/**
 * local-session-manager.ts — 本地长跑会话引擎（spawn 即返 + 双文件落盘 + 热窗口 + watcher）
 *
 * 净室平移自 个人Agent项目 `原内部模块`
 * ，按 REQ-0001 OSS 化改造：
 * - 剥 上游安全闸（执行网/沙箱属消费方策略——内核不越权预设安全边界）
 * - SessionNotifier 队列投递 → 纯 onEvent 回调（内核零队列红线）
 * - 落盘协议改双文件 `<logBase>.out` / `<logBase>.err`（FEAT-04——源版单文件混写）
 * - 热窗口行对象带 stream 标记；聚合序为到达序（REQ §3.2 跨流顺序契约）
 * - logger 可注入（缺省 noop）；日志目录/Shell 可配
 *
 * 终端语义：start 立即返回，进程长跑（无自动超时——长跑是特性）。
 * 三级读取：文件全量（完整行落盘，1MB/行防爆 + 64MiB 总量硬顶）＋ 热窗口 ＋ watcher 推送。
 * 生命周期：退出后句柄保留 ttlMs（默认 10min）供补读，TTL 后回收（timer unref 不撑进程）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import * as crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { LineAssembler, OutputRingBuffer, WatchRegistry, sanitizeSessionName } from "./session-buffer.js";
import { settleRejection } from "./async-guard.js";
import type {
    SessionStartOptions,
    SessionHandleInfo,
    SessionEvent,
    WatchOptions,
    ReadLogOptions,
    OutputStream,
} from "./session-types.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";
import { resolveLocalShell } from "./shell-discovery.js";
/** 子串语义转义（与 WatchRegistry.toRegex 同规则） */
function escapeRegExp(p: string): string {
    return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 文件侧单行上限（防爆盘；窗口侧 maxLineBytes 截断另算） */
const MAX_FILE_LINE_BYTES = 1_000_000;
/** 会话日志总量硬顶（两流合计；失控输出防写爆 tmpfs）；超限停写文件，ring/watcher 继续 */
const MAX_SESSION_LOG_BYTES = 64 * 1024 * 1024;
/** stop 后 SIGKILL 升级宽限 */
const KILL_GRACE_MS = 1500;

interface SessionEntry {
    sessionId: string;
    command: string;
    startedAt: number;
    ownerSessionId?: string;
    ring: OutputRingBuffer;
    watchers: WatchRegistry;
    watcherMeta: Map<string, WatchOptions>;
    assemblers: Record<OutputStream, LineAssembler>;
    /** 流式解码器（自挖·Astra 十五轮顺藤：逐 data 块 toString 把跨块多字节字符
     *  撕裂成 U+FFFD——与观察流十四轮 #2 同病；LineAssembler 只管行边界） */
    decoders: Record<OutputStream, StringDecoder>;
    logStreams: Record<OutputStream, ReturnType<typeof createWriteStream>>;
    logBase: string;
    logBytes: number;
    logCapped: boolean;
    proc?: ChildProcess;
    running: boolean;
    exitCode?: number | null;
    ttlTimer?: ReturnType<typeof setTimeout>;
}

export interface LocalSessionManagerOptions {
    maxLines?: number;
    maxLineBytes?: number;
    /** 退出后句柄保留时长，默认 10min */
    ttlMs?: number;
    /** 会话日志目录（缺省 os.tmpdir()/filaxis-sessions） */
    logDir?: string;
    /** 执行 shell（缺省 "bash"；Windows 需 Git Bash/WSL 提供 bash——平台差异显式声明，不静默切换） */
    shell?: string;
    /** spawn 注入（缺省 node:child_process.spawn）——消费方沙箱包装/测试 mock 注入点 */
    spawnImpl?: (cmd: string, argv: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; stdio: unknown[] }) => ChildProcess;
    /** 可注入日志（缺省 noop——SDK 不替调用方往 stdout 喷日志） */
    logger?: FilaxisLogger;
}

