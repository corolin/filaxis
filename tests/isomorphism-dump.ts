/**
 * isomorphism-dump.ts — 同构用例集的诊断出口：设 FX_ISO_DUMP=<目录> 时，把每个用例在
 * 每个宿主上的完整结果写成 <用例>.<宿主>.json。测试框架打印期望值时会截断长字符串，
 * 跨宿主的差异要靠完整结果做结构对比才看得清。不设环境变量时什么都不做。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FX_ISO_DUMP;

export function dumpResults(caseName: string, host: string, results: unknown): void {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const safe = (s: string): string => s.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 80);
    writeFileSync(join(dir, `${safe(caseName)}.${safe(host)}.json`), JSON.stringify(results, null, 1));
}
