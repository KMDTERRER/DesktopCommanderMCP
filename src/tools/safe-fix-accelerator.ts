import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { validatePathAuthority as validatePath } from './path-security.js';
import { acquireMutationResourceLocks } from '../utils/mutation-resource-lock.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { readFileBounded } from '../utils/bounded-file-read.js';
import { terminateProcessTree } from '../utils/process-tree.js';

const MAX_FILES = 50;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PATCH_CHARS = 1_000_000;

type ProcessResult = { stdout: string; stderr: string; exitCode: number };
type EngineCommand = { command: string; prefixArgs: string[] };
type PreparedFile = { relative: string; absolute: string; hash: string; size: number };

export const SAFE_FIX_ACCELERATOR_TOOL = {
  name: 'safe_fix',
  purpose: 'Preview language-engine safe fixes for an exact file set without modifying source files.',
  when_to_use: 'After diagnostics or review identify mechanical fixes and before apply_patch/edit_file.',
  when_not_to_use: 'For speculative refactors, unsafe fixes, or when no supported local fix engine is installed.',
  readOnly: true,
  mutating: false,
  inputSchema: {
    type: 'object', required: ['root', 'files'], additionalProperties: false,
    properties: {
      root: { type: 'string', description: 'Path inside the target Git repository.' },
      files: { type: 'array', minItems: 1, maxItems: MAX_FILES, items: { type: 'string' } },
      engine: { type: 'string', enum: ['auto', 'ruff'], default: 'auto' },
      maxPatchChars: { type: 'integer', minimum: 1, maximum: MAX_PATCH_CHARS, default: 200_000 },
    },
  },
  recommended_workflow: [
    'Pass exact files selected by diagnostics/Serena/CRG rather than whole directories.',
    'Review the returned no-write patch and beforeHashes.',
    'Apply separately with apply_patch and expectedHashes so filesystem mutation stays in one boundary.',
    'Run focused verification after application.',
  ],
  related_capabilities: ['Ruff safe fixes', 'LSP code actions', 'apply_patch', 'edit_file'],
};

function remaining(deadlineAt: number, max = 15_000): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error('safe_fix operation deadline exceeded.') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.min(max, value));
}

function normalizeSlash(value: string): string {
  return value.replace(/\\/g, '/');
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function runBounded(
  command: string, args: string[], cwd: string, deadlineAt: number, input?: string,
): Promise<ProcessResult> {
  const timeoutMs = remaining(deadlineAt);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let forcedError: Error | undefined;
    const finish = (result?: ProcessResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    };
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        if (!forcedError) {
          forcedError = new Error(`safe_fix engine output exceeded ${MAX_OUTPUT_BYTES} bytes.`);
          void terminateProcessTree(child, undefined, true).catch(() => child.kill('SIGKILL'));
        }
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        const unavailable = new Error(`SAFE_FIX_ENGINE_UNAVAILABLE: '${command}' was not found.`) as NodeJS.ErrnoException;
        unavailable.code = 'ENOENT';
        finish(undefined, unavailable);
      } else finish(undefined, error);
    });
    child.on('close', (code) => {
      if (forcedError) finish(undefined, forcedError);
      else finish({ stdout, stderr, exitCode: code ?? 1 });
    });
    const timer = setTimeout(() => {
      if (forcedError) return;
      forcedError = new Error(`safe_fix engine timed out after ${timeoutMs}ms.`) as NodeJS.ErrnoException;
      (forcedError as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      void terminateProcessTree(child, undefined, true).catch(() => child.kill('SIGKILL'));
    }, timeoutMs);
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input, 'utf8');
  });
}

