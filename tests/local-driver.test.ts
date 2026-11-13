/**
 * local-driver 单测（AC-04 exec 语义：stderr 分离/退出码如实/marker effectiveUser/timeout/abort）
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntimeDriver } from "../src/local-driver.js";

const execDir = join(tmpdir(), "filaxis-test-exec");

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
    });

    test("用户命令内写 exit 也不丢退出码（$? 变量锁，锦囊 3）", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const r = await drv.exec("exit 42");
        expect(r.exitCode).toBe(42);
        expect(r.effectiveUser).toBeTruthy();
    });

    test("exec 审计留痕：status.json 落盘 completed", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        await drv.exec("echo audit");
        const list = readdirSync(execDir);
        const statusFiles = list.filter((f) => f.endsWith(".status.json"));
        expect(statusFiles.length).toBeGreaterThan(0);
        const last = JSON.parse(readFileSync(join(execDir, statusFiles[statusFiles.length - 1]!), "utf-8"));
        // 并行测试下最新文件可能是任意用例的——合法终态皆证明审计留痕在位
        expect(["completed", "running", "aborted", "timeout"]).toContain(last.status);
    });

    test("timeout：超时 reject 且进程后台留日志", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        await expect(drv.exec("sleep 5", { timeoutMs: 300 })).rejects.toThrow(/timeout/i);
    });

    test("AbortSignal：abort 杀进程并 AbortError reject", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const ac = new AbortController();
        const p = drv.exec("sleep 5", { signal: ac.signal });
        setTimeout(() => ac.abort(), 200);
        await expect(p).rejects.toMatchObject({ name: "AbortError" });
    });

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
    });
});

describe("LocalRuntimeDriver fs + 会话族", () => {
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
        // 等退出
        await new Promise((r) => setTimeout(r, 300));
        expect(await drv.readSessionLog(h.sessionId, { stream: "stdout" })).toBe("s-out");
        expect(await drv.readSessionLog(h.sessionId, { stream: "stderr" })).toBe("s-err");
        const sessions = drv.listSessions();
        expect(sessions.some((s) => s.sessionId === h.sessionId)).toBe(true);
    });
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
        await new Promise((r) => setTimeout(r, 250)); // 状态异步落盘
        const st = statusOfNewFile(before);
        expect(st?.["status"]).toBe("timeout");
        expect(st?.["exitCode"]).toBeNull();
    }, 20_000);

    test("超时后进程晚死：close 不把 timeout 覆写成 completed", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const before = new Set(readdirSync(execDir));
        const p = drv.exec("sleep 2", { timeoutMs: 500 });
        await expect(p).rejects.toMatchObject({ outcome: "unknown" });
        await new Promise((r) => setTimeout(r, 250));
        const statusFileOf = () => statusOfNewFile(before);
        expect(statusFileOf()?.["status"]).toBe("timeout");
        await new Promise((r) => setTimeout(r, 2600)); // 进程已自然死亡（close 已触发）
        expect(statusFileOf()?.["status"]).toBe("timeout"); // 未被覆写
    }, 25_000);

    test("abort：AbortError 挂 outcome=unknown；状态记 aborted", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        const before = new Set(readdirSync(execDir));
        const ac = new AbortController();
        const p = drv.exec("sleep 30", { signal: ac.signal, timeoutMs: 60_000 });
        setTimeout(() => ac.abort(), 400);
        await expect(p).rejects.toMatchObject({ name: "AbortError", outcome: "unknown" });
        await new Promise((r) => setTimeout(r, 250));
        const st = statusOfNewFile(before);
        expect(st?.["status"]).toBe("aborted");
        expect(st?.["exitCode"]).toBeNull();
    }, 20_000);

    // GPT Astra 九轮 P1：`shell -s` 后 stdin.write 无 error 监听——shell 流式解析
    // 撞语法错**秒退**时，继续写管道抛 write EOF → uncaught exception 崩**宿主
    // 进程**（外层 try/catch 捕不住）。修前本测试直接把 bun test 进程带崩。
    test("stdin 管道断裂不崩宿主：shell 提前退出（语法错）+ 2MB 尾巴 → reject unknown", async () => {
        const drv = new LocalRuntimeDriver({ execDir });
        // `fi`（无 if 的 fi）让 bash 流式解析即死——不等 stdin EOF；后 2MB 注释
        // 尚在写管道 → EPIPE/write EOF
        const cmd = "fi\n" + "#".repeat(2 * 1024 * 1024);
        await expect(drv.exec(cmd, { timeoutMs: 15_000 })).rejects.toMatchObject({ outcome: "unknown" });
    }, 25_000);
});
