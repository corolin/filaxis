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

牵丝给 Agent 提供可切换的输入与输出通道。层决定输入发往哪里，驱动按所选通道提交指令，界面回传目标实际写出的内容。`echo`、`print` 等产生的输出按通道回传，静默命令可以没有输出。输出预览和观察窗有各自的采集范围。`exec` 通道的退出码以完成哨兵为凭，PTY 保留终端的混流语义。断线或中止后，终态无法核实就报告 `outcome: "unknown"`，执行层零自动重放。

目标环境负责命令及其后续行为。命令取消沿所选通道传递，覆盖范围取决于 shell、SSH 和操作系统实际提供的能力。牵丝持有的连接、观察窗、转发和显式会话按各自生命周期管理。显式停止会话时，`exited` 需要任务的可信退出码，`stopped` 需要确认停止，证据不足时为 `unknown`。

---

## 3. 三层定义

### 3.1 一句话定义

| 层 | 定义 | 拥有什么 | 不拥有什么 |
|---|---|---|---|
| **core（内核）** | 执行和通道原语：根据调用参数驱动所选环境 | driver 实现及其通道状态、批次内核 `runBatch`、文件传输 / 编辑、转发管理器、观察流与窗口、会话管理器、ssh 底座、方言、终端 | 命名层、默认层、连接复用缓存、会话归属、已存层表；**不知道 daemon / mcp / cli 的存在** |
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

- **R1** core 依赖 core、shared 和 Node 内置模块。
- **R2** middle 可依赖 core；**不得**依赖任何界面模块（mcp-server、mcp-proxy、daemon-server、daemon-client、agent-toolkit、bin）。
- **R3** interface 只依赖 middle 的公开 API 与自身的呈现 / 传输；**不得从 core 导入值**（`import type` 除外）。
- **R4** **界面层不直接碰内核**：一次性模式也过中层（进程内即弃的实例）。CLI 一次性路径自己拼驱动是今天的反例。
- **R5** 中层不读用户目录：已存层表读取函数由宿主装配时注入（Daemon 与 CLI 的装配点注入 `loadLayerStore`；SDK 使用方可传自己的）。
- **R6** 与调用方机器相关的事只在界面层做：相对路径→绝对路径、输出形式、token 与传输。**线协议里不再有 `clientCwd` / `target.cwd` 这类「调用方工作目录」参数**。

---

## 4. 模块归属

目录就是分层——`src/` 根下只有总出口和四个层目录，门禁按目录判层（§7）：

```
src/
├── index.ts          SDK 总出口（公开 API；包外只从这里导入）
├── shared/           各层共用，不含任何一层的知识：logger、async-guard
├── core/             执行和通道原语，按关注点分七组
│   ├── base/         driver 契约、工厂、事件、会话类型与缓冲、输出采集、方言、shell 与 OpenSSH 环境发现
│   ├── ssh/          ssh 驱动与底座、文件 stdio 中转、远端会话、动态端口转发
│   ├── local/        本机驱动、本机会话、本机观察进程
│   ├── stream/       观察流会话、滚动窗口、VT100 屏幕
│   ├── tmux/         tmux 驱动、终端管理器、terminal/
│   ├── file/         批次内核 runBatch、文件传输 / 受控编辑 / 落位、Windows 上传 ACL
│   └── probe/        层环境规格与自发现
├── middle/           有状态的操作层：middle（createMiddle 与 26 个操作）、runtime-stack、
│                     layer-store、session-ownership、protocol、types
└── interface/        界面层
    ├── mcp/          mcp-server、mcp-proxy、agent-toolkit（LLM 工具面：工具定义 + snake_case 投影）
    └── daemon/       daemon-server、daemon-client、daemon-files（中层的常驻宿主与线协议客户端）

bin/                  入口脚本（界面层）：filaxis（CLI）、filaxis-mcp、local-write-lock
```

| 层 | 是什么 | 不拥有什么 |
|---|---|---|
| core | driver 实现、批次内核、文件传输 / 编辑、转发管理器、观察流与窗口、会话管理器、ssh 底座、方言、终端 | 命名层、默认层、连接复用缓存、会话归属、已存层表；不知道 daemon / mcp / cli 的存在 |
| middle | `RuntimeStack`（命名层、默认层、连接指纹复用、转发）、观察窗注册表、会话归属、已存层解析、层引用解析、操作集 | 参数语法、文本呈现、Daemon 的 token 与传输 |
| interface | 中层的适配器：参数语法、调用方本机路径 → 绝对路径、结果呈现、Daemon 发现 / 握手 / 传输 / 装配 | 任何操作逻辑 |
| shared | 日志器、异步收口这类不含层知识的小件 | — |

