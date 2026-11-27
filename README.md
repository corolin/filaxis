# 牵丝 Filaxis

[![CI](https://github.com/corolin/filaxis/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/corolin/filaxis/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@syrkos/filaxis)](https://www.npmjs.com/package/@syrkos/filaxis)
[![License: Apache-2.0](https://img.shields.io/github/license/corolin/filaxis)](https://github.com/corolin/filaxis/blob/main/LICENSE)
[![Glama MCP Server](https://glama.ai/mcp/servers/corolin/filaxis/badges/score.svg)](https://glama.ai/mcp/servers/corolin/filaxis)
[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/corolin/filaxis)

简体中文 · [English](https://github.com/corolin/filaxis/blob/main/README.en.md)

**为 AI Agent 构建的无屏幕多屏运维工作台。**\
**千里一线，执行有迹。—— Connect · Execute · Observe · Reattach**

面向自动化与 Agent 的远程执行运行时（Syrkos · 漩核旗下）。TypeScript 编写，零第三方运行时依赖，Bun 与 Node LTS 双运行时，Windows 与 Linux 同构。**CLI / MCP Server / SDK 三种宿主**（`filaxis` / `filaxis-mcp` / `createMiddle` · `RuntimeStack` · `createAgentToolkit`）共用中层操作。MCP 缺省经本机 Daemon 运行，CLI 可复用已运行的 Daemon，SDK 可用 `connectRemoteMiddle` 接入共享工作空间。

## 为什么给 AI 配一套「屏幕」？

> 人类运维工程师拥有多个终端窗口、多块屏幕，以及持续存在的工作空间。
>
> 为什么普通 AI Agent 每执行一条远程命令，都要重新描述一遍自己如何 `ssh -> ssh -> docker exec` 抵达那个环境？
>
> **为什么不给 AI 也配一套可以切屏的工作台？**

Filaxis 的出发点不是重新发明 SSH，而是把人类运维工程师习以为常的多窗口工作环境，抽象成 Agent 可以寻址、切换、持续观察的运行时上下文（这里的「屏幕」不是物理显示器，而是持续存活、按需读取的执行上下文）：

- **人类运维工程师**：人 + 多块屏幕 + N 个常驻终端窗口 —— 命名标签页、`Alt + Tab` 切屏操作、副屏挂着 `tail -f` 按需扫一眼。
- **普通 Agent**：没有工作台，每次调用都从零拼装 `ssh -> ssh -> ...`，多跳引号层层转义；一旦直接跑 `tail -f` 就卡死工具调用或把输出灌满上下文。
- **牵丝 Filaxis**：给 Agent 配齐命名层（虚拟终端窗口）、滚动观察窗（虚拟副屏）与本机 Daemon（常驻工作台），建连一次即可跨轮次、跨宿主按名切屏操作。

| 人类的运维工作台 | 牵丝 Filaxis（MCP / CLI / SDK） |
|---|---|
| 打开 SSH 客户端（含跳板或批量连多机） | `connect_layer` / `filaxis layer save` / `stack.addLayer` |
| 从宿主机进入容器或内网二次跳转 | `connect_layer(enter_cmd)` / `--enter` / `stack.layerInto` |
| 给终端窗口命名 | 命名层（Named Layer） |
| 查看当前打开了哪些窗口 | `manage_layers(list)` / `filaxis layer list` |
| `Alt + Tab` 切换当前操作窗口 | 指定 `layer` 执行，或 `manage_layers(activate)` 切换默认层 |
| 敲完一条命令不关掉整个终端工作台 | **本机 Daemon**（跨 CLI 与多 MCP 客户端维持层、连接、转发与观察窗） |
| 副屏开着 `tail -f` 持续盯日志 | **持续观察窗**（`observe_stream` / `filaxis stream open`） |
| 回看终端历史输出 | **本地滚动窗口缓冲 + 游标续读**（完整历史查已有落盘日志） |
| 多块屏幕并行观察、批量下发操作 | 多层独立观察窗 + `run_batch` / `filaxis batch`（支持 `"web-*"` 通配扇出） |
| 打通本地到远端内层的调试隧道 | 动态端口转发（`manage_layers(forward_add)` / `filaxis forward add`） |
| 关闭不再需要的终端窗口 | `manage_layers(remove)` / `close_stream` |

这套模型还同时解决了 Agent 运维的两个核心矛盾：

1. **人类不会每敲完一条命令，就关闭整个终端工作台再重新打开所有窗口。** Daemon 承担的正是维持工作空间生命周期的职责——`0.3.0` 起 `filaxis-mcp` 缺省经本机 Daemon 执行（未运行则自动拉起），多个 MCP 客户端与 CLI 共享同一份层、SSH 连接、端口转发和观察窗。
2. **屏幕一直存在，不代表人类一直盯着屏幕；观察窗一直运行，也不代表 Agent 必须持续消耗 Token。** Agent 不受物理屏幕面积与视觉注意力限制，可同时挂载数十个环境的观察窗。远端流进入本地滚动缓冲，Agent 只在需要时按游标 `peek` 读取增量或检索异常。

## 快速上手（SDK）

```ts
import { RuntimeStack } from "@syrkos/filaxis";

const stack = new RuntimeStack();
const host = await stack.connect({ driver: "ssh", target: "my-server" });

// exec：退出码是数据，无法执行才抛异常；stdout/stderr 物理分离
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

含命名层、容器内层穿透（`layerInto`）、CAS 受控编辑、跨层 `runBatch` 与 `createAgentToolkit` 的完整编码配方见 [docs/skills/SKILL.md](docs/skills/SKILL.md)。

## 能力矩阵

「成熟度」列：**内置**=开箱即用且 CI 真机覆盖；**可接入**=经配置/适配层支持（示例或文档指引）。

| 能力 | 成熟度 | 说明 |
|---|---|---|
| 多层环境统一语义 | 内置（local/ssh/tmux）/ 可接入（docker/k8s/teleport） | `local` / `ssh` / `tmux` 内置 + `registerDriver()` 开放注册；docker/k8s/teleport 经进入管线（如 `"docker exec -i <ctr> sh"`）派生命名内层——能力同权，语义契约一致 |
| 共享工作台（Daemon）与同构中层 | 内置 | `interface / middle / core` 三层架构：CLI、MCP、SDK（`createMiddle` / `connectRemoteMiddle`）共用同一组 26 个中层操作；经 Daemon 跨进程共享层、连接、转发与观察窗，带线协议版本握手 |
| exec 双通道 | 内置 | 缺省非 PTY 通道（stdout/stderr 物理分离 + **层上下文拼装**：cwd/env/enter 进入管线在独立通道按需重放——`docker exec` 进的容器 exec 也直达）；`channel:"pty"` 继承层内交互状态 |
| 跨层并行批次 | 内置 | `runBatch` / `run_batch` / `filaxis batch` 支持多层数组与 `*` / `?` 通配扇出、`after` 依赖编排、巡检 `stopOnFail: false`，以及 CLI 批次输出落盘（`--out-dir`） |
| 长跑会话生命周期 | 内置 | `execSession` 即返、双文件 `.out/.err` 落盘、热窗口、`ready()` 回溯就绪握手（`evictedCount` 滚出有据）、行级 watcher。停止结果为 `exited/stopped/unknown`，可用 `verifySession` 核实会话状态 |
| 观察流与滚动观察窗 | 内置 | 独立 SSH channel 真流式直推（ControlMaster 复用）；本地反转为推模式滚动窗（单调递增帧号、非破坏游标续读、多消费者互不干扰、关窗自动收割流进程） |
| 持久会话与动态转发 | 内置 | tmux 后端 `terminalId` 跨进程 re-attach + cwd 恢复；SSH 本地 `-L`、远端 `-R`、SOCKS 动态端口转发（支持经可重放进入管线穿透内层） |
| 文件传输与受控编辑 | 内置 | `putFile/getFile`（及 SFTP 快路径）size/sha256 校验 + **方言适配**（GNU/BSD/busybox）；`editFile` 用 Compare-and-Swap（CAS）写前核对版本，分别报告锁保护与写入方式（见 AGENTS.md 第 8 条） |
| 环境规格与连接治理 | 内置 | 两段式自发现（语言/GPU/关键包）+ `matchLayers({needs})` 按需选层 + 指纹漂移标 stale；连接拓扑指纹复用、退避重连与退化哨兵 |
| 安全边界 | 内置 | host key 策略显式（tofu 缺省/strict+known_hosts）；凭据只传路径永不外泄；渲染永不含密钥内容 |

## 安装与运行时

```bash
bun add @syrkos/filaxis    # 或 npm install @syrkos/filaxis
```

- 运行时：Bun ≥1.x / Node LTS（内核统一 `node:` 标准库，零 runtime 专有 API——CI 门禁断言；CI 在 Ubuntu 上覆盖 Bun 全量测试 + SSH 自环集成，以及 Node LTS 类型检查、分层边界门禁、构建与 CLI 冒烟）
- npm 依赖：**零**（`dependencies` 为空是门禁项，见 `bun run check:boundaries`）
- 系统依赖按能力分列（`stack.features()` **探测本机视角**——Agent 在容器里跑 filaxis 时探测的是容器内的 `ssh`/`tmux`/`sftp`，目标主机的能力经目标层自行确认）：`ssh`≥7.3 全功能（`-J`）、`tmux` 仅持久会话（缺席自动降级非持久）、`sftp` 仅传输快路径

## MCP 配置与 Agent Skill

```bash
npm i -g @syrkos/filaxis
filaxis mcp-config                # JSON，使用 mcpServers
filaxis mcp-config --format toml  # TOML，使用 mcp_servers（Codex）
```

命令把 MCP 配置片段写到标准输出，包含当前运行时和 `filaxis-mcp` 入口的绝对路径。Agent 根据自身平台和所需作用域选择配置位置，再将片段合并到现有配置。

也可直接在 MCP 客户端配置中通过 `npx` 启动：

```json
{
  "mcpServers": {
    "filaxis": {
      "command": "npx",
      "args": ["-y", "-p", "@syrkos/filaxis", "filaxis-mcp"]
    }
  }
}
```

`0.3.0` 起，`filaxis-mcp` 缺省经本机 Daemon 执行（未运行则自动启动），使多个 MCP 客户端之间、CLI 与 MCP 之间共享同一套层、连接、端口转发与观察窗；若带 `--host` / `--enter` / `--docker` / `--layer` 绑定参数或显式传 `--no-daemon`，则在本进程内独立运行。跨版本升级后若旧 Daemon 仍在跑，线协议握手会显式拒绝，先执行 `filaxis daemon stop` 再发起命令即可（详见 [0.3.0 升级要点](docs/skills/SKILL.md)）。

暴露的 12 个 MCP 工具速览：

- **命令与批处理**：`run_command`、`run_batch`
- **长跑会话与观察窗**：`start_session`、`stop_session`、`observe_stream`、`close_stream`
- **文件与路径管理**：`read_path`、`edit_file`、`manage_path`、`transfer_file`
- **多层连接管理**：`connect_layer`、`manage_layers`

npm 包包含 [Skill 入口与四份子剧本](docs/skills/SKILL.md)，以及配套的 [AGENTS.md](AGENTS.md)。需要登记 Skill 时，由 Agent 按自身平台的规则处理这些文件。

## CLI 文件传输

```bash
filaxis put --layer app -- ./config.yaml /app/config.yaml
filaxis get --host user@host --transport sftp -- /var/tmp/result.bin ./result.bin
```

`put/get` 传输单个文件，支持 `--layer` 和 `--host`。默认用层的 exec 通道，可进入容器。SSH 目标的文件系统可直接访问时，可显式选择 `--transport sftp`，包括经 `-J` 跳板的连接。两条路径都先校验暂存文件再落位，JSON 结果标明校验等级和写入形态。详见 [文件同步剧本](docs/skills/file-sync.md)。

MCP 对应工具是 `transfer_file`（传 `direction: "put" | "get"`）。`local_path` 位于 MCP 服务所在机器，`remote_path` 位于目标层。可用 `layer` 选择命名层。

## 已验证的平台与连接方式

| 操作系统 | 连接方式 | 验证范围 |
|---|---|---|
| Windows | 本地执行（Git Bash） | 本地命令、长跑会话、观察窗、Windows Job 子进程回收 |
| Ubuntu Linux | 本地执行（WSL）、本地 tmux、CI SSH 回环 | 本地会话与观察窗、tmux 持久会话重挂与停止、SSH 集成测试。tmux 的 watcher 接管尚未实现 |
| Debian GNU/Linux | SSH 直连 | 非交互 exec、交互 PTY、持续观察窗、重连后接管会话与 watcher、核实停止、文件操作 |
| Debian GNU/Linux | SSH 单跳（`ProxyJump` / `-J`） | 非交互 exec、stdout 与 stderr 分离 |
| Alpine Linux | SSH 到 Linux 宿主后经 `docker exec` 进入容器 | 容器内非交互执行与受控文件编辑 |
| OPNsense（FreeBSD） | SSH 直连（非交互 exec） | 命令执行、目录读取、文件写入与覆盖时保留权限。默认交互登录进入设备菜单，PTY 握手在该配置下不可用 |

### SSH 文件中转模式

运行环境限制匿名管道时，可在启动 CLI 或 MCP 服务前设置 `FILAXIS_SSH_STDIO_MODE=inherit`。使用 SDK 时，在建立 SSH 层前设置。该模式通过临时文件为 SSH 提供标准输入和双流输出。命名层使用非交互探测核实目标和工作目录，后续执行仍以完成哨兵确认退出码。

Windows 上，Filaxis 启动 OpenSSH 子进程时会补齐缺失的系统和账户环境变量，包括 `SystemRoot`、`windir`、`ProgramData` 和 `USERNAME`。已有值优先，补全只作用于子进程。成功补齐 `SystemRoot` 时，CLI 和 MCP 会在 stderr 告警一次，SDK 通过注入的 logger 记录。主机剥离这些变量和主机限制匿名管道是两类独立问题。

支持免交互认证的直连、单跳 `connParams.jump`（CLI `-J`）及可非交互重放的进入步骤。逐跳 PTY 登录链、交互式进入、持久端口转发和持续观察窗需要可用的匿名管道。会话日志可用 `readSessionLog` 读取落盘内容。

SSH 秒退 255 且双流为空只能作为排障线索。执行终态未知时，先核实远端状态再决定是否重发。

## 语义契约要点（使用前必读）

详见包内 [AGENTS.md](./AGENTS.md)——**终止即请求、死亡须核实**（`unknown` 不是失败也不是成功）；退出码非零是数据不是异常；PTY 通道 stderr 混流是终端语义；跨流聚合序为到达序。

## 示例与技能剧本

- [examples/](./examples/)：跨主机诊断 / 长跑观察 / Agent 工具面最小封装（三可运行示例）
- [docs/skills/](./docs/skills/)：场景操作剧本（给人也给 Agent）

## Benchmark（真实运维对照评测）

四期受控实战评测（涵盖 `v0.1.0` ~ `v0.2.5`，内网与跨地域多跳、明盒与纯黑盒场景；每期内采用同模型对照，跨期因版本、考题与模型档位不同不可直接横向等同）的完整数据、方法论与局限说明见 [benchmark.md](https://github.com/corolin/filaxis/blob/main/benchmark.md)。

最新一期（第四份：`v0.2.5` 跨地域无 `ProxyJump` 真实堡垒机、**0 提示纯黑盒 9 处联动故障** + 跨海 `PUT`/`GET` 二进制文件传输，`Gemini 4 Hydrogen` 轻量档位子代理，四组均 100% 达标）总账：

| 组别 | 方式 | 轮数 | 耗时 | 报错/摩擦 | 全量活跃 Token (`in+out`) | 纯实战活跃 Token *(去文档预读)* | 总吞吐 Token *(含 cache)* |
|---|---|---:|---:|---:|---:|---:|---:|
| **牵丝 MCP** | `filaxis-mcp` 原生工具 | **14** | **225s** *(3m45s)* | **0** | **81,297** | **50,362** | **561,736** |
| 牵丝 SDK | `@syrkos/filaxis` TS 编排 | 18 | 273s *(4m33s)* | **0** | 104,563 | 67,823 | 890,017 |
| 牵丝 CLI | `filaxis` + `SKILL.md` | 22 | 368s *(6m08s)* | 3 | 106,587 | 79,535 | 1,051,857 |
| 裸 SSH | 原生 `ssh` / `scp` + shell | 24 | 483s *(8m03s)* | 4 | 107,151 | 86,917 | 999,825 |

在跨地域无 `-J` 纯黑盒排障场景下，牵丝 MCP 组达成 **0 报错**、墙钟耗时缩短 **53.4%**、全量活跃 Token 省 **24.1%**（剥离文档预读的纯实战活跃 Token 省 **42.1%**、总吞吐省 **43.8%**）。需要说明的是：上述结果为单次实战采样（非多随机种子统计），且在路径明确的简单局域网任务中裸 SSH 与牵丝差距较小（见报告第一份测试二）；牵丝的效率与稳定性优势主要集中在**无路径提示、多跳穿透与多故障联动排障**场景。

## 许可

[Apache-2.0](./LICENSE) + [NOTICE](./NOTICE)（牵丝 Filaxis / Syrkos · 漩核 品牌归属声明）。
