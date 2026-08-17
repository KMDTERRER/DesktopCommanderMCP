#!/usr/bin/env node

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { terminateProcessTree } from '../dist/utils/process-tree.js';

import {
  cancellationCauseOf,
  classifyRequestAbortReason,
} from '../dist/utils/cancellation.js';
import {
  cancelToolCallOwnedWork,
  registerToolCallCancellationCleanup,
  runInToolCallContext,
} from '../dist/utils/client-context.js';
import { runWithAbortableTimeout } from '../dist/utils/withTimeout.js';

async function probeLateCancellationAfterResponse() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-cancellation-scope-'));
  const sentinel = path.join(home, 'process-survived.txt');
  const cfgDir = path.join(home, '.claude-server-commander');
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.writeFile(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ telemetryEnabled: false, allowedDirectories: [] }),
    'utf8',
  );
  await fs.writeFile(
    path.join(cfgDir, 'feature-flags.json'),
    JSON.stringify({ version: 'cancellation-test', flags: { onboarding_injection: false } }),
    'utf8',
  );

  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'dist', 'index.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', DC_FLAG_URL: 'http://127.0.0.1:9/',
    },
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  try {
    const survived = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`late-cancellation probe timed out; stderr=${stderr.slice(-2000)}`)), 15000);
      const finish = (value, error) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        for (;;) {
          const nl = stdout.indexOf('\n');
          if (nl < 0) break;
          const line = stdout.slice(0, nl).trim();
          stdout = stdout.slice(nl + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            const script = `const fs=require('fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(sentinel)},'alive'),400);setInterval(()=>{},1000)`;
            send({
              jsonrpc: '2.0', id: 2, method: 'tools/call',
              params: { name: 'start_process', arguments: {
                executable: process.execPath, args: ['-e', script],
                execution_kind: 'interactive', pty: 'never', timeout_ms: 100,
              } },
            });
          } else if (message.id === 2) {
            const pid = Number(message.result?.structuredContent?.pid);
            if (!(pid > 0)) return finish(undefined, new Error(`missing process pid: ${JSON.stringify(message)}`));
            send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'late cancellation probe' } });
            void (async () => {
              const deadline = Date.now() + 5000;
              let exists = false;
              while (!exists && Date.now() < deadline) {
                exists = await fs.stat(sentinel).then(() => true, () => false);
                if (!exists) await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
              }
              send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'force_terminate', arguments: { pid } } });
              finish(exists);
            })();
          }
        }
      });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => finish(undefined, error));
      child.on('exit', (code) => {
        if (code !== null && code !== 0) finish(undefined, new Error(`MCP child exited ${code}; stderr=${stderr.slice(-2000)}`));
      });
      send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cancellation-probe', version: '1.0.0' } },
      });
    });
    assert.equal(survived, true, 'late cancellation of a completed tool request killed its transferred process');
  } finally {
    try { child.stdin.end(); } catch {}
    await terminateProcessTree(child, 3000, true).catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true });
  }
}

let observedAbortReason;
let deadlineError;
try {
  await runWithAbortableTimeout(
    (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        observedAbortReason = signal.reason;
        reject(signal.reason);
      }, { once: true });
    }),
    25,
    'cancellation-cause-probe',
  );
} catch (error) {
  deadlineError = error;
}

assert(deadlineError instanceof Error, 'deadline did not reject');
assert.equal(deadlineError.code, 'ETIMEDOUT');
assert.equal(cancellationCauseOf(deadlineError), 'deadline_exceeded');
assert.equal(cancellationCauseOf(observedAbortReason), 'deadline_exceeded');

assert.equal(
  classifyRequestAbortReason({ code: 'REQUEST_TIMEOUT', message: 'Request timed out' }),
  'client_cancelled',
  'SDK REQUEST_TIMEOUT must not be treated as our deadline owner',
);
assert.equal(
  classifyRequestAbortReason(new Error('transport connection closed')),
  'transport_closed',
);
assert.equal(
  classifyRequestAbortReason(new Error('server shutting down')),
  'server_shutdown',
);
assert.equal(
  classifyRequestAbortReason(new Error('claim ownership lost')),
  'ownership_lost',
);

const cancellationState = {};
const cancellationCleanups = new Set();
let cleanupCause;
await runInToolCallContext(
  {
    isRemote: true,
    remoteClient: { name: 'test', version: '1' },
    cancellationState,
    cancellationCleanups,
  },
  async () => {
    registerToolCallCancellationCleanup((cause) => { cleanupCause = cause; });
    cancelToolCallOwnedWork('server_shutdown', 'test shutdown');
  },
);
assert.equal(cleanupCause, 'server_shutdown');
assert.equal(cancellationState.cause, 'server_shutdown');
assert.equal(cancellationState.detail, 'test shutdown');

await probeLateCancellationAfterResponse();

console.log('Cancellation cause: PASS');
