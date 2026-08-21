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
  LOCAL_MCP_CONNECT_TIMEOUT_MS,
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
  CPP_BUILD_AUTO_OBSERVE_MAX_MS, PROCESS_CLIENT_RESPONSE_RESERVE_MS, PROCESS_REMOTE_OBSERVE_MAX_MS,
  PROCESS_TRANSPORT_RESERVE_MS, processObservationWaitMs,
} from '../dist/utils/process-wait-contract.js';
import {
  currentClient,
  getToolCallContext,
  runInToolCallContext,
  setCurrentClient,
} from '../dist/utils/client-context.js';
import { mcpStdioTraceEnabled } from '../dist/utils/mcp-stdio-trace.js';
import { createMcpToolErrorResult, normalizeMcpToolResult } from '../dist/utils/mcp-tool-error.js';

const remoteBackgroundModuleUrl = new URL('../dist/remote-device/remote-background.js', import.meta.url).href;
const remoteLifecycleModuleUrl = new URL('../dist/remote-device/remote-lifecycle.js', import.meta.url).href;
const toolHistoryModuleUrl = new URL('../dist/utils/toolHistory.js', import.meta.url).href;

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
  integration.ensureReady = async () => {}; // supervision is covered by remote-supervision-e2e
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

await test('local MCP restart resumes stateless post-restart work without a synthetic server error', async () => {
  const integration = new DesktopCommanderIntegration();
  const oldTransport = {};
  integration.isReady = true;
  integration.transportGeneration = 7;
  integration.mcpTransport = oldTransport;
  integration.mcpClient = { callTool: async () => { throw new Error('old client must not be used'); } };

  integration.handleLocalDisconnect('test transport closed', 7, oldTransport);
  let calls = 0;
  integration.ensureReady = async () => {
    integration.isReady = true;
    integration.transportGeneration = 8;
    integration.mcpTransport = {};
    integration.mcpClient = { callTool: async () => { calls++; return { content: [{ type: 'text', text: 'recovered' }] }; } };
  };

  const recovered = await integration.callClientTool('get_config', {});
  assert.equal(recovered.content?.[0]?.text, 'recovered');
  assert.equal(calls, 1, 'the first post-restart call must execute on the recovered child');
});

await test('native tool errors are marked as errors rather than successful text', async () => {
  const result = createMcpToolErrorResult(new Error('native failure'));
  assert.equal(result.isError, true);
  assert.equal(result.content?.[0]?.type, 'text');
  assert.equal(result.content?.[0]?.text, 'Error: native failure');
  const protocolFailure = createMcpToolErrorResult(new Error('MCP error -32000: Connection closed'));
  assert.equal(protocolFailure.content?.[0]?.text, 'Error: Connection closed',
    'SDK protocol prefix leaked into the native tool result');
  const directProxyFailure = createMcpToolErrorResult(new Error('MCP error -32000: Connection closed'), 'mcp_call_tool');
  assert.equal(directProxyFailure.content?.[0]?.text, 'Connection closed',
    'direct proxy failure did not keep the mcp_call_tool error convention');
});

await test('local MCP crash during a tool call becomes the native tool error result', async () => {
  const integration = new DesktopCommanderIntegration();
  const transport = {};
  integration.isReady = true;
  integration.transportGeneration = 3;
  integration.mcpTransport = transport;
  integration.ensureReady = async () => {};
  integration.mcpClient = {
    callTool: async () => {
      integration.handleLocalDisconnect('test stdio failure', 3, transport);
      throw new Error('connection closed');
    },
  };
  const result = await integration.callClientTool('get_config', {});
  assert.equal(result.isError, true, 'transport failure was returned as successful text');
  assert.equal(result.content?.[0]?.text, 'Error: connection closed');
});

