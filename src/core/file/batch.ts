/**
 * batch.ts — 可组合的批量执行（第十一季：批次组合层——减少 Agent Planner 轮次）
 *
 * 两层能力定案（用户拍板）：原子执行（exec/editFile/cat/observe）不动；本层只做
 * **批次组合**——一次调用描述多个原子操作，返回逐步骤状态与证据。
 *
 * 设计约束（用户点名）：
 * - **区分依赖与可并行步骤**：DAG 依赖边（step.after）——无依赖边的工作就绪即并行
 *   （并行池 maxParallel 节流；exec 通道每步独立 ssh 子进程，CM 下共享 master），
 *   绝不把所有操作无脑串成一条 SSH 命令
 * - **顺序链语义**：文件修改 → 配置验证 → 服务重载这类链靠 after 边显式保序
 * - **fail-fast**：任一步失败（stopOnFail 缺省 true）→ 未启动步骤全标 skipped
 *   （正在跑的并行兄弟步骤等其完成并如实记录——杀正在跑的子进程有副作用风险）
 * - **不做自动回滚**（用户警示采纳）：配置恢复 ≠ 运行状态回滚——服务重载可能已
 *   产生外部副作用；失败时报告已执行步骤清单 + 证据，回滚决策交回调用方
 * - 退出码是数据（契约不变）：exec 步骤的成败按 expectExit（缺省 [0]）判定，
 *   非预期退出码 = fail，但退出码/输出原样进报告
 */
import type { RuntimeDriver } from "../base/driver.js";
import { readFileSync } from "node:fs";
import { editFileMulti, type EditMultiHunk } from "./file-edit.js";
import { transferLayerFile, validateFileTransferFields, type FileTransferTransport, type LayerFileTransferResult } from "./layer-file-transfer.js";
import { shellQuote } from "../ssh/ssh-helpers.js";

/** exec 步骤（命令 + 预期退出码集合——非零预期显式声明）。
 *  命令来源二选一：`command` 内联，或 `commandFile` 引用脚本文件（DSH 评估
 *  2026-11-26 #6）——命令原样进文件，JSON 字符串里的引号/换行转义全部省掉，
 *  且同一脚本可被多个步骤/批次复用。commandFile 在计划校验阶段读取并内联：
 *  读不出或为空即整批拒绝（零副作用），不会跑到一半才发现。 */
export interface BatchExecStep {
    id: string;
    kind: "exec";
    command?: string;
    /** 脚本文件路径（与 command 互斥）。相对路径按当前进程工作目录解析——经 Daemon
     *  执行时由调用方传入的工作目录解析（CLI 已接；MCP 直连请给绝对路径） */
    commandFile?: string;
    timeoutMs?: number;
    /** 预期退出码集合（缺省 [0]；如健康检查预期 [0] 或显式 [3]） */
    expectExit?: number[];
}

/** edit 步骤（多 hunk 一次 CAS 原子应用——任一未命中整批拒绝不写） */
export interface BatchEditStep {
    id: string;
    kind: "edit";
    path: string;
    hunks: Array<{ old: string; new: string; all?: boolean }>;
    /** inplace=已知 bind mount 显式请求保留 inode 写（Hydrogen R10 #3：曾缺透传） */
    writeMode?: "auto" | "inplace";
}

/** read 步骤（批量读取——无依赖边的多个 read 并行） */
export interface BatchReadStep {
    id: string;
    kind: "read";
    path: string;
}

interface BatchFileTransferStep {
    id: string;
    localPath: string;
    remotePath: string;
    transport?: FileTransferTransport;
    timeoutMs?: number;
}

export interface BatchPutStep extends BatchFileTransferStep {
    kind: "put";
    writeMode?: "auto" | "inplace";
}

export interface BatchGetStep extends BatchFileTransferStep {
    kind: "get";
    writeMode?: never;
}

export type BatchStep = BatchExecStep | BatchEditStep | BatchReadStep | BatchPutStep | BatchGetStep;
export const BATCH_STEP_KINDS = ["exec", "edit", "read", "put", "get"] as const satisfies readonly BatchStep["kind"][];

/** 目标层：单个层名或同步展开到多个层的层名数组 */
export type BatchLayerTarget = string | string[];

