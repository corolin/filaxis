import { describe, expect, test } from "bun:test";
import { RuntimeStack } from "../src/middle/runtime-stack.js";
import { createAgentToolkit } from "../src/interface/mcp/agent-toolkit.js";
import { enterStepsOf } from "../src/core/ssh/ssh-helpers.js";
import type { RuntimeDriver, RuntimeDescriptor } from "../src/core/base/driver.js";

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

    test("connect_layer batch excludes layers replaced before the response", async () => {
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
        const batch = createAgentToolkit(stack).handlers.connect_layer({ targets: ["first", "slow"] });
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
        const names = tk.tools.map((t) => t.function.name);
        expect(names).toEqual([
            "run_batch", // 置顶（高杠杆批处理工具必须在首屏）
            "run_command", "start_session", "stop_session",
            "observe_stream", "close_stream",
            "read_path", "edit_file", "manage_path", "transfer_file",
            "connect_layer", "manage_layers",
        ]);
        expect(names.every((n) => /^[a-z]+_[a-z]+$/.test(n))).toBe(true);
        const r = await tk.handlers.run_command({ command: "echo tk-out; exit 4" });
        expect(r.stdout.trim()).toBe("tk-out");
        expect(r.exit_code).toBe(4); // 非零不抛——数据
        expect(r.effective_user).toBeTruthy();
    }, 20_000);

    test("start_session 就绪握手（回溯竞态安全）+ stop_session 三态", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), { readyTimeoutMs: 10_000 });
        const h = await tk.handlers.start_session({
            command: "sleep 0.5; echo LISTENING-OK; sleep 30",
            ready_marker: "LISTENING-OK",
            error_pattern: "NEVER_MATCH",
            name: "tk",
        });
        expect(h.session_id).toContain("tk-");
        expect(h.note).toBe("ready");
        const s = await tk.handlers.stop_session({ session_id: h.session_id });
        // local 面三态皆合法（Astra 二轮 #2 后：TERM/KILL 后仍核实不到死亡=unknown 诚实返回，
        // Windows 下 bash 子进程树收 TERM 偶有不退净——不再伪报 stopped）
        expect(["exited", "stopped", "unknown"]).toContain(s.status);
    }, 30_000);

    // GPT Astra #3：旧形态 driver 返回 {exitCode: null}（终止已发、无死亡证明——
    // tmux 后端 stop 后 .code 未落盘正是此形态）——必须报 unknown，不得报 stopped
    test("stop_session：无 status 且 exitCode null → unknown（无死亡证明不伪 stopped）", async () => {
        const fakeOldDriver = {
            descriptor: { driver: "tmux", target: "mock" },
            async stopSession() { return { exitCode: null }; }, // 旧形态：发了 kill，没核实
        } as unknown as import("../src/core/base/driver.js").RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: fakeOldDriver });
        const r = await tk.handlers.stop_session({ session_id: "s", layer: "__initial__" });
        expect(r.status).toBe("unknown"); // 修前：stopped（违宪——终止≠已核实）
        expect(r.note).toContain("stop_session"); // unknown 后自动接 verify（双通道不可达才保持）
    }, 15_000);

    test("stop_session validates the handle and needs an exit code before reporting exited", async () => {
        let stopCalls = 0;
        const driver = {
            async stopSession() { stopCalls++; return { status: "exited", exitCode: null }; },
            async verifySession() { return { status: "exited", exitCode: null }; },
        } as unknown as RuntimeDriver;
        const { handlers } = createAgentToolkit(new RuntimeStack(), { driver });
        await expect(handlers.stop_session({ session_id: "", layer: "__initial__" })).rejects.toThrow(/完整的非空会话 ID/);
        await expect(handlers.stop_session({ session_id: "fixture", layer: "" })).rejects.toThrow(/非空层名/);
        expect(stopCalls).toBe(0);
        expect(await handlers.stop_session({ session_id: "fixture", layer: "__initial__" })).toMatchObject({
            status: "unknown", note: expect.stringContaining("再次调用 stop_session"),
        });
        expect(stopCalls).toBe(1);
    });

    // GPT Astra 二轮 #3：spawn 在远端层的会话曾固定回初始层停（停错层必然失败）——
    // 修后按归属层（spawn 时的 driver）停止
    test("stop_session：跨层会话按归属层停止（不落初始层）", async () => {
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
        const h = await tk.handlers.start_session({ command: "srv", ready_marker: "READY" });
        // spawn 落默认层（remote——最近注册）——stop 必须回 remote 停
        const s = await tk.handlers.stop_session({ session_id: h.session_id });
        expect(s.status).toBe("stopped");
        expect(remoteStopped).toContain(h.session_id); // 归属层停了
        expect(initStopped).toEqual([]); // 初始层没被误用（修前：停错层报不存在）
        await stack.removeLayer("remote");
    }, 15_000);

    // GPT Astra 三轮 #1：unknown 终态**保留归属**（修前停止前就删——重试核实回退初始层停错层）
    test("stop_session：unknown 后重试仍找归属层；终态确定才清归属", async () => {
        const stack = new RuntimeStack();
        const calls: string[] = [];
        let stopResult: { status: string; exitCode?: number } = { status: "unknown" };
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
        await tk.handlers.start_session({ command: "c", ready_marker: "R" });
        // 第一次：unknown → 归属必须保留
        const r1 = await tk.handlers.stop_session({ session_id: "rs-own" });
        expect(r1.status).toBe("unknown");
        // 重试（网络恢复后再核实）：仍走归属层，不落初始层
        stopResult = { status: "exited", exitCode: 0 };
        const r2 = await tk.handlers.stop_session({ session_id: "rs-own" });
        expect(r2).toEqual({ status: "exited", exit_code: 0 });
        expect(calls).toEqual(["remote:rs-own", "remote:rs-own"]); // 两次都在归属层（修前第二次落 init）
        await stack.removeLayer("r2");
    }, 15_000);

    // GPT Astra 四轮 #1：旧形态 {exitCode:null}（status undefined）归一为 unknown——
    // 归属必须保留（修前 status!=="unknown" 判断把 undefined 当确定终态→删归属→重试落初始层）
    test("stop_session：旧形态无死亡证明归一 unknown 且保留归属（重试仍找归属层）", async () => {
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
        await tk.handlers.start_session({ command: "c", ready_marker: "R" });
        const r1 = await tk.handlers.stop_session({ session_id: "old-s" });
        expect(r1.status).toBe("unknown"); // 归一：无死亡证明
        // 重试：仍走归属层
        stopResult = { status: "exited", exitCode: 0 };
        const r2 = await tk.handlers.stop_session({ session_id: "old-s" });
        expect(r2.status).toBe("exited");
        expect(calls).toEqual(["remote:old-s", "remote:old-s"]); // 修前第二次 init:old-s
        await stack.removeLayer("old");
    }, 15_000);
});

describe("toolkit 层族（第十季命名层注册表）", () => {
    test("connect_layer/manage_layers + layer 参数寻址 + 无层族时零破坏", async () => {
        const stack = new RuntimeStack();
        stack.registerDriver("mockssh", (d) => new MockSshDriver(d) as unknown as RuntimeDriver);
        const tk = createAgentToolkit(stack, {});
        // 零破坏：未用层族——run_command 落初始 local 层（旧行为）
        const r0 = await tk.handlers.run_command({ command: "echo OLD_PATH" });
        expect(r0.stdout).toContain("OLD_PATH");
        // connect_layer(enter_cmd) 无源层报错
        await expect(tk.handlers.connect_layer({ enter_cmd: "docker exec -i web sh" })).rejects.toThrow(/无源层/);
        // 注册 mock 层（driver 形态）→ 成默认层 → 工具自动落它
        const m = new MockSshDriver({ driver: "mockssh", target: "h1" });
        await m.init();
        await stack.addLayer("host1", m as unknown as RuntimeDriver);
        const r1 = await tk.handlers.run_command({ command: "anything" });
        expect(r1.stdout).toContain("mock:"); // 落 mock 层而非 local
        // connect_layer(enter_cmd) 从默认层派生
        const p = await tk.handlers.connect_layer({ enter_cmd: "docker exec -i web sh", label: "docker:web" });
        expect(p.layer).toBe("docker:web");
        expect(enterStepsOf(stack.layer("docker:web").descriptor.config as Record<string, unknown>).length).toBe(1);
        // 参数别名宽收（第十二季）：enterCommand 手滑等价——派生自当前默认层 docker:web，
        // enter 管线全量继承追加（web→db 两步，继承语义）
        const p2 = await tk.handlers.connect_layer({ enterCommand: "docker exec -i db sh" });
        expect(p2.layer).toBe("docker exec -i db sh".slice(0, 30));
        expect(enterStepsOf(stack.layer("docker exec -i db sh".slice(0, 30)).descriptor.config as Record<string, unknown>).length).toBe(2);
        // layer 显式寻址（跨层）
        const r2 = await tk.handlers.run_command({ command: "x", layer: "host1" });
        expect(r2.stdout).toContain("mock:");
        // manage_layers list / activate / remove（host1 + docker:web + db 派生层 = 3 层）
        const ls = await tk.handlers.manage_layers({ action: "list" });
        expect(ls.text).toContain("host1");
        expect(ls.text).toContain("docker:web");
        expect(ls.layers.length).toBe(3);
        expect(await tk.handlers.manage_layers({ action: "activate", name: "host1" })).toEqual({
            action: "activate", active_layer: "host1",
        });
        expect((await tk.handlers.run_command({ command: "x" })).stdout).toContain("mock:");
        await tk.handlers.manage_layers({ action: "remove", name: "docker:web" });
        expect((await tk.handlers.manage_layers({ action: "list" })).layers.length).toBe(2);
        await tk.handlers.manage_layers({ action: "remove", name: "docker exec -i db sh".slice(0, 30) });
        RuntimeStack.evictDriver({ driver: "mockssh", target: "h1" } as RuntimeDescriptor);
    }, 20_000);
});

