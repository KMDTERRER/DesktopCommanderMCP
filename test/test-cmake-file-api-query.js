import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { ensureCmakeFileApiQuery } from '../dist/tools/cmake-file-api-query.js';

async function exists(filePath) {
  try { await fs.lstat(filePath); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-cmake-query-'));
  const root = path.join(temp, 'repo');
  const outside = path.join(temp, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  try {
    const buildDir = path.join(root, 'build', 'clang');
    const first = await ensureCmakeFileApiQuery(root, buildDir, Date.now() + 5000);
    assert.equal(first.changed, true);
    assert.equal(await exists(first.path), true);
    const query = JSON.parse(await fs.readFile(first.path, 'utf8'));
    assert.deepEqual(query.requests, [
      { kind: 'codemodel', version: 2 },
      { kind: 'cmakeFiles', version: 1 },
      { kind: 'toolchains', version: 1 },
    ]);

    const second = await ensureCmakeFileApiQuery(root, buildDir, Date.now() + 5000);
    assert.equal(second.changed, false);
    assert.equal(second.sha256, first.sha256);

    const outsideMarker = path.join(outside, 'escaped.txt');
    const linkBuild = path.join(root, 'linked-build');
    let linkCreated = false;
    try {
      await fs.symlink(outside, linkBuild, process.platform === 'win32' ? 'junction' : 'dir');
      linkCreated = true;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
    }
    if (linkCreated) {
      await assert.rejects(
        () => ensureCmakeFileApiQuery(root, linkBuild, Date.now() + 5000),
        /real directory|escaped build root/,
      );
      assert.equal(await exists(outsideMarker), false);
      assert.equal(await exists(path.join(outside, '.cmake')), false);
    }

    console.log('cmake file api query tests: PASS');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
