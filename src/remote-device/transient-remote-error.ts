const TRANSIENT_CODES = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE',
    'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
]);

export function isTransientHttpStatus(status: unknown): boolean {
    const value = typeof status === 'number' ? status : Number(status);
    return value === 408 || value === 425 || value === 429 ||
        value === 500 || value === 502 || value === 503 || value === 504;
}

export function isTransientRemoteError(error: unknown): boolean {
    let current: any = error;
    for (let depth = 0; current && depth < 6; depth++) {
        if (isTransientHttpStatus(current.status ?? current.statusCode)) return true;
        const code = String(current.code ?? '').toUpperCase();
        if (TRANSIENT_CODES.has(code) || code.startsWith('UND_ERR_')) return true;
        const name = String(current.name ?? '');
        if (name === 'AbortError' || name === 'TimeoutError') return true;
        const message = String(current.message ?? current);
        if (/fetch failed|socket hang up/i.test(message)) return true;
        if (/timed out after \d+\s*(?:ms|milliseconds?)/i.test(message)) return true;
        current = current.cause;
    }
    return false;
}
