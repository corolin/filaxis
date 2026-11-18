/**
 * runtime-stack.ts — 栈门面：连接拓扑指纹缓存 + Transport 注册 + 能力探测
 *
 * 净室平移自 个人Agent项目 `原内部模块`
 * （，仅取内核性——list/promptSummary 展示层留消费方），OSS 化：
 * - driverKey 连接拓扑指纹平移（身份白名单投影；enterSteps 待 ssh Transport 批次并入键）
 * - 内核事件总线（FEAT-09，EventBus）
 * - features() 能力探测（AC-02：降级不靠猜——mux/sftp/persistent 按平台与二进制探测）
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";
import type { RuntimeDriver, RuntimeDescriptor } from "./driver.js";
import { RuntimeFactory } from "./factory.js";
import { EventBus } from "./events.js";
import { settleRejection } from "./async-guard.js";
import {
    enterStepsOf, layerDisplayName, layerPathIdentities, resolveSshIdentity, ENTER_ALIAS_KEYS,
    hopHost, type SshHop, type SshConnParams,
} from "./ssh-helpers.js";
import type { SessionEvent } from "./session-types.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

export type FilaxisEvents = SessionEvent | { type: "layerState"; layer: string; state: string };

export interface StackFeatures {
    /** ControlMaster 多路复用可用（非 Windows + ssh 二进制存在） */
    mux: boolean;
    /** sftp 大文件快路径可用 */
    sftp: boolean;
    /** tmux 持久会话后端可用（缺席 → 持久层显式降级非持久） */
    persistent: boolean;
    /** 已注册 Transport 类型 */
    transports: string[];
    /** exec 通道 stderr 物理分离（平台默认；远端层的逐层标注属 driver 属性） */
    stderrSeparated: boolean;
}

export interface RuntimeStackOptions {
    logger?: FilaxisLogger;
    factory?: RuntimeFactory;
}

/** 命名层句柄（Paramiko 式「连接即句柄」的持有与寻址单元） */
export interface LayerHandle {
    /** 层名（注册表内唯一——显式寻址零歧义） */
    name: string;
    descriptor: RuntimeDescriptor;
    driver: RuntimeDriver;
    /** 落点校验缓存（hostname 实测——宁重连不错主机） */
    actualHostname?: string;
}

/** 层注册表快照（descriptor 即可序列化层身份——可 JSON 落盘跨进程恢复） */
export interface LayerSnapshot {
    layers: Array<{ name: string; descriptor: RuntimeDescriptor }>;
    active?: string;
}

export class RuntimeStack {
    /** 进程级驱动缓存：同连接拓扑指纹复用既有连接（杜绝孤儿/重复建连） */
    private static driverCache = new Map<string, RuntimeDriver>();
    /** 建链中 Promise（并发同指纹去重——Astra 十三轮 #2） */
    private static connectInflight = new Map<string, Promise<RuntimeDriver>>();

    readonly events = new EventBus<FilaxisEvents>();
    private readonly factory: RuntimeFactory;
    private readonly log: FilaxisLogger;
    /** 缓存命名空间（GPT Astra 十七轮 #1 + 十八轮 #1）：静态缓存进程级共享是
     *  **纯默认工厂**的语义（CM 复用/连接计数，AC-07）；任何自定义 driver 注册
     *  （构造注入 factory **或** registerDriver()）都让本 stack 退出共享缓存——
     *  两个 stack 各注册同名 driver 的不同实现不再串用连接（B 拿到 A 的实例） */
    private cacheNs: string;
    private featuresCache: StackFeatures | null = null;

    constructor(opts: RuntimeStackOptions = {}) {
        this.factory = opts.factory ?? new RuntimeFactory();
        this.cacheNs = opts.factory
            ? `fx:${RuntimeStack.cryptoRandomHex()}`
            : ""; // 默认工厂 → 共享全局缓存（既有连接复用语义不变）
        this.log = opts.logger ?? noopLogger;
    }

    /** 本 stack 的缓存键（命名空间 + 指纹） */
    private cacheKeyOf(d: RuntimeDescriptor): string {
        return this.cacheNs ? `${this.cacheNs}|${RuntimeStack.driverKey(d)}` : RuntimeStack.driverKey(d);
    }

    /** 会话事件桥接（审计 M7 + 二十八期 #2 + 二十九期）：driver 内部会话管理器
     *  的 onEvent 单槽——**多订阅者登记表**驱动。per-stack 稳定订阅（Astra 二十九期：
     *  修前每次 connect 新建 forward 闭包进 Set——同 stack 重复 connect 同 driver
     *  会重复订阅（A 连 3 次 = 1 个事件收 3 遍，告警/动作重复执行）。订阅闭包挂
     *  this（每 stack 一份、引用稳定）——重复 connect 时 Set.add 幂等去重）；
     *  evictDriver 清空登记并恢复原回调 */
    private sessionForward?: (e: SessionEvent) => void;
    private bridgeSessionEvents(drv: RuntimeDriver): void {
        const sm = (drv as {
            sessions?: {
                onEvent?: (e: SessionEvent) => void;
                __fxSubs?: Set<(e: SessionEvent) => void>;
                __fxOrig?: (e: SessionEvent) => void;
            };
        }).sessions;
        if (!sm || typeof sm.onEvent !== "function") return;
        // 扇出重装（Sol 76 P2-6）：全逐出时 onEvent 曾还原为 __fxOrig 而 __fxSubs
        // 空集仍在——复用同 driver 重连时守卫跳过重装，订阅者进了一个没人遍历
        // 的集合（exit 事件不再转发）。__fxOrig 在场且 onEvent 即原回调=需重装
        const tornDown = sm.__fxOrig != null && sm.onEvent === sm.__fxOrig;
        if (!sm.__fxSubs || tornDown) {
            sm.__fxSubs = sm.__fxSubs ?? new Set();
            sm.__fxOrig ??= sm.onEvent.bind(sm);
            sm.onEvent = (e: SessionEvent) => {
                try { settleRejection(sm.__fxOrig?.(e)); } catch { /* 原消费方异常不外溢（AC-10 同哲学） */ }
                for (const sub of sm.__fxSubs ?? []) {
                    try { sub(e); } catch { /* 订阅方异常不外溢 */ }
                }
            };
        }
        // per-stack 稳定订阅闭包：引用固定 → Set 天然去重（重复 connect 幂等）
        this.sessionForward ??= (e: SessionEvent) => this.events.emit(e);
        sm.__fxSubs.add(this.sessionForward);
    }