await test('remote adapter selects the error convention from the requested frozen tool', async () => {
  const integration = new DesktopCommanderIntegration();
  integration.isReady = true;
  integration.mcpTransport = {};
  integration.ensureReady = async () => {};
  integration.mcpClient = {
    callTool: async () => { throw new Error('MCP error -32000: Connection closed'); },
  };

  const directProxy = await integration.callClientTool('mcp_call_tool', {
    server: 'desktop-core', tool: 'get_config', arguments: {},
  });
  assert.equal(directProxy.isError, true);
  assert.equal(directProxy.content?.[0]?.text, 'Connection closed');

  const frozenRead = await integration.callClientTool('read_file', {
    path: 'mcp://desktop-core/get_config', options: {},
  });
  assert.equal(frozenRead.isError, true);
  assert.equal(frozenRead.content?.[0]?.text, 'Error: Connection closed');
});

await test('malformed local MCP results cannot escape the requested tool contract', async () => {
  const integration = new DesktopCommanderIntegration();
  integration.isReady = true;
  integration.mcpTransport = {};
  integration.ensureReady = async () => {};
  integration.mcpClient = { callTool: async () => [] };

  const direct = await integration.callClientTool('mcp_call_tool', {
    server: 'desktop-context', tool: 'serena_call', arguments: {},
  });
  assert.equal(direct.isError, true);
  assert.match(direct.content?.[0]?.text ?? '', /^Local MCP result for mcp_call_tool is not an MCP CallToolResult object\.$/);

  const frozen = await integration.callClientTool('read_file', {
    path: 'mcp://desktop-context/serena_call', options: {},
  });
  assert.equal(frozen.isError, true);
  assert.match(frozen.content?.[0]?.text ?? '', /^Error: Local MCP result for read_file is not an MCP CallToolResult object\.$/);
});

await test('CallToolResult validation rejects non-serializable data and preserves extensions', async () => {
  const extended = normalizeMcpToolResult({
    content: [],
    structuredContent: { ready: true },
    vendorExtension: { sequence: 7 },
  });
  assert.deepEqual(extended.content, []);
  assert.deepEqual(extended.vendorExtension, { sequence: 7 });

  const circular = {};
  circular.self = circular;
  assert.throws(
    () => normalizeMcpToolResult({ content: [], structuredContent: circular }),
    /circular reference/,
  );
  assert.throws(
    () => normalizeMcpToolResult({ content: [], structuredContent: { sequence: 1n } }),
    /JSON cannot encode/,
  );
});

await test('concurrent malformed and valid local MCP results remain call-local', async () => {
  const integration = new DesktopCommanderIntegration();
  integration.isReady = true;
  integration.mcpTransport = {};
  integration.ensureReady = async () => {};
  integration.mcpClient = {
    callTool: async ({ arguments: args }) => {
      await new Promise((resolve) => setTimeout(resolve, args.delay));
      return args.invalid ? null : { content: [{ type: 'text', text: args.marker }] };
    },
  };
  const [invalid, valid] = await Promise.all([
    integration.callClientTool('write_file', { invalid: true, delay: 5 }),
    integration.callClientTool('read_file', { marker: 'chat-b', delay: 0 }),
  ]);
  assert.equal(invalid.isError, true);
  assert.match(invalid.content?.[0]?.text ?? '', /^Error: Local MCP result for write_file/);
  assert.equal(valid.isError, undefined);
  assert.equal(valid.content?.[0]?.text, 'chat-b');
});

await test('remote MCP client reserves return-path time for cpp_build_execute', async () => {
  const downstream = { root: 'C:/repo', operation: 'build', timeoutMs: 120_000, executionMode: 'inline' };
  const expected = 135_000;
  assert.equal(localMcpRequestTimeoutMs('write_file', {
    path: 'mcp://desktop-accelerators/cpp_build_execute?timeout_ms=130000',
    content: JSON.stringify(downstream), mode: 'rewrite',
  }), expected);
  assert.equal(localMcpRequestTimeoutMs('mcp_call_tool', {
    server: 'desktop-accelerators', tool: 'cpp_build_execute', arguments: downstream, timeout_ms: 130_000,
  }), expected);
});

