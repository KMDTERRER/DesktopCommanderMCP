import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { validatePathAuthority as validatePath } from './path-security.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { readFileBounded } from '../utils/bounded-file-read.js';

const MAX_OPERATION_TIMEOUT_MS = 45_000;
const MAX_COMPILE_DB_BYTES = 32 * 1024 * 1024;
const MAX_CMAKE_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_CMAKE_CODEMODEL_BYTES = 16 * 1024 * 1024;
const MAX_CMAKE_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CMAKE_TARGET_BYTES = 4 * 1024 * 1024;
const MAX_CMAKE_TARGET_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_CMAKE_AUX_REPLY_BYTES = 16 * 1024 * 1024;
const MAX_CMAKE_INPUTS = 10_000;
const MAX_CMAKE_GLOBS = 2_000;
const MAX_CMAKE_TOOLCHAINS = 64;
const MAX_CMAKE_TOOLCHAIN_PATHS = 512;
const MAX_COMPILE_DB_ENTRIES = 100_000;
const MAX_RETURNED_COMPILE_ENTRIES = 500;
const MAX_CMAKE_TARGETS = 500;
const MAX_DISCOVERY_DIRECTORIES = 500;
const MAX_DISCOVERY_DEPTH = 4;
const MAX_RESPONSE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_OPERATION_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_FILES = 32;
const MAX_RESPONSE_DEPTH = 8;

type JsonObject = Record<string, unknown>;

function slash(value: string): string {
  return value.replace(/\\/g, '/');
}

function remaining(deadlineAt: number, max = 10_000): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error('build_metadata operation deadline exceeded.') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.min(max, value));
}

async function readJsonBounded(
  filePath: string,
  maxBytes: number,
  deadlineAt: number,
): Promise<{ value: unknown; sha256: string; size: number; mtimeMs: number }> {
  // Build systems rewrite these files in place. Pair the bytes with stable
  // metadata and retry once rather than returning a torn snapshot or trusting a
  // pre-read size that may no longer describe the content we actually parsed.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await runWithAbortableTimeout(
      (_signal) => fs.stat(filePath),
      remaining(deadlineAt),
      `Stat build metadata ${filePath}`,
    );
    if (!before.isFile()) throw new Error(`Build metadata path is not a file: ${filePath}`);
    if (before.size > maxBytes) throw new Error(`Build metadata file exceeds ${maxBytes} bytes: ${filePath}`);
    const bytes = await runWithAbortableTimeout(
      (signal) => readFileBounded(filePath, maxBytes, signal, 'Build metadata file'),
      remaining(deadlineAt),
      `Read bounded build metadata ${filePath}`,
    );
    if (bytes.length > maxBytes) throw new Error(`Build metadata file exceeds ${maxBytes} bytes while being read: ${filePath}`);
    const after = await runWithAbortableTimeout(
      (_signal) => fs.stat(filePath),
      remaining(deadlineAt),
      `Re-stat build metadata ${filePath}`,
    );
    const stable = after.isFile() && before.size === after.size && bytes.length === after.size &&
      before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
    if (!stable) {
      if (attempt === 0) continue;
      throw new Error(`Build metadata changed while being read: ${filePath}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error(`Invalid JSON build metadata ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      value,
      sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      size: bytes.length,
      mtimeMs: after.mtimeMs,
    };
  }
  throw new Error(`Build metadata stability retry exhausted unexpectedly: ${filePath}`);
}

async function readTextBoundedStable(
  filePath: string, maxBytes: number, deadlineAt: number, label: string,
): Promise<{ text: string; sha256: string; size: number; mtimeMs: number }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await runWithAbortableTimeout(
      (_signal) => fs.stat(filePath), remaining(deadlineAt), `Stat ${label} ${filePath}`,
    );
    if (!before.isFile()) throw new Error(`${label} path is not a file: ${filePath}`);
    if (before.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${filePath}`);
    const bytes = await runWithAbortableTimeout(
      (signal) => readFileBounded(filePath, maxBytes, signal, label),
      remaining(deadlineAt), `Read bounded ${label} ${filePath}`,
    );
    const after = await runWithAbortableTimeout(
      (_signal) => fs.stat(filePath), remaining(deadlineAt), `Re-stat ${label} ${filePath}`,
    );
    const stable = after.isFile() && before.size === after.size && bytes.length === after.size &&
      before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
    if (!stable) {
      if (attempt === 0) continue;
      throw new Error(`${label} changed while being read: ${filePath}`);
    }
    return {
      text: bytes.toString('utf8'),
      sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      size: bytes.length,
      mtimeMs: after.mtimeMs,
    };
  }
  throw new Error(`${label} stability retry exhausted unexpectedly: ${filePath}`);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeRepoFile(root: string, value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${label} must contain non-empty single-line repository-relative paths.`);
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`${label} must contain repository-relative paths.`);
  }
  const absolute = path.resolve(root, value);
  if (!isInside(root, absolute)) throw new Error(`${label} path escapes the repository root: ${value}`);
  const relative = slash(path.relative(root, absolute));
  if (!relative || relative === '.git' || relative.startsWith('.git/')) {
    throw new Error(`${label} contains an unsupported path: ${value}`);
  }
  return relative;
}

async function canonicalPathWithin(rootDir: string, candidate: string, deadlineAt: number, label: string): Promise<string> {
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    runWithAbortableTimeout(
      (_signal) => fs.realpath(rootDir, { encoding: 'utf8' }),
      remaining(deadlineAt),
      `Resolve ${label} root ${rootDir}`,
    ),
    runWithAbortableTimeout(
      (_signal) => fs.realpath(candidate, { encoding: 'utf8' }),
      remaining(deadlineAt),
      `Resolve ${label} path ${candidate}`,
    ),
  ]);
  if (!isInside(canonicalRoot, canonicalTarget)) {
    throw new Error(`${label} resolves outside its authorized root: ${candidate}`);
  }
  return canonicalTarget;
}

async function safeReplyPath(replyDir: string, jsonFile: unknown, deadlineAt: number): Promise<string> {
  if (typeof jsonFile !== 'string' || !jsonFile.trim()) throw new Error('CMake reply reference has no jsonFile.');
  const lexical = path.resolve(replyDir, jsonFile);
  if (!isInside(replyDir, lexical)) throw new Error(`CMake reply reference escapes reply directory: ${jsonFile}`);
  return canonicalPathWithin(replyDir, lexical, deadlineAt, 'CMake reply reference');
}

