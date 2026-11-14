/**
 * 层环境规格单测（AC-17：解析纯函数/身份键/漂移/匹配/持久化）
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, renameSync, utimesSync, readdirSync, existsSync, readFileSync, statSync } from "node:fs";
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
            renameSync(p, `${p}.111-222-aaaa.fx-old`);
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
            const aside = `${p}.111-222-bbbb.fx-old`;
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
            writeFileSync(`${p}.111-222-cccc.fx-old`, JSON.stringify({ layers: { retired: mk61("retired") } }));
            await s.save({ layers: {} }); // 整档替换=显式清空
            const cfg = await new LayerEnvStore(p).load(true);
            expect(Object.keys(cfg.layers)).toEqual([]); // 修前：retired 经历史旁路复活
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("P2 平局序戳裁决：旁路带新戳胜（旧 data 不再压住新旁路）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env61b-"));
        try {
            const p = join(dir, "env.json");
            // 带戳形态（store 自写档恒带 _fx_rev——真实旁路/data 皆如此）
            writeFileSync(p, JSON.stringify({ layers: { k: mk61("old") }, _fx_rev: "1000000000000-1-aa" }));
            const aside = `${p}.111-222-dddd.fx-old`;
            writeFileSync(aside, JSON.stringify({ layers: { k: mk61("new") }, _fx_rev: "2000000000000-1-bb" }));
            const t = new Date(Date.now() - 60_000); // 同刻 mtime——戳裁决
            utimesSync(p, t, t);
            utimesSync(aside, t, t);
            const cfg = await new LayerEnvStore(p).load();
            expect(cfg.layers.k!.connection.target).toBe("new"); // 旁路戳新胜
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

// GPT Sol 六十二期 P2 三件：嵌套改缓存条目随后续 upsert 落盘（浅副本漏嵌套）；
// 舞步窗口读成空档（列旁路先于 stat——两步之间现行态被移开）；同刻平局反转
// （崩溃于落位后清理前：新 data+旧旁路同刻，固定选旁路回退成旧值）。
describe("Sol 62：读隔离/舞步窗口/序戳裁决", () => {
    const mk62 = (k: string): LayerEnvEntry => ({
        connection: { driver: "ssh", target: k },
        environment: { os: `os-${k}` },
        discovered_at: new Date().toISOString(),
        fingerprint: `fp-${k}`,
    });

    test("P2 嵌套改不污染缓存不落盘（load 深副本）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env62a-"));
        try {
            const p = join(dir, "env.json");
            const s = new LayerEnvStore(p);
            await s.upsert("real", mk62("real"));
            const c = await s.load();
            c.layers.real!.environment.os = "MUTATED"; // 嵌套字段就地改
            expect(readFileSync(p, "utf-8")).not.toContain("MUTATED"); // 当时盘上仍原值
            await s.upsert("other", mk62("other")); // 后续写——修前：MUTATED 随缓存落盘
            const fresh = await new LayerEnvStore(p).load();
            expect(fresh.layers.real!.environment.os).toBe("os-real");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("P2 舞步窗口不读成空档（列旁路后、读 data 前现行态被移开——重列捞回）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env62b-"));
        try {
            const p = join(dir, "env.json");
            writeFileSync(p, JSON.stringify({ layers: { live: mk62("live") } }));
            const s = new LayerEnvStore(p);
            // 注入：首列旁路（此刻无旁路）返回后、data 读取前——现行态被移开
            //（模拟提交方舞步落在我们 collectDocs 的列旁路与读之间）
            const origList = (s as unknown as { listAsides: () => Promise<Array<{ p: string }>> }).listAsides.bind(s);
            let moved = false;
            (s as unknown as { listAsides: unknown }).listAsides = async () => {
                const r = await origList();
                if (!moved) {
                    moved = true;
                    renameSync(p, `${p}.111-222-eeee.fx-old`);
                }
                return r;
            };
            const cfg = await s.load();
            expect(Object.keys(cfg.layers)).toContain("live"); // 修前：{}（空档）
            expect(cfg.layers.live!.connection.target).toBe("live");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("P2 平局序戳裁决：崩溃清理前态（新 data 带新戳胜旧旁路）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env62c-"));
        try {
            const p = join(dir, "env.json");
            // 崩溃于「落位后、旁路清理前」：data=新提交（戳新），旁路=被移开的旧态（戳旧）
            writeFileSync(p, JSON.stringify({ layers: { k: mk62("new") }, _fx_rev: "2000000000000-1-cc", _fx_seen: ["1000000000000-1-dd"] }));
            const aside = `${p}.111-222-ffff.fx-old`;
            writeFileSync(aside, JSON.stringify({ layers: { k: mk62("old") }, _fx_rev: "1000000000000-1-dd" }));
            const t = new Date(Date.now() - 60_000); // 同刻——戳裁决
            utimesSync(p, t, t);
            utimesSync(aside, t, t);
            const cfg = await new LayerEnvStore(p).load();
            expect(cfg.layers.k!.connection.target).toBe("new"); // 修前：old（平局固定选旁路回退）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("P2 双无戳同刻平局：data 胜（护已落位提交——手造/遗老档的结构性不可判定选边）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env62d-"));
        try {
            const p = join(dir, "env.json");
            writeFileSync(p, JSON.stringify({ layers: { k: mk62("landed") } })); // 无戳（遗老形态）
            const aside = `${p}.111-222-gggg.fx-old`;
            writeFileSync(aside, JSON.stringify({ layers: { k: mk62("aside") } }));
            const t = new Date(Date.now() - 60_000);
            utimesSync(p, t, t);
            utimesSync(aside, t, t);
            const cfg = await new LayerEnvStore(p).load();
            expect(cfg.layers.k!.connection.target).toBe("landed"); // 已落位者胜
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 六十三期：P1×2——旁路归属前后缀判定把同目录他档（env.json.other）
// 的恢复锚误认自家并连删；同刻 mtime 下持锁 upsert 从旧缓存取基线丢 B 的更新。
// P2×2——读跨完整提交（move→link→清旁路全毕）重扫只看旁路曾读成空档；时钟
// 回拨颠倒序戳（陈锁穿透后陈值反胜）。
describe("Sol 63：归属隔离/锁内重读/读穿完整提交/回拨还原", () => {
    const mk63 = (k: string): LayerEnvEntry => ({
        connection: { driver: "ssh", target: k },
        environment: { os: `os-${k}` },
        discovered_at: new Date().toISOString(),
        fingerprint: `fp-${k}`,
    });

    test("P1 旁路归属 uniq 形态全匹配：env.json 不吃 env.json.other 的恢复锚", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env63a-"));
        try {
            const p = join(dir, "env.json");
            const other = join(dir, "env.json.other");
            // 他档崩溃遗留旁路（uniq 形态——前缀含 "env.json." 曾被误认领）
            writeFileSync(`${other}.4242-1794000000-zzzz.fx-old`, JSON.stringify({ layers: { sole: mk63("sole") } }));
            await new LayerEnvStore(p).save({ layers: { mine: mk63("mine") } }); // 舞步+收尾清理
            // 修前：他档旁路被当自家 preAsides 连删——env.json.other 唯一恢复锚蒸发
            expect(existsSync(`${other}.4242-1794000000-zzzz.fx-old`)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("P1 锁内强制重读：同刻 mtime 不丢 B 的更新", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env63b-"));
        try {
            const p = join(dir, "env.json");
            const a = new LayerEnvStore(p);
            const b = new LayerEnvStore(p);
            await a.upsert("a", mk63("a"));
            await a.load(); // A 预热缓存（mtime M）
            const m = statSync(p).mtimeMs;
            await b.upsert("b", mk63("b")); // B 写入
            utimesSync(p, new Date(m), new Date(m)); // 文件系统把两次写入记成同一 mtime
            await a.upsert("c", mk63("c")); // A 持锁写——修前：旧缓存基线 {a} → {a,c}，b 蒸发
            const cfg = await new LayerEnvStore(p).load(true);
            expect(Object.keys(cfg.layers).sort()).toEqual(["a", "b", "c"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("P2 读跨完整提交不返回空档（重扫旁路外主档也重读）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env63c-"));
        try {
            const p = join(dir, "env.json");
            writeFileSync(p, JSON.stringify({ layers: { v1: mk63("v1") } }));
            const s = new LayerEnvStore(p);
            // 注入两相：①列旁路后现行态被移开（随后的主档读必失败）②重扫时
            // 完整提交已毕（新主档落位+旁路清理）——修前只重扫旁路→{}
            const asidePath = `${p}.31337-1794000001-wwww.fx-old`;
            const orig = (s as unknown as { listAsides: () => Promise<Array<{ p: string }>> }).listAsides.bind(s);
            let phase = 0;
            (s as unknown as { listAsides: unknown }).listAsides = async () => {
                const r = await orig();
                if (phase === 0) { phase = 1; renameSync(p, asidePath); } // 移开窗口开
                else if (phase === 1) { phase = 2; writeFileSync(p, JSON.stringify({ layers: { v2: mk63("v2") } })); rmSync(asidePath); } // 提交收尾
                return r;
            };
            const cfg = await s.load();
            expect(Object.keys(cfg.layers)).toEqual(["v2"]); // 修前：{}（空档）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("P2 时钟回拨：落位后锁失即物理还原——B 新值胜出、A 得 stale", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env63d-"));
        try {
            const p = join(dir, "env.json");
            const a = new LayerEnvStore(p);
            const b = new LayerEnvStore(p);
            const relA = await (a as unknown as { acquireLock: () => Promise<{ verifyHeld(): Promise<boolean>; finalize(): Promise<void> }> }).acquireLock();
            const cfgA = await a.load();
            cfgA.layers.k = mk63("old");
            let aErr: unknown = null;
            let hookRan = false; // verifyHeld 被调两次（写前+落位后）——暂停注入只走一次
            try {
                await (a as unknown as { saveLocked: (cfg: LayerEnvConfigFile, v?: () => Promise<boolean>) => Promise<void> })
                    .saveLocked(cfgA, async () => {
                        if (hookRan) return relA.verifyHeld(); // 落位后复核：真值（锁已失→false）
                        hookRan = true;
                        const held = await relA.verifyHeld();
                        await new Promise((r) => setTimeout(r, 5_300)); // 暂停过陈锁阈
                        rmSync(`${p}.lock`); // 手动模拟陈锁回收（时钟回拨下 mtime 判龄不可用）
                        const realNow = Date.now;
                        Date.now = () => realNow() - 10_000; // 回拨 10s——B 的序戳取到比 A 的 tmp 更早的墙钟
                        try { await b.upsert("k", mk63("new")); } finally { Date.now = realNow; }
                        return held;
                    });
            } catch (e) { aErr = e; }
            expect(aErr).toBeInstanceOf(Error); // 落位后锁失拦下
            await relA.finalize(); // 白锁句柄必关（flake 治理：此行曾在改写中丢失——句柄滞留到 GC 报 FileHandle 错、随机砸中后续任意用例=五轮 flake 真凶）
            const retry = await a.upsert("k", mk63("old")); // A 正门重试
            expect(retry).toEqual({ stale: true }); // 修前：stale:false（回拨序戳让陈值看起来更新）
            const cfg = await new LayerEnvStore(p).load(true);
            expect(cfg.layers.k!.connection.target).toBe("new"); // B 的已提交新值胜出
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20_000);
});

// GPT Sol 六十四期 P2×4（layer-env）：读自主档已移开起步+列旁路前完整提交收尾
// →曾读成空档；首写失锁报冲突但产物留盘；整档替换落位后中断旧旁路复活已删
// 条目（须按序戳门控：旧于主档=作者已删）；同刻 mtime 普通读仍旧值（mtime
// 缓存失明）。
describe("Sol 64：读穿/首写撤产/门控/缓存退役", () => {
    const mk64 = (k: string): LayerEnvEntry => ({
        connection: { driver: "ssh", target: k },
        environment: { os: `os-${k}` },
        discovered_at: new Date().toISOString(),
        fingerprint: `fp-${k}`,
    });

    test("#1 读自主档已移开起步：完整提交跨过列旁路——重探主档不读空", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env64a-"));
        try {
            const p = join(dir, "env.json");
            writeFileSync(p, JSON.stringify({ layers: { v1: mk64("v1") } }));
            const asidePath = `${p}.111-222-hhhh.fx-old`;
            renameSync(p, asidePath); // 写入方已移开（load 的 stat 将失败）
            const s = new LayerEnvStore(p);
            const orig = (s as unknown as { listAsides: () => Promise<Array<{ p: string }>> }).listAsides.bind(s);
            let done = false;
            (s as unknown as { listAsides: unknown }).listAsides = async () => {
                if (!done) {
                    done = true;
                    // 列旁路前写入方完整收尾：归位新档+清旁路——旁路旧列与主档 stat 双空
                    writeFileSync(p, JSON.stringify({ layers: { v2: mk64("v2") } }));
                    rmSync(asidePath);
                }
                return orig();
            };
            const cfg = await s.load();
            expect(Object.keys(cfg.layers)).toEqual(["v2"]); // 修前：{}
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("#2 首写失锁：报冲突的产物撤下（盘面回无档原态）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env64b-"));
        try {
            const p = join(dir, "env.json"); // 无既有档
            const s = new LayerEnvStore(p);
            const relA = await (s as unknown as { acquireLock: () => Promise<{ verifyHeld(): Promise<boolean>; finalize(): Promise<void> }> }).acquireLock();
            let ran = false;
            let aErr: unknown = null;
            try {
                await (s as unknown as { saveLocked: (cfg: LayerEnvConfigFile, v?: () => Promise<boolean>) => Promise<void> })
                    .saveLocked({ layers: { x: mk64("x") } }, async () => {
                        if (ran) return relA.verifyHeld();
                        ran = true;
                        const held = await relA.verifyHeld();
                        rmSync(`${p}.lock`); // 模拟失锁（落位后复核将 false）
                        return held;
                    });
            } catch (e) { aErr = e; }
            expect(aErr).toBeInstanceOf(Error);
            expect(existsSync(p)).toBe(false); // 修前：true（首次写无移开态可还原、产物留盘）
            await relA.finalize();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("#3 整档替换落位后中断：旧旁路（戳旧）不复活已删条目", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env64c-"));
        try {
            const p = join(dir, "env.json");
            // 崩溃于「落位后、清旁路前」：主档=整档清空（新戳），旁路=被移开旧态（旧戳）
            writeFileSync(p, JSON.stringify({ layers: {}, _fx_rev: "2000000000000-1-kk", _fx_seen: ["1000000000000-1-ll"] }));
            writeFileSync(`${p}.111-222-jjjj.fx-old`, JSON.stringify({ layers: { retired: mk64("retired") }, _fx_rev: "1000000000000-1-ll" }));
            const cfg = await new LayerEnvStore(p).load();
            expect(Object.keys(cfg.layers)).toEqual([]); // 修前：retired 经旧旁路复活
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("#4 mtime 缓存退役：同刻写入普通 load 也读新值", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env64d-"));
        try {
            const p = join(dir, "env.json");
            const a = new LayerEnvStore(p);
            const b = new LayerEnvStore(p);
            await a.upsert("k", mk64("old"));
            await a.load(); // 预热（修前缓存命中路径）
            const m = statSync(p).mtimeMs;
            await b.upsert("k", mk64("new"), true); // force——同键指纹不同，非 force 会被 stale 检测正当拦下
            utimesSync(p, new Date(m), new Date(m)); // 文件系统把两次写入记成同一 mtime
            const cfg = await a.load(); // 不带 force——修前：旧值（缓存失明）
            expect(cfg.layers.k!.connection.target).toBe("new");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 六十五期：#4 主档重探曾只在零旁路时执行——捞到旧旁路+新主档落位→
// 返回旧值；#5 带戳主档对无戳旧旁路（遗老档升级首次替换中断）曾绕过门控复活
// 已删条目。
describe("Sol 65：重探扩面/门控扩面", () => {
    const mk65 = (k: string): LayerEnvEntry => ({
        connection: { driver: "ssh", target: k },
        environment: { os: `os-${k}` },
        discovered_at: new Date().toISOString(),
        fingerprint: `fp-${k}`,
    });

    test("#4 捞到旧旁路后新主档落位——重探读新值", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env65a-"));
        try {
            const p = join(dir, "env.json");
            writeFileSync(p, JSON.stringify({ layers: { k: mk65("old") } }));
            const asidePath = `${p}.111-222-mmmm.fx-old`;
            renameSync(p, asidePath); // 移开窗口（load 的 stat 将失败）
            const s = new LayerEnvStore(p);
            const orig = (s as unknown as { listAsides: () => Promise<Array<{ p: string }>> }).listAsides.bind(s);
            let done = false;
            (s as unknown as { listAsides: unknown }).listAsides = async () => {
                const r = await orig(); // 先列——捞到旧旁路（非零）
                if (!done) {
                    done = true;
                    writeFileSync(p, JSON.stringify({ layers: { k: mk65("new") } })); // 新主档落位
                }
                return r;
            };
            const cfg = await s.load();
            expect(cfg.layers.k!.connection.target).toBe("new"); // 修前：old（旁路非零不重探）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("#5 带戳主档+无戳旧旁路（升级首次替换中断）——已删条目不复活", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env65b-"));
        try {
            const p = join(dir, "env.json");
            // 升级路径：主档=带戳空档（首次 post-升级整档替换落位），旁路=被移开的
            // 遗老旧档（无戳）且未及清理
            writeFileSync(p, JSON.stringify({ layers: {}, _fx_rev: "2000000000000-1-nn" }));
            writeFileSync(`${p}.111-222-nnnn.fx-old`, JSON.stringify({ layers: { retired: mk65("retired") } }));
            const cfg = await new LayerEnvStore(p).load(true);
            expect(Object.keys(cfg.layers)).toEqual([]); // 修前：retired 经无戳旁路复活
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 六十六期：#3 时钟回拨+陈锁踩踏者崩溃于还原前——序戳倒挂把已提交
// 新值判过期；血统 _fx_base（写入时盘面最大 rev，因果链不受回拨影响）裁决。
// #4 Windows/macOS 大小写不敏感文件系统：仅改路径大小写曾认不到自己的旁路。
describe("Sol 66：血统裁决/大小写归属", () => {
    const mk66 = (k: string): LayerEnvEntry => ({
        connection: { driver: "ssh", target: k },
        environment: { os: `os-${k}` },
        discovered_at: new Date().toISOString(),
        fingerprint: `fp-${k}`,
    });

    test("#3 回拨踩踏崩溃残留：旁路 rev 在主档血统外——已提交新值救回", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env66a-"));
        try {
            const p = join(dir, "env.json");
            // 踩踏者 A 崩溃于落位后还原前：主档=A 的旧值（戳 5000=正常钟；血统只含
            // 1000——A 从未见过 B 的提交）；旁路=B 的已提交新值（戳 3000=回拨钟，
            // 序戳倒挂但血统外）
            writeFileSync(p, JSON.stringify({ layers: { k: mk66("old") }, _fx_rev: "5000000000000-1-aa", _fx_base: "1000000000000-1-pp" }));
            writeFileSync(`${p}.111-222-qqqq.fx-old`, JSON.stringify({ layers: { k: mk66("new") }, _fx_rev: "3000000000000-1-bb" }));
            const cfg = await new LayerEnvStore(p).load(true);
            expect(cfg.layers.k!.connection.target).toBe("new"); // 修前：old（戳序把 B 判过期）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    // 血统内对照：旁路 rev 在主档血统内=作者确曾见过（整档替换删除成立）
    test("#3b 血统内旁路（作者见过）：整档替换删除仍成立", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env66b-"));
        try {
            const p = join(dir, "env.json");
            writeFileSync(p, JSON.stringify({ layers: {}, _fx_rev: "2000000000000-1-cc", _fx_base: "1500000000000-1-rr" }));
            writeFileSync(`${p}.111-222-rrrr.fx-old`, JSON.stringify({ layers: { retired: mk66("retired") }, _fx_rev: "1500000000000-1-rr" }));
            const cfg = await new LayerEnvStore(p).load(true);
            expect(Object.keys(cfg.layers)).toEqual([]); // retired 不复活（血统内=知悉后删）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    // 大小写敏感平台（Linux）不认领他名旁路才是正确行为——仅不敏感平台跑
    test.skipIf(process.platform !== "win32" && process.platform !== "darwin")
    ("#4 大小写不敏感平台：CASE.JSON 认得 case.json 的旁路", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env66c-"));
        try {
            const p = join(dir, "case.json");
            writeFileSync(p, JSON.stringify({ layers: { live: mk66("live") } }));
            renameSync(p, `${p}.111-222-ssss.fx-old`); // 移开（恢复锚）
            const s = new LayerEnvStore(join(dir, "CASE.JSON")); // 仅大小写不同
            const cfg = await s.load();
            expect(cfg.layers.live).toBeTruthy(); // 修前：{}（前缀匹配大小写敏感认不到）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 六十七期：#1 首写者（盘面为空→无血统字段）落位后中断——上界判据
// 把 B 的已提交旁路判过期；#2 已知旧档（∈集合血统）仅因墙钟戳超上界复活已删
// 条目。集合血统 _fx_seen（写入时盘面全部 rev）成员判定免疫回拨。
describe("Sol 67：集合血统", () => {
    const mk67 = (k: string): LayerEnvEntry => ({
        connection: { driver: "ssh", target: k },
        environment: { os: `os-${k}` },
        discovered_at: new Date().toISOString(),
        fingerprint: `fp-${k}`,
    });

    test("#1 首写见空盘（无血统字段）踩踏残留——B 的已提交新值救回", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env67a-"));
        try {
            const p = join(dir, "env.json");
            // A 首写：准备时盘面为空（无 _fx_seen/_fx_base）——落位后中断；
            // B 已提交的新值在旁路（回拨钟：戳 3000 低于 A 的 5000）
            writeFileSync(p, JSON.stringify({ layers: { k: mk67("old") }, _fx_rev: "5000000000000-1-aa" }));
            writeFileSync(`${p}.111-222-tttt.fx-old`, JSON.stringify({ layers: { k: mk67("new") }, _fx_rev: "3000000000000-1-bb" }));
            const cfg = await new LayerEnvStore(p).load(true);
            expect(cfg.layers.k!.connection.target).toBe("new"); // 修前：old（无血统按墙钟比较跳过 B）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("#2 集合内旧档（作者见过）墙钟戳超上界——已删条目不复活", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env67b-"));
        try {
            const p = join(dir, "env.json");
            // 删除者带集合血统见过旧档（rev 9000）；其 _fx_base 上界（8000）低于
            // 旧档戳——上界判据曾误判「没见过」而复活 retired
            writeFileSync(p, JSON.stringify({ layers: {}, _fx_rev: "1000000000000-1-cc", _fx_base: "8000000000000-1-qq", _fx_seen: ["9000000000000-1-rr"] }));
            writeFileSync(`${p}.111-222-uuuu.fx-old`, JSON.stringify({ layers: { retired: mk67("retired") }, _fx_rev: "9000000000000-1-rr" }));
            const cfg = await new LayerEnvStore(p).load(true);
            expect(Object.keys(cfg.layers)).toEqual([]); // 集合判据：见过=知悉后删
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 六十八期：#3 主档移开窗口（下次提交未落位）——无主档时恢复曾绕过
// _fx_seen 直并全部旁路（已删条目复活）；#4 多旁路恢复——旁路间曾按墙钟排序
// （回拨下新旁路 seen 已录旧旁路、戳却更小——旧值覆盖新值）。锚点化：统摄旁路
//（seen 收录其余带戳档=因果最新）作锚，血统门控同权适用。
describe("Sol 68：锚点化恢复", () => {
    const mk68 = (k: string): LayerEnvEntry => ({
        connection: { driver: "ssh", target: k },
        environment: { os: `os-${k}` },
        discovered_at: new Date().toISOString(),
        fingerprint: `fp-${k}`,
    });

    test("#3 主档移开窗口：统摄旁路作锚——已删条目不复活", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env68a-"));
        try {
            const p = join(dir, "env.json");
            // 主档（整档清空、见过旧档）被移开成旁路——模拟下一次提交尚未落位
            writeFileSync(`${p}.111-222-vvvv.fx-old`, JSON.stringify({ layers: {}, _fx_rev: "2000000000000-1-ee", _fx_seen: ["1000000000000-1-ff"] }));
            writeFileSync(`${p}.111-222-wwww.fx-old`, JSON.stringify({ layers: { retired: mk68("retired") }, _fx_rev: "1000000000000-1-ff" }));
            const cfg = await new LayerEnvStore(p).load(true);
            expect(Object.keys(cfg.layers)).toEqual([]); // 修前：retired 复活（无主档绕过血统）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);

    test("#4 多旁路回拨：统摄旁路（seen 已录旧档、戳反小）作锚——新值胜出", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env68b-"));
        try {
            const p = join(dir, "env.json");
            // 新旁路（回拨钟：戳 3000 小于旧旁路 9000；seen 已录旧旁路）
            writeFileSync(`${p}.111-222-xxxx.fx-old`, JSON.stringify({ layers: { k: mk68("new") }, _fx_rev: "3000000000000-1-gg", _fx_seen: ["9000000000000-1-hh"] }));
            writeFileSync(`${p}.111-222-yyyy.fx-old`, JSON.stringify({ layers: { k: mk68("old") }, _fx_rev: "9000000000000-1-hh" }));
            const cfg = await new LayerEnvStore(p).load(true);
            expect(cfg.layers.k!.connection.target).toBe("new"); // 修前：old（旁路间墙钟排序）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 六十九期 #2：三代旁路（A→B→C，seen 链式、回拨下墙钟戳逐代减小）——
// 统摄判据只查直接收录曾漏 C 经 B 对 A 的继承（旧值+已删条目齐回）。锚点改选
// 「无人见过者」+ 血统传递闭包。
describe("Sol 69：传递闭包", () => {
    const mk69 = (k: string): LayerEnvEntry => ({
        connection: { driver: "ssh", target: k },
        environment: { os: `os-${k}` },
        discovered_at: new Date().toISOString(),
        fingerprint: `fp-${k}`,
    });

    test("三代旁路：C（seen 只记 B、墙钟戳最小）作锚——新值胜出且 retired 不复活", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env69-"));
        try {
            const p = join(dir, "env.json");
            // 墙钟逐代回拨：A(9000) → B(5000) → C(1000)；seen 链：B 记 A、C 只记 B
            writeFileSync(`${p}.111-222-zzzz.fx-old`, JSON.stringify({ layers: { k: mk69("a"), retired: mk69("retired") }, _fx_rev: "9000000000000-1-a69" }));
            writeFileSync(`${p}.111-222-aaaa.fx-old`, JSON.stringify({ layers: { k: mk69("b") }, _fx_rev: "5000000000000-1-b69", _fx_seen: ["9000000000000-1-a69"] }));
            writeFileSync(`${p}.111-222-bbbb.fx-old`, JSON.stringify({ layers: { k: mk69("c") }, _fx_rev: "1000000000000-1-c69", _fx_seen: ["5000000000000-1-b69"] }));
            const cfg = await new LayerEnvStore(p).load(true);
            expect(cfg.layers.k!.connection.target).toBe("c"); // 修前：b（墙钟序）
            expect(cfg.layers.retired).toBeUndefined(); // 修前：retired 经 A 复活（直接收录漏 A）
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// flake 治理排障（Sol 69 后专项）：全量下 GC 报「FileHandle closed during
// garbage collection (env.json.lock)」——锁句柄泄漏被算到当时在跑的用例头上。
test("锁句柄零泄漏（强制 GC 不报 FileHandle 错误）", async () => {
    // 重放典型生命周期后强制 GC——若有未 finalize 的锁句柄，Bun.gc 会当场抛错
    const dir = mkdtempSync(join(tmpdir(), "fx-env-gc-"));
    try {
        const p = join(dir, "env.json");
        const s = new LayerEnvStore(p);
        await s.upsert("a", { connection: { driver: "local" }, environment: {}, discovered_at: "", fingerprint: "f" });
        await s.load();
        await s.save({ layers: {} });
        Bun.gc(true);
        expect(true).toBe(true); // GC 无抛错=句柄全关
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}, 15_000);

// GPT Sol 七十期 #2：主档在场时 kept 旁路间曾按墙钟序合并——回拨下后继
//（seen 已录前代、戳反小）被前代覆盖，已删条目复活。kept 内部辈分门控：被
// 另一 kept 档见过=后继承继（整档不并入），按辈分深度定并入序。
describe("Sol 70：kept 辈分门控", () => {
    test("主档独立 + A/B 旁路（B 见过 A、回拨戳反小）——B 胜出且 retired 不复活", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env70-"));
        try {
            const p = join(dir, "env.json");
            const mk70 = (k: string): LayerEnvEntry => ({
                connection: { driver: "ssh", target: k },
                environment: { os: `os-${k}` },
                discovered_at: new Date().toISOString(),
                fingerprint: `fp-${k}`,
            });
            // 主档独立（血统不含 A/B——两者皆救回）；A=旧代（retired+k:old）；
            // B=A 的后继（seen 录 A、删 retired、改 k:new；回拨钟戳 3000 < A 的 9000）
            writeFileSync(p, JSON.stringify({ layers: { base: mk70("base") }, _fx_rev: "5000000000000-1-mm" }));
            writeFileSync(`${p}.111-222-pppp.fx-old`, JSON.stringify({ layers: { k: mk70("old"), retired: mk70("retired") }, _fx_rev: "9000000000000-1-nn" }));
            writeFileSync(`${p}.111-222-qqqq.fx-old`, JSON.stringify({ layers: { k: mk70("new") }, _fx_rev: "3000000000000-1-oo", _fx_seen: ["9000000000000-1-nn"] }));
            const cfg = await new LayerEnvStore(p).load(true);
            expect(cfg.layers.k!.connection.target).toBe("new"); // 修前：old（kept 按墙钟序、A 后并入）
            expect(cfg.layers.retired).toBeUndefined(); // 修前：retired 经 A 复活（B 的删除被无视）
            expect(cfg.layers.base).toBeTruthy(); // 主档键如常
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

// GPT Sol 七十一期 P1：主档截断（坏 JSON）仍占主位——恢复锚定坏档按墙钟并
// 旁路（回拨下旧 A 覆盖见过它的 B、复活已删条目）；旁路超 10min 时单次 load
// 的压实把错果写进主档并连删两份旁路=B 永久丢失。坏主档视同缺席（不作锚）。
describe("Sol 71：坏主档不作锚", () => {
    test("截断主档 + 老化旁路：B 胜出、压实落盘 B、旁路清、retired 不复活", async () => {
        const dir = mkdtempSync(join(tmpdir(), "fx-env71-"));
        try {
            const p = join(dir, "env.json");
            const mk71 = (k: string): LayerEnvEntry => ({
                connection: { driver: "ssh", target: k },
                environment: { os: `os-${k}` },
                discovered_at: new Date().toISOString(),
                fingerprint: `fp-${k}`,
            });
            writeFileSync(p, '{"layers":{"k":{"connection":{"driver":"ssh","tar'); // 截断 JSON（坏主档）
            const asideA = `${p}.111-222-rrrr.fx-old`;
            const asideB = `${p}.111-222-ssss.fx-old`;
            writeFileSync(asideA, JSON.stringify({ layers: { k: mk71("old"), retired: mk71("retired") }, _fx_rev: "9000000000000-1-a71" }));
            writeFileSync(asideB, JSON.stringify({ layers: { k: mk71("new") }, _fx_rev: "3000000000000-1-b71", _fx_seen: ["9000000000000-1-a71"] }));
            const old = new Date(Date.now() - 11 * 60_000); // 超过 10min——触发压实
            utimesSync(asideA, old, old);
            utimesSync(asideB, old, old);
            const cfg = await new LayerEnvStore(p).load(); // 单次 load（读+压实）
            expect(cfg.layers.k!.connection.target).toBe("new"); // 修前：old（坏主档作锚、墙钟序）
            expect(cfg.layers.retired).toBeUndefined(); // 修前：retired 复活
            // 压实落盘的是 B 的正果（主档可解析、旁路双双消费）
            expect(existsSync(asideA)).toBe(false);
            expect(existsSync(asideB)).toBe(false);
            const onDisk = JSON.parse(readFileSync(p, "utf-8")) as LayerEnvConfigFile;
            expect(onDisk.layers.k!.connection.target).toBe("new"); // 修前：错果（old+retired）写进主档
            expect(onDisk.layers.retired).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 15_000);
});
