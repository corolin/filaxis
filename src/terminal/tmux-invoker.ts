/**
 * terminal/tmux-invoker.ts — tmux CLI 原子调用层（净室平移）
 *
 * stdout/stderr 严格分离；非零退出码 reject（带 exitCode+stderr）不吞错；
 * exit 与 close 双监听先到为准（真实环境 exit 及时，mock 只发 close 兼容）。
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { TmuxResult } from "./types.js";
import { TmuxError } from "./types.js";

export class TmuxInvoker {
    static invoke(args: string[]): Promise<TmuxResult> {
        return new Promise((resolve, reject) => {
            let stdout = "";
            let stderr = "";
            let settled = false;
            const p = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
            // StringDecoder 双流（Hydrogen R5 #4）：跨块多字节 UTF-8 撕裂防护
            const oDec = new StringDecoder("utf-8");
            const eDec = new StringDecoder("utf-8");
            p.stdout.on("data", (d: Buffer) => { stdout += oDec.write(d); });
            p.stderr.on("data", (d: Buffer) => { stderr += eDec.write(d); });
            const settle = (exitCode: number | null) => {
                if (settled) return;
                settled = true;
                const code = exitCode ?? 0;
                if (code === 0) {
                    resolve({ stdout, stderr, exitCode: 0 });
                } else {
                    reject(new TmuxError(
                        `tmux ${args.join(" ")} failed with exit code ${code}` +
                        (stderr ? `: ${stderr.trim()}` : ""),
                        args, code, stderr,
                    ));
                }
            };
            p.once("exit", (code) => settle(code));
            p.once("close", (code) => settle(code));
            p.once("error", (err) => {
                if (settled) return;
                settled = true;
                reject(err);
            });
        });
    }

    /** 软失败变体：非零退出码返回带 exitCode 的结果（has-session 的 1=不存在是合法语义） */
    static async tryInvoke(args: string[]): Promise<TmuxResult> {
        try {
            return await this.invoke(args);
        } catch (e) {
            if (e instanceof TmuxError) {
                return { stdout: "", stderr: e.stderr, exitCode: e.exitCode };
            }
            throw e;
        }
    }

    /** tmux 是否可用（spawn 失败=未安装） */
    static async isAvailable(): Promise<boolean> {
        try {
            await this.tryInvoke(["list-sessions"]);
            return true;
        } catch {
            return false;
        }
    }
}
