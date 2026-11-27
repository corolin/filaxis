/**
 * 牵丝 Filaxis — 面向自动化与 Agent 的远程执行运行时 SDK
 * 千里一线，执行有迹。—— Connect · Execute · Observe · Reattach
 *
 * M1 第一批出口：契约与纯逻辑件。驱动实现（ssh/local/tmux）、会话管理器、
 * 事件总线按里程碑分批落位（REQ-0001 M1-M4）。
 */
export * from "./core/base/driver.js";
export * from "./core/base/session-types.js";
export * from "./core/base/session-buffer.js";
export * from "./shared/logger.js";
export * from "./core/local/local-session-manager.js";
export * from "./core/local/local-driver.js";
export * from "./core/base/events.js";
export * from "./core/base/factory.js";
export * from "./middle/runtime-stack.js";
export * from "./middle/layer-store.js";
export { PROTOCOL_VERSION, REMOTE_OP_NAMES } from "./middle/protocol.js";
export { createMiddle, assertSshTargetRoutable, describeLayer, BATCH_STEP_KINDS as MIDDLE_BATCH_STEP_KINDS } from "./middle/middle.js";
export type { LocalMiddle, MiddleOptions } from "./middle/middle.js";
export type {
    LayerRef, Middle, MiddleOps, MiddleHost, ExecResult, SessionHandle, SessionStopResult, ObserveLine, ObserveResult,
    ReadPathResult as MiddleReadPathResult, WriteFileResult, ManagePathResult as MiddleManagePathResult,
    StreamFilter, StreamName, StreamResult, StreamSummary, LayerInfo,
} from "./middle/types.js";
export * from "./core/base/dialect.js";
export * from "./core/ssh/ssh-helpers.js";
export * from "./core/ssh/ssh-forward.js";
export * from "./interface/daemon/daemon-files.js";
export * from "./interface/daemon/daemon-server.js";
export * from "./interface/daemon/daemon-client.js";
export { McpServer, McpProtocolHandler } from "./interface/mcp/mcp-server.js";
export type { McpServerOptions, McpProtocolHandlerOptions } from "./interface/mcp/mcp-server.js";
export * from "./interface/mcp/mcp-proxy.js";
export * from "./core/ssh/remote-session-manager.js";
export * from "./core/ssh/ssh-pty-driver.js";
export * from "./core/tmux/tmux-driver.js";
export * from "./core/tmux/terminal-manager.js";
export { DEFAULT_TERMINAL_CONFIG, compilePromptPatterns, TmuxError } from "./core/tmux/types.js";
export type { TerminalConfig, PromptPayload, PromptResponder, TmuxResult } from "./core/tmux/types.js";
export * from "./core/tmux/output-buffer.js";
export * from "./core/stream/stream-session-manager.js";
export * from "./core/file/file-transfer.js";
export { transferLayerFile } from "./core/file/layer-file-transfer.js";
export type { FileTransferTransport, LayerFileTransferOptions, LayerFileTransferResult } from "./core/file/layer-file-transfer.js";
export * from "./core/probe/layer-env.js";
export { resolveLocalShell } from "./core/base/shell-discovery.js";
export { createAgentToolkit, TOOL_DEFS, forwardInfoToPublic, closeForwardResultToPublic } from "./interface/mcp/agent-toolkit.js";
export type { PublicForwardInfo, PublicCloseForwardResult } from "./interface/mcp/agent-toolkit.js";
export type {
    AgentToolkit, AgentToolDef, AgentToolHandlers, AgentToolkitOptions,
    ConnectSshTarget, ConnectSshResult, ConnectSshBatchArgs, ConnectSshBatchResult,
    ConnectIntoArgs, ConnectIntoResult, ObserveStreamResult, ReadPathResult,
    AgentEditFileResult, ManagePathResult, ManageLayersResult,
    PushSshTarget, PushSshResult, PushSshBatchArgs, PushSshBatchResult,
} from "./interface/mcp/agent-toolkit.js";
export { discoverLayer } from "./core/probe/layer-discovery.js";
export type { DiscoverLayerOptions, DiscoverLayerResult } from "./core/probe/layer-discovery.js";
export * from "./core/stream/stream-window.js";
export { Vt100Screen } from "./core/stream/vt100-screen.js";
export type { Vt100ScreenOptions } from "./core/stream/vt100-screen.js";
export { editFile, editFileMulti, EditConflictError } from "./core/file/file-edit.js";
export type { EditFileOptions, EditFileResult, EditFileMultiResult, EditMultiHunk } from "./core/file/file-edit.js";
export { runBatch, expandBatchLayerWildcards, expandLayerPattern, hasLayerWildcard } from "./core/file/batch.js";
export type {
    BatchPlan, BatchLayerTarget, BatchStep, BatchStepWithDeps, BatchExecStep, BatchEditStep, BatchReadStep, BatchPutStep, BatchGetStep,
    BatchReport, BatchStepReport, BatchStepStatus,
} from "./core/file/batch.js";
