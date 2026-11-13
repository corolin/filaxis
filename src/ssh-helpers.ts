/**
 * ssh-helpers.ts — SSH 连接参数渲染/进入管线/层状态机/层选择（纯函数）
 *
 * 净室平移自 个人Agent项目 `原内部模块` 纯函数段
 * ，OSS 化：剥 上游概念，marker 前缀换 Filaxis 命名空间。
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import * as crypto from "node:crypto";
import type { RuntimeDescriptor } from "./driver.js";

/** 端口透传（随层连接生命周期——层在隧道在，层断即撤） */
export interface SshPortForward {
    kind: "L" | "R" | "D";
    port: number;
    target?: string;
    bind?: string;
}

export function renderForwardArg(f: SshPortForward): string {
    if (f.kind === "D") return String(f.port);
    return `${f.bind ? `${f.bind}:` : ""}${f.port}:${f.target ?? ""}`;
}

/** SSH 连接参数（结构化——渲染进 ssh 命令行与身份解析） */
export interface SshConnParams {
    user?: string;
    port?: number;
    keyFile?: string;
    /** 跳板（途径机不占栈层，由 ssh 自身代理）。结构化 SshJumpSpec 为正门；
     *  字符串兼容形态收窄为白名单解析（host/[host]:port/user@host[:port]），解析
     *  不了即拒绝——ProxyCommand 值经 shell 执行，原文拼接即命令注入（Astra 十一轮 #1） */
    jump?: string | SshJumpSpec;
    forwards?: SshPortForward[];
    /**
     * 主机密钥策略（FEAT-12 / AC-12；目标与跳板同策略——跳板降级即整个连接降级）：
     * - "tofu"（缺省）——accept-new：首连自动收主机键，已知主机不匹配则拒绝
     * - "strict"——StrictHostKeyChecking=yes：仅已知主机可连（配合 knownHostsFile 自定义信任锚）
     */
    hostKeyPolicy?: "tofu" | "strict";
    /** 自定义 known_hosts 路径（UserKnownHostsFile；strict 模式的信任锚，缺省用户默认） */
    knownHostsFile?: string;
}

/** 结构化跳板参数（参数化正门——单跳。多跳请用层模型 sshInto 派生） */
export interface SshJumpSpec {
    host: string;
    user?: string;
    port?: number;
    keyFile?: string;
}

/** 跳板字段白名单（ProxyCommand 值经 shell 执行——解析校验即注入防线）。
 *  首字符必须字母数字（GPT Astra 十二轮 #2：前导 - 的位置参数被 ssh 当选项
 *  解析——单引号只防 shell 不防 argv，`ssh '-V'` 实测打印版本退出零连接） */
const JUMP_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // 主机名/别名/IPv4
const JUMP_IPV6_RE = /^[0-9A-Fa-f:.]+$/; // IPv6 字面量（含冒号）
const JUMP_USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertJumpField(kind: string, v: string, re: RegExp): void {
    if (!re.test(v)) {
        throw new Error(
            `非法跳板${kind}（拒绝拼接——跳板参数会拼入经 shell 执行的 ProxyCommand，白名单外字符即注入面）: ${JSON.stringify(v.slice(0, 60))}`,
        );
    }
}

