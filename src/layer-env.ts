/**
 * layer-env.ts — 层环境规格与自发现（FEAT-16 / AC-17）
 *
 * 净室平移自 个人Agent项目 `原内部模块` Phase A 段
 * ，OSS 化：
 * - yaml 依赖剥 → JSON 持久化（零 npm 依赖红线；语义等价，格式记实施偏差）
 * - scrubber 剥 → 探测只落蒸馏值（版本/有无/型号），全量输出不落盘（hook 面=exec 回调在消费方）
 * - 观察投影/行为契约（源 Phase B/C 轴）不随——属消费方策略层
 *
 * 语义（生产锤炼）：两段式探测（快亚秒 + 慢包导入）；PTY 回显防御（值含 $( 一律
 * 丢弃）；探测真实性红线（nvidia-smi 失败文案不得记为 GPU 型号）；环境身份键
 * hops 不进键（同落点经不同路径=同一环境）。
 */
import { createHash } from "node:crypto";
import { rename, stat, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeDescriptor } from "./driver.js";
import { enterStepsOf, type SshConnParams } from "./ssh-helpers.js";

// ════════════════ 数据模型 ════════════════

/** 层环境规格（蒸馏快照——版本号/有无/型号，非全量 dump） */
export interface LayerEnvironmentSpec {
    os?: string;
    kernel_arch?: string;
    python?: string;
    node?: string;
    bun?: string;
    java?: string;
    cuda?: string;
    gpu?: { model: string; vram_mb?: number };
    docker?: boolean;
    /** 关键包（present-only，"torch@2.4.0" 形态；匹配按 @ 前名） */
    packages?: string[];
}

export interface SshHopLite {
    host: string;
    conn?: SshConnParams;
}

/** 重进路径投影（agent 据此零试错重进该层；环境身份不含 hops，重进路径含） */
export interface LayerConnectionInfo {
    driver: string;
    target?: string;
    conn?: SshConnParams;
    hops?: SshHopLite[];
    enters?: Array<{ cmd: string; label?: string }>;
    launch_cmd?: string;
}

/** 单层条目 */
export interface LayerEnvEntry {
    connection: LayerConnectionInfo;
    environment: LayerEnvironmentSpec;
    discovered_at: string;
    /** 连接拓扑+环境快照 hash（漂移检测锚点：命中不一致 → stale 供重探，不自动覆盖） */
    fingerprint: string;
    /** 探测部分失败的说明（诚实标注，不假装完整） */
    probe_note?: string;
}

export interface LayerEnvConfigFile {
    layers: Record<string, LayerEnvEntry>;
}

// ════════════════ 环境身份键 ════════════════

/**
 * 环境身份键（两键两职责之一：driverKey 管连接复用，本键管规格归属）：
 * 落点[+端口]/enter 标签链——hops 不进键（同落点经不同路径=同一环境规格）。
 */
export function layerEnvKey(desc: RuntimeDescriptor): string {
    if (desc.driver === "local") return "local";
    const c = (desc.config ?? {}) as Record<string, unknown>;
    if (c.pty === true) {
        const conn = c.connParams as SshConnParams | undefined;
        const hostPart = `${desc.target ?? "?"}${conn?.port ? `:${conn.port}` : ""}`;
        const enters = enterStepsOf(c).map((s) => s.label ?? slugify(s.cmd));
        return [hostPart, ...enters].join("/");
    }
    // 非 pty：connParams.port 进键（自挖 S1：同 host 不同 port=物理不同环境
    // ——22 与 2222 曾互踩同键，规格互相覆盖；与 driverKey 连接键口径对齐）
    const conn = c.connParams as SshConnParams | undefined;
    return `${desc.driver}:${desc.target ?? "default"}${conn?.port ? `:${conn.port}` : ""}`;
}

function slugify(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40) || "enter";
}

// ════════════════ 两段式探测命令 ════════════════

