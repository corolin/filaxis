/**
 * shell-discovery.ts — 本地 shell 发现（Windows WSL 入口坑防护——Gemini 试用反馈 #1）
 *
 * 痛点：win32 PATH 上的 `bash` 可能是 `C:\Windows\System32\bash.exe`（WSL 转发入口，
 * 未配置默认分发时 spawn 即挂）。发现序：
 *   1. 显式传入（opts.shell / FILAXIS_SHELL 环境变量）
 *   2. PATH 上的 bash——**若非 System32 WSL 入口则直接用**（并发 spawn 热路径：
 *      完整路径 exe 在 Windows Defender 并发扫描下首启可达 20s+，PATH 名 spawn 无此坑——生产实证）
 *   3. Git Bash 标准路径嗅探（PATH bash 即 WSL 入口的兜底）
 *   4. 回退 "bash" + 诊断提示（用户可能真有 WSL 发行版）
 */
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

const GIT_BASH_CANDIDATES = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

/** PATH 上 bash 的解析结果（无则 undefined） */
function bashOnPath(): string | undefined {
    try {
        return execSync("where bash", { stdio: ["ignore", "pipe", "ignore"] })
            .toString().split("\n").map((l) => l.trim()).filter(Boolean)[0];
    } catch {
        return undefined;
    }
}

/** 发现本执行 shell（Linux/macOS 恒 "bash"） */
export function resolveLocalShell(preferred?: string, log?: { warn(msg: string): void }): string {
    if (preferred) return preferred;
    if (process.platform !== "win32") return "bash";

    const fromEnv = process.env.FILAXIS_SHELL;
    if (fromEnv) return fromEnv;

    const p = bashOnPath();
    if (p && !/System32/i.test(p)) return "bash"; // PATH 上的真 bash（Git Bash 等）——并发热路径

    for (const c of GIT_BASH_CANDIDATES) {
        if (existsSync(c)) return c;
    }

    log?.warn(
        "[Filaxis] Windows 未找到可用 bash（PATH " +
        (p ? "上是 WSL 转发入口" : "上无 bash") +
        "且未嗅探到 Git Bash）——请安装 Git（https://git-scm.com）或设 FILAXIS_SHELL 指向 bash.exe 完整路径",
    );
    return "bash";
}
