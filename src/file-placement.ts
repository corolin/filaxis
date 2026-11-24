/** Open the payload before truncating the target. The outer condition tests only
 * whether the payload could be opened. A failed copy may have changed the target
 * even if the payload's pathname disappears while its descriptor is open. */
export function renderInplaceWrite(source: string, target: string, success: string): string {
    return `if { if cat > ${target} && rm -f ${source}; then ${success}; ` +
        `elif [ -f ${source} ]; then echo FX_INPLACE_FAIL; ` +
        `else echo FX_INPLACE_PAYLOAD_MISSING; fi; } < ${source}; ` +
        `then :; else echo FX_NO_PAYLOAD; fi`;
}

/** Keep the destination ownership and mode when replacing its inode. */
export function renderPreserveMode(source: string): string {
    return `[ -f ${source} ] || { echo FX_NO_PAYLOAD; exit 1; }; ` +
        `if [ -e "$__fx_tgt" ] && [ ! -d "$__fx_tgt" ]; then ` +
        `__fx_pm=$(stat -c '%a' "$__fx_tgt" 2>/dev/null || stat -f '%OLp' "$__fx_tgt" 2>/dev/null); ` +
        `case "$__fx_pm" in ''|*[!0-7]*) echo FX_PERMISSIONS_FAIL; exit 1;; esac; ` +
        `__fx_owner=$(stat -c '%u:%g' "$__fx_tgt" 2>/dev/null || stat -f '%u:%g' "$__fx_tgt" 2>/dev/null); ` +
        `case "$__fx_owner" in *[!0-9:]*|:*|*:|*:*:*) echo FX_PERMISSIONS_FAIL; exit 1;; ` +
        `*:*) ;; *) echo FX_PERMISSIONS_FAIL; exit 1;; esac; ` +
        `__fx_stage_owner=$(stat -c '%u:%g' ${source} 2>/dev/null || stat -f '%u:%g' ${source} 2>/dev/null); ` +
        `if [ "$__fx_stage_owner" != "$__fx_owner" ] && ! chown "$__fx_owner" ${source} 2>/dev/null; then echo FX_PERMISSIONS_FAIL; exit 1; fi; ` +
        `chmod "$__fx_pm" ${source} 2>/dev/null || { echo FX_PERMISSIONS_FAIL; exit 1; }; fi; `;
}

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function throwRemoteFsCmdError(
    op: string,
    target: string,
    r: { exitCode: number; stdout?: string; stderr?: string },
): never {
    const detail = (r.stderr || r.stdout || "").trim();
    const err = new Error(`${op} 失败（exit=${r.exitCode}）: ${target}${detail ? `: ${detail}` : ""}`);
    if (r.exitCode >= 129) {
        Object.assign(err, { outcome: "unknown" as const });
    }
    throw err;
}

/** Pure POSIX sh accident guardrails for recursive rm (workspace/root/trailing-slash checks, zero Python dependency). */
export function buildPosixRmGuardCmd(p: string, options?: { force?: boolean }): string {
    const stripped = p.replace(/\/+$/, "");
    const trailingSlash = /\/$/.test(p);
    const force = Boolean(options?.force);
    const fFlag = force ? "1" : "0";
    const tFlag = trailingSlash ? "1" : "0";
    return `( unset CDPATH; __fx_s=${q(stripped)}; ` +
        `__fx_cwd=$(pwd -P && printf .) || exit 1; __fx_cwd=\${__fx_cwd%??}; ` +
        `__fx_d=$(dirname -- "$__fx_s" && printf .) || exit 1; __fx_d=\${__fx_d%??}; ` +
        `__fx_b=$(basename -- "$__fx_s" && printf .) || exit 1; __fx_b=\${__fx_b%??}; ` +
        `if [ -z "$__fx_b" ] || [ "$__fx_b" = "." ] || [ "$__fx_b" = ".." ] || [ "$__fx_b" = "/" ]; then ` +
        `echo "rm 拒绝危险或无效路径" >&2; exit 1; fi; ` +
        `case "$__fx_d" in /*) ;; *) __fx_d="./$__fx_d" ;; esac; ` +
        `if ! __fx_pdir=$(cd -P -- "$__fx_d" >/dev/null 2>&1 && pwd -P && printf .); then ` +
        `if [ ${fFlag} = 1 ] && [ ! -e "$__fx_s" ] && [ ! -L "$__fx_s" ]; then exit 0; fi; ` +
        `echo "rm 路径不存在或父目录不可达" >&2; exit 1; fi; ` +
        `__fx_pdir=\${__fx_pdir%??}; ` +
        `__fx_t="\${__fx_pdir%/}/$__fx_b"; ` +
        `if [ ! -e "$__fx_t" ] && [ ! -L "$__fx_t" ]; then ` +
        `if [ ${fFlag} = 1 ]; then exit 0; fi; ` +
        `echo "rm 路径不存在" >&2; exit 1; fi; ` +
        `if [ ${tFlag} = 1 ] && { [ -L "$__fx_t" ] || [ ! -d "$__fx_t" ]; }; then ` +
        `echo "rm 目标不是真实目录（拒绝带尾斜杠的符号链接或文件）" >&2; exit 1; fi; ` +
        `if [ -d "$__fx_t" ] && [ ! -L "$__fx_t" ]; then ` +
        `__fx_real=$(cd -P -- "$__fx_t" >/dev/null 2>&1 && pwd -P && printf .) || { echo "rm 无法解析目标真实路径" >&2; exit 1; }; ` +
        `__fx_real=\${__fx_real%??}; ` +
        `if [ ${tFlag} = 1 ] && [ "$__fx_real" != "$__fx_t" ]; then ` +
        `echo "rm 目标不是真实目录（拒绝带尾斜杠的符号链接或文件）" >&2; exit 1; fi; ` +
        `if [ "$__fx_real" = "/" ] || [ "$__fx_real" = "$__fx_cwd" ]; then ` +
        `echo "rm 拒绝删除当前工作目录或上级目录" >&2; exit 1; fi; ` +
        `case "$__fx_cwd" in "$__fx_real"/*) echo "rm 拒绝删除当前工作目录或上级目录" >&2; exit 1 ;; esac; ` +
        `fi; ` +
        `rm -r ${force ? "-f " : ""}-- "$__fx_t" )`;
}

