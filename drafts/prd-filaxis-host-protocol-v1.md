# 牵丝 Filaxis Host Protocol：跨语言与跨进程的执行运行时宿主

> 💡 **目标正式版本**: v1.x 系列（多语言阶段）/ v2.x 系列（内核换核阶段）| **所属业务域**: Syrkos（漩核）基础设施
> **前置依赖**: REQ-0001（牵丝 Filaxis SDK）M1-M3 完成后启动阶段二；本需求**不改动** REQ-0001 既定的 RuntimeDriver / Session 体系与 M1-M4 里程碑。

---

## 1. 需求背景与商业价值

### 1.1 业务痛点与现状

REQ-0001 交付的牵丝 Filaxis 是 TypeScript SDK（Embedded Mode）：RuntimeLayer、Session、连接池、观察流全部活在**调用方进程内**。这带来两个跨不出去的边界：

1. **跨语言**：Python/Go/Java Agent 无法复用这套执行运行时（含已验证的连接复用、方言适配、终态核实等行为契约）；
2. **跨进程**：Agent 退出、模型切换、IDE 重启后，进程内的热连接与 Session 身份随之消散——「Agent A 启动任务 → Agent B 接管观察 → Agent C 查询结果」无法实现，除非重建整个远端执行环境。

关键解耦判断（架构定调）：**解决第二个问题的是独立于 Agent 进程的常驻执行服务（Host），不是 Rust 语言本身**。Rust 是「实现细节可替换」的候选，不是诉求本体。同时，Filaxis 调用以 SSH、远程命令、持续日志观察为主，属 IO 密集而非 CPU 密集——实测热层复用收益来自**连接复用**而非语言执行速度，故换核不承诺延迟改进，也不构成当下重写的理由。

### 1.2 预期收益与指标 (KPI)

- **定性价值**：Filaxis 从「Bun/Node SDK」升级为「独立于模型、语言和 Agent 进程生命周期的执行运行时」；多 Agent / 多语言共享同一条热连接与同一套行为契约；协议成为承诺，内核实现（TS→Rust）可替换而所有客户端零改动。
- **量化收益**：跨客户端接管端到端打通（Agent A spawn → 进程退出 → 异构客户端按 session id 接管，AC-03）；协议版本化兼容性有测试矩阵（AC-01）；同一套公开 API 双模式同构验证（AC-04）。

### 1.3 产品演进叙事（版本口径对齐 REQ-0001 §8.3）

- **0.x**（REQ-0001）：「我是一个 Bun/Node SDK」（M3 完成晋 1.0，API 稳定承诺）；
- **1.x**（本需求阶段二）：「Python Agent 也能用我，而且我们共享同一条 SSH 热连接」——Host Protocol + TS Host + 多语言 SDK；
- **2.x**（本需求阶段三，获益驱动非日历驱动）：「内核换成 Rust 了，你们甚至不用修改工具调用」。

---

## 2. 目标用户与使用场景 (User Scenarios)

### 2.1 目标用户画像

- **异构语言 Agent 开发者**：Python（第一个目标）、未来 Go/Java 的 Agent 作者，需要与 TS Agent 共享执行运行时与热连接；
- **多 Agent 协作编排者**：任务需要跨 Agent 交接（生成任务者 ≠ 观察者 ≠ 验收者），且中途任一 Agent 退出不丢现场；
- **长驻自动化运营者**：CLI 工具、看板、守护进程需要随时接入查看/接管在跑任务。

### 2.2 核心用户故事 (User Stories)

- **场景 A（跨进程接管）**：作为 **Agent 开发者**，我想要 Agent A `spawn` 的任务拥有稳定 Session ID，Agent A 退出后另一个客户端（甚至 Python Agent）能按 ID 接管 `tail / watch / result`，**以便任务生命周期独立于任何 Agent 进程**。
- **场景 B（多语言共享热连接）**：作为 **Python Agent 作者**，我想要 `filaxis` Python 包经本地 IPC 连接 Host，与 TS 客户端共享同一条 SSH 热连接与连接指纹缓存，**以便不用各自建连、不复刻行为契约**。
- **场景 C（嵌入式不打扰）**：作为 **脚本作者**，我只想 `bun add @syrkos/filaxis` 直接用（Embedded Mode），**不被迫部署常驻服务**——简单场景零运维成本。
- **场景 D（安全边界）**：作为 **平台管理者**，我想要客户端身份认证与会话授权、闲置租约自动清理，**以便 Session ID 泄漏不等于执行权泄漏**。

