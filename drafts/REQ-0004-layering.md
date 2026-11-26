# 牵丝 Filaxis 三层架构：interface / middle / core

> 💡 **目标正式版本**: 0.3.0 | **所属业务域**: Syrkos（漩核）基础设施
> **前置依赖**: REQ-0001（执行内核）、REQ-0003（MCP Server）。本文档**修订** REQ-0001 §4.1 的三层表述（把原「② 事件与组合层」明确拆成中层与留在内核里的无状态部分），并先行落地 Host Protocol PRD 的 FEAT-06（双模式同构 API）、AC-01（版本协商）、AC-04（双模式行为一致）的**同语言进程内 / 本机 RPC** 部分；跨语言 IPC 不在本文范围。

---

## 1. 需求背景与商业价值

### 1.1 业务痛点与现状

0.2.x 里同一个操作有三份入口级实现，彼此不通：

1. **Daemon 里 17 个手写 RPC 操作**（exec / batch / forward.* / stream.* / layer.* …），连目标解析、路径解析、错误整形近 500 行，与工具集的 handler 是同一批操作的两个入口。
2. **CLI 一次性模式自己拼驱动**（`savedLayerDriver` / `driverFor` 直接 `new SshPtyDriver`），绕过 `RuntimeStack`。同一个子命令的两条路径有 8 处行为差异（如本地文件路径只在经 Daemon 时解析成绝对路径；相对密钥路径的解析只在一侧做）。
3. **层表、通配、路径解析散在 7 个文件里**，包括本该只有界面逻辑的 `bin/`。

已经造成的事故（2026-11-26）：MCP 不认已存层表而 CLI 认；`filaxis-mcp --layer` 直接报不支持；层通配在 MCP 面只对会话内注册的层生效。这些是靠注入逐个补上的，属于治标。

更要紧的一条：**客户端与 Daemon 之间没有版本握手**。升级后旧 Daemon 还在跑，新 CLI / 新 MCP 的请求由旧代码执行，新功能静默消失。

### 1.2 预期收益与指标 (KPI)

- **定性**：一份操作实现，三种宿主（Daemon 进程、SDK 进程内、CLI 一次性）；界面层只剩参数形式与呈现形式；分层规则由门禁在编译期强制。
- **量化**：同构用例集在三种宿主下同参同果（AC-03）；`bin/` 与适配器对内核零值依赖（AC-02）；Daemon 的 RPC handler 不再含操作逻辑（AC-01）；版本错配 100% 显式报错（AC-04）。

---

## 2. 目标用户与使用场景

- **Agent 作者（MCP / CLI 使用方）**：不关心命令落在哪种宿主上，CLI、MCP、SDK 认同一份层表、同一套参数语义、同一种结果结构。
- **SDK 使用方**：进程内直接调中层操作；需要跨进程共享时连同一个 Daemon，**方法签名不变**。
- **维护者**：新能力只写一次（中层），三个界面自动获得；分层违规在 `bun run check:boundaries` 被拦下。

---

## 3. 三层定义

### 3.1 一句话定义

| 层 | 定义 | 拥有什么 | 不拥有什么 |
|---|---|---|---|
| **core（内核）** | 无状态执行内核：给定一个 driver 与一次调用参数，完成一次执行 | driver 实现、批次内核 `runBatch`、文件传输 / 编辑、转发管理器、观察流与窗口、会话管理器、ssh 底座、方言、终端 | 命名层、默认层、连接复用缓存、会话归属、已存层表；**不知道 daemon / mcp / cli 的存在** |
| **middle（中层）** | 有状态的操作层：唯一的操作实现 | `RuntimeStack`（命名层、默认层、连接指纹复用、转发）、观察窗注册表、会话归属、已存层解析、层引用解析、操作集 | 参数语法（argv / JSON-RPC）、文本呈现、daemon 的 token 与传输 |
| **interface（界面层）** | 中层的适配器：cli、mcp、以及 SDK 里给大模型用的工具面 | 参数语法、调用方本机路径→绝对路径、结果呈现（文本 / JSON / 落盘预览）、Daemon 发现 / 握手 / 传输 / 装配 | 任何操作逻辑 |

### 3.2 宿主模式（中层怎么被托管）