内核的七组沿用 ROADMAP §7「换核对账表」的分组（基础、SSH、本机层、观察流、tmux、批次与文件），探测单独成组。组之间有交叉引用（驱动要用到文件与流），没有强加组间依赖方向——内核的边界是「层」，组只是方便找。

SDK 导出（`src/index.ts`）保持扁平：包外的导入路径只有 `@syrkos/filaxis`，目录调整对外不可见；符号名不变。

---

## 5. 中层 API

### 5.1 `Middle`

```ts
interface Middle {
  readonly host: { kind: "in-process" | "daemon"; version: string; protocolVersion: number; pid?: number };
  readonly ops: MiddleOps;
  /** 销毁观察窗、会话跟踪与自建的观察窗注册表（同步） */
  dispose(): void;
  /** 宿主退出前的收尾：再销毁本实例拥有的 driver。远程形态是空操作（状态在 Daemon 进程里） */
  shutdown(): Promise<void>;
}
createMiddle(opts?: MiddleOptions): LocalMiddle            // 进程内实例
connectRemoteMiddle(client: DaemonClient): Promise<Middle> // 同形客户端；握手失败即抛 ProtocolMismatchError
```

`MiddleOptions`：`stack`、`descriptor`（初始层，缺省本机）、`driver`（外部持有生命周期的 driver）、`windowRegistry`、`readyTimeoutMs`、`sessionResultTtlMs`、`sessionCheckIntervalMs`、`savedLayers`、`logger`、`version`。

进程内实例（`LocalMiddle`）另把状态句柄交给宿主：`stack`、`sessionOwner`、`resolveLayerRef`、`windowRegistry()`、`listStreamsSync()`（Daemon 同步汇总状态用）、`shutdown()`。

`shutdown()` 必须销毁 driver：连接复用的主进程、PTY 链都是 driver 的子进程，一次性 CLI 进程退出前不销毁会滞留。

### 5.2 命名约定

- **中层线协议（RPC 参数 / 结果）、CLI `--json` 输出、Daemon `/status` 的结果：统一 camelCase**（即 TypeScript 类型原样）。
- **snake_case 只属于 MCP 工具面**（`run_batch` / `exit_code` / `window_id` …），由工具面适配器（`agent-toolkit.ts`）投影。0.2.13 里 CLI 转发记录改成 snake_case 是在「两套命名并存」上打的补丁，0.3.0 收敛为上面的规则。MCP 的 12 个工具名与 schema 不变。
- 批次计划（`BatchPlan`）字段沿用现状（`steps` / `layer` / `stopOnFail` / `maxParallel`；步骤 `command` / `commandFile` / `after` …）；MCP 面继续用 `command_file` / `stop_on_fail`，由工具面转换。
- 参数语法（未知字段、枚举、范围的报错文案）属于界面层：工具面的校验文案带工具面的字段名，是 MCP 契约的一部分；中层只带不变量守卫。

### 5.3 操作集（26 个）

| 组 | 操作 | 语义要点 |
|---|---|---|
| 能力 | `features` | 内核能力探测（mux / sftp / persistent …）。（宿主状态 `GET /status` 是 Daemon 端点，不是操作） |
| 层 | `connectSsh` `connectSshBatch` `connectInto` | 登记 SSH 目标（单台 / 批量逐个报告、不整批并发）/ 从已有层进入内层 |
| | `listLayers` `activateLayer` `removeLayer` | 命名层的查 / 设默认 / 移除（`destroy` 才销毁 driver） |
| | `probeLayer` | 两段式环境探测（蒸馏值） |
| 执行 | `runCommand` | 等完成拿退出码；`pty` 走终端通道；非零退出码是数据不是异常 |
| | `runBatch` | 计划校验、层通配展开、`commandFile` 内联都在中层做完，再交内核。参数另有 `defaultLayer`（未指定层的步骤落在哪一层）、`layers`（调用方带来的层描述符，命中时优先于中层自己的层表）、`cwd`（默认层是本机层时的命令工作目录）、`previewBudgetBytes` |
| | `startSession` `stopSession` | 长跑会话；停止是请求、死亡须核实，`unknown` 不是成功也不是失败 |
| | `observe` | 限时观察（起会话 → 等 `durationMs` → 读日志 → 停 → 必要时核实） |
| 文件 | `readFile` `readPath` `writeFile` | 读文本 / 读文件或列目录 / 写入（`overwrite`、`createDirs`） |
| | `editFile` | 受控编辑（CAS）。多处替换走 `runBatch` 的 `edit` 步骤（`hunks`） |
| | `managePath` | `mkdir` / `move` / `delete` |
| | `transferFile` | `put` / `get`，`transport`、`writeMode`，校验等级如实报告 |
| 观察窗 | `openStream` `peekStream` `closeStream` `listStreams` | 开窗（可带 `cwd`：本机层的命令工作目录）、三种游标读（`afterSeq` / `beforeSeq` / 末尾，可按 `stream` 过滤）、关窗、清单 |
| 转发 | `openForward` `listForwards` `closeForward` | `-L` / `-R` / `-D`；缺省只列在用；关闭三态 |

