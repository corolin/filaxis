/**
 * file-transfer.ts — 跨机文件传输 get/put（FEAT-14 / AC-15）
 *
 * 实现分级降级（PRD FEAT-14）：
 *   ① base64 管道（本文件主路径）——非 PTY exec 通道，跨 Transport 一致
 *      （docker/k8s 无 sftp；分块 append + decode 落位 + size/sha256 双校验）
 *   ② sftp 子进程快路径——仅 SSH Transport 大文件（CI sshd 矩阵验证；此处留
 *      扩展点，调用方经 stack.features().sftp 判定后自行接入）
 *
 * 方言适配（dialect.ts 接线）：base64/sha256 原语按连接探测缓存渲染——
 * OPNsense（BSD 无 -w）/Alpine（busybox）不再必错（上游tmux-driver
 * base64 -w 0 生产实锤的根治件）。
 *
 * exec 注入回调——零 I/O 假设，mock 全测。
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { RemoteDialect } from "./dialect.js";

/** 远端执行回调（通常是 driver 的 exec 通道） */
export type TransferExec = (command: string) => Promise<{ stdout: string; exitCode: number }>;

/** put 分块大小（base64 字符数——单条命令行安全长度内） */
const CHUNK_B64 = 48 * 1024;

export interface TransferResult {
    bytes: number;
    /** 远端回读核实的 sha256（与本地一致才返回成功） */
    sha256: string;
    /** 校验是否通过 */
    verified: boolean;
    /** 校验等级（GPT Astra 六轮 #3）：sha256=size+内容摘要双核验；size=远端无 sha256
     *  原语仅大小核验（同长损坏不可检——降级显式知情，不冒充完整校验） */
    verification: "sha256" | "size";
    /** 写入形态（bind mount 深水区定案：校验≠原子性两轴正交）：atomic-replace=mv
     *  原子替换；inplace-write=保留 inode 写入（挂载点 mv 不可用自动降级/请求式）——
     *  传输中断可能暴露半截文件，消费方须知 */
    writeMode: "atomic-replace" | "inplace-write";
}

export class TransferVerificationError extends Error {
    constructor(op: "put" | "get", detail: string) {
        super(`文件传输校验失败（${op}）: ${detail}`);
        this.name = "TransferVerificationError";
    }
}

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** 上行 put（本地文件门面）：读本地文件 → putContent（内存载荷主链路） */
export async function putFile(
    exec: TransferExec,
    dialect: RemoteDialect,
    localPath: string,
    remotePath: string,
    opts: { forceInplace?: boolean } = {},
): Promise<TransferResult> {
    return putContent(exec, dialect, await fs.readFile(localPath), remotePath, opts);
}

/**
 * 上行 put 主链路（内存载荷）：分块 base64 append 到远端临时文件 → 方言 decode
 * 到 **独立输出临时** → size + sha256 回读双校验（对临时输出）→ 校验通过才 mv
 * 原子落位目标。任何一步退出码非零/校验不符 → 抛错并清理临时——目标文件
 * **全程零接触**（GPT Astra 六轮 #1：旧实现 `decode > 目标` shell 重定向先
 * 截断目标，解码中途失败即污染；且空文件零分块 tmp 从未建——本轮一并修）。
 *
 * 临时文件名带随机 nonce（GPT Astra 七轮 #1）：同目标并发上传独占各自的
 * tmp/out——固定名下 B 会覆盖 A 已校验的输出临时，A 随后把 B 的内容落位
 * 还报 verified（「校验 A、落位 B」）。代价：进程被硬杀时残留随机临时
 * （不影响后续传输正确性，可定期清理；不做自动迁移清理——八轮 #1 实锤：
 * 无条件删固定名会砸掉旧版本传输正在使用的文件）。
 */
