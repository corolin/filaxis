import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/filaxis.ts", import.meta.url));

test("mcp-config emits one selected format without writing to the home or project", () => {
    const root = mkdtempSync(join(tmpdir(), "fx-mcp-config-"));
    try {
        const home = join(root, "home");
        const project = join(root, "project");
        mkdirSync(join(home, ".claude"), { recursive: true });
        mkdirSync(project);
        const config = join(project, ".mcp.json");
        const original = '{"mcpServers":{"existing":{}}}';
        writeFileSync(config, original);
        const env = { ...process.env, HOME: home, USERPROFILE: home };
        const runtime = Bun.spawnSync([process.execPath, "-e", 'console.log(require("node:os").homedir())'], { cwd: project, env });
        expect(runtime.stdout.toString().trim()).toBe(home);
        const server = { command: process.execPath, args: [join(dirname(cli), "filaxis-mcp.ts")] };

        function run(...args: string[]) {
            return Bun.spawnSync([process.execPath, cli, "mcp-config", ...args], { cwd: project, env });
        }

        const json = run();
        expect(json.exitCode).toBe(0);
        expect(json.stderr.toString()).toBe("");
        expect(JSON.parse(json.stdout.toString())).toEqual({ mcpServers: { filaxis: server } });

        const toml = run("--format", "toml");
        expect(toml.exitCode).toBe(0);
        expect(toml.stderr.toString()).toBe("");
        expect(toml.stdout.toString()).toBe(
            `[mcp_servers.filaxis]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`,
        );

        const invalid = run("--format", "yaml");
        expect(invalid.exitCode).toBe(1);
        expect(invalid.stdout.toString()).toBe("");
        expect(invalid.stderr.toString()).toContain("filaxis mcp-config [--format json|toml]");

        // Bun can create its own directory when starting the TypeScript CLI.
        expect(readdirSync(home).filter((name) => name !== ".bun")).toEqual([".claude"]);
        expect(readdirSync(join(home, ".claude"))).toEqual([]);
        expect(readdirSync(project)).toEqual([".mcp.json"]);
        expect(readFileSync(config, "utf8")).toBe(original);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
