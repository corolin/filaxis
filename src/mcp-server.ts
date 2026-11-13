/**
 * mcp-server.ts — stdio MCP Server 薄壳（REQ-0003：Agent 工具面的结构化原生入口）
 *
 * 手写 JSON-RPC 2.0 子集，零 npm 依赖（内核零依赖红线扩展到宿主面——CLI 手写
 * argv 是先例）。实现 MCP 协议子集：initialize（版本协商+capabilities）/
 * tools/list / tools/call。工具面单一来源：TOOL_DEFS 同源序列化、handlers
 * 直派发——壳零业务逻辑。
 *
 * 协议要点（Model Context Protocol stdio transport）：
 * - 行分帧：每行一个 JSON-RPC 消息（\n 分隔；stdout 仅写响应，日志走 stderr）
 * - initialize 握手：protocolVersion 协商 + serverInfo + capabilities.tools
 * - notifications/initialized 单向通知（无响应）
 * - tools/call 响应：content[].type="text" + structuredContent（MCP 2025 版）
 *   + isError（handler 抛错时 true——错误语义透传不吞成泛化字符串）
 * - 层绑定：构造传入已建 toolkit（启动参数定层与 CLI --host 同语义）
 */

import * as readline from "node:readline";
import { TOOL_DEFS, type AgentToolkit } from "./agent-toolkit.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const JSONRPC_VERSION = "2.0";

interface JsonRpcRequest {
    jsonrpc: string;
    id?: number | string | null;
    method: string;
    params?: Record<string, unknown>;
}

interface JsonRpcNotification {
    jsonrpc: string;
    method: string; // 无 id=通知（无响应）
    params?: Record<string, unknown>;
}

export interface McpServerOptions {
    /** 已装配的 toolkit（层绑定在构造前完成——与 CLI --host 同语义） */
    toolkit: AgentToolkit;
    serverName?: string;
    serverVersion?: string;
    logger?: FilaxisLogger;
    /** 输出流（缺省 process.stdout；测试注入） */
    stdout?: NodeJS.WritableStream;
    /** 输入流（缺省 process.stdin；测试注入） */
    stdin?: NodeJS.ReadableStream;
}

export class McpServer {
    private readonly tk: AgentToolkit;
    private readonly name: string;
    private readonly version: string;
    private readonly log: FilaxisLogger;
    private readonly out: NodeJS.WritableStream;
    private initialized = false;
    private rl?: readline.Interface;

    constructor(opts: McpServerOptions) {
        this.tk = opts.toolkit;
        this.name = opts.serverName ?? "@syrkos/filaxis";
        this.version = opts.serverVersion ?? "0.1.0";
        this.log = opts.logger ?? noopLogger;
        this.out = opts.stdout ?? process.stdout;
        const input = opts.stdin ?? process.stdin;
        this.rl = readline.createInterface({ input, terminal: false });
        this.rl.on("line", (line) => this.onLine(line));
        this.rl.on("close", () => {
            // 连接断开=客户端退出：进程内 toolkit 状态（会话句柄）交还内核 TTL 回收
            this.log.info("[mcp] stdin 关闭——server 退出");
        });
    }

    private write(msg: Record<string, unknown>): void {
        this.out.write(JSON.stringify(msg) + "\n");
    }

    private reply(id: number | string | null, result: Record<string, unknown>): void {
        this.write({ jsonrpc: JSONRPC_VERSION, id, result });
    }

