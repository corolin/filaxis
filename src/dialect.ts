/**
 * dialect.ts — 远端命令方言适配层（FEAT-14：GNU · BSD · busybox 三族原语探测与渲染）
 *
 * 动机（生产实锤）：`base64 -w 0` 为纯 GNU 方言——FreeBSD/OPNsense 的 base64
 * 不认 `-w`（BSD 用 `-b`，解码历史差异 `-d`/`-D`）；sha256 工具 Linux=sha256sum /
 * FreeBSD=/sbin/sha256 -q / 精简容器=busybox 或 openssl dgst。目标环境
 * （OPNsense/Alpine）不探测必错。探测结果**按连接缓存**（探测键由调用方持有）。
 */
import type { ExecResult } from "./driver.js";

export type DialectFamily = "gnu" | "bsd" | "busybox" | "openssl-fallback" | "unknown";

/** 一套已探测的远端原语（渲染为 argv 前缀，拼接数据参数后执行） */
export interface RemoteDialect {
    family: DialectFamily;
    /** 编码（无换行输出）：["base64","-w","0"]（GNU）/ ["base64"]（BSD·默认不折行） */
    base64Encode: string[];
    /** 解码：GNU ["base64","-d"] / BSD ["base64","-D"] */
    base64Decode: string[];
    /** sha256 摘要：["sha256sum"] / ["sha256","-q"] / busybox ["sha256sum"] / openssl ["openssl","dgst","-sha256"] */
    sha256: string[];
}

export type ExecFn = (command: string) => Promise<Pick<ExecResult, "stdout" | "exitCode">>;

/** 探测失败时的兜底：全部原语标记不可用（显式，不静默用错方言） */
export const NULL_DIALECT: RemoteDialect = {
    family: "unknown",
    base64Encode: [],
    base64Decode: [],
    sha256: [],
};

async function tryCmd(exec: ExecFn, cmd: string): Promise<{ ok: boolean; stdout: string }> {
    // 通道崩溃/超时 → reject 上抛（审计 M6：catch 吞成 ok:false 会让网络瞬断被
    // 判定「原语不支持」并**永久缓存** NULL_DIALECT——该主机后续操作永久降级）。
    // 退出码非零才是真实的「命令不存在」证据（数据不抛）。
    const r = await exec(cmd);
    return { ok: r.exitCode === 0, stdout: r.stdout };
}

/** 探测远端方言（每命令独立判定；缺原语=该族标记跳过，非报错） */
export async function probeDialect(exec: ExecFn): Promise<RemoteDialect> {
    // ── base64 编码：GNU 认 -w 0，BSD 报错（认 -b）──
    const gnuEnc = await tryCmd(exec, "printf filaxis | base64 -w 0");
    if (gnuEnc.ok && gnuEnc.stdout.includes("ZmlsYXhpcw==")) {
        // GNU base64 在场；解码参数再探（GNU -d）
        const gnuDec = await tryCmd(exec, "printf ZmlsYXhpcw== | base64 -d");
        if (gnuDec.ok && gnuDec.stdout.includes("filaxis")) {
            const sha = await detectSha256(exec);
            return { family: sha.family, base64Encode: ["base64", "-w", "0"], base64Decode: ["base64", "-d"], sha256: sha.argv };
        }
    }
    // ── BSD：无 -w 默认不折行；解码 -D（老 BSD）或 -d（新）──
    const bsdEnc = await tryCmd(exec, "printf filaxis | base64");
    if (bsdEnc.ok && bsdEnc.stdout.replace(/\s+/g, "").includes("ZmlsYXhpcw==")) {
        const decD = await tryCmd(exec, "printf ZmlsYXhpcw== | base64 -d");
        const decFlag = decD.ok && decD.stdout.includes("filaxis") ? "-d" : "-D";
        const sha = await detectSha256(exec);
        return { family: sha.family, base64Encode: ["base64"], base64Decode: ["base64", decFlag], sha256: sha.argv };
    }
    // ── base64 完全缺席（极简容器）：全 NULL（调用方显式降级别的原语路径）──
    return { ...NULL_DIALECT, sha256: (await detectSha256(exec)).argv };
}

const HEX64 = /[0-9a-f]{64}/;

async function detectSha256(exec: ExecFn): Promise<{ family: DialectFamily; argv: string[] }> {
    const coreutils = await tryCmd(exec, "printf filaxis | sha256sum");
    if (coreutils.ok && HEX64.test(coreutils.stdout)) {
        return { family: "gnu", argv: ["sha256sum"] };
    }
    const bsd = await tryCmd(exec, "printf filaxis | sha256 -q");
    if (bsd.ok && HEX64.test(bsd.stdout.trim())) {
        return { family: "bsd", argv: ["sha256", "-q"] };
    }
    const openssl = await tryCmd(exec, "printf filaxis | openssl dgst -sha256");
    if (openssl.ok && HEX64.test(openssl.stdout)) {
        return { family: "openssl-fallback", argv: ["openssl", "dgst", "-sha256"] };
    }
    return { family: "unknown", argv: [] };
}

/** 按连接缓存：探测键（调用方用连接身份）→ 方言 */
export class DialectCache {
    private cache = new Map<string, RemoteDialect>();

    async get(probeKey: string, exec: ExecFn, force = false): Promise<RemoteDialect> {
        if (!force && this.cache.has(probeKey)) return this.cache.get(probeKey)!;
        const d = await probeDialect(exec);
        this.cache.set(probeKey, d);
        return d;
    }

    invalidate(probeKey?: string): void {
        if (probeKey) this.cache.delete(probeKey);
        else this.cache.clear();
    }
}
