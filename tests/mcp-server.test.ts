/**
 * MCP Server 单测（REQ-0003：协议合规/schema 零漂移/结构化编辑/错误透传/会话链）
 * 流注入：PassThrough 模拟 stdin/stdout——零真实进程
 */
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { McpServer } from "../src/mcp-server.js";
import { createAgentToolkit, TOOL_DEFS } from "../src/agent-toolkit.js";
import { RuntimeStack } from "../src/runtime-stack.js";
import { LocalRuntimeDriver } from "../src/local-driver.js";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

/** 驱动 MCP server 的测试替身：write(line) 进请求，collect() 收响应 */
function mcpFixture(stack = new RuntimeStack(), tk = createAgentToolkit(stack, {})): { write: (obj: Record<string, unknown>) => void; collect: () => Array<Record<string, unknown>>; close: () => void } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    new McpServer({ toolkit: tk, stdin, stdout });
    const buf: Array<Record<string, unknown>> = [];
    let acc = "";
    stdout.on("data", (d: Buffer) => {
        acc += d.toString("utf-8");
        let nl: number;
        while ((nl = acc.indexOf("\n")) !== -1) {
            buf.push(JSON.parse(acc.slice(0, nl)) as Record<string, unknown>);
            acc = acc.slice(nl + 1);
        }
    });
    return {
        write: (obj) => stdin.write(JSON.stringify(obj) + "\n"),
        collect: () => buf,
        close: () => { stdin.end(); },
    };
}

