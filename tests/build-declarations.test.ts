/**
 * build-declarations.test.ts — 打包里的「类型声明」一步必须通过（0.3.0 收尾复查踩出）
 *
 * 打包的最后一步是 tsc 生成 .d.ts。它此前不用项目的 tsconfig、参数单独写（非严格模式），
 * 于是和日常的 `bun run typecheck` 是两套判断：0.3.0 重构工具集时有五处把校验前的
 * unknown 值传给了操作的类型化参数，日常检查（严格模式靠控制流收窄）放行，打包却以
 * 失败退出——直到收尾复查时跑了一次完整打包才发现。
 * 现在这一步用 tsconfig.build.json（继承项目配置，只改输出），并由本用例真的跑一遍。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("打包的类型声明一步", () => {
    test("tsconfig.build.json 生成声明零错误，总出口的声明落在包声明的位置", () => {
        const out = mkdtempSync(join(tmpdir(), "fx-dts-"));
        try {
            const r = Bun.spawnSync([
                process.execPath, join(root, "node_modules", "typescript", "bin", "tsc"),
                "-p", "tsconfig.build.json", "--outDir", out,
            ], { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true });
            const output = r.stdout.toString("utf-8") + r.stderr.toString("utf-8");
            expect(output.trim()).toBe("");
            expect(r.exitCode).toBe(0);
            // 包声明的位置 = package.json 的 types 字段
            const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { types?: string };
            const declared = (pkg.types ?? "").replace(/^\.\/dist\//, "");
            expect(existsSync(join(out, declared))).toBe(true);
            expect(readFileSync(join(out, declared), "utf-8")).toContain("createMiddle");
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    }, 120_000);
});
