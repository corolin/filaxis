# Sol 57 P1-2 + P2 批 A（文件投递）
import io, re

p = "src/remote-session-manager.ts"
s = io.open(p, encoding="utf-8").read()

# stop 与 verify 两处 .code 读：exitCode!=0 不采信（失败命令输出不可作死亡凭证）
old_a = """            const code = await this.exec(`cat ${q(e.base)}.code 2>/dev/null || true`);
            const codeStr = (code.stdout || "").trim();
            if (codeStr !== "" && /^\\d+$/.test(codeStr)) {"""
cnt = s.count(old_a)
assert cnt >= 2, f"code reads: {cnt}"
new_a = """            const code = await this.exec(`cat ${q(e.base)}.code 2>/dev/null || true`);
            // 命令失败不采信输出（Sol 57 P1-2）：cat exit 1+stdout '0' 曾直接
            // exited(0)——失败命令的输出不是死亡凭证（通道失灵归 unknown 路径）
            const codeStr = code.exitCode === 0 ? (code.stdout || "").trim() : "";
            if (codeStr !== "" && /^\\d+$/.test(codeStr)) {"""
s = s.replace(old_a, new_a)

# verify 的 kill-0 探测：exit!=0 不判 running
old_b = """            const alive = await this.exec(`kill -0 ${e.pid} 2>/dev/null && echo Y || echo N`);
            return alive.stdout.includes("Y") ? { status: "running" } : { status: "unknown" }; // 死了但无 .code=死因不明"""
assert old_b in s, "verify alive"
new_b = """            const alive = await this.exec(`kill -0 ${e.pid} 2>/dev/null && echo Y || echo N`);
            if (alive.exitCode !== 0) return { status: "unknown" }; // 探测命令失败不判 running（Sol 57 P1-2）
            return alive.stdout.includes("Y") ? { status: "running" } : { status: "unknown" }; // 死了但无 .code=死因不明"""
s = s.replace(old_b, new_b)

# ── P2-2: env:{} 空 join 修 ──
old_c = """        const envPrefix = opts.env
            ? Object.entries(opts.env).map(([k, v]) => {
                if (!ENV_NAME_RE.test(k)) throw new Error(`非法环境变量名（会话启动拒绝）: ${k}`);
                return `export ${k}=${q(v)}`; // export 形态（Sol 55 P2-D）：裸赋值前缀 VAR=v cmd 只作用 cmd——子 shell 后续命令丢变量
            }).join("; ") + "; " // 分号分隔（Sol 56 P2-1）：曾空格连接 export K=v cmd——export 吞 cmd 当变量名参数
            : "";"""
assert old_c in s, "env join"
new_c = """        // 空 env:{ } 零前缀（Sol 57 P2-2）：Object.entries({}).join("; ")+"; " 曾产孤立
        // 分号——真实 shell 启动握手超时。length 判空取代对象 truthiness
        const envPrefix = opts.env && Object.keys(opts.env).length > 0
            ? Object.entries(opts.env).map(([k, v]) => {
                if (!ENV_NAME_RE.test(k)) throw new Error(`非法环境变量名（会话启动拒绝）: ${k}`);
                return `export ${k}=${q(v)}`; // export 形态（Sol 55 P2-D）：裸赋值前缀只作用首命令
            }).join("; ") + "; " // 分号分隔（Sol 56 P2-1）：曾空格连接 export 吞 cmd
            : "";"""
s = s.replace(old_c, new_c)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("remote OK")

# tmux 同款 env:{} 修
p = "src/tmux-driver.ts"
s = io.open(p, encoding="utf-8").read()
old_d = """        const envPrefix = opts?.env
            ? Object.entries(opts.env).map(([k, v]) => {
                if (!ENV_NAME_RE.test(k)) throw new Error(`非法环境变量名（会话启动拒绝）: ${k}`);
                return `export ${k}=${q(v)}`; // export 形态（Sol 55 P2-D 同 remote）"""
assert old_d in s, "tmux env"
new_d = """        // 空 env:{} 零前缀（Sol 57 P2-2 同 remote——孤立分号握手超时）
        const envPrefix = opts?.env && Object.keys(opts.env).length > 0
            ? Object.entries(opts.env).map(([k, v]) => {
                if (!ENV_NAME_RE.test(k)) throw new Error(`非法环境变量名（会话启动拒绝）: ${k}`);
                return `export ${k}=${q(v)}`; // export 形态（Sol 55 P2-D 同 remote）"""
s = s.replace(old_d, new_d)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("tmux env OK")
