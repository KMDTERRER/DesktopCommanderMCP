#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { terminalManager } from '../dist/terminal-manager.js';
import { startProcess, readProcessOutput } from '../dist/tools/improved-process-tools.js';
import { callBuiltinAcceleratorTool } from '../dist/tools/workspace-accelerators.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakePid = 987654;
const terminalError = 'synthetic terminal backend failure';

const fakeResult = (complete) => ({
  lines: [`[TERMINAL_ERROR: ${terminalError}]`],
  totalLines: 1, readFrom: 0, readCount: 1, remaining: 0,
  isComplete: complete, exitCode: complete ? 0 : undefined, runtimeMs: complete ? 10 : undefined,
  evictedLines: 0, backend: 'pipe', terminalError, rootExited: false,
  treeState: complete ? undefined : 'root_running', descendantPids: [],
  lastOutputTimeMs: Date.now(), noOutputForMs: 0,
});

const originalExecuteCommand = terminalManager.executeCommand;
const originalReadOutput = terminalManager.readOutputPaginated;
const originalGetSession = terminalManager.getSession;

try {
  terminalManager.executeCommand = async () => ({
    pid: fakePid, output: '', isBlocked: true, backend: 'pipe', terminalError,
  });
  terminalManager.readOutputPaginated = () => fakeResult(false);

  const started = await startProcess({
    executable: process.execPath, args: ['--version'], cwd: REPO_ROOT,
    execution_kind: 'finite', pty: 'never', timeout_ms: 1000,
  });
  assert.equal(started.structuredContent?.state, 'terminal_error');
  assert.equal(started.structuredContent?.terminalError, terminalError);
  assert.match(started.content[0].text, /TERMINAL ERROR/);

  terminalManager.getSession = () => undefined;
  terminalManager.readOutputPaginated = () => fakeResult(true);
  const read = await readProcessOutput({ pid: fakePid, offset: -10, length: 10, timeout_ms: 0 });
  assert.equal(read.structuredContent?.processSucceeded, false);
  assert.equal(read.structuredContent?.terminalError, terminalError);
  assert.match(read.content[0].text, /TERMINAL ERROR/);

  terminalManager.readOutputPaginated = () => fakeResult(false);
  const waited = await callBuiltinAcceleratorTool(
    'wait_process', { pid: fakePid, timeout_ms: 1000, tail_lines: 10 }, 12000,
  );
  assert.equal(waited.terminalFailed, true);
  assert.equal(waited.processSucceeded, false);
  assert.equal(waited.terminalError, terminalError);
  assert.equal(waited.timedOut, false);
} finally {
  terminalManager.executeCommand = originalExecuteCommand;
  terminalManager.readOutputPaginated = originalReadOutput;
  terminalManager.getSession = originalGetSession;
}

const originalStdoutWrite = process.stdout.write;
let captured = '';
process.stdout.write = function capture(chunk, encoding, callback) {
  captured += Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
    ? Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8')
    : String(chunk);
  if (typeof encoding === 'function') encoding();
  else if (typeof callback === 'function') callback();
  return true;
};

let transport;
try {
  const { FilteredStdioServerTransport } = await import('../dist/custom-stdio.js');
  transport = new FilteredStdioServerTransport();
  process.stdout.write(Buffer.from('{\"id\":1}\n'));
  assert.equal(captured, '', 'fake JSON/debug Buffer escaped onto protocol stdout');

  const frame = '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n';
  process.stdout.write(Buffer.from(frame));
  assert.equal(captured, frame, 'valid JSON-RPC Buffer frame was blocked');
} finally {
  transport?.cleanup();
  process.stdout.write = originalStdoutWrite;
}

console.log('Terminal error/output integrity contract: PASS');
