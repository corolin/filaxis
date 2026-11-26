/**
 * SSH 真机集成（CI 专用——环境门控 FILAXIS_IT=1 才跑；本机/常规 bun test 自动跳过）
 *
 * CI 形态（.github/workflows/ci.yml）：ubuntu runner 自环 ssh localhost
 * （ed25519 免密）+ tmux——覆盖 AC-02/AC-04 远端面：PtyLink 建链握手、
 * exec 双通道 stderr 分离、层内 cwd/env、远端会话 .code 终态、文件传输双校验。
 */
import { describe, expect, test } from "bun:test";
import { SshPtyDriver } from "../src/ssh-pty-driver.js";
import { StreamSessionManager } from "../src/stream-session-manager.js";
import { putFile, getFile } from "../src/file-transfer.js";
import { transferLayerFile } from "../src/index.js";
import { probeDialect } from "../src/dialect.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { shellQuote } from "../src/ssh-helpers.js";
import { RuntimeStack } from "../src/operations/runtime-stack.js";
import { StreamWindowRegistry } from "../src/stream-window.js";

const IT = process.env.FILAXIS_IT === "1";
const TARGET = process.env.FILAXIS_IT_SSH || "localhost";
const integration = IT ? test : test.skip;
const jumpIntegration = IT && (TARGET === "localhost" || process.env.FILAXIS_IT_JUMP) ? test : test.skip;
const dockerIntegration = IT && (TARGET === "localhost" || process.env.FILAXIS_IT_DOCKER === "1") ? test : test.skip;

async function verifyFileStdioLayer(jump?: string): Promise<void> {
    const original = process.env.FILAXIS_SSH_STDIO_MODE;
    process.env.FILAXIS_SSH_STDIO_MODE = "inherit";
    const stack = new RuntimeStack();
    const name = "file-stdio";
    try {
        const { handle } = await stack.addLayer(name, {
            driver: "ssh", target: TARGET, cwd: "/tmp",
            ...(jump ? { config: { connParams: { jump } } } : {}),
        });
        const { driver } = handle;
        expect(await driver.exec("pwd; printf diagnostic >&2; exit 7", { timeoutMs: 15_000 })).toMatchObject({
            stdout: "/tmp\n", stderr: "diagnostic", exitCode: 7, effectiveUser: expect.any(String),
        });
        await expect(driver.exec(":", { channel: "pty" })).rejects.toThrow(/inherit.*交互 PTY/);
        await expect(driver.openStreamWindow!(new StreamWindowRegistry(), { name: "fixture", command: "pwd" })).rejects.toThrow(/inherit.*持续观察窗/);
    } finally {
        try { if (stack.layers.has(name)) await stack.removeLayer(name, { destroy: true }); }
        finally {
            if (original === undefined) delete process.env.FILAXIS_SSH_STDIO_MODE;
            else process.env.FILAXIS_SSH_STDIO_MODE = original;
        }
    }
}

integration("file stdio registers a direct named layer and executes without a PTY", () => verifyFileStdioLayer(), 30_000);

integration("bounded SSH capture keeps both streams and the completion sentinel in pipe and file modes", async () => {
    const saved = process.env.FILAXIS_SSH_STDIO_MODE;
    try {
        for (const fileMode of [false, true]) {
            if (fileMode) process.env.FILAXIS_SSH_STDIO_MODE = "inherit";
            else delete process.env.FILAXIS_SSH_STDIO_MODE;
            const driver = new SshPtyDriver({ driver: "ssh", target: TARGET });
            try {
                const result = await driver.exec(`printf 'ab🧵'; head -c 1048576 /dev/zero; printf 'stderr-marker' >&2; head -c 1048576 /dev/zero >&2; exit 7`, { maxOutputBytes: 3 });
                expect(result.exitCode).toBe(7);
                expect(result.stdout).toBe("ab\n[采集阶段已截断 1048580 字节]");
                expect(result.stderr).toContain("std\n[采集阶段已截断");
                expect(result.effectiveUser).toBeTruthy();
                const lateOutput = await driver.exec(
                    "printf before; (sleep 0.2; head -c 65536 /dev/zero) & exit 9",
                    { maxOutputBytes: 16 },
                );
                expect(lateOutput).toMatchObject({ exitCode: 9, stdout: "before" });
            } finally { await driver.destroy(); }
        }
    } finally {
        if (saved === undefined) delete process.env.FILAXIS_SSH_STDIO_MODE;
        else process.env.FILAXIS_SSH_STDIO_MODE = saved;
    }
}, 45_000);
jumpIntegration("file stdio registers a named layer through a TCP jump", () =>
    verifyFileStdioLayer(process.env.FILAXIS_IT_JUMP ?? "127.0.0.1"), 60_000);

