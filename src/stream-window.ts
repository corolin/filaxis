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
import { startLocalObservation, watchLocalProcess } from "./local-observation-process.js";
import { StringDecoder } from "node:string_decoder";
import { StreamSessionManager } from "./stream-session-manager.js";
import { resolveLocalShell } from "./shell-discovery.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

/** 单帧截断后缀（与 session-buffer.ts TRUNC_SUFFIX 同语义） */
const TRUNC_SUFFIX = "…[truncated]";

export interface ObservationWindowOptions {
    name: string;
    command: string;
    stream?: "stdout" | "stderr" | "both";
    retainSequence?: boolean;
}

export interface StreamFrame {
    seq: number;
    /** 帧到达本地时刻（时钟域统一本地） */
    ts: number;
    text: string;
    stream?: "stdout" | "stderr";
}

export interface PeekResult {
    name: string;
    oldestSeq: number;
    newestSeq: number;
    stale: boolean;
    exitCode?: number | null;
    error?: string;
    frames: StreamFrame[];
    /** since 模式且中间发生环形覆盖时置 true（空洞显式可见，不静默） */
    gap?: boolean;
    /** since 模式：本次实际交付的末帧 seq（空结果=传入的 since——续读用它，
     *  **不是 newestSeq**：翻页限 n 时 newestSeq 是窗内最新帧，拿它续读会跳过
     *  未读帧〔Astra 五十期 #2〕） */
    lastDeliveredSeq?: number;
}

type Transport =
    | { kind: "local"; child: ChildProcess; requestStop(): void; waitForStop(deadline: number): Promise<void> }
    | { kind: "remote"; manager: StreamSessionManager; sessionId: string };

