# Filaxis (牵丝)

[![CI](https://github.com/corolin/filaxis/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/corolin/filaxis/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@syrkos/filaxis)](https://www.npmjs.com/package/@syrkos/filaxis)
[![License: Apache-2.0](https://img.shields.io/github/license/corolin/filaxis)](https://github.com/corolin/filaxis/blob/main/LICENSE)

[简体中文](https://github.com/corolin/filaxis/blob/main/README.md) · English

**Connect · Execute · Observe · Reattach**

Filaxis is a TypeScript runtime for remote execution by AI agents and automation. It supports local execution, multi-hop SSH, persistent sessions, and streaming observation on Windows and Linux. The CLI (`filaxis`), SDK (`RuntimeStack` and `createAgentToolkit`), and MCP server (`filaxis-mcp`) share the same execution semantics. CI runs the full Bun suite and loopback SSH integration tests on Ubuntu. The Node LTS job checks types and runtime boundaries and runs the compiled CLI.

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

## Capabilities

| Capability | What Filaxis provides |
|---|---|
| Runtime layers | Built-in local, SSH, and tmux drivers. Register custom drivers with `registerDriver()` or connect to environments such as Docker, Kubernetes, and Teleport through `launchCmd`. |
| Command execution | The default non-interactive channel keeps stdout and stderr separate and applies the layer's working directory, environment variables, and replayable entry steps. The PTY channel inherits interactive shell state. |
| Long-running sessions | `execSession` returns immediately. Output is recorded in separate `.out` and `.err` files and is available through a recent-output buffer, line watchers, and readiness checks. |
| Streaming observation | A separate SSH channel streams live output. It can share the SSH master connection through ControlMaster where available. |
| Persistent sessions | The tmux backend can reattach across processes by `terminalId` and restore the working directory. |
| File transfer and editing | `putFile` and `getFile` verify size and, when available, SHA-256 with support for GNU, BSD, and BusyBox tools. `editFile` performs compare-and-swap edits and reports the write mode, lock protection, and verification level. |
| Environment discovery | Discover installed tools and GPU capabilities, select suitable layers with `matchLayers({ needs })`, and flag saved results when fingerprints drift. |
| Connection management | Reuse connections by topology fingerprint. Filaxis reconnects with backoff and tracks degraded layers. |
| SSH host verification | Trust on first use by default, with explicit strict mode and a configurable `known_hosts` file. The SDK accepts private-key paths. |

## Installation and system requirements

```bash
bun add @syrkos/filaxis
# or
npm install @syrkos/filaxis
```

- The SDK runs on Bun 1.x and Node LTS with zero runtime npm dependencies.
- SSH requires `ssh`. OpenSSH 7.3 or later supports the `-J` jump-host option. Persistent terminals require `tmux`, and the optional fast transfer path requires `sftp`.
- `await stack.features()` checks tools where Filaxis runs. If the agent runs in a container, this reports the container's tools. Check target-side capabilities through the target layer.

## MCP setup and agent skill

```bash
npm install -g @syrkos/filaxis
filaxis mcp-config                # JSON with mcpServers
filaxis mcp-config --format toml   # TOML with mcp_servers for Codex
```

`mcp-config` prints a snippet with absolute paths to the current runtime and the `filaxis-mcp` entry point. Merge it into the configuration for your MCP client and chosen scope.

The npm package includes the [agent skill and four playbooks](./docs/skills/SKILL.md) and the [runtime contract](./AGENTS.md). Register the skill according to your agent's conventions.

## File transfers

```bash
filaxis put --layer app -- ./config.yaml /app/config.yaml
filaxis get --host user@host --transport sftp -- /var/tmp/result.bin ./result.bin
```

`put` and `get` move one file at a time. The default exec transport follows the target layer, including entry into a container. Use `--transport sftp` when the SSH server exposes the target filesystem directly, including through a TCP jump host. Results include the verification level and write mode.

In MCP, use `put_file` or `get_file` with `local_path` on the MCP server host and `remote_path` in the target layer. Specify `layer` to address a named layer. For multiple files, use `put` and `get` steps in `run_batch`. The [file transfer playbook](./docs/skills/file-sync.md) includes examples.

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

The blind operations benchmark compared Filaxis CLI, Filaxis MCP, and raw SSH across three runs with the same model and no direct bypass. The latest run covered six failure points.

| Group | Interface | Steps | Wall time | Failures or retries | Total tokens (including cache) |
|---|---|---:|---:|---:|---:|
| Filaxis CLI | CLI and skill quick reference | 63 | 33m 53s | 9 | 2.89M |
| Filaxis MCP | Native MCP tools | 79 | 34m 44s | 4 | 4.45M |
| Raw SSH | Native SSH and shell | 93 | 35m 26s | 31 | 5.12M |

The CLI group used 43.6% fewer tokens than raw SSH. The MCP group had the fewest failures or retries. See the [benchmark report](https://github.com/corolin/filaxis/blob/main/benchmark.md) for the methodology and full results.

## License

Filaxis is licensed under [Apache-2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.