test.skipIf(!IT || process.platform !== "win32")("Windows SSH file stdio works with missing system and account variables", async () => {
    const keys = ["SystemRoot", "windir", "SystemDrive", "ProgramData", "ALLUSERSPROFILE", "USERNAME", "USERPROFILE"];
    const previous = new Map(keys.map((name) => [name, process.env[name]]));
    try {
        for (const name of keys) delete process.env[name];
        await verifyFileStdioLayer();
        for (const name of keys) expect(process.env[name]).toBeUndefined();
    } finally {
        for (const [name, value] of previous) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}, 30_000);

integration("SSH rejects a broken PTY cwd and distinguishes an empty directory from a failed listing", async () => {
    const path = `/tmp/fx-session-cwd-${randomUUID()}`;
    const bad = new SshPtyDriver({ driver: "ssh", target: TARGET, cwd: path });
    try { await expect(bad.init()).rejects.toThrow(/无法进入工作目录/); }
    finally { await bad.destroy(); }
    const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
    try {
        await drv.init();
        await expect(drv.fs.readdir(path)).rejects.toThrow(/readdir/);
        await drv.fs.mkdir(path);
        expect(await drv.fs.readdir(path)).toEqual([]);
        const name = "one\nentry";
        expect((await drv.exec(`touch ${shellQuote(`${path}/${name}`)}`)).exitCode).toBe(0);
        expect((await drv.exec(`cd ${shellQuote(path)} && mkdir .nested || exit 1; i=0; ` +
            `while [ "$i" -lt 32 ]; do touch "entry-$i" || exit 1; i=$((i+1)); done`)).exitCode).toBe(0);
        const entries = await drv.fs.readdir(path);
        expect(entries).toHaveLength(34);
        expect(entries.find((entry) => entry.name === name)).toMatchObject({ isDirectory: false, size: 0 });
        expect(entries.find((entry) => entry.name === ".nested")).toMatchObject({ isDirectory: true });
        const scoped = new SshPtyDriver({ driver: "ssh", target: TARGET, cwd: path });
        try {
            expect((await scoped.exec("printf fixture > ./-literal")).exitCode).toBe(0);
            expect(await scoped.fs.stat?.("-literal")).toMatchObject({ size: 7 });
            expect(await scoped.fs.readFile("-literal")).toBe("fixture");
            expect((await scoped.exec("ln -s ./-literal alias-to-file")).exitCode).toBe(0);
            expect(await scoped.fs.stat?.("alias-to-file")).toMatchObject({ size: 7 });
            expect(await scoped.fs.readFile("alias-to-file")).toBe("fixture");
            await scoped.fs.rm("-literal");
            expect(await scoped.fs.exists("-literal")).toBe(false);
            await expect(scoped.fs.rm(".nested")).rejects.toThrow(/rm 失败/);
        } finally {
            await scoped.destroy();
        }
    } finally {
        await drv.fs.rm(path, { recursive: true, force: true });
        await drv.destroy();
    }
}, 25_000);

integration("SSH recovery and stop keep a background child in the session after its shell exits", async () => {
    const first = new SshPtyDriver({ driver: "ssh", target: TARGET });
    const second = new SshPtyDriver({ driver: "ssh", target: TARGET });
    let handle: Awaited<ReturnType<typeof first.execSession>> | undefined;
    try {
        await first.init();
        await second.init();
        handle = await first.execSession("sleep 20 >/dev/null 2>&1 & echo $!; exit 37");
        let pid = 0;
        const deadline = Date.now() + 4000;
        while (!pid && Date.now() < deadline) {
            pid = Number((await first.tailSession(handle.sessionId))[0]);
            if (!pid) await Bun.sleep(25);
        }
        expect(pid).toBeGreaterThan(0);
        expect((await second.recoverSession(handle.sessionId)).status).toBe("running");
        expect(await second.stopSession(handle.sessionId)).toEqual({ status: "exited", exitCode: 37 });
        const state = await second.exec(`ps -o stat= -p ${pid}`);
        expect(state.stdout.trim()).toMatch(/^(?:Z.*)?$/);
    } finally {
        if (handle) {
            const { sessionId, logBase } = handle;
            await first.stopSession(sessionId).catch(() => undefined);
            const paths = ["pid", "pgid", "st", "code", "claim", "out", "err", "members"].map((ext) => shellQuote(`${logBase}.${ext}`));
            await first.exec(`rm -f ${paths.join(" ")}`).catch(() => undefined);
        }
        await Promise.all([first.destroy(), second.destroy()]);
    }
}, 35_000);

describe("SSH 真机集成（AC-02/04/15 远端面）", () => {
    integration("exec 通道：stderr 物理分离 + marker effectiveUser + 退出码", async () => {
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const r = await drv.exec("echo i-out; echo i-err 1>&2; exit 5");
            expect(r.stdout.trim()).toBe("i-out");
            expect(r.stderr.trim()).toBe("i-err"); // 物理分离
            expect(r.exitCode).toBe(5);
            expect(r.effectiveUser).toBeTruthy();
        } finally {
            await drv.destroy();
        }
    }, 60_000);

    integration("pty 通道：层内交互语义（exec marker 协议）", async () => {
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const r = await drv.exec("cd /tmp && pwd", { channel: "pty" });
            expect(r.stdout.trim()).toBe("/tmp");
            const r2 = await drv.exec("pwd", { channel: "pty" }); // 层内状态保持
            expect(r2.stdout.trim()).toBe("/tmp");
        } finally {
            await drv.destroy();
        }
    }, 60_000);

    integration("远端会话：nohup .code 终态 + 双文件", async () => {
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        let logBase: string | undefined;
        try {
            const h = await drv.execSession("echo s-out; echo s-err 1>&2; exit 9");
            logBase = h.logBase;
            await new Promise((r) => setTimeout(r, 2500)); // 等 .code 落盘（轮询 1.5s 周期）
            const out = await drv.readSessionLog(h.sessionId, { stream: "stdout" });
            const err = await drv.readSessionLog(h.sessionId, { stream: "stderr" });
            expect(out).toBe("s-out");
            expect(err).toBe("s-err");
            expect(await drv.verifySession(h.sessionId)).toEqual({ status: "exited", exitCode: 9 });
        } finally {
            if (logBase) await drv.exec(`rm -f ${["claim", "out", "err", "pid", "pgid", "code", "st"].map((ext) => logBase + "." + ext).join(" ")}`);
            await drv.destroy();
        }
    }, 60_000);

    integration("SSH 新连接可从落盘证据核实旧会话并补读日志", async () => {
        const descriptor = { driver: "ssh", target: TARGET };
        const original = new SshPtyDriver(descriptor);
        const reconnected = new SshPtyDriver(descriptor);
        const gate = `/tmp/fx-recover-${randomUUID()}`;
        let session: Awaited<ReturnType<SshPtyDriver["execSession"]>> | undefined;
        try {
            await original.init();
            session = await original.execSession(
                `echo RECOVERED; i=0; while [ ! -f ${gate} ] && [ "$i" -lt 40 ]; do sleep 0.25; i=$((i+1)); done; exit 17`,
            );
            expect(session.pid).toBeGreaterThan(0);
            await original.destroy();
            await reconnected.init();
            expect(reconnected.listSessions()).toEqual([]);
            expect(await reconnected.verifySession(session.sessionId)).toEqual({ status: "running" });
            expect(await reconnected.readSessionLog(session.sessionId)).toBe("RECOVERED");
            const stamp = `${session.logBase}.st`;
            await reconnected.exec(`cp ${stamp} ${stamp}.backup && printf '0\\n' > ${stamp}`);
            expect(await reconnected.verifySession(session.sessionId)).toEqual({ status: "unknown" });
            await reconnected.exec(`mv ${stamp}.backup ${stamp}`);
            await reconnected.exec(`touch ${gate}`);
            const deadline = Date.now() + 5000;
            let status = await reconnected.verifySession(session.sessionId);
            while (status.status !== "exited" && Date.now() < deadline) {
                await Bun.sleep(100);
                status = await reconnected.verifySession(session.sessionId);
            }
            expect(status).toEqual({ status: "exited", exitCode: 17 });
        } finally {
            try {
                if (session) {
                    await reconnected.exec(`touch ${gate}`);
                    const base = session.logBase;
                    await reconnected.exec(`i=0; while [ ! -f ${base}.code ] && [ "$i" -lt 40 ]; do sleep 0.25; i=$((i+1)); done`);
                    const paths = ["claim", "out", "err", "pid", "pid.tmp", "pgid", "code", "st", "st.backup"].map((suffix) => base + "." + suffix);
                    await reconnected.exec(`rm -f ${gate} ${paths.join(" ")}`);
                }
            } finally {
                await original.destroy();
                await reconnected.destroy();
            }
        }
    }, 60_000);

    integration("SSH 接管后 watcher 只看新输出，重新核实身份后停止", async () => {
        const descriptor = { driver: "ssh", target: TARGET };
        const original = new SshPtyDriver(descriptor);
        const reconnected = new SshPtyDriver(descriptor);
        const gate = `/tmp/fx-adopt-${randomUUID()}`;
        let session: Awaited<ReturnType<SshPtyDriver["execSession"]>> | undefined;
        try {
            await original.init();
            session = await original.execSession(
                `echo EVENT_OLD; i=0; while [ ! -f ${gate} ] && [ "$i" -lt 40 ]; do sleep 0.25; i=$((i+1)); done; echo EVENT_NEW >&2; sleep 10`,
            );
            await original.destroy();
            await reconnected.init();
            const id = session.sessionId;
            const stamp = session.logBase + ".st";
            const stampValue = (await reconnected.exec(`cat ${stamp}`)).stdout.trim();
            expect(stampValue).toMatch(/^\d+$/);
            expect(await reconnected.readSessionLog(id)).toBe("EVENT_OLD");
            await reconnected.exec(`cp ${stamp} ${stamp}.backup && printf '0\\n' > ${stamp}`);
            expect((await reconnected.recoverSession(id)).status).toBe("unknown");
            expect((await reconnected.stopSession(id)).status).toBe("unknown");
            expect(reconnected.listSessions()).toEqual([]);
            await reconnected.exec(`mv ${stamp}.backup ${stamp}`);

            const matches: string[] = [];
            reconnected.sessions.onEvent = (event) => {
                if (event.type === "match") matches.push(`${event.stream}:${event.matchedLine}`);
            };
            const adopted = await Promise.all([reconnected.recoverSession(id), reconnected.recoverSession(id)]);
            const expected = { status: "running" as const, sessionId: id, logBase: session.logBase, pid: session.pid! };
            expect(adopted).toEqual([expected, expected]);
            expect(reconnected.listSessions()).toHaveLength(1);
            reconnected.watchSession(id, { pattern: /EVENT_/, once: false });
            await reconnected.exec(`touch ${gate}`);
            const deadline = Date.now() + 6500;
            while (!matches.length && Date.now() < deadline) await Bun.sleep(100);
            expect(matches).toEqual(["stderr:EVENT_NEW"]);
            expect(await reconnected.stopSession(id)).toMatchObject({ status: "stopped" });
        } finally {
            try {
                if (session) {
                    await reconnected.exec(`touch ${gate}`);
                    const final = await reconnected.stopSession(session.sessionId);
                    if (final.status === "unknown") {
                        await reconnected.exec(`i=0; while [ ! -f ${session.logBase}.code ] && [ "$i" -lt 48 ]; do sleep 0.25; i=$((i+1)); done`);
                    }
                    const paths = ["claim", "out", "err", "pid", "pid.tmp", "pgid", "code", "st", "st.backup"].map((suffix) => session!.logBase + "." + suffix);
                    await reconnected.exec(`rm -f ${gate} ${paths.join(" ")}`);
                }
            } finally {
                await original.destroy();
                await reconnected.destroy();
            }
        }
    }, 60_000);

    integration("Agent 持续观察窗在 SSH 进入管线中继承 cwd 并回看双流", async () => {
        const { RuntimeStack } = await import("../src/operations/runtime-stack.js");
        const { createAgentToolkit } = await import("../src/agent-toolkit.js");
        const stack = new RuntimeStack();
        const descriptor = { driver: "ssh", target: TARGET, cwd: "/tmp", config: { enterPipeline: [{ cmd: "sh" }] } };
        await stack.addLayer("remote-window", descriptor);
        const toolkit = createAgentToolkit(stack);
        try {
            const { window_id } = await toolkit.handlers.observe_stream({
                command: "pwd; echo REMOTE_ERR >&2; sleep 1; echo REMOTE_LATE",
                layer: "remote-window",
            });
            let cursor = 0;
            const frames: Array<{ text: string; stream?: string }> = [];
            while (frames.length < 3) {
                const page = await toolkit.handlers.observe_stream({ window_id, since_seq: cursor, wait_ms: 5000 });
                if (!page.frames.length) break;
                frames.push(...page.frames);
                cursor = page.last_delivered_seq!;
            }
            expect(frames).toHaveLength(3);
            expect(frames).toContainEqual(expect.objectContaining({ text: "/tmp", stream: "stdout" }));
            expect(frames).toContainEqual(expect.objectContaining({ text: "REMOTE_ERR", stream: "stderr" }));
            expect(frames.at(-1)?.text).toBe("REMOTE_LATE");
            const history = await toolkit.handlers.observe_stream({ window_id, before_seq: cursor });
            expect(history.frames.map(({ text }) => text).sort()).toEqual(["/tmp", "REMOTE_ERR"]);
            const done = await toolkit.handlers.observe_stream({ window_id, since_seq: cursor, wait_ms: 5000 });
            expect(done).toMatchObject({ stale: true, exit_code: 0 });
            await toolkit.handlers.close_stream({ window_id });

            const failed = await toolkit.handlers.observe_stream({ command: "printf '\\342\\202'; exit 37", layer: "remote-window" });
            const terminal = await toolkit.handlers.observe_stream({ window_id: failed.window_id, since_seq: 0, wait_ms: 5000 });
            expect(terminal).toMatchObject({ stale: true, exit_code: 37, frames: [{ text: "�", stream: "stdout" }] });
            await toolkit.handlers.close_stream({ window_id: failed.window_id });
        } finally {
            toolkit.dispose?.();
            await stack.removeLayer("remote-window", { destroy: true });
        }
    }, 30_000);

    integration("观察流：真流式 + 双流标记 + 衰减回收", async () => {
        const m = new StreamSessionManager([TARGET]);
        const events: Array<{ type: string; stream?: string }> = [];
        m.onEvent = (e) => events.push(e as never);
        const { sessionId } = await m.start("echo L1; echo E1 1>&2; sleep 10");
        await new Promise((r) => setTimeout(r, 1500));
        const lines = m.tailLines(sessionId);
        expect(lines.some((l) => l.stream === "stdout" && l.text === "L1")).toBe(true);
        expect(lines.some((l) => l.stream === "stderr" && l.text === "E1")).toBe(true);
        m.reapIdle(Date.now() + 60_000, 1); // 强制回收
        const deadline = Date.now() + 3000;
        while (m.list().length && Date.now() < deadline) await Bun.sleep(25);
        expect(m.list()).toHaveLength(0);
        expect(events.some((e) => e.type === "exit")).toBe(true);
    }, 60_000);

    integration("文件传输：方言探测（真机）+ put/get 双校验 roundtrip", async () => {
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        const remote = `/tmp/fx-it-${randomUUID()}.bin`;
        const dir = mkdtempSync(join(tmpdir(), "fx-it-"));
        try {
            const dialect = await probeDialect((cmd) => drv.exec(cmd));
            expect(["gnu", "bsd", "busybox", "openssl-fallback"]).toContain(dialect.family);
            const payload = Buffer.alloc(150 * 1024); // >128KB 触发多分块
            for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 251;
            const local = join(dir, "p.bin");
            writeFileSync(local, payload);
            await putFile((cmd) => drv.exec(cmd), dialect, local, remote);
            const back = join(dir, "b.bin");
            writeFileSync(back, "old contents", { mode: 0o600 });
            await getFile((cmd) => drv.exec(cmd), dialect, remote, back);
            if (process.platform !== "win32") expect(statSync(back).mode & 0o777).toBe(0o600);
            expect(Buffer.compare(readFileSync(back), payload)).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
            await drv.exec(`rm -f ${remote}`);
            await drv.destroy();
        }
    }, 120_000);

    integration("SDK exec 上传遵循目标 umask，覆盖时保留已有权限", async () => {
        const local = mkdtempSync(join(tmpdir(), "fx-put-mode-"));
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        let remote: string | undefined;
        const masks = [["022", "644"], ["027", "640"], ["077", "600"], ["444", "222"], ["002", "664"]] as const;
        try {
            const created = await drv.exec("mktemp -d /tmp/filaxis-put-mode.XXXXXXXXXX");
            expect(created.exitCode).toBe(0);
            const stage = created.stdout.trim();
            expect(stage).toMatch(/^\/tmp\/filaxis-put-mode\.[A-Za-z0-9]{10}$/);
            remote = stage;
            const input = join(local, "input");
            const payload = Buffer.from([0, 128, 255, 10]);
            writeFileSync(input, payload);
            for (const [mask, mode] of masks) {
                const path = `${stage}/mode-${mask}`;
                let stagingMode: string | undefined;
                const exec = async (command: string) => {
                    // GNU mv -T receives the staging payload as its second argument.
                    const inspect = command.includes("FX_MV_OK")
                        ? 'mv() { printf "stage-mode="; stat -c %a "$(dirname "$2")"; command mv "$@"; }; '
                        : "";
                    const result = await drv.exec(`umask ${mask}; ${inspect}${command}`);
                    stagingMode ??= result.stdout.match(/stage-mode=(\d+)/)?.[1];
                    return result;
                };
                await putFile(exec, await probeDialect(exec), input, path);
                expect(stagingMode).toBe("700");
                expect((await drv.exec(`stat -c %a ${shellQuote(path)}`)).stdout.trim()).toBe(mode);
                expect((await drv.exec(`chmod 604 ${shellQuote(path)}`)).exitCode).toBe(0);
                expect(await transferLayerFile(drv, "put", { localPath: input, remotePath: path }))
                    .toMatchObject({ bytes: payload.length, verification: "sha256", writeMode: "atomic-replace" });
                expect((await drv.exec(`stat -c %a ${shellQuote(path)}`)).stdout.trim()).toBe("604");
            }
            expect((await drv.exec(`find ${shellQuote(stage)} -mindepth 1 -type d -print`)).stdout.trim()).toBe("");
        } finally {
            try {
                if (remote) {
                    const files = masks.map(([mask]) => shellQuote(`${remote}/mode-${mask}`)).join(" ");
                    await drv.exec(`rm -f ${files}; rmdir ${shellQuote(remote)}`);
                }
            } finally {
                await drv.destroy();
                rmSync(local, { recursive: true, force: true });
            }
        }
    }, 120_000);

    // GPT Astra 十轮 #1/#2 + env 语义统一（真机实证）：
    // - cwd 是远端语义：远端专属目录（本地不存在）不得让本地 ssh spawn ENOENT
    // - getEnv 返回真实变量值（非 $KEY 字面量）；不存在 → undefined
    // - options.env 在远端生效（export 前缀——本地 ssh 进程灌 env 远端看不见）
    async function verifyCliTransfer(jump?: string): Promise<void> {
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        const local = mkdtempSync(join(tmpdir(), "fx-cli-transfer-"));
        const cases = jump ? [
            { name: "jump", transport: "sftp", config: { connParams: { jump } } },
        ] : [
            { name: "exec", transport: "exec", config: { enterPipeline: [{ cmd: "sh" }] } },
            { name: "sftp", transport: "sftp", config: undefined },
        ];
        let remoteDir: string | undefined;
        try {
            const created = await drv.exec("mktemp -d /tmp/filaxis-cli-transfer.XXXXXXXXXX");
            const stage = created.stdout.trim();
            expect(created.exitCode).toBe(0);
            expect(stage).toMatch(/^\/tmp\/filaxis-cli-transfer\.[A-Za-z0-9]{10}$/);
            remoteDir = stage;
            const input = join(local, "input data.bin");
            const payload = Buffer.from([0, 1, 127, 128, 195, 255, 10, 0]);
            writeFileSync(input, payload);
            const layers = join(local, "layers.json");
            writeFileSync(layers, JSON.stringify(Object.fromEntries(cases.map(({ name, config }) => [
                name, { driver: "ssh", target: TARGET, cwd: remoteDir, config },
            ]))));
            for (const { name, transport } of cases) {
                const output = join(local, `${name} output.bin`);
                const options = ["--layer", name, "--timeout", "15000"];
                if (transport === "sftp") options.push("--transport", "sftp");
                const env = {
                    ...process.env, FILAXIS_LAYERS: layers,
                    ...(transport === "sftp" ? { FILAXIS_SSH_STDIO_MODE: "inherit" } : {}),
                };
                const cli = (command: "put" | "get", from: string, to: string) => JSON.parse(execFileSync(
                    process.execPath, ["bin/filaxis.ts", command, ...options, "--", from, to], { encoding: "utf8", env, windowsHide: true },
                ));
                expect(cli("put", input, `${name} file.bin`)).toMatchObject({ transport, bytes: payload.length, verification: "sha256", writeMode: "atomic-replace" });
                expect(cli("get", `${name} file.bin`, output)).toMatchObject({ transport, bytes: payload.length, verification: "sha256" });
                expect(readFileSync(output)).toEqual(payload);
            }
        } finally {
            try {
                if (remoteDir) {
                    const files = cases.map(({ name }) => shellQuote(`${remoteDir}/${name} file.bin`)).join(" ");
                    await drv.exec(`rm -f ${files}; rmdir ${shellQuote(remoteDir)}`);
                }
            } finally {
                await drv.destroy();
                rmSync(local, { recursive: true, force: true });
            }
        }
    }

    integration("CLI put/get transfers binary files with spaces over exec and SFTP", () => verifyCliTransfer(), 120_000);
    jumpIntegration("CLI put/get transfers binary files over SFTP through a TCP jump", () =>
        verifyCliTransfer(process.env.FILAXIS_IT_JUMP ?? "127.0.0.1"), 120_000);

    integration("exec cwd/env/getEnv 语义（真机）：远端目录 + env 远端生效 + printenv 真值", async () => {
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            // #1：/tmp 远端必有、本地 Windows 无（本地 spawn 不吃 cwd——修前 ENOENT）
            const r = await drv.exec("pwd", { cwd: "/tmp", channel: undefined });
            expect(r.stdout.trim()).toBe("/tmp");
            // env 远端生效（exec 通道 export 前缀——export 后读展开值）
            const e = await drv.exec('printf %s "$FX_IT_MODE"', { env: { FX_IT_MODE: "remote-ok" } });
            expect(e.stdout).toBe("remote-ok");
            // #2：getEnv 真值 + 不存在 undefined + 非法名拒绝
            const home = await drv.getEnv("HOME");
            expect(home).toBeTruthy();
            expect(home).not.toContain("$");
            expect(await drv.getEnv("FX_NO_SUCH_VAR_9371")).toBeUndefined();
            await expect(drv.getEnv("BAD;NAME")).rejects.toThrow(/非法环境变量名/);
            // pty 通道 env 显式拒绝（键入回显物理语义）
            await expect(drv.exec("echo x", { channel: "pty", env: { A: "1" } })).rejects.toThrow(/不支持 env/);
        } finally {
            await drv.destroy();
        }
    }, 60_000);

    // -J 单层形态（ProxyJump 单命令——与 sshInto 派生层的 PTY 链形态互补）：
    // 认证全在发起端（跳板只转 TCP），exec 通道可用（ssh -J 自代理）。
    // CI 自环默认跳板 127.0.0.1：OpenSSH 自带跳板回环检测——-J localhost localhost
    // 直接拒绝（jumphost loop via localhost），127.0.0.1 与 localhost 字串不同绕开
    // 检测、物理仍同机中转。非标 sshd 端口的机器传 FILAXIS_IT_JUMP='[127.0.0.1]:2222'；
    // 真机跨跳板传 FILAXIS_IT_JUMP=<跳板别名>。
    jumpIntegration("-J 单层（ProxyJump）：exec 通道可用 + 双流分离 + 认证发起端直通", async () => {
        const jump = process.env.FILAXIS_IT_JUMP
            ?? (TARGET === "localhost" ? "127.0.0.1" : TARGET);
        const drv = new SshPtyDriver({
            driver: "ssh", target: TARGET,
            config: { connParams: { jump } },
        });
        await drv.init();
        try {
            const r = await drv.exec("echo via-jump; echo jerr 1>&2; exit 4");
            expect(r.stdout.trim()).toBe("via-jump");
            expect(r.stderr.trim()).toBe("jerr"); // exec 双流分离在 -J 形态同样成立
            expect(r.exitCode).toBe(4);
            expect(r.effectiveUser).toBeTruthy();
        } finally {
            await drv.destroy();
        }
    }, 60_000);
});

