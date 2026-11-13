/**
 * stream-window.ts — 流式观察窗（远端拉模式流反转为本地推模式滚动窗）
 *
 * 净室平移自 个人Agent项目 `原内部模块`
 * 。OSS 化：logger 注入；引擎接 filaxis StreamSessionManager
 * （onLine 行对象→text 投影）；local 窗 spawn 弃 shell:true（Windows cmd 会挂
 * unix 命令）改 shell -c 与 exec 一致。
 *
 * 关键语义（源施工图定案，全保）：
 * - 帧编号 per-window 单调递增，断连续编不归零（断点续读正确性依赖）
 * - 双限缓冲：帧数环形覆盖（滚动=设计行为）+ 单帧字节截断
 * - peek 三模式（last / window 时间窗 / since 增量），全部非破坏读
 * - 多消费者游标：consumer_id → last_seq，互不干扰
 * - 断流 stale 窗保留全部帧；重连续编；关窗收割流进程
 * - 窗纯内存缓冲（不走消息路由——消费方自行桥接）
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { StreamSessionManager } from "./stream-session-manager.js";
import { resolveLocalShell } from "./shell-discovery.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

/** 单帧截断后缀（与 session-buffer.ts TRUNC_SUFFIX 同语义） */
const TRUNC_SUFFIX = "…[truncated]";

export interface StreamFrame {
    seq: number;
    /** 帧到达本地时刻（时钟域统一本地） */
    ts: number;
    text: string;
}

export interface PeekResult {
    name: string;
    oldestSeq: number;
    newestSeq: number;
    stale: boolean;
    frames: StreamFrame[];
    /** since 模式且中间发生环形覆盖时置 true（空洞显式可见，不静默） */
    gap?: boolean;
    /** since 模式：本次实际交付的末帧 seq（空结果=传入的 since——续读用它，
     *  **不是 newestSeq**：翻页限 n 时 newestSeq 是窗内最新帧，拿它续读会跳过
     *  未读帧〔Astra 五十期 #2〕） */
    lastDeliveredSeq?: number;
}

type Transport =
    | { kind: "local"; child: ChildProcess }
    | { kind: "remote"; manager: StreamSessionManager; sessionId: string };

/** 同名重开续编锚（模块级——直接 close() 也登记；Registry stop 时并入自己的表） */
const __seqAnchors = new Map<string, number>();

export class StreamWindow {
    private frames: StreamFrame[] = [];
    private nextSeq = 1;
    /** 已分配帧号上限（Astra 五十一期 #1）：独立于 frames 缓冲——空窗（重开后
     *  未收到帧）的 newestSeq=0，用它续锚会把已存帧号归零覆盖、peekSince 误报
     *  gap。allocatedSeq 恒等于「本窗生命周期内发出的最大 seq」（含续编起点） */
    private allocated = 0;
    private _stale = false;
    private _closed = false;
    private readonly consumers = new Map<string, number>();
    private transport: Transport | null = null;
    private lastActivityAt = Date.now();

    constructor(
        readonly name: string,
        readonly layerAlias: string,
        readonly source: string,
        readonly command: string,
        private readonly maxFrames = 200,
        readonly maxLineBytes = 1024,
        /** 帧号起点（Registry 同名重开续编——五十期 #1：文档承诺「重开续编」
         *  但实现归零，旧游标 peekSince 静默漏帧且 gap 不置位） */
        seqStart = 0,
    ) {
        this.nextSeq = seqStart + 1;
        this.allocated = seqStart;
    }

    get stale(): boolean { return this._stale; }
    get closed(): boolean { return this._closed; }
    /** 已分配帧号上限（含续编起点——空窗也保留） */
    get allocatedSeq(): number { return this.allocated; }
    get frameCount(): number { return this.frames.length; }
    get oldestSeq(): number { return this.frames.length ? this.frames[0]!.seq : 0; }
    get newestSeq(): number { return this.frames.length ? this.frames[this.frames.length - 1]!.seq : this.allocated; } // 无缓冲（maxFrames=0）时回落 allocatedSeq（Sol 五十二期 #3——帧即弃但号段不丢）
    get lastActiveAt(): number { return this.lastActivityAt; }

