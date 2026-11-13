# Feature Specification: 牵丝 Filaxis：面向自动化与 Agent 的远程执行运行时 SDK (REQ-0001)

## 1. Background & Value
### 1.1 业务痛点与现状

RuntimeStack 当前是 个人Agent项目 仓内模块（`原内部模块`，约 4,900 行 + terminal-manager 外围），概念体系已经过一年生产锤炼，成熟度远超一般内部设施：

- **统一执行抽象**：`RuntimeDriver` 接口一套语义覆盖 local / ssh / docker / k8s / teleport / 任意自定义 Transport；
- **SSH 底座零库依赖**：spawn 系统 `ssh` 二进制 + PTY 握手协议，天然继承 OpenSSH 全部能力（多跳、`-J` 跳板、`-L/-R/-D` 端口转发、ControlMaster 多路复用），无协议栈重实现风险；
- **长跑任务生命周期**：execSession（启动即返回 + 落盘日志 + 热窗口 tail + 行级 watcher + stop）；
- **真流式观察流**：每条观察走独立 SSH channel，stdout 逐行直推，无轮询无漏行（D10 手眼分离）；
- **持久会话**：tmux 后端 terminalId，跨进程重启 re-attach + cwd 恢复；
- **连接治理**：连接拓扑指纹缓存（同 descriptor 复用连接，杜绝孤儿连接）。

但它物理上耦合在数字心智业务仓内，与 PolicyEngine（capabilities 环境感知拦截）、CoreLite 消息队列（SessionNotifier → Q_SESSION_EVENT）、SubstrateSecurity、workspace 概念、LLM prompt 注入格式交织，**无法独立安装、独立调用、独立运行**。

同时，SSH 库生态存在明确空位：Paramiko/AsyncSSH/Fabric 解决「怎样操作远程计算机」，停留在连接/通道/文件原语层；而**长期任务生命周期（spawn → observe → watch → attach → reap）、多 Transport 统一语义、慢消费者不阻塞远端的观察流**，在现有 SSH 库中没有一等公民表达。Paramiko 官方甚至把高层自动化场景引向 Fabric——证明「SSH 原语之上的自动化运行时」是被承认的独立一层。

### 1.2 预期收益与指标 (KPI)

- **定性价值**：
  - Syrkos 体系获得真正独立的远程执行基础设施：运维脚本、自动化测试、集群管理与 Agent 共用同一套底座；
  - 个人Agent项目 从「唯一宿主」变为「第一个消费者」，内核与集成层边界在编译期强制成立；
  - 差异化定位成立：「又一个 SSH 库」不是卖点，「统一执行语义 + 任务生命周期 + 观察流」才是。
- **量化收益**：
  - 内核包零 个人Agent项目 依赖（构建期断言，见 AC-01）；
  - 个人Agent项目 迁移到 OSS 包后生产行为零回归（现有测试基线 stash 往返对照，见 AC-11）；
  - Bun 与 Node 双运行时支持（见 AC-03），Windows 与 Linux 双平台同构（见 AC-02）。

---

## 2. User Scenarios & Stories
### 2.1 目标用户画像

- **主要用户：运维 / 平台工程师** —— 需要跨多台主机（含跳板、Docker、K8s）执行命令、抓取日志、管理长跑任务的脚本与工具作者；
- **自动化测试工程师** —— 需要在远端环境拉起被测进程、流式观察输出、按行断言、结束清理的测试基建作者；
- **Agent 开发者** —— 需要 LLM Agent 安全、可观察、可中断地操控远程计算环境的开发者（个人Agent项目 是第一个也是需求最重的消费者）；
- **集群 / 基础设施管理者** —— 需要统一接口管理异构执行面（SSH 主机 / 容器 / K8s Pod / 堡垒机）的平台团队。

### 2.2 核心用户故事 (User Stories)

