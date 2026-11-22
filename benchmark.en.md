# `@syrkos/filaxis` Operational Benchmark Reports

[简体中文](./benchmark.md) · English

This document collects **4 controlled comparative operational benchmarks** of `@syrkos/filaxis` across different releases and network topologies:

1. **Report 1 (`v0.1.0`)**: Cross-region black-box troubleshooting and LAN explicit-instruction comparison (`Gemini-3.8-Flash`, 3 groups: Raw SSH / MCP / CLI)
2. **Report 2 (`v0.2.4`)**: LAN 4-way isolated Docker-in-Docker benchmark (`Gemini 4 Hydrogen`, 4 groups: Raw SSH / CLI / MCP / SDK, including `PUT` / `GET` binary file transfers)
3. **Report 3 (`v0.2.4`)**: Cross-region no-`ProxyJump` bastion multi-hop DinD benchmark (`Gemini 4 Hydrogen`, 4 groups: Raw SSH / CLI / MCP / SDK, including 3-layer traversal and payload-level token breakdown)
4. **Report 4 (`v0.2.5`)**: Cross-region no-`ProxyJump` bastion · **zero-hint pure black-box** 4-way DinD benchmark (`Gemini 4 Hydrogen`, 4 groups: Raw SSH / CLI / MCP / SDK, 9 hidden faults + single-file bind-mounts + cross-region `PUT` / `GET`)

---

## Benchmark Methodology and Limitations

To ensure readers accurately interpret every metric's boundary and engineering meaning, this report follows a uniform measurement baseline and disclosure scope:

1. **Environment isolation and single-run sampling limitation**
   - Within each run, all groups use the same model and execute in isolated subagents and target environments. `v0.2.4` and `v0.2.5` use 4 separate Docker-in-Docker sandboxes, each with its own `sshd`, `dockerd`, and filesystem, sharing the same physical host.
   - This collection consists of **controlled single-run operational samples rather than multi-seed statistical trials**; multi-run variance intervals are not reported. Single-run wall-clock time and reasoning length can vary with LLM sampling variance and transient cross-region network jitter. Consequently, **small wall-clock differences (e.g., 2s–6s) in a single run are not treated as decisive wins**; only order-of-magnitude gaps (such as 40%–50%+ wall-time reductions or dropping errors from multiple occurrences to 0) are treated as meaningful engineering signals.
2. **Model codenames and tiers**
   - `Gemini-3.8-Flash` and `Gemini 4 Hydrogen` are the lightweight fast-tier (Flash-class) model codenames displayed in the test harness, not all publicly marketed commercial SKU names. Within any single report, all control and experimental groups strictly use the same model; model generations differ across reports.
3. **Delivery baseline and primary comparison axes**
   - Every group passed the acceptance checks for its respective benchmark. Runs involving file transfers also verified live HTTP serving and SHA-256 checksums of uploaded and downloaded artifacts.
   - The benchmarks compare differences in wall-clock time, interaction turns, token composition, and execution stability across integration modes **given identical verified delivery**.
4. **Token accounting definitions and operational-only stripping formula**
   - `input` is the sum of non-cached input tokens per turn recorded in session logs. Because multi-turn requests may resend overlapping content, this sum can exceed the net context growth of the conversation.
   - `output` is taken from the logged output token field. `thinking` and tool-interaction payloads are counted separately by character length from log fields.
   - `cache_read` is the cached input tokens recorded in the logs. `non_cache` (active tokens) equals `input + output`, and `total` adds `cache_read`. Actual monetary cost depends on provider billing rules and pricing tiers; **total throughput tokens including cache should not be equated directly with API cost**.
   - `p_end - p_start` estimates net context growth from the context lengths at the start and end turns. Estimates and character counts in each table use the units labeled.
   - **Operational-only stripping rule** (applied to Reports 2–4): Let `t_op0` be the first turn in each group that issues a non-documentation-pre-read remote connection or inspection action (i.e., excluding `read_file` calls on `SKILL.md`, `file-sync.md`, MCP schemas, `.d.ts` declarations, or `--help` invocations). Pre-read documentation context overhead is `DocOverhead = (input[t_op0] + cache_read[t_op0]) - base_system_prompt`; operational fresh input is `Op Fresh Input = ∑(input for t > t_op0)`; operational output is `Op Output = ∑(output for t ≥ t_op0)`; operational active total is `Op Active = Op Fresh Input + Op Output`; and adjusted operational cache read stripping documentation volume is `AdjOpCache = ∑(max(0, cache_read - DocOverhead) for t ≥ t_op0)`.