/** Pure POSIX sh accident guardrails for rename/move (existing-dir/xdev/self-subdir checks, zero Python dependency). */
export function buildPosixRenameCmd(from: string, to: string): string {
    return `( unset CDPATH; __fx_from=${q(from)}; __fx_to=${q(to)}; ` +
        `if [ ! -e "$__fx_from" ] && [ ! -L "$__fx_from" ]; then echo "源路径不存在" >&2; exit 1; fi; ` +
        `__fx_sd=$(dirname -- "$__fx_from" && printf .) || exit 1; __fx_sd=\${__fx_sd%??}; ` +
        `__fx_sb=$(basename -- "$__fx_from" && printf .) || exit 1; __fx_sb=\${__fx_sb%??}; ` +
        `case "$__fx_sd" in /*) ;; *) __fx_sd="./$__fx_sd" ;; esac; ` +
        `__fx_sdir=$(cd -P -- "$__fx_sd" >/dev/null 2>&1 && pwd -P && printf .) || { echo "源父目录不存在" >&2; exit 1; }; __fx_sdir=\${__fx_sdir%??}; ` +
        `__fx_td=$(dirname -- "$__fx_to" && printf .) || exit 1; __fx_td=\${__fx_td%??}; ` +
        `__fx_tb=$(basename -- "$__fx_to" && printf .) || exit 1; __fx_tb=\${__fx_tb%??}; ` +
        `case "$__fx_td" in /*) ;; *) __fx_td="./$__fx_td" ;; esac; ` +
        `__fx_tdir=$(cd -P -- "$__fx_td" >/dev/null 2>&1 && pwd -P && printf .) || { echo "目标父目录不存在" >&2; exit 1; }; __fx_tdir=\${__fx_tdir%??}; ` +
        `__fx_src="\${__fx_sdir%/}/$__fx_sb"; __fx_dst="\${__fx_tdir%/}/$__fx_tb"; ` +
        `if [ ! -e "$__fx_src" ] && [ ! -L "$__fx_src" ]; then echo "源路径不存在" >&2; exit 1; fi; ` +
        `if [ -d "$__fx_dst" ]; then echo "目标是现存目录" >&2; exit 1; fi; ` +
        `if [ -d "$__fx_src" ] && [ ! -L "$__fx_src" ]; then ` +
        `if [ -e "$__fx_dst" ] || [ -L "$__fx_dst" ]; then echo "目标已存在，拒绝覆盖" >&2; exit 1; fi; ` +
        `__fx_sreal=$(cd -P -- "$__fx_src" >/dev/null 2>&1 && pwd -P && printf .) || exit 1; __fx_sreal=\${__fx_sreal%??}; ` +
        `if [ "$__fx_tdir" = "$__fx_sreal" ]; then echo "不能将目录移入自身或子目录（EINVAL）" >&2; exit 1; fi; ` +
        `case "$__fx_tdir" in "$__fx_sreal"/*) echo "不能将目录移入自身或子目录（EINVAL）" >&2; exit 1 ;; esac; ` +
        `__fx_sdev=$(stat -c '%d' "$__fx_src" 2>/dev/null || stat -f '%d' "$__fx_src" 2>/dev/null) || __fx_sdev=; ` +
        `__fx_tdev=$(stat -Lc '%d' "$__fx_tdir" 2>/dev/null || stat -Lf '%d' "$__fx_tdir" 2>/dev/null) || __fx_tdev=; ` +
        `if [ -z "$__fx_sdev" ] || [ -z "$__fx_tdev" ]; then echo "无法核实文件系统设备号，拒绝目录移动" >&2; exit 1; fi; ` +
        `if [ "$__fx_sdev" != "$__fx_tdev" ]; then echo "不支持跨文件系统移动（EXDEV）" >&2; exit 1; fi; ` +
        `fi; ` +
        `mv -- "$__fx_src" "$__fx_dst" )`;
}
