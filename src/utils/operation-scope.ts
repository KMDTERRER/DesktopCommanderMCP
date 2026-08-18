import { setTimeout as sleepPromise } from 'node:timers/promises';

import {
  classifyRequestAbortReason, makeCancellationError,
  type CancellationCause,
} from './cancellation.js';

export interface OperationScopeOptions {
  label: string;
  timeoutMs?: number;
  deadlineAt?: number;
  parentSignal?: AbortSignal;
  timerRef?: boolean;
}

function finiteDeadline(options: OperationScopeOptions): number {
  const candidates: number[] = [];
  if (options.deadlineAt !== undefined) {
    if (!Number.isFinite(options.deadlineAt)) throw new Error(`${options.label}.deadlineAt must be finite.`);
    candidates.push(options.deadlineAt);
  }
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      throw new Error(`${options.label}.timeoutMs must be a non-negative finite number.`);
    }
    candidates.push(Date.now() + options.timeoutMs);
  }
  if (candidates.length === 0) throw new Error(`${options.label} requires timeoutMs or deadlineAt.`);
  return Math.min(...candidates);
}

function deadlineError(label: string): Error {
  return makeCancellationError('deadline_exceeded', `${label} deadline exceeded (timed out).`, 'ETIMEDOUT');
}

function reasonAsError(label: string, reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const cause = classifyRequestAbortReason(reason);
  return cause === 'deadline_exceeded'
    ? deadlineError(label)
    : makeCancellationError(cause, `${label} cancelled.`, 'ECANCELED');
}

export class OperationScope {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly label: string;

  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly timerRef: boolean;
  private readonly deadlinePromise: Promise<never>;
  private disposed = false;

  constructor(options: OperationScopeOptions) {
    this.label = options.label;
    this.deadlineAt = finiteDeadline(options);
    this.signal = options.parentSignal
      ? AbortSignal.any([options.parentSignal, this.controller.signal])
      : this.controller.signal;

    this.timerRef = options.timerRef !== false;
    const delay = Math.max(0, this.deadlineAt - Date.now());
    let deadlineTimer!: NodeJS.Timeout;
    this.deadlinePromise = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        const error = deadlineError(this.label);
        if (!this.controller.signal.aborted) this.controller.abort(error);
        reject(error);
      }, delay);
    });
    // The hard deadline is an independent rejection path, not merely an AbortSignal.
    // This guarantees request release even if a runtime/library ignores abort().
    void this.deadlinePromise.catch(() => undefined);
    this.timer = deadlineTimer;
    if (!this.timerRef) this.timer.unref?.();
  }

  remainingMs(label = this.label, minimum = 1, maximum = Number.POSITIVE_INFINITY): number {
    this.throwIfAborted(label);
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      const error = deadlineError(label);
      if (!this.controller.signal.aborted) this.controller.abort(error);
      throw error;
    }
    return Math.max(minimum, Math.min(maximum, remaining));
  }

  throwIfAborted(label = this.label): void {
    if (this.signal.aborted) throw reasonAsError(label, this.signal.reason);
    // Time remains authoritative even when AbortController.abort() is ineffective.
    if (Date.now() >= this.deadlineAt) throw deadlineError(label);
  }

  async run<T>(operation: (signal: AbortSignal) => PromiseLike<T>, label = this.label): Promise<T> {
    this.throwIfAborted(label);
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(reasonAsError(label, this.signal.reason));
      this.signal.addEventListener('abort', abortListener, { once: true });
    });
    const work = Promise.resolve().then(() => operation(this.signal));
    // A non-cooperative operation may settle after the scope. Observe it so a
    // late rejection never becomes unhandled; ownership cleanup stays with the
    // operation-specific layer (process tree, transport, etc.).
    void work.catch(() => undefined);
    try {
      return await Promise.race([work, aborted, this.deadlinePromise]);
    } finally {
      if (abortListener) this.signal.removeEventListener('abort', abortListener);
    }
  }

  async sleep(ms: number, options: { ref?: boolean; label?: string } = {}): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('OperationScope.sleep ms must be non-negative and finite.');
    const label = options.label ?? this.label;
    const delay = Math.min(ms, this.remainingMs(label));
    try {
      await sleepPromise(delay, undefined, { signal: this.signal, ref: options.ref ?? this.timerRef });
    } catch (error) {
      if (this.signal.aborted) throw reasonAsError(label, this.signal.reason);
      throw error;
    }
    this.throwIfAborted(label);
  }

  child(label: string, timeoutMs?: number): OperationScope {
    return new OperationScope({
      label,
      deadlineAt: this.deadlineAt,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      parentSignal: this.signal,
      timerRef: this.timerRef,
    });
  }

  cancel(cause: CancellationCause = 'client_cancelled', detail?: string): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(makeCancellationError(cause, detail ?? `${this.label} cancelled.`));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
  }
}

export async function withOperationScope<T>(
  options: OperationScopeOptions,
  operation: (scope: OperationScope) => Promise<T>,
): Promise<T> {
  const scope = new OperationScope(options);
  try { return await operation(scope); }
  finally { scope.dispose(); }
}

export function remainingOperationMs(
  deadlineAt: number, label: string, minimum = 1, maximum = Number.POSITIVE_INFINITY,
): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw deadlineError(label);
  }
  return Math.max(minimum, Math.min(maximum, remaining));
}

export async function waitForOperationUntil<T>(
  operation: PromiseLike<T>, deadlineAt: number, label: string,
  options: { parentSignal?: AbortSignal; timerRef?: boolean } = {},
): Promise<T> {
  return withOperationScope(
    { label, deadlineAt, parentSignal: options.parentSignal, timerRef: options.timerRef },
    (scope) => scope.run(() => operation, label),
  );
}
