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
import { callBuildMetadataAcceleratorTool, revalidateBuildMetadataSnapshot } from '../dist/tools/build-metadata-accelerator.js';
import { callCppBuildPlanAcceleratorTool } from '../dist/tools/cpp-build-plan-accelerator.js';
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

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function hashText(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

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
      ['apply_patch', 'ast_rewrite', 'ast_rule_search', 'ast_search', 'build_metadata', 'context_pack', 'cpp_build_context', 'cpp_build_impact', 'cpp_build_plan', 'cpp_toolchain_profile', 'edit_file', 'read_ranges', 'safe_fix', 'wait_process', 'workspace_delta', 'workspace_snapshot'],
    );
    const patchMetadata = listBuiltinAcceleratorTools('apply_patch');
    assert.equal(patchMetadata.mutating, true);
    assert.equal(patchMetadata.preferredFrozenSurface, 'write_file');
    assert.equal(patchMetadata.inputSchema.type, 'object');
    const snapshotMetadata = listBuiltinAcceleratorTools('workspace_snapshot');
    assert.equal(snapshotMetadata.readOnly, true);
    assert.equal(snapshotMetadata.preferredFrozenSurface, 'read_file');

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
      parseExternalMcpCompatUri('mcp://serena-project/get_symbols_overview?timeout_ms=45000'),
      { server: 'serena-project', tool: 'get_symbols_overview', timeout_ms: 45000 },
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
    await fs.mkdir(path.join(scopedContextRoot, 'build-debug', 'CMakeFiles'), { recursive: true });
    await fs.writeFile(path.join(scopedContextRoot, 'src', 'main.ts'), 'export const scopedNeedle = 1;\n', 'utf8');
    await fs.writeFile(path.join(scopedContextRoot, '.tmp-trace', 'trace.txt'), 'scopedNeedle runtime trace\n', 'utf8');
    await fs.writeFile(path.join(scopedContextRoot, 'build-debug', 'CMakeFiles', 'generated.txt'), 'scopedNeedle\n', 'utf8');

    const scopedPack = await callBuiltinAcceleratorTool('context_pack', {
      root: scopedContextRoot, query: 'scopedNeedle implementation',
      maxFiles: 2, contextLines: 0, maxLinesPerFile: 10, maxTotalChars: 1000,
    });
    assert.deepEqual(scopedPack.workspaceDelta.changedFiles, ['scoped-context/src/main.ts']);
    assert(scopedPack.files.some((file) => file.path === 'scoped-context/src/main.ts'));
    assert(!scopedPack.files.some((file) =>
      file.path.includes('.tmp-trace') || file.path.includes('/build-debug/')
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
    await fs.mkdir(path.join(buildMetaRoot, 'src'), { recursive: true });
    await fs.mkdir(path.join(buildMetaRoot, 'include'), { recursive: true });
    await fs.mkdir(replyDir, { recursive: true });
    const syntheticToolchainBin = path.join(buildMetaRoot, 'toolchain', 'bin');
    const syntheticQtRoot = path.join(buildMetaRoot, 'qt');
    const syntheticQtBin = path.join(syntheticQtRoot, 'bin');
    const syntheticQtPlugins = path.join(syntheticQtRoot, 'plugins');
    const syntheticQtDir = path.join(syntheticQtRoot, 'lib', 'cmake', 'Qt6');
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
    const cmakeExecutable = path.join(buildMetaDir, process.platform === 'win32' ? 'cmake.exe' : 'cmake').replace(/\\/g, '/');
    const ctestExecutable = path.join(buildMetaDir, process.platform === 'win32' ? 'ctest.exe' : 'ctest').replace(/\\/g, '/');
    await fs.writeFile(cmakeExecutable, '', 'utf8');
    await fs.writeFile(ctestExecutable, '', 'utf8');
    await fs.writeFile(path.join(buildMetaDir, 'CMakeCache.txt'), [
      `CMAKE_COMMAND:INTERNAL=${cmakeExecutable}`,
      `CMAKE_CTEST_COMMAND:INTERNAL=${ctestExecutable}`,
      `CMAKE_MAKE_PROGRAM:FILEPATH=${cmakeExecutable}`,
      `CMAKE_CXX_COMPILER:FILEPATH=${path.join(syntheticToolchainBin, process.platform === 'win32' ? 'c++.exe' : 'c++')}`,
      `CMAKE_PREFIX_PATH:PATH=${syntheticQtRoot}`,
      `Qt6_DIR:PATH=${syntheticQtDir}`,
      'CMAKE_GENERATOR:INTERNAL=Ninja',
      'CMAKE_BUILD_TYPE:STRING=Debug',
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(replyDir, 'index-2026-08-15T000000.json'), JSON.stringify({
      cmake: { generator: { name: 'Ninja', multiConfig: false } },
      objects: [{ kind: 'codemodel', version: { major: 2, minor: 8 }, jsonFile: 'codemodel-v2.json' }],
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
    const buildPathEntries = buildPlan.process.env.PATH.split(path.delimiter).map((value) => path.resolve(value));
    assert(buildPathEntries.some((value) => value === path.resolve(syntheticToolchainBin)), JSON.stringify(buildPlan.evidence.environment));
    assert(buildPathEntries.some((value) => value === path.resolve(buildMetaDir)), JSON.stringify(buildPlan.evidence.environment));
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
    await assert.rejects(
      () => callBuiltinAcceleratorTool('cpp_build_plan', { root: buildMetaRoot, buildDir: buildMetaDir, operation: 'test', targets: ['sample'] }),
      /targets is only valid/,
    );
    await assert.rejects(
      () => callBuiltinAcceleratorTool('cpp_build_plan', { root: buildMetaRoot, buildDir: buildMetaDir, preset: 'ci' }),
      /has no CMakePresets/,
    );
    await fs.writeFile(path.join(buildMetaRoot, 'CMakePresets.json'), JSON.stringify({ version: 3, buildPresets: [{ name: 'ci', configurePreset: 'base' }] }), 'utf8');
    const presetPlan = await callBuiltinAcceleratorTool('cpp_build_plan', {
      root: buildMetaRoot, buildDir: buildMetaDir, preset: 'ci', targets: ['sample'],
    });
    assert.deepEqual(presetPlan.process.args, ['--build', '--preset', 'ci', '--target', 'sample']);
    assert.equal(presetPlan.source, 'explicit-preset');
    assert.equal(presetPlan.evidence.presetFiles.length, 1);

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

    const contextSchema = parseTextResult(await readExternalMcpCompatUri('mcp://desktop-accelerators/cpp_build_context'));
    assert.equal(contextSchema.tool.name, 'cpp_build_context');
    assert.equal(contextSchema.tool.readOnly, true);
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