/** stage 1（快：亚秒级）——OS/架构/语言运行时/GPU/CUDA/docker；输出行 `fx_key=value` */
export function buildProbeStage1(): string {
    return [
        // 引号原样直书——'\\"' 会发出两字符 cut 分隔符（真机 PTY 实证）
        // os-release 缺席时的 fallback 链（报告 #4：群晖 DSM 用 /etc.defaults/VERSION）
        `echo "fx_os=$(grep PRETTY_NAME /etc/os-release 2>/dev/null | head -1 | cut -d'"' -f2)"`,
        `echo "fx_os_dsm=$(grep -E '^productversion=' /etc.defaults/VERSION 2>/dev/null | sed 's/productversion=/Synology DSM v/;s/"//g')"`,
        `echo "fx_kernel_arch=$(uname -s -m 2>/dev/null)"`,
        `echo "fx_python=$(if command -v python3 >/dev/null 2>&1; then python3 --version 2>&1; elif command -v python >/dev/null 2>&1; then python --version 2>&1; fi | head -1)"`,
        `echo "fx_node=$(node --version 2>&1 | head -1)"`,
        `echo "fx_bun=$(bun --version 2>&1 | head -1)"`,
        `echo "fx_java=$(java -version 2>&1 | head -1)"`,
        `echo "fx_gpu=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1)"`,
        `echo "fx_cuda=$(nvidia-smi 2>/dev/null | grep -o 'CUDA Version: [0-9.][0-9.]*' | head -1 | grep -o '[0-9][0-9.]*')"`,
        `echo "fx_docker=$(command -v docker >/dev/null 2>&1 && echo yes || echo no)"`,
    ].join("; ");
}

/** stage 2（慢：python 冷导入 10s+）——关键包版本；有 GNU timeout 逐项 15s 兜底 */
export function buildProbeStage2(): string {
    const py = `command -v python3 >/dev/null 2>&1 && echo python3 || echo python`;
    const parts = [
        `__FX_PY=$(${py}); __FX_TO=""; command -v timeout >/dev/null 2>&1 && __FX_TO="timeout 15"`,
    ];
    for (const pkg of PROBE_PACKAGES) {
        if (pkg.kind === "python") {
            parts.push(`echo "fx_pkg_${pkg.key}=$($__FX_TO "$__FX_PY" -c '${pkg.probe}' 2>/dev/null)"`);
        } else {
            parts.push(`echo "fx_tool_${pkg.key}=$($__FX_TO ${pkg.probe} 2>/dev/null | head -1)"`);
        }
    }
    return parts.join("; ");
}

/** 关键包探测清单（扩展在此加行） */
export const PROBE_PACKAGES: Array<{ key: string; kind: "python" | "tool"; probe: string; matchNames: string[] }> = [
    { key: "torch", kind: "python", probe: "import torch;print(torch.__version__)", matchNames: ["torch", "pytorch"] },
    { key: "transformers", kind: "python", probe: "import transformers;print(transformers.__version__)", matchNames: ["transformers", "huggingface"] },
    { key: "onnxruntime", kind: "python", probe: "import onnxruntime;print(onnxruntime.__version__)", matchNames: ["onnxruntime", "onnx"] },
    { key: "numpy", kind: "python", probe: "import numpy;print(numpy.__version__)", matchNames: ["numpy"] },
    { key: "ffmpeg", kind: "tool", probe: "ffmpeg -version", matchNames: ["ffmpeg"] },
    { key: "git", kind: "tool", probe: "git --version", matchNames: ["git"] },
];

/**
 * 探测输出解析（纯函数）：`fx_key=value` 行 → 蒸馏规格。
 * PTY 回显防御：回显行是未展开原文（值含 `$(`）——一律丢弃。
 * 真实性红线：nvidia-smi 失败文案（驱动不通信）不得记为 GPU 型号。
 */
