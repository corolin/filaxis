/**
 * file-edit.ts — 受控文件编辑（远端 CAS 原子写回 + 合成 SSH 往返）
 *
 * 第六季盲测实锤：SKILL 教了受控编辑但 SDK 无一级导出——Agent 读 7 轮源码自研
 * 20 行样板（50 万 cache tokens）；裸 SSH 组则 sed -i 两翻车并写坏远端配置。
 *
 * 第七季盲测反馈（B2 逐秒拆解）：旧实现一次 editFile = 5 次串行 SSH 往返
 * （stat/read/stat/write/stat），Windows 无 ControlMaster 下放大到 15s+。
 * 第七季版合成「读+戳 1 次 + 远端 CAS 原子写回 1 次」——但方言探测（base64
 * -w 0/-d/-D）是独立往返，SDK 常驻内存下有 dialectCache 掩护，**CLI 每次冷启动
 * 实为 3 次物理往返**（第十季 B5 轨迹实锤：3×SSH 握手 ≈11.4s 突破宿主 10s 后台
 * 阈值，多耗 3 轮轮询）。
 *
 * 本版（第十季）：**真 2 次往返**——方言探测合成进读往返（① stat/sha 戳 +
 * base64 -d 探测 + 文件读取一次带回；② CAS 写回用已确定 argv）。编码侧无需
 * 探测：折行输出由解析侧 \s+ 归一消化（base64 < file 全方言通吃）；解码侧
 * 不用 `base64 -d || base64 -D` 赌 fallback（GPT 否决：双解码器共用 stdin，
 * 首个消费后第二个拿不到完整载荷）。大文件（base64>30KB）自动回落 fs 层路径。
 *
 * **仅适用 UTF-8 文本**（readFile 返回 UTF-8 字符串；二进制文件的编辑走
 * readBase64 + 消费方自行改写 + writeFile）。
 */
import * as crypto from "node:crypto";
import type { RuntimeDriver } from "./driver.js";

export interface EditFileOptions {
    /** 多处命中时全替换（缺省 false——多处命中报错，精确替换语义） */
    all?: boolean;
    /** 写入策略（校验≠原子性——两轴正交）：缺省 auto=原子替换优先，mv 失败
     *  （Docker 单文件 bind mount 挂载点 EBUSY/EXDEV 类）自动降级保留 inode
     *  写入并显式报告；"inplace"=已知挂载环境显式请求（跳过 mv 少一次失败尝试） */
    writeMode?: "auto" | "inplace";
}

export interface EditFileResult {
    path: string;
    occurrences: number;
    bytesBefore: number;
    bytesAfter: number;
    /** 写前锁核验的 mtimeMs（CAS 远端原子比对用） */
    lockedAtMtimeMs: number;
    /** 并发互斥保护等级：flock=锁全程互斥；degraded=环境无 flock CLI 无锁降级（核验比对兜底，调度间隙窗口仍在——调用方明确知情） */
    mutex?: "flock" | "degraded";
    /** 写入形态（盲测深水区定案：CAS 校验通过 ≠ 写入原子性——两轴正交显式报告）：
     *  atomic-replace=tmp+mv 原子替换（中断不留半截）；inplace-write=保留 inode
     *  写入（bind mount 挂载点 mv 不可用）——写入中断可能暴露半截文件，消费方须知 */
    writeMode?: "atomic-replace" | "inplace-write";
}

/** 多 hunk 编辑结果（第十一季批量组合——同文件多替换对一次 CAS 原子应用） */
export interface EditMultiHunk {
    old: string;
    new: string;
    occurrences: number;
}

export interface EditFileMultiResult extends EditFileResult {
    hunks: EditMultiHunk[];
}

export class EditConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EditConflictError";
    }
}

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** 单引号安全检查（base64/stamp 等嵌入 shell 引号前的红线） */
const shellSafe = (s: string) => !s.includes("'") && !s.includes("\n");

/**
 * stat 戳命令模板（{f}=文件——行为 fallback 链，不探版本：GNU -c 优先、
 * 失败自动 BSD -f——CI 实证版本探测在 Ubuntu 误判走 BSD 分支）。
 */
