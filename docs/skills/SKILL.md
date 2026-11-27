---
name: filaxis-runtime
metadata:
  version: "0.2.13"
description: |
  使用 Filaxis（@syrkos/filaxis）执行跨层命令、批量巡检、管理后台任务、观察日志或操作目标层文件。
  也用于排查 SSH 别名与跳板、解读 unknown 终态或写入保障。纯本机一次性命令和与 Filaxis 无关的任务可跳过。
---

# Filaxis 技能剧本 · 总入口

> 这份是**引导与选型**：先在这里定打法，再进具体剧本。API 签名见包内版本化文档；语义契约全文见 [AGENTS.md](../../AGENTS.md)。

## 30 秒选型

先用下表选执行入口，只读命中的剧本。执行后核对退出码、就绪标记或对应的文件结果。终态未知时先核实，再决定是否重试。

| 任务意图 | MCP 工具或参考 |
|---|---|
| 等一条会自行结束的命令并获取退出码 | `run_command` |
| 批量巡检或按依赖跨层执行 | `run_batch`（巡检传 `stop_on_fail: false`，否则一台失败其余被跳过）。涉及跳板或多机取证时读 [跨主机排查](./cross-host-diagnosis.md) |
| 启动后台服务、等就绪或核实进程退出码 | `start_session` → `stop_session`。读 [长跑任务](./longrun-observe.md) |
| 按游标实时看日志、看完关窗 | `observe_stream`（开窗即读+游标续读）→ `close_stream`。读 [持续观察窗](./stream-window.md) |
| 读文件/列目录、编辑/建文本、建目录/移动/删除、传文件 | `read_path`、`edit_file`、`manage_path`、`transfer_file`。读 [文件操作](./file-sync.md) |
| 查询、切换默认层或移除已注册层 | `manage_layers`（`action: "list" \| "activate" \| "remove"`）；建连或进内层用 `connect_layer` |
| CLI 限时查看输出 | `filaxis observe`，适用于只取一段观察结果 |

预计超过两分钟的任务（如系统升级或长编译）优先用 `start_session` 启动。Antigravity 实测曾在约三分钟终止单次 MCP 调用，工具的 `timeout_ms` 无法延长宿主的调用时限。按 [长跑任务剧本](./longrun-observe.md) 查看落盘日志并核实终态。

## CLI 快速上手

```bash
# ① 建层（一次性；之后全部 --layer 复用，免拼连接参数）
filaxis layer save <名> --host <user@跳板> --enter "ssh <目标机>"   # 无 ProxyJump 多跳正道
filaxis layer save <名> --host <user@主机>                          # 单层直连

# ② 执行 / 读文件（之后所有子命令都吃 --layer）
filaxis exec --layer <名> -- "nginx -t"
filaxis cat --layer <名> /etc/nginx/nginx.conf
filaxis put --layer <名> -- ./config.yaml /tmp/config.yaml
filaxis get --layer <名> --transport sftp -- /tmp/result.bin ./result.bin

# ③ 复杂脚本免宿主 Shell 转义（引号/多行/Python -c 直达）
cat script.sh | filaxis exec --layer <名> --stdin-script
filaxis exec --layer <名> --script-file payload.py

# ④ 编辑免引号地狱（含引号/多行时禁用行内参数）
echo '{"old":"a: 1","new":"a: 2"}' | filaxis edit --layer <名> <path> --stdin-json
filaxis edit --layer <名> <path> --request-file edit.json

# ⑤ 挂起类命令（nc/ping/tail -f）必带 --timeout——CLI 缺省 120s
filaxis exec --layer <名> --timeout 8000 -- "(printf 'PING
'; sleep 1) | nc 127.0.0.1 6379"

# ⑥ 批次（计划 JSON 免转义；巡检加 --no-stop-on-fail；层名可写通配，按已存层名展开）
filaxis batch --layer "q-*" --no-stop-on-fail --request-file plan.json
filaxis exec --layer <名> --json -- "<command>"     # 单行 JSON {exitCode, effectiveUser, stdout, stderr}
```

**MCP 形态实战指引**（第十二季盲测 B 组教训）：
- 多个 SSH 目标可用一次 `connect_layer` 调用，例如 `{"targets":["web-01",{"host":"db-01","name":"db","jump":"bastion"}]}`；也可单台传 `host` 或传 `enter_cmd` 从既有层进入容器。字符串可用运行环境 SSH 配置里的别名。按输入顺序建连，单个目标失败后继续尝试。返回的 `layers` 只含建连成功或复用的实际层名，并已去重，非空时可直接传给 `run_batch.layer`。批量结果的 `active_layer` 是调用结束时的默认层。
- **定位/巡检期用 `run_batch` 打包**——多个 `read` / `exec` 一次调用并行
  执行（B 组逐个调 18 步 vs CLI 组打包 11 步——这是 MCP 形态省步数的最大杠杆）；
