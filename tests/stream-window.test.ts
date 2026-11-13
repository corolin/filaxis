/**
 * 流式观察窗测试（local 窗真跑；remote 窗 mock spawnImpl）
 */
import { describe, expect, test } from "bun:test";
import { StreamWindow, StreamWindowRegistry } from "../src/stream-window.js";
import { resolveLocalShell } from "../src/shell-discovery.js";

const BASH = resolveLocalShell(); // 环境无关（System32 WSL 入口优先的 PATH 下裸 "bash" 会解析到 WSL）
import { StreamSessionManager, type SpawnImpl } from "../src/stream-session-manager.js";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    stdin = { write: () => true, end: () => true };
    pid = 31337;
    killed = false;
    kill(sig?: string) { this.killed = true; this.emit("exit", 0); this.emit("close", 0); return true; }
    emitOut(t: string) { this.stdout.emit("data", Buffer.from(t)); }
    emitErr(t: string) { this.stderr.emit("data", Buffer.from(t)); }
    exit() { this.emit("exit", 0); this.emit("close", 0); } // node 真语义：exit 后必发 close
}

const fakeSpawn = (): { impl: SpawnImpl; procs: FakeChild[] } => {
    const procs: FakeChild[] = [];
    return { procs, impl: () => { const c = new FakeChild(); procs.push(c); return c as unknown as ChildProcess; } };
};

describe("StreamWindow（帧/peek/游标/stale）", () => {
    test("帧单调递增 + peek 三模式非破坏 + 多消费者游标互不干扰", () => {
        const w = new StreamWindow("t", "local", "t", "x", 3, 1024); // maxFrames=3
        for (const t of ["a", "b", "c", "d", "e"]) w.push(t);
        expect(w.frameCount).toBe(3); // 环形覆盖
        expect(w.oldestSeq).toBe(3);
        expect(w.newestSeq).toBe(5); // 断续编不归零
        const last = w.peekLast(2);
        expect(last.frames.map((f) => f.text)).toEqual(["d", "e"]);
        expect(w.peekLast(100).frames.length).toBe(3); // 非破坏
        // since 续读：consumerA 与 consumerB 游标独立
        const a1 = w.peekSince(0, 10, "A");
        expect(a1.frames.map((f) => f.text)).toEqual(["c", "d", "e"]);
        expect(w.consumerSeq("A")).toBe(5);
        expect(w.consumerSeq("B")).toBe(0); // 未读
        w.push("f");
        const b1 = w.peekSince(w.consumerSeq("B"), 10, "B");
        expect(b1.frames.length).toBe(3); // B 从 0 读全窗（maxFrames=3：d,e,f）
        expect(w.peekSince(0, 10).gap).toBe(true); // R6 #3 语义修正：从头读但历史已环形覆盖=显式空洞（原 undefined=无感知丢帧）
        expect(w.peekSince(0, 10, "fresh").gap).toBe(true); // 新消费者视角同样可见
    });

    test("环形覆盖空洞 gap 显式 + stale 复活", () => {
        const w = new StreamWindow("t2", "local", "t2", "x", 2, 1024);
        w.push("1"); w.push("2"); w.push("3"); w.push("4"); // 覆盖到 [3,4]（oldest=3）
        const r = w.peekSince(1, 10);
        expect(r.gap).toBe(true); // oldest=3 > 1+1：空洞显式
        expect(r.frames.map((f) => f.text)).toEqual(["3", "4"]);
        w.markStale();
        expect(w.peekLast(1).stale).toBe(true);
        w.push("4");
        expect(w.peekLast(1).stale).toBe(false); // 新帧复活
    });

    test("超长帧截断含后缀", () => {
        const w = new StreamWindow("t3", "local", "t3", "x", 10, 20);
        w.push("x".repeat(100));
        expect(w.peekLast(1).frames[0]!.text.endsWith("…[truncated]")).toBe(true);
        expect(Buffer.byteLength(w.peekLast(1).frames[0]!.text, "utf-8")).toBe(20); // 字节口径（Sol 55 P2-G——「…」3 字节后缀实测 20B 上限精确）
    });
});