const statCmdOf = (f: string) => `stat -c '%Y %s' ${f} 2>/dev/null || stat -f '%m %z' ${f} 2>/dev/null`;

/**
 * 内容指纹命令（三族 fallback 链：sha256sum → sha256 -q → openssl；
 * CAS 戳的内容分量：stat %Y 秒级粒度有同秒同 size 盲区——内容指纹封死。
 * openssl 分支必须 awk 取尾字段（GPT Astra 三轮 #3 实锤：`SHA2-256(path)= hex` 直接
 * head -c 12 截到的是**算法名+路径前缀**——不随内容变化，同秒等长修改指纹相同 →
 * CAS 放行覆盖；macOS/无 sha256sum 环境全中）。
 */
export const shaCmdOf = (f: string) =>
    `{ sha256sum ${f} 2>/dev/null || sha256 -q ${f} 2>/dev/null || ` +
    `openssl dgst -sha256 ${f} 2>/dev/null | awk '{print $NF}'; } | head -c 12`;

/** 本地 sha 前 12 位（与 shaCmdOf 远端输出同口径——写后回验比对用） */
const shaCmdOfContent = (content: string) =>
    crypto.createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 12);

/**
 * 受控编辑（真 2 次往返 + 远端 CAS 原子写回）：
 * ① 读+戳+方言探测（1 次往返）：`stat 戳; sha 戳; __FXS__; base64 -d 探测;
 *    __FXD__; base64 < file` —— (mtime,size)+全文+解码 argv 一次带回
 *    （__FXD__ 含下划线不在 base64 字母表——与 __FXS__ 同款防撞）
 * ② 精确替换（本地）：0 命中/多处命中（未开 all）拒绝
 * ③ CAS 原子写回（1 次往返）：远端一条命令内完成「戳比对 + tmp 写 + mv 原子替换 + 新戳回执」
 *    —— 戳不符（他人先写）→ EditConflictError；写后回执新戳
 *
 * @throws EditConflictError TOCTOU 冲突（CAS 戳不符）
 * @throws Error 未命中 / 多处命中（未开 all）/ 远端层无 stat 能力
 */
export async function editFile(
    drv: RuntimeDriver,
    path: string,
    oldStr: string,
    newStr: string,
    opts: EditFileOptions = {},
): Promise<EditFileResult> {
    const sr = await readStamped(drv, path);
    const occurrences = sr.content0.split(oldStr).length - 1;
    if (occurrences === 0) {
        // 安全红线：oldStr 可能含敏感信息（token/密码）——错误信息不嵌入原文，只给长度与行数线索
        throw new Error(`未命中待替换片段（0 处）: ${path}（oldStr 长度 ${oldStr.length}，文件 ${sr.content0.length} 字符）。`
            + `提示：若 old 含引号/多行/缩进——行内 argv 可能被宿主 Shell 剥引号或截断，改用免 Shell 载荷通道（CLI: edit <path> --stdin-json 或 --request-file <file>；SDK: editFile 直传字符串）后重试`);
    }
    if (occurrences > 1 && !opts.all) {
        throw new Error(`多处命中（${occurrences} 处）——精确替换语义拒绝；确认全替换请传 { all: true }: ${path}`);
    }
    // 字面替换语义（GPT Astra #5）：String.replace 的 replacement 含 $&/$$ 等替换
    // 语法会被 V8 解释（实测 old→"$&-new" 写成 "old-new"）——回调返回值按字面处理
    const edited = opts.all ? sr.content0.split(oldStr).join(newStr) : sr.content0.replace(oldStr, () => newStr);
    const w = await casWrite(drv, path, sr, edited, opts.writeMode === "inplace");
    return {
        path,
        occurrences,
        bytesBefore: sr.origin.size,
        bytesAfter: Buffer.byteLength(edited, "utf-8"),
        lockedAtMtimeMs: sr.origin.mtimeMs,
        mutex: w.mutex,
        writeMode: w.writeMode,
    };
}

/**
 * 多 hunk 原子编辑（第十一季批量组合积木）：同文件多替换对——读+戳一次、
 * 全部 hunk 本地顺序应用（任一未命中/未 all 多命中 → **整批拒绝不写**）、
 * CAS 一次写回（所有 hunk 原子生效——中途状态不可能被观察到）。
 */