- **场景 A（跨主机协同诊断）**：作为**运维工程师**，我想要在防火墙上启动抓包、从远端服务器发起探测、再回读 pcap 与日志汇总判断，**以便在一次脚本内完成跨节点网络定位**——期间长跑抓包任务的启动就绪、超时中断、资源清理都由 SDK 托管。
- **场景 B（长跑服务观察）**：作为**平台工程师**，我想要对 `tail -f` / `docker logs` / 训练任务这类持续输出建立观察流并注册行级 watcher，**以便进程输出命中关键模式时立刻收到事件，而不是轮询**；观察者退出后无人消费的流能自动回收。
- **场景 C（断线恢复）**：作为**运维工程师**，我想要执行环境以持久会话形式存活（tmux 后端），本地进程崩溃或重启后能重新附着并恢复工作目录，**以便长时间作业不因客户端中断而丢现场**。
- **场景 D（Agent 手脚）**：作为**Agent 开发者**，我想要给模型一组 `exec / spawn / observe / files` 工具，输出流按行消费、任务有生命周期、凭据与高危操作有显式边界，**以便 Agent 操控远程环境时行为可审计、可中断、可回收**——而不需要绑死任何消息队列或特定 Agent 框架。
- **场景 E（异构执行面统一）**：作为**平台工程师**，我想要 SSH 主机、Docker 容器、K8s Pod、堡垒机（teleport）暴露同一套执行/文件/会话语义，**以便上层编排代码不为每种环境写一遍**。

---

## 3. Detailed Specifications & Business Logic (详细功能与业务逻辑)
## 3. 详细功能说明与业务逻辑 (Feature Specifications)
### 3.1 功能矩阵清单