    /** 行入窗（截断+环形覆盖；不更新消费者游标——游标只在 peek since 时推进） */
    push(text: string): void {
        if (this._closed) return;
        let line = text;
        if (line.length > this.maxLineBytes) {
            // keep 下限 0（Hydrogen R2 #5，对齐 session-buffer 同款修复）：
            // maxLineBytes < 后缀长度时裸减法=负索引，越截越长
            const keep = Math.max(0, this.maxLineBytes - TRUNC_SUFFIX.length);
            let cut = line.slice(0, keep);
            // 孤立高代理剥除（Sol 54 P2-19：UTF-16 切点落代理对中间——孤立
            // 高代理编码后 4 字节+占位低代理缺失=乱码；剥 1 码元即可）
            if (/[\uD800-\uDBFF]$/.test(cut) && /[\uDC00-\uDFFF]/.test(line.slice(keep, keep + 1))) {
                cut = cut.slice(0, -1);
            }
            line = cut + TRUNC_SUFFIX;
        }
        const seq = this.nextSeq++;
        this.allocated = seq; // 已分配锚（空窗续编/超前判定用——非缓冲末帧）
        this.frames.push({ seq, ts: Date.now(), text: line });
        // maxFrames=0 曾因 slice(-0)=复制整个数组而失去上限（Sol 五十二期 #3：
        // 1000 帧全保留）。0 视为「无缓冲」——每帧即弃（seq 分配照常，续编/游标语义保持）
        if (this.maxFrames <= 0) {
            this.frames = [];
        } else if (this.frames.length > this.maxFrames) {
            this.frames = this.frames.slice(-this.maxFrames);
        }
        this._stale = false; // 新帧到达 = 流复活
        // lastActivityAt 不在此刷（Sol 54 P2-18）：持续输出曾无限推迟 TTL——
        // 「注意力」=被消费（peek），非数据到达。无人看的窗照收
    }

    /** 最近 n 帧 */
    peekLast(n = 20): PeekResult {
        // n=0=显式请求零帧（Sol 五十二期 #3：Math.max(0,n) 后 slice(-0) 曾返回
        // 全部帧）——0/负数返回空（与「无缓冲」一致）
        if (n <= 0) return this.snapshot([]);
        return this.snapshot(this.frames.slice(-n));
    }

    /** 最近 ms 毫秒内的帧 */
    peekWindow(ms: number): PeekResult {
        const cutoff = Date.now() - ms;
        const frames = this.frames.filter((f) => f.ts >= cutoff);
        return this.snapshot(frames);
    }

    /**
     * 增量断点续读：返回 > sinceSeq 的帧（上限 n 兜底）。
     * 带 consumerId 时推进该消费者游标；中间覆盖（oldestSeq > sinceSeq+1）置 gap。
     */
    peekSince(sinceSeq: number, n = 50, consumerId?: string): PeekResult {
        const frames = this.frames.filter((f) => f.seq > sinceSeq).slice(0, Math.max(0, n));
        const result = this.snapshot(frames);
        result.lastDeliveredSeq = frames.length ? frames[frames.length - 1]!.seq : sinceSeq;
        // 空洞双形态（五十期 #1 补）：①环形覆盖（oldestSeq > since+1）②游标超前
        // （since > newestSeq——旧窗游标/异常值，读不到任何帧且不可静默当「无新帧」）
        // 空洞双形态（五十期 #1 → R6 #3 修正）：①环形覆盖 ②游标超前。sinceSeq>0 曾
        // 把「从头读但历史已滚出」屏蔽——新消费者传 0 也会无感知丢帧（空窗 oldest=0
        // 本就不触发①，无需 sinceSeq 守卫）
        // 空洞三形态：①环形覆盖 ②游标超前 ③零容量丢帧（Sol 54 P2-16：帧全弃
        // oldestSeq=0 ①不触发——allocatedSeq 有分配但 buffer 空=消费者注定拿不到）
        if (this.oldestSeq > sinceSeq + 1 || sinceSeq > this.allocatedSeq
            || (this.frames.length === 0 && this.allocatedSeq > sinceSeq)) result.gap = true;
        if (consumerId) {
            const lastSeq = frames.length ? frames[frames.length - 1]!.seq : sinceSeq;
            this.consumers.set(consumerId, Math.max(lastSeq, sinceSeq));
            this.lastActivityAt = Date.now();
        }
        return result;
    }

    /** 无状态读取消费者已知游标（未注册返回 0） */
    consumerSeq(consumerId: string): number {
        return this.consumers.get(consumerId) ?? 0;
    }

