#!/usr/bin/env node
/**
 * bin/filaxis-mcp.ts — 牵丝 MCP Server 启动器（REQ-0003 FEAT-01）
 *
 * stdio JSON-RPC 2.0（MCP 协议子集）。宿主策略（REQ-0004 §6.3）：
 * - 缺省经 Daemon：层、连接、转发、观察窗、会话全机共享——两个 MCP 客户端之间、CLI 与
 *   MCP 之间看到的是同一份现场。没有 Daemon 在跑就启动一个。
 * - 带绑定参数（--host 族 / --enter / --docker / --layer）或 --no-daemon 时在本进程内建
 *   一个即弃的中层：绑定参数描述的是「这个会话的默认层」，常驻 Daemon 是全机共享的，
 *   没法替某一个客户端设默认层。
 *
 * 接入示例（Claude Code / Gemini CLI / 任意 MCP 客户端）：
 *   filaxis-mcp                                    # 经 Daemon（共享现场）
 *   filaxis-mcp --host root@192.0.2.10 --port 2222  # 本进程内，ssh 层为默认层
 *   filaxis-mcp --enter "ssh remote-vm" --host user@bastion  # 多跳
 *   filaxis-mcp --layer web-01                     # 本进程内，已存层为默认层
 *   # 不论怎么启动，工具的 layer 参数与 run_batch 的层通配都认已存层表
 */
import { McpServer } from "../src/interface/mcp/mcp-server.js";
import { McpStdioProxy } from "../src/interface/mcp/mcp-proxy.js";
import { probeDaemon, spawnDaemonBackground, assertDaemonProtocol } from "../src/interface/daemon/daemon-client.js";
import { createAgentToolkit } from "../src/interface/mcp/agent-toolkit.js";
import { createMiddle } from "../src/middle/middle.js";
import { loadLayerStore } from "../src/middle/layer-store.js";
import type { RuntimeDescriptor } from "../src/core/base/driver.js";
import type { FilaxisLogger } from "../src/shared/logger.js";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
        default: console.error(`filaxis-mcp: 未知参数 ${a}（支持 --host/--port/--user/--key/-J/--hop/--enter/--layer/--docker/--no-daemon/--daemon-dir）`);
        process.exit(2);
    }
}

/** 同目录下的 CLI 入口（bun 直跑是 bin/filaxis.ts，发布包是 dist/bin/filaxis.js）——启动 Daemon 用 */
function cliEntryPath(): string {
    const self = fileURLToPath(import.meta.url);
    return join(dirname(self), `filaxis${extname(self)}`);
}

async function main(): Promise<void> {
    // Keep diagnostics separate from MCP JSON-RPC stdout.
    const stderr = (message: string) => console.error(`[mcp] ${message}`);
    const logger: FilaxisLogger = { debug() { /* MCP 的 stdout 是协议通道，不输出调试日志 */ }, info() { /* 同上 */ }, warn: stderr, error: stderr };
    const hasSshPathOpts = Boolean(o.port !== undefined || o.user || o.key || o.jump || o.hop.length || o.enter.length || o.docker);
    let savedDescriptor: RuntimeDescriptor | undefined;
    // --layer 与 --host 族互斥（快照寻址 = 整个连接参数都在快照里）
    if (o.layer) {
        if (o.host || hasSshPathOpts) throw new Error("filaxis-mcp: --layer 与 --host 族互斥");
        savedDescriptor = loadLayerStore()[o.layer];
        if (!savedDescriptor) {
            throw new Error(`filaxis-mcp: 层 '${o.layer}' 未保存（filaxis layer list 查看；filaxis layer save ${o.layer} --host ... 创建）`);
        }
    }
    if (!o.host && hasSshPathOpts) {
        throw new Error("SSH 路径参数需要 --host");
    }

    const bound = Boolean(o.layer || o.host || hasSshPathOpts);
    if (!o.noDaemon && process.env.FILAXIS_NO_DAEMON !== "1" && !bound) {
        // 缺省经 Daemon；没有在跑就启动一个。两个 MCP 客户端同时首启时只有一个拉起成功，
        // 另一个拿到「已在运行」——那就用它。
        let client = await probeDaemon(o.daemonDir);
        if (!client) {
            try {
                await spawnDaemonBackground({ cliEntryPath: cliEntryPath(), daemonDir: o.daemonDir });
            } catch (e) {
                if (!/已在运行/.test(String((e as Error).message))) throw e;
            }
            client = await probeDaemon(o.daemonDir);
            if (!client) throw new Error("filaxis-mcp: Daemon 启动后未能连通（filaxis daemon status 查看）");
        }
        // 线协议不一致的 Daemon 不连（REQ-0004 §6.2）：明确报错，不让请求交给旧代码执行
        await assertDaemonProtocol(client);
        new McpStdioProxy({ daemonDir: o.daemonDir, logger }).start();
        return;
    }

    // 进程内：即弃中层。已存层表注入——工具的 layer 参数与 run_batch 的层通配都认
    // filaxis layer save 保存的层（与 CLI 一致）；按需读取，进程存活期间新保存的层也认。
    let descriptor = savedDescriptor;
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
        descriptor = { driver: "ssh", target: o.host, ...(Object.keys(config).length ? { config } : {}) };
    }
    const middle = createMiddle({ descriptor, savedLayers: loadLayerStore, logger });
    const tk = createAgentToolkit(middle.stack, { middle });
    new McpServer({
        toolkit: tk,
        logger,
    });
    // 进程内形态：客户端断开即退出。McpServer 在 stdin 关闭时只销毁观察窗注册表；SSH 层的
    // PTY 子进程（或还在跑的会话）会撑住事件循环——客户端退出后这个进程连同它的子进程
    // 一直留着，每个客户端会话泄漏一个（0.2.13 即如此）。收尾、等 stdout 排空后退出。
    // 经 Daemon 的缺省形态没有这个问题：代理进程随 stdin 关闭退出，现场留在 Daemon 里。
    process.stdin.once("end", () => {
        void middle.shutdown()
            .catch(() => undefined)
            .then(() => new Promise<void>((resolve) => process.stdout.write("", () => resolve())))
            .then(() => { process.exit(0); });
    });
}

main().catch((e) => {
    console.error(`filaxis-mcp 启动失败: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
