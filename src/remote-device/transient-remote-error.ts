const TRANSIENT_CODES = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE',
    'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
]);

function diagnosticAtom(value: unknown, limit = 240): string | null {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value).replace(/[\r\n\t]+/g, ' ').trim();
    return text ? text.slice(0, limit) : null;
}

/** Safe operator-facing network diagnostics. Intentionally whitelists fields. */
export function describeRemoteError(error: unknown): string {
    const parts: string[] = [];
    const seen = new Set<unknown>();
    const queue: Array<{ value: any; path: string }> = [{ value: error, path: 'error' }];
    while (queue.length > 0 && parts.length < 12) {
        const { value, path } = queue.shift()!;
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
            const atom = diagnosticAtom(value);
            if (atom) parts.push(`${path}{message=${atom}}`);
            continue;
        }
        if (seen.has(value)) continue;
        seen.add(value);
        const fields = ['name', 'message', 'code', 'errno', 'syscall', 'hostname', 'address', 'port', 'status', 'statusCode'] as const;
        const details = fields.flatMap((field) => {
            const atom = diagnosticAtom(value[field]);
            return atom === null ? [] : [`${field}=${atom}`];
        });
        if (details.length > 0) parts.push(`${path}{${details.join(', ')}}`);
        if (value.cause) queue.push({ value: value.cause, path: `${path}.cause` });
        if (Array.isArray(value.errors)) {
            value.errors.slice(0, 6).forEach((nested: unknown, index: number) =>
                queue.push({ value: nested, path: `${path}.errors[${index}]` }));
        }
    }
    return parts.join(' <- ') || 'unknown remote error';
}

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
