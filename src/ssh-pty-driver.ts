/**
 * ssh-pty-driver.ts — SSH Transport driver（PTY 层模型 + 双通道 exec）
 *
 * 净室平移自 个人Agent项目 `原内部模块`
 * ，按 REQ-0001 OSS 化改造：
 * - exec 双通道（FEAT-03）：缺省 channel:"exec" = 独立非 PTY ssh 进程
 *   （stdout/stderr 物理分离 + nonce marker effectiveUser + enterSteps
 *   stdin 管道重放——零嵌套引用）；channel:"pty" = 层内 PTY marker 协议
 *   （继承层内交互状态；stderr 混流为终端语义）
 * - 不可直达层判定：enterSteps 非「… shell」形态 → exec 通道显式拒绝并指引 pty
 * - 剥 上游安全闸/TmuxFileSystem/ProcessManager/FsProxy；
 *   fs 经 exec 通道实现（ExecFileSystem，方言适配接线）
 * - 会话族委托 RemoteSessionManager（nohup 双文件 + 终态三态）
 * - logger 注入；自动重连（3 次退避）/层状态机/退化哨兵全平移
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as crypto from "node:crypto";
import type {
    RuntimeDriver, FileSystemDriver, FileEntry, ExecOptions, ExecResult, RuntimeDescriptor,
} from "./driver.js";
import { LineAssembler } from "./session-buffer.js";
import type {
    SessionStartOptions, SessionHandleInfo, WatchOptions, ReadLogOptions,
} from "./session-types.js";
import {
    autonomousSshOpts, SSH_INPUT_WAIT_RE, enterStepsOf, hopLabel, rootSshSpawnArgs,
    sshArgsFor, renderExecChannel, muxFlagsFor, assertNoLikelyTypoKeys, envPrefixOf, ENV_NAME_RE, type SshConnParams, type SshHop, ENTER_ALIAS_KEYS,
} from "./ssh-helpers.js";
import { RemoteSessionManager } from "./remote-session-manager.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\r(?!\n)/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

/** 单条物理 PTY 链：进程 + 行流 + 握手状态机 + marker 协议（串行锁）+ 退化哨兵 */
class PtyLink {
    proc?: ChildProcessWithoutNullStreams;
    private fallbackNonce = crypto.randomBytes(16).toString("hex");
    private fallbackSteps = new Set<string>();
    private assembler = new LineAssembler();
    private lineBuffer: string[] = [];
    private ready = false;
    private readyWaiter?: () => void;
    private readyRejecter?: (e: Error) => void;
    private rawArrived = false;
    private firstOutWaiter?: () => void;
    private chain: Promise<unknown> = Promise.resolve();
    private handshakeTail: string[] = [];
    /** 最近一次握手步顺带实测的登录身份（PTYRDY_..._$(id -un)——冷启动锦囊） */
    handshakeUser?: string;
    private handshakeWhat = "";
    private pendingExitFailure?: Error;
    onUnexpectedExit?: () => void;
    onLayerFallback?: (evidence: string) => void;
    fallbackSeen?: string;

    /** 进入步骤退出哨兵（本物理链独有 nonce + 步骤号；$$ 展开 PID 防回显伪造——
     *  POSIX 全 shell 通吃：$RANDOM 是 bash 特性，dash/busybox ash 下展开为空致哨兵
     *  形态崩坏（CI 实锤：PTY 层 enter sh 握手 20s 超时）） */
    registerFallbackStep(): string {
        const step = String(this.fallbackSteps.size);
        this.fallbackSteps.add(step);
        return `; echo __FILAXIS_FB_${this.fallbackNonce}_${step}_$?_$$`;
    }

    attach(args: string[]): void {
        this.fallbackNonce = crypto.randomBytes(16).toString("hex");
        this.fallbackSteps.clear();
        this.fallbackSeen = undefined;
        this.proc = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
        // 双流各自解码器（Hydrogen R5 #4）：跨块多字节 UTF-8 撕裂——两管道交替喂
        // 同一 decoder 会混流撕字，必须 per-stream
        const outDec = new StringDecoder("utf-8");
        const errDec = new StringDecoder("utf-8");
        this.proc.stdout.on("data", (d: Buffer) => this.onData(outDec.write(d)));
        this.proc.stderr.on("data", (d: Buffer) => this.onData(errDec.write(d)));
        this.proc.on("exit", (code) => {
            if (!this.ready) {
                const err = new Error(this.egressError(`ssh 进程建链期间退出（code=${code}）: ${this.handshakeWhat}`));
                if (this.readyRejecter) this.readyRejecter(err);
                else this.pendingExitFailure = err;
            }
            this.onUnexpectedExit?.();
        });
    }

    send(s: string): void { this.proc?.stdin.write(s); }

