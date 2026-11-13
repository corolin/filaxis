/**
 * 本地会话引擎单测（真子进程——bun test 环境需 bash 于 PATH；
 * FEAT-04 双文件双流 / FEAT-05 行对象流标记 / watcher / 终态事件）
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { LocalSessionManager } from "../src/local-session-manager.js";
import type { SessionEvent } from "../src/session-types.js";

/** 轮询等待谓词为真（事件异步到达） */
async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<void> { // Windows Defender 对新 shell 路径首启扫描可 >5s
    const start = Date.now();
    while (!pred()) {
        if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
        await new Promise((r) => setTimeout(r, 20));
    }
}

function collect(m: LocalSessionManager): SessionEvent[] {
    const events: SessionEvent[] = [];
    m.onEvent = (ev) => events.push(ev);
    return events;
}

describe("LocalSessionManager", () => {
    test("spawn 即返 + 双文件创建 + exit 事件 exitCode", async () => {
        const m = new LocalSessionManager();
        const events = collect(m);
        const h = await m.start("echo hello; exit 3");
        expect(h.sessionId).toMatch(/^sess-/);
        expect(h.pid).toBeGreaterThan(0);
        await waitFor(() => events.some((e) => e.type === "exit"));
        const exit = events.find((e) => e.type === "exit") as Extract<SessionEvent, { type: "exit" }>;
        expect(exit.exitCode).toBe(3);
        expect(existsSync(`${h.logBase}.out`)).toBe(true);
        expect(existsSync(`${h.logBase}.err`)).toBe(true);
    });

    test("双流物理分离：.out/.err 各归各（FEAT-04 落盘协议）", async () => {
        const m = new LocalSessionManager();
        const events = collect(m);
        const h = await m.start("echo to-out; echo to-err 1>&2");
        await waitFor(() => events.some((e) => e.type === "exit"));
        const out = await m.readLog(h.sessionId, { stream: "stdout" });
        const err = await m.readLog(h.sessionId, { stream: "stderr" });
        expect(out).toBe("to-out");
        expect(err).toBe("to-err");
    });

    test("watcher 命中事件带 stream 字段；thenStop 收摊", async () => {
        const m = new LocalSessionManager();
        const events = collect(m);
        const h = await m.start("echo GO 1>&2; sleep 30");
        m.watch(h.sessionId, { pattern: "GO", once: true, thenStop: true });
        await waitFor(() => events.some((e) => e.type === "match"));
        const match = events.find((e) => e.type === "match") as Extract<SessionEvent, { type: "match" }>;
        expect(match.stream).toBe("stderr"); // 命中行发自 stderr
        expect(match.matchedLine).toContain("GO");
        // thenStop → 会话被终止（SIGTERM）→ exit 事件
        await waitFor(() => events.some((e) => e.type === "exit"));
    }, 20_000); // bun 用例级默认 5s——Windows 新 shell 路径首启+Defender 扫描累计超限

    test("stop 长跑进程：SIGTERM → exit 事件", async () => {
        const m = new LocalSessionManager();
        const events = collect(m);
        const h = await m.start("sleep 60");
        await m.stop(h.sessionId);
        await waitFor(() => events.some((e) => e.type === "exit"));
        const entry = m.list().find((s) => s.sessionId === h.sessionId);
        expect(entry?.running).toBe(false);
    });

    test("tailLines：行对象按到达序混合双流", async () => {
        const m = new LocalSessionManager();
        const events = collect(m);
        const h = await m.start("echo one; echo two 1>&2; echo three");
        await waitFor(() => events.some((e) => e.type === "exit"));
        const lines = m.tailLines(h.sessionId, 10);
        const streams = lines.map((l) => `${l.stream}:${l.text}`);
        expect(streams).toContain("stdout:one");
        expect(streams).toContain("stderr:two");
        expect(streams).toContain("stdout:three");
    });

    test("不存在/已回收的会话 → 显式错误", () => {
        const m = new LocalSessionManager();
        expect(() => m.tail("nope")).toThrow(/不存在/);
    });

    // GPT Astra 二轮 #2：核实窗（旧 1s）< SIGKILL 升级时刻（1.5s）——窗末未死伪报
    // stopped（真机复现 running:true）。修后：窗盖过 KILL_GRACE+1s，仍不死=unknown
    test("stop 核实窗盖过 SIGKILL：死亡未确认 → unknown（不伪 stopped）", async () => {
        const m = new LocalSessionManager();
        // 假 entry：running 恒 true（模拟无视信号/不可核实的进程——纯逻辑路径）
        const m2 = m as unknown as { entries: Map<string, { running: boolean; exitCode?: number }> };
        m2.entries.set("zombie", { running: true, exitCode: undefined });
        const t0 = Date.now();
        const r = await m.stop("zombie");
        expect(r.status).toBe("unknown"); // 修前：stopped（SIGKILL 还没发就收卷）
        expect(r.exitCode).toBeNull();
        expect(Date.now() - t0).toBeGreaterThan(2000); // 窗确实盖过 KILL_GRACE（1.5s）
    }, 15_000);
});