`REMOTE_OP_NAMES`（`src/middle/protocol.ts`）是客户端与服务端共用的操作清单，带穷举检查：中层增删操作而忘了同步，typecheck 报错。

### 5.4 层引用 `LayerRef`

```ts
type LayerRef =
  | string                                            // 命名层（简写）
  | { layer: string }                                 // 命名层：已注册，或在已存层表里（按需加载，不抢默认层）
  | { descriptor: RuntimeDescriptor; name?: string }  // 带描述符，见下
  | undefined;                                        // 中层的默认层
```

中层唯一负责把 `LayerRef` 解析成 driver（原工具集的 `resolveDrv` 与 Daemon 的 `resolveTarget` 合并为此）。

- **`undefined` = 中层当前的默认层**，与 MCP 的「不传 layer」同义。CLI 的「命令行没写目标」不是 `undefined`——界面层把它显式翻译成 `{ descriptor: { driver: "local" } }`。 Daemon 里若有人把一个 SSH 层登记成默认层（甚至就叫 `local`），无目标的 CLI 命令不会被它吸走。
- 带描述符、给 `name`：按命名层登记。与既有登记的连接指纹一致则复用；不一致则替换（该层有活跃转发或观察窗时拒绝静默覆盖）。
- 带描述符、不给 `name`：按连接指纹登记为一个临时命名层（名字带指纹短哈希，同指纹复用），不抢默认层。纯本机描述符（local、无 `cwd`、无 `config`）不登记进层栈。
- 同名并发只建一次；并发请求带着不同描述符时拒绝合并。

### 5.5 与调用方机器相关的规则

| 事项 | 规则 |
|---|---|
| 本机文件路径（传输的 `localPath`、`commandFile`、落盘输出、SSH 密钥） | 界面层补成绝对路径后再调用（只补基准目录、不折叠 `..`，与下一行同一条规则） |
| **本机层**上的相对路径（`filaxis cat x.txt` 这种落在 local 层的路径） | 界面层补成绝对路径——只补基准目录，不折叠 `..`（POSIX 上内核逐段解析，符号链接后面的 `..` 相对的是链接实际指向的位置，与 shell 一致；Windows 的路径解析本身就是词法的）。基准是**层自己的工作目录**，没有则取调用方的（经 Daemon 时它的工作目录与调用方无关） |
| 本机层的命令工作目录 | 显式参数 `cwd`（只在没指定 `--layer` / `--host` 时传；已存层用它自己的） |
| CLI 已存本机层的 `cwd` | 层引用与批次层表统一带上绝对 `cwd`。层的相对 `cwd` 按调用方目录锚定，省略时使用调用方目录。文件路径使用同一个基准 |
| MCP 代理的调用方目录 | stdio 代理开 SSE 时通过 `x-filaxis-caller-cwd` 携带目录。工具适配器用它补齐调用方文件路径，并为没有独立工作目录的本机层设置目录，包括按名首次访问的已存层。远程 SDK 和未带该请求头的 HTTP MCP 使用宿主或层的目录，调用方可显式传入相关操作支持的 `cwd` |
| SSH 密钥 / known_hosts 路径 | 界面层展开相对路径后再调用 |
| 调用方眼里的层表 | 批次经 `layers` 参数随请求带给中层：重新保存过的层立刻生效；CLI 用 `FILAXIS_LAYERS` 指向别处时以调用方为准 |
| 大输出 | `exec --out` / `batch --out-dir` 落盘是界面层的事，中层不感知 |

`/rpc` 信封使用操作参数及层描述符表达路径和目录。MCP 的调用方目录属于 SSE 会话上下文，由工具适配器解释。

---

## 6. Daemon 线协议与版本握手

### 6.1 信封

