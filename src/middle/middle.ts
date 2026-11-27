/**
 * middle/middle.ts — 中层：有状态的操作层（REQ-0004 §3、§5）
 *
 * 中层是唯一的一份操作实现。界面层（CLI、MCP、给大模型用的工具面）只管参数语法与
 * 结果呈现，经这里执行；Daemon 进程与 SDK 进程内只是宿主不同——createMiddle 建进程内
 * 实例，connectRemoteMiddle（daemon-client.ts）给出经 Daemon 的同形客户端。
 *
 * 约定
 * - 操作的参数与结果统一 camelCase（TypeScript 类型原样）；snake_case 只属于 MCP 工具面。
 * - 参数语法（未知字段、枚举、范围的报错文案）属于界面层；这里只带不变量守卫。
 * - 中层不读用户目录：已存层表读取函数由宿主装配时注入（savedLayers）。
 * - 与调用方机器相关的事（相对路径、工作目录）由界面层先解析成绝对路径再进来。
 *
 * 净室说明：层引用解析合并了原先 Daemon 的 resolveTarget 与工具集的 resolveDrv；
 * 观察窗合并了 Daemon 的 stream.* 与工具集的 observe_stream；转发同理。
 */
import * as crypto from "node:crypto";
import nodePath from "node:path";
import { StreamWindowRegistry, type StreamWindow } from "../core/stream/stream-window.js";
import { RuntimeStack, type LayerHandle } from "./runtime-stack.js";
import { SessionOwnership, type StopResult } from "./session-ownership.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { discoverLayer } from "../core/probe/layer-discovery.js";
import { validateFileTransferFields, transferLayerFile } from "../core/file/layer-file-transfer.js";
import { LocalRuntimeDriver } from "../core/local/local-driver.js";
import { SshPtyDriver } from "../core/ssh/ssh-pty-driver.js";
import type { RuntimeDescriptor, RuntimeDriver } from "../core/base/driver.js";
import { expandBatchLayerWildcards, runBatch } from "../core/file/batch.js";

/** 批次步骤种类的词表——工具面的参数 schema 与报错文案从这里取，不直接依赖内核 */
export { BATCH_STEP_KINDS } from "../core/file/batch.js";
import { editFile as coreEditFile, type EditFileResult } from "../core/file/file-edit.js";
import { noopLogger, type FilaxisLogger } from "../shared/logger.js";
import { isForwardActive, type CloseForwardResult, type ForwardInfo, type OpenForwardSpec } from "../core/ssh/ssh-forward.js";
import { layerDisplayName, sshArgsFor } from "../core/ssh/ssh-helpers.js";
import type {
    ConnectIntoResult, ConnectSshBatchResult, ConnectSshResult, ConnectSshTarget,
    LayerInfo, LayerRef, ManagePathResult, Middle, MiddleOps, ObserveResult, ProbeLayerResult, ReadPathResult,
    SessionHandle, SessionStopResult, StreamFilter, StreamName, StreamResult, StreamSummary, WriteFileResult,
} from "./types.js";

export interface MiddleOptions {
    /** 层栈（缺省新建；共享全局连接缓存） */
    stack?: RuntimeStack;
    /** 初始层描述符（缺省本机）；非本机描述符会登记为内部命名层 */
    descriptor?: RuntimeDescriptor;
    /** 外部持有生命周期的 driver（不登记进层栈） */
    driver?: RuntimeDriver;
    /** 外部共享的观察窗注册表（省略则自建自销） */
    windowRegistry?: StreamWindowRegistry;
    /** 就绪握手轮询的超时上限（缺省 15000） */
    readyTimeoutMs?: number;
    /** 会话结果保留时长（缺省 60000） */
    sessionResultTtlMs?: number;
    /** 会话跟踪检查间隔（缺省 5000） */
    sessionCheckIntervalMs?: number;
    /** 已存层表读取函数——按需调用、不缓存；不注入则不读任何层表 */
    savedLayers?: () => Record<string, RuntimeDescriptor>;
    logger?: FilaxisLogger;
    version?: string;
}

/** 进程内中层：除操作集外，把状态句柄也交给宿主（Daemon 汇总状态与收尾时要用） */
export interface LocalMiddle extends Middle {
    readonly stack: RuntimeStack;
    readonly sessionOwner: SessionOwnership;
    readonly resolveLayerRef: (ref: LayerRef) => Promise<RuntimeDriver>;
    /** 观察窗注册表（惰性创建） */
    windowRegistry(): StreamWindowRegistry;
    /** 观察窗清单（同步版，Daemon 状态汇总用） */
    listStreamsSync(): StreamSummary[];
    /** 宿主退出前的收尾：销毁全部 driver（见 createMiddle 返回值上的说明） */
    shutdown(): Promise<void>;
}

/** 层的人类可读名称（层清单显示用；界面层经这里取，不直接依赖内核） */
export const describeLayer: (descriptor: RuntimeDescriptor) => string = layerDisplayName;

/** connect 目标 → SSH 连接参数（字段缺省即不传，交给运行环境的 ssh 配置） */
function sshConnParams(target: ConnectSshTarget) {
    return {
        ...(target.port != null ? { port: Number(target.port) } : {}),
        ...(target.user ? { user: String(target.user) } : {}),
        ...(target.key ? { keyFile: String(target.key) } : {}),
        ...(target.jump ? { jump: String(target.jump) } : {}),
    };
}

/** 登记前的可路由性预检：与实际 SSH driver 相同的目标与跳板参数规则。批量建连时由
 *  调用方对每个目标先过一遍（全部合法才开始登记，避免登记到一半才发现有非法目标）。 */
export function assertSshTargetRoutable(target: ConnectSshTarget): void {
    sshArgsFor({ host: String(target.host), conn: sshConnParams(target) });
}