describe("StreamWindowRegistry", () => {
    test("local 窗 open/stop/list/通配 peek + 关窗收割", async () => {
        const reg = new StreamWindowRegistry({ shell: BASH });
        const w = await reg.open({ name: "loc:probe", command: "echo W1; echo W2; sleep 5" });
        await new Promise((r) => setTimeout(r, 800));
        expect(w.peekLast(5).frames.map((f) => f.text)).toContain("W1");
        expect(reg.list()[0]!.name).toBe("loc:probe");
        expect(reg.peek("loc:*").length).toBe(1); // 通配
        w.markStale(); // 进程还活着 → 新帧复活测试在 push 已测；stop 收割
        reg.stop("loc:probe");
        expect(reg.get("loc:probe")).toBeUndefined();
        expect(w.closed).toBe(true);
        await reg.open({ name: "loc:probe", command: "echo ok" }); // stop 后可重建
        reg.dispose();
    }, 20_000);

    test("remote 窗：引擎行对象→帧 + onExit→stale + 关窗 stop 引擎会话", async () => {
        const { impl, procs } = fakeSpawn();
        const mgr = new StreamSessionManager(["host"], { spawnImpl: impl, disableMux: true });
        const reg = new StreamWindowRegistry();
        const w = await reg.open({ name: "vm:log", layerAlias: "vm", command: "tail -f x", manager: mgr });
        procs[0]!.emitOut("R1\nR2\n");
        procs[0]!.emitErr("E1\n");
        await new Promise((r) => setTimeout(r, 100));
        const texts = w.peekLast(5).frames.map((f) => f.text);
        expect(texts).toContain("R1");
        expect(texts).toContain("R2");
        expect(texts).toContain("E1"); // 双流皆入窗（窗层不分会）
        procs[0]!.exit();
        await new Promise((r) => setTimeout(r, 50));
        expect(w.stale).toBe(true);
        reg.stop("vm:log");
        expect(procs[0]!.killed).toBe(true); // 关窗收割流进程
        reg.dispose();
    });
});

// GPT Astra 二十五期 #1：shell 不存在时 spawn ENOENT 无 error 监听 = uncaughtException
// 崩宿主。修后 open() reject + 零窗口残留。
describe("本地窗启动失败（二十五期）", () => {
    test("不存在的 shell → open 拒绝（不崩宿主）+ 无窗口残留", async () => {
        const reg = new StreamWindowRegistry({ shell: "/nonexistent/fx-shell" });
        await expect(reg.open({ name: "t:bad", command: "echo x" })).rejects.toThrow(/不可执行/);
        expect(reg.peek("t:bad")).toEqual([]); // 零残留
    }, 15_000);
});

// GPT Astra 二十六期 #2：双流共用 Splitter 半行串流——stdout 半行 OUT_PART 与
// stderr 的 ERR_LINE\n 拼成一行。双 Splitter 后各归各行（到达序保留）。
describe("本地窗双流半行（二十六期）", () => {
    test("stdout 半行不吞 stderr 行（各 Splitter 分离缓冲）", async () => {
        const reg = new StreamWindowRegistry({ shell: BASH });
        const win = await reg.open({ name: "t:mixed", command: "echo OUT_PART; echo ERR_LINE 1>&2; sleep 0.4; echo END" });
        await new Promise((r) => setTimeout(r, 1200));
        const texts = reg.peek("t:mixed").map((w) => w.peekLast(50).frames.map((f) => f.text)).flat();
        expect(texts).toContain("OUT_PART"); // 修前：OUT_PARTERR_LINE（跨流拼接）
        expect(texts).toContain("ERR_LINE");
        expect(texts).toContain("END");
        expect(texts.some((t) => t.includes("OUT_PARTERR"))).toBe(false);
        reg.stop("t:mixed");
    }, 15_000);
});

// GPT Astra 三十八期 #1：跨块 UTF-8——多字节字符劈在 chunk 边界，逐块 toString
// 首尾各产一个 U+FFFD。StringDecoder 持回不完整序列，流终 residual 经 end() 补齐。
describe("本地窗跨块 UTF-8（三十八期）", () => {
    test("「你」劈两半跨 chunk 到达 → 整字入帧零替换符", async () => {
        const reg = new StreamWindowRegistry({ shell: BASH });
        // 「你好」= \344\275\240\345\245\275：首写只出「你」前两字节（无换行），
        // 隔 0.3s 补余下字节+换行——两 chunk 由时间差保证分属两次 data 事件
        const win = await reg.open({ name: "t:utf8", command: "printf '\\344\\275'; sleep 0.3; printf '\\240\\345\\245\\275\\n'" });
        await new Promise((r) => setTimeout(r, 1500));
        const texts = win.peekLast(10).frames.map((f) => f.text);
        expect(texts).toContain("你好"); // 修前："\uFFFD\uFFFD好"（首块尾+次块头各一替换符）
        expect(texts.some((t) => t.includes("\uFFFD"))).toBe(false);
        reg.stop("t:utf8");
    }, 15_000);
});