/** 解析跳板（结构化直接校验；字符串兼容形态白名单解析；多跳逗号链显式拒绝） */
export function parseJumpSpec(jump: string | SshJumpSpec): Required<Pick<SshJumpSpec, "host">> & Pick<SshJumpSpec, "user" | "port" | "keyFile"> {
    if (typeof jump !== "string") {
        const hostRe = jump.host.includes(":") ? JUMP_IPV6_RE : JUMP_HOST_RE;
        assertJumpField(" host", jump.host, hostRe);
        if (jump.user != null) assertJumpField(" user", jump.user, JUMP_USER_RE);
        if (jump.port != null && (!Number.isInteger(jump.port) || jump.port < 1 || jump.port > 65535)) {
            throw new Error(`非法跳板 port（1-65535）: ${jump.port}`);
        }
        return { host: jump.host, user: jump.user, port: jump.port, keyFile: jump.keyFile ? expandHomePath(jump.keyFile) : undefined };
    }
    if (jump.includes(",")) {
        throw new Error(
            `多跳逗号链（'${jump.slice(0, 40)}'）不再直通——ProxyCommand 形态无法逐跳传导策略选项（旧 -J 直传时 strict 静默降级为裸奔）。多跳正门是层模型：addLayer 逐跳 + sshInto 派生（每跳独立策略/凭据）`,
        );
    }
    let user: string | undefined;
    let hostport = jump;
    const at = jump.lastIndexOf("@");
    if (at > 0) {
        user = jump.slice(0, at);
        hostport = jump.slice(at + 1);
    }
    let host = hostport;
    let port: number | undefined;
    const br = hostport.match(/^\[(.+)\]:(\d+)$/); // [host]:port（IPv6/带端口惯例）
    if (br) { host = br[1]!; port = parseInt(br[2]!, 10); }
    else {
        const pl = hostport.match(/^([^:\s]+):(\d+)$/); // host:port（host 无冒号=非裸 IPv6）
        if (pl) { host = pl[1]!; port = parseInt(pl[2]!, 10); }
    }
    if (!JUMP_HOST_RE.test(host) && !(host.includes(":") && JUMP_IPV6_RE.test(host))) {
        throw new Error(
            `非法跳板 host（拒绝拼接——白名单：主机名/别名/IPv4/IPv6 字面量；注入尝试直接拒绝）: ${JSON.stringify(jump.slice(0, 60))}`,
        );
    }
    if (user != null) assertJumpField(" user", user, JUMP_USER_RE);
    if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new Error(`非法跳板 port（1-65535）: ${port}`);
    }
    return { host, user, port, keyFile: undefined };
}

export type SshHop = string | { host: string; conn?: SshConnParams };

const isHopObj = (h: SshHop): h is { host: string; conn?: SshConnParams } => typeof h === "object";

export function hopHost(hop: SshHop): string {
    return isHopObj(hop) ? hop.host : hop;
}

/** 人读形式：root@203.0.113.10:2222 -J jump -L8080→localhost:80 */
export function hopLabel(hop: SshHop): string {
    if (!isHopObj(hop) || !hop.conn) return hopHost(hop);
    const { user, port, jump, forwards } = hop.conn;
    let s = `${user ? `${user}@` : ""}${hopHost(hop)}${port ? `:${port}` : ""}`;
    if (jump) {
        // 容错（Hydrogen R10 #4）：持久化快照里的非法 jump 曾令 layer list 整体
        // 崩溃——展示函数不得抛错，非法值原文降级展示
        try {
            const js = parseJumpSpec(jump);
            s += ` -J ${js.user ? `${js.user}@` : ""}${js.host}${js.port ? `:${js.port}` : ""}`;
        } catch {
            s += ` -J ${typeof jump === "string" ? jump.slice(0, 40) : "[spec]"}`;
        }
    }
    if (forwards?.length) {
        s += ` ${forwards.map((f) => (f.kind === "D" ? `-D${f.port}` : `-${f.kind}${f.port}→${f.target}`)).join(" ")}`;
    }
    return s;
}

/** 主目标串防选项注入（Astra 十二轮 #2 同源）：前导 - 的位置参数被 ssh 当
 *  选项解析（`ssh -V` 打版本退出——引用不阻止 argv 层选项解析） */
function assertBareHost(target: string): void {
    if (target.startsWith("-")) {
        throw new Error(`非法目标主机串（前导 - 会被 ssh 当选项解析）: ${JSON.stringify(target.slice(0, 40))}`);
    }
}

