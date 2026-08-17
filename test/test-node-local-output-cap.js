#!/usr/bin/env node
import assert from 'assert';
import fs from 'fs/promises';
import { startProcess, interactWithProcess } from '../dist/tools/improved-process-tools.js';

function resultText(result) {
  return result.content?.map((item) => item.type === 'text' ? item.text : '').join('\n') ?? '';
}

async function main() {
  const started = await startProcess({ command: 'node:local', timeout_ms: 5000 });
  const pidMatch = resultText(started).match(/PID (-\d+)/);
  assert(pidMatch, `node:local did not return a virtual PID: ${resultText(started)}`);
  const pid = Number(pidMatch[1]);

  const result = await interactWithProcess({
    pid,
    input: `process.stdout.write('x'.repeat(3 * 1024 * 1024));`,
    timeout_ms: 5000,
    wait_for_prompt: true,
  });

  const text = resultText(result);
  assert.equal(result.isError, true, 'node:local accepted output beyond its memory/response budget');
  assert.match(text, /output exceeded/i, `unexpected node:local overflow response: ${text.slice(0, 200)}`);
  assert(text.length < 128 * 1024, `overflow response itself is too large: ${text.length}`);

  const combined = await interactWithProcess({
    pid,
    input: `process.stdout.write('a'.repeat(1200 * 1024)); process.stderr.write('b'.repeat(1200 * 1024));`,
    timeout_ms: 5000,
    wait_for_prompt: true,
  });
  assert.equal(combined.isError, true, 'node:local allowed stdout+stderr to exceed the combined output budget');
  assert.match(resultText(combined), /output exceeded/i);

  const leftovers = (await fs.readdir(process.cwd())).filter((name) => name.startsWith('.mcp-exec-') && name.endsWith('.mjs'));
  assert.deepEqual(leftovers, [], `node:local leaked temp files: ${leftovers.join(', ')}`);
  console.log('node:local output cap: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
