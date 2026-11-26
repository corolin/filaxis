/**
 * 批次组合（runBatch）测试——local driver 真跑：
 * DAG 依赖边 / fail-fast / 多 hunk 原子 / expectExit / 计划校验 / CLI 冒烟
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntimeDriver } from "../src/local-driver.js";
import { runBatch, expandBatchLayerWildcards, expandLayerPattern, hasLayerWildcard, editFileMulti, type RuntimeDriver, type BatchPlan } from "../src/index.js";
import { createAgentToolkit } from "../src/agent-toolkit.js";
import { RuntimeStack } from "../src/operations/runtime-stack.js";

const dir = mkdtempSync(join(tmpdir(), "fx-batch-"));

describe("runBatch（DAG + fail-fast + 证据）", () => {
    test("顺序链：写文件→编辑→验证→重载（after 保序，全 ok）", async () => {
        const drv = new LocalRuntimeDriver();
        const p = join(dir, "chain.conf").replace(/\\/g, "/");
        const r = await runBatch(drv, {
            steps: [
                { id: "init", kind: "exec", command: `echo 'port=8080' > ${p}` },
                { id: "edit", kind: "edit", path: p, hunks: [{ old: "port=8080", new: "port=9090" }], after: ["init"] },
                { id: "verify", kind: "exec", command: `grep -q 'port=9090' ${p}`, after: ["edit"] },
                { id: "reload", kind: "exec", command: `echo reloaded`, after: ["verify"] },
            ],
        });
        expect(r.status).toBe("ok");
        expect(r.steps.every((s) => s.status === "ok")).toBe(true);
        expect(r.steps.find((s) => s.id === "edit")!.edits!.hunks[0]!.new).toBe("port=9090"); // 编辑预览=old/new 原文
        // 保护等级进批次报告（Astra 五轮 P2）
        expect(r.steps.find((s) => s.id === "edit")!.edits!.mutex === "flock"
            || r.steps.find((s) => s.id === "edit")!.edits!.mutex === "degraded").toBe(true);
    }, 30_000);

    test("fail-fast：验证步失败 → 重载步 skipped（不执行）", async () => {
        const drv = new LocalRuntimeDriver();
        const p = join(dir, "fail.conf").replace(/\\/g, "/");
        const r = await runBatch(drv, {
            steps: [
                { id: "init", kind: "exec", command: `echo 'port=80' > ${p}` },
                { id: "verify", kind: "exec", command: `grep -q 'port=9999' ${p}`, after: ["init"] }, // 必失败
                {
                    id: "reload", kind: "exec", command: `touch ${p}.reloaded; echo x`, after: ["verify"],
                },
            ],
        });
        expect(r.status).toBe("fail");
        expect(r.failedStep).toBe("verify");
        const rl = r.steps.find((s) => s.id === "reload")!;
        expect(rl.status).toBe("skipped");
        expect(rl.skippedBecause).toContain("fail-fast");
        expect(existsSync(p + ".reloaded")).toBe(false); // skipped = 真没执行（重载副作用零发生）
        // verify 失败证据在场（exitCode 非零 + error）
        const v = r.steps.find((s) => s.id === "verify")!;
        expect(v.exitCode).toBe(1);
        expect(v.error).toContain("不在预期");
    }, 30_000);

    test("无依赖并行 + 汇聚点（after 两步）", async () => {
        const drv = new LocalRuntimeDriver();
        const r = await runBatch(drv, {
            steps: [
                { id: "a", kind: "exec", command: `echo A` },
                { id: "b", kind: "exec", command: `echo B` },
                { id: "join", kind: "exec", command: `echo joined`, after: ["a", "b"] },
            ],
        });
        expect(r.status).toBe("ok");
        expect(r.steps.find((s) => s.id === "a")!.stdout).toContain("A");
        expect(r.steps.find((s) => s.id === "join")!.status).toBe("ok");
    }, 30_000);

    test("expectExit：非零预期显式声明（退出码是数据）", async () => {
        const drv = new LocalRuntimeDriver();
        const r = await runBatch(drv, {
            steps: [
                { id: "probe", kind: "exec", command: `exit 3`, expectExit: [3] },
                { id: "no", kind: "exec", command: `exit 0`, expectExit: [1, 2] }, // 0 不在预期 → fail
            ],
        });
        expect(r.steps.find((s) => s.id === "probe")!.status).toBe("ok");
        expect(r.steps.find((s) => s.id === "no")!.status).toBe("fail");
    }, 30_000);

    test("edit 多 hunk 原子：任一未命中整批拒绝不写（文件零改动）", async () => {
        const drv = new LocalRuntimeDriver();
        const p = join(dir, "multi.conf");
        writeFileSync(p, "A=1\nB=2\n");
        const fwd = p.replace(/\\/g, "/");
        await expect(editFileMulti(drv, fwd, [
            { old: "A=1", new: "A=9" },
            { old: "C=999", new: "C=1" }, // 未命中 → 整批拒
        ])).rejects.toThrow(/hunk #1 未命中.*整批拒绝/);
        expect(readFileSync(p, "utf-8")).toBe("A=1\nB=2\n"); // 零改动
        // batch 层同样：edit 步骤 fail + 文件未动
        const r = await runBatch(drv, {
            steps: [
                { id: "edit", kind: "edit", path: fwd, hunks: [{ old: "A=1", new: "A=9" }, { old: "NOPE", new: "X" }] },
                { id: "after", kind: "exec", command: "echo never", after: ["edit"] },
            ],
        });
        expect(r.status).toBe("fail");
        expect(readFileSync(p, "utf-8")).toBe("A=1\nB=2\n");
        expect(r.steps.find((s) => s.id === "after")!.status).toBe("skipped");
    }, 30_000);

    test("计划校验零副作用：id 重复 / 未知 after / 依赖环", async () => {
        const drv = new LocalRuntimeDriver();
        await expect(runBatch(drv, { steps: [
            { id: "x", kind: "exec", command: "echo 1" },
            { id: "x", kind: "exec", command: "echo 2" },
        ] })).rejects.toThrow(/id 重复/);
        await expect(runBatch(drv, { steps: [
            { id: "x", kind: "exec", command: "echo 1", after: ["ghost"] },
        ] })).rejects.toThrow(/未知步骤/);
        await expect(runBatch(drv, { steps: [
            { id: "a", kind: "exec", command: "echo 1", after: ["b"] },
            { id: "b", kind: "exec", command: "echo 2", after: ["a"] },
        ] })).rejects.toThrow(/依赖环/);
    }, 30_000);

    // GPT Astra #4：exec 超时/abort 挂的 outcome:"unknown"（远端终态未核实——非幂等
    // 步骤严禁自动重放）必须在批报告透传，不能丢成普通 fail
    test("outcome:unknown 透传：超时步骤的报告带终态未知标记", async () => {
        const drv = new LocalRuntimeDriver();
        const r = await runBatch(drv, {
            steps: [
                { id: "hang", kind: "exec", command: "sleep 5", timeoutMs: 300 }, // 超时 → outcome unknown
                { id: "after", kind: "exec", command: "echo never", after: ["hang"] },
            ],
        });
        expect(r.status).toBe("fail");
        const hang = r.steps.find((s) => s.id === "hang")!;
        expect(hang.status).toBe("fail");
        expect(hang.outcome).toBe("unknown"); // 修前：字段被 catch 吞掉
        expect(hang.error).toContain("timeout");
        expect(r.steps.find((s) => s.id === "after")!.status).toBe("skipped");
    }, 30_000);

    // GPT Astra 四轮 #3：driver throw null——catch 块读 (err as {outcome}).outcome 再抛
    // TypeError，整份 runBatch reject 报告丢失。修后：判空优先，失败仍进逐步骤报告
    test("driver 抛 null 不丢报告（catch 判空——步骤 fail 而非整批 reject）", async () => {
        const nullDriver = {
            descriptor: { driver: "local" },
            async exec(): Promise<never> { throw null; }, // 恶意/异常 driver
        } as unknown as import("../src/local-driver.js").LocalRuntimeDriver;
        const r = await runBatch(nullDriver, {
            steps: [
                { id: "boom", kind: "exec", command: "x" },
                { id: "never", kind: "exec", command: "echo n", after: ["boom"] },
            ],
        });
        expect(r.status).toBe("fail"); // 报告还在（修前：runBatch 直接 reject）
        const boom = r.steps.find((s) => s.id === "boom")!;
        expect(boom.status).toBe("fail");
        expect(boom.error).toContain("null"); // 空异常如实入报
        expect(r.steps.find((s) => s.id === "never")!.status).toBe("skipped");
    }, 15_000);
});

describe("toolkit run_batch + CLI batch 冒烟", () => {
    test("toolkit run_batch（snake_case 参数 → BatchPlan）", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), {});
        const p = join(dir, "tk.conf").replace(/\\/g, "/");
        const r = await tk.handlers.run_batch({
            steps: [
                { id: "w", kind: "exec", command: `echo 'k=1' > ${p}` },
                { id: "e", kind: "edit", path: p, hunks: [{ old: "k=1", new: "k=2" }], after: ["w"] },
                { id: "v", kind: "exec", command: `grep -q 'k=2' ${p}`, after: ["e"] },
            ],
        });
        expect(r.status).toBe("ok");
        expect(readFileSync(p, "utf-8")).toBe("k=2\n");
    }, 30_000);

    test("CLI batch --request-file（local 计划：exec+edit+read；fail 计划 exit 1）", async () => {
        const { execSync } = await import("node:child_process");
        const p = join(dir, "cli.conf").replace(/\\/g, "/");
        const plan = join(dir, "plan.json").replace(/\\/g, "/");
        writeFileSync(plan, JSON.stringify({
            steps: [
                { id: "w", kind: "exec", command: `echo 'v=1' > ${p}` },
                { id: "e", kind: "edit", path: p, hunks: [{ old: "v=1", new: "v=2" }], after: ["w"] },
                { id: "r", kind: "read", path: p, after: ["e"] },
            ],
        }));
        // --no-daemon：测试不取决于机器上是否有真实 Daemon 在跑（否则会连上去执行）
        const out = execSync(`bun bin/filaxis.ts batch --no-daemon --request-file "${plan}"`, { encoding: "utf-8", windowsHide: true });
        expect(out).toContain("[ok] w (exec");
        expect(out).toContain("替换 1 处");
        expect(out).toContain("[ok] r (read");
        expect(out).toContain("batch ok");
        // fail 计划：exit 1 + skipped 行
        const plan2 = join(dir, "plan2.json").replace(/\\/g, "/");
        writeFileSync(plan2, JSON.stringify({
            steps: [
                { id: "bad", kind: "exec", command: "exit 7" },
                { id: "never", kind: "exec", command: "echo no", after: ["bad"] },
            ],
        }));
        let errOut = "";
        try {
            execSync(`bun bin/filaxis.ts batch --no-daemon --request-file "${plan2}"`, { encoding: "utf-8", stdio: "pipe", windowsHide: true });
        } catch (e) {
            errOut = String((e as { stdout?: string }).stdout ?? "");
        }
        expect(errOut).toContain("exit=7");
        expect(errOut).toContain("[skipped] never");
        expect(errOut).toContain("batch fail");
        rmSync(dir, { recursive: true, force: true });
    }, 60_000);
});

// 冷路径摸排批 4：SDK 直调空计划曾静默 ok（CLI 有守卫而内核没有——绕过 CLI
// 的消费方拿到「成功执行了零个步骤」的假成功）
test("空 steps → 显式拒绝（内核级守卫，不再只靠 CLI）", async () => {
    const drv = new LocalRuntimeDriver();
    await expect(runBatch(drv, { steps: [] })).rejects.toThrow(/steps 需非空/);
    await expect(runBatch(drv, {} as never)).rejects.toThrow(/steps 需非空/);
});

// DSH 真机巡检踩中（2026-11-26）：`layers` 与 `layer` 一字之差被静默忽略，计划落回
// 默认层在调用方本机执行——「想扫集群、结果扫了自己」。拼错的顶层字段必须当场拒绝。
test("未知顶层字段 → 显式拒绝（layers≠layer 案）", async () => {
    const drv = new LocalRuntimeDriver();
    await expect(runBatch(drv, { layers: "q-*", steps: [{ id: "x", kind: "exec", command: "hostname" }] } as never))
        .rejects.toThrow(/未知顶层字段 'layers'/);
    await expect(runBatch(drv, { steps: [{ id: "x", kind: "exec", command: "true" }], layerr: 1 } as never))
        .rejects.toThrow(/未知顶层字段 'layerr'/);
    // 合法四字段不受影响
    const r = await runBatch(drv, { steps: [{ id: "ok", kind: "exec", command: "true" }], layer: undefined, stopOnFail: false, maxParallel: 1 });
    expect(r.steps[0]!.status).toBe("ok");
});

describe("runBatch layer 数组扇出", () => {
    function makeMockResolver(
        execImpl: (layer: string, command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
        missing: Set<string> = new Set(),
    ) {
        const calls: string[] = [];
        const drivers = new Map<string, RuntimeDriver>();
        const resolve = async (layer?: string): Promise<RuntimeDriver> => {
            const name = layer ?? "__default__";
            if (missing.has(name)) throw new Error(`层 '${name}' 不存在`);
            if (!drivers.has(name)) {
                drivers.set(name, {
                    descriptor: { driver: "mock", target: name },
                    supportsBoundedExec: true,
                    async exec(command: string) {
                        calls.push(`${name}:${command}`);
                        return execImpl(name, command);
                    },
                } as unknown as RuntimeDriver);
            }
            return drivers.get(name)!;
        };
        return { resolve, calls };
    }

    test("步骤级 layer 数组按 id@layer 展开并行，stopOnFail=false 时兄弟层继续执行", async () => {
        const { resolve, calls } = makeMockResolver(async (layer, cmd) => ({
            stdout: `${layer}:${cmd}`,
            stderr: layer === "b" ? "boom" : "",
            exitCode: layer === "b" ? 2 : 0,
        }));
        const r = await runBatch(resolve, {
            stopOnFail: false,
            steps: [
                { id: "check", kind: "exec", layer: ["a", "b", "c"], command: "uptime" },
            ],
        });
        expect(r.status).toBe("fail");
        expect(r.failedStep).toBe("check@b");
        expect(r.steps.map((s) => ({ id: s.id, layer: s.layer, status: s.status, exitCode: s.exitCode }))).toEqual([
            { id: "check@a", layer: "a", status: "ok", exitCode: 0 },
            { id: "check@b", layer: "b", status: "fail", exitCode: 2 },
            { id: "check@c", layer: "c", status: "ok", exitCode: 0 },
        ]);
        expect(calls).toHaveLength(3);
    });

    test("计划级 layer 数组扇出未覆盖步骤，步骤覆盖单层时保留原 id", async () => {
        const { resolve, calls } = makeMockResolver(async (layer, cmd) => ({
            stdout: `${layer}:${cmd}`,
            stderr: "",
            exitCode: 0,
        }));
        const r = await runBatch(resolve, {
            layer: ["a", "b"],
            steps: [
                { id: "probe", kind: "exec", command: "uname -a" },
                { id: "solo", kind: "exec", layer: "c", command: "hostname" },
            ],
        });
        expect(r.status).toBe("ok");
        expect(r.steps.map((s) => ({ id: s.id, layer: s.layer, stdout: s.stdout }))).toEqual([
            { id: "probe@a", layer: "a", stdout: "a:uname -a" },
            { id: "probe@b", layer: "b", stdout: "b:uname -a" },
            { id: "solo", layer: "c", stdout: "c:hostname" },
        ]);
        expect(calls).toEqual(["a:uname -a", "b:uname -a", "c:hostname"]);
    });

    test("单元素数组 layer: ['a'] 保留原步骤 id（不加 @a 后缀）", async () => {
        const { resolve } = makeMockResolver(async (layer) => ({ stdout: layer, stderr: "", exitCode: 0 }));
        const r = await runBatch(resolve, {
            steps: [{ id: "single", kind: "exec", layer: ["a"], command: "id" }],
        });
        expect(r.status).toBe("ok");
        expect(r.steps).toHaveLength(1);
        expect(r.steps[0]).toMatchObject({ id: "single", layer: "a", status: "ok", stdout: "a" });
    });

    test("after 扇入：需等待所有展开实例 ok；部分失败（stopOnFail=false）时下游标 skipped 并指出失败实例", async () => {
        const order: string[] = [];
        const { resolve } = makeMockResolver(async (layer, cmd) => {
            if (cmd === "fan" && layer === "a") await new Promise((r) => setTimeout(r, 30));
            order.push(`${cmd}@${layer}`);
            return { stdout: layer, stderr: "", exitCode: 0 };
        });
        const okReport = await runBatch(resolve, {
            maxParallel: 2,
            steps: [
                { id: "fan", kind: "exec", layer: ["a", "b"], command: "fan" },
                { id: "join", kind: "exec", layer: "c", command: "join", after: ["fan"] },
            ],
        });
        expect(okReport.status).toBe("ok");
        expect(order[order.length - 1]).toBe("join@c");
        expect(order.slice(0, 2).sort()).toEqual(["fan@a", "fan@b"]);

        const { resolve: resolveFail, calls: failCalls } = makeMockResolver(async (layer, cmd) => ({
            stdout: `${layer}:${cmd}`,
            stderr: "",
            exitCode: cmd === "fan" && layer === "b" ? 1 : 0,
        }));
        const failReport = await runBatch(resolveFail, {
            stopOnFail: false,
            steps: [
                { id: "fan", kind: "exec", layer: ["a", "b"], command: "fan" },
                { id: "join", kind: "exec", layer: "c", command: "join", after: ["fan"] },
            ],
        });
        expect(failReport.status).toBe("fail");
        expect(failCalls).toEqual(["a:fan", "b:fan"]);
        const joinStep = failReport.steps.find((s) => s.id === "join")!;
        expect(joinStep.status).toBe("skipped");
        expect(joinStep.skippedBecause).toContain("fan@b");
    });

    test("扇入完成后立即补满并发池，并保持就绪步骤的计划优先级", async () => {
        const releaseJoin = Promise.withResolvers<void>();
        const bothStarted = Promise.withResolvers<void>();
        let started = 0;
        const { resolve, calls } = makeMockResolver(async (_layer, command) => {
            if (command === "join") {
                if (++started === 2) bothStarted.resolve();
                await releaseJoin.promise;
            }
            return { stdout: "", stderr: "", exitCode: 0 };
        });
        const batch = runBatch(resolve, {
            maxParallel: 2,
            steps: [
                { id: "join", kind: "exec", layer: ["a", "b"], command: "join", after: ["root", "root"] },
                { id: "root", kind: "exec", layer: "c", command: "root" },
            ],
        });
        try {
            await bothStarted.promise;
            expect(calls).toEqual(["c:root", "a:join", "b:join"]);
        } finally {
            releaseJoin.resolve();
        }
        expect((await batch).status).toBe("ok");

        const { resolve: resolveOrdered, calls: orderedCalls } = makeMockResolver(async () => ({
            stdout: "", stderr: "", exitCode: 0,
        }));
        await runBatch(resolveOrdered, {
            maxParallel: 1,
            steps: [
                { id: "join", kind: "exec", layer: ["a", "b"], command: "join", after: ["root"] },
                { id: "root", kind: "exec", layer: "c", command: "root" },
                { id: "last", kind: "exec", layer: "c", command: "last" },
            ],
        });
        expect(orderedCalls).toEqual(["c:root", "a:join", "b:join", "c:last"]);
    });

    test("文本预算按 read 的采集通道分摊，exec 回读计入 stderr", async () => {
        const limits: Array<number | undefined> = [];
        const native = { fs: { async readFilePreview(_path: string, limit: number) {
            limits.push(limit);
            return "native";
        } } } as unknown as RuntimeDriver;
        const fallback = {
            supportsBoundedExec: true,
            fs: {},
            async exec(_command: string, options?: { maxOutputBytes?: number }) {
                limits.push(options?.maxOutputBytes);
                return { stdout: "fallback", stderr: "", exitCode: 0 };
            },
        } as unknown as RuntimeDriver;
        const report = await runBatch((name) => name === "native" ? native : fallback, {
            steps: [{ id: "read", kind: "read", path: "/file", layer: ["native", "fallback"] }],
        }, { previewBudgetBytes: 300 });
        expect(limits).toEqual([100, 100]);
        expect(report.steps.map((step) => step.stdout)).toEqual(["native", "fallback"]);
    });

    test("零副作用校验：空数组/非法元素/重复层名/展开 id 冲突/get 多层/缺失层均在执行前拒绝", async () => {
        const { resolve, calls } = makeMockResolver(
            async (layer) => ({ stdout: layer, stderr: "", exitCode: 0 }),
            new Set(["missing"]),
        );
        // 计划级空数组
        await expect(runBatch(resolve, {
            layer: [],
            steps: [{ id: "s", kind: "exec", command: "echo 1" }],
        })).rejects.toThrow(/非空字符串或非空字符串数组/);
        // 步骤级空数组
        await expect(runBatch(resolve, {
            steps: [{ id: "s", kind: "exec", layer: [], command: "echo 1" }],
        })).rejects.toThrow(/非空字符串或非空字符串数组/);
        // 非法元素
        await expect(runBatch(resolve, {
            steps: [{ id: "s", kind: "exec", layer: ["a", "  "], command: "echo 1" }],
        })).rejects.toThrow(/非空字符串或非空字符串数组/);
        // 重复层名
        await expect(runBatch(resolve, {
            steps: [{ id: "s", kind: "exec", layer: ["a", "a"], command: "echo 1" }],
        })).rejects.toThrow(/含重复层名 'a'/);
        const sparse = new Array<string>(2);
        sparse[0] = "a";
        const neverResolve = () => { throw new Error("invalid plan reached the layer resolver"); };
        await expect(runBatch(neverResolve, {
            layer: sparse,
            steps: [{ id: "s", kind: "exec", command: "echo 1" }],
        })).rejects.toThrow(/非空字符串或非空字符串数组/);
        // 展开后的 id 冲突
        await expect(runBatch(resolve, {
            steps: [
                { id: "check", kind: "exec", layer: ["a", "b"], command: "echo 1" },
                { id: "check@a", kind: "exec", layer: "c", command: "echo 2" },
            ],
        })).rejects.toThrow(/展开后的步骤 id 冲突 'check@a'/);
        await expect(runBatch(neverResolve, {
            steps: [
                { id: "check", kind: "exec", layer: ["a", "b"], command: "echo 1" },
                { id: "check@a", kind: "exec", layer: ["c", "d"], command: "echo 2" },
            ],
        })).rejects.toThrow(/展开后的步骤 id 冲突 'check@a'/);
        // kind=get 多层拒绝
        await expect(runBatch(resolve, {
            steps: [
                { id: "dl", kind: "get", layer: ["a", "b"], localPath: "./out.bin", remotePath: "/tmp/out.bin" },
            ],
        })).rejects.toThrow(/kind='get' 不支持多个目标层/);
        // 数组中含缺失层：先于任何步骤执行报错（零副作用）
        await expect(runBatch(resolve, {
            steps: [
                { id: "ok_first", kind: "exec", layer: "a", command: "echo ok" },
                { id: "fan", kind: "exec", layer: ["a", "missing"], command: "echo nope" },
            ],
        })).rejects.toThrow(/层 'missing' 不存在/);
        expect(calls).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// DSH + GLM-5.4 使用评估（2026-11-26）反馈 #6：exec 步骤 commandFile 与层通配
// ---------------------------------------------------------------------------
describe("runBatch：commandFile（DSH 评估 2026-11-26 #6）", () => {
    // 自建临时目录：文件顶层的 dir 会被前面的用例在收尾时删掉
    const cfDir = mkdtempSync(join(tmpdir(), "fx-batch-cf-"));
    test("脚本文件内联为命令：引号/$()/多行原样送达，BOM 与 CRLF 归一", async () => {
        const drv = new LocalRuntimeDriver();
        const f = join(cfDir, "snap.sh");
        // 模拟 Windows 编辑器产物：UTF-8 BOM + CRLF 行尾（\r 到 bash 里会被当成命令名的一部分）
        const body = [
            "echo \"## $(hostname) load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo n/a)\"",
            "printf '%s\\n' \"it's\" 'a \"quoted\" word'",
        ].join("\r\n");
        writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf-8")]));
        const r = await runBatch(drv, { steps: [{ id: "snap", kind: "exec", commandFile: f }] });
        expect(r.status).toBe("ok");
        expect(r.steps[0]!.stdout).toContain("## ");
        expect(r.steps[0]!.stdout).toContain("it's");
        expect(r.steps[0]!.stdout).toContain('a "quoted" word');
    }, 30_000);

    test("校验阶段拒绝（零副作用）：互斥 / 文件缺失 / 空文件 / 缺命令；且不改写调用方计划", async () => {
        const seen: string[] = [];
        const drv = {
            descriptor: { driver: "fake" },
            exec: async (c: string) => { seen.push(c); return { stdout: "", stderr: "", exitCode: 0 }; },
        } as unknown as RuntimeDriver;
        const good = join(cfDir, "good.sh");
        writeFileSync(good, "echo ok\n");
        const empty = join(cfDir, "empty.sh");
        writeFileSync(empty, "   \n\t\n");
        const cases: Array<[BatchPlan, RegExp]> = [
            [{ steps: [{ id: "s", kind: "exec", command: "echo a", commandFile: good }] }, /互斥/],
            [{ steps: [{ id: "s", kind: "exec", commandFile: join(cfDir, "absent.sh") }] }, /读取失败/],
            [{ steps: [{ id: "s", kind: "exec", commandFile: empty }] }, /内容为空/],
            [{ steps: [{ id: "s", kind: "exec" }] }, /缺 command/],
            [{ steps: [{ id: "s", kind: "exec", commandFile: "  " }] }, /需为非空字符串路径/],
        ];
        for (const [plan, re] of cases) {
            await expect(runBatch(drv, plan)).rejects.toThrow(re);
        }
        expect(seen).toEqual([]); // 五种非法计划一步都没执行
        // 解析结果只进内部展开副本——调用方的计划对象不被改写
        const plan: BatchPlan = { steps: [{ id: "s", kind: "exec", commandFile: good }] };
        const r = await runBatch(drv, plan);
        expect(r.status).toBe("ok");
        expect(seen).toEqual(["echo ok\n"]);
        expect((plan.steps[0] as { command?: string }).command).toBeUndefined();
    }, 30_000);
});

describe("层通配展开（DSH 评估 2026-11-26 #6）", () => {
    const known = ["m", "q-0-6", "q-0-9", "q-4-5", "q-4-8", "db.prod"];

    test("expandLayerPattern：* 与 ?；点号是字面；精确名优先；无通配原样", () => {
        expect(expandLayerPattern("q-*", known)).toEqual(["q-0-6", "q-0-9", "q-4-5", "q-4-8"]); // 保持已知层名的顺序
        expect(expandLayerPattern("q-?-6", known)).toEqual(["q-0-6"]);
        expect(expandLayerPattern("db.*", ["db.prod", "dbXprod"])).toEqual(["db.prod"]); // . 不是任意字符
        expect(expandLayerPattern("db.prod", known)).toEqual(["db.prod"]);
        expect(expandLayerPattern("a*b", ["a*b", "axb"])).toEqual(["a*b"]); // 层名本身含 * 也不会被当模式
        expect(expandLayerPattern("nope", known)).toEqual(["nope"]); // 无通配：原样交回（由层解析函数裁决存不存在）
        expect(expandLayerPattern("q-z*", known)).toEqual([]);
        expect(hasLayerWildcard("q-*")).toBe(true);
        expect(hasLayerWildcard("q-?-6")).toBe(true);
        expect(hasLayerWildcard("m")).toBe(false);
    });

    test("expandBatchLayerWildcards：顶层与步骤层都展开；无匹配整批拒绝；无通配原引用", () => {
        const base: BatchPlan = {
            layer: "q-*",
            steps: [
                { id: "snap", kind: "exec", command: "echo x" },
                { id: "one", kind: "exec", command: "echo y", layer: "q-4-*" },
                { id: "mix", kind: "exec", command: "echo z", layer: ["q-4-5", "q-4-8", "m", "q-4-*"] },
                { id: "any", kind: "exec", command: "echo w", layer: "*" },
            ],
        };
        const out = expandBatchLayerWildcards(base, known);
        expect(out.layer).toEqual(["q-0-6", "q-0-9", "q-4-5", "q-4-8"]);
        expect(out.steps[0]!.layer).toBeUndefined(); // 未覆盖层：继承顶层展开
        expect(out.steps[1]!.layer).toEqual(["q-4-5", "q-4-8"]);
        expect(out.steps[2]!.layer).toEqual(["q-4-5", "q-4-8", "m"]); // 数组去重，保持首次出现的位置
        expect(out.steps[3]!.layer).toEqual(known);
        // 调用方的计划不被改写
        expect(base.layer).toBe("q-*");
        expect(base.steps[1]!.layer).toBe("q-4-*");
        // 无匹配：把 "zz-*" 原样交下去会被当成一个不存在的层名——必须在入口拒绝
        expect(() => expandBatchLayerWildcards({ steps: [{ id: "s", kind: "exec", command: "x", layer: "zz-*" }] }, known))
            .toThrow(/步骤 's' 的 layer 的层通配 'zz-\*' 未匹配任何已存层/);
        expect(() => expandBatchLayerWildcards({ layer: "zz-*", steps: [{ id: "s", kind: "exec", command: "x" }] }, known, "已注册层"))
            .toThrow(/计划 layer 的层通配 'zz-\*' 未匹配任何已注册层/);
        const plain: BatchPlan = { layer: ["m", "nope"], steps: [{ id: "s", kind: "exec", command: "x", layer: ["q-4-5", "m"] }] };
        expect(expandBatchLayerWildcards(plain, known)).toBe(plain); // 不含通配：同一对象引用
    });

    test("展开结果交给 runBatch：按名解析到各层并行执行（id@layer）", async () => {
        const plan = expandBatchLayerWildcards({ layer: "q-*", steps: [{ id: "snap", kind: "exec", command: "echo hi" }] }, ["q-0-6", "q-4-5"]);
        const names: string[] = [];
        const drivers: LocalRuntimeDriver[] = [];
        const r = await runBatch(async (name) => {
            names.push(name!);
            const d = new LocalRuntimeDriver();
            drivers.push(d);
            return d;
        }, plan);
        await Promise.all(drivers.map((d) => d.destroy()));
        expect(r.status).toBe("ok");
        expect(r.steps.map((s) => s.id).sort()).toEqual(["snap@q-0-6", "snap@q-4-5"]);
        expect(names.sort()).toEqual(["q-0-6", "q-4-5"]);
    }, 30_000);
});

// ---------------------------------------------------------------------------
// CLI batch（DSH 评估 2026-11-26 #6）：开关 / 层通配 / commandFile
// ---------------------------------------------------------------------------
describe("CLI batch：开关 / 层通配 / commandFile（DSH 评估 2026-11-26 #6）", () => {
    const cliDir = mkdtempSync(join(tmpdir(), "fx-batch-cli-"));
    const fwd = (p: string) => p.replace(/\\/g, "/");
    const layerStore = fwd(join(cliDir, "layers.json"));
    writeFileSync(layerStore, JSON.stringify({
        "fx-a": { driver: "local" }, "fx-b": { driver: "local" }, "fx-c": { driver: "local" }, "keep": { driver: "local" },
    }));
    const cli = (args: string[], plan: unknown) => {
        const r = Bun.spawnSync([process.execPath, "bin/filaxis.ts", "batch", "--no-daemon", ...args, "--stdin-json"], {
            stdin: Buffer.from(JSON.stringify(plan)),
            stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, FILAXIS_LAYERS: layerStore }, // 层文件隔离：不碰 ~/.filaxis/layers.json
        });
        return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode };
    };
    const snap = { steps: [{ id: "hi", kind: "exec", command: "printf x" }] };

    test("--layer 通配与计划内通配：按已存层名展开为 hi@<层>；未命中的层不执行", () => {
        const byFlag = cli(["--layer", "fx-*"], snap);
        expect(byFlag.code).toBe(0);
        for (const l of ["fx-a", "fx-b", "fx-c"]) expect(byFlag.out).toContain(`[ok] hi@${l} (exec`);
        expect(byFlag.out).not.toContain("hi@keep");
        expect(byFlag.out).not.toContain("[ok] hi (exec"); // 不再在默认层（本机）多跑一遍
        const byPlan = cli([], { ...snap, layer: "fx-?" });
        expect(byPlan.code).toBe(0);
        expect(byPlan.out).toContain("[ok] hi@fx-b (exec");
        expect(byPlan.out).not.toContain("hi@keep");
    }, 60_000);

    test("通配无匹配：整批拒绝、零输出（不把 'zz-*' 当层名、更不落到默认层执行）", () => {
        const r = cli(["--layer", "zz-*"], snap);
        expect(r.code).toBe(1);
        expect(r.out).toBe("");
        expect(r.err).toContain("未匹配任何已注册层或已存层");
    }, 30_000);

    test("CLI batch keeps plan validation errors after wildcard support", () => {
        for (const [plan, message] of [
            [{ layer: "*", steps: {} }, "steps"],
            [{ ...snap, layer: 123 }, "需为非空字符串"],
            [{ ...snap, layer: ["fx-a", "fx-a"] }, "含重复层名"],
            [{ ...snap, layer: ["fx-*", "fx-*"] }, "含重复层名"],
            [{ steps: [{ id: "read", kind: "read", path: "x", commandFile: "a.sh" }] }, "只支持 kind='exec'"],
        ] as const) {
            const r = cli([], plan);
            expect(r.code).toBe(1);
            expect(r.out).toBe("");
            expect(r.err).toContain(message);
            expect(r.err).toContain("批次计划非法");
        }
    }, 30_000);

    test("--no-stop-on-fail：失败后其余步骤照看（缺省失败即停时标 skipped）；--max-parallel 1 保序", () => {
        const plan = { steps: [{ id: "boom", kind: "exec", command: "exit 7" }, { id: "rest", kind: "exec", command: "printf SURVIVED" }] };
        const fastFail = cli(["--max-parallel", "1"], plan);
        expect(fastFail.code).toBe(1);
        expect(fastFail.out).toContain("[fail] boom (exec");
        expect(fastFail.out).toContain("[skipped] rest");
        expect(fastFail.out).not.toContain("SURVIVED"); // 缺省：一台失败，其余都不看
        const inspect = cli(["--max-parallel", "1", "--no-stop-on-fail"], plan);
        expect(inspect.code).toBe(1); // 有失败步骤，批次整体仍报 fail
        expect(inspect.out).toContain("[fail] boom (exec");
        expect(inspect.out).toContain("[ok] rest (exec");
        expect(inspect.out).toContain("SURVIVED");
    }, 60_000);

    test("命令行开关覆盖计划里的 stopOnFail / maxParallel", () => {
        // 可观测的执行顺序与副作用：boom 睡 0.4s 后才写文件再失败；rest 立即写。
        // 计划里写的是「失败即停 + 并行度 8」（rest 会抢在 boom 前面落笔）——命令行
        // --max-parallel 1 --no-stop-on-fail 必须盖过它：rest 照看，且排在 boom 之后
        const order = fwd(join(cliDir, "order.txt"));
        const plan = {
            stopOnFail: true, maxParallel: 8,
            steps: [
                { id: "boom", kind: "exec", command: `sleep 0.4; printf boom >> ${order}; exit 7` },
                { id: "rest", kind: "exec", command: `printf rest >> ${order}` },
            ],
        };
        const overridden = cli(["--max-parallel", "1", "--no-stop-on-fail"], plan);
        expect(overridden.out).toContain("[ok] rest (exec"); // --no-stop-on-fail 胜出：其余步骤照看
        expect(readFileSync(order, "utf-8")).toBe("boomrest"); // --max-parallel 1 胜出：rest 在 boom 之后
        rmSync(order, { force: true });
        // 对照：不给开关，计划里的并行度 8 生效——rest 抢先落笔
        const asPlanned = cli([], plan);
        expect(readFileSync(order, "utf-8").startsWith("rest")).toBe(true);
    }, 60_000);

    test("--max-parallel 参数校验：0 与非数字拒绝；负数/缺值按 batch 参数规则拒绝；一律零输出", () => {
        for (const bad of ["0", "abc"]) {
            const r = cli(["--max-parallel", bad], snap);
            expect(r.code).toBe(1);
            expect(r.out).toBe("");
            expect(r.err).toContain("--max-parallel 需要一个正数字");
        }
        // 以 - 开头的值被 batch 的参数预检当成下一个选项（既有规则）
        const negative = cli(["--max-parallel", "-1"], snap);
        expect(negative.code).toBe(1);
        expect(negative.out).toBe("");
        expect(negative.err).toContain("--max-parallel 需要参数值");
        const missing = Bun.spawnSync([process.execPath, "bin/filaxis.ts", "batch", "--no-daemon", "--stdin-json", "--max-parallel"], {
            stdin: Buffer.from(JSON.stringify(snap)), stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, FILAXIS_LAYERS: layerStore },
        });
        expect(missing.exitCode).toBe(1);
        expect(missing.stdout.toString()).toBe("");
        expect(missing.stderr.toString()).toContain("--max-parallel 需要参数值");
    }, 60_000);

    test("commandFile：exec 步骤引用脚本文件（相对路径按调用方工作目录；引号/$()/多行零转义）", () => {
        const script = fwd(join(cliDir, "snap.sh"));
        writeFileSync(script, "echo \"## $(hostname)\"\nprintf '%s\\n' \"it's\" 'a \"quoted\" word'\n");
        const abs = cli([], { steps: [{ id: "cf", kind: "exec", commandFile: script }] });
        expect(abs.code).toBe(0);
        expect(abs.out).toContain("[ok] cf (exec");
        expect(abs.out).toContain("## ");
        expect(abs.out).toContain('a "quoted" word');
        // 相对路径：相对 CLI 进程的工作目录（CLI 入口用绝对路径，工作目录切到临时目录）
        const rel = Bun.spawnSync([process.execPath, fwd(join(process.cwd(), "bin/filaxis.ts")), "batch", "--no-daemon", "--stdin-json"], {
            cwd: cliDir,
            stdin: Buffer.from(JSON.stringify({ steps: [{ id: "cf", kind: "exec", commandFile: "snap.sh" }] })),
            stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, FILAXIS_LAYERS: layerStore },
        });
        expect(rel.exitCode).toBe(0);
        expect(rel.stdout.toString()).toContain("it's");
        // 读不出：整批拒绝、零输出
        const absent = cli([], { steps: [{ id: "cf", kind: "exec", commandFile: fwd(join(cliDir, "absent.sh")) }] });
        expect(absent.code).toBe(1);
        expect(absent.out).toBe("");
        expect(absent.err).toContain("commandFile 读取失败");
    }, 60_000);

    afterAll(() => {
        rmSync(cliDir, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// CLI exec 输出（DSH 评估 2026-11-26 #5c）：完成标记原先紧跟 stdout 写入就发 stderr
// ---------------------------------------------------------------------------
describe("CLI exec 输出（DSH 评估 2026-11-26 #5c）", () => {
    test("--json：单行结构化结果——退出码/用户/两路输出分字段，进程退出码照常透传", async () => {
        const { userInfo } = await import("node:os");
        const r = Bun.spawnSync(
            [process.execPath, "bin/filaxis.ts", "exec", "--no-daemon", "--json", "--", "printf 'a\\nb\\n'; printf 'e' >&2; exit 3"],
            { stdout: "pipe", stderr: "pipe", windowsHide: true },
        );
        expect(r.stderr.toString()).toBe(""); // 不再往 stderr 写「[exit=N user=…]」标记行
        expect(r.stdout.toString().trimEnd().split("\n")).toHaveLength(1); // 单行
        const parsed = JSON.parse(r.stdout.toString()) as { exitCode: number; effectiveUser: unknown; stdout: string; stderr: string };
        expect(parsed.exitCode).toBe(3);
        expect(parsed.stdout).toBe("a\nb\n");
        expect(parsed.stderr).toBe("e");
        expect(parsed.effectiveUser).toBe(userInfo().username); // 本地层：执行用户=本机登录用户
        expect(r.exitCode).toBe(3);
    }, 30_000);

    test("--out：完整输出落盘并与内容逐字节一致，终端只打头几行和路径；stderr 另存", async () => {
        const { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const d = mkdtempSync(join(tmpdir(), "fx-out-"));
        try {
            const out = join(d, "nested", "o.txt").replace(/\\/g, "/");
            const r = Bun.spawnSync(
                [process.execPath, "bin/filaxis.ts", "exec", "--no-daemon", "--out", out, "--", "seq 1 100; printf 'e' >&2; exit 0"],
                { stdout: "pipe", stderr: "pipe", windowsHide: true },
            );
            expect(r.exitCode).toBe(0);
            const shown = r.stdout.toString();
            // 终端只有头 15 行 + 一行交代；文件里是全部 100 行
            expect(shown.split("\n").filter((l) => /^\d+$/.test(l))).toHaveLength(15);
            expect(shown).toContain("共 100 行");
            expect(shown).toContain("o.txt");
            const file = readFileSync(out, "utf-8");
            expect(file.split("\n").filter(Boolean)).toHaveLength(100);
            expect(readFileSync(`${out}.stderr`, "utf-8")).toBe("e");
            expect(r.stderr.toString()).toContain("[exit=0");
            expect(r.stderr.toString()).toContain("已核对");

            // --json：给路径与字节数，不再把正文塞进响应
            const jr = Bun.spawnSync(
                [process.execPath, "bin/filaxis.ts", "exec", "--no-daemon", "--json", "--out", join(d, "j.txt").replace(/\\/g, "/"), "--", "seq 1 3"],
                { stdout: "pipe", stderr: "pipe", windowsHide: true },
            );
            const parsed = JSON.parse(jr.stdout.toString()) as { out: { stdout_bytes: number; stdout_lines: number }; stdout?: string };
            expect(parsed.out.stdout_lines).toBe(3);
            expect(parsed.out.stdout_bytes).toBe(6);
            expect(parsed.stdout).toBeUndefined();
            expect(jr.exitCode).toBe(0);
        } finally {
            rmSync(d, { recursive: true, force: true });
        }
    }, 30_000);

    test("batch --out-dir：每个 exec 步骤各落 stdout/stderr 文件，终端只打头几行", async () => {
        const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const d = mkdtempSync(join(tmpdir(), "fx-outdir-"));
        try {
            const plan = { steps: [
                { id: "big", kind: "exec", command: "seq 1 40; printf 'E\\n' >&2" },
                { id: "small", kind: "exec", command: "echo one" },
            ] };
            const r = Bun.spawnSync(
                [process.execPath, "bin/filaxis.ts", "batch", "--no-daemon", "--out-dir", d.replace(/\\/g, "/"), "--stdin-json"],
                { stdin: Buffer.from(JSON.stringify(plan)), stdout: "pipe", stderr: "pipe", windowsHide: true },
            );
            expect(r.exitCode).toBe(0);
            const files = readdirSync(d).sort();
            expect(files).toEqual(["big.stderr", "big.stdout", "small.stdout"]);
            expect(readFileSync(join(d, "big.stdout"), "utf-8").split("\n").filter(Boolean)).toHaveLength(40);
            expect(readFileSync(join(d, "big.stderr"), "utf-8")).toBe("E\n");
            expect(readFileSync(join(d, "small.stdout"), "utf-8")).toBe("one\n");
            const shown = r.stdout.toString();
            expect(shown.split("\n").filter((l) => /^\d+$/.test(l))).toHaveLength(15); // big 只显示头 15 行
            expect(shown).toContain("one"); // 没截断的小输出照常显示
            expect(shown).toContain("完整输出 3 个文件");
        } finally {
            rmSync(d, { recursive: true, force: true });
        }
    }, 30_000);

    const sh = process.env.FILAXIS_SHELL || Bun.which("sh");
    test.skipIf(!sh)("文本模式经 2>&1 合流：完成标记恒在末尾，正文一行不少", () => {
        const n = 20000;
        // 经 sh 合流（与调用方写 `filaxis … 2>&1` 同形）。大输出下 stdout 是异步排队——
        // 标记若不等它排空就发 stderr，合流后就会插进正文中间
        const command = `i=1; while [ "$i" -le ${n} ]; do echo "$i"; i=$((i + 1)); done`;
        const r = Bun.spawnSync([sh!, "-c", `${JSON.stringify(process.execPath)} bin/filaxis.ts exec --no-daemon -- '${command}' 2>&1`], {
            stdout: "pipe", stderr: "pipe", windowsHide: true,
        });
        const lines = r.stdout.toString().split(/\r?\n/);
        const markerIdx = lines.findIndex((l) => /^\[exit=0 user=/.test(l));
        expect(markerIdx).toBeGreaterThan(n); // 标记在全部正文之后
        expect(lines.slice(markerIdx + 1).join("")).toBe(""); // 标记之后没有任何正文
        expect(lines[0]).toBe("1");
        expect(lines[n - 1]).toBe(String(n));
        expect(r.exitCode).toBe(0);
    }, 60_000);
});

// ---------------------------------------------------------------------------
// CLI 已存层分派（DSH 评估 2026-11-26 排查中顺带发现）：一次性模式曾把任何已存层
// 无条件包成 SSH 驱动——driver:"local" 的条目变成对空主机名的 ssh 连接
// ---------------------------------------------------------------------------
describe("CLI 已存层分派（一次性模式）", () => {
    test("按 descriptor 的 driver 分派：local 层本地执行；不认识的 driver 由中层明确报错——不再一律当 SSH", () => {
        const d = mkdtempSync(join(tmpdir(), "fx-batch-saved-"));
        const store = join(d, "layers.json");
        writeFileSync(store, JSON.stringify({ loc: { driver: "local" }, odd: { driver: "tmux" } }));
        const run = (layer: string) => Bun.spawnSync([process.execPath, "bin/filaxis.ts", "exec", "--no-daemon", "--layer", layer, "--", "printf LOCAL_OK"], {
            stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, FILAXIS_LAYERS: store }, // 层文件隔离
        });
        try {
            const local = run("loc");
            expect(local.stdout.toString()).toContain("LOCAL_OK");
            expect(local.exitCode).toBe(0);
            // 修前：new SshPtyDriver({driver:"local"}) → ssh 连空主机名（落到 localhost 的 sshd）
            expect(local.stderr.toString()).not.toContain("Permission denied");
            const odd = run("odd");
            expect(odd.exitCode).toBe(1);
            expect(odd.stdout.toString()).toBe("");
            // 0.3.0：层由中层统一登记，不认识的 driver 由中层（层栈）报错并指出补法——
            // 经 Daemon 与一次性模式不再是两句不同的提示
            expect(odd.stderr.toString()).toContain("Unknown driver 'tmux'");
            expect(odd.stderr.toString()).not.toContain("Permission denied");
        } finally {
            rmSync(d, { recursive: true, force: true });
        }
    }, 30_000);
});
