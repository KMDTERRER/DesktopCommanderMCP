#!/usr/bin/env node
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';
import { callBuiltinAcceleratorTool } from '../dist/tools/workspace-accelerators.js';

const FILE_COUNT = 17;
const GROWN_BYTES = 2 * 1024 * 1024 - 1024;

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function main() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-dc-context-budget-'));
  const realStat = fs.stat;
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'context-budget@example.invalid');
    git(root, 'config', 'user.name', 'Context Budget Test');
    git(root, 'config', 'core.autocrlf', 'false');
    const files = Array.from({ length: FILE_COUNT }, (_, index) => `src/file-${String(index).padStart(2, '0')}.ts`);
    await fs.mkdir(path.join(root, 'src'));
    await Promise.all(files.map((file) => fs.writeFile(path.join(root, file), 'export const needle = 1;\n', 'utf8')));
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'baseline');
    const targets = new Set(files.map((file) => path.resolve(root, file)));
    const grown = new Set();
    fs.stat = async (...args) => {
      const target = path.resolve(String(args[0]));
      const before = await realStat(...args);
      if (targets.has(target) && !grown.has(target)) {
        grown.add(target);
        await fs.writeFile(target, `export const needle = 1;\n${'x'.repeat(GROWN_BYTES)}`, 'utf8');
      }
      return before;
    };

    const result = await callBuiltinAcceleratorTool('context_pack', {
      root,
      query: 'needle',
      seedFiles: files,
      maxFiles: FILE_COUNT,
      contextLines: 0,
      maxLinesPerFile: 1,
      maxTotalChars: 5000,
    }, 30_000);

    assert.equal(grown.size, FILE_COUNT, `growth fixture reached ${grown.size}/${FILE_COUNT} candidates`);
    assert(result.inspectedCandidateCount < FILE_COUNT,
      `context_pack retained all ${FILE_COUNT} grown candidates despite a 32MiB aggregate inspection budget`);
    assert(result.inspectedBytes <= result.inspectionByteLimit);
    console.log('context_pack aggregate budget: PASS');
  } finally {
    fs.stat = realStat;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
