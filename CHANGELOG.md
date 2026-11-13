# Changelog

本仓变更记录。条目来源标注（口径 2026-11-11 用户澄清）：

- **[Astra]** — GPT-6 Astra：审查弧初期几轮的具体缺陷（四~八轮），及最后的整体建议批（优先项与维护建议——额度耗尽后以建议收尾）
- **[Sol]** — GPT-6.1 Sol：其余大多数轮次的具体缺陷审查（九轮起接棒，Astra 额度不足）
- **[全量审计]** — 外部全量审计报告（H/M 系列）
- **[DeepSeek]** / **[Gemini]** — 其他外部审查与真机盲测
- **[自挖]** — 本仓维护者主动自查
- **[用户]** — 用户实测反馈

---

## 0.1.0（2026-11-13 · 摘帽首发）

以上 alpha.1–alpha.17 全部内容随本版正式发布。语义契约（终态三态 / 退出码是数据 /
完成哨兵 / 写入三轴 / PTY 四阶段）经五源审查 130+ 项修复与三季真实运维盲测背书；
CLI / SDK / MCP Server 三入口就绪。

### MCP Server（REQ-0003：Agent 工具面的结构化原生入口）

- **新增 `src/mcp-server.ts` + `bin/filaxis-mcp.ts`**：stdio MCP Server 薄壳（手写 JSON-RPC 2.0 子集零 npm 依赖——initialize 版本协商/tools/list/tools/call/ping；行分帧；通知无响应）；TOOL_DEFS 导出为单一来源（tools/list 同源序列化零漂移——11 工具全暴露，schema 断言锁定）；tools/call 直派 handlers + structuredContent 结构化透传 + isError 错误语义保留（EditConflictError/未命中/unknown 可程序化分支）；层绑定经启动参数（--host/--port/--user/--key/-J/--hop/--enter/--docker 与 CLI 同语义）；package.json bin 挂 filaxis-mcp
- 盲测痛点批：exec 增 `--stdin-script`/`--script-file` 免 Shell 命令通道（PowerShell ParserError 实测根因）；SKILL.md 10 秒复制即用配方 + Agent 形态升级路径（无速查时通读源码 44 万 Token 实测）；cat --help 拦截；edit 未命中免 Shell 通道指引 [盲测 B 组]

## 0.1.0-alpha.16（2026-11-13 · staged 等放行）

### 执行语义（终态三态 / 停止核实）

- ready 超时后停止结果诚实三态——unknown 挂 outcome+会话线索，不再谎称「已自动停止」[Sol]；顺线修 local-session 同款 [自挖]
- spawn_and_observe 启动后异常统一走共享 postLaunchFail（停止→核实→线索），observe_stream/CLI observe 全入口对齐 [Sol]
- stop_and_verify 停止通道抛错继续独立核实 [Sol]
- remote stop 先查 .code 再发信号（已退出会话不盲发 kill）；KILL 升级后仍活=unknown [全量审计 H3一][Sol]
- remote 停止/核实**进程组全树收割**：wrapper setsid 自成组长+.pgid 落盘，组感知停止/核实——多层脚本的孙进程不再漏杀谎报 stopped（真机三层树验证残留 0）[Astra]
- tmux stopSession 死亡证据三态化（CODE/DEAD/NOEV 探针，证据全缺=unknown 绝不 stopped）；先探针后信号；KILL 升级三段；探针失败/损坏记录（`CODE:7oops`）不采纳不进信号段 [Sol]
- verifySession 核实原语（.code 采纳+PID 身份戳+组感知存活），stopSession 接口类型收窄三态 [DeepSeek]
- 幽灵会话根除：启动握手两道闸（FX_MKDIR_FAIL / FX_SPAWN_FAIL）+ wrapper 亲写 .pid + 3s 等待窗；启动超时诚实 outcome:unknown [Sol]
- 终态尾行冲刷 flushTail 全 5 路径（无尾换行末行也喂 watcher）；日志消费会话级互斥 consumeChain（并发双消费/游标双跳根除）[Sol]
- 轮询改字节游标 tail -c（行对齐消费——半行不跳不重）；轮询链式调度防重入 [Sol][全量审计 H2]

### 安全（注入面 / 身份核验）

