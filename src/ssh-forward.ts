/**
 * ssh-forward.ts — SSH 动态端口转发内核（-L / -R / -D 双路径自动适配）
 *
 * 两条路径统一收敛到相同的 OpenForwardSpec / ForwardInfo / CloseForwardResult 契约：
 * - Path A（Mux）：非 Windows 且存在可用 ControlMaster 控制套接字时，
 *   经 `ssh -S <sock> -O forward / -O cancel` 复用已有主连接，零额外握手开销。
 * - Path B（Subprocess）：Windows（无 ControlMaster）、禁用 mux 或主连接未建 mux 时，
 *   自动降级为受托管的 `ssh -N -o ExitOnForwardFailure=yes` 子进程，并纳入层生命周期回收。
 *
 * 语义不变量（REQ-0005 / AGENTS.md）：
 * - closeForward 遵循「终止即请求、死亡须核实」，严格返回 stopped / already_closed / unknown；
 * - bindPort: 0 时必须回传实测绑定端口，解析失败一律报错，绝不返回 0 假装成功；
 * - 托管子进程意外退出诚实标记为 exited 并触发事件，绝不静默假装健康。
 */
import * as crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { autonomousSshOpts, muxFlagsFor, renderEnterBridgeCommand, shellQuote, type EnterStep, type SshConnParams } from "./ssh-helpers.js";
import { openSshEnvironment } from "./openssh-environment.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

export type DynamicForwardKind = "local" | "remote" | "dynamic";
export type ForwardTransportMode = "mux" | "subprocess" | "stdio-bridge";
export type ForwardStatus = "active" | "exited" | "stopped" | "unknown";

export interface OpenForwardSpec {
    kind: DynamicForwardKind | "L" | "R" | "D";
    bindAddr?: string;
    bindPort?: number;
    targetHost?: string;
    targetPort?: number;
    id?: string;
    timeoutMs?: number;
}

export interface ForwardInfo {
    forwardId: string;
    layer?: string;
    kind: DynamicForwardKind;
    bindAddr: string;
    bindPort: number;
    targetHost?: string;
    targetPort?: number;
    transportMode: ForwardTransportMode;
    status: ForwardStatus;
    createdAt: number;
    pid?: number;
    exitCode?: number | null;
    lastError?: string;
}

export interface CloseForwardResult {
    status: "stopped" | "already_closed" | "unknown";
    forwardId: string;
    detail?: string;
}

/** 转发是否仍承载流量（DSH 评估 2026-11-26 #5a）。已停止/已退出的条目只是墓碑——
 *  留在表里是给 closeForward 做幂等判定（already_closed）的，列表类查询默认不该再
 *  把它们当作在用的转发报出来。status=unknown 是「终止未确认」，不能当已停隐藏。 */
export function isForwardActive(info: Pick<ForwardInfo, "status">): boolean {
    return info.status !== "stopped" && info.status !== "exited";
}

/**
 * 对外转发记录（CLI --json 与 MCP 结果；DSH 评估 2026-11-26 #5b）：snake_case——
 * 与工具参数（forward_id、bind_addr…）和流观察窗的 window_id 同一命名风格。
 * SDK 类型 ForwardInfo 保持驼峰不动。
 */
export interface PublicForwardInfo {
    forward_id: string;
    /** 兼容别名（将移除）——请读 forward_id */
    forwardId: string;
    layer?: string;
    kind: DynamicForwardKind;
    bind_addr: string;
    bind_port: number;
    target_host?: string;
    target_port?: number;
    transport_mode: ForwardTransportMode;
    status: ForwardStatus;
    created_at: number;
    pid?: number;
    exit_code?: number | null;
    last_error?: string;
}

export interface PublicCloseForwardResult {
    forward_id: string;
    /** 兼容别名（将移除）——请读 forward_id */
    forwardId: string;
    status: CloseForwardResult["status"];
    detail?: string;
}

export function forwardInfoToPublic(info: ForwardInfo): PublicForwardInfo {
    return {
        forward_id: info.forwardId,
        forwardId: info.forwardId,
        ...(info.layer !== undefined ? { layer: info.layer } : {}),
        kind: info.kind,
        bind_addr: info.bindAddr,
        bind_port: info.bindPort,
        ...(info.targetHost !== undefined ? { target_host: info.targetHost } : {}),
        ...(info.targetPort !== undefined ? { target_port: info.targetPort } : {}),
        transport_mode: info.transportMode,
        status: info.status,
        created_at: info.createdAt,
        ...(info.pid !== undefined ? { pid: info.pid } : {}),
        ...(info.exitCode !== undefined ? { exit_code: info.exitCode } : {}),
        ...(info.lastError !== undefined ? { last_error: info.lastError } : {}),
    };
}

/** closeForward 结果的对外投影（同 forwardInfoToPublic） */
export function closeForwardResultToPublic(res: CloseForwardResult): PublicCloseForwardResult {
    return {
        forward_id: res.forwardId,
        forwardId: res.forwardId,
        status: res.status,
        ...(res.detail !== undefined ? { detail: res.detail } : {}),
    };
}

export interface NormalizedForwardSpec {
    kind: DynamicForwardKind;
    flag: "-L" | "-R" | "-D";
    bindAddr: string;
    bindPort: number;
    targetHost?: string;
    targetPort?: number;
    forwardId: string;
    timeoutMs: number;
}

export interface ExecSshResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
}

