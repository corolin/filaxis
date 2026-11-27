/**
 * daemon-client.ts — Filaxis 常驻守护进程 HTTP 客户端与显式后台拉起器
 *
 * 零第三方依赖：仅使用 node:http / node:child_process。
 * 重要不变量：probeDaemon 仅探测已存在的 Daemon，绝不隐式拉起后台进程；
 * 仅 filaxis daemon start 显式调用 spawnDaemonBackground。
 */
import { spawn } from "node:child_process";
import * as http from "node:http";
import { defaultDaemonDir, isPidAlive, readDaemonConnection } from "./daemon-files.js";
import type { DaemonStatusInfo } from "./daemon-server.js";
import { PROTOCOL_VERSION, REMOTE_OP_NAMES } from "../../middle/protocol.js";
import type { Middle, MiddleOps } from "../../middle/types.js";

export function urlRequestHost(url: URL): string {
    const h = url.hostname;
    return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

export function urlRequestPort(url: URL): number {
    if (url.port !== "") return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
}

export function parseAddrToUrl(addr: string): URL {
    const trimmed = addr.trim();
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const url = new URL(normalized);
    const authority = normalized.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";
    const hasExplicitPort = /:\d+$/.test(authority);
    if (!url.hostname || (!url.port && !hasExplicitPort)) {
        throw new Error(`非法 Daemon 监听地址（需要 host:port 形态）: ${addr}`);
    }
    return url;
}

export interface DaemonClientOptions {
    addr: string;
    token: string;
}

function tagTransportUnknown(err: unknown): unknown {
    if (err && typeof err === "object" && "outcome" in err && (err as { outcome?: unknown }).outcome !== undefined) {
        return err;
    }
    if (err && typeof err === "object") {
        const code = (err as { code?: unknown }).code;
        if (code === "ECONNREFUSED") return err;
        const tagged = err as Error & { outcome?: unknown };
        if (tagged.outcome === undefined) tagged.outcome = "unknown";
        return tagged;
    }
    return Object.assign(new Error(String(err)), { outcome: "unknown" });
}

export class DaemonClient {
    readonly addr: string;
    private readonly token: string;
    private readonly baseUrl: URL;

    constructor(opts: DaemonClientOptions) {
        this.addr = opts.addr;
        this.token = opts.token;
        this.baseUrl = parseAddrToUrl(opts.addr);
    }

    async health(timeoutMs = 1500): Promise<boolean> {
        try {
            const res = await this.rawRequest("GET", "/health", undefined, timeoutMs, false);
            return res.statusCode === 200 && Boolean((res.json as { ok?: unknown } | undefined)?.ok === true);
        } catch {
            return false;
        }
    }

    /** `control`：握手类请求可要求硬性期限、可被外部中止（见 RequestControl） */
    async status(timeoutMs = 3000, control: RequestControl = {}): Promise<DaemonStatusInfo> {
        return this.unwrap<DaemonStatusInfo>(await this.rawRequest("GET", "/status", undefined, timeoutMs, true, control));
    }

    async shutdown(timeoutMs = 5000): Promise<{ ok: true }> {
        const response = await this.rawRequest("POST", "/shutdown", {}, timeoutMs, true);
        return this.unwrap<{ ok: true }>(response);
    }

    /** 调用一个中层操作。信封带线协议版本：Daemon 与本客户端不一致时会被明确拒绝，不执行 */
    async rpc<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
        const response = await this.rawRequest("POST", "/rpc", { protocol: PROTOCOL_VERSION, op, params }, timeoutMs, true);
        return this.unwrap<T>(response);
    }

    private unwrap<T>(res: { statusCode: number; raw: string; json?: unknown }): T {
        if (res.statusCode === 401) {
            throw new Error("Daemon 鉴权失败 (HTTP 401)：Bearer token 不匹配或已失效");
        }
        const parsed = res.json as Record<string, unknown> | undefined;
        if (parsed && parsed.ok === true) {
            return parsed.result as T;
        }
        if (parsed && parsed.ok === false) {
            const err = new Error(String(parsed.error ?? "Daemon RPC 调用失败")) as Error & {
                outcome?: unknown;
                sessionId?: unknown;
                logBase?: unknown;
                exitCode?: unknown;
                terminalId?: unknown;
                forwardId?: string;
                code?: string | number;
                statusCode?: number;
                partialOutput?: string;
            };
            if (res.statusCode >= 400) err.statusCode = res.statusCode;
            if (typeof parsed.name === "string") err.name = parsed.name;
            if (typeof parsed.code === "string" || typeof parsed.code === "number") err.code = parsed.code;
            if (typeof parsed.partialOutput === "string") err.partialOutput = parsed.partialOutput;
            if (parsed.outcome !== undefined) err.outcome = parsed.outcome;
            if (parsed.sessionId !== undefined) err.sessionId = parsed.sessionId;
            if (parsed.logBase !== undefined) err.logBase = parsed.logBase;
            if (parsed.exitCode !== undefined) err.exitCode = parsed.exitCode;
            if (parsed.terminalId !== undefined) err.terminalId = parsed.terminalId;
            if (typeof parsed.forwardId === "string") err.forwardId = parsed.forwardId;
            throw err;
        }
        throw new Error(`Daemon HTTP ${res.statusCode}: ${res.raw.slice(0, 200)}`);
    }

    private rawRequest(
        method: "GET" | "POST",
        reqPath: string,
        body: unknown,
        timeoutMs: number | undefined,
        withAuth: boolean,
        control: RequestControl = {},
    ): Promise<{ statusCode: number; raw: string; json?: unknown }> {
        return new Promise((resolve, reject) => {
            if (control.signal?.aborted) {
                reject(abortReason(control.signal));
                return;
            }
            const payload = body !== undefined ? Buffer.from(JSON.stringify(body), "utf-8") : undefined;
            const headers: Record<string, string> = {};
            if (withAuth) headers.Authorization = `Bearer ${this.token}`;
            if (payload) {
                headers["Content-Type"] = "application/json; charset=utf-8";
                headers["Content-Length"] = String(payload.byteLength);
            }

            const req = http.request({
                protocol: this.baseUrl.protocol,
                hostname: urlRequestHost(this.baseUrl),
                port: urlRequestPort(this.baseUrl),
                path: reqPath,
                method,
                headers,
                agent: false,
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (d: Buffer) => chunks.push(d));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf-8");
                    let json: unknown;
                    try { json = JSON.parse(raw); } catch { /* non-json */ }
                    settle(() => resolve({ statusCode: res.statusCode ?? 0, raw, json }));
                });
                res.on("error", onTransportError);
            });

            // 缺省是空闲超时：长操作靠它做到「只杀哑不杀慢」。握手这类必须有限的请求另加硬性期限
            let deadline: ReturnType<typeof setTimeout> | undefined;
            if (timeoutMs !== undefined && timeoutMs > 0) {
                const expire = (): void => {
                    req.destroy(new Error(`Daemon 请求超时 (${timeoutMs}ms): ${method} ${reqPath}`));
                };
                if (control.absoluteTimeout) deadline = setTimeout(expire, timeoutMs);
                else req.setTimeout(timeoutMs, expire);
            }
            const onAbort = (): void => { req.destroy(abortReason(control.signal!)); };
            control.signal?.addEventListener("abort", onAbort, { once: true });
            req.on("error", onTransportError);
            if (payload) req.write(payload);
            req.end();

            function settle(fn: () => void): void {
                if (deadline) clearTimeout(deadline);
                control.signal?.removeEventListener("abort", onAbort);
                fn();
            }
            function onTransportError(err: Error): void {
                settle(() => reject(method === "POST" ? tagTransportUnknown(err) : err));
            }
        });
    }
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("请求已中止");
}

