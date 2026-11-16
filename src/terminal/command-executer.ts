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
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** 会话级共享注册表（Sol 89 P1-3）：tmux 会话 id 是**进程级全局命名空间**——
 *  两个 TerminalManager 各持执行器引用同一会话时，实例级注册表互不可见，
 *  双方并发 send-keys 把命令文本送进同一前台进程（实测无需注入故障即现）。
 *  chains（互斥）与 sttyOff/deadSessions/destroyConfirmed（会话状态）全局
 *  共享；**配置与 logger 保持实例级**（Hydrogen R3 #1 的实例隔离诉求只关乎
 *  配置互相覆盖——会话状态恰须共享，两轴分家） */
const sessionChains = new Map<string, Promise<unknown>>();
const sessionSttyOff = new Set<string>();
const sessionDead = new Set<string>();
const sessionDestroyConfirmed = new Set<string>();

/** 跨进程会话锁路径（Sol 90 P1-5）：tmux 会话 id 是**OS 级全局命名空间**——
 *  模块级 Map 只串行化本进程，两个独立进程引用同一 terminalId 时 send-keys
 *  仍交错（实测无需注入即现，命令文本互相送进对方前台任务）。锁文件落 tmpdir */
function sessionLockPath(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-80) || "sess";
    return join(tmpdir(), `filaxis-sess-${safe}.lock`);
}

export class CommandExecuter {
    private cfg: TerminalConfig = { ...DEFAULT_TERMINAL_CONFIG };
    private log: FilaxisLogger = noopLogger;

