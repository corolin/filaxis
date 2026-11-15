/**
 * 持久会话子系统单测（纯逻辑全测；tmux 真机集成条件跳过——本机无 tmux）
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputBuffer } from "../src/terminal/output-buffer.js";
import { SessionRegistry, type TerminalProfile } from "../src/terminal/session-registry.js";
import { SessionLauncher } from "../src/terminal/session-launcher.js";
import { CommandExecuter, isBinaryChunk } from "../src/terminal/command-executer.js";
import { TmuxInvoker } from "../src/terminal/tmux-invoker.js";
import { compilePromptPatterns } from "../src/terminal/types.js";
import { TerminalManager } from "../src/terminal-manager.js";
import { TmuxSessionDriver } from "../src/tmux-driver.js";

describe("OutputBuffer（三级缓冲）", () => {
    test("append/readTail/drainPending/stats", () => {
        const b = new OutputBuffer({ pendingChars: 1000, aggregatedChars: 1000, tailChars: 10 });
        b.append("hello ");
        b.append("world 12345");
        expect(b.readTail()).toBe("orld 12345"); // tail 快照=末 10 字符
        expect(b.drainPending()).toBe("hello world 12345");
        expect(b.hasPending()).toBe(false);
        expect(b.stats).toEqual({ total: 17, truncated: false });
    });

    test("readLog 绝对偏移游标 + 封顶断档显式报告（不静默错位）", () => {
        const b = new OutputBuffer({ pendingChars: 1000, aggregatedChars: 10, tailChars: 10 });
        b.append("0123456789"); // 恰满
        let r = b.readLog(0, 5);
        expect(r).toEqual({ ok: true, text: "01234", nextOffset: 5 });
        b.append("ABCDEF"); // 裁头 6 字符
        r = b.readLog(2); // 旧游标落入被裁区间
        expect(r.ok).toBe(false);
        expect(r.lostChars).toBe(4); // baseOffset=6, offset=2
        expect(r.validFrom).toBe(6);
        expect(b.readLogText(2)).toContain("游标已过期");
        r = b.readLog(6); // 有效下界
        expect(r.ok).toBe(true);
    });

    test("reset 归零", () => {
        const b = new OutputBuffer({ pendingChars: 10, aggregatedChars: 10, tailChars: 5 });
        b.append("xxxxxxxxxxxxxxxx");
        b.reset();
        expect(b.stats).toEqual({ total: 0, truncated: false });
        expect(b.readTail()).toBe("");
    });
});

describe("SessionRegistry（profile CRUD + 重连扫描）", () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-term-"));
    const reg = new SessionRegistry(() => dir);

    test("save/load/remove 幂等", async () => {
        const p: TerminalProfile = { id: "t1", driver: "local", target: "", createdAt: Date.now() };
        await reg.save(p);
        expect((await reg.load("t1"))!.id).toBe("t1");
        await reg.remove("t1");
        await reg.remove("t1"); // 幂等
        expect(await reg.load("t1")).toBeNull();
    });

    test("reconcile：无 tmux 环境保守保留（不误删）", async () => {
        writeFileSync(join(dir, "t2.json"), JSON.stringify({ id: "t2", driver: "ssh", target: "h", createdAt: 1 }));
        const r = await reg.reconcileOnStartup();
        expect(r.scanned).toBe(1);
        if (!(await TmuxInvoker.isAvailable())) {
            expect(r.kept).toBe(1); // tmux 缺席：无法核实→保留
        }
        rmSync(dir, { recursive: true, force: true });
    });
});

describe("SessionLauncher.resolveLaunchCmd", () => {
    const l = new SessionLauncher(new SessionRegistry(() => "/tmp/x"));
    test("driver 快捷方式渲染 + Unknown driver", () => {
        expect(l.resolveLaunchCmd("local", undefined)).toBe("bash");
        expect(l.resolveLaunchCmd("ssh", "root@h")).toBe("ssh  -t 'root@h'");
        expect(l.resolveLaunchCmd("docker", "ctr", { shell: "bash" })).toBe("docker exec -i -- 'ctr' 'bash' -i");
        expect(l.resolveLaunchCmd("k8s", "pod", { namespace: "ns" })).toBe("kubectl exec -i -n 'ns' 'pod' -- 'sh' -i");
        expect(l.resolveLaunchCmd("teleport", "node", { cluster: "c", login: "u" })).toBe("tsh ssh --cluster='c' 'u'@'node'");
        expect(l.resolveLaunchCmd("custom", "x", { launchCmd: "nix develop" })).toBe("nix develop");
        expect(() => l.resolveLaunchCmd("nope", "x")).toThrow(/Unknown driver/);
    });
});

describe("CommandExecuter 纯逻辑件", () => {
    test("isBinaryChunk：null 占比嗅探", () => {
        expect(isBinaryChunk("normal text")).toBe(false);
        expect(isBinaryChunk("a\x00b\x00c\x00d\x00e\x00f")).toBe(true); // >10% NUL
        expect(isBinaryChunk("")).toBe(false);
    });

    // GPT Astra #2 + 二轮 #4：回显不算证据（含折行形态）——token 独立成行（trim 全等）才算。
    // 真机实证（60 列窄 pane + 长提示符折行）：printf 回显折行后第二行含 "printf '" 前缀
    // 与 "\n'" 后缀，全等判定不命中；执行输出=独立 token 行命中
    test("paneShowsDrainEvidence：回显/折行回显不算证据，独立 token 行才算", () => {
        const tok = "__FX_DRAIN_abc123def";
        // echo 回显（整行/带提示符）——不全等
        expect(CommandExecuter.paneShowsDrainEvidence(`user@host:~$ echo ${tok}\r`, tok)).toBe(false);
        expect(CommandExecuter.paneShowsDrainEvidence(`echo ${tok}\n`, tok)).toBe(false);
        // printf 回显折行（真机形态：第二行 = "rintf '__FX_DRAIN_abc123def\\n'"）——不全等
        expect(CommandExecuter.paneShowsDrainEvidence(
            `root@very-long-hostname-agent-aethel:/some/deep/working/dirp\nrintf '${tok}\\n'\n`, tok,
        )).toBe(false);
        // echo 回显折行后 token 独立成行（Astra 场景）——echo 前缀已折走，行=裸 token？
        // 实机形态第二行是 "echo __FX_DRAIN_..."（echo 与 token 同行折下）——不全等
        expect(CommandExecuter.paneShowsDrainEvidence(`root@host:~# dire\necho ${tok}\n`, tok)).toBe(false);
        // 执行输出：独立 token 行——可信证据
        expect(CommandExecuter.paneShowsDrainEvidence(`user@host:~$ printf '${tok}\\n'\r\n${tok}\r\n`, tok)).toBe(true);
        expect(CommandExecuter.paneShowsDrainEvidence(`${tok}\n`, tok)).toBe(true);
        // token 作为子串出现在长行中——不全等不命中
        expect(CommandExecuter.paneShowsDrainEvidence(`prefix ${tok} suffix\n`, tok)).toBe(false);
        expect(CommandExecuter.paneShowsDrainEvidence("unrelated output", tok)).toBe(false);
    });

    test("detectPrompt：末尾锚定检测（中段字样不误判）", () => {
        const ce = new CommandExecuter(); // 实例化（Hydrogen R3 #1）
        expect(ce.detectPrompt("some output\nPassword: ", "t1")).toBeTruthy();
        expect(ce.detectPrompt("the password: field in docs", "t1")).toBeNull(); // 非末尾
        expect(ce.detectPrompt("done\n$ ", "t1")).toBeNull();
    });
});

describe("compilePromptPatterns", () => {
    test("多 pattern OR 合并多行正则", () => {
        const re = compilePromptPatterns(["Password:\\s*$", "\\(yes/no\\)\\s*\\??\\s*$"]);
        expect(re.test("Password: ")).toBe(true);
        expect(re.test("(yes/no) ? ")).toBe(true);
        expect(re.test("Password: mid text")).toBe(false);
    });
});

describe("TerminalManager（无 tmux 环境降级路径）", () => {
    test("getSession 缺失返回 null；destroySession 不抛", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-tm-"));
        const tm = new TerminalManager({ terminalDir: dir });
        expect(await tm.getSession("ghost")).toBeNull();
        await tm.destroySession("ghost"); // best-effort 不抛
        rmSync(dir, { recursive: true, force: true });
    });

    test("tmux 集成（有 tmux 才跑）：spawn→runCommand→destroy 闭环", async () => {
        if (!(await TmuxInvoker.isAvailable())) {
            console.log("[skip] 本机无 tmux——集成用例属 CI Linux 矩阵");
            return;
        }
        const dir = mkdtempSync(join(tmpdir(), "fx-tm-int"));
        const tm = new TerminalManager({ terminalDir: dir, config: { poll_interval_ms: 100, spawn_poll_ms: 50 } });
        const id = await tm.spawnSession("local", undefined, undefined, "fx_test_sess");
        expect(id).toBe("fx_test_sess");
        // 注意：(exit 7) 子 shell——裸 exit 会杀掉交互 bash 本体导致会话死（CI 真机实证）
        const r = await tm.runCommand(id, "echo persistent-hello; (exit 7)", 15_000);
        // 容 pane 折行：宽列 220 修复后仍保留折行容忍（历史 80 列行为）
        const flat = r.stdout.split("\n").join("");
        expect(flat).toContain("persistent-hello");
        expect(r.exitCode).toBe(7);
        // 重连语义：同 id 再 spawn → 复用
        const id2 = await tm.spawnSession("local", undefined, undefined, "fx_test_sess");
        expect(id2).toBe("fx_test_sess");
        await tm.destroySession(id);
        rmSync(dir, { recursive: true, force: true });
    });

    // 自挖 R5（有 tmux 才跑）：tmux fs writeFile 大载荷——send-keys -l 文本在本地
    // tmux argv（Windows 32K/Linux 单参 128K 上限）直接炸 + 超长键入回显污染 pane；
    // 分流 putContent（分块+decode+双校验+原子落位）后大文件可用且内容保真。
    test("tmux fs 大文件 writeFile（有 tmux 才跑）：>24KB b64 走 putContent 分块链路", async () => {
        if (!(await TmuxInvoker.isAvailable())) return console.log("[skip] 本机无 tmux——集成用例属 CI Linux 矩阵");
        const dir = mkdtempSync(join(tmpdir(), "fx-tm-big"));
        const tm = new TerminalManager({ terminalDir: dir, config: { poll_interval_ms: 80, spawn_poll_ms: 50 } });
        const { TmuxSessionDriver } = await import("../src/tmux-driver.js");
        // launchCmd 必须显式（SessionLauncher 只认 local/launchCmd——裸 driver:"tmux" 抛 Unknown driver）
        const drv = new TmuxSessionDriver({ driver: "tmux", config: { launchCmd: "bash" } }, { terminalManager: tm });
        await drv.init();
        try {
            const payload = "牵丝Filaxis大载荷\n" + "X".repeat(60 * 1024) + "\n尾部保真"; // b64 ≈80KB（>24K 阈值 → putContent）
            const target = (dir.replace(/\\/g, "/")) + "/big-file.txt";
            await drv.fs.writeFile(target, payload);
            expect(await drv.fs.readFile(target)).toBe(payload); // 内容逐字节保真
            const st = await drv.fs.stat!(target);
            expect(st?.size).toBe(Buffer.byteLength(payload, "utf-8"));
        } finally {
            await drv.destroy();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);

    // PTY 键入大数据（盲测深水区验证轮）：4096 是 canonical read **分段线**而非丢弃线
    // （远端实证：sh 无 readline 层 + 消费者忙/闲双场景，单行 16K 均完整——
    // 缓冲满时 master 写入被流控阻塞退避不丢）。此回归钉住 Linux N_TTY+流控行为，
    // 退化（某环境/内核改为丢弃）即红。
    test("tmux 键入超长单行（有 tmux 才跑）：canonical 分段下 16K 单行命令完整执行", async () => {
        if (!(await TmuxInvoker.isAvailable())) return console.log("[skip] 本机无 tmux——集成用例属 CI Linux 矩阵");
        const dir = mkdtempSync(join(tmpdir(), "fx-tm-4k"));
        const tm = new TerminalManager({ terminalDir: dir, config: { poll_interval_ms: 80, spawn_poll_ms: 50 } });
        const { TmuxSessionDriver } = await import("../src/tmux-driver.js");
        const drv = new TmuxSessionDriver({ driver: "tmux", config: { launchCmd: "sh" } }, { terminalManager: tm }); // sh=无 readline（canonical 事实面）
        await drv.init();
        try {
            const target = (dir.replace(/\\/g, "/")) + "/canary.txt";
            // 单行命令 ≈16K（head 参数 + 路径），超 canonical 4096 四倍
            const r = await drv.exec(`head -c 16000 /dev/zero | tr "\\0" C > ${target}; wc -c < ${target}`);
            expect(r.exitCode).toBe(0);
            expect(r.stdout.trim()).toBe("16000"); // 完整执行未截断（退化即红）
        } finally {
            await drv.destroy();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);

    // 二进制/控制字符经 b64 中继逐字节保真：\r（ICRNL 陷阱）/\x03（INTR）/\x04（EOF）/
    // \x1b（转义）——payload 直写必被行规程吃，b64 化是结构免疫而非假设。
    test("tmux 传输二进制控制字符（有 tmux 才跑）：b64 中继 \\r/\\x03/\\x04/\\x1b 逐字节保真", async () => {
        if (!(await TmuxInvoker.isAvailable())) return console.log("[skip] 本机无 tmux——集成用例属 CI Linux 矩阵");
        const dir = mkdtempSync(join(tmpdir(), "fx-tm-bin"));
        const tm = new TerminalManager({ terminalDir: dir, config: { poll_interval_ms: 80, spawn_poll_ms: 50 } });
        const { TmuxSessionDriver } = await import("../src/tmux-driver.js");
        const drv = new TmuxSessionDriver({ driver: "tmux", config: { launchCmd: "bash" } }, { terminalManager: tm });
        await drv.init();
        try {
            // fs.readFile 契约=UTF-8 文本——payload 取合法 UTF-8 字节（\r\n INTR EOF ESC NUL A 中文）；
            // 非法 UTF-8 字节（0xff 等）属 readBase64 二进制通道，不在本契约
            const payload = Buffer.from([0x0d, 0x0a, 0x03, 0x04, 0x1b, 0x00, 0x41, 0xe4, 0xb8, 0xad]);
            const target = (dir.replace(/\\/g, "/")) + "/bin.dat";
            await drv.fs.writeFile(target, payload.toString("utf-8"));
            const back = Buffer.from(await drv.fs.readFile(target), "utf-8");
            expect(Buffer.compare(back, payload)).toBe(0); // 逐字节保真（含行规程敏感字节）
        } finally {
            await drv.destroy();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);

    test("四阶段（审查问题 2）：超时 ^C + DRAINING——下条命令零残影；串行化不交错", async () => {
        if (!(await TmuxInvoker.isAvailable())) return console.log("[skip] 本机无 tmux——集成用例属 CI Linux 矩阵");
        const dir = mkdtempSync(join(tmpdir(), "fx-tm-4ph"));
        const tm = new TerminalManager({ terminalDir: dir, config: { poll_interval_ms: 80, spawn_poll_ms: 50 } });
        const id = await tm.spawnSession("local", undefined, undefined, "fx_four_phase");
        // ① 超时路径：长命令超时 → CommandExecError（outcome unknown）+ ^C 已发
        let timedOut: unknown;
        try {
            await tm.runCommand(id, "echo PRE_TASK_OUT; sleep 60", { timeoutMs: 1_500 });
        } catch (e) { timedOut = e; }
        expect((timedOut as { outcome?: string })?.outcome).toBe("unknown");
        expect((timedOut as Error).message).toMatch(/已确认终止|已销毁|已确认回提示符/);
        // ② DRAINING 兑现：超时返回后**立即**下一条命令——stdout 不得串入 PRE_TASK_OUT
        const r2 = await tm.runCommand(id, "echo AFTER_OK; (exit 0)", { timeoutMs: 30_000 });
        expect(r2.stdout).not.toContain("PRE_TASK_OUT");
        expect(r2.stdout).toContain("AFTER_OK");
        // ③ 串行化：并发两条命令，各自输出完整不交错
        const [a, b] = await Promise.all([
            tm.runCommand(id, "for i in 1 2 3 4 5; do echo AAA$i; done", { timeoutMs: 30_000 }),
            tm.runCommand(id, "for i in 1 2 3 4 5; do echo BBB$i; done", { timeoutMs: 30_000 }),
        ]);
        expect(a.stdout).toContain("AAA5");
        expect(b.stdout).toContain("BBB5");
        expect(a.stdout).not.toContain("BBB");
        expect(b.stdout).not.toContain("AAA");
        await tm.destroySession(id);
        rmSync(dir, { recursive: true, force: true });
    }, 90_000);
});

// 审计 M2：滚屏后前缀必失效（curr 头部历史被淘汰）——旧实现整屏返回=每轮重复
// 追加整个缓冲区。重叠匹配取增量锚点。computeDelta 是 private static——反射直测
// （纯函数无副作用）。
describe("computeDelta 滚屏重叠（审计 M2）", () => {
    const delta = (CommandExecuter as unknown as { computeDelta(p: string, c: string): string }).computeDelta.bind(CommandExecuter);
    test("前缀匹配（未滚屏）行为不变", () => {
        expect(delta("", "abc")).toBe("abc");
        expect(delta("ab", "abcd")).toBe("cd");
    });
    test("滚屏：prev 尾行 == curr 头行 → 只取新行（不再整屏重复）", () => {
        const prev = "L1\nL2\nL3\nL4";
        const curr = "L3\nL4\nL5\nL6"; // 滚掉 L1/L2
        expect(delta(prev, curr)).toBe("L5\nL6"); // 修前：整屏重复
    });
    test("无重叠（清屏/全重绘）→ 整屏（宁重复不丢）", () => {
        expect(delta("AAA\nBBB", "XXX\nYYY")).toBe("XXX\nYYY");
    });
});

// 三十九期 CI 二连挂根因（tmux 16K 测试 stdout 双计：两份输出夹 24 空行）：
// capture-pane 返回整个 pane——内容顶置时底部是渲染填充空行区。新行入底/滚动
// 使 ② 前缀与 ③ 重叠锚全落空（锚行被挤成空行区），落 ④ 整屏追加=双计+空行入流。
describe("computeDelta 尾部空行区归一（三十九期）", () => {
    const delta = (CommandExecuter as unknown as { computeDelta(p: string, c: string): string }).computeDelta.bind(CommandExecuter);

    test("内容顶置+底部空行区：新行入底不再整屏双计", () => {
        const prev = "16000\n" + "\n".repeat(20);            // 内容 1 行 + 填充空行
        const curr = "16000\n---CMD_DONE_x9f_0\n" + "\n".repeat(19); // marker 入底
        const d = delta(prev, curr);
        // 修前：③ 锚被空行区挤失效 → ④ 整屏（16000 双计+空行全入流）
        expect(d.replace(/\s/g, "")).toBe("---CMD_DONE_x9f_0"); // 除空白外恰为新内容
    });

    test("空屏（clear 渲染竞态窗）零信息不追加", () => {
        expect(delta("OLD\nCONTENT\n", "\n".repeat(24))).toBe(""); // 修前：24 空行整屏入流
        expect(delta("", "\n".repeat(24))).toBe("");               // 首捕即空屏同样零信息
    });

    test("同内容重捕（纯尾部空行变化）零增量", () => {
        expect(delta("X\n\n\n", "X\n")).toBe(""); // 修前：③④落空整屏返回 → X 双计
    });

    test("滚屏重叠锚不受尾空行归一影响（既有 M2 行为保持）", () => {
        const prev = "L1\nL2\nL3\nL4\n\n\n";
        const curr = "L3\nL4\nL5\n\n\n";
        expect(delta(prev, curr)).toBe("L5"); // 归一后锚 [L3,L4] 照常命中
    });
});

// 孪生对齐审计（三十九期后全弧复盘）：tmux execSession 带病出厂——二十一期 remote
// 握手模板（FX 闸/wrapper 亲写 .pid/等待窗）、二十期 #2 子 shell wrapped、R3 cd 失败
// 码、十轮 env 语义在 tmux 层全漏（execSession 写出时用了旧形态：谎报成功+幽灵 .pid）。
// mock exec 通道直测渲染与三态语义。
describe("tmux execSession 启动握手（孪生对齐审计）", () => {
    type ExecImpl = (cmd: string) => Promise<{ stdout: string; exitCode: number }>;
    const mkDrv = (execImpl: ExecImpl) => {
        const tm = new TerminalManager({ terminalDir: mkdtempSync(join(tmpdir(), "fx-tm-hs")) });
        const drv = new TmuxSessionDriver({ driver: "tmux", config: { launchCmd: "bash" } }, { terminalManager: tm });
        (drv as unknown as { exec: ExecImpl }).exec = execImpl;
        return { drv }; // TerminalManager 构造即挂 unref sweeper，无 dispose 面
    };

    test("握手链形态：子 shell 包裹 + FX 双闸 + wrapper 亲写 .pid + .st 身份戳", async () => {
        let seen = "";
        const { drv } = mkDrv(async (cmd) => { seen = cmd; return { stdout: "", exitCode: 0 }; });
        const h = await drv.execSession("echo HI");
        expect(seen.startsWith("( ")).toBe(true);      // 整条包子 shell（裸 exit 不杀持久会话 shell）
        expect(seen).toContain("echo $$ > ");           // wrapper 亲写 .pid（修前：$! 幽灵）
        expect(seen).toContain("FX_MKDIR_FAIL");
        expect(seen).toContain("FX_SPAWN_FAIL");
        expect(seen).toContain(".st");                   // PID 身份戳（防复用误杀）
        expect(seen).toContain("(\necho HI\n)");        // wrapped 子 shell+换行（业务 exit 7 隔离+尾注释防吞）
        expect(h.logBase).toContain("/tmp/filaxis-sessions/");
    });

    test("FX_SPAWN_FAIL → outcome=unknown + 核实线索（不谎报成功）", async () => {
        const { drv } = mkDrv(async () => ({ stdout: "FX_SPAWN_FAIL", exitCode: 1 }));
        let caught: (Error & { outcome?: string; logBase?: string }) | undefined;
        try { await drv.execSession("x"); } catch (e) { caught = e as never; }
        expect(caught?.outcome).toBe("unknown");         // 修前：echo started 即谎报成功+幽灵登记
        expect(caught?.message).toContain("勿盲目重试");
        expect(caught?.logBase ?? "").toContain("/tmp/filaxis-sessions/"); // 核实线索
    });

    test("FX_MKDIR_FAIL → 确定性失败（可安全重试）", async () => {
        const { drv } = mkDrv(async () => ({ stdout: "FX_MKDIR_FAIL", exitCode: 1 }));
        await expect(drv.execSession("x")).rejects.toThrow(/不可创建/);
    });

    test("cwd 失败码（cd X || exit 1）+ env：非法名拒绝 / 合法名内联前缀", async () => {
        let seen = "";
        const { drv } = mkDrv(async (cmd) => { seen = cmd; return { stdout: "", exitCode: 0 }; });
        await expect(drv.execSession("x", { env: { "BAD;NAME": "1" } })).rejects.toThrow(/非法环境变量名/);
        await drv.execSession("x", { cwd: "/tmp", env: { FXK: "V1" } });
        expect(seen).toContain("cd '/tmp' || exit 1");  // 修前：cd && 前缀（失败被 & 吞）
        expect(seen).toContain("FXK=");                  // env 进子 shell（Sol 54 P2-7：前缀形态变更——外层只作用首命令曾丢变量）
        expect(seen).toContain("x");                     // 业务命令仍在
    });

    // Astra 四十期 #1：会话名原文拼 sessionId → 未引用路径 = 命令注入（真 Bash
    // 复现文件被创建）。修=白名单规范化（local/remote 同款）+ 外层路径引用。
    test("会话名注入封死：恶意名规范化 + 真 Bash 执行零副作用", async () => {
        let seen = "";
        const { drv } = mkDrv(async (cmd) => { seen = cmd; return { stdout: "", exitCode: 0 }; });
        const probe = join(tmpdir(), "fx-inject-probe-40");
        const evil = `probe$(touch ${probe.replace(/\\/g, "/")})`;
        await drv.execSession("echo HI", { name: evil });
        expect(seen).not.toContain("$(touch");           // 修前：恶意载荷原文进 sessionId（产品自身的 $((n+1))/$ (cat) 合法替换不在此列）
        expect(seen).toContain("probe--touch");          // 白名单规范化（每个非法字符→一个 -）
        // 真 Bash 执行整条握手链（Astra 同款复现手法）：注入目标零创建（主断言——
        // 链是否在慢 bash 环境跑完 3s 握手窗是环境变量〔Gemini 环境实测 exit 1〕，
        // 与注入封死无关——exitCode 弱断言仅排崩溃级）
        const r = Bun.spawnSync(["bash", "-c", seen], { timeout: 15_000 });
        expect(r.exitCode).not.toBeLessThan(0);
        expect(existsSync(probe)).toBe(false);           // 修前：$(touch) 每次求值都执行
    }, 15_000);

    // Astra 四十一期：#1 读取侧 sessionId 仍原文拼路径（启动侧四十期修了读取侧漏）——
    // tailSession/readSessionLog/stopSession/verifySession 四入口统一 sessionBase 校验；
    // #2 stopSession 死亡未核实谎报 stopped（PID 文件全无仍 stopped）——证据三态化。
    test("四十一期 #1：读取/停止/核实入口恶 ID 全拒（不产生命令即无注入面）", async () => {
        const { drv } = mkDrv(async () => ({ stdout: "", exitCode: 0 }));
        const evil = "s$(touch /tmp/fx-41-probe)";
        await expect(drv.tailSession(evil)).rejects.toThrow(/非法会话 ID/);
        await expect(drv.readSessionLog(evil)).rejects.toThrow(/非法会话 ID/);
        await expect(drv.stopSession(evil)).rejects.toThrow(/非法会话 ID/);
        await expect(drv.verifySession(evil)).rejects.toThrow(/非法会话 ID/);
        expect(existsSync("/tmp/fx-41-probe")).toBe(false);
    });

    test("四十一期 #2：证据三态——NOEV=unknown（修前 PID 全无仍 stopped）/ CODE=exited / DEAD=stopped / 恒 ALIVE=窗尽 unknown", async () => {
        // 探针唯一特征 `echo CODE:`（pidGuardedKill 命令不含——mock 按此分支）
        const probeMock = (reply: string) => mkDrv(async (cmd) =>
            cmd.includes("echo CODE:") ? { stdout: reply, exitCode: 0 } : { stdout: "", exitCode: 0 });
        // a) 证据全缺（Astra mock 场景）：PID/code 文件都不存在
        const { drv: d1 } = probeMock("");
        expect((await d1.stopSession("tsess-nope")).status).toBe("unknown"); // 修前：stopped
        // b) .code 在场 → exited 真实码
        const { drv: d2 } = probeMock("CODE:7");
        expect(await d2.stopSession("tsess-code")).toEqual({ status: "exited", exitCode: 7 });
        // c) pid 在场且 kill -0 已死 → stopped（TERM 致死）
        const { drv: d3 } = probeMock("DEAD");
        expect((await d3.stopSession("tsess-dead")).status).toBe("stopped");
        // d) 恒 ALIVE → 核实窗尽 → unknown（不谎报 stopped；6 轮×300ms≈1.8s）
        const { drv: d4 } = probeMock("ALIVE");
        expect((await d4.stopSession("tsess-stuck")).status).toBe("unknown"); // 修前：立即 stopped
    }, 15_000);

    // Astra 四十二期：#1 stopSession 必须先读 .code 再发信号（已退出会话盲发 TERM
    // 在 .st 缺席+PID 复用时会误伤无辜进程——remote H3一 同款）；#2 verifySession
    // 裸 kill -0 在 PID 复用时把无辜进程存活冒认成原会话 running——.st 比对。
    test("四十二期 #1：CODE 在场 → 首条命令即探针、全程零 TERM、直返真实码", async () => {
        const cmds: string[] = [];
        const { drv } = mkDrv(async (cmd) => {
            cmds.push(cmd);
            return cmd.includes("echo CODE:") ? { stdout: "CODE:7", exitCode: 0 } : { stdout: "", exitCode: 0 };
        });
        expect(await drv.stopSession("tsess-done")).toEqual({ status: "exited", exitCode: 7 });
        expect(cmds.length).toBe(1);                        // 修前：首条是 pidGuardedKill（先 TERM 后读码）
        expect(cmds[0]).toContain(".code");                 // 首条即退出记录探针
        expect(cmds.join(" ")).not.toContain("kill -TERM"); // 全程零信号——已退出会话绝无发信号必要
    });

    test("四十二期 #2：verifySession 身份核验——RUNNING=running / STALE=unknown（修前冒认 running）", async () => {
        const vMock = (reply: string) => mkDrv(async (cmd) => {
            if (cmd.includes("echo RUNNING")) return { stdout: reply, exitCode: 0 };
            if (cmd.includes("echo CODE:")) return { stdout: "", exitCode: 0 };
            return { stdout: "", exitCode: 0 };
        });
        const { drv: ok } = vMock("RUNNING");
        expect((await ok.verifySession("tsess-a")).status).toBe("running");
        const { drv: stale } = vMock("STALE");
        const r = await stale.verifySession("tsess-b");
        expect(r.status).toBe("unknown"); // 修前：裸 kill -0 把复用进程的存活冒认成原会话 running
    });

    // Astra 四十三期：#1 探针失败（exitCode≠0/stdout 空）被当 ALIVE 照发 TERM/KILL——
    // 探针不可信绝不进信号段；#2 CODE:7oops 损坏记录被部分匹配成 7——整行严格。
    test("四十三期 #1：探针失败（exit 1/空输出）→ unknown 且全程零信号", async () => {
        const cmds: string[] = [];
        const { drv } = mkDrv(async (cmd) => {
            cmds.push(cmd);
            return cmd.includes("echo CODE:") ? { stdout: "", exitCode: 1 } : { stdout: "", exitCode: 0 };
        });
        expect((await drv.stopSession("tsess-probe-dead")).status).toBe("unknown");
        expect(cmds.join(" ")).not.toContain("kill -TERM"); // 修前：空输出当 ALIVE 照发信号
        expect(cmds.join(" ")).not.toContain("kill -KILL");
        expect((await drv.verifySession("tsess-probe-dead")).status).toBe("unknown"); // verify 同罪
    });

    test("四十三期 #2：损坏退出记录 CODE:7oops → unknown（stop/verify 双面不采纳）", async () => {
        const { drv } = mkDrv(async (cmd) =>
            cmd.includes("echo CODE:") ? { stdout: "CODE:7oops", exitCode: 0 } : { stdout: "", exitCode: 0 });
        expect((await drv.stopSession("tsess-corrupt")).status).toBe("unknown"); // 修前：exited/7
        expect((await drv.verifySession("tsess-corrupt")).status).toBe("unknown"); // 修前：exited/7
    });
});

// GPT Sol 七十四期：P1-1 stop/verify 只核实组长（孙进程持组曾报 stopped/DEAD）；
// P1-2 大文件分页读中转被删曾静默返回残缺；#4 init 原地改写调用方 descriptor
// （双实例共指同一会话）；#7 日志缺失当空。stub 终端 + 真 shell（探针跑真 /proc）。
describe("Sol 74：tmux 会话语义", () => {
    const shPath = () => Bun.which("sh")!;
    /** stub 终端：runCommand 直通真 sh——探针/文件命令全真跑 */
    const stubTerminal = (hooks: { onPage?: (cmd: string) => void } = {}) => ({
        spawnSession: async () => "fx74",
        runCommand: async (_id: string, cmd: string, _t?: number) => {
            hooks.onPage?.(cmd);
            const p = Bun.spawn([shPath(), "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            p.stdin.write(cmd);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, stderr: "", exitCode: code };
        },
        destroySession: async () => undefined,
    });
    const drvOf = (hooks?: Parameters<typeof stubTerminal>[0]) =>
        new TmuxSessionDriver(
            { driver: "tmux", terminalId: "fx74", config: { launchCmd: "bash" } } as never,
            { terminalManager: stubTerminal(hooks) as never },
        );

    test.skipIf(!Bun.which("sh"))("P1-1 组长死孙进程活：verify=running、stop 组杀后收口", async () => {
        const sh = shPath();
        // 造**自有**孤儿进程组（Sol 75 P1-3：曾 pgrep 系统 sleep）：组长先写
        // $$（=pgid）进 token 文件再退、sleep 孙进程持组。**文件先写**（Sol 77 #6）：
        // /proc 后读在组长退出后拿不到——WSL 上曾零断言静默通过
        const tok = `/tmp/fx-grp-tok-${Math.random().toString(36).slice(2, 8)}`;
        const g = Bun.spawnSync([sh, "-c",
            `setsid sh -c 'echo \$\$ > ${tok}; sleep 5 >/dev/null 2>&1 </dev/null & exit 0' >/dev/null 2>&1 </dev/null & ` +
            "sleep 0.4; cat " + tok + " 2>/dev/null"]);
        const pgid = g.stdout.toString().trim();
        if (!/^\d+$/.test(pgid)) return; // 无 setsid——环境不适用（CI Linux 矩阵覆盖）
        mkdirSync("/tmp/filaxis-sessions", { recursive: true });
        const sid = `fxgr74${Math.random().toString(36).slice(2, 6)}`;
        const base = `/tmp/filaxis-sessions/${sid}`;
        writeFileSync(`${base}.pid`, pgid);
        writeFileSync(`${base}.pgid`, pgid);
        try {
            const drv = drvOf();
            expect((await drv.verifySession(sid)).status).toBe("running"); // 修前：组长死组活被报 DEAD→unknown
            const st = await drv.stopSession(sid); // 组杀收口（TERM 组 → 核实窗 → 最多 KILL）
        } finally {
            Bun.spawnSync([sh, "-c", `rm -f ${base}.pid ${base}.pgid ${base}.st ${base}.code ${tok}; kill -TERM -- -${pgid} 2>/dev/null; true`]);
        }
    }, 20_000);

    test.skipIf(!Bun.which("sh"))("P1-2 分页读中转被删：拒绝（不返回残缺）", async () => {
        const d = mkdtempSync(join(tmpdir(), "fx-pg74-")).replace(/\\/g, "/");
        const src = `${d}/big.txt`;
        writeFileSync(src, "x".repeat(9_000));
        // 只删**本用例**的中转文件（Sol 75 P1-3：曾 rm /tmp 全部 filaxis-read-*
        // ——同机其他任务的中转会被误删）：首页捕获本用例中转名，次页删它
        let myTmp = "";
        let hit = false;
        const drv = drvOf({ onPage: (cmd) => {
            const m = cmd.match(/tail -c \+\d+ (\S+)/);
            if (!m) return;
            if (!myTmp) { myTmp = m[1]!; return; } // 首页：捕获中转名
            if (!hit) { hit = true; Bun.spawnSync([shPath(), "-c", `rm -f ${myTmp}`]); } // 次页前删它
        } });
        await expect(drv.fs.readFile(src)).rejects.toThrow(/分页读失败|长度对账/); // 修前：~5922B 正常完成
    }, 20_000);

    test("#4 init 克隆：调用方 descriptor 不被补写 terminalId", async () => {
        const drv = new TmuxSessionDriver(
            { driver: "tmux", config: { launchCmd: "bash" } } as never,
            { terminalManager: stubTerminal() as never },
        );
        const callerDesc = { driver: "tmux", config: { launchCmd: "bash" } } as never;
        const drv2 = new TmuxSessionDriver(callerDesc, { terminalManager: stubTerminal() as never });
        await drv2.init();
        expect((callerDesc as { terminalId?: string }).terminalId).toBeUndefined(); // 修前：被告改写（二次建层键漂移→双实例）
        expect(drv2.descriptor.terminalId).toBe("fx74");
        void drv;
    }, 10_000);

    test.skipIf(!Bun.which("sh"))("#7 日志缺失：tailSession/readSessionLog 拒绝（不当空日志）", async () => {
        const drv = drvOf();
        await expect(drv.tailSession("fxnope74")).rejects.toThrow(/不作日志凭证/); // 修前：[]
        await expect(drv.readSessionLog("fxnope74")).rejects.toThrow(/不作日志凭证/); // 修前：""
    }, 15_000);

    test("#5 registry 探测异常保守保留（仅 exit 1=不存在才删）", async () => {
        const real = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        const mk = async () => {
            const dir = mkdtempSync(join(tmpdir(), "fx-reg74-"));
            const reg = new SessionRegistry(() => dir);
            await reg.save({ id: "z74", driver: "tmux", createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() } as never);
            return { dir, reg };
        };
        try {
            // 探测被信号终止（exit 143——Sol 74 #5）：保守保留
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => ({ stdout: "", stderr: "", exitCode: 143 });
            const a = await mk();
            await a.reg.init();
            expect(existsSync(join(a.dir, "z74.json"))).toBe(true); // 修前：当会话已死亡删掉 profile
            // tmux 语义码 1=会话不存在（且服务端健在——Sol 75 P2-6 二次甄别）：删除
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async (args: string[]) =>
                ({ stdout: "", stderr: "", exitCode: args[0] === "list-sessions" ? 0 : 1 });
            const b = await mk();
            await b.reg.init();
            expect(existsSync(join(b.dir, "z74.json"))).toBe(false);
            // 服务端不可用（list-sessions 也败）：保守保留（Sol 75 P2-6）
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => ({ stdout: "", stderr: "", exitCode: 1 });
            const c = await mk();
            await c.reg.init();
            expect(existsSync(join(c.dir, "z74.json"))).toBe(true);
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real;
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real;
        }
    }, 10_000);
});

