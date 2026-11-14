/**
 * 层环境规格单测（AC-17：解析纯函数/身份键/漂移/匹配/持久化）
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, renameSync, utimesSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    parseProbeOutput, layerEnvKey, LayerEnvStore, projectConnection, layerFingerprint, matchLayers,
    type LayerEnvConfigFile, type LayerEnvironmentSpec, type LayerEnvEntry,
} from "../src/layer-env.js";

const CONN = { driver: "ssh", target: "192.0.2.10" };

function entry(spec: LayerEnvironmentSpec) {
    return { connection: CONN, environment: spec, discovered_at: "2026-11-07", fingerprint: layerFingerprint(CONN, spec) };
}

describe("parseProbeOutput（AC-17 真实性红线）", () => {
    test("正常蒸馏：os/语言/GPU带显存/包 present-only", () => {
        const out = [
            "fx_os=Ubuntu 24.04.1 LTS",
            "fx_kernel_arch=Linux x86_64",
            "fx_python=Python 3.12.3",
            "fx_node=v22.13.0",
            "fx_gpu=NVIDIA P100, 16384 MiB",
            "fx_cuda=12.4",
            "fx_docker=yes",
            "fx_pkg_torch=2.4.0",
            "fx_tool_git=git version 2.43.0",
            "fx_pkg_numpy=",       // 空=缺席
            "fx_pkg_transformers=$($__FX_PY -c ...)", // 回显行
        ].join("\n");
        const s = parseProbeOutput(out);
        expect(s.os).toBe("Ubuntu 24.04.1 LTS");
        expect(s.python).toBe("Python 3.12.3");
        expect(s.node).toBe("22.13.0");
        expect(s.gpu).toEqual({ model: "NVIDIA P100", vram_mb: 16384 });
        expect(s.cuda).toBe("12.4");
        expect(s.docker).toBe(true);
        expect(s.packages).toEqual(["torch@2.4.0", "git@2.43.0"]); // numpy 缺席/回显丢弃
    });

    test("nvidia-smi 失败文案不得记为 GPU 型号（生产实证红线）", () => {
        const out = "fx_gpu=NVIDIA-SMI has failed because it couldn't communicate with the driver";
        const s = parseProbeOutput(out);
        expect(s.gpu).toBeUndefined();
    });

    test("回显防御：值含 $( 一律丢弃", () => {
        const s = parseProbeOutput('fx_os=$(grep PRETTY_NAME /etc/os-release | head -1 | cut -d\'"\' -f2)');
        expect(s.os).toBeUndefined();
    });

    test("kernel_arch 兜底 os", () => {
        const s = parseProbeOutput("fx_kernel_arch=FreeBSD amd64");
        expect(s.os).toBe("FreeBSD");
    });
});

describe("layerEnvKey（环境身份键——hops 不进键）", () => {
    test("同落点不同路径=同键；端口区分；enter 链进键", () => {
        const a = layerEnvKey({ driver: "ssh", target: "vm", config: { pty: true, sshHops: [{ host: "j1" }], connParams: { port: 22 } } });
        const b = layerEnvKey({ driver: "ssh", target: "vm", config: { pty: true, sshHops: [{ host: "j2" }], connParams: { port: 22 } } });
        expect(a).toBe(b); // hops 不进键（环境归属身份）
        const c = layerEnvKey({ driver: "ssh", target: "vm", config: { pty: true, connParams: { port: 2222 } } });
        expect(c).not.toBe(a); // 端口不同=不同环境
        const d = layerEnvKey({ driver: "ssh", target: "vm", config: { pty: true, enterPipeline: [{ cmd: "docker exec -it gitea bash", label: "gitea" }] } });
        expect(d).toBe("vm/gitea");
        expect(layerEnvKey({ driver: "local" })).toBe("local");
    });
});

describe("LayerEnvStore（JSON 原子写 + 漂移标 stale 不覆盖）", () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-le-"));

    test("upsert/load roundtrip + 指纹漂移 stale", async () => {
        const store = new LayerEnvStore(join(dir, "layers.json"));
        const e1 = entry({ os: "Ubuntu 24.04", gpu: { model: "P100", vram_mb: 16384 } });
        expect((await store.upsert("gpu-host", e1)).stale).toBe(false);
        expect((await store.load()).layers["gpu-host"]!.environment.os).toBe("Ubuntu 24.04");
        // 同规格重写=同指纹 → 不 stale
        expect((await store.upsert("gpu-host", e1)).stale).toBe(false);
        // 环境漂移（规格变化→指纹变化）→ stale 不覆盖
        const e2 = entry({ os: "Ubuntu 26.04" });
        expect((await store.upsert("gpu-host", e2)).stale).toBe(true);
        expect((await store.load()).layers["gpu-host"]!.environment.os).toBe("Ubuntu 24.04"); // 原值保留
        // force 覆写
        expect((await store.upsert("gpu-host", e2, true)).stale).toBe(false);
        expect((await store.load()).layers["gpu-host"]!.environment.os).toBe("Ubuntu 26.04");
        rmSync(dir, { recursive: true, force: true });
    });
});

describe("matchLayers（needs → 命中）", () => {
    const cfg: LayerEnvConfigFile = {
        layers: {
            "gpu-host": entry({ python: "Python 3.12.3", gpu: { model: "P100", vram_mb: 16384 }, packages: ["torch@2.4.0"] }),
            "vm-web": entry({ python: "Python 3.10.2", docker: true }),
            "local": entry({ node: "22.13.0" }),
        },
    };

    test("gpu+torch 命中 GPU 机非 CPU 机（真机用例同构）", () => {
        const hits = matchLayers(cfg, ["gpu", "torch"]);
        expect(hits.map((h) => h.key)).toEqual(["gpu-host"]);
    });

    test("版本比较：python>=3.12 排除 3.10", () => {
        expect(matchLayers(cfg, ["python>=3.12"]).map((h) => h.key)).toEqual(["gpu-host"]);
        expect(matchLayers(cfg, ["python>=3.10"]).map((h) => h.key).sort()).toEqual(["gpu-host", "vm-web"]);
    });

    test("别名匹配：pytorch 命中 torch", () => {
        expect(matchLayers(cfg, ["gpu", "pytorch"]).map((h) => h.key)).toEqual(["gpu-host"]);
    });

    test("docker 布尔 need；无 GPU 层不命中 gpu", () => {
        expect(matchLayers(cfg, ["docker"]).map((h) => h.key)).toEqual(["vm-web"]);
        expect(matchLayers(cfg, ["node"]).map((h) => h.key)).toEqual(["local"]);
    });
});

test("projectConnection：hops 与 enters 进重进路径（环境身份之外）", () => {
    const conn = projectConnection({
        driver: "ssh", target: "vm", config: {
            sshHops: [{ host: "jump" }],
            enterPipeline: [{ cmd: "docker exec -it c bash", label: "c" }],
        },
    });
    expect(conn.hops).toEqual([{ host: "jump" }]);
    expect(conn.enters).toEqual([{ cmd: "docker exec -it c bash", label: "c" }]);
});

// 自挖（十五轮后自审批）：非 pty 层环境键丢 connParams.port——同 host 不同
// port（22 vs 2222）曾互踩同键，规格互相覆盖。
test("layerEnvKey port 区分（自挖 S1）：同 host 不同 port 不同键；同 port 稳定", () => {
    const p22 = layerEnvKey({ driver: "ssh", target: "192.0.2.10", config: { connParams: { port: 22 } } } as never);
    const p2222 = layerEnvKey({ driver: "ssh", target: "192.0.2.10", config: { connParams: { port: 2222 } } } as never);
    const p2222b = layerEnvKey({ driver: "ssh", target: "192.0.2.10", config: { connParams: { port: 2222, user: "root" } } } as never);
    expect(p22).not.toBe(p2222); // 物理不同环境不互踩（修前同键）
    expect(p2222).toBe(p2222b); // 同落点稳定（user 不进键——同机环境规格近似）
});

// 自挖 S2：load-modify-save 无锁——并发 upsert 后者以旧 cfg 覆盖前者，丢更新。
test("LayerEnvStore 并发 upsert 不丢更新（自挖 S2）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-store-"));
    try {
        const store = new LayerEnvStore(join(dir, "env.json"));
        const mk = (k: string): LayerEnvEntry => ({
            connection: { driver: "ssh", target: k },
            environment: { os: `os-${k}` },
            discovered_at: new Date().toISOString(),
            fingerprint: `fp-${k}`,
        });
        await Promise.all([store.upsert("a", mk("a")), store.upsert("b", mk("b"))]);
        const cfg = await store.load(true);
        expect(Object.keys(cfg.layers).sort()).toEqual(["a", "b"]); // 修前：丢一个
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}, 15_000);

// GPT Sol 五十九期 P2-1：link-CAS 舞步——A 复核过后暂停、B 陈锁回收接管提交、
// A 恢复 rename 直接盖掉 B（两个 upsert 都报成功，B 的键蒸发）。rename 是「无条件
// 替换」，link 是「不存在才落位」：EEXIST=并发已提交铁证，中止+移开态旁路留盘、
// load 并入恢复，重试收敛双方都在。
describe("Sol 59：跨实例并发提交不丢更新（link-CAS 舞步）", () => {
    test("A 复核后暂停→B 接管提交→A 恢复：双方键共存", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env59-"));
        try {
            const p = join(dir, "env.json");
            const a = new LayerEnvStore(p);
            const b = new LayerEnvStore(p);
            const mk = (k: string): LayerEnvEntry => ({
                connection: { driver: "ssh", target: k },
                environment: { os: `os-${k}` },
                discovered_at: new Date().toISOString(),
                fingerprint: `fp-${k}`,
            });
            // 白盒驱动 A 的舞步（upsert 的复核钩子不可注入——「复核已过、落位前被
            // 穿透」的暂停窗口经 saveLocked 直达）：钩子先复核（A 真持锁→true），
            // 再睡过 5s 陈锁阈值让 B 完整提交，然后放行
            const relA = await (a as unknown as { acquireLock: () => Promise<{ verifyHeld(): Promise<boolean>; finalize(): Promise<void> }> }).acquireLock();
            const cfgA = await a.load();
            cfgA.layers.alpha = mk("alpha");
            let aErr: unknown = null;
            try {
                await (a as unknown as { saveLocked: (cfg: LayerEnvConfigFile, v?: () => Promise<boolean>) => Promise<void> })
                    .saveLocked(cfgA, async () => {
                        const held = await relA.verifyHeld(); // A 复核时真持锁
                        await new Promise((r) => setTimeout(r, 5_300)); // 暂停：锁过陈阈
                        await b.upsert("beta", mk("beta")); // B 回收接管完整提交
                        return held; // 复核结论 true——A 不知道自己已被回收
                    });
            } catch (e) { aErr = e; } // link-CAS/落位后复核拦下（修前 rename 无声盖掉 B 且 saveLocked 成功）
            expect(aErr).toBeInstanceOf(Error);
            // A 走正门重提交：重读并入旁路（B 的移开态）→ 双方收敛
            await a.upsert("alpha", mk("alpha"));
            await relA.finalize();
            const cfg = await new LayerEnvStore(p).load(true);
            expect(Object.keys(cfg.layers).sort()).toEqual(["alpha", "beta"]); // 修前：只剩 alpha
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test("旁路恢复：data 缺席时 load 从旁路救回（崩溃于移开与落位之间）+ 在场时并入", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env59b-"));
        try {
            const p = join(dir, "env.json");
            writeFileSync(p, JSON.stringify({ layers: { live: entry({ os: "live" }) } }));
            // 模拟舞步崩溃残留：现行态被移开、落位未发生——旁路是唯一状态源
            renameSync(p, `${p}.777-crash.fx-old`);
            const cfg = await new LayerEnvStore(p).load();
            expect(cfg.layers.live).toBeTruthy();
            // data 回场后旁路并入（并集——data 同键胜出）
            writeFileSync(p, JSON.stringify({ layers: { fresh: entry({ os: "fresh" }) } }));
            const cfg2 = await new LayerEnvStore(p).load(true);
            expect(Object.keys(cfg2.layers).sort()).toEqual(["fresh", "live"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 六十期：link-CAS 协议三洞——P1 陈锁穿透后「data 恒胜」在同键冲突选错
// 赢家（旁路里 B 的新值 mtime 更晚却被 A 的陈值压住）；P2-2 舞步不移开自己造的
// 旁路（整档替换已删的层被恢复协议复活）；P2-3 老化旁路只删不写（恢复条目读
// 一次即蒸发）。
describe("Sol 60：link-CAS 协议收口", () => {
    const mk = (k: string): LayerEnvEntry => ({
        connection: { driver: "ssh", target: k },
        environment: { os: `os-${k}` },
        discovered_at: new Date().toISOString(),
        fingerprint: `fp-${k}`,
    });

    test("P1 同键穿透：A 复核后暂停→B 改同键→A 恢复——B 新值胜出、A 得 stale", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env60-"));
        try {
            const p = join(dir, "env.json");
            const a = new LayerEnvStore(p);
            const b = new LayerEnvStore(p);
            const relA = await (a as unknown as { acquireLock: () => Promise<{ verifyHeld(): Promise<boolean>; finalize(): Promise<void> }> }).acquireLock();
            const cfgA = await a.load();
            cfgA.layers.k = mk("old");
            let aErr: unknown = null;
            try {
                await (a as unknown as { saveLocked: (cfg: LayerEnvConfigFile, v?: () => Promise<boolean>) => Promise<void> })
                    .saveLocked(cfgA, async () => {
                        const held = await relA.verifyHeld();
                        await new Promise((r) => setTimeout(r, 5_300)); // 暂停过陈锁阈
                        await b.upsert("k", mk("new")); // B 回收接管——同键改新值
                        return held;
                    });
            } catch (e) { aErr = e; }
            expect(aErr).toBeInstanceOf(Error); // 落位后复核拦下（修前：落位成功=B 被盖）
            // A 走正门重试：mtime 升序合并（旁路 B-new mtime 晚于 data A-old）→ B 新值在场
            // → 指纹不符 → stale:true（修前：data 恒胜吞掉 B 新值 → stale:false 且盘上 old）
            const retry = await a.upsert("k", mk("old"));
            expect(retry).toEqual({ stale: true });
            await relA.finalize();
            const cfg = await new LayerEnvStore(p).load(true);
            expect(cfg.layers.k!.connection.target).toBe("new"); // 修前：old（B 的已提交新值被覆盖）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);

    test("P2-2 整档替换的删除语义：save({}) 后已删层不复活", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env60b-"));
        try {
            const p = join(dir, "env.json");
            const s = new LayerEnvStore(p);
            await s.save({ layers: { alpha: mk("alpha") } });
            await s.save({ layers: {} }); // 整档替换=显式清空
            const cfg = await new LayerEnvStore(p).load(); // 修前：移开旁路并入 → alpha 复活
            expect(Object.keys(cfg.layers)).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("P2-3 老化旁路先压实后清：恢复条目持久化（读一次不蒸发）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env60c-"));
        try {
            const p = join(dir, "env.json");
            writeFileSync(p, JSON.stringify({ layers: { current: mk("current") } }));
            const aside = `${p}.777-aged.fx-old`;
            writeFileSync(aside, JSON.stringify({ layers: { onlyAside: mk("onlyAside") } }));
            const old = new Date(Date.now() - 11 * 60_000);
            utimesSync(aside, old, old); // 超过 10min 压实阈值
            const cfg1 = await new LayerEnvStore(p).load();
            expect(Object.keys(cfg1.layers).sort()).toEqual(["current", "onlyAside"]);
            // 修前：只删不写——第二次读 onlyAside 蒸发。修后：压实已持久（data 含并入态+旁路清除）
            const cfg2 = await new LayerEnvStore(p).load();
            expect(Object.keys(cfg2.layers).sort()).toEqual(["current", "onlyAside"]);
            expect(existsSync(aside)).toBe(false); // 旁路已清（内容在 data 里）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 六十一期 P2 三件：历史旁路复活整档删除（舞步只消自己的旁路）；
// mtime 平局 data 后入压住旁路新值；load 返回缓存别名——upsert 写前改缓存对象、
// 写失败后同实例读到未落盘条目。
describe("Sol 61：协议三缝", () => {
    const mk61 = (k: string): LayerEnvEntry => ({
        connection: { driver: "ssh", target: k },
        environment: { os: `os-${k}` },
        discovered_at: new Date().toISOString(),
        fingerprint: `fp-${k}`,
    });

    test("P2 历史旁路不复活整档删除（崩溃遗留 .fx-old 随舞步一并消费）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env61a-"));
        try {
            const p = join(dir, "env.json");
            const s = new LayerEnvStore(p);
            await s.save({ layers: { live: mk61("live") } });
            // 预置崩溃遗留旁路（非本次舞步产物）
            writeFileSync(`${p}.999-crash.fx-old`, JSON.stringify({ layers: { retired: mk61("retired") } }));
            await s.save({ layers: {} }); // 整档替换=显式清空
            const cfg = await new LayerEnvStore(p).load(true);
            expect(Object.keys(cfg.layers)).toEqual([]); // 修前：retired 经历史旁路复活
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("P2 mtime 平局旁路胜（旧 data 不再压住新旁路）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env61b-"));
        try {
            const p = join(dir, "env.json");
            writeFileSync(p, JSON.stringify({ layers: { k: mk61("old") } }));
            const aside = `${p}.888-tie.fx-old`;
            writeFileSync(aside, JSON.stringify({ layers: { k: mk61("new") } }));
            const t = new Date(Date.now() - 60_000); // 同一时刻（新鲜——不触压实）
            utimesSync(p, t, t);
            utimesSync(aside, t, t);
            const cfg = await new LayerEnvStore(p).load();
            expect(cfg.layers.k!.connection.target).toBe("new"); // 修前：old（data 平局压住）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("P2 写失败不污染同实例缓存（load 不再外泄缓存别名）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env61c-"));
        try {
            const p = join(dir, "env.json");
            const s = new LayerEnvStore(p);
            await s.upsert("real", mk61("real")); // 落盘 + 预热缓存
            // 注入写失败：upsert 在 load 后已改 cfg.layers——别名泄漏曾把 ghost
            // 塞进缓存对象，写失败后同实例仍读到
            (s as unknown as { saveLocked: unknown }).saveLocked = async () => { throw new Error("disk full"); };
            await expect(s.upsert("ghost", mk61("ghost"))).rejects.toThrow(/disk full/);
            const same = await s.load(); // 同实例——修前：ghost 在缓存里
            expect(Object.keys(same.layers)).toEqual(["real"]);
            const fresh = await new LayerEnvStore(p).load();
            expect(Object.keys(fresh.layers)).toEqual(["real"]); // 盘上对照（本就无 ghost）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});
