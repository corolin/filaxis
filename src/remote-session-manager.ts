/**
 * remote-session-manager.ts — 远端长跑会话引擎（nohup 双文件落盘 + 终态三态核实）
 *
 * 净室设计自 个人Agent项目 RemoteSessionManager的 OSS 精简重实现：
 * - 落盘协议直接按 FEAT-04 契约：`<base>.out` / `<base>.err` 双文件 + `<base>.code`
 *   退出码文件（`{ cmd; }; echo $? > base.code`——nohup 后台进程退出码可核实）
 * - 终态三态（FEAT-04）：exited（读到 .code）/ stopped（kill 后 kill -0 核实已死）/
 *   unknown（核实不可达——exec 抛错/网络断）——发送终止≠确认死亡
 * - watcher 轮询匹配（远端无推送通道，与源版同语义）；行到达序即 tail 读取序
 * - exec 经注入回调（通常是 driver 的 exec 通道）——本模块零 I/O 假设、可 mock 全测
 */
import * as crypto from "node:crypto";
import { LineAssembler, sanitizeSessionName } from "./session-buffer.js";
import { settleRejection } from "./async-guard.js";
import type {
    SessionStartOptions,
    SessionHandleInfo,
    SessionEvent,
    WatchOptions,
    ReadLogOptions,
    SessionFinalStatus,
} from "./session-types.js";
import type { ExecResult } from "./driver.js";
import { ENV_NAME_RE } from "./ssh-helpers.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

export interface RemoteSessionManagerOptions {
    /** 执行通道回调（远端命令落点） */
    exec: (command: string) => Promise<Pick<ExecResult, "stdout" | "exitCode">>;
    /** 远端会话日志目录（缺省 /tmp/filaxis-sessions） */
    logDir?: string;
    /** watcher 轮询间隔（默认 1500ms） */
    pollMs?: number;
    /** 无人消费且无 armed watcher 的回收 TTL（缺省 30min；时钟可注入测试） */
    idleReapMs?: number;
    logger?: FilaxisLogger;
}

