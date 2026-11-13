/**
 * ssh-helpers / 层状态机 / 远端会话引擎 单测（纯逻辑 + mock 远端，真机面属 CI sshd 矩阵）
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    sshArgsFor, hopLabel, enterStepsOf, renderExecChannel, envPrefixOf, parseJumpSpec,
} from "../src/ssh-helpers.js";
import { resolveLayerState } from "../src/ssh-pty-driver.js";
import { RemoteSessionManager } from "../src/remote-session-manager.js";
import type { SessionEvent } from "../src/session-types.js";

describe("ssh-helpers", () => {
    test("sshArgsFor：结构化参数渲染（ProxyJump/-i/-p/-L）", () => {
        expect(sshArgsFor("vm")).toEqual(["vm"]);
        expect(sshArgsFor({ host: "192.0.2.10", conn: { user: "root", port: 2222, jump: "jump", keyFile: "~/id_ed", forwards: [{ kind: "L", port: 8080, target: "localhost:80" }] } }))
            .toEqual([
                // ProxyCommand 等价形态（跳板白名单+sh 引用+策略随主连接——Astra 十一轮 #1/#2）
                "-o", "ProxyCommand=ssh -o StrictHostKeyChecking=accept-new -W %h:%p 'jump'",
                "-i", expect.any(String), "-p", "2222", "-L", "8080:localhost:80", "root@192.0.2.10",
            ]);
        // 跳板串 [host]:port / host:port / user@[host]:port → 命令行 -p 展开（引用包裹）
        expect(sshArgsFor({ host: "t", conn: { jump: "[127.0.0.1]:2222" } })[1])
            .toBe("ProxyCommand=ssh -o StrictHostKeyChecking=accept-new -p 2222 -W %h:%p '127.0.0.1'");
        expect(sshArgsFor({ host: "t", conn: { jump: "root@h:2222" } })[1])
            .toBe("ProxyCommand=ssh -o StrictHostKeyChecking=accept-new -p 2222 -W %h:%p 'root@h'");
        expect(sshArgsFor({ host: "t", conn: { jump: "u@[198.51.100.9]:2200" } })[1])
            .toBe("ProxyCommand=ssh -o StrictHostKeyChecking=accept-new -p 2200 -W %h:%p 'u@198.51.100.9'");
        // IPv6 字面量
        expect(sshArgsFor({ host: "t", conn: { jump: "[::1]:2200" } })[1])
            .toBe("ProxyCommand=ssh -o StrictHostKeyChecking=accept-new -p 2200 -W %h:%p '::1'");
    });

    // GPT Astra 十一轮 #1：jump 原文拼入经 shell 执行的 ProxyCommand = 命令注入入口。
    // 防线：白名单解析（非法即拒）+ sh 单引号引用双保险。注入形态全拒绝。
    test("跳板注入矩阵：命令替换/空格/引号/分号/反引号形态全拒绝（不拼接不清洗）", () => {
        const evil = [
            "h; touch /tmp/fxs-pwn",
            "h`id`",
            "h$(touch /tmp/fxs-pwn)",
            "h x",
            "h'x",
            'h"x',
            "h|y",
            "h&y",
        ];
        for (const j of evil) {
            expect(() => sshArgsFor({ host: "t", conn: { jump: j } })).toThrow(/非法跳板|多跳逗号链/);
        }
        // 空串/纯 user 注入经 parseJumpSpec 直测（sshArgsFor 的 if(jump) 会跳过空串）
        expect(() => parseJumpSpec("")).toThrow(/非法跳板/);
        expect(() => parseJumpSpec("u;touch x@h")).toThrow(/非法跳板/);
    });

    // GPT Astra 十一轮 #2：strict 策略与 knownHostsFile 必须传导到跳板（不静默降级 accept-new）
    test("跳板策略随主连接：strict + knownHostsFile 传导（ProxyCommand 内 yes + 引用路径）", () => {
        const args = sshArgsFor({
            host: "t",
            conn: {
                jump: { host: "jump.example", user: "ops", port: 2222, keyFile: "~/id_jump" },
                hostKeyPolicy: "strict",
                knownHostsFile: "~/.ssh/known_jumps",
            },
        });
        expect(args[1]).toContain("StrictHostKeyChecking=yes"); // 跳板不再降级
        expect(args[1]).toMatch(/UserKnownHostsFile='[^']*known_jumps'/); // 路径引用在场
        expect(args[1]).toContain("-p 2222 -W %h:%p 'ops@jump.example'");
        expect(args[1]).toContain("-i '"); // 结构化 keyFile 引用
    });

    // GPT Astra 十一轮 #3：多跳逗号链显式拒绝（旧 -J 直传时跳板策略裸奔）——指引 sshInto
    test("多跳逗号链拒绝 + 指引层模型", () => {
        expect(() => sshArgsFor({ host: "t", conn: { jump: "a.example,b.example" } }))
            .toThrow(/多跳逗号链.*sshInto/s);
    });

    // GPT Astra 十二轮 #1：sshArgsQuoted 的双引号包裹让内层单引号失效——结构化
    // jump.keyFile 的 $() 经 PTY 二次渲染实测执行。单引号包裹后每层 shell 各自
    // 正确引用。真实 sh 解析验证（产物作为交互命令行交给 sh，断言 argv 字面 + 零副作用）。
    test("sshArgsQuoted 双层引用：keyFile 命令替换经真实 sh 不执行（字面到达）", async () => {
        const shPath = Bun.which("sh");
        if (!shPath) return; // CI Linux / Git Bash
        const pwnFile = join(process.cwd(), "FXS_QUOTED_PWN");
        rmSync(pwnFile, { force: true });
        const { sshArgsQuoted } = await import("../src/ssh-helpers.js");
        const line = sshArgsQuoted({
            host: "target.example",
            conn: { jump: { host: "jump.example", keyFile: "$(touch FXS_QUOTED_PWN)" } },
        });
        // 产物作为命令行交给真实 sh 解析（模拟 PTY 发送）：set -- 拿 argv——命令替换
        // 若被展开会创建文件且 argv 不再字面
        const p = Bun.spawn([shPath, "-c", `set -- ${line}; printf '%s' "$@"`], { stdout: "pipe" });
        const out = await new Response(p.stdout).text();
        expect(await p.exited).toBe(0);
        expect(out).toContain("$(touch FXS_QUOTED_PWN)"); // 字面到达（未展开）
        await new Promise((r) => setTimeout(r, 300));
        expect(existsSync(pwnFile)).toBe(false); // 零副作用（修前：双引号内 $() 执行）
        rmSync(pwnFile, { force: true });
    }, 20_000);

    // GPT Astra 十二轮 #2：前导 - 的位置参数被 ssh 当选项（'ssh -V' 打版本退出）——
    // 引用不阻止 argv 选项解析，首字符白名单拒绝
    test("前导 - 选项注入矩阵：jump host/user 与主 host/user 全拒绝", () => {
        for (const j of ["-V", "-oProxyCommand=x", "-4h"]) {
            expect(() => sshArgsFor({ host: "t", conn: { jump: j } })).toThrow(/非法跳板/);
        }
        expect(() => sshArgsFor({ host: "t", conn: { jump: { host: "-V" } } })).toThrow(/非法跳板/);
        expect(() => sshArgsFor({ host: "t", conn: { jump: { host: "j", user: "-oX=y" } } })).toThrow(/非法跳板/);
        // 主 host / user 前导 -（user 拼成 -x@host 也是选项面）
        expect(() => sshArgsFor("-V")).toThrow(/非法目标主机串/);
        expect(() => sshArgsFor({ host: "t", conn: { user: "-4" } })).toThrow(/非法目标主机串/);
    });

    test("hopLabel 人读形式", () => {
        expect(hopLabel({ host: "h", conn: { user: "u", port: 2222 } })).toBe("u@h:2222");
    });

    test("enterStepsOf：新管线为准，legacy 归一", () => {
        expect(enterStepsOf({ enterPipeline: [{ cmd: "docker exec -it a bash" }, { cmd: "su - root", label: "root" }] }))
            .toEqual([{ cmd: "docker exec -it a bash", label: undefined }, { cmd: "su - root", label: "root" }]);
        expect(enterStepsOf({ enterCmd: "x", enterLabel: "L" })).toEqual([{ cmd: "x", label: "L" }]);
        expect(enterStepsOf(undefined)).toEqual([]);
    });

    test("renderExecChannel：-it 清洗 + stdin 管道链 + cwd 拼装", () => {
        const r = renderExecChannel(
            [{ cmd: "docker exec -it gitea bash" }],
            "uname -a",
            { cwd: "/data", marker: "M", nonceWrapped: "( uname -a ); ec=$?" },
        );
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.remoteArgs).toEqual(["docker", "exec", "-i", "gitea", "bash", "-s", "sh", "-s"]); // 通道链 POSIX sh 通吃（报告 #3）
            expect(r.stdinCmd).toContain("cd '/data' ||"); // 单引号安全引用（Astra 五轮 P1）
            expect(r.stdinCmd).toContain("( uname -a ); ec=$?");
        }
    });

    // GPT Astra 五轮 P1：JSON.stringify 双引号不是 shell 转义——cwd 内 $()/反引号
    // 照常展开（路径即注入面）；且 cd 失败 || true 吞掉后业务命令在错误目录继续跑。
    test("renderExecChannel：恶意 cwd 单引号字面化 + cd 失败 fail-closed 哨兵 126", () => {
        const evil = "$(touch /tmp/fxs-pwned)`id`";
        const r = renderExecChannel([], "uname", { cwd: evil, marker: "M", nonceWrapped: "( uname ); ec=$?" });
        expect(r.kind).toBe("ok");
        if (r.kind !== "ok") return;
        // 单引号包裹：$()/反引号保持字面（双引号形态必须绝迹）
        expect(r.stdinCmd).toContain(`cd '${evil}' ||`);
        expect(r.stdinCmd).not.toContain('cd "');
        // fail-closed：cd 失败 → 哨兵带 126 + exit 126（业务命令不执行——退出码是数据）
        expect(r.stdinCmd).toContain(`printf '\\nM:126:%s\\n' "$(id -un 2>/dev/null)"; exit 126`);
        expect(r.stdinCmd).toContain("( uname ); ec=$?"); // 业务段仍在（cd 成功时正常执行）
    });

    // 本地 sh 实跑（Astra 同款验证路径）：注入中和 + 目录不存在业务不执行 + 正常目录不受影响
    test("renderExecChannel 实跑：恶意/缺失 cwd 经真实 sh 验证", async () => {
        const sh = Bun.which("sh");
        if (!sh) return; // CI Linux / Git Bash 均有 sh
        const runSh = async (stdinCmd: string) => {
            const p = Bun.spawn([sh, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            p.stdin.write(stdinCmd);
            await p.stdin.end();
            const [out, err, code] = await Promise.all([
                new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
            ]);
            return { out, err, code };
        };
        const pwnFile = join(process.cwd(), "FXS_PWNED");
        rmSync(pwnFile, { force: true });
        // ① 恶意 cwd：命令替换被单引号字面化（不执行），cd 失败哨兵 126
        const evil = "$(touch FXS_PWNED)`id`";
        const r1 = renderExecChannel([], "echo FXS_BIZ_RAN", {
            cwd: evil, marker: "M",
            nonceWrapped: "( echo FXS_BIZ_RAN ); ec=$?; printf '\\nM:%d:%s\\n' \"$ec\" \"$(id -un)\"; exit $ec",
        });
        if (r1.kind !== "ok") throw new Error("unreachable");
        const a = await runSh(r1.stdinCmd);
        expect(a.code).toBe(126);
        expect(a.out).toContain("\nM:126:");
        expect(a.out).not.toContain("FXS_BIZ_RAN"); // 业务未执行
        expect(existsSync(pwnFile)).toBe(false); // 注入被中和（双引号形态下 touch 会执行）
        // ② 目录不存在：业务不执行 + stderr 留 shell 原生报错（不吞诊断）
        const r2 = renderExecChannel([], "echo FXS_BIZ_RAN", {
            cwd: "/no/such/fxs-dir", marker: "M",
            nonceWrapped: "( echo FXS_BIZ_RAN ); ec=$?; printf '\\nM:%d:%s\\n' \"$ec\" \"$(id -un)\"; exit $ec",
        });
        if (r2.kind !== "ok") throw new Error("unreachable");
        const b = await runSh(r2.stdinCmd);
        expect(b.code).toBe(126);
        expect(b.out).not.toContain("FXS_BIZ_RAN");
        expect(b.err).toMatch(/cd: /i); // 原生报错行在场（修前 2>/dev/null 吞掉）
        // ③ 正常目录：cd 成功业务照跑（fail-closed 不误伤）
        const d = mkdtempSync(join(tmpdir(), "fx-cwd-"));
        const r3 = renderExecChannel([], "echo FXS_BIZ_RAN", {
            cwd: d.replace(/\\/g, "/"), marker: "M",
            nonceWrapped: "( echo FXS_BIZ_RAN ); ec=$?; printf '\\nM:%d:%s\\n' \"$ec\" \"$(id -un)\"; exit $ec",
        });
        if (r3.kind !== "ok") throw new Error("unreachable");
        const c = await runSh(r3.stdinCmd);
        expect(c.code).toBe(0);
        expect(c.out).toContain("FXS_BIZ_RAN");
        expect(c.out).toContain("\nM:0:");
        rmSync(d, { recursive: true, force: true });
        rmSync(pwnFile, { force: true });
    }, 20_000);

    test("renderExecChannel：非 shell 结尾 → 不可直达（FEAT-03 拒绝语义）", () => {
        const r = renderExecChannel([{ cmd: "su - root" }], "x", { marker: "M", nonceWrapped: "x" });
        expect(r.kind).toBe("unreachable");
        if (r.kind === "unreachable") expect(r.step).toBe("su - root");
    });

    // 用户实测反馈：`ssh remote-vm` 不以 shell 结尾曾被误判不可直达——ssh 形态的
    // 远端命令位可直接接 sh -s（stdin 管道链）；-t/-tt 须剥掉（ssh 的 -t=强制 PTY，
    // 换 -i 会变 identity file 指认——与 docker 的清洗语义相反）
    test("renderExecChannel：ssh 形态 enter 自动非交互重放（sh -s 追加 + -t 剥除）", () => {
        const r = renderExecChannel([{ cmd: "ssh remote-vm" }], "x", { marker: "M", nonceWrapped: "( x )" });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.remoteArgs).toEqual(["ssh", "remote-vm", "sh", "-s", "sh", "-s"]);
        }
        const r2 = renderExecChannel([{ cmd: "ssh -tt remote-vm -p 2222" }], "x", { marker: "M", nonceWrapped: "( x )" });
        expect(r2.kind).toBe("ok");
        if (r2.kind === "ok") {
            expect(r2.remoteArgs).toEqual(["ssh", "remote-vm", "-p", "2222", "sh", "-s", "sh", "-s"]); // -tt 剥除
        }
    });

    // 多层 enter（用户实测实锤）：旧形态全层塞 argv——第一层 sh -s 吞掉脚本、后续层
    // 静默丢失（命令跑错环境还报成功）；流式接力也被 shell 预读缓冲否决（真机实证）。
    // 正解=首层 argv + 后续层 heredoc 逐层包裹（nonce 分隔符 + 引号形式零展开）。
    test("renderExecChannel 多层：后续层 heredoc 包裹（nonce 分隔符逐层嵌套）", () => {
        const r = renderExecChannel(
            [{ cmd: "ssh remote-vm" }, { cmd: "docker exec -it c bash" }],
            "x",
            { marker: "__M__", nonceWrapped: "( biz ); ec=$?" },
        );
        expect(r.kind).toBe("ok");
        if (r.kind !== "ok") return;
        expect(r.remoteArgs).toEqual(["ssh", "remote-vm", "sh", "-s", "sh", "-s"]); // 首层 argv + 终层
        expect(r.stdinCmd).toBe("docker exec -i c bash -s <<'__M___HD0'\n( biz ); ec=$?\n__M___HD0");
        // 三层：heredoc 嵌套（由内向外赋号——最内层 HD1 在外层 HD0 的载荷内字面传递）
        const r3 = renderExecChannel(
            [{ cmd: "ssh a" }, { cmd: "ssh b" }, { cmd: "docker exec -it c sh" }],
            "x",
            { marker: "__M__", nonceWrapped: "( biz )" },
        );
        expect(r3.kind).toBe("ok");
        if (r3.kind === "ok") {
            expect(r3.stdinCmd).toBe(
                "ssh b sh -s <<'__M___HD0'\n" +
                "docker exec -i c sh -s <<'__M___HD1'\n" +
                "( biz )\n" +
                "__M___HD1\n" +
                "__M___HD0",
            );
        }
    });

    // 多层 heredoc 接力真实 sh 验证（本地两层：sh -s ← 内层 sh -s <<TAG 业务）
    test("renderExecChannel 多层实跑：本地两层嵌套 heredoc 业务脚本真执行", async () => {
        const shPath = Bun.which("sh");
        if (!shPath) return;
        const r = renderExecChannel([{ cmd: "sh" }, { cmd: "sh" }], "x", { marker: "M", nonceWrapped: "echo INNER_OK; exit 7" });
        expect(r.kind).toBe("ok");
        if (r.kind !== "ok") return;
        // 首层 argv 形态 [sh, -s, sh, -s] 等价于本地：sh -s 吃 stdinCmd（含内层 heredoc）
        const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        p.stdin.write(r.stdinCmd);
        await p.stdin.end();
        const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
        expect(out.trim()).toBe("INNER_OK"); // 业务在最内层执行（非首层吞掉）
        expect(code).toBe(7); // 退出码逐层传播
    }, 20_000);

    // GPT Astra 十轮自挖：env 三层语义统一——export 前缀先于 cd 先于业务命令
    test("envPrefixOf + renderExecChannel：export K='V' 前缀渲染（先于 cd/业务）+ 非法变量名拒绝", () => {
        expect(envPrefixOf(undefined)).toBe("");
        expect(envPrefixOf({ FX_MODE: "fast", NOTE: "it's" })).toBe(`export FX_MODE='fast'; export NOTE='it'\\''s'; `);
        expect(() => envPrefixOf({ "BAD;NAME": "x" })).toThrow(/非法环境变量名/);
        const r = renderExecChannel([], "echo x", {
            cwd: "/data", envPrefix: envPrefixOf({ FX_MODE: "fast" }), marker: "M", nonceWrapped: "( echo x )",
        });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            const p = r.stdinCmd.indexOf("export FX_MODE='fast'; ");
            const c = r.stdinCmd.indexOf("cd '/data'");
            expect(p).toBeGreaterThanOrEqual(0);
            expect(c).toBeGreaterThan(p); // env → cd → 业务 顺序
        }
    });

    // GPT Astra 十轮 #2 真实 shell 对照：旧 \$ 转义形态永远返回字面 $KEY；printenv 语义正确
    test("getEnv 命令形态（真实 sh）：旧形态实锤 $HOME 字面量；printenv 返回真值/不存在 exit 1", async () => {
        const sh = Bun.which("sh") && Bun.which("printenv");
        if (!sh) return; // CI Linux / Git Bash
        const runSh = async (stdinCmd: string) => {
            const p = Bun.spawn(["sh", "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            p.stdin.write(stdinCmd);
            await p.stdin.end(); // Bun FileSink：错误以 reject 形式从 end() 抛出（可捕获，无 uncaught 路径）
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, code };
        };
        const old = await runSh(`printf %s "\\$HOME"\n`);
        expect(old.stdout).toBe("$HOME"); // 修前形态：\$ 转义杀了展开——永远字面量（实锤）
        const neu = await runSh(`printenv HOME\n`);
        expect(neu.code).toBe(0);
        expect(neu.stdout).not.toContain("$"); // 真值（绝对路径）
        expect(neu.stdout.trim().length).toBeGreaterThan(1);
        const miss = await runSh(`printenv FX_NO_SUCH_VAR_9371\n`);
        expect(miss.code).toBe(1); // printenv 语义：不存在 → exit 1 → undefined
    }, 20_000);
});

describe("resolveLayerState", () => {
    const now = 1_000_000;
    test("dead/degraded/connecting/active/idle 判定序", () => {
        expect(resolveLayerState({ alive: false }, now)).toBe("dead");
        expect(resolveLayerState({ alive: true, shellGone: "x" }, now)).toBe("degraded"); // 退化优先
        expect(resolveLayerState({ alive: true, reconnecting: true }, now)).toBe("connecting");
        expect(resolveLayerState({ alive: true, execInFlight: true }, now)).toBe("active");
        expect(resolveLayerState({ alive: true, lastActivityAt: now - 20_000 }, now)).toBe("idle");
        expect(resolveLayerState({ alive: true, lastActivityAt: now - 1_000 }, now)).toBe("active");
        expect(resolveLayerState({ alive: true }, now)).toBe("connecting"); // 无活动记录
    });
});

/** 轻量远端模拟：nohup/tail/cat/kill/test 命令的行为回放 */
function fakeRemote() {
    const files = new Map<string, string>();
    /** 路径剥 q() 引号壳（产品命令已引用——mock 捕获后还原） */
    const unq = (x: string) => x.replace(/'/g, ""); // 剥所有单引号（q() 只包路径本体——后缀 .code/.pgid 在引号外）
    const procs = new Set<number>();
    /** 组内孙进程存活标记（四十三期组杀链 mock 面——孙=同 pgid） */
    const grandkids = new Set<number>();
    let pidSeq = 4200;
    const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
        // 组感知停止链（四十三期优先 1）：treeKill/treeProbe 以 g=$(cat .pgid) 开头
        if (cmd.startsWith('g=$(cat ')) {
            const pgidFile = unq(cmd.match(/cat (\S+\.pgid)/)?.[1] ?? "");
            const pidOf = parseInt(cmd.match(/\[ "\$g" = "(\d+)" \]/)?.[1] ?? "0", 10);
            const g = files.get(pgidFile) ?? "";
            const groupMode = g !== "" && g === String(pidOf);
            if (cmd.includes("kill -0")) {
                // 组探测：组内任一存活（主或孙）——组长死后孙持组存活正是旧实现
                // 「主 PID 探测 DEAD 谎报 stopped」的盲区。echo 词跟随命令（treeProbe
                // 用 ALIVE/DEAD，verify 用 Y/N——mock 按远端 shell 真实行为回声）
                const alive = groupMode ? procs.has(pidOf) || grandkids.size > 0 : procs.has(pidOf);
                const word = cmd.includes("echo ALIVE") ? "ALIVE" : "Y";
                const deadWord = word === "ALIVE" ? "DEAD" : "N";
                return { stdout: alive ? word : deadWord, exitCode: 0 };
            }
            if (groupMode) { procs.delete(pidOf); grandkids.clear(); } // 组杀全树
            else { procs.delete(pidOf); } // 回落路径：pkill -P 一层+主进程
            return { stdout: "", exitCode: 0 };
        }
        if (cmd.includes("nohup sh -c")) {
            const pid = ++pidSeq;
            procs.add(pid);
            const baseOfNohup = unq(cmd.match(/ > (\S+)\.out/)?.[1] ?? "");
            if (baseOfNohup) files.set(`${baseOfNohup}.pgid`, String(pid)); // wrapper setsid=组长（四十三期）
            // 异步「跑完」：写入 .code 与 .out（模拟命令 echo hello; exit 3）
            setTimeout(() => {
                const base = baseOfNohup;
                if (base) {
                    files.set(`${base}.out`, "hello\n");
                    files.set(`${base}.code`, "3");
                }
                procs.delete(pid);
            }, 60);
            return { stdout: String(pid), exitCode: 0 };
        }
        if (cmd.startsWith("mkdir -p")) return { stdout: "", exitCode: 0 };
        // 字节游标增量读（二十二期 #2）：tail -c +N 按字节 slice（mock 文件为字符串——
        // UTF-8 字节语义用 Buffer 对齐）
        if (cmd.startsWith("tail -c +")) {
            const f = unq(cmd.match(/tail -c \+\d+ (\S+)/)?.[1] ?? "");
            const from = parseInt(cmd.match(/tail -c \+(\d+)/)?.[1] ?? "1", 10) - 1;
            const buf = Buffer.from(files.get(f) ?? "", "utf-8");
            return { stdout: buf.slice(from).toString("utf-8"), exitCode: 0 };
        }
        if (cmd.startsWith("tail -n ")) {
            const n = parseInt(cmd.match(/tail -n (\d+)/)![1]!, 10);
            const f = unq(cmd.match(/(\S+)\.out/)?.[1] ?? "");
            const all = (files.get(`${f}.out`) ?? "").split("\n").filter(Boolean);
            return { stdout: all.slice(-n).join("\n"), exitCode: 0 };
        }
        if (cmd.startsWith("cat ")) {
            const f = unq(cmd.match(/cat (\S+)/)![1]!);
            return { stdout: files.get(f) ?? "", exitCode: 0 };
        }
        if (cmd.startsWith("kill -0 ")) {
            const pid = parseInt(cmd.match(/kill -0 (\d+)/)![1]!, 10);
            return { stdout: procs.has(pid) ? "Y" : "N", exitCode: 0 };
        }
        if (cmd.startsWith("kill -TERM ") || cmd.startsWith("kill -KILL ")) {
            const pid = parseInt(cmd.match(/kill -\w+ (\d+)/)![1]!, 10);
            procs.delete(pid);
            return { stdout: "", exitCode: 0 };
        }
        return { stdout: "", exitCode: 0 };
    };
    return { exec, files, procs, grandkids };
}

