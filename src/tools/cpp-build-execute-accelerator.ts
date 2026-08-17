import fs from 'fs/promises';
import path from 'path';

import { callBuildMetadataAcceleratorTool, discoverConfiguredCmakeTrees } from './build-metadata-accelerator.js';
import { callCppBuildContextAcceleratorTool } from './cpp-build-context-accelerator.js';
import { collectCmakePresetDependencies, type PresetFingerprint } from './cpp-build-plan-accelerator.js';
import { cppBuildImpactPathSupported } from './cpp-build-impact-accelerator.js';
import { validatePath } from './filesystem.js';
import { PROCESS_WAIT_DEFAULT_MS, PROCESS_WAIT_MAX_MS } from '../utils/process-wait-contract.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import type { CancellationCause } from '../utils/cancellation.js';

const MAX_CHANGED_FILES = 100;
const MAX_EXPLICIT_ITEMS = 50;
const MAX_PARALLELISM = 256;
const MAX_DIAGNOSTICS = 50;
const DIAGNOSTIC_SCAN_LINES = 20_000;
const DIAGNOSTIC_SCAN_CHARS = 2 * 1024 * 1024;
const OUTPUT_TAIL_CHARS = 64 * 1024;
const OUTPUT_TAIL_LINES = 200;
const LAUNCH_OBSERVE_MS = 1_000;
const PROCESS_CLEANUP_WAIT_MS = 3_000;
const CONFIGURE_GATE_NAME = '.desktop-commander-cmake-configure-owner';

type BuildOperation = 'build' | 'test' | 'build_and_test';
type ConfigureMode = 'never' | 'if_missing';
type StageName = 'configure' | 'build' | 'test';
type Parallelism = number | 'project';

type JsonRecord = Record<string, unknown>;
export type CppBuildDiagnostic = {
  file: string | null;
  line: number | null;
  column: number | null;
  severity: 'error' | 'warning';
  message: string;
  tool: string;
  stage: StageName;
};

type ProcessPage = {
  lines: string[];
  totalLines: number;
  readFrom: number;
  readCount: number;
  remaining: number;
  isComplete: boolean;
  exitCode?: number | null;
};

type StartResult = {
  isError?: boolean;
  content?: unknown[];
  structuredContent?: unknown;
};

type WaitResult = JsonRecord & {
  completed?: boolean;
  timedOut?: boolean;
  terminalFailed?: boolean;
  processSucceeded?: boolean;
  exitCode?: number | null;
  runtimeMs?: number;
  tail?: string;
};
export type CppBuildExecuteDependencies = {
  startProcess: (args: JsonRecord) => Promise<StartResult>;
  waitProcess: (args: JsonRecord) => Promise<WaitResult>;
  readProcessOutputPage: (pid: number, offset: number, length: number) => ProcessPage | null;
  terminateProcess: (pid: number, cause: CancellationCause, detail?: string) => Promise<boolean>;
  acquireMutationLocks: (
    resources: string[], deadlineAt: number, resourceMode?: 'exclusive' | 'shared',
  ) => Promise<() => Promise<void>>;
};

type ParsedArgs = {
  root: string;
  buildDir?: string;
  buildDirSource?: 'explicit' | 'discovered' | 'configure-preset';
  operation: BuildOperation;
  changedFiles: string[];
  unsupportedChangedFiles: string[];
  targets: string[];
  tests: string[];
  configuration?: string;
  buildPreset?: string;
  testPreset?: string;
  configurePreset?: string;
  configureMode: ConfigureMode;
  useAffectedTargets: boolean;
  useAffectedTests: boolean;
  includeTests: boolean;
  timeoutMs: number;
  parallelism: Parallelism;
};

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}
function boundedToken(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty single-line string up to ${maxLength} characters.`);
  }
  return value;
}

function stringArray(value: unknown, label: string, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} strings when provided.`);
  }
  return [...new Set(value.map((item, index) => boundedToken(item, `${label}[${index}]`, 1024)))];
}

function parseParallelism(value: unknown): Parallelism {
  if (value === undefined || value === 'project') return 'project';
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_PARALLELISM) {
    throw new Error(`cpp_build_execute.parallelism must be 'project' or an integer from 1 to ${MAX_PARALLELISM}.`);
  }
  return value as number;
}