/** ssh 命令行参数（spawn 数组与 ssh -G 解析共用） */
export function sshArgsFor(hop: SshHop): string[] {
    if (!isHopObj(hop) || !hop.conn) {
        assertBareHost(hopHost(hop));
        return [hopHost(hop)];
    }
    const { user, port, keyFile, jump, forwards } = hop.conn;
    const args: string[] = [];
    if (jump) {
        // 不用 -J 简写：ProxyJump 跳板子连接**不继承**主连接的 -o 选项（CI 实锤：
        // -J 下跳板 host key 检查走缺省 strict，首连即 Host key verification
        // failed——「host key 缺省 TOFU」承诺对跳板不成立）。改用 ProxyJump 的
        // 底层等价形态 ProxyCommand（值是命令，经 shell 执行）：
        // - 跳板经 parseJumpSpec 白名单校验 + sh 单引号引用（Astra 十一轮 #1：原文
        //   拼接即注入入口）；多跳逗号链显式拒绝（#3——层模型 sshInto 是多跳正门）
        // - host key 策略随主连接传导（#2：strict+knownHostsFile 不在跳板静默降级）
        const js = parseJumpSpec(jump);
        const hk = `-o StrictHostKeyChecking=${hop.conn.hostKeyPolicy === "strict" ? "yes" : "accept-new"}${hop.conn.knownHostsFile ? ` -o UserKnownHostsFile=${shellQuote(expandHomePath(hop.conn.knownHostsFile))}` : ""} `;
        const keyOpt = js.keyFile ? `-i ${shellQuote(js.keyFile)} ` : "";
        const portOpt = js.port ? `-p ${js.port} ` : "";
        const target = shellQuote(js.user ? `${js.user}@${js.host}` : js.host);
        args.push("-o", `ProxyCommand=ssh ${hk}${keyOpt}${portOpt}-W %h:%p ${target}`);
    }
    if (keyFile) args.push("-i", expandHomePath(keyFile));
    if (port) args.push("-p", String(port));
    for (const f of forwards ?? []) {
        args.push(f.kind === "L" ? "-L" : f.kind === "R" ? "-R" : "-D", renderForwardArg(f));
    }
    const final = user ? `${user}@${hopHost(hop)}` : hopHost(hop);
    assertBareHost(final); // 主目标同样拒前导 -（user 拼入 -x@host 形态也是选项面）
    args.push(final);
    return args;
}

/** PTY 内单行发送所需的引用形式。**单引号包裹**（GPT Astra 十二轮 #1：双引号
 *  内 $()/反引号照常展开——且会让内层 ProxyCommand 的单引号防护失效，结构化
 *  jump.keyFile 的命令替换实测经此通道执行）；白名单裸串零引用开销。 */
export function sshArgsQuoted(hop: SshHop): string {
    return sshArgsFor(hop)
        .map((a) => (/^[A-Za-z0-9_@:./%=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))
        .join(" ");
}

/** `~` 展开——spawn 参数数组不经过 shell，tilde 不会被展开（生产实证：公钥认证被拒 exit 255） */
export function expandHomePath(p: string): string {
    if (p === "~") return homedir();
    if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
    return p;
}

/** 进入管线一步：建层时在链路末端落进内层 shell 的一条命令（docker exec / kubectl exec / su 等） */
export interface EnterStep {
    /** 进入命令原文（重放用） */
    cmd: string;
    /** 显示/层选择标签（缺省截取 cmd） */
    label?: string;
}

/**
 * enter 管线别名键（第十二季语法糖——Agent 实锤事故：手滑把 enterCmd 写成
 * enterCommand，字段不被识别 → 静默建成裸宿主机层 → 文件全写错机器）。
 * 简写与完整词等价归一（别名间互为同键——driverKey 指纹不受别名选择影响）。
 */
const ENTER_CMD_KEYS = ["enterCmd", "enterCommand", "enter_cmd", "enter"] as const;
const ENTER_PIPELINE_KEYS = ["enterPipeline", "enters", "enterSteps", "enter_steps"] as const;
const ENTER_LABEL_KEYS = ["enterLabel", "enter_label"] as const;

/** enter 族全部别名列（连接指纹的身份归一剔除集——语义列以 enterStepsOf 归一
 *  结果参与指纹，别名原文剔除以防「同语义不同别名形态」分裂指纹） */
export const ENTER_ALIAS_KEYS: readonly string[] = [...ENTER_CMD_KEYS, ...ENTER_PIPELINE_KEYS, ...ENTER_LABEL_KEYS];

/** 层的完整进入管线（归一化读取）：管线数组（enterPipeline/enters 族）为准；
 *  单步别名（enterCmd/enterCommand/enter_cmd/enter）+ label 就地归一 */
export function enterStepsOf(config: Record<string, unknown> | undefined): EnterStep[] {
    for (const key of ENTER_PIPELINE_KEYS) {
        const v = config?.[key];
        if (Array.isArray(v)) {
            return v
                .filter((s) => typeof s === "string" || (s != null && typeof (s as EnterStep).cmd === "string"))
                .map((s) => typeof s === "string"
                    ? { cmd: s }
                    : { cmd: String((s as EnterStep).cmd), label: (s as EnterStep).label ? String((s as EnterStep).label) : undefined });
        }
    }
    for (const key of ENTER_CMD_KEYS) {
        const v = config?.[key];
        if (typeof v === "string" && v) {
            const label = ENTER_LABEL_KEYS.map((k) => config?.[k]).find((l) => typeof l === "string" && l);
            return [{ cmd: v, label: label ? String(label) : undefined }];
        }
    }
    return [];
}

// ── ssh 层配置键防线（第十二季用户警示：不识别的键不得静默吞掉建裸层——写错机器）──

/** SshPtyDriver config 已知键全集（含别名） */
const SSH_CONFIG_KNOWN_KEYS = [
    "pty", "connParams", "sshHops", "sshOptions",
    ...ENTER_PIPELINE_KEYS, ...ENTER_CMD_KEYS, ...ENTER_LABEL_KEYS,
    "launchCmd", "runtime", "shell", "namespace",
];

/** 键名归一化（lowercase + 去 _/-）：enter_command ≡ enterCommand ≡ entercmd */
const normKey = (k: string) => k.toLowerCase().replace(/[-_]/g, "");

/** 编辑距离（Levenshtein，短键名 O(mn) 足够；零依赖红线内手写） */
function editDistance(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 3; // 长度差>2 直接不可能 ≤1（快速剪枝）
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) dp[0]![j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i]![j] = Math.min(
                dp[i - 1]![j]! + 1,
                dp[i]![j - 1]! + 1,
                dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
    }
    return dp[m]![n]!;
}

