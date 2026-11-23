---
name: filaxis-runtime
version: 0.2.7
description: |
  Entry skill guide for the Filaxis remote execution runtime (@syrkos/filaxis) — 30-second execution mode selector, MCP/CLI/SDK recipes, and core execution contracts for reliable SSH, Docker, and multi-hop agent operations.

  Read before starting:
  - Any cross-layer or remote command execution, log observation, background session, file edit/transfer, or multi-host troubleshooting task
  - Interpreting `unknown` termination outcomes or 3-axis file-write guarantees (`mutex`, `writeMode`, `verification`)
  - Diagnosing connection failures (SSH config aliases, jump hosts, or no-ProxyJump bastion traversal)

  Skip when:
  - Running simple local one-off commands directly in the host shell
  - Working on tasks unrelated to remote execution or Filaxis
---

# Filaxis Agent Skill — Quick Start & Runtime Guide

> **Selection & contracts**: Start here to choose the right interface and execution mode, then consult the scenario playbooks if needed. Full runtime contracts live in [AGENTS.md](../../AGENTS.md).
>
> **Install / Connect**:
> - **MCP Server (recommended for coding agents)**: `npx -y -p @syrkos/filaxis filaxis-mcp`
> - **CLI**: `npm install -g @syrkos/filaxis` (`filaxis --help`)
> - **TypeScript SDK (Bun / Node LTS, zero runtime npm dependencies)**: `npm install @syrkos/filaxis`
> - **Repository**: `https://github.com/corolin/filaxis`

---

## 10-Second Start: Copy-Paste CLI Recipes (Do Not Read Source Code First)

> Reading package source files upfront wastes hundreds of thousands of tokens. Use these recipes directly:

```bash
# 1. Save a named layer once (reuse via --layer across all subsequent commands)
filaxis layer save <name> --host <user@bastion> --enter "ssh <target-host>"  # Multi-hop without ProxyJump
filaxis layer save <name> --host <user@host>                                 # Direct single-hop SSH

# 2. Execute commands / read files / transfer files
filaxis exec --layer <name> -- "nginx -t"
filaxis cat --layer <name> /etc/nginx/nginx.conf
filaxis put --layer <name> -- ./config.yaml /tmp/config.yaml
filaxis get --layer <name> --transport sftp -- /tmp/result.bin ./result.bin

# 3. Run complex scripts without host shell escaping issues
cat script.sh | filaxis exec --layer <name> --stdin-script
filaxis exec --layer <name> --script-file payload.py

# 4. Safe structured edits without shell quoting conflicts
echo '{"old":"a: 1","new":"a: 2"}' | filaxis edit --layer <name> <path> --stdin-json
filaxis edit --layer <name> <path> --request-file edit.json

# 5. Commands that may hang (nc/ping/tail) — always pass --timeout (CLI default is 120s)
filaxis exec --layer <name> --timeout 8000 -- "(printf 'PING\n'; sleep 1) | nc 127.0.0.1 6379"
```

---

## MCP Practical Guidelines

