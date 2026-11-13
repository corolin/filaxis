/**
 * 会话窗口基础件单测（净室平移件回归 + OSS 扩展 evictedCount）
 */
import { describe, expect, test } from "bun:test";
import { LineAssembler, OutputRingBuffer, WatchRegistry, sanitizeSessionName } from "../src/session-buffer.js";

describe("LineAssembler", () => {
    test("按 \\n 组行并剥 CRLF", () => {
        const a = new LineAssembler();
        expect(a.feed("a\r\nb\nc")).toEqual(["a", "b"]);
        expect(a.flush()).toEqual(["c"]);
    });

    test("partial 跨 chunk 暂存", () => {
        const a = new LineAssembler();
        expect(a.feed("hel")).toEqual([]);
        expect(a.feed("lo\nworld")).toEqual(["hello"]);
        expect(a.flush()).toEqual(["world"]);
    });

    test("flush 空暂存返回空数组", () => {
        const a = new LineAssembler();
        a.feed("x\n");
        expect(a.flush()).toEqual([]);
    });
});

describe("OutputRingBuffer", () => {
    test("tail(n) 最近 n 行", () => {
        const r = new OutputRingBuffer({ maxLines: 3 });
        for (const l of ["a", "b", "c", "d"]) r.push({ stream: "stdout", text: l });
        expect(r.tail(2)).toEqual(["c", "d"]);
        expect(r.tail(10)).toEqual(["b", "c", "d"]);
    });

    test("超长行截断含标记", () => {
        const r = new OutputRingBuffer({ maxLines: 5, maxLineBytes: 64 }); // > 后缀长度 29
        r.push({ stream: "stdout", text: "x".repeat(100) });
        const line = r.tail(1)[0]!;
        expect(line.length).toBe(64);
        expect(line.endsWith("[…truncated, see session log]")).toBe(true);
    });

    test("maxLineBytes 小于后缀长度时不再反转越界（源 bug 边界回归）", () => {
        const r = new OutputRingBuffer({ maxLines: 5, maxLineBytes: 10 }); // 10 < 29
        r.push({ stream: "stdout", text: "x".repeat(100) });
        const line = r.tail(1)[0]!;
        expect(line).toBe("[…truncated, see session log]"); // keep=0：仅后缀，恒定不长
        expect(line.length).toBeLessThan(30);
    });

    test("evictedCount：窗口未满为 0，滚出后累计（FEAT-11 有据滚出）", () => {
        const r = new OutputRingBuffer({ maxLines: 3 });
        expect(r.evictedCount).toBe(0);
        r.push({ stream: "stdout", text: "1" });
        r.push({ stream: "stdout", text: "2" });
        expect(r.evictedCount).toBe(0); // 未满：历史完整
        r.push({ stream: "stdout", text: "3" });
        r.push({ stream: "stdout", text: "4" });
        expect(r.evictedCount).toBe(1); // 「1」被挤出
        r.push({ stream: "stdout", text: "5" });
        expect(r.evictedCount).toBe(2);
        expect(r.tail(3)).toEqual(["3", "4", "5"]);
    });

    test("contextAround 越界收敛（行对象带 stream 标记）", () => {
        const r = new OutputRingBuffer();
        for (const l of ["a", "b", "c", "d", "e"]) r.push({ stream: "stdout", text: l });
        const texts = (i: number, n: number) => r.contextAround(i, n).map((l) => l.text);
        expect(texts(2, 1)).toEqual(["b", "c", "d"]);
        expect(texts(0, 2)).toEqual(["a", "b", "c"]);
        expect(texts(4, 2)).toEqual(["c", "d", "e"]);
        for (const l of r.contextAround(2, 1)) expect(l.stream).toBe("stdout");
    });

    test("indexOfLine 找不到回退末行", () => {
        const r = new OutputRingBuffer();
        r.push({ stream: "stdout", text: "a" });
        r.push({ stream: "stdout", text: "b" });
        expect(r.indexOfLine("a")).toBe(0);
        expect(r.indexOfLine("zzz")).toBe(1);
    });
});

describe("WatchRegistry", () => {
    test("子串语义命中（元字符转义）", () => {
        const w = new WatchRegistry();
        w.add({ id: "w1", pattern: "a.b" });
        expect(w.match("xa.bx")).toEqual(["w1"]); // 字面 a.b
        expect(w.match("axb")).toEqual([]); // 不当正则
    });

    test("RegExp 模式命中", () => {
        const w = new WatchRegistry();
        w.add({ id: "w1", pattern: /ERR\d+/ });
        expect(w.match("line ERR42 here")).toEqual(["w1"]);
    });

    test("once 默认命中即摘除；once:false 常驻", () => {
        const w = new WatchRegistry();
        w.add({ id: "once", pattern: "hit" });
        w.add({ id: "stay", pattern: "hit", once: false });
        expect(w.match("hit")).toEqual(["once", "stay"]);
        expect(w.match("hit")).toEqual(["stay"]);
    });

    test("cancel 摘除", () => {
        const w = new WatchRegistry();
        w.add({ id: "w1", pattern: "x" });
        expect(w.cancel("w1")).toBe(true);
        expect(w.cancel("w1")).toBe(false);
        expect(w.match("x")).toEqual([]);
    });

    test("每会话上限 8", () => {
        const w = new WatchRegistry();
        for (let i = 0; i < 8; i++) w.add({ id: `w${i}`, pattern: `p${i}` });
        expect(() => w.add({ id: "w9", pattern: "p9" })).toThrow(/上限/);
    });
});

// 四十期 #1 收敛为机制：会话名白名单规范化——四后端共享单一来源（tmux 曾原文
// 拼接被命令注入，真 Bash 复现文件创建）。字符集 [a-zA-Z0-9_-] 内零 shell 元字符。
describe("sanitizeSessionName（四十期机制收敛）", () => {
    test("注入载荷矩阵全灭：命令替换/引号/分号/空格/路径穿越全归一为 -", () => {
        expect(sanitizeSessionName("probe$(touch x)")).not.toMatch(/[\$$;\/\s&|<>`"]/);
        expect(sanitizeSessionName("a;b|c&d")).toBe("a-b-c-d");
        expect(sanitizeSessionName("../../etc")).toBe("------etc"); // . 与 / 每字符各归一（白名单不含 .）
        expect(sanitizeSessionName("ok_Name-1")).toBe("ok_Name-1"); // 白名单原样保真
    });
});
