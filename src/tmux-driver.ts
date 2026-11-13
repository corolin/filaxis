/**
 * tmux-driver.ts — 持久会话 Transport 适配层
 * （净室平移自 个人Agent项目 tmux-driver.ts）
 *
 * OSS 化：剥 RuntimeProcessManager/RemoteSessionManager/TmuxFileSystem——
 * fs 经 runCommand base64（方言适配接线 M2 批）；远端会话族沿用本文件
 * nohup 会话语义（经 TerminalManager 会话 shell 执行）。
 * terminalId 绑定 + cwd 恢复 + destroy 时 nohup 后台进程显式清理。
 */
import * as crypto from "node:crypto";
import type {
    RuntimeDriver, FileSystemDriver, FileEntry, ExecOptions, ExecResult, RuntimeDescriptor,
} from "./driver.js";
import { TerminalManager } from "./terminal-manager.js";
import { TmuxInvoker } from "./terminal/tmux-invoker.js";
import { ENV_NAME_RE } from "./ssh-helpers.js";
import { sanitizeSessionName } from "./session-buffer.js";
import { probeDialect, type RemoteDialect } from "./dialect.js";
import type {
    SessionStartOptions, SessionHandleInfo, WatchOptions, ReadLogOptions,
} from "./session-types.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export interface TmuxDriverOptions {
    terminalManager?: TerminalManager;
    logger?: FilaxisLogger;
}

export class TmuxSessionDriver implements RuntimeDriver {
    descriptor: RuntimeDescriptor;
    fs: FileSystemDriver;
    readonly terminal: TerminalManager;
    private readonly log: FilaxisLogger;

    constructor(descriptor: RuntimeDescriptor, opts: TmuxDriverOptions = {}) {
        this.descriptor = descriptor;
        this.terminal = opts.terminalManager ?? new TerminalManager();
        this.log = opts.logger ?? noopLogger;
        const self = this;
        this.fs = {
            async readFile(p) {
                // 真机实证（远端 Linux）：pane capture 滚动窗口 ~500 行（capture_scrollback
                // 缺省），80KB b64 在 220 列 pane 折行 400+ 行——窗口外头部永久丢；且远端
                // 解码形态长行折行混入多余换行。读方向两段式：小文件单次 b64 读回（本地
                // \s+ 归一解码——折行免疫）；大文件 b64 落远端临时 + 字节分页读（每页
                // 8K b64 折 ~40 行稳居窗口内，与滚动窗口彻底解耦）
                const st = await self.exec(`wc -c < ${q(p)} 2>/dev/null`);
                const size = parseInt((st.stdout || "").trim(), 10);
                if (!Number.isFinite(size)) throw new Error(`readFile 失败（文件不存在或不可读）: ${p}`);
                if (size * 2 <= 12_000) {
                    const r = await self.exec(`base64 ${q(p)}`);
                    return Buffer.from((r.stdout || "").replace(/\s+/g, ""), "base64").toString("utf-8");
                }
                const tmp = `/tmp/filaxis-read-${Math.random().toString(36).slice(2, 10)}.b64`;
                // && 连接 + 退出码查（Hydrogen R11 #1）：base64 失败（无权限/被删）曾仍
                // 创建空 tmp、wc -c 返 0 exit 0——readFile 静默返回空串而非报错
                const tot = await self.exec(`base64 ${q(p)} > ${q(tmp)} && wc -c < ${q(tmp)}`);
                const total = parseInt((tot.stdout || "").trim(), 10);
                // total 异常也走 finally 清理（曾在此 throw 遗留 tmp——throw 挪 try 内）
                try {
                    if (tot.exitCode !== 0 || !Number.isFinite(total)) {
                        throw new Error(`readFile 失败（base64 退出码 ${tot.exitCode}）: ${p}`);
                    }
                    let b64 = "";
                    for (let off = 1; off <= total; off += 8_000) {
                        const pg = await self.exec(`tail -c +${off} ${q(tmp)} | head -c 8000`);
                        b64 += (pg.stdout || "").replace(/\s+/g, "");
                    }
                    return Buffer.from(b64, "base64").toString("utf-8");
                } finally {
                    await self.exec(`rm -f ${q(tmp)}`).catch(() => undefined);
                }
            },
            async writeFile(p, content) {
                const buf = Buffer.from(content, "utf-8");
                const b64 = buf.toString("base64");
                // 小载荷单往返直写；大载荷走 putContent 分块链路（自排查 R5）。
                // 阈值与分块尺寸按真机实证收紧：tmux server 单条命令 ~16-24K 即
                // "command too long"（远端实测 16K OK / 24K FAIL）——12K 安全边距
                if (b64.length <= 12_000) {
                    await self.exec(`printf %s ${q(b64)} | base64 -d > ${q(p)}`);
                    return;
                }
                const { putContent } = await import("./file-transfer.js");
                await putContent(
                    async (cmd) => self.exec(cmd),
                    await self.dialect(),
                    buf,
                    p,
                    { chunkB64: 12_000 },
                );
            },
            async exists(p) {
                const r = await self.exec(`test -e ${q(p)} && echo Y || echo N`);
                return r.stdout.trim() === "Y";
            },
            async stat(p) {
                const r = await self.exec(`stat -c '%s %Y' ${q(p)} 2>/dev/null || stat -f '%z %m' ${q(p)} 2>/dev/null || true`);
                const m = r.stdout.trim().match(/^(\d+)\s+(\d+)$/);
                return m ? { size: parseInt(m[1]!, 10), mtimeMs: parseInt(m[2]!, 10) * 1000 } : null;
            },
            async readdir(p): Promise<FileEntry[]> {
                const r = await self.exec(`ls -1A ${q(p)} 2>/dev/null || true`);
                const names = r.stdout.split("\n").filter(Boolean);
                const out: FileEntry[] = [];
                for (const name of names) {
                    const full = `${p.replace(/\/$/, "")}/${name}`;
                    const d = await self.exec(`test -d ${q(full)} && echo Y || echo N`);
                    const st = await (this as FileSystemDriver).stat!(full);
                    out.push({ name, isDirectory: d.stdout.trim() === "Y", size: st?.size, mtime: st?.mtimeMs });
                }
                return out;
            },
            async rm(p, options) { await self.exec(`rm ${options?.recursive ? "-r " : ""}${options?.force ? "-f " : ""}${q(p)}`); },
            async mkdir(p, options) { await self.exec(`mkdir ${options?.recursive ? "-p " : ""}${q(p)}`); },
        };
    }

