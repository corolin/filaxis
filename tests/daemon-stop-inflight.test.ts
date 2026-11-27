/**
 * daemon-stop-inflight.test.ts — 有命令在途时 `filaxis daemon stop` 停得下、报得准（自挖第 2 轮）
 *
 * 真机现象：Daemon 里有条 20 秒的命令在跑时 `daemon stop`，CLI 等 5 秒等不到旧进程退出，报
 * 「停机核实超时：进程仍存活，终态未知（加 --force 可强制终止）」、退出码 1；而 Daemon 早已停止服务
 * （控制文件已清、status 报未运行），只是进程要陪在途命令跑完才退。长跑的后台会话同理，旧进程
 * 会活到会话结束。
 * 两个原因叠在一起：本机驱动 destroy() 是空的（在途 exec 与会话没人收）；前台入口在收尾完成后
 * 靠事件循环排空退出，被弃命令的孤儿子进程握着管道就排不空。
 *
 * 起～真的 Daemon 进程、真的本机命令，量的是用户看到的：stop 的返回与旧进程的消失。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonServer } from "../src/index.js";
import { PROTOCOL_VERSION } from "../src/middle/protocol.js";

const cli = join(import.meta.dir, "..", "bin", "filaxis.ts");

describe("有请求在途时 DaemonServer.stop()", () => {
    test("不等在途请求结束：连接逐个销毁，1 秒内返回（bun 1.3 的 closeAllConnections 不终止在途连接）", async () => {
        // Linux 上 bun 1.3.12 实测：server.close 的回调要等在途请求结束才来，stop() 挂到命令跑完
        const daemonDir = mkdtempSync(join(tmpdir(), "fx-daemon-stop-rpc-"));
        const srv = new DaemonServer({ daemonDir, version: "test" });
        let req: http.ClientRequest | undefined;
        try {
            const url = new URL(await srv.start());
            const body = JSON.stringify({
                protocol: PROTOCOL_VERSION,
                op: "runCommand",
                params: { layer: { descriptor: { driver: "local" } }, command: "sleep 12", timeoutMs: 30_000 },
            });
            req = http.request({
                protocol: url.protocol, hostname: url.hostname, port: url.port, path: "/rpc", method: "POST", agent: false,
                headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), Authorization: `Bearer ${srv.token}` },
            });
            // 连接被销毁时调用方拿到传输错误；不能变成未处理的 error 事件
            req.on("error", () => undefined);
            req.end(body);
            await Bun.sleep(1200);
            const t0 = Date.now();
            await srv.stop();
            expect(Date.now() - t0).toBeLessThan(2_000);
        } finally {
            req?.destroy();
            await srv.stop().catch(() => undefined);
            rmSync(daemonDir, { recursive: true, force: true });
        }
    }, 20_000);
});

function run(args: string[], cwd: string, env: Record<string, string>) {
    const p = Bun.spawnSync([process.execPath, cli, ...args], { cwd, stdout: "pipe", stderr: "pipe", env, windowsHide: true });
    return { code: p.exitCode, out: p.stdout.toString("utf-8"), err: p.stderr.toString("utf-8") };
}

describe("有工作在途时 daemon stop", () => {
    test("一条长命令在跑：stop 报 stopped:true，旧进程随即退出", async () => {
        const root = mkdtempSync(join(tmpdir(), "fx-daemon-stop-inflight-"));
        const daemonDir = join(root, "daemon");
        const env = { ...process.env, FILAXIS_DAEMON_DIR: daemonDir, FILAXIS_LAYERS: join(root, "layers.json") };
        const marker = join(root, "command-started");
        let pid: number | undefined;
        let caller: ReturnType<typeof Bun.spawn> | undefined;
        try {
            const started = run(["daemon", "start"], root, env);
            expect(started.err).toBe("");
            let ready = false;
            for (let i = 0; i < 80 && !ready; i++) {
                ready = run(["daemon", "status"], root, env).code === 0;
                if (!ready) Bun.sleepSync(250);
            }
            expect(ready).toBe(true);
            pid = (JSON.parse(readFileSync(join(daemonDir, "daemon.lock"), "utf-8")) as { pid: number }).pid;

            // 一条 30 秒的本机命令经 Daemon 执行；它先落一个标记，好知道命令确实已经在跑
            caller = Bun.spawn([process.execPath, cli, "exec", "--json", "--", `echo started > ${JSON.stringify(marker)}; sleep 30`], {
                cwd: root, stdout: "pipe", stderr: "pipe", env, windowsHide: true,
            });
            const startDeadline = Date.now() + 40_000;
            while (!existsSync(marker) && Date.now() < startDeadline) await Bun.sleep(100);
            expect(existsSync(marker)).toBe(true);

            const t0 = Date.now();
            const stop = run(["daemon", "stop", "--json"], root, env);
            const elapsed = Date.now() - t0;
            expect(stop.err).toBe("");
            expect(stop.code, stop.out).toBe(0);
            expect(JSON.parse(stop.out)).toMatchObject({ stopped: true, pid });

            expect(elapsed).toBeLessThan(10_000);
            const exitDeadline = Date.now() + 5_000;
            while (Date.now() < exitDeadline && isAlive(pid!)) await Bun.sleep(100);
            expect(isAlive(pid!)).toBe(false);
        } finally {
            try { caller?.kill(); } catch { /* 已退出 */ }
            run(["daemon", "stop"], root, env);
            rmSync(root, { recursive: true, force: true });
        }
    }, 120_000);
});

function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}
