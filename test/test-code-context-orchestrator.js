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
  return ['find_symbol', 'find_referencing_symbols', 'find_implementations'].map((name) => ({
    name, inputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true }
  }));
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
      if (process.env.DC_CONTEXT_GRAPH_MALFORMED === '1') {
        send(message.id, {
          content: [{ type: 'text', text: 'malformed-graph-result' }],
          structuredContent: { status: 'ok', summary: 'missing impacted_files', truncated: false },
        });
        return;
      }
      const impacts = process.env.DC_CONTEXT_IMPACT_COUNT
        ? Array.from({ length: Number(process.env.DC_CONTEXT_IMPACT_COUNT) }, (_, index) => 'src/generated-impact-' + index + '.ts')
        : [process.env.DC_CONTEXT_IMPACT];
      send(message.id, {
        content: [{ type: 'text', text: 'graph-result' }],
        structuredContent: {
          status: 'ok', summary: 'fake graph impact', truncated: false,
          impacted_files: impacts, total_impacted: impacts.length
        }
      });
      return;
    }
`, 'utf8');await fs.appendFile(fakeServer, `
    const args = message.params?.arguments || {};
    const tool = message.params?.name;
    let semanticResult;
    if (tool === 'find_referencing_symbols') {
      if (args.name_path === 'ShortReferenceTarget') {
        semanticResult = 'The answer is too long (24000 characters). You can adjust your query or raise the max_answer_chars parameter.'
          + String.fromCharCode(10) + 'References without surrounding lines:' + String.fromCharCode(10)
          + JSON.stringify({
            'src/tools/code-context-orchestrator.ts': { Function: [{ name_path: 'callCodeContextOrchestrator', reference_line: 300 }] },
            'src/server.ts': { File: [{ name_path: 'server', reference_line: 61 }] }
          });
      } else if (args.name_path === 'CountOnlyReferenceTarget') {
        semanticResult = 'The answer is too long (48000 characters). You can adjust your query or raise the max_answer_chars parameter.'
          + String.fromCharCode(10) + 'Reference counts per file:' + String.fromCharCode(10)
          + JSON.stringify({ 'src/server.ts': 3, 'src/tools/core-mcp.ts': 2 });
      } else {
        semanticResult = {
          'src/tools/code-context-orchestrator.ts': { Function: [{
            name_path: 'callCodeContextOrchestrator',
            body_location: { start_line: 242, end_line: 366 },
            content_around_reference: '... 300: before\\n  > 301: callExternalMcpTool()\\n... 302: after'
          }] },
          'src/server.ts': { File: [{
            name_path: 'server',
            body_location: { start_line: 0, end_line: 1768 },
            content_around_reference: '... 60: before\\n  > 61: callExternalMcpTool()\\n... 62: after'
          }] }
        };
      }
    } else if (tool === 'find_implementations') {
      semanticResult = args.name_path === 'LongImplementationTarget'
        ? 'The answer is too long (18000 characters). You can adjust your query or raise the max_answer_chars parameter.'
        : [{
            name_path: 'callExternalMcpToolImpl', kind: 'Function', relative_path: 'src/tools/core-mcp.ts',
            body_location: { start_line: 80, end_line: 120 }
          }];
    } else if (args.name_path_pattern === 'MalformedTarget') {
      semanticResult = 'not-json-find-symbol-contract';
    } else if (args.name_path_pattern === 'ShortenedTarget') {
      semanticResult = 'Matched 12>max_matches=2 symbols. Shortened result:\\n' + JSON.stringify({
        'src/tools/external-mcp.ts': ['ShortenedTarget'],
        'src/tools/code-context-orchestrator.ts': ['ShortenedTarget/helper']
      });
    } else if (args.name_path_pattern === 'RankingTarget') {
      semanticResult = Array.from({ length: 10 }, (_, index) => ({
        name_path: index === 9 ? 'test blocking offline RankingTarget generation fenced' : 'RankingTarget/generic-' + index,
        kind: 'Function',
        relative_path: index === 9 ? 'test/test-code-context-orchestrator.js' : 'src/tools/external-mcp.ts',
        body_location: { start_line: 100 + index, end_line: 100 + index }
      }));
    } else if (args.name_path_pattern === 'BroadFirst') {
      semanticResult = Array.from({ length: 10 }, (_, index) => ({
        name_path: 'BroadFirst/generic-' + index, kind: 'Function',
        relative_path: 'src/tools/external-mcp.ts'
      }));
    } else {
      semanticResult = [{
        name_path: args.name_path_pattern, kind: 'Function',
        relative_path: args.relative_path || 'src/tools/external-mcp.ts',
        body_location: { start_line: 1500, end_line: 1560 },
        include_body: args.include_body, max_matches: args.max_matches
      }];
    }
    send(message.id, {
      content: [{ type: 'text', text: 'semantic-result' }],
      structuredContent: { result: typeof semanticResult === 'string' ? semanticResult : JSON.stringify(semanticResult) }
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
    'fake-crg-malformed': {
      command: process.execPath,
      args: [fakeServer, '--repo', REPO_ROOT],
      env: { DC_CONTEXT_ROLE: 'graph', DC_CONTEXT_GRAPH_MALFORMED: '1' },
      protocolVersion: 'legacy', lifecycle: 'keep-alive',
      allowedTools: ['get_impact_radius_tool'],
    },
    'fake-crg-many': {
      command: process.execPath,
      args: [fakeServer, '--repo', REPO_ROOT],
      env: { DC_CONTEXT_ROLE: 'graph', DC_CONTEXT_IMPACT_COUNT: '120' },
      protocolVersion: 'legacy', lifecycle: 'keep-alive',
      allowedTools: ['get_impact_radius_tool'],
    },
    'fake-crg-parent': {
      command: process.execPath,
      args: [fakeServer, '--repo', path.dirname(REPO_ROOT)],
      env: { DC_CONTEXT_ROLE: 'graph', DC_CONTEXT_IMPACT: path.join(REPO_ROOT, 'src', 'tools', 'code-context-orchestrator.ts') },
      protocolVersion: 'legacy', lifecycle: 'keep-alive',
      allowedTools: ['get_impact_radius_tool'],
    },
    'fake-serena': {
      command: process.execPath,
      args: [fakeServer, '--repo', REPO_ROOT],
      env: { DC_CONTEXT_ROLE: 'semantic' },
      protocolVersion: 'legacy', lifecycle: 'keep-alive',
      allowedTools: ['find_symbol', 'find_referencing_symbols', 'find_implementations'],
    },
  },
};
await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
await fs.writeFile(staleConfigPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
const dcConfigDir = path.join(isolated, '.claude-server-commander');
await fs.mkdir(dcConfigDir, { recursive: true });
await fs.writeFile(path.join(dcConfigDir, 'config.json'), JSON.stringify({
  externalMcpConfigPath: staleConfigPath,
  allowedDirectories: [path.dirname(REPO_ROOT)],
  telemetryEnabled: false,
}, null, 2), 'utf8');
process.env.DESKTOP_COMMANDER_MCP_CONFIG = configPath;
process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY = JSON.stringify({
  'fake-crg': ['get_impact_radius_tool'],
  'fake-crg-parent': ['get_impact_radius_tool'],
  'fake-crg-many': ['get_impact_radius_tool'],
  'fake-crg-malformed': ['get_impact_radius_tool'],
  'fake-serena': ['find_symbol', 'find_referencing_symbols', 'find_implementations'],
});

const { configManager } = await import('../dist/config-manager.js');
assert.equal(await configManager.getValue('externalMcpConfigPath'), staleConfigPath);
const { listExternalMcpTools, callExternalMcpTool, readExternalMcpCompatUri, closeExternalMcpRuntime } =
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
  assert.equal(schema.routing_guidance, undefined, 'tool schema repeated root discovery guidance');
  assert.match(servers.routing_guidance, /keep include_info=false/);
  assert.match(servers.routing_guidance, /serena_read_batch/);
  assert.match(servers.routing_guidance, /semanticSession/);
  assert.match(servers.routing_guidance, /start_search -> get_more_search_results -> read_file/);
  assert.match(schema.tool.inputSchema.properties.semanticSession.description, /workspaceSession/);
  assert.match(schema.tool.inputSchema.properties.graphServer.description, /workspace_delta contract/);
  const batchSchema = JSON.parse((await readExternalMcpCompatUri('mcp://desktop-context/serena_read_batch?timeout_ms=5000')).content[0].text);
  assert.equal(batchSchema.tool.readOnly, true);
  assert.equal(batchSchema.tool.mutating, false);
  assert.equal(batchSchema.tool.inputSchema.properties.calls.maxItems, 16);
  assert.equal(batchSchema.tool.inputSchema.properties.concurrency.default, 4);
  assert.equal(schema.tool.inputSchema.properties.semanticExpand.default, 'references');
  assert.match(schema.tool.inputSchema.properties.semanticExpand.description, /related files/);

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

  await assert.rejects(
    () => callCodeContextOrchestrator(
      { root: REPO_ROOT, query: 'malformed context pack must fail closed' },
      {
        callBuiltin: async (tool) => {
          assert.equal(tool, 'context_pack');
          return { content: [{ type: 'text', text: 'not-a-context-pack-contract' }] };
        },
        callTrustedExternal: async () => { throw new Error('external call must not run'); },
        assertWorkspace: async () => { throw new Error('workspace binding must not run'); },
      },
      5000,
    ),
    /context_pack returned an invalid context contract/,
  );

  const sessionCalls = [];
  const sessionContext = await callCodeContextOrchestrator({
    root: REPO_ROOT,
    query: 'session scoped semantic fanout',
    semanticSession: 'ws_test_session',
    symbolQueries: [{ name_path_pattern: 'SessionTarget', relative_path: 'src/tools/external-mcp.ts' }],
    maxFiles: 4,
  }, {
    callBuiltin: async (tool, args) => {
      assert.equal(tool, 'context_pack');
      return {
        repositoryRoot: REPO_ROOT, scopeRoot: REPO_ROOT, scopePrefix: '', queryTerms: [],
        workspaceDelta: { changedFiles: [] }, candidateCount: 0, inspectedCandidateCount: 0, inspectedBytes: 0,
        inspectionByteLimitReached: false, seedFilesAccepted: args.seedFiles || [], missingSeedFiles: [], files: [],
        returnedChars: 0, responseTruncated: false, semanticFollowupTerms: [],
      };
    },
    callTrustedExternal: async () => { throw new Error('fixed external semantic provider must not be used'); },
    assertWorkspace: async () => { throw new Error('fixed workspace binding must not be used'); },
    assertSessionWorkspace: async (session, root) => {
      assert.equal(session, 'ws_test_session');
      return { requestedRoot: root, boundRoot: root };
    },
    callSessionSemantic: async (session, tool, args) => {
      sessionCalls.push({ session, tool, args });
      assert.equal(session, 'ws_test_session');
      if (tool === 'find_symbol') {
        return { result: JSON.stringify([{
          name_path: 'SessionTarget', relative_path: 'src/tools/external-mcp.ts',
          body_location: { start_line: 10, end_line: 20 },
        }]) };
      }
      assert.equal(tool, 'find_referencing_symbols');
      return { result: JSON.stringify({
        'src/tools/code-context-orchestrator.ts': { Function: [{
          name_path: 'callCodeContextOrchestrator', body_location: { start_line: 470, end_line: 650 },
        }] },
        'src/server.ts': { Function: [{ name_path: 'registerTools', body_location: { start_line: 40, end_line: 80 } }] },
      }) };
    },
  }, 5000);
  assert.equal(sessionContext.semantic.provider, 'session');
  assert.equal(sessionContext.semantic.workspaceSession, 'ws_test_session');
  assert.deepEqual(sessionContext.semantic.expansion.files, [
    'src/tools/external-mcp.ts', 'src/tools/code-context-orchestrator.ts', 'src/server.ts',
  ]);
  assert.equal(sessionContext.semantic.expansion.relations.length, 2);
  assert.equal(sessionCalls.filter((call) => call.tool === 'find_symbol').length, 1);
  assert.equal(sessionCalls.filter((call) => call.tool === 'find_referencing_symbols').length, 1);
  assert(sessionContext.contextPack.seedFilesAccepted.includes('src/server.ts'));

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
  assert.equal(semantic[0].name_path, 'callExternalMcpTool');
  assert.equal(semantic[0].include_body, false);
  assert.equal(semantic[0].max_matches, 2);
  assert.deepEqual(result.semantic.expansion.files, [
    'src/tools/external-mcp.ts',
    'src/tools/code-context-orchestrator.ts',
    'src/server.ts',
  ]);
  assert.equal(result.semantic.expansion.mode, 'references');
  assert.equal(result.semantic.expansion.relations.length, 2);
  assert(result.contextPack.seedFilesAccepted.includes('src/server.ts'));
  assert.equal(result.orchestration.graphCalls, 1);
  assert.equal(result.orchestration.contextPackCalls, 1);
  assert.equal(result.orchestration.semanticCalls, 1);
  assert.equal(result.orchestration.semanticExpansionCalls, 1);
  assert.equal(result.orchestration.semanticFiles, 3);

  const ancestorGraph = JSON.parse((await readExternalMcpCompatUri(
    'mcp://desktop-context/code_context?timeout_ms=15000',
    {
      root: REPO_ROOT,
      query: 'ancestor graph binding must promote scope-relative evidence',
      changedFiles: ['src/tools/external-mcp.ts'],
      graphServer: 'fake-crg-parent',
      maxFiles: 4,
      maxTotalChars: 20000,
    },
  )).content[0].text);
  assert.equal(ancestorGraph.orchestration.graphWorkspaceRelation, 'ancestor');
  assert.deepEqual(ancestorGraph.graph.impactedFiles, ['src/tools/code-context-orchestrator.ts']);
  assert(ancestorGraph.contextPack.seedFilesAccepted.includes('src/tools/external-mcp.ts'),
    `ancestor explicit changed file was not promoted: ${JSON.stringify(ancestorGraph.contextPack)}`);
  assert(ancestorGraph.contextPack.seedFilesAccepted.includes('src/tools/code-context-orchestrator.ts'),
    `ancestor graph impact was not promoted: ${JSON.stringify(ancestorGraph.contextPack)}`);

  const manyGraph = JSON.parse((await readExternalMcpCompatUri(
    'mcp://desktop-context/code_context?timeout_ms=15000',
    {
      root: REPO_ROOT, query: 'internal seed caps must be reported',
      changedFiles: ['src/tools/external-mcp.ts'], graphServer: 'fake-crg-many',
      maxFiles: 1, maxTotalChars: 12000,
    },
  )).content[0].text);
  assert.equal(manyGraph.graph.totalImpacted, 120);
  assert.equal(manyGraph.graph.impactedFiles.length, 100);
  assert.equal(manyGraph.graph.truncated, true, 'local graph impact cap must be visible');
  assert.equal(manyGraph.orchestration.seedCandidates, 101);
  assert.equal(manyGraph.orchestration.seedFiles, 100);
  assert.equal(manyGraph.orchestration.seedFilesTruncated, true);

  await assert.rejects(
    () => readExternalMcpCompatUri('mcp://desktop-context/code_context?timeout_ms=15000', {
      root: REPO_ROOT, query: 'malformed graph response must fail closed',
      changedFiles: ['src/tools/external-mcp.ts'], graphServer: 'fake-crg-malformed',
      maxFiles: 1, maxTotalChars: 12000,
    }),
    /graph impact returned an invalid graph contract/,
  );

  await assert.rejects(
    () => readExternalMcpCompatUri('mcp://desktop-context/code_context?timeout_ms=15000', {
      root: REPO_ROOT, query: 'malformed semantic response must fail closed',
      semanticServer: 'fake-serena',
      symbolQueries: [{ name_path_pattern: 'MalformedTarget', max_matches: 2 }],
      maxFiles: 2, maxTotalChars: 12000,
    }),
    /find_symbol returned an invalid symbol contract/,
  );

  const shortened = JSON.parse((await readExternalMcpCompatUri(
    'mcp://desktop-context/code_context?timeout_ms=15000',
    {
      root: REPO_ROOT, query: 'shortened target retrieval', semanticServer: 'fake-serena',
      symbolQueries: [{ name_path_pattern: 'ShortenedTarget', substring_matching: true, max_matches: 2 }],
      maxFiles: 6, maxTotalChars: 20000,
    },
  )).content[0].text);
  assert.equal(shortened.semantic.expansion.sourceTruncated, true);
  assert.equal(shortened.semantic.expansion.truncated, true);
  assert.equal(shortened.semantic.expansion.seedCount, 2);
  assert.equal(shortened.semantic.expansion.expandedSeedCount, 2);
  assert.equal(shortened.orchestration.semanticExpansionCalls, 2);
  assert.deepEqual(shortened.semantic.expansion.truncatedQueries, [
    { queryIndex: 0, maxMatches: 2, reportedMatches: 12 },
  ]);
  assert(shortened.contextPack.seedFilesAccepted.includes('src/tools/code-context-orchestrator.ts'));

  const ranked = JSON.parse((await readExternalMcpCompatUri(
    'mcp://desktop-context/code_context?timeout_ms=15000',
    {
      root: REPO_ROOT, query: 'blocking offline generation fenced ranking target', semanticServer: 'fake-serena',
      symbolQueries: [{ name_path_pattern: 'RankingTarget', substring_matching: true, max_matches: 20 }],
      maxFiles: 6, maxTotalChars: 20000,
    },
  )).content[0].text);
  assert.equal(ranked.semantic.expansion.seedCount, 10);
  assert.equal(ranked.semantic.expansion.expandedSeedCount, 8);
  assert.equal(ranked.semantic.expansion.truncated, true);
  assert(ranked.semantic.expansion.selectedSeeds.some((seed) =>
    seed.namePath === 'test blocking offline RankingTarget generation fenced'
      && seed.relativePath === 'test/test-code-context-orchestrator.js'));

  const fair = JSON.parse((await readExternalMcpCompatUri(
    'mcp://desktop-context/code_context?timeout_ms=15000',
    {
      root: REPO_ROOT, query: 'critical second query', semanticServer: 'fake-serena',
      symbolQueries: [
        { name_path_pattern: 'BroadFirst', substring_matching: true, max_matches: 20 },
        { name_path_pattern: 'CriticalSecondQuery', max_matches: 2 },
      ],
      maxFiles: 6, maxTotalChars: 20000,
    },
  )).content[0].text);
  assert(fair.semantic.expansion.selectedSeeds.some((seed) =>
    seed.queryIndex === 1 && seed.namePath === 'CriticalSecondQuery'));

  const shortReferences = JSON.parse((await readExternalMcpCompatUri(
    'mcp://desktop-context/code_context?timeout_ms=15000',
    {
      root: REPO_ROOT, query: 'truncated reference evidence', semanticServer: 'fake-serena',
      symbolQueries: [{ name_path_pattern: 'ShortReferenceTarget', max_matches: 2 }],
      maxFiles: 6, maxTotalChars: 20000,
    },
  )).content[0].text);
  assert.equal(shortReferences.semantic.expansion.downstreamTruncated, true);
  assert.equal(shortReferences.semantic.expansion.truncated, true);
  assert.equal(shortReferences.semantic.expansion.relations.length, 2);
  assert(shortReferences.semantic.expansion.truncatedExpansionCalls.some((call) =>
    call.kind === 'reference' && call.seedNamePath === 'ShortReferenceTarget'));
  assert(shortReferences.contextPack.seedFilesAccepted.includes('src/server.ts'));

  const countedReferences = JSON.parse((await readExternalMcpCompatUri(
    'mcp://desktop-context/code_context?timeout_ms=15000',
    {
      root: REPO_ROOT, query: 'count only reference evidence', semanticServer: 'fake-serena',
      symbolQueries: [{ name_path_pattern: 'CountOnlyReferenceTarget', max_matches: 2 }],
      maxFiles: 6, maxTotalChars: 20000,
    },
  )).content[0].text);
  assert.equal(countedReferences.semantic.expansion.downstreamTruncated, true);
  assert.equal(countedReferences.semantic.expansion.relations.length, 0);
  assert(countedReferences.semantic.expansion.files.includes('src/server.ts'));
  assert(countedReferences.semantic.expansion.files.includes('src/tools/core-mcp.ts'));
  assert(countedReferences.contextPack.seedFilesAccepted.includes('src/tools/core-mcp.ts'));

  const longImplementation = JSON.parse((await readExternalMcpCompatUri(
    'mcp://desktop-context/code_context?timeout_ms=15000',
    {
      root: REPO_ROOT, query: 'implementation truncation must be visible', semanticServer: 'fake-serena',
      semanticExpand: 'all',
      symbolQueries: [{ name_path_pattern: 'LongImplementationTarget', max_matches: 2 }],
      maxFiles: 6, maxTotalChars: 20000,
    },
  )).content[0].text);
  assert.equal(longImplementation.semantic.expansion.downstreamTruncated, true);
  assert.equal(longImplementation.semantic.expansion.truncated, true);
  assert(longImplementation.semantic.expansion.truncatedExpansionCalls.some((call) =>
    call.kind === 'implementation' && call.seedNamePath === 'LongImplementationTarget'));
  assert.equal(longImplementation.semantic.expansion.relations.some((relation) => relation.kind === 'implementation'), false);

  const allSemantic = JSON.parse((await readExternalMcpCompatUri(
    'mcp://desktop-context/code_context?timeout_ms=15000',
    {
      root: REPO_ROOT,
      query: 'semantic references and implementations',
      semanticServer: 'fake-serena',
      semanticExpand: 'all',
      symbolQueries: [{
        name_path_pattern: 'callExternalMcpTool',
        relative_path: 'src/tools/external-mcp.ts',
      }],
      maxFiles: 4,
      maxTotalChars: 20000,
    },
  )).content[0].text);
  assert(allSemantic.semantic.expansion.files.includes('src/tools/core-mcp.ts'));
  assert(allSemantic.semantic.expansion.relations.some((relation) => relation.kind === 'implementation'));
  assert.equal(allSemantic.orchestration.semanticExpansionCalls, 2);

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
    /semantic provider requires symbolQueries/,
  );

  console.log('code context orchestrator: PASS');
} finally {
  await closeExternalMcpRuntime().catch(() => {});
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
  await fs.rm(isolated, { recursive: true, force: true }).catch(() => {});
}