| 功能点编号 | 功能名称 | 优先级 | 前置条件与处理逻辑 | 异常处理策略 |
| :--- | :--- | :--- | :--- | :--- |
| **FEAT-01** | Driver 抽象与 Transport 注册 | P0 | 内核定义 `RuntimeDriver` 统一契约（exec / 会话族 / fs / 生命周期）；local/ssh 内置，docker/k8s/teleport 内置快捷方式，任意 Transport（nix-shell、conda、distrobox…）经 `launchCmd` 或注册表接入 | 未知 driver 且无 launchCmd → 结构化错误；注册表冲突 → 拒绝覆盖并报已占用 |
| **FEAT-02** | SSH 底座（系统 ssh 二进制路线） | P0 | spawn 系统 `ssh` + PTY 握手（`stty -echo` + 随机就绪标记）；结构化 `SshConnParams`（user/port/keyFile/jump/forwards）；多跳逐跳登录派生独立链；`~` 路径代码层展开 | 连接失败/超时给结构化错误（区分网络层/认证层）；私钥不可达显式报错 |
| **FEAT-03** | 一次性 exec | P0 | `exec(cmd, opts)`：timeoutMs / env / cwd / AbortSignal 硬中断；**通道显式化** `channel: "exec" \| "pty"`（缺省 exec）。**exec 通道（非 PTY）**：stdout/stderr 物理分离；**层上下文拼装**——复用层描述符的 cwd / env / enterSteps 有序管线（docker exec、sudo -u 等包裹前缀逐条重放，锚定既有 enterPipeline 机制），使独立 channel 复现层进入路径而非裸落宿主默认环境；返回 stdout / **stderr（分离）** / exitCode / effectiveUser。**pty 通道**：走层内 PTY marker 协议（天然继承层内交互状态：su 身份、cd、export），stderr 混流为终端语义。**effectiveUser 双通道语义**：各通道经 marker 尾缀 `id -un` 各自实测，反映**该通道命令上下文**的真实身份，非跨通道共享状态 | 超时与 abort 杀子进程并 reject；退出码非零不抛异常、如实返回（由调用方判定）；**不可直达层**（PTY 内交互式二次跳转、无独立 ssh socket 可复现者——如手工 `su -` 后再 `ssh`）→ exec 通道显式拒绝并指引用 pty 通道，且在 `features()` 标注 `stderrSeparated: false`（AC-02/AC-04 断言） |
| **FEAT-04** | 长跑会话生命周期 | P0 | `spawn`：启动即返回会话句柄；**远端落盘协议双文件**——`<log>.out` 与 `<log>.err` 分别重定向（禁止 `2>&1` 单文件混流——否则后续观察流无法还原 stream 标记），本地聚合按到达序进热窗口（行对象带 stream 标记）；**跨流顺序契约：聚合序为本地到达序（两路观察的交错近似），显式不承诺进程真实跨流写入序**——需严格写入序的场景不适用双文件落盘；行级 watcher（string=子串 / RegExp，once 默认）；stop（SIGTERM→SIGKILL 升级）；list 会话。**终态可核实**：`result()` 返回 `{status: "exited" \| "stopped" \| "unknown", exitCode?}`——exited=收到进程退出码；stopped=终止请求已发出且清理核实通过；unknown=核实不可达（SSH 断线/网络分区/核实超时），显式暴露而非当成功 | 无换行极端流防 OOM 硬上限强制切块；watcher 每会话上限防泄漏；停止的会话再操作 → 显式「会话不存在」错误；**发送终止请求≠确认死亡**——SSH 断线/远端脱离进程组（nohup/setsid）/网络分区场景必须落 unknown 或经核实落 stopped，严禁静默当已清理 |
| **FEAT-05** | 观察流（真流式） | P1 | 每条观察 = 独立 SSH channel 子进程，**stdout/stderr 双流直推**（行对象携带 stream 标记；onLine 回调 / AsyncIterable 可按流过滤），无轮询；**观察 spawn 会话落盘日志的组合场景**：`tail -F` 分别跟 `.out`/`.err` 双文件，行对象 stream 标记按源文件还原（FEAT-04 落盘协议保障）；ControlMaster 多路复用共享主连接（Windows 无 mux 自动退化直连）；无人消费且无 armed watcher 超 TTL → 注意力衰减自动回收 + 事件通知。注：现有实现将 stderr 并入同一窗口（刻意合并）——双流属本功能改造点 | 桥接消费方回调异常不杀流；master socket 清理容忍并发竞态 |
| **FEAT-06** | 文件子系统（基础契约） | P0 | `fs` 基础契约：readFile / writeFile / exists / readdir / rm / mkdir / stat(mtimeMs,size) / readBase64（二进制安全）；远端实现经 exec 通道，跨 Transport 一致。**远端脚本原语经方言适配层**（见 FEAT-14 方言探测）。**不含跨机整文件传输**（见 FEAT-14） | 远端层不支持二进制读取时显式声明而非静默损坏；路径安全检查防逃逸 |
| **FEAT-07** | 持久会话（tmux 后端） | P1 | `terminalId` 绑定 tmux 会话；跨重启 re-attach；持久化 cwd 恢复；destroy 时先停本层后台进程（nohup 脱离进程组，kill-session 的 SIGHUP 不达）再销毁 | cwd 恢复失败不阻断初始化；进程清理失败不阻断销毁（best-effort 但记录） |
| **FEAT-08** | 连接池与拓扑指纹 | P1 | 同连接拓扑（身份字段白名单投影归一化）复用既有连接；显示标签、运行态缓存等非身份字段不进指纹 | 逐出与销毁分离（销毁归调用方）；指纹冲突即新连接不误挤旧连接 |
| **FEAT-09** | 事件与钩子（零队列依赖） | P0 | 内核事件（会话退出 / watcher 命中 / 连接状态 / 层状态机）经 `EventEmitter` + `AsyncIterable` 双形态暴露；**内核不认识任何消息队列** | 事件消费方异常与内核生命周期隔离 |
| **FEAT-10** | 层模型（执行环境栈） | P0 | 层 = 独立长连接；栈顶仅为焦点指示器不约束执行；push 派生新独立链（不共享不嵌套既有连接）；逐层退出或全收 | 死层/重连中/退化态可查询（层状态机 healthy/blocked/probing 类语义） |
| **FEAT-11** | spawn 就绪握手 | P1 | `ready({pattern, timeoutMs})`：以输出中出现就绪标记为门（解决「exec 返回 ≠ 进程已开始监听」竞态，如 tcpdump 抓包先于探测启动）。**回溯匹配语义**：先扫描热窗口已有行（覆盖 spawn→ready 调用间隙已输出的标记——若只监听增量则快输出进程必漏），命中即立即 resolve；未命中再监听增量行 | 超时未就绪 → reject 且自动 stop 清理，不留孤儿进程；**滚出感知有据**：窗口件维护逐出计数（`evictedCount`）——扫描未命中且 `evictedCount === 0` → 自 spawn 起历史完整，标记确定未出现，安心监听增量（零远端 I/O）；`evictedCount > 0` → **历史可能不完整**（无从断言标记是否曾出现），报「窗口历史不完整，标记可能已滚出（可回查落盘日志）」——既不断言标记曾存在，也不死等 |
| **FEAT-12** | 主机密钥与凭据策略 | P0 | 默认 `accept-new`（TOFU）且可收紧为严格校验/已知主机文件校验；凭据（密钥路径/agent）显式结构化传入；日志与错误严禁输出私钥内容 | 策略由调用方显式配置，无静默接受未知主机的隐式默认（对系统 ssh 策略显式化声明） |
| **FEAT-13** | 个人Agent项目 适配器（可选子包） | P2 | 内核事件 → 个人Agent项目 CoreLite 队列桥（SessionNotifier 语义）；PolicyEngine capabilities 桥；**以适配器包形式存在，内核零感知** | 适配器缺席时内核功能完整可用 |
| **FEAT-14** | 文件传输 get/put + 远端方言适配层 | P1 | `fs.get(remote, local)` / `fs.put(local, remote)` 高层传输 API。实现分级降级：① 非 PTY exec 通道 base64 管道（跨 Transport 一致——docker/k8s 无 sftp，小中文件主路径）；② 系统 `sftp` 子进程批量模式（仅 SSH Transport，大文件快路径，复用同一连接参数渲染）。**方言适配层**：内核所有远端脚本原语（base64 编解码 / sha256 校验）经 GNU·BSD·busybox 三族探测嗅探并**按连接缓存**——现有 `base64 -w 0` 为纯 GNU 方言（`tmux-driver.ts:139`），FreeBSD/OPNsense 的 base64 不认 `-w`（BSD 用 `-b`，解码历史差异 `-d`/`-D`）、sha256 工具 Linux=`sha256sum` / FreeBSD=`/sbin/sha256 -q` / 精简容器=busybox 或 `openssl dgst`——目标环境（OPNsense/Alpine 容器）不探测必错。现状盘点：远端读写作 base64-over-PTY 分块（受 PTY send-keys 缓冲上限约束），**无高层传输 API**——本功能为补齐项而非平移 | 大文件分块传输可断点重试；sftp 缺席/失败自动降级 ① 并声明；校验和（size/sha256，按方言适配）回读验证落位完整；探测失败 → 该原语显式不可用而非静默用错方言 |
| **FEAT-15** | Agent 使用指引（包附带 AGENTS.md + 场景 SKILL 集） | P2 | 交付物含**给使用方 Agent 读的指引**两件：① 包内 `AGENTS.md`——包说明书形态（核心概念心智模型：driver/layer/session/stream/watcher；**语义契约防误用要点**：终态三态勿把 unknown 当成功、ready() 回溯语义、exec/pty 通道语义与层上下文边界、方言适配行为；声明「本文件只描述本包，不接管宿主仓库规范」——宿主自有其 AGENTS.md）；② 场景 SKILL 集（`docs/skills/`，可选分发）——按任务组织操作剧本（跨主机诊断 / 长跑观察 / 文件同步），**只写领域知识与操作剧本并引用 API 文档链接，不复制 API 参考正文**（防双源；环境实例数据不进 SKILL，现场探测）。定位：Agent-ready packaging 是本包对 Agent 开发者用户的交付承诺，亦是 个人Agent项目 回迁后 LO 工具面提示词的改写源 | 指引与 API 漂移防线——SKILL/AGENTS 不内嵌 API 签名副本，链接到版本化文档；语义契约要点与 REQ §3.2 细则一一对应，评审期同步核对 |
| **FEAT-16** | 环境规格与层自发现（Layer Probing） | P2 | 净室移植自 个人Agent项目 Adaptive Layer Phase A（2026-11-07 上产，源见对账表）。**两段式探测**：快探测（os/架构/语言运行时/GPU 型号显存）+ 慢探测（关键包导入验证），结果**蒸馏落盘**（只存版本号/有无/型号，不存全量 dump）；**层规格持久化**——ssh_config 类比的配置文件（`layers.{alias}`：connection + environment + discovered_at + fingerprint），mtime 缓存 + tmp+rename 原子写；**漂移检测**：连接拓扑+环境快照 hash；**按需匹配**：`stack.layers.match({ needs })` API（如 `{gpu, "python>=3.12"}` → 命中层）；**环境身份键**：落点[+端口]+enter 标签链，hops 不进键（同落点经不同路径 = 同一环境规格）——与 FEAT-08 连接指纹**两键两职责**（driverKey 管连接复用，环境键管规格归属）；探测输出默认仅蒸馏落盘，全量输出经可选 hook 供消费方审计/擦洗（scrubber 策略归消费方） | **探测真实性红线**：探测失败文案不得误记为规格（生产实证：nvidia-smi 驱动不通信的失败文案被记为 GPU 型号）；**回显防御**：PTY 批量探测下值含 `$(` 即丢弃（命令注入防御）；探测超时按命令独立（缺运行时=跳过非报错）；漂移检测命中 → 标记 stale 供重新探测，不自动覆盖 |

