/**
 * vt100-screen.ts — 轻量 VT100 虚拟屏幕（TUI 全屏程序字符级截屏）
 *
 * 第五季观察窗专项实测灵感：`watch/htop/nvtop` 等 ncurses 程序按
 * `\x1b[row;colH` 光标定位增量重绘、**不输出换行**——行模式对它退化（数据在但
 * 不可读）。本件是可选的终端仿真：feed 原始字节流 → snapshot 字符级高清截屏。
 *
 * 纯逻辑零 I/O 零依赖；手写状态机零正则。转义序列子集（观察够用）：
 * CUP/HVP（光标定位）、ED/EL（清屏/清行）、CUU/CUD/CUF/CUB（光标移动）、
 * LF（换行+滚屏）/CR/BS/TAB、SGR 忽略、OSC 忽略；其余序列保守忽略。
 * Autowrap：超行宽折到下一行（VT100 语义——ncurses 假设终端宽=实际宽，
 * 建议 cols 给足）。
 *
 * 显示宽度模型（Astra 四十四期 #2）：格索引=显示列索引——宽字符（CJK/emoji）
 * 占双格（左格存字符+右格空串占位，join 时自然隐形）；光标/定位/退格全部按
 * 显示宽度推进。零宽（组合符/变体选择符）不占格直接忽略。
 */
export interface Vt100ScreenOptions {
    rows?: number;
    cols?: number;
}

const ESC = "\u001b";
const BEL = "\u0007";

/** East Asian Width 简版（观察场景够用——零依赖红线，wcwidth 语义手写子集） */
const WIDE_RE = /[ᄀ-ᅟ〈-〉⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/;
const ZERO_RE = /[̀-ͯ​-‏︀-️]/;

function charWidth(ch: string): 0 | 1 | 2 {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x1F300 && cp <= 0x1FAFF) return 2; // emoji 区
    if (cp >= 0x20000 && cp <= 0x3FFFD) return 2; // CJK 扩展 B+
    if (ZERO_RE.test(ch)) return 0; // 组合符/变体选择符/零宽空格
    return WIDE_RE.test(ch) ? 2 : 1;
}

export class Vt100Screen {
    private rows: string[][];
    private readonly cols: number;
    private curRow = 0;
    /** 光标=显示列（宽字符双格推进——格索引即显示列索引） */
    private curCol = 0;
    /** 解析状态：0=normal 1=esc 2=csi 3=osc */
    private state = 0;
    private csiBuf = "";
    /** CSI 丢弃模式（参数超 128——序列作废，吞到终结字节不派发） */
    private csiOverflow = false;
    private oscBuf = "";
    private _frames = 0;

    constructor(opts: Vt100ScreenOptions = {}) {
        const rows = opts.rows ?? 24;
        this.cols = opts.cols ?? 220;
        // 固定 cols 字段（Astra 四十四期 #1）：滚屏时 rows:1 先 shift 后数组瞬间
        // 为空——从 rows[0] 取宽=TypeError；行宽恒定，字段即真相
        this.rows = Array.from({ length: rows }, () => Array.from({ length: this.cols }, () => " "));
    }

    /** 喂原始字节流（含转义序列） */
    feed(chunk: string): void {
        for (const ch of chunk) this.put(ch);
        this._frames++;
    }

    /** 字符级高清截屏（行尾空白裁剪） */
    snapshot(): string {
        return this.rows.map((r) => r.join("").replace(/ +$/, "")).join("\n");
    }

    get cursor(): { row: number; col: number } {
        return { row: this.curRow, col: this.curCol };
    }

    /** 已喂 chunk 数（帧计数——TUI 增量包一包一帧） */
    get frames(): number {
        return this._frames;
    }