    /** 流进程退出/断连 → stale（保留全部帧，seq 冻结在 nextSeq 上，重连续编） */
    markStale(): void {
        if (this._closed) return;
        this._stale = true;
    }

    attachTransport(t: Transport): void { this.transport = t; }

    /** 关窗：收割流进程 + 内容清空（由 Registry 除名）。local kill 同步确定；
     *  remote StreamSessionManager.stop 同步 void（kill 信号即时发出，无三态
     *  返回——自审核实：与 toolkit 的 stop 三态不同，此处无结果可吞） */
    close(): void {
        if (this._closed) return;
        this._closed = true;
        // 续编锚登记（Sol 54 P2-17）：直接 close() 曾绕过 Registry.stop——同名重开
        // 帧号归零，旧游标跳过新首帧。模块级锚表使任何关闭路径都被下一窗继承
        __seqAnchors.set(this.name, this.allocated);
        try {
            if (this.transport?.kind === "local") {
                this.transport.child.kill("SIGTERM");
            } else if (this.transport?.kind === "remote") {
                this.transport.manager.stop(this.transport.sessionId);
            }
        } catch { /* 收割尽力而为 */ }
        this.frames = [];
        this.consumers.clear();
    }

    private snapshot(frames: StreamFrame[]): PeekResult {
        this.lastActivityAt = Date.now();
        return {
            name: this.name,
            oldestSeq: this.oldestSeq,
            newestSeq: this.newestSeq,
            stale: this._stale,
            // 帧浅拷贝（五十期 #3）：返回元素曾与窗口内部共用引用——调用方改写
            // 返回帧的 seq/ts/text 会直接改写共享缓冲，殃及其他消费者
            frames: frames.map((f) => ({ ...f })),
        };
    }
}

/** 行切分器（跨 chunk 行缓冲，CRLF 容忍）
 *  未完成行封顶（Astra 五十一期 #2）：等待换行期间 buf 随输出无限增长（32MiB
 *  无换行实测堆涨 32MiB）——超 maxBytes 一次性封顶（与 win.push 的入窗截断
 *  **同公式**：整行送达与分块送达的字节相同时输出逐字节一致），封顶后本行
 *  剩余输入全丢（截断标记已在）。 */
class LineSplitter {
    private buf = "";
    private capped = false;
    constructor(private readonly maxBytes: number) {}
    push(chunk: string, onLine: (line: string) => void): void {
        // 迭代扫描（Sol 五十二期 #1）：逐换行消费——递归处理剩余曾随块内换行
        // 数增长栈深（64KiB 短行批实测 18,473 帧时 RangeError 栈溢出）
        let data = chunk;
        while (data !== "") {
            if (this.capped) {
                // 本行已封顶：内容丢弃但换行仍要成行（封顶行 buf 即终值）
                const idx = data.indexOf("\n");
                if (idx === -1) return; // 等下一个换行
                this.emitCapped(onLine);
                data = data.slice(idx + 1);
                continue;
            }
            const nl = data.indexOf("\n");
            if (nl === -1) {
                // 无换行尾段：仅以**本行已有长度**判定封顶（Sol 五十二期 #2：曾按
                // 整块长度判定——后续行数据计入首行长度，同批短行被误截断；逐行
                // 判定后 12B 上限下 "12345678\nOK\nZ\n" 三行全完整）
                // 行尾 CR 不计正文长度（Sol 54 P2-15）：12 字符+CRLF 曾超 12 上限
                // 被截——CR 是行终止符一半不是内容
                const dataBody = data.endsWith("\r") ? data.slice(0, -1) : data;
                if (this.buf.length + dataBody.length > this.maxBytes) {
                    const keep = Math.max(0, this.maxBytes - TRUNC_SUFFIX.length); // 负索引防护
                    let cut = (this.buf + dataBody).slice(0, keep);
                    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // 孤立高代理剥除（同 push）
                    this.buf = cut + TRUNC_SUFFIX;
                    this.capped = true;
                } else {
                    this.buf += data; // CR 保留在 buf（成行时剥）——长度判定用 body
                }
                return; // 尾段已并入 buf，等下一个 chunk
            }
            // 本 chunk 内有换行：当前行 = buf + data 头段；按**当前行长度**判定封顶
            const segRaw = data.slice(0, nl);
            const seg = segRaw.endsWith("\r") ? segRaw.slice(0, -1) : segRaw; // CR 剥后再判长（同上）
            if (this.buf.length + seg.length > this.maxBytes) {
                const keep = Math.max(0, this.maxBytes - TRUNC_SUFFIX.length);
                let cutL = (this.buf + seg).slice(0, keep);
                if (/[\uD800-\uDBFF]$/.test(cutL)) cutL = cutL.slice(0, -1);
                onLine(cutL + TRUNC_SUFFIX);
            } else {
                const clean = (this.buf + seg).replace(/\r$/, "");
                if (clean !== "") onLine(clean);
            }
            this.buf = "";
            this.capped = false; // 行已终结
            data = data.slice(nl + 1);
        }
    }

