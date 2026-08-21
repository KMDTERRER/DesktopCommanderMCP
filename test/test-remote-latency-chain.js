import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPDevice } from '../dist/remote-device/device.js';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';
import { SessionTokenOwner } from '../dist/remote-device/session-token-owner.js';
import { RemoteCallMetrics } from '../dist/remote-device/remote-call-metrics.js';
import { RemoteResultOutbox } from '../dist/remote-device/result-outbox.js';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const SERVER = path.join(REPO_ROOT, 'dist', 'index.js');
const DEVICE_ID = 'latency-device';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-remote-latency-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-remote-latency-home-'));
  const metricsPath = path.join(root, 'remote-call-metrics.jsonl');
  const configDir = path.join(home, '.claude-server-commander');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    telemetryEnabled: false, allowedDirectories: [root], fileWriteLineLimit: 100,
  }), 'utf8');

  const integration = new DesktopCommanderIntegration();
  integration.resolveMcpConfig = async () => ({
    command: process.execPath, args: [SERVER, '--no-onboarding'], cwd: REPO_ROOT,
    env: { HOME: home, USERPROFILE: home, DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true' },
  });

  const tokens = new SessionTokenOwner();
  const remote = new RemoteChannel(tokens);
  const device = new MCPDevice();
  const metrics = new RemoteCallMetrics(metricsPath);
  const outbox = new RemoteResultOutbox(path.join(root, 'result-outbox'));
  const rows = new Map();
  const claimTokens = new Map();
  const remoteResults = new Map();
  const dispatchAt = new Map();
  const remoteCommitAckAt = new Map();
  const handlerPromises = [];
  let activeFetch = 0, maxFetch = 0;
  let activeClaim = 0, maxClaim = 0;
  let activeCommit = 0, maxCommit = 0;
  let activeWake = 0, maxWake = 0, wakeCount = 0;

  try {
    await integration.initialize();
    for (let i = 0; i < 4; i++) {
      const file = path.join(root, `read-${i}.txt`);
      await fs.writeFile(file, `READ_TOKEN_${i}\n`, 'utf8');
      rows.set(`r${i}`, {
        id: `r${i}`, device_id: DEVICE_ID, user_id: 'latency-user', status: 'pending', tool_name: 'read_file',
        tool_args: { path: file, offset: 0, length: 10 }, metadata: {},
        created_at: new Date(Date.now() - 120).toISOString(),
      });
    }
    for (let i = 0; i < 4; i++) {
      rows.set(`w${i}`, {
        id: `w${i}`, device_id: DEVICE_ID, user_id: 'latency-user', status: 'pending', tool_name: 'write_file',
        tool_args: { path: path.join(root, `write-${i}.txt`), content: `WRITE_TOKEN_${i}\n`, mode: 'rewrite' },
        metadata: {}, created_at: new Date(Date.now() - 120).toISOString(),
      });
    }

    remote.client = {
      from: () => {
        let id;
        const chain = {
          select() { return chain; },
          eq(_field, value) { id = value; return chain; },
          abortSignal() { return chain; },
          async maybeSingle() {
            activeFetch++; maxFetch = Math.max(maxFetch, activeFetch);
            try { await sleep(id === 'r0' ? 140 : 25); return { data: rows.get(id) ?? null, error: null }; }
            finally { activeFetch--; }
          },
        };
        return chain;
      },
    };
    remote.deviceId = DEVICE_ID;
    remote.markCallExecuting = async (callId, metadata) => {
      activeClaim++; maxClaim = Math.max(maxClaim, activeClaim);
      try {
        await sleep(35);
        claimTokens.set(callId, `claim-${callId}`);
        return true;
      } finally { activeClaim--; }
    };
    remote.getCurrentUserId = () => 'latency-user';
    remote.getCallClaimToken = (callId) => claimTokens.get(callId) ?? null;
    remote.releaseCallClaim = (callId) => { claimTokens.delete(callId); };
    remote.signalResultAvailable = async () => {
      activeWake++; maxWake = Math.max(maxWake, activeWake);
      try { await sleep(30); wakeCount++; return { attempted: true, status: 'ok', durationMs: 30 }; }
      finally { activeWake--; }
    };

    device.deviceId = DEVICE_ID;
    device.remoteChannel = remote;
    device.desktop = integration;
    device.callMetrics = metrics;
    device.resultOutbox = outbox;
    remote.updateCallResult = async (callId, status, result, errorMessage) => {
      activeCommit++; maxCommit = Math.max(maxCommit, activeCommit);
      try {
        await sleep(callId === 'w0' ? 220 : 70);
        remoteResults.set(callId, { status, result, errorMessage });
        remoteCommitAckAt.set(callId, Date.now());
      } finally { activeCommit--; }
    };
    remote.onToolCall = (payload) => {
      dispatchAt.set(payload?.new?.id, Date.now());
      const run = device.handleNewToolCall(payload);
      handlerPromises.push(run);
      return run;
    };

    const ids = [...rows.keys()];
    await Promise.all(ids.map((callId) => remote.onDoorbell({ call_id: callId, device_id: DEVICE_ID })));
    assert.equal(handlerPromises.length, ids.length, 'doorbells did not dispatch every call');
    await Promise.all(handlerPromises);

    const deadline = Date.now() + 5000;
    while ((remoteResults.size < ids.length || wakeCount < ids.length) && Date.now() < deadline) await sleep(10);
    assert.equal(remoteResults.size, ids.length, 'not every terminal result reached the simulated remote server');
    assert.equal(wakeCount, ids.length, 'not every terminal result received a wake ACK');

    for (let i = 0; i < 4; i++) {
      assert.equal(await fs.readFile(path.join(root, `write-${i}.txt`), 'utf8'), `WRITE_TOKEN_${i}\n`);
      const text = JSON.stringify(remoteResults.get(`r${i}`)?.result ?? {});
      assert(text.includes(`READ_TOKEN_${i}`), `read_file result ${i} did not cross the remote terminal boundary`);
    }

    await metrics.flush();
    const events = (await fs.readFile(metricsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const byCall = new Map(ids.map((id) => [id, events.filter((event) => event.callId === id)]));
    for (const [id, callEvents] of byCall) {
      const stages = new Set(callEvents.map((event) => event.stage));
      for (const stage of ['recv', 'claim_done', 'tool_done', 'local_persist_done', 'remote_commit_done', 'wake_done']) {
        assert(stages.has(stage), `${id} missing latency stage ${stage}: ${JSON.stringify([...stages])}`);
      }
      const recv = callEvents.find((event) => event.stage === 'recv');
      const claim = callEvents.find((event) => event.stage === 'claim_done');
      const tool = callEvents.find((event) => event.stage === 'tool_done');
      const commit = callEvents.find((event) => event.stage === 'remote_commit_done');
      const wake = callEvents.find((event) => event.stage === 'wake_done');
      assert(recv.rowFetchMs >= (id === 'r0' ? 130 : 20), `${id} did not measure doorbell row-fetch latency`);
      assert(claim.claimMs >= 30 && claim.preToolMs >= 50, `${id} did not expose pre-tool network latency`);
      assert(tool.toolMs >= 0 && tool.toolMs < 2500, `${id} local tool execution unexpectedly dominated: ${tool.toolMs}ms`);
      assert(commit.remoteCommitMs >= (id === 'w0' ? 200 : 60), `${id} did not measure terminal server ACK latency`);
      assert(commit.postToolToRemoteCommitMs >= commit.remoteCommitMs, `${id} post-tool gap is inconsistent`);
      assert(wake.wakeMs >= 25 && wake.wakeStatus === 'ok', `${id} did not measure final wake ACK`);
    }

    const fastRecvAt = Math.min(...ids.filter((id) => id !== 'r0').map((id) => dispatchAt.get(id)));
    const slowRecvAt = dispatchAt.get('r0');
    assert(fastRecvAt + 70 < slowRecvAt, 'one slow doorbell fetch head-of-line blocked unrelated ingress');
    const fastCommitAt = Math.min(...ids.filter((id) => id !== 'w0').map((id) => remoteCommitAckAt.get(id)));
    const slowCommitAt = remoteCommitAckAt.get('w0');
    assert(fastCommitAt + 80 < slowCommitAt, 'one slow terminal server ACK head-of-line blocked unrelated results');

    assert(maxFetch >= 2, `remote ingress serialized unexpectedly: maxFetch=${maxFetch}`);
    assert(maxClaim >= 2, `claim admission serialized unexpectedly: maxClaim=${maxClaim}`);
    assert(maxCommit >= 2, `terminal result persistence serialized unexpectedly: maxCommit=${maxCommit}`);
    assert(maxWake >= 2, `result wake ACKs serialized unexpectedly: maxWake=${maxWake}`);

    const phaseValues = (stage, field) => events.filter((e) => e.stage === stage).map((e) => e[field]).filter(Number.isFinite);
    const avg = (values) => Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
    console.log('remote latency chain:', JSON.stringify({
      calls: ids.length, maxFetch, maxClaim, maxCommit, maxWake,
      avgInboundLagMs: avg(phaseValues('recv', 'inboundLagMs')),
      avgRowFetchMs: avg(phaseValues('recv', 'rowFetchMs')),
      avgClaimMs: avg(phaseValues('claim_done', 'claimMs')),
      avgPreToolMs: avg(phaseValues('claim_done', 'preToolMs')),
      avgToolMs: avg(phaseValues('tool_done', 'toolMs')),
      avgLocalPersistMs: avg(phaseValues('local_persist_done', 'localPersistMs')),
      avgDeliverySlotWaitMs: avg(phaseValues('remote_commit_done', 'deliverySlotWaitMs')),
      avgRemoteCommitMs: avg(phaseValues('remote_commit_done', 'remoteCommitMs')),
      avgPostToolToRemoteCommitMs: avg(phaseValues('remote_commit_done', 'postToolToRemoteCommitMs')),
      avgWakeMs: avg(phaseValues('wake_done', 'wakeMs')),
      avgPostToolToWakeMs: avg(phaseValues('wake_done', 'postToolToWakeMs')),
    }));
  } finally {
    await integration.shutdown().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(() => console.log('remote latency chain: PASS')).catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
