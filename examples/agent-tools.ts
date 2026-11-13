/**
 * 示例 3：Agent 工具面最小封装（把 Filaxis 包成 LLM 可调用的工具集）
 *
 * 形态：本地执行 + 就绪握手 + 终态三态——SSH/容器层换 descriptor 即同一封装。
 * 真实场景见 docs/skills/*.md。
 *
 * 运行：bun examples/agent-tools.ts
 */
import { RuntimeStack } from "../src/index.js";
import type { ExecResult } from "../src/index.js";

/** 工具描述（喂给 LLM 的 schema 由你的框架生成——这里演示语义边界） */
const tools = {
    run_command: {
        description: "执行一次性命令。返回 stdout/stderr/exitCode（非零不抛错——退出码是数据）",
        handler: async (cmd: string): Promise<ExecResult> => {
            const layer = await stack.connect({ driver: "local" });
            return layer.exec(cmd, { timeoutMs: 30_000 });
        },
    },
    spawn_and_observe: {
        description: "启动长跑任务并注册观察（ready 标记 + 错误模式）。返回 sessionId 与首窗口",
        handler: async (cmd: string, readyMarker: string, errorPattern?: string) => {
            const layer = await stack.connect({ driver: "local" });
            const h = await layer.execSession(cmd, { name: "agent-task" });
            // 就绪握手（回溯+增量——快输出进程不漏）
            await new Promise<void>((resolve, reject) => {
                const t0 = Date.now();
                const poll = setInterval(async () => {
                    const lines = await layer.tailSession(h.sessionId, 50);
                    if (lines.some((l) => l.includes(readyMarker))) {
                        clearInterval(poll); resolve();
                    } else if (Date.now() - t0 > 15_000) {
                        clearInterval(poll);
                        await layer.stopSession(h.sessionId).catch(() => undefined); // 超时自动清理
                        reject(new Error("ready 超时（已自动停止）"));
                    }
                }, 100);
            });
            if (errorPattern) {
                layer.watchSession(h.sessionId, { pattern: errorPattern, once: false, thenStop: true });
            }
            return { sessionId: h.sessionId, tail: await layer.tailSession(h.sessionId, 5) };
        },
    },
    stop_and_verify: {
        description: "停止任务并核实终态（unknown=核实不可达，非成功非失败——需重试或上报）",
        handler: async (sessionId: string) => {
            const layer = await stack.connect({ driver: "local" });
            const r = await layer.stopSession(sessionId) as { status: string; exitCode?: number | null };
            return r.status === "exited"
                ? { status: "exited", exitCode: r.exitCode }
                : r.status === "stopped"
                    ? { status: "stopped", hint: "终止已核实路径（SIGKILL 升级在场）" }
                    : { status: "unknown", hint: "重连后核实进程是否真死" };
        },
    },
};

const stack = new RuntimeStack();

// 演示三工具联动
const r = await tools.run_command.handler("echo tool-ok; exit 3");
console.log("run_command:", r.stdout.trim(), "exitCode:", r.exitCode, "user:", r.effectiveUser);

const obs = await tools.spawn_and_observe.handler(
    "echo READY; for i in 1 2 3; do echo tick-$i; sleep 0.1; done; sleep 20",
    "READY",
    "NEVER_MATCH",
);
console.log("spawn_and_observe:", obs.sessionId, "首窗口:", obs.tail.join(","));

const stop = await tools.stop_and_verify.handler(obs.sessionId);
console.log("stop_and_verify:", stop.status);
