import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const envRoot = path.resolve(repoRoot, '..', '..');
const server = path.join(repoRoot, 'dist', 'index.js');
const mcpConfig = path.join(envRoot, 'config', 'mcporter.local.json');
const textOf = (result) => (result?.content ?? []).map((part) => part?.text ?? '').join('\n');

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-serena-pattern-home-'));
  const cfgDir = path.join(home, '.claude-server-commander');
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.writeFile(path.join(cfgDir, 'config.json'), JSON.stringify({ telemetryEnabled: false, allowedDirectories: [repoRoot] }), 'utf8');

  const transport = new StdioClientTransport({
    command: process.execPath, args: [server, '--no-onboarding'], cwd: repoRoot, stderr: 'pipe',
    env: { ...process.env, HOME: home, USERPROFILE: home, DESKTOP_COMMANDER_MCP_CONFIG: mcpConfig, DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true' },
  });
  const client = new Client({ name: 'dc-serena-pattern-e2e', version: '1.0.0' }, { capabilities: {} });
  let session;
  try {
    await client.connect(transport, { timeout: 30_000 });
    const bind = await client.callTool({ name: 'write_file', arguments: {
      path: 'mcp://desktop-context/serena_workspace?timeout_ms=45000',
      content: JSON.stringify({ operation: 'bind', root: repoRoot, warm: true }), mode: 'rewrite',
    } }, undefined, { timeout: 50_000 });
    assert.notEqual(bind.isError, true, textOf(bind));
    const bound = JSON.parse(textOf(bind));
    session = bound.workspaceSession;
    assert.match(session, /^ws_/);

    const search = await client.callTool({ name: 'write_file', arguments: {
      path: 'mcp://desktop-context/serena_call?timeout_ms=45000',
      content: JSON.stringify({ tool: 'search_for_pattern', session, arguments: {
        substring_pattern: 'SERENA_SESSION_ADDITIONAL_TOOLS', relative_path: 'src/tools/external-mcp.ts', max_answer_chars: 12000,
      } }), mode: 'rewrite',
    } }, undefined, { timeout: 50_000 });
    assert.notEqual(search.isError, true, textOf(search));
    const called = JSON.parse(textOf(search));
    assert.equal(called.status, 'ready');
    const payloadText = JSON.stringify(called.result);
    assert(payloadText.includes('SERENA_SESSION_ADDITIONAL_TOOLS'), payloadText);

    console.log('serena session pattern mcp:// e2e: PASS');
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