```
POST /rpc   { "protocol": 3, "op": "runCommand", "params": { … } }
        → 200 { "ok": true,  "protocol": 3, "result": … }
        → 200 { "ok": false, "error": "<message>", "name?", "code?", "outcome", "sessionId", "logBase", "exitCode", "forwardId" … }
        → 400 / 413        // 信封或请求体校验失败
GET /status  含 protocolVersion、version、pid、layers、forwards、streams
```

- 操作名 = 中层操作名（camelCase）；不再有 `exec` / `forward.add` / `stream.peek` 这套独立命名。
- `/rpc` 解析信封后调用中层操作，并给支持中止的操作注入宿主信号。操作失败以 HTTP 200 和错误体表达，保留 `outcome` 等字段。执行结果未知时保留未知状态，执行层零自动重放。
- 传输仍是本机回环 HTTP + Bearer token + SSE（MCP 端点），**0.3.0 不换传输**。MCP 端点与 `/rpc` 调用同一个中层。

### 6.2 版本握手

- `PROTOCOL_VERSION`（`src/middle/protocol.ts`）是线协议版本，与包版本分离；不兼容的线协议变更才递增。
- **客户端**：连上先取 `/status`，`protocolVersion` 不等于自己的（或缺失——那是 0.2.x 的 Daemon）即抛 `ProtocolMismatchError`（`code: E_PROTOCOL_MISMATCH`），报双方版本、Daemon pid 与处置办法（`filaxis daemon stop` 后重启）。**绝不向错配的 Daemon 发操作**，也不退回另一条执行路径。
- **服务端**：信封 `protocol` 不等于自己的即拒绝（`code: E_PROTOCOL_MISMATCH`），不执行。
- 0.2.x 客户端 × 0.3 Daemon：旧客户端不带 `protocol` 字段 → 被拒并看到上面的错误。

### 6.3 宿主策略

| 入口 | 缺省 | 另一种形态 |
|---|---|---|
| `filaxis-mcp` | **经 Daemon**：没有在跑就自动启动（复用 `filaxis daemon start` 的同一条拉起路径；两个客户端同时首启时只有一个拉起成功） | `--no-daemon` / `FILAXIS_NO_DAEMON=1`，或带了绑定参数（`--host` 族 / `--enter` / `--docker` / `--layer`）→ 进程内即弃中层。绑定参数描述的是「这个会话的默认层」，共享的 Daemon 没法替某一个客户端设默认层 |
| CLI | 有 Daemon 在跑就用，没有就走进程内即弃中层；**不隐式启动**（脚本里的一次性命令不该留下后台进程） | `--no-daemon` 强制进程内；`filaxis daemon start` / `stop` 显式管理 |
| SDK | 进程内（`createMiddle`） | `connectRemoteMiddle` 连 Daemon，方法签名不变 |

CLI 的转发与观察窗子命令需要常驻宿主（进程一退状态就没了）：没有 Daemon 时明确报错。

---

## 7. 分层门禁（`bun run check:boundaries` 的第四道断言）

断言本体是纯函数模块 `scripts/layering-gate.ts`（输入「文件路径 → 源码」，输出违规清单）；门禁脚本用真文件调它，测试用合成例子逐类验证。

| 规则 | 断言 |
|---|---|
| R0 | `src/` 下的源文件必须归到某一层的目录里——直接堆在 `src/` 根下的不算（总出口 `src/index.ts` 除外）。归位先于一切：堆在根下的文件看不出属于哪层，依赖方向也无从谈起 |
| R1 | 内核只依赖内核与各层共用件——不依赖中层或界面层，**连类型也不取**（依赖方向不许倒过来） |
| R2 | 中层可依赖内核，不得依赖界面层 |
| R3 | 界面层从内核只能取类型（`import type`） |
| R3b | 任何一层都不得经 SDK 总出口（`src/index.ts`）取符号——总出口再导出了整个内核、自己又依赖各层：界面层与中层由此绕过逐模块判断，内核与共用件则和总出口成环 |

层按目录判，不靠文件名清单：`src/core/**` 是内核；`src/middle/**` 是中层；`src/interface/**` 与 `bin/**` 是界面层；`src/shared/**` 各层共用；不在这些目录里的 `src/**` 文件按 R0 报出。测试、示例、脚本不在门禁范围内。

原有三条（零上游业务概念 / 零裸 `Bun.*` / 零第三方运行时依赖）不变。

---

## 8. 有意变更清单（0.3.0）

