import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

// The guardian owns the job from outside it and can verify that it is empty.
const windowsJobScript = `
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class FxObservationJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    public static uint ActiveProcesses(IntPtr job) {
        Accounting info;
        if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
        return info.ActiveProcesses;
    }
    public static void Stop(IntPtr job) {
        if (!TerminateJobObject(job, 1)) throw new Win32Exception();
    }
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Own(int pid) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        try {
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) throw new Win32Exception();
            IntPtr process = OpenProcess(0x101, false, pid); // SET_QUOTA | TERMINATE
            if (process == IntPtr.Zero) throw new Win32Exception();
            try {
                if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
            } finally { CloseHandle(process); }
            return job;
        } catch { CloseHandle(job); throw; }
    }
}
'@
    $job = [FxObservationJob]::Own([int]$env:FILAXIS_OBSERVATION_SUPERVISOR_PID)
    try {
        [Console]::WriteLine('READY')
        while ($null -ne ($request = [Console]::In.ReadLine())) {
            try {
                if ($request -eq 'CHECK' -and [FxObservationJob]::ActiveProcesses($job) -gt 1) {
                    [Console]::WriteLine('BUSY')
                    continue
                }
                if ([FxObservationJob]::ActiveProcesses($job) -ne 0) { [FxObservationJob]::Stop($job) }
                while ([FxObservationJob]::ActiveProcesses($job) -ne 0) { Start-Sleep -Milliseconds 25 }
                [Console]::WriteLine('STOPPED')
                break
            } catch {
                [Console]::Error.WriteLine($_.Exception.Message)
                [Console]::WriteLine('RETRY')
            }
        }
    } finally { [void][FxObservationJob]::CloseHandle($job) }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`;

// Keep an owner alive while the command or its background children are running.
const supervisorScript = `
const { spawn } = require('node:child_process');
const [shell, command] = process.argv.slice(1);
const send = (message) => { if (process.connected) process.send(message, () => {}); };
const fail = (error) => send({ type: 'failed', error });
function startWorker(env) {
    const worker = spawn(shell, ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    worker.stdout.on('data', (chunk) => { stdoutBytes += chunk.length; });
    worker.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    worker.stdout.pipe(process.stdout, { end: false });
    worker.stderr.pipe(process.stderr, { end: false });
    worker.once('spawn', () => send({ type: 'started' }));
    worker.once('error', (error) => fail(error.message));
    worker.once('exit', (code) => send({ type: 'exit', code }));
    worker.once('close', () => send({ type: 'drained', stdoutBytes, stderrBytes }));
}
let retiring = false;
function checkPosixGroup() {
    const ps = spawn('ps', ['-ax', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='], {
        detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let sawOwner = false;
    let hasChildren = false;
    const lines = require('node:readline').createInterface({ input: ps.stdout });
    lines.on('line', (line) => {
        const [pid, group, status] = line.trim().split(/\\s+/);
        if (Number(group) !== process.pid) return;
        if (Number(pid) === process.pid) sawOwner = true;
        else if (status && !status.startsWith('Z')) hasChildren = true;
    });
    ps.on('error', () => {});
    ps.on('close', (code) => {
        if (code === 0 && sawOwner && !hasChildren) {
            retiring = true;
            process.disconnect();
        } else if (process.connected) {
            setTimeout(checkPosixGroup, 1000);
        }
    });
}
process.on('message', (message) => {
    if (message.type === 'start-worker') startWorker(message.env);
    else if (message === 'output-consumed' && process.platform !== 'win32') checkPosixGroup();
});
// Keep the group leader available while the worker handles a graceful stop.
if (process.platform !== 'win32') process.on('SIGTERM', () => {});
process.once('disconnect', () => {
    if (retiring) return;
    if (process.platform !== 'win32') {
        try { process.kill(-process.pid, 'SIGKILL'); } catch {}
    }
    process.exit(0);
});
`;

type OutputBytes = { stdoutBytes: number; stderrBytes: number };

export function watchLocalProcess(child: ChildProcess): { exited: () => boolean; finished: Promise<void> } {
    let ended = child.exitCode != null || child.signalCode != null;
    const finished = new Promise<void>((resolve) => {
        if (ended) { resolve(); return; }
        const onEnd = () => {
            ended = true;
            child.off("exit", onEnd);
            child.off("close", onEnd);
            resolve();
        };
        child.once("exit", onEnd);
        child.once("close", onEnd);
    });
    return { exited: () => ended, finished };
}