/** 握手类请求的附加控制 */
export interface RequestControl {
    /** 超时按绝对时间算，而不是「空闲多久」 */
    absoluteTimeout?: boolean;
    /** 触发即中止请求 */
    signal?: AbortSignal;
}

/** Daemon 的线协议与本客户端不一致（REQ-0004 §6.2）。绝不向错配的 Daemon 发操作。 */
export class ProtocolMismatchError extends Error {
    readonly code = "E_PROTOCOL_MISMATCH";
    readonly expected = PROTOCOL_VERSION;
    readonly actual: number | undefined;
    readonly daemonPid: number | undefined;
    readonly daemonVersion: string | undefined;
    constructor(actual: number | undefined, status: Partial<DaemonStatusInfo>) {
        const theirs = actual === undefined ? "（未上报——0.2.x 的 Daemon）" : String(actual);
        super(
            `Filaxis Daemon 线协议版本不一致，已拒绝执行：本客户端 protocol=${PROTOCOL_VERSION}，Daemon protocol=${theirs}` +
            `（pid=${status.pid ?? "?"}，版本 ${status.version ?? "?"}）。升级后旧 Daemon 仍在运行；请先 filaxis daemon stop，再重新发起命令`,
        );
        this.name = "ProtocolMismatchError";
        this.actual = actual;
        this.daemonPid = status.pid;
        this.daemonVersion = status.version;
    }
}

