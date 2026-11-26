/**
 * ssh-forward.test.ts — 动态端口转发双路径内核与栈接线测试（REQ-0005 Phase 1）
 */
import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { PassThrough } from "node:stream";
import {
    SshForwardManager,
    normalizeForwardSpec,
    renderDynamicForwardSpec,
    parseMuxAllocatedPort,
    parseSubprocessRemotePort,
    buildInnerTcpBridgeCmd,
    type ForwardInfo,
} from "../src/ssh-forward.js";
import { renderEnterBridgeCommand, sshArgsFor } from "../src/ssh-helpers.js";
import { SshPtyDriver } from "../src/ssh-pty-driver.js";
import { LocalRuntimeDriver } from "../src/local-driver.js";
import { RuntimeStack } from "../src/runtime-stack.js";

class MockChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 42424;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    signals: NodeJS.Signals[] = [];

    constructor(private readonly onKill?: (sig: NodeJS.Signals, self: MockChild) => void) {
        super();
    }

    kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
        this.signals.push(signal);
        this.onKill?.(signal, this);
        return true;
    }

    finish(code: number | null, signal: NodeJS.Signals | null = null): void {
        this.exitCode = code;
        this.signalCode = signal;
        this.emit("exit", code, signal);
        this.emit("close", code, signal);
    }
}

describe("ssh-forward spec normalization & rendering", () => {
    test("supports local/remote/dynamic, short aliases, default bindAddr, and IPv6 bracketing", () => {
        const l = normalizeForwardSpec({ kind: "L", bindPort: 8080, targetHost: "db.internal", targetPort: 5432 });
        expect(l.kind).toBe("local");
        expect(l.flag).toBe("-L");
        expect(l.bindAddr).toBe("127.0.0.1");
        expect(renderDynamicForwardSpec(l)).toBe("127.0.0.1:8080:db.internal:5432");

        const r = normalizeForwardSpec({ kind: "remote", bindAddr: "*", bindPort: 9000, targetHost: "::1", targetPort: 3000 });
        expect(r.flag).toBe("-R");
        expect(renderDynamicForwardSpec(r)).toBe("*:9000:[::1]:3000");

        const d = normalizeForwardSpec({ kind: "D", bindAddr: "[::1]", bindPort: 1080 });
        expect(d.kind).toBe("dynamic");
        expect(d.bindAddr).toBe("::1");
        expect(renderDynamicForwardSpec(d)).toBe("[::1]:1080");

        const omittedL = normalizeForwardSpec({ kind: "L", targetHost: "db.internal", targetPort: 5432 });
        expect(omittedL.bindPort).toBe(0);
        const omittedR = normalizeForwardSpec({ kind: "R", targetHost: "127.0.0.1", targetPort: 3000 });
        expect(omittedR.bindPort).toBe(0);
        const omittedD = normalizeForwardSpec({ kind: "D" });
        expect(omittedD.bindPort).toBe(0);
    });

    test("rejects invalid hosts, ports, ids, and injection payloads", () => {
        expect(() => normalizeForwardSpec({ kind: "invalid" as never, bindPort: 80 })).toThrow();
        expect(() => normalizeForwardSpec({ kind: "D", bindPort: "auto" as never })).toThrow(/必须为整数/);
        expect(() => normalizeForwardSpec({ kind: "L", bindAddr: "-evil", bindPort: 80, targetHost: "h", targetPort: 80 })).toThrow();
        expect(() => normalizeForwardSpec({ kind: "L", bindAddr: "127.0.0.1;id", bindPort: 80, targetHost: "h", targetPort: 80 })).toThrow();
        expect(() => normalizeForwardSpec({ kind: "L", bindPort: -1, targetHost: "h", targetPort: 80 })).toThrow();
        expect(() => normalizeForwardSpec({ kind: "L", bindPort: 70000, targetHost: "h", targetPort: 80 })).toThrow();
        expect(() => normalizeForwardSpec({ kind: "L", bindPort: 80, targetHost: "-h", targetPort: 80 })).toThrow();
        expect(() => normalizeForwardSpec({ kind: "R", bindPort: 80, targetHost: "h", targetPort: 0 })).toThrow();
        expect(() => normalizeForwardSpec({ kind: "D", bindPort: 1080, id: "bad id!" })).toThrow();
    });

    test("parses allocated ports from mux and subprocess outputs", () => {
        expect(parseMuxAllocatedPort("43210\n", "")).toBe(43210);
        expect(parseMuxAllocatedPort("", "Allocated port 51234 for remote forward.\n")).toBe(51234);
        expect(parseMuxAllocatedPort("0\n", "")).toBeUndefined();
        expect(parseSubprocessRemotePort("debug1: Allocated port 49152 for remote forward to localhost:3000")).toBe(49152);
    });
});

