import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/filaxis.ts", import.meta.url));
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "fx-install-"));
    scratch.push(root);
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home);
    mkdirSync(project);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex") };
    const probe = Bun.spawnSync([process.execPath, "-e", 'console.log(require("node:os").homedir())'], { env });
    expect(probe.stdout.toString().trim()).toBe(home);
    function run(...args: string[]) {
        const p = Bun.spawnSync([process.execPath, cli, "install", ...args], { cwd: project, env });
        return { code: p.exitCode, stdout: p.stdout.toString("utf8"), stderr: p.stderr.toString("utf8") };
    }
    return { home, project, run };
}

test("install requires an explicit Agent and only installs to its selected destination", () => {
    const { home, run } = fixture();
    expect(run("--agent", "unknown").code).toBe(1);
    expect(run("--help").code).toBe(0);
    expect(existsSync(join(home, ".agents"))).toBe(false);
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    mkdirSync(join(home, ".claude"));
    const missingAgent = run();
    expect(missingAgent.code).toBe(1);
    expect(missingAgent.stderr).toContain("请用 --agent 指定安装目标");
    expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
    expect(run("--agent", "claude").code).toBe(0);
    expect(existsSync(join(home, ".claude", "skills", "filaxis", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".gemini", "config", "skills"))).toBe(false);
    expect(existsSync(join(home, ".agents"))).toBe(false);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
});

test("project install deduplicates shared paths, makes links portable and preserves local edits", () => {
    const { home, project, run } = fixture();
    const result = run("--agent", "all", "--project");
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(3);
    expect(existsSync(join(home, ".agents"))).toBe(false);
    const target = join(project, ".agents", "skills", "filaxis");
    expect(existsSync(join(project, ".claude", "skills", "filaxis", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".cursor", "skills", "filaxis", "SKILL.md"))).toBe(true);
    const skill = readFileSync(join(target, "SKILL.md"), "utf8");
    expect(skill).toMatch(/^name: filaxis\r?$/m);
    expect(skill).toContain("[AGENTS.md](./AGENTS.md)");
    expect(skill).not.toContain("../../AGENTS.md");
    expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toContain("(./SKILL.md)");
    for (const file of ["longrun-observe.md", "file-sync.md", "cross-host-diagnosis.md", "stream-window.md"]) {
        expect(existsSync(join(target, file))).toBe(true);
    }
    expect(run("--agent=codex", "--project").stdout).toContain("已是当前版本");
    const path = join(target, "file-sync.md");
    const original = readFileSync(path, "utf8");
    const recordPath = join(target, ".filaxis-install.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    const oldReleaseText = "previous packaged text";
    record["file-sync.md"] = createHash("sha256").update(oldReleaseText).digest("hex");
    writeFileSync(path, oldReleaseText);
    writeFileSync(recordPath, JSON.stringify(record));
    expect(run("--agent", "codex", "--project").code).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(original);
    writeFileSync(path, "custom local text");
    const conflict = run("--agent", "codex", "--project");
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("已保留现有文件");
    expect(readFileSync(path, "utf8")).toBe("custom local text");
});

test("install --mcp emits a runnable config snippet and leaves existing config intact", () => {
    const { home, project, run } = fixture();
    const config = join(project, ".mcp.json");
    writeFileSync(config, '{"mcpServers":{"existing":{}}}');
    const json = run("--agent", "claude", "--project", "--mcp");
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ mcpServers: { filaxis: {
        command: process.execPath, args: [join(dirname(cli), "filaxis-mcp.ts")],
    } } });
    expect(json.stderr).toContain(config);
    expect(readFileSync(config, "utf8")).toBe('{"mcpServers":{"existing":{}}}');
    const toml = run("--agent", "codex", "--mcp");
    expect(toml.code).toBe(0);
    expect(toml.stdout).toStartWith("[mcp_servers.filaxis]\n");
    expect(toml.stderr).toContain(join(home, ".codex", "config.toml"));
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
    const legacy = join(home, ".gemini", "antigravity");
    mkdirSync(legacy, { recursive: true });
    const legacyMcp = join(legacy, "mcp_config.json");
    writeFileSync(legacyMcp, "{}");
    const antigravity = run("--agent", "antigravity", "--mcp");
    expect(antigravity.code).toBe(0);
    expect(antigravity.stderr).toContain(legacyMcp);
    expect(readFileSync(legacyMcp, "utf8")).toBe("{}");
});