export interface ForwardDeps {
    execSsh?: (argv: string[], timeoutMs: number) => Promise<ExecSshResult>;
    spawnSsh?: (argv: string[]) => ChildProcess;
    spawnBridge?: (argv: string[]) => ChildProcess;
    allocateLocalPort?: (bindAddr: string) => Promise<number>;
    muxControlPath?: () => string | undefined;
    stopGraceMs?: number;
    killWaitMs?: number;
}

export interface SshForwardManagerOptions {
    /** 用于启动独立转发或控制命令的 ssh 目标参数（不含静态 forwards 以避免端口冲突） */
    destArgs: string[];
    /** 用于计算 mux ControlPath 的完整参数（含静态连接特征，缺省同 destArgs） */
    muxDestArgs?: string[];
    connParams?: SshConnParams;
    layerName?: string;
    /** 若层含 enterPipeline（如 --docker/--enter），本地转发自动经穿层 stdio TCP 桥穿透到内层 127.0.0.1 */
    enterSteps?: EnterStep[];
    execInLayer?: (command: string, opts?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    logger?: FilaxisLogger;
    onForwardExit?: (info: ForwardInfo) => void;
    _deps?: ForwardDeps;
}

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IPV6_RE = /^[0-9A-Fa-f:]+$/;
const FORWARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_FORWARD_TIMEOUT_MS = 15_000;
const DEFAULT_MUX_CMD_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_GRACE_MS = 3_000;
const DEFAULT_KILL_WAIT_MS = 2_000;
const MAX_DIAG_BYTES = 4096;

type BridgeTool = "socat" | "python3" | "python" | "node" | "nc";

const PYTHON_STDIO_TCP_BRIDGE = [
    "import os,select,socket,sys",
    "s=socket.create_connection((sys.argv[1],int(sys.argv[2])))",
    "rf=[0,s]",
    "eof_in=False",
    "while rf:",
    " r,_,_=select.select(rf,[],[])",
    " if 0 in r:",
    "  d=os.read(0,16384)",
    "  if not d:",
    "   eof_in=True;rf.remove(0)",
    "   try:s.shutdown(socket.SHUT_WR)",
    "   except OSError:pass",
    "  else:s.sendall(d)",
    " if s in r:",
    "  d=s.recv(16384)",
    "  if not d:break",
    "  v=memoryview(d)",
    "  while v:",
    "   n=os.write(1,v);v=v[n:]",
    "s.close()",
].join("\n");

const NODE_STDIO_TCP_BRIDGE = [
    "const net=require('node:net');",
    "const s=net.createConnection({host:process.argv[1],port:Number(process.argv[2])});",
    "const bye=()=>process.exit(0);",
    "s.on('error',()=>process.exit(1));",
    "process.stdin.on('error',()=>s.destroy());",
    "process.stdout.on('error',()=>s.destroy());",
    "process.stdin.pipe(s);",
    "s.pipe(process.stdout);",
    "s.on('close',bye);",
].join("");

export function buildInnerTcpBridgeCmd(tool: BridgeTool, targetHost: string, targetPort: number): string {
    if (tool === "socat") {
        const dest = targetHost.includes(":") ? `TCP6:[${targetHost}]:${targetPort}` : `TCP:${targetHost}:${targetPort}`;
        return `exec socat - ${shellQuote(dest)}`;
    }
    if (tool === "python3" || tool === "python") {
        return `exec ${tool} -u -c ${shellQuote(PYTHON_STDIO_TCP_BRIDGE)} ${shellQuote(targetHost)} ${String(targetPort)}`;
    }
    if (tool === "node") {
        return `exec node -e ${shellQuote(NODE_STDIO_TCP_BRIDGE)} ${shellQuote(targetHost)} ${String(targetPort)}`;
    }
    return `exec nc ${shellQuote(targetHost)} ${String(targetPort)}`;
}

function unwrapBrackets(host: string): string {
    const trimmed = host.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function assertSafeHost(label: string, raw: string, allowWildcard = false): string {
    const host = unwrapBrackets(raw);
    if (!host) throw new Error(`动态端口转发 ${label} 不能为空`);
    if (allowWildcard && host === "*") return host;
    const ok = host.includes(":") ? IPV6_RE.test(host) : HOST_RE.test(host);
    if (!ok) {
        throw new Error(`非法动态端口转发 ${label}（禁止前导 '-'、空白或 shell 元字符）: ${JSON.stringify(raw.slice(0, 60))}`);
    }
    return host;
}

function assertPort(label: string, port: unknown, allowZero: boolean): number {
    if (typeof port !== "number" || !Number.isInteger(port)) {
        throw new Error(`动态端口转发 ${label} 必须为整数: ${String(port)}`);
    }
    const min = allowZero ? 0 : 1;
    if (port < min || port > 65535) {
        throw new Error(`动态端口转发 ${label} 超出范围（${min}-65535）: ${port}`);
    }
    return port;
}

function formatBindOrTargetAddr(addr: string): string {
    if (addr === "*") return "*";
    return addr.includes(":") ? `[${addr}]` : addr;
}

function bindHostFor(bindAddr: string): string {
    return bindAddr === "*" ? "0.0.0.0" : bindAddr;
}

function appendDiag(prev: string, chunk: string): string {
    const next = prev + chunk;
    return next.length > MAX_DIAG_BYTES ? next.slice(-MAX_DIAG_BYTES) : next;
}

/** 归一化并严格校验动态端口转发规格 */
export function normalizeForwardSpec(spec: OpenForwardSpec): NormalizedForwardSpec {
    let kind: DynamicForwardKind;
    let flag: "-L" | "-R" | "-D";
    if (spec.kind === "local" || spec.kind === "L") {
        kind = "local";
        flag = "-L";
    } else if (spec.kind === "remote" || spec.kind === "R") {
        kind = "remote";
        flag = "-R";
    } else if (spec.kind === "dynamic" || spec.kind === "D") {
        kind = "dynamic";
        flag = "-D";
    } else {
        throw new Error(`不支持的动态端口转发类型: ${String((spec as { kind?: unknown }).kind)}（支持 local/L, remote/R, dynamic/D）`);
    }

    const bindAddr = spec.bindAddr === undefined || spec.bindAddr === ""
        ? "127.0.0.1"
        : assertSafeHost("bindAddr", spec.bindAddr, true);
    const bindPort = spec.bindPort === undefined ? 0 : assertPort("bindPort", spec.bindPort, true);

    let targetHost: string | undefined;
    let targetPort: number | undefined;
    if (kind === "local" || kind === "remote") {
        if (typeof spec.targetHost !== "string" || !spec.targetHost.trim()) {
            throw new Error(`${kind} 模式必须提供 targetHost`);
        }
        targetHost = assertSafeHost("targetHost", spec.targetHost, false);
        targetPort = assertPort("targetPort", spec.targetPort, false);
    }

    let forwardId: string;
    if (spec.id !== undefined) {
        if (typeof spec.id !== "string" || !FORWARD_ID_RE.test(spec.id)) {
            throw new Error(`非法转发 ID（仅支持字母数字及 ._-）: ${JSON.stringify(spec.id)}`);
        }
        forwardId = spec.id;
    } else {
        forwardId = `fwd-${crypto.randomBytes(6).toString("hex")}`;
    }

    const timeoutMs = spec.timeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`非法 timeoutMs: ${String(spec.timeoutMs)}`);
    }

