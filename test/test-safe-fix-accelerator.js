import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  callBuiltinAcceleratorTool,
  listBuiltinAcceleratorTools,
} from '../dist/tools/workspace-accelerators.js';
import { acquireMutationResourceLocks } from '../dist/utils/mutation-resource-lock.js';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
}

async function expectReject(fn, fragment) {
  let error;
  try { await fn(); } catch (caught) { error = caught; }
  assert(error, `Expected rejection containing: ${fragment}`);
  assert(String(error).includes(fragment), String(error));
}

async function main() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-dc-safe-fix-test-'));
  const fakeRuff = path.join(root, 'fake-ruff.mjs');
  const sourcePath = path.join(root, 'sample.py');
  const original = 'import os\nprint("x")\n';

  await fs.writeFile(fakeRuff, `
import fs from 'fs';
import path from 'path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('ruff 9.9.9-fake'); process.exit(0); }
if (!args.includes('--diff') || !args.includes('--no-unsafe-fixes') || !args.includes('--no-cache')) process.exit(42);
const marker = args.indexOf('--');
const file = args[marker + 1];
if (!file) process.exit(43);
if (process.env.FAKE_RUFF_MUTATE === '1') fs.appendFileSync(path.resolve(process.cwd(), file), '# mutated\\n');
let target = process.env.FAKE_RUFF_OUTSIDE === '1' ? 'outside.py' : file.split(path.sep).join('/');
if (process.env.FAKE_RUFF_UPPERCASE === '1') target = target.toUpperCase();
console.log('--- a/' + target);
console.log('+++ b/' + target);
console.log('@@ -1,2 +1 @@');
console.log('-import os');
console.log(' print("x")');
process.exit(1);
`, 'utf8');

  await fs.writeFile(sourcePath, original, 'utf8');
  git(root, 'init');
  git(root, 'config', 'user.email', 'safe-fix@example.invalid');
  git(root, 'config', 'user.name', 'Safe Fix Test');
  git(root, 'add', 'sample.py');
  git(root, 'commit', '-m', 'baseline');

  const previousBin = process.env.RUFF_BIN;
  const previousArgs = process.env.RUFF_BIN_ARGS;
  const previousOutside = process.env.FAKE_RUFF_OUTSIDE;
  const previousMutate = process.env.FAKE_RUFF_MUTATE;
  const previousUppercase = process.env.FAKE_RUFF_UPPERCASE;
  process.env.RUFF_BIN = process.execPath;
  process.env.RUFF_BIN_ARGS = JSON.stringify([fakeRuff]);
  try {
    const metadata = listBuiltinAcceleratorTools('safe_fix');
    assert.equal(metadata.readOnly, true);
    assert.equal(metadata.mutating, false);

    const preview = await callBuiltinAcceleratorTool('safe_fix', {
      root, files: ['sample.py'], engine: 'ruff', maxPatchChars: 10000,
    }, 10_000);
    assert.equal(preview.engine, 'ruff');
    assert.equal(preview.safeOnly, true);
    assert.equal(preview.sourceUnchanged, true);
    assert.equal(preview.changed, true);
    assert.deepEqual(preview.patchFiles, ['sample.py']);
    assert.deepEqual(preview.applyExpectedFiles, ['sample.py']);
    assert(preview.applyExpectedHashes['sample.py'].startsWith('sha256:'));
    assert.equal(await fs.readFile(sourcePath, 'utf8'), original);

    if (process.platform === 'win32') {
      process.env.FAKE_RUFF_UPPERCASE = '1';
      const upperPreview = await callBuiltinAcceleratorTool('safe_fix', {
        root, files: ['sample.py'], engine: 'ruff', maxPatchChars: 10000,
      }, 10_000);
      assert.deepEqual(upperPreview.patchFiles, ['SAMPLE.PY']);
      assert.equal(typeof upperPreview.applyExpectedHashes['SAMPLE.PY'], 'string');
      assert(upperPreview.applyExpectedHashes['SAMPLE.PY'].startsWith('sha256:'));
      delete process.env.FAKE_RUFF_UPPERCASE;
    }

    process.env.FAKE_RUFF_OUTSIDE = '1';
    await expectReject(() => callBuiltinAcceleratorTool('safe_fix', {
      root, files: ['sample.py'], engine: 'ruff',
    }, 10_000), 'outside the requested file set');
    delete process.env.FAKE_RUFF_OUTSIDE;

    process.env.FAKE_RUFF_MUTATE = '1';
    await expectReject(() => callBuiltinAcceleratorTool('safe_fix', {
      root, files: ['sample.py'], engine: 'ruff',
    }, 10_000), 'SAFE_FIX_ENGINE_MUTATED_SOURCE');
    delete process.env.FAKE_RUFF_MUTATE;
    await fs.writeFile(sourcePath, original, 'utf8');

    const growFiles = ['grow-a.py', 'grow-b.py', 'grow-c.py'];
    const growPaths = growFiles.map((file) => path.join(root, file));
    await Promise.all(growPaths.map((file) => fs.writeFile(file, 'x = 1\n', 'utf8')));
    const releaseGrowth = await acquireMutationResourceLocks(growPaths, Date.now() + 5_000);
    const growthPreview = expectReject(() => callBuiltinAcceleratorTool('safe_fix', {
      root, files: growFiles, engine: 'ruff',
    }, 20_000), 'total bytes');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const largePython = Buffer.alloc(12 * 1024 * 1024, 0x20);
    largePython.write('x = 1\n', 0, 'utf8');
    await Promise.all(growPaths.map((file) => fs.writeFile(file, largePython)));
    await releaseGrowth();
    await growthPreview;

    await expectReject(() => callBuiltinAcceleratorTool('safe_fix', {
      root, files: ['../outside.py'], engine: 'ruff',
    }, 10_000), 'escapes');

    process.env.RUFF_BIN = path.join(root, 'missing-ruff.exe');
    process.env.RUFF_BIN_ARGS = '[]';
    await expectReject(() => callBuiltinAcceleratorTool('safe_fix', {
      root, files: ['sample.py'], engine: 'ruff',
    }, 10_000), 'SAFE_FIX_ENGINE_UNAVAILABLE');

    console.log('safe_fix accelerator: PASS');
  } finally {
    if (previousBin === undefined) delete process.env.RUFF_BIN; else process.env.RUFF_BIN = previousBin;
    if (previousArgs === undefined) delete process.env.RUFF_BIN_ARGS; else process.env.RUFF_BIN_ARGS = previousArgs;
    if (previousOutside === undefined) delete process.env.FAKE_RUFF_OUTSIDE; else process.env.FAKE_RUFF_OUTSIDE = previousOutside;
    if (previousMutate === undefined) delete process.env.FAKE_RUFF_MUTATE; else process.env.FAKE_RUFF_MUTATE = previousMutate;
    if (previousUppercase === undefined) delete process.env.FAKE_RUFF_UPPERCASE; else process.env.FAKE_RUFF_UPPERCASE = previousUppercase;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
