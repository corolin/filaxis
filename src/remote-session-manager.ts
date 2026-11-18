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
    SessionRecoveryResult,
    SessionEvent,
    WatchOptions,
    ReadLogOptions,
    SessionFinalStatus,
} from "./session-types.js";
import type { ExecResult } from "./driver.js";
import { cdTargetArg, ENV_NAME_RE } from "./ssh-helpers.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";
import { renderSessionCodeGuard, renderSessionGroupState, renderSessionWorker } from "./session-group.js";

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

type RecoveredIdentity = { bootId: string; startStamp: string; pid: number };
type DiskEvidence = { status: "unknown" } | { status: "exited"; exitCode: number }
    | { status: "running"; identity: RecoveredIdentity; offsets?: { out: number; err: number } };

type StopResult = { status: SessionFinalStatus; exitCode?: number | null };

interface RemoteEntry {
    stopping?: Promise<StopResult>;
    sessionId: string;
    command: string;
    base: string;
    pid?: number;
    /** 启动身份戳（/proc/<pid>/stat 第 22 列 starttime——H3二：PID 复用核验锚） */
    startStamp?: string;
    recovered?: RecoveredIdentity;
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
    private recovering = new Map<string, Promise<SessionRecoveryResult>>();
    private pollingClosed = false;
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
            crypto.randomBytes(16).toString("hex");
        const base = `${this.logDir}/${sessionId}`;
        // cd 显式失败码（`cd X || exit 1`——& 只后台化 nohup 行，失败可探测）
        const cd = opts.cwd ? `cd ${q(cdTargetArg(opts.cwd))} || exit 1; ` : "";
        // 环境经临时赋值前缀注入（VAR='V' cmd 形态——nohup 及其子进程继承）；
        // 变量名校验（自排查 R2，对齐十轮 ENV_NAME_RE 标准——防拼接注入）
        const envPrefix = opts.env && Object.keys(opts.env).length > 0
            ? Object.entries(opts.env).map(([k, v]) => {
                if (!ENV_NAME_RE.test(k)) throw new Error(`非法环境变量名（会话启动拒绝）: ${k}`);
                return `export ${k}=${q(v)}`; // export 形态（Sol 55 P2-D）：裸赋值前缀 VAR=v cmd 只作用 cmd——子 shell 后续命令丢变量
            }).join("; ") + "; " // 分号分隔（Sol 56 P2-1）：曾空格连接 export K=v cmd——export 吞 cmd 当变量名参数
            : "";
        // 子 shell + 上下换行（审计 M4 + Astra 二十轮 #2）：大括号形态下业务命令的
        // 显式 `exit 7` 会退出**整个包装 shell**——.code 永不写入（进程已死但管理器
        // 恒 running）。子 shell 隔离：exit 只退 ( )，外层 `$?` 照记；尾注释吞码同防
        const wrapped = renderSessionWorker(base, `${envPrefix}${command}`);
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
            `${cd}(set -C; : > ${q(base)}.claim) 2>/dev/null || { echo FX_SESSION_COLLISION; exit 1; }; ` +
            `for ext in pid pid.tmp pgid st code code.tmp members out err; do [ ! -e ${q(base)}."$ext" ] || { echo FX_SESSION_COLLISION; exit 1; }; done; ` +
            `__fx_sets=""; command -v setsid >/dev/null 2>&1 && __fx_sets=setsid; ` +
            `$__fx_sets nohup sh -c ${q(wrapped)} > ${q(base)}.out 2> ${q(base)}.err < /dev/null & ` +
            `__fx_n=0; while [ ! -f ${q(base)}.pid ] && [ $__fx_n -lt 30 ]; do sleep 0.1; __fx_n=$((__fx_n+1)); done; ` +
            `[ -f ${q(base)}.pid ] || { echo FX_SPAWN_FAIL; exit 1; }; ` +
            `cat ${q(base)}.pid; ` +
            // PID 身份戳（审计 H3二）：/proc/<pid>/stat 的 starttime——stop 前比对，防
            // PID 被系统复用后误杀无辜进程（非 Linux 无 /proc 时空戳=仅走 .code 一道闸）
            `{ awk '{print $22}' /proc/$(cat ${q(base)}.pid)/stat 2>/dev/null || true; } > ${q(base)}.st; true`,
        );
        const startOut = (r.stdout || "").trim();
        if (startOut === "FX_SESSION_COLLISION") throw new Error(`远端会话 ID 已被占用: ${sessionId}`);
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

    /** Adopt a verified session and observe bytes appended after the recovery snapshot. */
    async recover(sessionId: string): Promise<SessionRecoveryResult> {
        const logBase = this.sessionBase(sessionId);
        const entry = this.entries.get(sessionId);
        if (entry) {
            if (!entry.running) {
                return entry.exitCode == null ? { sessionId, logBase, status: "stopped" }
                    : { sessionId, logBase, status: "exited", exitCode: entry.exitCode };
            }
            const verified = await this.verify(sessionId);
            if (verified.status === "exited" && verified.exitCode != null) {
                return { sessionId, logBase, status: "exited", exitCode: verified.exitCode };
            }
            return verified.status === "running" && entry.pid != null
                ? { sessionId, logBase, status: "running", pid: entry.pid }
                : { sessionId, logBase, status: "unknown" };
        }
        let pending = this.recovering.get(sessionId);
        if (!pending) {
            pending = this.adoptOnDisk(sessionId, logBase).finally(() => this.recovering.delete(sessionId));
            this.recovering.set(sessionId, pending);
        }
        return pending;
    }

    private async adoptOnDisk(sessionId: string, logBase: string): Promise<SessionRecoveryResult> {
        const evidence = await this.readDiskEvidence(logBase, true);
        if (evidence.status !== "running") return { sessionId, logBase, ...evidence };
        if (this.pollingClosed || !evidence.offsets) return { sessionId, logBase, status: "unknown" };
        const { identity, offsets } = evidence;
        const now = Date.now();
        const entry: RemoteEntry = {
            sessionId, base: logBase, command: "", pid: identity.pid,
            startStamp: identity.startStamp, recovered: identity, running: true,
            startedAt: now, lastAttentionAt: now, outBytes: offsets.out, errBytes: offsets.err,
            assembler: new LineAssembler(), errAssembler: new LineAssembler(),
            consumeChain: Promise.resolve(), watchers: new Map(),
        };
        this.entries.set(sessionId, entry);
        this.startPolling(entry);
        return { sessionId, logBase, status: "running", pid: identity.pid };
    }

    /** 热窗口快照（远端 tail .out） */
    async tail(sessionId: string, n = 50): Promise<string[]> {
        const e = this.require(sessionId);
        e.lastAttentionAt = Date.now();
        // 无 || true（Sol 69 #3）：曾以 `2>/dev/null || true` 吞错——文件缺失/读失败
        // exit 恒 0，空串当正常日志返回
        const r = await this.exec(`tail -n ${n} ${q(e.base)}.out 2>/dev/null`);
        // 凭证纪律（Sol 67 #3）：读命令失败（exit≠0）的输出不作日志凭证
        if (r.exitCode !== 0) {
            throw new Error(`会话日志读取失败（tail exit=${r.exitCode}——输出不作日志凭证）: ${sessionId}`);
        }
        return (r.stdout || "").split("\n").filter((l, i, arr) => l !== "" || i < arr.length - 1).filter((l) => l !== "");
    }

    /** 落盘日志读取（按流分读——FEAT-04 双文件） */
    async readLog(sessionId: string, opts: ReadLogOptions = {}): Promise<string> {
        const base = this.entries.get(sessionId)?.base ?? this.sessionBase(sessionId);
        const file = opts.stream === "stderr" ? `${base}.err` : `${base}.out`;
        // 可读性门（Sol 69 #3）：`|| true` 曾吞错——test -r 前置，读不了整体非零。
        // lines 截断走临时文件中转（Sol 70 #3 → Sol 71 #4 → Sol 72 #3）：管道尾 rc
        // 掩码曾当空日志；命令替换（$(cat)）吞尾换行+剥 NUL；临时文件曾落日志
        // 目录——只读目录下 lines 读曾报错（全量读正常）。临时文件改落远端
        // $TMPDIR（$$+nonce 保唯一），cat 失败经 || 清场退出、字节全程保真
        const rd = q(file);
        let cmd: string;
        if (opts.lines != null) {
            const nonce = crypto.randomBytes(3).toString("hex");
            const readCmd = opts.offsetLines ? `tail -n +${opts.offsetLines + 1} ${rd}` : `cat ${rd}`;
            cmd = `test -r ${rd} || exit 9; ` +
                // TMPDIR 失效回落（Sol 73 #6）：指向不存在/不可写目录时 lines 读曾
                // exit 9（全量读正常）——校验在场且可写，否则回落 /tmp
                `__fx_d="\${TMPDIR:-/tmp}"; [ -d "$__fx_d" ] && [ -w "$__fx_d" ] || __fx_d=/tmp; ` +
                `__fx_t="$__fx_d/fx-rl-$$-${nonce}"; ` +
                `{ ${readCmd} > "$__fx_t" 2>/dev/null || { rm -f "$__fx_t"; exit 9; }; }; ` +
                `{ tail -n ${opts.lines} "$__fx_t"; }; __fx_rc=$?; rm -f "$__fx_t"; exit $__fx_rc`;
        } else {
            cmd = opts.offsetLines
                ? `test -r ${rd} || exit 9; tail -n +${opts.offsetLines + 1} ${rd}`
                : `test -r ${rd} || exit 9; cat ${rd}`;
        }
        const r = await this.exec(cmd);
        // 凭证纪律（Sol 67 #3）：失败输出不作日志凭证
        if (r.exitCode !== 0) {
            throw new Error(`会话日志读取失败（readLog exit=${r.exitCode}——输出不作日志凭证）: ${sessionId}`);
        }
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
        // 命令 echo 该字面量即令后续行全部错归 stderr）——nonce 后不可预测。
        // 双 rc 捕获（Sol 69 #3）：复合命令整体 exit 只反映**末个** tail——首流
        // 读失败曾被末流成功掩盖（stdout 缺失+stderr 正常曾当正常返回）
        const sep = `__FX_TL_${crypto.randomBytes(4).toString("hex")}__`;
        const r = await this.exec(
            `tail -n ${n} ${q(e.base)}.out 2>/dev/null; __fx_r1=$?; echo ${sep}; ` +
            `tail -n ${n} ${q(e.base)}.err 2>/dev/null; __fx_r2=$?; ` +
            `[ "$__fx_r1" = 0 ] && [ "$__fx_r2" = 0 ] || exit 9`,
        );
        // 凭证纪律（Sol 68 #5）：双流读取入口同权——exit≠0 的输出不作日志凭证
        if (r.exitCode !== 0) {
            throw new Error(`会话日志读取失败（tailLines exit=${r.exitCode}——输出不作日志凭证）: ${sessionId}`);
        }
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
    async stop(sessionId: string): Promise<StopResult> {
        let e = this.entries.get(sessionId);
        if (!e) {
            const recovered = await this.recover(sessionId);
            if (recovered.status === "exited") return { status: recovered.status, exitCode: recovered.exitCode };
            if (recovered.status !== "running") return { status: recovered.status };
            e = this.entries.get(sessionId);
            if (!e) return { status: "unknown" };
        }
        const entry = e;
        entry.stopping ??= this.stopEntry(entry).finally(() => { entry.stopping = undefined; });
        return entry.stopping;
    }

    private async stopEntry(e: RemoteEntry): Promise<StopResult> {
        if (!e.running) return { status: e.exitCode != null ? "exited" : "stopped", exitCode: e.exitCode };
        if (e.pid == null) return { status: "unknown" };
        try {
            const finishIfExited = async () => {
                const code = await this.readExitCode(e.base);
                const value = code.exitCode === 0 ? code.stdout.trim() : "";
                if (!/^\d+$/.test(value)) return undefined;
                const exitCode = Number(value);
                await this.flushTail(e);
                this.finalize(e, exitCode);
                return { status: "exited" as const, exitCode };
            };
            const alreadyExited = await finishIfExited();
            if (alreadyExited) return alreadyExited;
            // Check the original start time in the same remote command as each
            // signal. The process observed after TERM might be a replacement.
            const checkIdentity = e.startStamp
                ? `stamp=$(awk '{print $22}' /proc/${e.pid}/stat 2>/dev/null) && [ "$stamp" = ${q(e.startStamp)} ]`
                : "true";
            // 第五季盲测反馈 #3 + 四十三期优先 1（进程树核实面）：pkill -P 只杀直接子
            // 一层——多层脚本的孙进程继续跑而主 PID 已死=probe 过关谎报 stopped。
            // 升级=**进程组杀**：启动侧 wrapper setsid 自成组长并落 .pgid（== .pid 才
            // 组杀——杀错组=误伤无辜）；组长死后孙进程持组存活，/bin/kill -0 -- -pgid 组探
            // 测仍 ALIVE（主 PID 探测已 DEAD 的盲区正是谎报源头）。老会话/无 setsid
            // 平台 .pgid≠pid 或缺席 → 自动回落旧路径（pkill -P 一层+主进程）
            const treeKill = (sig: "TERM" | "KILL") => {
                if (e.recovered) {
                    const identity = e.recovered;
                    return this.exec(
                        `[ ! -f ${q(e.base)}.code ] && ` +
                        `[ "$(cat /proc/sys/kernel/random/boot_id)" = ${q(identity.bootId)} ] && ` +
                        `[ "$(awk '{sub(/^.*\\) /, ""); print $20 ":" $3}' /proc/${identity.pid}/stat 2>/dev/null)" = ${q(`${identity.startStamp}:${identity.pid}`)} ] && ` +
                        `/bin/kill -${sig} -- -${identity.pid} 2>/dev/null && sleep ${sig === "TERM" ? 1 : 0.5}`,
                    );
                }
                return this.exec(
                    `g=$(cat ${q(e.base)}.pgid 2>/dev/null); ` +
                    `[ ! -f ${q(e.base)}.code ] || exit 1; ` +
                    `{ ${checkIdentity}; } || exit 1; ` +
                    `if [ -n "$g" ] && [ "$g" = "${e.pid}" ]; then /bin/kill -${sig} -- "-$g" 2>/dev/null; ` +
                    `else pkill -${sig} -P ${e.pid} 2>/dev/null; ` +
                    `{ ${checkIdentity}; } || exit 1; kill -${sig} ${e.pid} 2>/dev/null; fi; ` +
                    `sleep ${sig === "TERM" ? 1 : 0.5}; true`,
                );
            };
            const term = await treeKill("TERM");
            let alive = term.exitCode === 0 ? await this.probeTree(e) : null;
            if (alive && e.startStamp) {
                const exitedAfterTerm = await finishIfExited();
                if (exitedAfterTerm) return exitedAfterTerm;
                const kill = await treeKill("KILL");
                alive = kill.exitCode === 0 ? await this.probeTree(e) : null;
            }
            // The wrapper can publish its exit code while stop is in flight.
            const exitedDuringStop = await finishIfExited();
            if (exitedDuringStop) return exitedDuringStop;
            if (alive !== false) return { status: "unknown" };
            await this.flushTail(e);
            this.finalize(e, null);
            return e.exitCode == null ? { status: "stopped" } : { status: "exited", exitCode: e.exitCode };
        } catch {
            return { status: "unknown" };
        }
    }

    private async probeTree(e: RemoteEntry): Promise<boolean | null> {
        const r = await this.exec(
            (e.recovered
                ? `[ "$(cat /proc/sys/kernel/random/boot_id)" = ${q(e.recovered.bootId)} ] || exit 1; g=${e.recovered.pid}; `
                : `g=$(cat ${q(e.base)}.pgid 2>/dev/null); `) +
            `if [ -n "$g" ] && [ "$g" = "${e.pid}" ]; then msg=$(LC_ALL=C /bin/kill -0 -- "-$g" 2>&1); ` +
            `else msg=$(LC_ALL=C kill -0 ${e.pid} 2>&1); fi; ` +
            `if [ "$?" -eq 0 ]; then ` +
            `if [ "$g" = "${e.pid}" ]; then ${renderSessionGroupState("ALIVE")}; else echo ALIVE; fi; else case "$msg" in ` +
            `*"No such process"*) echo DEAD;; *) echo UNKNOWN;; esac; fi`,
        );
        // 探针输出必须可判读（Sol 五十四期 P1-2）：退出码非零/输出为空=
        // 核实通道失灵——既非 ALIVE 亦非 DEAD，死亡未证实，不得报 stopped
        if (r.exitCode !== 0) return null;
        // 精确 token 匹配（Sol 55 P1-A）：子串匹配曾把 "NOT DEAD" 判死——
        // 输出须是且仅是探针词（trim 后全等），否则=探针失败归 null
        const token = r.stdout.trim();
        if (token === "ALIVE") return true;
        if (token === "DEAD") return false;
        return null;
    }

    /** 会话核实原语（unknown 闭环——DeepSeek 文档评审追问落地）：stop 返回 unknown
     *  后的可执行核实手段。远端实测：.code 采纳（自然退出真实码）/ PID 身份戳比对
     *  （复用不误判）/ kill -0（running）；探测通道不可达 → unknown（诚实，不猜） */
    async verify(sessionId: string): Promise<{ status: "running" | "exited" | "unknown"; exitCode?: number | null }> {
        const e = this.entries.get(sessionId);
        if (!e) {
            const evidence = await this.readDiskEvidence(this.sessionBase(sessionId), false);
            return evidence.status === "exited" ? evidence : { status: evidence.status };
        }
        e.lastAttentionAt = Date.now(); // verify=消费行为（自审：不刷会被 reapIdle 误收）
        if (!e.running) return { status: "exited", exitCode: e.exitCode ?? null };
        if (e.pid == null) return { status: "unknown" };
        try {
            const code = await this.readExitCode(e.base);
            const codeStr = code.exitCode === 0 ? (code.stdout || "").trim() : ""; // 命令失败不采信输出（Sol 57/58 P1-2）
            if (codeStr !== "" && /^\d+$/.test(codeStr)) {
                await this.flushTail(e); // 终态冲刷（二十三期 #2——尾行喂 watcher）
                this.finalize(e, parseInt(codeStr, 10));
                return { status: "exited", exitCode: e.exitCode };
            }
            if (e.recovered) {
                const evidence = await this.readDiskEvidence(e.base, false);
                if (evidence.status === "exited") {
                    await this.flushTail(e);
                    this.finalize(e, evidence.exitCode);
                    return evidence;
                }
                const original = e.recovered;
                return { status: evidence.status === "running" && evidence.identity.bootId === original.bootId
                    && evidence.identity.pid === original.pid && evidence.identity.startStamp === original.startStamp ? "running" : "unknown" };
            }
            if (e.startStamp) {
                const idc = await this.exec(`awk '{print $22}' /proc/${e.pid}/stat 2>/dev/null || true`);
                if (idc.exitCode !== 0 || (idc.stdout || "").trim() !== e.startStamp) return { status: "unknown" }; // PID 已复用——身份不符不判活
            }
            return await this.probeTree(e) === true ? { status: "running" } : { status: "unknown" };
        } catch {
            return { status: "unknown" };
        }
    }

    private sessionBase(sessionId: string): string {
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("非法远端会话 ID");
        return `${this.logDir}/${sessionId}`;
    }

    private readExitCode(base: string) {
        return this.exec(`cat ${q(base)}.code 2>/dev/null && (${renderSessionCodeGuard(base)}true)`);
    }

    /** Verify durable evidence without claiming ownership or sending a signal. */
    private async readDiskEvidence(base: string, adopt: boolean): Promise<DiskEvidence> {
        const path = q(base);
        try {
            const result = await this.exec(
                `if code=$(cat ${path}.code 2>/dev/null); then ${renderSessionCodeGuard(base)}` +
                `printf 'CODE:%s\\n' "$code"; exit 0; fi; ` +
                `p=$(cat ${path}.pid 2>/dev/null) && stamp=$(cat ${path}.st 2>/dev/null) || exit 1; ` +
                `case "$p" in ''|0*|*[!0-9]*) exit 1;; esac; ` +
                `case "$stamp" in ''|*[!0-9]*) exit 1;; esac; ` +
                `boot=$(awk '$1 == "btime" {print $2}' /proc/stat) && recorded=$(stat -c %Y ${path}.st 2>/dev/null) || exit 1; ` +
                `[ -n "$boot" ] && [ "$recorded" -gt "$boot" ] || exit 1; ` +
                `bootId=$(cat /proc/sys/kernel/random/boot_id) || exit 1; ` +
                `current=$(awk '{sub(/^.*\\) /, ""); print $20 ":" $3}' "/proc/$p/stat" 2>/dev/null) || exit 1; ` +
                (adopt
                    ? `group=$(cat ${path}.pgid 2>/dev/null) && [ "$group" = "$p" ] && [ "$current" = "$stamp:$p" ] || exit 1; ` +
                      `out=$(wc -c < ${path}.out) && err=$(wc -c < ${path}.err) || exit 1; `
                    : `[ "\${current%%:*}" = "$stamp" ] || exit 1; out=0; err=0; `) +
                `kill -0 "$p" 2>/dev/null && printf 'RUNNING:%s:%s:%s:%d:%d\\n' "$p" "$stamp" "$bootId" "$out" "$err"`,
            );
            if (result.exitCode === 0) {
                const evidence = result.stdout.trim();
                const code = evidence.match(/^CODE:(\d{1,3})$/);
                if (code && Number(code[1]) <= 255) return { status: "exited", exitCode: Number(code[1]) };
                const running = evidence.match(/^RUNNING:([1-9]\d*):(\d+):([a-f0-9-]{36}):(\d+):(\d+)$/);
                if (running) {
                    const pid = Number(running[1]);
                    const out = Number(running[4]);
                    const err = Number(running[5]);
                    if ([pid, out, err].every(Number.isSafeInteger)) {
                        return {
                            status: "running",
                            identity: { pid, startStamp: running[2]!, bootId: running[3]! },
                            ...(adopt ? { offsets: { out, err } } : {}),
                        };
                    }
                }
            }
        } catch { /* Neither an inaccessible host nor a failed probe establishes a result. */ }
        return { status: "unknown" };
    }

    /** Passive session state for lifecycle bookkeeping. */
    sessionState(sessionId: string): { status: "running" | "exited" | "stopped"; exitCode: number | null } | undefined {
        const entry = this.entries.get(sessionId);
        if (!entry) return undefined;
        const status = entry.running ? "running" : entry.exitCode == null ? "stopped" : "exited";
        return { status, exitCode: entry.exitCode ?? null };
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

    /** Release observers when their transport is destroyed. Remote tasks stay independent. */
    closePolling(): void {
        this.pollingClosed = true;
        for (const entry of this.entries.values()) {
            clearTimeout(entry.pollTimer);
            entry.watchers.clear();
        }
    }

    private startPolling(entry: RemoteEntry): void {
        // 链式调度（审计 H2）：setInterval 下单轮 poll（2~3 次 exec 往返）在网络抖动
        // 时可超 pollMs——并发重入读同 offset 重复喂 watcher、outOffset 双跳静默丢段。
        // 上一轮完成（catch 也算完成）才调度下一轮，永不重入。
        const schedule = () => {
            if (this.pollingClosed) return;
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

    /** 终态冲刷：消费 .out/.err 里游标之后的残余（Astra 二十三期 #2——无尾换行
     *  的最后一行此前被字节游标跳过：.code 出现即 finalize，watcher 对尾行零命中；
     *  Sol 64 #6：曾只冲 .out——stderr 的无换行尾行同样漏 watcher）。进程已死，
     *  残余是终值——补一个换行让末行成行，全量喂 watcher。 */
    private async flushTail(entry: RemoteEntry): Promise<void> {
        return this.consume(entry, async () => {
            // 分路独立 try（Sol 65 #2）：曾两路共用一个 try——stdout 末读抛错连坐
            // 跳过仍可读的 stderr 尾行。每路各自 best-effort
            for (const suffix of [".out", ".err"] as const) {
                try {
                    const bytes = suffix === ".out" ? entry.outBytes : entry.errBytes;
                    const r = await this.exec(
                        `tail -c +${bytes + 1} ${q(entry.base)}${suffix} 2>/dev/null || true`,
                    );
                    // 凭证纪律（Sol 65 #3）：读命令失败（exit≠0）的输出不作行凭证
                    // ——曾据错误输出发 match（thenStop 配置还会误触停止）
                    if (r.exitCode !== 0) continue;
                    const text = (r.stdout || "").replace(/\n$/, "");
                    if (text) {
                        if (suffix === ".out") entry.outBytes += Buffer.byteLength(text + "\n", "utf-8");
                        else entry.errBytes += Buffer.byteLength(text + "\n", "utf-8");
                        const asm = suffix === ".out" ? entry.assembler : entry.errAssembler;
                        const stream = suffix === ".out" ? ("stdout" as const) : ("stderr" as const);
                        for (const line of asm.feed(text + "\n")) this.onLine(entry, line, stream);
                    }
                } catch { /* 冲刷 best-effort——终态本身已确认 */ }
            }
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
                    // 凭证纪律（Sol 66 #1）：读命令失败（exit≠0）的输出不作行凭证
                    // ——曾据错误输出发 match 还推进游标（终态冲刷已查、轮询漏查）
                    if (r.exitCode !== 0) return;
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
                // 分流独立 try（Sol 66 #2）：stdout 读持续抛错曾连坐跳过 stderr
                //（终态冲刷已分路、轮询仍共用）——单流失败不堵另一流
                for (const suffix of [".out", ".err"] as const) {
                    try {
                        await readStream(suffix);
                    } catch { /* 单流读失败——下轮再试 */ }
                }
            });
            // 终态：.code 文件在场 = 进程已退出（nohup 包装的 echo 已落盘）
            const code = await this.readExitCode(entry.base);
            const codeStr = code.exitCode === 0 ? (code.stdout || "").trim() : ""; // 命令失败不采信输出（Sol 57/58 P1-2）
            if (codeStr !== "" && /^\d+$/.test(codeStr)) {
                await this.flushTail(entry); // 终态冲刷：无尾换行的末行也喂 watcher
                this.finalize(entry, parseInt(codeStr, 10));
            } else if (entry.pid != null) {
                // 无 .code 但进程没了（被外部 kill -9）→ unknown 退出码。
                // 组感知（Hydrogen R3 #6）：与 stop/verify 同口径（孙进程持组
                // 仍活=会话还在跑——裸 kill -0 主 PID 曾在多代脚本下提前判死）
                if (await this.probeTree(entry) === false) {
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
                    stream, // 事件流随实参（Sol 65 #1）：曾写死 stdout——stderr 行命中的事件流标错（thenStop/过滤按流分流的消费方全被误导）
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