function parseArgs(args: JsonRecord): ParsedArgs {
  const allowed = new Set([
    'root', 'buildDir', 'operation', 'changedFiles', 'targets', 'tests', 'configuration',
    'preset', 'buildPreset', 'testPreset', 'configurePreset', 'configureMode',
    'useAffectedTargets', 'useAffectedTests', 'includeTests', 'timeoutMs', 'parallelism',
  ]);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`cpp_build_execute received unsupported argument(s): ${unknown.join(', ')}.`);
  const root = boundedToken(args.root, 'cpp_build_execute.root', 4096);
  const buildDir = args.buildDir === undefined
    ? undefined : boundedToken(args.buildDir, 'cpp_build_execute.buildDir', 4096);
  const operation = args.operation;
  if (operation !== 'build' && operation !== 'test' && operation !== 'build_and_test') {
    throw new Error("cpp_build_execute.operation must be 'build', 'test', or 'build_and_test'.");
  }
  const changedFiles = stringArray(args.changedFiles, 'cpp_build_execute.changedFiles', MAX_CHANGED_FILES);
  const targets = stringArray(args.targets, 'cpp_build_execute.targets', MAX_EXPLICIT_ITEMS);
  const tests = stringArray(args.tests, 'cpp_build_execute.tests', MAX_EXPLICIT_ITEMS);
  if (operation === 'test' && targets.length > 0) throw new Error('cpp_build_execute.targets is not valid for test-only execution.');
  if (operation === 'build' && tests.length > 0) throw new Error('cpp_build_execute.tests is not valid for build-only execution.');

  const preset = args.preset === undefined ? undefined : boundedToken(args.preset, 'cpp_build_execute.preset');
  const explicitBuildPreset = args.buildPreset === undefined ? undefined : boundedToken(args.buildPreset, 'cpp_build_execute.buildPreset');
  const explicitTestPreset = args.testPreset === undefined ? undefined : boundedToken(args.testPreset, 'cpp_build_execute.testPreset');
  if (preset && (explicitBuildPreset || explicitTestPreset)) {
    throw new Error('cpp_build_execute.preset cannot be combined with buildPreset/testPreset.');
  }
  const buildPreset = explicitBuildPreset ?? preset;
  const testPreset = explicitTestPreset ?? preset;
  if (operation === 'build' && explicitTestPreset) throw new Error('cpp_build_execute.testPreset is not valid for build-only execution.');
  if (operation === 'test' && explicitBuildPreset) throw new Error('cpp_build_execute.buildPreset is not valid for test-only execution.');
  const configureMode = args.configureMode === undefined ? 'never' : args.configureMode;
  if (configureMode !== 'never' && configureMode !== 'if_missing') {
    throw new Error("cpp_build_execute.configureMode must be 'never' or 'if_missing'.");
  }
  const configurePreset = args.configurePreset === undefined
    ? undefined : boundedToken(args.configurePreset, 'cpp_build_execute.configurePreset');
  if (configureMode === 'if_missing' && !configurePreset) {
    throw new Error('cpp_build_execute.configurePreset is required when configureMode=if_missing.');
  }
  if (configureMode === 'never' && configurePreset) {
    throw new Error('cpp_build_execute.configurePreset requires configureMode=if_missing.');
  }
  const configuration = args.configuration === undefined
    ? undefined : boundedToken(args.configuration, 'cpp_build_execute.configuration', 128);
  const timeoutMs = args.timeoutMs === undefined ? PROCESS_WAIT_DEFAULT_MS : Number(args.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > PROCESS_WAIT_MAX_MS) {
    throw new Error(`cpp_build_execute.timeoutMs must be an integer from 1000 to ${PROCESS_WAIT_MAX_MS}.`);
  }
  for (const key of ['useAffectedTargets', 'useAffectedTests', 'includeTests'] as const) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`cpp_build_execute.${key} must be boolean.`);
  }
  return {
    root, buildDir, buildDirSource: buildDir ? 'explicit' : undefined, operation, changedFiles,
    unsupportedChangedFiles: changedFiles.filter((file) => !cppBuildImpactPathSupported(file)),
    targets, tests, configuration, buildPreset, testPreset, configurePreset, configureMode,
    useAffectedTargets: args.useAffectedTargets !== false,
    useAffectedTests: args.useAffectedTests !== false,
    includeTests: args.includeTests !== false,
    timeoutMs, parallelism: parseParallelism(args.parallelism),
  };
}
function requireBuildDir(parsed: ParsedArgs): string {
  if (!parsed.buildDir) throw new Error('CPP_BUILD_DIR_UNRESOLVED: no configured CMake tree has been selected.');
  return parsed.buildDir;
}

function remaining(deadlineAt: number, label: string): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error(`${label} deadline exceeded.`) as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function configuredTreeExists(root: string, buildDir: string, deadlineAt: number): Promise<boolean> {
  const absoluteBuildDir = path.isAbsolute(buildDir) ? path.resolve(buildDir) : path.resolve(root, buildDir);
  try {
    const [dir, cache] = await Promise.all([
      runWithAbortableTimeout(
        (_signal) => fs.stat(absoluteBuildDir), remaining(deadlineAt, 'configured build directory stat'),
        `Stat configured build directory ${absoluteBuildDir}`,
      ),
      runWithAbortableTimeout(
        (_signal) => fs.stat(path.join(absoluteBuildDir, 'CMakeCache.txt')), remaining(deadlineAt, 'CMake cache stat'),
        `Stat configured CMake cache ${path.join(absoluteBuildDir, 'CMakeCache.txt')}`,
      ),
    ]);
    return dir.isDirectory() && cache.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

async function resolveHostCmakeExecutable(root: string, deadlineAt: number): Promise<string> {
  const searchPath = process.env.PATH ?? '';
  const executableNames = process.platform === 'win32' ? ['cmake.exe'] : ['cmake'];
  for (const rawDirectory of searchPath.split(path.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '');
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const executableName of executableNames) {
      const lexical = path.join(directory, executableName);
      try {
        const canonical = await runWithAbortableTimeout(
          (_signal) => fs.realpath(lexical), remaining(deadlineAt, 'host CMake resolution'),
          `Resolve host CMake executable ${lexical}`,
        );
        if (isInside(root, canonical)) continue;
        const stats = await runWithAbortableTimeout(
          (_signal) => fs.stat(canonical), remaining(deadlineAt, 'host CMake stat'),
          `Stat host CMake executable ${canonical}`,
        );
        if (stats.isFile()) return canonical;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        throw error;
      }
    }
  }
  throw new Error('CPP_CMAKE_EXECUTABLE_UNRESOLVED: no external cmake executable was found in absolute PATH entries.');
}

function textFromStartResult(result: StartResult): string {
  return (result.content ?? []).map((item) => {
    const record = recordValue(item);
    return typeof record?.text === 'string' ? record.text : '';
  }).filter(Boolean).join('\n');
}

function stripControl(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x07/g, '');
}

function diagnosticToolForCompiler(hint: string | null): string {
  const normalized = (hint ?? '').toLowerCase();
  if (normalized.includes('clang')) return 'clang';
  if (normalized.includes('gcc') || normalized.includes('gnu')) return 'gcc';
  if (normalized.includes('msvc') || normalized.includes('visual')) return 'msvc';
  return 'gcc/clang';
}

function createDiagnostic(
  stage: StageName, tool: string, severity: 'error' | 'warning', message: string,
  file: string | null = null, line: number | null = null, column: number | null = null,
): CppBuildDiagnostic {
  return { file, line, column, severity, message: message.trim(), tool, stage };
}