export async function putContent(
    exec: TransferExec,
    dialect: RemoteDialect,
    content: Buffer,
    remotePath: string,
    opts: { chunkB64?: number; forceInplace?: boolean } = {},
): Promise<TransferResult> {
    if (!dialect.base64Decode.length) {
        throw new Error("远端 base64 原语不可用（方言探测 unknown）——该路径不支持文件传输");
    }
    // 目标目录早拒绝（GPT Astra 八轮 #2）：mv 遇现存目录=把临时移进目录
    // （basename 保留），落位语义被偷换还报 verified——传输前显式拒绝
    const dirChk = await exec(`test -d ${q(remotePath)}`);
    if (dirChk.exitCode === 0) {
        throw new Error(`目标是现存目录（拒绝上传）：${remotePath}——putFile 落位语义是文件路径`);
    }
    const b64 = content.toString("base64");
    const nonce = randomBytes(6).toString("hex");
    const tmp = withSuffix(remotePath, `.filaxis-tmp-${nonce}`); // b64 分块临时（独占+NAME_MAX 安全——Hydrogen R5 #5）
    const out = withSuffix(remotePath, `.filaxis-out-${nonce}`); // decode 输出临时（NAME_MAX 安全——Hydrogen R5 #5）
    const cleanup = () => exec(`rm -f ${q(tmp)} ${q(out)}`).catch(() => undefined);
    const localSha = createHash("sha256").update(content).digest("hex");
    // 分块尺寸可调（真机实证：tmux server 单命令 ~16-24K 即 "command too long"——
    // 键入通道的调用方须传小 chunk；ssh exec 通道 stdin 传命令不受限，缺省 48K）
    const chunkSize = opts.chunkB64 ?? CHUNK_B64;
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
        throw new Error(`chunkB64 非法（${opts.chunkB64}）——须为正数（0/负曾使循环反复发空块永不前进）`);
    }
    let level: "sha256" | "size";
    try {
        if (!b64.length) {
            // 空文件：零分块循环不建 tmp → decode 读不存在的文件必失败——显式建空 tmp
            const mk = await exec(`: > ${q(tmp)}`);
            if (mk.exitCode !== 0) throw new Error(`put 空临时文件创建失败: ${mk.stdout}`);
        }
        for (let i = 0; i < b64.length; i += chunkSize) {
            const chunk = b64.slice(i, i + chunkSize);
            const r = await exec(`printf %s ${q(chunk)} >> ${q(tmp)}`);
            if (r.exitCode !== 0) {
                throw new Error(`put 分块写入失败（chunk ${i / chunkSize}，exit=${r.exitCode}）: ${r.stdout}`);
            }
        }
        // decode → 独立输出临时（同目录 mv = rename 原子落位；目标此时零接触）
        const dec = dialect.base64Decode.join(" ");
        const dc = await exec(`${dec} < ${q(tmp)} > ${q(out)}`);
        if (dc.exitCode !== 0) throw new Error(`put 解码失败（目标未动）: ${dc.stdout}`);
        // 双校验对**临时输出**：size + sha256（方言渲染）——校验不过目标同样零接触
        const v = await verify(exec, dialect, out, content.length, localSha);
        if (!v.verified) throw new TransferVerificationError("put", v.detail);
        level = v.level;
    } catch (e) {
        // 统一失败清理（自排查补：分块中途失败/exec reject 此前漏清 tmp——除进程
        // 硬杀外的一切失败路径零残留）
        await cleanup();
        throw e;
    }
    // 落位（GPT Astra 七轮 #3 + 八轮 #2 + bind mount 定案 + 十八轮 #2 三态 + 审计 H5）：
    // symlink 追踪（readlink -f 真身——mv 对链接路径会替换链接本身破坏拓扑）+ 属性
    // 保持（chmod/chown --reference best-effort）；mv 失败自动降级 cat 保留 inode；
    // 失败三态：目录=未动 / inplace 中断=可能已部分改写（载荷保留 out）/ 其余未动。
    const tgtSetup = `__fx_tgt=$(readlink -f ${q(remotePath)} 2>/dev/null || echo ${q(remotePath)}); ` +
        // 数字模式权限保持（Hydrogen R8 #2 同款）：--reference 仅 GNU——非 GNU 平台
        // 静默回退 umask（敏感文件权限丢失）；stat -c '%a' → chmod NNN 全平台
        `__fx_pm=$(stat -c '%a' "$__fx_tgt" 2>/dev/null); [ -n "$__fx_pm" ] && chmod "$__fx_pm" ${q(out)} 2>/dev/null; ` +
        `chown --reference="$__fx_tgt" ${q(out)} 2>/dev/null || true; `;
    const place = opts.forceInplace
        ? `if cat ${q(out)} > "$__fx_tgt" && rm -f ${q(out)} && echo FX_MV_CAT; then :; else echo FX_INPLACE_FAIL; fi`
        : `if mv ${q(out)} "$__fx_tgt" 2>/dev/null; then echo FX_MV_OK; ` +
          `else if cat ${q(out)} > "$__fx_tgt" && rm -f ${q(out)} && echo FX_MV_CAT; then :; else echo FX_INPLACE_FAIL; fi; fi`;
    const mv = await exec(`test ! -d ${q(remotePath)} || { echo FX_IS_DIR; exit 1; }; { ${tgtSetup}${place}; }`);
    const mvOut = (mv.stdout || "").trim();
    if (mvOut.includes("FX_IS_DIR")) {
        await cleanup();
        throw new Error(`put 落位失败（目标是现存目录）——目标未动: ${remotePath}`);
    }
    if (mvOut.includes("FX_INPLACE_FAIL")) {
        // 不 cleanup：out 载荷保留供核实/重试（目标可能已是半截——处置属调用方）
        throw new Error(
            `put 落位失败（inplace 写入中断——目标 ${remotePath} **可能已被部分改写**，请核实内容；` +
            `完整载荷保留在 ${out} 可重试）`,
        );
    }
    if (mv.exitCode !== 0 || (!mvOut.includes("FX_MV_OK") && !mvOut.includes("FX_MV_CAT"))) {
        await cleanup();
        throw new Error(`put 落位异常（目标未动）: ${remotePath}（输出 ${mvOut.slice(0, 80)}）`);
    }
    const inplace = (mv.stdout || "").includes("FX_MV_CAT");
    await exec(`rm -f ${q(tmp)}`).catch(() => undefined);
    return {
        bytes: content.length, sha256: localSha, verified: true, verification: level,
        writeMode: inplace ? ("inplace-write" as const) : ("atomic-replace" as const),
    };
}