describe("SshForwardManager Path A (Mux -O forward / -O cancel)", () => {
    test("uses mux when control socket check succeeds, handles remote port 0, and closes with exact port", async () => {
        const calls: string[][] = [];
        const mgr = new SshForwardManager({
            destArgs: ["ops@example.com"],
            layerName: "prod",
            _deps: {
                muxControlPath: () => "/tmp/cm-prod",
                execSsh: async (argv) => {
                    calls.push(argv);
                    if (argv.includes("check")) return { exitCode: 0, stdout: "Master running\n", stderr: "" };
                    if (argv.includes("forward")) return { exitCode: 0, stdout: "43210\n", stderr: "" };
                    if (argv.includes("cancel")) return { exitCode: 0, stdout: "", stderr: "" };
                    return { exitCode: 1, stdout: "", stderr: "unexpected" };
                },
            },
        });

        const info = await mgr.openForward({
            id: "r-dyn",
            kind: "remote",
            targetHost: "127.0.0.1",
            targetPort: 3000,
        });
        expect(info.transportMode).toBe("mux");
        expect(info.bindPort).toBe(43210);
        expect(info.status).toBe("active");
        expect(calls[1]).toEqual(["-S", "/tmp/cm-prod", "-O", "forward", "-R", "127.0.0.1:0:127.0.0.1:3000", "ops@example.com"]);

        const closed = await mgr.closeForward("r-dyn");
        expect(closed).toEqual({ status: "stopped", forwardId: "r-dyn" });
        expect(calls[2]).toEqual(["-S", "/tmp/cm-prod", "-O", "cancel", "-R", "127.0.0.1:43210:127.0.0.1:3000", "ops@example.com"]);

        const again = await mgr.closeForward("r-dyn");
        expect(again).toEqual({ status: "already_closed", forwardId: "r-dyn" });
    });

    test("rejects mux remote bindPort=0 when allocated port cannot be parsed", async () => {
        const mgr = new SshForwardManager({
            destArgs: ["ops@example.com"],
            _deps: {
                muxControlPath: () => "/tmp/cm-prod",
                execSsh: async (argv) => argv.includes("check")
                    ? { exitCode: 0, stdout: "", stderr: "" }
                    : { exitCode: 0, stdout: "ok", stderr: "" },
            },
        });

        await expect(mgr.openForward({ kind: "R", bindPort: 0, targetHost: "localhost", targetPort: 80 })).rejects.toThrow(/未能解析/);
    });

    test("reports already_closed and unknown honestly on mux -O cancel", async () => {
        let cancelMode: "not_found" | "broken" | "missing_socket" = "not_found";
        const mgr = new SshForwardManager({
            destArgs: ["ops@example.com"],
            _deps: {
                muxControlPath: () => "/tmp/cm-prod",
                execSsh: async (argv) => {
                    if (argv.includes("check") || argv.includes("forward")) return { exitCode: 0, stdout: "", stderr: "" };
                    if (cancelMode === "not_found") return { exitCode: 255, stdout: "", stderr: "mux_client_forward: forward not found" };
                    if (cancelMode === "missing_socket") {
                        return { exitCode: 255, stdout: "", stderr: "Control socket connect(/tmp/cm-prod): No such file or directory" };
                    }
                    return { exitCode: 255, stdout: "", stderr: "Control socket connect(/tmp/cm-prod): Connection refused" };
                },
            },
        });

        const f1 = await mgr.openForward({ kind: "D", bindPort: 1080 });
        expect(await mgr.closeForward(f1.forwardId)).toEqual({
            status: "already_closed",
            forwardId: f1.forwardId,
            detail: "mux_client_forward: forward not found",
        });

        cancelMode = "broken";
        const f2 = await mgr.openForward({ kind: "D", bindPort: 1081 });
        const res2 = await mgr.closeForward(f2.forwardId);
        expect(res2.status).toBe("unknown");
        expect(res2.detail).toContain("Connection refused");
        expect(mgr.listForwards().find((f) => f.forwardId === f2.forwardId)?.status).toBe("unknown");

        cancelMode = "missing_socket";
        const res3 = await mgr.closeForward(f2.forwardId);
        expect(res3.status).toBe("unknown");
        expect(res3.detail).toContain("No such file or directory");
        expect(mgr.listForwards().find((f) => f.forwardId === f2.forwardId)?.status).toBe("unknown");
    });
});

