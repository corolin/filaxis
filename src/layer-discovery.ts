/**
 * layer-discovery.ts — 异步层环境探测助手（冷启动锦囊之异步侧）
 *
 * 探测不阻塞建层：`discoverLayer(driver)` 返回 Promise，消费方（自发现编排/
 * 观察窗）自行选择 fire-and-forget 或 await——建层与探测解耦。
 * 两段式（stage1 快 / stage2 慢包导入）+ 蒸馏 + 落盘（stale 防漂移）+ 可选跳过 stage2。
 */
import {
    buildProbeStage1,
    buildProbeStage2,
    parseProbeOutput,
    layerEnvKey,
    layerFingerprint,
    projectConnection,
    LayerEnvStore,
    type LayerEnvEntry,
    type LayerEnvironmentSpec,
} from "./layer-env.js";
import type { RuntimeDriver } from "./driver.js";

export interface DiscoverLayerOptions {
    /** 落盘 Store（缺省内存态——探测结果仍返回不落盘） */
    store?: LayerEnvStore;
    /** 跳过 stage2（慢包导入——10s+；快路径/离线探测） */
    skipStage2?: boolean;
    /** stage2 独立超时（缺省 120s——由调用方驱动 exec 超时） */
    stage2TimeoutMs?: number;
    logger?: { warn(msg: string): void };
}

export interface DiscoverLayerResult {
    key: string;
    spec: LayerEnvironmentSpec;
    /** stage2 失败/跳过时如实标注（诚实不假装完整） */
    probeNote?: string;
    stale?: boolean;
    entry?: LayerEnvEntry;
}

/** 异步探测一层环境：两段式 → 蒸馏 → （可选）落盘（漂移标 stale 不覆盖） */
export async function discoverLayer(
    driver: RuntimeDriver,
    opts: DiscoverLayerOptions = {},
): Promise<DiscoverLayerResult> {
    const key = layerEnvKey(driver.descriptor);

    const r1 = await driver.exec(buildProbeStage1(), { timeoutMs: 30_000 });
    if (r1.exitCode !== 0) {
        // stage1 失败不落盘（Sol 54 P2-10）：曾 exit 127（命令缺失）仍把空规格
        // 写进 store 并报 stale:false——空规格覆盖真规格=探测一次坏一次
        throw new Error(`环境探测 stage1 失败（exit=${r1.exitCode}）——不落盘（防空规格覆盖）: ${r1.stderr.slice(0, 120)}`);
    }
    const spec = parseProbeOutput(r1.stdout);
    let probeNote: string | undefined;
    if (!opts.skipStage2) {
        try {
            const r2 = await driver.exec(buildProbeStage2(), {
                timeoutMs: opts.stage2TimeoutMs ?? 120_000,
            });
            const spec2 = parseProbeOutput(r2.stdout);
            spec.packages = spec2.packages; // stage2 增量合并（包）
        } catch (err) {
            probeNote = `stage2 失败（${err instanceof Error ? err.message : String(err)}）——packages 可能缺席`;
            opts.logger?.warn(`[discoverLayer ${key}] ${probeNote}`);
        }
    } else {
        probeNote = "stage2 skipped";
    }

    const entry: LayerEnvEntry = {
        connection: projectConnection(driver.descriptor),
        environment: spec,
        discovered_at: new Date().toISOString(),
        fingerprint: layerFingerprint(projectConnection(driver.descriptor), spec),
        probe_note: probeNote,
    };

    let stale: boolean | undefined;
    if (opts.store) {
        const r = await opts.store.upsert(key, entry);
        stale = r.stale;
    }
    return { key, spec, probeNote, stale, entry: opts.store ? undefined : entry };
}