### 3.2 关键设计语义（业务逻辑细则）

1. **退出码契约**：`exec` 结果如实携带退出码，非零不抛异常——「命令失败」是数据不是异常；「无法执行」（连接断、超时、abort）才是异常。这一语义是 Agent 场景行为可审计的基石。
2. **stderr 分离的物理边界**：一次性 exec（FEAT-03）与观察流（FEAT-05）均走**非 PTY 通道**，stdout/stderr 物理分离、如实分别返回（诊断场景 stderr 是判据，混流是污染；现状为全链路混流——PTY marker 协议与 stream 会话均合并，属 OSS 版改造点）。**PTY 交互层（FEAT-10 手）显式不承诺 stderr 分离**：终端语义下 stderr 本就汇入终端流，这是物理事实而非缺陷，文档如实声明。
3. **观察窗存储边界**：进程内 ring buffer 只提供有限热窗口（默认 50 行 × 512 字节，可配）；完整历史经落盘日志文件承载；跨进程恢复依赖 tmux/terminalId 持久层。两级边界在文档中显式声明，不承诺进程内缓冲的无限历史。
4. **手眼分离**：交互编排（手）与会话串行走 PTY 层；观察（眼）走独立 channel 真流式——观察是廉价的，连接是稀缺的（ControlMaster 共享）。
5. **注意力衰减回收**：无人消费且无 armed watcher 的观察流超 TTL 自动收摊并广播事件——资源回收是默认行为，长活是显式请求（armed watcher = 常驻注意力）。
6. **终止即请求、死亡须核实**：`stop()` 是发出终止请求（本地杀 ssh 客户端后远端是否收到 SIGHUP 取决于进程组关系——nohup/setsid 脱离者收不到；远端 pkill 路径同理），终态必须经核实（退出码/远端探测）落 exited / stopped，核实不可达（断线/分区/超时）落 **unknown** 并显式返回——「发出了清理请求」不等于「清理成功」，SDK 不替调用方掩盖这个差别。

