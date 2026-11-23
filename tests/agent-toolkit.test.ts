import { describe, expect, test } from "bun:test";
import { RuntimeStack } from "../src/runtime-stack.js";
import { createAgentToolkit } from "../src/agent-toolkit.js";
import { enterStepsOf } from "../src/ssh-helpers.js";
import type { RuntimeDriver, RuntimeDescriptor } from "../src/driver.js";

/** mock ssh 层 driver（层族测试——pushInto 派生镜像真 driver 语义） */
class MockSshDriver {
    descriptor: RuntimeDescriptor;
    constructor(d: RuntimeDescriptor) { this.descriptor = d; }
    async init() { /* no-op */ }
    async destroy() { /* no-op */ }
    async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return { stdout: `mock:${command.slice(0, 20)}\n`, stderr: "", exitCode: 0 };
    }
    async pushInto(cmd: string, label: string): Promise<MockSshDriver> {
        const cfg = (this.descriptor.config ?? {}) as Record<string, unknown>;
        const child = new MockSshDriver({
            ...this.descriptor,
            config: { ...cfg, enterPipeline: [...enterStepsOf(cfg), { cmd, label }], enterCmd: undefined, enterLabel: undefined },
        });
        await child.init();
        return child;
    }
}

describe("createAgentToolkit（反馈 #3）", () => {
    test("explicit invalid layer never falls back to the active driver", async () => {
        const driver = new MockSshDriver({ driver: "fixture" });
        let executions = 0;
        driver.exec = async () => { executions++; return { stdout: "", stderr: "", exitCode: 0 }; };
        const stack = new RuntimeStack();
        await stack.addLayer("fixture", driver as unknown as RuntimeDriver);
        const { handlers } = createAgentToolkit(stack);
        for (const layer of ["", " ", null, false, 0]) {
            await expect(handlers.run_command({ command: "fixture", layer: layer as never })).rejects.toThrow(/非空层名/);
        }
        const misspelled = { command: "fixture", layer_name: "elsewhere" };
        await expect(handlers.run_command(misspelled)).rejects.toThrow(/目标层字段为 layer/);
        await expect(handlers.run_command({ command: "" })).rejects.toThrow(/command 需为非空字符串/);
        expect(executions).toBe(0);
        expect((await handlers.run_command({ command: "fixture" })).exit_code).toBe(0);
        expect(executions).toBe(1);
        await stack.removeLayer("fixture", { destroy: true });
    });

    test("push_ssh batch excludes layers replaced before the response", async () => {
        const stack = new RuntimeStack();
        const addLayer = stack.addLayer.bind(stack);
        const slowEntered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        stack.addLayer = async (name) => {
            if (name === "slow") {
                slowEntered.resolve();
                await release.promise;
            }
            return addLayer(name, new MockSshDriver({ driver: "fixture" }) as unknown as RuntimeDriver);
        };
        const batch = createAgentToolkit(stack).handlers.push_ssh({ targets: ["first", "slow"] });
        try {
            await slowEntered.promise;
            await stack.removeLayer("first", { destroy: true });
            await stack.addLayer("first", { driver: "local" });
            release.resolve();
            expect(await batch).toMatchObject({
                status: "partial",
                layers: ["slow"],
                results: [
                    { name: "first", status: "fail", error: expect.stringContaining("已移除或被替换") },
                    { name: "slow", status: "ok", layer: "slow" },
                ],
            });
        } finally {
            release.resolve();
            await batch;
            await Promise.all([...stack.layers.keys()].map((name) => stack.removeLayer(name, { destroy: true })));
        }
    });

    test("工具定义 + run_command 退出码是数据", async () => {
        const tk = createAgentToolkit(new RuntimeStack());
        expect(tk.tools.map((t) => t.function.name)).toEqual([
            "run_batch", // 置顶（第十三季黑盒：Lazy schema 按序读——run_batch 排第 7 被漏读）
            "run_command", "spawn_and_observe", "stop_and_verify",
            "read_file", "list_directory", "delete_file", "edit_file", "put_file", "get_file",
            "observe_stream", "read_stream", "close_stream",
            "push_ssh", "push_into", "list_layers", "set_active_layer", "remove_layer",
        ]);
        const r = await tk.handlers.run_command({ command: "echo tk-out; exit 4" });
        expect(r.stdout.trim()).toBe("tk-out");
        expect(r.exit_code).toBe(4); // 非零不抛——数据
        expect(r.effective_user).toBeTruthy();
    }, 20_000);

    test("spawn_and_observe 就绪握手（回溯竞态安全）+ stop_and_verify 三态", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), { readyTimeoutMs: 10_000 });
        const h = await tk.handlers.spawn_and_observe({
            command: "sleep 0.5; echo LISTENING-OK; sleep 30",
            ready_marker: "LISTENING-OK",
            error_pattern: "NEVER_MATCH",
            name: "tk",
        });
        expect(h.session_id).toContain("tk-");
        expect(h.note).toBe("ready");
        const s = await tk.handlers.stop_and_verify({ session_id: h.session_id });
        // local 面三态皆合法（Astra 二轮 #2 后：TERM/KILL 后仍核实不到死亡=unknown 诚实返回，
        // Windows 下 bash 子进程树收 TERM 偶有不退净——不再伪报 stopped）
        expect(["exited", "stopped", "unknown"]).toContain(s.status);
    }, 30_000);

    // GPT Astra #3：旧形态 driver 返回 {exitCode: null}（终止已发、无死亡证明——
    // tmux 后端 stop 后 .code 未落盘正是此形态）——必须报 unknown，不得报 stopped
    test("stop_and_verify：无 status 且 exitCode null → unknown（无死亡证明不伪 stopped）", async () => {
        const fakeOldDriver = {
            descriptor: { driver: "tmux", target: "mock" },
            async stopSession() { return { exitCode: null }; }, // 旧形态：发了 kill，没核实
        } as unknown as import("../src/driver.js").RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: fakeOldDriver });
        const r = await tk.handlers.stop_and_verify({ session_id: "s", layer: "__initial__" });
        expect(r.status).toBe("unknown"); // 修前：stopped（违宪——终止≠已核实）
        expect(r.note).toContain("verify"); // unknown 后自动接 verify（双通道不可达才保持）
    }, 15_000);

    // GPT Astra 二轮 #3：spawn 在远端层的会话曾固定回初始层停（停错层必然失败）——
    // 修后按归属层（spawn 时的 driver）停止
    test("stop_and_verify：跨层会话按归属层停止（不落初始层）", async () => {
        const stack = new RuntimeStack();
        let initStopped: string[] = [];
        let remoteStopped: string[] = [];
        const remoteDrv = {
            descriptor: { driver: "ssh", target: "remote-host" },
            async exec() { return { stdout: "", stderr: "", exitCode: 0 }; }, // isDriver 判定面
            async execSession(cmd: string) { return { sessionId: `rs-${cmd.slice(0, 4)}`, logBase: "/tmp/x" }; },
            async tailSession() { return ["READY"]; },
            async watchSession() { return { cancel: () => undefined }; },
            async stopSession(id: string) { remoteStopped.push(id); return { status: "stopped" as const }; },
        } as unknown as RuntimeDriver;
        const initDrv = {
            descriptor: { driver: "local" },
            async stopSession(id: string) { initStopped.push(id); return { status: "stopped" as const }; },
        } as unknown as RuntimeDriver;
        // 初始层 = initDrv；命名远端层 = remoteDrv
        await stack.addLayer("remote", remoteDrv);
        const tk = createAgentToolkit(stack, { driver: initDrv });
        const h = await tk.handlers.spawn_and_observe({ command: "srv", ready_marker: "READY" });
        // spawn 落默认层（remote——最近注册）——stop 必须回 remote 停
        const s = await tk.handlers.stop_and_verify({ session_id: h.session_id });
        expect(s.status).toBe("stopped");
        expect(remoteStopped).toContain(h.session_id); // 归属层停了
        expect(initStopped).toEqual([]); // 初始层没被误用（修前：停错层报不存在）
        await stack.removeLayer("remote");
    }, 15_000);

    // GPT Astra 三轮 #1：unknown 终态**保留归属**（修前停止前就删——重试核实回退初始层停错层）
    test("stop_and_verify：unknown 后重试仍找归属层；终态确定才清归属", async () => {
        const stack = new RuntimeStack();
        const calls: string[] = [];
        let stopResult: { status: string } = { status: "unknown" };
        const remoteDrv = {
            descriptor: { driver: "ssh", target: "r2" },
            async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
            async execSession() { return { sessionId: "rs-own", logBase: "/tmp/x" }; },
            async tailSession() { return ["R"]; },
            async watchSession() { return { cancel: () => undefined }; },
            async stopSession(id: string) { calls.push(`remote:${id}`); return stopResult; },
        } as unknown as RuntimeDriver;
        const initDrv = {
            descriptor: { driver: "local" },
            async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
            async stopSession(id: string) { calls.push(`init:${id}`); return { status: "stopped" }; },
        } as unknown as RuntimeDriver;
        await stack.addLayer("r2", remoteDrv);
        const tk = createAgentToolkit(stack, { driver: initDrv });
        await tk.handlers.spawn_and_observe({ command: "c", ready_marker: "R" });
        // 第一次：unknown → 归属必须保留
        const r1 = await tk.handlers.stop_and_verify({ session_id: "rs-own" });
        expect(r1.status).toBe("unknown");
        // 重试（网络恢复后再核实）：仍走归属层，不落初始层
        stopResult = { status: "exited" };
        const r2 = await tk.handlers.stop_and_verify({ session_id: "rs-own" });
        expect(r2.status).toBe("exited");
        expect(calls).toEqual(["remote:rs-own", "remote:rs-own"]); // 两次都在归属层（修前第二次落 init）
        await stack.removeLayer("r2");
    }, 15_000);

    // GPT Astra 四轮 #1：旧形态 {exitCode:null}（status undefined）归一为 unknown——
    // 归属必须保留（修前 status!=="unknown" 判断把 undefined 当确定终态→删归属→重试落初始层）
    test("stop_and_verify：旧形态无死亡证明归一 unknown 且保留归属（重试仍找归属层）", async () => {
        const stack = new RuntimeStack();
        const calls: string[] = [];
        let stopResult: { exitCode?: number | null; status?: string } = { exitCode: null }; // 旧形态
        const remoteDrv = {
            descriptor: { driver: "tmux", target: "old" },
            async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
            async execSession() { return { sessionId: "old-s", logBase: "/tmp/x" }; },
            async tailSession() { return ["R"]; },
            async watchSession() { return { cancel: () => undefined }; },
            async stopSession(id: string) { calls.push(`remote:${id}`); return stopResult; },
        } as unknown as RuntimeDriver;
        const initDrv = {
            descriptor: { driver: "local" },
            async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
            async stopSession(id: string) { calls.push(`init:${id}`); return { exitCode: null }; },
        } as unknown as RuntimeDriver;
        await stack.addLayer("old", remoteDrv);
        const tk = createAgentToolkit(stack, { driver: initDrv });
        await tk.handlers.spawn_and_observe({ command: "c", ready_marker: "R" });
        const r1 = await tk.handlers.stop_and_verify({ session_id: "old-s" });
        expect(r1.status).toBe("unknown"); // 归一：无死亡证明
        // 重试：仍走归属层
        stopResult = { status: "exited", exitCode: 0 };
        const r2 = await tk.handlers.stop_and_verify({ session_id: "old-s" });
        expect(r2.status).toBe("exited");
        expect(calls).toEqual(["remote:old-s", "remote:old-s"]); // 修前第二次 init:old-s
        await stack.removeLayer("old");
    }, 15_000);
});