export function parseProbeOutput(stdout: string): LayerEnvironmentSpec {
    const spec: LayerEnvironmentSpec = {};
    const pkgs: string[] = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        const m = rawLine.trim().match(/^fx_([a-z0-9_]+)=(.*)$/);
        if (!m) continue;
        const val = m[2]!.trim();
        if (!val || val.includes("$(") || val.includes("__FX")) continue; // 回显防御
        switch (m[1]) {
            case "os": spec.os = val || undefined; break;
            case "os_dsm": if (val) spec.os = val; break; // DSM fallback 覆盖空 os
            case "kernel_arch": spec.kernel_arch = val; break;
            case "python": if (/Python \d/.test(val)) spec.python = val; break;
            case "node": if (/^v?\d/.test(val)) spec.node = val.replace(/^v/, ""); break;
            case "bun": if (/^\d+\./.test(val)) spec.bun = val; break;
            case "java": if (/version/i.test(val)) spec.java = val; break;
            case "gpu": {
                const gm = val.match(/^(.+?),\s*(\d+)\s*MiB$/);
                if (gm) {
                    spec.gpu = { model: gm[1]!.trim(), vram_mb: parseInt(gm[2]!, 10) };
                } else if (val && looksLikeGpuModel(val)) {
                    spec.gpu = { model: val };
                }
                break;
            }
            case "cuda": if (/^\d+(\.\d+)*$/.test(val)) spec.cuda = val; break;
            case "docker": spec.docker = val === "yes"; break;
            default: {
                const pm = m[1]!.match(/^(?:pkg|tool)_(.+)$/);
                if (pm) {
                    const key = pm[1]!;
                    const def = PROBE_PACKAGES.find((p) => p.key === key);
                    const version = extractVersion(val);
                    const name = def?.key ?? key;
                    pkgs.push(version ? `${name}@${version}` : name);
                }
            }
        }
    }
    if (!spec.os && spec.kernel_arch) spec.os = spec.kernel_arch.split(/\s+/)[0];
    if (pkgs.length > 0) spec.packages = [...new Set(pkgs)];
    return spec;
}

function extractVersion(raw: string): string | undefined {
    if (!raw) return undefined;
    const bounded = raw.slice(0, 256);
    const m = bounded.match(/(\d+(?:\.\d+)+(?:[a-z_-][a-z0-9._-]*)?)/i) || bounded.match(/version\s+(\S+)/i) || bounded.match(/(\d+\.\d+)/);
    return m?.[1];
}