// GPT Astra 三十九期：#1 并发同名开窗重名检查在异步启动前、注册在后——双开都
// 成功各建观察流（remote s1/s2 或 local 双 spawn），后写覆盖前写=前窗脱离注册表
// 无人收割。#2 exit≠stdio 排空终点——exit 上冲刷把半行提前成帧、迟到数据又复活 stale。
describe("三十九期", () => {
    test("#1 并发同名 open：一成一拒 + 恰一路观察流 + 停的就是成功那路", async () => {
        const started: string[] = [];
        const stopped: string[] = [];
        const manager = {
            start: async (_cmd: string, _o: unknown) => {
                await new Promise((r) => setTimeout(r, 80)); // 制造并发窗
                const sid = `s-${started.length + 1}`;
                started.push(sid);
                return { sessionId: sid };
            },
            stop: (sid: string) => { stopped.push(sid); },
        } as unknown as StreamSessionManager;
        const reg = new StreamWindowRegistry();
        const results = await Promise.allSettled([
            reg.open({ name: "vm:dup", layerAlias: "vm", command: "x", manager }),
            reg.open({ name: "vm:dup", layerAlias: "vm", command: "x", manager }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
        expect(results.filter((r) => r.status === "rejected").length).toBe(1); // 修前：双成功
        expect(started.length).toBe(1); // 修前：2（s1 无人停——未登记观察流泄漏）
        expect(reg.list().length).toBe(1);
        reg.stop("vm:dup");
        expect(stopped).toEqual([started[0]!]); // 收割的正是成功那路的会话
    }, 15_000);

    test("#1b local 真跑并发同名同样一成一拒", async () => {
        const reg = new StreamWindowRegistry({ shell: BASH });
        const results = await Promise.allSettled([
            reg.open({ name: "t:dup2", command: "echo L1; sleep 0.6; echo L2" }),
            reg.open({ name: "t:dup2", command: "echo L3; sleep 0.6; echo L4" }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
        expect(new Set(results.map((r) => r.status)).size).toBe(2); // 一成一拒
        expect(reg.list().length).toBe(1);
        reg.stop("t:dup2");
        reg.dispose();
    }, 15_000);

    test("#2 exit 早于尾数据（RE→exit→ADY\n→close）：拼合 READY 单帧 + stale 保持", async () => {
        const procs: FakeChild[] = [];
        const reg = new StreamWindowRegistry({
            shell: "bash",
            spawnImpl: (() => { const c = new FakeChild(); procs.push(c); return c as unknown as ChildProcess; }) as unknown as typeof import("node:child_process").spawn,
        });
        const win = await reg.open({ name: "t:late", command: "fake" });
        const c = procs[0]!;
        c.emitOut("RE");
        c.emit("exit", 0);
        await new Promise((r) => setTimeout(r, 30));
        c.emitOut("ADY\n"); // 修前：exit 已把 RE 冲刷成帧，ADY 另成一帧且复活 stale
        c.emit("close", 0);
        await new Promise((r) => setTimeout(r, 30));
        expect(win.peekLast(10).frames.map((f) => f.text)).toEqual(["READY"]); // 修前：["RE","ADY"]
        expect(win.stale).toBe(true); // 修前：迟到 push 复活成 false
        reg.stop("t:late");
        reg.dispose();
    }, 15_000);

    // Astra 四十期 #2：dispose 只关已登记窗——在途 open 完成后迟注册（sweeper 已停
    // 无人回收=观察流孤儿）。修=disposed 标志 + 迟注册前自收割 + 后续 open 早拒。
    test("#3 启动途中 dispose：在途窗收割 + 迟注册拒绝 + 注册表零残留", async () => {
        const stopped: string[] = [];
        const manager = {
            start: async () => { await new Promise((r) => setTimeout(r, 80)); return { sessionId: "s-disp" }; },
            stop: (sid: string) => { stopped.push(sid); },
        } as unknown as StreamSessionManager;
        const reg = new StreamWindowRegistry();
        const p = reg.open({ name: "vm:disp", layerAlias: "vm", command: "x", manager });
        await new Promise((r) => setTimeout(r, 20)); // 进入启动途中（manager.start 挂起中）
        reg.dispose();
        let rejected = false;
        await p.catch(() => { rejected = true; });
        expect(rejected).toBe(true);              // 修前：fulfilled（dispose 后迟注册成功）
        expect(reg.list().length).toBe(0);        // 修前：1（无人回收的孤儿窗）
        expect(stopped).toEqual(["s-disp"]);      // 在途引擎会话已收割（win.close）
        await expect(reg.open({ name: "vm:after", layerAlias: "vm", command: "x", manager }))
            .rejects.toThrow(/dispose/);          // dispose 后新调用早拒（不白启动）
    }, 15_000);
});

// GPT Astra 五十期：#1 文档承诺「重开同名窗续编」但实现归零——旧游标 peekSince 静默漏帧且
// gap 不置位；#2 文档教「拿 newestSeq 续读」——限页时跳过未读帧；#3 peek 返回帧与内部共享
// 引用——调用方改写殃及其他消费者。
describe("五十期：续编/翻页/快照隔离", () => {
    test("#1 同名窗重开续编：旧游标无缝续读 + 游标超前 gap 显式", async () => {
        const reg = new StreamWindowRegistry({ shell: BASH });
        const w1 = await reg.open({ name: "t:re", command: "echo A; echo B; echo C" });
        await new Promise((r) => setTimeout(r, 1200));
        const first = w1.peekSince(0, 50, "reader");
        expect(first.frames.length).toBe(3);
        const cursor = w1.consumerSeq("reader"); // =3
        reg.stop("t:re");
        const w2 = await reg.open({ name: "t:re", command: "echo D; echo E" }); // 重开（文档路径）
        await new Promise((r) => setTimeout(r, 1200));
        const resume = w2.peekSince(cursor, 50); // 旧游标续读
        expect(resume.frames.map((f) => f.text)).toEqual(["D", "E"]); // 修前：[]（归零漏帧）
        expect(resume.gap).toBeUndefined();       // 修前也不置 gap（静默）
        expect(w2.oldestSeq).toBe(4);             // 新帧从冻结 seq 之后（4、5）
        const ahead = w2.peekSince(999);          // 游标超前（旧窗/异常值）
        expect(ahead.gap).toBe(true);             // 显式信号（五十期补：不静默当无新帧）
        reg.stop("t:re");
        reg.dispose();
    }, 20_000);

    test("#2 限页翻读：lastDeliveredSeq 续读不跳帧（newestSeq 会跳）", () => {
        const w = new StreamWindow("t2", "local", "t2", "x", 10, 1024);
        for (const t of ["1", "2", "3", "4", "5"]) w.push(t); // 帧 1-5
        const page1 = w.peekSince(0, 2); // 限页 2
        expect(page1.frames.map((f) => f.text)).toEqual(["1", "2"]);
        expect(page1.newestSeq).toBe(5);              // 窗内最新——拿它续读会跳 3、4、5
        expect(page1.lastDeliveredSeq).toBe(2);       // 实际交付末帧（新字段）
        const page2 = w.peekSince(page1.lastDeliveredSeq!);
        expect(page2.frames.map((f) => f.text)).toEqual(["3", "4", "5"]); // 不跳帧
    });

    test("#3 快照隔离：改写返回帧不影响窗口与其它消费者", () => {
        const w = new StreamWindow("t3", "local", "t3", "x", 10, 1024);
        for (let i = 1; i <= 5; i++) w.push("L" + i);
        const snap = w.peekLast(1);
        snap.frames[0]!.seq = 1;   // 恶意/误写返回帧
        snap.frames[0]!.text = "HACKED";
        expect(w.newestSeq).toBe(5);                        // 修前：1（共享引用被改写）
        expect(w.peekLast(5).frames[4]!.text).toBe("L5");   // 其他消费者读到的仍是原帧
    });
});

// GPT Astra 五十一期：#1 五十期续编锚绑在缓冲 newestSeq 上——空窗（重开未收帧）stop 用 0
// 归零覆盖已存帧号+空窗 peekSince 误报 gap；#2 本地窗 LineSplitter 未完成行随输出无限涨
// （32MiB 无换行堆涨 32MiB——maxLineBytes 只在成行后截）。
const NL51 = "\n";
const CR55 = "\r";
describe("五十一期：空窗续锚 + 未完成行封顶", () => {
    test("#1 空窗不归零续锚：重开空窗 peekSince 不误报 gap，再关再开首帧续编", () => {
        const w1 = new StreamWindow("t:chain", "local", "t", "x", 10, 1024);
        for (const t of ["A", "B", "C"]) w1.push(t); // 帧 1-3
        const reg = new StreamWindowRegistry({ shell: BASH });
        // 直接经 Registry 记锚（stop 需要 registry 窗——手动注册同构场景）
        (reg as unknown as { lastSeqByName: Map<string, number> }).lastSeqByName.set("t:chain", w1.allocatedSeq);
        const w2 = new StreamWindow("t:chain", "local", "t", "x", 10, 1024, w1.allocatedSeq); // 重开（空窗）
        const empty = w2.peekSince(3); // 旧游标读空窗
        expect(empty.gap).toBeUndefined();          // 修前：true（newestSeq=0 误判超前）
        expect(empty.frames).toEqual([]);
        expect(w2.allocatedSeq).toBe(3);            // 续编锚保留（缓冲空也在）
        // 空窗再关再开（五十期 stop 用 allocatedSeq 不归零——五十一期修）
        const w3 = new StreamWindow("t:chain", "local", "t", "x", 10, 1024, w2.allocatedSeq);
        w3.push("NEXT");
        const r = w3.peekSince(3);
        expect(r.frames.map((f) => f.text)).toEqual(["NEXT"]); // 修前：读不到（首帧归 1）
        expect(r.frames[0]!.seq).toBe(4);
    });

    test("#2 未完成行封顶：分块无换行有界 + 整行/分块输出逐字节一致", async () => {
        // 本地 splitter 路径经 FakeChild 驱动
        const procs: FakeChild[] = [];
        const reg = new StreamWindowRegistry({
            shell: BASH,
            spawnImpl: (() => { const c = new FakeChild(); procs.push(c); return c as unknown as ChildProcess; }) as unknown as typeof import("node:child_process").spawn,
        });
        const win = await reg.open({ name: "t:flood", command: "x", maxLineBytes: 64 });
        const c = procs[0]!;
        const big = "y".repeat(1024 * 1024); // 1MiB 无换行 ×8 块 = 8MiB
        for (let i = 0; i < 8; i++) c.emitOut(big);
        c.emitOut(NL51); // 换行成行
        await new Promise((r) => setTimeout(r, 30));
        const frames = win.peekLast(5).frames;
        expect(frames.length).toBe(1);
        expect(Buffer.byteLength(frames[0]!.text, "utf-8")).toBe(64);   // 封顶 ≤ maxLineBytes 字节口径（Sol 55 P2-G；修前 8MiB 堆涨）
        expect(frames[0]!.text.endsWith("…[truncated]")).toBe(true);
        // 一致性：整行一次喂（同字节）→ 输出逐字节同
        const procs2: FakeChild[] = [];
        const reg2 = new StreamWindowRegistry({
            shell: BASH,
            spawnImpl: (() => { const c = new FakeChild(); procs2.push(c); return c as unknown as ChildProcess; }) as unknown as typeof import("node:child_process").spawn,
        });
        const win2 = await reg2.open({ name: "t:one", command: "x", maxLineBytes: 64 });
        procs2[0]!.emitOut(big + big + big + big + big + big + big + big + NL51); // 8MiB 整行一次
        await new Promise((r) => setTimeout(r, 30));
        expect(win2.peekLast(5).frames[0]!.text).toBe(frames[0]!.text); // 跨块一致（同公式）
        reg.dispose();
        reg2.dispose();
    }, 20_000);
});

// GPT Sol 五十二期：#1 密集短行递归栈溢出（64KiB 短行批实测 18,473 帧 RangeError）；#2 短行
// 同批到达被误截断（整块长度判定——后续行数据计入首行）；#3 maxFrames:0 的 slice(-0) 失去上限。
describe("五十二期：迭代扫描 + 逐行截断 + 零容量", () => {
    test("#1 64KiB 密集短行一次交付不栈溢出（全部成帧）", async () => {
        const procs: FakeChild[] = [];
        const reg = new StreamWindowRegistry({
            shell: BASH,
            spawnImpl: (() => { const c = new FakeChild(); procs.push(c); return c as unknown as ChildProcess; }) as unknown as typeof import("node:child_process").spawn,
        });
        const win = await reg.open({ name: "t:flood52", command: "x", maxFrames: 40_000 });
        const chunk = "x\n".repeat(32_768); // 64KiB 全短行
        expect(() => procs[0]!.emitOut(chunk)).not.toThrow(); // 修前：18,473 帧处 RangeError
        expect(win.frameCount).toBe(32_768); // 全部成帧
        reg.dispose();
    }, 15_000);

    test("#2 短行同批到达不误截断（逐行判定）", async () => {
        const procs: FakeChild[] = [];
        const reg = new StreamWindowRegistry({
            shell: BASH,
            spawnImpl: (() => { const c = new FakeChild(); procs.push(c); return c as unknown as ChildProcess; }) as unknown as typeof import("node:child_process").spawn,
        });
        const win = await reg.open({ name: "t:batch52", command: "x", maxLineBytes: 12 });
        procs[0]!.emitOut("12345678\nOK\nZ\n"); // 一次同批
        await new Promise((r) => setTimeout(r, 30));
        expect(win.peekLast(10).frames.map((f) => f.text)).toEqual(["12345678", "OK", "Z"]); // 修前首行被截
        reg.dispose();
    }, 15_000);

    test("#3 maxFrames:0 无缓冲（帧即弃）+ peekLast(0) 返回空", () => {
        const w = new StreamWindow("t0", "local", "t0", "x", 0, 1024);
        for (let i = 0; i < 1000; i++) w.push("L" + i);
        expect(w.frameCount).toBe(0); // 修前：1000（slice(-0) 复制全数组）
        expect(w.newestSeq).toBe(1000); // seq 分配照常（续编/游标语义保持）
        const w2 = new StreamWindow("t1", "local", "t1", "x", 10, 1024);
        for (let i = 0; i < 10; i++) w2.push("F" + i);
        expect(w2.peekLast(0).frames).toEqual([]); // 修前：全部 10 帧
        expect(w2.peekLast(-3).frames).toEqual([]); // 负数同样空
    });
});

// GPT Sol 五十五期：跨块 CRLF 仍截断（buf 尾 CR 留块未剥）+ 字节口径（UTF-16 码元曾当字节）。
describe("五十五期：跨块 CRLF + 字节口径", () => {
    test("P2-F abcdefghijkl<CR> 与 <LF> 分块到达——正文完整不截断", async () => {
        const procs: FakeChild[] = [];
        const reg = new StreamWindowRegistry({
            shell: BASH,
            spawnImpl: (() => { const c = new FakeChild(); procs.push(c); return c as unknown as ChildProcess; }) as unknown as typeof import("node:child_process").spawn,
        });
        const win = await reg.open({ name: "t:crlf55", command: "x", maxLineBytes: 12 });
        const c = procs[0]!;
        c.emitOut("abcdefghijkl" + CR55); // 上块：正文+CR（无换行）
        c.emitOut(NL51);                 // 下块：只有换行——成行
        await new Promise((r) => setTimeout(r, 30));
        expect(win.peekLast(5).frames.map((f) => f.text)).toEqual(["abcdefghijkl"]); // 修前截断标记
        reg.dispose();
    }, 15_000);

    test("P2-G 字节口径：10 个「中」30 字节超 13 上限必截断（UTF-16 码元曾透传）", () => {
        const w = new StreamWindow("t56", "local", "t", "x", 10, 25); // 后缀 14B——上限须大于后缀
        w.push("中".repeat(10)); // 30B
        const t = w.peekLast(1).frames[0]!.text;
        expect(Buffer.byteLength(t, "utf-8")).toBeLessThanOrEqual(25); // 修前 30B 透传
        expect(t.endsWith("…[truncated]")).toBe(true);
    });
});
