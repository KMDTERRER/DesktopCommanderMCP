import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { renameReplacingWithRetry } from '../utils/atomic-rename.js';
import { readFileBounded } from '../utils/bounded-file-read.js';
import { resourceLimitError } from '../utils/read-resource-limits.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { normalizeMcpToolResult } from '../utils/mcp-tool-error.js';
import { createRemoteOutcomeIdentity } from './remote-result-contract.js';

const MiB = 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 64 * MiB;
const DEFAULT_MAX_LIST_BYTES = 80 * MiB;
const DEFAULT_MAX_LIST_ENTRIES = 32;
const DEFAULT_IO_TIMEOUT_MS = 10_000;

export interface RemoteResultOutboxOptions {
    maxEntryBytes?: number;
    maxListBytes?: number;
    maxListEntries?: number;
    ioTimeoutMs?: number;
}

export type RemoteResultStatus = 'completed' | 'failed';

export interface RemoteResultOutboxEntry {
    version: 2;
    callId: string;
    deviceId: string;
    userId: string;
    toolName: string;
    claimToken: string;
    outcomeRevision?: 1;
    outcomeHash?: string;
    status: RemoteResultStatus;
    result: unknown | null;
    errorMessage: string | null;
    createdAt: string;
}

export class RemoteResultOutbox {
    private readonly maxEntryBytes: number;
    private readonly maxListBytes: number;
    private readonly maxListEntries: number;
    private readonly ioTimeoutMs: number;

    constructor(private readonly directory: string, options: RemoteResultOutboxOptions = {}) {
        this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
        this.maxListBytes = options.maxListBytes ?? DEFAULT_MAX_LIST_BYTES;
        this.maxListEntries = options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;
        this.ioTimeoutMs = options.ioTimeoutMs ?? DEFAULT_IO_TIMEOUT_MS;
        if (!Number.isSafeInteger(this.maxEntryBytes) || this.maxEntryBytes <= 0) throw new Error('Outbox maxEntryBytes must be positive.');
        if (!Number.isSafeInteger(this.maxListBytes) || this.maxListBytes < this.maxEntryBytes) {
            throw new Error('Outbox maxListBytes must be at least maxEntryBytes.');
        }
        if (!Number.isSafeInteger(this.maxListEntries) || this.maxListEntries <= 0) throw new Error('Outbox maxListEntries must be positive.');
        if (!Number.isSafeInteger(this.ioTimeoutMs) || this.ioTimeoutMs <= 0) throw new Error('Outbox ioTimeoutMs must be positive.');
    }

    private runIo<T>(label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
        return runWithAbortableTimeout(operation, this.ioTimeoutMs, label);
    }

    private entryPath(callId: string): string {
        const key = createHash('sha256').update(callId).digest('hex');
        return path.join(this.directory, `${key}.json`);
    }

    private validEntry(value: unknown, expectedCallId?: string): value is RemoteResultOutboxEntry {
        const entry = value as Partial<RemoteResultOutboxEntry> | null;
        const structurallyValid = Boolean(entry && entry.version === 2
            && typeof entry.callId === 'string' && entry.callId
            && typeof entry.deviceId === 'string' && entry.deviceId
            && typeof entry.userId === 'string' && entry.userId
            && typeof entry.toolName === 'string' && entry.toolName
            && typeof entry.claimToken === 'string' && entry.claimToken
            && (entry.outcomeRevision === undefined || entry.outcomeRevision === 1)
            && (entry.outcomeHash === undefined || /^[0-9a-f]{64}$/.test(entry.outcomeHash))
            && (entry.status === 'completed' || entry.status === 'failed')
            && (entry.errorMessage === null || typeof entry.errorMessage === 'string')
            && typeof entry.createdAt === 'string'
            && Number.isFinite(Date.parse(entry.createdAt))
            && (!expectedCallId || entry.callId === expectedCallId));
        if (!structurallyValid) return false;
        let normalizedResult: unknown | null = null;
        try {
            if (!(entry!.status === 'failed' && entry!.result === null)) {
                normalizedResult = normalizeMcpToolResult(entry!.result, `Outbox result for ${entry!.toolName}`);
            }
        } catch {
            return false;
        }
        try {
            const identity = createRemoteOutcomeIdentity(
                entry!.status!, normalizedResult, entry!.errorMessage!,
            );
            if (entry!.outcomeRevision !== undefined && entry!.outcomeRevision !== identity.outcomeRevision) return false;
            if (entry!.outcomeHash !== undefined && entry!.outcomeHash !== identity.outcomeHash) return false;
            return true;
        } catch {
            return false;
        }
    }