| 宿主 | 生命周期 | 谁用 | 状态 |
|---|---|---|---|
| **daemon 进程** | 常驻，跨进程经本机 RPC | CLI（有 Daemon 在跑时）、MCP（缺省） | 全机共享：层、连接、转发、观察窗、会话 |
| **进程内·长驻** | 随 SDK 使用方进程 | SDK 使用方 | 进程内共享 |
| **进程内·即弃** | 随一次 CLI 调用 / 一个 `--no-daemon` 的 MCP 服务进程 | CLI 一次性模式、`filaxis-mcp --no-daemon` | 仅本次存活 |

三种宿主对界面层呈现同一个接口 `Middle`（§5.1），方法签名一致；远程宿主由同形客户端实现。

### 3.3 依赖方向（门禁强制，§7）

- **R1** core 只依赖 core 与 node 内置。
- **R2** middle 可依赖 core；**不得**依赖任何界面模块（mcp-server、mcp-proxy、daemon-server、daemon-client、agent-toolkit、bin）。
- **R3** interface 只依赖 middle 的公开 API 与自身的呈现 / 传输；**不得从 core 导入值**（`import type` 除外）。
- **R4** **界面层不直接碰内核**：一次性模式也过中层（进程内即弃的实例）。CLI 一次性路径自己拼驱动是今天的反例。
- **R5** 中层不读用户目录：已存层表读取函数由宿主装配时注入（Daemon 与 CLI 的装配点注入 `loadLayerStore`；SDK 使用方可传自己的）。
- **R6** 与调用方机器相关的事只在界面层做：相对路径→绝对路径、输出形式、token 与传输。**线协议里不再有 `clientCwd` / `target.cwd` 这类「调用方工作目录」参数**。

---

## 4. 模块归属

| 层 | 模块 | 备注 |
|---|---|---|
| core | `src/driver.ts` `local-driver.ts` `ssh-pty-driver.ts` `tmux-driver.ts` `terminal/*` `ssh-helpers.ts` `ssh-forward.ts` `ssh-file-stdio.ts` `batch.ts`（内核 `runBatch`）`file-transfer.ts` `file-edit.ts` `file-placement.ts` `layer-file-transfer.ts` `layer-env.ts` `layer-discovery.ts` `dialect.ts` `stream-window.ts` `stream-session-manager.ts` `remote-session-manager.ts` `local-session-manager.ts` `local-observation-process.ts` `session-buffer.ts` `events.ts` `logger.ts` `exec-capture.ts` `vt100-screen.ts` `shell-discovery.ts` `openssh-environment.ts` `windows-upload-acl.ts` `factory.ts` | 物理位置不动（0.3.0 不做内核文件搬迁，避免大面积改动导入路径） |
| middle | `src/operations/` ：`runtime-stack.ts`（自 `src/` 迁入）`layer-store.ts`（迁入）`session-ownership.ts`（迁入）`middle.ts`（`createMiddle` 与操作集）`protocol.ts`（线协议版本）`types.ts`（操作参数 / 结果类型、`LayerRef`） | 新目录 |
| interface | **cli**：`bin/filaxis.ts` ；**mcp**：`bin/filaxis-mcp.ts` `src/mcp-server.ts` `src/mcp-proxy.ts` ；**LLM 工具面**：`src/agent-toolkit.ts`（工具定义 + snake_case 投影 + 旧名兼容） ；**daemon 宿主与传输**：`src/daemon-server.ts` `src/daemon-client.ts` `src/daemon-files.ts` | daemon 进程 = 中层的宿主进程，可同时装载 RPC 端点与 MCP 端点 |

SDK 导出（`src/index.ts`）保持扁平：迁入 `operations/` 的模块改导出路径，符号名不变。

---

## 5. 中层 API

### 5.1 `Middle`

```ts
interface Middle {
  readonly host: { kind: "in-process" | "daemon"; version: string; protocolVersion: number; pid?: number };
  readonly ops: MiddleOps;
  /** 即弃实例与 SDK 实例用：销毁层、driver、观察窗、会话跟踪 */
  dispose(): Promise<void>;
}
createMiddle(opts?: { stack?: RuntimeStack; savedLayers?: () => Record<string, LayerDescriptor>; logger?: FilaxisLogger; … }): Middle
connectRemoteMiddle(client: DaemonClient): Promise<Middle>   // 同形客户端；握手失败即抛 ProtocolMismatchError
```

