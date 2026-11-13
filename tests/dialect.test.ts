/**
 * 方言适配层单测（AC-15 探测部分）：GNU/BSD/busybox 三族 mock + 缓存
 * 真机形态用例（OPNsense/Alpine）属集成批次，此处验证判定逻辑。
 */
import { describe, expect, test } from "bun:test";
import { probeDialect, DialectCache, NULL_DIALECT, type ExecFn } from "../src/dialect.js";

/** mock exec：按命令片段表回放（模拟某族系统的行为） */
function mockExec(table: Record<string, { code: number; out: string }>): ExecFn {
    return async (cmd) => {
        for (const [frag, resp] of Object.entries(table)) {
            if (cmd.includes(frag)) return { exitCode: resp.code, stdout: resp.out };
        }
        return { exitCode: 127, stdout: "" }; // command not found
    };
}

// "filaxis" 的 base64 = "ZmlsYXhpcw=="
const B64 = "ZmlsYXhpcw==";

describe("probeDialect（AC-15）", () => {
    test("GNU 族：base64 -w 0 认 + sha256sum 在场", async () => {
        const exec = mockExec({
            "base64 -w 0": { code: 0, out: B64 },
            "base64 -d": { code: 0, out: "filaxis" },
            "sha256sum": { code: 0, out: `${"a".repeat(64)}  -` },
        });
        const d = await probeDialect(exec);
        expect(d.base64Encode).toEqual(["base64", "-w", "0"]);
        expect(d.base64Decode).toEqual(["base64", "-d"]);
        expect(d.sha256).toEqual(["sha256sum"]);
        expect(d.family).toBe("gnu");
    });

    test("BSD 族（OPNsense 形态）：无 -w、解码只认 -D、sha256 -q", async () => {
        const exec = mockExec({
            "base64 -w 0": { code: 1, out: "base64: illegal option -- w" },
            "| base64 -d": { code: 1, out: "" }, // 老 BSD 不认 -d
            "| base64": { code: 0, out: B64 },   // 注意顺序：-d 探测在前命中更精确
            "base64 -D": { code: 0, out: "filaxis" },
            "sha256 -q": { code: 0, out: "b".repeat(64) },
            "sha256sum": { code: 127, out: "" },
        });
        const d = await probeDialect(exec);
        expect(d.base64Encode).toEqual(["base64"]); // 无 -w（默认不折行）
        expect(d.base64Decode).toEqual(["base64", "-D"]);
        expect(d.sha256).toEqual(["sha256", "-q"]);
    });

    test("openssl 兜底族：sha256sum/sha256 均缺席", async () => {
        const exec = mockExec({
            "base64 -w 0": { code: 0, out: B64 },
            "base64 -d": { code: 0, out: "filaxis" },
            "sha256sum": { code: 127, out: "" },
            "sha256 -q": { code: 127, out: "" },
            "openssl dgst -sha256": { code: 0, out: `SHA2-256(stdin)= ${"c".repeat(64)}` },
        });
        const d = await probeDialect(exec);
        expect(d.sha256).toEqual(["openssl", "dgst", "-sha256"]);
    });

    test("极简容器（base64 全缺席）→ NULL 方言显式不可用，不静默错用", async () => {
        const exec = mockExec({ "| base64": { code: 127, out: "" } });
        const d = await probeDialect(exec);
        expect(d.base64Encode).toEqual([]);
        expect(d.base64Decode).toEqual([]);
        expect(d.family).toBe("unknown");
        expect(NULL_DIALECT.family).toBe("unknown");
    });
});

describe("DialectCache", () => {
    test("按连接键缓存（二次不重探）；invalidate 失效", async () => {
        let probes = 0;
        const exec: ExecFn = async (cmd) => {
            probes++;
            if (cmd.includes("base64 -w 0")) return { exitCode: 0, stdout: B64 };
            if (cmd.includes("base64 -d")) return { exitCode: 0, stdout: "filaxis" };
            if (cmd.includes("sha256sum")) return { exitCode: 0, stdout: `${"a".repeat(64)}  -` };
            return { exitCode: 127, stdout: "" };
        };
        const cache = new DialectCache();
        const d1 = await cache.get("conn-a", exec);
        const d2 = await cache.get("conn-a", exec);
        expect(d2).toBe(d1);
        const firstProbeCount = probes;
        await cache.get("conn-a", exec);
        expect(probes).toBe(firstProbeCount); // 命中缓存零重探
        cache.invalidate("conn-a");
        await cache.get("conn-a", exec);
        expect(probes).toBeGreaterThan(firstProbeCount); // 失效后重探
    });
});
