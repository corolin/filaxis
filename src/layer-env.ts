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
import { basename, dirname, join } from "node:path";
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

// ════════════════ 持久化（JSON + link-CAS 落位 + mtime 缓存） ════════════════

/** 旁路文件后缀：<path>.<uniq>.fx-old（link 舞步的移开态/中止残留——load 并入恢复） */
const ASIDE_SUFFIX = ".fx-old";

/** 层条目并入（dst 被 src 覆盖同键——后并入者新） */
function mergeLayers(dst: LayerEnvConfigFile, src: unknown): void {
    const layers = (src as LayerEnvConfigFile | null)?.layers;
    if (!layers || typeof layers !== "object") return;
    // 无效条目跳过（Sol 74 P1-3 → Sol 76 P1-2）：null/非对象/数组/**缺必填
    // connection 的空对象**——曾原样并入随压实写进主档
    for (const [k, v] of Object.entries(layers)) {
        if (v != null && typeof v === "object" && !Array.isArray(v)
            && typeof v.connection === "object" && v.connection != null
            && typeof (v as { connection: { driver?: unknown } }).connection.driver === "string") {
            dst.layers[k] = v as LayerEnvEntry;
        }
    }
}

/** 盘面档位（Sol 62 P2-4 序戳 + Sol 66 #3 血统 → Sol 67 集合血统）：rev=文档
 *  内嵌 _fx_rev（提交时刻），seen=写入时盘面全部 rev 的集合（作者确切见过的
 *  状态——集合成员判定免疫时钟回拨；上界 base 保留作旧档回落）。坏档
 *  parsed=null（mergeLayers 自验证跳过） */
interface FxDoc {
    mtimeMs: number;
    aside: boolean;
    rev: string | null;
    base: string | null;
    seen: string[] | null;
    parsed: unknown;
}

function makeDoc(mtimeMs: number, aside: boolean, text: string): FxDoc {
    try {
        const d = JSON.parse(text) as { _fx_rev?: unknown; _fx_base?: unknown; _fx_seen?: unknown };
        return {
            mtimeMs,
            aside,
            rev: typeof d._fx_rev === "string" ? d._fx_rev : null,
            base: typeof d._fx_base === "string" ? d._fx_base : null,
            seen: Array.isArray(d._fx_seen) ? d._fx_seen.filter((x): x is string => typeof x === "string") : null,
            parsed: d,
        };
    } catch {
        return { mtimeMs, aside, rev: null, base: null, seen: null, parsed: null };
    }
}

export class LayerEnvStore {
    /** 写链串行（自挖 S2：load-modify-save 无锁——并发 upsert 后者以旧 cfg 覆盖
     *  前者写入，丢更新；实例级 promise 链保证读-改-写原子序） */
    private writeChain: Promise<unknown> = Promise.resolve();
    /** 本实例当前持锁深度（acquireLock++/finalize--）——load 的压实须跳过
     *  自己持锁的窗口（锁内再抢锁=自旋等自己的锁） */
    private selfLockDepth = 0;

    constructor(public readonly path: string) {}

    /** 列旁路文件（mtime 升序——线性历史态，旧→新逐个并入；mtime 是被移开文件
     *  的原写时间非移开时间，清理阈值按此保守理解）。
     *  归属按 uniq 形态全匹配（Sol 63 P1-1）：前后缀判定曾把同目录他档
     *  （env.json.other.<uniq>.fx-old）误认自家旁路——合并错档+舞步收尾连删
     *  他档恢复锚。剥前缀后必须恰为 <pid>-<ms>-<rand> 形态才算自己的。
     *  大小写随平台（Sol 66 #4）：Windows/macOS 文件系统大小写不敏感——
     *  case.json 移开旁路后 CASE.JSON 实例曾认不到自己的恢复锚（前缀匹配
     *  大小写敏感）。此类平台前缀与 uniq 段按小写比对（返回路径仍用盘面实名） */
    private async listAsides(): Promise<Array<{ p: string; mtimeMs: number }>> {
        try {
            const { readdir } = await import("node:fs/promises");
            const dir = dirname(this.path);
            const ci = process.platform === "win32" || process.platform === "darwin";
            const pre = `${basename(this.path)}.`;
            const preCmp = ci ? pre.toLowerCase() : pre;
            const uniqTail = new RegExp(`^\\d+-\\d+-[a-z0-9]{1,12}\\${ASIDE_SUFFIX}$`);
            const out: Array<{ p: string; mtimeMs: number }> = [];
            for (const n of await readdir(dir)) {
                const nCmp = ci ? n.toLowerCase() : n;
                if (!nCmp.startsWith(preCmp)) continue;
                if (!uniqTail.test(nCmp.slice(preCmp.length))) continue;
                const p = join(dir, n); // 盘面实名（大小写不敏感平台按实名开档最稳）
                try { out.push({ p, mtimeMs: (await stat(p)).mtimeMs }); } catch { /* 竞态消失 */ }
            }
            return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
        } catch {
            return [];
        }
    }

