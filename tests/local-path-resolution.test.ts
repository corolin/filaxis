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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("调用方机器上的路径：符号链接后面的 .. 按内核语义解析", () => {
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

    test.skipIf(process.platform === "win32")("put / get 的本机侧、批次的 commandFile 与落盘输出：选中的同样是 shell 看到的那个文件", () => {
        // 同一个规则覆盖所有「调用方机器上的路径」。0.2.13 的一次性模式下这些都是原样往下传
        // （内核语义）；经 Daemon 的分支才做词法折叠。0.3.0 合并两条路径时合到了折叠的那边：
        // 上传了另一份文件、执行了另一份脚本，且都退出 0
        const root = mkdtempSync(join(tmpdir(), "fx-path-resolution-"));
        const work = join(root, "work");
        try {
            mkdirSync(join(root, "target"));
            mkdirSync(work);
            mkdirSync(join(root, "dest"));
            symlinkSync("../target", join(work, "link")); // link/.. = <root>；词法折叠会落到 <root>/work
            writeFileSync(join(root, "payload.txt"), "kernel-payload\n");
            writeFileSync(join(work, "payload.txt"), "lexical-payload\n");
            writeFileSync(join(root, "script.sh"), "echo kernel-script\n");
            writeFileSync(join(work, "script.sh"), "echo lexical-script\n");

            // put：本机侧文件
            const put = run(["put", "--no-daemon", "link/../payload.txt", join(root, "dest", "uploaded.txt")], work);
            expect(put.err).toBe("");
            expect(readFileSync(join(root, "dest", "uploaded.txt"), "utf-8")).toBe("kernel-payload\n");

            // get：本机侧落点。目标目录 link/../newdir = <root>/newdir（存在）；词法折叠后的
            // <root>/work/newdir 不存在——下载内核若把临时文件拼到那边，目标目录在也报 ENOENT
            mkdirSync(join(root, "newdir"));
            const get = run(["get", "--no-daemon", join(root, "payload.txt"), "link/../newdir/downloaded.txt"], work);
            expect(get.err).toBe("");
            expect(readFileSync(join(root, "newdir", "downloaded.txt"), "utf-8")).toBe("kernel-payload\n");
            expect(existsSync(join(work, "newdir"))).toBe(false);

            // batch：exec 步骤的 commandFile（经 --out-dir 落盘后读回，看跑的是哪份脚本）
            const plan = join(root, "plan.json");
            writeFileSync(plan, JSON.stringify({ steps: [{ id: "s", kind: "exec", commandFile: "link/../script.sh" }] }));
            const batch = run(["batch", "--no-daemon", "--request-file", plan, "--out-dir", join(root, "batchout")], work);
            expect(batch.err).toBe("");
            expect(readFileSync(join(root, "batchout", "s.stdout"), "utf-8")).toBe("kernel-script\n");

            // exec --out 与 batch --out-dir：落盘位置（--out 模式把退出码与落盘路径打到 stderr，是正常输出）
            const spilled = run(["exec", "--no-daemon", "--out", "link/../out.txt", "--", "echo spilled"], work);
            expect(spilled.code).toBe(0);
            expect(readFileSync(join(root, "out.txt"), "utf-8")).toBe("spilled\n");
            const plan2 = join(root, "plan2.json");
            writeFileSync(plan2, JSON.stringify({ steps: [{ id: "step", kind: "exec", command: "echo batch-spilled" }] }));
            const spilledBatch = run(["batch", "--no-daemon", "--request-file", plan2, "--out-dir", "link/../spilled"], work);
            expect(spilledBatch.code).toBe(0);
            expect(readFileSync(join(root, "spilled", "step.stdout"), "utf-8")).toBe("batch-spilled\n");
            expect(existsSync(join(work, "spilled"))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60_000);

    test.skipIf(process.platform === "win32")("含反斜杠的长文件名（POSIX 上反斜杠是普通字符）：下载落在那个文件上", () => {
        // 文件名 = a + \ + 240 个 b，共 242 字节；临时名 = 文件名 + 后缀，超过 255 字节要截断。
        // 截断必须按整个文件名算——把反斜杠当成分隔符的话，「a\」被划进目录部分，剩下的部分截到
        // 255 字节再拼回去就是 257 字节，ENAMETOOLONG
        const root = mkdtempSync(join(tmpdir(), "fx-path-resolution-"));
        const work = join(root, "work");
        const name = `a\\${"b".repeat(240)}`;
        try {
            mkdirSync(work);
            writeFileSync(join(root, "source.txt"), "backslash-name\n");
            expect(Buffer.byteLength(name)).toBe(242);
            const get = run(["get", "--no-daemon", join(root, "source.txt"), join(work, name)], work);
            expect(get.err).toBe("");
            expect(existsSync(join(work, name))).toBe(true);
            expect(readFileSync(join(work, name), "utf-8")).toBe("backslash-name\n");
            expect(readdirSync(work)).toEqual([name]); // 没有留下截断错的临时文件
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60_000);

    test("已存本机层（带相对 cwd、或不带 cwd）：经 Daemon 时也以调用方目录为基准——同一个层上 exec、cat、batch 读到同一个文件", () => {
        // 层表里本机层的 cwd 可以是相对路径（"project"），也可以不写。一次性模式下基准都是调用方；
        // 经 Daemon 时描述符此前原样交给中层——相对的变成相对于 Daemon 自己的目录，不写的直接用
        // Daemon 的进程目录——而 cat 的路径基准按调用方解析：同一个层上 exec 与 cat 读到不同文件
        // （两版都退出 0）。Daemon 在 a 目录启动，客户端在 b 目录运行
        const root = mkdtempSync(join(tmpdir(), "fx-layer-cwd-"));
        const daemonHome = join(root, "a");
        const caller = join(root, "b");
        const daemonDir = join(root, "daemon");
        const store = join(root, "layers.json");
        const env = { ...process.env, FILAXIS_LAYERS: store, FILAXIS_DAEMON_DIR: daemonDir };
        const spawnCli = (args: string[], cwd: string) => {
            const p = Bun.spawnSync([process.execPath, cli, ...args], { cwd, stdout: "pipe", stderr: "pipe", env });
            return { code: p.exitCode, out: p.stdout.toString("utf-8"), err: p.stderr.toString("utf-8") };
        };
        const layers: Array<[name: string, descriptor: Record<string, unknown>, dir: string]> = [
            ["proj", { driver: "local", cwd: "project" }, "project"],
            ["plain", { driver: "local" }, ""],
        ];
        try {
            for (const d of [daemonHome, caller]) mkdirSync(join(d, "project"), { recursive: true });
            for (const [name, , dir] of layers) {
                writeFileSync(join(daemonHome, dir, "marker.txt"), `daemon-${name}\n`);
                writeFileSync(join(caller, dir, "marker.txt"), `caller-${name}\n`);
            }
            writeFileSync(store, JSON.stringify(Object.fromEntries(layers.map(([name, descriptor]) => [name, descriptor]))));

            const started = spawnCli(["daemon", "start"], daemonHome);
            expect(started.err).toBe("");
            let ready = false;
            for (let i = 0; i < 80 && !ready; i++) {
                ready = spawnCli(["daemon", "status"], caller).code === 0;
                if (!ready) Bun.sleepSync(250);
            }
            expect(ready).toBe(true);

            for (const [name] of layers) {
                const want = `caller-${name}\n`;
                const exec = spawnCli(["exec", "--layer", name, "--json", "--", "cat marker.txt"], caller);
                expect(exec.err, name).toBe("");
                expect(JSON.parse(exec.out).stdout, name).toBe(want);
                const cat = spawnCli(["cat", "--layer", name, "marker.txt"], caller);
                expect(cat.err, name).toBe("");
                expect(cat.out, name).toBe(want);
                // batch 走的是另一个入口：整张层表随请求带给中层
                const plan = join(root, `plan-${name}.json`);
                writeFileSync(plan, JSON.stringify({ steps: [{ id: "s", kind: "exec", command: "cat marker.txt" }] }));
                const batch = spawnCli(["batch", "--layer", name, "--request-file", plan, "--out-dir", join(root, `out-${name}`)], caller);
                expect(batch.err, name).toBe("");
                expect(readFileSync(join(root, `out-${name}`, "s.stdout"), "utf-8"), name).toBe(want);
            }
        } finally {
            spawnCli(["daemon", "stop"], root);
            rmSync(root, { recursive: true, force: true });
        }
    }, 90_000);
});
