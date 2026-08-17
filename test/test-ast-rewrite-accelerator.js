#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { callBuiltinAcceleratorTool } from '../dist/tools/workspace-accelerators.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-ast-rewrite-'));
const src = path.join(root, 'src');
const aPath = path.join(src, 'a.ts');
const bPath = path.join(src, 'b.ts');
const originalA = [
  'export function demo(x: number) {',
  '  console.log(x);',
  '  // console.log(x);',
  '  return "console.log(x)";',
  '}',
  '',
].join('\n');
const originalB = [
  'console.log(1);',
  'console.log(2);',
  '',
].join('\n');
try {
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(aPath, originalA, 'utf8');
  await fs.writeFile(bPath, originalB, 'utf8');
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });

  const freshCwd = path.join(root, 'cwd-trap');
  await fs.mkdir(freshCwd, { recursive: true });
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workspaceModuleUrl = pathToFileURL(path.join(repoRoot, 'dist', 'tools', 'workspace-accelerators.js')).href;
  const childEnv = { ...process.env };
  delete childEnv.PATH;
  delete childEnv.Path;
  delete childEnv.APPDATA;
  delete childEnv.AST_GREP_BIN;
  const childProbe = [
    `const { callBuiltinAcceleratorTool } = await import(${JSON.stringify(workspaceModuleUrl)});`,
    `const result = await callBuiltinAcceleratorTool('ast_search', ${JSON.stringify({
      project_folder: src, pattern: 'console.log($A)', language: 'typescript', max_results: 10, output_format: 'json',
    })}, 10000);`,
    `if (!(result.returnedMatches > 0)) throw new Error('package-owned ast-grep resolver returned no matches');`,
  ].join('\n');
  execFileSync(process.execPath, ['--input-type=module', '-e', childProbe], {
    cwd: freshCwd, env: childEnv, stdio: 'pipe', windowsHide: true,
  });

  const rule = {
    project_folder: src,
    pattern: 'console.log($A)',
    rewrite: 'logger.info($A)',
    language: 'typescript',
    max_results: 20,
    max_patch_chars: 200000,
    dry_run: true,
  };

  const preview = await callBuiltinAcceleratorTool('ast_rewrite', rule, 30000);
  assert.equal(preview.changed, true);
  assert.equal(preview.returnedMatches, 3);
  assert.deepEqual(preview.changedFiles, ['src/a.ts', 'src/b.ts']);
  assert.match(preview.previewId, /^sha256:[0-9a-f]{64}$/);
  assert.match(preview.patchHash, /^sha256:[0-9a-f]{64}$/);
  assert(preview.patchPreview.includes('logger.info'));
  assert.equal(await fs.readFile(aPath, 'utf8'), originalA, 'preview mutated a.ts');
  assert.equal(await fs.readFile(bPath, 'utf8'), originalB, 'preview mutated b.ts');

  await assert.rejects(
    () => callBuiltinAcceleratorTool('ast_rewrite', { ...rule, dry_run: false }, 30000),
    /expected_preview_id is required/,
  );
  assert.equal(await fs.readFile(aPath, 'utf8'), originalA, 'failed apply mutated source');

  const applied = await callBuiltinAcceleratorTool('ast_rewrite', {
    ...rule,
    dry_run: false,
    expected_preview_id: preview.previewId,
    expected_files: preview.applyExpectedFiles,
  }, 30000);
  assert.equal(applied.applied, true);
  assert.equal(applied.apply?.diffCheck?.ok, true);

  const rewrittenA = await fs.readFile(aPath, 'utf8');
  const rewrittenB = await fs.readFile(bPath, 'utf8');
  assert(rewrittenA.includes('logger.info(x);'));
  assert(rewrittenA.includes('// console.log(x);'), 'comment was rewritten');
  assert(rewrittenA.includes('"console.log(x)"'), 'string literal was rewritten');
  assert.equal((rewrittenB.match(/logger\.info/g) ?? []).length, 2);

  const staleRule = {
    project_folder: src,
    pattern: 'logger.info($A)',
    rewrite: 'audit.info($A)',
    language: 'typescript',
    max_results: 20,
    dry_run: true,
  };
  const stalePreview = await callBuiltinAcceleratorTool('ast_rewrite', staleRule, 30000);
  await fs.appendFile(aPath, '// concurrent change\n', 'utf8');
  await assert.rejects(
    () => callBuiltinAcceleratorTool('ast_rewrite', {
      ...staleRule,
      dry_run: false,
      expected_preview_id: stalePreview.previewId,
      expected_files: stalePreview.applyExpectedFiles,
    }, 30000),
    /AST_REWRITE_PREVIEW_STALE/,
  );
  assert((await fs.readFile(aPath, 'utf8')).includes('logger.info(x);'));

  await assert.rejects(
    () => callBuiltinAcceleratorTool('ast_rewrite', {
      project_folder: src,
      pattern: 'logger.info($A)',
      rewrite: 'bounded.info($A)',
      language: 'typescript',
      max_results: 1,
      dry_run: true,
    }, 30000),
    /AST_REWRITE_MATCH_LIMIT_EXCEEDED/,
  );

  const yamlPreview = await callBuiltinAcceleratorTool('ast_rewrite', {
    project_folder: src,
    yaml: [
      'id: yaml-rewrite',
      'language: TypeScript',
      'rule:',
      '  pattern: logger.info($A)',
      'fix: trace.info($A)',
    ].join('\n'),
    max_results: 20,
    dry_run: true,
  }, 30000);
  assert.equal(yamlPreview.changed, true);
  assert(yamlPreview.patchPreview.includes('trace.info'));

  const freshPreview = await callBuiltinAcceleratorTool('ast_rewrite', staleRule, 30000);
  await assert.rejects(
    () => callBuiltinAcceleratorTool('ast_rewrite', {
      ...staleRule,
      dry_run: false,
      expected_preview_id: freshPreview.previewId,
      expected_files: ['src/a.ts'],
    }, 30000),
    /AST_REWRITE_FILESET_CHANGED/,
  );

  const unicodeDir = path.join(src, 'a', 'before');
  const unicodePath = path.join(unicodeDir, 'unicode.ts');
  await fs.mkdir(unicodeDir, { recursive: true });
  await fs.writeFile(unicodePath, 'const greeting = "Привет";\nspecialCall(greeting);\n', 'utf8');
  const unicodePreview = await callBuiltinAcceleratorTool('ast_rewrite', {
    project_folder: src,
    pattern: 'specialCall($A)',
    rewrite: 'wrappedCall($A)',
    language: 'typescript',
    dry_run: true,
  }, 30000);
  assert.deepEqual(unicodePreview.changedFiles, ['src/a/before/unicode.ts']);
  const unicodeApplied = await callBuiltinAcceleratorTool('ast_rewrite', {
    project_folder: src,
    pattern: 'specialCall($A)',
    rewrite: 'wrappedCall($A)',
    language: 'typescript',
    dry_run: false,
    expected_preview_id: unicodePreview.previewId,
    expected_files: unicodePreview.applyExpectedFiles,
  }, 30000);
  assert.equal(unicodeApplied.applied, true);
  assert.equal(await fs.readFile(unicodePath, 'utf8'), 'const greeting = "Привет";\nwrappedCall(greeting);\n');

  const spacedDir = path.join(src, 'space ü');
  const spacedPath = path.join(spacedDir, 'file name.ts');
  await fs.mkdir(spacedDir, { recursive: true });
  await fs.writeFile(spacedPath, 'uniqueCall(99);\n', 'utf8');
  const spacedPreview = await callBuiltinAcceleratorTool('ast_rewrite', {
    project_folder: src, pattern: 'uniqueCall($A)', rewrite: 'uniqueWrapped($A)',
    language: 'typescript', dry_run: true,
  }, 30000);
  assert.deepEqual(spacedPreview.changedFiles, ['src/space ü/file name.ts']);
  assert(spacedPreview.patchPreview.includes('src/space ü/file name.ts'));
  assert(!spacedPreview.patchPreview.includes('a/before/src/space'));
  assert(!spacedPreview.patchPreview.includes('b/after/src/space'));
  await callBuiltinAcceleratorTool('ast_rewrite', {
    project_folder: src, pattern: 'uniqueCall($A)', rewrite: 'uniqueWrapped($A)',
    language: 'typescript', dry_run: false,
    expected_preview_id: spacedPreview.previewId, expected_files: spacedPreview.applyExpectedFiles,
  }, 30000);
  assert.equal(await fs.readFile(spacedPath, 'utf8'), 'uniqueWrapped(99);\n');

  const markerDir = path.join(src, 'weird b', 'after');
  const markerPath = path.join(markerDir, 'marker.ts');
  await fs.mkdir(markerDir, { recursive: true });
  await fs.writeFile(markerPath, 'markerCall(3);\n', 'utf8');
  const markerPreview = await callBuiltinAcceleratorTool('ast_rewrite', {
    project_folder: src, pattern: 'markerCall($A)', rewrite: 'markerWrapped($A)',
    language: 'typescript', dry_run: true,
  }, 30000);
  assert.deepEqual(markerPreview.changedFiles, ['src/weird b/after/marker.ts']);
  assert(markerPreview.patchPreview.includes('a/src/weird b/after/marker.ts'));
  assert(markerPreview.patchPreview.includes('b/src/weird b/after/marker.ts'));
  assert(!markerPreview.patchPreview.includes('a/before/src/weird'));
  assert(!markerPreview.patchPreview.includes('b/after/src/weird'));

  const crlfPath = path.join(src, 'crlf.ts');
  await fs.writeFile(crlfPath, 'console.log(7);\r\n', 'utf8');
  const crlfRule = {
    project_folder: src, pattern: 'console.log($A);',
    rewrite: 'logger.info($A);\nlogger.flush();', language: 'typescript', dry_run: true,
  };
  const crlfPreview = await callBuiltinAcceleratorTool('ast_rewrite', crlfRule, 30000);
  await callBuiltinAcceleratorTool('ast_rewrite', {
    ...crlfRule, dry_run: false, expected_preview_id: crlfPreview.previewId,
    expected_files: crlfPreview.applyExpectedFiles,
  }, 30000);
  const crlfAfter = await fs.readFile(crlfPath, 'utf8');
  assert.equal(crlfAfter, 'logger.info(7);\r\nlogger.flush();\r\n');
  assert.equal(/(^|[^\r])\n/.test(crlfAfter), false, 'multiline fix introduced lone LF into CRLF file');

  const mixedPath = path.join(src, 'mixed.ts');
  await fs.writeFile(mixedPath, 'const a = 1;\r\nspecialMixed(a);\nconst b = 2;\r\n', 'utf8');
  await assert.rejects(
    () => callBuiltinAcceleratorTool('ast_rewrite', {
      project_folder: src, pattern: 'specialMixed($A)', rewrite: 'one($A)\ntwo($A)',
      language: 'typescript', dry_run: true,
    }, 30000),
    /AST_REWRITE_AMBIGUOUS_EOL/,
  );

  const noFixPath = path.join(src, 'no-fix.ts');
  await fs.writeFile(noFixPath, 'noFixCall(1);\n', 'utf8');
  await assert.rejects(
    () => callBuiltinAcceleratorTool('ast_rewrite', {
      project_folder: src,
      yaml: ['id: no-fix', 'language: TypeScript', 'rule:', '  pattern: noFixCall($A)'].join('\n'),
      dry_run: true,
    }, 30000),
    /AST_REWRITE_RULE_HAS_NO_FIX/,
  );

  const overlapPath = path.join(src, 'overlap.ts');
  await fs.writeFile(overlapPath, 'overlapCall(overlapCall(1));\n', 'utf8');
  await assert.rejects(
    () => callBuiltinAcceleratorTool('ast_rewrite', {
      project_folder: src, pattern: 'overlapCall($A)', rewrite: 'changedCall($A)',
      language: 'typescript', max_results: 10, dry_run: true,
    }, 30000),
    /AST_REWRITE_OVERLAP/,
  );

  const trailingPath = path.join(src, 'trailing.ts');
  await fs.writeFile(trailingPath, 'trailingCall(1);NEXT();\n', 'utf8');
  const trailingRule = {
    project_folder: src, pattern: 'trailingCall($A);', rewrite: 'trailingWrapped($A);\n',
    language: 'typescript', dry_run: true,
  };
  const trailingPreview = await callBuiltinAcceleratorTool('ast_rewrite', trailingRule, 30000);
  await callBuiltinAcceleratorTool('ast_rewrite', {
    ...trailingRule, dry_run: false, expected_preview_id: trailingPreview.previewId,
    expected_files: trailingPreview.applyExpectedFiles,
  }, 30000);
  assert.equal(await fs.readFile(trailingPath, 'utf8'), 'trailingWrapped(1);\nNEXT();\n');

  const previousAstGrepBin = process.env.AST_GREP_BIN;
  process.env.AST_GREP_BIN = process.execPath;
  try {
    await assert.rejects(
      () => callBuiltinAcceleratorTool('ast_search', {
        project_folder: src, pattern: 'NEXT()', language: 'typescript', max_results: 2,
      }, 10000),
      /AST_GREP_VERSION_MISMATCH/,
    );
  } finally {
    if (previousAstGrepBin === undefined) delete process.env.AST_GREP_BIN;
    else process.env.AST_GREP_BIN = previousAstGrepBin;
  }

  const manyPath = path.join(src, 'many.ts');
  await fs.writeFile(manyPath, Array.from({ length: 60 }, (_, index) => `manyCall(${index});`).join('\n') + '\n', 'utf8');
  const manyRule = {
    project_folder: src, pattern: 'manyCall($A)', rewrite: 'manyWrapped($A)',
    language: 'typescript', max_results: 100, max_patch_chars: 80, dry_run: true,
  };
  const manyPreview = await callBuiltinAcceleratorTool('ast_rewrite', manyRule, 30000);
  assert.equal(manyPreview.returnedMatches, 60);
  assert.equal(manyPreview.matches.length, 30);
  assert.equal(manyPreview.matchDetailsTruncated, true);
  assert.equal(manyPreview.omittedMatchDetails, 30);
  assert.equal(manyPreview.patchTruncated, true);
  assert.equal(manyPreview.requiresTruncatedPreviewAcknowledgement, true);
  assert(manyPreview.patchPreview.length < 200);
  await assert.rejects(
    () => callBuiltinAcceleratorTool('ast_rewrite', {
      ...manyRule, dry_run: false, expected_preview_id: manyPreview.previewId,
      expected_files: manyPreview.applyExpectedFiles,
    }, 30000),
    /AST_REWRITE_TRUNCATED_PREVIEW_REQUIRES_ACK/,
  );
  const manyApplied = await callBuiltinAcceleratorTool('ast_rewrite', {
    ...manyRule, dry_run: false, expected_preview_id: manyPreview.previewId,
    expected_files: manyPreview.applyExpectedFiles, allow_truncated_preview: true,
  }, 30000);
  assert.equal(manyApplied.applied, true);
  assert.equal(manyApplied.patchPreview, undefined, 'apply response repeated the large patch preview');
  assert.equal(manyApplied.matches, undefined, 'apply response repeated match details');
  assert.equal((await fs.readFile(manyPath, 'utf8')).match(/manyWrapped/g)?.length, 60);

  if (process.platform === 'win32') {
    const rollbackA = path.join(src, 'rollback-a.ts');
    const rollbackB = path.join(src, 'rollback-b.ts');
    const rollbackOriginalA = 'rollbackCall(1);\n';
    const rollbackOriginalB = 'rollbackCall(2);\n';
    await fs.writeFile(rollbackA, rollbackOriginalA, 'utf8');
    await fs.writeFile(rollbackB, rollbackOriginalB, 'utf8');
    const rollbackRule = {
      project_folder: src, pattern: 'rollbackCall($A)', rewrite: 'rollbackWrapped($A)',
      language: 'typescript', max_results: 10, timeout_ms: 7000, dry_run: true,
    };
    const rollbackPreview = await callBuiltinAcceleratorTool('ast_rewrite', rollbackRule, 10000);
    const locker = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$s=[IO.File]::Open($env:DC_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); Start-Sleep -Seconds 30; $s.Dispose()",
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DC_LOCK_TARGET: rollbackB } });
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('rollback locker readiness timeout')), 5000);
      locker.stdout.setEncoding('utf8');
      locker.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('READY')) { clearTimeout(timer); resolve(); }
      });
      locker.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    try {
      await assert.rejects(
        () => callBuiltinAcceleratorTool('ast_rewrite', {
          ...rollbackRule, dry_run: false, expected_preview_id: rollbackPreview.previewId,
          expected_files: rollbackPreview.applyExpectedFiles,
        }, 10000),
        /AST_REWRITE_APPLY_ABORTED/,
      );
    } finally {
      locker.kill('SIGKILL');
    }
    assert.equal(await fs.readFile(rollbackA, 'utf8'), rollbackOriginalA, 'first committed file was not rolled back');
    assert.equal(await fs.readFile(rollbackB, 'utf8'), rollbackOriginalB, 'locked second file changed unexpectedly');
    const leftovers = (await fs.readdir(src)).filter((name) => name.includes('.ast-new.tmp') || name.includes('.ast-backup.tmp'));
    assert.deepEqual(leftovers, [], `successful rollback leaked temp files: ${leftovers.join(', ')}`);
  }

  console.log('AST rewrite accelerator: PASS');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
