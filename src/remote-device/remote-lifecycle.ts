import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_LIFECYCLE_LOG_BYTES = 1024 * 1024;
let installed = false;
let lifecycleLogPath = '';

function describeError(value: unknown) {
    if (value instanceof Error) {
        return { message: value.message, stack: value.stack };
    }
    return { message: String(value) };
}

function appendLifecycle(event: string, details: Record<string, unknown> = {}) {
    if (!lifecycleLogPath) return;
    try {
        fs.appendFileSync(lifecycleLogPath, `${JSON.stringify({
            timestamp: new Date().toISOString(),
            event,
            pid: process.pid,
            ppid: process.ppid,
            ...details,
        })}\n`, 'utf8');
    } catch {
        // Fatal-path diagnostics must never become another failure source.
    }
}
function prepareLog(logPath: string) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    try {
        if (fs.statSync(logPath).size <= MAX_LIFECYCLE_LOG_BYTES) return;
        const rotated = `${logPath}.1`;
        fs.rmSync(rotated, { force: true });
        fs.renameSync(logPath, rotated);
    } catch (error: any) {
        if (error?.code !== 'ENOENT') {
            process.stderr.write(`[WARN] Failed to rotate remote lifecycle log: ${error?.message ?? error}\n`);
        }
    }
}

export function recordRemoteLifecycle(event: string, details: Record<string, unknown> = {}) {
    appendLifecycle(event, details);
}

export function installRemoteLifecycleDiagnostics(): string {
    if (installed) return lifecycleLogPath;
    installed = true;
    lifecycleLogPath = process.env.DC_REMOTE_LIFECYCLE_LOG
        || path.join(os.homedir(), '.desktop-commander-device', 'remote-lifecycle.log');
    prepareLog(lifecycleLogPath);
    appendLifecycle('start', {
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        node: process.version,
        platform: process.platform,
    });
    process.on('uncaughtException', (error) => {
        appendLifecycle('uncaught_exception', describeError(error));
        process.stderr.write(`[FATAL] Remote uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        appendLifecycle('unhandled_rejection', describeError(reason));
        process.stderr.write(`[FATAL] Remote unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
        process.exit(1);
    });
    process.on('beforeExit', (code) => appendLifecycle('before_exit', { code }));
    process.on('exit', (code) => appendLifecycle('exit', { code }));
    process.on('SIGINT', () => appendLifecycle('signal', { signal: 'SIGINT' }));
    process.on('SIGTERM', () => appendLifecycle('signal', { signal: 'SIGTERM' }));

    return lifecycleLogPath;
}