/**
 * 核对 Daemon 的线协议版本，不一致即抛 ProtocolMismatchError。
 * 调用方在向 Daemon 发任何操作之前必须先过这一关。
 */
export async function assertDaemonProtocol(client: DaemonClient, timeoutMs = 3000): Promise<DaemonStatusInfo> {
    const status = await client.status(timeoutMs);
    if (status.protocolVersion !== PROTOCOL_VERSION) {
        throw new ProtocolMismatchError(status.protocolVersion, status);
    }
    return status;
}

/**
 * 经 Daemon 的同形中层（REQ-0004 §5.1）：与进程内 createMiddle 返回的对象同一个接口——
 * 方法签名一致，界面层不必关心中层在哪。连上先过线协议握手；之后每个操作是一次 RPC。
 * 这里不给 HTTP 请求设超时：长操作的超时由操作自己的参数管（如 runCommand 的 timeoutMs）。
 */
export async function connectRemoteMiddle(client: DaemonClient, timeoutMs = 3000): Promise<Middle> {
    const status = await assertDaemonProtocol(client, timeoutMs);
    const ops = Object.fromEntries(REMOTE_OP_NAMES.map((name) => [name, (params: Record<string, unknown> = {}) => client.rpc(name, params)])) as unknown as MiddleOps;
    return {
        host: { kind: "daemon", version: status.version, protocolVersion: status.protocolVersion, pid: status.pid },
        ops,
        dispose() { /* 状态在 Daemon 进程里，不随客户端销毁 */ },
        async shutdown() { /* 同上；停 Daemon 用 filaxis daemon stop */ },
    } as Middle;
}

/** 仅探测已存在的活跃 Daemon；无文件、PID 已死或连通失败均返回 null（绝不自动拉起） */
export async function probeDaemon(daemonDir = defaultDaemonDir(), timeoutMs = 800): Promise<DaemonClient | null> {
    const conn = readDaemonConnection(daemonDir);
    if (!conn) return null;
    if (conn.lock?.pid && !isPidAlive(conn.lock.pid)) return null;
    try {
        const client = new DaemonClient({ addr: conn.addr, token: conn.token });
        await client.status(timeoutMs);
        return client;
    } catch {
        return null;
    }
}

/**
 * 等控制面就绪（每 100ms 探一次），超时返回 null。用于「别的进程正在拉起 Daemon」的情形：
 * 多个客户端同时冷启动时，输家的子进程因锁被占而退出，赢家还在启动途中。
 */
export async function waitForDaemon(daemonDir = defaultDaemonDir(), timeoutMs = 10_000): Promise<DaemonClient | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const client = await probeDaemon(daemonDir, 500);
        if (client) return client;
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, 100));
    }
}

export interface SpawnDaemonOptions {
    cliEntryPath: string;
    daemonDir?: string;
    addr?: string;
    readyTimeoutMs?: number;
}

/** 由 `filaxis daemon start` 与 filaxis-mcp 的自动启动调用：后台独立拉起 Daemon 并等待控制面就绪 */
export async function spawnDaemonBackground(opts: SpawnDaemonOptions): Promise<DaemonStatusInfo> {
    const daemonDir = opts.daemonDir ?? defaultDaemonDir();
    const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
    const existing = await probeDaemon(daemonDir);
    if (existing) {
        const { pid, addr } = await existing.status();
        throw new Error(`Filaxis Daemon 已在运行 (pid=${pid}, addr=${addr})`);
    }
    const argv = [opts.cliEntryPath, "daemon", "start", "--foreground", "--daemon-dir", daemonDir];
    if (opts.addr) argv.push("--addr", opts.addr);

    const child = spawn(process.execPath, argv, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, FILAXIS_DAEMON_DIR: daemonDir },
    });

    let earlyExit: string | undefined;
    child.once("error", (err) => {
        earlyExit = `Daemon 进程启动失败: ${err.message}`;
    });
    child.once("exit", (code, signal) => {
        earlyExit = `Daemon 进程提前退出 (code=${code ?? "null"} signal=${signal ?? "none"})`;
    });
    child.unref();

    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
        if (earlyExit) throw new Error(earlyExit);
        const client = await probeDaemon(daemonDir, 500);
        if (client) {
            const status = await client.status(1500).catch(() => undefined);
            if (status && status.pid === child.pid) return status;
        }
        await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(`等待 Filaxis Daemon 就绪超时 (${readyTimeoutMs}ms)`);
}