---

## 4. 架构分层与内核边界（Architecture）
### 4.1 三层架构

```
┌────────────────────────────────────────────────┐
│ ③ 消费方（不在本包）                              │
│    个人Agent项目 适配器 · 运维脚本 · 测试基建 · CI      │
├────────────────────────────────────────────────┤
│ ② 事件与组合层（内核内置）                        │
│    EventEmitter / AsyncIterable · watcher       │
│    层模型编排 · 连接指纹缓存 · 注意力回收           │
├────────────────────────────────────────────────┤
│ ① 执行内核                                      │
│    RuntimeDriver 契约 · local/ssh 内置 Transport │
│    exec / spawn 会话生命周期 · fs 子系统          │
│    ssh 二进制底座（多跳/转发/ControlMaster）       │
│    tmux 持久会话后端                             │
└────────────────────────────────────────────────┘
```

### 4.2 内核边界红线（编译期强制）

- **零业务依赖**：内核包禁止 import 个人Agent项目/CoreLite/PolicyEngine 任何概念；logger 为可注入接口（不绑具体实现）；展示层（表格/彩色输出）只进可选子包；
- **零消息队列**：任务协调与输出分发只经事件接口暴露；消息队列只是「一种输出流消费者」（FEAT-13 适配器的事）；
- **零 LLM**：内核不生成任何 prompt/摘要格式；`promptSummary` 类 LLM 注入格式属于 个人Agent项目 消费层；
- **零 npm 第三方依赖**：不引 node-pty / ssh2 类含原生模块或纯 JS 的第三方运行时依赖；PTY 经系统 ssh 自带能力。**系统级依赖（ssh/sftp/tmux 二进制）与 npm 依赖是两类声明**，前者显式化于 8.2 依赖矩阵，不与本条混同。

