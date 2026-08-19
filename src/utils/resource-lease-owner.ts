import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { acquireMutationResourceLocks, type MutationLockOptions } from './mutation-resource-lock.js';

const LEASE_ROOT = path.join(os.tmpdir(), 'desktop-commander-resource-leases-v1');
const REGISTRY_GATE = path.join(LEASE_ROOT, '.registry-gate');
const LEASE_POLL_MS = 25;
const RELEASE_GATE_TIMEOUT_MS = 500;
const UNKNOWN_OWNER_GRACE_MS = 5_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_LEASE_PATHS = 20_000;
const MAX_LABEL_CHARS = 512;

export type ResourceLeaseKind = 'build' | 'mutation';
export type ResourceLeaseCoverage = 'exact' | 'historical' | 'conservative' | 'incomplete';

export type ResourceLeaseRequest = {
  kind: ResourceLeaseKind;
  label?: string;
  workspaceRoot?: string;
  readPaths?: string[];
  readRoots?: string[];
  writePaths?: string[];
  writeRoots?: string[];
  topologyPaths?: string[];
  watchRoots?: string[];
  coverage?: ResourceLeaseCoverage;
};

type NormalizedLease = {
  version: 1;
  leaseId: string;
  token: string;
  pid: number;
  createdAt: number;
  kind: ResourceLeaseKind;
  label: string;
  workspaceRoot: string | null;
  readPaths: string[];
  readRoots: string[];
  writePaths: string[];
  writeRoots: string[];
  topologyPaths: string[];
  watchRoots: string[];
  coverage: ResourceLeaseCoverage;
};

export type ResourceLeaseHandle = {
  leaseId: string;
  manifestPath: string;
  release: () => Promise<void>;
};

const activeTokens = new Set<string>();

function pathIdentity(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizedPaths(values: string[] | undefined, label: string): string[] {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > MAX_LEASE_PATHS) {
    throw new Error(`${label} exceeds the resource lease path limit (${MAX_LEASE_PATHS}).`);
  }
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) {
      throw new Error(`${label} contains an invalid path.`);
    }
    result.add(pathIdentity(value));
  }
  return [...result].sort();
}

function normalizeRequest(request: ResourceLeaseRequest, leaseId: string, token: string): NormalizedLease {
  if (request.kind !== 'build' && request.kind !== 'mutation') throw new Error('Resource lease kind is invalid.');
  const label = request.label ?? request.kind;
  if (label.length > MAX_LABEL_CHARS || /[\0\r\n]/.test(label)) throw new Error('Resource lease label is invalid.');
  return {
    version: 1, leaseId, token, pid: process.pid, createdAt: Date.now(), kind: request.kind, label,
    workspaceRoot: request.workspaceRoot ? pathIdentity(request.workspaceRoot) : null,
    readPaths: normalizedPaths(request.readPaths, 'readPaths'),
    readRoots: normalizedPaths(request.readRoots, 'readRoots'),
    writePaths: normalizedPaths(request.writePaths, 'writePaths'),
    writeRoots: normalizedPaths(request.writeRoots, 'writeRoots'),
    topologyPaths: normalizedPaths(request.topologyPaths, 'topologyPaths'),
    watchRoots: normalizedPaths(request.watchRoots, 'watchRoots'),
    coverage: request.coverage ?? (request.kind === 'build' ? 'conservative' : 'exact'),
  };
}

function insideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function rootsOverlap(left: string, right: string): boolean {
  return insideOrEqual(left, right) || insideOrEqual(right, left);
}

function exactHitsExact(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const smaller = left.length <= right.length ? left : right;
  const larger = new Set(left.length <= right.length ? right : left);
  return smaller.some((item) => larger.has(item));
}

function exactHitsRoots(exact: string[], roots: string[]): boolean {
  return exact.some((item) => roots.some((root) => insideOrEqual(root, item)));
}

function rootsHitRoots(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => rootsOverlap(a, b)));
}

function writesConflictWithReads(writer: NormalizedLease, reader: NormalizedLease): boolean {
  const writerRoots = [...writer.writeRoots, ...writer.topologyPaths];
  return exactHitsExact(writer.writePaths, reader.readPaths)
    || exactHitsRoots(writer.writePaths, reader.readRoots)
    || exactHitsRoots(reader.readPaths, writerRoots)
    || rootsHitRoots(writerRoots, reader.readRoots);
}

