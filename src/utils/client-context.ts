import { AsyncLocalStorage } from 'node:async_hooks';
import { classifyRequestAbortReason, setCancellationState, type CancellationCause, type CancellationState } from './cancellation.js';

export interface ClientInfo {
  name?: string;
  version?: string;
}

export type ToolCallCancellationCleanup = (cause?: CancellationCause) => void | Promise<void>;

export interface ToolCallContext {
  isRemote: boolean;
  remoteClient: ClientInfo | null;
  requestMetadata?: Readonly<Record<string, unknown>>;
  requestSignal?: AbortSignal;
  cancellationState?: CancellationState;
  cancellationCleanups?: Set<ToolCallCancellationCleanup>;
}

export let currentClient: ClientInfo = {
  name: 'uninitialized',
  version: 'uninitialized',
};

const toolCallContext = new AsyncLocalStorage<ToolCallContext>();

export function setCurrentClient(client: ClientInfo): void {
  currentClient = client;
}

export function runInToolCallContext<T>(context: ToolCallContext, fn: () => T): T {
  return toolCallContext.run(context, fn);
}

export function getToolCallContext(): ToolCallContext {
  return toolCallContext.getStore() ?? { isRemote: false, remoteClient: null };
}

const SESSION_METADATA_KEYS = [
  'conversation_id', 'conversationId', 'thread_id', 'threadId',
  'session_id', 'sessionId', 'chat_id', 'chatId',
] as const;

export function getToolCallSessionIdentity(): string | undefined {
  const metadata = toolCallContext.getStore()?.requestMetadata;
  if (!metadata) return undefined;
  for (const key of SESSION_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim() && value.length <= 512) {
      return `${key}:${value.trim()}`;
    }
  }
  return undefined;
}

export function registerToolCallCancellationCleanup(cleanup: ToolCallCancellationCleanup): () => void {
  const context = toolCallContext.getStore();
  if (!context?.cancellationCleanups) return () => {};
  if (context.requestSignal?.aborted) {
    const cause = context.cancellationState?.cause
      ?? classifyRequestAbortReason(context.requestSignal.reason);
    void Promise.resolve(cleanup(cause)).catch(() => {});
    return () => {};
  }
  context.cancellationCleanups.add(cleanup);
  return () => context.cancellationCleanups?.delete(cleanup);
}

export function markToolCallCancellation(cause: CancellationCause, detail?: string): void {
  const context = toolCallContext.getStore();
  setCancellationState(context?.cancellationState, cause, detail);
}

export function getToolCallCancellationState(): Readonly<CancellationState> | undefined {
  return toolCallContext.getStore()?.cancellationState;
}

export function cancelToolCallOwnedWork(
  cause: CancellationCause = 'client_cancelled',
  detail?: string,
): void {
  const context = toolCallContext.getStore();
  if (!context?.cancellationCleanups) return;
  setCancellationState(context.cancellationState, cause, detail);
  const cleanups = [...context.cancellationCleanups];
  context.cancellationCleanups.clear();
  for (const cleanup of cleanups) void Promise.resolve(cleanup(cause)).catch(() => {});
}
