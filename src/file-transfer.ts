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
import { createReadStream } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RemoteDialect } from "./dialect.js";
import { renderInplaceWrite, renderPreserveMode } from "./file-placement.js";
import { sshFileStdioRequested, spawnWithFileRedirect } from "./ssh-file-stdio.js";
import { openSshEnvironment } from "./openssh-environment.js";
import { windowsCreatePrivateStage, windowsPlaceExclusivePayload, windowsPlaceVerifiedPayload } from "./windows-upload-acl.js";
import type { ExecOptions } from "./driver.js";

/** Forward exec options when wrapping a driver so payload-bearing calls retain their audit policy. */
export type TransferExec = (
    command: string,
    options?: Pick<ExecOptions, "auditLabel">,
) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;

/** Decode standard Base64 into raw bytes, allowing line wrapping but rejecting malformed output. */
export function decodeFileBytes(output: string, path: string, expectedBytes?: number, opLabel = "readFile"): Buffer {
    const encoded = output.replace(/[ \t\r\n]+/g, "");
    const content = Buffer.from(encoded, "base64");
    if (content.toString("base64") !== encoded) throw new Error(`${opLabel} 返回无效 Base64: ${path}`);
    if (expectedBytes !== undefined && content.length !== expectedBytes) {
        throw new Error(`${opLabel} 长度对账失败（解码 ${content.length}B，源 ${expectedBytes}B）: ${path}`);
    }
    return content;
}

/** Decode standard Base64, allowing line wrapping but rejecting malformed output. */
export function decodeFileRead(output: string, path: string, expectedBytes?: number): string {
    return decodeFileBytes(output, path, expectedBytes, "readFile").toString("utf-8");
}

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

async function createUploadStage(exec: TransferExec, base: string): Promise<{ stage: string; payload: string; windows: boolean }> {
    const nonce = randomBytes(6).toString("hex");
    const stage = withSuffix(base.startsWith("-") ? `./${base}` : base, `.filaxis-stage-${nonce}`);
    const dir = q(stage);
    const result = await exec(`(umask 077; case "$(uname -s)" in MINGW*|MSYS*) ` +
        `__fx_stage_win=$(cygpath -aw ${dir}) || exit 1; ` +
        `FILAXIS_UPLOAD_STAGE="$__fx_stage_win" ${windowsCreatePrivateStage} && echo FX_STAGE_WINDOWS ;; ` +
        `*) mkdir -m 700 ${dir} ;; esac)`);
    if (result.exitCode !== 0) throw new Error(`无法创建上传暂存目录（目标未动）: ${base}`);
    // Keep the basename unique even on shells whose mv treats a new destination directory as a container.
    return { stage, payload: `${stage}/payload-${nonce}`, windows: result.stdout.trim() === "FX_STAGE_WINDOWS" };
}

/** 上行 put（本地文件门面）：读本地文件 → putContent（内存载荷主链路） */
export async function putFile(
    exec: TransferExec,
    dialect: RemoteDialect,
    localPath: string,
    remotePath: string,
    opts: { chunkB64?: number; forceInplace?: boolean } = {},
): Promise<TransferResult> {
    return putContent(exec, dialect, await fs.readFile(localPath), remotePath, opts);
}

export async function writeInplaceContent(
    exec: TransferExec,
    dialect: RemoteDialect,
    content: Buffer,
    remotePath: string,
    chunkB64?: number,
    opts: { exclusive?: boolean } = {},
): Promise<TransferResult> {
    const result = await exec("mktemp -d /tmp/filaxis-write.XXXXXXXXXX");
    const stageDir = result.stdout.trim();
    if (result.exitCode !== 0 || !/^\/tmp\/filaxis-write\.[A-Za-z0-9]{10}$/.test(stageDir)) {
        throw new Error(`writeFile 无法创建暂存目录（目标未动）: ${remotePath}`);
    }
    try {
        return await stageAndPlaceContent(
            exec, dialect, content, remotePath,
            { chunkB64, forceInplace: true, exclusive: opts.exclusive },
            `${stageDir}/payload`,
        );
    } finally {
        await exec(`rmdir ${q(stageDir)}`).catch(() => undefined);
    }
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
    opts: { chunkB64?: number; forceInplace?: boolean; exclusive?: boolean } = {},
): Promise<TransferResult> {
    return stageAndPlaceContent(exec, dialect, content, remotePath, opts, remotePath);
}