### 4.3 与现有生态的定位关系

- Paramiko/AsyncSSH = SSH 工具箱（协议栈内的连接/通道/文件原语）；
- 本包 = **SSH 之上的远程执行运行时**（任务生命周期 + 观察流 + 多 Transport 统一语义）；
- 技术路线声明：不重实现 SSH 协议栈，spawn 系统 ssh 二进制——继承 OpenSSH 成熟度与凭据体系（agent/config/known_hosts），代价是依赖目标机 OpenSSH 存在；此路线与 Paramiko（纯协议栈实现）正交，是刻意选择而非能力缺口。

---

## 5. 目标 API 草案（TypeScript，v1 形态）
```ts
import { RuntimeStack } from "@syrkos/filaxis";

const stack = new RuntimeStack({ logger: myLogger });          // logger 可注入

// 层模型：connect 返回独立长连接层（Transport 可插拔）
const fw = await stack.connect({ driver: "ssh",
  target: "opnsense", conn: { user: "root", port: 22 } });
const box = await stack.connect({ driver: "docker", target: "usca" });

// 一次性 exec：退出码是数据，失败是异常，stderr 分离
const r = await fw.exec("uname -a", { timeoutMs: 10_000, signal: ac.signal });
// r: { stdout, stderr, exitCode, effectiveUser }

// 长跑会话：spawn → ready 握手 → 流式观察（双流）→ watcher → 收尾
const cap = await fw.spawn("tcpdump -i igc0 -c 20 -w /tmp/x.pcap host 198.51.100.5");
await cap.ready({ pattern: /listening on/, timeoutMs: 5_000 }); // 就绪门（竞态根治）
for await (const line of cap.lines()) {                          // AsyncIterable 真流式
  if (line.stream === "stderr") alerts.push(line.text);          // 行对象带 stream 标记
}
const errLog = cap.lines({ stream: "stderr" });                  // 亦可按流过滤迭代
const hit = await cap.watch({ pattern: "ERROR", once: true });   // 行级命中 Promise
const done = await cap.result({ timeoutMs: 15_000 });
// done: { status: "exited" | "stopped" | "unknown", exitCode? }  // 终态可核实
await cap.stop();                                                // SIGTERM→SIGKILL（发出后核实）

// 文件子系统（跨 Transport 一致契约）
const osr = await fw.fs.readFile("/etc/rc.conf");
await box.fs.put(localPath, "/app/config.yaml");                 // 上行：base64 管道 / sftp 分级降级（FEAT-14）
await fw.fs.get("/tmp/x.pcap", localPath);                       // 下行同构

// 事件（零队列依赖；队列桥在 ③ 层适配器）
stack.on("sessionExit", (e) => dashboard.record(e));

// 持久会话：tmux 后端 re-attach + cwd 恢复
const term = await stack.connect({ driver: "ssh", target: "homelab", persistent: true });
```

> 草案口径：命名与语义以现有 `RuntimeDriver` 契约（`原内部模块`）与 R-1 会话族为准提炼；终名在实施期以既有概念体系为锚（driver / layer / session / stream / watcher），不引入源库命名。

---

## 6. 现有资产 1:1 对账表（个人Agent项目 → OSS 迁移映射）
> 按「跨模块移植 1:1 对账」门禁要求盘点，确保能力零降级。