export class StreamWindow {
    private frames: StreamFrame[] = [];
    private nextSeq = 1;
    /** 已分配帧号上限（Astra 五十一期 #1）：独立于 frames 缓冲——空窗（重开后
     *  未收到帧）的 newestSeq=0，用它续锚会把已存帧号归零覆盖、peekSince 误报
     *  gap。allocatedSeq 恒等于「本窗生命周期内发出的最大 seq」（含续编起点） */
    private allocated = 0;
    private readonly rememberSeq: (sequence: number) => void;
    private _stale = false;
    private exitCode?: number | null;
    private streamError?: string;
    private _closed = false;
    private readonly consumers = new Map<string, number>();
    private transport: Transport | null = null;
    private closing?: Promise<void>;
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
        _anchorNs = "__bare__",
        rememberSeq?: (sequence: number) => void, // 裸窗全局 namespace（Registry 窗注入自身实例 id）
    ) {
        this.rememberSeq = rememberSeq ?? (() => undefined);
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
    push(text: string, stream?: "stdout" | "stderr"): void {
        if (this._closed) return;
        let line = text;
        // 字节口径（Sol 55 P2-G）：UTF-16 码元曾当字节——10 个「中」20 码元
        // 过 13 上限检查却占 30 UTF-8 字节透传。上限名是 LineBytes——按字节判
        if (Buffer.byteLength(line, "utf-8") > this.maxLineBytes) {
            // 上限容不下后缀（Sol 56 P2-4）：maxLineBytes 12 < 后缀 14B 曾输出
            // 14B 仍超限。后缀放不进即放弃后缀硬切到上限（截断事实保真优于标记）
            const suffixBytes = Buffer.byteLength(TRUNC_SUFFIX, "utf-8");
            if (this.maxLineBytes < suffixBytes) {
                let hard = line.slice(0, this.maxLineBytes);
                while (Buffer.byteLength(hard, "utf-8") > this.maxLineBytes && hard.length > 0) hard = hard.slice(0, -1);
                if (/[\uD800-\uDBFF]$/.test(hard)) hard = hard.slice(0, -1);
                line = hard;
            } else {
                const keepBytes = this.maxLineBytes - suffixBytes;
                let cut = line.slice(0, keepBytes); // 码元粗切——下方字节复核回退
                // 孤立高代理剥除（Sol 54 P2-19：切点落代理对中间——孤立高代理乱码）
                while (Buffer.byteLength(cut, "utf-8") > keepBytes && cut.length > 0) cut = cut.slice(0, -1);
                if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
                line = cut + TRUNC_SUFFIX;
            }
        }
        const seq = this.nextSeq++;
        this.allocated = seq; // 已分配锚（空窗续编/超前判定用——非缓冲末帧）
        this.frames.push({ seq, ts: Date.now(), text: line, ...(stream ? { stream } : {}) });
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

    /** Return the most recent retained frames strictly before the cursor. */
    peekBefore(beforeSeq: number, n = 20): PeekResult {
        if (n <= 0) return this.snapshot([]);
        const result = this.snapshot(this.frames.filter((frame) => frame.seq < beforeSeq).slice(-n));
        const through = Math.min(beforeSeq - 1, this.allocated);
        if (through > 0 && (!this.frames.length || this.oldestSeq > Math.max(1, through - n + 1))) result.gap = true;
        return result;
    }

    /** 最近 ms 毫秒内的帧 */
    peekWindow(ms: number, n = this.maxFrames): PeekResult {
        const cutoff = Date.now() - ms;
        const frames = this.frames.filter((f) => f.ts >= cutoff);
        return this.snapshot(n <= 0 ? [] : frames.slice(-n));
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
    markStale(exitCode?: number | null, error?: string): void {
        if (this._closed) return;
        this._stale = true;
        this.exitCode = exitCode;
        this.streamError = error;
    }

    attachTransport(transport: Transport | { kind: "local"; child: ChildProcess }): void {
        if (transport.kind !== "local" || "requestStop" in transport) {
            this.transport = transport;
            return;
        }
        const { child } = transport;
        const state = watchLocalProcess(child);
        this.transport = {
            kind: "local", child,
            requestStop() {
                if (!state.exited() && !child.kill("SIGKILL") && !state.exited()) {
                    throw new Error("无法向本地观察进程发送停止信号");
                }
            },
            waitForStop: () => state.finished,
        };
    }

    /** Explicitly closing a local window terminates its dedicated process tree. */
    close(): void {
        if (this._closed || this.closing) return;
        if (this.transport?.kind === "remote" && !this._stale) {
            this.transport.manager.stop(this.transport.sessionId);
        }
        if (this.transport?.kind === "local") this.transport.requestStop();
        this.finishClose();
    }

    private finishClose(): void {
        this._closed = true;
        this.rememberSeq(this.allocated);
        this.transport = null;
        this.frames = [];
        this.consumers.clear();
    }

    /** Release the window only after confirming that its observation process has stopped. */
    async closeConfirmed(): Promise<void> {
        if (this._closed) return;
        const closing = this.closing ??= this.confirmTransportStop();
        try { await closing; }
        finally { if (this.closing === closing) this.closing = undefined; }
    }

    private async confirmTransportStop(): Promise<void> {
        const transport = this.transport;
        if (transport?.kind === "remote" && !this._stale) {
            await transport.manager.stopAndWait(transport.sessionId);
        } else if (transport?.kind === "local") {
            const deadline = Date.now() + 3000;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                transport.requestStop();
                await Promise.race([transport.waitForStop(deadline), new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error("等待本地观察进程退出超时")), 3000);
                })]);
            } catch (cause) {
                throw Object.assign(new Error(`观察窗 '${this.name}' 停止结果未知`, { cause }), { outcome: "unknown" });
            } finally {
                clearTimeout(timer);
            }
        }
        this.finishClose();
    }

    private snapshot(frames: StreamFrame[]): PeekResult {
        this.lastActivityAt = Date.now();
        return {
            name: this.name,
            oldestSeq: this.oldestSeq,
            newestSeq: this.newestSeq,
            stale: this._stale,
            ...(this._stale && this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
            ...(this._stale && this.streamError !== undefined ? { error: this.streamError } : {}),
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
    /** 封顶保留段末尾 CR 的内容性判定（Sol 59 P2-2）：true=已证正文（成行时保留） */
    private capKeepCr = false;
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
                // 跨块 CRLF（Sol 55 P2-F）：\r 留在上一块尾 buf——判长时同属行终止符
                // 不计（`abcdefghijkl\r`+`\n` 分块曾 13>12 截断）；字节口径（P2-G）
                const bufBody = this.buf.endsWith("\r") ? this.buf.slice(0, -1) : this.buf;
                const dataBody = data.endsWith("\r") ? data.slice(0, -1) : data;
                // 判长/封顶解耦（Sol 57 P2-3/4）：判长用 body（CRLF 乐观不计）；
                // 封顶切**原文**（buf+data raw）——正文 CR 不丢；后缀放不进硬切（同 push）
                if (Buffer.byteLength(bufBody + dataBody, "utf-8") > this.maxBytes) {
                    const suffixBytes = Buffer.byteLength(TRUNC_SUFFIX, "utf-8");
                    const raw = this.buf + data;
                    if (this.maxBytes < suffixBytes) {
                        // 后缀放不进：硬切原文到上限字节（Sol 57 P2-4——不再「只剩标记」）
                        let hard = raw.slice(0, this.maxBytes);
                        while (Buffer.byteLength(hard, "utf-8") > this.maxBytes && hard.length > 0) hard = hard.slice(0, -1);
                        if (/[\uD800-\uDBFF]$/.test(hard)) hard = hard.slice(0, -1);
                        this.buf = hard;
                    } else {
                        const keepBytes = this.maxBytes - suffixBytes;
                        let cut = raw.slice(0, keepBytes); // 原文切（CR 计 1 字节内容——Sol 57 P2-3）
                        while (Buffer.byteLength(cut, "utf-8") > keepBytes && cut.length > 0) cut = cut.slice(0, -1);
                        if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
                        this.buf = cut + TRUNC_SUFFIX;
                    }
                    // 封顶末尾 CR 分治（Sol 59 P2-2）：保留段恰以 \r 收尾且其后有
                    // 被丢字节——该 \r 必是正文（abc\rXYZ 上限 4 → "abc\r"，成行时
                    // 保留——修前 emitCapped 一律剥，同输入分块方式改变了截断结果）。
                    // 真 CRLF 的 \n 若在本块内会走正常分辙（不封顶）——被丢首字节
                    // 不可能是 \n，防御性比较保留作未来改动的护栏
                    this.capKeepCr = this.buf.endsWith("\r") && raw.length > this.buf.length && raw[this.buf.length] !== "\n";
                    this.capped = true;
                } else {
                    this.buf += data; // CR 保留（成行时按 CRLF/内容分治）
                }
                return; // 尾段已并入 buf，等下一个 chunk
            }
            // 本 chunk 内有换行：当前行 = buf + data 头段；按**当前行长度**判定封顶
            const segRaw = data.slice(0, nl);
            const seg = segRaw.endsWith("\r") ? segRaw.slice(0, -1) : segRaw; // CR 剥后再判长（同上）
            const bufHere = (this.buf.endsWith("\r") && data[0] === "\n") ? this.buf.slice(0, -1) : this.buf; // 跨块 CRLF 收紧（Sol 56 P2-3）：buf 尾 \r 仅在 data 以 \n 开头才是 CRLF——正文 CR（abc\rXYZ\n）是内容
            if (Buffer.byteLength(bufHere + seg, "utf-8") > this.maxBytes) { // 字节口径（P2-G）
                // 与 push/tail 同款截断规则（Sol 58 P2-3）：后缀放不进硬切到上限字节
                // ——曾用码元 keep 产「…[truncate」形态（同输入分块方式曾变结果）
                const suffixBytes = Buffer.byteLength(TRUNC_SUFFIX, "utf-8");
                if (this.maxBytes < suffixBytes) {
                    let hard = (bufHere + seg).slice(0, this.maxBytes);
                    while (Buffer.byteLength(hard, "utf-8") > this.maxBytes && hard.length > 0) hard = hard.slice(0, -1);
                    if (/[\uD800-\uDBFF]$/.test(hard)) hard = hard.slice(0, -1);
                    onLine(hard);
                } else {
                    const keepBytes = this.maxBytes - suffixBytes;
                    let cutL = (bufHere + seg).slice(0, keepBytes);
                    while (Buffer.byteLength(cutL, "utf-8") > keepBytes && cutL.length > 0) cutL = cutL.slice(0, -1);
                    if (/[\uD800-\uDBFF]$/.test(cutL)) cutL = cutL.slice(0, -1);
                    onLine(cutL + TRUNC_SUFFIX);
                }
            } else {
                // 不再二次剥 CR（Sol 60 P2-6）：seg 已剥 CRLF 的 \r（segRaw 尾 \r），
                // 此处 bufHere+seg 若仍以 \r 收尾只可能是「正文 CR+CRLF」叠字符
                //（abc\r\r\n → seg="abc\r"）——再剥会把正文 CR 吃掉（实测 abc\r\r\n
                // 曾得 "abc"）。跨块 CRLF 的 \r 已由 bufHere 的收紧规则处理
                const clean = bufHere + seg;
                if (clean !== "") onLine(clean);
            }
            this.buf = "";
            this.capped = false; // 行已终结
            data = data.slice(nl + 1);
        }
    }

    /** 封顶行输出（capped 等到换行——buf 终值直接成行并复位） */
    private emitCapped(onLine: (line: string) => void): void {
        // 正文 CR 保留（Sol 59 P2-2）：capKeepCr=封顶时已证末尾 \r 是正文——
        // 修前一律剥尾（abc\rXYZ 上限 4 分块送达曾成 "abc"，整行送达是 "abc\r"）
        const clean = this.capKeepCr ? this.buf : this.buf.replace(/\r$/, "");
        this.buf = "";
        this.capped = false;
        this.capKeepCr = false;
        if (clean !== "") onLine(clean);
    }
    flush(onLine: (line: string) => void): void {
        const rest = this.capped && this.capKeepCr ? this.buf : this.buf.replace(/\r$/, "");
        this.buf = "";
        this.capped = false; // 行已终结——下一行重新计封顶
        this.capKeepCr = false;
        if (rest !== "") onLine(rest);
    }
}