export async function editFileMulti(
    drv: RuntimeDriver,
    path: string,
    hunks: Array<{ old: string; new: string; all?: boolean }>,
    opts: Pick<EditFileOptions, "writeMode"> = {},
): Promise<EditFileMultiResult> {
    if (hunks.length === 0) throw new Error(`editFileMulti 需至少一个 hunk: ${path}`);
    const sr = await readStamped(drv, path);
    let content = sr.content0;
    const applied: EditMultiHunk[] = [];
    for (const [i, h] of hunks.entries()) {
        const n = content.split(h.old).length - 1;
        if (n === 0) {
            throw new Error(`hunk #${i} 未命中（0 处，整批拒绝未写入）: ${path}（oldStr 长度 ${h.old.length}，当前内容 ${content.length} 字符——先前 hunk 已应用后的内容）`);
        }
        if (n > 1 && !h.all) {
            throw new Error(`hunk #${i} 多处命中（${n} 处，整批拒绝未写入）——确认全替换请传 all: true: ${path}`);
        }
        content = h.all ? content.split(h.old).join(h.new) : content.replace(h.old, () => h.new); // 回调=字面替换（$ 语义免疫）
        applied.push({ old: h.old, new: h.new, occurrences: n });
    }
    const w = await casWrite(drv, path, sr, content, opts.writeMode === "inplace");
    return {
        path,
        occurrences: applied.reduce((s, h) => s + h.occurrences, 0),
        bytesBefore: sr.origin.size,
        bytesAfter: Buffer.byteLength(content, "utf-8"),
        lockedAtMtimeMs: sr.origin.mtimeMs,
        hunks: applied,
        mutex: w.mutex, // 保护等级贯穿（Astra 五轮 P2）：multi 路径不丢弃 casWrite 标注
        writeMode: w.writeMode, // 写入形态贯穿（bind mount 降级知情）
    };
}

// ── 内部：读戳与 CAS 写回（editFile / editFileMulti 共用） ──

interface StampedRead {
    qp: string;
    statStamp: string;
    shaStamp: string;
    dec: string;
    origin: { mtimeMs: number; size: number };
    content0: string;
}

/** 读+戳+方言探测 合成一次往返（读时戳与读到的内容同窗——读后他人写 → CAS 必不符）。
 *  编码 base64 < file（stdin 全方言通吃，折行由解析侧 \s+ 归一消化）；解码探测
 *  printf | base64 -d：GNU/busybox 出 filaxis → -d，BSD → -D（行为判定）。 */