export class LocalSessionManager {
    /** 事件回调（FEAT-09：消费方订阅点；缺省 noop）。回调异常被吞并记日志，不杀会话 */
    onEvent: (ev: SessionEvent) => void = () => undefined;

    private readonly entries = new Map<string, SessionEntry>();
    private readonly maxLines: number;
    private readonly maxLineBytes: number;
    private readonly ttlMs: number;
    private readonly logDir: string;
    private readonly shell: string;
    private readonly log: FilaxisLogger;
    private readonly spawnImpl: LocalSessionManagerOptions["spawnImpl"];

    constructor(opts: LocalSessionManagerOptions = {}) {
        this.maxLines = opts.maxLines ?? 50;
        this.maxLineBytes = opts.maxLineBytes ?? 512;
        this.ttlMs = opts.ttlMs ?? 10 * 60_000;
        this.logDir = opts.logDir ?? path.join(tmpdir(), "filaxis-sessions");
        this.log = opts.logger ?? noopLogger;
        this.shell = resolveLocalShell(opts.shell, this.log);
        this.spawnImpl = opts.spawnImpl ?? ((cmd, argv, o) => spawn(cmd, argv, o as never) as ChildProcess);
    }

    /** 启动长跑会话：立即返回句柄 */
    async start(command: string, opts: SessionStartOptions = {}): Promise<SessionHandleInfo> {
        const sessionId =
            `${opts.name ? sanitizeSessionName(opts.name) + "-" : "sess-"}` +
            crypto.randomBytes(4).toString("hex");

        await fs.mkdir(this.logDir, { recursive: true });
        const logBase = path.join(this.logDir, sessionId);

        const entry: SessionEntry = {
            sessionId,
            command,
            startedAt: Date.now(),
            ownerSessionId: opts.ownerSessionId,
            ring: new OutputRingBuffer({ maxLines: this.maxLines, maxLineBytes: this.maxLineBytes }),
            watchers: new WatchRegistry(),
            watcherMeta: new Map(),
            assemblers: { stdout: new LineAssembler(), stderr: new LineAssembler() },
            decoders: { stdout: new StringDecoder("utf-8"), stderr: new StringDecoder("utf-8") },
            logStreams: {
                // error 监听（Hydrogen R6 #5）：磁盘满/IO 异常曾直崩宿主（写日志尽力而为）
                stdout: createWriteStream(`${logBase}.out`).on("error", () => undefined),
                stderr: createWriteStream(`${logBase}.err`).on("error", () => undefined),
            },
            logBase,
            logBytes: 0,
            logCapped: false,
            running: true,
        };
        this.entries.set(sessionId, entry);

        const env = { ...process.env, ...opts.env };
        const cwd = opts.cwd || process.cwd();
        // 注：不 unref——unref 的子进程在 Bun 下不保活事件循环，close/exit 事件会静默丢失。
        // POSIX 下 detached=true（审计 H1）：子进程自成进程组——stop 可组杀整棵树（管道/
        // 守护孙进程不再孤儿化挂 PID 1）；Windows 走 taskkill /T 树杀，无需 detached。
        let proc: ChildProcess;
        try {
            proc = this.spawnImpl!(this.shell, ["-c", command], {
                env,
                cwd,
                stdio: ["ignore", "pipe", "pipe"],
                ...(process.platform !== "win32" ? { detached: true } : {}),
            });
        } catch (e) {
            // spawnImpl 同步异常回滚（Hydrogen R6 #5）：cwd 不存在/权限等——曾遗留
            // 已登记 entry 与两个打开的 WriteStream（内存+fd 泄漏）
            this.entries.delete(sessionId);
            for (const st of [entry.logStreams.stdout, entry.logStreams.stderr]) st.end();
            throw e;
        }
        entry.proc = proc;

        proc.stdout?.on("data", (buf: Buffer) => this.ingestChunk(entry, entry.decoders.stdout.write(buf), "stdout"));
        proc.stderr?.on("data", (buf: Buffer) => this.ingestChunk(entry, entry.decoders.stderr.write(buf), "stderr"));

        proc.on("close", (code) => {
            // decoder 残余 drain 收在 finalize 内（双入口统一——close 与 exit 兜底同权）
            this.finalize(entry, code);
        });
        // exit 2s 兜底（孪生对齐审计·十六期 Stream finalizeStream 同款漏改）：孙进程
        // 持 stdio 管道（`sh -c "sleep 100 & ..."`——主 shell 退了 sleep 还握着管道写端）
        // 时 close 永不触发 → finalize 永不跑 → running 谎报 true + TTL 不启动 +
        // watcher 悬置。exit 事件不看管道只看进程——挂 2s 兜底（close 先到则 finalize
        // 幂等挡掉，孙进程管道排空通常 <2s），终态一声（finalize 幂等）
        proc.on("exit", (code) => {
            setTimeout(() => this.finalize(entry, code), 2_000).unref?.();
        });
        proc.on("error", (err) => {
            this.ingestLine(entry, `[session-error] ${err.message}`, "stderr");
            this.finalize(entry, null);
        });

        this.log.info(`[Session ${sessionId}] started: ${command.slice(0, 80)} (pid=${proc.pid})`);
        return { sessionId, logBase, pid: proc.pid };
    }

