/**
 * ssh-helpers / 层状态机 / 远端会话引擎 单测（纯逻辑 + mock 远端，真机面属 CI sshd 矩阵）
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    sshArgsFor, hopSshCommand, hopLabel, enterStepsOf, renderExecChannel, envPrefixOf, parseJumpSpec,
} from "../src/ssh-helpers.js";
import { __testBrokenStdioExit, __testFileRedirect, resolveLayerState, SshPtyDriver } from "../src/ssh-pty-driver.js";
import { RemoteSessionManager } from "../src/remote-session-manager.js";
import type { SessionEvent } from "../src/session-types.js";
import { resolveLocalShell } from "../src/shell-discovery.js";
import { openSshEnvironment } from "../src/openssh-environment.js";
import { noopLogger } from "../src/logger.js";

test.skipIf(process.platform !== "linux")("SSH writeFile 解码器写出一部分再失败时保留原文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-ssh-write-"));
    const target = join(dir, "target");
    const driver = new SshPtyDriver({ driver: "ssh", target: "unused" });
    const failDecode = `base64() { if [ "$1" = -d ] && [ -f /dev/stdin ]; then printf partial; return 42; fi; command base64 "$@"; }; `;
    let fail = true;
    Object.assign(driver, {
        async execChannel(command: string) {
            const result = Bun.spawnSync(["sh", "-c", (fail ? failDecode : "") + command], { windowsHide: true });
            return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
        },
    });
    try {
        writeFileSync(target, "original");
        await expect(driver.fs.writeFile(target, "replacement")).rejects.toThrow(/解码失败/);
        expect(readFileSync(target, "utf-8")).toBe("original");
        expect(readdirSync(dir)).toEqual(["target"]);
        fail = false;
        chmodSync(target, 0o200);
        chmodSync(dir, 0o500);
        await driver.fs.writeFile(target, "replacement");
        chmodSync(target, 0o600);
        expect(readFileSync(target, "utf-8")).toBe("replacement");
    } finally {
        chmodSync(dir, 0o700);
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("ssh-helpers", () => {
    const proxyHost = (host: string) => process.platform === "win32" ? host : `'${host}'`;

    test("sshArgsFor：结构化参数渲染（ProxyJump/-i/-p/-L）", () => {
        expect(sshArgsFor("vm")).toEqual(["vm"]);
        expect(sshArgsFor({ host: "192.0.2.10", conn: { user: "root", port: 2222, jump: "jump", keyFile: "~/id_ed", forwards: [{ kind: "L", port: 8080, target: "localhost:80" }] } }))
            .toEqual([
                // ProxyCommand 等价形态（跳板白名单+sh 引用+策略随主连接——Astra 十一轮 #1/#2）
                "-o", `ProxyCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -W %h:%p ${proxyHost("jump")}`,
                "-i", expect.any(String), "-p", "2222", "-L", "8080:localhost:80", "root@192.0.2.10",
            ]);
        // 跳板串 [host]:port / host:port / user@[host]:port → 命令行 -p 展开（引用包裹）
        expect(sshArgsFor({ host: "t", conn: { jump: "[127.0.0.1]:2222" } })[1])
            .toBe(`ProxyCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p 2222 -W %h:%p ${proxyHost("127.0.0.1")}`);
        expect(sshArgsFor({ host: "t", conn: { jump: "root@h:2222" } })[1])
            .toBe(`ProxyCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p 2222 -W %h:%p ${proxyHost("root@h")}`);
        expect(sshArgsFor({ host: "t", conn: { jump: "u@[198.51.100.9]:2200" } })[1])
            .toBe(`ProxyCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p 2200 -W %h:%p ${proxyHost("u@198.51.100.9")}`);
        // IPv6 字面量
        expect(sshArgsFor({ host: "t", conn: { jump: "[::1]:2200" } })[1])
            .toBe(`ProxyCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p 2200 -W %h:%p ${proxyHost("::1")}`);
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
        expect(args[1]).toMatch(/UserKnownHostsFile=.*known_jumps/);
        expect(args[1]).toContain(`-p 2222 -W %h:%p ${proxyHost("ops@jump.example")}`);
        expect(args[1]).toMatch(/-i .*id_jump/);
    });

    test.skipIf(process.platform !== "win32")("Windows proxy paths with spaces use native argv quoting", () => {
        const args = sshArgsFor({ host: "target.example", conn: {
            jump: { host: "jump.example", keyFile: "C:\\SSH data\\id_jump" },
            hostKeyPolicy: "strict",
            knownHostsFile: "C:\\SSH data\\known_hosts",
        } });
        expect(args[1]).toBe('ProxyCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=\\"C:/SSH data/known_hosts\\"" -i "C:\\SSH data\\id_jump" -W %h:%p jump.example');
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
        const p = Bun.spawn([shPath, "-c", `set -- ${line}; printf '%s' "$@"`], { stdout: "pipe", windowsHide: true });
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
        expect(r.stdinCmd).toContain(`cd './${evil}' ||`); // 相对形态强制 ./（Sol 89 P1-7——单引号字面化不受影响）
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
            const p = Bun.spawn([sh, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
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
        const quoted = renderExecChannel([{ cmd: "ssh -t -i '/tmp/key  -t name' remote-vm" }], "x", { marker: "M", nonceWrapped: "( x )" });
        expect(quoted).toMatchObject({
            kind: "ok",
            remoteArgs: ["ssh", "-i", "'/tmp/key  -t name'", "remote-vm", "sh", "-s", "sh", "-s"],
        });
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
        const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
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
            const p = Bun.spawn(["sh", "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
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
            // tailLines 双 rc 复合形态（Sol 69 #3）：两流各自缺席=非零
            if (cmd.includes("__fx_r1")) {
                const sep = cmd.match(/echo (__FX_TL_\w+__)/)![1]!;
                const base = unq(cmd.match(/tail -n \d+ (\S+)\.out/)?.[1] ?? "");
                const o = files.get(`${base}.out`);
                const er = files.get(`${base}.err`);
                if (o == null || er == null) return { stdout: "", exitCode: 9 };
                const t = (b: string) => b.split("\n").filter(Boolean).slice(-n).join("\n");
                return { stdout: `${t(o)}\n${sep}\n${t(er)}`, exitCode: 0 };
            }
            const f = unq(cmd.match(/(\S+)\.out/)?.[1] ?? "");
            if (!files.has(`${f}.out`)) return { stdout: "", exitCode: 1 }; // 无 || true（Sol 69 #3）
            const all = (files.get(`${f}.out`) ?? "").split("\n").filter(Boolean);
            return { stdout: all.slice(-n).join("\n"), exitCode: 0 };
        }
        // readLog 可读性门形态（Sol 69 #3）：test -r 'X' || exit 9; cat/tail 'X'
        if (cmd.startsWith("test -r ")) {
            const m = cmd.match(/test -r (\S+) \|\| exit 9; (cat|tail -n \+\d+) (\S+)/);
            if (m) {
                const f = unq(m[1]!);
                if (!files.has(f)) return { stdout: "", exitCode: 9 }; // 不可读——整体失败
                let text = files.get(f) ?? "";
                if (m[2]!.startsWith("tail")) {
                    const from = parseInt(m[2]!.match(/\+(\d+)/)![1]!, 10) - 1;
                    text = text.split("\n").slice(from).join("\n");
                }
                return { stdout: text, exitCode: 0 };
            }
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
    test("stop 采纳 TERM 期间写入的退出码", async () => {
        let code = "";
        const manager = new RemoteSessionManager({
            pollMs: 60_000,
            exec: async (cmd) => {
                if (cmd.includes(".pid.tmp")) return { stdout: "4242", exitCode: 0 };
                if (cmd.startsWith("cat ") && cmd.includes(".code 2>")) return { stdout: code, exitCode: 0 };
                if (cmd.includes("kill -TERM")) code = "23";
                if (cmd.includes("echo ALIVE")) return { stdout: "DEAD", exitCode: 0 };
                return { stdout: "", exitCode: 0 };
            },
        });
        const h = await manager.start("fixture");
        const expected = { status: "exited", exitCode: 23 } as const;
        expect(await manager.stop(h.sessionId)).toEqual(expected);
        expect(await manager.verify(h.sessionId)).toEqual(expected);
    });

    test.each([
        ["PID 复用", "22222", ["TERM"], "unknown"],
        ["身份未变化", "11111", ["TERM", "KILL"], "stopped"],
        ["未记录身份戳", "", ["TERM"], "unknown"],
    ])("stop 在 %s 时按身份核验限制 KILL", async (label, afterTerm, expectedSignals, status) => {
        const shell = resolveLocalShell();
        const signals: string[] = [];
        const initialStamp = label === "未记录身份戳" ? "" : "11111";
        let stamp = initialStamp;
        const m = new RemoteSessionManager({
            pollMs: 60_000,
            exec: async (cmd) => {
                if (cmd.includes(".pid.tmp")) return { stdout: "4242", exitCode: 0 };
                if (cmd.startsWith("cat ") && cmd.includes(".st 2>")) return { stdout: initialStamp, exitCode: 0 };
                if (cmd.includes("echo ALIVE")) {
                    return { stdout: signals.includes("KILL") ? "DEAD" : "ALIVE", exitCode: 0 };
                }
                if (/kill -(?:TERM|KILL)/.test(cmd)) {
                    // Execute the generated guard with shell functions standing in for process I/O.
                    const script = `cat() { :; }; awk() { printf '%s\\n' "$FX_TEST_STAMP"; }; ` +
                        `pkill() { :; }; kill() { printf '%s\\n' "$1"; }; sleep() { :; }; ${cmd}`;
                    const r = Bun.spawnSync([shell, "-s"], {
                        stdin: Buffer.from(script), env: { ...process.env, FX_TEST_STAMP: stamp }, windowsHide: true,
                    });
                    const signal = r.stdout.toString().trim().replace(/^-/, "");
                    if (signal) signals.push(signal);
                    if (signal === "TERM") stamp = afterTerm as string;
                    return { stdout: "", exitCode: r.exitCode };
                }
                return { stdout: "", exitCode: 0 };
            },
        });
        const { sessionId } = await m.start("fixture");
        expect(await m.stop(sessionId)).toMatchObject({ status });
        expect(signals).toEqual(expectedSignals);
    }, 15_000);

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

    test("poll preserves a natural exit code published between the first read and the process probe", async () => {
        let code = "";
        const exited = Promise.withResolvers<number | null>();
        const manager = new RemoteSessionManager({
            pollMs: 10,
            exec: async (cmd) => {
                if (cmd.includes(".pid.tmp")) return { stdout: "4242", exitCode: 0 };
                if (cmd.startsWith("cat ") && cmd.includes(".code 2>")) {
                    return { stdout: code, exitCode: code ? 0 : 1 };
                }
                if (cmd.includes("echo ALIVE")) {
                    code = "7";
                    return { stdout: "DEAD", exitCode: 0 };
                }
                return { stdout: "", exitCode: 0 };
            },
        });
        manager.onEvent = (event) => { if (event.type === "exit") exited.resolve(event.exitCode); };
        const { sessionId } = await manager.start("fixture");
        expect(await exited.promise).toBe(7);
        expect(await manager.stop(sessionId)).toEqual({ status: "exited", exitCode: 7 });
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
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
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
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
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
            const p = Bun.spawn(["sh", "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
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
    test("renders a known_hosts path with spaces as one OpenSSH config value", () => {
        const path = process.platform === "win32" ? "C:\\SSH data\\known_hosts" : "/fixture/SSH data/known_hosts";
        const expected = process.platform === "win32" ? "C:/SSH data/known_hosts" : path;
        expect(autonomousSshOpts({ knownHostsFile: path })).toContain(`UserKnownHostsFile="${expected}"`);
    });

    test("PTY hop keeps file arguments intact and lets remote OpenSSH resolve its own home", () => {
        const command = hopSshCommand({
            host: "fixture.invalid",
            conn: {
                knownHostsFile: "~/SSH data/known_hosts",
                keyFile: "~/SSH data/id_fixture",
                jump: { host: "jump.invalid", keyFile: "~/SSH data/id_jump" },
            },
        });
        const argv = Bun.spawnSync([resolveLocalShell(), "-c", `ssh() { printf '%s\\n' "$@"; }; ${command}`], { windowsHide: true });
        expect(argv.exitCode).toBe(0);
        const args = argv.stdout.toString().trimEnd().split(/\r?\n/);
        expect(args).toContain('UserKnownHostsFile="~/SSH data/known_hosts"');
        expect(args).toContain("~/SSH data/id_fixture");
        expect(args.find((arg) => arg.startsWith("ProxyCommand="))).toContain("-i '~/SSH data/id_jump'");
    }, 15_000);

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
    test("无人消费超 TTL 收摊+广播；armed 不收", async () => {
        // 永活远端：nohup 不落盘（.code 永不出现——会话长跑才走 reap 路径）
        const procs = new Set<number>();
        let pid = 5000;
        const aliveExec = async (cmd: string) => {
            if (cmd.includes("nohup sh -c")) { procs.add(++pid); return { stdout: String(pid), exitCode: 0 }; }
            if (cmd.startsWith("cat ")) return { stdout: "", exitCode: 0 };
            if (cmd.startsWith("tail -n +")) return { stdout: "", exitCode: 0 };
            const k0 = /kill -0 (\d+)/.exec(cmd);
            if (k0) return { stdout: procs.has(parseInt(k0[1]!, 10)) ? "ALIVE" : "DEAD", exitCode: 0 };
            const kv = /kill -(?:TERM|KILL) (\d+)/.exec(cmd);
            if (kv) { procs.delete(parseInt(kv[1]!, 10)); return { stdout: "", exitCode: 0 }; }
            return { stdout: "", exitCode: 0 };
        };
        const m = new RemoteSessionManager({ exec: aliveExec, pollMs: 50, idleReapMs: 1000 });
        const events: SessionEvent[] = [];
        m.onEvent = (e) => events.push(e);
        const { sessionId: s1 } = await m.start("idle");
        const { sessionId: s2 } = await m.start("armed");
        m.watch(s2, { pattern: "NEVER", once: false });
        m.reapIdle(Date.now() + 2000, 1000);
        await waitFor(() => m.list().some((session) => session.sessionId === s1 && !session.running));
        const e1 = m.list().find((s) => s.sessionId === s1);
        const e2 = m.list().find((s) => s.sessionId === s2);
        expect(e1?.running).toBe(false); // 收摊：终态（句柄按语义保留）
        expect(e2?.running).toBe(true);  // armed = 常驻注意力不收
        expect(events.filter((e) => e.type === "exit").map((e) => e.sessionId)).toEqual([s1]);
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
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
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
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
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
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
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
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
            p.stdin.write(cmd);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, exitCode: code };
        };
        const m = new RemoteSessionManager({ exec, pollMs: 150, logDir });
        const events: Array<{ type?: string; exitCode?: number | null }> = [];
        m.onEvent = (e) => events.push(e as never);
        const h = await m.start("echo done");
        // flake 治理补漏（Sol 71 环境实锤）：固定 900ms 在慢环境（sh 冷启/杀软
        // 扫描拖慢每次 exec 的 spawn）内 poll 发现不了 .code → 0 exit——改谓词
        // 等待（waitFor 已有），慢环境给足余量
        await waitFor(() => events.some((e) => e.type === "exit"), 15_000);
        m.reapIdle(Date.now() + 60_000, 1); // 强制回收（已 running=false → 跳过 ✓ 无声）
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

// GPT Sol 五十九期 P1-2：poll 探针凭证纪律——includes("N") 子串匹配曾把两类脏
// 结果当死讯终结会话：①探针命令自身失败（exitCode 1 + stdout "N"——通道失灵
// 的输出不是死亡凭证，与 .code 读同一纪律）②输出非精确标记（"NOT DEAD" 含 N）。
// 修：exitCode=0 且 trim 后恰为 "N" 才判死（与 stop/verify 的精确匹配同口径）。
describe("Sol 59：poll 探针脏结果不判死", () => {
    test("exit 1+‘N’ 与 exit 0+‘NOT DEAD’ 均不终结；精确 ‘DEAD’ 才判死（null 退出码）", async () => {
        const remote = fakeRemote();
        let probe: { stdout: string; exitCode: number } | null = null;
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (cmd.startsWith("g=$(cat ") && cmd.includes("kill -0") && probe) return probe;
            if (/^cat \S+\.code/.test(cmd)) return { stdout: "", exitCode: 0 }; // .code 恒缺席（走 pid 探针分支）
            return remote.exec(cmd);
        };
        const m = new RemoteSessionManager({ exec, pollMs: 25 });
        const events: SessionEvent[] = [];
        m.onEvent = (e) => events.push(e);
        const h = await m.start("sleep 60");
        remote.procs.delete(h.pid!); // 进程已死但无 .code——探针分支
        probe = { stdout: "N", exitCode: 1 }; // 探针命令失败：输出不作死亡凭证
        await new Promise((r) => setTimeout(r, 150));
        expect(events.some((e) => e.type === "exit")).toBe(false); // 修前：includes("N") 判死
        probe = { stdout: "NOT DEAD", exitCode: 0 }; // 输出非精确标记（含 N 子串）
        await new Promise((r) => setTimeout(r, 150));
        expect(events.some((e) => e.type === "exit")).toBe(false); // 修前：同判死
        probe = { stdout: "UNKNOWN", exitCode: 0 };
        await new Promise((r) => setTimeout(r, 150));
        expect(events.some((e) => e.type === "exit")).toBe(false);
        probe = { stdout: "DEAD\n", exitCode: 0 }; // 精确 N（trim 后）→ 判死
        await new Promise((r) => setTimeout(r, 150));
        const exit = events.find((e) => e.type === "exit") as Extract<SessionEvent, { type: "exit" }>;
        expect(exit).toBeTruthy();
        expect(exit.exitCode).toBeNull(); // 无 .code 的外部死亡 → unknown 退出码
    }, 15_000);
});

// GPT Sol 六十期 P2-5：verify() 存活探针 includes("Y") 子串匹配——"NOT Y" 等
// 非标准输出曾判 running。改精确单标记（与 Sol 59 P1-2 的 poll 探针同口径）。
describe("Sol 60：verify 探针精确匹配", () => {
    test("stdout ‘NOT Y’ exit 0 → unknown；精确 ‘ALIVE’ → running", async () => {
        const remote = fakeRemote();
        let probe: { stdout: string; exitCode: number } | null = null;
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (cmd.startsWith("g=$(cat ") && cmd.includes("kill -0") && probe) return probe;
            if (/^cat \S+\.code/.test(cmd)) return { stdout: "", exitCode: 0 }; // .code 恒缺席
            return remote.exec(cmd);
        };
        const m = new RemoteSessionManager({ exec, pollMs: 10_000 });
        const h = await m.start("sleep 60");
        probe = { stdout: "NOT Y", exitCode: 0 };
        expect((await m.verify(h.sessionId)).status).toBe("unknown"); // 修前：running
        probe = { stdout: "ALIVE\n", exitCode: 0 };
        expect((await m.verify(h.sessionId)).status).toBe("running");
    }, 15_000);
});

// GPT Sol 六十四期 P2-6：stderr 无换行尾行漏 watcher——终态冲刷曾只读 .out。
describe("Sol 64：stderr 尾行冲刷", () => {
    test("stderr 最后输出无换行尾行 → exit 前冲刷喂 watcher 命中", async () => {
        const remote = fakeRemote();
        const m = new RemoteSessionManager({ exec: remote.exec, pollMs: 30 });
        const events: SessionEvent[] = [];
        m.onEvent = (e) => events.push(e);
        const h = await m.start("err tail");
        m.watch(h.sessionId, { pattern: "STDERR_TAIL", once: true });
        // 自动完成（60ms 落 .code）前注入 stderr 尾行（无换行——轮询只交付完整行）
        setTimeout(() => { remote.files.set(`${h.logBase}.err`, "STDERR_TAIL"); }, 25);
        await new Promise((r) => setTimeout(r, 400));
        expect(events.some((e) => e.type === "exit")).toBe(true);
        expect(events.some((e) => e.type === "match" && e.matchedLine.includes("STDERR_TAIL"))).toBe(true); // 修前：只有 exit
    }, 15_000);
});

// GPT Sol 六十五期：#1 match 事件 stream 写死 stdout（stderr 行命中的事件流标错）；
// #2 flushTail 两路共用 try（stdout 读抛错连坐跳过 stderr 尾行）；#3 读命令失败
//（exit≠0）的输出不作行凭证（曾据错误输出发 match、thenStop 还误触停止）。
describe("Sol 65：冲刷凭证与事件流", () => {
    test("#1+#2 stdout 读抛错不断 stderr 冲刷——match 事件 stream 如实标 stderr", async () => {
        const remote = fakeRemote();
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (/tail -c \+\d+ \S+\.out/.test(cmd)) throw new Error("out channel gone"); // stdout 末读抛错
            return remote.exec(cmd);
        };
        const m = new RemoteSessionManager({ exec, pollMs: 10_000 });
        const events: SessionEvent[] = [];
        m.onEvent = (e) => events.push(e);
        const h = await m.start("x");
        m.watch(h.sessionId, { pattern: "STDERR_TAIL", once: true });
        setTimeout(() => { remote.files.set(`${h.logBase}.err`, "STDERR_TAIL"); }, 25);
        await new Promise((r) => setTimeout(r, 100)); // 自动完成（60ms 落 .code）
        const v = await m.verify(h.sessionId); // verify 路径触终态冲刷（poll 长周期免干扰）
        expect(v.status).toBe("exited");
        await new Promise((r) => setTimeout(r, 50));
        const match = events.find((e) => e.type === "match") as Extract<SessionEvent, { type: "match" }> | undefined;
        expect(match?.matchedLine).toContain("STDERR_TAIL"); // 修前 #2：out 抛错连坐、无 match
        expect(match?.stream).toBe("stderr"); // 修前 #1：写死 stdout
    }, 15_000);

    test("#3 读命令失败（exit 1+匹配文本在输出里）不作行凭证——无 match", async () => {
        const remote = fakeRemote();
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (/tail -c \+\d+ \S+\.err/.test(cmd)) {
                return { stdout: "STDERR_TAIL", exitCode: 1 }; // 失败命令的输出含匹配文本
            }
            return remote.exec(cmd);
        };
        const m = new RemoteSessionManager({ exec, pollMs: 10_000 });
        const events: SessionEvent[] = [];
        m.onEvent = (e) => events.push(e);
        const h = await m.start("x");
        m.watch(h.sessionId, { pattern: "STDERR_TAIL", once: true });
        await new Promise((r) => setTimeout(r, 100));
        await m.verify(h.sessionId);
        await new Promise((r) => setTimeout(r, 50));
        expect(events.some((e) => e.type === "match")).toBe(false); // 修前：match 照发
    }, 15_000);
});

// GPT Sol 六十六期：#1 常规轮询读命令失败（exit≠0）输出不作行凭证（终态冲刷
// 已查、轮询漏查——曾据错误输出发 match 还推进游标）；#2 轮询单流抛错不连坐
// 另一流（stdout 持续抛错曾堵死 stderr 读取）。
describe("Sol 66：轮询凭证与分流隔离", () => {
    test("#1 poll stderr 读 exit 1+MATCH 输出 → 无 match", async () => {
        const remote = fakeRemote();
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (/tail -c \+\d+ \S+\.err/.test(cmd)) return { stdout: "MATCH\n", exitCode: 1 }; // 失败命令的输出含匹配文本
            return remote.exec(cmd);
        };
        const m = new RemoteSessionManager({ exec, pollMs: 30 });
        const events: SessionEvent[] = [];
        m.onEvent = (e) => events.push(e);
        const h = await m.start("x");
        m.watch(h.sessionId, { pattern: "MATCH", once: true });
        await new Promise((r) => setTimeout(r, 400));
        expect(events.some((e) => e.type === "match")).toBe(false); // 修前：poll 照喂
    }, 15_000);

    test("#2 poll stdout 读持续抛错——stderr 完整行照喂 watcher", async () => {
        const remote = fakeRemote();
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (/tail -c \+\d+ \S+\.out/.test(cmd)) throw new Error("out channel gone");
            return remote.exec(cmd);
        };
        const m = new RemoteSessionManager({ exec, pollMs: 30 });
        const events: SessionEvent[] = [];
        m.onEvent = (e) => events.push(e);
        const h = await m.start("x");
        m.watch(h.sessionId, { pattern: "ERRLINE", once: true });
        setTimeout(() => { remote.files.set(`${h.logBase}.err`, "ERRLINE\n"); }, 25);
        await new Promise((r) => setTimeout(r, 400));
        expect(events.some((e) => e.type === "match" && e.matchedLine.includes("ERRLINE"))).toBe(true); // 修前：out 抛错连坐
    }, 15_000);
});

// GPT Sol 六十七期 P2-3：tail()/readLog() 直接读取入口缺退出码检查——失败
// 命令（exit 1）的输出曾当正常日志返回（轮询/冲刷已查、此处漏查）。
describe("Sol 67：直接读取凭证纪律", () => {
    test("tail/readLog 读命令 exit 1+PARTIAL → 拒绝（不作日志凭证）", async () => {
        const remote = fakeRemote();
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (cmd.startsWith("tail -n ") || cmd.startsWith("test -r ") || cmd.startsWith("cat ")) return { stdout: "PARTIAL", exitCode: 1 };
            return remote.exec(cmd);
        };
        const m = new RemoteSessionManager({ exec, pollMs: 10_000 });
        const h = await m.start("x");
        await new Promise((r) => setTimeout(r, 100)); // 自动完成落 .code/.out
        await expect(m.tail(h.sessionId)).rejects.toThrow(/不作日志凭证/); // 修前：返回 ["PARTIAL"]
        await expect(m.readLog(h.sessionId)).rejects.toThrow(/不作日志凭证/); // 修前：返回 "PARTIAL"
    }, 15_000);
});

// GPT Sol 六十八期 #5：tailLines()（双流行对象读取入口）补凭证纪律——
// exit≠0 的输出不作日志凭证（tail/readLog 上轮已查、此处漏查）。
describe("Sol 68：tailLines 凭证", () => {
    test("读命令 exit 1+partial → 拒绝（不作日志凭证）", async () => {
        const remote = fakeRemote();
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (cmd.startsWith("tail -n ")) return { stdout: "partial", exitCode: 1 };
            return remote.exec(cmd);
        };
        const m = new RemoteSessionManager({ exec, pollMs: 10_000 });
        const h = await m.start("x");
        await new Promise((r) => setTimeout(r, 100));
        await expect(m.tailLines(h.sessionId)).rejects.toThrow(/不作日志凭证/); // 修前：返回 partial 行
    }, 15_000);
});

// GPT Sol 六十九期 #3：真实 shell 语义——readLog 的 || true 吞错、tailLines
// 只拿末个 tail 的退出码（stdout 缺失+stderr 正常曾当正常返回）。
describe("Sol 69：读取失败不被掩盖", () => {
    test("stdout 日志缺失（stderr 仍在）→ tail/readLog/tailLines 全拒绝", async () => {
        const remote = fakeRemote();
        const m = new RemoteSessionManager({ exec: remote.exec, pollMs: 10_000 });
        const h = await m.start("x");
        await new Promise((r) => setTimeout(r, 100)); // 自动完成（.out/.code 落盘）
        remote.files.set(`${h.logBase}.err`, "OK\n");
        remote.files.delete(`${h.logBase}.out`); // stdout 日志缺失
        await expect(m.readLog(h.sessionId)).rejects.toThrow(/不作日志凭证/); // 修前：""（|| true 吞错）
        await expect(m.tail(h.sessionId)).rejects.toThrow(/不作日志凭证/); // 修前：[]（|| true 吞错）
        await expect(m.tailLines(h.sessionId)).rejects.toThrow(/不作日志凭证/); // 修前：stderr 行照常返回
    }, 15_000);
});

// GPT Sol 七十期 #3：readLog({lines}) 的 `cat f | tail -n N` 管道整体 rc 只反映
// 末命令——日志路径是可读目录时 test -r 通过而 cat 失败，曾当空日志返回。
// lines 截断改命令替换中转（cat 失败经 || exit 9 直达整体退出码）。
describe("Sol 70：readLog lines 管道掩码", () => {
    test("日志路径为可读目录：lines 截断与全量读取都拒绝", async () => {
        const remote = fakeRemote();
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (cmd.startsWith("test -r ")) return { stdout: "", exitCode: 9 }; // 门过后读取即败（目录态）
            return remote.exec(cmd);
        };
        const m = new RemoteSessionManager({ exec, pollMs: 10_000 });
        const h = await m.start("x");
        await new Promise((r) => setTimeout(r, 100));
        await expect(m.readLog(h.sessionId, { lines: 5 })).rejects.toThrow(/不作日志凭证/); // 修前：""（管道尾 tail rc=0）
        await expect(m.readLog(h.sessionId)).rejects.toThrow(/不作日志凭证/); // 对照（Sol 69 已修）
    }, 15_000);
});

// GPT Sol 七十一期 #4：readLog({lines}) 的命令替换中转曾吞尾换行+剥 NUL
//（first\n\n 取末行得 first 而非空行）。临时文件中转保字节保真——真 shell 验证。
describe("Sol 71：readLog lines 字节保真", () => {
    test.skipIf(!Bun.which("sh"))("尾空行保留 + NUL 不丢", async () => {
        const remote = fakeRemote();
        const shPath = Bun.which("sh")!;
        const realSh = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
            p.stdin.write(cmd);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, exitCode: code };
        };
        const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            if (cmd.startsWith("test -r ")) return realSh(cmd); // readLog 形态走真 shell
            return remote.exec(cmd);
        };
        const d = mkdtempSync(join(tmpdir(), "fx-rl71-"));
        try {
            const m = new RemoteSessionManager({ exec, pollMs: 10_000, logDir: d.replace(/\\/g, "/") });
            const h = await m.start("x");
            // 尾空行：last line of "first\n\n" 是空行（readLog 返回剥一个尾换行 → ""）
            writeFileSync(`${h.logBase}.out`, "first\n\n"); // 真文件（真 shell 读真盘）
            expect(await m.readLog(h.sessionId, { lines: 1 })).toBe(""); // 修前："first"（$() 吞尾换行）
            expect(await m.readLog(h.sessionId, { lines: 2 })).toBe("first\n"); // 两行=first+空行（尾剥一个换行后留 first\n）
            // NUL 字节不丢
            writeFileSync(`${h.logBase}.out`, "a\0b\n");
            expect(await m.readLog(h.sessionId, { lines: 1 })).toBe("a\0b"); // 修前：NUL 被 $() 剥
        } finally {
            rmSync(d, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 七十二期 #3：readLog({lines}) 的临时副本曾落日志目录——只读目录下
// lines 读报错而全量读正常。临时文件改落远端 $TMPDIR（命令形态断言 + 真 shell
// 落点断言双验）。
describe("Sol 72：lines 临时副本落 TMPDIR", () => {
    test("命令的临时路径在 ${TMPDIR:-/tmp} 下（真 shell 可执行且不在日志目录）", async () => {
        const remote = fakeRemote();
        const shell = resolveLocalShell();
        const d = mkdtempSync(join(tmpdir(), "fx-tmp72-"));
        const scratch = join(d, "scratch");
        let sawCmd = "";
        const realSh = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
            const p = Bun.spawn([shell, "--posix", "-s"], {
                stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
                env: { ...process.env, TMPDIR: scratch.replaceAll("\\", "/") },
            });
            p.stdin.write(cmd);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, exitCode: code };
        };
        try {
            mkdirSync(scratch);
            const logDir = d.replace(/\\/g, "/");
            const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
                if (cmd.startsWith("test -r ")) { sawCmd = cmd; return realSh(cmd); }
                return remote.exec(cmd);
            };
            const m = new RemoteSessionManager({ exec, pollMs: 10_000, logDir });
            const h = await m.start("x");
            writeFileSync(`${h.logBase}.out`, "first\nsecond\n"); // 真文件（真 shell）
            expect(await m.readLog(h.sessionId, { lines: 1 })).toBe("second");
            expect(sawCmd).toContain('__fx_d="${TMPDIR:-/tmp}"'); // 临时副本根在 TMPDIR（Sol 73 #6 起带失效回落）
            expect(sawCmd).toContain('$__fx_d/fx-rl-');
            expect(sawCmd).not.toContain(`${logDir}/fx-rl-`); // 不落日志目录（只读目录也可读）
            // 副本清场：TMPDIR 下无残留
            expect(readdirSync(scratch)).toEqual([]);
        } finally {
            rmSync(d, { recursive: true, force: true });
        }
    }, 20_000);
});

// GPT Sol 七十三期 #6：TMPDIR 指向不存在目录时，readLog({lines}) 曾 exit 9
//（全量读正常）——临时盘依赖。TMPDIR 失效回落 /tmp（真 shell 实证）。
describe("Sol 73：TMPDIR 失效回落", () => {
    test.skipIf(!Bun.which("sh"))("TMPDIR=/nonexistent-fx-73 下 lines 读正常", async () => {
        const remote = fakeRemote();
        const shPath = Bun.which("sh")!;
        const realSh = async (cmd: string, env?: Record<string, string>): Promise<{ stdout: string; exitCode: number }> => {
            const p = Bun.spawn([shPath, "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, ...env } });
            p.stdin.write(cmd);
            await p.stdin.end();
            const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            return { stdout, exitCode: code };
        };
        const d = mkdtempSync(join(tmpdir(), "fx-td73-"));
        try {
            const logDir = d.replace(/\\/g, "/");
            const exec = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
                if (cmd.startsWith("test -r ")) return realSh(cmd, { TMPDIR: "/nonexistent-fx-73" }); // TMPDIR 失效注入
                return remote.exec(cmd);
            };
            const m = new RemoteSessionManager({ exec, pollMs: 10_000, logDir });
            const h = await m.start("x");
            writeFileSync(`${h.logBase}.out`, "first\nsecond\n");
            expect(await m.readLog(h.sessionId)).toBe("first\nsecond"); // 全量（对照）
            expect(await m.readLog(h.sessionId, { lines: 1 })).toBe("second"); // 修前：抛 exit 9
        } finally {
            rmSync(d, { recursive: true, force: true });
        }
    }, 20_000);
});

// DeepSeek Harness 反馈：沙箱拦截匿名管道——stdio:'pipe' spawn 的 ssh 秒退 255
// 零输出。快速诊断指纹（255+零输出+<500ms），文件中转由环境变量显式选择。
describe("DS 反馈：沙箱 stdio 管道损坏", () => {
    test.skipIf(process.platform !== "win32")("Windows OpenSSH environment fills missing values and preserves configured values", () => {
        const source = {
            SYSTEMROOT: "",
            SystemRoot: "D:\\Windows",
            programdata: "E:\\Shared Data",
            username: "configured-user",
            Path: "X:\\bin",
        };
        const warnings: string[] = [];
        const log = { ...noopLogger, warn: (message: string) => warnings.push(message) };
        const env = openSshEnvironment(source, log);
        expect(env).toMatchObject({
            SystemRoot: "D:\\Windows", windir: "D:\\Windows", SystemDrive: "D:",
            programdata: "E:\\Shared Data", ALLUSERSPROFILE: "E:\\Shared Data", username: "configured-user", Path: "X:\\bin",
        });
        expect(env.SYSTEMROOT).toBeUndefined();
        expect(source.SYSTEMROOT).toBe("");
        expect(Object.hasOwn(source, "windir")).toBe(false);
        expect(warnings).toEqual([]);
        const missingRoot = { WINDIR: "D:\\Windows" };
        expect(openSshEnvironment(missingRoot, log).SystemRoot).toBe(missingRoot.WINDIR);
        openSshEnvironment(missingRoot, log);
        expect(warnings).toEqual([expect.stringContaining("缺少 SystemRoot")]);
        expect(warnings[0]).not.toContain(missingRoot.WINDIR);
    });

    test("file stdio rejects PTY hops and persistent forwards before attempting a connection", async () => {
        const original = process.env.FILAXIS_SSH_STDIO_MODE;
        process.env.FILAXIS_SSH_STDIO_MODE = "inherit";
        try {
            for (const [config, message] of [
                [{ sshHops: ["destination.invalid"] }, /inherit.*逐跳 PTY.*-J/],
                [{ connParams: { forwards: [{ kind: "D", port: 1080 }] } }, /inherit.*持久端口转发/],
                [{ enterPipeline: [{ cmd: "su -" }] }, /inherit.*交互进入/],
            ] as const) {
                const driver = new SshPtyDriver({ driver: "ssh", target: "root.invalid", config });
                try { await expect(driver.init()).rejects.toThrow(message); }
                finally { await driver.destroy(); }
            }
        } finally {
            if (original === undefined) delete process.env.FILAXIS_SSH_STDIO_MODE;
            else process.env.FILAXIS_SSH_STDIO_MODE = original;
        }
    });

    test("isBrokenStdioExit 指纹判定：255+零输出+快退；任一不满足不判", () => {
        expect(__testBrokenStdioExit(255, "", "", 100)).toBe(true);
        expect(__testBrokenStdioExit(255, "x", "", 100)).toBe(false);
        expect(__testBrokenStdioExit(1, "", "", 100)).toBe(false);
        expect(__testBrokenStdioExit(255, "", "", 2000)).toBe(false);
        expect(__testBrokenStdioExit(null, "", "", 100)).toBe(false);
    }, 10_000);
});

// GPT Sol 七十八期：P1-1 文件中转曾漏 ssh 本体（选项直交 shell）；P1-2 自动
// 重放撤除（首轮结果未知=可能已执行副作用——非幂等命令重试违宪）；#6 abort
// 信号贯通；#7 中转文件 0600。
describe("Sol 78：文件中转三缝", () => {
    test.skipIf(!Bun.which("ssh"))("P1-1 中转命令含 ssh 本体：ssh -V 真跑通（修前 /bin/sh: -o not found）", async () => {
        const r = await __testFileRedirect(["-V"], ""); // ssh -V：版本打到 stderr
        expect(r.stderr).toMatch(/OpenSSH|OpenSSH_for_Windows/i); // 修前：'-o/-V: not found'（无 ssh 本体）
    }, 15_000);
});

// GPT Sol 七十九期 P1-1：Windows cmd 单串直传（spawn 的 args 数组会被 Node 再
// 包引号→「文件名语法错误」被中转吞掉）；#4 取消竞态+AbortError 带 outcome；
// #6 准备失败清理 .in。真 shell 跑 -V 验证双流+退出码往返。
describe("Sol 79：中转 Windows 形态/取消纪律", () => {
    test.skipIf(!Bun.which("ssh"))("P1-1 中转 ssh -V 双流/退出码往返（全平台真跑）", async () => {
        const r = await __testFileRedirect(["-V"], "");
        expect(r.stderr).toMatch(/OpenSSH|OpenSSH_for_Windows/i); // 修前（win）：exit 1 双流空
        expect(r.exitCode).not.toBe(1); // -V 退出 0（GNU）或 0——只要不是启动失败
    }, 15_000);

    test("#4 预先取消：AbortError+outcome=unknown；准备期取消不跑 ssh", async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(__testFileRedirect(["-V"], "", { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError", outcome: "unknown" });
    }, 10_000);
});

// GPT Sol 八十期：P1-1 Windows 中转 %VAR% 展开改写参数字面量（ssh -G -i 对比
// 实测）；P2-5 取消只杀外层 shell、ssh 替身照跑。直 spawn 文件 fd 两症同根同治
//（无 shell=无展开、kill 直达 ssh 本体）。
describe("Sol 80：中转直 spawn", () => {
    test.skipIf(!Bun.which("ssh"))("P1-1 %FX80% 字面量经中转原样保留（ssh -G 实测）", async () => {
        const literal = "%FX80_LITERAL% file";
        const dir = mkdtempSync(join(tmpdir(), "fx-ssh-literal-"));
        const path = join(dir, literal);
        const original = process.env.FX80_LITERAL;
        try {
            // OpenSSH 只在身份文件存在时保留 -i 的参数。
            writeFileSync(path, "fixture");
            process.env.FX80_LITERAL = "expanded-by-shell";
            const r = await __testFileRedirect(["-G", "-i", path, "localhost"], "");
            expect(r.exitCode).toBe(0);
            expect(r.stdout).toContain(literal);
        } finally {
            if (original === undefined) delete process.env.FX80_LITERAL;
            else process.env.FX80_LITERAL = original;
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 八十一期：P2-5 spawn 同步抛错（argv 含 NUL）泄漏中转文件与描述符。
describe("Sol 81：中转 spawn 清场", () => {
    test("P2-5 argv 含 NUL：spawn 拒启即清场（.in/.out/.err 不留盘）", async () => {
        const os = await import("node:os");
        const before = (await import("node:fs")).readdirSync(os.tmpdir()).filter((f) => f.includes("fx-ssh-io"));
        const NUL = String.fromCharCode(0);
        await expect(__testFileRedirect(["-V", "bad" + NUL + "arg"], "x")).rejects.toThrow(); // 含 NUL 由 Node 拒
        const after = (await import("node:fs")).readdirSync(os.tmpdir()).filter((f) => f.includes("fx-ssh-io"));
        expect(after.length).toBe(before.length); // 修前：+3（.in/.out/.err 滞留）
    }, 15_000);
});

// GPT Sol 八十五期 P2：上轮 spawnErr 补丁因 python 断言失败未落盘（重复 bug
// 根因）——本轮重落。本地拒启（ENOENT）直报。
describe("Sol 85：中转本地拒启直报", () => {
    test("ssh 不存在形态：直报本地启动失败（非「无哨兵」）", async () => {
        // argv 含 NUL——spawn 同步抛（Node 拒启），非异步 error 事件
        const NUL = String.fromCharCode(0);
        await expect(__testFileRedirect(["-V", "bad" + NUL], "x")).rejects.toThrow(/bad|NUL|null/i);
    }, 15_000);
});

// GPT Sol 八十七期 P1-4：PTY attach 的 spawn ssh ENOENT 曾是 unhandled error
// 事件——崩宿主（调用方 try/catch 收不到）。归 readyRejecter。
describe("Sol 87：attach spawn error", () => {
    test.skipIf(!Bun.which("ssh"))("PATH 置空真 ENOENT：握手拒绝带 code，不崩宿主", async () => {
        const { __testPtyLink } = await import("../src/ssh-pty-driver.js");
        const Link = __testPtyLink as unknown as new () => { attach(args: string[]): void; handshake(w: string): Promise<void> };
        // 真实 ENOENT：env.PATH 置空让 spawn("ssh") 拒启——error 事件异步到达
        //（node:fs/promises 不可 monkey-patch 同理——用环境真实故障，不做 stub）
        const link = new Link();
        const savedPath = process.env.PATH;
        process.env.PATH = "";
        try {
            link.attach(["-G"]);
            await expect(link.handshake("probe")).rejects.toMatchObject({ name: "Error" }); // 修前：uncaught 崩宿主
        } finally {
            process.env.PATH = savedPath;
        }
    }, 15_000);
});

// GPT Sol 八十八期：P1-7 PTY 链 stdin 写入 EPIPE 无监听=uncaughtException 崩
// 宿主（execChannel 早有同款防护，PTY 链漏挂）；P1-8 预触发 AbortSignal 不再
// 派发事件——发送前须显式核验（命令曾照发+exitCode:0 谎报）；P1-9 PTY exec
// 静默丢弃 cwd；P1-10 销毁后排程中的重连到期曾照样新建链拉起 ssh 进程。
describe("Sol 88：stdin EPIPE/预触发 abort/PTY cwd/销毁后重连", () => {
    test.skipIf(!Bun.which("ssh"))("P1-7 stdin 断裂写 EPIPE：归链失败语义，不崩宿主", async () => {
        const { __testPtyLink } = await import("../src/ssh-pty-driver.js");
        const Link = __testPtyLink as unknown as new () => { attach(a: string[]): void; send(s: string): void; handshake(w: string): Promise<void> };
        // 真实 EPIPE：ssh -V 立即退出（读端关闭）→ 对已死管道 write
        const link = new Link();
        link.attach(["-V"]);
        await new Promise((r) => setTimeout(r, 1_200)); // 等进程退出
        link.send("anything\n"); // 修前：stdin Socket 无 error 监听——EPIPE 崩宿主
        await new Promise((r) => setTimeout(r, 500)); // 错误事件异步到达
        // Sol 89 P1-6 语义：stdin error 监听**主要保护 Node 宿主**（SDK dist 也
        // 跑在 node 下——EPIPE 事件曾崩宿主）；Bun 双平台实测不向 stdin Socket
        // 投递 EPIPE（写入静默缓冲/丢弃，真机 Linux 实证 proc 不清空）——Bun 侧
        // 的防御由 markerCycle 发送同步抛路径承担（同 describe 单测）。此处不
        // 断言 proc 状态
        // 活着=通过；且失败已归账——下一次握手拿到明确拒绝（不悬空等待）
        await expect(link.handshake("probe")).rejects.toThrow(/退出|stdin/);
    }, 15_000);

    test("P1-8 预触发 AbortSignal：命令零发送（未执行，可安全重试）", async () => {
        const { __testPtyLink } = await import("../src/ssh-pty-driver.js");
        const Link = __testPtyLink as unknown as new () => { execMarker(c: string, t: number, s?: AbortSignal): Promise<unknown> };
        const link = new Link() as unknown as { ready: boolean; send(s: string): void; execMarker(c: string, t: number, s?: AbortSignal): Promise<unknown> };
        link.ready = true;
        const sent: string[] = [];
        link.send = (s: string) => { sent.push(s); };
        const ac = new AbortController();
        ac.abort(); // 已触发——不再派发 abort 事件
        let e: (Error & { name?: string }) | undefined;
        try { await link.execMarker("touch /tmp/fx88-should-not-exist", 5_000, ac.signal); } catch (err) { e = err as Error & { name?: string }; }
        expect(e?.name).toBe("AbortError");
        expect(sent).toEqual([]); // 修前：命令照发+exitCode:0
    }, 10_000);

    test("P1-9 PTY exec cwd 单次覆盖：子 shell+上下换行包裹；无 cwd 不包裹", async () => {
        const { SshPtyDriver } = await import("../src/ssh-pty-driver.js");
        const drv = new SshPtyDriver({ driver: "ssh", target: "t88" } as never);
        const cmds: string[] = [];
        (drv as unknown as { link: unknown }).link = {
            execMarker: async (c: string) => { cmds.push(c); return { stdout: "", stderr: "", exitCode: 0 }; },
            kill() { /* no-op */ },
        };
        try {
            await drv.exec("printf 'done\\n' # trailing comment", { channel: "pty", cwd: "/opt/x" });
            expect(cmds[0]).toBe("( cd '/opt/x' && {\nprintf 'done\\n' # trailing comment\n} )"); // 修前：cwd 被静默丢弃
            await drv.exec("pwd", { channel: "pty" });
            expect(cmds[1]).toBe("pwd"); // 无 cwd：层内持久状态直跑
        } finally {
            await drv.destroy();
        }
    }, 10_000);

    test("P1-10 销毁后排程中的重连不拉新进程（到期复查+定时器清理）", async () => {
        const { SshPtyDriver } = await import("../src/ssh-pty-driver.js");
        const realDelays = (SshPtyDriver as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS;
        (SshPtyDriver as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS = [80];
        const drv = new SshPtyDriver({ driver: "ssh", target: "t88r" } as never);
        let inits = 0;
        (drv as unknown as { init: () => Promise<void> }).init = async () => { inits++; };
        try {
            (drv as unknown as { scheduleReconnect(): void }).scheduleReconnect();
            await drv.destroy(); // 退避到期前销毁
            await new Promise((r) => setTimeout(r, 400));
            expect(inits).toBe(0); // 修前：80ms 回调照样新建链+init（新 ssh PID 存活）
        } finally {
            (SshPtyDriver as unknown as { RECONNECT_DELAYS_MS: number[] }).RECONNECT_DELAYS_MS = realDelays;
            await drv.destroy();
        }
    }, 15_000);
});

