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

    async status(timeoutMs = 3000): Promise<DaemonStatusInfo> {
        return this.unwrap<DaemonStatusInfo>(await this.rawRequest("GET", "/status", undefined, timeoutMs, true));
    }

    async shutdown(timeoutMs = 5000): Promise<{ ok: true }> {
        const response = await this.rawRequest("POST", "/shutdown", {}, timeoutMs, true);
        return this.unwrap<{ ok: true }>(response);
    }

    async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
        const response = await this.rawRequest("POST", "/rpc", { method, params }, timeoutMs, true);
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
    ): Promise<{ statusCode: number; raw: string; json?: unknown }> {
        return new Promise((resolve, reject) => {
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
                    resolve({ statusCode: res.statusCode ?? 0, raw, json });
                });
                res.on("error", onTransportError);
            });

            if (timeoutMs !== undefined && timeoutMs > 0) {
                req.setTimeout(timeoutMs, () => {
                    req.destroy(new Error(`Daemon 请求超时 (${timeoutMs}ms): ${method} ${reqPath}`));
                });
            }
            req.on("error", onTransportError);
            if (payload) req.write(payload);
            req.end();

            function onTransportError(err: Error): void {
                reject(method === "POST" ? tagTransportUnknown(err) : err);
            }
        });
    }
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

export interface SpawnDaemonOptions {
    cliEntryPath: string;
    daemonDir?: string;
    addr?: string;
    readyTimeoutMs?: number;
}

/** 仅由 `filaxis daemon start` 显式调用：后台独立拉起 Daemon 并等待控制面就绪 */
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
