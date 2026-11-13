# Implementation Tasks: 牵丝 Filaxis：面向自动化与 Agent 的远程执行运行时 SDK (REQ-0001)

## Task List
- [ ] Task 1: **AC-01**: 内核包可独立安装使用（`bun add` / `npm install`），构建期断言内核入口零 个人Agent项目/消息队列/LLM 概念 import（依赖边界 CI 门禁）。
- [ ] Task 2: **AC-02**: Windows（OpenSSH 客户端）与 Linux 双平台行为同构；ControlMaster 缺席平台自动退化直连、tmux 缺席时持久会话显式降级非持久，且均可经 `stack.features()` 探测，有测试覆盖。
- [ ] Task 3: **AC-03**: Bun 与 Node LTS 双运行时全量测试通过（CI 双矩阵）；内核源码零 `Bun.*` 等 runtime 专有 API（lint 断言，统一 node: 标准库）。
- [ ] Task 4: **AC-04**: exec 语义完整——退出码如实返回不抛异常；**通道语义**：`channel:"exec"` 下 stdout/stderr 物理分离且层上下文拼装生效（cwd/enterSteps 管线重放——docker 层 exec 落在容器内、sudo 包裹层身份正确，断言测试）；`channel:"pty"` 继承层内交互状态；不可直达层 exec 显式拒绝并在 features() 标 `stderrSeparated:false`；timeoutMs 超时与 AbortSignal 硬中断均杀子进程并 reject；effectiveUser 双通道各自实测可追踪。
- [ ] Task 5: **AC-05**: 长跑会话全生命周期闭环——spawn 即返、全量日志落盘、热窗口 tail、行级 watcher 命中（string/RegExp/once）、stop 升级（SIGTERM→SIGKILL）、**终态三态可核实**（正常退出落 exited 带退出码；清理核实通过落 stopped；断线/分区/核实超时落 unknown——不把「已发终止请求」静默当成功）、无换行极端流防 OOM 切块，均有测试。
- [ ] Task 6: **AC-06**: 观察流真流式——行到达即推（无轮询间隔）、stdout/stderr 双流行对象（可按流过滤迭代）、watcher 命中事件、注意力衰减自动回收（TTL 内无消费且无 armed watcher）、回收广播事件，均有测试。
- [ ] Task 7: **AC-07**: 连接拓扑指纹复用——同指纹 descriptor 复用既有连接（连接计数断言），非身份字段（标签/运行态）变更不误建新连接。
- [ ] Task 8: **AC-08**: 持久会话 re-attach——tmux 后端会话在客户端重建后恢复（terminalId 绑定 + cwd 恢复），nohup 后台进程在 destroy 时被显式清理。
- [ ] Task 9: **AC-09**: Transport 开放注册——第三方 driver 经注册表接入且与内置 Transport 同权（docker/k8s/teleport 快捷方式与自定义 launchCmd 均可用）。
- [ ] Task 10: **AC-10**: 事件双形态——EventEmitter 与 AsyncIterable 均可消费全部内核事件；消费方异常不影响内核与流存活。
- [ ] Task 11: **AC-11**: 个人Agent项目 零回归迁移——个人Agent项目 改引 OSS 包后，现有 runtime 相关测试基线（stash 往返双全量差分）零新增失败，生产部署观察期无行为回归。
- [ ] Task 12: **AC-12**: 主机密钥策略显式化——默认 TOFU（accept-new）且提供严格模式与自定义 known_hosts 配置；任何模式不在文档/日志中泄露私钥内容。
- [ ] Task 13: **AC-13**: spawn 就绪握手——`ready({pattern, timeoutMs})` 在就绪标记出现前阻塞；**回溯匹配**（spawn→ready 调用间隙已输出的标记从热窗口命中，快输出进程用例验证不漏）；超时自动 stop 清理不留孤儿进程（tcpdump 竞态用例为验收样例）。
- [ ] Task 14: **AC-14**: README + API 文档 + 三个可运行示例（跨主机诊断 / 长跑观察 / Agent 工具面最小封装）交付。
- [ ] Task 15: **AC-15**: 文件传输 get/put 闭环——跨 Transport 可用（docker/k8s 走 base64 管道）、SSH 大文件走 sftp 快路径且缺席自动降级、传输后 size/sha256 校验和验证落位完整（**方言适配**：GNU/BSD/busybox 三族 base64·sha256 原语探测缓存，OPNsense（BSD base64 无 `-w`）与 Alpine（busybox）真实形态用例通过）、大文件分块可断点重试，均有测试。
- [ ] Task 16: **AC-16**: Agent 使用指引交付——包内 AGENTS.md（概念心智模型 + 语义契约防误用要点：终态三态/ready 回溯/通道语义/方言行为，与 §3.2 细则一一对应）+ 场景 SKILL 集（≥3 剧本：跨主机诊断/长跑观察/文件同步）；指引零 API 签名副本（链接版本化文档防漂移）；SKILL 无环境实例数据。
- [ ] Task 17: **AC-17**: 环境规格闭环——两段式探测（快/慢分离，缺运行时跳过）结果蒸馏落盘（原子写）；`match({needs})` 按需命中正确（真机 GPU 层用例：`needs:['gpu','torch']` 命中 GPU 机非 CPU 机）；环境身份键语义正确（同落点不同 hops 路径=同规格、不同端口=不同规格）；指纹漂移标记 stale 不自动覆盖；探测失败文案不误记为规格（nvidia-smi 不通信用例）；回显防御（含 `$(` 的值丢弃），均有测试。
