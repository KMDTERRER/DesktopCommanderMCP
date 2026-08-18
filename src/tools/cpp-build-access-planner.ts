import crypto from 'crypto';
import path from 'path';

import {
  callBuildMetadataAcceleratorTool, type BuildMetadataSnapshot,
} from './build-metadata-accelerator.js';
import { collectCmakePresetDependencies } from './cmake-preset-dependencies.js';
import { inspectConfiguredExecutable } from '../utils/configured-executable.js';
import { runBoundedSubprocess } from '../utils/bounded-subprocess.js';
import type { ResourceLeaseCoverage, ResourceLeaseRequest } from '../utils/resource-lease-owner.js';

const MAX_OPERATION_TIMEOUT_MS = 45_000;
const MAX_TARGETS = 500;
const MAX_ACCESS_PATHS = 20_000;
const MAX_NINJA_OUTPUT_BYTES = 32 * 1024 * 1024;
const NINJA_PROBE_TIMEOUT_MS = 15_000;
const NINJA_TARGET_BATCH = 64;

type JsonRecord = Record<string, unknown>;

export type BuildPatternWatch = {
  expression: string;
  root: string;
  recurse: boolean;
};

export type BuildAccessPlan = {
  repositoryRoot: string;
  buildDir: string;
  requestedTargets: string[];
  includedTargets: string[];
  configureInputs: string[];
  sourceInputs: string[];
  dependencyInputs: string[];
  generatedOutputs: string[];
  artifactOutputs: string[];
  readPaths: string[];
  readRoots: string[];
  writePaths: string[];
  writeRoots: string[];
  patternWatches: BuildPatternWatch[];
  watchRoots: string[];
  coverage: ResourceLeaseCoverage;
  incompleteness: string[];
  warnings: string[];
  toolchains: unknown;
  evidence: Record<string, unknown>;
  accessFingerprint: string;
  leaseRequest: ResourceLeaseRequest;
};

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function slash(value: string): string {
  return value.replace(/\\/g, '/');
}

