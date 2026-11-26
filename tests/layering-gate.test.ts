/**
 * layering-gate.test.ts — 三层依赖方向断言（REQ-0004 §7、AC-07）
 *
 * 门禁通过本身不说明它在干活：解析器若一个 import 都没识别出来也会通过。所以这里
 * 用合成的例子逐类证明会被拦下、放行的方向不被误伤，并对真实文件断言它确实识别出了导入。
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

describe("分层门禁（REQ-0004 §7）：层的归属", () => {
    test("operations/ 是中层；工具面 / MCP / Daemon / bin 是界面层；日志器各层共用；其余 src 是内核", () => {
        expect(layerOf("src/operations/middle.ts")).toBe("middle");
        expect(layerOf("src/operations/runtime-stack.ts")).toBe("middle");
        expect(layerOf("src\\operations\\protocol.ts")).toBe("middle");
        for (const f of ["src/agent-toolkit.ts", "src/mcp-server.ts", "src/mcp-proxy.ts", "src/daemon-server.ts", "src/daemon-client.ts", "src/daemon-files.ts", "bin/filaxis.ts", "bin/filaxis-mcp.ts"]) {
            expect(layerOf(f)).toBe("interface");
        }
        expect(layerOf("src/logger.ts")).toBe("shared");
        expect(layerOf("src/index.ts")).toBe("barrel");
        for (const f of ["src/ssh-helpers.ts", "src/batch.ts", "src/driver.ts", "src/terminal/session-registry.ts"]) {
            expect(layerOf(f)).toBe("core");
        }
        expect(layerOf("tests/batch.test.ts")).toBe("other"); // 测试与示例不在门禁范围内
    });
});

describe("分层门禁（REQ-0004 §7）：三类违规都会被拦下", () => {
    test("R1 内核依赖中层或界面层", () => {
        expect(one("src/foo.ts", 'import { createMiddle } from "./operations/middle.js";')).toHaveLength(1);
        expect(one("src/foo.ts", 'import { McpServer } from "./mcp-server.js";')).toHaveLength(1);
        expect(one("src/terminal/x.ts", 'import { loadLayerStore } from "../operations/layer-store.js";')).toHaveLength(1);
        expect(one("src/ssh-helpers.ts", 'const { DaemonClient } = await import("./daemon-client.js");')).toHaveLength(1);
        // 连类型也不许——依赖方向不许倒过来（界面层取内核类型是 R3 明确放行的另一个方向）
        expect(one("src/foo.ts", 'import type { Middle } from "./operations/types.js";')).toHaveLength(1);
        expect(one("src/foo.ts", 'import type { AgentToolkit } from "./agent-toolkit.js";')).toHaveLength(1);
        // 内核依赖共用日志器放行
        expect(one("src/foo.ts", 'import { noopLogger } from "./logger.js";')).toEqual([]);
    });

    test("R2 中层依赖界面层", () => {
        expect(one("src/operations/x.ts", 'import { DaemonClient } from "../daemon-client.js";')).toHaveLength(1);
        expect(one("src/operations/x.ts", 'export { McpServer } from "../mcp-server.js";')).toHaveLength(1);
        expect(one("src/operations/x.ts", 'import { createAgentToolkit } from "../agent-toolkit.js";')).toHaveLength(1);
        // 中层依赖内核、依赖中层放行
        expect(one("src/operations/x.ts", 'import { runBatch } from "../batch.js";')).toEqual([]);
        expect(one("src/operations/x.ts", 'import { createMiddle } from "./middle.js";')).toEqual([]);
    });

    test("R3 界面层从内核导入值", () => {
        expect(one("src/agent-toolkit.ts", 'import { editFile } from "./file-edit.js";')).toHaveLength(1);
        expect(one("src/mcp-server.ts", 'import SshPtyDriver from "./ssh-pty-driver.js";')).toHaveLength(1);
        expect(one("src/mcp-proxy.ts", 'import * as batch from "./batch.js";')).toHaveLength(1); // 命名空间导入也是取值
        expect(one("src/daemon-server.ts", 'import * as sshHelpers from "./ssh-helpers.js";')).toHaveLength(1);
        expect(one("bin/filaxis.ts", 'import { SshPtyDriver } from "../src/ssh-pty-driver.js";')).toHaveLength(1);
        expect(one("bin/filaxis.ts", 'const m = await import("../src/ssh-pty-driver.js");')).toHaveLength(1);
        expect(one("bin/filaxis.ts", 'const m = require("../src/ssh-pty-driver.js");')).toHaveLength(1);
        expect(one("src/agent-toolkit.ts", 'import { BATCH_STEP_KINDS } from "./batch.js";')).toHaveLength(1);
        // 混合写法里取了一个值也算
        expect(one("src/agent-toolkit.ts", 'import { BATCH_STEP_KINDS, type BatchPlan } from "./batch.js";')).toHaveLength(1);
    });

    test("R3 只取类型放行", () => {
        expect(one("src/agent-toolkit.ts", 'import type { RuntimeDriver } from "./driver.js";')).toEqual([]);
        expect(one("src/agent-toolkit.ts", 'import { type RuntimeDriver } from "./driver.js";')).toEqual([]);
        expect(one("src/agent-toolkit.ts", 'import type { BatchPlan, BatchReport } from "./batch.js";')).toEqual([]);
        expect(one("src/agent-toolkit.ts", 'type T = typeof import("./driver.js");')).toEqual([]);
        expect(one("src/agent-toolkit.ts", 'type D = import("./driver.js").RuntimeDriver;')).toEqual([]);
        expect(one("src/mcp-server.ts", 'export type { StreamResult } from "./operations/types.js";')).toEqual([]);
    });

    test("R3b 界面层与中层不得经 SDK 总出口取符号", () => {
        // 总出口再导出了整个内核——从它取符号等于绕过了 R3 的逐模块判断
        expect(one("bin/filaxis.ts", 'import { probeDaemon } from "../src/index.js";')).toHaveLength(1);
        expect(one("bin/filaxis.ts", 'import type { Middle } from "../src/index.js";')).toHaveLength(1);
        expect(one("src/operations/x.ts", 'import { something } from "../index.js";')).toHaveLength(1);
        // 测试与示例不在门禁范围内，仍可从总出口取
        expect(one("tests/x.test.ts", 'import { probeDaemon } from "../src/index.js";')).toEqual([]);
    });

    test("放行的方向：界面层依赖中层、依赖界面层、依赖共用日志器与 node 内置", () => {
        expect(one("src/agent-toolkit.ts", [
            'import { createMiddle } from "./operations/middle.js";',
            'import type { Middle } from "./operations/types.js";',
            'import { McpServer } from "./mcp-server.js";',
            'import { noopLogger, type FilaxisLogger } from "./logger.js";',
            'import * as http from "node:http";',
            'import { version } from "../package.json" with { type: "json" };',
        ].join("\n"))).toEqual([]);
        expect(one("bin/filaxis.ts", 'import { connectRemoteMiddle } from "../src/daemon-client.js";')).toEqual([]);
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
        const [v] = one("src/agent-toolkit.ts", 'import type { X } from "./operations/types.js";\nimport { editFile } from "./file-edit.js";');
        expect(v).toContain("src/agent-toolkit.ts:2");
        expect(v).toContain("REQ-0004 R3");
        const [core] = one("src/foo.ts", 'import { createMiddle } from "./operations/middle.js";');
        expect(core).toContain("REQ-0004 R1");
    });

    test("解析器在真实文件上确实识别出了导入关系（不是静默地一个都没匹配到）", () => {
        const toolkit = importsOf(src("src/agent-toolkit.ts"));
        expect(toolkit.some((e) => e.spec === "./operations/middle.js" && !e.typeOnly)).toBe(true);
        expect(toolkit.some((e) => e.spec === "./driver.js" && e.typeOnly)).toBe(true);
        const cli = importsOf(src("bin/filaxis.ts"));
        expect(cli.some((e) => e.spec === "../src/daemon-client.js")).toBe(true);
        // 界面层的每个文件都至少识别出一条导入
        for (const f of ["src/mcp-server.ts", "src/mcp-proxy.ts", "src/daemon-server.ts", "src/daemon-client.ts", "bin/filaxis-mcp.ts"]) {
            expect(importsOf(src(f)).length).toBeGreaterThan(0);
        }
    });
});

describe("分层门禁（REQ-0004 §7）：现有代码", () => {
    test("src/ 与 bin/ 全量扫描零违规", () => {
        const root = join(import.meta.dir, "..");
        const files = [...walk(join(root, "src")), ...walk(join(root, "bin"))];
        expect(files.length).toBeGreaterThan(50);
        const entries = files.map((file) => ({ file: file.slice(root.length + 1).replace(/\\/g, "/"), text: readFileSync(file, "utf-8") }));
        expect(layeringViolations(entries)).toEqual([]);
    });

    test("界面层没有任何一条从内核来的值导入（逐条列出以便审阅）", () => {
        const root = join(import.meta.dir, "..");
        const files = [...walk(join(root, "src")), ...walk(join(root, "bin"))]
            .map((file) => file.slice(root.length + 1).replace(/\\/g, "/"))
            .filter((file) => layerOf(file) === "interface");
        const valueImportsFromCore = files.flatMap((file) => importsOf(readFileSync(join(root, file), "utf-8"))
            .filter((e) => !e.typeOnly && /^(src\/)?[^/]*\.js$|^\.\.?\/.*\.js$/.test(e.spec))
            .map((e) => ({ file, spec: e.spec })))
            .filter(({ file, spec }) => {
                const target = spec.startsWith(".") ? join(file, "..", spec).replace(/\\/g, "/") : "";
                return layerOf(target.replace(/\.js$/, ".ts")) === "core";
            });
        expect(valueImportsFromCore).toEqual([]);
        // 共用日志器是界面层唯一的非界面、非中层值依赖
        const shared = files.flatMap((file) => importsOf(readFileSync(join(root, file), "utf-8"))
            .filter((e) => !e.typeOnly && e.spec.endsWith("/logger.js") || !e.typeOnly && e.spec === "./logger.js")
            .map((e) => `${file} -> ${e.spec}`));
        expect(shared.length).toBeGreaterThan(0);
    });
});
