import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BACKGROUND_FLAG = '--background';
const BACKGROUND_WORKER_FLAG = '--background-worker';
const BACKGROUND_START_TIMEOUT_MS = 3_000;

export function shouldLaunchRemoteBackground(argv = process.argv): boolean {
    return argv.includes(BACKGROUND_FLAG) && !argv.includes(BACKGROUND_WORKER_FLAG);
}

export function isRemoteBackgroundWorker(argv = process.argv): boolean {
    return argv.includes(BACKGROUND_WORKER_FLAG);
}

export function buildBackgroundRemoteArgs(argv = process.argv): string[] {
    const entry = argv[1];
    if (!entry) throw new Error('Cannot determine Desktop Commander entry point');
    const remoteArgs = argv.slice(3).filter((arg) =>
        arg !== BACKGROUND_FLAG && arg !== BACKGROUND_WORKER_FLAG
    );
    return [entry, 'remote', ...remoteArgs, BACKGROUND_WORKER_FLAG];
}

export async function launchRemoteBackground(argv = process.argv) {
    const logDir = path.join(os.homedir(), '.desktop-commander-device');
    const logPath = process.env.DC_REMOTE_BACKGROUND_LOG
        || path.join(logDir, 'remote-background.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, 'a');

    try {
        const child = spawn(process.execPath, buildBackgroundRemoteArgs(argv), {
            cwd: process.cwd(),
            detached: true,
            windowsHide: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env, DC_REMOTE_BACKGROUND: '1' },
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(
                    `Background Remote Device did not spawn within ${BACKGROUND_START_TIMEOUT_MS}ms`
                ));
            }, BACKGROUND_START_TIMEOUT_MS);
            child.once('spawn', () => {
                clearTimeout(timer);
                resolve();
            });
            child.once('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
        });
        if (!child.pid) throw new Error('Background Remote Device did not receive a PID');
        child.unref();
        return { pid: child.pid, logPath };
    } finally {
        fs.closeSync(logFd);
    }
}
