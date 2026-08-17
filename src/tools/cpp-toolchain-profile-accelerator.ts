import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { callBuildMetadataAcceleratorTool, revalidateBuildMetadataSnapshot, type BuildMetadataSnapshot } from './build-metadata-accelerator.js';
import { runBoundedSubprocess, type BoundedSubprocessResult } from '../utils/bounded-subprocess.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';

const MAX_OPERATION_TIMEOUT_MS = 45_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_OUTPUT_BYTES = 512 * 1024;
const MAX_COMPILERS = 8;

type JsonRecord = Record<string, unknown>;
type CompilerFamily = 'gcc' | 'clang' | 'clang-cl' | 'msvc' | 'unknown';
type Version = [number, number, number];

type CompilerProfile = {
  source: string;
  path: string | null;
  family: CompilerFamily;
  version: string | null;
  target: string | null;
  queryDriverEligible: boolean;
  warnings: string[];
};

function slash(value: string): string {
  return value.replace(/\\/g, '/');
}

function pathIdentity(value: string): string {
  const normalized = slash(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function queryDriverSafePath(value: string): boolean {
  // clangd parses --query-driver as a comma-separated glob allowlist. Keep our
  // handoff exact: paths containing separators/glob metacharacters would broaden it.
  return !/[,?*\[\]]/.test(value);
}
function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord : undefined;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function remaining(deadlineAt: number, maximum = 10_000): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error('cpp_toolchain_profile operation deadline exceeded.') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.min(maximum, value));
}

function parseVersion(value: string | null): Version | null {
  if (!value) return null;
  const match = value.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function versionAtLeast(value: string | null, expected: Version): boolean | null {
  const parsed = parseVersion(value);
  if (!parsed) return null;
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] > expected[index]) return true;
    if (parsed[index] < expected[index]) return false;
  }
  return true;
}

async function runProbe(
  executable: string, args: string[], cwd: string, deadlineAt: number, label: string,
): Promise<BoundedSubprocessResult> {
  return runBoundedSubprocess(executable, args, {
    cwd,
    timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining(deadlineAt, PROBE_TIMEOUT_MS)),
    maxOutputBytes: MAX_PROBE_OUTPUT_BYTES,
    label,
  });
}

