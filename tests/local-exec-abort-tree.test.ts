/**
 * local-exec-abort-tree.test.ts — 中止一条本机命令 = 停掉它的整棵进程树（自挖第 5 轮）
 *
 * 命令包在子 shell `( eval … )` 里，子 shell 及其子孙各是一个进程。此前中止只对外层 shell 发
 * SIGTERM：外层死了，子 shell 照跑到结束并写完收尾副作用（Windows 与 Linux 实测一致）。
 * 现在 POSIX 下先冻结再按父子表清点、逐个杀；Windows 用 taskkill /T。
 *
 * 同时钉住另一头：命令与宿主同处前台进程组，终端的 Ctrl-C 连命令一起送。中止能力不能靠把命令
 * detached 出去换——那样 SDK 宿主、进程内 filaxis-mcp 按下 Ctrl-C 后命令就留下来了。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntimeDriver } from "../src/index.js";

const cli = join(import.meta.dir, "..", "bin", "filaxis.ts");
const ROOT = "fx-exec-abort-";

async function waitfor(path: string, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (!existsSync(path)) {
        if (Date.now() > deadline) throw new Error(`等不到 ${path}`);
        await Bun.sleep(100);
    }
}

describe("中止本机命令 → 整棵进程树停", () => {
    // 第二条往下再长两代（子 shell 里的 bash -c 里的 sleep）：清点要沿父子链走到底
    for (const command of ["echo started > started; sleep 3; echo done > finished", "echo started > started; bash -c 'sleep 3; echo done > finished'; echo done >> finished"]) {
        test(`驱动层：signal 中止后命令不再跑到收尾（${command.length > 60 ? "多代子孙" : "两代"}）`, async () => {
            const root = mkdtempSync(join(tmpdir(), ROOT));
            const ac = new AbortController();
            try {
                const driver = new LocalRuntimeDriver({ cwd: root, execDir: join(root, "exec") });
                const running = driver.exec(command, { signal: ac.signal, timeoutMs: 30_000 });
                const outcome = running.then(() => "resolved", (e: Error) => e);
                await waitfor(join(root, "started"), 20_000);
                ac.abort(new Error("调用方已断开"));
                expect(await outcome).toBeInstanceOf(Error);
                await Bun.sleep(4200); // the command would have written "finished" at 3 s
                expect(existsSync(join(root, "finished"))).toBe(false);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        }, 40_000);
    }

    // Windows 不适用：没有信号组可发，对 CLI 的 kill 即强杀
    test.skipIf(process.platform === "win32")("一次性模式：命令与 CLI 同组，终端的 Ctrl-C 连命令一起停", async () => {
        const root = mkdtempSync(join(tmpdir(), ROOT));
        let caller: ReturnType<typeof Bun.spawn> | undefined;
        try {
            // CLI 自成进程组，相当于终端里的一个前台作业；信号发给整组，与终端的做法一致
            caller = Bun.spawn([process.execPath, cli, "exec", "--no-daemon", "--json", "--", "echo started > started; sleep 4; echo done > finished"], {
                cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true, detached: true,
            });
            await waitfor(join(root, "started"), 20_000);
            process.kill(-caller.pid, "SIGINT");
            await Bun.sleep(5200); // the command would have written "finished" at 4 s
            expect(existsSync(join(root, "finished"))).toBe(false);
            expect(caller.exitCode !== null || caller.signalCode !== null).toBe(true); // the CLI itself did not sit out the interruption
        } finally {
            try { caller?.kill(); } catch { /* 已退出 */ }
            rmSync(root, { recursive: true, force: true });
        }
    }, 60_000);
});
