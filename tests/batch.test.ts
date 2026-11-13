/**
 * 批次组合（runBatch）测试——local driver 真跑：
 * DAG 依赖边 / fail-fast / 多 hunk 原子 / expectExit / 计划校验 / CLI 冒烟
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntimeDriver } from "../src/local-driver.js";
import { runBatch, editFileMulti } from "../src/index.js";
import { createAgentToolkit } from "../src/agent-toolkit.js";
import { RuntimeStack } from "../src/runtime-stack.js";

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
        const out = execSync(`bun bin/filaxis.ts batch --request-file "${plan}"`, { encoding: "utf-8" });
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
            execSync(`bun bin/filaxis.ts batch --request-file "${plan2}"`, { encoding: "utf-8", stdio: "pipe" });
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