    /** 串行执行（PTY 单通道） */
    queue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.then(fn);
        this.chain = run.catch(() => undefined);
        return run;
    }

    /** 建链失败消息：ssh 原始输出原文直交调用方（网络/认证/交互由人/模型自行判断） */
    private egressError(reason: string): string {
        const raw = this.handshakeTail.join("\n").trim();
        return raw ? `${reason}\n[ssh 原始输出·直交]\n${raw.slice(-1500)}` : `${reason}\n[ssh 原始输出·空（对端无任何回显）]`;
    }

    handshakeEvidence(): string {
        const raw = this.handshakeTail.join("\n").trim();
        return raw ? raw.slice(-1500) : "（无原始输出）";
    }

    /** 层切换握手：stty 三防（-ixon 禁流控防 0x13 冻结 / cols 500 防截断 / -echo 关回显）→ 等 PTYRDY */
    async handshake(what: string): Promise<void> {
        this.ready = false;
        this.handshakeTail = [];
        this.handshakeWhat = what;
        this.fallbackSeen = undefined;
        if (!this.pendingExitFailure) await this.waitQuiet();
        // 握手行顺带身份探测（冷启动锦囊：省一次独立 execChannel("id -un")——
        // Windows 下那次 exec 是第二次完整 SSH 握手，建层耗时近半在此）
        this.send("stty -echo -ixon cols 500 rows 50; export PS1= PS2=; echo PTYRDY_$$_$(id -un 2>/dev/null)\n");
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(this.egressError(`PTYRDY 握手超时（20s）: ${what}`))), 20_000);
                this.readyWaiter = () => { clearTimeout(timer); resolve(); };
                this.readyRejecter = (e) => { clearTimeout(timer); reject(e); };
                if (this.pendingExitFailure) {
                    const e = this.pendingExitFailure;
                    this.pendingExitFailure = undefined;
                    this.readyRejecter(e);
                }
            });
        } finally {
            this.readyWaiter = undefined;
            this.readyRejecter = undefined;
        }
        this.lineBuffer = [];
        this.ready = true;
    }

    /**
     * pty 通道 marker 协议 exec（层内交互状态语义；四阶段 temporal isolation）：
     *
     * RUNNING → INTERRUPTING → DRAINING → IDLE（GPT 第四季定调 + Gemini 手法 2 实证）：
     * - 调用方 Promise 与 PTY 占有权**分离**：超时/abort 只归还调用方（reject + outcome:unknown），
     *   PTY 锁不释放——转 DRAINING 等「自己 nonce 的可信终态」（真实 $? 行或 ^C trap 130 行，
     *   nonce 完整匹配防输出伪造）才 IDLE 解锁。
     * - DRAINING 超时（5s，shell 卡死/断链）→ kill() 走三层退避自动重连重建——
     *   超时只代表调用方不再等待，不代表 PTY 已可复用；不可确认即销毁重建，绝不定时强行复用。
     * 不变量：当前命令终态未确认前，同一条 PTY 不得交给下一条命令。
     */
    async execMarker(command: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<ExecResult> {
        if (!this.ready) throw new Error("PTY 未就绪（层切换中）");
        // timeoutMs 守卫（Hydrogen R9 #4）：0/负/NaN 曾静默禁用或立即触发
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new Error(`timeoutMs 非法（${timeoutMs}）——须为正整数毫秒`);
        }
        const marker = `__FX_M_${crypto.randomBytes(4).toString("hex")}`;
        // 多行大括号换行隔离（Hydrogen R8 #1/#4，当前 shell）：①单行 `{ cmd; }` 下
        //   命令尾注释 `ls # x` 把 `; } 2>&1; echo marker` 全部注释掉 → shell 挂等
        //   闭合 `}` 到 120s 超时+整链销毁重建；②hasRedirect 字面量误判曾跳过包裹
        //   ——总是包裹。子 shell 会断 cd 状态保持（PTY 层内语义契约）故用当前 shell
        const cmdLine = `{ 
${command}
} 2>&1`;
        // trap 用后即清（R8 #1）：残留 INT trap 会吞掉后续交互的 ^C 语义
        const wrapped = `trap 'echo \"${marker}_130_$(id -un)\"' INT; ${cmdLine}; __fx_ec=$?; trap - INT; echo "${marker}_\${__fx_ec}_$(id -un)"`;

        // 调用方 Promise（超时/abort 即归）——与 PTY 占有权周期解耦
        const callerP = new Promise<ExecResult>((resolve, reject) => {
            void this.queue(() => this.markerCycle(marker, wrapped, command, timeoutMs, abortSignal, { resolve, reject }))
                .catch(() => undefined); // 周期异常由周期内处理（kill 兜底）
        });
        return callerP;
    }

    /**
     * 单命令完整周期（RUNNING→(INTERRUPTING)→DRAINING→IDLE）。
     * resolve 时机=终态确认（IDLE）；caller 已被通知（超时/abort）时同 marker 只作 drain 确认。
     */
    private markerCycle(
        marker: string,
        wrapped: string,
        command: string,
        timeoutMs: number,
        abortSignal: AbortSignal | undefined,
        caller: { resolve: (r: ExecResult) => void; reject: (e: unknown) => void },
    ): Promise<void> {
        return new Promise<void>((cycleDone) => {
            let notified = false; // 调用方已归（超时/abort）——INTERRUPTING 起点标志
            let drained = false; // DRAINING 兜底定时器已布
            this.lineBuffer = [];
            const markerRe = new RegExp(`${marker}_(\\d+)(?:_(\\S+))?`);

            const notify = (fn: () => void) => { if (!notified) { notified = true; fn(); } };
            const cleanupAbort = () => abortSignal?.removeEventListener("abort", onAbort);
            const enterDraining = () => {
                if (drained) return;
                drained = true;
                // DRAINING 兜底：等不到可信终态=shell 卡死/断链——销毁重建（自动重连）
                deadline = setTimeout(() => {
                    clearInterval(poll);
                    cleanupAbort();
                    this.kill(); // 触发 onUnexpectedExit → 三层退避重连
                    cycleDone();
                }, 5000);
            };
            let deadline: ReturnType<typeof setTimeout> | null = null;
            const onAbort = () => {
                if (notified) return;
                this.send("\x03");
                notify(() => {
                    const e = new DOMException(
                        `SshPty exec aborted by AbortSignal（已发 ^C，远端终态未核实——outcome=unknown）`,
                        "AbortError",
                    ) as DOMException & { outcome: "unknown" };
                    e.outcome = "unknown";
                    caller.reject(e);
                });
                enterDraining();
            };
            abortSignal?.addEventListener("abort", onAbort, { once: true });
            const timer = setTimeout(() => {
                if (notified) return;
                this.send("\x03"); // INTERRUPTING：超时先杀远端前台任务再归调用方
                notify(() => {
                    const e = new Error(`SshPty exec 超时（${timeoutMs}ms，已发 ^C，远端终态未核实——outcome=unknown）: ${command.slice(0, 60)}`) as Error & { outcome: "unknown" };
                    e.outcome = "unknown";
                    caller.reject(e);
                });
                enterDraining();
            }, timeoutMs);

            const poll = setInterval(() => {
                const buf = this.lineBuffer;
                for (let i = 0; i < buf.length; i++) {
                    const m = buf[i]!.match(markerRe);
                    if (m) {
                        const prefix = m.index ? buf[i]!.slice(0, m.index) : "";
                        this.lineBuffer = buf.slice(i + 1);
                        clearInterval(poll);
                        clearTimeout(timer);
                        if (deadline) clearTimeout(deadline);
                        cleanupAbort();
                        if (!notified) {
                            // RUNNING 正常终态：唯一可信 resolve（nonce 完整匹配 + 可解析 + 尾位）
                            const out = [...buf.slice(0, i), ...(prefix ? [prefix] : [])].join("\n");
                            notify(() => caller.resolve({
                                stdout: out, stderr: "", exitCode: parseInt(m[1]!, 10), effectiveUser: m[2],
                            }));
                        }
                        // 已通知（超时/abort）→ 本 marker 行即可信终态确认 → IDLE
                        cycleDone();
                        return;
                    }
                }
                // 断链感知（Gemini Hydrogen 审查 #1）：ready 翻 false=进程退出/kill 已
                // 触发重连——marker 永不再来，不再空等 timeoutMs+DRAINING 兜底 5s
                if (!this.ready) {
                    clearInterval(poll);
                    clearTimeout(timer);
                    if (deadline) clearTimeout(deadline);
                    cleanupAbort();
                    notify(() => {
                        const e = new Error(`PTY 链断开（执行期断链——远端终态未核实，outcome=unknown）: ${command.slice(0, 60)}`) as Error & { outcome: "unknown" };
                        e.outcome = "unknown";
                        caller.reject(e);
                    });
                    cycleDone(); // 链已由 onUnexpectedExit 重建路径接管——不 enterDraining
                }
            }, 25);

            this.send(`${wrapped}\n`);
        });
    }

    kill(): void {
        this.proc?.kill();
        this.proc = undefined;
        this.ready = false;
    }

    private async waitQuiet(): Promise<void> {
        const firstOut = new Promise<void>((resolve) => {
            if (this.rawArrived) resolve();
            else this.firstOutWaiter = resolve;
        });
        await Promise.race([firstOut, new Promise((r) => setTimeout(r, 8000))]);
        await new Promise((r) => setTimeout(r, 600));
    }

    private onData(text: string): void {
        if (this.firstOutWaiter) { this.firstOutWaiter(); this.firstOutWaiter = undefined; }
        this.rawArrived = true;
        for (const line of this.assembler.feed(stripAnsi(text))) {
            const fb = [...line.matchAll(/__FILAXIS_FB_([a-f0-9]{32})_(\d+)_(\d+)_(\d+)(?!\w)/g)]
                .find((m) => m[1] === this.fallbackNonce && this.fallbackSteps.has(m[2]!));
            if (fb) {
                this.fallbackSeen = line.trim().slice(0, 200);
                if (this.ready) this.onLayerFallback?.(this.fallbackSeen);
            }
            if (!this.ready) {
                // 非行首锚定（容忍与提示符粘连）；字面回显的字面串不含数字与真实用户名，安全
                // PTYRDY_$$_ 展开值（$$=PID，POSIX 全 shell——$RANDOM 系 bash 特性）+ 顺带
                // id -un（冷启动锦囊：握手即身份，省一整次独立 ssh 握手）
                const m = line.match(/PTYRDY_(\d+)(?:_([A-Za-z0-9._-]+))?/);
                if (m) {
                    if (m[2]) this.handshakeUser = m[2]; // 本握手步（hop/enter/终层）的登录身份
                    this.readyWaiter?.();
                    this.readyWaiter = undefined;
                    continue;
                }
                if (line.trim()) {
                    this.handshakeTail.push(line.length > 200 ? line.slice(0, 200) + "…" : line);
                    if (this.handshakeTail.length > 30) this.handshakeTail.shift();
                }
                if (SSH_INPUT_WAIT_RE.test(line)) {
                    this.readyRejecter?.(new Error(this.egressError(`建链卡在等待输入（交互提示）: ${this.handshakeWhat}`)));
                }
                continue;
            }
            this.lineBuffer.push(line);
        }
        // 半行检测（Hydrogen R4 #1）：OpenSSH 的 password:/passphrase:/yes/no 提示
        // **末尾无换行**（光标停同行等输入）——只测切出的完整行=提示永远滞留
        // pending、干等 20s 握手超时。对未成行缓冲同样检测，立即快速失败
        if (SSH_INPUT_WAIT_RE.test(this.assembler.peekPending())) {
            this.readyRejecter?.(new Error(this.egressError(`建链卡在等待输入（交互提示·半行）: ${this.handshakeWhat}`)));
        }
    }
}

