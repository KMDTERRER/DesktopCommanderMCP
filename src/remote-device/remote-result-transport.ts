import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { captureRemote } from '../utils/capture.js';
import { makeCancellationError } from '../utils/cancellation.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { isTransientRemoteError } from './transient-remote-error.js';
import { SessionTokenOwner } from './session-token-owner.js';
import {
    CLAIM_METADATA_KEY, OUTCOME_METADATA_HASH_KEY, OUTCOME_METADATA_REVISION_KEY,
    createRemoteOutcomeIdentity, stripNullBytes,
    type RemoteResultDeliveryMode, type RemoteTerminalIdentityContext,
} from './remote-result-contract.js';

const RESULT_WRITE_TIMEOUT_MS = 60_000;
const RESULT_WRITE_ATTEMPTS = 3;
const RESULT_ATTEMPT_TIMEOUT_MS = 15_000;
const RESULT_RECONCILE_TIMEOUT_MS = 5_000;
const LIVE_WRITE_TIMEOUT_MS = 6_500;
const LIVE_WRITE_ATTEMPTS = 1;
const LIVE_ATTEMPT_TIMEOUT_MS = 5_000;
const LIVE_RECONCILE_TIMEOUT_MS = 1_000;
const FALLBACK_WRITE_TIMEOUT_MS = 15_000;
const FALLBACK_WRITE_ATTEMPTS = 2;

/**
 * Outbound-only result transport. It intentionally has no Supabase Auth owner:
 * its accessToken callback reads the process-local token snapshot in O(1).
 */
export class RemoteResultTransport {
    private client: SupabaseClient | null = null;
    private baseUrl: string | null = null;
    private anonKey: string | null = null;

    constructor(private readonly tokens: SessionTokenOwner) {}

    initialize(url: string, key: string): void {
        this.baseUrl = url.replace(/\/$/, '');
        this.anonKey = key;
        this.client = createClient(url, key, {
            // Supplying accessToken disables Supabase Auth on this client. The
            // callback reads SessionTokenOwner memory only and never refreshes.
            accessToken: this.tokens.accessToken,
        });
    }