async function stageAndPlaceContent(
    exec: TransferExec,
    dialect: RemoteDialect,
    content: Buffer,
    remotePath: string,
    opts: { chunkB64?: number; forceInplace?: boolean; exclusive?: boolean },
    stageBase: string,
): Promise<TransferResult> {
    if (!dialect.base64Decode.length) {
        throw new Error("远端 base64 原语不可用（方言探测 unknown）——该路径不支持文件传输");
    }
    if (opts.exclusive) {
        const existsChk = await exec(`test -e ${q(remotePath)} || test -L ${q(remotePath)}`);
        if (existsChk.exitCode === 0) {
            throw Object.assign(new Error(`文件已存在，拒绝覆盖: ${remotePath}`), { code: "EEXIST" as const });
        }
    }
    // 目标目录早拒绝（GPT Astra 八轮 #2）：mv 遇现存目录=把临时移进目录
    // （basename 保留），落位语义被偷换还报 verified——传输前显式拒绝
    const dirChk = await exec(`test -d ${q(remotePath)}`);
    if (dirChk.exitCode === 0) {
        throw new Error(`目标是现存目录（拒绝上传）：${remotePath}——putFile 落位语义是文件路径`);
    }
    const chunkSize = opts.chunkB64 ?? CHUNK_B64;
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
        throw new Error(`chunkB64 非法（${opts.chunkB64}）——须为正数（0/负曾使循环反复发空块永不前进）`);
    }
    const b64 = content.toString("base64");
    const { stage, payload: out, windows } = await createUploadStage(exec, stageBase);
    const tmp = `${stage}/encoded`;
    const cleanup = () => exec(`rm -f ${q(tmp)} ${q(out)}`).catch(() => undefined);
    const localSha = createHash("sha256").update(content).digest("hex");
    let level: "sha256" | "size";
    try {
        if (!b64.length) {
            // 空文件：零分块循环不建 tmp → decode 读不存在的文件必失败——显式建空 tmp
            const mk = await exec(`(umask 077; : > ${q(tmp)})`);
            if (mk.exitCode !== 0) throw new Error(`put 空临时文件创建失败: ${mk.stdout}`);
        }
        for (let i = 0; i < b64.length; i += chunkSize) {
            const chunk = b64.slice(i, i + chunkSize);
            const r = await exec(`(umask 077; printf %s ${q(chunk)} >> ${q(tmp)})`, { auditLabel: "file upload" });
            if (r.exitCode !== 0) {
                throw new Error(`put 分块写入失败（chunk ${i / chunkSize}，exit=${r.exitCode}）`);
            }
        }
        // decode → 独立输出临时（同目录 mv = rename 原子落位；目标此时零接触）
        const dec = dialect.base64Decode.join(" ");
        const dc = await exec(`(umask 077; ${dec} < ${q(tmp)} > ${q(out)})`);
        if (dc.exitCode !== 0) throw new Error(`put 解码失败（目标未动）: ${dc.stdout}`);
        // 双校验对**临时输出**：size + sha256（方言渲染）——校验不过目标同样零接触
        const v = await verify(exec, dialect, out, content.length, localSha);
        if (!v.verified) throw new TransferVerificationError("put", v.detail);
        level = v.level;
    } catch (e) {
        // 统一失败清理（自排查补：分块中途失败/exec reject 此前漏清 tmp——除进程
        // 硬杀外的一切失败路径零残留）
        await cleanup();
        await exec(`rmdir ${q(stage)}`).catch(() => undefined);
        throw e;
    }
    try {
        const writeMode = await placeVerifiedUpload(exec, out, remotePath, {
            forceInplace: opts.forceInplace, applyUmask: true, windows, exclusive: opts.exclusive,
        });
        return { bytes: content.length, sha256: localSha, verified: true, verification: level, writeMode };
    } finally {
        await exec(`rm -f ${q(tmp)}; rmdir ${q(stage)}`).catch(() => undefined);
    }
}

