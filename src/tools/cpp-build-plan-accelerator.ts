import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { callBuildMetadataAcceleratorTool, revalidateBuildMetadataSnapshot, type BuildMetadataSnapshot } from './build-metadata-accelerator.js';
import { collectCmakePresetDependencies } from './cmake-preset-dependencies.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { PROCESS_WAIT_DEFAULT_MS } from '../utils/process-wait-contract.js';
import { requireConfiguredExecutable } from '../utils/configured-executable.js';

const MAX_OPERATION_TIMEOUT_MS = 45_000;
const MAX_TARGETS = 50;
const MAX_TESTS = 50;
const MAX_PARALLELISM = 256;

type BuildOperation = 'build' | 'test';
type BuildParallelism = number | 'project';
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

function assertArguments(args: Record<string, unknown>): void {
  const allowed = new Set(['root', 'buildDir', 'operation', 'preset', 'targets', 'tests', 'configuration', 'parallelism', 'outputOnFailure', 'noTestsError']);
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

function requestedTests(value: unknown, operation: BuildOperation): string[] {
  if (value === undefined) return [];
  if (operation !== 'test') throw new Error('cpp_build_plan.tests is only valid for test operations.');
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TESTS) {
    throw new Error(`cpp_build_plan.tests must contain 1-${MAX_TESTS} test names.`);
  }
  return [...new Set(value.map((item, index) => boundedToken(item, `cpp_build_plan.tests[${index}]`)))];
}

function requestedParallelism(value: unknown): BuildParallelism {
  if (value === undefined || value === 'project') return 'project';
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_PARALLELISM) {
    throw new Error(`cpp_build_plan.parallelism must be 'project' or an integer from 1 to ${MAX_PARALLELISM}.`);
  }
  return value as number;
}

function exactTestRegex(tests: string[]): string {
  const escaped = tests.map((test) => test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `^(${escaped.join('|')})$`;
}

async function verifyExecutable(
  executable: unknown, label: string, expectedName: 'cmake' | 'ctest',
  repositoryRoot: string, buildDir: string, deadlineAt: number,
): Promise<string> {
  return requireConfiguredExecutable(executable, {
    repositoryRoot, buildDir, deadlineAt, label, expectedNames: [expectedName], projectLocalPolicy: 'allow',
  });
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
  const tests = requestedTests(args.tests, typedOperation);
  const parallelism = requestedParallelism(args.parallelism);
  const outputOnFailure = args.outputOnFailure === true;
  const noTestsError = args.noTestsError === true;
  if (args.outputOnFailure !== undefined && typeof args.outputOnFailure !== 'boolean') {
    throw new Error('cpp_build_plan.outputOnFailure must be boolean.');
  }
  if (args.noTestsError !== undefined && typeof args.noTestsError !== 'boolean') {
    throw new Error('cpp_build_plan.noTestsError must be boolean.');
  }

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
    ? await verifyExecutable(cacheValues.CMAKE_COMMAND, 'CMAKE_COMMAND', 'cmake', repositoryRoot, buildDir, deadlineAt)
    : await verifyExecutable(cacheValues.CMAKE_CTEST_COMMAND, 'CMAKE_CTEST_COMMAND', 'ctest', repositoryRoot, buildDir, deadlineAt);

  const environment = await configuredEnvironment(cacheValues, typedOperation, deadlineAt);

  const presetFiles = preset
    ? await collectCmakePresetDependencies(repositoryRoot, remaining(deadlineAt, 'cpp_build_plan preset dependencies'))
    : [];
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
    if (typeof parallelism === 'number') processArgs.push('--parallel', String(parallelism));
  } else {
    if (preset) processArgs.push('--preset', preset);
    else processArgs.push('--test-dir', buildDir);
    if (configuration) processArgs.push('-C', configuration);
    if (tests.length > 0) processArgs.push('--tests-regex', exactTestRegex(tests));
    if (typeof parallelism === 'number') processArgs.push('--parallel', String(parallelism));
    if (outputOnFailure) processArgs.push('--output-on-failure');
    if (noTestsError) processArgs.push('--no-tests=error');
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
    tests,
    parallelism,
    outputOnFailure,
    noTestsError,
    environment: { pathPrepend: environment.pathPrepend, qtPluginPath: environment.qtPluginPath },
  };
  return {
    repositoryRoot: slash(repositoryRoot),
    buildDir: slash(buildDir),
    operation: typedOperation,
    source: preset ? 'explicit-preset' : 'configured-build-tree',
    preset: preset ?? null,
    targets,
    tests,
    configuration: configuration ?? null,
    parallelism,
    outputOnFailure,
    noTestsError,
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
      tests: {
        type: 'array',
        maxItems: MAX_TESTS,
        items: { type: 'string' },
        description: 'Optional exact CTest names; test operations only. Converted to one anchored escaped --tests-regex.',
      },
      configuration: { type: 'string', description: 'Optional Debug/Release-style configuration.' },
      parallelism: {
        oneOf: [
          { type: 'integer', minimum: 1, maximum: MAX_PARALLELISM },
          { type: 'string', enum: ['project'] },
        ],
        default: 'project',
        description: "Explicit job count, or 'project' to preserve preset/environment/build-system defaults.",
      },
      outputOnFailure: { type: 'boolean', default: false, description: 'For CTest, request failed-test output without changing test selection.' },
      noTestsError: { type: 'boolean', default: false, description: 'For CTest, fail if the selected test set executes zero tests.' },
    },
  },
  recommended_workflow: [
    'Use an existing configured CMake tree; this tool never configures or builds by itself.',
    'Pass an explicit preset only when already selected by project/user context; otherwise use the configured build tree.',
    'Execute the returned process object through desktop-core/start_process, then use wait_process for completion.',
    'Let CMake/CTest own generator, compiler, linker, parallelism and preset semantics; execute the returned reviewed env handoff unchanged so configured toolchain/runtime directories stay available.',
    'Use exact tests only when already selected by project/impact context; the plan escapes them into one anchored CTest regex.',
  ],
  related_capabilities: [
    'build_metadata',
    'desktop-core/start_process',
    'wait_process',
    'CMakePresets.json',
    'CTest',
  ],
};