    private async rawPatchCall(
        callId: string, updateData: Record<string, unknown>, label: string,
    ): Promise<void> {
        const token = this.tokens.snapshot()?.access_token;
        if (!this.baseUrl || !this.anonKey || !token) {
            throw new Error('Raw result transport is not initialized/authenticated');
        }
        await runWithAbortableTimeout(async (signal) => {
            const response = await fetch(
                `${this.baseUrl}/rest/v1/mcp_remote_calls?id=eq.${encodeURIComponent(callId)}`,
                {
                    method: 'PATCH',
                    signal,
                    headers: {
                        apikey: this.anonKey!,
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        Prefer: 'return=minimal',
                    },
                    body: JSON.stringify(updateData),
                },
            );
            if (!response.ok) {
                const detail = (await response.text().catch(() => '')).slice(0, 512);
                throw new Error(`${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
            }
        }, 5_000, label);
    }

    async markCallExecutingRaw(callId: string): Promise<void> {
        await this.rawPatchCall(callId, { status: 'executing' }, `Raw executing write ${callId}`);
    }

    async updateCallResultRaw(
        callId: string, status: string, result: any, errorMessage: string | null,
    ): Promise<void> {
        const identity = createRemoteOutcomeIdentity(status, result, errorMessage);
        const updateData: Record<string, unknown> = { status, completed_at: new Date().toISOString() };
        if (identity.result !== null) updateData.result = identity.result;
        if (identity.errorMessage !== null) updateData.error_message = identity.errorMessage;
        await this.rawPatchCall(callId, updateData, `Raw terminal write ${callId}`);
    }

    async markCallExecutingSimple(callId: string): Promise<void> {
        if (!this.client) throw new Error('Result transport not initialized');
        const { error } = await runWithAbortableTimeout(
            async (signal) => await this.client!
                .from('mcp_remote_calls')
                .update({ status: 'executing' })
                .eq('id', callId)
                .abortSignal(signal),
            5_000,
            `Simple executing write ${callId}`,
        );
        if (error) throw error;
    }

    async updateCallResultSimple(
        callId: string, status: string, result: any, errorMessage: string | null,
    ): Promise<void> {
        if (!this.client) throw new Error('Result transport not initialized');
        const identity = createRemoteOutcomeIdentity(status, result, errorMessage);
        const updateData: Record<string, unknown> = { status, completed_at: new Date().toISOString() };
        if (identity.result !== null) updateData.result = identity.result;
        if (identity.errorMessage !== null) updateData.error_message = identity.errorMessage;
        const { error } = await runWithAbortableTimeout(
            async (signal) => await this.client!
                .from('mcp_remote_calls')
                .update(updateData)
                .eq('id', callId)
                .abortSignal(signal),
            5_000,
            `Simple terminal write ${callId}`,
        );
        if (error) throw error;
    }

    private async readCallState(callId: string, timeoutMs: number): Promise<any | null> {
        if (!this.client) throw new Error('Result transport not initialized');
        const { data, error } = await runWithAbortableTimeout(
            async (signal) => await this.client!
                .from('mcp_remote_calls')
                .select('status, metadata, result, error_message')
                .eq('id', callId)
                .abortSignal(signal)
                .maybeSingle(),
            timeoutMs,
            `Read terminal call state ${callId}`,
        );
        if (error) throw error;
        return data;
    }

    async updateCallResult(
        callId: string, status: string, result: any, errorMessage: string | null,
        claimToken: string, deliveryMode: RemoteResultDeliveryMode = 'replay',
        identityContext?: RemoteTerminalIdentityContext,
    ): Promise<void> {
        if (!this.client) throw new Error('Result transport not initialized');
        const expectedIdentity = createRemoteOutcomeIdentity(status, result, errorMessage);
        if (identityContext?.outcomeRevision !== undefined &&
            identityContext.outcomeRevision !== expectedIdentity.outcomeRevision) {
            throw new Error(`Outcome revision mismatch before terminal write for ${callId}`);
        }
        if (identityContext?.outcomeHash !== undefined &&
            identityContext.outcomeHash !== expectedIdentity.outcomeHash) {
            throw new Error(`Outcome hash mismatch before terminal write for ${callId}`);
        }

        const updateData: Record<string, unknown> = {
            status,
            completed_at: new Date().toISOString(),
        };
        if (expectedIdentity.result !== null) updateData.result = expectedIdentity.result;
        if (expectedIdentity.errorMessage !== null) updateData.error_message = expectedIdentity.errorMessage;
        if (identityContext?.claimMetadata) {
            updateData.metadata = {
                ...stripNullBytes(identityContext.claimMetadata),
                [CLAIM_METADATA_KEY]: claimToken,
                [OUTCOME_METADATA_REVISION_KEY]: expectedIdentity.outcomeRevision,
                [OUTCOME_METADATA_HASH_KEY]: expectedIdentity.outcomeHash,
            };
        }

        const fallback = result === null && status === 'failed';
        const live = deliveryMode === 'live';
        const totalBudgetMs = live ? LIVE_WRITE_TIMEOUT_MS : fallback ? FALLBACK_WRITE_TIMEOUT_MS : RESULT_WRITE_TIMEOUT_MS;
        const maxAttempts = live ? LIVE_WRITE_ATTEMPTS : fallback ? FALLBACK_WRITE_ATTEMPTS : RESULT_WRITE_ATTEMPTS;
        const attemptTimeoutMs = live ? LIVE_ATTEMPT_TIMEOUT_MS : RESULT_ATTEMPT_TIMEOUT_MS;
        const reconcileTimeoutMs = live ? LIVE_RECONCILE_TIMEOUT_MS : RESULT_RECONCILE_TIMEOUT_MS;
        const deadline = Date.now() + totalBudgetMs;
        let error: any = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            let writeError: any = null;
            let data: any = null;
            try {
                const response = await runWithAbortableTimeout(
                    async (signal) => await this.client!
                        .from('mcp_remote_calls')
                        .update(updateData)
                        .eq('id', callId)
                        .eq('status', 'executing')
                        .contains('metadata', { [CLAIM_METADATA_KEY]: claimToken })
                        .select('id, status, metadata')
                        .abortSignal(signal),
                    Math.max(100, Math.min(attemptTimeoutMs, remaining)),
                    `Update call result ${callId} attempt ${attempt}`,
                );
                data = response.data;
                writeError = response.error;
            } catch (caught: any) {
                writeError = caught;
            }

            if (!writeError && data?.length > 0) return;

            let reconcileError: any = null;
            try {
                const reconcileRemaining = deadline - Date.now();
                if (reconcileRemaining > 0) {
                    const row = await this.readCallState(
                        callId, Math.max(100, Math.min(reconcileTimeoutMs, reconcileRemaining)),
                    );
                    if (!row) {
                        const gone = new Error(`Remote call ${callId} no longer exists`) as NodeJS.ErrnoException;
                        gone.code = 'EREMOTECALLGONE';
                        error = gone;
                        break;
                    }
                    const owner = row.metadata?.[CLAIM_METADATA_KEY];
                    const terminal = row.status === 'completed' || row.status === 'failed';
                    if (owner === claimToken && terminal) {
                        const remoteIdentity = createRemoteOutcomeIdentity(
                            row.status, row.result ?? null, row.error_message ?? null,
                        );
                        const metadataRevision = row.metadata?.[OUTCOME_METADATA_REVISION_KEY];
                        const metadataHash = row.metadata?.[OUTCOME_METADATA_HASH_KEY];
                        const metadataMatches =
                            (metadataRevision === undefined || metadataRevision === expectedIdentity.outcomeRevision) &&
                            (metadataHash === undefined || metadataHash === expectedIdentity.outcomeHash);
                        if (remoteIdentity.outcomeHash === expectedIdentity.outcomeHash && metadataMatches) return;
                        error = new Error(
                            `Terminal outcome identity mismatch for ${callId}: expected ${expectedIdentity.outcomeHash}, ` +
                            `remote ${remoteIdentity.outcomeHash}`,
                        );
                        break;
                    }
                    if (owner !== claimToken || row.status !== 'executing') {
                        error = makeCancellationError(
                            'ownership_lost',
                            `Terminal write rejected because claim ownership/state changed for ${callId}`,
                            'EOWNERSHIPLOST',
                        );
                        break;
                    }
                }
            } catch (caught: any) {
                reconcileError = caught;
            }

            error = writeError ?? new Error(`Terminal write was not confirmed for ${callId}`);
            const retryable = isTransientRemoteError(writeError) || isTransientRemoteError(reconcileError);
            if (reconcileError) {
                error = new Error(`${error.message}; reconcile failed: ${reconcileError?.message || reconcileError}`);
            }
            if (!retryable || attempt >= maxAttempts) break;
            const backoffMs = 250 * attempt;
            if (deadline - Date.now() <= backoffMs) break;
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }

        error ??= new Error(`Terminal result persistence deadline exhausted for ${callId}`);
        void captureRemote('remote_result_transport_commit_error', {
            error: error?.message || String(error), callId, status, deliveryMode,
        });
        throw error;
    }
}
