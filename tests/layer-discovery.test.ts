/** 异步探测助手测试：mock driver 的 exec 返回探测输出——两段式/蒸馏/stale */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLayer } from "../src/layer-discovery.js";
import { LayerEnvStore, type LayerEnvironmentSpec } from "../src/layer-env.js";
import type { RuntimeDriver, RuntimeDescriptor, ExecOptions, ExecResult } from "../src/driver.js";

function mockDriver(out1: string, out2: string | Error): RuntimeDriver {
    return {
        descriptor: { driver: "ssh", target: "192.0.2.10" },
        exec: async (cmd: string): Promise<ExecResult> => {
            if (cmd.includes("fx_kernel_arch")) return { stdout: out1, stderr: "", exitCode: 0 };
            if (cmd.includes("fx_pkg_torch")) {
                if (out2 instanceof Error) throw out2;
                return { stdout: out2, stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
        },
    } as unknown as RuntimeDriver;
}

describe("discoverLayer", () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-disc-"));
    const o1 = [
        "fx_os=Ubuntu 24.04.1 LTS",
        "fx_kernel_arch=Linux x86_64",
        "fx_python=Python 3.12.3",
        "fx_gpu=NVIDIA P100, 16384 MiB",
    ].join("\n");
    const o2 = "fx_pkg_torch=2.4.0\nfx_pkg_numpy=1.26.4";

    test("两段式 → 蒸馏 → 落盘（stale 防漂移）", async () => {
        const store = new LayerEnvStore(join(dir, "l.json"));
        const drv = mockDriver(o1, o2);
        const r = await discoverLayer(drv, { store });
        expect(r.key).toBe("ssh:192.0.2.10"); // layerEnvKey 非 pty 形态=driver:target
        expect(r.spec.os).toBe("Ubuntu 24.04.1 LTS");
        expect(r.spec.gpu).toEqual({ model: "NVIDIA P100", vram_mb: 16384 });
        expect(r.spec.packages).toEqual(["torch@2.4.0", "numpy@1.26.4"]);
        expect(r.stale).toBe(false);
        // 同规格重探——stale: false；漂移——stale: true 不覆盖
        expect((await discoverLayer(mockDriver(o1, o2), { store })).stale).toBe(false);
        const o1b = o1.replace("Ubuntu 24.04.1 LTS", "Ubuntu 26.04 LTS");
        expect((await discoverLayer(mockDriver(o1b, o2), { store })).stale).toBe(true);
        rmSync(dir, { recursive: true, force: true });
    });

    test("stage2 失败 → probeNote 如实标注（不假装完整）", async () => {
        const drv = mockDriver(o1, new Error("timeout"));
        const r = await discoverLayer(drv, {});
        expect(r.spec.python).toBe("Python 3.12.3"); // stage1 已蒸馏
        expect(r.spec.packages).toBeUndefined(); // stage2 失败包缺席
        expect(r.probeNote).toContain("stage2 失败");
    });

    test("skipStage2 快路径", async () => {
        const r = await discoverLayer(mockDriver(o1, new Error("never")), { skipStage2: true });
        expect(r.probeNote).toBe("stage2 skipped");
        expect(r.entry).toBeTruthy(); // 无 store 时 entry 直接返回
    });
});
