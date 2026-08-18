import path from 'path';

import { terminalManager } from '../terminal-manager.js';
import { acquireMutationResourceLocks } from '../utils/mutation-resource-lock.js';
import { acquireResourceLease } from '../utils/resource-lease-owner.js';
import {
  CPP_BUILD_AUTO_OBSERVE_MAX_MS, PROCESS_STALL_DEFAULT_MS, PROCESS_TRANSPORT_RESERVE_MS,
  PROCESS_WAIT_DEFAULT_MS, PROCESS_WAIT_MAX_MS,
} from '../utils/process-wait-contract.js';
import { waitForTerminalProcess } from '../utils/terminal-process-wait.js';
import { buildRunOwner, type BuildRunHooks } from './build-run-owner.js';
import { callCppBuildAccessPlanner } from './cpp-build-access-planner.js';
import { CppBuildLaneRunner, type CppBuildExecuteDependencies } from './cpp-build-lane-runner.js';
import {
  readDetachedBuildProcessOutputPage, startDetachedBuildProcess,
  terminateDetachedBuildProcess, waitDetachedBuildProcess,
} from './detached-build-process.js';
import { startProcess } from './improved-process-tools.js';

type CppBuildExecutionMode = 'auto' | 'inline' | 'resumable';

function remaining(deadlineAt: number, maximum: number): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error('C++ build entry deadline exceeded.') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return Math.max(1, Math.min(maximum, value));
}

function executionMode(args: Record<string, unknown>): CppBuildExecutionMode {
  const value = args.executionMode ?? 'auto';
  if (value !== 'auto' && value !== 'inline' && value !== 'resumable') {
    throw new Error("cpp_build_execute.executionMode must be 'auto', 'inline', or 'resumable'.");
  }
  return value;
}

function internalArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result = { ...args };
  delete result.executionMode;
  return result;
}

async function waitInlineProcess(args: Record<string, unknown>) {
  return waitForTerminalProcess(terminalManager, {
    pid: Number(args.pid),
    timeoutMs: args.timeout_ms === undefined ? PROCESS_WAIT_DEFAULT_MS : Number(args.timeout_ms),
    stallTimeoutMs: args.stall_timeout_ms === undefined ? PROCESS_STALL_DEFAULT_MS : Number(args.stall_timeout_ms),
    tailLines: args.tail_lines === undefined ? 100 : Number(args.tail_lines),
  });
}

function dependencies(hooks?: BuildRunHooks): CppBuildExecuteDependencies {
  const detached = hooks !== undefined;
  return {
    startProcess: async (processArgs) => {
      const result = detached
        ? await startDetachedBuildProcess(processArgs)
        : await startProcess(processArgs);
      if (hooks) {
        const structured = result.structuredContent as { pid?: unknown } | undefined;
        const pid = Number(structured?.pid);
        if (Number.isInteger(pid) && pid > 0) hooks.onPid(pid);
      }
      return result;
    },
    waitProcess: (waitArgs) => detached ? waitDetachedBuildProcess(waitArgs) : waitInlineProcess(waitArgs),
    readProcessOutputPage: (pid, offset, length) => detached
      ? readDetachedBuildProcessOutputPage(pid, offset, length)
      : terminalManager.readOutputPaginated(pid, offset, length),
    terminateProcess: (pid, cause, detail) => detached
      ? terminateDetachedBuildProcess(pid, cause, detail)
      : terminalManager.forceTerminate(pid, cause, detail),
    acquireMutationLocks: (resources, lockDeadlineAt, resourceMode = 'exclusive') =>
      acquireMutationResourceLocks(resources, lockDeadlineAt, { topologyMode: 'none', resourceMode }),
    planBuildAccess: (planArgs, planTimeoutMs) => callCppBuildAccessPlanner(planArgs, planTimeoutMs),
    acquireBuildAccessLease: (request, leaseDeadlineAt) => acquireResourceLease(request, leaseDeadlineAt),
  };
}

function runningBuildRun(snapshot: ReturnType<typeof buildRunOwner.get>) {
  return {
    succeeded: null,
    status: 'running',
    buildRunId: snapshot.buildRunId,
    pids: snapshot.pids,
    createdAt: snapshot.createdAt,
    note: 'Build execution is owned by BuildRunOwner and continues independently of this MCP response. Use cpp_build_result.',
  };
}

