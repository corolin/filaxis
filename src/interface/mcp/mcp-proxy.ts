/**
 * mcp-proxy.ts — filaxis-mcp stdio ↔ Daemon HTTP/SSE 保活代理
 *
 * 设计要点（REQ-0005 Phase 3）：
 * - 零第三方依赖：仅使用 node:http / node:readline / node:string_decoder；
 * - 单 stdin 读循环：重连时绝不重复创建 readline 监听器；
 * - Watchdog + 退避重连 + Token 轮换重读：每次建连前重读 daemon.addr 与 daemon.token，并先过
 *   线协议握手（Daemon 中途被换成另一个版本时拒绝接入，不把请求交给它）；
 * - 语义不变量（AC-07 零自动重放）：一旦 SSE 断连，在途已 POST 的请求立即回传
 *   JSON-RPC error (outcome="unknown") 并清空 inFlight，绝不自动重放非幂等调用。
 */
import * as http from "node:http";
import * as readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { defaultDaemonDir, readDaemonConnection } from "../daemon/daemon-files.js";
import { DaemonClient, parseAddrToUrl, ProtocolMismatchError, urlRequestHost, urlRequestPort } from "../daemon/daemon-client.js";
import { noopLogger, type FilaxisLogger } from "../../shared/logger.js";
import { PROTOCOL_VERSION } from "../../middle/protocol.js";
import { CALLER_CWD_HEADER, encodeCallerCwd } from "./call-context.js";

export interface McpStdioProxyOptions {
    daemonDir?: string;
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    logger?: FilaxisLogger;
    watchdogIdleMs?: number;
    initialReconnectDelayMs?: number;
    maxReconnectDelayMs?: number;
    maxInFlight?: number;
    /** 代理自行终止时调用（重连时发现 Daemon 的线协议版本与自己的不一致）。此后代理不再工作 */
    onFatal?: (error: Error) => void;
}

interface PendingMessage {
    raw: string;
    id?: number | string;
    method?: string;
}

interface ActiveSseSession {
    addr: string;
    token: string;
    baseUrl: URL;
    postPath?: string;
    activeNotifPosts: number;
    abort: (err?: Error) => void;
}

interface InFlightRequest {
    id: number | string;
    method: string;
}

const DEFAULT_WATCHDOG_IDLE_MS = 45_000;
const DEFAULT_INITIAL_RECONNECT_MS = 200;
const DEFAULT_MAX_RECONNECT_MS = 5_000;
const DEFAULT_MAX_IN_FLIGHT = 128;
const MAX_PENDING_QUEUE = 1024;
const POST_TIMEOUT_MS = 10_000;

function idKey(id: number | string): string {
    return `${typeof id}:${String(id)}`;
}

export class McpStdioProxy {
    private readonly daemonDir: string;
    private readonly input: NodeJS.ReadableStream;
    private readonly out: NodeJS.WritableStream;
    private readonly log: FilaxisLogger;
    private readonly watchdogIdleMs: number;
    private readonly initialReconnectDelayMs: number;
    private readonly maxReconnectDelayMs: number;
    private readonly maxInFlight: number;
    private readonly onFatal?: (error: Error) => void;

    private rl?: readline.Interface;
    private started = false;
    private closed = false;
    private activeSession: ActiveSseSession | null = null;
    /** 在途的线协议握手请求：代理收尾时中止它，不让它把进程拖住 */
    private handshakeAbort: AbortController | null = null;
    private sleepTimer: ReturnType<typeof setTimeout> | null = null;
    private wakeSleep: (() => void) | null = null;
    private reconnectDelayMs: number;

    private readonly pendingQueue: PendingMessage[] = [];
    private readonly inFlight = new Map<string, InFlightRequest>();