    async load(_force = false): Promise<LayerEnvConfigFile> {
        // 旁路恢复（Sol 59 P2-1 link 舞步）：移开态/中止残留并入读取——data 缺席
        // 时旁路是唯一状态源（崩溃于移开与落位之间）。
        // mtime 缓存已退役（Sol 64 #4）：同刻写入下缓存失明（A 预热+B 同刻保存
        // →A 的 load 仍旧值）——env 档案小、读取廉，正确性优先于省一次读
        const { docs, asides, hasData } = await this.collectDocs();
        if (!hasData && docs.length === 0) return { layers: {} };
        const cfg = LayerEnvStore.mergeDocs(docs);
        // 老化旁路压实（Sol 60 P2-3）：先持久后清理——只删不写曾使恢复出的条目
        // 读一次即蒸发。锁内重读再写（本快照可能落后他方新提交）。data 缺席时
        // 旁路是唯一状态源不清（等下次成功提交带出 data 再压）
        const aged = hasData ? asides.filter((a) => Date.now() - a.mtimeMs > 600_000) : [];
        if (aged.length > 0 && this.selfLockDepth === 0) {
            try {
                await this.compact(aged);
            } catch { /* 锁竞争等——留待下次 load */ }
            return LayerEnvStore.snapshot(cfg);
        }
        return LayerEnvStore.snapshot(cfg);
    }