interface RemoteEntry {
    sessionId: string;
    command: string;
    base: string;
    pid?: number;
    /** 启动身份戳（/proc/<pid>/stat 第 22 列 starttime——H3二：PID 复用核验锚） */
    startStamp?: string;
    startedAt: number;
    ownerSessionId?: string;
    running: boolean;
    exitCode?: number | null;
    /** 轮询读到的 .out 字节偏移（只推进到最后的 \n 边界） */
    outBytes: number;
    /** .err 流字节偏移+行装配（Hydrogen R3 #6）：poll 曾只读 .out——stderr 的行
     *  watcher 零命中，与 LocalSessionManager 双流匹配不一致 */
    errBytes: number;
    errAssembler: LineAssembler;
    /** 日志消费串行链（Astra 二十四期：poll/stop/verify 并发进 flushTail 会从同一
     *  outBytes 读→双消费尾行+游标双跳——「读取偏移-消费-提交偏移」须会话级互斥） */
    consumeChain: Promise<unknown>;
    assembler: LineAssembler;
    watchers: Map<string, WatchOptions & { regex: RegExp }>;
    pollTimer?: ReturnType<typeof setTimeout>; // 链式调度（H2）——setTimeout/clearTimeout 配对（R12：曾 setInterval 类型+clearInterval 清理，语义不匹配）
    lastAttentionAt: number;
}

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export class RemoteSessionManager {
    onEvent: (ev: SessionEvent) => void = () => undefined;

    private entries = new Map<string, RemoteEntry>();
    private readonly exec: RemoteSessionManagerOptions["exec"];
    private readonly logDir: string;
    private readonly pollMs: number;
    private readonly idleReapMs?: number;
    private readonly log: FilaxisLogger;

    constructor(opts: RemoteSessionManagerOptions) {
        this.exec = opts.exec;
        this.logDir = opts.logDir ?? "/tmp/filaxis-sessions";
        // logDir 卫生（Gemini Hydrogen 审查 #5）：会话启动链内层（nohup sh -c
        // 引号包裹内）不能再 q() 引用——含单引号/空白的 logDir 从构造处拒绝
        if (/[' 	]/.test(this.logDir)) {
            throw new Error(`logDir 含引号或空白字符（会话命令无法安全引用）: ${this.logDir}`);
        }
        this.pollMs = opts.pollMs ?? 1500;
        this.idleReapMs = opts.idleReapMs;
        this.log = opts.logger ?? noopLogger;
    }

    /** 启动远端长跑会话：nohup 双文件落盘 + 退出码文件；立即返回。
     *  启动失败（cd 目录不存在/nohup 失败）显式抛错——绝不建幽灵会话
     *  （自排查 R3：旧 `cd X && nohup … & echo $!` 的 & 优先级把 && 链整体后台化，
     *  cd 失败探测不到且 exitCode 恒 0——幽灵 entry 挂到 reapIdle 30min）。 */
    async start(command: string, opts: SessionStartOptions = {}): Promise<SessionHandleInfo> {
        const sessionId =
            `${opts.name ? sanitizeSessionName(opts.name) + "-" : "rsess-"}` +
            crypto.randomBytes(4).toString("hex");
        const base = `${this.logDir}/${sessionId}`;
        // cd 显式失败码（`cd X || exit 1`——& 只后台化 nohup 行，失败可探测）
        const cd = opts.cwd ? `cd ${q(opts.cwd)} || exit 1; ` : "";
        // 环境经临时赋值前缀注入（VAR='V' cmd 形态——nohup 及其子进程继承）；
        // 变量名校验（自排查 R2，对齐十轮 ENV_NAME_RE 标准——防拼接注入）
        const envPrefix = opts.env
            ? Object.entries(opts.env).map(([k, v]) => {
                if (!ENV_NAME_RE.test(k)) throw new Error(`非法环境变量名（会话启动拒绝）: ${k}`);
                return `${k}=${q(v)}`;
            }).join(" ") + " "
            : "";
        // 子 shell + 上下换行（审计 M4 + Astra 二十轮 #2）：大括号形态下业务命令的
        // 显式 `exit 7` 会退出**整个包装 shell**——.code 永不写入（进程已死但管理器
        // 恒 running）。子 shell 隔离：exit 只退 ( )，外层 `$?` 照记；尾注释吞码同防
        const wrapped = `(\n${envPrefix}${command}\n); echo $? > ${base}.code`; // env 前缀进子 shell（Sol 54 P2-7：外层前缀只作用于第一条 ; 命令）
        // 启动握手（Astra 二十一轮 P2 + 二十二期 #1）：分号链里 mkdir 失败/重定向失败/
        // nohup 本身 127（命令不存在）都不影响父 shell——$! 照样返回 PID = 幽灵会话。
        // `.out` 存在只证明 shell 打开了重定向，**不证明进程拉起**。真正的启动确认由
        // wrapper 自己发：`sh -c 'echo $$ > .pid; …'` 首句写 .pid——nohup 127 时 wrapper
        // 从未运行，.pid 永不出现（等待窗 3s 后 FX_SPAWN_FAIL）。PID 也从 wrapper 亲手
        // 写的 .pid 读（比 $! 更可信）。
        // setsid 进程组（四十三期优先 1）：wrapper 自成会话组长——停止侧组杀全树
        // （pkill -P 只一层，多层脚本的孙进程曾漏杀而主 PID 核实已过=谎报 stopped）。
        // setsid 缺席（macOS 等）→ $SETS 空=无前缀，.pgid≠$$ → 停止侧自动回落旧路径
        const r = await this.exec(
            `mkdir -p ${q(this.logDir)} 2>/dev/null || { echo FX_MKDIR_FAIL; exit 1; }; ` +
            `${cd}__fx_sets=""; command -v setsid >/dev/null 2>&1 && __fx_sets=setsid; ` +
            `$__fx_sets nohup sh -c ${q(`echo $$ > ${base}.pid.tmp; mv ${base}.pid.tmp ${base}.pid; ps -o pgid= -p $$ 2>/dev/null | tr -d ' \\n' > ${base}.pgid; ${wrapped}`)} > ${q(base)}.out 2> ${q(base)}.err < /dev/null & ` +
            `__fx_n=0; while [ ! -f ${q(base)}.pid ] && [ $__fx_n -lt 30 ]; do sleep 0.1; __fx_n=$((__fx_n+1)); done; ` +
            `[ -f ${q(base)}.pid ] || { echo FX_SPAWN_FAIL; exit 1; }; ` +
            `cat ${q(base)}.pid; ` +
            // PID 身份戳（审计 H3二）：/proc/<pid>/stat 的 starttime——stop 前比对，防
            // PID 被系统复用后误杀无辜进程（非 Linux 无 /proc 时空戳=仅走 .code 一道闸）
            `{ awk '{print $22}' /proc/$(cat ${q(base)}.pid)/stat 2>/dev/null || true; } > ${q(base)}.st; true`,
        );
        const startOut = (r.stdout || "").trim();
        if (r.exitCode !== 0 || startOut.includes("FX_MKDIR_FAIL") || startOut.includes("FX_SPAWN_FAIL")) {
            if (startOut.includes("FX_MKDIR_FAIL")) {
                // 确定性失败：logDir 是普通文件——后台任务物理上不可能启动，安全重试
                throw new Error(`远端会话启动失败（logDir 不可创建——${this.logDir} 是普通文件或无权限）: ${command.slice(0, 60)}`);
            }
            if (startOut.includes("FX_SPAWN_FAIL")) {
                // **非确定失败**（Astra 二十三期 #1）：等待窗 3s 内 .pid 未出现——可能
                // nohup 127（真没启动），也可能是慢启动（真实 shell 延迟实验：start 报
                // 错后任务仍执行）。绝不给「可安全重试」的确定信号——outcome:unknown +
                // 线索（logBase 下 .pid/.out/.code 可核实），由调用方核实后决策
                const e = new Error(
                    `远端会话启动确认超时（3s 未见 .pid——**任务可能仍在启动中，outcome=unknown**：` +
                    `核实 ${base}.pid/.code 或进程表后决策；盲目重试可能双跑非幂等命令）: ${command.slice(0, 60)}`,
                ) as Error & { outcome: "unknown"; logBase?: string };
                e.outcome = "unknown";
                e.logBase = base;
                throw e;
            }
            throw new Error(`远端会话启动失败（exit=${r.exitCode}——cwd 目录不存在或 nohup 失败）: ${command.slice(0, 60)}`);
        }
        const pid = parseInt(startOut.split("\n").pop() ?? "", 10);
        if (!Number.isFinite(pid)) {
            throw new Error(`远端会话启动失败（未返回 PID）: ${command.slice(0, 60)}（输出 ${startOut.slice(0, 60)}）`);
        }
        const stR = await this.exec(`cat ${q(base)}.st 2>/dev/null || true`).catch(() => undefined);
        const startStamp = (stR?.stdout || "").trim() || undefined;

        const entry: RemoteEntry = {
            sessionId,
            command,
            base,
            pid: Number.isFinite(pid) ? pid : undefined,
            startStamp,
            startedAt: Date.now(),
            ownerSessionId: opts.ownerSessionId,
            running: true,
            outBytes: 0,
            errBytes: 0,
            errAssembler: new LineAssembler(),
            consumeChain: Promise.resolve(),
            assembler: new LineAssembler(),
            watchers: new Map(),
            lastAttentionAt: Date.now(),
        };
        this.entries.set(sessionId, entry);
        this.startPolling(entry);
        this.log.info(`[RemoteSession ${sessionId}] started (pid=${entry.pid}): ${command.slice(0, 60)}`);
        return { sessionId, logBase: base, pid: entry.pid };
    }

    /** 热窗口快照（远端 tail .out） */
    async tail(sessionId: string, n = 50): Promise<string[]> {
        const e = this.require(sessionId);
        e.lastAttentionAt = Date.now();
        const r = await this.exec(`tail -n ${n} ${q(e.base)}.out 2>/dev/null || true`);
        return (r.stdout || "").split("\n").filter((l, i, arr) => l !== "" || i < arr.length - 1).filter((l) => l !== "");
    }

    /** 落盘日志读取（按流分读——FEAT-04 双文件） */
    async readLog(sessionId: string, opts: ReadLogOptions = {}): Promise<string> {
        const e = this.require(sessionId);
        const file = opts.stream === "stderr" ? `${e.base}.err` : `${e.base}.out`;
        let cmd = `cat ${q(file)} 2>/dev/null || true`;
        if (opts.offsetLines) cmd = `tail -n +${opts.offsetLines + 1} ${q(file)} 2>/dev/null || true`;
        if (opts.lines) cmd += ` | tail -n ${opts.lines}`;
        const r = await this.exec(cmd);
        return (r.stdout || "").replace(/\n$/, "");
    }

    watch(sessionId: string, opts: WatchOptions): { cancel(): void } {
        const e = this.require(sessionId);
        e.lastAttentionAt = Date.now();
        const id = `rw-${crypto.randomBytes(3).toString("hex")}`;
        // 正则克隆去 g/y（GPT Astra 十七轮 #2 同款）：带状态 test 漏匹配 + 反向污染调用方 lastIndex
        const regex = opts.pattern instanceof RegExp
            ? new RegExp(opts.pattern.source, opts.pattern.flags.replace(/[gy]/g, ""))
            : new RegExp(opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        e.watchers.set(id, { ...opts, regex });
        return {
            cancel: () => { e.watchers.delete(id); },
        };
    }

    /**
     * 行对象视图（双流：.out + .err 各取最近 n 行，行对象带 stream 标记）——
     * observe 工具族用（第五季反馈 #2：此前仅 tail() 投影 stdout，stderr 漏读）
     */
    async tailLines(sessionId: string, n = 50): Promise<Array<{ stream: "stdout" | "stderr"; text: string }>> {
        const e = this.require(sessionId);
        e.lastAttentionAt = Date.now();
        // 分隔符带随机 nonce（自排查 R4）：静态 __FX_TL__ 可被输出内容伪造（用户
        // 命令 echo 该字面量即令后续行全部错归 stderr）——nonce 后不可预测
        const sep = `__FX_TL_${crypto.randomBytes(4).toString("hex")}__`;
        const r = await this.exec(`tail -n ${n} ${q(e.base)}.out 2>/dev/null; echo ${sep}; tail -n ${n} ${q(e.base)}.err 2>/dev/null`);
        const parts = (r.stdout || "").split(sep);
        const out: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
        for (const l of (parts[0] ?? "").split("\n")) {
            if (l.trim() !== "") out.push({ stream: "stdout", text: l });
        }
        for (const l of (parts[1] ?? "").split("\n")) {
            if (l.trim() !== "") out.push({ stream: "stderr", text: l });
        }
        return out;
    }

    /**
     * 停止会话：发 kill -TERM → kill -0 核实 → KILL 升级 → **再次核实**。
     * 核实不可达（exec 抛错）或 KILL 后仍存活（不可中断态）→ 显式 unknown
     * （终止即请求、死亡须核实——自排查 R1：KILL 升级后直接报 stopped 是虚报，
     * D 状态/不可中断睡眠下 kill -0 仍 ALIVE）。
     */
    async stop(sessionId: string): Promise<{ status: SessionFinalStatus; exitCode?: number | null }> {
        const e = this.require(sessionId);
        if (!e.running) return { status: e.exitCode != null ? "exited" : "stopped", exitCode: e.exitCode };
        if (e.pid == null) return { status: "unknown" };
        try {
            // 先查 .code（审计 H3）：轮询间隙已自然退出的进程——直接采纳真实退出码
            // finalize（exited），绝不向可能已被系统复用的 PID 盲发 kill（误杀无辜进程）
            const code = await this.exec(`cat ${q(e.base)}.code 2>/dev/null || true`);
            const codeStr = (code.stdout || "").trim();
            if (codeStr !== "" && /^\d+$/.test(codeStr)) {
                await this.flushTail(e); // 终态冲刷（二十三期 #2——尾行喂 watcher）
                this.finalize(e, parseInt(codeStr, 10));
                return { status: "exited", exitCode: e.exitCode };
            }
            // PID 身份核验（审计 H3二）：/proc starttime 比对——PID 已被系统复用给
            // 其他进程（starttime 不符）则**不发信号**（误杀无辜=unknown 交上层核实）
            if (e.startStamp) {
                const idc = await this.exec(`awk '{print $22}' /proc/${e.pid}/stat 2>/dev/null || true`);
                if ((idc.stdout || "").trim() !== e.startStamp) {
                    return { status: "unknown" };
                }
            }
            // 第五季盲测反馈 #3 + 四十三期优先 1（进程树核实面）：pkill -P 只杀直接子
            // 一层——多层脚本的孙进程继续跑而主 PID 已死=probe 过关谎报 stopped。
            // 升级=**进程组杀**：启动侧 wrapper setsid 自成组长并落 .pgid（== .pid 才
            // 组杀——杀错组=误伤无辜）；组长死后孙进程持组存活，/bin/kill -0 -- -pgid 组探
            // 测仍 ALIVE（主 PID 探测已 DEAD 的盲区正是谎报源头）。老会话/无 setsid
            // 平台 .pgid≠pid 或缺席 → 自动回落旧路径（pkill -P 一层+主进程）
            const treeKill = (sig: "TERM" | "KILL") =>
                this.exec(
                    `g=$(cat ${q(e.base)}.pgid 2>/dev/null); ` +
                    `if [ -n "$g" ] && [ "$g" = "${e.pid}" ]; then /bin/kill -${sig} -- "-$g" 2>/dev/null; ` +
                    `else pkill -${sig} -P ${e.pid} 2>/dev/null; kill -${sig} ${e.pid} 2>/dev/null; fi; sleep ${sig === "TERM" ? 1 : 0.5}; true`,
                );
            const treeProbe = async () => {
                const r = await this.exec(
                    `g=$(cat ${q(e.base)}.pgid 2>/dev/null); ` +
                    `if [ -n "$g" ] && [ "$g" = "${e.pid}" ]; then /bin/kill -0 -- "-$g" 2>/dev/null && echo ALIVE || echo DEAD; ` +
                    `else kill -0 ${e.pid} 2>/dev/null && echo ALIVE || echo DEAD; fi`,
                );
                // 探针输出必须可判读（Sol 五十四期 P1-2）：退出码非零/输出为空=
                // 核实通道失灵——既非 ALIVE 亦非 DEAD，死亡未证实，不得报 stopped
                if (r.exitCode !== 0) return null;
                const out = r.stdout;
                if (out.includes("ALIVE")) return true;
                if (out.includes("DEAD")) return false;
                return null; // 词不达意——探针失败同罪
            };
            await treeKill("TERM");
            let alive = await treeProbe();
            if (alive === null) return { status: "unknown" };
            if (alive) {
                await treeKill("KILL");
                alive = await treeProbe();
                if (alive === null || alive) return { status: "unknown" }; // KILL 后探针失灵或仍活——不虚报 stopped
            }
            // 死亡已核实（自审补漏）：KILL 杀死不写 .code——被杀前的输出尾行同样喂
            // watcher 后再 finalize（与 .code 命中路径同权）
            await this.flushTail(e);
            this.finalize(e, null);
            return { status: "stopped" };
        } catch {
            return { status: "unknown" };
        }
    }

    /** 会话核实原语（unknown 闭环——DeepSeek 文档评审追问落地）：stop 返回 unknown
     *  后的可执行核实手段。远端实测：.code 采纳（自然退出真实码）/ PID 身份戳比对
     *  （复用不误判）/ kill -0（running）；探测通道不可达 → unknown（诚实，不猜） */
    async verify(sessionId: string): Promise<{ status: "running" | "exited" | "unknown"; exitCode?: number | null }> {
        const e = this.require(sessionId);
        e.lastAttentionAt = Date.now(); // verify=消费行为（自审：不刷会被 reapIdle 误收）
        if (!e.running) return { status: "exited", exitCode: e.exitCode ?? null };
        if (e.pid == null) return { status: "unknown" };
        try {
            const code = await this.exec(`cat ${q(e.base)}.code 2>/dev/null || true`);
            const codeStr = (code.stdout || "").trim();
            if (codeStr !== "" && /^\d+$/.test(codeStr)) {
                await this.flushTail(e); // 终态冲刷（二十三期 #2——尾行喂 watcher）
                this.finalize(e, parseInt(codeStr, 10));
                return { status: "exited", exitCode: e.exitCode };
            }
            if (e.startStamp) {
                const idc = await this.exec(`awk '{print $22}' /proc/${e.pid}/stat 2>/dev/null || true`);
                if ((idc.stdout || "").trim() !== e.startStamp) return { status: "unknown" }; // PID 已复用——身份不符不判活
            }
            const alive = await this.exec(
                // 组感知存活（四十三期优先 1 同步）：会话=整棵命令树——孙进程还在跑就
                // 是 running（老会话 .pgid 缺席回落主 PID 探测）
                `g=$(cat ${q(e.base)}.pgid 2>/dev/null); ` +
                `if [ -n "$g" ] && [ "$g" = "${e.pid}" ]; then /bin/kill -0 -- "-$g" 2>/dev/null && echo Y || echo N; ` +
                `else kill -0 ${e.pid} 2>/dev/null && echo Y || echo N; fi`,
            );
            return alive.stdout.includes("Y") ? { status: "running" } : { status: "unknown" }; // 死了但无 .code=死因不明
        } catch {
            return { status: "unknown" };
        }
    }

    list(): Array<{ sessionId: string; command: string; running: boolean; startedAt: number }> {
        return Array.from(this.entries.values()).map((e) => ({
            sessionId: e.sessionId, command: e.command, running: e.running, startedAt: e.startedAt,
        }));
    }

    /** 注意力衰减回收：无人消费且无 armed watcher 超 TTL → 自动收摊（时钟可注入）。
     *  退出事件由 stop→finalize 统一发一声（自审：旧预发 exit(null) 双害——若进程
     *  实已自然退出，stop 的 .code 路径会以真实码 finalize 再发一次=**双发**，且第
     *  一次的 null 是错值；对齐 StreamSessionManager 二十一轮同款修法） */
    reapIdle(now: number = Date.now(), ttlMs?: number): void {
        const ttl = ttlMs ?? this.idleReapMs ?? 30 * 60 * 1000;
        for (const e of Array.from(this.entries.values())) {
            if (!e.running) continue;
            if (e.watchers.size > 0) continue; // armed watcher = 常驻注意力
            if (now - e.lastAttentionAt < ttl) continue;
            void this.stop(e.sessionId).catch(() => undefined);
        }
    }

    // ── 内部 ──

    private require(sessionId: string): RemoteEntry {
        const e = this.entries.get(sessionId);
        if (!e) throw new Error(`remote session '${sessionId}' 不存在`);
        return e;
    }

    private startPolling(entry: RemoteEntry): void {
        // 链式调度（审计 H2）：setInterval 下单轮 poll（2~3 次 exec 往返）在网络抖动
        // 时可超 pollMs——并发重入读同 offset 重复喂 watcher、outOffset 双跳静默丢段。
        // 上一轮完成（catch 也算完成）才调度下一轮，永不重入。
        const schedule = () => {
            entry.pollTimer = setTimeout(() => {
                void this.poll(entry).catch(() => undefined).finally(() => {
                    if (entry.running) schedule();
                });
            }, this.pollMs);
            entry.pollTimer.unref?.();
        };
        schedule();
    }

    /** 日志消费会话级互斥（Astra 二十四期）：poll 增量 / flushTail 冲刷共享同一串行
     *  链——并发进入会从同一 outBytes 读 → 双消费尾行 + 游标双跳（「读取偏移-消费-
     *  提交偏移」不可交错；H2 只串行化了 poll 自身，stop/verify 的冲刷是旁路入口）。 */
    private consume<T>(entry: RemoteEntry, task: () => Promise<T>): Promise<T> {
        const p = entry.consumeChain.then(task, task); // 前序失败不堵后续消费
        entry.consumeChain = p.catch(() => undefined);
        return p;
    }

    /** 终态冲刷：消费 .out 里游标之后的残余（Astra 二十三期 #2——无尾换行的最后
     *  一行此前被字节游标跳过：.code 出现即 finalize，watcher 对尾行零命中）。进程
     *  已死，残余是终值——补一个换行让末行成行，全量喂 watcher。 */
    private async flushTail(entry: RemoteEntry): Promise<void> {
        return this.consume(entry, async () => {
            try {
                const r = await this.exec(
                    `tail -c +${entry.outBytes + 1} ${q(entry.base)}.out 2>/dev/null || true`,
                );
                const text = (r.stdout || "").replace(/\n$/, "");
                if (text) {
                    entry.outBytes += Buffer.byteLength(text + "\n", "utf-8");
                    for (const line of entry.assembler.feed(text + "\n")) this.onLine(entry, line);
                }
            } catch { /* 冲刷 best-effort——终态本身已确认 */ }
        });
    }

    /** 轮询：增量读 .out 喂 watcher；读 .code 判定终态 */
    private async poll(entry: RemoteEntry): Promise<void> {
        if (!entry.running) return;
        try {
            // 增量输出（watcher 匹配用）——经会话级消费链（二十四期：与 flushTail
            // 互斥，游标读-消费-提交不交错）。字节游标 + 只消费完整行（二十二期 #2）。
            await this.consume(entry, async () => {
                // 双流增量（Hydrogen R3 #6）：.out 与 .err 各自游标+装配——stderr 的行
                // 同样喂 watcher（与 local 双流对齐）
                const readStream = async (suffix: ".out" | ".err"): Promise<void> => {
                    const bytes = suffix === ".out" ? entry.outBytes : entry.errBytes;
                    const r = await this.exec(
                        `tail -c +${bytes + 1} ${q(entry.base)}${suffix} 2>/dev/null || true`,
                    );
                    const text = r.stdout || "";
                    const lastNl = text.lastIndexOf("\n");
                    if (lastNl === -1) return;
                    const complete = text.slice(0, lastNl + 1); // 只喂完整行（含换行）
                    const stream = suffix === ".out" ? ("stdout" as const) : ("stderr" as const);
                    const asm = suffix === ".out" ? entry.assembler : entry.errAssembler;
                    if (suffix === ".out") entry.outBytes += Buffer.byteLength(complete, "utf-8");
                    else entry.errBytes += Buffer.byteLength(complete, "utf-8");
                    for (const line of asm.feed(complete)) this.onLine(entry, line, stream);
                };
                await readStream(".out");
                await readStream(".err");
            });
            // 终态：.code 文件在场 = 进程已退出（nohup 包装的 echo 已落盘）
            const code = await this.exec(`cat ${entry.base}.code 2>/dev/null || true`);
            const codeStr = (code.stdout || "").trim();
            if (codeStr !== "" && /^\d+$/.test(codeStr)) {
                await this.flushTail(entry); // 终态冲刷：无尾换行的末行也喂 watcher
                this.finalize(entry, parseInt(codeStr, 10));
            } else if (entry.pid != null) {
                // 无 .code 但进程没了（被外部 kill -9）→ unknown 退出码。
                // 组感知（Hydrogen R3 #6）：与 stop/verify 同口径（孙进程持组
                // 仍活=会话还在跑——裸 kill -0 主 PID 曾在多代脚本下提前判死）
                const alive = await this.exec(
                    `g=$(cat ${q(entry.base)}.pgid 2>/dev/null); ` +
                    `if [ -n "$g" ] && [ "$g" = "${entry.pid}" ]; then /bin/kill -0 -- "-$g" 2>/dev/null && echo Y || echo N; ` +
                    `else kill -0 ${entry.pid} 2>/dev/null && echo Y || echo N; fi`,
                );
                if (alive.stdout.includes("N")) {
                    await this.flushTail(entry);
                    this.finalize(entry, null);
                }
            }
        } catch {
            /* 轮询失败（exec 通道断）——下轮再试；终态核实属 stop()/result() 职责 */
        }
    }

    private onLine(entry: RemoteEntry, line: string, stream: "stdout" | "stderr" = "stdout"): void {
        for (const [id, w] of entry.watchers) {
            if (w.regex.test(line)) {
                if (w.once !== false) entry.watchers.delete(id);
                if (w.thenStop) void this.stop(entry.sessionId).catch(() => undefined);
                this.emit({
                    type: "match",
                    sessionId: entry.sessionId,
                    ownerSessionId: entry.ownerSessionId,
                    watcherId: id,
                    pattern: String(w.pattern),
                    matchedLine: line,
                    stream: "stdout",
                    context: [line],
                });
                entry.lastAttentionAt = Date.now();
            }
        }
    }

    private finalize(entry: RemoteEntry, exitCode: number | null): void {
        if (!entry.running) return;
        entry.running = false;
        entry.exitCode = exitCode;
        if (entry.pollTimer) clearTimeout(entry.pollTimer);
        entry.watchers.clear();
        this.emit({
            type: "exit",
            sessionId: entry.sessionId,
            ownerSessionId: entry.ownerSessionId,
            exitCode,
            lastLines: [],
        });
        this.log.info(`[RemoteSession ${entry.sessionId}] exited code=${exitCode}`);
        // 条目 TTL 回收（Hydrogen R11 #2）：local finalize 有 ttlTimer，remote 曾
        // 无——长驻进程频繁启停远端会话=RemoteEntry 永久滞留 entries（内存累积）。
        // 终态后保留短窗供 tail/verify 补读，随后移除（句柄方全量走文件）
        setTimeout(() => this.entries.delete(entry.sessionId), 60_000)?.unref?.();
    }

    private emit(ev: SessionEvent): void {
        try {
            // 异步拒绝隔离（孪生对齐审计·三十七/三十八期 EventBus 模式漏改）
            settleRejection(this.onEvent(ev));
        } catch (err) {
            this.log.warn(`remote session event sink threw: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