// GPT Sol 七十五期：P1-1 tmux 的 exec 跑在持久 shell——日志读取的裸 exit 9/
// exit $__fx_rc 曾直接退掉承载层（两次读取后 exec 全挂）。子 shell 包裹后 exit
// 只出子 shell、退出码仍透传。P2-3 组模式组长优先：组长活着但 .st 不符=STALE
//（复用组拦截），不再直信组存活。
describe("Sol 75：持久 shell 语义/组长身份", () => {
    test("P1-1 日志读取命令全以子 shell 包裹（无顶层裸 exit）", async () => {
        const cmds: string[] = [];
        const drv = new TmuxSessionDriver(
            { driver: "tmux", terminalId: "fx75", config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => "fx75",
                runCommand: async (_id: string, cmd: string, _t?: number) => {
                    cmds.push(cmd);
                    return { stdout: "", stderr: "", exitCode: 9 }; // 统一失败触发 throw 路径
                },
                destroySession: async () => undefined,
            } as never },
        );
        await expect(drv.tailSession("fxnope75")).rejects.toThrow(/不作日志凭证/);
        await expect(drv.readSessionLog("fxnope75")).rejects.toThrow(/不作日志凭证/);
        await expect(drv.readSessionLog("fxnope75", { lines: 3 })).rejects.toThrow(/不作日志凭证/);
        for (const c of cmds) {
            expect(c.startsWith("( ")).toBe(true); // 修前：test -r ... || exit 9 顶层裸 exit
            expect(c.endsWith(" )")).toBe(true);
        }
    }, 10_000);

    test.skipIf(!Bun.which("sh"))("P2-3 组长活但 .st 不符 → unknown（复用组拦截；修前组存活直信 running）", async () => {
        const sh = Bun.which("sh")!;
        // 自有活组长：exec setsid sleep——pid==pgid 且活着（stdio 全重定向防拖挂）
        const g = Bun.spawnSync([sh, "-c", "setsid sh -c 'exec sleep 5 >/dev/null 2>&1 </dev/null' >/dev/null 2>&1 </dev/null & w=$!; sleep 0.3; echo $w"]);
        const pid = g.stdout.toString().trim();
        if (!/^\d+$/.test(pid)) return; // 无 setsid——CI Linux 矩阵覆盖
        mkdirSync("/tmp/filaxis-sessions", { recursive: true });
        const sid = `fxst75${Math.random().toString(36).slice(2, 6)}`;
        const base = `/tmp/filaxis-sessions/${sid}`;
        writeFileSync(`${base}.pid`, pid);
        writeFileSync(`${base}.pgid`, pid);
        writeFileSync(`${base}.st`, "9999999999.99"); // 与真实 starttime 必不符
        const stubTerminal = {
            spawnSession: async () => "fx75",
            runCommand: async (_id: string, cmd: string, _t?: number) => {
                const p = Bun.spawn([sh, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
                p.stdin.write(cmd);
                await p.stdin.end();
                const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
                return { stdout, stderr: "", exitCode: code };
            },
            destroySession: async () => undefined,
        };
        try {
            const drv = new TmuxSessionDriver(
                { driver: "tmux", terminalId: "fx75", config: { launchCmd: "bash" } } as never,
                { terminalManager: stubTerminal as never },
            );
            expect((await drv.verifySession(sid)).status).toBe("unknown"); // 修前：running（组存活直信）
        } finally {
            Bun.spawnSync([sh, "-c", `rm -f ${base}.pid ${base}.pgid ${base}.st; kill -TERM ${pid} 2>/dev/null; true`]);
        }
    }, 20_000);
});

// GPT Sol 七十六期 #4：组长退出后孙进程持组+**有 .st 记录**——pidGuardedKill
// 曾因 /proc/$p 不可读整段卡死（stop 转一圈 unknown、孙进程照跑）。组长确死
// 放行组信号。#5：has-session 1 但 list-sessions **真列出**该会话 → 探测失败
// 保留（曾只查退出码就删）。
describe("Sol 76：组长死放行组信号/registry 列表甄别", () => {
    test.skipIf(!Bun.which("sh"))("#4 组长死+孙活+有 .st：stopSession 终止孙进程", async () => {
        const sh = Bun.which("sh")!;
        // token 文件先写（Sol 77 #6）：组长退出后 /proc 读不到——WSL 曾零断言
        const tok2 = `/tmp/fx-grp-tok-${Math.random().toString(36).slice(2, 8)}`;
        const g = Bun.spawnSync([sh, "-c",
            `setsid sh -c 'echo \$\$ > ${tok2}; sleep 8 >/dev/null 2>&1 </dev/null & exit 0' >/dev/null 2>&1 </dev/null & ` +
            "sleep 0.4; cat " + tok2 + " 2>/dev/null"]);
        const pgid = g.stdout.toString().trim();
        if (!/^\d+$/.test(pgid)) return;
        mkdirSync("/tmp/filaxis-sessions", { recursive: true });
        const sid = `fxst76${Math.random().toString(36).slice(2, 6)}`;
        const base = `/tmp/filaxis-sessions/${sid}`;
        writeFileSync(`${base}.pid`, pgid);
        writeFileSync(`${base}.pgid`, pgid);
        writeFileSync(`${base}.st`, "12345.67"); // 有身份戳记录（组长已死——读不出）
        const stubTerminal = {
            spawnSession: async () => "fx76",
            runCommand: async (_id: string, cmd: string, _t?: number) => {
                const p = Bun.spawn([sh, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
                p.stdin.write(cmd);
                await p.stdin.end();
                const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
                return { stdout, stderr: "", exitCode: code };
            },
            destroySession: async () => undefined,
        };
        try {
            const drv = new TmuxSessionDriver(
                { driver: "tmux", terminalId: "fx76", config: { launchCmd: "bash" } } as never,
                { terminalManager: stubTerminal as never },
            );
            expect((await drv.verifySession(sid)).status).toBe("running"); // 孙进程当家
            const t0 = Date.now();
            const st = await drv.stopSession(sid); // 修前：unknown（.st 卡死不放行）+孙进程照跑
            expect(["stopped", "unknown"]).toContain(st.status);
            // 组信号已放行——孙进程应死（组探不到了）
            const probe = Bun.spawnSync([sh, "-c", `/bin/kill -0 -- -${pgid} 2>/dev/null && echo ALIVE || echo DEAD`]);
            expect(probe.stdout.toString().trim()).toBe("DEAD");
            void t0;
        } finally {
            Bun.spawnSync([sh, "-c", `rm -f ${base}.pid ${base}.pgid ${base}.st ${base}.code ${tok2}; /bin/kill -KILL -- -${pgid} 2>/dev/null; true`]);
        }
    }, 30_000);

    test("#5 registry：has-session 1 但列表真含该会话 → 保留（探测失败）", async () => {
        const real = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        const mk = async () => {
            const dir = mkdtempSync(join(tmpdir(), "fx-reg76-"));
            const reg = new SessionRegistry(() => dir);
            await reg.save({ id: "z76", driver: "tmux", createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() } as never);
            return { dir, reg };
        };
        try {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async (args: string[]) =>
                args[0] === "list-sessions"
                    ? { stdout: "z76: 1 windows\nother: 2 windows\n", stderr: "", exitCode: 0 } // 服务端健在且真列出 z76
                    : { stdout: "", stderr: "", exitCode: 1 }; // has-session 单次失败
            const a = await mk();
            await a.reg.init();
            expect(existsSync(join(a.dir, "z76.json"))).toBe(true); // 修前：只查 list 退出码→删了活会话 profile
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real;
        }
    }, 10_000);
});

// GPT Sol 七十七期：P1-1 重挂不同 cwd 曾 cd 共享持久 shell（原层 pwd 被改）；
// P1-2 attach 探活失败/双 destroy 曾扣错引用（原层会话被连带杀）；#4 销毁排程
// 中的 driver 曾被 terminalId 索引返还（新句柄随即失效）；#5 同 tid 多工厂曾
// 互相覆盖索引。
describe("Sol 77：重挂守卫/引用纪律", () => {
    const shPath77 = () => Bun.which("sh")!;

    test("P1-1 重挂不同 cwd 拒绝（原层会话状态不动）；相同 cwd 放行", async () => {
        const real77 = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => ({ stdout: "", stderr: "", exitCode: 0 }); // 探活 stub（本机无真 tmux）
        const cds: string[] = [];
        const mk = (cwd?: string, tid?: string) => new TmuxSessionDriver(
            { driver: "tmux", terminalId: tid, cwd, config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => "SH77",
                runCommand: async (_id: string, cmd: string) => {
                    if (cmd.startsWith("cd ")) cds.push(cmd);
                    return { stdout: "", stderr: "", exitCode: 0 };
                },
                destroySession: async () => undefined,
            } as never },
        );
        // 原层：spawn + cwd /tmp（cd 生效一次）
        const d1 = mk("/tmp");
        await d1.init();
        expect(cds.filter((c) => c.includes("/tmp")).length).toBe(1);
        // 重挂不同 cwd：拒绝（不 cd、不登记）
        const d2 = mk("/", "SH77");
        await expect(d2.init()).rejects.toThrow(/已以 cwd/); // 修前：cd / 执行——原层 pwd 被悄悄改掉
        expect(cds.some((c) => c.includes("cd '/'") || c.includes("cd / "))).toBe(false);
        try {
            // 相同 cwd 重挂：放行（幂等无害）
            const d3 = mk("/tmp", "SH77");
            await d3.init();
            await d1.destroy();
            await d3.destroy();
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real77;
        }
    }, 15_000);

    test("P1-2 attach 探活失败不扣引用（原层会话留命）+ 双 destroy 幂等", async () => {
        const destroyed: string[] = [];
        const real = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => ({ stdout: "", stderr: "", exitCode: 1 }); // 探活失败注入
        const mk = (tid?: string) => new TmuxSessionDriver(
            { driver: "tmux", terminalId: tid, config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => "SH77b",
                runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
                destroySession: async (id: string) => { destroyed.push(id); },
            } as never },
        );
        try {
            const d1 = mk(); // spawn 路径（真登记）
            await d1.init();
            // 重挂探活失败：init 抛错（未登记）——destroy 不扣引用
            const d2 = mk("SH77b");
            await expect(d2.init()).rejects.toThrow(/不存在/);
            await d2.destroy(); // 失败清理路径——修前：??1 照扣 → 原层会话被杀
            expect(destroyed).toEqual([]); // 原层仍持有
            // 双 destroy 幂等
            await d1.destroy();
            await d1.destroy(); // 修前：再扣一次
            expect(destroyed).toEqual(["SH77b"]); // 恰好一次真销毁
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real;
        }
    }, 15_000);
});

// GPT Sol 七十八期 P1-4/#5：同 cwd 双驱动一个销毁曾把 cwd 条目删光（守卫失效
// ——不同 cwd 重挂被放行改掉共享 shell 目录）；销毁在途重挂曾拿到将死会话。
describe("Sol 78：cwd 计数/销毁在途守卫", () => {
    test("P1-4 同 cwd 双驱动：销毁一个后守卫仍拦截不同 cwd 重挂", async () => {
        const real78 = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => ({ stdout: "", stderr: "", exitCode: 0 });
        const mk = (cwd?: string, tid?: string) => new TmuxSessionDriver(
            { driver: "tmux", terminalId: tid, cwd, config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => "SH78",
                runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
                destroySession: async () => undefined,
            } as never },
        );
        try {
            const d1 = mk("/tmp"); // spawn：登记 cwd /tmp（计数 1）
            await d1.init();
            const d2 = mk("/tmp", "SH78"); // 同 cwd 重挂（计数 2）
            await d2.init();
            await d1.destroy(); // 一个销毁——/tmp 计数 2→1（条目保留）
            const d3 = mk("/", "SH78"); // 不同 cwd 重挂：仍须拒绝（d2 还在用 /tmp）
            await expect(d3.init()).rejects.toThrow(/已以 cwd/); // 修前：条目被删光→放行→pwd 被改
            await d2.destroy(); // 最后一个：条目清、会话销毁
            const d4 = mk("/", "SH78"); // 现在无冲突——放行
            await d4.init();
            await d4.destroy();
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real78;
        }
    }, 15_000);

    test("#5 销毁在途重挂被拒（destroySession 暂停窗口）", async () => {
        const real78 = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => ({ stdout: "", stderr: "", exitCode: 0 });
        let releaseDestroy!: () => void;
        const destroyGate = new Promise<void>((r) => { releaseDestroy = r; });
        const mk = (tid?: string) => new TmuxSessionDriver(
            { driver: "tmux", terminalId: tid, config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => "SH78b",
                runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
                destroySession: async () => { await destroyGate; }, // 暂停清理
            } as never },
        );
        try {
            const d1 = mk();
            await d1.init();
            const dying = d1.destroy(); // refs→0：destroySession 挂起（destroying 在册）
            await new Promise((r) => setTimeout(r, 30));
            const d2 = mk("SH78b"); // 销毁在途重挂——修前：has-session 尚通过→将死句柄
            await expect(d2.init()).rejects.toThrow(/销毁进行中/);
            releaseDestroy();
            await dying;
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real78;
        }
    }, 15_000);
});