// ── 故障注入回归（第三轮实验 1A/1B——完成哨兵原则）──
describe("故障注入回归（哨兵原则，CI 真机）", () => {
    integration("1B: abort 中断长命令 → AbortError reject（绝不 resolve 伪 exitCode:0）", async () => {
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const ac = new AbortController();
            const p = drv.exec("echo STEP_1_DONE; sleep 10", { signal: ac.signal, timeoutMs: 60_000 });
            await new Promise((r) => setTimeout(r, 1500));
            ac.abort();
            await expect(p).rejects.toMatchObject({ name: "AbortError", outcome: "unknown" });
        } finally { await drv.destroy(); }
    }, 90_000);

    integration("1A: 外部关闭本测试的 SSH 子进程，未完成请求返回 unknown 和部分输出", async () => {
        const driver = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await driver.init();
        try {
            // Hold this driver's own SSH child. No process lookup or host-wide signal.
            const { link } = driver as unknown as {
                link: { proc: import("node:child_process").ChildProcess; lineBuffer: string[] };
            };
            const child = link.proc;
            const outcome = driver.exec("printf '%s%s\\n' HALF_ OUTPUT; sleep 8", {
                channel: "pty", timeoutMs: 15_000,
            }).catch((error: unknown) => error);
            const deadline = Date.now() + 5000;
            while (!link.lineBuffer.includes("HALF_OUTPUT") && Date.now() < deadline) await Bun.sleep(25);
            expect(link.lineBuffer).toContain("HALF_OUTPUT");
            expect(child.kill("SIGKILL")).toBe(true);
            expect(await outcome).toMatchObject({
                outcome: "unknown",
                partialOutput: expect.stringContaining("HALF_OUTPUT"),
            });
        } finally {
            await driver.destroy();
        }
    }, 30_000);


});

