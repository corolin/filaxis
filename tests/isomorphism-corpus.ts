/**
 * isomorphism-corpus.ts — 中层操作的同构用例语料（REQ-0004 §9 M6、AC-03）
 *
 * 同构 = 同一组操作、同样的参数，在哪种宿主上执行结果都一样。所以语料里没有「标准
 * 答案」：只有一条条「调哪个操作、传什么参数」，由各宿主各自执行后互相比。
 *
 * 与语言无关：语料是纯数据（操作名 + JSON 参数），不调用任何 TypeScript 函数。将来的
 * Rust 内核、别的语言的薄入口，拿同一份语料跑一遍、和这里的三个宿主比即可。
 *
 * 参数里的三个记号（由执行器在运行时替换）：
 *   "$tmp/<相对路径>"   本次运行在调用方本机的临时目录下的路径（结果里统一归一成 <TMP>）
 *   "$ref:<名字>.<字段>" 前面某一步 save 下来的结果里的字段
 *   "$=<字面量>"        以 $ 开头又不是记号的字面量
 */
import type { MiddleOps } from "../src/middle/types.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface IsoStep {
    op: keyof MiddleOps;
    params: Json;
    /** 把这一步的结果存下来，供后面 $ref 引用 */
    save?: string;
}

export interface IsoCase {
    name: string;
    /** 用例开始前在临时目录里放好的文件（相对路径 → 内容） */
    files?: Record<string, string>;
    steps: IsoStep[];
    /** 缺省 20000 */
    timeoutMs?: number;
}

/** 所有宿主共用的已存层表（相对路径以 $tmp/ 为基）：三个本机层，各有自己的工作目录 */
export const ISO_LAYER_STORE: Record<string, Json> = {
    "iso-a": { driver: "local", cwd: "$tmp/a" },
    "iso-b": { driver: "local", cwd: "$tmp/b" },
    "iso-other": { driver: "local", cwd: "$tmp/c" },
};

const L = "layer";
const run = (command: string, layer?: string): IsoStep => ({ op: "runCommand", params: { command, ...(layer ? { layer } : {}) } });

