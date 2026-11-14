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
import { RuntimeStack, LocalRuntimeDriver, SshPtyDriver, editFile, discoverLayer, layerDisplayName, runBatch, type BatchPlan } from "../src/index.js";
import type { RuntimeDriver, RuntimeDescriptor } from "../src/driver.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

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

function numArg(argv: string[], i: number, opts: { positive?: boolean } = {}): number {
    const raw = argv[i + 1];
    const n = raw === undefined ? NaN : parseInt(raw, 10);
    if (!Number.isFinite(n) || (opts.positive && (n <= 0))) {
        throw new Error(`参数 ${argv[i]} 需要一个${opts.positive ? "正" : ""}数字（收到: ${raw ?? "（缺失）"}）`);
    }
    return n;
}

function parseOpts(argv: string[]): {
    host?: string; user?: string; port?: number; key?: string;
    jump?: string; hop: string[]; enter: string[];
    docker?: string; dockerShell?: string; dockerRuntime?: string;
    forward: string[]; hostKey?: string; knownHosts?: string;
    layer?: string;
    timeout?: number; duration?: number; stream?: string; all?: boolean;
    stdinJson?: boolean; requestFile?: string; pty?: boolean;
    stdinScript?: boolean; scriptFile?: string; // exec 免 Shell 通道（盲测 #4）
    positional: string[];
} {
    const o: ReturnType<typeof parseOpts> = { positional: [], hop: [], enter: [], forward: [] };
    let noMoreOpts = false; // `--` 后全 positional（Astra 二十五期 #2：业务命令里的 --layer 等字面量曾被吞成选项——错层/丢参数）
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (noMoreOpts) { o.positional.push(a); continue; }
        if (a === "--") { noMoreOpts = true; continue; } // 命令分隔符：终止选项解析
        switch (a) {
            case "--host": {
                const v = argv[++i];
                if (!v) throw new Error("--host 需要目标（user@host 形态）");
                o.host = v;
                break;
            }
            case "--user": o.user = argv[++i]; break;
            case "--port": o.port = numArg(argv, i); i++; break;
            case "--key": o.key = argv[++i]; break;
            case "-J": case "--jump": o.jump = argv[++i]; break;
            case "--hop": o.hop.push(argv[++i]!); break;
            case "--enter": o.enter.push(argv[++i]!); break;
            case "--pty": o.pty = true; break;
            case "--docker": o.docker = dockerArg(argv, i); i++; break;
            case "--docker-shell": o.dockerShell = dockerArg(argv, i); i++; break;
            case "--docker-runtime": o.dockerRuntime = dockerArg(argv, i); i++; break;
            case "--forward": o.forward.push(argv[++i]!); break;
            case "--host-key": o.hostKey = argv[++i]; break;
            case "--known-hosts": o.knownHosts = argv[++i]; break;
            case "--layer": {
                const v = argv[++i];
                if (!v) throw new Error(`--layer 需要层名（收到缺失——曾静默落本机执行）`); // Sol 57 P1-1
                o.layer = v;
                break;
            }
            case "--timeout": o.timeout = numArg(argv, i, { positive: true }); i++; break; // 正数（Hydrogen R9 #4：0/负数曾静默禁用或立即杀）
            case "--duration": o.duration = numArg(argv, i, { positive: true }); i++; break;
            case "--stream": o.stream = argv[++i]; break;
            case "--all": o.all = true; break;
            case "--write-mode": {
                const v = argv[++i];
                if (v !== "auto" && v !== "inplace") throw new Error(`--write-mode 仅接受 auto|inplace（收到: ${v ?? "（缺失）"}）`);
                o.writeMode = v as "auto" | "inplace";
                break;
            }
            case "--stdin-json": o.stdinJson = true; break;
            case "--stdin-script": o.stdinScript = true; break; // exec 免 Shell：命令从 stdin 读（盲测 #4）
            case "--script-file": o.scriptFile = argv[++i]; break; // exec 免 Shell：命令从文件读
            case "--request-file": o.requestFile = argv[++i]; break;
            default: o.positional.push(a);
        }
    }
    return o;
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
    const br = rest.match(/^" + BS + BS + "\[(.+)" + BS + BS + "\]" + BS + BS + "(?::(\\d+))?" + BS + BS + "$/);
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
function layerStorePath(): string {
    return process.env.FILAXIS_LAYERS ?? (homedir() + "/.filaxis/layers.json");
}
function loadLayerStore(): Record<string, RuntimeDescriptor> {
    try {
        return JSON.parse(readFileSync(layerStorePath(), "utf-8")) as Record<string, RuntimeDescriptor>;
    } catch { return {}; }
}
function saveLayerStore(store: Record<string, RuntimeDescriptor>): void {
    const p = layerStorePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(store, null, 2), "utf-8");
}