- **Batch inspection and multi-step fixes with `run_batch`**: Combine multiple `read_file`, `run_command`, `edit_file`, `put`, and `get` steps into a single parallel `run_batch` call instead of sequential single-tool loops.
- **Layer targeting precedence & multi-layer fan-out**: Both top-level `layer` and per-step `layer` accept either a single layer name or a non-empty array of layer names (top-level sets the batch default; per-step overrides only that step; omitting both uses the active default layer). Multi-layer arrays expand each step into `id@layer` instances that run in parallel up to `max_parallel` (single-element arrays keep the original `id`), and downstream `after` dependencies wait for all expanded instances to succeed (`kind: "get"` rejects multi-layer arrays to avoid overwriting the same `local_path`). `filaxis batch --request-file plan.json` shares the same precedence and array expansion (step `layer` > plan `layer` > `--layer`/`--host` > local).
- **Local targeting**: Layer arrays look up registered or saved names. SDK callers can register the local host with `stack.addLayer("local", { driver: "local" })`. The CLI and standalone MCP server leave the local default unnamed.
- **Concurrency & ordering (`max_parallel` and `after`)**: Independent steps run in parallel up to `max_parallel`. Use `after: ["step-id"]` to serialize dependent steps (e.g., edit config -> validate -> reload service), even across layers.
- **Resource coordination**: `after` references the original step IDs declared in the same batch. Fan-out executes once per layer name, and different names may point to the same environment. Serialize operations that modify the same resource using its environment identity and file path.
- **Text vs. structured output**: `run_batch` text previews share 4 KiB across streams and cap at 8 KiB total (prioritizing failed steps and edit guarantees). Clients that only read text blocks can pass `output: "text"`; use the default `output: "full"` to read full `structuredContent`. `run_command` previews up to 8 KiB per stream.
- **Start working right after connecting**: Do not waste turns running `hostname` or `list_layers` after `push_ssh`/`push_into` — the first `run_command`'s exit code and output confirm the layer.
- **Targeted file reading & minimal edits**: Inspect specific line ranges or recent logs (`sed -n '20,40p' <path>` or `docker logs --tail 30 <container>`). For `edit_file`, copy only the exact target lines with minimal unique context into `old`.
- **Single vs. batch file transfer**: Use `put_file` / `get_file` for individual files (`local_path` is on the MCP server host; `remote_path` is in the target layer; pass `transport: "sftp"` when the SSH server exposes the target filesystem directly). Use `kind: "put"` / `kind: "get"` steps in `run_batch` for multiple files, ordering concurrent writes to the same path with `after`.
- **Restricted pipe environments & Windows OpenSSH**: If the host restricts anonymous pipes, set `FILAXIS_SSH_STDIO_MODE=inherit` before starting the CLI/MCP server or creating SSH layers in the SDK (supports direct SSH, single `-J` jump, and non-interactive entry steps; live stream windows and interactive PTY chains require pipes). On Windows, Filaxis restores missing `SystemRoot`, `windir`, `ProgramData`, and `USERNAME` for OpenSSH child processes and logs a single stderr warning when restoring `SystemRoot`.

---

## Minimal TypeScript SDK Recipe (Bun / Node LTS)

For high-frequency automation or custom agents, use the SDK directly to reuse connections, run structured edits without temporary JSON files, and keep zero runtime npm dependencies:

```ts
import { RuntimeStack, editFile, runBatch, transferLayerFile, createAgentToolkit } from "@syrkos/filaxis";

const stack = new RuntimeStack();

// 1. Connect to a named SSH layer (auto-reuses matching topology) and enter a container
const { handle: host } = await stack.addLayer("prod", {
  driver: "ssh",
  target: "host.example.com",
  config: {
    connParams: { user: "deploy", port: 22, keyFile: "/path/to/id_ed25519", jump: "bastion.example.com" },
  },
});
const ctr = await stack.layerInto("prod", "web", "docker exec -i nginx sh");

// 2. One-off execution (exit code is data; stdout/stderr physically separated)
const res = await host.driver.exec("uptime", { timeoutMs: 10_000 });
console.log(res.exitCode, res.stdout, res.stderr);

// 3. Controlled CAS edit (pass writeMode: "inplace" for Docker single-file bind mounts)
const ed = await editFile(ctr.driver, "/etc/nginx/nginx.conf", "worker_processes 1;", "worker_processes auto;", {
  writeMode: "auto",
});

// 4. Dependency-ordered batch (parallel without `after`, sequential with `after`; fail-fast without auto-rollback)
const report = await runBatch(ctr.driver, {
  maxParallel: 3,
  steps: [
    { id: "test", kind: "exec", command: "nginx -t" },
    { id: "reload", kind: "exec", command: "nginx -s reload", after: ["test"] },
  ],
});

// 5. Verified single-file upload and download
await transferLayerFile(ctr.driver, "put", { localPath: "./config.yaml", remotePath: "/app/config.yaml" });
await transferLayerFile(ctr.driver, "get", { localPath: "./result.json", remotePath: "/app/result.json" });

// 6. Generate ready-to-wire agent tools & handlers
const { tools, handlers } = createAgentToolkit(stack);

// 7. Clean teardown
await stack.removeLayer("web", { destroy: true });
await stack.removeLayer("prod", { destroy: true });
```