function parseDiagnosticLine(rawLine: string, stage: StageName, compilerHint: string | null): CppBuildDiagnostic | null {
  const lineText = stripControl(rawLine).trimEnd();
  let match = lineText.match(/^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning):\s*(.+)$/i);
  if (match) return createDiagnostic(
    stage, diagnosticToolForCompiler(compilerHint), /warning/i.test(match[4]) ? 'warning' : 'error',
    match[5], match[1], Number(match[2]), match[3] ? Number(match[3]) : null,
  );

  match = lineText.match(/^(.+?)\((\d+)(?:,(\d+))?\)\s*:?\s*(fatal error|error|warning)\s*(?:[A-Z]+\d+\s*:)?\s*(.+)$/i);
  if (match) return createDiagnostic(
    stage, 'msvc', /warning/i.test(match[4]) ? 'warning' : 'error',
    match[5], match[1], Number(match[2]), match[3] ? Number(match[3]) : null,
  );
  match = lineText.match(/^CMake\s+(Error|Warning)(?:\s+at\s+(.+?):(\d+)(?:\s+\([^)]+\))?)?:\s*(.*)$/i);
  if (match) return createDiagnostic(
    stage, 'cmake', match[1].toLowerCase() === 'warning' ? 'warning' : 'error',
    match[4] || lineText, match[2] || null, match[3] ? Number(match[3]) : null, null,
  );

  match = lineText.match(/^ninja:\s*(error|warning):\s*(.+)$/i);
  if (match) return createDiagnostic(stage, 'ninja', match[1].toLowerCase() === 'warning' ? 'warning' : 'error', match[2]);
  match = lineText.match(/^FAILED:\s*(.+)$/);
  if (match) return createDiagnostic(stage, 'ninja', 'error', `Failed build rule: ${match[1]}`);

  match = lineText.match(/^\s*\d+\/\d+\s+Test\s+#\d+:\s+(.+?)\s+\.{2,}\*{3}Failed\b/i);
  if (match) return createDiagnostic(stage, 'ctest', 'error', `Test failed: ${match[1].trim()}`);
  match = lineText.match(/^\s*\d+\s*-\s*(.+?)\s+\(Failed\)\s*$/i);
  if (match) return createDiagnostic(stage, 'ctest', 'error', `Test failed: ${match[1].trim()}`);
  if (/^Errors while running CTest/i.test(lineText)) return createDiagnostic(stage, 'ctest', 'error', lineText.trim());
  if (/^No tests were found/i.test(lineText)) return createDiagnostic(stage, 'ctest', 'error', lineText.trim());
  if (lineText.startsWith('RegularExpression::compile(): Error')) return createDiagnostic(stage, 'ctest', 'error', lineText.trim());

  match = lineText.match(/^LINK\s*:\s*(fatal error|error|warning)\s+([A-Z]+\d+)?\s*:?\s*(.+)$/i);
  if (match) return createDiagnostic(stage, 'link', /warning/i.test(match[1]) ? 'warning' : 'error', match[3]);
  match = lineText.match(/^collect2:\s*(error|warning):\s*(.+)$/i);
  if (match) return createDiagnostic(stage, 'link', match[1].toLowerCase() === 'warning' ? 'warning' : 'error', match[2]);
  return null;
}

export function normalizeCppBuildDiagnostics(
  lines: string[], stage: StageName = 'build', compilerHint: string | null = null,
): CppBuildDiagnostic[] {
  const diagnostics: CppBuildDiagnostic[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const diagnostic = parseDiagnosticLine(line, stage, compilerHint);
    if (!diagnostic) continue;
    const identity = JSON.stringify(diagnostic);
    if (seen.has(identity)) continue;
    seen.add(identity);
    diagnostics.push(diagnostic);
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
  }
  return diagnostics;
}

function scanDiagnostics(
  deps: CppBuildExecuteDependencies, pid: number, stage: StageName, compilerHint: string | null,
): CppBuildDiagnostic[] {
  const last = deps.readProcessOutputPage(pid, -1, 1);
  if (!last || last.totalLines <= 0) return [];
  const totalLines = Math.min(last.totalLines, DIAGNOSTIC_SCAN_LINES);
  let offset = -totalLines;
  let consumedLines = 0;
  let consumedChars = 0;
  const diagnostics: CppBuildDiagnostic[] = [];
  const seen = new Set<string>();
  while (consumedLines < totalLines && consumedChars < DIAGNOSTIC_SCAN_CHARS && diagnostics.length < MAX_DIAGNOSTICS) {
    const pageSize = Math.min(250, totalLines - consumedLines);
    const page = deps.readProcessOutputPage(pid, offset, pageSize);
    if (!page || page.readCount === 0) break;
    for (const line of page.lines) {
      consumedChars += line.length;
      if (consumedChars > DIAGNOSTIC_SCAN_CHARS) break;
      const diagnostic = parseDiagnosticLine(line, stage, compilerHint);
      if (!diagnostic) continue;
      const identity = JSON.stringify(diagnostic);
      if (seen.has(identity)) continue;
      seen.add(identity);
      diagnostics.push(diagnostic);
      if (diagnostics.length >= MAX_DIAGNOSTICS) break;
    }
    consumedLines += page.readCount;
    offset = page.readFrom + page.readCount;
  }
  return diagnostics;
}

function boundedTail(value: unknown): string {
  const text = typeof value === 'string' ? stripControl(value) : '';
  return text.length <= OUTPUT_TAIL_CHARS ? text : text.slice(text.length - OUTPUT_TAIL_CHARS);
}
function compilerHint(context: JsonRecord): string | null {
  const profile = recordValue(context.profile);
  const compilers = Array.isArray(profile?.compilers) ? profile!.compilers as unknown[] : [];
  for (const raw of compilers) {
    const compiler = recordValue(raw);
    if (typeof compiler?.family === 'string') return compiler.family;
  }
  return null;
}

