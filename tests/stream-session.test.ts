/**
 * 观察流引擎单测（AC-06 逻辑面：spawn 注入 mock——真流式/双流/watcher/衰减回收）
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { StreamSessionManager, type SpawnImpl } from "../src/stream-session-manager.js";
import type { SessionEvent } from "../src/session-types.js";
import type { SessionLine } from "../src/session-buffer.js";

/** fake ssh 进程：可编程推流/退出的 EventEmitter 型 ChildProcess 替身 */
function fakeSpawn(): { impl: SpawnImpl; procs: FakeChild[] } {
    const procs: FakeChild[] = [];
    const impl: SpawnImpl = (_cmd, _argv, _opts) => {
        const c = new FakeChild();
        procs.push(c);
        return c as unknown as import("node:child_process").ChildProcess;
    };
    return { impl, procs };
}

class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    stdin = { write: () => true, end: () => true };
    pid = 12345;
    killed = false;
    kill(sig?: string) {
        this.killed = true;
        // node 真语义：exit 后 stdio 排空必发 close（十六轮 #1 收尾统一到 close）
        this.emit("exit", sig === "SIGTERM" ? 0 : null);
        this.emit("close", sig === "SIGTERM" ? 0 : null);
        return true;
    }
    emitOut(text: string) { this.stdout.emit("data", Buffer.from(text)); }
    emitErr(text: string) { this.stderr.emit("data", Buffer.from(text)); }
    exitWith(code: number | null) { this.emit("exit", code); this.emit("close", code); }
}

function collect(m: StreamSessionManager): SessionEvent[] {
    const evs: SessionEvent[] = [];
    m.onEvent = (e) => evs.push(e);
    return evs;
}