---

## 30-Second Decision Tree

```
Will the command exit on its own?
├─ Yes (one-off: curl / nginx -t / systemctl status) ──→ run_command / exec (exit code is data)
├─ No (tail -f / top / long-running daemon / training)
│   ├─ Quick time-bounded snapshot ───────────────────→ CLI observe (default 8s snapshot)
│   ├─ Wait for ready marker / error pattern & verify exit → spawn_and_observe + stop_and_verify
│   └─ Live non-destructive stream cursor / paging ───→ observe_stream → read_stream → close_stream
└─ Modifying or moving remote files
    ├─ Text config / code edits ──────────────────────→ edit_file (CAS + lock + writeMode)
    └─ Binary or full-file transfers ─────────────────→ put_file / get_file (or run_batch)
```

---

## Core Execution Contracts (Never Violate These)

| Contract | Rule |
|---|---|
| **Tri-state termination** | `stop_and_verify` / `stopSession` returns `exited` (verified exit code), `stopped` (verified termination), or `unknown` (verification unreachable — **neither success nor failure**). Verify with `verifySession(id)` / `stop_and_verify` instead of assuming cleanup succeeded. |
| **Exit code is data** | Nonzero command exit codes do **not** throw in `exec` / `run_command`. Only execution failures (timeout, abort, dead transport) reject or error. |
| **Completion sentinel required** | Missing completion markers (disconnect, remote kill, local abort) produce `outcome: "unknown"` — never fabricate exit code `0` and never blindly replay non-idempotent commands. |
| **No never-ending commands in `exec`** | `exec` / `run_command` waits for completion — `tail -f` or `top` will time out. Use `observe_stream` (for streaming logs) or `spawn_and_observe` (for managed background jobs). |
| **Three orthogonal write axes** | Inspect `mutex` (lock protection), `write_mode` (`atomic-replace` vs. `inplace-write` for bind mounts), and `verification` (size / SHA-256) independently. |
| **PTY combines stderr** | `channel: "pty"` merges stdout and stderr by terminal semantics; default `exec` keeps them separate. |
| **SSH aliases are host-local** | `--host` and `-J` / `jump` aliases resolve against the runtime host's `~/.ssh/config`. Use explicit `user@host[:port]` literals when running across containers or sandboxes. |

---

## Playbook Index & Anti-Hallucination Discipline

Additional detailed scenario playbooks in `docs/skills/`:
- [longrun-observe.md](./longrun-observe.md) — Long-running jobs, readiness handshake, watchers
- [file-sync.md](./file-sync.md) — Controlled CAS edits, bind mounts, binary transfers
- [cross-host-diagnosis.md](./cross-host-diagnosis.md) — Multi-host capture, probing, and correlation
- [stream-window.md](./stream-window.md) — Incremental log windows and multi-consumer cursors

> Do not invent flags, fields, or error contracts not listed here or in [AGENTS.md](../../AGENTS.md) / `node_modules/@syrkos/filaxis/dist/*.d.ts`.

---

## Troubleshooting Checklist

1. **Layer connection failure** — Check whether an SSH config alias is missing in the current container/runtime environment or whether a comma-chained `-J` hop needs `push_ssh` + `push_into` instead.
2. **Missing log output** — Inspect on-disk `.out`/`.err` session logs if hot-window lines were evicted (`evictedCount > 0`), or check `dropped` / `gap` counters on observation streams.
3. **Uncertain stop result** — Call `stop_and_verify` / `verifySession(id)` whenever `status === "unknown"`.
4. **Uncertain file write guarantees** — Check `mutex`, `write_mode`, and `verification` in the structured result; pass `write_mode: "inplace"` upfront for Docker single-file bind mounts.

## Project Policy Tips

When your environment has permanent constraints (e.g., NAS without atomic rename, minimal BusyBox targets without `flock`, or Linux-only GNU targets), document a short policy line in your project's `AGENTS.md` / `CLAUDE.md`, such as:
`**Execution Policy:** Target Linux/GNU hosts only; always pass write_mode: "inplace" for bind-mounted configs.`
