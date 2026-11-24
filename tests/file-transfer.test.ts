/**
 * 文件传输单测（AC-15：mock 远端 bash 语义——真机 sftp/OPNsense/Alpine 属 CI 矩阵）
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readlinkSync, rmSync, existsSync, statSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { LocalRuntimeDriver } from "../src/local-driver.js";
import { transferLayerFile } from "../src/layer-file-transfer.js";
import { putFile, putContent, getFile, sftpPutFile, sftpGetFile, TransferVerificationError, type TransferExec, type SftpSpawnImpl } from "../src/file-transfer.js";
import { probeDialect, NULL_DIALECT, type RemoteDialect } from "../src/dialect.js";

const GNU: RemoteDialect = {
    family: "gnu",
    base64Encode: ["base64", "-w", "0"],
    base64Decode: ["base64", "-d"],
    sha256: ["sha256sum"],
};

test("local upload and download audit only operation metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-transfer-audit-"));
    const audit = join(dir, "audit");
    const driver = new LocalRuntimeDriver({ cwd: dir, execDir: audit });
    const payload = Buffer.concat([Buffer.from("synthetic-audit-only-fixture"), Buffer.from([0, 255, 128])]);
    const source = join(dir, "source.bin");
    const destination = join(dir, "download.bin");
    const layerPath = "layer copy.bin";
    try {
        writeFileSync(source, payload);
        for (const [operation, localPath] of [["put", source], ["get", destination]] as const) {
            const result = await transferLayerFile(driver, operation, { localPath, remotePath: layerPath });
            expect(result).toMatchObject({ bytes: payload.length, verification: "sha256" });
        }
        expect(readFileSync(destination)).toEqual(payload);
        const files = readdirSync(audit);
        expect(files.length).toBeGreaterThan(0);
        const labels = new Set<string>();
        for (const name of files) {
            expect(name).toEndWith(".status.json");
            const contents = readFileSync(join(audit, name), "utf-8");
            expect(contents).not.toContain(payload.toString("base64"));
            expect(contents).not.toContain("synthetic-audit-only-fixture");
            const status = JSON.parse(contents);
            expect(status).toMatchObject({ status: "completed", exitCode: expect.any(Number) });
            labels.add(status.command);
        }
        expect(labels).toEqual(new Set(["file upload", "file download"]));
    } finally {
        await driver.destroy();
        rmSync(dir, { recursive: true, force: true });
    }
}, 45_000);

/**
 * mock 远端：内存文件系统 + bash 语义回放（printf append / base64 -d / wc -c /
 * sha256sum / rm / base64 -w 0 编码）。put 走 printf 分块真实拼接路径。
 */
function mockRemote() {
    const files = new Map<string, Buffer>();
    const exec: TransferExec = async (cmd) => {
        if (cmd.startsWith("(umask 077; case \"$(uname -s)\"") || cmd.startsWith("rmdir ")) return { stdout: "", exitCode: 0 };
        const m = cmd.match(/^\(umask 077; printf %s '([^']*)' >> '(.+)'\)$/);
        if (m) {
            const prev = files.get(m[2]!) ?? Buffer.alloc(0);
            // printf %s 的字面量即 base64 文本
            files.set(m[2]!, Buffer.concat([prev, Buffer.from(m[1]!, "utf-8")]));
            return { stdout: "", exitCode: 0 };
        }
        if (cmd.startsWith("rm -f ")) {
            // 多参数形态（rm -f 'a' 'b'）逐个删——真实 shell 语义
            for (const f of cmd.slice(6).match(/'([^']*)'/g) ?? []) files.delete(f.slice(1, -1));
            return { stdout: "", exitCode: 0 };
        }
        let mm = cmd.match(/^\(umask 077; : > '(.+)'\)$/);
        if (mm) {
            files.set(mm[1]!, Buffer.alloc(0)); // 空文件临时（Astra 六轮 #2）
            return { stdout: "", exitCode: 0 };
        }
        mm = cmd.match(/^test -d '(.+)'$/);
        if (mm) {
            // mock 文件系统无目录概念——一律非目录（真实目录语义由真实 shell 回归覆盖）
            return { stdout: "", exitCode: 1 };
        }
        // 落位三态形态（十八轮 #2 + 审计 H5 前缀）：test ! -d … || …;
        // { __fx_tgt=$(readlink -f …); chmod/chown --reference…; if mv src …; }——
        // mock 无挂载无写入失败，mv 恒成功。Sol 87→89 前缀渐长（权限保持/目录
        // 四防/设备分流）——不再锚定全前缀：目标取外层 test ! -d 捕获、源取
        // `if mv …` 捕获；mock 无设备概念恒走同设备 rename 链
        const tgtM = cmd.match(/^\( test ! -d '(.+?)' \|\|/);
        const movePrefix = ["if mv -T '", "if mv '"].find((prefix) => cmd.includes(prefix));
        const moveStart = movePrefix ? cmd.indexOf(movePrefix) + movePrefix.length : -1;
        const moveEnd = moveStart >= 0 ? cmd.indexOf("' \"$__fx_tgt\"", moveStart) : -1;
        if (moveEnd > moveStart) {
            const from = cmd.slice(moveStart, moveEnd);
            const b = files.get(from);
            if (!b) return { stdout: "", exitCode: 1 }; // 源不存在 → 真实 mv 报错
            files.set(tgtM?.[1] ?? "", b);
            files.delete(from);
            return { stdout: "FX_MV_OK", exitCode: 0 };
        }
        // forceInplace 形态（显式请求保留 inode 写）——cat src > "$tgt" && rm src
        mm = cmd.match(/< '([^']+\/payload-[0-9a-f]+)'; then :; else echo FX_NO_PAYLOAD; fi/);
        if (tgtM && mm) {
            const b = files.get(mm[1]!);
            if (!b) return { stdout: "", exitCode: 1 };
            files.set(tgtM[1]!, b);
            files.delete(mm[1]!);
            return { stdout: "FX_MV_CAT", exitCode: 0 };
        }
        mm = cmd.match(/^\(umask 077; base64 -d < '([^']*)' > '([^']*)'\)$/);
        if (mm) {
            const src = files.get(mm[1]!);
            if (!src) return { stdout: "", exitCode: 1 }; // 真实 shell：源不存在 decode 失败（Astra 六轮 #2 mock 失真根因）
            files.set(mm[2]!, Buffer.from(src.toString("utf-8"), "base64"));
            return { stdout: "", exitCode: 0 };
        }
        mm = cmd.match(/^base64 -w 0 < '(.+)'$/);
        if (mm) {
            const buf = files.get(mm[1]!);
            if (!buf) return { stdout: "", exitCode: 1 };
            return { stdout: buf.toString("base64"), exitCode: 0 };
        }
        mm = cmd.match(/^wc -c < '(.+)'$/);
        if (mm) {
            const buf = files.get(mm[1]!);
            if (!buf) return { stdout: "", exitCode: 1 };
            return { stdout: `${buf.length}`, exitCode: 0 };
        }
        mm = cmd.match(/^sha256sum < '(.+)'$/);
        if (mm) {
            const buf = files.get(mm[1]!);
            if (!buf) return { stdout: "", exitCode: 1 };
            return { stdout: `${createHash("sha256").update(buf).digest("hex")}  -`, exitCode: 0 };
        }
        if (cmd.includes(" && rm -f ")) return { stdout: "", exitCode: 0 };
        return { stdout: "", exitCode: 127 };
    };
    return { exec, files };
}