function completedBuildRun(snapshot: ReturnType<typeof buildRunOwner.get>) {
  if (snapshot.status === 'completed') {
    const result = snapshot.result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return {
        ...(result as Record<string, unknown>),
        buildRun: { buildRunId: snapshot.buildRunId, status: snapshot.status, pids: snapshot.pids },
      };
    }
    return { status: 'completed', buildRunId: snapshot.buildRunId, pids: snapshot.pids, result };
  }
  if (snapshot.status === 'failed') {
    return {
      succeeded: false, status: 'failed', buildRunId: snapshot.buildRunId, pids: snapshot.pids,
      error: snapshot.error ?? 'Build run failed.',
    };
  }
  return runningBuildRun(snapshot);
}

export async function executeCppBuildEntry(args: Record<string, unknown>, deadlineAt: number) {
  const mode = executionMode(args);
  const argsForEngine = internalArgs(args);
  const requestedExecutionTimeout = typeof args.timeoutMs === 'number'
    ? Math.max(1_000, Math.min(PROCESS_WAIT_MAX_MS, args.timeoutMs))
    : PROCESS_WAIT_DEFAULT_MS;

  if (mode === 'inline') {
    return new CppBuildLaneRunner(dependencies()).run(
      argsForEngine, remaining(deadlineAt, PROCESS_WAIT_MAX_MS),
    );
  }

  const rootLabel = typeof args.root === 'string' && args.root ? path.basename(path.resolve(args.root)) : 'project';
  const run = buildRunOwner.start(`cpp_build_execute:${rootLabel}`, async (hooks) =>
    new CppBuildLaneRunner(dependencies(hooks)).run(argsForEngine, requestedExecutionTimeout)
  );
  if (mode === 'resumable') return runningBuildRun(run);

  const observationBudget = Math.max(0, Math.min(
    CPP_BUILD_AUTO_OBSERVE_MAX_MS, deadlineAt - Date.now() - PROCESS_TRANSPORT_RESERVE_MS,
  ));
  if (observationBudget <= 0) return runningBuildRun(run);
  return completedBuildRun(await buildRunOwner.wait(run.buildRunId, observationBudget));
}

export async function readCppBuildResult(args: Record<string, unknown>, deadlineAt: number) {
  const buildRunId = typeof args.buildRunId === 'string' ? args.buildRunId : '';
  if (!/^br_[a-f0-9]{32}$/.test(buildRunId)) throw new Error('cpp_build_result.buildRunId is invalid.');
  const requestedWait = args.waitMs === undefined ? 0 : Number(args.waitMs);
  if (!Number.isInteger(requestedWait) || requestedWait < 0 || requestedWait > 30_000) {
    throw new Error('cpp_build_result.waitMs must be an integer from 0 to 30000.');
  }
  const available = Math.max(0, Math.min(30_000, deadlineAt - Date.now() - 250));
  return buildRunOwner.wait(buildRunId, Math.min(requestedWait, available));
}

export const CPP_BUILD_RESULT_ACCELERATOR_TOOL = {
  name: 'cpp_build_result',
  purpose: 'Observe one resumable C++ build run without owning or advancing its process lifetime.',
  when_to_use: 'After cpp_build_execute returns a running buildRunId.',
  when_not_to_use: 'To launch, cancel, or advance a build DAG; the BuildRunOwner continues autonomously.',
  readOnly: true,
  mutating: false,
  inputSchema: {
    type: 'object',
    required: ['buildRunId'],
    additionalProperties: false,
    properties: {
      buildRunId: { type: 'string', pattern: '^br_[a-f0-9]{32}$' },
      waitMs: { type: 'integer', minimum: 0, maximum: 30_000, default: 0 },
    },
  },
  recommended_workflow: [
    'Use the opaque buildRunId returned by cpp_build_execute.',
    'Use waitMs only for one bounded observation window; the run continues independently if still running.',
    'Read result only after status=completed; failed runs expose their owner-level error.',
  ],
  related_capabilities: ['cpp_build_execute', 'wait_process'],
};
