/**
 * mcp-proxy.test.ts — Phase 3 测试：manage_layers 动态转发、MCP SSE 共享控制面、
 * Proxy 重连保活、Watchdog/Token 轮换、零自动重放（REQ-0005）；filaxis-mcp 的宿主策略
 * （缺省经 Daemon、没有就自动启动；--no-daemon 与绑定参数走进程内）见 REQ-0004 §6.3
 */
import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import {
    createAgentToolkit,
    DaemonClient,
    DaemonServer,
    daemonPaths,
    LocalRuntimeDriver,
    McpServer,
    McpStdioProxy,
    RuntimeStack,
    SshPtyDriver,
    TOOL_DEFS,
    writePrivateFileAtomic,
    cleanupDaemonFiles,
    isPidAlive,
    probeDaemon,
    readDaemonConnection,
    readDaemonLock,
} from "../src/index.js";

class MockChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 61616;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    signals: NodeJS.Signals[] = [];

    kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
        this.signals.push(signal);
        if (signal === "SIGTERM") {
            this.exitCode = 0;
            this.signalCode = "SIGTERM";
            this.emit("exit", 0, "SIGTERM");
            this.emit("close", 0, "SIGTERM");
        }
        return true;
    }
}

function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function attachProxyFixture(opts: ConstructorParameters<typeof McpStdioProxy>[0]) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const proxy = new McpStdioProxy({ ...opts, stdin, stdout });
    const responses: Array<Record<string, unknown>> = [];
    let acc = "";
    stdout.on("data", (chunk: Buffer) => {
        acc += chunk.toString("utf-8");
        let nl: number;
        while ((nl = acc.indexOf("\n")) !== -1) {
            const line = acc.slice(0, nl).trim();
            acc = acc.slice(nl + 1);
            if (line) responses.push(JSON.parse(line) as Record<string, unknown>);
        }
    });
    proxy.start();
    return {
        proxy,
        send: (msg: Record<string, unknown>) => { stdin.write(JSON.stringify(msg) + "\n"); },
        closeStdin: () => { stdin.end(); },
        responses,
    };
}

async function waitForResponse(
    responses: Array<Record<string, unknown>>,
    id: number | string,
    timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const hit = responses.find((r) => r.id === id);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`waitForResponse(${String(id)}) timeout`);
}

