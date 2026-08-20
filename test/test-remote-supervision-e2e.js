import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';
import { MCPDevice } from '../dist/remote-device/device.js';
import { DeviceStatusArbiter } from '../dist/remote-device/device-status-arbiter.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const fixture = path.join(testDir, 'fixtures', 'remote-supervision-mcp.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result) => result?.content?.map((part) => part?.text ?? '').join('') ?? '';

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  process.env.DC_LOCAL_RESTART_BACKOFF_BASE_MS = '25';
  process.env.DC_LOCAL_RESTART_STABLE_UPTIME_MS = '100';
  const integration = new DesktopCommanderIntegration();
  integration.resolveMcpConfig = async () => ({ command: process.execPath, args: [fixture], cwd: repoRoot, env: { DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1' } });

  const device = new MCPDevice();
  const statusWrites = [];
  let capabilityRefreshes = 0;
  device.deviceId = undefined;
  device.desktop = integration;
  device.remoteChannel = {
    setOnlineStatus: async (_id, status) => { statusWrites.push(status); },
    refreshDeviceCapabilities: async () => { capabilityRefreshes++; },
  };
  device.statusArbiter = new DeviceStatusArbiter({
    write: async (status) => {
      if (!device.deviceId) return false;
      await device.remoteChannel.setOnlineStatus(device.deviceId, status);
      return true;
    },
  });
  device.statusArbiter.report('channel', true);
  integration.onDisconnect((reason) => { void device.handleLocalMcpLoss(reason); });

  try {
    await integration.initialize();
    device.localMcpStableSince = Date.now();
    device.statusArbiter.report('child', true);
    await device.statusArbiter.flush(); // pre-registration write is intentionally dropped
    device.deviceId = 'supervision-device';
    await device.statusArbiter.sync();
    assert.equal(statusWrites.at(-1), 'online');
    assert.deepEqual(statusWrites, ['online'], `startup status wrote more than one transition: ${statusWrites.join(',')}`);

    const firstPing = await integration.callClientTool('ping', {});
    const firstPid = Number(textOf(firstPing).split(':')[1]);
    assert(Number.isInteger(firstPid) && firstPid > 0, `bad fixture pid: ${textOf(firstPing)}`);

    const startedAt = Date.now();
    const blocked = integration.callClientTool('block', { ms: 60_000 });
    await sleep(100);
    process.kill(firstPid, 'SIGKILL');
    await assert.rejects(blocked);
    assert(Date.now() - startedAt < 5_000, 'in-flight MCP call waited for its long request timeout after child death');

    await waitFor(() => statusWrites.includes('offline'), 3_000, 'offline status after child death');
    await waitFor(() => integration.ready === true && statusWrites.at(-1) === 'online', 5_000, 'single supervised restart');
    assert.equal(capabilityRefreshes, 1, `expected one capability refresh after restart, got ${capabilityRefreshes}`);

    const secondPing = await integration.callClientTool('ping', {});
    const secondPid = Number(textOf(secondPing).split(':')[1]);
    assert(Number.isInteger(secondPid) && secondPid > 0 && secondPid !== firstPid, 'supervision did not replace the dead MCP child');
    assert.deepEqual(statusWrites, ['online', 'offline', 'online'], `status oscillated during one recovery: ${statusWrites.join(',')}`);
    console.log('remote supervision e2e: PASS');
  } finally {
    await integration.shutdown().catch(() => {});
    delete process.env.DC_LOCAL_RESTART_BACKOFF_BASE_MS;
    delete process.env.DC_LOCAL_RESTART_STABLE_UPTIME_MS;
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
