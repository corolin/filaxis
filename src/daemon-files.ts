/**
 * daemon-files.ts — Filaxis 常驻守护进程本地状态文件、PID 单实例锁与 Bearer Token 工具
 *
 * 零第三方依赖，仅使用 node:crypto / node:fs / node:os / node:path（Bun + Node LTS、Windows + Linux 同构）。
 */
import * as crypto from "node:crypto";
import {
    chmodSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DaemonPaths {
    dir: string;
    lockFile: string;
    addrFile: string;
    tokenFile: string;
}

export interface DaemonLockRecord {
    pid: number;
    startedAt: number;
    version: string;
}

export interface DaemonConnectionInfo {
    addr: string;
    token: string;
    lock?: DaemonLockRecord;
}

export function defaultDaemonDir(): string {
    return process.env.FILAXIS_DAEMON_DIR || join(homedir(), ".filaxis", "daemon");
}

export function assertLoopbackHost(host: string): string {
    const normalized = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
    if (normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost") {
        return host.trim().replace(/^\[|\]$/g, "");
    }
    throw new Error(`Filaxis Daemon 仅允许绑定本地回环地址（127.0.0.1 / ::1 / localhost），拒绝监听: ${host}`);
}

export function daemonPaths(dir = defaultDaemonDir()): DaemonPaths {
    return {
        dir,
        lockFile: join(dir, "daemon.lock"),
        addrFile: join(dir, "daemon.addr"),
        tokenFile: join(dir, "daemon.token"),
    };
}

export function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return false;
        if (code === "EPERM") return true;
        return false;
    }
}

export function readDaemonLock(dir = defaultDaemonDir()): DaemonLockRecord | null {
    const { lockFile } = daemonPaths(dir);
    try {
        const raw = readFileSync(lockFile, "utf-8");
        const parsed = JSON.parse(raw) as Partial<DaemonLockRecord>;
        if (!parsed || typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
        return {
            pid: parsed.pid,
            startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
            version: typeof parsed.version === "string" ? parsed.version : "",
        };
    } catch {
        return null;
    }
}

export function acquireDaemonLock(dir: string, version: string): DaemonLockRecord {
    const { lockFile } = daemonPaths(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: DaemonLockRecord = {
        pid: process.pid,
        startedAt: Date.now(),
        version,
    };
    const payload = JSON.stringify(record);

    const tryExclusiveCreate = (): boolean => {
        try {
            writeFileSync(lockFile, payload, { flag: "wx", mode: 0o600 });
            if (process.platform !== "win32") {
                try { chmodSync(lockFile, 0o600); } catch { /* ignore */ }
            }
            return true;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
            throw err;
        }
    };

    if (tryExclusiveCreate()) return record;

    const existing = readDaemonLock(dir);
    if (existing && isPidAlive(existing.pid)) {
        throw new Error(`Filaxis Daemon 已在运行 (pid=${existing.pid})`);
    }
    try {
        unlinkSync(lockFile);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!tryExclusiveCreate()) {
        const racer = readDaemonLock(dir);
        throw new Error(
            racer && isPidAlive(racer.pid)
                ? `Filaxis Daemon 已在运行 (pid=${racer.pid})`
                : `Filaxis Daemon 启动锁并发冲突: ${lockFile}`,
        );
    }
    return record;
}

export function writePrivateFileAtomic(filePath: string, content: string): void {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
        writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
        if (process.platform !== "win32") {
            try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
        }
        renameSync(tmp, filePath);
        if (process.platform !== "win32") {
            try { chmodSync(filePath, 0o600); } catch { /* ignore */ }
        }
    } finally {
        try { unlinkSync(tmp); } catch { /* rename 后临时文件已消失 */ }
    }
}

export function generateDaemonToken(): string {
    return crypto.randomBytes(32).toString("hex");
}

export function verifyBearerToken(authHeader: string | undefined, expectedToken: string): boolean {
    if (!authHeader || !expectedToken) return false;
    const match = authHeader.trim().match(/^Bearer\s+(\S+)$/i);
    if (!match) return false;
    const providedBuf = Buffer.from(match[1]!, "utf-8");
    const expectedBuf = Buffer.from(expectedToken, "utf-8");
    if (providedBuf.byteLength !== expectedBuf.byteLength) return false;
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

export function readDaemonConnection(dir = defaultDaemonDir()): DaemonConnectionInfo | null {
    const { addrFile, tokenFile } = daemonPaths(dir);
    try {
        const addr = readFileSync(addrFile, "utf-8").trim();
        const token = readFileSync(tokenFile, "utf-8").trim();
        if (!addr || !token) return null;
        const lock = readDaemonLock(dir) ?? undefined;
        return { addr, token, ...(lock ? { lock } : {}) };
    } catch {
        return null;
    }
}

export function cleanupDaemonFiles(dir = defaultDaemonDir(), expectedPid?: number): void {
    const { lockFile, addrFile, tokenFile } = daemonPaths(dir);
    if (expectedPid !== undefined) {
        const current = readDaemonLock(dir);
        if (current && current.pid !== expectedPid) return;
    }
    for (const file of [addrFile, tokenFile, lockFile]) {
        try { unlinkSync(file); } catch { /* ignore */ }
    }
}
