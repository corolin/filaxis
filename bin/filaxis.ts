#!/usr/bin/env node
// 注：shebang 用 node——dist/bin/filaxis.js 经此 bundle 供 npx/纯 Node 消费；
// bun 直跑（bun bin/filaxis.ts / bunx）显式指定解释器，不受 shebang 影响
/**
 * filaxis CLI — 极简宿主形态（第六季盲测摩擦点 ①：SDK 需要 bun -e 手拼几十行 TS——
 *   Agent 先跟宿主 Shell 引号搏斗。CLI 一行替代：filaxis exec|cat|edit|observe）
 *
 * 零依赖手写 argv。远端目标统一 --host（ssh）；缺省 local。
 *
 * edit 免 Shell 通道（第八季盲测实锤：Windows CommandLineToArgvW 剥引号、多行
 * argv 要数缩进空格——Flash 卡 32 轮）：--stdin-json / --request-file 走 JSON
 * 载荷 {old,new,all}，多行/引号/缩进 100% 保真，绕开宿主 Shell 转义。
 *
 * 路径描述对齐内核三件套（第九季盲测：CLI 只有 --host 族，跳板+容器场景 Agent
 * 被迫读 19 轮源码写 6 个 TS 脚本）：connParams（--jump/-J/--forward/--host-key/
 * --known-hosts）+ sshHops 逐跳链（--hop 可重复）+ enterPipeline（--enter 可重复
 * + --docker 糖）。每跳独立密钥等极端拓扑走 SDK descriptor 全量描述。
 */
import {
    RuntimeStack, LocalRuntimeDriver, SshPtyDriver, editFile, discoverLayer, layerDisplayName, runBatch, type BatchPlan, type BatchReport,
    DaemonServer, DaemonClient, probeDaemon, spawnDaemonBackground, parseAddrToUrl, urlRequestHost, urlRequestPort,
    defaultDaemonDir, readDaemonLock, readDaemonConnection, cleanupDaemonFiles, isPidAlive,
    normalizeForwardSpec, type CloseForwardResult, type OpenForwardSpec, type ForwardInfo, type CliTargetSpec,
    forwardInfoToPublic, closeForwardResultToPublic, isForwardActive, expandBatchLayerWildcards,
} from "../src/index.js";
import type { RuntimeDriver, RuntimeDescriptor } from "../src/driver.js";
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { withLocalWriteLock } from "./local-write-lock.js";
import { transferLayerFile } from "../src/layer-file-transfer.js";
import { noopLogger } from "../src/logger.js";
import { layerStorePath, loadLayerStore } from "../src/layer-store.js";
import type { SshConnParams } from "../src/ssh-helpers.js";
import { version as pkgVersion } from "../package.json" with { type: "json" };

const args = process.argv.slice(2);
const cmd = args[0];

/** 同步或异步结果（local tailLines 同步 / RemoteSessionManager 异步） */
type MaybeAsync<T> = T | Promise<T>;

/** 数值参数守卫（Gemini Hydrogen 审查 #8）：末尾孤立的 --port/--timeout/--duration
 *  曾 parseInt(undefined)=NaN 静默传递 */
/** docker 族参数白名单（Hydrogen R4 #5）：值拼进 enterPipeline 命令串——
 *  仅容简单词法（字母数字._/:-），其余拒绝 */
function dockerArg(argv: string[], i: number): string {
    const v = argv[i + 1];
    if (!v || !/^[A-Za-z0-9._:/-]+$/.test(v)) {
        throw new Error(`--docker 族参数仅接受简单词法（字母数字._:/-，无空格/引号/元字符）: ${v ?? "（缺失）"}`);
    }
    return v;
}

function numArg(argv: string[], i: number, opts: { positive?: boolean; nonNegative?: boolean } = {}): number {
    const raw = argv[i + 1];
    const n = raw !== undefined && /^[+-]?\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n) || (opts.positive && n <= 0) || (opts.nonNegative && n < 0)) {
        const desc = opts.positive ? "正" : opts.nonNegative ? "非负" : "";
        throw new Error(`参数 ${argv[i]} 需要一个${desc}数字（收到: ${raw ?? "（缺失）"}）`);
    }
    return n;
}

function strArg(argv: string[], i: number): string {
    const v = argv[i + 1];
    if (!v || /^-(?:-|[A-Za-z])/.test(v)) {
        throw new Error(`参数 ${argv[i]} 需要参数值`);
    }
    return v;
}

const batchValueOptions = new Set([
    "--host", "--user", "--port", "--key", "-J", "--jump", "--hop", "--enter",
    "--docker", "--docker-shell", "--docker-runtime", "--forward", "--host-key", "--known-hosts",
    "--layer", "--request-file", "--daemon-dir", "--max-parallel",
]);
/** batch 模式下的无值开关（其余 `-` 开头的一律拒绝：batch 不接受位置参数） */
const batchFlagOptions = new Set(["--stdin-json", "--no-daemon", "--no-stop-on-fail"]);

function parseOpts(argv: string[], mode: "default" | "strict" | "batch" = "default"): {
    host?: string; user?: string; port?: number; key?: string;
    jump?: string; hop: string[]; enter: string[];
    docker?: string; dockerShell?: string; dockerRuntime?: string;
    forward: string[]; hostKey?: string; knownHosts?: string;
    layer?: string;
    timeout?: number; duration?: number; stream?: string; all?: boolean;
    /** batch 开关（DSH 评估 2026-11-26 #6）：覆盖计划里的 maxParallel / stopOnFail */
    maxParallel?: number; noStopOnFail?: boolean;
    writeMode?: "auto" | "inplace";
    transport?: "exec" | "sftp";
    stdinJson?: boolean; requestFile?: string; pty?: boolean; help?: boolean;
    stdinScript?: boolean; scriptFile?: string; // exec 免 Shell 通道（盲测 #4）
    noDaemon?: boolean; daemonDir?: string; json?: boolean;
    addr?: string; foreground?: boolean; force?: boolean;
    dynLocal: string[]; dynRemote: string[]; dynDynamic: string[];
    id?: string; after?: number; before?: number; limit?: number; wait?: number; name?: string;
    positional: string[];
} {
    const o: ReturnType<typeof parseOpts> = {
        positional: [], hop: [], enter: [], forward: [],
        dynLocal: [], dynRemote: [], dynDynamic: [],
    };
    let noMoreOpts = false; // `--` 后全 positional（Astra 二十五期 #2：业务命令里的 --layer 等字面量曾被吞成选项——错层/丢参数）
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (noMoreOpts) { o.positional.push(a); continue; }
        if (a === "--") { noMoreOpts = true; continue; } // 命令分隔符：终止选项解析
        if (a === "--help" || a === "-h") return { ...o, help: true };
        if (mode === "batch" && a.startsWith("-") && !batchFlagOptions.has(a)) {
            if (!batchValueOptions.has(a)) throw new Error(`batch 不支持 ${a}`);
            const value = argv[i + 1];
            if (!value || value.startsWith("-")) throw new Error(`batch 的 ${a} 需要参数值`);
        }
        switch (a) {
            case "--host": {
                const v = argv[++i];
                if (!v || v.startsWith("-")) throw new Error("--host 需要目标（user@host 形态）");
                o.host = v;
                break;
            }
            case "--user": o.user = strArg(argv, i); i++; break;
            case "--port": o.port = numArg(argv, i); i++; break;
            case "--key": o.key = strArg(argv, i); i++; break;
            case "-J": case "--jump": o.jump = strArg(argv, i); i++; break;
            case "--hop": o.hop.push(strArg(argv, i)); i++; break;
            case "--enter": o.enter.push(strArg(argv, i)); i++; break;
            case "--pty": o.pty = true; break;
            case "--docker": o.docker = dockerArg(argv, i); i++; break;
            case "--docker-shell": o.dockerShell = dockerArg(argv, i); i++; break;
            case "--docker-runtime": o.dockerRuntime = dockerArg(argv, i); i++; break;
            case "--forward": o.forward.push(strArg(argv, i)); i++; break;
            case "--host-key": o.hostKey = strArg(argv, i); i++; break;
            case "--known-hosts": o.knownHosts = strArg(argv, i); i++; break;
            case "--layer": {
                const v = argv[++i];
                if (!v || v.startsWith("-")) throw new Error("--layer 需要层名");
                o.layer = v;
                break;
            }
            case "--timeout": o.timeout = numArg(argv, i, { positive: true }); i++; break; // 正数（Hydrogen R9 #4：0/负数曾静默禁用或立即杀）
            case "--max-parallel": o.maxParallel = numArg(argv, i, { positive: true }); i++; break;
            case "--no-stop-on-fail": o.noStopOnFail = true; break;
            case "--duration": o.duration = numArg(argv, i, { positive: true }); i++; break;
            case "--stream": {
                const stream = strArg(argv, i);
                if (stream !== "stdout" && stream !== "stderr" && stream !== "both") {
                    throw new Error("--stream 仅接受 stdout、stderr 或 both");
                }
                o.stream = stream;
                i++;
                break;
            }
            case "--all": o.all = true; break;
            case "--write-mode": {
                const v = argv[++i];
                if (v !== "auto" && v !== "inplace") throw new Error(`--write-mode 仅接受 auto|inplace（收到: ${v ?? "（缺失）"}）`);
                o.writeMode = v as "auto" | "inplace";
                break;
            }
            case "--transport": {
                const value = argv[++i];
                if (value !== "exec" && value !== "sftp") throw new Error("--transport 仅接受 exec 或 sftp");
                o.transport = value;
                break;
            }
            case "--stdin-json": o.stdinJson = true; break;
            case "--stdin-script": o.stdinScript = true; break; // exec 免 Shell：命令从 stdin 读（盲测 #4）
            case "--script-file": o.scriptFile = strArg(argv, i); i++; break;
            case "--request-file": o.requestFile = strArg(argv, i); i++; break;
            case "--no-daemon": o.noDaemon = true; break;
            case "--daemon-dir": o.daemonDir = strArg(argv, i); i++; break;
            case "--json": o.json = true; break;
            case "--addr": o.addr = strArg(argv, i); i++; break;
            case "--foreground": o.foreground = true; break;
            case "--force": o.force = true; break;
            case "-L": o.dynLocal.push(strArg(argv, i)); i++; break;
            case "-R": o.dynRemote.push(strArg(argv, i)); i++; break;
            case "-D": {
                const next = argv[i + 1];
                if (next === undefined || (next.startsWith("-") && !/^-\d/.test(next))) {
                    o.dynDynamic.push("0");
                } else {
                    o.dynDynamic.push(next);
                    i++;
                }
                break;
            }
            case "--id": o.id = strArg(argv, i); i++; break;
            case "--after": o.after = numArg(argv, i, { nonNegative: true }); i++; break;
            case "--before": o.before = numArg(argv, i, { nonNegative: true }); i++; break;
            case "--limit": o.limit = numArg(argv, i, { positive: true }); i++; break;
            case "--wait": o.wait = numArg(argv, i, { nonNegative: true }); i++; break;
            case "--name": o.name = strArg(argv, i); i++; break;
            default:
                if (mode !== "default" && a.startsWith("-")) throw new Error(`未知参数 ${a}。以 - 开头的路径请放在 -- 之后`);
                o.positional.push(a);
        }
    }
    if (o.stdinScript && o.scriptFile) throw new Error("--stdin-script 与 --script-file 二选一");
    return o;
}

