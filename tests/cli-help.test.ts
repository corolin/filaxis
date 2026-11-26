import { expect, test } from "bun:test";

test.each([
    ["filaxis CLI", ["--help"]],
    ["filaxis CLI", ["-h"]],
    ["filaxis exec", ["exec", "--help"]],
    ["filaxis batch", ["batch", "-h"]],
    ["filaxis batch", ["batch", "--stdin-json", "--help"]],
    ["filaxis batch", ["batch", "--help", "--request-file", "absent-review-plan.json"]],
    ["filaxis layer save", ["layer", "save", "--help"]],
    ["filaxis layer save", ["layer", "save", "my-layer", "--host", "example.invalid", "--help"]],
    ["filaxis put", ["put", "--help"]],
    ["filaxis get", ["get", "--help"]],
    ["filaxis mcp-config", ["mcp-config", "--help"]],
    ["filaxis daemon", ["daemon", "--help"]],
    ["filaxis forward", ["forward", "--help"]],
    ["filaxis stream", ["stream", "--help"]],
])("CLI help includes %s and exits successfully (%j)", (usage, args) => {
    const result = Bun.spawnSync([process.execPath, "bin/filaxis.ts", ...args], { stderr: "pipe", windowsHide: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(usage);
    expect(result.stderr.toString()).toBe("");
});

test.each([
    ["unknown option", ["--hots", "example.invalid"], "batch 不支持 --hots"],
    ["extra positional", ["example.invalid"], "batch 不接受位置参数"],
    ["remote connection options without a host", ["--port", "2200"], "SSH 连接参数需要 --host"],
    ["missing remote option value", ["--key"], "--key 需要参数值"],
    ["unsupported channel", ["--pty"], "batch 不支持 --pty"],
])("CLI batch rejects %s before running the plan", (_case, args, error) => {
    const input = JSON.stringify({ steps: [{ id: "probe", kind: "exec", command: "printf SHOULD_NOT_RUN" }] });
    const result = Bun.spawnSync([process.execPath, "bin/filaxis.ts", "batch", ...args, "--stdin-json"], { stdin: Buffer.from(input), stderr: "pipe", windowsHide: true });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(error);
});

test.each([
    [["daemon", "stop", "unexpected"], "daemon stop 不接受位置参数"],
    [["forward", "remove", "first", "second"], "forward remove 需要且只接受一个 forward_id"],
    [["forward", "list", "unexpected"], "forward list 不接受位置参数"],
    [["stream", "close", "first", "second"], "stream close 需要且只接受一个 window_id"],
    [["stream", "peek", "first", "second"], "stream peek 需要且只接受一个 window_id"],
    [["stream", "list", "unexpected"], "stream list 不接受位置参数"],
])("CLI rejects unused Daemon command arguments (%j)", (args, error) => {
    const result = Bun.spawnSync([process.execPath, "bin/filaxis.ts", ...args], { stderr: "pipe", windowsHide: true });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(error);
});

test.each([
    [["exec", "--no-daemon", "--script-file"], "--script-file 需要参数值"],
    [["exec", "--script-file", "--no-daemon", "--", "printf SHOULD_NOT_RUN"], "--script-file 需要参数值"],
    [["exec", "--stdin-script", "--script-file", "fixture.sh"], "--stdin-script 与 --script-file 二选一"],
    [["exec", "--timeout", "500ms", "--", "printf SHOULD_NOT_RUN"], "--timeout 需要一个正数字"],
    [["exec", "--no-daemon", "--port", "2222", "--", "printf SHOULD_NOT_RUN"], "SSH 连接参数需要 --host"],
    [["exec", "--layer", "fixture", "--key", "identity", "--", "printf SHOULD_NOT_RUN"], "SSH 连接参数需要 --host"],
    [["observe", "--stream", "out", "--", "printf SHOULD_NOT_RUN"], "--stream 仅接受 stdout"],
])("CLI rejects ambiguous execution parameters (%j)", (args, error) => {
    const result = Bun.spawnSync([process.execPath, "bin/filaxis.ts", ...args], { stderr: "pipe", windowsHide: true });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(error);
});

test.each([
    [["--layer"], "--layer 需要参数值"],
    [["--layer", "--no-daemon"], "--layer 需要参数值"],
    [["--host", "fixture.invalid", "--key", "--no-daemon"], "--key 需要参数值"],
])("MCP launcher rejects missing option values before defaulting to a target (%j)", (args, error) => {
    const result = Bun.spawnSync([process.execPath, "bin/filaxis-mcp.ts", ...args], {
        stdin: Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'),
        stderr: "pipe", windowsHide: true,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(error);
});

test("CLI treats --help after -- as command data", () => {
    // --no-daemon：否则会探到机器上正在跑的真实 Daemon 并经它执行
    // 预算 30s：全量并发下 spawnSync(bun CLI) 在 Windows 本机实测会超缺省 5s（轻载 ~1.2s）
    const result = Bun.spawnSync([process.execPath, "bin/filaxis.ts", "exec", "--no-daemon", "--", "printf '%s' --help"], { stderr: "pipe", windowsHide: true, timeout: 30000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("--help");
}, 30000);
