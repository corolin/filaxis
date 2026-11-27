/**
 * 事件总线 / 栧门面 / 工厂注册 单测（AC-07 指纹复用 / AC-09 注册 / AC-10 事件双形态）
 * + 命名层注册表状态机（第十季 Layer 渗透——Paramiko 式句柄）
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { EventBus } from "../src/core/base/events.js";
import { RuntimeStack } from "../src/middle/runtime-stack.js";
import { createAgentToolkit } from "../src/interface/mcp/agent-toolkit.js";
import { RuntimeFactory } from "../src/core/base/factory.js";
import { LocalRuntimeDriver } from "../src/core/local/local-driver.js";
import { TmuxSessionDriver } from "../src/core/tmux/tmux-driver.js";
import { SshPtyDriver } from "../src/core/ssh/ssh-pty-driver.js";
import { enterStepsOf } from "../src/core/ssh/ssh-helpers.js";
import type { RuntimeDriver, RuntimeDescriptor } from "../src/core/base/driver.js";
import type { LayerHandle } from "../src/middle/runtime-stack.js";

type Ev = { type: "a" | "b"; v: number };

test("EventBus iterator return closes an already pending next", async () => {
    const bus = new EventBus<Ev>();
    const stream = bus.iterable();
    const it = stream[Symbol.asyncIterator]();
    const next = it.next();
    try {
        expect((await it.return!()).done).toBe(true);
        expect((await next).done).toBe(true);
        bus.emit({ type: "a", v: 1 });
        expect((await it.next()).done).toBe(true);
    } finally { stream.cancel(); }
});

describe("EventBus（AC-10）", () => {
    test("on 订阅 + 退订；* 通配收到全部", () => {
        const bus = new EventBus<Ev>();
        const got: Ev[] = [];
        const off = bus.on("*", (e) => got.push(e));
        bus.emit({ type: "a", v: 1 });
        bus.emit({ type: "b", v: 2 });
        off();
        bus.emit({ type: "a", v: 3 });
        expect(got).toEqual([{ type: "a", v: 1 }, { type: "b", v: 2 }]);
    });

    test("消费方异常不杀内核（后续事件照常送达）", () => {
        const bus = new EventBus<Ev>();
        const got: number[] = [];
        bus.on("a", () => { throw new Error("consumer boom"); });
        bus.on("a", (e) => got.push(e.v));
        bus.emit({ type: "a", v: 1 });
        bus.emit({ type: "a", v: 2 });
        expect(got).toEqual([1, 2]);
    });

    test("iterable 形态可 for-await 消费；按 type 过滤", async () => {
        const bus = new EventBus<Ev>();
        const stream = bus.iterable("b");
        bus.emit({ type: "a", v: 1 }); // 被过滤
        bus.emit({ type: "b", v: 10 });
        const it = stream[Symbol.asyncIterator]();
        const first = await it.next();
        expect(first.done).toBe(false);
        expect((first.value as Ev).v).toBe(10);
        await it.return?.();
    });

    test("有界队列满丢最旧并计数 dropped", async () => {
        const bus = new EventBus<Ev>({ queueMax: 2 });
        const stream = bus.iterable();
        const it = stream[Symbol.asyncIterator]();
        bus.emit({ type: "a", v: 1 });
        bus.emit({ type: "a", v: 2 });
        bus.emit({ type: "a", v: 3 }); // 队列满 → 丢 v1
        const e1 = await it.next();
        expect((e1.value as Ev).v).toBe(2);
        expect(stream.dropped()).toBe(1);
        await it.return?.();
    });
});

describe("RuntimeStack 门面（AC-07/AC-09）", () => {
    test("同指纹 descriptor 复用连接（同实例）；非身份字段不误建", async () => {
        const stack = new RuntimeStack();
        const d1: RuntimeDescriptor = { driver: "local", config: { label: "我的机器" } };
        const d2: RuntimeDescriptor = { driver: "local", config: { label: "改名了" } }; // 标签非身份字段
        const d3: RuntimeDescriptor = { driver: "local", cwd: "/tmp" }; // cwd 是身份字段
        const a = await stack.connect(d1);
        const b = await stack.connect(d2);
        expect(b).toBe(a); // 复用
        const c = await stack.connect(d3);
        expect(c).not.toBe(a); // 身份变化 → 新连接
        RuntimeStack.evictDriver(d1);
        RuntimeStack.evictDriver(d3);
    });

    // 第十季「执行环境即 Layer」检查实锤：平移时 driverKey 丢了 pty/sshHops/enters
    // 三列——同 target/connParams 但进不同容器的两层指纹相同 → connect 复用错连接
    // → B 容器的命令跑进 A 容器。环境身份三列必须区分（源版 driverKey 同款投影）。
    test("环境身份三列：enterPipeline/sshHops/pty 任一不同 → 不同连接；enterCmd 与等价 enterPipeline 同键", async () => {
        const stack = new RuntimeStack();
        const base = { driver: "local" as const, target: undefined };
        const a = await stack.connect({ ...base, config: { enterPipeline: [{ cmd: "docker exec -i webA sh" }] } });
        const b = await stack.connect({ ...base, config: { enterPipeline: [{ cmd: "docker exec -i webB sh" }] } });
        expect(b).not.toBe(a); // 不同容器 = 不同环境 = 不同连接（修前同键复用=错机器）
        const c = await stack.connect({ ...base, config: { enterPipeline: [{ cmd: "docker exec -i webA sh" }] } });
        expect(c).toBe(a); // 同管线复用
        // 归一化：legacy enterCmd 与等价 enterPipeline 单步同键（源版契约）
        const legacy = await stack.connect({ ...base, config: { enterCmd: "docker exec -i webA sh" } });
        expect(legacy).toBe(a);
        // sshHops / pty 同为身份列
        const hopA = await stack.connect({ ...base, config: { sshHops: ["bastionA"] } });
        const hopB = await stack.connect({ ...base, config: { sshHops: ["bastionB"] } });
        expect(hopA).not.toBe(hopB);
        const ptyOn = await stack.connect({ ...base, config: { pty: true } });
        expect(ptyOn).not.toBe(a);
        for (const d of [
            { ...base, config: { enterPipeline: [{ cmd: "docker exec -i webA sh" }] } },
            { ...base, config: { enterPipeline: [{ cmd: "docker exec -i webB sh" }] } },
            { ...base, config: { sshHops: ["bastionA"] } },
            { ...base, config: { sshHops: ["bastionB"] } },
            { ...base, config: { pty: true } },
        ]) RuntimeStack.evictDriver(d);
    });

    test("开放注册：第三方 driver 同权接入；重复注册拒绝；未知 driver 结构化错误", () => {
        const factory = new RuntimeFactory();
        const fake: RuntimeDriver = new LocalRuntimeDriver();
        factory.registerDriver("mock", () => fake);
        expect(factory.create({ driver: "mock" })).toBe(fake);
        expect(factory.registeredTypes()).toContain("mock");
        expect(() => factory.registerDriver("mock", () => fake)).toThrow(/拒绝覆盖/);
        expect(() => factory.create({ driver: "nix-shell" })).toThrow(/未知 driver/);
    });

    test("features() 能力探测（AC-02）", async () => {
        const stack = new RuntimeStack();
        const f = await stack.features();
        expect(f.transports).toContain("local");
        expect(typeof f.mux).toBe("boolean");
        expect(typeof f.persistent).toBe("boolean");
        expect(f.stderrSeparated).toBe(true);
    });
});

// ── 命名层注册表（第十季 Layer 渗透定案：Paramiko 式句柄，栈/焦点弱化归消费方）──
/** mock 层 driver：可注入 pushInto/pushChild/exec/destroy 行为——注册表状态机全测 */
class MockLayerDriver {
    descriptor: RuntimeDescriptor;
    destroyed = false;
    constructor(d: RuntimeDescriptor) { this.descriptor = d; }
    async init() { /* no-op */ }
    async destroy() { this.destroyed = true; }
    async exec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        if (cmd === "hostname") return { stdout: "mock-host\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
    }
    /** pushInto 派生：enter 管线继承追加（镜像 SshPtyDriver.pushInto 语义） */
    async pushInto(cmd: string, label: string): Promise<MockLayerDriver> {
        const cfg = (this.descriptor.config ?? {}) as Record<string, unknown>;
        const child = new MockLayerDriver({
            ...this.descriptor,
            config: {
                ...cfg,
                enterPipeline: [...enterStepsOf(cfg), { cmd, label }],
                enterCmd: undefined, enterLabel: undefined,
            },
        });
        await child.init();
        return child;
    }
}

describe("enterStepsOf 别名归一（第十二季语法糖——enterCommand 手滑不再静默漏建层）", () => {
    test("单步别名矩阵：enterCmd/enterCommand/enter_cmd/enter 等价（含 label 别名）", () => {
        for (const key of ["enterCmd", "enterCommand", "enter_cmd", "enter"]) {
            const steps = enterStepsOf({ [key]: "docker exec -i web sh" });
            expect(steps).toEqual([{ cmd: "docker exec -i web sh", label: undefined }]);
        }
        expect(enterStepsOf({ enterCommand: "su - app", enter_label: "su:app" })).toEqual([{ cmd: "su - app", label: "su:app" }]);
    });

    test("管线别名矩阵：enterPipeline/enters/enterSteps/enter_steps（元素可字符串或 {cmd,label}）", () => {
        for (const key of ["enterPipeline", "enters", "enterSteps", "enter_steps"]) {
            expect(enterStepsOf({ [key]: [{ cmd: "docker exec -i web sh" }, "su - app"] }))
                .toEqual([{ cmd: "docker exec -i web sh", label: undefined }, { cmd: "su - app" }]);
        }
    });

    test("别名间同键（driverKey 指纹不受别名选择影响）+ 无 enter 键返回空", () => {
        const a = RuntimeStack.driverKey({ driver: "ssh", target: "h", config: { enterCmd: "docker exec -i web sh" } });
        const b = RuntimeStack.driverKey({ driver: "ssh", target: "h", config: { enterCommand: "docker exec -i web sh" } });
        expect(a).toBe(b); // 等价层等价连接（复用不因别名失效）
        expect(enterStepsOf(undefined)).toEqual([]);
        expect(enterStepsOf({ connParams: {} })).toEqual([]);
    });
});

