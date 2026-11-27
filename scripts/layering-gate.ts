/**
 * layering-gate.ts — 三层依赖方向断言（REQ-0004 §3.3、§7）
 *
 *     interface = cli | mcp        middle = daemon | sdk        core = non-daemon
 *
 * 层按目录判（不是按文件名清单）：
 *     src/core/**        内核
 *     src/middle/**      中层
 *     src/interface/**   界面层（bin/ 下的入口脚本也是）
 *     src/shared/**      各层共用：不含任何一层的知识
 *     src/index.ts       SDK 总出口
 *
 *   R0  src/ 下的源文件必须归到某一层的目录里——直接堆在 src/ 根下的不算
 *   R1  内核只依赖内核（与各层共用件）
 *   R2  中层可依赖内核，不得依赖界面层
 *   R3  界面层只依赖中层与自身；从内核只能取类型（import type）
 *   R3b 任何一层都不得经 SDK 总出口（src/index.ts）取符号——总出口再导出了整个内核
 *
 * 纯函数：输入「文件路径 → 源码」，输出违规清单。门禁脚本 check-boundaries.ts 用真文件
 * 调它；测试用合成的例子证明每一类违规都会被拦下、放行的方向不被误伤。
 */
export type Layer = "core" | "middle" | "interface" | "shared" | "barrel" | "unclassified" | "other";

const LAYER_DIRS: Array<[string, Layer]> = [
    ["src/core/", "core"],
    ["src/middle/", "middle"],
    ["src/interface/", "interface"],
    ["src/shared/", "shared"],
];

