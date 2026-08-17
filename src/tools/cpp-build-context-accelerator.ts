import crypto from 'crypto';

import { callBuildMetadataAcceleratorTool, revalidateBuildMetadataSnapshot, type BuildMetadataSnapshot } from './build-metadata-accelerator.js';
import { callCppBuildImpactAcceleratorTool } from './cpp-build-impact-accelerator.js';
import { callCppBuildPlanAcceleratorTool } from './cpp-build-plan-accelerator.js';
import { callCppToolchainProfileAcceleratorTool } from './cpp-toolchain-profile-accelerator.js';

const MAX_OPERATION_TIMEOUT_MS = 45_000;
const MAX_CHANGED_FILES = 100;
const MAX_METADATA_ENTRIES = 500;
const MAX_METADATA_TARGETS = 500;
const MAX_RETURNED_TARGETS = 250;
const MAX_RETURNED_TESTS = 500;
const MAX_PLAN_TARGETS = 50;
const MAX_PLAN_TESTS = 50;

type JsonRecord = Record<string, unknown>;
type ImpactResult = Awaited<ReturnType<typeof callCppBuildImpactAcceleratorTool>>;
type ProfileResult = Awaited<ReturnType<typeof callCppToolchainProfileAcceleratorTool>>;
type PlanResult = Awaited<ReturnType<typeof callCppBuildPlanAcceleratorTool>>;

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
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

function boundedInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return value as number;
}

function fingerprint(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function assertArguments(args: Record<string, unknown>): void {
  const allowed = new Set([
    'root', 'buildDir', 'changedFiles', 'configuration', 'includeTests', 'includeProfile',
    'operation', 'preset', 'targets', 'tests', 'maxTargets', 'maxTests', 'useAffectedTargets', 'useAffectedTests',
    'parallelism', 'outputOnFailure', 'noTestsError',
  ]);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`cpp_build_context received unsupported argument(s): ${unknown.join(', ')}.`);
  if (typeof args.root !== 'string' || !args.root.trim()) throw new Error('cpp_build_context.root is required.');
  if (args.changedFiles !== undefined && (!Array.isArray(args.changedFiles) || args.changedFiles.length < 1 || args.changedFiles.length > MAX_CHANGED_FILES)) {
    throw new Error(`cpp_build_context.changedFiles must contain 1-${MAX_CHANGED_FILES} paths when provided.`);
  }
  if (args.includeTests !== undefined && typeof args.includeTests !== 'boolean') throw new Error('cpp_build_context.includeTests must be boolean.');
  if (args.includeProfile !== undefined && typeof args.includeProfile !== 'boolean') throw new Error('cpp_build_context.includeProfile must be boolean.');
  if (args.useAffectedTargets !== undefined && typeof args.useAffectedTargets !== 'boolean') throw new Error('cpp_build_context.useAffectedTargets must be boolean.');
  if (args.useAffectedTests !== undefined && typeof args.useAffectedTests !== 'boolean') throw new Error('cpp_build_context.useAffectedTests must be boolean.');
  if (args.tests !== undefined && (!Array.isArray(args.tests) || args.tests.length < 1 || args.tests.length > MAX_PLAN_TESTS)) {
    throw new Error(`cpp_build_context.tests must contain 1-${MAX_PLAN_TESTS} names when provided.`);
  }
  if (args.outputOnFailure !== undefined && typeof args.outputOnFailure !== 'boolean') throw new Error('cpp_build_context.outputOnFailure must be boolean.');
  if (args.noTestsError !== undefined && typeof args.noTestsError !== 'boolean') throw new Error('cpp_build_context.noTestsError must be boolean.');
  if (args.operation !== undefined && args.operation !== 'build' && args.operation !== 'test') {
    throw new Error("cpp_build_context.operation must be 'build' or 'test'.");
  }
  if (args.operation === undefined && (args.preset !== undefined || args.targets !== undefined || args.tests !== undefined || args.parallelism !== undefined || args.outputOnFailure !== undefined || args.noTestsError !== undefined)) {
    throw new Error('cpp_build_context preset/targets/tests/parallelism/outputOnFailure/noTestsError require operation.');
  }
}

