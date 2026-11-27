/**
 * middle-isomorphism.test.ts — 中层同构用例集（REQ-0004 §9 M6、AC-03）
 *
 * 同一份声明式语料（isomorphism-corpus.ts）在三种宿主上各跑一遍，结果必须一致：
 *   即弃进程内   —— 一次性 CLI 的形态：每个用例一个全新的中层，用完销毁
 *   SDK 长驻     —— SDK 使用方的形态：一个中层跑完全部用例，状态跨用例留存
 *   Daemon 远程  —— CLI / MCP 经 Daemon 的形态：参数与结果走线协议（JSON 序列化）
 *
 * 语料不调用任何 TypeScript 函数，只有「调哪个操作、传什么参数」。将来的 Rust 内核、别的
 * 语言的薄入口拿同一份语料跑一遍，和这里的结果比即可（ROADMAP §6.1 P3）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dumpResults } from "./isomorphism-dump.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DaemonClient, DaemonServer } from "../src/index.js";
import { connectRemoteMiddle } from "../src/interface/daemon/daemon-client.js";
import { createMiddle, type LocalMiddle } from "../src/middle/middle.js";
import type { Middle, MiddleOps } from "../src/middle/types.js";
import type { RuntimeDescriptor } from "../src/core/base/driver.js";
import {
    ISO_CASES, ISO_LAYER_STORE, normalizeError, normalizeResult, scopeLayerListing,
    type IsoCase, type IsoStep, type Json,
} from "./isomorphism-corpus.js";

// ── 参数里的记号在运行时替换 ──
interface RunContext { tmp: string; saved: Record<string, unknown> }

function expand(value: Json, ctx: RunContext): unknown {
    if (typeof value === "string") {
        if (value.startsWith("$=")) return value.slice(2);
        if (value.startsWith("$ref:")) {
            const [name, ...path] = value.slice(5).split(".");
            let cur: unknown = ctx.saved[name!];
            for (const key of path) cur = (cur as Record<string, unknown> | undefined)?.[key!];
            if (cur === undefined) throw new Error(`$ref 落空: ${value}`);
            return cur;
        }
        if (value === "$tmp" || value.startsWith("$tmp/")) return join(ctx.tmp, value.slice(5));
        return value;
    }
    if (Array.isArray(value)) return value.map((v) => expand(v, ctx));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, ctx)]));
    }
    return value;
}

function resolveStore(tmp: string): Record<string, RuntimeDescriptor> {
    // 语料是纯数据（Json）；这里只是把它交给中层时换一个静态类型
    return Object.fromEntries(Object.entries(ISO_LAYER_STORE).map(([name, descriptor]) => [name, expand(descriptor, { tmp, saved: {} })])) as unknown as Record<string, RuntimeDescriptor>;
}

// ── 宿主 ──
interface HostSession { middle: Middle; close(): Promise<void> }
/** dir：临时目录名——不能带空格（结果里的路径以「用例目录名」为锚点归一，空格会截断匹配） */
interface Host { name: string; dir: string; open(): Promise<HostSession> }

const HOSTS: Host[] = [
    {
        name: "即弃进程内",
        dir: "ephemeral",
        async open() {
            // 层表读取函数每次调用都取「当前用例」的层表（由 runCase 在开始时刷新）
            const middle = createMiddle({ savedLayers: () => currentStore, version: "iso" });
            return { middle, close: () => middle.shutdown() };
        },
    },
    {
        name: "SDK 长驻",
        dir: "sdk",
        async open() {
            return { middle: sdkMiddle!, close: async () => { /* 长驻：不随用例销毁 */ } };
        },
    },
    {
        name: "Daemon 远程",
        dir: "daemon",
        async open() {
            // Daemon 进程内的中层经 loadLayerStore 读层表——runCase 在开始时把当前用例的层表写进那个文件
            const client = new DaemonClient({ addr: daemon!.addr, token: daemon!.token });
            return { middle: await connectRemoteMiddle(client), close: async () => { /* 状态在 Daemon 进程里 */ } };
        },
    },
];

let sdkMiddle: LocalMiddle | undefined;
let daemon: DaemonServer | undefined;
/** 当前用例的层表（三个宿主共用同一份内容：进程内的两个直接读，Daemon 读它指向的文件） */
let currentStore: Record<string, RuntimeDescriptor> = {};
let daemonStorePath: string | undefined;
let daemonDir: string | undefined;
let previousLayersEnv: string | undefined;
let root: string | undefined;

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fx-iso-"));
    sdkMiddle = createMiddle({ savedLayers: () => currentStore, version: "iso" });
    daemonDir = join(root, "daemon");
    mkdirSync(daemonDir, { recursive: true });
    daemonStorePath = join(root, "daemon-layers.json");
    previousLayersEnv = process.env.FILAXIS_LAYERS;
    process.env.FILAXIS_LAYERS = daemonStorePath;
    daemon = new DaemonServer({ daemonDir, writeFiles: false, version: "iso" });
    await daemon.start();
});

