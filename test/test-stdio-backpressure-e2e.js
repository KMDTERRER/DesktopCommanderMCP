import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FilteredStdioServerTransport } from '../dist/custom-stdio.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-stdio-backpressure-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-stdio-backpressure-home-'));
const configDir = path.join(home, '.claude-server-commander');
await fs.mkdir(configDir, { recursive: true });
await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
  telemetryEnabled: false, allowedDirectories: [root],
  welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false,
}), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result) => (result?.content ?? []).map((item) => item?.text ?? '').join('\n');
const within = (promise, ms, label) => Promise.race([
  promise,
  sleep(ms).then(() => { throw new Error(`${label} timed out after ${ms}ms`); }),
]);

const fixtures = Array.from({ length: 8 }, (_, index) => ({
  path: path.join(root, index === 0 ? 'команда-utf8-0.txt' : `payload-${index}.txt`),
  marker: index === 0 ? 'STDIO_BP_0_Привет_' : `STDIO_BP_${index}_`,
}));
for (const fixture of fixtures) {
  await fs.writeFile(fixture.path, `${fixture.marker}${'x'.repeat(256 * 1024)}\n`, 'utf8');
}

const previousTrace = process.env.DC_MCP_STDIO_TRACE;
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;
let syntheticTrace = '';
try {
  process.env.DC_MCP_STDIO_TRACE = 'true';
  process.stdout.write = () => false;
  process.stderr.write = (chunk, encoding, callback) => {
    syntheticTrace += String(chunk);
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };
  const syntheticTransport = new FilteredStdioServerTransport();
  const send = syntheticTransport.send({ jsonrpc: '2.0', id: 'synthetic-bp', result: {} });
  setTimeout(() => process.stdout.emit('drain'), 20);
  await within(send, 1_000, 'synthetic stdout drain');
  syntheticTransport.cleanup();
  assert.match(syntheticTrace, /\[MCP-STDIO\] WRITE .*backpressure=true/);
  assert.match(syntheticTrace, /\[MCP-STDIO\] DRAIN .*id=synthetic-bp/);
} finally {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  if (previousTrace === undefined) delete process.env.DC_MCP_STDIO_TRACE;
  else process.env.DC_MCP_STDIO_TRACE = previousTrace;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, 'dist', 'index.js'), '--no-onboarding'],
  cwd: repoRoot,
  stderr: 'pipe',
  env: {
    HOME: home, USERPROFILE: home,
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
    DC_REMOTE_DEVICE: 'true',
    DC_MCP_STDIO_TRACE: 'true',
  },
});
const client = new Client({ name: 'stdio-backpressure-e2e', version: '1.0.0' });
let stderr = '';
transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  await within(client.connect(transport), 10_000, 'MCP initialize');
  const child = transport._process;
  assert(child?.stdout, 'stdio client did not expose child stdout');
  child.stdout.pause();

  let settled = 0;
  const reads = fixtures.map((fixture) => client.callTool({
    name: 'read_file', arguments: { path: fixture.path, offset: 0, length: 2 },
  }, undefined, { timeout: 15_000, maxTotalTimeout: 15_000 }).finally(() => { settled += 1; }));
  const processCall = client.callTool({
    name: 'write_file',
    arguments: {
      path: 'mcp://desktop-core/start_process?timeout_ms=15000',
      content: JSON.stringify({
        command: `"${process.execPath}" -e "process.stdout.write('STDIO_BP_PROCESS_OK')"`,
        timeout_ms: 5_000,
      }),
      mode: 'rewrite',
    },
  }, undefined, { timeout: 15_000, maxTotalTimeout: 15_000 }).finally(() => { settled += 1; });

  await sleep(500);
  assert.equal(settled, 0, 'paused child stdout unexpectedly delivered MCP responses');
  child.stdout.resume();

  const results = await within(Promise.all([...reads, processCall]), 12_000, 'backpressured MCP responses');
  for (let index = 0; index < fixtures.length; index += 1) {
    assert.match(textOf(results[index]), new RegExp(fixtures[index].marker));
  }
  assert.match(textOf(results.at(-1)), /STDIO_BP_PROCESS_OK/);

  const followup = await within(client.callTool({
    name: 'get_config', arguments: {},
  }, undefined, { timeout: 5_000, maxTotalTimeout: 5_000 }), 6_000, 'post-backpressure follow-up');
  assert.match(textOf(followup), /allowedDirectories/);
  await sleep(50);
  assert.match(stderr, /\[MCP-STDIO\] HANDLER_START .*tool=read_file/, 'missing handler-start transport trace');
  assert.match(stderr, /\[MCP-STDIO\] HANDLER_DONE .*tool=read_file/, 'missing handler-done transport trace');
  assert.match(stderr, /\[MCP-STDIO\] WRITE .*kind=response/, 'missing response-write transport trace');
  console.log('stdio backpressure e2e: PASS');
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  await client.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
}