    /** 并入（Sol 64 门控 → Sol 66/67 血统 → Sol 68 锚点 → Sol 69 传递闭包）：
     *  血统集合 _fx_seen 成员判定——见过=知悉后删除、没见过=踩踏残留（救回，
     *  免疫时钟回拨）。**锚点**：主档在场用它；缺席取「无人见过者」（其 rev 不
     *  出现在任何档的 seen=因果最新——seen 收录链传递：A∈B.seen、B∈C.seen ⇒
     *  C 最新，回拨下墙钟序会说谎、收录关系不会）。**血统按传递闭包**判定：
     *  锚点经 seen 链继承对更早各代的知悉（C 直接只记 B，但 B 见过 A ⇒ C 对
     *  A 的删除同样成立）。并发多锚（互相没见过）退回 docOrder 末位；无戳锚点
     *  保持全并入+docOrder（恢复偏置）。救回的旁路在锚点之后并入 */
    private static mergeDocs(allDocs: FxDoc[]): LayerEnvConfigFile {
        // 无效档全流程惰化（Sol 71 P1 → Sol 72 P1 → Sol 73 P1）：截断 JSON、
        // `[]`、`{"layers":[]}`（数组层表）都视同坏档——不作锚、不参与统摄
        // 竞选与辈分门控（缺 layers 的带版本旁路曾压过有效旁路返回空配置），
        // 锚点落统摄旁路（回拨下旧 A 不再覆盖见过它的 B）
        const docs = allDocs.filter((d) => LayerEnvStore.docHasLayers(d));
        const dataDoc = docs.find((d) => !d.aside);
        let anchor: FxDoc | null = dataDoc ?? null;
        if (!anchor) {
            const stamped = docs.filter((d) => d.rev != null);
            if (stamped.length > 0) {
                // 无人见过者（被任何档 seen 收录的都不是最新）——传递成立：中间代
                // 必被其后代收录（A∈B、B∈C ⇒ A 被 B 见过）✓
                const unseen = stamped.filter(
                    (cand) => !stamped.some((x) => x !== cand && (x.seen?.includes(cand.rev!) ?? false)));
                const pool = unseen.length > 0 ? unseen : stamped; // 并发互未见/环——墙钟兜底
                const sorted = [...pool].sort(LayerEnvStore.docOrder);
                anchor = sorted[sorted.length - 1]!;
            }
        }
        const cfg: LayerEnvConfigFile = { layers: {} };
        if (anchor?.rev) {
            const anchorRev = anchor.rev; // 闭包内窄化保留
            const anchorBase = anchor.base;
            // 锚点有效 seen = 自身 ∪ seen 链上各代的并（传递闭包——Sol 69 #2）
            const seen = LayerEnvStore.seenClosure(anchor, docs);
            const kept = docs.filter((d) => {
                if (d === anchor) return false;
                if (!d.rev) return false; // 带戳锚点+无戳旁路：作者 load 过全盘（Sol 65 #5）
                // 集合血统（Sol 67 #2）：见过（含传递）=删/没见过=救——先于戳序
                //（回拨下已见旧档的戳可 numeric 上大于锚点戳）
                if (seen) return !seen.has(d.rev);
                if (d.rev > anchorRev) return true; // 新于锚点=踩踏恢复（无集合回落）
                if (anchorBase != null) return d.rev > anchorBase; // 旧档回落：超上界=没见过
                return true; // 无血统=首写见空盘——全救（Sol 67 #1）
            });
            // kept 内部辈分门控（Sol 70 #2）：被另一 kept 档**见过**（∈其闭包）=
            // 后继作者已知悉并做出取舍（含删除）——整档由后继承继，不再并入
            //（主档在场时曾只按墙钟序合并 kept——回拨下后继戳反小，旧值覆盖
            // 新值+已删条目复活）。后继闭包经 seen 链传递覆盖全部前代
            const keptMeta = kept.map((d) => ({ d, closure: LayerEnvStore.seenClosure(d, docs) }));
            const heirs = keptMeta.filter(({ d }) =>
                !keptMeta.some(({ d: k, closure: kc }) => k !== d && (kc?.has(d.rev!) ?? false)));
            heirs.sort((a, b) => (a.closure?.size ?? 0) - (b.closure?.size ?? 0) || LayerEnvStore.docOrder(a.d, b.d));
            mergeLayers(cfg, anchor.parsed); // 锚点先并入
            for (const { d } of heirs) mergeLayers(cfg, d.parsed); // 救回的旁路随后覆盖其键（辈分深者后并入）
            // 无效提名透传回救（Sol 77 P1-3b）：锚点/heirs 中被提名为**无效条目**
            //（null/数组/空 connection）的键≠删除（删除=未提名，Sol 64 语义）——
            // 键位状态不明，向被血统跳过的各代回溯取最新有效值（曾整档跳过致
            // 前代有效条目永久丢失并压实删除旁路）
            {
                const mentionedInvalid = new Set<string>();
                const layerEntries = (src: unknown): Record<string, unknown> =>
                    ((src as LayerEnvConfigFile | null)?.layers ?? {}) as Record<string, unknown>;
                const invalidEntry = (v: unknown): boolean =>
                    !(v != null && typeof v === "object" && !Array.isArray(v)
                        && typeof (v as LayerEnvEntry).connection === "object" && (v as LayerEnvEntry).connection != null
                        && typeof (v as { connection: { driver?: unknown } }).connection.driver === "string");
                for (const src of [anchor.parsed, ...heirs.map(({ d }) => d.parsed)]) {
                    for (const [k, v] of Object.entries(layerEntries(src))) {
                        if (invalidEntry(v) && cfg.layers[k] == null) mentionedInvalid.add(k);
                    }
                }
                if (mentionedInvalid.size > 0) {
                    // 回救序按**因果**（Sol 78 P1-3）：闭包深度（seen 链长度）定新旧
                    // ——墙钟序戳在回拨下会倒挂（后代戳反小，曾把旧值写回主档）；
                    // 并列以 docOrder 兜底
                    const skipped = docs
                        .filter((d) => d !== anchor && !heirs.some(({ d: h }) => h === d) && d.parsed != null)
                        .map((d) => ({ d, depth: LayerEnvStore.seenClosure(d, docs)?.size ?? 0 }))
                        .sort((a, b) => b.depth - a.depth || LayerEnvStore.docOrder(b.d, a.d)); // 深（新）优先
                    // byRev 快查（删除判定的 seen 溯源用）
                    const byRev = new Map(docs.filter((d) => d.rev).map((d) => [d.rev!, d]));
                    for (const { d } of skipped) {
                        let changed = false;
                        for (const k of [...mentionedInvalid]) {
                            const v = layerEntries(d.parsed)[k];
                            if (v !== undefined) {
                                if (!invalidEntry(v)) {
                                    cfg.layers[k] = v as LayerEnvEntry;
                                    mentionedInvalid.delete(k);
                                    changed = true;
                                }
                                // 无效提名（null/空壳）：状态不明——继续向更早回溯
                                continue;
                            }
                            // 未提名删除界（Sol 79 P1-2）：本档**没提**该键——若它见过的
                            // 各代里有人有效持有该键，此未提名=明知而删（Sol 64 语义），
                            // 回救不得越界向更早取值（曾越过中间删除档复活旧值）
                            const closure = LayerEnvStore.seenClosure(d, docs);
                            const sawValid = closure != null && [...closure].some((r) => {
                                const sd = byRev.get(r);
                                const sv = sd ? layerEntries(sd.parsed)[k] : undefined;
                                return sv !== undefined && !invalidEntry(sv);
                            });
                            if (sawValid) mentionedInvalid.delete(k); // 删除成立——停止回救（保持缺席）
                            changed = true;
                        }
                        if (mentionedInvalid.size === 0) break;
                        void changed;
                    }
                }
            }
            return cfg;
        }
        // 无戳锚点（遗老/手造）或无档：全并入按 docOrder（平局 data 胜）
        const ordered = [...docs];
        ordered.sort(LayerEnvStore.docOrder);
        for (const d of ordered) mergeLayers(cfg, d.parsed);
        return cfg;
    }

