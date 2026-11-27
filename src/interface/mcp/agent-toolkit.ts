/**
 * agent-toolkit.ts — 原生 Agent 工具集（12 工具 `verb_noun` 收敛版）
 *
 * 一行 `createAgentToolkit(stack)` 生成 LLM 工具面——OpenAI/Anthropic/Vercel AI SDK
 * 通吃的 {tools, handlers} 双层结构：定义层喂模型，执行层留宿主（桥到任意框架）。
 * 语义契约（退出码是数据/终态三态/就绪握手）由内核承载，宿主零胶水。
 *
 * 工具面：run_batch / run_command / start_session / stop_session /
 * observe_stream / close_stream / read_path / edit_file / manage_path /
 * transfer_file / connect_layer / manage_layers
 */
import type { StreamFrame, StreamWindowRegistry } from "../../core/stream/stream-window.js";
import type { RuntimeStack } from "../../middle/runtime-stack.js";
import type { FileTransferTransport, LayerFileTransferResult } from "../../core/file/layer-file-transfer.js";
import type { TransferResult } from "../../core/file/file-transfer.js";
import type { FileEntry, RuntimeDescriptor, RuntimeDriver } from "../../core/base/driver.js";
import type { StopResult } from "../../middle/session-ownership.js";
import type { BatchLayerTarget, BatchPlan, BatchStepWithDeps } from "../../core/file/batch.js";
import type { CloseForwardResult, DynamicForwardKind, ForwardInfo, ForwardStatus, ForwardTransportMode, OpenForwardSpec } from "../../core/ssh/ssh-forward.js";
import { assertSshTargetRoutable, BATCH_STEP_KINDS, createMiddle, type LocalMiddle } from "../../middle/middle.js";
import type {
    ConnectSshBatchResult as MiddleConnectSshBatchResult,
    ConnectSshResult as MiddleConnectSshResult,
    StreamResult,
} from "../../middle/types.js";
import { isAbsolute as pathIsAbsolute, resolve as pathResolve } from "node:path";
import { callerCwd } from "./call-context.js";

// ── 转发记录的工具面投影（REQ-0004 §5.2）──
// snake_case 只属于 MCP 工具面：中层的记录与 CLI --json 是 camelCase，这里是唯一的
// 转换点。forwardId 保留为兼容别名（0.2.13 引入；工具名与 schema 在 0.3.0 不变）。
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
export interface AgentToolDef {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>; // JSON Schema
    };
}

interface AgentFileTransferArgs {
    local_path: string;
    remote_path: string;
    layer?: string;
    transport?: FileTransferTransport;
    timeout_ms?: number;
}

type AgentFilePutArgs = AgentFileTransferArgs & { write_mode?: "auto" | "inplace" };
type AgentFileTransferResult = Omit<TransferResult, "writeMode"> & {
    transport: FileTransferTransport;
    write_mode: TransferResult["writeMode"];
};

function agentTransferResult({ writeMode, ...result }: LayerFileTransferResult): AgentFileTransferResult {
    return { ...result, write_mode: writeMode };
}

export interface ConnectSshTarget {
    host: string;
    port?: number;
    user?: string;
    key?: string;
    jump?: string;
    name?: string;
}

export interface ConnectSshResult {
    layer: string;
    reused: boolean;
    reused_from?: string;
    note?: string;
}

export interface ConnectSshBatchArgs {
    targets: Array<string | ConnectSshTarget>;
}

export interface ConnectSshBatchResult {
    status: "ok" | "partial" | "fail";
    active_layer?: string;
    layers: string[];
    results: Array<{ host: string; name: string } & (
        ({ status: "ok" } & ConnectSshResult) | { status: "fail"; error: string }
    )>;
}

export type ConnectIntoArgs =
    | { enter_cmd: string; label?: string; from?: string; name?: string }
    | { enter_command: string; label?: string; from?: string; name?: string }
    | { enterCommand: string; label?: string; from?: string; name?: string }
    | { enterCmd: string; label?: string; from?: string; name?: string };

export type PushSshTarget = ConnectSshTarget;
export type PushSshResult = ConnectSshResult;
export type PushSshBatchArgs = ConnectSshBatchArgs;
export type PushSshBatchResult = ConnectSshBatchResult;

export interface ConnectIntoResult {
    layer: string;
    target?: string;
}

export interface ObserveStreamResult {
    window_id: string;
    name?: string;
    oldest_seq: number;
    newest_seq: number;
    stale: boolean;
    frames: StreamFrame[];
    last_delivered_seq?: number;
    gap?: boolean;
    timed_out?: boolean;
    exit_code?: number | null;
    error?: string;
}

export type ReadPathResult =
    | { path: string; type: "file"; content: string; size: number; mtime_ms: number }
    | { path: string; type: "directory"; entries: FileEntry[] };

export type AgentEditFileResult =
    | {
        mode: "edit";
        path: string;
        occurrences: number;
        bytes_before: number;
        bytes_after: number;
        mutex?: "flock" | "degraded";
        write_mode?: "atomic-replace" | "inplace-write";
    }
    | {
        mode: "write";
        path: string;
        created: boolean;
        bytes_after: number;
    };

export type ManagePathResult =
    | { action: "mkdir"; path: string; created: true }
    | { action: "move"; path: string; destination: string; moved: true }
    | { action: "delete"; path: string; deleted: true; recursive: boolean };

export type ManageLayersResult =
    | { action: "list"; text: string; layers: Array<{ name: string; driver: string; target?: string }> }
    | { action: "activate"; active_layer: string }
    | { action: "remove"; removed: string }
    // 转发记录对外为 snake_case 投影（forward_id、bind_addr…；forwardId 为兼容别名）——
    // 与本工具的参数命名和 observe_stream 的 window_id 同一风格
    | { action: "forward_add"; forward: PublicForwardInfo }
    | { action: "forward_list"; forwards: PublicForwardInfo[] }
    | { action: "forward_remove"; forward_id: string; status: "stopped" | "already_closed" | "unknown"; detail?: string };