/**
 * 下行 get：远端 → 本地。方言 base64 编码回传 → **校验先行** → 本地临时 +
 * rename 原子落位（GPT Astra 七轮 #2：旧实现先 writeFile 再校验——校验失败
 * 原文件已被覆盖；校验对象是远端回读的 size/sha vs 解码 content，与本地
 * 落盘无关，顺序可安全对调）。
 */
export async function getFile(
    exec: TransferExec,
    dialect: RemoteDialect,
    remotePath: string,
    localPath: string,
): Promise<TransferResult> {
    if (!dialect.base64Encode.length) {
        throw new Error("远端 base64 原语不可用（方言探测 unknown）——该路径不支持文件传输");
    }
    // 本地目标是现存目录早拒绝（自排查，顺 putFile 八轮 #2）：rename 对目录目标
    // 报 ENOTDIR——晚失败且信息不友好，先拒
    const st = await fs.stat(localPath).catch(() => undefined);
    if (st?.isDirectory()) {
        throw new Error(`本地目标是现存目录（拒绝下载落位）：${localPath}`);
    }
    const enc = dialect.base64Encode.join(" ");
    const r = await exec(`${enc} < ${q(remotePath)}`);
    if (r.exitCode !== 0) throw new Error(`get 编码回传失败: ${r.stdout}`);
    const content = Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
    const localSha = createHash("sha256").update(content).digest("hex");
    // 校验先行：不过 → 本地目标零接触（临时都不建）
    const v = await verify(exec, dialect, remotePath, content.length, localSha);
    if (!v.verified) throw new TransferVerificationError("get", v.detail);
    // 本地临时 + rename 原子落位（写中途失败/磁盘满不留半截；并发本地写互不干扰）
    const localTmp = `${localPath}.filaxis-get-${randomBytes(6).toString("hex")}`;
    try {
        await fs.writeFile(localTmp, content);
        await fs.rename(localTmp, localPath);
    } catch (e) {
        await fs.rm(localTmp, { force: true }).catch(() => undefined);
        throw e;
    }
    return { bytes: content.length, sha256: localSha, verified: true, verification: v.level, writeMode: "atomic-replace" as const };
}