    /** 档位有效性（Sol 72 P1）：layers 为对象才算可作主档——`[]` 类合法 JSON
     *  无 layers 结构，与截断 JSON 同罪（视同坏档不作锚） */
    private static docHasLayers(d: FxDoc): boolean {
        const layers = (d.parsed as LayerEnvConfigFile | null | undefined)?.layers;
        if (layers == null || typeof layers !== "object" || Array.isArray(layers)) return false;
        // 全无效条目（非空却无一有效）=无效档（Sol 74 P1-3 → Sol 75 P1-2 →
        // Sol 76 P1-2）：null/数组/**缺必填字段的空对象**（`{"one":{}}`）条目都曾以
        // 有效档身份压过可恢复前代。有效条目须含对象 connection（LayerEnvEntry
        // 最小必填）。注意空对象 `{}` 是整档替换的合法清空态（store 自写），
        // 不在废档之列；混入无效条目的档有效，无效条目由 mergeLayers 跳过
        const validEntry = (v: unknown): boolean =>
            v != null && typeof v === "object" && !Array.isArray(v)
            && typeof (v as LayerEnvEntry).connection === "object" && (v as LayerEnvEntry).connection != null
            && typeof (v as { connection: { driver?: unknown } }).connection.driver === "string"; // 必填 driver（Sol 77 P1-3）：{"connection":{}} 曾压过前代
        const vals = Object.values(layers);
        return vals.length === 0 || vals.some(validEntry);
    }

    /** seen 传递闭包：锚点的有效知悉=自身 seen ∪ 各被收录档的 seen（链式回收） */
    private static seenClosure(anchor: FxDoc, docs: FxDoc[]): Set<string> | null {
        if (!anchor.seen) return null;
        const byRev = new Map<string, FxDoc>();
        for (const d of docs) if (d.rev) byRev.set(d.rev, d);
        const out = new Set<string>(anchor.seen);
        const visited = new Set<string>(); // 走查去重按**档**（rev）——out 预置
        // anchor.seen 后按 rev 查重曾把首层递归整个短路（首层 r 必已在 out）
        const walk = (d: FxDoc): void => {
            if (d.rev && visited.has(d.rev)) return;
            if (d.rev) visited.add(d.rev);
            for (const r of d.seen ?? []) {
                out.add(r);
                const next = byRev.get(r);
                if (next) walk(next);
            }
        };
        walk(anchor);
        return out;
    }