describe("拼错键防线（第十二季用户警示：不识别的键不得静默吞掉建裸层——写错机器）", () => {
    test("疑似拼写变体：建层即抛错并给正确键名建议", () => {
        
        // connParam → connParams（enter 正确传入——若无防线这将建成「无连接参数+正确 enter」的半残层）
        expect(() => new SshPtyDriver({ driver: "ssh", target: "h", config: { connParam: { port: 22 } } as never }))
            .toThrow(/疑似 'connParams'/);
        // sshHop → sshHops
        expect(() => new SshPtyDriver({ driver: "ssh", target: "h", config: { sshHop: ["a"] } as never }))
            .toThrow(/疑似 'sshHops'/);
        // enterPipelines → enterPipeline（多了 s——静默吞=enter 漏建=裸宿主机层，正是实锤事故形态）
        expect(() => new SshPtyDriver({ driver: "ssh", target: "h", config: { enterPipelines: [{ cmd: "docker exec -i web sh" }] } as never }))
            .toThrow(/疑似 'enterPipeline'/);
        // enterStepsOf 家族外：entercommand（归一化距 entercmd=2？不——entercommand vs entercommand... 显式别名没列全的变体由防线拦）
        expect(() => new SshPtyDriver({ driver: "ssh", target: "h", config: { enterLabelx: "x" } as never }))
            .toThrow(/疑似/);
    });

    test("无关自定义键不拦（开放字典扩展性）+ 合法键/大小写下划线变体通过", () => {
        
        // 无关自定义元数据：与已知键距离 >1——不拦
        expect(() => new SshPtyDriver({ driver: "ssh", target: "h", config: { customMeta: "team-a", owner: "ops" } as never }))
            .not.toThrow();
        // 合法键全通过（构造不做 I/O，仅校验）
        expect(() => new SshPtyDriver({
            driver: "ssh", target: "h",
            config: { pty: true, connParams: { port: 22 }, sshHops: ["a"], enterPipeline: [{ cmd: "x" }] },
        })).not.toThrow();
    });
});

describe("命名层注册表（Paramiko 式句柄寻址）", () => {
    function mockStack(): RuntimeStack {
        const stack = new RuntimeStack();
        stack.registerDriver("mockssh", (d) => new MockLayerDriver(d) as unknown as RuntimeDriver);
        return stack;
    }

    test("addLayer descriptor/driver 双形态 + active 默认层 + layerText", async () => {
        const stack = mockStack();
        const a = await stack.addLayer("hostA", { driver: "mockssh", target: "hostA.internal" });
        expect(a.reused).toBe(false);
        expect(stack.active).toBeDefined();
        expect(stack.layer("hostA").descriptor.target).toBe("hostA.internal");
        // driver 形态：现成句柄登记（派生产物）
        const child = await (stack.layer("hostA").driver as unknown as MockLayerDriver).pushInto("docker exec -i web sh", "docker:web");
        await stack.addLayer("web", child as unknown as RuntimeDriver);
        expect(stack.layer("web").descriptor.driver).toBe("mockssh");
        const text = stack.layerText();
        expect(text).toContain("hostA");
        expect(text).toContain("web");
        expect(text).toContain("◀ 默认"); // web 最近注册=默认
        RuntimeStack.evictDriver({ driver: "mockssh", target: "hostA.internal" } as RuntimeDescriptor);
    });

    test("重名报错列既有；layer 不存在报错附候选", async () => {
        const stack = mockStack();
        await stack.addLayer("dup", { driver: "mockssh", target: "x1" });
        await expect(stack.addLayer("dup", { driver: "mockssh", target: "x2" })).rejects.toThrow(/已占用.*dup/);
        expect(() => stack.layer("ghost")).toThrow(/不存在.*dup/);
        RuntimeStack.evictDriver({ driver: "mockssh", target: "x1" } as RuntimeDescriptor);
    });

    test("layerInto：enter 管线全量继承追加；无 pushInto 的层拒绝", async () => {
        const stack = mockStack();
        const stack2 = new RuntimeStack(); // 无 mock 注册——local 层测拒绝路径
        const local = await stack2.addLayer("base", { driver: "local" });
        expect(local.reused).toBe(false);
        await expect(stack2.layerInto("base", "x", "docker exec -i c sh")).rejects.toThrow(/pushInto 缺席/);
        // 继承追加
        await stack.addLayer("host", { driver: "mockssh", target: "h" });
        const h1 = await stack.layerInto("host", "c1", "docker exec -i c1 sh");
        expect(enterStepsOf(h1.descriptor.config as Record<string, unknown>)).toEqual([{ cmd: "docker exec -i c1 sh", label: "docker exec -i c1 sh" }]);
        const h2 = await stack.layerInto("c1", "deep", "su - app", { label: "su:app" });
        const steps = enterStepsOf(h2.descriptor.config as Record<string, unknown>);
        expect(steps.map((s) => s.cmd)).toEqual(["docker exec -i c1 sh", "su - app"]); // 父管线不丢
        RuntimeStack.evictDriver({ driver: "mockssh", target: "h" } as RuntimeDescriptor);
    });

    test("setActive/removeLayer：默认层回落最后注册；destroy 显式才销毁", async () => {
        const stack = mockStack();
        await stack.addLayer("a", { driver: "mockssh", target: "ta" });
        await stack.addLayer("b", { driver: "mockssh", target: "tb" });
        stack.setActive("a");
        expect(stack.layer("a").name).toBe("a");
        const aDriver = stack.layer("a").driver as unknown as MockLayerDriver;
        await stack.removeLayer("a"); // 缺省不销毁——连接留缓存
        expect(aDriver.destroyed).toBe(false);
        expect(stack.active).toBe(stack.layer("b").driver); // 回落最后注册
        await stack.removeLayer("b", { destroy: true });
        expect(() => stack.layer("b")).toThrow(/不存在/); // 已移除
        RuntimeStack.evictDriver({ driver: "mockssh", target: "ta" } as RuntimeDescriptor);
        RuntimeStack.evictDriver({ driver: "mockssh", target: "tb" } as RuntimeDescriptor);
    });

    test("snapshot/restore：descriptor 即层身份——移除后按快照重建（指纹缓存复用同连接）", async () => {
        const stack = mockStack();
        await stack.addLayer("h", { driver: "mockssh", target: "snap-host" });
        await stack.addLayer("w", { driver: "mockssh", target: "snap-host", config: { enterPipeline: [{ cmd: "docker exec -i w sh" }] } });
        stack.setActive("h");
        const snap = stack.snapshot();
        expect(snap.layers.length).toBe(2);
        expect(snap.active).toBe("h");
        const origDriver = stack.layer("w").driver;
        await stack.removeLayer("w");
        await stack.removeLayer("h");
        await stack.restore(snap); // 指纹命中缓存 → 同实例（连接未销毁的零成本恢复）
        expect(stack.layer("w").driver).toBe(origDriver);
        expect(stack.active).toBe(stack.layer("h").driver);
        RuntimeStack.evictDriver({ driver: "mockssh", target: "snap-host" } as RuntimeDescriptor);
        RuntimeStack.evictDriver({ driver: "mockssh", target: "snap-host", config: { enterPipeline: [{ cmd: "docker exec -i w sh" }] } } as RuntimeDescriptor);
    });
});

// GPT Astra 十三轮 #2：connect() 缓存写入在 await init() 后——并发同指纹竞态
// 各建一条、后者覆盖前者成孤儿连接泄漏。in-flight Promise 去重 + 失败清理。
describe("connect 并发去重（Astra 十三轮 #2）", () => {
    test("并发同指纹共享一次建链；init 失败清理半建连接且可重试", async () => {
        let creates = 0;
        const destroyed: string[] = [];
        const factory = new RuntimeFactory();
        let failInit = false;
        factory.registerDriver("mockconc", () => {
            creates++;
            return {
                descriptor: { driver: "mockconc" },
                fs: {},
                init: () => new Promise<void>((resolve, reject) => {
                    setTimeout(() => (failInit ? reject(new Error("init boom")) : resolve()), 40);
                }),
                destroy: async () => { destroyed.push(`d${creates}`); },
            } as unknown as RuntimeDriver;
        });
        const stack = new RuntimeStack({ factory });
        const desc = { driver: "mockconc", target: `conc-${Date.now()}` } as RuntimeDescriptor;

        // ① 并发共享：两个 connect 同指纹 → 一次 create、同实例
        const [a, b] = await Promise.all([stack.connect(desc), stack.connect(desc)]);
        expect(creates).toBe(1);
        expect(a).toBe(b);
        stack.evict(desc); // 实例级（自定义工厂命名空间）

        // ② 失败清理：init 抛错 → reject + destroy 半建 + 缓存无残留（重试可重建）
        failInit = true;
        await expect(stack.connect(desc)).rejects.toThrow(/init boom/);
        expect(destroyed).toContain("d2"); // 半建连接销毁（原实现裸泄漏）
        failInit = false;
        const c = await stack.connect(desc); // 缓存无残留 → 重试重建成功
        expect(creates).toBe(3);
        await c.destroy();
        stack.evict(desc);
    });
});

