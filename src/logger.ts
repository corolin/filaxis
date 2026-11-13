/**
 * logger.ts — 可注入日志接口（REQ-0001 §8.1：内核不绑任何 logger 实现）
 *
 * 消费方注入自己的 logger；缺省 noop（静默内核——SDK 不替调用方往 stdout 喷日志）。
 */

export interface FilaxisLogger {
    debug(msg: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
}

export const noopLogger: FilaxisLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
