import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { isBinaryFile } from 'isbinaryfile';
import { validatePath } from './filesystem.js';
import { terminalManager } from '../terminal-manager.js';
import {
  AST_GREP_ACCELERATOR_TOOLS, callAstGrepAcceleratorTool, prepareAstGrepRewrite,
  type PreparedAstGrepRewriteFile,
} from './ast-grep-accelerator.js';
import { BUILD_METADATA_ACCELERATOR_TOOL, callBuildMetadataAcceleratorTool } from './build-metadata-accelerator.js';
import { CPP_BUILD_PLAN_ACCELERATOR_TOOL, callCppBuildPlanAcceleratorTool } from './cpp-build-plan-accelerator.js';
import { CPP_BUILD_CONTEXT_ACCELERATOR_TOOL, callCppBuildContextAcceleratorTool } from './cpp-build-context-accelerator.js';
import { CPP_BUILD_EXECUTE_ACCELERATOR_TOOL } from './cpp-build-execute-accelerator.js';
import { CPP_BUILD_RESULT_ACCELERATOR_TOOL, executeCppBuildEntry, readCppBuildResult } from './cpp-build-entry.js';


import { CPP_BUILD_IMPACT_ACCELERATOR_TOOL, callCppBuildImpactAcceleratorTool } from './cpp-build-impact-accelerator.js';

import { CPP_TOOLCHAIN_PROFILE_ACCELERATOR_TOOL, callCppToolchainProfileAcceleratorTool } from './cpp-toolchain-profile-accelerator.js';
import { SAFE_FIX_ACCELERATOR_TOOL, callSafeFixAcceleratorTool } from './safe-fix-accelerator.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { renameReplacingWithRetry } from '../utils/atomic-rename.js';
import { findWindowsFileLockers } from '../utils/windows-file-locks.js';
import { acquireMutationResourceLocks } from '../utils/mutation-resource-lock.js';
import { acquireCoordinatedMutationOwnership } from '../utils/resource-lease-owner.js';
import { readFileBounded } from '../utils/bounded-file-read.js';
import { MANAGED_TRASH_DIRECTORY_NAME, isManagedTrashRelativePath } from '../utils/trash-contract.js';
import { runBoundedSubprocess, type BoundedSubprocessResult } from '../utils/bounded-subprocess.js';
import { processProblemEvidence } from '../utils/process-problem-matcher.js';
import { waitForTerminalProcess } from '../utils/terminal-process-wait.js';
import {
  PROCESS_STALL_DEFAULT_MS, PROCESS_TRANSPORT_RESERVE_MS, PROCESS_TRANSPORT_TIMEOUT_MAX_MS,
  PROCESS_WAIT_DEFAULT_MS, PROCESS_WAIT_MAX_MS,
} from '../utils/process-wait-contract.js';

const GIT_TIMEOUT_MS = 15_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const BUILTIN_SERVER_ID = 'desktop-accelerators';
const BUILTIN_OPERATION_TIMEOUT_MAX_MS = 45_000;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_FILES = 100;
const MAX_READ_RANGES = 100;
const MAX_READ_RANGE_LINES = 5_000;
const MAX_READ_RANGE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_READ_RANGES_TOTAL_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_READ_RANGES_MAX_CHARS = 200_000;
const MAX_READ_RANGES_MAX_CHARS = 2_000_000;
// Cursor transport and decoded-state limits are separate contracts. The workspace
// owner supports up to MAX_WORKSPACE_DELTA_FILES dirty paths, whose exact stamps
// can exceed the transport representation before compression on large worktrees.
export const MAX_WORKSPACE_CURSOR_TRANSPORT_BYTES = 1024 * 1024;
const MAX_WORKSPACE_CURSOR_DECODED_BYTES = 4 * 1024 * 1024;
const MAX_WORKSPACE_DELTA_FILES = 5_000;
const MAX_WORKSPACE_SNAPSHOT_TEXT_CHARS = 32 * 1024;
const WORKSPACE_GIT_BATCH_CONCURRENCY = 4;
const MAX_CONTEXT_QUERY_CHARS = 4_000;
const MAX_CONTEXT_QUERY_TERMS = 24;
const MAX_CONTEXT_FILES = 20;
const MAX_CONTEXT_SEED_FILES = 100;
const MAX_CONTEXT_DELTA_RETURNED_FILES = 25;
const MAX_CONTEXT_LINES_PER_FILE = 500;
const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_INSPECT_FILES = 120;
const MAX_CONTEXT_TOTAL_INSPECT_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONTEXT_MAX_CHARS = 60_000;
const MAX_CONTEXT_MAX_CHARS = 500_000;

type JsonSchema = Record<string, unknown>;

export interface BuiltinAcceleratorTool {
  name: string;
  purpose: string;
  when_to_use: string;
  when_not_to_use: string;
  readOnly: boolean;
  mutating: boolean;
  inputSchema: JsonSchema;
  recommended_workflow: string[];
  related_capabilities: string[];
}

function createDeadline(timeoutMs: number, maximum = BUILTIN_OPERATION_TIMEOUT_MAX_MS): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > maximum) {
    throw new Error(`Builtin accelerator timeout must be an integer from 100 to ${maximum}ms.`);
  }
  return Date.now() + timeoutMs;
}

function remainingTimeout(deadlineAt: number, perStepMaxMs = GIT_TIMEOUT_MS): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    const error = new Error('Desktop accelerator operation deadline exceeded.') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.min(perStepMaxMs, remaining));
}


function normalizeSlash(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeRepoRelative(value: string): string {
  const hasControlCharacter = [0, 10, 13].some((code) => value.includes(String.fromCharCode(code)));
  if (!value || hasControlCharacter) {
    throw new Error('Repository-relative path must be a non-empty single-line path.');
  }
  const slash = normalizeSlash(value);
  if (slash.startsWith('/') || /^[A-Za-z]:\//.test(slash)) {
    throw new Error(`Absolute path is not allowed in expectedFiles: ${value}`);
  }
  const normalized = path.posix.normalize(slash);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Path escapes the repository root: ${value}`);
  }
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    throw new Error(`Patching .git is not allowed: ${value}`);
  }
  return normalized;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function assertAllowedArguments(args: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key)).sort();
  if (unknown.length > 0) throw new Error(`${label} received unsupported argument(s): ${unknown.join(', ')}.`);
}

function boundedIntegerArgument(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value !== undefined && typeof value !== 'number') throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  const parsed = value === undefined ? fallback : value;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function pathIdentity(value: string): string {
  const normalized = normalizeRepoRelative(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePathSet(a: string[], b: string[]): boolean {
  const aa = sortedUnique(a.map(pathIdentity));
  const bb = sortedUnique(b.map(pathIdentity));
  return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
}

function parseSha256(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`Invalid SHA-256 value: ${value}`);
  }
  return normalized;
}

async function readFileBytes(filePath: string, deadlineAt: number): Promise<Buffer> {
  return runWithAbortableTimeout(
    (signal) => fs.readFile(filePath, { signal }),
    remainingTimeout(deadlineAt),
    `Read accelerator file ${filePath}`
  );
}

async function sha256File(filePath: string, deadlineAt: number): Promise<string> {
  const content = await readFileBytes(filePath, deadlineAt);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function sha256Text(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function replaceTextFileAtomically(
  filePath: string,
  content: string,
  expectedCurrentHash: string,
  expectedReplacementHash: string,
  deadlineAt: number,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let pendingWrite: Promise<void> | undefined;
  try {
    const stats = await runWithAbortableTimeout(
      (_signal) => fs.stat(filePath),
      remainingTimeout(deadlineAt, 10_000),
      `Stat accelerator edit target ${filePath}`,
    );
    await runWithAbortableTimeout(
      (signal) => {
        pendingWrite = fs.writeFile(tempPath, content, { encoding: 'utf8', mode: stats.mode, signal, flush: true });
        return pendingWrite;
      },
      remainingTimeout(deadlineAt),
      `Write accelerator temp file ${tempPath}`,
    );
    const tempHash = await sha256File(tempPath, deadlineAt);
    if (tempHash !== expectedReplacementHash) {
      throw new Error(`Temporary edit_file replacement hash mismatch for ${filePath}. Original file was preserved.`);
    }
    const assertTargetUnchanged = async () => {
      const currentHash = await sha256File(filePath, deadlineAt);
      if (currentHash !== expectedCurrentHash) {
        throw new Error(`File changed while edit_file prepared its replacement: ${filePath}. No replacement was committed.`);
      }
      if (deadlineAt - Date.now() < 250) {
        const error = new Error('edit_file deadline too close to atomic replacement; original file was preserved.') as NodeJS.ErrnoException;
        error.code = 'ETIMEDOUT';
        throw error;
      }
    };
    await assertTargetUnchanged();
    try {
      await renameReplacingWithRetry(tempPath, filePath, { deadlineAt, beforeRetry: assertTargetUnchanged });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? '';
      const sharingFailure = process.platform === 'win32' && ['EACCES', 'EPERM', 'EBUSY'].includes(code);
      if (!sharingFailure) throw error;

      const remaining = deadlineAt - Date.now();
      const diagnosticBudget = Math.min(1_500, remaining - 250);
      const lockers = diagnosticBudget >= 100
        ? await findWindowsFileLockers(filePath, diagnosticBudget)
        : [];
      const blockerSummary = lockers.length > 0
        ? ` Blocking processes: ${lockers.map((locker) => {
            const label = locker.appName || locker.serviceName || locker.applicationType || 'unknown process';
            return `${label} (PID ${locker.pid})`;
          }).join(', ')}.`
        : ' No blocking process could be identified before the operation deadline.';
      const wrapped = new Error(
        `FILE_LOCKED: Atomic replacement of ${filePath} was blocked by Windows after retrying (${code}).` +
        blockerSummary + ' Original file was preserved.',
      ) as NodeJS.ErrnoException;
      wrapped.code = 'EFILELOCKED';
      Object.assign(wrapped, { cause: error, lockers });
      throw wrapped;
    }
  } catch (error) {
    if (pendingWrite) {
      void pendingWrite.catch(() => undefined).finally(() => fs.rm(tempPath, { force: true }).catch(() => undefined));
    } else {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

interface StagedAstRewriteFile {
  source: PreparedAstGrepRewriteFile;
  target: string;
  mode: number;
  replacementTemp: string;
  backupTemp: string;
  committed: boolean;
}

function absolutePathIdentity(value: string): string {
  const normalized = normalizeSlash(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function writeAstRewriteTemp(
  filePath: string, bytes: Buffer, mode: number, deadlineAt: number, label: string,
): Promise<void> {
  await runWithAbortableTimeout(
    (signal) => fs.writeFile(filePath, bytes, { mode, signal, flush: true }),
    remainingTimeout(deadlineAt),
    label,
  );
  await runWithAbortableTimeout(
    (_signal) => fs.chmod(filePath, mode),
    remainingTimeout(deadlineAt),
    `${label} mode restore`,
  );
}

async function cleanupAstRewriteTemp(filePath: string): Promise<void> {
  const pending = fs.rm(filePath, { force: true });
  await runWithAbortableTimeout(
    (_signal) => pending,
    1_500,
    `Clean ast rewrite temp file ${filePath}`,
  ).catch(() => {
    // fs.rm is not AbortSignal-aware; keep best-effort cleanup owned if it
    // completes after the response budget rather than pinning tool completion.
    void pending.catch(() => undefined);
  });
}

async function applyPreparedAstRewriteFiles(
  repoRoot: string, files: PreparedAstGrepRewriteFile[], deadlineAt: number,
) {
  if (files.length === 0) return { applied: false, files: [], beforeHashes: {}, afterHashes: {} };
  const resolved = await resolveExpectedPatchFiles(repoRoot, files.map((file) => file.relative), deadlineAt);
  const preparedByPath = new Map(files.map((file) => [pathIdentity(file.relative), file]));
  const targets = resolved.map((entry) => {
    const source = preparedByPath.get(pathIdentity(entry.relative));
    if (!source) throw new Error(`AST_REWRITE_INTERNAL_FILESET_MISMATCH: ${entry.relative}`);
    if (absolutePathIdentity(source.absolute) !== absolutePathIdentity(entry.absolute)) {
      throw new Error(`AST_REWRITE_PATH_CHANGED: ${entry.relative} no longer resolves to the previewed file.`);
    }
    return { entry, source };
  });
  const release = await acquireCoordinatedMutationOwnership(
    resolved.map((file) => file.absolute), deadlineAt, { label: 'ast_rewrite' },
  );
  const staged: StagedAstRewriteFile[] = [];
  const preservedBackups = new Set<string>();
  try {
    for (const { entry, source } of targets) {
      const currentHash = await sha256File(entry.absolute, deadlineAt);
      if (currentHash !== source.beforeHash) {
        throw new Error(`AST_REWRITE_SOURCE_CHANGED: ${entry.relative} changed before mutation lock acquisition.`);
      }
      const stats = await runWithAbortableTimeout(
        (_signal) => fs.stat(entry.absolute), remainingTimeout(deadlineAt, 10_000),
        `Stat ast rewrite target ${entry.relative}`,
      );
      const nonce = `${process.pid}.${crypto.randomUUID()}`;
      const replacementTemp = path.join(path.dirname(entry.absolute), `.${path.basename(entry.absolute)}.${nonce}.ast-new.tmp`);
      const backupTemp = path.join(path.dirname(entry.absolute), `.${path.basename(entry.absolute)}.${nonce}.ast-backup.tmp`);
      const stagedItem = { source, target: entry.absolute, mode: stats.mode, replacementTemp, backupTemp, committed: false };
      // Register cleanup ownership before the first temp write so a failure while
      // creating either image cannot leak a half-staged file into the workspace.
      staged.push(stagedItem);
      await writeAstRewriteTemp(replacementTemp, source.after, stats.mode, deadlineAt, `Stage ast rewrite replacement ${entry.relative}`);
      await writeAstRewriteTemp(backupTemp, source.before, stats.mode, deadlineAt, `Stage ast rewrite rollback image ${entry.relative}`);
      if (await sha256File(replacementTemp, deadlineAt) !== source.afterHash) {
        throw new Error(`AST_REWRITE_STAGE_HASH_MISMATCH: replacement image for ${entry.relative} is not byte-exact.`);
      }
      if (await sha256File(backupTemp, deadlineAt) !== source.beforeHash) {
        throw new Error(`AST_REWRITE_BACKUP_HASH_MISMATCH: rollback image for ${entry.relative} is not byte-exact.`);
      }
    }

    for (const item of staged) {
      if (await sha256File(item.target, deadlineAt) !== item.source.beforeHash) {
        throw new Error(`AST_REWRITE_SOURCE_CHANGED: ${item.source.relative} changed while replacements were staged.`);
      }
    }
    if (deadlineAt - Date.now() < 4_000) {
      const error = new Error('ast_rewrite deadline too close to byte-exact commit phase; no source file was changed.') as NodeJS.ErrnoException;
      error.code = 'ETIMEDOUT';
      throw error;
    }

    try {
      for (const item of staged) {
        const assertTargetUnchanged = async () => {
          const currentHash = await sha256File(item.target, deadlineAt);
          if (currentHash !== item.source.beforeHash) {
            throw new Error(`AST_REWRITE_SOURCE_CHANGED: ${item.source.relative} changed before atomic replacement.`);
          }
        };
        await assertTargetUnchanged();
        await renameReplacingWithRetry(item.replacementTemp, item.target, { deadlineAt, beforeRetry: assertTargetUnchanged });
        item.committed = true;
      }
      for (const item of staged) {
        const actual = await sha256File(item.target, deadlineAt);
        if (actual !== item.source.afterHash) {
          throw new Error(`AST_REWRITE_AFTER_HASH_MISMATCH: ${item.source.relative} is not the computed post-image.`);
        }
      }
    } catch (commitError) {
      const rollbackDeadline = Date.now() + 8_000;
      const rollbackErrors: string[] = [];
      for (const item of [...staged].reverse()) {
        if (!item.committed) continue;
        try {
          const current = await sha256File(item.target, rollbackDeadline);
          if (current !== item.source.afterHash) {
            preservedBackups.add(item.backupTemp);
            rollbackErrors.push(`${item.source.relative}: target changed after commit; external bytes were preserved`);
            continue;
          }
          await renameReplacingWithRetry(item.backupTemp, item.target, { deadlineAt: rollbackDeadline });
          const restored = await sha256File(item.target, rollbackDeadline);
          if (restored !== item.source.beforeHash) {
            preservedBackups.add(item.backupTemp);
            rollbackErrors.push(`${item.source.relative}: rollback hash mismatch`);
          }
        } catch (rollbackError) {
          preservedBackups.add(item.backupTemp);
          rollbackErrors.push(`${item.source.relative}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (rollbackErrors.length > 0) {
        const error = new Error(
          `AST_REWRITE_ROLLBACK_INCOMPLETE: ${rollbackErrors.join('; ')}. ` +
          `Recovery backups preserved at: ${[...preservedBackups].join(', ')}. ` +
          `Original error: ${commitError instanceof Error ? commitError.message : String(commitError)}`,
        ) as NodeJS.ErrnoException;
        error.code = 'EASTREWRITEPARTIAL';
        throw error;
      }
      const error = new Error(
        `AST_REWRITE_APPLY_ABORTED: committed files were restored. ${commitError instanceof Error ? commitError.message : String(commitError)}`,
      ) as NodeJS.ErrnoException;
      error.code = 'EASTREWRITEABORTED';
      throw error;
    }

    const expectedFiles = files.map((file) => file.relative);
    const checked = await runGit(
      repoRoot, ['diff', '--check', '--', ...expectedFiles], undefined,
      Math.max(100, Math.min(3_000, deadlineAt - Date.now())),
    ).catch((error) => ({ stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 }));
    const verificationOutput = (checked.stdout + checked.stderr).trim();
    const verificationLimit = 16_000;
    const verificationTruncated = verificationOutput.length > verificationLimit;
    return {
      applied: true,
      files: expectedFiles,
      beforeHashes: Object.fromEntries(files.map((file) => [file.relative, `sha256:${file.beforeHash}`])),
      afterHashes: Object.fromEntries(files.map((file) => [file.relative, `sha256:${file.afterHash}`])),
      diffCheck: {
        ok: checked.exitCode === 0,
        exitCode: checked.exitCode,
        output: verificationTruncated
          ? `${verificationOutput.slice(0, verificationLimit)}… [${verificationOutput.length - verificationLimit} verification chars omitted]`
          : verificationOutput,
        outputTruncated: verificationTruncated,
      },
      byteExact: true,
    };
  } finally {
    const cleanupTasks: Promise<void>[] = [];
    for (const item of staged) {
      cleanupTasks.push(cleanupAstRewriteTemp(item.replacementTemp));
      if (!preservedBackups.has(item.backupTemp)) cleanupTasks.push(cleanupAstRewriteTemp(item.backupTemp));
    }
    await Promise.all(cleanupTasks);
    await release();
  }
}

