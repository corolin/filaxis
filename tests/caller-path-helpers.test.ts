/**
 * caller-path-helpers.test.ts — 调用方给的路径只补前缀、不折叠（自挖第 1 轮）
 *
 * CLI 的 callerPath 确立的规则：`link/../x` 里的 `..` 留给内核按符号链接语义解析，和 shell 看到
 * 的一致。内核里还有两处用 path.join 拼调用方给的路径，会把 `..` 词法折叠掉：`~` 展开与 tmux
 * 窗格锁。这两处是纯函数，直接钉住。
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { expandHomePath } from "../src/core/ssh/ssh-helpers.js";
import { paneLockPath } from "../src/core/tmux/command-executer.js";

describe("调用方给的路径只补前缀、不折叠", () => {
    test("~ 展开：~ 之后原样保留", () => {
        expect(expandHomePath("~")).toBe(homedir());
        expect(expandHomePath("~/.ssh/id")).toBe(`${homedir()}/.ssh/id`);
        // shell 里 ~ 展开后交给内核解析：link 是符号链接时，.. 相对的是链接指向的位置
        expect(expandHomePath("~/link/../key")).toBe(`${homedir()}/link/../key`);
        expect(expandHomePath("~\\a\\..\\b")).toBe(`${homedir()}/a\\..\\b`);
        expect(expandHomePath("$HOME/.ssh/id")).toBe("$HOME/.ssh/id");
        expect(expandHomePath("")).toBe("");
    });

    test("tmux 窗格锁：锁文件与 socket 并排，socket 路径里的 link/.. 原样保留", () => {
        expect(paneLockPath("/tmp/tmux-1000/default", "abc")).toBe("/tmp/tmux-1000/.filaxis-pane-abc.lock");
        expect(paneLockPath("/tmp/link/../sock", "abc")).toBe("/tmp/link/../.filaxis-pane-abc.lock");
        expect(paneLockPath("/sock", "abc")).toBe("/.filaxis-pane-abc.lock");
    });
});
