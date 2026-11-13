# Filaxis 包说明书（给使用方 Agent 读）

> 本文件只描述 `@syrkos/filaxis` 包本身，**不接管宿主仓库规范**——你的项目自有其 AGENTS.md。API 签名与详细参考见版本化文档（本文件不复制签名副本，防漂移）。**动手前先读 [docs/skills/SKILL.md](./docs/skills/SKILL.md)**——30 秒选型决策树 + 契约速查 + 四份场景剧本索引。

## 心智模型

- **层（Layer）**：一个可执行环境（本机 / SSH 主机 / 容器 / 持久终端）。`stack.connect(descriptor)` 建立或复用。
- **会话（Session）**：长跑任务。`execSession` 即返（句柄：`sessionId/logBase/pid`），输出双文件落盘 + 热窗口。
- **观察流（Stream）**：独立 SSH channel 的真流式 tail——观察是廉价的，连接是稀缺的（自动复用主连接）。
- **观察窗（Stream Window）**：远端拉模式流反转为**本地推模式滚动窗**——帧号 per-window 单调递增（断连续编不归零）、peek 三模式全非破坏、多消费者游标互不干扰、stale 窗帧保留重连续编、关窗收割流进程。窗是滚动缓冲不是无限历史（完整历史查落盘日志）。
- **两个身份键，两个职责**：连接拓扑指纹管「复用哪条连接」；环境身份键管「这台环境是什么」（同落点经不同跳板路径=同一环境）。

## 核心不变量（执行语义的宪法）

> **没有经过验证的远端终态，就绝不能推导出执行成功；执行结果未知，也绝不能自动重放非幂等操作。**

四条落地形态：

1. **完成哨兵是唯一凭证**：exec 的退出码只认 `__FILAXIS_META_<nonce>` 尾缀（nonce 完整匹配 + 退出码可解析 + 取尾部出现）。无哨兵（断链/远端 kill -9/abort/信号杀）一律 `reject` 附半截现场，Error 挂 `outcome: "unknown"`——绝不 resolve 伪造退出码。
2. **Abort ≠ 远端已取消**：abort/超时杀的是本地 ssh 进程，远端进程树状态未核实——`AbortError` 同时挂 `outcome: "unknown"`，上层须按未知处理（核实或上报），严禁直接推导远端已停。
3. **内核零自动重放**：任何失败/未知路径都不自动重试非幂等命令——重放决策属上层（拿到 `outcome=unknown` 后先核实再决策）。
4. **PTY 会话是有状态资源**：任务 Promise 的生命周期与 PTY 会话可复用生命周期必须分离——当前命令终态未经可信确认（自己 nonce 的 $? 行或 ^C trap 行），同一条 PTY 不得交给下一条命令（四阶段 RUNNING/INTERRUPTING/DRAINING/IDLE；确认不了就销毁重建，绝不定时强行复用）。

## 防误用契约（用错就是生产事故的九条）

