#!/usr/bin/env node

import assert from 'node:assert/strict';

import { TerminalManager } from '../dist/terminal-manager.js';

let ptyAvailable = true;
try {
  await import('node-pty');
} catch {
  ptyAvailable = false;
}
if (!ptyAvailable) {
  console.log('PTY backpressure: SKIP (node-pty unavailable)');
  process.exit(0);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const manager = new TerminalManager();
const script = [
  "process.stdout.write('READY>')",
  "setTimeout(() => process.stdout.write('\\n' + 'A'.repeat(130000) + '\\n'), 20)",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', () => process.stdout.write('SECOND_MARKER\\n'))",
  'setInterval(() => {}, 1000)',
].join(';');

let pid;
try {
  const started = await manager.executePty(
    { executable: process.execPath, args: ['-e', script] },
    5000,
    undefined,
    false,
    { executionKind: 'interactive', detectPrompts: true },
  );
  pid = started.pid;
  assert(pid > 0, `invalid PTY pid ${pid}`);
  assert.equal(started.isBlocked, true, 'interactive producer should still be running');

  const pauseDeadline = Date.now() + 3000;
  let observed = manager.readOutputPaginated(pid, -1000, 1000);
  while (observed && !observed.flowControlPaused && Date.now() < pauseDeadline) {
    await pause(25);
    observed = manager.readOutputPaginated(pid, -1000, 1000);
  }
  assert(observed, 'missing active PTY session');
  assert.equal(observed.flowControlPaused, true, 'producer should pause above high watermark');
  assert((observed.unacknowledgedChars ?? 0) > 100000, 'consumer lag should exceed high watermark');
  assert.equal(manager.sendInputToProcess(pid, 'trigger'), true, 'could not trigger marker while producer was paused');
  await pause(100);
  const stillPaused = manager.readOutputPaginated(pid, -20, 20);
  assert(!stillPaused?.lines.join('\n').includes('SECOND_MARKER'), 'marker crossed a paused PTY producer');

  const observer = manager.readOutputPaginated(pid, 0, 1000, 'observer-chat');
  assert(observer, 'named reader could not read PTY output');
  assert.equal(observer.flowControlPaused, true, 'named observer must not ACK producer data');
  assert((observer.unacknowledgedChars ?? 0) > 100000, 'named observer unexpectedly changed ACK state');

  const acknowledged = manager.readOutputPaginated(pid, 0, 1000);
  assert(acknowledged, 'default reader could not ACK PTY output');
  assert.equal(acknowledged.flowControlPaused, false, 'default reader should resume below low watermark');
  assert((acknowledged.unacknowledgedChars ?? Infinity) < 5000, 'ACK did not reduce lag below low watermark');

  const deadline = Date.now() + 2000;
  let markerSeen = false;
  while (Date.now() < deadline && !markerSeen) {
    await pause(25);
    const tail = manager.readOutputPaginated(pid, -20, 20);
    markerSeen = Boolean(tail?.lines.join('\n').includes('SECOND_MARKER'));
  }
  assert.equal(markerSeen, true, 'producer did not resume after default-reader ACK');

  console.log('PTY backpressure: PASS');
} finally {
  if (pid) await manager.forceTerminate(pid, 'server_shutdown').catch(() => false);
}