async function isFileWithin(rootDir: string, filePath: string, deadlineAt: number): Promise<boolean> {
  try {
    const canonical = await canonicalPathWithin(rootDir, filePath, deadlineAt, 'Build metadata candidate');
    const stats = await runWithAbortableTimeout(
      (_signal) => fs.stat(canonical),
      remaining(deadlineAt),
      `Stat build metadata candidate ${canonical}`,
    );
    return stats.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

async function hasCmakeReply(buildDir: string, deadlineAt: number): Promise<boolean> {
  const lexicalReplyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
  try {
    const replyDir = await canonicalPathWithin(buildDir, lexicalReplyDir, deadlineAt, 'CMake reply directory');
    const names = await runWithAbortableTimeout(
      (_signal) => fs.readdir(replyDir),
      remaining(deadlineAt),
      `Read CMake reply directory ${replyDir}`,
    );
    return names.some((name) => /^(?:index|error)-.*\.json$/.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

function buildDirNameScore(dir: string): number {
  const name = path.basename(dir).toLowerCase();
  if (name === 'build') return 40;
  if (name.startsWith('build-') || name.startsWith('cmake-build-')) return 35;
  if (name === 'out') return 15;
  return 0;
}

type BuildTreeFileStamp = { path: string; size: number; mtimeMs: number; ctimeMs: number };
type BuildDirCandidate = {
  dir: string;
  score: number;
  compileDatabase: BuildTreeFileStamp | null;
  cmakeCache: BuildTreeFileStamp | null;
  hasCmakeReply: boolean;
};

async function optionalFileStampWithin(
  rootDir: string, filePath: string, deadlineAt: number, label: string,
): Promise<BuildTreeFileStamp | null> {
  try {
    const canonical = await canonicalPathWithin(rootDir, filePath, deadlineAt, label);
    const stats = await runWithAbortableTimeout(
      (_signal) => fs.stat(canonical), remaining(deadlineAt), `Stat ${label} ${canonical}`,
    );
    if (!stats.isFile()) return null;
    return { path: slash(canonical), size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

async function collectBuildDirCandidates(root: string, deadlineAt: number) {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const candidates: BuildDirCandidate[] = [];
  let searchedDirectories = 0;
  const skipped = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
  while (queue.length > 0 && searchedDirectories < MAX_DISCOVERY_DIRECTORIES) {
    remaining(deadlineAt);
    const current = queue.shift()!;
    searchedDirectories += 1;
    const [compileDatabase, hasReply, cmakeCache] = await Promise.all([
      optionalFileStampWithin(current.dir, path.join(current.dir, 'compile_commands.json'), deadlineAt, 'compile database candidate'),
      hasCmakeReply(current.dir, deadlineAt),
      optionalFileStampWithin(current.dir, path.join(current.dir, 'CMakeCache.txt'), deadlineAt, 'CMake cache candidate'),
    ]);
    if (compileDatabase || hasReply || cmakeCache) {
      candidates.push({
        dir: current.dir, compileDatabase, cmakeCache, hasCmakeReply: hasReply,
        score: (compileDatabase ? 100 : 0) + (cmakeCache ? 80 : 0) + (hasReply ? 60 : 0)
          + buildDirNameScore(current.dir) - current.depth,
      });
    }
    if (current.depth >= MAX_DISCOVERY_DEPTH) continue;
    let entries;
    try {
      entries = await runWithAbortableTimeout(
        (_signal) => fs.readdir(current.dir, { withFileTypes: true }),
        remaining(deadlineAt),
        `Enumerate build metadata candidates in ${current.dir}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT') throw error;
      continue;
    }
    const dirs = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !skipped.has(entry.name));
    dirs.sort((a, b) => buildDirNameScore(path.join(current.dir, b.name)) - buildDirNameScore(path.join(current.dir, a.name)) || a.name.localeCompare(b.name));
    for (const entry of dirs) queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
  }
  candidates.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir));
  return { candidates, searchedDirectories };
}

function cmakeCacheValue(text: string, key: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith('#') || rawLine.startsWith('//')) continue;
    const equals = rawLine.indexOf('=');
    const colon = rawLine.indexOf(':');
    if (equals <= 0 || colon <= 0 || colon > equals || rawLine.slice(0, colon) !== key) continue;
    return rawLine.slice(equals + 1);
  }
  return null;
}

async function configuredTreeSourceRoot(candidate: BuildDirCandidate, deadlineAt: number): Promise<string> {
  if (!candidate.cmakeCache) throw new Error('Configured-tree source validation requires CMakeCache.txt.');
  const loaded = await readTextBoundedStable(
    candidate.cmakeCache.path, MAX_CMAKE_CACHE_BYTES, deadlineAt, 'CMake cache source identity',
  );
  const source = cmakeCacheValue(loaded.text, 'CMAKE_HOME_DIRECTORY');
  if (!source || !path.isAbsolute(source)) {
    throw new Error(`CPP_CMAKE_CACHE_SOURCE_UNVERIFIED: CMAKE_HOME_DIRECTORY is missing or non-absolute in ${candidate.cmakeCache.path}.`);
  }
  return validatePath(source, Math.min(10_000, remaining(deadlineAt)));
}

async function projectOwnedCmakeSourceRoot(
  canonicalRoot: string, candidate: BuildDirCandidate, deadlineAt: number,
): Promise<string | null> {
  try {
    const sourceRoot = await configuredTreeSourceRoot(candidate, deadlineAt);
    return isInside(canonicalRoot, sourceRoot) ? sourceRoot : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT') throw error;
    // A malformed/stale CMake cache is never allowed to become authoritative
    // metadata merely because its directory name or compile database scored well.
    return null;
  }
}

async function discoverBuildDir(root: string, requested: unknown, deadlineAt: number) {
  if (requested !== undefined) {
    if (typeof requested !== 'string' || !requested.trim()) throw new Error('build_metadata.buildDir must be a non-empty path.');
    const resolved = path.isAbsolute(requested) ? requested : path.resolve(root, requested);
    const buildDir = await validatePath(resolved, remaining(deadlineAt));
    const stats = await runWithAbortableTimeout(
      (_signal) => fs.stat(buildDir),
      remaining(deadlineAt),
      `Stat build_metadata.buildDir ${buildDir}`,
    );
    if (!stats.isDirectory()) throw new Error(`build_metadata.buildDir must be a directory: ${requested}`);
    return { buildDir, discovered: false, searchedDirectories: 1 };
  }
  const canonicalRoot = await runWithAbortableTimeout(
    (_signal) => fs.realpath(root), remaining(deadlineAt), `Resolve build_metadata project root ${root}`,
  );
  const { candidates, searchedDirectories } = await collectBuildDirCandidates(root, deadlineAt);
  let compileDatabaseFallback: BuildDirCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.cmakeCache) {
      if (await projectOwnedCmakeSourceRoot(canonicalRoot, candidate, deadlineAt)) {
        return { buildDir: candidate.dir, discovered: true, searchedDirectories };
      }
      continue;
    }
    // A File API reply without its CMakeCache is a stale/unverifiable CMake tree.
    if (candidate.hasCmakeReply) continue;
    if (candidate.compileDatabase && !compileDatabaseFallback) compileDatabaseFallback = candidate;
  }
  return {
    buildDir: compileDatabaseFallback?.dir ?? root,
    discovered: Boolean(compileDatabaseFallback),
    searchedDirectories,
  };
}

export async function discoverConfiguredCmakeTrees(rootValue: string, timeoutMs = 10_000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`Configured CMake tree discovery timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  if (!rootValue) throw new Error('Configured CMake tree discovery root is required.');
  const deadlineAt = Date.now() + timeoutMs;
  const root = await validatePath(rootValue, remaining(deadlineAt));
  const canonicalRoot = await runWithAbortableTimeout(
    (_signal) => fs.realpath(root), remaining(deadlineAt), `Resolve configured-tree project root ${root}`,
  );
  const { candidates, searchedDirectories } = await collectBuildDirCandidates(root, deadlineAt);
  const trees = [];
  for (const candidate of candidates) {
    if (!candidate.cmakeCache) continue;
    const sourceRoot = await projectOwnedCmakeSourceRoot(canonicalRoot, candidate, deadlineAt);
    if (!sourceRoot) continue;
    trees.push({
      buildDir: slash(candidate.dir),
      sourceRoot: slash(sourceRoot),
      cachePath: candidate.cmakeCache.path,
      cacheSize: candidate.cmakeCache.size,
      cacheMtimeMs: candidate.cmakeCache.mtimeMs,
      cacheCtimeMs: candidate.cmakeCache.ctimeMs,
      score: candidate.score,
      compileDatabaseFound: Boolean(candidate.compileDatabase),
      fileApiReplyFound: candidate.hasCmakeReply,
    });
  }
  return { repositoryRoot: slash(canonicalRoot), searchedDirectories, trees };
}

const CMAKE_CACHE_KEYS = new Set([
  'CMAKE_COMMAND', 'CMAKE_CTEST_COMMAND', 'CMAKE_MAKE_PROGRAM', 'CMAKE_GENERATOR', 'CMAKE_HOME_DIRECTORY',
  'CMAKE_BUILD_TYPE', 'CMAKE_CONFIGURATION_TYPES', 'CMAKE_C_COMPILER', 'CMAKE_CXX_COMPILER', 'CMAKE_TOOLCHAIN_FILE',
  // Tool/runtime roots generated by configured CMake projects. cpp_build_plan
  // uses only these reviewed values to preserve project-owned toolchain/runtime
  // environment without guessing arbitrary shell state.
  'CMAKE_PREFIX_PATH', 'Qt6_DIR', 'WINDEPLOYQT_EXECUTABLE',
]);

async function readCmakeCache(buildDir: string, deadlineAt: number) {
  const lexical = path.join(buildDir, 'CMakeCache.txt');
  if (!(await isFileWithin(buildDir, lexical, deadlineAt))) {
    return { found: false, path: slash(lexical), values: {} as Record<string, string> };
  }
  const filePath = await canonicalPathWithin(buildDir, lexical, deadlineAt, 'CMake cache');
  const loaded = await readTextBoundedStable(filePath, MAX_CMAKE_CACHE_BYTES, deadlineAt, 'CMake cache');
  const values: Record<string, string> = {};
  for (const rawLine of loaded.text.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith('#') || rawLine.startsWith('//')) continue;
    const equals = rawLine.indexOf('=');
    const colon = rawLine.indexOf(':');
    if (equals <= 0 || colon <= 0 || colon > equals) continue;
    const key = rawLine.slice(0, colon);
    if (!CMAKE_CACHE_KEYS.has(key)) continue;
    values[key] = rawLine.slice(equals + 1);
  }
  return {
    found: true, path: slash(filePath), sha256: loaded.sha256, size: loaded.size,
    mtimeMs: loaded.mtimeMs, values,
  };
}

type SemanticFlags = {
  standards: string[];
  includes: string[];
  defines: string[];
  targets: string[];
  sysroots: string[];
};

function boundedPush(values: string[], value: string): void {
  if (value && values.length < 100 && !values.includes(value)) values.push(value);
}

function semanticFlags(argumentsList: string[]): SemanticFlags {
  const result: SemanticFlags = { standards: [], includes: [], defines: [], targets: [], sysroots: [] };
  for (let index = 0; index < argumentsList.length; index++) {
    const arg = argumentsList[index];
    const next = argumentsList[index + 1];
    if (arg.startsWith('-std=') || arg.startsWith('/std:')) boundedPush(result.standards, arg);
    else if (arg === '-I' || arg === '-isystem' || arg === '/I') { boundedPush(result.includes, next ?? ''); index += next ? 1 : 0; }
    else if (arg.startsWith('-I') && arg.length > 2) boundedPush(result.includes, arg.slice(2));
    else if (arg.startsWith('/I') && arg.length > 2) boundedPush(result.includes, arg.slice(2));
    else if (arg === '-D' || arg === '/D') { boundedPush(result.defines, next ?? ''); index += next ? 1 : 0; }
    else if (arg.startsWith('-D') && arg.length > 2) boundedPush(result.defines, arg.slice(2));
    else if (arg.startsWith('/D') && arg.length > 2) boundedPush(result.defines, arg.slice(2));
    else if (arg.startsWith('--target=')) boundedPush(result.targets, arg.slice('--target='.length));
    else if (arg === '-target') { boundedPush(result.targets, next ?? ''); index += next ? 1 : 0; }
    else if (arg.startsWith('--sysroot=')) boundedPush(result.sysroots, arg.slice('--sysroot='.length));
    else if (arg === '-isysroot') { boundedPush(result.sysroots, next ?? ''); index += next ? 1 : 0; }
  }
  return result;
}

function sourceIdentity(root: string, absolute: string): string {
  const normalized = path.resolve(absolute);
  const display = isInside(root, normalized) ? slash(path.relative(root, normalized)) : slash(normalized);
  return process.platform === 'win32' ? display.toLowerCase() : display;
}

function displaySource(root: string, directory: string, file: string): { file: string; absolute: string; identity: string } {
  const absolute = path.resolve(path.isAbsolute(file) ? file : path.resolve(directory, file));
  const display = isInside(root, absolute) ? slash(path.relative(root, absolute)) : slash(absolute);
  return { file: display, absolute: slash(absolute), identity: sourceIdentity(root, absolute) };
}

function commandWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n';
}

function tokenizeGnuResponseFile(source: string): string[] {
  const args: string[] = [];
  let token = '';
  let inToken = false;
  for (let index = 0; index < source.length; index += 1) {
    if (!inToken) {
      while (index < source.length && commandWhitespace(source[index])) index += 1;
      if (index >= source.length) break;
      inToken = true;
    }
    const char = source[index];
    if (char === '\\' && index + 1 < source.length) {
      index += 1;
      token += source[index];
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) index += 1;
        token += source[index];
        index += 1;
      }
      if (index >= source.length) break;
      continue;
    }
    if (commandWhitespace(char)) {
      args.push(token);
      token = '';
      inToken = false;
      continue;
    }
    token += char;
  }
  if (inToken) args.push(token);
  return args;
}

function tokenizeGnuCompilationCommand(source: string): string[] {
  // Match Clang JSONCompilationDatabase's GNU `command` unescaper rather
  // than shell parsing: space delimits arguments, backslash escapes outside
  // quotes and inside double quotes, while single quotes preserve backslashes.
  const args: string[] = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && source[index] === ' ') index += 1;
    if (index >= source.length) break;
    let token = '';
    while (index < source.length && source[index] !== ' ') {
      const char = source[index];
      if (char === '"' || char === "'") {
        const quote = char;
        index += 1;
        while (index < source.length && source[index] !== quote) {
          if (quote === '"' && source[index] === '\\' && index + 1 < source.length) index += 1;
          token += source[index];
          index += 1;
        }
        if (index < source.length && source[index] === quote) index += 1;
        continue;
      }
      if (char === '\\' && index + 1 < source.length) index += 1;
      token += source[index];
      index += 1;
    }
    args.push(token);
  }
  return args;
}

function tokenizeWindowsCompilationCommand(source: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && commandWhitespace(source[index])) index += 1;
    if (index >= source.length) break;
    let token = '';
    let quoted = false;
    while (index < source.length) {
      const char = source[index];
      if (!quoted && commandWhitespace(char)) break;
      if (char === '"') {
        if (quoted && source[index + 1] === '"') {
          token += '"';
          index += 2;
        } else {
          quoted = !quoted;
          index += 1;
        }
        continue;
      }
      if (char === '\\') {
        let count = 0;
        while (index < source.length && source[index] === '\\') {
          count += 1;
          index += 1;
        }
        if (source[index] === '"') {
          token += '\\'.repeat(Math.floor(count / 2));
          if (count % 2 === 1) {
            token += '"';
            index += 1;
          }
        } else {
          token += '\\'.repeat(count);
        }
        continue;
      }
      token += char;
      index += 1;
    }
    args.push(token);
    while (index < source.length && commandWhitespace(source[index])) index += 1;
  }
  return args;
}

function tokenizeCompilationCommand(source: string): string[] {
  return process.platform === 'win32'
    ? tokenizeWindowsCompilationCommand(source)
    : tokenizeGnuCompilationCommand(source);
}

function tokenizeResponseFile(source: string): string[] {
  return process.platform === 'win32'
    ? tokenizeWindowsCompilationCommand(source)
    : tokenizeGnuResponseFile(source);
}

function unwrapCompilerArguments(rawArguments: string[]): string[] {
  const args = [...rawArguments];
  while (args.length >= 2) {
    const wrapper = path.basename(args[0]).replace(/\.exe$/i, '').toLowerCase();
    if (!['ccache', 'distcc', 'sccache'].includes(wrapper)) break;
    const possibleCompiler = path.basename(args[1]).replace(/\.exe$/i, '');
    const hasCompiler = !args[1].startsWith('-') && path.extname(possibleCompiler) === '';
    if (!hasCompiler) break;
    args.shift();
  }
  return args;
}

function decodeResponseFile(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2));
    for (let index = 0; index + 1 < body.length; index += 2) {
      const first = body[index]; body[index] = body[index + 1]; body[index + 1] = first;
    }
    return body.toString('utf16le');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  return bytes.toString('utf8');
}

type ResponseExpansion = {
  arguments: string[];
  expandedFiles: string[];
  unresolvedFiles: string[];
  bytesRead: number;
};

async function expandResponseArguments(
  rawArguments: string[],
  workingDir: string,
  authorizedRoots: string[],
  deadlineAt: number,
  operationBudget: { remaining: number },
): Promise<ResponseExpansion> {
  const expandedFiles: string[] = [];
  const unresolvedFiles: string[] = [];
  const active = new Set<string>();
  let bytesRead = 0;
  let filesRead = 0;

  const expand = async (argumentsList: string[], currentDir: string, depth: number): Promise<string[]> => {
    const output: string[] = [];
    for (const argument of argumentsList) {
      if (!argument.startsWith('@') || argument.length === 1) { output.push(argument); continue; }
      if (depth >= MAX_RESPONSE_DEPTH || filesRead >= MAX_RESPONSE_FILES) {
        unresolvedFiles.push(argument.slice(1)); output.push(argument); continue;
      }
      const requested = argument.slice(1);
      const lexical = path.resolve(path.isAbsolute(requested) ? requested : path.join(currentDir, requested));
      let responsePath: string;
      try {
        responsePath = await validatePath(lexical, remaining(deadlineAt));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT') throw error;
        unresolvedFiles.push(slash(lexical)); output.push(argument); continue;
      }
      if (!authorizedRoots.some((root) => isInside(root, responsePath))) {
        unresolvedFiles.push(slash(responsePath));
        output.push(argument);
        continue;
      }
      const identity = process.platform === 'win32' ? responsePath.toLowerCase() : responsePath;
      if (active.has(identity)) { unresolvedFiles.push(slash(responsePath)); output.push(argument); continue; }
      try {
        const before = await runWithAbortableTimeout((_signal) => fs.stat(responsePath), remaining(deadlineAt), `Stat response file ${responsePath}`);
        if (!before.isFile() || before.size > MAX_RESPONSE_FILE_BYTES || bytesRead + before.size > MAX_RESPONSE_TOTAL_BYTES ||
            before.size > operationBudget.remaining) {
          unresolvedFiles.push(slash(responsePath)); output.push(argument); continue;
        }
        const responseReadLimit = Math.min(
          MAX_RESPONSE_FILE_BYTES,
          MAX_RESPONSE_TOTAL_BYTES - bytesRead,
          operationBudget.remaining,
        );
        const bytes = await runWithAbortableTimeout(
          (signal) => readFileBounded(responsePath, responseReadLimit, signal, 'Response file'),
          remaining(deadlineAt),
          `Read bounded response file ${responsePath}`,
        );
        const after = await runWithAbortableTimeout((_signal) => fs.stat(responsePath), remaining(deadlineAt), `Re-stat response file ${responsePath}`);
        if (!after.isFile() || bytes.length > MAX_RESPONSE_FILE_BYTES || bytesRead + bytes.length > MAX_RESPONSE_TOTAL_BYTES ||
            before.size !== after.size || bytes.length !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          unresolvedFiles.push(slash(responsePath)); output.push(argument); continue;
        }
        bytesRead += bytes.length; operationBudget.remaining -= bytes.length; filesRead += 1; expandedFiles.push(slash(responsePath)); active.add(identity);
        try {
          const parsed = tokenizeResponseFile(decodeResponseFile(bytes));
          output.push(...await expand(parsed, path.dirname(responsePath), depth + 1));
        } finally { active.delete(identity); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT') throw error;
        unresolvedFiles.push(slash(responsePath));
        output.push(argument);
      }
    }
    return output;
  };

  return { arguments: await expand(rawArguments, workingDir, 0), expandedFiles, unresolvedFiles, bytesRead };
}

function compileEntry(entry: unknown, index: number, root: string, includeArguments: boolean) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`compile_commands entry ${index} must be an object.`);
  const value = entry as JsonObject;
  if (typeof value.directory !== 'string' || typeof value.file !== 'string') {
    throw new Error(`compile_commands entry ${index} requires string directory and file fields.`);
  }
  const explicitArguments = Array.isArray(value.arguments) && value.arguments.every((arg) => typeof arg === 'string')
    ? value.arguments as string[]
    : undefined;
  const command = typeof value.command === 'string' ? value.command : undefined;
  if (!explicitArguments && command === undefined) throw new Error(`compile_commands entry ${index} requires arguments or command.`);
  const argumentsList = explicitArguments ?? tokenizeCompilationCommand(command ?? '');
  if (argumentsList.length === 0 || !argumentsList[0]) {
    throw new Error(`compile_commands entry ${index} produced an empty command line.`);
  }
  const effectiveArguments = unwrapCompilerArguments(argumentsList);
  if (effectiveArguments.length === 0 || !effectiveArguments[0]) {
    throw new Error(`compile_commands entry ${index} has no effective compiler executable.`);
  }
  // Clang defines `directory` as the compile working directory. CMake emits an
  // absolute value, but some producers use a project-relative one. Resolve that
  // case against the repository root explicitly instead of process.cwd(), whose
  // value is unrelated to the compilation database and varies by caller.
  const directoryWasRelative = !path.isAbsolute(value.directory);
  const entryDirectory = path.resolve(directoryWasRelative ? path.join(root, value.directory) : value.directory);
  const source = displaySource(root, entryDirectory, value.file);
  const wrappersRemoved = effectiveArguments.length !== argumentsList.length;
  return {
    file: source.file,
    absoluteFile: source.absolute,
    identity: source.identity,
    directory: slash(entryDirectory),
    directoryWasRelative,
    compiler: effectiveArguments[0],
    output: typeof value.output === 'string' ? value.output : null,
    semanticFlags: semanticFlags(effectiveArguments),
    _arguments: argumentsList,
    ...(includeArguments ? { arguments: argumentsList } : {}),
    ...(includeArguments && wrappersRemoved ? { effectiveArguments } : {}),
    ...(includeArguments && command !== undefined ? { command } : {}),
  };
}