1. **终止即请求、死亡须核实**：`stop()` 返回 `{status: "exited" | "stopped" | "unknown"}`。`unknown`（断线/分区/核实超时）**不是成功也不是失败**——严禁当已清理继续往下走；用 `verifySession(sessionId)` 核实原语（远端 kill -0 + 退出码文件 + PID 身份戳三重实测：`running`/`exited(码)`/`unknown`），核实仍不可达才显式上报。
2. **退出码是数据**：`exec` 非零退出码**不抛异常**（如实在 `exitCode` 字段）；只有「无法执行」（超时/abort/连接死）才 reject。别把两者混为一谈。
3. **永不结束的命令不进 exec**：`exec` 是「等完成拿退出码」语义——`tail -f` / `top` / `watch` / 常驻服务进程会让它必然超时。限时快照用 `observe`（限时观察按流过滤）；长跑值守用 `execSession` + watcher（命中模式即收摊）。先问「这条命令会自己结束吗」，不会就别 exec。
4. **`ready()` 有窗口语义**：先回溯热窗口再等增量——`execSession` 与 ready 之间输出的标记不会漏；热窗口缺省 50 行（`maxLines` 可调，溢出计数 `evictedCount`）；若报「标记可能已滚出」（evicted>0），查落盘日志，别盲目重试。
5. **通道语义**：缺省 `channel:"exec"`（stdout/stderr 分离、**层上下文拼装**——层的 cwd/env/enter 进入管线〔`docker exec`/`ssh` 形态〕在独立通道自动非交互重放，exec 直达层内环境）；`channel:"pty"` 继承层内交互状态（su/cd），但 **stderr 混流是终端物理语义**，不是 bug。多跳 PTY 链与交互式二次跳转对 exec 通道**显式拒绝**——这是诚实行为，换 pty 或把途径机收敛为 `-J`。`-J`/`--host` 传 ssh-config **别名**时，别名解析用的是**本运行环境**的 `~/.ssh/config`——沙箱/远端会话里可能没有该条目（连接层报错会带此提示），跨环境请用 `user@host[:port]` 字面量。`jump` 只支持**单跳**（结构化 `SshJumpSpec` 正门/字符串白名单解析——跳板参数会拼进经 shell 执行的 ProxyCommand，白名单外字符直接拒绝）；多跳逗号链显式拒绝，多跳正门是层模型 `sshInto` 逐跳派生。
6. **跨流顺序**：双文件落盘后的聚合序是**本地到达序**（近似），不承诺进程真实写入序。
7. **方言适配自动进行**：base64/sha256 按连接探测缓存（OPNsense/Alpine 形态已测）——但你自己的远端脚本原语若依赖 GNU 方言，请同样探测，勿硬编码。
8. **CAS 校验 ≠ 写入原子性（两轴正交，看 `writeMode` 字段）**：受控编辑/传输缺省 tmp+mv 原子替换（`atomic-replace`）；**Docker 单文件 bind mount 挂载点 mv 不可用**（EBUSY/EXDEV）——自动降级保留 inode 写入（`inplace-write`）：写入中断可能暴露半截文件，消费方须知。已知挂载环境可显式传 `writeMode:"inplace"` 跳过失败尝试。`mutex`（锁保护）与 `verification`（校验等级）同理都是独立轴——别把四个保证混读成一个「成功」。
9. **PTY 键入大数据的边界（依赖面声明）**：canonical 行规程的 4096 在 Linux 实测是 **read 分段线而非丢弃线**（无 readline 的 sh 层 + 消费者忙/闲双场景、单行 16K 均完整——缓冲满时 master 写入被流控阻塞退避不丢；回归已钉住，退化即红）。但这**不是跨平台统一保证**（BSD 规程/老内核行为无承诺）；传输数据一律经 b64 中继（字母表对行规程/ICRNL/INTR/EOF 结构免疫，控制字符回归锁定）。非 Linux 环境 tmux 层传超大单行前先小载荷探路。

## 环境规格与漂移

探测结果只存蒸馏值（版本/有无/型号）；`upsert` 指纹不一致会标 **stale 且不覆盖**——重探是显式决定。nvidia-smi 驱动不通信的失败文案**不会**被记成 GPU 型号。

## 安全边界

host key 缺省 TOFU（accept-new：首连自动收录、已知主机不匹配则拒绝）；高价值环境请配 `hostKeyPolicy:"strict"` + `knownHostsFile`（缺省 `~/.ssh/known_hosts`）。**strict 模式下首连新主机会被直接拒绝**（不会自动收录）——运维流程：先在目标机上 `ssh-keyscan <host> >> known_hosts`（或人工首连一次 TOFU 收录后再切 strict）。凭据只传**路径**；所有渲染与日志永不含密钥内容。高危操作授权属你的策略层，本包不越权预设。

## 能力探测

部署环境缺什么，`await stack.features()` 说了算（`mux/sftp/persistent/transports/stderrSeparated`）——降级不靠猜。
