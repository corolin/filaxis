import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

export interface PaneOutputObserver {
    readonly position: number;
    sawTextAfter(text: string, position: number): boolean;
    close(): void;
}

const MAX_TAIL_BYTES = 16_384;

/** Read tmux output events without changing the pane's pipe or window size. */
export async function observePaneOutput(
    session: string, pane: string, timeoutMs: number,
): Promise<PaneOutputObserver> {
    const client = spawn("tmux", ["-C", "attach-session", "-Er", "-t", session], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
    });
    // Latin-1 preserves byte values even when tmux splits a UTF-8 character across events.
    const lines = createInterface({ input: client.stdout.setEncoding("latin1"), crlfDelay: Infinity });
    const outputPrefix = "%output " + pane + " ";
    let tail = Buffer.alloc(0);
    let position = 0;
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        lines.close();
        client.stdin.destroy();
        client.kill();
    };
    try {
        await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error("等待 tmux 输出观察器超时")), timeoutMs);
            client.on("error", (error) => {
                clearTimeout(deadline);
                reject(error);
            });
            client.once("close", () => {
                clearTimeout(deadline);
                reject(new Error("tmux 输出观察器已退出"));
            });
            lines.on("line", (line) => {
                if (line.startsWith("%session-changed ")) {
                    clearTimeout(deadline);
                    resolve();
                } else if (line.startsWith(outputPrefix)) {
                    // tmux escapes control characters and backslashes as octal.
                    // Keep UTF-8 bytes so a prompt may span multiple output events.
                    const escaped = Buffer.from(line.slice(outputPrefix.length), "latin1");
                    const bytes: number[] = [];
                    for (let index = 0; index < escaped.length; index++) {
                        if (escaped[index] === 0x5c && index + 3 < escaped.length) {
                            bytes.push(Number.parseInt(escaped.toString("ascii", index + 1, index + 4), 8));
                            index += 3;
                        } else {
                            bytes.push(escaped[index]!);
                        }
                    }
                    position += bytes.length;
                    tail = Buffer.concat([tail, Buffer.from(bytes)]).subarray(-MAX_TAIL_BYTES);
                }
            });
        });
        return {
            get position() { return position; },
            sawTextAfter(text, after) {
                const index = Math.max(0, after - (position - tail.length));
                return stripVTControlCharacters(tail.subarray(index).toString("utf-8")).includes(text);
            },
            close,
        };
    } catch (error) {
        close();
        throw error;
    }
}
