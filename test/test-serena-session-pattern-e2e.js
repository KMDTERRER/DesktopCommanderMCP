import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const envRoot = path.resolve(repoRoot, '..', '..');
const server = path.join(repoRoot, 'dist', 'index.js');
const serenaSource = path.join(envRoot, 'fork', 'serena');
const runtimeVenv = path.join(envRoot, '.cache', 'serena-internal', 'venv');
const runtimeUvCache = path.join(envRoot, '.cache', 'serena-internal', 'uv');
const textOf = (result) => (result?.content ?? []).map((part) => part?.text ?? '').join('\n');
const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pathExists(value) {
  return fs.access(value).then(() => true, () => false);
}

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-private-serena-e2e-'));
  const workspace = path.join(home, 'workspace');
  const projectDataRoot = path.join(home, 'serena-projects');
  const mcpConfig = path.join(home, 'external-mcp.json');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'sample.py'), 'PRIVATE_SERENA_MARKER = 1\n', 'utf8');
  await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'dc-e2e@example.invalid'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.name', 'Desktop Commander E2E'], { cwd: workspace });
  await execFileAsync('git', ['add', 'sample.py'], { cwd: workspace });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'e2e fixture'], { cwd: workspace });
  await fs.writeFile(mcpConfig, JSON.stringify({ daemonIdleTimeoutMs: 1800000, imports: [], mcpServers: {} }), 'utf8');
  const cfgDir = path.join(home, '.claude-server-commander');
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.writeFile(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ telemetryEnabled: false, allowedDirectories: [workspace] }),
    'utf8',
  );

  const transport = new StdioClientTransport({
    command: process.execPath, args: [server, '--no-onboarding'], cwd: repoRoot, stderr: 'inherit',
    env: {
      ...process.env, HOME: home, USERPROFILE: home, DESKTOP_COMMANDER_MCP_CONFIG: mcpConfig,
      DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY: '{}', DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
      DESKTOP_COMMANDER_SERENA_PROJECT: serenaSource,
      DESKTOP_COMMANDER_SERENA_HOME: path.join(home, 'serena-home'),
      DESKTOP_COMMANDER_SERENA_PROJECT_DATA_ROOT: projectDataRoot,
      DESKTOP_COMMANDER_SERENA_UV_CACHE_DIR: runtimeUvCache,
      DESKTOP_COMMANDER_SERENA_UV_PROJECT_ENVIRONMENT: runtimeVenv,
      DESKTOP_COMMANDER_SERENA_PYTHONPYCACHEPREFIX: path.join(home, 'pycache'),
    },
  });
  const client = new Client({ name: 'dc-private-serena-e2e', version: '1.0.0' }, { capabilities: {} });
  let session;
  try {
    await client.connect(transport, { timeout: 30_000 });
    const discovery = await client.callTool({ name: 'read_file', arguments: { path: 'mcp://servers' } }, undefined, { timeout: 15_000 });
    assert.notEqual(discovery.isError, true, textOf(discovery));
    const discovered = JSON.parse(textOf(discovery));
    assert.equal(discovered.servers.some((name) => String(name).startsWith('serena-')), false, JSON.stringify(discovered));

    const forbidden = await client.callTool({ name: 'write_file', arguments: {
      path: 'mcp://serena-primary/find_symbol?timeout_ms=5000', content: '{}', mode: 'rewrite',
    } }, undefined, { timeout: 10_000 });
    assert.equal(forbidden.isError, true, 'legacy external Serena ID must not be callable');

    const bind = await client.callTool({ name: 'write_file', arguments: {
      path: 'mcp://desktop-context/serena_workspace?timeout_ms=45000',
      content: JSON.stringify({ operation: 'bind', root: workspace, warm: true }), mode: 'rewrite',
    } }, undefined, { timeout: 50_000 });
    assert.notEqual(bind.isError, true, textOf(bind));
    const bound = JSON.parse(textOf(bind));
    session = bound.workspaceSession;
    assert.match(session, /^ws_/);
    assert.equal(bound.server, 'internal-serena');

    let called;
    for (let attempt = 0; attempt < 3; attempt++) {
      const search = await client.callTool({ name: 'write_file', arguments: {
        path: 'mcp://desktop-context/serena_call?timeout_ms=45000',
        content: JSON.stringify({ tool: 'search_for_pattern', session, arguments: {
          substring_pattern: 'PRIVATE_SERENA_MARKER', relative_path: 'sample.py', max_answer_chars: 12000,
        } }), mode: 'rewrite',
      } }, undefined, { timeout: 50_000 });
      assert.notEqual(search.isError, true, textOf(search));
      called = JSON.parse(textOf(search));
      if (called.status === 'ready') break;
      assert.equal(called.status, 'cold_start', JSON.stringify(called));
      await delay(1000);
    }
    assert.equal(called?.status, 'ready', JSON.stringify(called));
    assert(JSON.stringify(called.result).includes('PRIVATE_SERENA_MARKER'), JSON.stringify(called.result));

    let batchResult;
    for (let attempt = 0; attempt < 3; attempt++) {
      const batch = await client.callTool({ name: 'read_file', arguments: {
        path: 'mcp://desktop-context/serena_read_batch?timeout_ms=45000', options: {
          session, concurrency: 2, calls: [
            { tool: 'search_for_pattern', arguments: {
              substring_pattern: 'PRIVATE_SERENA_MARKER', relative_path: 'sample.py', max_answer_chars: 12000,
            } },
            { tool: 'find_symbol', arguments: {
              name_path_pattern: 'PRIVATE_SERENA_MARKER', relative_path: 'sample.py', max_matches: 2, max_answer_chars: 12000,
            } },
          ],
        },
      } }, undefined, { timeout: 50_000 });
      assert.notEqual(batch.isError, true, textOf(batch));
      batchResult = JSON.parse(textOf(batch));
      if (batchResult.status === 'ready') break;
      assert.equal(batchResult.status, 'cold_start', JSON.stringify(batchResult));
      await delay(1000);
    }
    assert.equal(batchResult?.status, 'ready', JSON.stringify(batchResult));
    assert.equal(batchResult.results.length, 2, JSON.stringify(batchResult));

    const context = await client.callTool({ name: 'read_file', arguments: {
      path: 'mcp://desktop-context/code_context?timeout_ms=45000', options: {
        root: workspace, query: 'PRIVATE_SERENA_MARKER symbol context', semanticSession: session,
        symbolQueries: [{ name_path_pattern: 'PRIVATE_SERENA_MARKER', relative_path: 'sample.py', max_matches: 2 }],
        semanticExpand: 'none', maxFiles: 4, maxLinesPerFile: 40, maxTotalChars: 20000,
      },
    } }, undefined, { timeout: 50_000 });
    assert.notEqual(context.isError, true, textOf(context));
    const contextResult = JSON.parse(textOf(context));
    assert.equal(contextResult.semantic?.workspaceSession, session, JSON.stringify(contextResult.semantic));
    assert(JSON.stringify(contextResult).includes('sample.py'), JSON.stringify(contextResult));

    assert.equal(await pathExists(path.join(workspace, '.desktop-commander-serena')), false,
      'private Serena must not create project-local managed state');
    const projectDataEntries = await fs.readdir(projectDataRoot);
    assert(projectDataEntries.length > 0, 'private Serena should create central project-data state');

    console.log('private Serena stdio / no external MCP e2e: PASS');
  } finally {
    if (session) {
      await client.callTool({ name: 'write_file', arguments: {
        path: 'mcp://desktop-context/serena_workspace?timeout_ms=10000',
        content: JSON.stringify({ operation: 'release', session }), mode: 'rewrite',
      } }, undefined, { timeout: 15_000 }).catch(() => {});
    }
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
