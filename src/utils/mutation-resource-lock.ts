import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const LOCK_ROOT = path.join(os.tmpdir(), 'desktop-commander-mutation-locks-v1');
const LOCK_POLL_MS = 25;
const WINDOWS_OPEN_CONTENTION_RETRY_MAX = 20;
const UNKNOWN_OWNER_GRACE_MS = 5_000;
const MAX_LOCK_METADATA_BYTES = 4 * 1024;

type LockOwner = { pid: number; token: string; createdAt: number };
type HeldLock = { handle: fs.FileHandle; lockPath: string; token: string };
export type MutationTopologyMode = 'shared' | 'exclusive' | 'none';
export type MutationResourceMode = 'shared' | 'exclusive';
export type MutationLockOptions = {
  topologyMode?: MutationTopologyMode;
  resourceMode?: MutationResourceMode;
};

function timeoutError(resources: string[]): NodeJS.ErrnoException {
  const error = new Error(`Timed out waiting for mutation ownership of ${resources.length} resource(s).`) as NodeJS.ErrnoException;
  error.code = 'ETIMEDOUT';
  return error;
}

function remaining(deadlineAt: number, resources: string[]): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) throw timeoutError(resources);
  return value;
}

function resourceIdentity(resource: string): string {
  const normalized = path.normalize(path.resolve(resource));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function lockPathFor(identity: string): string {
  return path.join(LOCK_ROOT, `${crypto.createHash('sha256').update(identity).digest('hex')}.lock`);
}

function topologyScopeIdentity(resource: string): string {
  const root = path.parse(path.resolve(resource)).root || path.sep;
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

function topologyScopeKey(scope: string): string {
  return crypto.createHash('sha256').update(`topology:${scope}`).digest('hex');
}

function resourceScopeKey(identity: string): string {
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function resourceSharedPrefix(identity: string): string {
  return `${resourceScopeKey(identity)}.resource-shared.`;
}

function topologyExclusiveIdentity(scope: string): string {
  return `topology-exclusive:${scope}`;
}

function topologySharedPrefix(scope: string): string {
  return `${topologyScopeKey(scope)}.topology-shared.`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // Only an explicit no-such-process result is evidence that the owner died.
    // Permission and unknown platform errors stay fail-closed as "possibly alive".
    return code !== 'ESRCH';
  }
}

async function readLockOwnerStrict(lockPath: string): Promise<LockOwner | undefined> {
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_LOCK_METADATA_BYTES) return undefined;

  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: Partial<LockOwner>;
  try { parsed = JSON.parse(raw) as Partial<LockOwner>; } catch { return undefined; }
  if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) return undefined;
  if (typeof parsed.token !== 'string' || !parsed.token) return undefined;
  if (!Number.isFinite(parsed.createdAt)) return undefined;
  return { pid: Number(parsed.pid), token: parsed.token, createdAt: Number(parsed.createdAt) };
}

async function readLockOwnerWithRetry(lockPath: string): Promise<LockOwner | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const owner = await readLockOwnerStrict(lockPath);
      if (owner) return owner;
      try {
        await fs.stat(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
        lastError = error;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await sleep(10);
  }
  if (lastError) throw lastError;
  return undefined;
}

async function readLockOwnerFailClosed(lockPath: string): Promise<{ readable: boolean; owner?: LockOwner }> {
  try {
    return { readable: true, owner: await readLockOwnerStrict(lockPath) };
  } catch {
    return { readable: false };
  }
}

