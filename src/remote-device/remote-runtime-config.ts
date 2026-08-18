import fs from 'fs/promises';
import path from 'path';

export type RemoteInboundMode = 'postgres_changes' | 'broadcast_doorbell';
export type RemoteExecutingWriteMode = 'none' | 'simple' | 'raw' | 'fenced';
export type RemoteTerminalWriteMode = 'simple' | 'raw' | 'fenced';

export interface RemoteRuntimeConfig {
    profile: string;
    inbound: RemoteInboundMode;
    executingWrite: RemoteExecutingWriteMode;
    terminalWrite: RemoteTerminalWriteMode;
    outbox: boolean;
    resultWake: boolean;
    heartbeatMs: number;
    diagnostics: boolean;
    maxParallelCalls: number;
}

export const REMOTE_LATENCY_BASELINE_PROFILE = 'latency-baseline';
export const REMOTE_LATENCY_BASELINE_CONFIG: RemoteRuntimeConfig = Object.freeze({
    profile: REMOTE_LATENCY_BASELINE_PROFILE,
    inbound: 'broadcast_doorbell',
    executingWrite: 'none',
    terminalWrite: 'simple',
    outbox: false,
    resultWake: false,
    heartbeatMs: 15_000,
    diagnostics: true,
    maxParallelCalls: 8,
});

const DEFAULT_CONFIG = REMOTE_LATENCY_BASELINE_CONFIG;
function normalize(raw: unknown): RemoteRuntimeConfig {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown> : {};
    const requestedProfile = typeof input.profile === 'string' && input.profile.trim()
        ? input.profile.trim() : 'custom';
    if (requestedProfile === REMOTE_LATENCY_BASELINE_PROFILE) {
        const lockedKeys: Array<keyof RemoteRuntimeConfig> = [
            'inbound', 'executingWrite', 'terminalWrite', 'outbox', 'resultWake',
            'heartbeatMs', 'diagnostics', 'maxParallelCalls',
        ];
        for (const key of lockedKeys) {
            if (input[key] !== undefined && input[key] !== REMOTE_LATENCY_BASELINE_CONFIG[key]) {
                throw new Error(`Profile ${REMOTE_LATENCY_BASELINE_PROFILE} locks ${String(key)}=${String(REMOTE_LATENCY_BASELINE_CONFIG[key])}`);
            }
        }
        return REMOTE_LATENCY_BASELINE_CONFIG;
    }
    const executingWrite = input.executingWrite === 'simple' || input.executingWrite === 'raw' || input.executingWrite === 'fenced'
        ? input.executingWrite : input.executingWrite === 'none' ? 'none' : DEFAULT_CONFIG.executingWrite;
    const terminalWrite = input.terminalWrite === 'fenced' || input.terminalWrite === 'raw'
        ? input.terminalWrite : 'simple';
    const outbox = input.outbox === true;
    if ((terminalWrite === 'fenced' || outbox) && executingWrite !== 'fenced') {
        throw new Error('terminalWrite=fenced/outbox=true requires executingWrite=fenced');
    }
    if (outbox && terminalWrite !== 'fenced') {
        throw new Error('outbox=true requires terminalWrite=fenced');
    }
    const heartbeatMs = typeof input.heartbeatMs === 'number' && Number.isFinite(input.heartbeatMs)
        ? Math.max(0, Math.min(10 * 60_000, Math.round(input.heartbeatMs)))
        : DEFAULT_CONFIG.heartbeatMs;
    const maxParallelCalls = typeof input.maxParallelCalls === 'number' && Number.isFinite(input.maxParallelCalls)
        ? Math.max(1, Math.min(64, Math.round(input.maxParallelCalls)))
        : DEFAULT_CONFIG.maxParallelCalls;
    return Object.freeze({
        profile: requestedProfile,
        inbound: input.inbound === 'broadcast_doorbell' ? 'broadcast_doorbell' : 'postgres_changes',
        executingWrite, terminalWrite, outbox,
        resultWake: input.resultWake === true,
        heartbeatMs,
        diagnostics: input.diagnostics !== false,
        maxParallelCalls,
    });
}

export class RemoteRuntimeConfigStore {
    private config: RemoteRuntimeConfig = DEFAULT_CONFIG;
    private lastMtimeMs = -1;
    private timer: NodeJS.Timeout | null = null;
    private listeners = new Set<(config: RemoteRuntimeConfig) => void>();

    constructor(public readonly filePath: string) {}

    current(): RemoteRuntimeConfig { return this.config; }

    subscribe(listener: (config: RemoteRuntimeConfig) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async initialize(): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        try {
            await fs.access(this.filePath);
        } catch {
            await fs.writeFile(this.filePath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
        }
        await this.reload(true);
        this.timer = setInterval(() => { void this.reload(false); }, 250);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private async reload(force: boolean): Promise<void> {
        try {
            const stat = await fs.stat(this.filePath);
            if (!force && stat.mtimeMs === this.lastMtimeMs) return;
            const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
            const next = normalize(parsed);
            this.lastMtimeMs = stat.mtimeMs;
            const changed = JSON.stringify(next) !== JSON.stringify(this.config);
            this.config = next;
            if (changed || force) {
                console.log(`⚙ REMOTE CONFIG ${next.profile}: inbound=${next.inbound} exec=${next.executingWrite} terminal=${next.terminalWrite} outbox=${next.outbox} wake=${next.resultWake} heartbeat=${next.heartbeatMs}ms parallel=${next.maxParallelCalls}`);
                for (const listener of this.listeners) listener(next);
            }
        } catch (error: any) {
            console.warn(`⚠ Remote runtime config rejected; keeping last-good settings: ${error?.message || error}`);
        }
    }
}
