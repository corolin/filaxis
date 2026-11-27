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
                await new Promise<void>((resolve) => {
                    srv.close(() => resolve());
                    (srv as { closeAllConnections?: () => void }).closeAllConnections?.();
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
            let payload: { protocol?: unknown; op?: unknown; params?: unknown };
            try {
                payload = await readJsonBody(req);
            } catch (err) {
                this.sendJsonBodyError(res, err);
                return;
            }
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
                const result = await this.dispatchOp(op, params);
                this.sendJson(res, 200, { ok: true, protocol: PROTOCOL_VERSION, result });
            } catch (err) {
                this.sendJson(res, 200, serializeRpcError(err));
            }
            return;
        }

        this.sendJson(res, 404, { ok: false, error: `Not Found: ${req.method ?? "UNKNOWN"} ${reqPath}` });
    }

    /**
     * 薄转发：取操作 → 调用 → 回结果。这里不认识任何具体操作——参数校验、目标解析、
     * 路径解析与结果整形都在中层（src/middle/）或界面层。
     */
    private dispatchOp(op: string, params: Record<string, unknown> | unknown[]): Promise<unknown> {
        if (!isRemoteOp(op)) {
            return Promise.reject(new Error(`未知 Daemon 操作: ${op}（可用：${REMOTE_OP_NAMES.join("、")}）`));
        }
        const fn = (this.middle.ops as unknown as Record<string, (p: Record<string, unknown> | unknown[]) => Promise<unknown>>)[op]!;
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
            void this.mcpHandler.handleMessage(body).then((resp) => {
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
    if (total > MAX_RPC_BODY_BYTES) {
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

async function readJsonBody(req: http.IncomingMessage): Promise<{ protocol?: unknown; op?: unknown; params?: unknown }> {
    const parsed = await readRawJsonBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new HttpStatusError(400, "RPC 请求体必须是 JSON 对象");
    }
    return parsed as { protocol?: unknown; op?: unknown; params?: unknown };
}
