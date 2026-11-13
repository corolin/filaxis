# 技能剧本：流式观察窗（Stream Window）

> 场景：需要**持续观察**多条远端/本地流（tail -f / docker logs / 训练日志 / 抓包），随时按需快照读取、断点续读、多消费者共享同一条流——不重复建流、慢消费者不阻塞远端。面向 Agent 或工程师。
> 体量 ~1K tokens · **何时不用**：等一个关键行就走的（execSession+watcher 更轻）；一次性 tail -n 快照（observe 足够）。

## 剧本

1. **命名即地址**：窗名建议 `层:用途`（如 `gpu:train`、`fw:drop`）——通配 peek（`gpu:*`）按前缀聚合。同名窗未 stop 不可重建（防双流）。
2. **开窗即订阅**：`registry.open({name, layerAlias, command, manager})`——local 窗走本地 shell；remote 窗走 `StreamSessionManager`（引擎真流式，ControlMaster 共享主连接——观察是廉价的，连接是稀缺的）。
3. **读取三模式，全非破坏**：
   - `peekLast(n)`：最近 n 帧（快照）；
   - `peekWindow(ms)`：时间窗帧；
   - `peekSince(since, n, consumerId)`：断点续读——帧号 per-window 单调递增、断连续编不归零；**消费者游标 per-consumer 互不干扰**——多 Agent / 多面板各读各的进度。
4. **续读的正确姿势**：拿本次返回的 `lastDeliveredSeq` 当下次 `since`（**不要用 `newestSeq`**——限页翻读时它是窗内最新帧，拿它续读会跳过未读帧；带 `consumerId` 则游标自动记，`consumerSeq(id)` 直取）。返回 `gap: true` = 中间发生了环形覆盖（帧滚出窗）**或游标超前**（旧窗游标/异常值）——**显式空洞不是错误**，需要完整历史时开大 `maxFrames` 或落日志文件（窗是滚动缓冲不是无限历史）。
5. **断流与复活**：流进程退出/断连 → `stale: true`（帧保留，`seq` 冻结）——重开同名窗**续编**（新流从冻结的 seq 之后继续）。
6. **关窗收割**：`registry.stop(name)` 会**收割流进程**（不是只删窗）——防遗忘泄漏；空引用窗超 TTL 自动销毁（注意力衰减语义）。

## TUI 全屏程序（watch/htop/nvtop）——VT100 屏桥

- ncurses 程序按 `[row;colH` 光标定位**增量重绘、不输出换行**——行模式对它退化（数据在但不可读）。
- 用 `onScreen` 桥：`manager.start(cmd, { onScreen: (snap, frames) => ... })`——原始 chunk 喂 `Vt100Screen` 虚拟屏后回调**字符级高清截屏**（每 chunk 一帧，与 `onLine` 可并存）。
- 也可独立用：`const s = new Vt100Screen(); s.feed(chunk); s.snapshot()`——50 行级状态机（CUP/HVP/ED/EL/CUU..CUB/LF/CR/BS/TAB/autowrap/滚屏；SGR/OSC 忽略）。
- 典型帧：`watch -n 1` 首屏约 2KB 全画，之后每秒只发 31~40B 增量包（时钟秒数/变化的那一个数字）——截屏随时高清。

## 陷阱清单

- **窗≠日志**：窗是滚动缓冲（默认 200 帧 × 1KB 截断），完整历史查落盘日志（`session log` / 会话双文件）。
- **peek 是非破坏读**：多读几次幂等；`peekSince` 才推进游标。
- **stale 窗不自动重连**：stale 只是「流断了」的显式状态——是否重开是剧本决策（`stop` 后 `open` 续编）。
