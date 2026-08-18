import { processProblemEvidence } from './process-problem-matcher.js';
import { PROCESS_STALL_DEFAULT_MS, PROCESS_WAIT_DEFAULT_MS, PROCESS_WAIT_MAX_MS } from './process-wait-contract.js';

export type TerminalWaitOptions = {
  pid: number;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  tailLines?: number;
};

export type TerminalWaitPage = {
  lines: string[];
  isComplete: boolean;
  exitCode?: number | null;
  runtimeMs?: number;
  noOutputForMs?: number;
  evictedLines?: number;
  outputDecoding?: unknown;
  rootExited?: boolean;
  rootExitCode?: number | null;
  treeState?: string | null;
  descendantPids?: number[];
  treeProbeWarning?: string;
  terminalError?: string;
};

export type TerminalProcessWaitPort = {
  readOutputPaginated: (pid: number, offset: number, length: number) => TerminalWaitPage | null;
  reconcileExitedSession: (pid: number) => Promise<void>;
};

function normalizedInteger(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return result;
}

export async function waitForTerminalProcess(port: TerminalProcessWaitPort, options: TerminalWaitOptions) {
  const pid = options.pid;
  if (!Number.isInteger(pid)) throw new Error('Terminal wait pid must be an integer.');
  const timeoutMs = normalizedInteger(options.timeoutMs, PROCESS_WAIT_DEFAULT_MS, 0, PROCESS_WAIT_MAX_MS, 'Terminal wait timeoutMs');
  const stallTimeoutMs = normalizedInteger(options.stallTimeoutMs, PROCESS_STALL_DEFAULT_MS, 0, PROCESS_WAIT_MAX_MS, 'Terminal wait stallTimeoutMs');
  const tailLines = normalizedInteger(options.tailLines, 100, 1, 1000, 'Terminal wait tailLines');
  const started = Date.now();

  while (true) {
    let result = port.readOutputPaginated(pid, -tailLines, tailLines);
    if (!result) throw new Error(`No terminal session found for PID ${pid}.`);
    if (!result.isComplete && result.rootExited) {
      await port.reconcileExitedSession(pid);
      result = port.readOutputPaginated(pid, -tailLines, tailLines);
      if (!result) throw new Error(`No terminal session found for PID ${pid} after process-tree reconciliation.`);
    }
    const lifecycle = {
      rootExited: result.rootExited ?? false,
      rootExitCode: result.rootExited ? result.rootExitCode ?? null : null,
      treeState: result.treeState ?? null,
      descendantPids: result.descendantPids ?? [],
      treeProbeWarning: result.treeProbeWarning ?? null,
      terminalError: result.terminalError ?? null,
    };
    const tail = result.lines.join('\n');
    const base = {
      pid, runtimeMs: result.runtimeMs ?? Date.now() - started,
      noOutputForMs: result.noOutputForMs ?? 0, evictedLines: result.evictedLines ?? 0,
      outputDecoding: result.outputDecoding ?? null, tail, ...lifecycle, ...processProblemEvidence(tail),
    };

    if ((result.terminalError || (result.rootExited && result.treeState === 'probe_uncertain')) && !result.isComplete) {
      return {
        ...base, completed: false, timedOut: false, stalled: false, terminalFailed: true,
        ownershipLost: result.rootExited && result.treeState === 'probe_uncertain',
        processSucceeded: false, exitCode: result.rootExited ? result.rootExitCode ?? null : null,
      };
    }

    if (result.isComplete) {
      return {
        ...base, completed: true, timedOut: false, stalled: false,
        processSucceeded: result.exitCode === 0 && !result.terminalError, exitCode: result.exitCode ?? null,
      };
    }
    if (stallTimeoutMs > 0 && (result.noOutputForMs ?? 0) >= stallTimeoutMs) {
      return {
        ...base, completed: false, timedOut: false, stalled: true,
        processSucceeded: false, exitCode: null,
      };
    }
    if (Date.now() - started >= timeoutMs) {
      return {
        ...base, completed: false, timedOut: true, stalled: false,
        processSucceeded: false, exitCode: null,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