/** 层状态机（净室平移源语义）：connecting → active → idle → dead / degraded（退化） */
export type LayerState = "connecting" | "active" | "idle" | "degraded" | "dead";
export const LAYER_IDLE_THRESHOLD_MS = 10_000;

export function resolveLayerState(
    d: { alive: boolean; reconnecting?: boolean; execInFlight?: boolean; lastActivityAt?: number; shellGone?: string },
    now: number = Date.now(),
): LayerState {
    if (!d.alive) return "dead";
    if (d.shellGone) return "degraded";
    if (d.reconnecting) return "connecting";
    if (d.execInFlight) return "active";
    if (d.lastActivityAt && now - d.lastActivityAt >= LAYER_IDLE_THRESHOLD_MS) return "idle";
    return d.lastActivityAt ? "active" : "connecting";
}

export interface SshPtyDriverOptions {
    logger?: FilaxisLogger;
}

/** SSH Transport driver：每层一条独立多跳 PTY + 双通道 exec + 远端会话/文件 */
export class SshPtyDriver implements RuntimeDriver {
    readonly descriptor: RuntimeDescriptor;
    readonly fs: FileSystemDriver;
    readonly sessions: RemoteSessionManager;

    private link: PtyLink = new PtyLink();
    private alive = true;
    effectiveUser?: string;
    layerShellGone?: string;
    layerState: LayerState = "connecting";
    lastActivityAt = 0;
    execInFlight = false;
    reconnecting = false;
    private reconnectAttempts = 0;
    private readonly log: FilaxisLogger;

