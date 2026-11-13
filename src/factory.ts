/**
 * factory.ts — Transport 工厂与开放注册表（FEAT-01/FEAT-09：AC-09 第三方 driver 同权接入）
 *
 * 净室平移自 个人Agent项目 `原内部模块`，
 * OSS 化：注册表对外开放（registerDriver）；内置 local，其余 Transport 分批落位。
 */
import type { RuntimeDriver, RuntimeDescriptor } from "./driver.js";
import { LocalRuntimeDriver } from "./local-driver.js";
import { SshPtyDriver } from "./ssh-pty-driver.js";
import { TmuxSessionDriver } from "./tmux-driver.js";

export type DriverFactory = (descriptor: RuntimeDescriptor) => RuntimeDriver;

export class RuntimeFactory {
    private custom = new Map<string, DriverFactory>();

    /** 开放注册：第三方 Transport 与内置同权；重复注册拒绝（FEAT-01 异常策略） */
    registerDriver(type: string, factory: DriverFactory): void {
        if (this.custom.has(type) || ["local", "ssh", "tmux"].includes(type)) {
            throw new Error(`driver '${type}' 已注册，拒绝覆盖——先 unregister 或换类型名`);
        }
        this.custom.set(type, factory);
    }

    unregisterDriver(type: string): boolean {
        return this.custom.delete(type);
    }

    registeredTypes(): string[] {
        return ["local", "ssh", "tmux", ...this.custom.keys()];
    }

    create(descriptor: RuntimeDescriptor, fallbackCwd?: string): RuntimeDriver {
        if (descriptor.driver === "local") {
            return LocalRuntimeDriver.fromDescriptor(descriptor, fallbackCwd);
        }
        if (descriptor.driver === "ssh") {
            return new SshPtyDriver(descriptor);
        }
        if (descriptor.driver === "tmux") {
            return new TmuxSessionDriver(descriptor);
        }
        const f = this.custom.get(descriptor.driver);
        if (f) return f(descriptor);
        // 未知 driver 且无注册工厂：结构化错误（docker/k8s/teleport 快捷方式经
        // launchCmd 走 tmux 后端，或 registerDriver 自定义——FEAT-01/FEAT-09）
        throw new Error(
            `未知 driver '${descriptor.driver}'——经 registerDriver() 注册，或在 config.launchCmd 提供完整启动命令`,
        );
    }
}