### 5.2 命名约定

- **中层线协议（RPC 参数 / 结果）、CLI `--json` 输出：统一 camelCase**（即 TypeScript 类型原样）。
- **snake_case 只属于 MCP 工具面**（`run_batch` / `exit_code` / `window_id` …），由工具面适配器投影。0.2.13 里 CLI 转发记录改成 snake_case 是在「两套命名并存」上打的补丁，0.3.0 收敛为上面的规则。
- 批次计划（`BatchPlan`）字段沿用现状（`steps` / `layer` / `stopOnFail` / `maxParallel`；步骤 `command` / `commandFile` / `after` …）；MCP 面继续用 `command_file` / `stop_on_fail`，由工具面转换。

### 5.3 操作集（24 个）

| 组 | 操作 | 语义要点 |
|---|---|---|
| 宿主 | `status` | 宿主信息：协议版本、包版本、层、转发、观察窗清单 |
| | `features` | 内核能力探测（mux / sftp / persistent …） |
| 层 | `connectLayer` | 三种形态：SSH 目标（可批量 `targets`）/ 进入内层（`enter`）/ 临时描述符；批量逐个报告、不整批中断 |
| | `listLayers` `activateLayer` `removeLayer` | 命名层的查 / 设默认 / 移除（`destroy` 才销毁 driver） |
| | `probeLayer` | 两段式环境探测（蒸馏值） |
| 执行 | `runCommand` | 等完成拿退出码；`pty` 走终端通道；非零退出码是数据不是异常 |
| | `runBatch` | 计划校验、层通配展开、`commandFile` 内联都在中层做完，再交内核 |
| | `startSession` `stopSession` | 长跑会话；停止是请求、死亡须核实，`unknown` 不是成功也不是失败 |
| | `observe` | 限时观察（起会话 → 等 `durationMs` → 读日志 → 停 → 必要时核实） |
| 文件 | `readFile` `readPath` `writeFile` | 读文本 / 读文件或列目录 / 写入（`overwrite`、`createDirs`） |
| | `editFile` `editFileMulti` | 受控编辑（CAS）；多 hunk 版 |
| | `managePath` | `mkdir` / `move` / `delete` |
| | `transferFile` | `put` / `get`，`transport`、`writeMode`，校验等级如实报告 |
| 观察窗 | `openStream` `peekStream` `closeStream` `listStreams` | 开窗、三种游标读（`afterSeq` / `beforeSeq` / 末尾）、关窗、清单 |
| 转发 | `openForward` `listForwards` `closeForward` | `-L` / `-R` / `-D`；缺省只列在用；关闭三态 |

### 5.4 层引用 `LayerRef`

```ts
type LayerRef =
  | { layer: string }                               // 命名层：已注册，或在已存层表里（按需加载，不抢默认层）
  | { descriptor: LayerDescriptor; name?: string }  // 临时目标（CLI --host 族、connect_layer 的参数）；给 name 则登记为命名层
  | undefined;                                      // 默认层
```

中层唯一负责把 `LayerRef` 解析成 driver（今天工具集的 `resolveDrv` 与 Daemon 的 `resolveTarget` 合并为此）。同名并发只建一次；配置与既有命名层不一致且该层有活跃转发 / 观察窗时拒绝覆盖（沿用 Daemon 现状）。

### 5.5 与调用方机器相关的规则

| 事项 | 规则 |
|---|---|
| 本机文件路径（传输的 `localPath`、`commandFile`） | 界面层解析成绝对路径后再调用 |
| **本机层**上的相对路径（`filaxis exec cat x.txt` 这种落在 local 层的路径） | 界面层解析成绝对路径（它知道目标是不是本机层）。经 Daemon 时工作目录与 Daemon 进程无关 |
| 本机层的命令工作目录 | 显式参数 `cwd`（绝对路径） |
| SSH 密钥 / known_hosts 路径 | 界面层展开 `~` 与相对路径后再调用 |
| 大输出 | `exec --out` / `batch --out-dir` 落盘是界面层的事，中层不感知 |

---

## 6. Daemon 线协议与版本握手

### 6.1 信封