// GPT Astra 三十四期 P1：ready 超时谎称「已自动停止」——unknown 须诚实 + 会话线索 + verify
describe("start_session ready 超时三态（三十四期）", () => {
    const mkDrv = (stopStatus: string | Error, verify?: { status: string; exitCode?: number | null }) => ({
        descriptor: { driver: "local" },
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        init: async () => undefined,
        destroy: async () => undefined,
        execSession: async () => ({ sessionId: "fx-rd-timeout", logBase: "/tmp/fx-rd", pid: 123 }),
        tailSession: async () => ["no-marker-yet"],
        stopSession: async () => stopStatus instanceof Error ? Promise.reject(stopStatus) : { status: stopStatus, exitCode: null },
        verifySession: async () => verify ?? { status: "unknown" },
    }) as unknown as import("../src/core/base/driver.js").RuntimeDriver;

    test("stop unknown + verify unknown → outcome:unknown + 会话线索（不再谎称已停）", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), { driver: mkDrv("unknown"), readyTimeoutMs: 150 });
        let caught: (Error & { outcome?: string; sessionId?: string; logBase?: string }) | undefined;
        try { await tk.handlers.start_session({ command: "x", ready_marker: "READY" }); } catch (e) { caught = e as never; }
        expect(caught?.message).not.toContain("已自动停止"); // 修前：谎称
        expect(caught?.message).toContain("可能仍在运行");    // 诚实警告
        expect(caught?.outcome).toBe("unknown");
        expect(caught?.sessionId).toBe("fx-rd-timeout");     // 核实线索
        expect(caught?.logBase).toBe("/tmp/fx-rd");
    }, 15_000);

    test("stop unknown + verify exited → 采纳真实退出码（stopped 语义）", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), { driver: mkDrv("unknown", { status: "exited", exitCode: 7 }), readyTimeoutMs: 150 });
        let caught: (Error & { outcome?: string }) | undefined;
        try { await tk.handlers.start_session({ command: "x", ready_marker: "READY" }); } catch (e) { caught = e as never; }
        expect(caught?.outcome).toBe("stopped");
        expect(caught?.message).toContain("exitCode=7");
    }, 15_000);

    test("stop stopped → 如实 stopped（无 verify 调用需求）", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), { driver: mkDrv("stopped"), readyTimeoutMs: 150 });
        let caught: (Error & { outcome?: string }) | undefined;
        try { await tk.handlers.start_session({ command: "x", ready_marker: "READY" }); } catch (e) { caught = e as never; }
        expect(caught?.outcome).toBe("stopped");
        expect(caught?.message).toContain("停止已核实");
    }, 15_000);

    test("stop 通道抛错 → unknown（会话线索保留）", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), { driver: mkDrv(new Error("channel dead")), readyTimeoutMs: 150 });
        let caught: (Error & { outcome?: string }) | undefined;
        try { await tk.handlers.start_session({ command: "x", ready_marker: "READY" }); } catch (e) { caught = e as never; }
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
        } as unknown as import("../src/core/base/driver.js").RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: drv });
        let caught: (Error & { outcome?: string; sessionId?: string; logBase?: string }) | undefined;
        try { await tk.handlers.start_session({ command: "x", ready_marker: "RDY", error_pattern: "ERR" }); } catch (e) { caught = e as never; }
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
        } as unknown as import("../src/core/base/driver.js").RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: drv, readyTimeoutMs: 10_000 });
        let caught: (Error & { outcome?: string; sessionId?: string }) | undefined;
        try { await tk.handlers.start_session({ command: "x", ready_marker: "RDY" }); } catch (e) { caught = e as never; }
        expect(caught?.outcome).toBe("unknown"); // verify 实测 running
        expect(caught?.message).toContain("实测仍在运行"); // 诚实警告
        expect(caught?.message).toContain("tail channel broke"); // 原因保留
        expect(caught?.sessionId).toBe("fx-tail-err");
    }, 15_000);

});

