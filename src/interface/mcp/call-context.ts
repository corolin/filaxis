/**
 * call-context.ts — 一次工具调用的「调用方基准目录」（REQ-0004 §5.5）
 *
 * MCP 经 Daemon 时，工具集在 Daemon 进程里执行，它的工作目录与客户端无关；进程内形态下
 * 就是本进程。相对路径与命令的工作目录该以谁为基准，属于界面层的事（中层不感知）：
 * 界面层的客户端一侧（代理）把工作目录随会话带来，Daemon 一侧的工具面据此定基准。
 * 经 AsyncLocalStorage 跟着异步调用链走：并发的多个会话互不串线。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute as pathIsAbsolute } from "node:path";

export interface ToolCallContext {
    /** 调用方的工作目录；未知（直接 POST、没带目录的旧代理）为 undefined */
    cwd?: string;
}

const storage = new AsyncLocalStorage<ToolCallContext>();

/** 在给定上下文里执行一次工具调用；没有上下文就原样执行 */
export function runWithToolCallContext<T>(ctx: ToolCallContext | undefined, fn: () => T): T {
    return ctx ? storage.run(ctx, fn) : fn();
}

/** 本次工具调用的调用方工作目录（不在工具调用里、或调用方没带，为 undefined） */
export function callerCwd(): string | undefined {
    return storage.getStore()?.cwd;
}

/**
 * 代理 → Daemon：SSE 握手请求头，值是 encodeURIComponent 过的工作目录（路径可能含非 Latin-1
 * 字符，HTTP 头只放得下 ASCII）。Daemon 按会话记住，之后这条会话上的工具调用都以它为基准。
 */
export const CALLER_CWD_HEADER = "x-filaxis-caller-cwd";

export function encodeCallerCwd(cwd: string): string {
    return encodeURIComponent(cwd);
}

/** 解析握手带来的目录；不是绝对路径（或根本没带）返回 undefined——此时一切照旧 */
export function decodeCallerCwd(header: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(header) ? header[0] : header;
    if (typeof raw !== "string" || raw === "") return undefined;
    let cwd: string;
    try { cwd = decodeURIComponent(raw); } catch { return undefined; }
    return pathIsAbsolute(cwd) ? cwd : undefined;
}