describe("toolkit 层族（第十季命名层注册表）", () => {
    test("push_into/list_layers/remove_layer + layer 参数寻址 + 无层族时零破坏", async () => {
        const stack = new RuntimeStack();
        stack.registerDriver("mockssh", (d) => new MockSshDriver(d) as unknown as RuntimeDriver);
        const tk = createAgentToolkit(stack, {});
        // 零破坏：未用层族——run_command 落初始 local 层（旧行为）
        const r0 = await tk.handlers.run_command({ command: "echo OLD_PATH" });
        expect(r0.stdout).toContain("OLD_PATH");
        // push_into 无源层报错
        await expect(tk.handlers.push_into({ enter_cmd: "docker exec -i web sh" })).rejects.toThrow(/无源层/);
        // 注册 mock 层（driver 形态）→ 成默认层 → 六工具自动落它
        const m = new MockSshDriver({ driver: "mockssh", target: "h1" });
        await m.init();
        await stack.addLayer("host1", m as unknown as RuntimeDriver);
        const r1 = await tk.handlers.run_command({ command: "anything" });
        expect(r1.stdout).toContain("mock:"); // 落 mock 层而非 local
        // push_into 从默认层派生
        const p = await tk.handlers.push_into({ enter_cmd: "docker exec -i web sh", label: "docker:web" });
        expect(p.layer).toBe("docker:web");
        expect(enterStepsOf(stack.layer("docker:web").descriptor.config as Record<string, unknown>).length).toBe(1);
        // 参数别名宽收（第十二季）：enterCommand 手滑等价——派生自当前默认层 docker:web，
        // enter 管线全量继承追加（web→db 两步，继承语义）
        const p2 = await tk.handlers.push_into({ enterCommand: "docker exec -i db sh" } as never);
        expect(p2.layer).toBe("docker exec -i db sh".slice(0, 30));
        expect(enterStepsOf(stack.layer("docker exec -i db sh".slice(0, 30)).descriptor.config as Record<string, unknown>).length).toBe(2);
        // layer 显式寻址（跨层）
        const r2 = await tk.handlers.run_command({ command: "x", layer: "host1" });
        expect(r2.stdout).toContain("mock:");
        // list_layers / remove_layer（host1 + docker:web + db 派生层 = 3 层）
        const ls = await tk.handlers.list_layers({});
        expect(ls.text).toContain("host1");
        expect(ls.text).toContain("docker:web");
        expect(ls.layers.length).toBe(3);
        await tk.handlers.remove_layer({ name: "docker:web" });
        expect((await tk.handlers.list_layers({})).layers.length).toBe(2);
        await tk.handlers.remove_layer({ name: "docker exec -i db sh".slice(0, 30) });
        RuntimeStack.evictDriver({ driver: "mockssh", target: "h1" } as RuntimeDescriptor);
    }, 20_000);
});

