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
import { createRemoteOutcomeIdentity, RemoteChannel } from '../dist/remote-device/remote-channel.js';
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
    getCallClaimMetadata: () => ({ _desktop_commander_claim_token: 'test-claim-token' }),
    updateCallResult: async () => {},
    notifyResult: async () => ({ acknowledged: true, attempts: 1, lastStatus: 'test:ok' }),
  };
  return { device, executed, outboxEntries };
}

/**
 * Supabase client fake covering both shapes the device uses:
 * `update(...).eq(...)` (awaited) and `select(...).eq(...).maybeSingle()`.
 * Records every mcp_devices write in `writes`.
 */
function makeFakeClient({ row = null, failFetches = 0, writeLatencies = [] } = {}) {
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
      };
      return chain;
    },
    select: () => chain,
    insert: () => chain,
    contains: (column, value) => { containsFilters.push({ column, value }); return chain; },
    eq: () => {
      if (!pendingWrite) return result();
      const { payload, delay } = pendingWrite;
      pendingWrite = null;
      const p = new Promise((resolve) => {
        const settle = () => {
          completions.push(payload);
          resolve({ data: null, error: null });
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
  rc.deviceSessionLease = { generation: 'test-session-generation', acquired_at: '2026-08-17T00:00:00.000Z' };
  return { rc, client };
}

const payloadFor = (id, deviceId = DEVICE_ID) => ({
  new: {
    id,
    tool_name: 'start_process',
    tool_args: { command: 'echo hi' },
    device_id: deviceId,
    metadata: {},
  },
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

await test('TOKEN_REFRESHED forwards the rotated refresh token to device persistence', async () => {
  const rc = new RemoteChannel();
  let authCallback = null;
  let persisted = null;
  rc.client = {
    auth: {
      setSession: async () => ({ error: null }),
      getUser: async () => ({ data: { user: { id: 'user-1', email: 'tester@example.com' } }, error: null }),
      getSession: async () => ({ data: { session: { access_token: 'current-access', refresh_token: 'current-refresh' } } }),
      onAuthStateChange: (callback) => { authCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    realtime: { setAuth() {} },
  };
  rc.setSessionUpdateHandler((session) => { persisted = session; });

  await rc.setSession({ access_token: 'old-access', refresh_token: 'old-refresh' });
  assert(authCallback, 'auth state listener was not registered');
  authCallback('TOKEN_REFRESHED', { access_token: 'rotated-access', refresh_token: 'rotated-refresh' });

  assert(persisted?.refresh_token === 'rotated-refresh', 'rotated refresh token was not forwarded to persistence');
  assert(persisted?.access_token === 'rotated-access', 'rotated access token was not forwarded to persistence');
});


// --- 1. Exactly-once under dual delivery ------------------------------------
// Both transports deliver every call during the transition. The DB claim fails
// OPEN on a transient error, so the in-memory guard is the real guarantee.

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
        metadata: {},
      },
    });
  } finally {
    process.stderr.write = originalWrite;
    process.env.DESKTOP_COMMANDER_REMOTE_TOOL_TRACE = 'false';
  }
  const trace = lines.join('');
  assert(trace.includes('[TOOL] ▶ START | call=trace-call-1 | read_file -> mcp://desktop-accelerators/ast_rewrite'), `missing start trace: ${trace}`);
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

await test('slow remote persistence cannot block completed handlers under parallel load', async () => {
  const { device, executed, outboxEntries } = makeDevice();
  let releaseWrites;
  const writeGate = new Promise((resolve) => { releaseWrites = resolve; });
  const deliveryModes = [];
  device.remoteChannel.updateCallResult = async (_callId, _status, _result, _error, _claim, mode) => {
    deliveryModes.push(mode);
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
  assert(deliveryModes.length > 0 && deliveryModes.every((mode) => mode === 'live'),
    `initial result delivery must use the short live policy, got ${JSON.stringify(deliveryModes)}`);

  releaseWrites();
  const deadline = Date.now() + 1000;
  while (outboxEntries.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert(outboxEntries.size === 0, 'released live deliveries did not retire their outbox entries');
});

await test('live result persistence uses two bounded attempts before durable replay takes over', async () => {
  const { rc } = makeRemoteChannel();
  const client = makeNeverSettlingClient();
  rc.client = client;
  rc.callClaimTokens.set('live-never-result', 'test-claim-token');
  rc.sleep = () => Promise.resolve();

  let error;
  try {
    await withAcceleratedRemoteDeadlines(() =>
      rc.updateCallResult(
        'live-never-result', 'completed', { content: [{ type: 'text', text: 'ok' }] },
        null, undefined, 'live'
      )
    );
  } catch (caught) {
    error = caught;
  }

  assert(error, 'unconfirmed live persistence must defer to the durable outbox');
  assert(client.updates.length === 2, `expected exactly two bounded live writes, got ${client.updates.length}`);
  assert(client.signals.length >= 1 && client.signals.every((signal) => signal.aborted),
    'live timeout must abort its in-flight remote requests');
  assert(rc.callClaimTokens.has('live-never-result'), 'deferred live delivery must preserve claim ownership');
});

await test('a stale non-transient outbox entry does not block later deliverable results', async () => {
  const { device, outboxEntries } = makeDevice();
  outboxEntries.set('poison', { version: 1, callId: 'poison', userId: 'user-1', claimToken: 'claim-poison', status: 'completed', result: { content: [] }, errorMessage: null, createdAt: new Date().toISOString() });
  outboxEntries.set('good', { version: 1, callId: 'good', userId: 'user-1', claimToken: 'claim-good', status: 'completed', result: { content: [] }, errorMessage: null, createdAt: new Date().toISOString() });
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

await test('an outbox entry whose remote call is confirmed gone is discarded instead of retried forever', async () => {
  const { device, outboxEntries } = makeDevice();
  outboxEntries.set('gone', { version: 1, callId: 'gone', userId: 'user-1', claimToken: 'claim-gone', status: 'completed', result: { content: [] }, errorMessage: null, createdAt: new Date().toISOString() });
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
  device.remoteChannel.notifyResult = async (callId) => {
    order.push(`notify:${callId}`);
    return { acknowledged: true, attempts: 1, lastStatus: 'test:ok' };
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
      version: 1, callId, userId: 'user-1', claimToken: `claim-${callId}`,
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
    await withAcceleratedRemoteDeadlines(() => rc.markCallExecuting('never-claim'));
  } catch (caught) {
    error = caught;
  }

  assert(error, 'an ambiguous claim must reject rather than execute fail-open');
  assert(client.signals.length >= 6, `expected bounded claim + reconcile attempts, got ${client.signals.length}`);
  assert(client.signals.every((signal) => signal.aborted), 'every timed-out ownership probe must abort its request signal');
});

await test('transient result persistence failure retries without discarding a successful tool result', async () => {
  const { rc } = makeRemoteChannel();
  const claimToken = 'transient-result-claim';
  let updateAttempts = 0;
  let reconcileAttempts = 0;
  let fallbackWrites = 0;

  const updateChain = (payload) => {
    const chain = {
      eq: () => chain,
      contains: () => chain,
      select: () => chain,
      abortSignal: async () => {
        updateAttempts++;
        if (payload.status === 'failed') fallbackWrites++;
        if (updateAttempts === 1) throw new TypeError('fetch failed');
        return { data: [{ id: 'transient-result', status: payload.status, metadata: { _desktop_commander_claim_token: claimToken } }], error: null };
      },
    };
    return chain;
  };
  const selectChain = {
    eq: () => selectChain,
    abortSignal: () => selectChain,
    maybeSingle: async () => {
      reconcileAttempts++;
      if (reconcileAttempts === 1) throw new TypeError('fetch failed');
      return { data: { status: 'executing', metadata: { _desktop_commander_claim_token: claimToken } }, error: null };
    },
  };
  rc.client = {
    from: () => ({
      update: (payload) => updateChain(payload),
      select: () => selectChain,
    }),
  };
  rc.sleep = () => Promise.resolve();
  rc.callClaimTokens.set('transient-result', claimToken);

  await rc.updateCallResult('transient-result', 'completed', { content: [{ type: 'text', text: 'valuable result' }] });

  assert(updateAttempts === 2, `expected one transient retry, got ${updateAttempts} updates`);
  assert(fallbackWrites === 0, 'a transient transport failure must not replace the successful result with fallback');
  assert(!rc.callClaimTokens.has('transient-result'), 'confirmed result must release local claim ownership');
});

await test('remote outcome hash is canonical and includes terminal status', async () => {
  const left = createRemoteOutcomeIdentity('completed', { b: 2, a: { y: 2, x: 1 } }, null);
  const right = createRemoteOutcomeIdentity('completed', { a: { x: 1, y: 2 }, b: 2 }, null);
  const failed = createRemoteOutcomeIdentity('failed', { a: { x: 1, y: 2 }, b: 2 }, null);
  assert(left.outcomeRevision === 1, 'outcome revision must start at 1');
  assert(left.outcomeHash === right.outcomeHash, 'object key order must not change canonical outcome hash');
  assert(left.outcomeHash !== failed.outcomeHash, 'terminal status must participate in outcome identity');
});

await test('ambiguous terminal write rejects a different remote outcome for the same claim', async () => {
  const { rc } = makeRemoteChannel();
  const claimToken = 'identity-mismatch-claim';
  const expectedResult = { content: [{ type: 'text', text: 'expected' }] };
  const remoteResult = { content: [{ type: 'text', text: 'different' }] };
  const updateChain = {
    eq: () => updateChain,
    contains: () => updateChain,
    select: () => updateChain,
    abortSignal: async () => ({ data: [], error: null }),
  };
  const selectChain = {
    eq: () => selectChain,
    abortSignal: () => selectChain,
    maybeSingle: async () => ({
      data: { status: 'completed', result: remoteResult, error_message: null, metadata: { _desktop_commander_claim_token: claimToken } },
      error: null,
    }),
  };
  rc.client = { from: () => ({ update: () => updateChain, select: () => selectChain }) };
  rc.callClaimTokens.set('identity-mismatch', claimToken);

  let error;
  try {
    await rc.updateCallResult('identity-mismatch', 'completed', expectedResult);
  } catch (caught) {
    error = caught;
  }

  assert(/outcome identity mismatch/i.test(error?.message || ''), `expected identity mismatch, got ${error?.message}`);
  assert(rc.callClaimTokens.has('identity-mismatch'), 'mismatched remote outcome must retain local claim for replay/forensics');
});

await test('ambiguous terminal write accepts the exact legacy remote outcome without identity metadata', async () => {
  const { rc } = makeRemoteChannel();
  const claimToken = 'identity-match-claim';
  const expectedResult = { content: [{ type: 'text', text: 'same' }], structuredContent: { z: 1, a: 2 } };
  const remoteResult = { structuredContent: { a: 2, z: 1 }, content: [{ text: 'same', type: 'text' }] };
  const updateChain = {
    eq: () => updateChain,
    contains: () => updateChain,
    select: () => updateChain,
    abortSignal: async () => ({ data: [], error: null }),
  };
  const selectChain = {
    eq: () => selectChain,
    abortSignal: () => selectChain,
    maybeSingle: async () => ({
      data: { status: 'completed', result: remoteResult, error_message: null, metadata: { _desktop_commander_claim_token: claimToken } },
      error: null,
    }),
  };
  rc.client = { from: () => ({ update: () => updateChain, select: () => selectChain }) };
  rc.callClaimTokens.set('identity-match', claimToken);

  await rc.updateCallResult('identity-match', 'completed', expectedResult);
  assert(!rc.callClaimTokens.has('identity-match'), 'exact legacy remote outcome should reconcile and release claim');
});

await test('terminal result classifies a confirmed missing remote row as gone', async () => {
  const { rc } = makeRemoteChannel();
  const claimToken = 'gone-result-claim';
  const updateChain = {
    eq: () => updateChain,
    contains: () => updateChain,
    select: () => updateChain,
    abortSignal: async () => ({ data: [], error: null }),
  };
  const selectChain = {
    eq: () => selectChain,
    abortSignal: () => selectChain,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  rc.client = { from: () => ({ update: () => updateChain, select: () => selectChain }) };
  rc.callClaimTokens.set('gone-result', claimToken);

  let error;
  try {
    await rc.updateCallResult('gone-result', 'completed', { content: [{ type: 'text', text: 'ok' }] });
  } catch (caught) {
    error = caught;
  }

  assert(error?.code === 'EREMOTECALLGONE', `expected EREMOTECALLGONE, got ${error?.code || error?.message}`);
  assert(rc.callClaimTokens.has('gone-result'), 'gone classification should not mutate claim state before outbox cleanup');
});

await test('result write stays bounded, claim-fenced, and replayable when DB I/O never settles', async () => {
  const { rc } = makeRemoteChannel();
  const client = makeNeverSettlingClient();
  rc.client = client;
  rc.callClaimTokens.set('never-result', 'test-claim-token');
  rc.sleep = () => Promise.resolve();

  let error;
  try {
    await withAcceleratedRemoteDeadlines(() =>
      rc.updateCallResult('never-result', 'completed', { content: [{ type: 'text', text: 'ok' }] })
    );
  } catch (caught) {
    error = caught;
  }

  assert(error, 'an unconfirmed terminal write must reject rather than ring a false result doorbell');
  assert(client.updates.length === 3, `expected 3 original-result attempts, got ${client.updates.length}`);
  assert(client.updates.every((value) => value.status === 'completed'), 'persistence retries must never synthesize a failed outcome');
  assert(client.signals.length >= 4, `expected bounded writes + reconciliation reads, got ${client.signals.length}`);
  assert(client.signals.every((signal) => signal.aborted), 'every timed-out terminal/reconcile query must be aborted');
  assert(rc.callClaimTokens.has('never-result'), 'unconfirmed result must retain local claim ownership for durable replay');
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
  device.remoteChannel.notifyResult = async () => { order.push('doorbell'); };
  await device.handleNewToolCall(payloadFor('call-order'));
  assert(executed.length === 1, 'tool should have run');
  const deliveryDeadline = Date.now() + 500;
  while (order.length < 2 && Date.now() < deliveryDeadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert(order.join(',') === 'write,doorbell', `expected write,doorbell — got ${order.join(',')}`);
});

await test('result notification falls back to REST after a WebSocket ACK timeout', async () => {
  const rc = new RemoteChannel();
  const transports = [];
  rc.channel = {
    state: 'joined',
    send: async (_message, options) => { transports.push(`ws:${options.timeout}`); return 'timed out'; },
    httpSend: async (_event, _payload, options) => { transports.push(`http:${options.timeout}`); return { success: true }; },
  };
  rc.sleep = () => Promise.resolve();

  const outcome = await rc.notifyResult('notify-fallback');

  assert(outcome.acknowledged === true, 'REST fallback should confirm notification acceptance');
  assert(outcome.attempts === 2, `expected exactly two attempts, got ${outcome.attempts}`);
  assert(transports.length === 2 && transports[0].startsWith('ws:') && transports[1].startsWith('http:'),
    `unexpected notification transports: ${transports.join(',')}`);
});

await test('result notification stops after two unconfirmed attempts', async () => {
  const rc = new RemoteChannel();
  let attempts = 0;
  rc.channel = {
    state: 'joined',
    send: async () => { attempts++; return 'timed out'; },
    httpSend: async () => { attempts++; throw new TypeError('network path alive but no result ACK'); },
  };
  rc.sleep = () => Promise.resolve();

  const outcome = await rc.notifyResult('notify-unconfirmed');

  assert(outcome.acknowledged === false, 'two missing confirmations must remain unconfirmed');
  assert(outcome.attempts === 2, `expected two attempts, got ${outcome.attempts}`);
  assert(attempts === 2, `notification retried more than twice: ${attempts}`);
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
// `status` is what the server's device selection filters on, and it is
// transport-agnostic — so it must follow "reachable by ANY transport", never the
// private channel alone.

await test('heartbeat writes when only the legacy channel is joined', async () => {
  const { rc, client } = makeRemoteChannel();
  rc.channel = null; // private channel never joined
  rc.legacyChannel = makeChannelState('joined'); // fallback is up
  await rc.updateHeartbeat(DEVICE_ID);
  assert(client.writes.length === 1, 'legacy-only reachable device must still write last_seen');
  assert(client.writes[0].last_seen, 'write should bump last_seen');
  assert(client.writes[0].status === 'online', 'write should assert online');
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

  // Also proves the recreate reached createChannel rather than dying earlier,
  // and that the legacy net is rebuilt first and on every attempt.
  assert(
    order.slice(0, 2).join(',') === 'legacy,private',
    `legacy net must be rebuilt first: ${JSON.stringify(order)}`
  );
  assert(
    order.filter((o) => o === 'legacy').length === 3,
    'legacy net must be rebuilt on every recreate attempt'
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

await test('device registration publishes the local MCP tool catalog and instructions', async () => {
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
  assert(registrationWrite.capabilities.tools?.length === 2, 'registration dropped the MCP tool catalog');
  assert(registrationWrite.capabilities.tools[0].name === 'mcp_list_tools', 'proxy list tool missing');
  assert(registrationWrite.capabilities.tools[1].name === 'mcp_call_tool', 'proxy call tool missing');
  assert(registrationWrite.capabilities.instructions?.includes('semantic MCP tools'), 'registration dropped MCP instructions');
  assert(registrationWrite.capabilities.app_version !== undefined, 'app_version must be composed');
  assert(typeof registrationWrite.capabilities.device_session_v1?.generation === 'string', 'registration must acquire a device session generation');
  assert(registrationWrite.capabilities.device_session_v1.generation.length >= 32, 'device session generation must be non-trivial');
  assert(registrationWrite.capabilities.transport_broadcast_v1 === undefined, 'transport flag must wait for proven presence');
});

await test('stale device-process status writes are fenced by their acquired generation', async () => {
  const old = makeRemoteChannel();
  old.rc.deviceSessionLease = { generation: 'old-session-generation', acquired_at: '2026-08-17T00:00:00.000Z' };

  const fresh = makeRemoteChannel();
  let registrationWrite = null;
  fresh.rc.findDevice = async () => ({ id: DEVICE_ID, device_name: 'old-name' });
  fresh.rc.updateDevice = async (_id, payload) => { registrationWrite = payload; return { data: null, error: null }; };
  fresh.rc.createLegacyChannel = () => {};
  fresh.rc.createChannel = async () => {};
  await fresh.rc.registerDevice({ tools: [] }, DEVICE_ID, 'fresh-device', () => {});
  const freshGeneration = registrationWrite.capabilities.device_session_v1.generation;
  assert(freshGeneration !== 'old-session-generation', 'new registration must acquire a new generation');

  await old.rc.setOnlineStatus(DEVICE_ID, 'offline');
  assert(old.client.containsFilters.length === 1, 'stale writer must carry one generation fence');
  assert(old.client.containsFilters[0].value.device_session_v1?.generation === 'old-session-generation', 'stale writer must not adopt the new generation');
  assert(old.client.containsFilters[0].value.device_session_v1.generation !== freshGeneration, 'stale writer predicate unexpectedly matches the new session');
});

await test('blocking offline shutdown is generation-fenced', async () => {
  const script = await fs.readFile(new URL('../src/remote-device/scripts/blocking-offline-update.js', import.meta.url), 'utf8');
  assert(script.includes('sessionGeneration'), 'blocking shutdown script does not accept the session generation');
  assert(script.includes(".contains('capabilities', { device_session_v1: { generation: sessionGeneration } })"), 'blocking shutdown write is not generation-fenced');
  assert(script.includes('Offline write skipped: device session was superseded'), 'superseded shutdown is not classified explicitly');
});

await test('transport capability writes preserve the registered MCP tool catalog', async () => {
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
    assert(payload.tools?.length === 2, 'transport update erased the registered tool catalog');
    assert(payload.tools[0].name === 'mcp_list_tools', 'first proxy tool must survive');
    assert(payload.tools[1].name === 'mcp_call_tool', 'second proxy tool must survive');
    assert(payload.instructions?.includes('semantic MCP tools'), 'transport update erased MCP instructions');
    assert(payload.app_version !== undefined, 'app_version must survive');
  }
  assert(capabilityWrites[0].transport_broadcast_v1 === true, 'enable write must advertise broadcast');
  assert(capabilityWrites[1].transport_broadcast_v1 === undefined, 'withdraw write must remove broadcast only');
  assert(client.containsFilters.length === 2, 'every post-registration capability write must carry a generation fence');
  assert(client.containsFilters.every((filter) => filter.column === 'capabilities'), 'generation fence must target capabilities JSONB');
  assert(client.containsFilters.every((filter) => filter.value.device_session_v1?.generation === 'test-session-generation'), 'capability write used the wrong device generation');
});

await test('capability catalog and transport flag writes are serialized', async () => {
  const { rc, client } = makeRemoteChannel({ writeLatencies: [20, 0] });
  rc.transportCapableWritten = false;
  const refresh = rc.refreshDeviceCapabilities({ tools: [{ name: 'new-tool' }] });
  const enable = rc.setTransportCapable(true);
  await Promise.all([refresh, enable]);

  const writes = client.completions.filter((entry) => entry.capabilities);
  assert(writes.length === 2, `expected 2 capability completions, got ${writes.length}`);
  const final = writes[writes.length - 1].capabilities;
  assert(final.transport_broadcast_v1 === true, 'late catalog refresh removed the proven transport flag');
  assert(final.tools?.[0]?.name === 'new-tool', 'transport write lost the refreshed tool catalog');
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