// GPT Sol 八十九期 P1-6/P1-7：markerCycle 发送同步抛（write 对断管道可同步
// EPIPE）曾逃出 Promise executor 被 queue 链吞掉——调用方永不 settle 直到自身
// 超时；cd 落点 CDPATH 防改写（相对路径强制 ./，含斜杠操作数不搜 CDPATH）。
describe("Sol 89：发送同步抛归 caller/cdTargetArg", () => {
    test("P1-6 markerCycle 发送同步抛：caller 收 outcome unknown（不悬空到自身超时）", async () => {
        const { __testPtyLink } = await import("../src/ssh-pty-driver.js");
        const Link = __testPtyLink as unknown as new () => { execMarker(c: string, t: number, s?: AbortSignal): Promise<unknown> };
        const link = new Link() as unknown as { ready: boolean; send(s: string): void; execMarker(c: string, t: number, s?: AbortSignal): Promise<unknown> };
        link.ready = true;
        link.send = () => { throw new Error("write EPIPE (sync)"); };
        let e: (Error & { outcome?: string }) | undefined;
        try { await link.execMarker("touch /tmp/fx89-sync", 5_000); } catch (err) { e = err as Error & { outcome?: string }; }
        expect(e?.outcome).toBe("unknown"); // 修前：异常被 queue 链吞——调用方等到自身超时
        expect(e?.message).toMatch(/发送失败/);
    }, 10_000);

    test("P1-7 cdTargetArg：相对路径强制 ./（CDPATH 不搜含斜杠操作数）", async () => {
        const { cdTargetArg } = await import("../src/ssh-helpers.js");
        expect(cdTargetArg("sub")).toBe("./sub");
        expect(cdTargetArg("a/b")).toBe("./a/b");
        expect(cdTargetArg("/abs/path")).toBe("/abs/path"); // 绝对路径本就不搜 CDPATH——原样
        expect(cdTargetArg("./x")).toBe("./x");
        expect(cdTargetArg("../y")).toBe("../y");
    }, 10_000);
});

