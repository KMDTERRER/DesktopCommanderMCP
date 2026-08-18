#!/usr/bin/env node

import { RemoteChannel } from './remote-channel.js';
import { SessionTokenOwner, type AuthSession } from './session-token-owner.js';
import { RemoteResultTransport } from './remote-result-transport.js';
import { RemoteRuntimeConfigStore, type RemoteRuntimeConfig } from './remote-runtime-config.js';
import { RemoteCallMetrics } from './remote-call-metrics.js';
import { createRemoteOutcomeIdentity, type RemoteResultDeliveryMode } from './remote-result-contract.js';
import { DeviceAuthenticator } from './device-authenticator.js';
import { DesktopCommanderIntegration } from './desktop-commander-integration.js';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { captureRemote } from '../utils/capture.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { renameReplacingWithRetry } from '../utils/atomic-rename.js';
import { isTransientHttpStatus, isTransientRemoteError } from './transient-remote-error.js';
import { RemoteResultOutbox, type RemoteResultOutboxEntry, type RemoteResultStatus } from './result-outbox.js';

const REMOTE_BOOTSTRAP_FETCH_TIMEOUT_MS = 15_000;
const REMOTE_BOOTSTRAP_FETCH_ATTEMPTS = 3;
const REMOTE_BOOTSTRAP_ATTEMPT_TIMEOUT_MS = 5_000;
const REMOTE_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 7_000;
const REMOTE_CONFIG_IO_TIMEOUT_MS = 10_000;
const REMOTE_CONFIG_MAX_BYTES = 1024 * 1024;

export interface MCPDeviceOptions {
    persistSession?: boolean;
    minimalLiveTest?: boolean;
}

/**
 * How many recently-handled call ids to remember for duplicate-delivery
 * suppression. The two transports deliver a call within MILLISECONDS of each
 * other, so this only has to outlive that window — 100 ids is several minutes
 * of even the heaviest agent traffic, and costs ~10 KB on the user's machine
 * (the device process, not the shared server).
 */
const SEEN_CALL_IDS_MAX = 100;
const RESULT_DELIVERY_CONCURRENCY = 8;
// Background replay must never consume every result slot or pre-enqueue an
// unbounded backlog ahead of fresh chat results. Three replay workers can drain
// failed results in parallel while leaving five slots for live chat delivery.
const RESULT_REPLAY_CONCURRENCY = 3;
const RESULT_DELIVERY_SLOT_WAIT_TIMEOUT_MS = 15_000;
// Emergency owner when both local fsync and immediate remote persistence fail.
// At capacity, stop claiming new side-effecting calls rather than risk replaying
// an already-completed call whose exact outcome exists only in memory.
const MAX_VOLATILE_OUTCOMES = 8;

type ResultDeliveryPriority = RemoteResultDeliveryMode;
type ResultDeliveryWaiter = {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
};

function remoteToolLogSummary(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { kind: Array.isArray(value) ? 'array' : typeof value };
    }
    const record = value as Record<string, unknown>;
    const content = Array.isArray(record.content) ? record.content : [];
    let textChars = 0;
    for (const item of content) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const text = (item as Record<string, unknown>).text;
        if (typeof text === 'string') textChars += text.length;
    }
    return {
        keys: Object.keys(record).slice(0, 16),
        contentItems: content.length,
        textChars,
        hasStructuredContent: record.structuredContent !== undefined,
        isError: record.isError === true,
    };
}

function operatorTraceToken(value: unknown, maxChars = 160): string {
    try {
        const rendered = typeof value === 'string' ? value : String(value ?? '');
        return rendered.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, maxChars);
    } catch {
        return 'unprintable';
    }
}

function mcpOperatorTarget(value: unknown): string | null {
    if (typeof value !== 'string' || !value.toLowerCase().startsWith('mcp://')) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'mcp:' || !url.hostname) return null;
        const tool = url.pathname.split('/').filter(Boolean)[0];
        const server = operatorTraceToken(url.hostname, 80);
        return tool ? `mcp://${server}/${operatorTraceToken(tool, 80)}` : `mcp://${server}`;
    } catch {
        return null;
    }
}

export function describeRemoteToolCall(toolName: unknown, toolArgs: unknown): string {
    const direct = operatorTraceToken(toolName || 'unknown-tool', 120);
    if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) return direct;
    const args = toolArgs as Record<string, unknown>;

    if (direct === 'mcp_call_tool') {
        const server = operatorTraceToken(args.server, 80);
        const tool = operatorTraceToken(args.tool, 80);
        if (server && tool) return `${direct} -> mcp://${server}/${tool}`;
    }
    if (direct === 'read_file' || direct === 'write_file') {
        const target = mcpOperatorTarget(args.path);
        if (target) return `${direct} -> ${target}`;
    }
    if (direct === 'read_multiple_files' && Array.isArray(args.paths)) {
        const targets = [...new Set(args.paths.map(mcpOperatorTarget).filter((value): value is string => Boolean(value)))];
        if (targets.length > 0) {
            const visible = targets.slice(0, 3).join(', ');
            const suffix = targets.length > 3 ? ` (+${targets.length - 3} more)` : '';
            return `${direct} -> ${visible}${suffix}`;
        }
    }
    return direct;
}

type RemoteToolTracePhase = 'RECV' | 'START' | 'OK' | 'FAIL';

function remoteToolTraceColorEnabled(): boolean {
    if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === '0') return false;
    if (process.env.FORCE_COLOR !== undefined) return true;
    return process.stderr.isTTY === true;
}

function colorizeRemoteToolTrace(text: string, ansiCode: string, enabled: boolean): string {
    return enabled ? `\u001b[${ansiCode}m${text}\u001b[0m` : text;
}

export function formatRemoteToolTrace(
    phase: RemoteToolTracePhase, callId: unknown, descriptor: string, elapsedMs?: number,
    colorEnabled = remoteToolTraceColorEnabled(),
): string {
    const id = operatorTraceToken(callId || 'unknown', 12);
    const style = phase === 'RECV'
        ? { glyph: '◆', color: '1;35' }
        : phase === 'START'
            ? { glyph: '▶', color: '1;36' }
            : phase === 'OK'
                ? { glyph: '✓', color: '1;32' }
                : { glyph: '✖', color: '1;31' };
    const prefix = colorizeRemoteToolTrace('[TOOL]', '1;34', colorEnabled);
    const phaseText = colorizeRemoteToolTrace(`${style.glyph} ${phase.padEnd(5)}`, style.color, colorEnabled);
    const callText = colorizeRemoteToolTrace(`call=${id}`, '2', colorEnabled);
    const elapsedText = elapsedMs === undefined
        ? ''
        : ` | ${colorizeRemoteToolTrace(`${Math.max(0, Math.round(elapsedMs))}ms`, '1;33', colorEnabled)}`;
    const descriptorText = colorizeRemoteToolTrace(descriptor, '1', colorEnabled);
    return `${prefix} ${phaseText} | ${callText}${elapsedText} | ${descriptorText}`;
}

