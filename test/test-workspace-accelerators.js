#!/usr/bin/env node
import assert from 'assert';
import crypto from 'crypto';
import { inflateRawSync } from 'node:zlib';
import fs from 'fs/promises';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

import {
  BUILTIN_SERVER_ID,
  callBuiltinAcceleratorTool,
  listBuiltinAcceleratorTools,
} from '../dist/tools/workspace-accelerators.js';
import {
  callExternalMcpCompatUri,
  listExternalMcpTools,
  parseExternalMcpCompatUri,
  readExternalMcpCompatUri,
} from '../dist/tools/external-mcp.js';
import { normalizeMcpArgumentsObject } from '../dist/utils/mcp-arguments.js';
import { callBuildMetadataAcceleratorTool, discoverConfiguredCmakeTrees, revalidateBuildMetadataSnapshot } from '../dist/tools/build-metadata-accelerator.js';
import { callCppBuildPlanAcceleratorTool } from '../dist/tools/cpp-build-plan-accelerator.js';
import { callCppBuildExecuteAcceleratorTool, normalizeCppBuildDiagnostics } from '../dist/tools/cpp-build-execute-accelerator.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { readProcessOutput } from '../dist/tools/improved-process-tools.js';
import { TextFileHandler } from '../dist/utils/files/text.js';
import { findWindowsFileLockers } from '../dist/utils/windows-file-locks.js';
import {
  BUILTIN_CORE_SERVER_ID,
  CORE_MCP_EXCLUDED_TOOLS,
  assertCoreMcpCoverage,
  listBuiltinCoreTools,
} from '../dist/tools/core-mcp.js';
import { StartProcessArgsSchema, ReadProcessOutputArgsSchema, InteractWithProcessArgsSchema, McpCallToolArgsSchema, toolArgSchemas } from '../dist/tools/schemas.js';
import { PROCESS_TRANSPORT_RESERVE_MS, PROCESS_TRANSPORT_TIMEOUT_MAX_MS, PROCESS_WAIT_DEFAULT_MS, PROCESS_WAIT_MAX_MS } from '../dist/utils/process-wait-contract.js';
import { acquireMutationResourceLease, acquireResourceLease } from '../dist/utils/resource-lease-owner.js';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function hashText(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectReject(action, contains) {
  let message = '';
  try {
    await action();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes(contains), `Expected rejection containing '${contains}', got '${message}'`);
}

function parseTextResult(result) {
  assert.equal(result.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

async function main() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-dc-accelerators-'));
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'accelerator-test@example.invalid');
    git(root, 'config', 'user.name', 'Accelerator Test');
    git(root, 'config', 'core.autocrlf', 'false');

    const aPath = path.join(root, 'a.txt');
    const bPath = path.join(root, 'b.txt');
    await fs.writeFile(aPath, 'alpha\nbeta\n', 'utf8');
    git(root, 'add', 'a.txt');
    git(root, 'commit', '-m', 'baseline');

    const catalog = listBuiltinAcceleratorTools();
    assert.equal(BUILTIN_SERVER_ID, 'desktop-accelerators');
    assert.deepEqual(
      catalog.map((tool) => tool.name).sort(),
      ['apply_patch', 'ast_rewrite', 'ast_rule_search', 'ast_search', 'build_metadata', 'context_pack', 'cpp_build_context', 'cpp_build_execute', 'cpp_build_impact', 'cpp_build_plan', 'cpp_build_result', 'cpp_toolchain_profile', 'edit_file', 'read_ranges', 'safe_fix', 'wait_process', 'workspace_delta', 'workspace_snapshot'],
    );
    const patchMetadata = listBuiltinAcceleratorTools('apply_patch');
    assert.equal(patchMetadata.mutating, true);
    assert.equal(patchMetadata.preferredFrozenSurface, 'write_file');
    assert.equal(patchMetadata.inputSchema.type, 'object');
    const snapshotMetadata = listBuiltinAcceleratorTools('workspace_snapshot');
    assert.equal(snapshotMetadata.readOnly, true);
    assert.equal(snapshotMetadata.preferredFrozenSurface, 'read_file');
    const buildResultMetadata = listBuiltinAcceleratorTools('cpp_build_result');
    assert.equal(buildResultMetadata.readOnly, true);
    assert.equal(buildResultMetadata.mutating, false);
    assert.equal(buildResultMetadata.preferredFrozenSurface, 'read_file');
    const buildExecuteMetadata = listBuiltinAcceleratorTools('cpp_build_execute');
    assert.deepEqual(buildExecuteMetadata.inputSchema.properties.executionMode.enum, ['auto', 'inline', 'resumable']);

    assert.equal(StartProcessArgsSchema.safeParse({ command: 'echo ok', timeout_ms: PROCESS_WAIT_MAX_MS }).success, true);
    assert.equal(StartProcessArgsSchema.safeParse({ command: 'echo ok', timeout_ms: PROCESS_WAIT_MAX_MS + 1 }).success, false);
    assert.equal(ReadProcessOutputArgsSchema.safeParse({ pid: 1, timeout_ms: PROCESS_WAIT_MAX_MS + 1 }).success, false);
    assert.equal(ReadProcessOutputArgsSchema.safeParse({ pid: 1, reader_id: 'chat-a' }).success, true);
    assert.equal(ReadProcessOutputArgsSchema.safeParse({ pid: 1, reader_id: 'x'.repeat(129) }).success, false);
    assert.equal(InteractWithProcessArgsSchema.safeParse({ pid: 1, input: 'x', timeout_ms: PROCESS_WAIT_MAX_MS + 1 }).success, false);
    assert.equal(McpCallToolArgsSchema.safeParse({ server: 'x', tool: 'y', timeout_ms: PROCESS_TRANSPORT_TIMEOUT_MAX_MS }).success, true);
    assert.equal(McpCallToolArgsSchema.safeParse({ server: 'x', tool: 'y', timeout_ms: PROCESS_TRANSPORT_TIMEOUT_MAX_MS + 1 }).success, false);
    assert.equal(McpCallToolArgsSchema.parse({ server: 'x', tool: 'y' }).timeout_ms, undefined);
    assert.deepEqual(normalizeMcpArgumentsObject(undefined), {});
    assert.deepEqual(normalizeMcpArgumentsObject({ relative_path: 'x.cpp' }), { relative_path: 'x.cpp' });
    assert.throws(() => normalizeMcpArgumentsObject([]), /must be a JSON object/);
    assert.throws(() => normalizeMcpArgumentsObject('relative_path=x.cpp'), /must be a JSON object/);
    assert.deepEqual(
      parseExternalMcpCompatUri('mcp://serena-ai-agent/get_symbols_overview?timeout_ms=45000'),
      { server: 'serena-ai-agent', tool: 'get_symbols_overview', timeout_ms: 45000 },
    );
    assert.deepEqual(
      parseExternalMcpCompatUri(`mcp://desktop-core/start_process?timeout_ms=${PROCESS_TRANSPORT_TIMEOUT_MAX_MS}`),
      { server: 'desktop-core', tool: 'start_process', timeout_ms: PROCESS_TRANSPORT_TIMEOUT_MAX_MS },
    );
    assert.throws(
      () => parseExternalMcpCompatUri(`mcp://server/tool?timeout_ms=${PROCESS_TRANSPORT_TIMEOUT_MAX_MS + 1}`),
      new RegExp(`must be an integer from 100 to ${PROCESS_TRANSPORT_TIMEOUT_MAX_MS}ms`),
    );
    assert.throws(
      () => parseExternalMcpCompatUri('mcp://server/tool?unknown=1'),
      /Unsupported MCP compatibility URI query keys/,
    );

    const bridgeList = parseTextResult(await listExternalMcpTools({}));
    assert(bridgeList.servers.includes(BUILTIN_SERVER_ID));
    assert(bridgeList.servers.includes(BUILTIN_CORE_SERVER_ID));
    assert(bridgeList.routing_guidance.includes('workspace_delta'));
    assert(bridgeList.routing_guidance.includes('context_pack'));
    assert(bridgeList.routing_guidance.includes('build_metadata'));
    assert(bridgeList.routing_guidance.includes('cpp_build_plan'));
    assert(bridgeList.routing_guidance.includes('safe_fix'));
    assert(bridgeList.routing_guidance.includes('ast_rewrite'));
    const acceleratorList = parseTextResult(await listExternalMcpTools({ server: BUILTIN_SERVER_ID }));
    const acceleratorSchema = parseTextResult(await listExternalMcpTools({
      server: BUILTIN_SERVER_ID, tool: 'workspace_snapshot',
    }));
    assert.equal(acceleratorList.routing_guidance, undefined, 'server list repeated root routing guidance');
    assert.equal(acceleratorSchema.routing_guidance, undefined, 'tool schema repeated root routing guidance');
    assert.doesNotThrow(() => assertCoreMcpCoverage());
    assert.deepEqual(
      listBuiltinCoreTools().map((tool) => tool.name).sort(),
      Object.keys(toolArgSchemas).filter((name) => !CORE_MCP_EXCLUDED_TOOLS.has(name)).sort(),
    );
    const frozenCompatSchema = parseTextResult(await readExternalMcpCompatUri(
      'mcp://desktop-core/read_process_output',
    ));
    assert(frozenCompatSchema.tool.inputSchema.properties.stall_timeout_ms);
    const bridgeTool = parseTextResult(await listExternalMcpTools({
      server: BUILTIN_SERVER_ID,
      tool: 'workspace_snapshot',
    }));
    assert.equal(bridgeTool.tool.name, 'workspace_snapshot');
    assert(bridgeTool.tool.inputSchema.properties.root);
    const compatTool = parseTextResult(await readExternalMcpCompatUri(
      'mcp://desktop-accelerators/edit_file',
    ));
    assert.equal(compatTool.tool.name, 'edit_file');
    const compatAstTool = parseTextResult(await readExternalMcpCompatUri(
      'mcp://desktop-accelerators/ast_search',
    ));
    assert.equal(compatAstTool.tool.name, 'ast_search');
    assert(compatAstTool.tool.inputSchema.properties.pattern);
    assert(compatAstTool.tool.inputSchema.properties.language);
    const compatReadRangesTool = parseTextResult(await readExternalMcpCompatUri(
      'mcp://desktop-accelerators/read_ranges',
    ));
    assert.equal(compatReadRangesTool.tool.name, 'read_ranges');
    assert(compatReadRangesTool.tool.inputSchema.properties.requests);
    const compatDeltaTool = parseTextResult(await readExternalMcpCompatUri(
      'mcp://desktop-accelerators/workspace_delta',
    ));
    assert.equal(compatDeltaTool.tool.name, 'workspace_delta');
    assert(compatDeltaTool.tool.inputSchema.properties.cursor);
    const compatContextPackTool = parseTextResult(await readExternalMcpCompatUri(
      'mcp://desktop-accelerators/context_pack',
    ));
    assert.equal(compatContextPackTool.tool.name, 'context_pack');
    assert(compatContextPackTool.tool.inputSchema.properties.query);
    assert(compatContextPackTool.tool.inputSchema.properties.seedFiles);
    const compatSafeFixTool = parseTextResult(await readExternalMcpCompatUri(
      'mcp://desktop-accelerators/safe_fix',
    ));
    assert.equal(compatSafeFixTool.tool.name, 'safe_fix');
    assert.equal(compatSafeFixTool.tool.readOnly, true);
    assert(compatSafeFixTool.tool.inputSchema.properties.files);

    const searchPath = path.join(root, 'search.ts');
    await fs.writeFile(
      searchPath,
      'function one(){ console.log("x"); }\nfunction two(){ console.log("y"); }\n',
      'utf8',
    );
    const previousAstGrepBin = process.env.AST_GREP_BIN;
    const stalledAstGrepBin = path.join(root, 'stalled-ast-grep-bin');
    const originalAstStat = fs.stat;
    process.env.AST_GREP_BIN = stalledAstGrepBin;
    fs.stat = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(stalledAstGrepBin)) return new Promise(() => {});
      return originalAstStat(...args);
    };
    try {
      const astPreflightOutcome = await Promise.race([
        callBuiltinAcceleratorTool('ast_search', {
          project_folder: root, pattern: 'console.log($A)', language: 'TypeScript', timeout_ms: 300,
        }, 300).then(() => ({ kind: 'resolved' }), (error) => ({ kind: 'rejected', error })),
        new Promise((resolve) => setTimeout(() => resolve({ kind: 'hung' }), 800)),
      ]);
      assert.notEqual(astPreflightOutcome.kind, 'hung', 'ast-grep executable preflight ignored the accelerator deadline');
      assert.equal(astPreflightOutcome.kind, 'rejected', 'stalled ast-grep executable preflight unexpectedly resolved');
    } finally {
      fs.stat = originalAstStat;
      if (previousAstGrepBin === undefined) delete process.env.AST_GREP_BIN; else process.env.AST_GREP_BIN = previousAstGrepBin;
    }

    let astAvailable = true;
    try {
      const astSearch = await callBuiltinAcceleratorTool('ast_search', {
        project_folder: root,
        pattern: 'console.log($A)',
        language: 'TypeScript',
        max_results: 1,
        output_format: 'text',
        timeout_ms: 5000,
      });
      assert.equal(astSearch.returnedMatches, 1);
      assert.equal(astSearch.limitReached, true);
      assert(astSearch.text.includes('search.ts'));

      const astRule = await callBuiltinAcceleratorTool('ast_rule_search', {
        project_folder: root,
        yaml: [
          'id: find-console',
          'language: TypeScript',
          'rule:',
          '  pattern: console.log($A)',
        ].join('\n'),
        max_results: 5,
        output_format: 'json',
        timeout_ms: 5000,
      });
      assert.equal(astRule.returnedMatches, 2);
      assert.equal(astRule.matches.length, 2);
      assert(astRule.matches.every((match) => match.file === 'search.ts'));
    } catch (error) {
      if (String(error).includes('ast-grep executable not found')) {
        astAvailable = false;
        console.log('ast-grep accelerator smoke: SKIP (optional CLI not installed)');
      } else {
        throw error;
      }
    }
    if (astAvailable) console.log('ast-grep accelerator smoke: PASS');

    const renameRoot = path.join(root, 'rename-repo');
    await fs.mkdir(renameRoot);
    git(renameRoot, 'init');
    git(renameRoot, 'config', 'user.email', 'rename-test@example.invalid');
    git(renameRoot, 'config', 'user.name', 'Rename Test');
    await fs.writeFile(path.join(renameRoot, 'old.txt'), 'rename me\n', 'utf8');
    git(renameRoot, 'add', 'old.txt');
    git(renameRoot, 'commit', '-m', 'baseline');
    git(renameRoot, 'mv', 'old.txt', 'new.txt');
    const renameSnapshot = await callBuiltinAcceleratorTool('workspace_snapshot', {
      root: renameRoot, includeDiffStat: false,
    });
    assert.deepEqual(renameSnapshot.changedFiles, ['new.txt', 'old.txt']);
    await fs.rm(renameRoot, { recursive: true, force: true });

    await fs.writeFile(aPath, 'alpha\nbeta dirty\n', 'utf8');
    await fs.writeFile(bPath, 'new\n', 'utf8');
    const snapshot = await callBuiltinAcceleratorTool('workspace_snapshot', { root });
    assert.equal(snapshot.dirty, true);
    assert(snapshot.changedFiles.includes('a.txt'));
    assert(snapshot.changedFiles.includes('b.txt'));
    assert.equal(snapshot.diffCheck.ok, true);
    const compatSnapshot = parseTextResult(await callExternalMcpCompatUri(
      'mcp://desktop-accelerators/workspace_snapshot',
      JSON.stringify({ arguments: { root, includeDiffStat: false }, timeout_ms: 5000 }),
    ));
    assert.equal(compatSnapshot.dirty, true);
    assert(compatSnapshot.changedFiles.includes('a.txt'));

    // Frozen clients may send the discovered downstream schema directly as the
    // write_file content instead of wrapping it in { arguments: ... }. That
    // flat form must be forwarded verbatim, never silently replaced with {}.
    const flatCompatSnapshot = parseTextResult(await callExternalMcpCompatUri(
      'mcp://desktop-accelerators/workspace_snapshot',
      JSON.stringify({ root, includeDiffStat: false }),
    ));
    assert.equal(flatCompatSnapshot.dirty, true);
    assert(flatCompatSnapshot.changedFiles.includes('a.txt'));

    const readCompatSnapshot = parseTextResult(await readExternalMcpCompatUri(
      'mcp://desktop-accelerators/workspace_snapshot?timeout_ms=5000',
      { root, includeDiffStat: false },
    ));
    assert.equal(readCompatSnapshot.dirty, true);
    assert(readCompatSnapshot.changedFiles.includes('a.txt'));
    await assert.rejects(
      () => readExternalMcpCompatUri(
        'mcp://desktop-accelerators/edit_file?timeout_ms=5000',
        { path: aPath, edits: [{ oldText: 'alpha', newText: 'omega' }], dryRun: true },
      ),
      /not a trusted read-only tool/,
    );
    const coreSessions = await readExternalMcpCompatUri(
      'mcp://desktop-core/list_sessions?timeout_ms=5000', {},
    );
    assert.equal(coreSessions.isError, undefined);
    assert.match(coreSessions.content?.[0]?.text ?? '', /No active sessions|PID:/);
    await assert.rejects(
      () => readExternalMcpCompatUri(
        'mcp://desktop-core/start_process?timeout_ms=12000',
        { executable: process.execPath, args: ['-e', 'process.exit(0)'], timeout_ms: 1000 },
      ),
      /not a trusted read-only core tool/,
    );

    const rangeAPath = path.join(root, 'range-a.txt');
    const rangeBPath = path.join(root, 'range-b.txt');
    await fs.writeFile(rangeAPath, 'zero\none\ntwo\nthree\n', 'utf8');
    await fs.writeFile(rangeBPath, 'red\r\ngreen\r\nblue\r\n', 'utf8');
    const batchRanges = await callBuiltinAcceleratorTool('read_ranges', {
      requests: [
        { path: rangeAPath, offset: 1, length: 2 },
        { path: rangeBPath, offset: 0, length: 2 },
        { path: rangeAPath, offset: 3, length: 1 },
      ],
      maxTotalChars: 1000,
    });
    assert.equal(batchRanges.uniqueFiles, 2);
    assert.equal(batchRanges.results.length, 3);
    assert.equal(batchRanges.results[0].content, 'one\ntwo\n');
    assert.equal(batchRanges.results[1].content, 'red\r\ngreen\r\n');
    assert.equal(batchRanges.results[2].content, 'three\n');
    assert.equal(batchRanges.results[0].unchanged, false);
    const rangeAHash = batchRanges.results[0].hash;

    const unchangedRange = await callBuiltinAcceleratorTool('read_ranges', {
      requests: [{ path: rangeAPath, offset: 0, length: 1, knownHash: rangeAHash }],
    });
    assert.equal(unchangedRange.results[0].unchanged, true);
    assert.equal('content' in unchangedRange.results[0], false);
    assert.equal(unchangedRange.returnedChars, 0);

    await fs.writeFile(rangeAPath, 'zero\nONE\ntwo\nthree\n', 'utf8');
    const changedRange = await callBuiltinAcceleratorTool('read_ranges', {
      requests: [{ path: rangeAPath, offset: 1, length: 1, knownHash: rangeAHash }],
    });
    assert.equal(changedRange.results[0].unchanged, false);
    assert.equal(changedRange.results[0].content, 'ONE\n');
    assert.notEqual(changedRange.results[0].hash, rangeAHash);

    const growthRangePath = path.join(root, 'range-growth.txt');
    await fs.writeFile(growthRangePath, 'small\n', 'utf8');
    const originalGrowthStat = fs.stat;
    let growthStatCalls = 0;
    let injectedGrowth = false;
    fs.stat = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(growthRangePath)) {
        growthStatCalls += 1;
        const beforeGrowth = await originalGrowthStat(...args);
        if (!injectedGrowth && growthStatCalls >= 2) {
          injectedGrowth = true;
          await fs.writeFile(growthRangePath, 'small\n' + 'x'.repeat(17 * 1024 * 1024), 'utf8');
        }
        return beforeGrowth;
      }
      return originalGrowthStat(...args);
    };
    try {
      await assert.rejects(
        () => callBuiltinAcceleratorTool('read_ranges', {
          requests: [{ path: growthRangePath, offset: 0, length: 1 }],
          maxTotalChars: 1000,
        }, 5000),
        /read_ranges file exceeds/,
      );
      assert.equal(injectedGrowth, true, 'read_ranges growth fixture did not trigger');
    } finally {
      fs.stat = originalGrowthStat;
      await fs.rm(growthRangePath, { force: true });
    }

    const stalledStatPath = path.join(root, 'range-stalled-stat.txt');
    await fs.writeFile(stalledStatPath, 'stat\n', 'utf8');
    const originalStat = fs.stat;
    let targetStatCalls = 0;
    fs.stat = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(stalledStatPath)) {
        targetStatCalls += 1;
        if (targetStatCalls >= 2) return new Promise(() => {});
      }
      return originalStat(...args);
    };
    try {
      const statOutcome = await Promise.race([
        callBuiltinAcceleratorTool('read_ranges', { requests: [{ path: stalledStatPath, offset: 0, length: 1 }] }, 300)
          .then(() => ({ kind: 'resolved' }), (error) => ({ kind: 'rejected', error })),
        new Promise((resolve) => setTimeout(() => resolve({ kind: 'hung' }), 800)),
      ]);
      assert.notEqual(statOutcome.kind, 'hung', 'read_ranges preflight fs.stat remained unbounded');
      assert.equal(statOutcome.kind, 'rejected', 'stalled read_ranges stat unexpectedly resolved');
      assert(targetStatCalls >= 2, `read_ranges stat fixture did not reach preflight stat: ${targetStatCalls}`);
    } finally {
      fs.stat = originalStat;
    }
    const recoveredRangeStartedAt = Date.now();
    const recoveredRange = await callBuiltinAcceleratorTool('read_ranges', {
      requests: [{ path: stalledStatPath, offset: 0, length: 1 }],
      maxTotalChars: 100,
    }, 1000);
    assert.equal(recoveredRange.results[0].content, 'stat\n');
    assert(Date.now() - recoveredRangeStartedAt < 800, 'read_ranges retained blocked shared state after a timed-out stat');
    await fs.rm(stalledStatPath, { force: true });

    const compatRanges = parseTextResult(await callExternalMcpCompatUri(
      'mcp://desktop-accelerators/read_ranges',
      JSON.stringify({ requests: [{ path: rangeBPath, offset: 2, length: 1 }], maxTotalChars: 100 }),
    ));
    assert.equal(compatRanges.results[0].content, 'blue\r\n');

    const deltaRoot = path.join(root, 'delta-repo');
    await fs.mkdir(deltaRoot);
    git(deltaRoot, 'init');
    git(deltaRoot, 'config', 'user.email', 'delta-test@example.invalid');
    git(deltaRoot, 'config', 'user.name', 'Delta Test');
    git(deltaRoot, 'config', 'core.autocrlf', 'false');
    await fs.mkdir(path.join(deltaRoot, 'src'));
    await fs.writeFile(path.join(deltaRoot, 'src', 'alpha.ts'), 'export function alphaHandler(){ return 1; }\n', 'utf8');
    await fs.writeFile(path.join(deltaRoot, 'src', 'beta.ts'), 'export function betaWorker(){ return 2; }\n', 'utf8');
    await fs.writeFile(path.join(deltaRoot, 'src', 'gamma.ts'), 'export function gammaAdapter(){ return 3; }\n', 'utf8');
    git(deltaRoot, 'add', '.');
    git(deltaRoot, 'commit', '-m', 'baseline');

    const initialDelta = await callBuiltinAcceleratorTool('workspace_delta', { root: deltaRoot });
    assert.equal(initialDelta.freshInstance, true);
    assert.equal(initialDelta.complete, false);
    assert.equal(typeof initialDelta.cursor, 'string');
    assert.deepEqual(initialDelta.changedFiles, []);

    await fs.writeFile(path.join(deltaRoot, 'src', 'beta.ts'), 'export function betaWorker(){ return alphaHandler(); }\n', 'utf8');
    const changedDelta = await callBuiltinAcceleratorTool('workspace_delta', {
      root: deltaRoot, cursor: initialDelta.cursor,
    });
    assert.equal(changedDelta.freshInstance, false);
    assert.equal(changedDelta.complete, true);
    assert.deepEqual(changedDelta.changedFiles, ['src/beta.ts']);
    assert.deepEqual(changedDelta.dirtyDelta.added, ['src/beta.ts']);

    const deltaGrowthPath = path.join(deltaRoot, 'src', 'growth.ts');
    await fs.writeFile(deltaGrowthPath, 'export const growth = 1;\n', 'utf8');
    const originalDeltaReadFile = fs.readFile;
    let unboundedDeltaRead = false;
    fs.readFile = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(deltaGrowthPath)) {
        unboundedDeltaRead = true;
        throw new Error('UNBOUNDED_WORKSPACE_DELTA_READ');
      }
      return originalDeltaReadFile(...args);
    };
    try {
      const boundedDelta = await callBuiltinAcceleratorTool('workspace_delta', { root: deltaRoot, cursor: changedDelta.cursor });
      assert(boundedDelta.changedFiles.includes('src/growth.ts'));
      assert.equal(unboundedDeltaRead, false, 'workspace_delta still used unbounded fs.readFile for a bounded dirty file');
    } finally {
      fs.readFile = originalDeltaReadFile;
      await fs.rm(deltaGrowthPath, { force: true });
    }

    const noChangeDelta = await callBuiltinAcceleratorTool('workspace_delta', {
      root: deltaRoot, cursor: changedDelta.cursor,
    });
    assert.deepEqual(noChangeDelta.changedFiles, []);
    await assert.rejects(
      () => callBuiltinAcceleratorTool('workspace_delta', { root: deltaRoot, cursor: 'not-a-cursor' }),
      /Invalid workspace_delta cursor/,
    );
    assert.match(noChangeDelta.cursor, /^z1\./, 'workspace_delta should emit compact self-contained cursors');
    const encodedCursor = noChangeDelta.cursor.startsWith('z1.')
      ? inflateRawSync(Buffer.from(noChangeDelta.cursor.slice(3), 'base64url')).toString('utf8')
      : Buffer.from(noChangeDelta.cursor, 'base64url').toString('utf8');
    const forgedPayload = JSON.parse(encodedCursor);
    forgedPayload.dirty['../escape.txt'] = { exists: false, kind: 'missing' };
    const forgedCursor = Buffer.from(JSON.stringify(forgedPayload), 'utf8').toString('base64url');
    await assert.rejects(
      () => callBuiltinAcceleratorTool('workspace_delta', { root: deltaRoot, cursor: forgedCursor }),
      /Invalid workspace_delta cursor/,
    );

    // The shared workspace owner promises thousands of dirty paths. Its decoded
    // exact-state representation may therefore exceed the old 512 KiB raw cap,
    // while the compressed self-contained transport must remain bounded.
    const cursorCapacityDir = path.join(deltaRoot, 'cursor-capacity');
    await fs.mkdir(cursorCapacityDir, { recursive: true });
    const cursorCapacityFiles = 1900;
    for (let start = 0; start < cursorCapacityFiles; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, cursorCapacityFiles - start) }, (_, offset) => {
        const index = start + offset;
        const name = `file-${String(index).padStart(4, '0')}-${'x'.repeat(120)}.txt`;
        return fs.writeFile(path.join(cursorCapacityDir, name), `cursor-capacity-${index}\n`, 'utf8');
      }));
    }
    const largeDelta = await callBuiltinAcceleratorTool('workspace_delta', {
      root: deltaRoot, cursor: noChangeDelta.cursor,
    });
    assert.equal(largeDelta.changedFiles.length, cursorCapacityFiles);
    assert.match(largeDelta.cursor, /^z1\./);
    const largeCursorJson = inflateRawSync(Buffer.from(largeDelta.cursor.slice(3), 'base64url'));
    assert(largeCursorJson.length > 512 * 1024, `cursor capacity fixture did not exceed legacy raw cap: ${largeCursorJson.length}`);
    assert(Buffer.byteLength(largeDelta.cursor, 'utf8') < 1024 * 1024, 'compressed workspace cursor exceeded transport bound');
    const stableLargeDelta = await callBuiltinAcceleratorTool('workspace_delta', {
      root: deltaRoot, cursor: largeDelta.cursor,
    });
    assert.deepEqual(stableLargeDelta.changedFiles, []);
    await fs.rm(cursorCapacityDir, { recursive: true, force: true });

    git(deltaRoot, 'add', 'src/beta.ts');
    git(deltaRoot, 'commit', '-m', 'commit beta change');
    const committedDelta = await callBuiltinAcceleratorTool('workspace_delta', {
      root: deltaRoot, cursor: noChangeDelta.cursor,
    });
    assert.equal(committedDelta.headChanged, true);
    assert.deepEqual(committedDelta.changedFiles, ['src/beta.ts']);

    const foreignDelta = await callBuiltinAcceleratorTool('workspace_delta', {
      root, cursor: committedDelta.cursor,
    });
    assert.equal(foreignDelta.freshInstance, true);
    assert.equal(foreignDelta.reason, 'cursor_repository_mismatch');

    await fs.writeFile(
      path.join(deltaRoot, 'package-lock.json'),
      JSON.stringify({ noise: Array.from({ length: 40 }, () => 'alphaHandler betaWorker').join(' ') }),
      'utf8',
    );
    const initialPack = await callBuiltinAcceleratorTool('context_pack', {
      root: deltaRoot,
      query: 'alphaHandler implementation and beta worker usage',
      maxFiles: 2,
      contextLines: 1,
      maxLinesPerFile: 20,
      maxTotalChars: 4000,
    });
    assert.equal(initialPack.files.length, 2);
    assert(initialPack.files.some((file) => file.path === 'src/alpha.ts'));
    assert(initialPack.files.some((file) => file.path === 'src/beta.ts'));
    assert(!initialPack.files.some((file) => file.path === 'package-lock.json'));
    assert(initialPack.files.some((file) => file.content.includes('alphaHandler')));
    assert.equal(typeof initialPack.workspaceCursor, 'string');
    assert(initialPack.queryTerms.includes('alphahandler'));

    const seededPack = await callBuiltinAcceleratorTool('context_pack', {
      root: deltaRoot,
      query: 'unrelated semantic candidate',
      seedFiles: ['src/gamma.ts'],
      maxFiles: 1,
      maxLinesPerFile: 10,
      maxTotalChars: 1000,
    });
    assert.equal(seededPack.files[0].path, 'src/gamma.ts');
    assert(seededPack.files[0].reasons.includes('seed_file'));
    await assert.rejects(
      () => callBuiltinAcceleratorTool('context_pack', {
        root: deltaRoot, query: 'escape', seedFiles: ['../escape.ts'],
      }),
      /seedFiles/,
    );

    await fs.writeFile(path.join(deltaRoot, 'src', 'alpha.ts'), 'export function alphaHandler(){ return 42; }\n', 'utf8');
    const deltaPack = await callBuiltinAcceleratorTool('context_pack', {
      root: deltaRoot,
      query: 'alphaHandler',
      workspaceCursor: initialPack.workspaceCursor,
      maxFiles: 1,
      contextLines: 0,
      maxLinesPerFile: 10,
      maxTotalChars: 2000,
    });
    assert.deepEqual(deltaPack.workspaceDelta.changedFiles, ['src/alpha.ts']);
    assert.equal(deltaPack.files[0].path, 'src/alpha.ts');
    assert(deltaPack.files[0].reasons.includes('workspace_delta'));

    // Ranking may consume the full scoped delta, but response metadata must stay
    // bounded so a dirty workspace cannot dominate the MCP transport payload.
    const bulkChanged = path.join(deltaRoot, 'bulk-changed');
    await fs.mkdir(bulkChanged, { recursive: true });
    await Promise.all(Array.from({ length: 125 }, (_, index) =>
      fs.writeFile(path.join(bulkChanged, `file-${String(index).padStart(3, '0')}.txt`), `delta-${index}\n`, 'utf8')));
    const cappedDeltaPack = await callBuiltinAcceleratorTool('context_pack', {
      root: deltaRoot, query: 'alphaHandler', workspaceCursor: initialPack.workspaceCursor,
      maxFiles: 1, contextLines: 0, maxLinesPerFile: 10, maxTotalChars: 2000,
    });
    assert(cappedDeltaPack.workspaceDelta.changedFileCount >= 126, JSON.stringify(cappedDeltaPack.workspaceDelta));
    assert.equal(cappedDeltaPack.workspaceDelta.changedFiles.length, 25);
    assert.equal(cappedDeltaPack.workspaceDelta.changedFilesTruncated, true);
    assert(cappedDeltaPack.workspaceDelta.workingTreeChangedFileCount >= 126);
    assert.equal(cappedDeltaPack.workspaceDelta.workingTreeChangedFiles.length, 25);
    assert.equal(cappedDeltaPack.workspaceDelta.workingTreeChangedFilesTruncated, true);

    // A subproject context pack must not serialize the parent repository's dirty
    // state or transient runtime artifacts into its cursor/ranking metadata.
    const scopedContextRoot = path.join(deltaRoot, 'scoped-context');
    await fs.mkdir(path.join(scopedContextRoot, 'src'), { recursive: true });
    await fs.mkdir(path.join(scopedContextRoot, '.tmp-trace'), { recursive: true });
    await fs.mkdir(path.join(scopedContextRoot, '.workspace-state', 'state'), { recursive: true });
    await fs.mkdir(path.join(scopedContextRoot, 'build-debug', 'CMakeFiles'), { recursive: true });
    await fs.writeFile(path.join(scopedContextRoot, 'src', 'main.ts'), 'export const scopedNeedle = 1;\n', 'utf8');
    await fs.writeFile(path.join(scopedContextRoot, '.tmp-trace', 'trace.txt'), 'scopedNeedle runtime trace\n', 'utf8');
    await fs.writeFile(path.join(scopedContextRoot, '.workspace-state', 'state', 'runtime.lock'), 'scopedNeedle\n', 'utf8');
    await fs.writeFile(path.join(scopedContextRoot, 'build-debug', 'CMakeFiles', 'generated.txt'), 'scopedNeedle\n', 'utf8');

    const scopedPack = await callBuiltinAcceleratorTool('context_pack', {
      root: scopedContextRoot, query: 'scopedNeedle implementation',
      maxFiles: 2, contextLines: 0, maxLinesPerFile: 10, maxTotalChars: 1000,
    });
    assert.deepEqual(scopedPack.workspaceDelta.changedFiles, ['scoped-context/src/main.ts']);
    assert(scopedPack.files.some((file) => file.path === 'scoped-context/src/main.ts'));
    assert(!scopedPack.files.some((file) =>
      file.path.includes('.tmp-trace') || file.path.includes('.workspace-state') || file.path.includes('/build-debug/')
    ));
    const scopedCursorJson = inflateRawSync(Buffer.from(scopedPack.workspaceCursor.slice(3), 'base64url')).toString('utf8');
    assert.deepEqual(Object.keys(JSON.parse(scopedCursorJson).dirty), ['scoped-context/src/main.ts']);
    assert(JSON.stringify(scopedPack).length < 8000, `scoped context response remained oversized: ${JSON.stringify(scopedPack).length}`);

    await fs.writeFile(path.join(scopedContextRoot, 'src', 'main.ts'), 'export const scopedNeedle = 2;\n', 'utf8');
    const scopedDeltaPack = await callBuiltinAcceleratorTool('context_pack', {
      root: scopedContextRoot, query: 'scopedNeedle', workspaceCursor: scopedPack.workspaceCursor,
      maxFiles: 1, contextLines: 0, maxLinesPerFile: 10, maxTotalChars: 1000,
    });
    assert.deepEqual(scopedDeltaPack.workspaceDelta.changedFiles, ['scoped-context/src/main.ts']);

    const explicitTransientPack = await callBuiltinAcceleratorTool('context_pack', {
      root: scopedContextRoot, query: 'runtime trace', seedFiles: ['.tmp-trace/trace.txt'],
      maxFiles: 1, contextLines: 0, maxLinesPerFile: 10, maxTotalChars: 1000,
    });
    assert.equal(explicitTransientPack.files[0].path, 'scoped-context/.tmp-trace/trace.txt');
    assert(explicitTransientPack.files[0].reasons.includes('seed_file'));

    await fs.rm(deltaRoot, { recursive: true, force: true });

    const buildMetaRoot = path.join(root, 'build-meta-repo');
    const buildMetaDir = path.join(buildMetaRoot, 'build');
    const replyDir = path.join(buildMetaDir, '.cmake', 'api', 'v1', 'reply');
    const syntheticCmakeBin = path.join(root, 'build-meta-host-tools');
    await fs.mkdir(path.join(buildMetaRoot, 'src'), { recursive: true });
    await fs.mkdir(path.join(buildMetaRoot, 'include'), { recursive: true });
    await fs.mkdir(replyDir, { recursive: true });
    const syntheticToolchainBin = path.join(buildMetaRoot, 'toolchain', 'bin');
    const syntheticQtRoot = path.join(buildMetaRoot, 'qt');
    const syntheticQtBin = path.join(syntheticQtRoot, 'bin');
    const syntheticQtPlugins = path.join(syntheticQtRoot, 'plugins');
    const syntheticQtDir = path.join(syntheticQtRoot, 'lib', 'cmake', 'Qt6');
    await fs.mkdir(syntheticCmakeBin, { recursive: true });
    await fs.mkdir(syntheticToolchainBin, { recursive: true });
    await fs.mkdir(syntheticQtBin, { recursive: true });
    await fs.mkdir(syntheticQtPlugins, { recursive: true });
    await fs.mkdir(syntheticQtDir, { recursive: true });
    git(buildMetaRoot, 'init');
    git(buildMetaRoot, 'config', 'user.email', 'build-meta@example.invalid');
    git(buildMetaRoot, 'config', 'user.name', 'Build Metadata Test');
    await fs.writeFile(path.join(buildMetaRoot, 'src', 'main.cpp'), 'int main(){ return 0; }\n', 'utf8');
    await fs.writeFile(path.join(buildMetaRoot, 'src', 'alt.cpp'), 'int alt(){ return 1; }\n', 'utf8');
    await fs.writeFile(path.join(buildMetaRoot, 'src', 'future.cpp'), 'int future(){ return 23; }\n', 'utf8');
    git(buildMetaRoot, 'add', 'src');
    git(buildMetaRoot, 'commit', '-m', 'sources');
    const compileDbPath = path.join(buildMetaDir, 'compile_commands.json');
    const compileDbSource = JSON.stringify([
      {
        directory: buildMetaDir,
        file: '../src/main.cpp',
        arguments: ['clang++', '-I../include', '-DVALUE=1', '-std=c++20', '--target=x86_64-pc-windows-msvc', '-c', '../src/main.cpp'],
        output: 'main.obj',
      },
      { directory: 'build', file: '../src/alt.cpp', command: 'clang++ -std=c++17 -c ../src/alt.cpp', output: 'alt.obj' },
      { directory: buildMetaDir, file: '../src/future.cpp', arguments: ['clang++', '-std=c++23', '-c', '../src/future.cpp'], output: 'future.obj' },
    ]);
    await fs.writeFile(compileDbPath, compileDbSource, 'utf8');
    const cmakeExecutable = path.join(syntheticCmakeBin, process.platform === 'win32' ? 'cmake.exe' : 'cmake').replace(/\\/g, '/');
    const ctestExecutable = path.join(syntheticCmakeBin, process.platform === 'win32' ? 'ctest.exe' : 'ctest').replace(/\\/g, '/');
    await fs.writeFile(cmakeExecutable, '', 'utf8');
    await fs.writeFile(ctestExecutable, '', 'utf8');
    await fs.writeFile(path.join(buildMetaDir, 'CMakeCache.txt'), [
      `CMAKE_COMMAND:INTERNAL=${cmakeExecutable}`,
      `CMAKE_CTEST_COMMAND:INTERNAL=${ctestExecutable}`,
      `CMAKE_MAKE_PROGRAM:FILEPATH=${cmakeExecutable}`,
      `CMAKE_CXX_COMPILER:FILEPATH=${path.join(syntheticToolchainBin, process.platform === 'win32' ? 'c++.exe' : 'c++')}`,
      `CMAKE_TOOLCHAIN_FILE:FILEPATH=${path.join(buildMetaRoot, 'cmake', 'toolchain.cmake')}`,
      `CMAKE_PREFIX_PATH:PATH=${syntheticQtRoot}`,
      `Qt6_DIR:PATH=${syntheticQtDir}`,
      'CMAKE_GENERATOR:INTERNAL=Ninja',
      `CMAKE_HOME_DIRECTORY:INTERNAL=${buildMetaRoot.replace(/\\/g, '/')}`,
      'CMAKE_BUILD_TYPE:STRING=Debug',
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(replyDir, 'index-2026-08-15T000000.json'), JSON.stringify({
      cmake: { generator: { name: 'Ninja', multiConfig: false } },
      objects: [
        { kind: 'codemodel', version: { major: 2, minor: 8 }, jsonFile: 'codemodel-v2.json' },
        { kind: 'cmakeFiles', version: { major: 1, minor: 1 }, jsonFile: 'cmakeFiles-v1.json' },
        { kind: 'toolchains', version: { major: 1, minor: 1 }, jsonFile: 'toolchains-v1.json' },
      ],
    }), 'utf8');
    await fs.writeFile(path.join(replyDir, 'cmakeFiles-v1.json'), JSON.stringify({
      kind: 'cmakeFiles', version: { major: 1, minor: 1 },
      paths: { source: buildMetaRoot.replace(/\\/g, '/'), build: buildMetaDir.replace(/\\/g, '/') },
      inputs: [
        { path: 'CMakeLists.txt' },
        { path: 'cmake/options.cmake' },
        { path: path.join(buildMetaDir, 'CMakeFiles', 'generated.cmake').replace(/\\/g, '/'), isGenerated: true },
      ],
      globsDependent: [{ expression: 'src/*.cpp', recurse: false, files: ['src/main.cpp', 'src/alt.cpp'] }],
    }), 'utf8');
    await fs.writeFile(path.join(replyDir, 'toolchains-v1.json'), JSON.stringify({
      kind: 'toolchains', version: { major: 1, minor: 1 },
      toolchains: [{
        language: 'CXX', sourceFileExtensions: ['cpp', 'cxx'],
        compiler: {
          path: path.join(syntheticToolchainBin, process.platform === 'win32' ? 'clang++.exe' : 'clang++').replace(/\\/g, '/'),
          id: 'Clang', version: '22.0.0', target: 'x86_64-pc-windows-msvc',
          implicit: { includeDirectories: [path.join(buildMetaRoot, 'include')], linkDirectories: [syntheticToolchainBin], linkFrameworkDirectories: [], linkLibraries: ['c++'] },
        },
      }],
    }), 'utf8');
    await fs.writeFile(path.join(replyDir, 'codemodel-v2.json'), JSON.stringify({
      kind: 'codemodel',
      version: { major: 2, minor: 8 },
      paths: { source: buildMetaRoot.replace(/\\/g, '/'), build: buildMetaDir.replace(/\\/g, '/') },
      configurations: [{
        name: 'Debug',
        targets: [{ name: 'sample', id: 'sample::@1', directoryIndex: 0, projectIndex: 0, jsonFile: 'target-sample.json' }],
      }],
    }), 'utf8');
    await fs.writeFile(path.join(replyDir, 'target-sample.json'), JSON.stringify({
      name: 'sample', id: 'sample::@1', type: 'EXECUTABLE',
      paths: { source: '.', build: '.' },
      sources: [{ path: 'src/main.cpp', compileGroupIndex: 0 }],
      artifacts: [{ path: 'sample.exe' }],
      dependencies: [{ id: 'support::@1' }],
      compileGroups: [{ language: 'CXX', compileCommandFragments: [{ fragment: '-Wall' }], defines: [{ define: 'VALUE=1' }], includes: [{ path: '../include', isSystem: false }] }],
    }), 'utf8');

    const buildMetaSchema = parseTextResult(await readExternalMcpCompatUri('mcp://desktop-accelerators/build_metadata'));
    assert.equal(buildMetaSchema.tool.name, 'build_metadata');
    assert(buildMetaSchema.tool.inputSchema.properties.buildDir);
    const buildMeta = await callBuiltinAcceleratorTool('build_metadata', {
      root: buildMetaRoot,
      buildDir: buildMetaDir,
      files: ['src/main.cpp'],
      includeArguments: true,
      maxTargets: 1,
    });
    assert.equal(buildMeta.compileDatabase.totalEntries, 3);
    assert.equal(buildMeta.compileDatabase.standardCounts['-std=c++20'], 1);
    assert.equal(buildMeta.compileDatabase.standardCounts['-std=c++17'], 1);
    assert.equal(buildMeta.compileDatabase.standardCounts['-std=c++23'], 1);
    assert.equal(buildMeta.compileDatabase.relativeDirectoryEntries, 1);
    assert.equal(buildMeta.compileDatabase.matchedEntries.length, 1);
    assert.equal(buildMeta.compileDatabase.matchedEntries[0].file, 'src/main.cpp');
    assert.equal(buildMeta.compileDatabase.matchedEntries[0].compiler, 'clang++');
    assert(buildMeta.compileDatabase.matchedEntries[0].semanticFlags.standards.includes('-std=c++20'));
    assert(buildMeta.compileDatabase.matchedEntries[0].semanticFlags.includes.includes('../include'));
    assert(buildMeta.compileDatabase.matchedEntries[0].semanticFlags.defines.includes('VALUE=1'));
    assert.equal(buildMeta.cmake.generator.name, 'Ninja');
    assert(buildMeta.cmake.availableObjectKinds.some((item) => item.kind === 'cmakeFiles' && item.major === 1));
    assert(buildMeta.cmake.availableObjectKinds.some((item) => item.kind === 'toolchains' && item.major === 1));
    assert.equal(buildMeta.cmake.cmakeFiles.found, true);
    assert(buildMeta.cmake.cmakeFiles.inputs.some((item) => item.path === 'CMakeLists.txt' && path.resolve(item.absolutePath) === path.resolve(buildMetaRoot, 'CMakeLists.txt')));
    assert(buildMeta.cmake.cmakeFiles.inputs.some((item) => item.isGenerated === true));
    assert.equal(buildMeta.cmake.cmakeFiles.globsDependent[0].expression, 'src/*.cpp');
    assert.deepEqual(buildMeta.cmake.cmakeFiles.globsDependent[0].paths, ['src/main.cpp', 'src/alt.cpp']);
    assert.equal(buildMeta.cmake.toolchains.found, true);
    assert.equal(buildMeta.cmake.toolchains.toolchains[0].language, 'CXX');
    assert.equal(buildMeta.cmake.toolchains.toolchains[0].compiler.id, 'Clang');
    assert.equal(buildMeta.cmake.toolchains.toolchains[0].compiler.version, '22.0.0');
    assert.equal(buildMeta.cmake.toolchains.toolchains[0].compiler.target, 'x86_64-pc-windows-msvc');
    assert.equal(buildMeta.cmake.configurations[0].name, 'Debug');
    assert.equal(path.resolve(buildMeta.cmake.codemodel.paths.source), path.resolve(buildMetaRoot));
    assert.equal(path.resolve(buildMeta.cmake.codemodel.paths.build), path.resolve(buildMetaDir));
    assert.equal(buildMeta.cmake.targets[0].name, 'sample');
    assert.equal(buildMeta.cmake.targets[0].type, 'EXECUTABLE');
    assert(buildMeta.cmake.targets[0].sources.includes('src/main.cpp'));
    assert(buildMeta.cmake.targets[0].artifacts.includes('sample.exe'));
    assert.equal(buildMeta.cmake.targets[0].paths.source, '.');
    assert.equal(buildMeta.cmake.targetsTruncated, false);
    assert.equal(buildMeta.cmakeCache.found, true);
    assert.equal(buildMeta.cmakeCache.values.CMAKE_COMMAND, cmakeExecutable);
    assert.equal(buildMeta.cmakeCache.values.CMAKE_GENERATOR, 'Ninja');
    const discoveredBuildMeta = await callBuiltinAcceleratorTool('build_metadata', {
      root: buildMetaRoot, files: ['src/main.cpp'], maxTargets: 1,
    });
    assert.equal(discoveredBuildMeta.buildDirDiscovered, true);
    assert.equal(path.resolve(discoveredBuildMeta.buildDir), path.resolve(buildMetaDir));

    // A size preflight followed by fs.readFile is not a real byte bound: the
    // file can grow after stat and the whole grown file is allocated before the
    // post-read size check. build_metadata must use a bounded reader instead.
    const originalBuildMetaReadFile = fs.readFile;
    let unboundedCompileDbRead = false;
    fs.readFile = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(compileDbPath)) {
        unboundedCompileDbRead = true;
        throw new Error('UNBOUNDED_BUILD_METADATA_READ');
      }
      return originalBuildMetaReadFile(...args);
    };
    try {
      const boundedBuildMeta = await callBuiltinAcceleratorTool('build_metadata', {
        root: buildMetaRoot, buildDir: buildMetaDir, files: ['src/main.cpp'], maxTargets: 1,
      });
      assert.equal(boundedBuildMeta.compileDatabase.totalEntries, 3);
      assert.equal(unboundedCompileDbRead, false, 'build_metadata still used unbounded fs.readFile for compile_commands.json');
    } finally {
      fs.readFile = originalBuildMetaReadFile;
    }

    await assert.rejects(
      () => callBuiltinAcceleratorTool('build_metadata', {
        root: buildMetaRoot, buildDir: buildMetaDir, files: ['../escape.cpp'],
      }),
      /files/,
    );
    await assert.rejects(
      () => callBuiltinAcceleratorTool('build_metadata', {
        root: buildMetaRoot, buildDir: path.join(buildMetaDir, 'compile_commands.json'),
      }),
      /directory/,
    );

    const buildPlanSchema = parseTextResult(await readExternalMcpCompatUri('mcp://desktop-accelerators/cpp_build_plan'));
    assert.equal(buildPlanSchema.tool.name, 'cpp_build_plan');
    assert.equal(buildPlanSchema.tool.readOnly, true);
    const buildPlan = await callBuiltinAcceleratorTool('cpp_build_plan', {
      root: buildMetaRoot, buildDir: buildMetaDir, operation: 'build', targets: ['sample'], configuration: 'Debug',
    });
    assert.equal(path.resolve(buildPlan.process.executable), path.resolve(cmakeExecutable));
    assert.deepEqual(buildPlan.process.args, ['--build', path.resolve(buildMetaDir), '--config', 'Debug', '--target', 'sample']);
    assert.equal(buildPlan.process.cwd, buildMetaRoot.replace(/\\/g, '/'));
    assert.equal(buildPlan.process.execution_kind, 'finite');
    assert.equal(buildPlan.process.pty, 'never');
    assert.equal(buildPlan.process.timeout_ms, PROCESS_WAIT_DEFAULT_MS);
    assert.equal(typeof buildPlan.process.env?.PATH, 'string');

    const cachePathForTrustTest = path.join(buildMetaDir, 'CMakeCache.txt');
    const trustedCacheSource = await fs.readFile(cachePathForTrustTest, 'utf8');
    const repoLocalCmake = path.join(buildMetaDir, process.platform === 'win32' ? 'cmake.exe' : 'cmake');
    await fs.writeFile(repoLocalCmake, '', 'utf8');
    await fs.writeFile(
      cachePathForTrustTest,
      trustedCacheSource.replace(`CMAKE_COMMAND:INTERNAL=${cmakeExecutable}`, `CMAKE_COMMAND:INTERNAL=${repoLocalCmake.replace(/\\/g, '/')}`),
      'utf8',
    );
    const projectLocalBuildPlan = await callBuiltinAcceleratorTool(
      'cpp_build_plan', { root: buildMetaRoot, buildDir: buildMetaDir, operation: 'build' },
    );
    assert.equal(path.resolve(projectLocalBuildPlan.process.executable), path.resolve(repoLocalCmake));
    await fs.writeFile(cachePathForTrustTest, trustedCacheSource, 'utf8');
    const buildPathEntries = buildPlan.process.env.PATH.split(path.delimiter).map((value) => path.resolve(value));
    assert(buildPathEntries.some((value) => value === path.resolve(syntheticToolchainBin)), JSON.stringify(buildPlan.evidence.environment));
    assert(buildPathEntries.some((value) => value === path.resolve(syntheticCmakeBin)), JSON.stringify(buildPlan.evidence.environment));
    assert(buildPathEntries.some((value) => value === path.resolve(syntheticQtBin)), JSON.stringify(buildPlan.evidence.environment));
    assert.equal(buildPlan.evidence.environment.source, 'cmake-cache');
    assert(buildPlan.profileFingerprint.startsWith('sha256:'));
    assert.equal(buildPlan.evidence.generator, 'Ninja');

    const testPlan = await callBuiltinAcceleratorTool('cpp_build_plan', {
      root: buildMetaRoot, buildDir: buildMetaDir, operation: 'test', configuration: 'Debug',
    });
    assert.equal(path.resolve(testPlan.process.executable), path.resolve(ctestExecutable));
    assert.deepEqual(testPlan.process.args, ['--test-dir', path.resolve(buildMetaDir), '-C', 'Debug']);
    assert.equal(testPlan.process.timeout_ms, PROCESS_WAIT_DEFAULT_MS);
    assert.equal(path.resolve(testPlan.process.env.QT_PLUGIN_PATH), path.resolve(syntheticQtPlugins));
    const focusedTestPlan = await callBuiltinAcceleratorTool('cpp_build_plan', {
      root: buildMetaRoot, buildDir: buildMetaDir, operation: 'test', configuration: 'Debug',
      tests: ['suite.alpha', 'suite[beta]'], parallelism: 3, outputOnFailure: true, noTestsError: true,
    });
    assert.deepEqual(focusedTestPlan.process.args, [
      '--test-dir', path.resolve(buildMetaDir), '-C', 'Debug',
      '--tests-regex', '^(suite\\.alpha|suite\\[beta\\])$', '--parallel', '3', '--output-on-failure', '--no-tests=error',
    ]);
    assert.deepEqual(focusedTestPlan.tests, ['suite.alpha', 'suite[beta]']);
    assert.equal(focusedTestPlan.parallelism, 3);
    assert.equal(focusedTestPlan.outputOnFailure, true);
    assert.equal(focusedTestPlan.noTestsError, true);
    await assert.rejects(
      () => callBuiltinAcceleratorTool('cpp_build_plan', { root: buildMetaRoot, buildDir: buildMetaDir, operation: 'test', targets: ['sample'] }),
      /targets is only valid/,
    );
    await assert.rejects(
      () => callBuiltinAcceleratorTool('cpp_build_plan', { root: buildMetaRoot, buildDir: buildMetaDir, preset: 'ci' }),
      /has no CMakePresets/,
    );
    const includedPresetDir = path.join(buildMetaRoot, 'cmake');
    const includedPresetPath = path.join(includedPresetDir, 'common-presets.json');
    await fs.mkdir(includedPresetDir, { recursive: true });
    await fs.writeFile(includedPresetPath, JSON.stringify({
      version: 4, buildPresets: [{ name: 'ci', configurePreset: 'base' }],
    }), 'utf8');
    const staticRootPreset = JSON.stringify({ version: 4, include: ['cmake/common-presets.json'] });
    await fs.writeFile(path.join(buildMetaRoot, 'CMakePresets.json'), staticRootPreset, 'utf8');
    const presetPlan = await callBuiltinAcceleratorTool('cpp_build_plan', {
      root: buildMetaRoot, buildDir: buildMetaDir, preset: 'ci', targets: ['sample'],
    });
    assert.deepEqual(presetPlan.process.args, ['--build', '--preset', 'ci', '--target', 'sample']);
    assert.equal(presetPlan.source, 'explicit-preset');
    assert.deepEqual(presetPlan.evidence.presetFiles.map((file) => file.name).sort(), [
      'CMakePresets.json', 'cmake/common-presets.json',
    ]);
    await fs.writeFile(path.join(buildMetaRoot, 'CMakePresets.json'), JSON.stringify({
      version: 7, include: ['$penv{DC_PRESET_FILE}'],
    }), 'utf8');
    await assert.rejects(
      () => callBuiltinAcceleratorTool('cpp_build_plan', { root: buildMetaRoot, buildDir: buildMetaDir, preset: 'ci' }),
      /CPP_PRESET_DYNAMIC_INCLUDE_UNSUPPORTED/,
    );
    await fs.writeFile(path.join(buildMetaRoot, 'CMakePresets.json'), staticRootPreset, 'utf8');

    const toolchainSchema = parseTextResult(await readExternalMcpCompatUri('mcp://desktop-accelerators/cpp_toolchain_profile'));
    assert.equal(toolchainSchema.tool.name, 'cpp_toolchain_profile');
    assert.equal(toolchainSchema.tool.readOnly, true);
    const toolchainProfile = await callBuiltinAcceleratorTool('cpp_toolchain_profile', { root: buildMetaRoot, buildDir: buildMetaDir });
    assert.equal(toolchainProfile.standardCounts['-std=c++20'], 1);
    assert.equal(toolchainProfile.standardCounts['-std=c++17'], 1);
    assert.equal(toolchainProfile.standardCounts['-std=c++23'], 1);
    assert.notEqual(toolchainProfile.capabilities.cxxModules.status, 'supported', 'C++23 syntax mode alone must not imply module capability');
    assert.notEqual(toolchainProfile.capabilities.importStd.status, 'supported', 'C++23 syntax mode alone must not imply import std capability');
    assert.equal(path.resolve(toolchainProfile.serenaHandoff.compilationDatabasePath), path.resolve(buildMetaDir));
    assert.deepEqual(toolchainProfile.serenaHandoff.runtimePathEntries, []);
    assert.equal(toolchainProfile.serenaHandoff.ready, false, 'unresolved synthetic clang++ must not be executed through PATH guessing');
    assert(toolchainProfile.profileFingerprint.startsWith('sha256:'));

    const impactSchema = parseTextResult(await readExternalMcpCompatUri('mcp://desktop-accelerators/cpp_build_impact'));
    assert.equal(impactSchema.tool.name, 'cpp_build_impact');
    assert.equal(impactSchema.tool.readOnly, true);
    const directImpact = await callBuiltinAcceleratorTool('cpp_build_impact', {
      root: buildMetaRoot, buildDir: buildMetaDir, changedFiles: ['src/main.cpp'], includeTests: false,
    });
    assert(directImpact.affectedTranslationUnits.values.includes('src/main.cpp'));
    assert.deepEqual(directImpact.affectedTargets, ['sample']);
    assert.equal(directImpact.recommendFullBuild, false);
    assert.equal(directImpact.selectionComplete, true);
    assert.deepEqual(directImpact.classifications, [
      { path: 'src/main.cpp', kind: 'source', evidence: 'C/C++ source/header/module extension' },
    ]);
    assert.equal(directImpact.requiresConfigure, false);

    const cmakeImpact = await callBuiltinAcceleratorTool('cpp_build_impact', {
      root: buildMetaRoot, buildDir: buildMetaDir, changedFiles: ['CMakeLists.txt'], includeTests: false,
    });
    assert.equal(cmakeImpact.classifications[0].kind, 'cmake_input');
    assert.equal(cmakeImpact.requiresConfigure, true);
    assert.deepEqual(cmakeImpact.configureInvalidatedBy, ['CMakeLists.txt']);
    assert.equal(cmakeImpact.recommendFullBuild, true);
    assert.equal(cmakeImpact.selectionComplete, false);

    const presetImpact = await callBuiltinAcceleratorTool('cpp_build_impact', {
      root: buildMetaRoot, buildDir: buildMetaDir, changedFiles: ['CMakePresets.json'], includeTests: false,
    });
    assert.equal(presetImpact.classifications[0].kind, 'preset');
    assert.equal(presetImpact.requiresConfigure, true);

    const toolchainImpact = await callBuiltinAcceleratorTool('cpp_build_impact', {
      root: buildMetaRoot, buildDir: buildMetaDir, changedFiles: ['cmake/toolchain.cmake'], includeTests: false,
    });
    assert.equal(toolchainImpact.classifications[0].kind, 'toolchain');
    assert.equal(toolchainImpact.requiresConfigure, true);

    const unknownImpact = await callBuiltinAcceleratorTool('cpp_build_impact', {
      root: buildMetaRoot, buildDir: buildMetaDir, changedFiles: ['dependency.lock'], includeTests: false,
    });
    assert.equal(unknownImpact.classifications[0].kind, 'unknown');
    assert.deepEqual(unknownImpact.unsupportedChangedFiles, ['dependency.lock']);
    assert.equal(unknownImpact.requiresConfigure, false);
    assert.equal(unknownImpact.recommendFullBuild, true);

    const contextSchema = parseTextResult(await readExternalMcpCompatUri('mcp://desktop-accelerators/cpp_build_context'));
    assert.equal(contextSchema.tool.name, 'cpp_build_context');
    assert.equal(contextSchema.tool.readOnly, true);
    const executeSchema = parseTextResult(await readExternalMcpCompatUri('mcp://desktop-accelerators/cpp_build_execute'));
    assert.equal(executeSchema.tool.name, 'cpp_build_execute');
    assert.equal(executeSchema.tool.readOnly, false);
    assert.equal(executeSchema.tool.mutating, true);
    assert.equal(executeSchema.tool.preferredFrozenSurface, 'write_file');
    assert.deepEqual(executeSchema.tool.inputSchema.required, ['root', 'operation']);
    assert.equal(executeSchema.tool.inputSchema.properties.configureMode.default, 'never');

    const configuredTrees = await discoverConfiguredCmakeTrees(buildMetaRoot, 5000);
    assert.equal(configuredTrees.trees.length, 1);
    assert.equal(path.resolve(configuredTrees.trees[0].buildDir), path.resolve(buildMetaDir));

    const foreignSourceRoot = path.join(root, 'foreign-cmake-source');
    const foreignBuildDir = path.join(buildMetaRoot, 'foreign-build');
    await fs.mkdir(foreignSourceRoot, { recursive: true });
    await fs.mkdir(foreignBuildDir, { recursive: true });
    await fs.writeFile(path.join(foreignBuildDir, 'CMakeCache.txt'), [
      `CMAKE_HOME_DIRECTORY:INTERNAL=${foreignSourceRoot.replace(/\\/g, '/')}`,
      'CMAKE_GENERATOR:INTERNAL=Ninja',
      '',
    ].join('\n'), 'utf8');
    const ownedTrees = await discoverConfiguredCmakeTrees(buildMetaRoot, 5000);
    assert.deepEqual(ownedTrees.trees.map((tree) => path.resolve(tree.buildDir)), [path.resolve(buildMetaDir)]);

    const nestedSourceRoot = path.join(buildMetaRoot, 'native');
    const nestedBuildDir = path.join(buildMetaRoot, 'nested-build');
    await fs.mkdir(nestedSourceRoot, { recursive: true });
    await fs.mkdir(nestedBuildDir, { recursive: true });
    await fs.writeFile(path.join(nestedBuildDir, 'CMakeCache.txt'), [
      `CMAKE_HOME_DIRECTORY:INTERNAL=${nestedSourceRoot.replace(/\\/g, '/')}`,
      'CMAKE_GENERATOR:INTERNAL=Ninja',
      '',
    ].join('\n'), 'utf8');
    const nestedMetadata = await callBuildMetadataAcceleratorTool({
      root: buildMetaRoot, buildDir: nestedBuildDir, maxEntries: 1, maxTargets: 1,
    }, 5000);
    assert.equal(nestedMetadata.cmakeCache.found, true);
    const nestedTrees = await discoverConfiguredCmakeTrees(buildMetaRoot, 5000);
    assert(nestedTrees.trees.some((tree) => path.resolve(tree.buildDir) === path.resolve(nestedBuildDir)));
    await fs.rm(nestedBuildDir, { recursive: true, force: true });
    await fs.rm(nestedSourceRoot, { recursive: true, force: true });

    let fakePid = 80000;
    const fakeExecuteDeps = {
      startProcess: async () => ({ structuredContent: { pid: fakePid++ }, content: [{ type: 'text', text: 'started' }] }),
      waitProcess: async () => ({ completed: true, timedOut: false, processSucceeded: true, exitCode: 0, runtimeMs: 5, tail: '' }),
      readProcessOutputPage: () => ({
        lines: [], totalLines: 0, readFrom: 0, readCount: 0, remaining: 0, isComplete: true, exitCode: 0,
      }),
      terminateProcess: async () => true,
      acquireMutationLocks: async () => async () => undefined,
      planBuildAccess: async (args) => {
        const targets = Array.isArray(args.targets) ? args.targets : [];
        const fingerprint = JSON.stringify([path.resolve(args.buildDir), targets, args.preset ?? null]);
        return {
          accessFingerprint: fingerprint, coverage: 'historical',
          readPaths: [], readRoots: [], writePaths: [], writeRoots: [path.resolve(args.buildDir)], watchRoots: [],
          incompleteness: [], warnings: [],
          leaseRequest: { kind: 'build', writeRoots: [path.resolve(args.buildDir)], coverage: 'historical' },
        };
      },
      acquireBuildAccessLease: async () => ({ release: async () => undefined }),
    };

    let staleBuildStarted = false;
    const staleNever = await callCppBuildExecuteAcceleratorTool({
      root: buildMetaRoot, buildDir: buildMetaDir, operation: 'build',
      changedFiles: ['CMakeLists.txt'], configureMode: 'never', timeoutMs: 5000,
    }, 5000, {
      ...fakeExecuteDeps,
      startProcess: async () => { staleBuildStarted = true; return { structuredContent: { pid: fakePid++ } }; },
    });
    assert.equal(staleNever.succeeded, false);
    assert.equal(staleBuildStarted, false);
    assert(staleNever.diagnostics.some((item) => item.message.includes('CPP_RECONFIGURE_REQUIRED')), JSON.stringify(staleNever));

    const staleIfMissing = await callCppBuildExecuteAcceleratorTool({
      root: buildMetaRoot, buildDir: buildMetaDir, operation: 'build', changedFiles: ['CMakeLists.txt'],
      configureMode: 'if_missing', configurePreset: 'base', timeoutMs: 5000,
    }, 5000, fakeExecuteDeps);
    assert.equal(staleIfMissing.succeeded, false);
    assert(staleIfMissing.diagnostics.some((item) => item.message.includes('CPP_RECONFIGURE_REQUIRED')), JSON.stringify(staleIfMissing));

    const reconfigureCalls = [];
    const reconfigured = await callCppBuildExecuteAcceleratorTool({
      root: buildMetaRoot, buildDir: buildMetaDir, operation: 'build', changedFiles: ['CMakeLists.txt'],
      configureMode: 'if_needed', configurePreset: 'base', includeTests: false, timeoutMs: 5000,
    }, 5000, {
      ...fakeExecuteDeps,
      startProcess: async (processArgs) => {
        reconfigureCalls.push(processArgs);
        return { structuredContent: { pid: fakePid++ }, content: [{ type: 'text', text: 'started' }] };
      },
    });
    assert.equal(reconfigured.succeeded, true, JSON.stringify(reconfigured));
    assert.equal(reconfigured.configure.executed, true);
    assert.deepEqual(reconfigureCalls[0].args, ['--preset', 'base', '-B', path.resolve(buildMetaDir)]);
    assert(reconfigureCalls.some((call) => Array.isArray(call.args) && call.args[0] === '--build'), JSON.stringify(reconfigureCalls));
    const queryPath = path.join(buildMetaDir, '.cmake', 'api', 'v1', 'query', 'client-desktop-commander', 'query.json');
    assert.equal((await fs.stat(queryPath)).isFile(), true);

    let staleTestStarted = false;
    const staleTest = await callCppBuildExecuteAcceleratorTool({
      root: buildMetaRoot, buildDir: buildMetaDir, operation: 'test', changedFiles: ['CMakeLists.txt'], timeoutMs: 5000,
    }, 5000, {
      ...fakeExecuteDeps,
      startProcess: async () => { staleTestStarted = true; return { structuredContent: { pid: fakePid++ } }; },
    });
    assert.equal(staleTest.succeeded, false);
    assert.equal(staleTestStarted, false);
    assert(staleTest.diagnostics.some((item) => item.message.includes('CPP_REBUILD_REQUIRED')), JSON.stringify(staleTest));

    const autoBuildDir = await callCppBuildExecuteAcceleratorTool({
      root: buildMetaRoot, operation: 'build', targets: ['sample'], configuration: 'Debug', timeoutMs: 5000,
    }, 5000, fakeExecuteDeps);
    assert.equal(autoBuildDir.succeeded, true, JSON.stringify(autoBuildDir));
    assert.equal(path.resolve(autoBuildDir.buildDir), path.resolve(buildMetaDir));
    assert.equal(autoBuildDir.buildDirSource, 'discovered');

    // cpp_build_execute must publish source/build access before starting the build,
    // while allowing mutations outside the planned read set to proceed concurrently.
    let markBuildStarted;
    let finishLeasedBuild;
    const leasedBuildStarted = new Promise((resolve) => { markBuildStarted = resolve; });
    const leasedBuildMayFinish = new Promise((resolve) => { finishLeasedBuild = resolve; });
    const leasedSource = path.join(buildMetaRoot, 'src', 'main.cpp');
    const leasedExecutePromise = callCppBuildExecuteAcceleratorTool({
      root: buildMetaRoot, buildDir: buildMetaDir, operation: 'build', targets: ['sample'],
      configuration: 'Debug', timeoutMs: 5000,
    }, 5000, {
      ...fakeExecuteDeps,
      planBuildAccess: async (args) => {
        const targets = Array.isArray(args.targets) ? args.targets : [];
        return {
          accessFingerprint: JSON.stringify([path.resolve(args.buildDir), targets, leasedSource]),
          coverage: 'historical', readPaths: [leasedSource], readRoots: [],
          writePaths: [], writeRoots: [path.resolve(args.buildDir)], watchRoots: [],
          incompleteness: [], warnings: [],
          leaseRequest: {
            kind: 'build', readPaths: [leasedSource], writeRoots: [path.resolve(args.buildDir)], coverage: 'historical',
          },
        };
      },
      acquireBuildAccessLease: (request, deadlineAt) => acquireResourceLease(request, deadlineAt),
      startProcess: async () => { markBuildStarted(); return { structuredContent: { pid: fakePid++ } }; },
      waitProcess: async () => {
        await leasedBuildMayFinish;
        return { completed: true, timedOut: false, processSucceeded: true, exitCode: 0, runtimeMs: 5, tail: '' };
      },
    });
    await leasedBuildStarted;
    let sourceWriterSettled = false;
    const sourceWriter = acquireMutationResourceLease([leasedSource], Date.now() + 4000, { label: 'execute-source-writer' })
      .then((handle) => { sourceWriterSettled = true; return handle; });
    await sleep(120);
    assert.equal(sourceWriterSettled, false, 'source writer bypassed cpp_build_execute access lease');
    const unrelatedBuildEdit = await acquireMutationResourceLease(
      [path.join(buildMetaRoot, 'docs', 'parallel.txt')], Date.now() + 1000, { label: 'execute-unrelated-writer' },
    );
    await unrelatedBuildEdit.release();
    finishLeasedBuild();
    const leasedExecute = await leasedExecutePromise;
    assert.equal(leasedExecute.succeeded, true, JSON.stringify(leasedExecute));
    assert.equal(leasedExecute.buildAccess.coverage, 'historical');
    const sourceWriterLease = await sourceWriter;
    assert.equal(sourceWriterSettled, true);
    await sourceWriterLease.release();

    const presetLockCalls = [];
    const presetFastPath = await callCppBuildExecuteAcceleratorTool({
      root: buildMetaRoot, buildDir: buildMetaDir, operation: 'build', preset: 'ci', targets: ['sample'], timeoutMs: 5000,
    }, 5000, {
      ...fakeExecuteDeps,
      acquireMutationLocks: async (resources, _deadline, resourceMode = 'exclusive') => {
        presetLockCalls.push({ resources: resources.map((value) => path.resolve(value)), resourceMode });
        return async () => undefined;
      },
    });
    assert.equal(presetFastPath.succeeded, true, JSON.stringify(presetFastPath));
    const sharedPresetLock = presetLockCalls.find((call) => call.resourceMode === 'shared');
    assert(sharedPresetLock, JSON.stringify(presetLockCalls));
    assert(sharedPresetLock.resources.includes(path.resolve(path.join(buildMetaRoot, 'CMakePresets.json'))));
    assert(sharedPresetLock.resources.includes(path.resolve(path.join(buildMetaRoot, 'CMakeUserPresets.json'))));
    assert(sharedPresetLock.resources.includes(path.resolve(includedPresetPath)), JSON.stringify(sharedPresetLock));

    await assert.rejects(
      () => callBuildMetadataAcceleratorTool({ root: buildMetaRoot, buildDir: foreignBuildDir, maxEntries: 1, maxTargets: 1 }, 5000),
      /BUILD_METADATA_SOURCE_MISMATCH/,
      'build_metadata must own CMake source-root validation for every downstream C++ accelerator',
    );

    let foreignBuildStarted = false;
    const foreignExecute = await callCppBuildExecuteAcceleratorTool({
      root: buildMetaRoot, buildDir: foreignBuildDir, operation: 'build', timeoutMs: 5000,
    }, 5000, {
      ...fakeExecuteDeps,
      startProcess: async () => { foreignBuildStarted = true; throw new Error('foreign build must not start'); },
    });
    assert.equal(foreignExecute.succeeded, false);
    assert.equal(foreignBuildStarted, false);
    assert(foreignExecute.diagnostics.some((item) => /BUILD_METADATA_SOURCE_MISMATCH/.test(item.message)), JSON.stringify(foreignExecute.diagnostics));

    const timeoutEvents = [];
    let timeoutWaitCount = 0;
    const timeoutExecute = await callCppBuildExecuteAcceleratorTool({
      root: buildMetaRoot, buildDir: buildMetaDir, operation: 'build', targets: ['sample'],
      configuration: 'Debug', timeoutMs: 5000,
    }, 5000, {
      ...fakeExecuteDeps,
      acquireMutationLocks: async (resources) => {
        const resolvedResources = resources.map((value) => path.resolve(value));
        timeoutEvents.push(['lock', ...resolvedResources]);
        return async () => { timeoutEvents.push(['release', ...resolvedResources]); };
      },
      startProcess: async () => { timeoutEvents.push(['start']); return { structuredContent: { pid: 81234 } }; },
      waitProcess: async () => {
        timeoutWaitCount += 1;
        timeoutEvents.push([timeoutWaitCount === 1 ? 'wait' : 'cleanup-wait']);
        return timeoutWaitCount === 1
          ? { completed: false, timedOut: true, processSucceeded: false, exitCode: null, tail: 'timed out' }
          : { completed: true, timedOut: false, processSucceeded: false, exitCode: 1, tail: 'terminated' };
      },
      terminateProcess: async (_pid, cause) => { timeoutEvents.push(['terminate', cause]); return true; },
    });
    assert.equal(timeoutExecute.succeeded, false);
    assert.equal(timeoutExecute.build.timedOut, true);
    assert.equal(timeoutExecute.build.terminationAttempted, true);
    assert.equal(timeoutExecute.build.terminationConfirmed, true);
    assert(timeoutEvents.some((event) => event[0] === 'lock' && event.includes(path.resolve(buildMetaDir))), JSON.stringify(timeoutEvents));
    const terminateIndex = timeoutEvents.findIndex((event) => event[0] === 'terminate');
    const buildReleaseIndex = timeoutEvents.findIndex((event) => event[0] === 'release' && event.includes(path.resolve(buildMetaDir)));
    assert(terminateIndex >= 0 && buildReleaseIndex > terminateIndex, JSON.stringify(timeoutEvents));

    const noisyOutput = Array.from({ length: 20_500 }, () => 'progress');
    noisyOutput[noisyOutput.length - 1] = 'src/tail.cpp:77:3: error: tail-only failure';
    const noisyExecute = await callCppBuildExecuteAcceleratorTool({
      root: buildMetaRoot, buildDir: buildMetaDir, operation: 'build', targets: ['sample'],
      configuration: 'Debug', timeoutMs: 5000,
    }, 5000, {
      ...fakeExecuteDeps,
      startProcess: async () => ({ structuredContent: { pid: 82345 }, content: [{ type: 'text', text: 'started' }] }),
      waitProcess: async () => ({
        completed: true, timedOut: false, processSucceeded: false, exitCode: 1, runtimeMs: 5, tail: 'tail-only failure',
      }),
      readProcessOutputPage: (_pid, offset, length) => {
        const totalLines = noisyOutput.length;
        const readFrom = offset < 0 ? Math.max(0, totalLines + offset) : Math.min(offset, totalLines);
        const lines = noisyOutput.slice(readFrom, readFrom + length);
        return {
          lines, totalLines, readFrom, readCount: lines.length, remaining: Math.max(0, totalLines - readFrom - lines.length),
          isComplete: true, exitCode: 1,
        };
      },
    });
    assert.equal(noisyExecute.succeeded, false);
    assert(noisyExecute.diagnostics.some((item) =>
      item.file === 'src/tail.cpp' && item.line === 77 && item.column === 3 && item.message.includes('tail-only failure')
    ), JSON.stringify(noisyExecute.diagnostics));

    const ambiguousDir = path.join(buildMetaRoot, 'build-secondary');
    await fs.mkdir(ambiguousDir, { recursive: true });
    await fs.writeFile(path.join(ambiguousDir, 'CMakeCache.txt'), [
      'CMAKE_GENERATOR:INTERNAL=Ninja',
      `CMAKE_HOME_DIRECTORY:INTERNAL=${buildMetaRoot.replace(/\\/g, '/')}`,
      '',
    ].join('\n'), 'utf8');
    const ambiguousBuild = await callCppBuildExecuteAcceleratorTool({
      root: buildMetaRoot, operation: 'build', targets: ['sample'], timeoutMs: 5000,
    }, 5000, fakeExecuteDeps);
    assert.equal(ambiguousBuild.succeeded, false, JSON.stringify(ambiguousBuild));
    assert.equal(ambiguousBuild.buildDir, null);
    assert(ambiguousBuild.diagnostics.some((item) => item.message.includes('CPP_BUILD_TREE_AMBIGUOUS')));
    await fs.rm(ambiguousDir, { recursive: true, force: true });

    const configureAutoRoot = path.join(root, 'configure-auto-repo');
    const configureAutoBuild = path.join(configureAutoRoot, 'preset-build');
    const configureAutoToolDir = path.join(root, 'configure-auto-host-tools');
    const configureAutoCmake = path.join(configureAutoToolDir, process.platform === 'win32' ? 'cmake.exe' : 'cmake');
    const configureAutoCtest = path.join(configureAutoToolDir, process.platform === 'win32' ? 'ctest.exe' : 'ctest');
    await fs.mkdir(configureAutoRoot, { recursive: true });
    await fs.mkdir(configureAutoToolDir, { recursive: true });
    await fs.writeFile(configureAutoCmake, '', 'utf8');
    await fs.writeFile(configureAutoCtest, '', 'utf8');
    await fs.writeFile(path.join(configureAutoRoot, 'CMakePresets.json'), JSON.stringify({
      version: 3, configurePresets: [{ name: 'auto', binaryDir: '${sourceDir}/preset-build' }],
    }), 'utf8');
    const configureCalls = [];
    const configureDeps = {
      ...fakeExecuteDeps,
      startProcess: async (processArgs) => {
        if (Array.isArray(processArgs.args) && processArgs.args[0] === '--preset') {
          configureCalls.push([...processArgs.args]);
          if (configureCalls.length === 2) {
            assert.deepEqual(processArgs.args.slice(0, 3), ['--preset', 'auto', '-B']);
            assert.equal(path.resolve(processArgs.args[3]), path.resolve(configureAutoBuild));
            const queryPath = path.join(configureAutoBuild, '.cmake', 'api', 'v1', 'query', 'client-desktop-commander', 'query.json');
            const query = JSON.parse(await fs.readFile(queryPath, 'utf8'));
            assert.deepEqual(query.requests.map((item) => item.kind), ['codemodel', 'cmakeFiles', 'toolchains']);
          }
          await fs.mkdir(configureAutoBuild, { recursive: true });
          await fs.writeFile(path.join(configureAutoBuild, 'CMakeCache.txt'), [
            `CMAKE_COMMAND:INTERNAL=${configureAutoCmake}`,
            `CMAKE_CTEST_COMMAND:INTERNAL=${configureAutoCtest}`,
            `CMAKE_MAKE_PROGRAM:FILEPATH=${configureAutoCmake}`,
            'CMAKE_GENERATOR:INTERNAL=Ninja',
            `CMAKE_HOME_DIRECTORY:INTERNAL=${configureAutoRoot.replace(/\\/g, '/')}`,
            'CMAKE_BUILD_TYPE:STRING=Debug',
            '',
          ].join('\n'), 'utf8');
        }
        return { structuredContent: { pid: fakePid++ }, content: [{ type: 'text', text: 'started' }] };
      },
    };
    const configuredByPreset = await callCppBuildExecuteAcceleratorTool({
      root: configureAutoRoot, operation: 'build', targets: ['sample'],
      configureMode: 'if_missing', configurePreset: 'auto', timeoutMs: 5000,
    }, 5000, configureDeps);
    assert.equal(configuredByPreset.succeeded, true, JSON.stringify(configuredByPreset));
    assert.equal(path.resolve(configuredByPreset.buildDir), path.resolve(configureAutoBuild));
    assert.equal(configuredByPreset.buildDirSource, 'configure-preset');
    assert.equal(configuredByPreset.configure.executed, true);
    assert.equal(configureCalls.length, 2, JSON.stringify(configureCalls));
    assert.deepEqual(configureCalls[0], ['--preset', 'auto']);
    await fs.rm(configureAutoRoot, { recursive: true, force: true });
    await fs.rm(configureAutoToolDir, { recursive: true, force: true });

    const buildContext = await callBuiltinAcceleratorTool('cpp_build_context', {
      root: buildMetaRoot, buildDir: buildMetaDir, changedFiles: ['src/main.cpp'], includeTests: false, operation: 'build',
    });
    assert.equal(buildContext.orchestration.metadataSnapshots, 1);
    assert.equal(buildContext.orchestration.profileAndImpactParallel, true);
    assert.equal(buildContext.orchestration.planSelection, 'affected-targets');
    assert.deepEqual(buildContext.impact.affectedTargets, ['sample']);
    assert.deepEqual(buildContext.plan.process.args, ['--build', path.resolve(buildMetaDir), '--target', 'sample']);
    assert.equal(buildContext.metadata.cmake.targetCount, 1);
    assert(buildContext.contextFingerprint.startsWith('sha256:'));

    const compilerDiagnostics = normalizeCppBuildDiagnostics([
      'src/scanner.cpp:123:9: error: broken expression',
      'src/warn.cpp:5:2: warning: risky conversion',
      'C:\\repo\\main.cpp(44,7): error C2143: syntax error: missing ; before }',
      'ninja: error: build stopped: subcommand failed.',
      'CMake Error at CMakeLists.txt:17 (message): fatal config',
    ], 'build', 'clang');
    assert.deepEqual(compilerDiagnostics.map((item) => item.tool), ['clang', 'clang', 'msvc', 'ninja', 'cmake']);
    assert.equal(compilerDiagnostics[0].file, 'src/scanner.cpp');
    assert.equal(compilerDiagnostics[0].line, 123);
    assert.equal(compilerDiagnostics[0].column, 9);
    const ctestDiagnostics = normalizeCppBuildDiagnostics([
      '1/3 Test #2: parser_test ........***Failed    0.01 sec',
      'Errors while running CTest',
      'No tests were found!!!',
    ], 'test');
    assert.equal(ctestDiagnostics.length, 3);
    assert(ctestDiagnostics.every((item) => item.tool === 'ctest' && item.severity === 'error'));

    const headerImpact = await callBuiltinAcceleratorTool('cpp_build_impact', {
      root: buildMetaRoot, buildDir: buildMetaDir, changedFiles: ['include/shared.hpp'], includeTests: false,
    });
    assert.equal(headerImpact.recommendFullBuild, true);
    assert(headerImpact.incompleteness.includes('header_dependency_graph_unavailable'));
    assert(headerImpact.affectedTargets.includes('sample'));

    const snapshotForRevalidation = await callBuildMetadataAcceleratorTool({
      root: buildMetaRoot, buildDir: buildMetaDir, maxEntries: 500, maxTargets: 500,
    }, 5000);
    const initiallyCurrent = await revalidateBuildMetadataSnapshot(snapshotForRevalidation, 5000);
    assert.equal(initiallyCurrent.current, true, JSON.stringify(initiallyCurrent));
    await fs.writeFile(compileDbPath, `${compileDbSource}\n`, 'utf8');
    const compileDbChanged = await revalidateBuildMetadataSnapshot(snapshotForRevalidation, 5000);
    assert.equal(compileDbChanged.current, false, JSON.stringify(compileDbChanged));
    assert(compileDbChanged.changed.includes('compile_database'), JSON.stringify(compileDbChanged));
    await assert.rejects(
      () => callCppBuildPlanAcceleratorTool({ root: buildMetaRoot, buildDir: buildMetaDir, operation: 'build' }, 5000, snapshotForRevalidation),
      /Build metadata changed while cpp_build_plan was being derived/,
    );
    await fs.writeFile(compileDbPath, compileDbSource, 'utf8');

    const generationSnapshot = await callBuildMetadataAcceleratorTool({
      root: buildMetaRoot, buildDir: buildMetaDir, maxEntries: 500, maxTargets: 500,
    }, 5000);
    const newerErrorIndex = path.join(replyDir, 'error-2026-08-16T999999.json');
    await fs.writeFile(newerErrorIndex, JSON.stringify({ error: 'simulated concurrent configure generation' }), 'utf8');
    const generationChanged = await revalidateBuildMetadataSnapshot(generationSnapshot, 5000);
    assert.equal(generationChanged.current, false, JSON.stringify(generationChanged));
    assert(generationChanged.changed.includes('cmake_file_api_generation'), JSON.stringify(generationChanged));
    await fs.rm(newerErrorIndex, { force: true });

    await fs.rm(buildMetaRoot, { recursive: true, force: true });
    await fs.rm(syntheticCmakeBin, { recursive: true, force: true });

    await expectReject(
      () => callBuiltinAcceleratorTool('read_ranges', {
        requests: [{ path: rangeBPath, offset: 0, length: 2 }],
        maxTotalChars: 2,
      }),
      'maxTotalChars',
    );

    await expectReject(
      () => callExternalMcpCompatUri(
        'mcp://desktop-accelerators/workspace_snapshot',
        JSON.stringify({ arguments: { root }, unexpected: true }),
      ),
      'workspace_snapshot.root is required',
    );

    await fs.writeFile(aPath, 'alpha\nbeta\n', 'utf8');
    const before = await fs.readFile(aPath, 'utf8');
    const dryEdit = await callBuiltinAcceleratorTool('edit_file', {
      path: aPath,
      edits: [{ oldText: 'beta', newText: 'gamma' }],
      dryRun: true,
      expectedHash: hashText(before),
    });
    assert.equal(dryEdit.changed, true);
    assert.equal(await fs.readFile(aPath, 'utf8'), before);

    const appliedEdit = await callBuiltinAcceleratorTool('edit_file', {
      path: aPath,
      edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: 'beta', newText: 'gamma' },
      ],
      dryRun: false,
      expectedHash: hashText(before),
    });
    assert.equal(appliedEdit.dryRun, false);
    assert.equal(await fs.readFile(aPath, 'utf8'), 'ALPHA\ngamma\n');

    const crlfEditPath = path.join(root, 'crlf-edit.txt');
    await fs.writeFile(crlfEditPath, 'alpha\r\nbeta\r\n', 'utf8');
    await callBuiltinAcceleratorTool('edit_file', {
      path: crlfEditPath,
      edits: [{ oldText: 'alpha\nbeta', newText: 'ALPHA\nBETA' }],
      dryRun: false,
    });
    assert.equal(await fs.readFile(crlfEditPath, 'utf8'), 'ALPHA\r\nBETA\r\n');

    if (process.platform === 'win32') {
      const lockProbePath = path.join(root, 'restart-manager-lock.txt');
      await fs.writeFile(lockProbePath, 'locked\n', 'utf8');
      const holder = spawn(process.execPath, ['--input-type=module', '-e',
        `import { createReadStream } from 'node:fs'; const stream = createReadStream(process.env.LOCK_PATH); stream.once('open', () => process.stdout.write('LOCKED\\n')); setInterval(() => {}, 1000);`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LOCK_PATH: lockProbePath },
      });
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('lock holder did not open file')), 3000);
          holder.once('error', reject);
          holder.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
        });
        const lockers = await findWindowsFileLockers(lockProbePath, 2500);
        assert(lockers.some((locker) => locker.pid === holder.pid), JSON.stringify(lockers));
        await assert.rejects(
          () => callBuiltinAcceleratorTool('edit_file', {
            path: lockProbePath, edits: [{ oldText: 'locked', newText: 'updated' }], dryRun: false,
          }, 5000),
          (error) => error?.code === 'EFILELOCKED' && error.message.includes('PID ' + holder.pid),
        );
        assert.equal(await fs.readFile(lockProbePath, 'utf8'), 'locked\n');
      } finally {
        if (holder.exitCode === null) {
          holder.kill();
          await new Promise((resolve) => holder.once('exit', resolve));
        }
      }

      const textHandler = new TextFileHandler();
      const partialReadPath = path.join(root, 'partial-read-lock.txt');
      const partialReadContent = Array.from({ length: 400 }, (_, index) => `line-${index}`).join('\n') + '\n';
      await fs.writeFile(partialReadPath, partialReadContent, 'utf8');
      const partialRead = await textHandler.read(partialReadPath, {
        offset: 120, length: 3, includeStatusMessage: false,
      });
      assert(partialRead.content.includes('line-120'));
      await callBuiltinAcceleratorTool('edit_file', {
        path: partialReadPath,
        edits: [{ oldText: 'line-399', newText: 'tail-updated' }],
        dryRun: false,
      }, 5000);
      assert((await fs.readFile(partialReadPath, 'utf8')).includes('tail-updated'));

      const deepReadPath = path.join(root, 'deep-read-lock.txt');
      const deepTempPath = path.join(root, 'deep-read-replacement.txt');
      const longLine = 'x'.repeat(6000);
      const deepContent = Array.from({ length: 1900 }, (_, index) => `${index}:${longLine}`).join('\n') + '\n';
      assert(Buffer.byteLength(deepContent) > 10 * 1024 * 1024);
      await fs.writeFile(deepReadPath, deepContent, 'utf8');
      const deepRead = await textHandler.read(deepReadPath, {
        offset: 1500, length: 2, includeStatusMessage: false,
      });
      assert(deepRead.content.length > 0);
      await fs.writeFile(deepTempPath, 'replacement\n', 'utf8');
      await fs.rename(deepTempPath, deepReadPath);
      assert.equal(await fs.readFile(deepReadPath, 'utf8'), 'replacement\n');

      const retryPath = path.join(root, 'rename-retry.txt');
      const realRename = fs.rename;
      await fs.writeFile(retryPath, 'ORIGINAL\n', 'utf8');
      let renameAttempts = 0;
      fs.rename = async (source, destination) => {
        if (String(destination) === retryPath && ++renameAttempts < 3) {
          throw Object.assign(new Error('transient Windows rename lock'), { code: 'EPERM' });
        }
        return realRename(source, destination);
      };
      try {
        await callBuiltinAcceleratorTool('edit_file', {
          path: retryPath, edits: [{ oldText: 'ORIGINAL', newText: 'REPLACED' }], dryRun: false,
        }, 5000);
      } finally {
        fs.rename = realRename;
      }
      assert.equal(renameAttempts, 3);
      assert.equal(await fs.readFile(retryPath, 'utf8'), 'REPLACED\n');

      await fs.writeFile(retryPath, 'ORIGINAL\n', 'utf8');
      let raceAttempts = 0;
      fs.rename = async (source, destination) => {
        if (String(destination) === retryPath && raceAttempts++ === 0) {
          await fs.writeFile(retryPath, 'RACED\n', 'utf8');
          throw Object.assign(new Error('transient Windows rename lock'), { code: 'EPERM' });
        }
        return realRename(source, destination);
      };
      try {
        await assert.rejects(
          () => callBuiltinAcceleratorTool('edit_file', {
            path: retryPath, edits: [{ oldText: 'ORIGINAL', newText: 'REPLACED' }], dryRun: false,
          }, 5000),
          /File changed while edit_file prepared its replacement/,
        );
      } finally {
        fs.rename = realRename;
      }
      assert.equal(raceAttempts, 1);
      assert.equal(await fs.readFile(retryPath, 'utf8'), 'RACED\n');
      const retryBase = path.basename(retryPath);
      const retryTemps = (await fs.readdir(root)).filter((name) => name.startsWith(`.${retryBase}.`) && name.endsWith('.tmp'));
      assert.deepEqual(retryTemps, []);
    }

    const atomicPath = path.join(root, 'atomic.txt');
    await fs.writeFile(atomicPath, 'ORIGINAL\n', 'utf8');
    const realWriteFile = fs.writeFile;
    const atomicBase = path.basename(atomicPath);
    fs.writeFile = async (target, data, options) => {
      const targetPath = String(target);
      const intercept = targetPath === atomicPath ||
        path.basename(targetPath).startsWith(`.${atomicBase}.`);
      if (!intercept) return realWriteFile(target, data, options);
      await realWriteFile(target, 'PARTIAL', typeof options === 'object' ? { ...options, signal: undefined } : options);
      const signal = typeof options === 'object' ? options?.signal : undefined;
      return new Promise((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    };
    try {
      await assert.rejects(
        () => callBuiltinAcceleratorTool('edit_file', {
          path: atomicPath, edits: [{ oldText: 'ORIGINAL', newText: 'CHANGED' }], dryRun: false,
        }, 150),
        (error) => error?.code === 'ETIMEDOUT',
      );
    } finally {
      fs.writeFile = realWriteFile;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await fs.readFile(atomicPath, 'utf8'), 'ORIGINAL\n');
    const atomicTemps = (await fs.readdir(root)).filter((name) => name.startsWith(`.${atomicBase}.`) && name.endsWith('.tmp'));
    assert.deepEqual(atomicTemps, []);

    await expectReject(
      () => callBuiltinAcceleratorTool('edit_file', {
        path: aPath,
        edits: [{ oldText: 'missing', newText: 'x' }],
        dryRun: false,
      }),
      'Expected 1 occurrence',
    );
    assert.equal(await fs.readFile(aPath, 'utf8'), 'ALPHA\ngamma\n');

    await fs.writeFile(aPath, 'alpha\nbeta\n', 'utf8');
    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      ' alpha',
      '-beta',
      '+gamma',
      '',
    ].join('\n');

    await expectReject(
      () => callBuiltinAcceleratorTool('apply_patch', {
        root,
        patch: 'x'.repeat(8 * 1024 * 1024 + 1),
        expectedFiles: ['a.txt'],
        dryRun: true,
      }),
      'limited to',
    );

    const dryPatch = await callBuiltinAcceleratorTool('apply_patch', {
      root,
      patch,
      expectedFiles: ['a.txt'],
      expectedHashes: { 'a.txt': hashText('alpha\nbeta\n') },
      dryRun: true,
    });
    assert.equal(dryPatch.applicable, true);
    assert.equal(await fs.readFile(aPath, 'utf8'), 'alpha\nbeta\n');

    await expectReject(
      () => callBuiltinAcceleratorTool('apply_patch', {
        root,
        patch,
        expectedFiles: ['a.txt', 'b.txt'],
        dryRun: false,
      }),
      'does not match expectedFiles',
    );
    assert.equal(await fs.readFile(aPath, 'utf8'), 'alpha\nbeta\n');

    const appliedPatch = await callBuiltinAcceleratorTool('apply_patch', {
      root,
      patch,
      expectedFiles: ['a.txt'],
      expectedHashes: { 'a.txt': hashText('alpha\nbeta\n') },
      dryRun: false,
    });
    assert.equal(appliedPatch.applied, true);
    assert.equal(appliedPatch.diffCheck.ok, true);
    assert.equal(await fs.readFile(aPath, 'utf8'), 'alpha\ngamma\n');

    // A read-only verification failure after git apply must not relabel an
    // already-committed patch as a failed/unknown mutation.
    await fs.writeFile(aPath, 'alpha\nbeta\n', 'utf8');
    const realReadFile = fs.readFile;
    let patchHashReads = 0;
    fs.readFile = async (target, ...rest) => {
      if (String(target) === aPath) {
        patchHashReads++;
        if (patchHashReads === 3) throw new Error('post-commit verification probe');
      }
      return realReadFile(target, ...rest);
    };
    let appliedWithVerificationFailure;
    try {
      appliedWithVerificationFailure = await callBuiltinAcceleratorTool('apply_patch', {
        root, patch, expectedFiles: ['a.txt'],
        expectedHashes: { 'a.txt': hashText('alpha\nbeta\n') },
        dryRun: false,
      });
    } finally {
      fs.readFile = realReadFile;
    }
    assert.equal(appliedWithVerificationFailure.applied, true);
    assert.equal(appliedWithVerificationFailure.verificationIncomplete, true);
    assert(appliedWithVerificationFailure.verificationError.includes('post-commit verification probe'));
    assert.equal(await fs.readFile(aPath, 'utf8'), 'alpha\ngamma\n');

    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const command = `node -e "setTimeout(()=>console.log('wait-done'), 180)"`;
    const started = await terminalManager.executeCommand(command, 10, shell);
    assert(started.pid > 0);
    const waited = await callBuiltinAcceleratorTool('wait_process', {
      pid: started.pid,
      timeout_ms: 5000,
      tail_lines: 20,
    });
    assert.equal(waited.completed, true);
    assert.equal(waited.processSucceeded, true);
    assert.equal(waited.exitCode, 0);
    assert(waited.tail.includes('wait-done'));

    const slowCommand = `node -e "setTimeout(()=>console.log('wait-later'), 350)"`;
    const slowStarted = await terminalManager.executeCommand(slowCommand, 10, shell);
    const timedOut = await callBuiltinAcceleratorTool('wait_process', {
      pid: slowStarted.pid,
      timeout_ms: 50,
      tail_lines: 20,
    });
    assert.equal(timedOut.completed, false);
    assert.equal(timedOut.timedOut, true);
    const resumed = await callBuiltinAcceleratorTool('wait_process', {
      pid: slowStarted.pid,
      timeout_ms: 2000,
      tail_lines: 20,
    });
    assert.equal(resumed.completed, true);
    assert.equal(resumed.processSucceeded, true);
    assert(resumed.tail.includes('wait-later'));

    const stalledCommand = `node -e "setTimeout(()=>console.log('stall-done'), 400)"`;
    const stalledStarted = await terminalManager.executeCommand(stalledCommand, 10, shell);
    const stalled = await callBuiltinAcceleratorTool('wait_process', {
      pid: stalledStarted.pid, timeout_ms: 1000, stall_timeout_ms: 60, tail_lines: 20,
    });
    assert.equal(stalled.completed, false);
    assert.equal(stalled.timedOut, false);
    assert.equal(stalled.stalled, true);
    assert(stalled.noOutputForMs >= 60);

    const readStalled = await readProcessOutput({
      pid: stalledStarted.pid, timeout_ms: 100, stall_timeout_ms: 60, offset: -20, length: 20,
    });
    assert(readStalled.content[0].text.includes('STALL WARNING'));

    const frozenCompatRead = await callExternalMcpCompatUri(
      'mcp://desktop-core/read_process_output',
      JSON.stringify({
        arguments: {
          pid: stalledStarted.pid, timeout_ms: 100, stall_timeout_ms: 60, offset: -20, length: 20,
        },
        timeout_ms: 100 + PROCESS_TRANSPORT_RESERVE_MS,
      }),
    );
    assert(frozenCompatRead.content[0].text.includes('STALL WARNING'));

    const stalledResumed = await callBuiltinAcceleratorTool('wait_process', {
      pid: stalledStarted.pid, timeout_ms: 2000, stall_timeout_ms: 0, tail_lines: 20,
    });
    assert.equal(stalledResumed.completed, true);
    assert(stalledResumed.tail.includes('stall-done'));

    console.log('workspace accelerators: PASS');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