5. **Boundaries for cross-version comparison**
   - `v0.1.0`, `v0.2.4` (LAN / cross-region white-box), and `v0.2.5` (cross-region black-box) differ in model under test, task structure, fault count, network path, and prompt hints.
   - Intra-report numbers compare interfaces on that specific benchmark. Cross-report data records observed behavior under different versions and scenarios; isolating version-to-version improvements requires re-running identical tasks.
6. **Uniform error and friction counting rules**
   - **Tool / command execution errors**: Counts every tool failure (`status=ERROR` / `status=fail`) or unexpected nonzero exit code that failed a step (e.g., nested shell quoting syntax errors, PowerShell pipe UTF-8 BOM/CRLF corruption, Win32 command-line length overflow, missing SDK exports, missing `scp` relay paths, or batch parameter validation rejections).
   - **Operational friction and extra rework**: Counts events that did not directly abort the task but forced extra decision turns or long blocks (e.g., newly created files with `0600` permissions causing `403 Forbidden` and requiring `chmod`, stream-device symlink blocking until default timeout, nonzero `--help` exits, or mistyped local truncated paths causing retries).
   - Each report table lists the specific triggers to distinguish **tool bugs**, **host shell friction**, and **occasional model typos**.

---

# Report 1: `v0.1.0` Multi-Hop SSH Operations Benchmark (Historical Baseline)

> Test environment: Local machine (Windows / PowerShell) connecting through a bastion host that forbids `ProxyJump` (no TCP forwarding) to reach a remote Linux target.
>
> Model under test: All control and experimental groups used **`Gemini-3.8-Flash`** (isolated subagents).

## 1. Group Definitions

| Group | Interface | Description |
| --- | --- | --- |
| **Group A** | **Raw SSH** | Standard native `ssh` commands and local shell only; no Filaxis code, CLI, or MCP allowed |
| **Group B** | **Filaxis MCP** | `@syrkos/filaxis v0.1.0` native stdio MCP Server (`filaxis-mcp`: `push_ssh` + `push_into` + `run_command` / `read_file` / `edit_file` / `run_batch` / `observe_stream`) |
| **Group C** | **Filaxis CLI** | `@syrkos/filaxis v0.1.0` CLI (including `SKILL.md` 10-second quick recipes + `layer save` + `--script-file` / `--request-file` / `--stdin-script` shell-free inputs) |

**Hard constraint**: Every group was strictly forbidden from connecting directly from the local machine to the target or using `ProxyJump` / `-J`. All traffic had to connect to the bastion first and initiate a second SSH hop from inside the bastion to the target (`directBypass = 0`).

## 2. Test 1: Cross-Region Black-Box Troubleshooting (Nginx + Tomcat + Redis + MySQL)

### 2.1 Scenario Design
- **Topology**: Local machine (Windows) → Cloud Server A (bastion) → Cloud Server B (ARM64 target), cross-cloud and cross-region multi-hop path.
- **Task format**: Dispatched as a production incident ticket (subagents were not told it was a benchmark), with **no container names, directory paths, or fault hints** — only that `http://127.0.0.1:<port>/api/health` was failing and all components had to be diagnosed and fixed until HTTP 200 with all components `OK`.
- **Actual fault chain (6 linked faults)**:
  1. Nginx `proxy_pass` pointed to container-local `127.0.0.1:8080`, causing `502 Bad Gateway`;
  2. Tomcat `server.xml` Connector port was set to `8081` (instead of `8080`);
  3. Tomcat lacked route mapping from `/api/health` to `/api/health.jsp`;
  4. `health.jsp` declared a local variable `out` colliding with the JSP implicit object, causing a Jasper compile error (HTTP 500);
  5. Redis `requirepass` did not match the password in `app.properties`;
  6. MySQL (MariaDB) was configured with `bind-address = 127.0.0.1`, rejecting cross-container connections on the same network.

