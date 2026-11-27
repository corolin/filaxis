/**
 * daemon-server.ts — Filaxis 常驻守护进程：中层的宿主进程（REQ-0004 §6）
 *
 * 设计要点（REQ-0005 / REQ-0004）：
 * - 零第三方依赖：仅基于 node:http / node:crypto 等标准库；
 * - 仅监听本地回环（缺省 127.0.0.1），除 GET /health 外全端点强制 Bearer Token 常量时间鉴权（401）；
 * - 进程内只有一个中层（createMiddle）；/rpc 与 MCP 两个界面端点都调用同一个它，
 *   层、连接、转发、观察窗、会话天然共享；
 * - /rpc 是薄转发：取操作 → 调用 → 回结果，不含任何操作逻辑（校验、目标解析、
 *   路径解析、结果整形都在中层或界面层）；
 * - 信封带线协议版本，与自身不一致即拒绝、不执行（REQ-0004 §6.2）。
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { RuntimeStack } from "../../middle/runtime-stack.js";
import type { StreamWindowRegistry } from "../../core/stream/stream-window.js";
import { createAgentToolkit, type AgentToolkit } from "../mcp/agent-toolkit.js";
import { McpProtocolHandler } from "../mcp/mcp-server.js";
import { CALLER_CWD_HEADER, decodeCallerCwd } from "../mcp/call-context.js";
import { noopLogger, type FilaxisLogger } from "../../shared/logger.js";
import { loadLayerStore } from "../../middle/layer-store.js";
import { createMiddle, type LocalMiddle } from "../../middle/middle.js";
import { PROTOCOL_VERSION, REMOTE_OP_NAMES } from "../../middle/protocol.js";
import type { StreamSummary } from "../../middle/types.js";
import {
    acquireDaemonLock,
    assertLoopbackHost,
    cleanupDaemonFiles,
    daemonPaths,
    defaultDaemonDir,
    generateDaemonToken,
    verifyBearerToken,
    writePrivateFileAtomic,
} from "./daemon-files.js";

export interface DaemonLayerSummary {
    name: string;
    driver: string;
    target?: string;
    active: boolean;
}

export interface DaemonStatusInfo {
    pid: number;
    startedAt: number;
    uptimeMs: number;
    version: string;
    /** 线协议版本（REQ-0004 §6.2）：客户端连上先核对这个，不一致即拒绝 */
    protocolVersion: number;
    addr: string;
    layers: DaemonLayerSummary[];
    forwards: unknown[];
    streams: StreamSummary[];
}

export interface DaemonServerOptions {
    daemonDir?: string;
    host?: string;
    port?: number;
    version?: string;
    logger?: FilaxisLogger;
    stack?: RuntimeStack;
    windowRegistry?: StreamWindowRegistry;
    /** 已建好的中层；省略则按 stack / windowRegistry 代建（并注入已存层表读取） */
    middle?: LocalMiddle;
    toolkit?: AgentToolkit;
    sseKeepaliveMs?: number;
    writeFiles?: boolean;
}

const MAX_RPC_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_SSE_KEEPALIVE_MS = 15_000;

interface McpSseClient {
    id: string;
    res: http.ServerResponse;
    sendEvent: (event: string, data: string) => void;
    close: () => void;
    /** 这条会话的客户端工作目录（代理在 SSE 握手时带来）：本会话的工具调用里，落在没有自己工作
     * 目录的本机层上的相对路径与命令目录以它为基准。没带（旧代理）为 undefined——照旧以本进程目录为基准 */
    callerCwd?: string;
}

class HttpStatusError extends Error {
    constructor(readonly statusCode: number, message: string) {
        super(message);
    }
}

export class DaemonServer {
    /** 本进程唯一的中层——/rpc 与 MCP 两个界面都调用它 */
    readonly middle: LocalMiddle;
    readonly stack: RuntimeStack;
    readonly windowRegistry: StreamWindowRegistry;
    readonly toolkit: AgentToolkit;
    readonly token: string;
    readonly daemonDir: string;
    readonly version: string;