describe("CLI observe 冒烟（正常路径）", () => {
    test("observe 端到端：启动→挂流→tail 输出报告", async () => {
        const { execSync } = await import("node:child_process");
        const r = execSync('bun bin/filaxis.ts observe --duration 800 -- "echo SELF_AUDIT_OK"', { encoding: "utf-8", timeout: 15_000, windowsHide: true });
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
    const result = await toolkit.handlers.start_session({ command: "fixture", ready_marker: "READY" });
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
    await toolkit.handlers.start_session({ command: "fixture" });
    finished = true;
    await Bun.sleep(35);
    const stop = toolkit.handlers.stop_session;
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
    await toolkit.handlers.start_session({ command: "fixture" });
    await probed.promise;
    await Bun.sleep(10);
    expect(await toolkit.handlers.stop_session({ session_id: "external" })).toEqual({ status: "exited", exit_code: 4 });
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
    await toolkit.handlers.manage_layers({ action: "remove", name: "__initial__", destroy: true });
    expect((await toolkit.handlers.run_command({ command: "second" })).stdout).toBe("2");
    await toolkit.handlers.manage_layers({ action: "remove", name: "__initial__", destroy: true });
});

test("observe_stream opens with initial frames, supports incremental reads, and rejects unsupported layers", async () => {
    const stack = new RuntimeStack();
    const local = new (await import("../src/core/local/local-driver.js")).LocalRuntimeDriver();
    await stack.addLayer("selected", local);
    const toolkit = createAgentToolkit(stack, { driver: {} as RuntimeDriver });
    try {
        const opened = await toolkit.handlers.observe_stream({ command: "echo SELECTED", layer: "selected", wait_ms: 8000 });
        expect(opened.frames.map((frame) => frame.text)).toEqual(["SELECTED"]);
        expect(opened.last_delivered_seq).toBe(1);
        const followUp = await toolkit.handlers.observe_stream({ window_id: opened.window_id, since_seq: opened.last_delivered_seq });
        expect(followUp.frames).toEqual([]);
        await toolkit.handlers.close_stream({ window_id: opened.window_id });
        await expect(toolkit.handlers.observe_stream({ window_id: opened.window_id })).rejects.toThrow(/已关闭/);
        await expect(toolkit.handlers.observe_stream({ command: "echo X", window_id: "w" } as never)).rejects.toThrow(/不能同时传/);
        await expect(toolkit.handlers.observe_stream({} as never)).rejects.toThrow(/需传 command/);
        await expect(toolkit.handlers.observe_stream({ command: "echo X", since_seq: 0 } as never)).rejects.toThrow(/不支持 since_seq/);
        await expect(toolkit.handlers.observe_stream({ window_id: opened.window_id, stream: "stdout" } as never)).rejects.toThrow(/不支持.*stream/);
        await stack.removeLayer("selected");
        await stack.addLayer("unsupported", { descriptor: { driver: "mock" }, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as unknown as RuntimeDriver);
        await expect(toolkit.handlers.observe_stream({ command: "echo WRONG", layer: "unsupported" })).rejects.toThrow(/不支持持续观察窗/);
    } finally {
        toolkit.dispose?.();
    }
}, 15000);

describe("12-tool convergence coverage (read_path, edit_file write, manage_path, transfer_file, connect_layer, manage_layers)", () => {
    test("read_path falls back cleanly when custom driver stat omits isDirectory", async () => {
        const customDrv = {
            descriptor: { driver: "custom" },
            fs: {
                stat: async () => ({ size: 0, mtimeMs: 100 }),
                readFile: async (p: string) => {
                    if (p === "dir") throw new Error("EISDIR");
                    return "file-body";
                },
                readdir: async () => [{ name: "a.txt", isDirectory: false }],
            },
        } as unknown as RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: customDrv });
        expect(await tk.handlers.read_path({ path: "file" })).toEqual({
            path: "file", type: "file", content: "file-body", size: 0, mtime_ms: 100,
        });
        expect(await tk.handlers.read_path({ path: "dir" })).toEqual({
            path: "dir", type: "directory", entries: [{ name: "a.txt", isDirectory: false }],
        });
    });

    test("edit_file write mode supports empty files, create_dirs, overwrite guard, and rejects mixed/invalid params", async () => {
        const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = mkdtempSync(join(tmpdir(), "fx-edit-write-"));
        const stack = new RuntimeStack();
        const drv = new (await import("../src/core/local/local-driver.js")).LocalRuntimeDriver({ cwd: dir });
        await stack.addLayer("w", drv);
        const tk = createAgentToolkit(stack);
        try {
            expect(await tk.handlers.edit_file({ path: "empty.txt", content: "" })).toEqual({
                mode: "write", path: "empty.txt", created: true, bytes_after: 0,
            });
            expect(readFileSync(join(dir, "empty.txt"), "utf8")).toBe("");
            await expect(tk.handlers.edit_file({ path: "sub/a.txt", content: "v1" })).rejects.toThrow();
            expect(await tk.handlers.edit_file({ path: "sub/a.txt", content: "v1", create_dirs: true })).toEqual({
                mode: "write", path: "sub/a.txt", created: true, bytes_after: 2,
            });
            await expect(tk.handlers.edit_file({ path: "sub/a.txt", content: "v2" })).rejects.toThrow(/拒绝覆盖/);
            expect(await tk.handlers.edit_file({ path: "sub/a.txt", content: "v2", overwrite: true })).toEqual({
                mode: "write", path: "sub/a.txt", created: false, bytes_after: 2,
            });
            expect(readFileSync(join(dir, "sub/a.txt"), "utf8")).toBe("v2");
            await expect(tk.handlers.edit_file({ path: "sub/a.txt", content: "x", old: "v2", new: "v3" } as never)).rejects.toThrow(/互斥/);
            await expect(tk.handlers.edit_file({ path: "sub/a.txt", content: "x", write_mode: "auto" } as never)).rejects.toThrow(/未知参数/);
            await expect(tk.handlers.edit_file({ path: "sub/a.txt" } as never)).rejects.toThrow(/需传 old 和 new/);
        } finally {
            await stack.removeLayer("w", { destroy: true });
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("manage_path handles mkdir, move, and safe/recursive delete", async () => {
        const { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = mkdtempSync(join(tmpdir(), "fx-manage-path-"));
        const stack = new RuntimeStack();
        const drv = new (await import("../src/core/local/local-driver.js")).LocalRuntimeDriver({ cwd: dir });
        await stack.addLayer("fs", drv);
        const tk = createAgentToolkit(stack);
        try {
            await expect(tk.handlers.manage_path({ action: "mkdir", path: "a/b/c", parents: false })).rejects.toThrow();
            expect(await tk.handlers.manage_path({ action: "mkdir", path: "a/b/c" })).toEqual({
                action: "mkdir", path: "a/b/c", created: true,
            });
            writeFileSync(join(dir, "a/b/c/file.txt"), "hello");
            expect(await tk.handlers.manage_path({ action: "move", path: "a/b/c/file.txt", destination: "a/moved.txt" })).toEqual({
                action: "move", path: "a/b/c/file.txt", destination: "a/moved.txt", moved: true,
            });
            expect(existsSync(join(dir, "a/b/c/file.txt"))).toBe(false);
            expect(readFileSync(join(dir, "a/moved.txt"), "utf8")).toBe("hello");

            await expect(tk.handlers.manage_path({ action: "delete", path: "a" })).rejects.toThrow();
            const dangerousPaths = process.platform === "win32"
                ? ["/", "\\", ".", "..", "C:\\", "a/..", "a/."]
                : ["/", ".", "..", "a/..", "a/."];
            for (const dangerous of dangerousPaths) {
                await expect(tk.handlers.manage_path({ action: "delete", path: dangerous, recursive: true })).rejects.toThrow(/拒绝删除/);
            }
            expect(await tk.handlers.manage_path({ action: "delete", path: "a", recursive: true })).toEqual({
                action: "delete", path: "a", deleted: true, recursive: true,
            });
            expect(existsSync(join(dir, "a"))).toBe(false);

            await expect(tk.handlers.manage_path({ action: "mkdir", path: "x", recursive: true } as never)).rejects.toThrow(/未知参数/);
            await expect(tk.handlers.manage_path({ action: "move", path: "x", destination: "y", parents: true } as never)).rejects.toThrow(/未知参数/);
            await expect(tk.handlers.manage_path({ action: "nope", path: "x" } as never)).rejects.toThrow(/action 须为/);
        } finally {
            await stack.removeLayer("fs", { destroy: true });
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("transfer_file, connect_layer, and manage_layers validate mode-specific arguments", async () => {
        const tk = createAgentToolkit(new RuntimeStack());
        await expect(tk.handlers.transfer_file({ direction: "sync", local_path: "a", remote_path: "b" } as never)).rejects.toThrow(/direction/);
        await expect(tk.handlers.transfer_file({ direction: "get", local_path: "a", remote_path: "b", write_mode: "inplace" } as never)).rejects.toThrow(/不支持 write_mode/);
        await expect(tk.handlers.connect_layer({ enter_cmd: "sh", host: "web" } as never)).rejects.toThrow(/互斥/);
        await expect(tk.handlers.connect_layer({ host: "web", from: "base" } as never)).rejects.toThrow(/不支持 from 或 label/);
        await expect(tk.handlers.connect_layer({} as never)).rejects.toThrow(/需提供 host/);
        await expect(tk.handlers.manage_layers({ action: "list", name: "x" } as never)).rejects.toThrow(/未知参数/);
        await expect(tk.handlers.manage_layers({ action: "activate", name: "x", destroy: true } as never)).rejects.toThrow(/只接受 action 和 name/);
        await expect(tk.handlers.manage_layers({ action: "unknown" } as never)).rejects.toThrow(/action 须为/);
    });
});

describe("audit regression fixes (P1/P2/P3)", () => {
    test("[P1] recursive delete rejects equivalent parent/cwd paths and preserves workspace files", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { basename, join } = await import("node:path");
        const dir = mkdtempSync(join(tmpdir(), "fx-rm-guard-"));
        const stack = new RuntimeStack();
        const drv = new (await import("../src/core/local/local-driver.js")).LocalRuntimeDriver({ cwd: dir });
        await stack.addLayer("fs", drv);
        const tk = createAgentToolkit(stack);
        try {
            mkdirSync(join(dir, "subdir", "deep"), { recursive: true });
            writeFileSync(join(dir, "keep.txt"), "keep");
            writeFileSync(join(dir, "subdir", "nested.txt"), "nested");
            const cwdSelfRel = `../${basename(dir)}`;
            for (const p of ["subdir/..//", "subdir/..\\", "subdir/deep/../..//", "./", ".///", cwdSelfRel, dir]) {
                await expect(tk.handlers.manage_path({ action: "delete", path: p, recursive: true })).rejects.toThrow();
                await expect(drv.fs.rm(p, { recursive: true, force: false })).rejects.toThrow();
            }
            expect(existsSync(dir)).toBe(true);
            expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("keep");
            expect(readFileSync(join(dir, "subdir", "nested.txt"), "utf8")).toBe("nested");
        } finally {
            await stack.removeLayer("fs", { destroy: true });
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("[P1] concurrent edit_file default writes are atomic and never overwrite each other", async () => {
        const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = mkdtempSync(join(tmpdir(), "fx-excl-write-"));
        const stack = new RuntimeStack();
        const drv = new (await import("../src/core/local/local-driver.js")).LocalRuntimeDriver({ cwd: dir });
        await stack.addLayer("w", drv);
        const tk = createAgentToolkit(stack);
        try {
            const results = await Promise.allSettled([
                tk.handlers.edit_file({ path: "race.txt", content: "first-writer" }),
                tk.handlers.edit_file({ path: "race.txt", content: "second-writer" }),
            ]);
            const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ mode: "write"; path: string; created: boolean; bytes_after: number }> => r.status === "fulfilled");
            const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
            expect(fulfilled).toHaveLength(1);
            expect(fulfilled[0]!.value.created).toBe(true);
            expect(rejected).toHaveLength(1);
            expect(String(rejected[0]!.reason)).toContain("拒绝覆盖");
            const expected = fulfilled[0]!.value.bytes_after === 12 ? "first-writer" : "second-writer";
            expect(readFileSync(join(dir, "race.txt"), "utf8")).toBe(expected);
        } finally {
            await stack.removeLayer("w", { destroy: true });
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("[P1] move/rename rejects existing destination directories on local and SSH/tmux commands", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const { SshPtyDriver } = await import("../src/core/ssh/ssh-pty-driver.js");
        const { TmuxSessionDriver } = await import("../src/core/tmux/tmux-driver.js");
        const dir = mkdtempSync(join(tmpdir(), "fx-rename-guard-"));
        const stack = new RuntimeStack();
        const local = new LocalRuntimeDriver({ cwd: dir });
        await stack.addLayer("localfs", local);
        const tk = createAgentToolkit(stack);
        try {
            mkdirSync(join(dir, "destDir"));
            writeFileSync(join(dir, "src.txt"), "from-src");
            writeFileSync(join(dir, "destDir", "src.txt"), "existing-inside-dir");

            // Local driver via manage_path
            await expect(tk.handlers.manage_path({ action: "move", path: "src.txt", destination: "destDir" })).rejects.toThrow(/目录/);
            expect(readFileSync(join(dir, "src.txt"), "utf8")).toBe("from-src");
            expect(readFileSync(join(dir, "destDir", "src.txt"), "utf8")).toBe("existing-inside-dir");

            // SSH driver exact shell command executed in real POSIX shell (cwd = dir)
            const ssh = new SshPtyDriver({ driver: "ssh", target: "mock" });
            (ssh as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = (cmd: string) => local.exec(cmd);
            await expect(ssh.fs.rename!("src.txt", "destDir")).rejects.toThrow();
            expect(readFileSync(join(dir, "src.txt"), "utf8")).toBe("from-src");
            expect(readFileSync(join(dir, "destDir", "src.txt"), "utf8")).toBe("existing-inside-dir");

            // Tmux driver exact shell command executed in real POSIX shell (cwd = dir)
            const tmux = new TmuxSessionDriver({ driver: "tmux", target: "mock" });
            tmux.exec = (cmd: string) => local.exec(cmd);
            await expect(tmux.fs.rename!("src.txt", "destDir")).rejects.toThrow();
            expect(readFileSync(join(dir, "src.txt"), "utf8")).toBe("from-src");
            expect(readFileSync(join(dir, "destDir", "src.txt"), "utf8")).toBe("existing-inside-dir");

            // Exclusive write via SSH fs.writeFile refuses concurrent/existing overwrite
            await ssh.fs.writeFile("excl.txt", "first", { exclusive: true });
            await expect(ssh.fs.writeFile("excl.txt", "second", { exclusive: true })).rejects.toThrow();
            expect(readFileSync(join(dir, "excl.txt"), "utf8")).toBe("first");

            // Valid rename to non-existent file still works via SSH driver command
            await ssh.fs.rename!("src.txt", "renamed.txt");
            expect(readFileSync(join(dir, "renamed.txt"), "utf8")).toBe("from-src");

            // SSH recursive rm guard inside real POSIX shell
            const sub = join(dir, "sub");
            mkdirSync(sub);
            writeFileSync(join(dir, "keep.txt"), "keep");
            const { basename } = await import("node:path");
            await expect(ssh.fs.rm(`../${basename(dir)}`, { recursive: true })).rejects.toThrow();
            await expect(ssh.fs.rm("sub/..//", { recursive: true })).rejects.toThrow();
            expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("keep");
        } finally {
            await stack.removeLayer("localfs", { destroy: true });
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test("[P2] read_path lists directories on custom drivers without fs.stat", async () => {
        const noStatDriver = {
            descriptor: { driver: "nostat" },
            fs: {
                readdir: async () => [{ name: "only.txt", isDirectory: false }],
            },
        } as unknown as RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: noStatDriver });
        expect(await tk.handlers.read_path({ path: "/data" })).toEqual({
            path: "/data",
            type: "directory",
            entries: [{ name: "only.txt", isDirectory: false }],
        });
        const brokenDriver = {
            descriptor: { driver: "nostat-err" },
            fs: {
                readdir: async () => { throw new Error("permission denied"); },
            },
        } as unknown as RuntimeDriver;
        const tk2 = createAgentToolkit(new RuntimeStack(), { driver: brokenDriver });
        await expect(tk2.handlers.read_path({ path: "/secret" })).rejects.toThrow(/fs\.stat 缺席.*permission denied/);
    });

    test("[P3] connect_layer schema oneOf accepts all advertised enter_cmd aliases", async () => {
        const { TOOL_DEFS } = await import("../src/interface/mcp/agent-toolkit.js");
        const connectDef = TOOL_DEFS.find((d) => d.function.name === "connect_layer")!;
        const oneOf = connectDef.function.parameters.oneOf as Array<{
            additionalProperties?: boolean;
            properties: Record<string, unknown>;
            required: string[];
        }>;
        for (const alias of ["enter_cmd", "enter_command", "enterCommand", "enterCmd"]) {
            const matching = oneOf.filter((branch) =>
                branch.required.includes(alias)
                && branch.additionalProperties === false
                && Object.hasOwn(branch.properties, alias),
            );
            expect(matching).toHaveLength(1);
        }

        const stack = new RuntimeStack();
        const drv = new MockSshDriver({ driver: "mockssh", target: "h1" });
        await drv.init();
        await stack.addLayer("base", drv as unknown as RuntimeDriver);
        const tk = createAgentToolkit(stack);
        try {
            const r1 = await tk.handlers.connect_layer({ enter_command: "docker exec -i c1 sh", name: "c1" });
            expect(r1.layer).toBe("c1");
            const r2 = await tk.handlers.connect_layer({ enterCmd: "docker exec -i c2 sh", from: "base", name: "c2" });
            expect(r2.layer).toBe("c2");
            await expect(tk.handlers.connect_layer({ enter_cmd: "a", enterCommand: "b" } as never)).rejects.toThrow(/只能传一个/);
        } finally {
            await Promise.all([...stack.layers.keys()].map((n) => stack.removeLayer(n, { destroy: true })));
        }
    });

    test("[P1] exclusive upload refuses directory created after pre-check and reports partial write separately from EEXIST", async () => {
        const { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const { SshPtyDriver } = await import("../src/core/ssh/ssh-pty-driver.js");
        const dir = mkdtempSync(join(tmpdir(), "fx-excl-posix-"));
        const local = new LocalRuntimeDriver({ cwd: dir });
        const stagesCreated: string[] = [];
        const basePosixExec = (transform?: (cmd: string) => string) => async (cmd: string) => {
            const actual = transform ? transform(cmd) : cmd;
            const r = await local.exec(`uname() { echo Linux; }; ${actual}`);
            const m = r.stdout.trim().match(/^\/tmp\/filaxis-write\.[A-Za-z0-9]{10}$/);
            if (m) stagesCreated.push(m[0]!);
            return r;
        };
        try {
            // 1. Target becomes a directory right after pre-check: must fail with EEXIST and not link inside dir.
            const sshDirRace = new SshPtyDriver({ driver: "ssh", target: "mock" });
            let injectedDir = false;
            (sshDirRace as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = basePosixExec((cmd) => {
                if (cmd.includes("exec 3>") && !injectedDir) {
                    injectedDir = true;
                    return cmd.replace("FX_ALREADY_EXISTS; exit 1; fi;", "FX_ALREADY_EXISTS; exit 1; fi; mkdir -p 'race-dir.txt';");
                }
                return cmd;
            });
            await expect(sshDirRace.fs.createFile!("race-dir.txt", "should-not-enter-dir")).rejects.toMatchObject({
                code: "EEXIST",
            });
            expect(injectedDir).toBe(true);
            expect(readdirSync(join(dir, "race-dir.txt"))).toEqual([]);

            // 2. Write fails/interrupts after set -C creates target: must NOT report EEXIST and must preserve staged payload.
            const sshWriteFail = new SshPtyDriver({ driver: "ssh", target: "mock" });
            (sshWriteFail as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = basePosixExec((cmd) =>
                cmd.includes("exec 3>") ? `cat() { printf 'half'; return 1; }; ${cmd}` : cmd,
            );
            let caught: unknown;
            try {
                await sshWriteFail.fs.createFile!("partial.txt", "complete-payload");
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(Error);
            const errObj = caught as NodeJS.ErrnoException;
            expect(errObj.code).not.toBe("EEXIST");
            expect(errObj.message).toContain("独占写入失败");
            expect(errObj.message).not.toContain("文件已存在");
            expect(readFileSync(join(dir, "partial.txt"), "utf8")).toBe("half");
            const payloadMatch = errObj.message.match(/完整载荷保留在 (\S+)/);
            expect(payloadMatch).toBeTruthy();
            const verifyPayload = await local.exec(`test -f '${payloadMatch![1]!.replace(/'/g, "'\\''")}' && cat '${payloadMatch![1]!.replace(/'/g, "'\\''")}'`);
            expect(verifyPayload.exitCode).toBe(0);
            expect(verifyPayload.stdout).toBe("complete-payload");

            // 3. On POSIX platforms with mkfifo (Linux/WSL/macOS), FIFO created after pre-check is atomically rejected without writing to the pipe reader.
            if (process.platform !== "win32") {
                const sshFifoRace = new SshPtyDriver({ driver: "ssh", target: "mock" });
                let injectedFifo = false;
                (sshFifoRace as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = basePosixExec((cmd) => {
                    if (cmd.includes("ln -T --") && !injectedFifo) {
                        injectedFifo = true;
                        return cmd.replace(
                            "FX_ALREADY_EXISTS; exit 1; fi;",
                            "FX_ALREADY_EXISTS; exit 1; fi; mkfifo 'race-fifo' && { cat 'race-fifo' > 'fifo-captured.txt' </dev/null 2>/dev/null & printf '%s' \"$!\" > 'fifo-reader.pid'; }; sleep 0.05;",
                        );
                    }
                    return cmd;
                });
                await expect(sshFifoRace.fs.createFile!("race-fifo", "never-sent-to-fifo")).rejects.toMatchObject({
                    code: "EEXIST",
                });
                expect(injectedFifo).toBe(true);
                const fifoOut = await local.exec(
                    "test -p 'race-fifo' && echo FIFO_OK; " +
                    ": > 'race-fifo' 2>/dev/null || true; " +
                    "kill \"$(cat 'fifo-reader.pid' 2>/dev/null)\" 2>/dev/null || true; " +
                    "cat 'fifo-captured.txt' 2>/dev/null || true",
                );
                expect(fifoOut.stdout).toContain("FIFO_OK");
                expect(fifoOut.stdout).not.toContain("never-sent-to-fifo");
            }
        } finally {
            for (const s of stagesCreated) {
                await local.exec(`rm -rf '${s}'`).catch(() => undefined);
            }
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test("[P1] edit_file default write requires explicit fs.createFile and rejects 2-arg writeFile drivers", async () => {
        const files = new Map<string, string>();
        let writeCalls = 0;
        const legacyCustomDriver = {
            descriptor: { driver: "custom-2arg" },
            fs: {
                exists: async (p: string) => files.has(p),
                writeFile: async (p: string, c: string) => {
                    writeCalls++;
                    files.set(p, c);
                },
            },
        } as unknown as RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: legacyCustomDriver });
        await expect(tk.handlers.edit_file({ path: "doc.txt", content: "first" })).rejects.toThrow(/fs\.createFile 缺席/);
        expect(writeCalls).toBe(0);
        expect(await tk.handlers.edit_file({ path: "doc.txt", content: "forced", overwrite: true })).toEqual({
            mode: "write", path: "doc.txt", created: true, bytes_after: 6,
        });
        expect(files.get("doc.txt")).toBe("forced");

        const atomicDriver = {
            descriptor: { driver: "custom-excl" },
            fs: {
                exists: async (p: string) => files.has(p),
                writeFile: async (p: string, c: string) => { files.set(p, c); },
                createFile: async (p: string, c: string) => {
                    if (files.has(p)) throw Object.assign(new Error(`文件已存在: ${p}`), { code: "EEXIST" });
                    files.set(p, c);
                },
            },
        } as unknown as RuntimeDriver;
        const tkAtomic = createAgentToolkit(new RuntimeStack(), { driver: atomicDriver });
        expect(await tkAtomic.handlers.edit_file({ path: "fresh.txt", content: "created" })).toEqual({
            mode: "write", path: "fresh.txt", created: true, bytes_after: 7,
        });
        await expect(tkAtomic.handlers.edit_file({ path: "fresh.txt", content: "second" })).rejects.toThrow(/拒绝覆盖/);
        expect(files.get("fresh.txt")).toBe("created");
    });

    test("[P2] read_path lists directories when fs.stat is defined but returns null (missing remote stat)", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const { SshPtyDriver } = await import("../src/core/ssh/ssh-pty-driver.js");
        const dir = mkdtempSync(join(tmpdir(), "fx-nostat-ssh-"));
        const local = new LocalRuntimeDriver({ cwd: dir });
        const ssh = new SshPtyDriver({ driver: "ssh", target: "mock" });
        (ssh as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = (cmd: string) =>
            local.exec(`stat() { return 127; }; ${cmd}`);
        const stack = new RuntimeStack();
        await stack.addLayer("nostatssh", ssh);
        const tk = createAgentToolkit(stack);
        try {
            mkdirSync(join(dir, "sub"));
            writeFileSync(join(dir, "hello.txt"), "hi");
            expect(await ssh.fs.stat!(".")).toBeNull();
            const res = await tk.handlers.read_path({ path: "." });
            expect(res.type).toBe("directory");
            if (res.type === "directory") {
                expect(res.entries.map((e) => e.name).sort()).toEqual(["hello.txt", "sub"]);
            }
            await expect(tk.handlers.read_path({ path: "missing-dir" })).rejects.toThrow(/路径不存在/);
        } finally {
            await stack.removeLayer("nostatssh", { destroy: true });
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test("[P1] local recursive rm resolves symlink/../ paths via filesystem semantics and keeps workspace data", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const root = mkdtempSync(join(tmpdir(), "fx-local-symlink-rm-"));
        const ws = join(root, "ws");
        const outside = join(root, "outside");
        const outsideSub = join(outside, "sub");
        const outsideData = join(outside, "data");
        const wsData = join(ws, "data");
        mkdirSync(wsData, { recursive: true });
        mkdirSync(outsideSub, { recursive: true });
        mkdirSync(outsideData, { recursive: true });
        writeFileSync(join(wsData, "keep.txt"), "ws-intact");
        writeFileSync(join(outsideData, "victim.txt"), "outside-data");
        symlinkSync(outsideSub, join(ws, "link"), process.platform === "win32" ? "junction" : "dir");
        const wsDeep = join(ws, "deep");
        mkdirSync(wsDeep, { recursive: true });
        symlinkSync(root, join(ws, "to-root"), process.platform === "win32" ? "junction" : "dir");

        const local = new LocalRuntimeDriver({ cwd: ws });
        try {
            await local.fs.rm("link/../data", { recursive: true, force: false });
            if (process.platform === "win32") {
                // Win32 RtlDosPathNameToNtPathName collapses ".." before junctions in the OS itself.
                expect(existsSync(wsData)).toBe(false);
                expect(readFileSync(join(outsideData, "victim.txt"), "utf8")).toBe("outside-data");
                mkdirSync(wsData, { recursive: true });
                writeFileSync(join(wsData, "keep.txt"), "ws-intact");
            } else {
                // POSIX VFS resolves symlinks left-to-right before applying "..".
                expect(existsSync(outsideData)).toBe(false);
                expect(readFileSync(join(wsData, "keep.txt"), "utf8")).toBe("ws-intact");
            }

            // Symlink path resolving back to workspace root must be refused.
            await expect(local.fs.rm("to-root/ws", { recursive: true, force: false })).rejects.toThrow(/拒绝删除工作目录/);
            await expect(local.fs.rm("deep/../to-root/ws", { recursive: true, force: false })).rejects.toThrow(/拒绝删除工作目录/);
            if (process.platform !== "win32") {
                const subAB = join(ws, "a", "b");
                mkdirSync(subAB, { recursive: true });
                symlinkSync(subAB, join(ws, "link-to-sub"), "dir");
                // Lexically folds to dirname(root)/ws, but OS resolves through ws/a/b/../../../ws === ws.
                await expect(local.fs.rm("link-to-sub/../../../ws", { recursive: true, force: false })).rejects.toThrow(/拒绝删除工作目录/);
            }
            expect(readFileSync(join(wsData, "keep.txt"), "utf8")).toBe("ws-intact");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("[P1] SSH and tmux recursive rm guard ignores inherited CDPATH and protects workspace", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const { SshPtyDriver } = await import("../src/core/ssh/ssh-pty-driver.js");
        const { TmuxSessionDriver } = await import("../src/core/tmux/tmux-driver.js");
        const root = mkdtempSync(join(tmpdir(), "fx-rm-cdpath-"));
        const decoyBase = join(root, "decoy-cdpath");
        const decoyTarget = join(decoyBase, "subdir");
        const work = join(root, "work");
        const workSub = join(work, "subdir");
        mkdirSync(decoyTarget, { recursive: true });
        mkdirSync(workSub, { recursive: true });
        writeFileSync(join(work, "keep.txt"), "must-survive");
        const local = new LocalRuntimeDriver({ cwd: work });
        const cdpathExec = (cmd: string) => local.exec(`CDPATH="../decoy-cdpath"; export CDPATH; ${cmd}`);
        try {
            const ssh = new SshPtyDriver({ driver: "ssh", target: "mock" });
            (ssh as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = cdpathExec;
            await expect(ssh.fs.rm("subdir/../../work", { recursive: true })).rejects.toThrow();
            expect(readFileSync(join(work, "keep.txt"), "utf8")).toBe("must-survive");

            const tmux = new TmuxSessionDriver({ driver: "tmux", target: "mock" });
            tmux.exec = cdpathExec;
            await expect(tmux.fs.rm("subdir/../../work", { recursive: true })).rejects.toThrow();
            expect(readFileSync(join(work, "keep.txt"), "utf8")).toBe("must-survive");

            // Legitimate subdirectory delete operates in cwd, never in CDPATH decoy.
            await ssh.fs.rm("subdir", { recursive: true });
            expect(existsSync(workSub)).toBe(false);
            expect(existsSync(decoyTarget)).toBe(true);
            expect(readFileSync(join(work, "keep.txt"), "utf8")).toBe("must-survive");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("[P1] local rename preserves symlink/../ resolution semantics for source and destination", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const root = mkdtempSync(join(tmpdir(), "fx-local-symlink-mv-"));
        const ws = join(root, "ws");
        const outside = join(root, "outside");
        const outsideSub = join(outside, "sub");
        const outsideData = join(outside, "data");
        const wsData = join(ws, "data");
        mkdirSync(wsData, { recursive: true });
        mkdirSync(outsideSub, { recursive: true });
        mkdirSync(outsideData, { recursive: true });
        writeFileSync(join(wsData, "source.txt"), "ws-source");
        writeFileSync(join(outsideData, "source.txt"), "outside-source");
        symlinkSync(outsideSub, join(ws, "link"), process.platform === "win32" ? "junction" : "dir");
        symlinkSync(outsideData, join(ws, "to-outside-data"), process.platform === "win32" ? "junction" : "dir");

        const local = new LocalRuntimeDriver({ cwd: ws });
        try {
            // Symlink without post-symlink ".." behaves uniformly across OSes.
            await local.fs.rename!("to-outside-data/source.txt", "to-outside-data/moved.txt");
            expect(readFileSync(join(outsideData, "moved.txt"), "utf8")).toBe("outside-source");
            expect(readFileSync(join(wsData, "source.txt"), "utf8")).toBe("ws-source");

            // Symlink followed by ".." follows OS filesystem semantics (POSIX dereferences link first; Win32 folds before junction).
            await local.fs.rename!("link/../data/moved.txt", "link/../data/moved2.txt").catch(async () => {
                await local.fs.rename!("link/../data/source.txt", "link/../data/moved2.txt");
            });
            if (process.platform === "win32") {
                expect(readFileSync(join(wsData, "moved2.txt"), "utf8")).toBe("ws-source");
                expect(existsSync(join(wsData, "source.txt"))).toBe(false);
                expect(readFileSync(join(outsideData, "moved.txt"), "utf8")).toBe("outside-source");
            } else {
                expect(readFileSync(join(outsideData, "moved2.txt"), "utf8")).toBe("outside-source");
                expect(existsSync(join(outsideData, "moved.txt"))).toBe(false);
                expect(readFileSync(join(wsData, "source.txt"), "utf8")).toBe("ws-source");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("[P1] SSH and tmux recursive rm guard rejects parent or cwd names ending with newlines", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const { SshPtyDriver } = await import("../src/core/ssh/ssh-pty-driver.js");
        const { TmuxSessionDriver } = await import("../src/core/tmux/tmux-driver.js");
        const root = mkdtempSync(join(tmpdir(), "fx-rm-newline-"));
        try {
            if (process.platform !== "win32") {
                const parentNl = join(root, "parent\n");
                const work = join(parentNl, "work");
                mkdirSync(join(work, "sub"), { recursive: true });
                writeFileSync(join(work, "keep.txt"), "keep-newline-parent");
                const localWork = new LocalRuntimeDriver({ cwd: work });
                const ssh = new SshPtyDriver({ driver: "ssh", target: "mock" });
                (ssh as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = (cmd: string) => localWork.exec(cmd);
                await expect(ssh.fs.rm("../parent\n", { recursive: true })).rejects.toThrow();
                const tmux = new TmuxSessionDriver({ driver: "tmux", target: "mock" });
                tmux.exec = (cmd: string) => localWork.exec(cmd);
                await expect(tmux.fs.rm("sub/../../parent\n", { recursive: true })).rejects.toThrow();
                expect(readFileSync(join(work, "keep.txt"), "utf8")).toBe("keep-newline-parent");
            } else {
                const { basename } = await import("node:path");
                const work = join(root, "work");
                mkdirSync(work, { recursive: true });
                writeFileSync(join(work, "keep.txt"), "win-intact");
                const localWork = new LocalRuntimeDriver({ cwd: work });
                const ssh = new SshPtyDriver({ driver: "ssh", target: "mock" });
                (ssh as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = (cmd: string) => localWork.exec(cmd);
                await expect(ssh.fs.rm(`../${basename(work)}`, { recursive: true })).rejects.toThrow(/当前工作目录或上级目录/);
                const tmux = new TmuxSessionDriver({ driver: "tmux", target: "mock" });
                tmux.exec = (cmd: string) => localWork.exec(cmd);
                await expect(tmux.fs.rm(`../${basename(work)}`, { recursive: true })).rejects.toThrow(/rm 失败/);
                expect(readFileSync(join(work, "keep.txt"), "utf8")).toBe("win-intact");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);

    test("[P2] SSH and tmux directory rename succeeds even if another process immediately recreates source path", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const { SshPtyDriver } = await import("../src/core/ssh/ssh-pty-driver.js");
        const { TmuxSessionDriver } = await import("../src/core/tmux/tmux-driver.js");
        const dir = mkdtempSync(join(tmpdir(), "fx-mv-recreate-src-"));
        const local = new LocalRuntimeDriver({ cwd: dir });
        const recreateAfterMv = (cmd: string) => local.exec(
            `mv() { ` +
            `command mv "$@"; __rc=$?; ` +
            `if [ "$__rc" -eq 0 ]; then mkdir -p 'srcDir' && printf 'recreated' > 'srcDir/fresh.txt'; fi; ` +
            `return "$__rc"; ` +
            `}; ${cmd}`,
        );
        try {
            mkdirSync(join(dir, "srcDir"));
            writeFileSync(join(dir, "srcDir", "orig.txt"), "moved-payload");
            const ssh = new SshPtyDriver({ driver: "ssh", target: "mock" });
            (ssh as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = recreateAfterMv;
            await ssh.fs.rename!("srcDir", "destDir1");
            expect(readFileSync(join(dir, "destDir1", "orig.txt"), "utf8")).toBe("moved-payload");
            expect(readFileSync(join(dir, "srcDir", "fresh.txt"), "utf8")).toBe("recreated");

            rmSync(join(dir, "srcDir"), { recursive: true, force: true });
            mkdirSync(join(dir, "srcDir"));
            writeFileSync(join(dir, "srcDir", "orig.txt"), "tmux-payload");
            const tmux = new TmuxSessionDriver({ driver: "tmux", target: "mock" });
            tmux.exec = recreateAfterMv;
            await tmux.fs.rename!("srcDir", "destDir2");
            expect(readFileSync(join(dir, "destDir2", "orig.txt"), "utf8")).toBe("tmux-payload");
            expect(readFileSync(join(dir, "srcDir", "fresh.txt"), "utf8")).toBe("recreated");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test("[P1] trailing backslash on POSIX is preserved as literal filename char and trailing slash rejects regular files", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const dir = mkdtempSync(join(tmpdir(), "fx-trail-sep-"));
        const stack = new RuntimeStack();
        const drv = new LocalRuntimeDriver({ cwd: dir });
        await stack.addLayer("sep", drv);
        const tk = createAgentToolkit(stack);
        try {
            writeFileSync(join(dir, "regular.txt"), "keep-regular");
            await expect(drv.fs.rm("regular.txt/", { recursive: true })).rejects.toThrow(/不是.*目录/);
            await expect(drv.fs.rm("regular.txt/", { recursive: true, force: true })).rejects.toThrow(/不是.*目录/);
            expect(readFileSync(join(dir, "regular.txt"), "utf8")).toBe("keep-regular");

            if (process.platform !== "win32") {
                mkdirSync(join(dir, "plain"), { recursive: true });
                writeFileSync(join(dir, "plain", "keep.txt"), "keep-plain");
                mkdirSync(join(dir, "plain\\"), { recursive: true });
                writeFileSync(join(dir, "plain\\", "victim.txt"), "backslash-dir");
                await tk.handlers.manage_path({ action: "delete", path: "plain\\", recursive: true });
                expect(existsSync(join(dir, "plain\\"))).toBe(false);
                expect(readFileSync(join(dir, "plain", "keep.txt"), "utf8")).toBe("keep-plain");

                writeFileSync(join(dir, "file\\"), "bs-file");
                await tk.handlers.manage_path({ action: "delete", path: "file\\", recursive: false });
                expect(existsSync(join(dir, "file\\"))).toBe(false);
            }
        } finally {
            await stack.removeLayer("sep", { destroy: true });
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("[P1][P2] local, SSH, and tmux rename refuse cross-filesystem moves upfront without clobbering external dirs", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const { SshPtyDriver } = await import("../src/core/ssh/ssh-pty-driver.js");
        const { TmuxSessionDriver } = await import("../src/core/tmux/tmux-driver.js");
        const dir = mkdtempSync(join(tmpdir(), "fx-xdev-mv-"));
        const local = new LocalRuntimeDriver({ cwd: dir });
        let mvCalled = 0;
        const xdevExec = async (cmd: string) => {
            const wrapped = `python3() { return 127; }; stat() { ` +
                `case "$*" in ` +
                `*"-c %d"*"srcDir"*|*"-c '%d'"*"srcDir"*|*"srcDir"*) ` +
                `if [ "$1" = "-c" ] && [ "$2" = "%d" ]; then echo 1001; return 0; fi ;; ` +
                `esac; ` +
                `if [ "$1" = "-Lc" ] && [ "$2" = "%d" ]; then echo 2002; return 0; fi; ` +
                `command stat "$@"; ` +
                `}; mv() { echo "MV_SHOULD_NOT_RUN" >&2; return 99; }; ${cmd}`;
            const r = await local.exec(wrapped);
            if (r.stderr.includes("MV_SHOULD_NOT_RUN")) mvCalled++;
            return r;
        };
        try {
            mkdirSync(join(dir, "srcDir"));
            writeFileSync(join(dir, "srcDir", "item.txt"), "stay-intact");

            const ssh = new SshPtyDriver({ driver: "ssh", target: "mock" });
            (ssh as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = xdevExec;
            await expect(ssh.fs.rename!("srcDir", "destXdev")).rejects.toThrow(/EXDEV/);

            const tmux = new TmuxSessionDriver({ driver: "tmux", target: "mock" });
            tmux.exec = xdevExec;
            await expect(tmux.fs.rename!("srcDir", "destXdev")).rejects.toThrow(/rename 失败/);

            expect(mvCalled).toBe(0);
            expect(existsSync(join(dir, "destXdev"))).toBe(false);
            expect(readFileSync(join(dir, "srcDir", "item.txt"), "utf8")).toBe("stay-intact");

            if (process.platform === "linux" && existsSync("/dev/shm")) {
                const tmpDev = statSync(tmpdir()).dev;
                const shmDev = statSync("/dev/shm").dev;
                if (tmpDev !== shmDev) {
                    const shmDest = join("/dev/shm", `fx-xdev-${Date.now()}-${Math.random().toString(16).slice(2)}`);
                    const shmNew = `${shmDest}-new`;
                    mkdirSync(shmDest);
                    try {
                        await expect(local.fs.rename!("srcDir", shmDest)).rejects.toThrow(/EXDEV|现存目录/);
                        await expect(local.fs.rename!("srcDir", shmNew)).rejects.toThrow(/EXDEV/);
                        const sshReal = new SshPtyDriver({ driver: "ssh", target: "mock" });
                        (sshReal as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = (cmd: string) => local.exec(cmd);
                        await expect(sshReal.fs.rename!("srcDir", shmNew)).rejects.toThrow(/EXDEV/);
                        const tmuxReal = new TmuxSessionDriver({ driver: "tmux", target: "mock" });
                        tmuxReal.exec = (cmd: string) => local.exec(cmd);
                        await expect(tmuxReal.fs.rename!("srcDir", shmNew)).rejects.toThrow(/rename 失败/);
                        expect(existsSync(shmDest)).toBe(true);
                        expect(existsSync(shmNew)).toBe(false);
                        expect(readFileSync(join(dir, "srcDir", "item.txt"), "utf8")).toBe("stay-intact");
                    } finally {
                        rmSync(shmDest, { recursive: true, force: true });
                        rmSync(shmNew, { recursive: true, force: true });
                    }
                }
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test("[P2] default local driver without cwd refuses recursive rm on process.cwd() and its parents via absolute path", async () => {
        const { dirname } = await import("node:path");
        const { existsSync } = await import("node:fs");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const defaultLocal = new LocalRuntimeDriver();
        const tk = createAgentToolkit(new RuntimeStack(), { driver: defaultLocal });
        const selfCwd = process.cwd();
        const parentCwd = dirname(selfCwd);
        await expect(defaultLocal.fs.rm(selfCwd, { recursive: true })).rejects.toThrow(/拒绝删除工作目录或上级目录/);
        await expect(defaultLocal.fs.rm(parentCwd, { recursive: true })).rejects.toThrow(/拒绝删除工作目录或上级目录/);
        await expect(tk.handlers.manage_path({ action: "delete", path: selfCwd, recursive: true })).rejects.toThrow(/拒绝删除工作目录或上级目录/);
        expect(existsSync(selfCwd)).toBe(true);
    });

    test("[P1] local exec and fs tools operate in the same OS-resolved cwd when configured cwd has symlink/..", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, realpathSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join, sep } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const root = mkdtempSync(join(tmpdir(), "fx-cwd-sym-"));
        const ws = join(root, "ws");
        const outside = join(root, "outside");
        const outsideSub = join(outside, "sub");
        const outsideData = join(outside, "data");
        const wsData = join(ws, "data");
        mkdirSync(join(wsData, "target"), { recursive: true });
        mkdirSync(outsideSub, { recursive: true });
        mkdirSync(join(outsideData, "target"), { recursive: true });
        writeFileSync(join(wsData, "marker.txt"), "ws-marker");
        writeFileSync(join(wsData, "target", "f.txt"), "ws-target");
        writeFileSync(join(outsideData, "marker.txt"), "outside-marker");
        writeFileSync(join(outsideData, "target", "f.txt"), "outside-target");
        symlinkSync(outsideSub, join(ws, "link"), process.platform === "win32" ? "junction" : "dir");

        const configuredCwd = `${ws}${sep}link${sep}..${sep}data`;
        const local = new LocalRuntimeDriver({ cwd: configuredCwd });
        try {
            const cmdMarker = (await local.exec("cat marker.txt")).stdout.trim();
            const fsMarker = (await local.fs.readFile("marker.txt")).trim();
            // File tool and exec command must observe the exact same marker and target directory.
            expect(fsMarker).toBe(cmdMarker);

            await local.fs.rm("target", { recursive: true });
            const expectedRemoved = process.platform === "win32" ? wsData : outsideData;
            const expectedPreserved = process.platform === "win32" ? outsideData : wsData;
            expect(existsSync(join(expectedRemoved, "target"))).toBe(false);
            if (process.platform !== "win32") {
                const cmdPwd = realpathSync((await local.exec("pwd -P")).stdout.trim());
                expect(cmdPwd).toBe(realpathSync(expectedRemoved));
            }
            expect(readFileSync(join(expectedPreserved, "target", "f.txt"), "utf8")).toBe(
                process.platform === "win32" ? "outside-target" : "ws-target",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("[P2] SSH and tmux rename refuse execution when remote stat cannot verify device IDs", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const { SshPtyDriver } = await import("../src/core/ssh/ssh-pty-driver.js");
        const { TmuxSessionDriver } = await import("../src/core/tmux/tmux-driver.js");
        const dir = mkdtempSync(join(tmpdir(), "fx-mv-nostat-"));
        const local = new LocalRuntimeDriver({ cwd: dir });
        let mvRan = 0;
        const noStatExec = async (cmd: string) => {
            const r = await local.exec(`python3() { return 127; }; stat() { return 127; }; mv() { echo "MV_RAN" >&2; return 99; }; ${cmd}`);
            if (r.stderr.includes("MV_RAN")) mvRan++;
            return r;
        };
        try {
            mkdirSync(join(dir, "srcDir"));
            writeFileSync(join(dir, "srcDir", "a.txt"), "keep-me");

            const ssh = new SshPtyDriver({ driver: "ssh", target: "mock" });
            (ssh as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = noStatExec;
            await expect(ssh.fs.rename!("srcDir", "destDir")).rejects.toThrow(/无法核实文件系统设备号|缺少禁止跨设备复制/);

            const tmux = new TmuxSessionDriver({ driver: "tmux", target: "mock" });
            tmux.exec = noStatExec;
            await expect(tmux.fs.rename!("srcDir", "destDir")).rejects.toThrow(/rename 失败/);

            expect(mvRan).toBe(0);
            expect(existsSync(join(dir, "destDir"))).toBe(false);
            expect(readFileSync(join(dir, "srcDir", "a.txt"), "utf8")).toBe("keep-me");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test("[P2] local directory rename uses native node:fs without requiring mv on PATH", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const dir = mkdtempSync(join(tmpdir(), "fx-mv-nopath-"));
        const local = new LocalRuntimeDriver({ cwd: dir });
        const origPath = process.env.PATH;
        try {
            mkdirSync(join(dir, "srcDir"));
            writeFileSync(join(dir, "srcDir", "file.txt"), "native-ok");
            process.env.PATH = "";
            await local.fs.rename!("srcDir", "dstDir");
            expect(existsSync(join(dir, "srcDir"))).toBe(false);
            expect(readFileSync(join(dir, "dstDir", "file.txt"), "utf8")).toBe("native-ok");
        } finally {
            process.env.PATH = origPath;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("[P2] recursive rm consistently refuses trailing slash on directory symlinks across local, SSH, and tmux", async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, symlinkSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const { SshPtyDriver } = await import("../src/core/ssh/ssh-pty-driver.js");
        const { TmuxSessionDriver } = await import("../src/core/tmux/tmux-driver.js");
        const dir = mkdtempSync(join(tmpdir(), "fx-rm-symlink-slash-"));
        const realDir = join(dir, "realdir");
        const linkPath = join(dir, "link");
        mkdirSync(realDir, { recursive: true });
        writeFileSync(join(realDir, "keep.txt"), "target-intact");
        symlinkSync(realDir, linkPath, process.platform === "win32" ? "junction" : "dir");

        const local = new LocalRuntimeDriver({ cwd: dir });
        const ssh = new SshPtyDriver({ driver: "ssh", target: "mock" });
        (ssh as unknown as { execChannel: (cmd: string) => Promise<unknown> }).execChannel = (cmd: string) => local.exec(cmd);
        const tmux = new TmuxSessionDriver({ driver: "tmux", target: "mock" });
        tmux.exec = (cmd: string) => local.exec(cmd);
        try {
            await expect(local.fs.rm("link/", { recursive: true, force: false })).rejects.toThrow(/不是真实目录/);
            await expect(local.fs.rm("link/", { recursive: true, force: true })).rejects.toThrow(/不是真实目录/);
            if (process.platform !== "win32") {
                await expect(ssh.fs.rm("link/", { recursive: true, force: false })).rejects.toThrow(/rm 失败/);
                await expect(ssh.fs.rm("link/", { recursive: true, force: true })).rejects.toThrow(/rm 失败/);
                await expect(tmux.fs.rm("link/", { recursive: true, force: false })).rejects.toThrow(/rm 失败/);
                await expect(tmux.fs.rm("link/", { recursive: true, force: true })).rejects.toThrow(/rm 失败/);
            }
            expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
            expect(readFileSync(join(realDir, "keep.txt"), "utf8")).toBe("target-intact");

            // Without trailing slash, recursive rm removes the symlink entry itself and preserves target contents.
            await local.fs.rm("link", { recursive: true, force: false });
            expect(() => lstatSync(linkPath)).toThrow();
            expect(readFileSync(join(realDir, "keep.txt"), "utf8")).toBe("target-intact");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test("local, SSH, and tmux rm/rename succeed without Python and surface raw shell errors directly", async () => {
        const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const { SshPtyDriver } = await import("../src/core/ssh/ssh-pty-driver.js");
        const { TmuxSessionDriver } = await import("../src/core/tmux/tmux-driver.js");

        const dir = mkdtempSync(join(tmpdir(), "fx-zero-python-"));
        const local = new LocalRuntimeDriver({ cwd: dir });
        const origPath = process.env.PATH;
        try {
            // 1. Local recursive rm and directory rename require zero external binaries (even PATH="").
            mkdirSync(join(dir, "localVictim", "sub"), { recursive: true });
            writeFileSync(join(dir, "localVictim", "sub", "a.txt"), "bye");
            mkdirSync(join(dir, "localSrc"));
            writeFileSync(join(dir, "localSrc", "b.txt"), "moved-local");
            process.env.PATH = "";
            try {
                await local.fs.rm("localVictim", { recursive: true });
                await local.fs.rename!("localSrc", "localDst");
            } finally {
                process.env.PATH = origPath;
            }
            expect(existsSync(join(dir, "localVictim"))).toBe(false);
            expect(readFileSync(join(dir, "localDst", "b.txt"), "utf8")).toBe("moved-local");

            // 2. SSH and tmux rm/rename succeed cleanly when python3/python/perl are completely absent.
            const noPyExec = (cmd: string) => local.exec(
                `python3() { return 127; }; python() { return 127; }; perl() { return 127; }; ${cmd}`,
            );
            const ssh = new SshPtyDriver({ driver: "ssh", target: "mock" });
            (ssh as unknown as { execChannel: (c: string) => Promise<unknown> }).execChannel = noPyExec;
            const tmux = new TmuxSessionDriver({ driver: "tmux", target: "mock" });
            tmux.exec = noPyExec;

            mkdirSync(join(dir, "sshVictim", "nested"), { recursive: true });
            writeFileSync(join(dir, "sshVictim", "nested", "x.txt"), "gone");
            await ssh.fs.rm("sshVictim", { recursive: true });
            expect(existsSync(join(dir, "sshVictim"))).toBe(false);

            mkdirSync(join(dir, "tmuxSrc"));
            writeFileSync(join(dir, "tmuxSrc", "y.txt"), "moved-tmux");
            await tmux.fs.rename!("tmuxSrc", "tmuxDst");
            expect(existsSync(join(dir, "tmuxSrc"))).toBe(false);
            expect(readFileSync(join(dir, "tmuxDst", "y.txt"), "utf8")).toBe("moved-tmux");
            await tmux.fs.rm("tmuxDst", { recursive: true });
            expect(existsSync(join(dir, "tmuxDst"))).toBe(false);

            // 3. Raw shell errors from rm/mv are surfaced directly; exit >= 129 sets outcome="unknown".
            mkdirSync(join(dir, "errDir"));
            (ssh as unknown as { execChannel: (c: string) => Promise<unknown> }).execChannel = (cmd: string) =>
                local.exec(`rm() { echo "custom-shell-eperm" >&2; return 1; }; ${cmd}`);
            await expect(ssh.fs.rm("errDir", { recursive: true })).rejects.toThrow(/custom-shell-eperm/);

            (ssh as unknown as { execChannel: (c: string) => Promise<unknown> }).execChannel = (cmd: string) =>
                local.exec(`rm() { return 143; }; ${cmd}`);
            await expect(ssh.fs.rm("errDir", { recursive: true })).rejects.toMatchObject({ outcome: "unknown" });
        } finally {
            process.env.PATH = origPath;
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test("real tmux session executes rm/rename, rejects >15.5KB commands without sealing, and runs large scripts via run_batch(put -> after -> exec)", async () => {
        if (process.platform === "win32") return;
        const { TmuxInvoker } = await import("../src/core/tmux/tmux-invoker.js");
        if (!(await TmuxInvoker.isAvailable())) return;
        const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { TerminalManager } = await import("../src/core/tmux/terminal-manager.js");
        const { TmuxSessionDriver } = await import("../src/core/tmux/tmux-driver.js");

        const dir = mkdtempSync(join(tmpdir(), "fx-real-tmux-slim-"));
        const ws = join(dir, "ws");
        const tmDir = join(dir, "tm");
        mkdirSync(join(ws, "victim"), { recursive: true });
        mkdirSync(tmDir, { recursive: true });
        writeFileSync(join(ws, "victim", "a.txt"), "remove-me");
        writeFileSync(join(ws, "keep.txt"), "stay-intact");

        const tm = new TerminalManager({ terminalDir: tmDir, config: { poll_interval_ms: 80, spawn_poll_ms: 50 } });
        const drv = new TmuxSessionDriver({ driver: "tmux", cwd: ws, config: { launchCmd: "bash" } }, { terminalManager: tm });
        await drv.init();
        const stack = new RuntimeStack();
        await stack.addLayer("tm", drv);
        const tk = createAgentToolkit(stack);
        try {
            // 1. Recursive delete & rename in real tmux
            await drv.fs.rm("victim", { recursive: true });
            expect(existsSync(join(ws, "victim"))).toBe(false);
            expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("stay-intact");

            // 2. Oversized >15.5KB command throws actionable guidance BEFORE sendKeys and leaves pane unsealed
            const hugeCmd = `echo ${"A".repeat(17_000)}`;
            let longErr: (Error & { outcome?: string }) | undefined;
            try {
                await drv.exec(hugeCmd);
            } catch (e) {
                longErr = e as Error & { outcome?: string };
            }
            expect(longErr?.message).toMatch(/run_batch.*put.*after.*exec|transfer_file/);
            expect(longErr?.outcome).toBeUndefined();

            const alive = await drv.exec("echo pane-unsealed");
            expect(alive.exitCode).toBe(0);
            expect(alive.stdout.trim()).toBe("pane-unsealed");

            // 3. run_batch(kind="put" -> after -> kind="exec") uploads and runs a >20KB script cleanly on real tmux
            const localScript = join(dir, "big-job.sh");
            const padComment = "# " + "X".repeat(24_000) + "\n";
            writeFileSync(localScript, `#!/bin/sh\n${padComment}printf 'BATCH_SCRIPT_OK\\n'\n`);
            const batchRes = await tk.handlers.run_batch({
                layer: "tm",
                steps: [
                    { id: "upload", kind: "put", local_path: localScript, remote_path: "uploaded-job.sh" },
                    { id: "run", kind: "exec", command: "sh ./uploaded-job.sh && rm -f ./uploaded-job.sh", after: ["upload"] },
                ],
            });
            expect(batchRes.status).toBe("ok");
            expect(batchRes.steps).toHaveLength(2);
            const runStep = batchRes.steps.find((s) => s.id === "run");
            expect(runStep?.stdout).toContain("BATCH_SCRIPT_OK");
            expect(existsSync(join(ws, "uploaded-job.sh"))).toBe(false);
            // 4. [P2] 128 KiB binary upload + download roundtrip on real tmux without scrollback truncation
            const localBinSrc = join(dir, "src-128k.bin");
            const localBinDst = join(dir, "dst-128k.bin");
            const binPayload = Buffer.alloc(128 * 1024);
            for (let i = 0; i < binPayload.length; i++) binPayload[i] = (i * 73 + 19) & 0xff;
            writeFileSync(localBinSrc, binPayload);

            const putRes = await tk.handlers.transfer_file({
                direction: "put", layer: "tm", local_path: localBinSrc, remote_path: "remote-128k.bin",
            });
            expect(putRes.verified).toBe(true);
            expect(putRes.bytes).toBe(128 * 1024);

            const getRes = await tk.handlers.transfer_file({
                direction: "get", layer: "tm", remote_path: "remote-128k.bin", local_path: localBinDst,
            });
            expect(getRes.verified).toBe(true);
            expect(getRes.bytes).toBe(128 * 1024);
            expect(Buffer.compare(readFileSync(localBinDst), binPayload)).toBe(0);

            // 5. [P1] read_path on a non-existent path reports not-found without exiting the persistent tmux shell
            await expect(tk.handlers.read_path({ layer: "tm", path: "definitely-missing-path" })).rejects.toThrow(/路径不存在/);
            const afterMissing = await tk.handlers.run_command({ layer: "tm", command: "printf 'STILL_ALIVE_OK\\n'" });
            expect(afterMissing.exit_code).toBe(0);
            expect(afterMissing.stdout).toContain("STILL_ALIVE_OK");
        } finally {
            await stack.removeLayer("tm", { destroy: true });
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);

    test("[P2] read_path preserves EACCES/permission-denied errors instead of reporting path not found", async () => {
        const fsPromises = await import("node:fs/promises");
        const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const { SshPtyDriver } = await import("../src/core/ssh/ssh-pty-driver.js");
        const { TmuxSessionDriver } = await import("../src/core/tmux/tmux-driver.js");

        const dir = mkdtempSync(join(tmpdir(), "fx-perm-read-"));
        try {
            // 1. Cross-platform: LocalRuntimeDriver.fs.stat rethrows EACCES/EPERM (only ENOENT/ENOTDIR -> null)
            const local = new LocalRuntimeDriver({ cwd: dir });
            const origStat = fsPromises.default.stat;
            const secretDir = join(dir, "secret-dir");
            mkdirSync(secretDir);
            fsPromises.default.stat = (async (p: Parameters<typeof origStat>[0], opts?: Parameters<typeof origStat>[1]) => {
                if (String(p).includes("secret-dir")) {
                    throw Object.assign(new Error(`EACCES: permission denied, stat '${String(p)}'`), { code: "EACCES" });
                }
                return origStat(p, opts);
            }) as typeof origStat;
            try {
                const tkLocal = createAgentToolkit(new RuntimeStack(), { driver: local });
                await expect(tkLocal.handlers.read_path({ path: "secret-dir" })).rejects.toThrow(/EACCES|permission denied/i);
                await expect(tkLocal.handlers.read_path({ path: "truly-missing" })).rejects.toThrow(/路径不存在/);
            } finally {
                fsPromises.default.stat = origStat;
            }

            // 2. Cross-platform: when stat returns null (e.g. missing remote stat), readdir EACCES is preserved
            const nullStatPermDrv = {
                descriptor: { driver: "custom-perm" },
                fs: {
                    stat: async () => null,
                    readdir: async (p: string) => {
                        if (p === "denied") {
                            throw Object.assign(new Error("EACCES: permission denied, scandir 'denied'"), { code: "EACCES" });
                        }
                        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
                    },
                    readFile: async () => "",
                    writeFile: async () => {},
                    exists: async () => false,
                    rm: async () => {},
                    mkdir: async () => {},
                },
            } as unknown as RuntimeDriver;
            const tkNullStat = createAgentToolkit(new RuntimeStack(), { driver: nullStatPermDrv });
            await expect(tkNullStat.handlers.read_path({ path: "denied" })).rejects.toThrow(/EACCES|permission denied/i);
            await expect(tkNullStat.handlers.read_path({ path: "missing" })).rejects.toThrow(/路径不存在/);

            // 3. POSIX real filesystem permission checks across local, SSH, and tmux
            if (process.platform !== "win32") {
                const isRoot = typeof process.geteuid === "function" && process.geteuid() === 0;
                const setpriv = isRoot ? Bun.which("setpriv") : null;
                if (!isRoot || setpriv) {
                    const pDir = join(dir, "posix-perm");
                    mkdirSync(join(pDir, "d000"), { recursive: true });
                    mkdirSync(join(pDir, "d111"), { recursive: true });
                    mkdirSync(join(pDir, "p000", "sub"), { recursive: true });
                    writeFileSync(join(pDir, "d111", "inside.txt"), "hidden");
                    chmodSync(dir, 0o755);
                    chmodSync(pDir, 0o755);
                    chmodSync(join(pDir, "d000"), 0o000);
                    chmodSync(join(pDir, "d111"), 0o111);
                    chmodSync(join(pDir, "p000"), 0o000);
                    try {
                        if (!isRoot) {
                            const tkRealLocal = createAgentToolkit(new RuntimeStack(), { driver: new LocalRuntimeDriver({ cwd: pDir }) });
                            await expect(tkRealLocal.handlers.read_path({ path: "d000" })).rejects.toThrow(/EACCES|permission denied/i);
                            await expect(tkRealLocal.handlers.read_path({ path: "d111" })).rejects.toThrow(/EACCES|permission denied/i);
                            await expect(tkRealLocal.handlers.read_path({ path: "p000/sub" })).rejects.toThrow(/EACCES|permission denied/i);
                        }
                        const runAsUnpriv = async (cmd: string) => {
                            const argv = isRoot
                                ? [setpriv!, "--reuid=65534", "--regid=65534", "--clear-groups", "sh", "-c", `cd ${JSON.stringify(pDir)} && eval "$1"`, "_", cmd]
                                : ["sh", "-c", `cd ${JSON.stringify(pDir)} && eval "$1"`, "_", cmd];
                            const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", windowsHide: true });
                            const [stdout, stderr, exitCode] = await Promise.all([
                                new Response(proc.stdout).text(),
                                new Response(proc.stderr).text(),
                                proc.exited,
                            ]);
                            return { stdout, stderr, exitCode };
                        };
                        const ssh = new SshPtyDriver({ driver: "ssh", target: "mock" });
                        (ssh as unknown as { execChannel: typeof runAsUnpriv }).execChannel = runAsUnpriv;
                        const tmux = new TmuxSessionDriver({ driver: "tmux" });
                        tmux.exec = async (cmd) => {
                            const r = await runAsUnpriv(cmd);
                            return { stdout: r.stdout + r.stderr, stderr: "", exitCode: r.exitCode };
                        };
                        for (const drv of [ssh, tmux]) {
                            const tkRemote = createAgentToolkit(new RuntimeStack(), { driver: drv });
                            await expect(tkRemote.handlers.read_path({ path: "d000" })).rejects.toThrow(/permission denied|权限不足/i);
                            await expect(tkRemote.handlers.read_path({ path: "d111" })).rejects.toThrow(/permission denied|权限不足/i);
                            await expect(tkRemote.handlers.read_path({ path: "p000/sub" })).rejects.toThrow(/permission denied|权限不足/i);
                            await expect(tkRemote.handlers.read_path({ path: "missing-sub" })).rejects.toThrow(/路径不存在/);
                        }
                    } finally {
                        chmodSync(join(pDir, "d000"), 0o700);
                        chmodSync(join(pDir, "d111"), 0o700);
                        chmodSync(join(pDir, "p000"), 0o700);
                    }
                }
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);
});

// ---------------------------------------------------------------------------
// DSH + GLM-5.4 使用评估（2026-11-26）#6：run_batch 的 command_file 与层通配
// ---------------------------------------------------------------------------
describe("run_batch：command_file 与层通配（DSH 评估 2026-11-26 #6）", () => {
    test("command_file 引用脚本文件替代 command：命令原样进文件，免 JSON 转义", async () => {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const { TOOL_DEFS } = await import("../src/interface/mcp/agent-toolkit.js");
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "fx-tk-cf-"));
        try {
            const tk = createAgentToolkit(new RuntimeStack(), {});
            const f = path.join(d, "snap.sh");
            fs.writeFileSync(f, "printf '%s\\n' \"it's\" 'a \"quoted\" word'\n");
            const r = await tk.handlers.run_batch({ steps: [{ id: "cf", kind: "exec", command_file: f }] });
            expect(r.status).toBe("ok");
            expect(r.steps[0]!.stdout).toContain("it's");
            expect(r.steps[0]!.stdout).toContain('a "quoted" word');
            // 二者互斥；驼峰 commandFile 在 MCP 面不是合法字段（字段名统一 snake_case）
            await expect(tk.handlers.run_batch({ steps: [{ id: "s", kind: "exec", command: "x", command_file: f }] })).rejects.toThrow(/互斥/);
            await expect(tk.handlers.run_batch({ steps: [{ id: "s", kind: "exec", commandFile: f }] })).rejects.toThrow(/未知字段/);
            // schema 把 command_file 暴露给调用方
            const batchTool = TOOL_DEFS.find((t) => t.function.name === "run_batch")!;
            const params = batchTool.function.parameters as { properties: { steps: { items: { properties: Record<string, unknown> } } } };
            expect(params.properties.steps.items.properties).toHaveProperty("command_file");
        } finally {
            fs.rmSync(d, { recursive: true, force: true });
        }
    }, 30_000);

    test("已存层：未注册的层名与层通配命中入口注入的层表时按需加载，且不抢默认层", async () => {
        // 三路互通（用户 2026-11-26 定调：CLI / MCP / SDK 本来就该认同一份层）。
        // 入口注入读取函数；工具集自身不读用户目录。
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const stack = new RuntimeStack();
        await stack.addLayer("q-a", new LocalRuntimeDriver());
        let reads = 0;
        const store: Record<string, { driver: string }> = { "sv-1": { driver: "local" }, "sv-2": { driver: "local" } };
        const tk = createAgentToolkit(stack, { savedLayers: () => { reads++; return store; } });
        try {
            // 通配：已存的那两个此刻才注册
            const r = await tk.handlers.run_batch({ layer: "sv-?", steps: [{ id: "hi", kind: "exec", command: "printf hi" }] });
            expect(r.status).toBe("ok");
            expect(r.steps.map((s) => s.id).sort()).toEqual(["hi@sv-1", "hi@sv-2"]);
            expect([...stack.layers.keys()].sort()).toEqual(["q-a", "sv-1", "sv-2"]);
            // 被顺带加载的层不抢默认层
            expect(stack.activeLayer?.name).not.toMatch(/^sv-/);

            // 精确层名：单个工具也认已存层
            const rc = await tk.handlers.run_command({ layer: "sv-1", command: "printf named" }) as { stdout: string };
            expect(rc.stdout).toContain("named");

            // 进程存活期间新保存的层也认（读取函数每次调用、不缓存）
            store["sv-3"] = { driver: "local" };
            const r3 = await tk.handlers.run_batch({ layer: "sv-3", steps: [{ id: "x", kind: "exec", command: "printf three" }] });
            // 单层计划保留原步骤 id；层字段指向新加载的已存层
            expect(r3.steps[0]!.id).toBe("x");
            expect(r3.steps[0]!.layer).toBe("sv-3");

            // 哪边都没有：点名说清；坏档：原样报出，不当空表
            await expect(tk.handlers.run_batch({ layer: "ghost", steps: [{ id: "s", kind: "exec", command: "x" }] }))
                .rejects.toThrow(/未注册，也不在已存层表里/);
            const broken = createAgentToolkit(new RuntimeStack(), { savedLayers: () => { throw new Error("层快照必须是对象"); } });
            await expect(broken.handlers.run_batch({ layer: "a-*", steps: [{ id: "s", kind: "exec", command: "x" }] }))
                .rejects.toThrow(/层快照必须是对象/);
            expect(reads).toBeGreaterThan(0);
        } finally {
            await Promise.all([...stack.layers.keys()].map((n) => stack.removeLayer(n, { destroy: true })));
        }
    }, 30_000);

    test("layer 通配按已注册层名展开；无匹配则拒绝（不落到默认层）", async () => {
        const { LocalRuntimeDriver } = await import("../src/core/local/local-driver.js");
        const stack = new RuntimeStack();
        await stack.addLayer("q-a", new LocalRuntimeDriver());
        await stack.addLayer("q-b", new LocalRuntimeDriver());
        await stack.addLayer("keep", new LocalRuntimeDriver());
        const tk = createAgentToolkit(stack, {});
        try {
            const r = await tk.handlers.run_batch({ layer: "q-?", steps: [{ id: "hi", kind: "exec", command: "printf hi" }] });
            expect(r.status).toBe("ok");
            expect(r.steps.map((s) => s.id).sort()).toEqual(["hi@q-a", "hi@q-b"]);
            await expect(tk.handlers.run_batch({ layer: "zz-*", steps: [{ id: "s", kind: "exec", command: "x" }] }))
                .rejects.toThrow(/未匹配任何已注册层/);
        } finally {
            await Promise.all([...stack.layers.keys()].map((n) => stack.removeLayer(n, { destroy: true })));
        }
    }, 30_000);
});