// GPT Sol 九十期 P2-3：PTY 子进程自然退出（非 kill、非 EPIPE）曾保持 ready=true
//——执行中 markerCycle 的断链感知（轮询 !ready）不触发，调用方干等到自身超时。
// 退出事件先翻 ready=false 再分发。
describe("Sol 90：PTY 自然退出快速感知", () => {
    test.skipIf(!Bun.which("ssh"))("P2-3 执行中自然退出：调用快速收 unknown（不等自身超时）", async () => {
        const { __testPtyLink } = await import("../src/ssh-pty-driver.js");
        const Link = __testPtyLink as unknown as new () => {
            attach(a: string[]): void;
            execMarker(c: string, t: number, s?: AbortSignal): Promise<unknown>;
            proc?: { emit(ev: string, code: number | null): void };
            ready: boolean;
            send(s: string): void;
        };
        const link = new Link();
        link.attach(["-V"]); // 真实 spawn（管线真实；-V 快退不影响——我们手动发事件）
        (link as unknown as { ready: boolean }).ready = true; // 模拟已建链、执行中
        (link as unknown as { send(s: string): void }).send = () => { /* noop */ };
        const t0 = Date.now();
        // 创建即挂 handler（reject 到 catch 之间若隔 macrotask 轮，bun 记 unhandled）
        const p = link.execMarker("long-running-cmd", 5_000)
            .then(() => { throw new Error("不应 resolve"); }, (err) => err as Error & { outcome?: string });
        await new Promise((r) => setTimeout(r, 150));
        link.proc!.emit("exit", 0); // 自然退出事件（对端关连接/超时同路径）
        const e = await p;
        expect(e?.outcome).toBe("unknown");
        expect(e?.message).toMatch(/断开|断链/);
        expect(Date.now() - t0).toBeLessThan(3_000); // 修前：ready 不翻 false——干等到 5s 超时
    }, 15_000);
});

