/**
 * check-boundaries.ts — 内核边界 CI 门禁（AC-01 / AC-03）
 *
 * 三道断言（任何一道失败退出码 1，阻断提交/发布）：
 *   1. 零上游业务概念（REQ-0001 §4.2 红线）：内核源码不得出现上游业务
 *      标识（CoreLite/PolicyEngine/SessionNotifier/SubstrateSecurity/NeuralImpulse…）
 *   2. 零 runtime 专有 API（AC-03）：禁止裸调 Bun.* ——统一 node: 标准库，
 *      Bun 与 Node LTS 双运行时是验收矩阵
 *   3. 零第三方运行时依赖（AC-01）：package.json dependencies 必须为空
 *      （devDependencies 允许——ts/bun-types 是开发面）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
/** 代码级上游业务标识（注释中的溯源说明合法——只查剥注释后的代码） */
const FORBIDDEN_IDENTIFIERS = [
    "CoreLite", "PolicyEngine", "SessionNotifier", "SubstrateSecurity",
    "NeuralImpulse", "getProjectRoot",
];
const FORBIDDEN_PATTERN = /Bun\.\w/;

/** 剥注释（行注释/块注释粗粒度）——溯源注释合法，红线管代码依赖 */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
}

function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* walk(p);
        else if (p.endsWith(".ts")) yield p;
    }
}

let failures = 0;
for (const file of walk(SRC)) {
    const raw = readFileSync(file, "utf-8");
    // import/require 路径含个人Agent项目原名——真依赖（无论注释与否）
    if (/from\s+["'][^"']*aethelum/i.test(raw) || /require\(["'][^"']*aethelum/i.test(raw)) {
        console.error(`[边界违规] ${file}: import 个人Agent项目模块（REQ-0001 §4.2 红线）`);
        failures++;
    }
    const code = stripComments(raw);
    for (const ident of FORBIDDEN_IDENTIFIERS) {
        if (code.includes(ident)) {
            console.error(`[边界违规] ${file}: 代码引用个人Agent项目概念 '${ident}'（REQ-0001 §4.2 红线）`);
            failures++;
        }
    }
    const m = code.match(FORBIDDEN_PATTERN);
    if (m) {
        console.error(`[边界违规] ${file}: 裸调 runtime 专有 API '${m[0]}'（AC-03——统一 node: 标准库）`);
        failures++;
    }
}

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const deps = Object.keys(pkg.dependencies ?? {});
if (deps.length > 0) {
    console.error(`[边界违规] package.json 含第三方运行时依赖: ${deps.join(", ")}（AC-01——内核零 npm 依赖）`);
    failures++;
}

if (failures > 0) {
    console.error(`\n边界门禁失败：${failures} 处违规`);
    process.exit(1);
}
console.log(`边界门禁通过：${SRC}/ 零个人Agent项目概念、零 Bun.* 裸用、零第三方运行时依赖`);
