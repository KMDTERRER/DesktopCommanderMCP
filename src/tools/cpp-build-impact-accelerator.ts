import fs from 'fs/promises';
import path from 'path';

import { callBuildMetadataAcceleratorTool, revalidateBuildMetadataSnapshot, type BuildMetadataSnapshot } from './build-metadata-accelerator.js';
import { collectCmakePresetDependencies } from './cmake-preset-dependencies.js';
import { runBoundedSubprocess } from '../utils/bounded-subprocess.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { requireConfiguredExecutable } from '../utils/configured-executable.js';

const MAX_OPERATION_TIMEOUT_MS = 45_000;
const MAX_CHANGED_FILES = 100;
const PATH_NORMALIZATION_CONCURRENCY = 8;
const MAX_METADATA_ENTRIES = 500;
const MAX_METADATA_TARGETS = 500;
const MAX_RETURNED_TARGETS = 250;
const MAX_RETURNED_TESTS = 500;
const MAX_PROBE_OUTPUT_BYTES = 32 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 15_000;

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cp', '.cpp', '.cxx', '.c++',
  '.h', '.hh', '.hpp', '.hxx', '.h++', '.inc',
  '.ixx', '.cppm', '.mpp', '.ccm',
]);
const TU_EXTENSIONS = new Set(['.c', '.cc', '.cp', '.cpp', '.cxx', '.c++', '.ixx', '.cppm', '.mpp', '.ccm']);

export function cppBuildImpactPathSupported(value: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(value).toLowerCase());
}

type JsonRecord = Record<string, unknown>;
type TargetInfo = {
  id: string;
  name: string;
  type: string | null;
  sources: string[];
  artifacts: string[];
  dependencies: string[];
};

type CompileEntry = {
  file: string;
  absoluteFile: string;
  directory: string;
  output: string | null;
};

type NinjaDepsBlock = {
  output: string;
  valid: boolean;
  dependencies: string[];
};

function slash(value: string): string {
  return value.replace(/\\/g, '/');
}

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function identity(value: string): string {
  const resolved = slash(path.resolve(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function remaining(deadlineAt: number, maximum = 10_000): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error('cpp_build_impact operation deadline exceeded.') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.min(maximum, value));
}

function positiveInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return value as number;
}

async function mapConcurrent<T, R>(
  values: T[], concurrency: number, mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}