/** size + sha256 回读双校验（sha256 原语缺席时降级为仅 size——等级随结果透传，
 *  不再冒充完整校验：verified=true 须配合 level=size 理解为「仅大小核验」） */
async function verify(
    exec: TransferExec,
    dialect: RemoteDialect,
    remotePath: string,
    expectSize: number,
    expectSha: string,
): Promise<{ verified: boolean; detail: string; level: "sha256" | "size" }> {
    const sz = await exec(`wc -c < ${q(remotePath)}`);
    if (sz.exitCode !== 0) {
        // 校验命令失败（Sol 54 P2-12）：wc 退出 1 输出仍可能可解析——曾据错误
        // 输出报 verified:true（下载落盘+假校验双害）。命令失败=校验不成立
        return { verified: false, detail: `size 校验命令失败（exit=${sz.exitCode}）`, level: "size" };
    }
    const size = parseInt((sz.stdout || "").trim(), 10);
    if (size !== expectSize) return { verified: false, detail: `size 不一致（远端 ${size} ≠ 本地 ${expectSize}）`, level: "size" };
    if (!dialect.sha256.length) {
        // sha256 原语缺席：size 单校验通过即通过（方言 unknown 的诚实降级）
        return { verified: true, detail: "size-only（sha256 原语缺席）", level: "size" };
    }
    const sh = await exec(`${dialect.sha256.join(" ")} < ${q(remotePath)}`);
    const remoteSha = (sh.stdout || "").replace(/[^0-9a-f]/g, "");
    if (!remoteSha.includes(expectSha)) {
        return { verified: false, detail: `sha256 不一致（远端 ${remoteSha.slice(0, 16)}… ≠ 本地 ${expectSha.slice(0, 16)}…）`, level: "sha256" };
    }
    return { verified: true, detail: "size+sha256", level: "sha256" };
}

// ════════════════ sftp 快路径（FEAT-14 ②：仅 SSH Transport 大文件） ════════════════

import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";

export type SftpSpawnImpl = (argv: string[], batch: string) => Promise<{ exitCode: number | null; stderr: string }>;

async function defaultSftpSpawn(argv: string[], batch: string): Promise<{ exitCode: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
        const p: ChildProcess = defaultSpawn("sftp", argv, { stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        p.stderr?.on("data", (d: Buffer) => { stderr += d; });
        // stdin 管道错误监听（GPT Astra 九轮 P1 同病面）：sftp 秒退时写管道抛
        // write EOF——无监听器则 uncaught 崩宿主；显式 reject（close 兜底幂等）
        p.stdin?.on("error", (e: Error) => reject(e));
        try {
            p.stdin?.write(batch);
            p.stdin?.end();
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
        }
        p.on("close", (code) => resolve({ exitCode: code, stderr }));
        p.on("error", reject);
    });
}

export interface SftpOptions {
    /** 连接参数（host key 策略/端口/密钥——与 ssh 通道同源） */
    connArgs: string[];
    /** spawn 注入（缺省真实 sftp 子进程 + `-b -` batch 模式）——mock 全测关键 */
    spawnImpl?: SftpSpawnImpl;
}

/** SFTP batch 路径防线（审计 M5）：batch 按行分割——路径含换行即命令注入面
 *  （q() 单引号对 sftp batch 解析器无效）；前导 - 会被当选项（用 ./ 相对形态）。 */

/** NAME_MAX 安全后缀路径（Hydrogen R5 #5）：basename+suffix 超 255B 触发
 *  ENAMETOOLONG——接近上限时截 basename 前段并以短 hash 保唯一性 */
