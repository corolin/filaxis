/**
 * 文件传输单测（AC-15：mock 远端 bash 语义——真机 sftp/OPNsense/Alpine 属 CI 矩阵）
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { putFile, getFile, sftpPutFile, TransferVerificationError, type TransferExec, type SftpSpawnImpl } from "../src/file-transfer.js";
import { probeDialect, NULL_DIALECT, type RemoteDialect } from "../src/dialect.js";

const GNU: RemoteDialect = {
    family: "gnu",
    base64Encode: ["base64", "-w", "0"],
    base64Decode: ["base64", "-d"],
    sha256: ["sha256sum"],
};

/**
 * mock 远端：内存文件系统 + bash 语义回放（printf append / base64 -d / wc -c /
 * sha256sum / rm / base64 -w 0 编码）。put 走 printf 分块真实拼接路径。
 */
function mockRemote() {
    const files = new Map<string, Buffer>();
    const exec: TransferExec = async (cmd) => {
        const m = cmd.match(/^printf %s '([^']*)' >> '(.+)'$/);
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
        let mm = cmd.match(/^: > '(.+)'$/);
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
        // mock 无挂载无写入失败，mv 恒成功（落点取 test ! -d 的目标=真身）
        // R8 #2 数字模式权限保持后形态：__fx_pm=$(stat -c …)+[ -n ]&&chmod …; chown …; if mv …
        mm = cmd.match(/^(?:test ! -d '(.+?)' \|\| \{ echo FX_IS_DIR; exit 1; \}; )?\{ ?__fx_tgt=[^;]*; __fx_pm=[^;]*; \[ -n "[^"]*" \] && chmod[^;]*; (?:chown)[^;]*; if mv '(.+?)' /);
        if (!mm) { // 兼容旧形态（无 __fx_pm 段）
            mm = cmd.match(/^(?:test ! -d '(.+?)' \|\| \{ echo FX_IS_DIR; exit 1; \}; )?\{ ?__fx_tgt=[^;]*; (?:chmod|chown)[^;]*; (?:chmod|chown)[^;]*; if mv '(.+?)' /);
        }
        if (mm) {
            const b = files.get(mm[2]!);
            if (!b) return { stdout: "", exitCode: 1 }; // 源不存在 → 真实 mv 报错
            files.set(mm[1]!, b);
            files.delete(mm[2]!);
            return { stdout: "FX_MV_OK", exitCode: 0 };
        }
        // forceInplace 形态（显式请求保留 inode 写）——cat src > "$tgt" && rm src
        mm = cmd.match(/^cat '([^']+)' > [^&]+ && rm -f '([^']+)' && echo FX_MV_CAT$/);
        if (mm) {
            const b = files.get(mm[1]!);
            if (!b) return { stdout: "", exitCode: 1 };
            files.set(mm[1]!.replace(/\.filaxis-out-[0-9a-f]+$/, ""), b); // 落点=去 out 后缀的目标
            files.delete(mm[1]!);
            return { stdout: "FX_MV_CAT", exitCode: 0 };
        }
        mm = cmd.match(/^base64 -d < '([^']*)' > '([^']*)'(?: && rm -f '([^']*)')?$/);
        if (mm) {
            const src = files.get(mm[1]!);
            if (!src) return { stdout: "", exitCode: 1 }; // 真实 shell：源不存在 decode 失败（Astra 六轮 #2 mock 失真根因）
            files.set(mm[2]!, Buffer.from(src.toString("utf-8"), "base64"));
            if (mm[3]) files.delete(mm[3]);
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
            let m = cmd.match(/^base64 -D < '([^']*)' > '([^']*)'(?: && rm -f '([^']*)')?$/);
            if (m) {
                files2.set(m[2]!, Buffer.from(files2.get(m[1]!)?.toString("utf-8") ?? "", "base64"));
                if (m[3]) files2.delete(m[3]);
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
        expect(gotArgv).toEqual(["-o", "ConnectTimeout=10", "user@host", "-b", "-"]);
        expect(gotBatch).toMatch(/^put '.+' '\/r\/big\.bin'$/m);
        expect(r.verified).toBe(true); // 与 base64 路径同一校验标准
        expect(r.verification).toBe("sha256");
        expect(r.bytes).toBe(64 * 1024);
        rmSync(dir2, { recursive: true, force: true });
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
            const m = cmd.match(/^printf %s '[^']*' >> '([^']+)'$/);
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
            if (/^rm -f '.+\.filaxis-tmp-[0-9a-f]+'$/.test(cmd)) return { stdout: "", exitCode: 1 }; // 清理失败
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
            if (cmd.startsWith("printf %s ") && ++n >= 2) return { stdout: "write error: No space left on device", exitCode: 1 };
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
