/**
 * session-buffer.ts — 会话窗口基础件（纯逻辑，无 I/O）
 *
 * 净室平移自 个人Agent项目 `原内部模块`
 * 。
 *
 * LineAssembler     字节流按 \n 组行（CRLF 剥 \r；partial 暂存；flush 收尾）
 * OutputRingBuffer  热窗口：maxLines × maxLineBytes 截断；截断仅发生在窗口副本
 *                   ——落盘文件侧由调用方写完整行
 *                   OSS 扩展（REQ-0001 FEAT-11）：evictedCount 逐出计数——
 *                   ready() 滚出感知「有据」的机制件（>0 = 窗口历史不完整）
 * WatchRegistry     行级 watcher：string=子串 / RegExp 命中；once 默认；每会话上限
 */

/** 无换行极端流的暂存硬上限（防 OOM）：超限强制切块成行 */
const MAX_PENDING_BYTES = 2 * 1024 * 1024;

/** 会话名白名单规范化（四十期 #1 收敛为机制——四处后端共享，防漂移）：
 *  用户提供的 name 拼进 sessionId→派生路径/文件名，白名单字符集
 *  [a-zA-Z0-9_-] 内零 shell 元字符（tmux 曾原文拼接被注入，真 Bash 复现） */
export function sanitizeSessionName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export class LineAssembler {
    private pending = '';

    /** 喂入一段输出，返回其中已成行的部分（不含尾部的 partial） */
    feed(chunk: string): string[] {
        this.pending += chunk;
        const lines: string[] = [];
        let idx: number;
        while ((idx = this.pending.indexOf('\n')) !== -1) {
            let line = this.pending.slice(0, idx);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            lines.push(line);
            this.pending = this.pending.slice(idx + 1);
        }
        // 硬上限：极端无换行字节流强制切块（如失控输出/二进制误入），插入截断标记
        if (this.pending.length > MAX_PENDING_BYTES) {
            lines.push(this.pending.slice(0, MAX_PENDING_BYTES) + '[TRUNCATED_CHUNK]');
            this.pending = '';
        }
        return lines;
    }

    /** 进程退出时调用：无换行的残余强制成行 */
    /** 只读未成行缓冲（交互提示无换行滞留检测用——Hydrogen R4 #1） */
    peekPending(): string {
        return this.pending;
    }

    flush(): string[] {
        if (this.pending === '') return [];
        const rest = this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending;
        this.pending = '';
        return rest === '' ? [] : [rest];
    }
}

export interface RingBufferOptions {
    maxLines?: number;
    maxLineBytes?: number;
}

const TRUNC_SUFFIX = '[…truncated, see session log]';

/** 输出流标记（定义于 session-types，此处 re-export 便利用户） */
export type { OutputStream } from "./session-types.js";
import type { OutputStream } from "./session-types.js";

/** 热窗口行对象：跨流聚合序为到达序（不承诺进程真实写入序——REQ §3.2） */
export interface SessionLine {
    stream: OutputStream;
    text: string;
}

export class OutputRingBuffer {
    private readonly maxLines: number;
    private readonly maxLineBytes: number;
    private lines: SessionLine[] = [];
    private evictedLines = 0;

    constructor(opts: RingBufferOptions = {}) {
        this.maxLines = opts.maxLines ?? 50;
        this.maxLineBytes = opts.maxLineBytes ?? 512;
    }

    /** 完整行入窗（窗口侧按 maxLineBytes 硬截断 text 含标记；文件侧由调用方写原行） */
    push(line: SessionLine): void {
        let text = line.text;
        if (text.length > this.maxLineBytes) {
            // OSS 边界修复（源实现 bug）：源版 slice(0, maxLineBytes - suffix.length)
            // 在 maxLineBytes < 后缀长度时为负索引，行为反转（越截越长）。keep 下限 0
            // 保截断标记；此时行长为后缀长度（29）恒定，防 OOM 语义不破。
            const keep = Math.max(0, this.maxLineBytes - TRUNC_SUFFIX.length);
            text = text.slice(0, keep) + TRUNC_SUFFIX;
        }
        this.lines.push({ stream: line.stream, text });
        if (this.lines.length > this.maxLines) {
            const overflow = this.lines.length - this.maxLines;
            this.lines = this.lines.slice(-this.maxLines);
            this.evictedLines += overflow;
        }
    }

    /** 最近 n 行的 text 投影（简洁消费） */
    tail(n: number): string[] {
        return this.lines.slice(-Math.max(0, n)).map((l) => l.text);
    }

    /** 最近 n 行对象（带 stream 标记——FEAT-05 按流过滤迭代用） */
    tailLines(n: number): SessionLine[] {
        return this.lines.slice(-Math.max(0, n));
    }

    /**
     * 自创建以来被挤出窗口的行数（FEAT-11 滚出感知有据）：
     * 0 = 窗口历史完整（标记若出现过必仍在窗内）；>0 = 历史可能不完整。
     */
    get evictedCount(): number {
        return this.evictedLines;
    }

    /**
     * 命中行 ± contextLines 的上下文切片（索引相对当前窗口，越界收敛）。
     * 供 watcher 命中时组装通知上下文。
     */
    contextAround(index: number, contextLines: number): SessionLine[] {
        const from = Math.max(0, index - contextLines);
        const to = Math.min(this.lines.length, index + contextLines + 1);
        return this.lines.slice(from, to);
    }

    /** 命中行的窗口索引（按 text 查找；找不到回退末行）——watch 上下文组装用 */
    indexOfLine(text: string): number {
        const i = this.lines.findIndex((l) => l.text === text);
        return i === -1 ? this.lines.length - 1 : i;
    }

    get size(): number {
        return this.lines.length;
    }
}

export interface WatcherSpec {
    id: string;
    pattern: string | RegExp;
    /** 命中一次即摘除（默认 true） */
    once?: boolean;
}

interface WatcherEntry extends WatcherSpec {
    regex: RegExp;
}

const MAX_WATCHERS_PER_SESSION = 8;

export class WatchRegistry {
    private watchers = new Map<string, WatcherEntry>();

    add(spec: WatcherSpec): void {
        if (this.watchers.size >= MAX_WATCHERS_PER_SESSION) {
            throw new Error(`watcher 数量已达上限（${MAX_WATCHERS_PER_SESSION}/会话），先 cancel 旧的再注册`);
        }
        this.watchers.set(spec.id, { ...spec, regex: this.toRegex(spec.pattern) });
    }

    /** 匹配一行，返回命中的 watcher id（once 的命中即摘除） */
    match(line: string): string[] {
        const hits: string[] = [];
        for (const [id, w] of this.watchers) {
            if (w.regex.test(line)) {
                hits.push(id);
                if (w.once !== false) this.watchers.delete(id);
            }
        }
        return hits;
    }

    cancel(id: string): boolean {
        return this.watchers.delete(id);
    }

    /** 全清（终态封板——会话 finalize 后行不再参与 watcher 匹配） */
    clear(): void {
        this.watchers.clear();
    }

    get size(): number {
        return this.watchers.size;
    }

    private toRegex(pattern: string | RegExp): RegExp {
        // RegExp 实例克隆并去 g/y 标志（GPT Astra 十七轮 #2）：带 g/y 的 test 有
        // lastIndex 状态——常驻 watcher 连续行「命中、漏掉、命中」；且直接持有
        // 调用方实例会反向污染其 lastIndex。行匹配语义=每行独立无状态。
        if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
        // string 模式 = 子串语义：全文转义
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(escaped);
    }
}
