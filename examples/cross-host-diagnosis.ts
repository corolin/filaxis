/**
 * 示例 1：跨主机网络诊断（本机形态——零外部依赖可跑）
 *
 * 真实场景见 docs/skills/cross-host-diagnosis.md：把 local 换成
 * `driver:"ssh", target:"防火墙"` 即同一剧本（环境能力先探测再选层）。
 *
 * 运行：bun examples/cross-host-diagnosis.ts
 */
import { RuntimeStack } from "../src/index.js";

const stack = new RuntimeStack();

// 单机版：本机既是「防火墙」又是「源主机」——演示就绪握手竞态的正确处理
const fw = await stack.connect({ driver: "local" });

// ① 抓包任务（此处用慢速计数模拟 tcpdump）：spawn 即返
const cap = await fw.execSession(
    "for i in $(seq 1 20); do echo packet-$i; sleep 0.05; done; echo CAPTURE_DONE",
    { name: "capture" },
);

// ② 就绪握手：等「开始监听」标记——exec 返回 ≠ 已监听，跳过即竞态
await fw.sessions /* ready 在会话句柄上 */;
const ready = await waitForReady(fw, cap.sessionId, "packet-1");
console.log("就绪标记:", ready);

// ③ 探测（退出码是数据）
const probe = await fw.exec("echo probe-ok; exit 0", { timeoutMs: 5000 });
console.log("探测:", probe.stdout.trim(), "exitCode:", probe.exitCode);

// ④ 收尾：等终态 → 读日志 → 拿退出码
await sleep(1500);
const log = await fw.readSessionLog(cap.sessionId);
console.log("抓包日志尾行:", log.split("\n").pop());

/** 最小 ready 轮询（SDK 会话句柄的 ready() 等价演示——回溯窗口+增量） */
async function waitForReady(drv: typeof fw, sessionId: string, marker: string): Promise<string> {
    for (let i = 0; i < 100; i++) {
        const lines = await drv.tailSession(sessionId, 50);
        const hit = lines.find((l) => l.includes(marker));
        if (hit) return hit;
        await sleep(50);
    }
    throw new Error("就绪标记超时");
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