- 跳板 -J 参数化收口：结构化 SshJumpSpec 白名单（注入形态全拒）+ 策略传导 + 多跳显式拒绝；ProxyCommand 等价形态修复跳板 host key TOFU [Sol]
- PTY 二次渲染引用层（单引号包裹）+ 前导 `-` 选项注入拦截 [Sol]
- cwd 拼装安全引用 + cd 失败 fail-closed（退出码是数据：126）[Astra]
- env 三层语义统一：local 生效 / ssh exec 前缀注入 / PTY 与 tmux 显式拒绝；getEnv 改 printenv [Sol]
- 会话名/会话 ID 白名单校验收敛为共享机制 sanitizeSessionName + sessionBase（创建/读取/停止/核实全链——tmux 曾两处注入实锤）[Sol]
- PID 身份戳（/proc starttime）比对防复用误杀：stop 发信号前 + verify 判活 [全量审计 H3二][Sol]
- stdin 管道错误监听三处（shell/ssh/sftp 提前退出的 write 崩宿主根除）[Sol]
- file-transfer 并发独占临时名、校验先行于落盘、目标零污染链、空文件支持、校验等级显式（sha256|size）[Astra]
- M5 SFTP 路径 \n 注入与选项歧义双拒绝 [全量审计]

### 观察窗与会话引擎

- 观察流收尾统一到 close（跨 exit/close 半行拼合）+ 常驻 watcher meta 保护 + pending 64KB 保尾 [Sol]
- 跨块 UTF-8 全链 StringDecoder（stream-window/local/stream 三面）；观察流分块安全（块边界≠行边界≠UTF-8 边界）[Sol]
- 行回调内 stop() 不再打乱交付序（deferred finalize——本块按到达序交付完再收尾，exit 不抢跑 watcher）；超长行截断跨块一致（boundLine 头尾各保半——换行符落在哪块不再决定 watcher 结果）；onScreen 桥补 async 拒绝隔离；finalized 后迟到 data 零幽灵回调 [Sol]
- 本地观察窗：spawn error 监听（不崩宿主）、双流分离 Splitter、收尾统一到 close、并发同名预留、dispose 并发收割 [Sol]
- 同名窗重开帧号续编（文档「续编」承诺兑现——旧游标无缝续读不再静默漏帧）+游标超前 gap 显式；peekSince 增 lastDeliveredSeq（限页翻读续读锚——newestSeq 会跳未读帧，文档同步改写）；快照帧浅拷贝（改写返回帧不再殃及共享缓冲）[Sol]
- 续编锚独立字段 allocatedSeq（空窗 stop 不再归零覆盖已存帧号+空窗 peekSince 不误报 gap）；本地窗未完成行封顶（等待换行期间 buf 随输出无限涨——32MiB 无换行实测堆涨同量；封顶与入窗截断同公式，整行/分块输出逐字节一致）[Sol]
- exit 2s 兜底（孙进程持管道 close 永不发场景）+ 终态后 late data 拦截 + watchers 终态封板 [自挖·孪生审计]
- 跨 realm Promise 拒绝隔离收敛 async-guard 单一来源（EventBus on/once + 三会话管理器 onEvent + onLine/onExit 桥）[Sol]
- 事件总线四代迭代定稿：per-registration 记录表（同回调双注册/退订不损坏）、函数引用键（闭包碰撞根除）、入队前类型过滤、iterable 事件驱动取消+同步收尾 [Sol]
- computeDelta 尾部空行区归一（tmux 16K CI flake 根治——渲染填充不再骗「宁重复不丢」）[自挖]

### 连接与层管理

- 自定义工厂/注册驱动缓存命名空间隔离（B 不再拿 A 的连接）[Sol]
- driverKey 全量 config 入指纹 + fallbackCwd 归一化 + enter 别名归一 [Sol]
- connect 并发去重（in-flight 共享，init 失败清缓存销半建）[Sol]
- 并发同名建层预留 withNameReservation 全入口；身份判重限 SSH 双向（候选层过滤）[Sol]
- 共享连接多订阅者登记表 + per-stack 稳定闭包幂等订阅 [Sol]
- 事件桥：缓存命中/in-flight/首建三路径全登记订阅 [Sol]

### 编辑与传输

- writeMode 拆分（atomic-replace / inplace-write 两轴正交）——bind mount 深水区定案；三轴显式报告（mutex×verification×writeMode）全链透传 [用户][Sol]
- 多层 enter heredoc 逐层包裹（静默丢层根治——假成功比报错恶劣）[用户实测]
- H4 UTF-8 有损转换拒绝（decode→encode 回验）；H5 mv 保 symlink 拓扑+属性 [全量审计]
- editFile 真 2-RTT CAS（stat+sha256 内容指纹+flock；openssl fallback 摘要 bug 根治）[用户][Sol]
- mutex 保护等级（flock|degraded）贯穿调用链；flock 能力缺失与加锁失败分治 [Astra]