    /** 封顶行输出（capped 等到换行——buf 终值直接成行并复位） */
    private emitCapped(onLine: (line: string) => void): void {
        const clean = this.buf.replace(/\r$/, "");
        this.buf = "";
        this.capped = false;
        if (clean !== "") onLine(clean);
    }
    flush(onLine: (line: string) => void): void {
        const rest = this.buf.replace(/\r$/, "");
        this.buf = "";
        this.capped = false; // 行已终结——下一行重新计封顶
        if (rest !== "") onLine(rest);
    }
}

/** 远程流桥：StreamSessionManager 行回调 → 窗入帧 */
class RemoteBridge {
    constructor(
        private readonly window: StreamWindow,
        private readonly manager: StreamSessionManager,
    ) {}

    async start(command: string): Promise<void> {
        const { sessionId } = await this.manager.start(command, {
            name: this.window.name.replace(/[^A-Za-z0-9_-]/g, "_"),
            onLine: (line) => this.window.push(line.text), // filaxis 行对象 → text 投影
            onExit: () => this.window.markStale(),
        });
        this.window.attachTransport({ kind: "remote", manager: this.manager, sessionId });
    }
}

export interface StreamWindowRegistryOptions {
    /** 空引用窗延迟销毁 TTL（对齐 stream 注意力衰减语义） */
    idleTtlMs?: number;
    /** local 窗 shell（缺省 resolveLocalShell——与 exec 同源） */
    shell?: string;
    logger?: FilaxisLogger;
    /** spawn 注入（测试驱动事件时序——与 StreamSessionManager.spawnImpl 同惯例） */
    spawnImpl?: typeof spawn;
}

export class StreamWindowRegistry {
    private readonly windows = new Map<string, StreamWindow>();
    /** 开窗中的名称预留（Astra 三十九期 #1）：重名检查在异步启动前、注册在后——
     *  并发同名双 open 都过检查各自启动（remote 各建引擎会话/local 各 spawn），后写
     *  覆盖前写=前窗脱离注册表无人收割（观察流泄漏）。预留先于任何异步动作占位，
     *  成功/失败都释放（与 runtime-stack withNameReservation 同语义）。 */
    private readonly pendingNames = new Set<string>();
    /** 同名重开的帧号续编锚（Astra 五十期 #1）：stop 记下末帧号，重开同名窗的
     *  新帧从冻结 seq 之后继续——文档「重开续编」承诺的兑现；旧消费者游标直接有效 */
    private readonly lastSeqByName = new Map<string, number>();
    private readonly sweeper: ReturnType<typeof setInterval>;
    /** 已 dispose（Astra 四十期 #2）：在途 open 的迟注册收割依据 + 后续 open 早拒 */
    private _disposed = false;
    private readonly idleTtlMs: number;
    private readonly shell: string;
    private readonly log: FilaxisLogger;
    private readonly spawnImpl?: typeof spawn;

    constructor(opts: StreamWindowRegistryOptions = {}) {
        this.idleTtlMs = opts.idleTtlMs ?? 30 * 60_000;
        this.shell = opts.shell ?? resolveLocalShell(undefined, opts.logger);
        this.log = opts.logger ?? noopLogger;
        this.spawnImpl = opts.spawnImpl;
        this.sweeper = setInterval(() => this.sweep(), 60_000);
        this.sweeper.unref();
    }