/** 依赖边：after 列出的步骤全部 ok 后才启动；无 after = 就绪即可并行 */
export type BatchStepWithDeps = BatchStep & { after?: string[]; layer?: BatchLayerTarget };

type ResolvedBatchStep = BatchStep & { layer?: string };

interface BatchStepGroup {
    order: number;
    after: string[];
    steps: ResolvedBatchStep[];
    dependents: BatchStepGroup[];
    pendingDependencies: number;
    pendingSuccesses: number;
    nextStep: number;
}

export interface BatchPlan {
    steps: BatchStepWithDeps[];
    /** 默认命名层（支持数组扇出）。步骤可覆盖；命名层需要传入层解析函数。 */
    layer?: BatchLayerTarget;
    /** 失败即停（缺省 true——未启动步骤标 skipped） */
    stopOnFail?: boolean;
    /** 并行度上限（缺省 3；exec 通道每并行步一条 ssh 子进程） */
    maxParallel?: number;
}

export type BatchStepStatus = "ok" | "fail" | "skipped";

export interface BatchStepReport {
    id: string;
    layer?: string;
    kind: BatchStep["kind"];
    status: BatchStepStatus;
    startedAt?: number;
    durationMs?: number;
    /** exec：退出码原样（数据——成败另按 expectExit 判） */
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    effectiveUser?: string;
    /**
     * 终态未知标记（GPT Astra #4）：exec 抛超时/abort/连接死时内核 Error 挂
     * outcome:"unknown"（远端可能已执行也可能没有）——批报告必须透传，调用方
     * 据此决定是否可安全重试（非幂等步骤严禁自动重放）。
     */
    outcome?: "unknown";
    /** edit：多 hunk 明细（old/new 文本即编辑预览） */
    edits?: { path: string; occurrences: number; bytesBefore: number; bytesAfter: number; hunks: EditMultiHunk[]; mutex?: "flock" | "degraded"; writeMode?: "atomic-replace" | "inplace-write" };
    transfer?: LayerFileTransferResult;
    /** skipped 原因（依赖失败 / 批次失败于某步） */
    skippedBecause?: string;
    error?: string;
}

export interface BatchReport {
    /** ok=全部步骤 ok；fail=任一步骤 fail */
    status: "ok" | "fail";
    steps: BatchStepReport[];
    failedStep?: string;
}

/**
 * 执行批次：拓扑就绪并行 + fail-fast + 逐步骤证据。
 *
 * @throws Error 计划非法（id 重复 / after 引用未知步骤 / 依赖环）——执行前校验，
 *               非法计划零副作用
 */