await test('resumable build transport budget is independent from build lifetime', async () => {
  const resumable = { root: 'C:/repo', operation: 'build', timeoutMs: 420_000, executionMode: 'resumable' };
  const resumableExpected = PROCESS_TRANSPORT_RESERVE_MS + PROCESS_CLIENT_RESPONSE_RESERVE_MS;
  assert.equal(localMcpRequestTimeoutMs('write_file', {
    path: 'mcp://desktop-accelerators/cpp_build_execute',
    content: JSON.stringify(resumable), mode: 'rewrite',
  }), resumableExpected);
  assert.equal(localMcpRequestTimeoutMs('mcp_call_tool', {
    server: 'desktop-accelerators', tool: 'cpp_build_execute', arguments: resumable,
  }), resumableExpected);

  const auto = { ...resumable, executionMode: 'auto' };
  const autoExpected = CPP_BUILD_AUTO_OBSERVE_MAX_MS + PROCESS_TRANSPORT_RESERVE_MS + PROCESS_CLIENT_RESPONSE_RESERVE_MS;
  assert.equal(localMcpRequestTimeoutMs('mcp_call_tool', {
    server: 'desktop-accelerators', tool: 'cpp_build_execute', arguments: auto,
  }), autoExpected);
});

await test('local MCP child inherits only allowlisted runtime environment controls', async () => {
  const keys = [
    'DESKTOP_COMMANDER_MCP_CONFIG',
    'RUFF_BIN',
    'RUFF_BIN_ARGS',
    'AST_GREP_BIN',
    'DESKTOP_COMMANDER_DISABLE_TELEMETRY',
    'DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY',
    'DESKTOP_COMMANDER_SERENA_PROJECT',
    'DESKTOP_COMMANDER_SERENA_HOME',
    'DESKTOP_COMMANDER_SERENA_PROJECT_DATA_ROOT',
    'DESKTOP_COMMANDER_SERENA_UV_CACHE_DIR',
    'DESKTOP_COMMANDER_SERENA_UV_PROJECT_ENVIRONMENT',
    'DESKTOP_COMMANDER_SERENA_PYTHONPYCACHEPREFIX',
    'DESKTOP_COMMANDER_SERENA_UV_COMMAND',
    'DESKTOP_COMMANDER_SERENA_CPP_PROFILE_JSON',
    'DC_MCP_STDIO_TRACE',
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
    process.env.DESKTOP_COMMANDER_SERENA_PROJECT = 'C:/runtime/fork/serena';
    process.env.DESKTOP_COMMANDER_SERENA_HOME = 'C:/runtime/state/serena-home';
    process.env.DESKTOP_COMMANDER_SERENA_PROJECT_DATA_ROOT = 'C:/runtime/state/serena-projects';
    process.env.DESKTOP_COMMANDER_SERENA_UV_CACHE_DIR = 'C:/runtime/cache/uv';
    process.env.DESKTOP_COMMANDER_SERENA_UV_PROJECT_ENVIRONMENT = 'C:/runtime/cache/venv';
    process.env.DESKTOP_COMMANDER_SERENA_PYTHONPYCACHEPREFIX = 'C:/runtime/cache/pycache';
    process.env.DESKTOP_COMMANDER_SERENA_UV_COMMAND = 'C:/tools/uv.exe';
    process.env.DESKTOP_COMMANDER_SERENA_CPP_PROFILE_JSON = '{"root":"C:/repo"}';
    process.env.DC_MCP_STDIO_TRACE = 'false';
    process.env.DC_TEST_PRIVATE_ENV = 'must-not-leak';

    const env = buildLocalMcpChildEnvironment({ RUFF_BIN: 'C:/config/ruff.exe', CUSTOM_LOCAL: 'yes' });
    assert.equal(env.DESKTOP_COMMANDER_MCP_CONFIG, 'C:/runtime/mcp.json');
    assert.equal(env.RUFF_BIN, 'C:/config/ruff.exe', 'server-specific config env must win');
    assert.equal(env.RUFF_BIN_ARGS, '["--isolated"]');
    assert.equal(env.AST_GREP_BIN, 'C:/tools/ast-grep.exe');
    assert.equal(env.DESKTOP_COMMANDER_DISABLE_TELEMETRY, '1');
    assert.equal(env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY, process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY);
    assert.equal(env.DESKTOP_COMMANDER_SERENA_PROJECT, 'C:/runtime/fork/serena');
    assert.equal(env.DESKTOP_COMMANDER_SERENA_HOME, 'C:/runtime/state/serena-home');
    assert.equal(env.DESKTOP_COMMANDER_SERENA_PROJECT_DATA_ROOT, 'C:/runtime/state/serena-projects');
    assert.equal(env.DESKTOP_COMMANDER_SERENA_UV_CACHE_DIR, 'C:/runtime/cache/uv');
    assert.equal(env.DESKTOP_COMMANDER_SERENA_UV_PROJECT_ENVIRONMENT, 'C:/runtime/cache/venv');
    assert.equal(env.DESKTOP_COMMANDER_SERENA_PYTHONPYCACHEPREFIX, 'C:/runtime/cache/pycache');
    assert.equal(env.DESKTOP_COMMANDER_SERENA_UV_COMMAND, 'C:/tools/uv.exe');
    assert.equal(env.DESKTOP_COMMANDER_SERENA_CPP_PROFILE_JSON, '{"root":"C:/repo"}');
    assert.equal(env.DC_MCP_STDIO_TRACE, 'false', 'explicit operator trace disable must be preserved');
    assert.equal(env.CUSTOM_LOCAL, 'yes');
    assert.equal(env.DC_REMOTE_DEVICE, 'true');
    assert.equal(env.DC_TEST_PRIVATE_ENV, undefined, 'unrelated host env must not leak to local MCP child');

    delete process.env.DC_MCP_STDIO_TRACE;
    const defaultTraceEnv = buildLocalMcpChildEnvironment();
    assert.equal(defaultTraceEnv.DC_MCP_STDIO_TRACE, undefined, 'remote local-MCP trace must require explicit opt-in');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

await test('MCP stdio tracing stays off for remote children unless explicitly enabled', async () => {
  const previousTrace = process.env.DC_MCP_STDIO_TRACE;
  const previousRemote = process.env.DC_REMOTE_DEVICE;
  try {
    delete process.env.DC_MCP_STDIO_TRACE;
    process.env.DC_REMOTE_DEVICE = 'true';
    assert.equal(mcpStdioTraceEnabled(), false, 'remote child enabled protocol tracing implicitly');
    process.env.DC_MCP_STDIO_TRACE = 'true';
    assert.equal(mcpStdioTraceEnabled(), true, 'explicit protocol trace opt-in was ignored');
  } finally {
    if (previousTrace === undefined) delete process.env.DC_MCP_STDIO_TRACE;
    else process.env.DC_MCP_STDIO_TRACE = previousTrace;
    if (previousRemote === undefined) delete process.env.DC_REMOTE_DEVICE;
    else process.env.DC_REMOTE_DEVICE = previousRemote;
  }
});

await test('local MCP connect budget covers the bounded pre-connect startup contract', async () => {
  assert(LOCAL_MCP_CONNECT_TIMEOUT_MS >= 25_000,
    `local MCP connect budget is shorter than bounded server startup headroom: ${LOCAL_MCP_CONNECT_TIMEOUT_MS}ms`);
});

await test('remote process observation returns model control without shortening local waits', async () => {
  assert.equal(processObservationWaitMs(120_000, true), PROCESS_REMOTE_OBSERVE_MAX_MS);
  assert.equal(processObservationWaitMs(10_000, true), 10_000);
  assert.equal(processObservationWaitMs(120_000, false), 120_000);
  assert(PROCESS_REMOTE_OBSERVE_MAX_MS < 45_000,
    'remote process observation window no longer fits inside the caller return budget');
});

await test('remote local-MCP history startup performs no synchronous filesystem I/O', async () => {
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const { ToolHistory } = await import(${JSON.stringify(toolHistoryModuleUrl)} + '?remote-startup=' + Date.now());
for (const name of ['existsSync','mkdirSync','statSync','readFileSync','writeFileSync']) fs[name] = () => { throw new Error('SYNC_HISTORY_IO:' + name); };
syncBuiltinESMExports();
new ToolHistory();
process.stdout.write('REMOTE_HISTORY_STARTUP_OK');`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, DC_REMOTE_DEVICE: 'true' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout || `unexpected probe status ${probe.status}`);
  assert.match(probe.stdout, /REMOTE_HISTORY_STARTUP_OK/);
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
