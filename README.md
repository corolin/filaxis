# 牵丝 Filaxis

**千里一线，执行有迹。—— Connect · Execute · Observe · Reattach**

面向自动化与 Agent 的远程执行运行时 SDK（Syrkos · 漩核旗下）。TypeScript 编写，Bun 与 Node LTS 双运行时，Windows 与 Linux 同构。**CLI / SDK / MCP Server 三入口**（`filaxis` / `createAgentToolkit` / `filaxis-mcp`）共享同一工具词汇表；CI 覆盖（均在 Ubuntu runner）：Bun 侧跑全量测试与 SSH 自环集成，Node 侧跑类型检查、边界检查、构建与编译版 CLI 冒烟（Node 不重复运行完整测试套）。

```ts
import { RuntimeStack } from "@syrkos/filaxis";

const stack = new RuntimeStack();
const host = await stack.connect({ driver: "ssh", target: "my-server" });

// exec：退出码是数据，失败是异常；stdout/stderr 物理分离
const r = await host.exec("uname -a", { timeoutMs: 10_000 });
console.log(r.stdout, r.stderr, r.exitCode, r.effectiveUser);

// 长跑会话：execSession 即返（句柄含 sessionId/logBase/pid）→ 观察 → 停止核实
const cap = await host.execSession("tcpdump -i eth0 -c 100 -w /tmp/x.pcap");
console.log(cap.sessionId, cap.logBase);                       // 句柄字段
console.log((await host.tailSession(cap.sessionId, 10)));      // 热窗口快照（最近 10 行）
const stop = await host.stopSession(cap.sessionId);            // 三态：exited/stopped/unknown
if (stop.status === "unknown") {
    const v = await host.verifySession(cap.sessionId);         // 核实原语（unknown 闭环）
    console.log("实测:", v.status, v.exitCode);                // running / exited(码) / unknown
}

// 事件（零消息队列依赖——消费方自行接队列/看板）
stack.events.on("exit", (e) => console.log("session", e.sessionId, "exit", e.exitCode));
```

## 能力矩阵

「成熟度」列：**内置**=开箱即用且 CI 真机覆盖；**可接入**=经配置/适配层支持（示例或文档指引）；**实验**=有实现但真机覆盖薄，欢迎试用与反馈。

| 能力 | 成熟度 | 说明 |
|---|---|---|
| 多 Transport 统一语义 | 内置（local/ssh）/ 可接入（docker/k8s/teleport） | `local` / `ssh` / `tmux` 内置 + `registerDriver()` 开放注册；docker/k8s/teleport 经 `launchCmd`（如 `"docker exec -it <ctr> bash"`）接入——能力同权，语义契约一致 |
| exec 双通道 | 内置 | 缺省非 PTY 通道（stdout/stderr 物理分离 + **层上下文拼装**：cwd/env/enter 进入管线在独立通道按需重放——`docker exec` 进的容器 exec 也直达）；`channel:"pty"` 继承层内交互状态 |
| 长跑会话生命周期 | 内置 | `execSession` 即返、双文件 `.out/.err` 落盘、热窗口、行级 watcher、**终态三态** `exited/stopped/unknown` + `verifySession` 核实原语 |
| ready() 就绪握手 | 内置 | 回溯匹配热窗口（快输出进程竞态根治）；滚出判定**有据**（evictedCount） |
| 观察流 | 内置 | 独立 SSH channel 真流式直推（无轮询）；ControlMaster 复用；注意力衰减回收 |
| 持久会话 | 内置 | tmux 后端 terminalId 跨进程 re-attach + cwd 恢复 |
| 文件传输 | 内置 | `putFile/getFile` base64 管道分块 + size/sha256 双校验 + **方言适配**（GNU/BSD/busybox——OPNsense/Alpine 不再必错） |
| 受控编辑 | 内置 | `editFile` CAS 原子写回（写入形态/锁保护/校验等级三轴显式报告，见 AGENTS.md 第 8 条） |
| 环境规格 | 内置 | 两段式自发现（语言/GPU/关键包）蒸馏落盘；`matchLayers({needs})` 按需选层；指纹漂移标 stale |
| 连接治理 | 内置 | 连接拓扑指纹复用（同拓扑零重建）；3 次退避自动重连；层状态机与退化哨兵 |
| 安全边界 | 内置 | host key 策略显式（tofu 缺省/strict+known_hosts）；凭据只传路径永不外泄；渲染永不含密钥内容 |

## 安装与运行时

```bash
bun add @syrkos/filaxis    # 或 npm install @syrkos/filaxis
```

- 运行时：Bun ≥1.x / Node LTS（内核统一 `node:` 标准库，零 runtime 专有 API——CI lint 断言）
- npm 依赖：**零**（`dependencies` 为空是 AC 门禁项，见 `bun run check:boundaries`）
- 系统依赖按能力分列（`stack.features()` **探测本机视角**——Agent 在容器里跑 filaxis 时探测的是容器内的 `ssh`/`tmux`/`sftp`，目标主机的能力经 `launchCmd` 层的 shell 自行确认）：`ssh`≥7.3 全功能（`-J`）、`tmux` 仅持久会话（缺席自动降级非持久）、`sftp` 仅传输快路径

## 语义契约要点（使用前必读）

详见包内 [AGENTS.md](./AGENTS.md)——**终止即请求、死亡须核实**（`unknown` 不是失败也不是成功）；退出码非零是数据不是异常；PTY 通道 stderr 混流是终端语义；跨流聚合序为到达序。

## 示例与技能剧本

- [examples/](./examples/)：跨主机诊断 / 长跑观察 / Agent 工具面最小封装（三可运行示例）
- [docs/skills/](./docs/skills/)：场景操作剧本（给人也给 Agent）

## Benchmark（真实运维盲测）

三季同模型盲测（flash 级子代理、跨地域多跳、零提示黑盒、`directBypass = 0`）的完整
A/B/C 对照报告见 [benchmark.md](./benchmark.md)。最新一季（跨海六故障点黑盒）总账：

| 组别 | 方式 | 步数 | 耗时 | 失败/重试 | 总 Token（含 cache） |
|---|---|---:|---:|---:|---:|
| **牵丝 CLI** | `filaxis` + SKILL 速查配方 | **63** | **33m53s** | 9 | **2.89M** |
| 牵丝 MCP | `filaxis-mcp` 原生工具 | 79 | 34m44s | **4** | 4.45M |
| 裸 SSH | 原生 ssh + shell | 93 | 43m26s | 32 | 5.12M |

CLI 组总 Token 省 **43.6%**、失败次数 **1/3.5** 于裸 SSH；MCP 组失败率全场最低
（结构化参数免疫三层引号地狱）。盲测方法论与逐季数据见报告全文。

## 许可

[Apache-2.0](./LICENSE) + [NOTICE](./NOTICE)（牵丝 Filaxis / Syrkos · 漩核 品牌归属声明）。
