import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { normalizeMcpArgumentsObject } from '../utils/mcp-arguments.js';
import { getToolCallContext, getToolCallSessionIdentity } from '../utils/client-context.js';
import { remainingOperationMs, waitForOperationUntil } from '../utils/operation-scope.js';
import { validatePathAuthority as validatePath } from '../tools/path-security.js';
import { buildSerenaLaunchProfile } from './serena-launch-profile.js';
import { SerenaPrivateClient, type SerenaToolInfo } from './serena-client.js';
import { SerenaSessionRegistry, type SerenaSessionBinding } from './serena-session-registry.js';
import type { ServerResult } from '../types.js';

const CALL_TIMEOUT_MAX_MS = 45_000;
const COLD_START_WAIT_MS = 15_000;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_MAX = 32;
const READ_BATCH_MAX_CALLS = 16;
const READ_BATCH_MAX_CONCURRENCY = 8;
const FILE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const FILE_LOCAL_CACHE_TOOLS = new Set(['get_symbols_overview', 'find_symbol']);
const ALLOWED_TOOLS = new Set([
  'get_symbols_overview', 'find_symbol', 'find_referencing_symbols', 'find_implementations',
  'find_declaration', 'get_diagnostics_for_file', 'get_code_actions', 'search_for_pattern',
  'rename_symbol', 'safe_delete_symbol', 'replace_symbol_body', 'insert_before_symbol', 'insert_after_symbol',
]);
const registry = new SerenaSessionRegistry();
let workspaceGeneration = 0;

function identityHash(identity: string): string {
  return crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32);
}

function implicitIdentityHash(): string | undefined {
  const identity = getToolCallSessionIdentity();
  return identity ? identityHash(identity) : undefined;
}

function explicitToken(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !SESSION_TOKEN.test(value)) {
    throw new Error('Serena workspace session must be an opaque 8-128 character token.');
  }
  return value;
}

function sameWorkspacePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function newToken(): string {
  return `ws_${crypto.randomBytes(18).toString('base64url')}`;
}

function boundedDeadline(timeoutMs: number): number {
  return Date.now() + Math.max(100, Math.min(timeoutMs, CALL_TIMEOUT_MAX_MS));
}

async function validateWorkspaceRoot(value: unknown, deadlineAt: number): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new Error('serena_workspace.root must be a non-empty project directory path.');
  }
  const validated = await validatePath(value.trim(), remainingOperationMs(deadlineAt, 'Validate Serena workspace root'));
  const stats = await waitForOperationUntil(fs.stat(validated), deadlineAt, 'Stat Serena workspace root');
  if (!stats.isDirectory()) throw new Error(`Serena workspace root is not a directory: ${validated}`);
  return fs.realpath(validated);
}

function bindingForCall(session: unknown): SerenaSessionBinding {
  const explicit = explicitToken(session);
  const owner = implicitIdentityHash();
  const token = explicit ?? (owner ? registry.tokenForOwner(owner) : undefined);
  const binding = token ? registry.get(token) : undefined;
  if (!binding) {
    throw new Error('No Serena workspace is bound for this chat/session. Call desktop-context/serena_workspace operation=bind first.');
  }
  if (owner && binding.ownerIdentityHash && binding.ownerIdentityHash !== owner) {
    throw new Error('Serena workspace session belongs to a different chat/session identity.');
  }
  if (owner && !binding.ownerIdentityHash && explicit) {
    throw new Error('Identity-bound calls cannot adopt an unowned explicit Serena workspace token. Bind a workspace in this chat first.');
  }
  touch(binding);
  return binding;
}

function touch(binding: SerenaSessionBinding): void {
  binding.lastUsedAt = Date.now();
  scheduleIdle(binding);
}

function scheduleIdle(binding: SerenaSessionBinding): void {
  if (binding.idleTimer) clearTimeout(binding.idleTimer);
  const timer = setTimeout(() => {
    if (registry.get(binding.token) !== binding) return;
    if (Date.now() - binding.lastUsedAt < SESSION_IDLE_TIMEOUT_MS) {
      scheduleIdle(binding);
      return;
    }
    void hibernate(binding).catch(() => undefined);
  }, SESSION_IDLE_TIMEOUT_MS);
  timer.unref();
  binding.idleTimer = timer;
}