async function normalizeChangedFile(root: string, value: unknown, deadlineAt: number, index: number): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`cpp_build_impact.changedFiles[${index}] must be a non-empty single-line path.`);
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`cpp_build_impact.changedFiles[${index}] must be repository-relative.`);
  }
  const lexical = path.resolve(root, value);
  if (!isInside(root, lexical)) throw new Error(`cpp_build_impact changed path escapes repository root: ${value}`);
  const relative = slash(path.relative(root, lexical));
  if (!relative || relative === '.git' || relative.startsWith('.git/')) {
    throw new Error(`cpp_build_impact changed path is unsupported: ${value}`);
  }
  if (!cppBuildImpactPathSupported(relative)) {
    // Non-source paths are classified against authoritative build metadata below.
  }
  try {
    const canonical = await runWithAbortableTimeout(
      (_signal) => fs.realpath(lexical), remaining(deadlineAt), `Resolve cpp_build_impact changed path ${lexical}`,
    );
    if (!isInside(root, canonical)) throw new Error(`cpp_build_impact changed path resolves outside repository: ${value}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  return relative;
}
export type CppBuildChangedFileKind = 'source' | 'cmake_input' | 'preset' | 'toolchain' | 'unknown';

type ChangedFileClassification = {
  path: string;
  kind: CppBuildChangedFileKind;
  evidence: string;
};

function metadataCmakeInputIds(metadata: JsonRecord): Set<string> {
  const cmake = recordValue(metadata.cmake);
  const cmakeFiles = recordValue(cmake?.cmakeFiles);
  const inputs = Array.isArray(cmakeFiles?.inputs) ? cmakeFiles!.inputs : [];
  const result = new Set<string>();
  for (const raw of inputs) {
    const item = recordValue(raw);
    if (typeof item?.absolutePath === 'string' && item.absolutePath) result.add(identity(item.absolutePath));
  }
  return result;
}

async function classifyChangedFiles(
  changedFiles: string[], metadata: JsonRecord, repositoryRoot: string, buildDir: string, deadlineAt: number,
): Promise<{ classifications: ChangedFileClassification[]; warnings: string[] }> {
  const cmakeInputIds = metadataCmakeInputIds(metadata);
  const cmakeCache = recordValue(metadata.cmakeCache);
  const cacheValues = recordValue(cmakeCache?.values) ?? {};
  const toolchainIds = new Set<string>();
  if (typeof cacheValues.CMAKE_TOOLCHAIN_FILE === 'string' && cacheValues.CMAKE_TOOLCHAIN_FILE.trim()) {
    for (const candidate of candidateIdentities(cacheValues.CMAKE_TOOLCHAIN_FILE, repositoryRoot, buildDir)) toolchainIds.add(candidate);
  }
  const presetIds = new Set<string>();
  const warnings: string[] = [];
  try {
    const presets = await collectCmakePresetDependencies(repositoryRoot, Math.min(10_000, remaining(deadlineAt)));
    for (const preset of presets) presetIds.add(identity(preset.path));
  } catch (error) {
    warnings.push(`Preset dependency classification incomplete: ${error instanceof Error ? error.message : String(error)}`);
  }

  const classifications = changedFiles.map((relative): ChangedFileClassification => {
    const absolute = path.resolve(repositoryRoot, relative);
    const id = identity(absolute);
    const base = path.basename(relative).toLowerCase();
    const extension = path.extname(relative).toLowerCase();
    if (toolchainIds.has(id)) return { path: relative, kind: 'toolchain', evidence: 'CMAKE_TOOLCHAIN_FILE' };
    if (presetIds.has(id)) return { path: relative, kind: 'preset', evidence: 'preset dependency closure' };
    if (cmakeInputIds.has(id)) return { path: relative, kind: 'cmake_input', evidence: 'CMake File API cmakeFiles-v1' };
    if (base === 'cmakepresets.json' || base === 'cmakeuserpresets.json') {
      return { path: relative, kind: 'preset', evidence: 'preset root filename fallback' };
    }
    if (base === 'cmakelists.txt' || extension === '.cmake') {
      return { path: relative, kind: 'cmake_input', evidence: 'CMake input filename fallback' };
    }
    if (cppBuildImpactPathSupported(relative)) return { path: relative, kind: 'source', evidence: 'C/C++ source/header/module extension' };
    return { path: relative, kind: 'unknown', evidence: 'not represented by current build metadata' };
  });
  return { classifications, warnings };
}

function compileEntries(metadata: JsonRecord): CompileEntry[] {
  const compileDatabase = recordValue(metadata.compileDatabase);
  const entries = Array.isArray(compileDatabase?.matchedEntries) ? compileDatabase.matchedEntries : [];
  const result: CompileEntry[] = [];
  for (const raw of entries) {
    const entry = recordValue(raw);
    if (!entry || typeof entry.file !== 'string' || typeof entry.absoluteFile !== 'string' || typeof entry.directory !== 'string') continue;
    result.push({
      file: slash(entry.file),
      absoluteFile: slash(entry.absoluteFile),
      directory: slash(entry.directory),
      output: typeof entry.output === 'string' ? slash(entry.output) : null,
    });
  }
  return result;
}

function targetsFromMetadata(metadata: JsonRecord): TargetInfo[] {
  const cmake = recordValue(metadata.cmake);
  const rawTargets = Array.isArray(cmake?.targets) ? cmake.targets : [];
  const targets: TargetInfo[] = [];
  for (const raw of rawTargets) {
    const target = recordValue(raw);
    if (!target || typeof target.id !== 'string' || typeof target.name !== 'string') continue;
    targets.push({
      id: target.id,
      name: target.name,
      type: typeof target.type === 'string' ? target.type : null,
      sources: Array.isArray(target.sources) ? target.sources.filter((item): item is string => typeof item === 'string') : [],
      artifacts: Array.isArray(target.artifacts) ? target.artifacts.filter((item): item is string => typeof item === 'string') : [],
      dependencies: Array.isArray(target.dependencies) ? target.dependencies.filter((item): item is string => typeof item === 'string') : [],
    });
  }
  return targets;
}
async function trustedProbeExecutable(
  value: unknown,
  expectedName: 'ninja' | 'ctest',
  repositoryRoot: string,
  buildDir: string,
  deadlineAt: number,
): Promise<string> {
  return requireConfiguredExecutable(value, {
    repositoryRoot, buildDir, deadlineAt,
    label: `Configured ${expectedName} executable`, expectedNames: [expectedName],
  });
}

function parseNinjaDeps(stdout: string): NinjaDepsBlock[] {
  const blocks: NinjaDepsBlock[] = [];
  let current: NinjaDepsBlock | undefined;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const header = rawLine.match(/^(.+): #deps \d+.*\((VALID|STALE)\)\s*$/);
    if (header) {
      current = {
        output: header[1].trim(),
        valid: header[2] === 'VALID',
        dependencies: [],
      };
      blocks.push(current);
      continue;
    }
    if (current && /^\s+\S/.test(rawLine)) current.dependencies.push(rawLine.trim());
  }
  return blocks;
}

function candidateIdentities(value: string, repositoryRoot: string, buildDir: string): Set<string> {
  const result = new Set<string>();
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    result.add(identity(value));
  } else {
    result.add(identity(path.resolve(buildDir, value)));
    result.add(identity(path.resolve(repositoryRoot, value)));
  }
  return result;
}

function compileOutputIdentities(entry: CompileEntry): Set<string> {
  if (!entry.output) return new Set();
  if (path.isAbsolute(entry.output) || /^[A-Za-z]:[\\/]/.test(entry.output)) return new Set([identity(entry.output)]);
  return new Set([identity(path.resolve(entry.directory, entry.output))]);
}
async function ninjaAffectedTranslationUnits(
  cacheValues: JsonRecord,
  repositoryRoot: string,
  buildDir: string,
  changedIdentities: Set<string>,
  entries: CompileEntry[],
  deadlineAt: number,
): Promise<{ files: Set<string>; matchedChangedIds: Set<string>; available: boolean; staleBlocks: number; blockCount: number; warning?: string }> {
  const generator = typeof cacheValues.CMAKE_GENERATOR === 'string' ? cacheValues.CMAKE_GENERATOR : '';
  if (!generator.startsWith('Ninja')) {
    return { files: new Set(), matchedChangedIds: new Set(), available: false, staleBlocks: 0, blockCount: 0, warning: `Generator '${generator || '<unknown>'}' has no Ninja deps fast path.` };
  }
  let ninja: string;
  try {
    ninja = await trustedProbeExecutable(cacheValues.CMAKE_MAKE_PROGRAM, 'ninja', repositoryRoot, buildDir, deadlineAt);
  } catch (error) {
    return { files: new Set(), matchedChangedIds: new Set(), available: false, staleBlocks: 0, blockCount: 0, warning: error instanceof Error ? error.message : String(error) };
  }
  const result = await runBoundedSubprocess(ninja, ['-t', 'deps'], {
    cwd: buildDir,
    timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining(deadlineAt, PROBE_TIMEOUT_MS)),
    maxOutputBytes: MAX_PROBE_OUTPUT_BYTES,
    label: 'Ninja dependency probe',
  });
  if (result.exitCode !== 0) {
    return { files: new Set(), matchedChangedIds: new Set(), available: false, staleBlocks: 0, blockCount: 0, warning: `ninja -t deps exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 1000)}` };
  }
  const blocks = parseNinjaDeps(result.stdout);
  const affected = new Set<string>();
  const matchedChangedIds = new Set<string>();
  let staleBlocks = 0;
  const byTu = new Map(entries.map((entry) => [identity(entry.absoluteFile), entry.file]));
  const byOutput = new Map<string, string>();
  for (const entry of entries) {
    for (const outputId of compileOutputIdentities(entry)) byOutput.set(outputId, entry.file);
  }
  for (const block of blocks) {
    if (!block.valid) { staleBlocks += 1; continue; }
    const dependencyIds = new Set<string>();
    for (const dependency of block.dependencies) {
      for (const depId of candidateIdentities(dependency, repositoryRoot, buildDir)) dependencyIds.add(depId);
    }
    const matchedHere = [...changedIdentities].filter((changed) => dependencyIds.has(changed));
    if (matchedHere.length === 0) continue;
    for (const changed of matchedHere) matchedChangedIds.add(changed);
    let translationUnit: string | undefined;
    for (const depId of dependencyIds) {
      const candidate = byTu.get(depId);
      if (candidate) { translationUnit = candidate; break; }
    }
    if (!translationUnit) {
      for (const outputId of candidateIdentities(block.output, repositoryRoot, buildDir)) {
        const candidate = byOutput.get(outputId);
        if (candidate) { translationUnit = candidate; break; }
      }
    }
    if (translationUnit) affected.add(translationUnit);
  }
  return { files: affected, matchedChangedIds, available: true, staleBlocks, blockCount: blocks.length };
}
function targetSourceIdentities(target: TargetInfo, repositoryRoot: string): Set<string> {
  return new Set(target.sources.map((source) => identity(path.isAbsolute(source) ? source : path.resolve(repositoryRoot, source))));
}

function targetArtifactIdentities(target: TargetInfo, buildDir: string): Set<string> {
  return new Set(target.artifacts.map((artifact) => identity(path.isAbsolute(artifact) ? artifact : path.resolve(buildDir, artifact))));
}

function expandDependentTargets(targets: TargetInfo[], initiallyAffected: Set<string>): Set<string> {
  const affected = new Set(initiallyAffected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const target of targets) {
      if (affected.has(target.id)) continue;
      if (target.dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(target.id);
        changed = true;
      }
    }
  }
  return affected;
}

function boundedNames(values: string[], maximum: number) {
  const unique = [...new Set(values)].sort();
  return { values: unique.slice(0, maximum), total: unique.length, truncated: unique.length > maximum };
}

function parseCtestInfo(stdout: string): { name: string; command: string[] }[] {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch (error) {
    throw new Error(`CTest JSON discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = recordValue(value);
  if (root?.kind !== 'ctestInfo' || !Array.isArray(root.tests)) throw new Error('CTest JSON discovery returned an unexpected object model.');
  const tests: { name: string; command: string[] }[] = [];
  for (const raw of root.tests) {
    const test = recordValue(raw);
    if (!test || typeof test.name !== 'string' || !test.name) continue;
    const command = Array.isArray(test.command) ? test.command.filter((item): item is string => typeof item === 'string') : [];
    tests.push({ name: test.name, command });
  }
  return tests;
}

