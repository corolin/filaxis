/**
 * daemon-start-race.test.ts — 多个 `filaxis daemon start` 同时冷启动（自挖第 4 轮）
 *
 * 真机现象：5 个进程同时 `daemon start`，最终只有一个 Daemon（结果正确），但输的 4 个报
 * 「Daemon 进程提前退出 (code=1)」、退出码 1——像是 Daemon 崩了，其实是别的启动器赢了。顺序启动时同样
 * 情况报的是「已在运行 (pid=…)」。Agent 照「提前退出」去排查会白费工夫。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "bin", "filaxis.ts");

describe("多个 filaxis daemon start 同时冷启动", () => {
    test("只有一个成功，其余都被告知「已在运行」——不报成「提前退出」", async () => {
        const root = mkdtempSync(join(tmpdir(), "fx-daemon-start-race-"));
        const daemonDir = join(root, "daemon");
        const env = { ...process.env, FILAXIS_DAEMON_DIR: daemonDir, FILAXIS_LAYERS: join(root, "layers.json") };
        try {
            const starters = Array.from({ length: 5 }, () => Bun.spawn([process.execPath, cli, "daemon", "start"], {
                cwd: root, stdout: "pipe", stderr: "pipe", env, windowsHide: true,
            }));
            const results = await Promise.all(starters.map(async (p) => {
                const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
                return { code, out, err };
            }));
            const winners = results.filter((r) => r.code === 0);
            expect(winners.length).toBe(1);
            expect(winners[0]!.out).toContain("已启动");
            const losers = results.filter((r) => r.code !== 0);
            expect(losers.length).toBe(4);
            for (const loser of losers) {
                expect(loser.code).toBe(1);
                expect(loser.err, loser.err).toContain("已在运行");
                expect(loser.err).not.toContain("提前退出");
            }
        } finally {
            Bun.spawnSync([process.execPath, cli, "daemon", "stop"], { cwd: root, env, stdout: "ignore", stderr: "ignore", windowsHide: true });
            rmSync(root, { recursive: true, force: true });
        }
    }, 60_000);
});
