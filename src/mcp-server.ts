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
import { version } from "../package.json" with { type: "json" };
import { TOOL_DEFS, type AgentToolHandlers, type AgentToolkit } from "./agent-toolkit.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const JSONRPC_VERSION = "2.0";
const COMMAND_PREVIEW_BYTES = 8 * 1024;
const BATCH_PREVIEW_BYTES = 4 * 1024;
const BATCH_TEXT_JSON_BYTES = 8 * 1024;
const BATCH_DETAIL_BYTES = 1024;
const FULL_OUTPUT_HINT = "，完整输出见 structuredContent";

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
        this.version = opts.serverVersion ?? version;
        this.log = opts.logger ?? noopLogger;
        this.out = opts.stdout ?? process.stdout;
        const input = opts.stdin ?? process.stdin;
        this.rl = readline.createInterface({ input, terminal: false });
        this.rl.on("line", (line) => this.onLine(line));
        this.rl.on("close", () => {
            // 连接断开=客户端退出：进程内 toolkit 状态（会话句柄）交还内核 TTL 回收
            this.tk.dispose?.();
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
            // 兜底 parse 防炸（Sol 55 P1-B）：畸形串的 id 片段可能截出半个字符串——
            // 二次 JSON.parse 再抛即逃出监听器崩进程；失败 id=null 照常回错
            let id: number | string | null = null;
            if (idMatch) {
                try { id = JSON.parse(idMatch[1]!) as number | string; } catch { id = null; }
            }
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
                        "【先看这行】多文件读取/多命令巡检/同命令发往多层/定位排查 → 优先 run_batch（一次调用并行打包，支持传 layer 数组自动扇出，不要逐个工具循环）；读工具 schema 时同轮并发读取（逐个读每步一趟 LLM）；",
                        "持续查看日志 → observe_stream 开窗、read_stream 回看或续读、close_stream 关闭；等就绪或错误模式 → spawn_and_observe；",
                        "edit_file 支持 write_mode:'inplace'（bind mount 保 inode 免重启）；",
                        "在 MCP 服务主机与目标层之间传输文件用 put_file 和 get_file。",
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
                if (!TOOL_DEFS.some((d) => d.function.name === name) || typeof handler !== "function") {
                    this.replyErr(id, -32602, `Unknown tool: ${name}`, { available: TOOL_DEFS.map((d) => d.function.name) });
                    return;
                }
                const textOnlyBatch = name === "run_batch" && args.output === "text";
                try {
                    if (typeof args !== "object" || Array.isArray(args)) throw new Error(`${name} 的 arguments 需为对象`);
                    const r = await handler(args);
                    // Some clients only expose content, so include bounded command output there.
                    this.reply(id, {
                        content: [{ type: "text", text: summarizeToolResult(name, r, textOnlyBatch) }],
                        ...(textOnlyBatch ? {} : { structuredContent: r }),
                        isError: false,
                    });
                } catch (e) {
                    // 错误透传（FEAT-03）：isError + 消息原样（EditConflictError/
                    // 未命中/unknown 终态可程序化分支，不吞成泛化字符串）
                    const err = (e !== null && typeof e === "object" ? e : {}) as {
                        outcome?: string;
                        terminalId?: string;
                        sessionId?: string;
                        logBase?: string;
                        sessions?: Array<{ sessionId: string; logBase: string }>;
                        exitCode?: number | null;
                    };
                    const message = e instanceof Error ? e.message : String(e);
                    const details = {
                        outcome: err.outcome,
                        terminalId: err.terminalId,
                        sessionId: err.sessionId,
                        logBase: err.logBase,
                        sessions: err.sessions,
                        exitCode: err.exitCode,
                    };
                    const errorText = textOnlyBatch && err.outcome ? `outcome=${err.outcome}\n${message}` : message;
                    const overflow = name === "run_batch" && jsonStringBytes(errorText) > BATCH_TEXT_JSON_BYTES;
                    this.reply(id, {
                        content: [{ type: "text", text: overflow ? limitBatchText(errorText, textOnlyBatch ? "" : FULL_OUTPUT_HINT) : errorText }],
                        isError: true,
                        ...(!textOnlyBatch && (overflow || Object.values(details).some((value) => value !== undefined))
                            ? { structuredContent: { error: message, ...details } }
                            : {}),
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

function summarizeToolResult(name: string, value: unknown, textOnlyBatch: boolean): string {
    if (name === "list_layers") {
        const result = value as Awaited<ReturnType<AgentToolHandlers["list_layers"]>>;
        return result.text;
    }
    if (name === "run_command") {
        const result = value as Awaited<ReturnType<AgentToolHandlers["run_command"]>>;
        return [`exit=${result.exit_code}`, ...outputPreviews(result, COMMAND_PREVIEW_BYTES)].join("\n");
    }
    if (name === "run_batch") {
        const result = value as Awaited<ReturnType<AgentToolHandlers["run_batch"]>>;
        const overview = `status=${result.status}${result.failed_step ? ` | failed_step=${result.failed_step}` : ""}`;
        const streams = result.steps.reduce((n, step) => n + Number(!!step.stdout) + Number(!!step.stderr), 0);
        const streamLimit = Math.floor(BATCH_PREVIEW_BYTES / Math.max(1, streams));
        const hint = textOnlyBatch ? "" : FULL_OUTPUT_HINT;
        const steps = result.steps.map((step) => {
            const header = [`${step.id} (${step.kind})`, `status=${step.status}`];
            if (step.layer !== undefined) header.push(`layer=${step.layer}`);
            if (step.exit_code !== undefined) header.push(`exit_code=${step.exit_code}`);
            if (step.outcome) header.push(`outcome=${step.outcome}`);
            if (step.edits) {
                header.push(`replaced=${step.edits.occurrences}`);
                if (step.edits.write_mode) header.push(`write_mode=${step.edits.write_mode}`);
                if (step.edits.mutex) header.push(`mutex=${step.edits.mutex}`);
            }
            if (step.transfer) header.push(transferSummary(step.transfer));
            const details = outputPreviews(step, textOnlyBatch ? Infinity : streamLimit, hint);
            if (step.error) details.push(`error: ${preview(step.error, BATCH_DETAIL_BYTES, hint)}`);
            if (step.skipped_because) details.push(`skipped_because: ${preview(step.skipped_because, BATCH_DETAIL_BYTES, hint)}`);
            return { header: header.join(" | "), details, failed: step.status === "fail", edited: !!step.edits };
        });
        const text = [overview, ...steps.map(({ header, details }) => [header, ...details].join("\n"))].join("\n\n");
        if (jsonStringBytes(text) <= BATCH_TEXT_JSON_BYTES) return text;

        const failed = steps.filter((step) => step.failed);
        const edits = steps.filter((step) => !step.failed && step.edited);
        const rest = steps.filter((step) => !step.failed && !step.edited);
        // On overflow, prioritize failure headers and write guarantees over bulk output.
        const prioritized = [
            ...failed.map((step) => step.header),
            ...edits.map((step) => step.header),
            ...failed.filter((step) => step.details.length).map((step) => [step.header, ...step.details].join("\n")),
            ...rest.map((step) => step.header),
            ...[...edits, ...rest].filter((step) => step.details.length).map((step) => [step.header, ...step.details].join("\n")),
        ];
        return limitBatchText([overview, ...prioritized].join("\n\n"), hint);
    }
    if (name === "put_file" || name === "get_file") {
        const result = value as Awaited<ReturnType<AgentToolHandlers["put_file"]>>;
        return transferSummary(result);
    }
    return summarize(value);
}

function jsonStringBytes(text: string): number {
    return Buffer.byteLength(JSON.stringify(text), "utf8");
}

function limitBatchText(text: string, hint: string): string {
    const suffix = `\n[批次文本达到上限，部分结果已省略${hint}]`;
    let lo = 0;
    let hi = Math.min(text.length, BATCH_TEXT_JSON_BYTES);
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (jsonStringBytes(text.slice(0, mid) + suffix) <= BATCH_TEXT_JSON_BYTES) lo = mid;
        else hi = mid - 1;
    }
    const last = text.charCodeAt(lo - 1);
    if (last >= 0xd800 && last <= 0xdbff) lo--;
    return text.slice(0, lo) + suffix;
}

function transferSummary(result: Awaited<ReturnType<AgentToolHandlers["put_file"]>>): string {
    return `bytes=${result.bytes} | transport=${result.transport} | verification=${result.verification} | write_mode=${result.write_mode}`;
}

function outputPreviews(output: { stdout?: string; stderr?: string }, limit: number, hint = FULL_OUTPUT_HINT): string[] {
    const blocks: string[] = [];
    if (output.stdout) blocks.push(`stdout:\n${preview(output.stdout, limit, hint)}`);
    if (output.stderr) blocks.push(`stderr:\n${preview(output.stderr, limit, hint)}`);
    return blocks;
}

function preview(text: string, limit: number, hint: string): string {
    const total = Buffer.byteLength(text, "utf8");
    if (total <= limit) return text;
    const bytes = Buffer.from(text.slice(0, limit + 1), "utf8");
    let end = limit;
    while ((bytes[end]! & 0xc0) === 0x80) end--;
    return `${bytes.subarray(0, end).toString("utf8")}\n[已截断 ${total - end} 字节${hint}]`;
}

/** 其他工具保留一行摘要。 */
function summarize(r: unknown): string {
    if (r && typeof r === "object") {
        const o = r as Record<string, unknown>;
        // 常见关键读数优先：退出码/命中数/会话 id/行数
        const bits: string[] = [];
        if (o.exit_code !== undefined) bits.push(`exit=${o.exit_code}`);
        if (o.occurrences !== undefined) bits.push(`replaced=${o.occurrences}`);
        if (o.window_id !== undefined) bits.push(`window=${o.window_id}`);
        if (Array.isArray(o.frames)) bits.push(`frames=${o.frames.length}`);
        if (o.session_id !== undefined) bits.push(`session=${String(o.session_id).slice(0, 24)}`);
        if (o.status !== undefined) bits.push(`status=${o.status}`);
        if (Array.isArray(o.lines)) bits.push(`lines=${o.lines.length}`);
        if (o.stdout !== undefined) {
            const head = String(o.stdout).trim().slice(0, 120);
            if (head) bits.push(`stdout: ${head}`);
        }
        if (bits.length > 0) return bits.join(" | ");
    }
    return "ok";
}
