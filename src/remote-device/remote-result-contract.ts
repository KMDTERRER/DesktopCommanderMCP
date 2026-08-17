import { createHash } from 'crypto';

const NUL_CHAR = String.fromCharCode(0);
const NUL_RE = new RegExp(NUL_CHAR, 'g');

export const CLAIM_METADATA_KEY = '_desktop_commander_claim_token';
export const OUTCOME_METADATA_REVISION_KEY = '_desktop_commander_outcome_revision';
export const OUTCOME_METADATA_HASH_KEY = '_desktop_commander_outcome_hash';
export const REMOTE_OUTCOME_REVISION = 1 as const;

export type RemoteResultDeliveryMode = 'live' | 'replay';

export interface RemoteTerminalIdentityContext {
    outcomeRevision?: typeof REMOTE_OUTCOME_REVISION;
    outcomeHash?: string;
    claimMetadata?: Record<string, unknown> | null;
}

export interface RemoteOutcomeIdentity {
    outcomeRevision: typeof REMOTE_OUTCOME_REVISION;
    outcomeHash: string;
    result: unknown | null;
    errorMessage: string | null;
}

export function stripNullBytes<T>(value: T): T {
    if (typeof value === 'string') {
        return (value.includes(NUL_CHAR) ? value.replace(NUL_RE, '') : value) as T;
    }
    if (Array.isArray(value)) {
        return value.map((item) => stripNullBytes(item)) as T;
    }
    if (value && typeof value === 'object') {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) return value;
        const out: Record<string, any> = {};
        for (const [key, item] of Object.entries(value as Record<string, any>)) {
            out[key.includes(NUL_CHAR) ? key.replace(NUL_RE, '') : key] = stripNullBytes(item);
        }
        return out as T;
    }
    return value;
}

function canonicalJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalJsonValue);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            out[key] = canonicalJsonValue((value as Record<string, unknown>)[key]);
        }
        return out;
    }
    return value;
}

function canonicalJson(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new Error('Remote terminal outcome is not JSON serializable.');
    }
    return JSON.stringify(canonicalJsonValue(JSON.parse(serialized)));
}

export function createRemoteOutcomeIdentity(
    status: string, result: unknown | null, errorMessage: string | null,
): RemoteOutcomeIdentity {
    const normalizedResult = result === null ? null : stripNullBytes(result);
    const normalizedError = errorMessage === null ? null : stripNullBytes(errorMessage);
    const canonical = canonicalJson({
        outcomeRevision: REMOTE_OUTCOME_REVISION,
        status,
        result: normalizedResult,
        errorMessage: normalizedError,
    });
    return {
        outcomeRevision: REMOTE_OUTCOME_REVISION,
        outcomeHash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
        result: normalizedResult,
        errorMessage: normalizedError,
    };
}