export async function runBatch(
    target: RuntimeDriver | ((layer?: string) => RuntimeDriver | Promise<RuntimeDriver>),
    plan: BatchPlan,
    options: { previewBudgetBytes?: number; commandCwd?: string } = {},
): Promise<BatchReport> {
    // ── 计划校验（零副作用阶段）──
    // 未知顶层键拒绝（DSH 真机巡检踩中：`layers` 与 `layer` 一字之差被静默忽略，
    // 计划落回默认层在调用方本机执行——「想扫集群、结果扫了自己」的副作用事故。
    // 拼错的字段名必须当场报错，不能当不存在。）
    if (plan && typeof plan === "object" && !Array.isArray(plan)) {
        const known = new Set(["steps", "layer", "stopOnFail", "maxParallel"]);
        const unknown = Object.keys(plan).filter((k) => !known.has(k));
        if (unknown.length > 0) {
            throw new Error(`批次计划非法：未知顶层字段 '${unknown.join("、")}'（合法: ${[...known].join("、")}——注意层字段名是 layer，可传数组扇出）`);
        }
    }
    if (!Array.isArray(plan?.steps) || plan.steps.length === 0) {
        // 空计划拒绝（冷路径摸排批 4：SDK 直调曾静默 ok——CLI 有守卫而内核没有，
        // 绕过 CLI 的消费方拿到「成功执行了零个步骤」的假成功）
        throw new Error(`批次计划非法：steps 需非空数组（kind 可为 ${BATCH_STEP_KINDS.join("、")}）`);
    }
    const planLayers = validateLayerTarget(plan.layer, "layer");
    if (plan.stopOnFail !== undefined && typeof plan.stopOnFail !== "boolean") throw new Error("stopOnFail 需为布尔值");
    const groups = new Map<string, BatchStepGroup>();
    const expandedSteps: ResolvedBatchStep[] = [];
    const expandedIds = new Set<string>();
    for (const [index, step] of plan.steps.entries()) {
        if (!nonEmptyString(step?.id)) throw new Error(`批次计划非法：steps[${index}].id 需非空字符串`);
        if (groups.has(step.id)) throw new Error(`批次计划非法：id 重复 '${step.id}'`);
        if (!BATCH_STEP_KINDS.includes(step.kind)) {
            throw new Error(`批次计划非法：未知 kind '${step.kind}'（合法: ${BATCH_STEP_KINDS.join("、")}）`);
        }
        // commandFile 在此读取并内联（零副作用阶段，且先于 validateStep——后者要求
        // command 已在场）；不改写调用方传入的计划对象
        const source = step.kind === "exec" ? { ...step, command: resolveExecCommand(step) } : step;
        const targetLayers = validateStep(source) ?? planLayers ?? [undefined];
        if (step.kind === "get" && targetLayers.length > 1) {
            throw new Error(`批次计划非法：步骤 '${step.id}' 的 kind='get' 不支持多个目标层（并发下载会覆盖同一 local_path），请拆分为独立步骤`);
        }
        const { after: dependencies, ...operation } = source;
        if (operation.kind === "exec" && operation.expectExit) operation.expectExit = [...operation.expectExit];
        if (operation.kind === "edit") operation.hunks = operation.hunks.map((hunk) => ({ ...hunk }));
        const steps = targetLayers.map((layer) => {
            const id = targetLayers.length === 1 ? step.id : `${step.id}@${layer}`;
            if (expandedIds.has(id)) throw new Error(`批次计划非法：展开后的步骤 id 冲突 '${id}'`);
            expandedIds.add(id);
            return { ...operation, id, layer };
        });
        for (const instance of steps) expandedSteps.push(instance);
        const after = [...new Set(dependencies)];
        groups.set(step.id, {
            order: index, after, steps, dependents: [],
            pendingDependencies: after.length, pendingSuccesses: steps.length, nextStep: 0,
        });
    }

    const roots: BatchStepGroup[] = [];
    for (const [id, group] of groups) {
        if (group.steps.length > 1 && expandedIds.has(id)) {
            throw new Error(`批次计划非法：展开后的步骤 id 冲突 '${id}'`);
        }
        for (const dep of group.after) {
            const prerequisite = groups.get(dep);
            if (!prerequisite) throw new Error(`批次计划非法：步骤 '${id}' 的 after 引用未知步骤 '${dep}'`);
            prerequisite.dependents.push(group);
        }
        if (group.pendingDependencies === 0) roots.push(group);
    }
    // Validate the logical DAG without expanding dependency edges between instances.
    const ordered = roots.slice();
    const remaining = new Map<BatchStepGroup, number>();
    for (const group of ordered) {
        for (const dependent of group.dependents) {
            const count = (remaining.get(dependent) ?? dependent.pendingDependencies) - 1;
            remaining.set(dependent, count);
            if (count === 0) ordered.push(dependent);
        }
    }
    if (ordered.length !== groups.size) throw new Error("批次计划非法：存在依赖环");

    // ── 执行（就绪并行 + fail-fast）──
    const reports = new Map<string, BatchStepReport>();
    const stopOnFail = plan.stopOnFail !== false;
    // maxParallel 守卫（Sol 五十四期 P1-5）：NaN 曾被 Math.max(1, NaN)=NaN——
    // 池 while(NaN < N) 恒假=零执行，唯一步骤被标 skipped 而批次报 ok
    const rawP = plan.maxParallel === undefined ? 3 : plan.maxParallel;
    if (!Number.isFinite(rawP) || rawP < 1) {
        throw new Error(`maxParallel 非法（${plan.maxParallel}）——须为 ≥1 的数字`);
    }
    const maxParallel = Math.floor(rawP);
    const { previewBudgetBytes } = options;
    if (previewBudgetBytes !== undefined && (!Number.isSafeInteger(previewBudgetBytes) || previewBudgetBytes < 0)) {
        throw new Error("previewBudgetBytes 需为非负整数");
    }
    const names = new Set(expandedSteps.map((s) => s.layer));
    const drivers = new Map<string | undefined, RuntimeDriver>();
    if (typeof target === "function") {
        for (const name of names) {
            if (name !== undefined) drivers.set(name, await target(name));
        }
        if (names.has(undefined)) drivers.set(undefined, await target());
        for (const [name, driver] of drivers) {
            if (!driver) throw new Error(`批次计划非法：未解析到运行层 '${name ?? "(默认)"}'`);
        }
    } else {
        if ([...names].some((name) => name !== undefined)) throw new Error("批次计划指定了 layer，需要层解析函数");
        drivers.set(undefined, target);
    }
    let previewBytes: number | undefined;
    if (previewBudgetBytes !== undefined) {
        let streams = 0;
        for (const step of expandedSteps) {
            if (step.kind !== "exec" && step.kind !== "read") continue;
            const driver = drivers.get(step.layer)!;
            const nativeRead = step.kind === "read" && typeof driver.fs.readFilePreview === "function";
            if (!nativeRead && !driver.supportsBoundedExec) {
                throw new Error(`步骤 '${step.id}' 的运行层不支持限制输出采集，请使用 full 模式`);
            }
            streams += nativeRead ? 1 : 2;
        }
        previewBytes = Math.floor(previewBudgetBytes / Math.max(1, streams));
    }
    const { commandCwd } = options;
    const stepIdentity = (step: ResolvedBatchStep) => ({
        id: step.id,
        kind: step.kind,
        ...(step.layer !== undefined ? { layer: step.layer } : {}),
    });
    let failedStep: string | undefined;

    // Prefer earlier eligible steps as before, with a heap of ready group heads.
    const ready = roots.slice();
    const enqueue = (group: BatchStepGroup): void => {
        let index = ready.length;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (ready[parent]!.order < group.order) break;
            ready[index] = ready[parent]!;
            index = parent;
        }
        ready[index] = group;
    };
    const removeHead = (): void => {
        const last = ready.pop()!;
        if (!ready.length) return;
        let index = 0;
        while (index * 2 + 1 < ready.length) {
            let child = index * 2 + 1;
            if (ready[child + 1] && ready[child + 1]!.order < ready[child]!.order) child++;
            if (last.order < ready[child]!.order) break;
            ready[index] = ready[child]!;
            index = child;
        }
        ready[index] = last;
    };

    const inflight = new Set<Promise<void>>();
    const pull = (): void => {
        while (ready.length && inflight.size < maxParallel && !(failedStep && stopOnFail)) {
            const group = ready[0]!;
            const step = group.steps[group.nextStep++]!;
            if (group.nextStep === group.steps.length) removeHead();
            const task = runStep(drivers.get(step.layer)!, step, previewBytes, commandCwd).then((report) => {
                reports.set(step.id, { ...stepIdentity(step), ...report });
                if (report.status === "fail") {
                    failedStep ??= step.id;
                } else if (--group.pendingSuccesses === 0) {
                    for (const dependent of group.dependents) {
                        if (--dependent.pendingDependencies === 0) enqueue(dependent);
                    }
                }
            }).finally(() => {
                inflight.delete(task);
                pull();
            });
            inflight.add(task);
        }
    };
    pull();
    while (inflight.size) await Promise.all([...inflight]);

    for (const group of groups.values()) {
        const skipped = group.steps.filter((step) => !reports.has(step.id));
        if (!skipped.length) continue;
        const skippedBecause = failedStep && stopOnFail
            ? `批次失败于 '${failedStep}'（fail-fast）`
            : `依赖步骤未 ok（${group.after.flatMap((dep) => groups.get(dep)!.steps
                .filter((step) => reports.get(step.id)?.status !== "ok").map((step) => step.id)).join(", ")}）`;
        for (const step of skipped) {
            reports.set(step.id, { ...stepIdentity(step), status: "skipped", skippedBecause });
        }
    }

    const steps = expandedSteps.map((s) => reports.get(s.id)!);
    return { status: failedStep ? "fail" : "ok", steps, failedStep };
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/** exec 步骤的命令来源（DSH 评估 2026-11-26 #6）：command 与 commandFile 二选一。
 *  commandFile 就地读取并内联为 command——计划非法时零副作用。内容归一同
 *  exec --script-file（剥 BOM、CRLF→LF：Windows 侧编辑器写出的脚本到 bash 里 \r 会
 *  被当成命令名的一部分）。相对路径按当前进程工作目录解析。 */
