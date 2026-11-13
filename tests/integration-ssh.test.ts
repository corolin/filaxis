/**
 * SSH 真机集成（CI 专用——环境门控 FILAXIS_IT=1 才跑；本机/常规 bun test 自动跳过）
 *
 * CI 形态（.github/workflows/ci.yml）：ubuntu runner 自环 ssh localhost
 * （ed25519 免密）+ tmux——覆盖 AC-02/AC-04 远端面：PtyLink 建链握手、
 * exec 双通道 stderr 分离、层内 cwd/env、远端会话 .code 终态、文件传输双校验。
 */
import { describe, expect, test } from "bun:test";
import { SshPtyDriver } from "../src/ssh-pty-driver.js";
import { StreamSessionManager } from "../src/stream-session-manager.js";
import { putFile, getFile } from "../src/file-transfer.js";
import { probeDialect } from "../src/dialect.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IT = process.env.FILAXIS_IT === "1";
const TARGET = process.env.FILAXIS_IT_SSH || "localhost";

describe("SSH 真机集成（AC-02/04/15 远端面）", () => {
    test("exec 通道：stderr 物理分离 + marker effectiveUser + 退出码", async () => {
        if (!IT) return console.log("[skip] FILAXIS_IT≠1——CI 矩阵专用");
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const r = await drv.exec("echo i-out; echo i-err 1>&2; exit 5");
            expect(r.stdout.trim()).toBe("i-out");
            expect(r.stderr.trim()).toBe("i-err"); // 物理分离
            expect(r.exitCode).toBe(5);
            expect(r.effectiveUser).toBeTruthy();
        } finally {
            await drv.destroy();
        }
    }, 60_000);

    test("pty 通道：层内交互语义（exec marker 协议）", async () => {
        if (!IT) return;
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const r = await drv.exec("cd /tmp && pwd", { channel: "pty" });
            expect(r.stdout.trim()).toBe("/tmp");
            const r2 = await drv.exec("pwd", { channel: "pty" }); // 层内状态保持
            expect(r2.stdout.trim()).toBe("/tmp");
        } finally {
            await drv.destroy();
        }
    }, 60_000);

    test("远端会话：nohup .code 终态 + 双文件", async () => {
        if (!IT) return;
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const h = await drv.execSession("echo s-out; echo s-err 1>&2; exit 9");
            await new Promise((r) => setTimeout(r, 2500)); // 等 .code 落盘（轮询 1.5s 周期）
            const out = await drv.readSessionLog(h.sessionId, { stream: "stdout" });
            const err = await drv.readSessionLog(h.sessionId, { stream: "stderr" });
            expect(out).toBe("s-out");
            expect(err).toBe("s-err");
        } finally {
            await drv.destroy();
        }
    }, 60_000);

    test("观察流：真流式 + 双流标记 + 衰减回收", async () => {
        if (!IT) return;
        const m = new StreamSessionManager([TARGET]);
        const events: Array<{ type: string; stream?: string }> = [];
        m.onEvent = (e) => events.push(e as never);
        const { sessionId } = await m.start("echo L1; echo E1 1>&2; sleep 2");
        await new Promise((r) => setTimeout(r, 1500));
        const lines = m.tailLines(sessionId);
        expect(lines.some((l) => l.stream === "stdout" && l.text === "L1")).toBe(true);
        expect(lines.some((l) => l.stream === "stderr" && l.text === "E1")).toBe(true);
        m.reapIdle(Date.now() + 60_000, 1); // 强制回收
        expect(events.some((e) => e.type === "exit")).toBe(true);
    }, 60_000);

    test("文件传输：方言探测（真机）+ put/get 双校验 roundtrip", async () => {
        if (!IT) return;
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const dialect = await probeDialect((cmd) => drv.exec(cmd));
            expect(["gnu", "bsd", "busybox", "openssl-fallback"]).toContain(dialect.family);
            const dir = mkdtempSync(join(tmpdir(), "fx-it-"));
            const payload = Buffer.alloc(150 * 1024); // >128KB 触发多分块
            for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 251;
            const local = join(dir, "p.bin");
            writeFileSync(local, payload);
            await putFile((cmd) => drv.exec(cmd), dialect, local, "/tmp/fx-it-dst.bin");
            const back = join(dir, "b.bin");
            await getFile((cmd) => drv.exec(cmd), dialect, "/tmp/fx-it-dst.bin", back);
            expect(Buffer.compare(readFileSync(back), payload)).toBe(0);
            rmSync(dir, { recursive: true, force: true });
        } finally {
            await drv.destroy();
        }
    }, 120_000);

    // GPT Astra 十轮 #1/#2 + env 语义统一（真机实证）：
    // - cwd 是远端语义：远端专属目录（本地不存在）不得让本地 ssh spawn ENOENT
    // - getEnv 返回真实变量值（非 $KEY 字面量）；不存在 → undefined
    // - options.env 在远端生效（export 前缀——本地 ssh 进程灌 env 远端看不见）
    test("exec cwd/env/getEnv 语义（真机）：远端目录 + env 远端生效 + printenv 真值", async () => {
        if (!IT) return;
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            // #1：/tmp 远端必有、本地 Windows 无（本地 spawn 不吃 cwd——修前 ENOENT）
            const r = await drv.exec("pwd", { cwd: "/tmp", channel: undefined });
            expect(r.stdout.trim()).toBe("/tmp");
            // env 远端生效（exec 通道 export 前缀——export 后读展开值）
            const e = await drv.exec('printf %s "$FX_IT_MODE"', { env: { FX_IT_MODE: "remote-ok" } });
            expect(e.stdout).toBe("remote-ok");
            // #2：getEnv 真值 + 不存在 undefined + 非法名拒绝
            const home = await drv.getEnv("HOME");
            expect(home).toBeTruthy();
            expect(home).not.toContain("$");
            expect(await drv.getEnv("FX_NO_SUCH_VAR_9371")).toBeUndefined();
            await expect(drv.getEnv("BAD;NAME")).rejects.toThrow(/非法环境变量名/);
            // pty 通道 env 显式拒绝（键入回显物理语义）
            await expect(drv.exec("echo x", { channel: "pty", env: { A: "1" } })).rejects.toThrow(/不支持 env/);
        } finally {
            await drv.destroy();
        }
    }, 60_000);

    // -J 单层形态（ProxyJump 单命令——与 sshInto 派生层的 PTY 链形态互补）：
    // 认证全在发起端（跳板只转 TCP），exec 通道可用（ssh -J 自代理）。
    // CI 自环默认跳板 127.0.0.1：OpenSSH 自带跳板回环检测——-J localhost localhost
    // 直接拒绝（jumphost loop via localhost），127.0.0.1 与 localhost 字串不同绕开
    // 检测、物理仍同机中转。非标 sshd 端口的机器传 FILAXIS_IT_JUMP='[127.0.0.1]:2222'；
    // 真机跨跳板传 FILAXIS_IT_JUMP=<跳板别名>。
    test("-J 单层（ProxyJump）：exec 通道可用 + 双流分离 + 认证发起端直通", async () => {
        if (!IT) return;
        const jump = process.env.FILAXIS_IT_JUMP
            ?? (TARGET === "localhost" ? "127.0.0.1" : TARGET);
        const drv = new SshPtyDriver({
            driver: "ssh", target: TARGET,
            config: { connParams: { jump } },
        });
        await drv.init();
        try {
            const r = await drv.exec("echo via-jump; echo jerr 1>&2; exit 4");
            expect(r.stdout.trim()).toBe("via-jump");
            expect(r.stderr.trim()).toBe("jerr"); // exec 双流分离在 -J 形态同样成立
            expect(r.exitCode).toBe(4);
            expect(r.effectiveUser).toBeTruthy();
        } finally {
            await drv.destroy();
        }
    }, 60_000);
});

