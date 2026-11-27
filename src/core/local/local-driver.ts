/**
 * local-driver.ts — 本地 Transport（进程内执行 + 原生 fs + 会话挂接）
 *
 * 净室平移自 个人Agent项目 `原内部模块`
 * ，按 REQ-0001 OSS 化改造：
 * - 剥 上游安全闸（执行网/沙箱属消费方策略）
 * - exec 改造（FEAT-03）：stdout/stderr 分离返回（源版混流 resolve）；
 *   effectiveUser 经 nonce marker 尾缀实测（子 shell 包裹 + $? 变量锁——
 *   用户命令内写 exit 也不丢退出码与 marker，见 docs/implementation-notes.md 锦囊 3）；
 *   channel:"pty" 显式拒绝（local 无 PTY 层——pty 通道语义属远端交互 Transport）
 * - exec 审计留痕保留（status/log 落盘 tempDir——「执行有迹」）
 * - shell 可配（缺省 bash；Windows 需 Git Bash/WSL——平台差异显式声明）
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream, readdirSync, readFileSync, realpath as realpathCallback, statSync } from "node:fs";
import { promisify } from "node:util";
import { ExecCapture, parseCompletionMarker } from "../base/exec-capture.js";

import path from "node:path";
import { tmpdir } from "node:os";
import * as crypto from "node:crypto";
import { shellQuote } from "../ssh/ssh-helpers.js";
import type {
    RuntimeDriver,
    FileSystemDriver,
    FileEntry,
    ExecOptions,
    ExecResult,
    RuntimeDescriptor,
} from "../base/driver.js";
import {
    LocalSessionManager,
} from "./local-session-manager.js";
import type {
    SessionStartOptions,
    SessionHandleInfo,
    WatchOptions,
    ReadLogOptions,
} from "../base/session-types.js";
import type { FilaxisLogger } from "../../shared/logger.js";
import { noopLogger } from "../../shared/logger.js";
import { resolveLocalShell } from "../base/shell-discovery.js";

export interface LocalDriverOptions {
    /** 缺省工作目录 */
    cwd?: string;
    /** exec 状态/日志目录（缺省 os.tmpdir()/filaxis-exec） */
    execDir?: string;
    /** 执行 shell（缺省 bash） */
    shell?: string;
    logger?: FilaxisLogger;
}

import type { ObservationWindowOptions, StreamWindowRegistry } from "../stream/stream-window.js";

/** 本地 Transport：进程内执行 + 原生 fs */
export class LocalRuntimeDriver implements RuntimeDriver {
    readonly supportsBoundedExec = true;
    descriptor: RuntimeDescriptor = { driver: "local", target: "localhost" };
    fs: FileSystemDriver;

    /** 会话式 exec 引擎（长跑 + 双文件落盘 + 热窗口 + watch） */
    readonly sessions: LocalSessionManager;

    private readonly defaultCwd?: string;
    private readonly execDir: string;
    private readonly shell: string;
    private readonly log: FilaxisLogger;

    constructor(opts: LocalDriverOptions = {}) {
        this.defaultCwd = opts.cwd;
        this.execDir = opts.execDir ?? path.join(tmpdir(), "filaxis-exec");
        this.log = opts.logger ?? noopLogger;
        this.shell = resolveLocalShell(opts.shell, this.log);
        this.fs = new LocalFileSystem(this.defaultCwd); // cwd 感知（Hydrogen R10 #1：相对路径曾落 process.cwd 与 ssh 层不一致）
        this.sessions = new LocalSessionManager({
            logDir: path.join(this.execDir, "sessions"),
            shell: this.shell,
            logger: this.log,
        });
    }

    /** 从 descriptor 构建（descriptor.cwd 初始化缺省工作目录） */
    static fromDescriptor(descriptor: RuntimeDescriptor, fallbackCwd?: string): LocalRuntimeDriver {
        const drv = new LocalRuntimeDriver({ cwd: descriptor.cwd ?? fallbackCwd });
        (drv as { descriptor: RuntimeDescriptor }).descriptor = descriptor;
        return drv;
    }

    async init() {
        // No-op for local
    }

    /** 在途的 exec 各持一个中止器：外部 signal 转发进来，destroy() 一并触发 */
    private readonly runningExecs = new Set<AbortController>();

