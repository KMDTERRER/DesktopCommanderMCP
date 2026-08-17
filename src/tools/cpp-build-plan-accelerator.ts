import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { callBuildMetadataAcceleratorTool, revalidateBuildMetadataSnapshot, type BuildMetadataSnapshot } from './build-metadata-accelerator.js';
import { readFileBounded } from '../utils/bounded-file-read.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { PROCESS_WAIT_DEFAULT_MS } from '../utils/process-wait-contract.js';

const MAX_OPERATION_TIMEOUT_MS = 45_000;
const MAX_PRESET_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TARGETS = 50;

type BuildOperation = 'build' | 'test';
type PresetFingerprint = {
  name: string;
  path: string;
  sha256: string;
  size: number;
  mtimeMs: number;
};

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

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertArguments(args: Record<string, unknown>): void {
  const allowed = new Set(['root', 'buildDir', 'operation', 'preset', 'targets', 'configuration']);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`cpp_build_plan received unsupported argument(s): ${unknown.join(', ')}.`);
}

function boundedToken(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || value.includes(String.fromCharCode(0)) || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty string up to ${maxLength} characters without control line breaks.`);
  }
  return value;
}

function requestedTargets(value: unknown, operation: BuildOperation): string[] {
  if (value === undefined) return [];
  if (operation !== 'build') throw new Error('cpp_build_plan.targets is only valid for build operations.');
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TARGETS) {
    throw new Error(`cpp_build_plan.targets must contain 1-${MAX_TARGETS} target names.`);
  }
  const targets = value.map((item, index) => boundedToken(item, `cpp_build_plan.targets[${index}]`));
  if (targets.some((target) => target.startsWith('-'))) {
    throw new Error('cpp_build_plan target names beginning with - are rejected to prevent option injection.');
  }
  return [...new Set(targets)];
}

async function presetFingerprint(
  root: string,
  name: string,
  deadlineAt: number,
): Promise<PresetFingerprint | null> {
  const lexical = path.join(root, name);
  let initial;
  try {
    initial = await runWithAbortableTimeout(
      (_signal) => fs.lstat(lexical),
      remaining(deadlineAt, 'cpp_build_plan preset stat'),
      `Stat cpp_build_plan preset file ${lexical}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
  if (!initial.isFile() && !initial.isSymbolicLink()) throw new Error(`Preset path is not a file: ${lexical}`);
  const canonical = await runWithAbortableTimeout(
    (_signal) => fs.realpath(lexical),
    remaining(deadlineAt, 'cpp_build_plan preset resolution'),
    `Resolve cpp_build_plan preset file ${lexical}`,
  );
  if (!isInside(root, canonical)) throw new Error(`Preset file escapes repository root: ${name}`);
  const before = await runWithAbortableTimeout(
    (_signal) => fs.stat(canonical),
    remaining(deadlineAt, 'cpp_build_plan preset stat'),
    `Stat resolved cpp_build_plan preset file ${canonical}`,
  );
  if (!before.isFile()) throw new Error(`Resolved preset path is not a file: ${canonical}`);
  if (before.size > MAX_PRESET_FILE_BYTES) throw new Error(`Preset file exceeds ${MAX_PRESET_FILE_BYTES} bytes: ${name}`);
  const bytes = await runWithAbortableTimeout(
    (signal) => readFileBounded(canonical, MAX_PRESET_FILE_BYTES, signal, 'cpp_build_plan preset file'),
    remaining(deadlineAt, 'cpp_build_plan preset read'),
    `Read cpp_build_plan preset file ${canonical}`,
  );
  const after = await runWithAbortableTimeout(
    (_signal) => fs.stat(canonical),
    remaining(deadlineAt, 'cpp_build_plan preset re-stat'),
    `Re-stat cpp_build_plan preset file ${canonical}`,
  );
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) {
    throw new Error(`Preset file changed while cpp_build_plan was reading it: ${name}`);
  }
  return {
    name,
    path: slash(canonical),
    size: bytes.length,
    mtimeMs: after.mtimeMs,
    sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
  };
}

