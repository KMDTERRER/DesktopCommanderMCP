#!/usr/bin/env node

import { RemoteChannel } from './remote-channel.js';
import { SessionTokenOwner, type AuthSession } from './session-token-owner.js';
import { RemoteCallMetrics, type RemoteMetricEvent, type RemoteMetricStage } from './remote-call-metrics.js';
import { createRemoteOutcomeIdentity, type RemoteResultDeliveryMode } from './remote-result-contract.js';
import { DeviceAuthenticator } from './device-authenticator.js';
import { DesktopCommanderIntegration } from './desktop-commander-integration.js';
import { DeviceStatusArbiter } from './device-status-arbiter.js';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { captureRemote } from '../utils/capture.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { renameReplacingWithRetry } from '../utils/atomic-rename.js';
import { describeRemoteError, isTransientHttpStatus, isTransientRemoteError } from './transient-remote-error.js';
import { RemoteResultOutbox, type RemoteResultOutboxEntry, type RemoteResultStatus } from './result-outbox.js';
import { createMcpToolErrorResult, normalizeMcpToolResult } from '../utils/mcp-tool-error.js';

const REMOTE_BOOTSTRAP_FETCH_TIMEOUT_MS = 15_000;
const REMOTE_BOOTSTRAP_FETCH_ATTEMPTS = 3;
const REMOTE_BOOTSTRAP_ATTEMPT_TIMEOUT_MS = 5_000;
const REMOTE_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 7_000;
const REMOTE_CONFIG_IO_TIMEOUT_MS = 10_000;
const REMOTE_CONFIG_MAX_BYTES = 1024 * 1024;

export interface MCPDeviceOptions {
    persistSession?: boolean;
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
type ActiveResultDelivery = {
    outcomeHash: string;
    promise: Promise<void>;
};

type RemoteLatencyContext = {
    tool: string;
    profile: string;
    inbound: string;
    terminalWrite: string;
    receivedAtMs: number;
    createdAt?: unknown;
    toolDoneAtMs?: number;
    localPersistStartedAtMs?: number;
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
    private deviceId?: string;
    private isShuttingDown: boolean;
    private configPath: string;
    private persistSession: boolean;
    private callMetrics: RemoteCallMetrics;
    private remoteLatencyContexts = new Map<string, RemoteLatencyContext>();
    private desktop: DesktopCommanderIntegration;
    private statusArbiter: DeviceStatusArbiter;
    private recoveringLocalMcp = false;
    private localRestartAttempt = 0;
    private localMcpStableSince = 0;
    private resultOutbox: RemoteResultOutbox;
    private resultOutboxFlushPromise: Promise<void> | null = null;
    private resultDeliveries = new Map<string, ActiveResultDelivery>();
    /** Confirmed terminal outcomes already handed to the hosted row by this
     * process. Retained briefly so delayed duplicate doorbells and stale local
     * cleanup cannot resend the same payload or wake. */
    private committedOutcomeHashes = new Map<string, string>();
    private volatileOutcomes = new Map<string, RemoteResultOutboxEntry>();
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
        this.remoteChannel = new RemoteChannel(this.tokenOwner);
        this.callMetrics = new RemoteCallMetrics(
            process.env.DC_REMOTE_METRICS_LOG
                || path.join(os.homedir(), '.desktop-commander-device', 'remote-call-metrics.jsonl')
        );
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
        this.statusArbiter = new DeviceStatusArbiter({
            write: async (status) => {
                if (!this.deviceId || this.isShuttingDown) return false;
                return await this.remoteChannel.setOnlineStatus(this.deviceId, status);
            },
        });
    }