export const ISO_CASES: IsoCase[] = [
    // ── runCommand ──
    {
        name: "runCommand：stdout / stderr / 退出码 / 执行用户",
        steps: [{ op: "runCommand", params: { command: "printf 'out-1'; printf 'err-1' >&2; exit 7" } }],
    },
    {
        name: "runCommand：非零退出码是数据不是异常，两路输出分列",
        steps: [run("printf 'a\\nb\\n'; printf 'x\\ny\\n' >&2")],
    },
    {
        name: "runCommand：已存层按名寻址，命令落在层自己的工作目录",
        files: { "a/marker.txt": "in-a", "b/marker.txt": "in-b" },
        steps: [run("pwd; cat marker.txt", "iso-a"), run("pwd; cat marker.txt", "iso-b")],
    },
    {
        name: "runCommand：层引用的对象写法与字符串写法等价",
        files: { "a/marker.txt": "in-a" },
        steps: [
            run("cat marker.txt", "iso-a"),
            { op: "runCommand", params: { layer: { [L]: "iso-a" }, command: "cat marker.txt" } },
        ],
    },
    {
        name: "runCommand：空的层名被拒绝，不落到默认层",
        steps: [{ op: "runCommand", params: { [L]: "  ", command: "echo should-not-run" } }],
    },
    {
        name: "runCommand：没写目标就是本机，命令工作目录由调用方指定",
        files: { "cwd-marker.txt": "caller-cwd" },
        steps: [
            { op: "runCommand", params: { command: "cat cwd-marker.txt", cwd: "$tmp/" } },
            { op: "runCommand", params: { layer: { descriptor: { driver: "local" } }, command: "printf 'explicit-local'" } },
        ],
    },
    {
        name: "runCommand：超时不是完成——结果未知，不伪造退出码",
        steps: [{ op: "runCommand", params: { command: "sleep 20", timeoutMs: 500 } }],
    },

    // ── 文件 ──
    {
        name: "writeFile → readFile → editFile → readPath → managePath",
        steps: [
            { op: "writeFile", params: { path: "$tmp/w/hello.txt", content: "hello old world\n", createDirs: true } },
            { op: "readFile", params: { path: "$tmp/w/hello.txt" } },
            { op: "editFile", params: { path: "$tmp/w/hello.txt", old: "old", new: "new" } },
            { op: "readFile", params: { path: "$tmp/w/hello.txt" } },
            { op: "writeFile", params: { path: "$tmp/w/hello.txt", content: "x" } }, // 已存在且未允许覆写
            { op: "readPath", params: { path: "$tmp/w/hello.txt" } },
            { op: "readPath", params: { path: "$tmp/w" } },
            { op: "managePath", params: { action: "move", path: "$tmp/w/hello.txt", destination: "$tmp/w/renamed.txt" } },
            { op: "managePath", params: { action: "delete", path: "$tmp/w/renamed.txt" } },
            { op: "readFile", params: { path: "$tmp/w/renamed.txt" } }, // 已删除
        ],
    },
    {
        name: "文件操作落在已存层上：相对路径相对于层的工作目录",
        files: { "a/layer-file.txt": "v1\n" },
        steps: [
            { op: "editFile", params: { [L]: "iso-a", path: "layer-file.txt", old: "v1", new: "v2" } },
            { op: "readFile", params: { [L]: "iso-a", path: "layer-file.txt" } },
            { op: "readPath", params: { [L]: "iso-a", path: "." } },
        ],
    },
    {
        name: "transferFile：put → get 往返一致，校验等级如实报告",
        files: { "payload.txt": "payload-bytes\n" },
        steps: [
            { op: "transferFile", params: { [L]: "iso-b", direction: "put", localPath: "$tmp/payload.txt", remotePath: "uploaded.txt" } },
            { op: "readFile", params: { [L]: "iso-b", path: "uploaded.txt" } },
            { op: "transferFile", params: { [L]: "iso-b", direction: "get", localPath: "$tmp/downloaded.txt", remotePath: "uploaded.txt" } },
            { op: "readFile", params: { path: "$tmp/downloaded.txt" } },
        ],
    },

    // ── runBatch ──
    {
        name: "runBatch：层通配按已存层展开，步骤扇出到每个层",
        files: { "a/who.txt": "a", "b/who.txt": "b" },
        steps: [{
            op: "runBatch",
            params: { plan: { layer: "iso-*", steps: [{ id: "who", kind: "exec", command: "cat who.txt" }] } },
        }],
    },
    {
        name: "runBatch：exec 步骤用 commandFile 引用脚本，零转义",
        files: { "script.sh": "printf 'from-script\\n'\nprintf 'second line\\n'\n" },
        steps: [{
            op: "runBatch",
            params: { plan: { steps: [{ id: "s", kind: "exec", commandFile: "$tmp/script.sh" }, { id: "after", kind: "exec", command: "echo after", after: ["s"] }] } },
        }],
    },
    {
        name: "runBatch：缺省失败即停——已启动的跑完，未启动的标 skipped",
        steps: [{
            op: "runBatch",
            params: { plan: { steps: [
                { id: "bad", kind: "exec", command: "exit 3" },
                { id: "next", kind: "exec", command: "echo next", after: ["bad"] },
            ] } },
        }],
    },
    {
        name: "runBatch：stopOnFail=false 时其余步骤照跑",
        steps: [{
            op: "runBatch",
            params: { plan: { stopOnFail: false, steps: [
                { id: "bad", kind: "exec", command: "exit 3" },
                { id: "next", kind: "exec", command: "echo next" },
            ] } },
        }],
    },
    {
        name: "runBatch：通配无匹配整批拒绝，不改用默认层",
        steps: [{ op: "runBatch", params: { plan: { layer: "no-such-*", steps: [{ id: "x", kind: "exec", command: "echo x" }] } } }],
    },
    {
        name: "runBatch：未知顶层字段与未知步骤字段当场拒绝",
        steps: [
            { op: "runBatch", params: { plan: { steps: [{ id: "x", kind: "exec", command: "true" }] }, extra: 1 } },
            { op: "runBatch", params: { plan: { steps: [{ id: "x", kind: "exec", command: "true", nope: 1 }] } } },
        ],
    },
    {
        name: "runBatch：调用方带来的层描述符优先（计划非法之外的一切都在中层校验）",
        steps: [
            { op: "runBatch", params: { layers: { "iso-x": { driver: "local", cwd: "$tmp/c" } }, plan: { steps: [{ id: "p", kind: "exec", command: "pwd", layer: "iso-x" }] } } },
            { op: "listLayers" as keyof MiddleOps, params: {} },
        ],
    },
    {
        name: "runBatch：read / put / edit 步骤在一个批次里按依赖排序",
        files: { "src.txt": "alpha\n" },
        steps: [{
            op: "runBatch",
            params: { plan: { steps: [
                { id: "put", kind: "put", localPath: "$tmp/src.txt", remotePath: "dst.txt", layer: "iso-a" },
                { id: "edit", kind: "edit", path: "dst.txt", layer: "iso-a", hunks: [{ old: "alpha", new: "beta" }], after: ["put"] },
                { id: "read", kind: "read", path: "dst.txt", layer: "iso-a", after: ["edit"] },
            ] } },
        }],
    },

    // ── 会话 ──
    {
        name: "startSession（就绪握手）→ stopSession：停止已核实",
        steps: [
            { op: "startSession", params: { command: "echo READY-MARK; sleep 30", readyMarker: "READY-MARK" }, save: "s" },
            { op: "stopSession", params: { sessionId: "$ref:s.sessionId" } },
            { op: "stopSession", params: { sessionId: "$ref:s.sessionId" } }, // 已有确定终态：原样回
        ],
    },
    {
        name: "stopSession：归属未知的会话回 unknown，不当成功也不当失败",
        steps: [{ op: "stopSession", params: { sessionId: "no-such-session-0123456789abcdef" } }],
    },
    {
        name: "startSession：就绪超时走「停止 → 核实」收口，错误带 outcome 与会话线索",
        steps: [{ op: "startSession", params: { command: "sleep 30", readyMarker: "NEVER-SHOWS-UP" } }],
        // 每个宿主要等满就绪超时（15s）再做「停止 → 核实」的收口，三个宿主串行
        timeoutMs: 120_000,
    },
    {
        name: "observe：限时观察两路输出，结束后停止",
        steps: [{ op: "observe", params: { command: "echo out-1; echo err-1 >&2; echo out-2; sleep 20", durationMs: 600 } }],
    },
    {
        name: "observe：只要 stderr",
        steps: [{ op: "observe", params: { command: "echo out-1; echo err-1 >&2; sleep 20", stream: "stderr", durationMs: 400 } }],
    },

    // ── 观察窗 ──
    {
        name: "openStream → peekStream（增量）→ listStreams → closeStream → 关窗后读取报错",
        steps: [
            { op: "openStream", params: { command: "printf 'line-1\\n'; sleep 1; printf 'line-2\\n'; sleep 20", waitMs: 2500, limit: 10 }, save: "w" },
            { op: "peekStream", params: { windowId: "$ref:w.windowId", limit: 10 } },
            { op: "listStreams", params: {} },
            { op: "closeStream", params: { windowId: "$ref:w.windowId" } },
            { op: "peekStream", params: { windowId: "$ref:w.windowId" } },
        ],
    },
    {
        name: "openStream：本机层引用带工作目录时命令落在该目录",
        files: { "d/stream-marker.txt": "stream-cwd\n" },
        steps: [
            // 命令读完后不退出：窗口状态恒为「运行中」。命令若瞬间结束，读到的是「已退出」
            // 还是「运行中」取决于轮询时机——那不是同构问题
            { op: "openStream", params: { layer: { descriptor: { driver: "local", cwd: "$tmp/d" } }, command: "cat stream-marker.txt; sleep 20", waitMs: 2500 }, save: "w" },
            { op: "closeStream", params: { windowId: "$ref:w.windowId" } },
        ],
    },

    // ── 层 ──
    {
        name: "listLayers → activateLayer → removeLayer",
        steps: [
            { op: "listLayers", params: {} },
            { op: "activateLayer", params: { [L]: "iso-b" } },
            { op: "listLayers", params: {} },
            { op: "removeLayer", params: { [L]: "iso-b", destroy: true } },
            { op: "listLayers", params: {} },
            { op: "activateLayer", params: { [L]: "iso-nope" } },
        ],
    },
    {
        name: "runBatch：默认层由调用方指定——未写层的步骤不落中层的默认层",
        files: { "c/c-marker.txt": "from-c" },
        steps: [{
            op: "runBatch",
            params: { defaultLayer: "iso-other", layers: ISO_LAYER_STORE, plan: { steps: [{ id: "r", kind: "read", path: "c-marker.txt" }] } },
        }],
    },
    {
        name: "probeLayer：环境探测的蒸馏值",
        steps: [{ op: "probeLayer", params: { [L]: "iso-a" } }],
        timeoutMs: 60_000,
    },
    {
        name: "features：内核能力探测",
        steps: [{ op: "features", params: {} }],
    },
    {
        // 参数本身是数组（唯一一个这样的操作）：经 Daemon 时不能被换成空对象
        name: "connectSshBatch：参数是数组——空数组原样送达",
        steps: [{ op: "connectSshBatch", params: [] }],
    },

    // ── 转发 ──
    {
        name: "转发：不支持转发的层明确拒绝；清单缺省只报在用的",
        steps: [
            { op: "openForward", params: { [L]: "iso-a", spec: { kind: "L", bindPort: 0, targetHost: "127.0.0.1", targetPort: 9 } } },
            { op: "listForwards", params: {} },
            { op: "closeForward", params: { forwardId: "no-such-forward" } },
        ],
    },
];