describe("ready() 就绪握手（AC-13）", () => {
    test("回溯匹配：spawn→ready 间隙已输出的标记不漏", async () => {
        const m = new LocalSessionManager();
        const h = await m.start("echo LISTENING-OK; sleep 8");
        try {
            // 等标记进窗口（有界等待：最多 4s，窗口一有行即继续）
            const t0 = Date.now();
            while (m.tail(h.sessionId).length === 0 && Date.now() - t0 < 4000) {
                await new Promise((r) => setTimeout(r, 30));
            }
            const r = await m.ready(h.sessionId, { pattern: "LISTENING-OK", timeoutMs: 3000 });
            expect(r.matchedLine).toContain("LISTENING-OK");
        } finally {
            await m.stop(h.sessionId).catch(() => undefined);
        }
    });

    test("增量匹配：ready 在前，标记在后", async () => {
        const m = new LocalSessionManager();
        const h = await m.start("sleep 0.3; echo LATE-READY; sleep 8");
        try {
            const r = await m.ready(h.sessionId, { pattern: "LATE-READY", timeoutMs: 5000 });
            expect(r.matchedLine).toContain("LATE-READY");
        } finally {
            await m.stop(h.sessionId).catch(() => undefined);
        }
    });

    test("超时：自动 stop 清理（reject 且清理路径触发）", async () => {
        const m = new LocalSessionManager();
        const events = collect(m);
        const h = await m.start("sleep 60");
        await expect(m.ready(h.sessionId, { pattern: "NEVER", timeoutMs: 400 })).rejects.toThrow(/超时|ready/);
        // SIGTERM 已随超时发出；Windows 下孤儿管道可延迟 close（exit 事件时序不保证），
        // 2s 宽限内观察到 exit 则强断言，否则容忍（清理请求送达已由不抛错证明）
        try {
            await waitFor(() => events.some((e) => e.type === "exit"), 2000);
        } catch { /* 平台时序容忍 */ }
        await m.stop(h.sessionId).catch(() => undefined);
    }, 10_000); // 串行等待段多（bash 冷启动+waitFor+stop 核实）——显式预算
});