function writesConflictWithWrites(left: NormalizedLease, right: NormalizedLease): boolean {
  const leftRoots = [...left.writeRoots, ...left.topologyPaths];
  const rightRoots = [...right.writeRoots, ...right.topologyPaths];
  return exactHitsExact(left.writePaths, right.writePaths)
    || exactHitsRoots(left.writePaths, rightRoots)
    || exactHitsRoots(right.writePaths, leftRoots)
    || rootsHitRoots(leftRoots, rightRoots);
}

function topologyConflictsWithWatches(topologyOwner: NormalizedLease, watcher: NormalizedLease): boolean {
  const topologyRoots = [...topologyOwner.topologyPaths, ...topologyOwner.writeRoots];
  return rootsHitRoots(topologyRoots, watcher.watchRoots);
}

function leasesConflict(left: NormalizedLease, right: NormalizedLease): boolean {
  // Ordinary mutation/mutation serialization remains owned by mutation-resource-lock.
  // These short manifests only close the race between builds and filesystem mutations.
  if (left.kind === 'mutation' && right.kind === 'mutation') return false;
  return writesConflictWithReads(left, right)
    || writesConflictWithReads(right, left)
    || writesConflictWithWrites(left, right)
    || topologyConflictsWithWatches(left, right)
    || topologyConflictsWithWatches(right, left);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
}

function leaseFilePath(leaseId: string): string {
  return path.join(LEASE_ROOT, `${leaseId}.json`);
}

function validateManifest(raw: unknown): NormalizedLease | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.leaseId !== 'string' || !/^rl_[a-f0-9]{32}$/.test(value.leaseId)) return null;
  if (typeof value.token !== 'string' || value.token.length < 16 || value.token.length > 128) return null;
  if (!Number.isInteger(value.pid) || Number(value.pid) <= 0 || !Number.isFinite(value.createdAt)) return null;
  if (value.kind !== 'build' && value.kind !== 'mutation') return null;
  if (!['exact', 'historical', 'conservative', 'incomplete'].includes(String(value.coverage))) return null;
  if (typeof value.label !== 'string' || value.label.length > MAX_LABEL_CHARS) return null;
  if (value.workspaceRoot !== null && typeof value.workspaceRoot !== 'string') return null;
  const fields = ['readPaths', 'readRoots', 'writePaths', 'writeRoots', 'topologyPaths', 'watchRoots'] as const;
  for (const field of fields) {
    const items = value[field];
    if (!Array.isArray(items) || items.length > MAX_LEASE_PATHS) return null;
    if (items.some((item) => typeof item !== 'string' || !path.isAbsolute(item) || pathIdentity(item) !== item)) return null;
  }
  return value as NormalizedLease;
}