function compactMetadataEvidence(metadata: BuildMetadataSnapshot) {
  const compileDatabase = recordValue(metadata.compileDatabase) ?? {};
  const cmake = recordValue(metadata.cmake) ?? {};
  const codemodel = recordValue(cmake.codemodel) ?? {};
  const generator = recordValue(cmake.generator) ?? {};
  const cmakeCache = recordValue(metadata.cmakeCache) ?? {};
  return {
    repositoryRoot: metadata.repositoryRoot,
    buildDir: metadata.buildDir,
    buildDirDiscovered: metadata.buildDirDiscovered,
    searchedDirectories: metadata.searchedDirectories,
    compileDatabase: {
      found: compileDatabase.found === true,
      path: typeof compileDatabase.path === 'string' ? compileDatabase.path : null,
      sha256: typeof compileDatabase.sha256 === 'string' ? compileDatabase.sha256 : null,
      totalEntries: typeof compileDatabase.totalEntries === 'number' ? compileDatabase.totalEntries : 0,
      truncated: compileDatabase.truncated === true,
      compilerCounts: recordValue(compileDatabase.compilerCounts) ?? {},
      standardCounts: recordValue(compileDatabase.standardCounts) ?? {},
    },
    cmake: {
      codemodelSha256: typeof codemodel.sha256 === 'string' ? codemodel.sha256 : null,
      generator: typeof generator.name === 'string' ? generator.name : null,
      targetCount: Array.isArray(cmake.targets) ? cmake.targets.length : 0,
      targetsTruncated: cmake.targetsTruncated === true,
    },
    cmakeCache: {
      found: cmakeCache.found === true,
      path: typeof cmakeCache.path === 'string' ? cmakeCache.path : null,
      sha256: typeof cmakeCache.sha256 === 'string' ? cmakeCache.sha256 : null,
    },
  };
}
export async function callCppBuildContextAcceleratorTool(
  args: Record<string, unknown>, timeoutMs = 30_000,
) {
  assertArguments(args);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`cpp_build_context timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  const deadlineAt = Date.now() + timeoutMs;
  const configuration = args.configuration;
  const maxTargets = boundedInteger(args.maxTargets, 100, MAX_RETURNED_TARGETS, 'cpp_build_context.maxTargets');
  const maxTests = boundedInteger(args.maxTests, 200, MAX_RETURNED_TESTS, 'cpp_build_context.maxTests');
  const includeTests = args.includeTests !== false;
  const includeProfile = args.includeProfile !== false;
  const useAffectedTargets = args.useAffectedTargets !== false;
  const useAffectedTests = args.useAffectedTests !== false;
  const changedFiles = Array.isArray(args.changedFiles) ? args.changedFiles : [];

  const metadata = await callBuildMetadataAcceleratorTool({
    root: args.root,
    buildDir: args.buildDir,
    configuration,
    includeArguments: false,
    maxEntries: MAX_METADATA_ENTRIES,
    maxTargets: MAX_METADATA_TARGETS,
  }, remaining(deadlineAt, 'cpp_build_context metadata', MAX_OPERATION_TIMEOUT_MS));

  const selectedBuildDir = metadata.buildDir;
  const profilePromise: Promise<ProfileResult | null> = includeProfile
    ? callCppToolchainProfileAcceleratorTool({
        root: args.root, buildDir: selectedBuildDir, configuration,
      }, remaining(deadlineAt, 'cpp_build_context toolchain profile', MAX_OPERATION_TIMEOUT_MS), metadata)
    : Promise.resolve(null);
  const impactPromise: Promise<ImpactResult | null> = changedFiles.length > 0
    ? callCppBuildImpactAcceleratorTool({
        root: args.root,
        buildDir: selectedBuildDir,
        changedFiles,
        configuration,
        includeTests,
        maxTargets,
        maxTests,
      }, remaining(deadlineAt, 'cpp_build_context build impact', MAX_OPERATION_TIMEOUT_MS), metadata)
    : Promise.resolve(null);

  // Both consumers are read-only and share only the immutable request snapshot.
  // Running them together shortens the staleness window before any later plan.
  const [profileDerived, impactDerived] = await Promise.all([profilePromise, impactPromise]);
  const snapshotValidation = await revalidateBuildMetadataSnapshot(
    metadata, remaining(deadlineAt, 'cpp_build_context snapshot revalidation', 5_000),
  );
  let profile: ProfileResult | null = profileDerived;
  let impact: ImpactResult | null = impactDerived;
  if (!snapshotValidation.current) {
    const warning = `Build metadata changed during cpp_build_context: ${snapshotValidation.changed.join(', ')}. Focused selections and semantic handoff were invalidated.`;
    if (profile) {
      profile = {
        ...profile,
        serenaHandoff: { ...profile.serenaHandoff, ready: false },
        snapshotValidation,
        warnings: [...profile.warnings, warning],
      };
    }
    if (impact) {
      impact = {
        ...impact,
        recommendFullBuild: true,
        recommendFullTests: includeTests ? true : impact.recommendFullTests,
        selectionComplete: false,
        incompleteness: [...new Set([...impact.incompleteness, 'build_metadata_changed_during_context'])],
        testIncompleteness: includeTests
          ? [...new Set([...impact.testIncompleteness, 'build_metadata_changed_during_context'])]
          : impact.testIncompleteness,
        warnings: [...impact.warnings, warning],
        evidence: { ...impact.evidence, snapshotValidation },
      };
    }
  }

  let plan: PlanResult | null = null;
  let metadataSnapshots = 1;
  let planSelection: 'none' | 'explicit-targets' | 'affected-targets' | 'explicit-tests' | 'affected-tests' | 'default-operation' | 'snapshot-changed-default' = 'none';
  if (args.operation !== undefined) {
    const planArgs: Record<string, unknown> = {
      root: args.root,
      buildDir: selectedBuildDir,
      operation: args.operation,
      configuration,
      preset: args.preset,
      parallelism: args.parallelism,
      outputOnFailure: args.outputOnFailure,
      noTestsError: args.noTestsError,
    };
    const explicitTargets = Array.isArray(args.targets) ? args.targets : [];
    const explicitTests = Array.isArray(args.tests) ? args.tests : [];
    if (args.operation === 'build' && explicitTargets.length > 0) {
      planArgs.targets = explicitTargets;
      planSelection = 'explicit-targets';
    } else if (
      snapshotValidation.current && args.operation === 'build' && useAffectedTargets && impact &&
      impact.recommendFullBuild === false && impact.selectionComplete === true &&
      impact.affectedTargets.length > 0 && impact.affectedTargets.length <= MAX_PLAN_TARGETS
    ) {
      planArgs.targets = impact.affectedTargets;
      planSelection = 'affected-targets';
    } else if (args.operation === 'test' && explicitTests.length > 0) {
      planArgs.tests = explicitTests;
      planSelection = 'explicit-tests';
    } else if (
      snapshotValidation.current && args.operation === 'test' && useAffectedTests && impact &&
      impact.recommendFullTests === false && impact.selectionComplete === true &&
      impact.affectedTests.length > 0 && impact.affectedTests.length <= MAX_PLAN_TESTS
    ) {
      planArgs.tests = impact.affectedTests;
      planSelection = 'affected-tests';
    } else {
      planSelection = snapshotValidation.current ? 'default-operation' : 'snapshot-changed-default';
    }
    const planSnapshot = snapshotValidation.current ? metadata : undefined;
    if (!planSnapshot) metadataSnapshots += 1;
    plan = await callCppBuildPlanAcceleratorTool(
      planArgs,
      remaining(deadlineAt, 'cpp_build_context build plan', MAX_OPERATION_TIMEOUT_MS),
      planSnapshot,
    );
  }
  const metadataEvidence = compactMetadataEvidence(metadata);
  const contextIdentity = {
    metadata: metadataEvidence,
    profile: profile?.profileFingerprint ?? null,
    impact: impact ? {
      selectionComplete: impact.selectionComplete,
      recommendFullBuild: impact.recommendFullBuild,
      affectedTargets: impact.affectedTargets,
      affectedTests: impact.affectedTests,
    } : null,
    plan: plan?.profileFingerprint ?? null,
    snapshotValidation,
  };

  return {
    repositoryRoot: metadata.repositoryRoot,
    buildDir: selectedBuildDir,
    metadata: metadataEvidence,
    profile,
    impact,
    plan,
    orchestration: {
      metadataSnapshots,
      profileAndImpactParallel: Boolean(includeProfile && changedFiles.length > 0),
      planSelection,
      snapshotValidation,
    },
    contextFingerprint: fingerprint(contextIdentity),
  };
}
export const CPP_BUILD_CONTEXT_ACCELERATOR_TOOL = {
  name: 'cpp_build_context',
  purpose: 'Reuse one request-scoped CMake/compile-database snapshot across C++ toolchain profile, build impact, and optional build-plan derivation.',
  when_to_use: 'For a changed C/C++ set when profile/impact/build planning would otherwise repeat build_metadata reads.',
  when_not_to_use: 'As a persistent build cache, semantic graph, configure step, or process executor.',
  readOnly: true,
  mutating: false,
  inputSchema: {
    type: 'object',
    required: ['root'],
    additionalProperties: false,
    properties: {
      root: { type: 'string' },
      buildDir: { type: 'string' },
      changedFiles: { type: 'array', minItems: 1, maxItems: MAX_CHANGED_FILES, items: { type: 'string' } },
      configuration: { type: 'string' },
      includeTests: { type: 'boolean', default: true },
      includeProfile: { type: 'boolean', default: true },
      operation: { type: 'string', enum: ['build', 'test'] },
      preset: { type: 'string' },
      targets: { type: 'array', minItems: 1, maxItems: MAX_PLAN_TARGETS, items: { type: 'string' } },
      tests: { type: 'array', minItems: 1, maxItems: MAX_PLAN_TESTS, items: { type: 'string' } },
      maxTargets: { type: 'integer', minimum: 1, maximum: MAX_RETURNED_TARGETS, default: 100 },
      maxTests: { type: 'integer', minimum: 1, maximum: MAX_RETURNED_TESTS, default: 200 },
      useAffectedTargets: { type: 'boolean', default: true },
      useAffectedTests: { type: 'boolean', default: true },
      parallelism: {
        oneOf: [{ type: 'integer', minimum: 1, maximum: 256 }, { type: 'string', enum: ['project'] }],
        default: 'project',
      },
      outputOnFailure: { type: 'boolean', default: false },
      noTestsError: { type: 'boolean', default: false },
    },
  },
  recommended_workflow: [
    'Use workspace_delta to obtain changed C/C++ paths.',
    'Call cpp_build_context once to reuse a single authoritative build snapshot.',
    'Use profile.serenaHandoff for clangd/Serena, impact for build/test scope, and plan.process for native start_process.',
    'For test plans, explicit tests win; otherwise a complete non-conservative affected test set may be selected exactly.',
    'Treat conservative impact as a request for wider build/test verification rather than guessing missing dependencies.',
  ],
  related_capabilities: [
    'build_metadata',
    'cpp_toolchain_profile',
    'cpp_build_impact',
    'cpp_build_plan',
    'Serena/clangd',
    'start_process',
    'wait_process',
  ],
};