    async destroy() {
        // 销毁 = 收掉这个 driver 起的、还在跑的东西（与 ssh 层「销毁即断链」同一语义）：在途 exec
        // 中止、后台会话停机并核实。此前是空实现——Daemon 停机后进程要陪在途命令/会话跑完才退
        // （长跑会话 = 旧进程活几小时），CLI 那头只等 5 秒就报「停机核实超时、终态未知」。
        const reason = new Error("本机层已销毁");
        for (const own of this.runningExecs) own.abort(reason);
        this.runningExecs.clear();
        const running = this.sessions.list().filter((s) => s.running);
        await Promise.all(running.map((s) => this.sessions.stop(s.sessionId).catch(() => undefined)));
    }

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
        const own = new AbortController();
        const outer = options?.signal;
        const forward = (): void => { own.abort(outer!.reason); };
        if (outer) {
            if (outer.aborted) forward();
            else outer.addEventListener("abort", forward, { once: true });
        }
        this.runningExecs.add(own);
        try {
            return await this.execOnce(command, { ...options, signal: own.signal });
        } finally {
            this.runningExecs.delete(own);
            outer?.removeEventListener("abort", forward);
        }
    }

    openStreamWindow(registry: StreamWindowRegistry, opts: ObservationWindowOptions) {
        // 调用方给了这次的工作目录就用它，否则用驱动自己的缺省目录（shell 等配置仍是本驱动的）
        return registry.open({ ...opts, shell: this.shell, cwd: opts.cwd ?? this.defaultCwd });
    }

    async getCwd(): Promise<string> {
        return this.defaultCwd || process.cwd();
    }

    async getEnv(key: string): Promise<string | undefined> {
        return process.env[key];
    }

    // ── 会话式 exec（委托 LocalSessionManager）──
    async execSession(command: string, opts?: SessionStartOptions): Promise<SessionHandleInfo> {
        return this.sessions.start(command, { ...opts, cwd: opts?.cwd ?? this.defaultCwd });
    }
    async tailSession(sessionId: string, lines = 50): Promise<string[]> {
        return this.sessions.tail(sessionId, lines);
    }
    async readSessionLog(sessionId: string, opts?: ReadLogOptions): Promise<string> {
        return this.sessions.readLog(sessionId, opts);
    }
    watchSession(sessionId: string, opts: WatchOptions): { cancel(): void } {
        return this.sessions.watch(sessionId, opts);
    }
    async stopSession(sessionId: string): Promise<{ status: "exited" | "stopped" | "unknown"; exitCode?: number | null }> {
        return this.sessions.stop(sessionId);
    }
    async verifySession(sessionId: string): Promise<{ status: "running" | "exited" | "unknown"; exitCode?: number | null }> {
        return this.sessions.verify(sessionId); // 公有正门（Gemini #7——曾强转私有 entries 且不实测 pid）
    }
    listSessions(): Array<{ sessionId: string; command: string; running: boolean; startedAt: number }> {
        return this.sessions.list();
    }

    private async execOnce(command: string, options?: ExecOptions): Promise<ExecResult> {
        if (options?.channel === "pty") {
            throw new Error('local Transport 不支持 channel:"pty"（PTY 交互语义属远端 Transport；本地 exec 通道天然分离且恒可用）');
        }

        await fs.mkdir(this.execDir, { recursive: true });
        const taskId = crypto.randomBytes(8).toString("hex");
        const logPath = path.join(this.execDir, `${taskId}.log`);
        const statusPath = path.join(this.execDir, `${taskId}.status.json`);
        const auditLabel = options?.auditLabel;
        const cwd = options?.cwd || this.defaultCwd || process.cwd();
        // 工作目录不存在时 spawn 报的是「ENOENT … uv_spawn '<shell>'」——看着像没装 shell，
        // 其实与 shell 无关（已存层的工作目录被删或填错时最常见）。先查目录，把原因说直
        if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
            throw new Error(`本机层的工作目录不存在（或不是目录）: ${cwd}`);
        }

        // FEAT-03 marker：子 shell 包裹业务命令，$? 变量锁 + nonce 防撞——
        // 用户命令内写 exit 42 也不丢退出码与 effectiveUser
        const nonce = crypto.randomBytes(6).toString("hex");
        const marker = `__FILAXIS_META_${nonce}__`;
        const wrapped =
            // 在子 shell 解析脚本，语法错误或显式 exit 都由外层记录退出码。
            `( eval ${shellQuote(` ${command}\n`)} ); __filaxis_ec=$?; ` +
            `printf '\\n${marker}:%d:%s\\n' "$__filaxis_ec" "$(id -un 2>/dev/null)"; ` +
            `exit $__filaxis_ec`;

        return new Promise<ExecResult>((resolve, reject) => {
            const stdout = new ExecCapture(options?.maxOutputBytes, marker);
            const stderr = new ExecCapture(options?.maxOutputBytes);

            const env = { ...process.env, ...options?.env };

            // 不使用 shell: true——Node 会再包一层 sh -c，stdin 读取类命令（wc、无参 cat）挂死。
            // 命令经 stdin 喂 `shell -s`（自排查·八轮顺藤：-c 走 argv 受 Windows 32767
            // 字符上限——file-transfer 48K chunk 命令本机层 ENAMETOOLONG；与 ssh
            // execChannel 同形态。sh -s 把 stdin 整流消费为脚本，脚本内 cat/wc 再读
            // stdin = EOF——与旧 stdin:"ignore" 语义一致，零行为变化）
            // timeoutMs 守卫前置（Sol 五十四期 P1-1）：曾放在 spawn 后——非法值
            // （0/负/NaN）虽报参数错但命令已写出副作用（测试文件已创建）。
            // spawn 前拒绝=零副作用
            if (options?.timeoutMs != null && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
                throw new Error(`timeoutMs 非法（${options.timeoutMs}）——须为正整数毫秒`);
            }
            if (options?.signal?.aborted) {
                throw new DOMException("Command aborted by AbortSignal（命令未发送）", "AbortError");
            }
            const p = spawn(this.shell, ["-s"], {
                env,
                cwd,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                // 不 detached：命令与宿主同处前台进程组，终端的 Ctrl-C 连命令一起送（SDK 宿主、进程内
                // filaxis-mcp、一次性 CLI 都靠这个）。代价是中止时不能按组号杀——见 reapCommandTree
            });
            // stdin 管道错误必须监听（GPT Astra 九轮 P1）：shell 提前退出（流式解析
            // 撞语法错即死）时继续写管道抛 write EOF——无 error 监听器则 uncaught
            // exception 崩**宿主进程**，外层 try/catch 捕不住（异步事件）。记录后由
            // close 路径统一裁决：shell 已死 → 无完成哨兵 → reject 附 outcome=unknown
            let stdinErr: Error | undefined;
            p.stdin.on("error", (e: Error) => { stdinErr = e; });
            try {
                p.stdin.write(wrapped);
                p.stdin.end();
            } catch (e) {
                // 同步 throw 形态（流已 destroy/write-after-end）——同管道错误处理
                stdinErr = e instanceof Error ? e : new Error(String(e));
            }

            const startTime = Date.now();
            const statusTemp = `${statusPath}.tmp`;
            let statusWrite = Promise.resolve();
            const writeStatus = (status: string, extra: Record<string, unknown> = {}) => {
                const payload = JSON.stringify({
                    pid: p.pid,
                    command: auditLabel ?? command,
                    status,
                    startTime,
                    endTime: Date.now(),
                    ...extra,
                }, null, 2);
                // Readers see whole snapshots, and the initial snapshot always
                // publishes before the terminal status.
                statusWrite = statusWrite.then(async () => {
                    try {
                        await fs.writeFile(statusTemp, payload, "utf-8");
                        await fs.rename(statusTemp, statusPath);
                    } catch {
                        await fs.unlink(statusTemp).catch(() => undefined);
                    }
                });
                return statusWrite;
            };
            void writeStatus("running");

            let settled = false;
            let finished = false;
            const logStream = auditLabel === undefined ? createWriteStream(logPath) : undefined;
            // error 监听 + 终结守卫（Hydrogen R5 #1）：超时=进程后台续跑，abort=整棵进程树收割，
            // 其后任意输出再进 logStream.write=ERR_STREAM_WRITE_AFTER_END 崩宿主
            // （无 error 监听时同步抛）。写日志尽力而为——失败吞掉，data 侧判 finished
            const resumeOutput = () => { p.stdout.resume(); p.stderr.resume(); };
            logStream?.on("error", resumeOutput);
            logStream?.on("drain", resumeOutput);
            const audit = (d: Buffer) => {
                if (!finished && logStream && !logStream.destroyed && !logStream.write(d)) {
                    p.stdout.pause();
                    p.stderr.pause();
                }
            };
            p.stdout.on("data", (d: Buffer) => { if (!finished) stdout.write(d); audit(d); });
            p.stderr.on("data", (d: Buffer) => { if (!finished) stderr.write(d); audit(d); });


            const cleanupProcess = (exitStatus: string, extra: Record<string, unknown> = {}) => {
                if (finished) return;
                finished = true;
                logStream?.end();
                return writeStatus(exitStatus, extra);
            };
            const detachLifecycle = () => {
                if (timeout) clearTimeout(timeout);
                if (onAbort) signal?.removeEventListener("abort", onAbort);
            };

            const timeout = options?.timeoutMs ? setTimeout(() => {
                if (settled) return;
                settled = true;
                finished = true; // 审计终态封口（审查问题 3：后台进程晚死时 close 不得把 timeout 覆写成 completed）
                detachLifecycle();
                // 超时=放弃该进程（继续后台写日志）。此时才 unref：被放弃的子进程
                // 不应撑事件循环。⚠️ 不能 spawn 后立即 unref——Bun 下 unref 子进程
                // 不保活事件循环，低活动场景 close 事件永不触发，exec 静默挂死。
                p.unref();
                logStream?.end();
                resumeOutput();
                void writeStatus("timeout", { error: "Command timeout", exitCode: null });
                const e = new Error(`Command timeout after ${options.timeoutMs}ms (process continues in background${logStream ? `, log: ${logPath}` : ""}, status: ${statusPath})`) as Error & { outcome: "unknown" };
                e.outcome = "unknown"; // 远端/本地进程终态未核实——审查问题 3：对齐 ssh 侧语义
                reject(e);
            }, options.timeoutMs) : null;

            const signal = options?.signal;
            const onAbort = signal ? () => {
                if (settled) return;
                settled = true;
                finished = true; // 审计终态封口（close 不得覆写 aborted）
                detachLifecycle();
                try { reapCommandTree(p, this.shell); } catch { /* 已退出 */ }
                logStream?.end();
                resumeOutput();
                void writeStatus("aborted", { error: "Aborted by AbortSignal", exitCode: null });
                const abortErr = new Error("Command aborted by AbortSignal（已尝试停止本机进程，命令终态未核实，outcome=unknown）") as Error & { name: "AbortError"; outcome: "unknown" };
                abortErr.name = "AbortError";
                abortErr.outcome = "unknown";
                reject(abortErr);
            } : null;
            if (signal && onAbort) {
                if (signal.aborted) onAbort();
                else signal.addEventListener("abort", onAbort, { once: true });
            }

            p.on("close", (code) => {
                detachLifecycle();
                if (settled) return;
                settled = true;
                const finish = () => {
                    // 完成哨兵原则（故障注入 1B 同源收口）：marker 尾缀是「跑完」唯一
                    // 凭证——未见哨兵（外部 kill -9/信号杀，code===null）reject 附半截
                    // 现场；哨兵在场退出码以哨兵为准。
                    const evidence = stdout.evidence();
                    const errorOutput = stderr.evidence();
                    const completion = parseCompletionMarker(evidence, marker, stdout.completionMarker);
                    // ★ 审计与事实对齐（审查问题 3）：先验哨兵，后写审计——
                    //   completed 只在有哨兵时落盘（exitCode 用哨兵真实码）；
                    //   无哨兵落 killed + exitCode null（绝不把 null ?? 0 伪成完成）
                    logStream?.end();
                    if (!completion) {
                        void writeStatus("killed", {
                            exitCode: null, closeCode: code ?? null,
                            stdinError: auditLabel === undefined ? stdinErr?.message : undefined,
                        });
                        const diagnostic = auditLabel === undefined
                            ? `${stdinErr ? `；stdin 管道错误: ${stdinErr.message}` : ""}。半截现场 stdout 尾 500:\n${evidence.slice(-500)}\nstderr 尾 300:\n${errorOutput.slice(-300)}`
                            : "";
                        const e = new Error(
                            `命令未完成（无完成哨兵——进程被信号终止，close code=${code}）${diagnostic}`,
                        ) as Error & { outcome: "unknown" };
                        e.outcome = "unknown";
                        reject(e);
                        return;
                    }
                    const { end, bodyBytes, exitCode, effectiveUser } = completion;
                    const result = { stdout: stdout.result(evidence, end, bodyBytes), stderr: stderr.result(errorOutput), exitCode, effectiveUser };
                    void writeStatus("completed", { exitCode }).then(() => resolve(result));
                };
                finish();
            });

            p.on("error", (err) => {
                detachLifecycle();
                const pWrite = cleanupProcess("failed", { error: auditLabel === undefined ? err.message : "Command spawn failed", exitCode: -1 });
                if (settled) return;
                settled = true;
                if (pWrite) void pWrite.then(() => reject(err), () => reject(err));
                else reject(err);
            });
        });
    }
}

