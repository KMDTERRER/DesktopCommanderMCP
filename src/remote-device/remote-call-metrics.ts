import fs from 'fs/promises';
import path from 'path';
import { isMcpCompatUri } from '../utils/mcp-uri.js';

export type RemoteMetricStage = 'recv' | 'tool_done' | 'terminal_done';

export interface RemoteMetricEvent {
    stage: RemoteMetricStage;
    callId: string;
    tool: string;
    args?: unknown;
    result?: unknown;
    profile: string;
    inbound: string;
    terminalWrite: string;
    receivedAtMs: number;
    createdAt?: unknown;
    laneWaitMs?: number;
    toolMs?: number;
    terminalMs?: number;
    totalMs?: number;
}

function utf8Bytes(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    return Buffer.byteLength(value, 'utf8');
}

function jsonBytes(value: unknown): number | null {
    if (value === undefined) return null;
    try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return null; }
}

function resultTextBytes(value: any): number | null {
    if (!value || !Array.isArray(value.content)) return null;
    let total = 0;
    let found = false;
    for (const item of value.content) {
        if (item && typeof item.text === 'string') {
            total += Buffer.byteLength(item.text, 'utf8');
            found = true;
        }
    }
    return found ? total : null;
}

function toolCategory(tool: string): string {
    if (/search/i.test(tool)) return 'search';
    if (/process|session|terminal/i.test(tool)) return 'process';
    if (/file|directory|pdf|move|edit/i.test(tool)) return 'filesystem';
    if (/config|usage|prompt/i.test(tool)) return 'control';
    if (/mcp|context|serena|crg/i.test(tool)) return 'bridge';
    return 'other';
}

function parseNestedWrite(args: any): any | null {
    if (!args || typeof args.path !== 'string' || !isMcpCompatUri(args.path) || typeof args.content !== 'string') return null;
    try {
        const parsed = JSON.parse(args.content);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
}

async function fileSize(localPath: unknown): Promise<number | null> {
    if (typeof localPath !== 'string' || !localPath || isMcpCompatUri(localPath) || /^https?:\/\//i.test(localPath)) return null;
    try { return (await fs.stat(localPath)).size; } catch { return null; }
}

export class RemoteCallMetrics {
    private writeChain: Promise<void> = Promise.resolve();

    constructor(public readonly filePath: string) {}

    record(event: RemoteMetricEvent): void {
        // Never put diagnostics on the result path. Heavy sizing/stat work and
        // append I/O are deferred and serialized behind the completed call stage.
        this.writeChain = this.writeChain
            .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
            .then(async () => {
                const args: any = event.args && typeof event.args === 'object' ? event.args : {};
                const nested = event.tool === 'write_file' ? parseNestedWrite(args) : null;
                const effectivePath = nested?.path ?? args.path ?? args.file_path ?? null;
                const createdMs = Date.parse(String(event.createdAt ?? ''));
                const row = {
                    at: new Date().toISOString(),
                    stage: event.stage,
                    callId: event.callId,
                    tool: event.tool,
                    category: toolCategory(event.tool),
                    profile: event.profile,
                    inbound: event.inbound,
                    terminalWrite: event.terminalWrite,
                    inboundLagMs: Number.isFinite(createdMs) ? Math.max(0, event.receivedAtMs - createdMs) : null,
                    laneWaitMs: event.laneWaitMs ?? null,
                    toolMs: event.toolMs ?? null,
                    terminalMs: event.terminalMs ?? null,
                    totalMs: event.totalMs ?? null,
                    argsJsonBytes: jsonBytes(args),
                    outerContentBytes: utf8Bytes(args.content),
                    nestedContentBytes: utf8Bytes(nested?.content),
                    inputBytes: utf8Bytes(args.input),
                    oldTextBytes: utf8Bytes(args.old_string),
                    newTextBytes: utf8Bytes(args.new_string),
                    resultJsonBytes: jsonBytes(event.result),
                    resultTextBytes: resultTextBytes(event.result),
                    filePath: effectivePath,
                    fileBytes: event.stage === 'recv' ? null : await fileSize(effectivePath),
                };
                await fs.mkdir(path.dirname(this.filePath), { recursive: true });
                await fs.appendFile(this.filePath, JSON.stringify(row) + '\n', 'utf8');
            })
            .catch(() => { /* diagnostics never own execution */ });
    }

    async flush(): Promise<void> {
        await this.writeChain;
    }
}