/**
 * ssh 层配置键疑似拼错检测：未知键与已知键归一化编辑距离 ≤1（如 connParam→connParams、
 * sshHop→sshHops、enterPipelines→enterPipeline）→ **抛错并给正确键名建议**——
 * 静默忽略拼错键=层路径悄悄降级（enter 漏建=裸宿主机层），文件写错机器。
 * 与已知键无关的自定义键不拦（config 是开放字典——扩展性保留）。
 */
export function assertNoLikelyTypoKeys(config: Record<string, unknown> | undefined, what = "层配置"): void {
    if (!config) return;
    for (const key of Object.keys(config)) {
        if (SSH_CONFIG_KNOWN_KEYS.includes(key)) continue;
        const nk = normKey(key);
        if (SSH_CONFIG_KNOWN_KEYS.some((k) => normKey(k) === nk)) continue; // 大小写/下划线变体（语义等价）
        for (const known of SSH_CONFIG_KNOWN_KEYS) {
            const d = editDistance(nk, normKey(known));
            if (d <= 1) {
                throw new Error(
                    `${what}键 '${key}' 不识别（疑似 '${known}' 的拼写变体）——拒绝建层：静默忽略该键会导致层路径错误` +
                    `（如 enter 漏建=命令落在宿主机而非容器）。请更正为 '${known}'`,
                );
            }
        }
    }
}

/**
 * 自治建链选项（AC-12：host key 策略显式可配）：
 * - ConnectTimeout=10（先于握手超时暴露真相）；ServerAlive 30×3（静默死亡 ~90s 内暴露）
 * - hostKeyPolicy：tofu（缺省，accept-new）/ strict（yes + 可选 UserKnownHostsFile）
 * 不加 BatchMode：禁交互提示会抹掉「等待输入」这个可感知状态——感知到 prompt 后
 * 把原文直交调用方，而不是假装它不存在。
 * 渲染只含密钥/known_hosts **路径**，永不包含其内容（AC-12 无泄漏红线）。
 */
export function autonomousSshOpts(conn?: SshConnParams): string[] {
    // LogLevel=ERROR（第十二季 B 组实测）：跳板 UserKnownHostsFile 变更产生的
    // "Warning: Permanently added" 每次 run_command 重复灌 stderr——压到 ERROR 级
    const opts = ["-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"];
    if (conn?.hostKeyPolicy === "strict") {
        opts.push("-o", "StrictHostKeyChecking=yes");
    } else {
        opts.push("-o", "StrictHostKeyChecking=accept-new"); // TOFU 缺省
    }
    // 独立信任锚（Hydrogen R6 #2）：knownHostsFile 与策略正交——tofu 模式下曾静默
    // 忽略（指纹仍写宿主 ~/.ssh/known_hosts，隔离意图失效）
    if (conn?.knownHostsFile) {
        opts.push("-o", `UserKnownHostsFile=${expandHomePath(conn.knownHostsFile)}`);
    }
    return opts;
}

/**
 * mux socket 确定性路径（destArgs 哈希）——跨进程共享 master 的锚点
 * （第一条命令付握手建 master，后续任何进程同 dest 毫秒级复用）。
 */
