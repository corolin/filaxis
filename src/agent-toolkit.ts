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
import type { RuntimeStack } from "./runtime-stack.js";
import { editFile } from "./file-edit.js";
import { runBatch, type BatchStepWithDeps } from "./batch.js";
import type { RuntimeDriver } from "./driver.js";

export interface AgentToolDef {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>; // JSON Schema
    };
}

export interface AgentToolHandlers {
    run_command(args: { command: string; timeout_ms?: number; layer?: string }): Promise<{
        stdout: string; stderr: string; exit_code: number; effective_user?: string;
    }>;
    read_file(args: { path: string; layer?: string }): Promise<{ path: string; content: string; size: number; mtime_ms: number }>;
    edit_file(args: { path: string; old: string; new: string; all?: boolean; write_mode?: "auto" | "inplace"; layer?: string }): Promise<{
        path: string; occurrences: number; bytes_before: number; bytes_after: number; mutex?: "flock" | "degraded"; write_mode?: "atomic-replace" | "inplace-write";
    }>;
    observe_stream(args: { command: string; duration_ms?: number; stream?: "stdout" | "stderr" | "both"; name?: string; layer?: string }): Promise<{
        session_id: string; lines: Array<{ stream: string; text: string }>;
    }>;
    spawn_and_observe(args: { command: string; ready_marker?: string; error_pattern?: string; name?: string; layer?: string }): Promise<{
        session_id: string; log_base: string; note?: string;
    }>;
    stop_and_verify(args: { session_id: string }): Promise<{
        status: "exited" | "stopped" | "unknown"; exit_code?: number | null; note?: string;
    }>;
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
    run_batch(args: { steps: Array<Record<string, unknown>>; stop_on_fail?: boolean; max_parallel?: number; layer?: string }): Promise<{
        status: "ok" | "fail"; failed_step?: string;
        steps: Array<{
            id: string; kind: string; status: string; exit_code?: number; outcome?: "unknown"; stdout?: string; stderr?: string; error?: string; skipped_because?: string;
            edits?: { path: string; occurrences: number; bytes_before: number; bytes_after: number; hunks: Array<{ old: string; new: string; occurrences: number }>; mutex?: "flock" | "degraded"; write_mode?: "atomic-replace" | "inplace-write" };
        }>;
    }>;
}

export interface AgentToolkit {
    tools: AgentToolDef[];
    handlers: AgentToolHandlers;
    /** 工具面绑定的层（缺省 local；远端层经 stack.connect 后传入重绑） */
    readonly layer: Promise<RuntimeDriver>;
}

