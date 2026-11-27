/**
 * local-driver 单测（AC-04 exec 语义：stderr 分离/退出码如实/marker effectiveUser/timeout/abort）
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntimeDriver } from "../src/core/local/local-driver.js";

const execDir = join(tmpdir(), "filaxis-test-exec");

test("local session inherits layer cwd and rejects a missing explicit cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-session-cwd-"));
    const drv = new LocalRuntimeDriver({ cwd: dir, execDir: join(dir, "logs") });
    try {
        writeFileSync(join(dir, "fixture"), "in-layer");
        const session = await drv.execSession("cat fixture");
        await waitFor(() => drv.sessions.sessionState(session.sessionId)?.status === "exited");
        expect((await drv.readSessionLog(session.sessionId, { stream: "stdout" })).trim()).toBe("in-layer");
        await expect(drv.execSession("echo bad", { cwd: join(dir, "missing") })).rejects.toThrow();
        expect(drv.listSessions().map(({ sessionId }) => sessionId)).toEqual([session.sessionId]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}, 30_000);

/** 轮询等待谓词为真（flake 治理：全量并发下 Defender/负载可拖慢子进程与异步
 *  落盘——固定睡眠窗曾连续五轮在不同用例上翻车，一律改有界轮询） */
async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
        if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
        await new Promise((r) => setTimeout(r, 20));
    }
}

describe("LocalRuntimeDriver.exec（AC-04）", () => {
    test("stdout/stderr 物理分离 + marker effectiveUser + 退出码如实", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const r = await drv.exec("echo to-out; echo to-err 1>&2; exit 3");
        // 字节保真：尾换行保留；stderr 独立
        expect(r.stdout).toBe("to-out\n");
        expect(r.stderr).toBe("to-err\n");
        expect(r.exitCode).toBe(3); // 非零不抛异常（退出码是数据）
        expect(typeof r.effectiveUser).toBe("string");
        expect(r.effectiveUser!.length).toBeGreaterThan(0);
    }, 20_000); // flake 治理：真子进程冷启动可超 bun 默认 5s

    test("用户命令内写 exit 也不丢退出码（$? 变量锁，锦囊 3）", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const r = await drv.exec("exit 42");
        expect(r.exitCode).toBe(42);
        expect(r.effectiveUser).toBeTruthy();
    }, 20_000); // flake 治理同上

    test("脚本语法错误仍有完成哨兵，heredoc 和末尾注释可正常执行", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        expect(await drv.exec("if true; then\n  echo unfinished")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("syntax error") });
        expect(await drv.exec("cat <<'END'\n'quoted' $HOME\nEND\n# final comment")).toMatchObject({ exitCode: 0, stdout: "'quoted' $HOME\n" });
    }, 20_000);

    test("exec 审计留痕：status.json 落盘 completed", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const before = new Set(readdirSync(execDir));
        await drv.exec("echo audit");
        const statusFiles = readdirSync(execDir).filter((f) => f.endsWith(".status.json") && !before.has(f));
        expect(statusFiles).toHaveLength(1);
        const status = JSON.parse(readFileSync(join(execDir, statusFiles[0]!), "utf-8"));
        expect(status.status).toBe("completed");
    }, 20_000); // flake 治理同上

    test("timeout：超时 reject 且进程后台留日志", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        await expect(drv.exec("sleep 5", { timeoutMs: 300 })).rejects.toThrow(/timeout/i);
    }, 20_000); // flake 治理同上

    test("AbortSignal：abort 杀进程并 AbortError reject", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const ac = new AbortController();
        const p = drv.exec("sleep 5", { signal: ac.signal });
        setTimeout(() => ac.abort(), 200);
        await expect(p).rejects.toMatchObject({ name: "AbortError" });
    }, 20_000); // flake 治理同上

    test('channel:"pty" 显式拒绝（local 无 PTY 层）', async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        await expect(drv.exec("echo x", { channel: "pty" })).rejects.toThrow(/pty/);
    });

    test("cwd 与 env 生效", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const r = await drv.exec("pwd; echo $FX_TEST_VAR", {
            env: { FX_TEST_VAR: "filaxis-yes" },
        });
        expect(r.stdout).toContain("filaxis-yes");
    }, 20_000); // flake 治理同上
});

