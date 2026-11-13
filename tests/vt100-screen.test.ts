/** VT100 虚拟屏测试：watch/htop 形态增量重演回放 */
import { describe, expect, test } from "bun:test";
import { Vt100Screen } from "../src/vt100-screen.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { StreamSessionManager, type SpawnImpl } from "../src/stream-session-manager.js";

describe("Vt100Screen（状态机）", () => {
    test("普通写入 + LF/CR + SGR 忽略", () => {
        const s = new Vt100Screen({ rows: 3, cols: 10 });
        s.feed("abc\x1b[31mRED\x1b[0m\r\ndef");
        expect(s.snapshot()).toBe("abcRED\ndef\n"); // SGR 不进屏；\r 归零 \n 换行（尾空行保留）
    });

    test("CUP 定位改写（watch 形态首屏 + 增量改写）", () => {
        const s = new Vt100Screen({ rows: 4, cols: 20 });
        // 首屏：全画（模拟 watch 首屏）
        s.feed("TIME 48C\r\nGPU OK");
        expect(s.snapshot()).toContain("48C");
        // 增量包 1：光标定位到 48C 的 '8'（1-based 第 7 列）改成 9
        s.feed("\x1b[1;7H9");
        expect(s.snapshot()).toContain("49C");
        // 增量包 2：改回 8
        s.feed("\x1b[1;7H8");
        expect(s.snapshot()).toContain("48C");
        expect(s.frames).toBe(3);
    });

    test("ED/EL 清屏清行 + BS/TAB", () => {
        const s = new Vt100Screen({ rows: 3, cols: 10 });
        s.feed("AAAA\r\nBBBB\r\nCCCC");
        s.feed("\x1b[2;1H\x1b[K"); // 行 2 清行
        expect(s.snapshot()).toBe("AAAA\n\nCCCC");
        s.feed("\x1b[2J"); // 全清
        expect(s.snapshot().trim()).toBe("");
        s.feed("X\bY"); // BS 回退覆写（2J 前光标在 row1 col0——X 后 \b 覆写回 col0）
        expect(s.snapshot().split("\n")[1]).toBe("Y");
        const t = new Vt100Screen({ rows: 2, cols: 16 });
        t.feed("A\tB");
        expect(t.snapshot().split("\n")[0]).toBe("A       B"); // TAB 到 8 列
    });

    test("滚屏 + autowrap（恰宽 wrap-pending）", () => {
        const s = new Vt100Screen({ rows: 3, cols: 5 });
        s.feed("11111");
        expect(s.cursor).toEqual({ row: 0, col: 5 }); // 恰宽=wrap-pending（VT100：第 cols+1 字符才折）
        s.feed("X"); // 第 6 字符 → autowrap 折到行 1
        expect(s.cursor.row).toBe(1);
        s.feed("\r\nL3\r\nL4\r\nL5"); // 连续 LF → 底部滚屏（11111/X 先后出屏）
        const lines = s.snapshot().split("\n");
        expect(lines[0]).toBe("L3"); // 推演：[L3, L4, L5]
        expect(lines[2]).toBe("L5"); // 最新行在底
    });

    test("OSC 忽略（长 OSC 不炸）", () => {
        const s = new Vt100Screen({ rows: 2, cols: 8 });
        s.feed("\x1b]0;title-长标题\x07OK");
        expect(s.snapshot()).toContain("OK");
    });
});

describe("StreamSessionManager.onScreen 桥", () => {
    test("TUI 增量流：每 chunk 一帧 snapshot + 行桥并存", async () => {
        class FakeChild extends EventEmitter {
            stdout = new EventEmitter();
            stderr = new EventEmitter();
            stdin = { write: () => true, end: () => true };
            pid = 99;
            kill() { this.emit("exit", 0); return true; }
        }
        const procs: FakeChild[] = [];
        const impl: SpawnImpl = () => { const c = new FakeChild(); procs.push(c); return c as unknown as ChildProcess; };
        const mgr = new StreamSessionManager(["h"], { spawnImpl: impl, disableMux: true });
        const snaps: string[] = [];
        const lines: string[] = [];
        await mgr.start("watch x", {
            onScreen: (snap) => snaps.push(snap),
            onLine: (l) => lines.push(l.text),
        });
        procs[0]!.stdout.emit("data", Buffer.from("GPU 48C\r\nMEM OK"));   // 帧 1（含 \r\n）
        procs[0]!.stdout.emit("data", Buffer.from("\x1b[1;6H9"));          // 帧 2（CUP 增量——"GPU 48C" 的 '8' 在 1-based 第 6 列）
        expect(snaps.length).toBe(2);
        expect(snaps[0]).toContain("48C");
        expect(snaps[1]).toContain("49C"); // 增量重演回放
        expect(lines.join("")).toContain("GPU 48C"); // 行桥并存（\r\n 成行）
        mgr.stop(mgr.list()[0]!.sessionId);
    });
});