- **巡检要显式关掉失败即停**：`run_batch` 缺省任一步失败即停，尚未启动的步骤（含其它层的展开实例）标 `skipped`——一台失败，其余都不看。批量巡检、多机取证这类只读批次传 `stop_on_fail: false`（CLI：`filaxis batch … --no-stop-on-fail`）。第一遍只看各步状态行，再对失败的层单独钻取。改配置→验证→重载这类链保持缺省：前一步失败不应继续。
- **少写转义**：`exec` 步骤可用 `command_file` 引用脚本文件，替代 `command`——命令原样进文件，JSON 里的引号和换行不必再转义，同一脚本可被多个步骤复用（二者互斥；读不出或内容为空则整批拒绝）。相对路径相对服务进程的工作目录，经 Daemon 执行时建议给绝对路径。
- **大输出落盘（CLI）**：`filaxis exec --out <文件>`、`filaxis batch --out-dir <目录>`——完整输出落到调用方本机（写后读回逐字节核对），终端只打头 15 行和文件路径；`batch` 的每个 exec 步骤各一个文件（层扇出后形如 `step@layer.stdout`，stderr 另存 `.stderr`）。输出多大都由规划决定用不用；不加则全量打到终端。没有 harness 输出外置的消费方走这一条。
- `run_batch` 的顶层 `layer` 和步骤 `layer` 均支持传单个层名或层名数组（也可同时传：顶层是批次默认值，步骤的 `layer` 仅覆盖本步；两处都省略时使用调用时的默认层）。传多个层名数组时，步骤按 `id@layer` 展开并在 `max_parallel` 并发池内并行执行，下游 `after` 需等被依赖步骤的所有展开实例均 ok 后才启动（`kind: "get"` 不支持多层数组，防并发覆盖同一 `local_path`）；单元素数组保留原 `id`。结果逐步标明命名层。
- CLI 的 `filaxis batch --request-file plan.json` 同样支持这两个字段，并从 `filaxis layer save` 保存的层中解析名称。优先级依次为步骤 `layer`、计划 `layer`、命令行的 `--layer` 或 `--host`，全省略时使用本机。计划文件里的字段是驼峰写法（`command` 或 `commandFile`、`maxParallel`、`stopOnFail`）；命令行开关 `--max-parallel N` 与 `--no-stop-on-fail` 覆盖计划里的对应字段。
- 层名可写通配：`*` 匹配任意字符序列，`?` 匹配单个字符（如 `"q-*"`），按已注册或已保存的层名展开（MCP、SDK 与 CLI 认同一份已存层表：`filaxis layer save` 保存的层不必先 `connect_layer`，按名寻址或被通配命中时自动加载；`filaxis-mcp --layer NAME` 可直接绑定已存层），免去逐个罗列。没有任何匹配时整批拒绝，不会改用默认层。
- 层名数组只查已注册或保存的层。SDK 可用 `stack.addLayer("local", { driver: "local" })` 把本机加入命名层；CLI 和独立 MCP 服务的本机默认目标不会自动注册为 `local`。
- `max_parallel` 是整个批次的并发上限。无依赖的步骤可以并行，包括同层的独立巡检。需要先改配置、再验证、最后重载时，用 `after` 引用前置步骤的 `id`。依赖可以跨层，前置步骤成功后才会启动后续步骤。
- `after` 引用当前批次计划里声明的原始步骤 ID。同一环境可能有多个层名，扇出按层名各执行一次。多个步骤或批次可能同时修改同一资源时，由调用方按实际资源串行化，例如用「环境身份 + 配置路径」作为互斥键。
- `run_batch` 文本逐步展示状态、退出码、编辑的写入方式和锁状态，以及 stdout/stderr 预览。所有输出流共用 4 KiB，整个文本字段序列化后最多 8 KiB，超出时优先显示失败步骤和编辑保障。只看文本块的 MCP 客户端请传 `output: "text"`。需要完整输出时用默认的 `output: "full"`，从 `structuredContent` 取。`run_command` 的文本各流最多预览 8 KiB。
- `output: "text"` 在本机和 SSH 层按预算采集 `exec` / `read` 预览，并继续读取完成哨兵来核实退出码。SSH 文件中转仍在磁盘接收完整输出，回读只取有界的首尾。其他层需要支持限量采集才能在文本模式下执行这些步骤。
- 建链后立即干活，**不要**逐个 `hostname` / `manage_layers(action="list")` 验证——首个 `run_command`
  的退出码与命令输出就是执行凭证；