async function discoverTests(
  cacheValues: JsonRecord,
  repositoryRoot: string,
  buildDir: string,
  configuration: string | undefined,
  deadlineAt: number,
): Promise<{ tests: { name: string; command: string[] }[]; available: boolean; warning?: string }> {
  let ctest: string;
  try {
    ctest = await trustedProbeExecutable(cacheValues.CMAKE_CTEST_COMMAND, 'ctest', repositoryRoot, buildDir, deadlineAt);
  } catch (error) {
    return { tests: [], available: false, warning: error instanceof Error ? error.message : String(error) };
  }
  const args = ['--show-only=json-v1', '--test-dir', buildDir];
  if (configuration) args.push('-C', configuration);
  const result = await runBoundedSubprocess(ctest, args, {
    cwd: repositoryRoot,
    timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining(deadlineAt, PROBE_TIMEOUT_MS)),
    maxOutputBytes: MAX_PROBE_OUTPUT_BYTES,
    label: 'CTest JSON discovery',
  });
  if (result.exitCode !== 0) {
    return {
      tests: [], available: false,
      warning: `ctest --show-only=json-v1 exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 1000)}`,
    };
  }
  try {
    return { tests: parseCtestInfo(result.stdout), available: true };
  } catch (error) {
    return { tests: [], available: false, warning: error instanceof Error ? error.message : String(error) };
  }
}