    /** 热窗口快照（最近 n 行 text 投影，默认 50；不碰盘） */
    tail(sessionId: string, n = 50): string[] {
        return this.require(sessionId).ring.tail(n);
    }

    /** 热窗口行对象（带 stream 标记——按流过滤消费） */
    tailLines(sessionId: string, n = 50) {
        return this.require(sessionId).ring.tailLines(n);
    }

    /** 文件全量/大范围读取（窗口滚出的内容在这里；双文件按流分读）。
     *  lines 尾窗走尾部块读（Hydrogen R8 #3）：曾 64MiB 全量读入+split=数百 MB
     *  堆峰值（多会话并发/容器限额下 OOM）——只读尾块 lines*512B 再切行 */
    async readLog(sessionId: string, opts: ReadLogOptions = {}): Promise<string> {
        const entry = this.require(sessionId);
        const file = opts.stream === "stderr" ? `${entry.logBase}.err` : `${entry.logBase}.out`;
        let content: string;
        try {
            if (opts.lines && !opts.offsetLines) {
                // 尾窗快路径：从文件尾读 lines*512B 块（行均宽余量），首行可能截半——
                // 与 tail -n 的「最老一行可能不完整」语义一致，可接受
                const st = await fs.stat(file);
                const want = Math.min(st.size, Math.max(1024, opts.lines * 512));
                const fh = await fs.open(file, "r");
                try {
                    const buf = Buffer.alloc(want);
                    await fh.read(buf, 0, want, st.size - want);
                    content = buf.toString("utf-8");
                } finally {
                    await fh.close();
                }
                const linesArr = content.split("\n");
                if (linesArr.length > opts.lines) linesArr.splice(0, linesArr.length - opts.lines);
                return linesArr.join("\n");
            }
            content = await fs.readFile(file, "utf-8");
        } catch {
            return ""; // 流文件尚未创建（该流无输出）→ 空而非异常
        }
        let lines = content.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        if (opts.offsetLines) lines = lines.slice(opts.offsetLines);
        if (opts.lines) lines = lines.slice(-opts.lines);
        return lines.join("\n");
    }