### tmux 后端

- execSession 启动握手对齐 remote 模板（FX 闸/wrapper .pid/等待窗/.st 戳）；wrapped 子 shell+换行（业务 exit 隔离+尾注释防吞）；env 支持；.st 守卫 kill [自挖·孪生审计]
- send-keys 命令长度硬边界 12K 收紧 + readFile 分页（pane 滚动窗口物理边界）[自挖·真机]
- PTY 键入大数据实证钉住（canonical 4096=分段线非丢弃线）[自挖·真机]
- M2 滚屏重叠 Delta / M6 NULL_DIALECT 永久缓存根除 [全量审计]

### 终端画面解析（VT100）

- rows:1 单行画面换行滚屏 TypeError（shift 后读空数组宽度）根治 [Sol]
- 宽字符显示列模型：CJK/emoji 占双格（右半空串占位 join 隐形）、光标/定位/退格按显示宽度、覆盖写清理宽字符残半、光标不落宽字符中间、autowrap 宽字符整体折行 [Sol]
- 擦除联动宽字符另一半（只清左半=占位折叠视觉左移）；OSC 终止符 ST（ESC 反斜杠）不再落画 [Sol]
- CSI 参数集补冒号（ITU T.416 子分隔符）——真彩色 SGR（38:2::R:G:B）不再中途退出污染画面 [Sol]
- CSI 完整消费（ECMA-48 参数区+中间字节——私有前缀/空格序列 ESC[>0c、ESC[2 q 整体吞掉）；csiBuf 128 上限+超限作废（无界参数流封顶）；DCS/SOS/PM/APC 字符串族吞载荷；嵌套 ESC 边角（ESC 态保持/CSI 态中断重开）[Sol][自挖·深排]
- CSI 命令空间分治：带中间字节/私有前缀的序列（ESC[2 SP A=SL 右移）不再剥杂质误入公有命令（曾当 CUU 上移写错行）——整体忽略；字符集选择族（ESC ( B）中间字节进 state4 吞终结字节（末字节曾落画）；LF 收编 wrap-pending（写满行后 LF+X 曾连跳两行）[Sol]

### 工具面 / CLI / 文档

- npx 兼容（bin 指编译产物 + CI Node 冒烟）[用户]
- ssh 形态 enter 非交互重放 + 拒绝文案 AI 可操作化 + --pty 开关 [用户实测]
- CLI `--` 终止选项解析 [Sol]
- runBatch 空计划内核级拒绝；编辑保护信息三层透传 [Sol][自挖]
- SKILL.md 总入口（选型决策树+契约速查+剧本索引）[用户]
- verifySession/文档八坑（命名统一/阈值漂移/strict 流程/成熟度列）[DeepSeek]
- README CI 覆盖如实分项（跨平台承诺不超前于验证）[Astra]
- 测试名与实际验证对齐（「CLI observe 读取异常」实为正常冒烟——如实改名；空输出假失败定位=时序窗过窄）[Astra]
- 全文档一致性扫描（spawn→execSession 等横切漂移 5 处）[用户]

### 执行健壮性（Gemini Hydrogen 全仓审查批）

- PTY 执行期断链即时感知（markerCycle poll 检 ready=false 立即 unknown——原空等 timeoutMs+5s 兜底）；入场预检（排队期 abort 已触发/前序 kill 后链死不空写 stdin）；editFile bytesAfter 全线字节口径（原 UTF-16 码元数——含中文时必误报）；空文件可编辑（size=0 有有效 sha）；观察流自然退出条目 TTL 回收（原仅 stop 删=泄漏）；不再 rmSync 共享 mux socket（execChannel 复用同 socket 不计 refCount——ControlPersist 自管过期）；enterCmd 词法分词（引号内空格路径曾按空白截断）；remote 会话派生路径全线 q() 引用+logDir 构造卫生（空白/单引号拒绝）；local verifySession pid 实测正门（原强转私有字段且不实测）；CLI exec 改 exitCode 不跳过 destroy；--port/--timeout/--duration 数值守卫；edit --write-mode 透传 [Gemini Hydrogen]

### Agent 实战体验（第十一季盲测痛点批）

- exec 增 `--stdin-script`/`--script-file` 免 Shell 命令通道（复杂脚本经宿主 Shell 转义常被拦死——PowerShell ParserError 实测；与 edit --stdin-json 同哲学）；SKILL.md 增 10 秒复制即用配方（盲测实测：无速查时 Agent 通读源码花 44 万 Token 零命令）+ Agent 形态升级路径指引（CLI 无状态短连接的局限→Toolkit 常驻）；CLI 冷启动提示已含 --layer 寻址 [盲测 B 组 transcript 深挖]

### 执行健壮性（Sol 五十二期）

- 本地窗 LineSplitter 迭代重写（递归处理剩余曾随块内换行数增长栈深——64KiB 短行批实测 18,473 帧 RangeError 栈溢出）；逐行截断判定（曾按整块长度——同批到达的短行被误截断，逐行判定后 12B 上限三行全完整）；maxFrames:0 显式无缓冲（slice(-0) 曾复制全数组失去上限）+peekLast(0/负) 返回空+newestSeq 无缓冲回落 allocatedSeq（号段不丢）[Sol]

### 执行健壮性（Gemini Hydrogen R11）

- tmux readFile 大分支双修（base64>tmp 曾分号连接——失败仍建空 tmp、wc 返 0 exit 0=静默空串；total 异常 throw 曾在 try 外遗留临时文件——挪 try 内走 finally 清理）；remote finalize 条目 60s TTL 回收（local 有 ttlTimer、remote 曾无——长驻进程 RemoteEntry 永久滞留内存累积）[Gemini Hydrogen]

### 执行健壮性（Gemini Hydrogen R10）

- LocalFileSystem 相对路径基于 descriptor.cwd 解析（曾落 process.cwd——与 ssh 层不一致，同代码跨后端读写不同文件）；tmux readSessionLog 补 offsetLines（曾静默忽略）；run_batch 步骤 id 空值入口显式报错（String(undefined)="undefined" 曾绕过内核校验）+edit 步骤 write_mode 透传（BatchEditStep/schema/editFileMulti 全链）；hopLabel 非法 jump 容错降级（曾令 layer list 整体崩溃）[Gemini Hydrogen]

### 执行健壮性（Gemini Hydrogen R9）

- 交互 Prompt 检测正则去 m 多行标志（历史输出中段 password: 字样曾误触发——$ 匹配每行行尾）+空 patterns 永不匹配（(?:) 曾匹配任意文本每轮误判）；pushChild/pushInto 清全部 10 个 enter 族别名（只清 3 个曾漏 7 个——父层容器命令残留在新主机重放）；tmux init 携 terminalId 重连显式 has-session 探活（restore 死会话曾静默成功到首次 exec 才炸——快失败）；timeoutMs 边界守卫（0/负/NaN 曾被 falsy 判断静默禁用超时或立即触发——CLI --timeout/--timeout 正数校验+驱动层显式拒绝）[Gemini Hydrogen]

### 执行健壮性（Gemini Hydrogen R8）

- PTY execMarker 子 shell+换行隔离（尾注释 `ls # x` 曾把 marker 全注释=挂死 120s+整链销毁；业务 exit 曾杀持久会话本体；hasRedirect 字面量误判曾跳过包裹——总是包裹最稳）+trap INT 用后即清；非 GNU 权限保持（chmod/chown --reference 仅 GNU——macOS/BSD/busybox 上 0600 私钥 editFile 后静默退化 0644；改 stat -c '%a' 数字模式 chmod NNN 全平台，真机 600→600 实证）；readLog lines 尾窗走尾部块读（曾 64MiB 全量读+split=数百 MB 堆峰——只读 lines*512B 尾块）[Gemini Hydrogen]

### 执行健壮性（Gemini Hydrogen R7）

- tmux 无尾换行末行不再静默吞掉（printf "OK" 与 marker 粘连曾被整行丢弃=空 stdout——marker echo 前置换行+strip 保留前缀；退出码先捕获再 printf——`$__fx_ec` 防 `$?` 被 printf 覆写）；ssh-pty PTY 通道 cwd 子 shell 支持（曾静默忽略——错目录操作隐患）；observe_stream/CLI observe 行数归一（local 热窗 50 vs remote 双流 1000 的 20 倍差——统一 readSessionLog 按流读+尾窗 500，自定义 driver 回落 tailLines）；toolkit descriptor 初始层注册命名表（list_layers 可见/push_into 有源）+建链失败不缓存（rejected Promise 永久复用=不自愈——每次重连）[Gemini Hydrogen]

### 执行健壮性（Gemini Hydrogen R6）

- 会话 .pid 原子落位（tmp+mv——创建与写入间隙 cat 读空→NaN 误报启动失败；remote/tmux 双修）；knownHostsFile 与策略正交（tofu 模式曾静默忽略——独立信任锚隔离意图失效，主连接+跳板 ProxyCommand 双修）；peekSince(0) 环形覆盖显式 gap（sinceSeq>0 曾把「从头读但历史已滚出」屏蔽=新消费者无感知丢帧）；重连完成后销毁竞态复查（不复活已销毁层）+重连期 exec 通道放行（独立连接不依赖 PtyLink）；local start 双修（logStreams error 监听+spawnImpl 异常回滚 entries/句柄——磁盘满崩溃与 fd 泄漏）；mux ControlPath 超长降级直连（macOS sun_path 104B——长 TMPDIR 下 too long for Unix domain socket）[Gemini Hydrogen]

### 执行健壮性（Gemini Hydrogen R5）

- local exec 超时/abort 后台续跑输出不再崩宿主（logStream 补 error 监听+data 侧 finished 守卫——原 ERR_STREAM_WRITE_AFTER_END 直崩）；ssh-pty init cwd 改真 PTY 通道（曾误调 execChannel——目录从未切换+多跳层 init 必败）；tmux execSession 组杀全树（setsid+.pgid 对齐 remote——单杀主 PID 漏孙进程谎报 stopped；真机三层树七进程组内残留 0 实证）；exec 通道四处 StringDecoder（PtyLink 双流/execChannel/本地 exec/tmux-invoker——跨 64KB pipe 边界多字节 UTF-8 撕裂）；临时文件 NAME_MAX 安全后缀（basename 近 255B 时截断+短 hash——ENAMETOOLONG 根治）[Gemini Hydrogen]

### 执行健壮性（Gemini Hydrogen R4）

- PTY 交互提示半行检测（password:/passphrase: 提示末尾无换行——只测完整行=滞留 pending 干等 20s；对未成行缓冲同测立即快速失败）；SshPtyDriver.fs 全操作查 exitCode（readFile 曾静默返回空串——runBatch read 步骤误报 ok）+远端 b64 直出本地解码（BSD base64 无 -d+二进制 UTF-8 拼接损坏双修）；tmux exec 支持 cwd（曾静默丢弃——误操作错误目录风险）+AbortSignal 显式拒绝指路；runBatch 工作池调度（曾波次屏障——同批慢步骤拖住全部空槽）；CLI --hop IPv6 防误拆（[ipv6]:port 方括号规范，裸多冒号整段作 host）+--docker 族白名单；readdir `command ls` 绕 alias [Gemini Hydrogen]

### 执行健壮性（Gemini Hydrogen R3）

- CommandExecuter 实例化（曾全 static——多 TerminalManager 静默互覆配置/共享锁链）；verifyLanding 边界匹配（裸 includes 曾让 web 匹配 web-bastion——FQDN 边界或全等）；connect 在途被 evict 后自毁不回填缓存（finally 只清自己的登记）；driverKey 键序 canonical（等价配置不再因字面量键序重复握手）；sftp batch 路径卫生（不 q()——解析器不认 shell 引号；引号/空白拒绝+指引 base64 管道）；remote poll 双流增量（stderr 行进 watcher——与 local 对齐）+组感知存活口径（与 stop/verify 同口径）；spawn_and_observe ready 轮询崩溃快速失败（每秒核实——启动即崩带真实退出码，不再空等 15s）[Gemini Hydrogen]
- **组信号命令全线 /bin/kill 绝对路径**：dash 的 kill 内建不认负 PID（`Illegal number: -`）——组杀/组探测在 dash 目标上曾静默失效（bash 目标掩盖）；真机 dash 复现链（poll 每轮存活探测误判死→watcher 永不命中）定位，真机 39 pass 复核 [自挖·真机]

### 执行健壮性（Gemini Hydrogen R2）

- tmux 不活动超时复活（存活检查曾每轮无条件重置 lastActivityAt——no_output_timeout_ms 形同虚设，违背「只杀哑不杀慢」）；交互 Prompt 空回复不再零延迟忙等（曾跳过 sleep 100% CPU）；local ready() 进程提前退出即时报错（曾空转到超时误报）+预退分支补 cancel+正则剥 g/y；stop 的 SIGKILL 升级定时器查 running（不再对已退 PID 补刀——PID 复用误杀面）；StreamWindow/LineSplitter 负索引截断防护同步（maxLineBytes<后缀长时越截越长——session-buffer 同款修复漏同步）；session-launcher 快捷渲染全线 shellQuote+sshOptions 危险字符拒绝（finalCmd 经 shell 执行的注入面）；LayerEnvStore 原子写 tmp 带进程 nonce（多进程并发踩踏）；EventBus.once 可被 off 取消（曾不记映射）[Gemini Hydrogen]

### 测试与稳定性

- 冷路径全仓摸排 57 路径+深入探针 28 条 [自挖·Astra 批评落实]
- 全弧孪生对齐审计（三十余期修复模式×全仓孪生面矩阵）[用户令]
- 注入面全仓深排（shell 模板插值点机械扫+逐条核）[用户令]
- 真机验证环境常设（bun+tmux+ssh 非标端口+跨跳板 -J 形态）[用户]

## 0.1.0-alpha.15（2026-11-10 · staged 等放行）

- enter 族语法糖（别名归一）+ 拼错键防线（编辑距离 ≤1 明拒）[用户实测]
- 发布物泄漏止血（files 白名单精确化 docs→docs/skills）[用户发现]

## 0.1.0-alpha.14（2026-11-08）

- 批次组合层 runBatch（after DAG + fail-fast + 逐步骤证据）[用户设计]
- CM 复用下沉（exec/观察共享 master）+ CLI 层快照（layer save/--layer）[用户]

## 0.1.0-alpha.13（2026-11-08）

- editFile 真 2-RTT（探测合成进读往返）；driverKey 丢三列（enter/hops/pty）补齐 [自挖]

## 0.1.0-alpha.12（2026-11-08）

- CLI 全量透传路径三件套（--hop/-J/--enter/--docker/--forward/--host-key）[用户否决阉割版定全量]

## 0.1.0-alpha.11（2026-11-08）

- observe 漏 await 根治 + edit 免 Shell 通道（--stdin-json/--request-file）[自挖][GPT 裁决]

## 0.1.0-alpha.10（2026-11-08）

- Claude 深审四问题收口：tmux destroy 误杀 / PTY 生命周期四阶段落地 tmux / local 执行审计一致性 / release 补 build（alpha.6~9 包缺 dist）[Claude]

## 0.1.0-alpha.9（2026-11-08）

- 进程树收割（POSIX 组杀+Windows taskkill）/ tailLines 双流 / editFile 2-RTT CAS [Gemini 盲测]

## 0.1.0-alpha.8（2026-11-08）

- editFile 一级导出 + toolkit 六工具 + `filaxis` CLI 五子命令 [Gemini 盲测]

## 0.1.0-alpha.7（2026-11-08）

- VT100 虚拟屏 + onScreen 屏桥（ncurses 光标重绘流可读化）[用户拍板]

## 0.1.0-alpha.6（2026-11-08）

- 观察窗下沉（StreamWindow/Registry）+ 冷启动握手顺带取身份 + discoverLayer 异步探测 [用户观察]

## 0.1.0-alpha.5（2026-11-08）

- PTY temporal isolation 四阶段（跨任务残影串台根治；超时只归还调用方 Promise，会话锁 DRAINING 等可信终态）[Gemini 故障注入]

## 0.1.0-alpha.4（2026-11-08）

- 完成哨兵原则 + outcome:unknown 语义（abort≠远端取消；无验证终态绝不推导成功）[Gemini 故障注入]

## 0.1.0-alpha.3（2026-11-08）

- ssh -tt 残留挂事件循环根除 / POSIX sh 通吃（FreeBSD/Alpine）/ DSM 探测 fallback [Gemini 真机巡检]

## 0.1.0-alpha.2（2026-11-08）

- resolveLocalShell（WSL 入口坑/Defender 扫描防护）/ files 白名单补齐 / createAgentToolkit 双层工具面 / watch 回溯匹配 [Gemini 试用]

## 0.1.0-alpha.1（2026-11-07）

- 首发 npmjs（stage publish 流程打通）

## 0.1.0（2026-11-07 · init）

- 牵丝 Filaxis 立项首发：执行内核/事件组合层/消费方三层；内核四红线（零个人Agent项目概念/零消息队列/零 LLM/零 npm 第三方依赖）
