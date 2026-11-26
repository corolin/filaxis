---
name: filaxis-runtime
metadata:
  version: "0.2.13"
description: |
  Use Filaxis (@syrkos/filaxis) to run commands across layers, batch inspections, manage background jobs, follow logs, or operate on files.
  Also use it to diagnose SSH aliases and jump hosts or interpret unknown outcomes and write guarantees. Skip for simple local shell commands and tasks unrelated to Filaxis.
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

## Choose an entry point

Match the task to an entry point and read the relevant playbook. After execution, check the exit code, readiness marker, or file result. Verify an unknown outcome before deciding whether to retry.

| Task | MCP tool or reference |
|---|---|
| Wait for one finite command and collect its exit code | `run_command` |
| Batch inspections or apply dependencies across layers | `run_batch` (pass `stop_on_fail: false` for inspections, or one failure skips the rest). For bastions or multi-host investigation, read [Cross-host diagnosis](./cross-host-diagnosis.md) |
| Start a background service, wait for readiness, or verify its exit code | `start_session` → `stop_session`. Read [Long-running jobs](./longrun-observe.md) |
| Follow logs with a cursor and close the view when finished | `observe_stream` (open/read) → `close_stream`. Read [Observation windows](./stream-window.md) |
| Read/list, edit/create, mkdir/move/delete, or transfer files | `read_path`, `edit_file`, `manage_path`, `transfer_file`. Read [File operations](./file-sync.md) |
| List, activate, or remove registered layers | `manage_layers` (`action: "list" \| "activate" \| "remove"`); connect or enter inner layers with `connect_layer` |
| Observe a command for a limited interval in the CLI | `filaxis observe` |

For work expected to take over two minutes, such as an OS upgrade or a long build, start a session with `start_session`. In one Antigravity run, the host ended an MCP call at about three minutes. A tool's `timeout_ms` cannot extend the host deadline. Follow the [long-running jobs playbook](./longrun-observe.md) to read the logs and verify the outcome.

## CLI quick start

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

