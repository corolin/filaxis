/**
 * agent-toolkit.ts — 原生 Agent 工具集（Gemini 试用反馈 #3 + 第十季层族）
 *
 * 一行 `createAgentToolkit(stack)` 生成 LLM 工具面——OpenAI/Anthropic/Vercel AI SDK
 * 通吃的 {tools, handlers} 双层结构：定义层喂模型，执行层留宿主（桥到任意框架）。
 * 语义契约（退出码是数据/终态三态/就绪握手）由内核承载，宿主零胶水。
 *
 * 第十季层族：执行类工具带可选 layer 参数（缺省=默认层——最近 push 的命名层；
 * 未用层族时与旧行为一致，零破坏）；push_ssh/push_into/list_layers/remove_layer
 * 操作 RuntimeStack 命名层注册表（Paramiko 式句柄寻址——栈/焦点弱化归消费方）。
 */
import { randomUUID } from "node:crypto";
import { StreamWindowRegistry, type StreamFrame } from "./stream-window.js";
import type { RuntimeStack } from "./runtime-stack.js";
import { editFile } from "./file-edit.js";
import { transferLayerFile, validateFileTransferFields, type FileTransferTransport, type LayerFileTransferResult } from "./layer-file-transfer.js";
import type { TransferResult } from "./file-transfer.js";
import { BATCH_STEP_KINDS, runBatch, type BatchStepWithDeps } from "./batch.js";
import type { RuntimeDriver } from "./driver.js";
import { SessionOwnership, type StopResult } from "./session-ownership.js";

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