const nativeRealpath = typeof realpathCallback?.native === "function"
    ? promisify(realpathCallback.native)
    : fs.realpath;

/** Bun 在 Linux 上会对 fs.realpath/realpath.native 词法折叠 ".."，POSIX 需逐段按内核语义解析符号链接 */
async function resolvePosixRealpath(inputPath: string): Promise<string> {
    if (!inputPath) {
        await fs.lstat(inputPath);
    }
    let absPath = inputPath;
    if (!absPath.startsWith("/")) {
        const procCwd = process.cwd();
        const sep = procCwd.endsWith("/") ? "" : "/";
        absPath = `${procCwd}${sep}${absPath}`;
    }
    let needDir = inputPath.length > 1 && inputPath.endsWith("/");
    const queue = absPath.split("/");
    let current = "/";
    let symlinkCount = 0;
    while (queue.length > 0) {
        const seg = queue.shift()!;
        if (seg === "" || seg === ".") continue;
        if (seg === "..") {
            current = path.posix.dirname(current);
            continue;
        }
        const next = current === "/" ? `/${seg}` : `${current}/${seg}`;
        const st = await fs.lstat(next);
        if (st.isSymbolicLink()) {
            if (++symlinkCount > 40) {
                throw Object.assign(
                    new Error(`ELOOP: too many levels of symbolic links, realpath '${inputPath}'`),
                    { code: "ELOOP" as const },
                );
            }
            const linkTarget = await fs.readlink(next);
            if (linkTarget.length > 1 && linkTarget.endsWith("/") && queue.every((s) => s === "")) {
                needDir = true;
            }
            if (linkTarget.startsWith("/")) current = "/";
            queue.unshift(...linkTarget.split("/"));
            continue;
        }
        if (!st.isDirectory() && (queue.some((s) => s !== "") || needDir)) {
            throw Object.assign(
                new Error(`ENOTDIR: not a directory, realpath '${inputPath}'`),
                { code: "ENOTDIR" as const },
            );
        }
        current = next;
    }
    return current;
}