// GPT Astra 四十四期：#1 rows:1 滚屏先 shift 后读 rows[0] 宽度=TypeError（单行画面收到换行即触发）；
// #2 中文宽字符光标按字符数推进——「中A」后 CUP 第三列写 B 得「中AB」（预期「中B」：宽字符占双显示列）。
describe("Vt100Screen 宽度模型（四十四期）", () => {
    test("#1 rows:1 单行画面换行滚屏不抛错", () => {
        const s = new Vt100Screen({ rows: 1, cols: 20 });
        expect(() => s.feed("first\r\nsecond")).not.toThrow(); // 修前：TypeError（LF 不回列——CR+LF 全语义断言）
        expect(s.snapshot()).toBe("second"); // 首行滚出，新行内容在场
    });

    test("#2 中A 后 CUP 第三列写 B → 中B（宽字符双格占位）", () => {
        const s = new Vt100Screen({ rows: 1, cols: 10 }); // 单行屏——快照无尾空行干扰
        s.feed("中A");
        s.feed("\u001b[1;3HB"); // 定位 1-based 列 3（=A 的显示列位）写入 B
        expect(s.snapshot()).toBe("中B"); // 修前：中AB（光标只推进了 2 显示列）
    });

    test("宽度模型边角：BS 跨宽字符归位 + autowrap 宽字符右放不下折行", () => {
        const s = new Vt100Screen({ rows: 3, cols: 4 });
        s.feed("中A\b\b\b"); // 退三格：A + 中右半归位 + 中左半
        expect(s.cursor.col).toBe(0); // 停在宽字符左半（不得停中间）
        const s2 = new Vt100Screen({ rows: 3, cols: 4 });
        s2.feed("abc中"); // c 后 curCol=3，宽字符右边(格 4)放不下 → 折行
        const lines = s2.snapshot().split("\n");
        expect(lines[0]).toBe("abc");
        expect(lines[1]).toBe("中"); // 宽字符整体去了下一行（不留半个）
    });
});

// GPT Astra 四十五期（实为 Sol 接棒后 VT100 双 P2）：#1 擦除宽字符只清左半——右半占位
// 空串残留被 join 折叠=后面字符视觉左移（中A+EL1 得「 A」）；#2 OSC 的 ST（ESC \）
// 反斜杠落进画面（分块得 \OK）。
describe("Vt100Screen 擦除联动与 OSC 终止（四十五期）", () => {
    test("#1 擦除宽字符联动另一半：中A+光标回首+EL1 → 两空格 A（不左移）", () => {
        const s = new Vt100Screen({ rows: 1, cols: 10 });
        s.feed("中A");
        s.feed("\u001b[1;1H\u001b[1K"); // 光标回首列 + 向左擦除（含光标位）
        expect(s.snapshot()).toBe("  A"); // 修前：" A"（占位折叠——A 从列 3 左移到列 2）
    });

    test("#2 OSC 终止符 ESC \ 的反斜杠不入画（分块喂入）", () => {
        const s = new Vt100Screen({ rows: 1, cols: 10 });
        s.feed("\u001b]0;窗口标题\u001b\\"); // OSC + ST 终止
        s.feed("OK"); // 终止后的正文才入画
        expect(s.snapshot()).toBe("OK"); // 修前："\OK"（ST 的反斜杠落进画面）
    });
});

// GPT Astra 四十六期：CSI 参数集缺冒号（ITU T.416 参数子分隔符）——真彩色 SGR 中途退出
// CSI 状态，剩余参数（2::255:0:0m）落进画面污染快照。
describe("Vt100Screen 真彩色 SGR（四十六期）", () => {
    test("ESC[38:2::255:0:0m 完整吞掉——正文 OK 不被参数污染", () => {
        const s = new Vt100Screen({ rows: 1, cols: 20 });
        s.feed("\u001b[38:2::255:0:0mOK"); // 真彩色红 + 正文
        expect(s.snapshot()).toBe("OK"); // 修前："2::255:0:0mOK"（冒号后落画）
    });
});