export interface AgentToolkitOptions {
    /** 层描述符（缺省 local）；也可直接传已连接的 driver */
    descriptor?: { driver: string; target?: string; config?: Record<string, unknown> };
    driver?: RuntimeDriver;
    /** 就绪握手与 watcher 轮询的超时上限 */
    readyTimeoutMs?: number;
}

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
                "批次组合：一次调用描述多个原子操作（exec/edit/read），按依赖边（after）拓扑执行——" +
                "无依赖步骤并行，顺序链（改配置→验证→重载）靠 after 显式保序；任一步失败即停（未启动步骤标 " +
                "skipped）。返回逐步骤状态与证据（退出码/输出/编辑明细）。**不做自动回滚**（配置恢复≠运行" +
                "状态回滚——重载可能已产生外部副作用），失败现场交回调用方决策。",
            parameters: {
                type: "object",
                properties: {
                    steps: {
                        type: "array",
                        description: "步骤数组（id 唯一）",
                        items: {
                            type: "object",
                            properties: {
                                id: { type: "string", description: "步骤唯一 id（after 引用用）" },
                                kind: { type: "string", enum: ["exec", "edit", "read"] },
                                command: { type: "string", description: "kind=exec：shell 命令" },
                                expect_exit: { type: "array", items: { type: "number" }, description: "kind=exec：预期退出码集合（缺省 [0]）" },
                                timeout_ms: { type: "number", description: "kind=exec：超时毫秒" },
                                path: { type: "string", description: "kind=edit/read：文件路径" },
                                write_mode: { type: "string", enum: ["auto", "inplace"], description: "kind=edit：inplace=bind mount 显式请求保留 inode 写（R10 #3 补透传）" },
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
                    layer: { type: "string", description: "目标层名（缺省=默认层）" },
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
                },
                required: ["session_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "读取远端层文件（UTF-8 文本）。返回内容与 (size, mtime_ms)。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
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
            name: "observe_stream",
            description:
                "长跑观察（限时快照）：启动长跑会话并观察一段时间（缺省 8s）按流过滤（stderr/stdout/both），" +
                "返回行对象（带 stream 标记）。跨流序为到达序。",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string" },
                    duration_ms: { type: "number", description: "观察时长（缺省 8000）" },
                    stream: { type: "string", enum: ["stdout", "stderr", "both"], description: "流过滤（缺省 both）" },
                    name: { type: "string" },
                    layer: { type: "string", description: "目标层名（缺省=默认层）" },
                },
                required: ["command"],
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
    const layer = async (): Promise<RuntimeDriver> => {
        if (opts.driver) return opts.driver;
        layerPromise ??= (async () => {
            const drv = await stack.connect(opts.descriptor ?? { driver: "local" });
            if (opts.descriptor && opts.descriptor.driver !== "local") {
                try { await stack.addLayer(INITIAL_LAYER_NAME, drv); } catch { /* 已注册/复用路径容忍 */ }
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
    /** 会话归属表（GPT Astra 二轮 #3）：sessionId → 启动它的 driver——
     *  spawn 在远端层的会话必须回该层 stop（此前 stop_and_verify 固定用初始层，
     *  跨层会话停错层=必然失败）。无记录（外部会话/跨进程）回退初始层语义。 */
    const sessionOwner = new Map<string, RuntimeDriver>();

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
            sessionOwner.delete(h.sessionId);
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
            sessionOwner.delete(h.sessionId);
            throw mk("stopped", `已退出（exitCode=${exitedViaVerify ?? "?"}）${causeNote}`);
        }
        throw mk("unknown", `${stillRunningNote ?? "停止结果未知（停止/核实通道均不可确认）"}${causeNote}`);
    };

    return {
        tools: TOOL_DEFS,
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
                sessionOwner.set(h.sessionId, drv); // 归属记录（stop_and_verify 按此寻层）
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
                            try {
                                const v = await drv.verifySession(h.sessionId);
                                if (v.status !== "running") {
                                    await postLaunchFail(drv, h,
                                        `进程已退出（${v.status}${v.exitCode != null ? `, exitCode=${v.exitCode}` : ""}）——ready 标记 '${ready_marker}' 未出现`);
                                }
                            } catch { /* verify 通道异常不阻断轮询（超时兜底仍在） */ }
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
            async observe_stream({ command, duration_ms, stream, name, layer: layerName }) {
                const drv = await resolveDrv(layerName);
                const h = await drv.execSession(command, name ? { name } : undefined);
                sessionOwner.set(h.sessionId, drv); // 归属登记（三十五期 P2：远端观察的停止须回该层——旧形态 stop unknown 后 stop_and_verify 跑回初始层）
                const dur = duration_ms ?? 8000;
                await new Promise((r) => setTimeout(r, dur));
                // 双流：driver 带 sessions.tailLines（local/ssh 均有）用行对象；否则 stdout 投影兜底。
                // 双形态统一 await（第八季盲测 bug 实锤：local 同步返回数组、ssh 层
                // RemoteSessionManager.tailLines 是 async——漏 await 时 Promise 恒 truthy，
                // 兜底分支短路，lines.filter 直接 TypeError）。
                // 读取异常走 postLaunchFail（三十六期 P1：旧形态跳过停止裸抛——任务
                // 可能继续运行但调用者拿不到核实句柄）
                const anyDrv = drv as unknown as {
                    sessions?: {
                        tailLines?: (
                            id: string,
                            n?: number,
                        ) => Array<{ stream: string; text: string }> | Promise<Array<{ stream: string; text: string }>>;
                    };
                };
                let lines: Array<{ stream: string; text: string }>;
                try {
                    // 行数归一（Hydrogen R7 #3）：tailLines 曾 local 热窗 50 行上限 vs
                    // remote 双流各 500=1000 行（20 倍差且非到达序）——统一 readSessionLog
                    // （双后端同走落盘文件+lines 尾窗），行对象形态保留由 readLog 文本重建
                    // 后端兼容：readSessionLog 缺席（自定义 driver）回落 tailLines/tailSession
                    if (typeof drv.readSessionLog === "function") {
                        // 流感知读（readSessionLog 按 opts.stream 选 .out/.err——修前只读
                        // stdout 侧，stream:"stderr" 过滤后恒空）
                        const streams: Array<"stdout" | "stderr"> = stream === "both" || !stream ? ["stdout", "stderr"] : [stream];
                        lines = [];
                        for (const st of streams) {
                            const log = await drv.readSessionLog(h.sessionId, { lines: 500, stream: st });
                            for (const t of (log ?? "").split("\n")) {
                                if (t !== "") lines.push({ stream: st, text: t });
                            }
                        }
                    } else {
                        const anyDrv = drv as unknown as { sessions?: { tailLines?: (id: string, n?: number) => Array<{ stream: string; text: string }> | Promise<Array<{ stream: string; text: string }>> } };
                        lines = await (anyDrv.sessions?.tailLines?.(h.sessionId, 500)
                            ?? (await drv.tailSession(h.sessionId, 500)).map((t) => ({ stream: "stdout", text: t })));
                    }
                } catch (err) {
                    await postLaunchFail(drv, h, "观察输出读取失败", err);
                }
                const filtered = (stream && stream !== "both") ? lines!.filter((l) => l.stream === stream) : lines!;
                const stopR = await drv.stopSession(h.sessionId).catch(() => undefined);
                // 快照语义：停止结果不进返回承诺，但终态确定即清归属（顺线扫——
                // 未清会让后续 stop_and_verify 落到初始层白跑）；unknown 保留归属可核实
                if (stopR && stopR.status !== "unknown") sessionOwner.delete(h.sessionId);
                return { session_id: h.sessionId, lines: filtered };
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
            async run_batch({ steps, stop_on_fail, max_parallel, layer: layerName }) {
                const drv = await resolveDrv(layerName);
                // snake_case 工具参数 → BatchPlan（按 kind 分支构造判别联合；缺字段由 runBatch 校验）
                const plan = {
                    steps: steps.map((raw, stepIdx): BatchStepWithDeps => {
                        const s = raw as Record<string, unknown>;
                        const after = Array.isArray(s.after) ? { after: s.after.map(String) } : {};
                        if (s.kind === "edit") {
                            return {
                                // id 显式守卫（Hydrogen R10 #3）：String(undefined)="undefined"
                                // 曾绕过内核空 id 校验——模型漏传 id 必须在入口报错
                                ...(s.id === undefined || s.id === null || s.id === "" ? (() => { throw new Error(`edit 步骤缺 id（steps[${stepIdx}]）——每步须有唯一 id`); })() : { id: String(s.id) }),
                                kind: "edit", path: String(s.path ?? ""),
                                hunks: (Array.isArray(s.hunks) ? s.hunks : []).map((h) => {
                                    const hh = h as Record<string, unknown>;
                                    return { old: String(hh.old), new: String(hh.new), ...(hh.all != null ? { all: Boolean(hh.all) } : {}) };
                                }),
                                ...(s.write_mode != null ? { writeMode: s.write_mode as "auto" | "inplace" } : {}),
                                ...after,
                            };
                        }
                        if (s.kind === "read") {
                            if (s.id === undefined || s.id === null || s.id === "") {
                                throw new Error(`read 步骤缺 id（steps[${stepIdx}]）——每步须有唯一 id`);
                            }
                            return { id: String(s.id), kind: "read", path: String(s.path ?? ""), ...after };
                        }
                        return {
                            ...(s.id === undefined || s.id === null || s.id === "" ? (() => { throw new Error(`exec 步骤缺 id（steps[${stepIdx}]）——每步须有唯一 id`); })() : { id: String(s.id) }),
                            kind: "exec", command: String(s.command ?? ""),
                            ...(Array.isArray(s.expect_exit) ? { expectExit: s.expect_exit.map(Number) } : {}),
                            ...(s.timeout_ms != null ? { timeoutMs: Number(s.timeout_ms) } : {}),
                            ...after,
                        };
                    }),
                    ...(stop_on_fail != null ? { stopOnFail: Boolean(stop_on_fail) } : {}),
                    ...(max_parallel != null ? { maxParallel: Number(max_parallel) } : {}),
                };
                const r = await runBatch(drv, plan);
                return {
                    status: r.status,
                    failed_step: r.failedStep,
                    steps: r.steps.map((s) => ({
                        id: s.id, kind: s.kind, status: s.status,
                        ...(s.exitCode != null ? { exit_code: s.exitCode } : {}),
                        ...(s.outcome === "unknown" ? { outcome: "unknown" } : {}),
                        ...(s.stdout != null ? { stdout: s.stdout } : {}),
                        ...(s.stderr != null ? { stderr: s.stderr } : {}),
                        ...(s.error != null ? { error: s.error } : {}),
                        ...(s.skippedBecause != null ? { skipped_because: s.skippedBecause } : {}),
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
            async stop_and_verify({ session_id }) {
                // 归属寻层（GPT Astra 二轮 #3 / 三轮 #1 / 四轮 #1）：spawn 在远端层的会话回该层停。
                // unknown 时自动接一次 verifySession 核实原语（DeepSeek 评审追问的 unknown 闭环）——
                // stop 的 unknown 是「停止瞬间核实不可达」，verify 是延迟后的独立探测通道。
                // 停止通道抛错也归 unknown 继续 verify（三十七期 #2：旧形态 await
                // 直接抛出——后面的 verify 根本不执行，裸抛无 unknown 标记）
                const drv = sessionOwner.get(session_id) ?? await layer();
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
                if (status !== "unknown") sessionOwner.delete(session_id);
                if (status === "exited") return { status: "exited", exit_code: exitCode };
                if (status === "stopped") return { status: "stopped", note: "终止已核实" };
                return {
                    status: "unknown",
                    note: stillRunningNote ?? "stop 与 verify 双通道均不可达——重连后 verify_session 或显式上报",
                };
            },
        },
    };
}
