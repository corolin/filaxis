import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function withLocalWriteLock<T>(path: string, subject: string, update: () => T): T {
    const lock = `${path}.lock`;
    mkdirSync(lock, { recursive: true });
    const claim = join(lock, `${process.pid}-${randomUUID()}`);
    // Each writer publishes its own claim before looking for its peers.
    writeFileSync(claim, "", { flag: "wx", mode: 0o600 });
    try {
        for (const entry of readdirSync(lock)) {
            const peer = join(lock, entry);
            if (peer === claim) continue;
            const owner = /^([1-9]\d*)-[0-9a-f-]{36}$/.exec(entry);
            if (!owner) throw new Error(`${subject}锁含无法识别的写入记录: ${peer}`);
            try {
                process.kill(Number(owner[1]), 0);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                    try { unlinkSync(peer); } catch (cleanup) {
                        if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw cleanup;
                    }
                    continue;
                }
                if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
            }
            throw new Error(`${subject}正在写入: ${path}`);
        }
        return update();
    } finally {
        unlinkSync(claim);
    }
}
