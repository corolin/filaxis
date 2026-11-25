/**
 * daemon-server.ts — Filaxis 显式常驻守护进程 HTTP 控制面与共享工作现场
 *
 * 设计要点（REQ-0005）：
 * - 零第三方依赖：仅基于 node:http / node:crypto / node:path 等标准库；
 * - 仅监听本地回环（缺省 127.0.0.1），除 GET /health 外全端点强制 Bearer Token 常量时间鉴权（401）；
 * - 惰性层解析：SSH 非交互 exec/stream/forward 不强迫预建 PTY link（保持 OPNsense 与多跳诚实拒绝语义），
 *   仅在 --pty 调用时按需初始化 PTY link；
 * - 内部持有统一 RuntimeStack 与 StreamWindowRegistry，供 CLI 与后续 MCP Proxy 共享现场。
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as path from "node:path";
import { RuntimeStack, type LayerHandle } from "./runtime-stack.js";
import type { RuntimeDescriptor, RuntimeDriver } from "./driver.js";
import { LocalRuntimeDriver } from "./local-driver.js";
import { SshPtyDriver } from "./ssh-pty-driver.js";
import { StreamWindowRegistry, type StreamFrame } from "./stream-window.js";
import { editFile } from "./file-edit.js";
import { transferLayerFile, type FileTransferTransport } from "./layer-file-transfer.js";
import { discoverLayer } from "./layer-discovery.js";
import { runBatch, type BatchPlan } from "./batch.js";
import type { OpenForwardSpec, ForwardInfo } from "./ssh-forward.js";
import { createAgentToolkit, type AgentToolkit } from "./agent-toolkit.js";
import { McpProtocolHandler } from "./mcp-server.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";
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

export interface CliTargetSpec {
    layer?: string;
    descriptor?: RuntimeDescriptor;
    cwd?: string;
}

export interface DaemonLayerSummary {
    name: string;
    driver: string;
    target?: string;
    active: boolean;
}

export interface DaemonStreamSummary {
    window_id: string;
    name?: string;
    layer: string;
    command: string;
    oldest_seq: number;
    newest_seq: number;
    stale: boolean;
    closed: boolean;
}

export interface DaemonStatusInfo {
    pid: number;
    startedAt: number;
    uptimeMs: number;
    version: string;
    addr: string;
    layers: DaemonLayerSummary[];
    forwards: ForwardInfo[];
    streams: DaemonStreamSummary[];
}

export interface DaemonServerOptions {
    daemonDir?: string;
    host?: string;
    port?: number;
    version?: string;
    logger?: FilaxisLogger;
    stack?: RuntimeStack;
    windowRegistry?: StreamWindowRegistry;
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
    private readonly ptyInitialized = new WeakSet<RuntimeDriver>();
    private readonly ptyInitInflight = new WeakMap<RuntimeDriver, Promise<void>>();
    private readonly resolvingLayers = new Map<string, { key: string; promise: Promise<LayerHandle> }>();
    private readonly ephemeralLayers = new Map<string, string>();
    private readonly streamMeta = new Map<string, { displayName?: string; layer: string; implicitLocal: boolean }>();
    private implicitLocal?: LayerHandle;

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
        this.stack = opts.stack ?? new RuntimeStack({ logger: this.log });
        this.windowRegistry = opts.windowRegistry ?? new StreamWindowRegistry({ logger: this.log });
        this.toolkit = opts.toolkit ?? createAgentToolkit(this.stack, { windowRegistry: this.windowRegistry });
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

    private pruneStreamMeta(): void {
        for (const id of [...this.streamMeta.keys()]) {
            if (!this.windowRegistry.get(id)) {
                this.streamMeta.delete(id);
            }
        }
    }

    waitForStop(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        return new Promise<void>((resolve) => {
            this.stopWaiters.push(resolve);
        });
    }

    status(): DaemonStatusInfo {
        this.pruneStreamMeta();
        const activeName = this.stack.activeLayer?.name;
        const layers: DaemonLayerSummary[] = [...this.stack.layers.values()].map((h) => ({
            name: h.name,
            driver: h.descriptor.driver,
            ...(h.descriptor.target !== undefined ? { target: h.descriptor.target } : {}),
            active: h.name === activeName,
        }));
        const streams: DaemonStreamSummary[] = [];
        for (const w of this.windowRegistry.list()) {
            const win = this.windowRegistry.get(w.name);
            const meta = this.streamMeta.get(w.name);
            streams.push({
                window_id: w.name,
                ...(meta?.displayName ? { name: meta.displayName } : {}),
                layer: meta?.layer ?? w.layer,
                command: w.command,
                oldest_seq: win?.oldestSeq ?? 0,
                newest_seq: win?.newestSeq ?? 0,
                stale: w.stale,
                closed: win?.closed ?? false,
            });
        }
        return {
            pid: process.pid,
            startedAt: this.startedAt,
            uptimeMs: Math.max(0, Date.now() - this.startedAt),
            version: this.version,
            addr: this.listenAddr ?? "",
            layers,
            forwards: this.stack.listForwards(),
            streams,
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
            this.streamMeta.clear();
            await this.stack.destroyDetachedForwardDrivers();
            for (const name of [...this.stack.layers.keys()]) {
                await this.stack.removeLayer(name, { destroy: true }).catch(() => undefined);
            }
            this.ephemeralLayers.clear();
            await this.implicitLocal?.driver.destroy().catch(() => undefined);
            this.implicitLocal = undefined;
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
            let payload: { method?: unknown; params?: unknown };
            try {
                payload = await readJsonBody(req);
            } catch (err) {
                const status = err instanceof HttpStatusError ? err.statusCode : 400;
                this.sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) });
                return;
            }
            const method = typeof payload.method === "string" ? payload.method : "";
            const params = (payload.params && typeof payload.params === "object" && !Array.isArray(payload.params))
                ? payload.params as Record<string, unknown>
                : {};
            if (!method) {
                this.sendJson(res, 400, { ok: false, error: "RPC 请求缺少 method 字段" });
                return;
            }
            try {
                const result = await this.dispatchRpc(method, params);
                this.sendJson(res, 200, { ok: true, result });
            } catch (err) {
                this.sendJson(res, 200, serializeRpcError(err));
            }
            return;
        }

        this.sendJson(res, 404, { ok: false, error: `Not Found: ${req.method ?? "UNKNOWN"} ${reqPath}` });
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
            const status = err instanceof HttpStatusError ? err.statusCode : 400;
            this.sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) });
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

    private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
        if (res.writableEnded) return;
        const json = JSON.stringify(body);
        res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(json, "utf-8"),
        });
        res.end(json);
    }

    private instantiateDriver(descriptor: RuntimeDescriptor): RuntimeDriver | null {
        if (descriptor.driver === "local") {
            const cfg = (descriptor.config ?? {}) as Record<string, unknown>;
            const drv = new LocalRuntimeDriver({
                ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
                ...(typeof cfg.shell === "string" ? { shell: cfg.shell } : {}),
                logger: this.log,
            });
            drv.descriptor = { ...descriptor };
            return drv;
        }
        if (descriptor.driver === "ssh") {
            return new SshPtyDriver(descriptor, { logger: this.log });
        }
        return null;
    }

    private hasActiveStreamsForLayer(layerName: string): boolean {
        this.pruneStreamMeta();
        for (const w of this.windowRegistry.list()) {
            const win = this.windowRegistry.get(w.name);
            if (!win || win.closed) continue;
            const meta = this.streamMeta.get(w.name);
            if (meta?.implicitLocal) continue;
            const ownerLayer = meta?.layer ?? w.layer;
            if (ownerLayer === layerName) return true;
        }
        return false;
    }

    private resolveClientLocalPath(filePath: string, clientCwd?: string): string {
        if (clientCwd && filePath && !filePath.includes("\0") && !path.isAbsolute(filePath)) {
            return path.resolve(clientCwd, filePath);
        }
        return filePath;
    }

    private resolveBatchPlanLocalPaths(plan: BatchPlan, clientCwd?: string): BatchPlan {
        if (!clientCwd || !plan || typeof plan !== "object" || Array.isArray(plan) || !Array.isArray(plan.steps)) {
            return plan;
        }
        return {
            ...plan,
            steps: plan.steps.map((step) => {
                if (step && typeof step === "object" && (step.kind === "put" || step.kind === "get")
                    && typeof step.localPath === "string") {
                    return { ...step, localPath: this.resolveClientLocalPath(step.localPath, clientCwd) };
                }
                return step;
            }),
        };
    }

    private async registerLazyLayer(name: string, descriptor: RuntimeDescriptor, opts: { activate?: boolean } = {}): Promise<LayerHandle> {
        const direct = this.instantiateDriver(descriptor);
        if (direct) {
            const res = await this.stack.addLayer(name, direct, { activate: opts.activate });
            return res.handle;
        }
        const res = await this.stack.addLayer(name, descriptor, { activate: opts.activate });
        return res.handle;
    }

    private async ensureLayerOnce(
        dedupKey: string,
        descriptorKey: string,
        create: () => Promise<LayerHandle>,
    ): Promise<LayerHandle> {
        const inflight = this.resolvingLayers.get(dedupKey);
        if (inflight) {
            if (inflight.key !== descriptorKey) {
                throw new Error(
                    `层 '${dedupKey.replace(/^named:/, "")}' 正在并发注册或更新为另一份配置，拒绝合并不同描述符的并发请求`,
                );
            }
            return inflight.promise;
        }
        const task = create().finally(() => {
            if (this.resolvingLayers.get(dedupKey)?.promise === task) {
                this.resolvingLayers.delete(dedupKey);
            }
        });
        this.resolvingLayers.set(dedupKey, { key: descriptorKey, promise: task });
        return task;
    }

    private getImplicitLocalHandle(): LayerHandle {
        if (!this.implicitLocal) {
            const drv = new LocalRuntimeDriver({ logger: this.log });
            this.implicitLocal = { name: "local", descriptor: drv.descriptor, driver: drv };
        }
        return this.implicitLocal;
    }

    private getEphemeralLayer(key: string): LayerHandle | undefined {
        const name = this.ephemeralLayers.get(key);
        const handle = name === undefined ? undefined : this.stack.layers.get(name);
        if (handle && RuntimeStack.driverKey(handle.descriptor) === key) return handle;
        this.ephemeralLayers.delete(key);
        return undefined;
    }

    private async resolveTarget(target?: CliTargetSpec, opts: { needPty?: boolean } = {}): Promise<LayerHandle> {
        let handle: LayerHandle;

        if (!target || (!target.layer && (!target.descriptor || (target.descriptor.driver === "local" && !target.descriptor.cwd && !target.descriptor.config)))) {
            handle = this.getImplicitLocalHandle();
        } else if (target.layer) {
            if (target.descriptor) {
                const layerName = target.layer;
                const descriptor = target.descriptor;
                const desiredKey = RuntimeStack.driverKey(descriptor);
                const fastExisting = this.stack.layers.has(layerName) ? this.stack.layer(layerName) : undefined;
                if (fastExisting && RuntimeStack.driverKey(fastExisting.descriptor) === desiredKey) {
                    handle = fastExisting;
                } else {
                    handle = await this.ensureLayerOnce(`named:${layerName}`, desiredKey, async () => {
                        if (this.stack.layers.has(layerName)) {
                            const existing = this.stack.layer(layerName);
                            if (RuntimeStack.driverKey(existing.descriptor) === desiredKey) {
                                return existing;
                            }
                            const hasActiveForwards = this.stack.hasLiveForwards(layerName);
                            const hasActiveStreams = this.hasActiveStreamsForLayer(layerName);
                            if (hasActiveForwards || hasActiveStreams) {
                                throw new Error(
                                    `层 '${layerName}' 已在 Daemon 注册且配置与新描述符不一致，当前仍有${hasActiveForwards ? "正在建立或未确认关闭的动态端口转发" : "活跃观察窗"}，拒绝静默覆盖——请先清理该层资源或移除旧层后重试`,
                                );
                            }
                            const wasActive = this.stack.activeLayer?.name === layerName;
                            await this.stack.removeLayer(layerName, { destroy: false });
                            return this.registerLazyLayer(layerName, descriptor, { activate: wasActive });
                        }
                        return this.registerLazyLayer(layerName, descriptor, { activate: false });
                    });
                }
            } else if (this.stack.layers.has(target.layer)) {
                handle = this.stack.layer(target.layer);
            } else {
                throw new Error(`层 '${target.layer}' 未在 Daemon 注册（可先 filaxis layer save ${target.layer} --host ...）`);
            }
        } else {
            const descriptor = target.descriptor!;
            const key = RuntimeStack.driverKey(descriptor);
            const existing = this.getEphemeralLayer(key);
            if (existing) {
                handle = existing;
            } else {
                handle = await this.ensureLayerOnce(`ephemeral:${key}`, key, async () => {
                    const again = this.getEphemeralLayer(key);
                    if (again) return again;
                    const shortHash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 6);
                    const base = (descriptor.target ?? descriptor.driver).replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 24) || "layer";
                    let candidate = `${base}#${shortHash}`;
                    if (this.stack.layers.has(candidate)) {
                        candidate = `${candidate}-${crypto.randomBytes(2).toString("hex")}`;
                    }
                    const created = await this.registerLazyLayer(candidate, descriptor, { activate: false });
                    this.ephemeralLayers.set(key, created.name);
                    return created;
                });
            }
        }

        if (opts.needPty && handle.driver instanceof SshPtyDriver && !this.ptyInitialized.has(handle.driver)) {
            const sshDrv = handle.driver;
            let initTask = this.ptyInitInflight.get(sshDrv);
            if (!initTask) {
                initTask = sshDrv.init().then(() => {
                    this.ptyInitialized.add(sshDrv);
                }).finally(() => {
                    if (this.ptyInitInflight.get(sshDrv) === initTask) {
                        this.ptyInitInflight.delete(sshDrv);
                    }
                });
                this.ptyInitInflight.set(sshDrv, initTask);
            }
            await initTask;
        }
        return handle;
    }

    private resolveLayerFilePath(drv: RuntimeDriver, filePath: string, clientCwd?: string): string {
        if (drv.descriptor.driver === "local" && clientCwd && !path.isAbsolute(filePath)) {
            return path.resolve(clientCwd, filePath);
        }
        return filePath;
    }

    private async dispatchRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
        switch (method) {
            case "status":
                return this.status();

            case "exec": {
                const target = params.target as CliTargetSpec | undefined;
                const command = String(params.command ?? "");
                const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 120_000;
                const pty = params.pty === true;
                const h = await this.resolveTarget(target, { needPty: pty });
                const isLocal = h.descriptor.driver === "local";
                const r = await h.driver.exec(command, {
                    timeoutMs,
                    channel: pty ? "pty" : undefined,
                    ...(isLocal && target?.cwd ? { cwd: target.cwd } : {}),
                });
                return {
                    stdout: r.stdout,
                    stderr: r.stderr,
                    exitCode: r.exitCode,
                    ...(r.effectiveUser !== undefined ? { effectiveUser: r.effectiveUser } : {}),
                };
            }

            case "cat": {
                const target = params.target as CliTargetSpec | undefined;
                const rawPath = String(params.path ?? "");
                if (!rawPath) throw new Error("cat 缺少 path 参数");
                const h = await this.resolveTarget(target);
                const resolved = this.resolveLayerFilePath(h.driver, rawPath, target?.cwd);
                return { content: await h.driver.fs.readFile(resolved) };
            }

            case "edit": {
                const target = params.target as CliTargetSpec | undefined;
                const rawPath = String(params.path ?? "");
                const old = params.old;
                const newStr = params.new;
                if (!rawPath || typeof old !== "string" || typeof newStr !== "string") {
                    throw new Error("edit 需要 path、old 与 new 字符串参数");
                }
                const h = await this.resolveTarget(target);
                const resolved = this.resolveLayerFilePath(h.driver, rawPath, target?.cwd);
                return editFile(h.driver, resolved, old, newStr, {
                    all: params.all === true,
                    writeMode: params.writeMode as "auto" | "inplace" | undefined,
                });
            }

            case "transfer": {
                const target = params.target as CliTargetSpec | undefined;
                const direction = params.direction === "get" ? "get" : params.direction === "put" ? "put" : undefined;
                if (!direction) throw new Error("transfer 需要 direction=put|get");
                const h = await this.resolveTarget(target);
                const clientCwd = typeof params.clientCwd === "string" && params.clientCwd ? params.clientCwd : target?.cwd;
                const remotePath = this.resolveLayerFilePath(h.driver, String(params.remotePath ?? ""), target?.cwd);
                return transferLayerFile(h.driver, direction, {
                    localPath: this.resolveClientLocalPath(String(params.localPath ?? ""), clientCwd),
                    remotePath,
                    transport: params.transport as FileTransferTransport | undefined,
                    timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
                    writeMode: params.writeMode as "auto" | "inplace" | undefined,
                });
            }

            case "observe": {
                const target = params.target as CliTargetSpec | undefined;
                const command = String(params.command ?? "");
                const streamArg = typeof params.stream === "string" ? params.stream : undefined;
                const duration = typeof params.duration === "number" ? params.duration : 8000;
                const h = await this.resolveTarget(target);
                const isLocal = h.descriptor.driver === "local";
                const session = await h.driver.execSession(command, {
                    name: "cli-observe",
                    ...(isLocal && target?.cwd ? { cwd: target.cwd } : {}),
                });
                await new Promise((r) => setTimeout(r, duration));
                const streams: Array<"stdout" | "stderr"> = streamArg === "stderr"
                    ? ["stderr"]
                    : streamArg === "stdout"
                        ? ["stdout"]
                        : ["stdout", "stderr"];
                const lines: Array<{ stream: string; text: string }> = [];
                try {
                    for (const st of streams) {
                        const log = await h.driver.readSessionLog(session.sessionId, { lines: 500, stream: st });
                        for (const text of (log ?? "").split("\n")) {
                            if (text !== "") lines.push({ stream: st, text });
                        }
                    }
                } catch (e) {
                    await h.driver.stopSession(session.sessionId).catch(() => undefined);
                    const err = new Error(
                        `观察输出读取失败（${(e as Error).message}）——已尝试停止。` +
                        `会话线索 session_id=${session.sessionId} log_base=${session.logBase}（任务可能仍在运行，核实后再重试）`,
                    ) as Error & { outcome: string; sessionId: string; logBase: string };
                    err.outcome = "unknown";
                    err.sessionId = session.sessionId;
                    err.logBase = session.logBase;
                    throw err;
                }
                const filtered = (streamArg && streamArg !== "both")
                    ? lines.filter((l) => l.stream === streamArg)
                    : lines;
                const stopR = await h.driver.stopSession(session.sessionId).catch(() => ({ status: "unknown" as const }));
                let verifyStatus: string | undefined;
                let verifyError: string | undefined;
                if (stopR.status === "unknown") {
                    verifyStatus = "unknown";
                    try {
                        verifyStatus = (await h.driver.verifySession(session.sessionId)).status;
                    } catch (e) {
                        verifyError = (e as Error).message;
                    }
                }
                return {
                    lines: filtered,
                    stopStatus: stopR.status,
                    ...(verifyStatus !== undefined ? { verifyStatus } : {}),
                    ...(verifyError !== undefined ? { verifyError } : {}),
                    sessionId: session.sessionId,
                    logBase: session.logBase,
                };
            }

            case "probe": {
                const target = params.target as CliTargetSpec | undefined;
                const h = await this.resolveTarget(target);
                const r = await discoverLayer(h.driver, { skipStage2: false });
                return { key: r.key, spec: r.spec, note: r.probeNote };
            }

            case "batch": {
                const target = params.target as CliTargetSpec | undefined;
                const plan = params.plan as BatchPlan;
                const savedLayers = (params.savedLayers ?? {}) as Record<string, RuntimeDescriptor>;
                const clientCwd = typeof params.clientCwd === "string" && params.clientCwd ? params.clientCwd : target?.cwd;
                const resolvedPlan = this.resolveBatchPlanLocalPaths(plan, clientCwd);
                let scopedLocal: LocalRuntimeDriver | undefined;
                try {
                    return await runBatch(async (layerName) => {
                        if (layerName === undefined) {
                            if ((!target || (!target.layer && (!target.descriptor || target.descriptor.driver === "local"))) && target?.cwd) {
                                scopedLocal ??= new LocalRuntimeDriver({ cwd: target.cwd, logger: this.log });
                                return scopedLocal;
                            }
                            return (await this.resolveTarget(target)).driver;
                        }
                        if (Object.hasOwn(savedLayers, layerName)) {
                            return (await this.resolveTarget({ layer: layerName, descriptor: savedLayers[layerName]! })).driver;
                        }
                        if (this.stack.layers.has(layerName)) {
                            return this.stack.layer(layerName).driver;
                        }
                        throw new Error(`层 '${layerName}' 未保存（filaxis layer list 查看；filaxis layer save ${layerName} --host ... 创建）`);
                    }, resolvedPlan);
                } finally {
                    await scopedLocal?.destroy().catch(() => undefined);
                }
            }

            case "forward.add": {
                const target = params.target as CliTargetSpec | undefined;
                const spec = params.spec as OpenForwardSpec;
                if (!spec || typeof spec !== "object") throw new Error("forward.add 需要 spec 参数");
                const h = await this.resolveTarget(target);
                if (typeof h.driver.openForward !== "function") {
                    throw new Error(`层 '${h.name}' (${h.descriptor.driver}) 不支持动态端口转发`);
                }
                if (this.stack.layers.get(h.name) !== h) {
                    throw new Error(`层 '${h.name}' 已变更，请重新指定目标层`);
                }
                return this.stack.openForward(spec, h.name);
            }

            case "forward.list": {
                const layer = typeof params.layer === "string" ? params.layer : undefined;
                return { forwards: this.stack.listForwards(layer) };
            }

            case "forward.remove": {
                const forwardId = typeof params.forwardId === "string" ? params.forwardId : "";
                if (!forwardId) throw new Error("forward.remove 需要 forwardId");
                const layer = typeof params.layer === "string" ? params.layer : undefined;
                return this.stack.closeForward(forwardId, layer);
            }

            case "stream.open": {
                const target = params.target as CliTargetSpec | undefined;
                const command = typeof params.command === "string" ? params.command : "";
                if (!command.trim()) throw new Error("stream.open 需要非空 command");
                const stream = params.stream as "stdout" | "stderr" | "both" | undefined;
                if (stream !== undefined && stream !== "stdout" && stream !== "stderr" && stream !== "both") {
                    throw new Error(`stream 无效: ${String(stream)}（支持 stdout|stderr|both）`);
                }
                const displayName = typeof params.name === "string" && params.name.trim() ? params.name.trim() : undefined;
                const limit = typeof params.limit === "number" ? params.limit : 20;
                const waitMs = typeof params.waitMs === "number" ? params.waitMs : 0;
                if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("limit 须在 1–200 之间");
                if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error("waitMs 须在 0–30000 之间");

                this.pruneStreamMeta();
                const h = await this.resolveTarget(target);
                const openDriver = (h.descriptor.driver === "local" && target?.cwd)
                    ? new LocalRuntimeDriver({ cwd: target.cwd, logger: this.log })
                    : h.driver;
                if (typeof openDriver.openStreamWindow !== "function") {
                    throw new Error(`层 '${h.name}' (${h.descriptor.driver}) 不支持持续观察窗`);
                }
                const id = crypto.randomUUID();
                const win = await openDriver.openStreamWindow(this.windowRegistry, {
                    name: id,
                    command,
                    stream,
                    retainSequence: false,
                });
                this.streamMeta.set(id, { displayName, layer: h.name, implicitLocal: h === this.implicitLocal });

                const deadline = Date.now() + waitMs;
                let res = win.peekSince(0, limit);
                while (!res.frames.length && !res.gap && !res.stale && Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(50, deadline - Date.now()))));
                    const cur = this.windowRegistry.get(id);
                    if (!cur || cur.closed) throw new Error(`观察窗 '${id}' 在等待首屏期间已关闭`);
                    res = cur.peekSince(0, limit);
                }
                return formatDaemonStreamResult(id, res, h.name, displayName);
            }

            case "stream.peek": {
                const windowId = typeof params.windowId === "string" ? params.windowId : "";
                if (!windowId.trim()) throw new Error("stream.peek 需要非空 windowId");
                const afterSeq = params.afterSeq as number | undefined;
                const beforeSeq = params.beforeSeq as number | undefined;
                const limit = typeof params.limit === "number" ? params.limit : 20;
                const waitMs = typeof params.waitMs === "number" ? params.waitMs : 0;
                const streamFilter = params.stream as "stdout" | "stderr" | "both" | undefined;
                if (afterSeq !== undefined && beforeSeq !== undefined) {
                    throw new Error("afterSeq 与 beforeSeq 互斥");
                }
                for (const v of [afterSeq, beforeSeq]) {
                    if (v !== undefined && (!Number.isSafeInteger(v) || v < 0)) {
                        throw new Error("afterSeq / beforeSeq 须为非负整数");
                    }
                }
                if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("limit 须在 1–200 之间");
                if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error("waitMs 须在 0–30000 之间");
                if (waitMs > 0 && afterSeq === undefined) throw new Error("waitMs 仅可用于 --after 增量续读");
                if (streamFilter !== undefined && streamFilter !== "stdout" && streamFilter !== "stderr" && streamFilter !== "both") {
                    throw new Error(`stream 无效: ${String(streamFilter)}`);
                }
                const selectedStream = streamFilter === "both" ? undefined : streamFilter;

                const requireActiveWin = () => {
                    const w = this.windowRegistry.get(windowId);
                    if (!w || w.closed) throw new Error(`观察窗 '${windowId}' 不存在或已关闭`);
                    return w;
                };
                const readOnce = () => {
                    const w = requireActiveWin();
                    return afterSeq !== undefined
                        ? w.peekSince(afterSeq, limit, undefined, selectedStream)
                        : beforeSeq !== undefined
                            ? w.peekBefore(beforeSeq, limit, selectedStream)
                            : w.peekLast(limit, selectedStream);
                };

                const deadline = Date.now() + waitMs;
                let res = readOnce();
                while (afterSeq !== undefined && !res.frames.length && !res.gap && !res.stale && Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(50, deadline - Date.now()))));
                    res = readOnce();
                }

                const meta = this.streamMeta.get(windowId);
                return formatDaemonStreamResult(windowId, res, meta?.layer, meta?.displayName);
            }

            case "stream.close": {
                const windowId = typeof params.windowId === "string" ? params.windowId : "";
                if (!windowId.trim()) throw new Error("stream.close 需要非空 windowId");
                const w = this.windowRegistry.get(windowId);
                if (!w || w.closed) throw new Error(`观察窗 '${windowId}' 不存在或已关闭`);
                await this.windowRegistry.stopConfirmed(windowId);
                this.streamMeta.delete(windowId);
                return { window_id: windowId, closed: true };
            }

            case "stream.list":
                return { streams: this.status().streams };

            case "layer.list":
                return {
                    layers: this.status().layers,
                    text: this.stack.layerText(),
                };

            case "layer.remove": {
                const name = typeof params.name === "string" ? params.name : "";
                if (!name) throw new Error("layer.remove 需要 name");
                await this.stack.removeLayer(name, { destroy: params.destroy === true });
                for (const [key, mappedName] of [...this.ephemeralLayers.entries()]) {
                    if (mappedName === name) this.ephemeralLayers.delete(key);
                }
                return { removed: name };
            }

            default:
                throw new Error(`未知 Daemon RPC 方法: ${method}`);
        }
    }
}

function formatDaemonStreamResult(
    windowId: string,
    res: {
        oldestSeq: number;
        newestSeq: number;
        stale: boolean;
        frames: StreamFrame[];
        exitCode?: number | null;
        error?: string;
        lastDeliveredSeq?: number;
        gap?: boolean;
    },
    layer?: string,
    name?: string,
) {
    return {
        window_id: windowId,
        ...(name ? { name } : {}),
        ...(layer ? { layer } : {}),
        oldest_seq: res.oldestSeq,
        newest_seq: res.newestSeq,
        stale: res.stale,
        frames: res.frames,
        ...(res.lastDeliveredSeq !== undefined ? { last_delivered_seq: res.lastDeliveredSeq } : {}),
        ...(res.gap ? { gap: true } : {}),
        ...(res.exitCode !== undefined ? { exit_code: res.exitCode } : {}),
        ...(res.error !== undefined ? { error: res.error } : {}),
    };
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
        error: err instanceof Error ? err.message : String(err),
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
    } catch (e) {
        throw new HttpStatusError(400, `JSON 解析失败: ${(e as Error).message}`);
    }
}

async function readJsonBody(req: http.IncomingMessage): Promise<{ method?: unknown; params?: unknown }> {
    const parsed = await readRawJsonBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new HttpStatusError(400, "RPC 请求体必须是 JSON 对象");
    }
    return parsed as { method?: unknown; params?: unknown };
}