function watchWindowsJob(child: ChildProcess, start: () => void, fail: (error: Error) => void) {
    const guardian = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsJobScript, "utf16le").toString("base64")], {
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        env: { ...process.env, FILAXIS_OBSERVATION_SUPERVISOR_PID: String(child.pid) },
    });
    let ready = false;
    let stopping = false;
    let confirmed = false;
    let error = "";
    let idleCheck: ReturnType<typeof setTimeout> | undefined;
    const check = () => { if (!stopping && !confirmed) guardian.stdin.write("CHECK\n"); };
    const requestStop = () => {
        if (stopping || confirmed) return;
        stopping = true;
        clearTimeout(idleCheck);
        guardian.stdin.write("STOP\n", (error) => { if (error) stopping = false; });
    };
    guardian.stdin.on("error", () => {});
    guardian.stderr.on("data", (chunk) => { error = (error + chunk).slice(-2000); });
    guardian.once("error", fail);
    createInterface({ input: guardian.stdout }).on("line", (line) => {
        if (line === "READY") {
            ready = true;
            if (!stopping) start();
        } else if (line === "BUSY" && !stopping) {
            idleCheck = setTimeout(check, 1000);
        } else if (line === "STOPPED") {
            confirmed = true;
        } else if (line === "RETRY") {
            if (!stopping) idleCheck = setTimeout(check, 1000);
            stopping = false;
        }
    });
    child.once("exit", requestStop);
    const verified = new Promise<boolean>((resolve) => {
        guardian.once("close", (code) => {
            clearTimeout(idleCheck);
            if (!ready) {
                fail(new Error(error.trim() || "Windows Job Object unavailable"));
                child.kill("SIGKILL"); // The worker starts only after READY.
            }
            resolve(!ready || (code === 0 && confirmed));
        });
    });
    return { check, requestStop, verified };
}

async function verifyPosixGroup(pid: number, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
        const active = await new Promise<boolean>((resolve, reject) => {
            execFile("ps", ["-ax", "-o", "pgid=", "-o", "stat="], { timeout: 1000 }, (error, stdout) => {
                if (error) { reject(error); return; }
                resolve(stdout.split("\n").some((line) => {
                    const [group, status] = line.trim().split(/\s+/);
                    return Number(group) === pid && status && !status.startsWith("Z");
                }));
            });
        });
        if (!active) return;
        await delay(25);
    }
    throw new Error("本地观察进程组仍有活动成员");
}

export function startLocalObservation(shell: string, command: string, cwd?: string, env?: NodeJS.ProcessEnv): {
    child: ChildProcess;
    started: Promise<void>;
    onExit(listener: (code: number | null) => void): void;
    onDrained(listener: (bytes: OutputBytes) => void): void;
    retireWhenIdle(): void;
    requestStop(signal?: "SIGTERM" | "SIGKILL"): void;
    waitForStop(deadline: number): Promise<void>;
} {
    const child = spawn(process.execPath, ["-e", supervisorScript, "--", shell, command], {
        cwd, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32", windowsHide: true,
    });
    let onDrained: ((bytes: OutputBytes) => void) | undefined;
    let onExit: ((code: number | null) => void) | undefined;
    const processState = watchLocalProcess(child);
    let job: ReturnType<typeof watchWindowsJob> | undefined;
    const started = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("本地观察进程启动超时")), 15_000);
        const fail = (error: Error) => { clearTimeout(deadline); reject(error); };
        child.once("error", fail);
        child.once("close", () => fail(new Error("本地观察进程已退出")));
        child.on("message", (raw) => {
            const message = raw as { type?: string; code?: number | null; error?: string } & Partial<OutputBytes>;
            if (message.type === "started") {
                clearTimeout(deadline);
                resolve();
            } else if (message.type === "failed") {
                fail(new Error(message.error ?? "本地 shell 启动失败"));
            } else if (message.type === "exit") {
                onExit?.(message.code ?? null);
            } else if (message.type === "drained" && message.stdoutBytes !== undefined && message.stderrBytes !== undefined) {
                onDrained?.({ stdoutBytes: message.stdoutBytes, stderrBytes: message.stderrBytes });
            }
        });
        const start = () => {
            if (child.connected) child.send({ type: "start-worker", env }, (error) => { if (error) fail(error); });
        };
        if (process.platform === "win32" && child.pid) {
            job = watchWindowsJob(child, start, fail);
        } else if (child.pid) {
            start();
        }
    });
    const pid = child.pid;
    return {
        child, started,
        onExit: (listener) => { onExit = listener; },
        onDrained: (listener) => { onDrained = listener; },
        retireWhenIdle: () => {
            if (job) job.check();
            else if (child.connected) child.send("output-consumed", () => {});
        },
        requestStop: (signal = "SIGKILL") => {
            if (job) { job.requestStop(); return; }
            if (!pid || processState.exited()) return;
            // Signal while the owned group leader is live. Later checks only read group state.
            try { process.kill(-pid, signal); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        },
        waitForStop: async (deadline) => {
            await processState.finished;
            if (job) {
                if (!await job.verified) throw new Error("Windows Job Object 终止未得到确认");
            } else if (pid) {
                await verifyPosixGroup(pid, deadline);
            }
        },
    };
}
