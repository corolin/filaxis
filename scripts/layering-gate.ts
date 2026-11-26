/**
 * layering-gate.ts — 三层依赖方向断言（REQ-0004 §3.3、§7）
 *
 *     interface = cli | mcp        middle = daemon | sdk        core = non-daemon
 *
 *   R1  内核只依赖内核（与各层共用的日志器）
 *   R2  中层可依赖内核，不得依赖界面层
 *   R3  界面层只依赖中层与自身；从内核只能取类型（import type）
 *   R3b 界面层与中层不得经 SDK 总出口（src/index.ts）取符号——总出口再导出了整个内核
 *
 * 纯函数：输入「文件路径 → 源码」，输出违规清单。门禁脚本 check-boundaries.ts 用真文件
 * 调它；测试用合成的例子证明每一类违规都会被拦下、放行的方向不被误伤。
 */
export type Layer = "core" | "middle" | "interface" | "shared" | "barrel" | "other";

const INTERFACE_FILES = new Set([
    "src/agent-toolkit.ts",
    "src/mcp-server.ts",
    "src/mcp-proxy.ts",
    "src/daemon-server.ts",
    "src/daemon-client.ts",
    "src/daemon-files.ts",
]);

/** 各层共用的基础设施：不含任何一层的知识，谁都可以依赖 */
const SHARED_FILES = new Set(["src/logger.ts"]);

export function layerOf(file: string): Layer {
    const f = file.replace(/\\/g, "/");
    if (f === "src/index.ts") return "barrel";
    if (f.startsWith("src/operations/")) return "middle";
    if (INTERFACE_FILES.has(f) || f.startsWith("bin/")) return "interface";
    if (SHARED_FILES.has(f)) return "shared";
    if (f.startsWith("src/")) return "core";
    return "other";
}

export interface ImportEdge {
    /** import 语句里的说明符（相对路径原样；node 内置与包名不解析） */
    spec: string;
    /** 只取类型：import type / export type / 花括号里全是 type 说明符 / 类型位置的 import("x") */
    typeOnly: boolean;
    line: number;
}

/** 去掉行注释（引号内的 // 不算）；不处理模板字符串里的 //，那种行里不会出现 import 语句 */
function stripLineComment(line: string): string {
    let quote: string | undefined;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quote) {
            if (ch === "\\") i++;
            else if (ch === quote) quote = undefined;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
    }
    return line;
}

/** `import { type A, type B } from "x"` 这种混合写法里没有取任何值 */
function namedSpecifiersAreAllTypes(clause: string): boolean {
    const body = clause.replace(/^\s*(?:import|export)\s+/, "").replace(/\bfrom\s*["'][^"']+["']\s*;?\s*$/, "");
    if (/^\s*\*\s+as\b/.test(body)) return false; // 命名空间导入
    const brace = body.indexOf("{");
    if (brace < 0) return false; // 无花括号：缺省导入或副作用导入
    if (body.slice(0, brace).trim() !== "") return false; // 缺省导入
    const inner = body.slice(body.indexOf("{") + 1, body.lastIndexOf("}"));
    // 多行写法的尾部会切出空项，不算说明符
    const specifiers = inner.split(",").map((specifier) => specifier.trim()).filter((specifier) => specifier !== "");
    return specifiers.length > 0 && specifiers.every((specifier) => /^type\s/.test(specifier));
}