function planProcess(context: JsonRecord): JsonRecord {
  const plan = recordValue(context.plan);
  const processSpec = recordValue(plan?.process);
  if (!plan || !processSpec || typeof processSpec.executable !== 'string' || !Array.isArray(processSpec.args)) {
    throw new Error('cpp_build_execute received no executable process plan from cpp_build_context.');
  }
  return processSpec;
}

function selectedNames(context: JsonRecord, key: 'targets' | 'tests'): string[] {
  const plan = recordValue(context.plan);
  const value = plan?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function executeContextPlan(
  stage: StageName, context: JsonRecord, deps: CppBuildExecuteDependencies, deadlineAt: number,
) {
  const processSpec = planProcess(context);
  const launchBudget = Math.max(100, Math.min(LAUNCH_OBSERVE_MS, remaining(deadlineAt, `${stage} launch`)));
  const start = await deps.startProcess({
    ...processSpec,
    execution_kind: 'finite',
    pty: 'never',
    timeout_ms: launchBudget,
  });
  const startStructured = recordValue(start.structuredContent);
  const pid = Number(startStructured?.pid);
  if (!Number.isInteger(pid) || pid < 1 || start.isError) {
    const message = textFromStartResult(start) || `${stage} process did not return a valid PID.`;
    return {
      stage: { executed: false, pid: null, succeeded: false, completed: false, timedOut: false, exitCode: null, durationMs: 0 },
      diagnostics: [createDiagnostic(stage, stage === 'test' ? 'ctest' : 'cmake', 'error', message)],
      outputTail: boundedTail(message),
    };
  }

  const waitBudget = Math.max(0, remaining(deadlineAt, `${stage} wait`));
  let wait = await deps.waitProcess({
    pid,
    timeout_ms: Math.min(PROCESS_WAIT_MAX_MS, waitBudget),
    stall_timeout_ms: 0,
    tail_lines: OUTPUT_TAIL_LINES,
  });
  const timedOut = wait.timedOut === true;
  const incompleteTerminalFailure = wait.terminalFailed === true && wait.completed !== true;
  let terminationAttempted = false;
  let terminationConfirmed: boolean | null = null;
  if ((timedOut || incompleteTerminalFailure) && wait.completed !== true) {
    terminationAttempted = true;
    const cause: CancellationCause = timedOut ? 'deadline_exceeded' : 'ownership_lost';
    const detail = `cpp_build_execute ${stage} ${timedOut ? 'deadline expired' : 'lost terminal ownership'}; terminating request-owned process tree before releasing build ownership.`;
    const terminationStarted = await deps.terminateProcess(pid, cause, detail);
    const cleanup = await deps.waitProcess({
      pid, timeout_ms: PROCESS_CLEANUP_WAIT_MS, stall_timeout_ms: 0, tail_lines: OUTPUT_TAIL_LINES,
    });
    terminationConfirmed = cleanup.completed === true;
    wait = { ...cleanup, timedOut, terminalFailed: wait.terminalFailed === true || cleanup.terminalFailed === true };
    if (!terminationStarted && !terminationConfirmed) {
      wait = { ...wait, terminalFailed: true };
    }
  }
  const diagnostics = scanDiagnostics(deps, pid, stage, compilerHint(context));
  if (terminationAttempted && terminationConfirmed === false) {
    diagnostics.unshift(createDiagnostic(
      stage, 'cpp_build_execute', 'error',
      `Process ${pid} did not confirm termination before cpp_build_execute released its execution slice.`,
    ));
  }
  const succeeded = wait.completed === true && wait.processSucceeded === true && wait.exitCode === 0 && !timedOut;
  return {
    stage: {
      executed: true,
      pid,
      targets: selectedNames(context, 'targets'),
      tests: selectedNames(context, 'tests'),
      durationMs: typeof wait.runtimeMs === 'number' ? wait.runtimeMs : null,
      succeeded,
      completed: wait.completed === true,
      timedOut,
      exitCode: typeof wait.exitCode === 'number' ? wait.exitCode : null,
      terminationAttempted,
      terminationConfirmed,
    },
    diagnostics,
    outputTail: boundedTail(wait.tail),
  };
}
function contextMetadataIdentity(context: JsonRecord): string {
  const metadata = recordValue(context.metadata) ?? {};
  const compileDatabase = recordValue(metadata.compileDatabase) ?? {};
  const cmake = recordValue(metadata.cmake) ?? {};
  const cmakeCache = recordValue(metadata.cmakeCache) ?? {};
  return JSON.stringify([
    compileDatabase.sha256 ?? null,
    cmake.codemodelSha256 ?? null,
    cmakeCache.sha256 ?? null,
  ]);
}

function snapshotMetadataIdentity(metadata: JsonRecord): string {
  const compileDatabase = recordValue(metadata.compileDatabase) ?? {};
  const cmake = recordValue(metadata.cmake) ?? {};
  const codemodel = recordValue(cmake.codemodel) ?? {};
  const cmakeCache = recordValue(metadata.cmakeCache) ?? {};
  return JSON.stringify([
    compileDatabase.sha256 ?? null,
    codemodel.sha256 ?? null,
    cmakeCache.sha256 ?? null,
  ]);
}

async function metadataStillFresh(context: JsonRecord, parsed: ParsedArgs, deadlineAt: number): Promise<boolean | null> {
  const budget = deadlineAt - Date.now();
  if (budget < 250) return null;
  try {
    const metadata = await callBuildMetadataAcceleratorTool({
      root: parsed.root,
      buildDir: requireBuildDir(parsed),
      configuration: parsed.configuration,
      includeArguments: false,
      maxEntries: 1,
      maxTargets: 1,
    }, Math.min(45_000, budget));
    return contextMetadataIdentity(context) === snapshotMetadataIdentity(metadata as JsonRecord);
  } catch {
    return null;
  }
}
function stageContextArgs(parsed: ParsedArgs, stage: 'build' | 'test'): JsonRecord {
  const supportedChangedFiles = parsed.changedFiles.filter(cppBuildImpactPathSupported);
  const forceConservative = parsed.unsupportedChangedFiles.length > 0;
  const args: JsonRecord = {
    root: parsed.root,
    buildDir: requireBuildDir(parsed),
    configuration: parsed.configuration,
    changedFiles: supportedChangedFiles.length > 0 ? supportedChangedFiles : undefined,
    includeTests: stage === 'test' ? true : parsed.includeTests,
    includeProfile: true,
    operation: stage,
    parallelism: parsed.parallelism,
  };
  if (stage === 'build') {
    args.preset = parsed.buildPreset;
    args.targets = parsed.targets.length > 0 ? parsed.targets : undefined;
    args.useAffectedTargets = parsed.targets.length === 0 && parsed.useAffectedTargets && !forceConservative;
  } else {
    args.preset = parsed.testPreset;
    args.tests = parsed.tests.length > 0 ? parsed.tests : undefined;
    args.useAffectedTests = parsed.tests.length === 0 && parsed.useAffectedTests && !forceConservative;
    args.outputOnFailure = true;
    args.noTestsError = true;
  }
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

function stageImpact(context: JsonRecord | null, parsed: ParsedArgs) {
  if (!context) return null;
  const orchestration = recordValue(context.orchestration) ?? {};
  const impact = recordValue(context.impact);
  const selection = typeof orchestration.planSelection === 'string' ? orchestration.planSelection : 'default-operation';
  const mode = selection.startsWith('explicit-') ? 'explicit' : selection.startsWith('affected-') ? 'focused' : 'full';
  const reasons = [...parsed.unsupportedChangedFiles.map((file) => `unsupported-impact-file:${file}`)];
  const incompleteness = Array.isArray(impact?.incompleteness) ? impact!.incompleteness : [];
  const testIncompleteness = Array.isArray(impact?.testIncompleteness) ? impact!.testIncompleteness : [];
  for (const reason of [...incompleteness, ...testIncompleteness]) if (typeof reason === 'string') reasons.push(reason);
  const conservative = parsed.unsupportedChangedFiles.length > 0
    || selection === 'snapshot-changed-default'
    || impact?.selectionComplete === false;
  return { mode, conservative, selection, reasons: [...new Set(reasons)] };
}
type ConfiguredTree = Awaited<ReturnType<typeof discoverConfiguredCmakeTrees>>['trees'][number];
type ConfigureExecutionResult = Awaited<ReturnType<typeof executeContextPlan>>;

async function configuredTrees(parsed: ParsedArgs, deadlineAt: number, label: string): Promise<ConfiguredTree[]> {
  const result = await discoverConfiguredCmakeTrees(
    parsed.root, Math.min(10_000, remaining(deadlineAt, label)),
  );
  return result.trees;
}

async function executeConfigurePreset(
  parsed: ParsedArgs, deps: CppBuildExecuteDependencies, root: string, deadlineAt: number,
): Promise<ConfigureExecutionResult> {
  const presetFile = path.join(root, 'CMakePresets.json');
  let presetStats;
  try {
    presetStats = await runWithAbortableTimeout(
      (_signal) => fs.stat(presetFile), remaining(deadlineAt, 'configure preset stat'),
      `Stat configure preset file ${presetFile}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('CPP_CONFIGURE_PRESET_REQUIRED: project-owned CMakePresets.json is required for configureMode=if_missing.');
    }
    throw error;
  }
  if (!presetStats.isFile()) {
    throw new Error('CPP_CONFIGURE_PRESET_REQUIRED: project-owned CMakePresets.json must be a file.');
  }
  const cmakeExecutable = await resolveHostCmakeExecutable(root, deadlineAt);
  const syntheticContext: JsonRecord = {
    plan: {
      process: {
        executable: cmakeExecutable,
        args: ['--preset', parsed.configurePreset!],
        cwd: root,
        execution_kind: 'finite',
        pty: 'never',
        timeout_ms: parsed.timeoutMs,
      },
      targets: [], tests: [],
    },
  };
  return executeContextPlan('configure', syntheticContext, deps, deadlineAt);
}

function failConfigureResolution(result: ConfigureExecutionResult, message: string): ConfigureExecutionResult {
  result.stage.succeeded = false;
  result.diagnostics.push(createDiagnostic('configure', 'cmake', 'error', message));
  result.outputTail = boundedTail([result.outputTail, message].filter(Boolean).join('\n'));
  return result;
}

async function resolveConfiguredBuildDir(
  parsed: ParsedArgs, deps: CppBuildExecuteDependencies, deadlineAt: number,
): Promise<ConfigureExecutionResult | null> {
  const root = await runWithAbortableTimeout(
    (_signal) => fs.realpath(path.resolve(parsed.root)), remaining(deadlineAt, 'project root resolution'),
    `Resolve cpp_build_execute project root ${parsed.root}`,
  );
  if (parsed.buildDir) {
    const requestedBuildDir = path.isAbsolute(parsed.buildDir) ? path.resolve(parsed.buildDir) : path.resolve(root, parsed.buildDir);
    const buildDir = await validatePath(
      requestedBuildDir, Math.min(10_000, remaining(deadlineAt, 'cpp_build_execute buildDir authority')),
    );
    if (await configuredTreeExists(root, buildDir, deadlineAt)) {
      parsed.buildDir = buildDir;
      parsed.buildDirSource = 'explicit';
      return null;
    }
    if (parsed.configureMode === 'never') {
      throw new Error('CPP_BUILD_NOT_CONFIGURED: explicit buildDir has no CMakeCache.txt and configureMode=never.');
    }
    if (!isInside(root, buildDir)) {
      throw new Error('CPP_CONFIGURE_OUTSIDE_ROOT: automatic configure only permits an explicit buildDir inside root.');
    }
    const existingTrees = await configuredTrees(parsed, deadlineAt, 'pre-configure output safety discovery');
    if (existingTrees.length > 0) {
      throw new Error(
        `CPP_CONFIGURE_OUTPUT_AMBIGUOUS: explicit buildDir is missing but ${existingTrees.length} project-owned configured tree(s) already exist. ` +
        'Without duplicating CMake preset semantics, cpp_build_execute cannot prove configurePreset will not mutate one of them; configure explicitly or pass an existing buildDir.',
      );
    }
    const result = await executeConfigurePreset(parsed, deps, root, deadlineAt);
    if (result.stage.succeeded && !(await configuredTreeExists(root, buildDir, deadlineAt))) {
      return failConfigureResolution(
        result, `Configure preset completed but did not create CMakeCache.txt in requested buildDir: ${buildDir}`,
      );
    }
    if (result.stage.succeeded) {
      parsed.buildDir = buildDir;
      parsed.buildDirSource = 'explicit';
    }
    return result;
  }

  const before = await configuredTrees(parsed, deadlineAt, 'configured tree discovery');
  if (before.length === 1) {
    parsed.buildDir = before[0].buildDir;
    parsed.buildDirSource = 'discovered';
    return null;
  }
  if (before.length > 1) {
    throw new Error(
      `CPP_BUILD_TREE_AMBIGUOUS: discovered ${before.length} configured CMake trees; pass buildDir. configurePreset is not executed against an ambiguous existing output set.`,
    );
  }
  if (parsed.configureMode === 'never') {
    throw new Error('CPP_BUILD_NOT_CONFIGURED: no project-owned CMakeCache.txt was discovered and configureMode=never.');
  }

  const result = await executeConfigurePreset(parsed, deps, root, deadlineAt);
  if (!result.stage.succeeded) return result;
  const after = await configuredTrees(parsed, deadlineAt, 'post-configure tree discovery');
  if (after.length !== 1) {
    return failConfigureResolution(
      result,
      `CPP_BUILD_TREE_AMBIGUOUS_AFTER_CONFIGURE: configure preset succeeded but exactly one project-owned configured tree was expected (${after.length} found). Pass buildDir for this layout.`,
    );
  }
  parsed.buildDir = after[0].buildDir;
  parsed.buildDirSource = 'configure-preset';
  return result;
}
function ensureFailureDiagnostic(
  stage: StageName, result: Awaited<ReturnType<typeof executeContextPlan>>,
): void {
  if (result.stage.succeeded || result.diagnostics.length > 0) return;
  const message = result.stage.timedOut
    ? `${stage} timed out before a final exit status was available.`
    : `${stage} exited with code ${result.stage.exitCode ?? 'unknown'}.`;
  result.diagnostics.push(createDiagnostic(stage, stage === 'test' ? 'ctest' : 'cmake', 'error', message));
}

type StageResult = {
  executed: boolean;
  pid: number | null;
  targets: string[];
  tests: string[];
  durationMs: number | null;
  succeeded: boolean;
  completed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  terminationAttempted: boolean;
  terminationConfirmed: boolean | null;
  buildMetadataFresh: boolean | null;
};

function placeholderStage(): StageResult {
  return {
    executed: false,
    pid: null,
    targets: [] as string[],
    tests: [] as string[],
    durationMs: null as number | null,
    succeeded: false,
    completed: false,
    timedOut: false,
    exitCode: null as number | null,
    terminationAttempted: false,
    terminationConfirmed: null as boolean | null,
    buildMetadataFresh: null as boolean | null,
  };
}

function presetDependencyIdentity(files: PresetFingerprint[]): string {
  return JSON.stringify(files.map((file) => [
    process.platform === 'win32' ? path.resolve(file.path).toLowerCase() : path.resolve(file.path),
    file.sha256, file.size,
  ]));
}

async function acquireStablePresetLocks(
  root: string, deps: CppBuildExecuteDependencies, deadlineAt: number,
): Promise<() => Promise<void>> {
  const rootPresetPaths = [path.join(root, 'CMakePresets.json'), path.join(root, 'CMakeUserPresets.json')];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await collectCmakePresetDependencies(
      root, Math.min(10_000, remaining(deadlineAt, 'preset dependency discovery')),
    );
    const resources = [...new Set([...rootPresetPaths, ...before.map((file) => file.path)])];
    const release = await deps.acquireMutationLocks(resources, deadlineAt, 'shared');
    try {
      const after = await collectCmakePresetDependencies(
        root, Math.min(10_000, remaining(deadlineAt, 'preset dependency revalidation')),
      );
      if (presetDependencyIdentity(before) === presetDependencyIdentity(after)) return release;
    } catch (error) {
      await release();
      throw error;
    }
    await release();
  }
  throw new Error('CPP_PRESET_DEPENDENCIES_CHANGED: preset dependency set changed repeatedly while acquiring shared ownership.');
}

export async function callCppBuildExecuteAcceleratorTool(
  rawArgs: JsonRecord,
  transportTimeoutMs: number,
  deps: CppBuildExecuteDependencies,
) {
  const parsed = parseArgs(rawArgs);
  const deadlineAt = Date.now() + Math.min(parsed.timeoutMs, transportTimeoutMs);
  parsed.root = await validatePath(
    parsed.root, Math.min(10_000, remaining(deadlineAt, 'cpp_build_execute root authority')),
  );
  const diagnostics: CppBuildDiagnostic[] = [];
  const outputTails: string[] = [];
  let configure = placeholderStage();
  let build = placeholderStage();
  let tests = placeholderStage();
  let buildContext: JsonRecord | null = null;
  let testContext: JsonRecord | null = null;
  let currentStage: StageName = parsed.configureMode === 'if_missing' ? 'configure'
    : parsed.operation === 'test' ? 'test' : 'build';
  let releaseConfigureGate: (() => Promise<void>) | null = null;
  let releasePresetLocks: (() => Promise<void>) | null = null;
  let releaseBuildLock: (() => Promise<void>) | null = null;
  try {
    const canonicalRoot = await runWithAbortableTimeout(
      (_signal) => fs.realpath(path.resolve(parsed.root)), remaining(deadlineAt, 'build ownership root resolution'),
      `Resolve cpp_build_execute ownership root ${parsed.root}`,
    );
    const stageUsesPreset = Boolean(parsed.buildPreset || parsed.testPreset);
    if (parsed.configurePreset || stageUsesPreset) {
      releasePresetLocks = await acquireStablePresetLocks(canonicalRoot, deps, deadlineAt);
    }
    // Every fast-path execution briefly joins the project configure gate while
    // resolving its output and acquiring the exact buildDir lock. A configure
    // with an initially unknown binaryDir holds this gate through generation,
    // preventing another fast-path caller from discovering a half-written tree.
    releaseConfigureGate = await deps.acquireMutationLocks([
      path.join(canonicalRoot, CONFIGURE_GATE_NAME),
    ], deadlineAt);
    const configureResult = await resolveConfiguredBuildDir(parsed, deps, deadlineAt);
    if (configureResult) {
      configure = { ...configure, ...configureResult.stage };
      ensureFailureDiagnostic('configure', configureResult);
      diagnostics.push(...configureResult.diagnostics);
      if (configureResult.outputTail) outputTails.push(configureResult.outputTail);
      if (!configure.succeeded) {
        return buildExecuteResult(parsed, configure, build, tests, diagnostics, outputTails, null, null);
      }
    }

    const configuredDuringCall = configure.executed && configure.succeeded;
    if (!configuredDuringCall && releaseConfigureGate) {
      await releaseConfigureGate();
      releaseConfigureGate = null;
    }
    releaseBuildLock = await deps.acquireMutationLocks([requireBuildDir(parsed)], deadlineAt);
    if (configuredDuringCall && releaseConfigureGate) {
      await releaseConfigureGate();
      releaseConfigureGate = null;
    }
    if (!stageUsesPreset && releasePresetLocks) {
      await releasePresetLocks();
      releasePresetLocks = null;
    }
    if (parsed.operation === 'build' || parsed.operation === 'build_and_test') {
      currentStage = 'build';
      buildContext = await callCppBuildContextAcceleratorTool(
        stageContextArgs(parsed, 'build'),
        Math.min(45_000, remaining(deadlineAt, 'build context')),
      ) as JsonRecord;
      const buildResult = await executeContextPlan('build', buildContext, deps, deadlineAt);
      ensureFailureDiagnostic('build', buildResult);
      build = { ...build, ...buildResult.stage };
      build.buildMetadataFresh = await metadataStillFresh(buildContext, parsed, deadlineAt);
      diagnostics.push(...buildResult.diagnostics);
      if (buildResult.outputTail) outputTails.push(buildResult.outputTail);
      if (!build.succeeded) {
        return buildExecuteResult(parsed, configure, build, tests, diagnostics, outputTails, buildContext, null);
      }
    }

    if (parsed.operation === 'test' || parsed.operation === 'build_and_test') {
      currentStage = 'test';
      testContext = await callCppBuildContextAcceleratorTool(
        stageContextArgs(parsed, 'test'),
        Math.min(45_000, remaining(deadlineAt, 'test context')),
      ) as JsonRecord;
      const testResult = await executeContextPlan('test', testContext, deps, deadlineAt);
      ensureFailureDiagnostic('test', testResult);
      tests = { ...tests, ...testResult.stage };
      tests.buildMetadataFresh = await metadataStillFresh(testContext, parsed, deadlineAt);
      diagnostics.push(...testResult.diagnostics);
      if (testResult.outputTail) outputTails.push(testResult.outputTail);
    }
    return buildExecuteResult(parsed, configure, build, tests, diagnostics, outputTails, buildContext, testContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(createDiagnostic(currentStage, 'cpp_build_execute', 'error', message));
    outputTails.push(message);
    return buildExecuteResult(parsed, configure, build, tests, diagnostics, outputTails, buildContext, testContext);
  } finally {
    if (releaseConfigureGate) await releaseConfigureGate();
    if (releasePresetLocks) await releasePresetLocks();
    if (releaseBuildLock) await releaseBuildLock();
  }
}

function aggregateImpact(buildImpact: ReturnType<typeof stageImpact>, testImpact: ReturnType<typeof stageImpact>) {
  const stages = { build: buildImpact, test: testImpact };
  const present = [buildImpact, testImpact].filter((item): item is NonNullable<typeof item> => item !== null);
  const conservative = present.some((item) => item.conservative);
  const mode = present.some((item) => item.mode === 'full') ? 'full'
    : present.some((item) => item.mode === 'focused') ? 'focused'
      : present.some((item) => item.mode === 'explicit') ? 'explicit' : 'full';
  return {
    mode,
    conservative,
    reasons: [...new Set(present.flatMap((item) => item.reasons))],
    stages,
  };
}

function requestedStagesSucceeded(parsed: ParsedArgs, build: StageResult, tests: StageResult): boolean {
  if ((parsed.operation === 'build' || parsed.operation === 'build_and_test') && !build.succeeded) return false;
  if ((parsed.operation === 'test' || parsed.operation === 'build_and_test') && !tests.succeeded) return false;
  return true;
}
function buildExecuteResult(
  parsed: ParsedArgs,
  configure: StageResult,
  build: StageResult,
  tests: StageResult,
  diagnostics: CppBuildDiagnostic[],
  outputTails: string[],
  buildContext: JsonRecord | null,
  testContext: JsonRecord | null,
) {
  const succeeded = requestedStagesSucceeded(parsed, build, tests)
    && (!configure.executed || configure.succeeded)
    && !diagnostics.some((item) => item.tool === 'cpp_build_execute');
  const failureStage = !configure.succeeded && configure.executed ? configure
    : !build.succeeded && (parsed.operation === 'build' || parsed.operation === 'build_and_test') ? build
      : !tests.succeeded && (parsed.operation === 'test' || parsed.operation === 'build_and_test') ? tests
        : null;
  const freshness = [build.buildMetadataFresh, tests.buildMetadataFresh]
    .filter((value): value is boolean => typeof value === 'boolean');
  const outputTail = boundedTail(outputTails.filter(Boolean).join('\n---\n'));
  return {
    succeeded,
    exitCode: succeeded ? 0 : failureStage?.exitCode ?? null,
    operation: parsed.operation,
    buildDir: parsed.buildDir ?? null,
    buildDirSource: parsed.buildDirSource ?? null,
    configure: { ...configure, preset: parsed.configurePreset ?? null, mode: parsed.configureMode },
    build: { ...build, selected: build.targets },
    tests: { ...tests, selected: tests.tests },
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    impact: aggregateImpact(stageImpact(buildContext, parsed), stageImpact(testContext, parsed)),
    outputTail,
    buildMetadataFresh: freshness.length > 0 ? freshness.every(Boolean) : null,
    selection: {
      changedFiles: parsed.changedFiles,
      unsupportedChangedFiles: parsed.unsupportedChangedFiles,
      explicitTargets: parsed.targets,
      explicitTests: parsed.tests,
    },
  };
}
export const CPP_BUILD_EXECUTE_ACCELERATOR_TOOL = {
  name: 'cpp_build_execute',
  purpose: 'Plan and execute one configured CMake/CTest verification slice, wait for completion, and return bounded normalized diagnostics in one MCP call.',
  when_to_use: 'For the common C/C++ build/test fast path after code changes when the project already owns its CMake configuration and toolchain.',
  when_not_to_use: 'For inventing compiler/generator/ABI flags, arbitrary shell pipelines, packaging workflows, or multi-toolchain artifact pipelines.',
  readOnly: false,
  mutating: true,
  inputSchema: {
    type: 'object',
    required: ['root', 'operation'],
    additionalProperties: false,
    properties: {
      root: { type: 'string', description: 'Project/repository root.' },
      buildDir: { type: 'string', description: 'Optional configured CMake build directory. Omit it only when exactly one project-owned configured tree exists, or when no tree exists and configureMode=if_missing creates exactly one through configurePreset. Ambiguous existing outputs require explicit buildDir.' },
      operation: { type: 'string', enum: ['build', 'test', 'build_and_test'] },
      changedFiles: {
        type: 'array', minItems: 1, maxItems: MAX_CHANGED_FILES, items: { type: 'string' },
        description: 'Optional changed-file set for cpp_build_impact. Non-C/C++ paths force conservative scope instead of failing execution.',
      },
      targets: {
        type: 'array', minItems: 1, maxItems: MAX_EXPLICIT_ITEMS, items: { type: 'string' },
        description: 'Explicit build targets. They win over affected-target expansion.',
      },
      tests: {
        type: 'array', minItems: 1, maxItems: MAX_EXPLICIT_ITEMS, items: { type: 'string' },
        description: 'Explicit exact CTest names. They win over affected-test expansion.',
      },
      configuration: { type: 'string', description: 'Optional Debug/Release-style configuration.' },
      preset: {
        type: 'string',
        description: 'Shorthand stage preset. For build_and_test it is used for both stages; prefer buildPreset/testPreset when names differ.',
      },
      buildPreset: { type: 'string', description: 'Optional explicit CMake build preset.' },
      testPreset: { type: 'string', description: 'Optional explicit CTest test preset.' },
      configurePreset: {
        type: 'string',
        description: 'Explicit configure preset, required only for configureMode=if_missing. It must come from project-owned CMakePresets.json.',
      },
      configureMode: {
        type: 'string', enum: ['never', 'if_missing'], default: 'never',
        description: 'never is fail-closed. if_missing may configure only through explicit project-owned configurePreset when the output is missing; it never guesses among multiple existing configured trees.',
      },
      useAffectedTargets: {
        type: 'boolean', default: true,
        description: 'Use exact affected targets only while impact is complete/non-conservative and no explicit targets were supplied.',
      },
      useAffectedTests: {
        type: 'boolean', default: true,
        description: 'Use exact affected tests only while impact is complete/non-conservative and no explicit tests were supplied.',
      },
      includeTests: {
        type: 'boolean', default: true,
        description: 'Ask build-stage impact analysis to include tests. Test operations always derive test impact.',
      },
      timeoutMs: {
        type: 'integer', minimum: 1_000, maximum: PROCESS_WAIT_MAX_MS, default: PROCESS_WAIT_DEFAULT_MS,
        description: 'Whole fast-path deadline. On timeout, cpp_build_execute terminates and reconciles its request-owned process tree before releasing build-output ownership; low-level start_process/wait_process remains the transferable long-running path.',
      },
      parallelism: {
        oneOf: [
          { type: 'integer', minimum: 1, maximum: MAX_PARALLELISM },
          { type: 'string', enum: ['project'] },
        ],
        default: 'project',
        description: "Explicit CMake/CTest job count, or 'project' to leave preset/environment/build-system parallelism untouched.",
      },
    },
  },
  recommended_workflow: [
    'Prefer this over cpp_build_context -> start_process -> wait_process for routine configured CMake verification.',
    'Omit buildDir only when there is exactly one project-owned configured tree, or no configured tree and an explicit project-owned configure preset can create one. Pass buildDir for ambiguous existing layouts.',
    'Supply explicit targets/tests when the caller already owns exact scope; the tool will not broaden them automatically.',
    'For changed-file scope, incomplete/stale/unsupported impact falls back to the broader safe CMake/CTest operation and reports why.',
    'Preset-driven stages hold the project preset files stable for the execution slice; same-output builds are serialized through the shared mutation-resource owner.',
    'Use returned diagnostics first; use outputTail only when a tool-specific diagnostic could not be normalized.',
    'Keep cpp_build_context, cpp_build_plan, start_process and wait_process for custom orchestration and debugging.',
  ],
  related_capabilities: [
    'cpp_build_context', 'cpp_build_plan', 'cpp_build_impact',
    'desktop-core/start_process', 'wait_process', 'CMake', 'CTest',
  ],
};
