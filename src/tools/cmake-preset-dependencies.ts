import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { readFileBounded } from '../utils/bounded-file-read.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';

const MAX_OPERATION_TIMEOUT_MS = 45_000;
const MAX_PRESET_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PRESET_FILES = 32;
const MAX_PRESET_INCLUDE_DEPTH = 8;

type JsonRecord = Record<string, unknown>;

export type PresetFingerprint = {
  name: string;
  path: string;
  sha256: string;
  size: number;
  mtimeMs: number;
};

type LoadedPresetFile = {
  fingerprint: PresetFingerprint;
  canonicalPath: string;
  includes: string[];
};

function slash(value: string): string {
  return value.replace(/\\/g, '/');
}

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function remaining(deadlineAt: number, maximum = 10_000): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error('CMake preset dependency deadline exceeded.') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.min(maximum, value));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function loadPresetFile(
  root: string, requestedPath: string, deadlineAt: number, optional: boolean,
): Promise<LoadedPresetFile | null> {
  const lexical = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(root, requestedPath);
  if (!isInside(root, lexical)) throw new Error(`Preset include escapes repository root: ${requestedPath}`);
  let initial;
  try {
    initial = await runWithAbortableTimeout(
      (_signal) => fs.lstat(lexical), remaining(deadlineAt), `Stat CMake preset file ${lexical}`,
    );
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`CPP_PRESET_INCLUDE_MISSING: included preset file does not exist: ${requestedPath}`);
    }
    throw error;
  }
  if (!initial.isFile() && !initial.isSymbolicLink()) throw new Error(`Preset path is not a file: ${lexical}`);
  const canonical = await runWithAbortableTimeout(
    (_signal) => fs.realpath(lexical), remaining(deadlineAt), `Resolve CMake preset file ${lexical}`,
  );
  if (!isInside(root, canonical)) throw new Error(`Preset file resolves outside repository root: ${requestedPath}`);
  const before = await runWithAbortableTimeout(
    (_signal) => fs.stat(canonical), remaining(deadlineAt), `Stat resolved CMake preset file ${canonical}`,
  );
  if (!before.isFile()) throw new Error(`Resolved preset path is not a file: ${canonical}`);
  if (before.size > MAX_PRESET_FILE_BYTES) throw new Error(`Preset file exceeds ${MAX_PRESET_FILE_BYTES} bytes: ${canonical}`);
  const bytes = await runWithAbortableTimeout(
    (signal) => readFileBounded(canonical, MAX_PRESET_FILE_BYTES, signal, 'CMake preset file'),
    remaining(deadlineAt), `Read CMake preset file ${canonical}`,
  );
  const after = await runWithAbortableTimeout(
    (_signal) => fs.stat(canonical), remaining(deadlineAt), `Re-stat CMake preset file ${canonical}`,
  );
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) {
    throw new Error(`Preset file changed while dependency graph was being read: ${canonical}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    throw new Error(`Invalid CMake preset JSON ${canonical}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = recordValue(parsed);
  if (!object) throw new Error(`CMake preset root must be an object: ${canonical}`);
  const rawIncludes = object.include;
  if (rawIncludes !== undefined && (!Array.isArray(rawIncludes) || rawIncludes.some((item) => typeof item !== 'string'))) {
    throw new Error(`CMake preset include must be an array of strings: ${canonical}`);
  }
  const includes = (rawIncludes as string[] | undefined) ?? [];
  const name = slash(path.relative(root, canonical)) || path.basename(canonical);
  return {
    canonicalPath: canonical, includes,
    fingerprint: {
      name, path: slash(canonical), size: bytes.length, mtimeMs: after.mtimeMs,
      sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    },
  };
}

export async function collectCmakePresetDependencies(
  rootValue: string, timeoutMs = 5_000,
): Promise<PresetFingerprint[]> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`CMake preset dependency timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  const deadlineAt = Date.now() + timeoutMs;
  const root = path.resolve(rootValue);
  const visited = new Map<string, PresetFingerprint>();
  const visiting = new Set<string>();

  const visit = async (requestedPath: string, depth: number, optional = false): Promise<void> => {
    if (depth > MAX_PRESET_INCLUDE_DEPTH) {
      throw new Error(`CPP_PRESET_INCLUDE_DEPTH: preset include depth exceeds ${MAX_PRESET_INCLUDE_DEPTH}.`);
    }
    const loaded = await loadPresetFile(root, requestedPath, deadlineAt, optional);
    if (!loaded) return;
    const identity = process.platform === 'win32' ? loaded.canonicalPath.toLowerCase() : loaded.canonicalPath;
    if (visited.has(identity)) return;
    if (visiting.has(identity)) throw new Error(`CPP_PRESET_INCLUDE_CYCLE: preset include cycle reaches ${loaded.fingerprint.name}.`);
    if (visited.size + visiting.size >= MAX_PRESET_FILES) {
      throw new Error(`CPP_PRESET_FILE_LIMIT: preset dependency set exceeds ${MAX_PRESET_FILES} files.`);
    }
    visiting.add(identity);
    try {
      for (const rawInclude of loaded.includes) {
        if (!rawInclude || rawInclude.length > 4096 || /[\0\r\n]/.test(rawInclude)) {
          throw new Error(`CPP_PRESET_INCLUDE_INVALID: invalid include in ${loaded.fingerprint.name}.`);
        }
        if (rawInclude.includes('$')) {
          throw new Error(
            `CPP_PRESET_DYNAMIC_INCLUDE_UNSUPPORTED: ${loaded.fingerprint.name} uses a macro-expanded include '${rawInclude}'. ` +
            'Use the low-level CMake execution path for this dynamic preset layout.',
          );
        }
        const includePath = path.isAbsolute(rawInclude)
          ? path.resolve(rawInclude) : path.resolve(path.dirname(loaded.canonicalPath), rawInclude);
        if (!isInside(root, includePath)) {
          throw new Error(`CPP_PRESET_INCLUDE_OUTSIDE_ROOT: ${loaded.fingerprint.name} includes ${rawInclude} outside repository root.`);
        }
        await visit(includePath, depth + 1);
      }
    } finally {
      visiting.delete(identity);
    }
    visited.set(identity, loaded.fingerprint);
  };

  await visit(path.join(root, 'CMakePresets.json'), 0, true);
  await visit(path.join(root, 'CMakeUserPresets.json'), 0, true);
  return [...visited.values()].sort((a, b) => a.path.localeCompare(b.path));
}