function transferUsage(cmd: "put" | "get"): string {
    const paths = cmd === "put" ? "<local-path> <layer-path>" : "<layer-path> <local-path>";
    const writeMode = cmd === "put" ? " [--write-mode auto|inplace]" : "";
    return `filaxis ${cmd} [--layer NAME | --host HOST] [--transport exec|sftp] [--timeout MS]${writeMode} -- ${paths}`;
}

/** 跳描述解析：user@host[:port]（任一存在→结构化跳；纯 host→纯字符串跳，旧形态逐字节不变） */
function parseHopSpec(spec: string): { host: string; conn?: { user?: string; port?: number } } {
    let rest = spec;
    let user: string | undefined;
    const at = rest.lastIndexOf("@");
    if (at > 0) { user = rest.slice(0, at); rest = rest.slice(at + 1); }
    let port: number | undefined;
    // IPv6 防误拆（Hydrogen R4 #5）：裸 IPv6（2001:db8::8080）多冒号——lastIndexOf
    // 会把末段误拆成端口。与 ssh-helpers 同规：[ipv6]:port 方括号形态才带端口；
    // 无方括号且含 ≥2 冒号=纯 IPv6 字面量整段作 host
    const br = rest.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (br) {
        rest = br[1]!;
        if (br[2]) port = parseInt(br[2]!, 10);
    } else if ((rest.match(/:/g) ?? []).length >= 2) {
        // 纯 IPv6 字面量——不拆端口
    } else {
        const colon = rest.lastIndexOf(":");
        if (colon > 0) {
            const p = parseInt(rest.slice(colon + 1), 10);
            if (Number.isFinite(p) && p > 0 && p < 65536) { port = p; rest = rest.slice(0, colon); }
        }
    }
    return user != null || port != null ? { host: rest, conn: { user, port } } : { host: rest };
}

/** 端口透传解析：L:8080:localhost:80 / R:... / D:1080（bind 走 SDK descriptor） */
function parseForwardSpec(spec: string): { kind: "L" | "R" | "D"; port: number; target?: string } {
    const parts = spec.split(":");
    const kind = (parts[0] ?? "").toUpperCase();
    if (!["L", "R", "D"].includes(kind)) throw new Error(`--forward 格式非法: '${spec}'（应为 L:port:host:port / R:... / D:port）`);
    const port = parseInt(parts[1] ?? "", 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`--forward 端口非法: '${spec}'`);
    const target = kind === "D" ? undefined : parts.slice(2).join(":");
    if (kind !== "D" && !target) throw new Error(`--forward kind=${kind} 需 target（host:port）: '${spec}'`);
    return { kind: kind as "L" | "R" | "D", port, target };
}

/** 路径描述三件套 → ssh descriptor（layer save 与 --host 直连共用） */
function buildSshDescriptor(opts: ReturnType<typeof parseOpts>): RuntimeDescriptor {
    // ① connParams（root 连接参数——对齐内核 SshConnParams 全字段）
    const connParams: Record<string, unknown> = {};
    if (opts.user) connParams.user = opts.user;
    if (opts.port != null) connParams.port = opts.port;
    if (opts.key) connParams.keyFile = opts.key;
    if (opts.jump) connParams.jump = opts.jump; // -J：途径机不占层，ssh 自身代理
    if (opts.forward.length) connParams.forwards = opts.forward.map(parseForwardSpec);
    if (opts.hostKey) {
        if (opts.hostKey !== "tofu" && opts.hostKey !== "strict") {
            throw new Error(`--host-key 取值非法: '${opts.hostKey}'（限 tofu | strict）`);
        }
        connParams.hostKeyPolicy = opts.hostKey;
    }
    if (opts.knownHosts) connParams.knownHostsFile = opts.knownHosts;
    const config: Record<string, unknown> = {};
    if (Object.keys(connParams).length) config.connParams = connParams;
    // ② sshHops 逐跳链（每跳 user@host[:port]，顺序=链序；密钥共享 --key——
    //    每跳独立密钥等极端拓扑走 SDK descriptor）
    if (opts.hop.length) config.sshHops = opts.hop.map(parseHopSpec);
    // ③ enterPipeline 有序进入管线（--docker 糖在前 + --enter 按序追加；label
    //    截取 cmd 前 30 字符=原版 push_enter 默认同款）
    const enterSteps: Array<{ cmd: string; label: string }> = [];
    if (opts.docker) {
        const runtime = opts.dockerRuntime ?? "docker";
        enterSteps.push({
            cmd: `${runtime} exec -i ${opts.docker} ${opts.dockerShell ?? "sh"}`,
            label: `${runtime}:${opts.docker}`,
        });
    }
    for (const e of opts.enter) enterSteps.push({ cmd: e, label: e.slice(0, 30) });
    if (enterSteps.length) config.enterPipeline = enterSteps;
    return { driver: "ssh", target: opts.host!, config };
}

// ── 层快照存储（CLI 跨调用共享——A 方案；FILAXIS_LAYERS 可覆盖路径） ──
// 读取在 src/layer-store.ts（MCP 入口与 Daemon 同源——三路对层名与层通配的解析一致）
function updateLayerStore<T>(update: (store: Record<string, RuntimeDescriptor>) => T): T {
    const path = layerStorePath();
    mkdirSync(dirname(path), { recursive: true });
    return withLocalWriteLock(path, "层快照", () => {
        const store = loadLayerStore();
        const result = update(store);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, JSON.stringify(store, null, 2), { flag: "wx", mode: 0o600 });
            renameSync(temporary, path);
        } finally {
            try { unlinkSync(temporary); } catch { /* rename 后临时路径已消失 */ }
        }
        return result;
    });
}

function handleLayerCmd(sub: string | undefined, rest: ReturnType<typeof parseOpts>): void {
    if (sub === "save") {
        const [name] = rest.positional;
        if (!name || !rest.host) {
            throw new Error("用法: filaxis layer save <name> --host u@h [-J <jump>] [--hop/--enter/--docker/--forward/--host-key/--known-hosts]");
        }
        const desc = buildSshDescriptor(rest);
        const existed = updateLayerStore((store) => {
            const existed = Boolean(store[name]);
            store[name] = desc;
            return existed;
        });
        console.log(`${existed ? "layer 覆盖" : "layer 保存"}: ${name} → ${layerDisplayName(desc)}`);
        console.log(`后续一行直达: filaxis exec --layer ${name} -- "<command>"`);
    } else if (sub === "list") {
        const store = loadLayerStore();
        const names = Object.keys(store);
        if (names.length === 0) {
            console.log("（无已保存层——filaxis layer save <name> --host ... 创建）");
            return;
        }
        for (const [i, name] of names.entries()) {
            console.log(`  ${i}: ${name} → ${layerDisplayName(store[name]!)}`);
        }
    } else if (sub === "rm") {
        const [name] = rest.positional;
        if (!name) throw new Error("用法: filaxis layer rm <name>");
        updateLayerStore((store) => {
            if (!store[name]) throw new Error(`层 '${name}' 未保存（filaxis layer list 查看）`);
            delete store[name];
        });
        console.log(`layer 移除: ${name}`);
    } else {
        throw new Error("用法: filaxis layer save <name> --host ... | list | rm <name>");
    }
}

const sshLogger = { ...noopLogger, warn: (message: string) => console.error(`[filaxis] ${message}`) };