function handleLayerCmd(args: string[]): void {
    const sub = args[1];
    const rest = parseOpts(args.slice(2));
    if (sub === "save") {
        const [name] = rest.positional;
        if (!name || !rest.host) {
            throw new Error("用法: filaxis layer save <name> --host u@h [-J <jump>] [--hop/--enter/--docker/--forward/--host-key/--known-hosts]");
        }
        const desc = buildSshDescriptor(rest);
        const store = loadLayerStore();
        const existed = Boolean(store[name]);
        store[name] = desc;
        saveLayerStore(store);
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
        const store = loadLayerStore();
        if (!store[name]) throw new Error(`层 '${name}' 未保存（filaxis layer list 查看）`);
        delete store[name];
        saveLayerStore(store);
        console.log(`layer 移除: ${name}`);
    } else {
        throw new Error("用法: filaxis layer save <name> --host ... | list | rm <name>");
    }
}

async function driverFor(opts: ReturnType<typeof parseOpts>, needPtyLink = false): Promise<RuntimeDriver> {
    // PTY link 按需建（审计 M1）：exec 通道独立 ssh 进程、观察流独立 spawn——都不依赖
    // PTY link，且不 init 能保留 execChannel 的「多跳不可直达」诚实拒绝语义（统一
    // init 会把假跳板名的错误提前成建链失败，改变错误落点）；--pty 走 link.execMarker
    // 必须先建链（修前恒抛「未就绪」）。
    const drv: RuntimeDriver = (() => {
        if (opts.layer) {
            if (opts.host) throw new Error("--layer 与 --host 互斥（层路径已持久化——改路径请 filaxis layer save 覆盖）");
            const desc = loadLayerStore()[opts.layer];
            if (!desc) {
                throw new Error(`层 '${opts.layer}' 未保存（filaxis layer list 查看；filaxis layer save ${opts.layer} --host ... 创建）`);
            }
            return new SshPtyDriver(desc);
        }
        if (opts.host) return new SshPtyDriver(buildSshDescriptor(opts));
        // local 层无路径概念——路径参数在场而 --host 缺席 = 防呆报错（静默忽略=错机器风险）
        if (opts.jump || opts.hop.length || opts.enter.length || opts.docker || opts.forward.length || opts.hostKey || opts.knownHosts) {
            throw new Error("路径描述参数（--jump/--hop/--enter/--docker/--forward/--host-key/--known-hosts）需要 --host（local 层无路径概念）");
        }
        return new LocalRuntimeDriver();
    })();
    if (needPtyLink && drv instanceof SshPtyDriver) await drv.init();
    return drv;
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

async function main() {
    // 层快照管理组（不建 driver——纯本地 descriptor 读写）
    if (cmd === "layer") {
        handleLayerCmd(args);
        return;
    }
    const o = parseOpts(args.slice(1));
    const drv = await driverFor(o, o.pty === true); // --pty 需先建 PTY link（审计 M1）
    try {
        switch (cmd) {
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
                process.stdout.write(r.stdout);
                if (r.stderr) process.stderr.write(r.stderr);
                console.error(`\n[exit=${r.exitCode} user=${r.effectiveUser ?? "?"}]`);
                process.exitCode = r.exitCode; // 不 process.exit（Gemini #8——曾跳过外层 finally 的 drv.destroy()）
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
                    if (typeof req.old !== "string" || typeof req.new !== "string") {
                        throw new Error('JSON 载荷需含字符串字段 "old" 与 "new"（可选 "all": boolean）');
                    }
                    old = req.old;
                    newStr = req.new;
                    if (typeof req.all === "boolean") all = req.all;
                }
                if (!p || old === undefined || newStr === undefined) {
                    throw new Error("用法: filaxis edit [--host ...] <path> <old> <new> [--all] [--write-mode auto|inplace] 或 <path> (--stdin-json | --request-file <file>)\n提示：old/new 含引号/多行时优先 --request-file（免 Shell 通道，宿主引号规则零影响）");
                }
                const r = await editFile(drv, p, old, newStr, { all, ...(o.writeMode === "inplace" ? { writeMode: "inplace-write" as const } : {}) }); // --write-mode auto|inplace → SDK 词汇（Gemini #8）
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
                const stopR = await drv.stopSession(h.sessionId).catch(() => undefined);
                // stop unknown 接核实（Sol 57 P2-7 同 toolkit——吞掉改带终态警示）
                if (stopR && stopR.status === "unknown") {
                    let vStatus = "unknown";
                    try { vStatus = (await drv.verifySession(h.sessionId)).status; } catch { /* 核实失败保 unknown */ }
                    if (vStatus === "running") {
                        console.error(`[filaxis] 停止结果未知且核实显示**任务仍在运行**——会话 ${h.sessionId} 日志 ${h.logBase}，勿盲目重试`);
                    }
                }
                break;
            }
            case "batch": {
                // 批次组合（第十一季）：计划 JSON 经 --request-file / --stdin-json 直达
                //（免 Shell 通道哲学——多行命令/hunk 绝不进 argv）
                if (!o.requestFile && !o.stdinJson) {
                    throw new Error("用法: filaxis batch [--layer X | --host ...] (--request-file <plan.json> | --stdin-json)");
                }
                const payload = o.requestFile ? readFileSync(o.requestFile, "utf-8") : await readStdinAll();
                let plan: BatchPlan;
                try {
                    plan = JSON.parse(payload) as BatchPlan;
                } catch (e) {
                    throw new Error(`batch 计划 JSON 解析失败: ${(e as Error).message}`);
                }
                if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
                    throw new Error('batch 计划需含非空 steps 数组（[{id, kind: "exec"|"edit"|"read", ..., after?: [依赖 id]}]）');
                }
                const r = await runBatch(drv, plan);
                for (const s of r.steps) {
                    const head = `[${s.status}] ${s.id} (${s.kind}${s.durationMs != null ? ` ${s.durationMs}ms` : ""})`;
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
                    } else {
                        console.log(`${head} ${((s.stdout ?? "").length)} 字符`);
                    }
                    if (s.error && s.kind !== "exec") console.error(`  ✗ ${s.error}`);
                }
                console.log(`batch ${r.status}${r.failedStep ? `（失败于 ${r.failedStep}）` : ""}`);
                process.exitCode = r.status === "ok" ? 0 : 1;
                break;
            }
            case "probe": {
                const r = await discoverLayer(drv, { skipStage2: false });
                console.log(JSON.stringify({ key: r.key, spec: r.spec, note: r.probeNote }, null, 2));
                break;
            }
            default:
                console.error(`filaxis CLI — 千里一线，执行有迹
用法:
  filaxis exec    [--host u@h [--port N] [--key F]] [-J jump] [--enter CMD]... [--docker CTR]
                  [--timeout MS] [--pty] -- <command>
                  # --enter 支持 "ssh <目标>"（自动非交互重放）与 "<...> bash" 结尾形态；
                  # 交互式进入（su - 类）用 --pty（stderr 与 stdout 混流=终端物理行为）
  filaxis cat     [--host ...] <path>
  filaxis edit    [--host ...] <path> <old> <new> [--all]   # 受控编辑（TOCTOU 锁+精确替换）
                  <path> --stdin-json | --request-file <f>  #   免 Shell 通道（JSON {old,new,all}——多行/引号保真）
  filaxis observe [--host ...] [--stream stderr|stdout|both] [--duration MS] -- <command>
  filaxis probe   [--host ...]                                     # 两段式环境探测
  filaxis batch   [--layer ...|--host ...] --request-file <plan>   # 批次组合（DAG 依赖+fail-fast+逐步骤证据）
                  --stdin-json                                     #   计划 JSON：{steps:[{id,kind,command/path,hunks,after}], maxParallel}
  filaxis layer   save <name> --host ... [-J/--hop/--enter/--docker/...]   # 层路径持久化
                  list | rm <name>                                 # 层清单/移除
  （全子命令 --layer <name> 用已存层一行直达；与 --host 互斥）

路径描述（需 --host；对齐内核三件套 connParams/sshHops/enterPipeline）:
  -J, --jump <j>          跳板（-J：途径机不占层，ssh 自身代理）
  --hop <user@host[:port]> 逐跳登录链（可重复=链序；每跳独立端口/用户，密钥共享 --key）
  --enter <cmd>           进入内层 shell（可重复=管线序，如 "docker exec -i web bash"）
  --docker <name>         糖 = --enter "docker exec -i <name> sh"（--docker-shell bash / --docker-runtime podman 可换）
  --forward L:8080:host:80  端口透传（可重复；R:/D: 同构；bind 走 SDK descriptor）
  --host-key tofu|strict  主机密钥策略（缺省 tofu=accept-new）
  --known-hosts <file>    自定义 known_hosts
连接复用：Linux 下 ControlMaster 自动多路复用（同目标跨命令毫秒级，FILAXIS_NO_MUX=1 禁用）；
Windows 无 CM 支持退化直连。每跳独立密钥等极端拓扑请用 SDK descriptor。缺省 --host 为 local。`);
                process.exit(cmd ? 1 : 0);
        }
    } finally {
        await drv.destroy().catch(() => undefined);
    }
}

void main().catch((err) => {
    console.error(`[filaxis] ${(err as Error).message}`);
    process.exit(1);
});
