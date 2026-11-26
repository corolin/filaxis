/**
 * operations/protocol.ts — Daemon 线协议版本（REQ-0004 §6.2）
 *
 * 与包版本分离：只有不兼容的线协议变更才递增。客户端连上 Daemon 先核对它，
 * 不一致就拒绝——升级之后旧 Daemon 还在跑时，新客户端的请求若交给旧代码执行，
 * 新功能会静默消失（0.2.x 的实际局面）。
 */
export const PROTOCOL_VERSION = 3;