async function runGit(
  root: string, args: string[], input?: string, timeoutMs = GIT_TIMEOUT_MS,
): Promise<BoundedSubprocessResult> {
  const gitExecutable = process.platform === 'win32' ? 'git.exe' : 'git';
  return runBoundedSubprocess(gitExecutable, ['-C', root, ...args], {
    input, timeoutMs, maxOutputBytes: MAX_GIT_OUTPUT_BYTES, label: 'Git accelerator subprocess',
  });
}

function requireGitSuccess(result: BoundedSubprocessResult, label: string): string {
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${label} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

async function resolveRepository(root: string, deadlineAt: number): Promise<{ requestedRoot: string; repoRoot: string }> {
  const requestedRoot = await validatePath(root, remainingTimeout(deadlineAt, 10_000));
  const top = await runGit(
    requestedRoot,
    ['rev-parse', '--show-toplevel'],
    undefined,
    remainingTimeout(deadlineAt)
  );
  const repoRootRaw = requireGitSuccess(top, 'git rev-parse --show-toplevel').trim();
  const repoRoot = await validatePath(repoRootRaw, remainingTimeout(deadlineAt, 10_000));
  remainingTimeout(deadlineAt); // fail before caller can enter a mutation phase
  return { requestedRoot, repoRoot };
}

function zeroDelimitedNames(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean).map(normalizeRepoRelative);
}

function zeroDelimitedChangedNames(stdout: string): string[] {
  const tokens = stdout.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const names: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) throw new Error('Malformed git --name-status output: missing status token.');
    const pathCount = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
      const value = tokens[index++];
      if (!value) throw new Error(`Malformed git --name-status output after status '${status}'.`);
      names.push(normalizeRepoRelative(value));
    }
  }
  return names;
}

function withoutManagedTrashStatusLines(value: string): string {
  const marker = MANAGED_TRASH_DIRECTORY_NAME.toLocaleLowerCase();
  return value.split(/\r?\n/).filter((line) => {
    if (!line) return false;
    const body = normalizeSlash(line.length >= 3 ? line.slice(3).trim() : line)
      .replace(/^"|"$/g, '').toLocaleLowerCase();
    return body !== marker && !body.startsWith(`${marker}/`)
      && !body.includes(` -> ${marker}/`) && !body.includes(` -> ${marker}`);
  }).join('\n');
}

function boundedWorkspaceSnapshotText(value: string) {
  const originalChars = value.length;
  if (originalChars <= MAX_WORKSPACE_SNAPSHOT_TEXT_CHARS) {
    return { text: value, truncated: false, originalChars };
  }
  const marker = `\n...[${originalChars - MAX_WORKSPACE_SNAPSHOT_TEXT_CHARS} chars omitted from duplicate snapshot text]...\n`;
  const retained = Math.max(0, MAX_WORKSPACE_SNAPSHOT_TEXT_CHARS - marker.length);
  const head = Math.floor(retained / 2);
  const tail = retained - head;
  return {
    text: `${value.slice(0, head)}${marker}${value.slice(-tail)}`,
    truncated: true,
    originalChars,
  };
}

