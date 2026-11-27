/**
 * open-stream-cwd.test.ts — 观察窗的命令工作目录（GPT 审查 #2）
 *
 * `filaxis stream open` 没写目标时在本机层执行。经 Daemon 时 Daemon 的工作目录与调用方无关，
 * 所以工作目录要由调用方显式传进来（REQ-0004 §5.5「本机层的命令工作目录」）。exec、observe、
 * batch 都带了这个参数，openStream 此前没有——0.2.13 靠本机描述符自带 cwd 覆盖所有操作，
 * 0.3.0 改成逐操作传参时漏了它：同一条命令，0.2.13 读到调用方目录的文件，0.3.0 读到 Daemon
 * 目录的同名文件。
 *
 * 同构用例集比的是三个宿主彼此一致；这个缺陷是三个宿主一致地错，所以要单独断言期望值。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, DaemonServer } from "../src/index.js";
import { connectRemoteMiddle } from "../src/interface/daemon/daemon-client.js";
import { createMiddle, type LocalMiddle } from "../src/middle/middle.js";
import type { MiddleOps } from "../src/middle/types.js";

const LOCAL = { descriptor: { driver: "local" } } as const;

describe("openStream 的工作目录", () => {
    test("没写目标时，命令在调用方指定的 cwd 里执行——进程内与经 Daemon 一致", async () => {
        const root = mkdtempSync(join(tmpdir(), "fx-stream-cwd-"));
        const caller = join(root, "caller");
        const elsewhere = join(root, "elsewhere");
        mkdirSync(caller);
        mkdirSync(elsewhere);
        // 两个目录各放一个同名文件：命令落在哪个目录，读到的就是哪个
        writeFileSync(join(caller, "marker.txt"), "CALLER\n");
        writeFileSync(join(elsewhere, "marker.txt"), "ELSEWHERE\n");
        const local: LocalMiddle = createMiddle({ version: "test" });
        const srv = new DaemonServer({ daemonDir: join(root, "daemon"), version: "test" });
        try {
            const addr = await srv.start();
            const remote = await connectRemoteMiddle(new DaemonClient({ addr, token: srv.token }));
            const hosts: Array<[string, MiddleOps]> = [["进程内", local.ops], ["经 Daemon", remote.ops]];
            for (const [label, ops] of hosts) {
                for (const cwd of [caller, elsewhere]) {
                    const want = cwd === caller ? "CALLER" : "ELSEWHERE";
                    const other = want === "CALLER" ? "ELSEWHERE" : "CALLER";
                    // 命令读完后不退出：窗口状态恒为「运行中」，读到的是稳定的一帧
                    const w = await ops.openStream({ layer: LOCAL, command: "cat marker.txt; sleep 20", cwd, waitMs: 4000 });
                    const text = w.frames.map((f) => f.text).join("\n");
                    await ops.closeStream({ windowId: w.windowId });
                    expect(text, `${label}，cwd=${want}`).toContain(want);
                    expect(text, `${label}，cwd=${want}`).not.toContain(other);
                }
            }
        } finally {
            await srv.stop().catch(() => undefined);
            await local.shutdown().catch(() => undefined);
            rmSync(root, { recursive: true, force: true });
        }
    }, 60_000);
});