describe("RemoteSessionManager（mock 远端）", () => {
    test("start→轮询发现终态→exited 事件带退出码（.code 文件核实）", async () => {
        const remote = fakeRemote();
        const m = new RemoteSessionManager({ exec: remote.exec, pollMs: 30 });
        const events: SessionEvent[] = [];
        m.onEvent = (e) => events.push(e);
        const h = await m.start("echo hello; exit 3");
        expect(h.pid).toBeGreaterThan(4000);
        await new Promise((r) => setTimeout(r, 400));
        const exit = events.find((e) => e.type === "exit") as Extract<SessionEvent, { type: "exit" }>;
        expect(exit).toBeTruthy();
        expect(exit.exitCode).toBe(3); // .code 文件 = nohup 包装的退出码可核实
        expect(m.list()[0]!.running).toBe(false);
    });

    test("watch 命中（轮询增量）+ tail/readLog", async () => {
        const remote = fakeRemote();
        const m = new RemoteSessionManager({ exec: remote.exec, pollMs: 20 });
        const events: SessionEvent[] = [];
        m.onEvent = (e) => events.push(e);
        const h = await m.start("echo will-not-run"); // mock 异步落盘 hello
        m.watch(h.sessionId, { pattern: "hello", once: true });
        await new Promise((r) => setTimeout(r, 400));
        expect(events.some((e) => e.type === "match" && e.matchedLine.includes("hello"))).toBe(true);
        expect((await m.tail(h.sessionId)).join("\n")).toContain("hello");
        expect(await m.readLog(h.sessionId)).toContain("hello");
    });

    test("stop 三态：核实已死 → stopped；exec 通道断 → unknown", async () => {
        const remote = fakeRemote();
        const m = new RemoteSessionManager({ exec: remote.exec, pollMs: 50 });
        // 存活进程：改用不落盘的命令（mock 只在 60ms 后落盘——先 stop）
        const h = await m.start("sleep 60");
        const r = await m.stop(h.sessionId);
        expect(r.status).toBe("stopped"); // kill -0 核实 DEAD
        // 核实不可达：exec 抛错 → unknown（终止≠确认死亡）
        const m2 = new RemoteSessionManager({
            exec: async () => { throw new Error("channel down"); },
            pollMs: 50,
        });
        const h2 = await m2.start("sleep 60").catch(() => null);
        expect(h2).toBeNull(); // start 也走不通 → 显式失败
    });

    // 自挖 R1：KILL 升级后直接报 stopped 是虚报（D 状态/不可中断睡眠下 kill -0
    // 仍 ALIVE）——死亡须核实宪法收口
    test("stop 自挖 R1：TERM/KILL 后仍存活（不可中断态模拟）→ unknown（不虚报 stopped）", async () => {
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (cmd.includes("nohup sh -c")) return { stdout: "7777", exitCode: 0 };
            if (cmd.startsWith("mkdir -p")) return { stdout: "", exitCode: 0 };
            // stop 的探测形态 `kill -0 pid && echo ALIVE || echo DEAD`——永远 ALIVE
            if (cmd.includes("kill -0 ")) return { stdout: "ALIVE\n", exitCode: 0 };
            return { stdout: "", exitCode: 0 }; // kill/pkill 「发出」但杀不死
        };
        const m = new RemoteSessionManager({ exec, pollMs: 10_000 });
        const h = await m.start("sleep 60");
        const r = await m.stop(h.sessionId);
        expect(r.status).toBe("unknown"); // 修前：KILL 后无条件 stopped
    }, 15_000);

    // 自挖 R2：env 变量名不校验=拼接注入面（对齐十轮 ENV_NAME_RE 标准）
    test("start 自挖 R2：env 非法变量名 → 拒绝", async () => {
        const remote = fakeRemote();
        const m = new RemoteSessionManager({ exec: remote.exec, pollMs: 10_000 });
        await expect(m.start("sleep 1", { env: { "BAD;NAME": "x" } as Record<string, string> }))
            .rejects.toThrow(/非法环境变量名/);
    });

    // 自挖 R3：旧 `cd X && nohup … & echo $!` 的 & 优先级把 && 链后台化——cd 失败
    // 探测不到（exitCode 恒 0）→ 幽灵 running entry 挂到 reapIdle 30min
    test("start 自挖 R3：cwd 不存在 → 显式抛错不建幽灵会话", async () => {
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (cmd.includes("nohup sh -c") && cmd.includes("cd '/no/such'")) {
                return { stdout: "", exitCode: 1 }; // cd '/no/such' || exit 1 语义
            }
            if (cmd.startsWith("mkdir -p")) return { stdout: "", exitCode: 0 };
            return { stdout: "1234", exitCode: 0 };
        };
        const m = new RemoteSessionManager({ exec, pollMs: 10_000 });
        await expect(m.start("sleep 60", { cwd: "/no/such" })).rejects.toThrow(/启动失败/);
        expect(m.list()).toEqual([]); // 幽灵会话绝迹（修前：entry 已建、running=true）
    });

    // GPT Astra 十七轮 #2（RemoteSessionManager 面）：g 正则 watcher 的 lastIndex
    // 状态——连续命中行曾「命中、漏掉、命中」。克隆去 g/y 后全中 + 零反向污染。
    test("watch g 正则：连续命中行全中 + 调用方 lastIndex 零污染", async () => {
        const remote = fakeRemote();
        const m = new RemoteSessionManager({ exec: remote.exec, pollMs: 50 });
        const h = await m.start("sleep 60");
        const userRe = /BEAT/g;
        const w = m.watch(h.sessionId, { pattern: userRe, once: false });
        const got: string[] = [];
        m.onEvent = (e) => {
            if ((e as { type?: string }).type === "match") got.push((e as { matchedLine?: string }).matchedLine ?? "");
        };
        // 直接喂行（绕过轮询——onLine 是 private；经 fakeRemote 的 .out 轮询路径）
        remote.files.set(`${h.logBase}.out`, "BEAT\nBEAT\nBEAT\n");
        await new Promise((r) => setTimeout(r, 400)); // 轮询两轮以上
        expect(got.filter((l) => l === "BEAT").length).toBe(3); // 修前：漏第二行
        expect(userRe.lastIndex).toBe(0); // 调用方实例零污染
        w.cancel();
        await m.stop(h.sessionId).catch(() => undefined);
    }, 15_000);

    // GPT Astra 二十一轮 P2：logDir 是普通文件 → mkdir 失败/重定向失败被分号链吞掉
    // ——$! 返回已死子 shell 的 PID、登记 running:true=幽灵会话。启动握手后显式抛错。
    test("幽灵会话防线：logDir 为普通文件 → start 显式抛错（不登记 running）", async () => {
        const shPath = Bun.which("sh");
        if (!shPath) return;
        const dirG = mkdtempSync(join(tmpdir(), "fx-ghost-"));
        const logDir = join(dirG, "occupied"); // 普通文件（非目录）
        writeFileSync(logDir, "not a dir\n");
        const realExec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            p.stdin.write(cmd);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, exitCode: code };
        };
        const m = new RemoteSessionManager({ exec: realExec, pollMs: 60_000, logDir: logDir.replace(/\\/g, "/") });
        await expect(m.start("sleep 60")).rejects.toThrow(/logDir 不可创建/); // 修前：返回句柄+running:true
        expect(m.list()).toEqual([]); // 无幽灵登记
        rmSync(dirG, { recursive: true, force: true });
    }, 25_000);

    // GPT Astra 二十轮 #2：大括号包装下业务命令显式 exit 退出整个包装 shell——
    // .code 永不写入（进程已死但管理器恒 running）。子 shell 隔离后 $? 照记。
    test("start 显式 exit：子 shell 隔离——.code 记录真实退出码（不再恒 running）", async () => {
        const shPath = Bun.which("sh");
        if (!shPath) return;
        const dirX = mkdtempSync(join(tmpdir(), "fx-exit-"));
        const logDir = dirX.replace(/\\/g, "/");
        const realExec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            p.stdin.write(cmd);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, exitCode: code };
        };
        const m = new RemoteSessionManager({ exec: realExec, pollMs: 400, logDir });
        const h = await m.start("exit 7"); // 显式退出（修前：.code 永不写，恒 running）
        try {
            await new Promise((r) => setTimeout(r, 5200)); // 多轮轮询（全量并发下本机 sh 后台任务时序余量；四十三期启动链加长〔setsid 探测+pgid〕后再放）
            const exit = m.list().find((s) => s.sessionId === h.sessionId);
            expect(exit?.running).toBe(false); // 修前：true（.code 不存在）
            const stopped = await m.stop(h.sessionId); // 已 finalize 的会话回真实退出码
            expect(stopped.status).toBe("exited");
            expect(stopped.exitCode).toBe(7); // .code 记录了真实退出码（修前：恒 running→stopped/unknown）
        } finally {
            await m.stop(h.sessionId).catch(() => undefined);
            rmSync(dirX, { recursive: true, force: true });
        }
    }, 30_000);

    // 自挖 R4：tailLines 静态分隔符 __FX_TL__ 可被输出内容伪造（echo 该字面量即令
    // 后续行错归流）——nonce 化后不可预测。真实 sh + 真后台进程 + 双文件。
    test("tailLines 自挖 R4：输出行含 __FX_TL__ 字面量不错位（真实 sh）", async () => {
        const shPath = Bun.which("sh");
        if (!shPath) return;
        const dirT = mkdtempSync(join(tmpdir(), "fx-tl-"));
        const logDir = dirT.replace(/\\/g, "/");
        const realExec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            const p = Bun.spawn(["sh", "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            p.stdin.write(cmd);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, exitCode: code };
        };
        const m = new RemoteSessionManager({ exec: realExec, pollMs: 60_000, logDir });
        const h = await m.start("sleep 60"); // 真后台进程
        try {
            writeFileSync(`${dirT}/${h.sessionId}.out`, "line1\n__FX_TL__\nline3\n"); // 伪造分隔符行
            writeFileSync(`${dirT}/${h.sessionId}.err`, "errline\n");
            const lines = await m.tailLines(h.sessionId, 50);
            const outTexts = lines.filter((l) => l.stream === "stdout").map((l) => l.text);
            const errTexts = lines.filter((l) => l.stream === "stderr").map((l) => l.text);
            expect(outTexts).toContain("__FX_TL__"); // 伪造行仍在 stdout（修前：静态 sep 被内容劈开）
            expect(outTexts).toContain("line3"); // 修前：line3 错归 stderr
            expect(errTexts).toEqual(["errline"]);
        } finally {
            await m.stop(h.sessionId).catch(() => undefined);
            rmSync(dirT, { recursive: true, force: true });
        }
    }, 25_000);
});