function parsePrefixArgs(raw: string | undefined, label: string): string[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${label} must be a JSON string array.`); }
  if (!Array.isArray(parsed) || parsed.length > 16 || parsed.some((value) => typeof value !== 'string')) {
    throw new Error(`${label} must be a JSON string array with at most 16 entries.`);
  }
  return parsed as string[];
}

async function isFile(candidate: string, deadlineAt: number): Promise<boolean> {
  try {
    return (await runWithAbortableTimeout(
      (_signal) => fs.stat(candidate), remaining(deadlineAt), `Stat safe_fix engine candidate ${candidate}`,
    )).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT') throw error;
    return false;
  }
}

async function resolveRuff(repoRoot: string, deadlineAt: number): Promise<EngineCommand> {
  const configured = process.env.RUFF_BIN?.trim();
  if (configured) {
    if (path.isAbsolute(configured) && !await isFile(configured, deadlineAt)) {
      throw new Error(`SAFE_FIX_ENGINE_UNAVAILABLE: configured RUFF_BIN does not exist: ${configured}`);
    }
    return { command: configured, prefixArgs: parsePrefixArgs(process.env.RUFF_BIN_ARGS, 'RUFF_BIN_ARGS') };
  }

  const localCandidates = process.platform === 'win32'
    ? [path.join(repoRoot, '.venv', 'Scripts', 'ruff.exe'), path.join(repoRoot, 'venv', 'Scripts', 'ruff.exe')]
    : [path.join(repoRoot, '.venv', 'bin', 'ruff'), path.join(repoRoot, 'venv', 'bin', 'ruff')];
  for (const candidate of localCandidates) {
    if (await isFile(candidate, deadlineAt)) return { command: candidate, prefixArgs: [] };
  }
  return { command: process.platform === 'win32' ? 'ruff.exe' : 'ruff', prefixArgs: [] };
}

async function resolveRepository(root: unknown, deadlineAt: number): Promise<string> {
  if (typeof root !== 'string' || !root.trim()) throw new Error('safe_fix.root is required.');
  const requested = await validatePath(root, remaining(deadlineAt));
  const result = await runBounded('git', ['-C', requested, 'rev-parse', '--show-toplevel'], requested, deadlineAt);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(`safe_fix requires a Git repository: ${(result.stderr || result.stdout).trim()}`);
  }
  return validatePath(result.stdout.trim(), remaining(deadlineAt));
}

async function hashFile(filePath: string, deadlineAt: number): Promise<{ hash: string; size: number }> {
  const stats = await runWithAbortableTimeout(
    (_signal) => fs.stat(filePath), remaining(deadlineAt), `Stat safe_fix input ${filePath}`,
  );
  if (!stats.isFile()) throw new Error(`safe_fix input is not a file: ${filePath}`);
  if (stats.size > MAX_FILE_BYTES) throw new Error(`safe_fix input exceeds ${MAX_FILE_BYTES} bytes: ${filePath}`);
  const bytes = await runWithAbortableTimeout(
    (signal) => readFileBounded(filePath, MAX_FILE_BYTES, signal, 'safe_fix input'),
    remaining(deadlineAt),
    `Read bounded safe_fix input ${filePath}`,
  );
  if (bytes.length !== stats.size) throw new Error(`safe_fix input changed while being read: ${filePath}`);
  return { hash: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

async function prepareFiles(repoRoot: string, rawFiles: unknown, deadlineAt: number): Promise<PreparedFile[]> {
  if (!Array.isArray(rawFiles) || rawFiles.length < 1 || rawFiles.length > MAX_FILES) {
    throw new Error(`safe_fix.files must contain 1-${MAX_FILES} repository-relative paths.`);
  }
  const canonicalRoot = await runWithAbortableTimeout(
    (_signal) => fs.realpath(repoRoot), remaining(deadlineAt), `Resolve safe_fix repository root ${repoRoot}`,
  );
  const seen = new Set<string>();
  const prepared: PreparedFile[] = [];
  let totalBytes = 0;
  for (const raw of rawFiles) {
    if (typeof raw !== 'string' || !raw.trim() || path.isAbsolute(raw)) {
      throw new Error('safe_fix.files entries must be non-empty repository-relative paths.');
    }
    const relative = normalizeSlash(path.normalize(raw));
    if (relative === '.' || relative === '..' || relative.startsWith('../') || relative === '.git' || relative.startsWith('.git/')) {
      throw new Error(`safe_fix path escapes or targets repository metadata: ${raw}`);
    }
    const absolute = await validatePath(path.resolve(repoRoot, relative), remaining(deadlineAt));
    const canonical = await runWithAbortableTimeout(
      (_signal) => fs.realpath(absolute), remaining(deadlineAt), `Resolve safe_fix input ${absolute}`,
    );
    if (!isInside(canonicalRoot, canonical)) throw new Error(`safe_fix path escapes repository root: ${raw}`);
    const normalizedRelative = normalizeSlash(path.relative(repoRoot, canonical));
    const key = process.platform === 'win32' ? normalizedRelative.toLowerCase() : normalizedRelative;
    if (seen.has(key)) throw new Error(`safe_fix.files contains duplicate path: ${raw}`);
    seen.add(key);
    if (!/\.pyi?$/i.test(normalizedRelative)) throw new Error(`safe_fix engine 'ruff' only accepts .py/.pyi files: ${raw}`);
    const info = await hashFile(canonical, deadlineAt);
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_FILE_BYTES) throw new Error(`safe_fix inputs exceed ${MAX_TOTAL_FILE_BYTES} total bytes.`);
    prepared.push({ relative: normalizedRelative, absolute: canonical, hash: info.hash, size: info.size });
  }
  return prepared.sort((a, b) => a.relative.localeCompare(b.relative));
}

function normalizeDiffPath(raw: string, repoRoot: string): string {
  const value = raw.split('\t', 1)[0].trim().replace(/^"|"$/g, '');
  if (!value || value === '/dev/null') throw new Error(`safe_fix returned unsupported diff path: ${raw}`);
  let relative: string;
  if (path.isAbsolute(value)) {
    relative = path.relative(repoRoot, value);
  } else {
    relative = value.replace(/\\/g, '/').replace(/^[ab]\//, '');
  }
  const normalized = normalizeSlash(path.normalize(relative));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)) {
    throw new Error(`safe_fix engine returned a diff path outside the repository: ${raw}`);
  }
  return normalized;
}

export function parseSafeFixPatchFiles(patchText: string, repoRoot: string): string[] {
  const files = new Set<string>();
  let headers = 0;
  for (const line of patchText.split(/\r?\n/)) {
    if (!line.startsWith('--- ') && !line.startsWith('+++ ')) continue;
    headers += 1;
    files.add(normalizeDiffPath(line.slice(4), repoRoot));
  }
  if (patchText.trim() && headers === 0) {
    throw new Error('safe_fix engine produced non-empty output without unified diff headers.');
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

function samePathSet(a: string[], b: string[]): boolean {
  const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const aa = [...new Set(a.map(key))].sort();
  const bb = [...new Set(b.map(key))].sort();
  return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
}

async function verifyUnchanged(files: PreparedFile[], deadlineAt: number): Promise<void> {
  for (const file of files) {
    const current = await hashFile(file.absolute, deadlineAt);
    if (current.hash !== file.hash) {
      throw new Error(`SAFE_FIX_ENGINE_MUTATED_SOURCE: ${file.relative} changed during no-write preview.`);
    }
  }
}

function assertPatchSubset(patchFiles: string[], requestedFiles: string[]): void {
  const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const allowed = new Set(requestedFiles.map(key));
  const outside = patchFiles.filter((file) => !allowed.has(key(file)));
  if (outside.length > 0) {
    throw new Error(`safe_fix engine returned changes outside the requested file set: ${outside.join(', ')}`);
  }
}

export async function callSafeFixAcceleratorTool(
  args: Record<string, unknown>, timeoutMs = 30_000,
) {
  const deadlineAt = Date.now() + timeoutMs;
  const requestedEngine = args.engine === undefined ? 'auto' : String(args.engine);
  if (requestedEngine !== 'auto' && requestedEngine !== 'ruff') {
    throw new Error(`safe_fix.engine '${requestedEngine}' is not supported.`);
  }
  const maxPatchChars = args.maxPatchChars === undefined ? 200_000 : Number(args.maxPatchChars);
  if (!Number.isInteger(maxPatchChars) || maxPatchChars < 1 || maxPatchChars > MAX_PATCH_CHARS) {
    throw new Error(`safe_fix.maxPatchChars must be an integer from 1 to ${MAX_PATCH_CHARS}.`);
  }

  const repoRoot = await resolveRepository(args.root, deadlineAt);
  const files = await prepareFiles(repoRoot, args.files, deadlineAt);
  const release = await acquireMutationResourceLocks(files.map((file) => file.absolute), deadlineAt);
  try {
    let refreshedTotalBytes = 0;
    for (const file of files) {
      const refreshed = await hashFile(file.absolute, deadlineAt);
      file.hash = refreshed.hash;
      file.size = refreshed.size;
      refreshedTotalBytes += refreshed.size;
      if (refreshedTotalBytes > MAX_TOTAL_FILE_BYTES) {
        throw new Error(`safe_fix inputs exceed ${MAX_TOTAL_FILE_BYTES} total bytes after acquiring mutation locks.`);
      }
    }

    const engine = await resolveRuff(repoRoot, deadlineAt);
    const versionResult = await runBounded(engine.command, [...engine.prefixArgs, '--version'], repoRoot, deadlineAt);
    if (versionResult.exitCode !== 0) {
      throw new Error(`SAFE_FIX_ENGINE_UNAVAILABLE: Ruff version probe failed: ${(versionResult.stderr || versionResult.stdout).trim()}`);
    }
    const version = versionResult.stdout.trim() || versionResult.stderr.trim();
    const relativeFiles = files.map((file) => file.relative);
    const result = await runBounded(engine.command, [
      ...engine.prefixArgs, 'check', '--diff', '--no-unsafe-fixes', '--no-cache', '--', ...relativeFiles,
    ], repoRoot, deadlineAt);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(`safe_fix Ruff preview failed (${result.exitCode}): ${(result.stderr || result.stdout).trim()}`);
    }
    await verifyUnchanged(files, deadlineAt);

    const patch = result.stdout;
    if (patch.length > maxPatchChars) {
      throw new Error(`safe_fix preview exceeds maxPatchChars=${maxPatchChars}; narrow the file set.`);
    }
    const patchFiles = parseSafeFixPatchFiles(patch, repoRoot);
    assertPatchSubset(patchFiles, relativeFiles);
    const beforeHashes = Object.fromEntries(files.map((file) => [file.relative, `sha256:${file.hash}`]));
    const identity = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const beforeHashByIdentity = new Map(
      Object.entries(beforeHashes).map(([file, hash]) => [identity(file), hash]),
    );
    const applyExpectedHashes = Object.fromEntries(patchFiles.map((file) => {
      const hash = beforeHashByIdentity.get(identity(file));
      if (!hash) throw new Error(`safe_fix could not map patch path to its source hash: ${file}`);
      return [file, hash];
    }));

    return {
      repositoryRoot: normalizeSlash(repoRoot),
      engine: 'ruff',
      version,
      safeOnly: true,
      sourceUnchanged: true,
      changed: patchFiles.length > 0,
      files: relativeFiles,
      patchFiles,
      patch,
      beforeHashes,
      applyExpectedFiles: patchFiles,
      applyExpectedHashes,
      stderr: result.stderr.trim(),
      note: 'Preview only. Apply separately with apply_patch/edit_file and the returned hashes.',
    };
  } finally {
    await release();
  }
}
