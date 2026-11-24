import type { RuntimeDescriptor, RuntimeDriver } from "./driver.js";
import { probeDialect } from "./dialect.js";
import { getFile, putFile, sftpGetFile, sftpPutFile, type SftpOptions, type TransferResult } from "./file-transfer.js";
import { autonomousSshOpts, enterStepsOf, sshArgsFor, type SshConnParams } from "./ssh-helpers.js";

export type FileTransferTransport = "exec" | "sftp";

export interface LayerFileTransferOptions {
    localPath: string;
    remotePath: string;
    transport?: FileTransferTransport;
    timeoutMs?: number;
    writeMode?: "auto" | "inplace";
}

export type LayerFileTransferResult = TransferResult & { transport: FileTransferTransport };

export function validateFileTransferFields(operation: "put" | "get", fields: LayerFileTransferOptions): void {
    for (const [name, path] of Object.entries({ local_path: fields.localPath, remote_path: fields.remotePath })) {
        if (typeof path !== "string" || !path.length || path.includes("\0")) throw new Error(`${name} 需要有效的文件路径`);
    }
    const { transport, timeoutMs, writeMode } = fields;
    if (transport !== undefined && transport !== "exec" && transport !== "sftp") throw new Error("transport 须为 exec 或 sftp");
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)) {
        throw new Error("timeout_ms/timeoutMs 须为 1 到 2147483647 之间的整数");
    }
    if (writeMode !== undefined) {
        if (operation === "get") throw new Error("write_mode/writeMode 仅用于上传");
        if (writeMode !== "auto" && writeMode !== "inplace") throw new Error("write_mode/writeMode 须为 auto 或 inplace");
    }
}

export async function transferLayerFile(
    driver: RuntimeDriver,
    operation: "put" | "get",
    options: LayerFileTransferOptions,
): Promise<LayerFileTransferResult> {
    validateFileTransferFields(operation, options);
    const { localPath, transport = "exec", timeoutMs = 120_000 } = options;
    const forceInplace = options.writeMode === "inplace";
    let layerPath = options.remotePath;
    if (driver.descriptor.driver === "local" && process.platform === "win32") layerPath = layerPath.replaceAll("\\", "/");
    if (layerPath.startsWith("-")) layerPath = `./${layerPath}`;
    const sftp = transport === "sftp" ? sftpOptions(driver.descriptor, timeoutMs, forceInplace) : undefined;
    const auditLabel = operation === "put" ? "file upload" : "file download";
    const exec = (command: string) => driver.exec(command, { timeoutMs, auditLabel });
    const dialect = await probeDialect(exec);
    const isTmux = driver.descriptor.driver === "tmux" || Boolean(driver.descriptor.terminalId) || "terminal" in driver;
    const chunkB64 = isTmux ? 12_000 : undefined;
    const result = operation === "put"
        ? (sftp ? await sftpPutFile(exec, dialect, localPath, layerPath, sftp)
            : await putFile(exec, dialect, localPath, layerPath, { chunkB64, forceInplace }))
        : (sftp ? await sftpGetFile(exec, dialect, layerPath, localPath, sftp)
            : await getFile(exec, dialect, layerPath, localPath, { chunkB64 }));
    return { transport, ...result };
}

function sftpOptions(descriptor: RuntimeDescriptor, timeoutMs: number, forceInplace: boolean): SftpOptions {
    const { driver, target, config } = descriptor;
    const conn = config?.connParams as SshConnParams | undefined;
    if (driver !== "ssh" || !target || enterStepsOf(config).length
        || (Array.isArray(config?.sshHops) && config.sshHops.length) || conn?.forwards?.length) {
        throw new Error("SFTP 需要可直接寻址的 SSH 文件系统，支持 TCP 跳板。容器、逐跳 PTY 或显式端口转发请使用可用的 exec 通道");
    }
    const { port, ...connection } = conn ?? {};
    const options = autonomousSshOpts(conn);
    if (port) options.push("-P", String(port));
    const targetArgs = sshArgsFor({ host: target, conn: connection });
    const destination = targetArgs.pop()!;
    const at = destination.lastIndexOf("@");
    const hostname = destination.slice(at + 1);
    const sftpDestination = !hostname.startsWith("[") && hostname.split(":").length > 2
        ? `${destination.slice(0, at + 1)}[${hostname}]` : destination;
    return { connArgs: [...options, ...targetArgs, sftpDestination], timeoutMs, forceInplace };
}