async function workspaceSnapshot(args: Record<string, unknown>, deadlineAt: number) {
  const root = typeof args.root === 'string' ? args.root : '';
  if (!root) throw new Error('workspace_snapshot.root is required.');
  const includeDiffStat = args.includeDiffStat !== false;
  const { repoRoot } = await resolveRepository(root, deadlineAt);
  const run = (gitArgs: string[]) =>
    runGit(repoRoot, gitArgs, undefined, remainingTimeout(deadlineAt));

  const [
    branchResult,
    headResult,
    upstreamResult,
    statusResult,
    unstagedResult,
    stagedResult,
    untrackedResult,
    diffCheckResult,
    diffStatResult,
  ] = await Promise.all([
    run(['symbolic-ref', '--short', '-q', 'HEAD']),
    run(['rev-parse', 'HEAD']),
    run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    run(['status', '--short', '--untracked-files=all', '--ignore-submodules=none']),
    run(['diff', '--name-status', '-z', '--ignore-submodules=none']),
    run(['diff', '--cached', '--name-status', '-z', '--ignore-submodules=none']),
    run(['ls-files', '--others', '--exclude-standard', '-z']),
    run(['diff', '--check']),
    includeDiffStat ? run(['diff', '--stat', 'HEAD', '--ignore-submodules=none']) : Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  ]);

  const head = requireGitSuccess(headResult, 'git rev-parse HEAD').trim();
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
  const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const divergence = await run(['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
    if (divergence.exitCode === 0) {
      const [left, right] = divergence.stdout.trim().split(/\s+/).map(Number);
      ahead = Number.isFinite(left) ? left : 0;
      behind = Number.isFinite(right) ? right : 0;
    }
  }

  const statusShort = withoutManagedTrashStatusLines(
    requireGitSuccess(statusResult, 'git status --short').trimEnd(),
  );
  const changedFiles = sortedUnique([
    ...zeroDelimitedChangedNames(requireGitSuccess(unstagedResult, 'git diff --name-status')),
    ...zeroDelimitedChangedNames(requireGitSuccess(stagedResult, 'git diff --cached --name-status')),
    ...zeroDelimitedNames(requireGitSuccess(untrackedResult, 'git ls-files --others')),
  ].filter((relativePath) => !isManagedTrashRelativePath(relativePath)));
  const rawDiffStat = includeDiffStat
    ? requireGitSuccess(diffStatResult, 'git diff --stat HEAD').trimEnd()
    : undefined;
  const boundedStatus = boundedWorkspaceSnapshotText(statusShort);
  const boundedDiffCheck = boundedWorkspaceSnapshotText((diffCheckResult.stdout + diffCheckResult.stderr).trim());
  const boundedDiffStat = rawDiffStat === undefined ? undefined : boundedWorkspaceSnapshotText(rawDiffStat);

  return {
    repositoryRoot: normalizeSlash(repoRoot),
    branch,
    head,
    upstream,
    ahead,
    behind,
    dirty: changedFiles.length > 0,
    changedFiles,
    statusShort: boundedStatus.text,
    statusShortTruncated: boundedStatus.truncated,
    statusShortChars: boundedStatus.originalChars,
    diffCheck: {
      ok: diffCheckResult.exitCode === 0,
      exitCode: diffCheckResult.exitCode,
      output: boundedDiffCheck.text,
      outputTruncated: boundedDiffCheck.truncated,
      outputChars: boundedDiffCheck.originalChars,
    },
    ...(boundedDiffStat ? {
      diffStat: boundedDiffStat.text,
      diffStatTruncated: boundedDiffStat.truncated,
      diffStatChars: boundedDiffStat.originalChars,
    } : {}),
  };
}

type WorkspaceDirtyStamp = {
  exists: boolean;
  kind: 'file' | 'symlink' | 'other' | 'missing';
  gitState?: string;
  indexState?: string;
  mode?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  sha256?: string;
};

type WorkspaceCursorPayload = {
  v: 1;
  repo: string;
  head: string;
  dirty: Record<string, WorkspaceDirtyStamp>;
};

function repoIdentity(repoRoot: string): string {
  const normalized = normalizeSlash(path.resolve(repoRoot));
  return sha256Text(process.platform === 'win32' ? normalized.toLowerCase() : normalized);
}

function encodeWorkspaceCursor(payload: WorkspaceCursorPayload): string {
  const cursorPayload: WorkspaceCursorPayload = {
    ...payload,
    dirty: Object.fromEntries(Object.entries(payload.dirty).map(([relativePath, stamp]) => {
      if (stamp.sha256 === undefined) return [relativePath, stamp];
      // Exact dirty comparison already uses SHA-256 (plus identity/git/index/mode)
      // when both stamps are hashed, so persisting these three metadata fields is
      // redundant. Keep them only for oversized/unhashed files where metadata is
      // the conservative change detector.
      const { size: _size, mtimeMs: _mtimeMs, ctimeMs: _ctimeMs, ...compact } = stamp;
      return [relativePath, compact];
    })),
  };
  const json = Buffer.from(JSON.stringify(cursorPayload), 'utf8');
  if (json.length > MAX_WORKSPACE_CURSOR_DECODED_BYTES) {
    throw new Error(`workspace_delta decoded cursor state exceeds ${MAX_WORKSPACE_CURSOR_DECODED_BYTES} bytes.`);
  }
  // Self-contained compression keeps cursors portable across processes/restarts
  // without introducing a server-side cursor cache/source of truth. Bound the
  // compressed transport separately from the larger decoded exact-state budget.
  const compressed = deflateRawSync(json, { level: 6 });
  const cursor = `z1.${compressed.toString('base64url')}`;
  if (Buffer.byteLength(cursor, 'utf8') > MAX_WORKSPACE_CURSOR_TRANSPORT_BYTES) {
    throw new Error(`workspace_delta cursor transport exceeds ${MAX_WORKSPACE_CURSOR_TRANSPORT_BYTES} bytes.`);
  }
  return cursor;
}

function validateWorkspaceDirtyStamp(value: unknown, label: string): asserts value is WorkspaceDirtyStamp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const stamp = value as Record<string, unknown>;
  const allowed = new Set(['exists', 'kind', 'gitState', 'indexState', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'sha256']);
  if (Object.keys(stamp).some((key) => !allowed.has(key))) throw new Error(`${label} contains unsupported fields`);
  if (typeof stamp.exists !== 'boolean' || !['file', 'symlink', 'other', 'missing'].includes(String(stamp.kind))) {
    throw new Error(`${label} has invalid exists/kind fields`);
  }
  if ((stamp.exists === false) !== (stamp.kind === 'missing')) throw new Error(`${label} has inconsistent existence state`);
  if (stamp.gitState !== undefined && (typeof stamp.gitState !== 'string' || stamp.gitState.length < 2 || stamp.gitState.length > 16)) {
    throw new Error(`${label}.gitState must be a short porcelain status string`);
  }
  if (stamp.indexState !== undefined && (typeof stamp.indexState !== 'string' || stamp.indexState.length > 512)) {
    throw new Error(`${label}.indexState must be a bounded Git index fingerprint`);
  }
  for (const field of ['mode', 'size', 'mtimeMs', 'ctimeMs'] as const) {
    const number = stamp[field];
    if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number < 0)) {
      throw new Error(`${label}.${field} must be a non-negative finite number`);
    }
  }
  if (stamp.sha256 !== undefined && (typeof stamp.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(stamp.sha256))) {
    throw new Error(`${label}.sha256 must be a lowercase SHA-256 hex string`);
  }
}

function decodeWorkspaceCursor(cursor: string): WorkspaceCursorPayload {
  if (!cursor || Buffer.byteLength(cursor, 'utf8') > MAX_WORKSPACE_CURSOR_TRANSPORT_BYTES) {
    throw new Error('workspace_delta.cursor is invalid or too large.');
  }
  try {
    let rawBuffer: Buffer;
    if (cursor.startsWith('z1.')) {
      const compressed = Buffer.from(cursor.slice(3), 'base64url');
      rawBuffer = inflateRawSync(compressed, { maxOutputLength: MAX_WORKSPACE_CURSOR_DECODED_BYTES });
    } else {
      // Backward compatibility for cursors emitted before compressed z1 format.
      rawBuffer = Buffer.from(cursor, 'base64url');
    }
    if (rawBuffer.length > MAX_WORKSPACE_CURSOR_DECODED_BYTES) throw new Error('decoded cursor too large');
    const parsed = JSON.parse(rawBuffer.toString('utf8')) as Partial<WorkspaceCursorPayload>;
    if (parsed.v !== 1 || typeof parsed.repo !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.repo) ||
        typeof parsed.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(parsed.head) ||
        !parsed.dirty || typeof parsed.dirty !== 'object' || Array.isArray(parsed.dirty)) {
      throw new Error('cursor shape mismatch');
    }
    const entries = Object.entries(parsed.dirty);
    if (entries.length > MAX_WORKSPACE_DELTA_FILES) throw new Error('too many dirty files');
    for (const [relativePath, stamp] of entries) {
      const normalized = normalizeRepoRelative(relativePath);
      if (normalized !== normalizeSlash(relativePath)) throw new Error(`non-canonical dirty path: ${relativePath}`);
      validateWorkspaceDirtyStamp(stamp, `dirty['${relativePath}']`);
    }
    return parsed as WorkspaceCursorPayload;
  } catch (error) {
    throw new Error(`Invalid workspace_delta cursor: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function repoAbsolutePath(repoRoot: string, relativePath: string): string {
  const normalized = normalizeRepoRelative(relativePath);
  const absolute = path.resolve(repoRoot, normalized);
  const relative = path.relative(repoRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Repository path escapes root: ${relativePath}`);
  }
  return absolute;
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function workspaceDirtyStamp(
  repoRoot: string,
  relativePath: string,
  gitState: string | undefined,
  indexState: string | undefined,
  deadlineAt: number,
): Promise<WorkspaceDirtyStamp> {
  const absolute = repoAbsolutePath(repoRoot, relativePath);
  try {
    const stats = await runWithAbortableTimeout(
      (_signal) => fs.lstat(absolute),
      remainingTimeout(deadlineAt),
      `Stat workspace delta file ${absolute}`,
    );
    const common = { gitState, indexState, mode: stats.mode, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
    if (stats.isSymbolicLink()) {
      const target = await runWithAbortableTimeout(
        (_signal) => fs.readlink(absolute),
        remainingTimeout(deadlineAt),
        `Read workspace delta symlink ${absolute}`,
      );
      return { exists: true, kind: 'symlink', ...common, sha256: sha256Text(`symlink:${target}`) };
    }
    if (!stats.isFile()) return { exists: true, kind: 'other', ...common };
    if (stats.size > MAX_READ_RANGE_FILE_BYTES) return { exists: true, kind: 'file', ...common };
    try {
      const bytes = await runWithAbortableTimeout(
        (signal) => readFileBounded(absolute, MAX_READ_RANGE_FILE_BYTES, signal, 'workspace_delta file'),
        remainingTimeout(deadlineAt),
        `Read bounded workspace delta file ${absolute}`,
      );
      return {
        exists: true,
        kind: 'file',
        ...common,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EFBIG') throw error;
      // The path grew after lstat. Preserve a conservative cursor stamp from
      // fresh metadata instead of allocating the enlarged file or failing the
      // whole workspace delta. Omitting sha256 guarantees this transition is
      // visible relative to a prior hashed stamp.
      const refreshed = await runWithAbortableTimeout(
        (_signal) => fs.lstat(absolute),
        remainingTimeout(deadlineAt),
        `Re-stat grown workspace delta file ${absolute}`,
      );
      const refreshedCommon = {
        gitState, indexState, mode: refreshed.mode, size: refreshed.size,
        mtimeMs: refreshed.mtimeMs, ctimeMs: refreshed.ctimeMs,
      };
      if (refreshed.isSymbolicLink()) {
        const target = await runWithAbortableTimeout(
          (_signal) => fs.readlink(absolute),
          remainingTimeout(deadlineAt),
          `Read grown workspace delta symlink ${absolute}`,
        );
        return { exists: true, kind: 'symlink', ...refreshedCommon, sha256: sha256Text(`symlink:${target}`) };
      }
      return { exists: true, kind: refreshed.isFile() ? 'file' : 'other', ...refreshedCommon };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { exists: false, kind: 'missing', gitState, indexState };
    throw error;
  }
}

async function workspaceDirtyState(
  repoRoot: string,
  changedFiles: string[],
  gitStates: Map<string, string>,
  indexStates: Map<string, string>,
  deadlineAt: number,
): Promise<Record<string, WorkspaceDirtyStamp>> {
  if (changedFiles.length > MAX_WORKSPACE_DELTA_FILES) {
    throw new Error(`workspace_delta is limited to ${MAX_WORKSPACE_DELTA_FILES} dirty paths.`);
  }
  const entries = await mapConcurrent(changedFiles, 12, async (relativePath) => [
    relativePath,
    await workspaceDirtyStamp(repoRoot, relativePath, gitStates.get(relativePath), indexStates.get(relativePath), deadlineAt),
  ] as const);
  return Object.fromEntries(entries);
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function dirtyStampEqual(a: WorkspaceDirtyStamp, b: WorkspaceDirtyStamp): boolean {
  if (a.exists !== b.exists || a.kind !== b.kind || a.gitState !== b.gitState ||
      a.indexState !== b.indexState || a.mode !== b.mode) return false;
  if (a.sha256 !== undefined && b.sha256 !== undefined) return a.sha256 === b.sha256;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function gitPathBatches(paths: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const relativePath of paths) {
    // Keep well below Windows CreateProcess command-line limits and avoid one
    // enormous Git pathspec invocation in large dirty worktrees.
    const cost = relativePath.length + 3;
    if (current.length > 0 && (current.length >= 100 || chars + cost > 12_000)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(relativePath);
    chars += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function addIndexStageRecords(output: string, records: Map<string, string[]>): void {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  for (const token of tokens) {
    const separator = token.indexOf('\t');
    if (separator <= 0) throw new Error('Unexpected git ls-files --stage -z record.');
    const header = token.slice(0, separator);
    const relativePath = normalizeRepoRelative(token.slice(separator + 1));
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])$/.exec(header);
    if (!match) throw new Error(`Unexpected Git index stage header: ${header}`);
    const fingerprint = `${match[1]}:${match[2]}:${match[3]}`;
    const existing = records.get(relativePath);
    if (existing) existing.push(fingerprint);
    else records.set(relativePath, [fingerprint]);
  }
}

async function workspaceIndexStates(repoRoot: string, paths: string[], deadlineAt: number): Promise<Map<string, string>> {
  const batches = gitPathBatches(paths);
  const outputs = await mapConcurrent(batches, WORKSPACE_GIT_BATCH_CONCURRENCY, async (batch) => {
    const result = await runGit(
      repoRoot,
      ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...batch],
      undefined,
      remainingTimeout(deadlineAt),
    );
    return requireGitSuccess(result, 'git ls-files --stage -z');
  });
  const records = new Map<string, string[]>();
  for (const output of outputs) addIndexStageRecords(output, records);
  return new Map([...records].map(([relativePath, values]) => [relativePath, values.sort().join('|')]));
}

function parsePorcelainV1States(output: string): Map<string, string> {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const states = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4 || token[2] !== ' ') throw new Error('Unexpected git status --porcelain=v1 -z record.');
    const status = token.slice(0, 2);
    const target = normalizeRepoRelative(token.slice(3));
    states.set(target, status);
    if (status.includes('R') || status.includes('C')) {
      const sourceToken = tokens[++index];
      if (sourceToken === undefined) throw new Error('Truncated rename/copy record in git porcelain status.');
      const source = normalizeRepoRelative(sourceToken);
      states.set(source, `${status}:source`);
    }
  }
  return states;
}

async function workspaceDeltaPreflight(root: string, deadlineAt: number) {
  const { repoRoot } = await resolveRepository(root, deadlineAt);
  const [headResult, porcelainResult] = await Promise.all([
    runGit(repoRoot, ['rev-parse', 'HEAD'], undefined, remainingTimeout(deadlineAt)),
    runGit(
      repoRoot,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      undefined,
      remainingTimeout(deadlineAt),
    ),
  ]);
  const head = requireGitSuccess(headResult, 'git rev-parse HEAD').trim();
  const rawGitStates = parsePorcelainV1States(requireGitSuccess(porcelainResult, 'git status --porcelain=v1 -z'));
  const gitStates = new Map([...rawGitStates].filter(([relativePath]) => !isManagedTrashRelativePath(relativePath)));
  return { repoRoot, head, gitStates, changedFiles: sortedUnique([...gitStates.keys()]) };
}

async function workspaceDelta(args: Record<string, unknown>, deadlineAt: number) {
  assertAllowedArguments(args, ['root', 'cursor'], 'workspace_delta');
  const root = typeof args.root === 'string' ? args.root : '';
  if (!root) throw new Error('workspace_delta.root is required.');
  if (args.cursor !== undefined && typeof args.cursor !== 'string') throw new Error('workspace_delta.cursor must be a string.');
  const cursorText = args.cursor as string | undefined;
  const preflight = await workspaceDeltaPreflight(root, deadlineAt);
  const { repoRoot, head, gitStates, changedFiles: workingTreeChangedFiles } = preflight;
  // Porcelain v1 -z is Git's stable script-facing view of staged, unstaged,
  // untracked and rename/copy state. Dirty fingerprints below add exact index
  // stages plus file identity/content so cursors still detect transitions that
  // preserve worktree bytes.
  const indexStates = await workspaceIndexStates(repoRoot, workingTreeChangedFiles, deadlineAt);
  const currentDirty = await workspaceDirtyState(repoRoot, workingTreeChangedFiles, gitStates, indexStates, deadlineAt);
  const currentPayload: WorkspaceCursorPayload = {
    v: 1,
    repo: repoIdentity(repoRoot),
    head,
    dirty: currentDirty,
  };

  let previous: WorkspaceCursorPayload | undefined;
  let freshInstance = cursorText === undefined;
  let reason = freshInstance ? 'cursor_missing' : undefined;
  if (cursorText !== undefined) {
    previous = decodeWorkspaceCursor(cursorText);
    previous = {
      ...previous,
      dirty: Object.fromEntries(
        Object.entries(previous.dirty).filter(([relativePath]) => !isManagedTrashRelativePath(relativePath)),
      ),
    };
    if (previous.repo !== currentPayload.repo) {
      previous = undefined;
      freshInstance = true;
      reason = 'cursor_repository_mismatch';
    }
  }

  let commitChangedFiles: string[] = [];
  if (previous && previous.head !== currentPayload.head) {
    const diff = await runGit(
      repoRoot,
      ['diff', '--name-status', '-z', previous.head, currentPayload.head],
      undefined,
      remainingTimeout(deadlineAt),
    );
    if (diff.exitCode === 0) {
      commitChangedFiles = zeroDelimitedChangedNames(diff.stdout)
        .filter((relativePath) => !isManagedTrashRelativePath(relativePath));
    } else {
      previous = undefined;
      freshInstance = true;
      reason = 'cursor_head_unavailable';
    }
  }

  const currentKeys = Object.keys(currentDirty);
  const previousDirty = previous?.dirty ?? {};
  const previousKeys = Object.keys(previousDirty);
  const added = previous
    ? currentKeys.filter((name) => !hasOwn(previousDirty, name))
    : currentKeys;
  const removed = previous
    ? previousKeys.filter((name) => !hasOwn(currentDirty, name))
    : [];
  const changed = previous
    ? currentKeys.filter((name) => hasOwn(previousDirty, name) && !dirtyStampEqual(currentDirty[name], previousDirty[name]))
    : [];
  const changedFiles = sortedUnique([
    ...commitChangedFiles,
    ...added,
    ...removed,
    ...changed,
  ]);

  return {
    repositoryRoot: repoRoot,
    freshInstance,
    complete: !freshInstance,
    ...(reason ? { reason } : {}),
    head: currentPayload.head,
    previousHead: previous?.head ?? null,
    headChanged: Boolean(previous && previous.head !== currentPayload.head),
    changedFiles,
    workingTreeChangedFiles,
    dirtyDelta: {
      added: sortedUnique(added),
      changed: sortedUnique(changed),
      removed: sortedUnique(removed),
    },
    cursor: encodeWorkspaceCursor(currentPayload),
  };
}

const CONTEXT_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'then', 'when', 'where', 'what', 'which',
  'use', 'using', 'used', 'implementation', 'usage', 'code', 'file', 'files', 'project', 'tool', 'tools',
  'для', 'или', 'как', 'что', 'это', 'при', 'надо', 'нужно', 'проверь', 'исправь', 'сделай', 'работа', 'проект',
]);

