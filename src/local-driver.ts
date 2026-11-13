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
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";import { StringDecoder } from "node:string_decoder";

import path from "node:path";
import { tmpdir } from "node:os";
import * as crypto from "node:crypto";
import type {
    RuntimeDriver,
    FileSystemDriver,
    FileEntry,
    ExecOptions,
    ExecResult,
    RuntimeDescriptor,
} from "./driver.js";
import {
    LocalSessionManager,
} from "./local-session-manager.js";
import type {
    SessionStartOptions,
    SessionHandleInfo,
    WatchOptions,
    ReadLogOptions,
} from "./session-types.js";
import type { FilaxisLogger } from "./logger.js";
import { noopLogger } from "./logger.js";
import { resolveLocalShell } from "./shell-discovery.js";

export interface LocalDriverOptions {
    /** 缺省工作目录 */
    cwd?: string;
    /** exec 状态/日志目录（缺省 os.tmpdir()/filaxis-exec） */
    execDir?: string;
    /** 执行 shell（缺省 bash） */
    shell?: string;
    logger?: FilaxisLogger;
}

/** 本地 Transport：进程内执行 + 原生 fs */
export class LocalRuntimeDriver implements RuntimeDriver {
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

    async destroy() {
        // 会话引擎句柄保留 TTL 自回收；此处无强制清理面（processMgr 属后续批次）
    }

    async getCwd(): Promise<string> {
        return this.defaultCwd || process.cwd();
    }

    async getEnv(key: string): Promise<string | undefined> {
        return process.env[key];
    }

    // ── 会话式 exec（委托 LocalSessionManager）──
    async execSession(command: string, opts?: SessionStartOptions): Promise<SessionHandleInfo> {
        return this.sessions.start(command, opts);
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

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
        if (options?.channel === "pty") {
            throw new Error('local Transport 不支持 channel:"pty"（PTY 交互语义属远端 Transport；本地 exec 通道天然分离且恒可用）');
        }

        await fs.mkdir(this.execDir, { recursive: true });
        const taskId = crypto.randomBytes(8).toString("hex");
        const logPath = path.join(this.execDir, `${taskId}.log`);
        const statusPath = path.join(this.execDir, `${taskId}.status.json`);

        // FEAT-03 marker：子 shell 包裹业务命令，$? 变量锁 + nonce 防撞——
        // 用户命令内写 exit 42 也不丢退出码与 effectiveUser
        const nonce = crypto.randomBytes(6).toString("hex");
        const marker = `__FILAXIS_META_${nonce}__`;
        const wrapped =
            // 命令上下强制换行（审计 M4）：尾注释吞码/显式 exit 的捕获隔离
            `(\n${command}\n); __filaxis_ec=$?; ` +
            `printf '\\n${marker}:%d:%s\\n' "$__filaxis_ec" "$(id -un 2>/dev/null)"; ` +
            `exit $__filaxis_ec`;

        return new Promise<ExecResult>((resolve, reject) => {
            let stdout = "";
            let stderr = "";

            const env = { ...process.env, ...options?.env };
            const cwd = options?.cwd || this.defaultCwd || process.cwd();

            // 不使用 shell: true——Node 会再包一层 sh -c，stdin 读取类命令（wc、无参 cat）挂死。
            // 命令经 stdin 喂 `shell -s`（自排查·八轮顺藤：-c 走 argv 受 Windows 32767
            // 字符上限——file-transfer 48K chunk 命令本机层 ENAMETOOLONG；与 ssh
            // execChannel 同形态。sh -s 把 stdin 整流消费为脚本，脚本内 cat/wc 再读
            // stdin = EOF——与旧 stdin:"ignore" 语义一致，零行为变化）
            const p = spawn(this.shell, ["-s"], {
                env,
                cwd,
                stdio: ["pipe", "pipe", "pipe"],
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
            const writeStatus = async (status: string, extra: Record<string, unknown> = {}) => {
                try {
                    await fs.writeFile(statusPath, JSON.stringify({
                        pid: p.pid,
                        command,
                        status,
                        startTime,
                        endTime: Date.now(),
                        ...extra,
                    }, null, 2), "utf-8");
                } catch { /* 状态文件写入失败不影响主流程 */ }
            };
            void writeStatus("running");

            let settled = false;
            let finished = false;
            const logStream = createWriteStream(logPath);
            // error 监听 + 终结守卫（Hydrogen R5 #1）：超时/abort 设计=进程后台续跑，
            // 其后任意输出再进 logStream.write=ERR_STREAM_WRITE_AFTER_END 崩宿主
            // （无 error 监听时同步抛）。写日志尽力而为——失败吞掉，data 侧判 finished
            logStream.on("error", () => undefined);
            // StringDecoder 双流（Hydrogen R5 #4）：跨块多字节 UTF-8 撕裂防护
            const oDec = new StringDecoder("utf-8");
            const eDec = new StringDecoder("utf-8");
            p.stdout.on("data", (d: Buffer) => { stdout += oDec.write(d); if (!finished) logStream.write(d); });
            p.stderr.on("data", (d: Buffer) => { stderr += eDec.write(d); if (!finished) logStream.write(d); });


            const cleanupProcess = (exitStatus: string, extra: Record<string, unknown> = {}) => {
                if (finished) return;
                finished = true;
                logStream.end();
                return writeStatus(exitStatus, extra);
            };
            const detachLifecycle = () => {
                if (timeout) clearTimeout(timeout);
                if (onAbort) signal?.removeEventListener("abort", onAbort);
            };

            // timeoutMs 守卫（Hydrogen R9 #4）：0/负/NaN 曾被 falsy 判断静默禁用
            // （永不超时）或立即触发——显式拒绝
            if (options?.timeoutMs != null && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
                throw new Error(`timeoutMs 非法（${options.timeoutMs}）——须为正整数毫秒`);
            }
            const timeout = options?.timeoutMs ? setTimeout(() => {
                if (settled) return;
                settled = true;
                finished = true; // 审计终态封口（审查问题 3：后台进程晚死时 close 不得把 timeout 覆写成 completed）
                detachLifecycle();
                // 超时=放弃该进程（继续后台写日志）。此时才 unref：被放弃的子进程
                // 不应撑事件循环。⚠️ 不能 spawn 后立即 unref——Bun 下 unref 子进程
                // 不保活事件循环，低活动场景 close 事件永不触发，exec 静默挂死。
                p.unref();
                logStream.end();
                void writeStatus("timeout", { error: "Command timeout", exitCode: null });
                const e = new Error(`Command timeout after ${options.timeoutMs}ms (process continues in background, log: ${logPath}, status: ${statusPath})`) as Error & { outcome: "unknown" };
                e.outcome = "unknown"; // 远端/本地进程终态未核实——审查问题 3：对齐 ssh 侧语义
                reject(e);
            }, options.timeoutMs) : null;

            const signal = options?.signal;
            const onAbort = signal ? () => {
                if (settled) return;
                settled = true;
                finished = true; // 审计终态封口（close 不得覆写 aborted）
                detachLifecycle();
                try { p.kill("SIGTERM"); } catch { /* 已退出 */ }
                logStream.end();
                void writeStatus("aborted", { error: "Aborted by AbortSignal", exitCode: null });
                const abortErr = new Error("Command aborted by AbortSignal（本地进程已 SIGTERM，终态未核实——outcome=unknown）") as Error & { name: "AbortError"; outcome: "unknown" };
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
                            out = out.slice(0, mIdx); // mIdx 处的 \n 是 printf 的，连同剥掉
                        }
                    }
                    // ★ 审计与事实对齐（审查问题 3）：先验哨兵，后写审计——
                    //   completed 只在有哨兵时落盘（exitCode 用哨兵真实码）；
                    //   无哨兵落 killed + exitCode null（绝不把 null ?? 0 伪成完成）
                    logStream.end();
                    if (sentinelCode === undefined) {
                        void writeStatus("killed", { exitCode: null, closeCode: code ?? null, stdinError: stdinErr?.message });
                        const e = new Error(
                            `命令未完成（无完成哨兵——进程被信号终止，close code=${code}）${stdinErr ? `；stdin 管道错误: ${stdinErr.message}` : ""}。半截现场 stdout 尾 500:\n${out.slice(-500)}\nstderr 尾 300:\n${stderr.slice(-300)}`,
                        ) as Error & { outcome: "unknown" };
                        e.outcome = "unknown";
                        reject(e);
                        return;
                    }
                    void writeStatus("completed", { exitCode: sentinelCode });
                    resolve({ stdout: out, stderr, exitCode: sentinelCode, effectiveUser });
                };
                finish();
            });

            p.on("error", (err) => {
                detachLifecycle();
                const pWrite = cleanupProcess("failed", { error: err.message, exitCode: -1 });
                if (settled) return;
                settled = true;
                if (pWrite) void pWrite.then(() => reject(err), () => reject(err));
                else reject(err);
            });
        });
    }
}