function resolveExecCommand(step: BatchExecStep): string {
    // 显式类型注解：never 返回的辅助函数只有这样声明，其后的控制流收窄才生效
    const invalid: (detail: string) => never = (detail): never => {
        throw new Error(`批次计划非法：步骤 '${step.id}' ${detail}`);
    };
    const hasCommand = step.command !== undefined;
    const hasFile = step.commandFile !== undefined;
    if (hasCommand && hasFile) invalid("的 command 与 commandFile 互斥（只能给一个）");
    if (hasFile) {
        const file = step.commandFile;
        if (typeof file !== "string" || !nonEmptyString(file)) invalid("的 commandFile 需为非空字符串路径");
        let raw: string;
        try {
            raw = readFileSync(file, { encoding: "utf-8" });
        } catch (error) {
            return invalid(`的 commandFile 读取失败（${file}）：${(error as Error).message}`);
        }
        const command = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, "\n");
        if (!command.trim()) invalid(`的 commandFile 内容为空（${file}）`);
        return command;
    }
    if (!hasCommand) invalid("是 exec 步骤但缺 command（内联命令，或改用 commandFile 引用脚本文件）");
    return step.command as string;
}

/** 层名是否含通配（`*` 任意字符序列、`?` 单个字符；DSH 评估 2026-11-26 #6） */
export function hasLayerWildcard(name: string): boolean {
    return /[*?]/.test(name);
}