export function muxSocketPath(destArgs: string[], dir?: string): string {
    const destKey = crypto.createHash("sha256").update(destArgs.join(" ")).digest("hex").slice(0, 16);
    const muxDir = dir ?? join(tmpdir(), "filaxis-mux");
    try { if (!existsSync(muxDir)) mkdirSync(muxDir, { recursive: true }); } catch { /* 并发竞态容忍 */ }
    return join(muxDir, `cm-${destKey}`);
}

/** mux 可用性（Hydrogen R6 #6）：sun_path 上限 macOS≈104B / Linux 108B——
 *  长 TMPDIR 下 ControlPath 超限导致 OpenSSH 报 too long for Unix domain
 *  socket。超限即降级直连（无 mux——握手成本回到每命令，正确性不受影响）。 */
export function muxPathUsable(path: string): boolean {
    return path.length <= 100; // 保守上限（104-108 留余量）
}

/**
 * ControlMaster 多路复用 flags（exec 通道与观察流共享同一 master）：
 * - Windows OpenSSH 无 ControlMaster（known limitation）→ 退化直连（每条重握手）
 * - FILAXIS_NO_MUX=1 显式禁用（测试/平台受限）
 * 源自 stream-session-manager 的观察流实现（第十一季下沉共享——此前 exec/编辑
 * 通道未接 CM，CLI 每条命令白握手）。
 */
export function muxFlagsFor(destArgs: string[], opts: { disable?: boolean; dir?: string } = {}): string[] {
    if (opts.disable || process.platform === "win32" || process.env.FILAXIS_NO_MUX === "1") return [];
    const sock = muxSocketPath(destArgs, opts.dir);
    if (!muxPathUsable(sock)) return []; // 超长降级直连（Hydrogen R6 #6——sun_path 上限）
    return [
        "-o", `ControlPath=${sock}`,
        "-o", "ControlMaster=auto",
        "-o", "ControlPersist=600", // master 独立常驻：CLI 进程退出后保留 10min 复用窗口
    ];
}

/** root 层 spawn 全参数（含 -tt 强制 PTY） */
export function rootSshSpawnArgs(destArgs: string[], conn?: SshConnParams): string[] {
    return ["-tt", ...autonomousSshOpts(conn), ...destArgs];
}

/** PTY 内 hop 登录命令（选项语义与 root 对齐） */
export function hopSshCommand(hop: SshHop): string {
    const conn = typeof hop === "object" ? hop.conn : undefined;
    return `ssh ${autonomousSshOpts(conn).join(" ")} ${sshArgsQuoted(hop)}`;
}

/** 「等待输入」感知特征：ssh 停在交互提示（密码/口令/yes-no）——检测到即失败交还原文 */
export const SSH_INPUT_WAIT_RE =
    /(?:password|passphrase|verification\s+code|login|密码|口令)[^\n]*[:：]\s*$|yes\s*\/\s*no|are you sure|continue connecting/i;

const identityCache = new Map<string, string>();
/** 连接身份解析（ssh -G 本地解析不连网）；失败回退 unresolved: 前缀（视为不相同，不误拦） */
export async function resolveSshIdentity(hop: SshHop): Promise<string> {
    const cacheKey = typeof hop === "string" ? hop : JSON.stringify(hop);
    const cached = identityCache.get(cacheKey);
    if (cached) return cached;
    try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const X = promisify(execFile);
        const { stdout } = await X("ssh", ["-G", ...sshArgsFor(hop)], { timeout: 8000 });
        const h = stdout.match(/^hostname (\S+)$/m)?.[1] ?? hopHost(hop);
        const p = stdout.match(/^port (\d+)$/m)?.[1] ?? "22";
        const u = stdout.match(/^user (\S+)$/m)?.[1] ?? "";
        const id = `${u ? u + "@" : ""}${h}:${p}`;
        identityCache.set(cacheKey, id);
        return id;
    } catch {
        return `unresolved:${hopHost(hop)}`;
    }
}

/** 层的完整途经身份链（target + hops），供回环检测 */
export function layerPathIdentities(desc: RuntimeDescriptor): SshHop[] {
    const hops: SshHop[] = Array.isArray(desc.config?.sshHops) ? (desc.config.sshHops as SshHop[]) : [];
    const connParams = desc.config?.connParams as SshConnParams | undefined;
    const root: SshHop = desc.target ? (connParams ? { host: desc.target, conn: connParams } : desc.target) : "";
    return [root, ...hops].filter(Boolean);
}