export interface AgentToolHandlers {
    run_command(args: { command: string; timeout_ms?: number; layer?: string }): Promise<{
        stdout: string; stderr: string; exit_code: number; effective_user?: string;
    }>;
    read_path(args: { path: string; layer?: string }): Promise<ReadPathResult>;
    edit_file(args: { path: string; old: string; new: string; all?: boolean; write_mode?: "auto" | "inplace"; layer?: string }): Promise<Extract<AgentEditFileResult, { mode: "edit" }>>;
    edit_file(args: { path: string; content: string; overwrite?: boolean; create_dirs?: boolean; layer?: string }): Promise<Extract<AgentEditFileResult, { mode: "write" }>>;
    manage_path(args: { action: "mkdir"; path: string; parents?: boolean; layer?: string }): Promise<Extract<ManagePathResult, { action: "mkdir" }>>;
    manage_path(args: { action: "move"; path: string; destination: string; layer?: string }): Promise<Extract<ManagePathResult, { action: "move" }>>;
    manage_path(args: { action: "delete"; path: string; recursive?: boolean; layer?: string }): Promise<Extract<ManagePathResult, { action: "delete" }>>;
    transfer_file(args: { direction: "put" } & AgentFilePutArgs): Promise<AgentFileTransferResult & { direction: "put" }>;
    transfer_file(args: { direction: "get" } & AgentFileTransferArgs): Promise<AgentFileTransferResult & { direction: "get" }>;
    observe_stream(args: {
        command: string; stream?: "stdout" | "stderr" | "both"; name?: string; layer?: string; limit?: number; wait_ms?: number;
    }): Promise<ObserveStreamResult>;
    observe_stream(args: {
        window_id: string; limit?: number; since_seq?: number; before_seq?: number; window_ms?: number; wait_ms?: number;
    }): Promise<ObserveStreamResult>;
    close_stream(args: { window_id: string }): Promise<{ window_id: string; closed: true }>;
    start_session(args: { command: string; ready_marker?: string; error_pattern?: string; name?: string; layer?: string }): Promise<{
        session_id: string; log_base: string; note?: string;
    }>;
    stop_session(args: { session_id: string; layer?: string }): Promise<StopResult>;
    // ── 层族（命名层注册表——Paramiko 式句柄寻址）──
    connect_layer(args: ConnectSshBatchArgs & Partial<Record<Exclude<keyof ConnectSshTarget, "name"> | "enter_cmd" | "enter_command" | "enterCommand" | "enterCmd" | "label" | "from", never>>): Promise<ConnectSshBatchResult>;
    connect_layer(args: ConnectSshTarget & { targets?: never } & Partial<Record<"enter_cmd" | "enter_command" | "enterCommand" | "enterCmd" | "label" | "from", never>>): Promise<ConnectSshResult>;
    connect_layer(args: ConnectIntoArgs & Partial<Record<Exclude<keyof ConnectSshTarget, "name"> | "targets", never>>): Promise<ConnectIntoResult>;
    manage_layers(args: { action: "list" }): Promise<Extract<ManageLayersResult, { action: "list" }>>;
    manage_layers(args: { action: "activate"; name: string }): Promise<Extract<ManageLayersResult, { action: "activate" }>>;
    manage_layers(args: { action: "remove"; name: string; destroy?: boolean }): Promise<Extract<ManageLayersResult, { action: "remove" }>>;
    manage_layers(args: {
        action: "forward_add";
        kind: "local" | "remote" | "dynamic" | "L" | "R" | "D";
        bind_port?: number;
        bind_addr?: string;
        target_host?: string;
        target_port?: number;
        forward_id?: string;
        timeout_ms?: number;
        layer?: string;
    }): Promise<Extract<ManageLayersResult, { action: "forward_add" }>>;
    manage_layers(args: { action: "forward_list"; layer?: string; include_closed?: boolean }): Promise<Extract<ManageLayersResult, { action: "forward_list" }>>;
    manage_layers(args: { action: "forward_remove"; forward_id: string; layer?: string }): Promise<Extract<ManageLayersResult, { action: "forward_remove" }>>;
    // ── 兼容 0.2.10 旧工具名直调（不进入 tools/list，仅 handlers/MCP call 适配器）──
    spawn_and_observe(args: { command: string; ready_marker?: string; error_pattern?: string; name?: string; layer?: string }): Promise<{
        session_id: string; log_base: string; note?: string;
    }>;
    stop_and_verify(args: { session_id: string; layer?: string }): Promise<StopResult>;
    read_file(args: { path: string; layer?: string }): Promise<{ path: string; content: string; size: number; mtime_ms: number }>;
    list_directory(args: { path: string; layer?: string }): Promise<{ path: string; entries: FileEntry[] }>;
    delete_file(args: { path: string; layer?: string }): Promise<{ path: string; deleted: true }>;
    put_file(args: AgentFilePutArgs): Promise<AgentFileTransferResult>;
    get_file(args: AgentFileTransferArgs): Promise<AgentFileTransferResult>;
    read_stream(args: { window_id: string; limit?: number; since_seq?: number; before_seq?: number; window_ms?: number; wait_ms?: number }): Promise<ObserveStreamResult>;
    push_ssh(args: ConnectSshBatchArgs & Partial<Record<keyof ConnectSshTarget, never>>): Promise<ConnectSshBatchResult>;
    push_ssh(args: ConnectSshTarget & { targets?: never }): Promise<ConnectSshResult>;
    push_into(args: ConnectIntoArgs): Promise<ConnectIntoResult>;
    list_layers(args?: Record<string, never>): Promise<{
        text: string; layers: Array<{ name: string; driver: string; target?: string }>;
    }>;
    set_active_layer(args: { name: string }): Promise<{ active_layer: string }>;
    remove_layer(args: { name: string; destroy?: boolean }): Promise<{ removed: string }>;
    // ── 批次组合（一次调用描述多原子操作——减少 Planner 轮次）──
    run_batch(args: { steps: Array<Record<string, unknown>>; stop_on_fail?: boolean; max_parallel?: number; layer?: BatchLayerTarget; output?: "text" | "full" }): Promise<{
        status: "ok" | "fail"; failed_step?: string;
        steps: Array<{
            id: string; layer?: string; kind: string; status: string; exit_code?: number; outcome?: "unknown"; stdout?: string; stderr?: string; error?: string; skipped_because?: string;
            transfer?: AgentFileTransferResult;
            edits?: { path: string; occurrences: number; bytes_before: number; bytes_after: number; hunks: Array<{ old: string; new: string; occurrences: number }>; mutex?: "flock" | "degraded"; write_mode?: "atomic-replace" | "inplace-write" };
        }>;
    }>;
}

export interface AgentToolkit {
    tools: AgentToolDef[];
    handlers: AgentToolHandlers;
    /** 工具面绑定的层（缺省 local；远端层经 stack.connect 后传入重绑） */
    readonly layer: Promise<RuntimeDriver>;
    dispose?(): void;
}

export interface AgentToolkitOptions {
    /** 层描述符（缺省 local）；也可直接传已连接的 driver */
    descriptor?: { driver: string; target?: string; config?: Record<string, unknown> };
    driver?: RuntimeDriver;
    /** 外部共享观察窗注册表（Daemon/Proxy 共享现场时注入；省略则每工具集自建自销） */
    windowRegistry?: StreamWindowRegistry;
    /** 就绪握手与 watcher 轮询的超时上限 */
    readyTimeoutMs?: number;
    /** Retain confirmed results after releasing their driver reference. */
    sessionResultTtlMs?: number;
    /** Interval for checking tracked sessions and expiring results. */
    sessionCheckIntervalMs?: number;
    /** 已存层表（`filaxis layer save` 的产物）的读取函数，按需调用、不缓存——入口注入
     *  （filaxis-mcp 与 Daemon 传 loadLayerStore）。工具集自身不读用户目录：未注入时
     *  行为与从前一致。未注册的层名或层通配命中这里的条目时按需注册（不抢默认层）。 */
    savedLayers?: () => Record<string, RuntimeDescriptor>;
    /** 已建好的中层（Daemon 把同一个中层交给 RPC 与 MCP 两个界面时传入）；省略则按上面的选项代建 */
    middle?: LocalMiddle;
}

const fileTransferProperties = {
    local_path: { type: "string", minLength: 1, description: "MCP 服务进程所在机器的文件路径" },
    remote_path: { type: "string", minLength: 1, description: "目标层内的文件路径" },
    layer: { type: "string", minLength: 1, description: "目标层名（缺省=默认层）" },
    transport: { type: "string", enum: ["exec", "sftp"], description: "缺省 exec。SFTP 适用于可直达的 SSH 文件系统" },
    timeout_ms: { type: "integer", minimum: 1, maximum: 2147483647, description: "每次 SSH 命令或 SFTP 进程的超时毫秒数，缺省 120000" },
};

const layerNameSchema = { type: "string", minLength: 1, pattern: "\\S" };
const nonEmptyPathSchema = { type: "string", minLength: 1, description: "目标层内的绝对路径或相对工作目录的路径" };
const layerPathParameters = {
    type: "object",
    additionalProperties: false,
    properties: {
        path: nonEmptyPathSchema,
        layer: { ...layerNameSchema, description: "目标层名，省略时使用默认层" },
    },
    required: ["path"],
};

function assertValidPath(path: unknown, label = "path"): asserts path is string {
    if (typeof path !== "string" || !path.length || path.includes("\0")) {
        throw new Error(`${label} 需为不含 NUL 的非空路径`);
    }
}

function assertOptionalLayerName(layer: unknown): asserts layer is string | undefined {
    if (layer !== undefined && (typeof layer !== "string" || !layer.trim())) {
        throw new Error("layer 需为非空层名");
    }
}

/**
 * 工具参数里的布尔开关：未传即不传，传了必须是布尔。校验与取值同在一处——工具参数是
 * Record<string, unknown>，若「先 if 校验、再把原值传给操作」，校验靠的是控制流收窄，
 * 非严格模式下不成立，unknown 会一路流进操作的类型化参数（打包的类型声明一步因此报错）。
 */
function boolOrUndefined(value: unknown, label: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw new Error(`${label} 需为布尔值`);
    return value;
}

function layerPathArgs(args: { path: string; layer?: string }) {
    const { path, layer, ...extra } = args;
    if (Object.keys(extra).length) throw new Error("只接受 path 和 layer");
    assertValidPath(path);
    assertOptionalLayerName(layer);
    return { path, layer };
}

const sshHostSchema = { type: "string", minLength: 1, pattern: "^\\S+$", description: "目标主机（user@host 或运行环境的 SSH 配置别名）" };
const sshTargetSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        host: sshHostSchema,
        port: { type: "integer", minimum: 1, maximum: 65535, description: "SSH 端口" },
        user: { type: "string", description: "登录用户名" },
        key: { type: "string", description: "私钥文件路径（-i）" },
        jump: { type: "string", description: "跳板（-J，途径机不占层）" },
        name: { ...layerNameSchema, description: "层名（省略时使用 host）" },
    },
    required: ["host"],
};
const sshTargetsSchema = {
    type: "array",
    minItems: 1,
    description: "按顺序尝试的目标。字符串可直接使用当前运行环境的 SSH 配置别名",
    items: { anyOf: [sshHostSchema, sshTargetSchema] },
};
const enterLayerAliases = ["enter_cmd", "enter_command", "enterCommand", "enterCmd"] as const;
const enterLayerCommonProperties = {
    label: { type: "string", description: "层显示标签" },
    from: { ...layerNameSchema, description: "源层名（缺省=默认层）" },
    name: { ...layerNameSchema, description: "层名（缺省=label）" },
};
const enterCmdSchemaProp = (description: string) => ({
    type: "string",
    minLength: 1,
    description,
});
const enterLayerProperties = {
    enter_cmd: enterCmdSchemaProp("进入内层环境命令，如 \"docker exec -i web sh\"（等价别名：enter_command / enterCommand / enterCmd）"),
    enter_command: enterCmdSchemaProp("enter_cmd 的等价别名：进入内层环境命令"),
    enterCommand: enterCmdSchemaProp("enter_cmd 的等价别名：进入内层环境命令"),
    enterCmd: enterCmdSchemaProp("enter_cmd 的等价别名：进入内层环境命令"),
    ...enterLayerCommonProperties,
};
const enterLayerVariants = enterLayerAliases.map((key) => ({
    type: "object",
    additionalProperties: false,
    properties: {
        [key]: enterCmdSchemaProp(
            key === "enter_cmd"
                ? "进入内层环境命令，如 \"docker exec -i web sh\"（等价别名：enter_command / enterCommand / enterCmd）"
                : "enter_cmd 的等价别名：进入内层环境命令",
        ),
        ...enterLayerCommonProperties,
    },
    required: [key],
}));