/** 结果里随时会变、与「同构」无关的字段：比较前去掉 */
const VOLATILE_KEYS = new Set([
    "ts", "durationMs", "startedAt", "createdAt", "pid", "sessionId", "logBase", "windowId", "uptimeMs",
    "bindPort", "port", "mtimeMs", "mtime", "lockedAtMtimeMs",
]);

export interface NormalizeOptions {
    /** 本次运行的临时目录（各种写法都归一成 <TMP>） */
    tmp: string;
    /**
     * 路径锚点：临时目录路径里标识「这一条用例」的目录名。同一条用例在每个宿主上各有一个
     * 临时目录（宿主名在路径里），而 Git Bash 打印同一个目录还有第四种写法（挂载名 /tmp），
     * 猜不全——锚点之前的一整段路径不论哪种写法都归一成 <TMP>
     */
    anchor?: string;
}

/** 路径的各种写法：原样、正斜杠、MSYS 形式（C:\x\y → /c/x/y） */
function tmpVariants(tmp: string): string[] {
    const forward = tmp.replace(/\\/g, "/");
    const msys = forward.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    return [tmp, forward, msys];
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把一步的结果归一成可跨宿主比较的形态：去易变字段、临时目录换成 <TMP>、路径分隔符统一 */
export function normalizeResult(value: unknown, opts: NormalizeOptions): unknown {
    const variants = tmpVariants(opts.tmp);
    const anchorPattern = opts.anchor
        ? new RegExp(`[^\\s'"\\[\\]()]*${escapeRegExp(opts.anchor)}`, "gu")
        : undefined;
    const fixString = (s: string): string => {
        let out = s;
        if (anchorPattern) out = out.replace(anchorPattern, "<TMP>");
        for (const v of variants) if (v) out = out.split(v).join("<TMP>");
        // 报错文案里也会带运行期编号：窗口 / 会话 / 执行日志的 id、临时层的指纹名
        out = out
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
            .replace(/sess-[0-9a-f]+/g, "sess-<ID>")
            .replace(/\b[0-9a-f]{16}\b/g, "<RUNID>")
            .replace(/(\S+)#([0-9a-f]{6})(-[0-9a-f]{4})?\b/g, "$1#<HASH>");
        return out.replace(/\\/g, "/");
    };
    const walk = (v: unknown): unknown => {
        if (typeof v === "string") return fixString(v);
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
            const out: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
                if (VOLATILE_KEYS.has(k)) continue;
                out[k] = walk(x);
            }
            return out;
        }
        return v;
    };
    const walked = walk(value) as unknown;
    // 键序也归一，避免两个宿主序列化时键的先后不同
    return sortKeys(walked);
}