1. **Daemon 线协议**：操作名改为中层操作名，信封带 `protocol`；`clientCwd` / `target.cwd` 取消。0.2.x 客户端与 0.3.0 Daemon 互相显式拒绝。
2. **裸 RPC 不带层 = 中层当前默认层**（与 MCP 一致）。CLI 的「没写目标 = 本机」在界面层翻译，对外行为不变。
3. **`filaxis-mcp` 缺省经 Daemon 并自动启动**；绑定参数与 `--no-daemon` 走进程内。推翻 0.2.x「MCP 绝不隐式启动 Daemon」。
4. **CLI `--json` 统一 camelCase**：转发记录从 0.2.13 的 snake_case 改回，观察窗、Daemon 状态同理。snake_case 只属于 MCP 工具面；MCP 的 12 个工具名与 schema 不变。
5. **一次性模式与经 Daemon 的行为一致**：相对的本机文件路径、相对的密钥路径在两种模式下不再有差别（原 0.2.x 有 8 处差异）。
6. **提示文案统一**：「层不存在」「不认识的 driver」由中层报错并带补救办法，经 Daemon 与一次性模式不再是两句。
7. **SDK**：`createAgentToolkit(stack, opts)` 签名不变（内部代建中层；`opts.middle` 可传入已建好的），handler 不再含操作逻辑；新增导出 `createMiddle`、`connectRemoteMiddle`、`Middle` / `MiddleOps` / `LayerRef` 及结果类型、`PROTOCOL_VERSION` / `REMOTE_OP_NAMES`；符号名不变。`runtime-stack`、`layer-store`、`session-ownership` 归入中层，包外导入路径不受影响。
8. **`bun run check:boundaries` 多一道断言**（§7）。
9. **`src/` 按层划分目录**（§4）：`core` / `middle` / `interface` / `shared`，根下只留总出口。包的 `exports` 只暴露总出口，所以这次调整对包外不可见；仓库内按旧路径深层导入的代码（测试、脚本）已随搬迁改写。

**非目标**：跨语言 IPC（Host Protocol PRD / ROADMAP §3）；更换传输层；改动完成哨兵、终态核实、零自动重放和 PTY 状态机；为普通 `exec` 扩展目标环境或原生通道的进程控制能力；补齐 SDK 公开面里尚未成为独立操作的能力（`ready()`、`verifySession()`、读落盘日志、事件订阅——ROADMAP §6.1 P2）；内核七组之间的依赖方向断言。

当前 `/rpc` 在应答前检测到连接关闭时，为 `runCommand`、`runBatch`、`observe` 注入宿主本地的中止信号。远程 SDK 的 `AbortSignal` 在客户端控制 HTTP 请求，Daemon 检测到断开后再传递中止请求。MCP SSE 工具调用由独立的消息端点处理，SSE 断开时代理将已提交请求报告为终态未知。普通命令的目标终态仍依赖对应驱动能取得的证据。

请求发出后，Daemon RPC 应答无效或执行通道无法核实终态时，报告 `outcome: "unknown"`。确认断开时同时携带 `reason: "disconnect"` 和 `channel`。`daemon_rpc`、`mcp_sse`、`mcp_post` 指客户端到 Daemon 的对应通道，`ssh_pty` 指 SSH PTY 执行链。单条 MCP POST 传输失败只影响对应请求，共享 SSE 继续回传其他结果。单凭缺少完成哨兵无法判明断线原因。出现已核实的完成结果时，仍按该结果报告。

---

## 9. 迁移步骤（as executed）

| 步 | 内容 | 提交 |
|---|---|---|
| **M0** | 版本握手：`PROTOCOL_VERSION`、`/status` 带 `protocolVersion`、新客户端遇旧 Daemon 明确拒绝 | `bb9853e` |
| **M1a** | `runtime-stack` / `layer-store` / `session-ownership` 迁入 `src/operations/`（纯机械） | `6735f0b` |
| **M1b** | 中层成型：`createMiddle` 与操作集从工具集 handler 里提出来；工具集变成「校验 → 调中层 → 投影」的薄适配器，行为不变 | `6c4a634` |
| **M2+M3** | Daemon RPC 改为薄转发、信封带 `protocol`、同形客户端；CLI 全面改走中层。**两步合并**：Daemon 的 RPC 一旦换成操作名，CLI 必须同步切换，否则两者之间的端到端用例会断；中间留一个旧方法名的过渡垫片是马上要删的一次性代码 | `c1a2319` |
| **M4** | `filaxis-mcp` 缺省经 Daemon、自动启动；绑定参数与 `--no-daemon` 走进程内 | `317a0e8` |
| **M5** | 分层门禁的四条断言 + 清掉界面层最后三处内核值依赖 | `76d0b10` |
| **M6** | 同构用例集：30 条声明式用例 × 三种宿主 | `af0c5f5` |
| **M7** | 文档修订、全量回归、真机复验（23 项） | `66accc4` |
| **M8** | `src/` 按层划分目录（§4）：52 个源文件进 `core` / `middle` / `interface` / `shared`，422 处相对引用由脚本按「解析旧位置 → 查搬迁表 → 按新位置重算」改写；门禁改为按目录判层并加 R0；脚本只认导入语句，另有两处把源码路径拼进字符串交给子进程的用例由「树里写到的路径都必须存在」的核对扫出后手改 | `70d205a` |