| 现有模块（个人Agent项目） | 行数 | OSS 去向 | 动作 |
| :--- | ---: | :--- | :--- |
| `runtime/driver.ts`（契约） | 135 | ① 内核 `driver` 契约 | 平移 + stderr 分离/ready 扩展 |
| `runtime/ssh-pty-driver.ts`（SSH/PTY/多跳/转发） | 872 | ① 内核 ssh Transport | 平移 + 剥 SubstrateSecurity 依赖 + exec 补非 PTY 通道（stderr 分离，FEAT-03 改造点） |
| `runtime/local-driver.ts` + `session/local-session-manager.ts` | 639 | ① 内核 local Transport + 会话 | 平移 + logger 注入化 |
| `runtime/session/remote-session-manager.ts` | 323 | ① 内核远端会话 | 平移 |
| `runtime/session/stream-session-manager.ts`（观察流） | 254 | ① 内核观察流 | 平移 + SessionNotifier→事件接口 + stderr 双流改造（现状刻意合并，FEAT-05 改造点） |
| `runtime/session/session-buffer.ts`（纯逻辑窗口件） | 148 | ① 内核窗口基础件 | 原样平移（已零 I/O 零依赖） |
| `runtime/session/session-notifier.ts`（队列通知） | 55 | ③ 个人Agent项目 适配器 | 剥离出内核 |
| `runtime/tmux-driver.ts`（tmux Transport 适配） | 224 | ① 内核持久会话适配层 | 平移 |
| `terminal-manager.ts`（门面）+ `terminal/` 子系统（9 文件：launcher/registry/executer/invoker/output-buffer/interaction-bridge/liveness-probe） | 1,378 | ① 内核**持久会话本体**（FEAT-07 实现体；双消费者：RuntimeStack 持久层 + 个人Agent项目 `terminal_run` 工具族） | 平移 + logger/dataDir 注入化（耦合面仅 createLogger 与 getProjectRoot） |
| `runtime/factory.ts` / `runtime-stack.ts`（指纹/缓存/装配） | 253 | ② 组合层 | 平移 + 剥 chalk/cli-table3（展示进可选子包） |
| `runtime/fs-proxy.ts` / `runtime-process-manager.ts` | 634 | ① 内核（fs 安全/进程管理） | 平移 + workspaceRoot 注入化 |
| `runtime/layer-env.ts` / `layer-select.ts`（Adaptive Layer Phase A，2026-11-07 上产） | 637 | **拆分**：探测/蒸馏/规格持久化/匹配/环境身份键 → ① 内核（FEAT-16 净室移植）；`layer_info` 工具面 + promptSummary 环境行注入 + Credential Scrubber 双点 → ③ 个人Agent项目 侧 | 内核部分平移 + scrubber 换可选 hook；工具面与注入格式留仓 |
| `runtime-stack.ts#promptSummary`（LLM 注入格式） | — | ③ 个人Agent项目 侧 | 留仓 |
| PolicyEngine `capabilities` 拦截 / SubstrateSecurity | — | ③ 个人Agent项目 侧 | 留仓（经适配器注入） |
| `runtime/dynamic-queue-factory.ts` / `work-queue.ts` / `task-registry.ts` / `run-registry.ts` | 537 | ③ 个人Agent项目 侧（任务编排） | 留仓 |

> 对账补充：现有远端文件读写作 base64-over-PTY 分块（`tmux-driver.ts` fs 实现，受 PTY send-keys 缓冲上限约束），**无高层跨机传输 API**——FEAT-14（get/put + sftp 快路径）为 OSS 补齐项，非平移；`push_ssh` 为建层动作（再 ssh 进一台机器）而非文件推送，二者在 个人Agent项目 侧易混名，迁移期注意区分。

---

## 4. Technical Constraints
### 8.1 运行时与平台

- TypeScript-first；Bun 与 Node LTS 双运行时支持；发布 ESM（CJS 视生态需求评估）。
- **子进程与流底座统一 node: 标准库**：内核一律使用 `node:child_process`（spawn）/ `node:readline` / `node:events` / `node:crypto` 等标准模块，**禁止裸调 `Bun.*` 等 runtime 专有 API**（现状盘点：runtime/ 与 terminal/ 全线已零 `Bun.*` 裸用，天然双兼容——本条为将其固化为 CI lint 断言，防回退；不引入额外 SubprocessRunner 抽象层，除非实施期发现真实分歧点）。
- Windows + Linux 同构（跨平台红线）：不引入仅单平台的正确性依赖；平台差异（ControlMaster、tmux 缺席）自动降级并显式声明。

### 8.2 依赖声明（npm 依赖与系统依赖分列）与安全

**npm 依赖（内核）**：零第三方运行时依赖、零原生编译。展示类（chalk/cli-table3）只进可选子包。