/** 冻结后清点子孙的轮数：每轮捞到的新面孔都被停住，它们的子进程下一轮还挂在它们下面 */
const REAP_ROUNDS = 3;

/**
 * 收割一条被中止的命令的整棵进程树——不是只杀外层 shell。命令在子 shell 里跑，子 shell 及其
 * 子孙各是一个进程；只杀外层，其余的照跑到结束（两平台实测）。
 *
 * 命令与宿主同组（没有 detached，终端的 Ctrl-C 才连命令一起送），所以不能按组号杀，按父子表清点。
 * 先冻结再清点：成员被 SIGSTOP 后不再分叉，外层也不会先死——外层一死子孙就被过继给 init，
 * 父子链断了就再也找不回来。清点到不再有新面孔为止，然后逐个 SIGTERM、放开 SIGCONT。
 * Windows：见 reapCommandTreeWindows。取不到父子表（没有 /proc 也没有 ps）时退回只杀外层。
 */
function reapCommandTree(p: ChildProcess, shell: string): void {
    const pid = p.pid;
    if (!pid) return;
    if (process.platform === "win32") {
        reapCommandTreeWindows(pid, shell);
        return;
    }
    const frozen: number[] = [];
    const stop = (target: number): void => {
        try { process.kill(target, "SIGSTOP"); frozen.push(target); } catch { /* 已退出 */ }
    };
    stop(pid);
    for (let round = 0; round < REAP_ROUNDS; round++) {
        const table = processParentTable();
        if (!table) break;
        const found = descendants(table, pid).filter((q) => !frozen.includes(q));
        if (found.length === 0) break;
        for (const q of found) stop(q);
    }
    for (const q of frozen) { try { process.kill(q, "SIGTERM"); } catch { /* 已退出 */ } }
    for (const q of frozen) { try { process.kill(q, "SIGCONT"); } catch { /* 已退出 */ } }
}

