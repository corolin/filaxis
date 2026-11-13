/**
 * MCP Server 单测（REQ-0003：协议合规/schema 零漂移/结构化编辑/错误透传/会话链）
 * 流注入：PassThrough 模拟 stdin/stdout——零真实进程
 */
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { McpServer } from "../src/mcp-server.js";
import { createAgentToolkit, TOOL_DEFS } from "../src/agent-toolkit.js";
import { RuntimeStack } from "../src/runtime-stack.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 驱动 MCP server 的测试替身：write(line) 进请求，collect() 收响应 */
function mcpFixture(): { write: (obj: Record<string, unknown>) => void; collect: () => Array<Record<string, unknown>>; close: () => void } {
    const tk = createAgentToolkit(new RuntimeStack(), {});
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
        expect(tools.length).toBe(TOOL_DEFS.length); // 全暴露（11 件）
        expect(tools.map((t) => t.name)).toEqual(TOOL_DEFS.map((d) => d.function.name)); // 同序同名
        // schema 同源断言：inputSchema 即 function.parameters（漂移即红）
        for (let i = 0; i < tools.length; i++) {
            expect(tools[i]!.inputSchema).toEqual(TOOL_DEFS[i]!.function.parameters);
        }
        // 核心六工具在场
        for (const n of ["run_command", "read_file", "edit_file", "observe_stream", "spawn_and_observe", "stop_and_verify"]) {
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
});