async function placeVerifiedUpload(
    exec: TransferExec, out: string, remotePath: string,
    { forceInplace = false, applyUmask = false, windows = false, exclusive = false } = {},
): Promise<TransferResult["writeMode"]> {
    const cleanup = () => exec(`rm -f ${q(out)}`).catch(() => undefined);
    if (exclusive) {
        const exclusiveModeSetup = applyUmask
            ? `__fx_mask=$(umask); case "$__fx_mask" in [0-7][0-7][0-7]|0[0-7][0-7][0-7]) ;; ` +
              `*) exec 3>&- 2>/dev/null || true; rm -f -- "$__fx_seed" 2>/dev/null || true; echo FX_PERMISSIONS_FAIL; exit 1;; esac; ` +
              `__fx_new_mode=$(printf '%03o' "$((0666 & ~(0$__fx_mask)))"); ` +
              `chmod "$__fx_new_mode" "$__fx_seed" || { exec 3>&- 2>/dev/null || true; rm -f -- "$__fx_seed" 2>/dev/null || true; echo FX_PERMISSIONS_FAIL; exit 1; }; `
            : "";
        const exclusiveCmd = windows
            ? `[ -f ${q(out)} ] || { echo FX_NO_PAYLOAD; exit 1; }; ` +
              `__fx_src_win=$(cygpath -aw ${q(out)}) && __fx_tgt_win=$(cygpath -aw ${q(remotePath)}) || exit 1; ` +
              `if FILAXIS_UPLOAD_SOURCE="$__fx_src_win" FILAXIS_UPLOAD_TARGET="$__fx_tgt_win" ${windowsPlaceExclusivePayload}; ` +
              `then echo FX_MV_OK; else echo FX_WINDOWS_PLACEMENT_UNKNOWN; fi`
            : `[ -f ${q(out)} ] || { echo FX_NO_PAYLOAD; exit 1; }; ` +
              `if [ -e ${q(remotePath)} ] || [ -L ${q(remotePath)} ]; then echo FX_ALREADY_EXISTS; exit 1; fi; ` +
              `__fx_dir=$(dirname -- ${q(remotePath)} && printf .) || exit 1; __fx_dir=\${__fx_dir%??}; ` +
              `case "$__fx_dir" in /*) ;; *) __fx_dir="./$__fx_dir" ;; esac; ` +
              `__fx_seed=$(mktemp "\${__fx_dir%/}/.filaxis-excl.XXXXXXXXXX" 2>/dev/null) || { echo FX_CREATE_FAIL; exit 1; }; ` +
              `exec 3> "$__fx_seed" 2>/dev/null || { rm -f -- "$__fx_seed" 2>/dev/null || true; echo FX_CREATE_FAIL; exit 1; }; ` +
              `${exclusiveModeSetup}` +
              `if ! ln -T -- "$__fx_seed" ${q(remotePath)} 2>/dev/null; then ` +
              `exec 3>&- 2>/dev/null || true; rm -f -- "$__fx_seed" 2>/dev/null || true; ` +
              `if [ -e ${q(remotePath)} ] || [ -L ${q(remotePath)} ]; then echo FX_ALREADY_EXISTS; else echo FX_CREATE_FAIL; fi; exit 1; fi; ` +
              `rm -f -- "$__fx_seed" 2>/dev/null || true; ` +
              `if cat < ${q(out)} >&3 && exec 3>&-; then rm -f ${q(out)} 2>/dev/null || true; echo FX_MV_CAT; ` +
              `else exec 3>&- 2>/dev/null || true; echo FX_INPLACE_FAIL; exit 1; fi`;
        const res = await exec(`( ${exclusiveCmd} )`);
        const resOut = (res.stdout || "").trim();
        if (resOut.includes("FX_ALREADY_EXISTS")) {
            await cleanup();
            throw Object.assign(new Error(`文件已存在，拒绝覆盖: ${remotePath}`), { code: "EEXIST" as const });
        }
        if (resOut.includes("FX_WINDOWS_PLACEMENT_UNKNOWN")) {
            throw Object.assign(new Error(`Windows 上传落位或 ACL 应用结果未知，请核实目标和暂存载荷：${remotePath}（${out}）`), { outcome: "unknown" as const });
        }
        if (resOut.includes("FX_PERMISSIONS_FAIL")) {
            await cleanup();
            throw new Error(`put 落位失败（无法设置文件权限，目标未动）: ${remotePath}`);
        }
        if (resOut.includes("FX_NO_PAYLOAD")) {
            await cleanup();
            throw new Error(`put 落位中止（载荷在落位前消失或无法打开，目标未动）: ${remotePath}`);
        }
        if (resOut.includes("FX_CREATE_FAIL")) {
            await cleanup();
            throw new Error(`put 落位失败（无法独占创建目标文件，目标未动）: ${remotePath}`);
        }
        if (resOut.includes("FX_INPLACE_FAIL")) {
            throw new Error(
                `put 落位失败（独占写入失败——请核实目标 ${remotePath}；` +
                `完整载荷保留在 ${out} 可重试）`,
            );
        }
        if (res.exitCode !== 0 || (!resOut.includes("FX_MV_OK") && !resOut.includes("FX_MV_CAT"))) {
            await cleanup();
            throw new Error(`put 落位异常（目标未动）: ${remotePath}（输出 ${resOut.slice(0, 80)}）`);
        }
        return resOut.includes("FX_MV_CAT") ? "inplace-write" : "atomic-replace";
    }
    // 落位（GPT Astra 七轮 #3 + 八轮 #2 + bind mount 定案 + 十八轮 #2 三态 + 审计 H5）：
    // symlink 追踪（readlink -f 真身——mv 对链接路径会替换链接本身破坏拓扑）+ 属性
    // 保持（chmod/chown --reference best-effort）；mv 失败自动降级 cat 保留 inode；
    // 失败三态：目录=未动 / inplace 中断=可能已部分改写（载荷保留 out）/ 其余未动。
    const tgtSetup = `__fx_tgt=$(if readlink -f ${q(remotePath)} 2>/dev/null; then printf .; ` +
        `elif [ -L ${q(remotePath)} ]; then exit 1; else printf '%s\\n.' ${q(remotePath)}; fi) ` +
        `|| { echo FX_UNRESOLVED_LINK; exit 1; }; __fx_tgt=\${__fx_tgt%??}; `;
    const preserveMode = renderPreserveMode(q(out));
    // The private staging directory protects the payload while its mode changes.
    // For a new file, apply the mode a regular creation would get in this layer.
    const setNewMode = applyUmask
        ? `__fx_new_file=0; if [ ! -e "$__fx_tgt" ]; then ` +
          `__fx_mask=$(umask); case "$__fx_mask" in [0-7][0-7][0-7]|0[0-7][0-7][0-7]) ;; *) echo FX_PERMISSIONS_FAIL; exit 1;; esac; ` +
          `__fx_new_mode=$(printf '%03o' "$((0666 & ~(0$__fx_mask)))"); ` +
          `chmod "$__fx_new_mode" ${q(out)} || { echo FX_PERMISSIONS_FAIL; exit 1; }; __fx_new_file=1; fi; `
        : "";
    const restoreReadablePayload = applyUmask
        ? `if [ "$__fx_new_file" = 1 ] && [ -f ${q(out)} ]; then chmod u+r ${q(out)} || { echo FX_PERMISSIONS_FAIL; exit 1; }; fi; `
        : "";
    const inplaceWrite = renderInplaceWrite(q(out), '"$__fx_tgt"', "echo FX_MV_CAT");
    const atomicPlace = windows
        ? `[ -f ${q(out)} ] || { echo FX_NO_PAYLOAD; exit 1; }; ` +
          `__fx_src_win=$(cygpath -aw ${q(out)}) && __fx_tgt_win=$(cygpath -aw "$__fx_tgt") || exit 1; ` +
          `if FILAXIS_UPLOAD_SOURCE="$__fx_src_win" FILAXIS_UPLOAD_TARGET="$__fx_tgt_win" ${windowsPlaceVerifiedPayload}; ` +
          `then echo FX_MV_OK; else echo FX_WINDOWS_PLACEMENT_UNKNOWN; fi`
        : `${preserveMode}` +
          `${setNewMode}` +
          `__fx_mv=0; ` +
          `if mv -T ${q(out)} "$__fx_tgt" 2>/dev/null; then echo FX_MV_OK; ` +
          `else if [ ! -d "$__fx_tgt" ] && mv ${q(out)} "$__fx_tgt" 2>/dev/null && __fx_mv=1 && [ ! -d "$__fx_tgt" ]; then echo FX_MV_OK; ` +
          `else if [ "$__fx_mv" = "1" ] && [ -d "$__fx_tgt" ] && mv "$__fx_tgt/$__fx_ob" ${q(out)} 2>/dev/null; then echo FX_IS_DIR; ` +
          `else ${restoreReadablePayload}${inplaceWrite}; fi; fi; fi`;
    const place = forceInplace
        ? inplaceWrite
        : `__fx_ob=$(basename ${q(out)} 2>/dev/null); ` +
          `__fx_od=$(stat -c %d ${q(out)} 2>/dev/null || stat -f %d ${q(out)} 2>/dev/null); ` +
          `__fx_td=$(stat -c %d "$(dirname "$__fx_tgt")" 2>/dev/null || stat -f %d "$(dirname "$__fx_tgt")" 2>/dev/null); ` +
          `if [ -n "$__fx_od" ] && [ "$__fx_od" = "$__fx_td" ]; then ` +
          `if [ -d "$__fx_tgt" ]; then echo FX_IS_DIR; exit 1; fi; ` +
          `${atomicPlace}; ` +
          `else ` +
          `if [ -d "$__fx_tgt" ]; then echo FX_IS_DIR; exit 1; fi; ` +
          `${inplaceWrite}; ` +
          `fi`;
    // 落位五防（Sol 87 P1-5 → Sol 88 P1-6 → Sol 89 P1-4/P1-5）：
    // ①前置 [ -d ] 快速拒绝（外层 test 与本处之间目标被换成目录）；
    // ②mv -T 精确指目标——拒绝目录时零副作用；③裸 mv 回落前置守卫+事后复验；
    // ④回搬分支带**搬移证据**（__fx_mv=1 只在裸 mv 成功后才置位——曾无条件
    // 按 basename 回搬，把目录里**恰同名的无关文件**搬出后删除/误当载荷）；
    // ⑤**设备号分流**（跨设备上传曾谎报 atomic-replace）：载荷临时在原路径
    // 一侧，符号链接真身可在另一文件系统——mv 跨设备时退化为复制仍报原子。
    // stat -c/-f 双方言取设备号，同设备才走 rename 链；跨设备/不可判一律走
    // cat（FX_MV_CAT→inplace-write 诚实标注，无法判定时保守按跨设备）。
    // cat 形态一律 `< src > tgt`（Sol 90 P1-3）：shell 从左到右处理重定向——
    // 源打开失败时目标尚未被截断（`cat src > tgt` 是 cat 自己开源、shell 先
    // 截目标——载荷丢失后原文件曾被截成 0 字节且恢复路径无存）
    const mv = await exec(`( test ! -d ${q(remotePath)} || { echo FX_IS_DIR; exit 1; }; ${tgtSetup}${place} )`);
    const mvOut = (mv.stdout || "").trim();
    if (mvOut.includes("FX_WINDOWS_PLACEMENT_UNKNOWN")) {
        throw Object.assign(new Error(`Windows 上传落位或 ACL 应用结果未知，请核实目标和暂存载荷：${remotePath}（${out}）`), { outcome: "unknown" as const });
    }
    if (mvOut === "FX_UNRESOLVED_LINK") {
        await cleanup();
        throw new Error(`put 落位失败（无法解析目标符号链接，链接已保留）: ${remotePath}`);
    }
    if (mvOut.includes("FX_IS_DIR")) {
        await cleanup();
        throw new Error(`put 落位失败（目标是现存目录）——目标未动: ${remotePath}`);
    }
    if (mvOut.includes("FX_PERMISSIONS_FAIL")) {
        await cleanup();
        throw new Error(`put 落位失败（无法设置文件权限，目标未动）: ${remotePath}`);
    }
    if (mvOut.includes("FX_NO_PAYLOAD")) {
        // 载荷在落位前已消失（Sol 90 P1-3）：`< src > tgt` 重定向排序保证目标
        // **未被截断**——零接触；专错不谎称恢复路径在场
        await cleanup();
        throw new Error(`put 落位中止（载荷在落位前消失或无法打开，目标未动）: ${remotePath}`);
    }
    if (mvOut.includes("FX_INPLACE_PAYLOAD_MISSING")) {
        await cleanup();
        throw new Error(`put 原地写入失败（目标可能已被部分改写，恢复载荷已不在）：${remotePath}`);
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
    return mvOut.includes("FX_MV_CAT") ? "inplace-write" : "atomic-replace";
}

/**
 * 分页读取远端文件字节（供 tmux readFile 与 getFile 共用）：
 * 小文件单次 Base64 直出；大文件先编码落盘到远端 0600 独占临时文件，再按 8KB Base64
 * 分页读取，避开 tmux 滚动窗口与聚合缓冲截断。
 */
export async function readPagedFileBytes(
    exec: TransferExec,
    base64EncodeCmd: string,
    remotePath: string,
    opts: { maxDirectB64?: number; pageB64?: number; auditLabel?: string; opLabel?: string } = {},
): Promise<Buffer> {
    const maxDirectB64 = opts.maxDirectB64 ?? 12_000;
    const pageB64 = Math.max(1, Math.min(8_000, opts.pageB64 ?? 8_000));
    const op = opts.opLabel ?? "readFile";
    const execOpts = opts.auditLabel ? { auditLabel: opts.auditLabel } : undefined;
    const st = await exec(`wc -c < ${q(remotePath)} 2>/dev/null`, execOpts);
    if (st.exitCode !== 0) {
        const detail = (st.stderr || st.stdout || "").trim();
        throw new Error(detail
            ? `${op} 失败（wc 退出码 ${st.exitCode}）: ${remotePath}: ${detail}`
            : `${op} 失败（wc 退出码 ${st.exitCode}）: ${remotePath}`);
    }
    const sizeText = st.stdout.trim();
    const size = Number(sizeText);
    if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size)) {
        throw new Error(`${op} 失败（文件大小无法核实）: ${remotePath}`);
    }
    if (size * 2 <= maxDirectB64) {
        const r = await exec(`${base64EncodeCmd} < ${q(remotePath)}`, execOpts);
        if (r.exitCode !== 0) {
            const detail = (r.stderr || r.stdout || "").trim();
            throw new Error(detail
                ? `${op} 失败（base64 退出码 ${r.exitCode}）: ${remotePath}: ${detail}`
                : `${op} 失败（base64 退出码 ${r.exitCode}）: ${remotePath}`);
        }
        return decodeFileBytes(r.stdout, remotePath, size, op);
    }
    const tmp = `/tmp/filaxis-read-${randomBytes(8).toString("hex")}.b64`;
    try {
        const tot = await exec(
            `(umask 077; set -C; ${base64EncodeCmd} < ${q(remotePath)} > ${q(tmp)}) && wc -c < ${q(tmp)}`,
            execOpts,
        );
        const totText = (tot.stdout || "").trim();
        const total = Number(totText);
        if (tot.exitCode !== 0 || !/^\d+$/.test(totText) || !Number.isSafeInteger(total)) {
            const detail = (tot.stderr || tot.stdout || "").trim();
            throw new Error(detail
                ? `${op} 失败（base64 退出码 ${tot.exitCode}）: ${remotePath}: ${detail}`
                : `${op} 失败（base64 退出码 ${tot.exitCode}）: ${remotePath}`);
        }
        const chunks: string[] = [];
        for (let off = 1; off <= total; off += pageB64) {
            const pg = await exec(`test -r ${q(tmp)} && tail -c +${off} ${q(tmp)} | head -c ${pageB64}`, execOpts);
            if (pg.exitCode !== 0) {
                throw new Error(`${op} 分页读失败（页偏移 ${off} 退出码 ${pg.exitCode}）: ${remotePath}`);
            }
            chunks.push(pg.stdout.replace(/[ \t\r\n]+/g, ""));
        }
        return decodeFileBytes(chunks.join(""), remotePath, size, op);
    } finally {
        await exec(`rm -f ${q(tmp)}`).catch(() => undefined);
    }
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
    opts: { chunkB64?: number } = {},
): Promise<TransferResult> {
    if (!dialect.base64Encode.length) {
        throw new Error("远端 base64 原语不可用（方言探测 unknown）——该路径不支持文件传输");
    }
    // 本地目标是现存目录早拒绝（自排查，顺 putFile 八轮 #2）：rename 对目录目标
    // 报 ENOTDIR——晚失败且信息不友好，先拒
    const st = await fs.stat(localPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
    });
    if (st?.isDirectory()) {
        throw new Error(`本地目标是现存目录（拒绝下载落位）：${localPath}`);
    }
    const enc = dialect.base64Encode.join(" ");
    let content: Buffer;
    if (opts.chunkB64 !== undefined) {
        content = await readPagedFileBytes(exec, enc, remotePath, {
            maxDirectB64: opts.chunkB64,
            pageB64: Math.min(8_000, opts.chunkB64),
            auditLabel: "file download",
            opLabel: "get",
        });
    } else {
        const r = await exec(`${enc} < ${q(remotePath)}`, { auditLabel: "file download" });
        if (r.exitCode !== 0) throw new Error(`get 编码回传失败（exit=${r.exitCode}）`);
        content = Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
    }
    const localSha = createHash("sha256").update(content).digest("hex");
    // 校验先行：不过 → 本地目标零接触（临时都不建）
    const v = await verify(exec, dialect, remotePath, content.length, localSha);
    if (!v.verified) throw new TransferVerificationError("get", v.detail);
    // 本地临时 + rename 原子落位（写中途失败/磁盘满不留半截；并发本地写互不干扰）
    // 本地临时名 NAME_MAX 安全（Sol 58 P2-5）：240 字符目标名+后缀曾超 255B——
    // 创建失败下载不落盘。超限时截 basename 前段+短 hash 保唯一
    // 本地临时名走 localTmpFor（Sol 73 #5）：内联旧版按码元计——252B 中文名
    // 追后缀 ENAMETOOLONG（上传/sftp 已修、此处漏）
    const localTmp = localTmpFor(localPath, `.filaxis-get-${randomBytes(6).toString("hex")}`);
    try {
        await fs.writeFile(localTmp, content, { flag: "wx", mode: 0o600 });
        if (st) await fs.chmod(localTmp, st.mode & 0o777);
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
    if (sh.exitCode !== 0) {
        // sha 命令失败（Sol 55 P2-C）：wc 已查——sha 同罪（exit 1+匹配输出曾仍 verified）
        return { verified: false, detail: `sha256 校验命令失败（exit=${sh.exitCode}）`, level: "sha256" };
    }
    const remoteSha = (sh.stdout || "").replace(/[^0-9a-f]/g, "");
    if (!remoteSha.includes(expectSha)) {
        return { verified: false, detail: `sha256 不一致（远端 ${remoteSha.slice(0, 16)}… ≠ 本地 ${expectSha.slice(0, 16)}…）`, level: "sha256" };
    }
    return { verified: true, detail: "size+sha256", level: "sha256" };
}