/** 等待指定 id 的响应到达（本地 exec 首跑 bash 冷启动 ~1s——固定窗不稳） */
async function waitId(f: { collect: () => Array<Record<string, unknown>> }, id: number | string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const t0 = Date.now();
    for (;;) {
        const hit = f.collect().find((x) => (x as { id?: unknown }).id === id);
        if (hit) return hit;
        if (Date.now() - t0 > timeoutMs) throw new Error(`waitId(${id}) timeout`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

describe("MCP Server（REQ-0003）", () => {
    test("directory listing, default-layer switching, and non-recursive deletion", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-mcp-directory-"));
        const stack = new RuntimeStack();
        const fixture = mcpFixture(stack);
        const call = async (id: number, name: string, args: Record<string, unknown>) => {
            fixture.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
            return (await waitId(fixture, id)).result;
        };
        try {
            const previous = join(dir, "previous");
            const current = join(dir, "current");
            mkdirSync(previous);
            mkdirSync(current);
            mkdirSync(join(previous, "nested"));
            writeFileSync(join(previous, "-literal"), "previous");
            writeFileSync(join(current, "-literal"), "current");
            writeFileSync(join(previous, ".hidden"), "hidden");
            if (process.platform !== "win32") symlinkSync("nested", join(previous, "link"));
            const previousDriver = new LocalRuntimeDriver({ cwd: previous });
            await stack.addLayer("previous", previousDriver);
            await stack.addLayer("current", new LocalRuntimeDriver({ cwd: current }));

            expect(await call(1, "set_active_layer", { name: "unknown" })).toMatchObject({ isError: true });
            expect(stack.activeLayer?.name).toBe("current");
            expect(await call(2, "set_active_layer", { name: "previous" })).toMatchObject({
                structuredContent: { active_layer: "previous" }, content: [{ text: "active_layer=previous" }],
            });
            expect(await call(3, "list_directory", { path: "." })).toMatchObject({
                content: [{ text: expect.stringContaining("file .hidden") }],
                structuredContent: { entries: expect.arrayContaining([
                    expect.objectContaining({ name: "nested", isDirectory: true }),
                    expect.objectContaining({ name: "-literal", isDirectory: false }),
                ]) },
            });
            expect(await call(4, "list_directory", { path: "missing" })).toMatchObject({ isError: true });
            expect(await call(5, "delete_file", { path: "nested", recursive: true })).toMatchObject({ isError: true });
            expect(await call(6, "delete_file", { path: "nested" })).toMatchObject({ isError: true });
            expect(await call(7, "delete_file", { path: "-literal" })).toMatchObject({
                structuredContent: { deleted: true, path: "-literal" },
            });
            expect(await call(8, "delete_file", { path: "-literal" })).toMatchObject({ isError: true });
            if (process.platform !== "win32") {
                mkdirSync(join(previous, "other", "deeper"), { recursive: true });
                writeFileSync(join(previous, "other", "target"), "physical");
                writeFileSync(join(previous, "target"), "lexical");
                symlinkSync("other/deeper", join(previous, "alias"));
                expect(await call(9, "delete_file", { path: "link/." })).toMatchObject({ isError: true });
                expect(await call(10, "delete_file", { path: "link" })).toMatchObject({
                    structuredContent: { deleted: true, path: "link" },
                });
                expect(await call(12, "delete_file", { path: "alias/../target" })).toMatchObject({ isError: false });
                expect(existsSync(join(previous, "other", "target"))).toBe(false);
                expect(readFileSync(join(previous, "target"), "utf8")).toBe("lexical");
            }
            expect(existsSync(join(previous, "nested"))).toBe(true);
            expect(existsSync(join(previous, "-literal"))).toBe(false);
            expect(readFileSync(join(current, "-literal"), "utf8")).toBe("current");
            previousDriver.fs.rm = async () => {
                throw Object.assign(new Error("connection lost"), { outcome: "unknown" });
            };
            expect(await call(11, "delete_file", { path: ".hidden" })).toMatchObject({
                isError: true, content: [{ text: "outcome=unknown\nconnection lost" }],
                structuredContent: { outcome: "unknown" },
            });
            const entries = Array.from({ length: 60 }, (_, i) => ({ name: `entry-${i}-${"雪".repeat(80)}-end`, isDirectory: false }));
            previousDriver.fs.readdir = async () => entries;
            const listed = await call(13, "list_directory", { path: "." }) as {
                content: Array<{ text: string }>; structuredContent: { entries: typeof entries };
            };
            const listingText = listed.content[0]!.text;
            expect(listed.structuredContent.entries).toEqual(entries);
            expect(Buffer.byteLength(JSON.stringify(listingText))).toBeLessThanOrEqual(8192);
            expect(listingText).toContain("完整结果见 structuredContent");
            const fileLines = listingText.split("\n").filter((line) => line.startsWith("file "));
            expect(fileLines.length).toBeGreaterThan(0);
            expect(fileLines.every((line) => line.endsWith("-end"))).toBe(true);
        } finally {
            fixture.close();
            await Promise.all([...stack.layers.keys()].map((name) => stack.removeLayer(name, { destroy: true })));
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("put_file and get_file transfer bytes on the selected layer and report verification", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-mcp-transfer-"));
        const stack = new RuntimeStack();
        const f = mcpFixture(stack);
        const driver = new LocalRuntimeDriver({ cwd: dir });
        try {
            await stack.addLayer("fixture", driver);
            const input = join(dir, "input.bin");
            const output = join(dir, "output.bin");
            const payload = Buffer.from([0, 127, 128, 255, 10]);
            writeFileSync(input, payload);
            const call = async (id: number, name: string, args: Record<string, unknown>) => {
                f.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
                return (await waitId(f, id, 20_000)).result;
            };
            const paths = { layer: "fixture", remote_path: "layer file.bin" };
            expect(await call(1, "put_file", { ...paths, path: input })).toMatchObject({ isError: true });
            expect(existsSync(join(dir, paths.remote_path))).toBe(false);
            for (const [id, name, local_path] of [[2, "put_file", input], [3, "get_file", output]] as const) {
                expect(await call(id, name, { ...paths, local_path })).toMatchObject({
                    isError: false,
                    content: [{ text: expect.stringContaining("verification=sha256") }],
                    structuredContent: { bytes: payload.length, transport: "exec", verification: "sha256", write_mode: "atomic-replace" },
                });
            }
            expect(readFileSync(output)).toEqual(payload);
        } finally {
            f.close();
            await stack.removeLayer("fixture", { destroy: true });
            rmSync(dir, { recursive: true, force: true });
        }
    }, 45_000);

    test("MCP rejects missing batch steps and window IDs with the expected parameter names", async () => {
        const f = mcpFixture();
        try {
            f.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_batch", arguments: { commands: [] } } });
            f.write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_stream", arguments: { session: "demo" } } });
            expect((await waitId(f, 1)).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("steps 需为非空数组") }] });
            expect((await waitId(f, 2)).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("window_id 需为非空字符串") }] });
        } finally { f.close(); }
    });

    test("run_batch transfers files across layers with dependencies and validates paths before running", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-mcp-batch-transfer-"));
        const stack = new RuntimeStack();
        const f = mcpFixture(stack);
        try {
            for (const name of ["alpha", "beta"]) {
                const cwd = join(dir, name);
                mkdirSync(cwd);
                await stack.addLayer(name, new LocalRuntimeDriver({ cwd }));
            }
            const source = join(dir, "source.bin");
            const download = join(dir, "download.bin");
            const payload = Buffer.from([0, 128, 255, 10]);
            writeFileSync(source, payload);
            const put = { id: "put", kind: "put", local_path: source, remote_path: "staged.bin" };
            const get = { id: "get", kind: "get", local_path: download, remote_path: "staged.bin", after: ["put"] };
            const fan = { id: "copy", kind: "put", layer: "beta", local_path: download, remote_path: "replica.bin", after: ["get"] };
            const call = async (id: number, steps: unknown[]) => {
                f.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "run_batch", arguments: { layer: "alpha", steps } } });
                return (await waitId(f, id, 30_000)).result;
            };
            expect(await call(1, [put, { ...get, local_path: undefined }])).toMatchObject({
                isError: true, content: [{ text: expect.stringMatching(/get.*local_path/) }],
            });
            expect(existsSync(join(dir, "alpha", "staged.bin"))).toBe(false);
            const transfer = { transport: "exec", bytes: payload.length, verification: "sha256", write_mode: "atomic-replace" };
            expect(await call(2, [put, get, fan])).toMatchObject({
                isError: false, content: [{ text: expect.stringContaining("verification=sha256") }],
                structuredContent: { status: "ok", steps: [
                    { id: "put", layer: "alpha", status: "ok", transfer },
                    { id: "get", layer: "alpha", status: "ok", transfer },
                    { id: "copy", layer: "beta", status: "ok", transfer },
                ] },
            });
            expect(readFileSync(join(dir, "beta", "replica.bin"))).toEqual(payload);
        } finally {
            f.close();
            await Promise.all([...stack.layers.keys()].map((name) => stack.removeLayer(name, { destroy: true })));
            rmSync(dir, { recursive: true, force: true });
        }
    }, 50_000);

    test("run_batch uses the batch default and per-step override and identifies each layer", async () => {
        const stack = new RuntimeStack();
        const first = new LocalRuntimeDriver();
        const second = new LocalRuntimeDriver();
        const calls: string[] = [];
        first.exec = async (command) => { calls.push(`first:${command}`); return { stdout: "from first", stderr: "", exitCode: 0 }; };
        second.exec = async (command) => { calls.push(`second:${command}`); return { stdout: "from second", stderr: "", exitCode: 0 }; };
        await stack.addLayer("first", first);
        await stack.addLayer("second", second);
        const f = mcpFixture(stack);
        const steps = [
            { id: "one", kind: "exec", command: "one" },
            { id: "two", kind: "exec", layer: "second", command: "two", after: ["one"] },
        ];
        try {
            f.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_batch", arguments: { layer: "first", steps } } });
            expect((await waitId(f, 1)).result).toMatchObject({
                isError: false, content: [{ text: expect.stringContaining("layer=first") }],
                structuredContent: { status: "ok", steps: [{ layer: "first", stdout: "from first" }, { layer: "second", stdout: "from second" }] },
            });
            expect(calls).toEqual(["first:one", "second:two"]);
            steps[1]!.layer = "missing";
            f.write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_batch", arguments: { layer: "first", steps } } });
            expect((await waitId(f, 2)).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("missing") }] });
            expect(calls).toHaveLength(2);
            const typo = { id: "typo", kind: "exec", command: "no", layre: "second" };
            f.write({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_batch", arguments: { steps: [steps[0], typo] } } });
            expect((await waitId(f, 3)).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("layre") }] });
            expect(calls).toHaveLength(2);
        } finally { f.close(); }
    });
    test("list_layers exposes the empty and populated layer lists in MCP text", async () => {
        const stack = new RuntimeStack();
        const f = mcpFixture(stack);
        async function listLayers(id: number) {
            f.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_layers" } });
            const response = await waitId(f, id);
            return response.result as { content: Array<{ type: string; text: string }>; structuredContent: { layers: Array<{ name: string }> } };
        }
        try {
            const empty = await listLayers(1);
            expect(empty.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("（空") });
            await stack.addLayer("build", { driver: "local" });
            const populated = await listLayers(2);
            expect(populated.content[0]).toEqual({ type: "text", text: stack.layerText() });
            expect(populated.content[0]!.text).toMatch(/build:.*◀ 默认/);
            expect(populated.structuredContent.layers).toMatchObject([{ name: "build" }]);
        } finally { f.close(); }
    });

    test("run_batch text exposes stdout, stderr and exit codes for every step", async () => {
        const f = mcpFixture();
        try {
            const steps = [
                { id: "sys", kind: "exec", command: "printf SYS_READY" },
                { id: "docker", kind: "exec", command: `printf '%s' '${"x".repeat(1364)}🧵DOCKER_TAIL'` },
                { id: "net", kind: "exec", command: "printf NET_CHECK >&2; exit 7", expect_exit: [7] },
            ];
            f.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_batch", arguments: { steps } } });
            const { result } = (await waitId(f, 1)) as { result: { content: Array<{ text: string }>; structuredContent: { steps: Array<{ stdout: string }> } } };
            const text = result.content[0]!.text;
            expect(text).toContain("sys (exec) | status=ok | exit_code=0\nstdout:\nSYS_READY");
            expect(text).toContain("docker (exec) | status=ok | exit_code=0");
            expect(text).toContain("net (exec) | status=ok | exit_code=7\nstderr:\nNET_CHECK");
            expect(text).toContain("已截断 15 字节，完整输出见 structuredContent");
            expect(text).not.toContain("�");
            expect(result.structuredContent.steps[1]!.stdout).toEndWith("🧵DOCKER_TAIL");
            f.write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_batch", arguments: { steps, output: "text" } } });
            const compact = (await waitId(f, 2)).result as typeof result;
            expect(compact).not.toHaveProperty("structuredContent");
            expect(compact.content[0]!.text).toContain("stdout:\nSYS_READY");
            expect(compact.content[0]!.text).toContain("stderr:\nNET_CHECK");
            expect(compact.content[0]!.text).toContain("[采集阶段已截断 ");
            expect(compact.content[0]!.text).not.toContain("structuredContent");
        } finally { f.close(); }
    }, 15_000);

    test("oversized MCP batch text preserves failures and edit guarantees within the JSON text budget", async () => {
        const stack = new RuntimeStack();
        const toolkit = createAgentToolkit(stack, {});
        const failure = "\u0000".repeat(2000) + "尾";
        toolkit.handlers.run_batch = async () => ({
            status: "fail",
            failed_step: "fail-0",
            steps: [
                { id: "edited", kind: "edit", status: "ok", edits: {
                    path: "sample", occurrences: 1, bytes_before: 1, bytes_after: 1, hunks: [],
                    write_mode: "inplace-write", mutex: "degraded",
                } },
                ...Array.from({ length: 12 }, (_, i) => ({
                    id: `fail-${i}`, kind: "exec", status: "fail", exit_code: 2, error: failure,
                })),
            ],
        });
        const fixture = mcpFixture(stack, toolkit);
        try {
            fixture.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "run_batch", arguments: { output: "text" },
            } });
            const { result } = await waitId(fixture, 1) as { result: { content: Array<{ text: string }> } };
            const text = result.content[0]!.text;
            expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(8 * 1024);
            expect(text).toContain("fail-11 (exec) | status=fail | exit_code=2");
            expect(text).toContain("write_mode=inplace-write | mutex=degraded");
            expect(text).toContain("部分结果已省略");
            expect(result).not.toHaveProperty("structuredContent");
        } finally { fixture.close(); }
    });

    test("batch validation errors also fit the text budget", async () => {
        const fixture = mcpFixture();
        try {
            fixture.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "run_batch", arguments: { output: "text", steps: [{ id: "bad", kind: "😀".repeat(3500) }] },
            } });
            const { result } = await waitId(fixture, 1) as { result: { content: Array<{ text: string }>; isError: boolean } };
            const text = result.content[0]!.text;
            expect(result.isError).toBe(true);
            expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(8 * 1024);
            expect(text).toContain("未知 kind");
            expect(text).toContain("部分结果已省略");
            expect(result).not.toHaveProperty("structuredContent");
        } finally { fixture.close(); }
    });

    test("read_file displays exact text and marks an oversized preview without changing the structured body", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-mcp-read-body-"));
        const stack = new RuntimeStack();
        const fixture = mcpFixture(stack);
        const small = 'Types: deb\r\n  Suites: stable\r\n# 中文 "quoted"\r\n';
        const boundary = "x".repeat(8190);
        const large = 'File start\n' + '雪🧵\n"\\'.repeat(1200) + '\nFile end';
        const read = async (id: number, args: Record<string, unknown>) => {
            fixture.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read_file", arguments: args } });
            return (await waitId(fixture, id)).result as {
                isError: boolean;
                content: Array<{ text: string }>;
                structuredContent?: { path: string; content: string; size: number; mtime_ms: number };
            };
        };
        try {
            for (const [name, text] of [["small.sources", small], ["boundary", boundary], ["large", large], ["empty", ""]] as const) {
                writeFileSync(join(dir, name), text);
            }
            await stack.addLayer("files", new LocalRuntimeDriver({ cwd: dir }));
            const exact = await read(1, { path: "small.sources", layer: "files" });
            expect(exact.isError).toBe(false);
            expect(exact.content[0]?.text).toBe(small);
            expect(exact.structuredContent).toMatchObject({
                path: "small.sources", content: small, size: Buffer.byteLength(small),
            });
            expect((await read(2, { path: "boundary" })).content[0]?.text).toBe(boundary);
            const clipped = await read(3, { path: "large" });
            const text = clipped.content[0]!.text;
            expect(clipped.isError).toBe(false);
            expect(text).toContain("文件正文已截断");
            expect(text).not.toContain("File end");
            expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(8192);
            const prefix = text.slice(0, text.lastIndexOf("\n[文件正文已截断"));
            expect(large.startsWith(prefix)).toBe(true);
            expect(/[\uD800-\uDFFF]/u.test(prefix)).toBe(false);
            expect(clipped.structuredContent?.content).toBe(large);
            const empty = await read(4, { path: "empty" });
            expect(empty.content[0]?.text).toBe("[空文件]");
            expect(empty.structuredContent?.content).toBe("");
            for (const [index, args] of [{ path: "missing" }, { path: "small.sources", layer_name: "other" }].entries()) {
                const error = await read(index + 5, args);
                expect(error.isError).toBe(true);
                expect(error.structuredContent?.content).toBeUndefined();
            }
        } finally {
            fixture.close();
            if (stack.layers.has("files")) await stack.removeLayer("files", { destroy: true });
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("text batches read bounded local file previews without loading the full file", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-mcp-read-preview-"));
        const stack = new RuntimeStack();
        const fixture = mcpFixture(stack);
        const driver = new LocalRuntimeDriver({ cwd: dir });
        try {
            writeFileSync(join(dir, "large data"), "preview-start\n" + "x".repeat(100_000) + "\npreview-end");
            await stack.addLayer("bounded-read", driver);
            driver.fs.readFile = async () => { throw new Error("Full file read must not run"); };
            fixture.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "run_batch", arguments: { layer: "bounded-read", output: "text", steps: [
                    { id: "read", kind: "read", path: "large data" },
                ] },
            } });
            const { result } = await waitId(fixture, 1) as { result: { content: Array<{ text: string }> } };
            const text = result.content[0]!.text;
            expect(text).toContain("status=ok");
            expect(text).toContain("preview-start");
            expect(text).toContain("采集阶段已截断");
            expect(text).not.toContain("preview-end");
            expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(8 * 1024);
        } finally {
            fixture.close();
            await stack.removeLayer("bounded-read", { destroy: true });
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("run_command text preserves multiline stdout within 8 KiB and provides stderr", async () => {
        const f = mcpFixture();
        try {
            const stdout = `FIRST\n${"x".repeat(7000)}\nLAST\n`;
            f.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_command", arguments: {
                command: `printf '%s' '${stdout}'; printf 'ERR_LINE\\n' >&2; exit 3`,
            } } });
            const { result } = (await waitId(f, 1)) as { result: { content: Array<{ text: string }>; structuredContent: { stdout: string } } };
            expect(result.content[0]!.text).toContain(`exit=3\nstdout:\n${stdout}\nstderr:\nERR_LINE`);
            expect(result.structuredContent.stdout).toBe(stdout);
        } finally { f.close(); }
    }, 15_000);

    test.skipIf(process.platform !== "win32")("push_ssh reaches the jump port through native Windows OpenSSH", async () => {
        let connections = 0;
        const proxy = createServer((socket) => { connections++; socket.destroy(); });
        await new Promise<void>((resolve, reject) => {
            proxy.once("error", reject);
            proxy.listen(0, "127.0.0.1", resolve);
        });
        const f = mcpFixture();
        try {
            const address = proxy.address();
            if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
            const jumps = [`localhost:${address.port}`, `probe@127.0.0.1:${address.port}`];
            for (const [index, jump] of jumps.entries()) {
                const id = index + 1;
                f.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "push_ssh", arguments: { host: "127.0.0.1", jump } } });
                const response = await waitId(f, id);
                // Reaching the listener proves the native client parsed the jump address.
                expect(response.result).toMatchObject({ isError: true });
                expect(connections).toBe(id);
            }
        } finally {
            f.close();
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
        }
    }, 25_000);

    test("AC-01 initialize 握手：协议版本+capabilities+serverInfo", async () => {
        const f = mcpFixture();
        f.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        const r = await waitId(f, 1);
        const res = (r as { result: { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string } } }).result;
        expect(res.protocolVersion).toBe("2025-06-18");
        expect(res.capabilities.tools).toBeTruthy();
        expect(res.serverInfo.name).toContain("filaxis");
        // 通知无响应
        f.write({ jsonrpc: "2.0", method: "notifications/initialized" });
        await new Promise((r2) => setTimeout(r2, 30));
        expect(f.collect().length).toBe(1); // 仍只有 initialize 的响应
        f.close();
    });

    test("AC-02 tools/list 与 TOOL_DEFS 零漂移（同源投影非复制）", async () => {
        const f = mcpFixture();
        f.write({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        const r = await waitId(f, 1);
        const tools = (r as { result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } }).result.tools;
        expect(tools.length).toBe(TOOL_DEFS.length);
        expect(tools.map((t) => t.name)).toEqual(TOOL_DEFS.map((d) => d.function.name)); // 同序同名
        // schema 同源断言：inputSchema 即 function.parameters（漂移即红）
        for (let i = 0; i < tools.length; i++) {
            expect(tools[i]!.inputSchema).toEqual(TOOL_DEFS[i]!.function.parameters);
        }
        // 核心六工具在场
        for (const n of ["run_command", "read_file", "edit_file", "put_file", "get_file", "observe_stream", "spawn_and_observe", "stop_and_verify"]) {
            expect(tools.map((t) => t.name)).toContain(n);
        }
        f.close();
    });

    test("AC-03 结构化编辑单轮：对象参数多行/引号/缩进 100% 保真", async () => {
        const d = mkdtempSync(join(tmpdir(), "fx-mcp-edit-"));
        const p = join(d, "routes.json").replace(/\\/g, "/");
        // 第八季盲测同款：JSON 同字段跨行消歧场景（多行 old 含引号+缩进）
        const content = '{\n  "routes": [\n    { "path": "/api/v1", "strip_prefix": false },\n    { "path": "/api/v2", "strip_prefix": false }\n  ]\n}\n';
        writeFileSync(p, content);
        const f = mcpFixture();
        // 多行 old（第二处的上下文消歧）+引号+缩进——结构化直达不经宿主 Shell
        const old2 = '{ "path": "/api/v2", "strip_prefix": false }';
        const new2 = '{ "path": "/api/v2", "strip_prefix": true }';
        for (const [index, invalid] of [
            { layer: "" }, { layer_name: "elsewhere" }, { old: "", all: true }, { all: "false" }, { write_mode: "typo" },
        ].entries()) {
            const id = index + 10;
            f.write({ jsonrpc: "2.0", id, method: "tools/call", params: {
                name: "edit_file", arguments: { path: p, old: old2, new: new2, ...invalid },
            } });
            expect((await waitId(f, id)).result).toMatchObject({ isError: true });
        }
        expect(readFileSync(p, "utf8")).toBe(content);
        f.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit_file", arguments: { path: p, old: old2, new: new2 } } });
        const r = await waitId(f, 1);
        const res = (r as { result: { isError: boolean; structuredContent: { occurrences: number } } }).result;
        expect(res.isError).toBeFalse(); // 1 轮完成（CLI argv 路径 32 轮）
        expect(res.structuredContent.occurrences).toBe(1);
        const after = (await import("node:fs")).readFileSync(p, "utf-8");
        expect(after).toContain('"strip_prefix": true'); // 替换生效
        expect(after).toContain('"strip_prefix": false'); // 第一处未误伤
        f.close();
        rmSync(d, { recursive: true, force: true });
    }, 15_000);

    test("AC-05 错误透传：未命中 isError + 消息原样（可程序化分支）", async () => {
        const d = mkdtempSync(join(tmpdir(), "fx-mcp-miss-"));
        const p = join(d, "x.txt").replace(/\\/g, "/");
        writeFileSync(p, "hello\n");
        const f = mcpFixture();
        f.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit_file", arguments: { path: p, old: "NOT_PRESENT", new: "y" } } });
        const r = await waitId(f, 1);
        const res = (r as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
        expect(res.isError).toBeTrue();
        expect(res.content[0]!.text).toContain("未命中"); // 语义保留非泛化
        f.write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
            name: "edit_file", arguments: { path: p, hunks: [{ old: "hello", new: "changed" }] },
        } });
        expect(await waitId(f, 2)).toMatchObject({
            result: { isError: true, content: [{ text: expect.stringContaining('未知参数："hunks"') }] },
        });
        expect(readFileSync(p, "utf8")).toBe("hello\n");
        f.close();
        rmSync(d, { recursive: true, force: true });
    });

    test("未知工具/未知方法/坏 JSON：JSON-RPC 标准错误", async () => {
        const f = mcpFixture();
        f.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
        f.write({ jsonrpc: "2.0", id: 2, method: "resources/list" });
        const r1 = await waitId(f, 1);
        const r2 = await waitId(f, 2);
        const rs = [r1, r2];
        const unknownTool = rs.find((x) => (x as { id?: number }).id === 1) as { error: { code: number; message: string; data?: { available: string[] } } };
        expect(unknownTool.error.code).toBe(-32602);
        expect(unknownTool.error.message).toContain("no_such_tool");
        expect(unknownTool.error.data!.available).toContain("run_command");
        const unknownMethod = rs.find((x) => (x as { id?: number }).id === 2) as { error: { code: number } };
        expect(unknownMethod.error.code).toBe(-32601);
        f.close();
    });

    test("AC-04 会话链跨调用：spawn→stop 按返回 session_id 串起", async () => {
        const f = mcpFixture();
        f.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "spawn_and_observe", arguments: { command: "echo READY; sleep 10", ready_marker: "READY", ready_timeout_ms: 6000 } } });
        const spawnR = await waitId(f, 1, 20_000);
        const spawnRes = spawnR as { result: { structuredContent: { session_id: string; note?: string } } };
        const sid = spawnRes.result.structuredContent.session_id;
        expect(sid).toBeTruthy();
        expect(spawnRes.result.structuredContent.note).toBe("ready");
        f.write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stop_and_verify", arguments: { session_id: sid } } });
        const stopR = await waitId(f, 2, 20_000);
        const stopRes = stopR as { result: { structuredContent: { status: string } } };
        expect(["stopped", "exited", "unknown"]).toContain(stopRes.result.structuredContent.status); // 三态可辨
        f.close();
    }, 20_000);

    test("a text-only client can verify a naturally exited session using the full launch handle", async () => {
        const stack = new RuntimeStack();
        const driver = new LocalRuntimeDriver();
        await stack.addLayer("fixture", driver);
        const fixture = mcpFixture(stack);
        const call = async (id: number, name: string, args: Record<string, unknown>) => {
            fixture.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
            return (await waitId(fixture, id, 10_000)).result as {
                isError: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown>;
            };
        };
        try {
            const launched = await call(1, "spawn_and_observe", {
                command: "echo READY; sleep 1; exit 7", ready_marker: "READY", name: "long-session-name",
            });
            expect(launched.isError).toBe(false);
            const handle = Object.fromEntries(launched.content[0]!.text.split("\n").map((line) => line.split("=", 2)));
            const sessionId = handle.session_id!;
            expect(sessionId.length).toBeGreaterThan(24);
            expect(sessionId).toBe(launched.structuredContent.session_id);
            expect(handle.log_base).toBe(launched.structuredContent.log_base);
            const deadline = Date.now() + 10_000;
            let terminal = await driver.verifySession(sessionId);
            while (terminal.status !== "exited" && Date.now() < deadline) {
                await Bun.sleep(25);
                terminal = await driver.verifySession(sessionId);
            }
            expect(terminal).toEqual({ status: "exited", exitCode: 7 });
            const shortened = await call(2, "stop_and_verify", { session_id: sessionId.slice(0, 24) });
            expect(shortened.content[0]!.text).toContain("status=unknown\nnote=会话归属未知或已过期");
            const result = await call(3, "stop_and_verify", { session_id: sessionId });
            expect(result.structuredContent).toEqual({ status: "exited", exit_code: 7 });
            expect(result.content[0]!.text).toBe("status=exited\nexit_code=7");
        } finally {
            fixture.close();
            await stack.removeLayer("fixture", { destroy: true });
        }
    }, 20_000);

    test("a failed readiness check returns full handle and unknown outcome in the text block", async () => {
        const stack = new RuntimeStack();
        const sessionId = "ready-fixture-0123456789abcdef0123456789abcdef";
        const logBase = "/tmp/filaxis-sessions/" + sessionId;
        const driver = {
            execSession: async () => ({ sessionId, logBase, pid: 123 }),
            tailSession: async () => [],
            stopSession: async () => ({ status: "exited", exitCode: null }),
            verifySession: async () => ({ status: "exited", exitCode: null }),
        } as unknown as import("../src/driver.js").RuntimeDriver;
        const fixture = mcpFixture(stack, createAgentToolkit(stack, { driver, readyTimeoutMs: 5 }));
        try {
            fixture.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "spawn_and_observe", arguments: { command: "fixture", ready_marker: "READY" },
            } });
            const { result } = await waitId(fixture, 1) as { result: {
                isError: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown>;
            } };
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({ outcome: "unknown", sessionId, logBase });
            expect(result.content[0]!.text).toContain(`outcome=unknown\nsession_id=${sessionId}\nlog_base=${logBase}\n`);
        } finally { fixture.close(); }
    });
});

