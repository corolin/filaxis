/** editFile 受控编辑测试（local driver 真跑 + toolkit 新工具真跑 + CLI 冒烟） */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, statSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntimeDriver } from "../src/core/local/local-driver.js";
import { editFile, editFileMulti, EditConflictError } from "../src/core/file/file-edit.js";
import { createAgentToolkit } from "../src/interface/mcp/agent-toolkit.js";
import { RuntimeStack } from "../src/middle/runtime-stack.js";
import type { RuntimeDriver } from "../src/core/base/driver.js";

const dir = mkdtempSync(join(tmpdir(), "fx-edit-"));

describe("editFile（TOCTOU+精确替换）", () => {
    test("invalid edit arguments are rejected before reading or writing", async () => {
        const driver = { exec: () => { throw new Error("driver called for invalid input"); } } as unknown as RuntimeDriver;
        await expect(editFile(driver, "/fixture", "", "insert", { all: true })).rejects.toThrow(/old 需为非空字符串/);
        await expect(editFile(driver, "/fixture", "x", "y", { all: "false" as never })).rejects.toThrow(/all 需为布尔值/);
        await expect(editFile(driver, "/fixture", "x", "y", { writeMode: "typo" as never })).rejects.toThrow(/writeMode 须为/);
        await expect(editFileMulti(driver, "/fixture", [
            { old: "a", new: "b" }, { old: "", new: "c", all: true },
        ])).rejects.toThrow(/hunk #1 的 old 需为非空字符串/);
    });

    test.skipIf(process.platform !== "linux")("符号链接编辑与同目标别名共用 CAS 锁", async () => {
        const fixture = mkdtempSync(join(tmpdir(), "fx-edit-aliases-"));
        try {
            const target = join(fixture, "target");
            const a = join(fixture, "a");
            const b = join(fixture, "b");
            writeFileSync(target, "base-A base-B\n");
            symlinkSync(target, a);
            symlinkSync(target, b);
            const drv = new LocalRuntimeDriver();
            const exec = drv.exec.bind(drv);
            let reads = 0;
            let releaseReads!: () => void;
            const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
            drv.exec = async (cmd, opts) => {
                const result = await exec(cmd, opts);
                if (cmd.includes("echo __FXS__")) {
                    if (++reads === 2) releaseReads();
                    await bothRead;
                }
                return result;
            };
            const results = await Promise.allSettled([
                editFile(drv, a, "base-A", "edit-A"),
                editFile(drv, b, "base-B", "edit-B"),
            ]);
            const success = results.filter((r) => r.status === "fulfilled");
            expect(success).toHaveLength(1);
            expect(success[0]?.value.mutex).toBe("flock");
            expect(results.find((r) => r.status === "rejected")?.reason).toBeInstanceOf(EditConflictError);
            expect(readFileSync(target, "utf-8")).toMatch(/^(edit-A base-B|base-A edit-B)\n$/);
            expect(readdirSync(fixture).filter((n) => n.endsWith(".fx-lock"))).toEqual(["target.fx-lock"]);
        } finally {
            rmSync(fixture, { recursive: true, force: true });
        }
    });

    test("唯一命中替换成功（base64 写回保真）", async () => {
        const drv = new LocalRuntimeDriver();
        const p = join(dir, "a.env");
        writeFileSync(p, "# Up-stream config item\nUP_STREAM=ok\n");
        const r = await editFile(drv, p, "UP_STREAM=ok", "UP_STREAM=fixed");
        expect(r.occurrences).toBe(1);
        expect(readFileSync(p, "utf-8")).toBe("# Up-stream config item\nUP_STREAM=fixed\n");
    }, 20_000); // 读往返 stat+sha+b64 冷启动可超 5s 默认（Windows Defender 首启扫描）

    test("未命中与多处命中拒绝（all=true 全替换）", async () => {
        const drv = new LocalRuntimeDriver();
        const p = join(dir, "b.env");
        writeFileSync(p, "A=1\nB=2\nA=1\n");
        await expect(editFile(drv, p, "A=9", "A=8")).rejects.toThrow(/未命中/);
        await expect(editFile(drv, p, "A=1", "A=7")).rejects.toThrow(/多处命中.*all/);
        const r = await editFile(drv, p, "A=1", "A=7", { all: true });
        expect(r.occurrences).toBe(2);
    }, 20_000); // 同上

    test("TOCTOU 乐观锁（读后他人先写拒绝 EditConflictError）", async () => {
        const drv = new LocalRuntimeDriver();
        const p = join(dir, "c.env");
        writeFileSync(p, "X=1\n");
        // 注入点：editFile 的读+戳往返（含 __FXS__）返回后（=读后 CAS 前）他人写 X=2
        // —— CAS 戳比对读时戳不符 → EditConflictError
        const realExec = drv.exec.bind(drv);
        let injected = false;
        (drv as unknown as { exec: unknown }).exec = async (cmd: string, o?: unknown) => {
            // 确定性注入：拦 CAS 写回命令（FX_CAS_FAIL 独有）发出前同步他人写——
            // 读时戳=X=1、CAS 时 X=2 → 必然冲突（微任务时序无关）
            if (!injected && cmd.includes("FX_CAS_FAIL")) {
                injected = true; writeFileSync(p, "X=2\n");
            }
            return await realExec(cmd, o as never);
        };
        await expect(editFile(drv, p, "X=1", "X=9")).rejects.toMatchObject({ name: "EditConflictError" });
        expect(readFileSync(p, "utf-8")).toBe("X=2\n"); // 他人写入未被覆盖
        rmSync(dir, { recursive: true, force: true });
    }, 30_000);

    // 第十季（B5 轨迹抠出）：CLI 冷启动下 dialectOf 独立探测往返使 edit 实为 3 次
    // 串行 SSH 往返（3×握手 ≈11.4s 破宿主 10s 后台阈值，多耗 3 轮轮询）。本版方言
    // 探测合成进读往返——editFile 成功路径恰 2 次 exec（读+戳+探测 ① / CAS 写回 ②）。
    test("editFile 恰好 2 次 exec 往返（探测合成读往返——冷启动 3-RTT 根治）", async () => {
        const drv = new LocalRuntimeDriver();
        const d5 = mkdtempSync(join(tmpdir(), "fx-rtt-"));
        const p = join(d5, "rtt.env");
        writeFileSync(p, "R=1\n");
        const realExec = drv.exec.bind(drv);
        let calls = 0;
        (drv as unknown as { exec: unknown }).exec = async (cmd: string, o?: unknown) => {
            calls++;
            return await realExec(cmd, o as never);
        };
        const r = await editFile(drv, p, "R=1", "R=2");
        expect(r.occurrences).toBe(1);
        expect(calls).toBe(2); // 修前 = 3（dialectOf 独立往返 + 读 + CAS）
        expect(readFileSync(p, "utf-8")).toBe("R=2\n");
        rmSync(d5, { recursive: true, force: true });
    }, 20_000);

    // GPT Astra #5：String.replace 的 $&/$$ 替换语义破坏字面保真——回调形式=字面替换
    test("字面替换语义：new 串含 $&/$$ 不被 V8 替换语法解释", async () => {
        const drv = new LocalRuntimeDriver();
        const d7 = mkdtempSync(join(tmpdir(), "fx-dollar-"));
        const p = join(d7, "d.env");
        const fwd = p.replace(/\\/g, "/");
        writeFileSync(p, "OLD_TEXT\n");
        await editFile(drv, fwd, "OLD_TEXT", "$&-NEW_$$");
        expect(readFileSync(p, "utf-8")).toBe("$&-NEW_$$\n"); // 字面，不是 OLD_TEXT-NEW_$
        // 多 hunk 单命中分支同款
        writeFileSync(p, "X=1\n");
        const { editFileMulti } = await import("../src/core/file/file-edit.js");
        await editFileMulti(drv, fwd, [{ old: "X=1", new: "$&-$$" }]);
        expect(readFileSync(p, "utf-8")).toBe("$&-$$\n");
        rmSync(d7, { recursive: true, force: true });
    }, 20_000);

    // GPT Astra 三轮 #3：openssl fallback 分支的摘要提取——`SHA2-256(path)= hex` 直接
    // head -c 12 截到算法名前缀（不随内容变化，macOS/无 sha256sum 环境全中）。
    // awk '{print $NF}' 取尾字段=纯摘要（真机实证与 sha256sum 逐位一致）
    test("shaCmdOf：openssl 分支 awk 取尾字段摘要（非算法名前缀）", async () => {
        const { shaCmdOf } = await import("../src/core/file/file-edit.js");
        const cmd = shaCmdOf("/tmp/x");
        expect(cmd).toContain("openssl dgst -sha256");
        expect(cmd).toContain(`awk '{print $NF}'`); // 修前：head -c 12 截 "SHA2-256(path"
    });

    // GPT Astra 四轮 #2：flock 能力缺失与加锁失败分治——结果带 mutex 保护等级标注
    // （本机 Git Bash 无 flock → degraded；CI Linux 有 flock → flock——两环境都断言字段存在）
    test("editFile 结果带 mutex 保护等级（flock | degraded 显式可感知）", async () => {
        const drv = new LocalRuntimeDriver();
        const d9 = mkdtempSync(join(tmpdir(), "fx-mutex-"));
        const p = join(d9, "m.env");
        writeFileSync(p, "M=1\n");
        const r = await editFile(drv, p.replace(/\\/g, "/"), "M=1", "M=2");
        expect(r.mutex === "flock" || r.mutex === "degraded").toBe(true); // 保护等级显式（不再静默同级）
        rmSync(d9, { recursive: true, force: true });
    }, 20_000);

    // GPT Astra 五轮 P2：mutex 保护等级须贯穿调用链——editFileMulti 此前丢弃
    // casWrite 标注（无锁降级经 multi 路径不可见）。拦 CAS 命令模拟无 flock 环境
    // （FX_DEGRADED_NO_LOCK 前缀 + FX_OK 载荷）→ 确定性断言 degraded 透传。
    test("editFileMulti 结果带 mutex（无锁降级跨 multi 路径可感知）", async () => {
        const drv = new LocalRuntimeDriver();
        const d11 = mkdtempSync(join(tmpdir(), "fx-mmutex-"));
        const p = join(d11, "mm.env");
        writeFileSync(p, "MM=1\n");
        const fwd = p.replace(/\\/g, "/");
        const realExec = drv.exec.bind(drv);
        (drv as unknown as { exec: unknown }).exec = async (cmd: string, o?: unknown) => {
            if (cmd.includes("fx-lock")) {
                return { stdout: "FX_DEGRADED_NO_LOCKFX_OK 111 222\n", stderr: "", exitCode: 0 };
            }
            return await realExec(cmd, o as never);
        };
        const { editFileMulti } = await import("../src/core/file/file-edit.js");
        const r = await editFileMulti(drv, fwd, [{ old: "MM=1", new: "MM=2" }, { old: "MM=2", new: "MM=3" }]);
        expect(r.mutex).toBe("degraded"); // 修前：multi 路径丢弃（undefined）
        rmSync(d11, { recursive: true, force: true });
    }, 20_000);

    // bind mount 深水区定案（用户设计）：CAS 校验 ≠ 写入原子性两轴正交。单文件
    // bind mount 挂载点 mv → EBUSY 不可替换——真实 sh 假 mv（PATH 前置 exit 1 桩）
    // 模拟：mv 恒败 → 命令内自动降级 cat（保留 inode）→ writeMode=inplace-write
    // 显式报告。inode 前后相同=保留 inode 的直接证据（bind mount 语义本地可证）。
    test("bind mount 降级（真实 sh 假 mv）：cat 保留 inode 写入 + writeMode=inplace-write", async () => {
        const drv = new LocalRuntimeDriver();
        const d12 = mkdtempSync(join(tmpdir(), "fx-bm-"));
        const p = join(d12, "m.conf");
        writeFileSync(p, "K=1\n");
        const fwd = p.replace(/\\/g, "/");
        // PATH 注入须 POSIX 形态（/c/...）——MSYS bash 不认 C:/ 盘符条目（探针实证：
        // 盘符形态静默不生效，假 mv 从未执行——首版测试是假阳性）
        const fakeBinWin = join(d12, "bin");
        const binForShell = (fwd.replace(/\/[^/]+$/, "") + "/bin")
            .replace(/^([A-Za-z]):/, (_m: string, dr: string) => "/" + dr.toLowerCase());
        mkdirSync(fakeBinWin);
        writeFileSync(join(fakeBinWin, "mv"), "#!/bin/sh\nexit 1\n"); // 模拟挂载点 EBUSY
        chmodSync(join(fakeBinWin, "mv"), 0o755);
        const realExec = drv.exec.bind(drv);
        (drv as unknown as { exec: unknown }).exec = async (cmd: string, o?: unknown) => {
            return realExec(`export PATH=${binForShell}:$PATH; ${cmd}`, o as never);
        };
        const inoBefore = statSync(p).ino;
        const r = await editFile(drv, fwd, "K=1", "K=2");
        expect(r.writeMode).toBe("inplace-write"); // 降级显式报告（修前 mv 失败直接抛错）
        expect(readFileSync(p, "utf-8")).toBe("K=2\n");
        expect(statSync(p).ino).toBe(inoBefore); // inode 保留——bind mount 挂载点兼容的直接证据
        // 正常路径（真 mv 在场）：atomic-replace
        const drv2 = new LocalRuntimeDriver();
        writeFileSync(p, "K=1\n");
        const r2 = await editFile(drv2, fwd, "K=1", "K=3");
        expect(r2.writeMode).toBe("atomic-replace");
        rmSync(d12, { recursive: true, force: true });
    }, 30_000);

    // 显式请求（已知挂载环境）：writeMode:"inplace" 跳过 mv 少一次失败尝试
    test("writeMode:'inplace' 显式请求：直走 cat（FX_INPLACE）+ 保留 inode", async () => {
        const drv = new LocalRuntimeDriver();
        const d13 = mkdtempSync(join(tmpdir(), "fx-req-"));
        const p = join(d13, "r.conf");
        writeFileSync(p, "V=1\n");
        const fwd = p.replace(/\\/g, "/");
        const inoBefore = statSync(p).ino;
        const r = await editFile(drv, fwd, "V=1", "V=2", { writeMode: "inplace" });
        expect(r.writeMode).toBe("inplace-write");
        expect(readFileSync(p, "utf-8")).toBe("V=2\n");
        expect(statSync(p).ino).toBe(inoBefore);
        rmSync(d13, { recursive: true, force: true });
    }, 20_000);

    // GPT Astra 十八轮 #2：inplace 写入中断（cat 半写即败）绝不谎称「目标未动」——
    // 明确报告可能已被部分改写 + tmp 载荷保留供核实/重试
    test("inplace 写入中断：报错明说目标可能已被部分改写（不再宣称未动）+ tmp 保留", async () => {
        const drv = new LocalRuntimeDriver();
        const d14 = mkdtempSync(join(tmpdir(), "fx-ipf-"));
        const p = join(d14, "f.conf");
        writeFileSync(p, "ORIG\n");
        const fwd = p.replace(/\\/g, "/");
        const realExec = drv.exec.bind(drv);
        (drv as unknown as { exec: unknown }).exec = async (cmd: string, o?: unknown) => {
            // 拦 CAS 命令 → 模拟 cat 中断（FX_INPLACE_FAIL——目标已被截断半写）
            if (cmd.includes("fx-lock")) {
                return { stdout: "FX_DEGRADED_NO_LOCK\nFX_INPLACE_FAIL\n", stderr: "", exitCode: 1 };
            }
            return realExec(cmd, o as never);
        };
        await expect(editFile(drv, fwd, "ORIG", "NEW")).rejects.toThrow(/可能已被部分改写.*fx-tmp 可重试/);
        rmSync(d14, { recursive: true, force: true });
    }, 20_000);

    // flock 在场但加锁失败 → FX_LOCK_FAIL 拒写（不静默继续冒进覆盖）
    test("flock 加锁失败 → 拒写（FX_LOCK_FAIL 显式报错）", async () => {
        const drv = new LocalRuntimeDriver();
        const d10 = mkdtempSync(join(tmpdir(), "fx-lockfail-"));
        const p = join(d10, "lf.env");
        writeFileSync(p, "L=1\n");
        const fwd = p.replace(/\\/g, "/");
        const realExec = drv.exec.bind(drv);
        (drv as unknown as { exec: unknown }).exec = async (cmd: string, o?: unknown) => {
            // 拦 CAS 命令（含 flock + fx-lock 特征）→ 模拟加锁失败
            if (cmd.includes("flock") && cmd.includes("fx-lock")) {
                return { stdout: "FX_LOCK_FAIL\n", stderr: "", exitCode: 1 };
            }
            return await realExec(cmd, o as never);
        };
        await expect(editFile(drv, fwd, "L=1", "L=2")).rejects.toThrow(/互斥锁获取失败/);
        expect(readFileSync(p, "utf-8")).toBe("L=1\n"); // 未写入
        rmSync(d10, { recursive: true, force: true });
    }, 20_000);

    test("大文件回退可用相对路径编辑当前目录中的文件", async () => {
        const fixture = mkdtempSync(join(tmpdir(), "fx-edit-relative-large-"));
        try {
            const name = "big file.conf";
            const file = join(fixture, name);
            const body = "x".repeat(75_000);
            writeFileSync(file, "old=" + body);
            const drv = new LocalRuntimeDriver({ cwd: fixture, execDir: join(fixture, "exec") });
            const result = await editFile(drv, name, "old=", "new=");
            expect(result.writeMode).toBe("inplace-write");
            expect(readFileSync(file, "utf-8")).toBe("new=" + body);
        } finally {
            rmSync(fixture, { recursive: true, force: true });
        }
    }, 30_000);

    // GPT Astra #1：大文件回退路径曾丢弃原始读戳（读取后他人写被当新基准覆盖）——
    // 回退前核验原始 stat 戳，不符即 EditConflictError
    test("大文件回退核验：读取后他人先写 → EditConflictError（不覆盖他人内容）", async () => {
        const drv = new LocalRuntimeDriver();
        const d8 = mkdtempSync(join(tmpdir(), "fx-big-"));
        const p = join(d8, "big.conf");
        // 构造 >30KB b64（编辑后 newB64 超 ARG_MAX 安全线走回退）
        writeFileSync(p, "K=1\n" + "P".repeat(92 * 1024) + "\n");
        const fwd = p.replace(/\\/g, "/");
        const realExec = drv.exec.bind(drv);
        let injected = false;
        (drv as unknown as { exec: unknown }).exec = async (cmd: string, o?: unknown) => {
            // 注入点：回退核验命令（stat -c 单命令、无 __FXS__ 读分隔）发出前他人写
            if (!injected && cmd.includes("stat -c") && !cmd.includes("__FXS__")) {
                injected = true;
                writeFileSync(p, "K=1\n" + "P".repeat(92 * 1024) + "\nOTHER_WROTE\n");
            }
            return await realExec(cmd, o as never);
        };
        await expect(editFile(drv, fwd, "K=1", "K=2")).rejects.toMatchObject({ name: "EditConflictError" });
        expect(readFileSync(p, "utf-8")).toContain("OTHER_WROTE"); // 他人写入未被覆盖
        rmSync(d8, { recursive: true, force: true });
    }, 30_000);
});

describe("toolkit 新工具（read_path/edit_file/observe_stream）", () => {
    test("read_path + edit_file（CAS + 直接写入）真跑", async () => {
        const d2 = mkdtempSync(join(tmpdir(), "fx-tk-"));
        const p = join(d2, "conf.env");
        writeFileSync(p, "TOKEN=FX_8829\n");
        const tk = createAgentToolkit(new RuntimeStack(), {});
        const rf = await tk.handlers.read_path({ path: p });
        expect(rf.type).toBe("file");
        if (rf.type !== "file") throw new Error("expected file");
        expect(rf.content).toContain("FX_8829");
        expect(rf.size).toBeGreaterThan(0);
        const dirRead = await tk.handlers.read_path({ path: d2 });
        expect(dirRead.type).toBe("directory");
        if (dirRead.type !== "directory") throw new Error("expected directory");
        expect(dirRead.entries.some((e) => e.name === "conf.env" && !e.isDirectory)).toBe(true);
        const ef = await tk.handlers.edit_file({ path: p, old: "FX_8829", new: "FX_9999" });
        expect(ef.mode).toBe("edit");
        expect(ef.occurrences).toBe(1);
        expect(ef.mutex === "flock" || ef.mutex === "degraded").toBe(true); // 保护等级透传到 Agent 工具面（Astra 五轮 P2）
        const rfAfter = await tk.handlers.read_path({ path: p });
        expect(rfAfter.type === "file" && rfAfter.content).toContain("FX_9999");

        // 直接创建/写入文本（默认拒绝覆写，overwrite=true 才覆写，create_dirs=true 自动建父目录）
        const createdPath = join(d2, "nested", "new.txt");
        const wf = await tk.handlers.edit_file({ path: createdPath, content: "HELLO_NEW\n", create_dirs: true });
        expect(wf).toEqual({ mode: "write", path: createdPath, created: true, bytes_after: 10 });
        await expect(tk.handlers.edit_file({ path: createdPath, content: "OVERWRITE" })).rejects.toThrow(/拒绝覆盖/);
        const ow = await tk.handlers.edit_file({ path: createdPath, content: "OVERWRITTEN", overwrite: true });
        expect(ow).toEqual({ mode: "write", path: createdPath, created: false, bytes_after: 11 });
        rmSync(d2, { recursive: true, force: true });
    }, 20_000);

    test("observe_stream 开窗首读、按流过滤、回看和游标续读", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), {});
        const dir = mkdtempSync(join(tmpdir(), "fx-window-test-"));
        const gate = join(dir, "gate");
        const path = (await import("../src/core/ssh/ssh-helpers.js")).shellQuote(gate.replace(/\\/g, "/"));
        try {
            const first = await tk.handlers.observe_stream({
                command: `echo IGNORE; printf 'E1\\nE2\\nE3\\n' >&2; while [ ! -f ${path} ]; do sleep 0.1; done; echo E4 >&2`,
                stream: "stderr",
                limit: 1,
                wait_ms: 8000,
            });
            const window_id = first.window_id;
            expect(first.frames.map(({ text, stream }) => [text, stream])).toEqual([["E1", "stderr"]]);
            const rest = await tk.handlers.observe_stream({ window_id, since_seq: first.last_delivered_seq, wait_ms: 8000 });
            expect(rest.frames.map((frame) => frame.text)).toEqual(["E2", "E3"]);
            const backward = await tk.handlers.observe_stream({ window_id, before_seq: rest.newest_seq, limit: 2 });
            expect(backward.frames.map((frame) => frame.text)).toEqual(["E1", "E2"]);
            const timeout = await tk.handlers.observe_stream({ window_id, since_seq: rest.newest_seq, wait_ms: 20 });
            expect(timeout.timed_out).toBe(true);
            writeFileSync(gate, "");
            const late = await tk.handlers.observe_stream({ window_id, since_seq: rest.newest_seq, wait_ms: 8000 });
            expect(late.frames.map((frame) => frame.text)).toEqual(["E4"]);
            const history = await tk.handlers.observe_stream({ window_id, window_ms: 30000 });
            expect(history.frames.map((frame) => frame.text)).toEqual(["E1", "E2", "E3", "E4"]);
            expect(await tk.handlers.close_stream({ window_id })).toEqual({ window_id, closed: true });
        } finally {
            tk.dispose?.();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30000);
});