// ── 第四季回归：PTY 跨任务残影串台（temporal isolation）──
describe("第四季：PTY 残影串台回归（CI 真机）", () => {
    integration("2B: A 超时 ^C 后紧跟 B——B 的 stdout 零串台（A 遗言与 A 的 130 trap 不入 B）", async () => {
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const a = drv.exec("echo A_LAST_WORDS; sleep 5", { timeoutMs: 1200, channel: "pty" });
            await expect(a).rejects.toMatchObject({ outcome: "unknown" });
            // 紧跟 B：上一周期必须先 DRAINING 完成才放行（等 A 的 trap/?$ 终态）
            const b = await drv.exec("echo B_OK", { timeoutMs: 30_000, channel: "pty" });
            expect(b.stdout).not.toContain("A_LAST_WORDS");
            expect(b.stdout).not.toContain("_130_"); // A 的 ^C trap 遗言不进 B
            expect(b.stdout.trim()).toBe("B_OK");
            expect(b.exitCode).toBe(0);
        } finally { await drv.destroy(); }
    }, 90_000);
});

// ── 第九季：CLI 路径描述透传（--enter 重放 / --docker 糖全链路 / --hop 拒绝）──
describe("第九季：CLI 路径描述（CI 真机）", () => {
    integration("--enter sh：exec 通道进入管线重放（stdin 管道零嵌套引用）", async () => {
        const out = execFileSync(process.execPath, ["bin/filaxis.ts", "exec", "--host", TARGET, "--enter", "sh", "--", "echo ENTER_OK"], { encoding: "utf-8", windowsHide: true });
        expect(out).toContain("ENTER_OK");
    }, 60_000);

    dockerIntegration("--docker 糖：alpine 容器全链路（盲测场景复刻：exec + edit 免 Shell 通道）", async () => {
        const driver = new SshPtyDriver({ driver: "ssh", target: TARGET });
        const container = `fx-cli-it-${randomUUID()}`;
        try {
            const started = await driver.exec(`docker run -d --name ${container} alpine:latest sleep 300`);
            if (started.exitCode !== 0) throw new Error(started.stderr);
            const args = ["bin/filaxis.ts"];
            const layer = ["--host", TARGET, "--docker", container];
            const out = execFileSync(process.execPath, [...args, "exec", ...layer, "--", "echo DOCKER_OK; cat /etc/alpine-release"], { encoding: "utf-8", windowsHide: true });
            expect(out).toContain("DOCKER_OK");
            expect(out).toMatch(/\d+\.\d+\.\d+/);
            const path = "/tmp/fx-cli-edit.json";
            execFileSync(process.execPath, [...args, "exec", ...layer, "--", `printf '{"k": 1}' > ${path}`], { windowsHide: true });
            const edited = execFileSync(process.execPath, [...args, "edit", ...layer, path, "--stdin-json"], {
                input: JSON.stringify({ old: "1", new: "2" }),
                encoding: "utf-8",
                windowsHide: true,
            });
            expect(edited).toContain("1 处");
        } finally {
            await driver.exec(`docker rm -f ${container}`);
            await driver.destroy();
        }
    }, 180_000);

    integration("--hop 链 exec 通道拒绝（不可直达语义自守——指引收敛 -J 或 pty 通道）", async () => {
        let errText = "";
        try {
            execFileSync(process.execPath, ["bin/filaxis.ts", "exec", "--host", TARGET, "--hop", "user@bastion:2222", "--", "echo X"], { encoding: "utf-8", stdio: "pipe", windowsHide: true });
        } catch (e) {
            errText = String((e as { stderr?: string }).stderr ?? (e as Error).message);
        }
        expect(errText).toContain("exec 通道无法复现多跳"); // 新文案（AI 可操作化后）
        expect(errText).toContain("-J");
        expect(errText).toContain("--pty"); // CLI 开关指引在场（不再是 SDK 术语死胡同）
    }, 60_000);
});