    /**
     * 注册 watcher：**回溯匹配**热窗口已有行（spawn→watch 注册间隙的输出不漏——
     * 与 ready() 同款语义；真实反馈：bash 冷启热后 GO 常在注册前已进窗口），
     * 未命中再匹配未来行；命中 → onEvent("match")。
     */
    watch(sessionId: string, opts: WatchOptions): { cancel(): void } {
        const entry = this.require(sessionId);
        const watcherId = `w-${crypto.randomBytes(3).toString("hex")}`;
        entry.watchers.add({ id: watcherId, pattern: opts.pattern, once: opts.once });
        entry.watcherMeta.set(watcherId, opts);
        // 回溯：窗口已有行命中即发（once 语义保持——命中即摘除）
        const regex = opts.pattern instanceof RegExp
            // 克隆剥 g/y（Hydrogen R2 #3）：带状态正则 test 推进 lastIndex 交替漏匹配——
            // 与 watch/WatchRegistry.toRegex 同款（十七轮 #2）
            ? new RegExp(opts.pattern.source, opts.pattern.flags.replace(/[gy]/g, ""))
            : new RegExp(escapeRegExp(String(opts.pattern)));
        for (const l of entry.ring.tailLines(Infinity)) {
            if (regex.test(l.text)) {
                if (opts.once !== false) {
                    entry.watchers.cancel(watcherId);
                    entry.watcherMeta.delete(watcherId);
                }
                if (opts.thenStop) void this.stop(sessionId).catch(() => undefined);
                this.emit({
                    type: "match", sessionId, ownerSessionId: entry.ownerSessionId, watcherId,
                    pattern: String(opts.pattern), matchedLine: l.text, stream: l.stream,
                    context: entry.ring.contextAround(entry.ring.size - 1, opts.contextLines ?? 5).map((c) => c.text),
                });
                break; // 回溯命中一次即止（未来行交给在线匹配）
            }
        }
        return {
            cancel: () => {
                entry.watchers.cancel(watcherId);
                entry.watcherMeta.delete(watcherId);
            },
        };
    }

