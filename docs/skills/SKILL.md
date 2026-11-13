---
name: filaxis-runtime
version: 0.1.0
description: |
  牵丝 Filaxis 远程执行运行时的技能剧本总入口——选型决策树（exec 还是观察还是会话）+ 核心契约速查 + 四份场景剧本索引。

  必读于（借鉴 modern-web-guidance 的触发清单设计）：
  - 任何跨层/远程执行、观察、会话、文件编辑、多机排查任务开始前
  - 拿到 unknown 终态 / 写入三轴结果需要解读时
  - 连接层失败（别名/跳板/多跳不可直达）需要自救时

  不必读：
  - 纯本地一次性命令（本机 shell 能直接解决）
  - 与本 SDK 无关的任务（数据库/CI 管线/纯前端）
---

# Filaxis 技能剧本 · 总入口

> 这份是**引导与选型**：先在这里定打法，再进具体剧本。API 签名见包内版本化文档；语义契约全文见 [AGENTS.md](../../AGENTS.md)。

## 10 秒上手：复制即用配方（禁止先读源码——盲测实测通读源码花 44 万 Token 零命令）

```bash
# ① 建层（一次性；之后全部 --layer 复用，免拼连接参数）
filaxis layer save <名> --host <user@跳板> --enter "ssh <目标机>"   # 无 ProxyJump 多跳正道
filaxis layer save <名> --host <user@主机>                          # 单层直连

# ② 执行 / 读文件（之后所有子命令都吃 --layer）
filaxis exec --layer <名> -- "nginx -t"
filaxis cat --layer <名> /etc/nginx/nginx.conf

# ③ 复杂脚本免宿主 Shell 转义（引号/多行/Python -c 直达）
cat script.sh | filaxis exec --layer <名> --stdin-script
filaxis exec --layer <名> --script-file payload.py

# ④ 编辑免引号地狱（含引号/多行时禁用行内参数）
echo '{"old":"a: 1","new":"a: 2"}' | filaxis edit --layer <名> <path> --stdin-json
filaxis edit --layer <名> <path> --request-file edit.json

# ⑤ 挂起类命令（nc/ping/tail -f）必带 --timeout——CLI 缺省 120s
filaxis exec --layer <名> --timeout 8000 -- "(printf 'PING
'; sleep 1) | nc 127.0.0.1 6379"
```

**MCP 形态实战指引**（第十二季盲测 B 组教训）：
- **定位/巡检期用 `run_batch` 打包**——多个 read_file/run_command 一次调用并行
  执行（B 组逐个调 18 步 vs CLI 组打包 11 步——这是 MCP 形态省步数的最大杠杆）；
- 建链后立即干活，**不要**逐个 hostname/list_layers 验证——首个 run_command
  的 `[exit=N user=X]` 就是活链证明；
- 大输出（日志/配置全文）用 `read_file` 而非 `run_command cat`——结构化返回
  不占对话输出面。

**Agent 形态升级路径**：CLI 每条命令独立进程（连接不复用）。高频操作时换 SDK/
`createAgentToolkit` 常驻形态——连接/PTY 复用 + 结构化参数（edit 直接传对象免
临时 JSON 文件 + batch 直接传数组免 plan 文件），步数与 Token 双降（盲测实证
阶段二 non_cache 省 17.7%）。

## 30 秒选型：你面对的是什么？

```
命令会自己结束吗？
├─ 会（一次性：curl/nginx -t/systemctl status）→ exec（退出码是数据）
├─ 不会（tail -f/top/常驻服务/训练）
│   ├─ 只想看一段输出 ────────────→ observe（限时快照，缺省 8s）
│   ├─ 值守等关键行/错误模式 ──────→ execSession + watcher → longrun-observe.md
│   └─ 需要持续 TUI/多消费者游标 ──→ 流式窗（stream-window.md）
└─ 要改远端文件 ──────────────────→ editFile 受控编辑 → file-sync.md
                                    （传输 put/get 也在 file-sync.md）
跨主机排查/抓包对照/跳板拓扑 ────────→ cross-host-diagnosis.md
```