复验过程中顺带修掉的三个原有缺陷（0.2.13 即有，不是本轮引入）：

| 缺陷 | 提交 |
|---|---|
| 本机层的工作目录不存在时，命令报成 `ENOENT … uv_spawn 'bash'`（看着像没装 bash）——改为直说「工作目录不存在」并点名目录 | `e9816f7` |
| 进程内形态的 `filaxis-mcp`（绑定参数或 `--no-daemon`）在客户端断开后不退出，连同它的 ssh 一起滞留，每个客户端会话泄漏一个——改为断开即收尾退出 | `48c6178` |
| 经 Daemon 的 `filaxis-mcp` 在客户端于握手完成前关闭 stdin 时，Node 进程陪着一条空闲的 SSE 连接永不退出（`filaxis-mcp < /dev/null` 即触发；发布包的 bin 由 Node 运行；0.2.12 引入 Daemon 与 MCP 代理起即有。代理只中止「已激活」的会话，而会话要等握手响应才登记）——会话改为在发出握手请求时登记，stdin 关闭即撤下在途请求，排队的请求不代为执行 | `721c1af` |

另一个不是原有、而是本分支内引入并在发布前修掉的：打包的类型声明一步自 M1b（`6c4a634`）起带着 5 个类型错误以退出码 2 失败——那一步此前不用项目配置，与日常类型检查是两套判断。改用 `tsconfig.build.json`，工具集里五处取值显式校验，并由测试真的跑一遍（`615d27a`）。

外部审查（GPT，2026-11-27，对象是 0.3.0-dev 相对 v0.2.13 的变更）翻出七处，逐条复现属实，均已修：

| 缺陷 | 提交 |
|---|---|
| 本机层上的路径被词法折叠：符号链接后面的 `..` 不按内核语义解析，`edit` 可能改错文件且退出 0（0.2.13 两种模式都是内核语义，0.3.0 开发中引入） | `8ba8a9f` |
| `stream open` 没带调用方的工作目录，经 Daemon 时命令落在 Daemon 的目录（0.2.13 是调用方的） | `6ce61d6` |
| MCP 代理断线重连时跳过线协议检查，Daemon 中途换成别的版本也照接 | `a256ef5` |
| 多个 MCP 客户端同时冷启动，只有一个是成的 | `1622ce4` |
| 经 Daemon 的 `connectSshBatch` 不可用：数组参数被换成空对象 | `680e5d7` |
| CI 的 Node 作业起不来：`node scripts/check-boundaries.ts` 的相对导入解析不到 | `5851e41` |
| 分层门禁放行 `import("x").then(…)` 这类动态取值写法 | `e939293` |

同一审查方复审（对象 `3c4d9d2`）又翻出四处，同样逐条复现属实，均已修：

| 缺陷 | 提交 |
|---|---|
| 调用方机器上的其余路径仍被词法折叠：`put` / `get` 的本机侧、批次的 `commandFile`、落盘输出。0.2.13 的一次性模式是内核语义，词法折叠只在为 Daemon 准备绝对路径的那条分支上，0.3.0 合并两条路径时合到了折叠的那边（上一轮我把它们误判为「0.2.13 就是词法解析」） | `f40574e` |
| MCP 代理握手没答上来仍开连接（`/status` 报 503 的对端照样收到请求）；握手在途时 stdin 关闭，迟到的结果仍触发 SSE 请求 | `e379bec` |
| `openStream({ cwd })` 另建缺省驱动，绕过所选驱动（注入的、带 shell 配置的） | `8e55e9b` |
| 分层门禁放行 `const then = import("x").then` 与值位置的 `typeof import("x")` | `01b60fc` |

第三轮复审（对象 `98fc064`）又翻出四处，同样逐条复现属实，均已修：

