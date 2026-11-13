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
 */
import { McpServer } from "../src/mcp-server.js";
import { RuntimeStack } from "../src/runtime-stack.js";
import { createAgentToolkit } from "../src/agent-toolkit.js";
import type { RuntimeDescriptor } from "../src/driver.js";

// argv 解析（零依赖手写——与 bin/filaxis.ts 同哲学；子集：--host/--port/--user/
// --key/-J/--enter/--hop/--layer/--docker）
const argv = process.argv.slice(2);
const o: {
    host?: string; port?: number; user?: string; key?: string; jump?: string;
    hop: string[]; enter: string[]; layer?: string; docker?: string;
} = { hop: [], enter: [] };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
        case "--host": o.host = argv[++i]; break;
        case "--port": o.port = parseInt(argv[++i]!, 10); break;
        case "--user": o.user = argv[++i]; break;
        case "--key": o.key = argv[++i]; break;
        case "-J": case "--jump": o.jump = argv[++i]; break;
        case "--hop": o.hop.push(argv[++i]!); break;
        case "--enter": o.enter.push(argv[++i]!); break;
        case "--layer": o.layer = argv[++i]; break;
        case "--docker": o.docker = argv[++i]; break;
        default: console.error(`filaxis-mcp: 未知参数 ${a}（支持 --host/--port/--user/--key/-J/--hop/--enter/--docker）`);
        process.exit(2);
    }
}

async function main(): Promise<void> {
    // 层装配（与 CLI driverFor 同语义的子集）
    const stack = new RuntimeStack();
    let opts: Parameters<typeof createAgentToolkit>[1];
    if (o.layer) {
        throw new Error("filaxis-mcp 暂不支持 --layer 快照寻址（FEAT-04 后续）——用 --host/--enter");
    }
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
    const tk = createAgentToolkit(stack, opts);
    new McpServer({
        toolkit: tk,
        serverVersion: "0.1.0",
        // stdout 归 JSON-RPC——任何意外日志走 stderr
        logger: { debug: () => undefined, info: () => undefined, warn: (m: string) => console.error(`[mcp] ${m}`), error: (m: string) => console.error(`[mcp] ${m}`) },
    });
}

main().catch((e) => {
    console.error(`filaxis-mcp 启动失败: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