function writeRemoteToolTrace(
    phase: RemoteToolTracePhase, callId: unknown, descriptor: string, elapsedMs?: number,
): void {
    if (process.env.DESKTOP_COMMANDER_REMOTE_TOOL_TRACE === 'false') return;
    try {
        process.stderr.write(`${formatRemoteToolTrace(phase, callId, descriptor, elapsedMs)}\n`);
    } catch {
        // Operator observability must never become an execution dependency.
    }
}

export class MCPDevice {
    private baseServerUrl: string;
    private tokenOwner: SessionTokenOwner;
    private remoteChannel: RemoteChannel;
    private resultTransport: RemoteResultTransport;
    private deviceId?: string;
    private isShuttingDown: boolean;
    private configPath: string;
    private persistSession: boolean;
    private minimalLiveTest: boolean;
    private runtimeConfig: RemoteRuntimeConfigStore | null;
    private runtimeHeartbeatTimer: NodeJS.Timeout | null = null;
    private callMetrics: RemoteCallMetrics;
    private minimalCallActive = 0;
    private minimalCallWaiters: Array<() => void> = [];
    private desktop: DesktopCommanderIntegration;
    private resultOutbox: RemoteResultOutbox;
    private resultOutboxFlushPromise: Promise<void> | null = null;
    private resultDeliveries = new Map<string, Promise<void>>();
    private volatileOutcomes = new Map<string, RemoteResultOutboxEntry>();
    private volatileDeliveries = new Map<string, Promise<void>>();
    private resultDeliveryActive = 0;
    private resultDeliveryLiveWaiters: ResultDeliveryWaiter[] = [];
    private resultDeliveryReplayWaiters: ResultDeliveryWaiter[] = [];
    private resultOutboxRetryTimer: NodeJS.Timeout | null = null;
    /** Serialize device.json writes so startup and token rotation cannot reorder. */
    private configWriteChain: Promise<void> = Promise.resolve();
    /** Call ids already handled by THIS process (insertion-ordered, bounded). */
    private seenCallIds: Set<string> = new Set();
    /** Claims currently being established; suppresses simultaneous dual-transport delivery. */
    private inFlightCallIds: Set<string> = new Set();
    /** Process-global signal hooks belong to the started lifecycle, not construction. */
    private shutdownSignalHandlers: { sigint: () => void; sigterm: () => void } | null = null;

    constructor(options: MCPDeviceOptions = {}) {
        this.baseServerUrl = process.env.MCP_SERVER_URL || 'https://mcp.desktopcommander.app';
        this.tokenOwner = new SessionTokenOwner();
        this.minimalLiveTest = options.minimalLiveTest === true;
        this.remoteChannel = new RemoteChannel(this.tokenOwner, this.minimalLiveTest);
        this.resultTransport = new RemoteResultTransport(this.tokenOwner);
        this.runtimeConfig = this.minimalLiveTest
            ? new RemoteRuntimeConfigStore(
                process.env.DC_REMOTE_RUNTIME_CONFIG
                    || path.join(os.homedir(), '.desktop-commander-device', 'remote-runtime.json')
            )
            : null;
        this.callMetrics = new RemoteCallMetrics(
            process.env.DC_REMOTE_METRICS_LOG
                || path.join(os.homedir(), '.desktop-commander-device', 'remote-call-metrics.jsonl')
        );
        this.runtimeConfig?.subscribe((config) => {
            this.scheduleRuntimeHeartbeat();
            this.drainMinimalCallWaiters();
            if (this.deviceId) {
                void this.remoteChannel.setMinimalInboundMode(config.inbound).catch((error: any) => {
                    console.warn(`⚠ Inbound hot-switch failed; keeping current channel: ${error?.message || error}`);
                });
            }
        });
        this.deviceId = undefined;
        this.isShuttingDown = false;
        this.configPath = path.join(os.homedir(), '.desktop-commander-device', 'device.json');
        this.persistSession = options.persistSession || false;
        this.resultOutbox = new RemoteResultOutbox(
            path.join(path.dirname(this.configPath), 'result-outbox')
        );
        this.tokenOwner.subscribe((session) => {
            if (!this.persistSession || !session) return;
            const persistedSession: AuthSession = {
                access_token: session.access_token,
                refresh_token: session.refresh_token,
                ...(session.device_id ? { device_id: session.device_id } : {}),
            };
            void this.savePersistedConfig(persistedSession);
        });

        // Initialize desktop integration. Construction itself must stay process-lifecycle neutral.
        this.desktop = new DesktopCommanderIntegration();
    }

    private scheduleRuntimeHeartbeat(): void {
        if (this.runtimeHeartbeatTimer) {
            clearTimeout(this.runtimeHeartbeatTimer);
            this.runtimeHeartbeatTimer = null;
        }
        if (!this.minimalLiveTest || !this.runtimeConfig || !this.deviceId || this.isShuttingDown) return;
        const intervalMs = this.runtimeConfig.current().heartbeatMs;
        if (intervalMs <= 0) return;
        this.runtimeHeartbeatTimer = setTimeout(async () => {
            try { await this.remoteChannel.updateHeartbeat(this.deviceId!); }
            finally { this.scheduleRuntimeHeartbeat(); }
        }, intervalMs);
        this.runtimeHeartbeatTimer.unref?.();
    }

    private stopRuntimeHeartbeat(): void {
        if (this.runtimeHeartbeatTimer) clearTimeout(this.runtimeHeartbeatTimer);
        this.runtimeHeartbeatTimer = null;
    }

    private shouldSignalResult(): boolean {
        return !this.minimalLiveTest || this.runtimeConfig?.current().resultWake === true;
    }