function firstLine(result: BoundedSubprocessResult): string {
  return (result.stdout || result.stderr).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

async function canonicalExternalExecutable(
  candidate: string, repositoryRoot: string, buildDir: string, deadlineAt: number,
): Promise<{ path: string | null; probeAllowed: boolean; warning?: string }> {
  if (!path.isAbsolute(candidate)) return { path: null, probeAllowed: false, warning: `Compiler path is not absolute: ${candidate}` };
  try {
    const canonical = await runWithAbortableTimeout(
      (_signal) => fs.realpath(candidate), remaining(deadlineAt), `Resolve toolchain executable ${candidate}`,
    );
    if (isInside(repositoryRoot, canonical) || isInside(buildDir, canonical)) {
      return { path: slash(canonical), probeAllowed: false, warning: 'Executable is inside the repository/build tree and will not be auto-queried.' };
    }
    const stats = await runWithAbortableTimeout(
      (_signal) => fs.stat(canonical), remaining(deadlineAt), `Stat toolchain executable ${canonical}`,
    );
    if (!stats.isFile()) return { path: null, probeAllowed: false, warning: `Compiler path is not a file: ${candidate}` };
    return { path: slash(canonical), probeAllowed: true };
  } catch (error) {
    return { path: null, probeAllowed: false, warning: error instanceof Error ? error.message : String(error) };
  }
}

function cacheCompilerPaths(cacheValues: JsonRecord): string[] {
  return ['CMAKE_CXX_COMPILER', 'CMAKE_C_COMPILER']
    .map((key) => cacheValues[key])
    .filter((value): value is string => typeof value === 'string' && path.isAbsolute(value));
}

function resolveCompilerCandidate(
  token: string, entryDirectories: Map<string, string>, cachePaths: string[], buildDir: string,
): string | null {
  if (path.isAbsolute(token)) return token;
  if (/[\\/]/.test(token)) {
    const directory = entryDirectories.get(token) ?? buildDir;
    return path.resolve(directory, token);
  }
  const basename = token.toLowerCase().replace(/\.exe$/, '');
  const matches = cachePaths.filter((item) => path.basename(item).toLowerCase().replace(/\.exe$/, '') === basename);
  return matches.length === 1 ? matches[0] : null;
}

function parseMsvcVersion(text: string): string | null {
  return text.match(/Compiler Version\s+(\d+(?:\.\d+){1,3})/i)?.[1] ?? null;
}

function parseClangVersion(text: string): string | null {
  return text.match(/clang version\s+(\d+(?:\.\d+){1,3})/i)?.[1] ?? null;
}
async function profileCompiler(
  source: string,
  candidate: string | null,
  repositoryRoot: string,
  buildDir: string,
  deadlineAt: number,
): Promise<CompilerProfile> {
  const warnings: string[] = [];
  if (!candidate) return { source, path: null, family: 'unknown', version: null, target: null, queryDriverEligible: false, warnings: ['Compiler path could not be resolved without PATH guessing.'] };
  const resolved = await canonicalExternalExecutable(candidate, repositoryRoot, buildDir, deadlineAt);
  if (resolved.warning) warnings.push(resolved.warning);
  if (!resolved.path || !resolved.probeAllowed) {
    return { source, path: resolved.path, family: 'unknown', version: null, target: null, queryDriverEligible: false, warnings };
  }

  const executable = resolved.path;
  const queryDriverEligible = queryDriverSafePath(executable);
  if (!queryDriverEligible) warnings.push('Compiler path contains clangd query-driver glob/list metacharacters and is not safe for an exact allowlist.');
  const basename = path.basename(executable).toLowerCase();
  if (basename === 'cl.exe' || basename === 'cl') {
    const result = await runProbe(executable, ['/Bv'], buildDir, deadlineAt, 'MSVC /Bv probe');
    const text = `${result.stdout}\n${result.stderr}`;
    const target = text.match(/\bfor\s+(x64|x86|ARM64|ARM)\b/i)?.[1] ?? null;
    if (result.exitCode !== 0 && !parseMsvcVersion(text)) warnings.push(`cl /Bv exited ${result.exitCode}.`);
    return { source, path: executable, family: 'msvc', version: parseMsvcVersion(text), target, queryDriverEligible, warnings };
  }

  const versionResult = await runProbe(executable, ['--version'], buildDir, deadlineAt, 'Compiler version probe');
  const versionText = `${versionResult.stdout}\n${versionResult.stderr}`;
  if (/clang/i.test(versionText)) {
    const family: CompilerFamily = basename.includes('clang-cl') ? 'clang-cl' : 'clang';
    const targetResult = await runProbe(executable, ['--print-target-triple'], buildDir, deadlineAt, 'Clang target probe');
    if (versionResult.exitCode !== 0) warnings.push(`Compiler --version exited ${versionResult.exitCode}.`);
    if (targetResult.exitCode !== 0) warnings.push(`Clang target probe exited ${targetResult.exitCode}.`);
    return {
      source, path: executable, family,
      version: parseClangVersion(versionText),
      target: targetResult.exitCode === 0 ? firstLine(targetResult) || null : null,
      queryDriverEligible, warnings,
    };
  }

  const gccVersion = await runProbe(executable, ['-dumpfullversion'], buildDir, deadlineAt, 'GCC version probe');
  const gccVersionText = firstLine(gccVersion);
  if (gccVersion.exitCode === 0 && /^\d+(?:\.\d+){1,3}$/.test(gccVersionText)) {
    const targetResult = await runProbe(executable, ['-dumpmachine'], buildDir, deadlineAt, 'GCC target probe');
    if (targetResult.exitCode !== 0) warnings.push(`GCC target probe exited ${targetResult.exitCode}.`);
    return {
      source, path: executable, family: 'gcc', version: gccVersionText,
      target: targetResult.exitCode === 0 ? firstLine(targetResult) || null : null,
      queryDriverEligible, warnings,
    };
  }
  if (versionResult.exitCode !== 0) warnings.push(`Compiler --version exited ${versionResult.exitCode}.`);
  warnings.push('Compiler family could not be classified by bounded standard probes.');
  return { source, path: executable, family: 'unknown', version: firstLine(versionResult) || null, target: null, queryDriverEligible: false, warnings };
}
async function profileNamedTool(
  raw: unknown,
  expectedName: 'cmake' | 'ninja',
  repositoryRoot: string,
  buildDir: string,
  deadlineAt: number,
): Promise<{ path: string | null; version: string | null; warning?: string }> {
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) return { path: null, version: null };
  const resolved = await canonicalExternalExecutable(raw, repositoryRoot, buildDir, deadlineAt);
  if (!resolved.path || !resolved.probeAllowed) return { path: resolved.path, version: null, warning: resolved.warning };
  const basename = path.basename(resolved.path).toLowerCase().replace(/\.exe$/, '');
  if (basename !== expectedName) return { path: resolved.path, version: null, warning: `Expected ${expectedName}, got ${basename}.` };
  let result: BoundedSubprocessResult;
  try {
    result = await runProbe(resolved.path, ['--version'], buildDir, deadlineAt, `${expectedName} version probe`);
  } catch (error) {
    return { path: resolved.path, version: null, warning: error instanceof Error ? error.message : String(error) };
  }
  const text = `${result.stdout}\n${result.stderr}`;
  const pattern = expectedName === 'cmake' ? /cmake version\s+(\d+(?:\.\d+){1,3})/i : /(\d+(?:\.\d+){1,3})/;
  return {
    path: resolved.path,
    version: text.match(pattern)?.[1] ?? null,
    ...(result.exitCode !== 0 ? { warning: `${expectedName} --version exited ${result.exitCode}.` } : {}),
  };
}