    /**
     * 就绪握手（FEAT-11 / AC-13）：先回溯扫描热窗口已有行（覆盖 spawn→ready
     * 调用间隙已输出的标记——只监听增量则快输出进程必漏），未命中再监听增量行。
     * 滚出感知有据：evictedCount===0 → 窗口历史完整，标记确定未出现，安心等待；
     * >0 → 历史可能不完整，报「标记可能已滚出（可回查落盘日志）」而非死等。
     * 超时 → 自动 stop 清理（不留孤儿进程）。
     */
    async ready(
        sessionId: string,
        opts: { pattern: string | RegExp; timeoutMs: number },
    ): Promise<{ matchedLine: string }> {
        const entry = this.require(sessionId);
        const regex = opts.pattern instanceof RegExp
            ? opts.pattern
            : new RegExp(opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        // ① 回溯：窗口已有行命中即立即 resolve
        for (const l of entry.ring.tailLines(Infinity)) {
            if (regex.test(l.text)) return { matchedLine: l.text };
        }
        if (entry.ring.evictedCount > 0) {
            throw new Error(
                `就绪标记可能已滚出热窗口（evicted=${entry.ring.evictedCount}，历史不完整）——` +
                `可经 readLog 回查 ${entry.logBase}.out/.err，或加大窗口后重启会话`,
            );
        }
        // ② 增量监听（一次性内部 watcher）
        return await new Promise<{ matchedLine: string }>((resolve, reject) => {
            const w = this.watch(sessionId, { pattern: opts.pattern, once: true });
            let poll: ReturnType<typeof setInterval> | undefined;
            const timer = setTimeout(() => {
                if (poll) clearInterval(poll);
                w.cancel();
                // 超时自动清理（AC-13）+ **停止结果诚实三态**（三十四期 P1 同款病——
                // 旧 fire-and-forget stop 后立即谎称「已自动停止」：unknown 时任务可能
                // 仍在跑。修：等 stop 三态再 reject——exited/stopped 如实说，unknown
                // 挂 outcome+会话线索供核实）
                void this.stop(sessionId).then(
                    (r) => {
                        const e = new Error(
                            r.status === "exited" || r.status === "stopped"
                                ? `ready() 超时（${opts.timeoutMs}ms）未见到就绪标记——已停止（status=${r.status}${r.exitCode != null ? `, exitCode=${r.exitCode}` : ""}）`
                                : `ready() 超时（${opts.timeoutMs}ms）未见到就绪标记——停止结果未知（**任务可能仍在运行**，勿盲目重试；核实会话 ${sessionId} 日志 ${entry.logBase}）`,
                        ) as Error & { outcome: string; sessionId: string; logBase: string };
                        e.outcome = r.status === "exited" || r.status === "stopped" ? r.status : "unknown";
                        e.sessionId = sessionId;
                        e.logBase = entry.logBase;
                        reject(e);
                    },
                    (stopErr) => {
                        const e = new Error(
                            `ready() 超时（${opts.timeoutMs}ms）未见到就绪标记——停止失败（${stopErr instanceof Error ? stopErr.message : String(stopErr)}）：**任务可能仍在运行**，勿盲目重试；核实会话 ${sessionId} 日志 ${entry.logBase}`,
                        ) as Error & { outcome: string; sessionId: string; logBase: string };
                        e.outcome = "unknown";
                        e.sessionId = sessionId;
                        e.logBase = entry.logBase;
                        reject(e);
                    },
                );
            }, opts.timeoutMs);
            poll = setInterval(() => {
                const e = this.entries.get(sessionId);
                if (!e) {
                    clearTimeout(timer); clearInterval(poll!);
                    reject(new Error(`会话 ${sessionId} 已消失（终态回收）`));
                    return;
                }
                // 进程已退出（Hydrogen R2 #3）：TTL 回收前 entry 仍在——曾只查 !e，
                // 进程崩溃后空转到 timeoutMs 误报「超时」而非「进程已退出」
                if (!e.running) {
                    clearTimeout(timer); clearInterval(poll!); w.cancel();
                    reject(new Error(`会话 ${sessionId} 已退出（exitCode=${e.exitCode ?? "?"}），就绪标记未出现`));
                    return;
                }
                // 全窗回溯（审计 M3：旧 tailLines(5) 在 30ms 间隙内输出超 5 行时标记
                // 滑出窗口——watcher 注册了但命中未绑 resolve，超时误杀健康进程）。
                // ring 本就是热窗（上限行数），全扫成本可忽略
                for (const l of e.ring.tailLines(Infinity)) {
                    if (regex.test(l.text)) {
                        clearTimeout(timer); clearInterval(poll!); w.cancel();
                        resolve({ matchedLine: l.text });
                        return;
                    }
                }
            }, 15);
            poll.unref?.();
            if (!entry.running) {
                clearTimeout(timer); clearInterval(poll); w.cancel(); // 曾漏 cancel（Hydrogen R2 #3）
                reject(new Error(`会话 ${sessionId} 已退出（exitCode=${entry.exitCode ?? "?"}），就绪标记未出现`));
            }
        });
    }

    /**
     * 停止会话：SIGTERM → 宽限 → SIGKILL 升级；核实窗盖过升级时刻
     * （FEAT-04：终止即请求、死亡须核实——close 事件到达=exited 带退出码；
     *  核实窗内仍未死=**unknown**（GPT Astra 二轮 #2：旧窗 1s < KILL_GRACE 1.5s，
     *  SIGKILL 还没发就返回 stopped 且 running:true——不伪 stopped，宪法三态诚实）
     */
    async stop(sessionId: string): Promise<{ status: "exited" | "stopped" | "unknown"; exitCode?: number | null }> {
        const entry = this.require(sessionId);
        if (!entry.running) {
            return { status: "exited", exitCode: entry.exitCode };
        }
        if (entry.proc?.pid) {
            const pid = entry.proc.pid;
            // 进程树收割（审计 H1）：顶级 shell 死后孙进程（管道段/守护脚本）存活——
            // POSIX 组杀（detached 进程组，-pid 全组）；Windows taskkill /T 树杀
            if (process.platform === "win32") {
                // error 监听兜底（二十五期模式散点）：fire-and-forget spawn 无监听，
                // ENOENT 时异步 error = uncaughtException 崩宿主（taskkill 系统自带，
                // 防御性一行）
                spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" }).on("error", () => undefined);
            } else {
                try { process.kill(-pid, "SIGTERM"); } catch { try { entry.proc.kill("SIGTERM"); } catch { /* gone */ } }
            }
            setTimeout(() => {
                // 已在宽限期内退出（Hydrogen R2 #4）：不再对旧 PID 发 KILL——
                // 高并发下 PID 快速复用时误杀同号新进程
                if (!entry.running) return;
                if (process.platform === "win32") {
                    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" }).on("error", () => undefined);
                } else {
                    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
                }
                // 句柄回收兜底（审计 H1 Windows 分支 + Astra 二十轮 #1）：孙进程持有 stdio
                // 管道时 close 可能永不触发（内存泄漏）——KILL 后仍活着就销毁管道流回收
                // 句柄。**只回收资源不置终态**：destroy 不杀进程、不证明死亡——running
                // 保持 true，死亡核实窗自然超时 → unknown（绝不伪造 exited）
                setTimeout(() => {
                    if (entry.running) {
                        try { entry.proc?.stdout?.destroy(); } catch { /* already */ }
                        try { entry.proc?.stderr?.destroy(); } catch { /* already */ }
                    }
                }, 500).unref?.();
            }, KILL_GRACE_MS).unref();
        }
        // 核实窗 ≥ SIGKILL 升级时刻 + close 回调余量（local 子进程 close 可靠）
        const deadline = Date.now() + KILL_GRACE_MS + 1_000;
        while (entry.running && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        if (!entry.running) return { status: "exited", exitCode: entry.exitCode };
        return { status: "unknown", exitCode: null }; // SIGKILL 已发仍未观察到退出——死亡未确认
    }

    /** 会话核实（Gemini Hydrogen 审查 #7）：内存态 + pid 实测——close 回调未达/
     *  exit 兜底窗内不谎报 running（与 RemoteSessionManager.verify 同语义） */
    verify(sessionId: string): { status: "running" | "exited" | "unknown"; exitCode?: number | null } {
        const e = this.require(sessionId);
        if (!e.running) return { status: "exited", exitCode: e.exitCode ?? null };
        if (e.proc?.pid == null) return { status: "unknown" };
        try {
            process.kill(e.proc.pid, 0); // 信号 0=探测不发送
            return { status: "running" };
        } catch {
            return { status: "unknown" }; // 已死但 close 未到——死亡未证实，终态不明
        }
    }

    list(): Array<{ sessionId: string; command: string; running: boolean; startedAt: number }> {
        return Array.from(this.entries.values()).map((e) => ({
            sessionId: e.sessionId,
            command: e.command,
            running: e.running,
            startedAt: e.startedAt,
        }));
    }

    // ── 内部 ─────────────────────────────────────────────

    private require(sessionId: string): SessionEntry {
        const e = this.entries.get(sessionId);
        if (!e) throw new Error(`session '${sessionId}' 不存在（可能已终态被 TTL 回收）`);
        return e;
    }

    private ingestChunk(entry: SessionEntry, text: string, stream: OutputStream): void {
        // 终态后到达的管道尾数据不进装配（孙进程持管道 + exit 兜底 finalize 场景）：
        // logStreams 已 end，再 write 会触发未监听的流 error 崩宿主；终态语义也已封板
        if (!entry.running) return;
        this.ingestLines(entry, text, stream);
    }

    /** 信任路径（终态 drain 用）：不经 running 拦截直接进行装配 */
    private ingestLines(entry: SessionEntry, text: string, stream: OutputStream): void {
        for (const line of entry.assemblers[stream].feed(text)) this.ingestLine(entry, line, stream);
    }

    private ingestLine(entry: SessionEntry, fullLine: string, stream: OutputStream): void {
        // 文件侧写完整行（1MB 防爆）+ 总量硬顶（64MiB 两流合计）；窗口侧截断
        const fileChunk = fullLine.length > MAX_FILE_LINE_BYTES
            ? fullLine.slice(0, MAX_FILE_LINE_BYTES) + "\n[…file-line-truncated]"
            : fullLine;
        if (!entry.logCapped) {
            entry.logBytes += fileChunk.length + 1;
            if (entry.logBytes > MAX_SESSION_LOG_BYTES) {
                entry.logCapped = true;
                for (const s of ["stdout", "stderr"] as const) {
                    entry.logStreams[s].end(
                        s === stream
                            ? `[log-capped: session log exceeded ${MAX_SESSION_LOG_BYTES} bytes, file writes suppressed; ring buffer continues]\n`
                            : `[log-capped]\n`,
                    );
                }
            } else {
                entry.logStreams[stream].write(fileChunk + "\n");
            }
        }
        entry.ring.push({ stream, text: fullLine });

        const anchor = entry.ring.size - 1;
        for (const watcherId of entry.watchers.match(fullLine)) {
            const meta = entry.watcherMeta.get(watcherId);
            // 仅一次性 watcher 完成时删 meta（Astra 十六轮 #2——local 漏改对齐：常驻
            // once:false 每次命中删 meta → pattern 变 "?"、armed 计数掉 0）
            if (meta?.once !== false) entry.watcherMeta.delete(watcherId);
            // ★ thenStop：命中即收摊——观察对象结束，观察者退场（防遗忘泄漏）
            if (meta?.thenStop) {
                void this.stop(entry.sessionId).catch(() => undefined);
            }
            this.emit({
                type: "match",
                sessionId: entry.sessionId,
                ownerSessionId: entry.ownerSessionId,
                watcherId,
                pattern: String(meta?.pattern ?? "?"),
                matchedLine: entry.ring.tail(1)[0] ?? fullLine,
                stream,
                context: entry.ring.contextAround(anchor, meta?.contextLines ?? 5).map((l) => l.text),
            });
        }
    }

    private finalize(entry: SessionEntry, exitCode: number | null): void {
        if (!entry.running) return;
        entry.running = false;
        entry.exitCode = exitCode;

        // decoder 残余字节先进行装配（close/exit 兜底双入口统一——Stream
        // finalizeStream drainStreamEnd 同款；ingestLines 信任路径绕过终态拦截）
        this.ingestLines(entry, entry.decoders.stdout.end(), "stdout");
        this.ingestLines(entry, entry.decoders.stderr.end(), "stderr");
        for (const s of ["stdout", "stderr"] as const) {
            for (const line of entry.assemblers[s].flush()) this.ingestLine(entry, line, s);
            if (!entry.logCapped) entry.logStreams[s].end();
        }
        entry.watchers.clear(); // 终态后 watcher 不再命中（对齐 Remote finalize——孙进程尾数据不误触发）
        entry.watcherMeta.clear();

        this.emit({
            type: "exit",
            sessionId: entry.sessionId,
            ownerSessionId: entry.ownerSessionId,
            exitCode,
            lastLines: entry.ring.tail(20),
        });
        this.log.info(`[Session ${entry.sessionId}] exited code=${exitCode}`);

        // TTL 回收（unref：不撑进程）
        entry.ttlTimer = setTimeout(() => this.entries.delete(entry.sessionId), this.ttlMs).unref();
    }

    private emit(ev: SessionEvent): void {
        try {
            // 异步拒绝隔离（孪生对齐审计·三十七/三十八期 EventBus 模式漏改）：
            // async onEvent 回调的 rejection 若不同化，逃逸为 unhandledRejection
            // 崩宿主——try/catch 只捕同步
            settleRejection(this.onEvent(ev));
        } catch (err) {
            this.log.warn(`session event sink threw: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