/**
 * Windows 上收割整棵树。taskkill /T 沿 Windows 的父子链走，但 Git Bash（MSYS）每执行一个外部程序
 * 都是「fork 出中间进程、再 exec」，exec 出来的进程挂在随即退出的中间进程下——在 Windows 的父子表里
 * 是孤儿，taskkill 找不到；它若是脚本（`bash -c 'sleep 3; echo …'`），会接着把后面的命令跑完
 * （真机复现）。MSYS 自己的进程表（ps -e，带 WINPID 列）认得完整的一族：先按它清点，再对清点到的
 * 每个进程连同各自的 Windows 子树一起 taskkill。清点必须在杀之前——杀了之后父子关系就散了。
 * Git for Windows 的 bin/bash.exe 是原生启动器，先查它的原生子进程以找到实际的 MSYS 根。
 * ps 没有 WINPID 列或仍找不到根时，退回只对启动 PID 做 taskkill /T。
 */
function reapCommandTreeWindows(rootWinpid: number, shell: string): void {
    const args = ["/T", "/F"];
    for (const winpid of msysFamilyWinpids(shell, rootWinpid) ?? [rootWinpid]) args.push("/PID", String(winpid));
    // fire-and-forget 的 spawn 必须挂 error 监听：taskkill 取不到时异步 error 会崩宿主进程
    spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
}