    private readonly host: string;
    private readonly port: number;
    private readonly log: FilaxisLogger;
    private readonly writeFiles: boolean;
    private readonly sseKeepaliveMs: number;
    private readonly mcpHandler: McpProtocolHandler;
    private readonly mcpSseClients = new Map<string, McpSseClient>();
    private readonly startedAt = Date.now();

    private server?: http.Server;
    /** 当前连着的客户端连接（停机时逐个销毁） */
    private readonly sockets = new Set<http.IncomingMessage["socket"]>();
    private listenAddr?: string;
    private starting?: Promise<string>;
    private stopping?: Promise<void>;
    private stopped = false;
    private stopWaiters: Array<() => void> = [];

    constructor(opts: DaemonServerOptions = {}) {
        this.daemonDir = opts.daemonDir ?? defaultDaemonDir();
        this.host = assertLoopbackHost(opts.host ?? "127.0.0.1");
        this.port = opts.port ?? 0;
        this.version = opts.version ?? "0.0.0";
        this.log = opts.logger ?? noopLogger;
        this.middle = opts.middle ?? createMiddle({
            stack: opts.stack,
            windowRegistry: opts.windowRegistry,
            // Daemon 是这台机器上的常驻宿主：已存层表在这里注入（界面层不必再随请求下发）
            savedLayers: loadLayerStore,
            logger: this.log,
            version: this.version,
        });
        this.stack = this.middle.stack;
        this.windowRegistry = this.middle.windowRegistry();
        this.toolkit = opts.toolkit ?? createAgentToolkit(this.stack, { middle: this.middle });
        this.mcpHandler = new McpProtocolHandler({ toolkit: this.toolkit, serverVersion: this.version });
        this.sseKeepaliveMs = opts.sseKeepaliveMs ?? DEFAULT_SSE_KEEPALIVE_MS;
        this.writeFiles = opts.writeFiles !== false;
        this.token = generateDaemonToken();
    }

    get addr(): string {
        if (!this.listenAddr) throw new Error("DaemonServer 尚未启动");
        return this.listenAddr;
    }

    async start(): Promise<string> {
        if (this.stopping) throw new Error("DaemonServer 已停止或正在停止，请创建新实例");
        if (this.listenAddr) return this.listenAddr;
        this.starting ??= this.startListening().finally(() => { this.starting = undefined; });
        return this.starting;
    }

