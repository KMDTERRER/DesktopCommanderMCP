import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const sentinel = 'NESTED_SERVER_PRIVATE_LINE_MUST_NOT_ESCAPE';

if (process.argv[2] === '--probe') {
  const { DesktopCommanderIntegration } = await import('../dist/remote-device/desktop-commander-integration.js');
  const integration = new DesktopCommanderIntegration();
  integration.resolveMcpConfig = async () => ({
    command: process.execPath,
    args: [path.join(testDir, 'fixtures', 'remote-supervision-mcp.js')],
    cwd: repoRoot,
    env: { DC_TEST_STDERR_SENTINEL: sentinel, DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1' },
  });
  try {
    await integration.initialize();
    await integration.callClientTool('ping', {});
  } finally {
    await integration.shutdown().catch(() => undefined);
  }
  process.stdout.write('probe complete\n');
  process.exit(0);
}

const probe = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe'], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: { ...process.env, DC_MCP_STDIO_TRACE: 'false' },
  timeout: 20_000,
});

assert.equal(probe.status, 0, probe.stderr || probe.stdout || `probe exited ${probe.status}`);
assert(!probe.stderr.includes(sentinel), `nested MCP stderr escaped to the owner terminal: ${probe.stderr}`);
assert(!probe.stdout.includes(sentinel), `nested MCP stderr crossed into protocol/console stdout: ${probe.stdout}`);
console.log('remote child stderr isolation: PASS');