    private static cryptoRandomHex(): string {
        return crypto.randomBytes(6).toString("hex");
    }

    /**
     * 连接拓扑指纹（净室移植自源版 driverKey，身份白名单投影）：
     * 显示标签/运行态缓存等非身份字段不进键——不把既有连接挤出缓存、不误建重复连接。
     * 环境身份三列（源版同款）：pty 标志 + sshHops 逐跳链 + enters 进入管线（归一化——
     * legacy enterCmd 与等价 enterPipeline 单步同键）。缺列后果：同 target/connParams
     * 但进不同容器的两层指纹相同 → connect 复用错连接 → B 容器的命令跑进 A 容器
     * （「执行环境即 Layer」的身份底线——平移时曾丢列，第十季检查补齐）。
     */
    /** 键序规范化（Hydrogen R3 #4）：等价配置仅因对象字面量键序不同就生成不同
     *  指纹（{user,port} vs {port,user}）——缓存失效重复握手。递归排序后 stringify */
    private static stableStringify(v: unknown): unknown {
        if (Array.isArray(v)) return v.map((x) => RuntimeStack.stableStringify(x));
        if (v && typeof v === "object") {
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(v as Record<string, unknown>).sort()) {
                out[k] = RuntimeStack.stableStringify((v as Record<string, unknown>)[k]);
            }
            return out;
        }
        return v;
    }

    static driverKey(d: RuntimeDescriptor): string {
        const c = (d.config ?? {}) as Record<string, unknown>;
        // 自定义 driver 的配置全量入指纹（GPT Astra 十五轮 #1：白名单投影漏掉第三方
        // 身份字段——同 driver 同 target 不同 tenant 复用同实例）。已知语义列显式归一，
        // enter 族别名原文剔除（enterStepsOf 归一结果代表语义），其余字段原样保留。
        const known = ["pty", "connParams", "sshHops", "launchCmd", "runtime", "shell", "namespace", "sshOptions"] as const;
        const rest: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(c)) {
            // label=显示名非身份字段（既有契约「标签非身份字段不误建」——AC-07 测试锚定）
            if (known.includes(k as never) || ENTER_ALIAS_KEYS.includes(k) || k === "label") continue;
            rest[k] = v;
        }
        return JSON.stringify(RuntimeStack.stableStringify({
            driver: d.driver,
            target: d.target,
            terminalId: d.terminalId,
            cwd: d.cwd,
            capabilities: d.capabilities,
            cfg: {
                ...rest,
                pty: c.pty,
                connParams: c.connParams,
                sshHops: c.sshHops,
                enters: enterStepsOf(c).map((s) => s.cmd),
                launchCmd: c.launchCmd,
                runtime: c.runtime,
                shell: c.shell,
                namespace: c.namespace,
                sshOptions: c.sshOptions,
            },
        }));
    }

    /** 建立层连接：指纹命中即复用（AC-07 连接计数语义）。
     *  in-flight 去重（GPT Astra 十三轮 #2）：并发同指纹共享同一次建链（缓存写入
     *  在 await init() 后——竞态窗口内两个 connect 各建一条、后者覆盖前者成孤儿
     *  连接泄漏）；建链失败移除缓存并销毁半建 driver。 */
    async connect(descriptor: RuntimeDescriptor, fallbackCwd?: string): Promise<RuntimeDriver> {
        // 归一化有效工作目录（GPT Astra 十四轮 #1）：fallbackCwd 先写进 descriptor 再
        // 算指纹——否则同 descriptor 不同 fallback 复用旧 driver（getCwd 停在 A，请求
        // B 却在 A 执行）。descriptor.cwd 显式给出时本就是指纹列，不受影响。
        if (!descriptor.cwd && fallbackCwd) descriptor = { ...descriptor, cwd: fallbackCwd };
        const key = this.cacheKeyOf(descriptor);
        // terminalId 索引先查（Sol 75 P2-1）：带 terminalId 的 descriptor（快照/
        // 重挂）按描述符算键与原始缓存键不匹配——曾新建第二实例共指同一 tmux
        // 会话，移除其一 destroySession 连坐另一层。terminalId 全局唯一，直接
        // 索引到既有 driver（复用=引用计数护住共享会话）
        const tid = (descriptor as { terminalId?: string }).terminalId;
        if (tid) {
            const inner = RuntimeStack.terminalIdIndex.get(tid);
            const hit = inner?.get(key);
            // finalKey 全等才复用（Sol 76 P1-1）；**销毁中跳过**（Sol 77 #4）：
            // destroy 排程中的 driver 曾被索引命中返还——调用方拿到随即失效的
            // 句柄（会话已被定时器收走）。跳过并摘除该槽
            if (hit) {
                if (RuntimeStack.destroyScheduled.has(hit)) {
                    inner!.delete(key);
                    if (inner!.size === 0) RuntimeStack.terminalIdIndex.delete(tid);
                } else {
                    this.log.debug(`[Filaxis] terminalId 命中复用连接: ${tid}`);
                    this.bridgeSessionEvents(hit);
                    return hit;
                }
            }
        }
        const cached = RuntimeStack.driverCache.get(key);
        if (cached) {
            this.log.debug(`[Filaxis] 指纹命中复用连接: ${descriptor.driver}/${descriptor.target ?? "local"}`);
            this.bridgeSessionEvents(cached); // 命中即订阅（二十八期 #2：每个共享
            // 该连接的 stack 登记自己的转发——修前只在首建时桥接，第二个 stack 永远收不到）
            return cached;
        }
        const inflight = RuntimeStack.connectInflight.get(key);
        if (inflight) {
            // in-flight 共享同一次建链——返回后同样登记订阅（与缓存命中同权）
            const drv = await inflight;
            this.bridgeSessionEvents(drv);
            return drv;
        }
        let p!: Promise<RuntimeDriver>; // 自引用（回填前复检 in-flight 身份）——回调执行时已赋值
        p = (async () => {
            const drv = this.factory.create(descriptor, fallbackCwd);
            try {
                await drv.init();
            } catch (e) {
                // 失败清理保留后建连接（Sol 54 P2-8）：A 逐出→B 建成→A 失败——
                // 无条件 delete 曾把 B 也清掉（下次 connect 又建 C 不复用 B）。
                // 只在缓存里还是自己失败代的占位/无人在等时清
                if (RuntimeStack.connectInflight.get(key) === p || !RuntimeStack.driverCache.has(key)) {
                    if (RuntimeStack.driverCache.get(key) !== drv) RuntimeStack.driverCache.delete(key);
                }
                await drv.destroy().catch(() => undefined); // 半建连接不泄漏（原实现裸抛）
                throw e;
            }
            // 回填前复检（Hydrogen R3 #3）：建链期间被 evict/removeLayer 逐出
            // （inflight 已删/被新 Promise 顶替）——自毁不回填（原无条件 set=逐出
            // 连接复活污染缓存+孤儿泄漏）
            if (RuntimeStack.connectInflight.get(key) !== p) {
                await drv.destroy().catch(() => undefined);
                throw new Error(`连接已在建链期间被逐出（evict/removeLayer）：${descriptor.driver}/${descriptor.target ?? "local"}——请重连`);
            }
            RuntimeStack.driverCache.set(key, drv);
            // homeKey 登记（Sol 73 #3）：tmux 初始化会补写 terminalId——descriptor
            // 建后即变；removeLayer 按描述符算键逐出=键不匹配旧缓存残留，重连
            // 拿回已销毁实例。不重挂键（descriptor 可能丢 config 信息、砸键控
            // 缓存）——逐出按「本 driver 实际挂在哪个键」实例核对（evictDriverHome）
            { const keys = RuntimeStack.driverHomeKeys.get(drv) ?? new Set<string>(); keys.add(key); RuntimeStack.driverHomeKeys.set(drv, keys); }
            { // 终态键（含 init 补写的 terminalId）——与重挂方算键同口径；嵌套槽
              const t = (drv.descriptor as { terminalId?: string }).terminalId;
              if (t) {
                  const inner = RuntimeStack.terminalIdIndex.get(t) ?? new Map<string, RuntimeDriver>();
                  inner.set(this.cacheKeyOf(drv.descriptor), drv);
                  RuntimeStack.terminalIdIndex.set(t, inner);
              } }
            this.log.info(`[Filaxis] 新建连接: ${descriptor.driver}/${descriptor.target ?? "local"}`);
            return drv;
        })();
        RuntimeStack.connectInflight.set(key, p);
        try {
            const drv = await p;
            this.bridgeSessionEvents(drv); // 首建者订阅（建链成功后）
            return drv;
        } finally {
            // 只清自己的登记（Hydrogen R3 #3 追修）：失败在途 promise 的 finally 曾
            // 无条件 delete——同 key 新一代建链的登记被前代尸体清掉，复检误判再逐出
            if (RuntimeStack.connectInflight.get(key) === p) RuntimeStack.connectInflight.delete(key);
        }
    }

    /** 逐出本 stack 命名空间内的连接缓存（自定义工厂隔离配套；销毁归调用方） */
    evict(d: RuntimeDescriptor): RuntimeDriver | undefined {
        return RuntimeStack.evictDriver(d, this.cacheNs);
    }

    /** 实例核对的逐出（Sol 72 #2）：缓存里就是本代才清——removeLayer 曾按描述符
     *  无条件清缓存，把同描述符的下一代（先显式逐出旧代、connect 新建后）连坐
     *  逐出/中断其在途建链；重新登记旧 driver 再移除同罪 */
    static evictDriverIfIs(drv: RuntimeDriver, d: RuntimeDescriptor, ns = ""): void {
        const key = ns ? `${ns}|${RuntimeStack.driverKey(d)}` : RuntimeStack.driverKey(d);
        if (RuntimeStack.driverCache.get(key) !== drv) return; // 缓存里已是别代——不动
        RuntimeStack.evictDriver(d, ns);
    }

    /** 逐出缓存（销毁归调用方——先 evict 再 destroy，避免销毁竞态复用）。
     *  ns：命名空间（默认共享缓存传 ""；自定义工厂的 stack 内部逐出走自身 ns） */
    /** 实例逐出（Sol 73 #3 → Sol 74 #6 多键全清）：本 driver 挂载的**全部**键
     *  逐个实例核对清（缓存里就是它才清——同键别代不误伤） */
    static evictDriverHome(drv: RuntimeDriver, keepSessionEvents = false): RuntimeDriver | undefined {
        const keys = RuntimeStack.driverHomeKeys.get(drv);
        if (keys == null || keys.size === 0) return undefined;
        let evicted: RuntimeDriver | undefined;
        for (const key of [...keys]) {
            const r = RuntimeStack.evictByKey(key, keepSessionEvents);
            if (r) evicted = r;
        }
        return evicted;
    }

    static evictDriver(d: RuntimeDescriptor, ns = ""): RuntimeDriver | undefined {
        const key = ns ? `${ns}|${RuntimeStack.driverKey(d)}` : RuntimeStack.driverKey(d);
        return RuntimeStack.evictByKey(key);
    }

    private static evictByKey(key: string, keepSessionEvents = false): RuntimeDriver | undefined {
        const drv = RuntimeStack.driverCache.get(key);
        RuntimeStack.driverCache.delete(key);
        // 集合化（Sol 74 #6）：摘本键，同 driver 他键保留；集合空=该 driver 已无
        // 任何挂载键——回收 Map 条目（Sol 75 P2-7：空 Set 曾滞留强引用，常驻
        // 进程反复建销持续积累）+ terminalId 索引同收
        let fullyEvicted = !drv;
        if (drv) {
            const keys = RuntimeStack.driverHomeKeys.get(drv);
            keys?.delete(key);
            if (!keys || keys.size === 0) {
                RuntimeStack.driverHomeKeys.delete(drv);
                const t = (drv.descriptor as { terminalId?: string }).terminalId;
                if (t) {
                    const inner = RuntimeStack.terminalIdIndex.get(t);
                    for (const [ik, iv] of [...inner ?? []]) {
                        if (iv === drv) inner!.delete(ik);
                    }
                    if (inner && inner.size === 0) RuntimeStack.terminalIdIndex.delete(t);
                }
                fullyEvicted = true;
            }
        }
        // in-flight 一并清（自挖 S3）：建链中的同指纹并发不再搭已逐出连接的
        // 车。注：已在途的建链 Promise 完成时仍会 set 回缓存（毫秒级窗口，
        // removeLayer/destroy 实路径在连接建成后才会 evict——接受并声明）
        RuntimeStack.connectInflight.delete(key);
        // 事件订阅登记清空（二十八期 #2 生命周期）——仅**全逐出**才拆桥
        //（Sol 75 P2-8：同 driver 多键别名时，逐出一个别名曾把整个事件桥拆掉，
        // 其余别名的 exit 事件从此丢失）
        if (drv && fullyEvicted && !keepSessionEvents) RuntimeStack.unbridgeSessionEvents(drv);
        return drv;
    }

    private static unbridgeSessionEvents(drv: RuntimeDriver): void {
        const sm = (drv as { sessions?: { __fxSubs?: Set<unknown>; onEvent?: (e: never) => void; __fxOrig?: (e: never) => void } }).sessions;
        if (sm?.__fxSubs) {
            sm.__fxSubs.clear();
            if (sm.__fxOrig) sm.onEvent = sm.__fxOrig;
        }
    }

    /** 开放注册（透传 factory；AC-09 第三方 Transport 同权）。注册即退出共享缓存
     *  （Astra 十八轮 #1：十七轮只盖了构造注入——registerDriver() 注册同名 driver
     *  的 A/B 实现仍共享缓存，B 的工厂 0 次执行拿到 A 的连接） */
    registerDriver(type: string, f: (descriptor: RuntimeDescriptor) => RuntimeDriver): void {
        if (!this.cacheNs) this.cacheNs = `fx:${RuntimeStack.cryptoRandomHex()}`;
        this.factory.registerDriver(type, f);
        this.featuresCache = null;
    }

    // ══════════ 命名层注册表（第十季 Layer 渗透定案——零破坏纯增量） ══════════
    // 设计拍板：牵丝出身 Paramiko 式「连接即句柄」——栈/焦点弱化为消费方心智
    //（上游垫片自带全局焦点栈），SDK 只补「句柄的持有与寻址」：
    //   - 命名注册：名字唯一=零歧义（子串匹配/焦点切换留给消费方）
    //   - 派生：pushChild/pushInto（ssh PTY 原语，派生即 init）——父子关系由
    //     descriptor 继承天然记录（connParams/sshHops/enterPipeline 全量继承）
    //   - 回环检测幂等返回：同落点 identity 命中 → 返回既有层 reused:true（原版
    //     push_ssh 判重语义的 Paramiko 化——报错是栈时代的脾气）+ 落点校验
    //     （hostname 实测 vs 期望，不符=撞了途经节点 → 拒绝，宁重连不错主机）
    //   - snapshot/restore：descriptor 即层身份（tmux 层 terminalId 零成本
    //     re-attach 现场全保；ssh 层重握手 + enterPipeline 逐条重放=位置确定性恢复）

    private namedLayers = new Map<string, LayerHandle>();
    /** 建链中的名称预留（二十七期 #2：并发同名 addLayer 的覆盖防线） */
    private pendingNames = new Set<string>();
    /** driver 全局引用计数（Sol 68 #2）：身份缓存跨 stack 共享——销毁决策须看
     *  全局在册数而非单 stack 引用。每个命名层注册 +1 / removeLayer -1 */
    private static readonly driverRefs = new Map<RuntimeDriver, number>();
    /** 已调度延迟销毁的 driver（Sol 71 #2 去重）：定时器触发前的重复移除不再
     *  二次调度 destroy */
    private static readonly destroyScheduled = new WeakMap<RuntimeDriver, Promise<void>>();
    private static readonly destroyingDrivers = new WeakSet<RuntimeDriver>();
    /** driver 实际挂载的缓存键集合（Sol 73 #3 → Sol 74 #6 集合化）：建链时
     *  descriptor 可能被 init 补写（tmux terminalId）——按描述符算键与实际键
     *  不一致；自定义工厂还可让**同一 driver 挂多键**（曾只记一个键——销毁后
     *  另一键仍能拿到已销毁实例）。按实例记全部键，逐出实例核对全清 */
    private static readonly driverHomeKeys = new Map<RuntimeDriver, Set<string>>();
    /** terminalId → {finalKey → driver} 索引（Sol 75 P2-1 → Sol 76 P1-1 判别化 →
     *  Sol 77 #5 嵌套化）：tmux 会话全局唯一——带 id 重挂复用既有 driver。
     *  **finalKey 判别**：命中须缓存键全等（driver/target/config/cwd 一致）。
     *  **嵌套**：同 tid 多工厂各占自己的 finalKey 槽——单值索引曾互相覆盖，
     *  被覆盖方重挂 miss 出第三实例 */
    private static readonly terminalIdIndex = new Map<string, Map<string, RuntimeDriver>>();
    private activeName?: string;

    /** 层注册表只读视图 */
    get layers(): ReadonlyMap<string, LayerHandle> { return this.namedLayers; }

    /** 默认层 driver（最近注册/setActive 的层；无层时 undefined——消费方自兜底） */
    get active(): RuntimeDriver | undefined {
        return this.activeName ? this.namedLayers.get(this.activeName)?.driver : undefined;
    }

    /** 默认层句柄（含层名；无层时 undefined） */
    get activeLayer(): LayerHandle | undefined {
        return this.activeName ? this.namedLayers.get(this.activeName) : undefined;
    }

    /**
     * 注册命名层。descriptor 形态走 connect（指纹复用）+ 回环检测幂等；
     * driver 形态直接登记现成句柄（pushChild/pushInto 派生产物、消费方自建连接）。
     * 新层自动成为默认层。
     */
    async addLayer(
        name: string,
        descriptorOrDriver: RuntimeDescriptor | RuntimeDriver,
    ): Promise<{ handle: LayerHandle; reused: boolean; reusedFrom?: string }> {
        this.assertNotDupName(name);
        if (this.isDriver(descriptorOrDriver)) {
            const driver = descriptorOrDriver;
            const handle: LayerHandle = { name, descriptor: driver.descriptor, driver };
            this.trackDriver(handle);
            this.namedLayers.set(name, handle);
            this.activeName = name;
            return { handle, reused: false };
        }
        const descriptor = descriptorOrDriver;
        // 名称预留（二十七期 #2）：统一经 withNameReservation（二十八期 #1 起
        // layerInto/sshInto 同款——所有异步建层入口共用的并发同名防线）
        return this.withNameReservation(name, () => this.addLayerInner(name, descriptor));
    }

    private async addLayerInner(name: string, descriptor: RuntimeDescriptor): Promise<{ handle: LayerHandle; reused: boolean; reusedFrom?: string }> {
        // 回环检测幂等（descriptor 形态）：新落点 identity ∈ 既有层路径 identity 集。
        // 末节点命中=同落点构造性成立（canonical identity 相同）→ 直接复用；
        // 途经节点命中（identity 撞了某层的中间跳）→ hostname 落点校验把关（宁重连不错主机）。
        // **仅限 ssh driver**（Astra 二十六期 #1）：SSH 主机身份判重对自定义 driver 越权——
        // 同 target 不同 tenant（配置身份不同）会被误判复用（B 拿到 A 的连接、B 的名字
        // 未注册）。自定义 driver 的复用走 connect 缓存键（driverKey 含全量 config——
        // 十五轮）自然隔离，不做跨层 identity 合并
        const hit = descriptor.driver === "ssh" ? await this.findIdentityHit(descriptor) : undefined;
        if (hit) {
            const reused = hit.terminal || await this.verifyLanding(hit.handle, hopHost(layerPathIdentities(descriptor).at(-1) ?? ""));
            if (reused) {
                this.log.info(`[Filaxis] 层 '${name}' 落点已由 '${hit.handle.name}' 持有——幂等复用（不重复建连）`);
                return { handle: hit.handle, reused: true, reusedFrom: hit.handle.name };
            }
            throw new Error(
                `层名 '${name}' 的落点 identity 命中既有层 '${hit.handle.name}' 的途经节点，且落点校验不符` +
                `（期望 ${hopHost(layerPathIdentities(descriptor).at(-1) ?? "?")}，实测 ${hit.handle.actualHostname ?? "?"}）` +
                `（宁重连不错主机）：请检查连接参数后重试`,
            );
        }
        const driver = await this.connect(descriptor);
        const handle: LayerHandle = { name, descriptor: driver.descriptor, driver };
        this.trackDriver(handle); // 登记计数（Sol 70 #1 复归：claim 无释放出口曾堵死最后一层）
        this.namedLayers.set(name, handle);
        this.activeName = name;
        return { handle, reused: false };
    }

    /** 名称预留帮手（二十七期 #2 / 二十八期 #1）：所有异步建层入口共用——
     *  检查后等待、最后注册的窗口内并发同名会双双成功后静默覆盖 */
    private async withNameReservation<T>(name: string, body: () => Promise<T>): Promise<T> {
        this.assertNotDupName(name);
        this.pendingNames.add(name);
        try {
            return await body();
        } finally {
            this.pendingNames.delete(name);
        }
    }

    /** 从命名层派生进入层（docker exec/kubectl 等——enter 管线全量继承追加） */
    async layerInto(from: string, name: string, enterCmd: string, opts: { label?: string } = {}): Promise<LayerHandle> {
        return this.withNameReservation(name, async () => {
            const src = this.requireLayer(from);
            const pushInto = (src.driver as unknown as {
                pushInto?: (cmd: string, label: string) => Promise<RuntimeDriver>;
            }).pushInto;
            if (typeof pushInto !== "function") {
                throw new Error(`层 '${from}'（${src.descriptor.driver}）不支持派生进入——需 ssh PTY 形态（pushInto 缺席）`);
            }
            const driver = await pushInto.call(src.driver, enterCmd, opts.label ?? enterCmd.slice(0, 30));
            const handle: LayerHandle = { name, descriptor: driver.descriptor, driver };
            this.trackDriver(handle);
            this.namedLayers.set(name, handle);
            this.activeName = name;
            return handle;
        });
    }

    /** 从命名层链式 ssh 派生子层（本层路径为前缀——途经继承；含回环检测幂等） */
    async sshInto(
        from: string,
        name: string,
        target: string,
        connParams?: SshConnParams,
    ): Promise<{ handle: LayerHandle; reused: boolean; reusedFrom?: string }> {
        return this.withNameReservation(name, async () => {
            const src = this.requireLayer(from);
            const hop: SshHop = connParams ? { host: target, conn: connParams } : target;
            // 回环检测幂等（链式派生落点=新 hop；末节点命中直接复用，途经命中 hostname 把关）
            const hit = await this.findIdentityHopHit(hop);
            if (hit) {
                const reused = hit.terminal || await this.verifyLanding(hit.handle, hopHost(hop));
                if (reused) {
                    this.log.info(`[Filaxis] 层 '${name}' 落点已由 '${hit.handle.name}' 持有——幂等复用（不重复建连）`);
                    return { handle: hit.handle, reused: true, reusedFrom: hit.handle.name };
                }
                throw new Error(
                    `层名 '${name}' 的落点 identity 命中既有层 '${hit.handle.name}' 的途经节点，且落点校验不符` +
                    `（期望 ${hopHost(hop)}，实测 ${hit.handle.actualHostname ?? "?"}）——宁重连不错主机：请检查连接参数后重试`,
                );
            }
            const pushChild = (src.driver as unknown as {
                pushChild?: (hop: SshHop) => Promise<RuntimeDriver>;
            }).pushChild;
            if (typeof pushChild !== "function") {
                throw new Error(`层 '${from}'（${src.descriptor.driver}）不支持链式 ssh 派生——需 ssh PTY 形态（pushChild 缺席）`);
            }
            const driver = await pushChild.call(src.driver, hop);
            const handle: LayerHandle = { name, descriptor: driver.descriptor, driver };
            this.trackDriver(handle);
            this.namedLayers.set(name, handle);
            this.activeName = name;
            return { handle, reused: false };
        });
    }

    /** 按名取层（不存在时报错并附候选清单） */
    layer(name: string): LayerHandle {
        return this.requireLayer(name);
    }

    /** 设默认层（显式声明「接下来都在这层干」——无全局焦点指针，最近使用 + 显式声明双轨） */
    setActive(name: string): LayerHandle {
        const h = this.requireLayer(name);
        this.activeName = name;
        return h;
    }

    /** 移出注册表（缺省连接保留在指纹缓存可复用；destroy=true 才真销毁） */
    async removeLayer(name: string, opts: { destroy?: boolean } = {}): Promise<void> {
        const h = this.requireLayer(name);
        this.namedLayers.delete(name);
        // 默认层回落在异步销毁**之前**（Sol 68 P1）：destroy 暂停期间缺省命令
        //（未显式指定层的 run_command）曾落到初始 driver——销毁完才切到存活层
        if (this.activeName === name) {
            this.activeName = [...this.namedLayers.keys()].at(-1); // 回落最后注册层
        }
        // 全局引用计数（Sol 67 #5 → Sol 68 #2）：driver 缓存跨 stack 共享——
        // 只看本 stack 引用曾提前销毁他 stack 仍持有的 driver。
        // 延迟复核销毁（Sol 69 #1 ↔ Sol 70 #1 两难的正解）：connect 归还与层登记
        // 之间隔调用方代码——同步判 0 会追杀在途登记（Sol 69）；而 connect 归还
        // 即计数（claim）无释放出口，裸 connect 永久占用、最后一层无法释放
        //（Sol 70）。登记计数 + 宏任务级复核：先除名，destroy 前重查
        // 在册数——微任务链上的在途登记必然先落地（复核见 0 才真销毁+逐出缓存）
        const refs = Math.max(0, (RuntimeStack.driverRefs.get(h.driver) ?? 0) - 1);
        if (refs === 0) RuntimeStack.driverRefs.delete(h.driver);
        else RuntimeStack.driverRefs.set(h.driver, refs);
        if (opts.destroy && refs === 0) {
            // 缓存同步逐出（Sol 71 #2 → Sol 73 #3 homeKey）：按本 driver 实际
            // 挂载键实例核对清——按描述符算键曾因 init 补写 terminalId 键不匹配
            // （旧缓存残留、重连拿回已销毁实例）；定时器只复核+销毁本代（不逐出）
            RuntimeStack.evictDriverHome(h.driver, true);
            let disposal = RuntimeStack.destroyScheduled.get(h.driver);
            if (!disposal) {
                disposal = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
                    if ((RuntimeStack.driverRefs.get(h.driver) ?? 0) > 0) return;
                    RuntimeStack.destroyingDrivers.add(h.driver);
                    try {
                        await h.driver.destroy();
                    } finally {
                        RuntimeStack.unbridgeSessionEvents(h.driver);
                        RuntimeStack.destroyingDrivers.delete(h.driver);
                    }
                }).finally(() => RuntimeStack.destroyScheduled.delete(h.driver));
                RuntimeStack.destroyScheduled.set(h.driver, disposal);
            }
            await disposal;
        }
    }

    /** 层清单纯文本（零 ANSI/零表格——npm 零依赖红线；彩色表格留消费方） */
    layerText(): string {
        if (this.namedLayers.size === 0) return "Filaxis 命名层：（空——addLayer/layerInto 注册）";
        const lines: string[] = [];
        for (const h of this.namedLayers.values()) {
            const d = h.driver as unknown as {
                alive?: boolean; layerShellGone?: unknown; reconnecting?: boolean; effectiveUser?: string;
            };
            const base = h.descriptor.driver === "local"
                ? `${os.hostname()}[local]`
                : layerDisplayName(h.descriptor);
            const state = d.reconnecting === true
                ? " ↻连中"
                : d.layerShellGone
                    ? " ⚠退化（内层 shell 已退出，勿在此层执行）"
                    : d.alive === false
                        ? " ⚠死（removeLayer 后按原参数重建）"
                        : "";
            const user = d.effectiveUser ? ` · ${d.effectiveUser}$` : "";
            const mark = h.name === this.activeName ? " ◀ 默认" : "";
            lines.push(`  ${h.name}: ${base}${user}${state}${mark}`);
        }
        return ["Filaxis 命名层（工具缺省落【默认层】；显式按名寻址任意层）：", ...lines].join("\n");
    }

    /** 层身份快照（可 JSON 落盘——跨进程恢复的凭证） */
    snapshot(): LayerSnapshot {
        return {
            layers: [...this.namedLayers.values()].map((h) => ({ name: h.name, descriptor: h.descriptor })),
            active: this.activeName,
        };
    }

    /**
     * 按快照重建（幂等：已在层的名字跳过）：tmux 层 terminalId 命中=零成本 re-attach
     * （现场全保）；ssh 层=重握手 + enterPipeline 逐条重放（位置确定性恢复）。
     */
    async restore(snap: LayerSnapshot): Promise<void> {
        for (const { name, descriptor } of snap.layers) {
            if (this.namedLayers.has(name)) continue;
            // 同名建层预留同权（Sol 67 #4）：restore 曾绕过 pendingNames——addLayer
            // 暂停在初始化时并发 restore 同名层，双方都成功、先成者被覆盖
            if (this.pendingNames.has(name)) {
                throw new Error(`层名 '${name}' 建链中（addLayer 进行时）——restore 不与其竞争，稍后重试或换名`);
            }
            this.pendingNames.add(name);
            try {
                const driver = await this.connect(descriptor);
                const handle: LayerHandle = { name, descriptor: driver.descriptor, driver };
                this.trackDriver(handle); // 登记计数（Sol 70 #1 复归）
                this.namedLayers.set(name, handle);
            } finally {
                this.pendingNames.delete(name);
            }
        }
        if (snap.active && this.namedLayers.has(snap.active)) this.activeName = snap.active;
    }

    // ── 注册表内部 ──

    /** 层注册计数（Sol 68 #2：跨 stack 共享 driver 的销毁门——所有建层路径
     *  统一口径=在册层数；connect 不计数（Sol 70 #1：claim 无释放出口）） */
    private trackDriver(handle: LayerHandle): void {
        if (RuntimeStack.destroyingDrivers.has(handle.driver)) {
            throw new Error(`层 '${handle.name}' 的连接正在销毁，请重新建链`);
        }
        this.bridgeSessionEvents(handle.driver);
        RuntimeStack.driverRefs.set(handle.driver, (RuntimeStack.driverRefs.get(handle.driver) ?? 0) + 1);
    }


    private assertNotDupName(name: string): void {
        if (this.namedLayers.has(name) || this.pendingNames.has(name)) {
            throw new Error(`层名 '${name}' 已占用或建链中（既有：${[...this.namedLayers.keys()].join(", ")}）——换名或先 removeLayer`);
        }
    }

    private requireLayer(name: string): LayerHandle {
        const h = this.namedLayers.get(name);
        if (!h) {
            throw new Error(`层 '${name}' 不存在（既有：${[...this.namedLayers.keys()].join(", ") || "空"}）`);
        }
        return h;
    }

    private isDriver(x: RuntimeDescriptor | RuntimeDriver): x is RuntimeDriver {
        return typeof (x as RuntimeDriver).exec === "function";
    }

    /**
     * descriptor 落点 identity（路径末节点）比对既有层全部路径节点。
     * 判重边界（原版 push_ssh 语义忠实平移）：**只在无 enter 管线的纯 ssh 落点层之间**——
     * enter 层（容器/内层 shell）的落点是容器而非宿主机，hop identity 管不到（enter 管线
     * 不进 layerPathIdentities）：同宿主机两个不同容器层会撞 identity + hostname 同为宿主机
     * → 误幂等返回错容器。enter 层的身份与复用归 driverKey（含 enters 三列）。
     */
    private async findIdentityHit(descriptor: RuntimeDescriptor): Promise<{ handle: LayerHandle; terminal: boolean } | undefined> {
        if (enterStepsOf((descriptor.config ?? {}) as Record<string, unknown>).length > 0) return undefined;
        const dest = layerPathIdentities(descriptor).at(-1);
        if (!dest) return undefined;
        return this.findIdentityHopHit(dest, (candidate) => {
            const contextKey = (d: RuntimeDescriptor) => RuntimeStack.driverKey({
                ...d,
                target: undefined,
                config: {
                    ...d.config,
                    sshHops: undefined,
                    connParams: RuntimeStack.sshHopContext(layerPathIdentities(d)[0]),
                },
            });
            return contextKey(descriptor) === contextKey(candidate);
        });
    }

    private static sshHopContext(hop?: SshHop): unknown {
        const conn = typeof hop === "object" ? hop.conn : undefined;
        const { user, port, ...context } = conn ?? {};
        return RuntimeStack.stableStringify(context);
    }

    /** terminal=true：identity 命中在该层路径**末节点**（同落点构造性成立，免 hostname 探测）；
     *  false：命中途经节点（identity 撞了中间跳——hostname 落点校验把关） */
    private async findIdentityHopHit(dest: SshHop, compatible?: (candidate: RuntimeDescriptor) => boolean): Promise<{ handle: LayerHandle; terminal: boolean } | undefined> {
        const destId = await resolveSshIdentity(dest);
        if (!destId || destId.startsWith("unresolved:")) {
            // 解析不可达（DNS/离线）——identity 不可靠，跳过判重（建层失败由 connect 兜底）
            return undefined;
        }
        const context = JSON.stringify(RuntimeStack.sshHopContext(dest));
        for (const h of this.namedLayers.values()) {
            if (h.descriptor.driver !== "ssh") continue; // 候选也须 ssh（Astra 二十七期 #1：
            // 发起者限 ssh 了但候选没限——ssh localhost 可命中自定义 driver 的同 target
            // 层，拿到别人的 driver 实例冒 reused。identity 语义只在 ssh 层间成立）
            if (enterStepsOf((h.descriptor.config ?? {}) as Record<string, unknown>).length > 0) continue; // 候选也须纯落点层
            if (compatible && !compatible(h.descriptor)) continue;
            const path = layerPathIdentities(h.descriptor);
            for (let i = 0; i < path.length; i++) {
                const candidate = path[i]!;
                if (JSON.stringify(RuntimeStack.sshHopContext(candidate)) !== context) continue;
                if ((await resolveSshIdentity(candidate)) === destId) {
                    return { handle: h, terminal: i === path.length - 1 };
                }
            }
        }
        return undefined;
    }

    /** 落点校验（宁重连不错主机）：命中层实测 hostname vs 期望 host——不符=identity 撞途经节点 */
    private async verifyLanding(hit: LayerHandle, expectedHost: string): Promise<boolean> {
        if (!expectedHost) return false;
        try {
            if (!hit.actualHostname) {
                const result = await hit.driver.exec("hostname");
                if (result.exitCode !== 0) return false;
                hit.actualHostname = result.stdout.trim().split("\n").pop() || "";
            }
        } catch {
            return false; // 探测失败=不可核实——拒绝复用
        }
        const actual = hit.actualHostname;
        // 边界匹配（Hydrogen R3 #2）：裸 includes 曾让期望 `web` 匹配途经跳板
        // `web-bastion`、`db1` 匹配 `db10`——宁重连不错主机。只认全等或 FQDN
        // 边界（web === web / web.example.com 前缀 web. / 短名 ↔ FQDN 反向）
        if (!actual || !expectedHost) return false;
        return actual === expectedHost
            || actual.startsWith(expectedHost + ".")
            || expectedHost.startsWith(actual + ".");
    }

    /**
     * 能力探测（AC-02：降级不靠猜）。结果缓存至注册表变化。
     * Windows 无 ControlMaster → mux=false（自动退化直连为既定行为）。
     */
    async features(): Promise<StackFeatures> {
        if (this.featuresCache) return this.featuresCache;
        const has = (bin: string) =>
            new Promise<boolean>((resolve) => {
                const probe = process.platform === "win32"
                    ? spawn("where", [bin], { stdio: "ignore" })
                    : spawn("which", [bin], { stdio: "ignore" });
                probe.on("close", (code) => resolve(code === 0));
                probe.on("error", () => resolve(false));
            });
        const [sshOk, sftpOk, tmuxOk] = await Promise.all([has("ssh"), has("sftp"), has("tmux")]);
        this.featuresCache = {
            mux: process.platform !== "win32" && sshOk,
            sftp: sftpOk,
            persistent: tmuxOk,
            transports: this.factory.registeredTypes(),
            stderrSeparated: true,
        };
        return this.featuresCache;
    }
}