    private async startListening(): Promise<string> {
        if (this.writeFiles) {
            acquireDaemonLock(this.daemonDir, this.version);
        }

        const srv = http.createServer((req, res) => {
            void this.handleHttp(req, res);
        });
        this.server = srv;
        // 记着自己身上的连接：停机时直接销毁。closeAllConnections() 在 bun 1.3（Linux 实测）不终止
        // 还有请求在处理中的连接，server.close 的回调要等那条请求结束才来——有命令在途时 stop() 挂住
        srv.on("connection", (socket) => {
            this.sockets.add(socket);
            socket.once("close", () => { this.sockets.delete(socket); });
        });

        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (err: Error) => {
                    srv.removeListener("listening", onListening);
                    reject(err);
                };
                const onListening = () => {
                    srv.removeListener("error", onError);
                    resolve();
                };
                srv.once("error", onError);
                srv.once("listening", onListening);
                srv.listen(this.port, this.host);
            });

            const address = srv.address();
            if (!address || typeof address === "string") {
                throw new Error("无法获取 Daemon HTTP 监听端口");
            }
            const hostPart = address.address.includes(":") ? `[${address.address}]` : address.address;
            this.listenAddr = `http://${hostPart}:${address.port}`;

            if (this.writeFiles) {
                const paths = daemonPaths(this.daemonDir);
                writePrivateFileAtomic(paths.tokenFile, this.token);
                writePrivateFileAtomic(paths.addrFile, this.listenAddr);
            }
            return this.listenAddr;
        } catch (err) {
            try { srv.close(); } catch { /* ignore */ }
            this.server = undefined;
            this.listenAddr = undefined;
            if (this.writeFiles) {
                cleanupDaemonFiles(this.daemonDir, process.pid);
            }
            throw err;
        }
    }

    waitForStop(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        return new Promise<void>((resolve) => {
            this.stopWaiters.push(resolve);
        });
    }

    status(): DaemonStatusInfo {
        const activeName = this.stack.activeLayer?.name;
        const layers: DaemonLayerSummary[] = [...this.stack.layers.values()].map((h) => ({
            name: h.name,
            driver: h.descriptor.driver,
            ...(h.descriptor.target !== undefined ? { target: h.descriptor.target } : {}),
            active: h.name === activeName,
        }));
        return {
            pid: process.pid,
            startedAt: this.startedAt,
            uptimeMs: Math.max(0, Date.now() - this.startedAt),
            version: this.version,
            protocolVersion: PROTOCOL_VERSION,
            addr: this.listenAddr ?? "",
            layers,
            forwards: this.stack.listForwards(),
            streams: this.middle.listStreamsSync(),
        };
    }

    async stop(): Promise<void> {
        if (this.stopping) return this.stopping;
        this.stopping = (async () => {
            await this.starting?.catch(() => undefined);
            for (const client of [...this.mcpSseClients.values()]) {
                client.close();
            }
            this.mcpSseClients.clear();
            const srv = this.server;
            this.server = undefined;
            if (srv) {
                for (const socket of [...this.sockets]) {
                    try { socket.destroy(); } catch { /* 已关闭 */ }
                }
                this.sockets.clear();
                await new Promise<void>((resolve) => {
                    let settled = false;
                    const done = (): void => {
                        if (settled) return;
                        settled = true;
                        resolve();
                    };
                    srv.close(() => done());
                    (srv as { closeAllConnections?: () => void }).closeAllConnections?.();
                    // 连接已全部销毁，close 的回调本应立刻就来；万一运行时不给（bun 实测），不等它
                    setTimeout(done, 500).unref?.();
                });
            }
            const activeWindows = this.windowRegistry.list().map((w) => w.name);
            await Promise.all(activeWindows.map((id) => this.windowRegistry.stopConfirmed(id).catch(() => undefined)));
            this.toolkit.dispose?.();
            this.windowRegistry.dispose();
            await this.middle.shutdown();
            this.listenAddr = undefined;
            if (this.writeFiles) {
                cleanupDaemonFiles(this.daemonDir, process.pid);
            }
            this.stopped = true;
            for (const resolve of this.stopWaiters) resolve();
            this.stopWaiters = [];
        })();
        return this.stopping;
    }

    private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const reqPath = parsedUrl.pathname;
        if (req.method === "GET" && reqPath === "/health") {
            this.sendJson(res, 200, { ok: true });
            return;
        }

        if (!verifyBearerToken(req.headers.authorization, this.token)) {
            this.sendJson(res, 401, { ok: false, error: "Unauthorized" });
            return;
        }

        if (req.method === "GET" && reqPath === "/status") {
            this.sendJson(res, 200, { ok: true, result: this.status() });
            return;
        }

        if (req.method === "GET" && reqPath === "/mcp/sse") {
            this.handleMcpSse(req, res);
            return;
        }

        if (req.method === "POST" && reqPath === "/mcp/message") {
            await this.handleMcpMessage(req, res, parsedUrl.searchParams.get("sessionId"));
            return;
        }

        if (req.method === "POST" && reqPath === "/shutdown") {
            this.sendJson(res, 200, { ok: true, result: { ok: true } });
            setTimeout(() => { void this.stop(); }, 20).unref?.();
            return;
        }

        if (req.method === "POST" && reqPath === "/rpc") {
            let held: { payload: RpcEnvelope; release: () => void };
            try {
                held = await readJsonBodyHeld(req);
            } catch (err) {
                this.sendJsonBodyError(res, err);
                return;
            }
            try {
                await this.handleRpc(held.payload, req, res);
            } finally {
                // 应答已发（或对方已走）：放开请求流，这条连接才能被复用
                held.release();
            }
            return;
        }

        this.sendJson(res, 404, { ok: false, error: `Not Found: ${req.method ?? "UNKNOWN"} ${reqPath}` });
    }

    /**
     * 一帧已读出的 RPC：协议握手 → 派发 → 回结果。调用方在应答之前断开，就中止它在途的操作。
     */
    private async handleRpc(payload: RpcEnvelope, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // 线协议握手（REQ-0004 §6.2）：信封不带或带着别的协议版本（0.2.x 的客户端不带这个
        // 字段）一律拒绝、不执行——旧客户端的请求若交给新代码或反过来，行为都不可预期
        if (payload.protocol !== PROTOCOL_VERSION) {
            const theirs = payload.protocol === undefined ? "（缺失）" : String(payload.protocol);
            this.sendJson(res, 200, {
                ok: false,
                error: `Daemon 线协议版本不一致，已拒绝执行：请求 protocol=${theirs}，Daemon protocol=${PROTOCOL_VERSION}（pid=${process.pid}）。请把客户端与 Daemon 升级到同一版本后重试`,
                code: "E_PROTOCOL_MISMATCH",
            });
            return;
        }
        const op = typeof payload.op === "string" ? payload.op : "";
        // 参数是对象或数组都原样交给操作（connectSshBatch 的参数就是一个数组——此前数组被换成
        // 空对象，经 Daemon 调它必报「not iterable」）；缺失或标量按空参数
        const raw = payload.params;
        const params: Record<string, unknown> | unknown[] = Array.isArray(raw)
            ? raw
            : (raw && typeof raw === "object" ? raw as Record<string, unknown> : {});
        if (!op) {
            this.sendJson(res, 400, { ok: false, error: "RPC 请求缺少 op 字段" });
            return;
        }
        try {
            // 在应答前检测到调用方断开，就向支持中止的在途操作传递信号。目标终态由对应驱动判断。
            // 应答发出后摘掉监听，连接自然关闭时不再触发。
            const abort = new AbortController();
            const socket = req.socket;
            const onGone = (): void => abort.abort(new Error("调用方已断开"));
            socket.on("close", onGone);
            if (socket.destroyed) onGone();
            try {
                const result = await this.dispatchOp(op, params, abort.signal);
                this.sendJson(res, 200, { ok: true, protocol: PROTOCOL_VERSION, result });
            } finally {
                socket.removeListener("close", onGone);
            }
        } catch (err) {
            this.sendJson(res, 200, serializeRpcError(err));
        }
        return;
    }

    /**
     * 薄转发负责选择操作和注入宿主的中止信号。命令、目标层和执行结果的语义由中层与驱动处理。
     */
    private dispatchOp(op: string, params: Record<string, unknown> | unknown[], signal: AbortSignal): Promise<unknown> {
        if (!isRemoteOp(op)) {
            return Promise.reject(new Error(`未知 Daemon 操作: ${op}（可用：${REMOTE_OP_NAMES.join("、")}）`));
        }
        const fn = (this.middle.ops as unknown as Record<string, (p: Record<string, unknown> | unknown[]) => Promise<unknown>>)[op]!;
        if (!Array.isArray(params) && (op === "runCommand" || op === "runBatch" || op === "observe")) {
            return fn.call(this.middle.ops, { ...params, signal });
        }
        return fn.call(this.middle.ops, params);
    }

    private handleMcpSse(req: http.IncomingMessage, res: http.ServerResponse): void {
        const sessionId = crypto.randomUUID();
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
        });
        res.flushHeaders?.();

        let closed = false;
        const sendEvent = (event: string, data: string) => {
            if (closed || res.writableEnded || res.destroyed) return;
            const lines = data.split(/\r?\n/).map((line) => `data: ${line}`).join("\n");
            res.write(`event: ${event}\n${lines}\n\n`);
        };

        const keepalive = this.sseKeepaliveMs > 0
            ? setInterval(() => {
                if (!closed && !res.writableEnded && !res.destroyed) {
                    res.write(": keepalive\n\n");
                }
            }, this.sseKeepaliveMs)
            : null;
        keepalive?.unref?.();

        const cleanup = () => {
            if (closed) return;
            closed = true;
            if (keepalive) clearInterval(keepalive);
            this.mcpSseClients.delete(sessionId);
        };

        const client: McpSseClient = {
            id: sessionId,
            res,
            sendEvent,
            close: () => {
                cleanup();
                if (!res.writableEnded) {
                    try { res.end(); } catch { /* ignore */ }
                }
                if (!res.destroyed) {
                    try { res.destroy(); } catch { /* ignore */ }
                }
            },
            callerCwd: decodeCallerCwd(req.headers[CALLER_CWD_HEADER]),
        };

        this.mcpSseClients.set(sessionId, client);
        req.on("close", cleanup);
        res.on("close", cleanup);
        res.on("error", cleanup);

        sendEvent("endpoint", `/mcp/message?sessionId=${encodeURIComponent(sessionId)}`);
    }

    private async handleMcpMessage(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        sessionId: string | null,
    ): Promise<void> {
        let body: unknown;
        try {
            body = await readRawJsonBody(req);
        } catch (err) {
            this.sendJsonBodyError(res, err);
            return;
        }

        if (sessionId !== null) {
            const client = this.mcpSseClients.get(sessionId);
            if (!client) {
                this.sendJson(res, 404, { ok: false, error: `SSE session not found: ${sessionId}` });
                return;
            }
            this.sendJson(res, 202, { ok: true });
            // 这条会话的调用方基准（客户端工作目录）随请求进入工具调用；会话没带就是本进程目录之外无从得知
            const ctx = client.callerCwd ? { cwd: client.callerCwd } : undefined;
            void this.mcpHandler.handleMessage(body, ctx).then((resp) => {
                if (resp) {
                    client.sendEvent("message", JSON.stringify(resp));
                }
            });
            return;
        }

        const resp = await this.mcpHandler.handleMessage(body);
        if (resp) {
            this.sendJson(res, 200, resp);
        } else {
            this.sendJson(res, 202, { ok: true });
        }
    }

    private sendJsonBodyError(res: http.ServerResponse, err: unknown): void {
        if (err instanceof HttpStatusError) {
            this.sendJson(res, err.statusCode, { ok: false, error: err.message });
            return;
        }
        this.sendJson(res, 400, { ok: false, error: "读取 JSON 请求体失败" });
    }

    private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
        if (res.writableEnded) return;
        const json = JSON.stringify(body);
        res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(json, "utf-8"),
        });
        res.end(json);
    }
}

