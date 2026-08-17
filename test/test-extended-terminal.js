import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  forceTerminate,
  interactWithProcess,
  startProcess,
} from '../dist/tools/improved-process-tools.js';
import { commandManager } from '../dist/command-manager.js';

function textOf(result) {
  return result.content?.map((item) => item.text ?? '').join('\n') ?? '';
}

async function directProcessTest(root) {
  const result = await startProcess({
    executable: process.execPath,
    args: ['-e', "process.stdout.write(process.cwd()+'|'+process.env.DC_TERMINAL_MARKER)"],
    cwd: root,
    env: { DC_TERMINAL_MARKER: 'DIRECT_OK' },
    execution_kind: 'finite',
    pty: 'never',
    timeout_ms: 5000,
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(result.structuredContent?.backend, 'pipe');
  assert.equal(result.structuredContent?.launchMode, 'direct');
  assert.equal(result.structuredContent?.processSucceeded, true);
  assert(textOf(result).includes('DIRECT_OK'));
  assert(textOf(result).includes(root));
}

async function directStateDecoderAndPolicyTest(root) {
  const finite = await startProcess({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('compile >')"],
    cwd: root,
    execution_kind: 'finite',
    pty: 'never',
    timeout_ms: 5000,
  });
  assert.equal(finite.isError, undefined, textOf(finite));
  assert.equal(finite.structuredContent?.state, 'completed');
  assert.equal(finite.structuredContent?.processSucceeded, true);

  const splitUtf8 = await startProcess({
    executable: process.execPath,
    args: ['-e', "process.stdout.write(Buffer.from([0xe2,0x82]));setTimeout(()=>process.stdout.write(Buffer.from([0xac])),20)"],
    execution_kind: 'finite',
    pty: 'never',
    timeout_ms: 5000,
  });
  assert.equal(splitUtf8.isError, undefined, textOf(splitUtf8));
  assert(textOf(splitUtf8).includes('€'), `split UTF-8 output was corrupted: ${textOf(splitUtf8)}`);

  const service = await startProcess({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('service >');setTimeout(()=>{},2000)"],
    execution_kind: 'service',
    pty: 'never',
    timeout_ms: 150,
  });
  assert.equal(service.isError, undefined, textOf(service));
  assert.equal(service.structuredContent?.state, 'running');
  await forceTerminate({ pid: service.structuredContent?.pid });

  for (const flag of ['-encodedcommand', '-enc', '-e', '-ec', '-encodedarguments']) {
    assert.equal(await commandManager.validateExecutable('pwsh.exe', [flag, 'AA==']), false, `pwsh ${flag} bypassed policy`);
  }
  assert.equal(await commandManager.validateExecutable('pwsh.exe', ['-cwa', 'shutdown']), false);
  assert.equal(await commandManager.validateExecutable('pwsh.exe', ['-commandwithargs', 'shutdown']), false);
}

async function processLocalIoDeadlineTest(root) {
  const originalStat = fs.stat;
  try {
    fs.stat = async (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(root)) return new Promise(() => {});
      return originalStat(target, ...args);
    };
    const cwdResult = await startProcess({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('never')"],
      cwd: root,
      execution_kind: 'finite',
      pty: 'never',
      timeout_ms: 100,
    });
    assert.equal(cwdResult.isError, true, textOf(cwdResult));
    assert.match(textOf(cwdResult), /timed out/i);
  } finally {
    fs.stat = originalStat;
  }

  const virtual = await startProcess({ command: 'node:local', timeout_ms: 100 });
  const virtualPid = virtual.structuredContent?.pid;
  assert.equal(typeof virtualPid, 'number');
  const originalWriteFile = fs.writeFile;
  let writeSignal;
  try {
    fs.writeFile = async (file, data, options = {}) => {
      if (String(file).includes('.mcp-exec-')) {
        writeSignal = options.signal;
        return new Promise((resolve, reject) => {
          if (writeSignal?.aborted) { reject(new Error('aborted')); return; }
          writeSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return originalWriteFile(file, data, options);
    };
    const nodeLocal = await interactWithProcess({
      pid: virtualPid, input: "console.log('never')", timeout_ms: 100, wait_for_prompt: true,
    });
    assert.equal(nodeLocal.isError, true, textOf(nodeLocal));
    assert.match(textOf(nodeLocal), /timed out/i);
    assert.equal(writeSignal?.aborted, true, 'Node fallback temp write did not receive AbortSignal cancellation');
  } finally {
    fs.writeFile = originalWriteFile;
    await forceTerminate({ pid: virtualPid });
  }
}

async function ptyProcessTest() {
  let ptyAvailable = true;
  try {
    await import('node-pty');
  } catch {
    ptyAvailable = false;
  }
  if (!ptyAvailable) {
    console.log('extended terminal: PTY optional dependency unavailable; PTY smoke skipped');
    return;
  }

  const started = await startProcess({
    executable: process.execPath,
    args: ['-i'],
    execution_kind: 'interactive',
    pty: 'always',
    timeout_ms: 5000,
  });
  assert.equal(started.isError, undefined, textOf(started));
  assert.equal(started.structuredContent?.backend, 'pty');
  assert.equal(started.structuredContent?.state, 'waiting_for_input');
  const pid = started.structuredContent?.pid;
  assert.equal(typeof pid, 'number');

  try {
    const interaction = await interactWithProcess({
      pid,
      input: "console.log('PTY_INTERACTION_OK')",
      timeout_ms: 5000,
      wait_for_prompt: true,
    });
    assert.equal(interaction.isError, undefined, textOf(interaction));
    assert(textOf(interaction).includes('PTY_INTERACTION_OK'));
  } finally {
    await forceTerminate({ pid });
  }

  // Start immediately after termination to exercise serialized Windows ConPTY lifecycle.
  const tail = await startProcess({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(65536));process.stdout.write('\\nPTY_TAIL_MARKER\\n')"],
    execution_kind: 'finite',
    pty: 'always',
    timeout_ms: 5000,
  });
  assert.equal(tail.isError, undefined, textOf(tail));
  assert.equal(tail.structuredContent?.backend, 'pty');
  assert.equal(tail.structuredContent?.state, 'completed');
  const tailText = textOf(tail);
  assert(tailText.includes('PTY_TAIL_MARKER'), `PTY trailing output was lost at exit: ${tailText.slice(-1000)}`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-terminal-'));
try {
  await directProcessTest(root);
  await directStateDecoderAndPolicyTest(root);
  await processLocalIoDeadlineTest(root);
  await ptyProcessTest();
  console.log('extended terminal: PASS');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