/** 裸 GPU 型号形态收窄：短、无句子气、非报错文案（生产实证：失败文案曾被记为型号） */
function looksLikeGpuModel(val: string): boolean {
    if (val.length > 60) return false;
    if (/failed|error|couldn|can't|unable|no device|not found|driver/i.test(val)) return false;
    if (/[.!?]$/.test(val)) return false;
    return /^[A-Za-z0-9 ()+.-]+$/.test(val);
}

// ════════════════ 持久化（JSON + 原子写 + mtime 缓存） ════════════════

export class LayerEnvStore {
    private cache: { mtimeMs: number; cfg: LayerEnvConfigFile } | null = null;
    /** 写链串行（自挖 S2：load-modify-save 无锁——并发 upsert 后者以旧 cfg 覆盖
     *  前者写入，丢更新；实例级 promise 链保证读-改-写原子序） */
    private writeChain: Promise<unknown> = Promise.resolve();

    constructor(public readonly path: string) {}

    async load(force = false): Promise<LayerEnvConfigFile> {
        let mtimeMs = 0;
        try {
            mtimeMs = (await stat(this.path)).mtimeMs;
        } catch {
            const cfg: LayerEnvConfigFile = { layers: {} };
            this.cache = { mtimeMs: 0, cfg };
            return cfg;
        }
        if (!force && this.cache?.mtimeMs === mtimeMs) return this.cache.cfg;
        try {
            const parsed = JSON.parse(await readFile(this.path, "utf-8")) as LayerEnvConfigFile;
            const cfg: LayerEnvConfigFile = parsed?.layers && typeof parsed.layers === "object"
                ? { layers: parsed.layers }
                : { layers: {} };
            this.cache = { mtimeMs, cfg };
            return cfg;
        } catch {
            return this.cache?.cfg ?? { layers: {} }; // 坏文件：不崩，返回空
        }
    }

    /** 原子写（公共）：抢跨实例文件锁后走 saveLocked */
    async save(cfg: LayerEnvConfigFile): Promise<void> {
        const release = await this.acquireLock();
        try {
            await this.saveLocked(cfg);
        } finally {
            await release.finalize();
        }
    }

    /** 无锁写（调用方持锁）：tmp+rename 原子落位
     *  tmp 带进程 nonce（Hydrogen R2 #7）：固定名跨进程踩踏/rename ENOENT */
    private async saveLocked(cfg: LayerEnvConfigFile): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.${process.pid}-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 6)}.tmp`;
        await writeFile(tmp, JSON.stringify(cfg, null, 2), "utf-8");
        await rename(tmp, this.path);
        this.cache = null; // 失效缓存（下次 load 重 stat）
    }

    /** 跨实例文件锁（Sol 54 P2-9）：O_CREAT|O_EXCL 探针 + 陈锁回收（>5s 强占） */
    private async acquireLock(): Promise<(() => Promise<void>) & { verifyHeld(): Promise<boolean>; finalize(): Promise<void> }> {
        // mkdir 前置（Sol 55 P2-A）：曾先开锁文件——新目录首写 ENOENT（目录创建
        // 在 saveLocked 的锁内执行不到）
        await mkdir(dirname(this.path), { recursive: true });
        const lock = `${this.path}.lock`;
        const { open, unlink, readFile } = await import("node:fs/promises");
        // 锁内 nonce（Sol 55 P2-B）：陈锁回收后旧 holder 释放曾误删新 holder 的锁
        // （A>5s→B 回收接管→A 释放删 B 锁→C 闯入）——释放只删**自己的**锁
        const myToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let fh: Awaited<ReturnType<typeof open>> | null = null;
        for (let attempt = 0; attempt < 50; attempt++) {
            try {
                fh = await open(lock, "wx");
                await fh.write(myToken);
                break;
            } catch (e) {
                if ((e as { code?: string }).code !== "EEXIST") throw e;
                try {
                    const st = await stat(lock);
                    if (Date.now() - st.mtimeMs > 5_000) await unlink(lock).catch(() => undefined);
                } catch { /* 锁文件刚好消失 */ }
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        if (!fh) throw new Error(`LayerEnvStore 写锁超时: ${lock}`);
        const held = fh;
        return Object.assign(
            async () => { await held.close().catch(() => undefined); },
            {
                /** 写前复核：锁文件 token 仍是自己的（被陈锁回收即 false） */
                async verifyHeld(): Promise<boolean> {
                    try {
                        const cur = await readFile(lock, "utf-8");
                        return cur.trim() === myToken;
                    } catch {
                        return false;
                    }
                },
                /** 收尾：关句柄 + 只删自己的锁（nonce 比对） */
                async finalize(): Promise<void> {
                    await held.close().catch(() => undefined);
                    try {
                        const cur = await readFile(lock, "utf-8");
                        if (cur.trim() === myToken) await unlink(lock);
                    } catch { /* 已被回收/删除 */ }
                },
            },
        );
    }

    /** 写入/更新一层规格；漂移检测：指纹不一致标 stale 不自动覆盖（显式 force 才覆写）。
     *  **跨实例锁包裹整个读-改-写**（Sol 54 P2-9）：writeChain 只串行化本实例——
     *  两实例并发 upsert 曾各自 load 后 save，后写覆盖前写丢 key。 */
    async upsert(key: string, entry: LayerEnvEntry, force = false): Promise<{ stale: boolean }> {
        const run = this.writeChain.then(async () => {
            // 锁属复核重试环（Sol 56 P2-2）：暂停的旧 holder 曾在陈锁回收+新 holder
            // 写完后恢复——saveLocked 无锁属检查直接覆盖新数据。写前复核锁 token
            // 仍是自己的；被回收（token 不匹配）则重试整轮（重新拿锁+重读+重合并）
            for (let round = 0; round < 3; round++) {
                const release = await this.acquireLock();
                try {
                    const cfg = await this.load();
                    const existing = cfg.layers[key];
                    if (existing && !force && existing.fingerprint !== entry.fingerprint) {
                        return { stale: true } as const; // 环境可能已漂移——不覆盖，供重探决策
                    }
                    cfg.layers[key] = entry;
                    await this.saveLocked(cfg);
                    // 写后复核（Sol 57 P2-1）：verify→write 间隙锁被回收+新 holder 写入
                    // 后，旧 holder 的写曾覆盖新数据（beta 被 alpha 盖）。写后 verify 失败
                    // 即整轮重试：重新拿锁+**重读盘上最新**（新 holder 的 key 保留）+
                    // 重合并自己 key——最终态两方 key 都在，后写 key 后赢（单 key 冲突
                    // = last-writer-wins 可接受）
                    if (await release.verifyHeld()) {
                        return { stale: false } as const;
                    }
                    // 锁被回收——本轮放弃，loop 重新拿锁重读（新 holder 的写入经重读保留）
                } finally {
                    await release.finalize();
                }
            }
            throw new Error(`LayerEnvStore upsert 锁属复核三轮失败（持续被回收）: ${key}`);
        });
        this.writeChain = run.catch(() => undefined); // 失败不堵后续写
        return run;
    }
}

/** 连接投影（descriptor → LayerConnectionInfo；重进路径含 hops） */
export function projectConnection(desc: RuntimeDescriptor): LayerConnectionInfo {
    const c = (desc.config ?? {}) as Record<string, unknown>;
    const hops: SshHopLite[] = Array.isArray(c.sshHops)
        ? (c.sshHops as SshHopLite[]).map((h) => (typeof h === "string" ? { host: h } : h))
        : [];
    return {
        driver: desc.driver,
        target: desc.target,
        conn: c.connParams as SshConnParams | undefined,
        hops: hops.length ? hops : undefined,
        enters: enterStepsOf(c).map((s) => ({ cmd: s.cmd, label: s.label })),
        launch_cmd: typeof c.launchCmd === "string" ? c.launchCmd : undefined,
    };
}

/** 指纹：连接投影 + 环境快照 hash */
export function layerFingerprint(conn: LayerConnectionInfo, spec: LayerEnvironmentSpec): string {
    return "sha256:" + createHash("sha256")
        .update(JSON.stringify({ conn: { driver: conn.driver, target: conn.target, enters: conn.enters }, spec }))
        .digest("hex").slice(0, 24);
}

// ════════════════ 匹配（needs → 层键命中） ════════════════

export interface LayerMatchResult {
    key: string;
    entry: LayerEnvEntry;
}

/**
 * 按需求匹配层：needs 形如 "gpu" / "torch"（包名） / "python>=3.12"（版本比较）。
 * 全部 need 命中才入选；结果不排序（调用方按需排）。
 */
export function matchLayers(cfg: LayerEnvConfigFile, needs: string[]): LayerMatchResult[] {
    const out: LayerMatchResult[] = [];
    for (const [key, entry] of Object.entries(cfg.layers)) {
        const spec = entry.environment;
        const ok = needs.every((need) => {
            if (need.length > 128) return false;
            const vm = need.match(/^([a-zA-Z][a-zA-Z0-9_-]*)(?:(>=|<=|>|<|=)\s*(\d+(?:\.\d+)*))?$/);
            if (!vm) return false;
            const name = vm[1]!.toLowerCase();
            const op = vm[2];
            const want = vm[3];
            if (name === "gpu") return spec.gpu != null;
            if (name === "docker") return spec.docker === true;
            if (name === "cuda") return spec.cuda != null;
            if (name === "python" || name === "node" || name === "bun" || name === "java") {
                const have = spec[name];
                if (!have) return false;
                if (!op || !want) return true;
                return compareVersion(extractVersion(have) ?? "0", want, op);
            }
            // 包名匹配（matchNames 别名 + @ 版本）
            const pkg = (spec.packages ?? []).find((p) => {
                const base = p.split("@")[0]!;
                const def = PROBE_PACKAGES.find((d) => base === d.key || d.matchNames.includes(base));
                return base === name || def?.matchNames.includes(name);
            });
            if (!pkg) return false;
            if (!op || !want) return true;
            return compareVersion(pkg.split("@")[1] ?? "0", want, op);
        });
        if (ok) out.push({ key, entry });
    }
    return out;
}

function compareVersion(a: string, b: string, op: string): boolean {
    const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
    const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) {
            if (op === ">=") return d > 0;
            if (op === "<=") return d < 0;
            if (op === ">") return d > 0;
            if (op === "<") return d < 0;
            return false;
        }
    }
    return op === ">=" || op === "<=" || op === "="; // 相等
}