- 巡检只读目标配置的相关行和最近 20–30 行关键日志，例如在批次的 `exec` 步骤中用 `sed -n '20,40p' <path>` 或 `docker logs --tail 30 <container>`。批量编辑时，把刚读到的原文连同能唯一定位的上下文直接填入 `old`，在 `new` 只改目标行，无需逐行默写全文。
- 二进制或整文件传输用 `transfer_file`（`direction: "put" | "get"`）。`local_path` 位于 MCP 服务进程所在机器，`remote_path` 位于目标层。传 `layer` 指定目标，`transport: "sftp"` 可选用于文件系统可直达的 SSH 层。完整示例见 [文件同步剧本](./file-sync.md)。
- 批量上传和下载用 `run_batch` 的 `kind: "put"` / `kind: "get"`，字段与单文件工具一致。多个步骤写同一个 `local_path` 或同一目标层文件时，用 `after` 排序，或为每个下载指定不同的本地路径。
- 宿主拦截 SSH 匿名管道时，在建层前设 `FILAXIS_SSH_STDIO_MODE=inherit`。它支持直连、单跳 `-J` 和可非交互重放的进入步骤。逐跳 PTY、交互进入、持久转发和持续观察窗需要可用的匿名管道。若首轮已发出且终态未知，先核实远端状态再决定是否重发。
- Windows 的 OpenSSH 子进程会继承现有配置，并由 Filaxis 补齐缺失的系统和账户变量，例如 `SystemRoot`、`windir`、`ProgramData` 和 `USERNAME`。成功补齐 `SystemRoot` 时，CLI 和 MCP 会在 stderr 告警一次，SDK 通过注入的 logger 记录。SSH 秒退且双流为空时，可检查启动器是否保留了系统环境。

本机守护进程（Daemon）让 CLI 与 MCP 共享同一份现场——层、连接、转发、观察窗。`filaxis-mcp` 缺省经 Daemon 执行，没有在跑就自动启动；带了 `--host` / `--enter` / `--docker` / `--layer` 这类绑定参数时在本进程内服务（共享的 Daemon 没法替某一个客户端设默认层），`--no-daemon` 可强制走进程内。CLI 有 Daemon 在跑就用它，没有就在本进程内执行、不会自己启动；要跨命令共享现场先 `filaxis daemon start`，用 `filaxis daemon status` 查看状态，`filaxis daemon stop` 停止。客户端与 Daemon 的线协议版本不一致时直接拒绝执行并提示重启 Daemon（升级之后旧 Daemon 还在跑的情形）。持续观察用 `filaxis stream open/peek/close`，转发用 `filaxis forward add/list/remove`，或在 MCP `manage_layers` 中使用 `forward_add`、`forward_list`、`forward_remove`。按返回的窗口 ID 或转发 ID 查询和关闭。转发列表缺省只报仍在用的转发，已停止的条目用 `filaxis forward list --all` 或 `forward_list` 的 `include_closed: true` 查看。CLI 的 `--json` 输出与中层记录同形（camelCase：`forwardId`、`bindAddr`、`windowId`…）；snake_case 字段名（`forward_id`、`window_id`…）只出现在 MCP 工具面。

SDK 的 `createAgentToolkit` 也可在宿主进程内复用连接和 PTY，并接受结构化参数。CLI、MCP 与 SDK 走的是同一组中层操作：`createMiddle()` 建进程内实例，`connectRemoteMiddle(client)` 经 Daemon，两者方法签名一致。

### SDK 最小配方（Bun / Node 编码接入）