    private async quarantine(filePath: string): Promise<void> {
        const destination = `${filePath}.invalid-${Date.now()}-${process.pid}`;
        await this.runIo(
            `Quarantine remote result outbox entry ${filePath}`,
            (_signal) => fs.rename(filePath, destination),
        ).catch(() => {});
    }

    private async readEntry(filePath: string, expectedCallId?: string): Promise<{ entry: RemoteResultOutboxEntry; bytes: number } | null> {
        try {
            const raw = await this.runIo(
                `Read remote result outbox entry ${filePath}`,
                (signal) => readFileBounded(filePath, this.maxEntryBytes, signal, 'Remote result outbox entry'),
            );
            let parsed: unknown;
            try { parsed = JSON.parse(raw.toString('utf8')); }
            catch { await this.quarantine(filePath); return null; }
            if (!this.validEntry(parsed, expectedCallId)) { await this.quarantine(filePath); return null; }
            return { entry: parsed, bytes: raw.length };
        } catch (error: any) {
            if (error?.code === 'ENOENT') return null;
            if (error?.code === 'EFBIG') { await this.quarantine(filePath); return null; }
            throw error;
        }
    }

    async put(entry: RemoteResultOutboxEntry): Promise<void> {
        const toolName = entry.toolName;
        if (!this.validEntry(entry, entry.callId)) {
            throw new Error(`Refusing to persist an invalid remote result for ${toolName}.`);
        }
        await this.runIo(`Create remote result outbox directory ${this.directory}`, async (_signal) => {
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        });
        const serialized = JSON.stringify(entry);
        const serializedBytes = Buffer.byteLength(serialized, 'utf8');
        if (serializedBytes > this.maxEntryBytes) {
            throw resourceLimitError('Remote result outbox entry', this.maxEntryBytes, serializedBytes);
        }
        const target = this.entryPath(entry.callId);
        const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
        try {
            await this.runIo(`Write remote result outbox entry ${entry.callId}`, (signal) =>
                fs.writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600, flush: true, signal })
            );
            const renameDeadline = Date.now() + this.ioTimeoutMs;
            await this.runIo(`Publish remote result outbox entry ${entry.callId}`, (_signal) =>
                renameReplacingWithRetry(temp, target, { deadlineAt: renameDeadline })
            );
        } finally {
            await this.runIo(`Clean remote result outbox temp ${entry.callId}`, async (_signal) => {
                await fs.rm(temp, { force: true });
            }).catch(() => {});
        }
    }

    async get(callId: string): Promise<RemoteResultOutboxEntry | null> {
        return (await this.readEntry(this.entryPath(callId), callId))?.entry ?? null;
    }

    async list(userId?: string): Promise<RemoteResultOutboxEntry[]> {
        return this.runIo(`List remote result outbox ${this.directory}`, async (signal) => {
            let directory;
            try { directory = await fs.opendir(this.directory); }
            catch (error: any) { if (error?.code === 'ENOENT') return []; throw error; }
            signal.throwIfAborted();

            const entries: RemoteResultOutboxEntry[] = [];
            let retainedBytes = 0;
            try {
                for await (const dirent of directory) {
                    signal.throwIfAborted();
                    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
                    const candidate = await this.readEntry(path.join(this.directory, dirent.name));
                    if (!candidate || (userId && candidate.entry.userId !== userId)) continue;
                    if (entries.length >= this.maxListEntries || retainedBytes + candidate.bytes > this.maxListBytes) break;
                    entries.push(candidate.entry);
                    retainedBytes += candidate.bytes;
                }
            } finally {
                await directory.close().catch(() => {});
            }
            return entries;
        });
    }

    async remove(callId: string): Promise<void> {
        await this.runIo(`Remove remote result outbox entry ${callId}`, async (_signal) => {
            await fs.rm(this.entryPath(callId), { force: true });
        });
    }
}
