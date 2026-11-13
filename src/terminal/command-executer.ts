/**
 * terminal/command-executer.ts — 持久会话内命令执行（marker 协议 + 三级缓冲 + 双超时）
 * （净室平移；剥 上游安全闸——安全策略归消费方；
 *  interactionManager 两形态嗅探剥——OSS 只认 PromptResponder 注入）
 *
 * marker 协议：send-keys 命令 + `echo MARKER$?`，capture-pane 解析 exitCode；
 * stdout 从 OutputBuffer 增量累积取（不受 capture 窗口截断）。
 * 双超时：墙钟总限 + 不活动（新输出重置——只杀哑不杀慢）。
 * 修复点 D：shopt 安全前缀防 PS1 注入。二进制嗅探保 stdout 纯净。
 */
import { TmuxInvoker } from "./tmux-invoker.js";
import { OutputBuffer, type BufferStats } from "./output-buffer.js";
import { compilePromptPatterns, DEFAULT_TERMINAL_CONFIG, type PromptPayload, type PromptResponder, type TerminalConfig } from "./types.js";
import { noopLogger, type FilaxisLogger } from "../logger.js";

export interface ProgressSnapshot {
    tail: string;
    stats: BufferStats;
}

export interface RunOptions {
    timeoutMs?: number;
    /** 交互响应者（密码/确认 Prompt——消费方注入；null=无交互能力） */
    responder?: PromptResponder | null;
    /** 流式回调：每次 capture 到新内容触发（原始 tail 快照，未剥 marker 噪声） */
    onProgress?: (snapshot: ProgressSnapshot) => void;
}

export interface TerminalExecResult {
    stdout: string;
    exitCode: number;
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

export interface CommandExecuterOptions {
    config?: Partial<TerminalConfig>;
    logger?: FilaxisLogger;
}

export class CommandExecuter {
    private cfg: TerminalConfig = { ...DEFAULT_TERMINAL_CONFIG };
    /** 已关回显的会话（每会话一次性 stty -echo——交互 shell 的命令回显不进 stdout） */
    private sttyOff = new Set<string>();
    /** per-session 命令链（审查问题 2：同会话命令必须串行——并发 send-keys 交错） */
    private chains = new Map<string, Promise<unknown>>();
    /** 因终态不可确认被销毁的会话（自愈：重建后 has-session 探活即清除标记） */
    private deadSessions = new Set<string>();
    private log: FilaxisLogger = noopLogger;

