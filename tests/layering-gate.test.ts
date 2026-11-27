/**
 * layering-gate.test.ts — 三层依赖方向断言（REQ-0004 §7、AC-07）
 *
 * 门禁通过本身不说明它在干活：解析器若一个 import 都没识别出来也会通过。所以这里
 * 用合成的例子逐类证明会被拦下、放行的方向不被误伤，并对真实文件断言它确实识别出了导入。
 *
 * 合成例子里「导入方」用的是各层目录下的虚构文件名（src/core/base/zz.ts 这种）：层按目录判，
 * 目录对了层就对了；被导入的路径写成从该文件出发的真实相对路径。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { importsOf, layerOf, layeringViolations } from "../scripts/layering-gate.js";

const one = (file: string, text: string) => layeringViolations([{ file, text }]);
const src = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf-8");

function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (p.endsWith(".ts")) yield p;
    }
}

describe("分层门禁（REQ-0004 §7）：层的归属按目录判", () => {
    test("core/ 是内核；middle/ 是中层；interface/ 与 bin/ 是界面层；shared/ 各层共用；index.ts 是总出口", () => {
        for (const f of [
            "src/core/base/driver.ts", "src/core/ssh/ssh-helpers.ts", "src/core/tmux/terminal/session-registry.ts",
            "src/core/file/batch.ts", "src/core/probe/layer-discovery.ts",
        ]) {
            expect(layerOf(f), f).toBe("core");
        }
        for (const f of ["src/middle/middle.ts", "src/middle/runtime-stack.ts", "src/middle/protocol.ts"]) {
            expect(layerOf(f), f).toBe("middle");
        }
        expect(layerOf("src\\middle\\protocol.ts")).toBe("middle"); // Windows 分隔符
        for (const f of [
            "src/interface/mcp/agent-toolkit.ts", "src/interface/mcp/mcp-server.ts", "src/interface/mcp/mcp-proxy.ts",
            "src/interface/daemon/daemon-server.ts", "src/interface/daemon/daemon-client.ts", "src/interface/daemon/daemon-files.ts",
            "bin/filaxis.ts", "bin/filaxis-mcp.ts",
        ]) {
            expect(layerOf(f), f).toBe("interface");
        }
        for (const f of ["src/shared/logger.ts", "src/shared/async-guard.ts"]) expect(layerOf(f), f).toBe("shared");
        expect(layerOf("src/index.ts")).toBe("barrel");
        // 堆在 src/ 根下、没归进任何一层目录的：不算内核，单独一类（见 R0）
        for (const f of ["src/foo.ts", "src/legacy/whatever.ts", "src/core.ts", "src/middle.ts"]) {
            expect(layerOf(f), f).toBe("unclassified");
        }
        expect(layerOf("tests/batch.test.ts")).toBe("other"); // 测试与示例不在门禁范围内
        expect(layerOf("scripts/check-boundaries.ts")).toBe("other");
    });
});

describe("分层门禁（REQ-0004 §7）：每一类违规都会被拦下", () => {
    test("R0 源文件必须归到某一层的目录里", () => {
        expect(one("src/foo.ts", 'import { noopLogger } from "./shared/logger.js";')).toHaveLength(1);
        expect(one("src/foo.ts", "")).toHaveLength(1); // 空文件堆在根下也不行
        expect(one("src/legacy/whatever.ts", "")).toHaveLength(1);
        const [v] = one("src/foo.ts", "");
        expect(v).toContain("src/foo.ts");
        expect(v).toContain("没有归到任何一层的目录");
        // 归了位就不报（哪怕什么都不导入）
        expect(one("src/core/base/zz.ts", "")).toEqual([]);
        expect(one("src/middle/zz.ts", "")).toEqual([]);
        expect(one("src/shared/zz.ts", "")).toEqual([]);
        expect(one("src/interface/mcp/zz.ts", "")).toEqual([]);
        expect(one("src/index.ts", "")).toEqual([]);
    });

    test("R1 内核依赖中层或界面层", () => {
        const core = "src/core/base/zz.ts";
        expect(one(core, 'import { createMiddle } from "../../middle/middle.js";')).toHaveLength(1);
        expect(one(core, 'import { McpServer } from "../../interface/mcp/mcp-server.js";')).toHaveLength(1);
        expect(one("src/core/tmux/terminal/zz.ts", 'import { loadLayerStore } from "../../../middle/layer-store.js";')).toHaveLength(1);
        expect(one(core, 'const { DaemonClient } = await import("../../interface/daemon/daemon-client.js");')).toHaveLength(1);
        // 连类型也不许——依赖方向不许倒过来（界面层取内核类型是 R3 明确放行的另一个方向）
        expect(one(core, 'import type { Middle } from "../../middle/types.js";')).toHaveLength(1);
        expect(one(core, 'import type { AgentToolkit } from "../../interface/mcp/agent-toolkit.js";')).toHaveLength(1);
        // 内核依赖内核、依赖共用件放行
        expect(one(core, 'import { noopLogger } from "../../shared/logger.js";')).toEqual([]);
        expect(one(core, 'import { SshPtyDriver } from "../ssh/ssh-pty-driver.js";')).toEqual([]);
        expect(one(core, 'import { LocalRuntimeDriver } from "../local/local-driver.js";')).toEqual([]);
    });

    test("R2 中层依赖界面层", () => {
        const mid = "src/middle/zz.ts";
        expect(one(mid, 'import { DaemonClient } from "../interface/daemon/daemon-client.js";')).toHaveLength(1);
        expect(one(mid, 'export { McpServer } from "../interface/mcp/mcp-server.js";')).toHaveLength(1);
        expect(one(mid, 'import { createAgentToolkit } from "../interface/mcp/agent-toolkit.js";')).toHaveLength(1);
        // 中层依赖内核、依赖中层、依赖共用件放行
        expect(one(mid, 'import { runBatch } from "../core/file/batch.js";')).toEqual([]);
        expect(one(mid, 'import { createMiddle } from "./middle.js";')).toEqual([]);
        expect(one(mid, 'import { settleRejection } from "../shared/async-guard.js";')).toEqual([]);
    });

    test("R3 界面层从内核导入值", () => {
        const toolFace = "src/interface/mcp/agent-toolkit.ts";
        expect(one(toolFace, 'import { editFile } from "../../core/file/file-edit.js";')).toHaveLength(1);
        expect(one("src/interface/mcp/mcp-server.ts", 'import SshPtyDriver from "../../core/ssh/ssh-pty-driver.js";')).toHaveLength(1);
        expect(one("src/interface/mcp/mcp-proxy.ts", 'import * as batch from "../../core/file/batch.js";')).toHaveLength(1); // 命名空间导入也是取值
        expect(one("src/interface/daemon/daemon-server.ts", 'import * as sshHelpers from "../../core/ssh/ssh-helpers.js";')).toHaveLength(1);
        expect(one("bin/filaxis.ts", 'import { SshPtyDriver } from "../src/core/ssh/ssh-pty-driver.js";')).toHaveLength(1);
        expect(one("bin/filaxis.ts", 'const m = await import("../src/core/ssh/ssh-pty-driver.js");')).toHaveLength(1);
        expect(one("bin/filaxis.ts", 'const m = require("../src/core/ssh/ssh-pty-driver.js");')).toHaveLength(1);
        // 动态导入取值的几种写法：点号后面是方法调用、default，或什么都没有
        expect(one(toolFace, 'import("../../core/file/batch.js").then((m) => m.runBatch);')).toHaveLength(1);
        expect(one(toolFace, 'import("../../core/file/batch.js").catch((e) => console.error(e));')).toHaveLength(1);
        expect(one(toolFace, 'const x = import("../../core/file/batch.js").default;')).toHaveLength(1);
        expect(one(toolFace, 'void import("../../core/file/batch.js");')).toHaveLength(1);
        // 成员被取出来稍后再调用、typeof 出现在值的位置、当实参传入——运行时都会加载模块
        expect(one(toolFace, 'const then = import("../../core/file/batch.js").then;')).toHaveLength(1);
        expect(one(toolFace, 'const kind = typeof import("../../core/file/batch.js");')).toHaveLength(1);
        expect(one(toolFace, 'load(import("../../core/file/batch.js").runBatch);')).toHaveLength(1);
        expect(one(toolFace, 'import { BATCH_STEP_KINDS } from "../../core/file/batch.js";')).toHaveLength(1);
        // 混合写法里取了一个值也算
        expect(one(toolFace, 'import { BATCH_STEP_KINDS, type BatchPlan } from "../../core/file/batch.js";')).toHaveLength(1);
        // 界面层取共用件的值放行（日志器不属于任何一层）
        expect(one(toolFace, 'import { noopLogger } from "../../shared/logger.js";')).toEqual([]);
    });

    test("R3 只取类型放行", () => {
        const toolFace = "src/interface/mcp/agent-toolkit.ts";
        expect(one(toolFace, 'import type { RuntimeDriver } from "../../core/base/driver.js";')).toEqual([]);
        expect(one(toolFace, 'import { type RuntimeDriver } from "../../core/base/driver.js";')).toEqual([]);
        expect(one(toolFace, 'import type { BatchPlan, BatchReport } from "../../core/file/batch.js";')).toEqual([]);
        expect(one(toolFace, 'type T = typeof import("../../core/base/driver.js");')).toEqual([]);
        expect(one(toolFace, 'type D = import("../../core/base/driver.js").RuntimeDriver;')).toEqual([]);
        expect(one(toolFace, 'let d: import("../../core/base/driver.js").RuntimeDriver;')).toEqual([]);
        expect(one(toolFace, 'type D = typeof import("../../core/base/driver.js").RuntimeDriver;')).toEqual([]);
        expect(one(toolFace, 'let t: typeof import("../../core/base/driver.js");')).toEqual([]);
        expect(one(toolFace, 'export type Loader = typeof import("../../core/base/driver.js");')).toEqual([]);
        expect(one(toolFace, 'type Registry = Record<string, typeof import("../../core/base/driver.js")>;')).toEqual([]);
        expect(one(toolFace, 'function f(p: typeof import("../../core/base/driver.js")) {}')).toEqual([]);
        expect(one("src/interface/mcp/mcp-server.ts", 'export type { StreamResult } from "../../middle/types.js";')).toEqual([]);
    });

    test("R3b 界面层与中层不得经 SDK 总出口取符号", () => {
        // 总出口再导出了整个内核——从它取符号等于绕过了 R3 的逐模块判断
        expect(one("bin/filaxis.ts", 'import { probeDaemon } from "../src/index.js";')).toHaveLength(1);
        expect(one("bin/filaxis.ts", 'import type { Middle } from "../src/index.js";')).toHaveLength(1);
        expect(one("src/interface/mcp/zz.ts", 'import { something } from "../../index.js";')).toHaveLength(1);
        expect(one("src/middle/zz.ts", 'import { something } from "../index.js";')).toHaveLength(1);
        // 内核经总出口取别的内核模块同样拦下（哪怕只是绕路）——R3b 管的是「经总出口取符号」这个动作本身
        expect(one("src/core/base/zz.ts", 'import { x } from "../../index.js";')).toHaveLength(1);
        // 测试与示例不在门禁范围内，仍可从总出口取
        expect(one("tests/x.test.ts", 'import { probeDaemon } from "../src/index.js";')).toEqual([]);
    });

    test("放行的方向：界面层依赖中层、依赖界面层、依赖共用件与 node 内置", () => {
        expect(one("src/interface/mcp/agent-toolkit.ts", [
            'import { createMiddle } from "../../middle/middle.js";',
            'import type { Middle } from "../../middle/types.js";',
            'import { McpServer } from "./mcp-server.js";',
            'import { noopLogger, type FilaxisLogger } from "../../shared/logger.js";',
            'import * as http from "node:http";',
            'import { version } from "../../../package.json" with { type: "json" };',
        ].join("\n"))).toEqual([]);
        expect(one("bin/filaxis.ts", 'import { connectRemoteMiddle } from "../src/interface/daemon/daemon-client.js";')).toEqual([]);
        expect(one("src/interface/daemon/daemon-server.ts", 'import { McpProtocolHandler } from "../mcp/mcp-server.js";')).toEqual([]);
    });
});

describe("分层门禁（REQ-0004 §7）：导入语句的识别", () => {
    test("多行 import 按一条计；行注释与块注释里的 import 不算", () => {
        expect(importsOf('import {\n    a,\n    type B,\n} from "./batch.js";')).toEqual([
            { spec: "./batch.js", typeOnly: false, line: 1 },
        ]);
        expect(importsOf('import {\n    type A,\n    type B,\n} from "./batch.js";')[0]?.typeOnly).toBe(true);
        expect(importsOf([
            '// import { a } from "./batch.js";',
            '/* import { b } from "./batch.js"; */',
            '/**',
            ' * import { c } from "./batch.js";',
            ' */',
            'const url = "http://127.0.0.1"; // import { d } from "./batch.js";',
            'import { real } from "./logger.js";',
        ].join("\n"))).toEqual([{ spec: "./logger.js", typeOnly: false, line: 7 }]);
    });

    test("违规清单点名文件、行号与所依据的规则", () => {
        const toolFace = "src/interface/mcp/agent-toolkit.ts";
        const [v] = one(toolFace, 'import type { X } from "../../middle/types.js";\nimport { editFile } from "../../core/file/file-edit.js";');
        expect(v).toContain("src/interface/mcp/agent-toolkit.ts:2");
        expect(v).toContain("REQ-0004 R3");
        const [core] = one("src/core/base/zz.ts", 'import { createMiddle } from "../../middle/middle.js";');
        expect(core).toContain("src/core/base/zz.ts:1");
        expect(core).toContain("REQ-0004 R1");
    });

    test("解析器在真实文件上确实识别出了导入关系（不是静默地一个都没匹配到）", () => {
        const toolkit = importsOf(src("src/interface/mcp/agent-toolkit.ts"));
        expect(toolkit.some((e) => e.spec === "../../middle/middle.js" && !e.typeOnly)).toBe(true);
        expect(toolkit.some((e) => e.spec === "../../core/base/driver.js" && e.typeOnly)).toBe(true);
        const cli = importsOf(src("bin/filaxis.ts"));
        expect(cli.some((e) => e.spec === "../src/interface/daemon/daemon-client.js")).toBe(true);
        // 界面层的每个文件都至少识别出一条导入
        for (const f of [
            "src/interface/mcp/mcp-server.ts", "src/interface/mcp/mcp-proxy.ts", "src/interface/daemon/daemon-server.ts",
            "src/interface/daemon/daemon-client.ts", "bin/filaxis-mcp.ts",
        ]) {
            expect(importsOf(src(f)).length, f).toBeGreaterThan(0);
        }
    });
});

