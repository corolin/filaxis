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
import { version } from "../../../package.json" with { type: "json" };
import {
    TOOL_DEFS,
    type AgentEditFileResult,
    type AgentToolHandlers,
    type AgentToolkit,
    type ConnectIntoResult,
    type ConnectSshBatchResult,
    type ConnectSshResult,
    type ManageLayersResult,
    type ManagePathResult,
    type ObserveStreamResult,
    type ReadPathResult,
} from "./agent-toolkit.js";
import { noopLogger, type FilaxisLogger } from "../../shared/logger.js";
import { runWithToolCallContext, type ToolCallContext } from "./call-context.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const JSONRPC_VERSION = "2.0";
const COMMAND_PREVIEW_BYTES = 8 * 1024;
const FILE_TEXT_JSON_BYTES = 8 * 1024;
const BATCH_PREVIEW_BYTES = 4 * 1024;
const BATCH_TEXT_JSON_BYTES = 8 * 1024;
const STREAM_TEXT_JSON_BYTES = 8 * 1024;
const DIRECTORY_TEXT_JSON_BYTES = 8 * 1024;
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

export interface McpProtocolHandlerOptions {
    toolkit: AgentToolkit;
    serverName?: string;
    serverVersion?: string;
}

function makeReply(id: number | string | null, result: Record<string, unknown>): Record<string, unknown> {
    return { jsonrpc: JSONRPC_VERSION, id, result };
}

