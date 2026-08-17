#!/usr/bin/env node

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { TerminalManager } from '../dist/terminal-manager.js';
import { getWindowsJobHelperPath } from '../dist/utils/windows-job-owner.js';

if (process.platform !== 'win32') {
  console.log('Windows Job owner: SKIP (non-Windows)');
  process.exit(0);
}

const POWERSHELL = path.join(
  process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-job-owner-'));
const manager = new TerminalManager();
const quotePs = (value) => `'${String(value).replaceAll("'", "''")}'`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  assert(await getWindowsJobHelperPath(), 'Windows Job helper did not compile');
  const sentinel = path.join(work, 'grandchild.txt');
  const rootScript = [
    `$file=${quotePs(sentinel)}`,
    `$child=Start-Process -FilePath ${quotePs(POWERSHELL)} ` +
      `-ArgumentList @('-NoProfile','-NonInteractive','-Command',` +
      `\"Start-Sleep -Seconds 2; Set-Content -LiteralPath '${sentinel.replaceAll("'", "''")}' -Value done\") ` +
      `-WindowStyle Hidden -PassThru`,
    `Write-Output ('ROOT_CHILD '+$child.Id)`,
  ].join('; ');
  const startedAt = Date.now();
  const completed = await manager.executeCommand(
    { executable: POWERSHELL, args: ['-NoProfile', '-NonInteractive', '-Command', rootScript] },
    7000, undefined, false, { executionKind: 'finite' },
  );
  const elapsed = Date.now() - startedAt;
  assert(completed.pid > 0, 'TerminalManager did not return target PID');
  assert(!completed.output.includes('__DC_JOB_'), 'Job helper control data leaked into tool output');
  assert(elapsed >= 1800, `Job-owned process completed before descendant (${elapsed}ms)`);
  assert(elapsed < 7000, `Job-owned process exceeded expected descendant lifetime (${elapsed}ms)`);
  assert(await fs.stat(sentinel).then(() => true, () => false), 'grandchild sentinel was not written');
  const longScript = [
    `$child=Start-Process -FilePath ${quotePs(POWERSHELL)} ` +
      `-ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') ` +
      `-WindowStyle Hidden -PassThru`,
    `Write-Output ('ROOT_CHILD '+$child.Id)`,
  ].join('; ');
  const running = await manager.executeCommand(
    { executable: POWERSHELL, args: ['-NoProfile', '-NonInteractive', '-Command', longScript] },
    800, undefined, false, { executionKind: 'finite' },
  );
  const childMatch = /ROOT_CHILD (\d+)/.exec(running.output);
  assert(childMatch, `missing descendant PID: ${running.output}`);
  const childPid = Number(childMatch[1]);
  assert.equal(manager.getSession(running.pid)?.processTreeOwner, 'windows_job');
  assert.equal(await manager.forceTerminate(running.pid), true, 'forceTerminate failed');
  await pause(300);
  let descendantAlive = true;
  try {
    execFileSync(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${childPid} -ErrorAction Stop | Out-Null`,
    ], { stdio: 'ignore' });
  } catch {
    descendantAlive = false;
  }
  assert.equal(descendantAlive, false, 'KILL_ON_JOB_CLOSE did not terminate descendant');

  let ptySpawnedPid = 0;
  let ptyOwner;
  const ptyResult = await manager.executePty(
    { executable: POWERSHELL, args: ['-NoProfile', '-NonInteractive', '-Command', longScript] },
    7000, undefined, false, {
      executionKind: 'finite',
      onSpawned: (pid) => {
        ptySpawnedPid = pid;
        ptyOwner = manager.getSession(pid)?.processTreeOwner;
      },
    },
  );
  const ptyChildMatch = /ROOT_CHILD\s+(\d+)/.exec(ptyResult.output);
  assert(ptyChildMatch, `missing PTY descendant PID: ${ptyResult.output}`);
  const ptyChildPid = Number(ptyChildMatch[1]);
  assert.equal(ptyOwner, 'windows_job', 'PTY host was not attached to a per-session Job');
  assert.equal(ptySpawnedPid, ptyResult.pid, 'PTY API PID changed across Job attachment');
  await pause(500);
  let ptyDescendantAlive = true;
  try {
    execFileSync(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${ptyChildPid} -ErrorAction Stop | Out-Null`,
    ], { stdio: 'ignore' });
  } catch {
    ptyDescendantAlive = false;
  }
  assert.equal(ptyDescendantAlive, false, 'PTY Job close did not terminate the remaining descendant tree');

  console.log('Windows Job owner: PASS');
} finally {
  for (const session of manager.listActiveSessions()) {
    await manager.forceTerminate(session.pid).catch(() => false);
  }
  await fs.rm(work, { recursive: true, force: true });
}