async function verifyExecutable(
  executable: unknown, label: string, expectedName: 'cmake' | 'ctest', deadlineAt: number,
): Promise<string> {
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
    throw new Error(`${label} is unavailable in the configured CMake cache.`);
  }
  const basename = path.basename(executable).toLowerCase();
  if (basename !== expectedName && basename !== `${expectedName}.exe`) {
    throw new Error(`${label} does not identify the expected ${expectedName} executable: ${executable}`);
  }
  const stats = await runWithAbortableTimeout(
    (_signal) => fs.stat(executable),
    remaining(deadlineAt, `${label} stat`),
    `Stat ${label} ${executable}`,
  );
  if (!stats.isFile()) throw new Error(`${label} does not resolve to a file: ${executable}`);
  return executable;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

type BuildEnvironmentHandoff = {
  env: Record<string, string>;
  pathPrepend: string[];
  qtPluginPath: string | null;
  source: 'cmake-cache';
};

async function existingDirectory(directory: string, deadlineAt: number, label: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error(`${label} is not an absolute directory: ${directory}`);
  const stats = await runWithAbortableTimeout(
    (_signal) => fs.stat(directory),
    remaining(deadlineAt, `${label} stat`),
    `Stat ${label} ${directory}`,
  );
  if (!stats.isDirectory()) throw new Error(`${label} is not a directory: ${directory}`);
  return path.resolve(directory);
}

async function configuredEnvironment(
  cacheValues: Record<string, string>, operation: BuildOperation, deadlineAt: number,
): Promise<BuildEnvironmentHandoff> {
  const pathPrepend: string[] = [];
  const addExecutableDirectory = async (value: string | undefined, label: string) => {
    if (!value || !path.isAbsolute(value)) return;
    const directory = await existingDirectory(path.dirname(value), deadlineAt, `${label} directory`);
    if (!pathPrepend.some((item) => process.platform === 'win32'
      ? item.toLowerCase() === directory.toLowerCase() : item === directory)) {
      pathPrepend.push(directory);
    }
  };

  await addExecutableDirectory(cacheValues.CMAKE_CXX_COMPILER ?? cacheValues.CMAKE_C_COMPILER, 'CMake compiler');
  await addExecutableDirectory(cacheValues.CMAKE_MAKE_PROGRAM, 'CMake build program');

  let qtPluginPath: string | null = null;
  const qt6Dir = cacheValues.Qt6_DIR;
  if (qt6Dir && path.isAbsolute(qt6Dir)) {
    const qtPrefix = path.resolve(qt6Dir, '..', '..', '..');
    const qtBin = await existingDirectory(path.join(qtPrefix, 'bin'), deadlineAt, 'Qt runtime bin');
    if (!pathPrepend.some((item) => process.platform === 'win32'
      ? item.toLowerCase() === qtBin.toLowerCase() : item === qtBin)) {
      pathPrepend.push(qtBin);
    }
    if (operation === 'test') {
      qtPluginPath = await existingDirectory(path.join(qtPrefix, 'plugins'), deadlineAt, 'Qt plugin runtime');
    }
  }

  const env: Record<string, string> = {};
  if (pathPrepend.length > 0) {
    env.PATH = [...pathPrepend, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);
  }
  if (qtPluginPath) env.QT_PLUGIN_PATH = qtPluginPath;
  return { env, pathPrepend: pathPrepend.map(slash), qtPluginPath: qtPluginPath ? slash(qtPluginPath) : null, source: 'cmake-cache' };
}

function profileFingerprint(payload: Record<string, unknown>): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