```
POST /rpc   { "protocol": 3, "op": "runCommand", "params": { … } }
        → 200 { "ok": true,  "protocol": 3, "result": … }
        → 200 { "ok": false, "error": { "message", "name?", "code?", "outcome?", … } }   // 操作失败/结果未知：沿用 HTTP 200 + 错误体
        → 400 / 413                                                                  // 仅请求体本身有问题
GET /status  含 protocolVersion、version、pid
```

- 操作名 = 中层操作名（camelCase）；不再有 `exec` / `forward.add` / `stream.peek` 这套独立命名。
- 传输仍是本机回环 HTTP + Bearer token + SSE（MCP 端点），**0.3.0 不换传输**。
- 错误体保留 `outcome` / `code` / `sessionId` / `logBase` / `forwardId` 等字段（执行语义宪法不变：结果未知不伪造终态、不自动重放）。

### 6.2 版本握手

- `PROTOCOL_VERSION`（`src/operations/protocol.ts`）是线协议版本，与包版本分离；不兼容的线协议变更才递增。
- **客户端**：连上先取 `/status`，`protocolVersion` 不等于自己的（或缺失——那是 0.2.x 的 Daemon）即抛 `ProtocolMismatchError`，报双方版本、Daemon pid 与处置办法（`filaxis daemon stop` 后重启）。**绝不向错配的 Daemon 发操作。**
- **服务端**：信封 `protocol` 不等于自己的即拒绝（错误码 `E_PROTOCOL_MISMATCH`），不执行。
- 0.2.x 客户端 × 0.3 Daemon：旧客户端不带 `protocol` 字段 → 被拒并看到上面的错误（而不是被旧逻辑静默执行）。

### 6.3 Daemon 启动策略

| 入口 | 缺省 | 退出方式 |
|---|---|---|
| `filaxis-mcp` | **经 Daemon**：没有在跑就自动启动（复用 `filaxis daemon start` 的同一条拉起路径） | `--no-daemon` / `FILAXIS_NO_DAEMON=1` → 进程内即弃中层（状态只属于这个 MCP 服务进程） |
| CLI | 有 Daemon 在跑就用，没有就走进程内即弃中层；**不隐式启动**（脚本里的一次性命令不该留下后台进程） | `filaxis daemon start` / `stop` 显式管理 |
| SDK | 进程内 | `connectRemoteMiddle` 连 Daemon |

CLI 的转发与观察窗子命令需要常驻宿主（进程一退状态就没了）：没有 Daemon 时明确报错，与现状一致。

---

## 7. 分层门禁（`scripts/check-boundaries.ts` 新增断言）

按 §4 的归属把文件标成 core / middle / interface，逐条 import 断言：

1. core 文件 import middle 或 interface 模块 → 违规。
2. middle 文件 import interface 模块 → 违规。
3. interface 文件与 `bin/` 从 core 模块做**值导入** → 违规（`import type` 放行）。

原有三条（零上游业务概念 / 零裸 `Bun.*` / 零第三方运行时依赖）不变。

---

## 8. 有意变更清单（0.3.0）

1. Daemon 线协议：操作名改为中层操作名，信封带 `protocol`；旧客户端与新 Daemon 互相显式拒绝。
2. `filaxis-mcp` 缺省经 Daemon 并自动启动（推翻 0.2.x「MCP 绝不隐式启动 Daemon」的设计与用例）。
3. CLI `--json` 输出统一 camelCase（转发记录从 0.2.13 的 snake_case 改回；观察窗同理）。
4. Daemon 线协议移除 `clientCwd` / `target.cwd`；本机层的相对路径由 CLI 解析。**效果**：一次性模式与经 Daemon 的行为一致（相对的本地文件路径、相对的密钥路径在两种模式下不再有差别）。
5. SDK：`createAgentToolkit` 的 handler 不再含操作逻辑（薄适配），`AgentToolkitOptions` 增加 `middle`（传入已建好的中层；原 `stack` 形态保留，内部代建中层）；新增导出 `createMiddle` `connectRemoteMiddle` `Middle` `MiddleOps` `PROTOCOL_VERSION`。
6. `src/runtime-stack.ts`、`layer-store.ts`、`session-ownership.ts` 迁入 `src/operations/`（SDK 导出路径不变）。