export function layerOf(file: string): Layer {
    const f = file.replace(/\\/g, "/");
    if (f === "src/index.ts") return "barrel";
    for (const [dir, layer] of LAYER_DIRS) if (f.startsWith(dir)) return layer;
    if (f.startsWith("bin/")) return "interface";
    if (f.startsWith("src/")) return "unclassified"; // 堆在 src/ 根下，没归进任何一层
    return "other"; // 测试、示例、脚本：不在门禁范围内
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

/**
 * `import("x")` 之前是否处在类型位置。按行判断，看它所在的这一句（从上一个 `;` 或 `}` 起）：
 *   - 类型别名 / 接口 / 枚举声明的内部；
 *   - 变量声明的类型标注之后、且还没到初始化表达式（`let x: … = …` 的 `=` 之后是值）；
 *   - 函数的参数表（还没到函数体）、箭头函数尚未闭合的参数表里已标注的参数；
 *   - `as` / `satisfies` 之后；类型实参、联合、交叉（同一句已处于上面的类型上下文）。
 * 表达式里的冒号不算类型标注：对象字面量的属性（`{ kind: … }`）、三元表达式的分支、case 标签。
 * 其余一律算值位置（存疑宁可误报——多行书写的接口成员看不出外层声明，也会被当成值）。
 */
function inTypePosition(before: string): boolean {
    // `typeof import("x")` 的位置由 typeof 之前的上下文决定
    const b = before.replace(/\s+$/, "").replace(/typeof$/, "").replace(/\s+$/, "");
    if (/\bas$/.test(b) || /\bsatisfies$/.test(b)) return true;
    if (/^\s*(?:export\s+)?type\s+[\w$]+\s*(?:<[^<>()]*>)?\s*=\s*$/.test(b)) return true;
    // 值得细看的结尾：标注冒号、类型实参/联合/交叉，或箭头（回调类型的返回类型；箭头函数体里的那种由参数表扫描判为值）
    if (!/:$/.test(b) && !/[<,|&]$/.test(b) && !/=>$/.test(b)) return false;
    // 这一句：从 statementStart 找到的边界之后起
    const s = b.slice(statementStart(b)).trimStart();
    if (/^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:type|interface|enum)\b/.test(s)) return true;
    const decl = /^(?:(?:export|declare)\s+)?(?:let|const|var)\s+[\w$]+\s*:/.exec(s);
    if (decl) return !s.slice(decl[0].length).includes("=");
    // 函数声明 / 箭头函数：看它的参数表
    const sig = /^(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[\w$]*\s*\(|(?:(?:const|let|var)\s+[\w$]+\s*=\s*)?(?:async\s+)?\()/.exec(s);
    return sig !== null && paramListIsTypePosition(s.slice(sig[0].length - 1));
}

/**
 * 这一句的起点。只认顶层（圆/方/花括号深度为 0）的 `;`、`}`，以及不属于类型上下文的 `{`
 * （对象字面量、代码块）。类型上下文里的花括号不切断语句：标注冒号之后的对象类型字面量、
 * type / interface 头之后的花括号、以及嵌在括号里的任何花括号（回调类型
 * `(e: { kind: number }) => …`）——否则 `function f(cb:` 这段头会被回调类型自己的 `}` 切掉。
 */
function statementStart(b: string): number {
    let depth = 0;
    let start = 0;
    const typeBrace: boolean[] = [];
    for (let i = 0; i < b.length; i++) {
        const c = b[i]!;
        if ("([{".includes(c)) {
            if (c === "{" && depth === 0) {
                const head = b.slice(0, i);
                const inType = /:\s*$/.test(head) || /(?:^|[;}\s])(?:type|interface)\s+[\w$]+\s*(?:<[^<>]*>)?\s*(?:=\s*)?$/.test(head);
                typeBrace.push(inType);
                if (!inType) start = i + 1;
            }
            depth++;
        } else if (")]}".includes(c)) {
            depth--;
            if (c === "}" && depth === 0) {
                if (typeBrace.pop() !== true) start = i + 1;
            }
        } else if (c === ";" && depth === 0) start = i + 1;
    }
    return start;
}

/**
 * 参数表（从它的左括号起、到 import 之前）是否处在类型位置：最后一个「标注冒号」之后，且它后面
 * 没有顶层的初始化（`=`）。标注冒号 = 段首是一个裸参数名（可带修饰符、`...`、`?`）、紧跟其后
 * 的冒号；参数默认值里的冒号（三元分支）前面是表达式，不算。嵌套在圆括号/花括号/方括号/
 * 尖括号里的内容不在顶层：回调类型 `(e: X) => typeof import(…)` 整体处在标注之后，是类型。
 * 参数表闭合之后只有返回类型标注（恰好一个冒号）才算类型，其余是函数体。
 */
function paramListIsTypePosition(list: string): boolean {
    let depth = 0;
    let lastColon = -1;
    let initAfter = false;
    let segStart = 1;
    let closeIndex = -1;
    for (let i = 0; i < list.length; i++) {
        const c = list[i]!;
        const next = list[i + 1];
        const prev = list[i - 1];
        if ("([{<".includes(c)) depth++;
        else if (")]}>".includes(c)) {
            if (c === ">" && prev === "=") continue; // 箭头 `=>` 的 > 不是闭合的尖括号
            depth--;
            if (depth === 0) closeIndex = i;
        } else if (depth === 1) {
            if (c === ",") segStart = i + 1;
            else if (c === "=" && next !== "=" && next !== ">" && prev !== "!" && prev !== "<" && prev !== ">" && prev !== "=") {
                if (lastColon >= 0) initAfter = true;
            } else if (c === ":" && next !== ":" && prev !== ":") {
                const segment = list.slice(segStart, i).trim();
                // `(?:\.{3})?`：可选的三个点。写成 `\.{3}?` 是「恰好三个点、惰性」，普通的参数名反而配不上
                if (/^(?:(?:readonly|public|private|protected|override)\s+)?(?:\.{3})?[\w$]+\??$/.test(segment)) lastColon = i;
            }
        }
    }
    if (closeIndex >= 0 && list.slice(closeIndex + 1).trim() !== ":") return false;
    if (closeIndex >= 0) return true; // 返回类型标注
    return lastColon >= 0 && !initAfter;
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
        // 动态 import 与 require：类型位置的 import("x")（typeof import("x")、import("x").T）只取类型。
        // `typeof import("x")` 与 `import("x").T` 出现在值的位置同样是加载模块——只有确实处在类型
        // 位置才算只取类型，其余一律按取值算（存疑时宁可误报）
        const dynamic = /\bimport\(\s*(["'])([^"']+)\1\s*\)/g;
        for (const m of trimmed.matchAll(dynamic)) {
            const after = trimmed.slice(m.index! + m[0].length);
            const before = trimmed.slice(0, m.index!);
            const member = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(after);
            const valueMember = member !== null
                && (member[1] === "default" || /^\s*(?:<[^<>()]*>)?\s*\(/.test(after.slice(member[0].length)));
            const typeQuery = member !== null || /typeof\s*$/.test(before);
            const typePosition = !valueMember && typeQuery && inTypePosition(before);
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
        if (from === "unclassified") {
            // R0：归位先于一切——堆在 src/ 根下的文件既看不出属于哪层，依赖方向的断言也无从谈起
            out.push(`${file}: 源文件没有归到任何一层的目录里（src/core、src/middle、src/interface、src/shared；总出口 src/index.ts 除外）——REQ-0004 §4`);
            continue;
        }
        for (const edge of importsOf(text)) {
            const target = resolveSpec(file, edge.spec);
            if (target === undefined) continue;
            const to = layerOf(target);
            const where = `${file}:${edge.line}`;
            if (to === "barrel" && from !== "barrel") {
                // 总出口再导出了整个内核，而且它自己依赖各层：谁都不得反过来经它取符号——
                // 界面层与中层由此绕过逐模块判断，内核与共用件则和总出口成环
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