describe("StreamSessionManager（AC-06）", () => {
    test("真流式：行到达即推 onLine（行对象带 stream 标记）", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const lines: SessionLine[] = [];
        await m.start("tail -f x", { onLine: (l) => lines.push(l) });
        procs[0]!.emitOut("L1\nL2\n");
        procs[0]!.emitErr("E1\n");
        expect(lines).toEqual([
            { stream: "stdout", text: "L1" },
            { stream: "stdout", text: "L2" },
            { stream: "stderr", text: "E1" },
        ]);
        const id = m.list()[0]!.sessionId;
        expect(m.tailLines(id).map((l) => `${l.stream}:${l.text}`)).toContain("stderr:E1");
    });

    test("watcher 命中事件带 stream 字段；once 默认摘除", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const evs = collect(m);
        const { sessionId } = await m.start("watched");
        m.watch(sessionId, { pattern: "ERROR", once: true });
        procs[0]!.emitErr("xx ERROR boom\n");
        const match = evs.find((e) => e.type === "match") as Extract<SessionEvent, { type: "match" }>;
        expect(match).toBeTruthy();
        expect(match.stream).toBe("stderr");
        expect(match.matchedLine).toContain("ERROR");
        procs[0]!.emitErr("ERROR again\n"); // once 已摘——不再命中
        expect(evs.filter((e) => e.type === "match").length).toBe(1);
    });

    test("exit 事件 + onExit 流桥；桥接回调异常不杀流（后续事件照常）", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const evs = collect(m);
        let bridgeBoom = 0;
        await m.start("x", {
            onExit: () => { bridgeBoom++; throw new Error("bridge boom"); },
        });
        procs[0]!.exitWith(3);
        expect(bridgeBoom).toBe(1); // 桥被调用且抛了
        const exit = evs.find((e) => e.type === "exit") as Extract<SessionEvent, { type: "exit" }>;
        expect(exit.exitCode).toBe(3); // 事件照常送达（异常被吞）
    });

    test("stop 收摊；list 状态", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const { sessionId } = await m.start("sleep");
        expect(m.list()[0]!.running).toBe(true);
        m.stop(sessionId);
        expect(procs[0]!.killed).toBe(true);
        expect(m.list().length).toBe(0);
        expect(() => m.tail(sessionId)).toThrow(/不存在/);
    });

    test("注意力衰减：无人消费且无 armed watcher 超 TTL 自动回收+广播；armed 不回收；消费刷新注意力", async () => {
        const { impl } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true, idleReapMs: 1000 });
        const evs = collect(m);
        const { sessionId: s1 } = await m.start("idle-stream");
        const { sessionId: s2 } = await m.start("armed-stream");
        m.watch(s2, { pattern: "NEVER", once: false }); // armed 常驻

        const t0 = Date.now();
        // 无消费超 TTL → 回收
        m.reapIdle(t0 + 2000, 1000);
        expect(m.list().some((s) => s.sessionId === s1)).toBe(false);
        expect(m.list().some((s) => s.sessionId === s2)).toBe(true); // armed 不回收
        expect(evs.some((e) => e.type === "exit" && e.sessionId === s1)).toBe(true); // 回收广播

        // tail=消费 → 刷新注意力，不回收
        const { sessionId: s3 } = await m.start("fresh");
        m.tail(s3); // lastAttentionAt = 真实 now
        m.reapIdle(Date.now() + 500, 1000); // 距上次消费 500ms < TTL
        expect(m.list().some((s) => s.sessionId === s3)).toBe(true);
    });

    test("start 建立即挂 watcher（watchPattern）", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const evs = collect(m);
        await m.start("boot", { watchPattern: "READY" });
        procs[0]!.emitOut("booting\nREADY\n");
        expect(evs.some((e) => e.type === "match" && e.matchedLine.includes("READY"))).toBe(true);
    });

    // GPT Astra 十三轮 #1：start() 硬编码 accept-new 在 argv 最前——重复 -o 首见
    // 生效，调用者 strict 被覆盖。策略感知渲染后 strict 传导、缺省 TOFU 保持。
    test("host key 策略传导：strict 渲染 yes（accept-new 绝迹）；缺省仍 TOFU", async () => {
        const captured: string[][] = [];
        const impl: SpawnImpl = (_c, argv) => {
            captured.push(argv as string[]);
            return new FakeChild() as unknown as import("node:child_process").ChildProcess;
        };
        const mStrict = new StreamSessionManager(["host"], {
            spawnImpl: impl, disableMux: true,
            connParams: { hostKeyPolicy: "strict", knownHostsFile: "/tmp/known-jumps" },
        });
        await mStrict.start("tail -f x");
        expect(captured[0]).toContain("StrictHostKeyChecking=yes"); // 不再被硬编码 accept-new 压掉
        expect(captured[0]).not.toContain("StrictHostKeyChecking=accept-new");
        expect(captured[0]).toContain("UserKnownHostsFile=/tmp/known-jumps");
        const mTofu = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        await mTofu.start("tail -f x");
        expect(captured[1]).toContain("StrictHostKeyChecking=accept-new"); // 缺省 TOFU 保持
    });

    // GPT Astra 十四轮 #2：块边界≠行边界/UTF-8 边界——`READY\n` 分两块曾成两行
    // （watcher 漏匹配）；中文跨块逐块 toString 撕裂成 U+FFFD。
    test("分块安全：READY 跨两块 watcher 仍命中；中文跨块无替换符；无尾换行 exit flush", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const lines: import("../src/session-buffer.js").SessionLine[] = [];
        const evs = collect(m);
        const id = await m.start("x", {
            onLine: (l) => lines.push(l),
            watchPattern: "READY",
        });
        void id;
        const c = procs[0]!;
        c.emitOut("RE"); // 半行
        c.emitOut("ADY\n"); // 补完——修前成 RE/ADY 两行，READY 永不命中
        c.stdout.emit("data", Buffer.from([0xe4, 0xb8])); // 「中」前三字节中的前两字节
        c.stdout.emit("data", Buffer.from([0xad, 0xe6, 0x96, 0x87])); // 「中」尾字节 + 「文」
        c.stdout.emit("data", Buffer.from("\n"));
        c.emitOut("TAIL_NO_NEWLINE"); // 无尾换行的最后一行
        c.exitWith(0); // exit flush 残余
        expect(evs.some((e) => e.type === "match" && e.matchedLine === "READY")).toBe(true);
        const texts = lines.map((l) => l.text);
        expect(texts).toContain("中文"); // 跨块拼接完整（修前 U+FFFD 乱码）
        expect(texts).toContain("TAIL_NO_NEWLINE"); // exit flush（修前残余半行丢弃）
    });

    // GPT Astra 十五轮 #2：exit≠stdio EOF——data→exit→data→close 合法顺序下，
    // exit 后到达的尾数据曾永久滞留 pending。close 兜底 drain 后 TAIL 入行。
    test("exit 后尾数据不丢（close 兜底 flush）：data→exit→data→close", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const lines: import("../src/session-buffer.js").SessionLine[] = [];
        await m.start("x", { onLine: (l) => lines.push(l) });
        const c = procs[0]!;
        c.emitOut("HEAD\n");
        c.emit("exit", 0); // 进程退出（stdio 未关）
        c.emitOut("TAIL"); // exit 后到达的尾数据
        c.emit("close", 0); // 流真关闭——兜底 drain
        const texts = lines.map((l) => l.text);
        expect(texts).toContain("HEAD");
        expect(texts).toContain("TAIL"); // 修前：永久滞留 pending
    });

    // GPT Astra 十六轮 #1：十五轮的 close 补 flush 只救回数据、救不回被 exit
    // 初次收尾拆断的行——RE→exit→ADY\n→close 曾成 RE/ADY 两行（READY 永不命中）。
    // 收尾统一到 close 后半行跨 exit 合回。
    test("跨 exit 的半行合回：RE→exit→ADY\\n→close → READY 单行命中", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const lines: import("../src/session-buffer.js").SessionLine[] = [];
        const evs = collect(m);
        await m.start("x", { onLine: (l) => lines.push(l), watchPattern: "READY" });
        const c = procs[0]!;
        c.emitOut("RE");
        c.emit("exit", 0);
        c.emitOut("ADY\n");
        c.emit("close", 0);
        expect(lines.map((l) => l.text)).toContain("READY"); // 单行（修前 RE/ADY 两行）
        expect(evs.some((e) => e.type === "match" && e.matchedLine === "READY")).toBe(true);
        const exit = evs.find((e) => e.type === "exit") as { lastLines: string[] };
        expect(exit.lastLines).toContain("READY"); // 退出快照含完整行（修前只有 RE）
    });

    // GPT Astra 十六轮 #2：常驻 watcher（once:false）每次命中删 watcherMeta →
    // pattern 变 "?"、armed 计数掉 0 → idle 回收误杀常驻观察。仅一次性完成才删。
    test("常驻 watcher 二次命中：pattern 保持 + armed 计数不掉（idle 保护）", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const evs = collect(m);
        await m.start("x");
        const id = m.list()[0]!.sessionId;
        m.watch(id, { pattern: "BEAT", once: false });
        const c = procs[0]!;
        c.emitOut("BEAT-1\n");
        c.emitOut("BEAT-2\n"); // 常驻第二次命中（修前 meta 已删 → pattern "?"）
        const matches = evs.filter((e) => e.type === "match") as Array<{ pattern: string; matchedLine: string }>;
        expect(matches.length).toBe(2);
        expect(matches[1]!.pattern).toBe("BEAT"); // 修前："?"
        expect(m.list()[0]!.armedWatchers).toBe(1); // armed 保持（修前 0 → 会被 idle 回收）
    });

    // GPT Astra 十六轮 #3：无换行长输出 pending 无限累积（4MiB 后窗口仍空）。
    // 上限 64KB 保尾截断 + 标记；换行终到后（截断标记）行入窗。
    test("pending 上限：4MiB 无换行不无限累积，保尾截断入窗", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const lines: import("../src/session-buffer.js").SessionLine[] = [];
        await m.start("x", { onLine: (l) => lines.push(l) });
        const c = procs[0]!;
        for (let i = 0; i < 64; i++) c.emitOut("X".repeat(64 * 1024)); // 4MiB 无换行
        c.emitOut("\n"); // 终于换行
        c.exitWith(0);
        expect(lines.length).toBe(1); // 单行入窗（修前 pending 全量 4MiB、窗口空）
        expect(lines[0]!.text.length).toBeLessThan(70 * 1024); // 保尾 + 标记（ring 另有单行截断）
        expect(lines[0]!.text).toContain("filaxis-truncated"); // 截断显式标记
    });

    // 自审 1-A：error 路径统一 finalizeStream——修前独立 emit 不设 finalized，
    // 后续 exit/close 到达会**再发一次** exit（双发）；lastLines 携带错误消息。
    test("spawn error：exit 事件恒一声 + lastLines 携错误消息（后续 exit/close 不双发）", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const evs = collect(m);
        await m.start("x");
        const c = procs[0]!;
        c.emit("error", new Error("spawn boom"));
        c.emit("exit", 1); // error 后仍可能到——不得双发
        c.emit("close", 1);
        const exits = evs.filter((e) => e.type === "exit");
        expect(exits.length).toBe(1); // 修前：双发
        expect((exits[0] as { lastLines: string[] }).lastLines).toContain("spawn boom");
    });

    // GPT Astra 十七轮 #2：带 g 标志的 RegExp watcher——test 有 lastIndex 状态，
    // 连续 READY 三行曾「命中、漏掉、命中」；且持有调用方实例反向污染其 lastIndex。
    test("g 正则常驻 watcher：连续命中行全中 + 调用方 lastIndex 零污染", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const evs = collect(m);
        await m.start("x");
        const id = m.list()[0]!.sessionId;
        const userRe = /READY/g; // 调用方持有的带状态正则
        m.watch(id, { pattern: userRe, once: false });
        const c = procs[0]!;
        c.emitOut("READY\nREADY\nREADY\n"); // 三行全应命中（修前：漏第二行）
        const matches = evs.filter((e) => e.type === "match");
        expect(matches.length).toBe(3);
        expect(userRe.lastIndex).toBe(0); // 调用方实例零污染（修前被 test 推进）
    });
});

