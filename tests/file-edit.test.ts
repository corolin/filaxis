/** editFile 受控编辑测试（local driver 真跑 + toolkit 新工具真跑 + CLI 冒烟） */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntimeDriver } from "../src/local-driver.js";
import { editFile, EditConflictError } from "../src/file-edit.js";
import { createAgentToolkit } from "../src/agent-toolkit.js";
import { RuntimeStack } from "../src/runtime-stack.js";
import type { RuntimeDriver } from "../src/driver.js";

const dir = mkdtempSync(join(tmpdir(), "fx-edit-"));

describe("editFile（TOCTOU+精确替换）", () => {
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
        const { editFileMulti } = await import("../src/file-edit.js");
        await editFileMulti(drv, fwd, [{ old: "X=1", new: "$&-$$" }]);
        expect(readFileSync(p, "utf-8")).toBe("$&-$$\n");
        rmSync(d7, { recursive: true, force: true });
    }, 20_000);

    // GPT Astra 三轮 #3：openssl fallback 分支的摘要提取——`SHA2-256(path)= hex` 直接
    // head -c 12 截到算法名前缀（不随内容变化，macOS/无 sha256sum 环境全中）。
    // awk '{print $NF}' 取尾字段=纯摘要（真机实证与 sha256sum 逐位一致）
    test("shaCmdOf：openssl 分支 awk 取尾字段摘要（非算法名前缀）", async () => {
        const { shaCmdOf } = await import("../src/file-edit.js");
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
        const { editFileMulti } = await import("../src/file-edit.js");
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

describe("toolkit 新工具（read_file/edit_file/observe_stream）", () => {
    test("read_file + edit_file 真跑", async () => {
        const d2 = mkdtempSync(join(tmpdir(), "fx-tk-"));
        const p = join(d2, "conf.env");
        writeFileSync(p, "TOKEN=FX_8829\n");
        const tk = createAgentToolkit(new RuntimeStack(), {});
        const rf = await tk.handlers.read_file({ path: p });
        expect(rf.content).toContain("FX_8829");
        expect(rf.size).toBeGreaterThan(0);
        const ef = await tk.handlers.edit_file({ path: p, old: "FX_8829", new: "FX_9999" });
        expect(ef.occurrences).toBe(1);
        expect(ef.mutex === "flock" || ef.mutex === "degraded").toBe(true); // 保护等级透传到 Agent 工具面（Astra 五轮 P2）
        expect((await tk.handlers.read_file({ path: p })).content).toContain("FX_9999");
        rmSync(d2, { recursive: true, force: true });
    }, 20_000);

    test("observe_stream 按流过滤", async () => {
        const tk = createAgentToolkit(new RuntimeStack(), {});
        const r = await tk.handlers.observe_stream({
            command: "echo O1; echo E1 1>&2; sleep 0.3; echo O2; echo E2 1>&2; sleep 2",
            duration_ms: 2000,
            stream: "stderr",
        });
        expect(r.lines.map((l) => l.text)).toContain("E1");
        expect(r.lines.map((l) => l.text)).toContain("E2");
        expect(r.lines.every((l) => l.stream === "stderr")).toBe(true);
        expect(r.lines.map((l) => l.text)).not.toContain("O1");
    }, 30_000);

    // 第八季盲测 bug 回归：ssh 层 RemoteSessionManager.tailLines 是 async——
    // 修复前 lines 是未 resolve 的 Promise（恒 truthy，兜底短路），lines.filter 抛
    // TypeError。local 层 tailLines 恰是同步方法，故此前 local 测试全绿掩盖了本 bug。
    test("observe_stream：async tailLines（ssh 形态）——Promise 必被 await", async () => {
        const fakeRemote = {
            descriptor: { driver: "ssh", target: "mock" },
            execSession: async () => ({ sessionId: "s-async", logBase: "/tmp/s-async" }),
            tailSession: async () => { throw new Error("tailLines 在场时不得走 stdout 投影兜底"); },
            stopSession: async () => ({ exitCode: null }),
            sessions: {
                tailLines: async (_id: string, _n?: number) => [
                    { stream: "stdout", text: "O_ASYNC" },
                    { stream: "stderr", text: "E_ASYNC" },
                ],
            },
        } as unknown as RuntimeDriver;
        const tk = createAgentToolkit(new RuntimeStack(), { driver: fakeRemote });
        const r = await tk.handlers.observe_stream({ command: "mock", duration_ms: 10, stream: "stderr" });
        expect(r.lines).toEqual([{ stream: "stderr", text: "E_ASYNC" }]);
        const both = await tk.handlers.observe_stream({ command: "mock", duration_ms: 10 });
        expect(both.lines.length).toBe(2); // 无过滤全量（修前此处 Promise.filter 已炸）
    }, 15_000);
});

describe("CLI 冒烟（bun bin/filaxis.ts）", () => {
    test("exec + cat + edit + observe 本地真跑", async () => {
        const { execSync } = await import("node:child_process");
        const d3 = mkdtempSync(join(tmpdir(), "fx-cli-"));
        const p = join(d3, "x.env");
        writeFileSync(p, "K=1\n");
        const fwd = p.replace(/\\/g, "/");
        const out1 = execSync('bun bin/filaxis.ts exec -- "echo CLI_OK" 2>&1', { encoding: "utf-8", cwd: process.cwd() });
        expect(out1).toContain("CLI_OK");
        expect(out1).toContain("exit=0");
        const out2 = execSync(`bun bin/filaxis.ts cat "${fwd}"`, { encoding: "utf-8" });
        expect(out2).toContain("K=1");
        const out3 = execSync(`bun bin/filaxis.ts edit "${fwd}" "K=1" "K=2"`, { encoding: "utf-8" });
        expect(out3).toContain("1 处");
        expect(readFileSync(p, "utf-8")).toBe("K=2\n");
        const out4 = execSync('bun bin/filaxis.ts observe --stream stderr --duration 2000 -- "echo EO; echo EE 1>&2; sleep 2" 2>&1', { encoding: "utf-8" });
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
        const out1 = execSync(`bun bin/filaxis.ts edit "${fwd(p)}" --request-file "${fwd(req)}"`, { encoding: "utf-8" });
        expect(out1).toContain("1 处");
        expect(readFileSync(p, "utf-8")).toContain('"strip_prefix": true');
        // stdin 管道通道（execSync input 直喂 stdin）
        writeFileSync(p, "K=1\n");
        const out2 = execSync(`bun bin/filaxis.ts edit "${fwd(p)}" --stdin-json`, {
            input: JSON.stringify({ old: "K=1", new: "K=2" }),
            encoding: "utf-8",
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
            execSync('bun bin/filaxis.ts exec --docker web -- "echo X"', { encoding: "utf-8", stdio: "pipe" });
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
            { encoding: "utf-8", env },
        );
        expect(out1).toContain("nginx");
        expect(out1).toContain("--layer nginx");
        // 覆盖保存幂等
        execSync('bun bin/filaxis.ts layer save nginx --host web-01', { encoding: "utf-8", env });
        const out2 = execSync("bun bin/filaxis.ts layer list", { encoding: "utf-8", env });
        expect(out2).toContain("nginx");
        expect(out2).toContain("web-01");
        // --layer 与 --host 互斥
        let err1 = "";
        try {
            execSync('bun bin/filaxis.ts exec --layer nginx --host x -- "echo 1"', { encoding: "utf-8", env, stdio: "pipe" });
        } catch (e) { err1 = String((e as { stderr?: string }).stderr ?? e); }
        expect(err1).toContain("互斥");
        // 未保存层报错
        let err2 = "";
        try {
            execSync('bun bin/filaxis.ts exec --layer ghost -- "echo 1"', { encoding: "utf-8", env, stdio: "pipe" });
        } catch (e) { err2 = String((e as { stderr?: string }).stderr ?? e); }
        expect(err2).toContain("未保存");
        // rm 后清单空
        execSync("bun bin/filaxis.ts layer rm nginx", { encoding: "utf-8", env });
        const out3 = execSync("bun bin/filaxis.ts layer list", { encoding: "utf-8", env });
        expect(out3).toContain("无已保存层");
        rmSync(d6, { recursive: true, force: true });
    }, 60_000);
});
