import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const projectRoot = path.resolve(repoRoot, '..', '..');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-local-mcp-concurrency-'));
const configDir = path.join(home, '.claude-server-commander');
await fs.mkdir(configDir, { recursive: true });
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
  telemetryEnabled: false, allowedDirectories: [repoRoot],
  welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false,
}), 'utf8');

const externalConfig = path.join(home, 'external-mcp.json');
await fs.writeFile(externalConfig, JSON.stringify({ imports: [], mcpServers: {} }), 'utf8');
const resultText = (result) => (result?.content ?? []).map((part) => part?.text ?? '').join('\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const within = (promise, ms, label) => Promise.race([
  promise, sleep(ms).then(() => { throw new Error(`${label} timed out after ${ms}ms`); }),
]);

const previousEnv = {};
const env = {
  DESKTOP_COMMANDER_MCP_CONFIG: externalConfig,
  DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY: '{}',
  DESKTOP_COMMANDER_SERENA_PROJECT: path.join(projectRoot, 'fork', 'serena'),
  DESKTOP_COMMANDER_SERENA_HOME: path.join(home, 'serena-home'),
  DESKTOP_COMMANDER_SERENA_PROJECT_DATA_ROOT: path.join(home, 'serena-projects'),
  DESKTOP_COMMANDER_SERENA_UV_CACHE_DIR: path.join(projectRoot, '.cache', 'serena-internal', 'uv'),
  DESKTOP_COMMANDER_SERENA_UV_PROJECT_ENVIRONMENT: path.join(projectRoot, '.cache', 'serena-internal', 'venv'),
  DESKTOP_COMMANDER_SERENA_PYTHONPYCACHEPREFIX: path.join(home, 'pycache'),
  DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
};
for (const [key, value] of Object.entries(env)) {
  previousEnv[key] = process.env[key];
  process.env[key] = value;
}

const { DesktopCommanderIntegration } =
  await import('../dist/remote-device/desktop-commander-integration.js');
const integration = new DesktopCommanderIntegration();
integration.resolveMcpConfig = async () => ({
  command: process.execPath, args: [path.join(repoRoot, 'dist', 'index.js'), '--no-onboarding'],
  cwd: repoRoot, env: { HOME: home, USERPROFILE: home },
});

let workspaceSession;
try {
  await within(integration.initialize(), 15_000, 'local MCP initialize');
  const bound = await within(integration.callClientTool('write_file', {
    path: 'mcp://desktop-context/serena_workspace?timeout_ms=45000',
    content: JSON.stringify({ operation: 'bind', root: repoRoot, warm: true }),
    mode: 'rewrite',
  }), 20_000, 'Serena workspace bind');
  workspaceSession = JSON.parse(resultText(bound)).workspaceSession;
  assert.match(workspaceSession, /^ws_/);

  let warmResult;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await within(integration.callClientTool('write_file', {
      path: 'mcp://desktop-context/serena_call?timeout_ms=45000',
      content: JSON.stringify({
        session: workspaceSession, tool: 'search_for_pattern',
        arguments: { substring_pattern: 'callSessionSerenaReadBatch', relative_path: 'src/serena/serena-runtime-manager.ts' },
      }), mode: 'rewrite',
    }), 20_000, `Serena warmup ${attempt}`);
    warmResult = JSON.parse(resultText(response));
    if (warmResult.status === 'ready') break;
    await sleep(500);
  }
  assert.equal(warmResult?.status, 'ready', JSON.stringify(warmResult));

  for (let round = 0; round < 4; round += 1) {
    const semanticOptions = {
      session: workspaceSession, concurrency: 2, calls: [
        { tool: 'get_diagnostics_for_file', arguments: { relative_path: 'src/tools/trash-manager.ts', min_severity: 4 } },
        { tool: 'search_for_pattern', arguments: {
          substring_pattern: 'literalBackslashName|registry overflow|metadata-only restore state',
          relative_path: 'test/test-trash-action-e2e.js', multiline: true, max_answer_chars: 12000,
        } },
      ],
    };
    const serenaCall = integration.callClientTool('read_file', {
      path: 'mcp://desktop-context/serena_read_batch?timeout_ms=45000', options: semanticOptions,
    });
    const processCall = integration.callClientTool('write_file', {
      path: 'mcp://desktop-core/start_process?timeout_ms=15000',
      content: JSON.stringify({
        executable: process.execPath, args: ['-e', `process.stdout.write('ROUND_${round}_PROCESS_OK')`],
        execution_kind: 'finite', pty: 'never', timeout_ms: 5_000,
      }), mode: 'rewrite',
    });
    const [semantic, processResult] = await within(
      Promise.all([serenaCall, processCall]), 25_000, `concurrent round ${round}`,
    );
    let semanticPayload = JSON.parse(resultText(semantic));
    assert.match(resultText(processResult), new RegExp(`ROUND_${round}_PROCESS_OK`));
    for (let attempt = 0; semanticPayload.status !== 'ready' && attempt < 5; attempt += 1) {
      assert.equal(semanticPayload.status, 'cold_start', JSON.stringify(semanticPayload));
      await sleep(1_000);
      const retry = await within(integration.callClientTool('read_file', {
        path: 'mcp://desktop-context/serena_read_batch?timeout_ms=45000', options: semanticOptions,
      }), 25_000, `semantic retry ${round}/${attempt}`);
      semanticPayload = JSON.parse(resultText(retry));
    }
    assert.equal(semanticPayload.status, 'ready', JSON.stringify(semanticPayload));
    assert.equal(semanticPayload.results.length, 2);
  }

  const followup = await within(integration.callClientTool('get_config', {}), 6_000, 'post-concurrency get_config');
  assert.match(resultText(followup), /allowedDirectories/);
  console.log('local MCP concurrency e2e: PASS');
} finally {
  if (workspaceSession) {
    await integration.callClientTool('write_file', {
      path: 'mcp://desktop-context/serena_workspace?timeout_ms=10000',
      content: JSON.stringify({ operation: 'release', session: workspaceSession }), mode: 'rewrite',
    }).catch(() => {});
  }
  await integration.shutdown().catch(() => {});
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
}