---

## 3. 详细功能说明与业务逻辑 (Feature Specifications)

### 3.1 功能矩阵清单

| 功能点编号 | 功能名称 | 优先级 | 前置条件与处理逻辑 | 异常处理策略 |
| :--- | :--- | :--- | :--- | :--- |
| **FEAT-01** | Filaxis Host Protocol（版本化 RPC 规范） | P0 | 能力面覆盖 `layer / session / exec / spawn / observe / watch / grep / fs / features`；**版本协商**（客户端声明支持区间，Host 回落）；**稳定错误码枚举**（跨语言映射，与 TS 异常类型一一对应）；流式通知（行对象/事件）+ **背压策略**（慢消费者不拖垮 Host，见 AC-06）；协议文档版本化发布 | 版本不兼容 → 显式拒绝并报双方版本；未知方法 → 结构化错误；协议规范为唯一契约源，SDK 文档只链接不复制 |
| **FEAT-02** | TS Host 参考实现 | P0 | 基于 REQ-0001 内核的常驻服务（Bun/Node 双运行时）：持有 RuntimeLayer、Session Registry、连接指纹缓存、观察流与 watcher 生命周期；**与 Embedded Mode 同源内核**（同一套 driver/session 代码，Host 只是给它加了协议端点与跨进程存续） | Host 崩溃恢复：registry 落盘重载（tmux/terminalId 持久层兜底）；内核红线继承 REQ-0001 §4.2（零 个人Agent项目 概念/零消息队列/零 LLM/零 npm 第三方） |
| **FEAT-03** | Session Registry 服务化（稳定会话身份） | P0 | `spawn()` 返回稳定 Session ID（跨进程、跨客户端可寻址）；Registry 维护会话元数据（命令/层归属/终态/热窗口/落盘日志路径）；**接管语义**：任意已认证客户端按 ID 获取句柄，tail/watch/result 与创建者视角同权；Registry 同时承载**层规格与环境身份**（REQ-0001 FEAT-16）——Host 持久面统一管理 Layer + Session 两类身份 | 会话不存在/已终态 → 结构化错误带终态快照；ID 唯一性由 Host 保证；热窗口与落盘边界沿用 REQ-0001 §3.2.3（不承诺进程内无限历史） |
| **FEAT-04** | 本地 IPC 传输层 | P0 | Unix domain socket（Linux/macOS）与 Windows named pipe（`node:net` 原生支持，零第三方依赖）；socket/pipe 路径按用户与实例隔离命名；远程 TCP 监听**不在本期**（显式排除，避免安全面扩大） | 连接断开 → 客户端自动重连+会话恢复；多 Host 实例共存（路径隔离）；权限：socket 文件权限收紧（同用户访问） |
| **FEAT-05** | 客户端认证与会话授权 | P0 | **Session ID 只是标识符，不是访问凭证**；认证：本地 token 握手（Host 启动时生成，默认同用户可读的受控文件）；授权模型：默认全量（单用户工作站的 Embedded→Host 平滑升级路径），可配会话级 ACL；**租约与清理**：闲置会话按 TTL 提醒→回收（沿用注意力衰减语义），可显式 pin 延长 | 未认证/错误 token → 拒绝并列出支持的认证方式；租约到期 → 通知+回收（终态广播），pin 中的会话不回收 |
| **FEAT-06** | Embedded / Host 双模式同构 API | P0 | 同一套公开 API（`connect/exec/spawn/observe/fs/watch`）双形态：Embedded 直连进程内内核，Host 经 IPC 走协议；**跨进程共享的会话能力（接管/多客户端）显式属于 Host Mode**，Embedded 下访问报「此能力需 Host Mode」；模式声明于连接期 | 双模式行为差异显式枚举于协议文档；同一测试套件双模式跑（AC-04） |
| **FEAT-07** | Python SDK（第一个异构客户端） | P1 | `filaxis` Python 包，pip 安装；经 FEAT-04 IPC 通道说 FEAT-01 协议；API 语义与 TS 版对齐（含终态三态/ready 回溯/方言行为等契约要点的等价测试）；作为**协议完备性的验收基准**——第二个语言客户端是协议质量的试金石 | Python 版行为偏差 → 以协议规范为仲裁；不实现协议未定义的便利语法 |
| **FEAT-08** | 会话内容检索 grep | P1 | `session.grep(pattern, scope: "window" \| "log")`——window=热窗口内匹配，log=落盘日志回查（走方言适配层）；跨客户端可用（接管场景的典型查询） | log scope 在日志缺失（未落盘会话）→ 显式不支持；大日志回查限流/分页 |
| **FEAT-09** | Rust Core 增量迁移路径（判据，非即时实施） | P2 | 阶段三框架：候选部件**独立且获益明确**者先行（Session Registry、环形缓冲、日志索引、跨平台进程管理）；**同协议新旧对照**——Rust 部件与 TS 部件跑同一协议测试矩阵，确认收益再扩大范围；换核不承诺延迟改进（IO 密集定性，§1.1）；触发判据=获益驱动而非日历驱动 | 新旧对照不达标 → 不迁移；全量差分+长跑+故障注入为换核门（对齐 REQ-0001 AC-11 零回归纪律） |