function savedLayerDriver(name: string, layers: Record<string, RuntimeDescriptor> = loadLayerStore()): RuntimeDriver {
    if (!Object.hasOwn(layers, name)) throw new Error(`层 '${name}' 未保存（filaxis layer list 查看；filaxis layer save ${name} --host ... 创建）`);
    const descriptor = layers[name]!;
    // 按 descriptor 的 driver 分派，与 Daemon 路径的 resolveTarget 一致。已存层按约定由
    // `layer save --host` 产生（SSH），但层文件可被手改：这里曾无条件包成 SshPtyDriver
    //——非 SSH 条目（driver:"local"）会变成对空主机名的 ssh 连接（落到 localhost 的 sshd）
    if (descriptor.driver === "ssh") return new SshPtyDriver(descriptor, { logger: sshLogger });
    if (descriptor.driver === "local") {
        const shell = descriptor.config?.shell;
        return new LocalRuntimeDriver({
            cwd: descriptor.cwd,
            shell: typeof shell === "string" ? shell : undefined,
        });
    }
    throw new Error(`层 '${name}' 的 driver '${descriptor.driver}' 在一次性模式（--no-daemon）下不可用——去掉 --no-daemon 经 Daemon 执行`);
}

async function driverFor(opts: ReturnType<typeof parseOpts>, needPtyLink = false): Promise<RuntimeDriver> {
    validateCliTargetOptions(opts);
    // PTY link 按需建（审计 M1）：exec 通道独立 ssh 进程、观察流独立 spawn——都不依赖
    // PTY link，且不 init 能保留 execChannel 的「多跳不可直达」诚实拒绝语义（统一
    // init 会把假跳板名的错误提前成建链失败，改变错误落点）；--pty 走 link.execMarker
    // 必须先建链（修前恒抛「未就绪」）。
    const drv: RuntimeDriver = (() => {
        if (opts.layer) {
            return savedLayerDriver(opts.layer);
        }
        if (opts.host) return new SshPtyDriver(buildSshDescriptor(opts), { logger: sshLogger });
        return new LocalRuntimeDriver();
    })();
    if (needPtyLink && drv instanceof SshPtyDriver) await drv.init();
    return drv;
}

async function destroyDriver(driver: RuntimeDriver): Promise<void> {
    try { await driver.destroy(); }
    catch (error) {
        console.error(`[filaxis] 连接销毁失败: ${error instanceof Error ? error.message : String(error)}`);
        if (!process.exitCode) process.exitCode = 1;
    }
}

