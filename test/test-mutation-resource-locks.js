import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { acquireMutationResourceLocks, withMutationResourceLocks } from '../dist/utils/mutation-resource-lock.js';
import { handleCreateDirectory, handleMoveFile, handleWriteFile } from '../dist/handlers/filesystem-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runChild() {
  const resource = process.argv[3];
  const childId = process.argv[4];
  const holdMs = Number(process.argv[5]);
  const topologyMode = process.argv[6] || 'shared';
  await withMutationResourceLocks([resource], Date.now() + 5_000, async () => {
    console.log(JSON.stringify({ event: 'acquired', childId, at: Date.now() }));
    await sleep(holdMs);
  }, { topologyMode });
  console.log(JSON.stringify({ event: 'released', childId, at: Date.now() }));
}

function spawnLockChild(resource, childId, holdMs, topologyMode = 'shared') {
  const child = spawn(process.execPath, [__filename, '--lock-child', resource, childId, String(holdMs), topologyMode], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffered = '';
  let resolveAcquired;
  let rejectAcquired;
  const acquired = new Promise((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.event === 'acquired') resolveAcquired(event);
      } catch {}
    }
  });
  child.on('error', rejectAcquired);
  const closed = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, acquired, closed };
}

async function main() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-dc-mutation-lock-test-'));
  const resource = path.join(root, 'same-file.txt');
  try {
    let active = 0;
    let maxActive = 0;
    await Promise.all(Array.from({ length: 4 }, () =>
      withMutationResourceLocks([resource], Date.now() + 5_000, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(40);
        active -= 1;
      })
    ));
    assert.equal(maxActive, 1, 'same-process calls must serialize the same resource');

    let parallelActive = 0;
    let parallelMax = 0;
    const siblingResources = [path.join(root, 'parallel-a.txt'), path.join(root, 'parallel-b.txt')];
    await Promise.all(siblingResources.map((parallelResource) =>
      withMutationResourceLocks([parallelResource], Date.now() + 5_000, async () => {
        parallelActive += 1;
        parallelMax = Math.max(parallelMax, parallelActive);
        await sleep(80);
        parallelActive -= 1;
      })
    ));
    assert.equal(parallelMax, 2, 'shared topology leases must not serialize unrelated file mutations');

    const first = spawnLockChild(resource, 'first', 450);
    const firstAcquired = await first.acquired;
    const second = spawnLockChild(resource, 'second', 0);
    const secondAcquired = await second.acquired;
    assert(
      secondAcquired.at - firstAcquired.at >= 300,
      `second process acquired too early: ${secondAcquired.at - firstAcquired.at}ms`,
    );
    assert.equal((await first.closed).code, 0);
    assert.equal((await second.closed).code, 0);

    const doomed = spawnLockChild(resource, 'doomed', 5_000);
    await doomed.acquired;
    doomed.child.kill('SIGKILL');
    await doomed.closed;

    const staleStarted = Date.now();
    await withMutationResourceLocks([resource], Date.now() + 2_000, async () => undefined);
    assert(
      Date.now() - staleStarted < 1_500,
      'a dead process lock should be reaped instead of waiting for the full deadline',
    );

    const exactPublishFailureResource = path.join(root, 'exact-publish-failure.txt');
    const originalReadFile = fs.readFile;
    let injectedExactPublishFailure = false;
    fs.readFile = async (...args) => {
      const basename = path.basename(String(args[0]));
      if (!injectedExactPublishFailure && basename.endsWith('.lock') && !basename.includes('.topology-')) {
        injectedExactPublishFailure = true;
        const injected = new Error('injected exact publish metadata read failure');
        injected.code = 'EIO';
        throw injected;
      }
      return originalReadFile(...args);
    };
    try {
      await withMutationResourceLocks([exactPublishFailureResource], Date.now() + 1_000, async () => undefined);
    } finally {
      fs.readFile = originalReadFile;
    }
    assert(injectedExactPublishFailure, 'exact publish metadata failure fixture did not trigger');
    await withMutationResourceLocks([exactPublishFailureResource], Date.now() + 1_000, async () => undefined);

    const activeReadFailureResource = path.join(root, 'active-read-failure.txt');
    const activeIdentityRaw = path.normalize(path.resolve(activeReadFailureResource));
    const activeIdentity = process.platform === 'win32' ? activeIdentityRaw.toLowerCase() : activeIdentityRaw;
    const activeLockRoot = path.join(os.tmpdir(), 'desktop-commander-mutation-locks-v1');
    const activeLockPath = path.join(activeLockRoot, `${crypto.createHash('sha256').update(activeIdentity).digest('hex')}.lock`);
    const releaseActiveReadFailure = await acquireMutationResourceLocks([activeReadFailureResource], Date.now() + 2_000);
    const oldActiveTime = new Date(Date.now() - 60_000);
    await fs.utimes(activeLockPath, oldActiveTime, oldActiveTime);
    fs.readFile = async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(activeLockPath)) {
        const injected = new Error('persistent active owner metadata read failure');
        injected.code = 'EIO';
        throw injected;
      }
      return originalReadFile(...args);
    };
    try {
      await assert.rejects(
        () => withMutationResourceLocks([activeReadFailureResource], Date.now() + 400, async () => undefined),
        (error) => error?.code === 'ETIMEDOUT',
        'an unreadable active lock must fail closed instead of being reaped',
      );
    } finally {
      fs.readFile = originalReadFile;
      await releaseActiveReadFailure();
    }

    const sharedMetadataFailureResource = path.join(root, 'shared-metadata-failure.txt');
    let injectedSharedMetadataFailure = false;
    fs.readFile = async (...args) => {
      if (!injectedSharedMetadataFailure && path.basename(String(args[0])).includes('.topology-shared.')) {
        injectedSharedMetadataFailure = true;
        const injected = new Error('injected shared metadata read failure');
        injected.code = 'EIO';
        throw injected;
      }
      return originalReadFile(...args);
    };
    try {
      const releaseAfterRetry = await acquireMutationResourceLocks(
        [sharedMetadataFailureResource], Date.now() + 3_000,
      );
      await releaseAfterRetry();
    } finally {
      fs.readFile = originalReadFile;
    }
    assert(injectedSharedMetadataFailure, 'shared metadata failure fixture did not trigger');
    const sharedMetadataRecoveryStarted = Date.now();
    await withMutationResourceLocks(
      [sharedMetadataFailureResource], Date.now() + 1_500, async () => undefined, { topologyMode: 'exclusive' },
    );
    assert(
      Date.now() - sharedMetadataRecoveryStarted < 1_000,
      'failed shared owner verification leaked a live topology holder',
    );

    const releaseMetadataFailureResource = path.join(root, 'release-metadata-failure.txt');
    const releaseAfterMetadataFailure = await acquireMutationResourceLocks(
      [releaseMetadataFailureResource], Date.now() + 3_000,
    );
    let injectedReleaseMetadataFailure = false;
    fs.readFile = async (...args) => {
      const basename = path.basename(String(args[0]));
      if (!injectedReleaseMetadataFailure && basename.endsWith('.lock') && !basename.includes('.topology-')) {
        injectedReleaseMetadataFailure = true;
        const injected = new Error('injected release metadata read failure');
        injected.code = 'EIO';
        throw injected;
      }
      return originalReadFile(...args);
    };
    try {
      await releaseAfterMetadataFailure();
    } finally {
      fs.readFile = originalReadFile;
    }
    assert(injectedReleaseMetadataFailure, 'release metadata failure fixture did not trigger');
    const releaseMetadataRecoveryStarted = Date.now();
    await withMutationResourceLocks([releaseMetadataFailureResource], Date.now() + 1_000, async () => undefined);
    assert(
      Date.now() - releaseMetadataRecoveryStarted < 700,
      'a transient release metadata read failure leaked a live-PID exact lock',
    );

    const releaseUnlinkFailureResource = path.join(root, 'release-unlink-failure.txt');
    const releaseAfterUnlinkFailure = await acquireMutationResourceLocks(
      [releaseUnlinkFailureResource], Date.now() + 3_000,
    );
    const originalUnlink = fs.unlink;
    let injectedReleaseUnlinkFailure = false;
    fs.unlink = async (...args) => {
      const basename = path.basename(String(args[0]));
      if (!injectedReleaseUnlinkFailure && basename.endsWith('.lock') && !basename.includes('.topology-')) {
        injectedReleaseUnlinkFailure = true;
        const injected = new Error('injected release unlink failure');
        injected.code = 'EBUSY';
        throw injected;
      }
      return originalUnlink(...args);
    };
    try {
      await releaseAfterUnlinkFailure();
    } finally {
      fs.unlink = originalUnlink;
    }
    assert(injectedReleaseUnlinkFailure, 'release unlink failure fixture did not trigger');
    const releaseUnlinkRecoveryStarted = Date.now();
    await withMutationResourceLocks([releaseUnlinkFailureResource], Date.now() + 1_000, async () => undefined);
    assert(
      Date.now() - releaseUnlinkRecoveryStarted < 700,
      'a transient release unlink failure leaked a live-PID exact lock',
    );

    const doomedExclusiveResource = path.join(root, 'doomed-exclusive.txt');
    const doomedExclusive = spawnLockChild(doomedExclusiveResource, 'doomed-exclusive', 5_000, 'exclusive');
    await doomedExclusive.acquired;
    doomedExclusive.child.kill('SIGKILL');
    await doomedExclusive.closed;
    const exclusiveRecoveryStarted = Date.now();
    await withMutationResourceLocks([doomedExclusiveResource], Date.now() + 2_000, async () => undefined);
    assert(
      Date.now() - exclusiveRecoveryStarted < 1_500,
      'a dead topology-exclusive owner should be reaped before a shared mutation proceeds',
    );

    const orphanResource = path.join(root, 'orphan-owner.txt');
    const orphanIdentityRaw = path.normalize(path.resolve(orphanResource));
    const orphanIdentity = process.platform === 'win32' ? orphanIdentityRaw.toLowerCase() : orphanIdentityRaw;
    const lockRoot = path.join(os.tmpdir(), 'desktop-commander-mutation-locks-v1');
    const orphanLock = path.join(lockRoot, `${crypto.createHash('sha256').update(orphanIdentity).digest('hex')}.lock`);
    await fs.mkdir(lockRoot, { recursive: true });
    await fs.writeFile(orphanLock, '', 'utf8');
    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(orphanLock, oldTime, oldTime);
    try {
      const orphanStarted = Date.now();
      await withMutationResourceLocks([orphanResource], Date.now() + 1_000, async () => undefined);
      assert(Date.now() - orphanStarted < 800, 'an abandoned metadata-less lock should be reaped');
    } finally {
      await fs.rm(orphanLock, { force: true });
      await fs.rm(`${orphanLock}.reap`, { force: true });
    }

    await fs.writeFile(resource, 'before\n', 'utf8');
    const releaseWrite = await acquireMutationResourceLocks([resource], Date.now() + 5_000);
    let writeSettled = false;
    const writePromise = handleWriteFile({ path: resource, content: 'after\n', mode: 'rewrite' })
      .then((result) => { writeSettled = true; return result; });
    await sleep(150);
    assert.equal(writeSettled, false, 'write_file bypassed an existing mutation lock');
    assert.equal(await fs.readFile(resource, 'utf8'), 'before\n');
    await releaseWrite();
    const writeResult = await writePromise;
    assert.notEqual(writeResult.isError, true, JSON.stringify(writeResult));
    assert.equal(await fs.readFile(resource, 'utf8'), 'after\n');

    const moved = path.join(root, 'moved.txt');
    const releaseMove = await acquireMutationResourceLocks([resource, moved], Date.now() + 5_000);
    let moveSettled = false;
    const movePromise = handleMoveFile({ source: resource, destination: moved })
      .then((result) => { moveSettled = true; return result; });
    await sleep(150);
    assert.equal(moveSettled, false, 'move_file bypassed existing mutation locks');
    assert.equal(await fs.readFile(resource, 'utf8'), 'after\n');
    await assert.rejects(fs.stat(moved), (error) => error?.code === 'ENOENT');
    await releaseMove();
    const moveResult = await movePromise;
    assert.notEqual(moveResult.isError, true, JSON.stringify(moveResult));
    assert.equal(await fs.readFile(moved, 'utf8'), 'after\n');

    const treeSource = path.join(root, 'tree-source');
    const treeNested = path.join(treeSource, 'nested');
    const treeFile = path.join(treeNested, 'child.txt');
    const treeDestination = path.join(root, 'tree-destination');
    await fs.mkdir(treeNested, { recursive: true });
    await fs.writeFile(treeFile, 'tree-before\n', 'utf8');
    const descendantChild = spawnLockChild(treeFile, 'descendant', 450);
    await descendantChild.acquired;
    let directoryMoveSettled = false;
    const directoryMovePromise = handleMoveFile({ source: treeSource, destination: treeDestination })
      .then((result) => { directoryMoveSettled = true; return result; });
    await sleep(150);
    assert.equal(directoryMoveSettled, false, 'directory move bypassed a mutation lock held by a descendant file');
    assert.equal(await fs.readFile(treeFile, 'utf8'), 'tree-before\n');
    assert.equal((await descendantChild.closed).code, 0);
    const directoryMoveResult = await directoryMovePromise;
    assert.notEqual(directoryMoveResult.isError, true, JSON.stringify(directoryMoveResult));
    assert.equal(await fs.readFile(path.join(treeDestination, 'nested', 'child.txt'), 'utf8'), 'tree-before\n');

    const createdDirectory = path.join(root, 'created-directory');
    const releaseCreate = await acquireMutationResourceLocks([createdDirectory], Date.now() + 5_000);
    let createSettled = false;
    const createPromise = handleCreateDirectory({ path: createdDirectory })
      .then((result) => { createSettled = true; return result; });
    await sleep(150);
    assert.equal(createSettled, false, 'create_directory bypassed an existing mutation lock');
    await assert.rejects(fs.stat(createdDirectory), (error) => error?.code === 'ENOENT');
    await releaseCreate();
    const createResult = await createPromise;
    assert.notEqual(createResult.isError, true, JSON.stringify(createResult));
    assert.equal((await fs.stat(createdDirectory)).isDirectory(), true);

    console.log('mutation resource locks: PASS');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--lock-child') {
  runChild().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