function moduleCompilerSupport(compiler: CompilerProfile): boolean | null {
  switch (compiler.family) {
    case 'gcc': return versionAtLeast(compiler.version, [14, 0, 0]);
    case 'clang': return versionAtLeast(compiler.version, [16, 0, 0]);
    case 'clang-cl': return versionAtLeast(compiler.version, [19, 1, 0]);
    case 'msvc': return versionAtLeast(compiler.version, [19, 34, 0]);
    default: return null;
  }
}

function importStdCompilerSupport(compiler: CompilerProfile): boolean | null {
  switch (compiler.family) {
    case 'gcc': return versionAtLeast(compiler.version, [15, 0, 0]);
    case 'clang': return versionAtLeast(compiler.version, [18, 1, 2]);
    case 'msvc': return versionAtLeast(compiler.version, [19, 36, 0]);
    case 'clang-cl': return null;
    default: return null;
  }
}

function generatorModuleSupport(generator: string | null, ninjaVersion: string | null): boolean | null {
  if (!generator) return null;
  if (generator === 'Ninja' || generator === 'Ninja Multi-Config') {
    return versionAtLeast(ninjaVersion, [1, 11, 0]);
  }
  if (generator === 'Visual Studio 17 2022' || generator === 'Visual Studio 18 2026') return true;
  return false;
}

function capabilityStatus(parts: Array<boolean | null>): 'supported' | 'unsupported' | 'unknown' {
  if (parts.includes(false)) return 'unsupported';
  if (parts.every((value) => value === true)) return 'supported';
  return 'unknown';
}