function makeReplyErr(id: number | string | null, code: number, message: string, data?: unknown): Record<string, unknown> {
    return { jsonrpc: JSONRPC_VERSION, id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** 传输无关的 MCP JSON-RPC 2.0 协议分发器（供 stdio McpServer 与 DaemonServer HTTP/SSE 共用） */
export class McpProtocolHandler {
    private readonly tk: AgentToolkit;
    private readonly name: string;
    private readonly version: string;

    constructor(opts: McpProtocolHandlerOptions) {
        this.tk = opts.toolkit;
        this.name = opts.serverName ?? "@syrkos/filaxis";
        this.version = opts.serverVersion ?? version;
    }

    /** `ctx`：本次请求的调用方基准（进程内形态＝本进程目录）。Daemon 侧按会话传入客户端目录 */
    async handleRawLine(line: string, ctx: ToolCallContext = { cwd: process.cwd() }): Promise<Record<string, unknown> | null> {
        const trimmed = line.trim();
        if (trimmed === "") return null;
        let msg: unknown;
        try {
            msg = JSON.parse(trimmed);
        } catch {
            // 解析失败：若可提取 id 则按规范回 Parse error（-32700）
            const idMatch = trimmed.match(/"id"\s*:\s*(\d+|"[^"]*")/);
            // 兜底 parse 防炸（Sol 55 P1-B）：畸形串的 id 片段可能切出半个字符串——
            // 二次 JSON.parse 再抛即逃出监听器崩进程；失败 id=null 照常回错
            let id: number | string | null = null;
            if (idMatch) {
                try { id = JSON.parse(idMatch[1]!) as number | string; } catch { id = null; }
            }
            return makeReplyErr(id, -32700, "Parse error: invalid JSON");
        }
        return this.handleMessage(msg, ctx);
    }

    async handleMessage(msg: unknown, ctx?: ToolCallContext): Promise<Record<string, unknown> | null> {
        if (msg === null || typeof msg !== "object") {
            // JSON null/标量防御（Sol 五十四期 P1-4）：null 是合法 JSON——解析成功
            // 后 `"id" in null` 抛 TypeError 逃出监听器崩进程
            return makeReplyErr(null, -32600, `Invalid Request: expected object, got ${msg === null ? "null" : typeof msg}`);
        }
        const obj = msg as Record<string, unknown>;
        if (!("id" in obj) || obj.id === undefined || obj.id === null) return null; // 通知（notifications/initialized 等）——无响应
        const req = obj as unknown as JsonRpcRequest;
        const id = (req.id ?? 0) as number | string;
        try {
            return await this.dispatch(req, id, ctx);
        } catch (e) {
            return makeReplyErr(id, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private async dispatch(req: JsonRpcRequest, id: number | string, ctx?: ToolCallContext): Promise<Record<string, unknown>> {
        const { method } = req;
        const params = req.params ?? {};
        switch (method) {
            case "initialize":
                return makeReply(id, {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: this.name, version: this.version },
                    // 首行强提醒（第十二季盲测定性：Lazy schema 下 flash 级模型只读
                    // 几个基础 schema 就动手——高杠杆组合工具被藏视野外。instructions
                    // 在任何 schema 读取之前必达，是唯一可靠的发现面）
                    instructions: [
                        "【先看这行】多文件读取/多命令巡检/同命令发往多层/定位排查 → 优先 run_batch（一次调用并行打包，支持传 layer 数组自动扇出，不要逐个工具循环）；读工具 schema 时同轮并发读取（逐个读每步一趟 LLM）；",
                        "建立或进入命名层（单台/批量 SSH 或 docker/kubectl 内层）→ connect_layer；查询、切换默认层、移除层或管理动态端口转发（-L/-R/-D） → manage_layers。",
                        "管理后台任务或服务（等就绪、按错误模式停止、核实退出码）→ start_session + stop_session。",
                        "实时查看日志或事件流 → observe_stream（传 command 开窗并可 wait_ms 带回首屏帧；传 window_id 按游标续读/回看），close_stream 回收流进程。",
                        "只读查看文件或目录 → read_path；受控 CAS 编辑或直接新建文本 → edit_file（CAS 模式支持 write_mode:'inplace' 保 inode 免重启）；创建目录、移动/重命名或删除（含递归） → manage_path；主机与目标层间传文件 → transfer_file。",
                        "契约：退出码是数据（非零不是异常）；终态三态 exited/stopped/unknown；unknown 后用 stop_session 核实。",
                    ].join("\n"),
                });
            case "tools/list": {
                // 单一来源直序列化（AC-02 零漂移）：OpenAI function 形态 → MCP
                // tools[].{name,description,inputSchema} 投影——字段名映射非复制
                return makeReply(id, {
                    tools: TOOL_DEFS.map((d) => ({
                        name: d.function.name,
                        description: d.function.description,
                        inputSchema: d.function.parameters,
                    })),
                });
            }
            case "tools/call": {
                const name = String(params.name ?? "");
                const args = (params.arguments ?? {}) as Record<string, unknown>;
                const handlersRecord = this.tk.handlers as unknown as Record<string, unknown>;
                const handler = Object.hasOwn(handlersRecord, name) ? handlersRecord[name] : undefined;
                if (typeof handler !== "function") {
                    return makeReplyErr(id, -32602, `Unknown tool: ${name}`, { available: TOOL_DEFS.map((d) => d.function.name) });
                }
                const textOnlyBatch = name === "run_batch" && args.output === "text";
                try {
                    if (typeof args !== "object" || Array.isArray(args)) throw new Error(`${name} 的 arguments 需为对象`);
                    // 工具处理函数从上下文里取调用方基准目录（相对路径、命令工作目录），处理函数签名不变
                    const r = await runWithToolCallContext(ctx, () =>
                        (handler as (a: Record<string, unknown>) => Promise<unknown>)(args));
                    // Some clients only expose content, so include bounded command output there.
                    return makeReply(id, {
                        content: [{ type: "text", text: summarizeToolResult(name, r, textOnlyBatch) }],
                        ...(textOnlyBatch ? {} : { structuredContent: r }),
                        isError: false,
                    });
                } catch (e) {
                    // 错误透传（FEAT-03）：isError + 消息原样（EditConflictError/
                    // 未命中/unknown 终态可程序化分支，不吞成泛化字符串）
                    const err = (e !== null && typeof e === "object" ? e : {}) as {
                        outcome?: string;
                        reason?: string;
                        channel?: string;
                        terminalId?: string;
                        forwardId?: string;
                        sessionId?: string;
                        logBase?: string;
                        sessions?: Array<{ sessionId: string; logBase: string }>;
                        exitCode?: number | null;
                    };
                    const message = e instanceof Error ? e.message : String(e);
                    const details = {
                        outcome: err.outcome,
                        reason: err.reason,
                        channel: err.channel,
                        terminalId: err.terminalId,
                        forwardId: err.forwardId,
                        sessionId: err.sessionId,
                        logBase: err.logBase,
                        sessions: err.sessions,
                        exitCode: err.exitCode,
                    };
                    const evidence: string[] = [];
                    if (typeof err.outcome === "string" && err.outcome) {
                        evidence.push(`outcome=${singleLine(err.outcome)}`);
                    }
                    if (typeof err.reason === "string" && err.reason) evidence.push(`reason=${singleLine(err.reason)}`);
                    if (typeof err.channel === "string" && err.channel) evidence.push(`channel=${singleLine(err.channel)}`);
                    if (typeof err.terminalId === "string" && err.terminalId) {
                        evidence.push(`terminal_id=${singleLine(err.terminalId)}`);
                    }
                    if (typeof err.forwardId === "string" && err.forwardId) {
                        evidence.push(`forward_id=${singleLine(err.forwardId)}`);
                    }
                    if (typeof err.sessionId === "string" && err.sessionId) {
                        evidence.push(`session_id=${singleLine(err.sessionId)}`);
                    }
                    if (typeof err.logBase === "string" && err.logBase) {
                        evidence.push(`log_base=${singleLine(err.logBase)}`);
                    }
                    if (typeof err.exitCode === "number") {
                        evidence.push(`exit_code=${err.exitCode}`);
                    }
                    if (Array.isArray(err.sessions) && err.sessions.length) {
                        const handles = err.sessions
                            .filter((s): s is { sessionId: string; logBase: string } =>
                                Boolean(s && typeof s.sessionId === "string" && typeof s.logBase === "string"))
                            .map((s) => `${singleLine(s.sessionId)} (${singleLine(s.logBase)})`);
                        if (handles.length) evidence.push(`sessions=${handles.join(", ")}`);
                    }
                    const errorText = [...evidence, message].join("\n");
                    const overflow = name === "run_batch" && jsonStringBytes(errorText) > BATCH_TEXT_JSON_BYTES;
                    return makeReply(id, {
                        content: [{ type: "text", text: overflow ? limitBatchText(errorText, textOnlyBatch ? "" : FULL_OUTPUT_HINT) : errorText }],
                        isError: true,
                        ...(!textOnlyBatch && (overflow || Object.values(details).some((value) => value !== undefined))
                            ? { structuredContent: { error: message, ...details } }
                            : {}),
                    });
                }
            }
            case "ping":
                return makeReply(id, {});
            default:
                return makeReplyErr(id, -32601, `Method not found: ${method}`);
        }
    }
}

export class McpServer {
    private readonly tk: AgentToolkit;
    private readonly log: FilaxisLogger;
    private readonly out: NodeJS.WritableStream;
    private readonly protocol: McpProtocolHandler;
    private rl?: readline.Interface;

    constructor(opts: McpServerOptions) {
        this.tk = opts.toolkit;
        this.log = opts.logger ?? noopLogger;
        this.out = opts.stdout ?? process.stdout;
        this.protocol = new McpProtocolHandler({
            toolkit: opts.toolkit,
            serverName: opts.serverName,
            serverVersion: opts.serverVersion,
        });
        const input = opts.stdin ?? process.stdin;
        this.rl = readline.createInterface({ input, terminal: false });
        this.rl.on("line", (line) => {
            void this.protocol.handleRawLine(line).then((resp) => {
                if (resp) this.write(resp);
            });
        });
        this.rl.on("close", () => {
            // 连接断开=客户端退出：进程内 toolkit 状态（会话句柄）交还内核 TTL 回收
            this.tk.dispose?.();
            this.log.info("[mcp] stdin 关闭——server 退出");
        });
    }

    private write(msg: Record<string, unknown>): void {
        this.out.write(JSON.stringify(msg) + "\n");
    }

    /** 测试/优雅收尾：关闭输入监听 */
    close(): void {
        this.rl?.close();
    }
}

function summarizeFileContent(content: string): string {
    if (!content.length) return "[空文件]";
    if (content.length <= FILE_TEXT_JSON_BYTES && jsonStringBytes(content) <= FILE_TEXT_JSON_BYTES) return content;
    return limitText(content, "\n[文件正文已截断，完整正文见 structuredContent.content]", FILE_TEXT_JSON_BYTES);
}

function summarizeToolResult(name: string, value: unknown, textOnlyBatch: boolean): string {
    if (name === "manage_layers") {
        const result = value as ManageLayersResult;
        if (result.action === "list") return result.text;
        if (result.action === "activate") return `active_layer=${singleLine(result.active_layer)}`;
        if (result.action === "remove") return `removed=${singleLine(result.removed)}`;
        if (result.action === "forward_add") {
            const f = result.forward;
            const dst = f.kind === "dynamic" ? "SOCKS5" : `${singleLine(f.target_host ?? "")}:${f.target_port}`;
            return `forward=${singleLine(f.forward_id)} | layer=${singleLine(f.layer ?? "?")} | ${f.kind} ${singleLine(f.bind_addr)}:${f.bind_port} -> ${dst}`;
        }
        if (result.action === "forward_list") {
            if (!result.forwards.length) return "forwards=0";
            return [
                `forwards=${result.forwards.length}`,
                ...result.forwards.map((f) => {
                    const dst = f.kind === "dynamic" ? "SOCKS5" : `${singleLine(f.target_host ?? "")}:${f.target_port}`;
                    const error = f.last_error ? ` | ${singleLine(f.last_error).slice(0, 240)}` : "";
                    return `${singleLine(f.forward_id)} | layer=${singleLine(f.layer ?? "?")} | ${f.kind} ${singleLine(f.bind_addr)}:${f.bind_port} -> ${dst} | ${f.status}${error}`;
                }),
            ].join("\n");
        }
        return `forward_id=${singleLine(result.forward_id)} | status=${result.status}${result.detail ? ` | ${singleLine(result.detail)}` : ""}`;
    }
    if (name === "list_layers") {
        return (value as Awaited<ReturnType<AgentToolHandlers["list_layers"]>>).text;
    }
    if (name === "set_active_layer") {
        return `active_layer=${singleLine((value as Awaited<ReturnType<AgentToolHandlers["set_active_layer"]>>).active_layer)}`;
    }
    if (name === "manage_path") {
        const result = value as ManagePathResult;
        if (result.action === "mkdir") return `created=true | path=${singleLine(result.path)}`;
        if (result.action === "move") return `moved=true | path=${singleLine(result.path)} -> ${singleLine(result.destination)}`;
        return `deleted=true | path=${singleLine(result.path)}${result.recursive ? " | recursive=true" : ""}`;
    }
    if (name === "delete_file") {
        return `deleted=true | path=${singleLine((value as Awaited<ReturnType<AgentToolHandlers["delete_file"]>>).path)}`;
    }
    if (name === "read_path") {
        const result = value as ReadPathResult;
        if (result.type === "directory") return summarizeDirectory(result);
        return summarizeFileContent(result.content);
    }
    if (name === "read_file") {
        return summarizeFileContent((value as Awaited<ReturnType<AgentToolHandlers["read_file"]>>).content);
    }
    if (name === "list_directory") {
        return summarizeDirectory(value as Awaited<ReturnType<AgentToolHandlers["list_directory"]>>);
    }
    if (name === "edit_file") {
        const result = value as AgentEditFileResult;
        if (result.mode === "write") {
            return `created=${result.created} | bytes=${result.bytes_after} | path=${singleLine(result.path)}`;
        }
        const bits = [`replaced=${result.occurrences}`];
        if (result.write_mode) bits.push(`write_mode=${result.write_mode}`);
        if (result.mutex) bits.push(`mutex=${result.mutex}`);
        return bits.join(" | ");
    }
    if (name === "start_session" || name === "spawn_and_observe") {
        const result = value as Awaited<ReturnType<AgentToolHandlers["start_session"]>>;
        const lines = [`session_id=${singleLine(result.session_id)}`, `log_base=${singleLine(result.log_base)}`];
        if (result.note) lines.push(`note=${singleLine(result.note)}`);
        return lines.join("\n");
    }
    if (name === "stop_session" || name === "stop_and_verify") {
        const result = value as Awaited<ReturnType<AgentToolHandlers["stop_session"]>>;
        const lines = [`status=${result.status}`];
        if (result.exit_code != null) lines.push(`exit_code=${result.exit_code}`);
        if (result.note) lines.push(`note=${singleLine(result.note)}`);
        return lines.join("\n");
    }
    if (name === "run_command") {
        const result = value as Awaited<ReturnType<AgentToolHandlers["run_command"]>>;
        return [`exit=${result.exit_code}`, ...outputPreviews(result, COMMAND_PREVIEW_BYTES)].join("\n");
    }
    if (name === "observe_stream" || name === "read_stream") {
        return summarizeStreamRead(value as ObserveStreamResult);
    }
    if (name === "connect_layer" || name === "push_ssh") {
        const result = value as ConnectSshResult | ConnectSshBatchResult | ConnectIntoResult;
        if ("results" in result) {
            const overview = `status=${result.status}${result.active_layer ? ` | active_layer=${singleLine(result.active_layer)}` : ""}`;
            const lines = result.results.map((target) => target.status === "ok"
                ? `[ok] ${singleLine(target.name)} | layer=${singleLine(target.layer)} | reused=${target.reused}`
                : `[fail] ${singleLine(target.name)} | ${singleLine(preview(target.error, BATCH_DETAIL_BYTES, FULL_OUTPUT_HINT))}`);
            const summary = [overview, ...lines].join("\n");
            return jsonStringBytes(summary) <= BATCH_TEXT_JSON_BYTES ? summary : limitBatchText(summary, FULL_OUTPUT_HINT);
        }
        if ("reused" in result) return `layer=${singleLine(result.layer)} | reused=${result.reused}`;
        return `layer=${singleLine(result.layer)}`;
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
            if (step.reason) header.push(`reason=${singleLine(step.reason)}`);
            if (step.channel) header.push(`channel=${singleLine(step.channel)}`);
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
        return transferSummary(value as Awaited<ReturnType<AgentToolHandlers["put_file"]>>);
    }
    if (name === "transfer_file") {
        const result = value as Awaited<ReturnType<AgentToolHandlers["transfer_file"]>>;
        return `direction=${result.direction} | ${transferSummary(result)}`;
    }
    return summarize(value);
}

function summarizeDirectory(result: { path: string; entries: Array<{ name: string; isDirectory: boolean }> }): string {
    const header = `path=${singleLine(result.path)} | entries=${result.entries.length}`;
    const omitted = "\n[目录文本达到上限，完整结果见 structuredContent]";
    const omittedBytes = jsonStringBytes(omitted) - 2;
    let remaining = DIRECTORY_TEXT_JSON_BYTES - jsonStringBytes(header);
    if (remaining < 0) return limitText(header, omitted, DIRECTORY_TEXT_JSON_BYTES);
    const lines = [header];
    for (const [index, entry] of result.entries.entries()) {
        const line = `${entry.isDirectory ? "dir" : "file"} ${singleLine(entry.name)}`;
        const bytes = jsonStringBytes(`\n${line}`) - 2;
        const reserve = index < result.entries.length - 1 ? omittedBytes : 0;
        if (bytes + reserve > remaining) {
            return remaining >= omittedBytes ? lines.join("\n") + omitted : limitText(header, omitted, DIRECTORY_TEXT_JSON_BYTES);
        }
        lines.push(line);
        remaining -= bytes;
    }
    return lines.join("\n");
}

function summarizeStreamRead(result: ObserveStreamResult): string {
    const { frames, last_delivered_seq: cursor } = result;
    const status = [
        `window=${singleLine(result.window_id)}`, `frames=${frames.length}`,
        `oldest_seq=${result.oldest_seq}`, `newest_seq=${result.newest_seq}`, `stale=${result.stale}`,
    ];
    if (result.gap) status.push("gap=true");
    if (result.timed_out) status.push("timed_out=true");
    if (result.exit_code !== undefined) status.push(`exit_code=${result.exit_code}`);
    if (result.error) status.push(`error=${preview(singleLine(result.error), 256, FULL_OUTPUT_HINT)}`);

    let firstSeq: number | undefined;
    let lastSeq = cursor;
    const header = (count: number, first?: number, last?: number, partialFrame = false) => [
        ...status, `text_frames=${count}`,
        ...(first === undefined ? [] : [`first_frame_seq=${first}`]),
        ...(last === undefined ? [] : [`last_delivered_seq=${last}`]),
        ...(count < frames.length || partialFrame ? ["text_truncated=true"] : []),
        ...(partialFrame ? ["frame_truncated=true"] : []),
    ].join(" | ");
    const lines: string[] = [];
    let lineBytes = 0;
    const forward = cursor !== undefined;
    // Incremental reads show the first frames; snapshots and backwards pages show the latest.
    for (let index = 0; index < frames.length; index++) {
        const frame = frames[forward ? index : frames.length - 1 - index]!;
        const line = `[${frame.seq} ${frame.stream ?? "output"}] ${singleLine(frame.text)}`;
        const bytes = jsonStringBytes(`\n${line}`) - 2;
        const first = forward ? firstSeq ?? frame.seq : frame.seq;
        const last = forward ? frame.seq : lastSeq ?? frame.seq;
        if (jsonStringBytes(header(index + 1, first, last)) + lineBytes + bytes > STREAM_TEXT_JSON_BYTES) {
            if (!lines.length) {
                const text = `${header(1, frame.seq, frame.seq, true)}\n${line}`;
                return limitText(text, "\n[此帧仅显示预览，完整帧见 structuredContent]", STREAM_TEXT_JSON_BYTES);
            }
            break;
        }
        lines.push(line);
        lineBytes += bytes;
        firstSeq = first;
        lastSeq = last;
    }
    if (!forward) lines.reverse();
    // The structured cursor covers the entire page. The text cursor covers the displayed frames.
    return [header(lines.length, firstSeq, lastSeq), ...lines].join("\n");
}

function singleLine(text: string): string {
    return text.replace(/[\p{Cc}\u2028\u2029]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function jsonStringBytes(text: string): number {
    return Buffer.byteLength(JSON.stringify(text), "utf8");
}

function limitBatchText(text: string, hint: string): string {
    return limitText(text, `\n[批次文本达到上限，部分结果已省略${hint}]`, BATCH_TEXT_JSON_BYTES);
}

function limitText(text: string, suffix: string, maxBytes: number): string {
    let lo = 0;
    let hi = Math.min(text.length, maxBytes);
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (jsonStringBytes(text.slice(0, mid) + suffix) <= maxBytes) lo = mid;
        else hi = mid - 1;
    }
    const last = text.charCodeAt(lo - 1);
    if (last >= 0xd800 && last <= 0xdbff) lo--;
    return text.slice(0, lo) + suffix;
}

function transferSummary(result: { bytes: number; transport: string; verification: string; write_mode: string }): string {
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