    private put(ch: string): void {
        switch (this.state) {
            case 0: { // normal
                if (ch === ESC) { this.state = 1; return; }
                this.writeChar(ch);
                return;
            }
            case 1: { // esc
                if (ch === "[") { this.state = 2; this.csiBuf = ""; this.csiOverflow = false; return; }
                if (ch === ESC) return; // 嵌套 ESC：保持 esc 态（丢弃后重开——次序列不落画）
                // 字符串序列族（OSC ]/DCS P/SOS X/PM ^/APC _）——载荷到 ST（ESC \）或
                // BEL 终止，全部吞掉不落画（四十七期深排：ESC P 曾被当单字符忽略，
                // DCS 载荷整体落画）。复用 osc 态：吞载荷语义同构
                if (ch === "]" || ch === "P" || ch === "X" || ch === "^" || ch === "_") {
                    this.state = 3;
                    this.oscBuf = "";
                    return;
                }
                // 中间字节（0x20-0x2F：( ) * + 等）——字符集/编码选择族（ESC ( B、
                // ESC ) 0、ESC % G……）的终结字节还在后面（四十八期 #2：提前回
                // normal 会把末字节写进画面，分块 ESC ( + BOK 实测 BOK）。进 state 4 吞终结
                if (ch >= " " && ch <= "/") { this.state = 4; return; }
                // 其余两字符序列（7/8 等单字符后缀）忽略
                this.state = 0;
                return;
            }
            case 2: { // csi
                // ECMA-48 完整消费（四十七期 #1）：参数区 0x30-0x3F（数字 : ; < = > ?）
                // 与中间字节区 0x20-0x2F（空格到 /，如 ESC[2 q 的光标样式序列）都进
                // 缓冲——私有前缀（>）与中间字节（空格）曾使解析器中途退出，剩余
                // 字符当文本落画（ESC[>0c 实测显示 0c）。只在终结字节 0x40-0x7E 出口。
                // 缓冲上限 128（四十七期 #2）：持续参数字符（恶意/异常流）不再无限
                // 累积——超限进丢弃模式（吞到终结字节，序列作废不派发）
                if (ch >= " " && ch <= "?") {
                    if (this.csiBuf.length < 128) this.csiBuf += ch;
                    else this.csiOverflow = true;
                    return;
                }
                if (ch >= "@" && ch <= "~") {
                    this.state = 0;
                    this.csiDispatch(ch);
                    return;
                }
                if (ch === ESC) { this.state = 1; return; } // ESC 中断当前序列——新序列从头（不吞进参数区）
                return; // 其余（DEL 等）忽略——留 CSI 态继续消费
            }
            case 4: { // esc-中间字节后：吞终结字节（字符集选择族 ESC ( B 等）
                this.state = ch === ESC ? 1 : 0; // ESC=畸形流重开，其余吞掉
                return;
            }
            default: { // osc
                // BEL=单字符终止；ESC=ST（ESC \）前半——转 esc 态消化后续
                // （Astra 四十五期 #2：直接回 state 0 会让 ST 的反斜杠落进画面）
                if (ch === BEL) { this.state = 0; return; }
                if (ch === ESC) { this.state = 1; return; }
                if (this.oscBuf.length < 256) this.oscBuf += ch; // 忽略内容（防长流）
                return;
            }
        }
    }

    private csiDispatch(final: string): void {
        if (this.csiOverflow) { this.csiOverflow = false; return; } // 超限序列作废
        // 中间字节/私有前缀=**独立命令空间**（四十八期 #1）：ESC[2 SP A 是 SL（右移）
        // 不是 CUU（上移）——剥掉杂质再派发会执行错误命令（实测 X 覆盖到上一行）。
        // 本屏引擎只实现无前缀的公有命令，带中间字节/私有前缀的序列整体忽略
        if (/[<=>? -/]/.test(this.csiBuf)) return;
        const parts = this.csiBuf.split(";");
        const n = (i: number, d: number) => {
            const v = parts[i] === undefined || parts[i] === "" ? d : parseInt(parts[i]!, 10);
            return Number.isFinite(v) ? v : d;
        };
        switch (final) {
            case "H": case "f": // CUP/HVP：1-based 定位
                this.moveTo(Math.max(0, n(0, 1) - 1), Math.max(0, n(1, 1) - 1));
                return;
            case "A": this.moveTo(this.curRow - Math.max(1, n(0, 1)), this.curCol); return; // CUU
            case "B": this.moveTo(this.curRow + Math.max(1, n(0, 1)), this.curCol); return; // CUD
            case "C": this.moveTo(this.curRow, this.curCol + Math.max(1, n(0, 1))); return; // CUF
            case "D": this.moveTo(this.curRow, this.curCol - Math.max(1, n(0, 1))); return; // CUB
            case "J": { // ED
                const mode = n(0, 0);
                if (mode === 2) this.clearAll();
                else if (mode === 0) this.clearRegion(this.curRow, this.curCol, this.rows.length - 1, -1);
                else if (mode === 1) this.clearRegion(0, 0, this.curRow, this.curCol);
                return;
            }
            case "K": { // EL
                const mode = n(0, 0);
                if (mode === 0) this.clearRegion(this.curRow, this.curCol, this.curRow, -1);
                else if (mode === 1) this.clearRegion(this.curRow, 0, this.curRow, this.curCol);
                else this.clearRegion(this.curRow, 0, this.curRow, -1);
                return;
            }
            default:
                return; // m（SGR）等其余序列忽略
        }
    }