export function importsOf(text: string): ImportEdge[] {
    const out: ImportEdge[] = [];
    const lines = text.split(/\r?\n/);
    let inBlockComment = false;
    let pending: { clause: string; line: number; keyword: "import" | "export" } | undefined;

    const complete = (clause: string, keyword: "import" | "export"): boolean => {
        if (/\bfrom\s*["'][^"']+["']/.test(clause)) return true;
        return keyword === "import" && /^\s*["'][^"']+["']/.test(clause);
    };
    const finish = (clause: string, keyword: "import" | "export", line: number): void => {
        const typeOnly = /^\s*(?:import|export)\s+type\s/.test(clause);
        const from = /\bfrom\s*["']([^"']+)["']/.exec(clause);
        if (from) {
            out.push({ spec: from[1]!, typeOnly: typeOnly || namedSpecifiersAreAllTypes(clause), line });
            return;
        }
        const bare = /^\s*["']([^"']+)["']/.exec(clause.replace(/^\s*import\s+/, ""));
        if (bare) out.push({ spec: bare[1]!, typeOnly: false, line });
    };

    lines.forEach((raw, index) => {
        let line = raw;
        if (inBlockComment) {
            const end = line.indexOf("*/");
            if (end < 0) return;
            line = line.slice(end + 2);
            inBlockComment = false;
        }
        // 块注释开始符不在引号里
        {
            let quote: string | undefined;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i]!;
                if (quote) {
                    if (ch === "\\") i++;
                    else if (ch === quote) quote = undefined;
                    continue;
                }
                if (ch === '"' || ch === "'" || ch === "`") quote = ch;
                else if (ch === "/" && line[i + 1] === "*") {
                    const end = line.indexOf("*/", i + 2);
                    if (end < 0) {
                        inBlockComment = true;
                        line = line.slice(0, i);
                    } else {
                        line = line.slice(0, i) + " " + line.slice(end + 2);
                        i = end + 1;
                    }
                }
            }
        }
        line = stripLineComment(line);
        const trimmed = line.trim();
        if (pending) {
            pending.clause += "\n" + line;
            if (complete(pending.clause, pending.keyword)) {
                finish(pending.clause, pending.keyword, pending.line);
                pending = undefined;
            }
            return;
        }
        if (/^import\s/.test(trimmed)) {
            if (complete(trimmed, "import")) finish(trimmed, "import", index + 1);
            else pending = { clause: trimmed, line: index + 1, keyword: "import" };
            return;
        }
        if (/^export\s+(type\s+)?[{*]/.test(trimmed)) {
            if (complete(trimmed, "export")) finish(trimmed, "export", index + 1);
            else pending = { clause: trimmed, line: index + 1, keyword: "export" };
            return;
        }
        // 动态 import 与 require：类型位置的 import("x")（typeof import("x")、import("x").T）只取类型
        const dynamic = /\bimport\(\s*(["'])([^"']+)\1\s*\)/g;
        for (const m of trimmed.matchAll(dynamic)) {
            const after = trimmed.slice(m.index! + m[0].length);
            const before = trimmed.slice(0, m.index!);
            const typePosition = /^\s*\.\s*[A-Za-z_$]/.test(after) || /typeof\s*$/.test(before);
            out.push({ spec: m[2]!, typeOnly: typePosition, line: index + 1 });
        }
        for (const m of trimmed.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g)) {
            out.push({ spec: m[2]!, typeOnly: false, line: index + 1 });
        }
    });
    return out;
}

function resolveSpec(fromFile: string, spec: string): string | undefined {
    if (!spec.startsWith(".")) return undefined; // node 内置模块与第三方包不属于任何一层
    const dir = fromFile.split("/").slice(0, -1).join("/");
    const stack: string[] = [];
    for (const part of `${dir}/${spec.replace(/\.js$/, ".ts")}`.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") stack.pop();
        else stack.push(part);
    }
    return stack.join("/");
}

export function layeringViolations(entries: Array<{ file: string; text: string }>): string[] {
    const out: string[] = [];
    for (const { file, text } of entries) {
        const from = layerOf(file);
        if (from === "other") continue;
        for (const edge of importsOf(text)) {
            const target = resolveSpec(file, edge.spec);
            if (target === undefined) continue;
            const to = layerOf(target);
            const where = `${file}:${edge.line}`;
            if (to === "barrel" && (from === "interface" || from === "middle")) {
                out.push(`${where}: ${from} 层不得经 SDK 总出口（${edge.spec}）取符号——总出口再导出了整个内核；请从具体模块导入（REQ-0004 R3）`);
            } else if (from === "core" && (to === "middle" || to === "interface")) {
                // 连类型也不许：依赖方向不许倒过来（界面层取内核类型是 R3 明确放行的另一个方向）
                out.push(`${where}: 内核模块依赖了${to === "middle" ? "中层" : "界面层"} '${edge.spec}'${edge.typeOnly ? "（类型）" : ""}（REQ-0004 R1：内核只依赖内核，连类型也不取自别的层）`);
            } else if (from === "middle" && to === "interface") {
                out.push(`${where}: 中层模块依赖了界面层 '${edge.spec}'（REQ-0004 R2）`);
            } else if (from === "interface" && to === "core" && !edge.typeOnly) {
                out.push(`${where}: 界面层从内核导入值 '${edge.spec}'（REQ-0004 R3：只允许 import type；执行走中层操作）`);
            }
        }
    }
    return out;
}
