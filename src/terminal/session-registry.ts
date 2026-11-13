/**
 * terminal/session-registry.ts — TerminalProfile 持久化与重连扫描
 * （净室平移；logger 换注入）
 */
import fs from "node:fs/promises";
import { TmuxInvoker } from "./tmux-invoker.js";
import { noopLogger, type FilaxisLogger } from "../logger.js";

export interface TerminalProfile {
    id: string;
    driver: string;
    target: string;
    config?: Record<string, unknown>;
    createdAt: number;
}

export type DirResolver = () => string;

export class SessionRegistry {
    private reconciledDirs = new Set<string>();

    constructor(
        private readonly dirResolver: DirResolver,
        private readonly log: FilaxisLogger = noopLogger,
    ) {}

    async ensureDir(): Promise<void> {
        await fs.mkdir(this.dirResolver(), { recursive: true });
    }

    /** 确保目录存在 + 每目录一次重连扫描（幂等；换目录=新一轮启动） */
    async init(): Promise<void> {
        await this.ensureDir();
        const dir = this.dirResolver();
        if (this.reconciledDirs.has(dir)) return;
        this.reconciledDirs.add(dir);
        await this.reconcileOnStartup();
    }

    async save(profile: TerminalProfile): Promise<void> {
        await fs.writeFile(`${this.dirResolver()}/${profile.id}.json`, JSON.stringify(profile, null, 2));
    }

    /** 缺失返回 null（不抛） */
    async load(id: string): Promise<TerminalProfile | null> {
        try {
            const raw = await fs.readFile(`${this.dirResolver()}/${id}.json`, "utf-8");
            return JSON.parse(raw) as TerminalProfile;
        } catch {
            return null;
        }
    }

    /** 幂等删除 */
    async remove(id: string): Promise<void> {
        try {
            await fs.unlink(`${this.dirResolver()}/${id}.json`);
        } catch { /* 幂等 */ }
    }

    /** 启动重连扫描：存活会话保留（=重连），僵尸 profile 清理 */
    async reconcileOnStartup(): Promise<{ scanned: number; kept: number; removed: number }> {
        const dir = this.dirResolver();
        let files: string[];
        try {
            files = await fs.readdir(dir);
        } catch {
            return { scanned: 0, kept: 0, removed: 0 };
        }
        const profiles = files.filter((f) => f.endsWith(".json"));
        let kept = 0;
        let removed = 0;
        await Promise.all(profiles.map(async (file) => {
            const id = file.slice(0, -5);
            const profile = await this.load(id);
            if (!profile || profile.id !== id) {
                await this.remove(id);
                removed++;
                return;
            }
            try {
                const r = await TmuxInvoker.tryInvoke(["has-session", "-t", id]);
                if (r.exitCode === 0) {
                    kept++;
                    this.log.info(`[reconcile] 会话 [${id}] 仍存活，保留（已重连）`);
                } else {
                    await this.remove(id);
                    removed++;
                    this.log.warn(`[reconcile] 僵尸会话 [${id}] 已清理`);
                }
            } catch {
                // tmux 未安装：无法核实——保留 profile（保守，不误删）
                kept++;
            }
        }));
        return { scanned: profiles.length, kept, removed };
    }
}
