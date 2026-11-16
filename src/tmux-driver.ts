/**
 * tmux-driver.ts — 持久会话 Transport 适配层
 * （净室平移自 个人Agent项目 tmux-driver.ts）
 *
 * OSS 化：剥 RuntimeProcessManager/RemoteSessionManager/TmuxFileSystem——
 * fs 经 runCommand base64（方言适配接线 M2 批）；远端会话族沿用本文件
 * nohup 会话语义（经 TerminalManager 会话 shell 执行）。
 * terminalId 绑定 + cwd 恢复 + destroy 时 nohup 后台进程显式清理。
 */
import * as crypto from "node:crypto";
import type {
    RuntimeDriver, FileSystemDriver, FileEntry, ExecOptions, ExecResult, RuntimeDescriptor,
} from "./driver.js";
import { TerminalManager } from "./terminal-manager.js";
import { TmuxInvoker } from "./terminal/tmux-invoker.js";
import { ENV_NAME_RE, cdTargetArg } from "./ssh-helpers.js";
import { sanitizeSessionName } from "./session-buffer.js";
import { probeDialect, type RemoteDialect } from "./dialect.js";
import type {
    SessionStartOptions, SessionHandleInfo, WatchOptions, ReadLogOptions,
} from "./session-types.js";
import { noopLogger, type FilaxisLogger } from "./logger.js";

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export interface TmuxDriverOptions {
    terminalManager?: TerminalManager;
    logger?: FilaxisLogger;
}

/** 同 terminalId 的在册 driver 数（Sol 76 P2-1）：不同 cwd/描述符的重挂会各建
 *  driver 实例但**共指同一 tmux 会话**——任一 destroy 曾直接杀会话连坐其余层。
 *  模块级计数：归零才真 destroySession（driver 实例各自独立，会话是共享物） */
const sessionAttachRefs = new Map<string, number>();
/** 同 tid 各在册实例声明的 cwd 计数（Sol 77 P1-1 → Sol 78 P1-4 计数化）：
 *  重挂不同 cwd 的冲突守卫依据。Set 形态曾在一个同 cwd 驱动销毁时把条目删光
 *  ——另一驱动还在用，守卫失效（不同 cwd 重挂被放行，共享 shell 的 pwd 被改） */
const sessionCwds = new Map<string, Map<string, number>>();
/** 正在执行 destroySession 的 tid（Sol 78 #5）：销毁在途时重挂曾拿到
 *  has-session 尚可通过的将死会话——恢复清理后新句柄随即失效 */
const sessionDestroying = new Set<string>();
/** 首挂目录验证在途的 tid（Sol 82 P1-1）：同 cwd 并发首挂——占位≠已恢复，
 *  验证结论未出不放行后续 attach */
const cwdValidating = new Set<string>();

export class TmuxSessionDriver implements RuntimeDriver {
    descriptor: RuntimeDescriptor;
    fs: FileSystemDriver;
    readonly terminal: TerminalManager;
    private readonly log: FilaxisLogger;