// ---------------------------------------------------------------------------
// DSH + GLM-5.4 使用评估（2026-11-26）：非交互 BatchMode / 认证诊断 / mux 哈希锚点
// ---------------------------------------------------------------------------
describe("DSH 评估 2026-11-26：ssh 自主化选项与认证诊断", () => {
    /** [-o, 值, -o, 值…] → ["-o 值", …] */
    const pairs = (opts: string[]) => opts.filter((_, i) => i % 2 === 0).map((k, j) => `${k} ${opts[j * 2 + 1]}`);

    test("非交互子进程缺省 BatchMode=yes；PTY 登录链（root attach / hop 登录）不带", async () => {
        const h = await import("../src/ssh-helpers.js");
        // exec 通道 / 观察窗 / 转发 / 文件传输都从这一处取选项——无终端的 ssh 遇到口令提示
        // 应答不了，让它当场失败而不是零输出挂到调用方超时
        expect(pairs(h.autonomousSshOpts())).toContain("-o BatchMode=yes");
        expect(pairs(h.autonomousSshOpts({ hostKeyPolicy: "strict", knownHostsFile: "~/.ssh/kh" }))).toContain("-o BatchMode=yes");
        expect(pairs(h.autonomousSshOpts(undefined, { interactive: true }))).not.toContain("-o BatchMode=yes");
        // PTY 登录链：-tt 强制终端，提示会回显进 PTY——保留交互（不加 BatchMode）
        const root = h.rootSshSpawnArgs(["root@example.invalid"]);
        expect(root[0]).toBe("-tt");
        expect(root.includes("BatchMode=yes")).toBe(false);
        const withJump = { host: "target", conn: { jump: "jump" } };
        expect(h.sshArgsFor(withJump)[1]).toContain("BatchMode=yes");
        expect(h.sshArgsFor(withJump, { interactive: true })[1]).not.toContain("BatchMode");
        const hopCmd = h.hopSshCommand({ host: "example.invalid", conn: { user: "root" } });
        expect(hopCmd.startsWith("ssh ")).toBe(true);
        expect(hopCmd).not.toContain("BatchMode");
    });

    test("mux socket 目录名哈希锚点（参数间以 NUL 分隔——防拼接歧义）", async () => {
        const { muxSocketPath } = await import("../src/ssh-helpers.js");
        const os = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs");
        const d = path.join(os.tmpdir(), "fx-mux-anchor");
        try {
            const tail = (args: string[]) => muxSocketPath(args, d).split(/[\\/]/).pop();
            // v0.2.12 发布版的取值：分隔符当时是字符串字面量里的真 NUL 字节（补丁事故），
            // 现为转义序列——运行时字符串不变，哈希逐项相同
            expect(tail(["root@h", "-i", "k"])).toBe("cm-19f1562a3ad5d1a4");
            expect(tail(["-p", "22", "u@h"])).toBe("cm-9d6035f41ff0fc39");
            expect(tail(["a"])).toBe("cm-ca978112ca1bbdca");
            expect(tail(["ab", "c"])).toBe("cm-6c032e631d39a14d");
            expect(tail(["a", "bc"])).toBe("cm-40bb547d936bbd31"); // 与 ["ab","c"] 不同：NUL 分隔的意义
        } finally {
            fs.rmSync(d, { recursive: true, force: true });
        }
    });

    test.skipIf(!Bun.which("ssh"))("describeSshIdentitySource：本地 ssh -v -G 解析（不连网）给出用户/主机/端口与身份文件在场情况", async () => {
        const { describeSshIdentitySource } = await import("../src/ssh-helpers.js");
        const src = await describeSshIdentitySource("localhost");
        expect(src).not.toBeNull();
        expect(src!.hostname).toBe("localhost");
        expect(src!.port).toMatch(/^\d+$/);
        expect(src!.user.length).toBeGreaterThan(0);
        expect(src!.identityFiles.every((f) => typeof f.path === "string" && typeof f.exists === "boolean")).toBe(true);
        expect(Array.isArray(src!.configFiles)).toBe(true);
        // 探测自身失败返回 null（诊断不得掩盖原始错误）：非法主机名（前导 -）与 ssh 拒绝的参数
        expect(await describeSshIdentitySource("-bad-host")).toBeNull();
    }, 20_000);

    test("formatAuthFailureDiagnosis：跳板角色点明 --key 不传给跳板并给三条出路；无在场身份文件时点破", async () => {
        const { formatAuthFailureDiagnosis } = await import("../src/ssh-helpers.js");
        const mk = (exists: boolean) => ({
            configFiles: ["C:/Users/u/.ssh/config"], user: "root", hostname: "10.0.0.1", port: "22",
            identityFiles: [{ path: "~/.ssh/id_ed25519", exists }, { path: "~/.ssh/id_rsa", exists: false }],
        });
        const jumpNoKey = formatAuthFailureDiagnosis({ role: "jump", label: "root@10.0.0.1", userGiven: true, source: mk(false) });
        expect(jumpNoKey).toContain("[跳板认证失败]");
        expect(jumpNoKey).toContain("跳板 `root@10.0.0.1`");
        expect(jumpNoKey).toContain("--key 只用于目标主机，不会传给跳板");
        expect(jumpNoKey).toContain("实际读取的配置文件：C:/Users/u/.ssh/config");
        expect(jumpNoKey).toContain("解析为：user=root hostname=10.0.0.1 port=22");
        expect(jumpNoKey).not.toContain("未显式指定"); // 给了用户名就不啰嗦
        expect(jumpNoKey).toContain("没有任何在场的身份文件");
        expect(jumpNoKey).toContain("①");
        expect(jumpNoKey).toContain("②");
        expect(jumpNoKey).toContain("③");
        // 目标角色：在场的与缺席的分开列（缺席的折叠计数）；--key 文件不在场要点破
        const target = formatAuthFailureDiagnosis({ role: "target", label: "root@10.0.0.1", userGiven: false, keyFile: "D:/keys/absent", source: mk(true) });
        expect(target).toContain("[目标认证失败]");
        expect(target).toContain("在场的身份文件：~/.ssh/id_ed25519");
        expect(target).toContain("另有 1 个身份文件不存在：~/.ssh/id_rsa");
        expect(target).not.toContain("没有任何在场的身份文件");
        expect(target).toContain("未显式指定");
        expect(target).toContain("--key：D:/keys/absent（文件不存在！）");
        expect(target).not.toContain("出路"); // 出路三条是跳板专属
        // 探测失败：只留不依赖来源的说明，不崩
        const degraded = formatAuthFailureDiagnosis({ role: "jump", label: "j", userGiven: false, source: null });
        expect(degraded).toContain("[跳板认证失败]");
        expect(degraded).not.toContain("实际读取的配置文件");
        expect(degraded).not.toContain("没有任何在场的身份文件"); // 来源未知时不下这个结论
    });

    test.skipIf(!Bun.which("ssh"))("connFailureDiagnosis：按被拒的角色分流；非认证类连接失败保持通用提示", async () => {
        const { __testConnFailureDiagnosis } = await import("../src/ssh-pty-driver.js");
        const { noopLogger } = await import("../src/logger.js");
        const conn = { jump: "root@jump.example.invalid" } as never;
        const jumpDenied = await __testConnFailureDiagnosis("root@target.example.invalid", conn,
            "root@jump.example.invalid: Permission denied (publickey).\n\nConnection closed by UNKNOWN port 65535\n", noopLogger);
        expect(jumpDenied).toContain("[跳板认证失败]");
        expect(jumpDenied).toContain("跳板 `root@jump.example.invalid`");
        // 目标被拒（跳板正常）：目标角色，不误判成跳板
        const targetDenied = await __testConnFailureDiagnosis("root@target.example.invalid", conn,
            "root@target.example.invalid: Permission denied (publickey,password).\n", noopLogger);
        expect(targetDenied).toContain("[目标认证失败]");
        expect(targetDenied).not.toContain("[跳板认证失败]");
        // 不带跳板的解析失败：ssh 的报错可见，保持通用提示（不附认证类诊断）
        const plainUnresolved = await __testConnFailureDiagnosis("root@target.example.invalid", undefined,
            "ssh: Could not resolve hostname target.example.invalid: No such host is known.\n", noopLogger);
        expect(plainUnresolved).toContain("[连接层失败]");
        expect(plainUnresolved).not.toContain("认证失败");
        // 报告原始失败的位置，保留目标的错误行。
        const unresolved = await __testConnFailureDiagnosis("root@target.example.invalid", conn,
            "ssh: Could not resolve hostname target.example.invalid: No such host is known.\n", noopLogger);
        expect(unresolved).toContain("[目标无法解析]");
        expect(unresolved).toContain("Could not resolve hostname target.example.invalid");
        const silent = await __testConnFailureDiagnosis("root@target.example.invalid", conn, "", noopLogger);
        expect(silent).toContain("失败位置无法确认");
        // 与连接层无关的输出：不附诊断
        expect(await __testConnFailureDiagnosis("h", undefined, "some other failure output", noopLogger)).toBe("");
    }, 60_000);
});