```ts
import { RuntimeStack, editFile, runBatch, transferLayerFile, createAgentToolkit } from "@syrkos/filaxis";

const stack = new RuntimeStack();

// ① 建命名层（直连或 -J 跳板；同拓扑自动复用；可再 layerInto 进容器）
const { handle: host } = await stack.addLayer("prod", {
  driver: "ssh",
  target: "host.example.com",
  config: {
    connParams: { user: "root", port: 22, keyFile: "~/.ssh/id_ed25519", jump: "bastion" },
  },
});
const ctr = await stack.layerInto("prod", "web", "docker exec -i nginx sh");

// ② 一次性执行（退出码是数据，stdout/stderr 物理分离）
const r = await host.driver.exec("uptime", { timeoutMs: 10_000 });
console.log(r.exitCode, r.stdout, r.stderr);

// ③ 受控编辑（写回前核对文件版本；Docker 单文件 bind mount 可传 writeMode: "inplace"）
const ed = await editFile(ctr.driver, "/etc/nginx/nginx.conf", "worker_processes 1;", "worker_processes auto;", {
  writeMode: "auto",
});

// ④ 批次组合（无 after 并行，有 after 保序；fail-fast 不自动回滚）
const report = await runBatch(ctr.driver, {
  maxParallel: 3,
  steps: [
    { id: "test", kind: "exec", command: "nginx -t" },
    { id: "reload", kind: "exec", command: "nginx -s reload", after: ["test"] },
  ],
});

// ⑤ 单文件上传与下载（返回传输方式、校验等级和落位语义）
await transferLayerFile(ctr.driver, "put", { localPath: "./config.yaml", remotePath: "/app/config.yaml" });
await transferLayerFile(ctr.driver, "get", { localPath: "./result.json", remotePath: "/app/result.json" });

// ⑥ 嵌入自定义 Agent：一行生成 OpenAI/Anthropic/Vercel AI SDK 通吃工具面
const { tools, handlers } = createAgentToolkit(stack);

// ⑦ 收尾释放（移除层并销毁底层连接）
await stack.removeLayer("web", { destroy: true });
await stack.removeLayer("prod", { destroy: true });
```


## 升级要点：0.2.13 → 0.3.0

MCP 工具面没变：12 个工具名、参数 schema、snake_case 字段都照旧，已有的调用方式不用改。CLI 没有删除或改名任何子命令与参数。变的是下面几处，脚本或习惯依赖旧行为的要跟着改：

| 变化 | 0.2.13 | 0.3.0 | 要做什么 |
|---|---|---|---|
| `filaxis-mcp` 的宿主 | 有 Daemon 在跑才经它，绝不自己启动 | 缺省经 Daemon，没有就自动启动；绑定参数或 `--no-daemon` 走进程内 | 层、连接、转发、观察窗在所有 MCP 客户端与 CLI 之间共享，客户端断开后现场仍留在 Daemon 里；要即弃就加 `--no-daemon` |
| 版本握手 | 无 | 0.2.x 与 0.3.0 的客户端、Daemon 互相拒绝（`E_PROTOCOL_MISMATCH`），不把请求交给旧代码执行 | 升级后先 `filaxis daemon stop`（新旧 CLI 都能停对方版本的 Daemon），再重新发起命令 |
| CLI `--json` 字段名 | 转发记录是 snake_case（`forward_id`，`forwardId` 留作别名） | 统一 camelCase（`forwardId`、`bindAddr`、`windowId`…），观察窗与 `daemon status` 同理 | 解析 CLI JSON 的脚本改字段名；MCP 面仍是 snake_case |
| 一次性模式与经 Daemon | 两种模式有 8 处行为差异（相对的本机路径、相对的密钥路径等） | 一致；「层不存在」这类报错文案统一 | 一般不用改；依赖旧差异的脚本，结果可能不同 |
| 大输出落盘 | 无 | 新增 `filaxis exec --out <文件>`、`filaxis batch --out-dir <目录>` | 按需使用；不加参数行为不变 |
| MCP 代理进程滞留 | 客户端在握手完成前断开时，代理进程不退出（0.2.12 起） | 已修 | 无需处理 |

没写目标的命令仍在本机执行。SDK 的 `createAgentToolkit(stack, opts)` 签名不变，包的导入路径不变，另新增 `createMiddle` / `connectRemoteMiddle` 导出。

## 核心契约速查（违者=生产事故）

| 契约 | 一句话 |
|---|---|
| **终态三态** | `exited`（有真实退出码）/ `stopped`（死亡已核实）/ `unknown`（核实不可达——**既非成功也非失败**）；unknown 后用 `verifySession(id)` 实测（running/exited/unknown） |
| **退出码是数据** | exec 非零退出码不抛异常；只有「无法执行」（超时/断链/abort）才 reject |
| **完成哨兵是唯一凭证** | 无哨兵（断链/远端 kill）= reject + `outcome:"unknown"`——绝不伪造退出码，绝不自动重放非幂等命令 |
| **永不结束的命令不进 exec** | exec 是「等完成」语义——`tail -f`/`top` 必超时；换 observe / 会话+watcher |
| **受控编辑** | CAS 全称 Compare-and-Swap（比较后写回）。写前比较文件修改时间、大小和内容指纹，发现冲突就拒绝写回。分别查看 `mutex` 与 `writeMode`。传输校验等级见 `verification` |
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
