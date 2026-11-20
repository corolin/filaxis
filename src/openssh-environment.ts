import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { win32 } from "node:path";
import { noopLogger, type FilaxisLogger } from "./logger.js";

let warnedAboutMissingSystemRoot = false;

/** OpenSSH on Windows expects the system and account environment even in a restricted host. */
export function openSshEnvironment(source: NodeJS.ProcessEnv = process.env, log: FilaxisLogger = noopLogger): NodeJS.ProcessEnv {
    if (process.platform !== "win32") return source;

    const env = { ...source };
    const keysFor = (name: string) => Object.keys(env).filter((key) => key.toLowerCase() === name.toLowerCase()).sort();
    const read = (name: string): string | undefined => keysFor(name).map((key) => env[key]).find((value) => value?.trim());
    const fill = (name: string, fallback?: string) => {
        const keys = keysFor(name);
        const selected = keys.find((key) => env[key]?.trim());
        if (!selected && !fallback) return;
        // Node selects one case-insensitive variant. Remove empty aliases that could shadow it.
        for (const key of keys) if (key !== selected) delete env[key];
        if (!selected) env[name] = fallback;
    };

    const comSpec = read("ComSpec");
    const comSpecRoot = comSpec && /[\\/](?:System32|SysWOW64)[\\/]cmd\.exe$/i.test(comSpec)
        ? win32.dirname(win32.dirname(comSpec)) : undefined;
    const systemDrive = read("SystemDrive");
    const suppliedSystemRoot = read("SystemRoot");
    const systemRoot = suppliedSystemRoot ?? read("windir") ?? [
        comSpecRoot,
        systemDrive && win32.join(systemDrive + "\\", "Windows"),
        win32.join(win32.parse(process.execPath).root, "Windows"),
        "C:\\Windows",
    ].find((candidate) => candidate && win32.isAbsolute(candidate)
        && existsSync(win32.join(candidate, "System32", "kernel32.dll")));
    const driveRoot = systemRoot ? win32.parse(systemRoot).root : undefined;
    const programData = read("ProgramData") ?? read("ALLUSERSPROFILE")
        ?? (driveRoot ? win32.join(driveRoot, "ProgramData") : undefined);

    fill("SystemRoot", systemRoot);
    fill("windir", systemRoot);
    fill("SystemDrive", driveRoot?.slice(0, 2));
    fill("ProgramData", programData);
    fill("ALLUSERSPROFILE", programData);

    let account: { username: string; homedir: string } | undefined;
    if (!read("USERNAME") || !read("USERPROFILE")) {
        try { account = userInfo(); } catch { /* A restricted host may not expose account information. */ }
    }
    fill("USERNAME", account?.username);
    fill("USERPROFILE", account?.homedir);
    if (!suppliedSystemRoot && systemRoot && log !== noopLogger && !warnedAboutMissingSystemRoot) {
        warnedAboutMissingSystemRoot = true;
        try { log.warn("Windows 宿主环境缺少 SystemRoot，已为 OpenSSH 子进程补齐。请检查启动器是否用自定义 env 替换了继承环境。"); }
        catch { /* A diagnostic must not prevent the child from starting. */ }
    }
    return env;
}