    private replyErr(id: number | string | null, code: number, message: string, data?: unknown): void {
        this.write({ jsonrpc: JSONRPC_VERSION, id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
    }

    private onLine(line: string): void {
        const trimmed = line.trim();
        if (trimmed === "") return;
        let msg: JsonRpcRequest | JsonRpcNotification;
        try {
            msg = JSON.parse(trimmed) as JsonRpcRequest;
        } catch {
            // 解析失败：若可提取 id 则按规范回 Parse error（-32700）
            const idMatch = trimmed.match(/"id"\s*:\s*(\d+|"[^"]*")/);
            const id = idMatch ? JSON.parse(idMatch[1]!) as number | string : null;
            this.replyErr(id, -32700, "Parse error: invalid JSON");
            return;
        }
        if (msg === null || typeof msg !== "object") {
            // JSON null/标量防御（Sol 五十四期 P1-4）：null 是合法 JSON——解析成功
            // 后 `"id" in null` 抛 TypeError 逃出监听器崩进程
            this.replyErr(null, -32600, `Invalid Request: expected object, got ${msg === null ? "null" : typeof msg}`);
            return;
        }
        if (!("id" in msg) || msg.id === undefined || msg.id === null) return; // 通知（notifications/initialized 等）——无响应
        const req = msg as JsonRpcRequest; // id 已非空（上方守卫）
        this.dispatch(req).catch((e) => {
            this.replyErr(req.id!, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
        });
    }

    private async dispatch(req: JsonRpcRequest): Promise<void> {
        const { method } = req;
        const id = (req.id ?? 0) as number | string; // 守卫后非空（通知已 return）
        const params = req.params ?? {};
        switch (method) {
            case "initialize":
                this.initialized = true;
                this.reply(id, {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: this.name, version: this.version },
                    // 首行强提醒（第十二季盲测定性：Lazy schema 下 flash 级模型只读
                    // 几个基础 schema 就动手——高杠杆组合工具被藏视野外。instructions
                    // 在任何 schema 读取之前必达，是唯一可靠的发现面）
                    instructions: [
                        "【先看这行】多文件读取/多命令巡检/定位排查 → 优先 run_batch（一次调用并行打包，不要逐个工具循环）；读工具 schema 时同轮并发读取（逐个读每步一趟 LLM）；",
                        "长跑/挂起/日志尾随 → observe_stream 或 spawn_and_observe（exec 会阻塞超时）；",
                        "edit_file 支持 write_mode:'inplace'（bind mount 保 inode 免重启）；",
                        "契约：退出码是数据（非零不是异常）；终态三态 exited/stopped/unknown；unknown 后用 stop_and_verify 核实。",
                    ].join("\n"),
                });
                return;
            case "tools/list": {
                // 单一来源直序列化（AC-02 零漂移）：OpenAI function 形态 → MCP
                // tools[].{name,description,inputSchema} 投影——字段名映射非复制
                this.reply(id, {
                    tools: TOOL_DEFS.map((d) => ({
                        name: d.function.name,
                        description: d.function.description,
                        inputSchema: d.function.parameters,
                    })),
                });
                return;
            }
            case "tools/call": {
                const name = String(params.name ?? "");
                const args = (params.arguments ?? {}) as Record<string, unknown>;
                const handler = (this.tk.handlers as unknown as Record<string, (a: Record<string, unknown>) => Promise<unknown>>)[name];
                if (!handler) {
                    this.replyErr(id, -32602, `Unknown tool: ${name}`, { available: TOOL_DEFS.map((d) => d.function.name) });
                    return;
                }
                try {
                    const r = await handler(args);
                    // 成功：structuredContent（结构化语义完整保留）+ text 精简摘要。
                    // **不做 JSON.stringify(r) 双序列化**（第十二季盲测定性：同一数据
                    // 发两遍直接推高 output 与下轮 input——响应体积约砍半）；text 是
                    // 规范要求的人类展示面，给关键读数一行摘要即可
                    this.reply(id, {
                        content: [{ type: "text", text: summarize(r) }],
                        structuredContent: r,
                        isError: false,
                    });
                } catch (e) {
                    // 错误透传（FEAT-03）：isError + 消息原样（EditConflictError/
                    // 未命中/unknown 终态可程序化分支，不吞成泛化字符串）
                    const err = e as Error & { outcome?: string; sessionId?: string; logBase?: string };
                    this.reply(id, {
                        content: [{
                            type: "text",
                            text: err.message,
                        }],
                        isError: true,
                        ...(err.outcome !== undefined || err.sessionId !== undefined ? {
                            structuredContent: {
                                error: err.message,
                                ...(err.outcome !== undefined ? { outcome: err.outcome } : {}),
                                ...(err.sessionId !== undefined ? { sessionId: err.sessionId } : {}),
                                ...(err.logBase !== undefined ? { logBase: err.logBase } : {}),
                            },
                        } : {}),
                    });
                }
                return;
            }
            case "ping":
                this.reply(id, {});
                return;
            default:
                this.replyErr(id, -32601, `Method not found: ${method}`);
        }
    }

    /** 测试/优雅收尾：关闭输入监听 */
    close(): void {
        this.rl?.close();
    }


}

/** 工具结果一行摘要（content[].text 展示面——structuredContent 才是数据面） */
function summarize(r: unknown): string {
    if (r && typeof r === "object") {
        const o = r as Record<string, unknown>;
        // 常见关键读数优先：退出码/命中数/会话 id/行数
        const bits: string[] = [];
        if (o.exit_code !== undefined) bits.push(`exit=${o.exit_code}`);
        if (o.occurrences !== undefined) bits.push(`replaced=${o.occurrences}`);
        if (o.session_id !== undefined) bits.push(`session=${String(o.session_id).slice(0, 24)}`);
        if (o.status !== undefined) bits.push(`status=${o.status}`);
        if (Array.isArray(o.lines)) bits.push(`lines=${o.lines.length}`);
        if (o.stdout !== undefined) {
            const head = String(o.stdout).trim().slice(0, 120);
            if (head) bits.push(`stdout: ${head}`);
        }
        if (bits.length > 0) return bits.join(" | ");
    }
    return "ok"; // 无关键读数（list_layers 等）——数据面在 structuredContent
}
