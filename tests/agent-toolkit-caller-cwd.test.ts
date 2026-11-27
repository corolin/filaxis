/**
 * agent-toolkit-caller-cwd.test.ts — 工具面的调用方基准目录（自挖第 1 轮）
 *
 * MCP 经 Daemon 时工具集在 Daemon 进程里执行，相对路径此前以 Daemon 的目录为基准，而进程内
 * 形态以客户端目录为基准——同一个 `read_path { path: "marker.txt" }`，两种形态读到两个文件，
 * 都报成功。现在界面层的代理把客户端工作目录随会话带来，工具面据此定基准。
 *
 * 这里用进程内 middle 模拟「执行进程目录 ≠ 调用方目录」：测试进程的目录是仓库根，调用方目录
 * 是一个临时目录。经 Daemon 的那一段（代理带目录、Daemon 侧按会话取用）在 mcp-proxy.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentToolkit, LocalRuntimeDriver, RuntimeStack } from "../src/index.js";
import { callerCwd, runWithToolCallContext } from "../src/interface/mcp/call-context.js";
import { createMiddle, type LocalMiddle } from "../src/middle/middle.js";

describe("工具面的调用方基准目录", () => {
    test("目标是没有自己工作目录的本机层时，相对路径与命令目录以调用方目录为基准", async () => {
        const root = mkdtempSync(join(tmpdir(), "fx-caller-cwd-"));
        const caller = join(root, "caller");
        const middle: LocalMiddle = createMiddle({ version: "test" });
        const tk = createAgentToolkit(middle.stack, { middle });
        const call = <T>(fn: () => Promise<T>) => runWithToolCallContext({ cwd: caller }, fn);
        try {
            mkdirSync(caller, { recursive: true });
            mkdirSync(join(caller, "sub"));
            writeFileSync(join(caller, "marker.txt"), "caller\n");
            writeFileSync(join(caller, "sub", "note.txt"), "in-sub\n");
            writeFileSync(join(caller, "script.sh"), "echo ran-in-caller\n");

            // 读：相对路径落在调用方目录
            const read = await call(() => tk.handlers.read_path({ path: "marker.txt" }));
            expect(read.type).toBe("file");
            expect(read.type === "file" ? read.content : "").toBe("caller\n");
            const list = await call(() => tk.handlers.list_directory({ path: "sub" }));
            expect(list.entries.map((e) => e.name)).toEqual(["note.txt"]);

            // 命令的工作目录（Windows 上本机 shell 是 Git Bash，pwd 打印 /tmp/… 形态——比目录名）
            const printsCallerDir = (out: string | undefined) => (out ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").endsWith("/caller");
            const ran = await call(() => tk.handlers.run_command({ command: "pwd" }));
            expect(printsCallerDir(ran.stdout)).toBe(true);

            // 写与编辑：落在调用方目录
            await call(() => tk.handlers.edit_file({ path: "written.txt", content: "new\n" }));
            expect(readFileSync(join(caller, "written.txt"), "utf-8")).toBe("new\n");
            await call(() => tk.handlers.manage_path({ action: "mkdir", path: "made/deeper", parents: true }));
            expect(await call(async () => (await tk.handlers.read_path({ path: "made" })).type)).toBe("directory");

            // 传输：本机侧文件是调用方目录里的那份；落在默认本机层上的那一侧同样
            mkdirSync(join(caller, "out"));
            await call(() => tk.handlers.transfer_file({
                direction: "put", local_path: "marker.txt", remote_path: "out/copied.txt",
            }));
            expect(readFileSync(join(caller, "out", "copied.txt"), "utf-8")).toBe("caller\n");
            await call(() => tk.handlers.transfer_file({
                direction: "get", remote_path: "out/copied.txt", local_path: "fetched.txt",
            }));
            expect(readFileSync(join(caller, "fetched.txt"), "utf-8")).toBe("caller\n");

            // 批次：步骤路径、commandFile 与命令目录
            const batch = await call(() => tk.handlers.run_batch({
                steps: [
                    { id: "read", kind: "read", path: "marker.txt" },
                    { id: "script", kind: "exec", command_file: "script.sh" },
                    { id: "where", kind: "exec", command: "pwd" },
                    { id: "edit", kind: "edit", path: "written.txt", hunks: [{ old: "new", new: "edited" }] },
                    { id: "put", kind: "put", local_path: "marker.txt", remote_path: "out/again.txt" },
                ],
            }));
            expect(batch.status).toBe("ok");
            expect(readFileSync(join(caller, "written.txt"), "utf-8")).toBe("edited\n");
            expect(readFileSync(join(caller, "out", "again.txt"), "utf-8")).toBe("caller\n");
            const byId = Object.fromEntries(batch.steps.map((s) => [s.id, s])) as Record<string, (typeof batch.steps)[number]>;
            expect(byId.read!.stdout ?? byId.read!.error).toContain("caller");
            expect(byId.script!.stdout?.trim()).toBe("ran-in-caller");
            expect(printsCallerDir(byId.where!.stdout)).toBe(true);
        } finally {
            await middle.shutdown().catch(() => undefined);
            rmSync(root, { recursive: true, force: true });
        }
    }, 60_000);

    test("带自己工作目录的本机层不锚定；没带调用方目录时行为不变", async () => {
        const root = mkdtempSync(join(tmpdir(), "fx-caller-cwd-layer-"));
        const caller = join(root, "caller");
        const project = join(root, "project");
        const middle: LocalMiddle = createMiddle({ version: "test" });
        const tk = createAgentToolkit(middle.stack, { middle });
        try {
            mkdirSync(caller);
            mkdirSync(project);
            writeFileSync(join(caller, "marker.txt"), "caller\n");
            writeFileSync(join(project, "marker.txt"), "project\n");
            await middle.stack.addLayer("proj", { driver: "local", cwd: project });
            const rooted = join(project, "marker.txt");

            // 已存本机层用自己的 cwd：相对路径仍是层目录里的那个；给了绝对路径原样
            const viaLayer = await runWithToolCallContext({ cwd: caller }, () => tk.handlers.read_path({ path: "marker.txt", layer: "proj" }));
            expect(viaLayer.type === "file" ? viaLayer.content : "").toBe("project\n");
            const absolute = await runWithToolCallContext({ cwd: caller }, () => tk.handlers.read_path({ path: rooted }));
            expect(absolute.type === "file" ? absolute.content : "").toBe("project\n");

            // 不在工具调用上下文里（SDK 直接调 handlers）：没有调用方目录，一切照旧
            expect(callerCwd()).toBeUndefined();
            const plain = await tk.handlers.read_path({ path: rooted });
            expect(plain.type === "file" ? plain.content : "").toBe("project\n");
        } finally {
            await middle.shutdown().catch(() => undefined);
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    test("批次里的具名本机层：仍由该层的驱动执行，只是命令目录换成调用方的", async () => {
        // 曾在这里绕过所选驱动：为了给命令一个目录，把具名层换成了缺省本机层——登记在具名层上的
        // 驱动（可能是调用方定制过的）就不再执行这一步。目录是「这次执行的参数」，交给所选驱动
        const root = mkdtempSync(join(tmpdir(), "fx-caller-cwd-batch-"));
        const caller = join(root, "caller");
        const stack = new RuntimeStack();
        const executed: Array<{ command: string; cwd: string | undefined }> = [];
        const dev = new LocalRuntimeDriver();
        dev.exec = async (command, opts) => {
            executed.push({ command, cwd: opts?.cwd });
            return { stdout: "dev-driver", stderr: "", exitCode: 0 };
        };
        await stack.addLayer("dev", dev);
        const middle: LocalMiddle = createMiddle({ stack, version: "test" });
        const tk = createAgentToolkit(stack, { middle });
        try {
            mkdirSync(caller);
            const r = await runWithToolCallContext({ cwd: caller }, () => tk.handlers.run_batch({
                layer: "dev",
                steps: [{ id: "s", kind: "exec", command: "echo x" }],
            }));
            expect(r.status).toBe("ok");
            expect(r.steps[0]?.stdout).toBe("dev-driver");
            expect(executed).toEqual([{ command: "echo x", cwd: caller }]);

            // 没带调用方目录（SDK 直接调）：不给目录，驱动用自己的缺省目录
            executed.length = 0;
            await tk.handlers.run_batch({ layer: "dev", steps: [{ id: "s", kind: "exec", command: "echo y" }] });
            expect(executed).toEqual([{ command: "echo y", cwd: undefined }]);
        } finally {
            await middle.shutdown().catch(() => undefined);
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
});