// ── 第十季：命名层注册表真机链（回环幂等 + 派生 + snapshot/restore）──
describe("第十季：命名层注册表（CI 真机）", () => {
    integration("addLayer 回环幂等（末节点命中免探测复用）+ layerInto 派生 + snapshot/restore", async () => {
        const { RuntimeStack } = await import("../src/operations/runtime-stack.js");
        const { enterStepsOf } = await import("../src/ssh-helpers.js");
        const stack = new RuntimeStack();
        const a = await stack.addLayer("lo", { driver: "ssh", target: TARGET });
        expect(a.reused).toBe(false);
        // 回环幂等：同落点（identity 末节点命中）→ 返回既有层句柄，不重复建连
        const b = await stack.addLayer("lo-again", { driver: "ssh", target: TARGET });
        expect(b.reused).toBe(true);
        expect(b.handle).toBe(a.handle);
        expect(b.reusedFrom).toBe("lo");
        const otherCwd = await stack.addLayer("other-cwd", { driver: "ssh", target: TARGET, cwd: "/tmp" });
        expect(otherCwd.reused).toBe(false);
        expect((await otherCwd.handle.driver.exec("pwd")).stdout.trim()).toBe("/tmp");
        await stack.removeLayer("other-cwd", { destroy: true });
        // 派生：enter sh 管线继承追加
        const c = await stack.layerInto("lo", "inner", "sh");
        expect(enterStepsOf(c.descriptor.config as Record<string, unknown>).length).toBe(1);
        // 按名寻址执行（inner 层 exec 真跑）
        const r = await stack.layer("inner").driver.exec("echo LAYER_OK");
        expect(r.stdout).toContain("LAYER_OK");
        // snapshot/restore：移除后按快照重建（指纹缓存命中=零成本恢复）
        const snap = stack.snapshot();
        const origDriver = stack.layer("lo").driver;
        await stack.removeLayer("inner");
        await stack.removeLayer("lo");
        await stack.restore(snap);
        expect(stack.layer("lo").driver).toBe(origDriver);
        const r2 = await stack.layer("lo").driver.exec("echo RESTORE_OK");
        expect(r2.stdout).toContain("RESTORE_OK");
        await stack.removeLayer("inner", { destroy: true });
        await stack.removeLayer("lo", { destroy: true });
    }, 180_000);
});