// ── 故障注入回归（第三轮实验 1A/1B——完成哨兵原则）──
describe("故障注入回归（哨兵原则，CI 真机）", () => {
    test("1B: abort 中断长命令 → AbortError reject（绝不 resolve 伪 exitCode:0）", async () => {
        if (!IT) return console.log("[skip] FILAXIS_IT≠1——CI 矩阵专用");
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const ac = new AbortController();
            const p = drv.exec("echo STEP_1_DONE; sleep 10", { signal: ac.signal, timeoutMs: 60_000 });
            await new Promise((r) => setTimeout(r, 1500));
            ac.abort();
            await expect(p).rejects.toMatchObject({ name: "AbortError" });
        } finally { await drv.destroy(); }
    }, 90_000);

    // TODO(第四轮故障注入): 外部死亡构造（杀 sshd/$PPID/断 TCP）在 CI 难稳定——
    // 交还 Gemini 沙箱（其手法已实证）；本仓 CI 覆盖 1B（abort 无哨兵 reject）路径
    test.skip("1A: 外部强杀本地 ssh 进程等价——无哨兵 → reject 附半截现场（不伪码）", async () => {
        if (!IT) return;
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const p = drv.exec("echo HALF_OUT; sleep 10", { timeoutMs: 60_000 });
            await new Promise((r) => setTimeout(r, 1500));
            // 等价外部强杀：再开一条 exec 用 pkill 杀同会话的 sleep（制造半途死亡）
            await drv.exec("pkill -9 -f 'sleep 10' 2>/dev/null; true", { timeoutMs: 15_000 });
            await expect(p).rejects.toThrow(/未完成|哨兵/);
        } finally { await drv.destroy(); }
    }, 90_000);
});

