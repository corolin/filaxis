/**
 * 牵丝 Filaxis — 面向自动化与 Agent 的远程执行运行时 SDK
 * 千里一线，执行有迹。—— Connect · Execute · Observe · Reattach
 *
 * M1 第一批出口：契约与纯逻辑件。驱动实现（ssh/local/tmux）、会话管理器、
 * 事件总线按里程碑分批落位（REQ-0001 M1-M4）。
 */
export * from "./driver.js";
export * from "./session-types.js";
export * from "./session-buffer.js";
export * from "./logger.js";
export * from "./local-session-manager.js";
export * from "./local-driver.js";
export * from "./events.js";
export * from "./factory.js";
export * from "./runtime-stack.js";
export * from "./dialect.js";
export * from "./ssh-helpers.js";
export * from "./remote-session-manager.js";
export * from "./ssh-pty-driver.js";
export * from "./tmux-driver.js";
export * from "./terminal-manager.js";
export { DEFAULT_TERMINAL_CONFIG, compilePromptPatterns, TmuxError } from "./terminal/types.js";
export type { TerminalConfig, PromptPayload, PromptResponder, TmuxResult } from "./terminal/types.js";
export * from "./terminal/output-buffer.js";
export * from "./stream-session-manager.js";
export * from "./file-transfer.js";
export * from "./layer-env.js";
export { resolveLocalShell } from "./shell-discovery.js";
export { createAgentToolkit } from "./agent-toolkit.js";
export type { AgentToolkit, AgentToolDef, AgentToolHandlers, AgentToolkitOptions } from "./agent-toolkit.js";
export { discoverLayer } from "./layer-discovery.js";
export type { DiscoverLayerOptions, DiscoverLayerResult } from "./layer-discovery.js";
export * from "./stream-window.js";
export { Vt100Screen } from "./vt100-screen.js";
export type { Vt100ScreenOptions } from "./vt100-screen.js";
export { editFile, editFileMulti, EditConflictError } from "./file-edit.js";
export type { EditFileOptions, EditFileResult, EditFileMultiResult, EditMultiHunk } from "./file-edit.js";
export { runBatch } from "./batch.js";
export type {
    BatchPlan, BatchStep, BatchStepWithDeps, BatchExecStep, BatchEditStep, BatchReadStep,
    BatchReport, BatchStepReport, BatchStepStatus,
} from "./batch.js";
