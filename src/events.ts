/**
 * events.ts — 内核事件总线（FEAT-09：EventEmitter + AsyncIterable 双形态，零队列依赖）
 *
 * 消费方异常与内核生命周期隔离（AC-10：on 回调异常不杀内核与流）。
 * AsyncIterable 形态为有界队列：满时丢最旧并累计 dropped（慢消费者可查证——
 * 不承诺无限缓冲，与热窗口「有限历史」同一哲学）。
 */
import { EventEmitter } from "node:events";
import { settleRejection } from "./async-guard.js";

const DEFAULT_ITER_QUEUE_MAX = 1024;

export interface EventBusOptions {
    /** iterable 形态的每订阅队列上限（满丢最旧并计数） */
    queueMax?: number;
}

/** 回调可返回任意值（含 Promise——async handler 三十七期 #1：Promise rejection 需隔离） */
type Handler<E> = (ev: E) => unknown;

export class EventBus<E extends { type: string }> {
    private emitter = new EventEmitter();
    private readonly queueMax: number;
    /** 每个迭代订阅一份独立队列：{queue, dropped, active, notify, type}（notify=等待唤醒钩子） */
    private iterables = new Set<{ queue: E[]; dropped: number; active: boolean; notify?: () => void; type?: E["type"] }>();

    constructor(opts: EventBusOptions = {}) {
        this.queueMax = opts.queueMax ?? DEFAULT_ITER_QUEUE_MAX;
        this.emitter.setMaxListeners(0); // 多订阅是常态（每会话/每流），不告警
    }

    /** 订阅（可按 type 过滤）；返回退订函数。
     *  **per-registration 记录表**（三十期→三十三期迭代定稿）：映射形态历经三代——
     *  ①字符串键碰撞（工厂闭包同特征）→②函数引用嵌套 Map（同回调双注册时第二次
     *  set 覆盖第一份，第一份的退订函数又把键删光——第二份失去映射成孤儿监听）。
     *  正解：每次 on 是一条独立记录 {handler, wrapped}——退订函数按记录身份移除，
     *  off(handler) 移除该 handler 的**全部**注册（与 EventEmitter removeAllListener
     *  同语义，因为 handler 传不出「哪一份」的信息） */
    private registrations = new Map<string, Array<{ handler: Handler<E>; wrapped: (ev: E) => void }>>();

    on(type: E["type"] | "*", handler: Handler<E>): () => void {
        const key = `${type === "*" ? "__all" : type}`;
        const wrapped = (ev: E) => {
            try {
                // 异步拒绝隔离（Astra 三十七期 #1 → 三十八期 #2 跨 realm 收口）：
                // async 回调返回 Promise，try/catch 只捕同步——rejection 逃逸为
                // unhandledRejection 崩**宿主**。instanceof Promise 只认当前 realm
                // 的构造器（vm.runInNewContext 返回的外来 Promise 漏网）——鸭子
                // 检测 thenable 经本 realm Promise.resolve 同化（单一来源 async-guard）
                settleRejection(handler(ev));
            } catch {
                /* 消费方异常不外溢（AC-10） */
            }
        };
        let regs = this.registrations.get(key);
        if (!regs) {
            regs = [];
            this.registrations.set(key, regs);
        }
        const rec = { handler, wrapped };
        regs.push(rec);
        this.emitter.on(key, wrapped as (ev: E) => void);
        // 退订按**记录身份**（三十三期 #1：不删整键——同 handler 的其它注册不受影响）
        return () => {
            this.emitter.off(key, wrapped as (ev: E) => void);
            const list = this.registrations.get(key);
            if (!list) return;
            const i = list.indexOf(rec);
            if (i !== -1) list.splice(i, 1);
        };
    }

    once(type: E["type"], handler: Handler<E>): void {
        // 回调保护与 on 一致（三十期 #2 同步隔离 + 三十七/三十八期异步拒绝隔离含跨 realm）
        const wrapped = (ev: E) => {
            try {
                settleRejection(handler(ev));
            } catch {
                /* 同上 */
            }
        };
        // 记入 registrations（Hydrogen R2 #7）：once 曾直透 emitter——off(type, handler)
        // 无法取消 once 注册的监听（映射无记录）。触发后由下方看守监听同步清记录
        const key = `${type === "*" ? "__all" : type}`;
        let regs = this.registrations.get(key);
        if (!regs) { regs = []; this.registrations.set(key, regs); }
        const rec = { handler, wrapped };
        regs.push(rec);
        this.emitter.once(type as string, wrapped);
        this.emitter.once(type as string, () => { // 看守：用户 wrapped 触发后清记录
            const list = this.registrations.get(key);
            if (!list) return;
            const i = list.indexOf(rec);
            if (i !== -1) list.splice(i, 1);
        });
    }