function fingerprint(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function assertArguments(args: Record<string, unknown>): void {
  const allowed = new Set(['root', 'buildDir', 'configuration']);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`cpp_toolchain_profile received unsupported argument(s): ${unknown.join(', ')}.`);
  if (typeof args.root !== 'string' || !args.root.trim()) throw new Error('cpp_toolchain_profile.root is required.');
  if (args.configuration !== undefined && (typeof args.configuration !== 'string' || !args.configuration.trim())) {
    throw new Error('cpp_toolchain_profile.configuration must be a non-empty string.');
  }
}
export async function callCppToolchainProfileAcceleratorTool(
  args: Record<string, unknown>, timeoutMs = 30_000, metadataSnapshot?: BuildMetadataSnapshot,
) {
  assertArguments(args);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`cpp_toolchain_profile timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  const deadlineAt = Date.now() + timeoutMs;
  const metadata = metadataSnapshot ?? await callBuildMetadataAcceleratorTool({
    root: args.root,
    buildDir: args.buildDir,
    configuration: args.configuration,
    maxEntries: 500,
    maxTargets: 1,
  }, remaining(deadlineAt, MAX_OPERATION_TIMEOUT_MS));
  const repositoryRoot = path.resolve(metadata.repositoryRoot);
  const buildDir = path.resolve(metadata.buildDir);
  const compileDatabase = recordValue(metadata.compileDatabase) ?? {};
  const cache = recordValue(metadata.cmakeCache) ?? {};
  const cacheValues = recordValue(cache.values) ?? {};
  const compilerCounts = recordValue(compileDatabase.compilerCounts) ?? {};
  const standardCounts = recordValue(compileDatabase.standardCounts) ?? {};
  const matchedEntries = Array.isArray(compileDatabase.matchedEntries) ? compileDatabase.matchedEntries : [];
  const entryDirectories = new Map<string, string>();
  for (const raw of matchedEntries) {
    const entry = recordValue(raw);
    if (typeof entry?.compiler === 'string' && typeof entry.directory === 'string' && !entryDirectories.has(entry.compiler)) {
      entryDirectories.set(entry.compiler, entry.directory);
    }
  }
  const cachePaths = cacheCompilerPaths(cacheValues);
  const compilerTokens = [...new Set([
    ...Object.keys(compilerCounts),
    ...cachePaths,
  ])].filter((value) => value && value !== '<command-string>');
  const compilers: CompilerProfile[] = [];
  const seenCompilerCandidates = new Set<string>();
  for (const token of compilerTokens) {
    const candidate = resolveCompilerCandidate(token, entryDirectories, cachePaths, buildDir);
    const candidateKey = candidate
      ? `resolved:${pathIdentity(candidate)}`
      : `unresolved:${process.platform === 'win32' ? token.toLowerCase() : token}`;
    if (seenCompilerCandidates.has(candidateKey)) continue;
    if (seenCompilerCandidates.size >= MAX_COMPILERS) break;
    seenCompilerCandidates.add(candidateKey);
    try {
      compilers.push(await profileCompiler(token, candidate, repositoryRoot, buildDir, deadlineAt));
    } catch (error) {
      compilers.push({
        source: token,
        path: candidate ? slash(candidate) : null,
        family: 'unknown', version: null, target: null, queryDriverEligible: false,
        warnings: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  const generator = typeof cacheValues.CMAKE_GENERATOR === 'string' ? cacheValues.CMAKE_GENERATOR : null;
  const [cmake, ninja] = await Promise.all([
    profileNamedTool(cacheValues.CMAKE_COMMAND, 'cmake', repositoryRoot, buildDir, deadlineAt),
    generator?.startsWith('Ninja')
      ? profileNamedTool(cacheValues.CMAKE_MAKE_PROGRAM, 'ninja', repositoryRoot, buildDir, deadlineAt)
      : Promise.resolve({ path: null, version: null, warning: undefined as string | undefined }),
  ]);
  const cxxCache = typeof cacheValues.CMAKE_CXX_COMPILER === 'string' ? cacheValues.CMAKE_CXX_COMPILER : null;
  const cxxCanonical = cxxCache && path.isAbsolute(cxxCache)
    ? slash(await fs.realpath(cxxCache).catch(() => cxxCache))
    : null;
  const canonicalCxxIdentity = cxxCanonical ? pathIdentity(cxxCanonical) : null;
  const knownCompilers = compilers.filter((compiler) => compiler.family !== 'unknown');
  const hasCxxStandard = Object.keys(standardCounts).some((standard) => /(?:^|-)std=(?:gnu\+\+|c\+\+)/.test(standard));
  const primaryCxx = compilers.find((compiler) => compiler.path && canonicalCxxIdentity && pathIdentity(compiler.path) === canonicalCxxIdentity)
    ?? (hasCxxStandard && knownCompilers.length === 1 ? knownCompilers[0] : null);
  const cmakeModules = versionAtLeast(cmake.version, [3, 28, 0]);
  const generatorModules = generatorModuleSupport(generator, ninja.version);
  let compilerModules = primaryCxx ? moduleCompilerSupport(primaryCxx) : null;
  if (primaryCxx?.family === 'clang-cl' && generator?.startsWith('Visual Studio ')) {
    // CMake 4.4 documents clang-cl module scanning as unsupported with VS generators.
    compilerModules = false;
  }
  const moduleScanningStatus = capabilityStatus([cmakeModules, generatorModules, compilerModules]);
  const importStdStatus = capabilityStatus([
    versionAtLeast(cmake.version, [3, 30, 0]),
    generator?.startsWith('Ninja') ? generatorModules : false,
    primaryCxx ? importStdCompilerSupport(primaryCxx) : null,
  ]);
  const compilationDatabasePath = typeof compileDatabase.path === 'string' && compileDatabase.found === true
    ? slash(path.dirname(compileDatabase.path)) : null;
  const queryDrivers = [...new Set(compilers
    .filter((compiler) => compiler.queryDriverEligible && compiler.path)
    .map((compiler) => compiler.path!))].sort();
  // clangd executes exact query drivers as subprocesses for system include
  // extraction. Preserve the driver runtime environment without copying a full
  // build shell: only prepend directories owning already-validated drivers.
  const runtimePathEntries = [...new Map(queryDrivers.map((driver) => {
    const directory = slash(path.dirname(driver));
    return [pathIdentity(directory), directory] as const;
  })).values()].sort();
  const snapshotValidation = metadataSnapshot
    ? null
    : await revalidateBuildMetadataSnapshot(metadata, remaining(deadlineAt, 5_000));
  const snapshotCurrent = snapshotValidation?.current ?? true;
  const profileWarnings = [cmake.warning, ninja.warning, ...compilers.flatMap((compiler) => compiler.warnings)].filter(Boolean) as string[];
  if (!snapshotCurrent) {
    profileWarnings.push(`Build metadata changed during toolchain profiling: ${snapshotValidation!.changed.join(', ')}. Refresh before semantic handoff.`);
  }

  const evidence = {
    compileDatabase: typeof compileDatabase.sha256 === 'string' ? compileDatabase.sha256 : null,
    cmakeCache: typeof cache.sha256 === 'string' ? cache.sha256 : null,
    cmakeVersion: cmake.version,
    ninjaVersion: ninja.version,
    compilerProfiles: compilers.map(({ source, path: compilerPath, family, version, target }) => ({ source, path: compilerPath, family, version, target })),
  };

  return {
    repositoryRoot: slash(repositoryRoot),
    buildDir: slash(buildDir),
    generator,
    configuration: args.configuration ?? (typeof cacheValues.CMAKE_BUILD_TYPE === 'string' ? cacheValues.CMAKE_BUILD_TYPE : null),
    compilerCounts,
    standardCounts,
    compilers,
    tools: { cmake, ninja },
    capabilities: {
      cxxModules: {
        status: moduleScanningStatus,
        minimums: { cmake: '3.28', ninja: '1.11', gcc: '14', clang: '16', clangCl: '19.1', msvcCompiler: '19.34' },
        headerUnitsSupportedByCMake: false,
      },
      importStd: {
        status: importStdStatus,
        minimums: { cmake: '3.30', gcc: '15', clang: '18.1.2', msvcCompiler: '19.36' },
        experimentalGateRequired: true,
        ninjaGeneratorRequired: true,
      },
    },
    serenaHandoff: {
      compilationDatabasePath,
      queryDrivers,
      runtimePathEntries,
      ready: Boolean(compilationDatabasePath && queryDrivers.length > 0 && runtimePathEntries.length > 0 && snapshotCurrent),
      requiresLanguageServerRestartIfProfileChanges: true,
    },
    snapshotValidation,
    profileFingerprint: fingerprint({ ...evidence, snapshotCurrent }),
    evidence,
    warnings: profileWarnings,
  };
}

export const CPP_TOOLCHAIN_PROFILE_ACCELERATOR_TOOL = {
  name: 'cpp_toolchain_profile',
  purpose: 'Derive a bounded C/C++ toolchain and capability profile from authoritative build metadata without configuring or building.',
  when_to_use: 'Before clangd/Serena handoff or C++20/23 module-capability decisions when compiler family/version/target matters.',
  when_not_to_use: 'As a build system or compiler installer; use build_metadata for raw compile facts and cpp_build_plan for execution.',
  readOnly: true,
  mutating: false,
  inputSchema: {
    type: 'object',
    required: ['root'],
    additionalProperties: false,
    properties: {
      root: { type: 'string', description: 'Project/repository root.' },
      buildDir: { type: 'string', description: 'Optional configured build directory; otherwise build_metadata performs bounded discovery.' },
      configuration: { type: 'string', description: 'Optional build configuration.' },
    },
  },
  recommended_workflow: [
    'Call after workspace_delta when the build profile may have changed.',
    'Use serenaHandoff.compilationDatabasePath directly; do not copy compile_commands.json into the repository.',
    'Allow clangd query-driver only for the exact queryDrivers returned by this tool.',
    'Prepend only serenaHandoff.runtimePathEntries to the Serena process PATH so validated compiler drivers can launch their own runtime helpers.',
    'Treat unknown/unsupported capability status conservatively instead of changing the project toolchain.',
  ],
  related_capabilities: [
    'build_metadata',
    'cpp_build_impact',
    'cpp_build_plan',
    'clangd compilationDatabasePath',
    'clangd --query-driver',
    'CMake C++ modules',
  ],
};