describe("LocalRuntimeDriver fs + 会话族", () => {
    test("readdir 按配置的 cwd 解析相对路径及条目元数据", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-local-readdir-"));
        try {
            const drv = new LocalRuntimeDriver({ cwd: dir, execDir });
            writeFileSync(join(dir, "fixture.txt"), "hello");
            const entries = await drv.fs.readdir(".");
            expect(entries).toEqual([
                { name: "fixture.txt", size: 5, isDirectory: false, mtime: expect.any(Number) },
            ]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("fs 全家桶 roundtrip", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const dir = join(execDir, "fs-test");
        await drv.fs.mkdir(dir, { recursive: true });
        const f = join(dir, "a.txt");
        await drv.fs.writeFile(f, "hello 牵丝");
        expect(await drv.fs.readFile(f)).toBe("hello 牵丝");
        expect(await drv.fs.exists(f)).toBe(true);
        expect((await drv.fs.stat!(f))!.size).toBeGreaterThan(0);
        const entries = await drv.fs.readdir(dir);
        expect(entries.some((e) => e.name === "a.txt")).toBe(true);
        expect(await drv.fs.readBase64!(f)).toBe(Buffer.from("hello 牵丝").toString("base64"));
        await drv.fs.rm(f);
        expect(await drv.fs.exists(f)).toBe(false);
    });

    test("execSession 委托会话引擎（双文件句柄）", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const h = await drv.execSession("echo s-out; echo s-err 1>&2");
        expect(h.sessionId).toBeTruthy();
        // 等退出（有界轮询——固定 300ms 曾在全量并发下不足，bash 冷启动可 >5s）
        await waitFor(() => drv.listSessions().find((s) => s.sessionId === h.sessionId)?.running === false);
        expect(await drv.readSessionLog(h.sessionId, { stream: "stdout" })).toBe("s-out");
        expect(await drv.readSessionLog(h.sessionId, { stream: "stderr" })).toBe("s-err");
        const sessions = drv.listSessions();
        expect(sessions.some((s) => s.sessionId === h.sessionId)).toBe(true);
    }, 20_000);
});

// ── 审查问题 3 回归：错误与审计状态对齐 ──
describe("local exec 审计与错误语义对齐（审查收口批）", () => {
    /** 快照差分：拿本次 exec 新增的 status 文件（readdir 顺序非时序——不能取末位） */
    function statusOfNewFile(before: Set<string>): Record<string, unknown> | null {
        const fresh = readdirSync(execDir).filter((f) => f.endsWith(".status.json") && !before.has(f));
        if (fresh.length === 0) return null;
        return JSON.parse(readFileSync(join(execDir, fresh[0]!), "utf-8"));
    }

    test("超时：reject 挂 outcome=unknown；状态文件记 timeout（exitCode null 非 0）", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const before = new Set(readdirSync(execDir));
        const p = drv.exec("sleep 30", { timeoutMs: 600 });
        await expect(p).rejects.toMatchObject({ outcome: "unknown" });
        // 状态异步落盘——有界轮询（固定 250ms 曾在全量并发下不足）
        await waitFor(() => statusOfNewFile(before)?.["status"] === "timeout");
        const st = statusOfNewFile(before);
        expect(st?.["status"]).toBe("timeout");
        expect(st?.["exitCode"]).toBeNull();
    }, 25_000);

    test("超时后进程晚死：close 不把 timeout 覆写成 completed", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const before = new Set(readdirSync(execDir));
        const p = drv.exec("sleep 2", { timeoutMs: 500 });
        await expect(p).rejects.toMatchObject({ outcome: "unknown" });
        await waitFor(() => statusOfNewFile(before)?.["status"] === "timeout");
        const statusFileOf = () => statusOfNewFile(before);
        expect(statusFileOf()?.["status"]).toBe("timeout");
        await new Promise((r) => setTimeout(r, 4000)); // 进程已自然死亡（close 已触发）
        expect(statusFileOf()?.["status"]).toBe("timeout"); // 未被覆写
    }, 30_000);

    test("abort：AbortError 挂 outcome=unknown；状态记 aborted", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const before = new Set(readdirSync(execDir));
        const ac = new AbortController();
        const p = drv.exec("sleep 30", { signal: ac.signal, timeoutMs: 60_000 });
        setTimeout(() => ac.abort(), 400);
        await expect(p).rejects.toMatchObject({ name: "AbortError", outcome: "unknown" });
        await waitFor(() => statusOfNewFile(before)?.["status"] === "aborted");
        const st = statusOfNewFile(before);
        expect(st?.["status"]).toBe("aborted");
        expect(st?.["exitCode"]).toBeNull();
    }, 25_000);

    // GPT Astra 九轮 P1：`shell -s` 后 stdin.write 无 error 监听——shell 流式解析
    // 撞语法错**秒退**时，继续写管道抛 write EOF → uncaught exception 崩**宿主
    // 进程**（外层 try/catch 捕不住）。修前本测试直接把 bun test 进程带崩。
    // flake 治理（Sol 69 后专项）：原「语法错秒退」是竞态触发——全量并发下 bash
    // 起得慢，2MB 在其死亡前全进管道缓冲 → 正常 resolve → 断言翻车（两轮快速
    // 失败实证）。另 exit-N 只退子壳（wrapper 的 ( ) 隔离）哨兵照跑。改用
    // kill -9 $$ 杀**顶层 shell**：无哨兵必然发生（与负载无关的确定性），
    // 且 shell 睡眠期间不读 stdin——写方在管道缓冲处阻塞、死亡即 EPIPE
    test("stdin 管道断裂不崩宿主：shell 提前被杀（不读 stdin）+ 2MB 尾巴 → reject unknown", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const cmd = "sleep 0.3; kill -9 $$\n" + "#".repeat(2 * 1024 * 1024);
        await expect(drv.exec(cmd, { timeoutMs: 15_000 })).rejects.toMatchObject({ outcome: "unknown" });
    }, 25_000);
});