// GPT Astra 三十四期 P1：ready 超时谎称「已自动停止」——unknown 须诚实 + 会话线索 + verify
describe("spawn_and_observe ready 超时三态（三十四期）", () => {
    const mkDrv = (stopStatus: string | Error, verify?: { status: string; exitCode?: number | null }) => ({
        descriptor: { driver: "local" },
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        init: async () => undefined,
        destroy: async () => undefined,
        execSession: async () => ({ sessionId: "fx-rd-timeout", logBase: "/tmp/fx-rd", pid: 123 }),
        tailSession: async () => ["no-marker-yet"],
        stopSession: async () => stopStatus instanceof Error ? Promise.reject(stopStatus) : { status: stopStatus, exitCode: null },
        verifySession: async () => verify ?? { status: "unknown" },
    }) as unknown as import("../src/driver.js").RuntimeDriver;

    test("stop unknown + verify unknown → outcome:unknown + 会话线索（不再谎称已停）", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), { driver: mkDrv("unknown"), readyTimeoutMs: 150 });
        let caught: (Error & { outcome?: string; sessionId?: string; logBase?: string }) | undefined;
        try { await tk.handlers.spawn_and_observe({ command: "x", ready_marker: "READY" }); } catch (e) { caught = e as never; }
        expect(caught?.message).not.toContain("已自动停止"); // 修前：谎称
        expect(caught?.message).toContain("可能仍在运行");    // 诚实警告
        expect(caught?.outcome).toBe("unknown");
        expect(caught?.sessionId).toBe("fx-rd-timeout");     // 核实线索
        expect(caught?.logBase).toBe("/tmp/fx-rd");
    }, 15_000);

    test("stop unknown + verify exited → 采纳真实退出码（stopped 语义）", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), { driver: mkDrv("unknown", { status: "exited", exitCode: 7 }), readyTimeoutMs: 150 });
        let caught: (Error & { outcome?: string }) | undefined;
        try { await tk.handlers.spawn_and_observe({ command: "x", ready_marker: "READY" }); } catch (e) { caught = e as never; }
        expect(caught?.outcome).toBe("stopped");
        expect(caught?.message).toContain("exitCode=7");
    }, 15_000);

    test("stop stopped → 如实 stopped（无 verify 调用需求）", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), { driver: mkDrv("stopped"), readyTimeoutMs: 150 });
        let caught: (Error & { outcome?: string }) | undefined;
        try { await tk.handlers.spawn_and_observe({ command: "x", ready_marker: "READY" }); } catch (e) { caught = e as never; }
        expect(caught?.outcome).toBe("stopped");
        expect(caught?.message).toContain("停止已核实");
    }, 15_000);

    test("stop 通道抛错 → unknown（会话线索保留）", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), { driver: mkDrv(new Error("channel dead")), readyTimeoutMs: 150 });
        let caught: (Error & { outcome?: string }) | undefined;
        try { await tk.handlers.spawn_and_observe({ command: "x", ready_marker: "READY" }); } catch (e) { caught = e as never; }
        expect(caught?.outcome).toBe("unknown");
    }, 15_000);
});