const INITIAL_LAYER_NAME = "__initial__";
export function createMiddle(opts: MiddleOptions = {}): LocalMiddle {
    const log = opts.logger ?? noopLogger;
    const stack = opts.stack ?? new RuntimeStack({ logger: log });
    let disposed = false;
    const assertOpen = () => { if (disposed) throw new Error("中层已关闭"); };

    // ── 默认层 ──
    // descriptor 形态登记进命名表（非 local 时）；失败不缓存（rejected Promise 永久复用
    // =不自愈；每次调用重连）。driver 直注形态不登记（外部生命周期）
    let layerPromise: Promise<RuntimeDriver> | undefined;
    let registeredInitial: RuntimeDriver | undefined;
    const initialLayer = async (): Promise<RuntimeDriver> => {
        if (opts.driver) return opts.driver;
        if (registeredInitial && stack.layers.get(INITIAL_LAYER_NAME)?.driver !== registeredInitial) {
            registeredInitial = undefined;
            layerPromise = undefined;
        }
        layerPromise ??= (async () => {
            const drv = await stack.connect(opts.descriptor ?? { driver: "local" });
            if (opts.driver === undefined && drv.descriptor?.driver === "local") {
                implicitLocal ??= { name: "local", descriptor: drv.descriptor, driver: drv };
            }
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

    // ── 已存层 ──
    // 未注册的层名命中入口注入的层表时按需登记。同名并发只建一次（名字预留会把第二次
    // addLayer 判成重名）；加载后与 connect 建立的层无差别。activate:false——不抢默认层。
    const loadingSaved = new Map<string, Promise<RuntimeDriver>>();
    const savedDescriptor = (name: string): RuntimeDescriptor | undefined => {
        if (!opts.savedLayers) return undefined;
        const store = opts.savedLayers();
        const entry = Object.hasOwn(store, name) ? store[name] : undefined;
        return entry && typeof entry === "object" ? entry : undefined;
    };
    const loadSaved = (name: string): Promise<RuntimeDriver> => {
        const inflight = loadingSaved.get(name);
        if (inflight) return inflight;
        const p = (async () => {
            const descriptor = savedDescriptor(name);
            if (!descriptor) throw new Error(`层 '${name}' 未注册，也不在已存层表里（filaxis layer list 查看已有层；filaxis layer save ${name} --host ... 创建）`);
            try {
                const driver = await stack.connect(descriptor);
                return (await stack.addLayer(name, driver, { activate: false })).handle.driver;
            } catch (e) {
                throw new Error(`已存层 '${name}' 加载失败: ${e instanceof Error ? e.message : String(e)}`);
            }
        })().finally(() => loadingSaved.delete(name));
        loadingSaved.set(name, p);
        return p;
    };
    /** 层名解析范围：已注册的在前，其后是已存层表里尚未注册的 */
    const knownLayerNames = (): string[] => {
        const names = [...stack.layers.keys()];
        if (opts.savedLayers) {
            for (const name of Object.keys(opts.savedLayers())) if (!names.includes(name)) names.push(name);
        }
        return names;
    };
    const savedLayersLabel = (): string => (opts.savedLayers ? "已注册层或已存层" : "已注册层");
    const resolveNamed = async (layerName?: string): Promise<RuntimeDriver> => {
        if (layerName !== undefined) {
            if (typeof layerName !== "string" || !layerName.trim()) throw new Error("layer 需为非空层名");
            if (stack.layers.has(layerName)) return stack.layer(layerName).driver;
            return loadSaved(layerName);
        }
        return stack.active ?? await initialLayer();
    };

    // ── 描述符引用 ──
    // SSH 层用「先实例化、后登记」的方式，不强迫预建 PTY 链（非交互 exec / 观察窗 /
    // 转发走独立通道，多跳不可直达的诚实拒绝语义要留到真正执行时）。
    const resolving = new Map<string, { key: string; promise: Promise<LayerHandle> }>();
    const ephemeralLayers = new Map<string, string>(); // 连接指纹 → 临时命名层的名字
    const ptyInitialized = new WeakSet<RuntimeDriver>();
    const ptyInitInflight = new Map<RuntimeDriver, Promise<void>>();
    let implicitLocal: LayerHandle | undefined;

    const instantiateDriver = (descriptor: RuntimeDescriptor): RuntimeDriver | null => {
        if (descriptor.driver === "local") {
            const cfg = (descriptor.config ?? {}) as Record<string, unknown>;
            const drv = new LocalRuntimeDriver({
                ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
                ...(typeof cfg.shell === "string" ? { shell: cfg.shell } : {}),
                logger: log,
            });
            drv.descriptor = { ...descriptor };
            return drv;
        }
        if (descriptor.driver === "ssh") return new SshPtyDriver(descriptor, { logger: log });
        return null;
    };
    const registerLayer = async (name: string, descriptor: RuntimeDescriptor, o: { activate?: boolean } = {}): Promise<LayerHandle> => {
        const direct = instantiateDriver(descriptor);
        if (direct) return (await stack.addLayer(name, direct, { activate: o.activate })).handle;
        return (await stack.addLayer(name, descriptor, { activate: o.activate })).handle;
    };
    const ensureOnce = (dedupKey: string, descriptorKey: string, create: () => Promise<LayerHandle>): Promise<LayerHandle> => {
        const inflight = resolving.get(dedupKey);
        if (inflight) {
            if (inflight.key !== descriptorKey) {
                throw new Error(`层 '${dedupKey.replace(/^(named|ephemeral):/, "")}' 正在并发注册或更新为另一份配置，拒绝合并不同描述符的并发请求`);
            }
            return inflight.promise;
        }
        const task = create().finally(() => {
            if (resolving.get(dedupKey)?.promise === task) resolving.delete(dedupKey);
        });
        resolving.set(dedupKey, { key: descriptorKey, promise: task });
        return task;
    };
    const isPlainLocal = (d: RuntimeDescriptor): boolean => d.driver === "local" && !d.cwd && !d.config;

    const descriptorHandle = async (ref: { descriptor: RuntimeDescriptor; name?: string }): Promise<LayerHandle> => {
        const { descriptor } = ref;
        const name = ref.name;
        if (name === undefined && isPlainLocal(descriptor)) {
            // 纯本机目标不登记（层清单里不该出现一个「本机」层）
            if (!implicitLocal) {
                const drv = await stack.connect({ driver: "local" });
                implicitLocal = { name: "local", descriptor: drv.descriptor, driver: drv };
            }
            return implicitLocal;
        }
        const desiredKey = RuntimeStack.driverKey(descriptor);
        if (name !== undefined) {
            if (typeof name !== "string" || !name.trim()) throw new Error("layer 需为非空层名");
            const fastExisting = stack.layers.has(name) ? stack.layer(name) : undefined;
            if (fastExisting && RuntimeStack.driverKey(fastExisting.descriptor) === desiredKey) return fastExisting;
            return ensureOnce(`named:${name}`, desiredKey, async () => {
                if (stack.layers.has(name)) {
                    const existing = stack.layer(name);
                    if (RuntimeStack.driverKey(existing.descriptor) === desiredKey) return existing;
                    const hasActiveForwards = stack.hasLiveForwards(name);
                    const hasActiveStreams = hasActiveStreamsForLayer(name);
                    if (hasActiveForwards || hasActiveStreams) {
                        throw new Error(
                            `层 '${name}' 已注册且配置与新描述符不一致，当前仍有${hasActiveForwards ? "正在建立或未确认关闭的动态端口转发" : "活跃观察窗"}，拒绝静默覆盖——请先清理该层资源或移除旧层后重试`,
                        );
                    }
                    const wasActive = stack.activeLayer?.name === name;
                    await stack.removeLayer(name, { destroy: false });
                    return registerLayer(name, descriptor, { activate: wasActive });
                }
                return registerLayer(name, descriptor, { activate: false });
            });
        }
        // 临时目标：按连接指纹登记为一个临时命名层（名字带指纹短哈希，同指纹复用）
        const cachedName = ephemeralLayers.get(desiredKey);
        const cached = cachedName === undefined ? undefined : stack.layers.get(cachedName);
        if (cached && RuntimeStack.driverKey(cached.descriptor) === desiredKey) return cached;
        ephemeralLayers.delete(desiredKey);
        return ensureOnce(`ephemeral:${desiredKey}`, desiredKey, async () => {
            const againName = ephemeralLayers.get(desiredKey);
            const again = againName === undefined ? undefined : stack.layers.get(againName);
            if (again && RuntimeStack.driverKey(again.descriptor) === desiredKey) return again;
            const shortHash = crypto.createHash("sha256").update(desiredKey).digest("hex").slice(0, 6);
            const base = (descriptor.target ?? descriptor.driver).replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 24) || "layer";
            let candidate = `${base}#${shortHash}`;
            if (stack.layers.has(candidate)) candidate = `${candidate}-${crypto.randomBytes(2).toString("hex")}`;
            const created = await registerLayer(candidate, descriptor, { activate: false });
            ephemeralLayers.set(desiredKey, created.name);
            return created;
        });
    };

    /** PTY 通道需要先建链（SSH 层）；同一 driver 只初始化一次 */
    const ensurePty = async (drv: RuntimeDriver): Promise<void> => {
        if (!(drv instanceof SshPtyDriver) || ptyInitialized.has(drv)) return;
        let task = ptyInitInflight.get(drv);
        if (!task) {
            task = drv.init().then(() => { ptyInitialized.add(drv); }).finally(() => { ptyInitInflight.delete(drv); });
            ptyInitInflight.set(drv, task);
        }
        await task;
    };

    /** 层引用 → driver（中层的唯一入口；界面层不自己拼 driver） */
    const resolveLayerRef = async (ref: LayerRef): Promise<RuntimeDriver> => {
        assertOpen();
        if (ref === undefined) return resolveNamed();
        if (typeof ref === "string") return resolveNamed(ref);
        if (typeof ref !== "object" || ref === null) throw new Error("layer 需为非空层名");
        if ("descriptor" in ref) return (await descriptorHandle(ref as { descriptor: RuntimeDescriptor; name?: string })).driver;
        if ("layer" in ref) return resolveNamed((ref as { layer?: string }).layer);
        throw new Error("layer 需为非空层名");
    };
    /** 报错里怎么称呼这个层引用：命名层用名字；临时目标用登记名、目标或驱动名 */
    const layerLabel = (ref: LayerRef): string => {
        if (typeof ref === "string") return ref;
        if (ref && "layer" in ref) return ref.layer;
        if (ref && "descriptor" in ref) return ref.name ?? ref.descriptor.target ?? ref.descriptor.driver;
        return "默认层";
    };

    // ── 观察窗 ──
    let windowRegistry: StreamWindowRegistry | undefined = opts.windowRegistry;
    let observationDisposed = false;
    const windows = (): StreamWindowRegistry => {
        if (observationDisposed) throw new Error("观察窗已关闭");
        windowRegistry ??= new StreamWindowRegistry({ logger: log });
        return windowRegistry;
    };
    // implicitLocal：开在未登记的本机 driver 上的窗——不属于任何命名层（哪怕恰好有层叫 local）
    const streamMeta = new Map<string, { displayName?: string; layer?: string; implicitLocal?: boolean }>();
    const pruneStreamMeta = (): void => {
        for (const id of [...streamMeta.keys()]) if (!windowRegistry?.get(id)) streamMeta.delete(id);
    };
    const hasActiveStreamsForLayer = (layerName: string): boolean => {
        pruneStreamMeta();
        for (const w of windowRegistry?.list() ?? []) {
            const win = windowRegistry?.get(w.name);
            if (!win || win.closed) continue;
            if (streamMeta.get(w.name)?.implicitLocal) continue;
            const ownerLayer = streamMeta.get(w.name)?.layer ?? w.layer;
            if (ownerLayer === layerName) return true;
        }
        return false;
    };
    const requireWindow = (windowId: string): StreamWindow => {
        if (typeof windowId !== "string" || !windowId.trim()) throw new Error("观察窗 ID 需为非空字符串（开窗时返回）");
        const window = windowRegistry?.get(windowId);
        if (!window || window.closed) throw new Error(`观察窗 '${windowId}' 不存在或已关闭`);
        return window;
    };
    function formatStreamResult(
        windowId: string,
        result: { oldestSeq: number; newestSeq: number; stale: boolean; frames: StreamResult["frames"]; exitCode?: number | null; error?: string; lastDeliveredSeq?: number; gap?: boolean },
        waitMs: number,
        meta?: { displayName?: string; layer?: string },
    ): StreamResult {
        return {
            windowId,
            ...(meta?.displayName ? { name: meta.displayName } : {}),
            ...(meta?.layer ? { layer: meta.layer } : {}),
            oldestSeq: result.oldestSeq,
            newestSeq: result.newestSeq,
            stale: result.stale,
            frames: result.frames,
            ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
            ...(result.lastDeliveredSeq !== undefined ? { lastDeliveredSeq: result.lastDeliveredSeq } : {}),
            ...(result.gap ? { gap: true } : {}),
            ...(waitMs > 0 && !result.frames.length && !result.gap && !result.stale ? { timedOut: true } : {}),
        };
    }
    const sleepUntil = (deadline: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.min(50, deadline - Date.now()))));

    // ── 会话 ──
    const readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
    const sessionOwner = new SessionOwnership(
        opts.sessionResultTtlMs ?? 60_000,
        opts.sessionCheckIntervalMs ?? 5_000,
    );
    /** 启动后失败共享收口：任务已启动但任何后续步骤失败时——等 stop 三态 → verify 双通道
     *  → Error 挂 outcome+sessionId+logBase+原始原因。终态确定清归属；否则保留线索 */
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
        if (st === "stopped" || (st === "exited" && Number.isSafeInteger(stopRes?.exitCode))) {
            sessionOwner.remember(h.sessionId, { status: st, exit_code: stopRes?.exitCode });
            throw mk("stopped", `${st === "exited" ? "已停止（进程本已退出）" : "停止已核实"}${st === "exited" && stopRes?.exitCode != null ? `（exitCode=${stopRes.exitCode}）` : ""}${causeNote}`);
        }
        // unknown / 停止抛错：verify 双通道裁决（结论值放 try 外）
        let stillRunningNote: string | undefined;
        let exitedViaVerify: number | undefined;
        try {
            const v = await drv.verifySession(h.sessionId);
            if (v.status === "running") stillRunningNote = "实测仍在运行（stop 未生效）";
            else if (v.status === "exited" && Number.isSafeInteger(v.exitCode)) exitedViaVerify = v.exitCode ?? undefined;
        } catch { /* verify 不可达——保持 unknown */ }
        if (exitedViaVerify !== undefined) {
            sessionOwner.remember(h.sessionId, { status: "exited", exit_code: exitedViaVerify });
            throw mk("stopped", `已退出（exitCode=${exitedViaVerify}）${causeNote}`);
        }
        throw mk("unknown", `${stillRunningNote ?? "停止结果未知（停止/核实通道均不可确认）"}${causeNote}`);
    };

    // ── 文件小件 ──
    const deleteSingleFile = async (path: string, drv: RuntimeDriver) => {
        const isWinLocal = drv.descriptor.driver === "local" && process.platform === "win32";
        const stripped = isWinLocal ? path.replace(/[/\\]+$/, "") : path.replace(/\/+$/, "");
        if (!stripped || /(?:^|\/)\.{1,2}$|\/$/.test(path)
            || (isWinLocal && /(?:^|\\)\.{1,2}$|\\$/.test(path))) {
            throw new Error("非递归删除需要单文件路径");
        }
        await drv.fs.rm(path, { recursive: false, force: false });
    };
    const isWinLocalDriver = (drv: RuntimeDriver) => drv.descriptor.driver === "local" && process.platform === "win32";

    /** 观察窗清单（同步——Daemon 的 status 是同步接口，要在这里汇总） */
    const listStreamsSync = (): StreamSummary[] => {
        pruneStreamMeta();
        const streams: StreamSummary[] = [];
        for (const w of windows().list()) {
            const win = windowRegistry!.get(w.name);
            const meta = streamMeta.get(w.name);
            streams.push({
                windowId: w.name,
                ...(meta?.displayName ? { name: meta.displayName } : {}),
                layer: meta?.layer ?? w.layer,
                command: w.command,
                oldestSeq: win?.oldestSeq ?? 0,
                newestSeq: win?.newestSeq ?? 0,
                stale: w.stale,
                closed: win?.closed ?? false,
            });
        }
        return streams;
    };

    // ── 操作集 ──
    const ops: MiddleOps = {
        async features() { return stack.features(); },

        // 层
        async connectSsh(target: ConnectSshTarget): Promise<ConnectSshResult> {
            assertOpen();
            const connParams = sshConnParams(target);
            const { handle, reused, reusedFrom } = await stack.addLayer(target.name ?? String(target.host), {
                driver: "ssh", target: String(target.host),
                config: Object.keys(connParams).length ? { connParams } : undefined,
            });
            return {
                layer: handle.name, reused, reusedFrom,
                note: reused ? "落点已由既有层持有——幂等复用（未重复建连）" : "新层已建并成为默认层",
            };
        },
        async connectSshBatch(targets: ConnectSshTarget[]): Promise<ConnectSshBatchResult> {
            const results: ConnectSshBatchResult["results"] = [];
            const connected = new Map<number, LayerHandle>();
            let failures = 0;
            // 串行登记：保持 RuntimeStack 的落点复用与默认层次序
            for (const target of targets) {
                const host = String(target.host);
                try {
                    const r = await ops.connectSsh(target);
                    const handle = stack.layers.get(r.layer);
                    if (handle) connected.set(results.length, handle);
                    results.push({ host, name: r.layer, status: "ok", ...r });
                } catch (error) {
                    failures++;
                    results.push({ host, name: target.name ?? host, status: "fail", error: error instanceof Error ? error.message : String(error) });
                }
            }
            const layers = new Set<string>();
            for (const [index, handle] of connected) {
                if (stack.layers.get(handle.name) === handle) {
                    layers.add(handle.name);
                } else {
                    const { host, name } = results[index]!;
                    results[index] = { host, name, status: "fail", error: `层 '${handle.name}' 在批量建连期间已移除或被替换` };
                    failures++;
                }
            }
            return {
                status: failures === 0 ? "ok" : failures === targets.length ? "fail" : "partial",
                activeLayer: stack.activeLayer?.name,
                layers: [...layers],
                results,
            };
        },
        async connectInto(args: { enterCmd: string; label?: string; from?: string; name?: string }): Promise<ConnectIntoResult> {
            const { enterCmd, label, from, name } = args;
            if (from !== undefined) await resolveNamed(from);
            const srcName = from ?? stack.activeLayer?.name;
            if (!srcName) throw new Error("无源层——先建立一个层，或显式指定 from");
            const h = await stack.layerInto(srcName, name ?? label ?? enterCmd.slice(0, 30), enterCmd, { label });
            return { layer: h.name, target: h.descriptor.target };
        },
        async listLayers() {
            return {
                text: stack.layerText(),
                layers: [...stack.layers.values()].map((h) => ({ name: h.name, driver: h.descriptor.driver, target: h.descriptor.target })),
            };
        },
        async activateLayer({ layer }) {
            await resolveNamed(layer);
            return { layer: stack.setActive(layer).name };
        },
        async removeLayer({ layer, destroy }) {
            await stack.removeLayer(layer, { destroy });
            for (const [key, mappedName] of [...ephemeralLayers.entries()]) if (mappedName === layer) ephemeralLayers.delete(key);
            return { layer };
        },
        async probeLayer({ layer }: { layer?: LayerRef }): Promise<ProbeLayerResult> {
            const r = await discoverLayer(await resolveLayerRef(layer), { skipStage2: false });
            return { key: r.key, spec: r.spec, note: r.probeNote };
        },

        // 执行
        async runCommand({ layer, command, timeoutMs, pty, cwd }) {
            assertOpen();
            if (typeof command !== "string" || !command.trim()) throw new Error("command 需为非空字符串");
            const drv = await resolveLayerRef(layer);
            if (pty) await ensurePty(drv);
            // 工作目录只对本机层有意义；不传时不去碰 driver 的描述符（替身驱动可能没有）
            return drv.exec(command, {
                timeoutMs,
                channel: pty ? "pty" : undefined,
                ...(cwd && drv.descriptor?.driver === "local" ? { cwd } : {}),
            });
        },
        async runBatch({ plan, layer, previewBudgetBytes, defaultLayer, layers, cwd }) {
            assertOpen();
            const known = (): string[] => {
                const names = [...stack.layers.keys()];
                for (const name of [...Object.keys(layers ?? {}), ...Object.keys(opts.savedLayers?.() ?? {})]) {
                    if (!names.includes(name)) names.push(name);
                }
                return names;
            };
            const expanded = expandBatchLayerWildcards(
                { ...plan, layer: plan.layer ?? layer ?? (defaultLayer === undefined ? stack.activeLayer?.name : undefined) },
                known,
                layers || opts.savedLayers ? "已注册层或已存层" : "已注册层",
            );
            let scoped: RuntimeDriver | undefined;
            const resolver = async (name?: string): Promise<RuntimeDriver> => {
                if (name !== undefined) {
                    // 调用方带来的描述符优先（重新保存过的层要立刻生效，不必等 Daemon 重启）
                    if (layers && Object.hasOwn(layers, name)) {
                        return (await descriptorHandle({ descriptor: layers[name]!, name })).driver;
                    }
                    return resolveNamed(name);
                }
                if (defaultLayer !== undefined) {
                    const drv = await resolveLayerRef(defaultLayer);
                    // 工作目录只作用于本机层，且不登记进层栈（调用方的工作目录不是一台环境）
                    if (cwd && drv.descriptor?.driver === "local") scoped ??= instantiateDriver({ driver: "local", cwd })!;
                    return scoped ?? drv;
                }
                return resolveNamed();
            };
            try {
                return await runBatch(resolver, expanded, previewBudgetBytes !== undefined ? { previewBudgetBytes } : {});
            } finally {
                if (scoped) await scoped.destroy().catch(() => undefined);
            }
        },
        async startSession({ layer, command, name, cwd, readyMarker, errorPattern }): Promise<SessionHandle> {
            assertOpen();
            const drv = await resolveLayerRef(layer);
            const sessionOpts = name || (cwd && drv.descriptor?.driver === "local")
                ? { ...(name ? { name } : {}), ...(cwd && drv.descriptor?.driver === "local" ? { cwd } : {}) }
                : undefined;
            const h = await drv.execSession(command, sessionOpts);
            sessionOwner.track(h.sessionId, drv); // 归属记录（stopSession 按此寻层）
            if (errorPattern) {
                try {
                    drv.watchSession(h.sessionId, { pattern: errorPattern, once: false, thenStop: true });
                } catch (err) {
                    await postLaunchFail(drv, h, "错误监听注册失败", err);
                }
            }
            let note: string | undefined;
            if (readyMarker) {
                // 就绪握手（回溯热窗口——快输出进程竞态安全）
                const t0 = Date.now();
                let ticks = 0;
                for (;;) {
                    let lines: string[];
                    try {
                        lines = await drv.tailSession(h.sessionId, 50);
                    } catch (err) {
                        await postLaunchFail(drv, h, "ready 轮询失败（tailSession 抛错）", err);
                    }
                    if (lines!.some((l) => l.includes(readyMarker))) { note = "ready"; break; }
                    if (Date.now() - t0 > readyTimeoutMs) {
                        await postLaunchFail(drv, h, `ready 超时（${readyTimeoutMs}ms 未见 '${readyMarker}'）`);
                    }
                    // 命令启动即崩时不空轮询整个超时——每 10 轮（约 1s）核实一次会话状态
                    if (++ticks % 10 === 0) {
                        const verified = await Promise.resolve()
                            .then(() => drv.verifySession(h.sessionId))
                            .catch(() => undefined);
                        if (verified?.status === "exited" && Number.isSafeInteger(verified.exitCode)) {
                            sessionOwner.remember(h.sessionId, { status: "exited", exit_code: verified.exitCode });
                            throw Object.assign(new Error(
                                `进程已退出（exitCode=${verified.exitCode}），未见 ready 标记 '${readyMarker}'`,
                            ), { outcome: "exited", exitCode: verified.exitCode, sessionId: h.sessionId, logBase: h.logBase });
                        }
                    }
                    await new Promise((r) => setTimeout(r, 100));
                }
            }
            return { sessionId: h.sessionId, logBase: h.logBase, note };
        },
        async stopSession({ sessionId, layer: layerName }): Promise<SessionStopResult> {
            // 归属寻层：spawn 在哪层，就回哪层停。unknown 时自动接一次 verifySession
            // 核实原语；停止通道抛错也归 unknown 继续 verify
            const entry = sessionOwner.get(sessionId);
            if (entry && "result" in entry) {
                const r: StopResult = entry.result;
                return { status: r.status, ...("exit_code" in r ? { exitCode: r.exit_code } : {}), ...(r.note !== undefined ? { note: r.note } : {}) };
            }
            if (!entry && !layerName) {
                return { status: "unknown", note: "会话归属未知或已过期，verify 需要显式指定 layer" };
            }
            const drv = entry && "driver" in entry
                ? entry.driver
                : layerName === INITIAL_LAYER_NAME ? await initialLayer() : await resolveNamed(layerName);
            let r: { status?: string; exitCode?: number | null };
            try {
                r = await drv.stopSession(sessionId);
            } catch {
                r = { status: "unknown", exitCode: null }; // 停止通道失败——归 unknown 走 verify
            }
            let status: "exited" | "stopped" | "unknown" = r.status === "stopped" ? "stopped"
                : r.status !== "unknown" && Number.isSafeInteger(r.exitCode) ? "exited" : "unknown";
            let exitCode = r.exitCode;
            let stillRunningNote: string | undefined;
            if (status === "unknown") {
                try {
                    const v = await drv.verifySession(sessionId);
                    if (v.status === "exited" && Number.isSafeInteger(v.exitCode)) { status = "exited"; exitCode = v.exitCode; }
                    else if (v.status === "running") {
                        stillRunningNote = "进程实测仍在运行（stop 未生效——不可中断态或权限不足）";
                    }
                } catch { /* verify 不可达——保持 unknown */ }
            }
            if (status !== "unknown") {
                const result: SessionStopResult = status === "exited" ? { status, exitCode } : { status, note: "终止已核实" };
                sessionOwner.remember(sessionId, status === "exited" ? { status, exit_code: exitCode } : { status, note: "终止已核实" });
                return result;
            }
            return {
                status: "unknown",
                note: stillRunningNote ?? "未取得可核实的终态。重连后，用完整会话 ID 和原目标层再次调用 stop_session，或上报结果未知。",
            };
        },
        async observe({ layer, command, stream, durationMs = 8000, cwd }: { layer?: LayerRef; command: string; stream?: StreamFilter; durationMs?: number; cwd?: string }): Promise<ObserveResult> {
            const drv = await resolveLayerRef(layer);
            const session = await drv.execSession(command, cwd && drv.descriptor?.driver === "local" ? { name: "observe", cwd } : { name: "observe" });
            await new Promise((r) => setTimeout(r, durationMs));
            const streams: StreamName[] = stream === "stderr" ? ["stderr"] : stream === "stdout" ? ["stdout"] : ["stdout", "stderr"];
            const lines: ObserveResult["lines"] = [];
            try {
                for (const st of streams) {
                    const log = await drv.readSessionLog(session.sessionId, { lines: 500, stream: st });
                    for (const text of (log ?? "").split("\n")) if (text !== "") lines.push({ stream: st, text });
                }
            } catch (e) {
                await drv.stopSession(session.sessionId).catch(() => undefined);
                const err = new Error(
                    `观察输出读取失败（${(e as Error).message}）——已尝试停止。` +
                    `会话线索 session_id=${session.sessionId} log_base=${session.logBase}（任务可能仍在运行，核实后再重试）`,
                ) as Error & { outcome: string; sessionId: string; logBase: string };
                err.outcome = "unknown";
                err.sessionId = session.sessionId;
                err.logBase = session.logBase;
                throw err;
            }
            const filtered = stream && stream !== "both" ? lines.filter((l) => l.stream === stream) : lines;
            const stopR = await drv.stopSession(session.sessionId).catch(() => ({ status: "unknown" as const }));
            let verifyStatus: ObserveResult["verifyStatus"];
            let verifyError: string | undefined;
            if (stopR.status === "unknown") {
                verifyStatus = "unknown";
                try {
                    verifyStatus = (await drv.verifySession(session.sessionId)).status;
                } catch (e) {
                    verifyError = (e as Error).message;
                }
            }
            return {
                lines: filtered,
                stopStatus: stopR.status,
                ...(verifyStatus !== undefined ? { verifyStatus } : {}),
                ...(verifyError !== undefined ? { verifyError } : {}),
                sessionId: session.sessionId,
                logBase: session.logBase,
            };
        },

        // 文件
        async readFile({ layer, path }) {
            if (typeof path !== "string" || !path) throw new Error("path 需为非空路径");
            return { content: await (await resolveLayerRef(layer)).fs.readFile(path) };
        },
        async readPath({ layer, path }): Promise<ReadPathResult> {
            const drv = await resolveLayerRef(layer);
            if (!drv.fs.stat) {
                if (typeof drv.fs.readdir === "function") {
                    try {
                        return { path, type: "directory", entries: await drv.fs.readdir(path) };
                    } catch (err) {
                        const detail = err instanceof Error ? err.message : String(err);
                        throw new Error(`无法读取路径（fs.stat 缺席且列目录失败：${detail}）: ${path}`);
                    }
                }
                throw new Error("该层不支持路径元数据（fs.stat 缺席）");
            }
            const isPermissionError = (err: unknown): boolean => {
                const code = (err as NodeJS.ErrnoException | undefined)?.code;
                if (code === "EACCES" || code === "EPERM") return true;
                const msg = err instanceof Error ? err.message : String(err);
                return /permission denied|operation not permitted|access is denied|eacces|eperm|权限不足/i.test(msg);
            };
            const isNotFoundOrNotDirError = (err: unknown): boolean => {
                if (isPermissionError(err)) return false;
                const code = (err as NodeJS.ErrnoException | undefined)?.code;
                if (code === "ENOENT" || code === "ENOTDIR") return true;
                if (code) return false;
                const msg = err instanceof Error ? err.message : String(err);
                return /no such file or directory|not a directory|does not exist|not found|enoent|enotdir/i.test(msg);
            };
            const st = await drv.fs.stat(path);
            if (!st) {
                if (typeof drv.fs.readdir === "function") {
                    try {
                        return { path, type: "directory", entries: await drv.fs.readdir(path) };
                    } catch (dirErr) {
                        if (!isNotFoundOrNotDirError(dirErr)) throw dirErr;
                    }
                }
                throw new Error(`路径不存在: ${path}`);
            }
            if (st.isDirectory === true) return { path, type: "directory", entries: await drv.fs.readdir(path) };
            if (st.isDirectory === false) {
                const content = await drv.fs.readFile(path);
                return { path, type: "file", content, size: st.size, mtimeMs: st.mtimeMs };
            }
            try {
                const content = await drv.fs.readFile(path);
                return { path, type: "file", content, size: st.size, mtimeMs: st.mtimeMs };
            } catch (err) {
                if (typeof drv.fs.readdir === "function") {
                    try {
                        return { path, type: "directory", entries: await drv.fs.readdir(path) };
                    } catch (dirErr) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        const fileSaidIsDir = (err as NodeJS.ErrnoException | undefined)?.code === "EISDIR"
                            || /eisdir|is a directory/i.test(errMsg);
                        if (fileSaidIsDir || isPermissionError(dirErr)) throw dirErr;
                    }
                }
                throw err;
            }
        },
        async writeFile({ layer, path, content, overwrite, createDirs }): Promise<WriteFileResult> {
            const drv = await resolveLayerRef(layer);
            if (/(?:^|\/)\.{1,2}$|\/$/.test(path)
                || (isWinLocalDriver(drv) && /(?:^|\\)\.{1,2}$|\\$/.test(path))) {
                throw new Error("需要有效的文件路径");
            }
            if (createDirs) {
                const isWinLocal = isWinLocalDriver(drv);
                const parent = isWinLocal ? nodePath.win32.dirname(path) : nodePath.posix.dirname(path);
                if (parent && parent !== "." && parent !== "/" && !(isWinLocal && /^[A-Za-z]:[/\\]?$/.test(parent))) {
                    await drv.fs.mkdir(parent, { recursive: true });
                }
            }
            if (!overwrite) {
                if (typeof drv.fs.createFile !== "function") {
                    throw new Error("该层不支持独占创建文件（fs.createFile 缺席）；如需覆写请显式请求覆写");
                }
                try {
                    await drv.fs.createFile(path, content);
                } catch (err) {
                    const code = (err as { code?: string } | null)?.code;
                    const msg = err instanceof Error ? err.message : String(err);
                    if (code === "EEXIST" || msg.includes("EEXIST") || msg.includes("文件已存在")) {
                        throw new Error(`文件已存在，拒绝覆盖: ${path}`);
                    }
                    throw err;
                }
                return { path, created: true, bytesAfter: Buffer.byteLength(content, "utf-8") };
            }
            const existed = await drv.fs.exists(path);
            await drv.fs.writeFile(path, content);
            return { path, created: !existed, bytesAfter: Buffer.byteLength(content, "utf-8") };
        },
        async editFile({ layer, path, old, new: newStr, all, writeMode }): Promise<EditFileResult> {
            return coreEditFile(await resolveLayerRef(layer), path, old, newStr, { all, writeMode });
        },
        async managePath(args): Promise<ManagePathResult> {
            const { layer, action, path } = args;
            const drv = await resolveLayerRef(layer);
            if (action === "mkdir") {
                await drv.fs.mkdir(path, { recursive: args.parents === undefined ? true : Boolean(args.parents) });
                return { action: "mkdir", path, created: true };
            }
            if (action === "move") {
                const destination = args.destination!;
                const isWinLocal = isWinLocalDriver(drv);
                if (/(?:^|\/)\.{1,2}$|\/$/.test(path) || /(?:^|\/)\.{1,2}$|\/$/.test(destination)
                    || (isWinLocal && (/(?:^|\\)\.{1,2}$|\\$/.test(path) || /(?:^|\\)\.{1,2}$|\\$/.test(destination)))) {
                    throw new Error("移动需要精确的文件或目录路径，不支持 . / .. 或尾斜杠");
                }
                if (!drv.fs.rename) throw new Error("该层不支持路径移动/重命名（fs.rename 缺席）");
                await drv.fs.rename(path, destination);
                return { action: "move", path, destination, moved: true };
            }
            const isRecursive = args.recursive === undefined ? false : Boolean(args.recursive);
            if (!isRecursive) {
                await deleteSingleFile(path, drv);
            } else {
                const isWinLocal = isWinLocalDriver(drv);
                const stripped = isWinLocal ? path.replace(/[/\\]+$/, "") : path.replace(/\/+$/, "");
                if (!stripped
                    || /(?:^|\/)\.{1,2}$/.test(stripped)
                    || (isWinLocal && (/^(?:\.{1,2}|[A-Za-z]:)$/.test(stripped) || /(?:^|\\)\.{1,2}$/.test(stripped)))) {
                    throw new Error("拒绝删除根目录、工作目录或上级等价路径");
                }
                await drv.fs.rm(path, { recursive: true, force: false });
            }
            return { action: "delete", path, deleted: true, recursive: isRecursive };
        },
        async transferFile({ layer, direction, localPath, remotePath, transport, timeoutMs, writeMode }) {
            if (direction !== "put" && direction !== "get") throw new Error('direction 需为 "put" 或 "get"');
            const fields = { localPath, remotePath, transport, timeoutMs, writeMode };
            validateFileTransferFields(direction, fields);
            return transferLayerFile(await resolveLayerRef(layer), direction, fields);
        },

        // 观察窗
        async openStream({ layer, command, stream, name, limit = 20, waitMs = 0, cwd }) {
            assertOpen();
            if (typeof command !== "string" || !command.trim()) throw new Error("command 需为非空字符串");
            const drv = await resolveLayerRef(layer);
            if (observationDisposed) throw new Error("观察窗已关闭");
            if (typeof drv.openStreamWindow !== "function") {
                throw new Error(`层 '${layerLabel(layer)}' (${drv.descriptor.driver}) 不支持持续观察窗`);
            }
            // 工作目录只对本机层有意义，是「这次开窗的参数」：交给所选驱动自己处理（经 Daemon 时
            // 它的工作目录与调用方无关，所以要由调用方传进来）。不另建驱动——那会绕过注入的驱动
            // 与驱动自己的 shell 配置
            const registry = windows();
            const id = crypto.randomUUID();
            const owner = [...stack.layers.values()].find((h) => h.driver === drv);
            const win = await drv.openStreamWindow(registry, {
                name: id,
                command,
                stream,
                retainSequence: false,
                ...(cwd && drv.descriptor?.driver === "local" ? { cwd } : {}),
            });
            streamMeta.set(id, {
                displayName: name,
                layer: owner?.name ?? (drv.descriptor?.driver === "local" ? "local" : undefined),
                ...(owner ? {} : { implicitLocal: true }),
            });
            const deadline = Date.now() + waitMs;
            let res = win.peekSince(0, limit);
            while (!res.frames.length && !res.gap && !res.stale && Date.now() < deadline) {
                await sleepUntil(deadline);
                requireWindow(id);
                res = requireWindow(id).peekSince(0, limit);
            }
            return formatStreamResult(id, res, waitMs, streamMeta.get(id));
        },
        async peekStream({ windowId, afterSeq, beforeSeq, windowMs, limit = 20, waitMs = 0, stream }) {
            pruneStreamMeta();
            const selected = stream === "both" ? undefined : stream;
            const read = (w: StreamWindow) => afterSeq !== undefined ? w.peekSince(afterSeq, limit, undefined, selected)
                : beforeSeq !== undefined ? w.peekBefore(beforeSeq, limit, selected)
                    : windowMs !== undefined ? w.peekWindow(windowMs, limit)
                        : w.peekLast(limit, selected);
            const deadline = Date.now() + waitMs;
            let res = read(requireWindow(windowId));
            while (afterSeq !== undefined && !res.frames.length && !res.gap && !res.stale && Date.now() < deadline) {
                await sleepUntil(deadline);
                res = read(requireWindow(windowId));
            }
            return formatStreamResult(windowId, res, waitMs, streamMeta.get(windowId));
        },
        async closeStream({ windowId }) {
            requireWindow(windowId);
            await windows().stopConfirmed(windowId);
            streamMeta.delete(windowId);
            return { windowId, closed: true };
        },
        async listStreams() {
            return { streams: listStreamsSync() };
        },

        // 转发
        async openForward({ layer, spec }: { layer?: LayerRef; spec: OpenForwardSpec }): Promise<ForwardInfo> {
            const explicit = typeof layer === "string" ? layer : layer && "layer" in layer ? layer.layer : undefined;
            const selectedName = explicit ?? (layer === undefined ? stack.activeLayer?.name : undefined);
            if (selectedName !== undefined) {
                await resolveNamed(selectedName);
                if (spec.id && externalDriver()?.listForwards?.().some((f) => f.forwardId === spec.id)) {
                    throw new Error(`转发 ID '${spec.id}' 已存在于注入驱动`);
                }
                return stack.openForward(spec, selectedName);
            }
            const drv = await resolveLayerRef(layer);
            if (typeof drv.openForward !== "function") {
                throw new Error(`层 '${layerLabel(layer)}' (${drv.descriptor.driver}) 不支持动态端口转发`);
            }
            const owner = [...stack.layers.values()].find((h) => h.driver === drv);
            if (owner) return stack.openForward(spec, owner.name);
            if (spec.id && stack.listForwards().some((f) => f.forwardId === spec.id)) {
                throw new Error(`转发 ID '${spec.id}' 已存在于已注册层`);
            }
            return drv.openForward(spec);
        },
        async listForwards({ layer, includeClosed } = {}) {
            const registered = stack.listForwards(layer);
            const external = layer === undefined ? externalDriver()?.listForwards?.() ?? [] : [];
            const all = [...registered, ...external];
            return { forwards: includeClosed === true ? all : all.filter(isForwardActive) };
        },
        async closeForward({ forwardId, layer }): Promise<CloseForwardResult> {
            const external = layer === undefined ? externalDriver() : undefined;
            const registered = external && stack.listForwards().some((f) => f.forwardId === forwardId);
            if (registered && external?.listForwards?.().some((f) => f.forwardId === forwardId)) {
                throw new Error(`转发 ID '${forwardId}' 同时存在于命名层和注入驱动，请明确指定命名层`);
            }
            return !registered && typeof external?.closeForward === "function"
                ? await external.closeForward(forwardId)
                : await stack.closeForward(forwardId, layer);
        },
    };

    /** 外部注入且未被任何命名层持有的 driver（转发类操作可直接落在它上面） */
    function externalDriver(): RuntimeDriver | undefined {
        const driver = opts.driver;
        return driver && !stack.hasForwardDriver(driver) ? driver : undefined;
    }

    return {
        host: { kind: "in-process", version: opts.version ?? "", protocolVersion: PROTOCOL_VERSION, pid: process.pid },
        ops,
        stack,
        sessionOwner,
        /** 层引用 → driver（供需要 driver 句柄的宿主逻辑使用，如 Daemon 状态汇总） */
        resolveLayerRef,
        /** 观察窗注册表（惰性创建；Daemon 用它汇总与收尾） */
        windowRegistry(): StreamWindowRegistry { return windows(); },
        listStreamsSync,
        dispose() {
            disposed = true;
            observationDisposed = true;
            if (!opts.windowRegistry) windowRegistry?.dispose();
        },
        /** 宿主退出前的收尾（Daemon 停机、一次性 CLI 进程结束）：销毁层栈里的 driver 与
         *  未登记的本机 driver——连接复用的主进程、PTY 链都是 driver 的子进程，不销毁会滞留 */
        async shutdown() {
            this.dispose();
            await stack.destroyDetachedForwardDrivers().catch(() => undefined);
            for (const name of [...stack.layers.keys()]) {
                await stack.removeLayer(name, { destroy: true }).catch(() => undefined);
            }
            const local = implicitLocal;
            implicitLocal = undefined;
            await local?.driver.destroy().catch(() => undefined);
        },
    };
}