    return { kind, flag, bindAddr, bindPort, targetHost, targetPort, forwardId, timeoutMs };
}

/** 渲染为 OpenSSH `-L` / `-R` / `-D` 参数值（IPv6 自动加方括号） */
export function renderDynamicForwardSpec(norm: NormalizedForwardSpec, effectivePort = norm.bindPort): string {
    const bind = formatBindOrTargetAddr(norm.bindAddr);
    if (norm.kind === "dynamic") {
        return `${bind}:${effectivePort}`;
    }
    const target = formatBindOrTargetAddr(norm.targetHost!);
    return `${bind}:${effectivePort}:${target}:${norm.targetPort!}`;
}

export function parseMuxAllocatedPort(stdout: string, stderr: string): number | undefined {
    for (const text of [stdout, stderr]) {
        const alloc = text.match(/Allocated port (\d+)/i);
        if (alloc) {
            const p = Number(alloc[1]);
            if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
        }
        const bare = text.match(/^\s*(\d{1,5})\s*$/m);
        if (bare) {
            const p = Number(bare[1]);
            if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
        }
    }
    return undefined;
}

export function parseSubprocessRemotePort(line: string): number | undefined {
    const m = line.match(/Allocated port (\d+)(?:\s+for remote forward)?/i);
    if (!m) return undefined;
    const p = Number(m[1]);
    return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : undefined;
}

async function defaultAllocateLocalPort(bindAddr: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once("error", (err) => reject(new Error(`分配本地空闲端口失败 (${bindAddr}): ${err.message}`)));
        srv.listen(0, bindHostFor(bindAddr), () => {
            const addr = srv.address();
            const port = addr && typeof addr === "object" ? addr.port : 0;
            srv.close((closeErr) => {
                if (closeErr) reject(closeErr);
                else if (port < 1 || port > 65535) reject(new Error("系统返回无效的临时端口号"));
                else resolve(port);
            });
        });
    });
}

function defaultExecSsh(argv: string[], timeoutMs: number, logger: FilaxisLogger): Promise<ExecSshResult> {
    return new Promise<ExecSshResult>((resolve, reject) => {
        const child = spawn("ssh", argv, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env: openSshEnvironment(process.env, logger),
        });
        const outDec = new StringDecoder("utf-8");
        const errDec = new StringDecoder("utf-8");
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }, 500).unref();
        }, timeoutMs);

        child.stdout?.on("data", (d: Buffer) => { stdout += outDec.write(d); });
        child.stderr?.on("data", (d: Buffer) => { stderr += errDec.write(d); });
        child.once("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`启动 ssh 控制命令失败: ${err.message}`));
        });
        child.once("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stdout += outDec.end();
            stderr += errDec.end();
            resolve({ exitCode: code, stdout, stderr, timedOut });
        });
    });
}

interface BridgeConnection {
    socket: net.Socket;
    child: ChildProcess;
    stopping?: Promise<boolean>;
}

interface PendingForwardChild {
    child: ChildProcess;
    cancelStartup?: () => void;
    cancelled?: boolean;
    stopping?: Promise<CloseForwardResult>;
    unconfirmed?: ForwardInfo;
}

interface ManagedForwardEntry {
    info: ForwardInfo;
    norm: NormalizedForwardSpec;
    effectiveSpec: string;
    muxSocket?: string;
    child?: ChildProcess;
    bridgeServer?: net.Server;
    bridgeConns?: Set<BridgeConnection>;
    closing: boolean;
    inFlightClose?: Promise<CloseForwardResult>;
}