function isTransientContextPath(relativePath: string): boolean {
  const parts = normalizeSlash(relativePath).toLocaleLowerCase().split('/');
  const generatedDirectory = (part: string) =>
    part === 'build' || part === 'dist' || part === 'out' || part === 'node_modules' ||
    part === '.cache' || part === '.pytest_cache' || part === '.mypy_cache' || part === '.ruff_cache' ||
    part === '__pycache__' || part === '.venv' || part === 'venv' || part === 'coverage' ||
    part.startsWith('build-') || part.startsWith('build_') || part.startsWith('cmake-build-') || part.startsWith('cmake-build_');
  const hiddenRuntimeState = parts.some((part, index) =>
    part.startsWith('.') && part.length > 1 && parts.slice(index + 1).some((child) =>
      child === 'state' || child === 'runtime' || child === 'cache' || child === 'tmp' || child === 'logs'));
  if (hiddenRuntimeState || parts.some(generatedDirectory)) return true;
  return parts.some((part) => part === '.tmp' || part.startsWith('.tmp-') || part.startsWith('.tmp_'));
}

function contextPathExplicitlyRequested(relativePath: string, queryLower: string): boolean {
  const normalized = normalizeSlash(relativePath).toLocaleLowerCase();
  const base = path.posix.basename(normalized);
  if (queryLower.includes(normalized) || (base.length >= 3 && queryLower.includes(base))) return true;
  const parts = normalized.split('/');
  if (parts.some((part) => part.startsWith('.') && part.length > 2 && queryLower.includes(part.slice(1)))) return true;
  return parts.some((part) => part.startsWith('.tmp')) && (queryLower.includes('.tmp') || queryLower.includes('tmp'));
}

function contextPathPenalty(relativePath: string, queryLower: string): number {
  const base = path.posix.basename(normalizeSlash(relativePath)).toLocaleLowerCase();
  if (queryLower.includes(base)) return 0;
  const dependencyMetadata = new Set([
    'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
    'uv.lock', 'poetry.lock', 'pipfile.lock', 'cargo.lock', 'composer.lock', 'gemfile.lock', 'go.sum',
  ]);
  return dependencyMetadata.has(base) || base.endsWith('.lock') ? -160 : 0;
}

function extractContextTerms(query: string): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const normalized = value.toLocaleLowerCase().replace(/^_+|_+$/g, '');
    if (normalized.length < 3 || CONTEXT_STOP_WORDS.has(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    values.push(normalized);
  };
  const tokens = query.normalize('NFKC').match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? [];
  for (const token of tokens) {
    add(token);
    for (const part of token.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[_\s]+/)) add(part);
    if (values.length >= MAX_CONTEXT_QUERY_TERMS) break;
  }
  return values.slice(0, MAX_CONTEXT_QUERY_TERMS);
}

function contextLineRanges(hitLines: number[], totalLines: number, contextLines: number, maxLines: number): Array<[number, number]> {
  const raw = hitLines.length > 0
    ? hitLines.map((line) => [Math.max(0, line - contextLines), Math.min(totalLines, line + contextLines + 1)] as [number, number])
    : [[0, Math.min(totalLines, Math.min(maxLines, 40))] as [number, number]];
  raw.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of raw) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  let remaining = maxLines;
  const bounded: Array<[number, number]> = [];
  for (const [start, end] of merged) {
    if (remaining <= 0) break;
    const take = Math.min(end - start, remaining);
    if (take > 0) bounded.push([start, start + take]);
    remaining -= take;
  }
  return bounded;
}