export interface AgentToolHandlers {
    run_command(args: { command: string; timeout_ms?: number; layer?: string }): Promise<{
        stdout: string; stderr: string; exit_code: number; effective_user?: string;
    }>;
    read_file(args: { path: string; layer?: string }): Promise<{ path: string; content: string; size: number; mtime_ms: number }>;
    put_file(args: AgentFilePutArgs): Promise<AgentFileTransferResult>;
    get_file(args: AgentFileTransferArgs): Promise<AgentFileTransferResult>;
    edit_file(args: { path: string; old: string; new: string; all?: boolean; write_mode?: "auto" | "inplace"; layer?: string }): Promise<{
        path: string; occurrences: number; bytes_before: number; bytes_after: number; mutex?: "flock" | "degraded"; write_mode?: "atomic-replace" | "inplace-write";
    }>;
    observe_stream(args: { command: string; stream?: "stdout" | "stderr" | "both"; name?: string; layer?: string }): Promise<{
        window_id: string; name?: string; stale: boolean;
    }>;
    read_stream(args: { window_id: string; limit?: number; since_seq?: number; before_seq?: number; window_ms?: number; wait_ms?: number }): Promise<{
        window_id: string; oldest_seq: number; newest_seq: number; stale: boolean; frames: StreamFrame[];
        last_delivered_seq?: number; gap?: boolean; timed_out?: boolean; exit_code?: number | null; error?: string;
    }>;
    close_stream(args: { window_id: string }): Promise<{ window_id: string; closed: true }>;
    spawn_and_observe(args: { command: string; ready_marker?: string; error_pattern?: string; name?: string; layer?: string }): Promise<{
        session_id: string; log_base: string; note?: string;
    }>;
    stop_and_verify(args: { session_id: string; layer?: string }): Promise<StopResult>;
    // ── 层族（第十季命名层注册表——Paramiko 式句柄寻址）──
    push_ssh(args: { host: string; port?: number; user?: string; key?: string; jump?: string; name?: string }): Promise<{
        layer: string; reused: boolean; reused_from?: string; note?: string;
    }>;
    push_into(args: { enter_cmd: string; label?: string; from?: string; name?: string }): Promise<{
        layer: string; target?: string;
    }>;
    list_layers(args: Record<string, never>): Promise<{
        text: string; layers: Array<{ name: string; driver: string; target?: string }>;
    }>;
    remove_layer(args: { name: string; destroy?: boolean }): Promise<{ removed: string }>;
    // ── 批次组合（第十一季：一次调用描述多原子操作——减少 Planner 轮次）──
    run_batch(args: { steps: Array<Record<string, unknown>>; stop_on_fail?: boolean; max_parallel?: number; layer?: string; output?: "text" | "full" }): Promise<{
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
    /** 就绪握手与 watcher 轮询的超时上限 */
    readyTimeoutMs?: number;
    /** Retain confirmed results after releasing their driver reference. */
    sessionResultTtlMs?: number;
    /** Interval for checking tracked sessions and expiring results. */
    sessionCheckIntervalMs?: number;
}

const fileTransferProperties = {
    local_path: { type: "string", minLength: 1, description: "MCP 服务进程所在机器的文件路径" },
    remote_path: { type: "string", minLength: 1, description: "目标层内的文件路径" },
    layer: { type: "string", minLength: 1, description: "目标层名（缺省=默认层）" },
    transport: { type: "string", enum: ["exec", "sftp"], description: "缺省 exec。SFTP 适用于可直达的 SSH 文件系统" },
    timeout_ms: { type: "integer", minimum: 1, maximum: 2147483647, description: "每次 SSH 命令或 SFTP 进程的超时毫秒数，缺省 120000" },
};

/** 工具定义单一来源（REQ-0003 MCP tools/list 同源序列化——零漂移） */
export const TOOL_DEFS: AgentToolDef[] = [
    // run_batch 置顶（第十三季黑盒实测：Lazy schema 按序读 6 个基础
    // .json 就动手——run_batch 排第 7 被漏读，排查期连续 6 步串行 read_file
    // 单文件 89s/次。排序即发现面：高杠杆批处理工具必须在懒加载首屏）
    {
        type: "function",
        function: {
            name: "run_batch",
            description:
                "批次组合：一次调用描述多个文件或命令操作（exec/edit/read/put/get），按依赖边（after）拓扑执行——" +
                "步骤 layer 可覆盖批次 layer；after 可跨层引用步骤 id。无依赖步骤并行，顺序链靠 after 显式保序；默认任一步失败即停（未启动步骤标 " +
                "skipped）。返回逐步骤状态与证据（退出码/输出/编辑明细）。**不做自动回滚**（配置恢复≠运行" +
                "状态回滚——重载可能已产生外部副作用），失败现场交回调用方决策。",
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
                                layer: { type: "string", minLength: 1, description: "当前步骤的目标层名，覆盖批次默认层" },
                                command: { type: "string", description: "kind=exec：shell 命令" },
                                expect_exit: { type: "array", items: { type: "number" }, description: "kind=exec：预期退出码集合（缺省 [0]）" },
                                timeout_ms: { type: "number", description: "kind=exec：超时毫秒" },
                                path: { type: "string", description: "kind=edit/read：文件路径" },
                                write_mode: { type: "string", enum: ["auto", "inplace"], description: "kind=edit/put：inplace 保留目标 inode" },
                                hunks: {
                                    type: "array",
                                    description: "kind=edit：替换对（一次 CAS 原子应用——任一未命中整批拒绝不写）",
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
                    stop_on_fail: { type: "boolean", description: "失败即停（缺省 true）" },
                    max_parallel: { type: "number", description: "并行度上限（缺省 3）" },
                    layer: { type: "string", minLength: 1, description: "批次默认目标层名（缺省=调用时的默认层）" },
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
                "执行一次性命令（⚠️ 多条命令/多文件操作请改用 run_batch 一次并行打包；不会自己结束的命令用 observe_stream）。退出码如实返回（非零不是异常——是数据，供条件分支）；" +
                "只有无法执行（超时/中断/连接死）才报错。stdout 与 stderr 分离返回。",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "shell 命令" },
                    timeout_ms: { type: "number", description: "超时毫秒（缺省 120000）" },
                    layer: { type: "string", description: "目标层名（缺省=默认层——最近 push_ssh/push_into 的层）" },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "spawn_and_observe",
            description:
                "启动长跑任务（立即返回句柄不阻塞）。可选就绪标记（ready_marker——回溯热窗口，" +
                "快输出进程竞态安全）与错误模式（error_pattern——命中即自动收摊防遗忘泄漏）。" +
                "后续用 stop_and_verify 停止并核实终态。",
                parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "长跑命令" },
                    ready_marker: { type: "string", description: "就绪标记（如 'listening on'）" },
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
            name: "stop_and_verify",
            description:
                "停止任务并核实终态。status 三态：exited=拿到退出码；stopped=终止已核实；" +
                "unknown=核实不可达（非成功非失败——重试核实或显式上报，严禁当已清理）。",
            parameters: {
                type: "object",
                properties: {
                    session_id: { type: "string", description: "spawn_and_observe 返回的 session_id" },
                    layer: { type: "string", description: "外部或已过期会话需要指定所属层，初始层用 __initial__" },
                },
                required: ["session_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description:
                "只读获取目标层中的 UTF-8 文本文件（不修改远端状态），返回 { path, content, size, mtime_ms }。" +
                "文件不存在、无权限或层不支持元数据时报错；下载二进制文件请改用 get_file，同时读多个文件优先使用 run_batch，后续受控修改请配合 edit_file。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", minLength: 1, description: "目标层内的文件路径（绝对路径或相对层工作目录）" },
                    layer: { type: "string", description: "目标层名（缺省=默认层）" },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description:
                "受控编辑远端文件：精确替换（唯一命中校验，all=true 全替换）+ TOCTOU 乐观锁（他人先写则拒绝）" +
                "+ base64 保真写回（零 Shell 转义——绝不 sed -i）。未命中/多处命中/冲突均报错不盲写。" +
                "返回 write_mode：atomic-replace=原子替换；inplace-write=保留 inode（bind mount 挂载点 mv 不可用降级）——非原子写入，中断可暴露半截。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    old: { type: "string", description: "待替换片段（含足够上下文唯一）" },
                    new: { type: "string" },
                    all: { type: "boolean", description: "多处命中全替换（缺省报错）" },
                    write_mode: { type: "string", enum: ["auto", "inplace"], description: "inplace=已知 bind mount 挂载环境显式请求保留 inode 写（跳过 mv 失败尝试）" },
                    layer: { type: "string", description: "目标层名（缺省=默认层）" },
                },
                required: ["path", "old", "new"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "put_file",
            description: "从 MCP 服务所在机器上传一个文件到目标层。支持二进制，校验后落位，可能覆盖目标文件。返回校验等级和写入形态。",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ...fileTransferProperties,
                    write_mode: { type: "string", enum: ["auto", "inplace"], description: "缺省 auto。inplace 保留目标 inode" },
                },
                required: ["local_path", "remote_path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_file",
            description:
                "从目标层下载单个文件到 MCP 服务所在机器（支持二进制）。先传输至本地暂存文件并校验大小与 SHA-256 后再落位，校验失败不破坏已有本地文件；" +
                "成功时会覆盖已存在的 local_path，返回传输通道、字节大小、校验等级 (verification) 与写入形态 (write_mode)。" +
                "仅读取远端小文本请用 read_file，批量传输多个文件请使用 run_batch。",
            parameters: {
                type: "object",
                additionalProperties: false,
                properties: fileTransferProperties,
                required: ["local_path", "remote_path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "observe_stream",
            description: "打开持续观察窗并立即返回 window_id。用 read_stream 回看或续读，用 close_stream 关闭。",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string" },
                    stream: { type: "string", enum: ["stdout", "stderr", "both"], description: "流过滤，缺省 both" },
                    name: { type: "string", description: "窗口显示名称" },
                    layer: { type: "string", description: "目标层名，缺省使用默认层" },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_stream",
            description: "读取本地观察窗。可读最近帧、按 before_seq 向前翻页、按 window_ms 回看或按 since_seq 续读。每次续读用 last_delivered_seq，gap 表示游标区间有丢失。",
            parameters: {
                type: "object",
                properties: {
                    window_id: { type: "string", minLength: 1 },
                    limit: { type: "integer", minimum: 1, maximum: 200, description: "最多返回帧数，缺省 20" },
                    since_seq: { type: "integer", minimum: 0, description: "读取此序号之后的帧" },
                    before_seq: { type: "integer", minimum: 0, description: "读取此序号之前最近的帧" },
                    window_ms: { type: "integer", minimum: 0, description: "回看最近多少毫秒" },
                    wait_ms: { type: "integer", minimum: 0, maximum: 30000, description: "续读等待新增帧的毫秒数，仅用于 since_seq" },
                },
                required: ["window_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "close_stream",
            description:
                "关闭由 observe_stream 打开的本地观察窗，确认终止并回收对应的远端观察流进程与通道资源，返回 { window_id, closed: true }。" +
                "观察完成后应及时调用以防残留流进程；若 window_id 不存在或已关闭则报错（不影响其他观察窗）。",
            parameters: {
                type: "object",
                properties: { window_id: { type: "string", minLength: 1, description: "由 observe_stream 返回的观察窗 ID" } },
                required: ["window_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "push_ssh",
            description:
                "建立命名 ssh 层（成为默认层——后续工具缺省落它）。同落点幂等复用（reused=true 返回既有层，" +
                "不重复建连）+ 落点校验（宁重连不错主机）。跳板传 jump（-J 不占层）。",
            parameters: {
                type: "object",
                properties: {
                    host: { type: "string", description: "目标主机（user@host 或 ssh config 别名）" },
                    port: { type: "number", description: "SSH 端口（非 22 时指定）" },
                    user: { type: "string", description: "登录用户名" },
                    key: { type: "string", description: "私钥文件路径（-i）" },
                    jump: { type: "string", description: "跳板（-J：途径机不占层）" },
                    name: { type: "string", description: "层名（缺省=host；注册表内唯一，显式寻址用）" },
                },
                required: ["host"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "push_into",
            description:
                "从默认层（或 from 指定层）进入内层 shell（docker exec -i <ctr> sh / kubectl exec 等）——" +
                "enter 管线全量继承追加（父层 docker→再 su 不丢）。新层成为默认层。需 ssh 层为源。",
                parameters: {
                type: "object",
                properties: {
                    enter_cmd: { type: "string", description: "进入命令，如 \"docker exec -i web sh\"（别名 enterCommand/enter_command/enterCmd 等价）" },
                    label: { type: "string", description: "层显示标签" },
                    from: { type: "string", description: "源层名（缺省=默认层）" },
                    name: { type: "string", description: "层名（缺省=label）" },
                },
                required: ["enter_cmd"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_layers",
            description:
                "列出全部命名层（链路/状态/有效用户/默认层标记）。死层/退化层有警示标注（removeLayer 后按原参数重建）。",
            parameters: { type: "object", properties: {}, required: [] },
        },
    },
    {
        type: "function",
        function: {
            name: "remove_layer",
            description:
                "移出命名层（缺省连接保留在指纹缓存——再建同层零成本；destroy=true 才真销毁连接）。",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "层名" },
                    destroy: { type: "boolean", description: "真销毁连接（缺省 false=保留可复用）" },
                },
                required: ["name"],
            },
        },
    },
];

/** 生成 Agent 工具集（定义层 + 执行层；宿主桥接到任意 LLM 框架） */
export function createAgentToolkit(stack: RuntimeStack, opts: AgentToolkitOptions = {}): AgentToolkit {
    // 初始层（Hydrogen R7 #4）：descriptor 形态注册进命名表（list_layers 可见、
    // push_into 无 from 时 activeLayer 有源）+ 失败不缓存（rejected Promise 永久
    // 复用=不自愈；每次工具调用重连）。driver 直注形态不注册（外部生命周期）
    const INITIAL_LAYER_NAME = "__initial__";
    let layerPromise: Promise<RuntimeDriver> | undefined;
    let registeredInitial: RuntimeDriver | undefined;
    const layer = async (): Promise<RuntimeDriver> => {
        if (opts.driver) return opts.driver;
        if (registeredInitial && stack.layers.get(INITIAL_LAYER_NAME)?.driver !== registeredInitial) {
            registeredInitial = undefined;
            layerPromise = undefined;
        }
        layerPromise ??= (async () => {
            const drv = await stack.connect(opts.descriptor ?? { driver: "local" });
            if (opts.descriptor && opts.descriptor.driver !== "local") {
                const existing = stack.layers.get(INITIAL_LAYER_NAME);
                if (!existing) await stack.addLayer(INITIAL_LAYER_NAME, drv);
                if (stack.layers.get(INITIAL_LAYER_NAME)?.driver === drv) registeredInitial = drv;
            }
            return drv;
        })().catch((e) => {
            layerPromise = undefined; // 失败不缓存——下次调用重连（自愈）
            throw e;
        });
        return layerPromise;
    };
    const readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
    /** 层寻址（第十季注册表）：显式层名 > 注册表默认层（最近 push）> 初始层——
     *  未用层族时与旧行为逐字节一致（零破坏），push 后六工具自动落新默认层 */
    const resolveDrv = async (layerName?: string): Promise<RuntimeDriver> => {
        if (layerName) return stack.layer(layerName).driver;
        return stack.active ?? await layer();
    };
    const transferFile = async (operation: "put" | "get", args: AgentFilePutArgs): Promise<AgentFileTransferResult> => {
        const { local_path, remote_path, layer: layerName, transport, timeout_ms, write_mode, ...unknownFields } = args;
        const extra = Object.keys(unknownFields);
        if (extra.length) throw new Error(`${operation}_file 未知参数：${extra.join(", ")}`);
        if (layerName !== undefined && (typeof layerName !== "string" || !layerName.trim())) throw new Error("layer 需为非空字符串");
        const fields = { localPath: local_path, remotePath: remote_path, transport, timeoutMs: timeout_ms, writeMode: write_mode };
        validateFileTransferFields(operation, fields);
        return agentTransferResult(await transferLayerFile(await resolveDrv(layerName), operation, fields));
    };
    let windowRegistry: StreamWindowRegistry | undefined;
    let observationDisposed = false;
    const requireWindow = (windowId: string) => {
        if (typeof windowId !== "string" || !windowId.trim()) throw new Error("window_id 需为非空字符串，请使用 observe_stream 返回的 window_id");
        const window = windowRegistry?.get(windowId);
        if (!window || window.closed) throw new Error(`观察窗 '${windowId}' 不存在或已关闭`);
        return window;
    };
    const sessionOwner = new SessionOwnership(
        opts.sessionResultTtlMs ?? 60_000,
        opts.sessionCheckIntervalMs ?? 5_000,
    );

    /** 启动后失败共享收口（Astra 三十五期 P1 + 三十六期 P1 提取）：任务已启动但
     *  任何后续步骤（watch/tail/stop）失败时——等 stop 三态 → verify 双通道 →
     *  Error 挂 outcome+sessionId+logBase+原始原因。终态确定清归属；否则保留线索。 */
    const postLaunchFail = async (
        drv: RuntimeDriver,
        h: { sessionId: string; logBase: string },
        what: string,
        cause?: unknown,
    ): Promise<never> => {
        const causeNote = cause instanceof Error ? `（原因：${cause.message.slice(0, 80)}）` : "";
        const mk = (outcome: "stopped" | "unknown", extra: string): Error => {
            const e = new Error(
                `${what}——${extra}。会话线索 session_id=${h.sessionId} log_base=${h.logBase}` +
                `（重试前先核实：任务可能仍在运行）`,
            ) as Error & { outcome: string; sessionId: string; logBase: string };
            e.outcome = outcome;
            e.sessionId = h.sessionId;
            e.logBase = h.logBase;
            return e;
        };
        let stopRes: { status?: string; exitCode?: number | null } | undefined;
        try {
            stopRes = await drv.stopSession(h.sessionId);
        } catch { /* 停止通道失败——unknown 处理 */ }
        const st = stopRes?.status;
        if (st === "exited" || st === "stopped") {
            sessionOwner.remember(h.sessionId, { status: st, exit_code: stopRes?.exitCode });
            throw mk("stopped", `${st === "exited" ? "已停止（进程本已退出）" : "停止已核实"}${st === "exited" && stopRes?.exitCode != null ? `（exitCode=${stopRes.exitCode}）` : ""}${causeNote}`);
        }
        // unknown / 停止抛错：verify 双通道裁决（结论值放 try 外——三十四期教训）
        let stillRunningNote: string | undefined;
        let exitedViaVerify: number | null | undefined;
        try {
            const v = await drv.verifySession(h.sessionId);
            if (v.status === "running") stillRunningNote = "实测仍在运行（stop 未生效）";
            else if (v.status === "exited") exitedViaVerify = v.exitCode ?? null;
        } catch { /* verify 不可达——保持 unknown */ }
        if (exitedViaVerify !== undefined) {
            sessionOwner.remember(h.sessionId, { status: "exited", exit_code: exitedViaVerify });
            throw mk("stopped", `已退出（exitCode=${exitedViaVerify ?? "?"}）${causeNote}`);
        }
        throw mk("unknown", `${stillRunningNote ?? "停止结果未知（停止/核实通道均不可确认）"}${causeNote}`);
    };

    return {
        tools: TOOL_DEFS,
        dispose() {
            observationDisposed = true;
            windowRegistry?.dispose();
        },
        get layer(): Promise<RuntimeDriver> { return layer(); }, // 惰性 getter（失败不缓存+注册命名表——Hydrogen R7 #4）
        handlers: {
            async run_command({ command, timeout_ms, layer: layerName }) {
                const drv = await resolveDrv(layerName);
                const r = await drv.exec(command, { timeoutMs: timeout_ms });
                return {
                    stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode,
                    effective_user: r.effectiveUser,
                };
            },
            async spawn_and_observe({ command, ready_marker, error_pattern, name, layer: layerName }) {
                const drv = await resolveDrv(layerName);
                const h = await drv.execSession(command, name ? { name } : undefined);
                sessionOwner.track(h.sessionId, drv); // 归属记录（stop_and_verify 按此寻层）
                // 启动后异常统一走 postLaunchFail（三十五期 P1 + 三十六期提取共享）
                if (error_pattern) {
                    try {
                        drv.watchSession(h.sessionId, { pattern: error_pattern, once: false, thenStop: true });
                    } catch (err) {
                        await postLaunchFail(drv, h, "错误监听注册失败", err);
                    }
                }
                let note: string | undefined;
                if (ready_marker) {
                    // 就绪握手（回溯热窗口——快输出进程竞态安全）。超时/轮询失败统一走
                    // postLaunchFail（三十四期超时诚实三态 + 三十五/三十六期共享收口）
                    const t0 = Date.now();
                    let ticks = 0;
                    for (;;) {
                        let lines: string[];
                        try {
                            lines = await drv.tailSession(h.sessionId, 50);
                        } catch (err) {
                            await postLaunchFail(drv, h, "ready 轮询失败（tailSession 抛错）", err);
                        }
                        if (lines!.some((l) => l.includes(ready_marker))) { note = "ready"; break; }
                        if (Date.now() - t0 > readyTimeoutMs) {
                            await postLaunchFail(drv, h, `ready 超时（${readyTimeoutMs}ms 未见 '${ready_marker}'）`);
                        }
                        // 崩溃快速失败（Hydrogen R3 #7）：命令启动即崩（参数/配置错）曾
                        // 空轮询整个 readyTimeoutMs 才报超时——每 10 轮（~1s）核实一次
                        // 会话状态，已退出即带真实退出码走 postLaunchFail
                        if (++ticks % 10 === 0) {
                            const verified = await Promise.resolve()
                                .then(() => drv.verifySession(h.sessionId))
                                .catch(() => undefined);
                            if (verified?.status === "exited") {
                                sessionOwner.remember(h.sessionId, { status: "exited", exit_code: verified.exitCode });
                                throw Object.assign(new Error(
                                    `进程已退出（exitCode=${verified.exitCode ?? "?"}），未见 ready 标记 '${ready_marker}'`,
                                ), { outcome: "exited", exitCode: verified.exitCode, sessionId: h.sessionId, logBase: h.logBase });
                            }
                        }
                        await new Promise((r) => setTimeout(r, 100));
                    }
                }
                return { session_id: h.sessionId, log_base: h.logBase, note };
            },
            async read_file({ path, layer: layerName }) {
                const drv = await resolveDrv(layerName);
                if (!drv.fs.stat) throw new Error("该层不支持 read_file 的元数据（fs.stat 缺席）");
                const st = await drv.fs.stat(path);
                if (!st) throw new Error(`文件不存在: ${path}`);
                const content = await drv.fs.readFile(path);
                return { path, content, size: st.size, mtime_ms: st.mtimeMs };
            },
            async edit_file({ path, old, new: newStr, all, write_mode: writeMode, layer: layerName }) {
                const drv = await resolveDrv(layerName);
                const r = await editFile(drv, path, old, newStr, { all, writeMode });
                return { path: r.path, occurrences: r.occurrences, bytes_before: r.bytesBefore, bytes_after: r.bytesAfter, mutex: r.mutex, write_mode: r.writeMode };
            },
            put_file: (args) => transferFile("put", args),
            get_file: (args) => transferFile("get", args),
            async observe_stream(args) {
                if ("duration_ms" in args) throw new Error("observe_stream 持续开窗，请用 read_stream 的 wait_ms 限制单次等待");
                const { command, stream, name, layer: layerName } = args;
                if (observationDisposed) throw new Error("工具集已关闭");
                if (typeof command !== "string" || !command.trim()) throw new Error("command 需要非空字符串");
                if (stream !== undefined && !["stdout", "stderr", "both"].includes(stream)) throw new Error("stream 无效");
                const drv = await resolveDrv(layerName);
                if (observationDisposed) throw new Error("工具集已关闭");
                if (!drv.openStreamWindow) throw new Error(`层 '${layerName ?? drv.descriptor.driver}' 不支持持续观察窗`);
                const registry = windowRegistry ??= new StreamWindowRegistry();
                const id = randomUUID();
                const window = await drv.openStreamWindow(registry, { name: id, command, stream, retainSequence: false });
                return { window_id: id, ...(name ? { name } : {}), stale: window.stale };
            },
            async read_stream({ window_id, limit = 20, since_seq, before_seq, window_ms, wait_ms = 0 }) {
                if ([since_seq, before_seq, window_ms].filter((value) => value !== undefined).length > 1) {
                    throw new Error("since_seq、before_seq 和 window_ms 互斥");
                }
                for (const value of [since_seq, before_seq, window_ms, wait_ms]) {
                    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
                        throw new Error("观察窗的游标和时长需要非负整数");
                    }
                }
                if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("limit 须在 1–200 之间");
                if (wait_ms > 30000 || (wait_ms > 0 && since_seq === undefined)) {
                    throw new Error("wait_ms 仅用于续读，且最大为 30000");
                }
                const window = requireWindow(window_id);
                const deadline = Date.now() + wait_ms;
                const read = () => since_seq !== undefined ? window.peekSince(since_seq, limit)
                    : before_seq !== undefined ? window.peekBefore(before_seq, limit)
                    : window_ms !== undefined ? window.peekWindow(window_ms, limit)
                    : window.peekLast(limit);
                let result = read();
                while (since_seq !== undefined && !result.frames.length && !result.gap && !result.stale && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(50, deadline - Date.now()))));
                    requireWindow(window_id);
                    result = read();
                }
                return {
                    window_id, oldest_seq: result.oldestSeq, newest_seq: result.newestSeq,
                    stale: result.stale, frames: result.frames,
                    ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
                    ...(result.error !== undefined ? { error: result.error } : {}),
                    ...(result.lastDeliveredSeq !== undefined ? { last_delivered_seq: result.lastDeliveredSeq } : {}),
                    ...(result.gap ? { gap: true } : {}),
                    ...(wait_ms > 0 && !result.frames.length && !result.gap && !result.stale ? { timed_out: true } : {}),
                };
            },
            async close_stream({ window_id }) {
                requireWindow(window_id);
                await windowRegistry!.stopConfirmed(window_id);
                return { window_id, closed: true };
            },
            // ── 层族（第十季命名层注册表）──
            async push_ssh({ host, port, user, key, jump, name }) {
                const connParams: Record<string, unknown> = {};
                if (port != null) connParams.port = Number(port);
                if (user) connParams.user = String(user);
                if (key) connParams.keyFile = String(key);
                if (jump) connParams.jump = String(jump);
                const r = await stack.addLayer(name ?? String(host), {
                    driver: "ssh", target: String(host),
                    config: Object.keys(connParams).length ? { connParams } : undefined,
                });
                return {
                    layer: r.handle.name, reused: r.reused, reused_from: r.reusedFrom,
                    note: r.reused ? "落点已由既有层持有——幂等复用（未重复建连）" : "新层已建并成为默认层",
                };
            },
            async push_into(args) {
                // 参数别名宽收（第十二季语法糖）：enter_cmd / enterCommand / enter_command / enterCmd
                // 等价——Agent 手滑完整词不再静默漏建层（同款事故：enterCommand 拼错→裸宿主机层）
                const raw = args as Record<string, unknown>;
                const enterCmd = [raw.enter_cmd, raw.enterCommand, raw.enter_command, raw.enterCmd]
                    .find((v) => typeof v === "string" && v) as string | undefined;
                const label = raw.label as string | undefined;
                const from = raw.from as string | undefined;
                const name = raw.name as string | undefined;
                if (!enterCmd) {
                    throw new Error("push_into 需提供 enter_cmd（别名 enterCommand/enter_command/enterCmd 均可）");
                }
                const srcName = from ?? stack.activeLayer?.name;
                if (!srcName) throw new Error("无源层——先 push_ssh 建层，或显式传 from");
                const h = await stack.layerInto(srcName, name ?? label ?? enterCmd.slice(0, 30), enterCmd, { label });
                return { layer: h.name, target: h.descriptor.target };
            },
            async list_layers(_args) {
                void _args;
                return {
                    text: stack.layerText(),
                    layers: [...stack.layers.values()].map((h) => ({
                        name: h.name, driver: h.descriptor.driver, target: h.descriptor.target,
                    })),
                };
            },
            async remove_layer({ name, destroy }) {
                await stack.removeLayer(name, { destroy });
                return { removed: name };
            },
            async run_batch({ steps, stop_on_fail, max_parallel, layer: layerName, output, ...unknownArgs }) {
                if (!Array.isArray(steps) || !steps.length) throw new Error(`steps 需为非空数组，每步提供 id 和 kind（${BATCH_STEP_KINDS.join("、")}）`);
                const extra = Object.keys(unknownArgs);
                if (extra.length) throw new Error(`run_batch 未知参数：${extra.join(", ")}（支持 steps、layer、stop_on_fail、max_parallel、output）`);
                if (output !== undefined && output !== "text" && output !== "full") throw new Error('output 需为 "text" 或 "full"');
                const r = await runBatch(resolveDrv, {
                    steps: steps.map((raw, stepIdx): BatchStepWithDeps => {
                        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`steps[${stepIdx}] 需为对象`);
                        // 仅转换字段名，实际类型由 runBatch 在执行前统一校验。
                        const { id, kind, layer, after, command, path, hunks, expect_exit, timeout_ms, write_mode, local_path, remote_path, transport, ...unknownFields } = raw;
                        const extra = Object.keys(unknownFields);
                        if (extra.length) throw new Error(`steps[${stepIdx}] 含未知字段：${extra.join(", ")}（目标层字段为 layer）`);
                        return {
                            id, kind, layer, after, command, path, hunks, transport,
                            expectExit: expect_exit, timeoutMs: timeout_ms, writeMode: write_mode,
                            localPath: local_path, remotePath: remote_path,
                        } as BatchStepWithDeps;
                    }),
                    layer: layerName === undefined ? stack.activeLayer?.name : layerName,
                    stopOnFail: stop_on_fail,
                    maxParallel: max_parallel,
                }, output === "text" ? { previewBudgetBytes: 4096 } : {});
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
                        // 编辑保护信息完整透传（Astra 十九轮：成功用的无锁/非原子写入方式
                        // 须让 Agent 可感知——hunks 预览 + mutex + write_mode）
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
            async stop_and_verify({ session_id, layer: layerName }) {
                // 归属寻层（GPT Astra 二轮 #3 / 三轮 #1 / 四轮 #1）：spawn 在远端层的会话回该层停。
                // unknown 时自动接一次 verifySession 核实原语（DeepSeek 评审追问的 unknown 闭环）——
                // stop 的 unknown 是「停止瞬间核实不可达」，verify 是延迟后的独立探测通道。
                // 停止通道抛错也归 unknown 继续 verify（三十七期 #2：旧形态 await
                // 直接抛出——后面的 verify 根本不执行，裸抛无 unknown 标记）
                const entry = sessionOwner.get(session_id);
                if (entry && "result" in entry) return { ...entry.result };
                if (!entry && !layerName) {
                    return { status: "unknown", note: "会话归属未知或已过期，verify 需要显式指定 layer" };
                }
                const drv = entry && "driver" in entry
                    ? entry.driver
                    : layerName === INITIAL_LAYER_NAME ? await layer() : stack.layer(layerName!).driver;
                let r: { status?: string; exitCode?: number | null };
                try {
                    r = await drv.stopSession(session_id);
                } catch {
                    r = { status: "unknown", exitCode: null }; // 停止通道失败——归 unknown 走 verify
                }
                let status: "exited" | "stopped" | "unknown" =
                    r.status === "exited" || r.status === "stopped" || r.status === "unknown"
                        ? r.status
                        : (r.exitCode != null ? "exited" : "unknown"); // 旧形态归一：无死亡证明=unknown
                let exitCode = r.exitCode;
                let stillRunningNote: string | undefined;
                if (status === "unknown") {
                    try {
                        const v = await drv.verifySession(session_id);
                        if (v.status === "exited") { status = "exited"; exitCode = v.exitCode ?? null; }
                        else if (v.status === "running") {
                            stillRunningNote = "进程实测仍在运行（stop 未生效——不可中断态或权限不足）";
                        }
                    } catch { /* verify 不可达——保持 unknown */ }
                }
                if (status !== "unknown") {
                    const result: StopResult = status === "exited"
                        ? { status, exit_code: exitCode }
                        : { status, note: "终止已核实" };
                    sessionOwner.remember(session_id, result);
                    return result;
                }
                return {
                    status: "unknown",
                    note: stillRunningNote ?? "stop 与 verify 双通道均不可达——重连后 verify_session 或显式上报",
                };
            },
        },
    };
}