test("remove_layer returns all unresolved session handles via MCP", async () => {
    const stack = new RuntimeStack();
    const sessions = [{ sessionId: "fixture", logBase: "/tmp/fixture" }];
    const driver = {
        descriptor: { driver: "tmux" },
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        destroy: async () => { throw Object.assign(new Error("cleanup unknown"), { outcome: "unknown", sessions }); },
    } as unknown as import("../src/driver.js").RuntimeDriver;
    await stack.addLayer("owned", driver);
    const fixture = mcpFixture(stack);
    try {
        fixture.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
            name: "remove_layer", arguments: { name: "owned", destroy: true },
        } });
        expect(await waitId(fixture, 1)).toMatchObject({
            result: { isError: true, structuredContent: { outcome: "unknown", sessions } },
        });
    } finally {
        fixture.close();
    }
});

test("MCP opens, reads, and closes a continuous window by ID", async () => {
    const fixture = mcpFixture();
    const call = async (id: number, name: string, args: Record<string, unknown>) => {
        fixture.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
        return (await waitId(fixture, id)).result as {
            isError: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown>;
        };
    };
    try {
        expect((await call(0, "observe_stream", { command: "echo LEGACY", duration_ms: 10 })).isError).toBe(true);
        const opened = await call(1, "observe_stream", { command: "echo MCP_WINDOW" });
        expect(opened.isError).toBe(false);
        const window_id = opened.structuredContent.window_id;
        const read = await call(2, "read_stream", { window_id, since_seq: 0, wait_ms: 5000 });
        expect(read.structuredContent).toMatchObject({ frames: [{ text: "MCP_WINDOW", stream: "stdout", seq: 1 }] });
        expect(read.content[0]!.text).toContain("[1 stdout] MCP_WINDOW");
        expect(read.content[0]!.text).toContain("last_delivered_seq=1");
        const closed = await call(3, "close_stream", { window_id });
        expect(closed.structuredContent).toEqual({ window_id, closed: true });
        expect((await call(4, "read_stream", { window_id })).isError).toBe(true);
    } finally {
        fixture.close();
    }
}, 20_000);