    /** init：无 terminalId 则 spawn；有则验证存活（跨进程重连语义）；cwd 恢复 */
    async init(): Promise<void> {
        if (!this.descriptor.terminalId) {
            this.descriptor.terminalId = await this.terminal.spawnSession(
                this.descriptor.driver,
                this.descriptor.target,
                this.descriptor.config,
            );
        } else {
            // 重连探活（Hydrogen R9 #3）：restore(snap) 携 terminalId 时曾静默成功——
            // 宿主重启/tmux server 已退要到首次 exec 才报错。显式 has-session 探测，
            // 死会话立即抛错（快失败优于延迟失败），不自动重建（消费方决定重建或换层）
            const alive = await TmuxInvoker.tryInvoke(["has-session", "-t", this.descriptor.terminalId]);
            if (alive.exitCode !== 0) {
                throw new Error(`tmux 会话 '${this.descriptor.terminalId}' 不存在（server 重启或已销毁）——请重建层或 restore 前 respawn`);
            }
        }
        if (this.descriptor.cwd) {
            try {
                await this.terminal.runCommand(
                    this.descriptor.terminalId,
                    // 引号安全化（Astra 五轮 P1：双引号不挡 $()/反引号注入）；best-effort 语义不变
                    `cd ${q(this.descriptor.cwd)} 2>/dev/null || true`,
                    10_000,
                );
            } catch { /* cwd 恢复失败不阻断初始化 */ }
        }
    }

    /** 本实例启动的后台会话（sessionId 集合——destroy 只清理自己的，绝不扫目录误杀他层） */
    private ownedSessions = new Set<string>();