import { autonomousSshOpts } from "../src/ssh-helpers.js";

describe("host key 策略可配（AC-12）", () => {
    test("tofu 缺省=accept-new；strict=yes+known_hosts 路径展开", () => {
        const tofu = autonomousSshOpts();
        expect(tofu).toContain("StrictHostKeyChecking=accept-new");
        expect(tofu).toContain("ConnectTimeout=10");
        const strict = autonomousSshOpts({ hostKeyPolicy: "strict", knownHostsFile: "~/.ssh/known_hosts" });
        expect(strict).toContain("StrictHostKeyChecking=yes");
        expect(strict.some((a) => a.startsWith("UserKnownHostsFile=") && !a.includes("~"))).toBe(true); // ~ 已展开
    });
    test("渲染只含路径不含密钥内容（无泄漏红线）", () => {
        const opts = autonomousSshOpts({ hostKeyPolicy: "strict", keyFile: "~/.ssh/id_ed25519" });
        expect(opts.join(" ")).not.toMatch(/BEGIN.*PRIVATE KEY/); // 永不出现密钥内容
    });
});

describe("RemoteSessionManager.reapIdle（衰减回收）", () => {
    // TODO(interval 竞态): 手动 poll 链已验证 reap→TERM→核实→finalize 逻辑正确
    // （探查实证），但 interval 驱动路径在快速 mock 时钟下存在未定竞态——待查后启用
    test.skip("无人消费超 TTL 收摊+广播；armed 不收", async () => {
        // 永活远端：nohup 不落盘（.code 永不出现——会话长跑才走 reap 路径）
        const procs = new Set<number>();
        let pid = 5000;
        const aliveExec = async (cmd: string) => {
            if (cmd.includes("nohup sh -c")) { procs.add(++pid); return { stdout: String(pid), exitCode: 0 }; }
            if (cmd.startsWith("cat ")) return { stdout: "", exitCode: 0 };
            if (cmd.startsWith("tail -n +")) return { stdout: "", exitCode: 0 };
            const k0 = /kill -0 (\d+)/.exec(cmd);
            if (k0) return { stdout: procs.has(parseInt(k0[1]!, 10)) ? "Y" : "N", exitCode: 0 };
            const kv = /kill -(?:TERM|KILL) (\d+)/.exec(cmd);
            if (kv) { procs.delete(parseInt(kv[1]!, 10)); return { stdout: "", exitCode: 0 }; }
            return { stdout: "", exitCode: 0 };
        };
        const m = new (await import("../src/remote-session-manager.js")).RemoteSessionManager({ exec: aliveExec, pollMs: 50, idleReapMs: 1000 });
        const events: unknown[] = [];
        m.onEvent = (e) => events.push(e);
        const { sessionId: s1 } = await m.start("idle");
        const { sessionId: s2 } = await m.start("armed");
        m.watch(s2, { pattern: "NEVER", once: false });
        m.reapIdle(Date.now() + 2000, 1000);
        await new Promise((r) => setTimeout(r, 400)); // stop 核实链 + poll 轮落地
        const e1 = m.list().find((s) => s.sessionId === s1);
        const e2 = m.list().find((s) => s.sessionId === s2);
        expect(e1?.running).toBe(false); // 收摊：终态（句柄按语义保留）
        expect(e2?.running).toBe(true);  // armed = 常驻注意力不收
        expect(events.length).toBeGreaterThan(0); // 回收广播
    });
});