export async function callCppBuildPlanAcceleratorTool(
  args: Record<string, unknown>, timeoutMs = 30_000, metadataSnapshot?: BuildMetadataSnapshot,
) {
  assertArguments(args);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`cpp_build_plan timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  const deadlineAt = Date.now() + timeoutMs;
  const operation = args.operation === undefined ? 'build' : args.operation;
  if (operation !== 'build' && operation !== 'test') throw new Error("cpp_build_plan.operation must be 'build' or 'test'.");
  const typedOperation = operation as BuildOperation;
  const preset = args.preset === undefined ? undefined : boundedToken(args.preset, 'cpp_build_plan.preset');
  const configuration = args.configuration === undefined
    ? undefined
    : boundedToken(args.configuration, 'cpp_build_plan.configuration', 128);
  const targets = requestedTargets(args.targets, typedOperation);

  const metadata = metadataSnapshot ?? await callBuildMetadataAcceleratorTool({
    root: args.root,
    buildDir: args.buildDir,
    configuration,
    maxEntries: 1,
    maxTargets: 1,
  }, remaining(deadlineAt, 'cpp_build_plan build metadata', MAX_OPERATION_TIMEOUT_MS));
  if (!metadata.cmakeCache.found) {
    throw new Error('cpp_build_plan requires an existing configured CMake tree with CMakeCache.txt.');
  }
  const repositoryRoot = path.resolve(metadata.repositoryRoot);
  const buildDir = path.resolve(metadata.buildDir);
  const cacheValues = metadata.cmakeCache.values;
  const cmakeRecord = recordValue(metadata.cmake);
  const codemodelRecord = recordValue(cmakeRecord?.codemodel);
  const generatorRecord = recordValue(cmakeRecord?.generator);
  const codemodelSha256 = typeof codemodelRecord?.sha256 === 'string' ? codemodelRecord.sha256 : null;
  const generatorName = typeof generatorRecord?.name === 'string' ? generatorRecord.name : null;
  const executable = typedOperation === 'build'
    ? await verifyExecutable(cacheValues.CMAKE_COMMAND, 'CMAKE_COMMAND', 'cmake', deadlineAt)
    : await verifyExecutable(cacheValues.CMAKE_CTEST_COMMAND, 'CMAKE_CTEST_COMMAND', 'ctest', deadlineAt);

  const environment = await configuredEnvironment(cacheValues, typedOperation, deadlineAt);

  const presetFiles = (await Promise.all([
    presetFingerprint(repositoryRoot, 'CMakePresets.json', deadlineAt),
    presetFingerprint(repositoryRoot, 'CMakeUserPresets.json', deadlineAt),
  ])).filter((item): item is PresetFingerprint => item !== null);
  if (preset && presetFiles.length === 0) {
    throw new Error('cpp_build_plan.preset was provided but the project has no CMakePresets.json or CMakeUserPresets.json.');
  }
  const configurationTypes = typeof cacheValues.CMAKE_CONFIGURATION_TYPES === 'string'
    ? cacheValues.CMAKE_CONFIGURATION_TYPES.split(';').filter(Boolean)
    : [];
  if (typedOperation === 'test' && !preset && configurationTypes.length > 0 && !configuration) {
    throw new Error(`cpp_build_plan requires an explicit configuration for this multi-config CTest tree: ${configurationTypes.join(', ')}.`);
  }

  const processArgs: string[] = [];
  if (typedOperation === 'build') {
    processArgs.push('--build');
    if (preset) processArgs.push('--preset', preset);
    else processArgs.push(buildDir);
    if (configuration) processArgs.push('--config', configuration);
    if (targets.length > 0) processArgs.push('--target', ...targets);
  } else {
    if (preset) processArgs.push('--preset', preset);
    else processArgs.push('--test-dir', buildDir);
    if (configuration) processArgs.push('-C', configuration);
  }

  const snapshotValidation = await revalidateBuildMetadataSnapshot(
    metadata, remaining(deadlineAt, 'cpp_build_plan snapshot revalidation', 5_000),
  );
  if (!snapshotValidation.current) {
    const error = new Error(
      `Build metadata changed while cpp_build_plan was being derived: ${snapshotValidation.changed.join(', ')}. Refresh the plan before execution.`,
    ) as NodeJS.ErrnoException;
    error.code = 'EBUILDSNAPSHOTCHANGED';
    throw error;
  }

  const fingerprintPayload = {
    cache: metadata.cmakeCache.sha256,
    compileDatabase: metadata.compileDatabase.found ? metadata.compileDatabase.sha256 : null,
    codemodel: codemodelSha256,
    presetFiles: presetFiles.map((item) => [item.name, item.sha256]),
    operation: typedOperation,
    executable: slash(executable),
    args: processArgs,
    environment: { pathPrepend: environment.pathPrepend, qtPluginPath: environment.qtPluginPath },
  };
  return {
    repositoryRoot: slash(repositoryRoot),
    buildDir: slash(buildDir),
    operation: typedOperation,
    source: preset ? 'explicit-preset' : 'configured-build-tree',
    preset: preset ?? null,
    targets,
    configuration: configuration ?? null,
    process: {
      executable: slash(executable),
      args: processArgs,
      cwd: slash(repositoryRoot),
      execution_kind: 'finite',
      pty: 'never',
      timeout_ms: PROCESS_WAIT_DEFAULT_MS,
      ...(Object.keys(environment.env).length > 0 ? { env: environment.env } : {}),
    },
    profileFingerprint: profileFingerprint(fingerprintPayload),
    evidence: {
      cmakeCache: { path: metadata.cmakeCache.path, sha256: metadata.cmakeCache.sha256 },
      compileDatabaseSha256: metadata.compileDatabase.found ? metadata.compileDatabase.sha256 : null,
      codemodelSha256,
      generator: cacheValues.CMAKE_GENERATOR ?? generatorName,
      buildProgram: cacheValues.CMAKE_MAKE_PROGRAM ?? null,
      configurationTypes,
      presetFiles,
      environment: {
        source: environment.source,
        pathPrepend: environment.pathPrepend,
        qtPluginPath: environment.qtPluginPath,
        inheritedPathPreserved: true,
      },
      snapshotValidation,
    },
  };
}

export const CPP_BUILD_PLAN_ACCELERATOR_TOOL = {
  name: 'cpp_build_plan',
  purpose: 'Return a validated structured start_process plan for an existing CMake build or CTest run without executing it.',
  when_to_use: 'After build_metadata for CMake projects when the next step is a build or test and compiler/build flags should remain owned by CMake.',
  when_not_to_use: 'For configuring a fresh build tree, selecting an unknown preset, or directly invoking compilers/linkers.',
  readOnly: true,
  mutating: false,
  inputSchema: {
    type: 'object',
    required: ['root'],
    additionalProperties: false,
    properties: {
      root: { type: 'string', description: 'Project/repository root.' },
      buildDir: { type: 'string', description: 'Optional configured CMake build directory.' },
      operation: { type: 'string', enum: ['build', 'test'], default: 'build' },
      preset: {
        type: 'string',
        description: 'Optional explicit project-owned build/test preset. The tool never guesses among presets.',
      },
      targets: {
        type: 'array',
        maxItems: MAX_TARGETS,
        items: { type: 'string' },
        description: 'Optional CMake build targets; build operations only.',
      },
      configuration: { type: 'string', description: 'Optional Debug/Release-style configuration.' },
    },
  },
  recommended_workflow: [
    'Use an existing configured CMake tree; this tool never configures or builds by itself.',
    'Pass an explicit preset only when already selected by project/user context; otherwise use the configured build tree.',
    'Execute the returned process object through desktop-core/start_process, then use wait_process for completion.',
    'Let CMake/CTest own generator, compiler, linker, parallelism and preset semantics; execute the returned reviewed env handoff unchanged so configured toolchain/runtime directories stay available.',
  ],
  related_capabilities: [
    'build_metadata',
    'desktop-core/start_process',
    'wait_process',
    'CMakePresets.json',
    'CTest',
  ],
};