    /** 配置注入（SDK 组装期一次性；测试可覆盖） */
    constructor(opts: CommandExecuterOptions = {}) {
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
     * - 超时（墙钟/不活动）= INTERRUPTING：发 C-c 杀远端前台任务，调用方立即
     *   收 CommandExecError（挂 outcome:"unknown"）——但**会话锁不释放**；
     * - DRAINING（仍在链内）：等自己的 marker 可信终态（上限 5s）才把会话交还
     *   下一条命令；
     * - 等不到终态 → kill-session 销毁 + 标记 dead（后续调用显式报错指引重建；
     *   重建后探活自愈）——绝不定时强行复用。
     */
    async execute(id: string, command: string, opts: RunOptions = {}): Promise<TerminalExecResult> {
        await this.assertReusable(id); // 入队前快检（新调用快速失败）
        const prev = sessionChains.get(id) ?? Promise.resolve();
        const run = prev.catch(() => undefined).then(() => this.executeLocked(id, command, opts));
        sessionChains.set(id, run.catch(() => undefined));
        return run;
    }

    /** 复用资格核验（Sol 87 P1-2 → Sol 88 P1-1）：dead 标记 + 销毁确认闸 +
     *  探活自愈。**入队前与出队后（executeLocked 顶）双检**——首检曾只在入队
     *  前：第一条在链内超时、kill-session 失败标 dead 时，此前已入队的第二条
     *  绕过首检直接 executeLocked，has-session 对旧前台任务持有的同名会话照样
     *  成功——下一条命令文本送进了旧前台进程 */
    private async assertReusable(id: string): Promise<void> {
        if (!sessionDead.has(id)) return;
        if (!sessionDestroyConfirmed.has(id)) {
            throw new CommandExecError(
                `tmux session '${id}' 销毁结果未确认（kill-session 曾失败——同名会话可能仍被旧前台任务持有）——拒绝复用。请换 id 重建层或先确认旧会话已消失`,
            );
        }
        try {
            const r = await TmuxInvoker.tryInvoke(["has-session", "-t", id]);
            if (r.exitCode === 0) {
                sessionDead.delete(id);
                sessionDestroyConfirmed.delete(id);
                sessionSttyOff.delete(id);
                return;
            }
            throw new CommandExecError(
                `tmux session '${id}' 已因超时终态不可确认被销毁——请重建层（同 id respawn 后自动恢复）再执行`,
            );
        } catch (e) {
            if (e instanceof CommandExecError) throw e;
            throw new CommandExecError(`tmux session '${id}' 已销毁且探活失败——请重建层`);
        }
    }

    private async executeLocked(id: string, command: string, opts: RunOptions = {}): Promise<TerminalExecResult> {
        await this.assertReusable(id); // 出队后复检（Sol 88 P1-1）：入队后才翻 dead 的会话在此拦截
        // 跨进程互斥（Sol 90 P1-5）：等待上限=本命令超时+7s（DRAINING 5s+余量）
        const release = await CommandExecuter.acquireSessionLock(id, (opts.timeoutMs ?? this.cfg.command_timeout_ms) + 7_000);
        try {
            return await this.executeCommand(id, command, opts);
        } finally {
            await release();
        }
    }

    /** 跨进程会话锁（Sol 90 P1-5）：O_CREAT|O_EXCL 探针 + 陈锁回收——持锁进程
     *  已死（pid 活性：EPERM=活无权、ESRCH=死）或锁龄>1h（pid 复用兜底）才可
     *  回收；释放只删自己 token 的锁。同进程内先经全局链串行，锁无自竞争 */
    private static async acquireSessionLock(id: string, waitMs: number): Promise<() => Promise<void>> {
        const { open, unlink, readFile, stat } = await import("node:fs/promises");
        const lockPath = sessionLockPath(id);
        const myToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const deadline = Date.now() + waitMs;
        let fh: Awaited<ReturnType<typeof open>> | null = null;
        while (Date.now() < deadline) {
            try {
                fh = await open(lockPath, "wx");
                await fh.write(myToken);
                break;
            } catch (e) {
                const code = (e as { code?: string }).code;
                if (code !== "EEXIST") throw e;
                try {
                    const [tok, st] = await Promise.all([readFile(lockPath, "utf-8"), stat(lockPath)]);
                    const holderPid = parseInt((tok.split("-")[0] ?? "").trim(), 10);
                    let alive = Number.isFinite(holderPid) && holderPid > 0;
                    if (alive) {
                        try { process.kill(holderPid, 0); } catch (err) { alive = (err as { code?: string }).code === "EPERM"; }
                    }
                    if (!alive || Date.now() - st.mtimeMs > 3_600_000) await unlink(lockPath).catch(() => undefined);
                } catch { /* 锁文件刚好消失——下轮抢 */ }
                await sleep(25);
            }
        }
        if (!fh) {
            throw new CommandExecError(`tmux 会话 '${id}' 正被另一进程使用（跨进程锁等待 ${waitMs}ms 超时）——命令串行重试或换 terminalId 分层`);
        }
        const held = fh;
        return async () => {
            await held.close().catch(() => undefined);
            try {
                const cur = await readFile(lockPath, "utf-8");
                if (cur.trim() === myToken) await unlink(lockPath);
            } catch { /* 已被回收/删除 */ }
        };
    }

    static __testSessLockPath(id: string): string { // 测试导出面（跨进程锁路径）
        return sessionLockPath(id);
    }

    private async executeCommand(id: string, command: string, opts: RunOptions = {}): Promise<TerminalExecResult> {
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
        if (!sessionSttyOff.has(id)) {
            await this.sendKeys(id, "stty -echo 2>/dev/null; export PS1= PS2=;");
            await sleep(400);
            await TmuxInvoker.invoke(["clear-history", "-t", id]);
            sessionSttyOff.add(id);
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

        try {
            await this.sendKeys(id, safeCommand);
        } catch (e) {
            // **业务命令首次发送失败**（Sol 90 P1-4）：sendKeys=写文本+提交回车两段
            //——文本（或回车）送达与否不可知=执行结果未知。raw 抛曾直接放行队列，
            // 下一条已入队命令的文本照进本条前台任务。与哨兵失败（Sol 89 P1-2）
            // 同判：标 dead（无销毁确认）+ unknown——出队复检拦截待重建
            sessionDead.add(id);
            sessionSttyOff.delete(id);
            throw new CommandExecError(
                `业务命令发送失败（${e instanceof Error ? e.message : String(e)}）——命令文本可能已送达且终态不可确认，会话已封存待重建`,
                "", "unknown",
            );
        }
        // 前置换行（Hydrogen R7 #1）：命令输出无尾换行（printf "OK"）时 marker 输出
        // 粘连同一行——单独靠 strip 前缀保留是兜底，源头先保证分行为主防线。
        // **终止符 #**（Sol 88 P1-2）：折行拼接还原后，数字段曾吃到**下一行的
        // 提示符数字**（PS1=123 下退出码 1 被拼成 1123）——非数字终止符收口数字
        // 段长度（`#` 词中非注释：紧贴变量展开，echo 原样输出）
        try {
            await this.sendKeys(id, `__fx_ec=$?; printf '\n'; echo ${markerPrefix}$__fx_ec#`);
        } catch (e) {
            // 哨兵注入失败（Sol 88 P1-3 → Sol 89 P1-2）：业务命令已提交执行中——
            // 终态不可核实，归 unknown 语义。**并标 dead（不入销毁确认集）**：
            // throw 即释放执行链，已入队的下一条曾照常 executeLocked——has-session
            // 对旧前台任务持有的会话照样成功，命令文本又送进旧前台进程（与
            // kill 失败同族；dead+无确认=出队复检拦截，指引重建）
            sessionDead.add(id);
            sessionSttyOff.delete(id);
            throw new CommandExecError(
                `完成哨兵注入失败（${e instanceof Error ? e.message : String(e)}）——命令已提交且会话终态不可确认，已封存待重建`,
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
        let binaryDetected = false;
        let binaryBytes = 0;
        // 本轮 DRAIN 探测哨兵（超时路径生成——Sol 89 P2-2）：输出清洗的 drain 帧
        // 过滤按**本轮 token** 收窄（全局形态模式曾删掉用户输出里的字面
        // `__FX_DRAIN_xxx`/`stty -echo` 合法正文）
        let drainToken: string | undefined;

        while (true) {
            if (Date.now() >= wallDeadline || Date.now() - lastActivityAt >= cfg.no_output_timeout_ms) {
                // ★ INTERRUPTING（审查问题 2：此前裸 throw——前台任务还在跑，下一条
                //   命令的 send-keys 会打进去。现在：发 C-c → DRAINING 等自己的
                //   marker 可信终态（仍在链内，串行保证下一条命令等这里完成）→
                //   等不到则销毁会话标 dead，绝不强行复用）
                const reason = Date.now() >= wallDeadline
                    ? `Timeout waiting for command to finish in terminal ${id}`
                    : `Timeout waiting for command to finish in terminal ${id} (no output for ${cfg.no_output_timeout_ms}ms)`;
                try { await TmuxInvoker.invoke(["send-keys", "-t", id, "C-c"]); } catch { /* 会话可能已死 */ }
                // ★ 交互 bash 中 ^C 杀整行 job（含本命令尾部的 marker echo）——原命令的
                //   marker 可能永不出现。DRAINING 改用**独立探测哨兵**：发一条新的
                //   echo（自身 ^C 幸存——它是 ^C 之后的新行），等它出现在 pane 即
                //   shell 已回提示符（可信终态：可安全接手）。二者任一先到即算。
                drainToken = `__FX_DRAIN_${Math.random().toString(36).slice(2, 8)}`;
                try {
                    // 分段哨兵（GPT Astra 三轮 #4）：发送文本=printf '__FX_DR%s' 'AIN_<hex>'——
                    // **完整 token 永不出现在回显里**（引号/折行无论怎么切，回显单行至多含
                    // token 片段，全等判定不可能命中）；执行输出由 printf 拼接出完整 token
                    // 独立成行。两轮迭代教训：echo 形态折行可使 token 独立成行、printf 引号
                    // 形态在极端窄 pane（提示符恰占满整行）仍有理论窗口——分段根除。
                    await TmuxInvoker.invoke(["send-keys", "-t", id, "-l", `printf '__FX_DR%s\\n' 'AIN_${drainToken.slice(11)}'`]);
                    await TmuxInvoker.invoke(["send-keys", "-t", id, "C-m"]);
                } catch { /* 会话可能已死 */ }
                const partial = CommandExecuter.extractPartialOutput(buffer, markerPrefix, markerEchoNeedle, binaryDetected, binaryBytes, drainToken);
                const drained = await this.waitForDrain(id, markerPrefix, drainToken, 5_000);
                if (drained) {
                    try { await TmuxInvoker.invoke(["clear-history", "-t", id]); } catch { /* best-effort */ }
                    throw new CommandExecError(
                        `${reason}（已发 ^C，远端 shell 已确认回提示符——outcome=unknown）`,
                        partial, "unknown",
                    );
                }
                try {
                    await TmuxInvoker.invoke(["kill-session", "-t", id]);
                    sessionDestroyConfirmed.add(id); // kill 成功=销毁已确认（自愈闸钥匙）
                } catch { /* kill 失败——不入 destroyConfirmed（Sol 87 P1-2）：同名在场≠重建 */ }
                sessionDead.add(id);
                sessionSttyOff.delete(id);
                throw new CommandExecError(
                    `${reason}（已发 ^C 但 5s 内未见可信终态——会话已销毁防残影串台；同 id respawn 后自动恢复）`,
                    partial, "unknown",
                );
            }

            const paneText = await this.capturePane(id, cfg.capture_scrollback);
            // 折行还原视图（Sol 88 P1-2）：窄窗格把哨兵前缀本身折断时，**原文**
            // includes 永远不命中——完成判定根本进不来（命令超时假象）。剥行
            // 拼接后的 flat 才是判据（软折行无分隔语义）
            const flatPane = CommandExecuter.flattenPane(paneText, markerPrefix);

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
                        if (opts.onProgress && !flatPane.includes(markerPrefix)) {
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
                    const stdout = CommandExecuter.stripMarkerNoise(buffer.readLogText(), markerPrefix, markerEchoNeedle, drainToken);
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
                    "unknown", //（Sol 87 P1-7）：命令已发、无完成哨兵——终态未核实（批处理/SDK 按 outcome 分诊重试）
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
    static __testStrip(log: string, markerPrefix: string, markerEchoNeedle: string, drainToken?: string): string { // 测试导出面
        return CommandExecuter.stripMarkerNoise(log, markerPrefix, markerEchoNeedle, drainToken);
    }

    private static stripMarkerNoise(log: string, markerPrefix: string, markerEchoNeedle: string, drainToken?: string): string {
        const resultLines: string[] = [];
        const lines = log.split("\n");
        // DRAIN 帧清理按**本轮 token** 收窄（Sol 89 P2-2）：全局形态模式
        //（/__FX_DRAIN_[0-9a-z]+/、裸 /stty -echo/）曾把用户输出里的同形合法
        // 正文无提示删除。只在超时路径（drainToken 在场）清本轮的探测帧残段
        const drainTail = drainToken ? drainToken.slice("__FX_DRAIN_".length) : null;
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
            if (drainToken) {
                // 本轮 DRAIN 探测帧（Sol 89 P2-2 收窄）：整行全等 token=执行输出行；
                // printf 回显/折行残段=含 __FX_DR%s 或以 'AIN_<尾段> 收尾
                if (line.trim() === drainToken) continue;
                if (line.includes("__FX_DR%s")) continue;
                if (drainTail && line.endsWith(`AIN_${drainTail}`)) continue;
                if (drainTail && line.endsWith(`AIN_${drainTail}'`)) continue;
            }
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
        binaryDetected: boolean, binaryBytes: number, drainToken?: string,
    ): string {
        if (binaryDetected) return `[binary output: ${binaryBytes} bytes omitted]`;
        return CommandExecuter.stripMarkerNoise(buffer.readLogText(), markerPrefix, markerEchoNeedle, drainToken);
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
            if (CommandExecuter.parseExitCode(pane, markerPrefix) !== null) return true; // flatten 内含（折断前缀同样可信）
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
