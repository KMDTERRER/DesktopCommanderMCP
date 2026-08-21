import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-serena-transport-lifecycle-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const configDir = path.join(home, '.claude-server-commander');
await fs.mkdir(configDir, { recursive: true });
await fs.writeFile(
  path.join(configDir, 'config.json'),
  JSON.stringify({ telemetryEnabled: false, allowedDirectories: [repoRoot] }),
  'utf8',
);

const { callSerenaWorkspaceTool, privateSerenaRuntimeStatus } =
  await import('../dist/serena/serena-runtime-manager.js');
const { closeAllMcpRuntimes } = await import('../dist/tools/external-mcp.js');

try {
  const bound = await callSerenaWorkspaceTool({ operation: 'bind', root: repoRoot, warm: false }, 5_000);
  assert.match(bound.workspaceSession, /^ws_/);
  assert.equal(privateSerenaRuntimeStatus().sessions.length, 1);

  await closeAllMcpRuntimes();
  assert.equal(privateSerenaRuntimeStatus().sessions.length, 0,
    'local Desktop Commander child shutdown must release private Serena bindings');

  process.env.DESKTOP_COMMANDER_SERENA_PROJECT = path.join(home, 'missing-serena-source');
  const failedWarm = await callSerenaWorkspaceTool({ operation: 'bind', root: repoRoot, warm: true }, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const failedStatus = await callSerenaWorkspaceTool({
    operation: 'status', session: failedWarm.workspaceSession,
  }, 5_000);
  assert.equal(failedStatus.status, 'failed', 'background warmup failure must stay session-local');
  assert.match(failedStatus.error, /DESKTOP_COMMANDER_SERENA_PROJECT does not exist/);
  await callSerenaWorkspaceTool({ operation: 'release', session: failedWarm.workspaceSession }, 5_000);
  delete process.env.DESKTOP_COMMANDER_SERENA_PROJECT;

  const envRoot = path.resolve(repoRoot, '..', '..');
  const externalConfig = path.join(home, 'remote-external-mcp.json');
  await fs.writeFile(externalConfig, JSON.stringify({ imports: [], mcpServers: {} }), 'utf8');
  process.env.DESKTOP_COMMANDER_MCP_CONFIG = externalConfig;
  process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY = '{}';
  process.env.DESKTOP_COMMANDER_SERENA_PROJECT = path.join(envRoot, 'fork', 'serena');
  process.env.DESKTOP_COMMANDER_SERENA_HOME = path.join(home, 'remote-serena-home');
  process.env.DESKTOP_COMMANDER_SERENA_PROJECT_DATA_ROOT = path.join(home, 'remote-serena-projects');
  process.env.DESKTOP_COMMANDER_SERENA_UV_CACHE_DIR = path.join(envRoot, '.cache', 'serena-internal', 'uv');
  process.env.DESKTOP_COMMANDER_SERENA_UV_PROJECT_ENVIRONMENT = path.join(envRoot, '.cache', 'serena-internal', 'venv');
  process.env.DESKTOP_COMMANDER_SERENA_PYTHONPYCACHEPREFIX = path.join(home, 'remote-pycache');

  const { DesktopCommanderIntegration } =
    await import('../dist/remote-device/desktop-commander-integration.js');
  const integration = new DesktopCommanderIntegration();
  integration.resolveMcpConfig = async () => ({
    command: process.execPath,
    args: [path.join(repoRoot, 'dist', 'index.js'), '--no-onboarding'],
    cwd: repoRoot,
    env: { HOME: home, USERPROFILE: home },
  });
  const resultText = (result) => (result?.content ?? []).map((part) => part?.text ?? '').join('\n');
  try {
    await integration.initialize();
    const remoteBind = await integration.callClientTool('write_file', {
      path: 'mcp://desktop-context/serena_workspace?timeout_ms=45000',
      content: JSON.stringify({ operation: 'bind', root: repoRoot, warm: true }), mode: 'rewrite',
    });
    const remoteBound = JSON.parse(resultText(remoteBind));
    assert.match(remoteBound.workspaceSession, /^ws_/);

    let remoteCall;
    for (let attempt = 0; attempt < 4; attempt++) {
      const call = await integration.callClientTool('write_file', {
        path: 'mcp://desktop-context/serena_call?timeout_ms=45000',
        content: JSON.stringify({
          tool: 'search_for_pattern', session: remoteBound.workspaceSession,
          arguments: { substring_pattern: 'closeAllMcpRuntimes', relative_path: 'src/tools/external-mcp.ts' },
        }), mode: 'rewrite',
      });
      remoteCall = JSON.parse(resultText(call));
      if (remoteCall.status === 'ready') break;
      assert.equal(remoteCall.status, 'cold_start');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert.equal(remoteCall?.status, 'ready', JSON.stringify(remoteCall));
    assert(JSON.stringify(remoteCall.result).includes('closeAllMcpRuntimes'));
    await integration.callClientTool('write_file', {
      path: 'mcp://desktop-context/serena_workspace?timeout_ms=10000',
      content: JSON.stringify({ operation: 'release', session: remoteBound.workspaceSession }), mode: 'rewrite',
    });
  } finally {
    await integration.shutdown();
  }

  console.log('private Serena transport lifecycle: PASS');
} finally {
  await closeAllMcpRuntimes().catch(() => {});
  await fs.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
