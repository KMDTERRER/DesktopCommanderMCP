import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { atomicReplaceFileBytes } from '../dist/utils/atomic-file-write.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-atomic-file-write-'));
try {
  const target = path.join(root, 'state.bin');
  await fs.writeFile(target, Buffer.from('ORIGINAL'));

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => atomicReplaceFileBytes(target, Buffer.from('ABORTED'), { signal: aborted.signal }),
    (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR',
  );
  assert.equal((await fs.readFile(target)).toString(), 'ORIGINAL');

  await assert.rejects(
    () => atomicReplaceFileBytes(target, Buffer.from('LATE'), { deadlineAt: Date.now() - 1 }),
    (error) => error?.code === 'ETIMEDOUT',
  );
  assert.equal((await fs.readFile(target)).toString(), 'ORIGINAL');

  await atomicReplaceFileBytes(target, Buffer.from('PUBLISHED'), { deadlineAt: Date.now() + 5000 });
  assert.equal((await fs.readFile(target)).toString(), 'PUBLISHED');

  const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.atomic.tmp'));
  assert.deepEqual(leftovers, []);
  console.log('atomic file write: PASS');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