    /** destroy：只停**本实例**启动的后台进程（审查问题 1：全目录扫杀会误杀同机其他
     * Filaxis 实例/其他层的任务——/tmp/filaxis-sessions 是共享目录），再销毁会话 */
    async destroy(): Promise<void> {
        if (this.descriptor.terminalId) {
            for (const sid of this.ownedSessions) {
                const base = this.sessionBase(sid);
                try {
                    await this.terminal.runCommand(
                        this.descriptor.terminalId,
                        `${this.pidGuardedKill(base)}; rm -f ${q(base)}.pid; true`,
                        5_000,
                    );
                } catch { /* best-effort：单个会话清理失败不阻断其余 */ }
            }
            this.ownedSessions.clear();
            await this.terminal.destroySession(this.descriptor.terminalId);
        }
    }

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
        // env 显式拒绝（十轮自挖）：tmux 全 PTY 语义（send-keys 键入回显进捕获输出），
        // export 前缀会污染 stdout——拒绝优于静默丢弃（曾完全忽略 options.env）
        if (options?.env && Object.keys(options.env).length) {
            throw new Error("tmux 层不支持 env（send-keys 键入回显会混入输出捕获——终端物理语义）；请内联进命令文本或换 ssh/local 层");
        }
        // signal 显式拒绝（Hydrogen R4 #3）：runCommand 通道无 abort 挂钩——静默忽略
        // 会让调用方以为可取消。指路 execSession+stop_and_verify（有完整三态收口）
        if (options?.signal) {
            throw new Error("tmux 层 exec 不支持 AbortSignal（runCommand 无中断挂钩）；改用 execSession + stopSession（三态收口）");
        }
        // cwd 支持（Hydrogen R4 #3）：曾静默丢弃——命令跑在原目录=误操作错误目录文件
        // 的风险。cd 前缀引用安全 + 失败即整条失败（fail-closed，退出码是数据）
        const cmd = options?.cwd
            ? `cd ${q(options.cwd)} && { ${command}; }`
            : command;
        if (options?.channel === "pty") {
            // tmux 后端本身即 PTY 语义（send-keys/capture-pane）
            const r = await this.terminal.runCommand(this.descriptor.terminalId!, cmd, {
                timeoutMs: options?.timeoutMs ?? 120_000,
            });
            return { stdout: r.stdout, stderr: "", exitCode: r.exitCode };
        }
        // exec 通道语义：独立 ssh 直达不适用于 tmux 复合层——走 PTY 但显式声明混流
        const r = await this.terminal.runCommand(this.descriptor.terminalId!, cmd, {
            timeoutMs: options?.timeoutMs ?? 120_000,
        });
        return { stdout: r.stdout, stderr: "", exitCode: r.exitCode };
    }

    async getCwd(): Promise<string> {
        const r = await this.exec("pwd");
        return r.stdout.trim();
    }

    /** 读环境变量（GPT Astra 十轮 #2 同款修复：旧 \$ 转义形态永远返回字面 $KEY）。
     *  PTY 混流下 printenv 输出 \r\n——剥单个尾 CRLF/LF。 */
    async getEnv(key: string): Promise<string | undefined> {
        if (!ENV_NAME_RE.test(key)) throw new Error(`非法环境变量名: ${key}`);
        const r = await this.exec(`printenv ${key}`);
        if (r.exitCode !== 0) return undefined;
        return r.stdout.replace(/\r?\n$/, "");
    }

    private dialectPromise?: Promise<RemoteDialect>;

    /** 方言惰性探测缓存（大文件 writeFile 的 putContent 链路用——每层一次） */
    private async dialect(): Promise<RemoteDialect> {
        this.dialectPromise ??= probeDialect((cmd) => this.exec(cmd));
        return this.dialectPromise;
    }

    // ── 会话族：nohup 后台进程经会话 shell 启动（.pid 落盘供 destroy 清理）──
    async execSession(command: string, opts?: SessionStartOptions): Promise<SessionHandleInfo> {
        // 名称白名单规范化（Astra 四十期 #1，对齐 local/remote 同款）：原名直接拼
        // sessionId→未引用路径 = 命令注入面（`probe$(touch …)` 实测文件被创建）。
        // 白名单字符集 [a-zA-Z0-9_-] 内无任何 shell 元字符
        const sessionId =
            `${opts?.name ? sanitizeSessionName(opts.name) + "-" : "tsess-"}` +
            crypto.randomBytes(3).toString("hex");
        const base = `/tmp/filaxis-sessions/${sessionId}`;
        // cd 显式失败码（R3 同款：`cd X &&` 前缀在 & 后台化下失败不可探测——幽灵会话）
        const cd = opts?.cwd ? `cd ${q(opts.cwd)} || exit 1; ` : "";
        // env 内联前缀（十轮 envPrefixOf 同款；execSession 的 env 此前被静默忽略——
        // nohup 后台跑无 send-keys 回显污染问题，支持优于静默丢弃）
        const envPrefix = opts?.env
            ? Object.entries(opts.env).map(([k, v]) => {
                if (!ENV_NAME_RE.test(k)) throw new Error(`非法环境变量名（会话启动拒绝）: ${k}`);
                return `${k}=${q(v)}`;
            }).join(" ") + " "
            : "";
        // 子 shell + 上下换行（孪生对齐审计·二十期 #2 + M4 在 remote/local 修后 tmux
        // execSession 才出生、带病出厂）：大括号形态下业务命令显式 `exit 7` 退出**整个
        // 包装 shell**——.code 永不写（进程已死但 stopSession 恒查不到终态）；单行拼接
        // 下业务尾注释 `cmd # cmt` 吞掉 `; }` 同病。子 shell 隔离 + 换行双防
        const wrapped = `(\n${envPrefix}${command}\n); echo $? > ${base}.code`; // env 前缀进子 shell（同 remote）
        // 启动握手（孪生对齐审计·二十一期 remote 模板漏改）：分号链里 mkdir 失败/
        // cd 失败被 & 吞/重定向失败/nohup 127 都不影响父 shell——$! 照样返回 PID =
        // 幽灵会话（.pid 空/指向已死壳，execSession 谎报成功）。wrapper 亲写 .pid +
        // 等待窗 + FX 闸三件套；.st 身份戳（H3二 同款）防 PID 复用误杀。
        // **整条包子 shell**：remote 模板的 `exit 1` 走 ssh 独立 shell 合法；本层 exec
        // 经 runCommand 打进**持久会话 shell**——裸 exit 会杀掉 tmux 会话本体（坑档
        // 案「tmux 交互用例裸 exit」+ M4 同源），子 shell 内 exit 只退自己
        const r = await this.exec(
            // 外层直接执行的派生路径全部引用（纵深——规范化已除注入面，q() 再兜一层；
            // nohup sh -c 内层不能再 q：外层整体单引号串内嵌单引号会提前闭合，且
            // q() 已保证 wrapped 字面到达、base 经规范化无元字符）
            `( mkdir -p /tmp/filaxis-sessions 2>/dev/null || { echo FX_MKDIR_FAIL; exit 1; }; ` +
            // setsid 进程组（Hydrogen R5 #3）：wrapper 自成组长——stopSession 组杀全树
            // （单杀主 PID 漏孙进程后探针见主死=谎报 stopped）。缺席平台 pgid≠pid 自动回落
            `${cd}__fx_sets=""; command -v setsid >/dev/null 2>&1 && __fx_sets=setsid; ` +
            `$__fx_sets nohup sh -c ${q(`echo $$ > ${base}.pid.tmp; mv ${base}.pid.tmp ${base}.pid; ps -o pgid= -p $$ 2>/dev/null | tr -d ' 
' > ${base}.pgid; ${wrapped}`)} > ${q(base)}.out 2> ${q(base)}.err < /dev/null & ` +
            `__fx_n=0; while [ ! -f ${q(base)}.pid ] && [ $__fx_n -lt 30 ]; do sleep 0.1; __fx_n=$((__fx_n+1)); done; ` +
            `[ -f ${q(base)}.pid ] || { echo FX_SPAWN_FAIL; exit 1; }; ` +
            `{ awk '{print $22}' /proc/$(cat ${q(base)}.pid)/stat 2>/dev/null || true; } > ${q(base)}.st; true )`,
        );
        const out = (r.stdout || "").trim();
        if (out.includes("FX_MKDIR_FAIL")) {
            // 确定性失败：目录不可创建——后台任务物理上不可能启动，可安全重试
            throw new Error(`tmux 会话启动失败（/tmp/filaxis-sessions 不可创建）: ${command.slice(0, 60)}`);
        }
        if (out.includes("FX_SPAWN_FAIL") || r.exitCode !== 0) {
            // 非确定失败（二十三期 #1 语义）：等待窗 3s 内 .pid 未出现——可能真没启动
            // 也可能慢启动。不给「可安全重试」信号——outcome=unknown + 线索交调用方核实
            const e = new Error(
                `tmux 会话启动未确认（3s 内未见 .pid——任务可能仍在启动，勿盲目重试非幂等命令；` +
                `核实：ls ${base}.* / cat ${base}.out）`,
            ) as Error & { outcome: string; sessionId: string; logBase: string };
            e.outcome = "unknown";
            e.sessionId = sessionId;
            e.logBase = base;
            throw e;
        }
        this.ownedSessions.add(sessionId);
        return { sessionId, logBase: base };
    }
    async tailSession(sessionId: string, lines = 50): Promise<string[]> {
        const base = this.sessionBase(sessionId);
        const r = await this.exec(`tail -n ${lines} ${q(`${base}.out`)} 2>/dev/null || true`);
        return r.stdout.split("\n").filter(Boolean);
    }
    async readSessionLog(sessionId: string, opts?: ReadLogOptions): Promise<string> {
        const base = this.sessionBase(sessionId);
        const suffix = opts?.stream === "stderr" ? ".err" : ".out";
        let cmd = `cat ${q(base + suffix)} 2>/dev/null || true`;
        if (opts?.offsetLines) cmd += ` | tail -n +${opts.offsetLines + 1}`; // 偏移（Hydrogen R10 #2：曾静默忽略）
        if (opts?.lines) cmd += ` | tail -n ${opts.lines}`;
        return (await this.exec(cmd)).stdout.replace(/\n$/, "");
    }
    watchSession(_sessionId: string, _opts: WatchOptions): { cancel(): void } {
        throw new Error("tmux 后端会话 watcher 属 M2 观察流批次（stream-session 落位后接入）");
    }
    async stopSession(sessionId: string): Promise<{ status: "exited" | "stopped" | "unknown"; exitCode?: number | null }> {
        const base = this.sessionBase(sessionId);
        // 先探针后信号（Astra 四十二期 #1，对齐 remote H3一「stop 先查 .code」）：
        // 已自然退出的会话绝无再发信号的必要——.st 缺席的老会话若 PID 已被系统
        // 复用，先 TERM 会误伤无辜进程。探针终态（CODE/DEAD/NOEV）直接返回，
        // 只有 ALIVE 才进入「身份戳守卫 TERM → 核实窗轮询」
        const probe = (
            `if [ -f ${q(base)}.code ]; then echo CODE:$(cat ${q(base)}.code); ` +
            `elif [ -f ${q(base)}.pid ]; then p=$(cat ${q(base)}.pid); ` +
            `if kill -0 "$p" 2>/dev/null; then echo ALIVE; else echo DEAD; fi; ` +
            `else echo NOEV; fi`
        );
        // 探针解析（Astra 四十三期 #2）：CODE 须**整行全数字**（`CODE:7oops` 这种损坏
        // 记录不得部分匹配成 7——格式不符=证据无效）；探针本身失败（exitCode≠0 或
        // 输出无四词任一——PTY 异常/会话死亡中途）=无从核实，**绝不进信号段**
        // （四十三期 #1：修前探针空输出被当 ALIVE，照样发 TERM/KILL）
        const readout = (
            out: string,
            probeOk: boolean,
        ): { status: "exited" | "stopped" | "unknown"; exitCode?: number | null } | undefined => {
            if (!probeOk) return { status: "unknown" }; // 探针不可信——不发信号，交调用方核实
            for (const line of out.split(/\r?\n/)) {
                const m = line.trim().match(/^CODE:(\d+)$/); // 整行严格：完整记录才算数
                if (m) return { status: "exited", exitCode: parseInt(m[1]!, 10) };
            }
            if (out.includes("DEAD")) return { status: "stopped" }; // pid 在场且已死（TERM 致死/迟到死亡）
            if (out.includes("NOEV")) return { status: "unknown" }; // 证据全缺——无从证实死亡
            if (out.includes("ALIVE")) return undefined; // 明确存活——才允许进信号段
            return { status: "unknown" }; // 词不达意（空输出/截断混流）——探针失败同罪
        };
        const runProbe = async () => {
            const r = await this.exec(probe);
            return readout(r.stdout, r.exitCode === 0);
        };
        const first = await runProbe();
        if (first) return first;
        // PID 身份戳比对（孪生对齐审计·H3二 remote 同款）：.st 与当前 starttime 不符
        // =PID 已被系统复用给无辜进程——不发信号（.st 缺席=老会话/非 Linux，放行）
        await this.exec(this.pidGuardedKill(base, "TERM"));
        for (let i = 0; i < 4; i++) {
            const r = await runProbe();
            if (r) return r;
            await new Promise((res) => setTimeout(res, 300)); // ALIVE——TERM 核实窗
        }
        // SIGKILL 升级（对齐 remote 三段：顽固/不可中断进程 TERM 不动——KILL 再核，
        // .st 守卫同款防复用误杀；仍不死=不可中断态（D 状态 IO）→ unknown 如实）
        await this.exec(this.pidGuardedKill(base, "KILL"));
        for (let i = 0; i < 2; i++) {
            const r = await runProbe();
            if (r) return r;
            await new Promise((res) => setTimeout(res, 300));
        }
        return { status: "unknown" }; // kill -0 持续说活（不可中断态）——死亡未证实
    }
    /** 会话路径派生（Astra 四十一期 #1）：sessionId 是外部输入——直接拼路径=注入面
     *  （本机 Bash 实测命令替换输出标记；启动侧四十期已规范化，读取/停止侧漏）。
     *  查询键白名单校验后拒绝（ID 是查找键非创建名——静默归一会把「查无此会话」
     *  偷换成「查了个不存在的归一名」，拒绝优于清洗） */
    private sessionBase(sessionId: string): string {
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
            throw new Error(`非法会话 ID（仅 [A-Za-z0-9_-]）: ${JSON.stringify(sessionId.slice(0, 40))}`);
        }
        return `/tmp/filaxis-sessions/${sessionId}`;
    }
    /** .st 身份戳守卫的信号发送（stopSession 三段与 destroy 共用；持久 shell 里禁裸 exit） */
    private pidGuardedKill(base: string, sig: "TERM" | "KILL" = "TERM"): string {
        // 组感知（Hydrogen R5 #3）：.pgid==pid 时组杀全树（/bin/kill 绝对路径——dash
        // kill 内建不认负 PID）；缺席/不匹配回落单杀
        return (
            `p=$(cat ${q(base)}.pid 2>/dev/null); [ -n "$p" ] && { ` +
            `s=$(cat ${q(base)}.st 2>/dev/null); ` +
            `{ [ -z "$s" ] || [ "$s" = "$(awk '{print $22}' /proc/$p/stat 2>/dev/null)" ] && { ` +
            `g=$(cat ${q(base)}.pgid 2>/dev/null); ` +
            `if [ -n "$g" ] && [ "$g" = "$p" ]; then /bin/kill -${sig} -- "-$g" 2>/dev/null; ` +
            `else kill -${sig} "$p" 2>/dev/null; fi; }; }; }; true`
        );
    }
    /** 会话核实（unknown 闭环）：.code 在场=exited（真实码）；否则 kill -0 实测 pid
     *  **带 .st 身份核验**（Astra 四十二期 #2）：裸 kill -0 在 PID 被系统复用时会把
     *  无辜进程的存活报告成原会话仍在运行——starttime 戳不符即 unknown（原会话
     *  真实状态不可知），绝不冒认。单探针合并往返（PTY 每往返数百 ms）。 */
    async verifySession(sessionId: string): Promise<{ status: "running" | "exited" | "unknown"; exitCode?: number | null }> {
        const base = this.sessionBase(sessionId);
        const r = await this.exec(
            `if [ -f ${q(base)}.code ]; then echo CODE:$(cat ${q(base)}.code); ` +
            `elif [ -f ${q(base)}.pid ]; then p=$(cat ${q(base)}.pid); ` +
            `if kill -0 "$p" 2>/dev/null; then ` +
            `s=$(cat ${q(base)}.st 2>/dev/null); c=$(awk '{print $22}' /proc/$p/stat 2>/dev/null); ` +
            `if [ -z "$s" ] || [ "$s" = "$c" ]; then echo RUNNING; else echo STALE; fi; ` + // 复用：活着但身份不符
            `else echo DEAD; fi; ` +
            `else echo NOEV; fi`,
        );
        const out = r.stdout;
        // 探针失败（exitCode≠0）或 CODE 非整行全数字=证据无效（四十三期 #2：
        // `CODE:7oops` 损坏记录不得部分匹配成 7；#1 同罪——探针不可信不下结论）
        if (r.exitCode !== 0) return { status: "unknown" };
        for (const line of out.split(/\r?\n/)) {
            const m = line.trim().match(/^CODE:(\d+)$/);
            if (m) return { status: "exited", exitCode: parseInt(m[1]!, 10) };
        }
        if (out.includes("RUNNING")) return { status: "running" }; // 身份核实过的存活
        return { status: "unknown" }; // STALE（PID 被复用——原会话状态不可知）/ DEAD（死因不明）/ NOEV / 词不达意
    }
    listSessions(): Array<{ sessionId: string; command: string; running: boolean; startedAt: number }> {
        return []; // 无常驻索引（M2 批补 registry 化）
    }
}