// ── 第四季回归：PTY 跨任务残影串台（temporal isolation）──
describe("第四季：PTY 残影串台回归（CI 真机）", () => {
    test("2B: A 超时 ^C 后紧跟 B——B 的 stdout 零串台（A 遗言与 A 的 130 trap 不入 B）", async () => {
        if (!IT) return console.log("[skip] FILAXIS_IT≠1——CI 矩阵专用");
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const a = drv.exec("echo A_LAST_WORDS; sleep 30", { timeoutMs: 1200 });
            await expect(a).rejects.toMatchObject({ outcome: "unknown" });
            // 紧跟 B：上一周期必须先 DRAINING 完成才放行（等 A 的 trap/?$ 终态）
            const b = await drv.exec("echo B_OK; exit 0", { timeoutMs: 30_000 });
            expect(b.stdout).not.toContain("A_LAST_WORDS");
            expect(b.stdout).not.toContain("_130_"); // A 的 ^C trap 遗言不进 B
            expect(b.stdout.trim()).toBe("B_OK");
            expect(b.exitCode).toBe(0);
        } finally { await drv.destroy(); }
    }, 90_000);
});

// ── 第九季：CLI 路径描述透传（--enter 重放 / --docker 糖全链路 / --hop 拒绝）──
describe("第九季：CLI 路径描述（CI 真机）", () => {
    test("--enter sh：exec 通道进入管线重放（stdin 管道零嵌套引用）", async () => {
        if (!IT) return console.log("[skip] FILAXIS_IT≠1——CI 矩阵专用");
        const { execSync } = await import("node:child_process");
        const out = execSync('bun bin/filaxis.ts exec --host localhost --enter sh -- "echo ENTER_OK"', { encoding: "utf-8" });
        expect(out).toContain("ENTER_OK");
    }, 60_000);

    test("--docker 糖：alpine 容器全链路（盲测场景复刻：exec + edit 免 Shell 通道）", async () => {
        if (!IT) return console.log("[skip] FILAXIS_IT≠1——CI 矩阵专用");
        const { execSync } = await import("node:child_process");
        execSync("docker rm -f fx-cli-it 2>/dev/null; docker run -d --name fx-cli-it alpine:latest sleep 300", { encoding: "utf-8" });
        try {
            const out = execSync(
                'bun bin/filaxis.ts exec --host localhost --docker fx-cli-it -- "echo DOCKER_OK; cat /etc/alpine-release"',
                { encoding: "utf-8" },
            );
            expect(out).toContain("DOCKER_OK");
            expect(out).toMatch(/\d+\.\d+\.\d+/); // alpine 版本行 = 命令真在容器里跑
            // edit 免 Shell 通道 × docker 组合（第九季主场景：容器内无 python/jq 也能受控编辑）
            const p = "/tmp/fx-cli-edit.json";
            execSync(`bun bin/filaxis.ts exec --host localhost --docker fx-cli-it -- "echo '{\\"k\\": 1}' > ${p}"`, { encoding: "utf-8" });
            const o2 = execSync(`bun bin/filaxis.ts edit --host localhost --docker fx-cli-it ${p} --stdin-json`, {
                input: JSON.stringify({ old: "1", new: "2" }),
                encoding: "utf-8",
            });
            expect(o2).toContain("1 处");
        } finally {
            execSync("docker rm -f fx-cli-it 2>/dev/null", { encoding: "utf-8" });
        }
    }, 180_000);

    test("--hop 链 exec 通道拒绝（不可直达语义自守——指引收敛 -J 或 pty 通道）", async () => {
        if (!IT) return console.log("[skip] FILAXIS_IT≠1——CI 矩阵专用");
        const { execSync } = await import("node:child_process");
        let errText = "";
        try {
            execSync('bun bin/filaxis.ts exec --host localhost --hop user@bastion:2222 -- "echo X"', { encoding: "utf-8", stdio: "pipe" });
        } catch (e) {
            errText = String((e as { stderr?: string }).stderr ?? (e as Error).message);
        }
        expect(errText).toContain("exec 通道无法复现多跳"); // 新文案（AI 可操作化后）
        expect(errText).toContain("-J");
        expect(errText).toContain("--pty"); // CLI 开关指引在场（不再是 SDK 术语死胡同）
    }, 60_000);
});

