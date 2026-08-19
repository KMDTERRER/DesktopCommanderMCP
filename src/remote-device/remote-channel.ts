import { createClient, SupabaseClient, Session, UserResponse, User, RealtimeChannel } from '@supabase/supabase-js';
import { captureRemote } from '../utils/capture.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { VERSION } from '../version.js';
import { randomUUID } from 'crypto';
import { SessionTokenOwner, type AuthSession } from './session-token-owner.js';
import { CLAIM_METADATA_KEY, stripNullBytes } from './remote-result-contract.js';
import type { RemoteInboundMode } from './remote-runtime-config.js';
import { describeRemoteError } from './transient-remote-error.js';
import { diagnoseRemoteEndpoint } from './remote-network-diagnostics.js';

const DEVICE_SESSION_CAPABILITY_KEY = 'device_session_v1';

interface DeviceSessionLease {
    generation: string;
    acquired_at: string;
}

export interface RemoteResultWakeAck {
    attempted: boolean;
    status: string;
    durationMs: number;
}

interface DeviceData {
    user_id: string;
    device_name: string;
    capabilities: any;
    status: string;
    last_seen: string;
}

// last_seen cadences. The server tiers its sweep on the transport_broadcast_v1
// flag, so each must fit its tier's threshold in the server's constants.ts:
// capable -> 15 min, unflagged -> 45s.
const CAPABLE_HEARTBEAT_INTERVAL = 5 * 60 * 1000;
const LEGACY_HEARTBEAT_INTERVAL = 15 * 1000;
// Cap on a recreate's rebuild step so a hung await can't disable the watchdog.
// Must exceed createChannel()'s worst case (~31.5s of presence retries).
const REALTIME_ACK_TIMEOUT_MS = 60_000;
const RECREATE_TIMEOUT_MS = 210_000;
// Max continuous time in 'joining' before forcing a recreate. Must stay above
// the Realtime join ACK timeout so a slow-but-live join is never torn down early.
const JOINING_WEDGE_TIMEOUT_MS = 75_000;
// Includes Presence retries after SUBSCRIBED; 3 x 60s plus bounded retry gaps.
const CHANNEL_SUBSCRIBE_SETTLE_TIMEOUT_MS = 195_000;
// Failed recreates before withdrawing transport_broadcast_v1 — keeping it while
// unable to join makes the device undispatchable. Not lower than 3: ordinary
// half-open recovery legitimately costs 2.
const TRANSPORT_WITHDRAW_AFTER_ATTEMPTS = 3;
// Cap on the withdrawal write; it runs in a catch block RECREATE_TIMEOUT_MS
// does not cover.
const CAPABILITY_WRITE_TIMEOUT_MS = 5000;
// Remote-call DB deadlines: fetch/claim are small control-plane operations;
// large terminal results get more room, while text-only failure fallback stays short.
const REMOTE_CALL_FETCH_TIMEOUT_MS = 15000;
const REMOTE_CALL_CLAIM_TIMEOUT_MS = 15000;
const REMOTE_CALL_CLAIM_RECONCILE_TIMEOUT_MS = 5000;
const REMOTE_CALL_CLAIM_ATTEMPTS = 3;
// All other PostgREST control-plane operations are bounded too. An outer
// Promise.race alone would leave the underlying fetch alive and can pin ordered
// chains such as statusWriteChain; abortSignal cancels the request itself.
const REMOTE_CONTROL_QUERY_TIMEOUT_MS = 15000;
const REMOTE_HEARTBEAT_WRITE_TIMEOUT_MS = 5000;
// When private Broadcast is unavailable, Postgres Changes can lag by seconds.
// Poll only while degraded: fast during an active recovery window, then idle-slow.
const DEGRADED_CALL_POLL_FAST_MS = 250;
const DEGRADED_CALL_POLL_IDLE_MS = 1000;
const DEGRADED_CALL_POLL_BURST_MS = 30_000;
const DEGRADED_CALL_POLL_TIMEOUT_MS = 5000;
const DEGRADED_CALL_POLL_BATCH = 16;
// A broadcast-selected row arriving this late through legacy delivery proves the
// primary transport missed its low-latency contract, even if SDK state says joined.
const BROADCAST_DELIVERY_MISS_MS = 750;
const BROADCAST_MISS_RECOVERY_COOLDOWN_MS = 30_000;
const RECENT_BROADCAST_CALL_TTL_MS = 60_000;
const RECENT_BROADCAST_CALLS_MAX = 256;
// realtime-js parks in 'disconnecting' for ~100ms after a disconnect and
// connect() early-returns for that whole window (see waitForSocketSettled).
// Bound generously — this only ever delays a recreate, which RECREATE_TIMEOUT_MS
// already covers.
const SOCKET_SETTLE_MAX_MS = 300;
const SOCKET_SETTLE_POLL_MS = 20;

export class RemoteChannel {
    private client: SupabaseClient | null = null;
    private channel: RealtimeChannel | null = null;
    /** Monotonic fence for private-channel callbacks across recreation. */
    private channelGeneration = 0;
    /** Invalidates async recreate bodies that outlive their outer timeout. */
    private recreateOperationGeneration = 0;
    /** Legacy listener, on its own public channel so a private-channel auth
     * failure can't take both transports down. Removed at the flip (009). */
    private legacyChannel: RealtimeChannel | null = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private connectionCheckInterval: NodeJS.Timeout | null = null;
    /** Device the heartbeat timer maintains; null = stopped, so re-arm is inert. */
    private heartbeatDeviceId: string | null = null;
    // Single-slot queue keeping concurrent `status` PATCHes in order.
    private statusWriteChain: Promise<void> = Promise.resolve();
    // Single writer for the capabilities JSONB column. Catalog refresh and
    // transport reachability both replace the whole value, so they must never race.
    private capabilityWriteChain: Promise<void> = Promise.resolve();
    /** Fences terminal writes to the process that won pending -> executing. */
    private callClaimTokens = new Map<string, string>();
    /** Exact metadata written with the winning claim, retained for durable terminal identity. */
    private callClaimMetadata = new Map<string, Record<string, unknown>>();
    /** Set by unsubscribe(): suppresses status/heartbeat writes so they can't
     * land after setOffline()'s durable write. */
    private shuttingDown = false;


    // Store subscription parameters for channel recreation
    private deviceId: string | null = null;
    private deviceName: string | null = null;
    private onToolCall: ((payload: any) => void) | null = null;
    // Guard so setSession being called twice can't stack auth listeners.
    private authListenerRegistered = false;
    /** False when presence publishing failed on an otherwise healthy channel;
     * the health check retries, since SUBSCRIBED won't fire again. */
    private presenceTracked = false;
    /** Local MCP tools/resources advertised by DesktopCommanderIntegration.
     * Kept separately from transport state so capability flag updates cannot
     * erase the tool catalog in the device JSONB record. */
    private deviceCapabilities: Record<string, any> = {};
    /** Device-process generation used to fence every write after registration acquisition. */
    private deviceSessionLease: DeviceSessionLease | null = null;
    /** Last transport capability value written (null = never), to avoid redundant writes. */
    private transportCapableWritten: boolean | null = null;
    /** Presence push in flight for the current private-channel generation. */
    private trackingPresenceGeneration: number | null = null;
    private minimalInboundMode: RemoteInboundMode | null = null;
    private minimalInboundSwitch: Promise<void> = Promise.resolve();
    private degradedCallPollTimer: NodeJS.Timeout | null = null;
    private degradedCallPollInFlight = false;
    private degradedCallPollBurstUntil = 0;
    private lastBroadcastMissRecoveryAt = 0;
    /** Broadcast doorbells already observed; late postgres_changes copies are expected duplicates. */
    private recentBroadcastCalls = new Map<string, number>();
    /** A delivery miss suppresses broadcast capability for this exact channel generation.
     * Presence can remain valid; only a new private-channel generation may clear suppression. */
    private broadcastSuppressedGeneration: number | null = null;

    // Track last device status to prevent duplicate log messages
    private lastDeviceStatus: 'online' | 'offline' = 'offline';

    // Track last channel state for debug logging
    private lastChannelState: string | null = null;

    private reconnectAttempt = 0;        // recreates since the last success
    private isRecreatingChannel = false; // re-entrancy guard
    private joiningSince: number | null = null; // start of an unbroken 'joining' run

    private _user: User | null = null;
    get user(): User | null { return this._user; }

    constructor(
        private readonly tokens: SessionTokenOwner = new SessionTokenOwner(),
        private readonly minimalLiveTest = false,
    ) {}