function withSuffix(p: string, suffix: string): string {
    const slash = p.lastIndexOf("/");
    const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
    const name = slash >= 0 ? p.slice(slash + 1) : p;
    if (name.length + suffix.length <= 255) return p + suffix;
    const crypto = globalThis.crypto;
    const h = crypto && "randomUUID" in crypto
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(16).slice(2, 10);
    const keep = Math.max(1, 255 - suffix.length - 9);
    return dir + name.slice(0, keep) + "~" + h + suffix;
}

function assertSftpPath(p: string, what: string): void {
    if (/[\n\r]/.test(p)) {
        throw new Error(`SFTP ${what}路径含换行（batch 按行分割=命令注入面，拒绝）: ${JSON.stringify(p.slice(0, 40))}`);
    }
    if (p.startsWith("-")) {
        throw new Error(`SFTP ${what}路径以 - 开头（会被当选项）——改用 ./ 相对形态: ${p.slice(0, 40)}`);
    }
    // 引号/空白拒绝（Hydrogen R3 #5）：sftp batch 解析器不认 POSIX shell 引号语法
    // （q() 的 ''' 拼接无效）且按空白分词——含引号/空白的路径直接拒绝（可走 base64 管道）
    if (/['"\t ]/.test(p)) {
        throw new Error(`SFTP ${what}路径含引号或空白（batch 解析器不支持，请走 base64 管道）: ${JSON.stringify(p.slice(0, 40))}`);
    }
}

/**
 * sftp 快路径 put：`sftp -b -` batch 模式（stdin 喂 `put` 命令）。
 * 成功后仍走 size/sha256 双校验（与 base64 路径同一信任标准——快路径不豁免校验）。
 * 缺席/失败由调用方捕获后降级 base64 管道（PRD FEAT-14 降级链）。
 */
export async function sftpPutFile(
    exec: TransferExec,
    dialect: RemoteDialect,
    localPath: string,
    remotePath: string,
    opts: SftpOptions,
): Promise<TransferResult> {
    const doSpawn = opts.spawnImpl ?? defaultSftpSpawn;
    assertSftpPath(localPath, "本地");
    assertSftpPath(remotePath, "远端");
    const batch = `put ${q(localPath)} ${q(remotePath)}\n`;
    const r = await doSpawn([...opts.connArgs, "-b", "-"], batch);
    if (r.exitCode !== 0) {
        throw new Error(`sftp put 失败（exit=${r.exitCode}）——可降级 base64 管道: ${r.stderr.trim().slice(0, 200)}`);
    }
    const content = await fs.readFile(localPath);
    const localSha = createHash("sha256").update(content).digest("hex");
    const v = await verify(exec, dialect, remotePath, content.length, localSha);
    if (!v.verified) throw new TransferVerificationError("put", v.detail);
    // sftp put 协议直写目标（open/truncate/write）——本质保留 inode 非原子，显式声明
    return { bytes: content.length, sha256: localSha, verified: true, verification: v.level, writeMode: "inplace-write" as const };
}

/** sftp 快路径 get（batch `get`；校验同 put） */
export async function sftpGetFile(
    exec: TransferExec,
    dialect: RemoteDialect,
    remotePath: string,
    localPath: string,
    opts: SftpOptions,
): Promise<TransferResult> {
    const doSpawn = opts.spawnImpl ?? defaultSftpSpawn;
    assertSftpPath(localPath, "本地");
    assertSftpPath(remotePath, "远端");
    const batch = `get ${q(remotePath)} ${q(localPath)}\n`;
    const r = await doSpawn([...opts.connArgs, "-b", "-"], batch);
    if (r.exitCode !== 0) {
        throw new Error(`sftp get 失败（exit=${r.exitCode}）——可降级 base64 管道: ${r.stderr.trim().slice(0, 200)}`);
    }
    const content = await fs.readFile(localPath);
    const localSha = createHash("sha256").update(content).digest("hex");
    const v = await verify(exec, dialect, remotePath, content.length, localSha);
    if (!v.verified) throw new TransferVerificationError("get", v.detail);
    return { bytes: content.length, sha256: localSha, verified: true, verification: v.level, writeMode: "inplace-write" as const };
}
