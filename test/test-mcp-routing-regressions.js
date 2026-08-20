#!/usr/bin/env node
import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import {
  assertBoundedProxyValue,
  callExternalMcpCompatUri,
  callExternalMcpTool,
  parseExternalMcpCompatUri,
  readExternalMcpCompatUri,
  readMultipleFilesCompatAware,
} from '../dist/tools/external-mcp.js';
import { callBuiltinCoreTool } from '../dist/tools/core-mcp.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { unsupportedMcpReadFileOptions } from '../dist/utils/mcp-uri.js';
import { terminateProcessTree } from '../dist/utils/process-tree.js';
import { ReadMultipleFilesArgsSchema } from '../dist/tools/schemas.js';
import { PROCESS_TRANSPORT_RESERVE_MS } from '../dist/utils/process-wait-contract.js';

function parseText(result) {
  assert.equal(result.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

async function expectReject(action, pattern) {
  await assert.rejects(action, (error) => pattern.test(String(error?.message || error)));
}

const sharedProxyValue = { files: ['sample.py'] };
const aliasedProxyResult = { first: sharedProxyValue, second: sharedProxyValue };
assert.doesNotThrow(() => assertBoundedProxyValue(aliasedProxyResult, 'aliased proxy result'));
assert.deepEqual(JSON.parse(JSON.stringify(aliasedProxyResult)), {
  first: { files: ['sample.py'] },
  second: { files: ['sample.py'] },
});
const cyclicProxyResult = { label: 'cycle' };
cyclicProxyResult.self = cyclicProxyResult;
assert.throws(
  () => assertBoundedProxyValue(cyclicProxyResult, 'cyclic proxy result'),
  /contains a cyclic object/,
);

async function runChild(scriptPath, env, timeoutMs = 20000) {
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ...env },
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void terminateProcessTree(child, 3000, true).finally(() => {
        reject(new Error(`isolated MCP routing child timed out; stdout=${stdout}; stderr=${stderr}`));
      });
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`isolated MCP routing child failed (${code}); stdout=${stdout}; stderr=${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function runServerPassthroughProbe(root) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-mcp-passthrough-'));
  const cfgDir = path.join(home, '.claude-server-commander');
  const baseFallbackFile = path.join(home, 'base-fallback.txt');
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.writeFile(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ telemetryEnabled: false, allowedDirectories: [root, home] }),
    'utf8',
  );
  await fs.writeFile(
    path.join(cfgDir, 'feature-flags.json'),
    JSON.stringify({ version: 'mcp-routing-test', flags: { onboarding_injection: true } }),
    'utf8',
  );

  const child = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], {
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DC_FLAG_URL: 'http://127.0.0.1:9/',
      // Built-in/base tools must remain operational even when the external MCP
      // configuration is missing or unusable. This is the emergency fallback path.
      DESKTOP_COMMANDER_MCP_CONFIG: path.join(home, 'missing-external-mcp.json'),
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void terminateProcessTree(child, 3000, true).finally(() => {
          reject(new Error(`stdio MCP passthrough probe timed out; stderr=${stderr.slice(-3000)}`));
        });
      }, 15000);
      const finish = (value, error) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
      let readResult;
      let writeResult;
      let baseWriteResult;
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        for (;;) {
          const nl = stdout.indexOf('\n');
          if (nl < 0) break;
          const line = stdout.slice(0, nl).trim();
          stdout = stdout.slice(nl + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'read_file',
                arguments: {
                  path: 'mcp://desktop-accelerators/workspace_snapshot',
                  isUrl: false,
                  offset: 0,
                  length: 1000,
                },
              },
            });
          } else if (message.id === 2) {
            readResult = message.result;
            send({
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: {
                name: 'write_file',
                arguments: {
                  path: 'mcp://desktop-accelerators/workspace_snapshot?timeout_ms=5000',
                  content: JSON.stringify({ root, includeDiffStat: false }),
                  mode: 'rewrite',
                },
              },
            });
          } else if (message.id === 3) {
            writeResult = message.result;
            send({
              jsonrpc: '2.0', id: 4, method: 'tools/call',
              params: {
                name: 'write_file',
                arguments: { path: baseFallbackFile, content: 'BASE_FALLBACK_OK\n', mode: 'rewrite' },
              },
            });
          } else if (message.id === 4) {
            baseWriteResult = message.result;
            send({
              jsonrpc: '2.0', id: 5, method: 'tools/call',
              params: {
                name: 'read_file',
                arguments: { path: baseFallbackFile, offset: 0, length: 10 },
              },
            });
          } else if (message.id === 5) {
            finish({ readResult, writeResult, baseWriteResult, baseReadResult: message.result });
          }
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => finish(undefined, error));
      child.on('exit', (code) => {
        if (code !== null && code !== 0) finish(undefined, new Error(`stdio MCP server exited ${code}; stderr=${stderr.slice(-3000)}`));
      });
      send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'routing-probe', version: '1.0.0' } },
      });
    });
    const readText = (result?.readResult?.content ?? []).map((item) => item?.text ?? '').join('\n');
    assert(readText.includes('workspace_snapshot'), 'frozen wrapper defaults must not break mcp:// read_file discovery');
    const text = (result?.writeResult?.content ?? []).map((item) => item?.text ?? '').join('\n');
    assert(!text.includes('NEW USER ONBOARDING REQUIRED'));
    const parsed = JSON.parse(text);
    assert.equal(parsed.repositoryRoot.replace(/\\/g, '/').toLowerCase(), root.replace(/\\/g, '/').toLowerCase());
    const baseWriteText = (result?.baseWriteResult?.content ?? []).map((item) => item?.text ?? '').join('\n');
    assert.match(baseWriteText, /Successfully wrote to/);
    const baseReadText = (result?.baseReadResult?.content ?? []).map((item) => item?.text ?? '').join('\n');
    assert(baseReadText.includes('BASE_FALLBACK_OK'), `base read/write fallback failed while external MCP config was unavailable: ${baseReadText}`);
  } finally {
    try { child.stdin.end(); } catch {}
    await terminateProcessTree(child, 3000, true).catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function main() {
  assert.deepEqual(unsupportedMcpReadFileOptions({ isUrl: false, offset: 0, length: 1000 }), []);
  assert.deepEqual(unsupportedMcpReadFileOptions({ offset: 1, length: 1000 }), ['offset']);
  assert.deepEqual(unsupportedMcpReadFileOptions({ offset: 0, length: 50 }), ['length']);
  await expectReject(
    () => callExternalMcpTool({
      server: 'desktop-core',
      tool: 'write_file',
      arguments: {
        path: 'mcp://desktop-accelerators/workspace_snapshot',
        content: JSON.stringify({ root: REPO_ROOT, includeDiffStat: false }),
        mode: 'append',
      },
      timeout_ms: 5000,
    }),
    /only accepts mode=rewrite/,
  );
  assert.deepEqual(
    parseExternalMcpCompatUri('mcp://server/tool?timeout_ms=45000&envelope=flat'),
    { server: 'server', tool: 'tool', timeout_ms: 45000, envelope: 'flat' },
  );
  assert.deepEqual(
    parseExternalMcpCompatUri('MCP://server/tool?timeout_ms=5000'),
    { server: 'server', tool: 'tool', timeout_ms: 5000 },
  );
  assert.throws(() => parseExternalMcpCompatUri('mcp://server/tool?timeout_ms=1&timeout_ms=2'), /only once/);
  assert.throws(() => parseExternalMcpCompatUri('mcp://server/tool?envelope=other'), /flat or legacy/);
  assert.throws(() => parseExternalMcpCompatUri('mcp://server/%ZZ'), /invalid percent-encoding/);
  assert.throws(() => parseExternalMcpCompatUri('mcp://server/a%2Fb'), /path separators/);
  assert.throws(() => parseExternalMcpCompatUri(`mcp://${'x'.repeat(5000)}`), /too long/);
  await expectReject(
    () => readExternalMcpCompatUri('mcp://desktop-accelerators/workspace_snapshot?envelope=legacy'),
    /only valid for write\/call/,
  );

  const root = REPO_ROOT;
  const originalReadOutputPaginated = terminalManager.readOutputPaginated;
  terminalManager.readOutputPaginated = () => ({
    lines: [],
    totalLines: 0,
    readFrom: 0,
    readCount: 0,
    remaining: 0,
    isComplete: false,
    evictedLines: 0,
    lastOutputTimeMs: Date.now(),
    noOutputForMs: 0,
  });
  try {
    const processWaitMs = 100;
    const exactTransportBudget = processWaitMs + PROCESS_TRANSPORT_RESERVE_MS;
    const waitArgs = { pid: 123456789, timeout_ms: processWaitMs, stall_timeout_ms: 0, tail_lines: 20 };

    await expectReject(
      () => callExternalMcpTool({
        server: 'desktop-accelerators', tool: 'wait_process', arguments: waitArgs,
        timeout_ms: exactTransportBudget - 1,
      }),
      /must be at least/,
    );

    const startedAt = Date.now();
    const waitResult = parseText(await callExternalMcpTool({
      server: 'desktop-accelerators',
      tool: 'wait_process',
      arguments: waitArgs,
      timeout_ms: exactTransportBudget,
    }));
    assert.equal(waitResult.completed, false);
    assert.equal(waitResult.timedOut, true);
    assert(Date.now() - startedAt < 1500, 'exact process transport budget must not add a second hidden reserve');

    await expectReject(
      () => callExternalMcpCompatUri(
        `mcp://desktop-accelerators/wait_process?timeout_ms=${exactTransportBudget - 1}`,
        JSON.stringify(waitArgs),
      ),
      /must be at least/,
    );

    const compatStartedAt = Date.now();
    const compatWaitResult = parseText(await callExternalMcpCompatUri(
      `mcp://desktop-accelerators/wait_process?timeout_ms=${exactTransportBudget}`,
      JSON.stringify(waitArgs),
    ));
    assert.equal(compatWaitResult.completed, false);
    assert.equal(compatWaitResult.timedOut, true);
    assert(Date.now() - compatStartedAt < 1500, 'compat exact process budget became self-invalidating');
  } finally {
    terminalManager.readOutputPaginated = originalReadOutputPaginated;
  }

  const buildExecuteWaitMs = 1000;
  const buildExecuteTransportBudget = buildExecuteWaitMs + PROCESS_TRANSPORT_RESERVE_MS;
  const buildExecuteArgs = { root, buildDir: root, operation: 'build', timeoutMs: buildExecuteWaitMs, executionMode: 'inline' };
  await expectReject(
    () => callExternalMcpCompatUri(
      `mcp://desktop-accelerators/cpp_build_execute?timeout_ms=${buildExecuteTransportBudget - 1}`,
      JSON.stringify(buildExecuteArgs),
    ),
    /must be at least/,
  );
  const buildExecuteBoundary = parseText(await callExternalMcpCompatUri(
    `mcp://desktop-accelerators/cpp_build_execute?timeout_ms=${buildExecuteTransportBudget}`,
    JSON.stringify(buildExecuteArgs),
  ));
  assert.equal(buildExecuteBoundary.succeeded, false);
  assert(buildExecuteBoundary.diagnostics.some((item) => item.tool === 'cpp_build_execute'));

  const explicitLegacy = parseText(await callExternalMcpCompatUri(
    'mcp://desktop-accelerators/workspace_snapshot?envelope=legacy&timeout_ms=5000',
    JSON.stringify({ arguments: { root, includeDiffStat: false }, timeout_ms: 5000 }),
  ));
  assert.equal(explicitLegacy.repositoryRoot.replace(/\\/g, '/').toLowerCase(), root.replace(/\\/g, '/').toLowerCase());

  await expectReject(
    () => callExternalMcpCompatUri(
      'mcp://desktop-accelerators/workspace_snapshot?envelope=flat&timeout_ms=5000',
      JSON.stringify({ arguments: { root }, timeout_ms: 4000 }),
    ),
    /workspace_snapshot\.root is required/,
  );
  await expectReject(
    () => callExternalMcpCompatUri(
      'mcp://desktop-accelerators/workspace_snapshot',
      JSON.stringify({ blob: 'x'.repeat(8 * 1024 * 1024 + 1) }),
    ),
    /payload exceeds/,
  );

  const batch = await readMultipleFilesCompatAware(
    [
      'mcp://desktop-core/read_process_output?timeout_ms=5000',
      'local-probe',
      'mcp://desktop-accelerators/no_such_tool?timeout_ms=5000',
    ],
    async (filePath) => ({ content: [{ type: 'text', text: `LOCAL:${filePath}` }] }),
  );
  const batchText = batch.content.map((item) => item.type === 'text' ? item.text : '').join('\n');
  assert(batchText.includes('stall_timeout_ms'));
  assert(batchText.includes('LOCAL:local-probe'));
  assert(batchText.includes('no_such_tool'));

  const localBatchPaths = ['local-a', 'local-b', 'local-c', 'local-d'];
  const batchStartedAt = Date.now();
  const concurrentBatch = await readMultipleFilesCompatAware(localBatchPaths, async (filePath) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { content: [{ type: 'text', text: `DONE:${filePath}` }] };
  });
  assert(Date.now() - batchStartedAt < 300, 'compat-aware batch regressed to sequential local reads');
  const concurrentText = concurrentBatch.content.map((item) => item.type === 'text' ? item.text : '').join('\n');
  let previousIndex = -1;
  for (const filePath of localBatchPaths) {
    const currentIndex = concurrentText.indexOf(`--- ${filePath} ---`);
    assert(currentIndex > previousIndex, 'batch output order must match input order');
    previousIndex = currentIndex;
  }
  await expectReject(
    () => readMultipleFilesCompatAware(Array.from({ length: 101 }, (_, index) => `local-${index}`), async () => ({ content: [] })),
    /at most 100 paths/,
  );
  assert.equal(ReadMultipleFilesArgsSchema.safeParse({ paths: Array.from({ length: 101 }, () => 'x') }).success, false);

  const coreRead = parseText(await callBuiltinCoreTool('read_file', {
    path: 'MCP://desktop-accelerators/workspace_snapshot?timeout_ms=5000',
  }));
  assert.equal(coreRead.tool.name, 'workspace_snapshot');

  const coreBatch = await callBuiltinCoreTool('read_multiple_files', {
    paths: [
      'mcp://desktop-accelerators/workspace_snapshot?timeout_ms=5000',
      'mcp://desktop-core/read_process_output?timeout_ms=5000',
    ],
  });
  const coreBatchText = coreBatch.content.map((item) => item.type === 'text' ? item.text : '').join('\n');
  assert(coreBatchText.includes('workspace_snapshot'));
  assert(coreBatchText.includes('stall_timeout_ms'));

  const coreWrite = parseText(await callBuiltinCoreTool('write_file', {
    path: 'mcp://desktop-accelerators/workspace_snapshot?timeout_ms=5000',
    content: JSON.stringify({ root, includeDiffStat: false }),
    mode: 'rewrite',
  }));
  assert.equal(coreWrite.repositoryRoot.replace(/\\/g, '/').toLowerCase(), root.replace(/\\/g, '/').toLowerCase());
  await expectReject(
    () => callBuiltinCoreTool('write_file', {
      path: 'mcp://desktop-core/write_file',
      content: '{}',
      mode: 'rewrite',
    }),
    /Recursive desktop-core\/write_file routing/,
  );

  const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-mcp-routing-'));
  try {
    const fakeServer = path.join(isolated, 'fake-mcp-server.mjs');
    const configPath = path.join(isolated, 'mcporter.json');
    const childScript = path.join(isolated, 'routing-child.mjs');
    await fs.writeFile(fakeServer, `
import fs from 'node:fs';
let buffer = '';
let listGeneration = 0;
process.stdin.setEncoding('utf8');
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
async function handle(message) {
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'dc-routing-fake', version: '1.0.0' },
      instructions: 'Fake MCP server instructions\\nCRITICAL: Before starting, call the initial_instructions tool.'
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'ping') { send(message.id, {}); return; }
  if (message.method === 'tools/list') {
    if (process.env.DC_LIST_TOOLS_FILE) fs.appendFileSync(process.env.DC_LIST_TOOLS_FILE, 'list\\n');
    const triggerDuringList = !message.params?.cursor && process.env.DC_LIST_CHANGE_DURING_LIST_FILE && fs.existsSync(process.env.DC_LIST_CHANGE_DURING_LIST_FILE);
    const responseGeneration = listGeneration;
    if (triggerDuringList) {
      fs.rmSync(process.env.DC_LIST_CHANGE_DURING_LIST_FILE, { force: true });
      listGeneration += 1;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\\n');
    }
    if (message.params?.cursor === 'page-2') {
      send(message.id, { tools: [{
        name: 'echo_two',
        description: 'Second paginated tool.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      }, {
        name: 'search_for_pattern',
        description: 'Fake Serena pattern discovery.',
        inputSchema: { type: 'object', properties: { substring_pattern: { type: 'string' } }, required: ['substring_pattern'], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      }] });
      return;
    }
    send(message.id, { tools: [{
      name: 'echo',
      title: 'Echo Full Metadata',
      description: 'Echo arguments with full MCP metadata. generation=' + responseGeneration,
      inputSchema: { type: 'object', properties: { value: { type: 'string' }, delay_ms: { type: 'number' }, change_tools: { type: 'boolean' }, huge_bytes: { type: 'number' }, disconnect_once: { type: 'boolean' } }, additionalProperties: false },
      outputSchema: { type: 'object', properties: { echoed: { type: 'object' } }, required: ['echoed'] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execution: { taskSupport: 'forbidden' },
      _meta: { 'x-dc-routing': 'tool-meta' }
    }, {
      name: 'get_symbols_overview',
      description: 'Fake file-local Serena read.',
      inputSchema: { type: 'object', properties: { relative_path: { type: 'string' }, value: { type: 'string' }, delay_ms: { type: 'number' } }, required: ['relative_path'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }], nextCursor: 'page-2' });
    return;
  }
  if (message.method === 'tools/call') {
    if (message.params?.arguments?.disconnect_once && process.env.DC_DISCONNECT_ONCE_FILE && !fs.existsSync(process.env.DC_DISCONNECT_ONCE_FILE)) {
      fs.writeFileSync(process.env.DC_DISCONNECT_ONCE_FILE, 'disconnected\\n');
      process.exit(0);
      return;
    }
    const delay = Number(message.params?.arguments?.delay_ms || 0);
    if (message.params?.arguments?.change_tools) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\\n');
    }
    if (delay > 0 && process.env.DC_CALL_STARTED_FILE) {
      fs.appendFileSync(process.env.DC_CALL_STARTED_FILE, String(message.params?.arguments?.value || '') + '\\n');
    }
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const echoed = message.params?.arguments || {};
    const hugeBytes = Number(echoed.huge_bytes || 0);
    const responseText = hugeBytes > 0 ? 'x'.repeat(hugeBytes) : JSON.stringify(echoed);
    send(message.id, {
      content: [{ type: 'text', text: responseText }],
      structuredContent: { echoed },
      isError: false,
      _meta: { 'x-dc-routing': 'result-meta' },
      xRoutingExtension: { preserved: true }
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
    if (!line) continue;
    void handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
`, 'utf8');

    const configFor = (name) => ({
      mcpServers: {
        [name]: {
          command: process.execPath,
          args: [fakeServer],
          protocolVersion: 'legacy',
          lifecycle: 'keep-alive',
          allowedTools: ['echo', 'echo_two', 'get_symbols_overview'],
        },
        'serena-test': {
          command: process.execPath,
          args: [fakeServer, 'start-mcp-server', '--project', isolated],
          protocolVersion: 'legacy',
          lifecycle: 'keep-alive',
          allowedTools: ['echo', 'echo_two', 'get_symbols_overview'],
        },
      },
    });
    await fs.writeFile(configPath, JSON.stringify(configFor('fake-a'), null, 2), 'utf8');

    const externalMcpUrl = pathToFileURL(path.join(root, 'dist', 'tools', 'external-mcp.js')).href;
    await fs.writeFile(childScript, `
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { listExternalMcpTools, callExternalMcpTool, callExternalMcpCompatUri, readExternalMcpCompatUri, callSerenaWorkspaceTool, callSessionSerenaTool, callSessionSerenaReadBatch, closeExternalMcpRuntime } from ${JSON.stringify(externalMcpUrl)};
const configPath = process.env.DESKTOP_COMMANDER_MCP_CONFIG;
const fakeServer = process.env.DC_FAKE_SERVER;
const configFor = (name) => ({ mcpServers: {
  [name]: { command: process.execPath, args: [fakeServer], protocolVersion: 'legacy', lifecycle: 'keep-alive', allowedTools: ['echo', 'echo_two', 'get_symbols_overview'] },
  'serena-test': { command: process.execPath, args: [fakeServer, 'start-mcp-server', '--project', process.env.DC_SERENA_ROOT], protocolVersion: 'legacy', lifecycle: 'keep-alive', allowedTools: ['echo', 'echo_two', 'get_symbols_overview'] }
} });
const roots = await Promise.all(Array.from({ length: 6 }, () => listExternalMcpTools({ timeout_ms: 5000 })));
for (const result of roots) {
  const parsed = JSON.parse(result.content[0].text);
  assert(parsed.servers.includes('fake-a'));
}
await fs.rm(process.env.DC_LIST_TOOLS_FILE, { force: true });
const paged = JSON.parse((await listExternalMcpTools({ server: 'fake-a', timeout_ms: 5000 })).content[0].text);
assert.deepEqual(paged.tools.map((tool) => tool.name).sort(), ['echo', 'echo_two', 'get_symbols_overview']);
assert.equal(paged.instructions, 'Fake MCP server instructions');\nassert(!paged.instructions.includes('initial_instructions'), 'discovery leaked instructions for a tool that is not exposed');
const exact = JSON.parse((await listExternalMcpTools({ server: 'fake-a', tool: 'echo', timeout_ms: 5000 })).content[0].text);
assert.equal(exact.tool.title, 'Echo Full Metadata');
assert.equal(exact.tool.annotations.readOnlyHint, true);
assert.equal(exact.tool.execution.taskSupport, 'forbidden');
assert.equal(exact.tool.outputSchema.type, 'object');
assert.equal(exact.tool._meta['x-dc-routing'], 'tool-meta');
assert.equal(exact.tool.preferredFrozenSurface, 'write_file');
assert.equal(exact.instructions, 'Fake MCP server instructions');\nassert(!exact.instructions.includes('initial_instructions'), 'exact discovery leaked instructions for a tool that is not exposed');
delete process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY;
await assert.rejects(
  () => readExternalMcpCompatUri('mcp://fake-a/echo?timeout_ms=5000', { value: 'hint-is-not-trust' }),
  /local DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY policy must explicitly allow it/,
);
process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY = JSON.stringify({ 'fake-a': ['echo'] });
const trustedExact = JSON.parse((await listExternalMcpTools({ server: 'fake-a', tool: 'echo', timeout_ms: 5000 })).content[0].text);
assert.equal(trustedExact.tool.preferredFrozenSurface, 'read_file');
const trustedRead = await readExternalMcpCompatUri('mcp://fake-a/echo?timeout_ms=5000', { value: 'trusted-read-route' });
assert.equal(trustedRead.structuredContent.echoed.value, 'trusted-read-route');
await fs.rm(process.env.DC_DISCONNECT_ONCE_FILE, { force: true });
const recoveredRead = await readExternalMcpCompatUri('mcp://fake-a/echo?timeout_ms=5000', { value: 'recovered-read-route', disconnect_once: true });
assert.equal(recoveredRead.structuredContent.echoed.value, 'recovered-read-route');

process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY = JSON.stringify({ 'fake-a': ['echo_two'] });
await assert.rejects(
  () => readExternalMcpCompatUri('mcp://fake-a/echo?timeout_ms=5000', { value: 'revoked' }),
  /local DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY policy must explicitly allow it/,
);
process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY = '{bad json';
await assert.rejects(
  () => readExternalMcpCompatUri('mcp://fake-a/echo?timeout_ms=5000', { value: 'malformed-policy' }),
  /must contain valid JSON/,
);
process.env.DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY = JSON.stringify({ 'fake-a': ['echo'] });
const postRecoveryExact = JSON.parse((await listExternalMcpTools({ server: 'fake-a', tool: 'echo', timeout_ms: 5000 })).content[0].text);
assert.equal(postRecoveryExact.tool.name, 'echo');
const cachedListCalls = (await fs.readFile(process.env.DC_LIST_TOOLS_FILE, 'utf8')).trim().split(/\\r?\\n/).filter(Boolean);
assert.equal(cachedListCalls.length, 4, 'connection recovery should invalidate and refill the paginated tools/list cache once');
const invalidatingCall = await callExternalMcpTool({ server: 'fake-a', tool: 'echo', arguments: { value: 'invalidate', change_tools: true }, timeout_ms: 5000 });
assert.equal(invalidatingCall.structuredContent.echoed.value, 'invalidate');
const refreshed = JSON.parse((await listExternalMcpTools({ server: 'fake-a', timeout_ms: 5000 })).content[0].text);
assert(refreshed.tools.some((tool) => tool.name === 'echo'));
const refreshedListCalls = (await fs.readFile(process.env.DC_LIST_TOOLS_FILE, 'utf8')).trim().split(/\\r?\\n/).filter(Boolean);
assert.equal(refreshedListCalls.length, cachedListCalls.length + 2, 'tools/list_changed should invalidate both paginated cache pages');

await fs.writeFile(process.env.DC_LIST_CHANGE_DURING_LIST_FILE, 'armed', 'utf8');
await callExternalMcpTool({ server: 'fake-a', tool: 'echo', arguments: { value: 'pre-list-race', change_tools: true }, timeout_ms: 5000 });
await listExternalMcpTools({ server: 'fake-a', timeout_ms: 5000 });
const afterListRace = JSON.parse((await listExternalMcpTools({ server: 'fake-a', timeout_ms: 5000 })).content[0].text);
const racedEcho = afterListRace.tools.find((tool) => tool.name === 'echo');
assert(racedEcho?.description?.includes('generation=1'), 'tools/list_changed during discovery allowed a stale cache generation');

const fixedSerenaTools = JSON.parse((await listExternalMcpTools({ server: 'serena-test', timeout_ms: 5000 })).content[0].text);
assert(!fixedSerenaTools.tools.some((tool) => tool.name === 'search_for_pattern'), 'fixed Serena template unexpectedly gained session-only search_for_pattern');
const cacheProbePath = process.env.DC_SERENA_ROOT + '/cache-probe.ts';
await fs.writeFile(cacheProbePath, 'export const generation = 1;\\n', 'utf8');
const workspaceSession = 'session_test_123';
const boundSerena = await callSerenaWorkspaceTool({ operation: 'bind', root: process.env.DC_SERENA_ROOT, session: workspaceSession, templateServer: 'serena-test' }, 5000);
assert.equal(boundSerena.workspaceSession, workspaceSession);
const patternRead = JSON.parse((await callExternalMcpCompatUri(
  'mcp://desktop-context/serena_call?timeout_ms=5000',
  JSON.stringify({ tool: 'search_for_pattern', arguments: { substring_pattern: 'generation' }, session: workspaceSession }),
)).content[0].text);
assert.equal(patternRead.status, 'ready');
assert.equal(patternRead.result.structuredContent.echoed.substring_pattern, 'generation');
const sessionSerenaTools = JSON.parse((await listExternalMcpTools({ server: boundSerena.server, timeout_ms: 5000 })).content[0].text);
assert(sessionSerenaTools.tools.some((tool) => tool.name === 'search_for_pattern'), 'warmed session Serena did not expose search_for_pattern through mcp://');
const localReadArgs = { relative_path: 'cache-probe.ts', value: 'session-read' };
const originalSerenaCacheReadFile = fs.readFile;
let cacheProbeReads = 0;
fs.readFile = async (...args) => {
  if (String(args[0]) === cacheProbePath) {
    cacheProbeReads++;
    if (cacheProbeReads === 2) await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return originalSerenaCacheReadFile(...args);
};
const sessionReadStartedAt = Date.now();
let sessionRead;
try {
  sessionRead = await callSessionSerenaTool({ tool: 'get_symbols_overview', arguments: localReadArgs, session: workspaceSession }, 5000);
} finally {
  fs.readFile = originalSerenaCacheReadFile;
}
assert(Date.now() - sessionReadStartedAt < 900, 'completed Serena read waited for post-result cache hashing');
assert.equal(sessionRead.status, 'ready');
assert.equal(sessionRead.result.structuredContent.echoed.value, 'session-read');
await new Promise((resolve) => setTimeout(resolve, 1300));
const sessionCached = await callSessionSerenaTool({ tool: 'get_symbols_overview', arguments: localReadArgs, session: workspaceSession }, 5000);
assert.equal(sessionCached.cached, true, 'unchanged file-local Serena read was not reused');
await fs.writeFile(cacheProbePath, 'export const generation = 2;\\n', 'utf8');
const invalidatedRead = await callSessionSerenaTool({ tool: 'get_symbols_overview', arguments: localReadArgs, session: workspaceSession }, 5000);
assert.equal(invalidatedRead.cached, false, 'file-local Serena cache survived a content hash change');
const genericRead = await callSessionSerenaTool({ tool: 'echo', arguments: { value: 'global-read' }, session: workspaceSession }, 5000);
const genericRepeat = await callSessionSerenaTool({ tool: 'echo', arguments: { value: 'global-read' }, session: workspaceSession }, 5000);
assert.equal(genericRead.cached, false);
assert.equal(genericRepeat.cached, false, 'workspace-dependent read without a file dependency was memoized unsafely');

const readBatch = await callSessionSerenaReadBatch({
  session: workspaceSession,
  concurrency: 2,
  calls: [
    { tool: 'echo', arguments: { value: 'batch-a' } },
    { tool: 'get_symbols_overview', arguments: { relative_path: 'cache-probe.ts', value: 'batch-b' } },
  ],
}, 5000);
assert.equal(readBatch.status, 'ready');
assert.equal(readBatch.results.length, 2);
assert.equal(readBatch.results[0].tool, 'echo');
assert.equal(readBatch.results[0].result.structuredContent.echoed.value, 'batch-a');
assert.equal(readBatch.results[1].tool, 'get_symbols_overview');
assert.equal(readBatch.results[1].result.structuredContent.echoed.value, 'batch-b');
await assert.rejects(
  () => callSessionSerenaReadBatch({
    session: workspaceSession, calls: [{ tool: 'echo_two', arguments: { value: 'must-reject' } }],
  }, 5000),
  /read-only tool/,
);

const coldSession = 'session_cold_123';
await callSerenaWorkspaceTool({ operation: 'bind', root: process.env.DC_SERENA_ROOT, session: coldSession, templateServer: 'serena-test' }, 5000);
await fs.rm(process.env.DC_CALL_STARTED_FILE, { force: true });
const coldStartedAt = Date.now();
const coldArgs = { relative_path: 'cache-probe.ts', value: 'cold-session', delay_ms: 16000 };
const coldResult = await callSessionSerenaTool({ tool: 'get_symbols_overview', arguments: coldArgs, session: coldSession }, 20000);
assert.equal(coldResult.status, 'cold_start');
assert(Date.now() - coldStartedAt >= 14000, 'cold-start status returned before the 15s reporting window');
await new Promise((resolve) => setTimeout(resolve, 1800));
const warmedResult = await callSessionSerenaTool({ tool: 'get_symbols_overview', arguments: coldArgs, session: coldSession }, 5000);
assert.equal(warmedResult.status, 'ready');
assert.equal(warmedResult.cached, true, 'completed cold-start read was not reused from session cache');
const coldMarkers = (await fs.readFile(process.env.DC_CALL_STARTED_FILE, 'utf8')).trim().split(/\\r?\\n/).filter((line) => line === 'cold-session');
assert.equal(coldMarkers.length, 1, 'cold-start retry re-executed the detached read');
await callSerenaWorkspaceTool({ operation: 'release', session: coldSession }, 5000);
await callSerenaWorkspaceTool({ operation: 'release', session: workspaceSession }, 5000);

const call = await callExternalMcpTool({ server: 'fake-a', tool: 'echo', arguments: { value: 'ok' }, timeout_ms: 5000 });
assert.deepEqual(call.structuredContent, { echoed: { value: 'ok' } });
assert.equal(call._meta['x-dc-routing'], 'result-meta');
assert.deepEqual(call.xRoutingExtension, { preserved: true });
await assert.rejects(
  () => callExternalMcpTool({ server: 'fake-a', tool: 'echo', arguments: { huge_bytes: 9 * 1024 * 1024 }, timeout_ms: 5000 }),
  /resource limit/,
);
const doomed = callExternalMcpTool({ server: 'fake-a', tool: 'echo', arguments: { value: 'timeout', delay_ms: 700 }, timeout_ms: 150 }).then(
  () => null,
  (error) => error,
);
await new Promise((resolve) => setTimeout(resolve, 20));
const survivor = callExternalMcpTool({ server: 'fake-a', tool: 'echo', arguments: { value: 'survivor', delay_ms: 250 }, timeout_ms: 2000 });
const [timeoutError, survivorResult] = await Promise.all([doomed, survivor]);
assert(timeoutError instanceof Error);
assert.equal(survivorResult.structuredContent.echoed.value, 'survivor');
await fs.rm(process.env.DC_CALL_STARTED_FILE, { force: true });
const retiringProbe = callExternalMcpTool({ server: 'fake-a', tool: 'echo', arguments: { value: 'retiring-probe', delay_ms: 1800 }, timeout_ms: 4000 });
let retiringStarted = false;
for (let attempt = 0; attempt < 100; attempt++) {
  const marker = await fs.readFile(process.env.DC_CALL_STARTED_FILE, 'utf8').catch(() => '');
  if (marker.includes('retiring-probe')) { retiringStarted = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert(retiringStarted, 'fake MCP server never entered the delayed retiring-probe call');
await fs.writeFile(configPath, JSON.stringify(configFor('fake-b'), null, 2), 'utf8');
await assert.rejects(
  () => listExternalMcpTools({ server: 'fake-b', timeout_ms: 700 }),
  /Wait for active external MCP calls before reload deadline exceeded/,
);
await fs.writeFile(configPath, JSON.stringify(configFor('fake-a'), null, 2), 'utf8');
const reuseStarted = Date.now();
const reused = JSON.parse((await listExternalMcpTools({ server: 'fake-a', timeout_ms: 500 })).content[0].text);
assert(Date.now() - reuseStarted < 250, 'failed reload left the healthy runtime stuck in retiring state');
assert(reused.tools.some((tool) => tool.name === 'echo'));
assert.equal((await retiringProbe).structuredContent.echoed.value, 'retiring-probe');

const active = callExternalMcpTool({ server: 'fake-a', tool: 'echo', arguments: { value: 'slow', delay_ms: 500 }, timeout_ms: 4000 });
await new Promise((resolve) => setTimeout(resolve, 50));
await fs.writeFile(configPath, JSON.stringify(configFor('fake-b'), null, 2), 'utf8');
const reloaded = listExternalMcpTools({ timeout_ms: 4000 });
const [activeResult, reloadResult] = await Promise.all([active, reloaded]);
assert.equal(activeResult.structuredContent.echoed.value, 'slow');
const reloadParsed = JSON.parse(reloadResult.content[0].text);
assert(reloadParsed.servers.includes('fake-b'));
assert(!reloadParsed.servers.includes('fake-a'));
await closeExternalMcpRuntime();

// Config fingerprint reads support AbortSignal in Node. A proxy deadline must
// cancel the underlying read rather than merely abandon a still-running promise.
await fs.writeFile(configPath, JSON.stringify(configFor('abort-probe'), null, 2), 'utf8');
const originalFingerprintReadFile = fs.readFile;
let fingerprintSignal;
fs.readFile = async (...args) => {
  const candidateSignal = args[1] && typeof args[1] === 'object' ? args[1].signal : undefined;
  if (String(args[0]) === configPath && candidateSignal) {
    fingerprintSignal = candidateSignal;
    return new Promise((_resolve, reject) => {
      fingerprintSignal.addEventListener('abort', () => {
        const error = new Error('fingerprint read aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  }
  return originalFingerprintReadFile(...args);
};
try {
  await assert.rejects(
    () => listExternalMcpTools({ server: 'abort-probe', timeout_ms: 500 }),
    /deadline exceeded|timed out|fingerprint read aborted/,
  );
  assert(fingerprintSignal, 'external MCP fingerprint read did not receive an AbortSignal');
  assert.equal(fingerprintSignal.aborted, true, 'external MCP fingerprint read signal was not aborted on timeout');
} finally {
  fs.readFile = originalFingerprintReadFile;
}

// A config rewrite after the stable fingerprint but before the saved stat stamp
// must not pair old parsed definitions with metadata from the new file version.
await fs.writeFile(configPath, JSON.stringify(configFor('race-a'), null, 2), 'utf8');
const originalStat = fs.stat;
let rewroteDuringFinalStat = false;
fs.stat = async (...args) => {
  const stack = new Error().stack || '';
  if (!rewroteDuringFinalStat && String(args[0]) === configPath && stack.includes('statConfigSources')) {
    rewroteDuringFinalStat = true;
    await fs.writeFile(configPath, JSON.stringify(configFor('race-b'), null, 2), 'utf8');
  }
  return originalStat(...args);
};
try {
  await listExternalMcpTools({ timeout_ms: 5000 });
} finally {
  fs.stat = originalStat;
}
assert(rewroteDuringFinalStat, 'race fixture never intercepted the final config stat');
const afterMetadataRace = JSON.parse((await listExternalMcpTools({ timeout_ms: 5000 })).content[0].text);
assert(afterMetadataRace.servers.includes('race-b'), 'metadata race reused stale external MCP definitions');
assert(!afterMetadataRace.servers.includes('race-a'), 'stale pre-rewrite external MCP runtime survived metadata race');
await closeExternalMcpRuntime();
console.log('isolated external MCP routing: PASS');
`, 'utf8');

    const childResult = await runChild(childScript, {
      HOME: isolated,
      USERPROFILE: isolated,
      DESKTOP_COMMANDER_MCP_CONFIG: configPath,
      DC_FAKE_SERVER: fakeServer,
      DC_SERENA_ROOT: isolated,
      DC_CALL_STARTED_FILE: path.join(isolated, 'call-started.txt'),
      DC_DISCONNECT_ONCE_FILE: path.join(isolated, 'disconnect-once.txt'),
      DC_LIST_TOOLS_FILE: path.join(isolated, 'list-tools.txt'),
      DC_LIST_CHANGE_DURING_LIST_FILE: path.join(isolated, 'list-change-during-list.txt'),
      MCPORTER_STDIO_PROBE_TIMEOUT_MS: '1000',
    }, 45000);
    assert(childResult.stdout.includes('isolated external MCP routing: PASS'));
  } finally {
    await fs.rm(isolated, { recursive: true, force: true });
  }

  await runServerPassthroughProbe(root);

  console.log('MCP routing regressions: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