    initialize(url: string, key: string): void {
        this.client = createClient(url, key, this.minimalLiveTest ? {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
                detectSessionInUrl: false,
            },
            realtime: { timeout: REALTIME_ACK_TIMEOUT_MS },
        } : {
            realtime: { timeout: REALTIME_ACK_TIMEOUT_MS },
        });
    }

    private async syncRealtimeAuth(token: string | null, reason: string): Promise<void> {
        if (!this.client) return;
        try {
            await this.client.realtime.setAuth(token);
        } catch (error: any) {
            console.debug(`[DEBUG] Realtime auth sync failed (${reason}):`, error?.message);
            void captureRemote('remote_channel_realtime_auth_sync_error', {
                reason, error: error?.message || String(error),
            });
        }
    }

    private async runDbQuery<T>(
        label: string,
        timeoutMs: number,
        operation: (signal: AbortSignal) => PromiseLike<T>,
    ): Promise<T> {
        return runWithAbortableTimeout(
            (signal) => Promise.resolve(operation(signal)),
            timeoutMs,
            label,
        );
    }

    async setSession(session: AuthSession): Promise<{ error: any }> {
        if (!this.client) throw new Error('Client not initialized');
        console.debug('[DEBUG] RemoteChannel.setSession() called, has refresh_token:', !!session.refresh_token);
        const { error } = await this.withTimeout(
            () => this.client!.auth.setSession({
                access_token: session.access_token,
                refresh_token: session.refresh_token || ''
            }),
            REMOTE_CONTROL_QUERY_TIMEOUT_MS,
            'auth.setSession'
        );

        if (error) {
            console.error('[DEBUG] Failed to set session:', describeRemoteError(error));
            const supabaseOrigin = (() => {
                try { return new URL((this.client as any).supabaseUrl).origin; } catch { return 'unknown'; }
            })();
            console.error('[DEBUG] Supabase endpoint:', supabaseOrigin);
            await diagnoseRemoteEndpoint(supabaseOrigin);
            await captureRemote('remote_channel_set_session_error', { error });
            return { error };
        }

        // Get user info
        const { data: { user }, error: userError } = await this.withTimeout(
            () => this.client!.auth.getUser(),
            REMOTE_CONTROL_QUERY_TIMEOUT_MS,
            'auth.getUser'
        );
        if (userError) {
            console.error('[DEBUG] Failed to get user:', describeRemoteError(userError));
            await captureRemote('remote_channel_get_user_error', { error: userError });
            throw userError;
        }

        if (!user) {
            const noUserError = new Error('No user returned after setSession');
            console.error('[DEBUG] No user returned:', noUserError.message);
            await captureRemote('remote_channel_get_user_empty', {});
            throw noUserError;
        }

        this._user = user;
        console.debug('[DEBUG] Session set successfully, user:', user.email);

        // Push the CURRENT token, not the one we were handed: setSession()
        // refreshes internally, and the stale parameter would overwrite it.
        const { data: { session: currentSession } } = await this.withTimeout(
            () => this.client!.auth.getSession(),
            REMOTE_CONTROL_QUERY_TIMEOUT_MS,
            'auth.getSession after setSession'
        );
        const realtimeToken = currentSession?.access_token ?? session.access_token;
        this.tokens.replace({
            access_token: realtimeToken,
            refresh_token: currentSession?.refresh_token ?? session.refresh_token ?? null,
            ...(session.device_id ? { device_id: session.device_id } : {}),
        });
        await this.syncRealtimeAuth(realtimeToken, 'setSession');
        console.debug('[DEBUG] Realtime socket authorized with current session JWT');
        if (!this.authListenerRegistered) {
            this.authListenerRegistered = true;
            this.client.auth.onAuthStateChange((event, newSession) => {
                const hasSessionToken =
                    (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') &&
                    !!newSession?.access_token;
                if (hasSessionToken && newSession?.access_token && this.client) {
                    const previous = this.tokens.snapshot();
                    this.tokens.replace({
                        access_token: newSession.access_token,
                        refresh_token: newSession.refresh_token ?? previous?.refresh_token ?? null,
                        ...(previous?.device_id ? { device_id: previous.device_id } : {}),
                    });
                    void this.syncRealtimeAuth(newSession.access_token, `auth:${event}`);
                } else if (event === 'SIGNED_OUT' && this.client) {
                    this.tokens.clear();
                    void this.syncRealtimeAuth(null, 'auth:SIGNED_OUT');
                }
            });
        }

        return { error };
    }

    getCachedSessionSnapshot(): AuthSession | null {
        const snapshot = this.tokens.snapshot();
        if (!snapshot) return null;
        return {
            access_token: snapshot.access_token,
            refresh_token: snapshot.refresh_token,
            ...(snapshot.device_id ? { device_id: snapshot.device_id } : {}),
        };
    }

    async getSession(): Promise<{ data: { session: Session | null }; error: any }> {
        if (!this.client) throw new Error('Client not initialized');
        return await this.withTimeout(
            () => this.client!.auth.getSession(),
            REMOTE_CONTROL_QUERY_TIMEOUT_MS,
            'auth.getSession'
        );
    }

    async findDevice(deviceId: string) {
        if (!this.client) throw new Error('Client not initialized');
        const { data, error } = await this.runDbQuery(
            'findDevice', REMOTE_CONTROL_QUERY_TIMEOUT_MS,
            (signal) => this.client!
                .from('mcp_devices')
                .select('id, device_name')
                .eq('id', deviceId)
                .eq('user_id', this.user?.id)
                .abortSignal(signal)
                .maybeSingle(),
        );

        if (error) {
            console.error('[DEBUG] Failed to find device:', error.message);
            await captureRemote('remote_channel_find_device_error', { error });
            throw error;
        }
        return data;
    }

    async updateDevice(deviceId: string, updates: any) {
        if (!this.client) throw new Error('Client not initialized');
        const { data, error } = await this.runDbQuery(
            'updateDevice', REMOTE_CONTROL_QUERY_TIMEOUT_MS,
            (signal) => this.client!
                .from('mcp_devices')
                .update(updates)
                .eq('id', deviceId)
                .select()
                .abortSignal(signal),
        );

        if (error) {
            console.error('[DEBUG] Failed to update device:', error.message);
            await captureRemote('remote_channel_update_device_error', { error });
        } else {
            console.debug('[DEBUG] Device updated successfully');
        }
        return { data, error };
    }

    async createDevice(deviceData: DeviceData) {
        if (!this.client) throw new Error('Client not initialized');
        const { data, error } = await this.runDbQuery(
            'createDevice', REMOTE_CONTROL_QUERY_TIMEOUT_MS,
            (signal) => this.client!
                .from('mcp_devices')
                .insert(deviceData)
                .select()
                .abortSignal(signal)
                .single(),
        );

        if (error) {
            console.error('[DEBUG] Failed to create device:', error.message);
            await captureRemote('remote_channel_create_device_error', { error });
            throw error;
        }
        console.debug('[DEBUG] Device created successfully');
        return { data, error };
    }

    private enqueueCapabilityWrite<T>(operation: () => Promise<T>): Promise<T> {
        const queued = this.capabilityWriteChain.then(operation, operation);
        this.capabilityWriteChain = queued.then(() => undefined, () => undefined);
        return queued;
    }

    async refreshDeviceCapabilities(capabilities: any): Promise<void> {
        this.deviceCapabilities = capabilities && typeof capabilities === 'object' ? capabilities : {};
        if (!this.client || !this.deviceId) return;
        await this.enqueueCapabilityWrite(async () => {
            if (!this.client || !this.deviceId) return;
            const { error } = await this.runDbQuery(
                'refreshDeviceCapabilities', REMOTE_CONTROL_QUERY_TIMEOUT_MS,
                (signal) => this.client!
                    .from('mcp_devices')
                    .update({ capabilities: this.capabilitiesPayload(this.transportCapableWritten === true) })
                    .contains('capabilities', this.deviceSessionFence())
                    .eq('id', this.deviceId!)
                    .abortSignal(signal),
            );
            if (error) {
                console.error('[DEBUG] Failed to refresh device capabilities:', error.message);
                await captureRemote('remote_channel_capabilities_refresh_error', { error });
                throw error;
            }
            console.debug('[DEBUG] Device tool capabilities refreshed');
        });
    }

    async registerDevice(capabilities: any, currentDeviceId: string | undefined, deviceName: string, onToolCall: (payload: any) => void): Promise<void> {

        console.debug('[DEBUG] RemoteChannel.registerDevice() called, deviceId:', currentDeviceId);

        // DesktopCommanderIntegration returns the local MCP `tools/list` envelope.
        // Capture it once for this device lifetime; every subsequent capability
        // write is composed from this canonical catalog plus transport metadata.
        this.deviceCapabilities = capabilities && typeof capabilities === 'object'
            ? capabilities
            : {};

        this.deviceSessionLease = { generation: randomUUID(), acquired_at: new Date().toISOString() };

        let existingDevice = null;

        if (currentDeviceId && this.user) {
            console.debug('[DEBUG] Finding existing device...');
            existingDevice = await this.findDevice(currentDeviceId);
            console.debug('[DEBUG] Existing device found:', !!existingDevice);
        }

        if (existingDevice) {
            console.debug('[DEBUG] Updating device status to online');
            // transport_broadcast_v1 is NOT set here: the server treats it as
            // binding, so it is written only once presence is proven.
            const { error: deviceUpdateError } = await this.updateDevice(existingDevice.id, {
                status: 'online',
                last_seen: new Date().toISOString(),
                capabilities: this.capabilitiesPayload(false),
                device_name: deviceName
            });
            if (deviceUpdateError) {
                throw new Error(`Failed to register device state: ${deviceUpdateError.message}`);
            }

            // Store parameters for channel recreation
            this.deviceId = existingDevice.id;
            this.deviceName = deviceName;
            this.onToolCall = onToolCall;

            console.debug(`⏳ Subscribing to tool call channel...`);

            // Create and subscribe to the channel
            console.debug('[DEBUG] Calling createChannel()');

            if (this.minimalLiveTest) {
                // A/B benchmark path matching the installed upstream 0.2.47:
                // one postgres_changes stream carrying the complete row. No
                // private doorbell, Presence, result wake or transport tier.
                this.transportCapableWritten = false;
                await this.createMinimalLiveChannel();
                this.minimalInboundMode = 'postgres_changes';
                return;
            }

            // Independent safety net for the doorbell transport.
            this.createLegacyChannel();

            await this.createChannel().catch((error) => {
                console.debug(`[DEBUG] Failed to create channel, will retry after socket reconnect: ${error?.message || error} — ${this.connState()}`);
            });

        } else {
            console.error(`   - ❌ Device not found: ${currentDeviceId}`);
            await captureRemote('remote_channel_register_device_error', { error: 'Device not found', deviceId: currentDeviceId });
            throw new Error(`Device not found: ${currentDeviceId}`);
        }
    }

    /**
     * Publish presence, retrying a non-'ok' result — track() resolves with a
     * status rather than rejecting, and absent presence reads as offline on the
     * server. `presenceTracked` lets the health check retry later.
     */
    private async trackPresenceWithRetry(
        recovered: number,
        attempts = 3,
        expectedGeneration = this.channelGeneration,
    ): Promise<void> {
        if (this.trackingPresenceGeneration === expectedGeneration) return;
        this.trackingPresenceGeneration = expectedGeneration;
        try {
            await this.trackPresenceInner(recovered, attempts, expectedGeneration);
        } finally {
            if (this.trackingPresenceGeneration === expectedGeneration) {
                this.trackingPresenceGeneration = null;
            }
        }
    }

    private async trackPresenceInner(
        recovered: number,
        attempts: number,
        expectedGeneration: number,
    ): Promise<void> {
        for (let attempt = 1; attempt <= attempts; attempt++) {
            if (expectedGeneration !== this.channelGeneration) return;
            const channel = this.channel;
            if (!channel || channel.state !== 'joined') return;
            let status: string;
            try {
                status = await channel.track({
                    device_id: this.deviceId,
                    device_name: this.deviceName,
                    app_version: VERSION,
                    platform: process.platform
                });
            } catch (trackErr: any) {
                status = `threw: ${trackErr?.message}`;
            }

            // A newer channel may have replaced this one while track() awaited.
            // Never let a stale completion mutate reachability/capability state.
            if (
                expectedGeneration !== this.channelGeneration ||
                this.channel !== channel
            ) return;

            if (status === 'ok') {
                this.presenceTracked = true;
                console.log(`Presence tracked (device ${this.deviceId} visible as online)`);
                captureRemote('remote_channel_presence_tracked', { recoveredAfterAttempts: recovered }).catch(() => { });
                const broadcastSuppressed = this.broadcastSuppressedGeneration === expectedGeneration;
                if (!broadcastSuppressed) await this.setTransportCapable(true);
                if (!broadcastSuppressed && this.transportCapableWritten === true) this.stopDegradedCallPolling();
                else this.startDegradedCallPolling();
                return;
            }

            console.error(`Presence track not acknowledged (${status}) - attempt ${attempt}/${attempts}`);
            if (attempt < attempts) await this.sleep(500 * attempt);
        }

        if (expectedGeneration !== this.channelGeneration) return;
        this.presenceTracked = false;
        this.startDegradedCallPolling();
        console.error('Presence track failed after retries - reverting to the legacy transport tier');
        captureRemote('remote_channel_presence_track_error', { attempts }).catch(() => { });
        await this.setTransportCapable(false);
    }

    /**
     * The complete `capabilities` JSONB value. One place only: every write
     * replaces the whole column, so a second literal would silently drop keys.
     */
    private deviceSessionFence(): Record<string, any> {
        if (!this.deviceSessionLease) {
            throw new Error('Device session generation has not been acquired yet.');
        }
        return { [DEVICE_SESSION_CAPABILITY_KEY]: { generation: this.deviceSessionLease.generation } };
    }

    private capabilitiesPayload(broadcastCapable: boolean): Record<string, any> {
        // Reserved transport/version fields are owned here even if a malformed
        // local capability envelope happens to contain the same keys.
        const {
            app_version: _ignoredAppVersion,
            transport_broadcast_v1: _ignoredTransport,
            [DEVICE_SESSION_CAPABILITY_KEY]: _ignoredDeviceSession,
            ...registeredCapabilities
        } = this.deviceCapabilities;

        return {
            ...registeredCapabilities,
            app_version: VERSION,
            ...(this.deviceSessionLease ? { [DEVICE_SESSION_CAPABILITY_KEY]: this.deviceSessionLease } : {}),
            ...(broadcastCapable ? { transport_broadcast_v1: true } : {})
        };
    }

    /**
     * Advertise (or withdraw) the broadcast capability. Only true while genuinely
     * reachable that way — the server uses it to pick a transport, to read absent
     * presence as offline, and to choose the sweep tier, so every change must
     * re-arm the heartbeat.
     */
    private async setTransportCapable(capable: boolean): Promise<void> {
        await this.enqueueCapabilityWrite(async () => {
            if (!this.client || !this.deviceId) return;
            if (this.transportCapableWritten === capable) return; // no redundant writes
            try {
                const capabilities = this.capabilitiesPayload(capable);
                const { error } = await this.runDbQuery(
                    'setTransportCapable', CAPABILITY_WRITE_TIMEOUT_MS,
                    (signal) => this.client!
                        .from('mcp_devices')
                        .update({ capabilities })
                        .contains('capabilities', this.deviceSessionFence())
                        .eq('id', this.deviceId!)
                        .abortSignal(signal),
                );
                if (error) {
                    console.error('[DEBUG] Failed to update transport capability:', error.message);
                    return;
                }
                this.transportCapableWritten = capable;
                console.debug(`[DEBUG] Transport capability set to ${capable ? 'broadcast_v1' : 'legacy'}`);
                // Tier changed — move last_seen onto the cadence that tier's sweep
                // threshold expects (no-op if the heartbeat hasn't started yet).
                this.scheduleHeartbeat();
                // last_seen may already be past the 45s threshold now judging us,
                // so write once immediately rather than waiting out the interval.
                if (!capable && this.heartbeatDeviceId) {
                    this.updateHeartbeat(this.heartbeatDeviceId).catch(() => { /* logged inside */ });
                }
            } catch (error: any) {
                console.error('[DEBUG] Transport capability update threw:', error?.message);
            }
        });
    }

    private privateTransportReady(): boolean {
        return this.channel?.state === 'joined'
            && this.presenceTracked
            && this.transportCapableWritten === true;
    }

    private hardPrivateTransportFailure(error: unknown): boolean {
        const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
        const code = typeof record.code === 'string' ? record.code : '';
        const message = typeof record.message === 'string' ? record.message : String(error ?? '');
        return code === 'IncreaseConnectionPool' || /\bIncreaseConnectionPool\b/.test(message);
    }

    private quiescePrivateChannel(): void {
        const channel = this.channel;
        if (!channel || !this.client) return;
        this.channelGeneration += 1;
        this.channel = null;
        this.presenceTracked = false;
        // Local teardown only: stop Phoenix's own rejoin timer without creating
        // another server join while the hosted authorization pool is unhealthy.
        try { (channel as any).teardown?.(); } catch { /* best effort */ }
        try {
            const phoenixChannel = (channel as any).channelAdapter?.getChannel?.();
            phoenixChannel?.socket?.remove?.(phoenixChannel);
        } catch { /* best effort */ }
        try { (this.client as any).realtime?._remove?.(channel); } catch { /* best effort */ }
    }

    private handlePrivateTransportFailure(error?: unknown): void {
        this.presenceTracked = false;
        this.startDegradedCallPolling();
        if (!this.hardPrivateTransportFailure(error)) return;
        // Hard hosted authorization-pool failure: stop Phoenix's private-channel
        // auto-rejoin, but leave the legacy channel and shared socket untouched.
        this.quiescePrivateChannel();
        if (this.transportCapableWritten !== true) return;
        // This is a Realtime authorization-capacity failure, not an ordinary
        // half-open reconnect blip. Stop advertising a transport that cannot join.
        void this.setTransportCapable(false).catch((withdrawError: any) => {
            console.debug('[DEBUG] Immediate broadcast capability withdrawal failed:', withdrawError?.message);
        });
    }

    private rememberBroadcastCall(callId: string, receivedAtMs: number): void {
        this.recentBroadcastCalls.delete(callId);
        this.recentBroadcastCalls.set(callId, receivedAtMs);
        const cutoff = receivedAtMs - RECENT_BROADCAST_CALL_TTL_MS;
        for (const [id, seenAt] of this.recentBroadcastCalls) {
            if (seenAt >= cutoff && this.recentBroadcastCalls.size <= RECENT_BROADCAST_CALLS_MAX) break;
            this.recentBroadcastCalls.delete(id);
        }
    }

    private hasRecentBroadcastCall(callId: string, nowMs: number): boolean {
        const seenAt = this.recentBroadcastCalls.get(callId);
        if (seenAt === undefined) return false;
        if (nowMs - seenAt <= RECENT_BROADCAST_CALL_TTL_MS) return true;
        this.recentBroadcastCalls.delete(callId);
        return false;
    }

    private handleBroadcastDeliveryMiss(row: any, receivedAtMs: number): void {
        if (row?.metadata?.transport !== 'broadcast_v1') return;
        if (typeof row?.id === 'string' && this.hasRecentBroadcastCall(row.id, receivedAtMs)) return;
        const createdAtMs = Date.parse(String(row?.created_at ?? ''));
        if (!Number.isFinite(createdAtMs)) return;
        const lagMs = Math.max(0, receivedAtMs - createdAtMs);
        if (lagMs < BROADCAST_DELIVERY_MISS_MS) return;

        // The server chose Broadcast, but legacy Postgres Changes won only after
        // a large delay. This invalidates Broadcast delivery for this channel
        // generation, not its already-established Presence registration.
        this.broadcastSuppressedGeneration = this.channelGeneration;
        this.startDegradedCallPolling();
        if (this.transportCapableWritten === true) {
            void this.setTransportCapable(false).catch((error: any) => {
                console.debug('[DEBUG] Broadcast-miss capability withdrawal failed:', error?.message);
            });
        }

        const now = Date.now();
        if (now - this.lastBroadcastMissRecoveryAt < BROADCAST_MISS_RECOVERY_COOLDOWN_MS) return;
        this.lastBroadcastMissRecoveryAt = now;
        captureRemote('remote_channel_broadcast_delivery_miss', {
            call_id: row?.id, lagMs, state: this.channel?.state ?? null,
        }).catch(() => {});
        // Degraded mode is authoritative until the next manual process restart.
        // Do not create another private join from an observed delivery miss.
    }

    private degradedCallPollDelayMs(): number {
        return Date.now() < this.degradedCallPollBurstUntil
            ? DEGRADED_CALL_POLL_FAST_MS
            : DEGRADED_CALL_POLL_IDLE_MS;
    }

    private scheduleDegradedCallPoll(delayMs: number): void {
        if (this.shuttingDown || this.privateTransportReady() || this.degradedCallPollTimer || this.degradedCallPollInFlight) return;
        this.degradedCallPollTimer = setTimeout(() => {
            this.degradedCallPollTimer = null;
            void this.runDegradedCallPollLoop();
        }, delayMs);
        this.degradedCallPollTimer.unref?.();
    }

    private startDegradedCallPolling(): void {
        if (this.shuttingDown || this.privateTransportReady() || this.degradedCallPollTimer || this.degradedCallPollInFlight) return;
        this.degradedCallPollBurstUntil = Date.now() + DEGRADED_CALL_POLL_BURST_MS;
        this.scheduleDegradedCallPoll(0);
    }

    private stopDegradedCallPolling(): void {
        if (this.degradedCallPollTimer) clearTimeout(this.degradedCallPollTimer);
        this.degradedCallPollTimer = null;
        this.degradedCallPollBurstUntil = 0;
    }

    private async pollPendingCallsOnce(): Promise<number> {
        if (!this.client || !this.deviceId || this.shuttingDown) return 0;
        const startedAt = Date.now();
        const { data, error } = await this.runDbQuery<any>(
            'Poll degraded pending calls', DEGRADED_CALL_POLL_TIMEOUT_MS,
            (signal) => this.client!
                .from('mcp_remote_calls')
                .select('*')
                .eq('device_id', this.deviceId!)
                .eq('status', 'pending')
                .order('created_at', { ascending: true })
                .limit(DEGRADED_CALL_POLL_BATCH)
                .abortSignal(signal),
        );
        if (error) throw error;
        const rows = Array.isArray(data) ? data : [];
        const receivedAtMs = Date.now();
        const rowFetchMs = Math.max(0, receivedAtMs - startedAt);
        for (const row of rows) {
            if (!row || row.device_id !== this.deviceId || row.status !== 'pending') continue;
            this.dispatchToolCall({
                new: row,
                _remoteTiming: { inbound: 'degraded_poll', receivedAtMs, rowFetchMs },
            });
        }
        return rows.length;
    }

    private async runDegradedCallPollLoop(): Promise<void> {
        if (this.degradedCallPollInFlight || this.shuttingDown || this.privateTransportReady()) return;
        this.degradedCallPollInFlight = true;
        let nextDelay = this.degradedCallPollDelayMs();
        try {
            const count = await this.pollPendingCallsOnce();
            if (count > 0) {
                this.degradedCallPollBurstUntil = Date.now() + DEGRADED_CALL_POLL_BURST_MS;
                nextDelay = DEGRADED_CALL_POLL_FAST_MS;
            }
        } catch (error: any) {
            nextDelay = DEGRADED_CALL_POLL_IDLE_MS;
            if (process.env.DEBUG_MODE === 'true') {
                console.debug('[DEBUG] Degraded pending-call poll failed:', error?.message);
            }
        } finally {
            this.degradedCallPollInFlight = false;
            if (!this.shuttingDown && !this.privateTransportReady()) {
                this.scheduleDegradedCallPoll(nextDelay);
            }
        }
    }

    /** Strict minimal transport used only for live A/B latency testing. */
    private createMinimalLiveChannel(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.client || !this.user?.id || !this.onToolCall) {
                reject(new Error('Minimal live channel missing client/user/handler'));
                return;
            }
            let settled = false;
            const finish = (error?: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                error ? reject(error) : resolve();
            };
            const channel = this.client
                .channel('device_tool_call_queue')
                .on(
                    'postgres_changes' as any,
                    { event: 'INSERT', schema: 'public', table: 'mcp_remote_calls', filter: `user_id=eq.${this.user.id}` },
                    (payload: any) => this.dispatchToolCall(payload),
                );
            this.legacyChannel = channel;
            const timer = setTimeout(() => finish(new Error('Minimal live channel subscribe timed out')), 15_000);
            timer.unref?.();
            channel.subscribe((status: string, error: any) => {
                if (status === 'SUBSCRIBED') finish();
                else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    finish(error ?? new Error(`Minimal live channel ${status}`));
                }
            });
        });
    }

    async setMinimalInboundMode(mode: RemoteInboundMode): Promise<void> {
        if (!this.minimalLiveTest) return;
        const run = this.minimalInboundSwitch.then(() => this.applyMinimalInboundMode(mode));
        this.minimalInboundSwitch = run.catch(() => {});
        await run;
    }

    private async applyMinimalInboundMode(mode: RemoteInboundMode): Promise<void> {
        if (mode === this.minimalInboundMode) return;
        if (!this.deviceId || !this.user || !this.onToolCall) return;

        if (mode === 'broadcast_doorbell') {
            await this.createChannel();
            if (this.channel?.state !== 'joined' || !this.presenceTracked || this.transportCapableWritten !== true) {
                await this.removePrivateChannelForMinimalTest();
                throw new Error('Broadcast doorbell transport did not become reachable');
            }
            await this.removeLegacyChannel();
            this.minimalInboundMode = mode;
            console.log('⚙ INBOUND switched to broadcast_doorbell');
            return;
        }

        await this.createMinimalLiveChannel();
        await this.setTransportCapable(false);
        await this.removePrivateChannelForMinimalTest();
        this.minimalInboundMode = mode;
        console.log('⚙ INBOUND switched to postgres_changes');
    }

    private realtimeChannelRegistered(channel: RealtimeChannel): boolean {
        if (!this.client) return false;
        try { return this.client.getChannels().includes(channel); } catch { return false; }
    }

    private async removeRealtimeChannel(channel: RealtimeChannel, label: string): Promise<void> {
        if (!this.client) return;
        let status: unknown = 'not_attempted';
        try { status = await this.client.removeChannel(channel); }
        catch (error: any) { status = error?.message || 'threw'; }
        if (!this.realtimeChannelRegistered(channel)) return;

        // realtime-js only tears down after an acknowledged leave. If leave returns
        // error, the wrapper and Phoenix channel can remain in their registries;
        // channel(sameTopic) then reuses that errored object and subscribe() is a no-op.
        console.debug(`[DEBUG] Evicting stale Realtime channel ${label} after remove status: ${String(status)}`);
        try { (channel as any).teardown?.(); } catch { /* best effort */ }
        try {
            const phoenixChannel = (channel as any).channelAdapter?.getChannel?.();
            phoenixChannel?.socket?.remove?.(phoenixChannel);
        } catch { /* best effort */ }
        try { (this.client as any).realtime?._remove?.(channel); } catch { /* best effort */ }

        if (this.realtimeChannelRegistered(channel)) {
            throw new Error(`Realtime channel registry retained stale ${label} after remove status ${String(status)}`);
        }
    }

    private async removePrivateChannelForMinimalTest(): Promise<void> {
        const channel = this.channel;
        if (!channel || !this.client) return;
        this.channelGeneration += 1;
        if (this.channel === channel) this.channel = null;
        this.presenceTracked = false;
        await this.removeRealtimeChannel(channel, 'private-minimal');
    }

    /**
     * Legacy postgres_changes listener on its own public channel. Best-effort:
     * failures are logged, never thrown. Removed at the flip (009).
     */
    private createLegacyChannel(): void {
        if (!this.client || !this.user?.id || !this.deviceId) return;
        try {
            this.legacyChannel = this.client
                .channel('device_tool_call_queue')
                .on(
                    'postgres_changes' as any,
                    {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'mcp_remote_calls',
                        filter: `device_id=eq.${this.deviceId}`
                    },
                    (payload: any) => {
                        const receivedAtMs = Date.now();
                        console.debug('[DEBUG] Realtime event received, payload:', payload?.new?.id);
                        this.handleBroadcastDeliveryMiss(payload?.new, receivedAtMs);
                        this.dispatchToolCall({
                            ...payload,
                            _remoteTiming: { inbound: 'postgres_changes', receivedAtMs, rowFetchMs: 0 },
                        });
                    }
                )
                .subscribe((status: string) => {
                    console.debug(`[DEBUG] Legacy channel status: ${status}`);
                });
        } catch (error: any) {
            console.debug('[DEBUG] Legacy channel subscribe failed (doorbell path unaffected):', error?.message);
        }
    }

    /** Tear down the legacy channel (best effort). */
    private async removeLegacyChannel(): Promise<void> {
        const channel = this.legacyChannel;
        if (!channel || !this.client) return;
        await this.removeRealtimeChannel(channel, 'legacy');
        // A stale teardown must never clear a newer replacement channel.
        if (this.legacyChannel === channel) this.legacyChannel = null;
    }

    /** Create and subscribe the private channel (initial join and recreation). */
    private createChannel(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.client || !this.user?.id || !this.onToolCall || !this.deviceId) {
                // deviceId is the presence KEY; a null key gets a random one and
                // the server's lookup by device id silently misses.
                console.debug('[DEBUG] createChannel() failed - missing prerequisites');
                return reject(new Error('Client not initialized or missing subscription parameters'));
            }

            let settled = false;
            let settleTimer: NodeJS.Timeout | undefined;
            const finish = (error?: unknown) => {
                if (settled) return;
                settled = true;
                if (settleTimer) clearTimeout(settleTimer);
                if (error) reject(error);
                else resolve();
            };

            // Private per-user channel: new_call doorbells + this device's
            // Presence, keyed by device id.
            const channelName = `user:${this.user.id}`;
            console.debug(`[DEBUG] Creating channel: ${channelName}`);
            const generation = ++this.channelGeneration;
            this.broadcastSuppressedGeneration = null;
            const channel = this.client.channel(channelName, {
                // ack: true — without it send() resolves 'ok' once the frame hits
                // the socket, making notifyResult's status check dead code.
                config: {
                    private: true,
                    broadcast: { ack: true },
                    // Non-null: the guard above rejects when !deviceId.
                    presence: { key: this.deviceId, enabled: true }
                }
            })
                .on(
                    'broadcast',
                    { event: 'new_call' },
                    ({ payload }: any) => {
                        if (!isCurrentChannel()) return;
                        this.onDoorbell(payload).catch((e: any) => {
                            console.error('[DEBUG] Doorbell handling failed:', e?.message);
                        });
                    }
                );
            this.channel = channel;
            const isCurrentChannel = () =>
                this.channelGeneration === generation && this.channel === channel;
            settleTimer = setTimeout(() => {
                // Invalidate late callbacks, but keep the channel object reachable so
                // the next recreate can remove it from the Realtime registry.
                const timeoutError = new Error(`Tool call channel did not settle within ${CHANNEL_SUBSCRIBE_SETTLE_TIMEOUT_MS}ms`);
                if (isCurrentChannel()) {
                    this.channelGeneration += 1;
                    this.handlePrivateTransportFailure(timeoutError);
                }
                finish(timeoutError);
            }, CHANNEL_SUBSCRIBE_SETTLE_TIMEOUT_MS);
            settleTimer.unref?.();

            channel.subscribe((status: string, err: any) => {
                    if (!isCurrentChannel()) {
                        console.debug(`[DEBUG] Ignoring stale channel generation ${generation} status: ${status}`);
                        finish(new Error(`Tool call channel generation ${generation} was superseded.`));
                        return;
                    }
                    // Debug: Log all subscription status events
                    console.debug(`[DEBUG] Channel subscription status: ${status}${err ? ' (error: ' + (err?.message || err) + ')' : ''} — ${this.connState()}`);

                    if (status === 'SUBSCRIBED') {
                        const recovered = this.reconnectAttempt;
                        this.reconnectAttempt = 0;
                        console.log(`✅ Channel subscribed${recovered > 0 ? ` (recovered after ${recovered} attempt${recovered === 1 ? '' : 's'})` : ''}`);
                        // Update device status on successful connection (queued, so
                        // it can't be overtaken by a teardown's status write).
                        this.queueStatusWrite('online');
                        // Presence is the live signal dispatch reads, so resolve
                        // only once it lands — otherwise registerDevice() reports
                        // "Device ready" while still undispatchable.
                        this.trackPresenceWithRetry(recovered, 3, generation)
                            .catch(() => { /* logged inside */ })
                            .finally(() => finish());
                    } else if (status === 'CHANNEL_ERROR') {
                        // CHANNEL_ERROR is the only status carrying a real error message.
                        console.error(`❌ Channel error: ${err?.message || 'unknown'} — ${this.connState()}`);
                        this.handlePrivateTransportFailure(err);
                        this.syncReachabilityStatus();
                        // Fires on ordinary network faults too — filter on the
                        // error text to isolate an 008 misconfiguration.
                        captureRemote('remote_channel_subscription_error', { error: err?.message || 'Channel error' }).catch(() => { });
                        finish(err || new Error('Failed to initialize tool call channel subscription'));
                    } else if (status === 'TIMED_OUT') {
                        const timeoutError = new Error('Tool call channel subscription timed out');
                        console.error(`⏱️ Channel subscription timed out, Reconnecting... — ${this.connState()}`);
                        this.handlePrivateTransportFailure(timeoutError);
                        this.syncReachabilityStatus();
                        captureRemote('remote_channel_subscription_timeout', { attempt: this.reconnectAttempt }).catch(() => { });
                        finish(timeoutError);
                    } else if (status === 'CLOSED') {
                        // Settle the promise so an in-flight recreateChannel() can't await
                        // forever (which would wedge the re-entrancy guard / watchdog).
                        const closedError = new Error('Tool call channel closed during subscribe');
                        console.warn(`⚠️ Channel closed — ${this.connState()}`);
                        this.handlePrivateTransportFailure(closedError);
                        this.syncReachabilityStatus();
                        finish(closedError);
                    }
                });
        });
    }

    /**
     * Wake the server after a terminal row is committed. Reuse the already joined
     * Realtime channel: this is a signal only, never an owner of result durability.
     */
    async signalResultAvailable(callId: string): Promise<RemoteResultWakeAck> {
        const channel = this.channel;
        if (!channel || channel.state !== 'joined') {
            if (process.env.DEBUG_MODE === 'true') {
                console.debug('[DEBUG] Result wake skipped — realtime channel not joined:', callId);
            }
            return { attempted: false, status: 'skipped', durationMs: 0 };
        }
        const wakeStartedAt = Date.now();
        try {
            const status = await channel.send(
                { type: 'broadcast', event: 'result', payload: { call_id: callId } },
                { timeout: 1_000 },
            );
            const durationMs = Date.now() - wakeStartedAt;
            console.log(`↗ RESULT WAKE ${callId.slice(0, 8)} ${status} ${durationMs}ms`);
            if (status !== 'ok' && process.env.DEBUG_MODE === 'true') {
                console.debug(`[DEBUG] Result wake not acknowledged (${status}):`, callId);
            }
            return { attempted: true, status, durationMs };
        } catch (error: any) {
            const durationMs = Date.now() - wakeStartedAt;
            console.log(`↗ RESULT WAKE ${callId.slice(0, 8)} error ${durationMs}ms`);
            console.debug('[DEBUG] Result wake failed; recovery remains authoritative:', error?.message);
            void captureRemote('remote_channel_result_wake_failed', {
                call_id: callId, error: error?.message || String(error),
            });
            return { attempted: true, status: 'error', durationMs };
        }
    }

    /** Hand a call to device.ts, observing the rejection — the handler is async
     * and an unhandled rejection terminates the process. */
    private dispatchToolCall(payload: any): void {
        try {
            const maybePromise = this.onToolCall?.(payload) as unknown;
            if (maybePromise instanceof Promise) {
                maybePromise.catch((e: any) => {
                    console.error('[DEBUG] Tool call handler rejected:', e?.message);
                });
            }
        } catch (e: any) {
            console.error('[DEBUG] Tool call handler threw:', e?.message);
        }
    }

    /**
     * Handle a 'new_call' doorbell. It carries ids only; the row is fetched by
     * primary key and fed through the same handler as a postgres_changes
     * payload, so device.ts stays transport-agnostic.
     */
    private async onDoorbell(payload: any): Promise<void> {
        const receivedAtMs = Date.now();
        const callId = payload?.call_id;
        if (!callId) return;
        if (payload?.device_id && payload.device_id !== this.deviceId) {
            console.debug('[DEBUG] Ignoring doorbell for different device');
            return;
        }

        // Not a telemetry event on purpose: ~126k/day in prod. Transport usage
        // is already segmentable server-side via metadata.transport.
        console.debug('[DEBUG] Doorbell received for call:', callId);
        // Record the signal before the REST row fetch. A later postgres_changes copy
        // is normal transition duplication and must never trigger transport repair.
        this.rememberBroadcastCall(callId, receivedAtMs);

        if (!this.client) return;

        // Retry on transient failures (a REST blip while the socket stays
        // healthy). Post-flip this fetch is the only way we learn about a call,
        // so a hiccup must not cost a 5-minute timeout.
        let row: any = null;
        let lastError: any = null;
        for (const delayMs of [0, 500, 1500]) {
            if (delayMs > 0) await this.sleep(delayMs);
            try {
                const { data, error } = await runWithAbortableTimeout(
                    async (signal) => await this.client!
                        .from('mcp_remote_calls')
                        .select('*')
                        .eq('id', callId)
                        .abortSignal(signal)
                        .maybeSingle(),
                    REMOTE_CALL_FETCH_TIMEOUT_MS,
                    `Doorbell row fetch ${callId}`
                );
                if (!error) {
                    row = data;
                    lastError = null;
                    break;
                }
                lastError = error;
            } catch (error: any) {
                lastError = error;
            }
            console.debug(`[DEBUG] Doorbell row fetch attempt failed for ${callId}: ${lastError?.message ?? lastError} — retrying`);
        }

        if (lastError) {
            console.error(`[DEBUG] Doorbell row fetch failed for ${callId} after retries:`, lastError.message);
            await captureRemote('remote_channel_doorbell_fetch_error', { error: lastError });
            return;
        }
        if (!row) {
            // Already claimed and deleted, or cleanup raced delivery. Not
            // retried: the row is always inserted before the doorbell is sent.
            await captureRemote('remote_channel_doorbell_row_missing', { call_id: callId });
            return;
        }
        // Optimization, not a guard — saves a hop when the legacy path already
        // claimed this. Exactly-once lives in device.ts (seenCallIds + DB claim).
        if (row.status !== 'pending') {
            console.debug('[DEBUG] Doorbell call already claimed via legacy path:', callId);
            return;
        }

        // Same payload shape as postgres_changes ({ new: row }), plus local-only
        // transport timing that is never persisted into remote row metadata.
        this.dispatchToolCall({
            new: row,
            _remoteTiming: {
                inbound: 'broadcast_doorbell',
                receivedAtMs,
                rowFetchMs: Math.max(0, Date.now() - receivedAtMs),
            },
        });
    }

    /**
     * Compact connection state for logs — e.g. "socket=open(1) ch=errored attempt=3".
     * readyState 1=OPEN (a 1 while joins keep failing = a half-open socket being reused),
     * 3=CLOSED, '-'=no socket. Reads realtime-js internals defensively; never throws.
     */
    private connState(): string {
        let socket = '?';
        try {
            const rt: any = (this.client as any)?.realtime;
            socket = `${rt?.connectionState?.() ?? '?'}(${rt?.conn?.readyState ?? '-'})`;
        } catch { /* best effort */ }
        return `socket=${socket} ch=${this.channel?.state ?? '-'} attempt=${this.reconnectAttempt}`;
    }

    /**
     * Check if channel is connected, recreate if not.
     */
    private checkConnectionHealth(): void {
        if (!this.channel || !this.client || !this.user?.id || !this.onToolCall) {
            return;
        }

        const state = this.channel.state;

        // Debug: Log current channel state (only if changed)
        if (!this.lastChannelState || this.lastChannelState !== state) {
            console.debug(`[DEBUG] channel state: ${state} — ${this.connState()}`);
            this.lastChannelState = state;
        }

        // 'joined' = healthy. Clear the joining-overstay timer.
        if (state === 'joined') {
            this.joiningSince = null;
            if (this.privateTransportReady()) {
                this.stopDegradedCallPolling();
                return;
            }
            this.startDegradedCallPolling();
            // Self-heal a failed presence publish: the channel is up, so nothing
            // else will ever retry (SUBSCRIBED won't fire again), and without
            // presence the server reports this healthy device as offline.
            if (
                !this.presenceTracked &&
                this.deviceId &&
                this.trackingPresenceGeneration !== this.channelGeneration
            ) {
                console.debug('[DEBUG] Channel joined but presence not tracked - retrying track()');
                this.trackPresenceWithRetry(0, 1, this.channelGeneration).catch(() => { /* logged inside */ });
            } else if (
                this.presenceTracked &&
                this.transportCapableWritten !== true &&
                this.broadcastSuppressedGeneration !== this.channelGeneration
            ) {
                // Presence succeeded but its capability PATCH may have failed. Retry
                // only when this generation was not intentionally degraded after a
                // delivery miss; Presence alone is not evidence Broadcast recovered.
                this.setTransportCapable(true).catch(() => { /* logged inside */ });
            }
            return;
        }

        // 'joining' is transitional — let realtime-js's rejoin backoff converge
        // rather than tearing the channel down mid-join. But bound it: a
        // half-open socket parks the channel here indefinitely, so past
        // JOINING_WEDGE_TIMEOUT_MS force a recreate, the only path that
        // disconnect()s the dead socket.
        if (state === 'joining') {
            this.startDegradedCallPolling();
            const now = Date.now();
            if (this.joiningSince === null) this.joiningSince = now;
            const stuckMs = now - this.joiningSince;
            if (stuckMs < JOINING_WEDGE_TIMEOUT_MS) return;
            console.debug(`[DEBUG] ⚠️ Channel stuck 'joining' ${Math.round(stuckMs / 1000)}s - forcing recreate — ${this.connState()}`);
            captureRemote('remote_channel_joining_wedge', { stuckMs, attempt: this.reconnectAttempt });
            this.joiningSince = null;
            this.recreateChannel();
            return;
        }

        this.startDegradedCallPolling();
        this.joiningSince = null;

        // realtime-js already owns errored-channel recovery via its rejoin timer.
        // Do not layer our destructive recovery over the same transient signal.
        if (state === 'errored' || state === 'leaving') {
            captureRemote('remote_channel_state_health', { state, attempt: this.reconnectAttempt, owner: 'realtime-js' });
            return;
        }

        // CLOSED has no automatic channel-rejoin owner; replace only that case.
        captureRemote('remote_channel_state_health', { state, attempt: this.reconnectAttempt, owner: 'device' });
        console.debug(`[DEBUG] ⚠️ Channel state '${state}' requires replacement — ${this.connState()}`);
        this.recreateChannel();
    }

    /**
     * Run an async op but reject if it doesn't settle within `ms`, so a hung await
     * can't leave isRecreatingChannel stuck true and disable the watchdog. Mirrors
     * closeWithTimeout() in desktop-commander-integration.ts.
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Block until realtime-js has left the 'disconnecting' state it enters on
     * disconnect(), so the next subscribe() actually dials a socket instead of
     * hitting connect()'s early return. Bounded either way — worst case we cost
     * a recreate SOCKET_SETTLE_MAX_MS.
     */
    private async waitForSocketSettled(): Promise<void> {
        const realtime = (this.client as any)?.realtime;
        // No predicate to poll (older/newer client): wait out the internal
        // fallback timer blind rather than guess at the state.
        if (typeof realtime?.isDisconnecting !== 'function') {
            await this.sleep(SOCKET_SETTLE_MAX_MS);
            return;
        }
        const deadline = Date.now() + SOCKET_SETTLE_MAX_MS;
        while (realtime.isDisconnecting() && Date.now() < deadline) {
            await this.sleep(SOCKET_SETTLE_POLL_MS);
        }
    }

    private async withTimeout<T>(op: () => Promise<T>, ms: number, name: string): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                op(),
                new Promise<T>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * Recreate the channel by destroying old one and creating fresh instance.
     */
    private async recreateChannel(force = false): Promise<void> {
        if (!this.client || !this.user?.id || !this.onToolCall) {
            console.warn('Cannot recreate channel - missing parameters');
            console.debug('[DEBUG] recreateChannel() aborted - missing prerequisites');
            return;
        }

        // FIX: re-entrancy guard so a 10s health tick can't stack a second recreate
        // on top of an in-flight one.
        if (this.isRecreatingChannel) {
            console.debug('[DEBUG] recreateChannel() skipped - already in progress');
            return;
        }
        this.isRecreatingChannel = true;
        const operationGeneration = ++this.recreateOperationGeneration;
        const isCurrentOperation = () =>
            this.recreateOperationGeneration === operationGeneration && !this.shuttingDown;
        this.reconnectAttempt++;
        this.startDegradedCallPolling();

        // Create fresh channel
        console.log(`🔄 Recreating channel... (attempt ${this.reconnectAttempt}) — ${this.connState()}`);

        try {
            // Jittered backoff so a fleet-wide event doesn't stampede every
            // device into reconnecting at once. ~1-3s rising to ~15-45s.
            const backoffMs = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5)) * (0.5 + Math.random());
            console.debug(`[DEBUG] Reconnect backoff: ${Math.round(backoffMs)}ms`);
            await this.sleep(backoffMs);
            if (!isCurrentOperation()) return;

            // realtime-js runs its own rejoin timer, and the backoff above gives
            // it a window to win: the old channel can come back 'joined' while we
            // slept. Destroying a healthy channel would cause a pointless outage
            // cycle — bail out instead (observed live on staging, 2026-07-23).
            if (!force && this.channel?.state === 'joined') {
                console.log(`✅ Channel self-healed during backoff — skipping recreate — ${this.connState()}`);
                return; // finally-block below clears the re-entrancy guard
            }

            // Cap the whole recreate: a never-settling await (e.g. a subscribe that only
            // ever emits CLOSED) must not pin isRecreatingChannel=true and silently disable
            // the 10s watchdog. On timeout we reject -> catch -> finally clears the guard.
            await this.withTimeout(async () => {
                // This recovery owns only the private channel. Never tear down the
                // legacy safety net or the shared Realtime socket here.
                if (!isCurrentOperation()) return;
                const channelToRemove = this.channel;
                if (channelToRemove) {
                    this.channelGeneration += 1;
                    if (this.channel === channelToRemove) this.channel = null;
                    this.presenceTracked = false;
                    await this.removeRealtimeChannel(channelToRemove, 'private');
                    if (!isCurrentOperation()) return;
                }

                // RealtimeClient.channel(topic) reuses an existing wrapper. If a
                // previous leave failed, evict every stale same-topic wrapper from
                // both RealtimeClient and Phoenix registries before creating one
                // replacement.
                const privateTopic = `realtime:user:${this.user!.id}`;
                let staleChannels: RealtimeChannel[] = [];
                try {
                    staleChannels = this.client!.getChannels().filter((candidate) => candidate.topic === privateTopic);
                } catch { /* older client shape: nothing else to clean */ }
                for (const stale of staleChannels) {
                    await this.removeRealtimeChannel(stale, 'private-stale');
                    if (!isCurrentOperation()) return;
                }

                console.debug('[DEBUG] Calling createChannel() for private replacement');
                await this.createChannel();
                if (!isCurrentOperation()) return;
            }, RECREATE_TIMEOUT_MS, 'recreateChannel');
        } catch (err: any) {
            if (this.recreateOperationGeneration === operationGeneration) {
                this.recreateOperationGeneration += 1;
            }
            captureRemote('remote_channel_recreate_error', { errMsg: err?.message, attempt: this.reconnectAttempt });
            console.debug(`[DEBUG] Channel recreation failed: ${err?.message} — ${this.connState()}`);
            // Sustained failure: stop promising a transport we can't deliver, or
            // the server's presence overlay reports this device offline
            // authoritatively and overrides `status`.
            if (this.reconnectAttempt >= TRANSPORT_WITHDRAW_AFTER_ATTEMPTS) {
                // Bounded, in its own try: this catch block is outside
                // RECREATE_TIMEOUT_MS, so a hanging PATCH would pin
                // isRecreatingChannel and disable the watchdog.
                try {
                    await this.withTimeout(
                        () => this.setTransportCapable(false),
                        CAPABILITY_WRITE_TIMEOUT_MS,
                        'withdrawTransportCapability'
                    );
                } catch (withdrawErr: any) {
                    // The next failed recreate retries; the flag only advances
                    // on a confirmed write, so nothing is lost.
                    console.debug(`[DEBUG] Capability withdrawal did not complete: ${withdrawErr?.message}`);
                }
            }
        } finally {
            this.isRecreatingChannel = false;
        }
    }

    async markCallExecutingMinimal(callId: string): Promise<void> {
        if (!this.client) throw new Error('Client not initialized');
        const startedAt = Date.now();
        const { error } = await this.runDbQuery(
            `Minimal mark executing ${callId}`, REMOTE_CALL_CLAIM_TIMEOUT_MS,
            (signal) => this.client!
                .from('mcp_remote_calls')
                .update({ status: 'executing' })
                .eq('id', callId)
                .abortSignal(signal),
        );
        if (error) throw error;
        console.log(`↗ MINIMAL EXEC ${callId.slice(0, 8)} ${Date.now() - startedAt}ms`);
    }

    async updateCallResultMinimal(
        callId: string, status: string, result: unknown | null, errorMessage: string | null,
    ): Promise<void> {
        if (!this.client) throw new Error('Client not initialized');
        const updateData: Record<string, unknown> = { status, completed_at: new Date().toISOString() };
        if (result !== null) updateData.result = result;
        if (errorMessage !== null) updateData.error_message = errorMessage;
        const startedAt = Date.now();
        const { error } = await this.runDbQuery(
            `Minimal terminal result ${callId}`, REMOTE_CONTROL_QUERY_TIMEOUT_MS,
            (signal) => this.client!
                .from('mcp_remote_calls')
                .update(updateData)
                .eq('id', callId)
                .abortSignal(signal),
        );
        if (error) throw error;
        console.log(`↗ MINIMAL RESULT ${callId.slice(0, 8)} ${Date.now() - startedAt}ms`);
    }

    private async readCallClaimState(
        callId: string,
        timeoutMs = REMOTE_CALL_CLAIM_RECONCILE_TIMEOUT_MS,
    ): Promise<any | null> {
        const { data, error } = await this.runDbQuery(
            `Read call claim state ${callId}`, timeoutMs,
            (signal) => this.client!
                .from('mcp_remote_calls')
                .select('status, metadata, result, error_message')
                .eq('id', callId)
                .abortSignal(signal)
                .maybeSingle(),
        );
        if (error) throw error;
        return data;
    }

    /**
     * Atomically claim pending -> executing. The claim token is written in the
     * same UPDATE so a lost HTTP response is recoverable: read-back can tell
     * whether THIS process won instead of guessing/failing open.
     */
    async markCallExecuting(callId: string, metadata: any = null): Promise<boolean> {
        if (!this.client) throw new Error('Client not initialized');
        const claimToken = randomUUID();
        const baseMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? stripNullBytes(metadata)
            : {};
        const claimMetadata = { ...baseMetadata, [CLAIM_METADATA_KEY]: claimToken };
        let lastError: any = null;

        for (let attempt = 1; attempt <= REMOTE_CALL_CLAIM_ATTEMPTS; attempt++) {
            try {
                const { data, error } = await this.runDbQuery(
                    `Mark call executing ${callId}`, REMOTE_CALL_CLAIM_TIMEOUT_MS,
                    (signal) => this.client!
                        .from('mcp_remote_calls')
                        .update({ status: 'executing', metadata: claimMetadata })
                        .eq('id', callId)
                        .eq('status', 'pending')
                        .select('id, metadata')
                        .abortSignal(signal),
                );
                if (error) throw error;
                if (data && data.length > 0) {
                    this.callClaimTokens.set(callId, claimToken);
                    this.callClaimMetadata.set(callId, claimMetadata);
                    console.debug('[DEBUG] Call marked executing:', callId);
                    return true;
                }

                const row = await this.readCallClaimState(callId);
                const owner = row?.metadata?.[CLAIM_METADATA_KEY];
                if (row?.status === 'executing' && owner === claimToken) {
                    this.callClaimTokens.set(callId, claimToken);
                    this.callClaimMetadata.set(callId, claimMetadata);
                    return true;
                }
                console.debug('[DEBUG] Call already claimed (duplicate delivery), skipping:', callId);
                return false;
            } catch (claimError: any) {
                lastError = claimError;
                // The UPDATE may have committed even if its HTTP response was
                // lost. Reconcile ownership before retrying or giving up.
                try {
                    const row = await this.readCallClaimState(callId);
                    const owner = row?.metadata?.[CLAIM_METADATA_KEY];
                    if (row?.status === 'executing' && owner === claimToken) {
                        this.callClaimTokens.set(callId, claimToken);
                        this.callClaimMetadata.set(callId, claimMetadata);
                        console.debug('[DEBUG] Reconciled ambiguous claim as ours:', callId);
                        return true;
                    }
                    if (row && row.status !== 'pending') {
                        console.debug('[DEBUG] Reconciled ambiguous claim as owned elsewhere:', callId);
                        return false;
                    }
                } catch (reconcileError: any) {
                    lastError = new Error(`${claimError?.message || claimError}; reconcile failed: ${reconcileError?.message || reconcileError}`);
                }
                if (attempt < REMOTE_CALL_CLAIM_ATTEMPTS) await this.sleep(250 * attempt);
            }
        }

        console.error('[DEBUG] Failed to establish call claim ownership:', lastError?.message);
        await captureRemote('remote_channel_mark_call_executing_error', { error: lastError, callId });
        throw lastError ?? new Error(`Could not establish claim ownership for ${callId}`);
    }

    getCurrentUserId(): string | null {
        return this.user?.id ?? null;
    }

    getCallClaimToken(callId: string): string | null {
        return this.callClaimTokens.get(callId) ?? null;
    }

    getCallClaimMetadata(callId: string): Record<string, unknown> | null {
        const metadata = this.callClaimMetadata.get(callId);
        return metadata ? { ...metadata } : null;
    }

    releaseCallClaim(callId: string): void {
        this.callClaimTokens.delete(callId);
        this.callClaimMetadata.delete(callId);
    }

    /**
     * Reachable by SOME transport — the private channel or, during the
     * transition, the independent legacy one. Gates the heartbeat and `status`:
     * asking only about the private channel starves last_seen for a device whose
     * legacy channel is fine, and the 45s sweep then blacks it out.
     * Collapses to a single check at the flip (009).
     */
    private isReachable(): boolean {
        return this.channel?.state === 'joined' || this.legacyChannel?.state === 'joined';
    }

    /**
     * Set `status` from actual reachability. `status` is transport-agnostic (the
     * server filters on it), so it must not follow one channel's health — the
     * private channel's error path re-fires on every rejoin and would oscillate
     * the row against the heartbeat. Same predicate as the heartbeat gate.
     */
    private syncReachabilityStatus(): void {
        this.queueStatusWrite(this.isReachable() ? 'online' : 'offline');
    }

    /**
     * Serialize the channel-callback status writes. They fire from un-awaited
     * callbacks, and inside recreateChannel() a teardown's 'offline' and the
     * fresh join's 'online' land ~100-300ms apart — unordered, 'offline' can win
     * and leave a healthy device undispatchable until the next heartbeat.
     *
     * Not the single writer: updateHeartbeat, registerDevice and setOffline's
     * subprocess write status directly, so this is not total ordering.
     */
    private queueStatusWrite(status: 'online' | 'offline'): void {
        // After teardown begins, setOffline() owns the final status write.
        if (this.shuttingDown) {
            console.debug(`[DEBUG] Status write '${status}' suppressed — teardown in progress`);
            return;
        }
        this.statusWriteChain = this.statusWriteChain
            .then(() => (this.deviceId ? this.setOnlineStatus(this.deviceId, status) : undefined))
            .catch((e: any) => {
                console.error('[DEBUG] Status write failed:', e?.message);
            });
    }

    /**
     * Heartbeat cadence for the tier this device is CURRENTLY in. Follows the
     * capability flag (what the server actually tiers its sweep on), not the
     * build — see LEGACY_HEARTBEAT_INTERVAL.
     */
    private heartbeatIntervalMs(): number {
        return this.transportCapableWritten === true
            ? CAPABLE_HEARTBEAT_INTERVAL
            : LEGACY_HEARTBEAT_INTERVAL;
    }

    async updateHeartbeat(deviceId: string) {
        if (!this.client) return;
        // This write asserts status:'online' too, so it MUST respect the
        // shutdown gate — otherwise a heartbeat firing (or in flight) as SIGINT
        // lands can be applied after setOffline()'s subprocess write and leave
        // an exited process marked online with a fresh last_seen, which for a
        // capable device the sweep then cannot age out for a full tier window.
        if (this.shuttingDown) {
            console.debug('[DEBUG] Skipping heartbeat write — shutting down');
            return;
        }
        try {
            // Skip the write entirely when no transport is up. Bumping last_seen
            // on a deaf device would keep its row perpetually young, so the
            // server's staleness sweep could never age it out and correct a
            // stale 'online' — and whenever presence is unavailable (kill
            // switch, wedged socket) that stale row is exactly what dispatch
            // falls back to. Staying silent lets the sweep do its job.
            if (!this.isReachable()) {
                console.debug('[DEBUG] Skipping heartbeat write — no transport joined; letting the row age out');
                return;
            }

            const { error } = await this.runDbQuery(
                'updateHeartbeat', REMOTE_HEARTBEAT_WRITE_TIMEOUT_MS,
                (signal) => this.client!
                    .from('mcp_devices')
                    .update({ last_seen: new Date().toISOString(), status: 'online' })
                    .contains('capabilities', this.deviceSessionFence())
                    .eq('id', deviceId)
                    .abortSignal(signal),
            );

            if (error) {
                console.error('[DEBUG] Heartbeat update failed:', error.message);
                await captureRemote('remote_channel_heartbeat_error', { error });
            } else {
                console.debug('[DEBUG] last_seen bookkeeping write ok:', deviceId);
            }
        } catch (error: any) {
            console.error('Heartbeat failed:', error.message);
            await captureRemote('remote_channel_heartbeat_error', { error });
        }
    }

    startHeartbeat(deviceId: string) {
        console.debug('[DEBUG] Starting heartbeat for device:', deviceId);
        this.heartbeatDeviceId = deviceId;
        this.connectionCheckInterval = setInterval(() => {
            this.checkConnectionHealth();
        }, 10000);

        // Bookkeeping last_seen write. Self-rescheduling rather than a fixed
        // setInterval so the cadence can follow the tier: a device that
        // withdraws the capability flag must fall back to the fast legacy
        // cadence immediately, not 30 minutes later.
        this.scheduleHeartbeat();
        console.debug(`[DEBUG] Heartbeat started - connectionCheck: 10s, last_seen: ${this.heartbeatIntervalMs()}ms`);
    }

    /** Arm (or re-arm) the last_seen timer at the current tier's cadence. */
    private scheduleHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearTimeout(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (!this.heartbeatDeviceId) return;
        this.heartbeatInterval = setTimeout(async () => {
            if (this.heartbeatDeviceId) {
                await this.updateHeartbeat(this.heartbeatDeviceId);
            }
            this.scheduleHeartbeat(); // re-read the tier every tick
        }, this.heartbeatIntervalMs());
    }

    stopHeartbeat() {
        this.heartbeatDeviceId = null;
        if (this.heartbeatInterval) {
            clearTimeout(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.connectionCheckInterval) {
            clearInterval(this.connectionCheckInterval);
            this.connectionCheckInterval = null;
        }
    }

    async setOnlineStatus(deviceId: string, status: 'online' | 'offline') {
        if (!this.client) return;

        // Only log if status changed
        if (this.lastDeviceStatus !== status) {
            console.log(`🔌 Device marked as ${status}`);
            this.lastDeviceStatus = status;
        }

        const { error } = await this.runDbQuery(
            `setOnlineStatus:${status}`, REMOTE_CONTROL_QUERY_TIMEOUT_MS,
            (signal) => this.client!
                .from('mcp_devices')
                .update({ status: status, last_seen: new Date().toISOString() })
                .contains('capabilities', this.deviceSessionFence())
                .eq('id', deviceId)
                .abortSignal(signal),
        );

        if (error) {
            console.error(`[DEBUG] Failed to set status ${status}:`, error.message);
            if (status == "online") {
                console.error('Failed to update device status:', error.message);
            }
            await captureRemote('remote_channel_status_update_error', { error, status });
            return;
        } else {
            console.debug(`[DEBUG] Device status set to ${status}`);
        }

        // console.log(status === 'online' ? `🔌 Device marked as ${status}` : `❌ Device marked as ${status}`);
    }

    async setOffline(deviceId: string | undefined) {
        if (!deviceId || !this.client) {
            console.debug('[DEBUG] setOffline() skipped - no deviceId or client');
            return;
        }

        if (!this.deviceSessionLease) {
            console.error('[DEBUG] setOffline() skipped - no owned device session generation');
            return;
        }

        console.debug('[DEBUG] setOffline() initiating blocking update for device:', deviceId);

        try {
            // Shutdown must never enter Auth refresh/storage machinery. The token
            // owner already tracks every accepted session rotation in memory.
            const session = this.tokens.snapshot();
            if (!session?.access_token) {
                console.error('❌ No valid session for offline update');
                console.debug('[DEBUG] Session data missing or invalid');
                return;
            }

            // Get Supabase config from client
            const supabaseUrl = (this.client as any).supabaseUrl;
            const supabaseKey = (this.client as any).supabaseKey;

            if (!supabaseUrl || !supabaseKey) {
                console.error('❌ Missing Supabase configuration');
                console.debug('[DEBUG] supabaseUrl or supabaseKey is missing');
                return;
            }

            // Use spawnSync to run the blocking update script
            const { spawnSync } = await import('child_process');
            const { fileURLToPath } = await import('url');
            const path = await import('path');

            // Get the script path relative to this file
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const scriptPath = path.join(__dirname, 'scripts', 'blocking-offline-update.js');

            console.debug('[DEBUG] Spawning blocking update script:', scriptPath);
            console.debug('[DEBUG] Using node executable:', process.execPath);

            const result = spawnSync(process.execPath, [
                scriptPath,
                deviceId,
                supabaseUrl,
                supabaseKey,
                session.access_token,
                session.refresh_token || '',
                this.deviceSessionLease.generation
            ], {
                timeout: 3000,
                stdio: 'pipe', // Capture output to prevent blocking
                encoding: 'utf-8'
            });

            console.debug('[DEBUG] spawnSync completed, exit code:', result.status, 'signal:', result.signal);

            // Log subprocess output (with encoding:'utf-8', these are already strings)
            if (result.stdout && result.stdout.trim()) {
                console.log(result.stdout.trim());
            }
            if (result.stderr && result.stderr.trim()) {
                console.error(result.stderr.trim());
            }

            // Handle exit codes
            if (result.error) {
                console.error('❌ Failed to spawn update process:', result.error.message);
                console.debug('[DEBUG] spawn error:', result.error);
            } else if (result.status === 0) {
                console.log('✓ Device marked as offline (blocking)');
            } else if (result.status === 2) {
                console.warn('⚠️ Device offline update timed out');
            } else if (result.signal) {
                console.error(`❌ Update process killed by signal: ${result.signal}`);
            } else {
                console.error(`❌ Update process failed with exit code: ${result.status}`);
            }

        } catch (error: any) {
            console.error('❌ Error in blocking offline update:', error.message);
            console.debug('[DEBUG] setOffline() error stack:', error.stack);
            await captureRemote('remote_channel_offline_update_error', { error });
        }
    }

    async unsubscribe() {
        // setOffline()'s durable write is the final word on `status` from here,
        // so stop the heartbeat and the channel callbacks from racing it. The
        // races that matter: a heartbeat tick firing as the signal arrives, and
        // SIGINT during recreateChannel()'s backoff, where the later join's
        // SUBSCRIBED would queue 'online' after the durable write.
        this.shuttingDown = true;
        this.stopDegradedCallPolling();
        // Budget against device.ts's 5s force-exit, worst case:
        //   250 drain + 3x300 leave + 500 session + 3000 spawnSync = 4650ms.
        // In practice only the untrack bound binds — removeChannel/unsubscribe
        // set state='leaving' first, so their leave push resolves inline.
        const LEAVE_BOUND_MS = 300;
        // Drain queued channel-callback writes. Can't drain an in-flight
        // heartbeat PATCH (it doesn't use the chain), but the gate above stops
        // any new one and an in-flight one started earlier.
        await Promise.race([this.statusWriteChain, this.sleep(250)]);
        await Promise.race([this.removeLegacyChannel(), this.sleep(LEAVE_BOUND_MS)]);
        if (this.channel) {
            // Leave presence on the graceful path (socket close covers the abrupt
            // one). Bounded: a half-open socket still reports 'joined', so the
            // push just buffers and would settle via realtime-js's 10s timeout.
            try {
                await Promise.race([
                    this.channel.untrack(),
                    this.sleep(LEAVE_BOUND_MS),
                ]);
                console.debug('[DEBUG] Presence untrack attempted (bounded)');
            } catch { /* best effort */ }
            // Bounded as insurance; unsubscribe() resolves inline in practice.
            await Promise.race([this.channel.unsubscribe(), this.sleep(LEAVE_BOUND_MS)]);
            this.channel = null;
            console.log('✓ Unsubscribed from tool call channel');
        }
    }
}
