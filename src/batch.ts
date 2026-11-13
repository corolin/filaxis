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
import type { RuntimeDriver } from "./driver.js";
import { editFileMulti, type EditMultiHunk } from "./file-edit.js";

/** exec 步骤（命令 + 预期退出码集合——非零预期显式声明） */
export interface BatchExecStep {
    id: string;
    kind: "exec";
    command: string;
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

export type BatchStep = BatchExecStep | BatchEditStep | BatchReadStep;

/** 依赖边：after 列出的步骤全部 ok 后才启动；无 after = 就绪即可并行 */
export type BatchStepWithDeps = BatchStep & { after?: string[] };

export interface BatchPlan {
    steps: BatchStepWithDeps[];
    /** 失败即停（缺省 true——未启动步骤标 skipped） */
    stopOnFail?: boolean;
    /** 并行度上限（缺省 3；exec 通道每并行步一条 ssh 子进程） */
    maxParallel?: number;
}

export type BatchStepStatus = "ok" | "fail" | "skipped";

export interface BatchStepReport {
    id: string;
    kind: "exec" | "edit" | "read";
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
export async function runBatch(drv: RuntimeDriver, plan: BatchPlan): Promise<BatchReport> {
    // ── 计划校验（零副作用阶段）──
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
        // 空计划拒绝（冷路径摸排批 4：SDK 直调曾静默 ok——CLI 有守卫而内核没有，
        // 绕过 CLI 的消费方拿到「成功执行了零个步骤」的假成功）
        throw new Error(`批次计划非法：steps 需非空数组（[{id, kind: "exec"|"edit"|"read", ..., after?: [依赖 id]}]）`);
    }
    const byId = new Map<string, BatchStepWithDeps>();
    for (const s of plan.steps) {
        if (!s.id) throw new Error(`批次计划非法：存在无 id 步骤`);
        if (byId.has(s.id)) throw new Error(`批次计划非法：id 重复 '${s.id}'`);
        byId.set(s.id, s);
    }
    for (const s of plan.steps) {
        for (const dep of s.after ?? []) {
            if (!byId.has(dep)) throw new Error(`批次计划非法：步骤 '${s.id}' 的 after 引用未知步骤 '${dep}'`);
        }
    }
    // 环检测（DFS 三色）
    const color = new Map<string, 1 | 2>(); // 1=在途 2=完成
    const visit = (id: string, trail: string[]): void => {
        const c = color.get(id);
        if (c === 1) throw new Error(`批次计划非法：依赖环（${[...trail, id].join(" → ")}）`);
        if (c === 2) return;
        color.set(id, 1);
        for (const dep of byId.get(id)!.after ?? []) visit(dep, [...trail, id]);
        color.set(id, 2);
    };
    for (const s of plan.steps) visit(s.id, []);

    // ── 执行（就绪并行 + fail-fast）──
    const reports = new Map<string, BatchStepReport>();
    const stopOnFail = plan.stopOnFail !== false;
    // maxParallel 守卫（Sol 五十四期 P1-5）：NaN 曾被 Math.max(1, NaN)=NaN——
    // 池 while(NaN < N) 恒假=零执行，唯一步骤被标 skipped 而批次报 ok
    const rawP = plan.maxParallel ?? 3;
    if (!Number.isFinite(rawP) || rawP < 1) {
        throw new Error(`maxParallel 非法（${plan.maxParallel}）——须为 ≥1 的数字`);
    }
    const maxParallel = Math.floor(rawP);
    let failedStep: string | undefined;

    const done = (id: string): boolean => reports.get(id)?.status === "ok";
    const ready = (): BatchStepWithDeps[] =>
        plan.steps.filter((s) => !reports.has(s.id) && (s.after ?? []).every(done));

    for (;;) {
        if (failedStep && stopOnFail) {
            // fail-fast：未启动步骤全标 skipped；已启动的并行兄弟照常等完成（其结果已记录）
            for (const s of plan.steps) {
                if (!reports.has(s.id)) {
                    reports.set(s.id, {
                        id: s.id, kind: s.kind, status: "skipped",
                        skippedBecause: `批次失败于 '${failedStep}'（fail-fast）`,
                    });
                }
            }
            break;
        }
        // 工作池调度（Hydrogen R4 #4）：曾按批 Promise.all=波次屏障——同批 1 个慢
        // 步骤拖住全部空槽、就绪的后续步骤干等。改为 N worker 竞争拉取：完成即补位
        const running = new Set<string>();
        const inflight = new Set<Promise<void>>();
        const pull = (): void => {
            while (inflight.size < maxParallel) {
                if (failedStep && stopOnFail) return;
                const next = ready().find((st) => !running.has(st.id));
                if (!next) return;
                running.add(next.id);
                const t = runStep(drv, next).then((r) => {
                    reports.set(next.id, r);
                    if (r.status === "fail" && !failedStep) failedStep = next.id;
                }).finally(() => {
                    inflight.delete(t);
                    pull(); // 完成即补位（空闲槽立即吃下一个就绪步骤）
                });
                inflight.add(t);
            }
        };
        pull();
        while (inflight.size > 0) await Promise.all([...inflight]);
        // fail-fast 已触发 → 回循环头统一标 skipped（保留原 fail-fast 文案语义）
        if (failedStep && stopOnFail) continue;
        // 池收尾后仍无报告的步骤=被失败依赖卡死（stopOnFail=false 路径）
        const stuck = plan.steps.filter((s) => !reports.has(s.id));
        for (const s of stuck) {
            reports.set(s.id, {
                id: s.id, kind: s.kind, status: "skipped",
                skippedBecause: `依赖步骤未 ok（${(s.after ?? []).filter((d) => !done(d)).join(", ")}）`,
            });
        }
        break;
    }

    const steps = plan.steps.map((s) => reports.get(s.id)!);
    return { status: failedStep ? "fail" : "ok", steps, failedStep };
}

async function runStep(drv: RuntimeDriver, s: BatchStepWithDeps): Promise<BatchStepReport> {
    const startedAt = Date.now();
    const base = { id: s.id, kind: s.kind, startedAt };
    try {
        if (s.kind === "exec") {
            const r = await drv.exec(s.command, { timeoutMs: s.timeoutMs });
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
            const content = await drv.fs.readFile(s.path);
            return { ...base, status: "ok", durationMs: Date.now() - startedAt, stdout: content };
        }
        // 未知 kind 显式拒绝（Sol 五十四期 P2-6）：read 曾是兜底分支——kind:"typo"
        // 被当 read 执行还报成功（拼写错误静默降级成读文件）
        throw new Error(`未知步骤 kind '${(s as { kind: string }).kind}'（合法: exec|edit|read）`);
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
