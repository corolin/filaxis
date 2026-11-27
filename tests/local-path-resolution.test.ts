/**
 * local-path-resolution.test.ts — 本机层上的路径按内核语义解析（GPT 审查 #1）
 *
 * 界面层要把本机层上的相对路径补成绝对路径再交给中层（REQ-0004 §5.5）。POSIX 上内核是逐段
 * 解析的：`link/../x` 里的 `..` 相对的是符号链接实际指向的位置，和 shell 看到的一致。
 * `path.resolve` 做的是词法折叠，会把 `work/link/../x` 变成 `work/x`——另一个文件，且不报错。
 * 0.2.13 把相对路径原样交给本机驱动（拼接、不折叠），两种模式都是内核语义；0.3.0 的 CLI
 * 先折叠了，是回归。
 *
 * 只在有 POSIX 路径语义的平台上跑（Windows 的路径解析本身就是词法的，`..` 不跨符号链接）。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "bin", "filaxis.ts");

function run(args: string[], cwd: string): { code: number; out: string; err: string } {
    const p = Bun.spawnSync([process.execPath, cli, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        // 不读也不写用户目录里的层表
        env: { ...process.env, FILAXIS_LAYERS: join(cwd, ".no-such-layers.json") },
    });
    return { code: p.exitCode, out: p.stdout.toString("utf-8"), err: p.stderr.toString("utf-8") };
}

describe("本机层上的相对路径：符号链接后面的 .. 按内核语义解析", () => {
    test.skipIf(process.platform === "win32")("cat / edit link/../marker.txt 落在 shell 看到的那个文件上", () => {
        // <root>/work 是调用方的工作目录，<root>/work/link -> ../target。
        // work/link/../marker.txt 内核解析为 <root>/marker.txt；词法折叠会变成 <root>/work/marker.txt
        const root = mkdtempSync(join(tmpdir(), "fx-path-resolution-"));
        const work = join(root, "work");
        try {
            mkdirSync(join(root, "target"));
            mkdirSync(work);
            symlinkSync("../target", join(work, "link"));
            writeFileSync(join(root, "marker.txt"), "kernel\n");
            writeFileSync(join(work, "marker.txt"), "lexical\n");

            const cat = run(["cat", "--no-daemon", "link/../marker.txt"], work);
            expect(cat.err).toBe("");
            expect(cat.out).toBe("kernel\n");

            const edit = run(["edit", "--no-daemon", "link/../marker.txt", "kernel", "kernel-edited"], work);
            expect(edit.err).toBe("");
            expect(edit.code).toBe(0);
            expect(readFileSync(join(root, "marker.txt"), "utf-8")).toBe("kernel-edited\n");
            expect(readFileSync(join(work, "marker.txt"), "utf-8")).toBe("lexical\n");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60_000);
});