function sortKeys(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
        return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
    }
    return v;
}

/** listLayers 的结果只看本用例集的层（别的用例、别的宿主可能登记了别的层），且按名排序 */
export function scopeLayerListing(step: IsoStep, result: unknown): unknown {
    if (step.op !== "listLayers" || !result || typeof result !== "object") return result;
    const { layers } = result as { layers?: Array<Record<string, unknown>> };
    return { layers: (layers ?? []).filter((l) => String(l.name).startsWith("iso-")).sort((a, b) => String(a.name).localeCompare(String(b.name))) };
}

/** connectSshBatch 的结果只看这次调用自己的产出：activeLayer 是调用结束时宿主的默认层（环境状态，各宿主可以不同） */
export function scopeConnectResult(step: IsoStep, result: unknown): unknown {
    if (step.op !== "connectSshBatch" || !result || typeof result !== "object" || Array.isArray(result)) return result;
    const { activeLayer: _activeLayer, ...rest } = result as { activeLayer?: unknown };
    return rest;
}

/** 操作抛错时的归一形态（错误也是结果的一种：三个宿主报的必须是同一句话） */
export function normalizeError(error: unknown, opts: NormalizeOptions): { error: Record<string, unknown> } {
    const e = error as { message?: string; outcome?: unknown; code?: unknown; exitCode?: unknown };
    return { error: normalizeResult({ message: e?.message ?? String(error), ...(e?.outcome !== undefined ? { outcome: e.outcome } : {}), ...(e?.code !== undefined ? { code: e.code } : {}) }, opts) as Record<string, unknown> };
}