### 3.2 关键设计语义（业务逻辑细则）

1. **协议是承诺，内核是可替换件**：所有客户端只依赖 Host Protocol；TS→Rust 换核属于 Host 内部实现变化，客户端与 Agent 工具面零改动——「架构设计到将来可以换 Rust，却不需要让所有 Agent 跟着重写」。
2. **Embedded 优先、Host 渐进**：不强制部署服务；同一 API 双模式，跨进程共享能力显式标注 Host Mode（FEAT-06）——嵌入式用户零运维成本（场景 C）。
3. **安全边界三原则**：Session ID ≠ 凭证；认证先于会话操作；租约到期即回收（默认不留野会话，pin 是显式请求）。
4. **Rust 生态工具的定位注记**（提案来源方建议的取舍，本需求裁定）：NAPI-RS / PyO3 属**嵌入式原生绑定**路线，解决的是单进程内跨语言调用，与本需求「跨进程共享」诉求正交——**不采纳为当前阶段路线**；interprocess（Rust IPC crate）属阶段三实现选型，届时评估。阶段二 IPC 一律 `node:net`（零依赖）。

---

## 4. 架构分层（Architecture）

```
┌──────────────────────────────────────────────────────┐
│ 客户端层                                                │
│   Node/Bun: @syrkos/filaxis    Python: filaxis  …未来  │
│   （Embedded Mode：TS 客户端可进程内直连同源内核，不经 IPC） │
├──────────────────────────────────────────────────────┤
│ Filaxis Host Protocol（版本化 RPC：认证/会话/流/背压/错误码）│
├──────────────────────────────────────────────────────┤
│ Filaxis Host（常驻服务；阶段二=TS 实现，阶段三可增量换 Rust）│
│   Session Registry · 连接指纹缓存 · 观察流 · watcher      │
│   租约与清理 · 认证授权                                    │
├──────────────────────────────────────────────────────┤
│ REQ-0001 执行内核（RuntimeDriver 契约 / ssh 底座 /        │
│   会话生命周期 / fs 子系统 / 方言适配）                      │
│   Transport: Local · SSH · Docker · K8s · Teleport      │
└──────────────────────────────────────────────────────┘
```

Host 与 Embedded 共享 ①② 层（同源内核）；差异只在 Host 多出协议端点、Registry 服务化与跨进程存续。内核边界红线（REQ-0001 §4.2）原样继承。

---

## 5. 验收标准清单 (Acceptance Criteria / AC Matrix)

> 💡 **AI 编译提示**: 以下条目将直接编译为 Spec-Kit 实施任务（锚定阶段二交付；阶段三为判据框架不设实现型 AC）：