/** 启动 PID 及从 MSYS 进程表查到的子孙 Windows PID。 */
function msysFamilyWinpids(shell: string, rootWinpid: number): number[] | null {
    const ps = spawnSync(shell, ["-c", "command -p ps -e"], { encoding: "utf-8", windowsHide: true });
    if (ps.error || ps.status !== 0 || !ps.stdout.includes("WINPID")) return null;
    // PID PPID PGID WINPID TTY UID STIME COMMAND：只取前四列数字（STIME 含空格，后面的不再解析）
    const rows: Array<{ pid: number; ppid: number; winpid: number }> = [];
    for (const line of ps.stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), winpid: Number(m[4]) });
    }
    const root = rows.find((r) => r.winpid === rootWinpid);
    // The Git launcher is absent from the MSYS table, but its actual Bash child appears there.
    const launchChildren = root ? undefined : windowsChildPids(rootWinpid);
    const roots = root ? [root] : rows.filter((r) => launchChildren?.has(r.winpid));
    if (!roots.length) return null;
    const parents = new Map(rows.map((r) => [r.pid, r.ppid]));
    const family = new Set(roots.flatMap((r) => [r.pid, ...descendants(parents, r.pid)]));
    return [...new Set([rootWinpid, ...rows.filter((r) => family.has(r.pid)).map((r) => r.winpid)])];
}

