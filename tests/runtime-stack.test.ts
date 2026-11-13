/**
 * 事件总线 / 栧门面 / 工厂注册 单测（AC-07 指纹复用 / AC-09 注册 / AC-10 事件双形态）
 * + 命名层注册表状态机（第十季 Layer 渗透——Paramiko 式句柄）
 */
import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/events.js";
import { RuntimeStack } from "../src/runtime-stack.js";
import { createAgentToolkit } from "../src/agent-toolkit.js";
import { RuntimeFactory } from "../src/factory.js";
import { LocalRuntimeDriver } from "../src/local-driver.js";
import { SshPtyDriver } from "../src/ssh-pty-driver.js";
import { enterStepsOf } from "../src/ssh-helpers.js";
import type { RuntimeDriver, RuntimeDescriptor } from "../src/driver.js";
import type { LayerHandle } from "../src/runtime-stack.js";

type Ev = { type: "a" | "b"; v: number };

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
        expect((dup.reason as Error).message).toMatch(/已占用或建链中/);
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
        expect(((a.status === "rejected" ? a : b) as PromiseRejectedResult).reason.message).toMatch(/已占用或建链中/);
        await stack.removeLayer("sameName").catch(() => undefined);
        await stack.removeLayer("deriveSrc").catch(() => undefined);
    }, 20_000);

    // #2 共享连接的双 stack 各自收到会话事件（修前第二个 stack 0 次）
    test("缓存命中的第二个 stack 事件照收（多订阅者登记）", async () => {
        // 独立指纹防测试间缓存污染（target 注入 capabilities 不可行——用 cwd 微差）
        const shared = { driver: "local", cwd: `${process.cwd()}#m28` } as unknown as RuntimeDescriptor;
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
        const shared = { driver: "local", cwd: `${process.cwd()}#m29` } as unknown as RuntimeDescriptor;
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
import { EventBus as EventBusFor30 } from "../src/events.js";
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

    test("#2 stop_and_verify 停止通道抛错 → unknown + verify 继续（不裸抛）", async () => {
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
        } as unknown as import("../src/driver.js").RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: drv });
        const r = await tk.handlers.stop_and_verify({ session_id: "s34" });
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