**系统依赖矩阵**（能力 → 依赖二进制 → 版本底线 → 缺席降级）：

| 能力 | 系统依赖 | 版本底线 | 缺席/受限时降级 |
| :--- | :--- | :--- | :--- |
| local Transport（exec/会话/fs） | 无 | — | 零依赖，始终可用 |
| ssh Transport（含多跳链、`-J` 跳板、端口转发） | `ssh`（OpenSSH 客户端） | ≥7.3（2016，含 `-J`/ProxyJump）即全功能；ControlPersist 需 ≥5.6，现代发行版均满足 | Windows 内建 OpenSSH 无 ControlMaster → 多路复用自动退化直连（既有实证） |
| 大文件快路径传输（FEAT-14 ②） | `sftp`（随 OpenSSH 客户端分发） | 随 ssh | 缺席/失败自动降级 base64 管道并显式声明 |
| 持久会话 re-attach（FEAT-07） | `tmux` | 主流发行版默认版本 | 缺席 → 非持久模式显式降级（连接层功能完整，跨重启恢复不可用） |
| docker Transport | `docker`（或 podman/nerdctl，可配） | 由使用方环境决定 | 未安装时该 Transport 注册返回结构化错误 |
| k8s Transport | `kubectl`（或 oc/k3s，可配） | 由使用方环境决定 | 同上 |
| teleport Transport | `tsh`（自带 SSH 协议栈，**不依赖本机 OpenSSH**） | 由使用方环境决定 | 同上 |

> 矩阵口径：依赖按 **Transport 实现路径**声明，不做「一切远端能力依赖 ssh」的一概归类——docker exec 走容器运行时 API、kubectl exec 走 K8s API、tsh 走自有协议。**分层组合例外**：在 ssh 层之上 `push_enter` 进入 docker/k8s 层时，该组合依赖的是下层宿主链的 ssh，属组合事实而非本 Transport 固有依赖。

- 内核提供**能力探测 API**：`stack.features()` 返回 `{ mux, sftp, persistent, transports: [...], stderrSeparated }` 运行环境可用性（`stderrSeparated` 按层标注 exec 通道可否物理分离，见 FEAT-03），降级不靠猜（AC-02 断言）。
- 凭据显式结构化传入；日志/错误输出严禁包含私钥内容；主机密钥策略显式可配（FEAT-12）。
- 高危操作边界（FEAT-13 的 PolicyEngine 桥）属消费方策略，内核不越权预设。

### 8.3 版本与演进

- **版本口径**：v1.0.0 是目标正式版本（本 PRD 定义的 API 形态）；实际发布序列自 **0.x 预发布**起步，0.x 期间允许 breaking change（变更日志显式标注）；**M3 完成（含 AC-11 个人Agent项目 回迁零回归验证）即晋升 1.0**，此后按 semver 承诺 API 稳定。
- 里程碑分批：**M1** 内核提炼（driver 契约/ssh 底座/exec/会话/事件/文件）→ **M2** 观察流 + tmux 持久 + 连接指纹 → **M3** docker/k8s/teleport Transport + 个人Agent项目 回迁（AC-11）→ **M4** 生态（插件协议/文档站/示例库/**Agent 使用指引 FEAT-15**/**环境规格与层自发现 FEAT-16**）。
- 个人Agent项目 迁移策略：OSS 包稳定后 个人Agent项目 以依赖替换仓内实现，适配器（FEAT-13）承载剥离的集成点；迁移前后生产行为对照纳入验收。

### 8.4 许可证

- **Apache-2.0 单一许可证**（2026-11-07 定稿，弃双许可方案）；随包携带 `LICENSE`（Apache-2.0 官方原文）与 `NOTICE` 文件锁品牌归属：

```
Syrkos Filaxis (牵丝)
Copyright 2026 Corolin and Syrkos Contributors.

This product includes software developed as part of the Syrkos (漩核) project.

"Syrkos", "漩核", "Filaxis", and "牵丝" are brand names claimed by Corolin.

The Apache License, Version 2.0, does not grant trademark rights except as provided in Section 6 of that license.

All trademark rights, if any, are reserved by their respective owners.
```

- 所有分发物（npm 包 / 未来 Python 包）均须携带 LICENSE 与 NOTICE。