// ── 第十季：命名层注册表真机链（回环幂等 + 派生 + snapshot/restore）──
describe("第十季：命名层注册表（CI 真机）", () => {
    test("addLayer 回环幂等（末节点命中免探测复用）+ layerInto 派生 + snapshot/restore", async () => {
        if (!IT) return console.log("[skip] FILAXIS_IT≠1——CI 矩阵专用");
        const { RuntimeStack } = await import("../src/runtime-stack.js");
        const { enterStepsOf } = await import("../src/ssh-helpers.js");
        const stack = new RuntimeStack();
        const a = await stack.addLayer("lo", { driver: "ssh", target: TARGET });
        expect(a.reused).toBe(false);
        // 回环幂等：同落点（identity 末节点命中）→ 返回既有层句柄，不重复建连
        const b = await stack.addLayer("lo-again", { driver: "ssh", target: TARGET });
        expect(b.reused).toBe(true);
        expect(b.handle).toBe(a.handle);
        expect(b.reusedFrom).toBe("lo");
        // 派生：enter sh 管线继承追加
        const c = await stack.layerInto("lo", "inner", "sh");
        expect(enterStepsOf(c.descriptor.config as Record<string, unknown>).length).toBe(1);
        // 按名寻址执行（inner 层 exec 真跑）
        const r = await stack.layer("inner").driver.exec("echo LAYER_OK");
        expect(r.stdout).toContain("LAYER_OK");
        // snapshot/restore：移除后按快照重建（指纹缓存命中=零成本恢复）
        const snap = stack.snapshot();
        const origDriver = stack.layer("lo").driver;
        await stack.removeLayer("inner");
        await stack.removeLayer("lo");
        await stack.restore(snap);
        expect(stack.layer("lo").driver).toBe(origDriver);
        const r2 = await stack.layer("lo").driver.exec("echo RESTORE_OK");
        expect(r2.stdout).toContain("RESTORE_OK");
        await stack.removeLayer("inner", { destroy: true });
        await stack.removeLayer("lo", { destroy: true });
    }, 180_000);
});

// ── 第十一季：批量组合真机（ssh 层 DAG + fail-fast + CM 复用下的并行 exec）──
describe("第十一季：批量组合（CI 真机）", () => {
    test("runBatch ssh 层：改配置→验证（真 CAS+CM）→ fail-fast", async () => {
        if (!IT) return console.log("[skip] FILAXIS_IT≠1——CI 矩阵专用");
        const { runBatch } = await import("../src/batch.js");
        const drv = new SshPtyDriver({ driver: "ssh", target: TARGET });
        await drv.init();
        try {
            const p = "/tmp/fx-batch-it.conf";
            await drv.exec(`echo 'port=8080' > ${p}`);
            const ok = await runBatch(drv, {
                steps: [
                    { id: "edit", kind: "edit", path: p, hunks: [{ old: "port=8080", new: "port=9090" }] },
                    { id: "verify", kind: "exec", command: `grep -q 'port=9090' ${p}`, after: ["edit"] },
                    { id: "parallel", kind: "exec", command: "echo P1" }, // 无依赖——与 edit 并行
                ],
            });
            expect(ok.status).toBe("ok");
            expect(ok.steps.find((s) => s.id === "edit")!.edits!.occurrences).toBe(1);
            // fail-fast：verify 失败 → reload skipped
            const bad = await runBatch(drv, {
                steps: [
                    { id: "verify2", kind: "exec", command: `grep -q 'port=NOPE' ${p}` },
                    { id: "reload", kind: "exec", command: `touch ${p}.never`, after: ["verify2"] },
                ],
            });
            expect(bad.status).toBe("fail");
            expect(bad.steps.find((s) => s.id === "reload")!.status).toBe("skipped");
        } finally {
            await drv.destroy();
        }
    }, 120_000);
});
describe("第十一季：CLI 层快照（CI 真机）", () => {
    test("layer save → exec --layer 一行直达（CM master 跨命令复用）", async () => {
        if (!IT) return console.log("[skip] FILAXIS_IT≠1——CI 矩阵专用");
        const { execSync } = await import("node:child_process");
        const { tmpdir } = await import("node:os");
        const { join: j } = await import("node:path");
        const { mkdtempSync, rmSync } = await import("node:fs");
        const d = mkdtempSync(j(tmpdir(), "fx-cli-layer-"));
        const env = { ...process.env, FILAXIS_LAYERS: j(d, "layers.json") };
        try {
            execSync(`bun bin/filaxis.ts layer save lo --host ${TARGET}`, { encoding: "utf-8", env });
            // 第一条：建 master（一次握手）；第二条：CM 复用毫秒级
            const o1 = execSync('bun bin/filaxis.ts exec --layer lo -- "echo L1_OK"', { encoding: "utf-8", env });
            expect(o1).toContain("L1_OK");
            const o2 = execSync('bun bin/filaxis.ts exec --layer lo -- "echo L2_OK"', { encoding: "utf-8", env });
            expect(o2).toContain("L2_OK");
        } finally {
            rmSync(d, { recursive: true, force: true });
        }
    }, 120_000);
});
