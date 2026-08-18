import { MCPDevice } from '../remote-device/device.js';
import os from 'os';
import { installRemoteLifecycleDiagnostics, recordRemoteLifecycle } from '../remote-device/remote-lifecycle.js';
import {
    isRemoteBackgroundWorker,
    launchRemoteBackground,
    shouldLaunchRemoteBackground,
} from '../remote-device/remote-background.js';

export async function runRemote() {
    if (shouldLaunchRemoteBackground()) {
        const { pid, logPath } = await launchRemoteBackground();
        console.log(`🚀 Remote Device started in background (PID ${pid})`);
        console.log(`📝 Background log: ${logPath}`);
        return;
    }

    const lifecycleLog = installRemoteLifecycleDiagnostics();
    const persistSession = process.argv.includes('--persist-session');
    const minimalLiveTest = process.argv.includes('--minimal-live-test')
        || process.env.DC_REMOTE_MINIMAL_LIVE_TEST === 'true';
    if (minimalLiveTest) {
        // Test mode isolates the live transport from analytics/background network
        // traffic so latency measurements cover only the remote call protocol.
        process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';
    }
    const disableNoSleep = process.argv.includes('--disable-no-sleep');
    const verbose = process.argv.includes('--debug');
    console.debug('[DEBUG] Verbose mode: ', verbose);
    // Override console.debug based on verbose flag
    // When --debug is not provided, console.debug becomes a no-op
    if (!verbose) {
        console.debug = () => { };
    }

    console.debug('[DEBUG] Platform:', os.platform());

    // Start caffeinate on macOS (unless disabled)
    // Caffeinate will monitor this process and automatically exit when it terminates
    if (!disableNoSleep && os.platform() === 'darwin') {
        try {
            console.debug('[DEBUG] Start caffeinate', process.pid);
            const { default: caffeinate } = await import('caffeinate');
            caffeinate({ pid: process.pid });
            console.log('☕ No sleep mode enabled');
        } catch (error) {
            console.warn('⚠️ Failed to start caffeinate:', error);
        }
    }

    const device = new MCPDevice({ persistSession, minimalLiveTest });
    await device.start();
    recordRemoteLifecycle('ready', {
        persistSession,
        minimalLiveTest,
        background: isRemoteBackgroundWorker(),
        lifecycleLog,
    });
}