async function hibernate(binding: SerenaSessionBinding): Promise<void> {
  if (registry.get(binding.token) !== binding) return;
  if (Date.now() - binding.lastUsedAt < SESSION_IDLE_TIMEOUT_MS) {
    scheduleIdle(binding);
    return;
  }
  if (binding.idleTimer) clearTimeout(binding.idleTimer);
  binding.idleTimer = undefined;
  const client = binding.client;
  binding.client = undefined;
  binding.warmup = undefined;
  binding.transportReady = false;
  binding.transportReadyAt = undefined;
  binding.semanticReady = false;
  binding.lastError = undefined;
  binding.pendingReads.clear();
  binding.completedReads.clear();
  if (client) await client.close(Date.now() + 5_000).catch(() => undefined);
}

async function closeBinding(binding: SerenaSessionBinding): Promise<void> {
  if (binding.idleTimer) clearTimeout(binding.idleTimer);
  binding.idleTimer = undefined;
  registry.delete(binding);
  const client = binding.client;
  binding.client = undefined;
  binding.warmup = undefined;
  binding.pendingReads.clear();
  binding.completedReads.clear();
  if (client) await client.close(Date.now() + 5_000).catch(() => undefined);
}

async function settledWithin<T>(promise: Promise<T>, waitMs: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => { timer = setTimeout(() => resolve({ done: false }), Math.max(1, waitMs)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function coldStart(binding: SerenaSessionBinding, stage: string) {
  return {
    status: 'cold_start', workspaceSession: binding.token, root: binding.root, stage, retryAfterMs: 3000,
    message: 'Serena is still starting for this workspace. Keep this workspaceSession and retry the same call; do not create another Serena process.',
  };
}

async function startWarmup(binding: SerenaSessionBinding): Promise<void> {
  if (binding.warmup) return binding.warmup;
  const deadlineAt = Date.now() + CALL_TIMEOUT_MAX_MS;
  let warmup!: Promise<void>;
  warmup = (async () => {
    const profile = await buildSerenaLaunchProfile(binding.root, binding.templateServer);
    if (registry.get(binding.token) !== binding) return;
    if (!binding.client || binding.profileFingerprint !== profile.profileFingerprint) {
      const previous = binding.client;
      binding.client = new SerenaPrivateClient(profile);
      binding.profileFingerprint = profile.profileFingerprint;
      if (previous) await previous.close(Date.now() + 5_000).catch(() => undefined);
    }
    await binding.client.ensureStarted(deadlineAt);
    await binding.client.listTools(deadlineAt);
    if (registry.get(binding.token) !== binding) {
      await binding.client.close(Date.now() + 5_000).catch(() => undefined);
      return;
    }
    binding.transportReady = true;
    binding.transportReadyAt = Date.now();
    binding.lastError = undefined;
  })().catch((error) => {
    binding.transportReady = false;
    binding.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }).finally(() => {
    if (binding.warmup === warmup) binding.warmup = undefined;
  });
  binding.warmup = warmup;
  void warmup.catch(() => undefined);
  return warmup;
}

export async function callSerenaWorkspaceTool(args: Record<string, unknown>, timeoutMs = 30_000) {
  const allowed = new Set(['operation', 'root', 'session', 'templateServer', 'warm']);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`serena_workspace received unsupported argument(s): ${unknown.join(', ')}.`);
  const operation = args.operation;
  if (operation !== 'bind' && operation !== 'status' && operation !== 'release') {
    throw new Error('serena_workspace.operation must be bind, status, or release.');
  }
  const deadlineAt = boundedDeadline(timeoutMs);
  if (operation !== 'bind') {
    const binding = bindingForCall(args.session);
    if (operation === 'release') {
      await closeBinding(binding);
      return { status: 'released', workspaceSession: binding.token, root: binding.root };
    }
    return {
      status: binding.lastError ? 'failed' : binding.semanticReady ? 'ready' : binding.transportReady ? 'warming' : 'starting',
      workspaceSession: binding.token, root: binding.root, server: 'internal-serena',
      transportReady: binding.transportReady, semanticReady: binding.semanticReady,
      ageMs: Date.now() - binding.createdAt, ...(binding.lastError ? { error: binding.lastError } : {}),
    };
  }

  const root = await validateWorkspaceRoot(args.root, deadlineAt);
  const owner = implicitIdentityHash();
  const explicit = explicitToken(args.session);
  const implicit = owner ? registry.tokenForOwner(owner) : undefined;
  const token = explicit ?? implicit ?? newToken();
  const templateServer = args.templateServer === undefined ? undefined : String(args.templateServer);
  if (templateServer && !TOOL_NAME.test(templateServer)) throw new Error('serena_workspace.templateServer is invalid.');
  if (templateServer && templateServer !== 'serena-primary' && templateServer !== 'serena-primary-cpp' && templateServer !== 'serena-secondary') {
    throw new Error(`Unsupported legacy Serena template '${templateServer}'.`);
  }
  const previous = registry.get(token);
  if (previous && owner && previous.ownerIdentityHash && previous.ownerIdentityHash !== owner) {
    throw new Error('Serena workspace session belongs to a different chat/session identity.');
  }
  const sameBinding = Boolean(previous && sameWorkspacePath(previous.root, root) && previous.templateServer === templateServer);
  if (previous && !sameBinding) await closeBinding(previous);
  if (!sameBinding && registry.size >= SESSION_MAX) {
    const oldest = registry.values().sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (oldest) await closeBinding(oldest);
  }
  const binding: SerenaSessionBinding = sameBinding ? previous! : {
    token, ownerIdentityHash: owner, root, templateServer, workspaceGeneration: ++workspaceGeneration,
    createdAt: Date.now(), lastUsedAt: Date.now(), transportReady: false, semanticReady: false,
    pendingReads: new Map(), completedReads: new Map(),
  };
  if (owner && !binding.ownerIdentityHash) binding.ownerIdentityHash = owner;
  touch(binding);
  registry.bind(binding);
  if (args.warm !== false) void startWarmup(binding).catch(() => undefined);
  return {
    status: binding.semanticReady ? 'ready' : binding.transportReady ? 'warming' : 'starting',
    workspaceSession: token, sessionIdentity: owner ? 'transport' : 'explicit-token-required',
    root, server: 'internal-serena', coldStartWaitMs: COLD_START_WAIT_MS,
  };
}

function discoveredReadOnly(tool: SerenaToolInfo): boolean {
  const annotations = tool.annotations;
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return false;
  return annotations.readOnlyHint === true && annotations.destructiveHint !== true;
}

function readCacheKey(tool: string, args: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(tool).update('\0').update(JSON.stringify(args)).digest('hex');
}

async function fileCacheDependency(
  binding: SerenaSessionBinding, tool: string, args: Record<string, unknown>, deadlineAt: number,
): Promise<{ relativePath: string; contentHash: string } | undefined> {
  if (!FILE_LOCAL_CACHE_TOOLS.has(tool)) return undefined;
  const requested = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
  if (!requested || path.isAbsolute(requested)) return undefined;
  const lexical = path.resolve(binding.root, requested);
  const resolved = await Promise.all([fs.realpath(binding.root), fs.realpath(lexical)]).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [undefined, undefined] as const;
    throw error;
  });
  const [rootReal, fileReal] = resolved;
  if (!rootReal || !fileReal) return undefined;
  const relative = path.relative(rootReal, fileReal);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  const stats = await waitForOperationUntil(fs.stat(fileReal), deadlineAt, 'Stat Serena cache dependency');
  if (!stats.isFile() || stats.size > FILE_CACHE_MAX_BYTES) return undefined;
  const bytes = await waitForOperationUntil(fs.readFile(fileReal), deadlineAt, 'Read Serena cache dependency');
  return { relativePath: relative.replace(/\\/g, '/'), contentHash: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export async function callSessionSerenaTool(
  args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MAX_MS, requireReadOnly = false,
) {
  const allowed = new Set(['tool', 'arguments', 'session']);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`serena_call received unsupported argument(s): ${unknown.join(', ')}.`);
  if (typeof args.tool !== 'string' || !TOOL_NAME.test(args.tool)) throw new Error('serena_call.tool is invalid.');
  const tool = args.tool;
  if (!ALLOWED_TOOLS.has(tool)) throw new Error(`Serena tool '${tool}' is not exposed by Desktop Commander.`);
  const toolArguments = normalizeMcpArgumentsObject(args.arguments, 'serena_call.arguments');
  const binding = bindingForCall(args.session);
  const warmup = startWarmup(binding);
  const warm = await settledWithin(warmup, Math.min(COLD_START_WAIT_MS, timeoutMs));
  if (!warm.done) return coldStart(binding, 'transport');
  await warmup;

  const deadlineAt = boundedDeadline(timeoutMs);
  const client = binding.client;
  if (!client) throw new Error('Private Serena client was not created after warmup.');
  const tools = await client.listTools(deadlineAt);
  const selected = tools.find((candidate) => candidate.name === tool);
  if (!selected) throw new Error(`Serena tool '${tool}' is not available for this workspace.`);
  const readOnly = discoveredReadOnly(selected);
  if (requireReadOnly && !readOnly) {
    throw new Error(`Serena read batch requires a read-only tool; '${tool}' is not read-only.`);
  }

  if (readOnly) {
    const cacheKey = readCacheKey(tool, toolArguments);
    const dependency = await fileCacheDependency(binding, tool, toolArguments, deadlineAt);
    const cached = binding.completedReads.get(cacheKey);
    if (cached) {
      if (dependency && cached.clientGeneration === client.generation &&
          cached.workspaceGeneration === binding.workspaceGeneration &&
          cached.relativePath === dependency.relativePath && cached.contentHash === dependency.contentHash) {
        return { status: 'ready', workspaceSession: binding.token, root: binding.root, cached: true, result: cached.result };
      }
      binding.completedReads.delete(cacheKey);
    }
    let pending = binding.pendingReads.get(cacheKey);
    if (!pending) {
      const callDeadline = Date.now() + CALL_TIMEOUT_MAX_MS;
      const cachedWorkspaceGeneration = binding.workspaceGeneration;
      let pendingPromise!: Promise<ServerResult>;
      const releasePending = () => {
        if (binding.pendingReads.get(cacheKey) === pendingPromise) binding.pendingReads.delete(cacheKey);
      };
      // Read-only work is coalesced for the binding. A single caller cancellation must not
      // abort the shared semantic request that another concurrent caller is awaiting.
      pendingPromise = client.callTool(tool, toolArguments, callDeadline, { retryReadOnly: true }).then((result) => {
        binding.semanticReady = true;
        binding.lastError = undefined;
        const clientGeneration = client.generation;
        if (!dependency) {
          queueMicrotask(releasePending);
          return result;
        }
        void fileCacheDependency(binding, tool, toolArguments, Date.now() + 5_000).then((after) => {
          if (registry.get(binding.token) !== binding) return;
          if (binding.client !== client || binding.workspaceGeneration !== cachedWorkspaceGeneration) return;
          if (after && after.relativePath === dependency.relativePath && after.contentHash === dependency.contentHash) {
            binding.completedReads.set(cacheKey, {
              result, clientGeneration, workspaceGeneration: cachedWorkspaceGeneration,
              relativePath: dependency.relativePath, contentHash: dependency.contentHash,
            });
            while (binding.completedReads.size > 16) {
              binding.completedReads.delete(binding.completedReads.keys().next().value!);
            }
          }
        }).catch(() => undefined).finally(releasePending);
        return result;
      }).catch((error) => {
        binding.lastError = error instanceof Error ? error.message : String(error);
        releasePending();
        throw error;
      });
      pending = pendingPromise;
      binding.pendingReads.set(cacheKey, pending);
      void pending.catch(() => undefined);
    }
    const settled = await settledWithin(pending, Math.min(COLD_START_WAIT_MS, timeoutMs));
    if (!settled.done) return coldStart(binding, 'semantic');
    return { status: 'ready', workspaceSession: binding.token, root: binding.root, cached: false, result: settled.value };
  }

  binding.completedReads.clear();
  if (!binding.semanticReady && binding.transportReadyAt) {
    const remainingWarmWindow = COLD_START_WAIT_MS - (Date.now() - binding.transportReadyAt);
    if (remainingWarmWindow > 0) await new Promise((resolve) => setTimeout(resolve, remainingWarmWindow));
  }
  const result = await client.callTool(tool, toolArguments, boundedDeadline(timeoutMs), {
    signal: getToolCallContext().requestSignal,
  });
  binding.semanticReady = true;
  binding.lastError = undefined;
  return { status: 'ready', workspaceSession: binding.token, root: binding.root, cached: false, result };
}

export async function callSessionSerenaReadBatch(
  args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MAX_MS,
) {
  const allowed = new Set(['calls', 'session', 'concurrency']);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`serena_read_batch received unsupported argument(s): ${unknown.join(', ')}.`);
  if (!Array.isArray(args.calls) || args.calls.length < 1 || args.calls.length > READ_BATCH_MAX_CALLS) {
    throw new Error(`serena_read_batch.calls must contain 1-${READ_BATCH_MAX_CALLS} calls.`);
  }
  const concurrency = args.concurrency === undefined ? 4 : Number(args.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > READ_BATCH_MAX_CONCURRENCY) {
    throw new Error(`serena_read_batch.concurrency must be an integer from 1 to ${READ_BATCH_MAX_CONCURRENCY}.`);
  }
  const calls = args.calls.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`serena_read_batch.calls[${index}] must be an object.`);
    }
    const item = raw as Record<string, unknown>;
    const itemUnknown = Object.keys(item).filter((key) => key !== 'tool' && key !== 'arguments');
    if (itemUnknown.length) throw new Error(`serena_read_batch.calls[${index}] has unsupported field(s): ${itemUnknown.join(', ')}.`);
    if (typeof item.tool !== 'string' || !TOOL_NAME.test(item.tool) || !ALLOWED_TOOLS.has(item.tool)) {
      throw new Error(`serena_read_batch.calls[${index}].tool is invalid or not exposed.`);
    }
    return { tool: item.tool, arguments: normalizeMcpArgumentsObject(item.arguments, `serena_read_batch.calls[${index}].arguments`) };
  });
  const binding = bindingForCall(args.session);
  const warmup = startWarmup(binding);
  const warm = await settledWithin(warmup, Math.min(COLD_START_WAIT_MS, timeoutMs));
  if (!warm.done) return { ...coldStart(binding, 'transport'), results: [], requestedCalls: calls.length };
  await warmup;
  const deadlineAt = boundedDeadline(timeoutMs);
  const results = new Array<unknown>(calls.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= calls.length) return;
      const item = calls[index];
      const outcome = await callSessionSerenaTool(
        { tool: item.tool, arguments: item.arguments, session: binding.token },
        remainingOperationMs(deadlineAt, `Serena read batch call ${index}`), true,
      );
      results[index] = 'cached' in outcome && 'result' in outcome
        ? {
            index, tool: item.tool, status: outcome.status, cached: outcome.cached === true,
            ...(outcome.result === undefined ? {} : { result: outcome.result }),
          }
        : { index, tool: item.tool, status: outcome.status };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, calls.length) }, worker));
  const allReady = results.every((value) =>
    !!value && typeof value === 'object' && (value as Record<string, unknown>).status === 'ready');
  return {
    status: allReady ? 'ready' : 'cold_start', workspaceSession: binding.token, root: binding.root,
    concurrency: Math.min(concurrency, calls.length), results,
  };
}