async function readCompilationDatabase(
  root: string,
  buildDir: string,
  requestedFiles: string[],
  includeArguments: boolean,
  maxEntries: number,
  deadlineAt: number,
) {
  const lexicalFilePath = path.join(buildDir, 'compile_commands.json');
  if (!(await isFileWithin(buildDir, lexicalFilePath, deadlineAt))) return { found: false, path: slash(lexicalFilePath), totalEntries: 0, uniqueFiles: 0, matchedEntries: [] };
  const filePath = await canonicalPathWithin(buildDir, lexicalFilePath, deadlineAt, 'Compilation database');
  const loaded = await readJsonBounded(filePath, MAX_COMPILE_DB_BYTES, deadlineAt);
  if (!Array.isArray(loaded.value)) throw new Error('compile_commands.json root must be an array.');
  if (loaded.value.length > MAX_COMPILE_DB_ENTRIES) {
    throw new Error(`compile_commands.json exceeds ${MAX_COMPILE_DB_ENTRIES} entries.`);
  }
  const requested = new Set(requestedFiles.map((file) => sourceIdentity(root, path.resolve(root, file))));
  const normalized = loaded.value.map((entry, index) => compileEntry(entry, index, root, includeArguments));
  const uniqueFiles = new Set(normalized.map((entry) => entry.identity));
  const compilerCounts: Record<string, number> = {};
  const standardCounts: Record<string, number> = {};
  let relativeDirectoryEntries = 0;
  for (const entry of normalized) {
    const compiler = entry.compiler ?? '<command-string>';
    compilerCounts[compiler] = (compilerCounts[compiler] ?? 0) + 1;
    for (const standard of entry.semanticFlags.standards) {
      standardCounts[standard] = (standardCounts[standard] ?? 0) + 1;
    }
    if (entry.directoryWasRelative) relativeDirectoryEntries += 1;
  }
  const matched = normalized.filter((entry) => requested.size === 0 || requested.has(entry.identity));
  const matchedEntries: Array<Record<string, unknown>> = [];
  const responseBudget = { remaining: MAX_RESPONSE_OPERATION_BYTES };
  for (const selected of matched.slice(0, maxEntries)) {
    const expansion = selected._arguments.some((argument) => argument.startsWith('@') && argument.length > 1)
      ? await expandResponseArguments(selected._arguments, selected.directory, [root, buildDir], deadlineAt, responseBudget)
      : { arguments: selected._arguments, expandedFiles: [], unresolvedFiles: [], bytesRead: 0 };
    const effectiveArguments = unwrapCompilerArguments(expansion.arguments);
    if (effectiveArguments.length === 0 || !effectiveArguments[0]) {
      throw new Error(`compile_commands entry for ${selected.file} has no effective compiler after response expansion.`);
    }
    const { identity, _arguments, ...publicEntry } = selected;
    const entry: Record<string, unknown> = { ...publicEntry };
    entry.compiler = effectiveArguments[0];
    entry.semanticFlags = semanticFlags(effectiveArguments);
    if (includeArguments && (expansion.expandedFiles.length > 0 || expansion.unresolvedFiles.length > 0 ||
        effectiveArguments.length !== _arguments.length || effectiveArguments.some((value, index) => value !== _arguments[index]))) {
      entry.effectiveArguments = effectiveArguments;
    }
    if (expansion.expandedFiles.length > 0) {
      entry.responseFilesExpanded = expansion.expandedFiles;
      entry.responseFileBytesRead = expansion.bytesRead;
    }
    if (expansion.unresolvedFiles.length > 0) entry.responseFilesUnresolved = expansion.unresolvedFiles;
    matchedEntries.push(entry);
  }
  return {
    found: true,
    path: slash(filePath),
    sha256: loaded.sha256,
    size: loaded.size,
    mtimeMs: loaded.mtimeMs,
    totalEntries: normalized.length,
    uniqueFiles: uniqueFiles.size,
    compilerCounts,
    standardCounts,
    relativeDirectoryEntries,
    matchedEntries,
    responseFileBytesRead: MAX_RESPONSE_OPERATION_BYTES - responseBudget.remaining,
    responseFileByteLimit: MAX_RESPONSE_OPERATION_BYTES,
    truncated: matched.length > maxEntries,
  };
}