    private writeChar(ch: string): void {
        if (ch === "\n") { this.lineFeed(); return; }
        if (ch === "\r") { this.curCol = 0; return; }
        if (ch === "\b") {
            this.curCol = Math.max(0, this.curCol - 1);
            // 光标不得停在宽字符中间（落在右半占位格上再退到左半）
            if (this.rows[this.curRow]![this.curCol] === "") this.curCol = Math.max(0, this.curCol - 1);
            return;
        }
        if (ch === "\t") {
            this.curCol = Math.min(this.cols - 1, (Math.floor(this.curCol / 8) + 1) * 8);
            return;
        }
        if (ch < " ") return; // 其余控制字符忽略
        const w = charWidth(ch);
        if (w === 0) return; // 零宽不占格（组合符观察场景忽略）
        // autowrap：普通字符越界折行；宽字符右边放不下同样折行
        if (this.curCol >= this.cols || (w === 2 && this.curCol + 1 >= this.cols)) {
            this.curCol = 0;
            this.lineFeed();
        }
        const line = this.rows[this.curRow]!;
        this.clearGlyphAt(line, this.curCol); // 覆盖目标格上的旧字形（宽字符残半清理）
        if (w === 2) this.clearGlyphAt(line, this.curCol + 1);
        line[this.curCol] = ch;
        if (w === 2 && this.curCol + 1 < this.cols) line[this.curCol + 1] = ""; // 右半占位（join 隐形）
        this.curCol += w;
    }

    /** 清除某格上的旧字形：右半占位 → 清其左半宽字符；宽字符左半 → 清其右半 */
    private clearGlyphAt(line: string[], c: number): void {
        const g = line[c];
        if (g === undefined) return;
        if (g === "") {
            if (c > 0 && charWidth(line[c - 1] ?? "") === 2) line[c - 1] = " ";
        } else if (charWidth(g) === 2 && line[c + 1] === "") {
            line[c + 1] = " ";
        }
    }

    private lineFeed(): void {
        // LF 收编 wrap-pending（四十八期 #3）：写满一行后 curCol 停在越界位（=待折
        // 标记，lazy wrap 语义）。LF 已推进一行——若保留越界态，下一字符写入时再次
        // 折行=连跳两行（3×5 屏 12345+LF+X 实测 X 落第三行、第二行空）。归位到
        // 最后写入格（xterm deferred wrap 语义：LF 清 pending、光标列停最后格）
        if (this.curCol >= this.cols) this.curCol = this.cols - 1;
        if (this.curRow >= this.rows.length - 1) {
            this.rows.shift();
            this.rows.push(Array.from({ length: this.cols }, () => " ")); // 宽度用字段（rows:1 时 shift 后数组瞬间为空）
            this.curRow = this.rows.length - 1;
        } else {
            this.curRow++;
        }
    }

    private moveTo(row: number, col: number): void {
        this.curRow = Math.max(0, Math.min(this.rows.length - 1, row));
        this.curCol = Math.max(0, Math.min(this.cols - 1, col));
        // 光标不得停在宽字符中间（落在右半占位格归位到左半）
        if (this.rows[this.curRow]![this.curCol] === "" && this.curCol > 0) this.curCol--;
    }

    /** endCol=-1 表示到行尾；endRow 含 */
    private clearRegion(row1: number, col1: number, row2: number, col2: number): void {
        const cols = this.cols;
        for (let r = Math.max(0, row1); r <= Math.min(this.rows.length - 1, row2); r++) {
            const from = r === row1 ? Math.max(0, col1) : 0;
            const to = (col2 === -1 || r < row2) ? cols - 1 : Math.min(cols - 1, col2);
            for (let c = from; c <= to; c++) {
                // 擦除联动宽字符另一半（Astra 四十五期 #1）：只清左半会留孤儿占位
                // 空串——join 折叠=后面字符视觉左移；只清右半会留半个宽字符
                this.clearGlyphAt(this.rows[r]!, c);
                this.rows[r]![c] = " ";
            }
        }
    }

    private clearAll(): void {
        this.rows = Array.from({ length: this.rows.length }, () => Array.from({ length: this.cols }, () => " "));
    }
}