// ════════════════ sftp 快路径（FEAT-14 ②：仅 SSH Transport 大文件） ════════════════

import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";

export type SftpSpawnImpl = (argv: string[], batch: string) => Promise<{ exitCode: number | null; stderr: string }>;

async function defaultSftpSpawn(argv: string[], batch: string, timeoutMs?: number): Promise<{ exitCode: number | null; stderr: string }> {
    if (sshFileStdioRequested()) return spawnWithFileRedirect(argv, batch, { executable: "sftp", timeoutMs });
    return new Promise((resolve, reject) => {
        const p: ChildProcess = defaultSpawn("sftp", argv, {
            stdio: ["pipe", "ignore", "pipe"], windowsHide: true, env: openSshEnvironment(),
        });
        const timer = timeoutMs ? setTimeout(() => {
            stderr += `\nsftp 超时（${timeoutMs}ms）`;
            p.kill("SIGKILL");
        }, timeoutMs) : undefined;
        let stderr = "";
        p.stderr?.on("data", (d: Buffer) => { stderr += d; });
        // stdin 管道错误监听（GPT Astra 九轮 P1 同病面）：sftp 秒退时写管道抛
        // write EOF——无监听器则 uncaught 崩宿主；显式 reject（close 兜底幂等）
        let stdinError: Error | undefined;
        p.stdin?.on("error", (e: Error) => { stdinError = e; });
        try {
            p.stdin?.write(batch);
            p.stdin?.end();
        } catch (e) {
            stdinError = e instanceof Error ? e : new Error(String(e));
        }
        p.on("close", (code) => {
            clearTimeout(timer);
            if (stdinError && code === 0) reject(stdinError);
            else resolve({ exitCode: code, stderr });
        });
        p.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
}

export interface SftpOptions {
    /** OpenSSH SFTP 连接选项，最后一个参数为目标主机 */
    connArgs: string[];
    timeoutMs?: number;
    forceInplace?: boolean;
    /** spawn 注入（缺省真实 sftp 子进程 + `-b -` batch 模式）——mock 全测关键 */
    spawnImpl?: SftpSpawnImpl;
}

/** SFTP batch 路径防线（审计 M5）：batch 按行分割——路径含换行即命令注入面
 *  （q() 单引号对 sftp batch 解析器无效）；前导 - 会被当选项（用 ./ 相对形态）。 */

/** NAME_MAX 安全后缀路径（Hydrogen R5 #5）：basename+suffix 超文件系统字节上限
 *  触发 ENAMETOOLONG——接近上限时截 basename 前段并以短 hash 保唯一性。
 *  字节口径（Sol 72 #5）：码元计数曾让 252B 中文文件名（84 码元）+后缀
 *  「看似放得进」——Linux NAME_MAX 按 UTF-8 字节计，追后缀即超限 */
function withSuffix(p: string, suffix: string): string {
    const slash = p.lastIndexOf("/");
    const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
    const name = slash >= 0 ? p.slice(slash + 1) : p;
    const suffixBytes = Buffer.byteLength(suffix, "utf-8");
    if (Buffer.byteLength(name, "utf-8") + suffixBytes <= 255) return p + suffix;
    const h = randomBytes(4).toString("hex");
    const keep = Math.max(1, 255 - suffixBytes - 9);
    let cut = name.slice(0, keep);
    while (Buffer.byteLength(cut, "utf-8") > keep && cut.length > 0) cut = cut.slice(0, -1);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // 代理对不拆（多字节名截断）
    return dir + cut + "~" + h + suffix;
}

function assertSftpPath(p: string, what: string): void {
    if (/[\n\r]/.test(p)) {
        throw new Error(`SFTP ${what}路径含换行（batch 按行分割=命令注入面，拒绝）: ${JSON.stringify(p.slice(0, 40))}`);
    }
    if (p.startsWith("-")) {
        throw new Error(`SFTP ${what}路径以 - 开头（会被当选项）——改用 ./ 相对形态: ${p.slice(0, 40)}`);
    }
    // Batch quoting preserves spaces. Reject glob syntax and characters that would
    // require different escaping for local and remote SFTP paths.
    if (/['"\\*?\[\]\x00-\x1f\x7f]/.test(p)) {
        throw new Error(`SFTP ${what}路径含引号、通配符、反斜杠或控制字符，请走 exec 传输: ${JSON.stringify(p.slice(0, 40))}`);
    }
}

function sftpBatchArgs(connArgs: string[]): string[] {
    // getopt 在部分平台会在第一个非选项参数处结束。
    return ["-b", "-", ...connArgs];
}

async function digestFile(path: string): Promise<{ bytes: number; sha256: string }> {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
        bytes += chunk.length;
    }
    return { bytes, sha256: hash.digest("hex") };
}

async function resolveSftpRemotePath(exec: TransferExec, path: string): Promise<string> {
    assertSftpPath(path, "远端");
    if (path.startsWith("/")) return path;
    // SFTP starts in its own working directory. Anchor relative paths in the
    // same shell environment used for verification, placement and cleanup.
    const cwd = await exec("pwd -P");
    const directory = cwd.stdout.replace(/\n$/, "");
    if (cwd.exitCode !== 0 || !directory.startsWith("/")) {
        throw new Error(`SFTP 无法核实远端工作目录: ${path}`);
    }
    const resolved = `${directory === "/" ? "" : directory}/${path}`;
    assertSftpPath(resolved, "远端");
    return resolved;
}

/**
 * sftp 快路径 put：`sftp -b -` batch 模式（stdin 喂 `put` 命令）。
 * 上传到独立暂存文件，校验通过后沿用普通上传的落位逻辑。
 * 失败由调用方处理。无法确认落位状态时，调用方须先核实目标。
 */
export async function sftpPutFile(
    exec: TransferExec,
    dialect: RemoteDialect,
    localPath: string,
    remotePath: string,
    opts: SftpOptions,
): Promise<TransferResult> {
    const doSpawn = opts.spawnImpl ?? defaultSftpSpawn;
    const local = process.platform === "win32" ? localPath.replaceAll("\\", "/") : localPath;
    assertSftpPath(local, "本地");
    const target = await resolveSftpRemotePath(exec, remotePath);
    const digest = await digestFile(localPath);
    const { stage, payload: staged, windows } = await createUploadStage(exec, target);
    let verification: TransferResult["verification"];
    try {
        try {
            const batch = `put ${q(local)} ${q(staged)}\n`;
            const r = await doSpawn(sftpBatchArgs(opts.connArgs), batch, opts.timeoutMs);
            if (r.exitCode !== 0) {
                throw new Error(`sftp put 失败（exit=${r.exitCode}）——可降级 base64 管道: ${r.stderr.trim().slice(0, 200)}`);
            }
            const v = await verify(exec, dialect, staged, digest.bytes, digest.sha256);
            if (!v.verified) throw new TransferVerificationError("put", v.detail);
            verification = v.level;
        } catch (error) {
            await exec(`rm -f ${q(staged)}`).catch(() => undefined);
            throw error;
        }
        const writeMode = await placeVerifiedUpload(exec, staged, target, { forceInplace: opts.forceInplace, windows });
        return { ...digest, verified: true, verification, writeMode };
    } finally {
        await exec(`rmdir ${q(stage)}`).catch(() => undefined);
    }
}

/** 本地下载临时名（Sol 63 P2-5）：basename+后缀超 255B 截前段+短 hash（NAME_MAX 安全） */
/** 本地临时名（字节口径 NAME_MAX 安全）：suffix 由调用方给（fx-dl/filaxis-get
 *  两条下载路径共用——Sol 73 #5：getFile 内联旧版仍按码元计，252B 中文名
 *  追后缀 ENAMETOOLONG） */
function localTmpFor(localPath: string, suffix: string): string {
    const name = basename(localPath);
    const suffixBytes = Buffer.byteLength(suffix, "utf-8");
    // 字节口径（Sol 72 #5 同 withSuffix）：多字节长名按 UTF-8 字节预算截断
    if (Buffer.byteLength(name, "utf-8") + suffixBytes <= 255) {
        return join(dirname(localPath), name + suffix);
    }
    const keep = Math.max(1, 255 - suffixBytes - 9);
    let cut = name.slice(0, keep);
    while (Buffer.byteLength(cut, "utf-8") > keep && cut.length > 0) cut = cut.slice(0, -1);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return join(dirname(localPath), cut + "~" + randomBytes(4).toString("hex") + suffix);
}

/** sftp 快路径 get（batch `get`；校验同 put）。
 *  先落临时再校验后归位（Sol 63 P2-5）：get 直写目标+事后校验——校验失败时
 *  目标已被坏内容覆盖（original→bad 无从恢复）。临时落位→双校验通过才
 *  rename 归位；任何失败清临时，目标分毫未动 */
export async function sftpGetFile(
    exec: TransferExec,
    dialect: RemoteDialect,
    remotePath: string,
    localPath: string,
    opts: SftpOptions,
): Promise<TransferResult> {
    const doSpawn = opts.spawnImpl ?? defaultSftpSpawn;
    const local = process.platform === "win32" ? localPath.replaceAll("\\", "/") : localPath;
    assertSftpPath(local, "本地");
    const source = await resolveSftpRemotePath(exec, remotePath);
    const existing = await fs.stat(localPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
    });
    if (existing?.isDirectory()) throw new Error(`本地目标是现存目录（拒绝下载落位）：${localPath}`);
    const tmpLocal = localTmpFor(localPath, `.fx-dl-${process.pid}-${randomBytes(4).toString("hex")}`);
    await fs.writeFile(tmpLocal, "", { flag: "wx", mode: 0o600 });
    const temporary = process.platform === "win32" ? tmpLocal.replaceAll("\\", "/") : tmpLocal;
    const batch = `get ${q(source)} ${q(temporary)}\n`;
    let r: Awaited<ReturnType<typeof doSpawn>>;
    try {
        r = await doSpawn(sftpBatchArgs(opts.connArgs), batch, opts.timeoutMs);
    } catch (e) {
        // 执行器抛错也清临时（Sol 64 #5）：spawn 调用曾在清理 try 之外——
        // 半途抛错（已写部分内容）留下 .fx-dl-* 残件
        await fs.unlink(tmpLocal).catch(() => undefined);
        throw e;
    }
    if (r.exitCode !== 0) {
        await fs.unlink(tmpLocal).catch(() => undefined);
        throw new Error(`sftp get 失败（exit=${r.exitCode}）——可降级 base64 管道: ${r.stderr.trim().slice(0, 200)}`);
    }
    try {
        const digest = await digestFile(tmpLocal);
        const v = await verify(exec, dialect, source, digest.bytes, digest.sha256);
        if (!v.verified) throw new TransferVerificationError("get", v.detail);
        if (existing) await fs.chmod(tmpLocal, existing.mode & 0o777);
        await fs.rename(tmpLocal, localPath);
        return { ...digest, verified: true, verification: v.level, writeMode: "atomic-replace" as const };
    } catch (e) {
        await fs.unlink(tmpLocal).catch(() => undefined);
        throw e;
    }
}