// DSH 评估 2026-11-26 #4：exec --no-daemon --pty 稳定 8.1s——结果早已打印，进程却等握手
// 竞速的 8s 定时器到期才退（CLI 不调 process.exit，靠事件循环排空退出）。
describe("DSH 评估 2026-11-26 #4：一次性 PTY 进程不被握手定时器拖住", () => {
    test.skipIf(!Bun.which("ssh"))("握手结束后进程随事件循环排空退出（不留 8s 竞速定时器）", async () => {
        const os = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs");
        const { pathToFileURL } = await import("node:url");
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "fx-oneshot-"));
        const script = path.join(d, "oneshot.ts");
        const modUrl = pathToFileURL(path.join(process.cwd(), "src", "ssh-pty-driver.ts")).href;
        fs.writeFileSync(script, [
            `const { __testPtyLink } = await import(${JSON.stringify(modUrl)});`,
            "const link = new __testPtyLink();",
            "try { await link.attach(['-V']); await link.handshake('oneshot'); } catch { /* ssh -V 即退：握手按预期失败 */ }",
            "console.log('HANDSHAKE_DONE');",
            "// 刻意不调 process.exit：与 CLI 一次性进程一致，靠事件循环排空退出",
            "",
        ].join("\n"));
        try {
            const t0 = Date.now();
            const p = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe", windowsHide: true });
            const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
            const elapsed = Date.now() - t0;
            expect(out).toContain("HANDSHAKE_DONE");
            expect(code).toBe(0);
            // 修前：握手后进程被拖到 attach+8s 才退（真机 8360ms；修后 1187ms）
            expect(elapsed).toBeLessThan(6_000);
        } finally {
            fs.rmSync(d, { recursive: true, force: true });
        }
    }, 30_000);
});