    constructor(descriptor: RuntimeDescriptor, opts: TmuxDriverOptions = {}) {
        this.descriptor = descriptor;
        this.terminal = opts.terminalManager ?? new TerminalManager();
        this.log = opts.logger ?? noopLogger;
        const self = this;
        this.fs = {
            async readFile(p) {
                // 真机实证（远端 Linux）：pane capture 滚动窗口 ~500 行（capture_scrollback
                // 缺省），80KB b64 在 220 列 pane 折行 400+ 行——窗口外头部永久丢；且远端
                // 解码形态长行折行混入多余换行。读方向两段式：小文件单次 b64 读回（本地
                // \s+ 归一解码——折行免疫）；大文件 b64 落远端临时 + 字节分页读（每页
                // 8K b64 折 ~40 行稳居窗口内，与滚动窗口彻底解耦）
                const st = await self.exec(`wc -c < ${q(p)} 2>/dev/null`);
                // 凭证纪律（Sol 73 P1-2）：编码/wc 命令失败（exit≠0）不作内容凭证
                //——故障注入时 base64 失败曾静默返回空串
                if (st.exitCode !== 0) throw new Error(`readFile 失败（wc 退出码 ${st.exitCode}）: ${p}`);
                const size = parseInt((st.stdout || "").trim(), 10);
                if (!Number.isFinite(size)) throw new Error(`readFile 失败（文件不存在或不可读）: ${p}`);
                if (size * 2 <= 12_000) {
                    const r = await self.exec(`base64 ${q(p)}`);
                    if (r.exitCode !== 0) throw new Error(`readFile 失败（base64 退出码 ${r.exitCode}）: ${p}`);
                    return Buffer.from((r.stdout || "").replace(/\s+/g, ""), "base64").toString("utf-8");
                }
                const tmp = `/tmp/filaxis-read-${Math.random().toString(36).slice(2, 10)}.b64`;
                // && 连接 + 退出码查（Hydrogen R11 #1）：base64 失败（无权限/被删）曾仍
                // 创建空 tmp、wc -c 返 0 exit 0——readFile 静默返回空串而非报错
                const tot = await self.exec(`base64 ${q(p)} > ${q(tmp)} && wc -c < ${q(tmp)}`);
                const total = parseInt((tot.stdout || "").trim(), 10);
                // total 异常也走 finally 清理（曾在此 throw 遗留 tmp——throw 挪 try 内）
                try {
                    if (tot.exitCode !== 0 || !Number.isFinite(total)) {
                        throw new Error(`readFile 失败（base64 退出码 ${tot.exitCode}）: ${p}`);
                    }
                    let b64 = "";
                    for (let off = 1; off <= total; off += 8_000) {
                        const pg = await self.exec(`tail -c +${off} ${q(tmp)} | head -c 8000`);
                        // 分页凭证纪律（Sol 74 P1-2）：管道尾 rc 只反映 head——中转文件
                        // 被删/读取失败曾静默跳页，9KB 源文件返回 5.9KB 还正常完成。
                        // 逐页退出码入闸 + 末尾长度对账（解码字节 == wc 实测源大小）
                        if (pg.exitCode !== 0) {
                            throw new Error(`readFile 分页读失败（页偏移 ${off} 退出码 ${pg.exitCode}）: ${p}`);
                        }
                        b64 += (pg.stdout || "").replace(/\s+/g, "");
                    }
                    const content = Buffer.from(b64, "base64");
                    if (content.length !== size) {
                        throw new Error(
                            `readFile 长度对账失败（解码 ${content.length}B ≠ 源 ${size}B——分页途中丢页/截断）: ${p}`,
                        );
                    }
                    return content.toString("utf-8");
                } finally {
                    await self.exec(`rm -f ${q(tmp)}`).catch(() => undefined);
                }
            },
            async writeFile(p, content) {
                const buf = Buffer.from(content, "utf-8");
                const b64 = buf.toString("base64");
                // 小载荷单往返直写；大载荷走 putContent 分块链路（自排查 R5）。
                // 阈值与分块尺寸按真机实证收紧：tmux server 单条命令 ~16-24K 即
                // "command too long"（远端实测 16K OK / 24K FAIL）——12K 安全边距
                if (b64.length <= 12_000) {
                    const w = await self.exec(`printf %s ${q(b64)} | base64 -d > ${q(p)}`);
                    // 凭证纪律（Sol 73 P1-2）：重定向失败（目标为目录等）曾静默
                    // 返回成功——退出码入闸
                    if (w.exitCode !== 0) throw new Error(`writeFile 失败（重定向退出码 ${w.exitCode}）: ${p}`);
                    return;
                }
                const { putContent } = await import("./file-transfer.js");
                await putContent(
                    async (cmd) => self.exec(cmd),
                    await self.dialect(),
                    buf,
                    p,
                    { chunkB64: 12_000 },
                );
            },
            async exists(p) {
                const r = await self.exec(`test -e ${q(p)} && echo Y || echo N`);
                return r.stdout.trim() === "Y";
            },
            async stat(p) {
                const r = await self.exec(`stat -c '%s %Y' ${q(p)} 2>/dev/null || stat -f '%z %m' ${q(p)} 2>/dev/null || true`);
                const m = r.stdout.trim().match(/^(\d+)\s+(\d+)$/);
                return m ? { size: parseInt(m[1]!, 10), mtimeMs: parseInt(m[2]!, 10) * 1000 } : null;
            },
            async readdir(p): Promise<FileEntry[]> {
                // 逐名 hex 帧传输（Sol 89 P2-1）：PTY 里 ls 的**终端展示形态**对
                // 空格/换行/控制字符名加引号或转义、capture-pane 还按窗宽软折行
                //（100 字符名曾拆成两个条目）——ls 输出结构性不可信。改 od hex
                //（字符集 [0-9a-f]）+ `;` 帧分隔（不出现在 hex 中）；stdout 里的
                // 换行全是折行伪影——整体拼接后按分号切帧再解码。
                // **子 shell cd 进目标**（真机抓回首版 bug：glob 跑在会话 cwd——
                // 列出来的是别处）；**cd 锚定 cdTargetArg**（Sol 90 P2-2：相对路径
                // 裸交 cd 被 CDPATH 改写到另一棵树、命中还打印路径进 hex 流触发帧
                // 损坏）；**glob 用 `.* *` + case 排 . / ..**（Sol 90 P2-1：`.[!.]*`
                // 曾把 `..hidden` 这类「第二个字符是点」的合法名静默漏掉）；cd 失败
                // 零输出=空列表（旧 ls || true 同语义）
                const r = await self.exec(
                    `( cd ${q(cdTargetArg(p))} 2>/dev/null && for __fx_e in .* *; do case "$__fx_e" in .|..) continue;; esac; ` +
                    `[ -e "$__fx_e" ] || [ -L "$__fx_e" ] || continue; ` +
                    `printf %s "$__fx_e" | od -An -v -tx1 | tr -d ' \\n'; printf ';'; done )`,
                );
                const frames = r.stdout.replace(/[\r\n]+/g, "").split(";").filter(Boolean);
                const out: FileEntry[] = [];
                for (const h of frames) {
                    if (!/^[0-9a-f]+$/.test(h) || h.length % 2 !== 0) {
                        // 凭证纪律：帧损坏（非 od 产物）显式报错——不静默跳过/降级
                        throw new Error(`readdir hex 帧损坏（${h.slice(0, 20)}…）: ${p}`);
                    }
                    const name = Buffer.from(h, "hex").toString("utf-8");
                    const full = `${p.replace(/\/$/, "")}/${name}`;
                    const d = await self.exec(`test -d ${q(full)} && echo Y || echo N`);
                    const st = await (this as FileSystemDriver).stat!(full);
                    out.push({ name, isDirectory: d.stdout.trim() === "Y", size: st?.size, mtime: st?.mtimeMs });
                }
                return out;
            },
            // 退出码入闸（Sol 87 P2-7）：rm/mkdir 曾丢 exitCode——对普通文件 mkdir、
            // 无 force 删缺席路径都报正常完成。凭证纪律同 readFile/writeFile
            async rm(p, options) {
                const r = await self.exec(`rm ${options?.recursive ? "-r " : ""}${options?.force ? "-f " : ""}${q(p)}`);
                // force 只影响命令形态（-f 豁免缺席路径——exit 0）；非零退出=真实
                // 失败（目录未递归删等）照传（Sol 88 P2-1：曾 force 下吞掉一切非零
                //——对现存目录的非递归删除谎报完成、目录仍在）
                if (r.exitCode !== 0) throw new Error(`rm 失败（exit=${r.exitCode}）: ${p}`);
            },
            async mkdir(p, options) {
                const r = await self.exec(`mkdir ${options?.recursive ? "-p " : ""}${q(p)}`);
                if (r.exitCode !== 0) throw new Error(`mkdir 失败（exit=${r.exitCode}）: ${p}`);
            },
        };
    }