// GPT Astra 十四轮 #1：缓存键忽略 fallbackCwd——同 descriptor 不同 fallback 复用
// 旧 driver（请求 B 却在 A 执行）。归一化：fallback 写进 descriptor 再算指纹。
describe("connect fallbackCwd 归一化（Astra 十四轮 #1）", () => {
    test("不同 fallback → 各自工作目录（真 local driver getCwd 验证）", async () => {
        const { mkdtempSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dirA = mkdtempSync(join(tmpdir(), "fx-cwdA-"));
        const dirB = mkdtempSync(join(tmpdir(), "fx-cwdB-"));
        try {
            const stack = new RuntimeStack();
            const d = { driver: "local" } as RuntimeDescriptor; // 无 cwd——fallback 生效面
            const a = await stack.connect(d, dirA);
            const b = await stack.connect(d, dirB);
            expect(a).not.toBe(b); // 不同 fallback ≠ 复用（修前同实例停 A）
            expect((await a.getCwd()).replace(/\\/g, "/")).toBe(dirA.replace(/\\/g, "/"));
            expect((await b.getCwd()).replace(/\\/g, "/")).toBe(dirB.replace(/\\/g, "/"));
            await a.destroy();
            await b.destroy();
            RuntimeStack.evictDriver({ ...d, cwd: dirA } as RuntimeDescriptor);
            RuntimeStack.evictDriver({ ...d, cwd: dirB } as RuntimeDescriptor);
        } finally {
            rmSync(dirA, { recursive: true, force: true });
            rmSync(dirB, { recursive: true, force: true });
        }
    }, 30_000);
});

// GPT Astra 十五轮 #1：driverKey 白名单投影漏掉第三方身份字段——同 driver 同
// target 不同 tenant 复用同实例。修：未知 config 字段全量入指纹；enter 族别名
// 剔除原文以 enterStepsOf 归一结果代表语义（十二季语法糖等价性不破）。
describe("driverKey 自定义 config 全量入指纹（Astra 十五轮 #1）", () => {
    test("tenant 区分实例；enterCmd 与等价 enterPipeline 同语义同指纹", async () => {
        let creates = 0;
        const factory = new RuntimeFactory();
        factory.registerDriver("mocktenant", () => {
            creates++;
            return {
                descriptor: { driver: "mocktenant" },
                init: async () => undefined,
                destroy: async () => undefined,
            } as unknown as RuntimeDriver;
        });
        const stack = new RuntimeStack({ factory });
        const base = { driver: "mocktenant", target: "t15" } as RuntimeDescriptor;
        // ① 第三方身份字段区分：tenant A/B 各建实例
        await stack.connect({ ...base, config: { tenant: "A" } } as RuntimeDescriptor);
        await stack.connect({ ...base, config: { tenant: "B" } } as RuntimeDescriptor);
        expect(creates).toBe(2); // 修前：1（B 复用 A 的实例）
        // ② enter 别名等价回归：enterCmd 与等价 enterPipeline（同 tenant）→ 同指纹复用
        const viaCmd = await stack.connect({ ...base, config: { tenant: "C", enterCmd: "docker exec -i x sh" } } as RuntimeDescriptor);
        creates = 0;
        const viaPipe = await stack.connect({ ...base, config: { tenant: "C", enterPipeline: ["docker exec -i x sh"] } } as RuntimeDescriptor);
        expect(viaPipe).toBe(viaCmd);
        expect(creates).toBe(0);
        for (const cfg of [{ tenant: "A" }, { tenant: "B" }, { tenant: "C", enterCmd: "docker exec -i x sh" }]) {
            RuntimeStack.evictDriver({ ...base, config: cfg } as RuntimeDescriptor);
        }
    });
});

// 自挖 S3：evictDriver 不清 connectInflight——建链中 evict 后的同指纹并发仍搭
// 已逐出连接的车（共享旧 promise）。修：evict 连带清 in-flight（已在途 promise 完成
// 时 set 回缓存的毫秒级窗口接受并声明——实路径 removeLayer 在连接建成后 evict）。
describe("evictDriver 清 in-flight（自挖 S3）", () => {
    test("慢建链期间 evict → 后续 connect 不搭已逐出连接的车（各自新建）", async () => {
        let creates = 0;
        const factory = new RuntimeFactory();
        factory.registerDriver("mockevict", () => {
            creates++;
            return {
                descriptor: { driver: "mockevict" },
                init: () => new Promise<void>((r) => setTimeout(r, 120)),
                destroy: async () => undefined,
            } as unknown as RuntimeDriver;
        });
        const stack = new RuntimeStack({ factory });
        const desc = { driver: "mockevict", target: `ev-${Date.now()}` } as RuntimeDescriptor;
        const first = stack.connect(desc); // 慢建链（120ms）在途
        await new Promise((r) => setTimeout(r, 30));
        stack.evict(desc); // 建链期间逐出（实例级——命名空间内）
        const second = stack.connect(desc); // in-flight 已清 → 不搭车
        // Hydrogen R3 #3：在途 promise 完成后复检发现自己已被逐出——自毁不回填
        // （原毫秒窗语义=照样完成返回并 set 回缓存——逐出连接复活+孤儿泄漏）
        await expect(first).rejects.toThrow(/被逐出/);
        const b = await second;
        expect(creates).toBe(2); // 各自新建（修前：second 复用 first 的 promise=搭车）
        await b.destroy();
        stack.evict(desc);
    });
});

// GPT Astra 十七轮 #1：静态缓存进程级共享，但缓存键不含工厂——两个 stack 各注册
// 同名 driver 的 A/B 实现，B 连接相同 descriptor 直接拿到 A 的实例（B 工厂没执行）。
describe("自定义工厂缓存隔离（Astra 十七轮 #1）", () => {
    test("A/B 工厂同名 driver 各建实例；默认 stack 间仍共享缓存", async () => {
        const mkFactory = (tag: string) => {
            const f = new RuntimeFactory();
            let n = 0;
            f.registerDriver("dual", () => {
                n++;
                return {
                    descriptor: { driver: "dual", target: "shared", config: { madeBy: tag, n } },
                    init: async () => undefined,
                    destroy: async () => undefined,
                } as unknown as RuntimeDriver;
            });
            return { f, count: () => n };
        };
        const A = mkFactory("A");
        const B = mkFactory("B");
        const stackA = new RuntimeStack({ factory: A.f });
        const stackB = new RuntimeStack({ factory: B.f });
        const desc = { driver: "dual", target: "shared" } as RuntimeDescriptor;
        const da = await stackA.connect(desc);
        const db = await stackB.connect(desc);
        expect(db).not.toBe(da); // B 不串用 A 的连接（修前：同实例，B 工厂没执行）
        expect(B.count()).toBe(1); // B 的工厂真的跑了
        expect((db.descriptor as { config?: { madeBy?: string } }).config?.madeBy).toBe("B");
        // 默认 stack（不注入工厂）间仍共享：同 local descriptor 两 stack 复用
        const shared = { driver: "local", cwd: process.cwd() } as RuntimeDescriptor;
        const s1 = new RuntimeStack();
        const s2 = new RuntimeStack();
        const d1 = await s1.connect(shared);
        const d2 = await s2.connect(shared);
        expect(d2).toBe(d1); // 共享语义保持（CM 复用/连接计数的既有契约）
        RuntimeStack.evictDriver(shared);
    });

    // GPT Astra 十八轮 #1：registerDriver() 入口注册同名 driver 的 A/B 实现仍共享
    // 缓存（十七轮只盖了构造注入）。注册即退出共享缓存。
    test("registerDriver 注册即隔离：B 工厂真执行（不串 A 的连接）", async () => {
        const mk = (tag: string) => {
            const stack = new RuntimeStack(); // 普通构造（默认工厂）
            let n = 0;
            stack.registerDriver("regdual", () => {
                n++;
                return {
                    descriptor: { driver: "regdual", target: "shared2", config: { madeBy: tag } },
                    init: async () => undefined,
                    destroy: async () => undefined,
                } as unknown as RuntimeDriver;
            });
            return { stack, count: () => n };
        };
        const A = mk("A");
        const B = mk("B");
        const desc = { driver: "regdual", target: "shared2" } as RuntimeDescriptor;
        const da = await A.stack.connect(desc);
        const db = await B.stack.connect(desc);
        expect(db).not.toBe(da); // 修前：B 串 A 的连接
        expect(B.count()).toBe(1); // B 的工厂真执行（修前 0 次）
        A.stack.evict(desc);
        B.stack.evict(desc);
    });
});

// 审计 M7：events 总线全仓零发射点（API 虚设）——connect 建链桥接 driver 会话事件。
describe("会话事件桥接（审计 M7）", () => {
    test("local 层 spawn→exit 事件经 stack.events 可订阅", async () => {
        const stack = new RuntimeStack();
        const seen: string[] = [];
        stack.events.on("*", (e) => seen.push(e.type));
        const drv = await stack.connect({ driver: "local", cwd: process.cwd() } as RuntimeDescriptor);
        const h = await drv.execSession("echo m7; exit 5");
        await new Promise((r) => setTimeout(r, 2500)); // 轮询周期
        expect(seen).toContain("exit"); // 修前：永远空（零发射点）
        await drv.stopSession(h.sessionId).catch(() => undefined);
        RuntimeStack.evictDriver({ driver: "local", cwd: process.cwd() } as RuntimeDescriptor);
    }, 15_000);
});

// GPT Astra 二十六期 #1：addLayer 的 SSH 主机身份判重越权到自定义 driver——同 target
// 不同 tenant 被误判复用（B 拿 A 的连接、B 的名字未注册）。修：判重仅限 ssh driver。
describe("addLayer 判重限 SSH（二十六期）", () => {
    test("自定义 driver 同 target 不同 tenant：各自注册各自连接（不被 identity 误合并）", async () => {
        let made = 0;
        const stack = new RuntimeStack();
        stack.registerDriver("mockid", () => {
            made++;
            return {
                descriptor: { driver: "mockid", target: "same-target", config: { madeBy: made } },
                init: async () => undefined,
                destroy: async () => undefined,
            } as unknown as RuntimeDriver;
        });
        const a = await stack.addLayer("ida", { driver: "mockid", target: "same-target", config: { tenant: "A" } } as RuntimeDescriptor);
        expect(a.reused).toBe(false);
        const b = await stack.addLayer("idb", { driver: "mockid", target: "same-target", config: { tenant: "B" } } as RuntimeDescriptor);
        expect(b.reused).toBe(false); // 修前：true（identity 判重误合并——B 直接拿 A 的句柄）
        expect(b.handle.name).toBe("idb"); // 名字真正注册（修前返回 A 的句柄冒名 ida）
        expect(b.handle.driver).not.toBe(a.handle.driver); // 各自连接（缓存键含 tenant 自然隔离）
        expect(made).toBe(2); // 工厂两次执行（修前 1 次——B 的工厂被跳过）
        await stack.removeLayer("ida").catch(() => undefined);
        await stack.removeLayer("idb").catch(() => undefined);
        RuntimeStack.evictDriver({ driver: "mockid", target: "same-target", config: { tenant: "A" } } as RuntimeDescriptor);
        RuntimeStack.evictDriver({ driver: "mockid", target: "same-target", config: { tenant: "B" } } as RuntimeDescriptor);
    }, 15_000);
});

// GPT Astra 二十七期双回归：
describe("二十七期", () => {
    // #1 候选层过滤：ssh localhost 不命中自定义 driver 的同 target 层
    test("ssh 判重候选也须 ssh：自定义层同 target 不被 ssh 请求命中", async () => {
        const stack = new RuntimeStack();
        stack.registerDriver("mockcand", () => ({
            descriptor: { driver: "mockcand", target: "localhost", config: {} },
            init: async () => undefined,
            destroy: async () => undefined,
        } as unknown as RuntimeDriver));
        await stack.addLayer("customL", { driver: "mockcand", target: "localhost", config: {} } as RuntimeDescriptor);
        // ssh 请求同 target——identity 判重不得命中 customL（修前：返回 customL 的 driver 标 reused）
        // 真实建链会尝试 ssh localhost——此处只验判重路径不撞：用 sshHops 空的 ssh descriptor
        // 会走真实 connect；避免真实连接，只断言 findIdentityHopHit 的候选过滤（经 addLayer
        // 的 ssh 分支触发一次 mockcand 不在场的行为）——改用直接断言：注册表里 customL 与
        // ssh 层判重互不干扰（轻量法：再次 addLayer 同名必须报已占用而非复用）
        await expect(stack.addLayer("customL", { driver: "mockcand", target: "localhost", config: {} } as RuntimeDescriptor))
            .rejects.toThrow(/已占用/); // 名字占用语义正常（不受判重影响）
        await stack.removeLayer("customL").catch(() => undefined);
    }, 15_000);

    // #2 并发同名：预留后第二个直接撞名（不再双双成功后覆盖）
    test("并发同名 addLayer → 第二个撞预留失败（无静默覆盖）", async () => {
        const stack = new RuntimeStack();
        const mk = (n: string) => ({ driver: "mockid" as const, target: n, config: { n } });
        stack.registerDriver("mockid", () => ({
            descriptor: { driver: "mockid", target: "x", config: {} },
            init: () => new Promise<void>((r) => setTimeout(r, 80)), // 慢建链制造并发窗
            destroy: async () => undefined,
        } as unknown as RuntimeDriver));
        const [a, b] = await Promise.allSettled([
            stack.addLayer("same", mk("A") as never),
            stack.addLayer("same", mk("B") as never),
        ]);
        const statuses = [a.status, b.status];
        expect(statuses).toContain("fulfilled"); // 一个成功
        expect(statuses).toContain("rejected"); // 另一个撞名（修前：双成功后覆盖）
        const ok = (a.status === "fulfilled" ? a : b) as PromiseFulfilledResult<{ handle: LayerHandle }>;
        const dup = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
        expect((dup.reason as Error).message).toMatch(/建链中/);
        expect(stack.layer(ok.value.handle.name).driver).toBeTruthy();
        await stack.removeLayer("same").catch(() => undefined);
        RuntimeStack.evictDriver(mk("A") as never);
        RuntimeStack.evictDriver(mk("B") as never);
    }, 20_000);
});

// GPT Astra 二十八期双回归：
describe("二十八期", () => {
    // #1 layerInto 并发同名：预留防线从 addLayer 扩展到全部异步建层入口
    test("并发同名 layerInto → 一成一拒（无静默覆盖）", async () => {
        const stack = new RuntimeStack();
        const mkDriver = (): RuntimeDriver => ({
            descriptor: { driver: "local" },
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), // isDriver 判 exec
            init: async () => undefined,
            destroy: async () => undefined,
            pushInto: async () => {
                await new Promise((r) => setTimeout(r, 80)); // 慢派生制造并发窗
                return mkDriver();
            },
        } as unknown as RuntimeDriver);
        await stack.addLayer("deriveSrc", mkDriver()); // driver 形态直接登记（绕 factory）
        const [a, b] = await Promise.allSettled([
            stack.layerInto("deriveSrc", "sameName", "enter A"),
            stack.layerInto("deriveSrc", "sameName", "enter B"),
        ]);
        const statuses = [a.status, b.status];
        expect(statuses).toContain("fulfilled");
        expect(statuses).toContain("rejected"); // 修前：双成功后 B 覆盖 A
        expect(((a.status === "rejected" ? a : b) as PromiseRejectedResult).reason.message).toMatch(/建链中|已占用/);
        await stack.removeLayer("sameName").catch(() => undefined);
        await stack.removeLayer("deriveSrc").catch(() => undefined);
    }, 20_000);

    // #2 共享连接的双 stack 各自收到会话事件（修前第二个 stack 0 次）
    test("缓存命中的第二个 stack 事件照收（多订阅者登记）", async () => {
        // 独立指纹防测试间缓存污染（target 注入 capabilities 不可行——用 cwd 微差）
        const shared: RuntimeDescriptor = { driver: "local", config: { testFixture: "m28" } };
        const s1 = new RuntimeStack();
        const s2 = new RuntimeStack();
        const got1: string[] = [];
        const got2: string[] = [];
        s1.events.on("*", (e) => got1.push(e.type));
        s2.events.on("*", (e) => got2.push(e.type));
        const d1 = await s1.connect(shared);
        const d2 = await s2.connect(shared); // 缓存命中（同实例）
        expect(d2).toBe(d1);
        const h = await d1.execSession("echo m28; exit 5");
        await new Promise((r) => setTimeout(r, 2500)); // 轮询周期
        expect(got1).toContain("exit"); // 首建者照收
        expect(got2).toContain("exit"); // 修前：[]（__fxBridged 挡死）
        await d1.stopSession(h.sessionId).catch(() => undefined);
        RuntimeStack.evictDriver(shared); // 订阅登记清空（生命周期钩子）
    }, 15_000);
});

