/**
 * daemon-caller-gone.test.ts — 调用方断开后，经 Daemon 在途的命令被中止（自挖第 5 轮）
 *
 * 真机现象：`filaxis exec`（缺省经 Daemon）跑一条 8 秒的命令，2.5 秒时把 CLI 进程杀掉（Ctrl-C 即如此），
 * 命令照跑到 8 秒并写了收尾标记，而经 Daemon 是缺省路径——用户按 Ctrl-C 当然以为停了。
 *
 * 机制：Daemon 给每个 /rpc 请求配一个中止器，调用方的连接在应答之前断开就触发；信号经中层
 * （runCommand / runBatch / observe）交给这一步所选的驱动，驱动收割命令的整棵进程树
 * （见 local-exec-abort-tree.test.ts）。应答发完之后的断开不触发。
 *
 * 请求体必须「读而不完结」：请求流一完结，bun 1.3.12（Linux 实测）就不再把连接的关闭送到 socket 上
 * （Node 与 Windows 上的 bun 1.4.4 没有这个问题）——本文件在 bun 1.3.12 上过了才算这条机制真的成立。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonServer } from "../src/index.js";
import { PROTOCOL_VERSION } from "../src/middle/protocol.js";

const cli = join(import.meta.dir, "..", "bin", "filaxis.ts");

describe("调用方断开 → 在途操作中止", () => {
    test("原始 HTTP 调用方在应答前断开：Daemon 里的命令随即被中止", async () => {
        const root = mkdtempSync(join(tmpdir(), "fx-caller-gone-"));
        const srv = new DaemonServer({ daemonDir: join(root, "daemon"), version: "test" });
        const marker = join(root, "finished");
        let req: http.ClientRequest | undefined;
        try {
            const url = new URL(await srv.start());
            const body = JSON.stringify({
                protocol: PROTOCOL_VERSION,
                op: "runCommand",
                params: { layer: { descriptor: { driver: "local" } }, cwd: root, command: `echo started > started; sleep 3; echo done > finished`, timeoutMs: 30_000 },
            });
            req = http.request({
                protocol: url.protocol, hostname: url.hostname, port: url.port, path: "/rpc", method: "POST", agent: false,
                headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), Authorization: `Bearer ${srv.token}` },
            });
            req.on("error", () => undefined); // the connection is torn down on purpose
            req.end(body);
            const startDeadline = Date.now() + 20_000;
            while (!existsSync(join(root, "started"))) {
                if (Date.now() > startDeadline) throw new Error("命令没有在 20 秒内启动");
                await Bun.sleep(100);
            }
            req.destroy(); // the caller is gone (Ctrl-C, killed, network dropped)
            await Bun.sleep(4200); // the command would have written "finished" at 3 s
            expect(existsSync(marker)).toBe(false);
        } finally {
            req?.destroy();
            await srv.stop().catch(() => undefined);
            rmSync(root, { recursive: true, force: true });
        }
    }, 40_000);

    test("filaxis exec 经 Daemon 时 CLI 被中断：命令不活过 CLI", async () => {
        const root = mkdtempSync(join(tmpdir(), "fx-caller-gone-cli-"));
        const env = { ...process.env, FILAXIS_DAEMON_DIR: join(root, "daemon"), FILAXIS_LAYERS: join(root, "layers.json") };
        let caller: ReturnType<typeof Bun.spawn> | undefined;
        try {
            Bun.spawnSync([process.execPath, cli, "daemon", "start"], { cwd: root, env, stdout: "pipe", stderr: "pipe", windowsHide: true });
            let ready = false;
            for (let i = 0; i < 80 && !ready; i++) {
                ready = Bun.spawnSync([process.execPath, cli, "daemon", "status"], { cwd: root, env, stdout: "ignore", stderr: "ignore", windowsHide: true }).exitCode === 0;
                if (!ready) Bun.sleepSync(250);
            }
            expect(ready).toBe(true);
            caller = Bun.spawn([process.execPath, cli, "exec", "--json", "--", `echo started > started; sleep 4; echo done > finished`], {
                cwd: root, stdout: "pipe", stderr: "pipe", env, windowsHide: true,
            });
            const startDeadline = Date.now() + 20_000;
            while (!existsSync(join(root, "started"))) {
                if (Date.now() > startDeadline) throw new Error("命令没有在 20 秒内启动");
                await Bun.sleep(100);
            }
            caller.kill(); // Ctrl-C / termination of the CLI process
            await Bun.sleep(5200); // the command would have written "finished" at 4 s
            expect(existsSync(join(root, "finished"))).toBe(false);
        } finally {
            try { caller?.kill(); } catch { /* 已退出 */ }
            Bun.spawnSync([process.execPath, cli, "daemon", "stop"], { cwd: root, env, stdout: "ignore", stderr: "ignore", windowsHide: true });
            rmSync(root, { recursive: true, force: true });
        }
    }, 90_000);
});
