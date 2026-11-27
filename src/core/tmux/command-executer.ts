/**
 * terminal/command-executer.ts — 持久会话内命令执行（marker 协议 + 三级缓冲 + 双超时）
 * （净室平移；剥 上游安全闸——安全策略归消费方；
 *  interactionManager 两形态嗅探剥——OSS 只认 PromptResponder 注入）
 *
 * marker 协议：命令和哨兵一起提交，capture-pane 解析 exitCode；
 * stdout 从 OutputBuffer 增量累积取（不受 capture 窗口截断）。
 * 双超时：墙钟总限 + 不活动（新输出重置——只杀哑不杀慢）。
 * 修复点 D：shopt 安全前缀防 PS1 注入。二进制嗅探保 stdout 纯净。
 */
import { FILAXIS_PANE_OPTION, TmuxInvoker } from "./tmux-invoker.js";
import { OutputBuffer, type BufferStats } from "./output-buffer.js";
import { compilePromptPatterns, DEFAULT_TERMINAL_CONFIG, type PromptPayload, type PromptResponder, type TerminalConfig } from "./types.js";
import { noopLogger, type FilaxisLogger } from "../../shared/logger.js";
import { shellQuote } from "../ssh/ssh-helpers.js";
import { observePaneOutput, type PaneOutputObserver } from "./pane-output-observer.js";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ProgressSnapshot {
    tail: string;
    stats: BufferStats;
}

export interface RunOptions {
    timeoutMs?: number;
    /** 交互响应者。启用时命令在子 shell 中执行，cd、export 和 trap 等变更限于本次调用。 */
    responder?: PromptResponder | null;
    /** 流式回调：每次 capture 到新内容触发（原始 tail 快照，未剥 marker 噪声） */
    onProgress?: (snapshot: ProgressSnapshot) => void;
}

export interface TerminalExecResult {
    stdout: string;
    exitCode: number;
}

interface PendingReply {
    snapshot: string;
    prompt: string;
    result?: { reply: string | null } | { error: unknown };
}

/** 命令失败富错误：partialOutput 携带截至失败时刻的累积输出 */
export class CommandExecError extends Error {
    readonly partialOutput: string;
    /** 超时/中断：远端终态未核实（"unknown"）——上层按未知处理，严禁当已清理 */
    outcome?: "unknown";
    constructor(message: string, partialOutput = "", outcome?: "unknown") {
        super(message);
        this.name = "CommandExecError";
        this.partialOutput = partialOutput;
        this.outcome = outcome;
    }
}

const SAFE_PREFIX = "shopt -u promptvars nullglob extglob nocaseglob 2>/dev/null;";
const BINARY_SNIFF_BYTES = 4096;
const BINARY_NULL_RATIO = 0.10;

