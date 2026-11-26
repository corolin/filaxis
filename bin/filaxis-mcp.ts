#!/usr/bin/env node
/**
 * bin/filaxis-mcp.ts — 牵丝 MCP Server 启动器（REQ-0003 FEAT-01）
 *
 * stdio JSON-RPC 2.0（MCP 协议子集）。层绑定经启动参数（与 filaxis exec
 * 的 --host 族同语义）：缺省 local；--host user@host 走 ssh 层。
 *
 * 接入示例（Claude Code / Gemini CLI / 任意 MCP 客户端）：
 *   filaxis-mcp                                    # local 层
 *   filaxis-mcp --host root@192.0.2.10 --port 2222  # ssh 层
 *   filaxis-mcp --enter "ssh remote-vm" --host user@bastion  # 多跳
 *   filaxis-mcp --layer web-01                                 # 已存层（filaxis layer save）
 *   # 不论用哪种方式绑定，run_command 的 layer 参数与 run_batch 的层通配都认已存层
 */
import { McpServer } from "../src/mcp-server.js";
import { McpStdioProxy } from "../src/mcp-proxy.js";
import { probeDaemon } from "../src/daemon-client.js";
import { RuntimeStack } from "../src/runtime-stack.js";
import { createAgentToolkit } from "../src/agent-toolkit.js";
import type { RuntimeDescriptor } from "../src/driver.js";
import { noopLogger } from "../src/logger.js";
import { loadLayerStore } from "../src/layer-store.js";

// argv 解析（零依赖手写——与 bin/filaxis.ts 同哲学；子集：--host/--port/--user/
// --key/-J/--enter/--hop/--layer/--docker/--no-daemon/--daemon-dir）
const argv = process.argv.slice(2);
const o: {
    host?: string; port?: number; user?: string; key?: string; jump?: string;
    hop: string[]; enter: string[]; layer?: string; docker?: string;
    noDaemon?: boolean; daemonDir?: string;
} = { hop: [], enter: [] };
function optionValue(index: number): string {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
        console.error(`filaxis-mcp: ${argv[index]} 需要参数值`);
        process.exit(2);
    }
    return value;
}

for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
        case "--host": {
            const v = argv[++i];
            if (!v || v.startsWith("-")) { console.error("filaxis-mcp: --host 需要目标（user@host）——缺值曾静默落本机"); process.exit(2); }
            o.host = v;
            break;
        }
        case "--port": {
            const raw = argv[++i];
            const p = raw === undefined ? NaN : Number(raw);
            if (!raw || !/^\d+$/.test(raw) || !Number.isInteger(p) || p < 1 || p > 65535) {
                console.error(`filaxis-mcp: --port 需要 1-65535 整数（收到: ${raw ?? "（缺失）"}）`);
                process.exit(2);
            }
            o.port = p;
            break;
        }
        case "--user": o.user = optionValue(i); i++; break;
        case "--key": o.key = optionValue(i); i++; break;
        case "-J": case "--jump": o.jump = optionValue(i); i++; break;
        case "--hop": o.hop.push(optionValue(i)); i++; break;
        case "--enter": o.enter.push(optionValue(i)); i++; break;
        case "--layer": o.layer = optionValue(i); i++; break;
        case "--docker": o.docker = optionValue(i); i++; break;
        case "--no-daemon": o.noDaemon = true; break;
        case "--daemon-dir": {
            const v = argv[++i];
            if (!v || v.startsWith("-")) { console.error("filaxis-mcp: --daemon-dir 需要目录路径"); process.exit(2); }
            o.daemonDir = v;
            break;
        }
        default: console.error(`filaxis-mcp: 未知参数 ${a}（支持 --host/--port/--user/--key/-J/--hop/--enter/--docker/--no-daemon/--daemon-dir）`);
        process.exit(2);
    }
}

async function main(): Promise<void> {
    // 层装配（与 CLI driverFor 同语义的子集）
    // Keep diagnostics separate from MCP JSON-RPC stdout.
    const stderr = (message: string) => console.error(`[mcp] ${message}`);
    const logger = { ...noopLogger, warn: stderr, error: stderr };
    const hasSshPathOpts = Boolean(o.port !== undefined || o.user || o.key || o.jump || o.hop.length || o.enter.length || o.docker);
    // --layer 与 --host 族互斥（快照寻址 = 整个连接参数都在快照里）
    if (o.layer) {
        if (o.host || hasSshPathOpts) throw new Error("filaxis-mcp: --layer 与 --host 族互斥");
        if (!Object.hasOwn(loadLayerStore(), o.layer)) {
            throw new Error(`filaxis-mcp: 层 '${o.layer}' 未保存（filaxis layer list 查看；filaxis layer save ${o.layer} --host ... 创建）`);
        }
    }
    if (!o.host && hasSshPathOpts) {
        throw new Error("SSH 路径参数需要 --host");
    }
    const useDaemonAllowed = !o.noDaemon && process.env.FILAXIS_NO_DAEMON !== "1" && !o.host && !hasSshPathOpts;
    if (useDaemonAllowed) {
        const activeDaemon = await probeDaemon(o.daemonDir);
        if (activeDaemon) {
            new McpStdioProxy({ daemonDir: o.daemonDir, logger }).start();
            return;
        }
    }
    const stack = new RuntimeStack({ logger });
    let opts: Parameters<typeof createAgentToolkit>[1];
    if (o.host) {
        const config: Record<string, unknown> = {};
        const conn: Record<string, unknown> = {};
        if (o.port) conn.port = o.port;
        if (o.user) conn.user = o.user;
        if (o.key) conn.keyFile = o.key;
        if (o.jump) conn.jump = o.jump;
        if (Object.keys(conn).length) config.connParams = conn;
        if (o.hop.length) config.sshHops = o.hop.map((h) => {
            const at = h.lastIndexOf("@");
            return at > 0 ? { host: h.slice(at + 1), conn: { user: h.slice(0, at) } } : h;
        });
        if (o.enter.length) config.enterPipeline = o.enter.map((c) => ({ cmd: c }));
        if (o.docker) config.enterPipeline = [...(config.enterPipeline as unknown[] ?? []), { cmd: `docker exec -i ${o.docker} sh` }];
        const desc: RuntimeDescriptor = { driver: "ssh", target: o.host, ...(Object.keys(config).length ? { config } : {}) };
        opts = { descriptor: desc };
    } else {
        opts = {}; // local 缺省
    }
    // 已存层表注入：run_command 等工具按层名寻址、run_batch 的层通配都认 filaxis layer
    // save 保存的层（与 CLI 一致）。按需读取，进程存活期间新保存的层也认。
    const tk = createAgentToolkit(stack, o.layer ? { descriptor: loadLayerStore()[o.layer]! } : { ...opts, savedLayers: loadLayerStore });
    new McpServer({
        toolkit: tk,
        logger,
    });
}

main().catch((e) => {
    console.error(`filaxis-mcp 启动失败: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