### 2.2 Observed Results

| Group | Completion | Total wall time | Total steps | Failures / retries | `input` | `cache_read` | `output` | `non_cache` (`in+out`) | `total` (incl. cache) |
| --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **A: Raw SSH** | 6/6 | 43m 26s | 93 | 32 | 253,619 | 4,827,511 | 36,655 | 290,274 | 5,117,785 |
| **B: Filaxis MCP** | 6/6 | 34m 44s | 79 | **4** | 223,526 | 4,201,517 | **26,425** | 249,951 | 4,451,468 |
| **C: Filaxis CLI** | 6/6 | **33m 53s** | **63** | 9 | **181,517** | **2,670,877** | 33,719 | **215,236** | **2,886,113** |

### 2.3 Reductions Relative to Raw SSH

| Metric | B (Filaxis MCP) vs A (Raw SSH) | C (Filaxis CLI) vs A (Raw SSH) |
| --- | ---: | ---: |
| **Wall-clock time** | ↓ 8m 42s (**20.0% faster**) | ↓ 9m 33s (**22.0% faster**) |
| **LLM interaction steps** | ↓ 14 steps (**↓ 15.1%**) | ↓ 30 steps (**↓ 32.3%**) |
| **Command failures / retries** | ↓ 28 (**↓ 87.5%**) | ↓ 23 (**↓ 71.9%**) |
| **Non-cache tokens (`input + output`)** | ↓ 40,323 (**↓ 13.9%**) | ↓ 75,038 (**↓ 25.9%**) |
| **Output tokens (`output`)** | ↓ 10,230 (**↓ 27.9%**) | ↓ 2,936 (**↓ 8.0%**) |
| **Total throughput tokens (incl. `cache_read`)** | ↓ 666,317 (**↓ 13.0%**) | ↓ 2,231,672 (**↓ 43.6%**) |

## 3. Test 2: LAN Explicit-Instruction Comparison (5 Targeted Faults)

> Topology: Local machine (Windows) → LAN bastion (sshd explicitly configured with `AllowTcpForwarding no` to block `ProxyJump`) → LAN target.
>
> The prompt explicitly identified the 5 container/script targets and ports (Nginx syntax error, Python API division-by-zero, Worker lock file blocking, security script permissions and config validation, Redis `bind 127.0.0.1`).

| Group | Wall time | Total steps | Phase 1 (connect/setup) `non_cache` | Phase 2 (diagnose) `non_cache` | Phase 3 (fix/verify) `non_cache` | Total `non_cache` | Total `total` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **A: Raw SSH** | 7m 38s | **31** | 23,697 (3 steps) | 40,758 (14 steps) | 48,736 (14 steps) | **113,191** | **916,699** |
| **B: Filaxis MCP** | **7m 04s** | 41 | 41,120 (9 steps) | 63,857 (18 steps) | 80,285* (14 steps) | 185,262* | 1,314,397 |
| **C: Filaxis CLI** | 12m 06s | 46 | 32,097 (5 steps) | **32,718 (11 steps)** | 88,219 (30 steps) | 153,034 | 1,602,260 |

> *Note: In Test 2, Group B hit two server-side Prompt Cache Misses during Phases 2 and 3 (single-turn `input` reached 15,408 and 37,553 respectively), adding ~48k `input`; even so, Group B's generated `output` in Phase 3 (9,173) remained lower than Group A (10,329) and Group C (12,063), and its wall-clock time was the shortest.*

## 4. Key Findings (`v0.1.0`)

1. When target paths are explicitly given, Raw SSH can finish in a few fixed commands, and models tend to fall back to "local `base64` encode and overwrite whole files," trading fewer steps for the loss of CAS verification, lock protection, and Docker bind-mount inode preservation.
2. Once the task shifts to **zero-hint cross-region multi-hop troubleshooting**, raw SSH across **PowerShell → Bastion Bash → Target Bash** suffers frequent quote-stripping, premature variable expansion, and redirection landing on the bastion host, driving Group A to **32 failures/retries**, **93 steps**, and **43 minutes**.

---