// GPT Astra 三十五期双回归：
describe("三十五期", () => {
    // #1 启动后异常（watchSession/tailSession 抛错）统一处理
    test("watchSession 抛错 → stop+verify 路径（outcome+sessionId 在场，不再裸抛）", async () => {
        const drv = {
            descriptor: { driver: "local" },
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
            init: async () => undefined,
            destroy: async () => undefined,
            execSession: async () => ({ sessionId: "fx-post-boot", logBase: "/tmp/pb", pid: 1 }),
            watchSession: () => { throw new Error("watcher backend dead"); },
            tailSession: async () => [],
            stopSession: async () => ({ status: "stopped", exitCode: null }),
            verifySession: async () => ({ status: "unknown" }),
        } as unknown as import("../src/driver.js").RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: drv });
        let caught: (Error & { outcome?: string; sessionId?: string; logBase?: string }) | undefined;
        try { await tk.handlers.spawn_and_observe({ command: "x", ready_marker: "RDY", error_pattern: "ERR" }); } catch (e) { caught = e as never; }
        expect(caught?.outcome).toBe("stopped"); // stop 核实可靠
        expect(caught?.sessionId).toBe("fx-post-boot"); // 修前：裸抛无线索
        expect(caught?.message).toContain("watcher backend dead"); // 原因保留
    }, 15_000);

    test("tailSession 轮询抛错 → stopAndReport（不再裸抛原异常）", async () => {
        let calls = 0;
        const drv = {
            descriptor: { driver: "local" },
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
            init: async () => undefined,
            destroy: async () => undefined,
            execSession: async () => ({ sessionId: "fx-tail-err", logBase: "/tmp/te", pid: 1 }),
            tailSession: async () => { calls++; if (calls >= 2) throw new Error("tail channel broke"); return ["nope"]; },
            stopSession: async () => ({ status: "unknown", exitCode: null }),
            verifySession: async () => ({ status: "running" }),
        } as unknown as import("../src/driver.js").RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: drv, readyTimeoutMs: 10_000 });
        let caught: (Error & { outcome?: string; sessionId?: string }) | undefined;
        try { await tk.handlers.spawn_and_observe({ command: "x", ready_marker: "RDY" }); } catch (e) { caught = e as never; }
        expect(caught?.outcome).toBe("unknown"); // verify 实测 running
        expect(caught?.message).toContain("实测仍在运行"); // 诚实警告
        expect(caught?.message).toContain("tail channel broke"); // 原因保留
        expect(caught?.sessionId).toBe("fx-tail-err");
    }, 15_000);

});

