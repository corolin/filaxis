/** Socket errors that identify a reset connection or a closed pipe. */
export function isDisconnectedSocket(error: Error): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ECONNRESET" || code === "EPIPE";
}