    private setupShutdownHandlers() {
        if (this.shutdownSignalHandlers) return;

        const handleShutdown = async (signal: string) => {
            if (this.isShuttingDown) {
                console.log(`\n${signal} received, but already shutting down...`);
                // Force exit if we get multiple signals
                process.exit(1);
                return;
            }

            console.log(`\n${signal} received, initiating graceful shutdown...`);

            // Final bound: local MCP teardown gets priority, then remote offline cleanup.
            const forceExit = setTimeout(() => {
                console.error('\n⚠️ Graceful shutdown timed out, forcing exit...');
                process.exit(1);
            }, REMOTE_GRACEFUL_SHUTDOWN_TIMEOUT_MS);

            try {
                await this.shutdown();
                clearTimeout(forceExit);
                process.exit(0);
            } catch (error) {
                console.error('Error during shutdown:', error);
                await captureRemote('remote_device_shutdown_handler_error', { error });
                process.exit(1);
            }
        };

        // Remove any existing SIGINT/SIGTERM listeners to prevent default behavior
        // process.removeAllListeners('SIGINT');
        // process.removeAllListeners('SIGTERM');

        const sigint = () => {
            handleShutdown('SIGINT').catch((error) => {
                console.error('Fatal error during shutdown:', error);
                captureRemote('remote_device_shutdown_handler_error', { error, signal: 'SIGINT' }).catch(() => { });
                process.exit(1);
            });
        };
        const sigterm = () => {
            handleShutdown('SIGTERM').catch((error) => {
                console.error('Fatal error during shutdown:', error);
                captureRemote('remote_device_shutdown_handler_error', { error, signal: 'SIGTERM' }).catch(() => { });
                process.exit(1);
            });
        };

        this.shutdownSignalHandlers = { sigint, sigterm };
        process.on('SIGINT', sigint);
        process.on('SIGTERM', sigterm);
    }

    private removeShutdownHandlers() {
        const handlers = this.shutdownSignalHandlers;
        if (!handlers) return;
        process.off('SIGINT', handlers.sigint);
        process.off('SIGTERM', handlers.sigterm);
        this.shutdownSignalHandlers = null;
    }

    async start() {
        try {
            this.setupShutdownHandlers();
            console.log('🚀 Starting MCP Device...');
            if (process.env.DEBUG_MODE === 'true') {
                console.log(`  - 🐞 DEBUG_MODE`);
            }


            // Initialize desktop integration
            await this.desktop.initialize();
            if (this.runtimeConfig) await this.runtimeConfig.initialize();

            console.log(`⏳ Connecting to Remote MCP ${this.baseServerUrl}`);
            const { supabaseUrl, anonKey } = await this.fetchSupabaseConfig();
            console.log(`   - 🔌 Connected to Remote MCP`);

            // Result transport has no Auth lifecycle or Realtime socket; in test
            // mode it is also the owner of minimal/raw DB write variants.
            this.remoteChannel.initialize(supabaseUrl, anonKey);
            this.resultTransport.initialize(supabaseUrl, anonKey);

            // Load persisted configuration (deviceId, session)
            let session = await this.loadPersistedConfig();

            // 2. Set Session or Authenticate
            if (session) {
                const { error } = await this.remoteChannel.setSession(session);

                if (error) {
                    console.log('   - ⚠️ Persisted session invalid:', error.message);
                    session = null;
                } else {
                    console.log('   - ✅ Session restored');
                }
            }

            if (!session) {
                console.log('\n🔐 Authenticating with Remote MCP server...');
                const authenticator = new DeviceAuthenticator(this.baseServerUrl);
                session = await authenticator.authenticate(this.deviceId);
                if (session.device_id) {
                    if (!this.deviceId) {
                        await captureRemote('remote_device_auth_success', {
                            "device": "assigned"
                        });
                        console.log(`   - ✅ Device ID assigned: ${session.device_id}`);
                    } else if (this.deviceId !== session.device_id) {
                        await captureRemote('remote_device_auth_success', {
                            "device": "changed"
                        });
                        console.log(`   - ⚠️ Device ID changed: ${this.deviceId} → ${session.device_id}`);
                    } else {
                        await captureRemote('remote_device_auth_success', {
                            "device": "authenticated"
                        });
                        console.log(`   - ✅ Device ID authenticated: ${session.device_id}`);
                    }
                    this.deviceId = session.device_id;
                }
                // Set session in Remote Channel
                const { error } = await this.remoteChannel.setSession(session);
                if (error) throw error;
            }

            // Force save the current session immediately to ensure it's persisted
            await this.savePersistedConfig();

            const deviceName = os.hostname();

            // Register as device
            await this.remoteChannel.registerDevice(
                await this.desktop.listClientTools(),
                this.deviceId,
                deviceName,
                (payload: any) => this.handleNewToolCall(payload)
            );
            if (this.minimalLiveTest && this.runtimeConfig) {
                await this.remoteChannel.setMinimalInboundMode(this.runtimeConfig.current().inbound);
            }
            if (!this.minimalLiveTest) {
                this.desktop.setToolsChangedHandler(async () => {
                    if (!this.deviceId || this.isShuttingDown) return;
                    const capabilities = await this.desktop.listClientTools();
                    await this.remoteChannel.refreshDeviceCapabilities(capabilities);
                });

                this.startResultOutboxRetry();
                void this.scheduleResultOutboxFlush().catch((error) => {
                    console.error('[DEBUG] Initial result outbox flush failed:', error?.message);
                });
            } else {
                console.log('⚡ Minimal live transport test: postgres_changes → tool → terminal UPDATE');
            }

            console.log('✅ Device ready:');
            console.log(`   - User:         ${this.remoteChannel.user!.email}`);
            console.log(`   - Device ID:    ${this.deviceId}`);
            console.log(`   - Device Name:  ${deviceName}`);

            // Production keeps the normal tier-aware heartbeat. Test mode uses
            // the hot-configured minimal lease so it remains reachable during long A/B runs.
            if (this.minimalLiveTest) this.scheduleRuntimeHeartbeat();
            else this.remoteChannel.startHeartbeat(this.deviceId!);

        } catch (error: any) {
            console.error(' - ❌ Device startup failed:', error.message);
            if (error.stack && process.env.DEBUG_MODE === 'true') {
                console.error('Stack trace:', error.stack);
            }
            await captureRemote('remote_device_startup_failed', { error });
            await this.shutdown();
            process.exit(1);
        }
    }


    private async readPersistedConfigData(): Promise<any> {
        const data = await runWithAbortableTimeout(
            (signal) => fs.readFile(this.configPath, { encoding: 'utf8', signal }),
            REMOTE_CONFIG_IO_TIMEOUT_MS,
            `Read persisted device config ${this.configPath}`
        );
        const bytes = Buffer.byteLength(data, 'utf8');
        if (bytes > REMOTE_CONFIG_MAX_BYTES) {
            const error = new Error(`Persisted device config exceeds ${REMOTE_CONFIG_MAX_BYTES} bytes`) as NodeJS.ErrnoException;
            error.code = 'EFBIG';
            throw error;
        }
        return JSON.parse(data);
    }