## 核心契约速查（违者=生产事故）

| 契约 | 一句话 |
|---|---|
| **终态三态** | `exited`（有真实退出码）/ `stopped`（死亡已核实）/ `unknown`（核实不可达——**既非成功也非失败**）；unknown 后用 `verifySession(id)` 实测（running/exited/unknown） |
| **退出码是数据** | exec 非零退出码不抛异常；只有「无法执行」（超时/断链/abort）才 reject |
| **完成哨兵是唯一凭证** | 无哨兵（断链/远端 kill）= reject + `outcome:"unknown"`——绝不伪造退出码，绝不自动重放非幂等命令 |
| **永不结束的命令不进 exec** | exec 是「等完成」语义——`tail -f`/`top` 必超时；换 observe / 会话+watcher |
| **写入三轴别混读** | `mutex`（锁保护）× `writeMode`（原子/保留 inode）× `verification`（校验等级）——一个「成功」背后三个独立保证，逐个看 |
| **PTY 通道 stderr 混流** | 终端物理语义不是 bug；exec 通道才分离 |
| **别名是运行环境的** | `--host`/`-J` 的 ssh-config 别名用**本运行环境**的 `~/.ssh/config`——跨环境用 `user@host[:port]` 字面量 |

## 剧本索引

体量列≈tokens（按需取用——总入口读完再来，不必全量预读）。

| 剧本 | 场景 | 关键坑 | 体量 |
|---|---|---|---|
| [longrun-observe.md](./longrun-observe.md) | 长跑任务：启动离开、命中即知、终态可信 | 流设备日志软链；慢消费者 dropped 计数 | ~1K |
| [file-sync.md](./file-sync.md) | 受控编辑/文件传输（免 sed -i 写坏） | UTF-8 契约；写入三轴；bind mount 降级 | ~0.9K |
| [cross-host-diagnosis.md](./cross-host-diagnosis.md) | 多机协同取证（抓包+探测+对照定责） | 就绪握手竞态；-J 别名环境依赖；BSD 方言 | ~0.8K |
| [stream-window.md](./stream-window.md) | TUI 增量流/多消费者游标续读 | gap=显式空洞；stale 不自动重连 | ~1K |

> **防幻觉纪律**：以上四份就是全部剧本——场景不在其中时，别虚构剧本或参数；去读
> [AGENTS.md](../../AGENTS.md) 的契约全文或包内 TypeScript 类型定义（`node_modules/@syrkos/filaxis/dist/*.d.ts`）。

## 通用排障路径

1. **连接层失败** → 看错误里的 `[连接层失败]` 提示（别名环境依赖）或 `-J` 拒绝文案的三条修法
2. **输出不对** → 先查落盘日志（`.out`/`.err`）再怀疑热窗口滚出；观察流查 `dropped` 计数
3. **停止后不放心** → `verifySession(id)` 实测三态，别猜
4. **写入成功但不放心** → 结果里的 `mutex`/`writeMode`/`verification` 逐轴核对

## 项目政策沉淀（发现特例→建议成文）

遇到以下环境特例时，处置方式值得建议用户**成文沉淀**到自己项目的 `AGENTS.md`/`CLAUDE.md`
（政策显式优于每次临场判断；一次写清，后续 Agent 不再重新踩）：

- 文件系统不支持原子 rename（某些 NAS/network fs）→ 固定 `writeMode:"inplace"` 策略
- 远端无 `flock`（嵌入式/最小镜像）→ 已自动降级无锁（结果里 `mutex:"degraded"`）——
  项目若在高并发写同一文件，应成文「禁止并发写」或换目标层
- 特殊方言目标（BSD/macOS/busybox）→ 已自动适配三族 fallback；项目级固定目标可在
  政策里写明「只面向 GNU」跳过探测心智
- 浏览器支持式的固定底线（如「只用 Linux 目标」「禁用 tmux 层」）→ 直接写进政策，
  Agent 选型时不再犹豫

示例格式：`**执行环境政策：** 只面向 Linux/GNU 目标；写文件一律 writeMode:"inplace"（NAS 部署）。`
