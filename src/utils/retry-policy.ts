import type { OperationScope } from './operation-scope.js';

export type RetrySafety = 'read_only' | 'idempotent' | 'reconciled';
export type RetryJitter = 'none' | 'full';

export interface RetryPolicy {
  safety: RetrySafety;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter?: RetryJitter;
  isRetryable: (error: unknown, attempt: number) => boolean;
  random?: () => number;
}

export interface RetryAttemptContext {
  attempt: number;
  scope: OperationScope;
}

function validatePolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 100) {
    throw new Error('RetryPolicy.maxAttempts must be an integer from 1 to 100.');
  }
  if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw new Error('RetryPolicy.baseDelayMs must be a non-negative finite number.');
  }
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error('RetryPolicy.maxDelayMs must be finite and >= baseDelayMs.');
  }
}

export function retryDelayMs(policy: RetryPolicy, failedAttempt: number): number {
  validatePolicy(policy);
  const exponent = Math.max(0, failedAttempt - 1);
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  if ((policy.jitter ?? 'full') === 'none' || cap <= 0) return Math.round(cap);
  const random = policy.random ?? Math.random;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new Error('RetryPolicy.random must return a number from 0 to 1.');
  }
  return Math.floor(sample * cap);
}

export async function retryWithPolicy<T>(
  scope: OperationScope,
  policy: RetryPolicy,
  operation: (context: RetryAttemptContext) => Promise<T>,
): Promise<T> {
  validatePolicy(policy);
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    scope.throwIfAborted();
    try {
      return await operation({ attempt, scope });
    } catch (error) {
      lastError = error;
      if (attempt >= policy.maxAttempts || !policy.isRetryable(error, attempt)) throw error;
      const delayMs = retryDelayMs(policy, attempt);
      if (delayMs > 0) await scope.sleep(delayMs, { label: 'Retry backoff' });
    }
  }
  throw lastError ?? new Error('Retry policy exhausted without an attempt result.');
}