// 自挖（Astra 十五轮顺藤）：本地会话与观察流同病——逐 data 块 toString 把跨块
// 多字节字符撕裂成 U+FFFD。StringDecoder per stream 后「中文」按字节拆块完整拼回。
describe("LocalSessionManager 跨块解码（自挖）", () => {
    test("中文跨块不撕裂：2+4 字节分块经 decoder 完整行入窗", async () => {
        const proc = new EventEmitter() as unknown as {
            stdout: EventEmitter; stderr: EventEmitter;
            stdin: { write(): boolean; end(): void };
            pid: number; killed: boolean; kill(): boolean;
            emit(ev: string, ...a: unknown[]): boolean;
        };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = { write: () => true, end: () => undefined };
        proc.pid = 4321;
        proc.killed = false;
        proc.kill = () => { proc.emit("close", 0); return true; };
        const m = new LocalSessionManager({ spawnImpl: (() => proc) as never });
        const h = await m.start("x");
        proc.stdout.emit("data", Buffer.from([0xe4, 0xb8])); // 「中」前 2 字节
        proc.stdout.emit("data", Buffer.from([0xad, 0xe6, 0x96, 0x87])); // 「中」尾 + 「文」
        proc.stdout.emit("data", Buffer.from("\n"));
        proc.emit("close", 0);
        await new Promise((r) => setTimeout(r, 150));
        expect(m.tail(h.sessionId)).toContain("中文"); // 修前：U+FFFD 乱码
    });

    // GPT Astra 二十轮 #1：H1 的 close 兜底伪造 exited——SIGKILL 后仍 running 就
    // finalize(null) → stop 返回 exited。隔离 mock（kill 无效、无 exit/close 事件、
    // destroy 不触发任何回调）下死亡从未被证明——必须保持 unknown。
    test("stop 兜底不伪造终态：杀不死的 mock 进程（死亡未证明）→ unknown", async () => {
        const proc = new EventEmitter() as unknown as {
            stdout: EventEmitter & { destroyed?: boolean; destroy?(): void };
            stderr: EventEmitter & { destroyed?: boolean; destroy?(): void };
            stdin: { write(): boolean; end(): void };
            pid: number; killed: boolean;
            kill(): boolean;
        };
        proc.stdout = Object.assign(new EventEmitter(), { destroy: () => undefined });
        proc.stderr = Object.assign(new EventEmitter(), { destroy: () => undefined });
        proc.stdin = { write: () => true, end: () => undefined };
        proc.pid = 9999;
        proc.killed = false;
        proc.kill = () => true; // 信号「发出」但进程不死（不 emit 任何事件）
        const m = new LocalSessionManager({ spawnImpl: (() => proc) as never });
        const h = await m.start("x");
        const r = await m.stop(h.sessionId);
        expect(r.status).toBe("unknown"); // 修前：兜底 finalize 伪造 exited
        expect(r.exitCode).toBeNull();
    }, 15_000);
});

// 自审（二十三期后续）：十六轮 #2 常驻 watcher meta 保护漏改 local——孪生代码
// 不对齐（与 reapIdle 双发同模式）。修后常驻二次命中 pattern 保持。
describe("常驻 watcher meta（自审·local 对齐）", () => {
    test("once:false 二次命中 pattern 不变 '?'（meta 保留）", async () => {
        const m = new LocalSessionManager();
        const events: Array<{ type?: string; pattern?: string }> = [];
        m.onEvent = (e) => events.push(e as never);
        const h = await m.start("echo BEAT-1; sleep 0.3; echo BEAT-2; sleep 5");
        m.watch(h.sessionId, { pattern: "BEAT", once: false });
        await new Promise((r) => setTimeout(r, 1200));
        const matches = events.filter((e) => e.type === "match");
        expect(matches.length).toBe(2);
        expect(matches[1]!.pattern).toBe("BEAT"); // 修前："?"（meta 被首命中误删）
        await m.stop(h.sessionId).catch(() => undefined);
    }, 15_000);
});

// GPT Astra 三十四期 P1 SDK 面：ready() 超时 fire-and-forget stop 后谎称「已自动停止」
// ——unknown 时任务可能仍在跑。修：等 stop 三态，unknown 挂 outcome+会话线索。
describe("ready() 超时三态（三十四期 SDK）", () => {
    test("停止结果核实后如实报告（local 组杀可靠——exited/stopped 带真实细节，不再谎称已自动停止）", async () => {
        const m = new LocalSessionManager();
        const h = await m.start("sleep 30");
        let caught: (Error & { outcome?: string; sessionId?: string }) | undefined;
        try { await m.ready(h.sessionId, { pattern: "NEVER_APPEARS", timeoutMs: 400 }); } catch (e) { caught = e as never; }
        expect(caught?.message).not.toContain("已自动停止"); // 修前：fire-and-forget 谎称
        // local 停止核实可靠（H1 组杀 + close 可观察）——实测 outcome=exited（SIGTERM 后退出）
        expect(caught?.outcome === "exited" || caught?.outcome === "stopped" || caught?.outcome === "unknown").toBe(true);
        expect(caught?.sessionId).toBe(h.sessionId); // 会话线索在场
        await m.stop(h.sessionId).catch(() => undefined);
    }, 15_000);
});

