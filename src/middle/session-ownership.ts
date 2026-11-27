import type { RuntimeDriver } from "../core/base/driver.js";

export type StopResult = {
    status: "exited" | "stopped" | "unknown";
    exit_code?: number | null;
    note?: string;
};

type TerminalResult = Omit<StopResult, "status"> & { status: "exited" | "stopped" };
type Active = { driver: RuntimeDriver };
type Entry = Active | { result: TerminalResult; expiresAt: number };
type ManagedDriver = RuntimeDriver & {
    sessions?: { sessionState?(id: string): { status: "running" | "exited" | "stopped"; exitCode: number | null } | undefined };
};

export class SessionOwnership {
    private readonly entries = new Map<string, Entry>();
    private readonly checkingDrivers = new WeakSet<RuntimeDriver>();
    private timer?: ReturnType<typeof setInterval>;

    constructor(private readonly retentionMs: number, private readonly checkIntervalMs: number) {
        if (![retentionMs, checkIntervalMs].every((value) => Number.isFinite(value) && value >= 1 && value <= 2_147_483_647)) {
            throw new RangeError("Session retention and check interval must be positive timer durations");
        }
    }

    track(id: string, driver: RuntimeDriver): void {
        this.entries.set(id, { driver });
        this.timer ??= startChecking(this, this.checkIntervalMs);
    }

    get(id: string): Entry | undefined {
        const entry = this.entries.get(id);
        if (entry && "expiresAt" in entry && entry.expiresAt <= Date.now()) {
            this.entries.delete(id);
            return undefined;
        }
        return entry;
    }

    remember(id: string, result: StopResult): void {
        const entry = this.get(id);
        if (!entry || !("driver" in entry) || result.status === "unknown") return;
        if (result.status === "exited" && !Number.isSafeInteger(result.exit_code)) return;
        const { status, ...details } = result;
        this.entries.set(id, { result: { status, ...details }, expiresAt: Date.now() + this.retentionMs });
    }

    sweep(): void {
        for (const id of this.entries.keys()) {
            const entry = this.get(id);
            if (entry && "driver" in entry) {
                try { this.check(id, entry); } catch { /* A driver probe must not stop the sweep. */ }
            }
        }
        if (!this.entries.size && this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private check(id: string, entry: Active): void {
        const sessions = (entry.driver as ManagedDriver).sessions;
        if (sessions?.sessionState) {
            // Read without refreshing the session's attention time.
            const state = sessions.sessionState(id);
            if (!state) this.entries.delete(id);
            else if (state.status !== "running") {
                this.remember(id, state.status === "stopped" ? { status: "stopped" } : { status: "exited", exit_code: state.exitCode });
            }
            return;
        }
        if (this.checkingDrivers.has(entry.driver)) return;
        this.checkingDrivers.add(entry.driver);
        void this.probe(id, entry);
    }

    private async probe(id: string, entry: Active): Promise<void> {
        try {
            const status = await Promise.resolve().then(() => entry.driver.verifySession(id));
            if (this.get(id) === entry && status.status === "exited") {
                this.remember(id, { status: "exited", exit_code: status.exitCode ?? null });
            }
        } catch { /* Unknown state preserves the live handle. */ }
        finally {
            if (this.get(id) === entry) {
                // Rotate the entry so a long-running session cannot starve its peers.
                this.entries.delete(id);
                this.entries.set(id, entry);
            }
            this.checkingDrivers.delete(entry.driver);
        }
    }
}

function startChecking(owner: SessionOwnership, intervalMs: number): ReturnType<typeof setInterval> {
    const ref = new WeakRef(owner);
    const timer = setInterval(() => {
        const current = ref.deref();
        if (current) current.sweep();
        else clearInterval(timer);
    }, intervalMs);
    timer.unref?.();
    return timer;
}