/** 批量目标逐个校验（形状、字符、端口、与实际 SSH driver 相同的可路由规则、重名）；
 *  全部合法才开始登记。返回中层 connectSshBatch 的入参。 */
function sshBatchTargets(targets: ConnectSshBatchArgs["targets"]): ConnectSshTarget[] {
    if (!Array.isArray(targets) || !targets.length) throw new Error("connect_layer 的 targets 需为非空数组");
    const names = new Set<string>();
    return Array.from(targets, (entry, index) => {
        const raw = typeof entry === "string" ? { host: entry } : entry;
        const label = `targets[${index}]`;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} 需为主机名或对象`);
        if (Object.keys(raw).some((key) => !Object.hasOwn(sshTargetSchema.properties, key))) {
            throw new Error(`${label} 含未知连接字段`);
        }
        for (const field of ["host", "user", "key", "jump", "name"] as const) {
            const value = raw[field];
            if (field !== "host" && value === undefined) continue;
            if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
                throw new Error(`${label}.${field} 需为非空字符串且不能含控制字符`);
            }
        }
        if (!/^[^@\s]+(?:@[^@\s]+)?$/.test(raw.host) || raw.host.startsWith("-")
            || (raw.user !== undefined && (/[\s@]/.test(raw.user) || raw.host.includes("@")))) {
            throw new Error(`${label} 的 host 或 user 无效`);
        }
        if (raw.port !== undefined && (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535)) {
            throw new Error(`${label}.port 需为 1 到 65535 的整数`);
        }
        const name = raw.name ?? String(raw.host);
        const target: ConnectSshTarget = {
            host: String(raw.host),
            name,
            ...(raw.port !== undefined ? { port: raw.port } : {}),
            ...(raw.user !== undefined ? { user: raw.user } : {}),
            ...(raw.key !== undefined ? { key: raw.key } : {}),
            ...(raw.jump !== undefined ? { jump: raw.jump } : {}),
        };
        // Check the same target and jump argument rules as the actual SSH driver.
        assertSshTargetRoutable(target);
        if (names.has(name)) throw new Error(`targets 含重复层名 '${name}'`);
        names.add(name);
        return target;
    });
}

const batchLayerSchema = (description: string) => ({
    anyOf: [
        layerNameSchema,
        { type: "array", minItems: 1, uniqueItems: true, items: layerNameSchema },
    ],
    description,
});

const observeStreamOpenProperties = {
    command: { type: "string", minLength: 1, description: "开窗模式：启动并持续观察流式输出的命令（如 'tail -f /var/log/app.log'），与 window_id 互斥" },
    stream: { type: "string", enum: ["stdout", "stderr", "both"], description: "开窗模式流过滤，缺省 both" },
    name: { type: "string", description: "开窗模式窗口显示名称" },
    layer: { ...layerNameSchema, description: "开窗模式目标层名，缺省使用默认层" },
};

const observeStreamReadProperties = {
    window_id: { type: "string", minLength: 1, description: "续读模式：由开窗返回的 window_id，与 command 互斥" },
    since_seq: { type: "integer", minimum: 0, description: "续读模式：读取此序号之后的帧（与 before_seq/window_ms 互斥）" },
    before_seq: { type: "integer", minimum: 0, description: "续读模式：读取此序号之前最近的帧（与 since_seq/window_ms 互斥）" },
    window_ms: { type: "integer", minimum: 0, description: "续读模式：回看最近多少毫秒内的帧（与 since_seq/before_seq 互斥）" },
};

const observeStreamSharedProperties = {
    limit: { type: "integer", minimum: 1, maximum: 200, description: "最多返回帧数，缺省 20" },
    wait_ms: { type: "integer", minimum: 0, maximum: 30000, description: "等待新增帧的毫秒数（开窗模式等首屏帧；续读模式仅用于 since_seq）" },
};

const editFileCasProperties = {
    path: nonEmptyPathSchema,
    old: { type: "string", minLength: 1, description: "CAS 模式：待替换片段（含足够上下文保持唯一）" },
    new: { type: "string", description: "CAS 模式：替换后的新文本" },
    all: { type: "boolean", description: "CAS 模式：多处命中全替换（缺省 false，多处命中报错）" },
    write_mode: { type: "string", enum: ["auto", "inplace"], description: "CAS 模式：inplace=已知 bind mount 挂载环境显式请求保留 inode 写（跳过 mv 失败尝试）" },
    layer: { ...layerNameSchema, description: "目标层名（缺省=默认层）" },
};

const editFileWriteProperties = {
    path: nonEmptyPathSchema,
    content: { type: "string", description: "写入模式：直接写入或新建的完整 UTF-8 文本（支持空字符串创建空文件）" },
    overwrite: { type: "boolean", description: "写入模式：目标已存在时是否允许覆写（缺省 false——防止误覆盖）" },
    create_dirs: { type: "boolean", description: "写入模式：父目录不存在时是否自动递归创建（缺省 false）" },
    layer: { ...layerNameSchema, description: "目标层名（缺省=默认层）" },
};

/** 工具定义单一来源（REQ-0003 MCP tools/list 同源序列化——零漂移） */
export const TOOL_DEFS: AgentToolDef[] = [
    // run_batch 置顶（第十三季黑盒实测：Lazy schema 按序读前几个 .json 就动手，高杠杆批处理工具必须在首屏）
    {
        type: "function",
        function: {
            name: "run_batch",
            description:
                "编排并执行多步骤文件或命令 DAG（exec/edit/read/put/get），支持按 layer 数组跨多层并行扇出。" +
                "单步操作请使用专用工具（run_command、read_path、edit_file、transfer_file）；多步骤依赖、批量读取/修改或多层同发请使用本工具。" +
                "无 after 依赖的步骤并行，顺序链靠 after 显式保序；默认任一步失败即停（未启动步骤标 skipped），**不做自动回滚**。" +
                "巡检/批量只读请传 stop_on_fail:false——缺省的失败即停会让其余步骤被跳过（一台失败，其余都不看）。",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    steps: {
                        type: "array",
                        minItems: 1,
                        description: "步骤数组（id 唯一）",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                ...fileTransferProperties,
                                id: { type: "string", description: "步骤唯一 id（after 引用用）" },
                                kind: { type: "string", enum: BATCH_STEP_KINDS },
                                layer: batchLayerSchema("覆盖批次默认层。多个层名按 id@layer 展开，单元素数组保留原 id；kind=get 只接受单层。可写通配（如 \"q-*\"），按本会话已注册的层名与已存层表（filaxis layer save 的产物）展开，命中未注册的已存层时自动加载"),
                                command: { type: "string", description: "kind=exec：shell 命令（或改用 command_file 引用脚本文件）" },
                                command_file: {
                                    type: "string", minLength: 1,
                                    description: "kind=exec：脚本文件路径，替代 command（二者互斥）。命令原样进文件——免 JSON 转义、同一脚本可复用；读不出或为空则整批拒绝。相对路径相对服务进程工作目录，经 Daemon 执行时建议给绝对路径",
                                },
                                expect_exit: { type: "array", items: { type: "number" }, description: "kind=exec：预期退出码集合（缺省 [0]）" },
                                timeout_ms: { type: "number", description: "kind=exec：超时毫秒" },
                                path: { type: "string", description: "kind=edit/read：文件路径" },
                                write_mode: { type: "string", enum: ["auto", "inplace"], description: "kind=edit/put：inplace 保留目标 inode" },
                                hunks: {
                                    type: "array",
                                    description: "kind=edit：同一文件的替换对。全部匹配且写前版本校验通过才写回；任一未命中则本步骤不写",
                                    items: {
                                        type: "object",
                                        properties: {
                                            old: { type: "string", description: "待替换片段（含足够上下文唯一）" },
                                            new: { type: "string" },
                                            all: { type: "boolean", description: "多处命中全替换（缺省报错）" },
                                        },
                                        required: ["old", "new"],
                                    },
                                },
                                after: { type: "array", items: { type: "string" }, description: "依赖边：列出的步骤 id 全部 ok 后才启动（无=可并行）" },
                            },
                            required: ["id", "kind"],
                        },
                    },
                    stop_on_fail: { type: "boolean", description: "失败即停（缺省 true：某步失败后未启动的步骤标 skipped）。巡检/批量只读请传 false——一台失败其余照看" },
                    max_parallel: { type: "number", description: "并行度上限（缺省 3）" },
                    layer: batchLayerSchema("批次默认目标层名或层名数组（缺省=默认层；传数组时未覆盖 layer 的步骤自动展开到各层并行执行）。可写通配（如 \"q-*\"），按本会话已注册的层名与已存层表（filaxis layer save 的产物）展开，命中未注册的已存层时自动加载"),
                    output: { type: "string", enum: ["text", "full"], description: "MCP 输出模式。text 适合只读文本块的客户端，保留简短预览；full（默认）另在 structuredContent 保留完整输出" },
                },
                required: ["steps"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "run_command",
            description:
                "在单层执行会自行结束的一次性命令，物理分离返回 stdout、stderr 与 exit_code。" +
                "多命令、多文件或跨多层同发请用 run_batch；持续实时流（如 tail -f）请用 observe_stream；后台常驻服务启停请用 start_session 与 stop_session；" +
                "标准文件与目录操作请优先用 read_path、edit_file、manage_path、transfer_file。" +
                "非零 exit_code 作为数据正常返回不报错；仅超时、中断或连接异常导致终态未知时报错。",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    command: { ...layerNameSchema, description: "会自行结束的 shell 命令" },
                    timeout_ms: { type: "number", description: "超时毫秒（缺省 120000）" },
                    layer: { ...layerNameSchema, description: "目标层名，省略时使用当前默认层" },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "start_session",
            description:
                "启动后台长跑任务或服务并落盘输出到 log_base（.out/.err），支持就绪握手与错误触发停机。" +
                "需要启动后台服务、等待 ready_marker 就绪、按 error_pattern 停机或稍后用 stop_session 核实退出码时使用；" +
                "会自行结束的命令用 run_command，临时实时盯日志用 observe_stream。" +
                "省略 ready_marker 时立即返回 session_id 与 log_base；提供 ready_marker 时轮询热窗口至就绪后返回，超时或早退时附带终态线索报错。",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "长跑命令" },
                    ready_marker: { type: "string", description: "可选的就绪标记（如 'listening on'）。提供时，本次调用等待标记后返回" },
                    error_pattern: { type: "string", description: "错误模式（命中即收摊）" },
                    name: { type: "string", description: "会话名（人读前缀）" },
                    layer: { type: "string", description: "目标层名（缺省=默认层）" },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "stop_session",
            description:
                "停止由 start_session 启动的后台会话并核实远端终态。" +
                "返回三态 status：exited（已确认退出码）、stopped（终止已核实）或 unknown（终态证据不足，禁止推定已停止）。" +
                "返回 unknown 时可持完整 session_id 与原目标 layer 再次调用核实；会话归属未知或已过期时需显式传 layer（初始层用 __initial__）。",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    session_id: { ...layerNameSchema, description: "start_session 返回的完整 session_id" },
                    layer: { ...layerNameSchema, description: "外部会话或归属已过期时指定原目标层，初始层用 __initial__" },
                },
                required: ["session_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "observe_stream",
            description:
                "启动实时日志/事件流观察窗（传 command，可选 wait_ms 直接带回首屏帧）或按游标续读/回看既有窗口（传 window_id）。" +
                "适合 tail -f 等持续流式观察；需要后台服务就绪握手与退出码核实时改用 start_session。观察完毕请调用 close_stream 回收流进程。" +
                "续读用 last_delivered_seq 配合 since_seq，向前翻页用 before_seq，时间回看用 window_ms；gap=true 表示中间有帧已被环形覆盖。",
            parameters: {
                type: "object",
                properties: {
                    ...observeStreamOpenProperties,
                    ...observeStreamReadProperties,
                    ...observeStreamSharedProperties,
                },
                oneOf: [
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: { ...observeStreamOpenProperties, ...observeStreamSharedProperties },
                        required: ["command"],
                    },
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: { ...observeStreamReadProperties, ...observeStreamSharedProperties },
                        required: ["window_id"],
                    },
                ],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "close_stream",
            description:
                "关闭由 observe_stream 打开的本地观察窗，确认终止并回收对应的远端观察流进程与通道资源，返回 { window_id, closed: true }。" +
                "流观察完成后应及时调用以防残留进程；若 window_id 不存在或已关闭则报错（不影响其他观察窗）。",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: { window_id: { type: "string", minLength: 1, description: "由 observe_stream 返回的观察窗 ID" } },
                required: ["window_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_path",
            description:
                "只读查看目标层中的路径（不修改远端状态）：若为文件返回 UTF-8 文本与元数据 { path, type: 'file', content, size, mtime_ms }；" +
                "若为目录返回直接子项列表 { path, type: 'directory', entries }（含名称、目录标志及可用时的大小/修改时间）。" +
                "下载二进制文件用 transfer_file(direction='get')，批量读取多个文件用 run_batch，创建或编辑文本用 edit_file。",
            parameters: layerPathParameters,
        },
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description:
                "在目标层做受控 CAS 文本替换（传 old + new）或直接新建/写入完整 UTF-8 文本文件（传 content）。" +
                "CAS 模式在写回前校验修改时间、大小与内容指纹（冲突报 EditConflictError），默认要求 old 唯一命中（all=true 全替换），并报告 mutex 与 write_mode；" +
                "写入模式默认 overwrite=false 防止误覆盖已有文件，可选 create_dirs=true 自动建父目录。" +
                "多文件或同一文件多处并发编辑用 run_batch(kind='edit')，二进制传输用 transfer_file。",
            parameters: {
                type: "object",
                properties: {
                    ...editFileCasProperties,
                    ...editFileWriteProperties,
                },
                oneOf: [
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: editFileCasProperties,
                        required: ["path", "old", "new"],
                    },
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: editFileWriteProperties,
                        required: ["path", "content"],
                    },
                ],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "manage_path",
            description:
                "管理目标层内的目录与路径生命周期：创建目录（action='mkdir'，默认 parents=true）、移动/重命名路径（action='move'，需 destination）" +
                "或删除路径（action='delete'）。" +
                "delete 默认 recursive=false 仅删单文件或符号链接本身并拒绝目录；传 recursive=true 可递归删除目录，并前置拒绝根目录、当前工作目录及上级路径。",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["mkdir", "move", "delete"], description: "路径操作类型" },
                    path: nonEmptyPathSchema,
                    parents: { type: "boolean", description: "action=mkdir：不存在时自动创建上级目录（缺省 true）" },
                    destination: { type: "string", minLength: 1, description: "action=move：目标路径" },
                    recursive: { type: "boolean", description: "action=delete：递归删除目录（缺省 false——安全起见默认拒绝目录）" },
                    layer: { ...layerNameSchema, description: "目标层名，省略时使用默认层" },
                },
                oneOf: [
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            action: { type: "string", const: "mkdir" },
                            path: nonEmptyPathSchema,
                            parents: { type: "boolean", description: "不存在时自动创建上级目录（缺省 true）" },
                            layer: { ...layerNameSchema, description: "目标层名，省略时使用默认层" },
                        },
                        required: ["action", "path"],
                    },
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            action: { type: "string", const: "move" },
                            path: nonEmptyPathSchema,
                            destination: { type: "string", minLength: 1, description: "移动或重命名后的目标路径" },
                            layer: { ...layerNameSchema, description: "目标层名，省略时使用默认层" },
                        },
                        required: ["action", "path", "destination"],
                    },
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            action: { type: "string", const: "delete" },
                            path: nonEmptyPathSchema,
                            recursive: { type: "boolean", description: "是否递归删除目录（缺省 false）" },
                            layer: { ...layerNameSchema, description: "目标层名，省略时使用默认层" },
                        },
                        required: ["action", "path"],
                    },
                ],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "transfer_file",
            description:
                "在 MCP 服务所在主机与目标层之间上传（direction='put'）或下载（direction='get'）单个文件（支持二进制）。" +
                "传输始终先校验大小，目标层支持 SHA-256 时再校验摘要（返回 verification 区分 sha256 与 size）；校验通过后才落位并覆盖目标文件。" +
                "仅查看文本内容用 read_path，新建/修改文本用 edit_file，批量传输多文件用 run_batch(kind='put'|'get')。",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    direction: { type: "string", enum: ["put", "get"], description: "put=本地上传到目标层；get=从目标层下载到本地" },
                    ...fileTransferProperties,
                    write_mode: { type: "string", enum: ["auto", "inplace"], description: "仅 direction=put 有效，缺省 auto。inplace 保留目标 inode" },
                },
                required: ["direction", "local_path", "remote_path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "connect_layer",
            description:
                "建立并激活命名执行层：单台 SSH（传 host，可带 port/user/key/jump/name）、批量 SSH（传 targets 数组，按顺序建连并返回可用于 run_batch 的 layers），" +
                "或从既有源层进入内层容器/Shell（传 enter_cmd，如 'docker exec -i web sh'，全量继承追加 enter 管线）。" +
                "SSH 同落点可幂等复用既有层，新建或复用后成为默认层；查询、切换或移出层请用 manage_layers。",
            parameters: {
                type: "object",
                properties: {
                    ...sshTargetSchema.properties,
                    targets: sshTargetsSchema,
                    ...enterLayerProperties,
                },
                oneOf: [
                    sshTargetSchema,
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: { targets: sshTargetsSchema },
                        required: ["targets"],
                    },
                    ...enterLayerVariants,
                ],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "manage_layers",
            description:
                "查询、切换、移除已注册命名层或管理动态端口转发：action='list' 列出全部命名层及链路/状态/有效用户/默认标记；" +
                "action='activate' 将指定 name 设为默认层（保留所有连接）；" +
                "action='remove' 移出指定层（缺省保留连接在指纹缓存以便零成本重建，传 destroy=true 才真销毁连接）；" +
                "action='forward_add' 在目标或默认 SSH 层动态开启 -L/-R/-D 端口转发（bind_port 不填或传 0 自动分配空闲端口）；" +
                "action='forward_list' 查询动态端口转发列表（缺省只报仍在用的转发，include_closed=true 连已停止/已退出的一并返回）；" +
                "action='forward_remove' 关闭指定 forward_id。转发记录字段为 snake_case（forward_id、bind_addr、bind_port、target_host、target_port、transport_mode、status…；forwardId 仅为兼容别名）。" +
                "新建 SSH 或进入内层环境请用 connect_layer。",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["list", "activate", "remove", "forward_add", "forward_list", "forward_remove"],
                        description: "层与动态转发管理操作",
                    },
                    name: { ...layerNameSchema, description: "目标层名（action=activate/remove 时必填）" },
                    destroy: { type: "boolean", description: "action=remove：是否真销毁底层连接（缺省 false=保留可复用）" },
                    layer: { ...layerNameSchema, description: "action=forward_*：目标层名（缺省=默认层；forward_list 缺省=全部层）" },
                    kind: { type: "string", enum: ["local", "remote", "dynamic", "L", "R", "D"], description: "action=forward_add：转发类型" },
                    bind_addr: { type: "string", minLength: 1, description: "action=forward_add：绑定地址，缺省 127.0.0.1" },
                    bind_port: { type: "integer", minimum: 0, maximum: 65535, description: "action=forward_add：绑定端口（省略或传 0=自动分配随机空闲端口）" },
                    target_host: { type: "string", minLength: 1, description: "action=forward_add（local/remote 必填）：目标主机" },
                    target_port: { type: "integer", minimum: 1, maximum: 65535, description: "action=forward_add（local/remote 必填）：目标端口" },
                    forward_id: { type: "string", minLength: 1, description: "action=forward_add 可选自定义 ID；action=forward_remove 必填转发 ID" },
                    timeout_ms: { type: "integer", minimum: 1, maximum: 2147483647, description: "action=forward_add：建链超时毫秒数，缺省 15000" },
                    include_closed: { type: "boolean", description: "action=forward_list：true 连已停止/已退出的转发一并返回（缺省 false=只报仍在用的）" },
                },
                oneOf: [
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: { action: { type: "string", const: "list" } },
                        required: ["action"],
                    },
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            action: { type: "string", const: "activate" },
                            name: { ...layerNameSchema, description: "已注册的层名" },
                        },
                        required: ["action", "name"],
                    },
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            action: { type: "string", const: "remove" },
                            name: { ...layerNameSchema, description: "待移出的层名" },
                            destroy: { type: "boolean", description: "真销毁连接（缺省 false=保留可复用）" },
                        },
                        required: ["action", "name"],
                    },
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            action: { type: "string", const: "forward_add" },
                            kind: { type: "string", enum: ["local", "remote", "dynamic", "L", "R", "D"] },
                            bind_port: { type: "integer", minimum: 0, maximum: 65535 },
                            bind_addr: { type: "string", minLength: 1 },
                            target_host: { type: "string", minLength: 1 },
                            target_port: { type: "integer", minimum: 1, maximum: 65535 },
                            forward_id: { type: "string", minLength: 1 },
                            timeout_ms: { type: "integer", minimum: 1, maximum: 2147483647 },
                            layer: { ...layerNameSchema },
                        },
                        required: ["action", "kind"],
                    },
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            action: { type: "string", const: "forward_list" },
                            layer: { ...layerNameSchema },
                            include_closed: { type: "boolean" },
                        },
                        required: ["action"],
                    },
                    {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            action: { type: "string", const: "forward_remove" },
                            forward_id: { type: "string", minLength: 1 },
                            layer: { ...layerNameSchema },
                        },
                        required: ["action", "forward_id"],
                    },
                ],
            },
        },
    },
];

/** 观察窗 ID 的存在性属于工具契约（文案要点名 window_id 这个字段）；窗口存在与否由中层判定 */
function requireWindowId(windowId: unknown): asserts windowId is string {
    if (typeof windowId !== "string" || !windowId.trim()) throw new Error("window_id 需为非空字符串，请使用 observe_stream 返回的 window_id");
}

// ── 适配层（REQ-0004 §3：界面层只管参数语法与结果呈现）──
// 工具参数与结果是 snake_case（LLM 工具面的契约）；中层操作是 camelCase。下面每个
// handler 做三件事：按工具契约校验参数 → 调中层操作 → 把结果投影成 snake_case。
// 校验文案是 MCP 契约的一部分（字段名按工具面写），所以留在这一层；操作逻辑只在中层。

/** 中层 camelCase 的观察窗结果 → 工具面 snake_case */
function publicStream(r: StreamResult): ObserveStreamResult {
    return {
        window_id: r.windowId,
        ...(r.name ? { name: r.name } : {}),
        oldest_seq: r.oldestSeq,
        newest_seq: r.newestSeq,
        stale: r.stale,
        frames: r.frames,
        ...(r.exitCode !== undefined ? { exit_code: r.exitCode } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(r.lastDeliveredSeq !== undefined ? { last_delivered_seq: r.lastDeliveredSeq } : {}),
        ...(r.gap ? { gap: true } : {}),
        ...(r.timedOut ? { timed_out: true } : {}),
    };
}

function publicConnectSsh(r: MiddleConnectSshResult): ConnectSshResult {
    return {
        layer: r.layer,
        reused: r.reused,
        ...(r.reusedFrom !== undefined ? { reused_from: r.reusedFrom } : {}),
        ...(r.note !== undefined ? { note: r.note } : {}),
    };
}

function publicConnectBatch(r: MiddleConnectSshBatchResult): ConnectSshBatchResult {
    return {
        status: r.status,
        ...(r.activeLayer !== undefined ? { active_layer: r.activeLayer } : {}),
        layers: r.layers,
        results: r.results.map((x) => x.status === "ok"
            ? { host: x.host, name: x.name, status: "ok" as const, ...publicConnectSsh(x) }
            : { host: x.host, name: x.name, status: "fail" as const, error: x.error }),
    };
}

/** 生成 Agent 工具集（定义层 + 执行层；宿主桥接到任意 LLM 框架） */
export function createAgentToolkit(stack: RuntimeStack, opts: AgentToolkitOptions = {}): AgentToolkit {
    const middle = opts.middle ?? createMiddle({
        stack,
        descriptor: opts.descriptor,
        driver: opts.driver,
        windowRegistry: opts.windowRegistry,
        readyTimeoutMs: opts.readyTimeoutMs,
        sessionResultTtlMs: opts.sessionResultTtlMs,
        sessionCheckIntervalMs: opts.sessionCheckIntervalMs,
        savedLayers: opts.savedLayers,
    });
    const { ops } = middle;

    // ── 调用方基准目录（REQ-0004 §5.5）──
    // 工具面可能在 Daemon 进程里执行（MCP 经 Daemon），它的工作目录与客户端无关；相对路径与命令
    // 的工作目录该以谁为基准是界面层的事：客户端一侧的代理把工作目录随会话带来（callerCwd）。
    // 只有「没有自己工作目录的本机层」才用它：已存本机层用自己的 cwd，SSH 层的路径原样。
    // 不在工具调用上下文里（SDK 直接调 handlers）时 callerCwd 为 undefined，一切照旧。
    const callerLocal = async (layer: unknown): Promise<boolean> => {
        if (callerCwd() === undefined) return false;
        if (layer !== undefined && typeof layer !== "string") return false;
        // 具名层只查登记表（不触发任何建层动作）；没写层才解析（缺省层或隐式本机层）
        const drv = layer === undefined
            ? await middle.resolveLayerRef(undefined)
            : middle.stack.layers.get(layer)?.driver;
        if (!drv || drv.descriptor?.driver !== "local" || drv.descriptor.cwd) return false;
        // 以驱动实例登记的层，描述符里不带 cwd，工作目录只在驱动身上：它的实际目录就是本进程的
        // 缺省目录时才算「没有自己的工作目录」（否则是层自己的，路径相对它）
        const sameDir = (a: string, b: string): boolean => {
            const norm = (p: string) => pathResolve(p).replace(/[/\\]+$/, "").toLowerCase();
            return norm(a) === norm(b);
        };
        try {
            return typeof drv.getCwd === "function" && sameDir(await drv.getCwd(), process.cwd());
        } catch {
            return false;
        }
    };
    /** 相对路径补上调用方目录（只补前缀、不折叠 `..`——与 CLI 的 callerPath 同一条规则） */
    const anchor = (p: unknown): unknown => {
        const base = callerCwd();
        return typeof p === "string" && p && base && !pathIsAbsolute(p) ? `${base.replace(/[/\\]+$/, "")}/${p}` : p;
    };
    /** 命令的工作目录：目标是没有自己工作目录的本机层时才给 */
    const commandCwd = async (layer: unknown): Promise<string | undefined> =>
        (await callerLocal(layer)) ? callerCwd() : undefined;

    const transferFile = async (operation: "put" | "get", args: AgentFilePutArgs): Promise<AgentFileTransferResult> => {
        const { local_path, remote_path, layer: layerName, transport, timeout_ms, write_mode, ...unknownFields } = args;
        const extra = Object.keys(unknownFields);
        if (extra.length) throw new Error(`transfer_file 未知参数：${extra.join(", ")}`);
        if (layerName !== undefined && (typeof layerName !== "string" || !layerName.trim())) throw new Error("layer 需为非空字符串");
        // local_path 永远在调用方机器上；remote_path 只有目标也是调用方的本机层时才是
        const localSide = await callerLocal(layerName);
        return agentTransferResult(await ops.transferFile({
            layer: layerName, direction: operation,
            localPath: anchor(local_path) as string,
            remotePath: (localSide ? anchor(remote_path) : remote_path) as string,
            transport, timeoutMs: timeout_ms, writeMode: write_mode,
        }));
    };

    const startSession: AgentToolHandlers["start_session"] = async ({ command, ready_marker, error_pattern, name, layer: layerName }) => {
        const cwd = await commandCwd(layerName);
        const h = await ops.startSession({ layer: layerName, command, name, readyMarker: ready_marker, errorPattern: error_pattern, ...(cwd ? { cwd } : {}) });
        return { session_id: h.sessionId, log_base: h.logBase, ...(h.note !== undefined ? { note: h.note } : {}) };
    };
    const stopSession: AgentToolHandlers["stop_session"] = async ({ session_id, layer: layerName, ...extra }) => {
        if (Object.keys(extra).length) throw new Error("stop_session 只接受 session_id 和 layer");
        if (typeof session_id !== "string" || !session_id.trim()) throw new Error("session_id 需为完整的非空会话 ID");
        if (layerName !== undefined && (typeof layerName !== "string" || !layerName.trim())) {
            throw new Error("layer 需为非空层名");
        }
        const r = await ops.stopSession({ sessionId: session_id, layer: layerName });
        return {
            status: r.status,
            ...("exitCode" in r ? { exit_code: r.exitCode } : {}),
            ...(r.note !== undefined ? { note: r.note } : {}),
        };
    };

    const connectIntoLayer = async (args: Record<string, unknown>, presentEnterKeys: readonly string[]): Promise<ConnectIntoResult> => {
        if (presentEnterKeys.length > 1) {
            throw new Error(`connect_layer 只能传一个进入命令参数（不要同时传 ${presentEnterKeys.join("、")}）`);
        }
        const sshKeys = ["host", "targets", "port", "user", "key", "jump"];
        const conflicting = sshKeys.filter((k) => args[k] !== undefined);
        if (conflicting.length) {
            throw new Error(`connect_layer 的内层进入模式（enter_cmd）与 SSH 参数互斥：${conflicting.join(", ")}`);
        }
        const enterAllowed = new Set<string>([...enterLayerAliases, "label", "from", "name"]);
        const unknown = Object.keys(args).filter((k) => !enterAllowed.has(k));
        if (unknown.length) throw new Error(`connect_layer 内层进入模式未知参数：${unknown.join(", ")}`);
        const enterKey = presentEnterKeys[0];
        const enterCmd = enterKey && typeof args[enterKey] === "string" && (args[enterKey] as string).trim()
            ? (args[enterKey] as string)
            : undefined;
        if (!enterCmd) {
            throw new Error("connect_layer 的 enter_cmd 需为非空命令字符串（别名 enterCommand/enter_command/enterCmd 均可）");
        }
        const label = args.label as string | undefined;
        const from = args.from as string | undefined;
        const name = args.name as string | undefined;
        if (label !== undefined && typeof label !== "string") throw new Error("label 需为字符串");
        assertOptionalLayerName(from);
        assertOptionalLayerName(name);
        return await ops.connectInto({ enterCmd, label, from, name });
    };
    const connectSshLayer = async (args: Record<string, unknown>) => {
        if (args.from !== undefined || args.label !== undefined) {
            throw new Error("connect_layer 的 SSH 模式不支持 from 或 label（仅 enter_cmd 模式使用）");
        }
        if (args.targets === undefined) {
            const unknown = Object.keys(args).filter((k) => !Object.hasOwn(sshTargetSchema.properties, k));
            if (unknown.length) throw new Error(`connect_layer 未知参数：${unknown.join(", ")}`);
            if (typeof args.host !== "string" || !args.host.trim()) {
                throw new Error("connect_layer 需提供 host（单台 SSH）、targets（批量 SSH）或 enter_cmd（进入内层）");
            }
            if (args.port !== undefined && (!Number.isInteger(args.port) || (args.port as number) < 1 || (args.port as number) > 65535)) {
                throw new Error("port 需为 1 到 65535 的整数");
            }
            const t = args as unknown as ConnectSshTarget;
            return publicConnectSsh(await ops.connectSsh({ host: t.host, port: t.port, user: t.user, key: t.key, jump: t.jump, name: t.name }));
        }
        if (Object.keys(args).some((key) => key !== "targets" && args[key] !== undefined)) {
            throw new Error("connect_layer 的 targets 必须单独提供");
        }
        return publicConnectBatch(await ops.connectSshBatch(sshBatchTargets(args.targets as ConnectSshBatchArgs["targets"])));
    };
    const connectLayer: AgentToolHandlers["connect_layer"] = (async (args: Record<string, unknown>) => {
        const presentEnterKeys = enterLayerAliases.filter((k) => args[k] !== undefined);
        if (presentEnterKeys.length > 0) return await connectIntoLayer(args, presentEnterKeys);
        return await connectSshLayer(args);
    }) as unknown as AgentToolHandlers["connect_layer"];

    return {
        tools: TOOL_DEFS,
        dispose() {
            middle.dispose();
        },
        get layer(): Promise<RuntimeDriver> { return middle.resolveLayerRef(undefined); }, // 惰性（失败不缓存）
        handlers: {
            async run_command({ command, timeout_ms, layer: layerName, ...extra }) {
                if (Array.isArray(layerName)) {
                    throw new Error("run_command 的 layer 仅支持单个层名；同一命令发往多个层请改用 run_batch 并传 layer 数组");
                }
                if (Object.keys(extra).length) throw new Error("run_command 含未知参数，目标层字段为 layer");
                if (typeof command !== "string" || !command.trim()) throw new Error("command 需为非空字符串");
                const cwd = await commandCwd(layerName);
                const r = await ops.runCommand({ layer: layerName, command, timeoutMs: timeout_ms, ...(cwd ? { cwd } : {}) });
                return {
                    stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode,
                    effective_user: r.effectiveUser,
                };
            },
            start_session: startSession,
            async read_path(args) {
                const { path, layer: layerName } = layerPathArgs(args);
                const anchored = await callerLocal(layerName);
                const r = await ops.readPath({ layer: layerName, path: (anchored ? anchor(path) : path) as string });
                return r.type === "file"
                    ? { path: r.path, type: "file" as const, content: r.content, size: r.size, mtime_ms: r.mtimeMs }
                    : { path: r.path, type: "directory" as const, entries: r.entries };
            },
            edit_file: (async (args: Record<string, unknown>) => {
                const hasWrite = args.content !== undefined;
                const hasCas = args.old !== undefined || args.new !== undefined;
                if (hasWrite && hasCas) {
                    throw new Error("edit_file 的直接写入模式（content）与 CAS 替换模式（old/new）互斥");
                }
                if (hasWrite) {
                    const { path, content, overwrite, create_dirs: createDirs, layer: layerName, ...extra } = args;
                    const unknown = Object.keys(extra);
                    if (unknown.length) {
                        throw new Error(`edit_file 写入模式未知参数：${unknown.map((field) => JSON.stringify(field)).join(", ")}`);
                    }
                    assertValidPath(path);
                    assertOptionalLayerName(layerName);
                    if (typeof content !== "string") throw new Error("edit_file 的 content 需为字符串");
                    const r = await ops.writeFile({
                        layer: layerName, path: (await callerLocal(layerName)) ? anchor(path) as string : path, content,
                        overwrite: boolOrUndefined(overwrite, "edit_file 的 overwrite"),
                        createDirs: boolOrUndefined(createDirs, "edit_file 的 create_dirs"),
                    });
                    return { mode: "write" as const, path: r.path, created: r.created, bytes_after: r.bytesAfter };
                }
                const { path, old, new: newStr, all, write_mode: writeMode, layer: layerName, ...extra } = args as {
                    path: string; old: string; new: string; all?: boolean; write_mode?: "auto" | "inplace"; layer?: string;
                };
                const unknown = Object.keys(extra);
                if (unknown.length) {
                    const hint = unknown.includes("hunks") ? "。单次编辑传 old 和 new，多处替换可用 run_batch 的 edit 步骤" : "";
                    throw new Error(`edit_file 未知参数：${unknown.map((field) => JSON.stringify(field)).join(", ")}${hint}`);
                }
                if (old === undefined || newStr === undefined) {
                    throw new Error("edit_file 需传 old 和 new（CAS 替换），或传 content（直接写入/创建）");
                }
                const r = await ops.editFile({
                    layer: layerName, path: (await callerLocal(layerName)) ? anchor(path) as string : path, old, new: newStr, all, writeMode,
                });
                return {
                    mode: "edit" as const,
                    path: r.path, occurrences: r.occurrences,
                    bytes_before: r.bytesBefore, bytes_after: r.bytesAfter,
                    mutex: r.mutex, write_mode: r.writeMode,
                };
            }) as AgentToolHandlers["edit_file"],
            manage_path: (async (args: Record<string, unknown>) => {
                const { action, path, layer: layerName, ...rest } = args;
                if (action !== "mkdir" && action !== "move" && action !== "delete") {
                    throw new Error('manage_path 的 action 须为 "mkdir"、"move" 或 "delete"');
                }
                assertValidPath(path);
                assertOptionalLayerName(layerName);
                const anchored = await callerLocal(layerName);
                const anchoredPath = (anchored ? anchor(path) : path) as string;
                if (action === "mkdir") {
                    const { parents, ...extra } = rest;
                    const unknown = Object.keys(extra);
                    if (unknown.length) throw new Error(`manage_path(mkdir) 未知参数：${unknown.join(", ")}`);
                    return await ops.managePath({ layer: layerName, action: "mkdir", path: anchoredPath, parents: boolOrUndefined(parents, "parents") });
                }
                if (action === "move") {
                    const { destination, ...extra } = rest;
                    const unknown = Object.keys(extra);
                    if (unknown.length) throw new Error(`manage_path(move) 未知参数：${unknown.join(", ")}`);
                    assertValidPath(destination, "destination");
                    return await ops.managePath({ layer: layerName, action: "move", path: anchoredPath, destination: (anchored ? anchor(destination) : destination) as string });
                }
                const { recursive, ...extra } = rest;
                const unknown = Object.keys(extra);
                if (unknown.length) throw new Error(`manage_path(delete) 未知参数：${unknown.join(", ")}`);
                return await ops.managePath({ layer: layerName, action: "delete", path: anchoredPath, recursive: boolOrUndefined(recursive, "recursive") });
            }) as AgentToolHandlers["manage_path"],
            transfer_file: (async (args: Record<string, unknown>) => {
                const { direction, ...rest } = args;
                if (direction !== "put" && direction !== "get") {
                    throw new Error('transfer_file 的 direction 需为 "put" 或 "get"');
                }
                if (direction === "get" && rest.write_mode !== undefined) {
                    throw new Error("transfer_file 在 direction=get 时不支持 write_mode");
                }
                const result = await transferFile(direction, rest as unknown as AgentFilePutArgs);
                return { direction, ...result };
            }) as unknown as AgentToolHandlers["transfer_file"],
            observe_stream: (async (args: Record<string, unknown>) => {
                if ("duration_ms" in args) throw new Error("observe_stream 持续开窗，请用 wait_ms 限制单次等待");
                const hasCommand = args.command !== undefined;
                const hasWindowId = args.window_id !== undefined;
                if (hasCommand && hasWindowId) {
                    throw new Error("observe_stream 不能同时传 command（开窗）和 window_id（续读）");
                }
                if (!hasCommand && !hasWindowId) {
                    throw new Error("observe_stream 需传 command（开窗）或 window_id（续读）");
                }
                if (hasCommand) {
                    const { command, stream, name, layer: layerName, limit = 20, wait_ms = 0, ...extra } = args as {
                        command: unknown; stream?: unknown; name?: unknown; layer?: unknown; limit?: unknown; wait_ms?: unknown;
                        [key: string]: unknown;
                    };
                    if (extra.since_seq !== undefined || extra.before_seq !== undefined || extra.window_ms !== undefined) {
                        throw new Error("observe_stream 开窗模式不支持 since_seq、before_seq 或 window_ms；请先开窗再凭返回的 window_id 续读");
                    }
                    const unknown = Object.keys(extra);
                    if (unknown.length) throw new Error(`observe_stream 开窗模式未知参数：${unknown.join(", ")}`);
                    if (typeof command !== "string" || !command.trim()) throw new Error("command 需要非空字符串");
                    if (stream !== undefined && stream !== "stdout" && stream !== "stderr" && stream !== "both") throw new Error("stream 无效");
                    if (name !== undefined && typeof name !== "string") throw new Error("name 需为字符串");
                    assertOptionalLayerName(layerName);
                    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw new Error("limit 须在 1–200 之间");
                    if (!Number.isSafeInteger(wait_ms) || (wait_ms as number) < 0 || (wait_ms as number) > 30000) {
                        throw new Error("wait_ms 须在 0–30000 之间");
                    }
                    const streamCwd = await commandCwd(layerName);
                    return publicStream(await ops.openStream({
                        layer: layerName, command, stream: stream as "stdout" | "stderr" | "both" | undefined,
                        name: name as string | undefined, limit: limit as number, waitMs: wait_ms as number,
                        ...(streamCwd ? { cwd: streamCwd } : {}),
                    }));
                }
                const { window_id, limit = 20, since_seq, before_seq, window_ms, wait_ms = 0, ...extra } = args as {
                    window_id: unknown; limit?: unknown; since_seq?: unknown; before_seq?: unknown; window_ms?: unknown; wait_ms?: unknown;
                    [key: string]: unknown;
                };
                if (extra.stream !== undefined || extra.layer !== undefined || extra.name !== undefined || extra.command !== undefined) {
                    throw new Error("observe_stream 续读模式不支持 command、stream、name 或 layer；请仅传 window_id 及读取游标参数");
                }
                const unknown = Object.keys(extra);
                if (unknown.length) throw new Error(`observe_stream 续读模式未知参数：${unknown.join(", ")}`);
                if ([since_seq, before_seq, window_ms].filter((value) => value !== undefined).length > 1) {
                    throw new Error("since_seq、before_seq 和 window_ms 互斥");
                }
                for (const value of [since_seq, before_seq, window_ms, wait_ms]) {
                    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
                        throw new Error("观察窗的游标和时长需要非负整数");
                    }
                }
                if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw new Error("limit 须在 1–200 之间");
                const waitMs = wait_ms as number;
                if (waitMs > 30000 || (waitMs > 0 && since_seq === undefined)) {
                    throw new Error("wait_ms 仅用于续读，且最大为 30000");
                }
                requireWindowId(window_id);
                return publicStream(await ops.peekStream({
                    windowId: window_id, limit: limit as number, afterSeq: since_seq as number | undefined,
                    beforeSeq: before_seq as number | undefined, windowMs: window_ms as number | undefined, waitMs,
                }));
            }) as AgentToolHandlers["observe_stream"],
            async close_stream({ window_id }) {
                requireWindowId(window_id);
                const r = await ops.closeStream({ windowId: window_id });
                return { window_id: r.windowId, closed: true as const };
            },
            // ── 层族（命名层注册表）──
            connect_layer: connectLayer,
            manage_layers: (async (args: Record<string, unknown>) => {
                const { action, ...rest } = args;
                if (action === "list") {
                    const unknown = Object.keys(rest);
                    if (unknown.length) throw new Error(`manage_layers(list) 未知参数：${unknown.join(", ")}`);
                    const r = await ops.listLayers();
                    return { action: "list" as const, text: r.text, layers: r.layers };
                }
                if (action === "activate") {
                    const { name, ...extra } = rest;
                    if (Object.keys(extra).length) throw new Error("manage_layers(activate) 只接受 action 和 name");
                    if (typeof name !== "string" || !name.trim()) throw new Error("name 需为非空层名");
                    const r = await ops.activateLayer({ layer: name });
                    return { action: "activate" as const, active_layer: r.layer };
                }
                if (action === "remove") {
                    const { name, destroy, ...extra } = rest;
                    if (Object.keys(extra).length) throw new Error("manage_layers(remove) 只接受 action、name 和 destroy");
                    if (typeof name !== "string" || !name.trim()) throw new Error("name 需为非空层名");
                    if (destroy !== undefined && typeof destroy !== "boolean") throw new Error("destroy 需为布尔值");
                    const r = await ops.removeLayer({ layer: name, destroy: destroy === undefined ? undefined : Boolean(destroy) });
                    return { action: "remove" as const, removed: r.layer };
                }
                if (action === "forward_add") {
                    const {
                        layer: layerName, kind, bind_addr, bind_port, target_host, target_port, forward_id, timeout_ms,
                        ...extra
                    } = rest;
                    const unknown = Object.keys(extra);
                    if (unknown.length) throw new Error(`manage_layers(forward_add) 未知参数：${unknown.join(", ")}`);
                    assertOptionalLayerName(layerName);
                    if (bind_addr !== undefined && typeof bind_addr !== "string") throw new Error("bind_addr 需为字符串");
                    if (target_host !== undefined && typeof target_host !== "string") throw new Error("target_host 需为字符串");
                    if (forward_id !== undefined && (typeof forward_id !== "string" || !forward_id.trim())) {
                        throw new Error("forward_id 需为非空字符串");
                    }
                    const spec: OpenForwardSpec = {
                        kind: kind as OpenForwardSpec["kind"],
                        ...(bind_port !== undefined ? { bindPort: bind_port as number } : {}),
                        ...(typeof bind_addr === "string" ? { bindAddr: bind_addr } : {}),
                        ...(typeof target_host === "string" ? { targetHost: target_host } : {}),
                        ...(target_port !== undefined ? { targetPort: target_port as number } : {}),
                        ...(typeof forward_id === "string" ? { id: forward_id } : {}),
                        ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms as number } : {}),
                    };
                    return { action: "forward_add" as const, forward: forwardInfoToPublic(await ops.openForward({ layer: layerName, spec })) };
                }
                if (action === "forward_list") {
                    const { layer: layerName, include_closed, ...extra } = rest;
                    const unknown = Object.keys(extra);
                    if (unknown.length) throw new Error(`manage_layers(forward_list) 未知参数：${unknown.join(", ")}`);
                    if (include_closed !== undefined) boolOrUndefined(include_closed, "include_closed"); // 先于层名校验，报错次序不变
                    assertOptionalLayerName(layerName);
                    const r = await ops.listForwards({ layer: layerName, includeClosed: boolOrUndefined(include_closed, "include_closed") });
                    return { action: "forward_list" as const, forwards: r.forwards.map(forwardInfoToPublic) };
                }
                if (action === "forward_remove") {
                    const { forward_id, layer: layerName, ...extra } = rest;
                    const unknown = Object.keys(extra);
                    if (unknown.length) throw new Error(`manage_layers(forward_remove) 未知参数：${unknown.join(", ")}`);
                    assertOptionalLayerName(layerName);
                    if (typeof forward_id !== "string" || !forward_id.trim()) throw new Error("forward_id 需为非空字符串");
                    const res = await ops.closeForward({ forwardId: forward_id, layer: layerName });
                    return {
                        action: "forward_remove" as const,
                        forward_id: res.forwardId,
                        status: res.status,
                        ...(res.detail ? { detail: res.detail } : {}),
                    };
                }
                throw new Error('manage_layers 的 action 须为 "list"、"activate"、"remove"、"forward_add"、"forward_list" 或 "forward_remove"');
            }) as AgentToolHandlers["manage_layers"],
            async run_batch({ steps, stop_on_fail, max_parallel, layer: layerName, output, ...unknownArgs }) {
                if (!Array.isArray(steps) || !steps.length) throw new Error(`steps 需为非空数组，每步提供 id 和 kind（${BATCH_STEP_KINDS.join("、")}）`);
                const extra = Object.keys(unknownArgs);
                if (extra.length) throw new Error(`run_batch 未知参数：${extra.join(", ")}（支持 steps、layer、stop_on_fail、max_parallel、output）`);
                if (output !== undefined && output !== "text" && output !== "full") throw new Error('output 需为 "text" 或 "full"');
                // 仅转换字段名，实际类型由内核 runBatch 在执行前统一校验。
                // 调用方基准：local_path / command_file 永远在调用方机器上；path / remote_path 只在
                // 这一步的目标是没有自己工作目录的本机层时（层名通配展开的目标不确定，不锚定）
                const plan: BatchPlan = {
                    steps: await Promise.all(steps.map(async (raw, stepIdx): Promise<BatchStepWithDeps> => {
                        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`steps[${stepIdx}] 需为对象`);
                        const { id, kind, layer, after, command, command_file, path, hunks, expect_exit, timeout_ms, write_mode, local_path, remote_path, transport, ...unknownFields } = raw;
                        const extra = Object.keys(unknownFields);
                        if (extra.length) throw new Error(`steps[${stepIdx}] 含未知字段：${extra.join(", ")}（目标层字段为 layer）`);
                        const localSide = await callerLocal(layer ?? layerName);
                        return {
                            id, kind, layer, after, command, transport,
                            path: (localSide ? anchor(path) : path) as string | undefined,
                            hunks,
                            commandFile: anchor(command_file) as string | undefined,
                            expectExit: expect_exit, timeoutMs: timeout_ms, writeMode: write_mode,
                            localPath: anchor(local_path) as string | undefined,
                            remotePath: (localSide ? anchor(remote_path) : remote_path) as string | undefined,
                        } as BatchStepWithDeps;
                    })),
                    stopOnFail: stop_on_fail,
                    maxParallel: max_parallel,
                };
                const batchCwd = await commandCwd(layerName);
                const r = await ops.runBatch({
                    plan, layer: layerName === undefined ? undefined : layerName,
                    // 目标是没有自己工作目录的本机层时带上调用方 cwd：exec 步骤仍由这一步所选的驱动
                    // 执行，只是在该目录执行（与 run_command 同一规则；具名层的身份不变）
                    ...(batchCwd !== undefined ? { cwd: batchCwd } : {}),
                    previewBudgetBytes: output === "text" ? 4096 : undefined,
                });
                return {
                    status: r.status,
                    failed_step: r.failedStep,
                    steps: r.steps.map((s) => ({
                        id: s.id, kind: s.kind, status: s.status,
                        ...(s.layer !== undefined ? { layer: s.layer } : {}),
                        ...(s.exitCode != null ? { exit_code: s.exitCode } : {}),
                        ...(s.outcome === "unknown" ? { outcome: "unknown" } : {}),
                        ...(s.stdout != null ? { stdout: s.stdout } : {}),
                        ...(s.stderr != null ? { stderr: s.stderr } : {}),
                        ...(s.error != null ? { error: s.error } : {}),
                        ...(s.skippedBecause != null ? { skipped_because: s.skippedBecause } : {}),
                        ...(s.transfer ? { transfer: agentTransferResult(s.transfer) } : {}),
                        // 编辑保护信息完整透传（成功用的无锁/非原子写入方式须让 Agent 可感知）
                        ...(s.edits != null ? {
                            edits: {
                                path: s.edits.path, occurrences: s.edits.occurrences,
                                bytes_before: s.edits.bytesBefore, bytes_after: s.edits.bytesAfter,
                                hunks: s.edits.hunks,
                                ...(s.edits.mutex != null ? { mutex: s.edits.mutex } : {}),
                                ...(s.edits.writeMode != null ? { write_mode: s.edits.writeMode } : {}),
                            },
                        } : {}),
                    })),
                };
            },
            stop_session: stopSession,
            // ── 兼容 0.2.10 旧工具名直调适配器 ──
            spawn_and_observe: startSession,
            stop_and_verify: stopSession,
            async read_file(args) {
                const { path, layer: layerName } = layerPathArgs(args);
                const drv = await middle.resolveLayerRef(layerName);
                if (!drv.fs.stat) throw new Error("该层不支持 read_file 的元数据（fs.stat 缺席）");
                const target = ((await callerLocal(layerName)) ? anchor(path) : path) as string;
                const st = await drv.fs.stat(target);
                if (!st) throw new Error(`文件不存在: ${path}`);
                if (st.isDirectory === true) throw new Error(`目标是目录（请使用 read_path 或 list_directory）: ${path}`);
                const content = await drv.fs.readFile(target);
                return { path, content, size: st.size, mtime_ms: st.mtimeMs };
            },
            async list_directory(args) {
                const { path, layer: layerName } = layerPathArgs(args);
                const target = ((await callerLocal(layerName)) ? anchor(path) : path) as string;
                return { path, entries: await (await middle.resolveLayerRef(layerName)).fs.readdir(target) };
            },
            async delete_file(args) {
                const { path, layer: layerName } = layerPathArgs(args);
                await ops.managePath({
                    layer: layerName, action: "delete",
                    path: ((await callerLocal(layerName)) ? anchor(path) : path) as string, recursive: false,
                });
                return { path, deleted: true as const };
            },
            put_file: (args) => transferFile("put", args),
            get_file: (args) => transferFile("get", args),
            async read_stream(args) {
                const raw = args as Record<string, unknown>;
                if ("duration_ms" in raw) throw new Error("read_stream 不支持 duration_ms，请使用 wait_ms");
                if (raw.window_id === undefined) requireWindowId("");
                const { window_id, limit, since_seq, before_seq, window_ms, wait_ms } = args;
                return publicStream(await ops.peekStream({
                    windowId: window_id, limit, afterSeq: since_seq, beforeSeq: before_seq, windowMs: window_ms, waitMs: wait_ms,
                }));
            },
            push_ssh: (async (args: Record<string, unknown>) => {
                if (enterLayerAliases.some((k) => args[k] !== undefined)) {
                    throw new Error("push_ssh 仅支持 SSH 目标，进入内层请使用 push_into 或 connect_layer");
                }
                return await connectSshLayer(args);
            }) as unknown as AgentToolHandlers["push_ssh"],
            async push_into(args) {
                const raw = args as Record<string, unknown>;
                const presentEnterKeys = enterLayerAliases.filter((k) => raw[k] !== undefined);
                if (!presentEnterKeys.length) {
                    throw new Error("push_into 需提供 enter_cmd（别名 enterCommand/enter_command/enterCmd 均可）");
                }
                return await connectIntoLayer(raw, presentEnterKeys);
            },
            async list_layers(_args) {
                void _args;
                const r = await ops.listLayers();
                return { text: r.text, layers: r.layers };
            },
            async set_active_layer({ name, ...extra }) {
                if (Object.keys(extra).length) throw new Error("set_active_layer 只接受 name");
                if (typeof name !== "string" || !name.trim()) throw new Error("name 需为非空层名");
                const r = await ops.activateLayer({ layer: name });
                return { active_layer: r.layer };
            },
            async remove_layer({ name, destroy }) {
                const r = await ops.removeLayer({ layer: name, destroy });
                return { removed: r.layer };
            },
        },
    };
}
