#!/usr/bin/env node
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../dist/utils/process-tree.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const serverEntrypoint = process.env.DC_E2E_SERVER
  ? path.resolve(process.env.DC_E2E_SERVER)
  : path.join(repoRoot, 'dist', 'index.js');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function textOf(result) {
  return (result?.content ?? []).map((item) => item?.type === 'text' ? item.text ?? '' : '').join('\n');
}

class JsonLineMcpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
    child.on('exit', (code, signal) => {
      if (this.pending.size === 0) return;
      const error = new Error(
        `MCP server exited while requests were pending (code=${code}, signal=${signal}): ${this.stderr.slice(-3000)}`
      );
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
    });
  }

  onStdout(chunk) {
    this.buffer += chunk.toString();
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined) continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  }

  request(method, params, timeoutMs = 15_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms; stderr=${this.stderr.slice(-3000)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async tool(name, args, timeoutMs = 15_000) {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (result?.isError) throw new Error(textOf(result));
    return result;
  }
}

async function compatCall(client, uri, downstreamArgs, timeoutMs = 15_000) {
  return client.tool('write_file', { path: uri, content: JSON.stringify(downstreamArgs), mode: 'rewrite' }, timeoutMs);
}

async function compatReadCall(client, uri, downstreamArgs, timeoutMs = 15_000) {
  return client.tool('read_file', { path: uri, options: downstreamArgs }, timeoutMs);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-mcp-e2e-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-mcp-e2e-home-'));
  const configDir = path.join(home, '.claude-server-commander');
  const sourceDir = path.join(root, 'src');
  const sourceFile = path.join(sourceDir, 'sample.ts');
  const cppSourceFile = path.join(sourceDir, 'sample.cpp');
  const verifyScript = path.join(root, 'verify.mjs');
  const buildDir = path.join(root, 'build');
  const cmakeToolDir = path.join(home, 'cmake-tools');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(buildDir, { recursive: true });
  await fs.mkdir(cmakeToolDir, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(sourceFile, 'export const targetValue = "before";\n', 'utf8');
  await fs.writeFile(cppSourceFile, 'int sample(){ return 1; }\n', 'utf8');
  await fs.writeFile(verifyScript, "import fs from 'node:fs';\nconst text=fs.readFileSync(process.argv[2],'utf8');\nconsole.log(text.includes('after')?'E2E_OK':'E2E_BAD');\n", 'utf8');
  const cmakeExecutable = path.join(cmakeToolDir, process.platform === 'win32' ? 'cmake.exe' : 'cmake').replace(/\\/g, '/');
  const ctestExecutable = path.join(cmakeToolDir, process.platform === 'win32' ? 'ctest.exe' : 'ctest').replace(/\\/g, '/');
  await fs.writeFile(cmakeExecutable, '', 'utf8');
  await fs.writeFile(ctestExecutable, '', 'utf8');
  await fs.writeFile(path.join(buildDir, 'CMakeCache.txt'), [
    `CMAKE_COMMAND:INTERNAL=${cmakeExecutable}`,
    `CMAKE_CTEST_COMMAND:INTERNAL=${ctestExecutable}`,
    `CMAKE_MAKE_PROGRAM:FILEPATH=${cmakeExecutable}`,
    'CMAKE_GENERATOR:INTERNAL=Ninja',
    `CMAKE_HOME_DIRECTORY:INTERNAL=${root.replace(/\\/g, '/')}`,
    '',
  ].join('\n'), 'utf8');
  git(root, 'init');
  git(root, 'config', 'user.email', 'mcp-e2e@example.invalid');
  git(root, 'config', 'user.name', 'MCP E2E');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ telemetryEnabled: false, allowedDirectories: [root] }), 'utf8');
  await fs.writeFile(path.join(configDir, 'feature-flags.json'), JSON.stringify({ version: 'e2e', flags: { onboarding_injection: false } }), 'utf8');

  const child = spawn(process.execPath, [serverEntrypoint], {
    detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, USERPROFILE: home, DC_FLAG_URL: 'http://127.0.0.1:9/' },
  });
  const client = new JsonLineMcpClient(child);
  let searchSessionId;
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'desktop-commander-pre-release-e2e', version: '1.0.0' },
    });
    client.notify('notifications/initialized');

    // Warm the Windows process owner so the correlation check measures response
    // routing rather than first-use helper compilation.
    await client.tool('start_process', {
      executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root,
      execution_kind: 'finite', pty: 'never', timeout_ms: 5000,
    }, 10000);
    let slowResolvedAt = 0;
    let fastResolvedAt = 0;
    const slowResponse = client.tool('start_process', {
      executable: process.execPath, args: ['-e', 'setTimeout(() => process.exit(7), 400)'], cwd: root,
      execution_kind: 'finite', pty: 'never', timeout_ms: 2000,
    }, 10000).then((result) => { slowResolvedAt = Date.now(); return result; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const fastResponse = client.tool('start_process', {
      executable: process.execPath, args: ['-e', 'process.exit(3)'], cwd: root,
      execution_kind: 'finite', pty: 'never', timeout_ms: 2000,
    }, 10000).then((result) => { fastResolvedAt = Date.now(); return result; });
    const [slowResult, fastResult] = await Promise.all([slowResponse, fastResponse]);
    assert.equal(slowResult.structuredContent?.exitCode, 7, JSON.stringify(slowResult.structuredContent));
    assert.equal(fastResult.structuredContent?.exitCode, 3, JSON.stringify(fastResult.structuredContent));
    assert(fastResolvedAt > 0 && slowResolvedAt > fastResolvedAt,
      `JSON-RPC responses did not complete out of order as expected: fast=${fastResolvedAt} slow=${slowResolvedAt}`);

    const retrievalStartedAt = Date.now();
    const searchStarted = await client.tool('start_search', {
      path: root, pattern: 'targetValue', searchType: 'content', literalSearch: true,
      maxResults: 20, contextLines: 0, timeout_ms: 5000,
    });
    const searchResolvedAt = Date.now();
    const readAfterSearch = await client.tool('read_file', { path: sourceFile, offset: 0, length: 20 }, 5000);
    const readResolvedAt = Date.now();
    const writeAfterRead = await client.tool('write_file', {
      path: sourceFile, content: 'export const targetValue = \"before\";\n', mode: 'rewrite',
    }, 5000);
    const writeResolvedAt = Date.now();
    assert(searchResolvedAt - retrievalStartedAt < 1500,
      `start_search response was held after local completion: ${searchResolvedAt - retrievalStartedAt}ms`);
    assert(readResolvedAt - searchResolvedAt < 1500,
      `read_file response was held after preceding start_search: ${readResolvedAt - searchResolvedAt}ms`);
    assert(writeResolvedAt - readResolvedAt < 1500,
      `write_file response was held after preceding read_file: ${writeResolvedAt - readResolvedAt}ms`);
    assert(textOf(readAfterSearch).includes('targetValue'), `read_file missed fixture after start_search: ${textOf(readAfterSearch)}`);
    assert(textOf(writeAfterRead).includes('Successfully'), `write_file did not return success promptly: ${textOf(writeAfterRead)}`);
    assert.equal(await fs.readFile(sourceFile, 'utf8'), 'export const targetValue = \"before\";\n');
    const searchMatch = textOf(searchStarted).match(/session:\s*(search_[^\s]+)/);
    assert(searchMatch, `start_search did not publish a session id: ${textOf(searchStarted)}`);
    searchSessionId = searchMatch[1];
    let searchFinal;
    for (let attempt = 0; attempt < 100; attempt++) {
      searchFinal = await client.tool('get_more_search_results', { sessionId: searchSessionId, offset: 0, length: 20 }, 5000);
      if (textOf(searchFinal).includes('✅ Search completed.')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const searchText = textOf(searchFinal);
    assert(searchText.includes('✅ Search completed.'), `search did not complete: ${searchText}`);
    assert(searchText.includes('sample.ts') && searchText.includes('targetValue'), `search missed fixture: ${searchText}`);
    await client.tool('stop_search', { sessionId: searchSessionId }, 5000);
    searchSessionId = undefined;

    const snapshotResult = await compatReadCall(
      client, 'mcp://desktop-accelerators/workspace_snapshot?timeout_ms=5000',
      { root, includeDiffStat: true },
    );
    assert.equal(snapshotResult.content.length, 1, 'workspace_snapshot duplicated its result content blocks');
    assert.equal(snapshotResult.structuredContent, undefined, 'workspace_snapshot duplicated text as structuredContent');
    const snapshot = JSON.parse(textOf(snapshotResult));
    assert.equal(snapshot.dirty, false, JSON.stringify(snapshot));
    assert.equal(path.resolve(snapshot.repositoryRoot), path.resolve(root));
    await assert.rejects(
      () => compatReadCall(
        client, 'mcp://desktop-accelerators/edit_file?timeout_ms=5000',
        { path: sourceFile, edits: [{ oldText: 'before', newText: 'forbidden' }], dryRun: true },
      ),
      /not a trusted read-only tool/,
    );
    const coreSessions = await compatReadCall(
      client, 'mcp://desktop-core/list_sessions?timeout_ms=5000', {},
    );
    assert.match(textOf(coreSessions), /No active sessions|PID:/);
    await assert.rejects(
      () => compatReadCall(
        client, 'mcp://desktop-core/start_process?timeout_ms=12000',
        { executable: process.execPath, args: ['-e', 'process.exit(0)'], timeout_ms: 1000 },
      ),
      /not a trusted read-only core tool/,
    );
    assert((await fs.readFile(sourceFile, 'utf8')).includes('targetValue = "before"'));

    const rewriteSchema = JSON.parse(textOf(await compatReadCall(
      client, 'mcp://desktop-accelerators/ast_rewrite?timeout_ms=5000', undefined,
    )));
    assert.equal(rewriteSchema.tool.name, 'ast_rewrite');
    assert.equal(rewriteSchema.tool.mutating, true);
    await assert.rejects(
      () => compatReadCall(
        client, 'mcp://desktop-accelerators/ast_rewrite?timeout_ms=5000',
        { project_folder: sourceDir, pattern: 'export const targetValue = $A', rewrite: 'export let targetValue = $A', language: 'typescript', dry_run: true },
      ),
      /not a trusted read-only tool/,
    );
    const rewritePreview = JSON.parse(textOf(await compatCall(
      client, 'mcp://desktop-accelerators/ast_rewrite?timeout_ms=15000',
      { project_folder: sourceDir, pattern: 'export const targetValue = $A', rewrite: 'export let targetValue = $A', language: 'typescript', dry_run: true },
      20000,
    )));
    assert.equal(rewritePreview.changed, true, JSON.stringify(rewritePreview));
    assert.deepEqual(rewritePreview.changedFiles, ['src/sample.ts']);
    assert((await fs.readFile(sourceFile, 'utf8')).includes('export const targetValue'));
    const rewriteApplied = JSON.parse(textOf(await compatCall(
      client, 'mcp://desktop-accelerators/ast_rewrite?timeout_ms=20000',
      {
        project_folder: sourceDir, pattern: 'export const targetValue = $A', rewrite: 'export let targetValue = $A', language: 'typescript',
        dry_run: false, expected_preview_id: rewritePreview.previewId, expected_files: rewritePreview.applyExpectedFiles,
      },
      25000,
    )));
    assert.equal(rewriteApplied.applied, true, JSON.stringify(rewriteApplied));
    assert.equal(rewriteApplied.apply?.byteExact, true, JSON.stringify(rewriteApplied));
    assert.equal(rewriteApplied.patchPreview, undefined, 'apply response repeated patch preview');
    assert((await fs.readFile(sourceFile, 'utf8')).includes('export let targetValue = "before"'));

    const cppPlan = JSON.parse(textOf(await compatReadCall(
      client, 'mcp://desktop-accelerators/cpp_build_plan?timeout_ms=5000',
      { root, buildDir, operation: 'build', targets: ['sample'] },
    )));
    assert.equal(path.resolve(cppPlan.process.executable), path.resolve(cmakeExecutable), JSON.stringify(cppPlan));
    assert.deepEqual(cppPlan.process.args, ['--build', path.resolve(buildDir), '--target', 'sample']);
    assert.equal(cppPlan.process.execution_kind, 'finite');
    assert.equal(cppPlan.process.pty, 'never');

    const cppImpact = JSON.parse(textOf(await compatReadCall(
      client, 'mcp://desktop-accelerators/cpp_build_impact?timeout_ms=5000',
      { root, buildDir, changedFiles: ['src/sample.cpp'], includeTests: false },
    )));
    assert.equal(cppImpact.recommendFullBuild, true, JSON.stringify(cppImpact));
    assert(cppImpact.incompleteness.includes('cmake_target_model_unavailable'), JSON.stringify(cppImpact));
    assert(cppImpact.unmappedChangedFiles.includes('src/sample.cpp'), JSON.stringify(cppImpact));

    const cppContext = JSON.parse(textOf(await compatReadCall(
      client, 'mcp://desktop-accelerators/cpp_build_context?timeout_ms=5000',
      { root, buildDir, changedFiles: ['src/sample.cpp'], includeTests: false, includeProfile: false, operation: 'build' },
    )));
    assert.equal(cppContext.orchestration.metadataSnapshots, 1, JSON.stringify(cppContext));
    assert.equal(cppContext.orchestration.planSelection, 'default-operation', JSON.stringify(cppContext));
    assert.equal(cppContext.impact.recommendFullBuild, true, JSON.stringify(cppContext));
    assert.deepEqual(cppContext.plan.process.args, ['--build', path.resolve(buildDir)]);

    const packed = JSON.parse(textOf(await compatReadCall(
      client, 'mcp://desktop-accelerators/context_pack?timeout_ms=5000',
      { root, query: 'targetValue before', maxFiles: 4, contextLines: 1, maxLinesPerFile: 20, maxTotalChars: 10000 },
    )));
    assert(packed.files.some((file) => file.path.replace(/\\/g, '/').endsWith('src/sample.ts')),
      `context_pack missed source file: ${JSON.stringify(packed.files)}`);
    assert.equal(typeof packed.workspaceCursor, 'string', 'context_pack did not return a reusable workspace cursor');

    const codeContextSchema = JSON.parse(textOf(await compatReadCall(
      client, 'mcp://desktop-context/code_context?timeout_ms=5000', undefined,
    )));
    assert.equal(codeContextSchema.tool.name, 'code_context');
    assert.equal(codeContextSchema.tool.readOnly, true);
    const codeContext = JSON.parse(textOf(await compatReadCall(
      client, 'mcp://desktop-context/code_context?timeout_ms=5000',
      { root, query: 'targetValue before', maxFiles: 4, contextLines: 1, maxLinesPerFile: 20, maxTotalChars: 10000 },
    )));
    assert.equal(codeContext.graph, null, JSON.stringify(codeContext));
    assert.equal(codeContext.semantic, null, JSON.stringify(codeContext));
    assert.equal(codeContext.orchestration.contextPackCalls, 1, JSON.stringify(codeContext));
    assert(codeContext.contextPack.files.some((file) => file.path.replace(/\\/g, '/').endsWith('src/sample.ts')), JSON.stringify(codeContext));

    const ranged = JSON.parse(textOf(await compatReadCall(
      client, 'mcp://desktop-accelerators/read_ranges?timeout_ms=5000',
      { requests: [{ path: sourceFile, offset: 0, length: 5 }], maxTotalChars: 10000 },
    )));
    const firstRange = ranged.results?.[0];
    assert(firstRange?.content?.includes('targetValue = \"before\"'), JSON.stringify(ranged));
    assert.equal(typeof firstRange.hash, 'string', JSON.stringify(ranged));
    const suppressed = JSON.parse(textOf(await compatReadCall(
      client, 'mcp://desktop-accelerators/read_ranges?timeout_ms=5000',
      { requests: [{ path: sourceFile, offset: 0, length: 5, knownHash: firstRange.hash }], maxTotalChars: 10000 },
    )));
    assert.equal(suppressed.results?.[0]?.unchanged, true, JSON.stringify(suppressed));

    const edited = JSON.parse(textOf(await compatCall(
      client, 'mcp://desktop-accelerators/edit_file?timeout_ms=5000',
      { path: sourceFile, edits: [{ oldText: 'targetValue = "before"', newText: 'targetValue = "after"' }], dryRun: false },
    )));
    assert.equal(edited.changed, true, JSON.stringify(edited));
    assert((await fs.readFile(sourceFile, 'utf8')).includes('targetValue = "after"'));

    const delta = JSON.parse(textOf(await compatCall(
      client, 'mcp://desktop-accelerators/workspace_delta?timeout_ms=5000',
      { root, cursor: packed.workspaceCursor },
    )));
    assert.equal(delta.freshInstance, false, JSON.stringify(delta));
    assert(delta.changedFiles.includes('src/sample.ts'), JSON.stringify(delta));

    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(verifyScript)} ${JSON.stringify(sourceFile)}`;
    const started = await compatCall(
      client, 'mcp://desktop-core/start_process?timeout_ms=15000',
      { command, timeout_ms: 5000 },
    );
    const startedText = textOf(started);
    const pidMatch = startedText.match(/PID\s+(\d+)/i);
    assert(pidMatch, `start_process did not publish a PID: ${startedText}`);
    const pid = Number(pidMatch[1]);

    const waited = JSON.parse(textOf(await compatReadCall(
      client, 'mcp://desktop-accelerators/wait_process?timeout_ms=15000',
      { pid, timeout_ms: 5000, stall_timeout_ms: 0, tail_lines: 20 },
    )));
    assert.equal(waited.completed, true, JSON.stringify(waited));
    assert.equal(waited.processSucceeded, true, JSON.stringify(waited));
    assert(String(waited.tail ?? '').includes('E2E_OK'), JSON.stringify(waited));

    const finalSnapshot = JSON.parse(textOf(await compatReadCall(
      client, 'mcp://desktop-accelerators/workspace_snapshot?timeout_ms=5000',
      { root, includeDiffStat: false },
    )));
    assert(finalSnapshot.changedFiles.includes('src/sample.ts'), JSON.stringify(finalSnapshot));
    console.log('MCP accelerator stdio E2E: PASS');
  } finally {
    if (searchSessionId) {
      await client.tool('stop_search', { sessionId: searchSessionId }, 5000).catch(() => undefined);
    }
    try { child.stdin.end(); } catch {}
    await terminateProcessTree(child, 3000, true).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
