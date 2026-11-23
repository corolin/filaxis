# 技能剧本：文件同步

> 场景：配置下发 / 产物回收 / 小集群批量分发——把文件在层与层之间可靠搬运。面向 Agent 或工程师。
> 体量 ~0.9K tokens · **何时不用**：二进制大文件频繁同步（走 rsync/scp 专用通道）；临时一次性 echo 重定向（成本不值当）。

## 剧本

1. **选路径**：CLI 默认走层的 exec 通道，适合进入容器后的文件传输。SSH 层的文件系统可直达时可加 `--transport sftp`，包括经 TCP 跳板访问的 SSH 层。SFTP 需要本机 `sftp`、服务端 SFTP 子系统及用于校验和落位的 SSH exec 通道。
2. **信任校验，不信过程**：传输 API 自带 size + sha256 双校验——**校验失败必须当失败处理**（重传或上报），不要「文件在了就算成功」；篡改/截断在弱网上是真实会发生的事。
3. **二进制安全**：文本读取 API 会破坏二进制字节——拉回 pcap/模型/图片必须走传输 API 或 base64 读取，全程不进 UTF-8 字符串。
4. **批量分发的顺序**：先传一台 → 校验 → 远端执行一次启动验证 → 再扇面铺开。别裸扇出 20 台再发现路径错了。
5. **远端原语**：编解码/校验命令的参数存在方言差异（GNU/BSD/busybox）——SDK 内部已按连接探测适配；你自己拼的远端脚本若用到这些原语，同样先探测再渲染。
6. **上线前看权限**：通过 exec 上传的新文件遵循目标层的 `umask`，例如 `0022` 得到 `0644`，`0027` 得到 `0640`。覆盖会保留已有文件权限。服务仍须有权访问上级目录。
7. **上传暂存目录**：POSIX 目标以 `0700` 暂存载荷。Windows 本地 Git Bash 通过 Windows PowerShell 创建只授权当前用户的 NTFS 暂存目录。新文件落位后应用继承 ACL，覆盖落位后核对并恢复原 DACL。落位或权限应用异常时返回 `outcome: "unknown"`，应先核实目标。
8. **本地传输审计**：SDK、CLI 和 MCP 的传输入口只记录操作标签、进程和终态等元数据。直接使用底层传输函数并包装 `driver.exec` 时，应将回调的第二个参数透传给驱动，让载荷读写沿用同一审计策略。

```bash
filaxis put --layer app -- ./config.yaml /app/config.yaml
filaxis get --layer host --transport sftp -- /var/tmp/result.bin ./result.bin
```

两个命令都传单个文件。`put` 的参数顺序是本地源、层内目标，`get` 反过来。查看 JSON 结果的 `verification` 和 `writeMode`。SFTP 失败时命令直接报错，由调用方核实后决定是否改用 exec。含通配符、引号或控制字符的文件名使用 exec。

## MCP 目录与单文件删除

- `list_directory` 接受 `path` 和可选的 `layer`，列出直接子项，包括隐藏项。文本块显示名称与类型，条目元数据在 `structuredContent.entries`。
- `delete_file` 永久删除一个文件或符号链接本身。目录和递归删除会报错。未明确目标层时使用当前默认层。若返回 `outcome: "unknown"`，先核实目标路径，再决定是否重试。

## MCP 上传和下载

调用 `put_file` 上传，下例向 `app` 层写入文件。

```json
{"layer":"app","local_path":"./config.yaml","remote_path":"/app/config.yaml"}
```

调用 `get_file` 下载，下例用 SFTP 把二进制文件写到 MCP 服务所在机器。

```json
{"layer":"host","remote_path":"/var/tmp/result.bin","local_path":"./result.bin","transport":"sftp"}
```

`local_path` 由 MCP 服务进程解析，相对路径以其工作目录为准。两个工具都可能覆盖目标文件，成功后返回字节数、摘要、校验等级和 `write_mode`。文件内容直接写入目标路径。传输层和校验规则与 CLI 一致。

多个文件可以放进同一次 `run_batch`。下例先从 `source` 层取回文件，再上传到 `target` 层。每步结果的 `transfer` 包含校验信息。

```json
{
  "steps": [
    {"id":"fetch","kind":"get","layer":"source","remote_path":"/tmp/data.bin","local_path":"./data.bin"},
    {"id":"send","kind":"put","layer":"target","local_path":"./data.bin","remote_path":"/tmp/data.bin","after":["fetch"]}
  ]
}
```

独立传输可以并行。使用不同的本地目标路径下载到同一台 MCP 服务机器，或用 `after` 串行写入同一路径。

## 受控编辑与 CAS

CAS 是 **Compare-and-Swap（比较后写回）**。每次编辑先读取目标 UTF-8 文件，再用文件的修改时间、大小和 SHA-256 指纹前 12 个十六进制字符记录版本。Filaxis 按字面匹配 `old`，默认要求唯一命中，`all: true` 可明确要求替换所有匹配。写回前再次比较版本，发现不一致时拒绝写回并报告冲突。

例如用 MCP `edit_file` 提交一次替换。版本检查以本次编辑内部读取的文件为基准，调用者提供刚读到的原文片段。

```json
{"layer":"app","path":"/app/config.yaml","old":"port: 8080","new":"port: 9090"}
```

- `mutex` 报告锁保护。具备 `flock` 时，核验和落位受同一把协作锁保护。`degraded` 表示无锁，核验与写入之间仍有并发窗口。
- `write_mode`（SDK 为 `writeMode`）报告落位方式。`atomic-replace` 使用临时文件替换目标，`inplace-write` 保留 inode，写入中断可能留下部分内容。
- 编辑后的 Base64 载荷超过 90,000 字符时，走文件系统回退。回退会在写入前核验并在写后核对内容指纹，结果报告 `degraded` 和 `inplace-write`。回验失败发生在写入之后，应核实目标内容。
- 二进制文件使用传输工具。传输的 `verification` 描述大小或 SHA-256 校验等级。

## 陷阱清单

- 落位缺省**原子替换**（tmp+mv）——中断不留半截目标；但 bind mount 挂载点会自动降级**保留 inode 写入**（结果 `writeMode:"inplace-write"`）——中断**可能留半截**，此时载荷保留在 `.filaxis-out-*` 供核实重试。批量收尾时顺手清 `.*-tmp`/`.filaxis-out-*` 残尾。
- 大文件分块可断点重传，但**不要并行双写同一目标**（append 模式会交错）。
- `unknown` 终态的传输任务：先核实远端实际状态（临时文件在不在/多大），再决定续传或重传。
