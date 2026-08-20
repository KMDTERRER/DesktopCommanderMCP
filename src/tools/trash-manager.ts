import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { isBinaryFile } from 'isbinaryfile';
import { configManager } from '../config-manager.js';
import { getToolCallSessionIdentity } from '../utils/client-context.js';
import { readFileBounded } from '../utils/bounded-file-read.js';
import { runBoundedSubprocess } from '../utils/bounded-subprocess.js';
import { acquireMutationResourceLocks } from '../utils/mutation-resource-lock.js';
import { acquireCoordinatedMutationOwnership } from '../utils/resource-lease-owner.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import {
  MANAGED_TRASH_DIRECTORY_NAME, MANAGED_TRASH_ENTRIES_DIRECTORY_NAME,
  MANAGED_TRASH_ENTRY_NAME, MANAGED_TRASH_RETENTION_MS, MANAGED_TRASH_SWEEP_INTERVAL_MS,
  isManagedTrashRelativePath, pathContainsManagedTrashSegment,
} from '../utils/trash-contract.js';
import { validatePathAuthority } from './path-security.js';

const TRASH_OPERATION_TIMEOUT_MS = 45_000;
const TRASH_COMMIT_RESERVE_MS = 500;
const TRASH_BACKGROUND_SWEEP_BUDGET_MS = 20_000;
const TRASH_MANIFEST_MAX_BYTES = 64 * 1024;
const TRASH_READ_MAX_BYTES = 1024 * 1024;
const TRASH_MAX_ENTRIES = 1000;
const TRASH_MAX_LIST_CHILDREN = 500;
const TRASH_PURGE_MAX_NODES = 100_000;
const TRASH_PURGE_MAX_DEPTH = 128;
const TRASH_MAX_WORKSPACES = 128;
const TRASH_MAX_SESSION_BINDINGS = 256;
const TRASH_WORKSPACE_REGISTRY_KEY = 'trashWorkspaceRootsV1';
const TRASH_GITIGNORE_CONTENT = '*\n';

type TrashKind = 'file' | 'directory' | 'symlink' | 'other';
type TrashManifest = {
  version: 1;
  name: string;
  workspaceRoot: string;
  originalRelativePath: string;
  displayName: string;
  kind: TrashKind;
  createdAt: number;
  expiresAt: number;
};

type PutTarget = {
  targetPath: string;
  workspaceRoot: string;
  relativePath: string;
  stats: Awaited<ReturnType<typeof fs.lstat>>;
};

type TrashStorage = {
  root: string;
  entries: string;
  marker: string;
};

function remaining(deadlineAt: number, label: string, maximum = 10_000): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error(`${label} deadline exceeded.`) as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.min(maximum, value));
}

function requireCommitReserve(deadlineAt: number, label: string): void {
  if (deadlineAt - Date.now() >= TRASH_COMMIT_RESERVE_MS) return;
  const error = new Error(`${label} deadline too close to rename commit; no rename was started.`) as NodeJS.ErrnoException;
  error.code = 'ETIMEDOUT';
  throw error;
}

function slash(value: string): string {
  return value.replace(/\\/g, '/');
}

function pathIdentity(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathIdentity(left) === pathIdentity(right);
}

function setBoundedMap(map: Map<string, string>, key: string, value: string, maximum: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function kindOf(stats: Awaited<ReturnType<typeof fs.lstat>>): TrashKind {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

function normalizeStoredRelative(value: string): string {
  if (!value || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error('Trash manifest contains an invalid original path.');
  }
  const normalized = path.posix.normalize(slash(value));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')
      || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error('Trash manifest original path escapes the workspace.');
  }
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    throw new Error('Trash manifest may not target Git metadata.');
  }
  if (isManagedTrashRelativePath(normalized)) {
    throw new Error('Trash manifest may not target the managed trash directory.');
  }
  return normalized;
}

function storagePaths(workspaceRoot: string): TrashStorage {
  const root = path.join(workspaceRoot, MANAGED_TRASH_DIRECTORY_NAME);
  return {
    root,
    entries: path.join(root, MANAGED_TRASH_ENTRIES_DIRECTORY_NAME),
    marker: path.join(root, 'workspace.json'),
  };
}
async function lstatBounded(filePath: string, deadlineAt: number, label: string) {
  return runWithAbortableTimeout(
    (_signal) => fs.lstat(filePath),
    remaining(deadlineAt, label),
    label,
  );
}