describe("分层门禁（REQ-0004 §7）：现有代码", () => {
    const root = join(import.meta.dir, "..");
    const listFiles = (): string[] =>
        [...walk(join(root, "src")), ...walk(join(root, "bin"))].map((file) => file.slice(root.length + 1).replace(/\\/g, "/"));

    test("src/ 与 bin/ 全量扫描零违规", () => {
        const files = listFiles();
        expect(files.length).toBeGreaterThan(50);
        expect(layeringViolations(files.map((file) => ({ file, text: readFileSync(join(root, file), "utf-8") })))).toEqual([]);
    });

    test("目录就是分层：src/ 根下只有总出口和四个层目录", () => {
        const topLevel = new Set(readdirSync(join(root, "src")));
        expect([...topLevel].sort()).toEqual(["core", "index.ts", "interface", "middle", "shared"]);
        // 每个层目录下都有东西，内核按关注点分了子目录
        expect(readdirSync(join(root, "src/core")).sort()).toEqual(["base", "file", "local", "probe", "ssh", "stream", "tmux"]);
        expect(readdirSync(join(root, "src/interface")).sort()).toEqual(["daemon", "mcp"]);
    });

    test("界面层没有任何一条从内核来的值导入（逐条列出以便审阅）", () => {
        const files = listFiles().filter((file) => layerOf(file) === "interface");
        expect(files.length).toBeGreaterThanOrEqual(9);
        const valueImportsFromCore = files.flatMap((file) => importsOf(readFileSync(join(root, file), "utf-8"))
            .filter((e) => !e.typeOnly && /^\.\.?\/.*\.js$/.test(e.spec))
            .map((e) => ({ file, spec: e.spec }))
            .filter(({ file, spec }) => layerOf(join(file, "..", spec).replace(/\\/g, "/").replace(/\.js$/, ".ts")) === "core"));
        expect(valueImportsFromCore).toEqual([]);
        // 共用件是界面层唯一的非界面、非中层值依赖
        const shared = files.flatMap((file) => importsOf(readFileSync(join(root, file), "utf-8"))
            .filter((e) => !e.typeOnly && /^(.*\/)?logger\.js$/.test(e.spec))
            .map((e) => `${file} -> ${e.spec}`));
        expect(shared.length).toBeGreaterThan(0);
    });
});
