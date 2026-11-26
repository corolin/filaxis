/**
 * operations/protocol.ts — Daemon 线协议版本与操作清单（REQ-0004 §6）
 *
 * 与包版本分离：只有不兼容的线协议变更才递增。客户端连上 Daemon 先核对它，
 * 不一致就拒绝——升级之后旧 Daemon 还在跑时，新客户端的请求若交给旧代码执行，
 * 新功能会静默消失（0.2.x 的实际局面）。
 */
import type { MiddleOps } from "./types.js";

export const PROTOCOL_VERSION = 3;

/**
 * 可经 Daemon 调用的操作（= 中层操作全集；操作名即线协议里的 op）。
 * 客户端（同形客户端）与服务端（薄转发）共用这一份清单。中层增删操作而忘了
 * 同步这里时，下面的穷举检查会在 typecheck 报错。
 */
export const REMOTE_OP_NAMES = [
    "features",
    "connectSsh", "connectSshBatch", "connectInto", "listLayers", "activateLayer", "removeLayer", "probeLayer",
    "runCommand", "runBatch", "startSession", "stopSession", "observe",
    "readFile", "readPath", "writeFile", "editFile", "managePath", "transferFile",
    "openStream", "peekStream", "closeStream", "listStreams",
    "openForward", "listForwards", "closeForward",
] as const satisfies readonly (keyof MiddleOps)[];

// 中层有、这里没有的操作：应为 never
type MissingOps = Exclude<keyof MiddleOps, (typeof REMOTE_OP_NAMES)[number]>;
const exhaustive: MissingOps[] = [];
void exhaustive;