async function realpathBounded(filePath: string, deadlineAt: number, label: string) {
  return runWithAbortableTimeout(
    (_signal) => fs.realpath(filePath),
    remaining(deadlineAt, label),
    label,
  );
}

async function readJsonBounded(filePath: string, deadlineAt: number): Promise<unknown> {
  const bytes = await runWithAbortableTimeout(
    (signal) => readFileBounded(filePath, TRASH_MANIFEST_MAX_BYTES, signal, 'trash metadata'),
    remaining(deadlineAt, `Read trash metadata ${filePath}`),
    `Read trash metadata ${filePath}`,
  );
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`Managed trash metadata is invalid JSON: ${filePath}`);
  }
}

async function ensureTrashGitIgnore(storage: TrashStorage, deadlineAt: number): Promise<void> {
  const ignorePath = path.join(storage.root, '.gitignore');
  try {
    await runWithAbortableTimeout(
      (signal) => fs.writeFile(ignorePath, TRASH_GITIGNORE_CONTENT, {
        encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true, signal,
      }),
      remaining(deadlineAt, 'Create managed trash Git exclude'), 'Create managed trash Git exclude',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
  }
  const stats = await lstatBounded(ignorePath, deadlineAt, 'Stat managed trash Git exclude');
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Managed trash .gitignore must be a real file.');
  }
  const bytes = await runWithAbortableTimeout(
    (signal) => readFileBounded(ignorePath, 128, signal, 'managed trash Git exclude'),
    remaining(deadlineAt, 'Read managed trash Git exclude'), 'Read managed trash Git exclude',
  );
  if (bytes.toString('utf8') !== TRASH_GITIGNORE_CONTENT) {
    throw new Error('Managed trash .gitignore does not match the owner-controlled ignore contract.');
  }
}

async function gitWorkspaceFrom(directory: string, deadlineAt: number): Promise<string> {
  const executable = process.platform === 'win32' ? 'git.exe' : 'git';
  const result = await runBoundedSubprocess(
    executable, ['-C', directory, 'rev-parse', '--path-format=absolute', '--show-toplevel'],
    {
      timeoutMs: remaining(deadlineAt, 'Resolve trash Git workspace', 10_000),
      maxOutputBytes: 256 * 1024,
      label: 'Resolve trash Git workspace',
    },
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error('trash_action only operates inside a Git working tree.');
  }
  const validated = await validatePathAuthority(
    result.stdout.trim(), remaining(deadlineAt, 'Validate trash Git workspace'),
  );
  const canonical = await realpathBounded(validated, deadlineAt, 'Canonicalize trash Git workspace');
  const stats = await lstatBounded(canonical, deadlineAt, 'Stat trash Git workspace');
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('trash_action workspace root must be a real directory.');
  }
  return canonical;
}

async function validateWorkspaceRoot(raw: string, deadlineAt: number): Promise<string> {
  if (!raw || raw.length > 4096 || !path.isAbsolute(raw) || pathContainsManagedTrashSegment(raw)) {
    throw new Error('trash_action.workspace must be an absolute normal workspace path.');
  }
  const validated = await validatePathAuthority(
    raw, remaining(deadlineAt, 'Validate trash workspace selector'),
  );
  const canonical = await realpathBounded(validated, deadlineAt, 'Canonicalize trash workspace selector');
  const gitRoot = await gitWorkspaceFrom(canonical, deadlineAt);
  if (!samePath(canonical, gitRoot)) {
    throw new Error(`trash_action.workspace must be the exact Git working-tree root: ${gitRoot}`);
  }
  return gitRoot;
}

async function resolvePutTarget(rawPath: string, deadlineAt: number, expectedWorkspace?: string): Promise<PutTarget> {
  if (!rawPath || rawPath.length > 4096 || !path.isAbsolute(rawPath) || pathContainsManagedTrashSegment(rawPath)) {
    throw new Error('trash_action.put path must be absolute and outside the reserved trash storage.');
  }
  const rawParent = path.dirname(rawPath);
  const baseName = path.basename(rawPath);
  if (!baseName || baseName === '.' || baseName === '..') throw new Error('trash_action.put requires a concrete item path.');
  const canonicalParent = await validatePathAuthority(
    rawParent, remaining(deadlineAt, 'Validate trash target parent'),
  );
  const targetPath = path.join(canonicalParent, baseName);
  const stats = await lstatBounded(targetPath, deadlineAt, `Stat trash target ${targetPath}`);
  const workspaceProbe = stats.isDirectory() && !stats.isSymbolicLink() ? targetPath : canonicalParent;
  const workspaceRoot = await gitWorkspaceFrom(workspaceProbe, deadlineAt);
  if (!isInside(workspaceRoot, targetPath)) {
    throw new Error('trash_action target resolves outside its Git workspace.');
  }
  const relativePath = normalizeStoredRelative(slash(path.relative(workspaceRoot, targetPath)));
  if (expectedWorkspace && !samePath(expectedWorkspace, workspaceRoot)) {
    throw new Error(`trash_action target belongs to '${workspaceRoot}', not requested workspace '${expectedWorkspace}'.`);
  }
  return { targetPath, workspaceRoot, relativePath, stats };
}

