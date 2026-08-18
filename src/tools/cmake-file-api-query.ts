import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { readFileBounded } from '../utils/bounded-file-read.js';
import { renameReplacingWithRetry } from '../utils/atomic-rename.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';

const QUERY_CLIENT = 'client-desktop-commander';
const QUERY_MAX_BYTES = 64 * 1024;
const QUERY_CONTENT = `${JSON.stringify({
  requests: [
    { kind: 'codemodel', version: 2 },
    { kind: 'cmakeFiles', version: 1 },
    { kind: 'toolchains', version: 1 },
  ],
}, null, 2)}\n`;

function remaining(deadlineAt: number, label: string, maximum = 10_000): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error(`${label} deadline exceeded.`) as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.min(maximum, value));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function ensurePlainDirectory(directory: string, fenceRoot: string, deadlineAt: number): Promise<void> {
  try {
    await runWithAbortableTimeout(
      (_signal) => fs.mkdir(directory), remaining(deadlineAt, `Create CMake File API directory ${directory}`),
      `Create CMake File API directory ${directory}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
  }
  const stats = await runWithAbortableTimeout(
    (_signal) => fs.lstat(directory), remaining(deadlineAt, `Stat CMake File API directory ${directory}`),
    `Stat CMake File API directory ${directory}`,
  );
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`CMake File API query directory must be a real directory: ${directory}`);
  }
  const canonical = await runWithAbortableTimeout(
    (_signal) => fs.realpath(directory), remaining(deadlineAt, `Resolve CMake File API directory ${directory}`),
    `Resolve CMake File API directory ${directory}`,
  );
  if (!isInside(fenceRoot, canonical)) throw new Error(`CMake File API query directory escaped build root: ${directory}`);
}

async function ensureDirectoryChain(root: string, target: string, deadlineAt: number): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (path.resolve(root) === path.resolve(target)) return;
    throw new Error(`CMake File API query target escapes repository root: ${target}`);
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await ensurePlainDirectory(current, root, deadlineAt);
  }
}

async function currentQuery(queryPath: string, deadlineAt: number): Promise<string | null> {
  try {
    const bytes = await runWithAbortableTimeout(
      (signal) => readFileBounded(queryPath, QUERY_MAX_BYTES, signal, 'CMake File API query'),
      remaining(deadlineAt, 'Read CMake File API query'), 'Read CMake File API query',
    );
    return bytes.toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function ensureCmakeFileApiQuery(
  repositoryRootValue: string, buildDirValue: string, deadlineAt: number,
) {
  const repositoryRoot = await runWithAbortableTimeout(
    (_signal) => fs.realpath(path.resolve(repositoryRootValue)),
    remaining(deadlineAt, 'Resolve CMake File API repository root'),
    `Resolve CMake File API repository root ${repositoryRootValue}`,
  );
  const buildDir = path.resolve(buildDirValue);
  if (!isInside(repositoryRoot, buildDir) || path.resolve(repositoryRoot) === buildDir) {
    throw new Error(`CMake File API query build directory must be a child of the repository root: ${buildDir}`);
  }
  await ensureDirectoryChain(repositoryRoot, buildDir, deadlineAt);
  const queryDir = path.join(buildDir, '.cmake', 'api', 'v1', 'query', QUERY_CLIENT);
  await ensureDirectoryChain(repositoryRoot, queryDir, deadlineAt);
  const queryPath = path.join(queryDir, 'query.json');
  const before = await currentQuery(queryPath, deadlineAt);
  const sha256 = `sha256:${crypto.createHash('sha256').update(QUERY_CONTENT, 'utf8').digest('hex')}`;
  if (before === QUERY_CONTENT) {
    return { path: queryPath.replace(/\\/g, '/'), sha256, changed: false };
  }

  const tempPath = path.join(queryDir, `.query.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await runWithAbortableTimeout(
      (signal) => fs.writeFile(tempPath, QUERY_CONTENT, { encoding: 'utf8', mode: 0o600, signal, flush: true }),
      remaining(deadlineAt, 'Stage CMake File API query'), 'Stage CMake File API query',
    );
    await renameReplacingWithRetry(tempPath, queryPath, { deadlineAt });
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { path: queryPath.replace(/\\/g, '/'), sha256, changed: true };
}