    /** init：无 terminalId 则 spawn；有则验证存活（跨进程重连语义）；cwd 恢复 */
    async init(): Promise<void> {
        const isAttach = Boolean(this.descriptor.terminalId);
        if (!isAttach) {
            const terminalId = await this.terminal.spawnSession(
                this.descriptor.driver,
                this.descriptor.target,
                this.descriptor.config,
            );
            // 克隆而非原地补写（Sol 74 #4）：调用方的 descriptor 对象曾被告就地
            // 添 terminalId——同描述符二次建层算键即含 terminalId→缓存 miss→
            // 双实例共指同一 tmux 会话，destroy 一个连坐杀掉另一层在用的会话
            this.descriptor = { ...this.descriptor, terminalId };
        } else {
            const tid0 = this.descriptor.terminalId!;
            if (sessionDestroying.has(tid0)) {
                throw new Error(`tmux 会话 '${tid0}' 销毁进行中——稍后重试重挂或新建层（Sol 78 #5：在途销毁的会话 has-session 尚可通过，重挂拿到的将是将死句柄）`);
            }
            const wanted = this.descriptor.cwd;
            // **先登记后异步**（Sol 81 P1-1）：检查→登记之间曾隔着探活/cd 两个
            // await——并发首挂同会话两边都过守卫、各自 cd，后到者覆盖先到者的
            // 目录（两边 pwd 都=/tmp）。JS 单线程：同步完成守卫+登记，异步探活
            // 失败再回滚——并发第二挂进守卫时第一挂已在册（不同 cwd 即拒）
            if (wanted != null) {
                const cwds = sessionCwds.get(tid0);
                if (cwds) {
                    for (const [cwd, n] of cwds) {
                        if (n > 0 && cwd !== wanted) {
                            throw new Error(
                                `tmux 会话 '${tid0}' 已以 cwd='${cwd}' 在用——重挂不同 cwd（'${wanted}'）会改掉共享持久 shell 的工作目录（原层相对路径将落错位置）。` +
                                `请新建层（不带 terminalId）或用 exec 的 cwd 选项（按命令前缀）`,
                            );
                        }
                    }
                    // 未声明 cwd 的在册实例（cwd 计数键为 ""）：其实际目录不可证与
                    // wanted 一致——拒绝（曾放行致原层 pwd 被改）
                    if ((cwds.get("") ?? 0) > 0) {
                        throw new Error(
                            `tmux 会话 '${tid0}' 有未声明 cwd 的在用层（其实际目录不可证与 '${wanted}' 一致）——重挂显式 cwd 可能改掉共享目录。` +
                            `请新建层或先显式声明各层 cwd`,
                        );
                    }
                }
            }
            // **验证期互斥**（Sol 82 P1-1 → Sol 83 P1-2 提前到登记处）：互斥集曾
            // 在 cd 验证启动时才加入——探活返回后、验证开始前的窗口内第二挂曾
            // 过守卫（占位在场→firstAttach=false→跳过验证直接成功）。首挂的
            // 互斥标记在**早登记的同时**加入，验证结束/回滚时清除
            if (cwdValidating.has(tid0)) {
                throw new Error(`tmux 会话 '${tid0}' 目录恢复验证进行中——并发重挂请稍候（首挂验证结论未出前不放行）`);
            }
            const firstAttach = !sessionCwds.has(tid0);
            const refsBefore = sessionAttachRefs.get(tid0) ?? 0;
            // **cwd 早登记**（同步，守卫面即刻生效；refs 仍走共享块——探活失败/
            // 竞态拒只回滚 cwd）：并发第二挂在守卫处即见第一挂的目录占位
            { const key = wanted ?? ""; const cwds = sessionCwds.get(tid0) ?? new Map<string, number>(); cwds.set(key, (cwds.get(key) ?? 0) + 1); sessionCwds.set(tid0, cwds); }
            const needsValidation = wanted != null && firstAttach;
            if (needsValidation) cwdValidating.add(tid0);
            const rollback = (): void => {
                const cwds = sessionCwds.get(tid0);
                const key = wanted ?? "";
                const n = (cwds?.get(key) ?? 1) - 1;
                if (n > 0) cwds!.set(key, n);
                else { cwds?.delete(key); if (cwds && cwds.size === 0) sessionCwds.delete(tid0); }
                cwdValidating.delete(tid0);
            };
            // 探活/cd 全程 try（Sol 82 P2-6）：探活**抛错**（tmux 不在 PATH 等
            // ENOENT）曾不经 rollback——cwd 占位滞留，恢复 PATH 后重挂被幽灵占位拒
            try {
                // 重连探活（Hydrogen R9 #3）：restore(snap) 携 terminalId 时曾静默成功——
                // 宿主重启/tmux server 已退要到首次 exec 才报错。显式 has-session 探测，
                // 死会话立即抛错（快失败优于延迟失败），不自动重建（消费方决定重建或换层）
                const alive = await TmuxInvoker.tryInvoke(["has-session", "-t", tid0]);
                if (alive.exitCode !== 0) {
                    throw new Error(`tmux 会话 '${this.descriptor.terminalId}' 不存在（server 重启或已销毁）——请重建层或 restore 前 respawn`);
                }
                // 首挂 cd + 严格验证（Sol 79→85）：**exitCode 判定**——不解析 stdout。
                // 输出清洗（stripMarkerNoise）在命令回显的退出标记处截断（Sol 85
                // P1-1 真机实锤：OK 标记行在截断点之后被丢——cd 已生效仍报错）。
                // runCommand 的 exitCode=完成哨兵捕获的 $?（cd 本体的退出码）——
                // 无回显/截断干扰
                if (needsValidation) {
                    const probe = await this.terminal.runCommand(
                        tid0,
                        `cd ${q(cdTargetArg(wanted))}`,
                        10_000,
                    ).catch(() => ({ stdout: "", exitCode: 1 }));
                    if (probe.exitCode !== 0) {
                        throw new Error(
                            `tmux 会话 '${tid0}' 恢复目录失败：cd '${wanted}' 退出码 ${probe.exitCode}（目录不存在或无权限）——restore 拒绝半挂（句柄声明与实际目录不符）。请修正快照 cwd 或先建目录`,
                        );
                    }
                }
                // 探活-登记竞态守卫（Sol 79 #5 → Sol 80 #4）：**归零判据**——仅当此前有
                // 在册（refsBefore>0）而现在归零（我们自己的登记也被清=整会话被销毁）。
                // 多引用销毁其一（2→1）合法放行；首挂（refsBefore=0）放行
                if ((refsBefore > 0 && (sessionAttachRefs.get(tid0) ?? 0) === 0) || sessionDestroying.has(tid0)) {
                    throw new Error(`tmux 会话 '${tid0}' 在重挂探活期间被销毁（竞态检出）——请重试重挂或新建层`);
                }
            } catch (e) {
                rollback();
                throw e;
            }
            cwdValidating.delete(tid0); // 验证通过——互斥解除（成功路径）
        }
        { // 在册登记（Sol 76 P2-1）：spawn 与重挂 attach 同权计数。
          // **登记即置位**（Sol 77 P1-2）：attach 探活失败抛错时未曾登记——
          // destroy 的引用扣减曾照扣（?? 1 把缺席当 1），原层会话被连带销毁。
          // cwd：spawn 在此登记；attach 已在守卫段**早登记**（Sol 81 P1-1 同步
          // 占位）——此处再记会双计（销毁清不净、守卫永拦）
            const tid = this.descriptor.terminalId!;
            sessionAttachRefs.set(tid, (sessionAttachRefs.get(tid) ?? 0) + 1);
            if (!isAttach) {
                const cwds = sessionCwds.get(tid) ?? new Map<string, number>();
                const key = this.descriptor.cwd ?? "";
                cwds.set(key, (cwds.get(key) ?? 0) + 1);
                sessionCwds.set(tid, cwds);
            }
            this.attached = true;
        }
        if (this.descriptor.cwd && this.descriptor.terminalId && !isAttach) {
            // cd 仅 spawn 路径（Sol 77 P1-1）：attach 路径的 cd 会改共享会话状态。
            // exitCode 严验证（Sol 86 P2-4）：`|| true` best-effort 曾把不存在的
            // cwd 吞成成功（句柄声明该目录、实际 pwd 停在旧处）——与 attach 路径
            // 同款 exitCode 判定，失败即拒（新建层 cwd 错=配置错误，快失败）
            const probe = await this.terminal.runCommand(
                this.descriptor.terminalId,
                `cd ${q(cdTargetArg(this.descriptor.cwd))}`,
                10_000,
            ).catch(() => ({ stdout: "", exitCode: 1 }));
            if (probe.exitCode !== 0) {
                throw new Error(
                    `tmux 层目录切换失败：cd '${this.descriptor.cwd}' 退出码 ${probe.exitCode}（目录不存在或无权限）——init 拒绝半挂（句柄声明与实际目录不符）。请修正 cwd 或先建目录`,
                );
            }
        }
    }