async function readStamped(drv: RuntimeDriver, path: string): Promise<StampedRead> {
    // NAME_MAX 安全基底（Hydrogen R5 #5）：.fx-tmp/.fx-lock 后缀拼接近上限 basename
    // 会 ENAMETOOLONG——接近上限截前段+短 hash（文件本体走目标原路径不受影响）
    const fxBase = (() => {
        const slash = path.lastIndexOf("/");
        const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
        const name = slash >= 0 ? path.slice(slash + 1) : path;
        if (name.length + ".filaxis-lock-xxxxxxxx".length <= 255) return path;
        const h = Math.random().toString(16).slice(2, 10);
        return dir + name.slice(0, Math.max(1, 255 - 32)) + "~" + h;
    })();
    // 读原文件用**原路径**（Sol 57 P2-5）：fxBase 是缩短名——曾拿缩短路径去读/戳
    // 原文件（240 字符合法文件名报不存在）。fxBase 只服务 .fx-tmp/.fx-lock 同目录
    // 伴生文件的 NAME_MAX 安全
    const qpRead = q(path);
    const readCmd =
        `${statCmdOf(qpRead)}; ${shaCmdOf(qpRead)}; echo __FXS__; ` +
        `printf ZmlsYXhpcw== | base64 -d 2>/dev/null; echo __FXD__; base64 < ${qpRead} 2>/dev/null`;
    const r = await drv.exec(readCmd, { timeoutMs: 30_000 });
    const [stampPart, restPart] = (r.stdout || "").split("__FXS__");
    const originStampRaw = (stampPart ?? "").trim();
    const originLines = originStampRaw.split(/\n/);
    const statStamp = (originLines[0] ?? "").trim();
    const shaStamp = (originLines[1] ?? "").trim();
    if (!shellSafe(statStamp) || !shellSafe(shaStamp)) {
        throw new Error(`远端戳异常（stat/sha256 输出非单行）: ${path}`);
    }
    const originParts = statStamp.split(/\s+/);
    const origin = {
        mtimeMs: parseInt(originParts[0] ?? "0", 10) * 1000,
        size: parseInt(originParts[1] ?? "0", 10),
    };
    if (!shaStamp) throw new Error(`文件不存在或指纹异常: ${path}（${originStampRaw}）`); // 空文件合法（size=0 有有效 sha）——仅指纹缺失才拒
    const [decPart, b64Part = ""] = (restPart ?? "").split("__FXD__");
    const dec = (decPart ?? "").trim() === "filaxis" ? "base64 -d" : "base64 -D";
    const raw = Buffer.from(b64Part.replace(/\s+/g, ""), "base64");
    const content0 = raw.toString("utf-8");
    // 有损转换拒绝（审计 H4）：toString("utf-8") 对非 UTF-8 字节（GBK/Latin-1/二进制）
    // 产生 U+FFFD 且**不可逆**——替换后写回会把未触碰的区域永久损坏，CAS 仍放行。
    // 往返回验：解码再编码不等于原文 = 含不可表示字节 → 显式拒绝（本模块契约：仅 UTF-8）
    if (!Buffer.from(content0, "utf-8").equals(raw)) {
        throw new Error(
            `目标文件含非 UTF-8 字节（受控编辑契约=仅 UTF-8 文本；GBK/Latin-1/二进制文件的 toString("utf-8") 会产生不可逆 U+FFFD，静默写回=永久损坏未触碰区域）: ${path}`,
        );
    }
    const qp = q(fxBase); // tmp/lock 伴生文件锚（NAME_MAX 安全形态）
    return { qp, statStamp, shaStamp, dec, origin, content0 }; // qp=fxBase 引用（tmp/lock 用）；读原文件已改走 qpRead（Sol 57 P2-5）
}