class LocalFileSystem implements FileSystemDriver {
    constructor(private readonly baseCwd?: string) {}

    /** 相对路径基于 descriptor.cwd 解析（Hydrogen R10 #1：与 ssh 层 execChannel
     *  的 cwd 继承对齐——曾直接落 process.cwd=跨后端行为不一致） */
    private resolve(filePath: string): string {
        return this.baseCwd ? path.resolve(this.baseCwd, filePath) : filePath;
    }

    async readFile(filePath: string): Promise<string> {
        return await fs.readFile(this.resolve(filePath), "utf-8");
    }

    /** 二进制安全读取（裸 base64——readFile 的 UTF-8 会破坏二进制字节） */
    async readBase64(filePath: string): Promise<string> {
        const buf = await fs.readFile(this.resolve(filePath));
        return Buffer.from(buf).toString("base64");
    }

    async writeFile(filePath: string, content: string): Promise<void> {
        await fs.writeFile(this.resolve(filePath), content, "utf-8");
    }

    async exists(filePath: string): Promise<boolean> {
        try {
            await fs.access(this.resolve(filePath));
            return true;
        } catch {
            return false;
        }
    }

    async stat(filePath: string): Promise<{ mtimeMs: number; size: number } | null> {
        try {
            const st = await fs.stat(this.resolve(filePath));
            return { mtimeMs: st.mtimeMs, size: st.size };
        } catch {
            return null;
        }
    }

    async readdir(dirPath: string): Promise<FileEntry[]> {
        const dirents = await fs.readdir(dirPath, { withFileTypes: true });
        return await Promise.all(dirents.map(async (d) => {
            const stats = await fs.stat(path.join(dirPath, d.name)).catch(() => null);
            return {
                name: d.name,
                isDirectory: d.isDirectory(),
                size: stats?.size,
                mtime: stats?.mtimeMs,
            };
        }));
    }

    async rm(filePath: string, options?: { recursive?: boolean; force?: boolean}): Promise<void> {
        await fs.rm(this.resolve(filePath), options);
    }

    async mkdir(dirPath: string, options?: {recursive?: boolean}): Promise<void> {
        await fs.mkdir(this.resolve(dirPath), options);
    }
}