async function ensurePlainDirectory(
  directory: string, workspaceRoot: string, deadlineAt: number, create: boolean,
): Promise<boolean> {
  let stats;
  try {
    stats = await lstatBounded(directory, deadlineAt, `Stat managed trash directory ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    if (!create) return false;
    try {
      await runWithAbortableTimeout(
        (_signal) => fs.mkdir(directory, { mode: 0o700 }),
        remaining(deadlineAt, `Create managed trash directory ${directory}`),
        `Create managed trash directory ${directory}`,
      );
    } catch (mkdirError) {
      // Concurrent TrashManager calls may create the same manager-owned directory.
      // Only EEXIST is an acceptable race; the re-stat below still validates type.
      if ((mkdirError as NodeJS.ErrnoException)?.code !== 'EEXIST') throw mkdirError;
    }
    stats = await lstatBounded(directory, deadlineAt, `Re-stat managed trash directory ${directory}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Managed trash storage must be a real directory, not a link: ${directory}`);
  }
  const real = await realpathBounded(directory, deadlineAt, `Resolve managed trash directory ${directory}`);
  if (!isInside(workspaceRoot, real)) {
    throw new Error(`Managed trash storage escaped its workspace: ${directory}`);
  }
  return true;
}

async function ensureTrashStorage(workspaceRoot: string, deadlineAt: number, create: boolean): Promise<TrashStorage | null> {
  const storage = storagePaths(workspaceRoot);
  const rootPreexisted = await pathExists(storage.root, deadlineAt);
  if (!(await ensurePlainDirectory(storage.root, workspaceRoot, deadlineAt, create))) return null;

  let marker: unknown;
  try {
    marker = await readJsonBounded(storage.marker, deadlineAt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && !(error instanceof Error && error.message.includes('ENOENT'))) {
      throw error;
    }
  }
  if (marker === undefined) {
    if (!create) throw new Error('Managed trash marker is missing.');
    if (rootPreexisted) {
      throw new Error(
        `Reserved trash directory already exists without a Desktop Commander ownership marker: ${storage.root}`,
      );
    }
    const value = JSON.stringify({ version: 1, workspaceRoot }, null, 2);
    try {
      await fs.writeFile(storage.marker, value, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }
    marker = await readJsonBounded(storage.marker, deadlineAt);
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new Error('Managed trash marker has an invalid shape.');
  }
  const markerRecord = marker as Record<string, unknown>;
  if (markerRecord.version !== 1 || typeof markerRecord.workspaceRoot !== 'string'
      || !samePath(markerRecord.workspaceRoot, workspaceRoot)) {
    throw new Error('Managed trash marker does not match this workspace.');
  }
  // Keep the manager-owned store invisible to Git without modifying tracked
  // .gitignore files or repository metadata. The file lives inside the already
  // reserved storage root and ignores that root's contents, including itself.
  await ensureTrashGitIgnore(storage, deadlineAt);
  if (!(await ensurePlainDirectory(storage.entries, workspaceRoot, deadlineAt, create))) return null;
  return storage;
}

function validateManifest(raw: unknown, workspaceRoot: string, expectedName?: string): TrashManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Managed trash manifest has an invalid shape.');
  }
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === 'string' ? value.name : '';
  const originalRelativePath = typeof value.originalRelativePath === 'string'
    ? normalizeStoredRelative(value.originalRelativePath) : '';
  const displayName = typeof value.displayName === 'string' ? value.displayName : '';
  const kind = value.kind;
  const createdAt = Number(value.createdAt);
  const expiresAt = Number(value.expiresAt);
  if (value.version !== 1 || !MANAGED_TRASH_ENTRY_NAME.test(name) || (expectedName && name !== expectedName)) {
    throw new Error('Managed trash manifest identity is invalid.');
  }
  if (typeof value.workspaceRoot !== 'string' || !samePath(value.workspaceRoot, workspaceRoot)) {
    throw new Error('Managed trash manifest workspace does not match storage.');
  }
  if (!originalRelativePath || displayName !== path.basename(originalRelativePath)) {
    throw new Error('Managed trash manifest original name is invalid.');
  }
  if (!['file', 'directory', 'symlink', 'other'].includes(String(kind))) {
    throw new Error('Managed trash manifest kind is invalid.');
  }
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt)
      || expiresAt - createdAt !== MANAGED_TRASH_RETENTION_MS) {
    throw new Error('Managed trash manifest expiration contract is invalid.');
  }
  return {
    version: 1, name, workspaceRoot, originalRelativePath, displayName,
    kind: kind as TrashKind, createdAt, expiresAt,
  };
}

async function readManifest(storage: TrashStorage, workspaceRoot: string, name: string, deadlineAt: number): Promise<TrashManifest> {
  if (!MANAGED_TRASH_ENTRY_NAME.test(name)) throw new Error('trash_action.name is not a valid trash entry id.');
  const entryDir = path.join(storage.entries, name);
  const entryStats = await lstatBounded(entryDir, deadlineAt, `Stat trash entry ${name}`);
  if (!entryStats.isDirectory() || entryStats.isSymbolicLink()) {
    throw new Error(`Managed trash entry is not a real directory: ${name}`);
  }
  const entryReal = await realpathBounded(entryDir, deadlineAt, `Resolve trash entry ${name}`);
  if (!isInside(storage.entries, entryReal)) throw new Error(`Managed trash entry escaped storage: ${name}`);
  return validateManifest(await readJsonBounded(path.join(entryDir, 'manifest.json'), deadlineAt), workspaceRoot, name);
}
function sessionKey(): string | undefined {
  const identity = getToolCallSessionIdentity();
  return identity ? crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32) : undefined;
}

function sameLstatIdentity(
  left: Awaited<ReturnType<typeof fs.lstat>>, right: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && kindOf(left) === kindOf(right);
}

function entryPaths(storage: TrashStorage, name: string) {
  const entry = path.join(storage.entries, name);
  return {
    entry,
    payload: path.join(entry, 'payload'),
    manifest: path.join(entry, 'manifest.json'),
  };
}

async function pathExists(filePath: string, deadlineAt: number): Promise<boolean> {
  try {
    await lstatBounded(filePath, deadlineAt, `Check path ${filePath}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}
async function removeTreeNoFollow(
  target: string, fenceRoot: string, rootDevice: number, deadlineAt: number,
  state: { nodes: number }, depth = 0,
): Promise<void> {
  if (depth > TRASH_PURGE_MAX_DEPTH || ++state.nodes > TRASH_PURGE_MAX_NODES) {
    throw new Error('Managed trash purge exceeded its bounded tree limit.');
  }
  const stats = await lstatBounded(target, deadlineAt, `Stat trash purge node ${target}`);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    await runWithAbortableTimeout(
      (_signal) => fs.unlink(target), remaining(deadlineAt, `Unlink trash purge node ${target}`),
      `Unlink trash purge node ${target}`,
    );
    return;
  }
  if (stats.dev !== rootDevice) throw new Error(`Managed trash purge refuses to cross filesystem devices: ${target}`);
  const canonical = await realpathBounded(target, deadlineAt, `Resolve trash purge directory ${target}`);
  if (!isInside(fenceRoot, canonical)) throw new Error(`Managed trash purge escaped storage: ${target}`);
  const children = await runWithAbortableTimeout(
    (_signal) => fs.readdir(target), remaining(deadlineAt, `Read trash purge directory ${target}`),
    `Read trash purge directory ${target}`,
  );
  for (const child of children) {
    await removeTreeNoFollow(path.join(target, child), fenceRoot, rootDevice, deadlineAt, state, depth + 1);
  }
  await runWithAbortableTimeout(
    (_signal) => fs.rmdir(target), remaining(deadlineAt, `Remove trash purge directory ${target}`),
    `Remove trash purge directory ${target}`,
  );
}
export class TrashManager {
  private readonly workspaces = new Map<string, string>();
  private readonly sessionWorkspaces = new Map<string, string>();
  private started = false;
  private startPromise: Promise<void> | undefined;
  private sweepRunning = false;
  private timer: NodeJS.Timeout | undefined;

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.initialize();
    return this.startPromise;
  }

  private async initialize(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      void this.sweepAll().catch(() => undefined);
    }, MANAGED_TRASH_SWEEP_INTERVAL_MS);
    this.timer.unref?.();

    let configured: unknown;
    try { configured = await configManager.getValue(TRASH_WORKSPACE_REGISTRY_KEY); }
    catch { configured = undefined; }
    const roots = Array.isArray(configured) ? configured.filter((item): item is string => typeof item === 'string') : [];
    for (const raw of roots.slice(-TRASH_MAX_WORKSPACES)) {
      try {
        const root = await validateWorkspaceRoot(raw, Date.now() + 10_000);
        setBoundedMap(this.workspaces, pathIdentity(root), root, TRASH_MAX_WORKSPACES);
      } catch {
        // Stale or no-longer-authorized roots are ignored fail-closed.
      }
    }
    void this.persistWorkspaceRegistry();
    void this.sweepAll().catch(() => undefined);
  }

  private registerWorkspace(root: string): void {
    setBoundedMap(this.workspaces, pathIdentity(root), root, TRASH_MAX_WORKSPACES);
    const key = sessionKey();
    if (key) setBoundedMap(this.sessionWorkspaces, key, root, TRASH_MAX_SESSION_BINDINGS);
    void this.persistWorkspaceRegistry();
  }

  private async persistWorkspaceRegistry(): Promise<void> {
    try {
      await configManager.setValueNonBlocking(
        TRASH_WORKSPACE_REGISTRY_KEY, [...this.workspaces.values()],
      );
    } catch {
      // Persistence is recovery metadata; it must never gate a trash operation.
    }
  }

  private async workspaceForAction(workspace: string | undefined, deadlineAt: number): Promise<string> {
    if (workspace) {
      const root = await validateWorkspaceRoot(workspace, deadlineAt);
      this.registerWorkspace(root);
      return root;
    }
    const key = sessionKey();
    const root = key ? this.sessionWorkspaces.get(key) : undefined;
    if (!root) {
      throw new Error('No trash workspace is bound for this chat/session. Use put first or provide workspace with the exact Git root.');
    }
    const validated = await validateWorkspaceRoot(root, deadlineAt);
    this.registerWorkspace(validated);
    return validated;
  }

  async action(args: { action: 'put' | 'list' | 'read' | 'restore'; path?: string; name?: string; workspace?: string }) {
    void this.start().catch(() => undefined);
    const deadlineAt = Date.now() + TRASH_OPERATION_TIMEOUT_MS;
    switch (args.action) {
      case 'put':
        return this.put(args.path!, args.workspace, deadlineAt);
      case 'list':
        return this.list(args.name, args.workspace, deadlineAt);
      case 'read':
        return this.read(args.name!, args.workspace, deadlineAt);
      case 'restore':
        return this.restore(args.name!, args.workspace, deadlineAt);
    }
  }
  private async put(rawPath: string, workspace: string | undefined, deadlineAt: number) {
    const expectedWorkspace = workspace ? await validateWorkspaceRoot(workspace, deadlineAt) : undefined;
    const initial = await resolvePutTarget(rawPath, deadlineAt, expectedWorkspace);
    this.registerWorkspace(initial.workspaceRoot);
    const storage = await ensureTrashStorage(initial.workspaceRoot, deadlineAt, true);
    if (!storage) throw new Error('Failed to initialize managed trash storage.');

    const name = `tr_${crypto.randomUUID().replace(/-/g, '')}`;
    const entry = entryPaths(storage, name);
    await runWithAbortableTimeout(
      (_signal) => fs.mkdir(entry.entry, { mode: 0o700 }),
      remaining(deadlineAt, `Create trash entry ${name}`), `Create trash entry ${name}`,
    );
    const createdAt = Date.now();
    const manifest: TrashManifest = {
      version: 1, name, workspaceRoot: initial.workspaceRoot,
      originalRelativePath: initial.relativePath, displayName: path.basename(initial.relativePath),
      kind: kindOf(initial.stats), createdAt, expiresAt: createdAt + MANAGED_TRASH_RETENTION_MS,
    };
    await runWithAbortableTimeout(
      (signal) => fs.writeFile(entry.manifest, JSON.stringify(manifest, null, 2), {
        encoding: 'utf8', flag: 'wx', mode: 0o600, signal, flush: true,
      }),
      remaining(deadlineAt, `Write trash manifest ${name}`), `Write trash manifest ${name}`,
    );

    let moved = false;
    const release = await acquireCoordinatedMutationOwnership(
      [initial.targetPath, storage.root, entry.payload], deadlineAt,
      { topologyMode: 'exclusive', label: 'trash_action.put' },
    );
    try {
      const current = await resolvePutTarget(rawPath, deadlineAt, initial.workspaceRoot);
      if (!samePath(current.targetPath, initial.targetPath) || !sameLstatIdentity(current.stats, initial.stats)) {
        throw new Error('trash_action target changed before mutation ownership was acquired. No item was moved.');
      }
      if (await pathExists(entry.payload, deadlineAt)) {
        throw new Error('Managed trash payload path unexpectedly already exists.');
      }
      requireCommitReserve(deadlineAt, `Move ${current.targetPath} into trash`);
      try {
        // Rename is the mutation commit. Once it starts, await its real OS outcome;
        // racing it with a JS timer could report failure while a late rename succeeds.
        await fs.rename(current.targetPath, entry.payload);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EXDEV') {
          throw new Error('trash_action refuses copy+delete fallback across filesystems; original item was preserved.');
        }
        throw error;
      }
      moved = true;
    } finally {
      await release();
      if (!moved) {
        await fs.unlink(entry.manifest).catch(() => undefined);
        await fs.rmdir(entry.entry).catch(() => undefined);
      }
    }
    return {
      action: 'put',
      name,
      displayName: manifest.displayName,
      originalRelativePath: manifest.originalRelativePath,
      kind: manifest.kind,
      workspace: slash(initial.workspaceRoot),
      expiresAt: new Date(manifest.expiresAt).toISOString(),
      expiresInMs: Math.max(0, manifest.expiresAt - Date.now()),
      note: 'Item was renamed into managed trash. No copy+delete fallback is permitted.',
    };
  }

  private async list(name: string | undefined, workspace: string | undefined, deadlineAt: number) {
    const root = await this.workspaceForAction(workspace, deadlineAt);
    const storage = await ensureTrashStorage(root, deadlineAt, false);
    if (!storage) return { action: 'list', workspace: slash(root), entries: [] };
    void this.sweepWorkspace(root).catch(() => undefined);
    if (name) return this.listEntry(root, storage, name, deadlineAt);

    const dirents = await runWithAbortableTimeout(
      (_signal) => fs.readdir(storage.entries, { withFileTypes: true }),
      remaining(deadlineAt, 'List managed trash entries'), 'List managed trash entries',
    );
    const entries = [];
    const warnings: string[] = [];
    for (const dirent of dirents.slice(0, TRASH_MAX_ENTRIES)) {
      if (!dirent.isDirectory() || !MANAGED_TRASH_ENTRY_NAME.test(dirent.name)) continue;
      try {
        const manifest = await readManifest(storage, root, dirent.name, deadlineAt);
        const payload = entryPaths(storage, dirent.name).payload;
        if (manifest.expiresAt <= Date.now() || !(await pathExists(payload, deadlineAt))) continue;
        entries.push({
          name: manifest.name, displayName: manifest.displayName,
          originalRelativePath: manifest.originalRelativePath, kind: manifest.kind,
          createdAt: new Date(manifest.createdAt).toISOString(),
          expiresAt: new Date(manifest.expiresAt).toISOString(),
          expiresInMs: Math.max(0, manifest.expiresAt - Date.now()),
        });
      } catch (error) {
        warnings.push(`${dirent.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    entries.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    return {
      action: 'list', workspace: slash(root), entries,
      ...(dirents.length > TRASH_MAX_ENTRIES ? { truncated: true, totalEntryDirectories: dirents.length } : {}),
      ...(warnings.length ? { warnings: warnings.slice(0, 20) } : {}),
    };
  }

  private async listEntry(root: string, storage: TrashStorage, name: string, deadlineAt: number) {
    const manifest = await readManifest(storage, root, name, deadlineAt);
    if (manifest.expiresAt <= Date.now()) throw new Error(`Trash entry ${name} has expired and is no longer restorable.`);
    const payload = entryPaths(storage, name).payload;
    const stats = await lstatBounded(payload, deadlineAt, `Stat trash payload ${name}`);
    if (stats.isSymbolicLink()) {
      const linkTarget = await runWithAbortableTimeout(
        (_signal) => fs.readlink(payload), remaining(deadlineAt, `Read trash symlink ${name}`),
        `Read trash symlink ${name}`,
      );
      return { action: 'list', workspace: slash(root), name, kind: 'symlink', linkTarget };
    }
    if (!stats.isDirectory()) {
      return { action: 'list', workspace: slash(root), name, kind: manifest.kind, children: [] };
    }
    const children = await runWithAbortableTimeout(
      (_signal) => fs.readdir(payload, { withFileTypes: true }),
      remaining(deadlineAt, `List trash directory ${name}`), `List trash directory ${name}`,
    );
    return {
      action: 'list', workspace: slash(root), name, kind: 'directory',
      children: children.slice(0, TRASH_MAX_LIST_CHILDREN).map((child) => ({
        name: child.name,
        kind: child.isSymbolicLink() ? 'symlink' : child.isDirectory() ? 'directory' : child.isFile() ? 'file' : 'other',
      })),
      ...(children.length > TRASH_MAX_LIST_CHILDREN ? { truncated: true, totalChildren: children.length } : {}),
    };
  }
  private async read(name: string, workspace: string | undefined, deadlineAt: number) {
    const root = await this.workspaceForAction(workspace, deadlineAt);
    const storage = await ensureTrashStorage(root, deadlineAt, false);
    if (!storage) throw new Error('Managed trash is empty for this workspace.');
    const manifest = await readManifest(storage, root, name, deadlineAt);
    if (manifest.expiresAt <= Date.now()) throw new Error(`Trash entry ${name} has expired and is no longer readable.`);
    const payload = entryPaths(storage, name).payload;
    const stats = await lstatBounded(payload, deadlineAt, `Stat trash payload ${name}`);
    if (stats.isSymbolicLink()) {
      const linkTarget = await runWithAbortableTimeout(
        (_signal) => fs.readlink(payload), remaining(deadlineAt, `Read trash symlink ${name}`),
        `Read trash symlink ${name}`,
      );
      return { action: 'read', workspace: slash(root), name, kind: 'symlink', encoding: 'link-target', content: linkTarget };
    }
    if (!stats.isFile()) throw new Error(`trash_action.read only reads file payloads; ${name} is ${manifest.kind}.`);
    const bytes = await runWithAbortableTimeout(
      (signal) => readFileBounded(payload, TRASH_READ_MAX_BYTES, signal, 'trash_action read payload'),
      remaining(deadlineAt, `Read trash payload ${name}`), `Read trash payload ${name}`,
    );
    const binary = await isBinaryFile(bytes, bytes.length);
    return {
      action: 'read', workspace: slash(root), name, kind: manifest.kind,
      encoding: binary ? 'base64' : 'utf8', content: binary ? bytes.toString('base64') : bytes.toString('utf8'),
      bytes: bytes.length,
    };
  }
  private async resolveRestoreDestination(root: string, relativePath: string, deadlineAt: number): Promise<string> {
    const lexical = path.resolve(root, relativePath);
    if (!isInside(root, lexical) || samePath(root, lexical)) {
      throw new Error('Trash restore destination is outside the workspace or equals its root.');
    }
    const parent = path.dirname(lexical);
    const canonicalParent = await validatePathAuthority(
      parent, remaining(deadlineAt, 'Validate trash restore parent'),
    );
    if (!isInside(root, canonicalParent) || !samePath(parent, canonicalParent)) {
      throw new Error('Trash restore parent changed identity or now traverses a link.');
    }
    const destination = path.join(canonicalParent, path.basename(lexical));
    if (!samePath(destination, lexical) || pathContainsManagedTrashSegment(destination)) {
      throw new Error('Trash restore destination failed its workspace path fence.');
    }
    return destination;
  }

  private async restore(name: string, workspace: string | undefined, deadlineAt: number) {
    const root = await this.workspaceForAction(workspace, deadlineAt);
    const storage = await ensureTrashStorage(root, deadlineAt, false);
    if (!storage) throw new Error('Managed trash is empty for this workspace.');
    const initialManifest = await readManifest(storage, root, name, deadlineAt);
    if (initialManifest.expiresAt <= Date.now()) {
      throw new Error(`Trash entry ${name} has expired and cannot be restored.`);
    }
    const entry = entryPaths(storage, name);
    const destination = await this.resolveRestoreDestination(root, initialManifest.originalRelativePath, deadlineAt);
    if (await pathExists(destination, deadlineAt)) {
      throw new Error(`Restore refused because destination already exists: ${destination}`);
    }
    const release = await acquireCoordinatedMutationOwnership(
      [storage.root, entry.payload, destination], deadlineAt,
      { topologyMode: 'exclusive', label: 'trash_action.restore' },
    );
    let restored = false;
    try {
      const currentManifest = await readManifest(storage, root, name, deadlineAt);
      if (currentManifest.expiresAt <= Date.now()) throw new Error(`Trash entry ${name} expired before restore ownership was acquired.`);
      const currentDestination = await this.resolveRestoreDestination(root, currentManifest.originalRelativePath, deadlineAt);
      if (!samePath(currentDestination, destination)) throw new Error('Trash restore destination changed before commit.');
      if (await pathExists(destination, deadlineAt)) {
        throw new Error(`Restore refused because destination now exists: ${destination}`);
      }
      await lstatBounded(entry.payload, deadlineAt, `Stat restore payload ${name}`);
      requireCommitReserve(deadlineAt, `Restore trash entry ${name}`);
      try {
        // Restore has the same truthful-commit rule as put: never return a
        // timeout while a non-cancelable rename may still commit afterwards.
        await fs.rename(entry.payload, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EXDEV') {
          throw new Error('trash_action restore refuses copy fallback across filesystems. Trash entry was preserved.');
        }
        throw error;
      }
      restored = true;
    } finally {
      await release();
    }
    if (restored) {
      await fs.unlink(entry.manifest).catch(() => undefined);
      await fs.rmdir(entry.entry).catch(() => undefined);
    }
    return {
      action: 'restore', name, workspace: slash(root),
      restoredTo: slash(destination),
      originalRelativePath: initialManifest.originalRelativePath,
      restored,
    };
  }

  private async sweepAll(): Promise<void> {
    if (this.sweepRunning) return;
    this.sweepRunning = true;
    try {
      for (const root of [...this.workspaces.values()]) {
        try { await this.sweepWorkspace(root); }
        catch { /* one inaccessible workspace must not stop the autonomous sweeper */ }
      }
    } finally {
      this.sweepRunning = false;
    }
  }

  private async sweepWorkspace(root: string): Promise<void> {
    const deadlineAt = Date.now() + TRASH_BACKGROUND_SWEEP_BUDGET_MS;
    const validatedRoot = await validateWorkspaceRoot(root, deadlineAt);
    const storage = await ensureTrashStorage(validatedRoot, deadlineAt, false);
    if (!storage) return;
    const dirents = await runWithAbortableTimeout(
      (_signal) => fs.readdir(storage.entries, { withFileTypes: true }),
      remaining(deadlineAt, 'Sweep managed trash entries'), 'Sweep managed trash entries',
    );
    for (const dirent of dirents.slice(0, TRASH_MAX_ENTRIES)) {
      if (!dirent.isDirectory() || !MANAGED_TRASH_ENTRY_NAME.test(dirent.name)) continue;
      if (Date.now() >= deadlineAt - 250) break;
      let manifest: TrashManifest;
      try { manifest = await readManifest(storage, validatedRoot, dirent.name, deadlineAt); }
      catch { continue; }
      if (manifest.expiresAt > Date.now()) continue;
      await this.purgeEntry(validatedRoot, storage, manifest, deadlineAt).catch(() => undefined);
    }
  }

  private async purgeEntry(
    root: string, storage: TrashStorage, manifest: TrashManifest, deadlineAt: number,
  ): Promise<void> {
    const entry = entryPaths(storage, manifest.name);
    const release = await acquireMutationResourceLocks(
      [storage.root, entry.entry, entry.payload], deadlineAt, { topologyMode: 'exclusive' },
    );
    try {
      const current = await readManifest(storage, root, manifest.name, deadlineAt);
      if (current.expiresAt > Date.now()) return;
      const entryStats = await lstatBounded(entry.entry, deadlineAt, `Stat purge entry ${manifest.name}`);
      const entryReal = await realpathBounded(entry.entry, deadlineAt, `Resolve purge entry ${manifest.name}`);
      if (!entryStats.isDirectory() || entryStats.isSymbolicLink() || !isInside(storage.entries, entryReal)) {
        throw new Error(`Refusing unsafe managed trash purge for ${manifest.name}.`);
      }
      await removeTreeNoFollow(
        entry.entry, storage.entries, entryStats.dev, deadlineAt, { nodes: 0 },
      );
    } finally {
      await release();
    }
  }
}

export const trashManager = new TrashManager();

export function startTrashManager(): void {
  void trashManager.start().catch(() => undefined);
}