export async function assertSessionSerenaContextWorkspace(
  session: string, requestedRoot: string, timeoutMs: number,
): Promise<{ requestedRoot: string; boundRoot: string }> {
  const deadlineAt = boundedDeadline(timeoutMs);
  const binding = bindingForCall(session);
  const requested = await validateWorkspaceRoot(requestedRoot, deadlineAt);
  const canonicalBound = await waitForOperationUntil(fs.realpath(binding.root), deadlineAt, 'Resolve Serena session workspace');
  if (!sameWorkspacePath(requested, canonicalBound)) {
    throw new Error(`Serena workspace session '${binding.token}' is bound to '${canonicalBound}' and cannot provide context for '${requested}'.`);
  }
  return { requestedRoot: requested, boundRoot: canonicalBound };
}

export async function callTrustedReadOnlySessionSerenaTool(
  session: string, tool: string, args: Record<string, unknown>, timeoutMs: number,
): Promise<ServerResult> {
  const outcome = await callSessionSerenaTool({ tool, arguments: args, session }, timeoutMs, true);
  if (outcome.status !== 'ready' || !('result' in outcome)) {
    const error = new Error(
      `Serena workspace session '${session}' is still ${outcome.status}; retry code_context with the same semanticSession.`,
    ) as NodeJS.ErrnoException;
    error.code = 'EAGAIN';
    throw error;
  }
  return outcome.result;
}

export async function closePrivateSerenaRuntime(): Promise<void> {
  const bindings = registry.values();
  await Promise.all(bindings.map((binding) => closeBinding(binding)));
}

export function privateSerenaRuntimeStatus() {
  return {
    sessions: registry.values().map((binding) => ({
      workspaceSession: binding.token, root: binding.root, transportReady: binding.transportReady,
      semanticReady: binding.semanticReady, workspaceGeneration: binding.workspaceGeneration,
      profileFingerprint: binding.profileFingerprint ?? 'unresolved',
    })),
  };
}