test("read_stream text stays bounded and pages without skipping undisplayed frames", async () => {
    const stack = new RuntimeStack();
    const toolkit = createAgentToolkit(stack);
    const frames = Array.from({ length: 30 }, (_, index) => ({
        seq: index + 1, ts: 0, stream: index === 1 ? "stderr" as const : "stdout" as const,
        text: `line-${index + 1} ` + "雪".repeat(200) + "\u001b[0m",
    }));
    toolkit.handlers.read_stream = async ({ window_id, since_seq, before_seq }) => {
        const page = window_id === "oversized" ? [{ ...frames[0]!, text: "oversized " + "雪".repeat(4000) }, ...frames.slice(1)] : frames;
        const selected = page.filter(({ seq }) => seq > (since_seq ?? 0) && seq < (before_seq ?? Infinity));
        return {
            window_id, oldest_seq: 1, newest_seq: 30, stale: false, frames: selected,
            ...(since_seq === undefined ? {} : { last_delivered_seq: selected.at(-1)?.seq ?? since_seq }),
            ...(selected.length ? {} : { timed_out: true }),
        };
    };
    const fixture = mcpFixture(stack, toolkit);
    const read = async (id: number, args: Record<string, number>, window_id = "fixture") => {
        fixture.write({ jsonrpc: "2.0", id, method: "tools/call", params: {
            name: "read_stream", arguments: { window_id, ...args },
        } });
        const result = (await waitId(fixture, id)).result as {
            content: Array<{ text: string }>;
            structuredContent: Awaited<ReturnType<typeof toolkit.handlers.read_stream>>;
        };
        const text = result.content[0]!.text;
        expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(8192);
        return { text, structured: result.structuredContent };
    };
    try {
        const first = await read(1, { since_seq: 0 });
        expect(first.structured).toEqual({
            window_id: "fixture", oldest_seq: 1, newest_seq: 30, stale: false, frames, last_delivered_seq: 30,
        });
        expect(first.text).toContain("text_truncated=true");
        expect(first.text).toContain("[2 stderr] line-2");
        expect(first.text).toContain("\\u001b[0m");
        const cursor = Number(first.text.match(/last_delivered_seq=(\d+)/)?.[1]);
        expect(cursor).toBeGreaterThan(2);
        expect(cursor).toBeLessThan(30);
        expect((await read(2, { since_seq: cursor })).text).toContain(`[${cursor + 1} stdout] line-${cursor + 1} `);

        const backwards = await read(3, { before_seq: 30 });
        const firstSeq = Number(backwards.text.match(/first_frame_seq=(\d+)/)?.[1]);
        expect(firstSeq).toBeGreaterThan(1);
        expect(backwards.text).toContain("[29 stdout] line-29 ");
        expect((await read(4, { before_seq: firstSeq })).text).toContain(`[${firstSeq - 1} stdout] line-${firstSeq - 1} `);
        const empty = await read(5, { since_seq: 30 });
        expect(empty.text).toContain("last_delivered_seq=30");
        expect(empty.text).toContain("timed_out=true");
        const oversized = await read(6, { since_seq: 0 }, "oversized");
        expect(oversized.text).toContain("frame_truncated=true");
        expect(oversized.text).toContain("last_delivered_seq=1");
        expect(oversized.text).toContain("[1 stdout] oversized");
        expect(oversized.structured.frames[0]?.text).toHaveLength(4010);
        expect((await read(7, { since_seq: 1 }, "oversized")).text).toContain("[2 stderr] line-2");
    } finally {
        fixture.close();
    }
});