**非目标**：跨语言 IPC（Host Protocol PRD 后续）；内核文件物理搬迁；更换传输层；改动执行语义宪法（完成哨兵 / abort≠已取消 / 零自动重放 / PTY 状态机）。

---

## 9. 迁移步骤（每步独立提交，既有测试保持通过）

| 步 | 内容 | 完成标志 |
|---|---|---|
| **M0** | 版本握手：`PROTOCOL_VERSION`、`/status` 带 `protocolVersion`、新客户端遇旧 Daemon 明确拒绝 | 新 CLI 对 0.2.13 Daemon 报错不执行；单测 |
| **M1** | 中层成型：建 `src/operations/`，迁入三个模块；`createMiddle` 与操作集从 `agent-toolkit.ts` 的 handler 里提出来；工具集变成「工具定义 + 投影 + 薄转发」；`createAgentToolkit(stack, opts)` 签名不变 | 工具集 / MCP 测试零改动通过；typecheck |
| **M2** | Daemon RPC 改为中层的薄转发：`DaemonServer` 装配一个 `Middle`，`/rpc` 变成操作表；信封带 `protocol` 并拒绝错配；`connectRemoteMiddle` 同形客户端 | daemon / mcp-proxy 测试改用同形客户端后通过 |
| **M3** | CLI 全面改走 `Middle`（远程或即弃）：删掉 `savedLayerDriver` / `driverFor` 等自己拼驱动的代码；路径解析收口到界面层；CLI JSON 统一 camelCase | CLI 冒烟测试通过；§1.1 列的 8 处差异消失 |
| **M4** | `filaxis-mcp` 缺省经 Daemon（自动启动），`--no-daemon` 进程内 | 「绝不隐式启动」用例改写为新设计 |
| **M5** | 门禁：§7 三条断言 | `bun run check:boundaries` 能拦下故意制造的三类违规（测试钉住） |
| **M6** | 同构用例集：同一组操作用例在 即弃进程内 / SDK 长驻 / Daemon 远程 三种宿主下跑 | AC-03 |
| **M7** | 文档（SKILL、包说明书 AGENTS.md、CHANGELOG 0.3.0）、全量回归、真机三环境复验 | AC-06 |

---

## 10. 验收标准清单 (Acceptance Criteria / AC Matrix)

- [ ] **AC-01 一份操作实现**：Daemon 的 `/rpc` 处理只有「取操作 → 调用 → 回结果」，不含校验、目标解析、路径解析或结果整形；操作逻辑只存在于 `src/operations/`。
- [ ] **AC-02 界面层零内核值依赖**：`bin/` 与适配器模块对 core 模块没有任何值导入（门禁断言 + 测试）。
- [ ] **AC-03 同构**：同一组操作用例（至少覆盖 `runCommand`、`runBatch`（含层通配与 `commandFile`）、`readFile`、`transferFile`、`startSession`/`stopSession`、`openStream`/`peekStream`/`closeStream`、`connectLayer`/`listLayers`/`removeLayer`）在 即弃进程内、SDK 长驻、Daemon 远程 三种宿主下结果一致。
- [ ] **AC-04 版本握手**：新客户端 × 旧 Daemon（`protocolVersion` 缺失）→ 拒绝并报双方版本与 pid，不发出任何操作；旧客户端 × 新 Daemon（信封无 `protocol`）→ 被拒不执行；版本一致 → 正常。
- [ ] **AC-05 MCP 宿主策略**：`filaxis-mcp` 无 Daemon 时自动启动并经其执行；`--no-daemon` 不启动且功能可用；两种模式下 `run_batch` 层通配、按名寻址已存层、转发、观察窗行为一致。
- [ ] **AC-06 零回归**：除 §8 有意变更对应的用例外，既有测试全部通过；Windows 与 Linux（真机集成打开）两平台全量 0 失败；homelab / 腾讯云集群 / 多跳管线三组真实环境复验通过。
- [ ] **AC-07 分层门禁**：三类违规各有一条测试证明会被 `check:boundaries` 拦下；现有代码零违规。
- [ ] **AC-08 文档**：REQ-0004 状态更新；SKILL 与包说明书按新宿主策略与 JSON 约定修订；CHANGELOG 列出 §8 全部有意变更。