async function reapDeadOwner(lockPath: string): Promise<boolean> {
  let firstStats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    firstStats = await fs.stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
    return false;
  }

  const ownerRead = await readLockOwnerFailClosed(lockPath);
  if (!ownerRead.readable) return false;
  const owner = ownerRead.owner;
  if (owner) {
    if (processExists(owner.pid)) return false;
    // Re-read immediately before reclamation. Another reaper may already have
    // removed the stale lock and a new owner may have acquired the path.
    const confirmedRead = await readLockOwnerFailClosed(lockPath);
    const confirmed = confirmedRead.owner;
    if (!confirmedRead.readable || !confirmed || confirmed.pid !== owner.pid ||
        confirmed.token !== owner.token || processExists(confirmed.pid)) {
      return false;
    }
  } else {
    // A process can die after exclusive-create but before writing owner metadata.
    // Give an active creator a generous grace interval, then reclaim only if
    // size/mtime are still unchanged and metadata remains readable but absent.
    if (Date.now() - firstStats.mtimeMs < UNKNOWN_OWNER_GRACE_MS) return false;
    let confirmedStats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      confirmedStats = await fs.stat(lockPath);
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    }
    if (confirmedStats.size !== firstStats.size || confirmedStats.mtimeMs !== firstStats.mtimeMs) return false;
    const finalRead = await readLockOwnerFailClosed(lockPath);
    if (!finalRead.readable || finalRead.owner) return false;
  }

  const tombstone = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, tombstone);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return true;
    return false;
  }
  await fs.unlink(tombstone).catch(() => undefined);
  return true;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function acquireOne(identity: string, deadlineAt: number, allResources: string[]): Promise<HeldLock> {
  await fs.mkdir(LOCK_ROOT, { recursive: true });
  const lockPath = lockPathFor(identity);
  const token = crypto.randomUUID();
  let windowsOpenContentionRetries = 0;

  while (true) {
    remaining(deadlineAt, allResources);
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      windowsOpenContentionRetries = 0;
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), 'utf8');
        await handle.sync();
        const owner = await readLockOwnerWithRetry(lockPath);
        if (owner?.pid !== process.pid || owner.token !== token) {
          // The path was reclaimed/replaced while this creator was stalled. Do
          // not claim ownership of an unlinked/replaced inode; retry safely.
          await handle.close().catch(() => undefined);
          continue;
        }
        return { handle, lockPath, token };
      } catch (error) {
        await handle.close().catch(() => undefined);
        // Do not blindly unlink here: if this creator stalled, the path may now
        // belong to a newer owner. Metadata-less remnants are reclaimed after
        // UNKNOWN_OWNER_GRACE_MS by reapDeadOwner().
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? '';
      if (code !== 'EEXIST') {
        const windowsDeleteRace = process.platform === 'win32'
          && ['EACCES', 'EPERM', 'EBUSY'].includes(code)
          && windowsOpenContentionRetries < WINDOWS_OPEN_CONTENTION_RETRY_MAX;
        if (!windowsDeleteRace) throw error;
        windowsOpenContentionRetries += 1;
        await sleep(Math.min(LOCK_POLL_MS, remaining(deadlineAt, allResources)));
        continue;
      }
    }

    if (await reapDeadOwner(lockPath)) continue;
    const waitMs = Math.min(LOCK_POLL_MS, remaining(deadlineAt, allResources));
    await sleep(waitMs);
  }
}

async function readReleaseOwner(lockPath: string): Promise<LockOwner | undefined> {
  // A transient metadata read failure during release must not turn a healthy
  // live-PID lock into a permanent poison pill. Retry briefly, but never unlink
  // unless the expected owner token is actually observed.
  return readLockOwnerWithRetry(lockPath);
}

async function releaseOne(lock: HeldLock): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const retryableUnlinkCodes = new Set(['EACCES', 'EPERM', 'EBUSY']);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Re-verify the token before every unlink attempt. A retry must never
      // delete a path that was replaced by a newer owner after our first try.
      const owner = await readReleaseOwner(lock.lockPath);
      if (!owner || owner.pid !== process.pid || owner.token !== lock.token) return;
      try {
        await fs.unlink(lock.lockPath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code ?? '';
        if (code === 'ENOENT') return;
        if (!retryableUnlinkCodes.has(code) || attempt === 2) return;
      }
    } catch {
      // Best effort on shutdown/error paths. Never unlink an unverified owner.
      return;
    }
    await sleep(10);
  }
}

async function hasActiveResourceExclusive(identity: string): Promise<boolean> {
  return !(await reapDeadOwner(lockPathFor(identity)));
}

async function acquireResourceShared(
  identity: string, deadlineAt: number, allResources: string[],
): Promise<HeldLock> {
  await fs.mkdir(LOCK_ROOT, { recursive: true });
  const prefix = resourceSharedPrefix(identity);
  while (true) {
    remaining(deadlineAt, allResources);
    if (await hasActiveResourceExclusive(identity)) {
      await sleep(Math.min(LOCK_POLL_MS, remaining(deadlineAt, allResources)));
      continue;
    }
    const token = crypto.randomUUID();
    const lockPath = path.join(LOCK_ROOT, `${prefix}${process.pid}.${token}.lock`);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), 'utf8');
      await handle.sync();
      const owner = await readLockOwnerWithRetry(lockPath);
      if (owner?.pid !== process.pid || owner.token !== token) {
        await handle.close().catch(() => undefined);
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      const held = { handle, lockPath, token };
      if (await hasActiveResourceExclusive(identity)) {
        await releaseOne(held);
        await sleep(Math.min(LOCK_POLL_MS, remaining(deadlineAt, allResources)));
        continue;
      }
      return held;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }
}

async function hasActiveResourceShared(identity: string): Promise<boolean> {
  let names: string[];
  try {
    names = await fs.readdir(LOCK_ROOT);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  const prefix = resourceSharedPrefix(identity);
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.lock')) continue;
    if (!(await reapDeadOwner(path.join(LOCK_ROOT, name)))) return true;
  }
  return false;
}

async function acquireResourceExclusive(
  identity: string, deadlineAt: number, allResources: string[],
): Promise<HeldLock> {
  const held = await acquireOne(identity, deadlineAt, allResources);
  try {
    while (await hasActiveResourceShared(identity)) {
      await sleep(Math.min(LOCK_POLL_MS, remaining(deadlineAt, allResources)));
    }
    return held;
  } catch (error) {
    await releaseOne(held);
    throw error;
  }
}