describe("putFile/getFile（AC-15）", () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-ft-"));

    test("put→get roundtrip：分块传输 + size/sha256 双校验通过", async () => {
        const remote = mockRemote();
        const local = join(dir, "src.bin");
        // >96KB 内容触发多分块（CHUNK_B64=48K base64 字符）
        const payload = Buffer.alloc(80 * 1024);
        for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
        writeFileSync(local, payload);

        const r1 = await putFile(remote.exec, GNU, local, "/remote/dst.bin");
        expect(r1.verified).toBe(true);
        expect(r1.verification).toBe("sha256"); // 校验等级显式（Astra 六轮 #3）
        expect(r1.bytes).toBe(80 * 1024);
        expect(Buffer.compare(remote.files.get("/remote/dst.bin")!, payload)).toBe(0);

        const back = join(dir, "back.bin");
        const r2 = await getFile(remote.exec, GNU, "/remote/dst.bin", back);
        expect(r2.verified).toBe(true);
        expect(r2.verification).toBe("sha256");
        expect(Buffer.compare(readFileSync(back), payload)).toBe(0);
    });

    test("空文件与二进制安全（UTF-8 字符串不损坏）", async () => {
        const remote = mockRemote();
        const local = join(dir, "txt.txt");
        writeFileSync(local, "hello 牵丝 Filaxis 🧵", "utf-8");
        await putFile(remote.exec, GNU, local, "/r/t.txt");
        expect(remote.files.get("/r/t.txt")!.toString("utf-8")).toBe("hello 牵丝 Filaxis 🧵");
        const local2 = join(dir, "empty.bin");
        writeFileSync(local2, Buffer.alloc(0));
        const r = await putFile(remote.exec, GNU, local2, "/r/e.bin");
        expect(r.verified).toBe(true);
    });

    test("size 不一致 → TransferVerificationError（不静默成功）", async () => {
        const remote = mockRemote();
        const local = join(dir, "tamper.bin");
        writeFileSync(local, Buffer.from("0123456789"));
        // 篡改 mock：wc 返回假 size
        const evil: TransferExec = async (cmd) => {
            if (cmd.includes("wc -c")) return { stdout: "999", exitCode: 0 };
            return remote.exec(cmd);
        };
        await expect(putFile(evil, GNU, local, "/r/x.bin")).rejects.toThrow(TransferVerificationError);
    });

    test("sha256 不一致 → 校验失败", async () => {
        const remote = mockRemote();
        const local = join(dir, "sha.bin");
        writeFileSync(local, Buffer.from("abc"));
        const evil: TransferExec = async (cmd) => {
            if (cmd.includes("sha256sum")) return { stdout: "deadbeef".repeat(8), exitCode: 0 };
            return remote.exec(cmd);
        };
        await expect(putFile(evil, GNU, local, "/r/y.bin")).rejects.toThrow(/sha256 不一致/);
    });

    test("方言 unknown → 显式不支持（不静默错用）", async () => {
        const remote = mockRemote();
        const local = join(dir, "u.bin");
        writeFileSync(local, Buffer.from("x"));
        await expect(putFile(remote.exec, NULL_DIALECT, local, "/r/z.bin")).rejects.toThrow(/base64 原语不可用/);
    });

    test("BSD 方言（OPNsense 形态）渲染验证：probeDialect mock 判定 + 传输走 BSD argv", async () => {
        // BSD 形态探测（与 dialect.test 同 mock 策略，此处验证传输层接线）
        const bsdDialect: RemoteDialect = {
            family: "bsd",
            base64Encode: ["base64"],
            base64Decode: ["base64", "-D"],
            sha256: ["sha256", "-q"],
        };
        const remote = mockRemote();
        // 扩 mock：BSD 命令形态
        const bsdExec: TransferExec = async (cmd) => {
            let m = cmd.match(/^\(umask 077; base64 -D < '([^']*)' > '([^']*)'\)$/);
            if (m) {
                files2.set(m[2]!, Buffer.from(files2.get(m[1]!)?.toString("utf-8") ?? "", "base64"));
                return { stdout: "", exitCode: 0 };
            }
            m = cmd.match(/^base64 < '(.+)'$/);
            if (m) return { stdout: files2.get(m[1]!)?.toString("base64") ?? "", exitCode: 0 };
            m = cmd.match(/^sha256 -q < '(.+)'$/);
            if (m) return { stdout: createHash("sha256").update(files2.get(m[1]!) ?? Buffer.alloc(0)).digest("hex"), exitCode: 0 };
            return remote.exec(cmd);
        };
        const files2 = remote.files;
        const local = join(dir, "bsd.bin");
        writeFileSync(local, Buffer.from("freebsd payload"));
        const r = await putFile(bsdExec, bsdDialect, local, "/r/bsd.bin");
        expect(r.verified).toBe(true);
        expect(files2.get("/r/bsd.bin")!.toString()).toBe("freebsd payload");
        void probeDialect; // 探测联动见 dialect.test
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });
});