function remaining(deadlineAt: number, label: string, maximum = 10_000): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error(`${label} deadline exceeded.`) as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.min(maximum, value));
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function boundedPaths(values: string[], label: string): string[] {
  const unique = sortedUnique(values.map((value) => path.resolve(value)));
  if (unique.length > MAX_ACCESS_PATHS) {
    throw new Error(`${label} exceeds the build access path limit (${MAX_ACCESS_PATHS}).`);
  }
  return unique;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function cmakeTargets(metadata: BuildMetadataSnapshot): JsonRecord[] {
  const cmake = recordValue(metadata.cmake);
  return Array.isArray(cmake?.targets)
    ? cmake!.targets.map(recordValue).filter((item): item is JsonRecord => item !== undefined)
    : [];
}

function selectTargetClosure(targets: JsonRecord[], requested: string[]): JsonRecord[] {
  const byId = new Map<string, JsonRecord>();
  const byName = new Map<string, JsonRecord>();
  for (const target of targets) {
    if (typeof target.id === 'string') byId.set(target.id, target);
    if (typeof target.name === 'string') byName.set(target.name, target);
  }
  const roots = requested.length > 0 ? requested.map((name) => {
    const target = byName.get(name);
    if (!target) throw new Error(`Build access target is not present in CMake codemodel: ${name}`);
    return target;
  }) : targets;
  const selected = new Map<string, JsonRecord>();
  const queue = [...roots];
  while (queue.length > 0) {
    const target = queue.shift()!;
    const id = typeof target.id === 'string' ? target.id : `name:${String(target.name ?? '')}`;
    if (selected.has(id)) continue;
    selected.set(id, target);
    const dependencies = stringArray(target.dependencies);
    for (const dependency of dependencies) {
      const next = byId.get(dependency);
      if (next) queue.push(next);
    }
  }
  return [...selected.values()].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

function sourcePath(repositoryRoot: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(repositoryRoot, value);
}

function outputPath(buildDir: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(buildDir, value);
}

function targetFileSets(repositoryRoot: string, buildDir: string, targets: JsonRecord[]) {
  const sources: string[] = [];
  const generated: string[] = [];
  const artifacts: string[] = [];
  for (const target of targets) {
    const generatedSet = new Set(stringArray(target.generatedSources).map((item) => sourcePath(repositoryRoot, item)));
    for (const item of stringArray(target.sources)) {
      const absolute = sourcePath(repositoryRoot, item);
      if (generatedSet.has(absolute)) generated.push(absolute);
      else sources.push(absolute);
    }
    generated.push(...generatedSet);
    artifacts.push(...stringArray(target.artifacts).map((item) => outputPath(buildDir, item)));
  }
  return { sources: boundedPaths(sources, 'sourceInputs'), generated: boundedPaths(generated, 'generatedOutputs'), artifacts: boundedPaths(artifacts, 'artifactOutputs') };
}

function cmakeFileInputs(metadata: BuildMetadataSnapshot): string[] {
  const cmake = recordValue(metadata.cmake);
  const cmakeFiles = recordValue(cmake?.cmakeFiles);
  const inputs = Array.isArray(cmakeFiles?.inputs) ? cmakeFiles!.inputs : [];
  return inputs.map(recordValue).filter((item): item is JsonRecord => item !== undefined)
    .map((item) => typeof item.absolutePath === 'string' && item.absolutePath ? path.resolve(item.absolutePath) : '')
    .filter(Boolean);
}

function stableGlobRoot(expression: string, sourceRoot: string): string {
  const normalized = expression.replace(/\\/g, '/');
  const meta = normalized.search(/[?*[{]/);
  const prefix = meta < 0 ? normalized : normalized.slice(0, meta);
  const nativePrefix = prefix.replace(/\//g, path.sep);
  const absolutePrefix = path.isAbsolute(nativePrefix)
    ? path.resolve(nativePrefix) : path.resolve(sourceRoot, nativePrefix);
  if (!prefix || prefix.endsWith('/') || prefix.endsWith('\\')) return absolutePrefix;
  return path.dirname(absolutePrefix);
}

function cmakePatternWatches(metadata: BuildMetadataSnapshot): BuildPatternWatch[] {
  const cmake = recordValue(metadata.cmake);
  const cmakeFiles = recordValue(cmake?.cmakeFiles);
  const paths = recordValue(cmakeFiles?.paths);
  const sourceRoot = typeof paths?.source === 'string' ? path.resolve(paths.source) : path.resolve(metadata.repositoryRoot);
  const globs = Array.isArray(cmakeFiles?.globsDependent) ? cmakeFiles!.globsDependent : [];
  const result: BuildPatternWatch[] = [];
  for (const raw of globs) {
    const item = recordValue(raw);
    const expression = typeof item?.expression === 'string' ? item.expression : '';
    if (!expression) continue;
    result.push({ expression, root: stableGlobRoot(expression, sourceRoot), recurse: item?.recurse === true });
  }
  return result.sort((a, b) => a.root.localeCompare(b.root) || a.expression.localeCompare(b.expression));
}

function ninjaInputPath(buildDir: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return null;
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) return path.resolve(trimmed);
  return path.resolve(buildDir, trimmed);
}

function batches<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export type BuildDependencyInputsResult = {
  available: boolean;
  inputs: string[];
  warning?: string;
  executable?: string;
};

export type BuildAccessPlannerDependencies = {
  dependencyInputs?: (
    metadata: BuildMetadataSnapshot, targetNames: string[], deadlineAt: number,
  ) => Promise<BuildDependencyInputsResult>;
};

async function ninjaInputs(
  metadata: BuildMetadataSnapshot, targetNames: string[], deadlineAt: number,
): Promise<BuildDependencyInputsResult> {
  const cache = recordValue(metadata.cmakeCache?.values) ?? {};
  const generator = typeof cache.CMAKE_GENERATOR === 'string' ? cache.CMAKE_GENERATOR : '';
  if (!generator.startsWith('Ninja')) {
    return { available: false, inputs: [], warning: `Generator '${generator || '<unknown>'}' has no Ninja inputs provider.` };
  }
  if (targetNames.length === 0) {
    return { available: false, inputs: [], warning: 'Ninja inputs provider has no selected target names.' };
  }
  const inspected = await inspectConfiguredExecutable(cache.CMAKE_MAKE_PROGRAM, {
    repositoryRoot: path.resolve(metadata.repositoryRoot), buildDir: path.resolve(metadata.buildDir),
    deadlineAt, label: 'Configured Ninja executable', expectedNames: ['ninja'],
  });
  if (!inspected.trusted || !inspected.path) return { available: false, inputs: [], warning: inspected.reason };
  const inputs: string[] = [];
  for (const batch of batches(sortedUnique(targetNames), NINJA_TARGET_BATCH)) {
    const result = await runBoundedSubprocess(
      inspected.path, ['-C', path.resolve(metadata.buildDir), '-t', 'inputs', ...batch],
      {
        cwd: path.resolve(metadata.repositoryRoot),
        timeoutMs: Math.min(NINJA_PROBE_TIMEOUT_MS, remaining(deadlineAt, 'Ninja inputs provider', NINJA_PROBE_TIMEOUT_MS)),
        maxOutputBytes: MAX_NINJA_OUTPUT_BYTES,
        label: 'Ninja inputs provider',
      },
    );
    if (result.exitCode !== 0) {
      return {
        available: false, inputs: [], executable: slash(inspected.path),
        warning: `Ninja inputs provider failed (${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 8000)}`,
      };
    }
    for (const line of result.stdout.split(/\r?\n/)) {
      const input = ninjaInputPath(path.resolve(metadata.buildDir), line);
      if (input) inputs.push(input);
      if (inputs.length > MAX_ACCESS_PATHS) {
        return {
          available: false, inputs: [], executable: slash(inspected.path),
          warning: `Ninja inputs exceed the build access path limit (${MAX_ACCESS_PATHS}).`,
        };
      }
    }
  }
  return { available: true, inputs: boundedPaths(inputs, 'dependencyInputs'), executable: slash(inspected.path) };
}

function cmakeFilesFound(metadata: BuildMetadataSnapshot): boolean {
  return recordValue(recordValue(metadata.cmake)?.cmakeFiles)?.found === true;
}

function targetModelComplete(metadata: BuildMetadataSnapshot): boolean {
  const cmake = recordValue(metadata.cmake);
  return cmake?.targetsTruncated !== true && cmake?.targetsByteTruncated !== true;
}

function accessFingerprint(value: Record<string, unknown>): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function coverageNeedsConservativeRoot(value: ResourceLeaseCoverage): boolean {
  return value === 'conservative' || value === 'incomplete';
}

export async function callCppBuildAccessPlanner(
  args: Record<string, unknown>, timeoutMs = 30_000, metadataSnapshot?: BuildMetadataSnapshot,
  dependencies: BuildAccessPlannerDependencies = {},
): Promise<BuildAccessPlan> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`Build access planner timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  if (typeof args.root !== 'string' || !args.root.trim()) throw new Error('Build access planner root is required.');
  const requestedTargets = args.targets === undefined ? [] : stringArray(args.targets);
  if (args.targets !== undefined && (!Array.isArray(args.targets) || requestedTargets.length !== args.targets.length || requestedTargets.length > MAX_TARGETS)) {
    throw new Error(`Build access planner targets must contain at most ${MAX_TARGETS} names.`);
  }
  const preset = args.preset === undefined ? undefined : args.preset;
  if (preset !== undefined && (typeof preset !== 'string' || !preset.trim() || /[\0\r\n]/.test(preset))) {
    throw new Error('Build access planner preset must be a non-empty single-line string.');
  }
  const deadlineAt = Date.now() + timeoutMs;
  const metadata = metadataSnapshot ?? await callBuildMetadataAcceleratorTool({
    root: args.root, buildDir: args.buildDir, configuration: args.configuration,
    includeArguments: false, maxEntries: 1, maxTargets: MAX_TARGETS,
  }, remaining(deadlineAt, 'Build access metadata', MAX_OPERATION_TIMEOUT_MS));
  const repositoryRoot = path.resolve(metadata.repositoryRoot);
  const buildDir = path.resolve(metadata.buildDir);
  const targets = cmakeTargets(metadata);
  const included = selectTargetClosure(targets, requestedTargets);
  const includedTargets = sortedUnique(included.map((target) => String(target.name ?? '')).filter(Boolean));
  const files = targetFileSets(repositoryRoot, buildDir, included);
  const presetFiles = preset
    ? await collectCmakePresetDependencies(repositoryRoot, remaining(deadlineAt, 'Build access preset dependencies'))
    : [];
  const configureInputs = boundedPaths([
    ...cmakeFileInputs(metadata), ...presetFiles.map((item) => item.path),
  ], 'configureInputs');
  const patternWatches = cmakePatternWatches(metadata);
  const watchRoots = boundedPaths(patternWatches.map((item) => item.root), 'watchRoots');

  const dependencyProvider = dependencies.dependencyInputs ?? ninjaInputs;
  const ninja = await dependencyProvider(
    metadata, requestedTargets.length > 0 ? requestedTargets : ['all'], deadlineAt,
  );
  const dependencyInputs = ninja.available ? ninja.inputs : [];
  const incompleteness: string[] = [];
  const warnings: string[] = [];
  if (!cmakeFilesFound(metadata)) incompleteness.push('cmake_files_reply_unavailable');
  if (!targetModelComplete(metadata)) incompleteness.push('cmake_target_model_truncated');
  if (targets.length === 0) incompleteness.push('cmake_target_model_unavailable');
  if (!ninja.available) {
    incompleteness.push('generator_dependency_inputs_unavailable');
    if (ninja.warning) warnings.push(ninja.warning);
  }

  let coverage: ResourceLeaseCoverage;
  if (!cmakeFilesFound(metadata) || targets.length === 0) coverage = 'incomplete';
  else if (ninja.available && targetModelComplete(metadata)) coverage = 'historical';
  else coverage = 'conservative';

  const readPaths = boundedPaths([
    ...configureInputs, ...files.sources, ...dependencyInputs,
  ], 'readPaths');
  const readRoots = coverageNeedsConservativeRoot(coverage) ? [repositoryRoot] : [];
  const writePaths = boundedPaths([...files.generated, ...files.artifacts], 'writePaths');
  const writeRoots = [buildDir];
  const cmake = recordValue(metadata.cmake) ?? {};
  const cmakeFiles = recordValue(cmake.cmakeFiles) ?? {};
  const toolchains = recordValue(cmake.toolchains) ?? {};
  const codemodel = recordValue(cmake.codemodel) ?? {};
  const fingerprintPayload = {
    repositoryRoot: slash(repositoryRoot), buildDir: slash(buildDir),
    requestedTargets: sortedUnique(requestedTargets), includedTargets,
    configureInputs: configureInputs.map(slash), sourceInputs: files.sources.map(slash),
    dependencyInputs: dependencyInputs.map(slash), generatedOutputs: files.generated.map(slash),
    artifactOutputs: files.artifacts.map(slash), readRoots: readRoots.map(slash),
    patternWatches: patternWatches.map((item) => ({ ...item, root: slash(item.root) })),
    coverage,
    metadata: {
      cache: metadata.cmakeCache?.sha256 ?? null,
      compileDatabase: metadata.compileDatabase?.found ? metadata.compileDatabase.sha256 : null,
      codemodel: typeof codemodel.sha256 === 'string' ? codemodel.sha256 : null,
      cmakeFiles: typeof cmakeFiles.sha256 === 'string' ? cmakeFiles.sha256 : null,
      toolchains: typeof toolchains.sha256 === 'string' ? toolchains.sha256 : null,
    },
    presetFiles: presetFiles.map((item) => [item.name, item.sha256]),
    ninjaExecutable: ninja.executable ?? null,
  };
  const fingerprint = accessFingerprint(fingerprintPayload);
  const leaseRequest: ResourceLeaseRequest = {
    kind: 'build', label: `CMake build access ${path.basename(buildDir)}`, workspaceRoot: repositoryRoot,
    readPaths, readRoots, writePaths, writeRoots, watchRoots, coverage,
  };

  return {
    repositoryRoot: slash(repositoryRoot), buildDir: slash(buildDir),
    requestedTargets: sortedUnique(requestedTargets), includedTargets,
    configureInputs: configureInputs.map(slash), sourceInputs: files.sources.map(slash),
    dependencyInputs: dependencyInputs.map(slash), generatedOutputs: files.generated.map(slash),
    artifactOutputs: files.artifacts.map(slash), readPaths: readPaths.map(slash), readRoots: readRoots.map(slash),
    writePaths: writePaths.map(slash), writeRoots: writeRoots.map(slash),
    patternWatches: patternWatches.map((item) => ({ ...item, root: slash(item.root) })), watchRoots: watchRoots.map(slash),
    coverage, incompleteness: [...new Set(incompleteness)], warnings,
    toolchains: cmake.toolchains ?? { found: false, toolchains: [] },
    evidence: fingerprintPayload.metadata, accessFingerprint: fingerprint, leaseRequest,
  };
}
