/**
 * layer-store.ts — 已存层表（`~/.filaxis/layers.json`，`FILAXIS_LAYERS` 覆盖路径）
 *
 * `filaxis layer save` 写入的层描述符。CLI、MCP 入口与 Daemon 都从这里取同一份，
 * 三条入口对层名与层通配的解析才一致。只读；写入锁与原子落位在 CLI 侧
 * （`updateLayerStore`）。库代码与工具集自身不读用户目录——由入口把读取函数
 * 注入工具集（`createAgentToolkit` 的 `savedLayers`）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeDescriptor } from "./driver.js";

export function layerStorePath(): string {
    return process.env.FILAXIS_LAYERS ?? join(homedir(), ".filaxis", "layers.json");
}

/** 文件不存在视为空表；存在但读不出、或形态不对则抛错（坏档不静默当空） */
export function loadLayerStore(): Record<string, RuntimeDescriptor> {
    try {
        const parsed = JSON.parse(readFileSync(layerStorePath(), "utf-8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("层快照必须是对象");
        return Object.assign(Object.create(null), parsed);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null);
        throw error;
    }
}