| 缺陷 | 提交 |
|---|---|
| 已存本机层带相对 `cwd` 时，同一个层上 `exec`（经 Daemon，以 Daemon 目录为基准）与 `cat`（以调用方为基准）读到不同文件——`8ba8a9f` 修 `cat` 的基准时引入的不一致 | `4bec662` |
| 下载的本地临时文件名经 `path.join` 折叠了 `link/..`，目标目录在也报 `ENOENT`（0.2.13 即有） | `97362e6` |
| 线协议握手请求是空闲超时且不随代理收尾中止：对端持续滴数据就卡住，stdin 关闭后进程被拖住 | `b342699` |
| 同类（复核时自查翻出）：控制面请求 `/status`、`/health`、`/shutdown` 也是空闲超时——`probeDaemon`、启动器握手、`daemon status` / `stop` 对着只滴数据不应答的对端被无限期拖住 | `e86ebcd` |
| 配套（Linux 真机全量抓出）：请求被销毁后 bun 1.3.12 先给应答对象发 `end`，半截应答被当成 HTTP 200；到点或中止之后的「结束」一律按失败算 | `5c68fa9` |
| 分层门禁把表达式里的冒号（对象字面量、三元）当成类型标注 | `a7386ef` |

第四轮复审（对象 `5c68fa9`）又翻出三处，逐条复现属实，均已修；其中两处是上一批修复带出来的：

| 缺陷 | 提交 |
|---|---|
| 不写 `cwd` 的已存本机层：`4bec662` 只锚定了带相对 `cwd` 的层；不写的层经 Daemon 时 `exec` 落在 Daemon 的进程目录，而 `cat` 按调用方解析——同一个层上两条命令读到不同文件 | `700c9ed` |
| `97362e6` 的回归：下载临时名把反斜杠也当成分隔符，POSIX 上含反斜杠的长文件名 `ENAMETOOLONG` | `7d63724` |
| 分层门禁把参数默认值表达式里的三元冒号当成类型标注（`function f(p = c ? a : typeof import("…"))`）；判定改逐段扫描时又照出回调类型被误拦，一并修 | `93b56f5` |

重写过程中被既有用例与同构用例抓回的回归（均已修）：批次已存层改由 Daemon 自己读层表；「没写目标」落到中层默认层；带工作目录的本机层相对路径基准取错；开在未登记本机层上的观察窗被算到同名命名层头上；多行 import 的类型说明符被判成值导入。

---

## 10. 验收标准清单 (Acceptance Criteria / AC Matrix)

同构验收以语料中具有相同输入、目标层和调用方目录的操作为准。宿主生命周期和中止事件按 §3.2 与 §8 分别核对。会话停止还需区分任务的自然退出与已核实的主动停止，父 shell 的退出码只能作为该 shell 的退出证据。