// ── 第十一季：批量组合真机（ssh 层 DAG + fail-fast + CM 复用下的并行 exec）──
describe("第十一季：批量组合（CI 真机）", () => {
    integration("run_batch combines local and SSH layers and retains the SSH syntax-error exit code", async () => {
        const { RuntimeStack, createAgentToolkit } = await import("../src/index.js");
        const stack = new RuntimeStack();
        const toolkit = createAgentToolkit(stack);
        try {
            await stack.addLayer("controller", { driver: "local" });
            const connections = await toolkit.handlers.connect_layer({ targets: [
                { host: TARGET, name: "remote" }, { host: TARGET, name: "duplicate-landing" },
            ] });
            expect(connections).toMatchObject({
                status: "ok", active_layer: "remote", layers: ["remote"],
                results: [
                    { layer: "remote", reused: false },
                    { layer: "remote", reused: true },
                ],
            });
            const result = await toolkit.handlers.run_batch({
                layer: "controller",
                steps: [
                    { id: "local", kind: "exec", command: "printf controller" },
                    { id: "syntax", kind: "exec", layer: connections.layers, command: "if true; then\n  echo unfinished", expect_exit: [2], after: ["local"] },
                    { id: "script", kind: "exec", layer: "remote", command: "cat <<'END'\n'quoted' $HOME\nEND\n# final comment", after: ["syntax"] },
                    { id: "done", kind: "exec", command: "printf done", after: ["script"] },
                ],
            });
            expect(result.status).toBe("ok");
            expect(result.steps).toMatchObject([
                { layer: "controller", stdout: "controller" },
                { layer: "remote", exit_code: 2, stderr: expect.stringMatching(/syntax error/i) },
                { layer: "remote", stdout: "'quoted' $HOME\n" },
                { layer: "controller", stdout: "done" },
            ]);
        } finally {
            await Promise.all([...stack.layers.keys()].map((layer) => stack.removeLayer(layer, { destroy: true })));
        }
    }, 30_000);

    integration("runBatch ssh 层：改配置→验证（真 CAS+CM）→ fail-fast", async () => {
        const { runBatch } = await import("../src/batch.js");
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        const p = `/tmp/fx-batch-it-${randomUUID()}.conf`;
        try {
            await drv.exec(`echo 'port=8080' > ${p}`);
            const ok = await runBatch(drv, {
                steps: [
                    { id: "edit", kind: "edit", path: p, hunks: [{ old: "port=8080", new: "port=9090" }] },
                    { id: "verify", kind: "exec", command: `grep -q 'port=9090' ${p}`, after: ["edit"] },
                    { id: "parallel", kind: "exec", command: "echo P1" }, // 无依赖——与 edit 并行
                ],
            });
            expect(ok.status).toBe("ok");
            expect(ok.steps.find((s) => s.id === "edit")!.edits!.occurrences).toBe(1);
            // fail-fast：verify 失败 → reload skipped
            const bad = await runBatch(drv, {
                steps: [
                    { id: "verify2", kind: "exec", command: `grep -q 'port=NOPE' ${p}` },
                    { id: "reload", kind: "exec", command: `touch ${p}.never`, after: ["verify2"] },
                ],
            });
            expect(bad.status).toBe("fail");
            expect(bad.steps.find((s) => s.id === "reload")!.status).toBe("skipped");
        } finally {
            await drv.exec(`rm -f ${p} ${p}.fx-lock ${p}.fx-tmp ${p}.never`);
            await drv.destroy();
        }
    }, 120_000);
});
describe("第十一季：CLI 层快照（CI 真机）", () => {
    integration("CLI batch 解析逐步 layer、计划 layer 和命令行默认层", () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-cli-batch-"));
        const layers = join(dir, "layers.json");
        const planPath = join(dir, "plan.json");
        const env = { ...process.env, FILAXIS_LAYERS: layers };
        const run = (plan: object, layer: string) => {
            writeFileSync(planPath, JSON.stringify(plan));
            return execFileSync(process.execPath, [
                "bin/filaxis.ts", "batch", "--layer", layer, "--request-file", planPath,
            ], { encoding: "utf8", env, windowsHide: true });
        };
        try {
            writeFileSync(layers, JSON.stringify({
                root: { driver: "ssh", target: TARGET, cwd: "/" },
                tmp: { driver: "ssh", target: TARGET, cwd: "/tmp" },
            }));
            const first = { id: "first", kind: "exec", command: "pwd" };
            const second = { id: "second", kind: "exec", command: "pwd", layer: "tmp", after: ["first"] };
            expect(run({ layer: "root", steps: [first, second] }, "tmp"))
                .toMatch(/first .*layer=root[^\n]*\n\/\r?\n.*second .*layer=tmp[^\n]*\n\/tmp\r?\nbatch ok/);
            expect(run({ steps: [first] }, "tmp")).toMatch(/first .*layer=tmp[^\n]*\n\/tmp\r?\nbatch ok/);
            const fan = run({ layer: ["root", "tmp"], steps: [first, second] }, "tmp");
            expect(fan).toMatch(/first@root .*layer=root[^\n]*\n\/\r?\n.*first@tmp .*layer=tmp[^\n]*\n\/tmp\r?\n.*second .*layer=tmp[^\n]*\n\/tmp\r?\nbatch ok/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);

    integration("layer save → exec --layer 一行直达（CM master 跨命令复用）", async () => {
        const { tmpdir } = await import("node:os");
        const { join: j } = await import("node:path");
        const { mkdtempSync, rmSync } = await import("node:fs");
        const d = mkdtempSync(j(tmpdir(), "fx-cli-layer-"));
        const env = { ...process.env, FILAXIS_LAYERS: j(d, "layers.json") };
        try {
            execFileSync(process.execPath, ["bin/filaxis.ts", "layer", "save", "lo", "--host", TARGET], { encoding: "utf-8", env, windowsHide: true });
            // 第一条：建 master（一次握手）；第二条：CM 复用毫秒级
            const o1 = execFileSync(process.execPath, ["bin/filaxis.ts", "exec", "--layer", "lo", "--", "echo L1_OK"], { encoding: "utf-8", env, windowsHide: true });
            expect(o1).toContain("L1_OK");
            const o2 = execFileSync(process.execPath, ["bin/filaxis.ts", "exec", "--layer", "lo", "--", "echo L2_OK"], { encoding: "utf-8", env, windowsHide: true });
            expect(o2).toContain("L2_OK");
        } finally {
            rmSync(d, { recursive: true, force: true });
        }
    }, 120_000);
});