describe("SshForwardManager Path B (Subprocess ssh -N fallback)", () => {
    test("reports a confirmed SSH exit before returning a newly opened forward", async () => {
        const manager = new SshForwardManager({ destArgs: ["fixture.invalid"], _deps: {
            muxControlPath: () => undefined,
            spawnSsh: () => {
                const child = new MockChild();
                setTimeout(() => {
                    child.stderr.write("debug1: Entering interactive session.\n");
                    child.finish(255);
                }, 5);
                return child as unknown as ChildProcess;
            },
        } });
        await expect(manager.openForward({ id: "exited-during-start", kind: "D", bindPort: 18081 }))
            .rejects.toMatchObject({ forwardId: "exited-during-start", exitCode: 255 });
        expect(manager.listForwards()).toMatchObject([{ forwardId: "exited-during-start", status: "exited" }]);
    });

    test.each([true, false])("closeAll verifies a starting child that ignores SIGTERM (SIGKILL works: %s)", async (killWorks) => {
        let finishOnKill = killWorks;
        let onSpawn!: () => void;
        const spawned = new Promise<void>((resolve) => { onSpawn = resolve; });
        const child = new MockChild((signal, self) => {
            if (signal === "SIGKILL" && finishOnKill) self.finish(0, signal);
        });
        const mgr = new SshForwardManager({ destArgs: ["fixture.invalid"], _deps: {
            muxControlPath: () => undefined,
            spawnSsh: () => { onSpawn(); return child as unknown as ChildProcess; },
            stopGraceMs: 15, killWaitMs: 20,
        } });
        const opening = mgr.openForward({ id: "pending-close", kind: "L", bindPort: 18103, targetHost: "localhost", targetPort: 80 });
        void opening.catch(() => undefined);
        try {
            await spawned;
            const result = await mgr.closeAll();
            expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
            expect(result).toMatchObject([{ forwardId: "pending-close", status: killWorks ? "stopped" : "unknown" }]);
            if (killWorks) {
                await expect(opening).rejects.toThrow(/已取消/);
            } else {
                await expect(opening).rejects.toMatchObject({ outcome: "unknown", forwardId: "pending-close" });
                expect(mgr.listForwards()).toMatchObject([{ forwardId: "pending-close", status: "unknown" }]);
                finishOnKill = true;
                await expect(mgr.closeForward("pending-close")).resolves.toMatchObject({ status: "stopped" });
                expect(mgr.listForwards()).toEqual([]);
            }
        } finally {
            if (child.exitCode === null) child.finish(0);
            await opening.catch(() => undefined);
        }
    });

    test("falls back to subprocess when mux check fails, allocates local port=0, and strips static forwards", async () => {
        const spawnedArgvs: string[][] = [];
        const connParams = {
            user: "ops",
            port: 2222,
            hostKeyPolicy: "strict" as const,
            forwards: [{ kind: "L" as const, port: 9999, target: "localhost:99" }],
        };
        const mgr = new SshForwardManager({
            destArgs: sshArgsFor({ host: "host.test", conn: { ...connParams, forwards: undefined } }),
            muxDestArgs: sshArgsFor({ host: "host.test", conn: connParams }),
            connParams,
            _deps: {
                muxControlPath: () => "/tmp/cm-missing",
                execSsh: async () => ({ exitCode: 255, stdout: "", stderr: "not running" }),
                spawnSsh: (argv) => {
                    spawnedArgvs.push(argv);
                    const child = new MockChild((sig, self) => {
                        if (sig === "SIGTERM") self.finish(0, "SIGTERM");
                    });
                    setTimeout(() => {
                        child.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port 12345.\ndebug1: Entering interactive session.\r\n");
                    }, 5);
                    return child as unknown as ChildProcess;
                },
            },
        });

        const info = await mgr.openForward({ kind: "L", bindPort: 0, targetHost: "db", targetPort: 5432 });
        expect(info.transportMode).toBe("subprocess");
        expect(info.bindPort).toBeGreaterThan(0);
        expect(info.bindPort).toBeLessThanOrEqual(65535);
        expect(spawnedArgvs[0]).toContain("-N");
        expect(spawnedArgvs[0]).toContain("ExitOnForwardFailure=yes");
        expect(spawnedArgvs[0]).toContain("StrictHostKeyChecking=yes");
        expect(spawnedArgvs[0]).not.toContain("9999:localhost:99");

        expect(await mgr.closeForward(info.forwardId)).toEqual({ status: "stopped", forwardId: info.forwardId });
    });

    test("opens remote port=0 via subprocess stderr Allocated port and handles unexpected exit", async () => {
        let childRef!: MockChild;
        const exits: ForwardInfo[] = [];
        const mgr = new SshForwardManager({
            destArgs: ["ops@example.com"],
            onForwardExit: (info) => exits.push(info),
            _deps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    childRef = new MockChild();
                    setTimeout(() => {
                        childRef.stderr.write("debug1: Allocated port 55123 for remote forward to localhost:8000\n");
                    }, 5);
                    return childRef as unknown as ChildProcess;
                },
            },
        });

        const info = await mgr.openForward({ kind: "remote", bindPort: 0, targetHost: "localhost", targetPort: 8000 });
        expect(info.bindPort).toBe(55123);

        childRef.finish(255);
        expect(exits.length).toBe(1);
        expect(exits[0]?.status).toBe("exited");
        expect(exits[0]?.exitCode).toBe(255);
        expect(await mgr.closeForward(info.forwardId)).toEqual({ status: "already_closed", forwardId: info.forwardId });
    });

    test("does not interpret an occupied port or a bind attempt as successful forwarding", async () => {
        const occupied = net.createServer((socket) => socket.destroy());
        await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
        const port = (occupied.address() as net.AddressInfo).port;
        try {
            const manager = new SshForwardManager({ destArgs: ["fixture.invalid"], _deps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    const child = new MockChild((_signal, self) => self.finish(0));
                    setTimeout(() => child.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.\n`), 5);
                    return child as unknown as ChildProcess;
                },
            } });
            await expect(manager.openForward({ kind: "D", bindPort: port, timeoutMs: 150 })).rejects.toThrow(/启动超时/);
            expect(manager.listForwards()).toEqual([]);
        } finally {
            await new Promise<void>((resolve) => occupied.close(() => resolve()));
        }
    });

    test("waits for remote forwarding confirmation after entering the client loop", async () => {
        const mgrFail = new SshForwardManager({
            destArgs: ["ops@example.com"],
            _deps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    const c = new MockChild();
                    setTimeout(() => {
                        c.stderr.write("debug1: Entering interactive session.\nError: remote port forwarding failed for listen port 8080\n");
                        c.finish(255);
                    }, 5);
                    return c as unknown as ChildProcess;
                },
            },
        });
        await expect(mgrFail.openForward({ kind: "R", bindPort: 8080, targetHost: "localhost", targetPort: 80 }))
            .rejects.toThrow(/remote port forwarding failed/);

        const manager = new SshForwardManager({ destArgs: ["fixture.invalid"], _deps: {
            muxControlPath: () => undefined,
            spawnSsh: () => {
                const child = new MockChild((_signal, self) => self.finish(0));
                setTimeout(() => child.stderr.write(
                    "debug1: Entering interactive session.\ndebug1: remote forward success for: listen 127.0.0.1:8081, connect localhost:80\n",
                ), 5);
                return child as unknown as ChildProcess;
            },
        } });
        await expect(manager.openForward({ kind: "R", bindPort: 8081, targetHost: "localhost", targetPort: 80 }))
            .resolves.toMatchObject({ status: "active", bindPort: 8081 });
        await manager.closeAll();
    });

    test("escalates SIGTERM to SIGKILL and reports unknown when child refuses to exit", async () => {
        let childKillRef!: MockChild;
        const mgrKill = new SshForwardManager({
            destArgs: ["ops@example.com"],
            _deps: {
                muxControlPath: () => undefined,
                stopGraceMs: 15,
                killWaitMs: 50,
                spawnSsh: () => {
                    childKillRef = new MockChild((sig, self) => {
                        if (sig === "SIGKILL") self.finish(null, "SIGKILL");
                    });
                    setTimeout(() => childKillRef.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port 7001.\ndebug1: Entering interactive session.\n"), 5);
                    return childKillRef as unknown as ChildProcess;
                },
            },
        });
        const f1 = await mgrKill.openForward({ kind: "L", bindPort: 7001, targetHost: "db", targetPort: 5432 });
        expect(await mgrKill.closeForward(f1.forwardId)).toEqual({ status: "stopped", forwardId: f1.forwardId });
        expect(childKillRef.signals).toEqual(["SIGTERM", "SIGKILL"]);

        const mgrStuck = new SshForwardManager({
            destArgs: ["ops@example.com"],
            _deps: {
                muxControlPath: () => undefined,
                stopGraceMs: 15,
                killWaitMs: 20,
                spawnSsh: () => {
                    const c = new MockChild();
                    setTimeout(() => c.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port 7002.\ndebug1: Entering interactive session.\n"), 5);
                    return c as unknown as ChildProcess;
                },
            },
        });
        const f2 = await mgrStuck.openForward({ kind: "L", bindPort: 7002, targetHost: "db", targetPort: 5432 });
        const stuckClose = await mgrStuck.closeForward(f2.forwardId);
        expect(stuckClose.status).toBe("unknown");
        expect(mgrStuck.listForwards()[0]?.status).toBe("unknown");
    });
});

describe("RuntimeStack & SshPtyDriver forward integration and boundaries", () => {
    test("rejects dynamic forwards on local layer, inherit file-stdio mode, and multi-hop PTY chains", async () => {
        const stack = new RuntimeStack();
        await stack.addLayer("local", new LocalRuntimeDriver());
        await expect(stack.openForward({ kind: "L", bindPort: 8080, targetHost: "db", targetPort: 5432 }, "local"))
            .rejects.toThrow(/不支持动态端口转发/);
        expect(stack.listForwards("local")).toEqual([]);

        const hopDriver = new SshPtyDriver({
            driver: "ssh",
            target: "bastion",
            config: { sshHops: ["inner"] },
        });
        await expect(hopDriver.openForward({ kind: "L", bindPort: 8080, targetHost: "db", targetPort: 5432 }))
            .rejects.toThrow(/逐跳 PTY 登录链不可用/);

        const prevMode = process.env.FILAXIS_SSH_STDIO_MODE;
        process.env.FILAXIS_SSH_STDIO_MODE = "inherit";
        try {
            const inheritDriver = new SshPtyDriver({ driver: "ssh", target: "host" });
            await expect(inheritDriver.openForward({ kind: "L", bindPort: 8080, targetHost: "db", targetPort: 5432 }))
                .rejects.toThrow(/FILAXIS_SSH_STDIO_MODE=inherit/);
        } finally {
            if (prevMode === undefined) delete process.env.FILAXIS_SSH_STDIO_MODE;
            else process.env.FILAXIS_SSH_STDIO_MODE = prevMode;
        }
    });

    test("wires forward events, cross-layer list/close, and destroys active forwards on layer removal", async () => {
        let spawnedChild!: MockChild;
        const sshDriver = new SshPtyDriver({ driver: "ssh", target: "ops@app" }, {
            _forwardDeps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    spawnedChild = new MockChild((sig, self) => {
                        if (sig === "SIGTERM") self.finish(0, "SIGTERM");
                    });
                    setTimeout(() => {
                        spawnedChild.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port 8081.\ndebug1: Entering interactive session.\n");
                    }, 5);
                    return spawnedChild as unknown as ChildProcess;
                },
            },
        });

        const stack = new RuntimeStack();
        await stack.addLayer("app", sshDriver);
        const events: Array<{ type: string; layer?: string; forward?: ForwardInfo }> = [];
        stack.events.on("forwardExit", (e) => events.push(e as { type: string; layer?: string; forward?: ForwardInfo }));

        const f1 = await stack.openForward({ id: "web-8081", kind: "L", bindPort: 8081, targetHost: "127.0.0.1", targetPort: 80 });
        expect(f1.layer).toBe("app");
        expect(stack.listForwards().map((f) => f.forwardId)).toEqual(["web-8081"]);
        await expect(stack.closeForward("missing-id")).rejects.toThrow(/不存在/);

        await stack.removeLayer("app", { destroy: true });
        expect(spawnedChild.signals).toContain("SIGTERM");
        expect(sshDriver.listForwards()[0]?.status).toBe("stopped");
        expect(events).toEqual([]);
    });

    test("a forward can still be closed by ID after its last layer name is removed and reused", async () => {
        const driver = new SshPtyDriver({ driver: "ssh", target: "fixture.invalid" }, {
            _forwardDeps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    const child = new MockChild((signal, self) => { if (signal === "SIGTERM") self.finish(0, signal); });
                    setTimeout(() => child.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port 18082.\ndebug1: Entering interactive session.\n"), 5);
                    return child as unknown as ChildProcess;
                },
            },
        });
        const stack = new RuntimeStack();
        try {
            await stack.addLayer("fixture", driver);
            const spec = { id: "detached", kind: "L", bindPort: 18082, targetHost: "localhost", targetPort: 80 } as const;
            const { forwardId } = await stack.openForward(spec, "fixture");
            await stack.removeLayer("fixture");
            await stack.addLayer("fixture", new LocalRuntimeDriver());
            expect(stack.listForwards("fixture")).toEqual([]);
            expect(stack.listForwards()).toMatchObject([{ forwardId, status: "active" }]);
            expect(stack.listForwards()[0]).not.toHaveProperty("layer");
            await expect(stack.closeForward(forwardId)).resolves.toMatchObject({ status: "stopped" });
            expect(stack.listForwards()).toEqual([]);
        } finally {
            await driver.destroy();
        }
    });

    test("emits forwardExit event on RuntimeStack when managed tunnel exits unexpectedly", async () => {
        let spawnedChild!: MockChild;
        const sshDriver = new SshPtyDriver({ driver: "ssh", target: "ops@app" }, {
            _forwardDeps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    spawnedChild = new MockChild();
                    setTimeout(() => {
                        spawnedChild.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port 8082.\ndebug1: Entering interactive session.\n");
                    }, 5);
                    return spawnedChild as unknown as ChildProcess;
                },
            },
        });

        const stack = new RuntimeStack();
        await stack.addLayer("app", sshDriver);
        const events: Array<{ type: string; layer?: string; forward: ForwardInfo }> = [];
        stack.events.on("forwardExit", (e) => {
            if (e.type === "forwardExit") events.push(e);
        });

        await stack.openForward({ id: "tunnel-drop", kind: "L", bindPort: 8082, targetHost: "127.0.0.1", targetPort: 80 });
        spawnedChild.finish(1);

        expect(events.length).toBe(1);
        expect(events[0]?.layer).toBe("app");
        expect(events[0]?.forward.forwardId).toBe("tunnel-drop");
        expect(events[0]?.forward.status).toBe("exited");
    });

    test("rejects concurrent duplicate forwardId, reaps pending child on closeAll, tags mux timeout unknown, and rejects cross-layer duplicate id", async () => {
        // 1) Concurrent duplicate forwardId & closeAll reaping pending subprocess
        let pendingChild!: MockChild;
        const slowMgr = new SshForwardManager({
            destArgs: ["ops@slow"],
            _deps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    pendingChild = new MockChild((sig, self) => {
                        if (sig === "SIGTERM") self.finish(0, "SIGTERM");
                    });
                    return pendingChild as unknown as ChildProcess;
                },
            },
        });
        const p1 = slowMgr.openForward({ id: "dup-id", kind: "L", bindPort: 17001, targetHost: "db", targetPort: 5432 });
        const p2 = slowMgr.openForward({ id: "dup-id", kind: "L", bindPort: 17002, targetHost: "db", targetPort: 5432 });
        await expect(p2).rejects.toThrow(/已存在或正在建立/);
        await slowMgr.closeAll();
        await expect(p1).rejects.toThrow(/已关闭|建链失败/);
        expect(pendingChild.signals).toContain("SIGTERM");

        // 2) Mux timeout carries outcome: "unknown"
        const timeoutMgr = new SshForwardManager({
            destArgs: ["ops@mux"],
            _deps: {
                muxControlPath: () => "/tmp/cm-mux",
                execSsh: async (argv) => argv.includes("check")
                    ? { exitCode: 0, stdout: "ok", stderr: "" }
                    : { exitCode: null, stdout: "", stderr: "", timedOut: true },
            },
        });
        let muxErr: (Error & { outcome?: string }) | undefined;
        try {
            await timeoutMgr.openForward({ kind: "L", bindPort: 17003, targetHost: "db", targetPort: 5432 });
        } catch (e) {
            muxErr = e as Error & { outcome?: string };
        }
        expect(muxErr?.outcome).toBe("unknown");

        // 3) Cross-layer duplicate forwardId rejection in RuntimeStack
        const mkDrv = (target: string, port: number) => new SshPtyDriver({ driver: "ssh", target }, {
            _forwardDeps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    const c = new MockChild((sig, self) => {
                        if (sig === "SIGTERM") self.finish(0, "SIGTERM");
                    });
                    setTimeout(() => c.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.\ndebug1: Entering interactive session.\n`), 5);
                    return c as unknown as ChildProcess;
                },
            },
        });
        const stack = new RuntimeStack();
        await stack.addLayer("a", mkDrv("ops@a", 17010));
        await stack.addLayer("b", mkDrv("ops@b", 17011));
        await stack.openForward({ id: "shared-name", kind: "L", bindPort: 17010, targetHost: "db", targetPort: 5432 }, "a");
        await expect(
            stack.openForward({ id: "shared-name", kind: "L", bindPort: 17011, targetHost: "db", targetPort: 5432 }, "b"),
        ).rejects.toThrow(/已在层 'a' 中存在/);
        await stack.removeLayer("a", { destroy: true });
        await stack.removeLayer("b", { destroy: true });
    });

    test("tags forwardExit events with the emitting driver layer rather than the first bridged driver", async () => {
        const children: MockChild[] = [];
        const mkDrv = (target: string, port: number) => new SshPtyDriver({ driver: "ssh", target }, {
            _forwardDeps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    const c = new MockChild();
                    children.push(c);
                    setTimeout(() => c.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.\ndebug1: Entering interactive session.\n`), 5);
                    return c as unknown as ChildProcess;
                },
            },
        });
        const stack = new RuntimeStack();
        const events: Array<{ type: string; layer?: string; forward?: { forwardId: string; layer?: string; status: string } }> = [];
        stack.events.on("forwardExit", (e) => events.push(e as never));

        await stack.addLayer("layer-a", mkDrv("ops@a", 17020));
        await stack.addLayer("layer-b", mkDrv("ops@b", 17021));

        await stack.openForward({ id: "fwd-b", kind: "L", bindPort: 17021, targetHost: "db", targetPort: 5432 }, "layer-b");
        expect(children).toHaveLength(1);
        children[0]!.finish(255, null);

        expect(events).toHaveLength(1);
        expect(events[0]!.layer).toBe("layer-b");
        expect(events[0]!.forward).toMatchObject({ forwardId: "fwd-b", layer: "layer-b", status: "exited" });

        await stack.removeLayer("layer-a", { destroy: true });
        await stack.removeLayer("layer-b", { destroy: true });
    });
});

describe("enterPipeline layer-penetrating dynamic forwarding (stdio-bridge)", () => {
    test("renders binary-safe multi-layer argv bridge commands and rejects interactive steps", () => {
        const inner = buildInnerTcpBridgeCmd("python3", "127.0.0.1", 6379);
        const single = renderEnterBridgeCommand([{ cmd: "docker exec -it web bash" }], inner);
        expect(single.kind).toBe("ok");
        if (single.kind === "ok") {
            expect(single.command).toContain("'docker' 'exec' '-i' 'web' 'bash' '-c'");
            expect(single.command).not.toContain("-it");
        }

        const nested = renderEnterBridgeCommand([
            { cmd: "ssh -t vm-b" },
            { cmd: "docker exec -it app-ctr sh" },
        ], buildInnerTcpBridgeCmd("socat", "127.0.0.1", 8080));
        expect(nested.kind).toBe("ok");
        if (nested.kind === "ok") {
            // ssh 跳的 `sh -c <内层>` 必须整体再包一层引号（嵌套 ssh 会把参数按空格
            // 拼接，单层引号在跳板 sh 就被消费掉）
            expect(nested.command).toContain("'ssh' '-T' 'vm-b' 'sh -c");
            expect(nested.command).toContain("socat");
        }

        const quoted = renderEnterBridgeCommand([{ cmd: "ssh -tt -i '/tmp/key  -t name' vm-b" }], inner);
        expect(quoted).toMatchObject({ kind: "ok", command: expect.stringContaining("'ssh' '-T' '-i' '/tmp/key  -t name' 'vm-b'") });

        const bad = renderEnterBridgeCommand([{ cmd: "su - app" }], inner);
        expect(bad.kind).toBe("unreachable");
    });

    test("DSH 真机回归 2026-11-26：ssh 跳的引号层级 = 跳数 + 内层（裸 exec 终结 shell 案）", () => {
        // 真机病链：单层引号在跳板 sh 被消费 → 嵌套 ssh 空格拼接 → 目标收到
        // `sh -c exec ...` → dash 的裸 exec 直接退出 shell → python 桥根本没跑，
        // 转发 listener 活着但连接即断、零报错。钉住：每多一跳 ssh，内层多一层引号。
        const inner = buildInnerTcpBridgeCmd("python3", "127.0.0.1", 22);

        const oneHop = renderEnterBridgeCommand([{ cmd: "ssh root@10.0.0.12" }], inner);
        expect(oneHop.kind).toBe("ok");
        if (oneHop.kind === "ok") {
            // 末段是单个引号包裹的 `sh -c <内层>`（引号作为字符保留在参数里）
            expect(oneHop.command.startsWith("'ssh' '-T' 'root@10.0.0.12' ")).toBe(true);
            expect(oneHop.command).toContain("'sh -c");
            // 内层整体作为嵌套 ssh 的一个参数存在，不是裸拼的 'sh' '-c'
            expect(oneHop.command).not.toContain("'sh' '-c'");
            // 双重引号包裹：内层脚本与参数在两层转义后仍存活，且以目标参数收尾
            expect(oneHop.command).toContain("exec python3 -u -c");
            expect(oneHop.command).toContain("127.0.0.1");
            expect(oneHop.command).toMatch(/22'\\'''$/);
        }

        const twoHops = renderEnterBridgeCommand([
            { cmd: "ssh jump-a" },
            { cmd: "ssh -t 10.0.0.12" },
        ], inner);
        expect(twoHops.kind).toBe("ok");
        if (twoHops.kind === "ok") {
            // 两跳：`sh -c ` 出现两次（每跳一层）
            expect(twoHops.command.match(/sh -c /g)?.length).toBe(2);
            expect(twoHops.command).toContain("'sh -c");
        }
    });

    test("guards enterPipeline layers against -R/-D host leaks, missing tools, and interactive steps", async () => {
        const makeDrv = (enterCmd: string, probeOut = "socat", probeCode = 0) => new SshPtyDriver({
            driver: "ssh",
            target: "ops@host",
            config: { enterPipeline: [{ cmd: enterCmd }] },
        });

        const d1 = makeDrv("docker exec -it web bash");
        d1.exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });
        await expect(d1.openForward({ kind: "R", bindPort: 0, targetHost: "127.0.0.1", targetPort: 80 })).rejects.toThrow(/仅支持 -L/);
        await expect(d1.openForward({ kind: "D", bindPort: 0 })).rejects.toThrow(/仅支持 -L/);

        d1.exec = async () => ({ stdout: "", stderr: "", exitCode: 127 });
        await expect(d1.openForward({ kind: "L", bindPort: 0, targetHost: "127.0.0.1", targetPort: 80 })).rejects.toThrow(/socat/);

        const dBad = makeDrv("su - root");
        dBad.exec = async () => ({ stdout: "socat\n", stderr: "", exitCode: 0 });
        await expect(dBad.openForward({ kind: "L", bindPort: 0, targetHost: "127.0.0.1", targetPort: 80 })).rejects.toThrow(/无法建立穿层动态转发/);
    });

    test("forwards TCP traffic through stdio-bridge into target loopback port and cleans up on close", async () => {
        // Simulate a 3rd-layer container loopback TCP service on an ephemeral local port
        const echoServer = net.createServer((sock) => {
            sock.on("data", (chunk: Buffer | string) => {
                const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
                sock.write(Buffer.concat([Buffer.from("ctr:"), buf]));
            });
        });
        await new Promise<void>((resolve) => echoServer.listen(0, "127.0.0.1", () => resolve()));
        const containerPort = (echoServer.address() as net.AddressInfo).port;

        let capturedArgv: string[] = [];
        const drv = new SshPtyDriver({
            driver: "ssh",
            target: "ops@host",
            config: { enterPipeline: [{ cmd: "docker exec -it web bash" }] },
        }, {
            _forwardDeps: {
                spawnBridge: (argv) => {
                    capturedArgv = argv;
                    // Verify rendered remote command ends with node inner TCP bridge script, then execute the inner node bridge directly against containerPort
                    const remoteCmd = argv[argv.length - 1] ?? "";
                    expect(remoteCmd).toContain("docker");
                    expect(remoteCmd).toContain("-i");
                    expect(remoteCmd).toContain("node");
                    return spawn(process.execPath, [
                        "-e",
                        "const net=require('node:net');const s=net.createConnection({host:'127.0.0.1',port:Number(process.argv[1])});s.on('error',()=>process.exit(1));process.stdin.on('error',()=>s.destroy());process.stdout.on('error',()=>s.destroy());process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit(0));",
                        String(containerPort),
                    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
                },
            },
        });
        drv.exec = async () => ({ stdout: "node\n", stderr: "", exitCode: 0 });

        let client: net.Socket | undefined;
        try {
            const info = await drv.openForward({
                id: "ctr-db",
                kind: "L",
                targetHost: "127.0.0.1",
                targetPort: containerPort,
            });
            expect(info.transportMode).toBe("stdio-bridge");
            expect(info.bindPort).toBeGreaterThan(0);

            const reply = await new Promise<string>((resolve, reject) => {
                const c = net.createConnection({ host: "127.0.0.1", port: info.bindPort });
                client = c;
                c.once("error", reject);
                c.once("data", (d) => {
                    const text = d.toString("utf-8");
                    resolve(text);
                });
                c.write("hello-layer3");
            });
            expect(reply).toBe("ctr:hello-layer3");
            expect(capturedArgv).toContain("ops@host");

            const closed = await Promise.race([
                drv.closeForward("ctr-db"),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close waited for the client to disconnect")), 2_000).unref()),
            ]);
            expect(closed.status).toBe("stopped");
        } finally {
            client?.destroy();
            await drv.destroy().catch(() => undefined);
            await new Promise<void>((r) => echoServer.close(() => r()));
        }
    }, 15_000);

    test("真机回归 2026-11-26：桥接子进程未送出数据即退出时，死因（stderr 尾部）挂到转发记录上，不再无声", async () => {
        // 真机两次踩中：内层连不上目标端口（ConnectionRefused）/ 桥命令在远端没跑起来，
        // stderr 里写得清清楚楚，但产品把它丢弃——外面只看到连接立刻断开、零报错。
        let failToSpawn = false;
        const drv = new SshPtyDriver({
            driver: "ssh",
            target: "ops@host",
            config: { enterPipeline: [{ cmd: "docker exec -it web bash" }] },
        }, {
            _forwardDeps: {
                spawnBridge: () => {
                    if (failToSpawn) throw new Error("bridge unavailable");
                    return spawn(process.execPath, [
                        "-e",
                        "process.stderr.write('Traceback (most recent call last):\\nConnectionRefusedError: [Errno 111] Connection refused\\n');process.exit(2);",
                    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
                },
            },
        });
        drv.exec = async () => ({ stdout: "node\n", stderr: "", exitCode: 0 });
        const info = await drv.openForward({ id: "ctr-dead", kind: "L", targetHost: "127.0.0.1", targetPort: 22 });
        expect(info.transportMode).toBe("stdio-bridge");
        // 连一下触发桥子进程；连接会被关闭
        const connectAndWait = () => new Promise<void>((resolve) => {
            const c = net.createConnection({ host: "127.0.0.1", port: info.bindPort });
            c.on("error", () => undefined);
            c.once("close", () => resolve());
            c.once("connect", () => c.write("x"));
        });
        try {
            await connectAndWait();
            await new Promise((r) => setTimeout(r, 300));
            const listed = drv.listForwards().find((f) => f.forwardId === "ctr-dead");
            expect(listed?.lastError).toContain("未送出数据即退出");
            expect(listed?.lastError).toContain("ConnectionRefusedError");
            failToSpawn = true;
            await connectAndWait();
            expect(drv.listForwards()[0]?.lastError).toContain("bridge unavailable");
        } finally {
            await drv.destroy();
        }
    }, 15_000);

    test("keeps a disconnected bridge child addressable until its exit is verified", async () => {
        let spawned!: () => void;
        let killAttempted!: () => void;
        const childStarted = new Promise<void>((resolve) => { spawned = resolve; });
        const kill = new Promise<void>((resolve) => { killAttempted = resolve; });
        const child = new MockChild((signal) => {
            if (signal === "SIGKILL") killAttempted();
        });
        const drv = new SshPtyDriver({
            driver: "ssh", target: "fixture.invalid",
            config: { enterPipeline: [{ cmd: "docker exec -i fixture sh" }] },
        }, {
            _forwardDeps: {
                spawnBridge: () => { spawned(); return child as unknown as ChildProcess; },
                stopGraceMs: 15,
                killWaitMs: 20,
            },
        });
        drv.exec = async () => ({ stdout: "node\n", stderr: "", exitCode: 0 });
        let client: net.Socket | undefined;
        try {
            const info = await drv.openForward({ id: "disconnect", kind: "L", targetHost: "127.0.0.1", targetPort: 8080 });
            client = net.createConnection({ host: "127.0.0.1", port: info.bindPort });
            await childStarted;
            client.destroy();
            await kill;
            await expect(drv.closeForward("disconnect")).resolves.toMatchObject({ status: "unknown" });
            child.finish(0, "SIGKILL");
            await expect(drv.closeForward("disconnect")).resolves.toMatchObject({ status: "stopped" });
        } finally {
            client?.destroy();
            if (child.exitCode === null) child.finish(0);
            await drv.destroy();
        }
    }, 15_000);

    test("[P1] blocks cross-layer concurrent duplicate forwardId before async open settles", async () => {
        const mkSlowDrv = (target: string, port: number) => new SshPtyDriver({ driver: "ssh", target }, {
            _forwardDeps: {
                muxControlPath: () => undefined,
                spawnSsh: () => {
                    const c = new MockChild((sig, self) => {
                        if (sig === "SIGTERM") self.finish(0, "SIGTERM");
                    });
                    setTimeout(() => c.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.\ndebug1: Entering interactive session.\n`), 50);
                    return c as unknown as ChildProcess;
                },
            },
        });
        const stack = new RuntimeStack();
        await stack.addLayer("a", mkSlowDrv("ops@a", 17110));
        await stack.addLayer("b", mkSlowDrv("ops@b", 17111));

        try {
            const pA = stack.openForward({ id: "race-id", kind: "L", bindPort: 17110, targetHost: "db", targetPort: 5432 }, "a");
            const pB = stack.openForward({ id: "race-id", kind: "L", bindPort: 17111, targetHost: "db", targetPort: 5432 }, "b");

            await expect(pB).rejects.toThrow(/正在层 'a' 中建立/);
            const infoA = await pA;
            expect(infoA).toMatchObject({ forwardId: "race-id", layer: "a", status: "active" });

            const closed = await stack.closeForward("race-id");
            expect(closed.status).toBe("stopped");
            expect(stack.listForwards().filter((f) => f.status === "active")).toHaveLength(0);
        } finally {
            await stack.removeLayer("a", { destroy: true });
            await stack.removeLayer("b", { destroy: true });
        }
    });
});