/** 远程流桥：StreamSessionManager 行回调 → 窗入帧 */
class RemoteBridge {
    constructor(
        private readonly window: StreamWindow,
        private readonly manager: StreamSessionManager,
    ) {}

    async start(command: string, stream?: ObservationWindowOptions["stream"], stdinScript?: string): Promise<void> {
        const { sessionId } = await this.manager.start(command, {
            name: this.window.name.replace(/[^A-Za-z0-9_-]/g, "_"),
            stdinScript,
            onLine: (line) => {
                if (!stream || stream === "both" || stream === line.stream) this.window.push(line.text, line.stream);
            }, // filaxis 行对象 → text 投影
            onExit: (code, error) => this.window.markStale(code, error),
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
    /** 续编锚 namespace（实例 id——跨注册表隔离） */
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
    async open(opts: ObservationWindowOptions & {
        layerAlias?: string;
        cwd?: string;
        shell?: string;
        stdinScript?: string;
        transportCommand?: string;
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
                this.lastSeqByName.get(opts.name) ?? 0, undefined,
                (sequence) => { if (!this.disposed && opts.retainSequence !== false) this.lastSeqByName.set(opts.name, sequence); },
            );
            winRef = win;

            if (layerAlias === "local" && !opts.manager) {
                const shell = opts.shell ?? this.shell;
                const supervised = this.spawnImpl ? undefined : startLocalObservation(shell, opts.command, opts.cwd);
                const child = supervised ? supervised.child : this.spawnImpl!(shell, ["-c", opts.command], {
                    cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
                });
                const push = (stream: "stdout" | "stderr", line: string) => {
                    if (!opts.stream || opts.stream === "both" || opts.stream === stream) win.push(line, stream);
                };
                const spawnFailed = supervised ? undefined
                    : new Promise<Error>((resolve) => child.once("error", resolve));
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
                let stdoutBytes = 0;
                let stderrBytes = 0;
                child.stdout?.on("data", (d: Buffer) => {
                    stdoutBytes += d.length;
                    if (finalized) { checkDrained(); return; }
                    outSplitter.push(outDecoder.write(d), (l) => push("stdout", l));
                    checkDrained();
                });
                child.stderr?.on("data", (d: Buffer) => {
                    stderrBytes += d.length;
                    if (finalized) { checkDrained(); return; }
                    errSplitter.push(errDecoder.write(d), (l) => push("stderr", l));
                    checkDrained();
                });
                const finalize = (code: number | null) => {
                    if (finalized) return;
                    finalized = true;
                    clearTimeout(closeGuard);
                    outSplitter.push(outDecoder.end(), (l) => push("stdout", l));
                    errSplitter.push(errDecoder.end(), (l) => push("stderr", l));
                    outSplitter.flush((l) => push("stdout", l));
                    errSplitter.flush((l) => push("stderr", l));
                    win.markStale(code);
                };
                let closeGuard: ReturnType<typeof setTimeout> | undefined;
                let commandCode: number | null | undefined;
                let expectedBytes: { stdoutBytes: number; stderrBytes: number } | undefined;
                // IPC can arrive before pipe data. Wait until all reported bytes are consumed.
                const checkDrained = () => {
                    if (commandCode !== undefined && expectedBytes && stdoutBytes >= expectedBytes.stdoutBytes
                        && stderrBytes >= expectedBytes.stderrBytes) {
                        expectedBytes = undefined;
                        finalize(commandCode);
                        supervised?.retireWhenIdle();
                    }
                };
                const observeExit = (code: number | null) => {
                    commandCode = code;
                    if (!supervised) {
                        closeGuard = setTimeout(() => finalize(code), 2_000);
                        closeGuard.unref?.();
                    }
                    checkDrained();
                };
                if (supervised) {
                    supervised.onExit(observeExit);
                    supervised.onDrained((bytes) => { expectedBytes = bytes; checkDrained(); });
                } else {
                    child.on("exit", observeExit);
                }
                child.on("close", (code) => finalize(supervised ? commandCode ?? null : code ?? commandCode ?? null));
                win.attachTransport(supervised
                    ? { kind: "local", child, requestStop: supervised.requestStop, waitForStop: supervised.waitForStop }
                    : { kind: "local", child });
                try {
                    if (supervised) await supervised.started;
                    else {
                        const early = await Promise.race([spawnFailed!, new Promise<null>((r) => setTimeout(r, 0))]);
                        if (early) throw early;
                    }
                } catch (cause) {
                    const message = cause instanceof Error ? cause.message : String(cause);
                    throw new Error(`本地观察窗启动失败（shell='${shell}' 不可执行: ${message}）`, { cause });
                }
            } else {
                if (!opts.manager) throw new Error(`remote 窗需要 StreamSessionManager（layer='${layerAlias}'）`);
                await new RemoteBridge(win, opts.manager).start(opts.transportCommand ?? opts.command, opts.stream, opts.stdinScript);
            }
            // 启动途中 dispose（Astra 四十期 #2）：sweeper 已停，此刻注册的窗永远
            // 无人回收（在途流进程成漏网孤儿）——收割在途资源并拒绝迟注册
            if (this.disposed) {
                throw new Error(`观察窗 '${opts.name}' 启动途中 Registry 已 dispose`);
            }
            this.windows.set(opts.name, win);
            this.log.info(`[StreamWindow] open '${opts.name}' (layer=${layerAlias})`);
            return win;
        } catch (e) {
            // 启动中途失败：收割已 attach 的传输（幂等——remote bridge 失败时无
            // transport 零动作；local attach 先于启动竞态检查，失败时 kill 无害）
            if (winRef) {
                try { await winRef.closeConfirmed(); }
                catch (cleanupError) {
                    this.windows.set(opts.name, winRef);
                    this.log.warn(String(cleanupError));
                }
            }
            throw e;
        } finally {
            this.pendingNames.delete(opts.name);
            this.stopSweeperIfDisposed();
        }
    }

    stop(name: string): void {
        const win = this.require(name);
        win.close();
        if (win.closed) this.windows.delete(name);
    }

    async stopConfirmed(name: string): Promise<void> {
        const win = this.require(name);
        await win.closeConfirmed();
        if (this.windows.get(name) === win) this.windows.delete(name);
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
            if (this._disposed || now - w.lastActiveAt > this.idleTtlMs) {
                this.log.info(`[StreamWindow] '${name}' 空引用超时 → 销毁`);
                this.cleanup(name);
            }
        }
        this.stopSweeperIfDisposed();
    }

    get disposed(): boolean { return this._disposed; }

    dispose(): void {
        this._disposed = true;
        for (const name of [...this.windows.keys()]) {
            this.cleanup(name);
        }
        this.stopSweeperIfDisposed();
        this.lastSeqByName.clear();
    }

    private stopSweeperIfDisposed(): void {
        if (this._disposed && !this.windows.size && !this.pendingNames.size) clearInterval(this.sweeper);
    }

    private cleanup(name: string): void {
        void this.stopConfirmed(name)
            .catch((error) => this.log.warn(String(error)))
            .finally(() => this.stopSweeperIfDisposed());
    }
}

/** 模块级单例（消费方共享；多实例场景自行 new Registry） */
let _registry: StreamWindowRegistry | null = null;
export function getStreamWindowRegistry(): StreamWindowRegistry {
    if (_registry && _registry.disposed) _registry = null; // dispose 后重建（Sol 54 P2-20：曾返回死对象 open 永拒）
    if (!_registry) _registry = new StreamWindowRegistry();
    return _registry;
}
