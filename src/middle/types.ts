/**
 * middle/types.ts — 中层对外类型（REQ-0004 §5）
 *
 * 命名约定：中层操作的参数与结果统一 camelCase（即 TypeScript 类型原样）。snake_case
 * 只属于 MCP 工具面，由工具面适配器（agent-toolkit.ts）投影。
 */
import type { FileEntry, RuntimeDescriptor } from "../core/base/driver.js";
import type { BatchLayerTarget, BatchPlan, BatchReport } from "../core/file/batch.js";
import type { StreamFrame } from "../core/stream/stream-window.js";
import type { FileTransferTransport, LayerFileTransferResult } from "../core/file/layer-file-transfer.js";
import type { CloseForwardResult, ForwardInfo, OpenForwardSpec } from "../core/ssh/ssh-forward.js";
import type { EditFileResult } from "../core/file/file-edit.js";
import type { StackFeatures } from "./runtime-stack.js";

/**
 * 层引用——把「在哪一层上执行」说清楚的三种写法：
 * - 字符串或 { layer }：命名层（已注册，或在已存层表里——按需加载，不抢默认层）
 * - { descriptor, name? }：临时目标（CLI 的 --host 族、connect_layer 的参数）；
 *   给 name 则登记为命名层，不给则按连接指纹登记为一个临时命名层
 * - undefined：默认层
 */
export type LayerRef = string | { layer: string } | { descriptor: RuntimeDescriptor; name?: string } | undefined;

export type StreamFilter = "stdout" | "stderr" | "both";
export type StreamName = "stdout" | "stderr";

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    effectiveUser?: string;
}

export interface SessionHandle {
    sessionId: string;
    logBase: string;
    note?: string;
}

export interface SessionStopResult {
    status: "exited" | "stopped" | "unknown";
    exitCode?: number | null;
    note?: string;
}

export interface ObserveLine {
    stream: StreamName;
    text: string;
}

export interface ObserveResult {
    lines: ObserveLine[];
    stopStatus: "exited" | "stopped" | "unknown";
    verifyStatus?: "running" | "exited" | "unknown";
    verifyError?: string;
    sessionId: string;
    logBase: string;
}

export type ReadPathResult =
    | { path: string; type: "file"; content: string; size: number; mtimeMs: number }
    | { path: string; type: "directory"; entries: FileEntry[] };

export interface WriteFileResult {
    path: string;
    created: boolean;
    bytesAfter: number;
}

export type ManagePathResult =
    | { action: "mkdir"; path: string; created: true }
    | { action: "move"; path: string; destination: string; moved: true }
    | { action: "delete"; path: string; deleted: true; recursive: boolean };

export interface StreamResult {
    windowId: string;
    name?: string;
    layer?: string;
    oldestSeq: number;
    newestSeq: number;
    stale: boolean;
    frames: StreamFrame[];
    exitCode?: number | null;
    error?: string;
    lastDeliveredSeq?: number;
    gap?: boolean;
    /** 等待了 waitMs 仍一帧未到 */
    timedOut?: boolean;
}

export interface StreamSummary {
    windowId: string;
    name?: string;
    layer: string;
    command: string;
    oldestSeq: number;
    newestSeq: number;
    stale: boolean;
    closed: boolean;
}

export interface LayerInfo {
    name: string;
    driver: string;
    target?: string;
}

export interface ConnectSshResult {
    layer: string;
    reused: boolean;
    reusedFrom?: string;
    note?: string;
}

export interface ConnectSshTarget {
    host: string;
    port?: number;
    user?: string;
    key?: string;
    jump?: string;
    name?: string;
}

export interface ConnectSshBatchResult {
    status: "ok" | "partial" | "fail";
    activeLayer?: string;
    layers: string[];
    results: Array<{ host: string; name: string } & (
        ({ status: "ok" } & ConnectSshResult) | { status: "fail"; error: string }
    )>;
}

export interface ConnectIntoResult {
    layer: string;
    target?: string;
}

export interface ProbeLayerResult {
    key: string;
    spec: unknown;
    note?: string;
}

/** 中层操作集——唯一的一份操作实现；Daemon RPC、SDK、CLI、MCP 都调用它 */
export interface MiddleOps {
    features(): Promise<StackFeatures>;

    // ── 层 ──
    /** 登记（或幂等复用）一个 SSH 命名层 */
    connectSsh(target: ConnectSshTarget): Promise<ConnectSshResult>;
    /** 逐个登记一批 SSH 目标；单个失败不中断，逐个报告 */
    connectSshBatch(targets: ConnectSshTarget[]): Promise<ConnectSshBatchResult>;
    /** 从已有层进入内层环境（docker exec / ssh 等），派生一个新层 */
    connectInto(args: { enterCmd: string; label?: string; from?: string; name?: string }): Promise<ConnectIntoResult>;
    listLayers(): Promise<{ text: string; layers: LayerInfo[] }>;
    activateLayer(args: { layer: string }): Promise<{ layer: string }>;
    removeLayer(args: { layer: string; destroy?: boolean }): Promise<{ layer: string }>;
    probeLayer(args: { layer?: LayerRef }): Promise<ProbeLayerResult>;