type CmakeReplyIndex = { path: string; kind: 'index' | 'error'; name: string };

async function latestCmakeIndex(replyDir: string, deadlineAt: number): Promise<CmakeReplyIndex | null> {
  try {
    const names = await runWithAbortableTimeout(
      (_signal) => fs.readdir(replyDir),
      remaining(deadlineAt),
      `Read CMake File API index directory ${replyDir}`,
    );
    // CMake 4.1+ may leave the most recent generation as error-*.json while
    // keeping an older successful index-*.json. The current reply is selected
    // by the lexicographically largest suffix with the prefix ignored.
    const candidates = names
      .filter((name) => /^(?:index|error)-.*\.json$/.test(name))
      .map((name) => ({
        name,
        kind: name.startsWith('error-') ? 'error' as const : 'index' as const,
        key: name.replace(/^(?:index|error)-/, ''),
      }))
      .sort((a, b) => {
        if (a.key !== b.key) return a.key < b.key ? -1 : 1;
        if (a.name === b.name) return 0;
        return a.name < b.name ? -1 : 1;
      });
    if (candidates.length === 0) return null;
    const selected = candidates[candidates.length - 1];
    return {
      path: await safeReplyPath(replyDir, selected.name, deadlineAt),
      kind: selected.kind,
      name: selected.name,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function cmakeObjectRef(objects: JsonObject[], kind: string, major: number): JsonObject | undefined {
  return objects.find((item) => {
    const version = objectValue(item.version);
    return item.kind === kind && version?.major === major && typeof item.jsonFile === 'string';
  });
}

function boundedStrings(value: unknown, maximum: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, maximum).map(slash)
    : [];
}

async function readCmakeAuxReply(
  replyDir: string, reference: JsonObject | undefined, deadlineAt: number,
): Promise<{ object: JsonObject; path: string; sha256: string; size: number } | null> {
  if (!reference) return null;
  const replyPath = await safeReplyPath(replyDir, reference.jsonFile, deadlineAt);
  const loaded = await readJsonBounded(replyPath, MAX_CMAKE_AUX_REPLY_BYTES, deadlineAt);
  const object = objectValue(loaded.value);
  if (!object) throw new Error(`CMake File API reply must be an object: ${replyPath}`);
  return { object, path: slash(replyPath), sha256: loaded.sha256, size: loaded.size };
}

function summarizeCmakeFilesReply(loaded: Awaited<ReturnType<typeof readCmakeAuxReply>>) {
  if (!loaded) return { found: false, inputs: [], globsDependent: [] };
  const paths = objectValue(loaded.object.paths) ?? {};
  const sourceRoot = typeof paths.source === 'string' ? path.resolve(paths.source) : null;
  const rawInputs = Array.isArray(loaded.object.inputs) ? loaded.object.inputs : [];
  const inputs = rawInputs.slice(0, MAX_CMAKE_INPUTS).map(objectValue).filter((item): item is JsonObject => item !== null).map((item) => {
    const rawPath = typeof item.path === 'string' ? item.path : '';
    const absolutePath = rawPath && sourceRoot
      ? path.resolve(sourceRoot, rawPath)
      : rawPath ? path.resolve(rawPath) : '';
    return {
      path: slash(rawPath), absolutePath: absolutePath ? slash(absolutePath) : '',
      isGenerated: item.isGenerated === true, isExternal: item.isExternal === true, isCMake: item.isCMake === true,
    };
  }).filter((item) => item.path);
  const rawGlobs = Array.isArray(loaded.object.globsDependent) ? loaded.object.globsDependent : [];
  const globsDependent = rawGlobs.slice(0, MAX_CMAKE_GLOBS).map(objectValue).filter((item): item is JsonObject => item !== null).map((item) => ({
    expression: typeof item.expression === 'string' ? item.expression : '',
    recurse: item.recurse === true, listDirectories: item.listDirectories === true, followSymlinks: item.followSymlinks === true,
    relative: typeof item.relative === 'string' ? slash(item.relative) : null,
    paths: boundedStrings(item.paths ?? item.files, MAX_CMAKE_INPUTS),
  })).filter((item) => item.expression);
  return {
    found: true, path: loaded.path, sha256: loaded.sha256, size: loaded.size,
    version: objectValue(loaded.object.version),
    paths: { source: typeof paths.source === 'string' ? slash(paths.source) : null, build: typeof paths.build === 'string' ? slash(paths.build) : null },
    inputs, inputsTruncated: rawInputs.length > MAX_CMAKE_INPUTS,
    globsDependent, globsTruncated: rawGlobs.length > MAX_CMAKE_GLOBS,
  };
}

function summarizeToolchainsReply(loaded: Awaited<ReturnType<typeof readCmakeAuxReply>>) {
  if (!loaded) return { found: false, toolchains: [] };
  const raw = Array.isArray(loaded.object.toolchains) ? loaded.object.toolchains : [];
  const toolchains = raw.slice(0, MAX_CMAKE_TOOLCHAINS).map(objectValue).filter((item): item is JsonObject => item !== null).map((item) => {
    const compiler = objectValue(item.compiler) ?? {};
    const implicit = objectValue(compiler.implicit) ?? {};
    return {
      language: typeof item.language === 'string' ? item.language : '',
      compiler: {
        path: typeof compiler.path === 'string' ? slash(compiler.path) : null,
        commandFragment: typeof compiler.commandFragment === 'string' ? compiler.commandFragment : null,
        id: typeof compiler.id === 'string' ? compiler.id : null, version: typeof compiler.version === 'string' ? compiler.version : null,
        target: typeof compiler.target === 'string' ? compiler.target : null,
        implicit: {
          includeDirectories: boundedStrings(implicit.includeDirectories, MAX_CMAKE_TOOLCHAIN_PATHS),
          linkDirectories: boundedStrings(implicit.linkDirectories, MAX_CMAKE_TOOLCHAIN_PATHS),
          linkFrameworkDirectories: boundedStrings(implicit.linkFrameworkDirectories, MAX_CMAKE_TOOLCHAIN_PATHS),
          linkLibraries: boundedStrings(implicit.linkLibraries, MAX_CMAKE_TOOLCHAIN_PATHS),
        },
      },
      sourceFileExtensions: boundedStrings(item.sourceFileExtensions, MAX_CMAKE_TOOLCHAIN_PATHS),
    };
  }).filter((item) => item.language);
  return {
    found: true, path: loaded.path, sha256: loaded.sha256, size: loaded.size,
    version: objectValue(loaded.object.version), toolchains, toolchainsTruncated: raw.length > MAX_CMAKE_TOOLCHAINS,
  };
}

function summarizeCompileGroup(value: unknown) {
  const group = objectValue(value) ?? {};
  const fragments = Array.isArray(group.compileCommandFragments)
    ? group.compileCommandFragments.map((item) => objectValue(item)?.fragment).filter((item): item is string => typeof item === 'string').slice(0, 100)
    : [];
  const defines = Array.isArray(group.defines)
    ? group.defines.map((item) => objectValue(item)?.define).filter((item): item is string => typeof item === 'string').slice(0, 100)
    : [];
  const includes = Array.isArray(group.includes)
    ? group.includes.map((item) => objectValue(item)).filter((item): item is JsonObject => item !== null).slice(0, 100).map((item) => ({
        path: typeof item.path === 'string' ? slash(item.path) : '',
        isSystem: item.isSystem === true,
      })).filter((item) => item.path)
    : [];
  return { language: typeof group.language === 'string' ? group.language : null, fragments, defines, includes };
}

async function readCmakeTarget(
  replyDir: string,
  configuration: string,
  reference: JsonObject,
  deadlineAt: number,
  targetBudget: { remaining: number },
) {
  const targetFile = await safeReplyPath(replyDir, reference.jsonFile, deadlineAt);
  const stats = await runWithAbortableTimeout(
    (_signal) => fs.stat(targetFile),
    remaining(deadlineAt),
    `Stat CMake target reply ${targetFile}`,
  );
  if (!stats.isFile()) throw new Error(`CMake target reply is not a file: ${targetFile}`);
  if (stats.size > MAX_CMAKE_TARGET_BYTES) throw new Error(`CMake target reply exceeds ${MAX_CMAKE_TARGET_BYTES} bytes: ${targetFile}`);
  if (stats.size > targetBudget.remaining) {
    const error = new Error(`CMake target aggregate byte budget exhausted before ${targetFile}`) as NodeJS.ErrnoException;
    error.code = 'ECMAKETARGETBUDGET';
    throw error;
  }
  const loaded = await readJsonBounded(targetFile, MAX_CMAKE_TARGET_BYTES, deadlineAt);
  if (loaded.size > targetBudget.remaining) {
    const error = new Error(`CMake target aggregate byte budget exhausted while reading ${targetFile}`) as NodeJS.ErrnoException;
    error.code = 'ECMAKETARGETBUDGET';
    throw error;
  }
  targetBudget.remaining -= loaded.size;
  const target = objectValue(loaded.value);
  if (!target) throw new Error(`CMake target reply must be an object: ${targetFile}`);
  const targetPaths = objectValue(target.paths);
  const sourceRecords = Array.isArray(target.sources)
    ? target.sources.map(objectValue).filter((item): item is JsonObject => item !== null).slice(0, 2000)
    : [];
  const sources = sourceRecords
    .map((item) => item.path).filter((item): item is string => typeof item === 'string').map(slash);
  const generatedSources = sourceRecords
    .filter((item) => item.isGenerated === true)
    .map((item) => item.path).filter((item): item is string => typeof item === 'string').map(slash);
  const artifacts = Array.isArray(target.artifacts)
    ? target.artifacts.map((item) => objectValue(item)?.path).filter((item): item is string => typeof item === 'string').slice(0, 100).map(slash)
    : [];
  const dependencies = Array.isArray(target.dependencies)
    ? target.dependencies.map((item) => objectValue(item)?.id).filter((item): item is string => typeof item === 'string').slice(0, 1000)
    : [];
  const compileGroups = Array.isArray(target.compileGroups)
    ? target.compileGroups.slice(0, 100).map(summarizeCompileGroup)
    : [];
  return {
    configuration,
    name: typeof target.name === 'string' ? target.name : String(reference.name ?? ''),
    id: typeof target.id === 'string' ? target.id : String(reference.id ?? ''),
    type: typeof target.type === 'string' ? target.type : null,
    isGeneratorProvided: target.isGeneratorProvided === true,
    paths: targetPaths ? {
      source: typeof targetPaths.source === 'string' ? slash(targetPaths.source) : null,
      build: typeof targetPaths.build === 'string' ? slash(targetPaths.build) : null,
    } : null,
    nameOnDisk: typeof target.nameOnDisk === 'string' ? target.nameOnDisk : null,
    sources,
    generatedSources,
    artifacts,
    dependencies,
    compileGroups,
  };
}

async function readCmakeMetadataOnce(
  buildDir: string,
  configurationFilter: string | undefined,
  maxTargets: number,
  deadlineAt: number,
) {
  const lexicalReplyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
  let replyDir: string;
  try {
    replyDir = await canonicalPathWithin(buildDir, lexicalReplyDir, deadlineAt, 'CMake reply directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { found: false, replyDir: slash(lexicalReplyDir), configurations: [], targets: [] };
    }
    throw error;
  }
  const replyIndex = await latestCmakeIndex(replyDir, deadlineAt);
  if (!replyIndex) return { found: false, replyDir: slash(replyDir), configurations: [], targets: [] };
  const indexPath = replyIndex.path;
  const indexLoaded = await readJsonBounded(indexPath, MAX_CMAKE_INDEX_BYTES, deadlineAt);
  const index = objectValue(indexLoaded.value);
  if (!index) throw new Error(`CMake File API index must be an object: ${indexPath}`);
  const objects = Array.isArray(index.objects) ? index.objects.map(objectValue).filter((item): item is JsonObject => item !== null) : [];
  const codemodelRef = cmakeObjectRef(objects, 'codemodel', 2);
  const cmakeFilesRef = cmakeObjectRef(objects, 'cmakeFiles', 1);
  const toolchainsRef = cmakeObjectRef(objects, 'toolchains', 1);
  const availableObjectKinds = objects.map((item) => {
    const version = objectValue(item.version);
    return { kind: typeof item.kind === 'string' ? item.kind : '', major: typeof version?.major === 'number' ? version.major : null };
  }).filter((item) => item.kind);
  const cmake = objectValue(index.cmake);
  const generator = objectValue(cmake?.generator);
  const base = {
    found: true,
    replyDir: slash(replyDir),
    indexPath: slash(indexPath),
    indexSha256: indexLoaded.sha256,
    indexSize: indexLoaded.size,
    indexMtimeMs: indexLoaded.mtimeMs,
    replyIndexKind: replyIndex.kind,
    generationFailed: replyIndex.kind === 'error',
    availableObjectKinds,
    generator: generator ? {
      name: typeof generator.name === 'string' ? generator.name : null,
      multiConfig: generator.multiConfig === true,
      platform: typeof generator.platform === 'string' ? generator.platform : null,
    } : null,
  };
  if (replyIndex.kind === 'error') {
    return {
      ...base, codemodel: null,
      cmakeFiles: { found: false, inputs: [], globsDependent: [] },
      toolchains: { found: false, toolchains: [] },
      configurations: [], targets: [],
    };
  }
  const [cmakeFilesLoaded, toolchainsLoaded] = await Promise.all([
    readCmakeAuxReply(replyDir, cmakeFilesRef, deadlineAt),
    readCmakeAuxReply(replyDir, toolchainsRef, deadlineAt),
  ]);
  const cmakeFiles = summarizeCmakeFilesReply(cmakeFilesLoaded);
  const toolchains = summarizeToolchainsReply(toolchainsLoaded);
  if (!codemodelRef) return { ...base, codemodel: null, cmakeFiles, toolchains, configurations: [], targets: [] };
  const codemodelPath = await safeReplyPath(replyDir, codemodelRef.jsonFile, deadlineAt);
  const codemodelLoaded = await readJsonBounded(codemodelPath, MAX_CMAKE_CODEMODEL_BYTES, deadlineAt);
  const codemodel = objectValue(codemodelLoaded.value);
  if (!codemodel) throw new Error(`CMake codemodel reply must be an object: ${codemodelPath}`);
  const version = objectValue(codemodel.version);
  const codemodelPaths = objectValue(codemodel.paths);
  const configurations = Array.isArray(codemodel.configurations)
    ? codemodel.configurations.map(objectValue).filter((item): item is JsonObject => item !== null)
    : [];
  const selected = configurations.filter((item) => !configurationFilter || item.name === configurationFilter);
  const targetReferences: Array<{ configuration: string; reference: JsonObject }> = [];
  for (const configuration of selected) {
    const name = typeof configuration.name === 'string' ? configuration.name : '';
    const refs = Array.isArray(configuration.targets)
      ? configuration.targets.map(objectValue).filter((item): item is JsonObject => item !== null)
      : [];
    for (const reference of refs) {
      if (targetReferences.length >= maxTargets) break;
      targetReferences.push({ configuration: name, reference });
    }
    if (targetReferences.length >= maxTargets) break;
  }
  const targets = [];
  const targetBudget = { remaining: MAX_CMAKE_TARGET_TOTAL_BYTES };
  let targetsByteTruncated = false;
  for (const item of targetReferences) {
    try {
      targets.push(await readCmakeTarget(replyDir, item.configuration, item.reference, deadlineAt, targetBudget));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ECMAKETARGETBUDGET') {
        targetsByteTruncated = true;
        break;
      }
      throw error;
    }
  }
  return {
    ...base,
    cmakeFiles,
    toolchains,
    codemodel: {
      path: slash(codemodelPath),
      sha256: codemodelLoaded.sha256,
      size: codemodelLoaded.size,
      mtimeMs: codemodelLoaded.mtimeMs,
      version: version ? { major: version.major ?? null, minor: version.minor ?? null } : null,
      paths: codemodelPaths ? {
        source: typeof codemodelPaths.source === 'string' ? slash(codemodelPaths.source) : null,
        build: typeof codemodelPaths.build === 'string' ? slash(codemodelPaths.build) : null,
      } : null,
    },
    configurations: configurations.map((item) => ({
      name: typeof item.name === 'string' ? item.name : '',
      targetCount: Array.isArray(item.targets) ? item.targets.length : 0,
    })),
    selectedConfigurations: selected.map((item) => typeof item.name === 'string' ? item.name : ''),
    targets,
    targetBytesRead: MAX_CMAKE_TARGET_TOTAL_BYTES - targetBudget.remaining,
    targetByteLimit: MAX_CMAKE_TARGET_TOTAL_BYTES,
    targetsByteTruncated,
    targetsTruncated: targetsByteTruncated || selected.reduce((sum, item) => sum + (Array.isArray(item.targets) ? item.targets.length : 0), 0) > maxTargets,
  };
}

async function readCmakeMetadata(
  buildDir: string,
  configurationFilter: string | undefined,
  maxTargets: number,
  deadlineAt: number,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await readCmakeMetadataOnce(buildDir, configurationFilter, maxTargets, deadlineAt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && attempt === 0) {
        remaining(deadlineAt);
        continue;
      }
      throw error;
    }
  }
  throw new Error('CMake File API retry loop exhausted unexpectedly.');
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value !== undefined && typeof value !== 'number') {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  const parsed = value === undefined ? fallback : value;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function assertBuildMetadataArguments(args: Record<string, unknown>): void {
  const allowed = new Set(['root', 'buildDir', 'files', 'configuration', 'includeArguments', 'maxEntries', 'maxTargets']);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`build_metadata received unsupported argument(s): ${unknown.join(', ')}.`);
}