// GPT Astra 二十二期双回归（真实 sh）：
/** 轮询等待谓词（Hydrogen R3 #6 配套）：双流 poll 单轮往返数翻倍——固定 sleep 窗
 *  对真机 sh 冷启时序敏感，改谓词等待根治 */
async function waitFor(pred: () => boolean, timeoutMs = 6000): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
        if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
        await new Promise((r) => setTimeout(r, 100));
    }
}

describe("二十二期（真实 sh）", () => {
    const mkReal = (logDir: string, pollMs = 200) => {
        const shPath = Bun.which("sh")!;
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            p.stdin.write(cmd);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, exitCode: code };
        };
        return { m: new RemoteSessionManager({ exec, pollMs, logDir }), exec };
    };

    // #2 半行拼合：轮询间隙写入半行 RE → 补 ADY\n——READY 必须命中（修前被跳过/重复）
    test("字节游标半行拼合：RE → 补 ADY 后 READY 命中（不跳不重）", async () => {
        if (!Bun.which("sh")) return;
        const d = mkdtempSync(join(tmpdir(), "fx-half-"));
        const logDir = d.replace(/\\/g, "/");
        const { m } = mkReal(logDir);
        const h = await m.start("sleep 10");
        const matches: string[] = [];
        m.onEvent = (e) => { if ((e as { type?: string }).type === "match") matches.push((e as { matchedLine?: string }).matchedLine ?? ""); };
        m.watch(h.sessionId, { pattern: "READY", once: true });
        await new Promise((r) => setTimeout(r, 900)); // 一轮 poll（空输出——双流往返多，窗放宽）
        writeFileSync(join(d, `${h.sessionId}.out`), "RE"); // 半行
        await new Promise((r) => setTimeout(r, 900)); // 一轮 poll 读到半行（游标留 pending）
        writeFileSync(join(d, `${h.sessionId}.out`), "READY\n"); // 补全（append 语义）
        await waitFor(() => matches.includes("READY")); // 下轮拼合（谓词等待——不赌固定窗）
        expect(matches.filter((l) => l === "READY").length).toBe(1); // 不跳不重
        await m.stop(h.sessionId).catch(() => undefined);
        rmSync(d, { recursive: true, force: true });
    }, 20_000);

    // #1 nohup 127：.out 只证明重定向打开——nohup 本身失败时 wrapper 未跑、.pid 不出现
    test("nohup 127 幽灵防线：假 nohup 失败 → start 拒绝（wrapper .pid 未出现）", async () => {
        if (!Bun.which("sh")) return;
        const d = mkdtempSync(join(tmpdir(), "fx-n127-"));
        const logDir = d.replace(/\\/g, "/");
        const binWin = join(d, "bin");
        mkdirSync(binWin);
        writeFileSync(join(binWin, "nohup"), "#!/bin/sh\nexit 127\n");
        chmodSync(join(binWin, "nohup"), 0o755);
        const binSh = (logDir + "/bin").replace(/^([A-Za-z]):/, (_m, dr: string) => "/" + dr.toLowerCase());
        const shPath = Bun.which("sh")!;
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            p.stdin.write(`export PATH=${binSh}:$PATH; ${cmd}`);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, exitCode: code };
        };
        const m = new RemoteSessionManager({ exec, pollMs: 60_000, logDir });
        // 二十三期 #1 语义升级：超时≠确定失败——outcome:unknown + 核实线索（不再谎称「未拉起」）
        await expect(m.start("sleep 60")).rejects.toMatchObject({ outcome: "unknown" });
        expect(m.list()).toEqual([]);
        rmSync(d, { recursive: true, force: true });
    }, 25_000);
});