# 6. Batches (plan JSON without escaping; add --no-stop-on-fail for inspections; layer names may use wildcards)
filaxis batch --layer "q-*" --no-stop-on-fail --request-file plan.json
filaxis exec --layer <name> --json -- "<command>"     # single-line JSON {exitCode, effectiveUser, stdout, stderr}
```

The local daemon gives the CLI and MCP launchers one shared working set: layers, connections, forwards, and observation windows. `filaxis-mcp` runs through the daemon by default and starts one when none is running. With a binding option (`--host`, `--enter`, `--docker`, `--layer`) it serves inside its own process instead, because a shared daemon cannot hold a default layer for one client; `--no-daemon` forces the in-process mode. The CLI uses a running daemon when there is one and otherwise executes in-process on its own; it never starts a daemon implicitly, so run `filaxis daemon start` when state should be shared across commands. Use `filaxis daemon status` to inspect the daemon and `filaxis daemon stop` to stop it. A client whose wire-protocol version differs from the daemon's refuses to execute and asks for a daemon restart (the situation after an upgrade while an old daemon is still running). Manage continuous observation with `filaxis stream open/peek/close`. Manage forwarding with `filaxis forward add/list/remove` or the MCP `manage_layers` actions `forward_add`, `forward_list`, and `forward_remove`. Use the returned window or forward ID to inspect and close it. The forward list reports only forwards still in use. Pass `filaxis forward list --all` or `forward_list` with `include_closed: true` to include stopped entries. CLI `--json` output has the same shape as the middle-layer records (camelCase: `forwardId`, `bindAddr`, `windowId`, …); snake_case field names (`forward_id`, `window_id`, …) appear only in the MCP tool surface.

The SDK's `createAgentToolkit` also reuses connections and PTYs inside the host process and takes structured arguments. The CLI, MCP, and SDK all run the same set of middle-layer operations: `createMiddle()` builds an in-process instance and `connectRemoteMiddle(client)` goes through the daemon, with identical method signatures.

---

## MCP Practical Guidelines

- **Batch inspection and multi-step fixes with `run_batch`**: Combine multiple `read`, `exec`, `edit`, `put`, and `get` steps into a single parallel `run_batch` call instead of sequential single-tool loops.
- **Turn off fail-fast for inspections**: by default the first failing step stops the batch and steps that have not started (including expanded instances on other layers) are marked `skipped` — one host fails and the rest are never checked. Pass `stop_on_fail: false` for read-only batches such as inspections and multi-host evidence collection (CLI: `filaxis batch … --no-stop-on-fail`). Read the per-step status lines first, then drill into the failed layers. Keep the default for chains such as edit config → validate → reload: a failed step should not be followed by the next one.
- **Less escaping**: an `exec` step can reference a script file with `command_file` instead of `command` — the script goes in as-is, so quotes and newlines need no JSON escaping, and the same script can be reused across steps (the two are mutually exclusive; an unreadable or empty file rejects the whole batch). Relative paths resolve against the server process working directory, so prefer absolute paths when running through the Daemon.
- **Spill large output to files (CLI)**: `filaxis exec --out <file>` and `filaxis batch --out-dir <dir>` write the complete output to the caller's machine (read back and verified byte for byte) and show only the first 15 lines plus the file path in the terminal; `batch` writes one file per exec step (`step@layer.stdout` after layer fan-out, stderr in a separate `.stderr` file). Whether to use it is the plan's call; without it everything still goes to the terminal. This is the path for consumers that have no harness-level output spilling.
- **Layer connections (`connect_layer`)**: Connect a single SSH host (`host`), a batch (`{"targets":["web-01",{"host":"db-01","name":"db","jump":"bastion"}]}`), or enter an inner container/shell (`enter_cmd`). Strings can be SSH config aliases resolved in the runtime environment. Batch targets are attempted in order and individual failures are reported without stopping the batch. Pass the deduplicated `layers` from successful and reused connections directly to `run_batch.layer`. `active_layer` reports the default layer at the end of the call.
- **Layer targeting precedence & multi-layer fan-out**: Both top-level `layer` and per-step `layer` accept either a single layer name or a non-empty array of layer names (top-level sets the batch default; per-step overrides only that step; omitting both uses the active default layer). Multi-layer arrays expand each step into `id@layer` instances that run in parallel up to `max_parallel` (single-element arrays keep the original `id`), and downstream `after` dependencies wait for all expanded instances to succeed (`kind: "get"` rejects multi-layer arrays to avoid overwriting the same `local_path`). `filaxis batch --request-file plan.json` shares the same precedence and array expansion (step `layer` > plan `layer` > `--layer`/`--host` > local). Plan files use camelCase fields (`command` or `commandFile`, `maxParallel`, `stopOnFail`); the `--max-parallel N` and `--no-stop-on-fail` switches override the matching plan fields.
- **Layer wildcards**: a layer name may contain `*` (any character sequence) or `?` (one character), e.g. `"q-*"`, and expands against registered or saved layer names instead of listing them one by one (MCP, the SDK and the CLI share one saved-layer store: layers written by `filaxis layer save` need no `connect_layer` first and are loaded on demand when addressed by name or matched by a wildcard; `filaxis-mcp --layer NAME` binds a saved layer directly). A pattern with no match rejects the whole batch; it never falls back to the default layer.
- **Local targeting**: Layer arrays look up registered or saved names. SDK callers can register the local host with `stack.addLayer("local", { driver: "local" })`. The CLI and standalone MCP server leave the local default unnamed.
- **Concurrency & ordering (`max_parallel` and `after`)**: Independent steps run in parallel up to `max_parallel`. Use `after: ["step-id"]` to serialize dependent steps (e.g., edit config -> validate -> reload service), even across layers.
- **Resource coordination**: `after` references the original step IDs declared in the same batch. Fan-out executes once per layer name, and different names may point to the same environment. Serialize operations that modify the same resource using its environment identity and file path.
- **Text vs. structured output**: `run_batch` text previews share 4 KiB across streams and cap at 8 KiB total (prioritizing failed steps and edit guarantees). Clients that only read text blocks can pass `output: "text"`; use the default `output: "full"` to read full `structuredContent`. `run_command` previews up to 8 KiB per stream.
- **Start working right after connecting**: Do not waste turns running `hostname` or `manage_layers(action="list")` after `connect_layer` — the first `run_command`'s exit code and output confirm the layer.
- **Targeted file reading & minimal edits**: Inspect specific line ranges or recent logs (`sed -n '20,40p' <path>` or `docker logs --tail 30 <container>`). For `edit_file`, copy only the exact target lines with minimal unique context into `old` (or pass `content` to create a new UTF-8 file).
- **Single vs. batch file transfer**: Use `transfer_file` (`direction: "put" | "get"`) for individual files (`local_path` is on the MCP server host; `remote_path` is in the target layer; pass `transport: "sftp"` when the SSH server exposes the target filesystem directly). Use `kind: "put"` / `kind: "get"` steps in `run_batch` for multiple files, ordering concurrent writes to the same path with `after`.
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

// 3. Controlled edit with a pre-write version check (writeMode: "inplace" for single-file bind mounts)
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

## Core Execution Contracts (Never Violate These)

| Contract | Rule |
|---|---|
| **Tri-state termination** | `stop_session` / `stopSession` returns `exited` (verified exit code), `stopped` (verified termination), or `unknown` (verification unreachable — **neither success nor failure**). Verify with `verifySession(id)` / `stop_session` instead of assuming cleanup succeeded. |
| **Exit code is data** | Nonzero command exit codes do **not** throw in `exec` / `run_command`. Only execution failures (timeout, abort, dead transport) reject or error. |
| **Completion sentinel required** | Missing completion markers (disconnect, remote kill, local abort) produce `outcome: "unknown"` — never fabricate exit code `0` and never blindly replay non-idempotent commands. |
| **No never-ending commands in `exec`** | `exec` / `run_command` waits for completion — `tail -f` or `top` will time out. Use `observe_stream` (for streaming logs) or `start_session` (for managed background jobs). |
| **Controlled edits** | CAS stands for compare-and-swap. Filaxis checks modification time, size, and a content fingerprint before writing and rejects a version conflict. Check `mutex` and `write_mode` separately. For file transfers, check `verification`. |
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

1. **Layer connection failure** — Check whether an SSH config alias is missing in the current container/runtime environment or whether a comma-chained `-J` hop needs two `connect_layer` calls (`host` then `enter_cmd`) instead.
2. **Missing log output** — Inspect on-disk `.out`/`.err` session logs if hot-window lines were evicted (`evictedCount > 0`), or check `dropped` / `gap` counters on observation streams.
3. **Uncertain stop result** — Call `stop_session` / `verifySession(id)` whenever `status === "unknown"`.
4. **Uncertain file write guarantees** — Check `mutex`, `write_mode`, and `verification` in the structured result; pass `write_mode: "inplace"` upfront for Docker single-file bind mounts.

## Project Policy Tips

When your environment has permanent constraints (e.g., NAS without atomic rename, minimal BusyBox targets without `flock`, or Linux-only GNU targets), document a short policy line in your project's `AGENTS.md` / `CLAUDE.md`, such as:
`**Execution Policy:** Target Linux/GNU hosts only; always pass write_mode: "inplace" for bind-mounted configs.`