// GPT Astra 四十七期：#1 CSI 只认参数子集——私有前缀（>）与中间字节（空格）使解析器中途
// 退出，剩余字符落画（ESC[>0c 实测 0cOK / ESC[2 q 实测 qOK）；#2 csiBuf 无上限（分块
// 送参实测 26 万字符累积）。深排追加：DCS（ESC P）曾被当单字符忽略——载荷整体落画。
describe("Vt100Screen CSI 完整消费与上限（四十七期）", () => {
    test("#1 私有前缀与中间字节的序列整体吞掉：正文 OK 不被污染", () => {
        const a = new Vt100Screen({ rows: 1, cols: 20 });
        a.feed("\u001b[>0cOK"); // DA 私有前缀响应
        expect(a.snapshot()).toBe("OK"); // 修前：0cOK
        const b = new Vt100Screen({ rows: 1, cols: 20 });
        b.feed("\u001b[2 qOK"); // 光标样式（空格=中间字节）
        expect(b.snapshot()).toBe("OK"); // 修前：qOK
    });

    test("#2 超限参数流：缓冲封顶 128 + 序列作废后正文照常", () => {
        const s2 = new Vt100Screen({ rows: 1, cols: 32 });
        s2.feed("\u001b[");
        for (let i = 0; i < 8; i++) s2.feed("1234567890".repeat(5000)); // 40 万参数字符分块
        const buf = (s2 as unknown as { csiBuf: string }).csiBuf;
        expect(buf.length).toBeLessThanOrEqual(128); // 修前：40 万（实测 26 万+ 无界涨）
        s2.feed("mOK"); // 终结字节收尾 + 正文
        expect(s2.snapshot()).toBe("OK"); // 作废序列不派发，正文照常入画
    });

    test("深排：DCS（ESC P）载荷到 ST 整体吞掉——不落画", () => {
        const s3 = new Vt100Screen({ rows: 1, cols: 20 });
        s3.feed("\u001bP1;2|payload-data\u001b\\OK"); // DCS + ST + 正文
        expect(s3.snapshot()).toBe("OK"); // 修前：载荷整体落画（ESC P 被当单字符忽略）
    });
});

// 四十七期深排边角：嵌套 ESC——ESC 态收 ESC 应保持（次序列正常解析），CSI 态收
// ESC 应中断重来（不吞进参数区）。malformed 流不落画不吞序列。
describe("Vt100Screen 嵌套 ESC 边角（四十七期深排）", () => {
    test("ESC ESC [2J：次序列清屏生效（首个 ESC 被丢弃重开）", () => {
        const s4 = new Vt100Screen({ rows: 1, cols: 10 }); // 单行屏——快照无尾空行
        s4.feed("XX");
        s4.feed("\u001b\u001b[2J"); // 双 ESC + 清屏
        expect(s4.snapshot()).toBe(""); // 修前：[ 落画（第二 ESC 被丢、序列断头）
    });

    test("CSI 中途 ESC：中断当前序列、新序列从头解析", () => {
        const s5 = new Vt100Screen({ rows: 1, cols: 10 }); // 同上
        s5.feed("\u001b[12\u001b[2JY"); // 残缺 CSI + 新的清屏
        expect(s5.snapshot()).toBe("Y"); // 修前：[2J 被吞进参数区、J 落画
    });
});

// GPT Astra 四十八期：#1 带中间字节的 CSI 是独立命令空间（ESC[2 SP A=SL 右移）——剥杂质
// 后误入公有命令（当 CUU 上移，实测 X 覆盖第一行）；#2 字符集选择 ESC ( B 的中间字节
// 提前退出致末字节 B 落画（分块实测 BOK）；#3 LF 不清 wrap-pending——写满行后 LF+X
// 连跳两行（X 落第三行、第二行空）。
describe("Vt100Screen 命令空间/字符集/wrap-pending（四十八期）", () => {
    test("#1 ESC[2 SP A（SL 右移）不误当 CUU——光标不上移，X 写在第二行", () => {
        const s6 = new Vt100Screen({ rows: 3, cols: 8 });
        s6.feed("AAA\u001b[2;1H\u001b[2 A"); // 第一行写满内容 + 光标到第二行行首 + SL 右移 2
        s6.feed("X");
        const lines = s6.snapshot().split("\n");
        expect(lines[0]).toBe("AAA"); // 修前：X 覆盖第一行（CUU 上移 2）
        expect(lines[1]).toBe("X");   // X 留在第二行（SL 未实现=整体忽略）
    });

    test("#2 字符集选择 ESC ( B 末字节吞掉——分块喂入正文 OK", () => {
        const s7 = new Vt100Screen({ rows: 1, cols: 10 });
        s7.feed("\u001b("); // 中间字节（分块）
        s7.feed("BOK"); // 终结字节 B + 正文
        expect(s7.snapshot()).toBe("OK"); // 修前：BOK（B 落画）
    });

    test("#3 写满行后 LF 收编 wrap-pending——X 在第二行不连跳", () => {
        const s8 = new Vt100Screen({ rows: 3, cols: 5 });
        s8.feed("12345\nX"); // 写满 5 列 + LF + X
        const lines = s8.snapshot().split("\n");
        expect(lines[0]).toBe("12345");
        expect(lines[1]).toBe("    X"); // 修前：X 落第三行（连跳两行）
    });
});
