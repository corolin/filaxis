/**
 * async-guard.ts — 消费方回调的异步拒绝隔离（单一来源）
 *
 * 净室定型自 events.ts 三十七/三十八期迭代（instanceof Promise 只认当前 realm
 * 构造器 → 鸭子检测 thenable + 本 realm Promise.resolve 同化）。孪生对齐审计
 * （三十九期后用户令全弧复盘）发现三个会话管理器的 onEvent 分发面与 EventBus
 * on/once 同构却各持裸 try/catch——async 回调的 rejection 逃逸为
 * unhandledRejection 崩**宿主**。提取单一来源防四处漂移。
 *
 * 语义：同步 throw 由调用方 try/catch 捕；返回 thenable（含跨 realm Promise）
 * 的 rejection 经同化兜住（外来 then 抛同步错也只化归派生 rejection，不 re-throw）。
 */

/** 回调返回值若为 thenable，吞掉其异步拒绝（返回原值，零分配热路径：非 thenable 直接过） */
export function settleRejection(r: unknown): void {
    if (r != null && typeof (r as { then?: unknown }).then === "function") {
        Promise.resolve(r).catch(() => undefined);
    }
}