    async loadPersistedConfig() {
        try {
            console.debug('[DEBUG] Loading persisted config from:', this.configPath);
            const config = await this.readPersistedConfigData();

            this.deviceId = config?.deviceId;
            console.debug('[DEBUG] Loaded device ID:', this.deviceId);

            console.log('💾 Found persisted session for device ' + this.deviceId);
            if (config.session) {
                console.debug('[DEBUG] Session found in config, returning session');
                return config.session;
            }

            console.debug('[DEBUG] No session in config');
            return null;
        } catch (error: any) {

            if (error.code !== 'ENOENT') {
                console.warn('⚠️ Failed to load config:', error.message);
                await captureRemote('remote_device_config_load_error', { error });
            } else {
                console.debug('[DEBUG] Config file does not exist (ENOENT)');
            }
            return null;
        } finally {
            // No need to ensure device ID here
        }
    }

    async savePersistedConfig(sessionOverride?: AuthSession) {
        const write = async () => {
            try {
                console.debug('[DEBUG] Saving persisted config, persistSession:', this.persistSession);
                let session: AuthSession | null = null;

                if (this.persistSession) {
                    if (sessionOverride) {
                        session = sessionOverride;
                    } else {
                        session = this.remoteChannel.getCachedSessionSnapshot();
                    }
                } else {
                    // A one-off non-persistent run must never erase credentials saved by
                    // an earlier --persist-session run. Preserve the existing snapshot.
                    try {
                        const existing = await this.readPersistedConfigData();
                        session = existing?.session ?? null;
                    } catch (readError: any) {
                        if (readError?.code !== 'ENOENT') throw readError;
                    }
                }

                const config = { deviceId: this.deviceId, session };
                const configDir = path.dirname(this.configPath);
                await runWithAbortableTimeout(
                    async (_signal) => { await fs.mkdir(configDir, { recursive: true }); },
                    REMOTE_CONFIG_IO_TIMEOUT_MS,
                    `Create persisted device config directory ${configDir}`
                );
                const tempPath = path.join(
                    configDir,
                    `.device.json.${process.pid}.${Date.now()}.tmp`
                );
                try {
                    // Write a complete sibling first, then replace by rename. A
                    // process crash can leave a temp file, but not half a JSON target.
                    await runWithAbortableTimeout(
                        (signal) => fs.writeFile(tempPath, JSON.stringify(config, null, 2), { mode: 0o600, signal }),
                        REMOTE_CONFIG_IO_TIMEOUT_MS,
                        `Write persisted device config temp ${tempPath}`
                    );
                    await renameReplacingWithRetry(tempPath, this.configPath, {
                        deadlineAt: Date.now() + REMOTE_CONFIG_IO_TIMEOUT_MS
                    });
                } finally {
                    await runWithAbortableTimeout(
                        async (_signal) => { await fs.rm(tempPath, { force: true }); },
                        REMOTE_CONFIG_IO_TIMEOUT_MS,
                        `Clean persisted device config temp ${tempPath}`
                    ).catch(() => {});
                }
                console.debug('[DEBUG] Config saved to:', this.configPath);
            } catch (error: any) {
                console.error(' - ❌ Failed to save config:', error.message);
                console.debug('[DEBUG] Config save error details:', error);
                await captureRemote('remote_device_config_save_error', { error });
            }
        };

        const queued = this.configWriteChain.then(write, write);
        // Keep the actual write serialized even if the caller's response deadline expires.
        // In particular, a late atomic rename must never race a newer token snapshot.
        this.configWriteChain = queued.catch(() => { /* write already reports its error */ });
        try {
            await runWithAbortableTimeout(
                (_signal) => queued,
                REMOTE_CONFIG_IO_TIMEOUT_MS,
                `Persist remote device config ${this.configPath}`
            );
        } catch (error: any) {
            console.warn(' - ⚠️ Persisted config write exceeded response deadline; serialized write remains owned by the config queue:', error.message);
            await captureRemote('remote_device_config_save_timeout', { error });
        }
    }

    async fetchSupabaseConfig() {
        // GET is idempotent, so transient transport/5xx failures may be retried
        // within one absolute startup budget. Deterministic HTTP/JSON errors fail fast.
        console.debug('[DEBUG] Fetching Supabase config from:', `${this.baseServerUrl}/api/mcp-info`);
        const deadline = Date.now() + REMOTE_BOOTSTRAP_FETCH_TIMEOUT_MS;
        let lastError: any = null;

        for (let attempt = 1; attempt <= REMOTE_BOOTSTRAP_FETCH_ATTEMPTS; attempt++) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            try {
                const response = await runWithAbortableTimeout(
                    (signal) => fetch(`${this.baseServerUrl}/api/mcp-info`, { signal }),
                    Math.max(100, Math.min(REMOTE_BOOTSTRAP_ATTEMPT_TIMEOUT_MS, remaining)),
                    `Remote MCP bootstrap config fetch attempt ${attempt}`
                );

                if (response.ok) {
                    const config = await response.json();
                    console.debug('[DEBUG] Supabase config received, URL:', config.supabaseUrl?.substring(0, 30) + '...');
                    return {
                        supabaseUrl: config.supabaseUrl,
                        anonKey: config.supabasePublishableKey
                    };
                }

                lastError = Object.assign(
                    new Error(`Failed to fetch Supabase config: ${response.statusText || response.status}`),
                    { status: response.status },
                );
                if (!isTransientHttpStatus(response.status)) throw lastError;
            } catch (error: any) {
                lastError = error;
                if (!isTransientRemoteError(error)) throw error;
            }

            if (attempt < REMOTE_BOOTSTRAP_FETCH_ATTEMPTS) {
                const backoffMs = 200 * attempt;
                if (deadline - Date.now() <= backoffMs) break;
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
        }

        throw lastError ?? Object.assign(
            new Error('Remote MCP bootstrap config fetch timed out'),
            { code: 'ETIMEDOUT' },
        );
    }

    // Methods moved to RemoteChannel

    private scheduleResultOutboxFlush(): Promise<void> {
        if (this.resultOutboxFlushPromise) return this.resultOutboxFlushPromise;
        let current!: Promise<void>;
        current = this.flushResultOutbox().finally(() => {
            if (this.resultOutboxFlushPromise === current) this.resultOutboxFlushPromise = null;
        });
        this.resultOutboxFlushPromise = current;
        return current;
    }