    private static readonly MAX_RECONNECT = 3;
    private static readonly RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000];

    constructor(descriptor: RuntimeDescriptor, opts: SshPtyDriverOptions = {}) {
        // 拼错键防线（第十二季用户警示）：connParam/enterPipelines 等疑似拼写变体
        // 拒绝建层——静默吞掉拼错键=层路径悄悄降级（enter 漏建=裸宿主机层，写错机器）
        assertNoLikelyTypoKeys(descriptor.config as Record<string, unknown> | undefined, "ssh 层配置");
        this.descriptor = descriptor;
        this.log = opts.logger ?? noopLogger;
        const self = this;
        const fsExec = async (cmd: string) => self.execChannel(cmd, undefined);
        const statOf = async (p: string) => {
            const r = await fsExec(`stat -c '%s %Y' ${q(p)} 2>/dev/null || stat -f '%z %m' ${q(p)} 2>/dev/null || true`);
            const m = r.stdout.trim().match(/^(\d+)\s+(\d+)$/);
            return m ? { size: parseInt(m[1]!, 10), mtimeMs: parseInt(m[2]!, 10) * 1000 } : null;
        };
        this.fs = {
            async readFile(p) {
                // 远端 b64 直出+本地解码（Hydrogen R4 #2）：曾远端 | base64 -d——①BSD 的
                // base64 无 -d（-D）②exitCode 不查（文件不存在静默返回空串=契约违背，
                // runBatch 的 read 步骤误报 ok）③解码输出经 stdout UTF-8 拼接易损坏
                const r = await fsExec(`base64 ${q(p)} 2>/dev/null`);
                if (r.exitCode !== 0) throw new Error(`readFile 失败（exit=${r.exitCode}）: ${p}`);
                return Buffer.from(r.stdout.replace(/[^A-Za-z0-9+/=]/g, ""), "base64").toString("utf-8");
            },
            async writeFile(p, content) {
                const b64 = Buffer.from(content, "utf-8").toString("base64");
                const r = await fsExec(`printf %s ${q(b64)} | base64 -d > ${q(p)}`);
                if (r.exitCode !== 0) throw new Error(`writeFile 失败（exit=${r.exitCode}）: ${p}`);
            },
            async exists(p) {
                const r = await fsExec(`test -e ${q(p)} && echo Y || echo N`);
                return r.stdout.trim() === "Y";
            },
            stat: statOf,
            async readdir(p): Promise<FileEntry[]> {
                const r = await fsExec(`command ls -1A ${q(p)} 2>/dev/null || true`); // command 绕 alias（Hydrogen R4 #6）
                const names = r.stdout.split("\n").filter(Boolean);
                return Promise.all(names.map(async (name) => {
                    const full = `${p.replace(/\/$/, "")}/${name}`;
                    const d = await fsExec(`test -d ${q(full)} && echo Y || echo N`);
                    const st = await statOf(full);
                    return { name, isDirectory: d.stdout.trim() === "Y", size: st?.size, mtime: st?.mtimeMs };
                }));
            },
            async rm(p, options) {
                const r = await fsExec(`rm ${options?.recursive ? "-r " : ""}${options?.force ? "-f " : ""}${q(p)}`);
                if (r.exitCode !== 0) throw new Error(`rm 失败（exit=${r.exitCode}）: ${p}`);
            },
            async mkdir(p, options) {
                const r = await fsExec(`mkdir ${options?.recursive ? "-p " : ""}${q(p)}`);
                if (r.exitCode !== 0) throw new Error(`mkdir 失败（exit=${r.exitCode}）: ${p}`);
            },
        };
        this.sessions = new RemoteSessionManager({ exec: (cmd) => this.exec(cmd), logger: this.log });
        this.bindLink();
    }

    currentState(): LayerState {
        return resolveLayerState({
            alive: this.alive, reconnecting: this.reconnecting, execInFlight: this.execInFlight,
            lastActivityAt: this.lastActivityAt, shellGone: this.layerShellGone,
        });
    }

    /** 建链：root PTY + 逐跳登录（sshHops）+ enterSteps 有序管线 + cwd 恢复 + 身份探测 */
    async init(): Promise<void> {
        const target = this.descriptor.target ?? "";
        if (!target) throw new Error("SshPtyDriver 需要 descriptor.target（user@host 或 ssh config 别名）");
        const hops: SshHop[] = Array.isArray(this.descriptor.config?.sshHops) ? (this.descriptor.config.sshHops as SshHop[]) : [];
        const enterSteps = enterStepsOf(this.descriptor.config as Record<string, unknown> | undefined);
        const connParams = this.descriptor.config?.connParams as SshConnParams | undefined;
        const rootHop: SshHop = connParams ? { host: target, conn: connParams } : target;

        this.layerShellGone = undefined;
        this.link.onLayerFallback = (evidence) => {
            this.layerShellGone = evidence;
            this.layerState = "degraded";
            this.log.warn(`[SshPty] 内层 shell 已退出，层退化：${evidence}——连接仍在但已非本层环境`);
        };

        this.link.attach(rootSshSpawnArgs(sshArgsFor(rootHop), connParams));
        await this.link.handshake(`ssh ${hopLabel(rootHop)}`);
        for (const hop of hops) {
            const { hopSshCommand } = await import("./ssh-helpers.js");
            this.link.send(`${hopSshCommand(hop)}${this.link.registerFallbackStep()}\n`);
            try {
                await this.link.handshake(`ssh ${hopLabel(hop)}`);
            } catch (err) {
                this.link.kill(); // 失败回收链（报告 #2：残留 ssh 挂事件循环）
                throw err;
            }
            this.assertNotFallenBack(`ssh ${hopLabel(hop)}`);
        }
        for (const step of enterSteps) {
            this.link.send(`${step.cmd}${this.link.registerFallbackStep()}\n`);
            try {
                await this.link.handshake(`enter: ${step.cmd.slice(0, 40)}`);
            } catch (err) {
                this.link.kill();
                throw err;
            }
            this.assertNotFallenBack(`enter: ${step.cmd.slice(0, 40)}`);
        }
        if (this.descriptor.cwd) {
            // best-effort 恢复（重连时目录可能已被删——不阻断建链）；引号安全化
            // （Astra 五轮 P1：JSON.stringify 双引号不挡 $()/反引号注入）。exec 通道
            // 每条命令另行 fail-closed 拼装 cwd（renderExecChannel）。PTY 会话目录恢复
            // 必须走 execMarker（Hydrogen R5 #2）：曾误调 execChannel——独立一次性子进程
            // cd 即失效（PTY 目录从未切换），且多跳/交互 enter 层上 execChannel 会抛
            // 「不可直达」直接炸掉整层 init
            try {
                await this.link.execMarker(`cd ${q(this.descriptor.cwd)}`, 10_000);
            } catch { /* 目录可能已删——best-effort 语义保留（exec 通道每条命令另行 fail-closed） */ }
        }
        // 登录身份：握手已顺带实测（冷启动锦囊：省一次独立 ssh 握手——建层耗时近半）；
        // 缺席（旧握手形态/极旧对端）时静默跳过——绝不回退独立 exec（回退即冷启动退化）
        if (this.link.handshakeUser) this.effectiveUser = this.link.handshakeUser;
        this.layerState = "active";
        this.lastActivityAt = Date.now();
    }

    private assertNotFallenBack(what: string): void {
        if (this.link.fallbackSeen) {
            throw new Error(`层进入命令未驻留（${what}）——命令执行后立即退出，目标可能不存在或命令有误\n[哨兵证据] ${this.link.fallbackSeen}\n[原始输出·直交]\n${this.link.handshakeEvidence()}`);
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnecting || !this.alive) return;
        this.reconnecting = true;
        const attempt = () => {
            if (!this.alive) { this.reconnecting = false; return; }
            if (this.reconnectAttempts >= SshPtyDriver.MAX_RECONNECT) {
                this.reconnecting = false;
                this.layerState = "dead";
                return;
            }
            this.reconnectAttempts++;
            const delay = SshPtyDriver.RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts - 1, SshPtyDriver.RECONNECT_DELAYS_MS.length - 1)]!;
            const timer = setTimeout(() => {
                void (async () => {
                    try {
                        this.link = new PtyLink();
                        this.bindLink();
                        await this.init();
                        this.reconnecting = false;
                        this.reconnectAttempts = 0;
                        this.lastActivityAt = Date.now();
                        this.layerState = "active";
                    } catch {
                        attempt();
                    }
                })();
            }, delay);
            timer.unref?.();
        };
        attempt();
    }

    private bindLink(): void {
        this.link.onUnexpectedExit = () => {
            if (this.alive && !this.reconnecting) {
                this.layerState = "connecting";
                this.scheduleReconnect();
            }
        };
    }

    /** 派生 ssh 子层（独立连接）：本层路径为前缀，enter 管线显式清空 */
    async pushChild(hop: SshHop): Promise<SshPtyDriver> {
        const myHops: SshHop[] = Array.isArray(this.descriptor.config?.sshHops) ? (this.descriptor.config.sshHops as SshHop[]) : [];
        const child = new SshPtyDriver({
            driver: "ssh", target: this.descriptor.target,
            config: this.deriveConfig({ sshHops: [...myHops, hop] }),
        }, { logger: this.log });
        await child.init();
        return child;
    }

    /** 派生配置时清除全部 enter 族别名（Hydrogen R9 #2）：只清三个键曾漏其余
     *  七个别名——父层容器进入命令残留在新主机上意外重放 */
    private deriveConfig(extra: Record<string, unknown>): Record<string, unknown> {
        // 先清后并：extra 里的 enterPipeline 是派生层的新语义——清除必须在合并前
        // （曾先并后清把新管线也抹掉=layerInto 派生零 enter 步）
        const base: Record<string, unknown> = { ...this.descriptor.config };
        for (const k of ENTER_ALIAS_KEYS) delete base[k];
        return { ...base, ...extra };
    }

    /** 派生组合层（docker-in-ssh 等）：父层管线全量继承再追加本步 */
    async pushInto(enterCmd: string, enterLabel: string): Promise<SshPtyDriver> {
        const myHops: SshHop[] = Array.isArray(this.descriptor.config?.sshHops) ? (this.descriptor.config.sshHops as SshHop[]) : [];
        const enterPipeline = [...enterStepsOf(this.descriptor.config as Record<string, unknown> | undefined), { cmd: enterCmd, label: enterLabel }];
        const child = new SshPtyDriver({
            driver: "ssh", target: this.descriptor.target,
            config: this.deriveConfig({ sshHops: myHops, enterPipeline }),
        }, { logger: this.log });
        await child.init();
        return child;
    }

    async exit(): Promise<void> {
        if (!this.alive) return;
        this.alive = false;
        this.reconnecting = false;
        this.layerState = "dead";
        this.link.kill();
    }

    async destroy(): Promise<void> { await this.exit(); }

    async getCwd(): Promise<string> { return (await this.exec("pwd")).stdout.trim(); }

    /** 读远端环境变量。旧形态 `printf %s "\\$KEY"` 的 \$ 转义把变量展开杀了——
     *  永远返回字面 `$KEY`（GPT Astra 十轮 #2 实锤）。printenv 语义：变量不存在
     *  exit 1 → undefined；值剥单个尾换行（多行值末行换行不保真——注释声明）。 */
    async getEnv(key: string): Promise<string | undefined> {
        if (!ENV_NAME_RE.test(key)) throw new Error(`非法环境变量名: ${key}`);
        const r = await this.exec(`printenv ${key}`);
        if (r.exitCode !== 0) return undefined;
        return r.stdout.replace(/\r?\n$/, "");
    }

    /** 双通道 exec 分发（FEAT-03） */
    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
        if (!this.alive) throw new Error("层已退出");
        if (this.layerShellGone) throw new Error(`层已退化：内层 shell 已退出（${this.layerShellGone.slice(0, 60)}）——连接仍在但已非本层环境`);
        if (this.reconnecting) throw new Error("连接意外断开，自动重连中——请稍后重试");
        if (options?.channel === "pty") {
            // env 显式拒绝（十轮自挖）：PTY 键入回显会混入输出捕获——exec 通道
            // （stdinCmd export 前缀）才是 env 的生效通道
            if (options.env && Object.keys(options.env).length) {
                throw new Error('channel:"pty" 不支持 env（键入回显会混入输出——终端物理语义）；请用缺省 exec 通道');
            }
            this.execInFlight = true;
            try {
                const r = await this.link.execMarker(command, options?.timeoutMs ?? 120_000, options?.signal);
                if (r.effectiveUser) this.effectiveUser = r.effectiveUser;
                return r;
            } finally {
                this.execInFlight = false;
                this.lastActivityAt = Date.now();
            }
        }
        return this.execChannel(command, options);
    }

    /**
     * exec 通道（非 PTY，FEAT-03）：独立 ssh 进程（无 -tt），stdout/stderr 物理分离；
     * enterSteps 以 stdin 管道重放（`… shell -s` 链，零嵌套引用）+ 层 cwd 拼装 +
     * nonce marker 实测 effectiveUser（子 shell + $? 变量锁）。
     */
    private async execChannel(command: string, options?: ExecOptions): Promise<ExecResult> {
        const hops: SshHop[] = Array.isArray(this.descriptor.config?.sshHops) ? (this.descriptor.config.sshHops as SshHop[]) : [];
        const enterSteps = enterStepsOf(this.descriptor.config as Record<string, unknown> | undefined);
        const connParams = this.descriptor.config?.connParams as SshConnParams | undefined;
        const rootHop: SshHop = connParams ? { host: this.descriptor.target ?? "", conn: connParams } : (this.descriptor.target ?? "");

        const nonce = crypto.randomBytes(6).toString("hex");
        const marker = `__FILAXIS_META_${nonce}`;
        const wrapped =
            `( ${command} ); __filaxis_ec=$?; ` +
            `printf '\\n${marker}:%d:%s\\n' "$__filaxis_ec" "$(id -un 2>/dev/null)"; ` +
            `exit $__filaxis_ec`;

        const render = renderExecChannel(enterSteps, command, {
            cwd: options?.cwd ?? this.descriptor.cwd,
            // env 远端语义（十轮自挖）：export 前缀与 cd 同通道拼进 stdinCmd——
            // 旧实现灌给本地 ssh 进程，远端命令根本看不见
            envPrefix: envPrefixOf(options?.env),
            marker, nonceWrapped: wrapped,
        });
        if (render.kind === "unreachable") {
            throw new Error(
                `exec 通道无法进入该层：${render.reason}［进入命令：${render.step}］\n` +
                `怎么修（按序尝试）：\n` +
                `  1. 把 --enter 改成可自动重放的形态——以 shell 结尾（例: "docker exec -it <容器> bash"）或 ssh 形态（例: "ssh <目标>"，会自动改为非交互执行）\n` +
                `  2. 确需交互式进入（su - /密码提示类）→ 改用 PTY 通道（CLI: 加 --pty；SDK: exec(cmd, {channel:"pty"})）——注意 PTY 里 stderr 会与 stdout 混在一起（终端物理行为，非 bug）`,
            );
        }

        // 多跳 + 转发的 exec 通道：hops 收敛为 -J（ProxyJump）由 ssh 自代理；逐跳 PTY
        // 登录链无法用单条非 PTY 进程复现 → 该形态层走 pty 通道（不可直达语义）
        if (hops.length > 0) {
            throw new Error(
                `exec 通道无法复现多跳 PTY 登录链（${hops.map(hopLabel).join(" → ")}）——单条非 PTY 进程做不到逐跳交互登录。\n` +
                `怎么修（按序尝试）：\n` +
                `  1. 途经机若只是 TCP 中转 → 收敛为 -J 跳板（CLI: -J <跳板>；SDK: connParams.jump）——认证在发起端，exec 通道可用\n` +
                `  2. 确需逐跳登录 → PTY 通道（CLI: 加 --pty；SDK: exec(cmd, {channel:"pty"})；stderr 混流为终端物理行为）\n` +
                `  3. 或逐层派生（SDK: addLayer 每跳一层 + sshInto 派生——每跳独立策略/凭据）`,
            );
        }

        return new Promise<ExecResult>((resolve, reject) => {
            // CM 多路复用（第十一季）：同 dest 跨命令/跨进程共享 master——CLI 单发形态
            // 的握手成本从「每条命令」降到「每 10min 窗口首条」（ControlPersist=600）；
            // 与观察流同一 socket（exec/observe 同主机共享一条主连接）
            const destArgs = sshArgsFor(rootHop);
            const argv = [...autonomousSshOpts(connParams), ...muxFlagsFor(destArgs), ...destArgs, "--", ...render.remoteArgs];
            const p = spawn("ssh", argv, {
                env: { ...process.env },
                // 本地 ssh 进程启动目录不用 options.cwd（GPT Astra 十轮 #1）：cwd 是
                // **远端**语义（stdinCmd 的 cd 前缀）——远端专属目录本地不存在则
                // spawn ENOENT，连接尚未建立即崩。本地目录与远端工作目录无关。
                stdio: ["pipe", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            let settled = false;
            // StringDecoder 双流（Hydrogen R5 #4）：跨块多字节 UTF-8 撕裂（64KB pipe 边界中文/emoji → U+FFFD 对）
            const oDec = new StringDecoder("utf-8");
            const eDec = new StringDecoder("utf-8");
            p.stdout.on("data", (d: Buffer) => { stdout += oDec.write(d); });
            p.stderr.on("data", (d: Buffer) => { stderr += eDec.write(d); });
            // stdin 管道错误监听（GPT Astra 九轮 P1 同病面）：ssh 提前退出时继续写
            // 管道抛 write EOF——无监听器则 uncaught 崩宿主。记录后由 close 路径
            // 裁决（无哨兵 → reject 附 outcome=unknown）
            let stdinErr: Error | undefined;
            p.stdin.on("error", (e: Error) => { stdinErr = e; });
            try {
                p.stdin.write(render.stdinCmd);
                p.stdin.end();
            } catch (e) {
                stdinErr = e instanceof Error ? e : new Error(String(e));
            }

            // 完成哨兵原则（故障注入实验 1A/1B 实证收口）：__FILAXIS_META_ 尾缀是
            // 「命令跑完」的唯一权威凭证——未见哨兵（断链/远端 kill -9/abort/信号杀）
            // 一律 reject 附半截现场，绝不 resolve 伪造退出码。
            const onAbort = () => {
                // 杀的是本地 ssh——远端进程树状态未核实（GPT 加码：AbortError 不得伪装「远端已取消」）
                p.kill("SIGTERM");
                const e = new DOMException(
                    "exec aborted by AbortSignal（本地 ssh 已终止，远端进程状态未核实——outcome=unknown）",
                    "AbortError",
                ) as DOMException & { outcome: "unknown"; reason: string };
                e.outcome = "unknown";
                e.reason = "aborted";
                finish(() => reject(e));
            };
            const timer: ReturnType<typeof setTimeout> | null = options?.timeoutMs
                ? setTimeout(() => {
                    p.kill("SIGTERM");
                    const e = new Error(`exec 通道超时（${options.timeoutMs}ms，远端进程状态未核实）: ${command.slice(0, 60)}`) as Error & { outcome: "unknown" };
                    e.outcome = "unknown";
                    finish(() => reject(e));
                }, options.timeoutMs)
                : null;
            const cleanupAbort = () => options?.signal?.removeEventListener("abort", onAbort);
            options?.signal?.addEventListener("abort", onAbort, { once: true });
            const finish = (fn: () => void) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); cleanupAbort(); fn(); } };
            if (options?.signal?.aborted) onAbort(); // race-safe：传入时已 abort

            p.on("close", (code) => {
                let out = stdout;
                let effectiveUser: string | undefined;
                let sentinelCode: number | undefined;
                const mIdx = out.lastIndexOf(`\n${marker}:`);
                if (mIdx !== -1) {
                    const metaLine = out.slice(mIdx + 1).split("\n", 1)[0] ?? "";
                    const m = metaLine.match(new RegExp(`^${marker}:(-?\\d+):(.*)$`));
                    if (m) {
                        effectiveUser = m[2] === "" ? undefined : m[2];
                        sentinelCode = parseInt(m[1]!, 10);
                        out = out.slice(0, mIdx);
                    }
                }
                if (effectiveUser) this.effectiveUser = effectiveUser;
                // 无哨兵=命令未跑完（「无法执行」语义）——reject 附半截现场（outcome=unknown）
                if (sentinelCode === undefined) {
                    finish(() => {
                        // 连接层失败诊断（试用反馈 #29：-J/--host 传 ssh-config 别名在沙箱/
                        // 远端环境「不认」——别名解析依赖**运行环境**的 ~/.ssh/config，本机
                        // 有的别名沙箱里没有。报错直交 + 指引，缩短排障路径）
                        const connFail = /Could not resolve hostname|Connection (timed out|refused|closed)|Permission denied|Host key verification failed|no route to host/i.test(stderr);
                        const diag = connFail
                            ? "\n[连接层失败] ssh 本身没建起链——若 --host/-J 传的是 ssh-config 别名，注意别名解析用的是**本运行环境**的 ~/.ssh/config（沙箱/远端会话可能没有该条目：改用 user@host[:port] 字面量或先补 config）"
                            : "";
                        const e = new Error(
                            `命令未完成（无完成哨兵——通道中断/进程被信号终止，close code=${code}）${stdinErr ? `；stdin 管道错误: ${stdinErr.message}` : ""}。半截现场 stdout 尾 500 字符:\n${out.slice(-500)}\nstderr 尾 300:\n${stderr.slice(-300)}${diag}`,
                        ) as Error & { outcome: "unknown" };
                        e.outcome = "unknown";
                        reject(e);
                    });
                    return;
                }
                // 哨兵在场：退出码以哨兵为准（code===null 的信号杀竞态也不伪 0）
                finish(() => resolve({ stdout: out, stderr, exitCode: sentinelCode, effectiveUser }));
            });
            p.on("error", (err) => finish(() => reject(err)));
        });
    }

    // ── 会话族（委托 RemoteSessionManager）──
    async execSession(command: string, opts?: SessionStartOptions): Promise<SessionHandleInfo> {
        if (this.layerShellGone) throw new Error("层已退化——后台任务会落在父环境，请重建层后再启动");
        return this.sessions.start(command, opts);
    }
    async tailSession(sessionId: string, lines?: number): Promise<string[]> { return this.sessions.tail(sessionId, lines); }
    async readSessionLog(sessionId: string, opts?: ReadLogOptions): Promise<string> { return this.sessions.readLog(sessionId, opts); }
    watchSession(sessionId: string, opts: WatchOptions): { cancel(): void } { return this.sessions.watch(sessionId, opts); }
    async stopSession(sessionId: string): Promise<{ status: "exited" | "stopped" | "unknown"; exitCode?: number | null }> { return this.sessions.stop(sessionId); }
    /** 会话核实（unknown 闭环）：远端实测 kill -0 + .code 采纳 + PID 身份戳比对 */
    async verifySession(sessionId: string): Promise<{ status: "running" | "exited" | "unknown"; exitCode?: number | null }> {
        return this.sessions.verify(sessionId);
    }
    listSessions() { return this.sessions.list(); }
}

/** shell 单引号安全引用 */
function q(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}
