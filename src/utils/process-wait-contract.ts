export const PROCESS_WAIT_DEFAULT_MS = 90_000;
export const PROCESS_WAIT_MAX_MS = 7 * 60_000;
export const PROCESS_STALL_DEFAULT_MS = 0;
export const PROCESS_INTERACTION_DEFAULT_MS = 8_000;
export const PROCESS_TRANSPORT_RESERVE_MS = 10_000;
export const PROCESS_TRANSPORT_TIMEOUT_MAX_MS = PROCESS_WAIT_MAX_MS + PROCESS_TRANSPORT_RESERVE_MS;
export const PROCESS_CLIENT_RESPONSE_RESERVE_MS = 5_000;
export const PROCESS_CLIENT_TIMEOUT_MAX_MS = PROCESS_TRANSPORT_TIMEOUT_MAX_MS + PROCESS_CLIENT_RESPONSE_RESERVE_MS;
export const PROCESS_INITIAL_OUTPUT_MAX_CHARS = 64 * 1024;

export type ProcessWaitToolName =
  | 'start_process'
  | 'read_process_output'
  | 'interact_with_process'
  | 'wait_process';

export function isProcessWaitToolName(tool: string): tool is ProcessWaitToolName {
  return tool === 'start_process' || tool === 'read_process_output' ||
    tool === 'interact_with_process' || tool === 'wait_process';
}

export function processToolWaitMs(tool: string, args: Record<string, unknown>): number | null {
  if (!isProcessWaitToolName(tool)) return null;
  const fallback = tool === 'interact_with_process' ? PROCESS_INTERACTION_DEFAULT_MS : PROCESS_WAIT_DEFAULT_MS;
  const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : fallback;
  if (!Number.isInteger(requested) || requested < 0 || requested > PROCESS_WAIT_MAX_MS) {
    throw new Error(`${tool}.timeout_ms must be an integer from 0 to ${PROCESS_WAIT_MAX_MS}ms.`);
  }
  return requested;
}
