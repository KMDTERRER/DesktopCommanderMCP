import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import {
  acquireMutationResourceLease,
  acquireResourceLease,
} from '../dist/utils/resource-lease-owner.js';
import { acquireMutationResourceLocks } from '../dist/utils/mutation-resource-lock.js';

const __filename = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function childMode() {
  const target = process.argv[3];
  const holdMs = Number(process.argv[4] || 5000);
  const handle = await acquireResourceLease({
    kind: 'build', label: 'child-build', readPaths: [target], coverage: 'exact',
  }, Date.now() + 5000);
  process.stdout.write(`ACQUIRED:${handle.leaseId}\n`);
  await sleep(holdMs);
  await handle.release();
}

function spawnLeaseChild(target, holdMs = 5000) {
  const child = spawn(process.execPath, [__filename, '--child', target, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  const acquired = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child lease acquisition timed out')), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.includes('ACQUIRED:')) { clearTimeout(timer); resolve(); }
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      if (!output.includes('ACQUIRED:')) { clearTimeout(timer); reject(new Error(`child exited ${code}: ${output}`)); }
    });
  });
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, acquired, closed };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-resource-lease-'));
  const sourceA = path.join(root, 'src', 'a.cpp');
  const sourceB = path.join(root, 'src', 'b.cpp');
  const buildA = path.join(root, 'build-a');
  const buildB = path.join(root, 'build-b');
  await fs.mkdir(path.dirname(sourceA), { recursive: true });
  await fs.mkdir(buildA);
  await fs.mkdir(buildB);
  await fs.writeFile(sourceA, 'a');
  await fs.writeFile(sourceB, 'b');

  try {
    const build = await acquireResourceLease({
      kind: 'build', label: 'backend', readPaths: [sourceA], writeRoots: [buildA], coverage: 'exact',
    }, Date.now() + 3000);

    const unrelatedStarted = Date.now();
    const unrelated = await acquireMutationResourceLease([sourceB], Date.now() + 1000, { label: 'edit-b' });
    assert(Date.now() - unrelatedStarted < 500, 'unrelated mutation was blocked by build lease');
    await unrelated.release();

    let intersectingAcquired = false;
    const intersectingPending = acquireMutationResourceLease([sourceA], Date.now() + 3000, { label: 'edit-a' })
      .then((handle) => { intersectingAcquired = true; return handle; });
    await sleep(150);
    assert.equal(intersectingAcquired, false, 'writer bypassed active build read lease');
    await build.release();
    const intersecting = await intersectingPending;
    assert.equal(intersectingAcquired, true);
    await intersecting.release();

    const readerA = await acquireResourceLease({
      kind: 'build', label: 'reader-a', readPaths: [sourceA], coverage: 'exact',
    }, Date.now() + 1000);
    const readerBStarted = Date.now();
    const readerB = await acquireResourceLease({
      kind: 'build', label: 'reader-b', readPaths: [sourceA], coverage: 'exact',
    }, Date.now() + 1000);
    assert(Date.now() - readerBStarted < 500, 'build read/read leases should coexist');
    await readerB.release();
    await readerA.release();

    const outputOwner = await acquireResourceLease({
      kind: 'build', label: 'output-a', writeRoots: [buildA], coverage: 'exact',
    }, Date.now() + 1000);
    let overlappingOutputAcquired = false;
    const overlappingOutput = acquireResourceLease({
      kind: 'build', label: 'output-a-2', writeRoots: [path.join(buildA, 'nested')], coverage: 'exact',
    }, Date.now() + 3000).then((handle) => { overlappingOutputAcquired = true; return handle; });
    const independentOutput = await acquireResourceLease({
      kind: 'build', label: 'output-b', writeRoots: [buildB], coverage: 'exact',
    }, Date.now() + 1000);
    await sleep(120);
    assert.equal(overlappingOutputAcquired, false, 'overlapping build output roots ran concurrently');
    await independentOutput.release();
    await outputOwner.release();
    const outputOwner2 = await overlappingOutput;
    await outputOwner2.release();

    const watch = await acquireResourceLease({
      kind: 'build', label: 'glob-watch', watchRoots: [path.join(root, 'src')], coverage: 'historical',
    }, Date.now() + 1000);
    const contentWrite = await acquireMutationResourceLease([sourceA], Date.now() + 1000, { label: 'content-only' });
    await contentWrite.release();
    let topologyAcquired = false;
    const topologyTarget = path.join(root, 'src', 'new.cpp');
    const topologyPending = acquireMutationResourceLease([topologyTarget], Date.now() + 3000, {
      label: 'create-source', topologyPaths: [topologyTarget],
    }).then((handle) => { topologyAcquired = true; return handle; });
    await sleep(120);
    assert.equal(topologyAcquired, false, 'topology mutation bypassed active glob watch');
    await watch.release();
    const topology = await topologyPending;
    await topology.release();

    const manyReads = Array.from({ length: 1000 }, (_, index) => path.join(root, 'many', `${index}.hpp`));
    const compact = await acquireResourceLease({
      kind: 'build', label: 'many-inputs', readPaths: manyReads, coverage: 'historical',
    }, Date.now() + 2000);
    const leaseDirEntries = await fs.readdir(path.dirname(compact.manifestPath));
    assert.equal(leaseDirEntries.filter((name) => /^rl_[a-f0-9]{32}\.json$/.test(name)).length, 1,
      'one build lease must publish one manifest, not one lock file per input');
    await compact.release();

    const cleanupLease = await acquireMutationResourceLease([sourceB], Date.now() + 1000, { label: 'cleanup-gate' });
    const cleanupManifest = cleanupLease.manifestPath;
    const registryGate = path.join(os.tmpdir(), 'desktop-commander-resource-leases-v1', '.registry-gate');
    const releaseRegistryGate = await acquireMutationResourceLocks(
      [registryGate], Date.now() + 1000, { topologyMode: 'none' },
    );
    try {
      const releaseStarted = Date.now();
      await cleanupLease.release();
      assert(Date.now() - releaseStarted < 1500, 'lease cleanup blocked the completed mutation outcome');
      await assert.rejects(() => fs.stat(cleanupManifest), (error) => error?.code === 'ENOENT');
    } finally {
      await releaseRegistryGate();
    }

    const child = spawnLeaseChild(sourceA);
    await child.acquired;
    let crossProcessWriterAcquired = false;
    const crossProcessWriter = acquireMutationResourceLease([sourceA], Date.now() + 4000, { label: 'parent-writer' })
      .then((handle) => { crossProcessWriterAcquired = true; return handle; });
    await sleep(150);
    assert.equal(crossProcessWriterAcquired, false, 'cross-process writer bypassed build lease');
    child.child.kill('SIGKILL');
    await child.closed;
    const parentWriter = await crossProcessWriter;
    assert.equal(crossProcessWriterAcquired, true, 'dead build owner lease was not reaped');
    await parentWriter.release();

    console.log('resource lease owner tests: PASS');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--child') {
  childMode().catch((error) => { console.error(error); process.exit(1); });
} else {
  main().catch((error) => { console.error(error); process.exit(1); });
}