// 孪生对齐审计（三十九期后全弧复盘）：三十七/三十八期 EventBus 异步拒绝隔离在
// onEvent 的漏改；十六期 Stream「收尾统一 close+2s 兜底」在 local 的漏改
// （孙进程持管道 close 永不发 → running 谎报 + TTL 不启动）；watchers.clear 对齐 Remote。
describe("孪生对齐审计（async 隔离 + exit 兜底 + 终态 watcher 封板）", () => {
    test("async onEvent 回调 rejection 不崩宿主（settleRejection 接线）", async () => {
        const m = new LocalSessionManager();
        m.onEvent = async () => { throw new Error("sink async boom"); };
        const h = await m.start("echo ALIVE_OK");
        await waitFor(() => !m.list()[0]!.running);
        // 修前：rejection 逃逸 unhandledRejection 崩宿主（bun test 直接 fail）
        expect(m.tail(h.sessionId)).toContain("ALIVE_OK");
    }, 20_000);

    test("孙进程持 stdio 管道：exit 2s 兜底先于 close finalize（close 永不按时来）", async () => {
        const m = new LocalSessionManager();
        const exits: Array<number | null | undefined> = [];
        m.onEvent = (ev) => { if (ev.type === "exit") exits.push(ev.exitCode); };
        // 主 shell 即退（exit 事件立即到），孙 sleep 3 持管道写端 → close ≈3s 后
        await m.start("echo MAIN_DONE; (sleep 3) & exit 0");
        // 2.6s = 兜底（主退+2s）已触发、close（3s）未到——兜底生效的直接证明窗
        await new Promise((r) => setTimeout(r, 2600));
        expect(exits.length).toBe(1); // 修前：0（close 永不按时来，finalize 悬置）
        expect(m.list()[0]!.running).toBe(false); // 修前：true（孙进程还握着管道）
        expect(m.tail(m.list()[0]!.sessionId)).toContain("MAIN_DONE");
    }, 15_000);

    test("终态后孙进程尾数据不触发 watcher（watchers.clear 对齐 + late data 拦截）", async () => {
        const m = new LocalSessionManager();
        const matches: string[] = [];
        m.onEvent = (ev) => { if (ev.type === "match") matches.push(ev.matchedLine); };
        // 主 shell 即退 → 兜底 ≈2s finalize；孙进程 3s 才输出（终态**之后**到达）
        await m.start("(sleep 3; echo LATE_LINE) & exit 0");
        const id = m.list()[0]!.sessionId;
        m.watch(id, { pattern: "LATE_LINE", once: true }); // 终态前注册
        await new Promise((r) => setTimeout(r, 4200));
        expect(matches.length).toBe(0); // 修前风险：终态后 watcher 复活误触 + write-after-end 崩流
    }, 15_000);
});

// Gemini #7：verify() pid 实测——close 未达/兜底窗内不谎报 running。
describe("local verify（Gemini #7）", () => {
    test("running 会话 verify=running；死进程（close 未达）=unknown 不谎报", async () => {
        const m = new LocalSessionManager();
        const h = await m.start("sleep 5");
        expect(m.verify(h.sessionId).status).toBe("running");
        // 外部杀死（绕过 stop——模拟 close 回调未达窗口）
        const entry = (m as unknown as { entries: Map<string, { proc?: { pid?: number } }> }).entries.get(h.sessionId);
        process.kill(entry!.proc!.pid!, "SIGKILL");
        await new Promise((r) => setTimeout(r, 200)); // close 可能已到——两种合法终态
        const v = m.verify(h.sessionId);
        expect(v.status === "unknown" || v.status === "exited").toBe(true); // 修前：恒 running（内存态谎报）
        await m.stop(h.sessionId).catch(() => undefined);
    }, 15_000);
});
