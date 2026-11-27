# Filaxis (牵丝)

[![CI](https://github.com/corolin/filaxis/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/corolin/filaxis/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@syrkos/filaxis)](https://www.npmjs.com/package/@syrkos/filaxis)
[![License: Apache-2.0](https://img.shields.io/github/license/corolin/filaxis)](https://github.com/corolin/filaxis/blob/main/LICENSE)
[![Glama MCP Server](https://glama.ai/mcp/servers/corolin/filaxis/badges/score.svg)](https://glama.ai/mcp/servers/corolin/filaxis)
[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/corolin/filaxis)

[简体中文](https://github.com/corolin/filaxis/blob/main/README.md) · English

**A headless multi-screen ops workbench for AI agents.**\
**Connect · Execute · Observe · Reattach**

Filaxis is a zero-dependency TypeScript runtime for remote execution by AI agents and automation (by Syrkos). It runs on Bun and Node LTS across Windows and Linux. Its **CLI (`filaxis`), MCP server (`filaxis-mcp`), and SDK (`createMiddle`, `RuntimeStack`, `createAgentToolkit`)** share the same middle-layer operations. MCP uses the local Daemon by default, the CLI can reuse a running Daemon, and SDK callers can join the shared workspace with `connectRemoteMiddle`.

## Why give AI agents their own "screens"?

> Human ops engineers work with multiple terminal windows, multiple monitors, and a persistent workspace.
>
> Why does an ordinary AI agent have to re-describe how to reach a target (`ssh -> ssh -> docker exec ...`) on every single command?
>
> **Why not give the agent a set of switchable "screens"?**

Filaxis is not trying to reinvent SSH. Instead, it turns the multi-window terminal workbench that human engineers take for granted into addressable, persistent, on-demand execution contexts for AI agents (where a "screen" is not a physical monitor, but a live runtime context the agent can switch into and inspect at will):

- **Human ops engineer**: Engineer + monitors + N persistent SSH windows — named tabs, `Alt + Tab` to switch context, and `tail -f` running on a side screen to glance at when needed.
- **Ordinary AI agent**: Stateless `ssh -> ssh -> ...` from scratch on every tool call, nested shell-quoting traps across hops, and `tail -f` commands that either hang the tool call or flood the context window.
- **Filaxis**: Named layers (virtual terminal tabs), rolling stream windows (virtual side screens), and a local Daemon (persistent workbench) — connect once, then switch layers and peek at streams across turns and clients.

| Human Ops Workbench | Filaxis (MCP / CLI / SDK) |
|---|---|
| Open an SSH client (single host, `-J` jump, or batch) | `connect_layer` / `filaxis layer save` / `stack.addLayer` |
| Enter a container or inner host from a server | `connect_layer(enter_cmd)` / `--enter` / `stack.layerInto` |
| Name a terminal tab | Named Layer |
| See which terminal windows are open | `manage_layers(list)` / `filaxis layer list` |
| `Alt + Tab` between windows | Target by `layer` or switch default via `manage_layers(activate)` |
| Keep the workbench open between commands | **Local Daemon** (persists layers, connections, forwards, and stream windows across CLI & MCP clients) |
| Leave `tail -f` running on a side monitor | **Observation Window** (`observe_stream` / `filaxis stream open`) |
| Scroll back through recent terminal output | **Local rolling buffer + cursor-based `peek`** (consult existing log files for full history) |
| Watch and act across many terminals in parallel | Concurrent stream windows + `run_batch` / `filaxis batch` (with `"web-*"` wildcard fan-out) |
| Open a local tunnel into an inner environment | Dynamic port forwarding (`manage_layers(forward_add)` / `filaxis forward add`) |
| Close a window when finished | `manage_layers(remove)` / `close_stream` |

This design directly resolves two fundamental tensions in agentic operations:

1. **Humans don't close their entire terminal workbench and reconnect every window after typing a single command.** The local **Daemon** maintains the workspace lifecycle — starting in `0.3.0`, `filaxis-mcp` connects to (or auto-starts) the local Daemon by default so multiple MCP clients and the CLI share the same live layers, SSH connections, port forwards, and observation windows.
2. **Keeping a screen open doesn't mean staring at it nonstop; keeping an observation window running doesn't mean burning tokens nonstop.** Unlike humans, an agent isn't bound by physical monitor space or visual attention. It can keep dozens of stream windows open simultaneously while output buffers locally, reading incremental frames by cursor only when needed.

## Quick start (SDK)

```ts
import { RuntimeStack } from "@syrkos/filaxis";

const stack = new RuntimeStack();
const host = await stack.connect({ driver: "ssh", target: "my-server" });

// One-off commands return separate streams, a verified exit code, and the effective user.
const result = await host.exec("uname -a", { timeoutMs: 10_000 });
console.log(result.stdout, result.stderr, result.exitCode, result.effectiveUser);

// Subscribe to session events through the SDK.
stack.events.on("exit", (event) => console.log(event.sessionId, event.exitCode));

// Long-running commands return a session handle immediately.
const capture = await host.execSession("tcpdump -i eth0 -c 100 -w /tmp/x.pcap");
console.log(capture.sessionId, capture.logBase);
console.log(await host.tailSession(capture.sessionId, 10));

const stop = await host.stopSession(capture.sessionId);
if (stop.status === "unknown") {
    const verified = await host.verifySession(capture.sessionId);
    console.log(verified.status, verified.exitCode);
}
```

See [docs/skills/SKILL.en.md](./docs/skills/SKILL.en.md) for complete recipes covering named layers, container entry (`layerInto`), CAS file edits, multi-layer `runBatch`, and `createAgentToolkit`.

## Capabilities

| Capability | What Filaxis provides |
|---|---|
| Runtime layers | Built-in `local`, `ssh`, and `tmux` drivers. Register custom drivers with `registerDriver()` or derive inner layers (Docker, Kubernetes, bastion hops) through entry pipelines (`layerInto` / `--enter`). |
| Shared workspace & middle layer | Three-layer architecture (`interface / middle / core`): CLI, MCP, and SDK (`createMiddle` / `connectRemoteMiddle`) share the same 26 stateful operations, persisting layers, connections, forwards, and stream windows via the local Daemon with wire-protocol version handshakes. |
| Command execution | The default non-interactive channel keeps stdout and stderr separate and replays the layer's working directory, environment variables, and entry pipeline. The PTY channel inherits interactive shell state. |
| Cross-layer batching | `runBatch` / `run_batch` / `filaxis batch` fan out across layer arrays and `*` / `?` wildcards with `after` dependency ordering, `stopOnFail: false` fleet inspections, and CLI batch output files (`--out-dir`). |
| Long-running sessions | `execSession` returns immediately. Output is recorded in separate `.out` and `.err` files with a hot recent-output window, backtrack-aware `ready()` checks (`evictedCount`), and line watchers. Stop reports `exited / stopped / unknown`, and `verifySession` checks session state. |
| Streaming & observation windows | Dedicated SSH channels stream live output (reusing `ControlMaster` where available) into local rolling windows with monotonic frame numbers, non-destructive multi-consumer cursors, and automatic stream reaping on close. |
| Persistent sessions & port forwards | The `tmux` backend reattaches across processes by `terminalId` and restores working directories. Dynamic SSH `-L`, `-R`, and SOCKS forwards work across replayable inner layers. |
| File transfer and editing | `putFile` and `getFile` (plus optional `sftp` fast path) report verification levels using size and SHA-256 across GNU/BSD/BusyBox dialects. `editFile` uses compare-and-swap (CAS) to verify file versions before writing and reports lock protection and write mode. |
| Discovery & connection governance | Probe installed tools and GPU capabilities, select layers via `matchLayers({ needs })`, flag stale fingerprints, reuse connections by topology fingerprint, and reconnect with backoff. |
| SSH host verification | Trust on first use (`tofu`) by default, with explicit `strict` mode and configurable `known_hosts`. Private keys are passed by path only and never exposed in logs or rendered output. |

## Installation and system requirements

```bash
bun add @syrkos/filaxis
# or
npm install @syrkos/filaxis
```

- Runs on Bun 1.x and Node LTS with **zero runtime npm dependencies** (CI runs the full Bun test suite and loopback SSH integration tests on Ubuntu, plus Node LTS typechecking, architecture boundary gates, build, and compiled CLI smoke tests).
- SSH requires `ssh`. OpenSSH 7.3 or later supports the `-J` jump-host option. Persistent terminals require `tmux`, and the optional fast transfer path requires `sftp`.
- `await stack.features()` checks tools where Filaxis runs. If the agent runs in a container, this reports the container's tools. Check target-side capabilities through the target layer.

## MCP setup and agent skill

```bash
npm install -g @syrkos/filaxis
filaxis mcp-config                # JSON with mcpServers
filaxis mcp-config --format toml  # TOML with mcp_servers for Codex
```

`mcp-config` prints a snippet with absolute paths to the current runtime and the `filaxis-mcp` entry point. Merge it into the configuration for your MCP client and chosen scope.

Or launch it directly with `npx` in your MCP client configuration:

```json
{
  "mcpServers": {
    "filaxis": {
      "command": "npx",
      "args": ["-y", "-p", "@syrkos/filaxis", "filaxis-mcp"]
    }
  }
}
```

Starting in `0.3.0`, `filaxis-mcp` runs through the local Daemon by default (auto-starting it if none is running), so multiple MCP clients and the CLI share layers, SSH connections, port forwards, and observation windows. Target-binding flags (`--host`, `--enter`, `--docker`, `--layer`) or `--no-daemon` run an isolated in-process server instead. After upgrading Filaxis, stop any older running Daemon first with `filaxis daemon stop` so the protocol handshake does not reject mismatched versions (see [0.3.0 upgrade notes](./docs/skills/SKILL.en.md)).

Exposed MCP tools (12 tools):

- **Execution & batching**: `run_command`, `run_batch`
- **Long-running sessions & observation windows**: `start_session`, `stop_session`, `observe_stream`, `close_stream`
- **Files and paths**: `read_path`, `edit_file`, `manage_path`, `transfer_file`
- **Layer management**: `connect_layer`, `manage_layers`

The npm package includes the [English agent skill](./docs/skills/SKILL.en.md), [four playbooks](./docs/skills/), and the [runtime contract](./AGENTS.md). Register the skill according to your agent's conventions.

## File transfers

```bash
filaxis put --layer app -- ./config.yaml /app/config.yaml
filaxis get --host user@host --transport sftp -- /var/tmp/result.bin ./result.bin
```

`put` and `get` move one file at a time. The default exec transport follows the target layer, including entry into a container. Use `--transport sftp` when the SSH server exposes the target filesystem directly, including through a TCP jump host. Results include the verification level and write mode.

In MCP, use `transfer_file` (`direction: "put" | "get"`) with `local_path` on the MCP server host and `remote_path` in the target layer. Specify `layer` to address a named layer. For multiple files, use `put` and `get` steps in `run_batch`. The [file transfer playbook](./docs/skills/file-sync.md) includes examples.

## Tested platforms and connection methods

| Operating system | Connection | Verified coverage |
|---|---|---|
| Windows | Local execution through Git Bash | Commands, long-running sessions, observation windows, and Windows Job Object cleanup |
| Ubuntu Linux | Local WSL execution, local tmux, and CI loopback SSH | Local sessions and observation windows, tmux reattachment and stop, and SSH integration. Watcher recovery for tmux is pending. |
| Debian GNU/Linux | Direct SSH | Non-interactive exec, interactive PTY, live observation windows, session and watcher recovery after reconnect, verified stop, and file operations |
| Debian GNU/Linux | SSH through one TCP jump host (`ProxyJump` / `-J`) | Non-interactive exec with separate stdout and stderr |
| Alpine Linux | SSH to a Linux host followed by `docker exec` | Non-interactive commands and controlled file edits inside the container |
| OPNsense (FreeBSD) | Direct non-interactive SSH | Commands, directory listing, file writes, and permission preservation on overwrite. The default appliance menu prevents the PTY handshake in this setup. |

### SSH file redirection

When the host restricts anonymous pipes, set `FILAXIS_SSH_STDIO_MODE=inherit` before starting the CLI or MCP server, or before creating an SSH layer in the SDK. OpenSSH reads stdin and writes stdout and stderr through local temporary files. Filaxis probes named layers non-interactively and verifies command exit codes using a completion marker.

On Windows, Filaxis fills missing system and account variables for OpenSSH child processes, including `SystemRoot`, `windir`, `ProgramData`, and `USERNAME`. Existing values take precedence. When Filaxis restores `SystemRoot`, the CLI and MCP server warn once on stderr. SDK callers receive the warning through an injected logger.

File redirection supports direct SSH, one TCP jump host, and replayable non-interactive entry steps. Interactive entry, multi-hop PTY chains, persistent port forwarding, and live observation windows require pipes. Session logs remain available through `readSessionLog`.

A quick exit of 255 with empty streams is a diagnostic clue. If a command's outcome is `unknown`, verify remote state before deciding whether to run it again.

## Execution guarantees

- A verified nonzero exit code is returned as data. A lost completion marker leaves the outcome `unknown`.
- `stopSession` can return `exited`, `stopped`, or `unknown`. Call `verifySession` when the outcome is unknown.
- PTY output combines stdout and stderr. Cross-stream ordering outside PTY reflects local arrival order.

See [AGENTS.md](./AGENTS.md) for the complete runtime contract.

## Examples and playbooks

- [Runnable examples](./examples/) cover cross-host diagnosis, long-running observation, and agent-tool integration.
- [Agent playbooks](./docs/skills/) cover execution, observation, and file transfer workflows.

## Benchmark

Four controlled operational benchmarks (spanning `v0.1.0` to `v0.2.5`, covering LAN and cross-region multi-hop bastion topologies, white-box and zero-hint black-box scenarios; same model within each run, not directly comparable across versions due to task and model differences) are documented with full methodology and limitations in [benchmark.en.md](https://github.com/corolin/filaxis/blob/main/benchmark.en.md).

Latest run (Report 4: `v0.2.5`, cross-region no-`ProxyJump` bastion, **zero-hint black-box with 9 cascading faults** + cross-region `PUT`/`GET` binary file transfers, `Gemini 4 Hydrogen` lightweight-tier subagents, 100% pass rate across all 4 groups):

| Group | Interface | Turns | Wall time | Errors / friction | Active tokens (`in+out`) | Operational active *(excl. doc pre-read)* | Total tokens *(incl. cache)* |
|---|---|---:|---:|---:|---:|---:|---:|
| **Filaxis MCP** | Native `filaxis-mcp` tools | **14** | **225s** *(3m 45s)* | **0** | **81,297** | **50,362** | **561,736** |
| Filaxis SDK | `@syrkos/filaxis` TS orchestration | 18 | 273s *(4m 33s)* | **0** | 104,563 | 67,823 | 890,017 |
| Filaxis CLI | `filaxis` + `SKILL.md` | 22 | 368s *(6m 08s)* | 3 | 106,587 | 79,535 | 1,051,857 |
| Raw SSH | Native `ssh` / `scp` + shell | 24 | 483s *(8m 03s)* | 4 | 107,151 | 86,917 | 999,825 |

In this cross-region no-`-J` black-box scenario, Filaxis MCP completed with **0 errors**, **53.4% shorter wall time**, and **24.1% fewer total active tokens** (**42.1% fewer** excluding doc pre-read; **43.8% fewer** total tokens including cache) than raw SSH. Note that these are single-run operational samples (not multi-seed averages), and in simple white-box LAN tasks with explicit paths the gap is much smaller (see Report 1, Test 2); Filaxis delivers its largest gains in **zero-hint, multi-hop, cascading failure troubleshooting**.

## License

Filaxis is licensed under [Apache-2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.