function windowsChildPids(pid: number): Set<number> {
    const result = spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | Select-Object -ExpandProperty ProcessId`,
    ], { encoding: "utf-8", windowsHide: true, timeout: 2500 });
    if (result.error || result.status !== 0) return new Set();
    return new Set(result.stdout.split(/\s+/).filter((value) => /^\d+$/.test(value)).map(Number));
}

/** pid → 父 pid。Linux 读 /proc，其余 POSIX 用 ps；取不到返回 null */
function processParentTable(): Map<number, number> | null {
    const table = new Map<number, number>();
    if (process.platform === "linux") {
        let names: string[];
        try { names = readdirSync("/proc"); } catch { return null; }
        for (const name of names) {
            if (!/^[0-9]+$/.test(name)) continue;
            try {
                // 形如 `pid (comm) state ppid …`：comm 可含空格与括号，从最后一个 ')' 之后取
                const stat = readFileSync(`/proc/${name}/stat`, "utf-8");
                table.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
            } catch { /* 进程已退出或无权读 */ }
        }
        return table;
    }
    const ps = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf-8", windowsHide: true });
    if (ps.error || ps.status !== 0) return null;
    for (const line of ps.stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (m) table.set(Number(m[1]), Number(m[2]));
    }
    return table;
}

function descendants(table: Map<number, number>, root: number): number[] {
    const out: number[] = [];
    let frontier = [root];
    while (frontier.length > 0) {
        const next: number[] = [];
        for (const [child, parent] of table) {
            if (frontier.includes(parent) && child !== root) {
                out.push(child);
                next.push(child);
            }
        }
        frontier = next;
    }
    return out;
}

async function resolveRealpath(inputPath: string): Promise<string> {
    return process.platform === "win32"
        ? await nativeRealpath(inputPath)
        : await resolvePosixRealpath(inputPath);
}

function sameOrAncestorPath(candidate: string, targetPath: string, isWin: boolean): boolean {
    const normA = isWin ? candidate.toLowerCase() : candidate;
    const normB = isWin ? targetPath.toLowerCase() : targetPath;
    const trailing = normA.endsWith(path.sep) ? "" : path.sep;
    return normA === normB || normB.startsWith(normA + trailing);
}

class LocalFileSystem implements FileSystemDriver {
    constructor(private readonly baseCwd?: string) {}

    private rawBaseCwd(): string {
        const procCwd = process.cwd();
        if (!this.baseCwd) return procCwd;
        if (path.isAbsolute(this.baseCwd)) return this.baseCwd;
        const sep = procCwd.endsWith(path.sep) ? "" : path.sep;
        return `${procCwd}${sep}${this.baseCwd}`;
    }

    /** 相对路径基于原始 descriptor.cwd 拼接，不做词法折叠以对齐 spawn({ cwd }) 的内核解析语义 */
    private resolve(filePath: string): string {
        if (!this.baseCwd || path.isAbsolute(filePath)) return filePath;
        const base = this.rawBaseCwd();
        const sep = base.endsWith(path.sep) ? "" : path.sep;
        return `${base}${sep}${filePath}`;
    }

    private async resolveEntryPath(filePath: string, opts?: { ignoreMissingParent?: boolean }): Promise<string | null> {
        let rawPath: string;
        if (path.isAbsolute(filePath)) {
            rawPath = filePath;
        } else {
            const base = this.rawBaseCwd();
            let resolvedBase: string;
            try {
                resolvedBase = await resolveRealpath(base);
            } catch (err) {
                if (opts?.ignoreMissingParent && (err as NodeJS.ErrnoException)?.code === "ENOENT") {
                    return null;
                }
                throw err;
            }
            const sep = resolvedBase.endsWith(path.sep) ? "" : path.sep;
            rawPath = `${resolvedBase}${sep}${filePath}`;
        }
        const rawParent = path.dirname(rawPath);
        const baseName = path.basename(rawPath);
        let realParent: string;
        try {
            realParent = await resolveRealpath(rawParent);
        } catch (err) {
            if (opts?.ignoreMissingParent && (err as NodeJS.ErrnoException)?.code === "ENOENT") {
                return null;
            }
            throw err;
        }
        return path.join(realParent, baseName);
    }

    async readFile(filePath: string): Promise<string> {
        return await fs.readFile(this.resolve(filePath), "utf-8");
    }

    async readFilePreview(filePath: string, maxOutputBytes: number): Promise<string> {
        const path = this.resolve(filePath);
        if (!(await fs.stat(path)).isFile()) throw new Error(`预览只支持普通文件：${filePath}`);
        const capture = await ExecCapture.fromFile(path, maxOutputBytes);
        return capture.result("");
    }

    /** 二进制安全读取（裸 base64——readFile 的 UTF-8 会破坏二进制字节） */
    async readBase64(filePath: string): Promise<string> {
        const buf = await fs.readFile(this.resolve(filePath));
        return Buffer.from(buf).toString("base64");
    }

    async writeFile(filePath: string, content: string, options?: { exclusive?: boolean }): Promise<void> {
        await fs.writeFile(this.resolve(filePath), content, {
            encoding: "utf-8",
            ...(options?.exclusive ? { flag: "wx" } : {}),
        });
    }

    async createFile(filePath: string, content: string): Promise<void> {
        await this.writeFile(filePath, content, { exclusive: true });
    }

    async exists(filePath: string): Promise<boolean> {
        try {
            await fs.access(this.resolve(filePath));
            return true;
        } catch {
            return false;
        }
    }

    async stat(filePath: string): Promise<{ mtimeMs: number; size: number; isDirectory: boolean } | null> {
        try {
            const st = await fs.stat(this.resolve(filePath));
            return { mtimeMs: st.mtimeMs, size: st.size, isDirectory: st.isDirectory() };
        } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT" || code === "ENOTDIR") return null;
            throw err;
        }
    }

    async readdir(dirPath: string): Promise<FileEntry[]> {
        const resolved = this.resolve(dirPath);
        const dirents = await fs.readdir(resolved, { withFileTypes: true });
        const sep = resolved.endsWith(path.sep) ? "" : path.sep;
        return await Promise.all(dirents.map(async (d) => {
            const stats = await fs.stat(`${resolved}${sep}${d.name}`).catch(() => null);
            return {
                name: d.name,
                isDirectory: d.isDirectory(),
                size: stats?.size,
                mtime: stats?.mtimeMs,
            };
        }));
    }

    async rm(filePath: string, options?: { recursive?: boolean; force?: boolean}): Promise<void> {
        const isWin = process.platform === "win32";
        const stripped = isWin ? filePath.replace(/[/\\]+$/, "") : filePath.replace(/\/+$/, "");
        if (!stripped || (isWin ? /(?:^|[/\\])\.{1,2}$/ : /(?:^|\/)\.{1,2}$/).test(stripped)) {
            throw new Error(`rm 拒绝危险或无效路径: ${filePath}`);
        }
        if (isWin && /^[A-Za-z]:[/\\]*$/.test(filePath)) {
            throw new Error(`rm 拒绝删除根目录: ${filePath}`);
        }
        const hasTrailingSep = isWin ? /[/\\]$/.test(filePath) : /\/$/.test(filePath);
        if (!options?.recursive && !options?.force && hasTrailingSep) {
            throw new Error(`rm 非递归删除需要单文件路径: ${filePath}`);
        }
        const baseCwdRaw = this.rawBaseCwd();
        const target = await this.resolveEntryPath(stripped, { ignoreMissingParent: options?.force });
        if (!target) return;
        if (hasTrailingSep) {
            const lstatSep = await fs.lstat(target).catch(() => null);
            if (lstatSep && (lstatSep.isSymbolicLink() || !lstatSep.isDirectory())) {
                throw new Error(`rm 目标不是真实目录（拒绝带尾分隔符的符号链接或文件）: ${filePath}`);
            }
        }
        if (target === path.parse(target).root) {
            throw new Error(`rm 拒绝删除根目录: ${filePath}`);
        }
        if (options?.recursive) {
            const realCwd = await resolveRealpath(baseCwdRaw).catch(() => path.resolve(baseCwdRaw));
            if (sameOrAncestorPath(target, realCwd, isWin)) {
                throw new Error(`rm 拒绝删除工作目录或上级目录: ${filePath}`);
            }
            const lstat = await fs.lstat(target).catch(() => null);
            if (lstat && !lstat.isSymbolicLink()) {
                const realTarget = await resolveRealpath(target).catch(() => null);
                if (realTarget && (realTarget === path.parse(realTarget).root
                    || sameOrAncestorPath(realTarget, realCwd, isWin))) {
                    throw new Error(`rm 拒绝删除工作目录或上级目录: ${filePath}`);
                }
            }
        }
        if (!options?.recursive && !options?.force) {
            await fs.unlink(target);
            return;
        }
        await fs.rm(target, options);
    }

    async mkdir(dirPath: string, options?: {recursive?: boolean}): Promise<void> {
        await fs.mkdir(this.resolve(dirPath), options);
    }

    async rename(from: string, to: string): Promise<void> {
        const isWin = process.platform === "win32";
        const hasTrailingOrDot = (p: string) => !p
            || (isWin
                ? /[/\\]$/.test(p) || /(?:^|[/\\])\.{1,2}$/.test(p) || /^[A-Za-z]:[/\\]*$/.test(p)
                : /\/$/.test(p) || /(?:^|\/)\.{1,2}$/.test(p));
        if (hasTrailingOrDot(from) || hasTrailingOrDot(to)) {
            throw new Error(`rename 需要精确的文件或目录路径: ${from} -> ${to}`);
        }
        const resolvedFrom = (await this.resolveEntryPath(from))!;
        const resolvedTo = (await this.resolveEntryPath(to))!;
        const destStat = await fs.stat(resolvedTo).catch(() => null);
        if (destStat?.isDirectory()) {
            throw new Error(`rename 失败（目标是现存目录）: ${from} -> ${to}`);
        }
        const srcStat = await fs.lstat(resolvedFrom);
        const destParentStat = await fs.stat(path.dirname(resolvedTo));
        if (srcStat.dev !== destParentStat.dev) {
            throw Object.assign(
                new Error(`rename 失败（不支持跨文件系统移动 EXDEV）: ${from} -> ${to}`),
                { code: "EXDEV" as const },
            );
        }
        if (srcStat.isDirectory()) {
            if (sameOrAncestorPath(resolvedFrom, resolvedTo, isWin)) {
                throw Object.assign(
                    new Error(`rename 失败（不能将目录移入自身或子目录 EINVAL）: ${from} -> ${to}`),
                    { code: "EINVAL" as const },
                );
            }
            const destLstat = destStat ?? await fs.lstat(resolvedTo).catch(() => null);
            if (destLstat) {
                throw new Error(`rename 失败（目标已存在）: ${from} -> ${to}`);
            }
        }
        await fs.rename(resolvedFrom, resolvedTo);
    }
}
