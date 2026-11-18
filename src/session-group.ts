const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const activeMember = '$2 == g && $3 !~ /^[ZX]/';
const listProcesses = "ps -ax -o pid= -o pgid= -o stat=";

/** The private group leader stays available for identity checks until its members exit. */
export function renderSessionWorker(base: string, command: string): string {
    const session = quote(base);
    return `__fx_group=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' \\n'); ` +
        `__fx_terminated=0; if [ "$__fx_group" = "$$" ]; then trap '__fx_terminated=1' TERM; fi; ` +
        `printf '%s\\n' "$__fx_group" > ${session}.pgid && ` +
        `printf '%s\\n' "$$" > ${session}.pid.tmp && mv ${session}.pid.tmp ${session}.pid || exit 1; ` +
        `(\n${command}\n); __fx_code=$?; ` +
        `if [ "$__fx_group" = "$$" ]; then ` +
        `while :; do ` +
        // Exclude the shell and the process taking the snapshot from the members it lists.
        `${listProcesses} > ${session}.members 2>/dev/null & __fx_probe=$!; ` +
        `if wait "$__fx_probe" && ` +
        `awk -v g="$$" -v probe="$__fx_probe" '${activeMember} && $1 != g && $1 != probe { live=1 } END { exit live }' ${session}.members; then break; fi; ` +
        `sleep 0.2; done; rm -f ${session}.members; fi; ` +
        `if [ "$__fx_terminated" = 1 ] && [ "$__fx_code" -ge 128 ]; then exit 0; fi; ` +
        `printf '%s\\n' "$__fx_code" > ${session}.code.tmp && mv ${session}.code.tmp ${session}.code`;
}

/** A legacy .code can predate the exit of the remaining group members. */
export function renderSessionCodeGuard(base: string): string {
    const session = quote(base);
    return `p=$(cat ${session}.pid 2>/dev/null); g=$(cat ${session}.pgid 2>/dev/null); ` +
        `if [ -n "$g" ] && [ "$g" = "$p" ]; then ` +
        `members=$(${listProcesses}) || exit 1; ` +
        `printf '%s\\n' "$members" | awk -v g="$g" '${activeMember} && $1 != g { live=1 } END { exit live }' || exit 1; fi; `;
}

/** Check even groups whose only remaining members are unreaped zombies. */
export function renderSessionGroupState(alive: "ALIVE" | "RUNNING"): string {
    return `members=$(${listProcesses}) || exit 1; ` +
        `printf '%s\\n' "$members" | awk -v g="$g" '${activeMember} { live=1 } END { print (live ? "${alive}" : "DEAD") }'`;
}
