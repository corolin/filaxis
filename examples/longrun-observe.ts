/**
 * 示例 2：长跑任务观察（本机形态可跑——watcher/thenStop/终态三态）
 *
 * 真实场景见 docs/skills/longrun-observe.md。
 *
 * 运行：bun examples/longrun-observe.ts
 */
import { LocalRuntimeDriver } from "../src/index.js";
import type { SessionEvent } from "../src/index.js";

const drv = new LocalRuntimeDriver();

// 事件订阅（零队列依赖——你的看板/IM 桥从这里接线）
const events: SessionEvent[] = [];
drv.sessions.onEvent = (ev) => events.push(ev);

// ① 长跑任务（模拟训练）：正常进度走 stdout，告警走 stderr
const h = await drv.execSession(
    "for i in 1 2 3; do echo epoch=$i; sleep 0.2; done; echo 'OOM: cuda memory exhausted' 1>&2; sleep 30",
    { name: "train" },
);
console.log("会话启动:", h.sessionId, "logBase:", h.logBase);

// ② watcher：等进度标记（once）；错误模式命中即收摊（thenStop）
drv.watchSession(h.sessionId, { pattern: "epoch=3", once: true });
drv.watchSession(h.sessionId, { pattern: "OOM", once: false, thenStop: true });

// ③ 观察：双流行对象（按流过滤——告警只看 stderr）
await sleep(1200);
const stderrLines = drv.sessions.tailLines(h.sessionId).filter((l) => l.stream === "stderr");
console.log("stderr 告警:", stderrLines.map((l) => l.text));

// ④ 终态：等 exit 事件，拿可信退出码
await new Promise<void>((resolve) => {
    const t = setInterval(() => {
        if (events.some((e) => e.type === "exit")) { clearInterval(t); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(t); resolve(); }, 6000).unref?.();
});
const exit = events.find((e) => e.type === "exit") as Extract<SessionEvent, { type: "exit" }>;
console.log("终态: exitCode =", exit?.exitCode, "（thenStop 命中 OOM 收摊）");
console.log("落盘日志(stdout):", (await drv.readSessionLog(h.sessionId)).split("\n").slice(0, 3).join(" | "));

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
