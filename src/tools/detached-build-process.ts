import path from 'path';

import { terminalManager, type DirectProcessSpec } from '../terminal-manager.js';
import { waitForTerminalProcess } from '../utils/terminal-process-wait.js';
import type { CancellationCause } from '../utils/cancellation.js';

const LAUNCH_OBSERVE_MS = 1_000;
const MAX_PROCESS_ARGS = 512;
const MAX_ENV_ENTRIES = 512;
const MAX_TOKEN_CHARS = 32 * 1024;

type JsonRecord = Record<string, unknown>;

function boundedString(value: unknown, label: string, maximum = MAX_TOKEN_CHARS): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes(String.fromCharCode(0)) || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a bounded non-empty single-line string.`);
  }
  return value;
}

function processSpec(args: JsonRecord): DirectProcessSpec {
  const executable = boundedString(args.executable, 'Detached build executable', 4096);
  if (!path.isAbsolute(executable)) throw new Error('Detached build executable must be absolute.');
  const rawArgs = args.args ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.length > MAX_PROCESS_ARGS) throw new Error(`Detached build args are limited to ${MAX_PROCESS_ARGS} entries.`);
  const processArgs = rawArgs.map((value, index) => boundedString(value, `Detached build args[${index}]`));
  const cwd = boundedString(args.cwd, 'Detached build cwd', 4096);
  if (!path.isAbsolute(cwd)) throw new Error('Detached build cwd must be absolute.');
  let env: Record<string, string> | undefined;
  if (args.env !== undefined) {
    if (!args.env || typeof args.env !== 'object' || Array.isArray(args.env)) throw new Error('Detached build env must be an object.');
    const entries = Object.entries(args.env as Record<string, unknown>);
    if (entries.length > MAX_ENV_ENTRIES) throw new Error(`Detached build env is limited to ${MAX_ENV_ENTRIES} entries.`);
    env = {};
    for (const [key, value] of entries) {
      if (!key || key.length > 512 || /[=\0\r\n]/.test(key) || typeof value !== 'string' || value.length > MAX_TOKEN_CHARS || value.includes(String.fromCharCode(0))) {
        throw new Error('Detached build env contains an invalid entry.');
      }
      env[key] = value;
    }
  }
  if (args.execution_kind !== undefined && args.execution_kind !== 'finite') {
    throw new Error('Detached build process only accepts execution_kind=finite.');
  }
  if (args.pty !== undefined && args.pty !== 'never') throw new Error('Detached build process does not use PTY.');
  return { executable: path.resolve(executable), args: processArgs, cwd: path.resolve(cwd), env };
}

export async function startDetachedBuildProcess(args: JsonRecord) {
  const spec = processSpec(args);
  const result = await terminalManager.executeCommand(spec, LAUNCH_OBSERVE_MS, undefined, false, {
    executionKind: 'finite', detectPrompts: false,
  });
  if (!Number.isInteger(result.pid) || result.pid < 1) {
    return { content: [{ type: 'text', text: result.output || 'Detached build process failed to start.' }], isError: true };
  }
  const snapshot = terminalManager.readOutputPaginated(result.pid, -1, 1);
  return {
    content: [{ type: 'text', text: result.output || `Detached build process started with PID ${result.pid}.` }],
    structuredContent: { pid: result.pid, backend: snapshot?.backend ?? 'pipe', state: snapshot?.isComplete ? 'completed' : 'running' },
  };
}

export function readDetachedBuildProcessOutputPage(pid: number, offset: number, length: number) {
  return terminalManager.readOutputPaginated(pid, offset, length);
}

export async function waitDetachedBuildProcess(args: JsonRecord) {
  return waitForTerminalProcess(terminalManager, {
    pid: Number(args.pid),
    timeoutMs: args.timeout_ms === undefined ? undefined : Number(args.timeout_ms),
    stallTimeoutMs: args.stall_timeout_ms === undefined ? undefined : Number(args.stall_timeout_ms),
    tailLines: args.tail_lines === undefined ? undefined : Number(args.tail_lines),
  });
}

export async function terminateDetachedBuildProcess(
  pid: number, cause: CancellationCause, detail?: string,
): Promise<boolean> {
  return terminalManager.forceTerminate(pid, cause, detail);
}