function isRemoteOp(name: string): name is (typeof REMOTE_OP_NAMES)[number] {
    return (REMOTE_OP_NAMES as readonly string[]).includes(name);
}

function serializeRpcError(err: unknown): Record<string, unknown> {
    const obj = (err !== null && typeof err === "object" ? err : {}) as {
        outcome?: unknown;
        reason?: unknown;
        channel?: unknown;
        sessionId?: unknown;
        logBase?: unknown;
        exitCode?: unknown;
        terminalId?: unknown;
        forwardId?: unknown;
        code?: unknown;
        partialOutput?: unknown;
    };
    return {
        ok: false,
        error: err instanceof Error ? err.message : "Daemon RPC 执行失败",
        ...(err instanceof Error ? { name: err.name } : {}),
        ...(typeof obj.code === "string" || typeof obj.code === "number" ? { code: obj.code } : {}),
        ...(typeof obj.partialOutput === "string" ? { partialOutput: obj.partialOutput } : {}),
        ...(obj.outcome !== undefined ? { outcome: obj.outcome } : {}),
        ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
        ...(typeof obj.channel === "string" ? { channel: obj.channel } : {}),
        ...(obj.sessionId !== undefined ? { sessionId: obj.sessionId } : {}),
        ...(obj.logBase !== undefined ? { logBase: obj.logBase } : {}),
        ...(obj.exitCode !== undefined ? { exitCode: obj.exitCode } : {}),
        ...(obj.terminalId !== undefined ? { terminalId: obj.terminalId } : {}),
        ...(typeof obj.forwardId === "string" ? { forwardId: obj.forwardId } : {}),
    };
}