    constructor(opts: McpStdioProxyOptions = {}) {
        this.daemonDir = opts.daemonDir ?? defaultDaemonDir();
        this.input = opts.stdin ?? process.stdin;
        this.out = opts.stdout ?? process.stdout;
        this.log = opts.logger ?? noopLogger;
        this.watchdogIdleMs = opts.watchdogIdleMs ?? DEFAULT_WATCHDOG_IDLE_MS;
        this.initialReconnectDelayMs = opts.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_MS;
        this.maxReconnectDelayMs = opts.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_MS;
        this.maxInFlight = opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
        this.onFatal = opts.onFatal;
        this.reconnectDelayMs = this.initialReconnectDelayMs;
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        this.rl = readline.createInterface({ input: this.input, terminal: false });
        this.rl.on("line", (line) => this.onLine(line));
        this.rl.on("close", () => {
            this.log.info("[mcp-proxy] stdin 关闭——仅退出代理，Daemon 现场继续保留");
            this.close();
        });
        void this.connectLoop();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.sleepTimer) {
            clearTimeout(this.sleepTimer);
            this.sleepTimer = null;
        }
        this.wakeSleep?.();
        this.wakeSleep = null;
        this.activeSession?.abort();
        this.activeSession = null;
        this.handshakeAbort?.abort();
        this.handshakeAbort = null;
        this.rl?.close();
    }

    private writeStdout(msg: Record<string, unknown> | string): void {
        if (this.closed) return;
        const line = typeof msg === "string" ? msg : JSON.stringify(msg);
        this.out.write(line.endsWith("\n") ? line : `${line}\n`);
    }

    private onLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            const idMatch = trimmed.match(/"id"\s*:\s*(\d+|"[^"]*")/);
            let id: number | string | null = null;
            if (idMatch) {
                try { id = JSON.parse(idMatch[1]!) as number | string; } catch { id = null; }
            }
            this.writeStdout({
                jsonrpc: "2.0",
                id,
                error: { code: -32700, message: "Parse error: invalid JSON" },
            });
            return;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            this.writeStdout({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32600, message: `Invalid Request: expected object, got ${parsed === null ? "null" : typeof parsed}` },
            });
            return;
        }
        const obj = parsed as Record<string, unknown>;
        const rawId = obj.id;
        const hasId = (typeof rawId === "number" || typeof rawId === "string");
        if (this.pendingQueue.length >= MAX_PENDING_QUEUE) {
            if (hasId) {
                this.writeStdout({
                    jsonrpc: "2.0",
                    id: rawId,
                    error: {
                        code: -32000,
                        message: `MCP 代理待发队列已满 (${MAX_PENDING_QUEUE})，拒绝接收新请求（outcome=unknown）`,
                        data: { outcome: "unknown", reason: "queue_overflow" },
                    },
                });
            }
            return;
        }
        this.pendingQueue.push({
            raw: trimmed,
            ...(hasId ? { id: rawId } : {}),
            ...(typeof obj.method === "string" ? { method: obj.method } : {}),
        });
        this.pumpQueue();
    }

    private failOneInFlight(entry: InFlightRequest | undefined, message: string, data: { outcome?: "unknown"; statusCode?: number }): void {
        if (!entry) return;
        const key = idKey(entry.id);
        if (this.inFlight.get(key) !== entry) return;
        this.inFlight.delete(key);
        this.writeStdout({
            jsonrpc: "2.0",
            id: entry.id,
            error: {
                code: -32000,
                message,
                data: { method: entry.method, ...data },
            },
        });
    }

    private failInFlight(reason: string): void {
        if (this.inFlight.size === 0) return;
        const entries = [...this.inFlight.values()];
        this.inFlight.clear();
        for (const entry of entries) {
            this.writeStdout({
                jsonrpc: "2.0",
                id: entry.id,
                error: {
                    code: -32000,
                    message: `${reason}——远端执行状态未知（outcome=unknown），内核不会自动重放该请求，请核实远端状态后由调用方决定是否重试`,
                    data: { outcome: "unknown", method: entry.method },
                },
            });
        }
    }

    private pumpQueue(): void {
        const session = this.activeSession;
        if (this.closed || !session || !session.postPath) return;

        while (this.pendingQueue.length > 0 && (this.inFlight.size + session.activeNotifPosts) < this.maxInFlight) {
            const item = this.pendingQueue.shift()!;
            this.dispatchPost(session, item);
        }
    }

    private dispatchPost(session: ActiveSseSession, item: PendingMessage): void {
        const entry = item.id === undefined ? undefined : { id: item.id, method: item.method ?? "unknown" };
        if (entry) {
            this.inFlight.set(idKey(entry.id), entry);
        } else {
            session.activeNotifPosts++;
        }

        let postDone = false;
        const releaseNotif = () => {
            if (postDone) return;
            postDone = true;
            if (!entry) {
                session.activeNotifPosts--;
            }
        };

        const payload = Buffer.from(item.raw, "utf-8");
        const req = http.request({
            protocol: session.baseUrl.protocol,
            hostname: urlRequestHost(session.baseUrl),
            port: urlRequestPort(session.baseUrl),
            path: session.postPath,
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": String(payload.byteLength),
                Authorization: `Bearer ${session.token}`,
            },
            agent: false,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (d: Buffer) => chunks.push(d));
            res.on("end", () => {
                releaseNotif();
                const code = res.statusCode ?? 0;
                if (code < 200 || code >= 300) {
                    const detail = Buffer.concat(chunks).toString("utf-8").slice(0, 200);
                    const rejectedBeforeExecution = code === 413;
                    this.failOneInFlight(
                        entry,
                        `Daemon POST 失败 (HTTP ${code}): ${detail || "request rejected"}${rejectedBeforeExecution ? "" : "（outcome=unknown，不自动重放）"}`,
                        rejectedBeforeExecution ? { statusCode: code } : { statusCode: code, outcome: "unknown" },
                    );
                    if (code === 401 || code === 404) {
                        if (this.activeSession === session) session.abort();
                    }
                }
                this.pumpQueue();
            });
            res.on("error", (err) => {
                releaseNotif();
                this.failOneInFlight(
                    entry,
                    `Daemon POST 响应读取失败（${err.message}）——远端执行状态未知（outcome=unknown），不自动重放`,
                    { outcome: "unknown" },
                );
                if (this.activeSession === session) session.abort();
                this.pumpQueue();
            });
        });

        req.setTimeout(POST_TIMEOUT_MS, () => {
            req.destroy(new Error(`Daemon POST 超时 (${POST_TIMEOUT_MS}ms)`));
        });

        req.on("error", (err) => {
            releaseNotif();
            this.failOneInFlight(
                entry,
                `Daemon POST 连接失败（${err.message}）——远端执行状态未知（outcome=unknown），不自动重放`,
                { outcome: "unknown" },
            );
            if (this.activeSession === session) session.abort();
            this.pumpQueue();
        });

        req.write(payload);
        req.end();
    }

    private async connectLoop(): Promise<void> {
        while (!this.closed) {
            const conn = readDaemonConnection(this.daemonDir);
            if (!conn) {
                await this.waitReconnect();
                continue;
            }
            // 每次建连前都过线协议握手，不只是启动器首次连接时：Daemon 中途被换成另一个版本
            // （升级/回滚后重启），重连不能把请求交给它。握手没答上来同样不开连接——稍后再试
            const handshake = await this.handshake(conn.addr, conn.token);
            if (this.closed) return; // 握手在途时 stdin 关闭：迟到的结果不再触发任何连接
            if (handshake === "unanswered") {
                await this.waitReconnect();
                continue;
            }
            if (handshake instanceof ProtocolMismatchError) {
                this.failQueued(`Daemon 线协议版本不一致，请求未发出：${handshake.message}`, "not_sent");
                this.close();
                this.onFatal?.(handshake);
                return;
            }
            try {
                await this.runSseSession(conn.addr, conn.token);
            } catch (err) {
                if (!this.closed) {
                    this.log.warn(`[mcp-proxy] SSE 会话断开: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (!this.closed) {
                this.failInFlight("Daemon SSE 连接中断");
                await this.waitReconnect();
            }
        }
    }

    /**
     * 建连前的线协议握手，三种结果：版本一致；没答上来（连接不上、报错、超时——算还没就绪，
     * 但绝不在这种情况下开连接）；答了但版本不一致。
     * 1.5 秒是硬性期限（不是「空闲多久」：对端一直滴数据也得放弃），且随代理收尾一起中止。
     */
    private async handshake(addr: string, token: string): Promise<"ok" | "unanswered" | ProtocolMismatchError> {
        const abort = new AbortController();
        this.handshakeAbort = abort;
        try {
            const status = await new DaemonClient({ addr, token }).status(1500, { absoluteTimeout: true, signal: abort.signal });
            return status.protocolVersion === PROTOCOL_VERSION ? "ok" : new ProtocolMismatchError(status.protocolVersion, status);
        } catch {
            return "unanswered";
        } finally {
            if (this.handshakeAbort === abort) this.handshakeAbort = null;
        }
    }

    /** 排队中还没发出的请求逐个报错——没发出过，不假装执行过；通知没有应答，直接丢弃 */
    private failQueued(reason: string, outcome: "not_sent"): void {
        for (const item of this.pendingQueue.splice(0)) {
            if (item.id === undefined) continue;
            this.writeStdout({
                jsonrpc: "2.0",
                id: item.id,
                error: { code: -32000, message: reason, data: { method: item.method ?? "unknown", outcome } },
            });
        }
    }

    private waitReconnect(): Promise<void> {
        if (this.closed) return Promise.resolve();
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(this.maxReconnectDelayMs, Math.max(50, delay * 2));
        return new Promise<void>((resolve) => {
            this.wakeSleep = resolve;
            this.sleepTimer = setTimeout(() => {
                this.sleepTimer = null;
                this.wakeSleep = null;
                resolve();
            }, delay);
            this.sleepTimer.unref?.();
        });
    }

    private runSseSession(addr: string, token: string): Promise<void> {
        if (this.closed) return Promise.resolve(); // 代理已收尾：不再发出任何连接
        const baseUrl = parseAddrToUrl(addr);
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let watchdog: ReturnType<typeof setInterval> | null = null;
            let reqRef: http.ClientRequest | null = null;
            let resRef: http.IncomingMessage | null = null;

            const session: ActiveSseSession = {
                addr,
                token,
                baseUrl,
                activeNotifPosts: 0,
                abort: (err) => {
                    finish(err ?? new Error("SSE 连接已关闭"));
                    if (resRef && !resRef.destroyed) {
                        try { resRef.destroy(); } catch { /* ignore */ }
                    }
                    if (reqRef && !reqRef.destroyed) {
                        try { reqRef.destroy(); } catch { /* ignore */ }
                    }
                },
            };

            const finish = (err?: Error) => {
                if (settled) return;
                settled = true;
                if (watchdog) { clearInterval(watchdog); watchdog = null; }
                if (this.activeSession === session) this.activeSession = null;
                if (err) reject(err);
                else resolve();
            };

            // 会话在发出握手请求时就登记，不等响应头：握手期间 stdin 关闭（close()）也要能撤下
            // 这条在途请求。此前要等响应头到达才登记，而 close() 只中止已登记的会话——握手
            // 响应迟到后会话在一个已关闭的代理上「激活」，连接再没人收，Node 进程陪着它永不
            // 退出（`filaxis-mcp < /dev/null`、探测式调用、宿主启动失败都会这样）。
            this.activeSession = session;

            const req = http.request({
                protocol: baseUrl.protocol,
                hostname: urlRequestHost(baseUrl),
                port: urlRequestPort(baseUrl),
                path: "/mcp/sse",
                method: "GET",
                headers: {
                    Accept: "text/event-stream",
                    "Cache-Control": "no-cache",
                    Authorization: `Bearer ${token}`,
                    // 调用方基准目录：代理进程跑在客户端那一侧、就在客户端的工作目录里。Daemon 侧的
                    // 工具面据此给相对路径与命令工作目录定基准——与进程内形态同参同果（REQ-0004 §5.5）
                    [CALLER_CWD_HEADER]: encodeCallerCwd(process.cwd()),
                },
                agent: false,
            }, (res) => {
                resRef = res;
                if (this.closed) {
                    // 握手响应迟到：代理已收尾，这条连接不留
                    res.destroy();
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    finish(new Error(`SSE 握手失败: HTTP ${res.statusCode ?? 0}`));
                    return;
                }

                let lastSeenAt = Date.now();
                const checkInterval = Math.max(15, Math.min(1000, Math.floor(this.watchdogIdleMs / 3)));
                watchdog = setInterval(() => {
                    if (Date.now() - lastSeenAt > this.watchdogIdleMs) {
                        const idleErr = new Error(`SSE 数据饥饿超时 (${this.watchdogIdleMs}ms)`);
                        session.abort(idleErr);
                    }
                }, checkInterval);
                watchdog.unref?.();

                const dec = new StringDecoder("utf-8");
                let buf = "";
                let evName = "";
                const dataLines: string[] = [];

                const flushEvent = () => {
                    if (settled) return;
                    if (!dataLines.length) {
                        evName = "";
                        return;
                    }
                    const event = evName;
                    const payload = dataLines.join("\n");
                    evName = "";
                    dataLines.length = 0;

                    if (event === "endpoint") {
                        session.postPath = payload.trim();
                        this.reconnectDelayMs = this.initialReconnectDelayMs;
                        this.pumpQueue();
                        return;
                    }
                    if (event === "message" || event === "") {
                        try {
                            const msg = JSON.parse(payload) as { id?: unknown };
                            if (msg && (typeof msg.id === "number" || typeof msg.id === "string")) {
                                this.inFlight.delete(idKey(msg.id));
                            }
                        } catch { /* 原样透传 */ }
                        this.writeStdout(payload);
                        this.pumpQueue();
                    }
                };

                const processLines = (final: boolean) => {
                    for (;;) {
                        const nl = buf.indexOf("\n");
                        if (nl === -1) break;
                        const line = buf.slice(0, nl).replace(/\r$/, "");
                        buf = buf.slice(nl + 1);
                        if (line === "") {
                            flushEvent();
                        } else if (line.startsWith(":")) {
                            // SSE comment/keepalive
                        } else if (line.startsWith("event:")) {
                            evName = line.slice("event:".length).trim();
                        } else if (line.startsWith("data:")) {
                            let val = line.slice("data:".length);
                            if (val.startsWith(" ")) val = val.slice(1);
                            dataLines.push(val);
                        }
                    }
                    if (final && buf.length > 0) {
                        const line = buf.replace(/\r$/, "");
                        buf = "";
                        if (line.startsWith("data:")) {
                            let val = line.slice("data:".length);
                            if (val.startsWith(" ")) val = val.slice(1);
                            dataLines.push(val);
                        }
                        flushEvent();
                    }
                };

                res.on("data", (chunk: Buffer) => {
                    lastSeenAt = Date.now();
                    buf += dec.write(chunk);
                    processLines(false);
                });
                res.on("end", () => {
                    buf += dec.end();
                    processLines(true);
                    finish(new Error("SSE 流意外结束"));
                });
                res.on("close", () => {
                    finish(new Error("SSE 连接已关闭"));
                });
                res.on("error", (err) => {
                    finish(err instanceof Error ? err : new Error(String(err)));
                });
            });

            reqRef = req;
            req.on("error", (err) => {
                finish(err instanceof Error ? err : new Error(String(err)));
            });
            req.end();
        });
    }
}