    /** 配置注入（SDK 组装期一次性；测试可覆盖） */
    constructor(opts: CommandExecuterOptions = {}) {
        // 实例化（Hydrogen R3 #1）：曾全 static——多个 TerminalManager 实例静默
        // 互相覆盖配置/共享锁链与状态（注释宣称实例隔离实为假象）
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
     * - 超时（墙钟/不活动）= INTERRUPTING：发 C-c 杀远端前台任务，调用方立即
     *   收 CommandExecError（挂 outcome:"unknown"）——但**会话锁不释放**；
     * - DRAINING（仍在链内）：等自己的 marker 可信终态（上限 5s）才把会话交还
     *   下一条命令；
     * - 等不到终态 → kill-session 销毁 + 标记 dead（后续调用显式报错指引重建；
     *   重建后探活自愈）——绝不定时强行复用。
     */
    async execute(id: string, command: string, opts: RunOptions = {}): Promise<TerminalExecResult> {
        // 自愈探活：dead 标记在但会话已被重建（同 id respawn）→ 清标记放行
        if (this.deadSessions.has(id)) {
            try {
                const r = await TmuxInvoker.tryInvoke(["has-session", "-t", id]);
                if (r.exitCode === 0) {
                    this.deadSessions.delete(id);
                    this.sttyOff.delete(id);
                } else {
                    throw new CommandExecError(
                        `tmux session '${id}' 已因超时终态不可确认被销毁——请重建层（同 id respawn 后自动恢复）再执行`,
                    );
                }
            } catch (e) {
                if (e instanceof CommandExecError) throw e;
                throw new CommandExecError(`tmux session '${id}' 已销毁且探活失败——请重建层`);
            }
        }
        const prev = this.chains.get(id) ?? Promise.resolve();
        const run = prev.catch(() => undefined).then(() => this.executeLocked(id, command, opts));
        this.chains.set(id, run.catch(() => undefined));
        return run;
    }

    private async executeLocked(id: string, command: string, opts: RunOptions = {}): Promise<TerminalExecResult> {
        const cfg = this.cfg;
        const timeoutMs = opts.timeoutMs ?? cfg.command_timeout_ms;

        let alive: boolean;
        try {
            const r = await TmuxInvoker.tryInvoke(["has-session", "-t", id]);
            alive = r.exitCode === 0;
        } catch {
            alive = false;
        }
        if (!alive) {
            throw new CommandExecError(`tmux session '${id}' does not exist. Spawn a new session first.`);
        }

        await TmuxInvoker.invoke(["clear-history", "-t", id]);

        // ── 会话首次执行：关交互回显 + 清提示符（CI 实证：tmux 非登录 shell 的
        //    PS1 带 hostname 前缀裸奔，命令回显与提示符行全进 capture-pane）。
        //    stty/PS1 自身的回显经二次 clear 清除 ──
        if (!this.sttyOff.has(id)) {
            await this.sendKeys(id, "stty -echo 2>/dev/null; export PS1= PS2=;");
            await sleep(400);
            await TmuxInvoker.invoke(["clear-history", "-t", id]);
            this.sttyOff.add(id);
        }
        // 每命令发送前清屏：clear-history 只清滚回区；可见 pane 的残留（CI 六发
        // 实证 PRE_TASK_OUT 滞留）必须经 shell 命令 `clear`（清终端+光标归位；
        // C-l 按键在非交互 bash 不被处理，实测无效）——两者一起做
        try {
            await TmuxInvoker.invoke(["send-keys", "-t", id, "-l", "clear"]);
            await TmuxInvoker.invoke(["send-keys", "-t", id, "C-m"]);
            await sleep(200);
        } catch { /* best-effort */ }
        await TmuxInvoker.invoke(["clear-history", "-t", id]).catch(() => undefined);

        const markerToken = Math.random().toString(36).slice(2, 10);
        const markerPrefix = `---CMD_DONE_${markerToken}_`;
        const markerEchoNeedle = `echo ${markerPrefix}`;
        const safeCommand = `${SAFE_PREFIX} ${command}`;

        await this.sendKeys(id, safeCommand);
        // 前置换行（Hydrogen R7 #1）：命令输出无尾换行（printf "OK"）时 marker 输出
        // 粘连同一行——单独靠 strip 前缀保留是兜底，源头先保证分行为主防线
        await this.sendKeys(id, `__fx_ec=$?; printf '\n'; echo ${markerPrefix}$__fx_ec`);

        const buffer = new OutputBuffer({
            pendingChars: cfg.buffer_pending_chars,
            aggregatedChars: cfg.buffer_aggregated_chars,
            tailChars: cfg.buffer_tail_chars,
        });

        const wallDeadline = Date.now() + timeoutMs;
        let lastActivityAt = Date.now();
        let lastPaneText = "";
        let binaryDetected = false;
        let binaryBytes = 0;

        while (true) {
            if (Date.now() >= wallDeadline || Date.now() - lastActivityAt >= cfg.no_output_timeout_ms) {
                // ★ INTERRUPTING（审查问题 2：此前裸 throw——前台任务还在跑，下一条
                //   命令的 send-keys 会打进去。现在：发 C-c → DRAINING 等自己的
                //   marker 可信终态（仍在链内，串行保证下一条命令等这里完成）→
                //   等不到则销毁会话标 dead，绝不强行复用）
                const reason = Date.now() >= wallDeadline
                    ? `Timeout waiting for command to finish in terminal ${id}`
                    : `Timeout waiting for command to finish in terminal ${id} (no output for ${cfg.no_output_timeout_ms}ms)`;
                const partial = CommandExecuter.extractPartialOutput(buffer, markerPrefix, markerEchoNeedle, binaryDetected, binaryBytes);
                try { await TmuxInvoker.invoke(["send-keys", "-t", id, "C-c"]); } catch { /* 会话可能已死 */ }
                // ★ 交互 bash 中 ^C 杀整行 job（含本命令尾部的 marker echo）——原命令的
                //   marker 可能永不出现。DRAINING 改用**独立探测哨兵**：发一条新的
                //   echo（自身 ^C 幸存——它是 ^C 之后的新行），等它出现在 pane 即
                //   shell 已回提示符（可信终态：可安全接手）。二者任一先到即算。
                const drainToken = `__FX_DRAIN_${Math.random().toString(36).slice(2, 8)}`;
                try {
                    // 分段哨兵（GPT Astra 三轮 #4）：发送文本=printf '__FX_DR%s' 'AIN_<hex>'——
                    // **完整 token 永不出现在回显里**（引号/折行无论怎么切，回显单行至多含
                    // token 片段，全等判定不可能命中）；执行输出由 printf 拼接出完整 token
                    // 独立成行。两轮迭代教训：echo 形态折行可使 token 独立成行、printf 引号
                    // 形态在极端窄 pane（提示符恰占满整行）仍有理论窗口——分段根除。
                    await TmuxInvoker.invoke(["send-keys", "-t", id, "-l", `printf '__FX_DR%s\\n' 'AIN_${drainToken.slice(11)}'`]);
                    await TmuxInvoker.invoke(["send-keys", "-t", id, "C-m"]);
                } catch { /* 会话可能已死 */ }
                const drained = await this.waitForDrain(id, markerPrefix, drainToken, 5_000);
                if (drained) {
                    try { await TmuxInvoker.invoke(["clear-history", "-t", id]); } catch { /* best-effort */ }
                    throw new CommandExecError(
                        `${reason}（已发 ^C，远端 shell 已确认回提示符——outcome=unknown）`,
                        partial, "unknown",
                    );
                }
                try { await TmuxInvoker.invoke(["kill-session", "-t", id]); } catch { /* 已死 */ }
                this.deadSessions.add(id);
                this.sttyOff.delete(id);
                throw new CommandExecError(
                    `${reason}（已发 ^C 但 5s 内未见可信终态——会话已销毁防残影串台；同 id respawn 后自动恢复）`,
                    partial, "unknown",
                );
            }

            const paneText = await this.capturePane(id, cfg.capture_scrollback);

            if (paneText !== lastPaneText) {
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
                        if (opts.onProgress && !paneText.includes(markerPrefix)) {
                            try {
                                opts.onProgress({ tail: buffer.readTail(), stats: buffer.stats });
                            } catch { /* 进度回调失败不阻断 */ }
                        }
                    }
                }
                lastPaneText = paneText;
            }

            if (paneText.includes(markerPrefix)) {
                const exitCode = CommandExecuter.parseExitCode(paneText, markerPrefix);
                if (exitCode !== null) {
                    if (binaryDetected) {
                        return { stdout: `[binary output: ${binaryBytes} bytes omitted]`, exitCode };
                    }
                    const stdout = CommandExecuter.stripMarkerNoise(buffer.readLogText(), markerPrefix, markerEchoNeedle);
                    return { stdout, exitCode };
                }
            }

            // 交互 Prompt 检测（无 marker 时；仅文本末尾匹配）
            if (opts.responder && !paneText.includes(markerPrefix)) {
                const payload = this.detectPrompt(paneText, id);
                if (payload) {
                    this.log.info(`[${id}] 检测到交互 Prompt：${payload.metadata.prompt}`);
                    const reply = await opts.responder.ask(payload);
                    if (reply) {
                        await this.sendKeys(id, reply);
                        await sleep(800);
                        lastPaneText = "";
                        lastActivityAt = Date.now();
                    }
                    // 空 reply（拒绝/非交互兜底）：不再直接 continue（Hydrogen R2 #2——
                    // 曾跳过存活检查与 sleep，主循环退化为零延迟忙等 100% CPU）
                    await sleep(cfg.poll_interval_ms);
                    continue;
                }
            }

            // 中途死亡检测（存活=心跳，重置不活动定时器）
            try {
                const r = await TmuxInvoker.tryInvoke(["has-session", "-t", id]);
                alive = r.exitCode === 0;
            } catch {
                alive = false;
            }
            if (!alive) {
                throw new CommandExecError(
                    `tmux session '${id}' died while waiting for command to complete.`,
                    CommandExecuter.extractPartialOutput(buffer, markerPrefix, markerEchoNeedle, binaryDetected, binaryBytes),
                );
            }
            // 注意：不在此处重置 lastActivityAt（Hydrogen R2 #1）——「会话存活」≠
            // 「有输出」：不活动超时的语义是输出停滞即判（只杀哑不杀慢），曾每轮
            // 无条件重置致 no_output_timeout_ms 形同虚设（只剩墙钟超时兜底）
            await sleep(cfg.poll_interval_ms);
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

    private static parseExitCode(paneText: string, markerPrefix: string): number | null {
        for (const line of paneText.split("\n")) {
            if (!line.includes(markerPrefix)) continue;
            if (line.includes(`echo ${markerPrefix}`)) continue;
            const match = line.match(new RegExp(`${markerPrefix}(\\d+)`));
            if (match) return parseInt(match[1] ?? "0", 10);
        }
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

    /** 剥 marker/echo 噪声得纯净 stdout（marker 行起全停） */
    private static stripMarkerNoise(log: string, markerPrefix: string, markerEchoNeedle: string): string {
        const resultLines: string[] = [];
        for (const line of log.split("\n")) {
            if (line.includes(markerPrefix)) {
                // 保留 marker 前的前缀（Hydrogen R7 #1）：无尾换行输出的末行与 marker
                // 粘连（hello---CMD_DONE_.._0）——前缀是真实输出不得随 marker 丢弃
                const prefix = line.slice(0, line.indexOf(markerPrefix));
                if (prefix !== "") resultLines.push(prefix);
                break;
            }
            if (line.includes(markerEchoNeedle)) continue;
            if (/__FX_DRAIN_[0-9a-z]+/.test(line)) continue; // DRAINING 探测哨兵执行输出行
            if (/__FX_DR%s/.test(line) || /AIN_[0-9a-z]{4,10}'?\s*$/.test(line)) continue; // 分段哨兵的命令回显（折行残段）
            if (/stty -echo/.test(line)) continue; // 初始化残章
            if (/__fx_ec=\$\?/.test(line)) continue; // 退出码捕获赋值的命令回显（R7 #1 配套）
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

    private async sendKeys(id: string, text: string): Promise<void> {
        await TmuxInvoker.invoke(["send-keys", "-t", id, "-l", text]);
        await TmuxInvoker.invoke(["send-keys", "-t", id, "C-m"]);
    }

    /**
     * DRAINING（审查问题 2）：超时 ^C 后等可信回提示符证据（有上限）。
     * 两凭证任一先到：① 原命令 marker（^C 后 trap/echo 幸存时）② 独立探测哨兵
     * drainToken（^C 之后新发的 echo——^C 杀整行 job 也不影响它）。
     * 链内调用——串行保证下一条命令在本方法返回/超时后才接手会话。
     */
    private async waitForDrain(id: string, markerPrefix: string, drainToken: string, deadlineMs: number): Promise<boolean> {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
            const pane = await this.capturePane(id, 80);
            if (CommandExecuter.paneShowsDrainEvidence(pane, drainToken)) return true;
            if (pane.includes(markerPrefix) && CommandExecuter.parseExitCode(pane, markerPrefix) !== null) return true;
            await sleep(120);
        }
        return false;
    }

    /**
     * drain 证据判定（GPT Astra 两轮迭代）：探测命令的**回显**（pane 里的命令文本，
     * 可能被窄 pane 折行）不是执行证据——只有 token **独立成行**（trim 后全等）才是
     * shell 回提示符的可信凭证。探测命令用 `printf '<token>\n'` 形态（回显含引号包裹，
     * 折行后任何单行都不等于裸 token）双保险。
     */
    static paneShowsDrainEvidence(pane: string, drainToken: string): boolean {
        for (const line of pane.split(/\r?\n/)) {
            if (line.trim() === drainToken) return true;
        }
        return false;
    }

    private async capturePane(id: string, scrollback: number): Promise<string> {
        try {
            const r = await TmuxInvoker.invoke(["capture-pane", "-t", id, "-p", "-S", `-${scrollback}`]);
            return r.stdout;
        } catch {
            return "";
        }
    }
}