    /** 深副本（Sol 62 P2-1）：浅副本曾漏嵌套——改 environment.os 就地污染缓存
     *  条目并随后续 upsert 落盘。条目为 JSON 纯数据，structuredClone 深隔离 */
    private static snapshot(cfg: LayerEnvConfigFile): LayerEnvConfigFile {
        const layers: Record<string, LayerEnvEntry> = {};
        for (const [k, v] of Object.entries(cfg.layers)) layers[k] = structuredClone(v);
        return { layers };
    }

    /** 档位排序（Sol 60 P1 → Sol 62 P2-4）：内嵌序戳 _fx_rev（提交时刻 ms-pid-nonce）
     *  优先——真提交新旧的可靠序：穿透序（A 陈 data vs B 新旁路）与崩溃清理前序
     *  （新 data vs 旧旁路）双解，mtime 同刻平局不再靠猜。无戳（手造/遗老档）
     *  回落 mtime；双无戳同刻=结构上不可判定，选护已落位提交（data 胜） */
    private static docOrder(x: FxDoc, y: FxDoc): number {
        const kx = x.rev ? parseInt(x.rev, 10) : x.mtimeMs;
        const ky = y.rev ? parseInt(y.rev, 10) : y.mtimeMs;
        if (kx !== ky) return kx - ky;
        if (x.rev && y.rev) return x.rev < y.rev ? -1 : x.rev > y.rev ? 1 : 0;
        if (x.rev) return 1; // 同刻：带戳后入（胜）——新协议档
        if (y.rev) return -1;
        return (y.aside ? 1 : 0) - (x.aside ? 1 : 0); // 双无戳同刻：data 后入（胜）
    }

    /** 档位收集：stat 先于列旁路（Sol 62 P2-3）——stat 失败=现行态在 stat 前已被
     *  移开→rename 已落地→随后的列旁路必见移开态；stat 成功而读失败=stat 与读
     *  之间被移开→重列旁路捞回。两个舞步窗口都不再读成空档 */
    private async collectDocs(): Promise<{
        docs: FxDoc[];
        asides: Array<{ p: string; mtimeMs: number }>;
        dataMtimeMs: number;
        hasData: boolean;
    }> {
        let dataMtimeMs = 0;
        let hasData = false;
        try {
            dataMtimeMs = (await stat(this.path)).mtimeMs;
            hasData = true;
        } catch { /* 缺席——旁路承载 */ }
        const asides = await this.listAsides();
        const docs: FxDoc[] = [];
        for (const a of asides) {
            try { docs.push(makeDoc(a.mtimeMs, true, await readFile(a.p, "utf-8"))); } catch { /* 竞态消失 */ }
        }
        if (hasData) {
            try {
                docs.push(makeDoc(dataMtimeMs, false, await readFile(this.path, "utf-8")));
            } catch {
                // stat 与读之间现行态被移开——重列旁路（rename 先于读失败，必见）；
                // 主档也重读（Sol 63 P2-3）：完整提交可能已跨过我们的读
                //（move→link→清旁路全毕）——只重扫旁路曾读成空档
                const known = new Set(asides.map((x) => x.p));
                for (const a of await this.listAsides()) {
                    if (known.has(a.p)) continue;
                    try { docs.push(makeDoc(a.mtimeMs, true, await readFile(a.p, "utf-8"))); } catch { /* 竞态消失 */ }
                }
                try {
                    docs.push(makeDoc((await stat(this.path)).mtimeMs, false, await readFile(this.path, "utf-8")));
                } catch { /* 仍缺席——旁路已并入 */ }
            }
        }
        if (!hasData) {
            // 主档重探（Sol 64 #1 → Sol 65 #4）：读取自「主档已移开」起步（stat 即
            // 失败）后，写入方可能在任何时刻归位新档——不论旁路扫描是否已捞到旧
            // 态（曾只在零旁路时重探：捞到旧旁路+新档落位→返回旧值）。缺席即重探
            try {
                const st = await stat(this.path);
                docs.push(makeDoc(st.mtimeMs, false, await readFile(this.path, "utf-8")));
                dataMtimeMs = st.mtimeMs;
                hasData = true;
            } catch { /* 确无档 */ }
        }
        return { docs, asides, dataMtimeMs, hasData };
    }

