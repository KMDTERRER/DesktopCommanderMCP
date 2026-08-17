#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configManager } from '../dist/config-manager.js';
import { listDirectory, readFile } from '../dist/tools/filesystem.js';
import { ListDirectoryArgsSchema } from '../dist/tools/schemas.js';

async function createFiles(dir, count, prefix) {
  for (let start = 0; start < count; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, count - start) }, (_, offset) =>
      fs.writeFile(path.join(dir, `${prefix}-${start + offset}.txt`), '', 'utf8')));
  }
}

async function main() {
  assert.equal(ListDirectoryArgsSchema.safeParse({ path: '.', depth: 0 }).success, false);
  assert.equal(ListDirectoryArgsSchema.safeParse({ path: '.', depth: 11 }).success, false);
  assert.equal(ListDirectoryArgsSchema.safeParse({ path: '.', depth: 1.5 }).success, false);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-list-bounds-'));
  const originalAllowed = (await configManager.getConfig()).allowedDirectories;
  try {
    await configManager.setValue('allowedDirectories', [root]);
    const huge = path.join(root, 'huge');
    await fs.mkdir(huge);
    await createFiles(huge, 2050, 'top');
    const listing = await listDirectory(huge, 1);
    assert(listing.length <= 2000, `listing retained ${listing.length} rows`);
    assert(listing.at(-1)?.includes('global 2000-item / 1 MiB output limit'));
    assert(Buffer.byteLength(listing.join('\n'), 'utf8') <= 1024 * 1024);
    const nestedRoot = path.join(root, 'nested');
    const child = path.join(nestedRoot, 'child');
    await fs.mkdir(child, { recursive: true });
    await createFiles(child, 120, 'nested');
    const nested = await listDirectory(nestedRoot, 2);
    assert(nested.some((line) => line.includes('additional items hidden')),
      'nested 100-item boundary was not reported');
    assert(nested.filter((line) => line.includes('nested-')).length <= 100);

    const directoryRead = await readFile(huge);
    assert.equal(directoryRead.metadata?.isDirectory, true);
    assert(Buffer.byteLength(String(directoryRead.content), 'utf8') <= 1024 * 1024 + 512,
      'read_file directory fallback bypassed list_directory output bounds');
    console.log('list_directory bounds: PASS');
  } finally {
    await configManager.setValue('allowedDirectories', originalAllowed);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