function testMatchesArtifacts(test: { command: string[] }, artifactIds: Set<string>, repositoryRoot: string, buildDir: string): boolean {
  for (const token of test.command) {
    if (!token || token.startsWith('-')) continue;
    for (const candidate of candidateIdentities(token, repositoryRoot, buildDir)) {
      if (artifactIds.has(candidate)) return true;
    }
  }
  return false;
}

function assertArguments(args: Record<string, unknown>): void {
  const allowed = new Set(['root', 'buildDir', 'changedFiles', 'configuration', 'includeTests', 'maxTargets', 'maxTests']);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`cpp_build_impact received unsupported argument(s): ${unknown.join(', ')}.`);
  if (!Array.isArray(args.changedFiles) || args.changedFiles.length < 1 || args.changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error(`cpp_build_impact.changedFiles must contain 1-${MAX_CHANGED_FILES} paths.`);
  }
  if (args.includeTests !== undefined && typeof args.includeTests !== 'boolean') {
    throw new Error('cpp_build_impact.includeTests must be boolean.');
  }
}

export async function callCppBuildChangeClassification(
  args: Record<string, unknown>, timeoutMs = 10_000, metadataSnapshot?: BuildMetadataSnapshot,
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`cpp build change classification timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  if (typeof args.root !== 'string' || !args.root.trim()) throw new Error('cpp build change classification root is required.');
  if (!Array.isArray(args.changedFiles) || args.changedFiles.length < 1 || args.changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error(`cpp build change classification changedFiles must contain 1-${MAX_CHANGED_FILES} paths.`);
  }
  const configuration = args.configuration === undefined ? undefined : args.configuration;
  if (configuration !== undefined && (typeof configuration !== 'string' || !configuration.trim() || /[\0\r\n]/.test(configuration))) {
    throw new Error('cpp build change classification configuration must be a non-empty single-line string.');
  }
  const deadlineAt = Date.now() + timeoutMs;
  const metadata = (metadataSnapshot ?? await callBuildMetadataAcceleratorTool({
    root: args.root, buildDir: args.buildDir, configuration, includeArguments: false, maxEntries: 1, maxTargets: 1,
  }, remaining(deadlineAt, MAX_OPERATION_TIMEOUT_MS))) as JsonRecord;
  const repositoryRoot = path.resolve(String(metadata.repositoryRoot));
  const buildDir = path.resolve(String(metadata.buildDir));
  const changedFiles = await mapConcurrent(
    args.changedFiles as unknown[], PATH_NORMALIZATION_CONCURRENCY,
    (value, index) => normalizeChangedFile(repositoryRoot, value, deadlineAt, index),
  );
  const classified = await classifyChangedFiles(changedFiles, metadata, repositoryRoot, buildDir, deadlineAt);
  const classifications = classified.classifications;
  const buildSystemChanged = classifications.filter((item) =>
    item.kind === 'cmake_input' || item.kind === 'preset' || item.kind === 'toolchain');
  const unsupportedChangedFiles = classifications.filter((item) => item.kind === 'unknown').map((item) => item.path);
  return {
    repositoryRoot: slash(repositoryRoot), buildDir: slash(buildDir), changedFiles, classifications,
    requiresConfigure: buildSystemChanged.length > 0,
    configureInvalidatedBy: buildSystemChanged.map((item) => item.path),
    unsupportedChangedFiles, warnings: classified.warnings,
  };
}

export async function callCppBuildImpactAcceleratorTool(
  args: Record<string, unknown>, timeoutMs = 30_000, metadataSnapshot?: BuildMetadataSnapshot,
) {
  assertArguments(args);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`cpp_build_impact timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  const deadlineAt = Date.now() + timeoutMs;
  const maxTargets = positiveInteger(args.maxTargets, 100, MAX_RETURNED_TARGETS, 'cpp_build_impact.maxTargets');
  const maxTests = positiveInteger(args.maxTests, 200, MAX_RETURNED_TESTS, 'cpp_build_impact.maxTests');
  const includeTests = args.includeTests !== false;
  const configuration = args.configuration === undefined ? undefined : args.configuration;
  if (configuration !== undefined && (typeof configuration !== 'string' || !configuration.trim() || /[\0\r\n]/.test(configuration))) {
    throw new Error('cpp_build_impact.configuration must be a non-empty single-line string.');
  }

  const metadata = (metadataSnapshot ?? await callBuildMetadataAcceleratorTool({
    root: args.root,
    buildDir: args.buildDir,
    configuration,
    includeArguments: false,
    maxEntries: MAX_METADATA_ENTRIES,
    maxTargets: MAX_METADATA_TARGETS,
  }, remaining(deadlineAt, MAX_OPERATION_TIMEOUT_MS))) as JsonRecord;
  const repositoryRoot = path.resolve(String(metadata.repositoryRoot));
  const buildDir = path.resolve(String(metadata.buildDir));
  const changedFiles = await mapConcurrent(
    args.changedFiles as unknown[], PATH_NORMALIZATION_CONCURRENCY,
    (value, index) => normalizeChangedFile(repositoryRoot, value, deadlineAt, index),
  );
  const classified = await classifyChangedFiles(changedFiles, metadata, repositoryRoot, buildDir, deadlineAt);
  const classifications = classified.classifications;
  const sourceChangedFiles = classifications.filter((item) => item.kind === 'source').map((item) => item.path);
  const buildSystemChanged = classifications.filter((item) =>
    item.kind === 'cmake_input' || item.kind === 'preset' || item.kind === 'toolchain');
  const unsupportedChangedFiles = classifications.filter((item) => item.kind === 'unknown').map((item) => item.path);
  const requiresConfigure = buildSystemChanged.length > 0;
  const changedIdentities = new Set(sourceChangedFiles.map((file) => identity(path.resolve(repositoryRoot, file))));
  const entries = compileEntries(metadata);
  const targets = targetsFromMetadata(metadata);
  const compileDatabase = recordValue(metadata.compileDatabase);
  const cmake = recordValue(metadata.cmake);
  const cmakeCache = recordValue(metadata.cmakeCache);
  const cacheValues = recordValue(cmakeCache?.values) ?? {};
  const warnings: string[] = [...classified.warnings];
  const incompleteness: string[] = [];
  if (requiresConfigure) incompleteness.push('build_system_input_changed');
  if (unsupportedChangedFiles.length > 0) incompleteness.push('unsupported_changed_files');

  if (compileDatabase?.truncated === true) incompleteness.push('compile_database_truncated');
  if (cmake?.targetsTruncated === true) incompleteness.push('cmake_targets_truncated');
  if (targets.length === 0) incompleteness.push('cmake_target_model_unavailable');

  const affectedTranslationUnits = new Set<string>();
  const mappedChangedFiles = new Set<string>();
  for (const entry of entries) {
    if (changedIdentities.has(identity(entry.absoluteFile))) {
      affectedTranslationUnits.add(entry.file);
      mappedChangedFiles.add(entry.file);
    }
  }
  for (const target of targets) {
    const sourceIds = targetSourceIdentities(target, repositoryRoot);
    for (const changedFile of sourceChangedFiles) {
      if (sourceIds.has(identity(path.resolve(repositoryRoot, changedFile)))) mappedChangedFiles.add(changedFile);
    }
  }

  const hasNonTuChange = sourceChangedFiles.some((file) => !TU_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const ninja = sourceChangedFiles.length > 0
    ? await ninjaAffectedTranslationUnits(cacheValues, repositoryRoot, buildDir, changedIdentities, entries, deadlineAt)
    : { files: new Set<string>(), matchedChangedIds: new Set<string>(), available: true, staleBlocks: 0, blockCount: 0, warning: undefined as string | undefined };
  for (const file of ninja.files) affectedTranslationUnits.add(file);
  for (const changedFile of sourceChangedFiles) {
    if (ninja.matchedChangedIds.has(identity(path.resolve(repositoryRoot, changedFile)))) mappedChangedFiles.add(changedFile);
  }
  if (ninja.warning) warnings.push(ninja.warning);
  if (hasNonTuChange && !ninja.available) incompleteness.push('header_dependency_graph_unavailable');
  if (ninja.staleBlocks > 0) incompleteness.push('stale_ninja_dependency_blocks');

  const affectedTuIds = new Set([...affectedTranslationUnits].map((file) => identity(path.resolve(repositoryRoot, file))));
  const initialTargetIds = new Set<string>();
  for (const target of targets) {
    const sourceIds = targetSourceIdentities(target, repositoryRoot);
    if ([...changedIdentities].some((changed) => sourceIds.has(changed)) || [...affectedTuIds].some((tu) => sourceIds.has(tu))) {
      initialTargetIds.add(target.id);
    }
  }
  const unmappedChanged = sourceChangedFiles.filter((file) => !mappedChangedFiles.has(file) && !ninja.files.has(file));
  if (unmappedChanged.length > 0) incompleteness.push('changed_files_not_mapped_to_build_graph');

  let affectedTargetIds = expandDependentTargets(targets, initialTargetIds);
  let recommendFullBuild = incompleteness.length > 0;
  if (recommendFullBuild) affectedTargetIds = new Set(targets.map((target) => target.id));
  const affectedTargetRecords = targets.filter((target) => affectedTargetIds.has(target.id));
  const targetSelection = boundedNames(affectedTargetRecords.map((target) => target.name), maxTargets);
  const testIncompleteness: string[] = [];
  let testSelection = { values: [] as string[], total: 0, truncated: false };
  let discoveredTestCount = 0;
  let recommendFullTests = false;
  if (includeTests) {
    const configurationTypes = typeof cacheValues.CMAKE_CONFIGURATION_TYPES === 'string'
      ? cacheValues.CMAKE_CONFIGURATION_TYPES.split(';').filter(Boolean)
      : [];
    if (configurationTypes.length > 0 && !configuration) {
      testIncompleteness.push('multi_config_test_configuration_required');
      warnings.push(`CTest mapping requires an explicit configuration for this multi-config tree: ${configurationTypes.join(', ')}.`);
      recommendFullTests = true;
    } else {
      const discovered = await discoverTests(
        cacheValues, repositoryRoot, buildDir, configuration as string | undefined, deadlineAt,
      );
      if (discovered.warning) warnings.push(discovered.warning);
      if (!discovered.available) {
        testIncompleteness.push('ctest_json_unavailable');
        recommendFullTests = true;
      } else {
        discoveredTestCount = discovered.tests.length;
        const artifactIds = new Set<string>();
        for (const target of affectedTargetRecords) {
          for (const artifact of targetArtifactIdentities(target, buildDir)) artifactIds.add(artifact);
        }
        let selected = discovered.tests.filter((test) => testMatchesArtifacts(test, artifactIds, repositoryRoot, buildDir));
        if (recommendFullBuild || (affectedTargetRecords.length > 0 && (artifactIds.size === 0 || selected.length === 0))) {
          selected = discovered.tests;
          recommendFullTests = true;
          testIncompleteness.push(recommendFullBuild ? 'build_selection_conservative' : 'test_target_mapping_incomplete');
        }
        testSelection = boundedNames(selected.map((test) => test.name), maxTests);
      }
    }
  }
  if (targetSelection.truncated) {
    recommendFullBuild = true;
    incompleteness.push('affected_target_output_truncated');
  }
  if (testSelection.truncated) {
    recommendFullTests = true;
    testIncompleteness.push('affected_test_output_truncated');
  }

  const snapshotValidation = metadataSnapshot
    ? null
    : await revalidateBuildMetadataSnapshot(metadata as BuildMetadataSnapshot, remaining(deadlineAt, 5_000));
  if (snapshotValidation && !snapshotValidation.current) {
    recommendFullBuild = true;
    incompleteness.push('build_metadata_changed_during_impact');
    if (includeTests) {
      recommendFullTests = true;
      testIncompleteness.push('build_metadata_changed_during_impact');
    }
    warnings.push(`Build metadata changed during impact analysis: ${snapshotValidation.changed.join(', ')}. Refresh before focused verification.`);
  }

  const cmakeCodemodel = recordValue(cmake?.codemodel);
  return {
    repositoryRoot: slash(repositoryRoot),
    buildDir: slash(buildDir),
    changedFiles,
    classifications,
    requiresConfigure,
    configureInvalidatedBy: buildSystemChanged.map((item) => item.path),
    unsupportedChangedFiles,
    affectedTranslationUnits: boundedNames([...affectedTranslationUnits], MAX_METADATA_ENTRIES),
    affectedTargets: targetSelection.values,
    affectedTargetCount: targetSelection.total,
    targetsTruncated: targetSelection.truncated,
    affectedTests: testSelection.values,
    affectedTestCount: testSelection.total,
    discoveredTestCount,
    testsTruncated: testSelection.truncated,
    recommendFullBuild,
    recommendFullTests,
    selectionComplete: !recommendFullBuild && !recommendFullTests,
    incompleteness: [...new Set(incompleteness)],
    testIncompleteness: [...new Set(testIncompleteness)],
    unmappedChangedFiles: unmappedChanged,
    warnings,
    evidence: {
      generator: typeof cacheValues.CMAKE_GENERATOR === 'string' ? cacheValues.CMAKE_GENERATOR : null,
      buildProgram: typeof cacheValues.CMAKE_MAKE_PROGRAM === 'string' ? slash(cacheValues.CMAKE_MAKE_PROGRAM) : null,
      compileDatabaseSha256: compileDatabase?.found === true && typeof compileDatabase.sha256 === 'string' ? compileDatabase.sha256 : null,
      codemodelSha256: typeof cmakeCodemodel?.sha256 === 'string' ? cmakeCodemodel.sha256 : null,
      cmakeFilesSha256: typeof recordValue(cmake?.cmakeFiles)?.sha256 === 'string' ? recordValue(cmake?.cmakeFiles)!.sha256 : null,
      buildSystemClassificationSource: 'CMake File API + preset closure + cache toolchain',
      ninjaDeps: { available: ninja.available, blockCount: ninja.blockCount, staleBlocks: ninja.staleBlocks },
      snapshotValidation,
    },
  };
}
export const CPP_BUILD_IMPACT_ACCELERATOR_TOOL = {
  name: 'cpp_build_impact',
  purpose: 'Compute a conservative C/C++ affected translation-unit, CMake target, and CTest set from existing build metadata without building or testing.',
  when_to_use: 'After workspace_delta/build_metadata when changed C/C++ files are known and focused build/test selection would avoid a broad verification run.',
  when_not_to_use: 'For semantic symbol impact, configuring a build tree, running builds/tests, or claiming minimal impact when generated dependency metadata is absent or stale.',
  readOnly: true,
  mutating: false,
  inputSchema: {
    type: 'object',
    required: ['root', 'changedFiles'],
    additionalProperties: false,
    properties: {
      root: { type: 'string', description: 'Project/repository root.' },
      buildDir: { type: 'string', description: 'Optional existing CMake build directory.' },
      changedFiles: { type: 'array', minItems: 1, maxItems: MAX_CHANGED_FILES, items: { type: 'string' } },
      configuration: { type: 'string', description: 'Optional CMake/CTest configuration for multi-config trees.' },
      includeTests: { type: 'boolean', default: true },
      maxTargets: { type: 'integer', minimum: 1, maximum: MAX_RETURNED_TARGETS, default: 100 },
      maxTests: { type: 'integer', minimum: 1, maximum: MAX_RETURNED_TESTS, default: 200 },
    },
  },
  recommended_workflow: [
    'Pass the exact changed C/C++ files from workspace_delta; do not broaden discovery first.',
    'Use affectedTargets/affectedTests only when the corresponding recommendation is not marked full/conservative.',
    'Feed affected targets/tests into cpp_build_plan or project-owned verification commands; this tool never executes them.',
    'Use CRG/Serena separately for architecture/symbol semantics; cpp_build_impact owns only generated build evidence.',
  ],
  related_capabilities: ['build_metadata', 'cpp_build_plan', 'workspace_delta', 'CMake File API', 'Ninja deps', 'CTest json-v1'],
};