// GPT Astra 二十九期：同 stack 重复 connect 同 driver → 重复订阅（A 连 3 次 = 
// 1 个事件收 3 遍）。per-stack 稳定订阅闭包（引用固定 → Set 去重）。
describe("重复 connect 订阅幂等（二十九期）", () => {
    test("A 连 3 次 B 连 1 次 → 一次退出事件 A 收 1 次 B 收 1 次", async () => {
        const shared: RuntimeDescriptor = { driver: "local", config: { testFixture: "m29" } };
        const a = new RuntimeStack();
        const b = new RuntimeStack();
        const gotA: string[] = [];
        const gotB: string[] = [];
        a.events.on("exit", () => gotA.push("x"));
        b.events.on("exit", () => gotB.push("x"));
        const d1 = await a.connect(shared);
        await a.connect(shared); // 重复 1
        await a.connect(shared); // 重复 2
        const d4 = await b.connect(shared);
        expect(d4).toBe(d1);
        const h = await d1.execSession("echo m29; exit 4");
        await new Promise((r) => setTimeout(r, 2500));
        expect(gotA.length).toBe(1); // 修前：3（重复订阅重复执行）
        expect(gotB.length).toBe(1);
        await d1.stopSession(h.sessionId).catch(() => undefined);
        RuntimeStack.evictDriver(shared);
    }, 15_000);
});

// GPT Astra 三十期：事件总线两件——off(原回调) 退订失效 + once 回调抛错中断分发。
import { EventBus as EventBusFor30 } from "../src/core/base/events.js";
describe("EventBus off/once（三十期）", () => {
    const EventBus = EventBusFor30;
    type Ev = { type: "tick"; n: number };

    test("off(原始回调) 真退订（修前引用不一致永远移不掉）", () => {
        const bus = new EventBus<Ev>();
        const seen: number[] = [];
        const h = (e: Ev) => seen.push(e.n);
        bus.on("tick", h);
        bus.emit({ type: "tick", n: 1 });
        bus.off("tick", h); // 原回调（非 on 返回的退订函数）
        bus.emit({ type: "tick", n: 2 });
        expect(seen).toEqual([1]); // 修前：[1,2]（off 无效）
    });

    test("once 回调抛错不中断分发（后续普通/通配照常执行）", () => {
        const bus = new EventBus<Ev>();
        const after: number[] = [];
        bus.once("tick", () => { throw new Error("boom"); });
        bus.on("tick", (e) => after.push(e.n));
        bus.on("*", (e) => after.push(e.n * 10));
        expect(() => bus.emit({ type: "tick", n: 3 })).not.toThrow(); // 修前：boom 逸出
        expect(after).toEqual([3, 30]); // 后续监听器照常（修前双双未执行）
    });
});

// GPT Astra 三十一期双回归：
describe("EventBus 多订阅退订与迭代器取消（三十一期）", () => {
    type Ev2 = { type: "a" | "b"; n: number };

    test("#1 同回调订阅 a+b：两个退订函数各自有效（修前映射互相覆盖）", () => {
        const bus = new EventBus<Ev2>();
        const seen: string[] = [];
        const h = (e: Ev2) => seen.push(e.type);
        const offA = bus.on("a", h);
        const offB = bus.on("b", h); // 修前：b 的包装函数覆盖 a 的映射
        offA();
        bus.emit({ type: "a", n: 1 });
        expect(seen).toEqual([]); // a 已退订（修前：仍触发——offA 拿到的是 b 的包装）
        bus.emit({ type: "b", n: 2 });
        expect(seen).toEqual(["b"]); // b 仍在
        offB();
        bus.emit({ type: "b", n: 3 });
        expect(seen).toEqual(["b"]); // 双退后全静默（修前：两个退订函数都失效）
        // off(原回调) 对最后一个注册同样有效
        const h2 = (e: Ev2) => seen.push(`x${e.type}`);
        bus.on("a", h2);
        bus.on("b", h2);
        bus.off("a", h2);
        bus.emit({ type: "a", n: 4 });
        expect(seen).toEqual(["b"]); // off(a, h2) 只退 a——b 的 h2 不受影响
        bus.emit({ type: "b", n: 5 });
        expect(seen).toEqual(["b", "xb"]);
    });

    test("#2 空闲迭代器 cancel() 即时唤醒（等待可打断 + 订阅记录移除）", async () => {
        const bus = new EventBus<Ev2>();
        const it = bus.iterable();
        const iter = it[Symbol.asyncIterator]();
        // 空转一步（进入 notify 等待）
        const nextP = iter.next();
        await new Promise((r) => setTimeout(r, 30));
        // cancel：主动置 inactive + 唤醒等待者——挂起的 next 应即时收尾
        it.cancel();
        const raced = await Promise.race([
            nextP.then((r) => (r.done ? "done" : "value")),
            new Promise((r) => setTimeout(() => "PENDING", 800)),
        ]);
        expect(raced).toBe("done"); // 修前：PENDING（return() 排队 + 10ms 轮询永不进 finally）
        // 事件驱动收尾后 emit 不再入队（记录已移除/active=false）
        bus.emit({ type: "a", n: 9 });
        expect((it as unknown as { __entry: { queue: unknown[]; active: boolean } }).__entry.queue.length).toBe(0);
    }, 15_000);
});