async function readRawJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.byteLength;
        if (total > MAX_RPC_BODY_BYTES) {
            // Finish reading without retaining the body so the client receives HTTP 413.
            chunks.length = 0;
            continue;
        }
        chunks.push(buf);
    }
    return parseJsonBody(chunks, total > MAX_RPC_BODY_BYTES);
}

function parseJsonBody(chunks: Buffer[], tooBig: boolean): unknown {
    if (tooBig) {
        throw new HttpStatusError(413, `请求体超过限制 (${MAX_RPC_BODY_BYTES} 字节)`);
    }
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (!raw) throw new HttpStatusError(400, "空 JSON 请求体");
    try {
        return JSON.parse(raw);
    } catch {
        throw new HttpStatusError(400, "JSON 解析失败");
    }
}

/**
 * 读请求体，但不让请求流完结：按 Content-Length 收够字节就暂停，`end` 留到 release() 再发。
 *
 * 请求流一完结，bun 1.3.12 就不再把连接的关闭送到这个 socket 上——调用方在应答前断开，
 * close 事件不来（读完再挂监听、轮询状态位、往回写都察觉不到）。暂停着才收得到。
 * Node 与 Windows 上的 bun 1.4.4 实测读完也收得到，不必分运行时：三处这个写法都收得到。
 * 没有 Content-Length（分块编码、无体）退回读完。
 */