# Report 2: `v0.2.4` LAN 4-Way Isolated DinD Benchmark (with `PUT` / `GET` File Transfers)

> **Version under test**: `@syrkos/filaxis v0.2.4`
>
> **Model under test**: All 4 groups used **`Gemini 4 Hydrogen`** (isolated concurrent subagents).
>
> **Test environment**: Local machine (Windows / PowerShell) → **4 isolated Docker-in-Docker (`docker:dind`) sandboxes** running on a LAN x86_64 host. Each DinD sandbox had its own SSH port, its own `dockerd` daemon, and an independent `/opt/battlefield` filesystem, with identical container names and paths across all 4 groups.

## 1. Groups and Task Scope

| Group | Interface | Strict tool constraints |
| --- | --- | --- |
| **Group 1** | **Raw SSH** | Native Windows `ssh.exe` / `scp.exe` only; no Filaxis tools or code allowed |
| **Group 2** | **Filaxis CLI** | `filaxis` CLI only (`layer save` / `exec` / `edit` / `batch` / `put` / `get`) |
| **Group 3** | **Filaxis MCP** | `filaxis` MCP tools only (`push_ssh` / `push_into` / `run_batch` / `run_command` / `edit_file` / `read_file` / `put_file` / `get_file`) |
| **Group 4** | **Filaxis SDK** | TypeScript script in an isolated directory run via `bun run` calling `@syrkos/filaxis` SDK (`RuntimeStack` / `layerInto` / `runBatch` / `editFile`) |

### Task Checklist (4 Container Faults + Long-Filename Image `PUT` + In-Container Backup `GET`)
Each DinD sandbox ran the same 4-service stack on Docker network `battlefield-net`:
1. **`app-redis` fault**: `/opt/battlefield/redis/redis.conf` contained an invalid eviction policy `maxmemory-policy volatile-lru-invalid` (causing crash loops) and `bind 127.0.0.1` (blocking cross-container connections).
2. **`app-mysql` fault**: `/opt/battlefield/mysql/my.cnf` had `skip-networking = 1` and `port = 3307` (disabling TCP listening and mismatching `3306`).
3. **`app-springboot` fault**: `/opt/battlefield/springboot/application.yml` had a database password mismatch against `init.sql`, and Redis host set to `127.0.0.1` (instead of `app-redis`).
4. **`app-nginx` fault**: `/opt/battlefield/nginx/conf.d/default.conf` had a syntax error (`proxy_read_timeout 30s_typo;`) causing crashes, upstream port pointing to `9090` (instead of `8080`), and `location ~* \.(jpg|jpeg|png)$ { deny all; }` blocking image access.
5. **`PUT` upload verification**: Upload a local JPEG image with a 196-character filename (`90,576` bytes, preserving original filename) into Nginx's static directory, returning `HTTP/1.1 200 OK` over Nginx with matching SHA-256.
6. **`GET` in-container retrieval verification**: Pull `/app/backups/springboot-prod-backup.tar.gz` (`24,877` bytes) from inside the `app-springboot` container (not mounted on the host) to the local receiving directory, byte-exact with matching SHA-256.

## 2. Overall Results and Operational-Only Comparison

> All 4 groups passed independent verifier checks against live HTTP endpoints (`/actuator/health`, long-filename image `200 OK` and SHA-256) and SHA-256 checksums of pulled backup files, achieving a **100% pass rate**.

### 2.1 Full Run Totals (Including P0 Cold-Start Reading of `SKILL.md` / Schemas / `.d.ts`)

| Metric | Group 1: Raw SSH | Group 2: Filaxis CLI 🏆 | Group 3: Filaxis MCP | Group 4: Filaxis SDK |
| :--- | :---: | :---: | :---: | :---: |
| **Wall-clock time** | `108.0s` | **`102.0s` (fastest)** | `128.0s` | `177.0s` |
| **LLM decision turns** | `11 turns` | **`9 turns` (fewest)** | `10 turns` | `14 turns` |
| **Fresh input (`input_tokens`)** | **`48,797`** | `49,813` | `54,308` | `76,982` |
| **Model output (`output_tokens`)** | **`9,404`** | `11,794` | `12,517` | `17,128` |
| **Active total (`input + output`)** | **`58,201`** | `61,607` | `66,825` | `94,110` |
| **Cache read (`cache_read_tokens`)** | `263,463` | **`249,047` (lowest)** | `315,228` | `605,273` |
| **Errors / friction** | ❌ **2 errors** (3-layer quoting syntax error + PowerShell UTF-8 BOM mangled command) + 1 background timeout poll | ✅ **0 remote errors** (only `filaxis --help` exited with code `1` during pre-check) | ✅ **0 tool errors** (1 `put` newly created file got `0600` causing 403, fixed with `chmod 644`) | ❌ **1 missing-export error** (`transferLayerFile` not re-exported at root) + 1 `0600` `chmod` fix |