    // ── 执行 ──
    /** 等完成拿退出码。非零退出码是数据不是异常；pty 走终端通道 */
    runCommand(args: { layer?: LayerRef; command: string; timeoutMs?: number; pty?: boolean; cwd?: string }): Promise<ExecResult>;
    /** 计划校验、层通配展开、commandFile 内联都在这里做完，再交内核 */
    runBatch(args: {
        plan: BatchPlan;
        layer?: BatchLayerTarget;
        previewBudgetBytes?: number;
        /** 未指定层的步骤落在哪一层（缺省=中层的默认层）。CLI 传本机层——命令行没写目标就是本机 */
        defaultLayer?: LayerRef;
        /** 调用方已知的层描述符（已存层表的当前内容，路径已按调用方解析）：命中时优先于中层自己的层表 */
        layers?: Record<string, RuntimeDescriptor>;
        /** 默认层是本机层时的命令工作目录 */
        cwd?: string;
    }): Promise<BatchReport>;
    startSession(args: { layer?: LayerRef; command: string; name?: string; cwd?: string; readyMarker?: string; errorPattern?: string }): Promise<SessionHandle>;
    /** 停止是请求、死亡须核实；unknown 不是成功也不是失败 */
    stopSession(args: { sessionId: string; layer?: string }): Promise<SessionStopResult>;
    /** 限时观察：起会话 → 等 durationMs → 读日志 → 停 → 必要时核实 */
    observe(args: { layer?: LayerRef; command: string; stream?: StreamFilter; durationMs?: number; cwd?: string }): Promise<ObserveResult>;

    // ── 文件 ──
    readFile(args: { layer?: LayerRef; path: string }): Promise<{ content: string }>;
    readPath(args: { layer?: LayerRef; path: string }): Promise<ReadPathResult>;
    writeFile(args: { layer?: LayerRef; path: string; content: string; overwrite?: boolean; createDirs?: boolean }): Promise<WriteFileResult>;
    /** 受控编辑（CAS）：版本变了拒绝写回 */
    editFile(args: { layer?: LayerRef; path: string; old: string; new: string; all?: boolean; writeMode?: "auto" | "inplace" }): Promise<EditFileResult>;
    managePath(args: {
        layer?: LayerRef; action: "mkdir" | "move" | "delete"; path: string;
        destination?: string; recursive?: boolean; parents?: boolean;
    }): Promise<ManagePathResult>;
    transferFile(args: {
        layer?: LayerRef; direction: "put" | "get"; localPath: string; remotePath: string;
        transport?: FileTransferTransport; timeoutMs?: number; writeMode?: "auto" | "inplace";
    }): Promise<LayerFileTransferResult>;

    // ── 观察窗 ──
    /** `cwd`：本机层的命令工作目录——经 Daemon 时它的工作目录与调用方无关，要由调用方传进来 */
    openStream(args: { layer?: LayerRef; command: string; stream?: StreamFilter; name?: string; limit?: number; waitMs?: number; cwd?: string }): Promise<StreamResult>;
    peekStream(args: {
        windowId: string; afterSeq?: number; beforeSeq?: number; windowMs?: number;
        limit?: number; waitMs?: number; stream?: StreamFilter;
    }): Promise<StreamResult>;
    closeStream(args: { windowId: string }): Promise<{ windowId: string; closed: true }>;
    listStreams(): Promise<{ streams: StreamSummary[] }>;

    // ── 转发 ──
    openForward(args: { layer?: LayerRef; spec: OpenForwardSpec }): Promise<ForwardInfo>;
    /** 缺省只列在用的；已停止/已退出的条目是幂等判定的墓碑 */
    listForwards(args?: { layer?: string; includeClosed?: boolean }): Promise<{ forwards: ForwardInfo[] }>;
    closeForward(args: { forwardId: string; layer?: string }): Promise<CloseForwardResult>;
}

export interface MiddleHost {
    kind: "in-process" | "daemon";
    version: string;
    protocolVersion: number;
    pid?: number;
}

/** 界面层看到的全部：三种宿主（Daemon 进程 / 进程内长驻 / 进程内即弃）同一个接口 */
export interface Middle {
    readonly host: MiddleHost;
    readonly ops: MiddleOps;
    /** 销毁观察窗、会话跟踪与自建的观察窗注册表（同步部分） */
    dispose(): void;
    /** 宿主退出前的收尾：销毁本实例拥有的 driver。远程形态是空操作（状态在 Daemon 进程里） */
    shutdown(): Promise<void>;
}
