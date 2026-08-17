#!/usr/bin/env node
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { readMultipleFiles } from '../dist/tools/filesystem.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-dc-multi-read-'));
  const files = Array.from({ length: 24 }, (_, index) => path.join(root, `file-${index}.txt`));
  const realRealpath = fs.realpath;
  const targets = new Set(files.map((file) => path.resolve(file)));
  let active = 0;
  let maxActive = 0;
  let realpathDelayMs = 50;
  try {
    await Promise.all(files.map((file, index) => fs.writeFile(file, `file-${index}\n`, 'utf8')));
    fs.realpath = async (...args) => {
      if (targets.has(path.resolve(String(args[0])))) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(realpathDelayMs);
        try { return await realRealpath(...args); } finally { active -= 1; }
      }
      return realRealpath(...args);
    };
    const results = await readMultipleFiles(files);
    assert.equal(results.length, files.length);
    assert(results.every((result) => !result.error), JSON.stringify(results.filter((result) => result.error)));
    assert(maxActive <= 8, `read_multiple_files opened ${maxActive} file validations concurrently; expected <= 8`);
    assert(maxActive >= 2, 'concurrency fixture did not observe parallel reads');

    realpathDelayMs = 600;
    const deadlineStarted = Date.now();
    const deadlineResults = await readMultipleFiles(files, 300);
    const deadlineElapsed = Date.now() - deadlineStarted;
    assert(deadlineElapsed < 800, `read_multiple_files ignored its 300ms batch deadline: ${deadlineElapsed}ms`);
    assert(deadlineResults.some((result) => result.error), 'deadline batch unexpectedly completed every file');
    console.log('read_multiple_files concurrency/deadline: PASS');
  } finally {
    fs.realpath = realRealpath;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