describe("CLI observe 冒烟（正常路径）", () => {
    test("observe 端到端：启动→挂流→tail 输出报告", async () => {
        const { execSync } = await import("node:child_process");
        const r = execSync('bun bin/filaxis.ts observe --duration 800 -- "echo SELF_AUDIT_OK"', { encoding: "utf-8", timeout: 15_000 });
        expect(r).toContain("SELF_AUDIT_OK");
    }, 20_000);
});

test("ready 等待期间核实未知时继续等待，且不请求停止", async () => {
    let reads = 0;
    let stops = 0;
    const driver = {
        execSession: async () => ({ sessionId: "fixture", logBase: "/tmp/fixture" }),
        tailSession: async () => ++reads >= 11 ? ["READY"] : [],
        verifySession: async () => ({ status: "unknown" }),
        stopSession: async () => { stops++; return { status: "stopped" }; },
    } as unknown as RuntimeDriver;
    const toolkit = createAgentToolkit(new RuntimeStack(), { driver, readyTimeoutMs: 4000 });
    const result = await toolkit.handlers.spawn_and_observe({ command: "fixture", ready_marker: "READY" });
    expect(result.note).toBe("ready");
    expect(stops).toBe(0);
});

test("natural exit releases Agent routing and caches the verified result for a bounded window", async () => {
    const stack = new RuntimeStack();
    let initialStops = 0;
    let explicitStops = 0;
    let finished = false;
    const original = {
        descriptor: { driver: "ssh", target: "fixture" },
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        execSession: async () => ({ sessionId: "short", logBase: "/tmp/short" }),
        sessions: { sessionState: () => finished ? { status: "exited", exitCode: 9 } : { status: "running", exitCode: null } },
        stopSession: async () => { explicitStops++; return { status: "exited", exitCode: 9 }; },
    } as unknown as RuntimeDriver;
    await stack.addLayer("fixture", original);
    const toolkit = createAgentToolkit(stack, {
        driver: { stopSession: async () => { initialStops++; return { status: "stopped" }; } } as unknown as RuntimeDriver,
        sessionResultTtlMs: 150,
        sessionCheckIntervalMs: 10,
    });
    await toolkit.handlers.spawn_and_observe({ command: "fixture" });
    finished = true;
    await Bun.sleep(35);
    const stop = toolkit.handlers.stop_and_verify;
    expect(await stop({ session_id: "short" })).toEqual({ status: "exited", exit_code: 9 });
    expect(explicitStops).toBe(0);
    await Bun.sleep(170);
    expect(await stop({ session_id: "short" })).toMatchObject({ status: "unknown" });
    expect(initialStops).toBe(0);
    expect(explicitStops).toBe(0);
    expect(await stop({ session_id: "short", layer: "fixture" })).toEqual({ status: "exited", exit_code: 9 });
    expect(explicitStops).toBe(1);
});

