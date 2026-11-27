import { StringDecoder } from "node:string_decoder";
import { open } from "node:fs/promises";

// Keep a separate tail for the completion sentinel and failed-connection diagnostics.
const TAIL_BYTES = 8192;

interface MarkerSample { bodyBytes: number; line: string }

export function parseCompletionMarker(evidence: string, marker: string, remembered?: MarkerSample) {
    const end = evidence.lastIndexOf(`\n${marker}:`);
    const line = remembered?.line ?? (end === -1 ? "" : evidence.slice(end + 1).split("\n", 1)[0] ?? "");
    const match = line.match(new RegExp(`^${marker}:(-?\\d+):(.*)$`));
    if (!match) return undefined;
    return {
        end: end === -1 ? evidence.length : end,
        bodyBytes: remembered?.bodyBytes,
        exitCode: parseInt(match[1]!, 10),
        effectiveUser: match[2] || undefined,
    };
}

export class ExecCapture {
    private readonly decoder = new StringDecoder("utf8");
    private full = "";
    private head = Buffer.alloc(0);
    private tail = Buffer.alloc(0);
    private size = 0;
    private readonly marker?: Buffer;
    completionMarker?: MarkerSample;

    constructor(private readonly limit?: number, marker?: string) {
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error("maxOutputBytes 需为非负整数");
        if (limit !== undefined && marker) this.marker = Buffer.from(`\n${marker}:`);
    }

    write(chunk: Buffer): void {
        if (this.limit === undefined) {
            this.full += this.decoder.write(chunk);
            return;
        }
        this.size += chunk.length;
        if (this.head.length < this.limit) {
            this.head = Buffer.concat([this.head, chunk.subarray(0, this.limit - this.head.length)]);
        }
        if (this.marker) {
            const span = Buffer.concat([this.tail, chunk]);
            const at = span.lastIndexOf(this.marker);
            if (at !== -1) this.rememberMarker(span.subarray(at + 1), this.size - span.length + at);
        }
        this.tail = chunk.length >= TAIL_BYTES
            ? Buffer.from(chunk.subarray(-TAIL_BYTES))
            : Buffer.concat([this.tail.subarray(Math.max(0, this.tail.length + chunk.length - TAIL_BYTES)), chunk]);
    }

    /** Full text in normal mode, a separate bounded suffix in preview mode. */
    evidence(): string {
        return this.limit === undefined ? this.full + this.decoder.end() : this.tail.toString("utf8");
    }

    result(evidence: string, end = evidence.length, bodyBytes?: number): string {
        if (this.limit === undefined) return evidence.slice(0, end);
        const contentBytes = bodyBytes ?? this.size - Buffer.byteLength(evidence.slice(end));
        const prefix = this.head.subarray(0, Math.max(0, contentBytes));
        if (contentBytes <= this.limit) return prefix.toString("utf8");
        // A byte limit can bisect a UTF-8 code point. Count retained input bytes,
        // not the size of the decoded string (malformed input can expand to U+FFFD).
        let start = prefix.length - 1;
        while (start >= Math.max(0, prefix.length - 3) && (prefix[start]! & 0xc0) === 0x80) start--;
        const lead = prefix[start] ?? 0;
        const width = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
        const retained = width > prefix.length - start ? start : prefix.length;
        return `${prefix.subarray(0, retained).toString("utf8")}\n[采集阶段已截断 ${contentBytes - retained} 字节]`;
    }

    private rememberMarker(bytes: Buffer, bodyBytes: number): void {
        const newline = bytes.indexOf(10);
        const end = newline === -1 ? bytes.length : newline;
        this.completionMarker = { bodyBytes, line: end >= TAIL_BYTES ? "" : bytes.subarray(0, end).toString("utf8") };
    }

    static async fromFile(path: string, limit: number, marker?: string): Promise<ExecCapture> {
        const capture = new ExecCapture(limit, marker);
        const file = await open(path, "r");
        try {
            capture.size = (await file.stat()).size;
            const read = async (length: number, position: number) => {
                const buffer = Buffer.alloc(length);
                let offset = 0;
                while (offset < length) {
                    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
                    if (!bytesRead) break;
                    offset += bytesRead;
                }
                return buffer.subarray(0, offset);
            };
            const tailLength = Math.min(capture.size, TAIL_BYTES);
            capture.head = await read(Math.min(capture.size, limit), 0);
            capture.tail = await read(tailLength, capture.size - tailLength);
            if (capture.marker) {
                const needle = capture.marker;
                // Search backwards in bounded blocks and overlap the marker prefix.
                // A child can keep stdout open and write after its parent printed the marker.
                let block = capture.tail;
                let start = capture.size - block.length;
                for (;;) {
                    const at = block.lastIndexOf(needle);
                    if (at !== -1) {
                        const offset = start + at + 1;
                        capture.rememberMarker(await read(Math.min(TAIL_BYTES, capture.size - offset), offset), offset - 1);
                        break;
                    }
                    if (!start) break;
                    const end = start + Math.min(needle.length - 1, TAIL_BYTES - 1);
                    start = Math.max(0, end - TAIL_BYTES);
                    block = await read(end - start, start);
                }
            }
            return capture;
        } finally {
            await file.close();
        }
    }
}
