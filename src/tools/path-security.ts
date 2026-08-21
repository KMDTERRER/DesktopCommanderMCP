import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { configManager } from '../config-manager.js';
import { CONFIG_FILE } from '../config.js';
import { withTimeout } from '../utils/withTimeout.js';
import {
  MANAGED_TRASH_WORKSPACE_REGISTRY_FILE_NAME, MANAGED_TRASH_WORKSPACE_REGISTRY_TEMP_PREFIX,
  pathContainsManagedTrashSegment,
} from '../utils/trash-contract.js';

export const PATH_VALIDATION_TIMEOUT_MS = 10_000;
const MANAGED_TRASH_CONTROL_DIRECTORY = path.dirname(CONFIG_FILE);
const MANAGED_TRASH_WORKSPACE_REGISTRY_FILE = path.join(
  MANAGED_TRASH_CONTROL_DIRECTORY, MANAGED_TRASH_WORKSPACE_REGISTRY_FILE_NAME,
);

export async function getAllowedDirs(): Promise<string[]> {
  try {
    const config = await configManager.getConfig();
    if (Array.isArray(config.allowedDirectories)) {
      return config.allowedDirectories;
    }
    const defaults = [os.homedir()];
    await configManager.setValue('allowedDirectories', defaults);
    return defaults;
  } catch (error) {
    // An explicit [] remains the backward-compatible unrestricted mode, but
    // failure to read configuration must never silently broaden access.
    console.error('Failed to initialize allowed directories:', error);
    throw error;
  }
}

function expandHome(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

function normalizePath(value: string): string {
  const normalized = path.normalize(expandHome(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isManagedTrashControlPath(value: string): boolean {
  const candidate = path.resolve(expandHome(value));
  if (normalizePath(path.dirname(candidate)) !== normalizePath(MANAGED_TRASH_CONTROL_DIRECTORY)) return false;
  const basename = path.basename(candidate);
  const exact = process.platform === 'win32'
    ? basename.toLowerCase() === MANAGED_TRASH_WORKSPACE_REGISTRY_FILE_NAME.toLowerCase()
    : basename === MANAGED_TRASH_WORKSPACE_REGISTRY_FILE_NAME;
  const tempPrefix = process.platform === 'win32'
    ? basename.toLowerCase().startsWith(MANAGED_TRASH_WORKSPACE_REGISTRY_TEMP_PREFIX.toLowerCase())
    : basename.startsWith(MANAGED_TRASH_WORKSPACE_REGISTRY_TEMP_PREFIX);
  return exact || tempPrefix;
}

async function isManagedTrashControlIdentity(value: string): Promise<boolean> {
  let candidate: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    candidate = await fs.lstat(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink <= 1) return false;
  let registry: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    registry = await fs.lstat(MANAGED_TRASH_WORKSPACE_REGISTRY_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  return registry.isFile() && !registry.isSymbolicLink()
    && candidate.dev === registry.dev && candidate.ino === registry.ino;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function allowedPathVariants(allowedDirectories: string[]): Promise<string[]> {
  const variants = new Set<string>();
  for (const raw of allowedDirectories) {
    const absolute = path.resolve(expandHome(raw));
    variants.add(normalizePath(absolute));
    try {
      // Resolve on every authorization check. Caching a symlink/junction target
      // would keep the old target authorized after the link is retargeted.
      variants.add(normalizePath(await fs.realpath(absolute, { encoding: 'utf8' })));
    } catch {
      // Retain the lexical form for not-yet-created/offline roots. Candidate
      // paths are canonicalized separately, so this does not authorize a
      // symlink escape outside the configured root.
    }
  }
  return [...variants];
}

async function validateParentDirectories(directoryPath: string): Promise<boolean> {
  const parentDir = path.dirname(directoryPath);
  if (parentDir === directoryPath || parentDir === path.dirname(parentDir)) {
    return false;
  }
  try {
    await fs.realpath(parentDir);
    return true;
  } catch {
    return validateParentDirectories(parentDir);
  }
}

async function isPathAllowed(pathToCheck: string, allowedDirectories: string[]): Promise<boolean> {
  if (allowedDirectories.length === 0) return true;

  const candidate = normalizePath(pathToCheck);
  const variants = await allowedPathVariants(allowedDirectories);
  return variants.some((allowedRoot) => isWithin(allowedRoot, candidate));
}

async function resolveCanonicalPath(requestedPath: string): Promise<string> {
  const expandedPath = expandHome(requestedPath);
  const absoluteOriginal = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);

  try {
    return await fs.realpath(absoluteOriginal, { encoding: 'utf8' });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (!err.code || err.code !== 'ENOENT') {
      throw new Error(`Failed to resolve symlink for path: ${absoluteOriginal}. Error: ${err.message}`);
    }
  }

  try {
    const parentDir = path.dirname(absoluteOriginal);
    const resolvedParent = await fs.realpath(parentDir, { encoding: 'utf8' });
    return path.join(resolvedParent, path.basename(absoluteOriginal));
  } catch {
    let current = absoluteOriginal;
    const remaining: string[] = [];
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) break;
      remaining.unshift(path.basename(current));
      current = parent;
      try {
        const resolvedAncestor = await fs.realpath(current, { encoding: 'utf8' });
        return path.join(resolvedAncestor, ...remaining);
      } catch {
        // Keep walking toward the filesystem root.
      }
    }
  }

  return absoluteOriginal;
}

export async function validatePathAuthority(
  requestedPath: string,
  timeoutMs: number = PATH_VALIDATION_TIMEOUT_MS,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Path validation timeout must be a positive finite number.');
  }
  if (isManagedTrashControlPath(requestedPath)) {
    throw new Error('Managed trash registry metadata is reserved for trash_action.');
  }
  if (pathContainsManagedTrashSegment(requestedPath)) {
    throw new Error('Managed trash storage is reserved for trash_action.');
  }
  const effectiveTimeoutMs = Math.max(1, Math.min(PATH_VALIDATION_TIMEOUT_MS, Math.floor(timeoutMs)));
  const operation = async (): Promise<string> => {
    const canonicalPath = await resolveCanonicalPath(requestedPath);
    if (isManagedTrashControlPath(canonicalPath) || await isManagedTrashControlIdentity(canonicalPath)) {
      throw new Error('Managed trash registry metadata is reserved for trash_action.');
    }
    if (pathContainsManagedTrashSegment(canonicalPath)) {
      throw new Error('Managed trash storage is reserved for trash_action.');
    }
    const allowedDirectories = await getAllowedDirs();
    if (!(await isPathAllowed(canonicalPath, allowedDirectories))) {
      throw new Error(
        `Path not allowed: ${requestedPath}. Must be within one of these directories: ${allowedDirectories.join(', ')}`,
      );
    }

    try {
      await fs.stat(canonicalPath);
      return canonicalPath;
    } catch {
      if (await validateParentDirectories(canonicalPath)) {
        return canonicalPath;
      }
      return canonicalPath;
    }
  };

  try {
    return await withTimeout(
      operation(),
      effectiveTimeoutMs,
      'Path validation operation',
      null as never,
    );
  } catch (error) {
    if (typeof error === 'string' && error.includes('timed out')) {
      const timeoutError = new Error(`Path validation failed for path: ${requestedPath}`) as NodeJS.ErrnoException;
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }
    throw error;
  }
}