export async function callBuildMetadataAcceleratorTool(
  args: Record<string, unknown>,
  timeoutMs = 30_000,
) {
  assertBuildMetadataArguments(args);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`build_metadata timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  const deadlineAt = Date.now() + timeoutMs;
  const rootValue = typeof args.root === 'string' ? args.root : '';
  if (!rootValue) throw new Error('build_metadata.root is required.');
  const root = await validatePath(rootValue, remaining(deadlineAt));
  const filesRaw = args.files === undefined ? [] : args.files;
  if (!Array.isArray(filesRaw) || filesRaw.length > 200) {
    throw new Error('build_metadata.files must be an array with at most 200 repository-relative paths.');
  }
  const files = [...new Set(filesRaw.map((value, index) => normalizeRepoFile(root, value, `build_metadata.files[${index}]`)))];
  const includeArguments = args.includeArguments === true;
  if (args.includeArguments !== undefined && typeof args.includeArguments !== 'boolean') {
    throw new Error('build_metadata.includeArguments must be boolean.');
  }
  const maxEntries = boundedInteger(args.maxEntries, 100, 1, MAX_RETURNED_COMPILE_ENTRIES, 'build_metadata.maxEntries');
  const maxTargets = boundedInteger(args.maxTargets, 100, 1, MAX_CMAKE_TARGETS, 'build_metadata.maxTargets');
  if (args.configuration !== undefined && typeof args.configuration !== 'string') {
    throw new Error('build_metadata.configuration must be a string.');
  }
  const configuration = args.configuration as string | undefined;
  if (configuration !== undefined && !configuration.trim()) throw new Error('build_metadata.configuration must be non-empty.');

  const discovered = await discoverBuildDir(root, args.buildDir, deadlineAt);
  // CMakeCache owns the source/build-tree association. Validate it before
  // reading potentially large compile-database or File API payloads from an
  // explicit tree so a foreign-but-authorized directory never becomes
  // authoritative metadata for this root even transiently.
  const cmakeCache = await readCmakeCache(discovered.buildDir, deadlineAt);
  if (cmakeCache.found) {
    const home = cmakeCache.values.CMAKE_HOME_DIRECTORY;
    if (typeof home !== 'string' || !path.isAbsolute(home)) {
      throw new Error(`BUILD_METADATA_CMAKE_SOURCE_UNVERIFIED: ${cmakeCache.path} has no absolute CMAKE_HOME_DIRECTORY.`);
    }
    const sourceRoot = await validatePath(home, Math.min(10_000, remaining(deadlineAt)));
    if (!isInside(root, sourceRoot)) {
      throw new Error(
        `BUILD_METADATA_SOURCE_MISMATCH: configured tree ${discovered.buildDir} belongs to ${sourceRoot}, not ${root}.`,
      );
    }
  }
  const [compileDatabase, cmake] = await Promise.all([
    readCompilationDatabase(root, discovered.buildDir, files, includeArguments, maxEntries, deadlineAt),
    readCmakeMetadata(discovered.buildDir, configuration, maxTargets, deadlineAt),
  ]);
  return {
    repositoryRoot: slash(root),
    buildDir: slash(discovered.buildDir),
    buildDirDiscovered: discovered.discovered,
    searchedDirectories: discovered.searchedDirectories,
    requestedFiles: files,
    compileDatabase,
    cmake,
    cmakeCache,
  };
}

export type BuildMetadataSnapshot = Awaited<ReturnType<typeof callBuildMetadataAcceleratorTool>>;
export type BuildMetadataSnapshotValidation = { current: boolean; checked: string[]; changed: string[] };

function sameFilesystemPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function validateSnapshotFile(
  value: unknown, label: string, deadlineAt: number, checked: string[], changed: string[],
): Promise<void> {
  const entry = objectValue(value);
  if (!entry || entry.found !== true) return;
  const filePath = typeof entry.path === 'string' ? entry.path : '';
  const expectedSize = typeof entry.size === 'number' ? entry.size : null;
  const expectedMtime = typeof entry.mtimeMs === 'number' ? entry.mtimeMs : null;
  checked.push(label);
  if (!filePath || expectedSize === null || expectedMtime === null) { changed.push(label); return; }
  try {
    const stats = await runWithAbortableTimeout(
      (_signal) => fs.stat(filePath), remaining(deadlineAt), `Revalidate ${label} ${filePath}`,
    );
    if (!stats.isFile() || stats.size !== expectedSize || stats.mtimeMs !== expectedMtime) changed.push(label);
  } catch { changed.push(label); }
}

export async function revalidateBuildMetadataSnapshot(
  snapshot: BuildMetadataSnapshot, timeoutMs = 5_000,
): Promise<BuildMetadataSnapshotValidation> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`Build metadata snapshot revalidation timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  const deadlineAt = Date.now() + timeoutMs;
  const checked: string[] = [];
  const changed: string[] = [];
  await Promise.all([
    validateSnapshotFile(snapshot.compileDatabase, 'compile_database', deadlineAt, checked, changed),
    validateSnapshotFile(snapshot.cmakeCache, 'cmake_cache', deadlineAt, checked, changed),
  ]);

  const cmake = objectValue(snapshot.cmake);
  if (cmake?.found === true) {
    checked.push('cmake_file_api_generation');
    try {
      const replyDir = typeof cmake.replyDir === 'string' ? cmake.replyDir : '';
      const expectedIndex = typeof cmake.indexPath === 'string' ? cmake.indexPath : '';
      const expectedKind = typeof cmake.replyIndexKind === 'string' ? cmake.replyIndexKind : '';
      const expectedSize = typeof cmake.indexSize === 'number' ? cmake.indexSize : null;
      const expectedMtime = typeof cmake.indexMtimeMs === 'number' ? cmake.indexMtimeMs : null;
      const latest = replyDir ? await latestCmakeIndex(replyDir, deadlineAt) : null;
      if (!latest || !expectedIndex || latest.kind !== expectedKind || !sameFilesystemPath(latest.path, expectedIndex)) {
        changed.push('cmake_file_api_generation');
      } else {
        const stats = await runWithAbortableTimeout(
          (_signal) => fs.stat(expectedIndex), remaining(deadlineAt), `Revalidate CMake File API index ${expectedIndex}`,
        );
        if (!stats.isFile() || expectedSize === null || expectedMtime === null ||
            stats.size !== expectedSize || stats.mtimeMs !== expectedMtime) {
          changed.push('cmake_file_api_generation');
        }
      }
    } catch { changed.push('cmake_file_api_generation'); }
  }

  const uniqueChanged = [...new Set(changed)];
  return { current: uniqueChanged.length === 0, checked: [...new Set(checked)], changed: uniqueChanged };
}

