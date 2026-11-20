import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as crypto from "node:crypto";
import { openSshEnvironment } from "./openssh-environment.js";
import type { FilaxisLogger } from "./logger.js";

export function sshFileStdioRequested(): boolean {
    return process.env.FILAXIS_SSH_STDIO_MODE === "inherit";
}

/** 直接启动 SSH 或 SFTP，将标准流绑定到临时文件描述符，最后读回双流。 */
export async function spawnWithFileRedirect(argv: string[], stdinCmd: string, opts: { timeoutMs?: number; signal?: AbortSignal; executable?: "ssh" | "sftp"; logger?: FilaxisLogger } = {}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const executable = opts.executable ?? "ssh";
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    const nonce = crypto.randomBytes(6).toString("hex");
    const outFile = `${os.tmpdir()}/fx-ssh-io-${nonce}.out`;
    const errFile = `${os.tmpdir()}/fx-ssh-io-${nonce}.err`;
    const inFile = `${os.tmpdir()}/fx-ssh-io-${nonce}.in`;
    const cleanup = () => Promise.all([
        fsp.unlink(outFile).catch(() => undefined),
        fsp.unlink(errFile).catch(() => undefined),
        fsp.unlink(inFile).catch(() => undefined),
    ]);
    if (opts.signal?.aborted) {
        throw Object.assign(new DOMException("exec aborted by AbortSignal（文件中转未启动）", "AbortError"), { outcome: "unknown" });
    }
    try {
        await fsp.writeFile(inFile, stdinCmd, { encoding: "utf-8", mode: 0o600 });
        // 中转文件可含命令、环境变量和输出，创建时限制权限。
        await fsp.writeFile(outFile, "", { mode: 0o600 });
        await fsp.writeFile(errFile, "", { mode: 0o600 });
    } catch (e) {
        await cleanup(); // 准备失败不留残（Sol 79 #6）：.in 含原始命令/env 值
        throw e;
    }
    // 备妥后再核一次取消（Sol 79 #4）：建文件窗口内 abort 曾照跑 ssh
    if (opts.signal?.aborted) {
        await cleanup();
        throw Object.assign(new DOMException("exec aborted by AbortSignal（文件中转准备完成前取消）", "AbortError"), { outcome: "unknown" });
    }
    // 直 spawn + 文件 fd（Sol 80 P1-1/P2-5）：无 shell——cmd 的 %VAR% 展开曾改写
    // -i 密钥路径等参数字面量；shell 包装还使 kill 只杀到外层 shell（ssh 替身
    // 照跑到底）。stdio 三路全部接文件句柄（沙箱拦的是**匿名管道**，文件句柄
    // 放行）——无引用、无展开、kill 直达 ssh 本体。
    // fsSync 静态导入（Sol 81 P2-4）：动态 import 的 await 窗口内取消曾被放过
    let inFd = -1, outFd = -1, errFd = -1;
    try {
        inFd = fsSync.openSync(inFile, "r");
        outFd = fsSync.openSync(outFile, "w");
        errFd = fsSync.openSync(errFile, "w");
    } catch (e) {
        for (const fd of [inFd, outFd, errFd]) if (fd >= 0) fsSync.closeSync(fd);
        await cleanup();
        throw e;
    }
    let aborted = false;
    let spawnErr: Error | undefined; // 本地启动错误（Sol 84 P2 上轮补丁断言失败未落盘——本轮重落+验证）
    let p: ReturnType<typeof spawn>;
    const closeFds = (): void => {
        // fd 双关防线（Sol 82 P2-8）：启动前取消分支关过一次、catch 再关同编号
        //——清理期间复用编号的他文件曾报 EBADF。关后置 -1，二次关闭自然跳过
        for (const fd of [inFd, outFd, errFd]) if (fd >= 0) { try { fsSync.closeSync(fd); } catch { /* 已关 */ } }
        inFd = outFd = errFd = -1;
    };
    try {
        if (opts.signal?.aborted) { // spawn 前最后一核（fd 打开窗口内取消）
            closeFds();
            await cleanup();
            throw Object.assign(new DOMException("exec aborted by AbortSignal（spawn 前检出）", "AbortError"), { outcome: "unknown" });
        }
        p = spawn(executable, argv, { stdio: [inFd, outFd, errFd], env: openSshEnvironment(process.env, opts.logger) });
        p.once("error", (e: Error) => { spawnErr = e; }); // 本地拒启归账（ENOENT 等）——区别于远端执行结果
    } catch (e) {
        // spawn 同步抛错清场（Sol 81 P2-5）：argv 含 NUL 等被 Node 拒启——
        // fd 与三个中转文件曾全部滞留
        closeFds();
        await cleanup();
        throw e;
    }
    const exitCode = await new Promise<number | null>((resolve) => {
        const onAbort = () => { aborted = true; p.kill("SIGTERM"); resolve(null); };
        const t = opts.timeoutMs ? setTimeout(() => { p.kill("SIGTERM"); resolve(null); }, opts.timeoutMs) : null;
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        const done = (c: number | null) => {
            if (t) clearTimeout(t);
            opts.signal?.removeEventListener("abort", onAbort);
            resolve(c);
        };
        p.once("exit", (c) => done(c));
        p.once("error", () => done(null));
    });
    for (const fd of [inFd, outFd, errFd]) { try { fsSync.closeSync(fd); } catch { /* 已随进程关闭 */ } }
    // stderr 读取失败不静默（Sol 83 P2-9）：EIO 等曾吞成空串——退出码照回而
    // 诊断内容丢失，调用方无从知晓。落诊断占位（stdout 同罪同判）
    const readOrNote = async (f: string, what: string): Promise<string> => {
        try {
            return await fsp.readFile(f, "utf-8");
        } catch (e) {
            return `[filaxis] ${what} 读取失败（${(e as Error).message}）——诊断内容丢失`;
        }
    };
    const [out, err] = await Promise.all([
        readOrNote(outFile, "stdout"),
        readOrNote(errFile, "stderr"),
    ]);
    await cleanup();
    if (aborted) {
        // AbortError+outcome（Sol 79 #4）：修前返回普通错误且替身照跑到底
        throw Object.assign(new DOMException("exec aborted by AbortSignal（文件中转已终止本地 ssh，远端进程状态未核实）", "AbortError"), { outcome: "unknown" });
    }
    if (spawnErr) {
        // 本地启动失败直报（Sol 84 P2 → Sol 85 P2 → Sol 86 P2-5 结构化）：
        // 修前吞成「无哨兵 exit=null」；上轮直报但包成普通 Error——code/cause
        // 全丢（消费方按 code 分诊不可用）。code 透传 + cause 挂原错误
        throw Object.assign(
            new Error(`本地 ${executable} 启动失败（${spawnErr.message}）——检查 PATH/可执行文件。中转模式（FILAXIS_SSH_STDIO_MODE=inherit）`),
            { code: (spawnErr as { code?: string }).code, cause: spawnErr },
        );
    }
    return { stdout: out, stderr: err, exitCode };
}