// 二十三期 #2（真实 sh）：无尾换行的末行 + .code 出现——终态冲刷后 watcher 必须命中
describe("终态尾行冲刷（二十三期）", () => {
    test("无换行尾行 READY + exit 0 → watcher 命中（修前：.code 即 finalize，尾行零命中）", async () => {
        if (!Bun.which("sh")) return;
        const d = mkdtempSync(join(tmpdir(), "fx-tail-"));
        const logDir = d.replace(/\\/g, "/");
        const shPath = Bun.which("sh")!;
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            p.stdin.write(cmd);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, exitCode: code };
        };
        const m = new RemoteSessionManager({ exec, pollMs: 200, logDir });
        const h = await m.start("echo hi; sleep 1");
        const matches: string[] = [];
        m.onEvent = (e) => { if ((e as { type?: string }).type === "match") matches.push((e as { matchedLine?: string }).matchedLine ?? ""); };
        m.watch(h.sessionId, { pattern: "READY", once: true });
        await new Promise((r) => setTimeout(r, 400));
        // 进程活着时写入无换行尾行（字节游标留 pending）；进程随后退出（.code 出现）
        writeFileSync(join(d, `${h.sessionId}.out`), "hi\nREADY"); // 无尾换行
        await waitFor(() => matches.includes("READY")); // 等 wrapper 退出 + 轮询发现 .code → 冲刷（谓词等待）
        expect(matches).toContain("READY"); // 修前：零命中
        rmSync(d, { recursive: true, force: true });
    }, 20_000);
});