export const BUILD_METADATA_ACCELERATOR_TOOL = {
  name: 'build_metadata',
  purpose: 'Read authoritative C/C++ compilation database and existing CMake File API codemodel metadata in one bounded call.',
  when_to_use: 'Before C/C++ semantic analysis when exact compile flags, target membership, or build dependencies matter.',
  when_not_to_use: 'To configure or build the project; this capability is read-only and never creates CMake File API queries.',
  readOnly: true,
  mutating: false,
  inputSchema: {
    type: 'object',
    required: ['root'],
    additionalProperties: false,
    properties: {
      root: { type: 'string', description: 'Project/repository root.' },
      buildDir: { type: 'string', description: 'Optional build directory; otherwise bounded discovery is used.' },
      files: {
        type: 'array',
        maxItems: 200,
        items: { type: 'string' },
        description: 'Optional repository-relative translation units to filter compile commands.',
      },
      configuration: { type: 'string', description: 'Optional CMake configuration name.' },
      includeArguments: { type: 'boolean', default: false },
      maxEntries: { type: 'integer', minimum: 1, maximum: MAX_RETURNED_COMPILE_ENTRIES, default: 100 },
      maxTargets: { type: 'integer', minimum: 1, maximum: MAX_CMAKE_TARGETS, default: 100 },
    },
  },
  recommended_workflow: [
    'Prefer an explicit buildDir when the project uses an out-of-tree or nonstandard build layout.',
    'Use semanticFlags for compact compile semantics; request includeArguments only when exact argv is necessary.',
    'Use CMake target/source/dependency metadata to narrow follow-up Serena/clangd/SCIP queries instead of reparsing CMakeLists.',
  ],
  related_capabilities: [
    'compile_commands.json',
    'CMake File API codemodel v2',
    'clangd compilation database',
    'Serena/SCIP',
  ],
};