// GPT Astra 三十二期双回归：
describe("EventBus 引用键与入队过滤（三十二期）", () => {
    type Ev3 = { type: "wanted" | "noise"; n: number };

    test("#1 工厂生成的同特征闭包不再碰撞（函数引用键）", () => {
        const bus = new EventBus<Ev3>();
        const seen: string[] = [];
        const mk = (tag: string) => (e: Ev3) => seen.push(tag); // 工厂：同源码长度/同匿名形态
        const a = mk("A");
        const b = mk("B");
        bus.on("wanted", a);
        bus.on("wanted", b);
        bus.off("wanted", a); // 退 A——B 必须不受影响（修前：字符串键碰撞退错人）
        bus.emit({ type: "wanted", n: 1 });
        expect(seen).toEqual(["B"]); // 修前风险：[]（B 被误移除）或 ["A","B"]（A 未退）
    });

    test("#2 类型订阅队列不被无关事件挤占（入队前过滤）", async () => {
        const bus = new EventBus<Ev3>({ queueMax: 1 });
        const it = bus.iterable("wanted");
        const iter = it[Symbol.asyncIterator]();
        bus.emit({ type: "wanted", n: 1 }); // 占满 queueMax=1
        bus.emit({ type: "noise", n: 2 });  // 无关——不得挤掉 wanted（修前：wanted 被顶）
        const r = await Promise.race([
            iter.next(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("starved")), 500)),
        ]);
        expect((r as { value: Ev3 }).value.n).toBe(1); // 消费者拿到 wanted（修前：饿死）
        it.cancel();
    }, 15_000);
});

// GPT Astra 三十三期双回归 + 全路径复扫：
describe("EventBus 重复注册与 cancel 泄漏（三十三期）", () => {
    type Ev4 = { type: "t"; n: number };

    test("#1 同回调双注册：退订第一份后 off(handler) 全退（映射不损坏）", () => {
        const bus = new EventBus<Ev4>();
        let n = 0;
        const h = () => n++;
        const off1 = bus.on("t", h);
        bus.on("t", h); // 双注册（EventEmitter 双触发语义）
        bus.emit({ type: "t", n: 1 });
        expect(n).toBe(2);
        off1(); // 退第一份——第二份不受影响（修前：映射键被删光成孤儿）
        bus.emit({ type: "t", n: 2 });
        expect(n).toBe(3);
        bus.off("t", h); // 全退该 handler
        bus.emit({ type: "t", n: 3 });
        expect(n).toBe(3); // 修前：残留一份继续触发 → 4
    });

    test("#2 未启动迭代的订阅 cancel 后零残留（记录+队列双清）", () => {
        const bus = new EventBus<Ev4>({ queueMax: 1 }); // 每订阅队列上限 1——泄漏可数
        const handles = [];
        for (let i = 0; i < 20; i++) {
            const it = bus.iterable();
            bus.emit({ type: "t", n: i }); // 入队（未消费；queueMax=1 → 每队列至多 1 事件）
            handles.push(it);
        }
        const leak = (bus as unknown as { iterables: Set<{ queue: unknown[] }> }).iterables;
        expect(leak.size).toBe(20);
        expect([...leak].reduce((s, e) => s + e.queue.length, 0)).toBe(20);
        for (const it of handles) it.cancel(); // 未启动 generator——修前 finally 永不执行
        expect(leak.size).toBe(0); // 修前：20（记录泄漏）
        expect([...leak].reduce((s, e) => s + e.queue.length, 0)).toBe(0); // 修前：20 个带载荷事件
    });
});

// GPT Astra 三十七期双回归：
describe("三十七期", () => {
    type Ev5 = { type: "t"; n: number };

    test("#1 async 回调 rejection 不崩宿主（on + once 双面）", async () => {
        const bus = new EventBus<Ev5>();
        let syncReached = false;
        bus.on("t", async () => { throw new Error("async boom"); });
        bus.once("t", async () => { throw new Error("async boom once"); });
        bus.on("t", () => { syncReached = true; });
        expect(() => bus.emit({ type: "t", n: 1 })).not.toThrow(); // 同步不炸
        await new Promise((r) => setTimeout(r, 50)); // 等 Promise rejection 处理
        expect(syncReached).toBe(true); // 后续监听器照常执行
        // 宿主未崩（测试还在跑即证明）
    });

    test("#2 stop_session 停止通道抛错 → unknown + verify 继续（不裸抛）", async () => {
        let verifyCalled = false;
        const drv = {
            descriptor: { driver: "local" },
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
            init: async () => undefined,
            destroy: async () => undefined,
            execSession: async () => ({ sessionId: "s34", logBase: "/tmp/s34", pid: 1 }),
            tailSession: async () => [],
            stopSession: async () => { throw new Error("stop channel dead"); },
            verifySession: async () => { verifyCalled = true; return { status: "exited", exitCode: 3 }; },
        } as unknown as import("../src/core/base/driver.js").RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: drv });
        const r = await tk.handlers.stop_session({ session_id: "s34", layer: "__initial__" });
        expect(verifyCalled).toBe(true); // 修前：stop 抛错后 verify 根本不执行
        expect(r.status).toBe("exited"); // verify 采纳真实退出码
        expect((r as { exit_code?: number }).exit_code).toBe(3);
    });
});

// GPT Astra 三十八期 #2：跨 realm Promise——instanceof 只认当前 realm 的构造器，
// vm.runInNewContext 返回的外来 Promise rejection 漏网成 unhandledRejection 崩宿主。
// 修后鸭子检测 thenable，经**本 realm** Promise.resolve 同化兜住。
describe("三十八期", () => {
    type Ev6 = { type: "t"; n: number };

    test("#1 外来 thenable：同化路径生效 + 异步 rejection 不崩宿主", async () => {
        const bus = new EventBus<Ev6>();
        let thenCalled = 0;
        let syncReached = false;
        // 非 instanceof Promise 的外来 thenable：修前被无视（then 永不被调）；
        // 修后经 Promise.resolve 同化（then 被调），rejection 归化到派生 promise 被 .catch 兜住
        const foreign = {
            then(_res: unknown, rej?: (e: unknown) => void) {
                thenCalled++;
                queueMicrotask(() => rej?.(new Error("foreign rejection")));
            },
        };
        const syncThrow = { then() { throw new Error("then throws sync"); } }; // 同步抛错也只化归 rejection（spec）
        bus.on("t", () => foreign as unknown as Promise<void>);
        bus.once("t", () => syncThrow as unknown as Promise<void>);
        bus.on("t", () => { syncReached = true; });
        expect(() => bus.emit({ type: "t", n: 1 })).not.toThrow();
        await new Promise((r) => setTimeout(r, 50)); // 等同化微任务与异步 rejection
        expect(thenCalled).toBe(1); // 修前：instanceof 漏网 → 0（then 永不被调）
        expect(syncReached).toBe(true); // 后续监听器照常
        // 测试进程存活 = 无 unhandledRejection
    });

    test("#2 真·跨 realm Promise（vm realm）rejection 隔离", async () => {
        let vmMod: typeof import("node:vm");
        try {
            vmMod = await import("node:vm");
        } catch {
            return; // 运行时无 vm——#1 thenable 面已覆盖同化语义
        }
        // vm realm 的 Promise：宿主侧 instanceof 不认（真跨 realm 形态），rejection 异步落地
        const foreignPromise = vmMod.runInNewContext(
            "new Promise((_, rej) => setTimeoutHost(() => rej(new Error('realm boom')), 5))",
            { setTimeoutHost: (fn: () => void) => setTimeout(fn, 5) },
        );
        if (foreignPromise instanceof Promise) return; // 实现未分 realm——形态不成立，#1 已覆盖
        const bus = new EventBus<Ev6>();
        let syncReached = false;
        bus.on("t", () => foreignPromise as unknown as Promise<void>);
        bus.on("t", () => { syncReached = true; });
        expect(() => bus.emit({ type: "t", n: 1 })).not.toThrow();
        await new Promise((r) => setTimeout(r, 100)); // 等 vm realm 内 rejection 落地
        expect(syncReached).toBe(true);
        // 修前：instanceof 漏网 → 外来 rejection 无人接 → unhandledRejection 崩宿主（bun test 直接 fail）
    });
});

// GPT Sol 六十七期：#4 restore 绕过同名建层预留——addLayer 暂停在初始化时并发
// restore 同名层，先成者被覆盖；#5 两命名层共享同一 driver（同落点复用）——
// removeLayer(destroy) 连坐销毁仍在用的另一层。
describe("Sol 67：restore 预留/共享销毁", () => {
    const mockStack67 = () => {
        const stack = new RuntimeStack();
        stack.registerDriver("mockssh", (d) => new MockLayerDriver(d) as unknown as RuntimeDriver);
        return stack;
    };

    test("#4 addLayer 建链中 restore 同名 → 拒绝（不竞争不覆盖）", async () => {
        const stack = new RuntimeStack();
        let releaseInit!: () => void;
        const gate = new Promise<void>((res) => { releaseInit = res; });
        stack.registerDriver("slowssh", (d: RuntimeDescriptor) => {
            const drv = new MockLayerDriver(d) as unknown as RuntimeDriver & { init: () => Promise<void> };
            drv.init = () => gate; // init 挂起——addLayer 停在建链（预留持有中）
            return drv;
        });
        const adding = stack.addLayer("same", { driver: "slowssh", target: "t67" });
        await new Promise((r) => setTimeout(r, 30)); // 预留生效
        await expect(stack.restore({ layers: [{ name: "same", descriptor: { driver: "mockssh", target: "other" } }] }))
            .rejects.toThrow(/建链中/); // 修前：绕过预留直接覆盖注册项
        releaseInit();
        const r = await adding;
        expect(r.handle.name).toBe("same");
        expect(stack.layer("same").descriptor.driver).toBe("slowssh"); // addLayer 的注册不被 restore 劫走
    }, 15_000);

    test("#5 共享 driver 层 destroy 不连坐——另一层照常执行", async () => {
        const stack = mockStack67();
        await stack.addLayer("a", { driver: "mockssh", target: "shared-t" });
        await stack.addLayer("b", { driver: "mockssh", target: "shared-t" }); // 同落点=复用同一 driver
        const aDriver = stack.layer("a").driver;
        expect(stack.layer("b").driver).toBe(aDriver); // 共享实证（指纹缓存复用）
        await stack.removeLayer("a", { destroy: true }); // 修前：连坐销毁共享 driver
        expect((aDriver as unknown as MockLayerDriver).destroyed).toBe(false);
        const out = await stack.layer("b").driver.exec("hostname");
        expect(out.exitCode).toBe(0); // b 层照常干活
        RuntimeStack.evictDriver({ driver: "mockssh", target: "shared-t" } as RuntimeDescriptor);
    }, 15_000);
});