### 2.2 Operational-Only Totals (Excluding P0 Documentation Pre-Read, Starting from First Connection/Inspection Action)

| Operational-only metric (excluding P0 doc pre-read & base prompt) | Group 2: Filaxis CLI 🏆 | Group 3: Filaxis MCP | Group 1: Raw SSH (baseline) | Group 4: Filaxis SDK |
| :--- | :---: | :---: | :---: | :---: |
| **Stripped pre-read doc overhead** | `7,566` tokens | `9,186` tokens | `0` | `14,809` tokens |
| **Operational wall time** | **`88.0s` (18.5% faster)** | `121.0s` | `108.0s` | `169.0s` |
| **Operational turns** | **`6 turns` (45.5% fewer)** | **`9 turns` (18.2% fewer)** | `11 turns` | `12 turns` |
| **Operational fresh input (`Op Fresh Input`)** | **`17,482` (38.3% fewer)** | **`24,345` (14.1% fewer)** | `28,348` | `41,332` |
| **Operational active total (`Op Fresh In + Out`)** | **`28,458` (24.6% fewer)** | **`35,940` (4.8% fewer)** | `37,752` | `57,821` |
| **Operational cache read (adjusted)** | **`158,346` (39.9% fewer)** | **`232,554` (11.7% fewer)** | `263,463` | `406,721` |

> **Key Findings (Single-Hop LAN)**:
> - Excluding doc pre-read, **Filaxis CLI** combined `layer save` + `batch --stdin-json` + `put --transport sftp` + `--docker` direct container access to achieve **24.6% fewer operational active tokens**, **18.5% faster wall time**, **45.5% fewer turns**, and **0 remote errors** compared to Raw SSH.
> - **Filaxis MCP** completed all 4 config edits, the long-filename image upload, dependency-ordered restarts (`after`) across 4 containers, and health checks in a single `run_batch` turn, demonstrating high single-step orchestration density.

---

# Report 3: `v0.2.4` Cross-Region No-`ProxyJump` Bastion Multi-Hop DinD Benchmark

> **Version under test**: `@syrkos/filaxis v0.2.4`
>
> **Model under test**: All 4 groups used **`Gemini 4 Hydrogen`** (isolated concurrent subagents).
>
> **Network topology**: **Local machine (Windows / PowerShell) → Cross-region Bastion A (`sshd` explicitly configured with `AllowTcpForwarding no`, physically blocking `-J` / `ProxyJump`) → SSH from inside Bastion A to 4 isolated DinD sandboxes on a cross-region ARM64 Host B → enter `app-springboot` container** (a 3-layer deep pipeline).
>
> **Security constraint**: The `authorized_keys` inside all 4 downstream DinD sandboxes kept **only Bastion A's internal public key** (local machine public keys were completely removed), guaranteeing no group could bypass the bastion or connect directly via `-J` / `scp -J`. Task scope matched Report 2 (4 container faults + cross-region 196-char image `PUT` + cross-region in-container backup `GET`).

## 1. Full Totals vs. Operational-Only Comparison

> All 4 groups passed independent verifier checks on the cross-region host (HTTP health, image SHA-256, and local retrieved backup SHA-256), achieving a **100% pass rate**.

### 1.1 Full Run Totals (Including P0 Reading Docs / Schemas / Types)