function wildcardToRegExp(pattern: string): RegExp {
    return new RegExp(`^${pattern.split(/([*?])/).map((part) => (part === "*" ? ".*" : part === "?" ? "." : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("")}$`);
}

/**
 * 按已知层名展开一个层目标（层名或含通配的模式）。精确等于已知层名的优先按字面
 * 取（层名本身含 * ? 也不会被当模式）。无匹配返回空数组——由调用方决定报错口径。
 */
export function expandLayerPattern(target: string, known: readonly string[]): string[] {
    if (known.includes(target)) return [target];
    if (!hasLayerWildcard(target)) return [target];
    const re = wildcardToRegExp(target);
    return known.filter((name) => re.test(name));
}

/**
 * 计划里的层通配展开（CLI 与 MCP 入口共用；内核的层解析函数只认具体名，所以通配
 * 必须在入口按「已知层名全集」展开）。规则：
 * - 顶层 layer 与每个步骤的 layer（单个名或数组）里的模式都展开；展开结果保持已知
 *   层名的原有顺序；数组内去重。
 * - **无匹配即整批拒绝**（零副作用）：把 "q-*" 原样当层名交下去，轻则报「层未保存」，
 *   重则被当成默认层目标——静默换执行面。
 * - 不含通配的计划原样返回（同一对象引用）。
 */
