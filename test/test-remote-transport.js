#!/usr/bin/env node

/**
 * Remote transport tests (Broadcast/Presence + legacy fallback).
 *
 * Sections:
 *   1. Exactly-once execution under dual delivery
 *   2. Doorbell routing and row fetch
 *   3. Result write ordering
 *   4. Heartbeat cadence tiers
 *   5. Reachability and status writes
 *   6. Capability withdrawal
 *   7. Shutdown
 *
 * Run: npm run build && node test/test-remote-transport.js
 */

import { formatRemoteToolTrace, MCPDevice } from '../dist/remote-device/device.js';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';
import { createRemoteOutcomeIdentity } from '../dist/remote-device/remote-result-contract.js';
import { RemoteCallMetrics } from '../dist/remote-device/remote-call-metrics.js';
import { listNeutralToolAliases, resolveNeutralToolAlias } from '../dist/tools/neutral-tool-aliases.js';
import { SessionTokenOwner } from '../dist/remote-device/session-token-owner.js';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Server-side thresholds this device must fit inside. Hand-copied from
// remote-dc-mcp/src/server/constants.ts — the repos ship separately and nothing
// enforces the copy, so change both together.
const SERVER_LEGACY_OFFLINE_TIMEOUT_MS = 45 * 1000;
const SERVER_CAPABLE_OFFLINE_TIMEOUT_MS = 15 * 60 * 1000;

