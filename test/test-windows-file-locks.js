#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { findWindowsFileLockers } from '../dist/utils/windows-file-locks.js';
import { terminateProcessTree } from '../dist/utils/process-tree.js';

if (process.platform !== 'win32') {
  console.log('windows file locks: SKIP (non-Windows)');
  process.exit(0);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-windows-locks-'));
const target = path.join(temp, 'locked.txt');
await fs.writeFile(target, 'lock regression\n', 'utf8');
let locker;

async function waitReady(child) {
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('locker readiness timeout')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (!output.includes('READY')) {
        clearTimeout(timer);
        reject(new Error(`locker exited before READY (${code})`));
      }
    });
  });
}

try {
  assert.deepEqual(await findWindowsFileLockers(target, 3000), []);

  locker = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$s=[IO.File]::Open($env:DC_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); Start-Sleep -Seconds 30; $s.Dispose()",
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DC_LOCK_TARGET: target },
  });
  await waitReady(locker);
  assert(locker.pid && locker.pid > 0);

  const single = await findWindowsFileLockers(target, 5000);
  assert(single.some((item) => item.pid === locker.pid), JSON.stringify(single));

  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () => findWindowsFileLockers(target, 5000)),
  );
  for (const result of concurrent) {
    assert(result.some((item) => item.pid === locker.pid), JSON.stringify(result));
  }

  console.log('windows file locks: PASS');
} finally {
  if (locker) await terminateProcessTree(locker).catch(() => locker.kill('SIGKILL'));
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