async function hasActiveTopologyExclusive(scope: string): Promise<boolean> {
  const lockPath = lockPathFor(topologyExclusiveIdentity(scope));
  return !(await reapDeadOwner(lockPath));
}

async function acquireTopologyShared(
  scope: string,
  deadlineAt: number,
  allResources: string[],
): Promise<HeldLock> {
  await fs.mkdir(LOCK_ROOT, { recursive: true });
  const prefix = topologySharedPrefix(scope);

  while (true) {
    remaining(deadlineAt, allResources);
    if (await hasActiveTopologyExclusive(scope)) {
      await sleep(Math.min(LOCK_POLL_MS, remaining(deadlineAt, allResources)));
      continue;
    }

    const token = crypto.randomUUID();
    const lockPath = path.join(LOCK_ROOT, `${prefix}${process.pid}.${token}.lock`);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      throw error;
    }

    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), 'utf8');
      await handle.sync();
      const owner = await readLockOwnerWithRetry(lockPath);
      if (owner?.pid !== process.pid || owner.token !== token) {
        await handle.close().catch(() => undefined);
        // Shared holder names contain this acquire's UUID token, so no other
        // legitimate owner can reuse this exact path. Remove a failed publish
        // instead of leaving a live-PID ghost that would block exclusive topology.
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      const held = { handle, lockPath, token };
      // A topology-exclusive claimant may have appeared between our first check
      // and publishing the shared holder. Back out if so; the exclusive holder
      // will wait for this file to disappear before mutating topology.
      if (await hasActiveTopologyExclusive(scope)) {
        await releaseOne(held);
        await sleep(Math.min(LOCK_POLL_MS, remaining(deadlineAt, allResources)));
        continue;
      }
      return held;
    } catch (error) {
      await handle.close().catch(() => undefined);
      // Unlike exact resource locks, this shared path is UUID-unique to this
      // acquire attempt and can be cleaned unconditionally after our handle closes.
      await fs.unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }
}

async function hasActiveTopologyShared(scope: string): Promise<boolean> {
  let names: string[];
  try {
    names = await fs.readdir(LOCK_ROOT);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  const prefix = topologySharedPrefix(scope);
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.lock')) continue;
    const sharedPath = path.join(LOCK_ROOT, name);
    if (!(await reapDeadOwner(sharedPath))) return true;
  }
  return false;
}

async function acquireTopologyExclusive(
  scope: string,
  deadlineAt: number,
  allResources: string[],
): Promise<HeldLock> {
  // Publishing the exclusive sentinel first prevents new shared holders from
  // entering while we drain readers that already announced lower-level work.
  const held = await acquireOne(topologyExclusiveIdentity(scope), deadlineAt, allResources);
  try {
    while (await hasActiveTopologyShared(scope)) {
      await sleep(Math.min(LOCK_POLL_MS, remaining(deadlineAt, allResources)));
    }
    return held;
  } catch (error) {
    await releaseOne(held);
    throw error;
  }
}

export async function acquireMutationResourceLocks(
  resources: string[],
  deadlineAt: number,
  options: MutationLockOptions = {},
): Promise<() => Promise<void>> {
  const identities = [...new Set(resources.map(resourceIdentity))].sort();
  if (identities.length === 0) return async () => undefined;
  const topologyMode = options.topologyMode ?? 'shared';
  const resourceMode = options.resourceMode ?? 'exclusive';
  const topologyScopes = topologyMode === 'none'
    ? []
    : [...new Set(resources.map(topologyScopeIdentity))].sort();
  const topologyHeld: HeldLock[] = [];
  const held: HeldLock[] = [];
  const allResources = [...topologyScopes.map((scope) => `topology:${scope}`), ...identities];
  try {
    for (const scope of topologyScopes) {
      topologyHeld.push(topologyMode === 'exclusive'
        ? await acquireTopologyExclusive(scope, deadlineAt, allResources)
        : await acquireTopologyShared(scope, deadlineAt, allResources));
    }
    for (const identity of identities) {
      held.push(resourceMode === 'shared'
        ? await acquireResourceShared(identity, deadlineAt, allResources)
        : await acquireResourceExclusive(identity, deadlineAt, allResources));
    }
  } catch (error) {
    for (const lock of held.reverse()) await releaseOne(lock);
    for (const lock of topologyHeld.reverse()) await releaseOne(lock);
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    for (const lock of held.reverse()) await releaseOne(lock);
    for (const lock of topologyHeld.reverse()) await releaseOne(lock);
  };
}

export async function withMutationResourceLocks<T>(
  resources: string[],
  deadlineAt: number,
  operation: () => Promise<T>,
  options: MutationLockOptions = {},
): Promise<T> {
  const release = await acquireMutationResourceLocks(resources, deadlineAt, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}