/** 二进制嗅探：前 N 字节 null 占比 >10% 判 binary（PTY 偶发 NUL 容忍） */
export function isBinaryChunk(text: string): boolean {
    const sample = text.length > BINARY_SNIFF_BYTES ? text.slice(0, BINARY_SNIFF_BYTES) : text;
    if (sample.length === 0) return false;
    let nulls = 0;
    for (let i = 0; i < sample.length; i++) {
        if (sample.charCodeAt(i) === 0) nulls++;
    }
    return nulls / sample.length > BINARY_NULL_RATIO;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function renderInteractiveCommand(command: string, token: string, printCompletion: string): string {
    const readTrap = `__fx_read_int_${token}`;
    const trapState = `__fx_int_state_${token}`;
    const trapFile = `__fx_int_file_${token}`;
    const status = `__fx_status_${token}`;
    const installed = `__fx_int_installed_${token}`;
    const ttyMode = `__fx_tty_${token}`;
    // Older dash clears the trap table in $(trap). Dump it in the parent
    // shell, then source the shell-quoted data with a collector in a subshell.
    const inspect = `${readTrap}() { ` +
        `if [ -n "\${BASH_VERSION-}" ]; then ${trapState}=$(command trap -p INT); return; fi; ` +
        `${trapFile}=$(command mktemp "\${TMPDIR:-/tmp}/filaxis-int.XXXXXXXXXX") || return 1; ` +
        `if ! command trap > "$${trapFile}"; then command rm -f "$${trapFile}"; return 1; fi; ` +
        `if ! ${trapState}=$( __fx_collect_int() { case "$3" in INT|SIGINT) command printf 'set:%s' "$2";; esac; }; ` +
        `alias trap=__fx_collect_int; . "$${trapFile}" ); then command rm -f "$${trapFile}"; return 1; fi; ` +
        `command rm -f "$${trapFile}"; }; `;
    const setup = `${readTrap} && { [ -n "$${trapState}" ] || { command trap ':' INT && ${installed}=1; }; }`;
    const restore = `[ "\${${installed}-}" != 1 ] || command trap - INT`;
    const waitForRelease = `( while IFS= command read -r __fx_line; do ` +
        `[ "$__fx_line" != '__FX_RELEASE_${token}' ] || exit 0; done; exit 1 )`;
    // Run the reply consumer in a child shell so its trap and environment
    // changes cannot disable the parent shell's input drain.
    // Terminal settings are shared across the two shells. Restore them and
    // accept the release newline literally before allowing another command.
    return inspect + `if ${ttyMode}=$(command stty -g) && ${setup}; then ( ${command} ); ${status}=$?; ` +
        `if command stty "$${ttyMode}" && command stty icanon -inlcr -echo; then ` +
        `command printf '\\n__FX_REPLY_END_%s\\n' '${token}'; ` +
        `if ${waitForRelease} && command stty "$${ttyMode}" && { ${restore}; }; then ` +
        `${printCompletion} "$${status}"; fi; fi; ` +
        `else command printf '\\n__FX_REPLY_UNAVAILABLE_%s\\n' '${token}'; fi; ` +
        `unset -f ${readTrap}; unset ${trapState} ${trapFile} ${status} ${installed} ${ttyMode}`;
}

export interface CommandExecuterOptions {
    config?: Partial<TerminalConfig>;
    logger?: FilaxisLogger;
    resolvePane?: (id: string) => Promise<ExecutionPane>;
}

/** 会话级共享注册表（Sol 89 P1-3）：tmux 会话 id 是**进程级全局命名空间**——
 *  两个 TerminalManager 各持执行器引用同一会话时，实例级注册表互不可见，
 *  双方并发 send-keys 把命令文本送进同一前台进程（实测无需注入故障即现）。
 *  chains（互斥）与 sttyOff/deadSessions/destroyConfirmed（会话状态）全局
 *  共享；**配置与 logger 保持实例级**（Hydrogen R3 #1 的实例隔离诉求只关乎
 *  配置互相覆盖——会话状态恰须共享，两轴分家） */
const sessionChains = new Map<string, Promise<unknown>>();
const sessionSttyOff = new Set<string>();
const sessionDead = new Set<string>();
interface ExecutionPane {
    target: string;
    lockPath: string;
    assertIdle(): Promise<void>;
    setInput(enabled: boolean): Promise<void>;
    observeOutput?(timeoutMs: number): Promise<PaneOutputObserver>;
}

const execFileAsync = promisify(execFile);

/** 窗格锁：与 socket 并排。socket 路径按原样截取目录（字符串切片，不经 path.join——后者会把
 *  路径里的 `link/..` 词法折叠，锁文件落到另一个目录） */
export function paneLockPath(socket: string, key: string): string {
    const slash = socket.lastIndexOf("/");
    const dir = slash >= 0 ? socket.slice(0, slash + 1) : "";
    return `${dir}.filaxis-pane-${key}.lock`;
}

async function resolveExecutionPane(id: string): Promise<ExecutionPane> {
    const format = "#{pid}\t#{pane_id}\t#{pane_pid}\t#{socket_path}";
    const { stdout } = await TmuxInvoker.invoke(["display-message", "-p", "-t", id, format]);
    const match = stdout.replace(/\r?\n$/, "").match(/^(\d+)\t(%\d+)\t(\d+)\t([^\r\n]+)$/);
    if (!match) throw new CommandExecError(`无法核实 tmux 会话 '${id}' 的窗格身份`);
    const [, serverPid, target, panePid, socket] = match as unknown as [string, string, string, string, string];
    const key = createHash("sha256").update(JSON.stringify([socket, serverPid, target, panePid])).digest("hex");
    return {
        target,
        lockPath: paneLockPath(socket, key),
        async assertIdle() {
            const state = await TmuxInvoker.invoke([
                "display-message", "-p", "-t", target,
                `#{pane_pid}\t#{${FILAXIS_PANE_OPTION}}\t#{pane_input_off}`,
            ]);
            // A closed gate proves no client could have started a read between SDK calls.
            // An arbitrary existing shell cannot attest to its readiness without input.
            if (state.stdout.trim() !== `${panePid}\t1\t1`) {
                throw new CommandExecError(`tmux 窗格 '${target}' 无法确认由 Filaxis 独占且处于待命状态，请新建会话`);
            }
            const { stdout: groups } = await execFileAsync("ps", ["-o", "pgid=,tpgid=", "-p", panePid], { windowsHide: true });
            const [group, foreground] = groups.trim().split(/\s+/);
            if (!group || !/^[1-9]\d*$/.test(group) || group !== foreground) {
                throw new CommandExecError(`tmux 窗格 '${target}' 的前台正在被占用或无法核实，拒绝发送`);
            }
        },
        async setInput(enabled) {
            await TmuxInvoker.invoke(["select-pane", enabled ? "-e" : "-d", "-t", target]);
        },
        async observeOutput(timeoutMs) {
            const { stdout: session } = await TmuxInvoker.invoke(["display-message", "-p", "-t", target, "#{session_id}"]);
            return observePaneOutput(session.trim(), target, timeoutMs);
        },
    };
}

export class CommandExecuter {
    private cfg: TerminalConfig = { ...DEFAULT_TERMINAL_CONFIG };
    private log: FilaxisLogger = noopLogger;
    private readonly resolvePane: (id: string) => Promise<ExecutionPane>;

    /** 配置注入（SDK 组装期一次性；测试可覆盖） */
    constructor(opts: CommandExecuterOptions = {}) {
        this.resolvePane = opts.resolvePane ?? resolveExecutionPane;
        // 配置实例化（Hydrogen R3 #1 → Sol 89 P1-3 分轴）：曾全 static——多实例
        // 互相覆盖配置；R3 全实例化又把会话队列也隔离了（同会话双 manager 失去
        // 互斥）。配置/logger=实例级，会话注册表=模块级共享（见上方注释）
        this.cfg = { ...DEFAULT_TERMINAL_CONFIG, ...opts.config };
        this.log = opts.logger ?? noopLogger;
    }

    configure(opts: CommandExecuterOptions = {}): void {
        this.cfg = { ...DEFAULT_TERMINAL_CONFIG, ...opts.config };
        this.log = opts.logger ?? noopLogger;
    }

    /**
     * 在 tmux 会话中执行命令（四阶段 temporal isolation——审查问题 2 修复）：
     * - **per-session 串行**：同会话命令排队，绝不并发 send-keys；
     * - 超时后发 C-c 请求中断，持锁观察本命令哨兵，最多 5 秒。
     * - 缺少可信终态时销毁窗格，销毁失败则封存。超时结果始终为 unknown。
     */
    async execute(id: string, command: string, opts: RunOptions = {}): Promise<TerminalExecResult> {
        const prev = sessionChains.get(id) ?? Promise.resolve();
        const run = prev.catch(() => undefined).then(() => this.executeLocked(id, command, opts));
        sessionChains.set(id, run.catch(() => undefined));
        return run;
    }

    private async executeLocked(id: string, command: string, opts: RunOptions): Promise<TerminalExecResult> {
        const pane = await this.resolvePane(id);
        const key = pane.lockPath;
        if (sessionDead.has(key)) {
            throw new CommandExecError(`tmux 窗格 '${pane.target}' 销毁结果未确认，已封存`);
        }
        const release = await CommandExecuter.acquireSessionLock(
            pane, (opts.timeoutMs ?? this.cfg.command_timeout_ms) + 7_000,
        );
        let inputAttempted = false;
        let observer: PaneOutputObserver | undefined;
        const destroyPane = async () => {
            await TmuxInvoker.invoke(["kill-pane", "-t", pane.target]);
            inputAttempted = false;
        };
        try {
            await pane.assertIdle();
            inputAttempted = true;
            await pane.setInput(true);
            if (opts.responder && pane.observeOutput) {
                try {
                    observer = await pane.observeOutput(Math.min(opts.timeoutMs ?? this.cfg.command_timeout_ms, 2_500));
                } catch (error) {
                    this.log.warn(`[${pane.target}] 无法观察 tmux 输出事件：${String(error)}`);
                }
            }
            return await this.executeCommand(pane, command, opts, destroyPane, observer);
        } finally {
            observer?.close();
            if (inputAttempted) {
                try {
                    await pane.setInput(false);
                } catch {
                    // Retain the fence if we cannot confirm that the input gate closed.
                    sessionDead.add(key);
                }
            }
            await release(sessionDead.has(key));
        }
    }

    /** Publish a complete token atomically. A dead holder leaves the pane's state unknown,
     *  so its lock remains a fence until the caller creates a new session ID. */
    private static async acquireSessionLock(pane: ExecutionPane, waitMs: number): Promise<(quarantine: boolean) => Promise<void>> {
        const { link, unlink, readFile, writeFile, rename } = await import("node:fs/promises");
        const { lockPath, target: id } = pane;
        const myToken = `${process.pid}-${randomUUID()}`;
        const candidate = `${lockPath}.${randomUUID()}.tmp`;
        const deadline = Date.now() + waitMs;
        await writeFile(candidate, myToken, { flag: "wx", mode: 0o600 });
        try {
            while (Date.now() < deadline) {
                try {
                    await link(candidate, lockPath);
                    return async (quarantine) => {
                        try {
                            if (await readFile(lockPath, "utf-8") !== myToken) return;
                            if (quarantine) {
                                await writeFile(candidate, `quarantined ${myToken}`, { flag: "wx", mode: 0o600 });
                                await rename(candidate, lockPath);
                            } else {
                                await unlink(lockPath);
                            }
                        } catch { /* Keep the lock if its state cannot be updated safely. */ }
                        finally { await unlink(candidate).catch(() => undefined); }
                    };
                } catch (e) {
                    if ((e as { code?: string }).code !== "EEXIST") throw e;
                }
                const token = await readFile(lockPath, "utf-8").catch((e: NodeJS.ErrnoException) => {
                    if (e.code === "ENOENT") return "";
                    throw e;
                });
                if (token.startsWith("quarantined ")) {
                    throw new CommandExecError(`tmux session '${id}' 的上一次执行终态未知，已封存——请换 terminalId 重建`);
                }
                const holderPid = Number(/^([1-9]\d*)-/.exec(token)?.[1]);
                if (Number.isSafeInteger(holderPid)) {
                    try { process.kill(holderPid, 0); } catch (e) {
                        if ((e as { code?: string }).code === "ESRCH") {
                            throw new CommandExecError(`tmux session '${id}' 的持锁进程已退出，会话终态未核实——请换 terminalId 重建`);
                        }
                        if ((e as { code?: string }).code !== "EPERM") throw e;
                    }
                }
                await sleep(25);
            }
        } finally {
            await unlink(candidate).catch(() => undefined);
        }
        throw new CommandExecError(`tmux 会话 '${id}' 正被另一进程使用（跨进程锁等待 ${waitMs}ms 超时）——命令串行重试或换 terminalId 分层`);
    }

    static __testSessLockPath(id: string): string { // 测试导出面（跨进程锁路径）
        return join(tmpdir(), `filaxis-sess-${id}.lock`);
    }

    private async executeCommand(
        pane: ExecutionPane, command: string, opts: RunOptions, destroyPane: () => Promise<void>,
        observer?: PaneOutputObserver,
    ): Promise<TerminalExecResult> {
        const { target: id, lockPath: key } = pane;
        const cfg = this.cfg;
        const timeoutMs = opts.timeoutMs ?? cfg.command_timeout_ms;

        let alive: boolean;
        try {
            const r = await TmuxInvoker.tryInvoke(["display-message", "-p", "-t", id, "#{pane_id}"]);
            alive = r.exitCode === 0;
        } catch {
            alive = false;
        }
        if (!alive) {
            throw new CommandExecError(`tmux session '${id}' does not exist. Spawn a new session first.`);
        }

        await TmuxInvoker.invoke(["clear-history", "-t", id]);

        if (!sessionSttyOff.has(key)) {
            try {
                await this.prepareShell(id, Math.min(timeoutMs, 10_000));
                sessionSttyOff.add(key);
            } catch (e) {
                sessionDead.add(key);
                throw new CommandExecError(
                    `tmux shell 就绪未获确认，业务命令未发送，窗格已封存：${e instanceof Error ? e.message : String(e)}`,
                );
            }
        }
        const screenToken = randomUUID().replace(/-/g, "");
        const screenMarker = `__FX_SCREEN_${screenToken}`;
        try {
            // tmux interprets these sequences directly, independent of shell TERM.
            await this.sendKeys(id, `command printf '\\033[H\\033[2J__FX_SCREEN_%s\\n' '${screenToken}'`);
            await this.waitForMarkerLine(id, screenMarker, Math.min(timeoutMs, 10_000));
            await TmuxInvoker.invoke(["clear-history", "-t", id]);
        } catch (e) {
            // A failed Enter can leave clear in the shell's input buffer.
            sessionDead.add(key);
            sessionSttyOff.delete(key);
            throw new CommandExecError(
                `tmux 清屏发送失败，业务命令未发送，窗格已封存：${e instanceof Error ? e.message : String(e)}`,
            );
        }
        const markerToken = randomUUID().replace(/-/g, "");
        const markerPrefix = `---CMD_DONE_${markerToken}_`;
        const markerEchoNeedle = `echo ${markerPrefix}`;
        const replyEnd = `__FX_REPLY_END_${markerToken}`;
        const replyRelease = `__FX_RELEASE_${markerToken}`;
        const outputBoundary = opts.responder ? replyEnd : markerPrefix;
        const printCompletion = `command printf '\\n---CMD_DONE_%s_%d#\\n' '${markerToken}'`;
        const evaluate = `eval ${shellQuote(` ${command}`)}`;
        const body = opts.responder
            ? renderInteractiveCommand(evaluate, markerToken, printCompletion)
            : `${evaluate}; ${printCompletion} "$?"`;
        // Parse the full wrapper before entering eval. A separate send-keys after
        // starting the command can be read by the command as business input.
        // The nonce is split from the marker format so the echo isn't evidence.
        // A leading blank keeps dash-prefixed command names from being parsed as eval options.
        const safeCommand = `${SAFE_PREFIX} ${body}`;
        const safeCmdBytes = Buffer.byteLength(safeCommand, "utf-8");
        if (safeCmdBytes > 15_500) {
            throw new Error(
                `tmux 单条命令过长（包装后 ${safeCmdBytes} 字节，超出 15500 字节上限）；` +
                `请改用 transfer_file 上传脚本后执行，或用 run_batch（先 kind="put" 上传脚本，再通过 after 依赖执行 kind="exec"）`,
            );
        }

        try {
            await this.sendKeys(id, safeCommand);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/command too long/i.test(msg)) {
                throw new Error(
                    `tmux 单条命令过长（${msg}）；` +
                    `请改用 transfer_file 上传脚本后执行，或用 run_batch（先 kind="put" 上传脚本，再通过 after 依赖执行 kind="exec"）`,
                );
            }
            // **业务命令首次发送失败**（Sol 90 P1-4）：sendKeys=写文本+提交回车两段
            //——文本（或回车）送达与否不可知=执行结果未知。raw 抛曾直接放行队列，
            // 下一条已入队命令的文本照进本条前台任务。与哨兵失败（Sol 89 P1-2）
            // 同判：标 dead（无销毁确认）+ unknown——出队复检拦截待重建
            sessionDead.add(key);
            sessionSttyOff.delete(key);
            throw new CommandExecError(
                `业务命令发送失败（${msg}）——命令文本可能已送达且终态不可确认，会话已封存待重建`,
                "", "unknown",
            );
        }

        const buffer = new OutputBuffer({
            pendingChars: cfg.buffer_pending_chars,
            aggregatedChars: cfg.buffer_aggregated_chars,
            tailChars: cfg.buffer_tail_chars,
        });

        const wallDeadline = Date.now() + timeoutMs;
        let lastActivityAt = Date.now();
        let lastPaneText = "";
        let promptHandled = false;
        let reprintAfter: number | undefined;
        let replyReleased = false;
        let pendingReply: PendingReply | undefined;
        let binaryDetected = false;
        let binaryBytes = 0;
        const quarantineInteraction = (error: unknown) => {
            sessionDead.add(key);
            sessionSttyOff.delete(key);
            return new CommandExecError(
                `tmux 交互失败，窗格已封存：${error instanceof Error ? error.message : String(error)}`,
                CommandExecuter.extractPartialOutput(buffer, outputBoundary, markerEchoNeedle, binaryDetected, binaryBytes),
                "unknown",
            );
        };
        const replyReady = (pane: string) =>
            Boolean(opts.responder && CommandExecuter.paneHasMarkerLine(pane, replyEnd));
        const releaseReply = async () => {
            try {
                // End any partially received reply before sending the release line.
                await TmuxInvoker.invoke(["send-keys", "-t", id, "C-j"]);
                await this.sendKeys(id, replyRelease, "C-j");
                replyReleased = true;
                pendingReply = undefined;
            } catch (e) {
                throw quarantineInteraction(e);
            }
        };
        while (true) {
            if (Date.now() >= wallDeadline || Date.now() - lastActivityAt >= cfg.no_output_timeout_ms) {
                const draining = replyReleased || (opts.responder && replyReady(await this.capturePane(id, 80, true)));
                if (pendingReply && !pendingReply.result && !draining) {
                    throw quarantineInteraction(new Error("等待交互回复超时"));
                }
                const reason = Date.now() >= wallDeadline
                    ? `Timeout waiting for command to finish in terminal ${id}`
                    : `Timeout waiting for command to finish in terminal ${id} (no output for ${cfg.no_output_timeout_ms}ms)`;
                if (!draining) {
                    try { await TmuxInvoker.invoke(["send-keys", "-t", id, "C-c"]); } catch { /* 会话可能已死 */ }
                }
                // Only acknowledge after the command's own marker confirms it
                // has entered the release reader.
                const partial = CommandExecuter.extractPartialOutput(buffer, outputBoundary, markerEchoNeedle, binaryDetected, binaryBytes);
                const drained = await this.waitForCompletion(id, markerPrefix, 5_000, async (pane) => {
                    if (!replyReleased && replyReady(pane)) await releaseReply();
                });
                if (drained) {
                    try { await TmuxInvoker.invoke(["clear-history", "-t", id]); } catch { /* best-effort */ }
                    throw new CommandExecError(
                        `${reason}（已观察到原命令完成哨兵——outcome=unknown）`,
                        partial, "unknown",
                    );
                }
                let destroyed = false;
                try {
                    await destroyPane();
                    destroyed = true;
                } catch {
                    sessionDead.add(key);
                }
                sessionSttyOff.delete(key);
                throw new CommandExecError(
                    `${reason}（未见可信终态，窗格${destroyed ? "已销毁" : "已封存"}）`,
                    partial, "unknown",
                );
            }

            const paneText = (await this.capturePane(id, cfg.capture_scrollback, true))
                .split("\n").filter((line) => line.trim() !== screenMarker).join("\n");
            if (opts.responder && CommandExecuter.paneHasMarkerLine(paneText, `__FX_REPLY_UNAVAILABLE_${markerToken}`)) {
                throw new CommandExecError("无法安装 tmux 交互中断保护，业务命令未执行");
            }
            // 折行还原视图（Sol 88 P1-2）：窄窗格把哨兵前缀本身折断时，**原文**
            // includes 永远不命中——完成判定根本进不来（命令超时假象）。剥行
            // 拼接后的 flat 才是判据（软折行无分隔语义）
            const flatPane = CommandExecuter.flattenPane(paneText, markerPrefix);
            const commandFinished = replyReady(paneText);

            if (paneText !== lastPaneText) {
                promptHandled = false;
                lastActivityAt = Date.now();
                if (paneText.length > 0) {
                    if (!binaryDetected && isBinaryChunk(paneText)) {
                        binaryDetected = true;
                        binaryBytes = paneText.length;
                        this.log.warn(`[${id}] 检测到二进制输出，切换字节计数模式`);
                    } else if (binaryDetected) {
                        binaryBytes = paneText.length;
                    } else {
                        const delta = CommandExecuter.computeDelta(lastPaneText, paneText);
                        if (delta.length > 0) buffer.append(delta);
                        if (opts.onProgress && !commandFinished && !flatPane.includes(markerPrefix)) {
                            try {
                                opts.onProgress({ tail: buffer.readTail(), stats: buffer.stats });
                            } catch { /* 进度回调失败不阻断 */ }
                        }
                    }
                }
                lastPaneText = paneText;
            }

            if (flatPane.includes(markerPrefix)) {
                const exitCode = CommandExecuter.parseFlatExitCode(flatPane, markerPrefix);
                if (exitCode !== null) {
                    if (binaryDetected) {
                        return { stdout: `[binary output: ${binaryBytes} bytes omitted]`, exitCode };
                    }
                    const stdout = CommandExecuter.stripMarkerNoise(buffer.readLogText(), outputBoundary, markerEchoNeedle);
                    return { stdout, exitCode };
                }
            }

            if (commandFinished && !replyReleased) {
                await releaseReply();
            }

            if (pendingReply?.result) {
                const { result, snapshot, prompt: pendingPrompt } = pendingReply;
                pendingReply = undefined;
                if (snapshot === paneText) {
                    if ("error" in result) throw quarantineInteraction(result.error);
                    if (result.reply && Date.now() < Math.min(wallDeadline, lastActivityAt + cfg.no_output_timeout_ms)) {
                        try {
                            if (/[\x00-\x1f\x7f]/.test(result.reply)) throw new Error("交互回复须为不含控制字符的单行文本");
                            await TmuxInvoker.invoke(["send-keys", "-t", id, "-l", result.reply]);
                            reprintAfter = observer?.sawTextAfter(pendingPrompt, 0) ? observer.position : undefined;
                            await TmuxInvoker.invoke(["send-keys", "-t", id, "C-m"]);
                            lastActivityAt = Date.now();
                        } catch (e) {
                            throw quarantineInteraction(e);
                        }
                    }
                }
            }

            // Continue observing completion while the responder waits for the user.
            const responder = opts.responder;
            if (responder && !pendingReply && !commandFinished && !replyReleased && !flatPane.includes(markerPrefix)) {
                const payload = this.detectPrompt(paneText, id);
                if (payload && (!promptHandled || (reprintAfter !== undefined &&
                    observer?.sawTextAfter(payload.metadata.prompt, reprintAfter)))) {
                    promptHandled = true;
                    reprintAfter = undefined;
                    this.log.info(`[${id}] 检测到交互 Prompt：${payload.metadata.prompt}`);
                    const request: PendingReply = { snapshot: paneText, prompt: payload.metadata.prompt };
                    pendingReply = request;
                    void Promise.resolve().then(() => responder.ask(payload)).then(
                        (reply) => { request.result = { reply }; },
                        (error: unknown) => { request.result = { error }; },
                    );
                }
            }

            // 中途死亡检测（存活=心跳，重置不活动定时器）
            try {
                const r = await TmuxInvoker.tryInvoke(["display-message", "-p", "-t", id, "#{pane_id}"]);
                alive = r.exitCode === 0;
            } catch {
                alive = false;
            }
            if (!alive) {
                sessionDead.add(key);
                sessionSttyOff.delete(key);
                throw new CommandExecError(
                    `tmux session '${id}' died while waiting for command to complete.`,
                    CommandExecuter.extractPartialOutput(buffer, outputBoundary, markerEchoNeedle, binaryDetected, binaryBytes),
                    "unknown", //（Sol 87 P1-7）：命令已发、无完成哨兵——终态未核实（批处理/SDK 按 outcome 分诊重试）
                );
            }
            // 注意：不在此处重置 lastActivityAt（Hydrogen R2 #1）——「会话存活」≠
            // 「有输出」：不活动超时的语义是输出停滞即判（只杀哑不杀慢），曾每轮
            // 无条件重置致 no_output_timeout_ms 形同虚设（只剩墙钟超时兜底）
            const now = Date.now();
            await sleep(Math.max(0, Math.min(cfg.poll_interval_ms, wallDeadline - now, lastActivityAt + cfg.no_output_timeout_ms - now)));
        }
    }

    /** 交互 Prompt 检测（末尾锚定，避免输出中段字样误判） */
    detectPrompt(paneText: string, terminalId: string): PromptPayload | null { // 实例方法（读 cfg.prompt_patterns）
        if (!paneText) return null;
        const re = compilePromptPatterns(this.cfg.prompt_patterns);
        const m = paneText.match(re);
        if (!m) return null;
        const prompt = m[0].trim();
        return {
            type: "CONFIRM",
            title: "Shell Interaction Needed",
            message: `The command is requesting input: "${prompt}"`,
            metadata: { terminalId, prompt, platform: "terminal" },
        };
    }

    static __testParseExit(paneText: string, markerPrefix: string): number | null { // 测试导出面
        return CommandExecuter.parseExitCode(paneText, markerPrefix);
    }

    /** 剥行拼接（Sol 87 P1-3 → Sol 88 P1-2）：滤哨兵回显行 → 无分隔拼接 →
     *  剥 \r。PTY 软折行无分隔语义——还原成逻辑流。拼接也会把**下一逻辑行**
     *（提示符）焊上来，故退出码锚定须要求完整哨兵（终止符 #）而非裸 \d+ */
    private static flattenPane(paneText: string, markerPrefix: string): string {
        return paneText.split("\n").filter((l) => !l.includes(`echo ${markerPrefix}`)).join("").replace(/\r/g, "");
    }

    private static parseExitCode(paneText: string, markerPrefix: string): number | null {
        return CommandExecuter.parseFlatExitCode(CommandExecuter.flattenPane(paneText, markerPrefix), markerPrefix);
    }

    private static parseFlatExitCode(flat: string, markerPrefix: string): number | null {
        // 折行防截断（Sol 87 P1-3）：窄窗格把 `---CMD_DONE_tk_127` 折断——单行
        // 解析曾把折断的数字前缀（127→12→1）当完整退出码。折断行无法从单行
        // 形态区分「完整/折断」（数字到行尾两者同形）——剥换行拼接后锚定。
        // **终止符 # 收口**（Sol 88 P1-2）：裸 \d+ 曾把折行拼接进来的下一行
        // 提示符数字当退出码尾部（PS1=123 下 1 → 1123）；要求 prefix+数字+#
        // 三段齐整——# 是发送侧哨兵自带的，提示符数字接在 # 后不再入数
        const m2 = flat.match(new RegExp(`${markerPrefix}(\\d+)#`));
        if (m2) return parseInt(m2[1] ?? "0", 10);
        return null;
    }

    /** 增量 delta：① 前缀匹配 → 尾部；② 归一（\r+尾部空行区）再试；③ 滚屏重叠
     *  匹配（审计 M2：capturePane 滚动缓冲有限——输出滚屏后 curr 头部历史被淘汰，
     *  前缀必失效，旧实现整屏返回=每轮轮询重复追加整个缓冲区。prev 尾 k 行 ==
     *  curr 头 k 行的最大重叠即增量锚点）；④ 都不匹配（清屏/全重绘）整屏（宁重复
     *  不丢——空屏除外）。重叠搜索上限 64 行（单轮滚屏淘汰量级）。
     *  **尾部空行区归一（三十九期 CI 二连挂根因）**：capture-pane 返回整个 pane，
     *  内容只占顶部时底部是渲染填充空行——新行从底部进入整屏上滚，② 前缀与 ③
     *  重叠锚全被挤进空行区匹配失效，落 ④ 整屏追加=内容双计（实测 stdout 出现
     *  两份输出夹 24 空行）。归一尾部空白后再比对；空屏（纯填充）零信息不追加。 */
    private static computeDelta(prev: string, curr: string): string {
        const blank = (s: string) => s.replace(/\s+$/, "").length === 0;
        if (prev.length === 0) return blank(curr) ? "" : curr;
        if (curr.startsWith(prev)) return curr.slice(prev.length);
        const normPrev = prev.replace(/\s+$/, ""); // 尾部空行区=渲染填充非内容（\r 同归）
        const normCurr = curr.replace(/\s+$/, "");
        if (normCurr.startsWith(normPrev)) {
            const rest = curr.slice(normPrev.length);
            return blank(rest) ? "" : rest; // 纯尾部空行增长零信息（同内容重捕）
        }
        const pl = normPrev.split("\n");
        const cl = normCurr.split("\n");
        const maxK = Math.min(pl.length, cl.length, 64);
        for (let k = maxK; k >= 1; k--) {
            let same = true;
            for (let i = 0; i < k; i++) {
                if (pl[pl.length - k + i] !== cl[i]) { same = false; break; }
            }
            if (same) return cl.slice(k).join("\n");
        }
        return blank(curr) ? "" : curr; // 全屏重绘整屏返回（宁重复不丢）；空屏零信息
    }

    /** 剥 marker/echo 噪声得纯净 stdout（marker 行起全停）。
     *  回显判定**先于** marker 判定（Sol 86 P1-1）：包装命令的回显行含
     *  `echo ---CMD_DONE_..` 字样——markerPrefix 是其子串，曾先撞 marker 检查
     *  在回显行处 break——首执行（stty -echo 尚未生效）真实输出全被截掉 */
    static __testStrip(log: string, markerPrefix: string, markerEchoNeedle: string): string { // 测试导出面
        return CommandExecuter.stripMarkerNoise(log, markerPrefix, markerEchoNeedle);
    }

    private static stripMarkerNoise(log: string, markerPrefix: string, markerEchoNeedle: string): string {
        const resultLines: string[] = [];
        const lines = log.split("\n");
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.includes(markerEchoNeedle)) continue; // 回显行（echo 前缀在场）——先于 marker 检查跳过
            if (line.includes(markerPrefix)) {
                // 保留 marker 前的前缀（Hydrogen R7 #1）：无尾换行输出的末行与 marker
                // 粘连（hello---CMD_DONE_.._0）——前缀是真实输出不得随 marker 丢弃
                const prefix = line.slice(0, line.indexOf(markerPrefix));
                if (prefix !== "") resultLines.push(prefix);
                break;
            }
            // 折断哨兵跨行还原（Sol 88 真机补全）：窄窗格把 marker 前缀本身折断——
            // 单行 includes 不命中，残段曾整段漏进 stdout（20 列真机实锤）。向前拼
            // 两行判定：哨兵**自本行开始**（起点落在行内）→ 保起点前段后弃全部；
            // 起点在后续行 → 本行是真实输出照常保留（下一行自会命中折断判定）
            const joined = line + (lines[i + 1] ?? "") + (lines[i + 2] ?? "");
            const mIdx = joined.indexOf(markerPrefix);
            if (mIdx !== -1 && mIdx < line.length) {
                if (mIdx > 0) resultLines.push(line.slice(0, mIdx));
                break;
            }
            // 回显折断跨行同样跳过——但须**起点落在本行内**（Sol 86 回归）：无分隔
            // 拼接曾在行边界拼出假 needle（"hello"+"echo —…"）误跳真实输出行
            const nIdx = joined.indexOf(markerEchoNeedle);
            if (nIdx !== -1 && nIdx < line.length) continue;
            if (/^stty -echo 2>\/dev\/null; export PS1= PS2=;?\s*$/.test(line)) continue; // 初始化残章（**整行全形态**——裸 /stty -echo/ 曾删用户正文）
            if (/^__fx_ec=\$\?; printf ['"]\\n['"]/.test(line)) continue; // 退出码捕获赋值回显（**前缀全形态**——同上收窄）
            if (/\$\s*$/.test(line) && /debian_chroot|@\S+[:~]/.test(line)) continue; // hostname 提示符行（PS1 清理竞态兜底）
            if (/^\$\s*$/.test(line)) continue; // 清空后的空提示符
            resultLines.push(line);
        }
        while (resultLines.length > 0 && resultLines[resultLines.length - 1]!.trim() === "") {
            resultLines.pop();
        }
        return resultLines.join("\n").trim();
    }

    private static extractPartialOutput(
        buffer: OutputBuffer, markerPrefix: string, markerEchoNeedle: string,
        binaryDetected: boolean, binaryBytes: number,
    ): string {
        if (binaryDetected) return `[binary output: ${binaryBytes} bytes omitted]`;
        return CommandExecuter.stripMarkerNoise(buffer.readLogText(), markerPrefix, markerEchoNeedle);
    }

    private async sendKeys(id: string, text: string, enter = "C-m"): Promise<void> {
        await TmuxInvoker.invoke(["send-keys", "-t", id, "-l", text]);
        await TmuxInvoker.invoke(["send-keys", "-t", id, enter]);
    }

    private async waitForCompletion(
        id: string, markerPrefix: string, deadlineMs: number, onCapture: (pane: string) => Promise<void>,
    ): Promise<boolean> {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
            const pane = await this.capturePane(id, 80, true);
            if (CommandExecuter.parseExitCode(pane, markerPrefix) !== null) return true; // flatten 内含（折断前缀同样可信）
            await onCapture(pane);
            await sleep(120);
        }
        return false;
    }

    static paneHasMarkerLine(pane: string, marker: string): boolean {
        return pane.split(/\r?\n/).some((line) => line.trim() === marker);
    }


    private async prepareShell(id: string, timeoutMs: number): Promise<void> {
        const nonce = randomUUID().replace(/-/g, "");
        // The echoed probe cannot contain the complete readiness marker.
        await this.sendKeys(id, `stty -echo 2>/dev/null; export PS1= PS2=; printf '\\n__FX_READY_%s\\n' '${nonce}'`);
        await this.waitForMarkerLine(id, `__FX_READY_${nonce}`, timeoutMs);
    }

    private async waitForMarkerLine(id: string, marker: string, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const pane = await this.capturePane(id, 80, true);
            if (CommandExecuter.paneHasMarkerLine(pane, marker)) return;
            await sleep(Math.max(0, Math.min(this.cfg.poll_interval_ms, deadline - Date.now())));
        }
        throw new Error("等待 Shell 哨兵超时");
    }


    private async capturePane(id: string, scrollback: number, joinWrapped = false): Promise<string> {
        try {
            const r = await TmuxInvoker.invoke([
                "capture-pane", "-t", id, "-p", "-S", `-${scrollback}`, ...(joinWrapped ? ["-J"] : []),
            ]);
            return r.stdout;
        } catch {
            return "";
        }
    }
}