afterAll(async () => {
    await daemon?.stop().catch(() => undefined);
    await sdkMiddle?.shutdown().catch(() => undefined);
    if (previousLayersEnv === undefined) delete process.env.FILAXIS_LAYERS;
    else process.env.FILAXIS_LAYERS = previousLayersEnv;
    if (root) rmSync(root, { recursive: true, force: true });
});

// ── 执行一个用例 ──
async function runCase(session: HostSession, c: IsoCase, host: Host): Promise<unknown[]> {
    const caseDir = c.name.replace(/[^\p{L}\p{N}._-]+/gu, "_");
    // 每个宿主各有一个临时目录（路径里带宿主的目录名）：上一个宿主留下的后台命令还占着它自己的
    // 目录当工作目录，Windows 上删不掉，所以不共用、不清空
    const tmp = join(root!, host.dir, caseDir);
    mkdirSync(tmp, { recursive: true });
    const norm = { tmp, anchor: caseDir };
    for (const [rel, content] of Object.entries(c.files ?? {})) {
        const target = join(tmp, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
    // 已存层的工作目录要真实存在（本机层的工作目录不存在时命令起不来）
    for (const dir of ["a", "b", "c"]) mkdirSync(join(tmp, dir), { recursive: true });
    // 层表按本用例自己的临时目录解析：已存层的工作目录必须在这次运行的目录里真实存在
    currentStore = resolveStore(tmp);
    writeFileSync(daemonStorePath!, JSON.stringify(currentStore));
    const ctx: RunContext = { tmp, saved: {} };
    const results: unknown[] = [];
    for (const step of c.steps) {
        const params = expand(step.params, ctx);
        let raw: unknown;
        let normalized: unknown;
        try {
            raw = await (session.middle.ops[step.op as keyof MiddleOps] as (p: unknown) => Promise<unknown>)(params);
            normalized = normalizeResult(scopeLayerListing(step, raw), norm);
        } catch (e) {
            raw = e;
            normalized = normalizeError(e, norm);
        }
        if (step.save) ctx.saved[step.save] = raw;
        results.push(normalized);
    }
    // 清场：把本用例登记的层与窗收掉——宿主之间、用例之间互不残留（已存层下次按需重新登记）
    const { layers } = await session.middle.ops.listLayers();
    for (const layer of layers) {
        if (layer.name.startsWith("iso-")) await session.middle.ops.removeLayer({ layer: layer.name, destroy: true }).catch(() => undefined);
    }
    const { streams } = await session.middle.ops.listStreams();
    for (const s of streams) await session.middle.ops.closeStream({ windowId: s.windowId }).catch(() => undefined);
    return results;
}

describe("中层同构用例集（REQ-0004 AC-03）：三种宿主同参同果", () => {
    for (const c of ISO_CASES) {
        test(c.name, async () => {
            const results: Record<string, string> = {};
            const raw: Record<string, unknown[]> = {};
            for (const host of HOSTS) {
                const session = await host.open();
                try {
                    raw[host.name] = await runCase(session, c, host);
                    results[host.name] = JSON.stringify(raw[host.name]);
                    // 诊断：终端里的期望值会被测试框架截断——设 FX_ISO_DUMP=<目录> 时把完整结果落成文件
                    void dumpResults(c.name, host.name, raw[host.name]!);
                } finally {
                    await session.close();
                }
            }
            const baseline = results["即弃进程内"]!;
            for (const name of Object.keys(results)) {
                expect(results[name], `${name}宿主的结果与「即弃进程内」不一致`).toBe(baseline);
            }
        }, c.timeoutMs ?? 20_000);
    }
});

describe("中层同构用例集：语料自身的约束", () => {
    test("每条用例都有名字，且互不重复；每一步的操作名都在中层操作集里", async () => {
        const { REMOTE_OP_NAMES } = await import("../src/middle/protocol.js");
        const names = ISO_CASES.map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
        for (const c of ISO_CASES) {
            expect(c.steps.length).toBeGreaterThan(0);
            for (const step of c.steps) {
                expect((REMOTE_OP_NAMES as readonly string[]).includes(step.op), `${c.name} / ${step.op}`).toBe(true);
            }
        }
    });

    test("语料是纯数据：可整体 JSON 序列化，不含函数", () => {
        expect(() => JSON.parse(JSON.stringify(ISO_CASES))).not.toThrow();
        expect(JSON.stringify(ISO_CASES)).toContain("\"op\":\"runCommand\"");
    });
});