test("drivers without a session registry are probed without issuing stop requests", async () => {
    const probed = Promise.withResolvers<void>();
    const driver = {
        execSession: async () => ({ sessionId: "external", logBase: "/tmp/external" }),
        verifySession: async () => {
            probed.resolve();
            return { status: "exited", exitCode: 4 };
        },
        stopSession: async () => { throw Error("expected cached result"); },
    } as unknown as RuntimeDriver;
    const toolkit = createAgentToolkit(new RuntimeStack(), { driver, sessionCheckIntervalMs: 5 });
    await toolkit.handlers.spawn_and_observe({ command: "fixture" });
    await probed.promise;
    await Bun.sleep(10);
    expect(await toolkit.handlers.stop_and_verify({ session_id: "external" })).toEqual({ status: "exited", exit_code: 4 });
});

test("toolkit rebuilds its configured initial layer after that layer is destroyed", async () => {
    const stack = new RuntimeStack();
    let created = 0;
    stack.registerDriver("fixture", (descriptor) => {
        const generation = ++created;
        return {
            descriptor,
            init: async () => undefined,
            destroy: async () => undefined,
            exec: async () => ({ stdout: String(generation), stderr: "", exitCode: 0 }),
        } as unknown as RuntimeDriver;
    });
    const toolkit = createAgentToolkit(stack, { descriptor: { driver: "fixture" } });
    expect((await toolkit.handlers.run_command({ command: "first" })).stdout).toBe("1");
    await toolkit.handlers.remove_layer({ name: "__initial__", destroy: true });
    expect((await toolkit.handlers.run_command({ command: "second" })).stdout).toBe("2");
    await toolkit.handlers.remove_layer({ name: "__initial__", destroy: true });
});

test("observe_stream opens the selected layer and rejects unsupported layers", async () => {
    const stack = new RuntimeStack();
    const local = new (await import("../src/local-driver.js")).LocalRuntimeDriver();
    await stack.addLayer("selected", local);
    const toolkit = createAgentToolkit(stack, { driver: {} as RuntimeDriver });
    try {
        const { window_id } = await toolkit.handlers.observe_stream({ command: "echo SELECTED", layer: "selected" });
        const result = await toolkit.handlers.read_stream({ window_id, since_seq: 0, wait_ms: 8000 });
        expect(result.frames.map((frame) => frame.text)).toEqual(["SELECTED"]);
        await toolkit.handlers.close_stream({ window_id });
        await expect(toolkit.handlers.read_stream({ window_id })).rejects.toThrow(/已关闭/);
        await stack.removeLayer("selected");
        await stack.addLayer("unsupported", { descriptor: { driver: "mock" }, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as unknown as RuntimeDriver);
        await expect(toolkit.handlers.observe_stream({ command: "echo WRONG", layer: "unsupported" })).rejects.toThrow(/不支持持续观察窗/);
    } finally {
        toolkit.dispose?.();
    }
}, 15000);
