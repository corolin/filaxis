/**
 * stream-session-manager.ts — 观察流会话引擎（手眼分离：观察走独立真流式 channel）
 *
 * 净室平移自 个人Agent项目 `原内部模块`
 * ，按 REQ-0001 OSS 化改造：
 * - SessionNotifier 队列投递 → onEvent 纯回调（内核零队列红线）
 * - stderr 双流（FEAT-05）：源版刻意并入同一窗口——OSS 版行对象带 stream 标记，
 *   onLine 桥与热窗口均按流可辨
 * - spawn 注入化（spawnImpl）——零 I/O 假设，mock 全测（AC-06 逻辑面）
 *
 * 设计语义（源生产锤炼）：
 *   - 每个观察流 = 一条独立 SSH channel 子进程（stdout 逐行直推本地，
 *     无轮询、无漏行）；ControlMaster 多路复用共享主连接（连接是稀缺资源——
 *     观察是廉价的）；Windows 无 mux 支持时自动退化直连
 *   - 注意力衰减回收：无人问津且无 armed watcher 超 TTL → 自动收摊 + 事件广播
 *   - 桥接消费方（onLine/onExit）异常不杀流
 */
import * as crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { spawn, type ChildProcess } from "node:child_process";
import { OutputRingBuffer, WatchRegistry, sanitizeSessionName, type SessionLine } from "./session-buffer.js";
import { settleRejection } from "./async-guard.js";
import { Vt100Screen } from "./vt100-screen.js";
import { muxFlagsFor, autonomousSshOpts, type SshConnParams } from "./ssh-helpers.js";
import type { SessionEvent } from "./session-types.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

export interface StreamStartOptions {
    /** Shell script sent to the stream process before EOF. */
    stdinScript?: string;
    name?: string;
    ownerSessionId?: string;
    /** 建立即挂 watcher（真流式命中——无需等轮询） */
    watchPattern?: string;
    watchOnce?: boolean;
    contextLines?: number;
    /** 观察窗流桥：每行对象原样回调（截断/入窗由窗侧自理） */
    onLine?: (line: SessionLine) => void;
    /** 流进程退出回调（观察窗 stale 语义） */
    onExit?: (exitCode: number | null, error?: string) => void;
    /**
     * TUI 屏桥（第五季灵感）：原始 chunk（含 ANSI 转义）喂 Vt100Screen 后回调
     * snapshot（每 chunk 一帧——ncurses 增量包一包一帧）。观察 watch/htop/nvtop
     * 这类无换行的全屏重绘流用 onScreen 截屏，行流用 onLine——两桥可并存。
     */
    onScreen?: (snap: string, frames: number) => void;
}

export type SpawnImpl = (cmd: string, argv: string[], opts: { stdio: unknown[] }) => ChildProcess;

export interface StreamSessionManagerOptions {
    /** 禁用 ControlMaster（测试/平台受限） */
    disableMux?: boolean;
    /** 无人消费且无 armed watcher 的回收 TTL（默认 30min；测试可注入短值） */
    idleReapMs?: number;
    /** spawn 注入（缺省 node:child_process.spawn）——mock 全测关键 */
    spawnImpl?: SpawnImpl;
    /** mux socket 目录（缺省 os.tmpdir()/filaxis-stream-mux） */
    muxDir?: string;
    /** 连接参数（host key 策略渲染——GPT Astra 十三轮 #1：此前硬编码 accept-new
     *  在 argv 最前，调用者 strict 被首见生效规则覆盖；缺省仍 TOFU） */
    connParams?: SshConnParams;
    logger?: FilaxisLogger;
}

export class StreamSessionManager {
    onEvent: (ev: SessionEvent) => void = () => undefined;

    private entries = new Map<string, StreamEntry>();
    private readonly destArgs: string[];
    private readonly muxDisabled: boolean;
    private readonly idleReapMs?: number;
    private readonly spawnImpl: SpawnImpl;
    private readonly muxDir?: string;
    private readonly log: FilaxisLogger;

    private static readonly DEFAULT_IDLE_REAP_MS = 30 * 60 * 1000;

    private readonly sshOpts: string[];

