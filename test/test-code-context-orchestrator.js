#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-code-context-'));
const fakeServer = path.join(isolated, 'fake-context-server.mjs');
const configPath = path.join(isolated, 'mcporter.json');
const staleConfigPath = path.join(isolated, 'stale-mcporter.json');
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = isolated;
process.env.USERPROFILE = isolated;

await fs.writeFile(fakeServer, `
let buffer = '';
process.stdin.setEncoding('utf8');
const role = process.env.DC_CONTEXT_ROLE;
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
function toolList() {
  if (role === 'graph') return [{
    name: 'get_impact_radius_tool',
    inputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true }
  }];
  return [{
    name: 'find_symbol',
    inputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true }
  }];
}
`, 'utf8');await fs.appendFile(fakeServer, `
async function handle(message) {
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'dc-code-context-fake', version: '1.0.0' }
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'ping') { send(message.id, {}); return; }
  if (message.method === 'tools/list') { send(message.id, { tools: toolList() }); return; }
  if (message.method === 'tools/call') {
    if (role === 'graph') {
      await new Promise((resolve) => setTimeout(resolve, 150));
      send(message.id, {
        content: [{ type: 'text', text: 'graph-result' }],
        structuredContent: {
          status: 'ok', summary: 'fake graph impact', truncated: false,
          impacted_files: [process.env.DC_CONTEXT_IMPACT], total_impacted: 1
        }
      });
      return;
    }
`, 'utf8');await fs.appendFile(fakeServer, `
    const args = message.params?.arguments || {};
    send(message.id, {
      content: [{ type: 'text', text: 'semantic-result' }],
      structuredContent: {
        result: JSON.stringify({
          name: args.name_path_pattern,
          relative_path: args.relative_path || '',
          include_body: args.include_body,
          max_matches: args.max_matches
        })
      }
    });
    return;
  }
  if (message.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf('\\n');
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) void handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
`, 'utf8');const config = {
  mcpServers: {
    'fake-crg': {
      command: process.execPath,
      args: [fakeServer, '--repo', REPO_ROOT],
      env: { DC_CONTEXT_ROLE: 'graph', DC_CONTEXT_IMPACT: path.join(REPO_ROOT, 'src', 'tools', 'code-context-orchestrator.ts') },
      protocolVersion: 'legacy', lifecycle: 'keep-alive',
      allowedTools: ['get_impact_radius_tool'],
    },
    'fake-serena': {
      command: process.execPath,
      args: [fakeServer, '--repo', REPO_ROOT],
      env: { DC_CONTEXT_ROLE: 'semantic' },
      protocolVersion: 'legacy', lifecycle: 'keep-alive',
      allowedTools: ['find_symbol'],
    },
  },
};
await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
await fs.writeFile(staleConfigPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
const dcConfigDir = path.join(isolated, '.claude-server-commander');
await fs.mkdir(dcConfigDir, { recursive: true });
await fs.writeFile(path.join(dcConfigDir, 'config.json'), JSON.stringify({
  externalMcpConfigPath: staleConfigPath,
  allowedDirectories: [REPO_ROOT],
  telemetryEnabled: false,
}, null, 2), 'utf8');
process.env.DESKTOP_COMMANDER_MCP_CONFIG = configPath;
process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY = JSON.stringify({
  'fake-crg': ['get_impact_radius_tool'],
  'fake-serena': ['find_symbol'],
});

const { configManager } = await import('../dist/config-manager.js');
assert.equal(await configManager.getValue('externalMcpConfigPath'), staleConfigPath);
const { listExternalMcpTools, readExternalMcpCompatUri, closeExternalMcpRuntime } =
  await import('../dist/tools/external-mcp.js');
const { callCodeContextOrchestrator } = await import('../dist/tools/code-context-orchestrator.js');
try {
  const servers = JSON.parse((await listExternalMcpTools({ timeout_ms: 5000 })).content[0].text);
  assert(servers.servers.includes('desktop-context'));
  assert(servers.servers.includes('fake-crg'));
  assert(servers.servers.includes('fake-serena'));

  const schema = JSON.parse((await readExternalMcpCompatUri('mcp://desktop-context/code_context?timeout_ms=5000')).content[0].text);
  assert.equal(schema.tool.name, 'code_context');
  assert.equal(schema.tool.readOnly, true);
  assert.equal(schema.tool.preferredFrozenSurface, 'read_file');
  assert.match(
    schema.tool.inputSchema.properties.symbolQueries.items.properties.include_info.description,
    /bulk or multi-symbol context/,
  );
  assert.match(schema.routing_guidance, /keep include_info=false/);
  assert.match(schema.tool.inputSchema.properties.graphServer.description, /workspace_delta contract/);

  const directCalls = [];
  const direct = await callCodeContextOrchestrator({
    root: REPO_ROOT,
    query: 'shared changed file contract',
    workspaceCursor: 'prior-cursor',
    graphServer: 'fake-crg',
    maxFiles: 1,
  }, {
    callBuiltin: async (tool, args) => {
      directCalls.push({ kind: 'builtin', tool, args });
      if (tool === 'workspace_delta') {
        assert.equal(args.cursor, 'prior-cursor');
        return {
        repositoryRoot: REPO_ROOT, freshInstance: false, complete: true,
        changedFiles: ['src/tools/external-mcp.ts'], workingTreeChangedFiles: ['src/tools/external-mcp.ts'],
        cursor: 'shared-cursor',
        };
      }
      if (tool === 'context_pack') return {
        repositoryRoot: REPO_ROOT, scopeRoot: REPO_ROOT, scopePrefix: '', queryTerms: [],
        workspaceCursor: args.workspaceCursor, workspaceDelta: { changedFiles: [] },
        candidateCount: 0, inspectedCandidateCount: 0, inspectedBytes: 0, inspectionByteLimitReached: false,
        seedFilesAccepted: args.seedFiles || [], missingSeedFiles: [], files: [], returnedChars: 0,
        responseTruncated: false, semanticFollowupTerms: [],
      };
      throw new Error(`unexpected builtin ${tool}`);
    },
    callTrustedExternal: async (server, tool, args) => {
      directCalls.push({ kind: 'external', server, tool, args });
      assert.equal(server, 'fake-crg');
      assert.equal(tool, 'get_impact_radius_tool');
      assert.deepEqual(args.changed_files, ['src/tools/external-mcp.ts']);
      return { status: 'ok', impacted_files: [], total_impacted: 0, truncated: false };
    },
    assertWorkspace: async (_server, root) => ({ requestedRoot: root, boundRoot: root }),
  }, 5000);
  assert.equal(direct.orchestration.workspaceDeltaCalls, 1);
  assert.equal(direct.orchestration.changedFilesSource, 'workspace_delta');
  assert.equal(direct.orchestration.changedFiles, 1);
  assert.equal(directCalls.filter((call) => call.tool === 'workspace_delta').length, 1);
  assert.equal(directCalls.find((call) => call.tool === 'context_pack').args.workspaceCursor, 'prior-cursor');
  assert.deepEqual(directCalls.find((call) => call.tool === 'context_pack').args.seedFiles ?? [], []);

  const largeSharedDelta = Array.from({ length: 101 }, (_, i) => `file-${i}.ts`);
  const largeCursor = `z1.${'x'.repeat(200_000)}`;
  assert(largeCursor.length > 128 * 1024, 'large cursor regression no longer exceeds the old consumer cap');
  const largeDirect = await callCodeContextOrchestrator(
    { root: REPO_ROOT, query: 'large shared delta', graphServer: 'fake-crg', maxFiles: 1 },
    {
      callBuiltin: async (tool, args) => {
        if (tool === 'workspace_delta') return { changedFiles: largeSharedDelta, cursor: largeCursor };
        if (tool === 'context_pack') return {
          repositoryRoot: REPO_ROOT, scopeRoot: REPO_ROOT, scopePrefix: '', queryTerms: [],
          workspaceCursor: args.workspaceCursor, workspaceDelta: { changedFiles: [] },
          candidateCount: 0, inspectedCandidateCount: 0, inspectedBytes: 0, inspectionByteLimitReached: false,
          seedFilesAccepted: args.seedFiles || [], missingSeedFiles: [], files: [], returnedChars: 0,
          responseTruncated: false, semanticFollowupTerms: [],
        };
        throw new Error(`unexpected builtin ${tool}`);
      },
      callTrustedExternal: async (_server, tool, args) => {
        assert.equal(tool, 'get_impact_radius_tool');
        assert.equal(args.changed_files.length, 101);
        return { status: 'ok', impacted_files: [], total_impacted: 0, truncated: false };
      },
      assertWorkspace: async (_server, root) => ({ requestedRoot: root, boundRoot: root }),
    },
    5000,
  );
  assert.equal(largeDirect.orchestration.changedFiles, 101);
  assert.equal(largeDirect.orchestration.seedFiles, 0);

  const result = JSON.parse((await readExternalMcpCompatUri(
    'mcp://desktop-context/code_context?timeout_ms=15000',
    {
      root: REPO_ROOT,
      query: 'external MCP context orchestration',
      changedFiles: ['src/tools/external-mcp.ts'],
      graphServer: 'fake-crg',
      semanticServer: 'fake-serena',
      symbolQueries: [{
        name_path_pattern: 'callExternalMcpTool',
        relative_path: 'src/tools/external-mcp.ts',
        max_matches: 2,
      }],
      maxFiles: 4,
      maxTotalChars: 20000,
    },
  )).content[0].text);
  assert.equal(result.graph.server, 'fake-crg');
  assert.deepEqual(result.graph.impactedFiles, ['src/tools/code-context-orchestrator.ts']);
  assert(result.contextPack.seedFilesAccepted.includes('src/tools/external-mcp.ts'));
  assert(result.contextPack.seedFilesAccepted.includes('src/tools/code-context-orchestrator.ts'));
  assert.equal(typeof result.contextPack.workspaceCursor, 'string');
  assert(result.contextPack.workspaceCursor.length > 0);
  assert.equal(result.semantic.server, 'fake-serena');
  assert.equal(result.semantic.results.length, 1);
  const semantic = JSON.parse(result.semantic.results[0].result.result);
  assert.equal(semantic.name, 'callExternalMcpTool');
  assert.equal(semantic.include_body, false);
  assert.equal(semantic.max_matches, 2);
  assert.equal(result.orchestration.graphCalls, 1);
  assert.equal(result.orchestration.contextPackCalls, 1);
  assert.equal(result.orchestration.semanticCalls, 1);

  process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY = JSON.stringify({ 'fake-serena': ['find_symbol'] });
  await assert.rejects(
    () => readExternalMcpCompatUri('mcp://desktop-context/code_context?timeout_ms=5000', {
      root: REPO_ROOT,
      query: 'trust gate',
      changedFiles: ['src/tools/external-mcp.ts'],
      graphServer: 'fake-crg',
    }),
    /locally trusted read-only tool 'fake-crg\/get_impact_radius_tool'/,
  );

  process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY = JSON.stringify({ 'fake-crg': ['get_impact_radius_tool'] });
  await assert.rejects(
    () => readExternalMcpCompatUri('mcp://desktop-context/code_context?timeout_ms=5000', {
      root: REPO_ROOT,
      query: 'semantic rejection lifecycle gate',
      changedFiles: ['src/tools/external-mcp.ts'],
      graphServer: 'fake-crg',
      semanticServer: 'fake-serena',
      symbolQueries: [{ name_path_pattern: 'callExternalMcpTool' }],
    }),
    /locally trusted read-only tool 'fake-serena\/find_symbol'/,
  );

  process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY = JSON.stringify({
    'fake-crg': ['get_impact_radius_tool'],
    'fake-serena': ['find_symbol'],
  });
  await assert.rejects(
    () => readExternalMcpCompatUri('mcp://desktop-context/code_context?timeout_ms=5000', {
      root: path.dirname(REPO_ROOT),
      query: 'workspace mismatch',
      changedFiles: ['src/tools/external-mcp.ts'],
      graphServer: 'fake-crg',
    }),
    /cannot provide context/,
  );
  await assert.rejects(
    () => readExternalMcpCompatUri('mcp://desktop-context/code_context?timeout_ms=5000', {
      root: REPO_ROOT,
      query: 'implicit symbol inference must stay disabled',
      semanticServer: 'fake-serena',
    }),
    /semanticServer requires symbolQueries/,
  );

  console.log('code context orchestrator: PASS');
} finally {
  await closeExternalMcpRuntime().catch(() => {});
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
  await fs.rm(isolated, { recursive: true, force: true }).catch(() => {});
}