    private shouldSignalResult(): boolean {
        return true;
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

    async handleLocalMcpLoss(reason: string): Promise<void> {
        if (this.recoveringLocalMcp || this.isShuttingDown) return;
        this.recoveringLocalMcp = true;
        this.statusArbiter.report('child', false);
        await this.statusArbiter.flush();
        try {
            const baseMs = Math.max(1, Number(process.env.DC_LOCAL_RESTART_BACKOFF_BASE_MS) || 2_000);
            const stableMs = Math.max(1, Number(process.env.DC_LOCAL_RESTART_STABLE_UPTIME_MS) || 60_000);
            const ceilingMs = 5 * 60_000;
            if (!this.localMcpStableSince || Date.now() - this.localMcpStableSince >= stableMs) this.localRestartAttempt = 0;
            while (!this.isShuttingDown) {
                const delayMs = Math.min(baseMs * 2 ** Math.min(this.localRestartAttempt, 16), ceilingMs);
                this.localRestartAttempt += 1;
                await new Promise((resolve) => setTimeout(resolve, delayMs + Math.random() * delayMs * 0.15));
                if (this.isShuttingDown) return;
                try {
                    await this.desktop.ensureReady();
                    const capabilities = await this.desktop.listClientTools();
                    if (this.deviceId) await this.remoteChannel.refreshDeviceCapabilities(capabilities);
                    this.localMcpStableSince = Date.now();
                    this.statusArbiter.report('child', true);
                    await this.statusArbiter.flush();
                    console.log(`♻️ Local Desktop Commander MCP restarted (attempt ${this.localRestartAttempt})`);
                    return;
                } catch (error: any) {
                    console.error(`❌ Local MCP restart attempt ${this.localRestartAttempt} failed: ${error?.message}`);
                    void captureRemote('remote_device_local_mcp_restart_failed', { error, reason, attempt: this.localRestartAttempt });
                }
            }
        } finally {
            this.recoveringLocalMcp = false;
        }
    }

    async start() {
        try {
            this.setupShutdownHandlers();
            console.log('🚀 Starting MCP Device...');
            if (process.env.DEBUG_MODE === 'true') {
                console.log(`  - 🐞 DEBUG_MODE`);
            }


            // Initialize desktop integration
            this.desktop.onDisconnect((reason) => { void this.handleLocalMcpLoss(reason); });
            this.remoteChannel.setChannelHealthReporter((ready) => this.statusArbiter.report('channel', ready));
            await this.desktop.initialize();
            this.localMcpStableSince = Date.now();
            this.statusArbiter.report('child', true);

            console.log(`⏳ Connecting to Remote MCP ${this.baseServerUrl}`);
            const { supabaseUrl, anonKey } = await this.fetchSupabaseConfig();
            console.log(`   - 🔌 Connected to Remote MCP`);

            // RemoteChannel is the sole owner of hosted Auth, Realtime, claim,
            // terminal-result and wake operations.
            this.remoteChannel.initialize(supabaseUrl, anonKey);

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
            await this.statusArbiter.sync();
            this.desktop.setToolsChangedHandler(async () => {
                if (!this.deviceId || this.isShuttingDown) return;
                const capabilities = await this.desktop.listClientTools();
                await this.remoteChannel.refreshDeviceCapabilities(capabilities);
            });

            this.startResultOutboxRetry();
            void this.scheduleResultOutboxFlush().catch((error) => {
                console.error('[DEBUG] Initial result outbox flush failed:', error?.message);
            });

            console.log('✅ Device ready:');
            console.log(`   - User:         ${this.remoteChannel.user!.email}`);
            console.log(`   - Device ID:    ${this.deviceId}`);
            console.log(`   - Device Name:  ${deviceName}`);

            this.remoteChannel.startHeartbeat(this.deviceId!);

        } catch (error: any) {
            console.error(' - ❌ Device startup failed:', describeRemoteError(error));
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
                // Config recovery is an availability boundary. Remote telemetry must
                // never re-block the caller after the local read already timed out.
                void captureRemote('remote_device_config_load_error', { error }).catch(() => undefined);
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

    private recordRemoteLatency(
        callId: string,
        stage: RemoteMetricStage,
        fields: Omit<Partial<RemoteMetricEvent>,
            'stage' | 'callId' | 'tool' | 'profile' | 'inbound' | 'terminalWrite' | 'receivedAtMs' | 'createdAt'> = {},
    ): void {
        const context = this.remoteLatencyContexts.get(callId);
        if (!context) return;
        this.callMetrics.record({
            stage, callId, tool: context.tool,
            profile: context.profile, inbound: context.inbound, terminalWrite: context.terminalWrite,
            receivedAtMs: context.receivedAtMs, createdAt: context.createdAt,
            ...fields,
        });
    }

    private scheduleResultOutboxFlush(): Promise<void> {
        if (this.resultOutboxFlushPromise) return this.resultOutboxFlushPromise;
        let current!: Promise<void>;
        current = this.flushResultOutbox().finally(() => {
            if (this.resultOutboxFlushPromise === current) this.resultOutboxFlushPromise = null;
        });
        this.resultOutboxFlushPromise = current;
        return current;
    }

    private resultEntryOutcomeHash(entry: RemoteResultOutboxEntry): string {
        const identity = createRemoteOutcomeIdentity(entry.status, entry.result, entry.errorMessage);
        if (entry.outcomeRevision !== undefined && entry.outcomeRevision !== identity.outcomeRevision) {
            throw new Error(`Remote result outcome revision changed for ${entry.callId}.`);
        }
        if (entry.outcomeHash !== undefined && entry.outcomeHash !== identity.outcomeHash) {
            throw new Error(`Remote result outcome hash changed for ${entry.callId}.`);
        }
        return identity.outcomeHash;
    }

    private rememberCommittedOutcome(callId: string, outcomeHash: string): void {
        const existing = this.committedOutcomeHashes.get(callId);
        if (existing !== undefined && existing !== outcomeHash) {
            throw new Error(`Refusing a second terminal outcome for ${callId}.`);
        }
        if (existing === undefined) this.committedOutcomeHashes.set(callId, outcomeHash);
        if (this.committedOutcomeHashes.size > SEEN_CALL_IDS_MAX) {
            const oldest = this.committedOutcomeHashes.keys().next().value;
            if (oldest !== undefined) this.committedOutcomeHashes.delete(oldest);
        }
    }

    /** One process-wide delivery owner for durable, volatile, live and replay
     * paths. A second path for the same call may join the first only when the
     * immutable terminal outcome hash matches exactly. */
    private runSingleResultDelivery(
        entry: RemoteResultOutboxEntry,
        operation: (alreadyCommitted: boolean, outcomeHash: string) => Promise<void>,
    ): Promise<void> {
        let outcomeHash: string;
        try {
            outcomeHash = this.resultEntryOutcomeHash(entry);
        } catch (error) {
            return Promise.reject(error);
        }
        const active = this.resultDeliveries.get(entry.callId);
        if (active) {
            if (active.outcomeHash !== outcomeHash) {
                return Promise.reject(new Error(`Concurrent terminal outcomes differ for ${entry.callId}.`));
            }
            return active.promise;
        }
        const committed = this.committedOutcomeHashes.get(entry.callId);
        if (committed !== undefined) {
            if (committed !== outcomeHash) {
                return Promise.reject(new Error(`Committed terminal outcome differs for ${entry.callId}.`));
            }
            return operation(true, outcomeHash);
        }

        let promise!: Promise<void>;
        promise = operation(false, outcomeHash).finally(() => {
            const current = this.resultDeliveries.get(entry.callId);
            if (current?.promise === promise) this.resultDeliveries.delete(entry.callId);
        });
        this.resultDeliveries.set(entry.callId, { outcomeHash, promise });
        return promise;
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

    private observeResultWake(callId: string): void {
        if (!this.shouldSignalResult()) {
            this.remoteLatencyContexts.delete(callId);
            return;
        }
        const wakeStartedAt = Date.now();
        void Promise.resolve(this.remoteChannel.signalResultAvailable(callId)).then(
            (ack) => {
                const context = this.remoteLatencyContexts.get(callId);
                const completedAt = Date.now();
                this.recordRemoteLatency(callId, 'wake_done', {
                    wakeMs: ack?.durationMs ?? Math.max(0, completedAt - wakeStartedAt),
                    wakeStatus: ack?.status ?? 'unknown',
                    postToolToWakeMs: context?.toolDoneAtMs === undefined
                        ? undefined : Math.max(0, completedAt - context.toolDoneAtMs),
                    totalMs: Math.max(0, completedAt - (context?.receivedAtMs ?? completedAt)),
                    phaseOutcome: ack?.attempted === false ? 'skipped' : ack?.status ?? 'unknown',
                });
                this.remoteLatencyContexts.delete(callId);
            },
            (error: any) => {
                const context = this.remoteLatencyContexts.get(callId);
                const completedAt = Date.now();
                this.recordRemoteLatency(callId, 'wake_done', {
                    wakeMs: Math.max(0, completedAt - wakeStartedAt),
                    wakeStatus: 'error',
                    postToolToWakeMs: context?.toolDoneAtMs === undefined
                        ? undefined : Math.max(0, completedAt - context.toolDoneAtMs),
                    totalMs: Math.max(0, completedAt - (context?.receivedAtMs ?? completedAt)),
                    phaseOutcome: error?.message || 'error',
                });
                this.remoteLatencyContexts.delete(callId);
            },
        );
    }

    private deliverResultOutboxEntry(
        entry: RemoteResultOutboxEntry, priority: ResultDeliveryPriority = 'live',
    ): Promise<void> {
        return this.runSingleResultDelivery(entry, async (alreadyCommitted, outcomeHash) => {
            if (alreadyCommitted) {
                // A confirmed outcome can leave a stale file only when local
                // cleanup failed. Retire it without touching the network again.
                await this.resultOutbox.remove(entry.callId);
                return;
            }
            const deliveryQueuedAt = Date.now();
            const release = await this.acquireResultDeliverySlot(priority);
            const deliverySlotWaitMs = Math.max(0, Date.now() - deliveryQueuedAt);
            try {
                // The outbox owns only persistence of the exact terminal outcome.
                // Once the database confirms it, retire the local retry entry BEFORE
                // notification so an unconfirmed wake-up can never create an
                // unbounded notification loop. Server-side recovery owns resume.
                const terminalCommitStartedAt = Date.now();
                const commitDisposition = await this.remoteChannel.updateCallResult(
                    entry.callId, entry.status, entry.result, entry.errorMessage,
                    { deviceId: entry.deviceId, userId: entry.userId, toolName: entry.toolName },
                    priority,
                );
                const terminalCommitDoneAt = Date.now();
                const remoteCommitMs = Math.max(0, terminalCommitDoneAt - terminalCommitStartedAt);
                const context = this.remoteLatencyContexts.get(entry.callId);
                this.recordRemoteLatency(entry.callId, 'remote_commit_done', {
                    deliverySlotWaitMs, remoteCommitMs,
                    postToolToRemoteCommitMs: context?.toolDoneAtMs === undefined
                        ? undefined : Math.max(0, terminalCommitDoneAt - context.toolDoneAtMs),
                    totalMs: Math.max(0, terminalCommitDoneAt - (context?.receivedAtMs ?? terminalCommitDoneAt)),
                    phaseOutcome: priority,
                });
                console.log(`↗ RESULT COMMIT ${entry.callId.slice(0, 8)} ${remoteCommitMs}ms`);
                this.rememberCommittedOutcome(entry.callId, outcomeHash);
                this.remoteChannel.releaseCallClaim(entry.callId);

                // Retire the replay source before the one allowed wake. If local
                // cleanup fails, server-side recovery remains authoritative and
                // the in-memory committed hash prevents another payload/wake.
                await this.resultOutbox.remove(entry.callId);
                if (commitDisposition !== 'already_committed') this.observeResultWake(entry.callId);
                else this.remoteLatencyContexts.delete(entry.callId);
            } finally {
                release();
            }
        });
    }

    private deliverVolatileOutcome(
        entry: RemoteResultOutboxEntry, priority: ResultDeliveryPriority = 'live',
    ): Promise<void> {
        return this.runSingleResultDelivery(entry, async (alreadyCommitted, outcomeHash) => {
            if (alreadyCommitted) {
                this.volatileOutcomes.delete(entry.callId);
                return;
            }
            const deliveryQueuedAt = Date.now();
            const release = await this.acquireResultDeliverySlot(priority);
            const deliverySlotWaitMs = Math.max(0, Date.now() - deliveryQueuedAt);
            try {
                try {
                    const remoteCommitStartedAt = Date.now();
                    const commitDisposition = await this.remoteChannel.updateCallResult(
                        entry.callId, entry.status, entry.result, entry.errorMessage,
                        { deviceId: entry.deviceId, userId: entry.userId, toolName: entry.toolName },
                        priority,
                    );
                    const remoteCommitDoneAt = Date.now();
                    const context = this.remoteLatencyContexts.get(entry.callId);
                    this.recordRemoteLatency(entry.callId, 'remote_commit_done', {
                        deliverySlotWaitMs, remoteCommitMs: Math.max(0, remoteCommitDoneAt - remoteCommitStartedAt),
                        postToolToRemoteCommitMs: context?.toolDoneAtMs === undefined
                            ? undefined : Math.max(0, remoteCommitDoneAt - context.toolDoneAtMs),
                        totalMs: Math.max(0, remoteCommitDoneAt - (context?.receivedAtMs ?? remoteCommitDoneAt)),
                        phaseOutcome: `volatile_${priority}`,
                    });
                    this.rememberCommittedOutcome(entry.callId, outcomeHash);
                    this.remoteChannel.releaseCallClaim(entry.callId);
                    if (commitDisposition === 'already_committed') {
                        this.volatileOutcomes.delete(entry.callId);
                        this.remoteLatencyContexts.delete(entry.callId);
                        return;
                    }
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
                this.observeResultWake(entry.callId);
            } finally {
                release();
            }
        });
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
        deviceId: string,
        toolName: string,
        status: RemoteResultStatus,
        result: unknown | null,
        errorMessage: string | null,
    ): Promise<void> {
        const claimToken = this.remoteChannel.getCallClaimToken(callId);
        if (!claimToken) throw new Error(`No claim token available for result outbox entry ${callId}`);
        const userId = this.remoteChannel.getCurrentUserId();
        if (!userId) throw new Error(`No authenticated user available for result outbox entry ${callId}`);
        const identity = createRemoteOutcomeIdentity(status, result, errorMessage);
        const entry: RemoteResultOutboxEntry = {
            version: 2, callId, deviceId, userId, toolName, claimToken,
            outcomeRevision: identity.outcomeRevision, outcomeHash: identity.outcomeHash,
            status, result: identity.result, errorMessage: identity.errorMessage,
            createdAt: new Date().toISOString(),
        };

        // Install an emergency owner before the first persistence await. Remove it
        // only after either local fsync or confirmed remote terminal persistence.
        this.volatileOutcomes.set(callId, entry);
        try {
            await this.resultOutbox.put(entry);
            const localPersistDoneAt = Date.now();
            const latencyContext = this.remoteLatencyContexts.get(callId);
            const localPersistMs = latencyContext?.localPersistStartedAtMs === undefined
                ? undefined : Math.max(0, localPersistDoneAt - latencyContext.localPersistStartedAtMs);
            this.recordRemoteLatency(callId, 'local_persist_done', {
                localPersistMs,
                totalMs: Math.max(0, localPersistDoneAt - (latencyContext?.receivedAtMs ?? localPersistDoneAt)),
                phaseOutcome: 'outbox',
            });
            this.volatileOutcomes.delete(callId);
            if (process.env.DESKTOP_COMMANDER_REMOTE_TOOL_TRACE !== 'false') {
                console.log(`↗ OUTBOX COMMIT ${callId.slice(0, 8)} ${localPersistMs ?? 0}ms`);
            }
        } catch (spoolError: any) {
            const spoolFailedAt = Date.now();
            const latencyContext = this.remoteLatencyContexts.get(callId);
            this.recordRemoteLatency(callId, 'local_persist_done', {
                localPersistMs: latencyContext?.localPersistStartedAtMs === undefined
                    ? undefined : Math.max(0, spoolFailedAt - latencyContext.localPersistStartedAtMs),
                totalMs: Math.max(0, spoolFailedAt - (latencyContext?.receivedAtMs ?? spoolFailedAt)),
                phaseOutcome: 'spool_error',
            });
            console.error(`[DEBUG] Could not persist local result outbox entry ${callId}:`, spoolError?.message);
            await this.deliverVolatileOutcome(entry, 'live');
            return;
        }

        // Local fsync is the handler's completion boundary. Remote persistence is
        // deliberately detached: a healthy connection still gets an immediate
        // short live attempt, while a slow/outage path cannot consume the caller's
        // remaining request deadline or head-of-line block a parallel chat. The
        // exact result stays in the outbox until a later acknowledged replay.
        void this.deliverResultOutboxEntry(entry, 'live').catch((deliveryError: any) => {
            if (process.env.DESKTOP_COMMANDER_REMOTE_TOOL_TRACE !== 'false') {
                console.warn(
                    `↗ RESULT DEFER ${callId.slice(0, 8)} ${operatorTraceToken(deliveryError?.message || deliveryError || 'unknown', 160)}`,
                );
            }
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

    /** Record a handled call id, evicting the oldest once the cap is reached. */
    private rememberCallId(callId: string) {
        this.seenCallIds.add(callId);
        if (this.seenCallIds.size > SEEN_CALL_IDS_MAX) {
            // Sets iterate in insertion order — drop the oldest entry.
            const oldest = this.seenCallIds.values().next().value;
            if (oldest !== undefined) this.seenCallIds.delete(oldest);
        }
    }

    /** Fail closed before dedupe/claim: a row is executable only by the exact
     * authenticated user and device named on that row. */
    private remoteCallTargetsThisRuntime(toolCall: any): boolean {
        if (!toolCall || typeof toolCall !== 'object') return false;
        if (typeof toolCall.id !== 'string' || !toolCall.id.trim()) return false;
        if (typeof toolCall.tool_name !== 'string' || !toolCall.tool_name.trim()) return false;
        if (typeof this.deviceId !== 'string' || toolCall.device_id !== this.deviceId) return false;
        const expectedUserId = this.remoteChannel.getCurrentUserId();
        return typeof expectedUserId === 'string' && expectedUserId.length > 0
            && toolCall.user_id === expectedUserId;
    }

    async handleNewToolCall(payload: any) {
        const handlerReceivedAtMs = Date.now();
        const toolCall = payload?.new;
        if (!this.remoteCallTargetsThisRuntime(toolCall)) {
            if (process.env.DEBUG_MODE === 'true') {
                console.debug('[DEBUG] Ignoring malformed or foreign remote call target');
            }
            return;
        }
        // Expect toolCall to include a device_id field used to route calls to this device instance.
        const { id: call_id, tool_name, tool_args, device_id, metadata = {}, created_at } = toolCall;
        const rawTiming = payload?._remoteTiming && typeof payload._remoteTiming === 'object'
            ? payload._remoteTiming as Record<string, unknown> : {};
        const receivedAtMs = Number.isFinite(rawTiming.receivedAtMs)
            ? Number(rawTiming.receivedAtMs) : handlerReceivedAtMs;
        const inbound = typeof rawTiming.inbound === 'string' ? rawTiming.inbound : 'unknown';
        const rowFetchMs = Number.isFinite(rawTiming.rowFetchMs) ? Number(rawTiming.rowFetchMs) : undefined;

        // Only process jobs for this device. Verbose routing diagnostics stay
        // behind DEBUG_MODE; the clean operator trace below is emitted only
        // after this process has actually won execution ownership.
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

        this.remoteLatencyContexts.set(call_id, {
            tool: tool_name, profile: 'production', inbound, terminalWrite: 'fenced',
            receivedAtMs, createdAt: created_at,
        });
        this.recordRemoteLatency(call_id, 'recv', {
            args: tool_args, handlerReceivedAtMs, rowFetchMs,
            totalMs: Math.max(0, handlerReceivedAtMs - receivedAtMs),
        });

        const operatorDescriptor = describeRemoteToolCall(tool_name, tool_args);
        writeRemoteToolTrace('RECV', call_id, operatorDescriptor);

        this.inFlightCallIds.add(call_id);
        let claimed = false;
        const claimStartedAt = Date.now();
        try {
            claimed = await this.remoteChannel.markCallExecuting(call_id, {
                deviceId: this.deviceId!, userId: toolCall.user_id, toolName: tool_name,
            });
        } catch (claimError: any) {
            // Ownership was not established. Do not execute and do not write a
            // terminal result for a row another process may own. Because the id
            // is not remembered, a later redelivery can safely retry the claim.
            const claimDoneAt = Date.now();
            this.recordRemoteLatency(call_id, 'claim_done', {
                rowFetchMs, claimMs: Math.max(0, claimDoneAt - claimStartedAt),
                preToolMs: Math.max(0, claimDoneAt - receivedAtMs),
                totalMs: Math.max(0, claimDoneAt - receivedAtMs), phaseOutcome: 'error',
            });
            this.remoteLatencyContexts.delete(call_id);
            console.error(`❌ Could not establish claim ownership for ${call_id}:`, claimError?.message);
            try {
                await captureRemote('remote_device_tool_call_claim_failed', { error: claimError, tool_name, call_id });
            } catch { /* telemetry must not affect delivery */ }
            return;
        } finally {
            this.inFlightCallIds.delete(call_id);
        }

        const claimDoneAt = Date.now();
        this.recordRemoteLatency(call_id, 'claim_done', {
            rowFetchMs, claimMs: Math.max(0, claimDoneAt - claimStartedAt),
            preToolMs: Math.max(0, claimDoneAt - receivedAtMs),
            totalMs: Math.max(0, claimDoneAt - receivedAtMs), phaseOutcome: claimed ? 'won' : 'lost',
        });
        if (!claimed) {
            this.remoteLatencyContexts.delete(call_id);
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
            // This is the single final response gate for every remote route,
            // including built-ins, the child MCP, external MCPs, and Serena.
            // Tests/adapters cannot bypass it by replacing callClientTool.
            result = normalizeMcpToolResult(result, `Remote result for ${tool_name}`);
            if (process.env.DEBUG_MODE === 'true') {
                console.debug(`[DEBUG] Tool call ${call_id}/${tool_name} completed`, remoteToolLogSummary(result));
            }
        } catch (error: any) {
            // Defense in depth for failures outside DesktopCommanderIntegration:
            // a claimed tool call still completes with the wrapper's native
            // isError result and never exposes a proxy/MCP server error channel.
            result = createMcpToolErrorResult(error, tool_name);
            console.error(`❌ Tool call ${tool_name} returned a wrapped error:`, error?.message ?? String(error));
            captureRemote('remote_device_tool_call_failed', { error, tool_name }).catch(() => {});
        }
        const toolDoneAtMs = Date.now();
        const toolMs = Math.max(0, toolDoneAtMs - operatorStartedAt);
        const latencyContext = this.remoteLatencyContexts.get(call_id);
        if (latencyContext) latencyContext.toolDoneAtMs = toolDoneAtMs;
        this.recordRemoteLatency(call_id, 'tool_done', {
            args: tool_args, result, toolMs,
            totalMs: Math.max(0, toolDoneAtMs - receivedAtMs), phaseOutcome: status,
        });
        writeRemoteToolTrace(status === 'completed' ? 'OK' : 'FAIL', call_id, operatorDescriptor, toolMs);

        if (latencyContext) latencyContext.localPersistStartedAtMs = Date.now();
        try {
            // Persist the exact terminal outcome locally before attempting the
            // remote write. A lost HTTP acknowledgement can therefore be replayed
            // without re-executing the tool or inventing a synthetic failure.
            await this.persistToolOutcome(call_id, device_id, tool_name, status, result, errorMessage);
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
            for (const { error } of shutdownErrors) {
                void captureRemote('remote_device_shutdown_error', { error }).catch(() => {});
            }
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