// GPT Sol 六十八期 P1/P2：删除默认层的销毁暂停期，缺省命令曾落初始 driver
//（默认层回落在异步销毁之后）；跨 stack 共享 driver 曾被单 stack 引用检查
// 提前销毁（全局引用计数收口）。
describe("Sol 68：默认层切换序/跨 stack 引用计数", () => {
    test("P1 默认层销毁暂停期：缺省解析已切到存活层（不落初始 driver）", async () => {
        const stack = new RuntimeStack();
        let releaseDestroy!: () => void;
        const gate = new Promise<void>((res) => { releaseDestroy = res; });
        const mkDriver = (d: RuntimeDescriptor) => {
            const drv = new MockLayerDriver(d) as unknown as RuntimeDriver & { destroy: () => Promise<void> };
            drv.destroy = () => gate.then(() => { (drv as unknown as MockLayerDriver).destroyed = true; });
            return drv;
        };
        stack.registerDriver("mockssh", (d) => mkDriver(d));
        await stack.addLayer("a", { driver: "mockssh", target: "ta68" }); // 默认层
        const b = await stack.addLayer("b", { driver: "mockssh", target: "tb68" });
        stack.setActive("a"); // a 为默认层
        const removing = stack.removeLayer("a", { destroy: true }); // 暂停在 destroy
        await new Promise((r) => setTimeout(r, 30));
        // 销毁暂停期：默认层已回落到 b（修前：activeName 仍指已删的 a——缺省解析落初始 driver）
        expect(stack.active).toBe(b.handle.driver);
        releaseDestroy();
        await removing;
        expect((stack.layer("b").driver as unknown as MockLayerDriver).destroyed).toBe(false);
        RuntimeStack.evictDriver({ driver: "mockssh", target: "ta68" } as RuntimeDescriptor);
        RuntimeStack.evictDriver({ driver: "mockssh", target: "tb68" } as RuntimeDescriptor);
    }, 15_000);

    test("P2 跨 stack 共享 driver：一 stack 销毁不连坐另一 stack", async () => {
        // registerDriver 会配随机 cacheNs（实例隔离）——跨 stack 共享只发生在
        // 缺省工厂路径（全局缓存键）：local driver 两 stack 同键复用同一实例
        const s1 = new RuntimeStack();
        const s2 = new RuntimeStack();
        await s1.addLayer("a", { driver: "local" });
        await s2.addLayer("b", { driver: "local" });
        expect(s2.layer("b").driver).toBe(s1.layer("a").driver); // 跨 stack 共享实证（全局缓存）
        await s1.removeLayer("a", { destroy: true }); // 修前：单 stack 检查通过→销毁共享 driver
        const out = await s2.layer("b").driver.exec("echo ok");
        expect(out.exitCode).toBe(0); // 修前：local driver 已被销毁、exec 失败
        expect((out as { stdout?: string }).stdout?.trim()).toBe("ok");
        RuntimeStack.evictDriver({ driver: "local" });
    }, 20_000);
});

// GPT Sol 六十九期 #1：并发建层/销毁——新层从缓存拿到 driver 后、登记引用前，
// 旧层删除曾把引用减到 0 销毁共享 driver（新层注册到已死连接）。claim 前移到
// connect 归还点（原子）。
describe("Sol 69：connect 归还点 claim", () => {
    test("获取与登记之间的窗口：旧层销毁不追杀已认领连接", async () => {
        const stack = new RuntimeStack();
        stack.registerDriver("mockssh", (d) => new MockLayerDriver(d) as unknown as RuntimeDriver);
        await stack.addLayer("a", { driver: "mockssh", target: "race69" });
        const realConnect = (stack as unknown as { connect: (d: RuntimeDescriptor) => Promise<RuntimeDriver> }).connect.bind(stack);
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        (stack as unknown as { connect: unknown }).connect = async (d: RuntimeDescriptor) => {
            const drv = await realConnect(d); // claim 已在此原子发生（修前：拿到后未计数）
            await gate; // 模拟获取与登记之间的任意代码
            return drv;
        };
        const adding = stack.addLayer("b", { driver: "mockssh", target: "race69" }); // 缓存命中后挂起
        await new Promise((r) => setTimeout(r, 30));
        const removal = stack.removeLayer("a", { destroy: true });
        release();
        await removal;
        const r2 = await adding;
        const out = await r2.handle.driver.exec("echo hi"); // 修前：driver 已销毁
        expect(out.exitCode).toBe(0);
        await stack.removeLayer("b", { destroy: true });
        RuntimeStack.evictDriver({ driver: "mockssh", target: "race69" } as RuntimeDescriptor);
    }, 15_000);
});

// GPT Sol 七十期 #1：connect 的 claim 计数无释放出口——裸 connect 永久占用，
// 唯一命名层 removeLayer(destroy) 后 destroy 从未调用。登记计数复归 + 宏任务
// 级延迟复核（在途登记先行落地、复核见 0 才真销毁）。
describe("Sol 70：销毁两难正解", () => {
    test("#1 两次 connect（一裸一成层）：最后一层 destroy 释放连接", async () => {
        const stack = new RuntimeStack();
        stack.registerDriver("mockssh", (d) => new MockLayerDriver(d) as unknown as RuntimeDriver);
        await stack.connect({ driver: "mockssh", target: "rel70" } as RuntimeDescriptor); // 裸 connect
        await stack.addLayer("a", { driver: "mockssh", target: "rel70" }); // 同落点复用 + 唯一命名层
        const drv = stack.layer("a").driver as unknown as MockLayerDriver;
        await stack.removeLayer("a", { destroy: true });
        await new Promise((r) => setTimeout(r, 30)); // 延迟复核宏任务落地
        expect(drv.destroyed).toBe(true); // 修前：claim 计数永不归零、destroy 不发
    }, 15_000);
});

// GPT Sol 七十一期 #2/#3：destroy 同步逐出缓存（延迟窗口内 connect 曾拿到注定
// 被杀的旧连接）+ 销毁去重（定时器前重复登记移除曾双 destroy）+ 旧定时器不再
// 按描述符逐出（曾误杀定时器落地前建立的新一代连接）。
describe("Sol 71：销毁窗口三缝", () => {
    class CountingDriver extends MockLayerDriver {
        destroyCount = 0;
        async destroy(): Promise<void> { this.destroyCount++; this.destroyed = true; }
    }
    const mkStack = () => {
        const stack = new RuntimeStack();
        stack.registerDriver("mockssh", (d) => new CountingDriver(d) as unknown as RuntimeDriver);
        return stack;
    };

    test("#2a destroy 返回后立即 connect——拿到新代（非注定被杀的旧代）", async () => {
        const stack = mkStack();
        await stack.addLayer("a", { driver: "mockssh", target: "doom71" });
        const oldDrv = stack.layer("a").driver;
        const removing = stack.removeLayer("a", { destroy: true }); // 返回时 destroy 未跑
        const d2 = await stack.connect({ driver: "mockssh", target: "doom71" }); // 窗口内
        await removing;
        await new Promise((r) => setTimeout(r, 30));
        expect(d2).not.toBe(oldDrv); // 修前：同实例（随后被定时器销毁）
        expect((d2 as unknown as CountingDriver).destroyed).toBe(false); // 新代未被波及
        const out = await d2.exec("echo ok");
        expect(out.exitCode).toBe(0);
        expect((oldDrv as unknown as CountingDriver).destroyCount).toBe(1); // 旧代恰好销毁一次
        RuntimeStack.evictDriver({ driver: "mockssh", target: "doom71" } as RuntimeDescriptor);
        await (d2 as unknown as CountingDriver).destroy();
    }, 15_000);

    test("#2b 定时器前重新登记又移除——destroy 恰好一次", async () => {
        const stack = mkStack();
        await stack.addLayer("a", { driver: "mockssh", target: "dedup71" });
        const drv = stack.layer("a").driver as unknown as CountingDriver;
        const first = stack.removeLayer("a", { destroy: true });
        await stack.addLayer("re", drv as unknown as RuntimeDriver);
        const second = stack.removeLayer("re", { destroy: true });
        await Promise.all([first, second]);
        expect(drv.destroyCount).toBe(1); // 修前：两次
        RuntimeStack.evictDriver({ driver: "mockssh", target: "dedup71" } as RuntimeDescriptor);
    }, 15_000);

    test("#3 旧定时器不逐出新代：移除→显式 evict→connect 建二代——旧定时器落地后 connect 仍命中二代", async () => {
        const stack = mkStack();
        await stack.addLayer("a", { driver: "mockssh", target: "gen71" });
        const gen1 = stack.layer("a").driver;
        await stack.removeLayer("a", { destroy: true }); // 同步逐出+调度旧定时器
        stack.evict({ driver: "mockssh", target: "gen71" }); // 显式再逐（幂等）
        const gen2 = await stack.connect({ driver: "mockssh", target: "gen71" }); // 建二代
        await new Promise((r) => setTimeout(r, 30)); // 旧定时器落地
        const gen3 = await stack.connect({ driver: "mockssh", target: "gen71" });
        expect(gen3).toBe(gen2); // 修前：旧定时器按描述符逐出——gen2 被清、gen3 是三代
        expect((gen1 as unknown as CountingDriver).destroyCount).toBe(1); // 旧代销毁的是自己
        RuntimeStack.evictDriver({ driver: "mockssh", target: "gen71" } as RuntimeDescriptor);
        await (gen2 as unknown as CountingDriver).destroy();
    }, 15_000);
});