| Metric (Full Run) | Group 4: Filaxis SDK 🏆 | Group 3: Filaxis MCP 🏆 | Group 1: Raw SSH | Group 2: Filaxis CLI |
| :--- | :---: | :---: | :---: | :---: |
| **Wall-clock time** | **`211.0s` (1st)** | **`213.0s` (2nd, +2s)** | `229.0s` | `328.0s`* |
| **Total turns** | `16 turns` | `14 turns` | `13 turns` | `19 turns` |
| **Fresh input (`input_tokens`)** | `83,662` | `66,935` | **`54,118`** | `75,448` |
| **Model output (`output_tokens`)** | `16,774` | `17,449` | **`11,836`** | `16,443` |
| **Active total (`input + output`)** | `100,436` | `84,384` | **`65,954`** | `91,891` |
| **Cache read (`cache_read_tokens`)** | `661,304` | `453,696` | **`340,234`** | `700,362` |
| **Remote execution errors / failures** | ✅ **0 remote errors** (1 `0600` `chmod` fix) | ✅ **0 remote errors** (3 local UUID path typos + 1 `chmod` fix) | ❌ **4 severe execution failures** (double-layer quote crash, 2× BOM mangled commands, Win32 command-line overflow crash, wrote 0-byte empty image) | ⚠️ **2 CLI errors + 1× 120s block** (hit `filaxis batch` layer resolver bug + `tail` on container `/dev/stderr` symlink hung for 120s) |

> *Note: When diagnosing Nginx 403, Group 2 (CLI) ran `docker exec app-nginx tail -n 10 /var/log/nginx/error.log`; because `nginx:alpine` symlinks that log to `/dev/stderr`, it blocked for the full `120s` default timeout. Excluding that 120s wait, elapsed time was ~`208s`.*

### 1.2 Operational-Only Totals (Excluding P0 Doc Pre-Read)

| Operational-only metric (excl. P0 doc pre-read) | Group 4: Filaxis SDK 🏆 | Group 3: Filaxis MCP 🏆 | Group 1: Raw SSH (baseline) | Group 2: Filaxis CLI |
| :--- | :---: | :---: | :---: | :---: |
| **Stripped pre-read doc overhead** | `14,584` tokens | `9,008` tokens | `0` | `5,707` tokens |
| **Operational wall time** | **`187.0s` (18.3% faster)** | **`207.0s` (9.6% faster)** | `229.0s` | `323.0s` *(`203s` excl. hang)* |
| **Operational turns** | **`11 turns`** | `13 turns` *(**10 turns** excl. local UUID typos)* | `13 turns` | `18 turns` |
| **Operational fresh input (`Op Fresh Input`)** | `41,835` | `36,884` | **`33,442`** | `48,831` |
| **Operational model output (`Op Output`)** | `14,935` | `16,705` | **`11,836`** | `16,303` |
| **Operational active total (`Op Fresh In + Out`)** | `56,770` | `53,589` | **`45,278`** | `65,134` |
| **Operational cache read (adjusted)** | `386,555` | **`336,592` (lowest, below Raw SSH)** | `340,234` | `597,636` |

## 2. Deep Dive: Why Did Raw SSH Appear Lower in Nominal Cross-Region Tokens?

Character counts of `tool_calls`, `tool_response`, and `thinking` fields were extracted from all 4 groups' `transcript_full.jsonl`, alongside estimated net context growth.

| Operational-phase payload breakdown | Group 3: Filaxis MCP 🏆 | Group 1: Raw SSH (baseline) | Group 2: Filaxis CLI | Group 4: Filaxis SDK |
| :--- | :---: | :---: | :---: | :---: |
| **① Total `ToolCall` length emitted by model** | **`12,805` chars (↓ 15.0%)** | `15,057` chars | `14,257` chars (↓ 5.3%) | `15,060` chars |
| **② Total `ToolResp` returned to model** | **`14,978` chars (↓ 28.9%)** | `21,067` chars | `31,642` chars | `46,107` chars |
| **👉 Bidirectional tool payload (`① + ②`)** | **`27,783` chars (23.1% smaller)** 🏆 | **`36,124` chars** | `45,899` chars | `61,167` chars |
| **③ Internal `Thinking` chain length** | `12,137` chars (**2.19×**) | **`5,535` chars** | `11,567` chars (2.09×) | `12,375` chars (2.24×) |
| **👉 Net business context growth (excl. `Thinking` & local typos)** | **`~13,315` tokens (19.1% smaller)** 🏆 | `~16,460` tokens | `~23,095` tokens | `~23,838` tokens |