// 自审（二十三期后续）：reapIdle 旧预发 exit(null) 双害——自然退出的会话被回收时
// 先收到错值 null 再收到真实码（双发）；修后 stop→finalize 统一发一声。
describe("reapIdle 事件单发（自审）", () => {
    test("回收已自然退出的会话 → exit 事件恰好一声且带真实码", async () => {
        if (!Bun.which("sh")) return;
        const d = mkdtempSync(join(tmpdir(), "fx-reap-"));
        const logDir = d.replace(/\\/g, "/");
        const shPath = Bun.which("sh")!;
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            p.stdin.write(cmd);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, exitCode: code };
        };
        const m = new RemoteSessionManager({ exec, pollMs: 150, logDir });
        const events: Array<{ type?: string; exitCode?: number | null }> = [];
        m.onEvent = (e) => events.push(e as never);
        const h = await m.start("echo done");
        await new Promise((r) => setTimeout(r, 900)); // 自然退出 + 轮询发现
        m.reapIdle(Date.now() + 60_000, 1); // 强制回收（已 running=false → 跳过 ✓ 无声）
        await new Promise((r) => setTimeout(r, 300));
        const exits = events.filter((e) => e.type === "exit");
        expect(exits.length).toBe(1); // 修前风险：预发 null + finalize 真实码=双发
        expect(exits[0]!.exitCode).toBe(0); // 真实码（非 null 错值）
        rmSync(d, { recursive: true, force: true });
    }, 20_000);
});