/** 层显示名（root 含端口/用户 + 途经链 + 进入标签） */
export function layerDisplayName(desc: RuntimeDescriptor): string {
    const hops = (Array.isArray(desc.config?.sshHops) ? (desc.config.sshHops as SshHop[]) : []).map((h) => hopLabel(h));
    const connParams = desc.config?.connParams as SshConnParams | undefined;
    const root = hopLabel(connParams ? { host: desc.target ?? "?", conn: connParams } : desc.target ?? "?");
    const parts = [root, ...hops];
    parts.push(...enterStepsOf(desc.config as Record<string, unknown> | undefined).map((s) => s.label ?? s.cmd.slice(0, 24)));
    return parts.join(" → ");
}

/** 层显示标签（descriptor 链 + 容器短 ID 后缀） */
export function layerDisplayLabel(d: { descriptor: RuntimeDescriptor; containerId?: string }): string {
    const base = layerDisplayName(d.descriptor);
    return d.containerId ? `${base}(${d.containerId})` : base;
}

/**
 * exec 通道（非 PTY）进入管线重放渲染（FEAT-03 层上下文拼装）：
 * 每步清洗 -it → -i（非交互）后要求以 shell 结尾（docker exec -it ctr bash 形态）——
 * 渲染为 stdin 管道链：`… bash -s` 逐层读 stdin，命令文本从本地注入，零嵌套引用。
 * 任一步非 shell 结尾形态（如裸 su -）→ 不可直达层（exec 通道拒绝，用 pty 通道）。
 */
const SHELL_TAIL_RE = /(?:^|\s)(bash|sh|zsh|ash|dash)\s*$/;

/** shell 单引号安全引用（GPT Astra 五轮 P1：JSON.stringify 的双引号**不是** shell
 *  转义——$() / 反引号 / $VAR 在双引号内照常展开，路径即注入面） */
/** shell 词法分词（Gemini Hydrogen 审查 #4）：识别单/双引号与反斜杠转义——
 *  enterCmd 带空格路径/引号参数（ssh -i "/path/with space/key"）曾按空白
 *  split 截断并保留字面引号，spawn 参数错乱 */
export function tokenizeArgv(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let quoted = false;   // 引号包裹过（保留空串参数）
    let quote: '"' | '"' | undefined;
    for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (quote) {
            if (c === quote) quote = undefined;
            else if (quote === '"' && c === "' + BS + BS + '") cur += line[++i] ?? "";
            else cur += c;
        } else if (c === '"' || c === "'") { quote = c as '"' | '"'; quoted = true; }
        else if (c === " " || c === "' + chr(9) + '") { if (cur !== "" || quoted) { out.push(cur); cur = ""; quoted = false; } }
        else cur += c;
    }
    if (cur !== "" || quoted) out.push(cur);
    return out;
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** 环境变量名合法性（拼入远端命令前的红线——防 argv/引号注入） */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 远端 env 前缀渲染（GPT Astra 十轮自挖：env 三层语义统一——local=子进程 env、
 *  ssh=曾灌给本地 ssh 进程（远端看不见）、tmux=曾静默丢弃；统一为远端语义：
 *  `export K='V'; ` 前缀拼进命令，与 cwd 同通道生效） */
export function envPrefixOf(env?: Record<string, string>): string {
    if (!env) return "";
    return Object.entries(env).map(([k, v]) => {
        if (!ENV_NAME_RE.test(k)) throw new Error(`非法环境变量名（拼接拒绝）: ${k}`);
        return `export ${k}=${shellQuote(String(v))}; `;
    }).join("");
}

export type ExecChannelRender =
    | { kind: "ok"; remoteArgs: string[]; stdinCmd: string }
    | { kind: "unreachable"; reason: string; step: string };