describe("MCP layer array fan-out", () => {
    test("push_ssh validates all batch targets and reports usable layers after partial failure", async () => {
        const stack = new RuntimeStack();
        const addLayer = stack.addLayer.bind(stack);
        const attempted: Array<{ name: string; descriptor: Parameters<RuntimeStack["addLayer"]>[1] }> = [];
        stack.addLayer = async (name, descriptor) => {
            attempted.push({ name, descriptor });
            if (name === "unreachable") throw new Error("fixture connection failed");
            if (name === "same-host") return { handle: stack.layer("web"), reused: true, reusedFrom: "web" };
            return addLayer(name, new LocalRuntimeDriver());
        };
        const f = mcpFixture(stack);
        const call = async (id: number, name: string, args: Record<string, unknown>) => {
            f.write({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
            return (await waitId(f, id)).result;
        };
        try {
            const invalid = [
                { targets: [] },
                { targets: ["web", { host: "other", name: "web" }] },
                { targets: ["web", { host: "db", port: 0 }] },
                { targets: ["web", { host: "db", jump: "one,two" }] },
                { targets: ["web", { host: "deploy@db", user: "other" }] },
                { targets: ["web", "deploy@"] },
                { targets: ["web", { host: "db", name: "db\n01" }] },
                { targets: ["web"], host: "db" },
                { hosts: ["web"] },
            ];
            for (const [index, args] of invalid.entries()) {
                expect(await call(index, "push_ssh", args)).toMatchObject({ isError: true });
            }
            expect(attempted).toHaveLength(0);
            expect(await call(10, "push_ssh", { targets: [
                "web", "unreachable", { host: "db", name: "database", port: 2222, user: "deploy", jump: "bastion" }, "same-host",
            ] })).toMatchObject({
                isError: false,
                content: [{ text: expect.stringContaining("[fail] unreachable | fixture connection failed") }],
                structuredContent: {
                    status: "partial",
                    active_layer: "database",
                    layers: ["web", "database"],
                    results: [
                        { host: "web", name: "web", status: "ok", layer: "web", reused: false },
                        { host: "unreachable", status: "fail" },
                        { host: "db", name: "database", status: "ok", layer: "database", reused: false },
                        { host: "same-host", status: "ok", layer: "web", reused: true, reused_from: "web" },
                    ],
                },
            });
            expect(attempted[2]).toEqual({
                name: "database",
                descriptor: { driver: "ssh", target: "db", config: { connParams: { port: 2222, user: "deploy", jump: "bastion" } } },
            });
            expect(await call(11, "push_ssh", { targets: ["unreachable"] })).toMatchObject({
                structuredContent: { status: "fail", layers: [], active_layer: "database" },
            });
            expect(await call(12, "push_ssh", { host: "single" })).toMatchObject({
                structuredContent: { layer: "single", reused: false },
            });
        } finally {
            f.close();
            await Promise.all([...stack.layers.keys()].map((name) => stack.removeLayer(name, { destroy: true })));
        }
    });

    test("tools/list exposes string | string[] schema for run_batch layer and step layer", async () => {
        const f = mcpFixture();
        try {
            f.write({ jsonrpc: "2.0", id: 1, method: "tools/list" });
            const { result } = await waitId(f, 1) as {
                result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> };
            };
            const batchTool = result.tools.find((t) => t.name === "run_batch")!;
            const expectedAnyOf = [
                { type: "string", minLength: 1, pattern: "\\S" },
                { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, pattern: "\\S" } },
            ];
            expect(batchTool.inputSchema.properties.layer).toMatchObject({ anyOf: expectedAnyOf });
            const stepsSchema = batchTool.inputSchema.properties.steps as {
                items: { properties: Record<string, unknown> };
            };
            expect(stepsSchema.items.properties.layer).toMatchObject({ anyOf: expectedAnyOf });
        } finally { f.close(); }
    });

    test("run_batch fans out layer array in full and text modes and divides bounded output budget", async () => {
        const stack = new RuntimeStack();
        const first = new LocalRuntimeDriver();
        const second = new LocalRuntimeDriver();
        const maxBytesSeen: number[] = [];
        const origFirstExec = first.exec.bind(first);
        const origSecondExec = second.exec.bind(second);
        first.exec = (cmd, opts) => {
            if (opts?.maxOutputBytes !== undefined) maxBytesSeen.push(opts.maxOutputBytes);
            return origFirstExec(cmd, opts);
        };
        second.exec = (cmd, opts) => {
            if (opts?.maxOutputBytes !== undefined) maxBytesSeen.push(opts.maxOutputBytes);
            return origSecondExec(cmd, opts);
        };
        await stack.addLayer("first", first);
        await stack.addLayer("second", second);
        const f = mcpFixture(stack);
        try {
            const steps = [{ id: "fan", kind: "exec", command: "printf 'LINE_%s' 'ok'" }];
            f.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "run_batch", arguments: { layer: ["first", "second"], steps },
            } });
            const fullRes = (await waitId(f, 1, 20_000)).result as {
                isError: boolean;
                content: Array<{ text: string }>;
                structuredContent: { status: string; steps: Array<{ id: string; layer?: string; stdout?: string }> };
            };
            expect(fullRes.isError).toBe(false);
            expect(fullRes.content[0]!.text).toContain("fan@first (exec) | status=ok | layer=first");
            expect(fullRes.content[0]!.text).toContain("fan@second (exec) | status=ok | layer=second");
            expect(fullRes.structuredContent).toMatchObject({
                status: "ok",
                steps: [
                    { id: "fan@first", layer: "first", stdout: "LINE_ok" },
                    { id: "fan@second", layer: "second", stdout: "LINE_ok" },
                ],
            });

            // text mode: 1 exec step across 2 layers = 4 streams → 4096 / 4 = 1024 bytes per stream
            const textSteps = [{ id: "bounded", kind: "exec", command: `printf '%s' '${"A".repeat(1500)}'` }];
            f.write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
                name: "run_batch", arguments: { layer: ["first", "second"], steps: textSteps, output: "text" },
            } });
            const textRes = (await waitId(f, 2, 20_000)).result as {
                isError: boolean;
                content: Array<{ text: string }>;
            };
            expect(textRes.isError).toBe(false);
            expect(textRes).not.toHaveProperty("structuredContent");
            expect(maxBytesSeen).toEqual([1024, 1024]);
            expect(textRes.content[0]!.text).toContain("bounded@first (exec) | status=ok | layer=first");
            expect(textRes.content[0]!.text).toContain("bounded@second (exec) | status=ok | layer=second");
            expect(textRes.content[0]!.text).toContain("[采集阶段已截断 ");
        } finally {
            f.close();
            await stack.removeLayer("first", { destroy: true });
            await stack.removeLayer("second", { destroy: true });
        }
    }, 30_000);

    test("run_command rejects array layer and points caller to run_batch", async () => {
        const f = mcpFixture();
        try {
            f.write({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "run_command", arguments: { command: "echo hi", layer: ["a", "b"] },
            } });
            const res = (await waitId(f, 1)).result as { isError: boolean; content: Array<{ text: string }> };
            expect(res.isError).toBe(true);
            expect(res.content[0]!.text).toContain("run_batch");
        } finally { f.close(); }
    });
});