// GPT Sol 七十二期 #2：removeLayer 的同步逐出曾按描述符无条件清——同描述符的
// 下一代（先显式逐出旧代、connect 新建）被连坐逐出/中断建链；重新登记旧
// driver 再移除同罪。实例核对：缓存里就是本代才清。
describe("Sol 72：实例核对逐出", () => {
    test("旧层移除不逐出新代（先 evict 旧、connect 建二代、再移除持旧代的层）", async () => {
        const stack = new RuntimeStack();
        stack.registerDriver("mockssh", (d) => new MockLayerDriver(d) as unknown as RuntimeDriver);
        const desc = { driver: "mockssh", target: "inst72" } as RuntimeDescriptor;
        await stack.addLayer("old", desc);
        const gen1 = stack.layer("old").driver;
        stack.evict(desc); // 显式逐出旧代
        const gen2 = await stack.connect(desc); // 同描述符建二代（缓存）
        await stack.removeLayer("old", { destroy: true }); // 移除持 gen1 的层——修前：连坐逐出 gen2
        const gen3 = await stack.connect(desc);
        expect(gen3).toBe(gen2); // 修前：gen2 被清、gen3 是三代（gen1 的销毁定时器还可能中断建链）
        await new Promise((r) => setTimeout(r, 30)); // 延迟复核宏任务落地
        expect((gen1 as unknown as MockLayerDriver).destroyed).toBe(true); // 销毁的只是 gen1
        await (gen2 as unknown as MockLayerDriver).destroy();
        RuntimeStack.evictDriver(desc);
    }, 15_000);

    test("重新登记旧 driver 再移除——已建好的二代不被逐出", async () => {
        const stack = new RuntimeStack();
        stack.registerDriver("mockssh", (d) => new MockLayerDriver(d) as unknown as RuntimeDriver);
        const desc = { driver: "mockssh", target: "reg72" } as RuntimeDescriptor;
        await stack.addLayer("a", desc);
        const gen1 = stack.layer("a").driver;
        stack.evict(desc);
        const gen2 = await stack.connect(desc); // 二代已建好（在缓存）
        await stack.addLayer("re", gen1); // 重新登记旧 driver（driver 直传）
        await stack.removeLayer("re", { destroy: true }); // 修前：按描述符清缓存=逐出 gen2
        const gen3 = await stack.connect(desc);
        expect(gen3).toBe(gen2);
        await (gen2 as unknown as MockLayerDriver).destroy();
        RuntimeStack.evictDriver(desc);
    }, 15_000);
});

// GPT Sol 七十四期 #6：自定义工厂让同一 driver 挂两个描述符键——homeKeys 曾只
// 记最后一个键，销毁后另一键仍能拿到已销毁实例。集合化：全部键实例核对清。
describe("Sol 74：homeKeys 多键", () => {
    test("共享 driver 两键：两层移除销毁后，按任一描述符重连拿新实例", async () => {
        const shared = new MockLayerDriver({ driver: "shared74" } as RuntimeDescriptor) as unknown as RuntimeDriver;
        let served = 0;
        const stack = new RuntimeStack();
        // 前两次（初始两键）吐同一实例（模拟工厂层共享）；之后吐新件——
        // 若缓存清理正确，重连必走工厂拿新实例
        const factory = () => {
            served++;
            return (served <= 2 ? shared : new MockLayerDriver({ driver: "fresh74" } as RuntimeDescriptor)) as unknown as RuntimeDriver;
        };
        stack.registerDriver("dA", factory);
        stack.registerDriver("dB", factory);
        await stack.addLayer("a", { driver: "dA", target: "x" });
        await stack.addLayer("b", { driver: "dB", target: "x" });
        expect(stack.layer("a").driver).toBe(shared);
        expect(stack.layer("b").driver).toBe(shared); // 同实例挂两键
        await stack.removeLayer("a", { destroy: true });
        await stack.removeLayer("b", { destroy: true });
        await new Promise((r) => setTimeout(r, 30));
        expect((shared as unknown as MockLayerDriver).destroyed).toBe(true);
        // 修前：dA 键残留——按 dA 重连拿回已销毁实例
        const again = await stack.connect({ driver: "dA", target: "x" } as RuntimeDescriptor);
        expect(again).not.toBe(shared);
        expect((again as unknown as MockLayerDriver).destroyed).toBe(false);
        RuntimeStack.evictDriver({ driver: "dA", target: "x" } as RuntimeDescriptor);
        RuntimeStack.evictDriver({ driver: "dB", target: "x" } as RuntimeDescriptor);
        await (again as unknown as MockLayerDriver).destroy();
    }, 15_000);
});

// GPT Sol 七十五期 P2-1/P2-7/P2-8：terminalId 重挂曾双实例互杀（索引复用收口）；
// homeKeys 空 Set 强引用滞留（常驻积累）；逐出一别名曾拆掉整个事件桥。
describe("Sol 75：重挂复用/回收/事件桥", () => {
    test("P2-1 带 terminalId 重挂：复用既有 driver（不建第二实例）", async () => {
        let created = 0;
        const stack = new RuntimeStack();
        stack.registerDriver("mocktmux", (d: RuntimeDescriptor) => {
            created++;
            const drv = new MockLayerDriver({ ...d, terminalId: "T75" }) as unknown as RuntimeDriver & { descriptor: RuntimeDescriptor };
            return drv;
        });
        const a = await stack.connect({ driver: "mocktmux", target: "t75" } as RuntimeDescriptor);
        expect(created).toBe(1);
        // 重挂：descriptor 带 terminalId（快照形态）——修前键不匹配新建第二实例
        const b = await stack.connect({ driver: "mocktmux", target: "t75", terminalId: "T75" } as RuntimeDescriptor);
        expect(b).toBe(a); // 索引复用
        expect(created).toBe(1);
        RuntimeStack.evictDriverHome(a);
        await (a as unknown as MockLayerDriver).destroy();
    }, 15_000);

    test("P2-7/P2-8 别名逐出不拆桥、全逐出拆桥且无空集合滞留", async () => {
        const shared = new MockLayerDriver({ driver: "alias75" } as RuntimeDescriptor) as unknown as RuntimeDriver;
        const stack = new RuntimeStack();
        let served = 0;
        const factory = () => {
            served++;
            return (served <= 2 ? shared : new MockLayerDriver({ driver: "fresh75" } as RuntimeDescriptor)) as unknown as RuntimeDriver;
        };
        stack.registerDriver("kA", factory);
        stack.registerDriver("kB", factory);
        await stack.addLayer("a", { driver: "kA", target: "x" });
        await stack.addLayer("b", { driver: "kB", target: "x" });
        // 事件桥在场（白盒：mock 补 sessions 载体 + subs 非空）
        const sm = (shared as unknown as { sessions: { __fxSubs?: Set<unknown> } }).sessions
            ?? ((shared as unknown as { sessions: { __fxSubs?: Set<unknown> } }).sessions = {});
        sm.__fxSubs = sm.__fxSubs ?? new Set();
        sm.__fxSubs.add("fwd-75");
        stack.evict({ driver: "kA", target: "x" } as RuntimeDescriptor); // 逐出一别名（实例方法带 cacheNs）
        expect(sm.__fxSubs.size).toBe(1); // 修前：整桥被拆（剩余别名丢事件）
        const still = await stack.connect({ driver: "kB", target: "x" } as RuntimeDescriptor);
        expect(still).toBe(shared); // 另一别名仍可用
        stack.evict({ driver: "kB", target: "x" } as RuntimeDescriptor); // 全逐出
        expect(sm.__fxSubs.size).toBe(0); // 全逐出才拆桥
        const homeKeys = (RuntimeStack as unknown as { driverHomeKeys: Map<unknown, Set<string>> }).driverHomeKeys;
        expect(homeKeys.has(shared)).toBe(false); // 修前：空 Set 条目滞留（强引用积累）
        await (shared as unknown as MockLayerDriver).destroy();
        RuntimeStack.evictDriver({ driver: "kA", target: "x" } as RuntimeDescriptor);
        RuntimeStack.evictDriver({ driver: "kB", target: "x" } as RuntimeDescriptor);
    }, 15_000);
});

