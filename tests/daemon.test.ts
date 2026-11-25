/**
 * daemon.test.ts — 显式常驻 Daemon、鉴权文件锁、RPC 共享现场与 CLI 端到端测试（REQ-0005 Phase 2）
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { PassThrough } from "node:stream";
import {
    acquireDaemonLock,
    cleanupDaemonFiles,
    DaemonClient,
    DaemonServer,
    daemonPaths,
    generateDaemonToken,
    LocalRuntimeDriver,
    parseAddrToUrl,
    probeDaemon,
    readDaemonConnection,
    SshPtyDriver,
    spawnDaemonBackground,
    StreamWindowRegistry,
    urlRequestPort,
    verifyBearerToken,
    writePrivateFileAtomic,
} from "../src/index.js";

class MockChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 51515;
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

function runCli(args: string[], daemonDir: string) {
    return Bun.spawnSync([process.execPath, "bin/filaxis.ts", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: { ...process.env, FILAXIS_DAEMON_DIR: daemonDir },
    });
}

function runCliAsync(args: string[], daemonDir: string, options: { cwd?: string; layers?: string } = {}) {
    return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [resolvePath("bin/filaxis.ts"), ...args], {
            stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
            cwd: options.cwd,
            env: {
                ...process.env,
                FILAXIS_DAEMON_DIR: daemonDir,
                ...(options.layers ? { FILAXIS_LAYERS: options.layers } : {}),
            },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
}

describe("daemon-files lock & token", () => {
    test("enforces single-instance PID lock and reclaims stale dead-PID lock", () => {
        const dir = makeTempDir("fx-daemon-lock-");
        try {
            const rec = acquireDaemonLock(dir, "0.2.11");
            expect(rec.pid).toBe(process.pid);
            expect(() => acquireDaemonLock(dir, "0.2.11")).toThrow(/已在运行/);

            const { lockFile } = daemonPaths(dir);
            writeFileSync(lockFile, JSON.stringify({ pid: 999_999_99, startedAt: 1, version: "0.0.0" }));
            const reclaimed = acquireDaemonLock(dir, "0.2.11");
            expect(reclaimed.pid).toBe(process.pid);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("generates 32-byte hex token and verifies Bearer case-insensitively", () => {
        const dir = makeTempDir("fx-daemon-tok-");
        try {
            const token = generateDaemonToken();
            expect(token).toMatch(/^[0-9a-f]{64}$/);
            expect(verifyBearerToken(`Bearer ${token}`, token)).toBe(true);
            expect(verifyBearerToken(`bearer ${token}`, token)).toBe(true);
            expect(verifyBearerToken(`Bearer ${"0".repeat(64)}`, token)).toBe(false);
            expect(verifyBearerToken(undefined, token)).toBe(false);
            expect(verifyBearerToken(`Basic ${token}`, token)).toBe(false);

            const { tokenFile } = daemonPaths(dir);
            writePrivateFileAtomic(tokenFile, token);
            expect(readFileSync(tokenFile, "utf-8")).toBe(token);
            if (process.platform !== "win32") {
                expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("DaemonServer & DaemonClient RPC", () => {
    test("passes client-relative SSH files to the daemon for explicit hosts and saved layers", async () => {
        const dir = makeTempDir("fx-daemon-ssh-paths-");
        const cwd = join(dir, "client");
        const layers = join(dir, "layers.json");
        mkdirSync(cwd);
        writeFileSync(layers, JSON.stringify({
            fixture: {
                driver: "ssh", target: "fixture.invalid",
                config: {
                    connParams: { keyFile: "~/fixture-key", knownHostsFile: "hosts", jump: { host: "jump.invalid", keyFile: "jump-key" } },
                    sshHops: [{ host: "inner.invalid", conn: { keyFile: "inner-key" } }],
                },
            },
        }));
        const plan = join(dir, "plan.json");
        writeFileSync(plan, JSON.stringify({ layer: "fixture", steps: [{ id: "fixture", kind: "exec", command: "fixture" }] }));
        const requests: unknown[] = [];
        const stub = http.createServer(async (req, res) => {
            let result: Record<string, unknown> = {};
            if (req.method === "POST") {
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(chunk);
                const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                requests.push(request);
                result = request.method === "batch"
                    ? { status: "ok", steps: [] }
                    : { stdout: "", stderr: "", exitCode: 0 };
            }
            res.end(JSON.stringify({ ok: true, result }));
        });
        try {
            await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
            const { addrFile, tokenFile } = daemonPaths(dir);
            writePrivateFileAtomic(addrFile, `127.0.0.1:${(stub.address() as { port: number }).port}`);
            writePrivateFileAtomic(tokenFile, "fixture");
            const opts = { cwd, layers };
            const direct = await runCliAsync([
                "exec", "--host", "fixture.invalid", "--key", "key", "--known-hosts", "hosts", "--", "fixture",
            ], dir, opts);
            expect(direct.exitCode).toBe(0);
            expect((await runCliAsync(["exec", "--layer", "fixture", "--", "fixture"], dir, opts)).exitCode).toBe(0);
            expect((await runCliAsync(["batch", "--request-file", plan], dir, opts)).exitCode).toBe(0);

            const savedConfig = {
                connParams: {
                    keyFile: "~/fixture-key",
                    knownHostsFile: join(cwd, "hosts"),
                    jump: { host: "jump.invalid", keyFile: join(cwd, "jump-key") },
                },
                sshHops: [{ host: "inner.invalid", conn: { keyFile: "inner-key" } }],
            };
            expect(requests).toMatchObject([
                { method: "exec", params: { target: { descriptor: { config: { connParams: {
                    keyFile: join(cwd, "key"), knownHostsFile: join(cwd, "hosts"),
                } } } } } },
                { method: "exec", params: { target: { layer: "fixture", descriptor: { config: savedConfig } } } },
                { method: "batch", params: { savedLayers: { fixture: { config: savedConfig } } } },
            ]);
        } finally {
            await new Promise<void>((resolve) => stub.close(() => resolve()));
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("returns an explicit HTTP 413 for an oversized RPC body and stays available", async () => {
        const srv = new DaemonServer({ writeFiles: false });
        try {
            const addr = await srv.start();
            const client = new DaemonClient({ addr, token: srv.token });
            const rejection = client.rpc("cat", { path: "x".repeat(17 * 1024 * 1024) }, 5_000);
            await expect(rejection).rejects.toMatchObject({ statusCode: 413, message: expect.stringContaining("请求体超过限制") });
            await expect(rejection).rejects.not.toHaveProperty("outcome");
            expect(await client.health()).toBe(true);
        } finally {
            await srv.stop();
        }
    });

    test("shares a pending listen and does not reopen a stopped server instance", async () => {
        const srv = new DaemonServer({ writeFiles: false });
        const starting = srv.start();
        const secondStart = srv.start();
        const stopping = srv.stop();
        const [addr, secondAddr] = await Promise.all([starting, secondStart, stopping]);
        expect(secondAddr).toBe(addr);
        await expect(srv.start()).rejects.toThrow(/已停止或正在停止/);
        const client = new DaemonClient({ addr, token: srv.token });
        expect(await client.health()).toBe(false);
    });

    test("background launch rejects an already-running daemon instead of returning its PID as a new launch", async () => {
        const dir = makeTempDir("fx-daemon-existing-start-");
        const srv = new DaemonServer({ daemonDir: dir });
        try {
            const addr = await srv.start();
            await expect(spawnDaemonBackground({
                daemonDir: dir,
                cliEntryPath: resolvePath("bin/filaxis.ts"),
            })).rejects.toThrow(/Daemon 已在运行/);
            expect((await new DaemonClient({ addr, token: srv.token }).status()).pid).toBe(process.pid);
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("enforces Bearer auth (401) on protected endpoints while allowing /health", async () => {
        const dir = makeTempDir("fx-daemon-auth-");
        const srv = new DaemonServer({ daemonDir: dir, version: "test" });
        try {
            const addr = await srv.start();
            const unauth = await fetch(`${addr}/status`);
            expect(unauth.status).toBe(401);

            const wrongRpc = await fetch(`${addr}/rpc`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
                body: JSON.stringify({ method: "status" }),
            });
            expect(wrongRpc.status).toBe(401);

            const health = await fetch(`${addr}/health`);
            expect(health.status).toBe(200);
            expect(await health.json()).toEqual({ ok: true });

            const client = await probeDaemon(dir);
            expect(client).not.toBeNull();
            const status = await client!.status();
            expect(status.pid).toBe(process.pid);
            expect(status.addr).toBe(addr);
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("executes exec/cat/edit and cross-call stream open/peek/list/close", async () => {
        const dir = makeTempDir("fx-daemon-rpc-");
        const work = makeTempDir("fx-daemon-work-");
        const srv = new DaemonServer({ daemonDir: dir, version: "test" });
        try {
            const addr = await srv.start();
            const client = new DaemonClient({ addr, token: srv.token });

            const targetFile = join(work, "sample.txt");
            writeFileSync(targetFile, "hello old world\n", "utf-8");

            const catRes = await client.rpc<{ content: string }>("cat", { path: "sample.txt", target: { cwd: work } });
            expect(catRes.content).toBe("hello old world\n");

            const editRes = await client.rpc<{ occurrences: number }>("edit", {
                path: targetFile,
                old: "old",
                new: "new",
            });
            expect(editRes.occurrences).toBe(1);
            expect(readFileSync(targetFile, "utf-8")).toBe("hello new world\n");

            const execRes = await client.rpc<{ stdout: string; exitCode: number }>("exec", {
                command: "printf 'daemon-exec-ok'",
            });
            expect(execRes.exitCode).toBe(0);
            expect(execRes.stdout).toBe("daemon-exec-ok");

            const opened = await client.rpc<{
                window_id: string;
                frames: Array<{ seq: number; text: string }>;
                last_delivered_seq?: number;
            }>("stream.open", {
                command: "printf 'line1\\n'; sleep 0.2; printf 'line2\\n'",
                waitMs: 2000,
                limit: 20,
            });
            expect(opened.window_id).toBeTruthy();

            const listRes = await client.rpc<{ streams: Array<{ window_id: string }> }>("stream.list");
            expect(listRes.streams.some((s) => s.window_id === opened.window_id)).toBe(true);

            let cursor = opened.last_delivered_seq ?? 0;
            const collected = opened.frames.map((f) => f.text);
            const deadline = Date.now() + 4000;
            while (collected.length < 2 && Date.now() < deadline) {
                const peek = await client.rpc<{
                    frames: Array<{ seq: number; text: string }>;
                    last_delivered_seq?: number;
                }>("stream.peek", { windowId: opened.window_id, afterSeq: cursor, waitMs: 500 });
                for (const f of peek.frames) collected.push(f.text);
                cursor = peek.last_delivered_seq ?? cursor;
            }
            expect(collected).toEqual(["line1", "line2"]);

            const closed = await client.rpc<{ closed: boolean }>("stream.close", { windowId: opened.window_id });
            expect(closed.closed).toBe(true);
            await expect(client.rpc("stream.peek", { windowId: opened.window_id })).rejects.toThrow(/不存在或已关闭/);
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
            rmSync(work, { recursive: true, force: true });
        }
    }, 15_000);

    test("paginates and waits on the selected stream and retains the stale stream error", async () => {
        const observer = new MockChild();
        const spawnFixture = (() => observer) as unknown as typeof spawn;
        const registry = new StreamWindowRegistry({ shell: "fixture", spawnImpl: spawnFixture });
        const srv = new DaemonServer({ writeFiles: false, windowRegistry: registry });
        try {
            const addr = await srv.start();
            const client = new DaemonClient({ addr, token: srv.token });
            const win = await registry.open({ name: "mixed", command: "fixture" });
            win.push("out-1", "stdout");
            win.push("err-2", "stderr");
            win.push("out-3", "stdout");
            const peek = (cursors: Record<string, number> = {}) => client.rpc("stream.peek", {
                windowId: win.name, limit: 1, stream: "stderr", ...cursors,
            }, 8_000);
            const frames = [{ seq: 2, text: "err-2", stream: "stderr" }];
            await expect(peek()).resolves.toMatchObject({ frames });
            await expect(peek({ beforeSeq: 4 })).resolves.toMatchObject({ frames });
            await expect(peek({ afterSeq: 0 })).resolves.toMatchObject({ frames, last_delivered_seq: 2 });
            let readStarted!: () => void;
            const firstRead = new Promise<void>((resolve) => { readStarted = resolve; });
            const peekSince = win.peekSince.bind(win);
            win.peekSince = (...args) => {
                const result = peekSince(...args);
                readStarted();
                return result;
            };
            const waiting = peek({ afterSeq: 2, waitMs: 5_000 });
            await Promise.race([firstRead, waiting]);
            win.push("err-4", "stderr");
            await expect(waiting).resolves.toMatchObject({
                frames: [{ seq: 4, text: "err-4", stream: "stderr" }], last_delivered_seq: 4,
            });

            observer.kill("SIGTERM");
            win.markStale(null, "fixture connection closed");
            await expect(peek()).resolves.toMatchObject({
                stale: true, error: "fixture connection closed", frames: [{ seq: 4, text: "err-4" }],
            });
        } finally {
            if (observer.exitCode === null) observer.kill("SIGTERM");
            await srv.stop();
        }
    }, 15_000);

    test("forward remove exits unsuccessfully when the forward could not be confirmed closed", async () => {
        const dir = makeTempDir("fx-daemon-forward-unknown-");
        const srv = new DaemonServer({ daemonDir: dir });
        try {
            await srv.start();
            const driver = new SshPtyDriver({ driver: "ssh", target: "fixture.invalid" });
            driver.closeForward = async (forwardId) => ({ forwardId, status: "unknown", detail: "fixture unverified" });
            await srv.stack.addLayer("fixture", driver);
            const removed = await runCliAsync(["forward", "remove", "fwd-id", "--layer", "fixture", "--json"], dir);
            expect(removed.exitCode).toBe(1);
            expect(JSON.parse(removed.stdout)).toEqual({ forwardId: "fwd-id", status: "unknown", detail: "fixture unverified" });
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("manages forward.add / forward.list / forward.remove via Daemon RPC and cleans up on stop", async () => {
        const srv = new DaemonServer({ writeFiles: false, version: "test" });
        let childRef!: MockChild;
        try {
            const addr = await srv.start();
            const sshDriver = new SshPtyDriver({ driver: "ssh", target: "ops@example.com" }, {
                _forwardDeps: {
                    muxControlPath: () => undefined,
                    spawnSsh: () => {
                        childRef = new MockChild();
                        setTimeout(() => {
                            childRef.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port 18080.\ndebug1: Entering interactive session.\n");
                        }, 5);
                        return childRef as unknown as ChildProcess;
                    },
                },
            });
            await srv.stack.addLayer("prod", sshDriver);

            const client = new DaemonClient({ addr, token: srv.token });
            const added = await client.rpc<{ forwardId: string; bindPort: number; layer: string }>("forward.add", {
                target: { layer: "prod" },
                spec: { id: "db-fwd", kind: "L", bindPort: 18080, targetHost: "127.0.0.1", targetPort: 5432 },
            });
            expect(added.forwardId).toBe("db-fwd");
            expect(added.layer).toBe("prod");
            expect(added.bindPort).toBe(18080);

            const list = await client.rpc<{ forwards: Array<{ forwardId: string }> }>("forward.list", { layer: "prod" });
            expect(list.forwards.map((f) => f.forwardId)).toEqual(["db-fwd"]);

            const removed = await client.rpc<{ status: string }>("forward.remove", { forwardId: "db-fwd", layer: "prod" });
            expect(removed.status).toBe("stopped");
            expect(childRef.signals).toContain("SIGTERM");

            await client.rpc("forward.add", {
                target: { layer: "prod" },
                spec: { id: "detached", kind: "L", bindPort: 18080, targetHost: "127.0.0.1", targetPort: 5432 },
            });
            await client.rpc("layer.remove", { name: "prod" });
            expect(srv.stack.layers.has("prod")).toBe(false);
            const detached = await client.rpc<{ forwards: Array<{ forwardId: string; layer?: string }> }>("forward.list");
            expect(detached.forwards.map((f) => f.forwardId)).toEqual(["detached"]);
            expect(detached.forwards[0]).not.toHaveProperty("layer");
            expect(childRef.signals).toEqual([]);
            await srv.stop();
            expect(childRef.signals).toContain("SIGTERM");
        } finally {
            await srv.stop();
        }
    }, 15_000);

    test("stops a forward still being established on an unnamed driver during shutdown", async () => {
        const srv = new DaemonServer({ writeFiles: false });
        let started!: () => void;
        const childStarted = new Promise<void>((resolve) => { started = resolve; });
        const child = new MockChild();
        const driver = new SshPtyDriver({ driver: "ssh", target: "fixture.invalid" }, {
            _forwardDeps: {
                muxControlPath: () => undefined,
                spawnSsh: () => { started(); return child as unknown as ChildProcess; },
            },
        });
        try {
            await srv.start();
            await srv.stack.addLayer("pending", driver);
            const opening = srv.stack.openForward({
                id: "pending", kind: "L", bindPort: 18101, targetHost: "127.0.0.1", targetPort: 8080,
            });
            void opening.catch(() => undefined);
            await childStarted;
            await srv.stack.removeLayer("pending");
            await srv.stop();
            expect(child.signals).toContain("SIGTERM");
            await expect(opening).rejects.toThrow();
        } finally {
            await srv.stop();
            await driver.destroy();
        }
    }, 15_000);
});

describe("CLI daemon / forward / stream E2E", () => {
    test("never spawns daemon implicitly and errors cleanly on forward/stream without daemon", () => {
        const dir = makeTempDir("fx-cli-nod-");
        try {
            const execRes = runCli(["exec", "--", "printf 'single-shot'"], dir);
            expect(execRes.exitCode).toBe(0);
            expect(execRes.stdout.toString()).toBe("single-shot");
            const { lockFile, addrFile, tokenFile } = daemonPaths(dir);
            expect(existsSync(lockFile)).toBe(false);
            expect(existsSync(addrFile)).toBe(false);
            expect(existsSync(tokenFile)).toBe(false);

            const fwdRes = runCli(["forward", "list"], dir);
            expect(fwdRes.exitCode).toBe(1);
            expect(fwdRes.stderr.toString()).toContain("filaxis daemon start");

            const streamRes = runCli(["stream", "peek", "win-1"], dir);
            expect(streamRes.exitCode).toBe(1);
            expect(streamRes.stderr.toString()).toContain("filaxis daemon start");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test("supports explicit daemon start -> status -> exec/no-daemon -> stream -> stop", () => {
        const dir = makeTempDir("fx-cli-e2e-");
        mkdirSync(dir, { recursive: true });
        try {
            const startRes = runCli(["daemon", "start", "--json"], dir);
            expect(startRes.exitCode).toBe(0);
            const startJson = JSON.parse(startRes.stdout.toString()) as { running: boolean; pid: number; addr: string };
            expect(startJson.running).toBe(true);
            expect(startJson.pid).toBeGreaterThan(0);

            const statusRes = runCli(["daemon", "status", "--json"], dir);
            expect(statusRes.exitCode).toBe(0);
            const statusJson = JSON.parse(statusRes.stdout.toString()) as { running: boolean; pid: number };
            expect(statusJson.running).toBe(true);
            expect(statusJson.pid).toBe(startJson.pid);

            const execViaDaemon = runCli(["exec", "--", "printf 'via-daemon'"], dir);
            expect(execViaDaemon.exitCode).toBe(0);
            expect(execViaDaemon.stdout.toString()).toBe("via-daemon");

            const execBypass = runCli(["exec", "--no-daemon", "--", "printf 'bypass-daemon'"], dir);
            expect(execBypass.exitCode).toBe(0);
            expect(execBypass.stdout.toString()).toBe("bypass-daemon");

            const openRes = runCli(["stream", "open", "--wait", "2000", "--json", "--", "printf 's1\\ns2\\n'"], dir);
            expect(openRes.exitCode).toBe(0);
            const openJson = JSON.parse(openRes.stdout.toString()) as {
                window_id: string;
                frames: Array<{ seq: number; text: string }>;
                last_delivered_seq?: number;
            };
            expect(openJson.window_id).toBeTruthy();

            const peekRes = runCli(["stream", "peek", openJson.window_id, "--after", "0", "--wait", "2000", "--json"], dir);
            expect(peekRes.exitCode).toBe(0);
            const peekJson = JSON.parse(peekRes.stdout.toString()) as { frames: Array<{ text: string }> };
            expect(peekJson.frames.map((f) => f.text)).toEqual(["s1", "s2"]);

            const closeRes = runCli(["stream", "close", openJson.window_id, "--json"], dir);
            expect(closeRes.exitCode).toBe(0);

            const stopRes = runCli(["daemon", "stop", "--json"], dir);
            expect(stopRes.exitCode).toBe(0);
            const stopJson = JSON.parse(stopRes.stdout.toString()) as { stopped: boolean };
            expect(stopJson.stopped).toBe(true);

            expect(readDaemonConnection(dir)).toBeNull();
            const afterStop = runCli(["daemon", "status", "--json"], dir);
            expect(afterStop.exitCode).toBe(1);
        } finally {
            try {
                const conn = readDaemonConnection(dir);
                if (conn?.lock?.pid) {
                    try { process.kill(conn.lock.pid, "SIGTERM"); } catch { /* ignore */ }
                }
                cleanupDaemonFiles(dir);
            } catch { /* ignore */ }
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);

    test("enforces loopback bind, deduplicates concurrent first local exec, and honors target.cwd in batch/stream", async () => {
        const dir = makeTempDir("fx-daemon-hardening-");
        const work = makeTempDir("fx-daemon-cwd-");
        expect(() => new DaemonServer({ daemonDir: dir, host: "0.0.0.0" })).toThrow(/仅允许绑定本地回环/);

        writeFileSync(join(work, "cwd-marker.txt"), "hello-cwd", "utf-8");
        const srv = new DaemonServer({ daemonDir: dir, version: "test" });
        try {
            const addr = await srv.start();
            const client = new DaemonClient({ addr, token: srv.token });

            // Concurrent first requests to local layer must not collide in RuntimeStack.addLayer
            const [e1, e2] = await Promise.all([
                client.rpc<{ stdout: string; exitCode: number }>("exec", { command: "printf 'c1'" }),
                client.rpc<{ stdout: string; exitCode: number }>("exec", { command: "printf 'c2'" }),
            ]);
            expect(e1.stdout).toBe("c1");
            expect(e2.stdout).toBe("c2");

            // batch honors client target.cwd for relative paths
            const batchRes = await client.rpc<{ status: string; steps: Array<{ stdout?: string }> }>("batch", {
                target: { descriptor: { driver: "local" }, cwd: work },
                plan: { steps: [{ id: "r1", kind: "read", path: "cwd-marker.txt" }] },
            });
            expect(batchRes.status).toBe("ok");
            expect(batchRes.steps[0]?.stdout).toBe("hello-cwd");

            // stream.open honors client target.cwd
            const stRes = await client.rpc<{ window_id: string; frames: Array<{ text: string }> }>("stream.open", {
                target: { descriptor: { driver: "local" }, cwd: work },
                command: "cat cwd-marker.txt",
                waitMs: 2000,
            });
            expect(stRes.frames.map((f) => f.text)).toContain("hello-cwd");
            await client.rpc("stream.close", { windowId: stRes.window_id });
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
            rmSync(work, { recursive: true, force: true });
        }
    }, 15_000);

    test("CLI forward add accepts omitted bindPort (-L host:port, -D with no port) and rejects invalid specs", async () => {
        const dir = makeTempDir("fx-cli-fwd-omit-");
        const srv = new DaemonServer({ daemonDir: dir, version: "test" });
        try {
            await srv.start();
            const sshDriver = new SshPtyDriver({ driver: "ssh", target: "ops@example.com" }, {
                _forwardDeps: {
                    muxControlPath: () => undefined,
                    allocateLocalPort: async () => 54321,
                    spawnSsh: () => {
                        const child = new MockChild();
                        setTimeout(() => {
                            child.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port 54321.\ndebug1: Entering interactive session.\n");
                        }, 5);
                        return child as unknown as ChildProcess;
                    },
                },
            });
            await srv.stack.addLayer("prod", sshDriver);

            const okL = await runCliAsync(["forward", "add", "--layer", "prod", "-L", "127.0.0.1:5432", "--json"], dir);
            expect(okL.exitCode).toBe(0);
            const infoL = JSON.parse(okL.stdout) as { kind: string; bindPort: number; targetHost: string; targetPort: number };
            expect(infoL).toMatchObject({ kind: "local", bindPort: 54321, targetHost: "127.0.0.1", targetPort: 5432 });

            const okD = await runCliAsync(["forward", "add", "--layer", "prod", "-D", "--json"], dir);
            expect(okD.exitCode).toBe(0);
            const infoD = JSON.parse(okD.stdout) as { kind: string; bindPort: number };
            expect(infoD).toMatchObject({ kind: "dynamic", bindPort: 54321 });

            const badD = await runCliAsync(["forward", "add", "--layer", "prod", "-D", "-1"], dir);
            expect(badD.exitCode).toBe(1);
            expect(badD.stderr).toContain("端口");

            const badAuto = await runCliAsync(["forward", "add", "--layer", "prod", "-L", "auto:127.0.0.1:5432"], dir);
            expect(badAuto.exitCode).toBe(1);
            expect(badAuto.stderr).toContain("端口必须是数字");
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    test("resolves relative batch localPath against CLI caller cwd rather than daemon cwd for put and get", async () => {
        const daemonDir = makeTempDir("fx-daemon-batch-dir-");
        const daemonCwd = makeTempDir("fx-daemon-cwd-b-");
        const callerCwd = makeTempDir("fx-caller-cwd-b-");
        const remoteDir = makeTempDir("fx-remote-cwd-b-");
        writeFileSync(join(daemonCwd, "input.txt"), "FROM_DAEMON_CWD", "utf-8");
        writeFileSync(join(callerCwd, "input.txt"), "FROM_CALLER_CWD", "utf-8");

        const cliEntry = resolvePath("bin/filaxis.ts");
        const fgChild = spawn(process.execPath, [cliEntry, "daemon", "start", "--foreground", "--daemon-dir", daemonDir], {
            cwd: daemonCwd,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, FILAXIS_DAEMON_DIR: daemonDir },
        });
        try {
            let client: DaemonClient | null = null;
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline && !client) {
                client = await probeDaemon(daemonDir, 300);
                if (!client) await new Promise((r) => setTimeout(r, 80));
            }
            expect(client).not.toBeNull();

            const remoteTarget = join(remoteDir, "uploaded.txt").replace(/\\/g, "/");
            const planFile = join(callerCwd, "plan.json");
            writeFileSync(planFile, JSON.stringify({
                steps: [
                    { id: "up", kind: "put", localPath: "input.txt", remotePath: remoteTarget },
                    { id: "down", kind: "get", localPath: "downloaded.txt", remotePath: remoteTarget, after: ["up"] },
                ],
            }), "utf-8");

            const batchRes = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
                const c = spawn(process.execPath, [cliEntry, "batch", "--daemon-dir", daemonDir, "--request-file", "plan.json"], {
                    cwd: callerCwd,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true,
                    env: { ...process.env, FILAXIS_DAEMON_DIR: daemonDir },
                });
                let stdout = "";
                let stderr = "";
                c.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
                c.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
                c.once("error", reject);
                c.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
            });
            expect(batchRes.exitCode).toBe(0);
            expect(readFileSync(join(remoteDir, "uploaded.txt"), "utf-8")).toBe("FROM_CALLER_CWD");
            expect(readFileSync(join(callerCwd, "downloaded.txt"), "utf-8")).toBe("FROM_CALLER_CWD");
            expect(existsSync(join(daemonCwd, "downloaded.txt"))).toBe(false);
        } finally {
            try { fgChild.kill("SIGTERM"); } catch { /* ignore */ }
            await new Promise((r) => setTimeout(r, 150));
            cleanupDaemonFiles(daemonDir);
            rmSync(daemonDir, { recursive: true, force: true });
            rmSync(daemonCwd, { recursive: true, force: true });
            rmSync(callerCwd, { recursive: true, force: true });
            rmSync(remoteDir, { recursive: true, force: true });
        }
    }, 30_000);

    test("updates cached named layer when saved descriptor changes and rejects conflict with active forward", async () => {
        const dir = makeTempDir("fx-daemon-layer-upd-");
        const dirA = makeTempDir("fx-layer-a-");
        const dirB = makeTempDir("fx-layer-b-");
        writeFileSync(join(dirA, "marker.txt"), "from-A", "utf-8");
        writeFileSync(join(dirB, "marker.txt"), "from-B", "utf-8");

        const srv = new DaemonServer({ daemonDir: dir, version: "test" });
        try {
            const addr = await srv.start();
            const client = new DaemonClient({ addr, token: srv.token });

            // 1) Initial named layer points to dirA
            const c1 = await client.rpc<{ content: string }>("cat", {
                target: { layer: "app", descriptor: { driver: "local", cwd: dirA } },
                path: "marker.txt",
            });
            expect(c1.content).toBe("from-A");

            // 2) Updated descriptor points to dirB -> Daemon replaces stale layer handle
            const c2 = await client.rpc<{ content: string }>("cat", {
                target: { layer: "app", descriptor: { driver: "local", cwd: dirB } },
                path: "marker.txt",
            });
            expect(c2.content).toBe("from-B");

            // 3) batch savedLayers also honors updated descriptor for an already-cached layer
            const b1 = await client.rpc<{ status: string; steps: Array<{ stdout?: string }> }>("batch", {
                savedLayers: { app: { driver: "local", cwd: dirA } },
                plan: { steps: [{ id: "r", kind: "read", layer: "app", path: "marker.txt" }] },
            });
            expect(b1.status).toBe("ok");
            expect(b1.steps[0]?.stdout).toBe("from-A");

            // 4) Pending and confirmed forwards both keep their layer addressable.
            let childStarted!: (child: MockChild) => void;
            const started = new Promise<MockChild>((resolve) => { childStarted = resolve; });
            const sshOld = new SshPtyDriver({ driver: "ssh", target: "ops@old.example" }, {
                _forwardDeps: {
                    muxControlPath: () => undefined,
                    spawnSsh: () => {
                        const c = new MockChild();
                        childStarted(c);
                        return c as unknown as ChildProcess;
                    },
                },
            });
            await srv.stack.addLayer("tun-layer", sshOld);
            const opening = client.rpc<{ forwardId: string }>("forward.add", {
                target: { layer: "tun-layer" },
                spec: { kind: "L", bindPort: 18111, targetHost: "db", targetPort: 5432 },
            });
            void opening.catch(() => undefined);
            const child = await started;
            const replaceLayer = () => client.rpc("cat", {
                target: { layer: "tun-layer", descriptor: { driver: "local", cwd: dirA } },
                path: "marker.txt",
            });
            try {
                await expect(replaceLayer()).rejects.toThrow(/拒绝静默覆盖/);
            } finally {
                child.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port 18111.\ndebug1: Entering interactive session.\n");
            }
            const { forwardId } = await opening;
            await expect(replaceLayer()).rejects.toThrow(/拒绝静默覆盖/);

            await expect(client.rpc("forward.remove", { forwardId })).resolves.toMatchObject({ status: "stopped" });
            await expect(replaceLayer()).resolves.toEqual({ content: "from-A" });
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
            rmSync(dirA, { recursive: true, force: true });
            rmSync(dirB, { recursive: true, force: true });
        }
    }, 15_000);

    test("supports IPv6 loopback [::1] for DaemonServer and DaemonClient", async () => {
        const dir = makeTempDir("fx-daemon-ipv6-");
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
            const client = new DaemonClient({ addr: srv.addr, token: srv.token });
            expect(await client.health()).toBe(true);
            expect((await client.status()).version).toBe("ipv6");
            const r = await client.rpc<{ stdout: string; exitCode: number }>("exec", { command: "printf 'v6-ok'" });
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toBe("v6-ok");
        } finally {
            await srv.stop().catch(() => undefined);
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("[P1] rejects concurrent same-name layer requests with conflicting descriptors", async () => {
        const dir = makeTempDir("fx-daemon-conc-conflict-");
        const dirA = makeTempDir("fx-conc-a-");
        const dirB = makeTempDir("fx-conc-b-");
        writeFileSync(join(dirA, "marker.txt"), "from-A", "utf-8");
        writeFileSync(join(dirB, "marker.txt"), "from-B", "utf-8");

        const srv = new DaemonServer({ daemonDir: dir, version: "test" });
        let releaseGate!: () => void;
        const firstEntered = new Promise<void>((r) => {
            const origAddLayer = srv.stack.addLayer.bind(srv.stack);
            const gate = new Promise<void>((res) => { releaseGate = res; });
            srv.stack.addLayer = async (name, desc, opts) => {
                if (name === "race-app") {
                    r();
                    await gate;
                }
                return origAddLayer(name, desc, opts);
            };
        });

        try {
            const addr = await srv.start();
            const client = new DaemonClient({ addr, token: srv.token });

            const p1 = client.rpc<{ content: string }>("cat", {
                target: { layer: "race-app", descriptor: { driver: "local", cwd: dirA } },
                path: "marker.txt",
            });
            await firstEntered;

            const p2 = client.rpc<{ content: string }>("cat", {
                target: { layer: "race-app", descriptor: { driver: "local", cwd: dirB } },
                path: "marker.txt",
            });
            await expect(p2).rejects.toThrow(/并发注册|拒绝合并/);

            releaseGate();
            expect((await p1).content).toBe("from-A");
        } finally {
            releaseGate?.();
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
            rmSync(dirA, { recursive: true, force: true });
            rmSync(dirB, { recursive: true, force: true });
        }
    }, 15_000);

    test("[P1] explicit CLI targets preserve existing MCP default layer and leave empty activeLayer unset", async () => {
        const dir = makeTempDir("fx-daemon-active-preserve-");
        const dirA = makeTempDir("fx-active-a-");
        const dirB = makeTempDir("fx-active-b-");
        writeFileSync(join(dirA, "who.txt"), "MCP_DEFAULT_A", "utf-8");
        writeFileSync(join(dirB, "who.txt"), "CLI_EXPLICIT_B", "utf-8");

        const srv = new DaemonServer({ daemonDir: dir, version: "test" });
        try {
            const addr = await srv.start();
            const client = new DaemonClient({ addr, token: srv.token });

            // 1) Even when activeLayer starts undefined, explicit ephemeral CLI target does not hijack it
            const eph1 = await client.rpc<{ content: string }>("cat", {
                target: { descriptor: { driver: "local", cwd: dirB } },
                path: "who.txt",
            });
            expect(eph1.content).toBe("CLI_EXPLICIT_B");
            expect(srv.stack.activeLayer).toBeUndefined();

            // 2) MCP establishes default layer "mcp-default"
            await srv.stack.addLayer("mcp-default", { driver: "local", cwd: dirA });
            expect(srv.stack.activeLayer?.name).toBe("mcp-default");

            // 3) Explicit CLI named and ephemeral calls must NOT switch activeLayer away from "mcp-default"
            const cliNamed = await client.rpc<{ content: string }>("cat", {
                target: { layer: "cli-other", descriptor: { driver: "local", cwd: dirB } },
                path: "who.txt",
            });
            expect(cliNamed.content).toBe("CLI_EXPLICIT_B");
            expect(srv.stack.activeLayer?.name).toBe("mcp-default");

            const mcpRead = await srv.toolkit.handlers.read_path({ path: "who.txt" });
            expect(mcpRead).toMatchObject({ type: "file", content: "MCP_DEFAULT_A" });
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
            rmSync(dirA, { recursive: true, force: true });
            rmSync(dirB, { recursive: true, force: true });
        }
    }, 15_000);

    test("[P2] probeDaemon returns null on invalid daemon.addr and CLI falls back to single-shot execution", async () => {
        const dir = makeTempDir("fx-daemon-bad-addr-");
        try {
            acquireDaemonLock(dir, "0.2.11");
            const paths = daemonPaths(dir);
            writePrivateFileAtomic(paths.addrFile, "not-a-valid-addr");
            writePrivateFileAtomic(paths.tokenFile, generateDaemonToken());

            expect(await probeDaemon(dir)).toBeNull();
            const res = runCli(["exec", "--", "printf 'standalone-fallback-ok'"], dir);
            expect(res.exitCode).toBe(0);
            expect(res.stdout.toString()).toBe("standalone-fallback-ok");
        } finally {
            cleanupDaemonFiles(dir);
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("[P1] implicit local CLI commands never hijack a user-registered SSH layer named 'local'", async () => {
        const dir = makeTempDir("fx-daemon-local-clash-");
        const srv = new DaemonServer({ daemonDir: dir, version: "test" });
        try {
            const addr = await srv.start();
            const fakeSsh = {
                descriptor: { driver: "ssh", target: "ops@ssh-named-local" },
                fs: {
                    readFile: async () => "SSH_LOCAL_FS",
                    writeFile: async () => undefined,
                    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
                    readdir: async () => [],
                    mkdir: async () => undefined,
                    rename: async () => undefined,
                    rm: async () => undefined,
                },
                exec: async () => ({ stdout: "FROM_SSH_NAMED_LOCAL", stderr: "", exitCode: 0 }),
                execSession: async () => { throw new Error("unused"); },
                tailSession: async () => [],
                readSessionLog: async () => "",
                watchSession: () => ({ cancel: () => undefined }),
                stopSession: async () => ({ status: "stopped" as const }),
                verifySession: async () => ({ status: "exited" as const, exitCode: 0 }),
                listSessions: () => [],
                getCwd: async () => "/",
                getEnv: async () => undefined,
                init: async () => undefined,
                destroy: async () => undefined,
            };
            await srv.stack.addLayer("local", fakeSsh as never);

            const client = new DaemonClient({ addr, token: srv.token });
            // Implicit local (no target, or descriptor.driver === "local" without target.layer) executes locally, NOT on SSH "local"
            const r1 = await client.rpc<{ stdout: string; exitCode: number }>("exec", { command: "printf 'REAL_LOCAL_1'" });
            expect(r1.exitCode).toBe(0);
            expect(r1.stdout).toBe("REAL_LOCAL_1");

            const r2 = await client.rpc<{ stdout: string; exitCode: number }>("exec", {
                target: { descriptor: { driver: "local" } },
                command: "printf 'REAL_LOCAL_2'",
            });
            expect(r2.exitCode).toBe(0);
            expect(r2.stdout).toBe("REAL_LOCAL_2");

            // Explicit target: { layer: "local" } intentionally targets the registered layer named "local"
            const r3 = await client.rpc<{ stdout: string; exitCode: number }>("exec", {
                target: { layer: "local" },
                command: "printf 'IGNORED'",
            });
            expect(r3.stdout).toBe("FROM_SSH_NAMED_LOCAL");
            await expect(client.rpc("forward.add", {
                spec: { kind: "D", bindPort: 0 },
            })).rejects.toMatchObject({ message: "层 'local' (local) 不支持动态端口转发" });

            const stream = await client.rpc<{ window_id: string }>("stream.open", {
                command: "printf 'implicit-local-log\\n'",
                waitMs: 2_000,
            });
            try {
                await expect(client.rpc("exec", {
                    target: { layer: "local", descriptor: { driver: "local" } },
                    command: "printf 'NEW_NAMED_LOCAL'",
                })).resolves.toMatchObject({ stdout: "NEW_NAMED_LOCAL", exitCode: 0 });
            } finally {
                await client.rpc("stream.close", { windowId: stream.window_id });
            }
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    test("[P2] RPC mid-flight socket drop preserves error and tags outcome='unknown'", async () => {
        const dir = makeTempDir("fx-daemon-rpc-drop-");
        const stub = http.createServer((req, res) => {
            if (req.method === "GET" && req.url === "/status") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: {} }));
                return;
            }
            req.on("data", () => undefined);
            req.on("end", () => {
                req.socket.destroy();
            });
        });
        await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", () => resolve()));
        const port = (stub.address() as { port: number }).port;
        try {
            const client = new DaemonClient({ addr: `127.0.0.1:${port}`, token: "tok" });
            let caught: (Error & { outcome?: unknown; code?: unknown }) | undefined;
            try {
                await client.rpc("exec", { command: "echo may-have-ran" });
            } catch (e) {
                caught = e as Error & { outcome?: unknown; code?: unknown };
            }
            expect(caught).toBeInstanceOf(Error);
            expect(caught?.outcome).toBe("unknown");

            const paths = daemonPaths(dir);
            writePrivateFileAtomic(paths.addrFile, `127.0.0.1:${port}`);
            writePrivateFileAtomic(paths.tokenFile, "tok");
            const cli = Bun.spawn([process.execPath, "bin/filaxis.ts", "exec", "--", "printf should-not-replay"], {
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                windowsHide: true,
                env: { ...process.env, FILAXIS_DAEMON_DIR: dir },
            });
            const [exitCode, stdout, stderr] = await Promise.all([
                cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text(),
            ]);
            expect(exitCode).toBe(1);
            expect(stdout).toBe("");
            expect(stderr).toContain("outcome=unknown");
        } finally {
            await new Promise<void>((resolve) => stub.close(() => resolve()));
            rmSync(dir, { recursive: true, force: true });
        }
    }, 10_000);

    test("preserves confirmed RPC errors without marking their outcome unknown", async () => {
        const srv = new DaemonServer({ writeFiles: false });
        try {
            const addr = await srv.start();
            const client = new DaemonClient({ addr, token: srv.token });
            const rejection = client.rpc("cat", {});
            await expect(rejection).rejects.toThrow("cat 缺少 path 参数");
            await expect(rejection).rejects.not.toHaveProperty("outcome");

            const unauthorized = new DaemonClient({ addr, token: "wrong-token" });
            const rejectedAuth = unauthorized.rpc("exec", {});
            await expect(rejectedAuth).rejects.toThrow("HTTP 401");
            await expect(rejectedAuth).rejects.not.toHaveProperty("outcome");

            const driver = new LocalRuntimeDriver();
            const failure = Object.assign(new Error("fixture command interrupted"), {
                name: "AbortError", code: "ABORT_ERR", outcome: "unknown", partialOutput: "fixture output",
            });
            driver.exec = async () => { throw failure; };
            await srv.stack.addLayer("fixture", driver);
            await expect(client.rpc("exec", {
                target: { layer: "fixture" }, command: "fixture",
            })).rejects.toMatchObject({
                name: failure.name, code: failure.code, outcome: failure.outcome, partialOutput: failure.partialOutput,
            });

            driver.exec = async () => { throw { toString: () => "internal error details" }; };
            await expect(client.rpc("exec", {
                target: { layer: "fixture" }, command: "fixture",
            })).rejects.toMatchObject({ message: "Daemon RPC 执行失败" });
        } finally {
            await srv.stop();
        }
    });

    test("explicit descriptors keep selecting their target after a shared layer name is replaced", async () => {
        const dir = makeTempDir("fx-daemon-ephemeral-replace-");
        const first = join(dir, "first");
        const second = join(dir, "second");
        mkdirSync(first);
        mkdirSync(second);
        writeFileSync(join(first, "marker.txt"), "first");
        writeFileSync(join(second, "marker.txt"), "second");
        const srv = new DaemonServer({ writeFiles: false });
        try {
            const addr = await srv.start();
            const client = new DaemonClient({ addr, token: srv.token });
            const target = { descriptor: { driver: "local", cwd: first } };
            const read = (targetSpec: Record<string, unknown>) => client.rpc<{ content: string }>(
                "cat", { target: targetSpec, path: "marker.txt" },
            );
            expect((await read(target)).content).toBe("first");
            const [layer] = (await client.status()).layers;
            if (!layer) throw new Error("Expected the descriptor to register a layer");
            const { name } = layer;
            expect((await read({ layer: name, descriptor: { driver: "local", cwd: second } })).content).toBe("second");
            expect((await read(target)).content).toBe("first");
            expect((await read({ layer: name })).content).toBe("second");
        } finally {
            await srv.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("[P2] parseAddrToUrl & urlRequestPort accept explicit default HTTP port :80 and :443 while rejecting portless hosts", () => {
        expect(urlRequestPort(parseAddrToUrl("127.0.0.1:80"))).toBe(80);
        expect(urlRequestPort(parseAddrToUrl("http://127.0.0.1:80"))).toBe(80);
        expect(urlRequestPort(parseAddrToUrl("[::1]:80"))).toBe(80);
        expect(urlRequestPort(parseAddrToUrl("https://127.0.0.1:443"))).toBe(443);
        expect(urlRequestPort(parseAddrToUrl("127.0.0.1:8080"))).toBe(8080);

        expect(() => parseAddrToUrl("127.0.0.1")).toThrow(/非法 Daemon 监听地址/);
        expect(() => parseAddrToUrl("http://127.0.0.1")).toThrow(/非法 Daemon 监听地址/);
        expect(() => parseAddrToUrl("[::1]")).toThrow(/非法 Daemon 监听地址/);
    });
});