    private releaseResultDeliverySlot(): void {
        // Transfer the occupied slot directly to the highest-priority waiter.
        // Do not decrement then wake: a fresh caller could observe the temporary
        // gap and oversubscribe the concurrency limit before the waiter resumes.
        const waiter = this.resultDeliveryLiveWaiters.shift() ?? this.resultDeliveryReplayWaiters.shift();
        if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve();
            return;
        }
        this.resultDeliveryActive = Math.max(0, this.resultDeliveryActive - 1);
    }

    private async acquireResultDeliverySlot(
        priority: ResultDeliveryPriority,
        timeoutMs = RESULT_DELIVERY_SLOT_WAIT_TIMEOUT_MS,
    ): Promise<() => void> {
        if (this.resultDeliveryActive < RESULT_DELIVERY_CONCURRENCY) {
            this.resultDeliveryActive += 1;
        } else {
            await new Promise<void>((resolve, reject) => {
                const queue = priority === 'live' ? this.resultDeliveryLiveWaiters : this.resultDeliveryReplayWaiters;
                let waiter!: ResultDeliveryWaiter;
                const timer = setTimeout(() => {
                    const index = queue.indexOf(waiter);
                    if (index >= 0) queue.splice(index, 1);
                    const error = new Error(`Timed out waiting for a ${priority} result-delivery slot after ${timeoutMs}ms`) as NodeJS.ErrnoException;
                    error.code = 'ETIMEDOUT';
                    reject(error);
                }, timeoutMs);
                timer.unref?.();
                waiter = { resolve, reject, timer };
                queue.push(waiter);
            });
            // A release transferred an already-counted active slot to us.
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.releaseResultDeliverySlot();
        };
    }

    private deliverResultOutboxEntry(
        entry: RemoteResultOutboxEntry, priority: ResultDeliveryPriority = 'live',
    ): Promise<void> {
        const existing = this.resultDeliveries.get(entry.callId);
        if (existing) return existing;

        let delivery!: Promise<void>;
        delivery = (async () => {
            const release = await this.acquireResultDeliverySlot(priority);
            try {
                // The outbox owns only persistence of the exact terminal outcome.
                // Once the database confirms it, retire the local retry entry BEFORE
                // notification so an unconfirmed wake-up can never create an
                // unbounded notification loop. Server-side recovery owns resume.
                const terminalCommitStartedAt = Date.now();
                await this.resultTransport.updateCallResult(
                    entry.callId, entry.status, entry.result, entry.errorMessage, entry.claimToken, priority, {
                        outcomeRevision: entry.outcomeRevision, outcomeHash: entry.outcomeHash, claimMetadata: entry.claimMetadata,
                    }
                );
                console.log(`↗ RESULT COMMIT ${entry.callId.slice(0, 8)} ${Date.now() - terminalCommitStartedAt}ms`);
                this.remoteChannel.releaseCallClaim(entry.callId);

                // Terminal persistence is the handoff boundary. Wake the server
                // immediately, then retire the local replay copy independently;
                // neither wake acknowledgement nor filesystem cleanup owns this slot.
                if (this.shouldSignalResult()) this.remoteChannel.signalResultAvailable(entry.callId);
                void this.resultOutbox.remove(entry.callId).catch((cleanupError: any) => {
                    if (process.env.DEBUG_MODE === 'true') {
                        console.debug(`[DEBUG] Deferred result outbox cleanup for ${entry.callId}:`, cleanupError?.message);
                    }
                });
            } finally {
                release();
            }
        })().finally(() => {
            if (this.resultDeliveries.get(entry.callId) === delivery) {
                this.resultDeliveries.delete(entry.callId);
            }
        });

        this.resultDeliveries.set(entry.callId, delivery);
        return delivery;
    }

    private deliverVolatileOutcome(
        entry: RemoteResultOutboxEntry, priority: ResultDeliveryPriority = 'live',
    ): Promise<void> {
        const existing = this.volatileDeliveries.get(entry.callId);
        if (existing) return existing;
        let delivery!: Promise<void>;
        delivery = (async () => {
            const release = await this.acquireResultDeliverySlot(priority);
            try {
                try {
                    await this.resultTransport.updateCallResult(
                        entry.callId, entry.status, entry.result, entry.errorMessage, entry.claimToken, priority, {
                            outcomeRevision: entry.outcomeRevision, outcomeHash: entry.outcomeHash, claimMetadata: entry.claimMetadata,
                        }
                    );
                    this.remoteChannel.releaseCallClaim(entry.callId);
                } catch (error: any) {
                    if (error?.code === 'EREMOTECALLGONE') {
                        this.volatileOutcomes.delete(entry.callId);
                        return;
                    }
                    throw error;
                }
                // Remote terminal persistence is authoritative. Notification is
                // best-effort acceleration and must not retain the delivery slot.
                this.volatileOutcomes.delete(entry.callId);
                if (this.shouldSignalResult()) this.remoteChannel.signalResultAvailable(entry.callId);
            } finally {
                release();
            }
        })().finally(() => {
            if (this.volatileDeliveries.get(entry.callId) === delivery) {
                this.volatileDeliveries.delete(entry.callId);
            }
        });
        this.volatileDeliveries.set(entry.callId, delivery);
        return delivery;
    }

    private async flushResultOutbox(): Promise<void> {
        // Recover exact outcomes that currently exist only in memory. Prefer
        // restoring disk durability; if local storage is still unavailable, a
        // confirmed remote terminal write is enough to retire the volatile copy.
        for (const entry of [...this.volatileOutcomes.values()]) {
            try {
                await this.resultOutbox.put(entry);
                this.volatileOutcomes.delete(entry.callId);
                void this.deliverResultOutboxEntry(entry, 'replay').catch(() => {});
            } catch {
                try {
                    await this.deliverVolatileOutcome(entry, 'replay');
                } catch { /* keep the exact outcome for the next retry */ }
            }
        }

        const currentUserId = this.remoteChannel.getCurrentUserId();
        if (!currentUserId) return;
        const entries = (await this.resultOutbox.list(currentUserId))
            .filter((entry) => entry.userId === currentUserId);

        let nextEntry = 0;
        const worker = async () => {
            while (nextEntry < entries.length) {
                const entry = entries[nextEntry++];
                try {
                    await this.deliverResultOutboxEntry(entry, 'replay');
                } catch (error: any) {
                    if (error?.code === 'EREMOTECALLGONE') {
                        await this.resultOutbox.remove(entry.callId);
                        if (process.env.DEBUG_MODE === 'true') {
                            console.debug(`[DEBUG] Removed retired result outbox entry ${entry.callId}`);
                        }
                        continue;
                    }
                    if (process.env.DEBUG_MODE === 'true') {
                        console.debug(`[DEBUG] Result outbox delivery deferred for ${entry.callId}:`, error?.message);
                    }
                }
            }
        };
        const workers = Math.min(RESULT_REPLAY_CONCURRENCY, entries.length);
        await Promise.all(Array.from({ length: workers }, () => worker()));
    }

    private startResultOutboxRetry(): void {
        if (this.resultOutboxRetryTimer) return;
        this.resultOutboxRetryTimer = setInterval(() => {
            void this.scheduleResultOutboxFlush().catch(() => {});
        }, 10_000);
        this.resultOutboxRetryTimer.unref?.();
    }

    private stopResultOutboxRetry(): void {
        if (!this.resultOutboxRetryTimer) return;
        clearInterval(this.resultOutboxRetryTimer);
        this.resultOutboxRetryTimer = null;
    }

    private async persistToolOutcome(
        callId: string,
        status: RemoteResultStatus,
        result: unknown | null,
        errorMessage: string | null,
    ): Promise<void> {
        const claimToken = this.remoteChannel.getCallClaimToken(callId);
        if (!claimToken) throw new Error(`No claim token available for result outbox entry ${callId}`);
        const userId = this.remoteChannel.getCurrentUserId();
        if (!userId) throw new Error(`No authenticated user available for result outbox entry ${callId}`);
        const claimMetadata = this.remoteChannel.getCallClaimMetadata(callId) ?? undefined;
        const identity = createRemoteOutcomeIdentity(status, result, errorMessage);
        const entry: RemoteResultOutboxEntry = {
            version: 1, callId, userId, claimToken, claimMetadata,
            outcomeRevision: identity.outcomeRevision, outcomeHash: identity.outcomeHash,
            status, result: identity.result, errorMessage: identity.errorMessage,
            createdAt: new Date().toISOString(),
        };

        // Install an emergency owner before the first persistence await. Remove it
        // only after either local fsync or confirmed remote terminal persistence.
        this.volatileOutcomes.set(callId, entry);
        try {
            await this.resultOutbox.put(entry);
            this.volatileOutcomes.delete(callId);
        } catch (spoolError: any) {
            console.error(`[DEBUG] Could not persist local result outbox entry ${callId}:`, spoolError?.message);
            await this.resultTransport.updateCallResult(
                callId, status, identity.result, identity.errorMessage, claimToken, 'live', {
                    outcomeRevision: identity.outcomeRevision, outcomeHash: identity.outcomeHash, claimMetadata,
                }
            );
            this.remoteChannel.releaseCallClaim(callId);
            this.volatileOutcomes.delete(callId);
            if (this.shouldSignalResult()) this.remoteChannel.signalResultAvailable(callId);
            return;
        }

        // Local fsync is the handler's completion boundary. Remote persistence is
        // deliberately detached: a healthy connection still gets an immediate
        // short live attempt, while a slow/outage path cannot consume the caller's
        // remaining request deadline or head-of-line block a parallel chat. The
        // exact result stays in the outbox until a later acknowledged replay.
        void this.deliverResultOutboxEntry(entry, 'live').catch((deliveryError: any) => {
            if (process.env.DEBUG_MODE === 'true') {
                console.debug(
                    `[DEBUG] Outcome ${callId} persisted locally; remote delivery deferred:`,
                    deliveryError?.message,
                );
            }
            captureRemote('remote_device_result_delivery_deferred', {
                error: deliveryError?.message, call_id: callId, status,
            }).catch(() => {});
            void this.scheduleResultOutboxFlush().catch(() => {});
        });
    }

    private async acquireMinimalCallLane(limit: number): Promise<() => void> {
        if (this.minimalCallActive < limit) {
            this.minimalCallActive += 1;
        } else {
            await new Promise<void>((resolve) => this.minimalCallWaiters.push(resolve));
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.minimalCallActive = Math.max(0, this.minimalCallActive - 1);
            this.drainMinimalCallWaiters();
        };
    }

    private drainMinimalCallWaiters(): void {
        const limit = this.runtimeConfig?.current().maxParallelCalls ?? 1;
        while (this.minimalCallWaiters.length > 0 && this.minimalCallActive < limit) {
            this.minimalCallActive += 1;
            this.minimalCallWaiters.shift()?.();
        }
    }

    /** Record a handled call id, evicting the oldest once the cap is reached. */
    private rememberCallId(callId: string) {
        this.seenCallIds.add(callId);
        if (this.seenCallIds.size > SEEN_CALL_IDS_MAX) {
            // Sets iterate in insertion order — drop the oldest entry.
            const oldest = this.seenCallIds.values().next().value;
            if (oldest !== undefined) this.seenCallIds.delete(oldest);
        }
    }

    private async handleMinimalLiveToolCall(
        payload: any, policy: RemoteRuntimeConfig, receivedAtMs: number, laneWaitMs: number,
    ): Promise<void> {
        const toolCall = payload?.new;
        if (!toolCall) return;
        const { id: call_id, tool_name, tool_args, device_id, metadata = {}, created_at } = toolCall;
        if (device_id && device_id !== this.deviceId) return;
        if (this.seenCallIds.has(call_id)) return;
        this.rememberCallId(call_id);
        this.callMetrics.record({
            stage: 'recv', callId: call_id, tool: tool_name, args: tool_args,
            profile: policy.profile, inbound: policy.inbound, terminalWrite: policy.terminalWrite,
            receivedAtMs, createdAt: created_at, laneWaitMs,
        });

        const descriptor = describeRemoteToolCall(tool_name, tool_args);
        if (policy.diagnostics) {
            const createdMs = Date.parse(String(created_at ?? ''));
            if (Number.isFinite(createdMs)) {
                console.log(`↘ INBOUND ${policy.inbound} ${call_id.slice(0, 8)} ${Math.max(0, Date.now() - createdMs)}ms`);
            }
            writeRemoteToolTrace('RECV', call_id, descriptor);
        }

        const executingStartedAt = Date.now();
        let fencedClaim = false;
        if (policy.executingWrite === 'simple') {
            await this.resultTransport.markCallExecutingSimple(call_id);
        } else if (policy.executingWrite === 'raw') {
            await this.resultTransport.markCallExecutingRaw(call_id);
        } else if (policy.executingWrite === 'fenced') {
            fencedClaim = await this.remoteChannel.markCallExecuting(call_id, metadata);
            if (!fencedClaim) return;
        }
        if (policy.diagnostics) {
            console.log(`↗ DB EXEC ${policy.executingWrite} ${call_id.slice(0, 8)} ${Date.now() - executingStartedAt}ms`);
        }

        const startedAt = Date.now();
        if (policy.diagnostics) writeRemoteToolTrace('START', call_id, descriptor);
        let status: RemoteResultStatus = 'completed';
        let result: unknown | null = null;
        let errorMessage: string | null = null;
        let shutdownRequested = false;
        try {
            if (tool_name === 'ping') {
                result = { content: [{ type: 'text', text: `pong ${new Date().toISOString()}` }] };
            } else if (tool_name === 'shutdown') {
                result = { content: [{ type: 'text', text: `Shutdown initialized at ${new Date().toISOString()}` }] };
                shutdownRequested = true;
            } else {
                result = await this.desktop.callClientTool(tool_name, tool_args, metadata);
            }
        } catch (error: any) {
            status = 'failed';
            errorMessage = error?.message ?? String(error);
            console.error(`❌ Tool call ${tool_name} failed:`, errorMessage);
        }
        const toolMs = Date.now() - startedAt;
        if (policy.diagnostics) {
            writeRemoteToolTrace(status === 'completed' ? 'OK' : 'FAIL', call_id, descriptor, toolMs);
        }
        this.callMetrics.record({
            stage: 'tool_done', callId: call_id, tool: tool_name, args: tool_args, result,
            profile: policy.profile, inbound: policy.inbound, terminalWrite: policy.terminalWrite,
            receivedAtMs, createdAt: created_at, laneWaitMs, toolMs, totalMs: Date.now() - receivedAtMs,
        });

        const terminalStartedAt = Date.now();
        if (policy.outbox) {
            await this.persistToolOutcome(call_id, status, result, errorMessage);
        } else if (policy.terminalWrite === 'simple') {
            await this.resultTransport.updateCallResultSimple(call_id, status, result, errorMessage);
        } else if (policy.terminalWrite === 'raw') {
            await this.resultTransport.updateCallResultRaw(call_id, status, result, errorMessage);
        } else {
            const claimToken = this.remoteChannel.getCallClaimToken(call_id);
            if (!claimToken || !fencedClaim) throw new Error(`Missing fenced claim for terminal write ${call_id}`);
            const claimMetadata = this.remoteChannel.getCallClaimMetadata(call_id) ?? undefined;
            const identity = createRemoteOutcomeIdentity(status, result, errorMessage);
            await this.resultTransport.updateCallResult(
                call_id, status, identity.result, identity.errorMessage, claimToken, 'live', {
                    outcomeRevision: identity.outcomeRevision,
                    outcomeHash: identity.outcomeHash,
                    claimMetadata,
                },
            );
        }
        if (!policy.outbox && fencedClaim) this.remoteChannel.releaseCallClaim(call_id);
        if (policy.resultWake && !policy.outbox) this.remoteChannel.signalResultAvailable(call_id);
        const terminalMs = Date.now() - terminalStartedAt;
        if (policy.diagnostics) {
            const stage = policy.outbox ? 'OUTBOX' : `DB TERMINAL ${policy.terminalWrite}`;
            console.log(`↗ ${stage} ${call_id.slice(0, 8)} ${terminalMs}ms`);
        }
        this.callMetrics.record({
            stage: 'terminal_done', callId: call_id, tool: tool_name, args: tool_args, result,
            profile: policy.profile, inbound: policy.inbound, terminalWrite: policy.terminalWrite,
            receivedAtMs, createdAt: created_at, laneWaitMs, toolMs, terminalMs, totalMs: Date.now() - receivedAtMs,
        });

        if (shutdownRequested) {
            setTimeout(async () => {
                await this.shutdown();
                process.exit(0);
            }, 1000);
        }
    }

    async handleNewToolCall(payload: any) {
        if (this.minimalLiveTest) {
            const receivedAtMs = Date.now();
            const policy = this.runtimeConfig?.current();
            if (!policy) throw new Error('Remote runtime config is unavailable in minimal live mode');
            const releaseLane = await this.acquireMinimalCallLane(policy.maxParallelCalls);
            const laneWaitMs = Date.now() - receivedAtMs;
            try {
                await this.handleMinimalLiveToolCall(payload, policy, receivedAtMs, laneWaitMs);
            } finally {
                releaseLane();
            }
            return;
        }
        const toolCall = payload.new;
        // Expect toolCall to include a device_id field used to route calls to this device instance.
        const { id: call_id, tool_name, tool_args, device_id, metadata = {} } = toolCall;

        // Only process jobs for this device. Verbose routing diagnostics stay
        // behind DEBUG_MODE; the clean operator trace below is emitted only
        // after this process has actually won execution ownership.
        if (device_id && device_id !== this.deviceId) {
            if (process.env.DEBUG_MODE === 'true') {
                console.debug('[DEBUG] Ignoring tool call for different device');
            }
            return;
        }

        if (process.env.DEBUG_MODE === 'true') {
            console.debug(`[DEBUG] Received tool call ${call_id}: ${tool_name}`, {
                device_id,
                thisDeviceId: this.deviceId,
                toolArgKeys: tool_args && typeof tool_args === 'object' && !Array.isArray(tool_args)
                    ? Object.keys(tool_args).slice(0, 24) : [],
                metadataKeys: metadata && typeof metadata === 'object' && !Array.isArray(metadata)
                    ? Object.keys(metadata).slice(0, 24) : [],
            });
        }

        // LOCAL claim first — this is the authoritative guard against executing
        // a call twice. During the transition both transports deliver every call
        // to THIS SAME PROCESS, so an in-memory check is sufficient and, unlike
        // the DB claim below, cannot fail open: a transient REST error made
        // markCallExecuting return true for both deliveries, which could run a
        // side-effecting command twice (found in review, 2026-07-24).
        if (this.seenCallIds.has(call_id)) {
            console.debug('[DEBUG] Duplicate delivery for call already handled here, replaying its pending outcome if needed:', call_id);
            try {
                const volatile = this.volatileOutcomes.get(call_id);
                if (volatile) {
                    await this.deliverVolatileOutcome(volatile);
                    return;
                }
                const pending = await this.resultOutbox.get(call_id);
                if (pending) await this.deliverResultOutboxEntry(pending);
            } catch (replayError: any) {
                console.debug(`[DEBUG] Deferred duplicate result replay for ${call_id}:`, replayError?.message);
            }
            return;
        }
        if (this.inFlightCallIds.has(call_id)) {
            console.debug('[DEBUG] Duplicate delivery while claim is in flight, skipping:', call_id);
            return;
        }
        if (this.volatileOutcomes.size >= MAX_VOLATILE_OUTCOMES) {
            // Fail closed before ownership/execution. Leaving the DB row pending
            // lets normal redelivery retry after durability recovers.
            console.error(`❌ Volatile outcome capacity reached; deferring unclaimed call ${call_id}.`);
            captureRemote('remote_device_volatile_outcome_capacity', {
                pending: this.volatileOutcomes.size, tool_name, call_id
            }).catch(() => {});
            return;
        }

        const operatorDescriptor = describeRemoteToolCall(tool_name, tool_args);
        writeRemoteToolTrace('RECV', call_id, operatorDescriptor);

        this.inFlightCallIds.add(call_id);
        let claimed = false;
        try {
            claimed = await this.remoteChannel.markCallExecuting(call_id, metadata);
        } catch (claimError: any) {
            // Ownership was not established. Do not execute and do not write a
            // terminal result for a row another process may own. Because the id
            // is not remembered, a later redelivery can safely retry the claim.
            console.error(`❌ Could not establish claim ownership for ${call_id}:`, claimError?.message);
            try {
                await captureRemote('remote_device_tool_call_claim_failed', { error: claimError, tool_name, call_id });
            } catch { /* telemetry must not affect delivery */ }
            return;
        } finally {
            this.inFlightCallIds.delete(call_id);
        }

        if (!claimed) {
            this.rememberCallId(call_id);
            return;
        }
        this.rememberCallId(call_id);

        const operatorStartedAt = Date.now();
        writeRemoteToolTrace('START', call_id, operatorDescriptor);

        let status: RemoteResultStatus = 'completed';
        let result: unknown | null = null;
        let errorMessage: string | null = null;
        let shutdownRequested = false;

        try {
            // Handle 'ping' tool specially
            if (tool_name === 'ping') {
                result = {
                    content: [{
                        type: 'text',
                        text: `pong ${new Date().toISOString()}`
                    }]
                };
            } else if (tool_name === 'shutdown') {
                result = {
                    content: [{
                        type: 'text',
                        text: `Shutdown initialized at ${new Date().toISOString()}`
                    }]
                };
                shutdownRequested = true;
            } else {
                result = await this.desktop.callClientTool(tool_name, tool_args, metadata);
            }
            if (process.env.DEBUG_MODE === 'true') {
                console.debug(`[DEBUG] Tool call ${call_id}/${tool_name} completed`, remoteToolLogSummary(result));
            }
        } catch (error: any) {
            status = 'failed';
            errorMessage = error?.message ?? String(error);
            console.error(`❌ Tool call ${tool_name} failed:`, errorMessage);
            captureRemote('remote_device_tool_call_failed', { error, tool_name }).catch(() => {});
        }
        writeRemoteToolTrace(status === 'completed' ? 'OK' : 'FAIL', call_id, operatorDescriptor, Date.now() - operatorStartedAt);

        try {
            // Persist the exact terminal outcome locally before attempting the
            // remote write. A lost HTTP acknowledgement can therefore be replayed
            // without re-executing the tool or inventing a synthetic failure.
            await this.persistToolOutcome(call_id, status, result, errorMessage);
        } catch (reportError: any) {
            console.error(`❌ Could not durably preserve outcome for ${call_id}:`, reportError?.message);
            captureRemote('remote_device_result_outbox_write_failed', {
                error: reportError?.message, tool_name, call_id, status
            }).catch(() => {});
        }

        if (shutdownRequested) {
            setTimeout(async () => {
                console.log('🛑 Remote shutdown requested. Exiting...');
                await this.shutdown();
                process.exit(0);
            }, 1000);
        }
    }

    async shutdown() {
        if (this.isShuttingDown) {
            console.debug('[DEBUG] Shutdown already in progress, returning');
            return;
        }

        this.isShuttingDown = true;
        this.stopRuntimeHeartbeat();
        this.runtimeConfig?.stop();
        this.stopResultOutboxRetry();
        console.log('\n🛑 Shutting down device...');
        console.debug('[DEBUG] Shutdown initiated for device:', this.deviceId);

        const shutdownErrors: Array<{ component: string; error: unknown }> = [];

        // Stop heartbeat first so no new status writes are scheduled.
        console.log('  → Stopping heartbeat...');
        this.remoteChannel.stopHeartbeat();
        console.log('  ✓ Heartbeat stopped');

        // Stop receiving remote calls before tearing down the local MCP server.
        console.log('  → Unsubscribing from channel...');
        try {
            await this.remoteChannel.unsubscribe();
        } catch (error) {
            shutdownErrors.push({ component: 'remote-channel', error });
            console.warn('  ⚠️ Channel unsubscribe failed; continuing local shutdown');
        }

        // The local server is the resource owned by this process. Never let a
        // remote cleanup failure skip this step or leave the fork serving after
        // Ctrl+C / terminal shutdown.
        console.log('  → Shutting down desktop integration...');
        try {
            await this.desktop.shutdown();
            console.log('  ✓ Desktop integration shut down');
        } catch (error) {
            shutdownErrors.push({ component: 'desktop-integration', error });
            console.error('  ❌ Desktop integration shutdown failed:', error);
        }

        // Durable remote presence is best-effort and must come after local
        // process teardown so a slow network write cannot keep the server alive.
        console.log('  → Marking device offline...');
        try {
            await this.remoteChannel.setOffline(this.deviceId);
        } catch (error) {
            shutdownErrors.push({ component: 'offline-status', error });
            console.warn('  ⚠️ Device offline update failed');
        }

        if (shutdownErrors.length > 0) {
            void captureRemote('remote_device_shutdown_error', {
                errors: shutdownErrors.map(({ component, error }) => ({
                    component,
                    message: error instanceof Error ? error.message : String(error),
                })),
            }).catch(() => {});
        }

        this.removeShutdownHandlers();
        console.log('✓ Device shutdown complete');
        console.debug('[DEBUG] Shutdown sequence completed');
    }
}

// Start device if called directly or as a bin command
// When installed globally, npm creates a wrapper, so we need to check multiple conditions
const isMainModule = process.argv[1] && (
    // Direct execution: node device.js
    import.meta.url === `file://${process.argv[1]}` ||
    fileURLToPath(import.meta.url) === process.argv[1] ||
    // Global bin execution: desktop-commander-device (npm creates a wrapper)
    process.argv[1].endsWith('desktop-commander-device') ||
    process.argv[1].endsWith('desktop-commander-device.js')
);

if (isMainModule) {
    // Parse command-line arguments
    const args = process.argv.slice(2);
    const options = {
        persistSession: args.includes('--persist-session')
    };

    if (options.persistSession) {
        console.log('🔒 Session persistence enabled');
    }

    const device = new MCPDevice(options);
    device.start();
}
