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
])("CLI help includes %s and exits successfully (%j)", (usage, args) => {
    const result = Bun.spawnSync([process.execPath, "bin/filaxis.ts", ...args], { stderr: "pipe" });
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
    const result = Bun.spawnSync([process.execPath, "bin/filaxis.ts", "batch", ...args, "--stdin-json"], { stdin: Buffer.from(input), stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(error);
});

test("CLI treats --help after -- as command data", () => {
    const result = Bun.spawnSync([process.execPath, "bin/filaxis.ts", "exec", "--", "printf '%s' --help"], { stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("--help");
});