export function renderExecChannel(
    steps: EnterStep[],
    command: string,
    opts: { cwd?: string; envPrefix?: string; marker: string; nonceWrapped: string },
): ExecChannelRender {
    /** 单层进入命令的非交互重放形态（docker：-it→-i + shell 追加 -s；ssh：剥 -t +
     *  远端命令位接 sh -s） */
    const replayTokens = (raw: string): string[] | { unreachable: true; reason: string; step: string } => {
        // -it / -t → -i（非交互）；进入命令须以 shell 结尾（内层读 stdin）
        const cleaned = raw.replace(/(^|\s)-(it|ti)\b/g, "$1-i").replace(/(^|\s)-t\b/g, "$1-i").trim();
        // ssh 形态（用户实测反馈）：`ssh remote-vm` 不以 shell 结尾，但远端命令位
        // 可直接接 sh -s（ssh host sh -s = stdin 管道链，零嵌套引用）——并非真不可
        // 直达。注意清洗语义与 docker 相反：ssh 的 -t 是「强制 PTY」须**剥掉**
        // （换成 -i 会变成 identity file 指认，完全跑偏）
        if (/^ssh(\s|$)/.test(cleaned)) {
            const stripped = cleaned.replace(/(^|\s)-+(tt|t)\b/g, "$1").replace(/\s+/g, " ").trim();
            return [...tokenizeArgv(stripped), "sh", "-s"];
        }
        const m = SHELL_TAIL_RE.exec(cleaned);
        if (!m) {
            return {
                unreachable: true,
                reason: "进入命令无法非交互重放（既非「… bash/sh」结尾、也非「ssh <目标>」形态——如 su - /密码交互类）",
                step: raw,
            };
        }
        return [...tokenizeArgv(cleaned), "-s"]; // shell -s：从 stdin 读命令
    };

    // 多层进入（用户实测实锤 + 真机根因分析）：旧实现把所有层都塞 argv——第一层
    // 的 sh -s 把注入脚本全量吃掉，后续层沦为位置参数被**静默忽略**（命令跑在第一
    // 层环境还报成功）；流式接力（后续层作为 stdin 头部逐行）也不行——sh 读脚本
    // **按块预读缓冲**，docker 行之后的业务行早被 sh 吞进缓冲，下一层启动时 stdin
    // 已空（真机实证）。正确解：首层进 argv；后续层经 **heredoc 逐层包裹**——
    // 分隔符带 nonce（marker 派生）防业务脚本内撞车，<<'TAG' 引号形式零展开。
    const remoteArgs: string[] = [];
    const innerLayers: string[] = [];
    if (steps.length > 0) {
        const first = replayTokens(steps[0]!.cmd);
        if ("unreachable" in first) return { kind: "unreachable", reason: first.reason, step: first.step };
        remoteArgs.push(...first);
        for (const s of steps.slice(1)) {
            const t = replayTokens(s.cmd);
            if ("unreachable" in t) return { kind: "unreachable", reason: t.reason, step: t.step };
            innerLayers.push(t.join(" "));
        }
    }
    // 终层远端 shell：POSIX sh 通吃（包装脚本纯 POSIX——报告 #3：FreeBSD/Alpine 无 bash
    // 也能跑；bash 系统上 sh 通常为 bash/ash 链接，行为兼容）
    remoteArgs.push("sh", "-s");
    // cwd 拼装（Astra 五轮 P1）：① 单引号安全引用（双引号不挡 $()/反引号——路径内
    // 命令注入）；② cd 失败 fail-closed——业务命令**不执行**，哨兵带 126 诚实回传
    // （退出码是数据；不吞 shell 原生 cd 报错行），绝不静默回退到错误目录继续跑。
    const cd = opts.cwd
        ? `cd ${shellQuote(opts.cwd)} || { printf '\\n${opts.marker}:126:%s\\n' "$(id -un 2>/dev/null)"; exit 126; }; `
        : "";
    // env 前缀（十轮自挖：远端语义——export K='V'; 先于 cd/业务命令）。
    // envPrefix/cd 拼在**终层脚本头部**（最内层执行——多层时 export 在第一层执行
    // 传不进 docker 容器；cd 同理管的是业务命令的工作目录）
    void command;
    const tail = `${opts.envPrefix ?? ""}${cd}${opts.nonceWrapped}`;
    // 多层：由内向外逐层 heredoc 包裹（内层命令 + <<'TAG' + payload + TAG）。
    // 单层（innerLayers 空）时 payload=tail 与旧版逐字节一致。
    let payload = tail;
    for (let i = innerLayers.length - 1; i >= 0; i--) {
        const tag = `${opts.marker}_HD${i}`;
        payload = `${innerLayers[i]!} <<'${tag}'\n${payload}\n${tag}`;
    }
    return { kind: "ok", remoteArgs, stdinCmd: payload };
}
