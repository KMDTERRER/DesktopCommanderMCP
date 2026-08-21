export const PROCESS_WAIT_DEFAULT_MS = 90_000;
export const PROCESS_WAIT_MAX_MS = 7 * 60_000;
export const CPP_BUILD_AUTO_OBSERVE_MAX_MS = 30_000;
// Remote tool RPCs must periodically return control to the model even when the
// owned terminal session is still healthy. The process itself is never killed;
// callers can observe the same PID again.
export const PROCESS_REMOTE_OBSERVE_MAX_MS = 30_000;
export const PROCESS_STALL_DEFAULT_MS = 0;
export const PROCESS_INTERACTION_DEFAULT_MS = 8_000;
export const PROCESS_TRANSPORT_RESERVE_MS = 10_000;
export const PROCESS_TRANSPORT_TIMEOUT_MAX_MS = PROCESS_WAIT_MAX_MS + PROCESS_TRANSPORT_RESERVE_MS;
export const PROCESS_CLIENT_RESPONSE_RESERVE_MS = 5_000;
export const PROCESS_CLIENT_TIMEOUT_MAX_MS = PROCESS_TRANSPORT_TIMEOUT_MAX_MS + PROCESS_CLIENT_RESPONSE_RESERVE_MS;
export const PROCESS_INITIAL_OUTPUT_MAX_CHARS = 64 * 1024;
export const PROCESS_STRUCTURED_OUTPUT_MAX_CHARS = 64 * 1024;

export type ProcessWaitToolName =
  | 'start_process'
  | 'read_process_output'
  | 'interact_with_process'
  | 'wait_process'
  | 'cpp_build_execute';

export function isProcessWaitToolName(tool: string): tool is ProcessWaitToolName {
  return tool === 'start_process' || tool === 'read_process_output' ||
    tool === 'interact_with_process' || tool === 'wait_process' || tool === 'cpp_build_execute';
}

export function processObservationWaitMs(requestedMs: number, isRemote: boolean): number {
  return isRemote ? Math.min(requestedMs, PROCESS_REMOTE_OBSERVE_MAX_MS) : requestedMs;
}

export function processToolWaitMs(tool: string, args: Record<string, unknown>): number | null {
  if (!isProcessWaitToolName(tool)) return null;
  const fallback = tool === 'interact_with_process' ? PROCESS_INTERACTION_DEFAULT_MS : PROCESS_WAIT_DEFAULT_MS;
  const timeoutKey = tool === 'cpp_build_execute' ? 'timeoutMs' : 'timeout_ms';
  const requested = typeof args[timeoutKey] === 'number' ? args[timeoutKey] as number : fallback;
  const minimum = tool === 'cpp_build_execute' ? 1_000 : 0;
  if (!Number.isInteger(requested) || requested < minimum || requested > PROCESS_WAIT_MAX_MS) {
    throw new Error(`${tool}.${timeoutKey} must be an integer from ${minimum} to ${PROCESS_WAIT_MAX_MS}ms.`);
  }
  if (tool === 'cpp_build_execute') {
    const mode = args.executionMode ?? 'auto';
    if (mode === 'resumable') return 0;
    if (mode !== 'inline') return Math.min(requested, CPP_BUILD_AUTO_OBSERVE_MAX_MS);
  }
  return requested;
}
