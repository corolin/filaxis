/**
 * terminal-manager.ts — 持久终端会话门面（净室平移）
 *
 * OSS 化：源版全 static + getProjectRoot 单例 → 实例类（terminalDir 可配，
 * 缺省 os.tmpdir()/filaxis-terminals；多实例多目录并存）；logger 注入。
 *
 * 公开契约（与源版签名一致）：
 *   spawnSession(driver,target,config?,customId?) → Promise<string>
 *   runCommand(id,cmd,timeoutMs|options) → Promise<{stdout,exitCode}>
 *   getSession(id) / destroySession(id) / init()
 */
import path from "node:path";
import { tmpdir } from "node:os";
import { SessionRegistry, type TerminalProfile } from "./terminal/session-registry.js";
import { SessionLauncher } from "./terminal/session-launcher.js";
import { CommandExecuter, type RunOptions } from "./terminal/command-executer.js";
import { TmuxInvoker } from "./terminal/tmux-invoker.js";
import type { TerminalConfig } from "./terminal/types.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

export type { TerminalProfile } from "./terminal/session-registry.js";

export interface TerminalManagerOptions {
    /** profile 持久化目录（缺省 os.tmpdir()/filaxis-terminals） */
    terminalDir?: string;
    config?: Partial<TerminalConfig>;
    logger?: FilaxisLogger;
}

export class TerminalManager {
    private readonly registry: SessionRegistry;
    private readonly executer: CommandExecuter;
    private readonly launcher: SessionLauncher;
    readonly terminalDir: string;

    constructor(opts: TerminalManagerOptions = {}) {
        this.terminalDir = opts.terminalDir ?? path.join(tmpdir(), "filaxis-terminals");
        const log = opts.logger ?? noopLogger;
        this.registry = new SessionRegistry(() => this.terminalDir, log);
        this.launcher = new SessionLauncher(this.registry, { config: opts.config, logger: log });
        // 独立执行器实例（Hydrogen R3 #1）：曾共用全局 static——多实例互相覆盖
        this.executer = new CommandExecuter({ config: opts.config, logger: log });
    }

    /** 确保目录存在 + 一次重连扫描（幂等） */
    async init(): Promise<void> {
        await this.registry.init();
    }

    /** 启动（或复用）持久 tmux 会话 */
    async spawnSession(
        driver: string,
        target: string | undefined,
        config?: Record<string, unknown>,
        customId?: string,
    ): Promise<string> {
        await this.init();
        return this.launcher.launch(driver, target, config, customId);
    }

    /** 会话内执行命令（纯净 stdout + exitCode；第三参 number|RunOptions 多态） */
    async runCommand(
        id: string,
        command: string,
        timeoutMsOrOptions: number | RunOptions = 600_000,
    ): Promise<{ stdout: string; exitCode: number }> {
        const opts: RunOptions = typeof timeoutMsOrOptions === "number"
            ? { timeoutMs: timeoutMsOrOptions }
            : timeoutMsOrOptions;
        return this.executer.execute(id, command, opts);
    }

    /** 销毁会话 + 删 profile（best-effort：kill-session 失败不阻断） */
    async destroySession(id: string): Promise<void> {
        try {
            await TmuxInvoker.invoke(["kill-session", "-t", id]);
        } catch { /* best-effort */ }
        await this.registry.remove(id);
    }

    /** 读 profile；缺失返回 null */
    async getSession(id: string): Promise<TerminalProfile | null> {
        return this.registry.load(id);
    }
}