    /** 开窗（local 经 spawn shell -c；remote 经 StreamSessionManager 行桥） */
    async open(opts: {
        name: string;
        layerAlias?: string;
        command: string;
        maxFrames?: number;
        maxLineBytes?: number;
        manager?: StreamSessionManager;
    }): Promise<StreamWindow> {
        if (this._disposed) throw new Error("StreamWindowRegistry 已 dispose——重建实例（或模块单例重取）后再开窗");
        const existing = this.windows.get(opts.name);
        if ((existing && !existing.closed) || this.pendingNames.has(opts.name)) {
            throw new Error(`观察窗 '${opts.name}' 已存在或正在打开（stop 后可重建）`);
        }
        this.pendingNames.add(opts.name);
        let winRef: StreamWindow | undefined;
        try {
            const layerAlias = opts.layerAlias ?? "local";
            const source = opts.name.split(":").slice(-1)[0] ?? opts.name;
            const win = new StreamWindow(
                opts.name, layerAlias, source, opts.command, opts.maxFrames, opts.maxLineBytes,
                this.lastSeqByName.get(opts.name) ?? __seqAnchors.get(opts.name) ?? 0, // 续编（五十期+Sol54 P2-17 直接 close 也锚）
            );
            winRef = win;

            if (layerAlias === "local") {
                // shell -c（与 exec 同源——弃 shell:true：Windows 下 cmd 解释器会挂 unix 命令）。
                // spawn error 必须监听（Astra 二十五期 #1）：shell 不存在时 spawn 先返回 child、
                // 随后异步抛 spawn ENOENT——无 error 监听器 = uncaughtException 崩**宿主**，
                // 外层 try/catch 捕不住。修：error 桥到 open() 的 reject + 不注册窗口
                const child = this.spawnImpl
                    ? this.spawnImpl(this.shell, ["-c", opts.command], { stdio: ["ignore", "pipe", "pipe"] })
                    : spawn(this.shell, ["-c", opts.command], { stdio: ["ignore", "pipe", "pipe"] });
                const spawnFailed = new Promise<Error>((resolve) => {
                    child.once("error", (err: Error) => resolve(err));
                });
                // 双流各配 Splitter（Astra 二十六期 #2）：共用一个会把 stdout 的半行与
                // stderr 的下一行**拼成一行**（OUT_PART + ERR_LINE\n → "OUT_PARTERR_LINE"）。
                // 分离缓冲后按完整行到达序聚合（窗口帧序=到达序，契约同 FEAT-05）
                const outSplitter = new LineSplitter(win.maxLineBytes);
                const errSplitter = new LineSplitter(win.maxLineBytes);
                // 跨块 UTF-8（Astra 三十八期 #1）：逐 Buffer toString 会把跨块边界的
                // 多字节字符解成 U+FFFD（首块尾巴+次块开头各一个）。StringDecoder
                // 持回不完整字节序列，流终 residual 经 end() 补齐——真截断至多一个
                // 替换符（对应物理事实），不再拆成两个。
                let finalized = false; // 声明前置（data 守卫引用）
                const outDecoder = new StringDecoder("utf-8");
                const errDecoder = new StringDecoder("utf-8");
                child.stdout?.on("data", (d: Buffer) => {
                    if (finalized) return; // 收尾后迟到 data 丢弃（Sol 54 P2-14）：曾继续推帧把 stale 复活成活跃
                    outSplitter.push(outDecoder.write(d), (l) => win.push(l));
                });
                child.stderr?.on("data", (d: Buffer) => {
                    if (finalized) return;
                    errSplitter.push(errDecoder.write(d), (l) => win.push(l));
                });
                // 收尾统一到 close（Astra 三十九期 #2）：exit≠stdio 排空终点——
                // `RE → exit → ADY\n → close` 合法顺序（pipe 缓冲未读尽时 data 迟到
                // 于 exit 常见）下，exit 上冲刷把半行 RE 提前成帧、迟到的 ADY 又复
                // 活 stale。close=stdio 全关的真终点，残余字节/半行在此一次冲刷；
                // exit 只挂 2s 兜底（close 永不到的异常流序），两路幂等先到者收尾
                const finalize = () => {
                    if (finalized) return;
                    finalized = true;
                    outSplitter.push(outDecoder.end(), (l) => win.push(l));
                    errSplitter.push(errDecoder.end(), (l) => win.push(l));
                    outSplitter.flush((l) => win.push(l));
                    errSplitter.flush((l) => win.push(l));
                    win.markStale();
                };
                let closeGuard: ReturnType<typeof setTimeout> | undefined;
                child.on("exit", () => {
                    closeGuard = setTimeout(finalize, 2_000);
                    closeGuard.unref?.();
                });
                child.on("close", () => {
                    clearTimeout(closeGuard);
                    finalize();
                });
                win.attachTransport({ kind: "local", child });
                // 启动竞态窗：error 异步于 spawn 返回——让出一拍微任务再注册窗口，
                // 启动失败（shell 缺席/ENOENT）时 open() 直接 reject，零窗口残留
                const early = await Promise.race([spawnFailed, new Promise<null>((r) => setTimeout(r, 0))]);
                if (early) throw new Error(`本地观察窗启动失败（shell='${this.shell}' 不可执行: ${early.message}）`);
            } else {
                if (!opts.manager) throw new Error(`remote 窗需要 StreamSessionManager（layer='${layerAlias}'）`);
                await new RemoteBridge(win, opts.manager).start(opts.command);
            }
            // 启动途中 dispose（Astra 四十期 #2）：sweeper 已停，此刻注册的窗永远
            // 无人回收（在途流进程成漏网孤儿）——收割在途资源并拒绝迟注册
            if (this.disposed) {
                win.close(); // 幂等收割（remote 引擎会话/local spawn 进程）
                throw new Error(`观察窗 '${opts.name}' 启动途中 Registry 已 dispose——流进程已收割，窗口未注册`);
            }
            this.windows.set(opts.name, win);
            this.log.info(`[StreamWindow] open '${opts.name}' (layer=${layerAlias})`);
            return win;
        } catch (e) {
            // 启动中途失败：收割已 attach 的传输（幂等——remote bridge 失败时无
            // transport 零动作；local attach 先于启动竞态检查，失败时 kill 无害）
            winRef?.close();
            throw e;
        } finally {
            this.pendingNames.delete(opts.name);
        }
    }