const DEVICE_ID = 'device-1';
const OTHER_DEVICE = 'device-2';
const TARGET_IDENTITY = Object.freeze({ deviceId: DEVICE_ID, userId: 'user-1', toolName: 'start_process' });

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
process.env.DESKTOP_COMMANDER_REMOTE_TOOL_TRACE = 'false';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ PASS  ${name}`);
  } catch (error) {
    failures++;
    console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await test('neutral aliases keep compact arguments while preserving canonical semantics and risk metadata', async () => {
  const put = resolveNeutralToolAlias('file_put', { path: 'C:/tmp/x.txt', data: 'abc', append: true });
  assert(put?.canonicalName === 'write_file', 'file_put did not resolve to write_file');
  assert(put?.args.content === 'abc' && put?.args.mode === 'append', 'file_put argument mapping drifted');
  const stop = resolveNeutralToolAlias('session_stop', { id: 42 });
  assert(stop?.canonicalName === 'force_terminate' && stop?.args.pid === 42, 'session_stop mapping drifted');
  const defs = listNeutralToolAliases();
  const putDef = defs.find((tool) => tool.name === 'file_put');
  const stopDef = defs.find((tool) => tool.name === 'session_stop');
  assert(putDef?.annotations?.destructiveHint === true, 'file_put lost mutating/destructive metadata');
  assert(stopDef?.annotations?.destructiveHint === true, 'session_stop lost destructive metadata');
  assert(!defs.some((tool) => /delete|kill|terminate/i.test(tool.name)), 'neutral alias catalog contains legacy destructive wording');
});

await test('remote call metrics record sizes and timings without retaining payload contents', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-remote-metrics-'));
  try {
    const logPath = path.join(dir, 'metrics.jsonl');
    const metrics = new RemoteCallMetrics(logPath);
    const receivedAtMs = Date.now();
    const secretInput = 'DO_NOT_LOG_INPUT';
    const secretResult = 'DO_NOT_LOG_RESULT';
    metrics.record({
      stage: 'recv', callId: 'metric-1', tool: 'write_file',
      args: { path: 'C:/missing/metric.txt', content: secretInput },
      profile: 'test', inbound: 'postgres_changes', terminalWrite: 'simple',
      receivedAtMs, createdAt: new Date(receivedAtMs - 123).toISOString(), laneWaitMs: 7,
    });
    metrics.record({
      stage: 'terminal_done', callId: 'metric-1', tool: 'write_file',
      args: { path: 'C:/missing/metric.txt', content: secretInput },
      result: { content: [{ type: 'text', text: secretResult }] },
      profile: 'test', inbound: 'postgres_changes', terminalWrite: 'simple',
      receivedAtMs, createdAt: new Date(receivedAtMs - 123).toISOString(), laneWaitMs: 7,
      toolMs: 11, terminalMs: 13, totalMs: 31,
    });
    await metrics.flush();
    const text = await fs.readFile(logPath, 'utf8');
    assert(!text.includes(secretInput) && !text.includes(secretResult), 'metrics leaked payload contents');
    const rows = text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert(rows.length === 2, `expected two metric stages, got ${rows.length}`);
    assert(rows[0].outerContentBytes === Buffer.byteLength(secretInput), 'input byte count is wrong');
    assert(rows[0].inboundLagMs === 123 && rows[0].laneWaitMs === 7, 'inbound timing fields are wrong');
    assert(rows[1].resultTextBytes === Buffer.byteLength(secretResult), 'result byte count is wrong');
    assert(rows[1].toolMs === 11 && rows[1].terminalMs === 13 && rows[1].totalMs === 31, 'stage timing fields are wrong');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

await test('production remote path emits phase metrics around claim, tool, local durability and detached delivery', async () => {
  const { device } = makeDevice();
  const events = [];
  const realSetTimeout = globalThis.setTimeout;
  device.callMetrics = { record: (event) => events.push(event) };
  device.remoteChannel.markCallExecuting = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return true;
  };
  device.resultOutbox.put = async () => { await new Promise((resolve) => setTimeout(resolve, 15)); };
  device.remoteChannel.updateCallResult = async () => { await new Promise((resolve) => setTimeout(resolve, 35)); };
  device.remoteChannel.signalResultAvailable = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { attempted: true, status: 'ok', durationMs: 20 };
  };

  await device.handleNewToolCall({
    new: {
      id: 'phase-metrics', tool_name: 'read_file', tool_args: { path: 'C:/tmp/phase.txt' },
      device_id: DEVICE_ID, user_id: 'user-1', metadata: {}, created_at: new Date(Date.now() - 80).toISOString(),
    },
    _remoteTiming: { inbound: 'broadcast_doorbell', receivedAtMs: Date.now() - 40, rowFetchMs: 18 },
  });
  const deadline = Date.now() + 1000;
  while (!events.some((event) => event.stage === 'wake_done') && Date.now() < deadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  const stages = events.map((event) => event.stage);
  for (const stage of ['recv', 'claim_done', 'tool_done', 'local_persist_done', 'remote_commit_done', 'wake_done']) {
    assert(stages.includes(stage), `production latency metrics missing ${stage}: ${JSON.stringify(stages)}`);
  }
  const claim = events.find((event) => event.stage === 'claim_done');
  const commit = events.find((event) => event.stage === 'remote_commit_done');
  const wake = events.find((event) => event.stage === 'wake_done');
  assert(claim.rowFetchMs === 18 && claim.claimMs >= 20 && claim.preToolMs >= 40, `pre-tool phases not separated: ${JSON.stringify(claim)}`);
  assert(commit.remoteCommitMs >= 30 && commit.postToolToRemoteCommitMs >= commit.remoteCommitMs, `remote commit latency missing: ${JSON.stringify(commit)}`);
  assert(wake.wakeMs >= 15 && wake.wakeStatus === 'ok', `wake ACK latency missing: ${JSON.stringify(wake)}`);
});

await test('remote tool trace formatter keeps plain logs clean and color changes presentation only', async () => {
  const descriptor = 'read_file -> mcp://desktop-accelerators/workspace_delta';
  const plain = formatRemoteToolTrace('OK', 'call-123', descriptor, 1234, false);
  const colored = formatRemoteToolTrace('OK', 'call-123', descriptor, 1234, true);
  const stripAnsi = (value) => value.replace(/\u001b\[[0-9;]*m/g, '');
  assert(!plain.includes('\u001b['), 'plain tool trace unexpectedly contains ANSI escapes');
  assert(stripAnsi(colored) === plain, 'colorized tool trace changed semantic text');
  assert(plain.includes('[TOOL]'), 'tool trace prefix is missing');
  assert(plain.includes('✓ OK'), 'tool trace phase marker is missing');
  assert(plain.includes('call=call-123'), 'tool trace call id is missing');
  assert(plain.includes('1234ms'), 'tool trace duration is missing');
  assert(plain.includes(descriptor), 'tool trace descriptor is missing');
});

await test('MCPDevice construction is process-signal neutral and started hooks are idempotent', async () => {
  const sigintBefore = process.listenerCount('SIGINT');
  const sigtermBefore = process.listenerCount('SIGTERM');
  const devices = Array.from({ length: 16 }, () => new MCPDevice());
  assert(process.listenerCount('SIGINT') === sigintBefore, 'constructor leaked SIGINT listeners');
  assert(process.listenerCount('SIGTERM') === sigtermBefore, 'constructor leaked SIGTERM listeners');

  const device = devices[0];
  device.setupShutdownHandlers();
  assert(process.listenerCount('SIGINT') === sigintBefore + 1, 'started lifecycle did not install SIGINT');
  assert(process.listenerCount('SIGTERM') === sigtermBefore + 1, 'started lifecycle did not install SIGTERM');
  device.setupShutdownHandlers();
  assert(process.listenerCount('SIGINT') === sigintBefore + 1, 'SIGINT setup was not idempotent');
  assert(process.listenerCount('SIGTERM') === sigtermBefore + 1, 'SIGTERM setup was not idempotent');
  device.removeShutdownHandlers();
  assert(process.listenerCount('SIGINT') === sigintBefore, 'SIGINT listener was not released');
  assert(process.listenerCount('SIGTERM') === sigtermBefore, 'SIGTERM listener was not released');
});

const makeChannelState = (state) => ({ state });

// Captured before any test runs: the heartbeat re-arm test monkeypatches
// globalThis.setTimeout to never fire, and the fake client's write completion
// must not silently depend on that.
const realSetTimeout = globalThis.setTimeout;

/** MCPDevice with the network and desktop edges stubbed. */
function makeDevice({ claimResults = [] } = {}) {
  const device = new MCPDevice();
  // Unit fixtures must not append synthetic call ids to the user's live
  // forensic metrics file.
  device.callMetrics = { record: () => {} };
  const executed = [];
  const claims = [...claimResults];

  device.deviceId = DEVICE_ID;
  device.desktop = {
    callClientTool: async (toolName, args) => {
      executed.push({ toolName, args });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const outboxEntries = new Map();
  device.resultOutbox = {
    put: async (entry) => { outboxEntries.set(entry.callId, entry); },
    get: async (callId) => outboxEntries.get(callId) ?? null,
    list: async () => [...outboxEntries.values()],
    remove: async (callId) => { outboxEntries.delete(callId); },
  };
  device.remoteChannel = {
    // Default: the stub grants ownership. Individual tests can return false to
    // model a claim already owned by another process.
    markCallExecuting: async () => (claims.length ? claims.shift() : true),
    getCurrentUserId: () => 'user-1',
    getCallClaimToken: () => 'test-claim-token',
    releaseCallClaim: () => {},
    signalResultAvailable: () => {},
    updateCallResult: async () => {},
  };
  return { device, executed, outboxEntries };
}

/**
 * Supabase client fake covering both shapes the device uses:
 * `update(...).eq(...)` (awaited) and `select(...).eq(...).maybeSingle()`.
 * Records every mcp_devices write in `writes`.
 */
function makeFakeClient({ row = null, failFetches = 0, writeLatencies = [], writeErrors = [] } = {}) {
  const writes = [];
  // Recorded when a write COMPLETES, not when it is issued. `writes` alone
  // cannot test ordering: setOnlineStatus evaluates .update() synchronously
  // before its only await, so issue order holds with or without the
  // statusWriteChain serialisation.
  const completions = [];
  const containsFilters = [];
  let fetchAttempts = 0;
  let pendingWrite = null;

  const result = () => {
    const p = Promise.resolve({ data: null, error: null });
    p.maybeSingle = async () => {
      fetchAttempts++;
      if (fetchAttempts <= failFetches) {
        return { data: null, error: { message: 'fetch failed' } };
      }
      return { data: row, error: null };
    };
    p.eq = () => result();
    p.select = () => result();
    p.abortSignal = () => p;
    return p;
  };

  const chain = {
    update: (payload) => {
      writes.push(payload);
      // Per-write completion latency, so a test can make an earlier write land
      // LATER than a later one — the only way to observe serialisation.
      pendingWrite = {
        payload,
        delay: writeLatencies.length ? writeLatencies.shift() : 0,
        error: writeErrors.length ? writeErrors.shift() : null,
      };
      return chain;
    },
    select: () => chain,
    insert: () => chain,
    contains: (column, value) => { containsFilters.push({ column, value }); return chain; },
    eq: () => {
      if (!pendingWrite) return result();
      const { payload, delay, error } = pendingWrite;
      pendingWrite = null;
      const p = new Promise((resolve) => {
        const settle = () => {
          completions.push(payload);
          resolve({ data: null, error });
        };
        // Only defer when a test actually asked for latency, so every other
        // test keeps the original resolve-immediately semantics.
        if (delay > 0) realSetTimeout(settle, delay);
        else settle();
      });
      // markCallExecuting chains .eq().eq().select() off a single update(), so
      // this must stay chainable exactly like result() does — returning a bare
      // promise leaves that chain hanging forever.
      p.eq = () => p;
      p.select = () => p;
      p.abortSignal = () => p;
      p.maybeSingle = async () => ({ data: null, error: null });
      return p;
    },
  };

  return {
    writes,
    completions,
    containsFilters,
    attempts: () => fetchAttempts,
    // Required by recreateChannel(); without them it dies on a TypeError before
    // reaching anything the recreate tests stub.
    removeChannel: () => Promise.resolve('ok'),
    // isDisconnecting models a client that has already settled, so
    // waitForSocketSettled() polls once and returns. NOTE: this fake has no
    // real connection state, so it cannot observe whether a new socket was
    // actually dialled — the recreate tests verify sequencing, not transport.
    realtime: { disconnect: () => Promise.resolve(), isDisconnecting: () => false },
    from: () => chain,
  };
}

function makeNeverSettlingClient() {
  const signals = [];
  const updates = [];
  const pending = new Promise(() => {});
  pending.select = () => pending;
  pending.update = (payload) => { updates.push(payload); return pending; };
  pending.eq = () => pending;
  pending.contains = () => pending;
  pending.maybeSingle = () => pending;
  pending.abortSignal = (signal) => { signals.push(signal); return pending; };
  return {
    signals,
    updates,
    from: () => pending,
  };
}

async function withAcceleratedRemoteDeadlines(fn) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) =>
    originalSetTimeout(callback, ms >= 5000 ? 5 : ms, ...args);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

function makeRemoteChannel(opts = {}) {
  const rc = new RemoteChannel();
  const client = makeFakeClient(opts);
  rc.client = client; // private in TS, plain property at runtime
  rc._user = { id: 'user-1', email: 'tester@example.com' };
  rc.deviceId = DEVICE_ID;
  rc.deviceName = 'test-device';
  rc.onToolCall = () => {};
  return { rc, client };
}

const payloadFor = (id, deviceId = DEVICE_ID) => ({
  new: {
    id,
    tool_name: 'start_process',
    tool_args: { command: 'echo hi' },
    device_id: deviceId,
    user_id: 'user-1',
    metadata: {},
  },
});

await test('RemoteChannel is the sole hosted call-row transport owner', async () => {
  const sourceDirectory = new URL('../src/remote-device/', import.meta.url);
  const names = (await fs.readdir(sourceDirectory)).filter((name) => name.endsWith('.ts'));
  const owners = [];
  for (const name of names) {
    const source = await fs.readFile(new URL(name, sourceDirectory), 'utf8');
    if (source.includes('mcp_remote_calls')) owners.push(name);
  }
  assert(owners.length === 1 && owners[0] === 'remote-channel.ts',
    `hosted call-row access escaped RemoteChannel: ${JSON.stringify(owners)}`);
  for (const removed of ['remote-result-transport.ts', 'remote-runtime-config.ts', 'remote-live-test-guard.ts']) {
    assert(!names.includes(removed), `removed alternate transport returned: ${removed}`);
  }
});

await test('the parent device gate converts a nested malformed result before delivery', async () => {
  const { device } = makeDevice();
  const delivered = [];
  device.desktop.callClientTool = async () => [];
  device.remoteChannel.updateCallResult = async (callId, status, result, errorMessage) => {
    delivered.push({ callId, status, result, errorMessage });
  };
  await device.handleNewToolCall({
    new: {
      id: 'malformed-child', tool_name: 'read_file', tool_args: { path: 'C:/example.txt' },
      device_id: DEVICE_ID, user_id: 'user-1', metadata: {},
    },
  });
  for (let attempt = 0; attempt < 100 && delivered.length < 1; attempt++) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert(delivered.length === 1, 'parent did not deliver the normalized terminal outcome');
  assert(delivered[0].status === 'completed' && delivered[0].errorMessage === null,
    'native tool error leaked into the hosted error channel');
  assert(delivered[0].result?.isError === true, 'malformed nested result was not marked as a tool error');
  assert(/^Error: Remote result for read_file/.test(delivered[0].result?.content?.[0]?.text ?? ''),
    `wrong frozen error envelope: ${JSON.stringify(delivered[0].result)}`);
});

await test('remote call_id correlation survives out-of-order tool completion', async () => {
  const { device } = makeDevice();
  const delivered = [];
  device.desktop.callClientTool = async (_toolName, args) => {
    await new Promise((resolve) => realSetTimeout(resolve, args.label === 'slow' ? 120 : 10));
    return { content: [{ type: 'text', text: args.label }] };
  };
  device.remoteChannel.updateCallResult = async (callId, status, result, errorMessage) => {
    delivered.push({ callId, status, text: result?.content?.[0]?.text ?? null, errorMessage });
  };
  const routedPayload = (id, label) => ({
    new: { id, tool_name: 'route_test', tool_args: { label }, device_id: DEVICE_ID, user_id: 'user-1', metadata: {} },
  });
  const slow = device.handleNewToolCall(routedPayload('call-slow', 'slow'));
  await new Promise((resolve) => realSetTimeout(resolve, 5));
  const fast = device.handleNewToolCall(routedPayload('call-fast', 'fast'));
  await Promise.all([slow, fast]);
  for (let attempt = 0; attempt < 100 && delivered.length < 2; attempt++) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert(delivered.length === 2, `expected two delivered outcomes, got ${JSON.stringify(delivered)}`);
  assert(delivered[0].callId === 'call-fast', `fast call did not complete first: ${JSON.stringify(delivered)}`);
  const byId = new Map(delivered.map((entry) => [entry.callId, entry]));
  assert(byId.get('call-fast')?.text === 'fast', `fast result routed to wrong call: ${JSON.stringify(delivered)}`);
  assert(byId.get('call-slow')?.text === 'slow', `slow result routed to wrong call: ${JSON.stringify(delivered)}`);
  assert([...byId.values()].every((entry) => entry.status === 'completed' && entry.errorMessage === null),
    `terminal status/error was cross-routed: ${JSON.stringify(delivered)}`);
});

await test('concurrent chats keep a timeout error and a success on their own call ids', async () => {
  const { device } = makeDevice();
  const delivered = [];
  device.desktop.callClientTool = async (_toolName, args) => {
    if (args.label === 'timeout-chat') {
      await new Promise((resolve) => realSetTimeout(resolve, 35));
      const error = new Error('Operation timed out after 25ms');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    return { content: [{ type: 'text', text: 'success-chat-result' }] };
  };
  device.remoteChannel.updateCallResult = async (callId, status, result, errorMessage) => {
    delivered.push({ callId, status, result, errorMessage });
  };
  const payload = (id, label, conversationId) => ({ new: {
    id, tool_name: 'read_file', tool_args: { label }, device_id: DEVICE_ID, user_id: 'user-1',
    metadata: { conversation_id: conversationId },
  } });

  await Promise.all([
    device.handleNewToolCall(payload('timeout-call', 'timeout-chat', 'chat-timeout')),
    device.handleNewToolCall(payload('success-call', 'success-chat', 'chat-success')),
  ]);
  for (let attempt = 0; attempt < 100 && delivered.length < 2; attempt++) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }

  const byId = new Map(delivered.map((entry) => [entry.callId, entry]));
  const timeout = byId.get('timeout-call');
  const success = byId.get('success-call');
  assert(timeout?.status === 'completed' && timeout?.result?.isError === true,
    `timeout did not retain the native tool error result: ${JSON.stringify(timeout)}`);
  assert(/timed out/i.test(timeout?.result?.content?.[0]?.text || ''), 'timeout message was lost or cross-routed');
  assert(timeout?.errorMessage === null, 'timeout escaped through the hosted error_message channel');
  assert(success?.status === 'completed' && success?.result?.isError !== true,
    `success was contaminated by the other chat timeout: ${JSON.stringify(success)}`);
  assert(success?.result?.content?.[0]?.text === 'success-chat-result', 'success result was routed to the wrong call');
});

await test('non-persistent run preserves an existing persisted auth session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-commander-auth-'));
  try {
    const configPath = path.join(dir, 'device.json');
    const savedSession = { access_token: 'saved-access', refresh_token: 'saved-refresh' };
    await fs.writeFile(configPath, JSON.stringify({ deviceId: DEVICE_ID, session: savedSession }));

    const device = new MCPDevice({ persistSession: false });
    device.deviceId = DEVICE_ID;
    device.configPath = configPath;
    device.remoteChannel = {
      getSession: async () => ({
        data: { session: { access_token: 'runtime-access', refresh_token: 'runtime-refresh' } },
        error: null,
      }),
    };

    await device.savePersistedConfig();
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert(persisted.session?.refresh_token === savedSession.refresh_token,
      'non-persistent launch erased the previously persisted refresh token');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

await test('TOKEN_REFRESHED atomically updates the shared session token owner', async () => {
  const tokens = new SessionTokenOwner();
  const rc = new RemoteChannel(tokens);
  let authCallback = null;
  rc.client = {
    auth: {
      setSession: async () => ({ error: null }),
      getUser: async () => ({ data: { user: { id: 'user-1', email: 'tester@example.com' } }, error: null }),
      getSession: async () => ({ data: { session: { access_token: 'current-access', refresh_token: 'current-refresh' } } }),
      onAuthStateChange: (callback) => { authCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    realtime: { setAuth: async () => {} },
  };

  await rc.setSession({ access_token: 'old-access', refresh_token: 'old-refresh' });
  assert(authCallback, 'auth state listener was not registered');
  authCallback('TOKEN_REFRESHED', { access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
  await new Promise((resolve) => setImmediate(resolve));

  const snapshot = tokens.snapshot();
  assert(snapshot?.refresh_token === 'rotated-refresh', 'rotated refresh token did not reach token owner');
  assert(snapshot?.access_token === 'rotated-access', 'rotated access token did not reach token owner');
});

await test('outbound token lookup is memory-only and reflects rotation immediately', async () => {
  const tokens = new SessionTokenOwner();
  tokens.replace({ access_token: 'first-access', refresh_token: 'first-refresh' });
  assert(await tokens.accessToken() === 'first-access', 'initial token snapshot was not readable');
  tokens.replace({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
  assert(await tokens.accessToken() === 'rotated-access', 'rotated token was not immediately visible to outbound transport');
});

await test('result wake reuses the already joined realtime channel and returns its ACK timing', async () => {
  const rc = new RemoteChannel(new SessionTokenOwner());
  const sent = [];
  rc.channel = {
    state: 'joined',
    send: async (payload, opts) => {
      sent.push({ payload, opts });
      await new Promise((resolve) => realSetTimeout(resolve, 15));
      return 'ok';
    },
  };
  const ack = await rc.signalResultAvailable('joined-result');
  assert(sent.length === 1, `expected one websocket wake, got ${sent.length}`);
  assert(sent[0].payload?.event === 'result' && sent[0].payload?.payload?.call_id === 'joined-result',
    'result wake payload was routed incorrectly');
  assert(sent[0].opts?.timeout === 1000, 'result wake must stay bounded');
  assert(ack?.attempted === true && ack?.status === 'ok', `wake did not return the remote ACK: ${JSON.stringify(ack)}`);
  assert(ack.durationMs >= 10, `wake ACK timing was not measured: ${JSON.stringify(ack)}`);
});


// --- 1. Exactly-once under dual delivery ------------------------------------
// Both transports deliver every call during the transition. The DB claim fails
// OPEN on a transient error, so the in-memory guard is the real guarantee.

await test('operator trace exposes a received call before slow remote claim completes', async () => {
  const { device } = makeDevice();
  let releaseClaim;
  device.remoteChannel.markCallExecuting = async () =>
    await new Promise((resolve) => { releaseClaim = () => resolve(true); });
  const originalWrite = process.stderr.write;
  const lines = [];
  process.env.DESKTOP_COMMANDER_REMOTE_TOOL_TRACE = 'true';
  process.stderr.write = ((chunk) => { lines.push(String(chunk)); return true; });
  try {
    const pending = device.handleNewToolCall(payloadFor('claim-visible'));
    await new Promise((resolve) => setImmediate(resolve));
    const beforeClaim = lines.join('');
    assert(beforeClaim.includes('[TOOL] ◆ RECV'), `received call stayed invisible behind claim: ${beforeClaim}`);
    assert(!beforeClaim.includes('▶ START'), `execution start was logged before claim ownership: ${beforeClaim}`);
    releaseClaim();
    await pending;
    assert(lines.join('').includes('▶ START'), 'execution start was not logged after claim ownership');
  } finally {
    process.stderr.write = originalWrite;
    process.env.DESKTOP_COMMANDER_REMOTE_TOOL_TRACE = 'false';
  }
});

await test('Remote parent operator trace identifies mcp:// tools without leaking arguments', async () => {
  const { device } = makeDevice();
  const originalWrite = process.stderr.write;
  const lines = [];
  process.env.DESKTOP_COMMANDER_REMOTE_TOOL_TRACE = 'true';
  process.stderr.write = ((chunk) => { lines.push(String(chunk)); return true; });
  try {
    await device.handleNewToolCall({
      new: {
        id: 'trace-call-123456789',
        tool_name: 'read_file',
        tool_args: {
          path: 'mcp://desktop-accelerators/ast_rewrite?timeout_ms=30000',
          options: { secret: 'MUST_NOT_REACH_OPERATOR_TRACE' },
        },
        device_id: DEVICE_ID,
        user_id: 'user-1',
        metadata: {},
      },
    });
  } finally {
    process.stderr.write = originalWrite;
    process.env.DESKTOP_COMMANDER_REMOTE_TOOL_TRACE = 'false';
  }
  const trace = lines.join('');
  assert(trace.includes('[TOOL] ◆ RECV  | call=trace-call-1 | read_file -> mcp://desktop-accelerators/ast_rewrite'), `missing receive trace: ${trace}`);
  assert(trace.includes('[TOOL] ▶ START | call=trace-call-1 | read_file -> mcp://desktop-accelerators/ast_rewrite'), `missing start trace: ${trace}`);
  assert(trace.indexOf('◆ RECV') < trace.indexOf('▶ START'), `receive trace did not precede execution start: ${trace}`);
  assert(/\[TOOL\] ✓ OK\s+\| call=trace-call-1 \| \d+ms \| read_file -> mcp:\/\/desktop-accelerators\/ast_rewrite/.test(trace), `missing completion trace: ${trace}`);
  assert(!trace.includes('MUST_NOT_REACH_OPERATOR_TRACE'), 'tool arguments leaked into operator trace');
  assert(!trace.includes('timeout_ms'), 'mcp URI query leaked into operator trace');
});

await test('operator trace sink failure never blocks tool execution', async () => {
  const { device, executed } = makeDevice();
  const originalWrite = process.stderr.write;
  process.env.DESKTOP_COMMANDER_REMOTE_TOOL_TRACE = 'true';
  process.stderr.write = (() => { throw new Error('operator trace sink closed'); });
  try {
    await device.handleNewToolCall(payloadFor('trace-sink-failure'));
  } finally {
    process.stderr.write = originalWrite;
    process.env.DESKTOP_COMMANDER_REMOTE_TOOL_TRACE = 'false';
  }
  assert(executed.length === 1, 'operator trace failure prevented tool execution');
});

await test('dual delivery of the same call executes the tool exactly once', async () => {
  const { device, executed } = makeDevice();
  await device.handleNewToolCall(payloadFor('call-a'));
  await device.handleNewToolCall(payloadFor('call-a')); // the other transport
  assert(executed.length === 1, `expected 1 execution, got ${executed.length}`);
});

await test('exactly-once holds when the DB claim fails OPEN for both deliveries', async () => {
  const { device, executed } = makeDevice({ claimResults: [true, true] });
  await device.handleNewToolCall(payloadFor('call-b'));
  await device.handleNewToolCall(payloadFor('call-b'));
  assert(executed.length === 1, `fail-open claim double-executed: ${executed.length} runs`);
});

await test('a lost DB claim (another process won) skips execution', async () => {
  const { device, executed } = makeDevice({ claimResults: [false] });
  await device.handleNewToolCall(payloadFor('call-c'));
  assert(executed.length === 0, `expected no execution, got ${executed.length}`);
});

await test('calls for another device are ignored and do not poison the dedupe set', async () => {
  const { device, executed } = makeDevice();
  await device.handleNewToolCall(payloadFor('call-d', OTHER_DEVICE));
  assert(executed.length === 0, 'must not execute another device call');
  // The device filter runs before dedupe, so our own copy must still run.
  await device.handleNewToolCall(payloadFor('call-d'));
  assert(executed.length === 1, 'a mismatched delivery must not suppress our own');
});

await test('missing device or wrong user targets fail closed before claim and execution', async () => {
  const { device, executed, outboxEntries } = makeDevice();
  let claims = 0;
  let terminalWrites = 0;
  let wakes = 0;
  device.remoteChannel.markCallExecuting = async () => { claims++; return true; };
  device.remoteChannel.updateCallResult = async () => { terminalWrites++; };
  device.remoteChannel.signalResultAvailable = () => { wakes++; };
  const missingDevice = payloadFor('missing-device');
  delete missingDevice.new.device_id;
  const wrongUser = payloadFor('wrong-user');
  wrongUser.new.user_id = 'user-2';
  await device.handleNewToolCall(missingDevice);
  await device.handleNewToolCall(wrongUser);
  assert(claims === 0, `foreign calls reached DB claim: ${claims}`);
  assert(executed.length === 0, `foreign calls executed: ${executed.length}`);
  assert(outboxEntries.size === 0, 'foreign calls created a result outbox entry');
  assert(terminalWrites === 0, `foreign calls wrote ${terminalWrites} terminal responses`);
  assert(wakes === 0, `foreign calls emitted ${wakes} result wakes`);
});

await test('claim errors never manufacture a terminal response for an unowned call', async () => {
  const { device, executed, outboxEntries } = makeDevice();
  let terminalWrites = 0;
  let wakes = 0;
  device.remoteChannel.markCallExecuting = async () => { throw new Error('claim transport failed'); };
  device.remoteChannel.updateCallResult = async () => { terminalWrites++; };
  device.remoteChannel.signalResultAvailable = () => { wakes++; };

  await device.handleNewToolCall(payloadFor('claim-error'));

  assert(executed.length === 0, 'tool executed without claim ownership');
  assert(outboxEntries.size === 0, 'claim error created a result outbox entry');
  assert(terminalWrites === 0, `claim error wrote ${terminalWrites} terminal responses`);
  assert(wakes === 0, `claim error emitted ${wakes} result wakes`);
});

await test('a local tool error stays in the native tool result after ownership is established', async () => {
  const { device, executed, outboxEntries } = makeDevice();
  let releaseDelivery;
  const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
  device.desktop.callClientTool = async (toolName, args) => {
    executed.push({ toolName, args });
    throw new Error('intentional local failure');
  };
  device.remoteChannel.updateCallResult = async () => { await deliveryGate; };

  await device.handleNewToolCall(payloadFor('owned-tool-error'));

  const entry = outboxEntries.get('owned-tool-error');
  assert(executed.length === 1, 'owned failing tool did not execute exactly once');
  assert(entry?.version === 2, 'error outcome did not use identity-bound outbox format');
  assert(entry?.callId === 'owned-tool-error' && entry?.deviceId === DEVICE_ID && entry?.userId === 'user-1'
    && entry?.toolName === 'start_process', `error outcome target drifted: ${JSON.stringify(entry)}`);
  assert(entry?.status === 'completed', `tool error escaped through remote failed status: ${JSON.stringify(entry)}`);
  assert(entry?.result?.isError === true, `tool error was returned as successful text: ${JSON.stringify(entry)}`);
  assert(entry?.result?.content?.[0]?.text === 'Error: intentional local failure',
    `native tool error text drifted: ${JSON.stringify(entry)}`);
  assert(entry?.errorMessage === null, 'tool error escaped through the proxy error_message channel');

  releaseDelivery();
});

await test('the seen-call-id set stays bounded', async () => {
  const { device } = makeDevice();
  for (let i = 0; i < 250; i++) await device.handleNewToolCall(payloadFor(`bulk-${i}`));
  assert(device.seenCallIds.size <= 100, `set grew to ${device.seenCallIds.size}`);
});

await test('a completed tool result stays in the durable outbox until remote persistence succeeds', async () => {
  const { device, executed, outboxEntries } = makeDevice();
  let writes = 0;
  device.remoteChannel.updateCallResult = async () => {
    writes++;
    if (writes === 1) throw new TypeError('fetch failed');
  };

  await device.handleNewToolCall(payloadFor('call-outbox'));
  assert(executed.length === 1, 'tool should execute exactly once');
  const retained = outboxEntries.get('call-outbox');
  assert(retained?.status === 'completed', 'successful outcome must remain completed in the outbox');
  assert(retained?.result?.content?.[0]?.text === 'ok', 'exact successful result was not retained');

  await device.handleNewToolCall(payloadFor('call-outbox'));
  assert(executed.length === 1, 'redelivery must replay the outbox, not re-execute the tool');
  assert(outboxEntries.size === 0, 'confirmed replay must remove the durable outbox entry');
});

await test('a duplicate doorbell cannot resend a committed result while outbox cleanup is pending', async () => {
  const { device, executed, outboxEntries } = makeDevice();
  let terminalWrites = 0;
  let wakes = 0;
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  device.remoteChannel.updateCallResult = async () => { terminalWrites++; };
  device.remoteChannel.signalResultAvailable = () => {
    wakes++;
    return { attempted: true, status: 'ok', durationMs: 0 };
  };
  device.resultOutbox.remove = async (callId) => {
    await cleanupGate;
    outboxEntries.delete(callId);
  };

  await device.handleNewToolCall(payloadFor('cleanup-race'));
  const firstDeliveryDeadline = Date.now() + 500;
  while (terminalWrites < 1 && Date.now() < firstDeliveryDeadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert(terminalWrites === 1, 'initial terminal result did not reach the hosted writer');

  const duplicate = device.handleNewToolCall(payloadFor('cleanup-race'));
  await new Promise((resolve) => realSetTimeout(resolve, 20));
  assert(terminalWrites === 1, 'duplicate resent the payload before cleanup completed');
  releaseCleanup();
  await duplicate;
  const wakeDeadline = Date.now() + 500;
  while (wakes < 1 && Date.now() < wakeDeadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }

  assert(executed.length === 1, 'duplicate doorbell re-executed the tool');
  assert(terminalWrites === 1, `duplicate doorbell resent the terminal payload ${terminalWrites} times`);
  assert(wakes === 1, `duplicate doorbell emitted ${wakes} result wakes`);
});

await test('slow remote persistence cannot block completed handlers under parallel load', async () => {
  const { device, executed, outboxEntries } = makeDevice();
  let releaseWrites;
  const writeGate = new Promise((resolve) => { releaseWrites = resolve; });
  let deliveryCalls = 0;
  device.remoteChannel.updateCallResult = async (_callId, _status, _result, _error) => {
    deliveryCalls++;
    await writeGate;
  };

  const calls = Array.from({ length: 6 }, (_, index) =>
    device.handleNewToolCall(payloadFor(`parallel-${index}`))
  );
  const handlerState = await Promise.race([
    Promise.all(calls).then(() => 'done'),
    new Promise((resolve) => realSetTimeout(() => resolve('timeout'), 150)),
  ]);

  assert(handlerState === 'done', 'completed tool handlers waited for slow remote result persistence');
  assert(executed.length === 6, `expected 6 completed tools, got ${executed.length}`);
  assert(outboxEntries.size === 6, 'each completed tool must be durable before detached delivery');
  assert(deliveryCalls > 0, 'initial result delivery did not use the upstream RemoteChannel path');

  releaseWrites();
  const deadline = Date.now() + 1000;
  while (outboxEntries.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert(outboxEntries.size === 0, 'released live deliveries did not retire their outbox entries');
});

await test('a stale non-transient outbox entry does not block later deliverable results', async () => {
  const { device, outboxEntries } = makeDevice();
  outboxEntries.set('poison', { version: 2, callId: 'poison', ...TARGET_IDENTITY, claimToken: 'claim-poison', status: 'completed', result: { content: [] }, errorMessage: null, createdAt: new Date().toISOString() });
  outboxEntries.set('good', { version: 2, callId: 'good', ...TARGET_IDENTITY, claimToken: 'claim-good', status: 'completed', result: { content: [] }, errorMessage: null, createdAt: new Date().toISOString() });
  const writes = [];
  device.remoteChannel.updateCallResult = async (callId) => {
    writes.push(callId);
    if (callId === 'poison') throw new Error('claim ownership changed');
  };

  await device.flushResultOutbox();

  assert(writes.includes('good'), 'one stale outbox entry must not block later results');
  assert(outboxEntries.has('poison'), 'stale entry must remain for forensic/retry handling');
  assert(!outboxEntries.has('good'), 'deliverable later entry should be removed after acknowledgement');
});

await test('an already-committed replay is retired without a second result wake', async () => {
  const { device, outboxEntries } = makeDevice();
  outboxEntries.set('already-terminal', {
    version: 2, callId: 'already-terminal', ...TARGET_IDENTITY, claimToken: 'claim-already-terminal',
    status: 'completed', result: { content: [{ type: 'text', text: 'stored' }] },
    errorMessage: null, createdAt: new Date().toISOString(),
  });
  let wakes = 0;
  device.remoteChannel.updateCallResult = async () => 'already_committed';
  device.remoteChannel.signalResultAvailable = () => { wakes++; };

  await device.flushResultOutbox();

  assert(!outboxEntries.has('already-terminal'), 'already-terminal replay remained in the outbox');
  assert(wakes === 0, `already-terminal replay emitted ${wakes} duplicate wake(s)`);
});

await test('an outbox entry whose remote call is confirmed gone is discarded instead of retried forever', async () => {
  const { device, outboxEntries } = makeDevice();
  outboxEntries.set('gone', { version: 2, callId: 'gone', ...TARGET_IDENTITY, claimToken: 'claim-gone', status: 'completed', result: { content: [] }, errorMessage: null, createdAt: new Date().toISOString() });
  const error = Object.assign(new Error('remote call no longer exists'), { code: 'EREMOTECALLGONE' });
  device.remoteChannel.updateCallResult = async () => { throw error; };

  await device.flushResultOutbox();

  assert(!outboxEntries.has('gone'), 'a confirmed-gone remote call must not remain in the retry outbox');
});
await test('a slow result for one call does not block another call delivery', async () => {
  const { device } = makeDevice();
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const order = [];
  device.remoteChannel.updateCallResult = async (callId) => {
    if (callId === 'slow-call') await slowGate;
    order.push(`write:${callId}`);
  };
  device.remoteChannel.signalResultAvailable = (callId) => {
    order.push(`notify:${callId}`);
  };

  const slow = device.handleNewToolCall(payloadFor('slow-call'));
  await new Promise((resolve) => setImmediate(resolve));
  const fast = device.handleNewToolCall(payloadFor('fast-call'));
  const fastState = await Promise.race([
    fast.then(() => 'done'),
    new Promise((resolve) => realSetTimeout(() => resolve('timeout'), 100)),
  ]);

  assert(fastState === 'done', 'fast call was head-of-line blocked by unrelated slow result delivery');
  const notifyDeadline = Date.now() + 500;
  while (!order.includes('notify:fast-call') && Date.now() < notifyDeadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert(order.includes('notify:fast-call'), 'fast call never reached result notification');
  releaseSlow();
  await slow;
});

await test('background outbox replay cannot reserve the delivery pool ahead of three fresh chats', async () => {
  const { device, outboxEntries } = makeDevice();
  for (let index = 0; index < 8; index++) {
    const callId = `old-${index}`;
    outboxEntries.set(callId, {
      version: 2, callId, ...TARGET_IDENTITY, claimToken: `claim-${callId}`,
      status: 'completed', result: { content: [{ type: 'text', text: callId }] },
      errorMessage: null, createdAt: new Date().toISOString(),
    });
  }

  let releaseReplay;
  const replayGate = new Promise((resolve) => { releaseReplay = resolve; });
  const replayStarted = [];
  const delivered = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  device.remoteChannel.updateCallResult = async (callId) => {
    activeWrites++;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    try {
      if (callId.startsWith('old-')) {
        replayStarted.push(callId);
        await replayGate;
      }
      delivered.push(callId);
    } finally {
      activeWrites--;
    }
  };

  const flush = device.flushResultOutbox();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert(replayStarted.length === 3, `expected three bounded replay workers, got ${replayStarted.length}`);

  const live = ['live-a', 'live-b', 'live-c'].map((callId) => device.handleNewToolCall(payloadFor(callId)));
  const liveState = await Promise.race([
    Promise.all(live).then(() => 'done'),
    new Promise((resolve) => realSetTimeout(() => resolve('timeout'), 150)),
  ]);
  assert(liveState === 'done', 'fresh results were queued behind the historical outbox backlog');
  for (const callId of ['live-a', 'live-b', 'live-c']) {
    assert(delivered.includes(callId), `fresh result ${callId} did not reach remote persistence`);
  }
  assert(maxActiveWrites <= 8, `result delivery exceeded its concurrency bound: ${maxActiveWrites}`);

  releaseReplay();
  await flush;
});

await test('result-delivery slot wait is bounded instead of becoming an unresolved waiter', async () => {
  const { device } = makeDevice();
  const releases = [];
  try {
    for (let index = 0; index < 8; index++) {
      releases.push(await device.acquireResultDeliverySlot('live', 100));
    }
    let error;
    try {
      await device.acquireResultDeliverySlot('live', 25);
    } catch (caught) {
      error = caught;
    }
    assert(error?.code === 'ETIMEDOUT', `expected bounded delivery-slot timeout, got ${error?.message ?? error}`);
    assert(device.resultDeliveryLiveWaiters.length === 0, 'timed-out live waiter remained queued');
  } finally {
    for (const release of releases) release();
  }
});

// --- 2. Doorbell routing ----------------------------------------------------

await test('heartbeat startup is idempotent for the same device', async () => {
  const rc = new RemoteChannel(new SessionTokenOwner());
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearInterval = globalThis.clearInterval;
  const realClearTimeout = globalThis.clearTimeout;
  let intervals = 0; let timeouts = 0;
  globalThis.setInterval = () => ({ kind: 'interval', id: ++intervals });
  globalThis.setTimeout = () => ({ kind: 'timeout', id: ++timeouts, unref() {} });
  globalThis.clearInterval = () => {}; globalThis.clearTimeout = () => {};
  try {
    rc.startHeartbeat(DEVICE_ID);
    const firstInterval = rc.connectionCheckInterval;
    const firstHeartbeat = rc.heartbeatInterval;
    rc.startHeartbeat(DEVICE_ID);
    assert(intervals === 1 && timeouts === 1, `duplicate heartbeat timers created: ${intervals}/${timeouts}`);
    assert(rc.connectionCheckInterval === firstInterval && rc.heartbeatInterval === firstHeartbeat, 'idempotent heartbeat replaced active timers');
  } finally {
    rc.stopHeartbeat();
    globalThis.setInterval = realSetInterval; globalThis.setTimeout = realSetTimeout;
    globalThis.clearInterval = realClearInterval; globalThis.clearTimeout = realClearTimeout;
  }
});

await test('legacy production subscription matches the upstream user-scoped channel', async () => {
  const rc = new RemoteChannel(new SessionTokenOwner());
  rc._user = { id: 'user-1', email: 'tester@example.com' };
  rc.deviceId = DEVICE_ID;
  let subscriptionFilter = null;
  const channel = { state: 'joined', on: (_kind, options) => { subscriptionFilter = options?.filter ?? null; return channel; }, subscribe: () => channel };
  rc.client = { channel: () => channel };
  rc.createLegacyChannel();
  assert(subscriptionFilter === 'user_id=eq.user-1', `legacy subscription drifted from upstream: ${subscriptionFilter}`);
});

await test('fork-only degraded polling transport is absent', async () => {
  const { rc } = makeRemoteChannel();
  assert(rc.pollPendingCallsOnce === undefined, 'production still exposes degraded REST polling');
  assert(rc.startDegradedCallPolling === undefined, 'production still exposes a degraded poll scheduler');
  assert(rc.handleBroadcastDeliveryMiss === undefined, 'production still exposes fork-only broadcast suppression');
});

await test('late broadcast doorbell remains on the upstream channel contract', async () => {
  const row = {
    id: 'late-doorbell', device_id: DEVICE_ID, status: 'pending', tool_name: 'read_file', tool_args: {},
    created_at: new Date(Date.now() - 2000).toISOString(), metadata: { transport: 'broadcast_v1' },
  };
  const { rc } = makeRemoteChannel({ row });
  rc.transportCapableWritten = true; rc.presenceTracked = true; rc.channel = makeChannelState('joined');
  const delivered = [];
  rc.onToolCall = (payload) => delivered.push(payload);

  await rc.onDoorbell({ call_id: row.id, device_id: DEVICE_ID });
  assert(delivered.length === 1, 'late broadcast doorbell did not deliver its pending row');
  assert(rc.transportCapableWritten === true, 'doorbell timing unexpectedly rewrote hosted capabilities');
});

await test('IncreaseConnectionPool immediately withdraws a stale broadcast capability', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.transportCapableWritten = true; rc.channel = makeChannelState('errored'); rc.legacyChannel = makeChannelState('joined');
  rc.handlePrivateTransportFailure(new Error('IncreaseConnectionPool: Please increase your connection pool size'));
  await rc.capabilityWriteChain;
  assert(rc.transportCapableWritten === false, 'hard private authorization failure left broadcast capability advertised');
  const capabilityWrites = client.writes.filter((value) => value?.capabilities);
  assert(capabilityWrites.length >= 1, 'hard private failure did not publish a capability withdrawal');
  assert(capabilityWrites.every((value) => value.capabilities.transport_broadcast_v1 !== true), 'withdrawal still advertised broadcast_v1');
});

await test('doorbell for another device is ignored without fetching', async () => {
  const { rc, client } = makeRemoteChannel();
  await rc.onDoorbell({ call_id: 'x', device_id: OTHER_DEVICE });
  assert(client.attempts() === 0, 'must not even fetch the row');
});

await test('doorbell delivers a pending row through the shared handler', async () => {
  const row = { id: 'x', status: 'pending', tool_name: 'start_process' };
  const { rc } = makeRemoteChannel({ row });
  const delivered = [];
  rc.onToolCall = (p) => delivered.push(p);
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(delivered.length === 1, 'expected one delivery');
  assert(delivered[0].new === row, 'must pass the fetched row as {new: row}');
});

await test('doorbell for an already-claimed row does not re-deliver', async () => {
  const { rc } = makeRemoteChannel({ row: { id: 'x', status: 'executing' } });
  const delivered = [];
  rc.onToolCall = (p) => delivered.push(p);
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(delivered.length === 0, 'non-pending rows must not be re-delivered');
});

await test('doorbell row fetch retries a transient failure', async () => {
  const { rc, client } = makeRemoteChannel({ row: { id: 'x', status: 'pending' }, failFetches: 2 });
  const delivered = [];
  rc.onToolCall = (p) => delivered.push(p);
  rc.sleep = () => Promise.resolve();
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(client.attempts() === 3, `expected 3 attempts, got ${client.attempts()}`);
  assert(delivered.length === 1, 'should deliver after the retry succeeds');
});

await test('doorbell with a missing row is a no-op', async () => {
  const { rc } = makeRemoteChannel({ row: null });
  const delivered = [];
  rc.onToolCall = (p) => delivered.push(p);
  await rc.onDoorbell({ call_id: 'gone', device_id: DEVICE_ID });
  assert(delivered.length === 0, 'missing row must not deliver');
});

await test('doorbell fetch aborts and returns when DB I/O never settles', async () => {
  const { rc } = makeRemoteChannel();
  const client = makeNeverSettlingClient();
  rc.client = client;
  rc.sleep = () => Promise.resolve();
  let delivered = 0;
  rc.onToolCall = () => { delivered++; };

  await withAcceleratedRemoteDeadlines(() =>
    rc.onDoorbell({ call_id: 'never-fetch', device_id: DEVICE_ID })
  );

  assert(delivered === 0, 'a timed-out row fetch must not dispatch a tool call');
  assert(client.signals.length === 3, `expected 3 bounded fetch attempts, got ${client.signals.length}`);
  assert(client.signals.every((signal) => signal.aborted), 'every timed-out fetch must abort its request signal');
});

await test('markCallExecuting fails closed when DB ownership cannot be established', async () => {
  const { rc } = makeRemoteChannel();
  const client = makeNeverSettlingClient();
  rc.client = client;
  rc.sleep = () => Promise.resolve();

  let error;
  try {
    await withAcceleratedRemoteDeadlines(() => rc.markCallExecuting('never-claim', TARGET_IDENTITY));
  } catch (caught) {
    error = caught;
  }

  assert(error, 'an ambiguous claim must reject rather than execute fail-open');
  assert(client.signals.length >= 6, `expected bounded claim + reconcile attempts, got ${client.signals.length}`);
  assert(client.signals.every((signal) => signal.aborted), 'every timed-out ownership probe must abort its request signal');
});

await test('remote outcome hash is canonical and includes terminal status', async () => {
  const left = createRemoteOutcomeIdentity('completed', { b: 2, a: { y: 2, x: 1 } }, null);
  const right = createRemoteOutcomeIdentity('completed', { a: { x: 1, y: 2 }, b: 2 }, null);
  const failed = createRemoteOutcomeIdentity('failed', { a: { x: 1, y: 2 }, b: 2 }, null);
  assert(left.outcomeRevision === 1, 'outcome revision must start at 1');
  assert(left.outcomeHash === right.outcomeHash, 'object key order must not change canonical outcome hash');
  assert(left.outcomeHash !== failed.outcomeHash, 'terminal status must participate in outcome identity');
});

await test('sole hosted-result writer rejects malformed results before any network write', async () => {
  const { rc, client } = makeRemoteChannel();
  for (const invalid of [[], null, { content: 'not-an-array' }, { content: [{ type: 'text' }] }]) {
    let error;
    try {
      await rc.updateCallResult('invalid-final', 'completed', invalid, null, TARGET_IDENTITY);
    } catch (caught) {
      error = caught;
    }
    assert(error, `hosted writer accepted malformed result ${JSON.stringify(invalid)}`);
  }
  assert(client.writes.length === 0, 'a malformed result reached the hosted update path');
});

await test('replay reconciles an identical terminal row without resending its payload', async () => {
  const result = { content: [{ type: 'text', text: 'already stored' }] };
  const { rc, client } = makeRemoteChannel({
    row: {
      id: 'replay-complete', status: 'completed', result, error_message: null,
      device_id: DEVICE_ID, user_id: 'user-1', tool_name: 'start_process',
    },
  });

  const disposition = await rc.updateCallResult(
    'replay-complete', 'completed', result, null, TARGET_IDENTITY, 'replay',
  );

  assert(disposition === 'already_committed', `unexpected replay disposition ${disposition}`);
  assert(client.writes.length === 0, 'identical replay issued a second hosted result PATCH');
});

await test('a lost terminal PATCH acknowledgement reconciles before any retry payload', async () => {
  const result = { content: [{ type: 'text', text: 'stored despite lost ack' }] };
  const { rc, client } = makeRemoteChannel({
    row: {
      id: 'lost-result-ack', status: 'completed', result, error_message: null,
      device_id: DEVICE_ID, user_id: 'user-1', tool_name: 'start_process',
    },
    writeErrors: [{ message: 'response lost' }],
  });
  rc.sleep = () => Promise.resolve();

  const disposition = await rc.updateCallResult(
    'lost-result-ack', 'completed', result, null, TARGET_IDENTITY, 'live',
  );

  assert(disposition === 'committed', `lost ACK was not reconciled: ${disposition}`);
  assert(client.writes.length === 1, `lost ACK resent the result payload ${client.writes.length} times`);
});

// --- 2b. Handler rejections are observed -------------------------------------
// handleNewToolCall is async and its promise is discarded at both call sites, so
// a rejection would be unhandled and terminate the device process.

await test('a rejecting tool-call handler does not produce an unhandled rejection', async () => {
  const { rc } = makeRemoteChannel({ row: { id: 'x', status: 'pending' } });
  rc.onToolCall = async () => { throw new Error('handler blew up'); };

  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
    await new Promise((r) => setImmediate(r)); // let a rejection surface
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert(unhandled.length === 0, `unhandled rejection escaped: ${unhandled[0]?.message}`);
});

await test('a synchronously throwing handler is contained too', async () => {
  const { rc } = makeRemoteChannel({ row: { id: 'x', status: 'pending' } });
  rc.onToolCall = () => { throw new Error('sync throw'); };
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID }); // must not reject
});

// --- 3. Result ordering -----------------------------------------------------
// The server fetches the row by id when the doorbell arrives, so the write must
// land first or it sees a non-terminal row and waits for the recovery poll.

await test('the result row is written BEFORE the doorbell is rung', async () => {
  const order = [];
  const { device, executed } = makeDevice();
  device.remoteChannel.updateCallResult = async () => { order.push('write'); };
  device.remoteChannel.signalResultAvailable = () => { order.push('doorbell'); };
  await device.handleNewToolCall(payloadFor('call-order'));
  assert(executed.length === 1, 'tool should have run');
  const deliveryDeadline = Date.now() + 500;
  while (order.length < 2 && Date.now() < deliveryDeadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert(order.join(',') === 'write,doorbell', `expected write,doorbell — got ${order.join(',')}`);
});

await test('back-to-back result wakes preserve call ids on the joined websocket', async () => {
  const rc = new RemoteChannel(new SessionTokenOwner());
  const delivered = [];
  rc.channel = { state: 'joined', send: async (payload) => { delivered.push(payload.payload.call_id); return 'ok'; } };
  rc.signalResultAvailable('start-search-result');
  rc.signalResultAvailable('read-file-result');
  rc.signalResultAvailable('write-file-result');
  await new Promise((resolve) => setImmediate(resolve));
  assert(delivered.join(',') === 'start-search-result,read-file-result,write-file-result', 'result wake call ids were cross-routed');
});

await test('result wake does not create a fallback HTTP path when realtime is not joined', async () => {
  const rc = new RemoteChannel(new SessionTokenOwner());
  let sends = 0;
  rc.channel = { state: 'closed', send: async () => { sends++; return 'ok'; } };
  rc.signalResultAvailable('offline-result');
  await new Promise((resolve) => setImmediate(resolve));
  assert(sends === 0, 'unjoined realtime channel must defer to durable server recovery');
});

// --- 4. Heartbeat cadence tiers ---------------------------------------------
// The server tiers its offline sweep on the capability FLAG, not the app
// version, and the flag is only set once presence is proven. So an unproven
// device is judged by the 45s legacy rule and must heartbeat fast enough to
// survive it, or it is swept offline while its legacy channel still works.

await test('legacy tier heartbeats inside the server 45s sweep threshold', async () => {
  const { rc } = makeRemoteChannel();
  rc.transportCapableWritten = null; // never written = legacy tier
  const cadence = rc.heartbeatIntervalMs();
  assert(
    cadence * 2 < SERVER_LEGACY_OFFLINE_TIMEOUT_MS,
    `legacy cadence ${cadence}ms must allow >=2 writes inside ${SERVER_LEGACY_OFFLINE_TIMEOUT_MS}ms`
  );
  rc.transportCapableWritten = false; // explicitly withdrawn
  assert(rc.heartbeatIntervalMs() === cadence, 'a withdrawn capability uses the fast cadence');
});

await test('capable tier heartbeats inside the server capable sweep threshold', async () => {
  const { rc } = makeRemoteChannel();
  rc.transportCapableWritten = true;
  const cadence = rc.heartbeatIntervalMs();
  assert(
    cadence * 2 < SERVER_CAPABLE_OFFLINE_TIMEOUT_MS,
    `capable cadence ${cadence}ms must allow >=2 writes inside ${SERVER_CAPABLE_OFFLINE_TIMEOUT_MS}ms`
  );
  assert(cadence > SERVER_LEGACY_OFFLINE_TIMEOUT_MS, 'capable cadence is the slow one');
});

await test('withdrawing the capability re-arms the heartbeat at the fast cadence', async () => {
  const { rc } = makeRemoteChannel();
  rc.transportCapableWritten = true;
  rc.channel = makeChannelState('joined');
  rc.startHeartbeat(DEVICE_ID);
  try {
    const armed = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => {
      armed.push(ms);
      return realSetTimeout(() => {}, 0); // never fire
    };
    try {
      await rc.setTransportCapable(false);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert(armed.length > 0, 'withdrawing must re-arm the heartbeat timer');
    assert(
      armed[armed.length - 1] * 2 < SERVER_LEGACY_OFFLINE_TIMEOUT_MS,
      `re-armed cadence ${armed[armed.length - 1]}ms must fit the 45s sweep`
    );
  } finally {
    rc.stopHeartbeat();
  }
});

await test('stopHeartbeat halts the self-rescheduling timer', async () => {
  const { rc } = makeRemoteChannel();
  rc.channel = makeChannelState('joined');
  rc.startHeartbeat(DEVICE_ID);
  rc.stopHeartbeat();
  assert(rc.heartbeatInterval === null, 'timer handle cleared');
  assert(rc.heartbeatDeviceId === null, 'device id cleared so re-arm is inert');
  rc.scheduleHeartbeat(); // must be inert after stop
  assert(rc.heartbeatInterval === null, 'scheduleHeartbeat after stop must not re-arm');
});

// --- 5. Reachability and status writes --------------------------------------

await test('status transition is committed locally only after the DB PATCH succeeds', async () => {
  const { rc } = makeRemoteChannel({ writeErrors: [{ message: 'db unavailable' }, null] });
  rc.lastDeviceStatus = 'offline';

  const failed = await rc.setOnlineStatus(DEVICE_ID, 'online');
  assert(failed === false, 'failed status PATCH was reported as persisted');
  assert(rc.lastDeviceStatus === 'offline', 'failed status PATCH advanced local transition state');

  const succeeded = await rc.setOnlineStatus(DEVICE_ID, 'online');
  assert(succeeded === true, 'successful status PATCH was not acknowledged');
  assert(rc.lastDeviceStatus === 'online', 'confirmed status PATCH did not advance local transition state');
});
// `status` is what the server's device selection filters on, and it is
// transport-agnostic — so it must follow "reachable by ANY transport", never the
// private channel alone.

await test('heartbeat writes bookkeeping only when the legacy channel is joined', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = null; // private channel never joined
  rc.legacyChannel = makeChannelState('joined'); // fallback is up
  await rc.updateHeartbeat(DEVICE_ID);
  assert(client.writes.length === 1, 'legacy-only reachable device must still write last_seen');
  assert(client.writes[0].last_seen, 'write should bump last_seen');
  assert(!Object.hasOwn(client.writes[0], 'status'), 'heartbeat must not compete with DeviceStatusArbiter for status ownership');
});

await test('heartbeat stays silent when no transport is joined', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('errored');
  rc.legacyChannel = makeChannelState('closed');
  await rc.updateHeartbeat(DEVICE_ID);
  assert(client.writes.length === 0, 'a deaf device must let the sweep age its row out');
});

await test('heartbeat writes when the private channel is joined', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('joined');
  rc.legacyChannel = null;
  await rc.updateHeartbeat(DEVICE_ID);
  assert(client.writes.length === 1, 'private channel joined = reachable');
});

await test('private-channel failure keeps status online while legacy is joined', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('errored');
  rc.legacyChannel = makeChannelState('joined');
  rc.syncReachabilityStatus();
  await rc.statusWriteChain;
  assert(client.writes.length === 1, 'one status write');
  assert(client.writes[0].status === 'online', 'still reachable via legacy = online');
});

await test('soft private transport timeout does not tear down the existing channel', async () => {
  const { rc } = makeRemoteChannel();
  const channel = makeChannelState('errored');
  rc.channel = channel;
  rc.legacyChannel = makeChannelState('joined');
  rc.transportCapableWritten = true;
  rc.handlePrivateTransportFailure(new Error('Tool call channel subscription timed out'));
  assert(rc.channel === channel, 'soft timeout destroyed the existing private channel');
});

await test('health watchdog does not duplicate realtime-js recovery on an open socket', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('errored');
  rc.legacyChannel = makeChannelState('joined');
  client.realtime.connectionState = () => 'open';
  let recreates = 0;
  rc.recreateChannel = async () => { recreates++; };
  rc.checkConnectionHealth();
  assert(recreates === 0, `health watchdog duplicated realtime-js recovery: ${recreates}`);
});

await test('status goes offline when no transport is joined', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('errored');
  rc.legacyChannel = makeChannelState('closed');
  rc.syncReachabilityStatus();
  await rc.statusWriteChain;
  assert(client.writes[0].status === 'offline', 'genuinely deaf device goes offline');
});

await test('concurrent status writes stay ordered', async () => {
  // The first write completes AFTER the second is issued. Without the
  // statusWriteChain serialisation the teardown's 'offline' then lands at the
  // DB after the re-join's 'online', leaving a healthy device undispatchable
  // until the next heartbeat (up to 5 min on the capable tier). Assert on
  // `completions`, not `writes` — see makeFakeClient.
  const { rc, client } = makeRemoteChannel({ writeLatencies: [20, 0] });
  rc.channel = makeChannelState('joined');
  rc.queueStatusWrite('offline'); // teardown
  rc.queueStatusWrite('online'); // immediate re-join
  await rc.statusWriteChain;
  // Let the deferred first write land even when the implementation does NOT
  // serialise, so this fails on ORDER — the actual bug — rather than on timing.
  const deadline = Date.now() + 500;
  while (client.completions.length < 2 && Date.now() < deadline) {
    await new Promise((r) => realSetTimeout(r, 5));
  }
  assert(client.writes.length === 2, 'both writes issued');
  assert(client.completions.length === 2, 'both writes completed');
  assert(
    client.completions.map((w) => w.status).join(',') === 'offline,online',
    `writes must COMPLETE in issue order so the join wins, got ${client.completions
      .map((w) => w.status)
      .join(',')}`
  );
});

// --- 6. Capability withdrawal -----------------------------------------------
// For a flagged device the server treats absent presence as authoritative
// offline and applies that overlay before selection, overriding `status`. So a
// device that cannot join the private channel must stop advertising the flag or
// it is undispatchable however healthy its legacy channel is.

await test('private recreate evicts a stale same-topic wrapper before one replacement', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.sleep = () => Promise.resolve();
  rc.channel = null;
  rc.legacyChannel = makeChannelState('joined');

  const stale = { topic: 'realtime:user:user-1', state: 'errored', teardown: () => {} };
  const registry = [stale];
  client.getChannels = () => registry;
  client.removeChannel = async () => 'error';
  client.realtime._remove = (channel) => {
    const index = registry.indexOf(channel);
    if (index >= 0) registry.splice(index, 1);
  };

  let privateCreates = 0;
  let legacyCreates = 0;
  rc.createChannel = async () => { privateCreates++; };
  rc.createLegacyChannel = () => { legacyCreates++; };

  await rc.recreateChannel();
  assert(registry.length === 0, 'stale private wrapper remained registered');
  assert(privateCreates === 1, `expected one private replacement, got ${privateCreates}`);
  assert(legacyCreates === 0, 'private replacement touched the legacy channel');
});

await test('sustained recreate failure withdraws the transport capability', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.transportCapableWritten = true; // previously proven
  rc.legacyChannel = makeChannelState('joined');
  rc.sleep = () => Promise.resolve(); // skip the jittered backoff
  const order = [];
  rc.createChannel = () => {
    order.push('private');
    return Promise.reject(new Error('Unauthorized'));
  };
  rc.createLegacyChannel = () => { order.push('legacy'); };
  rc.channel = makeChannelState('errored');

  for (let i = 0; i < 3; i++) await rc.recreateChannel();

  // Recovery owns only the private channel. The legacy safety net must remain
  // untouched while private replacements fail.
  assert(
    order.join(',') === 'private,private,private',
    `private recovery unexpectedly touched another transport: ${JSON.stringify(order)}`
  );
  assert(
    order.filter((o) => o === 'legacy').length === 0,
    'private recreate must not rebuild or close the legacy channel'
  );
  assert(rc.transportCapableWritten === false, 'capability must be withdrawn');
  const capWrite = client.writes.find((w) => w.capabilities);
  assert(capWrite, 'a capabilities write should have been issued');
  assert(
    capWrite.capabilities.transport_broadcast_v1 === undefined,
    'the withdrawn payload must not carry the flag'
  );
  assert(capWrite.capabilities.app_version !== undefined, 'app_version must survive');
});

await test('desktop integration forwards MCP server instructions with the tool catalog', async () => {
  const integration = new DesktopCommanderIntegration();
  integration.mcpClient = {
    listTools: async () => ({ tools: [{ name: 'mcp_list_tools' }, { name: 'mcp_call_tool' }] }),
    getInstructions: () => 'Prefer semantic MCP tools before generic text search/read.',
  };

  const capabilities = await integration.listClientTools();

  assert(capabilities.tools.length === 2, 'integration dropped the local MCP tool catalog');
  assert(capabilities.instructions?.includes('semantic MCP tools'), 'integration dropped MCP server instructions');
});

await test('remote row metadata cannot downgrade the trusted remote call marker', async () => {
  const integration = new DesktopCommanderIntegration();
  let forwarded;
  integration.isReady = true;
  integration.mcpTransport = {};
  integration.mcpClient = {
    callTool: async (request) => { forwarded = request; return { content: [] }; },
  };

  await integration.callClientTool('get_config', {}, {
    remote: false,
    conversation_id: 'trusted-boundary-test',
  });

  assert(forwarded?._meta?.remote === true, 'untrusted metadata downgraded a remote call to local');
  assert(forwarded?._meta?.conversation_id === 'trusted-boundary-test', 'non-authority metadata was not preserved');
});

await test('transient tools/list failure preserves the last validated capability catalog', async () => {
  const integration = new DesktopCommanderIntegration();
  let fail = false;
  integration.mcpClient = {
    listTools: async () => {
      if (fail) throw new Error('temporary tools/list failure');
      return { tools: [{ name: 'stable-tool' }] };
    },
    getInstructions: () => 'stable instructions',
  };

  const initial = await integration.listClientTools();
  fail = true;
  const fallback = await integration.listClientTools();

  assert(fallback === initial, 'transient discovery failure did not reuse the last validated catalog');
  assert(fallback.tools[0]?.name === 'stable-tool', 'transient discovery failure erased the tool catalog');
});

await test('initial tools/list failure is surfaced instead of advertising an empty catalog', async () => {
  const integration = new DesktopCommanderIntegration();
  integration.mcpClient = {
    listTools: async () => { throw new Error('initial discovery failed'); },
    getInstructions: () => undefined,
  };
  let error;
  try { await integration.listClientTools(); } catch (caught) { error = caught; }
  assert(/initial discovery failed/.test(error?.message || ''), 'initial discovery failure was swallowed');
});

await test('overlapping tools/list refreshes are serialized so an older response cannot win last', async () => {
  const integration = new DesktopCommanderIntegration();
  let releaseFirst;
  let calls = 0;
  integration.mcpClient = {
    listTools: async () => {
      calls += 1;
      if (calls === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      return { tools: [{ name: calls === 1 ? 'old-tool' : 'new-tool' }] };
    },
    getInstructions: () => undefined,
  };

  const first = integration.listClientTools();
  const second = integration.listClientTools();
  await new Promise((resolve) => setImmediate(resolve));
  assert(calls === 1, 'overlapping capability discovery was not serialized');
  releaseFirst();
  const [oldCatalog, newCatalog] = await Promise.all([first, second]);
  assert(oldCatalog.tools[0]?.name === 'old-tool', 'first capability response changed unexpectedly');
  assert(newCatalog.tools[0]?.name === 'new-tool', 'queued capability response did not observe the newer catalog');
  integration.mcpClient = null;
  const cached = await integration.listClientTools();
  assert(cached.tools[0]?.name === 'new-tool', 'older discovery response replaced the latest cache');
});

await test('capability refresh rejects malformed envelopes before replacing the catalog', async () => {
  const { rc } = makeRemoteChannel();
  rc.deviceCapabilities = { tools: [{ name: 'stable-tool' }] };
  let error;
  try { await rc.refreshDeviceCapabilities({}); } catch (caught) { error = caught; }
  assert(/invalid tools\/list envelope/.test(error?.message || ''), 'malformed capability refresh was accepted');
  assert(rc.deviceCapabilities.tools[0]?.name === 'stable-tool', 'malformed refresh erased the previous catalog');
});

await test('device registration keeps the local MCP catalog out of hosted capabilities', async () => {
  const { rc } = makeRemoteChannel();
  const catalog = {
    tools: [
      { name: 'mcp_list_tools', description: 'List external MCP tools', inputSchema: { type: 'object' } },
      { name: 'mcp_call_tool', description: 'Call an external MCP tool', inputSchema: { type: 'object' } },
    ],
    instructions: 'Prefer semantic MCP tools before generic text search/read.',
  };
  let registrationWrite = null;
  rc.findDevice = async () => ({ id: DEVICE_ID, device_name: 'old-name' });
  rc.updateDevice = async (_id, payload) => {
    registrationWrite = payload;
    return { data: null, error: null };
  };
  rc.createLegacyChannel = () => {};
  rc.createChannel = async () => {};

  await rc.registerDevice(catalog, DEVICE_ID, 'test-device', () => {});

  assert(registrationWrite, 'registration must update the device record');
  assert(registrationWrite.capabilities.tools === undefined, 'registration leaked the child tool catalog into the hosted contract');
  assert(registrationWrite.capabilities.instructions === undefined, 'registration leaked child instructions into the hosted contract');
  assert(registrationWrite.capabilities.app_version !== undefined, 'app_version must be composed');
  assert(registrationWrite.capabilities.device_session_v1 === undefined, 'registration leaked a fork-private session field');
  assert(registrationWrite.capabilities.transport_broadcast_v1 === undefined, 'transport flag must wait for proven presence');
});

await test('device status writes keep the upstream hosted shape', async () => {
  const old = makeRemoteChannel();
  await old.rc.setOnlineStatus(DEVICE_ID, 'offline');
  assert(old.client.containsFilters.length === 0, 'status write emitted a fork-private capability predicate');
});

await test('blocking offline shutdown keeps the upstream argument and update shape', async () => {
  const script = await fs.readFile(new URL('../src/remote-device/scripts/blocking-offline-update.js', import.meta.url), 'utf8');
  assert(!script.includes('sessionGeneration'), 'blocking shutdown still accepts a fork-private session generation');
  assert(!script.includes(".contains('capabilities'"), 'blocking shutdown still emits a fork-private capability predicate');
  assert(script.includes(".update({ status: 'offline', last_seen: new Date().toISOString() })"), 'blocking shutdown lost the upstream status update');
});

await test('transport capability writes remain compatible with the compact hosted contract', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.deviceCapabilities = {
    tools: [
      { name: 'mcp_list_tools', description: 'List external MCP tools', inputSchema: { type: 'object' } },
      { name: 'mcp_call_tool', description: 'Call an external MCP tool', inputSchema: { type: 'object' } },
    ],
    instructions: 'Prefer semantic MCP tools before generic text search/read.',
  };

  await rc.setTransportCapable(true);
  await rc.setTransportCapable(false);

  const capabilityWrites = client.writes.filter((w) => w.capabilities).map((w) => w.capabilities);
  assert(capabilityWrites.length === 2, `expected 2 capability writes, got ${capabilityWrites.length}`);
  for (const payload of capabilityWrites) {
    assert(payload.tools === undefined, 'transport update leaked the child tool catalog');
    assert(payload.instructions === undefined, 'transport update leaked child instructions');
    assert(payload.app_version !== undefined, 'app_version must survive');
  }
  assert(capabilityWrites[0].transport_broadcast_v1 === true, 'enable write must advertise broadcast');
  assert(capabilityWrites[1].transport_broadcast_v1 === undefined, 'withdraw write must remove broadcast only');
  assert(client.containsFilters.length === 0, 'transport capability write emitted fork-private predicates');
});

await test('local catalog refresh does not race or rewrite hosted transport capabilities', async () => {
  const { rc, client } = makeRemoteChannel({ writeLatencies: [20, 0] });
  rc.transportCapableWritten = false;
  const refresh = rc.refreshDeviceCapabilities({ tools: [{ name: 'new-tool' }] });
  const enable = rc.setTransportCapable(true);
  await Promise.all([refresh, enable]);

  const writes = client.completions.filter((entry) => entry.capabilities);
  assert(writes.length === 1, `expected only the transport capability write, got ${writes.length}`);
  const final = writes[writes.length - 1].capabilities;
  assert(final.transport_broadcast_v1 === true, 'late catalog refresh removed the proven transport flag');
  assert(final.tools === undefined, 'local catalog refresh was published to the hosted contract');
  assert(rc.deviceCapabilities.tools?.[0]?.name === 'new-tool', 'local catalog refresh was not retained in process');
});

await test('stale presence completion cannot mutate a newer channel generation', async () => {
  const { rc } = makeRemoteChannel();
  let finishTrack;
  const oldChannel = { state: 'joined', track: () => new Promise((resolve) => { finishTrack = resolve; }) };
  rc.channel = oldChannel;
  rc.channelGeneration = 1;
  rc.presenceTracked = false;
  rc.transportCapableWritten = false;
  const inFlight = rc.trackPresenceWithRetry(0, 1, 1);
  await new Promise((resolve) => setImmediate(resolve));
  rc.channel = { state: 'joined' };
  rc.channelGeneration = 2;
  finishTrack('ok');
  await inFlight;
  assert(rc.presenceTracked === false, 'stale track completion changed current presence state');
  assert(rc.transportCapableWritten === false, 'stale track completion changed current capability state');
});

await test('a single recreate failure does not withdraw the capability', async () => {
  const { rc } = makeRemoteChannel();
  rc.transportCapableWritten = true;
  rc.legacyChannel = makeChannelState('joined');
  rc.sleep = () => Promise.resolve();
  rc.createChannel = () => Promise.reject(new Error('transient'));
  rc.createLegacyChannel = () => {};
  rc.channel = makeChannelState('errored');
  await rc.recreateChannel();
  assert(rc.transportCapableWritten === true, 'one blip must not withdraw');
});

await test('a hanging capability withdrawal cannot pin the recreate guard', async () => {
  const { rc } = makeRemoteChannel();
  rc.transportCapableWritten = true;
  rc.legacyChannel = makeChannelState('joined');
  rc.sleep = () => Promise.resolve();
  rc.createChannel = () => Promise.reject(new Error('Unauthorized'));
  rc.createLegacyChannel = () => {};
  rc.channel = makeChannelState('errored');
  rc.setTransportCapable = () => new Promise(() => {}); // never settles
  const realWithTimeout = rc.withTimeout.bind(rc);
  rc.withTimeout = (op, _ms, name) => realWithTimeout(op, 20, name);

  for (let i = 0; i < 3; i++) await rc.recreateChannel();

  assert(rc.isRecreatingChannel === false, 'the guard must be released even if the write hangs');
});

// --- 7. Shutdown ------------------------------------------------------------
// setOffline()'s durable write is the final word on status, so nothing may race
// or outlast it — device.ts force-exits 5s after the signal.

await test('status writes are suppressed once shutting down', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('joined');
  rc.legacyChannel = makeChannelState('joined');
  rc.shuttingDown = true;
  rc.syncReachabilityStatus();
  rc.queueStatusWrite('online');
  await rc.statusWriteChain;
  assert(client.writes.length === 0, 'no status write after teardown starts');
});

await test('heartbeat is suppressed once shutting down', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = makeChannelState('joined');
  rc.shuttingDown = true;
  await rc.updateHeartbeat(DEVICE_ID);
  assert(client.writes.length === 0, 'no heartbeat write during shutdown');
});

await test('unsubscribe is bounded and still clears the channel', async () => {
  const { rc } = makeRemoteChannel();
  rc.legacyChannel = null;
  rc.channel = {
    state: 'joined',
    untrack: () => new Promise(() => {}), // never settles
    unsubscribe: () => new Promise(() => {}), // half-open socket
  };
  rc.sleep = () => Promise.resolve();
  await rc.unsubscribe();
  assert(rc.channel === null, 'must give up on a wedged leave push and move on');
  assert(rc.shuttingDown === true, 'teardown flag set');
});

await test('setOffline does not hang when getSession stalls', async () => {
  const { rc } = makeRemoteChannel();
  rc.client.auth = { getSession: () => new Promise(() => {}) }; // never settles
  rc.lastKnownSession = { access_token: 'cached-at', refresh_token: 'cached-rt' };
  // Missing config makes setOffline return right after the session step, so no
  // subprocess is spawned.
  rc.client.supabaseUrl = undefined;
  rc.client.supabaseKey = undefined;

  let settled = false;
  await Promise.race([
    rc.setOffline(DEVICE_ID).then(() => { settled = true; }),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  assert(settled, 'setOffline must settle rather than block the shutdown path');
});

console.log(`\n${failures ? '🔴' : '✅'} remote transport: ${failures} failing test(s).`);
process.exit(failures ? 1 : 0);
