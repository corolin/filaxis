/**
 * terminal/types.ts — 持久会话子系统共享类型与默认配置
 *
 * 净室平移自 个人Agent项目 `原内部模块`
 * 。OSS 化：ConfigLoader/Zod schema 依赖剥——TerminalConfig
 * 变为注入式选项 + 本文件默认值（内核不绑任何配置装载器）。
 */

/** tmux CLI 单次调用结果（stdout/stderr 严格分离；非零退出码 reject 不吞错） */
export interface TmuxResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export class TmuxError extends Error {
    constructor(
        message: string,
        public readonly args: string[],
        public readonly exitCode: number,
        public readonly stderr: string,
    ) {
        super(message);
        this.name = "TmuxError";
    }
}

/** 交互 Prompt 载荷（持久会话内检测到 Password/Confirm 等等待输入时） */
export interface PromptPayload {
    type: "CONFIRM";
    title: string;
    message: string;
    metadata: { terminalId: string; prompt: string; platform: "terminal" };
}

/** 交互响应者：返回用户回复字符串，null 表示未作答（消费方自行适配 UI/IM） */
export interface PromptResponder {
    ask(payload: PromptPayload): Promise<string | null>;
}

export type OutputStream = "stdout" | "stderr";

/** 持久会话子系统配置（注入式；默认值覆盖源 ConfigLoader schema 语义） */
export interface TerminalConfig {
    /** 前置环境加固前缀（关交互入口——GIT_TERMINAL_PROMPT/SSH_ASKPASS/PAGER） */
    env_hardening_prefix: string;
    spawn_max_wait_ms_local: number;
    spawn_max_wait_ms_remote: number;
    spawn_poll_ms: number;
    command_timeout_ms: number;
    /** 不活动超时（只杀哑不杀慢——有新输出即重置） */
    no_output_timeout_ms: number;
    poll_interval_ms: number;
    capture_scrollback: number;
    buffer_pending_chars: number;
    buffer_aggregated_chars: number;
    buffer_tail_chars: number;
    /** 交互 Prompt 检测模式（多行正则，末尾锚定由 compile 保证） */
    prompt_patterns: string[];
}

export const DEFAULT_TERMINAL_CONFIG: TerminalConfig = {
    env_hardening_prefix: "export GIT_TERMINAL_PROMPT=0 SSH_ASKPASS=/bin/false PAGER=cat",
    spawn_max_wait_ms_local: 5_000,
    spawn_max_wait_ms_remote: 20_000,
    spawn_poll_ms: 200,
    command_timeout_ms: 600_000,
    no_output_timeout_ms: 120_000,
    poll_interval_ms: 500,
    capture_scrollback: 500,
    buffer_pending_chars: 100_000,
    buffer_aggregated_chars: 500_000,
    buffer_tail_chars: 4_000,
    prompt_patterns: [
        "(?:password|passphrase|密码|口令)[^\\n]*[:：]\\s*$",
        "\\(yes\\/no[^)]*\\)\\s*\\??\\s*$",
        "press any key to continue[^\\n]*$",
    ],
};

/** 把 prompt_patterns 源串编译成 OR 正则（末尾锚定 $；i——大小写不敏感）。
 *  不用 m 多行标志（Hydrogen R9 #1）：m 下 $ 匹配每一行行尾——历史输出中段的
 *  `password:` 字样（后面还有正常日志）也会误判等待输入。i 单段尾锚定才是
 *  detectPrompt 注释宣称的「末尾锚定」。空数组返回永不匹配（原 (?:) 匹配任意） */
export function compilePromptPatterns(patterns: string[]): RegExp {
    if (patterns.length === 0) return /$^/; // 永不匹配（非空文本）
    const joined = patterns.length === 1 ? patterns[0]! : `(?:${patterns.join("|")})`;
    return new RegExp(joined, "i");
}
