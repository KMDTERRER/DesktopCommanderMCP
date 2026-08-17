#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { terminateProcessTree } from '../dist/utils/process-tree.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-process-tree-'));
  const childScript = path.join(root, 'child.mjs');
  const parentScript = path.join(root, 'parent.mjs');
  const pidFile = path.join(root, 'descendant.pid');
  let descendantPid = 0;
  await fs.writeFile(childScript, 'setInterval(() => {}, 1000);\n', 'utf8');
  await fs.writeFile(parentScript, `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const [childScript, pidFile] = process.argv.slice(2);
const detached = process.platform === 'win32';
const child = spawn(process.execPath, [childScript], { detached, windowsHide: true, stdio: 'ignore' });
if (!child.pid) throw new Error('descendant did not start');
if (detached) child.unref();
fs.writeFileSync(pidFile, String(child.pid));
setInterval(() => {}, 1000);
`, 'utf8');

  const parent = spawn(process.execPath, [parentScript, childScript, pidFile], {
    detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { descendantPid = Number(await fs.readFile(pidFile, 'utf8')); break; }
      catch { await sleep(20); }
    }
    assert(Number.isInteger(descendantPid) && descendantPid > 0, 'descendant PID was not published');
    assert(processExists(descendantPid), 'descendant exited before termination probe');

    await terminateProcessTree(parent, 3_000, true);
    for (let attempt = 0; attempt < 50 && processExists(descendantPid); attempt++) await sleep(20);
    assert.equal(processExists(descendantPid), false, 'bounded process termination leaked a descendant');
    console.log('process tree termination: PASS');
  } finally {
    if (parent.pid && processExists(parent.pid)) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(parent.pid), '/T', '/F'], { windowsHide: true });
      else { try { process.kill(-parent.pid, 'SIGKILL'); } catch { parent.kill('SIGKILL'); } }
    }
    if (descendantPid && processExists(descendantPid)) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(descendantPid), '/T', '/F'], { windowsHide: true });
      else { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