/** CAS 原子写回（戳比对 + tmp 写 + mv + 新戳回执——远端一条命令原子完成） */
async function casWrite(
    drv: RuntimeDriver,
    path: string,
    sr: StampedRead,
    edited: string,
    forceInplace = false,
): Promise<{ bytesAfter: number; mutex: "flock" | "degraded"; writeMode: "atomic-replace" | "inplace-write" }> {
    const newB64 = Buffer.from(edited, "utf-8").toString("base64");
    if (newB64.length > 90_000) {
        // 大文件回落 fs 层旧路径。门槛 90KB（MAX_ARG_STRLEN 单参数 128KB 安全线内留余量
        // ——30KB 旧值过保守，绝大多数文件因此被拒之 CAS 原子门外）。
        // 回退核验（GPT Astra 二轮 #1）：**stat+sha 双比**（同秒等长修改 stat 戳不变仍会
        // 覆盖他人——内容指纹封死该盲区）；写后回验 sha 自证写入正确。
        // 残余窗口（核验→写入之间）fs 层无原子 CAS 可用，如实声明：>90KB 文件的受控编辑
        // 存在毫秒级核验-写入窗口，并发写场景请消费方自管锁。
        const verify = await drv.exec(
            `${statCmdOf(sr.qp)}; ${shaCmdOf(sr.qp)}`, { timeoutMs: 30_000 },
        );
        const vLines = (verify.stdout || "").trim().split(/\n/);
        if ((vLines[0] ?? "").trim() !== sr.statStamp || (vLines[1] ?? "").trim() !== sr.shaStamp) {
            throw new EditConflictError(
                `TOCTOU 冲突（大文件回退前核验）：读时 stat ${sr.statStamp} sha ${sr.shaStamp}，` +
                `回退时 stat ${(vLines[0] ?? "?").trim()} sha ${(vLines[1] ?? "?").trim()}: ${path}`,
            );
        }
        await editFileViaFs(drv, path, edited, 1);
        // 写后回验：内容指纹确认写入结果（被并发覆盖或写坏立即暴露）
        const post = await drv.exec(shaCmdOf(sr.qp), { timeoutMs: 30_000 });
        const expectSha = shaCmdOfContent(edited);
        if ((post.stdout || "").trim() !== expectSha) {
            throw new EditConflictError(
                `TOCTOU 冲突（大文件写后回验）：期望 sha ${expectSha}，实际 ${(post.stdout || "").trim()}（写入后被并发修改）: ${path}`,
            );
        }
        // fs 回退双降级诚实标注：无锁（mutex degraded）+ 非原子（fs.writeFile 本质
        // 重定向截断写——bind mount 场景能用的正是它，但从未声明过非原子）
        return { bytesAfter: Buffer.byteLength(edited, "utf-8"), mutex: "degraded" as const, writeMode: "inplace-write" as const };
    }
    // flock 互斥（GPT Astra 三轮 #2 / 四轮 #2）：同一条 shell 命令≠原子——核验 $(stat)/$(sha)
    // 与写入 mv 之间有调度间隙，并发编辑可互相覆盖且双方报成功。fd 锁全程持锁封死。
    // **能力缺失与加锁失败分治**：flock 命令缺席（BSD/OPNsense 无该 CLI）= 无锁降级
    // （输出 FX_DEGRADED_NO_LOCK 标记——结果 mutex:"degraded" 让调用方明确保护等级）；
    // flock 在场但加锁失败 = FX_LOCK_FAIL 拒写（互斥保证失效时不冒进静默继续）。
    // **落位降级（bind mount 深水区定案）**：单文件 bind mount 挂载点 mv → EBUSY/EXDEV
    // 不可替换——同一条命令内自动降级 cat（保留 inode，绕过挂载点限制），FX_INPLACE
    // 显式报告（写入形态与 CAS 校验正交：降级非原子，消费方须知中断可暴露半截）。
    const stampOf = `stat -c '%Y %s' "$__fx_tgt" 2>/dev/null || stat -f '%m %z' "$__fx_tgt" 2>/dev/null`;
    // symlink 追踪 + 属性保持（审计 H5）：readlink -f 解析真身（mv 对链接路径=替换
    // 链接本身，破坏 sites-enabled 类拓扑）；chmod/chown --reference 把目标属性
    // （0600 私钥/0400 证书/属主）同步到 tmp——best-effort（无权限/不支持则跳过，
    // mv 不因属性同步失败而中止）。
    // 失败三态（Astra 十八轮 #2 同款）：inplace 中断=目标可能已被部分改写（绝谎称
    // 未动），tmp 载荷保留供核实/重试
    const tgtSetup = `__fx_tgt=$(readlink -f ${sr.qp} 2>/dev/null || echo ${sr.qp}); ` +
        // 数字模式权限保持（Hydrogen R8 #2）：chmod/chown --reference 仅 GNU——macOS/
        // FreeBSD/busybox 不认，mv 后目标静默回退 umask 默认（0600 私钥→0644 可读）。
        // stat -c 读八进制权限（GNU）→ chmod NNN 数字模式全平台通吃；stat 缺席 best-effort
        `__fx_pm=$(stat -c '%a' "$__fx_tgt" 2>/dev/null); [ -n "$__fx_pm" ] && chmod "$__fx_pm" ${sr.qp}.fx-tmp 2>/dev/null; ` +
        `chown --reference="$__fx_tgt" ${sr.qp}.fx-tmp 2>/dev/null || true; `;
    const place = forceInplace
        ? `if cat ${sr.qp}.fx-tmp > "$__fx_tgt" && rm -f ${sr.qp}.fx-tmp && echo "FX_INPLACE $(${stampOf})"; then :; else echo FX_INPLACE_FAIL; fi`
        : `if mv ${sr.qp}.fx-tmp "$__fx_tgt" 2>/dev/null; then echo "FX_OK $(${stampOf})"; ` +
          `else if cat ${sr.qp}.fx-tmp > "$__fx_tgt" && rm -f ${sr.qp}.fx-tmp && echo "FX_INPLACE $(${stampOf})"; then :; else echo FX_INPLACE_FAIL; fi; fi`;
    const cmd =
        `( if command -v flock >/dev/null 2>&1; then flock -x 9 || { echo FX_LOCK_FAIL; exit 1; }; ` +
        `else echo FX_DEGRADED_NO_LOCK; fi; ` +
        `if [ "$(${statCmdOf(sr.qp)})" = "${sr.statStamp}" ] && ` +
        `[ "$(${shaCmdOf(sr.qp)})" = "${sr.shaStamp}" ]; then ` +
        `printf %s ${q(newB64)} | ${sr.dec} > ${sr.qp}.fx-tmp && { ${tgtSetup}${place}; }; ` +
        `else echo FX_CAS_FAIL; fi ) 9>${sr.qp}.fx-lock`;
    const cas = await drv.exec(cmd, { timeoutMs: 30_000 });
    const out = (cas.stdout || "").trim();
    if (out.startsWith("FX_LOCK_FAIL")) {
        throw new Error(`互斥锁获取失败（flock 在场但加锁失败）——拒绝写入: ${path}`);
    }
    const degraded = out.startsWith("FX_DEGRADED_NO_LOCK");
    const payload = degraded ? out.slice("FX_DEGRADED_NO_LOCK".length).trim() : out;
    if (payload.startsWith("FX_CAS_FAIL")) {
        throw new EditConflictError(
            `TOCTOU 冲突：CAS 戳不符（他人先写）: ${path}（读时 stat ${sr.statStamp} sha ${sr.shaStamp}）`,
        );
    }
    if (payload.startsWith("FX_INPLACE_FAIL")) { // 须在 FX_INPLACE 前判定（FAIL 是其前缀延伸）
        throw new Error(
            `CAS 写回失败（inplace 写入中断——目标 ${path} **可能已被部分改写**，请核实内容；完整载荷保留在 ${path}.fx-tmp 可重试）`,
        );
    }
    if (payload.startsWith("FX_INPLACE")) {
        return { bytesAfter: Buffer.byteLength(edited, "utf-8"), mutex: degraded ? ("degraded" as const) : ("flock" as const), writeMode: "inplace-write" as const };
    }
    if (!payload.startsWith("FX_OK")) {
        throw new Error(`远端 CAS 写回异常: ${path}（输出 ${out.slice(0, 80)}）`);
    }
    return { bytesAfter: Buffer.byteLength(edited, "utf-8"), mutex: degraded ? ("degraded" as const) : ("flock" as const), writeMode: "atomic-replace" as const };
}

