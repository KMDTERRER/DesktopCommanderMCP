export type CancellationCause =
  | 'client_cancelled'
  | 'deadline_exceeded'
  | 'transport_closed'
  | 'server_shutdown'
  | 'process_stalled'
  | 'ownership_lost';

export interface CancellationState {
  cause?: CancellationCause;
  detail?: string;
  at?: number;
}

export class ClassifiedCancellationError extends Error {
  readonly cancellationCause: CancellationCause;
  readonly code: string;

  constructor(cause: CancellationCause, message: string, code?: string) {
    super(message);
    this.name = 'ClassifiedCancellationError';
    this.cancellationCause = cause;
    this.code = code ?? (cause === 'deadline_exceeded' ? 'ETIMEDOUT' : 'ECANCELED');
  }
}

const CAUSES = new Set<CancellationCause>([
  'client_cancelled',
  'deadline_exceeded',
  'transport_closed',
  'server_shutdown',
  'process_stalled',
  'ownership_lost',
]);

export function cancellationCauseOf(value: unknown): CancellationCause | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as { cancellationCause?: unknown }).cancellationCause;
  return typeof candidate === 'string' && CAUSES.has(candidate as CancellationCause)
    ? candidate as CancellationCause
    : undefined;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return typeof value === 'string' ? value : '';
}

export function classifyRequestAbortReason(
  reason: unknown,
  fallback: CancellationCause = 'client_cancelled',
): CancellationCause {
  const explicit = cancellationCauseOf(reason);
  if (explicit) return explicit;
  const code = reason && typeof reason === 'object' && 'code' in reason
    ? String((reason as { code?: unknown }).code ?? '')
    : '';
  if (code === 'ETIMEDOUT') return 'deadline_exceeded';
  const message = errorMessage(reason).toLowerCase();
  if (/transport|connection|socket|stream/.test(message) && /closed|closing|disconnect|terminated|lost/.test(message)) {
    return 'transport_closed';
  }
  if (/server/.test(message) && /shutdown|shutting down|stopping/.test(message)) return 'server_shutdown';
  if (/ownership|claim/.test(message) && /lost|superseded|changed/.test(message)) return 'ownership_lost';
  return fallback;
}

export function makeCancellationError(
  cause: CancellationCause,
  message: string,
  code?: string,
): ClassifiedCancellationError {
  return new ClassifiedCancellationError(cause, message, code);
}

export function setCancellationState(
  state: CancellationState | undefined,
  cause: CancellationCause,
  detail?: string,
): CancellationState | undefined {
  if (!state) return undefined;
  if (!state.cause) {
    state.cause = cause;
    state.detail = detail;
    state.at = Date.now();
  }
  return state;
}