- [x] **AC-01 一份操作实现**：`/rpc` 负责信封、分发、应答和宿主中止信号，操作实现由三种宿主共用同一个中层。
- [x] **AC-02 界面层零内核值依赖**：门禁断言 + 测试；现有 `src/` 与 `bin/` 零违规。
- [x] **AC-03 同构**：`tests/isomorphism-corpus.ts` 32 条用例覆盖 `runCommand`、`runBatch`（层通配、`commandFile`、失败即停语义、调用方层表）、`readFile` / `writeFile` / `editFile` / `readPath` / `managePath`、`transferFile`、`startSession` / `stopSession`、`observe`、`openStream` / `peekStream` / `closeStream` / `listStreams`（含 `openStream` 的工作目录）、`listLayers` / `activateLayer` / `removeLayer`、`connectSshBatch`（参数是数组）、`probeLayer`、`features`、转发的不支持拒绝；在即弃进程内、SDK 长驻、Daemon 远程三种宿主下结果一致。
- [x] **AC-04 版本握手**：客户端侧（旧 Daemon 不上报 → 拒绝并报 pid 与处置办法；版本一致放行）有单测；服务端拒绝错配信封；CLI 遇错配不退回一次性模式；MCP 代理每次重连前同样过握手（Daemon 中途换了版本即拒绝接入、不向它发请求；握手没答上来不开连接；握手请求有硬性期限并随代理收尾中止）；控制面请求（`/status`、`/health`、`/shutdown`）一律按硬性期限，操作类 RPC 仍是空闲超时（只杀哑不杀慢）。
- [x] **AC-05 MCP 宿主策略**：缺省自动启动并经其执行、另一客户端接得上同一 Daemon、多个客户端同时冷启动都接得上、MCP 退出后 Daemon 仍在；`--no-daemon` 不启动且功能可用；`--layer` 绑定时走进程内。
- [x] **AC-06 零回归**：除 §8 有意变更对应的用例外全部通过。最终代码全量（含 M8 与其后全部修复）——Windows 812 通过 / 48 跳过 / 0 失败，Linux（真机集成打开）853 通过 / 7 跳过 / 0 失败（各 860 条；Windows 多跳过的三条是只在 POSIX 上跑的路径用例）。真机复验 23 项全部通过：协议错配的两个方向（新客户端 × 旧 Daemon 拒绝且不发操作；旧客户端 × 新 Daemon 被拒不执行）；homelab（一次性、经 Daemon、两跳进入管线、put/get 往返、observe）；腾讯云集群（层通配 `q-*` 9 台经 Daemon、一次性批次、跳板层转发）；多跳管线（三段 ssh → ssh → docker 的穿层转发、两跳 ssh 的穿层转发）；MCP 经 Daemon（三个已存层不必先 connect_layer、层通配、forward_add、MCP 开的观察窗 CLI 接得上）；绑定参数走进程内。M8 之后另做真机产物复核（VM 上构建，Node 22）：CLI 经 Daemon 与一次性模式正常；MCP 经 Daemon 三轮应答齐全、12 个工具；客户端在握手完成前关闭 stdin 的三种形态均即时退出，无残留进程。外部审查七处修完后的真机复核：WSL（已发布的 0.2.13 与本分支对照）——`edit link/../marker.txt` 在一次性与经 Daemon 两种模式下都落在 shell 看到的那个文件上；本机真 Daemon——`stream open` 落在调用方目录；构建产物——四个 MCP 客户端并发冷启动三轮 12/12（修复前 3/12），客户端连着时 Daemon 被换成版本不符的假 Daemon → 客户端以 1 退出、假 Daemon 零接触（Linux，Node 22）；CI 的 Node 作业各步在本机 Node 26 下逐步通过。第二轮修复后的真机复核：WSL——`put`、batch 的 `commandFile`、`--script-file`、`--request-file` 四个入口同 0.2.13 逐项一致；Linux 产物（Node 22）——四个 MCP 客户端并发冷启动 12/12，连着客户端时换成版本不符的假 Daemon → 客户端以 1 退出、排队请求报 `not_sent`、假 Daemon 零接触，换成 `/status` 报 503 的假 Daemon → 不开连接、假 Daemon 零接触。第三、四轮修复后的真机复核：本机真 Daemon——已存本机层（带相对 `cwd` 的、不带 `cwd` 的）在一次性与经 Daemon 两种模式下 `exec`、`cat`、`batch` 都读调用方目录的文件（八种组合）；WSL——`get` 到 `link/../newdir/…`（0.2.13 同样 `ENOENT`）与 242 字节含反斜杠的文件名均成功；Linux 产物（Node 22）——并发冷启动 12/12，版本不符的假 Daemon → 客户端以 1 退出，`/status` 报 503 的假 Daemon → 不开连接，均零接触；没有 Daemon 而目录指向只滴数据不应答的假 Daemon 时，`filaxis-mcp` 2.4 秒内自行拉起真 Daemon 开始服务，CLI 的 `daemon status` / `stop` 不再被拖住；CI 的 Node 作业各步在本机 Node 26 下逐步通过。
- [x] **AC-07 分层门禁**：四类违规各有测试证明会被拦下；动态导入的取值写法（`import("x").then(…)`、`.catch(…)`、`.default`、`const then = import("x").then`、值位置的 `typeof import("x")`、对象字面量属性与三元分支里的 `typeof import("x")`、参数默认值表达式里的 `typeof import("x")`、箭头函数体里的 `typeof import("x")`）同样拦下——是否只取类型按所处语句与参数表逐段判定，表达式里的冒号不算类型标注；回调类型、条件类型、返回类型标注等真类型不被误拦；现有代码零违规；门禁脚本在 Bun 与 Node 下都能直接运行（CI 的 Node 作业跑的就是后者）。
- [x] **AC-08 文档**：本文档、SKILL 中英文版、包说明书 AGENTS.md、CHANGELOG 已按新宿主策略与命名约定修订。
- [x] **AC-09 目录就是分层**：`src/` 根下只有总出口与四个层目录；门禁按目录判层，未归位的源文件被拦下——合成用例逐类验证，并用一个真放在 `src/` 根下的文件实测门禁脚本失败退出。