    constructor(destArgs: string[], opts: StreamSessionManagerOptions = {}) {
        this.destArgs = destArgs;
        // Windows OpenSSH 无 ControlMaster 支持（known limitation）——退化直连
        this.muxDisabled = opts.disableMux === true;
        this.idleReapMs = opts.idleReapMs;
        this.spawnImpl = opts.spawnImpl ?? ((cmd, argv, o) => spawn(cmd, argv, o as never) as ChildProcess);
        this.muxDir = opts.muxDir;
        // 策略感知（Astra 十三轮 #1：硬编码 accept-new 抢先生效覆盖调用者 strict）
        this.sshOpts = autonomousSshOpts(opts.connParams);
        this.log = opts.logger ?? noopLogger;
    }

    /** 建立观察流：真流式子进程，stdout/stderr 双流逐行进 ring/watcher */
    async start(command: string, opts: StreamStartOptions = {}): Promise<{ sessionId: string; name?: string }> {
        // 名称规范化（四十期后卫生统一：sessionId 当前只作内存键，但与其余三后端
        // 同一机制防未来接入 shell/文件消费时漏——单一来源 sanitizeSessionName）
        const sessionId = `${opts.name ? sanitizeSessionName(opts.name) + "-" : "stream-"}${crypto.randomBytes(3).toString("hex")}`;
        // 基础选项统一走 autonomousSshOpts（策略感知：strict 传导/缺省 TOFU——
        // Astra 十三轮 #1：此前硬编码 accept-new 在最前，重复 -o 首见生效压掉调用者策略）
        // OpenSSH owns ControlPersist and the socket lifecycle.
        const mux = muxFlagsFor(this.destArgs, { disable: this.muxDisabled, dir: this.muxDir, sshOptions: this.sshOpts });
        const argv = [...this.sshOpts, ...mux, ...this.destArgs, "--", command];
        const child = this.spawnImpl("ssh", argv, {
            stdio: [opts.stdinScript === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        // spawn 启动失败前置监听（Sol 87 P2-8）：error 事件异步到达——桥到 start
        // 的 reject（曾仅 finalizeStream→onExit→窗口 stale，open 照常返回零帧窗、
        // 调用方收不到 ENOENT）。ready 竞速：已 resolve 则归 exit 路径
        let startSettled = false;
        const spawnFailure = new Promise<never>((_, reject) => {
            child.once("error", (e: Error) => {
                if (startSettled) return; // start 已返回——错误归流终态路径
                reject(Object.assign(new Error(`本地 ssh 启动失败（${e.message}）——检查 PATH/可执行文件`), { code: (e as { code?: string }).code, cause: e }));
            });
        });

        const entry: StreamEntry = {
            sessionId, name: opts.name, command, child,
            ring: new OutputRingBuffer({ maxLines: 50, maxLineBytes: 512 }),
            watchers: new WatchRegistry(),
            watcherMeta: new Map(),
            startedAt: Date.now(),
            running: true,
            lastAttentionAt: Date.now(),
            ownerSessionId: opts.ownerSessionId,
            opts,
            decoders: { stdout: new StringDecoder("utf-8"), stderr: new StringDecoder("utf-8") },
            pending: { stdout: new StreamLineBuffer(), stderr: new StreamLineBuffer() },
        };
        this.entries.set(sessionId, entry);

        child.stdout?.on("data", (d: Buffer) => {
            if (entry.finalized) return; // 终态守卫（Sol 54 P2-13：onScreen 曾漏拦——stop 后迟到 stdout 仍触发屏回调）
            const text = entry.decoders.stdout.write(d); // 跨块 UTF-8 安全解码
            if (entry.opts?.onScreen) {
                if (!entry.screen) entry.screen = new Vt100Screen();
                entry.screen.feed(text);
                // 同步 throw + 异步 rejection 双隔离（四十九期补漏——onEvent/onLine/onExit
                // 四十三期已接 async-guard，onScreen 桥漏网）
                try { settleRejection(entry.opts.onScreen(entry.screen.snapshot(), entry.screen.frames)); } catch { /* 桥异常不杀流 */ }
            }
            this.onChunk(entry, text, "stdout");
        });
        child.stderr?.on("data", (d: Buffer) => this.onChunk(entry, entry.decoders.stderr.write(d), "stderr"));
        let closeGuard: ReturnType<typeof setTimeout> | undefined;
        child.on("exit", (code) => {
            entry.exitCode = code;
            entry.running = false;
            // Pipes can still deliver data after the process has exited.
            closeGuard = setTimeout(() => this.finalizeStream(entry, code), 2_000);
            closeGuard.unref?.();
        });
        child.once("close", (code) => {
            clearTimeout(closeGuard);
            entry.running = false;
            this.finalizeStream(entry, code ?? entry.exitCode ?? null);
        });
        child.on("error", (err) => {
            // ChildProcess can emit error for a failed signal. Keep a spawned
            // process registered until its exit or close is observed.
            if (entry.stopRequested) return;
            entry.errorMessage = err.message;
            if (startSettled && child.pid !== undefined) return;
            entry.running = false;
            this.finalizeStream(entry, null);
        });

        if (opts.stdinScript !== undefined) {
            child.stdin?.on("error", () => undefined);
            child.stdin?.end(opts.stdinScript);
        }

        if (opts.watchPattern) {
            this.watch(sessionId, {
                pattern: opts.watchPattern, once: opts.watchOnce ?? true, contextLines: opts.contextLines,
            });
        }
        this.log.info(`[StreamSession ${sessionId}] 流建立（mux=${mux.length > 0}）`);
        // 启动失败竞速（Sol 87 P2-8）：error 在 start await 窗口内到达即 reject；
        // 正常返回前置 settle 标记（后续 error 走流终态）
        const handle = await Promise.race([spawnFailure, new Promise<"ok">((r) => setImmediate(() => r("ok")))]).then(
            (r) => { if (r !== "ok") throw new Error("unreachable"); return { sessionId, name: opts.name }; },
        );
        startSettled = true;
        return handle;
    }

    /** 流式 watcher：行到达即匹配（真流，无轮询间隔） */
    watch(sessionId: string, opts: { pattern: string | RegExp; once?: boolean; contextLines?: number }): { cancel(): void } {
        const e = this.require(sessionId);
        e.lastAttentionAt = Date.now();
        const watcherId = `sw-${crypto.randomBytes(3).toString("hex")}`;
        e.watchers.add({ id: watcherId, pattern: opts.pattern, once: opts.once });
        e.watcherMeta.set(watcherId, { pattern: opts.pattern, contextLines: opts.contextLines, once: opts.once });
        return {
            cancel: () => {
                e.watchers.cancel(watcherId);
                e.watcherMeta.delete(watcherId);
            },
        };
    }

    tail(sessionId: string, n = 50): string[] {
        const e = this.require(sessionId);
        e.lastAttentionAt = Date.now();
        return e.ring.tail(n);
    }

    /** 行对象视图（带 stream 标记——FEAT-05 按流过滤） */
    tailLines(sessionId: string, n = 50): SessionLine[] {
        const e = this.require(sessionId);
        e.lastAttentionAt = Date.now();
        return e.ring.tailLines(n);
    }

    stop(sessionId: string): void {
        const entry = this.require(sessionId);
        if (entry.finalized) {
            this.entries.delete(sessionId);
            return;
        }
        if (entry.stopRequested && Date.now() < entry.stopRequested) return;
        entry.stopRequested = Date.now() + 3000;
        try {
            if (entry.running && !entry.child.kill("SIGTERM") && entry.running) {
                throw new Error("未能向本地 SSH 流进程发出停止信号");
            }
        } catch (cause) {
            entry.stopRequested = undefined;
            throw Object.assign(new Error(`SSH 观察流 '${sessionId}' 停止结果未知`, { cause }), {
                outcome: "unknown", sessionId,
            });
        }
    }

    async stopAndWait(sessionId: string): Promise<void> {
        const entry = this.require(sessionId);
        const finished = entry.finished ??= new Promise<void>((resolve) => { entry.resolveFinished = resolve; });
        this.stop(sessionId);
        if (entry.finalized) return;
        const waitMs = Math.max(0, entry.stopRequested! - Date.now());
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([finished, new Promise<never>((_, reject) => {
                deadline = setTimeout(() => {
                    reject(Object.assign(new Error(`SSH 观察流 '${sessionId}' 退出尚未确认`), {
                        outcome: "unknown", sessionId,
                    }));
                }, waitMs);
            })]);
        } finally {
            clearTimeout(deadline);
        }
    }

    list(): Array<{ sessionId: string; name?: string; command: string; running: boolean; idleMs: number; armedWatchers: number }> {
        const now = Date.now();
        return Array.from(this.entries.values()).map((e) => ({
            sessionId: e.sessionId, name: e.name, command: e.command,
            running: e.running, idleMs: now - e.lastAttentionAt, armedWatchers: e.watcherMeta.size,
        }));
    }

    /** 注意力衰减回收（时钟可注入——测试用）；armed watcher = 常驻注意力不回收 */
    reapIdle(now: number = Date.now(), ttlMs?: number): void {
        const ttl = ttlMs ?? this.idleReapMs ?? StreamSessionManager.DEFAULT_IDLE_REAP_MS;
        for (const e of Array.from(this.entries.values())) {
            if (e.finalized) { this.entries.delete(e.sessionId); continue; }
            if (!e.running) continue;
            if (e.watcherMeta.size > 0) continue;
            if (now - e.lastAttentionAt < ttl) continue;
            this.log.warn(`[StreamSession ${e.sessionId}] 注意力衰减：自动回收`);
            try { this.stop(e.sessionId); }
            catch (error) { this.log.warn(String(error)); }
        }
    }

    private onChunk(entry: StreamEntry, text: string, stream: "stdout" | "stderr"): void {
        if (!text || entry.finalized) return;
        entry.chunkBusy = true;
        try {
            const pending = entry.pending[stream];
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
                pending.append(lines[i]!);
                if (i === lines.length - 1) break;
                const line = pending.take();
                if (line !== "") this.pushLine(entry, stream, line);
            }
        } finally {
            entry.chunkBusy = false;
            if (entry.deferredFinalize !== undefined) {
                const code = entry.deferredFinalize;
                entry.deferredFinalize = undefined;
                this.finalizeStream(entry, code);
            }
        }
    }

    /** 流末收尾：解码器末缓冲 + 残余半行 + 退出通知（幂等——close 与 2s 兜底窗
     *  先到者执行）。收尾前不再拆行（Astra 十六轮 #1：跨 exit/close 的半行合回）。 */
    private finalizeStream(entry: StreamEntry, code: number | null): void {
        if (entry.finalized) return;
        // 块处理中（四十九期 #1）：行回调内 stop()/close 抢入——记 deferred（后写
        // 覆盖：close 的真实退出码优先于 stop 的 null），本块交付完由 onChunk 收尾
        if (entry.chunkBusy) { entry.deferredFinalize = code; return; }
        entry.finalized = true;
        this.drainStreamEnd(entry);
        entry.resolveFinished?.();
        // 桥接消费方异常不杀流（同步 throw + 异步 rejection——孪生对齐审计同款）
        try { settleRejection(entry.opts?.onExit?.(code, entry.errorMessage)); } catch { /* 同 */ }
        this.emit({
            type: "exit", sessionId: entry.sessionId, ownerSessionId: entry.ownerSessionId,
            exitCode: code,
            // spawn error 携带错误消息（自审 1-A：error 路径统一收尾）
            lastLines: entry.errorMessage ? [entry.errorMessage] : entry.ring.tail(10),
        });
        // 条目 TTL 回收（Gemini Hydrogen 审查 #3）：自然退出的流只走 finalize 不经
        // stop——entries 永久滞留（ring/句柄泄漏）。终态后保留短窗供 tail 补读，随后移除
        if (entry.stopRequested) this.entries.delete(entry.sessionId);
        else setTimeout(() => this.entries.delete(entry.sessionId), 60_000)?.unref?.();
    }

    private drainStreamEnd(entry: StreamEntry): void {
        for (const stream of ["stdout", "stderr"] as const) {
            const pending = entry.pending[stream];
            pending.append(entry.decoders[stream].end());
            const line = pending.take();
            if (line !== "") this.pushLine(entry, stream, line);
        }
    }

    private pushLine(entry: StreamEntry, stream: "stdout" | "stderr", raw: string): void {
        {
            const clean = raw.replace(/\r$/, ""); // 超长行跨块一致（四十九期 #2）
            entry.ring.push({ stream, text: clean });
            try { settleRejection(entry.opts?.onLine?.({ stream, text: clean })); } catch { /* 桥接异常不杀流 */ }
            const anchor = entry.ring.size - 1;
            for (const watcherId of entry.watchers.match(clean)) {
                entry.lastAttentionAt = Date.now(); // 命中=被消费的注意力
                const meta = entry.watcherMeta.get(watcherId);
                // 仅一次性 watcher 完成时删 meta（GPT Astra 十六轮 #2：常驻
                // once:false 每次命中删 meta → armed 计数掉 0 → idle 回收误杀常驻观察）
                if (meta?.once !== false) entry.watcherMeta.delete(watcherId);
                this.emit({
                    type: "match",
                    sessionId: entry.sessionId,
                    ownerSessionId: entry.ownerSessionId,
                    watcherId,
                    pattern: String(meta?.pattern ?? "?"),
                    matchedLine: clean,
                    stream,
                    context: entry.ring.contextAround(anchor, meta?.contextLines ?? 5).map((l) => l.text),
                } as SessionEvent);
            }
        }
    }

    private require(sessionId: string): StreamEntry {
        const e = this.entries.get(sessionId);
        if (!e) throw new Error(`stream 会话 '${sessionId}' 不存在`);
        return e;
    }

    private emit(ev: SessionEvent): void {
        try {
            // 异步拒绝隔离（孪生对齐审计·三十七/三十八期 EventBus 模式漏改）
            settleRejection(this.onEvent(ev));
        } catch (err) {
            this.log.warn(`stream event sink threw: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

/** Keep the first and last half of a line. Count input independently of display text. */
class StreamLineBuffer {
    private static readonly HALF = 32 * 1024;
    private head = "";
    private tail = "";
    private length = 0;

    append(text: string): void {
        this.length += text.length;
        const headSize = Math.min(text.length, StreamLineBuffer.HALF - this.head.length);
        this.head += text.slice(0, headSize);
        if (headSize < text.length) {
            this.tail = (this.tail + text.slice(headSize)).slice(-StreamLineBuffer.HALF);
        }
    }

    take(): string {
        const { head, tail, length } = this;
        this.head = this.tail = "";
        this.length = 0;
        if (head.length + tail.length === length) return head + tail;
        const left = head.replace(/[\uD800-\uDBFF]$/, "");
        const right = tail.replace(/^[\uDC00-\uDFFF]/, "");
        return `${left}…[filaxis-truncated ${length - left.length - right.length} chars]${right}`;
    }
}

interface StreamEntry {
    sessionId: string;
    /** Timestamp when an unconfirmed signal may be retried. */
    stopRequested?: number;
    finished?: Promise<void>;
    resolveFinished?: () => void;
    name?: string;
    command: string;
    child: ChildProcess;
    ring: OutputRingBuffer;
    watchers: WatchRegistry;
    watcherMeta: Map<string, { pattern: string | RegExp; contextLines?: number; once?: boolean }>;
    startedAt: number;
    running: boolean;
    lastAttentionAt: number;
    ownerSessionId?: string;
    exitCode?: number | null;
    opts?: StreamStartOptions;
    /** TUI 虚拟屏（onScreen 存在时惰性建） */
    screen?: Vt100Screen;
    /** 流式解码器（GPT Astra 十四轮 #2：data 块边界≠UTF-8 边界——逐块 toString
     *  把跨块多字节字符撕裂成 U+FFFD） */
    decoders: { stdout: StringDecoder; stderr: StringDecoder };
    /** 块处理中标志+延迟收尾（四十九期 #1）：行回调内调用 stop() 时，当前块的
     *  剩余行必须按到达序先交付完——收尾（drain+exit 通知）延迟到本块处理毕 */
    chunkBusy?: boolean;
    deferredFinalize?: number | null;
    /** 未完成行缓冲（块边界≠行边界——`READY\n` 分两块曾成 `RE`/`ADY` 两行，
     *  watcher 漏匹配；残余行留到下块拼接，close 时 flush）。
     *  上限 64KB 保尾截断（Astra 十六轮 #3：无换行长输出曾无限累积——4MiB
     *  pending 且窗口空；截断保最近内容，watcher 关心近期） */
    pending: { stdout: StreamLineBuffer; stderr: StreamLineBuffer };
    /** 流末收尾完成标志（close 与兜底窗幂等） */
    finalized?: boolean;
    /** spawn error 消息（error 路径统一走 finalizeStream 后由收尾携带） */
    errorMessage?: string;
}
