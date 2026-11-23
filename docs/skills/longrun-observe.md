# 技能剧本：长跑任务观察

> 场景：训练任务 / `tail -f` / 构建 / 数据管道——启动后离开，命中关键模式时立刻知道，结束时拿到可信退出码。面向 Agent 或工程师。
> 体量 ~1K tokens · **何时不用**：命令几秒内自己结束的（直接 exec 拿退出码）；只要一次性输出快照的（observe 限时采集更轻）。

## 先做对选择：exec 还是观察？

**exec 是「等命令自己结束拿退出码」的语义**。动手前先问一句：这条命令会自己结束吗？

- `tail -f` / `top` / `watch -n 1 nvidia-smi` / 常驻服务前台进程——**永不结束，进 exec 必超时**：
  - 只想看一段输出 → `observe`（限时快照，缺省 8s，按流过滤）；
  - 要值守等关键行 → `execSession` + watcher（命中模式即收摊）；
  - 容器里 → `docker logs -f <ctr>` 同理，走观察不走 exec。
- 一次性命令（`curl -v`、`nginx -t`、`systemctl status`）→ exec 没问题。
- 混合链（`curl -v ...; tail -n 20 error.log`）拆开看：`tail -n 20`（带 `-n` 的快照式）会结束、可以 exec；一旦写成 `tail -f` 就必须换观察。

## 剧本

MCP 长跑任务用 `spawn_and_observe` 启动，保存文本块里的完整 `session_id`、`log_base` 和目标层。持续看日志时，用 `observe_stream` 在同一层跟随 `log_base` 对应的 `.out` 或 `.err`，然后用 `read_stream` 续读。关闭观察窗会回收观察命令。任务自然退出后，用完整 `session_id` 调 `stop_and_verify` 获取可核实的退出码。会话归属缓存过期时，使用原目标层的 `layer`。

1. **启动即返，不要阻塞在 execSession**：长跑任务是会话不是 exec——`execSession` 返回句柄（`sessionId`/`logBase`/`pid`）后立刻挂 watcher，人再离开。
2. **watcher 三态用法**：
   - 等成功标记（如 `epoch=100`）→ `once: true`；
   - 等错误模式（`CUDA out of memory`）→ `once: false` + **thenStop**（命中即收摊——观察对象结束，观察者退场，防遗忘泄漏）；
   - 关注 stderr（告警通常走错流）→ 行对象带 stream 标记，按流过滤，别混着看。
3. **热窗口 vs 落盘日志**：日常看热窗口（内存快照）；窗口滚出的历史查落盘文件（`.out`/`.err` 分流）。**跨流顺序是到达序近似**——需要严格写入序的场景别依赖双文件拼接。
4. **结束的两种形态**：自然退出拿退出码（`exited`）；你主动停 → **核实终态**（`stopped`=确认死了；`unknown`=停止瞬间核实不可达——用 `verifySession(sessionId)` 核实原语实测：`running`/`exited(真实码)`/`unknown`；核实仍不可达才上报，严禁当已停）。
5. **无人值守的流要能自愈**：观察流无人消费且无 armed watcher 超时会被自动回收（并广播事件）——长期值守请保持 armed watcher 或定期 tail。

本地会话以及具备独立进程组的 SSH 和 tmux 会话，启动 shell 退出后会继续跟踪组内后台任务。后台输出仍可读取，组清空后才确认终态。旧会话的 `.code` 可能早于后台进程退出，无法核实其归属或终止时，停止结果为 `unknown`。

### SSH 重连后接管

在原目标层建立新连接，保留启动时的 `sessionId`。SDK 可用 `await driver.recoverSession?.(sessionId)` 恢复会话。返回 `running` 后可调用 `watchSession` 或 `stopSession`。新的 watcher 从接管时记录的 stdout 和 stderr 字节位置继续观察，历史输出可用 `readSessionLog` 补读。已结束的会话返回 `exited` 和原退出码。

接管运行中的任务需要 Linux `/proc` 启动身份及独立进程组的证据。证据缺失或身份不符时返回 `unknown`。`stopSession` 收到新连接中未登记的会话 ID 时执行同样的核实，每次发信号前再次比对身份。关闭连接会取消本地轮询和 watcher，已启动的远端任务可继续运行。

## 陷阱清单

- **流设备日志陷阱（Linux 实锤）**：容器/服务里的日志路径可能是 `/dev/stderr`、`/dev/stdout` 的软链或挂载（如 nginx 容器的 `error.log -> /dev/stderr`）——`tail -f` 流设备不会正常跟随，轻则空转重则挂死。先 `ls -l <log>` 或 `readlink -f <log>` 确认是真实文件再 tail；是流设备就改从进程 stderr 观察（`observe --stream stderr` / `docker logs`），别跟设备文件较劲。
- **慢消费者**：迭代读取跟不上产出时，事件队列会丢最旧并累计 dropped 计数——先查计数再断言「什么都没发生」。
- 探测 GPU 时 `nvidia-smi` 驱动不通信会输出整段失败文案——规格层已做收窄，你的自定义解析也要防。
- 会话终态的工具缓存有保留期限。过期时用原目标层和完整 ID 核实，或查落盘日志。