    off(type: E["type"] | "*", handler: Handler<E>): void {
        const key = `${type === "*" ? "__all" : type}`;
        const list = this.registrations.get(key);
        if (!list) {
            this.emitter.off(key, handler as (ev: E) => void); // 非本总线注册的透传尝试
            return;
        }
        // 移除该 handler 在此 type 下的全部注册（handler 传不出「哪一份」——全退）
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i]!.handler === handler) {
                this.emitter.off(key, list[i]!.wrapped as (ev: E) => void);
                list.splice(i, 1);
            }
        }
    }

    /** 发布：同步分发到订阅者与迭代队列（唤醒等待中的迭代器）。
     *  迭代队列**入队前过滤**（Astra 三十二期 #2）：按 type 订阅的队列曾先入队
     *  后过滤——无关事件挤占容量（queueMax=1 时订阅者被 noise 顶掉自己 starve）。
     *  过滤提前到入队口：容量与 dropped 计数对应真实订阅类型 */
    emit(ev: E): void {
        this.emitter.emit(ev.type as string, ev);
        this.emitter.emit("__all", ev);
        for (const it of this.iterables) {
            if (!it.active) continue;
            if (it.type && it.type !== ev.type) continue; // 无关类型不入队（容量不浪费）
            if (it.queue.length >= this.queueMax) {
                it.queue.shift();
                it.dropped++;
            }
            it.queue.push(ev);
            it.notify?.(); // 唤醒等待的 next()（三十一期 #2：事件驱动替代轮询）
            it.notify = undefined;
        }
    }

    /** AsyncIterable 形态句柄：可 for-await 消费（可按 type 过滤），dropped() 查溢出
     *  丢弃数。**可取消**（Astra 三十一期 #2）：旧轮询等待形态下 next() 占住 generator、
     *  return() 排在其后无法进 finally——空闲迭代器取消永远 pending。改为 notify 等待
     *  （事件到达/取消都唤醒），cancel() 主动置 inactive + 唤醒 + 移除订阅记录。 */
    iterable(type?: E["type"]): AsyncIterable<E> & { dropped(): number; cancel(): void } {
        const entry = {
            queue: [] as E[],
            dropped: 0,
            active: true,
            notify: undefined as (() => void) | undefined,
            type, // 入队前过滤依据（三十二期 #2）
        };
        this.iterables.add(entry);
        const wake = () => {
            entry.notify?.();
            entry.notify = undefined;
        };
        const iterables = this.iterables;
        const handle = {
            [Symbol.asyncIterator]: async function* (): AsyncGenerator<E> {
                try {
                    while (entry.active) {
                        if (entry.queue.length === 0) {
                            // 等待唤醒（事件到达或取消）——不再轮询：return() 可即时打断
                            await new Promise<void>((resolve) => {
                                entry.notify = resolve;
                            });
                            continue;
                        }
                        const ev = entry.queue.shift()!;
                        yield ev; // 已在入队口过滤（三十二期 #2）——取出即订阅类型
                    }
                } finally {
                    entry.active = false;
                    iterables.delete(entry); // 消费结束自然移除
                    wake(); // 唤醒可能挂起的 return()/next() 链
                }
            },
            dropped: () => entry.dropped,
            cancel: () => {
                // **同步收尾**（Astra 三十三期 #2）：移除记录+清空队列不依赖 generator
                // finally——未启动迭代的订阅 cancel 后 finally 永不执行，总线持有
                // 记录+带载荷事件累积成泄漏（20 份订阅 = 20 条记录 + 20 个事件）
                entry.active = false;
                entry.queue.length = 0;
                iterables.delete(entry);
                wake();
            },
        } as AsyncIterable<E> & { dropped(): number; cancel(): void };
        (handle as unknown as { __entry: typeof entry }).__entry = entry;
        return handle;
    }

    listenerCount(type?: E["type"]): number {
        return this.emitter.listenerCount(type === "*" || !type ? "__all" : (type as string));
    }
}