- [ ] **AC-01**: Host Protocol 版本化——协议带版本号与协商机制；旧客户端 × 新 Host（至少跨 1 个 minor）兼容性测试矩阵通过；未知版本显式拒绝并回报双方版本。
- [ ] **AC-02**: TS Host 常驻存续——全部客户端退出后 layer/热连接/session 存续；Host 重启后经 registry 落盘重载可恢复（tmux/terminalId 持久层兜底），行为与重启前一致（会话终态/热窗口边界如实）。
- [ ] **AC-03**: 跨客户端接管端到端——客户端 A `spawn` 并退出 → 客户端 B（**Python SDK**）按稳定 Session ID 接管，`tail / grep / watch / result` 全部可用且语义与创建者视角一致。
- [ ] **AC-04**: 双模式同构——REQ-0001 的公开 API 测试套件在 Embedded 与 Host 两模式下同参数运行，行为一致；Host Mode 独有能力（接管/多客户端）在 Embedded 下显式报「需 Host Mode」。
- [ ] **AC-05**: 认证与会话授权——未认证/错 token 拒绝；Session ID 单独泄漏不足以访问会话；租约到期会话通知+回收；pin 会话不被回收。
- [ ] **AC-06**: 流式背压——慢消费者（限速消费的客户端）不拖垮 Host 与其他客户端的观察流；背压策略在协议层有定义（丢弃策略/窗口截断二选一，显式声明）。
- [ ] **AC-07**: 错误码契约——稳定错误码枚举跨语言一致：TS 异常类型 ↔ 协议错误码 ↔ Python 异常类三方映射表有测试。
- [ ] **AC-08**: Python SDK 交付——pip 可安装；e2e 用例覆盖 connect/exec/spawn/observe/watch/result/grep；终态三态、ready 回溯、方言行为等语义契约要点有等价测试。
- [ ] **AC-09**: Rust 迁移对照门（框架级）——「同协议新旧实现对照」测试框架就绪：任一部件的 Rust 实现可插入同一协议测试矩阵与 REQ-0001 全量差分基线跑分；未过门不得替换（判据框架，非 Rust 实现本身）。
- [ ] **AC-10**: 协议规范文档——Host Protocol 规范（能力面/版本策略/错误码/背压/认证/授权模型）独立版本化发布；SDK 文档只链接不复制。

---

## 6. 技术契约与非功能约束 (Constraints)

### 6.1 推进阶段与依赖

- **阶段一**（REQ-0001，进行中）：TS SDK 独立开源，M1-M3 照旧完成——本需求不改动其任何既定体系。
- **阶段二**（本需求主体）：Host Protocol 规范 + TS Host + Python SDK + 双模式同构；启动点 = REQ-0001 M3 完成。
- **阶段三**（判据驱动）：Rust Core 增量迁移，独立获益部件先行，同协议对照过门才扩大范围。

### 6.2 Rust 重写代价清单（为什么不是现在）

以下已验证行为不是翻译几千行 TypeScript 能覆盖的，换核前必须全量重验：PTY 握手与多跳连接、层状态管理、stdout/stderr 双流语义、观察流与 watcher 生命周期、tmux 持久会话与断线重附着、Windows/Linux 差异处理、SSH 连接拓扑指纹与复用、方言适配层。**全量差分 + 长跑测试 + 故障注入**是换核门槛（对齐 REQ-0001 AC-11 零回归纪律）。

### 6.3 安全与运维

- IPC 默认本机（socket/pipe），远程 TCP 显式排除在本期外；token 受控文件权限；socket 按用户/实例隔离。
- Host 资源治理继承 REQ-0001（注意力衰减/OOM 防线/watcher 上限），叠加租约与清理（FEAT-05）。

### 6.4 与 个人Agent项目 的关系

- 个人Agent项目 是 Host Mode 的**首个候选消费者**（多 LogicNode 共看、Agent 重启任务不丢的现成诉求），但经适配器接入（REQ-0001 FEAT-13 同一位置）；本需求全文零 个人Agent项目 概念，内核红线继承。

### 6.5 许可证

- 跟随 REQ-0001 §8.4：**Apache-2.0 单一许可 + NOTICE**（品牌归属锁定）；Python SDK 分发（PyPI）同样携带 LICENSE 与 NOTICE。
