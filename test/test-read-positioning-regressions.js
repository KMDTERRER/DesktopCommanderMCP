#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configManager } from '../dist/config-manager.js';
import { readFile, readFileInternal } from '../dist/tools/filesystem.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-read-positioning-'));
const original = await configManager.getConfig();
try {
  await configManager.setValue('allowedDirectories', [root]);
  const large = path.join(root, 'large-variable-lines.txt');
  const short = Array.from({ length: 5000 }, (_, i) => `S_${String(i).padStart(4, '0')}\n`).join('');
  const long = Array.from({ length: 1500 }, (_, i) =>
    `LONG_${String(i).padStart(4, '0')}_${'x'.repeat(8000)}\n`
  ).join('');
  await fs.writeFile(large, short + long, 'utf8');
  const deep = await readFile(large, { offset: 6000, length: 1, includeStatusMessage: false });
  assert.match(String(deep.content), /^LONG_1000_/, 'deep offset returned an estimated nearby line instead of exact line 6001');

  const tailLine = `${'p'.repeat(100)}😀${'z'.repeat(8188)}`;
  await fs.appendFile(large, `${tailLine}\n`, 'utf8');
  const tail = await readFile(large, { offset: -1, length: 1, includeStatusMessage: false });
  assert.equal(String(tail.content), tailLine, 'large-file reverse tail corrupted or lost the final UTF-8 line');

  await fs.appendFile(large, 'CR_A\rCR_B\rCR_C', 'utf8');
  const crTail = await readFile(large, { offset: -2, length: 2, includeStatusMessage: false });
  assert.equal(String(crTail.content), 'CR_B\nCR_C', 'large-file reverse tail disagrees with readline on bare-CR line endings');

  const malformedUtf16 = path.join(root, 'truncated-utf16.txt');
  await fs.writeFile(malformedUtf16, Buffer.from([0xff, 0xfe, 0x41]));
  await assert.rejects(
    () => readFileInternal(malformedUtf16, 0, Number.MAX_SAFE_INTEGER),
    /Truncated UTF-16 code unit/,
    'full-buffer UTF-16 read silently discarded an incomplete code unit',
  );
  console.log('read positioning regressions: PASS');
} finally {
  await configManager.updateConfig(original).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
}