// 孪生对齐审计（三十九期后全弧复盘）：三十七/三十八期 EventBus 异步拒绝隔离在
// 观察流引擎的漏改面——onEvent + onLine/onExit 桥三处，async 回调 rejection 逃逸
// unhandledRejection 崩宿主（settleRejection 接线）。
describe("观察流 async 回调隔离（孪生对齐审计）", () => {
    test("async onEvent/onLine/onExit 全 rejection 不崩宿主", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        m.onEvent = async () => { throw new Error("onEvent async boom"); };
        const asyncBoom = async () => { throw new Error("bridge async boom"); };
        await m.start("x", { onLine: asyncBoom, onExit: asyncBoom });
        const c = procs[0]!;
        c.emitOut("LINE_ONE\n");
        c.exitWith(0);
        await new Promise((r) => setTimeout(r, 100)); // 等异步 rejection 处理
        // 修前：任一 rejection 逃逸 → unhandledRejection（bun test 直接 fail）
        expect(m.list()[0]!.running).toBe(false); // 终态照常（异常不杀流引擎）
    }, 15_000);
});

// GPT Astra 四十九期：#1 行回调内 stop() 打乱交付序（drain 冲出的尾行先于本块后续行，exit
// 早于 watcher 命中，lastLines 缺行）；#2 超长行截断跨块不一致（换行分离块曾丢行首标记）。
// 补漏两件：onScreen 桥 async 拒绝（四十三期 async-guard 接线漏网）+ finalized 后 late data 幽灵回调。
const NL = "\n";
const E = "\u001b";
describe("四十九期：回调内停止与跨块一致性", () => {
    test("#1 onLine 内 stop：本块按到达序交付完再收尾（last 不抢跑，exit 最后，lastLines 全）", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const delivered: string[] = [];
        const evs: string[] = [];
        m.onEvent = (e) => { evs.push(e.type); };
        const h = await m.start("x", {
            onLine: (l) => { delivered.push(l.text); if (l.text === "READY") m.stop(h.sessionId); },
        });
        const c = procs[0]!;
        c.emitOut("READY\nsecond\nlast"); // 单块三行（last 无尾换行进 pending）
        await new Promise((r) => setTimeout(r, 100));
        expect(delivered).toEqual(["READY", "second", "last"]); // 修前：["READY","last","second"]（drain 抢跑）
        const exitIdx = evs.indexOf("exit");
        expect(exitIdx).toBeGreaterThan(-1);
        expect(evs.indexOf("match")).toBeLessThan(exitIdx); // READY 的 watcher 命中先于 exit（修前：之后）
        const exit = m.list(); // entries 已删——事件流断言为主
        void exit;
    }, 15_000);

    test("#2 超长行跨块一致：换行分离块 watcher 同样命中（行首标记不被截掉）", async () => {
        const mk = async () => {
            const { impl, procs } = fakeSpawn();
            const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
            const evs: SessionEvent[] = [];
            m.onEvent = (e) => evs.push(e);
            await m.start("x");
            return { m, procs, evs };
        };
        const LONG = "READY" + "x".repeat(65_536); // 一行 > PENDING_MAX(64K)
        // 形态 A：整行连换行一次送达
        const a = await mk();
        a.m.watch(a.m.list()[0]!.sessionId, { pattern: "READY", once: true });
        a.procs[0]!.emitOut(LONG + NL);
        // 形态 B：同字节，换行符单独下一块
        const b = await mk();
        b.m.watch(b.m.list()[0]!.sessionId, { pattern: "READY", once: true });
        b.procs[0]!.emitOut(LONG);
        b.procs[0]!.emitOut(NL);
        await new Promise((r) => setTimeout(r, 50));
        expect(a.evs.filter((e) => e.type === "match").length).toBe(1); // 基线：整行命中
        expect(b.evs.filter((e) => e.type === "match").length).toBe(1); // 修前：0（跨块丢行首）
    }, 15_000);

    test("补漏：onScreen 桥 async 拒绝不崩宿主 + finalized 后 late data 零回调", async () => {
        const { impl, procs } = fakeSpawn();
        const m = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const linesAfterExit: string[] = [];
        await m.start("x", {
            onScreen: async () => { throw new Error("screen boom"); },
            onLine: (l) => linesAfterExit.push(l.text),
        });
        const c = procs[0]!;
        c.emitOut("GHOST" + E + "[2J"); // 触发 onScreen（转义序列进屏）——async reject 不崩
        c.exitWith(0);
        c.emitOut("LATE\n"); // 退出后的迟到 data——不得再回调 onLine
        await new Promise((r) => setTimeout(r, 80));
        expect(linesAfterExit.length).toBe(1);            // 仅 exit 前的 GHOST 行（合法）
        expect(linesAfterExit[0]).toContain("GHOST");
        expect(linesAfterExit.join(" ")).not.toContain("LATE"); // 修前：LATE 幽灵交付
    }, 15_000);
});