    /** 压实：锁内重读合并态 → 舞步落位（成功即自消其旁路）→ 清 aged。
     *  读路径 best-effort——任何失败留待下次 load 重试 */
    private async compact(aged: Array<{ p: string; mtimeMs: number }>): Promise<void> {
        const release = await this.acquireLock();
        try {
            const fresh = await this.readMergedRaw();
            await this.saveLocked(fresh, () => release.verifyHeld());
            const { unlink } = await import("node:fs/promises");
            for (const a of aged) await unlink(a.p).catch(() => undefined);
        } finally {
            await release.finalize();
        }
    }

    /** 盘面全量读（旁路+data 按序戳/mtime 排序并+新旧门控——load 的纯读核） */
    private async readMergedRaw(): Promise<LayerEnvConfigFile> {
        const { docs } = await this.collectDocs();
        return LayerEnvStore.mergeDocs(docs);
    }

    /** 原子写（公共）：抢跨实例文件锁后走 saveLocked（含锁属复核——Sol 59 P2-1：
     *  此前未传复核，公开 save() 是无保护覆盖通道） */
    async save(cfg: LayerEnvConfigFile): Promise<void> {
        const release = await this.acquireLock();
        try {
            await this.saveLocked(cfg, () => release.verifyHeld());
        } catch (e) {
            if (e instanceof Error && e.message === "__FX_LOCK_LOST__") {
                // save 是整档快照语义（不自动合并重试——重放会盖掉并发写入方的键）：
                // 报冲突交调用方 load() 重读合并后重写
                throw new Error(`LayerEnvStore.save 并发冲突（写入期间锁被回收——盘上是他方新档或本轮已落位）。请 load() 重读、合并你的键后重写: ${this.path}`);
            }
            throw e;
        } finally {
            await release.finalize();
        }
    }