export function expandBatchLayerWildcards(
    plan: BatchPlan,
    known: readonly string[] | (() => readonly string[]),
    knownLabel = "已存层",
): BatchPlan {
    if (!Array.isArray(plan.steps)) return plan;
    let names: readonly string[] | undefined;
    const expandOne = (target: string | string[] | undefined, where: string): string | string[] | undefined => {
        const targets = typeof target === "string" ? [target] : target;
        if (!Array.isArray(targets) || ![...targets].every(nonEmptyString) || !targets.some(hasLayerWildcard)) return target;
        validateLayerTarget(target, where);
        const available = names ??= typeof known === "function" ? known() : known;
        const expandName = (name: string): string[] => {
            const hit = expandLayerPattern(name, available);
            if (hit.length === 0) {
                const scope = available.length === 0
                    ? `（当前没有任何${knownLabel}）`
                    : `（现有：${available.slice(0, 12).join("、")}${available.length > 12 ? ` 等 ${available.length} 个` : ""}）`;
                throw new Error(`批次计划非法：${where} 的层通配 '${name}' 未匹配任何${knownLabel}${scope}`);
            }
            return hit;
        };
        if (typeof target === "string") {
            const hit = expandName(target);
            return hit.length === 1 ? hit[0]! : hit;
        }
        const out = [...new Set(targets.flatMap(expandName))];
        return out.length === targets.length && out.every((name, i) => name === targets[i]) ? target : out;
    };
    const layer = expandOne(plan.layer, "计划 layer");
    let touched = layer !== plan.layer;
    const steps = plan.steps.map((step) => {
        if (!step || typeof step !== "object" || step.layer === undefined) return step;
        const hit = expandOne(step.layer, `步骤 '${step.id}' 的 layer`);
        if (step.layer === hit) return step;
        touched = true;
        return { ...step, layer: hit };
    });
    return touched ? { ...plan, layer, steps } : plan;
}

function validateLayerTarget(value: unknown, label: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string") {
        if (!nonEmptyString(value)) {
            throw new Error(`批次计划非法：${label} 需为非空字符串或非空字符串数组`);
        }
        return [value];
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            throw new Error(`批次计划非法：${label} 需为非空字符串或非空字符串数组`);
        }
        const seen = new Set<string>();
        for (const name of value) {
            if (!nonEmptyString(name)) {
                throw new Error(`批次计划非法：${label} 需为非空字符串或非空字符串数组`);
            }
            if (seen.has(name)) {
                throw new Error(`批次计划非法：${label} 含重复层名 '${name}'`);
            }
            seen.add(name);
        }
        return [...seen];
    }
    throw new Error(`批次计划非法：${label} 需为非空字符串或非空字符串数组`);
}

function validateStep(step: BatchStepWithDeps): string[] | undefined {
    const invalid = (field: string, expected: string): never => {
        throw new Error(`批次计划非法：步骤 '${step.id}' 的 ${field} ${expected}`);
    };
    const stepLayers = validateLayerTarget(step.layer, `步骤 '${step.id}' 的 layer`);
    if (step.kind !== "exec" && "commandFile" in step && step.commandFile !== undefined) {
        invalid("commandFile", "只支持 kind='exec'");
    }
    if (step.after !== undefined && (!Array.isArray(step.after) || ![...step.after].every(nonEmptyString))) {
        invalid("after", "需为步骤 id 数组");
    }
    if (step.kind === "exec") {
        if (!nonEmptyString(step.command)) invalid("command", "需非空字符串");
        if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)) invalid("timeout_ms/timeoutMs", "需为正数");
        if (step.expectExit !== undefined && (!Array.isArray(step.expectExit) || ![...step.expectExit].every(Number.isSafeInteger))) {
            invalid("expect_exit/expectExit", "需为整数数组");
        }
        return stepLayers;
    }
    if (step.kind === "put" || step.kind === "get") {
        try { validateFileTransferFields(step.kind, step); }
        catch (error) { invalid("传输参数", (error as Error).message); }
        return stepLayers;
    }
    if (!nonEmptyString(step.path)) invalid("path", "需非空字符串");
    if (step.kind === "edit") {
        if (!Array.isArray(step.hunks) || !step.hunks.length || ![...step.hunks].every((h) =>
            typeof h?.old === "string" && h.old.length > 0 && typeof h.new === "string" && (h.all === undefined || typeof h.all === "boolean"))) {
            invalid("hunks", "需为非空数组，每项须含非空字符串 old、字符串 new，以及可选布尔值 all");
        }
        if (step.writeMode !== undefined && step.writeMode !== "auto" && step.writeMode !== "inplace") invalid("write_mode/writeMode", "须为 auto 或 inplace");
    }
    return stepLayers;
}

