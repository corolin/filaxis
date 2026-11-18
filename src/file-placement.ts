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