    /** 无锁写（调用方持锁）：tmp + link-CAS 舞步落位。
     *  link-CAS（Sol 59 P2-1）：rename 是「无条件替换」——上轮把锁属复核内联到
     *  rename 紧前只收窄到 syscall 间隙，复核回调内可暂停的窗口仍会被陈锁回收
     *  穿透（A 复核过→暂停→B 回收接管提交→A 恢复 rename 直接盖掉——两个
     *  upsert 都报成功，B 的键蒸发）。link 是「不存在才落位」：EEXIST = 落位
     *  点已有他人提交的铁证——中止且不动盘上数据。舞步：先把现行态移开
     *  （rename→旁路）空出落位点，再 link；崩溃/中止时旁路残留由 load 并入
     *  恢复（自愈）。落位后二次锁属复核兜底「暂停跨越整个舞步」的持有权早失 */
    private async saveLocked(
        cfg: LayerEnvConfigFile,
        verifyHeld?: () => Promise<boolean>,
    ): Promise<void> {
        const { link, unlink } = await import("node:fs/promises");
        await mkdir(dirname(this.path), { recursive: true });
        const uniq = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const tmp = `${this.path}.${uniq}.tmp`;
        const aside = `${this.path}.${uniq}${ASIDE_SUFFIX}`;
        // 舞步开场旁路快照（Sol 61 P2-2）：成功收尾时一并消费——上轮只消自己的
        // 旁路，崩溃遗留的历史旁路仍会把整档替换已删的层复活
        const preAsides = (await this.listAsides()).map((a) => a.p);
        // 血统快照（Sol 66 #3 → Sol 67 集合化）：锁内盘面全部 rev=本轮作者「确切
        // 见过」的状态集——集合成员判定免疫时钟回拨（上界 base 在首写见空盘与
        // 旁路戳超上界两端都误判）。写入 _fx_seen（_fx_base 保留作旧档回落）
        const diskDocs = (await this.collectDocs()).docs;
        const seenRevs = diskDocs.map((d) => d.rev).filter((r): r is string => r != null);
        const baseRev = seenRevs.reduce<string | null>((m, r) => (!m || r > m ? r : m), null);
        // 内嵌序戳（Sol 62 P2-4）：文档自带提交时刻——rename/link 迁移不损，
        // 同刻 mtime 平局由戳裁决（mergeLayers 只读 layers，戳不外泄）。
        // payloadText 单源（Sol 63 P2-4）：落位后锁失的还原比对须与写入逐字节同串
        const rev = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        const payloadText = JSON.stringify(
            seenRevs.length > 0
                ? { ...cfg, _fx_rev: rev, _fx_base: baseRev, _fx_seen: seenRevs }
                : { ...cfg, _fx_rev: rev },
            null, 2);
        await writeFile(tmp, payloadText, "utf-8");
        if (verifyHeld && !(await verifyHeld())) {
            await unlink(tmp).catch(() => undefined);
            throw new Error("__FX_LOCK_LOST__"); // 哨兵：落位未尝试，盘上数据未动
        }
        try {
            await rename(this.path, aside);
        } catch (e) {
            if ((e as { code?: string }).code !== "ENOENT") {
                await unlink(tmp).catch(() => undefined); // 移开失败：tmp 不留残
                throw e;
            } // 缺席容忍（首次写）
        }
        try {
            await link(tmp, this.path);
        } catch (e) {
            await unlink(tmp).catch(() => undefined);
            if ((e as { code?: string }).code === "EEXIST") {
                throw new Error("__FX_LOCK_LOST__"); // 并发已提交铁证——移开态留旁路，load 并入恢复
            }
            throw e;
        }
        await unlink(tmp).catch(() => undefined);
        // 落位后锁属复核：EEXIST 未触发只证明落位瞬间无并发提交——暂停窗口跨越
        // 整个舞步时持有权早失。还原优先（Sol 63 P2-4）：盘上仍是本舞步产物
        //（无人再动过）时把移开态搬回主位——陈值不留主位；时钟回拨/同刻下
        // 序戳不可靠，物理还原是活检测路径上最诚实的序。盘面已变则留给合并序。
        // 首次写无移开态可还原（Sol 64 #2）：搬回失败即撤下自己的产物——
        // 报冲突的写入不留盘（盘面回到无档原态）
        if (verifyHeld && !(await verifyHeld())) {
            try {
                const cur = await readFile(this.path, "utf-8");
                if (cur === payloadText) {
                    const moved = await rename(aside, this.path).then(() => true, () => false);
                    if (!moved) await unlink(this.path).catch(() => undefined);
                    await unlink(aside).catch(() => undefined); // rename 未遂时兜底（aside 可能已被收）
                }
            } catch { /* 盘面已变——旁路留恢复锚 */}
            throw new Error("__FX_LOCK_LOST__");
        }
        // 成功收尾：消费自己移开的旁路 + 舞步开场在场的历史旁路（Sol 60 P2-2 +
        // Sol 61 P2-2）——保留它们会让整档替换已删的层经恢复协议复活。post-check
        // 通过=本舞步持锁期间无他方提交：upsert 的 cfg 基线（锁内 load）⊇ 旁路
        // 内容；save 的整档替换语义本就覆盖删除。中止/崩溃路径不消费——旁路是
        // 恢复锚
        await unlink(aside).catch(() => undefined);
        for (const p of preAsides) await unlink(p).catch(() => undefined);
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
        const store = this; // 对象字面量方法内 this 不指 store——闭包捕获
        store.selfLockDepth++;
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
                    store.selfLockDepth = Math.max(0, store.selfLockDepth - 1);

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
                    // 锁内强制重读（Sol 63 P1-2）：mtime 缓存在同刻写入下失明——
                    // A 缓存{a}+B 同刻写 b 后，A 持锁 upsert 曾从旧缓存取基线写
                    // {a,c}，b 蒸发。写者不信缓存，锁内永远读盘面新鲜态
                    const cfg = await this.load(true);
                    const existing = cfg.layers[key];
                    if (existing && !force && existing.fingerprint !== entry.fingerprint) {
                        return { stale: true } as const; // 环境可能已漂移——不覆盖，供重探决策
                    }
                    cfg.layers[key] = entry;
                    try {
                        // rename 紧前复核（Sol 58 P2-1）：失败时 rename 未发生，盘上
                        // 新 holder 数据完好——本轮放弃，loop 重新拿锁+重读+重合并
                        await this.saveLocked(cfg, () => release.verifyHeld());
                        return { stale: false } as const;
                    } catch (e) {
                        if (e instanceof Error && e.message === "__FX_LOCK_LOST__") continue; // 重试
                        throw e;
                    }
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