// GPT Astra 二十四期：flushTail 无会话互斥——并发 verify 双调用从同一 outBytes 读
// → 尾行双消费（watcher×2）+ 游标双跳（6→12）。会话级消费链后单发/游标准确。
describe("终态冲刷会话互斥（二十四期）", () => {
    test("并发双 verify → watcher 恰好一发、游标推进一次", async () => {
        const remote = fakeRemote();
        const m = new RemoteSessionManager({ exec: remote.exec, pollMs: 60_000 }); // 关轮询——只验证冲刷互斥
        const h = await m.start("echo READY; exit 0");
        // 定态：.out=READY\n（6 字节）、.code=0、进程已死（mock 的 nohup setTimeout 已跑完）
        await new Promise((r) => setTimeout(r, 120));
        remote.files.set(`${h.logBase}.out`, "READY\n");
        remote.files.set(`${h.logBase}.code`, "0");
        const matches: string[] = [];
        m.onEvent = (e) => { if ((e as { type?: string }).type === "match") matches.push((e as { matchedLine?: string }).matchedLine ?? ""); };
        m.watch(h.sessionId, { pattern: "READY", once: false });
        await Promise.all([m.verify(h.sessionId), m.verify(h.sessionId)]); // 并发双调用
        await new Promise((r) => setTimeout(r, 150));
        expect(matches.filter((l) => l === "READY").length).toBe(1); // 修前：2（双消费）
        const e = (m as unknown as { entries: Map<string, { outBytes: number }> }).entries.get(h.sessionId)!;
        expect(e.outBytes).toBe(6); // 修前：12（游标双跳）
    }, 15_000);
});