describe("manage_layers dynamic forwarding & 12-tool surface", () => {
    test("lists and closes injected-driver forwards after registering or activating a named layer", async () => {
        const stack = new RuntimeStack();
        const makeDriver = (name: string, port: number) => new SshPtyDriver({ driver: "ssh", target: name }, {
            _forwardDeps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    const child = new MockChild();
                    setTimeout(() => child.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.\ndebug1: Entering interactive session.\n`), 5);
                    return child as unknown as ChildProcess;
                },
            },
        });
        const injected = makeDriver("injected.invalid", 18121);
        const named = makeDriver("named.invalid", 18122);
        const toolkit = createAgentToolkit(stack, { driver: injected });
        const { manage_layers } = toolkit.handlers;
        const spec = { action: "forward_add", kind: "L", target_host: "localhost", target_port: 80 } as const;
        try {
            const opened = await manage_layers({ ...spec, bind_port: 18121, forward_id: "injected" });
            await stack.addLayer("named", named, { activate: false });
            await manage_layers({ ...spec, layer: "named", bind_port: 18122, forward_id: "named" });
            // 结果记录为 snake_case（forward_id 主名；forwardId 仅兼容别名）——与参数命名一致
            expect((await manage_layers({ action: "forward_list" })).forwards.map((f) => f.forward_id).sort())
                .toEqual(["injected", "named"]);

            stack.setActive("named");
            expect((await manage_layers({ action: "forward_list" })).forwards.map((f) => f.forward_id).sort())
                .toEqual(["injected", "named"]);
            expect((await manage_layers({ action: "forward_list", layer: "named" })).forwards.map((f) => f.forward_id))
                .toEqual(["named"]);
            await expect(manage_layers({ ...spec, bind_port: 18123, forward_id: "injected" }))
                .rejects.toThrow(/已存在于注入驱动/);
            await expect(manage_layers({ action: "forward_remove", forward_id: opened.forward.forward_id }))
                .resolves.toMatchObject({ status: "stopped" });
            expect(named.listForwards()).toMatchObject([{ forwardId: "named", status: "active" }]); // SDK 类型保持驼峰
            // forward_list 缺省只报仍在用的转发：刚 remove 的 "injected"（stopped 墓碑）不再出现；
            // include_closed=true 才连墓碑一并返回
            expect((await manage_layers({ action: "forward_list" })).forwards.map((f) => f.forward_id)).toEqual(["named"]);
            expect((await manage_layers({ action: "forward_list", include_closed: true })).forwards.map((f) => f.forward_id).sort())
                .toEqual(["injected", "named"]);

            await stack.addLayer("injected-alias", injected, { activate: false });
            await manage_layers({ ...spec, layer: "injected-alias", bind_port: 18121, forward_id: "unregistered" });
            await stack.removeLayer("injected-alias");
            const remaining = await manage_layers({ action: "forward_list" });
            expect(remaining.forwards.map((f) => f.forward_id).sort()).toEqual(["named", "unregistered"]);
            await expect(manage_layers({ action: "forward_remove", forward_id: "unregistered" }))
                .resolves.toMatchObject({ status: "stopped" });
        } finally {
            toolkit.dispose?.();
            await Promise.all([injected.destroy(), named.destroy()]);
        }
    }, 15_000);

    test("keeps TOOL_DEFS at 12 tools and handles forward_add/forward_list/forward_remove via McpServer", async () => {
        expect(TOOL_DEFS).toHaveLength(12);
        const manageTool = TOOL_DEFS.find((t) => t.function.name === "manage_layers")!;
        const oneOf = (manageTool.function.parameters as { oneOf?: Array<{ properties?: { action?: { const?: string } }; required?: string[] }> }).oneOf ?? [];
        const fwdAddSchema = oneOf.find((v) => v.properties?.action?.const === "forward_add");
        expect(fwdAddSchema?.required).toEqual(["action", "kind"]);
        const stack = new RuntimeStack();
        const local = new LocalRuntimeDriver();
        await stack.addLayer("local", local);

        let childRef!: MockChild;
        const sshDriver = new SshPtyDriver({ driver: "ssh", target: "ops@tunnel.test" }, {
            _forwardDeps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    childRef = new MockChild();
                    setTimeout(() => {
                        childRef.stderr.write("debug1: Allocated port 45123 for remote forward to localhost:3000\n");
                    }, 5);
                    return childRef as unknown as ChildProcess;
                },
            },
        });
        await stack.addLayer("ssh-main", sshDriver);

        const stdin = new PassThrough();
        const stdout = new PassThrough();
        new McpServer({ toolkit: createAgentToolkit(stack), stdin, stdout });
        const responses: Array<Record<string, unknown>> = [];
        let acc = "";
        stdout.on("data", (d: Buffer) => {
            acc += d.toString("utf-8");
            let nl: number;
            while ((nl = acc.indexOf("\n")) !== -1) {
                responses.push(JSON.parse(acc.slice(0, nl)) as Record<string, unknown>);
                acc = acc.slice(nl + 1);
            }
        });

        const call = async (id: number, args: Record<string, unknown>) => {
            stdin.write(JSON.stringify({
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: { name: "manage_layers", arguments: args },
            }) + "\n");
            return (await waitForResponse(responses, id)).result as {
                isError: boolean;
                content: Array<{ text: string }>;
                structuredContent?: Record<string, unknown>;
            };
        };

        try {
            const badLocal = await call(1, {
                action: "forward_add",
                layer: "local",
                kind: "L",
                bind_port: 8080,
                target_host: "db",
                target_port: 5432,
            });
            expect(badLocal.isError).toBe(true);
            expect(badLocal.content[0]!.text).toContain("不支持动态端口转发");

            const badParam = await call(2, { action: "forward_list", extra_bad: 1 });
            expect(badParam.isError).toBe(true);

            const added = await call(3, {
                action: "forward_add",
                layer: "ssh-main",
                kind: "remote",
                target_host: "localhost",
                target_port: 3000,
                forward_id: "mcp-r1",
            });
            expect(added.isError).toBe(false);
            expect(added.structuredContent).toMatchObject({
                action: "forward_add",
                forward: {
                    forward_id: "mcp-r1",
                    layer: "ssh-main",
                    kind: "remote",
                    bind_port: 45123,
                    status: "active",
                },
            });
            // 别名与主名同值（兼容期）；record 的其余字段也是 snake_case
            const addedForward = (added.structuredContent as { forward: Record<string, unknown> }).forward;
            expect(addedForward.forwardId).toBe("mcp-r1");
            expect(Object.keys(addedForward).some((k) => /[a-z][A-Z]/.test(k) && k !== "forwardId")).toBe(false);

            const listed = await call(4, { action: "forward_list" });
            expect(listed.isError).toBe(false);
            expect((listed.structuredContent as { forwards: Array<{ forward_id: string }> }).forwards.map((f) => f.forward_id))
                .toEqual(["mcp-r1"]);

            const removed = await call(5, { action: "forward_remove", forward_id: "mcp-r1" });
            expect(removed.isError).toBe(false);
            expect(removed.structuredContent).toEqual({
                action: "forward_remove",
                forward_id: "mcp-r1",
                status: "stopped",
            });
            expect(childRef.signals).toContain("SIGTERM");
        } finally {
            stdin.end();
            await stack.removeLayer("ssh-main", { destroy: true }).catch(() => undefined);
            await stack.removeLayer("local", { destroy: true }).catch(() => undefined);
        }
    });
});

describe("DaemonServer MCP HTTP/SSE & McpStdioProxy", () => {
    test("enforces Bearer auth (401) on /mcp/sse and /mcp/message", async () => {
        const dir = makeTempDir("fx-mcp-auth-");
        const srv = new DaemonServer({ daemonDir: dir, version: "test" });
        try {
            const addr = await srv.start();
            expect((await fetch(`${addr}/mcp/sse`)).status).toBe(401);
            expect((await fetch(`${addr}/mcp/message`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
            })).status).toBe(401);
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("survives MCP proxy client restart and shares streams + forwards with CLI DaemonClient", async () => {
        const dir = makeTempDir("fx-mcp-share-");
        const srv = new DaemonServer({ daemonDir: dir, version: "test" });
        let childRef!: MockChild;
        try {
            const addr = await srv.start();
            const sshDriver = new SshPtyDriver({ driver: "ssh", target: "ops@share.test" }, {
                _forwardDeps: {
                    muxControlPath: () => undefined,
                    spawnSsh: () => {
                        childRef = new MockChild();
                        setTimeout(() => {
                            childRef.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port 19090.\ndebug1: Entering interactive session.\n");
                        }, 5);
                        return childRef as unknown as ChildProcess;
                    },
                },
            });
            await srv.stack.addLayer("shared-ssh", sshDriver);
            await srv.stack.addLayer("local", new LocalRuntimeDriver());

            // Proxy #1 opens a stream window and reads initial frame, then disconnects stdin
            const p1 = attachProxyFixture({ daemonDir: dir });
            p1.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
            await waitForResponse(p1.responses, 1);

            p1.send({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                    name: "observe_stream",
                    arguments: {
                        command: "printf 'frame-one\\n'; sleep 1.5; printf 'frame-two\\n'",
                        wait_ms: 3000,
                    },
                },
            });
            const openResp = await waitForResponse(p1.responses, 2);
            const openSc = (openResp.result as { structuredContent: { window_id: string; frames: Array<{ text: string }> } }).structuredContent;
            expect(openSc.frames.map((f) => f.text)).toContain("frame-one");
            const windowId = openSc.window_id;

            // Close Proxy #1 stdin; Daemon现场 must survive
            p1.closeStdin();
            await new Promise((r) => setTimeout(r, 80));

            // CLI DaemonClient sees the MCP-opened stream window and adds a forward
            const cli = new DaemonClient({ addr, token: srv.token });
            const peekedByCli = await cli.rpc<{ windowId: string; frames: Array<{ text: string }> }>("peekStream", {
                windowId,
                limit: 10,
            });
            expect(peekedByCli.frames.map((f) => f.text)).toContain("frame-one");

            await cli.rpc("openForward", {
                layer: "shared-ssh",
                spec: { id: "cli-fwd", kind: "L", bindPort: 19090, targetHost: "127.0.0.1", targetPort: 80 },
            });

            // Proxy #2 reconnects and sees the same stream window + CLI-created forward, then closes both
            const p2 = attachProxyFixture({ daemonDir: dir });
            p2.send({
                jsonrpc: "2.0",
                id: 10,
                method: "tools/call",
                params: { name: "manage_layers", arguments: { action: "forward_list" } },
            });
            const fwdListResp = await waitForResponse(p2.responses, 10);
            expect((fwdListResp.result as { structuredContent: { forwards: Array<{ forward_id: string }> } }).structuredContent.forwards.map((f) => f.forward_id))
                .toEqual(["cli-fwd"]);

            p2.send({
                jsonrpc: "2.0",
                id: 11,
                method: "tools/call",
                params: { name: "manage_layers", arguments: { action: "forward_remove", forward_id: "cli-fwd" } },
            });
            const fwdRmResp = await waitForResponse(p2.responses, 11);
            expect((fwdRmResp.result as { structuredContent: { status: string } }).structuredContent.status).toBe("stopped");
            expect(childRef.signals).toContain("SIGTERM");

            p2.send({
                jsonrpc: "2.0",
                id: 12,
                method: "tools/call",
                params: { name: "close_stream", arguments: { window_id: windowId } },
            });
            const closeResp = await waitForResponse(p2.responses, 12);
            expect((closeResp.result as { structuredContent: { closed: boolean } }).structuredContent.closed).toBe(true);
            p2.closeStdin();
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("watchdog triggers reconnect and re-reads rotated token/addr after daemon restart", async () => {
        const dir = makeTempDir("fx-mcp-watchdog-");
        let srv1: DaemonServer | undefined = new DaemonServer({
            daemonDir: dir,
            version: "v1",
            sseKeepaliveMs: 60_000,
        });
        let srv2: DaemonServer | undefined;
        try {
            await srv1.start();
            const token1 = srv1.token;
            const addr1 = srv1.addr;

            const fx = attachProxyFixture({
                daemonDir: dir,
                watchdogIdleMs: 300,
                initialReconnectDelayMs: 30,
                maxReconnectDelayMs: 80,
            });
            fx.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
            const r1 = await waitForResponse(fx.responses, 1);
            expect((r1.result as { tools: unknown[] }).tools).toHaveLength(12);

            // Wait past watchdogIdleMs so proxy destroys hung SSE and reconnects
            await new Promise((r) => setTimeout(r, 420));
            fx.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
            const r2 = await waitForResponse(fx.responses, 2);
            expect((r2.result as { tools: unknown[] }).tools).toHaveLength(12);

            // Stop srv1 and start srv2 on the same daemonDir (new port + rotated token)
            await srv1.stop();
            srv1 = undefined;
            srv2 = new DaemonServer({ daemonDir: dir, version: "v2", sseKeepaliveMs: 50 });
            await srv2.stack.addLayer("local", new LocalRuntimeDriver());
            await srv2.start();
            expect(srv2.token).not.toBe(token1);
            expect(srv2.addr).not.toBe(addr1);
            await new Promise((r) => setTimeout(r, 250));

            fx.send({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "run_command", arguments: { command: "printf 'rotated-ok'" } },
            });
            const r3 = await waitForResponse(fx.responses, 3, 10_000);
            expect((r3.result as { structuredContent: { stdout: string; exit_code: number } }).structuredContent).toMatchObject({
                stdout: "rotated-ok",
                exit_code: 0,
            });
            fx.closeStdin();
        } finally {
            await srv1?.stop().catch(() => undefined);
            await srv2?.stop().catch(() => undefined);
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("never auto-replays in-flight tools/call on SSE disconnect (returns outcome=unknown)", async () => {
        const dir = makeTempDir("fx-mcp-noreplay-");
        let execCount = 0;
        let startedResolve!: () => void;
        const execStarted = new Promise<void>((r) => { startedResolve = r; });

        const makeMockToolkit = () => {
            const stack = new RuntimeStack();
            const tk = createAgentToolkit(stack, {
                driver: {
                    descriptor: { driver: "local", target: "mock" },
                    exec: async (cmd: string) => {
                        execCount++;
                        startedResolve();
                        if (cmd === "hang-non-idempotent") {
                            await new Promise((r) => setTimeout(r, 5_000));
                        }
                        return { stdout: "ok", stderr: "", exitCode: 0 };
                    },
                    execSession: async () => { throw new Error("unused"); },
                    tailSession: async () => [],
                    readSessionLog: async () => "",
                    watchSession: () => ({ cancel: () => undefined }),
                    stopSession: async () => ({ status: "stopped" as const }),
                    verifySession: async () => ({ status: "exited" as const, exitCode: 0 }),
                    listSessions: () => [],
                    getCwd: async () => "/",
                    getEnv: async () => undefined,
                    fs: new LocalRuntimeDriver().fs,
                    init: async () => undefined,
                    destroy: async () => undefined,
                },
            });
            return tk;
        };

        let srv1: DaemonServer | undefined = new DaemonServer({ daemonDir: dir, toolkit: makeMockToolkit() });
        let srv2: DaemonServer | undefined;
        try {
            await srv1.start();
            const fx = attachProxyFixture({
                daemonDir: dir,
                initialReconnectDelayMs: 30,
                maxReconnectDelayMs: 80,
            });

            fx.send({
                jsonrpc: "2.0",
                id: 99,
                method: "tools/call",
                params: { name: "run_command", arguments: { command: "hang-non-idempotent" } },
            });
            await execStarted;
            expect(execCount).toBe(1);

            // Sever Daemon #1 mid-execution and bring up Daemon #2 on same daemonDir
            await srv1.stop();
            srv1 = undefined;

            const errResp = await waitForResponse(fx.responses, 99);
            expect(errResp.error).toMatchObject({
                code: -32000,
                data: { outcome: "unknown", method: "tools/call" },
            });

            srv2 = new DaemonServer({ daemonDir: dir, toolkit: makeMockToolkit() });
            await srv2.start();
            await new Promise((r) => setTimeout(r, 150));

            // Subsequent new request works, and the severed call was NEVER replayed
            fx.send({
                jsonrpc: "2.0",
                id: 100,
                method: "tools/call",
                params: { name: "run_command", arguments: { command: "after-reconnect" } },
            });
            const okResp = await waitForResponse(fx.responses, 100);
            expect((okResp.result as { isError: boolean }).isError).toBe(false);
            expect(execCount).toBe(2); // 1 (severed) + 1 (new request) — strictly 0 replays!
            fx.closeStdin();
        } finally {
            await srv1?.stop().catch(() => undefined);
            await srv2?.stop().catch(() => undefined);
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("disconnected SSE sessions cannot fail reused IDs or consume the new session's POST slots", async () => {
        const dir = makeTempDir("fx-mcp-old-post-");
        const streams: http.ServerResponse[] = [];
        let onOldPost!: (res: http.ServerResponse) => void;
        let onOldNotification!: (res: http.ServerResponse) => void;
        let onNewPost!: () => void;
        const oldPost = new Promise<http.ServerResponse>((resolve) => { onOldPost = resolve; });
        const oldNotification = new Promise<http.ServerResponse>((resolve) => { onOldNotification = resolve; });
        const newPost = new Promise<void>((resolve) => { onNewPost = resolve; });
        let firstSessionRequests = 0;
        let secondSessionRequests = 0;
        const stub = http.createServer((req, res) => {
            if (req.url === "/mcp/sse") {
                streams.push(res);
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.write(`event: endpoint\ndata: /post/${streams.length}\n\n`);
                return;
            }
            req.resume();
            req.on("end", () => {
                if (req.url === "/post/1") {
                    if (firstSessionRequests++ === 0) onOldPost(res);
                    else onOldNotification(res);
                } else {
                    res.writeHead(202).end();
                    if (++secondSessionRequests === 2) onNewPost();
                }
            });
        });
        let fx: ReturnType<typeof attachProxyFixture> | undefined;
        try {
            await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
            const port = (stub.address() as { port: number }).port;
            const { addrFile, tokenFile } = daemonPaths(dir);
            writePrivateFileAtomic(addrFile, `127.0.0.1:${port}`);
            writePrivateFileAtomic(tokenFile, "fixture");
            fx = attachProxyFixture({ daemonDir: dir, initialReconnectDelayMs: 30, maxInFlight: 2 });
            const request = { jsonrpc: "2.0", id: 7, method: "tools/list" };
            fx.send(request);
            const delayed = await oldPost;
            fx.send({ jsonrpc: "2.0", method: "notifications/initialized" });
            const delayedNotification = await oldNotification;
            streams[0]!.end();
            expect((await waitForResponse(fx.responses, 7)).error).toMatchObject({ data: { outcome: "unknown" } });
            fx.responses.length = 0;

            fx.send(request);
            fx.send({ ...request, id: 8 });
            await newPost;
            delayedNotification.writeHead(202).end();
            await new Promise<void>((resolve) => delayed.writeHead(500).end("old request failure", resolve));
            await new Promise((resolve) => setTimeout(resolve, 100));
            streams[1]!.write('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n');
            streams[1]!.write('event: message\ndata: {"jsonrpc":"2.0","id":8,"result":{"tools":[]}}\n\n');
            expect(await waitForResponse(fx.responses, 7)).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
            expect(await waitForResponse(fx.responses, 8)).toEqual({ jsonrpc: "2.0", id: 8, result: { tools: [] } });
        } finally {
            fx?.proxy.close();
            stub.closeAllConnections();
            await new Promise<void>((resolve) => stub.close(() => resolve()));
            rmSync(dir, { recursive: true, force: true });
        }
    }, 8_000);

    /** 起一个 filaxis-mcp 子进程并收齐它的 JSON-RPC 响应 */
    function spawnMcp(args: string[], extraEnv: Record<string, string> = {}) {
        const child = spawn(process.execPath, ["bin/filaxis-mcp.ts", ...args], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, FILAXIS_NO_DAEMON: "0", ...extraEnv },
        });
        const responses: Array<Record<string, unknown>> = [];
        let acc = "";
        child.stdout.on("data", (d: Buffer) => {
            acc += d.toString("utf-8");
            let nl: number;
            while ((nl = acc.indexOf("\n")) !== -1) {
                const line = acc.slice(0, nl).trim();
                acc = acc.slice(nl + 1);
                if (line) responses.push(JSON.parse(line) as Record<string, unknown>);
            }
        });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
        return { child, responses, stderrText: () => stderr };
    }

    async function stopDaemonIn(dir: string): Promise<void> {
        const client = await probeDaemon(dir);
        if (client) await client.shutdown().catch(() => undefined);
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline && (readDaemonConnection(dir) || (readDaemonLock(dir)?.pid && isPidAlive(readDaemonLock(dir)!.pid)))) {
            await new Promise((r) => setTimeout(r, 50));
        }
        const pid = readDaemonLock(dir)?.pid;
        if (pid && isPidAlive(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* 已退出 */ } }
        cleanupDaemonFiles(dir);
    }

    test("filaxis-mcp 缺省经 Daemon：没有在跑就自动启动；客户端退出后 Daemon 仍在，别的客户端接得上同一份现场", async () => {
        // REQ-0004 §6.3 / AC-05：0.2.x 的「MCP 绝不隐式启动 Daemon」是有意推翻的——
        // 两个 MCP 客户端之间、CLI 与 MCP 之间要共享层、连接、转发、观察窗
        const dir = makeTempDir("fx-mcp-bin-autostart-");
        const { child, responses, stderrText } = spawnMcp(["--daemon-dir", dir]);
        try {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
            const r1 = await waitForResponse(responses, 1, 60_000);
            expect((r1.result as { tools: unknown[] }).tools).toHaveLength(12);

            child.stdin.write(JSON.stringify({
                jsonrpc: "2.0", id: 2, method: "tools/call",
                params: { name: "run_command", arguments: { command: "printf MCP_VIA_DAEMON" } },
            }) + "\n");
            const r2 = await waitForResponse(responses, 2, 30_000);
            expect(JSON.stringify(r2.result)).toContain("MCP_VIA_DAEMON");

            // Daemon 是这个 MCP 进程启动的；另一个客户端（这里是 DaemonClient）连的是同一个它
            const client = await probeDaemon(dir);
            expect(client).not.toBeNull();
            const viaCli = await client!.rpc<{ stdout: string }>("runCommand", { command: "printf CLI_SAME_SITE" });
            expect(viaCli.stdout).toBe("CLI_SAME_SITE");

            child.stdin.end();
            const exitCode = await new Promise<number | null>((resolve) => {
                if (child.exitCode !== null) resolve(child.exitCode);
                else child.once("close", (code) => resolve(code));
            });
            expect(exitCode).toBe(0);
            // 客户端退出后 Daemon 仍在（现场不随某一个客户端的退出而消失）
            const { lockFile, addrFile, tokenFile } = daemonPaths(dir);
            expect(existsSync(lockFile)).toBe(true);
            expect(existsSync(addrFile)).toBe(true);
            expect(existsSync(tokenFile)).toBe(true);
            expect(await probeDaemon(dir)).not.toBeNull();
        } finally {
            if (child.exitCode === null) child.kill("SIGTERM");
            await stopDaemonIn(dir);
            rmSync(dir, { recursive: true, force: true });
        }
    }, 90_000);

    test("多个 filaxis-mcp 客户端同时冷启动：都接得上同一个 Daemon", async () => {
        // 并发首启：只有一个客户端的子进程拿得到锁，其余的子进程因锁被占而退出、只上报退出码。
        // 启动器此前只在报错文案含「已在运行」时才接纳别人拉起的实例——构建产物实测四成一
        const dir = makeTempDir("fx-mcp-bin-cold-");
        const clients = Array.from({ length: 4 }, () => spawnMcp(["--daemon-dir", dir]));
        const settled = (c: ReturnType<typeof spawnMcp>): Promise<"responded" | "exited"> => Promise.race([
            waitForResponse(c.responses, 1, 60_000).then(() => "responded" as const),
            new Promise<"exited">((resolve) => {
                if (c.child.exitCode !== null) resolve("exited");
                else c.child.once("close", () => resolve("exited"));
            }),
        ]);
        try {
            for (const c of clients) c.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
            const outcomes = await Promise.all(clients.map(settled));
            const detail = clients
                .map((c, i) => `客户端 ${i + 1}: ${outcomes[i]}${outcomes[i] === "exited" ? `（${c.stderrText().trim().slice(0, 160)}）` : ""}`)
                .join("；");
            expect(outcomes.filter((o) => o === "responded"), detail).toHaveLength(clients.length);
            for (const c of clients) {
                expect((c.responses.find((r) => r.id === 1)!.result as { tools: unknown[] }).tools).toHaveLength(12);
            }
            // 接的是同一个 Daemon：只拉起了一个
            expect(await probeDaemon(dir)).not.toBeNull();
        } finally {
            for (const c of clients) if (c.child.exitCode === null) c.child.kill("SIGTERM");
            await stopDaemonIn(dir);
            rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);

    test("filaxis-mcp --no-daemon：不启动 Daemon，在本进程内服务", async () => {
        const dir = makeTempDir("fx-mcp-bin-nod-");
        const { child, responses, stderrText } = spawnMcp(["--daemon-dir", dir, "--no-daemon"]);
        try {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
            const r1 = await waitForResponse(responses, 1, 30_000);
            expect((r1.result as { tools: unknown[] }).tools).toHaveLength(12);

            child.stdin.write(JSON.stringify({
                jsonrpc: "2.0", id: 2, method: "tools/call",
                params: { name: "run_command", arguments: { command: "printf MCP_INPROCESS" } },
            }) + "\n");
            const r2 = await waitForResponse(responses, 2, 30_000);
            expect(JSON.stringify(r2.result)).toContain("MCP_INPROCESS");

            child.stdin.end();
            const exitCode = await new Promise<number | null>((resolve) => {
                if (child.exitCode !== null) resolve(child.exitCode);
                else child.once("close", (code) => resolve(code));
            });
            expect(exitCode).toBe(0);

            const { lockFile, addrFile, tokenFile } = daemonPaths(dir);
            expect(existsSync(lockFile)).toBe(false);
            expect(existsSync(addrFile)).toBe(false);
            expect(existsSync(tokenFile)).toBe(false);
        } finally {
            if (child.exitCode === null) child.kill("SIGTERM");
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);

    test("进程内形态：客户端断开后进程退出，不陪还在跑的会话与 SSH 子进程一起滞留", async () => {
        // 真机复验踩出（0.2.13 即如此）：McpServer 在 stdin 关闭时只销毁观察窗注册表；
        // 绑定 SSH 层时 PTY 子进程撑住事件循环，客户端退出后这个进程连同它的 ssh 一直留着，
        // 每个客户端会话泄漏一个。这里用一个还在跑的会话制造同样的「事件循环被撑住」：
        // 修复前进程至少要陪它等到会话结束（25s），修复后断开即退
        const dir = makeTempDir("fx-mcp-bin-exit-");
        const cwd = join(dir, "layer-cwd");
        mkdirSync(cwd);
        const store = join(dir, "layers.json");
        writeFileSync(store, JSON.stringify({ bound: { driver: "local", cwd } }));
        const { child, responses } = spawnMcp(["--no-daemon", "--layer", "bound"], { FILAXIS_LAYERS: store });
        try {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
            child.stdin.write(JSON.stringify({
                jsonrpc: "2.0", id: 2, method: "tools/call",
                params: { name: "start_session", arguments: { command: "sleep 25" } },
            }) + "\n");
            const r2 = await waitForResponse(responses, 2, 30_000);
            expect(JSON.stringify(r2.result)).toContain("session_id");
            child.stdin.end();
            const t0 = Date.now();
            const exitCode = await new Promise<number | null>((resolve) => {
                const timer = setTimeout(() => resolve(null), 10_000);
                child.once("close", (code) => { clearTimeout(timer); resolve(code); });
            });
            expect(exitCode).toBe(0);
            expect(Date.now() - t0).toBeLessThan(10_000);
        } finally {
            if (child.exitCode === null) child.kill("SIGKILL");
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);

    test("filaxis-mcp --layer honors the saved target while a daemon is running", async () => {
        const dir = makeTempDir("fx-mcp-bin-layer-");
        const srv = new DaemonServer({ daemonDir: dir });
        let child: ChildProcess | undefined;
        try {
            await srv.start();
            const store = join(dir, "layers.json");
            const records = Object.fromEntries(["first", "second"].map((name) => {
                const cwd = join(dir, name);
                mkdirSync(cwd);
                writeFileSync(join(cwd, "marker.txt"), name);
                return [name, { driver: "local", cwd }];
            }));
            writeFileSync(store, JSON.stringify(records));
            const proc = spawn(process.execPath, ["bin/filaxis-mcp.ts", "--daemon-dir", dir, "--layer", "first"], {
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env, FILAXIS_LAYERS: store, FILAXIS_NO_DAEMON: "0" },
                windowsHide: true,
            });
            child = proc;
            const responses: Array<Record<string, unknown>> = [];
            createInterface({ input: proc.stdout }).on("line", (line) => responses.push(JSON.parse(line)));
            for (const [id, layer, marker] of [[1, undefined, "first"], [2, "second", "second"]] as const) {
                proc.stdin.write(JSON.stringify({
                    jsonrpc: "2.0", id, method: "tools/call",
                    params: { name: "read_path", arguments: { path: "marker.txt", layer } },
                }) + "\n");
                expect((await waitForResponse(responses, id)).result).toMatchObject({
                    content: [{ type: "text", text: expect.stringContaining(marker) }],
                });
            }
            proc.stdin.end();
            expect(await new Promise<number | null>((resolve) => proc.once("close", resolve))).toBe(0);
        } finally {
            if (child?.exitCode === null) child.kill("SIGTERM");
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("fails in-flight request immediately with outcome=unknown when POST target rejects/errors", async () => {
        const dir = makeTempDir("fx-mcp-posterr-");
        const srv = new DaemonServer({ daemonDir: dir, version: "test" });
        try {
            await srv.start();
            const fx = attachProxyFixture({
                daemonDir: dir,
                initialReconnectDelayMs: 50,
                maxReconnectDelayMs: 100,
            });
            fx.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
            await waitForResponse(fx.responses, 1);

            // Corrupt daemon.token? Or stop server right as POST happens? Even simpler:
            // Send an oversized or malformed POST? Wait: proxy reads from daemon.addr;
            // if Daemon returns 401/404 or closes socket during POST, proxy emits -32000 outcome=unknown.
            // Stop server and immediately send request before SSE close propagates, or test 404 via closing SSE clients.
            const stopping = srv.stop();
            fx.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
            await stopping;
            const resp = await waitForResponse(fx.responses, 2, 5_000);
            expect(resp.error).toMatchObject({
                code: -32000,
                data: { outcome: "unknown" },
            });
            fx.closeStdin();
        } finally {
            await srv.stop().catch(() => undefined);
            rmSync(dir, { recursive: true, force: true });
        }
    }, 10_000);

    test("reports oversized MCP requests as rejected and keeps the session usable", async () => {
        const dir = makeTempDir("fx-mcp-post-oversize-");
        const srv = new DaemonServer({ daemonDir: dir });
        let fx: ReturnType<typeof attachProxyFixture> | undefined;
        try {
            await srv.start();
            fx = attachProxyFixture({ daemonDir: dir });
            fx.send({
                jsonrpc: "2.0", id: 1, method: "tools/call",
                params: { name: "run_command", arguments: { command: "x".repeat(17 * 1024 * 1024) } },
            });
            const { error } = await waitForResponse(fx.responses, 1);
            expect(error).toMatchObject({
                message: expect.stringContaining("请求体超过限制"),
                data: { method: "tools/call", statusCode: 413 },
            });
            expect((error as { data: Record<string, unknown> }).data).not.toHaveProperty("outcome");
            fx.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
            expect((await waitForResponse(fx.responses, 2)).result).toBeDefined();
        } finally {
            fx?.proxy.close();
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("stdin 在 SSE 握手完成前关闭：在途的握手请求随即撤下，不转发、不重连、不留连接", async () => {
        // 假 Daemon：/mcp/sse 的请求扣住不回应（握手悬而未决）；其余路径记下并拒绝
        const dir = makeTempDir("fx-mcp-early-eof-");
        // 观察连接本身。响应尚未开始时，Linux 上的 bun 1.3.12 不给 ServerResponse 发 close，
        // 只给 socket 发；socket 的 close 四个运行时（bun 1.3.12 / 1.4.4、Node 22 / 26）都发
        const held = new Set<http.IncomingMessage["socket"]>();
        const posts: string[] = [];
        let sseGets = 0;
        const fake = http.createServer((req, res) => {
            if (req.method === "GET" && req.url === "/mcp/sse") {
                sseGets++;
                const socket = req.socket;
                held.add(socket);
                socket.on("close", () => held.delete(socket));
                return;
            }
            posts.push(`${req.method} ${req.url}`);
            res.writeHead(404).end();
        });
        let fx: ReturnType<typeof attachProxyFixture> | undefined;
        try {
            await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
            const port = (fake.address() as { port: number }).port;
            writeFileSync(join(dir, "daemon.addr"), `http://127.0.0.1:${port}`);
            writeFileSync(join(dir, "daemon.token"), "early-eof-token");

            fx = attachProxyFixture({ daemonDir: dir, initialReconnectDelayMs: 50, maxReconnectDelayMs: 100 });
            fx.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
            // 握手请求已发出、响应还没回来，客户端这时走了（`filaxis-mcp < /dev/null`、
            // 探测式调用、宿主启动失败）
            const gotDeadline = Date.now() + 3_000;
            while (held.size === 0 && Date.now() < gotDeadline) await new Promise((r) => setTimeout(r, 5));
            expect(held.size).toBe(1);
            fx.closeStdin();

            // 修复前：握手请求没人撤（close() 只中止已激活的会话，而会话要等响应头才登记），
            // 连接一直扣在这里；握手响应迟到后代理已关闭、队列不转发，Node 进程陪着这条
            // SSE 连接永不退出（真机：`echo … | node dist/bin/filaxis-mcp.js` 滞留超过 12 秒）
            const heldDeadline = Date.now() + 3_000;
            while (held.size > 0 && Date.now() < heldDeadline) await new Promise((r) => setTimeout(r, 10));
            expect([...held]).toHaveLength(0);

            await new Promise((r) => setTimeout(r, 250)); // 超过重连间隔：关闭之后不再重连
            expect(sseGets).toBe(1);
            expect(posts).toEqual([]);
            expect(fx.responses).toEqual([]);
        } finally {
            fx?.proxy.close();
            fake.closeAllConnections();
            await new Promise<void>((resolve) => fake.close(() => resolve()));
            rmSync(dir, { recursive: true, force: true });
        }
    }, 10_000);

    test("connects MCP HTTP/SSE proxy over IPv6 loopback [::1]", async () => {
        const dir = makeTempDir("fx-mcp-ipv6-");
        const srv = new DaemonServer({ daemonDir: dir, host: "::1", version: "ipv6" });
        try {
            try {
                await srv.start();
            } catch (e) {
                const code = (e as NodeJS.ErrnoException).code;
                if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") return;
                throw e;
            }
            expect(srv.addr).toContain("[::1]:");

            const fx = attachProxyFixture({ daemonDir: dir });
            fx.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
            const initResp = await waitForResponse(fx.responses, 1);
            expect((initResp.result as { serverInfo: { version: string } }).serverInfo.version).toBe("ipv6");

            fx.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
            const listResp = await waitForResponse(fx.responses, 2);
            expect((listResp.result as { tools: unknown[] }).tools).toHaveLength(12);
            fx.closeStdin();
        } finally {
            await srv.stop().catch(() => undefined);
            rmSync(dir, { recursive: true, force: true });
        }
    }, 10_000);
});