// GPT Sol 七十九期：P1-3 restore attach 曾忽略显式 cwd（pwd 留旧目录）；
// #5 探活-登记竞态（探活 await 期间旧层销毁走完——新层拿到已死会话）。
describe("Sol 79：restore cwd/探活竞态", () => {
    test("P1-3 首挂 attach（cwd 注册表空）：显式 cwd 生效（cd 执行）", async () => {
        const real79 = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => ({ stdout: "", stderr: "", exitCode: 0 });
        const cds: string[] = [];
        const drv = new TmuxSessionDriver(
            { driver: "tmux", terminalId: "SH79", cwd: "/", config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => "SH79",
                runCommand: async (_id: string, cmd: string) => { if (cmd.startsWith("cd ")) cds.push(cmd); return { stdout: "", stderr: "", exitCode: 0 }; },
                destroySession: async () => undefined,
            } as never },
        );
        try {
            await drv.init(); // attach 首挂（本进程无在册实例）——cd / 应执行
            expect(cds.some((c) => c.startsWith("cd '/'") || c.includes("cd /"))).toBe(true); // 修前：pwd 留旧目录
            await drv.destroy();
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real79;
        }
    }, 15_000);

    test("#5 探活期间旧层销毁走完：新 attach 拒绝（竞态检出）", async () => {
        let releaseProbe!: () => void;
        const probeGate = new Promise<void>((r) => { releaseProbe = r; });
        const real79 = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => { await probeGate; return { stdout: "", stderr: "", exitCode: 0 }; };
        const mk = (tid?: string) => new TmuxSessionDriver(
            { driver: "tmux", terminalId: tid, config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => "SH79b",
                runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
                destroySession: async () => undefined,
            } as never },
        );
        try {
            const d1 = mk();
            await d1.init(); // refs=1
            const d2 = mk("SH79b"); // 重挂：探活挂起
            const attaching = d2.init();
            await new Promise((r) => setTimeout(r, 20));
            await d1.destroy(); // 探活期间销毁走完（refs 删光）——修前：d2 照登记（已死会话）
            releaseProbe();
            await expect(attaching).rejects.toThrow(/竞态检出|销毁/);
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real79;
        }
    }, 15_000);
});

