import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withLocalWriteLock } from "./local-write-lock.js";

const agents = ["antigravity", "claude", "cursor", "codex"] as const;
type Agent = (typeof agents)[number];
const skillFiles = ["SKILL.md", "longrun-observe.md", "file-sync.md", "cross-host-diagnosis.md", "stream-window.md"];
const installRecord = ".filaxis-install.json";

function missing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function readInstalled(path: string): string | undefined {
    try {
        if (!lstatSync(path).isFile()) throw new Error(`安装目标不是普通文件: ${path}`);
        return readFileSync(path, "utf8");
    } catch (error) {
        if (missing(error)) return undefined;
        throw error;
    }
}

function writeInstalled(path: string, data: string): void {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temp, data, { flag: "wx" });
        renameSync(temp, path);
    } finally {
        try { unlinkSync(temp); } catch (error) { if (!missing(error)) throw error; }
    }
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function installAt(target: string, files: Map<string, string>): boolean {
    return withLocalWriteLock(join(dirname(target), ".filaxis-install"), "Filaxis Skill", () => {
        mkdirSync(target, { recursive: true });
        if (!lstatSync(target).isDirectory()) throw new Error(`安装目标不是普通目录: ${target}`);
        const recordPath = join(target, installRecord);
        const oldRecord = readInstalled(recordPath);
        const previous = JSON.parse(oldRecord ?? "{}") as Record<string, string>;
        if (!previous || typeof previous !== "object" || Array.isArray(previous)) throw new Error(`安装记录无效: ${recordPath}`);
        const nextRecord: Record<string, string> = {};
        const updates = new Map<string, string>();
        for (const [name, content] of files) {
            const path = join(target, name);
            const current = readInstalled(path);
            nextRecord[name] = digest(content);
            if (current === content) continue;
            if (current !== undefined && digest(current) !== previous[name]) {
                throw new Error(`已保留现有文件 ${path}。请备份或移走这个文件后重试安装。`);
            }
            updates.set(path, content);
        }
        const record = JSON.stringify(nextRecord, null, 2) + "\n";
        for (const [path, content] of updates) writeInstalled(path, content);
        if (oldRecord !== record) writeInstalled(recordPath, record);
        return updates.size > 0;
    });
}

export function installSkill(argv: string[], cliUrl: string): void {
    const usage = "用法: filaxis install [--agent antigravity|claude|cursor|codex|all] [--project] [--mcp]";
    let selected: string | undefined;
    let project = false;
    let mcp = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === "--help" || arg === "-h") { console.log(usage); return; }
        if (arg === "--project") project = true;
        else if (arg === "--mcp") mcp = true;
        else if (arg === "--agent" || arg.startsWith("--agent=")) {
            selected = arg === "--agent" ? argv[++i] : arg.slice("--agent=".length);
            if (selected !== "all" && !agents.some((agent) => agent === selected)) throw new Error(usage);
        } else throw new Error(`未知安装参数 ${arg}\n${usage}`);
    }

    const home = homedir();
    const cwd = process.cwd();
    const codexHome = process.env.CODEX_HOME || join(home, ".codex");
    const globalConfig = {
        antigravity: join(home, ".gemini", "config"), claude: join(home, ".claude"),
        cursor: join(home, ".cursor"), codex: codexHome,
    };
    const projectConfig = {
        antigravity: join(cwd, ".agents"), claude: join(cwd, ".claude"),
        cursor: join(cwd, ".cursor"), codex: join(cwd, ".codex"),
    };
    const common = join(project ? cwd : home, ".agents", "skills", "filaxis");
    const targets = selected === "all" ? agents : selected ? [selected as Agent] : agents.filter((agent) => {
        const candidates = [globalConfig[agent]];
        if (agent === "antigravity") candidates.push(join(home, ".gemini", "antigravity"), join(home, ".gemini", "antigravity-cli"));
        if (project) candidates.push(projectConfig[agent]);
        return candidates.some((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory());
    });
    const scope = project ? projectConfig : globalConfig;
    const destinations = new Set(targets.map((agent) => agent === "codex" ? common : join(scope[agent], "skills", "filaxis")));
    if (destinations.size === 0 || (!selected && statSync(dirname(common), { throwIfNoEntry: false })?.isDirectory())) {
        destinations.add(common);
    }

    const cli = fileURLToPath(cliUrl);
    const extension = extname(cli);
    const root = resolve(dirname(cli), extension === ".ts" ? ".." : "../..");
    const files = new Map<string, string>();
    try {
        for (const name of skillFiles) files.set(name, readFileSync(join(root, "docs", "skills", name), "utf8"));
        files.set("AGENTS.md", readFileSync(join(root, "AGENTS.md"), "utf8").replaceAll("./docs/skills/SKILL.md", "./SKILL.md"));
    } catch (cause) {
        throw new Error(`Filaxis 安装包缺少 Skill 文件: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    files.set("SKILL.md", files.get("SKILL.md")!
        .replace(/^name: filaxis-runtime(?=\r?$)/m, "name: filaxis")
        .replaceAll("../../AGENTS.md", "./AGENTS.md"));
    const log = mcp ? console.error : console.log;
    for (const destination of destinations) {
        const changed = installAt(destination, files);
        log(`${changed ? "已安装" : "已是当前版本"} ${destination}`);
    }

    if (mcp) {
        let antigravityMcp = join(scope.antigravity, "mcp_config.json");
        const legacyAntigravityMcp = join(home, ".gemini", "antigravity", "mcp_config.json");
        if (!project && !statSync(antigravityMcp, { throwIfNoEntry: false })
            && statSync(legacyAntigravityMcp, { throwIfNoEntry: false })?.isFile()) {
            antigravityMcp = legacyAntigravityMcp;
        }
        const configPaths = {
            antigravity: antigravityMcp,
            claude: project ? join(cwd, ".mcp.json") : join(home, ".claude.json"),
            cursor: join(scope.cursor, "mcp.json"),
            codex: join(scope.codex, "config.toml"),
        };
        const mcpAgents = targets.length ? targets : agents;
        const command = process.execPath;
        const args = [join(dirname(cli), `filaxis-mcp${extension}`)];
        for (const agent of mcpAgents) console.error(`将 ${agent} 的 MCP 配置片段合并到 ${configPaths[agent]}`);
        const json = JSON.stringify({ mcpServers: { filaxis: { command, args } } }, null, 2);
        const toml = `[mcp_servers.filaxis]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`;
        const hasCodex = mcpAgents.includes("codex");
        const hasJson = mcpAgents.some((agent) => agent !== "codex");
        if (hasJson && hasCodex) console.log(`JSON\n${json}\n\nCodex TOML\n${toml}`);
        else console.log(hasCodex ? toml : json);
    }
}
