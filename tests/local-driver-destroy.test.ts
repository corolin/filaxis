/**
 * local-driver-destroy.test.ts — 本机驱动销毁时收掉自己起的东西（自挖第 2 轮）
 *
 * `destroy()` 此前是空实现（注释写着「此处无强制清理面」）。后果：Daemon 停机时本机层上还在跑的
 * exec 与后台会话没人管，进程要陪它们跑完才退——真机上 20 秒的命令，`daemon stop` 等 5 秒就报
 * 「停机核实超时、终态未知」，旧进程又活 19 秒；长跑会话就是活几小时。SSH 层销毁即断链、在途
 * 命令随之失败，本机层与之对齐：destroy = 中止在途 exec + 停掉还在跑的会话并核实。
 * `dispose()` 不销毁驱动（SDK 日常不受影响），只有宿主退出前的 shutdown 才走到这里。
 */
import { describe, expect, test } from "bun:test";
import { LocalRuntimeDriver } from "../src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => Promise.race([
    p,
    sleep(ms).then(() => {
        throw new Error(`${label}: ${ms}ms 内未结束`);
    }),
]);

describe("本机驱动 destroy() 收掉自己起的、还在跑的东西", () => {
    test("中止在途的 exec：销毁后它以 AbortError 拒绝（结果未知），不再陪命令跑完", async () => {
        const drv = new LocalRuntimeDriver();
        const running = drv.exec("sleep 12", { timeoutMs: 30_000 }).then(
            () => "resolved",
            (e: Error) => e,
        );
        await sleep(500);
        const t0 = Date.now();
        await within(drv.destroy(), 5_000, "destroy()");
        const outcome = await within(running, 5_000, "被中止的 exec");
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).name).toBe("AbortError");
        expect(Date.now() - t0).toBeLessThan(8_000);
    }, 30_000);

    test("停掉还在跑的后台会话：销毁后会话不再处于运行态", async () => {
        const drv = new LocalRuntimeDriver();
        const h = await drv.execSession("sleep 12", { name: "destroy-probe" });
        await sleep(800);
        expect(drv.sessions.verify(h.sessionId).status).toBe("running");
        const t0 = Date.now();
        await within(drv.destroy(), 12_000, "destroy()");
        expect(drv.sessions.verify(h.sessionId).status).not.toBe("running");
        expect(Date.now() - t0).toBeLessThan(15_000);
    }, 40_000);

    test("销毁是幂等的；没有在途工作时立即返回", async () => {
        const drv = new LocalRuntimeDriver();
        await drv.destroy();
        await within(drv.destroy(), 1_000, "第二次 destroy()");
    }, 10_000);
});