// GPT Sol 八十期：P1-3 未声明 cwd 的在用层——不同 cwd 重挂曾放行（其实际目录
// 不可证一致，pwd 被改）；#4 竞态误拒绝（多引用销毁其一 2→1 曾被当成销毁竞态）。
describe("Sol 80：未声明 cwd 守卫/竞态归零", () => {
    test("P1-3 原层未声明 cwd：重挂显式 cwd 被拒（目录不可证一致）", async () => {
        const real80 = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => ({ stdout: "", stderr: "", exitCode: 0 });
        const cds: string[] = [];
        const mk = (cwd?: string, tid?: string) => new TmuxSessionDriver(
            { driver: "tmux", terminalId: tid, cwd, config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => "SH80",
                runCommand: async (_id: string, cmd: string) => { if (cmd.startsWith("cd ")) cds.push(cmd); return { stdout: "", stderr: "", exitCode: 0 }; },
                destroySession: async () => undefined,
            } as never },
        );
        try {
            const d1 = mk(); // spawn 无 cwd（"" 键登记）
            await d1.init();
            const d2 = mk("/tmp", "SH80"); // 重挂显式 cwd——修前：放行并 cd（原层 pwd 被改）
            await expect(d2.init()).rejects.toThrow(/已以 cwd/); // 冲突守卫拦下（未声明层登记为空串键——冲突信息即拒绝）
            expect(cds.filter((c) => c.includes("tmp")).length).toBe(0); // cd 未执行
            await d1.destroy();
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real80;
        }
    }, 15_000);

    test("#4 多引用销毁其一（2→1）：重挂不被误拒", async () => {
        const real80 = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => ({ stdout: "", stderr: "", exitCode: 0 });
        const mk = (tid?: string) => new TmuxSessionDriver(
            { driver: "tmux", terminalId: tid, config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => "SH80b",
                runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
                destroySession: async () => undefined,
            } as never },
        );
        try {
            const d1 = mk(); await d1.init();
            const d2 = mk("SH80b"); await d2.init(); // refs=2
            await d1.destroy(); // 2→1（d2 仍在用）——修前：refs 降量触发误拒
            const d3 = mk("SH80b");
            await d3.init(); // 不抛（合法：另一层仍在用）
            await d2.destroy();
            await d3.destroy();
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real80;
        }
    }, 15_000);
});