**Log Observations and Likely Explanations**

1. **Batch planning generated longer `thinking`**. Raw SSH logged `5,535` `thinking` characters over 13 turns. The MCP group assembled 4 file edits, image upload, and container restart dependencies in a single `run_batch` call, logging `5,407` characters on that turn alone. Actual billing impact requires invoice verification.
2. **Retries inflated cumulative `input`**. The MCP group retried 3 turns due to local `output.txt` path typos, logging `6,657` cumulative input tokens while estimated net context growth was `~1,806`. Cache block alignment is a plausible factor; exact caching behavior depends on server-side mechanisms.
3. **Persistent layer reuse**. The SDK and MCP groups used a resident `RuntimeStack` and completed uploads/downloads without staging files on the bastion host. Operational wall times were `187s` and `207s` vs. Raw SSH's `229s` (end-to-end times recorded; individual handshake counts were not separately instrumented).

## 3. `v0.2.4` Improvements Directly Identified by This Benchmark (Fixed for `v0.2.5`)

1. **New files created by `put` / `put_file` (`transport: "exec"`) defaulted to `0600`**: `mktemp` creates staging files with `0600`, and when the target file did not exist, `mv` preserved `0600`, causing non-root workers (like Nginx) to hit `403 Forbidden` on static assets. Fixed by setting standard `0644` (or respecting remote `umask`) for newly created files before placement.
2. **`filaxis batch` CLI lacked a `resolveLayer` callback**: When `plan.json` specified a `layer` field, the CLI errored with `[filaxis] batch plan specifies layer, requiring a layer resolver`. Wired local persistent layer resolution into the CLI.
3. **Export single-file transfer function from SDK root `src/index.ts`**: Re-exported `transferLayerFile` and added SDK transfer examples to `SKILL.md`.
4. **Standardize `filaxis --help` exit code**: Write help output to `stdout` and exit with code `0` when `--help` is explicitly requested.

---

# Report 4: `v0.2.5` Cross-Region No-`ProxyJump` Bastion · Pure Black-Box 4-Way DinD Benchmark

> **Version under test**: `@syrkos/filaxis v0.2.5` (including the fixes for `exec` new-file `0600` permissions, root `transferLayerFile` export, `filaxis batch` layer resolution, and `--help` exit code).
>
> **Model under test**: All 4 groups used **`Gemini 4 Hydrogen`** (isolated concurrent subagents).
>
> **Network topology**: **Local machine (Windows / PowerShell) → Cross-region Bastion A (`AllowTcpForwarding no`, physically blocking `-J` / `ProxyJump`) → SSH from inside Bastion A to 4 isolated DinD sandboxes on a cross-region ARM64 Host B → enter the order-service container**.
>
> **Black-box constraint (0 container names / 0 path hints)**: The incident ticket given to all 4 groups provided only the failing endpoint `http://127.0.0.1:8080/api/orders/health`, asking each agent to locate the gateway's static root, upload a 196-character JPEG (`90,576` bytes) returning `HTTP 200`, and find and retrieve the latest `.tar.gz` backup (`30,026` bytes) from inside the order-service container for local SHA-256 verification. All configs were placed in non-default nested directories (including single-file bind-mounts) with **9 linked faults**: Nginx syntax error + wrong upstream port + `deny all` on static images + non-default `root`; Redis invalid policy + `bind 127.0.0.1`; MySQL `skip-networking = 1` + port mismatch; and order-service wrong DB hostname/stale password + wrong Redis host/port.

## 1. Full Run Totals (Including P0 Reading Docs / Schemas / `.d.ts`)

> All 4 groups passed independent verifier checks on the cross-region host (HTTP health, image SHA-256, and local retrieved backup SHA-256), achieving a **100% pass rate**.