    stop(name: string): void {
        const win = this.require(name);
        this.lastSeqByName.set(name, win.allocatedSeq); // 续编锚
        __seqAnchors.delete(name); // 模块锚已并入（清防增长）（allocatedSeq——空窗〔重开后未收帧〕的 newestSeq=0 不再归零覆盖，五十一期 #1）
        win.close();
        this.windows.delete(name);
    }

    /** 通配聚合 peek：glob 如 "gpu:*"（* 与 ?；无通配=精确名） */
    peek(pattern: string): StreamWindow[] {
        return this.matches(pattern);
    }

    get(name: string): StreamWindow | undefined {
        return this.windows.get(name);
    }

    list(): Array<{ name: string; layer: string; frames: number; stale: boolean; command: string }> {
        return [...this.windows.values()].map((w) => ({
            name: w.name, layer: w.layerAlias, frames: w.frameCount, stale: w.stale, command: w.command,
        }));
    }

    private require(name: string): StreamWindow {
        const w = this.windows.get(name);
        if (!w) throw new Error(`观察窗 '${name}' 不存在`);
        return w;
    }

    private matches(pattern: string): StreamWindow[] {
        const hasWildcard = pattern.includes("*") || pattern.includes("?");
        if (!hasWildcard) {
            const w = this.windows.get(pattern);
            return w ? [w] : [];
        }
        const re = new RegExp(
            "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
        );
        return [...this.windows.values()].filter((w) => re.test(w.name));
    }

    private sweep(): void {
        const now = Date.now();
        for (const [name, w] of this.windows) {
            if (now - w.lastActiveAt > this.idleTtlMs) {
                this.log.info(`[StreamWindow] '${name}' 空引用超时 → 销毁`);
                this.stop(name);
            }
        }
    }

    get disposed(): boolean { return this._disposed; }

    dispose(): void {
        const wasD = this._disposed;
        this._disposed = true;
        void wasD; // 先置位：并发在途 open 在注册前检查到此标志即自收割
        clearInterval(this.sweeper);
        for (const name of [...this.windows.keys()]) this.stop(name);
    }
}

/** 模块级单例（消费方共享；多实例场景自行 new Registry） */
let _registry: StreamWindowRegistry | null = null;
export function getStreamWindowRegistry(): StreamWindowRegistry {
    if (_registry && _registry.disposed) _registry = null; // dispose 后重建（Sol 54 P2-20：曾返回死对象 open 永拒）
    if (!_registry) _registry = new StreamWindowRegistry();
    return _registry;
}