/** 单条 SSH 层的动态端口转发管理器（Mux 优先 + Subprocess 自动降级 + enterPipeline stdio TCP 桥） */
export class SshForwardManager {
    private readonly entries = new Map<string, ManagedForwardEntry>();
    private readonly pendingIds = new Set<string>();
    private readonly pendingChildren = new Map<string, PendingForwardChild>();
    private closedAll = false;
    private cachedBridgeTool?: BridgeTool;
    private readonly destArgs: string[];
    private readonly muxDestArgs: string[];
    private readonly connParams?: SshConnParams;
    private readonly layerName?: string;
    private readonly enterSteps: EnterStep[];
    private readonly execInLayer?: SshForwardManagerOptions["execInLayer"];
    private readonly log: FilaxisLogger;
    private readonly onForwardExit?: (info: ForwardInfo) => void;
    private readonly deps: Required<ForwardDeps>;

    constructor(opts: SshForwardManagerOptions) {
        this.destArgs = opts.destArgs;
        this.muxDestArgs = opts.muxDestArgs ?? opts.destArgs;
        this.connParams = opts.connParams;
        this.layerName = opts.layerName;
        this.enterSteps = opts.enterSteps ? [...opts.enterSteps] : [];
        this.execInLayer = opts.execInLayer;
        this.log = opts.logger ?? noopLogger;
        this.onForwardExit = opts.onForwardExit;

        const sshOpts = autonomousSshOpts(this.connParams);
        const defaultMuxControlPath = () => {
            const flags = muxFlagsFor(this.muxDestArgs, { sshOptions: sshOpts });
            const cp = flags.find((f) => f.startsWith("ControlPath="));
            return cp ? cp.slice("ControlPath=".length) : undefined;
        };

        this.deps = {
            execSsh: opts._deps?.execSsh ?? ((argv, ms) => defaultExecSsh(argv, ms, this.log)),
            spawnSsh: opts._deps?.spawnSsh ?? ((argv) => spawn("ssh", argv, {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                env: openSshEnvironment(process.env, this.log),
            })),
            spawnBridge: opts._deps?.spawnBridge ?? ((argv) => spawn("ssh", argv, {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                env: openSshEnvironment(process.env, this.log),
            })),
            allocateLocalPort: opts._deps?.allocateLocalPort ?? defaultAllocateLocalPort,
            muxControlPath: opts._deps?.muxControlPath ?? defaultMuxControlPath,
            stopGraceMs: opts._deps?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
            killWaitMs: opts._deps?.killWaitMs ?? DEFAULT_KILL_WAIT_MS,
        };
    }

    private async activeMuxSocket(): Promise<string | undefined> {
        const sock = this.deps.muxControlPath();
        if (!sock) return undefined;
        try {
            const check = await this.deps.execSsh(["-S", sock, "-O", "check", ...this.destArgs], 3_000);
            return !check.timedOut && check.exitCode === 0 ? sock : undefined;
        } catch {
            return undefined;
        }
    }

    async openForward(spec: OpenForwardSpec): Promise<ForwardInfo> {
        if (this.closedAll) {
            throw new Error("转发管理器已关闭，无法新建动态端口转发");
        }
        const norm = normalizeForwardSpec(spec);
        if (this.entries.has(norm.forwardId) || this.pendingIds.has(norm.forwardId) || this.pendingChildren.has(norm.forwardId)) {
            throw new Error(`转发 ID '${norm.forwardId}' 已存在或正在建立`);
        }
        this.pendingIds.add(norm.forwardId);
        try {
            if (this.enterSteps.length > 0) {
                return await this.openViaStdioBridge(norm);
            }
            const muxSock = await this.activeMuxSocket();
            if (this.closedAll) {
                throw new Error("转发管理器已关闭，无法新建动态端口转发");
            }
            if (muxSock) {
                return await this.openViaMux(norm, muxSock);
            }
            return await this.openViaSubprocess(norm);
        } finally {
            this.pendingIds.delete(norm.forwardId);
        }
    }

    private async openViaMux(norm: NormalizedForwardSpec, sock: string): Promise<ForwardInfo> {
        let requestPort = norm.bindPort;
        if (norm.bindPort === 0 && norm.kind !== "remote") {
            // OpenSSH `-O forward` 仅对 `-R ...:0:...` 回传动态端口；本地端口由本机分配以保精确 `-O cancel`
            requestPort = await this.deps.allocateLocalPort(norm.bindAddr);
        }
        const reqSpec = renderDynamicForwardSpec(norm, requestPort);
        const res = await this.deps.execSsh(
            ["-S", sock, "-O", "forward", norm.flag, reqSpec, ...this.destArgs],
            norm.timeoutMs,
        );
        if (res.timedOut) {
            const err = new Error(`Mux 动态端口转发超时 (${norm.timeoutMs}ms): ${norm.flag} ${reqSpec}`) as Error & { outcome: "unknown" };
            err.outcome = "unknown";
            throw err;
        }
        if (res.exitCode !== 0) {
            const detail = (res.stderr || res.stdout).trim();
            throw new Error(`Mux 动态端口转发失败 (exit=${res.exitCode}): ${detail || reqSpec}`);
        }

        let effectivePort = requestPort;
        if (effectivePort === 0) {
            const parsed = parseMuxAllocatedPort(res.stdout, res.stderr);
            if (!parsed) {
                throw new Error(
                    `Mux 动态端口转发未能解析远端分配端口（禁止返回 port=0）: stdout=${JSON.stringify(res.stdout.trim())} stderr=${JSON.stringify(res.stderr.trim())}`,
                );
            }
            effectivePort = parsed;
        }

        const effectiveSpec = renderDynamicForwardSpec(norm, effectivePort);
        if (this.closedAll) {
            await this.deps.execSsh(
                ["-S", sock, "-O", "cancel", norm.flag, effectiveSpec, ...this.destArgs],
                DEFAULT_MUX_CMD_TIMEOUT_MS,
            ).catch(() => undefined);
            throw new Error("转发管理器已关闭，已尝试取消在途转发");
        }
        const info: ForwardInfo = {
            forwardId: norm.forwardId,
            ...(this.layerName ? { layer: this.layerName } : {}),
            kind: norm.kind,
            bindAddr: norm.bindAddr,
            bindPort: effectivePort,
            ...(norm.targetHost !== undefined ? { targetHost: norm.targetHost } : {}),
            ...(norm.targetPort !== undefined ? { targetPort: norm.targetPort } : {}),
            transportMode: "mux",
            status: "active",
            createdAt: Date.now(),
        };
        this.entries.set(norm.forwardId, {
            info,
            norm,
            effectiveSpec,
            muxSocket: sock,
            closing: false,
        });
        return { ...info };
    }

