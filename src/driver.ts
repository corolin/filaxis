/**
 * driver.ts — RuntimeDriver 统一契约（多 Transport 执行内核）
 *
 * 净室平移自 个人Agent项目 `原内部模块`
 * ，按 REQ-0001 OSS 化改造：
 * - ExecResult 新增 stderr（FEAT-03：exec 通道 stdout/stderr 物理分离；源版无此字段）
 * - ExecOptions 新增 channel（FEAT-03：通道显式化 "exec" | "pty"，缺省 exec）
 * - 剔除 interactionManager/sessionId（凭据交互策略属 FEAT-12，M1 后续批次设计后进契约）
 * - capabilities 保留为纯数据标签（语义解释权归消费方；源注释中的策略引擎字样改为通用表述）
 *
 * 已知 driver 快捷方式（可自动生成 launchCmd）：
 *   "local"    — 进程内原生执行，唯一特殊值
 *   "ssh"      — ssh [-options] <target>
 *   "docker"   — <runtime> exec -i <target> <shell> -i  (runtime 默认 docker，可换 podman/nerdctl 等)
 *   "k8s"      — <runtime> exec -i [-n ns] <target> -- <shell> -i  (runtime 默认 kubectl，可换 oc/k3s 等)
 *   "teleport" — tsh ssh [--cluster=c] [login@]<target>
 *
 * 任意字符串也合法（e.g. "nix-shell", "conda", "distrobox"），
 * 但必须在 config.launchCmd 中提供完整的启动命令。
 */

export type RuntimeDriverType = "local" | "browser" | "ssh" | "docker" | "k8s" | (string & {});

export interface RuntimeDescriptor {
    driver: RuntimeDriverType;
    /** 连接目标（ssh: user@host；container: 容器名/ID；自定义: 任意标签） */
    target?: string;
    /** 驱动配置：sshOptions / shell / runtime / namespace / launchCmd 等 */
    config?: Record<string, unknown>;
    /** 持久会话 ID（tmux 后端管理的长连接标识，跨重启恢复用） */
    terminalId?: string;
    /**
     * 持久化的工作目录。调用方执行 cd 后异步更新，跨重启恢复时用于重建上下文。
     */
    cwd?: string;
    /**
     * 该运行时环境的能力标签列表（纯数据——消费方可据此做环境感知策略，
     * 内核不解释）。内置约定示例：
     *   "read-only"   — 禁止写操作
     *   "production"  — 生产环境，高危操作从严
     *   "sandbox"     — 沙箱环境，可放宽检查
     */
    capabilities?: string[];
}

/**
 * 执行通道（FEAT-03）：
 * - "exec"（缺省）——非 PTY 通道：stdout/stderr 物理分离；层上下文经
 *   cwd/env/enterSteps 管线重放拼装（独立 channel 复现层进入路径）
 * - "pty"——层内 PTY marker 协议：天然继承层内交互状态（su 身份/cd/export），
 *   stderr 混流为终端语义（不承诺分离）
 */
export type ExecChannel = "exec" | "pty";

export interface ExecOptions {
    timeoutMs?: number;
    env?: Record<string, string>;
    /** 临时覆盖命令执行路径 */
    cwd?: string;
    /** 执行通道（缺省 "exec"） */
    channel?: ExecChannel;
    /** AbortSignal 硬中断子进程：abort 时子进程立即 SIGTERM，Promise 以 AbortError reject */
    signal?: AbortSignal;
}

export interface ExecResult {
    stdout: string;
    /** exec 通道物理分离的 stderr；pty 通道下并入 stdout（终端语义） */
    stderr: string;
    exitCode: number;
    /** 执行完成时该通道命令上下文的有效用户（marker 尾缀 id -un 实测——层内 su/sudo 变更可追踪） */
    effectiveUser?: string;
}

export interface FileEntry {
    name: string;
    isDirectory: boolean;
    size?: number;
    mtime?: number;
}

export interface FileStat {
    mtimeMs: number;
    size: number;
}

export interface FileSystemDriver {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    readdir(path: string): Promise<FileEntry[]>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    /** 可选 stat（mtimeMs/size）——先读后写闸的数据依赖 */
    stat?(path: string): Promise<FileStat | null>;
    /**
     * 可选 readBase64——二进制安全读取。readFile 返回 UTF-8 字符串会破坏
     * 二进制字节；本方法返回裸 base64。local 层实现；远端层无此方法时
     * 调用方应显式处理「该层不支持二进制读取」。
     */
    readBase64?(path: string): Promise<string>;
}

import type {
    SessionStartOptions,
    SessionHandleInfo,
    WatchOptions,
    ReadLogOptions,
} from "./session-types.js";

export interface RuntimeDriver {
    // 基础信息
    descriptor: RuntimeDescriptor;

    // 核心环境能力
    exec(command: string, options?: ExecOptions): Promise<ExecResult>;

    // ── 长跑会话生命周期（execSession 即返 + 落盘日志 + 热窗口 + watcher）──
    /** 启动长跑会话（立即返回句柄：sessionId/logBase/pid——tail/readLog/watch/stop 用） */
    execSession(command: string, opts?: SessionStartOptions): Promise<SessionHandleInfo>;
    /** 热窗口快照：最近 n 行 */
    tailSession(sessionId: string, lines?: number): Promise<string[]>;
    /** 读会话日志文件（全量/大范围） */
    readSessionLog(sessionId: string, opts?: ReadLogOptions): Promise<string>;
    /** 注册 watcher：命中 → 会话事件（内核事件接口，见 FEAT-09） */
    watchSession(sessionId: string, opts: WatchOptions): { cancel(): void };
    /** 停止会话（SIGTERM→SIGKILL 升级；发出后核实终态）——status: exited/stopped/unknown */
    stopSession(sessionId: string): Promise<{ status: "exited" | "stopped" | "unknown"; exitCode?: number | null }>;
    /** 会话核实原语（unknown 闭环：stop 返回 unknown 后的可执行核实手段）：
     *  running=进程实测还在跑（remote 层含远端 kill -0/身份戳比对）；exited=已终态
     *  （含退出码）；unknown=探测通道本身不可达。绝不猜测 */
    verifySession(sessionId: string): Promise<{ status: "running" | "exited" | "unknown"; exitCode?: number | null }>;
    /** 会话列表 */
    listSessions(): Array<{ sessionId: string; command: string; running: boolean; startedAt: number }>;

    // 原生路径解析与环境获取
    getCwd(): Promise<string>;
    getEnv(key: string): Promise<string | undefined>;

    // 强隔离文件系统
    fs: FileSystemDriver;

    // 初始化与销毁
    init(): Promise<void>;
    destroy(): Promise<void>;
}