| Metric (Full Run) | Group 3: Filaxis MCP `0.2.5` 🏆 | Group 4: Filaxis SDK `0.2.5` 🥈 | Group 2: Filaxis CLI `0.2.5` 🥉 | Group 1: Raw SSH (baseline) |
| :--- | :---: | :---: | :---: | :---: |
| **Wall-clock time** | **`225.0s` (53.4% faster)** | **`273.0s` (43.5% faster)** | **`368.0s` (23.8% faster)** | `483.0s` |
| **Total turns** | **`14 turns` (41.7% fewer)** | **`18 turns` (25.0% fewer)** | **`22 turns` (8.3% fewer)** | `24 turns` |
| **Fresh input (`input_tokens`)** | **`67,164` (22.4% fewer)** | `89,294` | `88,327` | `86,545` |
| **Model output (`output_tokens`)** | **`14,133` (31.4% fewer)** | **`15,269` (25.9% fewer)** | **`18,260` (11.4% fewer)** | `20,606` |
| **Full active total (`input + output`)** | **`81,297` (24.1% fewer)** | **`104,563` (2.4% fewer)** | **`106,587` (0.5% fewer)** | `107,151` |
| **Cache read (`cache_read_tokens`)** | **`480,439` (46.2% fewer)** | **`785,454` (12.0% fewer)** | `945,270` | `892,674` |
| **Total throughput tokens (incl. cache)** | **`561,736` (43.8% fewer)** | **`890,017` (11.0% fewer)** | `1,051,857` | `999,825` |
| **Errors / failures** | ✅ **`0` (zero rework)** | ✅ **`0` (zero rework)** | ⚠️ `3` (multi-layer `--enter` flag adjustments) | ❌ **`4`** (PS `-i` parsing error, quoting error, BOM+CRLF error, `scp` missing relay file) |

## 2. Operational-Only Totals (Excluding P0 Doc Pre-Read) and Payload Comparison

| Operational & payload metric (excl. P0 doc pre-read) | Group 3: Filaxis MCP `0.2.5` 🏆 | Group 4: Filaxis SDK `0.2.5` 🥈 | Group 2: Filaxis CLI `0.2.5` 🥉 | Group 1: Raw SSH (baseline) |
| :--- | :---: | :---: | :---: | :---: |
| **Stripped pre-read doc overhead** | `9,676` tokens | `15,409` tokens | `6,380` tokens | `0` |
| **Operational wall time** | **`218.0s` (54.9% faster)** | **`264.0s` (45.3% faster)** | **`362.0s` (25.1% faster)** | `483.0s` |
| **Operational turns** | **`13 turns` (45.8% fewer)** | **`16 turns` (33.3% fewer)** | **`21 turns` (12.5% fewer)** | `24 turns` |
| **Operational active total (`Op Fresh In + Out`)** | **`50,362` (42.1% fewer)** 🏆 | **`67,823` (22.0% fewer)** | **`79,535` (8.5% fewer)** | `86,917` |
| **Operational cache read (adjusted)** | **`354,651` (60.3% fewer)** 🏆 | **`518,357` (41.9% fewer)** | **`811,290` (9.1% fewer)** | `892,674` |
| **Estimated net context growth (`p_end - p_start`)** | **`24,001` (42.4% smaller)** 🏆 | **`36,398` (12.6% smaller)** | **`37,966` (8.9% smaller)** | `41,659` |
| **Bidirectional tool payload (`ToolCall + ToolResp`)** | **`40,374` chars (46.3% smaller)** 🏆 | `76,262` chars | **`71,919` chars (4.3% smaller)** | `75,178` chars |

## 3. Key Verification Conclusions (`v0.2.5` Black-Box Run)

1. **Verified upload permissions, root SDK export, and in-place bind-mount editing**. All three Filaxis groups (MCP, SDK, and CLI) uploaded the new image via exec with `HTTP 200` on the first request. The SDK group imported `transferLayerFile` directly. Single-file bind-mounted configs were edited with `write_mode: "inplace"`, preserving their inodes and passing service health checks without container recreation.
2. **MCP achieved the lowest wall time and error count**. With zero path or container-name hints, the Raw SSH group hit PowerShell argument parsing, nested quoting, BOM/CRLF, and relay-path errors. In this run, Filaxis MCP recorded 0 errors while reducing full-run wall time by **53.4%**, full active tokens by **24.1%**, operational active tokens by **42.1%**, and operational cache reads by **60.3%** relative to Raw SSH.
