#!/usr/bin/env node
import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

import { TerminalManager } from '../dist/terminal-manager.js';
import { MCPDevice } from '../dist/remote-device/device.js';
import { DeviceAuthenticator } from '../dist/remote-device/device-authenticator.js';
import {
  DesktopCommanderIntegration,
  buildLocalMcpChildEnvironment,
  localMcpRequestTimeoutMs,
} from '../dist/remote-device/desktop-commander-integration.js';
import { isTransientRemoteError } from '../dist/remote-device/transient-remote-error.js';
import {
  buildBackgroundRemoteArgs,
  launchRemoteBackground,
  shouldLaunchRemoteBackground,
} from '../dist/remote-device/remote-background.js';
import { configManager } from '../dist/config-manager.js';
import { validatePathAuthority } from '../dist/tools/path-security.js';
import { handleGetRecentToolCalls } from '../dist/handlers/history-handlers.js';
import { toolHistory } from '../dist/utils/toolHistory.js';
import { featureFlagManager } from '../dist/utils/feature-flags.js';
import { usageTracker } from '../dist/utils/usageTracker.js';
import {
  currentClient,
  getToolCallContext,
  runInToolCallContext,
  setCurrentClient,
} from '../dist/utils/client-context.js';

const remoteBackgroundModuleUrl = new URL('../dist/remote-device/remote-background.js', import.meta.url).href;
const remoteLifecycleModuleUrl = new URL('../dist/remote-device/remote-lifecycle.js', import.meta.url).href;

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error?.message || error}`);
  }
}
await test('usage accounting cannot gate an already-completed tool response', async () => {
  const originalTrackSuccess = usageTracker.trackSuccess;
  let started = false;
  try {
    usageTracker.trackSuccess = async () => {
      started = true;
      return new Promise(() => {});
    };
    const startedAt = Date.now();
    const returned = usageTracker.trackOutcomeNonBlocking('get_more_search_results', true);
    assert.equal(returned, undefined);
    assert.equal(started, true, 'background accounting was not started');
    assert(Date.now() - startedAt < 50, 'non-blocking usage accounting waited for its unresolved operation');
  } finally {
    usageTracker.trackSuccess = originalTrackSuccess;
  }
});

await test('tool-call context stays isolated across overlapping async work', async () => {
  setCurrentClient({ name: 'local-client', version: '1' });
  const seen = [];
  await Promise.all([
    runInToolCallContext({ isRemote: true, remoteClient: { name: 'remote-a' } }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen.push(['a', getToolCallContext()]);
    }),
    runInToolCallContext({ isRemote: false, remoteClient: null }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(['b', getToolCallContext()]);
    }),
  ]);
  const remote = seen.find(([id]) => id === 'a')[1];
  const local = seen.find(([id]) => id === 'b')[1];
  assert.equal(remote.isRemote, true);
  assert.equal(remote.remoteClient?.name, 'remote-a');
  assert.equal(local.isRemote, false);
  assert.equal(currentClient.name, 'local-client');
});

await test('remote MCP integration preserves the exact argument object', async () => {
  const integration = new DesktopCommanderIntegration();
  let seenRequest;
  integration.isReady = true;
  integration.mcpClient = {
    callTool: async (request) => {
      seenRequest = request;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const args = { relative_path: 'src/example.cpp', depth: 1 };
  await integration.callClientTool('get_symbols_overview', args, { source: 'regression' });
  assert.deepEqual(seenRequest.arguments, args);
  assert.equal(seenRequest._meta.remote, true);
  assert.equal(seenRequest._meta.source, 'regression');
});

await test('remote MCP client reserves return-path time for cpp_build_execute', async () => {
  const downstream = { root: 'C:/repo', operation: 'build', timeoutMs: 120_000 };
  const expected = 135_000;
  assert.equal(localMcpRequestTimeoutMs('write_file', {
    path: 'mcp://desktop-accelerators/cpp_build_execute?timeout_ms=130000',
    content: JSON.stringify(downstream), mode: 'rewrite',
  }), expected);
  assert.equal(localMcpRequestTimeoutMs('mcp_call_tool', {
    server: 'desktop-accelerators', tool: 'cpp_build_execute', arguments: downstream, timeout_ms: 130_000,
  }), expected);
});

await test('local MCP child inherits only allowlisted runtime environment controls', async () => {
  const keys = [
    'DESKTOP_COMMANDER_MCP_CONFIG',
    'RUFF_BIN',
    'RUFF_BIN_ARGS',
    'AST_GREP_BIN',
    'DESKTOP_COMMANDER_DISABLE_TELEMETRY',
    'DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY',
    'DC_TEST_PRIVATE_ENV',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.DESKTOP_COMMANDER_MCP_CONFIG = 'C:/runtime/mcp.json';
    process.env.RUFF_BIN = 'C:/tools/ruff.exe';
    process.env.RUFF_BIN_ARGS = '["--isolated"]';
    process.env.AST_GREP_BIN = 'C:/tools/ast-grep.exe';
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
    process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY = JSON.stringify({ 'fake-serena': ['find_symbol'] });
    process.env.DC_TEST_PRIVATE_ENV = 'must-not-leak';

    const env = buildLocalMcpChildEnvironment({ RUFF_BIN: 'C:/config/ruff.exe', CUSTOM_LOCAL: 'yes' });
    assert.equal(env.DESKTOP_COMMANDER_MCP_CONFIG, 'C:/runtime/mcp.json');
    assert.equal(env.RUFF_BIN, 'C:/config/ruff.exe', 'server-specific config env must win');
    assert.equal(env.RUFF_BIN_ARGS, '["--isolated"]');
    assert.equal(env.AST_GREP_BIN, 'C:/tools/ast-grep.exe');
    assert.equal(env.DESKTOP_COMMANDER_DISABLE_TELEMETRY, '1');
    assert.equal(env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY, process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY);
    assert.equal(env.CUSTOM_LOCAL, 'yes');
    assert.equal(env.DC_REMOTE_DEVICE, 'true');
    assert.equal(env.DC_TEST_PRIVATE_ENV, undefined, 'unrelated host env must not leak to local MCP child');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

await test('tool history response budget keeps newest records without bulk diagnostic backpressure', async () => {
  const originalRecent = toolHistory.getRecentCallsFormatted;
  const originalStats = toolHistory.getStats;
  try {
    toolHistory.getRecentCallsFormatted = () => Array.from({ length: 80 }, (_, index) => ({
      timestamp: '2026-08-16 23:00:00',
      toolName: `tool-${index}`,
      arguments: { index, note: 'x'.repeat(120) },
      output: { content: [{ type: 'text', text: `omitted-${index}` }] },
      duration: index,
    }));
    toolHistory.getStats = () => ({ totalEntries: 1000 });
    const result = await handleGetRecentToolCalls({ maxResults: 80, maxOutputChars: 4096 });
    const text = result.content?.[0]?.text ?? '';
    assert(text.length <= 4608, `history response exceeded bounded budget: ${text.length}`);
    assert.match(text, /older matched record\(s\) omitted/);
    assert.match(text, /tool-79/);
  } finally {
    toolHistory.getRecentCallsFormatted = originalRecent;
    toolHistory.getStats = originalStats;
  }
});

await test('config startup read timeout falls back without overwriting and recovers on the next load', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-config-stall-'));
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    fileReadLineLimit: 321, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false,
  }), 'utf8');
  const previous = {
    configPath: configManager.configPath, config: configManager.config, initialized: configManager.initialized,
    firstRun: configManager._isFirstRun, writeChain: configManager.writeChain, saveScheduled: configManager.saveScheduled,
  };
  const originalReadFile = fs.readFile;
  const originalSetTimeout = globalThis.setTimeout;
  try {
    configManager.configPath = configPath;
    configManager.config = {};
    configManager.initialized = false;
    configManager._isFirstRun = false;
    configManager.writeChain = Promise.resolve();
    configManager.saveScheduled = false;
    fs.readFile = async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(configPath)) return new Promise(() => {});
      return originalReadFile(target, options);
    };
    globalThis.setTimeout = (callback, ms, ...args) =>
      originalSetTimeout(callback, ms === 10_000 ? 20 : ms, ...args);
    const started = Date.now();
    await configManager.loadConfig();
    assert(Date.now() - started < 1000, 'config startup remained blocked on a stalled read');
    assert.equal(configManager.config.fileReadLineLimit, 1000, 'stalled config should use bounded in-memory defaults');
    assert.equal(JSON.parse(await originalReadFile(configPath, 'utf8')).fileReadLineLimit, 321, 'timeout path overwrote the authoritative config');

    fs.readFile = originalReadFile;
    configManager.initialized = false;
    const recoveredStarted = Date.now();
    await configManager.loadConfig();
    assert(Date.now() - recoveredStarted < 800, 'config manager retained blocked state after timeout');
    assert.equal((await configManager.getConfig()).fileReadLineLimit, 321);
  } finally {
    fs.readFile = originalReadFile;
    globalThis.setTimeout = originalSetTimeout;
    configManager.configPath = previous.configPath;
    configManager.config = previous.config;
    configManager.initialized = previous.initialized;
    configManager._isFirstRun = previous.firstRun;
    configManager.writeChain = previous.writeChain;
    configManager.saveScheduled = previous.saveScheduled;
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test('feature flag cache metadata timeout does not block startup or the next cache read', async () => {
  const cachePath = path.join(os.tmpdir(), `dc-feature-flags-stall-${process.pid}.json`);
  const originalCachePath = featureFlagManager.cachePath;
  const originalStat = fs.stat;
  const originalSetTimeout = globalThis.setTimeout;
  await fs.writeFile(cachePath, JSON.stringify({ flags: { bounded_cache_probe: true } }), 'utf8');
  featureFlagManager.cachePath = cachePath;
  try {
    fs.stat = async (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(cachePath)) return new Promise(() => {});
      return originalStat(target, ...args);
    };
    globalThis.setTimeout = (callback, ms, ...args) =>
      originalSetTimeout(callback, ms === 3000 ? 20 : ms, ...args);
    const started = Date.now();
    await featureFlagManager.loadFromCache();
    assert(Date.now() - started < 1000, 'feature flag cache stat held startup past its deadline');

    fs.stat = originalStat;
    const recoveredStarted = Date.now();
    await featureFlagManager.loadFromCache();
    assert(Date.now() - recoveredStarted < 800, 'feature flag cache retained blocked state after timeout');
    assert.equal(featureFlagManager.get('bounded_cache_probe', false), true);
  } finally {
    fs.stat = originalStat;
    globalThis.setTimeout = originalSetTimeout;
    featureFlagManager.cachePath = originalCachePath;
    await fs.rm(cachePath, { force: true });
  }
});

await test('persisted device config load is bounded and abortable', async () => {
  const device = new MCPDevice({ persistSession: true });
  const originalReadFile = fs.readFile;
  const originalSetTimeout = globalThis.setTimeout;
  const configPath = path.join(os.tmpdir(), `dc-stalled-device-${process.pid}.json`);
  let readSignal;
  device.configPath = configPath;
  try {
    fs.readFile = async (target, options = {}) => {
      if (String(target) === configPath) {
        readSignal = options.signal;
        return new Promise((resolve, reject) => {
          if (readSignal?.aborted) { reject(new Error('aborted')); return; }
          readSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return originalReadFile(target, options);
    };
    globalThis.setTimeout = (callback, ms, ...args) =>
      originalSetTimeout(callback, ms === 10_000 ? 20 : ms, ...args);
    const started = Date.now();
    assert.equal(await device.loadPersistedConfig(), null);
    assert(Date.now() - started < 1000, 'persisted config load exceeded bounded deadline');
    assert.equal(readSignal?.aborted, true, 'persisted config read did not receive AbortSignal cancellation');
  } finally {
    fs.readFile = originalReadFile;
    globalThis.setTimeout = originalSetTimeout;
  }
});

await test('persisted device config save releases caller when local filesystem stalls', async () => {
  const device = new MCPDevice({ persistSession: true });
  const originalMkdir = fs.mkdir;
  const originalSetTimeout = globalThis.setTimeout;
  const configDir = path.join(os.tmpdir(), `dc-stalled-device-save-${process.pid}`);
  device.configPath = path.join(configDir, 'device.json');
  try {
    fs.mkdir = async (target, options) => {
      if (String(target) === configDir) return new Promise(() => {});
      return originalMkdir(target, options);
    };
    globalThis.setTimeout = (callback, ms, ...args) =>
      originalSetTimeout(callback, ms === 10_000 ? 20 : ms, ...args);
    const started = Date.now();
    await device.savePersistedConfig({ access_token: 'a', refresh_token: 'r' });
    assert(Date.now() - started < 1000, 'persisted config save held caller past deadline');
  } finally {
    fs.mkdir = originalMkdir;
    globalThis.setTimeout = originalSetTimeout;
  }
});

await test('device shutdown still closes the local MCP integration when remote cleanup fails', async () => {
  const device = new MCPDevice();
  let desktopShutdown = false;
  device.remoteChannel = {
    stopHeartbeat: () => {},
    unsubscribe: async () => { throw new Error('remote cleanup failed'); },
    setOffline: async () => {},
  };
  device.desktop = {
    shutdown: async () => { desktopShutdown = true; },
  };
  await device.shutdown();
  assert.equal(desktopShutdown, true, 'local MCP integration must always be shut down');
});

await test('desktop integration force-terminates a local MCP server when close stalls', async () => {
  const integration = new DesktopCommanderIntegration();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const originalSetTimeout = globalThis.setTimeout;
  try {
    integration.isReady = true;
    integration.mcpClient = { close: async () => new Promise(() => {}) };
    integration.mcpTransport = {
      pid: child.pid,
      close: async () => new Promise(() => {}),
    };
    globalThis.setTimeout = (callback, ms, ...args) =>
      originalSetTimeout(callback, ms >= 3000 ? 20 : ms, ...args);
    await integration.shutdown();
    for (let attempt = 0; attempt < 40 && child.exitCode === null; attempt++) {
      await new Promise((resolve) => originalSetTimeout(resolve, 25));
    }
    assert.notEqual(child.exitCode, null, 'stalled local MCP child must be force-terminated');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

await test('completed process output has a global retention budget', async () => {
  const manager = new TerminalManager();
  const now = new Date();
  const completed = (pid) => ({
    pid,
    outputLines: [`session-${pid}`],
    exitCode: 0,
    startTime: now,
    endTime: now,
    lastOutputTime: now,
    evictedLines: 0,
    evictedChars: 0,
    bufferedChars: 60 * 1024 * 1024,
  });
  manager.storeCompletedSession(completed(1));
  manager.storeCompletedSession(completed(2));
  assert.equal(manager.completedSessions.has(1), false);
  assert.equal(manager.completedSessions.has(2), true);
  assert(manager.completedOutputChars <= 100 * 1024 * 1024);
});

await test('retargeting an allowed symlink does not retain old authority', async () => {
  const originalAllowed = (await configManager.getConfig()).allowedDirectories;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-path-retarget-'));
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const link = path.join(root, 'allowed-link');
  await fs.mkdir(a);
  await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'probe.txt'), 'a');
  await fs.writeFile(path.join(b, 'probe.txt'), 'b');
  let symlinkReady = false;
  try {
    await fs.symlink(a, link, process.platform === 'win32' ? 'junction' : 'dir');
    symlinkReady = true;
    await configManager.setValue('allowedDirectories', [link]);
    assert.equal(await validatePathAuthority(path.join(a, 'probe.txt')), path.join(a, 'probe.txt'));
    await fs.rm(link, { force: true });
    await fs.symlink(b, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => validatePathAuthority(path.join(a, 'probe.txt')), /Path not allowed/);
    assert.equal(await validatePathAuthority(path.join(b, 'probe.txt')), path.join(b, 'probe.txt'));
  } catch (error) {
    if (!symlinkReady && ['EPERM', 'EACCES'].includes(error?.code)) {
      console.log('SKIP symlink retarget probe (platform permission)');
      return;
    }
    throw error;
  } finally {
    await configManager.setValue('allowedDirectories', originalAllowed);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function expectAcceleratedHttpTimeout(action) {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const signals = [];
  globalThis.fetch = async (_url, options = {}) => {
    if (options.signal) signals.push(options.signal);
    return new Promise(() => {});
  };
  globalThis.setTimeout = (callback, ms, ...args) =>
    originalSetTimeout(callback, ms >= 5000 ? 10 : ms, ...args);
  try {
    await assert.rejects(action, (error) => error?.code === 'ETIMEDOUT');
    assert(signals.length >= 1, 'request did not receive an AbortSignal');
    assert(signals.every((signal) => signal.aborted), 'timed-out HTTP signal was not aborted');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
}

await test('remote transport error classifier separates fetch failures from application errors', async () => {
  assert.equal(isTransientRemoteError(new TypeError('fetch failed')), true);
  assert.equal(isTransientRemoteError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientRemoteError(new Error('access_denied')), false);
});

await test('manifest requires the Supabase version that provides Realtime httpSend', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies?.['@supabase/supabase-js'], '^2.107.0');
});

await test('remote bootstrap config fetch is bounded and abortable', async () => {
  const device = new MCPDevice();
  await expectAcceleratedHttpTimeout(() => device.fetchSupabaseConfig());
});

await test('remote bootstrap GET recovers from a transient fetch failure', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'anon-key' }),
    };
  };
  try {
    const config = await new MCPDevice().fetchSupabaseConfig();
    assert.equal(calls, 2);
    assert.equal(config.anonKey, 'anon-key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('device authorization terminal denial is not retried as a network error', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 400, json: async () => ({ error: 'access_denied', error_description: 'Denied by user' }) };
  };
  const authenticator = new DeviceAuthenticator('https://example.invalid');
  authenticator.sleep = async () => {};
  try {
    await assert.rejects(
      () => authenticator.pollForAuthorization({ device_code: 'code', expires_in: 30, interval: 1 }, 'verifier'),
      /Denied by user/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('device authorization poll retries a transient fetch failure', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return {
      ok: true, status: 200,
      json: async () => ({ access_token: 'access', refresh_token: 'refresh', device_id: 'device-test' }),
    };
  };
  const authenticator = new DeviceAuthenticator('https://example.invalid');
  authenticator.sleep = async () => {};
  try {
    const session = await authenticator.pollForAuthorization({ device_code: 'code', expires_in: 30, interval: 1 }, 'verifier');
    assert.equal(calls, 2);
    assert.equal(session.access_token, 'access');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('device authorization start request is bounded and abortable', async () => {
  const authenticator = new DeviceAuthenticator('https://example.invalid');
  await expectAcceleratedHttpTimeout(() =>
    authenticator.requestDeviceCode('test-challenge', 'device-test')
  );
});

await test('background remote launch detaches with preserved user flags', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-remote-background-'));
  const stubPath = path.join(dir, 'worker.mjs');
  const markerPath = path.join(dir, 'worker.json');
  const oldMarker = process.env.DC_REMOTE_BACKGROUND_TEST_MARKER;
  const oldLog = process.env.DC_REMOTE_BACKGROUND_LOG;
  try {
    await fs.writeFile(stubPath, [
      "import fs from 'fs';",
      "fs.writeFileSync(process.env.DC_REMOTE_BACKGROUND_TEST_MARKER, JSON.stringify(process.argv.slice(2)));",
    ].join('\n'));
    process.env.DC_REMOTE_BACKGROUND_TEST_MARKER = markerPath;
    process.env.DC_REMOTE_BACKGROUND_LOG = path.join(dir, 'worker.log');
    const argv = [process.execPath, stubPath, 'remote', '--persist-session', '--background', '--debug'];
    assert.equal(shouldLaunchRemoteBackground(argv), true);
    assert.deepEqual(buildBackgroundRemoteArgs(argv), [
      stubPath, 'remote', '--persist-session', '--debug', '--background-worker',
    ]);
    const launched = await launchRemoteBackground(argv);
    assert(launched.pid > 0);
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const workerArgs = JSON.parse(await fs.readFile(markerPath, 'utf8'));
        assert.deepEqual(workerArgs, ['remote', '--persist-session', '--debug', '--background-worker']);
        return;
      } catch (error) {
        if (attempt === 39) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } finally {
    if (oldMarker === undefined) delete process.env.DC_REMOTE_BACKGROUND_TEST_MARKER;
    else process.env.DC_REMOTE_BACKGROUND_TEST_MARKER = oldMarker;
    if (oldLog === undefined) delete process.env.DC_REMOTE_BACKGROUND_LOG;
    else process.env.DC_REMOTE_BACKGROUND_LOG = oldLog;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

await test('detached remote worker survives launcher process exit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-remote-detach-'));
  const stubPath = path.join(dir, 'worker.mjs');
  const markerPath = path.join(dir, 'survived.txt');
  const logPath = path.join(dir, 'worker.log');
  try {
    await fs.writeFile(stubPath, [
      "import fs from 'fs';",
      "setTimeout(() => fs.writeFileSync(process.env.DC_REMOTE_BACKGROUND_TEST_MARKER, 'survived'), 500);",
    ].join('\n'));
    const launcher = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { launchRemoteBackground } from ${JSON.stringify(remoteBackgroundModuleUrl)}; await launchRemoteBackground([process.execPath, process.env.DC_REMOTE_BACKGROUND_TEST_STUB, 'remote', '--persist-session', '--background']);`,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DC_REMOTE_BACKGROUND_TEST_STUB: stubPath,
        DC_REMOTE_BACKGROUND_TEST_MARKER: markerPath,
        DC_REMOTE_BACKGROUND_LOG: logPath,
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(launcher.status, 0, launcher.stderr || `unexpected launcher status ${launcher.status}`);
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        assert.equal(await fs.readFile(markerPath, 'utf8'), 'survived');
        return;
      } catch (error) {
        if (attempt === 39) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

await test('remote lifecycle diagnostics persist fatal JS exits locally', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-remote-lifecycle-'));
  const logPath = path.join(dir, 'remote-lifecycle.log');
  try {
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { installRemoteLifecycleDiagnostics } from ${JSON.stringify(remoteLifecycleModuleUrl)}; installRemoteLifecycleDiagnostics(); Promise.reject(new Error('fatal-regression')); setTimeout(function(){}, 1000);`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DC_REMOTE_LIFECYCLE_LOG: logPath },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.status, 1, child.stderr || `unexpected child status ${child.status}`);
    const log = await fs.readFile(logPath, 'utf8');
    assert.match(log, /"event":"unhandled_rejection"/);
    assert.match(log, /fatal-regression/);
    assert.match(log, /"event":"exit"/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

console.log(`\n${failures ? 'FAIL' : 'PASS'} hardening regressions: ${failures} failing test(s).`);
process.exit(failures ? 1 : 0);