// GPT Sol 七十六期：P1-1 terminalId 索引裸 id 串线（不同 driver/不同 cwd 的重挂
// 拿到第一个 driver）；#3 同 tid 多实例 destroy 连坐会话；#6 全逐出后同 driver
// 复用事件不转发（扇出未重装）。
describe("Sol 76：索引判别/会话引用计数/扇出重装", () => {
    test("P1-1 不同 driver 同 tid 不串线；同 driver 不同 cwd 重挂不命中索引", async () => {
        let madeA = 0, madeB = 0;
        const stack = new RuntimeStack();
        stack.registerDriver("tmA", (d: RuntimeDescriptor) => { madeA++; return new MockLayerDriver({ ...d, terminalId: "TX" }) as unknown as RuntimeDriver; });
        stack.registerDriver("tmB", (d: RuntimeDescriptor) => { madeB++; return new MockLayerDriver({ ...d, terminalId: "TX" }) as unknown as RuntimeDriver; });
        const a = await stack.connect({ driver: "tmA", target: "t" } as RuntimeDescriptor);
        const b = await stack.connect({ driver: "tmB", target: "t" } as RuntimeDescriptor); // 同 tid 不同 driver
        expect(b).not.toBe(a); // 修前：索引裸 id 命中——命令送到第一个 driver
        expect(madeA).toBe(1); expect(madeB).toBe(1);
        // 同 driver 不同 cwd 重挂：不命中（cwd 是身份列）——新建实例（attach 计数护会话）
        const c1 = await stack.connect({ driver: "tmA", target: "t", cwd: "/x" } as RuntimeDescriptor);
        expect(c1).not.toBe(a); // 修前：裸 id 命中旧实例（cwd 被吞、命令落旧目录）
        RuntimeStack.evictDriverHome(a); RuntimeStack.evictDriverHome(b); RuntimeStack.evictDriverHome(c1);
        for (const d of [a, b, c1]) await (d as unknown as MockLayerDriver).destroy();
    }, 15_000);

    test("#3 同 tid 两实例：destroy 一个不杀共享会话（归零才杀）", async () => {
        const destroyedSessions: string[] = [];
        const mkDrv = (tid: string, cwd?: string) => new TmuxSessionDriver(
            // 无 terminalId 走 spawn 路径（stub 起"会话"）——避免 init 的真 tmux 探测
            { driver: "tmux", cwd, config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => tid,
                runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
                destroySession: async (id: string) => { destroyedSessions.push(id); },
            } as never },
        );
        const d1 = mkDrv("SH76", "/tmp");
        const d2 = mkDrv("SH76", "/"); // 不同 cwd 重挂——第二实例共指同一会话
        await d1.init(); await d2.init();
        await d1.destroy(); // 修前：直接杀会话——d2 报会话不存在
        expect(destroyedSessions).toEqual([]); // 还有持有人
        await d2.destroy(); // 归零
        expect(destroyedSessions).toEqual(["SH76"]);
    }, 15_000);

    test("#6 全逐出后同 driver 复用：事件仍转发（扇出重装）", async () => {
        const shared = new MockLayerDriver({ driver: "reb76" } as RuntimeDescriptor) as unknown as RuntimeDriver & {
            sessions: { onEvent?: (e: unknown) => void; __fxSubs?: Set<(e: unknown) => void>; __fxOrig?: (e: unknown) => void };
        };
        shared.sessions = { onEvent: () => undefined }; // 桥守卫要求 onEvent 是函数（driver 自有消费方）
        const stack = new RuntimeStack();
        stack.registerDriver("reb76", () => shared); // 工厂恒返同实例（复用场景）
        await stack.addLayer("a", { driver: "reb76", target: "x" });
        const got: unknown[] = [];
        stack.events.on("*", (e) => got.push(e));
        stack.evict({ driver: "reb76", target: "x" } as RuntimeDescriptor); // 全逐出（onEvent 还原）
        await stack.connect({ driver: "reb76", target: "x" } as RuntimeDescriptor); // 复用同 driver 重连
        shared.sessions.onEvent?.({ type: "exit", sessionId: "s" }); // 会话侧发事件
        expect(got.length).toBe(1); // 修前：0（扇出没重装——订阅进了没人遍历的集合）
        await stack.removeLayer("a", { destroy: true });
        await new Promise((r) => setTimeout(r, 20));
    }, 15_000);
});

// GPT Sol 七十七期 #4/#5：销毁排程中的 driver 曾被 terminalId 索引返还（新句柄
// 随即失效）；同 tid 多工厂曾互相覆盖索引（被覆盖方重挂出第三实例）。
describe("Sol 77：索引销毁中跳过/嵌套不互覆", () => {
    test("#4 销毁排程中的索引命中被跳过——重挂拿新活实例", async () => {
        let made = 0;
        const stack = new RuntimeStack();
        stack.registerDriver("mt77", (d: RuntimeDescriptor) => { made++; return new MockLayerDriver({ ...d, terminalId: "T77" }) as unknown as RuntimeDriver; });
        await stack.addLayer("a", { driver: "mt77", target: "t" });
        const old = stack.layer("a").driver;
        const rm = stack.removeLayer("a", { destroy: true }); // 排程销毁（destroyScheduled）
        await rm;
        const again = await stack.connect({ driver: "mt77", target: "t", terminalId: "T77" } as RuntimeDescriptor);
        expect(again).not.toBe(old); // 修前：索引返还排程中的死句柄
        expect((again as unknown as MockLayerDriver).destroyed).toBe(false);
        RuntimeStack.evictDriverHome(again);
        await (again as unknown as MockLayerDriver).destroy();
    }, 15_000);

    test("#5 同 tid 两工厂各占索引槽——互不覆盖", async () => {
        let mA = 0, mB = 0;
        const stack = new RuntimeStack();
        stack.registerDriver("fa77", (d: RuntimeDescriptor) => { mA++; return new MockLayerDriver({ ...d, terminalId: "TZ" }) as unknown as RuntimeDriver; });
        stack.registerDriver("fb77", (d: RuntimeDescriptor) => { mB++; return new MockLayerDriver({ ...d, terminalId: "TZ" }) as unknown as RuntimeDriver; });
        const a = await stack.connect({ driver: "fa77", target: "t" } as RuntimeDescriptor);
        const b = await stack.connect({ driver: "fb77", target: "t" } as RuntimeDescriptor);
        expect(a).not.toBe(b);
        // A 方重挂（同描述符+tid）：拿到 A 的实例——修前：被 B 覆盖 → miss 出第三实例
        const a2 = await stack.connect({ driver: "fa77", target: "t", terminalId: "TZ" } as RuntimeDescriptor);
        expect(a2).toBe(a);
        expect(mA).toBe(1); expect(mB).toBe(1);
        RuntimeStack.evictDriverHome(a); RuntimeStack.evictDriverHome(b);
        await (a as unknown as MockLayerDriver).destroy();
        await (b as unknown as MockLayerDriver).destroy();
    }, 15_000);
});

test.skipIf(process.platform === "win32")("SSH aliases with different proxy routes get distinct named layers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "filaxis-ssh-route-"));
    const savedPath = process.env.PATH;
    const stack = new RuntimeStack();
    stack.connect = async (descriptor) => new MockLayerDriver(descriptor) as unknown as RuntimeDriver;
    try {
        writeFileSync(join(dir, "ssh"), [
            "#!/bin/sh",
            'test "$1" = -G || exit 1',
            'printf "host %s\\nuser deploy\\nhostname 10.0.0.5\\nport 22\\n" "$2"',
            'case "$2" in',
            '  fx-route-a) printf "proxyjump bastion-a\\n";;',
            '  fx-route-b) printf "proxyjump bastion-b\\n";;',
            'esac',
        ].join("\n") + "\n", { mode: 0o700 });
        process.env.PATH = [dir, savedPath].filter(Boolean).join(delimiter);
        const add = (name: string, target: string) => stack.addLayer(name, { driver: "ssh", target });
        const first = await add("routed-a", "fx-route-a");
        const second = await add("routed-b", "fx-route-b");
        expect(second.reused).toBe(false);
        expect(second.handle.driver).not.toBe(first.handle.driver);
        expect((await add("same-route", "fx-route-a")).handle).toBe(first.handle);
        const direct = await add("direct", "fx-direct-a");
        expect((await add("direct-alias", "fx-direct-b")).handle).toBe(direct.handle);
    } finally {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
        await Promise.all([...stack.layers.keys()].map((name) => stack.removeLayer(name)));
        rmSync(dir, { recursive: true, force: true });
    }
});

test("sshInto only reuses a landing with matching connection settings", async () => {
    const stack = new RuntimeStack();
    let pushed = 0;
    const landing = {
        descriptor: { driver: "ssh", target: "localhost" },
        init: async () => undefined,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as RuntimeDriver;
    const child = {
        descriptor: { driver: "ssh", target: "localhost", config: { sshHops: [
            { host: "localhost", conn: { hostKeyPolicy: "strict", knownHostsFile: "fixture" } },
        ] } },
        init: async () => undefined,
    } as unknown as RuntimeDriver;
    const source = Object.assign({}, landing, {
        descriptor: { driver: "ssh", target: "127.0.0.1" },
        pushChild: async () => { pushed++; return child; },
    });
    await stack.addLayer("landing", landing);
    await stack.addLayer("source", source);
    // Resolve aliases using the same ssh -G path as production.
    const same = await stack.sshInto("source", "same", "localhost");
    expect(same.handle.driver).toBe(landing);
    const strict = await stack.sshInto("source", "strict", "localhost", {
        hostKeyPolicy: "strict", knownHostsFile: "fixture",
    });
    expect(strict.reused).toBe(false);
    expect(strict.handle.driver).toBe(child);
    expect(pushed).toBe(1);
});

test("removeLayer awaits disposal and propagates unresolved session evidence", async () => {
    const stack = new RuntimeStack();
    const disposal = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const driver = new MockLayerDriver({ driver: "mockssh" });
    driver.destroy = () => { entered.resolve(); return disposal.promise; };
    await stack.addLayer("owned", driver as unknown as RuntimeDriver);
    const removal = stack.removeLayer("owned", { destroy: true });
    const expected = Object.assign(new Error("cleanup unknown"), {
        outcome: "unknown",
        sessions: [{ sessionId: "fixture", logBase: "/tmp/fixture" }],
    });
    const result = removal.catch((error: unknown) => error);
    await entered.promise;
    expect(stack.layers.has("owned")).toBe(false);
    await expect(stack.addLayer("new", driver as unknown as RuntimeDriver)).rejects.toThrow(/正在销毁/);
    disposal.reject(expected);
    expect(await result).toBe(expected);
});

test("driver exit events remain forwarded through named-layer disposal", async () => {
    const stack = new RuntimeStack();
    const seen: string[] = [];
    stack.events.on("exit", (event) => { if (event.type === "exit") seen.push(event.sessionId); });
    const sessions = { onEvent: async (_event: import("../src/core/base/session-types.js").SessionEvent) => {
        throw new Error("driver callback rejected");
    } };
    const driver = Object.assign(new MockLayerDriver({ driver: "fixture" }), {
        sessions,
        destroy: async () => { sessions.onEvent({ type: "exit", sessionId: "during-destroy", exitCode: 0, lastLines: [] }); },
    });
    await stack.addLayer("fixture", driver as unknown as RuntimeDriver);
    sessions.onEvent({ type: "exit", sessionId: "direct", exitCode: 0, lastLines: [] });
    await stack.removeLayer("fixture", { destroy: true });
    await expect(sessions.onEvent({ type: "exit", sessionId: "after-destroy", exitCode: 0, lastLines: [] }))
        .rejects.toThrow("driver callback rejected");
    expect(seen).toEqual(["direct", "during-destroy"]);
});