/** 读尽管道 stdin（TTY 直接报用法——绝不挂起等输入；process.stdin 双运行时兼容） */
async function readStdinAll(): Promise<string> {
    if (process.stdin.isTTY) {
        throw new Error(
            "--stdin-json 需管道输入（例: Get-Content req.json -Raw | filaxis edit <path> --stdin-json；或改用 --request-file <file>）",
        );
    }
    const chunks: Buffer[] = [];
    for await (const c of process.stdin as unknown as AsyncIterable<Buffer>) chunks.push(c);
    // BOM+CRLF 剥离（第十二季 C 组实测）：PowerShell 管道注入前导 \uFEFF（JSON
    // Parse error: Unrecognized token）与 CRLF（脚本体 \r: not found）——入口统一
    // 剥 BOM；CRLF 由调用侧按需归一（JSON 解析容忍 \r，脚本体在 exec 侧处理）
    let text = Buffer.concat(chunks).toString("utf-8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
}

/** 拆分冒号同时保留方括号内 IPv6（如 [::1]:8080:[::1]:80） */
function splitColonsRespectingBrackets(raw: string): string[] {
    const parts: string[] = [];
    let cur = "";
    let inBracket = false;
    for (const ch of raw) {
        if (ch === "[") {
            inBracket = true;
            cur += ch;
        } else if (ch === "]") {
            inBracket = false;
            cur += ch;
        } else if (ch === ":" && !inBracket) {
            parts.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    if (inBracket) throw new Error(`端口转发规格括号未闭合: ${raw}`);
    parts.push(cur);
    return parts;
}

function parseStrictPort(raw: string, allowZero: boolean, spec: string): number {
    if (allowZero && raw === "") return 0;
    if (!/^\d+$/.test(raw)) throw new Error(`端口必须是数字 (${raw}): ${spec}`);
    const port = Number(raw);
    const min = allowZero ? 0 : 1;
    if (!Number.isInteger(port) || port < min || port > 65535) {
        throw new Error(`端口超出范围 ${min}-65535 (${raw}): ${spec}`);
    }
    return port;
}

function parseDynamicForwardCliSpec(kind: "L" | "R" | "D", raw: string, id?: string, timeoutMs?: number): OpenForwardSpec {
    const parts = splitColonsRespectingBrackets(raw);
    let spec: OpenForwardSpec;
    if (kind === "D") {
        if (parts.length === 1) {
            spec = { kind, bindPort: parseStrictPort(parts[0]!, true, raw) };
        } else if (parts.length === 2) {
            spec = { kind, bindAddr: parts[0]!, bindPort: parseStrictPort(parts[1]!, true, raw) };
        } else {
            throw new Error(`-D 规格格式应为 [bindAddr:]bindPort，收到: ${raw}`);
        }
    } else {
        if (parts.length === 2) {
            spec = {
                kind,
                bindPort: 0,
                targetHost: parts[0]!,
                targetPort: parseStrictPort(parts[1]!, false, raw),
            };
        } else if (parts.length === 3) {
            spec = {
                kind,
                bindPort: parseStrictPort(parts[0]!, true, raw),
                targetHost: parts[1]!,
                targetPort: parseStrictPort(parts[2]!, false, raw),
            };
        } else if (parts.length === 4) {
            spec = {
                kind,
                bindAddr: parts[0]!,
                bindPort: parseStrictPort(parts[1]!, true, raw),
                targetHost: parts[2]!,
                targetPort: parseStrictPort(parts[3]!, false, raw),
            };
        } else {
            throw new Error(`-${kind} 规格格式应为 [[bindAddr:]bindPort:]targetHost:targetPort，收到: ${raw}`);
        }
    }
    if (id !== undefined) spec.id = id;
    if (timeoutMs !== undefined) spec.timeoutMs = timeoutMs;
    normalizeForwardSpec(spec);
    return spec;
}

function validateCliTargetOptions(opts: ReturnType<typeof parseOpts>): void {
    if (opts.layer && opts.host) throw new Error("--layer 与 --host 互斥（层路径已持久化——改路径请 filaxis layer save 覆盖）");
    if (!opts.host && (opts.user !== undefined || opts.port !== undefined || opts.key !== undefined ||
        opts.jump || opts.hop.length || opts.enter.length || opts.docker || opts.dockerRuntime ||
        opts.dockerShell || opts.forward.length || opts.hostKey || opts.knownHosts)) {
        throw new Error("SSH 连接参数需要 --host（已保存层请修改快照）");
    }
}

function resolveDaemonSshPaths(descriptor: RuntimeDescriptor): RuntimeDescriptor {
    if (descriptor?.driver !== "ssh") return descriptor;
    const config = descriptor.config;
    const conn = config?.connParams as SshConnParams | undefined;
    if (!conn || typeof conn !== "object") return descriptor;

    const fromCaller = (file: string | undefined): string | undefined => {
        if (typeof file !== "string" || !file || file === "none" || isAbsolute(file) || /^(?:~|%|\$\{)/.test(file)) return file;
        return resolvePath(file);
    };
    const jump = conn.jump;
    return {
        ...descriptor,
        config: {
            ...config,
            connParams: {
                ...conn,
                keyFile: fromCaller(conn.keyFile),
                knownHostsFile: fromCaller(conn.knownHostsFile),
                ...(jump && typeof jump === "object"
                    ? { jump: { ...jump, keyFile: fromCaller(jump.keyFile) } }
                    : {}),
            },
        },
    };
}

function buildCliTargetSpec(opts: ReturnType<typeof parseOpts>, allowSavedLayerLookup = true): CliTargetSpec {
    validateCliTargetOptions(opts);
    if (opts.layer) {
        if (allowSavedLayerLookup) {
            const layers = loadLayerStore();
            if (Object.hasOwn(layers, opts.layer)) {
                return { layer: opts.layer, descriptor: resolveDaemonSshPaths(layers[opts.layer]!) };
            }
        }
        return { layer: opts.layer };
    }
    if (opts.host) {
        return { descriptor: resolveDaemonSshPaths(buildSshDescriptor(opts)) };
    }
    return { descriptor: { driver: "local" }, cwd: process.cwd() };
}

async function tryDaemon(opts: ReturnType<typeof parseOpts>): Promise<DaemonClient | null> {
    if (opts.noDaemon || process.env.FILAXIS_NO_DAEMON === "1") return null;
    return probeDaemon(opts.daemonDir);
}

async function requireDaemon(opts: ReturnType<typeof parseOpts>): Promise<DaemonClient> {
    if (opts.noDaemon) {
        throw new Error("该命令依赖常驻 Daemon，不支持 --no-daemon");
    }
    const client = await probeDaemon(opts.daemonDir);
    if (!client) {
        throw new Error("未检测到活跃的 Filaxis Daemon，请先运行 filaxis daemon start");
    }
    return client;
}

/**
 * exec 结果输出（DSH 评估 2026-11-26 #5c）：完成标记原先紧跟 stdout 写入就发 stderr。
 * stdout 对管道是异步写入——正文还在排队时标记已到，调用方 `2>&1` 合流后它就落在
 * 正文中间。先等 stdout 排空再写标记（合流后标记恒在末尾）。--json 结构化输出，
 * 调用方不必再从正文里认标记行。
 * 只设 exitCode、不 process.exit（Gemini #8——曾跳过外层 finally 的 drv.destroy()）。
 */
async function printExecResult(r: { stdout: string; stderr: string; exitCode: number; effectiveUser?: string }, json: boolean): Promise<void> {
    if (json) {
        console.log(JSON.stringify({ exitCode: r.exitCode, effectiveUser: r.effectiveUser ?? null, stdout: r.stdout, stderr: r.stderr }));
    } else {
        if (r.stdout) {
            await new Promise<void>((done, reject) => {
                process.stdout.write(r.stdout, (error) => error ? reject(error) : done());
            });
        }
        if (r.stderr) process.stderr.write(r.stderr);
        console.error(`\n[exit=${r.exitCode} user=${r.effectiveUser ?? "?"}]`);
    }
    process.exitCode = r.exitCode;
}

function printBatchReport(r: BatchReport): void {
    for (const s of r.steps) {
        const head = `[${s.status}] ${s.id} (${s.kind}${s.durationMs != null ? ` ${s.durationMs}ms` : ""})${s.layer === undefined ? "" : ` layer=${s.layer}`}`;
        if (s.status === "skipped") {
            console.log(`${head} — ${s.skippedBecause}`);
            continue;
        }
        if (s.kind === "exec") {
            console.log(`${head} exit=${s.exitCode}${s.effectiveUser ? ` user=${s.effectiveUser}` : ""}${s.error ? ` ✗ ${s.error}` : ""}`);
            if (s.stdout) process.stdout.write(s.stdout.endsWith("\n") ? s.stdout : s.stdout + "\n");
            if (s.stderr) process.stderr.write(s.stderr.endsWith("\n") ? s.stderr : s.stderr + "\n");
        } else if (s.kind === "edit" && s.edits) {
            console.log(`${head} ${s.edits.path} 替换 ${s.edits.occurrences} 处，${s.edits.bytesBefore}B → ${s.edits.bytesAfter}B${s.edits.mutex === "degraded" ? "（无锁降级）" : ""}`);
        } else if (s.transfer) {
            const { bytes, transport, verification, writeMode } = s.transfer;
            console.log(`${head} ${bytes} 字节 | transport=${transport} | verification=${verification} | writeMode=${writeMode}`);
        } else {
            console.log(`${head} ${((s.stdout ?? "").length)} 字符`);
        }
        if (s.error && s.kind !== "exec") console.error(`  ✗ ${s.error}`);
    }
    console.log(`batch ${r.status}${r.failedStep ? `（失败于 ${r.failedStep}）` : ""}`);
    process.exitCode = r.status === "ok" ? 0 : 1;
}

function printObserveStopStatus(
    stopStatus: "exited" | "stopped" | "unknown",
    verifyStatus: string | undefined,
    verifyError: string | undefined,
    sessionId: string,
    logBase: string,
): void {
    if (stopStatus !== "unknown") return;
    if (verifyStatus === "unknown" || verifyStatus === "running") process.exitCode = 1;
    if (verifyStatus === "running") {
        console.error(`[filaxis] 停止结果未知且核实显示**任务仍在运行**——会话 ${sessionId} 日志 ${logBase}，勿盲目重试`);
    } else if (verifyStatus === "unknown") {
        console.error(`[filaxis] 停止与核实均为未知（${verifyError ? `核实失败: ${verifyError}` : "通道异常或会话失联"}）——会话 ${sessionId} 日志 ${logBase}，任务可能仍在运行：核实终态后再重试`);
    }
}

async function runCliBatch(o: ReturnType<typeof parseOpts>, daemon: DaemonClient | null): Promise<void> {
    // 批次组合（第十一季）：计划 JSON 经 --request-file / --stdin-json 直达
    //（免 Shell 通道哲学——多行命令/hunk 绝不进 argv）
    if (o.positional.length) throw new Error(`batch 不接受位置参数：${o.positional.join(" ")}`);
    if (o.layer && o.host) throw new Error("--layer 与 --host 互斥");
    if (!o.host && (o.user !== undefined || o.port !== undefined || o.key !== undefined
        || o.jump || o.hop.length || o.enter.length || o.docker || o.dockerRuntime || o.dockerShell
        || o.forward.length || o.hostKey || o.knownHosts)) {
        throw new Error("batch 的 SSH 连接参数需要 --host；已保存层请在快照内配置");
    }
    if (Boolean(o.requestFile) === Boolean(o.stdinJson)) {
        throw new Error("用法: filaxis batch [--layer X | --host ...] (--request-file <plan.json> | --stdin-json)");
    }
    const payload = o.requestFile ? readFileSync(o.requestFile, "utf-8") : await readStdinAll();
    let plan: BatchPlan;
    try {
        plan = JSON.parse(payload) as BatchPlan;
    } catch (e) {
        throw new Error(`batch 计划 JSON 解析失败: ${(e as Error).message}`);
    }
    let saved: Record<string, RuntimeDescriptor> | undefined;
    if (o.layer && plan && typeof plan === "object" && !Array.isArray(plan) && plan.layer === undefined) {
        plan = { ...plan, layer: o.layer };
    }
    // 命令行开关覆盖计划字段（DSH 评估 2026-11-26 #6）：显式写在命令行上的意图优先。
    // --no-stop-on-fail 把缺省的失败即停关掉——巡检要「一台挂了其余照看」；改配置→验证
    // →重载这类链保持缺省（前一步失败不该继续）
    if (plan && typeof plan === "object" && !Array.isArray(plan)) {
        if (o.maxParallel !== undefined) plan = { ...plan, maxParallel: o.maxParallel };
        if (o.noStopOnFail) plan = { ...plan, stopOnFail: false };
        // 层通配（"q-*"）按已存层名展开——只在此入口做：内核的层解析只认具体名。
        // 无匹配即拒绝（把 "q-*" 原样交下去会被当成一个不存在的层名）
        plan = expandBatchLayerWildcards(plan, () => Object.keys(saved ??= loadLayerStore()), "已存层");
    }
    if (daemon) {
        const savedLayers = Object.fromEntries(
            Object.entries(saved ??= loadLayerStore()).map(([name, descriptor]) => [name, resolveDaemonSshPaths(descriptor)]),
        );
        const target = !o.layer ? buildCliTargetSpec(o) : undefined;
        const resolvedPlan: BatchPlan = (plan && typeof plan === "object" && !Array.isArray(plan) && Array.isArray(plan.steps))
            ? {
                ...plan,
                steps: plan.steps.map((step) => {
                    if (step && typeof step === "object" && (step.kind === "put" || step.kind === "get")
                        && typeof step.localPath === "string" && step.localPath.length > 0 && !step.localPath.includes("\0")) {
                        return { ...step, localPath: resolvePath(step.localPath) };
                    }
                    return step;
                }),
            }
            : plan;
        const r = await daemon.rpc<BatchReport>("batch", { target, plan: resolvedPlan, savedLayers, clientCwd: process.cwd() });
        printBatchReport(r);
        return;
    }
    const drivers = new Map<string | undefined, RuntimeDriver>();
    try {
        const r = await runBatch(async (name) => {
            const existing = drivers.get(name);
            if (existing) return existing;
            const driver = name === undefined ? await driverFor(o) : savedLayerDriver(name, saved ??= loadLayerStore());
            drivers.set(name, driver);
            return driver;
        }, plan);
        printBatchReport(r);
    } finally {
        await Promise.all([...drivers.values()].map(destroyDriver));
    }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isPidAlive(pid)) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return !isPidAlive(pid);
}

async function forceStopPid(pid: number, dir: string): Promise<boolean> {
    try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
    if (await waitForPidExit(pid, 2_000)) {
        cleanupDaemonFiles(dir, pid);
        return true;
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    if (await waitForPidExit(pid, 2_000)) {
        cleanupDaemonFiles(dir, pid);
        return true;
    }
    return false;
}

async function handleDaemonCmd(sub: string | undefined, o: ReturnType<typeof parseOpts>): Promise<void> {
    if ((sub === "start" || sub === "status" || sub === "stop") && o.positional.length) {
        throw new Error(`daemon ${sub} 不接受位置参数: ${o.positional.join(" ")}`);
    }
    const dir = o.daemonDir ?? defaultDaemonDir();
    if (sub === "start") {
        let host = "127.0.0.1";
        let port = 0;
        if (o.addr) {
            const url = parseAddrToUrl(o.addr);
            host = urlRequestHost(url);
            port = urlRequestPort(url);
        }
        if (o.foreground) {
            const srv = new DaemonServer({ daemonDir: dir, host, port, version: pkgVersion, logger: sshLogger });
            const addr = await srv.start();
            if (o.json) {
                console.log(JSON.stringify({ running: true, pid: process.pid, addr, daemonDir: dir }));
            } else {
                console.log(`Filaxis Daemon 已启动 (foreground): pid=${process.pid} addr=${addr}`);
            }
            let closing = false;
            const onSignal = () => {
                if (closing) return;
                closing = true;
                void srv.stop();
            };
            process.on("SIGINT", onSignal);
            process.on("SIGTERM", onSignal);
            await srv.waitForStop();
            process.removeListener("SIGINT", onSignal);
            process.removeListener("SIGTERM", onSignal);
            return;
        }
        const cliEntryPath = fileURLToPath(import.meta.url);
        const info = await spawnDaemonBackground({ cliEntryPath, daemonDir: dir, addr: o.addr });
        if (o.json) {
            console.log(JSON.stringify({ running: true, ...info, daemonDir: dir }, null, 2));
        } else {
            console.log(`Filaxis Daemon 已启动: pid=${info.pid} addr=${info.addr} dir=${dir}`);
        }
        return;
    }
    if (sub === "status") {
        const client = await probeDaemon(dir);
        if (!client) {
            if (o.json) console.log(JSON.stringify({ running: false, daemonDir: dir }));
            else console.log(`Filaxis Daemon 未运行 (${dir})`);
            process.exitCode = 1;
            return;
        }
        const info = await client.status();
        if (o.json) {
            console.log(JSON.stringify({ running: true, ...info, daemonDir: dir }, null, 2));
        } else {
            console.log(`Filaxis Daemon 运行中: pid=${info.pid} addr=${info.addr} uptime=${Math.round(info.uptimeMs / 1000)}s`);
            console.log(`  layers=${info.layers.length} forwards=${info.forwards.length} streams=${info.streams.length}`);
        }
        return;
    }
    if (sub === "stop") {
        const client = await probeDaemon(dir);
        if (client) {
            let pid: number | undefined;
            try { pid = (await client.status(1500)).pid; } catch { pid = readDaemonLock(dir)?.pid; }
            await client.shutdown();
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                const stillConn = readDaemonConnection(dir);
                const alive = pid ? isPidAlive(pid) : false;
                if (!stillConn && !alive) break;
                await new Promise((r) => setTimeout(r, 50));
            }
            if (pid && isPidAlive(pid)) {
                if (!o.force) {
                    process.exitCode = 1;
                    if (o.json) console.log(JSON.stringify({ stopped: false, status: "unknown", pid }));
                    else console.error(`[filaxis] Daemon 停机核实超时：进程仍存活 (pid=${pid})，终态未知（加 --force 可强制终止）`);
                    return;
                }
                const killed = await forceStopPid(pid, dir);
                if (!killed) {
                    process.exitCode = 1;
                    if (o.json) console.log(JSON.stringify({ stopped: false, status: "unknown", forced: true, pid }));
                    else console.error(`[filaxis] 强制终止 Daemon 后仍未确认退出 (pid=${pid})，终态未知`);
                    return;
                }
                if (o.json) console.log(JSON.stringify({ stopped: true, forced: true, pid }));
                else console.log(`已强制停止 Filaxis Daemon (pid=${pid})`);
                return;
            }
            if (o.json) console.log(JSON.stringify({ stopped: true, ...(pid ? { pid } : {}) }));
            else console.log(`Filaxis Daemon 已停止${pid ? ` (pid=${pid})` : ""}`);
            return;
        }
        const lock = readDaemonLock(dir);
        if (lock && isPidAlive(lock.pid)) {
            if (!o.force) {
                throw new Error(`Daemon 控制面无响应但进程仍存活 (pid=${lock.pid})——加 --force 强制终止`);
            }
            const killed = await forceStopPid(lock.pid, dir);
            if (!killed) {
                process.exitCode = 1;
                if (o.json) console.log(JSON.stringify({ stopped: false, status: "unknown", forced: true, pid: lock.pid }));
                else console.error(`[filaxis] 强制终止 Daemon 后仍未确认退出 (pid=${lock.pid})，终态未知`);
                return;
            }
            if (o.json) console.log(JSON.stringify({ stopped: true, forced: true, pid: lock.pid }));
            else console.log(`已强制停止 Filaxis Daemon (pid=${lock.pid})`);
            return;
        }
        if (lock) {
            cleanupDaemonFiles(dir);
            if (o.json) console.log(JSON.stringify({ stopped: true, staleCleaned: true }));
            else console.log("未检测到活跃 Daemon（已清理陈旧锁文件）");
            return;
        }
        if (o.json) console.log(JSON.stringify({ stopped: false, running: false }));
        else console.log("Filaxis Daemon 未运行");
        process.exitCode = 1;
        return;
    }
    throw new Error("用法: filaxis daemon start [--addr host:port] [--foreground] [--daemon-dir dir] | status | stop [--force]");
}

async function handleForwardCmd(sub: string | undefined, o: ReturnType<typeof parseOpts>): Promise<void> {
    if (sub === "list" && o.positional.length) throw new Error("forward list 不接受位置参数");
    if ((sub === "remove" || sub === "rm") && (o.positional.length !== 1 || !o.positional[0])) {
        throw new Error("forward remove 需要且只接受一个 forward_id");
    }
    const client = await requireDaemon(o);
    if (sub === "add") {
        if (o.positional.length) {
            throw new Error(`forward add 不接受位置参数: ${o.positional.join(" ")}`);
        }
        const specs: Array<{ kind: "L" | "R" | "D"; raw: string }> = [
            ...o.dynLocal.map((raw) => ({ kind: "L" as const, raw })),
            ...o.dynRemote.map((raw) => ({ kind: "R" as const, raw })),
            ...o.dynDynamic.map((raw) => ({ kind: "D" as const, raw })),
        ];
        if (specs.length !== 1) {
            throw new Error("用法: filaxis forward add (--layer NAME | --host HOST) (-L SPEC | -R SPEC | -D SPEC) [--id ID]");
        }
        const spec = parseDynamicForwardCliSpec(specs[0]!.kind, specs[0]!.raw, o.id, o.timeout);
        const target = buildCliTargetSpec(o);
        const info = await client.rpc<ForwardInfo>("forward.add", { target, spec });
        if (info.status !== "active") {
            if (o.json) console.log(JSON.stringify(forwardInfoToPublic(info), null, 2));
            else console.error(`forward add: id=${info.forwardId} status=${info.status}${info.lastError ? ` (${info.lastError})` : ""}`);
            process.exitCode = 1;
            return;
        }
        if (o.json) {
            console.log(JSON.stringify(forwardInfoToPublic(info), null, 2));
        } else {
            const targetDesc = info.kind === "dynamic" ? "SOCKS5" : `${info.targetHost}:${info.targetPort}`;
            console.log(`forward added: id=${info.forwardId} layer=${info.layer ?? "?"} ${info.kind} ${info.bindAddr}:${info.bindPort} -> ${targetDesc} (${info.transportMode})`);
        }
        return;
    }
    if (sub === "list") {
        // 默认只报仍在用的转发（DSH 评估 2026-11-26 #5a）：remove 之后条目以 stopped
        // 留在表里做幂等判定——曾照样列出，与「无活跃转发」的空表文案自相矛盾。
        // --all 连同已停止/已退出的一并列出（--json 同受 --all 控制）
        const all = o.all === true;
        const res = await client.rpc<{ forwards: ForwardInfo[] }>("forward.list", {
            ...(o.layer ? { layer: o.layer } : {}),
            includeClosed: all,
        });
        // 本地再滤一次：对上不认 includeClosed 的旧 daemon，行为不变
        const shown = all ? res.forwards : res.forwards.filter(isForwardActive);
        if (o.json) {
            console.log(JSON.stringify(shown.map(forwardInfoToPublic), null, 2));
            return;
        }
        if (shown.length === 0) {
            console.log(all ? "（无动态端口转发）" : "（无活跃动态端口转发）");
            return;
        }
        for (const f of shown) {
            const dst = f.kind === "dynamic" ? "SOCKS5" : `${f.targetHost}:${f.targetPort}`;
            console.log(`  ${f.forwardId} | layer=${f.layer ?? "?"} | ${f.kind} ${f.bindAddr}:${f.bindPort} -> ${dst} | ${f.transportMode} | ${f.status}`);
            if (f.lastError) {
                // 最近一次异常的尾行（完整内容在 --json 的 last_error）——穿层转发连接即断时死因在这里
                const lines = f.lastError.trim().split(/\r?\n/);
                console.log(`      ↳ ${lines[0]!.trim()}${lines.length > 1 ? ` …${lines[lines.length - 1]!.trim()}` : ""}`.slice(0, 240));
            }
        }
        return;
    }
    if (sub === "remove" || sub === "rm") {
        const res = await client.rpc<CloseForwardResult>("forward.remove", {
            forwardId: o.positional[0]!,
            ...(o.layer ? { layer: o.layer } : {}),
        });
        if (o.json) {
            console.log(JSON.stringify(closeForwardResultToPublic(res), null, 2));
        } else {
            console.log(`forward remove: id=${res.forwardId} status=${res.status}${res.detail ? ` (${res.detail})` : ""}`);
        }
        if (res.status === "unknown") process.exitCode = 1;
        return;
    }
    throw new Error("用法: filaxis forward add ... | list [--layer NAME] | remove <forward_id>");
}

type StreamRpcResult = {
    window_id: string;
    name?: string;
    layer?: string;
    oldest_seq: number;
    newest_seq: number;
    stale: boolean;
    frames: Array<{ seq: number; ts: number; text: string; stream?: string }>;
    last_delivered_seq?: number;
    gap?: boolean;
    exit_code?: number | null;
    error?: string;
};

function printStreamRpcResult(res: StreamRpcResult): void {
    const header = [
        `window=${res.window_id}`,
        ...(res.layer ? [`layer=${res.layer}`] : []),
        `oldest=${res.oldest_seq}`,
        `newest=${res.newest_seq}`,
        `stale=${res.stale}`,
        ...(res.last_delivered_seq !== undefined ? [`cursor=${res.last_delivered_seq}`] : []),
        ...(res.gap ? ["gap=true"] : []),
        ...(res.exit_code !== undefined ? [`exit=${res.exit_code}`] : []),
    ].join(" | ");
    console.log(header);
    for (const f of res.frames) {
        console.log(`[${f.seq} ${f.stream ?? "output"}] ${f.text}`);
    }
    if (res.error) console.error(`[filaxis] ${res.error}`);
}

async function handleStreamCmd(sub: string | undefined, o: ReturnType<typeof parseOpts>): Promise<void> {
    if (sub === "list" && o.positional.length) throw new Error("stream list 不接受位置参数");
    if ((sub === "peek" || sub === "close") && (o.positional.length !== 1 || !o.positional[0])) {
        throw new Error(`stream ${sub} 需要且只接受一个 window_id`);
    }
    const client = await requireDaemon(o);
    if (sub === "open") {
        let command = o.positional.join(" ");
        const sanitizeScript = (t: string): string =>
            (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t).replace(/\r\n/g, "\n");
        if (o.stdinScript) command = sanitizeScript(await readStdinAll());
        else if (o.scriptFile) command = sanitizeScript(readFileSync(o.scriptFile, "utf-8"));
        if (!command.trim()) throw new Error("用法: filaxis stream open [--layer NAME | --host HOST] [--stream stdout|stderr|both] [--wait MS] [--limit N] -- <command>");
        const target = buildCliTargetSpec(o);
        const res = await client.rpc<StreamRpcResult>("stream.open", {
            target,
            command,
            ...(o.stream ? { stream: o.stream } : {}),
            ...(o.name ? { name: o.name } : {}),
            ...(o.limit !== undefined ? { limit: o.limit } : {}),
            ...(o.wait !== undefined ? { waitMs: o.wait } : {}),
        });
        if (o.json) console.log(JSON.stringify(res, null, 2));
        else printStreamRpcResult(res);
        return;
    }
    if (sub === "peek") {
        const res = await client.rpc<StreamRpcResult>("stream.peek", {
            windowId: o.positional[0]!,
            ...(o.after !== undefined ? { afterSeq: o.after } : {}),
            ...(o.before !== undefined ? { beforeSeq: o.before } : {}),
            ...(o.limit !== undefined ? { limit: o.limit } : {}),
            ...(o.wait !== undefined ? { waitMs: o.wait } : {}),
            ...(o.stream ? { stream: o.stream } : {}),
        });
        if (o.json) console.log(JSON.stringify(res, null, 2));
        else printStreamRpcResult(res);
        return;
    }
    if (sub === "close") {
        const res = await client.rpc<{ window_id: string; closed: boolean }>("stream.close", { windowId: o.positional[0]! });
        if (o.json) console.log(JSON.stringify(res, null, 2));
        else console.log(`stream closed: ${res.window_id}`);
        return;
    }
    if (sub === "list") {
        const res = await client.rpc<{ streams: Array<{ window_id: string; name?: string; layer: string; command: string; oldest_seq: number; newest_seq: number; stale: boolean }> }>("stream.list");
        if (o.json) {
            console.log(JSON.stringify(res.streams, null, 2));
            return;
        }
        if (res.streams.length === 0) {
            console.log("（无活跃观察窗）");
            return;
        }
        for (const w of res.streams) {
            console.log(`  ${w.window_id} | layer=${w.layer} | seq=${w.oldest_seq}..${w.newest_seq} | stale=${w.stale} | ${w.command}`);
        }
        return;
    }
    throw new Error("用法: filaxis stream open ... | peek <window_id> | close <window_id> | list");
}

const generalHelp = `filaxis CLI — 千里一线，执行有迹
用法:
  filaxis mcp-config [--format json|toml]  # 输出 MCP 配置片段
  filaxis exec    [--host u@h [--port N] [--key F]] [-J jump] [--enter CMD]... [--docker CTR]
                  [--timeout MS] [--pty] [--json] -- <command>
                  # --enter 支持 "ssh <目标>"（自动非交互重放）与 "<...> bash" 结尾形态；
                  # 交互式进入（su - 类）用 --pty（stderr 与 stdout 混流=终端物理行为）
                  # --json 输出单行 {exitCode, effectiveUser, stdout, stderr}（脚本取值用，不必认标记行）
  filaxis cat     [--host ...] <path>
  ${transferUsage("put")}
  ${transferUsage("get")}
  filaxis edit    [--host ...] <path> <old> <new> [--all]   # 受控编辑（TOCTOU 锁+精确替换）
                  <path> --stdin-json | --request-file <f>  #   免 Shell 通道（JSON {old,new,all}——多行/引号保真）
  filaxis observe [--host ...] [--stream stderr|stdout|both] [--duration MS] -- <command>
  filaxis probe   [--host ...]                                     # 两段式环境探测
  filaxis batch   [--layer ...|--host ...] --request-file <plan>   # 批次组合（DAG 依赖+逐步骤证据）
                  --stdin-json                                 # 计划及每步可用 layer 选择已保存层
                  [--max-parallel N] [--no-stop-on-fail]         # 覆盖计划里的 maxParallel / stopOnFail
                  # 缺省失败即停：某步失败后未启动的步骤标 skipped（改配置→验证→重载这类链要这个）
                  # 巡检要「一台挂了其余照看」→ --no-stop-on-fail
                  # exec 步骤可写 "commandFile": 引用脚本文件（零转义、可复用）替代 "command"
                  # layer 支持通配（"q-*" 按已存层名展开）
  filaxis layer   save <name> --host ... [-J/--hop/--enter/--docker/...]   # 层路径持久化
                  list | rm <name>                                 # 层清单/移除
  filaxis daemon  start [--addr host:port] [--foreground]          # 显式启停常驻 Daemon
                  status | stop [--force]                          # 查看状态/优雅停机
  filaxis forward add (--layer NAME|--host ...) (-L|-R|-D SPEC)    # 动态端口转发（需 Daemon）
                  list [--layer NAME] [--all] | remove <forward_id>
                  # list 默认只报仍在用的转发；--all 连已停止/已退出的一并列出
  filaxis stream  open [--layer NAME|--host ...] -- <command>      # 跨命令持续观察窗（需 Daemon）
                  peek <window_id> [--after SEQ|--before SEQ] | close <window_id> | list
  （全子命令 --layer <name> 用已存层一行直达；与 --host 互斥；检测到活跃 Daemon 时自动复用，--no-daemon 绕过）

路径描述（需 --host；对齐内核三件套 connParams/sshHops/enterPipeline）:
  -J, --jump <j>          跳板（-J：途径机不占层，ssh 自身代理）。跳板的用户名与密钥取自
                          ssh 配置/ssh-agent——--key 只给目标主机；字面 IP 跳板需在 ssh config 配好
  --hop <user@host[:port]> 逐跳登录链（可重复=链序；每跳独立端口/用户，密钥共享 --key）
  --enter <cmd>           进入内层 shell（可重复=管线序，如 "docker exec -i web bash"）
  --docker <name>         糖 = --enter "docker exec -i <name> sh"（--docker-shell bash / --docker-runtime podman 可换）
  --forward L:8080:host:80  端口透传（可重复；R:/D: 同构；bind 走 SDK descriptor）
  --host-key tofu|strict  主机密钥策略（缺省 tofu=accept-new）
  --known-hosts <file>    自定义 known_hosts
连接复用：Linux 下 ControlMaster 自动多路复用（同目标跨命令毫秒级，FILAXIS_NO_MUX=1 禁用）；
Windows 无 CM 支持退化直连。每跳独立密钥等极端拓扑请用 SDK descriptor。缺省 --host 为 local。`;

async function main() {
    const helpFlag = (value: string | undefined) => value === "--help" || value === "-h";
    const commandHelp = new Map<string, string>([
        ["mcp-config", "filaxis mcp-config [--format json|toml]"],
        ["exec", "filaxis exec [--layer NAME | --host HOST] [--timeout MS] [--pty] [--json] -- <command>\nfilaxis exec [目标选项] --stdin-script | --script-file FILE\n--json 输出单行 {exitCode, effectiveUser, stdout, stderr}（脚本取值用，不必从正文里认 [exit=N user=…] 标记行）"],
        ["cat", "filaxis cat [--layer NAME | --host HOST] -- <path>"],
        ["put", transferUsage("put")],
        ["get", transferUsage("get")],
        ["edit", "filaxis edit [--layer NAME | --host HOST] <path> <old> <new> [--all] [--write-mode auto|inplace]\nfilaxis edit [目标选项] <path> --stdin-json | --request-file FILE"],
        ["observe", "filaxis observe [--layer NAME | --host HOST] [--stream stderr|stdout|both] [--duration MS] -- <command>"],
        ["probe", "filaxis probe [--layer NAME | --host HOST]"],
        ["batch", "filaxis batch [--layer NAME|--layer 通配 | --host HOST] --request-file FILE | --stdin-json\n" +
            "          [--max-parallel N] [--no-stop-on-fail]\n" +
            "目标优先级：步骤 layer → 计划 layer → --layer 或 --host。命名层来自 filaxis layer save；名字可写通配（如 \"q-*\"），按已存层名展开。\n" +
            "--max-parallel / --no-stop-on-fail 覆盖计划里的 maxParallel / stopOnFail。缺省失败即停（未启动步骤标 skipped）；巡检要「一台挂了其余照看」用 --no-stop-on-fail。\n" +
            "exec 步骤可用 \"commandFile\" 引用脚本文件，替代 \"command\"（命令原样进文件，零转义、可复用）。"],
        ["layer", "filaxis layer save <name> --host HOST | list | rm <name>"],
        ["layer save", "filaxis layer save <name> --host HOST [--port N] [--key FILE] [-J JUMP] [--hop HOST] [--enter CMD] [--docker CTR] [--forward SPEC] [--host-key tofu|strict] [--known-hosts FILE]"],
        ["layer list", "filaxis layer list"],
        ["layer rm", "filaxis layer rm <name>"],
        ["daemon", "filaxis daemon start [--addr host:port] [--foreground] [--daemon-dir dir] [--json] | status [--json] | stop [--force] [--json]"],
        ["daemon start", "filaxis daemon start [--addr host:port] [--foreground] [--daemon-dir dir] [--json]"],
        ["daemon status", "filaxis daemon status [--daemon-dir dir] [--json]"],
        ["daemon stop", "filaxis daemon stop [--force] [--daemon-dir dir] [--json]"],
        ["forward", "filaxis forward add (--layer NAME | --host HOST) (-L SPEC | -R SPEC | -D SPEC) [--id ID] [--json] | list [--layer NAME] [--all] [--json] | remove <forward_id> [--layer NAME] [--json]"],
        ["forward add", "filaxis forward add (--layer NAME | --host HOST) (-L [[bind:]port:]host:port | -R [[bind:]port:]host:port | -D [[bind:]port]) [--id ID] [--json]"],
        ["forward list", "filaxis forward list [--layer NAME] [--all] [--daemon-dir dir] [--json]\n默认只报仍在用的转发（已停止/已退出的条目用 --all 查看）。--json 字段为 snake_case（forward_id、bind_addr…），forwardId 保留为兼容别名。"],
        ["forward remove", "filaxis forward remove <forward_id> [--layer NAME] [--daemon-dir dir] [--json]"],
        ["stream", "filaxis stream open (--layer NAME | --host HOST) [--stream stdout|stderr|both] [--limit N] [--wait MS] [--json] -- <command> | peek <window_id> [--after SEQ|--before SEQ] [--limit N] [--wait MS] [--json] | close <window_id> | list"],
        ["stream open", "filaxis stream open [--layer NAME | --host HOST] [--stream stdout|stderr|both] [--limit N] [--wait MS] [--name NAME] [--json] -- <command>"],
        ["stream peek", "filaxis stream peek <window_id> [--after SEQ | --before SEQ] [--limit N] [--wait MS] [--stream stdout|stderr|both] [--json]"],
        ["stream close", "filaxis stream close <window_id> [--json]"],
        ["stream list", "filaxis stream list [--json]"],
    ]);
    if (!cmd || (args.length === 1 && helpFlag(cmd))) {
        console.log(generalHelp);
        return;
    }
    if (cmd === "mcp-config") {
        const usage = `用法: ${commandHelp.get(cmd)}`;
        const options = args.slice(1);
        if (helpFlag(options[0]) || (options[0] === "--format" && helpFlag(options[2]))) {
            console.log(usage);
            return;
        }
        const format = options.length === 0 ? "json" : options[1];
        if (options.length !== 0 && (options.length !== 2 || options[0] !== "--format"
            || (format !== "json" && format !== "toml"))) throw new Error(usage);

        const cli = fileURLToPath(import.meta.url);
        const server = { command: process.execPath, args: [join(dirname(cli), `filaxis-mcp${extname(cli)}`)] };
        console.log(format === "toml"
            ? `[mcp_servers.filaxis]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}`
            : JSON.stringify({ mcpServers: { filaxis: server } }, null, 2));
        return;
    }
    // 层快照管理组（不建 driver——纯本地 descriptor 读写）
    if (cmd === "layer") {
        const sub = args[1];
        const o = parseOpts(args.slice(2));
        if (helpFlag(sub) || o.help) {
            console.log(`用法: ${commandHelp.get(`layer ${sub}`) ?? commandHelp.get(cmd)}`);
            return;
        }
        handleLayerCmd(sub, o);
        return;
    }
    if (cmd === "daemon" || cmd === "forward" || cmd === "stream") {
        const sub = args[1];
        const o = parseOpts(args.slice(2));
        if (helpFlag(sub) || o.help || !sub) {
            const specific = sub ? commandHelp.get(`${cmd} ${sub}`) : undefined;
            console.log(`用法: ${specific ?? commandHelp.get(cmd)}`);
            if (!sub) process.exitCode = 1;
            return;
        }
        if (cmd === "daemon") await handleDaemonCmd(sub, o);
        else if (cmd === "forward") await handleForwardCmd(sub, o);
        else await handleStreamCmd(sub, o);
        return;
    }
    const transfer = cmd === "put" || cmd === "get" ? cmd : undefined;
    const o = parseOpts(args.slice(1), cmd === "batch" ? "batch" : transfer ? "strict" : "default");
    const help = commandHelp.get(cmd);
    if (o.help && help) {
        console.log(`用法: ${help}`);
        return;
    }
    if (transfer) {
        if (o.pty) throw new Error(`${transfer} 需要非交互 exec 通道完成文件校验`);
        if (transfer === "get" && o.writeMode !== undefined) throw new Error("--write-mode 仅用于 put");
        if (o.positional.length !== 2 || o.positional.some((path) => !path || path.includes("\0"))) {
            throw new Error(transferUsage(transfer));
        }
    }
    const daemon = await tryDaemon(o);
    if (cmd === "batch") {
        await runCliBatch(o, daemon);
        return;
    }
    if (daemon) {
        await runViaDaemon(cmd, o, daemon);
        return;
    }
    const drv = await driverFor(o, o.pty === true); // --pty 需先建 PTY link（审计 M1）
    try {
        switch (cmd) {
            case "put":
            case "get": {
                const [source, destination] = o.positional as [string, string];
                const result = await transferLayerFile(drv, cmd, {
                    localPath: cmd === "put" ? source : destination,
                    remotePath: cmd === "put" ? destination : source,
                    transport: o.transport,
                    timeoutMs: o.timeout,
                    writeMode: o.writeMode,
                });
                console.log(JSON.stringify(result));
                break;
            }
            case "exec": {
                // 免 Shell 命令通道（盲测痛点 #4）：复杂脚本（内嵌引号/多行/Python -c）
                // 经宿主 Shell 转义常被拦死（PowerShell ParserError 实测）——脚本从
                // stdin 或文件直达，与 edit --stdin-json 同哲学
                let execCmd = o.positional.join(" ");
                // BOM 剥+CRLF 归一（第十二季 C 组）：管道/文件来源的脚本体在 Windows
                // 侧常带 \uFEFF 前导与 \r\n 行尾——bash 视 \r 为命令名一部分
                const sanitizeScript = (t: string): string =>
                    (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t).replace(/\r\n/g, "\n");
                if (o.stdinScript) execCmd = sanitizeScript(await readStdinAll());
                else if (o.scriptFile) execCmd = sanitizeScript((await import("node:fs")).readFileSync(o.scriptFile, "utf-8"));
                // --pty：交互式层（su -/二次登录类）走 PTY 通道——stderr 与 stdout 混流（终端物理行为）
                const r = await drv.exec(execCmd, {
                    timeoutMs: o.timeout ?? 120_000,
                    channel: o.pty ? "pty" : undefined,
                });
                await printExecResult(r, o.json === true);
                break;
            }
            case "cat": {
                const [p] = o.positional;
                if (!p || p === "--help" || p === "-h") {
                    // 子命令 help 拦截（盲测 B 组实测：--help 曾被当文件名报 ENOENT）
                    console.log("用法: filaxis cat [--host ...] [--layer <名>] <path>\n输出远端/本地文件内容（UTF-8 文本；二进制走 SDK readBase64）");
                    break;
                }
                process.stdout.write(await drv.fs.readFile(p));
                break;
            }
            case "edit": {
                const [p, oldArg, newArg] = o.positional;
                let old = oldArg;
                let newStr = newArg;
                let all = o.all;
                // 免 Shell 通道（第八季盲测实锤：Windows CommandLineToArgvW 剥引号、
                // 多行 argv 要数缩进空格——Agent 卡 32 轮。JSON 载荷经 stdin/文件直达，
                // 多行/引号/缩进 100% 保真；载荷字段与 toolkit edit_file 工具同一词汇表）
                if (o.stdinJson || o.requestFile) {
                    if (o.stdinJson && o.requestFile) {
                        throw new Error("--stdin-json 与 --request-file 二选一");
                    }
                    if (oldArg !== undefined || newArg !== undefined) {
                        throw new Error("--stdin-json/--request-file 与位置参数 <old> <new> 互斥（JSON 载荷已携带）");
                    }
                    const payload = o.requestFile
                        ? readFileSync(o.requestFile, "utf-8")
                        : await readStdinAll();
                    let req: { old?: unknown; new?: unknown; all?: unknown };
                    try {
                        req = JSON.parse(payload) as typeof req;
                    } catch (e) {
                        throw new Error(`JSON 载荷解析失败（${o.requestFile ?? "stdin"}）: ${(e as Error).message}`);
                    }
                    if (!req || typeof req.old !== "string" || typeof req.new !== "string"
                        || (req.all !== undefined && typeof req.all !== "boolean")) {
                        throw new Error('JSON 载荷需含字符串字段 "old" 与 "new"（可选 "all": boolean）');
                    }
                    old = req.old;
                    newStr = req.new;
                    if (typeof req.all === "boolean") all = req.all;
                }
                if (!p || old === undefined || newStr === undefined) {
                    throw new Error("用法: filaxis edit [--host ...] <path> <old> <new> [--all] [--write-mode auto|inplace] 或 <path> (--stdin-json | --request-file <file>)\n提示：old/new 含引号/多行时优先 --request-file（免 Shell 通道，宿主引号规则零影响）");
                }
                const r = await editFile(drv, p, old, newStr, { all, writeMode: o.writeMode }); // --write-mode auto|inplace → SDK 词汇（Gemini #8）
                console.log(`edited: ${r.path} 替换 ${r.occurrences} 处，${r.bytesBefore}B → ${r.bytesAfter}B${r.mutex === "degraded" ? "（无锁降级）" : ""}`);
                break;
            }
            case "observe": {
                const h = await drv.execSession(o.positional.join(" "), { name: "cli-observe" });
                const dur = o.duration ?? 8000;
                await new Promise((r) => setTimeout(r, dur));
                // 读取异常也走停止（自审·三十六期同类：CLI observe 旧形态读取抛错
                // 跳过 stop 裸抛——同 toolkit observe_stream 修前形态）
                let lines: Array<{ stream: string; text: string }>;
                try {
                    // 双形态统一 await（第八季盲测 bug 实锤：local tailLines 同步返回数组、
                    // ssh 层 RemoteSessionManager.tailLines 是 async——漏 await 时 Promise
                    // 恒 truthy，?? 兜底短路，lines.filter 直接 TypeError）
                    // 行数归一（Hydrogen R7 #3）：统一 readSessionLog（local 热窗 50 vs remote 1000 的 20 倍差根治）
                    const streams: Array<"stdout" | "stderr"> = o.stream === "stderr" ? ["stderr"] : o.stream === "stdout" ? ["stdout"] : ["stdout", "stderr"];
                    lines = [];
                    for (const st of streams) {
                        const log = await drv.readSessionLog(h.sessionId, { lines: 500, stream: st });
                        for (const text of (log ?? "").split("\n")) {
                            if (text !== "") lines.push({ stream: st, text });
                        }
                    }
                } catch (e) {
                    await drv.stopSession(h.sessionId).catch(() => undefined);
                    const err = new Error(
                        `观察输出读取失败（${(e as Error).message}）——已尝试停止。` +
                        `会话线索 session_id=${h.sessionId} log_base=${h.logBase}（任务可能仍在运行，核实后再重试）`,
                    ) as Error & { outcome: string; sessionId: string; logBase: string };
                    err.outcome = "unknown";
                    err.sessionId = h.sessionId;
                    err.logBase = h.logBase;
                    throw err;
                }
                const filtered = (o.stream && o.stream !== "both") ? lines.filter((l) => l.stream === o.stream) : lines;
                for (const l of filtered) console.log(`[${l.stream}] ${l.text}`);
                const stopR = await drv.stopSession(h.sessionId).catch(() => ({ status: "unknown" }) as { status: "unknown" }); // 异常归 unknown（Sol 58 P2-6）
                // stop unknown 接核实（Sol 57 P2-7 同 toolkit——吞掉改带终态警示）。
                // 双未知不静默（Sol 59 P2-3）：修前仅核实 running 时提示——verify
                // 也 unknown/抛错时 CLI 零输出收场，调用者拿不到会话与日志线索
                if (stopR && stopR.status === "unknown") {
                    let vStatus = "unknown";
                    let vErr = "";
                    try { vStatus = (await drv.verifySession(h.sessionId)).status; } catch (e) { vErr = (e as Error).message; }
                    printObserveStopStatus(stopR.status, vStatus, vErr, h.sessionId, h.logBase);
                }
                break;
            }
            case "probe": {
                const r = await discoverLayer(drv, { skipStage2: false });
                console.log(JSON.stringify({ key: r.key, spec: r.spec, note: r.probeNote }, null, 2));
                break;
            }
            default:
                console.error(generalHelp);
                process.exitCode = 1;
        }
    } finally {
        await destroyDriver(drv);
    }
}

async function runViaDaemon(cmd: string, o: ReturnType<typeof parseOpts>, daemon: DaemonClient): Promise<void> {
    switch (cmd) {
        case "put":
        case "get": {
            const target = buildCliTargetSpec(o);
            const [source, destination] = o.positional as [string, string];
            const result = await daemon.rpc("transfer", {
                target,
                direction: cmd,
                localPath: resolvePath(cmd === "put" ? source : destination),
                remotePath: cmd === "put" ? destination : source,
                transport: o.transport,
                timeoutMs: o.timeout,
                writeMode: o.writeMode,
            });
            console.log(JSON.stringify(result));
            break;
        }
        case "exec": {
            const target = buildCliTargetSpec(o);
            let execCmd = o.positional.join(" ");
            const sanitizeScript = (t: string): string =>
                (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t).replace(/\r\n/g, "\n");
            if (o.stdinScript) execCmd = sanitizeScript(await readStdinAll());
            else if (o.scriptFile) execCmd = sanitizeScript(readFileSync(o.scriptFile, "utf-8"));
            const r = await daemon.rpc<{ stdout: string; stderr: string; exitCode: number; effectiveUser?: string }>("exec", {
                target,
                command: execCmd,
                timeoutMs: o.timeout ?? 120_000,
                pty: o.pty === true,
            });
            await printExecResult(r, o.json === true);
            break;
        }
        case "cat": {
            const [p] = o.positional;
            if (!p || p === "--help" || p === "-h") {
                console.log("用法: filaxis cat [--host ...] [--layer <名>] <path>\n输出远端/本地文件内容（UTF-8 文本；二进制走 SDK readBase64）");
                break;
            }
            const target = buildCliTargetSpec(o);
            const r = await daemon.rpc<{ content: string }>("cat", { target, path: p });
            process.stdout.write(r.content);
            break;
        }
        case "edit": {
            const [p, oldArg, newArg] = o.positional;
            let old = oldArg;
            let newStr = newArg;
            let all = o.all;
            if (o.stdinJson || o.requestFile) {
                if (o.stdinJson && o.requestFile) throw new Error("--stdin-json 与 --request-file 二选一");
                if (oldArg !== undefined || newArg !== undefined) {
                    throw new Error("--stdin-json/--request-file 与位置参数 <old> <new> 互斥（JSON 载荷已携带）");
                }
                const payload = o.requestFile ? readFileSync(o.requestFile, "utf-8") : await readStdinAll();
                let req: { old?: unknown; new?: unknown; all?: unknown };
                try { req = JSON.parse(payload) as typeof req; }
                catch (e) { throw new Error(`JSON 载荷解析失败（${o.requestFile ?? "stdin"}）: ${(e as Error).message}`); }
                if (!req || typeof req.old !== "string" || typeof req.new !== "string"
                    || (req.all !== undefined && typeof req.all !== "boolean")) {
                    throw new Error('JSON 载荷需含字符串字段 "old" 与 "new"（可选 "all": boolean）');
                }
                old = req.old;
                newStr = req.new;
                if (typeof req.all === "boolean") all = req.all;
            }
            if (!p || old === undefined || newStr === undefined) {
                throw new Error("用法: filaxis edit [--host ...] <path> <old> <new> [--all] [--write-mode auto|inplace] 或 <path> (--stdin-json | --request-file <file>)\n提示：old/new 含引号/多行时优先 --request-file（免 Shell 通道，宿主引号规则零影响）");
            }
            const target = buildCliTargetSpec(o);
            const r = await daemon.rpc<{ path: string; occurrences: number; bytesBefore: number; bytesAfter: number; mutex?: string }>("edit", {
                target, path: p, old, new: newStr, all, writeMode: o.writeMode,
            });
            console.log(`edited: ${r.path} 替换 ${r.occurrences} 处，${r.bytesBefore}B → ${r.bytesAfter}B${r.mutex === "degraded" ? "（无锁降级）" : ""}`);
            break;
        }
        case "observe": {
            const target = buildCliTargetSpec(o);
            const r = await daemon.rpc<{
                lines: Array<{ stream: string; text: string }>;
                stopStatus: "exited" | "stopped" | "unknown";
                verifyStatus?: string;
                verifyError?: string;
                sessionId: string;
                logBase: string;
            }>("observe", {
                target,
                command: o.positional.join(" "),
                stream: o.stream,
                duration: o.duration ?? 8000,
            });
            for (const l of r.lines) console.log(`[${l.stream}] ${l.text}`);
            printObserveStopStatus(r.stopStatus, r.verifyStatus, r.verifyError, r.sessionId, r.logBase);
            break;
        }
        case "probe": {
            const target = buildCliTargetSpec(o);
            const r = await daemon.rpc<{ key: string; spec: unknown; note?: string }>("probe", { target });
            console.log(JSON.stringify({ key: r.key, spec: r.spec, note: r.note }, null, 2));
            break;
        }
        default:
            console.error(generalHelp);
            process.exitCode = 1;
    }
}

void main().catch((err) => {
    const { message, outcome, forwardId } = err as Error & { outcome?: string; forwardId?: string };
    const detail = outcome === "unknown" && !message.includes("outcome=unknown") ? " (outcome=unknown)" : "";
    console.error(`[filaxis] ${message}${detail}${forwardId ? ` forward_id=${forwardId}` : ""}`);
    process.exit(1);
});