// ---------------------------------------------------------------------------
// DSH 评估 2026-11-26（真机发现）：带跳板时 ssh 把代理进程的 stderr 指向 /dev/null——
// 跳板段的任何失败都是「255 + 零输出」。诊断探测带 -v 重放把报错带回后，按报错行
// 判定失败发生在哪一段。
// ---------------------------------------------------------------------------
describe("DSH 评估 2026-11-26：ssh 报错行归属判定（classifySshFailure）", () => {
    test("跳板被拒：不带主机的重试提示排在前面时，仍归到跳板段", async () => {
        const { classifySshFailure } = await import("../src/ssh-helpers.js");
        // 真机实录（vm-homelab，跳板 nosuchuser@127.0.0.1:3322）：首版只看第一条报错行——
        // 「Permission denied, please try again.」不带主机名，被归给了目标
        const v = classifySshFailure([
            "OpenSSH_10.0p2 Debian-7+deb13u4, OpenSSL 3.5.9 29 Sep 2026",
            "debug1: Offering public key: /root/.ssh/id_ed25519 ED25519 SHA256:…",
            "Permission denied, please try again.",
            "nosuchuser@127.0.0.1: Permission denied (publickey,password).",
            "kex_exchange_identification: Connection closed by remote host",
            "Connection closed by UNKNOWN port 65535",
        ].join("\n"), "127.0.0.1");
        expect(v.stage).toBe("jump");
        expect(v.kind).toBe("auth");
        expect(v.lines).toContain("nosuchuser@127.0.0.1: Permission denied (publickey,password).");
        expect(v.lines[0]).toBe("Permission denied, please try again.");
        expect(v.lines.some((l) => l.startsWith("debug1:"))).toBe(false); // debug 前缀已剥； Offering 之类的进度行不带回
    });

    test("跳板别名解析不出 / 跳板端口不通：归跳板段，类别分别为 resolve / unreachable", async () => {
        const { classifySshFailure } = await import("../src/ssh-helpers.js");
        const unresolved = classifySshFailure(
            "debug1: Reading configuration data /root/.ssh/config\nssh: Could not resolve hostname no-such-alias-xyz: Name or service not known\nkex_exchange_identification: Connection closed by remote host\n",
            "no-such-alias-xyz",
        );
        expect(unresolved.stage).toBe("jump");
        expect(unresolved.kind).toBe("resolve");
        expect(unresolved.lines).toEqual([
            "ssh: Could not resolve hostname no-such-alias-xyz: Name or service not known",
            "kex_exchange_identification: Connection closed by remote host",
        ]);
        const refused = classifySshFailure("ssh: connect to host 127.0.0.1 port 9: Connection refused\r\nConnection closed by UNKNOWN port 65535\r\n", "127.0.0.1");
        expect(refused.stage).toBe("jump");
        expect(refused.kind).toBe("unreachable");
        expect(refused.lines).toHaveLength(2); // CRLF 归一后仍是两行
    });

    test("跳板已连通、目标被拒：归目标段；无跳板时一律目标段", async () => {
        const { classifySshFailure } = await import("../src/ssh-helpers.js");
        const targetDenied = classifySshFailure("nosuchuser@localhost: Permission denied (publickey,password).\n", "127.0.0.1");
        expect(targetDenied.stage).toBe("target");
        expect(targetDenied.kind).toBe("auth");
        // 「Connection closed by remote host」不带具体主机——不点名跳板
        const kex = classifySshFailure("kex_exchange_identification: Connection closed by remote host\n", "jump.example");
        expect(kex.stage).toBe("target");
        expect(kex.kind).toBe("unreachable");
        expect(classifySshFailure("root@h: Permission denied (publickey).\n", null).stage).toBe("target");
        // 跳板与目标同名：第一条点名行即失败点（跳板段先失败）
        expect(classifySshFailure("u@same: Permission denied (publickey).\n", "same").stage).toBe("jump");
    });

    test("没有可判读的报错行：stage=none（连接探测成功时不附误导诊断）；最多带回 8 行", async () => {
        const { classifySshFailure } = await import("../src/ssh-helpers.js");
        const ok = classifySshFailure("debug1: Authentication succeeded (publickey).\ndebug1: channel 0: new session\n", "j");
        expect(ok).toEqual({ stage: "none", kind: null, lines: [] });
        const many = classifySshFailure(Array.from({ length: 20 }, (_, i) => `h${i}: Permission denied (publickey).`).join("\n"), "j");
        expect(many.lines).toHaveLength(8);
        const hostkey = classifySshFailure("root@h: Host key verification failed.\n", "j");
        expect(hostkey.kind).toBe("hostkey");
    });
});