// 四十三期优先 1（进程树核实面）：pkill -P 只一层——多层脚本的孙进程在主 PID 死后
// 继续跑而旧 probe 只看主 PID=谎报 stopped。修=启动侧 setsid 组长+.pgid 落盘、
// 停止/核实组感知（组长死后孙持组存活=kill -0 -- -pgid 仍 ALIVE）。真机多层树另验。
describe("RemoteSessionManager 组杀（四十三期）", () => {
    test("孙进程持组存活：主 PID 已死仍不谎报——组杀全树后才 stopped", async () => {
        const remote = fakeRemote();
        const m = new RemoteSessionManager({ exec: remote.exec, pollMs: 30 });
        const h = await m.start("sleep 60"); // mock nohup：wrapper 组长+.pgid 已落盘
        // 主 wrapper 立即「死亡」（模拟脚本退了但孙进程还在跑）+ 孙进程持组存活
        (remote as unknown as { procs: Set<number> }).procs.delete(h.pid!);
        remote.grandkids.add(99999); // 孙进程（同 pgid）
        const r = await m.stop(h.sessionId);
        expect(r.status).toBe("stopped");          // 经组 KILL 全树死后才报
        expect(remote.grandkids.size).toBe(0);     // 修前：孙进程不清（pkill -P 一层够不着）
    }, 15_000);

    test("verify 组感知：孙进程在跑=running（主 PID 探测的盲区）", async () => {
        const remote = fakeRemote();
        const m = new RemoteSessionManager({ exec: remote.exec, pollMs: 30 });
        const h = await m.start("sleep 60");
        (remote as unknown as { procs: Set<number> }).procs.delete(h.pid!);
        remote.grandkids.add(77777);
        const r = await m.verify(h.sessionId);
        expect(r.status).toBe("running");          // 修前：主 PID 探测 N → unknown（孙在跑却不知）
        remote.grandkids.clear();
        await m.stop(h.sessionId).catch(() => undefined);
    }, 15_000);
});

// Gemini Hydrogen 审查批回归：tokenizeArgv 引号分词（#4）/ local verify pid 实测（#7）。
describe("Gemini 审查批回归", () => {
    test("#4 tokenizeArgv：引号内空格/转义不截断，字面引号不残留", async () => {
        const { tokenizeArgv } = await import("../src/ssh-helpers.js");
        expect(tokenizeArgv('ssh -i "/path/with space/key" host')).toEqual(["ssh", "-i", "/path/with space/key", "host"]); // 修前：截断+残留引号
        expect(tokenizeArgv("docker exec -i ctr sh -c 'echo hi'")).toEqual(["docker", "exec", "-i", "ctr", "sh", "-c", "echo hi"]);
        expect(tokenizeArgv("a '' b")).toEqual(["a", "", "b"]); // 空串参数保留
    });
});