// GPT Sol 八十一期：P1-1 并发首挂同会话不同 cwd——两边都过守卫各自 cd、
// 后到者覆盖（两边 pwd 同值）。cwd 早登记（同步占位）。P2-3 restore 到不存在的
// 目录曾静默成功（句柄声明与实际不符）——cd 严格验证失败即拒。
describe("Sol 81：并发首挂/restore 严验证", () => {
    test("P1-1 并发首挂不同 cwd：先到者胜、后到者拒（不再互相覆盖）", async () => {
        const real81 = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        let releaseProbe!: () => void;
        const probeGate = new Promise<void>((r) => { releaseProbe = r; });
        let probeCount = 0;
        (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => { probeCount++; if (probeCount === 1) await probeGate; return { stdout: "", stderr: "", exitCode: 0 }; };
        const cds: string[] = [];
        const mk = (cwd: string) => new TmuxSessionDriver(
            { driver: "tmux", terminalId: "SH81", cwd, config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => "SH81",
                runCommand: async (_id: string, cmd: string) => { if (cmd.includes("cd ")) cds.push(cmd); return { stdout: "ok", stderr: "", exitCode: 0 }; },
                destroySession: async () => undefined,
            } as never },
        );
        try {
            const d1 = mk("/");
            const d2 = mk("/tmp");
            const p1 = d1.init(); // 首挂 /：cwd 早登记（同步）后探活挂起
            await new Promise((r) => setTimeout(r, 20));
            await expect(d2.init()).rejects.toThrow(/已以 cwd/); // 修前：d2 也过守卫（登记在探活后）→ 双 cd 互相覆盖
            releaseProbe();
            await p1;
            expect(cds.filter((c) => c.includes("/tmp")).length).toBe(0); // d2 的 cd 从未执行
            await d1.destroy();
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real81;
        }
    }, 15_000);

    test("P2-3 restore 到不存在的目录：拒绝（不再静默半挂）", async () => {
        const real81 = TmuxInvoker.tryInvoke.bind(TmuxInvoker);
        (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = async () => ({ stdout: "", stderr: "", exitCode: 0 });
        const drv = new TmuxSessionDriver(
            { driver: "tmux", terminalId: "SH81b", cwd: "/nonexistent-fx81", config: { launchCmd: "bash" } } as never,
            { terminalManager: {
                spawnSession: async () => "SH81b",
                runCommand: async () => ({ stdout: "__FX_CD_FAIL", stderr: "", exitCode: 0 }), // cd 失败标记
                destroySession: async () => undefined,
            } as never },
        );
        try {
            await expect(drv.init()).rejects.toThrow(/恢复目录失败/); // 修前：静默成功（pwd 停在旧处）
        } finally {
            (TmuxInvoker as unknown as { tryInvoke: unknown }).tryInvoke = real81;
        }
    }, 15_000);
});