describe("sftp 快路径（FEAT-14 ②）", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "fx-sftp-"));

    test("SFTP 上传和下载都以校验 shell 的目录解析相对路径", async () => {
        const remote = mockRemote();
        const dir = mkdtempSync(join(tmpdir(), "fx-sftp-cwd-"));
        const local = join(dir, "input");
        const output = join(dir, "output");
        const exec: TransferExec = (cmd) => cmd === "pwd -P"
            ? Promise.resolve({ stdout: "/shell-cwd\n", exitCode: 0 })
            : remote.exec(cmd);
        const spawnImpl: SftpSpawnImpl = async (_argv, batch) => {
            const [, action, source, target] = /^(put|get) '(.+)' '(.+)'\n$/.exec(batch)!;
            const fromSftp = (path: string) => path.startsWith("/") ? path : `/sftp-home/${path}`;
            if (action === "put") remote.files.set(fromSftp(target!), readFileSync(source!));
            else writeFileSync(target!, remote.files.get(fromSftp(source!))!);
            return { exitCode: 0, stderr: "" };
        };
        try {
            writeFileSync(local, "different working directories");
            await sftpPutFile(exec, GNU, local, "notes", { connArgs: [], spawnImpl });
            expect([...remote.files.keys()]).toEqual(["/shell-cwd/notes"]);
            await sftpGetFile(exec, GNU, "notes", output, { connArgs: [], spawnImpl });
            expect(readFileSync(output, "utf-8")).toBe("different working directories");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("sftpPutFile：batch 命令形态正确 + 同一双校验标准 + spawn 注入", async () => {
        const remote = mockRemote();
        let gotArgv: string[] = [];
        let gotBatch = "";
        // sftp 成功后模拟远端已有该文件（供 wc/sha256 校验）
        const fakeSftp: SftpSpawnImpl = async (argv, batch) => {
            gotArgv = argv; gotBatch = batch;
            const m = batch.match(/^put '(.+?)' '(.+?)'$/m);
            if (m) {
                // 读本地文件写进 mock 远端（模拟 sftp put 效果）
                const { readFile } = await import("node:fs/promises");
                remote.files.set(m[2]!, await readFile(m[1]!));
            }
            return { exitCode: 0, stderr: "" };
        };
        const local = join(dir2, "big.bin");
        writeFileSync(local, Buffer.alloc(64 * 1024, 7));
        const r = await sftpPutFile(remote.exec, GNU, local, "/r/big.bin", {
            connArgs: ["-o", "ConnectTimeout=10", "user@host"],
            spawnImpl: fakeSftp,
        });
        expect(gotArgv).toEqual(["-b", "-", "-o", "ConnectTimeout=10", "user@host"]);
        expect(gotBatch).toMatch(/^put '.+' '\/r\/big\.bin\.filaxis-stage-([a-f0-9]{12})\/payload-\1'$/m);
        expect(r.verified).toBe(true); // 与 base64 路径同一校验标准
        expect(r.verification).toBe("sha256");
        expect(r.bytes).toBe(64 * 1024);
        expect(r.writeMode).toBe("atomic-replace");
        expect(remote.files.get("/r/big.bin")).toEqual(Buffer.alloc(64 * 1024, 7));
        expect([...remote.files.keys()]).toEqual(["/r/big.bin"]);
        rmSync(dir2, { recursive: true, force: true });
    });

    test("sftpPutFile 校验失败时保留目标并清理暂存文件", async () => {
        const remote = mockRemote();
        const dir = mkdtempSync(join(tmpdir(), "fx-sftp-verify-"));
        try {
            const local = join(dir, "input");
            const target = "/r/file";
            writeFileSync(local, "expected");
            remote.files.set(target, Buffer.from("original"));
            const spawnImpl: SftpSpawnImpl = async (_argv, batch) => {
                const staged = batch.match(/^put '.+' '(.+)'$/m)![1]!;
                remote.files.set(staged, Buffer.from("modified"));
                return { exitCode: 0, stderr: "" };
            };
            await expect(sftpPutFile(remote.exec, GNU, local, target, { connArgs: [], spawnImpl }))
                .rejects.toBeInstanceOf(TransferVerificationError);
            expect(remote.files.get(target)?.toString()).toBe("original");
            expect([...remote.files.keys()]).toEqual([target]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("sftp 失败：退出码非零显式报错（降级提示），不静默", async () => {
        const remote = mockRemote();
        const boom: SftpSpawnImpl = async () => ({ exitCode: 1, stderr: "Connection closed" });
        const local = join(tmpdir(), `fx-sftp-e-${Date.now()}`);
        writeFileSync(local, Buffer.from("x"));
        await expect(sftpPutFile(remote.exec, GNU, local, "/r/e.bin", { connArgs: ["h"], spawnImpl: boom }))
            .rejects.toThrow(/sftp put 失败.*降级/);
    });
});

/**
 * 真实 shell 回归（GPT Astra 六轮 #1/#2/#3——mock 失真根因：不存在的文件当
 * 空内容、`&& rm` 无脑放行，8 测全过却盖不住真 shell 语义）。exec 直连本地
 * sh -c，走与远端一致的物理行为。
 */
describe("putFile（真实 shell 回归）", () => {
    test.skipIf(process.platform !== "win32")("Windows uses a protected staging ACL and preserves the destination ACL", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-private-stage-"));
        const driver = new LocalRuntimeDriver({ cwd: dir });
        const target = "file with spaces.bin";
        const info = (path: string, operation: string) => execFileSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command", operation,
        ], { encoding: "utf8", env: { ...process.env, FX_TEST_ACL_PATH: path } }).trim();
        const snapshot = "([IO.File]::GetAccessControl($env:FX_TEST_ACL_PATH)).GetSecurityDescriptorSddlForm('Access')";
        const staged: string[] = [];
        const exec: TransferExec = async (command) => {
            const create = /cygpath -aw '([^']+\.filaxis-stage-[0-9a-f]+)'/.exec(command);
            const payload = /cygpath -aw '([^']+\/payload-[0-9a-f]+)'/.exec(command);
            if (payload) {
                for (const path of [payload[1]!, payload[1]!.replace(/payload-[0-9a-f]+$/, "encoded")]) {
                    expect(info(join(dir, path),
                        "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; " +
                        "$a = [IO.File]::GetAccessControl($env:FX_TEST_ACL_PATH); " +
                        "$rules = @($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); " +
                        "($rules.Count -eq 1 -and $rules[0].IdentityReference -eq $sid)")).toBe("True");
                }
            }
            const result = await driver.exec(command);
            if (create && result.exitCode === 0) {
                const path = join(dir, create[1]!);
                staged.push(path);
                expect(info(path, "$a = [IO.Directory]::GetAccessControl($env:FX_TEST_ACL_PATH); " +
                    "[string]$a.AreAccessRulesProtected + ',' + @($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])).Count"))
                    .toBe("True,1");
            }
            return result;
        };
        try {
            const dialect = await probeDialect(exec);
            await putContent(exec, dialect, Buffer.from("first"), target);
            const file = join(dir, target);
            expect(info(file, "([IO.File]::GetAccessControl($env:FX_TEST_ACL_PATH)).AreAccessRulesProtected")).toBe("False");
            info(file, "& icacls.exe $env:FX_TEST_ACL_PATH /grant '*S-1-1-0:(R)'");
            const before = info(file, snapshot);
            expect(await putContent(exec, dialect, Buffer.from("second"), target)).toMatchObject({ writeMode: "atomic-replace" });
            expect(info(file, snapshot)).toBe(before);
            expect(readFileSync(file, "utf8")).toBe("second");
            expect(staged).toHaveLength(2);
            expect(staged.every((path) => !existsSync(path))).toBe(true);
        } finally {
            await driver.destroy();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 45_000);

    test.skipIf(process.platform !== "linux")("上传无法解析目标时保留符号链接", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-put-dangling-"));
        try {
            const target = join(dir, "missing-parent", "target");
            const link = join(dir, "link");
            symlinkSync(target, link);
            await expect(putContent(realExec, GNU, Buffer.from("new"), link)).rejects.toThrow(/无法解析目标符号链接/);
            expect(readlinkSync(link)).toBe(target);
            expect(readdirSync(dir)).toEqual(["link"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test.skipIf(process.platform !== "linux")("编辑和上传保留文件名末尾的换行", async () => {
        const { editFile } = await import("../src/file-edit.js");
        const { LocalRuntimeDriver } = await import("../src/local-driver.js");
        const driver = new LocalRuntimeDriver();
        const neighbor = fwd(join(dirR, "newline-name"));
        const target = neighbor + "\n";
        writeFileSync(neighbor, "old neighbor");
        writeFileSync(target, "old target");
        await editFile(driver, target, "old", "new");
        expect(readFileSync(target, "utf-8")).toBe("new target");
        await putContent(realExec, GNU, Buffer.from("uploaded"), target);
        expect(readFileSync(target, "utf-8")).toBe("uploaded");
        expect(readFileSync(neighbor, "utf-8")).toBe("old neighbor");
    }, 20_000);
    const hasSh = Boolean(Bun.which("sh") && Bun.which("base64") && Bun.which("sha256sum") && Bun.which("mv"));
    const dirR = mkdtempSync(join(tmpdir(), "fx-ft-real-"));
    const fwd = (p: string) => p.replace(/\\/g, "/");
    const realExec: TransferExec = async (command) => {
        // sh -s stdin 传命令（与 execChannel 同形态）——sh -c 走 argv，Windows
        // 32767 字符上限装不下 48K chunk（uv_spawn ENAMETOOLONG，本测试实测踩出）
        const p = Bun.spawn(["sh", "-s"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        p.stdin.write(command);
        await p.stdin.end();
        const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
        return { stdout, exitCode: code };
    };

    test.skipIf(!hasSh)("#1 解码中途失败 → 目标保持原样（旧实现 shell 重定向先截断目标 → PARTIAL）", async () => {
        const local = join(dirR, "a.bin");
        writeFileSync(local, "ORIGINAL-CONTENT-0123456789");
        const dst = fwd(join(dirR, "dst1.bin"));
        writeFileSync(join(dirR, "dst1.bin"), "PRECIOUS");
        // 注入：chunk 正常落盘后追加非法 base64 字符 → decode invalid input 失败
        const evil: TransferExec = async (cmd) => {
            const m = cmd.match(/^\(umask 077; printf %s '[^']*' >> '([^']+)'\)$/);
            if (m) {
                const r = await realExec(cmd);
                if (r.exitCode !== 0) return r;
                return realExec(`printf '!!!!' >> '${m[1]}'`);
            }
            return realExec(cmd);
        };
        await expect(putFile(evil, GNU, local, dst)).rejects.toThrow(/解码失败（目标未动）/);
        expect(readFileSync(join(dirR, "dst1.bin"), "utf-8")).toBe("PRECIOUS"); // 目标零污染（修前变 PARTIAL）
        expect(readdirSync(dirR).filter((f) => f.includes(".filaxis-"))).toEqual([]); // 失败路径临时清理（nonce 后缀）
    }, 20_000);

    test.skipIf(!hasSh)("#2 空文件可上传（显式 : > tmp——零分块不再读不存在的文件）", async () => {
        const local = join(dirR, "e.bin");
        writeFileSync(local, Buffer.alloc(0));
        const dst = fwd(join(dirR, "dst2.bin"));
        const r = await putFile(realExec, GNU, local, dst);
        expect(r.verified).toBe(true);
        expect(r.verification).toBe("sha256");
        expect(statSync(join(dirR, "dst2.bin")).size).toBe(0); // 远端真 0 字节
    }, 20_000);

    test.skipIf(!hasSh)("#3 校验等级显式：sha256 原语缺席 → verification=size（不冒充完整校验）", async () => {
        const local = join(dirR, "s.bin");
        writeFileSync(local, "payload-xyz");
        const noSha: RemoteDialect = { ...GNU, sha256: [] };
        const r = await putFile(realExec, noSha, local, fwd(join(dirR, "dst3.bin")));
        expect(r.verified).toBe(true);
        expect(r.verification).toBe("size"); // 同长损坏不可检是能力边界——显式知情（修前虚标完整校验）
        const r2 = await putFile(realExec, GNU, local, fwd(join(dirR, "dst4.bin")));
        expect(r2.verification).toBe("sha256");
    }, 20_000);

    test.skipIf(!hasSh)("#1 补充：解码成功但校验不符 → 目标同样零接触（verify 先于 mv）", async () => {
        const local = join(dirR, "v.bin");
        writeFileSync(local, "good-payload");
        const dst = fwd(join(dirR, "dst5.bin"));
        writeFileSync(join(dirR, "dst5.bin"), "PRECIOUS2");
        // 注入：sha256sum 返回假摘要 → 校验必挂（decode 本身成功）
        const evil: TransferExec = async (cmd) => {
            if (/^sha256sum /.test(cmd)) return { stdout: "deadbeef".repeat(8) + "  -", exitCode: 0 };
            return realExec(cmd);
        };
        await expect(putFile(evil, GNU, local, dst)).rejects.toThrow(TransferVerificationError);
        expect(readFileSync(join(dirR, "dst5.bin"), "utf-8")).toBe("PRECIOUS2"); // 未 mv 落位
        expect(readdirSync(dirR).filter((f) => f.includes(".filaxis-"))).toEqual([]); // 校验失败路径临时清理
    }, 20_000);

    // GPT Astra 七轮 #1：固定名临时下并发同目标「校验 A、落位 B」——A 校验完
    // 输出临时后 B 覆盖之，A 把 B 的内容 mv 落位还报 verified。nonce 独占后
    // 各自落位各自内容。
    test.skipIf(!hasSh)("#4 并发同目标：A 校验间隙 B 完整上传 → A 落位自己的内容（不再张冠李戴）", async () => {
        const localA = join(dirR, "pa.bin");
        const localB = join(dirR, "pb.bin");
        writeFileSync(localA, "A".repeat(64));
        writeFileSync(localB, "B".repeat(64));
        const dst = fwd(join(dirR, "dstc.bin"));
        let injected = false;
        const aExec: TransferExec = async (cmd) => {
            // 注入点：A 的 mv（落位）发出前，B 完整跑一遍（干净通道）——A 的输出
            // 临时此时已被 B 碰过的窗口即旧 bug 现场
            if (!injected && cmd.startsWith("mv ")) {
                injected = true;
                const rb = await putFile(realExec, GNU, localB, dst);
                expect(rb.verified).toBe(true);
            }
            return realExec(cmd);
        };
        const ra = await putFile(aExec, GNU, localA, dst);
        expect(ra.verified).toBe(true);
        // 修前：A verified 但目标= BBBBBBBB（固定名 out 被 B 复用）；修后：A 落位自己的
        // nonce out——最终内容 = A 的（后写胜，两者各报各的，诚实）
        expect(readFileSync(join(dirR, "dstc.bin"), "utf-8")).toBe("A".repeat(64));
        expect(readdirSync(dirR).filter((f) => f.includes(".filaxis-"))).toEqual([]); // 双方临时全清
    }, 30_000);

    // GPT Astra 七轮 #2：旧实现先 writeFile 再校验——校验失败原本地文件已被覆盖
    test.skipIf(!hasSh)("#5 下载校验失败 → 本地目标零接触（校验先行 + rename 原子落位）", async () => {
        const remoteSrc = join(dirR, "remote-src.bin");
        writeFileSync(remoteSrc, "REMOTE-GOOD-DATA");
        const localDst = join(dirR, "precious-local.bin");
        writeFileSync(localDst, "LOCAL-PRECIOUS");
        // 注入：encode 回传坏载荷（截半 → sha 必不符）
        const evil: TransferExec = async (cmd) => {
            if (/^base64 -w 0 /.test(cmd)) {
                const good = await realExec(cmd);
                return { stdout: good.stdout.slice(0, Math.max(1, Math.floor(good.stdout.length / 2))), exitCode: good.exitCode };
            }
            return realExec(cmd);
        };
        await expect(getFile(evil, GNU, fwd(remoteSrc), localDst)).rejects.toThrow(TransferVerificationError);
        expect(readFileSync(localDst, "utf-8")).toBe("LOCAL-PRECIOUS"); // 修前：已被坏内容覆盖
        expect(readdirSync(dirR).filter((f) => f.includes(".filaxis-"))).toEqual([]); // 校验先行：临时都不建
        // 成功路径：真内容落位
        const ok = await getFile(realExec, GNU, fwd(remoteSrc), localDst);
        expect(ok.verified).toBe(true);
        expect(readFileSync(localDst, "utf-8")).toBe("REMOTE-GOOD-DATA");
    }, 20_000);

    // GPT Astra 七轮 #3：旧 `mv && rm` 共用退出码——mv 成功 rm 失败误报「目标未动」
    test.skipIf(!hasSh)("#6 落位成功但分块临时清理失败 → 不误报目标未动（落位与清理拆分）", async () => {
        const local = join(dirR, "clean.bin");
        writeFileSync(local, "FRESH-CONTENT");
        const dst = fwd(join(dirR, "dst6.bin"));
        const evil: TransferExec = async (cmd) => {
            if (/^rm -f '.+\/encoded'; rmdir /.test(cmd)) return { stdout: "", exitCode: 1 }; // 清理失败
            return realExec(cmd);
        };
        const r = await putFile(evil, GNU, local, dst); // 不抛「目标未动」（落位已成功）
        expect(r.verified).toBe(true);
        expect(readFileSync(join(dirR, "dst6.bin"), "utf-8")).toBe("FRESH-CONTENT"); // 新内容已落位
    }, 20_000);

    // GPT Astra 八轮 #1：自动迁移清理会删掉旧版本传输正在使用的固定名临时
    // （滚动升级/多客户端混用：新上传破坏旧上传）——移除后旧临时不被触碰
    test.skipIf(!hasSh)("#7 不再自动迁移清理：预置旧版固定名临时原样保留（混用安全）", async () => {
        const local = join(dirR, "m.bin");
        writeFileSync(local, "MIGRATE");
        const dst = fwd(join(dirR, "dst7.bin"));
        writeFileSync(join(dirR, "dst7.bin.filaxis-tmp"), "OLD-TMP-IN-USE");
        writeFileSync(join(dirR, "dst7.bin.filaxis-out"), "OLD-OUT-IN-USE");
        const r = await putFile(realExec, GNU, local, dst);
        expect(r.verified).toBe(true);
        expect(readFileSync(join(dirR, "dst7.bin.filaxis-tmp"), "utf-8")).toBe("OLD-TMP-IN-USE"); // 未被删（修前：入口无条件 rm）
        expect(readFileSync(join(dirR, "dst7.bin.filaxis-out"), "utf-8")).toBe("OLD-OUT-IN-USE");
        // 自身 nonce 临时零残留（旧固定名是预置件，不算自身残留）
        expect(readdirSync(dirR).filter((f) => f.startsWith("dst7.bin.filaxis-")).sort())
            .toEqual(["dst7.bin.filaxis-out", "dst7.bin.filaxis-tmp"]);
    }, 20_000);

    // GPT Astra 八轮 #2：目标是现存目录时 mv 把临时移进目录（basename 保留）、
    // 落位语义被偷换还报 verified——显式拒绝
    test.skipIf(!hasSh)("#8 目标是现存目录 → 拒绝上传（mv 进目录还报 verified 的旧形态绝迹）", async () => {
        const local = join(dirR, "d8.bin");
        writeFileSync(local, "DIR-TARGET");
        const dstDir = join(dirR, "dest-dir");
        mkdirSync(dstDir);
        await expect(putFile(realExec, GNU, local, fwd(dstDir))).rejects.toThrow(/现存目录/);
        expect(readdirSync(dstDir)).toEqual([]); // 目录里没被移进任何东西
        expect(readdirSync(dirR).filter((f) => f.startsWith("dest-dir.filaxis-"))).toEqual([]); // 早拒：临时都不建
    }, 20_000);

    // 自排查（八轮顺藤）：分块写入中途失败（磁盘满/配额形态）——此前直接 throw
    // 漏清 tmp；统一失败清理后零残留
    test.skipIf(!hasSh)("#9 分块写入中途失败 → 抛错且零残留", async () => {
        const local = join(dirR, "c9.bin");
        writeFileSync(local, Buffer.alloc(200 * 1024)); // b64 ≈267K > 2 个 chunk
        const dst = fwd(join(dirR, "dst9.bin"));
        let n = 0;
        const evil: TransferExec = async (cmd) => {
            if (cmd.startsWith("(umask 077; printf %s ") && ++n >= 2) return { stdout: "write error: No space left on device", exitCode: 1 };
            return realExec(cmd);
        };
        await expect(putFile(evil, GNU, local, dst)).rejects.toThrow(/分块写入失败.*exit=1/);
        expect(readdirSync(dirR).filter((f) => f.startsWith("dst9.bin.filaxis-"))).toEqual([]); // 修前：tmp-nonce 残留
    }, 20_000);

    // 自排查（顺延 getFile）：本地目标是目录——rename 报 ENOTDIR 晚失败且不友好，早拒绝
    test.skipIf(!hasSh)("#10 本地目标是现存目录 → 早拒绝", async () => {
        const remoteSrc = join(dirR, "rs10.bin");
        writeFileSync(remoteSrc, "X");
        const dirLocal = join(dirR, "local-dir");
        mkdirSync(dirLocal);
        await expect(getFile(realExec, GNU, fwd(remoteSrc), dirLocal)).rejects.toThrow(/现存目录/);
    }, 20_000);


    // GPT Sol 八十九期 P1-4/P1-5：目录回搬分支曾不核实「本次是否真搬过」——mv
    // 全败时目录里恰同名无关文件被搬出后删除/误当载荷；跨文件系统落位（载荷临时
    // 在原路径一侧、符号链接真身在另一 fs）mv 退化为复制仍报 atomic-replace。
    test.skipIf(!hasSh || process.platform === "win32")("Sol 89 P1-4/P1-5 同设备形状：__fx_mv 证据闸 + 设备分流在场，atomic-replace 保持", async () => {
        const cmds: string[] = [];
        const recExec: TransferExec = async (cmd) => { cmds.push(cmd); return realExec(cmd); };
        const dst = fwd(join(dirR, "shape89.bin"));
        const r = await putContent(recExec, GNU, Buffer.from("hello-shape"), dst);
        expect(r.verified).toBe(true);
        expect(r.writeMode).toBe("atomic-replace"); // 同设备（本地 tmp 一侧）→ rename 链
        expect(readFileSync(join(dirR, "shape89.bin"), "utf-8")).toBe("hello-shape");
        const place = cmds.find((c) => c.includes("__fx_mv=0"));
        expect(place).toBeTruthy(); // 五防 place 在场
        // 证据序：__fx_mv=1 紧跟裸 mv 成功（&& 短路链内）；回搬守卫查 __fx_mv=1
        //（曾无条件按 basename 回搬目录里恰同名的无关文件）
        expect(place).toMatch(/mv [^;]* && __fx_mv=1 && \[ ! -d "\$__fx_tgt" \]/);
        expect(place).toMatch(/\[ "\$__fx_mv" = "1" \] && \[ -d "\$__fx_tgt" \]/);
        // 设备分流在场（stat %d 同设备才走 rename 链；跨设备/不可判走 cat）
        expect(place).toContain("stat -c %d");
    }, 20_000);

    test.skipIf(!hasSh || !existsSync("/dev/shm"))("Sol 89 P1-5 跨设备上传（/tmp→/dev/shm 符号链接）：writeMode=inplace-write（不谎报原子）", async () => {
        const shmDir = `/dev/shm/fx-xdev-${process.pid}`;
        mkdirSync(shmDir, { recursive: true });
        try {
            const linkPath = fwd(join(dirR, "xdev-link.bin"));
            symlinkSync(`${shmDir}/real.bin`, linkPath); // 原路径一侧的符号链接 → 真身跨设备
            const r = await putContent(realExec, GNU, Buffer.from("cross-device-payload"), linkPath);
            expect(r.verified).toBe(true);
            expect(r.writeMode).toBe("inplace-write"); // 修前：mv 跨设备复制仍报 atomic-replace
            expect(readFileSync(`${shmDir}/real.bin`, "utf-8")).toBe("cross-device-payload");
        } finally {
            rmSync(shmDir, { recursive: true, force: true });
        }
    }, 20_000);


    // GPT Sol 九十期 P1-3：载荷（已校验的 out/fx-tmp）在落位开始时被移除——
    // `cat src > tgt` 由 cat 自己开源、shell 先截断目标：原文件被截成 0 字节且
    // 错误所称恢复路径无存。修后 `cat < src > tgt`：shell 从左到右处理重定向，
    // 源打开失败时目标尚未被截断。
    test.skipIf(!hasSh)("Sol 90 P1-3 载荷丢失：mv 失败回落 cat——目标零接触（不再截空）", async () => {
        const dst = fwd(join(dirR, "p3-target.bin"));
        writeFileSync(join(dirR, "p3-target.bin"), "PRECIOUS-CONTENT");
        let outPath = "";
        const evil: TransferExec = async (cmd) => {
            const dm = cmd.match(/base64 -d < '([^']+)' > '([^']+)'/);
            if (dm) outPath = dm[2]!;
            if (cmd.includes("__fx_od=")) {
                // 落位开始：移除已校验载荷（模拟丢失/外部清理）
                if (outPath) rmSync(outPath, { force: true });
            }
            return realExec(cmd);
        };
        await expect(putContent(evil, GNU, Buffer.from("new-payload"), dst)).rejects.toThrow(/载荷在落位前消失/);
        expect(readFileSync(join(dirR, "p3-target.bin"), "utf-8")).toBe("PRECIOUS-CONTENT"); // 修前：0 字节+谎称恢复路径在场
    }, 20_000);

    // Sol 90 P1-2（受控编辑侧同款防御的形状锚）：CAS 核验与落位同锚解析后真身
    test.skipIf(!hasSh)("原地写入已经开始时，载荷消失仍报告目标可能被改写", async () => {
        const target = fwd(join(dirR, "partial-payload-missing.bin"));
        writeFileSync(target, "previous");
        const exec: TransferExec = (command) => realExec(command.includes("FX_INPLACE_PAYLOAD_MISSING")
            ? `cat() { rm -f '${target}'.filaxis-stage-*/payload-*; head -c 1; return 1; }; ${command}`
            : command);
        await expect(putContent(exec, GNU, Buffer.from("new"), target, { forceInplace: true }))
            .rejects.toThrow(/目标可能已被部分改写，恢复载荷已不在/);
        expect(readFileSync(target, "utf-8")).toBe("n");
    }, 20_000);

    test.skipIf(!hasSh)("Sol 90 P1-2 editFile 命令形状：真身解析先于核验（同锚 __fx_tgt）", async () => {
        const { editFile } = await import("../src/file-edit.js");
        const { LocalRuntimeDriver } = await import("../src/local-driver.js");
        const drv = new LocalRuntimeDriver();
        const target = fwd(join(dirR, "p2-real.bin"));
        writeFileSync(join(dirR, "p2-real.bin"), "V=1\n");
        const cmds: string[] = [];
        const rec = Object.create(drv) as typeof drv;
        (rec as unknown as { exec(c: string, o?: unknown): Promise<unknown> }).exec = async (c: string, o?: unknown) => {
            cmds.push(c);
            return (drv.exec as (c: string, o?: unknown) => Promise<unknown>)(c, o);
        };
        await editFile(rec, target, "V=1", "V=2");
        const cas = cmds.find((c) => c.includes("FX_CAS_FAIL") || c.includes("flock"));
        expect(cas).toBeTruthy();
        const iResolve = cas!.indexOf("readlink -f");
        const iStat = cas!.indexOf("stat -c '%Y %s'");
        const iSha = cas!.indexOf("sha256sum");
        expect(iResolve).toBeGreaterThanOrEqual(0);
        expect(iResolve).toBeLessThan(iStat); // 修前：核验在前、真身解析在落位段
        expect(cas).toContain("stat -c '%Y %s' \"$__fx_tgt\""); // 核验锚**真身**（修前：原路径）
        expect(cas).toContain('sha256sum "$__fx_tgt"');
        expect(readFileSync(join(dirR, "p2-real.bin"), "utf-8")).toBe("V=2\n"); // 编辑本身仍成功
    }, 20_000);

    afterAll(() => {
        rmSync(dirR, { recursive: true, force: true });
    });
});

// 审计 M5：SFTP batch 按行分割——路径含换行=命令注入面；前导 -=选项歧义。
describe("SFTP 路径防线（审计 M5）", () => {
    test("换行路径拒绝（注入面）+ 前导 - 拒绝（选项歧义）", async () => {
        const { sftpPutFile } = await import("../src/file-transfer.js");
        const opts = { connArgs: ["h"], spawnImpl: (async () => ({ exitCode: 0, stderr: "" })) as never };
        await expect(sftpPutFile({} as never, GNU, "a\nrm /x", "/r/p", opts)).rejects.toThrow(/含换行/);
        await expect(sftpPutFile({} as never, GNU, "/tmp/ok", "/r/p\nrename a b", opts)).rejects.toThrow(/含换行/);
        await expect(sftpPutFile({} as never, GNU, "-weird", "/r/p", opts)).rejects.toThrow(/以 - 开头/);
        await expect(sftpGetFile({} as never, GNU, "/r/*.txt", "/tmp/out", opts)).rejects.toThrow(/通配符/);
    });
});

// 审计 M6：网络瞬断（exec reject）不得被判定「原语不支持」并永久缓存 NULL_DIALECT。
describe("方言探测通道崩溃（审计 M6）", () => {
    test("第二条命令 reject → probeDialect 上抛 + 缓存为空（瞬断不固化降级）", async () => {
        const { probeDialect, DialectCache } = await import("../src/dialect.js");
        let n = 0;
        const flaky = async (cmd: string) => {
            n++;
            if (n === 1) return { stdout: "ZmlsYXhpcw==", exitCode: 0 }; // 第一条 OK
            throw new Error("channel reset by peer"); // 第二条瞬断
        };
        await expect(probeDialect(flaky)).rejects.toThrow(/channel reset/); // 修前：吞成 NULL_DIALECT
        const cache = new DialectCache();
        await expect(cache.get("k1", flaky)).rejects.toThrow(/channel reset/);
        expect((cache as unknown as { cache: Map<string, unknown> }).cache.size).toBe(0); // 未固化
    });
});

// GPT Sol 六十三期 P2-5：sftp get 直写目标+事后校验——校验失败时目标已被坏
// 内容覆盖。修：临时落位→双校验→rename 归位；失败清临时，目标分毫未动。
describe("Sol 63：sftpGetFile 校验失败不覆盖目标", () => {
    test("下载内容损坏（size 不符）→ 抛校验错 + 目标保持 original + 无临时残留", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-get63-"));
        try {
            const localPath = join(dir, "target.bin");
            writeFileSync(localPath, "original");
            const files = new Map<string, Buffer>([["/remote/src.bin", Buffer.from("good")]]);
            const exec: TransferExec = async (cmd) => {
                const m = cmd.match(/^(?:wc -c|sha256sum) < '([^']+)'$/);
                if (!m) return { stdout: "", exitCode: 0 };
                const buf = files.get(m[1]!) ?? Buffer.alloc(0);
                if (cmd.startsWith("wc")) return { stdout: String(buf.length), exitCode: 0 };
                return { stdout: createHash("sha256").update(buf).digest("hex"), exitCode: 0 };
            };
            const spawnImpl: SftpSpawnImpl = async (_args: string[], batch: string) => {
                const m = batch.trim().match(/^get '([^']+)' '([^']+)'$/);
                if (m) writeFileSync(m[2]!, "bad"); // 模拟损坏下载（远端是 good）
                return { stdout: "", stderr: "", exitCode: 0 };
            };
            await expect(sftpGetFile(exec, GNU, "/remote/src.bin", localPath, { connArgs: [], spawnImpl }))
                .rejects.toBeInstanceOf(TransferVerificationError);
            expect(readFileSync(localPath, "utf-8")).toBe("original"); // 修前：bad 已覆盖
            expect(readdirSync(dir).filter((f) => f.includes("fx-dl"))).toEqual([]); // 临时已清
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 六十四期 P2-5：sftp 执行器半途抛错——spawn 调用曾在清理 try 之外，
// .fx-dl-* 半截临时残留在盘。
describe("Sol 64：sftpGetFile 执行器抛错清临时", () => {
    test("spawn 写入部分内容后抛错 → 透传异常 + 目标保持 + 无临时残留", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-get64-"));
        try {
            const localPath = join(dir, "target.bin");
            writeFileSync(localPath, "original");
            const spawnImpl: SftpSpawnImpl = async (_args: string[], batch: string) => {
                const m = batch.trim().match(/^get '([^']+)' '([^']+)'$/);
                if (m) writeFileSync(m[2]!, "partial"); // 半途已写
                throw new Error("channel died");
            };
            const exec: TransferExec = async () => ({ stdout: "", exitCode: 0 });
            await expect(sftpGetFile(exec, GNU, "/remote/x.bin", localPath, { connArgs: [], spawnImpl }))
                .rejects.toThrow(/channel died/);
            expect(readFileSync(localPath, "utf-8")).toBe("original");
            expect(readdirSync(dir).filter((f) => f.includes("fx-dl"))).toEqual([]); // 修前：半截临时残留
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 七十二期 #5：NAME_MAX 按字节计——250B 中文文件名（83 码元）+临时后缀
// 曾按码元判定「放得进」→ 追后缀即超限（上传 tmp/普通下载 out/sftp 下载本地
// 临时全中）。字节口径截断。
describe("Sol 72：多字节长名字节口径", () => {
    test("sftpGetFile 本地临时名：82 个「中」（250B）+ 后缀 ≤255B", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-cjk72-"));
        try {
            const name = "中".repeat(82) + ".bin"; // 246B + 4B=250B 裸名合法（<255B）、追后缀必超（>255B）
            const localPath = join(dir, name);
            writeFileSync(localPath, "original");
            const files = new Map<string, Buffer>([["/remote/x.bin", Buffer.from("good")]]);
            const exec: TransferExec = async (cmd) => {
                const m = cmd.match(/^(?:wc -c|sha256sum) < '([^']+)'$/);
                if (!m) return { stdout: "", exitCode: 0 };
                const buf = files.get(m[1]!) ?? Buffer.alloc(0);
                if (cmd.startsWith("wc")) return { stdout: String(buf.length), exitCode: 0 };
                return { stdout: createHash("sha256").update(buf).digest("hex"), exitCode: 0 };
            };
            let tmpSeen = "";
            const spawnImpl: SftpSpawnImpl = async (_args: string[], batch: string) => {
                const m = batch.trim().match(/^get '([^']+)' '([^']+)'$/);
                if (m) { tmpSeen = m[2]!; writeFileSync(m[2]!, "good"); } // 落真实文件（名字超限会当场 ENAMETOOLONG）
                return { stdout: "", stderr: "", exitCode: 0 };
            };
            const r = await sftpGetFile(exec, GNU, "/remote/x.bin", localPath, { connArgs: [], spawnImpl });
            expect(r.verified).toBe(true);
            expect(readFileSync(localPath, "utf-8")).toBe("good"); // 归位成功（修前：临时名超限写不进）
            const tmpBase = tmpSeen.split(/[\\/]/).pop()!;
            expect(Buffer.byteLength(tmpBase, "utf-8")).toBeLessThanOrEqual(255); // 字节口径（修前码元口径必超）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 七十三期 #5：长中文名修复漏了普通下载（getFile 内联临时名仍按码元
// 计）与 CAS 编辑伴生锁（fxBase 码元判定）。两入口字节口径补齐。
describe("Sol 73：长名漏网入口", () => {
    test("getFile（普通下载）：250B 中文名归位成功", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-get73-"));
        try {
            const localPath = join(dir, "中".repeat(82) + ".bin"); // 250B 裸名合法
            const remote = mockRemoteForGet();
            remote.files.set("/remote/cjk.bin", Buffer.from("content-73"));
            const dialect = { family: "gnu", base64Encode: ["base64", "-w", "0"], base64Decode: ["base64", "-d"], sha256: ["sha256sum"] } as never;
            const r = await getFile(remote.exec, dialect, "/remote/cjk.bin", localPath);
            expect(r.verified).toBe(true);
            expect(readFileSync(localPath, "utf-8")).toBe("content-73"); // 修前：临时名 ENAMETOOLONG
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    function mockRemoteForGet() {
        const files = new Map<string, Buffer>();
        const exec: TransferExec = async (cmd) => {
            const m = cmd.match(/^(?:base64 -w 0|wc -c|sha256sum) < '([^']+)'$/);
            if (!m) return { stdout: "", exitCode: 0 };
            const buf = files.get(m[1]!) ?? Buffer.alloc(0);
            if (cmd.startsWith("wc")) return { stdout: String(buf.length), exitCode: 0 };
            if (cmd.startsWith("sha256")) return { stdout: createHash("sha256").update(buf).digest("hex"), exitCode: 0 };
            return { stdout: buf.toString("base64"), exitCode: 0 };
        };
        return { files, exec };
    }
});

describe("[P2] tmux 大文件分块下载（避开输出滚动窗口截断）", () => {
    const hasSh = Boolean(Bun.which("sh"));
    test.skipIf(!hasSh)("128 KiB 二进制文件经受限输出窗口的 tmux 层下载完整通过", async () => {
        const shPath = Bun.which("sh")!;
        const dir = mkdtempSync(join(tmpdir(), "fx-tmux-get128k-"));
        const fwd = (p: string) => p.replace(/\\/g, "/");
        try {
            const payload = Buffer.alloc(128 * 1024);
            for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 13) & 0xff;
            const remoteFile = join(dir, "remote-128k.bin");
            const localOut = join(dir, "local-128k.bin");
            writeFileSync(remoteFile, payload);

            let maxStdoutSeen = 0;
            const cappedTmuxDriver = {
                descriptor: { driver: "tmux" as const },
                async exec(cmd: string) {
                    const p = Bun.spawn([shPath, "-c", cmd], { stdout: "pipe", stderr: "pipe" });
                    const [stdout, stderr, exitCode] = await Promise.all([
                        new Response(p.stdout).text(),
                        new Response(p.stderr).text(),
                        p.exited,
                    ]);
                    maxStdoutSeen = Math.max(maxStdoutSeen, stdout.length);
                    // 模拟 tmux 滚动缓冲上限（超过 32KB 的单次输出头部被截掉）
                    const bounded = stdout.length > 32_000 ? stdout.slice(-32_000) : stdout;
                    return { stdout: bounded, stderr, exitCode };
                },
            } as never;

            const res = await transferLayerFile(cappedTmuxDriver, "get", {
                remotePath: fwd(remoteFile),
                localPath: localOut,
            });
            expect(res.verified).toBe(true);
            expect(res.bytes).toBe(128 * 1024);
            expect(maxStdoutSeen).toBeLessThanOrEqual(9_000);
            expect(Buffer.compare(readFileSync(localOut), payload)).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 25_000);

    test("[P2] 下载暂存编码命令抛错时仍进入 finally 清理远端临时文件", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-tmux-get-clean-"));
        try {
            const localOut = join(dir, "local-never-written.bin");
            let stagedTmp = "";
            let cleanedTmp = "";
            const exec: TransferExec = async (cmd) => {
                if (cmd.startsWith("wc -c < ")) return { stdout: "131072\n", exitCode: 0 };
                const mStage = cmd.match(/> '(\/tmp\/filaxis-read-[0-9a-f]+\.b64)'/);
                if (mStage) {
                    stagedTmp = mStage[1]!;
                    throw Object.assign(new Error("模拟编码完成后通道中断"), { outcome: "unknown" as const });
                }
                const mClean = cmd.match(/^rm -f '(\/tmp\/filaxis-read-[0-9a-f]+\.b64)'$/);
                if (mClean) {
                    cleanedTmp = mClean[1]!;
                    return { stdout: "", exitCode: 0 };
                }
                return { stdout: "", exitCode: 0 };
            };
            const dialect = {
                family: "gnu",
                base64Encode: ["base64", "-w", "0"],
                base64Decode: ["base64", "-d"],
                sha256: ["sha256sum"],
            } as never;
            let caught: (Error & { outcome?: string }) | undefined;
            try {
                await getFile(exec, dialect, "/remote/big.bin", localOut, { chunkB64: 12_000 });
            } catch (err) {
                caught = err as Error & { outcome?: string };
            }
            expect(caught?.message).toContain("模拟编码完成后通道中断");
            expect(caught?.outcome).toBe("unknown");
            expect(stagedTmp).toMatch(/^\/tmp\/filaxis-read-[0-9a-f]+\.b64$/);
            expect(cleanedTmp).toBe(stagedTmp);
            expect(() => readFileSync(localOut)).toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