async function readManifestBounded(filePath: string): Promise<{ lease: NormalizedLease | null; mtimeMs: number }> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_MANIFEST_BYTES) return { lease: null, mtimeMs: stats.mtimeMs };
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.min(MAX_MANIFEST_BYTES + 1, stats.size + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_MANIFEST_BYTES) return { lease: null, mtimeMs: stats.mtimeMs };
    let parsed: unknown;
    try { parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); } catch { parsed = null; }
    return { lease: validateManifest(parsed), mtimeMs: stats.mtimeMs };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function scanActiveLeases(): Promise<NormalizedLease[]> {
  let names: string[];
  try { names = await fs.readdir(LEASE_ROOT); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  const leases: NormalizedLease[] = [];
  for (const name of names) {
    if (!/^rl_[a-f0-9]{32}\.json$/.test(name)) continue;
    const filePath = path.join(LEASE_ROOT, name);
    let loaded: { lease: NormalizedLease | null; mtimeMs: number };
    try { loaded = await readManifestBounded(filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw error;
    }
    const lease = loaded.lease;
    if (!lease) {
      if (Date.now() - loaded.mtimeMs >= UNKNOWN_OWNER_GRACE_MS) {
        await fs.unlink(filePath).catch(() => undefined);
        continue;
      }
      const error = new Error(`Unreadable active resource lease manifest: ${filePath}`) as NodeJS.ErrnoException;
      error.code = 'ERESOURCELEASECORRUPT';
      throw error;
    }
    const inactiveLocal = lease.pid === process.pid && !activeTokens.has(lease.token);
    if (inactiveLocal || !processExists(lease.pid)) {
      await fs.unlink(filePath).catch(() => undefined);
      continue;
    }
    leases.push(lease);
  }
  return leases;
}

async function acquireRegistryGate(deadlineAt: number): Promise<() => Promise<void>> {
  await fs.mkdir(LEASE_ROOT, { recursive: true });
  return acquireMutationResourceLocks([REGISTRY_GATE], deadlineAt, { topologyMode: 'none' });
}

function waitBudget(deadlineAt: number, label: string): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error(`Timed out waiting for resource lease: ${label}`) as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function publishManifest(manifest: NormalizedLease, manifestPath: string): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error(`Resource lease manifest exceeds ${MAX_MANIFEST_BYTES} bytes; compact the access plan first.`);
  }
  const handle = await fs.open(manifestPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(manifestPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

async function releaseManifest(manifestPath: string, token: string, deadlineAt: number): Promise<void> {
  let releaseGate: (() => Promise<void>) | undefined;
  try {
    try {
      releaseGate = await acquireRegistryGate(deadlineAt);
    } catch {
      // Release is cleanup after the mutation/build outcome is already known.
      // Never turn a committed operation into an ambiguous error because the
      // registry gate is transiently unavailable. Ownership is re-verified below.
    }
    try {
      const loaded = await readManifestBounded(manifestPath);
      if (loaded.lease?.pid === process.pid && loaded.lease.token === token) {
        await fs.unlink(manifestPath).catch((error) => {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        });
      }
    } catch {
      // activeTokens is cleared in finally. A surviving local manifest is then
      // classified as inactive-local and safely reaped by the next registry scan.
    }
  } finally {
    activeTokens.delete(token);
    await releaseGate?.().catch(() => undefined);
  }
}

export async function acquireResourceLease(
  request: ResourceLeaseRequest, deadlineAt: number,
): Promise<ResourceLeaseHandle> {
  if (!Number.isFinite(deadlineAt)) throw new Error('Resource lease deadline must be finite.');
  const leaseId = `rl_${crypto.randomUUID().replace(/-/g, '')}`;
  const token = crypto.randomUUID();
  const manifest = normalizeRequest(request, leaseId, token);
  const manifestPath = leaseFilePath(leaseId);

  while (true) {
    waitBudget(deadlineAt, manifest.label);
    const releaseGate = await acquireRegistryGate(deadlineAt);
    let conflict: NormalizedLease | undefined;
    try {
      const active = await scanActiveLeases();
      conflict = active.find((other) => leasesConflict(manifest, other));
      if (!conflict) {
        activeTokens.add(token);
        try { await publishManifest(manifest, manifestPath); }
        catch (error) { activeTokens.delete(token); throw error; }
      }
    } finally {
      await releaseGate();
    }
    if (!conflict) {
      let released = false;
      return {
        leaseId, manifestPath,
        release: async () => {
          if (released) return;
          released = true;
          await releaseManifest(manifestPath, token, Date.now() + RELEASE_GATE_TIMEOUT_MS);
        },
      };
    }
    await sleep(Math.min(LEASE_POLL_MS, waitBudget(deadlineAt, `${manifest.label}; blocked by ${conflict.label}`)));
  }
}

export async function acquireMutationResourceLease(
  writePaths: string[], deadlineAt: number,
  options: { topologyPaths?: string[]; label?: string } = {},
): Promise<ResourceLeaseHandle> {
  return acquireResourceLease({
    kind: 'mutation', writePaths, topologyPaths: options.topologyPaths,
    label: options.label ?? 'filesystem mutation', coverage: 'exact',
  }, deadlineAt);
}

export async function acquireCoordinatedMutationOwnership(
  resources: string[], deadlineAt: number,
  options: MutationLockOptions & { topologyPaths?: string[]; label?: string } = {},
): Promise<() => Promise<void>> {
  const topologyPaths = options.topologyPaths
    ?? (options.topologyMode === 'exclusive' ? resources : []);
  const lease = await acquireMutationResourceLease(resources, deadlineAt, {
    topologyPaths, label: options.label,
  });
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await acquireMutationResourceLocks(resources, deadlineAt, {
      topologyMode: options.topologyMode, resourceMode: options.resourceMode,
    });
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await releaseLock!();
    await lease.release();
  };
}