async function readRawJsonBodyHeld(req: http.IncomingMessage): Promise<{ value: unknown; release: () => void }> {
    const declared = Number(req.headers["content-length"]);
    if (!Number.isInteger(declared) || declared < 0) {
        return { value: await readRawJsonBody(req), release: () => undefined };
    }
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let tooBig = false;
        let settled = false;
        const cleanup = (): void => {
            req.removeListener("data", onData);
            req.removeListener("end", onEnd);
            req.removeListener("error", onError);
        };
        const finish = (settle: () => void): void => {
            if (settled) return;
            settled = true;
            cleanup();
            settle();
        };
        const settle = (): void => {
            try {
                resolve({ value: parseJsonBody(chunks, tooBig), release });
            } catch (err) {
                reject(err);
            }
        };
        const onError = (err: Error): void => finish(() => reject(err));
        // 比声明的短（或超出限制后不再暂停）：按实收的字节结算
        const onEnd = (): void => finish(settle);
        const onData = (chunk: Buffer): void => {
            total += chunk.byteLength;
            if (tooBig) return; // keep draining so the client receives HTTP 413
            if (total > MAX_RPC_BODY_BYTES) {
                tooBig = true;
                chunks.length = 0;
                return;
            }
            chunks.push(chunk);
            if (total >= declared) {
                req.pause();
                finish(settle);
            }
        };
        const release = (): void => {
            cleanup();
            req.resume();
        };
        req.on("data", onData);
        req.on("end", onEnd);
        req.on("error", onError);
    });
}

/** RPC 信封：一个 JSON 对象。请求流保持未完结（见 readRawJsonBodyHeld），信封不合格时先放开再报 */
async function readJsonBodyHeld(req: http.IncomingMessage): Promise<{ payload: RpcEnvelope; release: () => void }> {
    const { value, release } = await readRawJsonBodyHeld(req);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        release();
        throw new HttpStatusError(400, "RPC 请求体必须是 JSON 对象");
    }
    return { payload: value as RpcEnvelope, release };
}

type RpcEnvelope = { protocol?: unknown; op?: unknown; params?: unknown };