    private async openViaSubprocess(norm: NormalizedForwardSpec): Promise<ForwardInfo> {
        let effectivePort = norm.bindPort;
        if (norm.bindPort === 0 && norm.kind !== "remote") {
            effectivePort = await this.deps.allocateLocalPort(norm.bindAddr);
        }
        if (this.closedAll) throw new Error("转发管理器已关闭");
        const effectiveSpec = renderDynamicForwardSpec(norm, effectivePort);
        const argv = [
            "-N", "-T", "-v",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ClearAllForwardings=no",
            "-o", "ControlPath=none",
            ...autonomousSshOpts(this.connParams),
            norm.flag, effectiveSpec,
            ...this.destArgs,
        ];
        const child = this.deps.spawnSsh(argv);
        const id = norm.forwardId;
        const pending: PendingForwardChild = { child };
        this.pendingChildren.set(id, pending);
        child.once("close", () => {
            if (this.pendingChildren.get(id) === pending) this.pendingChildren.delete(id);
        });

        let entry!: ManagedForwardEntry;
        let ready = false;
        let diagTail = "";
        let exitedAfterReady: { code: number | null } | undefined;

        try {
            await new Promise<void>((resolve, reject) => {
            let settled = false;
            const errDec = new StringDecoder("utf-8");
            let pendingLine = "";

            const cleanupStartup = () => {
                clearTimeout(timeoutTimer);
            };

            const failStartup = (message: string) => {
                if (settled) return;
                settled = true;
                cleanupStartup();
                reject(new Error(message));
            };

            const succeedStartup = () => {
                if (settled) return;
                settled = true;
                ready = true;
                cleanupStartup();
                resolve();
            };

            const handleStderrLine = (line: string) => {
                if (ready) return;
                if (norm.kind === "remote" && effectivePort === 0) {
                    const allocated = parseSubprocessRemotePort(line);
                    if (allocated) {
                        effectivePort = allocated;
                        succeedStartup();
                    }
                    return;
                }
                if (norm.kind === "remote") {
                    const confirmed = /^debug1: remote forward success for: listen (?:.*:)?(\d+), connect /i.exec(line);
                    if (confirmed && Number(confirmed[1]) === effectivePort) {
                        succeedStartup();
                    }
                    return;
                }
                // OpenSSH reaches the client loop after checking local binds with ExitOnForwardFailure.
                if (/^debug1: Entering interactive session\./.test(line)) {
                    succeedStartup();
                }
            };

            // stdout 持续排空，避免子进程缓冲区写满阻塞
            child.stdout?.on("data", () => undefined);
            child.stderr?.on("data", (chunk: Buffer | string) => {
                const text = typeof chunk === "string" ? chunk : errDec.write(chunk);
                diagTail = appendDiag(diagTail, text);
                if (ready) return;
                pendingLine += text;
                const lines = pendingLine.split(/\r?\n/);
                pendingLine = lines.pop() ?? "";
                for (const line of lines) {
                    handleStderrLine(line);
                    if (ready) break;
                }
            });

            child.once("error", (err) => {
                if (!ready) {
                    failStartup(`本地 ssh 转发进程启动失败: ${err.message}`);
                }
            });

            child.once("exit", (code) => {
                if (pendingLine && !ready) {
                    handleStderrLine(pendingLine);
                    pendingLine = "";
                }
                if (!ready) {
                    failStartup(
                        `动态端口转发建链失败 (ssh -N exit=${code ?? "signal"}): ${diagTail.trim() || effectiveSpec}`,
                    );
                    return;
                }
                if (entry) {
                    if (!entry.closing) {
                        entry.info.status = "exited";
                        entry.info.exitCode = code;
                        entry.info.lastError = diagTail.trim() || (code !== 0 ? `ssh -N 意外退出 (code=${code})` : "ssh -N 意外退出");
                        try { this.onForwardExit?.({ ...entry.info }); } catch { /* 回调异常不外溢 */ }
                    }
                } else {
                    exitedAfterReady = { code };
                }
            });

            const timeoutTimer = setTimeout(() => {
                failStartup(`动态端口转发启动超时 (${norm.timeoutMs}ms): ${norm.flag} ${effectiveSpec}${diagTail.trim() ? `\n${diagTail.trim()}` : ""}`);
            }, norm.timeoutMs);
            pending.cancelStartup = () => failStartup("转发建立已取消（管理器已关闭或收到关闭请求）");
            if (this.closedAll) pending.cancelStartup();
        });
            if (pending.cancelled || this.closedAll) throw new Error("转发建立已取消");
        } catch (error) {
            const result = await this.stopPendingForward(id, pending);
            if (result.status === "unknown") {
                pending.unconfirmed = {
                    forwardId: id, kind: norm.kind, bindAddr: norm.bindAddr, bindPort: effectivePort,
                    targetHost: norm.targetHost, targetPort: norm.targetPort,
                    transportMode: "subprocess", status: "unknown", createdAt: Date.now(),
                    pid: child.pid, lastError: result.detail,
                };
                throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
                    outcome: "unknown", forwardId: id,
                });
            }
            throw error;
        }
        this.pendingChildren.delete(id);

        const finalSpec = renderDynamicForwardSpec(norm, effectivePort);
        const info: ForwardInfo = {
            forwardId: norm.forwardId,
            ...(this.layerName ? { layer: this.layerName } : {}),
            kind: norm.kind,
            bindAddr: norm.bindAddr,
            bindPort: effectivePort,
            ...(norm.targetHost !== undefined ? { targetHost: norm.targetHost } : {}),
            ...(norm.targetPort !== undefined ? { targetPort: norm.targetPort } : {}),
            transportMode: "subprocess",
            status: "active",
            createdAt: Date.now(),
            ...(child.pid !== undefined ? { pid: child.pid } : {}),
        };
        entry = {
            info,
            norm,
            effectiveSpec: finalSpec,
            child,
            closing: false,
        };
        this.entries.set(norm.forwardId, entry);
        if (exitedAfterReady) {
            entry.info.status = "exited";
            entry.info.exitCode = exitedAfterReady.code;
            entry.info.lastError = diagTail.trim() || (exitedAfterReady.code !== 0 ? `ssh -N 意外退出 (code=${exitedAfterReady.code})` : "ssh -N 意外退出");
            try { this.onForwardExit?.({ ...entry.info }); } catch { /* 回调异常不外溢 */ }
            throw Object.assign(new Error(
                `动态端口转发建立后立即退出 (ssh -N exit=${exitedAfterReady.code ?? "signal"}): ${entry.info.lastError}`,
            ), { forwardId: norm.forwardId, exitCode: exitedAfterReady.code });
        }
        return { ...info };
    }

    private async probeBridgeTool(timeoutMs: number): Promise<BridgeTool> {
        if (this.cachedBridgeTool) return this.cachedBridgeTool;
        if (!this.execInLayer) {
            throw new Error("带 enterPipeline（如 --docker/--enter）的层缺少执行通道，无法探测内层 TCP 桥原语（socat/python3/python/node/nc）");
        }
        const probeCmd = "for t in socat python3 python node nc; do command -v \"$t\" >/dev/null 2>&1 && { printf '%s\\n' \"$t\"; exit 0; }; done; exit 127";
        const r = await this.execInLayer(probeCmd, { timeoutMs: Math.min(timeoutMs, 10_000) });
        const found = r.stdout.trim().split(/\r?\n/)[0]?.trim();
        if (r.exitCode !== 0 || (found !== "socat" && found !== "python3" && found !== "python" && found !== "node" && found !== "nc")) {
            throw new Error(
                `目标内层容器/环境未检测到可用的 TCP 桥接工具（需要 socat / python3 / python / node / nc 之一，probe exit=${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}）`,
            );
        }
        this.cachedBridgeTool = found;
        return found;
    }

    private async openViaStdioBridge(norm: NormalizedForwardSpec): Promise<ForwardInfo> {
        if (norm.kind !== "local") {
            throw new Error(
                `带 enterPipeline（如 --docker/--enter）的内层环境目前仅支持 -L 本地到内层的 TCP 穿透转发，不支持 -R/-D（防止静默落到外层宿主机）`,
            );
        }
        const tool = await this.probeBridgeTool(norm.timeoutMs);
        const innerCmd = buildInnerTcpBridgeCmd(tool, norm.targetHost!, norm.targetPort!);
        const rendered = renderEnterBridgeCommand(this.enterSteps, innerCmd);
        if (rendered.kind === "unreachable") {
            throw new Error(`无法建立穿层动态转发（${rendered.reason}［进入步骤：${rendered.step}］）`);
        }

        const sshOpts = autonomousSshOpts(this.connParams);
        const bridgeArgv = [
            "-T", "-o", "ClearAllForwardings=yes",
            ...sshOpts,
            ...muxFlagsFor(this.muxDestArgs, { sshOptions: sshOpts }),
            ...this.destArgs,
            "--",
            rendered.command,
        ];

        const server = net.createServer();
        const bridgeConns = new Set<BridgeConnection>();

        await new Promise<void>((resolve, reject) => {
            const onErr = (err: Error) => {
                server.removeListener("listening", onListening);
                reject(new Error(`穿层转发本地监听失败 (${norm.bindAddr}:${norm.bindPort}): ${err.message}`));
            };
            const onListening = () => {
                server.removeListener("error", onErr);
                resolve();
            };
            server.once("error", onErr);
            server.once("listening", onListening);
            server.listen(norm.bindPort, bindHostFor(norm.bindAddr));
        });

        const bound = server.address();
        const effectivePort = bound && typeof bound === "object" ? bound.port : 0;
        if (!effectivePort || effectivePort < 1 || effectivePort > 65535) {
            await new Promise<void>((r) => server.close(() => r()));
            throw new Error("穿层动态转发未能获取本地监听端口");
        }
        if (this.closedAll) {
            await new Promise<void>((r) => server.close(() => r()));
            throw new Error("转发管理器已关闭，已回收穿层转发监听");
        }

        const effectiveSpec = renderDynamicForwardSpec(norm, effectivePort);
        const info: ForwardInfo = {
            forwardId: norm.forwardId,
            ...(this.layerName ? { layer: this.layerName } : {}),
            kind: norm.kind,
            bindAddr: norm.bindAddr,
            bindPort: effectivePort,
            targetHost: norm.targetHost,
            targetPort: norm.targetPort,
            transportMode: "stdio-bridge",
            status: "active",
            createdAt: Date.now(),
        };
        const entry: ManagedForwardEntry = {
            info,
            norm,
            effectiveSpec,
            bridgeServer: server,
            bridgeConns,
            closing: false,
        };
        this.entries.set(norm.forwardId, entry);

        server.on("connection", (socket) => {
            if (entry.closing || this.closedAll) {
                socket.destroy();
                return;
            }
            let child: ChildProcess;
            try {
                child = this.deps.spawnBridge(bridgeArgv);
            } catch {
                socket.destroy();
                return;
            }
            const conn: BridgeConnection = { socket, child };
            bridgeConns.add(conn);

            let teardownStarted = false;
            const teardownConn = () => {
                if (!socket.destroyed) socket.destroy();
                if (!entry.closing && !teardownStarted && bridgeConns.has(conn)) {
                    teardownStarted = true;
                    void this.stopBridgeChild(entry, conn);
                }
            };

            socket.on("error", teardownConn);
            socket.once("close", teardownConn);
            child.once("error", teardownConn);
            child.once("close", () => {
                bridgeConns.delete(conn);
                teardownConn();
            });
            child.stdin?.on("error", teardownConn);
            child.stdout?.on("error", teardownConn);
            // 桥接子进程的 stderr 不是数据面（不进隧道），但也不能丢：内层连不上
            // 目标端口、桥工具启动失败等原因全写在这里。真机排查时连接只会「立刻
            // 断开、零报错」，死因只能手工复现 spawn 才看得见。留尾部一段，子进程
            // 没送出任何数据就退出时记日志并挂到转发记录上。
            let relayedBytes = 0;
            let stderrTail = "";
            child.stdout?.on("data", (d: Buffer) => { relayedBytes += d.length; });
            child.stderr?.on("data", (d: Buffer) => {
                stderrTail = (stderrTail + d.toString("utf-8")).slice(-2048);
            });
            child.stderr?.on("error", () => undefined);
            const bridgeDied = (code: number | null, signal: NodeJS.Signals | null): string => {
                const why = stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(" | ");
                return `穿层桥接子进程未送出数据即退出 (code=${code ?? signal})${why ? `: ${why}` : ""}`;
            };
            child.once("close", (code, signal) => {
                if (entry.closing || relayedBytes > 0) return;
                const failed = code !== 0 || signal !== null;
                if (code === 0 && signal === null && !stderrTail.trim()) {
                    // 客户端连上不发数据就断开也会走到这里，不当作故障
                    this.log.debug(`[filaxis] 转发 ${entry.info.forwardId} ${bridgeDied(code, signal)}`);
                    return;
                }
                entry.info.lastError = bridgeDied(code, signal);
                this.log[failed ? "warn" : "info"](`[filaxis] 转发 ${entry.info.forwardId} ${entry.info.lastError}`);
            });

            if (child.stdin) socket.pipe(child.stdin);
            if (child.stdout) child.stdout.pipe(socket);
        });

        server.on("error", (err) => {
            if (entry.closing) return;
            entry.info.status = "exited";
            entry.info.lastError = `穿层本地监听异常: ${err.message}`;
            for (const c of [...bridgeConns]) {
                try { c.socket.destroy(); } catch { /* ignore */ }
                if (c.child.exitCode === null && c.child.signalCode === null) {
                    try { c.child.kill("SIGTERM"); } catch { /* ignore */ }
                }
            }
            try { this.onForwardExit?.({ ...entry.info }); } catch { /* ignore */ }
        });

        return { ...info };
    }

    async closeForward(forwardId: string): Promise<CloseForwardResult> {
        const pending = this.pendingChildren.get(forwardId);
        if (pending) return this.stopPendingForward(forwardId, pending);
        const entry = this.entries.get(forwardId);
        if (!entry) {
            throw new Error(`转发 '${forwardId}' 不存在`);
        }
        if (entry.info.status === "stopped" || entry.info.status === "exited") {
            return { status: "already_closed", forwardId };
        }
        if (entry.inFlightClose) {
            return entry.inFlightClose;
        }
        const task = entry.info.transportMode === "mux"
            ? this.closeViaMux(entry)
            : entry.info.transportMode === "stdio-bridge"
                ? this.closeViaStdioBridge(entry)
                : this.closeViaSubprocess(entry);
        entry.inFlightClose = task.finally(() => { entry.inFlightClose = undefined; });
        return entry.inFlightClose;
    }

    private stopPendingForward(forwardId: string, pending: PendingForwardChild): Promise<CloseForwardResult> {
        if (pending.stopping) return pending.stopping;
        pending.cancelled = true;
        pending.cancelStartup?.();
        const child = pending.child;
        const stopped = child.pid === undefined ? Promise.resolve({ exited: true }) : this.terminateChildVerified(child);
        pending.stopping = stopped.then(({ exited }): CloseForwardResult => {
            if (!exited) {
                return { status: "unknown", forwardId, detail: "建立中的 ssh -N 进程未确认退出" };
            }
            if (this.pendingChildren.get(forwardId) === pending) this.pendingChildren.delete(forwardId);
            return { status: "stopped", forwardId };
        }).finally(() => { pending.stopping = undefined; });
        return pending.stopping;
    }

    private async terminateChildVerified(child: ChildProcess): Promise<{ exited: boolean; code: number | null }> {
        if (child.exitCode !== null || child.signalCode !== null) {
            return { exited: true, code: child.exitCode };
        }
        return new Promise<{ exited: boolean; code: number | null }>((resolve) => {
            let settled = false;
            let killTimer: ReturnType<typeof setTimeout> | null = null;
            let giveUpTimer: ReturnType<typeof setTimeout> | null = null;

            const finish = (ok: boolean, code: number | null) => {
                if (settled) return;
                settled = true;
                if (killTimer) clearTimeout(killTimer);
                if (giveUpTimer) clearTimeout(giveUpTimer);
                child.removeListener("exit", onExit);
                child.removeListener("close", onExit);
                resolve({ exited: ok, code });
            };
            const onExit = (code: number | null) => finish(true, code);
            child.once("exit", onExit);
            child.once("close", onExit);

            try {
                child.kill("SIGTERM");
            } catch {
                // 如果进程已结束则等待退出回调或直接查状态
            }
            if (settled) return;

            killTimer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    try { child.kill("SIGKILL"); } catch { /* ignore */ }
                }
                if (settled) return;
                giveUpTimer = setTimeout(() => {
                    finish(child.exitCode !== null || child.signalCode !== null, child.exitCode);
                }, this.deps.killWaitMs);
            }, this.deps.stopGraceMs);
        });
    }

    private stopBridgeChild(entry: ManagedForwardEntry, conn: BridgeConnection): Promise<boolean> {
        conn.stopping ??= this.terminateChildVerified(conn.child).then(({ exited }) => {
            if (exited) entry.bridgeConns?.delete(conn);
            return exited;
        }).finally(() => { conn.stopping = undefined; });
        return conn.stopping;
    }

    private async closeViaStdioBridge(entry: ManagedForwardEntry): Promise<CloseForwardResult> {
        const { forwardId } = entry.info;
        entry.closing = true;

        const srv = entry.bridgeServer;
        const serverClosed = new Promise<void>((resolve) => {
            if (!srv) return resolve();
            try { srv.close(() => resolve()); } catch { resolve(); }
        });

        const conns = [...(entry.bridgeConns ?? [])];
        for (const c of conns) {
            try { c.socket.destroy(); } catch { /* ignore */ }
        }
        const [results] = await Promise.all([
            Promise.all(conns.map((c) => this.stopBridgeChild(entry, c))),
            serverClosed,
        ]);
        if (results.every(Boolean)) {
            entry.info.status = "stopped";
            return { status: "stopped", forwardId };
        }
        entry.closing = false;
        entry.info.status = "unknown";
        entry.info.lastError = "部分穿层桥接子进程在 SIGTERM/SIGKILL 窗口内未确认退出";
        return { status: "unknown", forwardId, detail: entry.info.lastError };
    }

    private async closeViaMux(entry: ManagedForwardEntry): Promise<CloseForwardResult> {
        const { forwardId } = entry.info;
        try {
            const res = await this.deps.execSsh(
                ["-S", entry.muxSocket!, "-O", "cancel", entry.norm.flag, entry.effectiveSpec, ...this.destArgs],
                DEFAULT_MUX_CMD_TIMEOUT_MS,
            );
            if (!res.timedOut && res.exitCode === 0) {
                entry.info.status = "stopped";
                return { status: "stopped", forwardId };
            }
            const detail = (res.stderr || res.stdout).trim();
            const forwardAbsent = /^(?:mux_client_forward: )?(?:forwarding request failed: )?(?:port not forwarded|forward(?:ing)? not (?:found|active)|no such forward(?:ing)?)[.!]?$/im.test(detail);
            if (!res.timedOut && forwardAbsent) {
                entry.info.status = "stopped";
                return { status: "already_closed", forwardId, ...(detail ? { detail } : {}) };
            }
            entry.info.status = "unknown";
            entry.info.lastError = detail || (res.timedOut ? "mux -O cancel 超时" : `mux -O cancel 退出码=${res.exitCode}`);
            return { status: "unknown", forwardId, detail: entry.info.lastError };
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            entry.info.status = "unknown";
            entry.info.lastError = detail;
            return { status: "unknown", forwardId, detail };
        }
    }

    private async closeViaSubprocess(entry: ManagedForwardEntry): Promise<CloseForwardResult> {
        const { forwardId } = entry.info;
        const child = entry.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) {
            entry.info.status = "exited";
            return { status: "already_closed", forwardId };
        }

        entry.closing = true;
        const exited = await this.terminateChildVerified(child);
        if (exited.exited) {
            entry.info.status = "stopped";
            entry.info.exitCode = exited.code;
            return { status: "stopped", forwardId };
        }
        entry.closing = false;
        entry.info.status = "unknown";
        entry.info.lastError = "托管 ssh -N 进程在 SIGTERM/SIGKILL 窗口内未确认退出";
        return { status: "unknown", forwardId, detail: entry.info.lastError };
    }

    listForwards(): ForwardInfo[] {
        const forwards = [...this.entries.values()].map((e) => ({ ...e.info }));
        for (const { unconfirmed } of this.pendingChildren.values()) {
            if (unconfirmed) forwards.push({ ...unconfirmed });
        }
        return forwards;
    }

    hasForward(forwardId: string): boolean {
        return this.entries.has(forwardId) || this.pendingChildren.has(forwardId);
    }

    async closeAll(): Promise<CloseForwardResult[]> {
        this.closedAll = true;
        const targets = new Set(this.pendingChildren.keys());
        for (const entry of this.entries.values()) {
            if (entry.info.status === "active" || entry.info.status === "unknown") targets.add(entry.info.forwardId);
        }
        return Promise.all([...targets].map((id) => this.closeForward(id)));
    }
}