    /** 本实例启动的后台会话（sessionId 集合——destroy 只清理自己的，绝不扫目录误杀他层） */
    private ownedSessions = new Set<string>();
    /** init 登记成功才置位（Sol 77 P1-2）：attach 探活失败的实例从未持有引用
     *  ——destroy 不得扣减/销毁（曾照扣致原层会话被连带杀） */
    private attached = false;
    /** destroy 幂等（Sol 77 P1-2）：同 driver 二次 destroy 曾再扣一次引用，
     *  提前耗尽其他层 */
    private destroyedOnce = false;

    /** destroy：只停**本实例**启动的后台进程（审查问题 1：全目录扫杀会误杀同机其他
     * Filaxis 实例/其他层的任务——/tmp/filaxis-sessions 是共享目录），再销毁会话——
     * **引用计数护会话**（Sol 76 P2-1）：同 terminalId 的其他 driver 实例仍在
     *用时（不同 cwd 重挂等）不杀会话，归零才真销毁 */
    async destroy(): Promise<void> {
        if (this.destroyedOnce) return; // 幂等（Sol 77 P1-2）：二次调用不再扣减
        this.destroyedOnce = true;
        if (!this.attached) return; // 未登记=未持有引用（init 失败路径）——不动会话
        if (this.descriptor.terminalId) {
            for (const sid of this.ownedSessions) {
                const base = this.sessionBase(sid);
                try {
                    await this.terminal.runCommand(
                        this.descriptor.terminalId,
                        `${this.pidGuardedKill(base)}; rm -f ${q(base)}.pid; true`,
                        5_000,
                    );
                } catch { /* best-effort：单个会话清理失败不阻断其余 */ }
            }
            this.ownedSessions.clear();
            const tid = this.descriptor.terminalId;
            const refs = Math.max(0, (sessionAttachRefs.get(tid) ?? 1) - 1);
            { // cwd 计数递减（Sol 78 P1-4 → Sol 80 P1-3：未声明以 "" 键同登记同减）
              const key = this.descriptor.cwd ?? "";
              const cwds = sessionCwds.get(tid);
              const n = (cwds?.get(key) ?? 1) - 1;
              if (n > 0) cwds!.set(key, n);
              else {
                  cwds?.delete(key);
                  if (cwds && cwds.size === 0) sessionCwds.delete(tid);
              } }
            if (refs === 0) {
                sessionAttachRefs.delete(tid);
                sessionDestroying.add(tid); // 销毁在途（Sol 78 #5）：重挂守卫依据
                try {
                    await this.terminal.destroySession(tid);
                } finally {
                    sessionDestroying.delete(tid);
                }
            } else {
                sessionAttachRefs.set(tid, refs); // 他实例仍持有——会话留命
            }
        }
    }

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
        // env 显式拒绝（十轮自挖）：tmux 全 PTY 语义（send-keys 键入回显进捕获输出），
        // export 前缀会污染 stdout——拒绝优于静默丢弃（曾完全忽略 options.env）
        if (options?.env && Object.keys(options.env).length) {
            throw new Error("tmux 层不支持 env（send-keys 键入回显会混入输出捕获——终端物理语义）；请内联进命令文本或换 ssh/local 层");
        }
        // signal 显式拒绝（Hydrogen R4 #3）：runCommand 通道无 abort 挂钩——静默忽略
        // 会让调用方以为可取消。指路 execSession+stop_and_verify（有完整三态收口）
        if (options?.signal) {
            throw new Error("tmux 层 exec 不支持 AbortSignal（runCommand 无中断挂钩）；改用 execSession + stopSession（三态收口）");
        }
        // cwd 支持（Hydrogen R4 #3 → Sol 87 P1-6 作用域隔离）：曾静默丢弃；后修
        // cd 前缀**裸跑在父 shell**——单次 exec 的 cwd 覆盖永久改掉持久 shell 的
        // 目录（下一条无 cwd 的 pwd 仍在新目录、相对路径全落错）。改子 shell
        // 隔离：( cd X && cmd )——cd 只活在本条命令；退出码经子 shell 天然透传。
        // **上下换行**（Sol 88 P2-2）：单行 `{ cmd; } )` 下业务尾注释
        // `cmd # cmt` 把 `; } )` 一并注释掉——包装永不闭合，命令挂到超时。命令
        // 与闭合语法分行（execSession 二十期 #2 同款双防）。
        // **CDPATH 防改写**（Sol 89 P1-7）：裸相对路径的 cd 先搜 CDPATH——
        // CDPATH 下同名目录存在时执行落去另一棵树（当前目录的 sub 在场也拦不住）
        const cmd = options?.cwd
            ? `( cd ${q(cdTargetArg(options.cwd))} && {\n${command}\n} )`
            : command;
        if (options?.channel === "pty") {
            // tmux 后端本身即 PTY 语义（send-keys/capture-pane）
            const r = await this.terminal.runCommand(this.descriptor.terminalId!, cmd, {
                timeoutMs: options?.timeoutMs ?? 120_000,
            });
            return { stdout: r.stdout, stderr: "", exitCode: r.exitCode };
        }
        // exec 通道语义：独立 ssh 直达不适用于 tmux 复合层——走 PTY 但显式声明混流
        const r = await this.terminal.runCommand(this.descriptor.terminalId!, cmd, {
            timeoutMs: options?.timeoutMs ?? 120_000,
        });
        return { stdout: r.stdout, stderr: "", exitCode: r.exitCode };
    }

    async getCwd(): Promise<string> {
        const r = await this.exec("pwd");
        return r.stdout.trim();
    }

    /** 读环境变量（GPT Astra 十轮 #2 同款修复：旧 \$ 转义形态永远返回字面 $KEY）。
     *  PTY 混流下 printenv 输出 \r\n——剥单个尾 CRLF/LF。 */
    async getEnv(key: string): Promise<string | undefined> {
        if (!ENV_NAME_RE.test(key)) throw new Error(`非法环境变量名: ${key}`);
        const r = await this.exec(`printenv ${key}`);
        if (r.exitCode !== 0) return undefined;
        return r.stdout.replace(/\r?\n$/, "");
    }

    private dialectPromise?: Promise<RemoteDialect>;

    /** 方言惰性探测缓存（大文件 writeFile 的 putContent 链路用——每层一次） */
    private async dialect(): Promise<RemoteDialect> {
        this.dialectPromise ??= probeDialect((cmd) => this.exec(cmd));
        return this.dialectPromise;
    }

    // ── 会话族：nohup 后台进程经会话 shell 启动（.pid 落盘供 destroy 清理）──
    async execSession(command: string, opts?: SessionStartOptions): Promise<SessionHandleInfo> {
        // 名称白名单规范化（Astra 四十期 #1，对齐 local/remote 同款）：原名直接拼
        // sessionId→未引用路径 = 命令注入面（`probe$(touch …)` 实测文件被创建）。
        // 白名单字符集 [a-zA-Z0-9_-] 内无任何 shell 元字符
        const sessionId =
            `${opts?.name ? sanitizeSessionName(opts.name) + "-" : "tsess-"}` +
            crypto.randomBytes(3).toString("hex");
        const base = `/tmp/filaxis-sessions/${sessionId}`;
        // cd 显式失败码（R3 同款：`cd X &&` 前缀在 & 后台化下失败不可探测——幽灵会话）
        const cd = opts?.cwd ? `cd ${q(cdTargetArg(opts.cwd))} || exit 1; ` : ""; // CDPATH 防改写（Sol 89 P1-7，cdTargetArg）
        // env 内联前缀（十轮 envPrefixOf 同款；execSession 的 env 此前被静默忽略——
        // nohup 后台跑无 send-keys 回显污染问题，支持优于静默丢弃）
        const envPrefix = opts?.env && Object.keys(opts.env).length > 0
            ? Object.entries(opts.env).map(([k, v]) => {
                if (!ENV_NAME_RE.test(k)) throw new Error(`非法环境变量名（会话启动拒绝）: ${k}`);
                return `export ${k}=${q(v)}`; // export 形态（Sol 55 P2-D 同 remote）
            }).join("; ") + "; " // 分号分隔（Sol 56 P2-1）：曾空格连接 export K=v cmd——export 吞 cmd 当变量名参数
            : "";
        // 子 shell + 上下换行（孪生对齐审计·二十期 #2 + M4 在 remote/local 修后 tmux
        // execSession 才出生、带病出厂）：大括号形态下业务命令显式 `exit 7` 退出**整个
        // 包装 shell**——.code 永不写（进程已死但 stopSession 恒查不到终态）；单行拼接
        // 下业务尾注释 `cmd # cmt` 吞掉 `; }` 同病。子 shell 隔离 + 换行双防
        const wrapped = `(\n${envPrefix}${command}\n); echo $? > ${base}.code`; // env 前缀进子 shell（同 remote）
        // 启动握手（孪生对齐审计·二十一期 remote 模板漏改）：分号链里 mkdir 失败/
        // cd 失败被 & 吞/重定向失败/nohup 127 都不影响父 shell——$! 照样返回 PID =
        // 幽灵会话（.pid 空/指向已死壳，execSession 谎报成功）。wrapper 亲写 .pid +
        // 等待窗 + FX 闸三件套；.st 身份戳（H3二 同款）防 PID 复用误杀。
        // **整条包子 shell**：remote 模板的 `exit 1` 走 ssh 独立 shell 合法；本层 exec
        // 经 runCommand 打进**持久会话 shell**——裸 exit 会杀掉 tmux 会话本体（坑档
        // 案「tmux 交互用例裸 exit」+ M4 同源），子 shell 内 exit 只退自己
        const r = await this.exec(
            // 外层直接执行的派生路径全部引用（纵深——规范化已除注入面，q() 再兜一层；
            // nohup sh -c 内层不能再 q：外层整体单引号串内嵌单引号会提前闭合，且
            // q() 已保证 wrapped 字面到达、base 经规范化无元字符）
            `( mkdir -p /tmp/filaxis-sessions 2>/dev/null || { echo FX_MKDIR_FAIL; exit 1; }; ` +
            // setsid 进程组（Hydrogen R5 #3）：wrapper 自成组长——stopSession 组杀全树
            // （单杀主 PID 漏孙进程后探针见主死=谎报 stopped）。缺席平台 pgid≠pid 自动回落
            `${cd}__fx_sets=""; command -v setsid >/dev/null 2>&1 && __fx_sets=setsid; ` +
            `$__fx_sets nohup sh -c ${q(`echo $$ > ${base}.pid.tmp; mv ${base}.pid.tmp ${base}.pid; ps -o pgid= -p $$ 2>/dev/null | tr -d ' 
' > ${base}.pgid; ${wrapped}`)} > ${q(base)}.out 2> ${q(base)}.err < /dev/null & ` +
            `__fx_n=0; while [ ! -f ${q(base)}.pid ] && [ $__fx_n -lt 30 ]; do sleep 0.1; __fx_n=$((__fx_n+1)); done; ` +
            `[ -f ${q(base)}.pid ] || { echo FX_SPAWN_FAIL; exit 1; }; ` +
            `{ awk '{print $22}' /proc/$(cat ${q(base)}.pid)/stat 2>/dev/null || true; } > ${q(base)}.st; true )`,
        );
        const out = (r.stdout || "").trim();
        if (out.includes("FX_MKDIR_FAIL")) {
            // 确定性失败：目录不可创建——后台任务物理上不可能启动，可安全重试
            throw new Error(`tmux 会话启动失败（/tmp/filaxis-sessions 不可创建）: ${command.slice(0, 60)}`);
        }
        if (out.includes("FX_SPAWN_FAIL") || r.exitCode !== 0) {
            // 非确定失败（二十三期 #1 语义）：等待窗 3s 内 .pid 未出现——可能真没启动
            // 也可能慢启动。不给「可安全重试」信号——outcome=unknown + 线索交调用方核实
            const e = new Error(
                `tmux 会话启动未确认（3s 内未见 .pid——任务可能仍在启动，勿盲目重试非幂等命令；` +
                `核实：ls ${base}.* / cat ${base}.out）`,
            ) as Error & { outcome: string; sessionId: string; logBase: string };
            e.outcome = "unknown";
            e.sessionId = sessionId;
            e.logBase = base;
            throw e;
        }
        this.ownedSessions.add(sessionId);
        return { sessionId, logBase: base };
    }
    async tailSession(sessionId: string, lines = 50): Promise<string[]> {
        const base = this.sessionBase(sessionId);
        // 存在性纪律（Sol 74 #7）：`|| true` 曾把缺失会话的日志当空数组。test -r 门
        // + 退出码入闸——**子 shell 包裹**（Sol 75 P1-1）：tmux 的 exec 跑在**持久
        // shell** 里（send-keys 到会话），裸 exit 会退掉承载层（remote 的每命令
        // sh -s 语义不可照搬）——全部命令以 ( ... ) 收束，exit 只出子 shell、
        // 退出码仍透传为整行状态
        const r = await this.exec(
            `( test -r ${q(`${base}.out`)} || exit 9; tail -n ${lines} ${q(`${base}.out`)} 2>/dev/null )`,
        );
        if (r.exitCode !== 0) {
            throw new Error(`会话日志读取失败（tailSession exit=${r.exitCode}——输出不作日志凭证）: ${sessionId}`);
        }
        return r.stdout.split("\n").filter(Boolean);
    }
    async readSessionLog(sessionId: string, opts?: ReadLogOptions): Promise<string> {
        const base = this.sessionBase(sessionId);
        const suffix = opts?.stream === "stderr" ? ".err" : ".out";
        // 存在性纪律（Sol 74 #7）+ 子 shell 包裹（Sol 75 P1-1 同 tailSession：
        // 裸 exit 曾直接终止承载层）；lines 截断走临时文件中转（管道尾 rc 只
        // 反映末命令——与 remote readLog 同款，但包在子 shell 内）
        const rd = q(base + suffix);
        let body: string;
        if (opts?.lines != null) {
            const readCmd = opts?.offsetLines ? `tail -n +${opts.offsetLines + 1} ${rd}` : `cat ${rd}`;
            body = `test -r ${rd} || exit 9; ` +
                `__fx_d="\${TMPDIR:-/tmp}"; [ -d "$__fx_d" ] && [ -w "$__fx_d" ] || __fx_d=/tmp; ` +
                `__fx_t="$__fx_d/fx-rl-$$-${Math.random().toString(36).slice(2, 6)}"; ` +
                `{ ${readCmd} > "$__fx_t" 2>/dev/null || { rm -f "$__fx_t"; exit 9; }; }; ` +
                `{ tail -n ${opts.lines} "$__fx_t"; }; __fx_rc=$?; rm -f "$__fx_t"; exit $__fx_rc`;
        } else {
            body = opts?.offsetLines
                ? `test -r ${rd} || exit 9; tail -n +${opts.offsetLines + 1} ${rd}`
                : `test -r ${rd} || exit 9; cat ${rd}`;
        }
        const r = await this.exec(`( ${body} )`);
        if (r.exitCode !== 0) {
            throw new Error(`会话日志读取失败（readSessionLog exit=${r.exitCode}——输出不作日志凭证）: ${sessionId}`);
        }
        return r.stdout.replace(/\n$/, "");
    }
    watchSession(_sessionId: string, _opts: WatchOptions): { cancel(): void } {
        throw new Error("tmux 后端会话 watcher 属 M2 观察流批次（stream-session 落位后接入）");
    }
    async stopSession(sessionId: string): Promise<{ status: "exited" | "stopped" | "unknown"; exitCode?: number | null }> {
        const base = this.sessionBase(sessionId);
        // 先探针后信号（Astra 四十二期 #1，对齐 remote H3一「stop 先查 .code」）：
        // 已自然退出的会话绝无再发信号的必要——.st 缺席的老会话若 PID 已被系统
        // 复用，先 TERM 会误伤无辜进程。探针终态（CODE/DEAD/NOEV）直接返回，
        // 只有 ALIVE 才进入「身份戳守卫 TERM → 核实窗轮询」
        const probe = (
            `if [ -f ${q(base)}.code ]; then echo CODE:$(cat ${q(base)}.code); ` +
            // 组感知存活（Sol 74 P1-1）：.pgid==pid 时探**整组**（/bin/kill 绝对
            // 路径——dash 内建不认负 PID）——组长先退、孙进程持组存活曾报 DEAD
            // →stopped（孙进程实际还在跑）。组内任一存活=ALIVE
            `elif [ -f ${q(base)}.pid ]; then p=$(cat ${q(base)}.pid); ` +
            `g=$(cat ${q(base)}.pgid 2>/dev/null); ` +
            `if [ -n "$g" ] && [ "$g" = "$p" ]; then ` +
            // 组模式组长优先+.st（Sol 75 P2-3 同 verifySession）：组长活→戳比对
            //（不符=STALE 不发信号——复用组防误杀）；组长死组活=我组孙进程当家
            // →ALIVE；组全灭→DEAD
            `if kill -0 "$p" 2>/dev/null; then ` +
            `s=$(cat ${q(base)}.st 2>/dev/null); c=$(awk '{print $22}' /proc/$p/stat 2>/dev/null); ` +
            `if [ -z "$s" ] || [ "$s" = "$c" ]; then echo ALIVE; else echo STALE; fi; ` +
            `elif /bin/kill -0 -- "-$g" 2>/dev/null; then echo ALIVE; else echo DEAD; fi; ` +
            `else if kill -0 "$p" 2>/dev/null; then echo ALIVE; else echo DEAD; fi; fi; ` +
            `else echo NOEV; fi`
        );
        // 探针解析（Astra 四十三期 #2）：CODE 须**整行全数字**（`CODE:7oops` 这种损坏
        // 记录不得部分匹配成 7——格式不符=证据无效）；探针本身失败（exitCode≠0 或
        // 输出无四词任一——PTY 异常/会话死亡中途）=无从核实，**绝不进信号段**
        // （四十三期 #1：修前探针空输出被当 ALIVE，照样发 TERM/KILL）
        const readout = (
            out: string,
            probeOk: boolean,
        ): { status: "exited" | "stopped" | "unknown"; exitCode?: number | null } | undefined => {
            if (!probeOk) return { status: "unknown" }; // 探针不可信——不发信号，交调用方核实
            for (const line of out.split(/\r?\n/)) {
                const m = line.trim().match(/^CODE:(\d+)$/); // 整行严格：完整记录才算数
                if (m) return { status: "exited", exitCode: parseInt(m[1]!, 10) };
            }
            if (out.includes("DEAD")) return { status: "stopped" }; // pid 在场且已死（TERM 致死/迟到死亡）
            if (out.includes("STALE")) return { status: "unknown" }; // 组长被复用（Sol 75 P2-3）——原会话状态不可知，绝不向复用组发信号
            if (out.includes("NOEV")) return { status: "unknown" }; // 证据全缺——无从证实死亡
            if (out.includes("ALIVE")) return undefined; // 明确存活——才允许进信号段
            return { status: "unknown" }; // 词不达意（空输出/截断混流）——探针失败同罪
        };
        const runProbe = async () => {
            const r = await this.exec(probe);
            return readout(r.stdout, r.exitCode === 0);
        };
        const first = await runProbe();
        if (first) return first;
        // PID 身份戳比对（孪生对齐审计·H3二 remote 同款）：.st 与当前 starttime 不符
        // =PID 已被系统复用给无辜进程——不发信号（.st 缺席=老会话/非 Linux，放行）
        await this.exec(this.pidGuardedKill(base, "TERM"));
        for (let i = 0; i < 4; i++) {
            const r = await runProbe();
            if (r) return r;
            await new Promise((res) => setTimeout(res, 300)); // ALIVE——TERM 核实窗
        }
        // SIGKILL 升级（对齐 remote 三段：顽固/不可中断进程 TERM 不动——KILL 再核，
        // .st 守卫同款防复用误杀；仍不死=不可中断态（D 状态 IO）→ unknown 如实）
        await this.exec(this.pidGuardedKill(base, "KILL"));
        for (let i = 0; i < 2; i++) {
            const r = await runProbe();
            if (r) return r;
            await new Promise((res) => setTimeout(res, 300));
        }
        return { status: "unknown" }; // kill -0 持续说活（不可中断态）——死亡未证实
    }
    /** 会话路径派生（Astra 四十一期 #1）：sessionId 是外部输入——直接拼路径=注入面
     *  （本机 Bash 实测命令替换输出标记；启动侧四十期已规范化，读取/停止侧漏）。
     *  查询键白名单校验后拒绝（ID 是查找键非创建名——静默归一会把「查无此会话」
     *  偷换成「查了个不存在的归一名」，拒绝优于清洗） */
    private sessionBase(sessionId: string): string {
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
            throw new Error(`非法会话 ID（仅 [A-Za-z0-9_-]）: ${JSON.stringify(sessionId.slice(0, 40))}`);
        }
        return `/tmp/filaxis-sessions/${sessionId}`;
    }
    /** .st 身份戳守卫的信号发送（stopSession 三段与 destroy 共用；持久 shell 里禁裸 exit） */
    private pidGuardedKill(base: string, sig: "TERM" | "KILL" = "TERM"): string {
        // 组感知（Hydrogen R5 #3）：.pgid==pid 时组杀全树（/bin/kill 绝对路径——dash
        // kill 内建不认负 PID）；缺席/不匹配回落单杀
        // 组长已死放行组信号（Sol 76 P2-3）：.st 比对要求 /proc/$p 可读——组长
        // 退出后孙进程持组存活时比不出来，曾整段卡死（stopSession 转一圈
        // unknown、孙进程照跑）。放行条件=组长确死（kill -0 失败）：组若仍活
        // 必是我组孙进程（pgid 被我成员持有不可复用）；复用组的新组长必活、
        // 走不进此分支（活组长戳不符仍拦截）
        return (
            `p=$(cat ${q(base)}.pid 2>/dev/null); [ -n "$p" ] && { ` +
            `s=$(cat ${q(base)}.st 2>/dev/null); ` +
            `{ [ -z "$s" ] || [ "$s" = "$(awk '{print $22}' /proc/$p/stat 2>/dev/null)" ] || ! kill -0 "$p" 2>/dev/null; } && { ` +
            `g=$(cat ${q(base)}.pgid 2>/dev/null); ` +
            `if [ -n "$g" ] && [ "$g" = "$p" ]; then /bin/kill -${sig} -- "-$g" 2>/dev/null; ` +
            `else kill -${sig} "$p" 2>/dev/null; fi; }; }; true`
        );
    }
    /** 会话核实（unknown 闭环）：.code 在场=exited（真实码）；否则 kill -0 实测 pid
     *  **带 .st 身份核验**（Astra 四十二期 #2）：裸 kill -0 在 PID 被系统复用时会把
     *  无辜进程的存活报告成原会话仍在运行——starttime 戳不符即 unknown（原会话
     *  真实状态不可知），绝不冒认。单探针合并往返（PTY 每往返数百 ms）。 */
    async verifySession(sessionId: string): Promise<{ status: "running" | "exited" | "unknown"; exitCode?: number | null }> {
        const base = this.sessionBase(sessionId);
        const r = await this.exec(
            `if [ -f ${q(base)}.code ]; then echo CODE:$(cat ${q(base)}.code); ` +
            // 组感知存活（Sol 74 P1-1 同 stopSession）：孙进程持组=running——
            // 组模式先探组（/bin/kill 负 PID），组长活着才做 .st 身份核验；
            // 组长已死组仍活（孙进程当家）=RUNNING（会话语义=整棵命令树）
            `elif [ -f ${q(base)}.pid ]; then p=$(cat ${q(base)}.pid); ` +
            `g=$(cat ${q(base)}.pgid 2>/dev/null); ` +
            `if [ -n "$g" ] && [ "$g" = "$p" ]; then ` +
            // 组模式组长身份核验（Sol 75 P2-3）：先探组长——活着即做 .st 比对
            //（原组全灭后 pgid 被新组复用时，新组长 pid==pgid 必活着、戳必不符
            // → STALE 拦下）；组长死而组仍活=我组孙进程当家（pgid 被我成员持有
            // 不可能被复用）→ RUNNING；组全灭 → DEAD
            `if kill -0 "$p" 2>/dev/null; then ` +
            `s=$(cat ${q(base)}.st 2>/dev/null); c=$(awk '{print $22}' /proc/$p/stat 2>/dev/null); ` +
            `if [ -z "$s" ] || [ "$s" = "$c" ]; then echo RUNNING; else echo STALE; fi; ` +
            `elif /bin/kill -0 -- "-$g" 2>/dev/null; then echo RUNNING; else echo DEAD; fi; ` +
            `elif kill -0 "$p" 2>/dev/null; then ` +
            `s=$(cat ${q(base)}.st 2>/dev/null); c=$(awk '{print $22}' /proc/$p/stat 2>/dev/null); ` +
            `if [ -z "$s" ] || [ "$s" = "$c" ]; then echo RUNNING; else echo STALE; fi; ` + // 复用：活着但身份不符
            `else echo DEAD; fi; ` +
            `else echo NOEV; fi`,
        );
        const out = r.stdout;
        // 探针失败（exitCode≠0）或 CODE 非整行全数字=证据无效（四十三期 #2：
        // `CODE:7oops` 损坏记录不得部分匹配成 7；#1 同罪——探针不可信不下结论）
        if (r.exitCode !== 0) return { status: "unknown" };
        for (const line of out.split(/\r?\n/)) {
            const m = line.trim().match(/^CODE:(\d+)$/);
            if (m) return { status: "exited", exitCode: parseInt(m[1]!, 10) };
        }
        if (out.includes("RUNNING")) return { status: "running" }; // 身份核实过的存活
        return { status: "unknown" }; // STALE（PID 被复用——原会话状态不可知）/ DEAD（死因不明）/ NOEV / 词不达意
    }
    listSessions(): Array<{ sessionId: string; command: string; running: boolean; startedAt: number }> {
        return []; // 无常驻索引（M2 批补 registry 化）
    }
}