async function runStep(drv: RuntimeDriver, s: ResolvedBatchStep, previewBytes?: number, commandCwd?: string): Promise<BatchStepReport> {
    const startedAt = Date.now();
    const base = { id: s.id, kind: s.kind, startedAt };
    try {
        if (s.kind === "exec") {
            // command 在校验阶段已由 resolveExecCommand 保证在场（commandFile 已内联）
            const command = s.command;
            if (command === undefined) throw new Error(`步骤 '${s.id}' 缺少 command（内部错误：commandFile 未解析）`);
            // 命令工作目录只对「没有自己工作目录的本机层」生效：仍由这一步所选的驱动执行（不另建、
            // 不绕过），只是告诉它这次在哪里执行。层有自己的 cwd 或不是本机层时原样
            const withCwd = commandCwd !== undefined && drv.descriptor?.driver === "local" && !drv.descriptor.cwd;
            const r = await drv.exec(command, { timeoutMs: s.timeoutMs, maxOutputBytes: previewBytes, ...(withCwd ? { cwd: commandCwd } : {}) });
            const expect = s.expectExit ?? [0];
            const ok = expect.includes(r.exitCode);
            return {
                ...base,
                status: ok ? "ok" : "fail",
                durationMs: Date.now() - startedAt,
                exitCode: r.exitCode,
                stdout: r.stdout,
                stderr: r.stderr,
                effectiveUser: r.effectiveUser,
                error: ok ? undefined : `退出码 ${r.exitCode} 不在预期 ${JSON.stringify(expect)}`,
            };
        }
        if (s.kind === "edit") {
            const r = await editFileMulti(drv, s.path, s.hunks, s.writeMode ? { writeMode: s.writeMode } : {}); // 透传（R10 #3）
            return {
                ...base,
                status: "ok",
                durationMs: Date.now() - startedAt,
                edits: {
                    path: r.path, occurrences: r.occurrences,
                    bytesBefore: r.bytesBefore, bytesAfter: r.bytesAfter,
                    hunks: r.hunks, // old/new 文本即编辑预览
                    mutex: r.mutex, // 保护等级贯穿（Astra 五轮 P2）：无锁降级在批次报告显式可感知
                    writeMode: r.writeMode, // 写入形态贯穿（Astra 十九轮）：非原子降级在批次报告显式可感知
                },
            };
        }
        if (s.kind === "read") {
            let content: string;
            if (previewBytes === undefined) {
                content = await drv.fs.readFile(s.path);
            } else if (typeof drv.fs.readFilePreview === "function") {
                content = await drv.fs.readFilePreview(s.path, previewBytes);
            } else {
                const path = shellQuote(s.path);
                const r = await drv.exec(`test -f ${path} && cat < ${path}`, { maxOutputBytes: previewBytes });
                if (r.exitCode !== 0) throw new Error(`读取失败（退出码 ${r.exitCode}）：${r.stderr}`);
                content = r.stdout;
            }
            return { ...base, status: "ok", durationMs: Date.now() - startedAt, stdout: content };
        }
        if (s.kind === "put" || s.kind === "get") {
            const transfer = await transferLayerFile(drv, s.kind, s);
            return { ...base, status: "ok", durationMs: Date.now() - startedAt, transfer };
        }
        // 未知 kind 显式拒绝（Sol 五十四期 P2-6）：read 曾是兜底分支——kind:"typo"
        // 被当 read 执行还报成功（拼写错误静默降级成读文件）
        throw new Error(`未知步骤 kind '${(s as { kind: string }).kind}'（合法: ${BATCH_STEP_KINDS.join("、")}）`);
    } catch (raw) {
        // 判空优先（GPT Astra 四轮 #3）：自定义 driver 可能 throw null/undefined——
        // 直接读 (err as {outcome}).outcome 会再抛 TypeError，catch 块崩掉整份 runBatch
        // 报告。先归一化再提取字段。
        const outcome = raw != null && typeof raw === "object" && (raw as { outcome?: string }).outcome === "unknown"
            ? ("unknown" as const)
            : undefined;
        // outcome:"unknown" 透传（宪法字段）：超时/abort/连接死=远端终态未核实——
        // 调用方须按未知处理（非幂等步骤严禁自动重放），不能当确定失败
        return {
            ...base,
            status: "fail",
            durationMs: Date.now() - startedAt,
            ...(outcome ? { outcome } : {}),
            error: raw instanceof Error ? raw.message : String(raw ?? "driver 抛出空异常（null/undefined）"),
        };
    }
}