async function contextPack(args: Record<string, unknown>, deadlineAt: number) {
  assertAllowedArguments(args, ['root', 'query', 'workspaceCursor', 'seedFiles', 'maxFiles', 'contextLines', 'maxLinesPerFile', 'maxTotalChars'], 'context_pack');
  const root = typeof args.root === 'string' ? args.root : '';
  const rawQuery = typeof args.query === 'string' ? args.query : '';
  if (!root) throw new Error('context_pack.root is required.');
  if (!rawQuery) throw new Error('context_pack.query is required.');
  if (rawQuery.length > MAX_CONTEXT_QUERY_CHARS) throw new Error(`context_pack.query is limited to ${MAX_CONTEXT_QUERY_CHARS} characters.`);
  const query = rawQuery.trim();
  if (!query) throw new Error('context_pack.query is required.');

  const maxFiles = boundedIntegerArgument(args.maxFiles, 8, 1, MAX_CONTEXT_FILES, 'context_pack.maxFiles');
  const contextLines = boundedIntegerArgument(args.contextLines, 3, 0, 20, 'context_pack.contextLines');
  const maxLinesPerFile = boundedIntegerArgument(args.maxLinesPerFile, 120, 1, MAX_CONTEXT_LINES_PER_FILE, 'context_pack.maxLinesPerFile');
  const maxTotalChars = boundedIntegerArgument(args.maxTotalChars, DEFAULT_CONTEXT_MAX_CHARS, 1, MAX_CONTEXT_MAX_CHARS, 'context_pack.maxTotalChars');

  if (args.workspaceCursor !== undefined && typeof args.workspaceCursor !== 'string') {
    throw new Error('context_pack.workspaceCursor must be a string.');
  }
  const workspaceCursor = args.workspaceCursor as string | undefined;
  const seedFilesRaw = args.seedFiles === undefined ? [] : args.seedFiles;
  if (!Array.isArray(seedFilesRaw) || seedFilesRaw.length > MAX_CONTEXT_SEED_FILES) {
    throw new Error(`context_pack.seedFiles must be an array with at most ${MAX_CONTEXT_SEED_FILES} repository-relative paths.`);
  }
  const seedFilesRequested = sortedUnique(seedFilesRaw.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`context_pack.seedFiles[${index}] must be a non-empty repository-relative path.`);
    }
    try {
      const normalized = normalizeRepoRelative(value);
      if (normalized !== normalizeSlash(value)) throw new Error('path must be canonical');
      return normalized;
    } catch (error) {
      throw new Error(`context_pack.seedFiles[${index}] is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  const delta = await workspaceDelta({ root, ...(workspaceCursor ? { cursor: workspaceCursor } : {}) }, deadlineAt);
  const repoRoot = delta.repositoryRoot as string;
  const scopeRoot = await runWithAbortableTimeout(
    (_signal) => fs.realpath(path.resolve(root), { encoding: 'utf8' }),
    remainingTimeout(deadlineAt, 10_000),
    `Resolve context_pack scope ${root}`,
  );
  const scopeStats = await runWithAbortableTimeout(
    (_signal) => fs.stat(scopeRoot),
    remainingTimeout(deadlineAt, 10_000),
    `Stat context_pack scope ${scopeRoot}`,
  );
  if (!scopeStats.isDirectory()) throw new Error(`context_pack.root must be a directory: ${scopeRoot}`);
  const scopeRelativeRaw = path.relative(repoRoot, scopeRoot);
  if (scopeRelativeRaw === '..' || scopeRelativeRaw.startsWith(`..${path.sep}`) || path.isAbsolute(scopeRelativeRaw)) {
    throw new Error(`context_pack scope escapes repository root: ${scopeRoot}`);
  }
  const scopePrefix = scopeRelativeRaw ? normalizeSlash(scopeRelativeRaw) : '';
  const inScope = (relativePath: string) => !scopePrefix || relativePath === scopePrefix || relativePath.startsWith(`${scopePrefix}/`);
  const queryTerms = extractContextTerms(query);
  const queryLower = query.toLocaleLowerCase();
  const explicitContextPaths = new Set(seedFilesRequested.map((requestedPath) =>
    scopePrefix && !inScope(requestedPath) ? `${scopePrefix}/${requestedPath}` : requestedPath
  ));
  const contextPathAllowed = (relativePath: string) =>
    !isManagedTrashRelativePath(relativePath) && (
      explicitContextPaths.has(relativePath) || !isTransientContextPath(relativePath) || contextPathExplicitlyRequested(relativePath, queryLower)
    );
  const scopedChangedFiles = (delta.changedFiles as string[]).filter((relativePath) => inScope(relativePath) && contextPathAllowed(relativePath));
  const scopedWorkingTreeChangedFiles = (delta.workingTreeChangedFiles as string[])
    .filter((relativePath) => inScope(relativePath) && contextPathAllowed(relativePath));

  const lsFilesArgs = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  if (scopePrefix) lsFilesArgs.push('--', scopePrefix);
  const filesResult = await runGit(
    repoRoot,
    lsFilesArgs,
    undefined,
    remainingTimeout(deadlineAt),
  );
  const allRepoFiles = zeroDelimitedNames(requireGitSuccess(filesResult, 'git ls-files for context_pack'));
  const repoFileSet = new Set(allRepoFiles);
  const repoFiles = allRepoFiles.filter(contextPathAllowed);
  const candidates = new Map<string, { path: string; score: number; reasons: Set<string> }>();
  const candidate = (relativePath: string) => {
    let value = candidates.get(relativePath);
    if (!value) {
      const penalty = contextPathPenalty(relativePath, queryLower);
      const reasons = new Set<string>();
      if (penalty < 0) reasons.add('low_value_path');
      value = { path: relativePath, score: penalty, reasons };
      candidates.set(relativePath, value);
    }
    return value;
  };

  const missingSeedFiles: string[] = [];
  const seedFiles: string[] = [];
  for (const requestedPath of seedFilesRequested) {
    const scopedCandidate = scopePrefix && !inScope(requestedPath)
      ? `${scopePrefix}/${requestedPath}`
      : requestedPath;
    if (!inScope(scopedCandidate) || !repoFileSet.has(scopedCandidate) || !contextPathAllowed(scopedCandidate)) {
      missingSeedFiles.push(requestedPath);
      continue;
    }
    seedFiles.push(scopedCandidate);
    const value = candidate(scopedCandidate);
    value.score += 180;
    value.reasons.add('seed_file');
  }
  for (const relativePath of scopedChangedFiles) {
    if (!repoFileSet.has(relativePath)) continue;
    const value = candidate(relativePath);
    value.score += 100;
    value.reasons.add('workspace_delta');
  }
  for (const relativePath of repoFiles) {
    const lower = relativePath.toLocaleLowerCase();
    const matches = queryTerms.filter((term) => lower.includes(term)).length;
    if (matches > 0) {
      const value = candidate(relativePath);
      value.score += Math.min(80, matches * 20);
      value.reasons.add('path_match');
    }
  }

  if (queryTerms.length > 0) {
    const grepArgs = ['grep', '--untracked', '-l', '-z', '-I', '-i', '-F'];
    for (const term of queryTerms) grepArgs.push('-e', term);
    grepArgs.push('--');
    if (scopePrefix) grepArgs.push(scopePrefix);
    const grep = await runGit(repoRoot, grepArgs, undefined, remainingTimeout(deadlineAt));
    if (grep.exitCode !== 0 && grep.exitCode !== 1) {
      requireGitSuccess(grep, 'git grep for context_pack');
    }
    if (grep.exitCode === 0) {
      for (const relativePath of zeroDelimitedNames(grep.stdout)) {
        if (!contextPathAllowed(relativePath)) continue;
        const value = candidate(relativePath);
        value.score += 30;
        value.reasons.add('content_candidate');
      }
    }
  }

  const initial = [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.min(MAX_CONTEXT_INSPECT_FILES, Math.max(maxFiles * 8, maxFiles)));

  // Canonicalize every candidate before reading it. Git may track symlinks; a
  // lexical repository-relative path alone must never let context_pack follow a
  // link/junction outside the repository and ingest unrelated source.
  const preflight = await mapConcurrent(initial, 8, async (entry) => {
    const lexical = repoAbsolutePath(repoRoot, entry.path);
    try {
      const absolute = await runWithAbortableTimeout(
        (_signal) => fs.realpath(lexical, { encoding: 'utf8' }),
        remainingTimeout(deadlineAt),
        `Resolve context_pack candidate ${lexical}`,
      );
      const relative = path.relative(repoRoot, absolute);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return null;
      }
      const scopedRelative = path.relative(scopeRoot, absolute);
      if (scopedRelative === '..' || scopedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(scopedRelative)) {
        return null;
      }
      const stats = await runWithAbortableTimeout(
        (_signal) => fs.stat(absolute),
        remainingTimeout(deadlineAt),
        `Stat context_pack candidate ${absolute}`,
      );
      if (!stats.isFile() || stats.size > MAX_CONTEXT_FILE_BYTES) return null;
      return { entry, absolute, size: stats.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
  });

  type SelectedContextCandidate = NonNullable<(typeof preflight)[number]>;
  let preflightSelectedBytes = 0;
  const selected: SelectedContextCandidate[] = [];
  for (const item of preflight) {
    if (!item) continue;
    if (preflightSelectedBytes + item.size > MAX_CONTEXT_TOTAL_INSPECT_BYTES) continue;
    preflightSelectedBytes += item.size;
    selected.push(item);
  }

  type InspectedContextCandidate = {
    path: string; score: number; reasons: string[]; hash: string; lines: string[]; hitLines: number[];
  };
  const inspectContextCandidate = async (
    { entry, absolute }: (typeof selected)[number],
    maxBytes: number,
  ): Promise<{ value: InspectedContextCandidate | null; bytesRead: number; aggregateLimit: boolean }> => {
    try {
      const bytes = await runWithAbortableTimeout(
        (signal) => readFileBounded(absolute, maxBytes, signal, 'context_pack candidate'),
        remainingTimeout(deadlineAt),
        `Read bounded context_pack candidate ${absolute}`,
      );
      if (await isBinaryFile(bytes, bytes.length)) return { value: null, bytesRead: bytes.length, aggregateLimit: false };
      const text = bytes.toString('utf8');
      const lines = text ? text.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [] : [];
      const hitLines: number[] = [];
      let termHits = 0;
      for (let index = 0; index < lines.length; index++) {
        const lower = lines[index].toLocaleLowerCase();
        let hit = false;
        for (const term of queryTerms) {
          if (lower.includes(term)) { termHits += 1; hit = true; }
        }
        if (hit) hitLines.push(index);
      }
      const reasons = new Set(entry.reasons);
      let score = entry.score;
      if (hitLines.length > 0) {
        score += Math.min(100, hitLines.length * 6 + termHits * 2);
        reasons.add('content_match');
      }
      if (queryLower.length <= 200 && text.toLocaleLowerCase().includes(queryLower)) {
        score += 25;
        reasons.add('phrase_match');
      }
      return {
        value: {
          path: entry.path, score, reasons: [...reasons].sort(),
          hash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, lines, hitLines,
        },
        bytesRead: bytes.length,
        aggregateLimit: false,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return { value: null, bytesRead: 0, aggregateLimit: false };
      if (code === 'EFBIG' && maxBytes < MAX_CONTEXT_FILE_BYTES) {
        return { value: null, bytesRead: 0, aggregateLimit: true };
      }
      throw error;
    }
  };

  const inspected: InspectedContextCandidate[] = [];
  let inspectedBytes = 0;
  let inspectedCandidateCount = 0;
  let inspectionByteLimitReached = false;
  for (let cursor = 0; cursor < selected.length;) {
    const remainingBudget = MAX_CONTEXT_TOTAL_INSPECT_BYTES - inspectedBytes;
    if (remainingBudget <= 0) { inspectionByteLimitReached = true; break; }
    const fullSlots = Math.floor(remainingBudget / MAX_CONTEXT_FILE_BYTES);
    const batchSize = Math.min(8, selected.length - cursor, Math.max(1, fullSlots));
    const perFileBudget = fullSlots > 0 ? MAX_CONTEXT_FILE_BYTES : remainingBudget;
    const batch = selected.slice(cursor, cursor + batchSize);
    const batchResults = await mapConcurrent(batch, batchSize, (item) => inspectContextCandidate(item, perFileBudget));
    cursor += batchSize;
    let stop = false;
    for (const result of batchResults) {
      if (result.aggregateLimit) { inspectionByteLimitReached = true; stop = true; break; }
      inspectedBytes += result.bytesRead;
      if (result.bytesRead > 0 || result.value !== null) inspectedCandidateCount += 1;
      if (result.value !== null) inspected.push(result.value);
    }
    if (stop) break;
  }

  const ranked = inspected.filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const files = [];
  let returnedChars = 0;
  let responseTruncated = false;
  for (const entry of ranked.slice(0, maxFiles)) {
    const ranges = contextLineRanges(entry.hitLines, entry.lines.length, contextLines, maxLinesPerFile);
    const parts: string[] = [];
    for (const [start, end] of ranges) {
      if (parts.length > 0) parts.push('...\n');
      for (let index = start; index < end; index++) {
        const line = entry.lines[index].replace(/(?:\r\n|\n|\r)$/, '');
        parts.push(`${index + 1}: ${line}\n`);
      }
    }
    let content = parts.join('');
    const remaining = maxTotalChars - returnedChars;
    if (remaining <= 0) { responseTruncated = true; break; }
    let truncated = false;
    if (content.length > remaining) {
      content = content.slice(0, remaining);
      truncated = true;
      responseTruncated = true;
    }
    returnedChars += content.length;
    files.push({
      path: entry.path,
      score: entry.score,
      reasons: entry.reasons,
      hash: entry.hash,
      matchedLines: entry.hitLines.slice(0, 200).map((line) => line + 1),
      ranges: ranges.map(([start, end]) => ({ startLine: start + 1, endLine: end })),
      content,
      truncated,
    });
    if (responseTruncated) break;
  }

  const contextCursorPayload = decodeWorkspaceCursor(delta.cursor as string);
  contextCursorPayload.dirty = Object.fromEntries(
    Object.entries(contextCursorPayload.dirty)
      .filter(([relativePath]) => inScope(relativePath) && contextPathAllowed(relativePath)),
  );
  const contextWorkspaceCursor = encodeWorkspaceCursor(contextCursorPayload);

  return {
    repositoryRoot: repoRoot,
    scopeRoot,
    scopePrefix,
    query,
    queryTerms,
    workspaceDelta: {
      freshInstance: delta.freshInstance,
      complete: delta.complete,
      changedFileCount: scopedChangedFiles.length,
      changedFiles: scopedChangedFiles.slice(0, MAX_CONTEXT_DELTA_RETURNED_FILES),
      changedFilesTruncated: scopedChangedFiles.length > MAX_CONTEXT_DELTA_RETURNED_FILES,
      workingTreeChangedFileCount: scopedWorkingTreeChangedFiles.length,
      workingTreeChangedFiles: scopedWorkingTreeChangedFiles.slice(0, MAX_CONTEXT_DELTA_RETURNED_FILES),
      workingTreeChangedFilesTruncated: scopedWorkingTreeChangedFiles.length > MAX_CONTEXT_DELTA_RETURNED_FILES,
    },
    workspaceCursor: contextWorkspaceCursor,
    candidateCount: candidates.size,
    inspectedCandidateCount,
    inspectedBytes,
    inspectionByteLimit: MAX_CONTEXT_TOTAL_INSPECT_BYTES,
    inspectionByteLimitReached,
    seedFilesAccepted: seedFiles.filter((relativePath) => repoFileSet.has(relativePath)),
    missingSeedFiles,
    files,
    returnedChars,
    responseTruncated,
    semanticFollowupTerms: queryTerms.slice(0, 5),
  };
}

async function readRanges(args: Record<string, unknown>, deadlineAt: number) {
  const requests = Array.isArray(args.requests) ? args.requests : [];
  if (requests.length === 0) throw new Error('read_ranges.requests must contain at least one range.');
  if (requests.length > MAX_READ_RANGES) {
    throw new Error(`read_ranges.requests is limited to ${MAX_READ_RANGES} ranges per call.`);
  }

  const maxTotalChars = args.maxTotalChars === undefined
    ? DEFAULT_READ_RANGES_MAX_CHARS
    : Number(args.maxTotalChars);
  if (!Number.isInteger(maxTotalChars) || maxTotalChars < 1 || maxTotalChars > MAX_READ_RANGES_MAX_CHARS) {
    throw new Error(`read_ranges.maxTotalChars must be an integer from 1 to ${MAX_READ_RANGES_MAX_CHARS}.`);
  }

  const parsed = requests.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`read_ranges.requests[${index}] must be an object.`);
    }
    const request = raw as Record<string, unknown>;
    const requestedPath = typeof request.path === 'string' ? request.path : '';
    if (!requestedPath) throw new Error(`read_ranges.requests[${index}].path is required.`);
    const offset = request.offset === undefined ? 0 : Number(request.offset);
    const length = request.length === undefined ? 200 : Number(request.length);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`read_ranges.requests[${index}].offset must be a non-negative integer.`);
    }
    if (!Number.isInteger(length) || length < 1 || length > MAX_READ_RANGE_LINES) {
      throw new Error(`read_ranges.requests[${index}].length must be an integer from 1 to ${MAX_READ_RANGE_LINES}.`);
    }
    let knownHash: string | undefined;
    if (request.knownHash !== undefined) {
      if (typeof request.knownHash !== 'string') {
        throw new Error(`read_ranges.requests[${index}].knownHash must be a SHA-256 string.`);
      }
      knownHash = parseSha256(request.knownHash);
    }
    return { requestedPath, offset, length, knownHash };
  });

  const validated = await Promise.all(parsed.map(async (request) => ({
    ...request,
    validPath: await validatePath(request.requestedPath, remainingTimeout(deadlineAt, 10_000)),
  })));
  const uniquePaths = new Map<string, string>();
  for (const request of validated) {
    const absolute = path.resolve(request.validPath);
    const identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    uniquePaths.set(identity, request.validPath);
  }

  const entries = await Promise.all([...uniquePaths.entries()].map(async ([identity, filePath]) => {
    const stats = await runWithAbortableTimeout(
      (_signal) => fs.stat(filePath),
      remainingTimeout(deadlineAt),
      `Stat read_ranges file ${filePath}`,
    );
    if (!stats.isFile()) throw new Error(`read_ranges path is not a file: ${filePath}`);
    if (stats.size > MAX_READ_RANGE_FILE_BYTES) {
      throw new Error(`read_ranges file exceeds ${MAX_READ_RANGE_FILE_BYTES} bytes: ${filePath}`);
    }
    return { identity, filePath, size: stats.size };
  }));
  const preflightTotalFileBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (preflightTotalFileBytes > MAX_READ_RANGES_TOTAL_FILE_BYTES) {
    throw new Error(`read_ranges unique files total ${preflightTotalFileBytes} bytes; limit is ${MAX_READ_RANGES_TOTAL_FILE_BYTES}.`);
  }

  const loaded = new Map<string, { hash: string; lines: string[]; totalLines: number }>();
  let totalFileBytes = 0;
  // Load sequentially so concurrent file growth cannot make several files burst
  // through the aggregate byte budget before the limit is observed.
  for (const { identity, filePath } of entries) {
    const bytes = await runWithAbortableTimeout(
      (signal) => readFileBounded(filePath, MAX_READ_RANGE_FILE_BYTES, signal, 'read_ranges file'),
      remainingTimeout(deadlineAt),
      `Read bounded read_ranges file ${filePath}`,
    );
    totalFileBytes += bytes.length;
    if (totalFileBytes > MAX_READ_RANGES_TOTAL_FILE_BYTES) {
      throw new Error(`read_ranges unique files total ${totalFileBytes} bytes; limit is ${MAX_READ_RANGES_TOTAL_FILE_BYTES}.`);
    }
    if (await isBinaryFile(bytes, bytes.length)) {
      throw new Error(`read_ranges only supports text files: ${filePath}`);
    }
    const text = bytes.toString('utf8');
    const lines = text ? text.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [] : [];
    loaded.set(identity, {
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      lines,
      totalLines: text === '' ? 0 : lines.length,
    });
  }

  let returnedChars = 0;
  const results = validated.map((request) => {
    const absolute = path.resolve(request.validPath);
    const identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    const data = loaded.get(identity);
    if (!data) throw new Error(`read_ranges internal load failure for ${request.validPath}.`);
    const hash = `sha256:${data.hash}`;
    if (request.knownHash === data.hash) {
      return { path: normalizeSlash(request.validPath), hash, unchanged: true, totalLines: data.totalLines };
    }
    const start = Math.min(request.offset, data.totalLines);
    const end = Math.min(start + request.length, data.totalLines);
    const content = data.lines.slice(start, end).join('');
    returnedChars += content.length;
    return {
      path: normalizeSlash(request.validPath),
      hash,
      unchanged: false,
      offset: start,
      requestedOffset: request.offset,
      requestedLength: request.length,
      returnedLines: end - start,
      totalLines: data.totalLines,
      content,
    };
  });
  if (returnedChars > maxTotalChars) {
    throw new Error(`read_ranges response would contain ${returnedChars} chars; maxTotalChars is ${maxTotalChars}. Narrow the requested ranges.`);
  }
  return { results, returnedChars, uniqueFiles: entries.length, totalFileBytes };
}

function countExactOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function replaceExact(content: string, oldText: string, newText: string, expected: number): string {
  let matchText = oldText;
  let replacementText = newText;
  let actual = countExactOccurrences(content, matchText);
  const withoutCrlf = content.replace(/\r\n/g, '');
  const fileEol = content.includes('\r\n') && !withoutCrlf.includes('\n') ? '\r\n' :
    !content.includes('\r\n') ? '\n' : undefined;
  if (actual !== expected && fileEol && oldText.includes('\n')) {
    matchText = oldText.replace(/\r?\n/g, fileEol);
    replacementText = newText.replace(/\r?\n/g, fileEol);
    actual = countExactOccurrences(content, matchText);
  }
  if (actual !== expected) {
    throw new Error(`Expected ${expected} occurrence(s), found ${actual}. No changes were written.`);
  }
  if (expected === 0) return content;
  return content.split(matchText).join(replacementText);
}

async function editFile(args: Record<string, unknown>, deadlineAt: number) {
  const requestedPath = typeof args.path === 'string' ? args.path : '';
  if (!requestedPath) throw new Error('edit_file.path is required.');
  const validPath = await validatePath(requestedPath, remainingTimeout(deadlineAt, 10_000));
  const releaseMutationLock = await acquireCoordinatedMutationOwnership(
    [validPath], deadlineAt, { label: 'edit_file' },
  );
  try {

  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) throw new Error('edit_file.edits must contain at least one edit.');
  if (edits.length > 100) throw new Error('edit_file.edits is limited to 100 edits per call.');

  // One read owns both the edit source and the compare-and-swap hash. Two
  // independent reads create a race where stale text can be paired with a
  // newer hash and later overwrite the newer file.
  const beforeBytes = await readFileBytes(validPath, deadlineAt);
  if (await isBinaryFile(beforeBytes, beforeBytes.length)) {
    throw new Error('edit_file only supports text files.');
  }
  const beforeHash = crypto.createHash('sha256').update(beforeBytes).digest('hex');
  if (typeof args.expectedHash === 'string' && parseSha256(args.expectedHash) !== beforeHash) {
    throw new Error(`SHA-256 fence failed for ${validPath}. Expected ${args.expectedHash}, actual sha256:${beforeHash}.`);
  }
  const before = beforeBytes.toString('utf8');
  let after = before;
  const applied: Array<{ index: number; replacements: number; oldLength: number; newLength: number }> = [];

  for (let index = 0; index < edits.length; index += 1) {
    const raw = edits[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`edit_file.edits[${index}] must be an object.`);
    }
    const edit = raw as Record<string, unknown>;
    const oldText = typeof edit.oldText === 'string' ? edit.oldText : '';
    const newText = typeof edit.newText === 'string' ? edit.newText : undefined;
    const expected = edit.expectedReplacements === undefined ? 1 : Number(edit.expectedReplacements);
    if (!oldText) throw new Error(`edit_file.edits[${index}].oldText must be non-empty.`);
    if (newText === undefined) throw new Error(`edit_file.edits[${index}].newText is required.`);
    if (!Number.isInteger(expected) || expected < 0 || expected > 10_000) {
      throw new Error(`edit_file.edits[${index}].expectedReplacements must be an integer from 0 to 10000.`);
    }
    after = replaceExact(after, oldText, newText, expected);
    applied.push({ index, replacements: expected, oldLength: oldText.length, newLength: newText.length });
  }

  const afterHash = sha256Text(after);
  const dryRun = args.dryRun !== false;
  if (!dryRun && after !== before) {
    const currentHash = await sha256File(validPath, deadlineAt);
    if (currentHash !== beforeHash) {
      throw new Error(`File changed after edit_file read and before write: ${validPath}. No accelerator write was performed.`);
    }
    await replaceTextFileAtomically(validPath, after, beforeHash, afterHash, deadlineAt);
  }

  return {
    path: normalizeSlash(validPath),
    dryRun,
    changed: before !== after,
    beforeHash: `sha256:${beforeHash}`,
    afterHash: `sha256:${afterHash}`,
    bytesBefore: Buffer.byteLength(before),
    bytesAfter: Buffer.byteLength(after),
    edits: applied,
  };
  } finally {
    await releaseMutationLock();
  }
}

function parseNumstatFiles(stdout: string): string[] {
  const files: string[] = [];
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const fields = record.split('\t');
    if (fields.length < 3) throw new Error('Unexpected git apply --numstat -z output.');
    if (fields[0] === '-' || fields[1] === '-') throw new Error('Binary patches are not allowed.');
    files.push(normalizeRepoRelative(fields.slice(2).join('\t')));
  }
  return sortedUnique(files);
}

function rejectUnsupportedPatchForms(patchText: string): void {
  if (!patchText.trim()) throw new Error('apply_patch.patch must be non-empty.');
  const forbidden = [
    /^GIT binary patch$/m,
    /^Binary files .* differ$/m,
    /^new file mode /m,
    /^deleted file mode /m,
    /^rename from /m,
    /^rename to /m,
    /^copy from /m,
    /^copy to /m,
    /^old mode /m,
    /^new mode /m,
    /^--- \/dev\/null$/m,
    /^\+\+\+ \/dev\/null$/m,
  ];
  if (forbidden.some((pattern) => pattern.test(patchText))) {
    throw new Error('apply_patch v1 only modifies existing text files; binary/new/delete/rename/copy/mode patches are rejected.');
  }
}

async function resolveExpectedPatchFiles(
  repoRoot: string,
  expectedFilesRaw: unknown,
  deadlineAt: number,
): Promise<Array<{ relative: string; absolute: string }>> {
  if (!Array.isArray(expectedFilesRaw) || expectedFilesRaw.length === 0) {
    throw new Error('apply_patch.expectedFiles must list every file the patch may modify.');
  }
  if (expectedFilesRaw.length > MAX_PATCH_FILES) {
    throw new Error(`apply_patch.expectedFiles is limited to ${MAX_PATCH_FILES} files.`);
  }
  const expectedFiles = sortedUnique(expectedFilesRaw.map((value) => {
    if (typeof value !== 'string') throw new Error('apply_patch.expectedFiles must contain only strings.');
    return normalizeRepoRelative(value);
  }));

  const resolved: Array<{ relative: string; absolute: string }> = [];
  for (const relative of expectedFiles) {
    const joined = path.join(repoRoot, ...relative.split('/'));
    const valid = await validatePath(joined, remainingTimeout(deadlineAt, 10_000));
    const repoRelative = normalizeSlash(path.relative(repoRoot, valid));
    const same = process.platform === 'win32'
      ? repoRelative.toLowerCase() === relative.toLowerCase()
      : repoRelative === relative;
    if (!same) {
      throw new Error(`Path resolves outside or through an alias/symlink: ${relative}`);
    }
    const stats = await runWithAbortableTimeout(
      (_signal) => fs.stat(valid),
      remainingTimeout(deadlineAt),
      `Stat patch target ${relative}`
    );
    if (!stats.isFile()) throw new Error(`apply_patch only accepts existing files: ${relative}`);
    const binary = await runWithAbortableTimeout(
      (_signal) => isBinaryFile(valid),
      remainingTimeout(deadlineAt),
      `Inspect patch target ${relative}`
    );
    if (binary) throw new Error(`apply_patch only accepts text files: ${relative}`);
    remainingTimeout(deadlineAt);
    resolved.push({ relative, absolute: valid });
  }
  return resolved;
}

async function verifyExpectedHashes(
  files: Array<{ relative: string; absolute: string }>,
  expectedHashesRaw: unknown,
  deadlineAt: number,
): Promise<Record<string, string>> {
  const expectedHashes = expectedHashesRaw && typeof expectedHashesRaw === 'object' && !Array.isArray(expectedHashesRaw)
    ? expectedHashesRaw as Record<string, unknown>
    : {};
  const allowedIdentities = new Set(files.map((file) => pathIdentity(file.relative)));
  const normalizedExpectedHashes = new Map<string, unknown>();
  for (const [rawPath, expected] of Object.entries(expectedHashes)) {
    const identity = pathIdentity(rawPath);
    if (!allowedIdentities.has(identity)) {
      throw new Error(`expectedHashes contains a path not present in expectedFiles: ${rawPath}`);
    }
    if (normalizedExpectedHashes.has(identity)) {
      throw new Error(`expectedHashes contains duplicate path identities: ${rawPath}`);
    }
    normalizedExpectedHashes.set(identity, expected);
  }

  const currentHashes: Record<string, string> = {};

  for (const file of files) {
    const current = await sha256File(file.absolute, deadlineAt);
    currentHashes[file.relative] = `sha256:${current}`;
    const expected = normalizedExpectedHashes.get(pathIdentity(file.relative));
    if (expected !== undefined) {
      if (typeof expected !== 'string') throw new Error(`expectedHashes['${file.relative}'] must be a string.`);
      if (parseSha256(expected) !== current) {
        throw new Error(`SHA-256 fence failed for ${file.relative}. Expected ${expected}, actual sha256:${current}.`);
      }
    }
  }
  return currentHashes;
}

async function applyPatch(args: Record<string, unknown>, deadlineAt: number) {
  const root = typeof args.root === 'string' ? args.root : '';
  const patchText = typeof args.patch === 'string' ? args.patch : '';
  if (!root) throw new Error('apply_patch.root is required.');
  if (Buffer.byteLength(patchText, 'utf8') > MAX_PATCH_BYTES) {
    throw new Error(`apply_patch.patch is limited to ${MAX_PATCH_BYTES} UTF-8 bytes.`);
  }
  rejectUnsupportedPatchForms(patchText);

  const { repoRoot } = await resolveRepository(root, deadlineAt);
  const files = await resolveExpectedPatchFiles(repoRoot, args.expectedFiles, deadlineAt);
  const releaseMutationLocks = await acquireCoordinatedMutationOwnership(
    files.map((file) => file.absolute), deadlineAt, { label: 'apply_patch' },
  );
  try {
  const beforeHashes = await verifyExpectedHashes(files, args.expectedHashes, deadlineAt);
  const run = (gitArgs: string[], input?: string) =>
    runGit(repoRoot, gitArgs, input, remainingTimeout(deadlineAt));

  const numstat = await run(['apply', '--numstat', '-z', '--'], patchText);
  const patchFiles = parseNumstatFiles(requireGitSuccess(numstat, 'git apply --numstat'));
  const expectedFiles = files.map((file) => file.relative);
  if (!samePathSet(patchFiles, expectedFiles)) {
    throw new Error(
      `Patch file set does not match expectedFiles. Patch touches [${patchFiles.join(', ')}], expected [${expectedFiles.join(', ')}].`,
    );
  }

  const check = await run(['apply', '--check', '--whitespace=error-all', '--'], patchText);
  requireGitSuccess(check, 'git apply --check');

  const dryRun = args.dryRun !== false;
  if (dryRun) {
    return {
      repositoryRoot: normalizeSlash(repoRoot),
      dryRun: true,
      applicable: true,
      files: expectedFiles,
      beforeHashes,
    };
  }

  // Re-check the exact hashes observed before --check immediately before mutation,
  // even when the caller did not provide explicit expectedHashes.
  await verifyExpectedHashes(files, beforeHashes, deadlineAt);
  // Do not enter the mutating phase if almost all of the caller's budget was
  // consumed by validation; leave time for apply + read-back verification.
  if (deadlineAt - Date.now() < 5_000) {
    const error = new Error('apply_patch deadline too close to mutation phase; no patch was applied.') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  const apply = await run(['apply', '--whitespace=error-all', '--'], patchText);
  requireGitSuccess(apply, 'git apply');

  // Once git apply exits successfully the mutation is committed. Verification
  // must never turn that known success into an ambiguous failure, so keep a
  // short post-commit budget and report verification problems as metadata.
  const verificationDeadlineAt = Math.min(deadlineAt - 500, Date.now() + 3_000);
  const afterHashes: Record<string, string> = {};
  let diffCheck: { ok: boolean; exitCode: number; output: string } | undefined;
  let verificationError: string | undefined;
  if (verificationDeadlineAt > Date.now() + 100) {
    try {
      for (const file of files) {
        afterHashes[file.relative] = `sha256:${await sha256File(file.absolute, verificationDeadlineAt)}`;
      }
      const checked = await runGit(
        repoRoot, ['diff', '--check', '--', ...expectedFiles], undefined,
        remainingTimeout(verificationDeadlineAt),
      );
      diffCheck = {
        ok: checked.exitCode === 0,
        exitCode: checked.exitCode,
        output: (checked.stdout + checked.stderr).trim(),
      };
    } catch (error) {
      verificationError = error instanceof Error ? error.message : String(error);
    }
  } else {
    verificationError = 'Post-commit verification skipped because the caller deadline was nearly exhausted.';
  }

  return {
    repositoryRoot: normalizeSlash(repoRoot),
    dryRun: false,
    applied: true,
    files: expectedFiles,
    beforeHashes,
    afterHashes,
    ...(diffCheck ? { diffCheck } : {}),
    ...(verificationError ? { verificationIncomplete: true, verificationError } : {}),
  };
  } finally {
    await releaseMutationLocks();
  }
}

async function waitProcess(args: Record<string, unknown>) {
  const pid = Number(args.pid);
  const timeoutMs = args.timeout_ms === undefined ? PROCESS_WAIT_DEFAULT_MS : Number(args.timeout_ms);
  const stallTimeoutMs = args.stall_timeout_ms === undefined ? PROCESS_STALL_DEFAULT_MS : Number(args.stall_timeout_ms);
  const tailLines = args.tail_lines === undefined ? 100 : Number(args.tail_lines);
  return waitForTerminalProcess(terminalManager, { pid, timeoutMs, stallTimeoutMs, tailLines });
}

const tools: BuiltinAcceleratorTool[] = [
  ...AST_GREP_ACCELERATOR_TOOLS,
  BUILD_METADATA_ACCELERATOR_TOOL,
  CPP_BUILD_CONTEXT_ACCELERATOR_TOOL,
  CPP_BUILD_EXECUTE_ACCELERATOR_TOOL,
  CPP_BUILD_RESULT_ACCELERATOR_TOOL,
  CPP_BUILD_PLAN_ACCELERATOR_TOOL,
  CPP_BUILD_IMPACT_ACCELERATOR_TOOL,
  CPP_TOOLCHAIN_PROFILE_ACCELERATOR_TOOL,
  SAFE_FIX_ACCELERATOR_TOOL,
  {
    name: 'workspace_snapshot',
    purpose: 'Return the Git safety/preflight state needed before code changes in one bounded call.',
    when_to_use: 'At the start of repository work and before impact analysis that needs the exact changed-file set.',
    when_not_to_use: 'For non-Git directories or when a fresh remote fetch is required; this tool never fetches.',
    readOnly: true,
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['root'],
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: 'Path anywhere inside the Git repository.' },
        includeDiffStat: { type: 'boolean', default: true },
      },
    },
    recommended_workflow: [
      'Call once before repository mutations.',
      'Preserve unknown dirty files.',
      'Pass changedFiles to impact-analysis tools instead of recomputing Git state.',
    ],
    related_capabilities: ['git status', 'git diff --check', 'code-review-graph changed_files'],
  },
  {
    name: 'workspace_delta',
    purpose: 'Return a conservative cursor-based Git/worktree delta without rescanning unchanged file contents.',
    when_to_use: 'Between repository turns to discover what changed since the prior workspace cursor.',
    when_not_to_use: 'As a replacement for a full refresh after a missing, foreign, or unavailable cursor baseline.',
    readOnly: true,
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['root'],
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: 'Path anywhere inside the Git repository.' },
        cursor: { type: 'string', description: 'Opaque cursor returned by a prior workspace_delta/context_pack call.' },
      },
    },
    recommended_workflow: [
      'Persist the returned cursor in agent/task state, not in the target repository.',
      'Treat freshInstance=true as an incomplete baseline and perform normal discovery when required.',
      'Use changedFiles to avoid repeating expensive semantic/index work for unchanged paths.',
    ],
    related_capabilities: ['workspace_snapshot', 'Watchman clocks', 'Git FSMonitor'],
  },
  {
    name: 'context_pack',
    purpose: 'Build a bounded deterministic task-oriented source context pack from workspace delta, path relevance, and exact content matches.',
    when_to_use: 'When a task/query is known and you want a small ranked set of exact source ranges before broader reads.',
    when_not_to_use: 'For compiler-accurate symbol identity; use Serena/SCIP after this narrowing step when semantics matter.',
    readOnly: true,
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['root', 'query'],
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: 'Path anywhere inside the Git repository.' },
        query: { type: 'string', minLength: 1, maxLength: MAX_CONTEXT_QUERY_CHARS },
        workspaceCursor: { type: 'string', description: 'Optional cursor from a previous workspace_delta/context_pack call.' },
        seedFiles: {
          type: 'array',
          maxItems: MAX_CONTEXT_SEED_FILES,
          items: { type: 'string' },
          description: 'Optional repository-relative relevance seeds, e.g. CRG impacted_files or exact semantic candidates.',
        },
        maxFiles: { type: 'integer', minimum: 1, maximum: MAX_CONTEXT_FILES, default: 8 },
        contextLines: { type: 'integer', minimum: 0, maximum: 20, default: 3 },
        maxLinesPerFile: { type: 'integer', minimum: 1, maximum: MAX_CONTEXT_LINES_PER_FILE, default: 120 },
        maxTotalChars: { type: 'integer', minimum: 1, maximum: MAX_CONTEXT_MAX_CHARS, default: DEFAULT_CONTEXT_MAX_CHARS },
      },
    },
    recommended_workflow: [
      'Use the task text directly; the tool deterministically extracts bounded lexical terms.',
      'Pass CRG impacted_files or exact semantic candidate paths through seedFiles when graph/semantic narrowing is already available.',
      'Reuse workspaceCursor on the next turn so newly changed files are boosted without replaying unchanged context.',
      'Escalate semanticFollowupTerms or selected files to Serena/SCIP only where exact symbol identity matters.',
    ],
    related_capabilities: ['workspace_delta', 'read_ranges', 'ast_search', 'CRG impact', 'Serena/SCIP'],
  },
  {
    name: 'read_ranges',
    purpose: 'Read many bounded text-file line ranges in one call and suppress unchanged content using SHA-256 validators.',
    when_to_use: 'After search/semantic tools return several file locations, or when previously read ranges should only be resent if their file changed.',
    when_not_to_use: 'For binary files, whole large files, or semantic symbol resolution; use Serena/CRG/AST to choose the ranges first.',
    readOnly: true,
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['requests'],
      additionalProperties: false,
      properties: {
        requests: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_READ_RANGES,
          items: {
            type: 'object',
            required: ['path'],
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              offset: { type: 'integer', minimum: 0, default: 0, description: 'Zero-based line offset.' },
              length: { type: 'integer', minimum: 1, maximum: MAX_READ_RANGE_LINES, default: 200 },
              knownHash: { type: 'string', description: 'Optional sha256:<hex>. Matching files return unchanged=true without content.' },
            },
          },
        },
        maxTotalChars: { type: 'integer', minimum: 1, maximum: MAX_READ_RANGES_MAX_CHARS, default: DEFAULT_READ_RANGES_MAX_CHARS },
      },
    },
    recommended_workflow: [
      'Use search, ast-grep, CRG or Serena to identify exact candidate files/locations.',
      'Batch all required line ranges into one read_ranges call.',
      'Reuse returned hashes as knownHash on later calls to avoid retransmitting unchanged context.',
      'Keep maxTotalChars bounded and narrow ranges rather than reading whole files.',
    ],
    related_capabilities: ['read_file', 'read_multiple_files', 'ast_search', 'Serena symbols', 'CRG minimal context'],
  },
  {
    name: 'edit_file',
    purpose: 'Apply many exact text replacements to one file in one validated read/compute/write cycle.',
    when_to_use: 'When several surgical edits are needed in the same text file.',
    when_not_to_use: 'For binary files, AST-wide codemods, or arbitrary multi-file changes.',
    readOnly: false,
    mutating: true,
    inputSchema: {
      type: 'object',
      required: ['path', 'edits'],
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            required: ['oldText', 'newText'],
            additionalProperties: false,
            properties: {
              oldText: { type: 'string', minLength: 1 },
              newText: { type: 'string' },
              expectedReplacements: { type: 'integer', minimum: 0, maximum: 10000, default: 1 },
            },
          },
        },
        dryRun: { type: 'boolean', default: true },
        expectedHash: { type: 'string', description: 'Optional sha256:<hex> compare-and-swap fence.' },
      },
    },
    recommended_workflow: [
      'Read the current file or semantic target first.',
      'Use dryRun=true when the replacement set is non-trivial.',
      'Apply with the beforeHash as expectedHash when racing writers are possible.',
      'Read back or run focused verification.',
    ],
    related_capabilities: ['edit_block', 'apply_patch', 'Serena symbol edits'],
  },
  {
    name: 'apply_patch',
    purpose: 'Validate and apply one bounded git-style multi-file text patch without staging or committing.',
    when_to_use: 'For arbitrary related changes across multiple existing text files where one round-trip is preferable.',
    when_not_to_use: 'For binary/new/delete/rename/copy/mode patches; v1 intentionally rejects those for stability.',
    readOnly: false,
    mutating: true,
    inputSchema: {
      type: 'object',
      required: ['root', 'patch', 'expectedFiles'],
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: 'Path inside the target Git repository.' },
        patch: { type: 'string', description: 'Unified git-style patch.' },
        expectedFiles: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PATCH_FILES,
          items: { type: 'string' },
          description: 'Exact repository-relative set the patch is allowed to modify.',
        },
        expectedHashes: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional repository-relative path -> sha256:<hex> fences.',
        },
        dryRun: { type: 'boolean', default: true },
      },
    },
    recommended_workflow: [
      'Call workspace_snapshot first.',
      'Inspect every target file/diff and preserve unrelated dirty state.',
      'Use dryRun=true; verify the exact file set.',
      'Apply with expectedHashes for stronger race fencing.',
      'Run focused tests and git diff --check afterwards.',
    ],
    related_capabilities: ['workspace_snapshot', 'edit_file', 'git apply --check'],
  },
  {
    name: 'wait_process',
    purpose: 'Wait internally for a finite Desktop Commander terminal session and return completion plus a bounded output tail.',
    when_to_use: 'After start_process for builds/tests that should finish, instead of repeated read_process_output polling.',
    when_not_to_use: 'For REPLs, servers, watchers, or intentionally long-lived processes.',
    readOnly: true,
    mutating: false,
    inputSchema: {
      type: 'object',
      required: ['pid'],
      additionalProperties: false,
      properties: {
        pid: { type: 'integer' },
        timeout_ms: { type: 'integer', minimum: 0, maximum: PROCESS_WAIT_MAX_MS, default: PROCESS_WAIT_DEFAULT_MS },
        stall_timeout_ms: { type: 'integer', minimum: 0, maximum: PROCESS_WAIT_MAX_MS, default: PROCESS_STALL_DEFAULT_MS, description: 'Return stalled=true after this long without stdout/stderr; 0 disables stall detection.' },
        tail_lines: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
      },
    },
    recommended_workflow: [
      'Start the finite command once.',
      'If start_process reports it still running, call wait_process in a bounded window.',
      'If stalled=true, inspect the process/tail before deciding whether to keep waiting or terminate; stall detection never kills the process.',
      'Treat processSucceeded/exitCode as verification, not transport success alone.',
    ],
    related_capabilities: ['start_process', 'read_process_output'],
  },
];

function withPreferredFrozenSurface<T extends Pick<BuiltinAcceleratorTool, 'readOnly' | 'mutating'>>(tool: T) {
  return {
    ...tool,
    preferredFrozenSurface: tool.readOnly && !tool.mutating ? 'read_file' as const : 'write_file' as const,
  };
}

export function listBuiltinAcceleratorTools(tool?: string) {
  if (!tool) {
    return tools.map(({ inputSchema, ...metadata }) => withPreferredFrozenSurface(metadata));
  }
  const selected = tools.find((candidate) => candidate.name === tool);
  if (!selected) throw new Error(`Unknown ${BUILTIN_SERVER_ID} tool '${tool}'.`);
  return withPreferredFrozenSurface(selected);
}

export async function callBuiltinAcceleratorTool(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
) {
  const isProcessExecutionTool = tool === 'wait_process' || tool === 'cpp_build_execute' || tool === 'cpp_build_result';
  const requestedExecutionTimeout = tool === 'cpp_build_result'
    ? (typeof args.waitMs === 'number' ? args.waitMs : 0)
    : (typeof args.timeoutMs === 'number' ? args.timeoutMs : PROCESS_WAIT_DEFAULT_MS);
  const effectiveTimeoutMs = timeoutMs ?? (
    tool === 'cpp_build_execute' ? Math.min(PROCESS_TRANSPORT_TIMEOUT_MAX_MS, requestedExecutionTimeout + PROCESS_TRANSPORT_RESERVE_MS)
      : tool === 'cpp_build_result' ? Math.min(PROCESS_TRANSPORT_TIMEOUT_MAX_MS, requestedExecutionTimeout + PROCESS_TRANSPORT_RESERVE_MS)
        : tool === 'wait_process' ? PROCESS_WAIT_DEFAULT_MS + PROCESS_TRANSPORT_RESERVE_MS
        : tool === 'ast_rewrite' ? BUILTIN_OPERATION_TIMEOUT_MAX_MS
          : 30_000
  );
  const deadlineAt = createDeadline(
    effectiveTimeoutMs,
    isProcessExecutionTool ? PROCESS_TRANSPORT_TIMEOUT_MAX_MS : BUILTIN_OPERATION_TIMEOUT_MAX_MS,
  );
  switch (tool) {
    case 'workspace_snapshot':
      return workspaceSnapshot(args, deadlineAt);
    case 'workspace_delta':
      return workspaceDelta(args, deadlineAt);
    case 'context_pack':
      return contextPack(args, deadlineAt);
    case 'build_metadata':
      return callBuildMetadataAcceleratorTool(args, remainingTimeout(deadlineAt, BUILTIN_OPERATION_TIMEOUT_MAX_MS));
    case 'cpp_build_context':
      return callCppBuildContextAcceleratorTool(args, remainingTimeout(deadlineAt, BUILTIN_OPERATION_TIMEOUT_MAX_MS));
    case 'cpp_build_execute':
      return executeCppBuildEntry(args, deadlineAt);
    case 'cpp_build_result':
      return readCppBuildResult(args, deadlineAt);
    case 'cpp_build_plan':
      return callCppBuildPlanAcceleratorTool(args, remainingTimeout(deadlineAt, BUILTIN_OPERATION_TIMEOUT_MAX_MS));
    case 'cpp_build_impact':
      return callCppBuildImpactAcceleratorTool(args, remainingTimeout(deadlineAt, BUILTIN_OPERATION_TIMEOUT_MAX_MS));
    case 'cpp_toolchain_profile':
      return callCppToolchainProfileAcceleratorTool(args, remainingTimeout(deadlineAt, BUILTIN_OPERATION_TIMEOUT_MAX_MS));
    case 'safe_fix':
      return callSafeFixAcceleratorTool(args, remainingTimeout(deadlineAt, BUILTIN_OPERATION_TIMEOUT_MAX_MS));
    case 'read_ranges':
      return readRanges(args, deadlineAt);
    case 'edit_file':
      return editFile(args, deadlineAt);
    case 'apply_patch':
      return applyPatch(args, deadlineAt);
    case 'ast_search':
    case 'ast_rule_search': {
      const remaining = remainingTimeout(deadlineAt, BUILTIN_OPERATION_TIMEOUT_MAX_MS);
      if (remaining < 100) throw new Error('ast-grep accelerator deadline exhausted before launch.');
      const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : remaining;
      return callAstGrepAcceleratorTool(tool, { ...args, timeout_ms: Math.min(requested, remaining) });
    }
    case 'ast_rewrite': {
      const remaining = remainingTimeout(deadlineAt, BUILTIN_OPERATION_TIMEOUT_MAX_MS);
      if (remaining < 100) throw new Error('ast rewrite deadline exhausted before preview generation.');
      const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : remaining;
      const prepared = await prepareAstGrepRewrite(
        { ...args, timeout_ms: Math.min(requested, remaining) },
        Math.min(requested, remaining),
      );
      if (args.dry_run !== false) return prepared.publicResult;

      const expectedPreviewId = typeof args.expected_preview_id === 'string' ? args.expected_preview_id : '';
      if (!expectedPreviewId) {
        throw new Error('ast_rewrite expected_preview_id is required when dry_run=false. Preview the exact rule first.');
      }
      if (expectedPreviewId !== prepared.publicResult.previewId) {
        throw new Error('AST_REWRITE_PREVIEW_STALE: regenerated preview identity differs; inspect a fresh preview before applying.');
      }
      const previewWasTruncated = prepared.publicResult.patchTruncated === true
        || prepared.publicResult.matchDetailsTruncated === true;
      if (previewWasTruncated && args.allow_truncated_preview !== true) {
        throw new Error(
          'AST_REWRITE_TRUNCATED_PREVIEW_REQUIRES_ACK: preview omitted patch or match detail; ' +
          'inspect the bounded preview/file set and set allow_truncated_preview=true to apply intentionally.',
        );
      }
      if (!Array.isArray(args.expected_files) || args.expected_files.length < 1 || args.expected_files.length > MAX_PATCH_FILES) {
        throw new Error(`ast_rewrite expected_files must contain 1-${MAX_PATCH_FILES} paths when dry_run=false.`);
      }
      const callerExpectedFiles = sortedUnique(args.expected_files.map((raw) => {
        if (typeof raw !== 'string') throw new Error('ast_rewrite expected_files must contain only strings.');
        return normalizeRepoRelative(raw);
      }));
      if (!samePathSet(callerExpectedFiles, prepared.expectedFiles)) {
        throw new Error(
          `AST_REWRITE_FILESET_CHANGED: regenerated files [${prepared.expectedFiles.join(', ')}] do not match expected_files [${callerExpectedFiles.join(', ')}].`,
        );
      }
      if (!prepared.patch.trim()) {
        return { ...prepared.publicResult, dryRun: false, applied: false, note: 'Rewrite produced no source changes.' };
      }
      const repositoryRoot = typeof prepared.publicResult.repositoryRoot === 'string'
        ? prepared.publicResult.repositoryRoot : '';
      if (!repositoryRoot) throw new Error('AST_REWRITE_INTERNAL_ROOT_MISSING: preview did not retain its repository root.');
      const applyResult = await applyPreparedAstRewriteFiles(repositoryRoot, prepared.files, deadlineAt);
      const { patchPreview: _patchPreview, matches: _matches, ...applyPreviewMeta } = prepared.publicResult;
      return {
        ...applyPreviewMeta,
        dryRun: false,
        applied: applyResult.applied,
        apply: applyResult,
        patchPreviewOmittedOnApply: true,
        matchDetailsOmittedOnApply: true,
        note: 'Structural rewrite applied as byte-exact post-images by the Workspace mutation owner after preview/file/hash revalidation.',
      };
    }
    case 'wait_process': {
      const remaining = remainingTimeout(deadlineAt, PROCESS_WAIT_MAX_MS);
      const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : PROCESS_WAIT_DEFAULT_MS;
      return waitProcess({ ...args, timeout_ms: Math.min(requested, remaining) });
    }
    default:
      throw new Error(`Unknown ${BUILTIN_SERVER_ID} tool '${tool}'.`);
  }
}

export { BUILTIN_SERVER_ID };