// ---------------------------------------------------------------------------
// REQ-0004 M6 同构用例集踩出：本机层的工作目录不存在时，spawn 报的是
// 「ENOENT … uv_spawn 'bash'」——看着像没装 bash，其实与 bash 无关。把原因说直。
// ---------------------------------------------------------------------------
describe("本机层工作目录不存在时的报错", () => {
    test("exec 直接拒绝并点名目录，不再报成找不到 shell；命令零副作用", async () => {
        const base = mkdtempSync(join(tmpdir(), "fx-local-nocwd-"));
        const missing = join(base, "gone");
        try {
            const drv = new LocalRuntimeDriver({ cwd: missing, execDir: join(base, "exec") });
            let caught: unknown;
            try { await drv.exec("echo side-effect"); } catch (e) { caught = e; }
            expect(caught).toBeInstanceOf(Error);
            expect((caught as Error).message).toContain("工作目录不存在");
            expect((caught as Error).message).toContain(missing);
            expect((caught as Error).message).not.toContain("uv_spawn");
            // per-exec cwd 覆盖同样先查
            const plain = new LocalRuntimeDriver({ execDir: join(base, "exec") });
            await expect(plain.exec("echo x", { cwd: missing })).rejects.toThrow(/工作目录不存在/);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
        // 预算 30s：本机驱动构造时探测 shell（扫 PATH）在负载高的机器上要几秒
    }, 30_000);
});
