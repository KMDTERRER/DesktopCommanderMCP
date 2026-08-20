export type DeviceHealthPart = 'channel' | 'child';
export type DeviceReachabilityStatus = 'online' | 'offline';

/** Single runtime owner of mcp_devices.status. Registration bootstraps offline;
 * afterwards status is online only when both remote transport and local MCP child are healthy. */
export class DeviceStatusArbiter {
    private parts: Record<DeviceHealthPart, boolean> = { channel: false, child: false };
    private lastQueued: DeviceReachabilityStatus = 'offline';
    private lastWritten: DeviceReachabilityStatus = 'offline';
    private writeChain: Promise<void> = Promise.resolve();

    constructor(private readonly options: { write: (status: DeviceReachabilityStatus) => Promise<boolean> }) {}

    get status(): DeviceReachabilityStatus {
        return this.parts.channel && this.parts.child ? 'online' : 'offline';
    }

    report(part: DeviceHealthPart, ready: boolean): void {
        this.parts[part] = ready;
        this.queue();
    }

    async sync(): Promise<void> {
        this.queue();
        await this.writeChain;
    }

    async flush(): Promise<void> { await this.writeChain; }

    private queue(): void {
        const status = this.status;
        if (status === this.lastQueued) return;
        this.lastQueued = status;
        this.writeChain = this.writeChain.then(async () => {
            const persisted = await this.options.write(status);
            if (persisted) {
                this.lastWritten = status;
            } else if (this.lastQueued === status) {
                // Writer was not ready yet (typically pre-registration). Keep the
                // transition retryable instead of pretending it reached storage.
                this.lastQueued = this.lastWritten;
            }
        }).catch((error: any) => {
            if (this.lastQueued === status) this.lastQueued = this.lastWritten;
            console.error(`[DEBUG] Device status arbiter write '${status}' failed:`, error?.message ?? error);
        });
    }
}
