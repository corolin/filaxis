/**
 * daemon-rpc-keepalive.test.ts — /rpc 的请求体「读而不完结」，不放坏连接复用
 *
 * 为了在 bun 1.3.12 上也收得到调用方断开，/rpc 读够 Content-Length 就暂停请求流、应答后再放开
 * （daemon-server.ts readRawJsonBodyHeld）。同一条 keep-alive 连接上连发请求：每个都照常应答，
 * 连接确实被复用（没被服务端关掉）；早退路径（协议不符）与分块请求体（没有 Content-Length）同样如此。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonServer } from "../src/index.js";
import { PROTOCOL_VERSION } from "../src/middle/protocol.js";

const root = mkdtempSync(join(tmpdir(), "fx-rpc-keepalive-"));
const srv = new DaemonServer({ daemonDir: join(root, "daemon"), version: "test" });
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

afterAll(async () => {
    agent.destroy();
    await srv.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
});

/** 发一帧 /rpc，回报应答与本地端口（端口相同 = 同一条连接）。`chunks` 为多段时不带 Content-Length（分块） */
function rpc(port: number, token: string, chunks: string[]): Promise<{ status: number; json: { ok?: boolean; code?: string }; localPort?: number }> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1", port, path: "/rpc", method: "POST", agent,
            headers: chunks.length === 1
                ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(chunks[0]!)), Authorization: `Bearer ${token}` }
                : { "Content-Type": "application/json", "Transfer-Encoding": "chunked", Authorization: `Bearer ${token}` },
        }, (res) => {
            let text = "";
            res.setEncoding("utf-8");
            res.on("data", (d: string) => { text += d; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as { ok?: boolean; code?: string }, localPort: req.socket?.localPort }));
        });
        req.on("error", reject);
        for (const c of chunks) req.write(c);
        req.end();
    });
}

const frame = (op: string): string => JSON.stringify({ protocol: PROTOCOL_VERSION, op, params: {} });

describe("/rpc 读而不完结 → 连接照常复用", () => {
    test("同一条 keep-alive 连接连发：定长、协议不符（早退）、分块，全部照常应答", async () => {
        const url = new URL(await srv.start());
        const port = Number(url.port);
        const good = JSON.stringify({ protocol: "0.0.0-old", op: "features", params: {} });
        const replies = [];
        for (const chunks of [[frame("features")], [frame("listLayers")], [good], [frame("features")], ["{\"protocol\":", `${PROTOCOL_VERSION},"op":"features","params":{}}`]]) {
            replies.push(await rpc(port, srv.token, chunks));
        }
        expect(replies.map((r) => [r.status, r.json.ok, r.json.code])).toEqual([
            [200, true, undefined], [200, true, undefined], [200, false, "E_PROTOCOL_MISMATCH"], [200, true, undefined], [200, true, undefined],
        ]);
        expect(new Set(replies.map((r) => r.localPort)).size).toBe(1); // one connection for all five
    }, 30_000);
});
