/**
 * terminal/session-launcher.ts — 持久 tmux 会话启动器
 * （净室平移；TerminalConfig 注入化）
 *
 * FR-1：customId 命中存活会话 → 复用返回同 id（跨进程重启恢复连接的语义）；
 * 未知 driver 且无 launchCmd → 抛 /Unknown driver/；会话立即死亡 → 清 profile 抛带 hint 错。
 * FR-9 第一道防线：launchCmd 前置 env_hardening_prefix 关交互 Prompt。
 */
import { SessionRegistry, type TerminalProfile } from "./session-registry.js";
import { TmuxInvoker } from "./tmux-invoker.js";
import { DEFAULT_TERMINAL_CONFIG, type TerminalConfig } from "./types.js";
import { noopLogger, type FilaxisLogger } from "../logger.js";
import { shellQuote } from "../ssh-helpers.js";

export interface SessionLauncherOptions {
    config?: Partial<TerminalConfig>;
    logger?: FilaxisLogger;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SessionLauncher {
    private readonly cfg: TerminalConfig;
    private readonly log: FilaxisLogger;

    constructor(
        private readonly registry: SessionRegistry,
        opts: SessionLauncherOptions = {},
    ) {
        this.cfg = { ...DEFAULT_TERMINAL_CONFIG, ...opts.config };
        this.log = opts.logger ?? noopLogger;
    }

    /** 启动（或复用）一个持久 tmux 会话；返回存活会话 id */
    async launch(
        driver: string,
        target: string | undefined,
        config?: Record<string, unknown>,
        customId?: string,
    ): Promise<string> {
        const id = customId || ("term_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6));
        const launchCmd = this.resolveLaunchCmd(driver, target, config);

        // customId 复用：会话仍存活直接返回（profile 按当前入参刷新）
        try {
            const alive = await TmuxInvoker.tryInvoke(["has-session", "-t", id]);
            if (alive.exitCode === 0) {
                this.log.info(`会话 [${id}] 已存在于 tmux，复用`);
                const profile: TerminalProfile = { id, driver, target: target ?? "", config, createdAt: Date.now() };
                await this.registry.save(profile);
                return id;
            }
        } catch { /* tmux 不可用——继续走 new-session 由其报错 */ }

        const finalCmd = this.cfg.env_hardening_prefix
            ? `${this.cfg.env_hardening_prefix}; ${launchCmd}`
            : launchCmd;
        this.log.info(`启动持久会话 [${id}] (driver: ${driver})`);
        // -x 220：pane 宽列——输出长行不被 80 列折断（marker 解析/stout 纯净度契约依赖整行）
        await TmuxInvoker.invoke(["new-session", "-d", "-x", "220", "-s", id, finalCmd]);

        const ok = await this.waitForAlive(id, driver);
        if (!ok) {
            await this.registry.remove(id);
            throw new Error(this.diedHint(id, driver, target));
        }
        const profile: TerminalProfile = { id, driver, target: target ?? "", config, createdAt: Date.now() };
        await this.registry.save(profile);
        return id;
    }

    /** 已知 driver 快捷方式渲染（与 RuntimeDescriptor 注释一致） */
    resolveLaunchCmd(driver: string, target: string | undefined, config?: Record<string, unknown>): string {
        const c = config ?? {};
        if (typeof c.launchCmd === "string" && c.launchCmd) return c.launchCmd;
        if (driver === "ssh" && target) {
            const sshOpts = typeof c.sshOptions === "string" ? c.sshOptions : "";
            // sshOptions 白名单（Hydrogen R2 #6）：选项串含命令替换/分号/反引号/换行=拒绝
            if (/[;`$]/.test(sshOpts) || sshOpts.includes("(") || /[\n\r]/.test(sshOpts)) {
                throw new Error(`config.sshOptions 含不安全字符（拒绝执行）: ${sshOpts.slice(0, 60)}`);
            }
            return `ssh ${sshOpts} -t ${shellQuote(target)}`;
        }
        if (driver === "docker" && target) {
            const runtime = typeof c.runtime === "string" ? c.runtime : "docker";
            const shell = typeof c.shell === "string" ? c.shell : "sh";
            // -- 分离（注入深排·四十二期）：target 以 - 开头会被 exec 当选项（k8s 形态
            // 88 行本就有——docker 形态漏）；target 属配置能力面，此处防的是选项歧义
            return `${runtime} exec -i -- ${shellQuote(target)} ${shellQuote(shell)} -i`;
        }
        if (driver === "k8s" && target) {
            const runtime = typeof c.runtime === "string" ? c.runtime : "kubectl";
            const shell = typeof c.shell === "string" ? c.shell : "sh";
            const nsQ = typeof c.namespace === "string" ? `-n ${shellQuote(c.namespace)}` : "";
            return `${runtime} exec -i ${nsQ} ${shellQuote(target)} -- ${shellQuote(shell)} -i`;
        }
        if (driver === "teleport" && target) {
            const cluster = typeof c.cluster === "string" ? `--cluster=${shellQuote(c.cluster)} ` : "";
            const login = typeof c.login === "string" ? `${shellQuote(c.login)}@` : "";
            return `tsh ssh ${cluster}${login}${shellQuote(target)}`;
        }
        if (driver === "local") return "bash";
        throw new Error(
            `Unknown driver '${driver}' and no config.launchCmd provided. ` +
            `Supply config.launchCmd with the full command to enter the environment ` +
            `(e.g. "nix develop", "conda run -n myenv bash", "distrobox enter my-box").`,
        );
    }

    /** 存活轮询（远端 driver 更长 deadline + dead-streak 容忍瞬时抖动） */
    private async waitForAlive(id: string, driver: string): Promise<boolean> {
        const isLocal = driver === "local";
        const maxWaitMs = isLocal ? this.cfg.spawn_max_wait_ms_local : this.cfg.spawn_max_wait_ms_remote;
        const maxDeadStreak = isLocal ? 1 : 3;
        const deadline = Date.now() + maxWaitMs;
        let deadStreak = 0;
        while (Date.now() < deadline) {
            await sleep(this.cfg.spawn_poll_ms);
            let alive: boolean;
            try {
                const r = await TmuxInvoker.tryInvoke(["has-session", "-t", id]);
                alive = r.exitCode === 0;
            } catch {
                return false;
            }
            if (!alive) {
                deadStreak++;
                if (deadStreak >= maxDeadStreak) return false;
                continue;
            }
            deadStreak = 0;
            const paneOut = await TmuxInvoker.tryInvoke(["capture-pane", "-t", id, "-p"]);
            if (paneOut.stdout !== "") return true;
        }
        try {
            const r = await TmuxInvoker.tryInvoke(["has-session", "-t", id]);
            return r.exitCode === 0;
        } catch {
            return false;
        }
    }

    private diedHint(id: string, driver: string, target: string | undefined): string {
        const hint = driver === "docker"
            ? `Make sure the container '${target}' is running ('docker ps'). Use the container name/ID, not the image name.`
            : driver === "ssh"
                ? `Check that '${target}' is reachable and SSH credentials are valid.`
                : driver === "teleport"
                    ? `Check 'tsh status' — a valid Teleport login is required.`
                    : "The shell exited immediately after launch.";
        return `Session '${id}' (driver: ${driver}) died immediately after spawn. ${hint}`;
    }
}
