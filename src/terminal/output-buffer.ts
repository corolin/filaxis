/**
 * terminal/output-buffer.ts — 三级输出缓冲（净室平移，纯逻辑零 I/O）
 *
 * pending（增量数组）/ aggregated（留尾串）/ tail（快照）三级；游标读取以
 * UTF-16 码元绝对偏移计，封顶裁头显式报断档（validFrom/lostChars）——
 * 拒绝静默返回不连续内容。
 */
import type { OutputStream } from "./types.js";

export interface BufferStats {
    total: number;
    truncated: boolean;
}

export type ReadLogResult = {
    ok: boolean;
    text: string;
    nextOffset: number;
    validFrom?: number;
    lostChars?: number;
};

export interface BufferCaps {
    pendingChars: number;
    aggregatedChars: number;
    tailChars: number;
}

export class OutputBuffer {
    private pendingStdout: string[] = [];
    private pendingStderr: string[] = [];
    private aggregated = "";
    private tail = "";
    private totalOutputChars = 0;
    private truncated = false;
    private baseOffset = 0;

    private readonly pendingCap: number;
    private readonly aggregatedCap: number;
    private readonly tailCap: number;

    constructor(caps: BufferCaps) {
        this.pendingCap = caps.pendingChars;
        this.aggregatedCap = caps.aggregatedChars;
        this.tailCap = caps.tailChars;
    }

    append(chunk: string, stream: OutputStream = "stdout"): void {
        if (chunk.length === 0) return;
        this.totalOutputChars += chunk.length;
        const buf = stream === "stderr" ? this.pendingStderr : this.pendingStdout;
        buf.push(chunk);
        this.trimPending(buf);
        this.aggregated += chunk;
        if (this.aggregated.length > this.aggregatedCap) {
            const dropped = this.aggregated.length - this.aggregatedCap;
            this.aggregated = this.aggregated.slice(-this.aggregatedCap);
            this.baseOffset += dropped;
            this.truncated = true;
        }
        this.tail = this.aggregated.slice(-this.tailCap);
    }

    /** 取走并清空未读增量 */
    drainPending(): string {
        const out = this.pendingStdout.join("");
        const err = this.pendingStderr.join("");
        this.pendingStdout = [];
        this.pendingStderr = [];
        return out + (err ? `\n[stderr]\n${err}` : "");
    }

    readTail(): string {
        return this.tail;
    }

    /** 分页读取（绝对偏移游标；游标过期显式报断档） */
    readLog(offset = 0, limit?: number): ReadLogResult {
        if (offset < this.baseOffset) {
            const lostChars = this.baseOffset - offset;
            const text = limit === undefined ? this.aggregated : this.aggregated.slice(0, limit);
            return { ok: false, text, nextOffset: this.baseOffset + text.length, validFrom: this.baseOffset, lostChars };
        }
        const start = offset - this.baseOffset;
        const text = limit === undefined
            ? this.aggregated.slice(start)
            : this.aggregated.slice(start, start + limit);
        return { ok: true, text, nextOffset: offset + text.length };
    }

    /** 便捷视图：丢失时前置断档提示行 */
    readLogText(offset = 0, limit?: number): string {
        const r = this.readLog(offset, limit);
        if (!r.ok) {
            return `[游标已过期] 此前约 ${r.lostChars} 字符已被裁掉，以下从绝对偏移 ${r.validFrom} 继续\n` + r.text;
        }
        return r.text;
    }

    get stats(): BufferStats {
        return { total: this.totalOutputChars, truncated: this.truncated };
    }

    hasPending(): boolean {
        return this.pendingStdout.length > 0 || this.pendingStderr.length > 0;
    }

    reset(): void {
        this.pendingStdout = [];
        this.pendingStderr = [];
        this.aggregated = "";
        this.tail = "";
        this.totalOutputChars = 0;
        this.baseOffset = 0;
        this.truncated = false;
    }

    private trimPending(buf: string[]): void {
        let len = buf.reduce((s, c) => s + c.length, 0);
        while (len > this.pendingCap && buf.length > 1) {
            const dropped = buf.shift()!;
            len -= dropped.length;
            this.truncated = true;
        }
    }
}