/** 大文件回落路径（fs 层 5 次往返——语义同 CAS：精确替换+TOCTOU+base64 写回） */
async function editFileViaFs(
    drv: RuntimeDriver,
    path: string,
    edited: string,
    occurrences: number,
): Promise<EditFileResult> {
    if (!drv.fs.stat) {
        throw new Error(`该层不支持受控编辑（fs.stat 缺席——TOCTOU 锁依赖）: ${path}`);
    }
    const before = await drv.fs.stat(path);
    if (!before) throw new Error(`文件不存在: ${path}`);
    const lockCheck = await drv.fs.stat(path);
    if (!lockCheck || lockCheck.mtimeMs !== before.mtimeMs || lockCheck.size !== before.size) {
        throw new EditConflictError(
            `TOCTOU 冲突：读取后文件已被他人修改（mtime ${before.mtimeMs}→${lockCheck?.mtimeMs}）: ${path}`,
        );
    }
    await drv.fs.writeFile(path, edited);
    const after = await drv.fs.stat(path);
    if (after && before.mtimeMs === after.mtimeMs && before.size === after.size) {
        if (Buffer.byteLength(edited, "utf-8") !== after.size) { // 字节口径（原 UTF-16 码元数与远端字节数必不等——含非 ASCII 时误报）
            throw new Error(`写后回读异常（size 未随写入变化）: ${path}`);
        }
    }
    return {
        path, occurrences, bytesBefore: before.size, bytesAfter: Buffer.byteLength(edited, "utf-8"), lockedAtMtimeMs: before.mtimeMs,
        writeMode: "inplace-write" as const, // fs.writeFile 本质重定向写——非原子显式声明
    };
}
