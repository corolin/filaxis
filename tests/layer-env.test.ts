/**
 * 层环境规格单测（AC-17：解析纯函数/身份键/漂移/匹配/持久化）
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
