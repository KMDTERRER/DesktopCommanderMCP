import { lookup } from 'node:dns/promises';
import tls from 'node:tls';
import { describeRemoteError } from './transient-remote-error.js';

const TLS_PROBE_TIMEOUT_MS = 4_000;
const FETCH_PROBE_TIMEOUT_MS = 5_000;

function probeTls(hostname: string, address: string, family: number, port: number): Promise<string> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
        const socket = tls.connect({ host: address, port, servername: hostname, rejectUnauthorized: true });
        const finish = (message: string) => {
            clearTimeout(timer);
            socket.destroy();
            resolve(message);
        };
        const timer = setTimeout(() => finish(`timeout after ${TLS_PROBE_TIMEOUT_MS}ms`), TLS_PROBE_TIMEOUT_MS);
        timer.unref?.();
        socket.once('secureConnect', () => finish(`ok ${Date.now() - startedAt}ms protocol=${socket.getProtocol() ?? 'unknown'}`));
        socket.once('error', (error) => finish(`${Date.now() - startedAt}ms ${describeRemoteError(error)}`));
    });
}
export async function diagnoseRemoteEndpoint(endpoint: string): Promise<void> {
    let url: URL;
    try { url = new URL(endpoint); } catch { return; }
    const port = url.port ? Number(url.port) : 443;
    console.error(`[NET-DIAG] endpoint=${url.origin}`);

    let addresses: Array<{ address: string; family: number }> = [];
    try {
        addresses = await lookup(url.hostname, { all: true, verbatim: true });
        console.error(`[NET-DIAG] dns=${addresses.map(({ address, family }) => `IPv${family}:${address}`).join(', ') || 'empty'}`);
    } catch (error) {
        console.error(`[NET-DIAG] dns-error=${describeRemoteError(error)}`);
    }

    await Promise.all(addresses.slice(0, 6).map(async ({ address, family }) => {
        const result = await probeTls(url.hostname, address, family, port);
        console.error(`[NET-DIAG] tls IPv${family} ${address}:${port} ${result}`);
    }));

    try {
        const response = await fetch(`${url.origin}/auth/v1/health`, { signal: AbortSignal.timeout(FETCH_PROBE_TIMEOUT_MS) });
        console.error(`[NET-DIAG] fetch status=${response.status} ${response.statusText || ''}`.trimEnd());
    } catch (error) {
        console.error(`[NET-DIAG] fetch-error=${describeRemoteError(error)}`);
    }
}