describe("CLI 冒烟（bun bin/filaxis.ts）", () => {

    test("layer save recovers a dead writer's claim and protects a live writer", async () => {
        const { mkdirSync } = await import("node:fs");
        const { spawn } = await import("node:child_process");
        const { once } = await import("node:events");
        const dir = mkdtempSync(join(tmpdir(), "fx-layer-claim-"));
        const store = join(dir, "layers.json");
        const lock = store + ".lock";
        const generation = "00000000-0000-4000-8000-000000000001";
        const run = () => Bun.spawnSync([process.execPath, "bin/filaxis.ts", "layer", "save", "probe", "--host", "web-01"], {
            env: { ...process.env, FILAXIS_LAYERS: store },
            windowsHide: true,
        });
        try {
            mkdirSync(lock);
            const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
            await once(dead, "exit");
            expect(dead.pid).toBeDefined();
            writeFileSync(join(lock, `${dead.pid}-${generation}`), "");
            const active = join(lock, `${process.pid}-${generation}`);
            writeFileSync(active, "");
            expect(run().exitCode).not.toBe(0);
            rmSync(active);
            expect(run().exitCode).toBe(0);
            expect(JSON.parse(readFileSync(store, "utf8")).probe.target).toBe("web-01");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
    test("exec + cat + edit + observe 本地真跑", async () => {
        const { execSync } = await import("node:child_process");
        const d3 = mkdtempSync(join(tmpdir(), "fx-cli-"));
        const p = join(d3, "x.env");
        writeFileSync(p, "K=1\n");
        const fwd = p.replace(/\\/g, "/");
        const out1 = execSync('bun bin/filaxis.ts exec -- "echo CLI_OK" 2>&1', { encoding: "utf-8", cwd: process.cwd(), windowsHide: true });
        expect(out1).toContain("CLI_OK");
        expect(out1).toContain("exit=0");
        const out2 = execSync(`bun bin/filaxis.ts cat "${fwd}"`, { encoding: "utf-8", windowsHide: true });
        expect(out2).toContain("K=1");
        const out3 = execSync(`bun bin/filaxis.ts edit "${fwd}" "K=1" "K=2"`, { encoding: "utf-8", windowsHide: true });
        expect(out3).toContain("1 处");
        expect(readFileSync(p, "utf-8")).toBe("K=2\n");
        const out4 = execSync('bun bin/filaxis.ts observe --stream stderr --duration 2000 -- "echo EO; echo EE 1>&2; sleep 2" 2>&1', { encoding: "utf-8", windowsHide: true });
        expect(out4).toContain("[stderr] EE");
        expect(out4).not.toContain("[stdout] EO");
        rmSync(d3, { recursive: true, force: true });
    }, 60_000);

    // 第八季 PowerShell argv 深渊对策：多行 old/new 载荷经 JSON 文件/管道直达，
    // 不经宿主 Shell 转义（Windows CommandLineToArgvW 剥引号 + 多行缩进空格地狱）
    test("edit 免 Shell 通道：--request-file 与 --stdin-json（多行载荷不经 argv）", async () => {
        const { execSync } = await import("node:child_process");
        const d4 = mkdtempSync(join(tmpdir(), "fx-cli-ch-"));
        const fwd = (s: string) => s.replace(/\\/g, "/");
        const p = join(d4, "routes.json");
        writeFileSync(p, '{\n  "path": "/api/v2/pay",\n  "timeout_ms": 3500,\n  "strip_prefix": false\n}\n');
        const req = join(d4, "req.json");
        // 载荷里的多行 old/new——argv 传不进来的形态（正是盲测卡 32 轮的场景）
        writeFileSync(req, JSON.stringify({
            old: '"timeout_ms": 3500,\n  "strip_prefix": false',
            new: '"timeout_ms": 3500,\n  "strip_prefix": true',
        }));
        const out1 = execSync(`bun bin/filaxis.ts edit "${fwd(p)}" --request-file "${fwd(req)}"`, { encoding: "utf-8", windowsHide: true });
        expect(out1).toContain("1 处");
        expect(readFileSync(p, "utf-8")).toContain('"strip_prefix": true');
        // stdin 管道通道（execSync input 直喂 stdin）
        writeFileSync(p, "K=1\n");
        const out2 = execSync(`bun bin/filaxis.ts edit "${fwd(p)}" --stdin-json`, {
            input: JSON.stringify({ old: "K=1", new: "K=2" }),
            encoding: "utf-8",
            windowsHide: true,
        });
        expect(out2).toContain("1 处");
        expect(readFileSync(p, "utf-8")).toBe("K=2\n");
        rmSync(d4, { recursive: true, force: true });
    }, 60_000);

    // 第九季防呆：路径描述参数（--docker/--jump/--hop/--enter/--forward...）需 --host——
    // local 层无路径概念，静默忽略=错机器风险
    test("路径描述参数防呆：无 --host 显式报错", async () => {
        const { execSync } = await import("node:child_process");
        let errText = "";
        try {
            execSync('bun bin/filaxis.ts exec --docker web -- "echo X"', { encoding: "utf-8", stdio: "pipe", windowsHide: true });
        } catch (e) {
            errText = String((e as { stderr?: string }).stderr ?? (e as Error).message);
        }
        expect(errText).toContain("需要 --host");
    }, 30_000);

    // 第十一季 A 方案：层快照（save/list/rm + --layer 直达与防呆）
    test("layer save/list/rm + --layer 寻址（快照 CRUD，FILAXIS_LAYERS 隔离）", async () => {
        const { execSync } = await import("node:child_process");
        const d6 = mkdtempSync(join(tmpdir(), "fx-layer-"));
        const store = join(d6, "layers.json").replace(/\\/g, "/");
        const env = { ...process.env, FILAXIS_LAYERS: store };
        const out1 = execSync(
            'bun bin/filaxis.ts layer save nginx --host web-01 -J jump-host --docker lab-nginx-b3',
            { encoding: "utf-8", env, windowsHide: true },
        );
        expect(out1).toContain("nginx");
        expect(out1).toContain("--layer nginx");
        // 覆盖保存幂等
        execSync('bun bin/filaxis.ts layer save nginx --host web-01', { encoding: "utf-8", env, windowsHide: true });
        const out2 = execSync("bun bin/filaxis.ts layer list", { encoding: "utf-8", env, windowsHide: true });
        expect(out2).toContain("nginx");
        expect(out2).toContain("web-01");
        // --layer 与 --host 互斥
        let err1 = "";
        try {
            execSync('bun bin/filaxis.ts exec --no-daemon --layer nginx --host x -- "echo 1"', { encoding: "utf-8", env, stdio: "pipe", windowsHide: true });
        } catch (e) { err1 = String((e as { stderr?: string }).stderr ?? e); }
        expect(err1).toContain("互斥");
        // 未保存层报错
        let err2 = "";
        try {
            execSync('bun bin/filaxis.ts exec --no-daemon --layer ghost -- "echo 1"', { encoding: "utf-8", env, stdio: "pipe", windowsHide: true });
        } catch (e) { err2 = String((e as { stderr?: string }).stderr ?? e); }
        expect(err2).toContain("未注册，也不在已存层表里");
        // rm 后清单空
        execSync("bun bin/filaxis.ts layer rm nginx", { encoding: "utf-8", env, windowsHide: true });
        const out3 = execSync("bun bin/filaxis.ts layer list", { encoding: "utf-8", env, windowsHide: true });
        expect(out3).toContain("无已保存层");
        rmSync(d6, { recursive: true, force: true });
    }, 60_000);
});

// GPT Sol 五十九期 P1-1：240 字符长文件名编辑——CAS 核验已改原路径（58 P2-4），
// 但落位目标 __fx_tgt 仍由缩短名 fxBase 解析：编辑报 atomic-replace 成功，实际
// 写进同目录缩短名旁路文件（原文件分毫未动）。修：fxBase 只锚 tmp/lock 伴生件。
describe("Sol 59：长文件名编辑落位原路径", () => {
    test("240 字符 ASCII 文件名：原文件被改写 + 无旁路缩短名文件", async () => {
        const drv = new LocalRuntimeDriver();
        const d = mkdtempSync(join(tmpdir(), "fx-long-")).replace(/\\/g, "/");
        const name = "L".repeat(240) + ".env"; // >231 触发 fxBase 缩短（NAME_MAX 基底）
        const p = `${d}/${name}`;
        writeFileSync(p, "OLD=1\n");
        const r = await editFile(drv, p, "OLD=1", "NEW=2");
        expect(r.writeMode).toBe("atomic-replace");
        expect(readFileSync(p, "utf-8")).toBe("NEW=2\n"); // 修前：原文件仍是 OLD=1
        // 修前实锤形态：同目录出现「LLL…~xxxxxxxx」缩短名文件装着 NEW=2
        //（fx-lock 残留是 fd 9 重定向的既有行为，不算旁路）
        const lSiblings = readdirSync(d).filter((f) => f.startsWith("L") && f !== name && !f.endsWith(".fx-lock") && !f.endsWith(".fx-tmp"));
        expect(lSiblings).toEqual([]);
        rmSync(d, { recursive: true, force: true });
    }, 30_000);
});

// GPT Sol 六十期 P2-4：长文件名缩短基底的 hash 曾取随机——同一 240 字符文件的
// 两次编辑各持各的 .fx-lock，flock 对同目标的核验/写回互斥失效。确定性摘要
//（sha256(name) 前 8）= 同目标必同锁。
describe("Sol 60：长文件名同锁", () => {
    test("同一 240 字符文件两次编辑——fx-lock 路径一致", async () => {
        const drv = new LocalRuntimeDriver();
        const d = mkdtempSync(join(tmpdir(), "fx-lock60-")).replace(/\\/g, "/");
        const name = "K".repeat(240) + ".env";
        const p = `${d}/${name}`;
        writeFileSync(p, "OLD=1\n");
        const realExec = drv.exec.bind(drv);
        const lockPaths = new Set<string>();
        (drv as unknown as { exec: unknown }).exec = async (cmd: string, o?: unknown) => {
            const m = String(cmd).match(/9>(\S+)/); // 舞步命令的 fd 9 锁重定向
            if (m) lockPaths.add(m[1]!);
            return await realExec(cmd, o as never);
        };
        await editFile(drv, p, "OLD=1", "NEW=2");
        await editFile(drv, p, "NEW=2", "NEW=3");
        expect(lockPaths.size).toBe(1); // 修前：随机 hash → 两个不同锁路径
        expect(readFileSync(p, "utf-8")).toBe("NEW=3\n");
        rmSync(d, { recursive: true, force: true });
    }, 30_000);
});

// GPT Sol 六十一期 P1：读往返内戳-正文混版——stat/sha 戳与 base64 正文在同一
// 命令里先后读取，其间文件被并发换版（戳=A、正文=短暂出现的 B、写回前恢复 A）
// 时 CAS 戳写回时仍匹配，B 的正文却被当底稿写回。修：正文摘要与同次 sha 戳互核。
describe("Sol 61：读往返内戳-正文互核", () => {
    test("sha 戳与 base64 正文来自不同版本 → EditConflictError（B 正文不落盘）", async () => {
        const drv = new LocalRuntimeDriver();
        const d = mkdtempSync(join(tmpdir(), "fx-mix61-")).replace(/\\/g, "/");
        const p = `${d}/mix.env`;
        const bFile = `${d}/version-b.env`;
        writeFileSync(p, "KEEP=A\nMODE=0\n");
        writeFileSync(bFile, "KEEP=B\nMODE=0\n");
        const realExec = drv.exec.bind(drv);
        let injected = false;
        (drv as unknown as { exec: unknown }).exec = async (cmd: string, o?: unknown) => {
            if (!injected && cmd.includes("__FXS__")) {
                injected = true;
                // 在 sha 戳（__FXS__ 前段）与 base64 正文（__FXD__ 后段）之间插入
                // 「文件短暂变为 B」——戳=A、正文=B
                const sabotaged = cmd.replace("echo __FXD__; base64", `echo __FXD__; cat '${bFile}' > '${p}'; base64`);
                const r = await realExec(sabotaged, o as never);
                writeFileSync(p, "KEEP=A\nMODE=0\n"); // 恢复原版——写回时 CAS 戳必匹配
                return r;
            }
            return await realExec(cmd, o as never);
        };
        // 修前：CAS 匹配（盘上是 A）→ 以 B 的正文为底稿替换 MODE → KEEP=B 落盘
        await expect(editFile(drv, p, "MODE=0", "MODE=1")).rejects.toMatchObject({ name: "EditConflictError" });
        expect(readFileSync(p, "utf-8")).toBe("KEEP=A\nMODE=0\n"); // 未被写坏
        rmSync(d, { recursive: true, force: true });
    }, 30_000);
});

// GPT Sol 六十二期 P1：CAS 写回命令 exit 1 + stdout "FX_OK …" 曾被报成
// atomic-replace/flock——成功分支只看输出前缀。修：退出码入闸（FX_LOCK_FAIL
// 特判外非零一律不作成功凭证）。
describe("Sol 62：写回退出码入闸", () => {
    test("exit 1 + FX_OK 输出 → 拒绝（不报 atomic-replace）", async () => {
        const drv = new LocalRuntimeDriver();
        const d = mkdtempSync(join(tmpdir(), "fx-ec62-")).replace(/\\/g, "/");
        const p = `${d}/ec.env`;
        writeFileSync(p, "X=1\n");
        const realExec = drv.exec.bind(drv);
        (drv as unknown as { exec: unknown }).exec = async (cmd: string, o?: unknown) => {
            // FX_CAS_FAIL 标记只在 CAS 写回命令里（读命令无此串）
            if (cmd.includes("FX_CAS_FAIL")) {
                return { stdout: "FX_OK 1794630000 4\n", exitCode: 1 }; // 异常退出+成功标记
            }
            return await realExec(cmd, o as never);
        };
        await expect(editFile(drv, p, "X=1", "X=2")).rejects.toThrow(/异常退出|exit 1/);
        rmSync(d, { recursive: true, force: true });
    }, 30_000);
});

// GPT Sol 七十三期 #5：CAS 编辑的伴生锁基底（fxBase）曾按码元判定——250B 中文
// 文件名不触发缩短、.filaxis-lock 后缀追上即超限（Linux ENAMETOOLONG 编辑整体
// 失败）。字节口径（Windows 长路径下验证编辑成功+基底缩短生效）。
describe("Sol 73：长中文名编辑", () => {
    test("250B 中文文件名 CAS 编辑成功（fxBase 字节口径缩短）", async () => {
        const drv = new LocalRuntimeDriver();
        const d = mkdtempSync(join(tmpdir(), "fx-cjk73-")).replace(/\\/g, "/");
        const p = `${d}/${"中".repeat(82)}.txt`; // 246B+4B=250B——裸名合法
        writeFileSync(p, "OLD=1\n");
        const r = await editFile(drv, p, "OLD=1", "NEW=2");
        expect(r.writeMode).toBe("atomic-replace");
        expect(readFileSync(p, "utf-8")).toBe("NEW=2\n");
        // 伴生锁文件名（fxBase+后缀）字节不超限
        const lockFiles = readdirSync(d).filter((f) => f.endsWith(".fx-lock"));
        for (const f of lockFiles) expect(Buffer.byteLength(f, "utf-8")).toBeLessThanOrEqual(255);
        rmSync(d, { recursive: true, force: true });
    }, 30_000);
});
