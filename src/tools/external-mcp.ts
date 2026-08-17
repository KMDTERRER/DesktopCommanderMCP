import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import type { Runtime, ServerDefinition, ServerToolInfo } from 'mcporter';
import { configManager } from '../config-manager.js';
import { VERSION } from '../version.js';
import type { ServerResult } from '../types.js';
import { bindExternalMcpWorkspaceDefinition, resolveExternalMcpWorkspaceDefinition } from './external-mcp-binding.js';
import { validatePathAuthority as validatePath } from './path-security.js';
import { BUILTIN_CONTEXT_SERVER_ID, callCodeContextOrchestrator, listBuiltinContextTools } from './code-context-orchestrator.js';
import { normalizeMcpArgumentsObject } from '../utils/mcp-arguments.js';
import { isMcpCompatUri } from '../utils/mcp-uri.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { cancelToolCallOwnedWork, getToolCallSessionIdentity } from '../utils/client-context.js';
import { cancellationCauseOf, makeCancellationError } from '../utils/cancellation.js';
import {
  PROCESS_TRANSPORT_RESERVE_MS, PROCESS_TRANSPORT_TIMEOUT_MAX_MS,
  processToolWaitMs,
} from '../utils/process-wait-contract.js';
import {
  AggregateByteBudget,
  READ_MULTIPLE_MAX_OUTPUT_BYTES,
  READ_MULTIPLE_PER_FILE_OUTPUT_BYTES,
  resourceLimitError,
} from '../utils/read-resource-limits.js';

const BUILTIN_SERVER_ID = 'desktop-accelerators';
const BUILTIN_CORE_SERVER_ID = 'desktop-core';
const MCP_LIST_TIMEOUT_MAX_MS = 45_000;
const MCP_CALL_TIMEOUT_DEFAULT_MS = 45_000;
const MCP_CALL_TIMEOUT_MAX_MS = 45_000;
const MCP_RESPONSE_RESERVE_MAX_MS = 1_000;
const MCP_RUNTIME_CLOSE_TIMEOUT_MS = 3_000;
const MCP_RUNTIME_STARTUP_TIMEOUT_MS = 45_000;
const MCP_COMPAT_URI_MAX_CHARS = 4_096;
const MCP_COMPAT_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;
const MCP_PROXY_RESULT_MAX_BYTES = 8 * 1024 * 1024;
const MCP_PROXY_RESULT_MAX_NODES = 100_000;
const MCP_LIST_MAX_PAGES = 100;
const MCP_LIST_MAX_TOOLS = 10_000;
const MCP_LIST_MAX_INVALIDATION_RETRIES = 3;
const MCP_COMPAT_MULTI_MAX_FILES = 100;
const MCP_COMPAT_MULTI_CONCURRENCY = 8;
const MCP_COMPAT_MULTI_TIMEOUT_MS = 45_000;
const MCP_RUNTIME_ROOT_DIR = process.cwd();
const MCP_READ_ONLY_POLICY_ENV = 'DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY';
const MCP_READ_ONLY_POLICY_MAX_BYTES = 64 * 1024;
const MCP_READ_ONLY_POLICY_MAX_SERVERS = 128;
const MCP_READ_ONLY_POLICY_MAX_TOOLS_PER_SERVER = 256;
const MCP_READ_ONLY_POLICY_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const SERENA_COLD_START_WAIT_MS = 15_000;
const SERENA_SESSION_MAX = 32;
const SERENA_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SERENA_FILE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const SERENA_FILE_LOCAL_CACHE_TOOLS = new Set(['get_symbols_overview', 'find_symbol']);
const SERENA_SESSION_TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const SERENA_DYNAMIC_PREFIX = 'serena-session-';
const SERENA_CPP_ENV_KEYS = new Set([
  'SERENA_FORCED_LANGUAGE_SERVERS',
  'SERENA_CPP_COMPILATION_DATABASE_PATH',
  'SERENA_CPP_QUERY_DRIVERS',
  'SERENA_CPP_TOOLCHAIN_PROFILE_FINGERPRINT',
]);

type ReadOnlyRoutePolicy = Map<string, ReadonlySet<string>>;
let cachedReadOnlyRoutePolicyRaw: string | undefined;
let cachedReadOnlyRoutePolicy: ReadOnlyRoutePolicy = new Map();

function localReadOnlyRoutePolicy(): ReadOnlyRoutePolicy {
  const raw = process.env[MCP_READ_ONLY_POLICY_ENV]?.trim();
  if (!raw) {
    cachedReadOnlyRoutePolicyRaw = undefined;
    cachedReadOnlyRoutePolicy = new Map();
    return cachedReadOnlyRoutePolicy;
  }
  if (raw === cachedReadOnlyRoutePolicyRaw) return cachedReadOnlyRoutePolicy;
  if (Buffer.byteLength(raw, 'utf8') > MCP_READ_ONLY_POLICY_MAX_BYTES) {
    throw new Error(`${MCP_READ_ONLY_POLICY_ENV} exceeds ${MCP_READ_ONLY_POLICY_MAX_BYTES} bytes.`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error(`${MCP_READ_ONLY_POLICY_ENV} must contain valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${MCP_READ_ONLY_POLICY_ENV} must be a server-to-tool-list object.`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MCP_READ_ONLY_POLICY_MAX_SERVERS) {
    throw new Error(`${MCP_READ_ONLY_POLICY_ENV} contains too many servers.`);
  }
  const policy: ReadOnlyRoutePolicy = new Map();
  for (const [server, value] of entries) {
    if (!MCP_READ_ONLY_POLICY_NAME.test(server)) {
      throw new Error(`${MCP_READ_ONLY_POLICY_ENV} contains invalid server name '${server}'.`);
    }
    if (!Array.isArray(value) || value.length > MCP_READ_ONLY_POLICY_MAX_TOOLS_PER_SERVER) {
      throw new Error(`${MCP_READ_ONLY_POLICY_ENV}.${server} must be an array of at most ${MCP_READ_ONLY_POLICY_MAX_TOOLS_PER_SERVER} tools.`);
    }
    const tools = new Set<string>();
    for (const tool of value) {
      if (typeof tool !== 'string' || !MCP_READ_ONLY_POLICY_NAME.test(tool)) {
        throw new Error(`${MCP_READ_ONLY_POLICY_ENV}.${server} contains an invalid tool name.`);
      }
      tools.add(tool);
    }
    policy.set(server, tools);
  }
  cachedReadOnlyRoutePolicyRaw = raw;
  cachedReadOnlyRoutePolicy = policy;
  return policy;
}

function isLocallyTrustedReadOnlyExternalTool(server: string, tool: string): boolean {
  return localReadOnlyRoutePolicy().get(server)?.has(tool) === true;
}

function boundedTimeout(value: number | undefined, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 100 || value > maximum) {
    throw new Error(`${label} must be an integer from 100 to ${maximum}ms.`);
  }
  return value;
}

function operationTimeout(timeoutMs: number): number {
  return Math.max(100, timeoutMs - Math.min(MCP_RESPONSE_RESERVE_MAX_MS, Math.floor(timeoutMs / 10)));
}

function isLocalProcessWaitTarget(server: string, tool: string): boolean {
  return (server === BUILTIN_CORE_SERVER_ID && (
    tool === 'start_process' || tool === 'read_process_output' || tool === 'interact_with_process'
  )) || (server === BUILTIN_SERVER_ID && tool === 'wait_process');
}

function localProcessTransportBudget(server: string, tool: string, args: Record<string, unknown>): number | null {
  if (!isLocalProcessWaitTarget(server, tool)) return null;
  const waitMs = processToolWaitMs(tool, args);
  if (waitMs === null) return null;
  return Math.min(PROCESS_TRANSPORT_TIMEOUT_MAX_MS, waitMs + PROCESS_TRANSPORT_RESERVE_MS);
}

function callTimeoutMaximum(server: string, tool: string): number {
  return isLocalProcessWaitTarget(server, tool) ? PROCESS_TRANSPORT_TIMEOUT_MAX_MS : MCP_CALL_TIMEOUT_MAX_MS;
}

function callTimeoutFallback(server: string, tool: string, args: Record<string, unknown>): number {
  return localProcessTransportBudget(server, tool, args) ?? MCP_CALL_TIMEOUT_DEFAULT_MS;
}

function assertProcessTransportBudget(
  server: string, tool: string, args: Record<string, unknown>, timeoutMs: number, label: string,
): void {
  const required = localProcessTransportBudget(server, tool, args);
  if (required !== null && timeoutMs < required) {
    throw new Error(
      `${label} must be at least ${required}ms for ${server}/${tool}; ` +
      `the process wait is ${required - PROCESS_TRANSPORT_RESERVE_MS}ms and ${PROCESS_TRANSPORT_RESERVE_MS}ms is reserved for PID/result delivery.`,
    );
  }
}

function compatDispatchTimeout(
  server: string, tool: string, args: Record<string, unknown>, totalTimeout: number, remaining: number,
): number {
  const genericBudget = Math.min(totalTimeout, operationTimeout(remaining));
  const processRequired = localProcessTransportBudget(server, tool, args);
  if (processRequired === null) return genericBudget;

  // Process calls already reserve PROCESS_TRANSPORT_RESERVE_MS for PID/result
  // delivery. Do not subtract the generic compatibility reserve a second time
  // below that advertised minimum, or an exactly-valid wait+reserve timeout
  // becomes self-invalidating at the next proxy layer. Use the generic reserve
  // whenever there is headroom; consume it only at the exact lower boundary.
  return Math.min(totalTimeout, Math.max(processRequired, genericBudget));
}

function remainingDeadline(deadlineAt: number, label: string): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    const error = new Error(`${label} deadline exceeded.`) as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return remaining;
}

async function builtinAccelerators() {
  return import('./workspace-accelerators.js');
}

async function builtinCore() {
  return import('./core-mcp.js');
}

function sameWorkspacePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function assertExternalContextWorkspace(
  server: string, requestedRoot: string, timeoutMs: number, relation: 'exact' | 'ancestor',
): Promise<{ requestedRoot: string; boundRoot: string }> {
  if (server === BUILTIN_SERVER_ID || server === BUILTIN_CORE_SERVER_ID || server === BUILTIN_CONTEXT_SERVER_ID) {
    throw new Error(`code_context requires an external workspace-bound server, got '${server}'.`);
  }
  const bounded = boundedTimeout(timeoutMs, 10_000, MCP_CALL_TIMEOUT_MAX_MS, 'code_context workspace timeout');
  const deadlineAt = Date.now() + bounded;
  const requested = await runWithAbortableTimeout(
    (_signal) => fs.realpath(path.resolve(requestedRoot)), remainingDeadline(deadlineAt, 'code_context requested workspace'),
    `Resolve code_context requested workspace ${requestedRoot}`,
  );
  const bound = await withRuntimeLease(deadlineAt, async (runtime) => {
    const definition = runtime.getDefinition(server);
    return resolveExternalMcpWorkspaceDefinition(definition, deadlineAt);
  });
  if (!bound) throw new Error(`MCP server '${server}' has no authoritative workspace binding and cannot be used by code_context.`);
  const canonicalBound = await runWithAbortableTimeout(
    (_signal) => fs.realpath(bound), remainingDeadline(deadlineAt, 'code_context bound workspace'),
    `Resolve code_context bound workspace ${bound}`,
  );
  const exact = sameWorkspacePath(requested, canonicalBound);
  const relative = path.relative(canonicalBound, requested);
  const insideBound = exact || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if ((relation === 'exact' && !exact) || (relation === 'ancestor' && !insideBound)) {
    const expected = relation === 'exact' ? 'exactly' : 'at or above';
    throw new Error(
      `MCP server '${server}' is bound to '${canonicalBound}' and cannot provide context for requested root '${requested}'; ` +
      `code_context requires the binding to be ${expected} that root.`,
    );
  }
  return { requestedRoot: requested, boundRoot: canonicalBound };
}

async function callTrustedReadOnlyExternalMcpTool(
  server: string, tool: string, args: Record<string, unknown>, timeoutMs: number,
): Promise<unknown> {
  if (!isLocallyTrustedReadOnlyExternalTool(server, tool)) {
    throw new Error(`code_context requires locally trusted read-only tool '${server}/${tool}'.`);
  }
  return callExternalMcpTool({ server, tool, arguments: args, timeout_ms: timeoutMs });
}

function deadlineError(label: string): NodeJS.ErrnoException {
  return makeCancellationError(
    'deadline_exceeded', `${label} deadline exceeded.`, 'ETIMEDOUT',
  ) as NodeJS.ErrnoException;
}

async function waitForPromiseUntil<T>(promise: PromiseLike<T>, deadlineAt: number, label: string): Promise<T> {
  const remaining = remainingDeadline(deadlineAt, label);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(deadlineError(label)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeRuntimeBounded(
  runtime: Runtime | undefined,
  timeoutMs = MCP_RUNTIME_CLOSE_TIMEOUT_MS,
): Promise<void> {
  if (!runtime) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runtime.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const EXTERNAL_MCP_ROUTING_GUIDANCE =
  'For repository work, start with desktop-accelerators/workspace_snapshot instead of repeating Git preflight shell calls. Reuse desktop-accelerators/workspace_delta cursors between turns to avoid rediscovering unchanged worktree state. For one broad context request that needs CRG impact plus bounded source retrieval, prefer desktop-context/code_context; add explicit symbolQueries only when exact symbol names are already known, because this deterministic layer never infers symbol identity from natural-language prose. For bulk or multi-symbol code_context lookups, keep include_info=false; request hover/type enrichment only for the small number of exact symbols that actually need it. For narrow retrieval or already-known graph/semantic steps, keep using context_pack, CRG, or Serena directly; when CRG already produced impacted_files, pass those paths as context_pack.seedFiles rather than repeating graph discovery. For C/C++ changes that need toolchain profile, build impact, and/or a build plan together, prefer desktop-accelerators/cpp_build_context: it reuses one request-scoped build_metadata snapshot and runs independent profile/impact derivation in parallel. For narrow questions, keep using build_metadata, cpp_toolchain_profile, cpp_build_impact, or cpp_build_plan directly. Use CRG/context_pack/Serena separately where architecture or symbol semantics matter. For configured CMake build/test work, prefer cpp_build_context -> structured desktop-core/start_process -> wait_process so CMake/CTest retain compiler, generator, linker, preset and parallelism ownership. Prefer desktop-accelerators/edit_file for multiple exact edits in one text file, desktop-accelerators/apply_patch for bounded multi-file text changes, desktop-accelerators/safe_fix for preview-only engine-classified safe fixes before applying them through the mutation tools, and desktop-accelerators/wait_process for finite builds/tests instead of repeated read_process_output polling. Use desktop-accelerators/ast_search or ast_rule_search for bounded structural syntax queries before broad grep/read loops. When the same syntax shape must be changed repeatedly, prefer ast_rewrite in preview mode before text edits; apply only with its regenerated preview identity/exact file set, and keep Serena/LSP preferred for semantic rename/type-aware refactoring. For configured programmatic CRG adapters, use get_impact_radius_tool/get_review_context_tool with explicit changed_files when the task already has a bounded change set, and use query_graph_tool only for explicit graph relationships. The adapter owns mandatory freshness reconciliation; do not call CRG build/update, semantic-search, or traversal tools from the agent path. Use Serena or SCIP for type- and symbol-aware semantics. When a configured external MCP server provides a task-specific semantic tool, prefer it over generic filesystem text search/read or shell emulation. For code intelligence, discover the bound server with mcp_list_tools and prefer semantic symbols, references, implementations, diagnostics, and refactoring tools when applicable; use native search/read as fallback. Inspect an exact tool schema before calling it unless already known. Frozen clients use read_file(mcp://<server>/<tool>) for schema discovery when options are omitted. Trusted read-only desktop-accelerators and external tools explicitly allowlisted by the local DESKTOP_COMMANDER_MCP_READ_ONLY_POLICY may be invoked with read_file(path=mcp://<server>/<tool>?timeout_ms=..., options=<flat downstream arguments>); the URI owns the bridge deadline so any downstream timeout_ms field remains available to the tool. Downstream MCP readOnlyHint annotations never grant this route. Mutating and not-yet-trusted tools continue through write_file(path=mcp://<server>/<tool>, content=<the downstream arguments JSON object>). The content is passed as the tool arguments without reinterpretation. If a bridge deadline is needed, put it in the URI query, e.g. mcp://<server>/<tool>?timeout_ms=45000. The historical {arguments:{...},timeout_ms:N} wrapper is supported when unambiguous; for an open/dynamic downstream schema use ?envelope=legacy explicitly. desktop-core mirrors current Desktop Commander core schemas through the same stable path.';

type ConfigSourceStamp = { source: string; size: number; mtimeMs: number; ctimeMs: number };

type RuntimeState = {
  generation: number;
  configPath: string;
  configFingerprint: string;
  configSources: string[];
  configSourceStamps: ConfigSourceStamp[];
  rawStartup: Promise<Runtime>;
  startup: Promise<Runtime>;
  activeUsers: number;
  retiring: boolean;
  idleWaiters: Set<() => void>;
};

type RuntimeLease = {
  state: RuntimeState;
  runtime: Runtime;
};

type SerenaReadCacheEntry = {
  result: unknown;
  runtimeGeneration: number;
  relativePath: string;
  contentHash: string;
};

type SerenaSessionBinding = {
  token: string;
  implicitIdentityHash?: string;
  root: string;
  serverName: string;
  templateServer?: string;
  createdAt: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
  warmup?: Promise<void>;
  transportReady: boolean;
  transportReadyAt?: number;
  semanticReady: boolean;
  lastError?: string;
  pendingReads: Map<string, Promise<unknown>>;
  completedReads: Map<string, SerenaReadCacheEntry>;
};

let runtimeState: RuntimeState | undefined;
let runtimeGenerationCounter = 0;
const serenaSessionBindings = new Map<string, SerenaSessionBinding>();
const serenaImplicitSessions = new Map<string, string>();
let runtimeMutationTail: Promise<void> = Promise.resolve();

async function withRuntimeMutationLock<T>(
  deadlineAt: number,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = runtimeMutationTail.catch(() => undefined);
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  runtimeMutationTail = previous.then(() => turn);
  try {
    await waitForPromiseUntil(previous, deadlineAt, 'Wait for external MCP runtime state lock');
    return await operation();
  } finally {
    // If this caller timed out before acquiring its turn, pre-resolving the turn
    // keeps the chain moving as soon as the previous owner releases it.
    release();
  }
}

async function configuredPath(deadlineAt = Date.now() + MCP_CALL_TIMEOUT_MAX_MS): Promise<string> {
  // A process-local materialized config is authoritative for this runtime.
  // Persisted Desktop Commander settings remain a fallback for ordinary launches,
  // but must not override a fresh architecture bootstrap/run-remote binding.
  const fromEnv = process.env.DESKTOP_COMMANDER_MCP_CONFIG?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  const fromConfig = await waitForPromiseUntil(
    configManager.getValue('externalMcpConfigPath'),
    deadlineAt,
    'Read external MCP config path',
  );
  const raw = typeof fromConfig === 'string' ? fromConfig.trim() : '';
  if (!raw) {
    throw new Error('External MCP is not configured. Set externalMcpConfigPath.');
  }
  return path.resolve(raw);
}

type RuntimeDescriptor = {
  configPath: string;
  configFingerprint: string;
  configSources: string[];
  configSourceStamps: ConfigSourceStamp[];
  servers: ServerDefinition[];
};

async function statConfigSources(sources: string[], deadlineAt: number): Promise<ConfigSourceStamp[]> {
  return Promise.all([...sources].sort().map(async (source) => {
    const stats = await waitForPromiseUntil(
      fs.stat(source),
      deadlineAt,
      `Stat external MCP config source ${source}`,
    );
    return { source, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
  }));
}

function sameConfigSourceStamps(a: ConfigSourceStamp[], b: ConfigSourceStamp[]): boolean {
  return a.length === b.length && a.every((stamp, index) => {
    const other = b[index];
    return other?.source === stamp.source && other.size === stamp.size &&
      other.mtimeMs === stamp.mtimeMs && other.ctimeMs === stamp.ctimeMs;
  });
}

function definitionSourcePaths(configPath: string, servers: ServerDefinition[]): string[] {
  const baseDir = path.dirname(configPath);
  const values = new Set<string>([configPath]);
  for (const definition of servers) {
    const sources = [definition.source, ...(definition.sources ?? [])].filter(Boolean);
    for (const source of sources) {
      if (!source?.path) continue;
      values.add(path.isAbsolute(source.path) ? source.path : path.resolve(baseDir, source.path));
    }
  }
  return [...values].sort();
}

async function fingerprintConfigSources(sources: string[], deadlineAt: number): Promise<string> {
  const hash = crypto.createHash('sha256');
  for (const source of [...sources].sort()) {
    hash.update(source);
    hash.update('\0');
    const readLabel = `Read external MCP config source ${source}`;
    hash.update(await runWithAbortableTimeout(
      (signal) => fs.readFile(source, { signal }),
      remainingDeadline(deadlineAt, readLabel),
      readLabel,
    ));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function loadStableRuntimeDescriptor(configPath: string, deadlineAt: number): Promise<RuntimeDescriptor> {
  const module = await waitForPromiseUntil(import('mcporter'), deadlineAt, 'Load mcporter config module');
  let previousFingerprint: string | undefined;
  let previousSources: string[] | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const servers = await waitForPromiseUntil(
      module.loadServerDefinitions({ configPath, rootDir: MCP_RUNTIME_ROOT_DIR }),
      deadlineAt,
      'Load external MCP server definitions',
    );
    const configSources = definitionSourcePaths(configPath, servers);
    const stampsBeforeFingerprint = await statConfigSources(configSources, deadlineAt);
    const configFingerprint = await fingerprintConfigSources(configSources, deadlineAt);
    const stampsAfterFingerprint = await statConfigSources(configSources, deadlineAt);
    const metadataStable = sameConfigSourceStamps(stampsBeforeFingerprint, stampsAfterFingerprint);

    if (metadataStable && previousFingerprint === configFingerprint &&
        JSON.stringify(previousSources) === JSON.stringify(configSources)) {
      return {
        configPath,
        configFingerprint,
        configSources,
        configSourceStamps: stampsAfterFingerprint,
        servers,
      };
    }

    // Only a metadata-stable pass may become evidence for the next pass. If a
    // source changed while it was being fingerprinted, its parsed definitions
    // and bytes cannot be treated as one coherent configuration generation.
    if (metadataStable) {
      previousFingerprint = configFingerprint;
      previousSources = configSources;
    } else {
      previousFingerprint = undefined;
      previousSources = undefined;
    }
  }
  throw new Error('External MCP configuration changed repeatedly while being loaded.');
}

function createRuntimeStartup(
  descriptor: RuntimeDescriptor,
  createRuntime: (options: { servers: ServerDefinition[]; rootDir: string; clientInfo: { name: string; version: string } }) => Promise<Runtime>,
): RuntimeState {
  const rawStartup = createRuntime({
    servers: descriptor.servers,
    rootDir: MCP_RUNTIME_ROOT_DIR,
    clientInfo: { name: 'desktop-commander', version: VERSION },
  });
  let timer: NodeJS.Timeout | undefined;
  const startup = new Promise<Runtime>((resolve, reject) => {
    timer = setTimeout(
      () => reject(deadlineError('External MCP runtime startup')),
      MCP_RUNTIME_STARTUP_TIMEOUT_MS,
    );
    rawStartup.then(resolve, reject);
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
  const state: RuntimeState = {
    generation: ++runtimeGenerationCounter,
    configPath: descriptor.configPath,
    configFingerprint: descriptor.configFingerprint,
    configSources: descriptor.configSources,
    configSourceStamps: descriptor.configSourceStamps,
    rawStartup,
    startup,
    activeUsers: 0,
    retiring: false,
    idleWaiters: new Set(),
  };

  void startup.catch(() => {
    if (runtimeState === state) runtimeState = undefined;
  });
  // createRuntime itself cannot be aborted. If the state was superseded or hit
  // the hard startup deadline, reap any transport that resolves late.
  void rawStartup.then((runtime) => {
    if (runtimeState !== state) void closeRuntimeBounded(runtime);
  }).catch(() => undefined);
  return state;
}

async function closeRuntimeStateBounded(state: RuntimeState, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + Math.max(1, timeoutMs);
  try {
    const runtime = await waitForPromiseUntil(
      state.startup,
      deadlineAt,
      'Wait for external MCP runtime before close',
    );
    const remaining = Math.max(1, deadlineAt - Date.now());
    await closeRuntimeBounded(runtime, remaining);
  } catch {
    // Do not let an unresolved startup pin reload/shutdown. The raw promise is
    // already observed; if it eventually resolves, close the late runtime.
    void state.rawStartup.then((runtime) => closeRuntimeBounded(runtime)).catch(() => undefined);
  }
}

function releaseRuntimeLease(state: RuntimeState): void {
  if (state.activeUsers <= 0) return;
  state.activeUsers -= 1;
  if (state.activeUsers === 0) {
    for (const resolve of state.idleWaiters) resolve();
    state.idleWaiters.clear();
  }
}

async function waitForRuntimeIdle(state: RuntimeState, deadlineAt: number): Promise<void> {
  if (state.activeUsers === 0) return;
  let resolveIdle!: () => void;
  const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
  state.idleWaiters.add(resolveIdle);
  try {
    await waitForPromiseUntil(idle, deadlineAt, 'Wait for active external MCP calls before reload');
  } finally {
    state.idleWaiters.delete(resolveIdle);
  }
}

async function acquireRuntime(deadlineAt = Date.now() + MCP_CALL_TIMEOUT_MAX_MS): Promise<RuntimeLease> {
  const selected = await withRuntimeMutationLock(deadlineAt, async () => {
    const configPath = await configuredPath(deadlineAt);
    const current = runtimeState;
    if (current && !current.retiring && current.configPath === configPath) {
      try {
        const sourceStamps = await statConfigSources(current.configSources, deadlineAt);
        if (sameConfigSourceStamps(sourceStamps, current.configSourceStamps)) {
          current.activeUsers += 1;
          return current;
        }
        const fingerprint = await fingerprintConfigSources(current.configSources, deadlineAt);
        if (fingerprint === current.configFingerprint) {
          current.configSourceStamps = sourceStamps;
          current.activeUsers += 1;
          return current;
        }
      } catch {
        // Missing/changed config source falls through to a stable reload.
      }
    }

    const descriptor = await loadStableRuntimeDescriptor(configPath, deadlineAt);
    if (current) {
      current.retiring = true;
      try {
        await waitForRuntimeIdle(current, deadlineAt);
      } catch (error) {
        if (runtimeState === current) current.retiring = false;
        throw error;
      }
      if (runtimeState === current) runtimeState = undefined;
      const closeBudget = Math.min(
        MCP_RUNTIME_CLOSE_TIMEOUT_MS,
        remainingDeadline(deadlineAt, 'Reload external MCP runtime'),
      );
      await closeRuntimeStateBounded(current, closeBudget);
    }

    const module = await waitForPromiseUntil(
      import('mcporter'),
      deadlineAt,
      'Load mcporter runtime module',
    );
    const next = createRuntimeStartup(descriptor, module.createRuntime);
    next.activeUsers = 1;
    runtimeState = next;
    return next;
  });

  try {
    // Do not hold the mutation lock while the stdio server performs its potentially
    // slow initialization; concurrent callers share this one startup promise.
    const runtime = await waitForPromiseUntil(selected.startup, deadlineAt, 'External MCP runtime startup');
    return { state: selected, runtime };
  } catch (error) {
    releaseRuntimeLease(selected);
    throw error;
  }
}

async function withRuntimeLease<T>(
  deadlineAt: number,
  operation: (runtime: Runtime, state: RuntimeState) => Promise<T> | T,
): Promise<T> {
  const lease = await acquireRuntime(deadlineAt);
  try {
    return await operation(lease.runtime, lease.state);
  } finally {
    releaseRuntimeLease(lease.state);
  }
}

type DiscoveredTool = ServerToolInfo & Record<string, unknown>;

type RuntimeToolCacheEntry = { tools: DiscoveredTool[] };
type ToolListChangeRegistration = { runtime: Runtime; servers: Set<string> };
const runtimeToolCache = new WeakMap<object, Map<string, RuntimeToolCacheEntry>>();
const runtimeToolGenerations = new WeakMap<object, Map<string, number>>();
const toolListChangeHandlers = new WeakMap<object, ToolListChangeRegistration>();

function toolCacheFor(runtime: Runtime): Map<string, RuntimeToolCacheEntry> {
  let cache = runtimeToolCache.get(runtime as object);
  if (!cache) {
    cache = new Map();
    runtimeToolCache.set(runtime as object, cache);
  }
  return cache;
}

function toolGenerationsFor(runtime: Runtime): Map<string, number> {
  let generations = runtimeToolGenerations.get(runtime as object);
  if (!generations) {
    generations = new Map();
    runtimeToolGenerations.set(runtime as object, generations);
  }
  return generations;
}

function toolGeneration(runtime: Runtime, server: string): number {
  return toolGenerationsFor(runtime).get(server) ?? 0;
}

function invalidateToolList(runtime: Runtime, server: string): void {
  const generations = toolGenerationsFor(runtime);
  generations.set(server, (generations.get(server) ?? 0) + 1);
  toolCacheFor(runtime).delete(server);
}

const runtimeServerRecoveries = new WeakMap<object, Map<string, Promise<void>>>();

function isExternalMcpDisconnectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  return code === 'NOT_CONNECTED' || code === 'CONNECTION_CLOSED'
    || /\b(?:not connected|connection closed)\b/i.test(message);
}

async function recoverDisconnectedRuntimeServer(
  runtime: Runtime, server: string, deadlineAt: number,
): Promise<void> {
  const identity = runtime as object;
  let recoveries = runtimeServerRecoveries.get(identity);
  if (!recoveries) {
    recoveries = new Map();
    runtimeServerRecoveries.set(identity, recoveries);
  }
  const existing = recoveries.get(server);
  if (existing) {
    await waitForPromiseUntil(existing, deadlineAt, `Recover disconnected MCP server ${server}`);
    return;
  }

  invalidateToolList(runtime, server);
  const recovery = waitForPromiseUntil(
    runtime.close(server), deadlineAt, `Reset disconnected MCP server ${server}`,
  );
  recoveries.set(server, recovery);
  try {
    await recovery;
  } finally {
    if (recoveries.get(server) === recovery) recoveries.delete(server);
  }
}

function installToolListChangeInvalidation(
  runtime: Runtime,
  server: string,
  client: {
    getServerCapabilities?: () => { tools?: { listChanged?: boolean } } | undefined;
    setNotificationHandler: (method: string, handler: () => void) => void;
  },
): void {
  const clientIdentity = client as object;
  const existing = toolListChangeHandlers.get(clientIdentity);
  if (existing) {
    existing.servers.add(server);
    return;
  }
  if (client.getServerCapabilities?.()?.tools?.listChanged !== true) return;
  const registration: ToolListChangeRegistration = { runtime, servers: new Set([server]) };
  client.setNotificationHandler('notifications/tools/list_changed', () => {
    for (const boundServer of registration.servers) invalidateToolList(registration.runtime, boundServer);
  });
  toolListChangeHandlers.set(clientIdentity, registration);
}

function compactTool(tool: ServerToolInfo, server?: string) {
  const firstLine = tool.description?.split(/\r?\n/, 1)[0]?.trim();
  return {
    name: tool.name,
    ...(firstLine ? { description: firstLine.slice(0, 180) } : {}),
    ...(server ? {
      preferredFrozenSurface: isLocallyTrustedReadOnlyExternalTool(server, tool.name) ? 'read_file' : 'write_file',
    } : {}),
  };
}

function toolDeclaresInputProperty(tool: DiscoveredTool, propertyName: string): boolean {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const properties = (schema as Record<string, unknown>).properties;
  return Boolean(
    properties
    && typeof properties === 'object'
    && !Array.isArray(properties)
    && Object.prototype.hasOwnProperty.call(properties, propertyName)
  );
}

function toolAllowedByDefinition(runtime: Runtime, server: string, toolName: string): boolean {
  const definition = runtime.getDefinition(server) as unknown as {
    allowedTools?: string[];
    blockedTools?: string[];
  };
  if (Array.isArray(definition.allowedTools)) return definition.allowedTools.includes(toolName);
  if (Array.isArray(definition.blockedTools)) return !definition.blockedTools.includes(toolName);
  return true;
}

async function listRuntimeTools(
  runtime: Runtime,
  server: string,
  _includeFullMetadata: boolean,
  deadlineAt: number,
): Promise<DiscoveredTool[]> {
  const timeoutMs = Math.min(
    MCP_LIST_TIMEOUT_MAX_MS,
    remainingDeadline(deadlineAt, 'External MCP tool discovery'),
  );
  const context = await waitForPromiseUntil(
    runtime.connect(server, { disableOAuth: true, oauthTimeoutMs: timeoutMs }),
    deadlineAt,
    `Connect MCP server ${server} for tool discovery`,
  );
  const cache = toolCacheFor(runtime);
  installToolListChangeInvalidation(runtime, server, context.client);
  const cached = cache.get(server);
  if (cached) return cached.tools;

  for (let attempt = 0; attempt < MCP_LIST_MAX_INVALIDATION_RETRIES; attempt++) {
    const startGeneration = toolGeneration(runtime, server);
    const tools: DiscoveredTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let invalidated = false;
    let snapshotBytes = 0;
    let snapshotNodes = 0;

    for (let page = 0; page < MCP_LIST_MAX_PAGES; page++) {
      const requestTimeout = Math.min(timeoutMs, remainingDeadline(deadlineAt, 'External MCP tool discovery'));
      const response = await waitForPromiseUntil(
        context.client.listTools(cursor ? { cursor } : undefined, {
          timeout: requestTimeout,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: requestTimeout,
        }),
        deadlineAt,
        `List raw MCP tools for ${server}`,
      );

      // A tools/list_changed received while this page was in flight invalidates
      // the whole paginated snapshot. Never mix pages or publish/cache a list
      // assembled across two server generations.
      if (toolGeneration(runtime, server) !== startGeneration) {
        invalidated = true;
        break;
      }

      const pageBudget = assertBoundedProxyValue(response.tools ?? [], 'MCP tool discovery page');
      snapshotBytes += pageBudget.bytes;
      snapshotNodes += pageBudget.nodes;
      if (snapshotBytes > MCP_PROXY_RESULT_MAX_BYTES) {
        throw resourceLimitError('MCP tool discovery snapshot', MCP_PROXY_RESULT_MAX_BYTES, snapshotBytes);
      }
      if (snapshotNodes > MCP_PROXY_RESULT_MAX_NODES) {
        throw resourceLimitError('MCP tool discovery snapshot structure', MCP_PROXY_RESULT_MAX_NODES, snapshotNodes);
      }

      for (const tool of response.tools ?? []) {
        if (!toolAllowedByDefinition(runtime, server, tool.name)) continue;
        if (names.has(tool.name)) throw new Error(`MCP server '${server}' returned duplicate tool '${tool.name}' across pages.`);
        names.add(tool.name);
        tools.push(tool as DiscoveredTool);
        if (tools.length > MCP_LIST_MAX_TOOLS) {
          throw new Error(`MCP server '${server}' exceeded the ${MCP_LIST_MAX_TOOLS}-tool discovery limit.`);
        }
      }
      const nextCursor = response.nextCursor;
      if (!nextCursor) {
        // No await occurs between this generation check and cache publication;
        // a later notification will therefore either be observed here or delete
        // the newly published entry in its notification handler.
        if (toolGeneration(runtime, server) !== startGeneration) {
          invalidated = true;
          break;
        }
        cache.set(server, { tools });
        return tools;
      }
      if (cursors.has(nextCursor)) {
        throw new Error(`MCP server '${server}' repeated a tools/list pagination cursor.`);
      }
      cursors.add(nextCursor);
      cursor = nextCursor;
    }

    if (invalidated) {
      cache.delete(server);
      continue;
    }
    throw new Error(`MCP server '${server}' exceeded the ${MCP_LIST_MAX_PAGES}-page tools/list limit.`);
  }

  throw new Error(
    `MCP server '${server}' changed its tool list repeatedly during discovery ` +
    `(${MCP_LIST_MAX_INVALIDATION_RETRIES} invalidations).`,
  );
}

async function callRuntimeTool(
  runtime: Runtime,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  deadlineAt: number,
) {
  if (!toolAllowedByDefinition(runtime, server, tool)) {
    throw new Error(`Tool '${tool}' is not accessible on MCP server '${server}' (blocked by configuration).`);
  }
  const invokeOnce = async () => {
    const connectTimeout = Math.min(
      MCP_CALL_TIMEOUT_MAX_MS,
      remainingDeadline(deadlineAt, 'Connect external MCP tool call'),
    );
    const context = await waitForPromiseUntil(
      runtime.connect(server, { disableOAuth: true, oauthTimeoutMs: connectTimeout }),
      deadlineAt,
      `Connect MCP server ${server} for tool call`,
    );
    const requestTimeout = Math.min(
      MCP_CALL_TIMEOUT_MAX_MS,
      remainingDeadline(deadlineAt, 'External MCP tool call'),
    );
    // Call the raw MCP client instead of Runtime.callTool(). mcporter's wrapper
    // resets/closes the shared cached context for any ordinary Error, including a
    // single request timeout. Raw request-level timeouts keep unrelated concurrent
    // calls on the same stdio connection alive.
    return waitForPromiseUntil(
      context.client.callTool(
        { name: tool, arguments: args },
        { timeout: requestTimeout, resetTimeoutOnProgress: true, maxTotalTimeout: requestTimeout },
      ),
      deadlineAt,
      `Call MCP tool ${server}/${tool}`,
    );
  };

  try {
    return await invokeOnce();
  } catch (error) {
    if (!isExternalMcpDisconnectedError(error)) throw error;
    const retryReadOnly = isLocallyTrustedReadOnlyExternalTool(server, tool);
    await recoverDisconnectedRuntimeServer(runtime, server, deadlineAt);
    if (!retryReadOnly) throw error;
    return invokeOnce();
  }
}

function serenaIdentityHash(identity: string): string {
  return crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32);
}

function serenaExplicitToken(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !SERENA_SESSION_TOKEN.test(value)) {
    throw new Error('Serena workspace session must be an opaque 8-128 character token.');
  }
  return value;
}

function implicitSerenaIdentityHash(): string | undefined {
  const identity = getToolCallSessionIdentity();
  return identity ? serenaIdentityHash(identity) : undefined;
}

function scheduleSerenaIdleHibernate(binding: SerenaSessionBinding): void {
  if (binding.idleTimer) clearTimeout(binding.idleTimer);
  const timer = setTimeout(() => {
    if (serenaSessionBindings.get(binding.token) !== binding) return;
    if (Date.now() - binding.lastUsedAt < SERENA_SESSION_IDLE_TIMEOUT_MS) {
      scheduleSerenaIdleHibernate(binding);
      return;
    }
    void hibernateSerenaBinding(binding, Date.now() + 10_000).catch(() => undefined);
  }, SERENA_SESSION_IDLE_TIMEOUT_MS);
  timer.unref();
  binding.idleTimer = timer;
}

function touchSerenaBinding(binding: SerenaSessionBinding): void {
  binding.lastUsedAt = Date.now();
  scheduleSerenaIdleHibernate(binding);
}

function serenaBindingForCall(explicitSession: unknown): SerenaSessionBinding {
  const explicit = serenaExplicitToken(explicitSession);
  const implicitHash = implicitSerenaIdentityHash();
  const token = explicit ?? (implicitHash ? serenaImplicitSessions.get(implicitHash) : undefined);
  const binding = token ? serenaSessionBindings.get(token) : undefined;
  if (!binding) {
    throw new Error('No Serena workspace is bound for this chat/session. Call desktop-context/serena_workspace operation=bind first.');
  }
  touchSerenaBinding(binding);
  return binding;
}

function comparableRoot(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function validateSerenaWorkspaceRoot(value: unknown, deadlineAt: number): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new Error('serena_workspace.root must be a non-empty project directory path.');
  }
  const validated = await validatePath(value.trim(), remainingDeadline(deadlineAt, 'Validate Serena workspace root'));
  const stats = await waitForPromiseUntil(fs.stat(validated), deadlineAt, 'Stat Serena workspace root');
  if (!stats.isDirectory()) throw new Error(`Serena workspace root is not a directory: ${validated}`);
  return validated;
}

function replaceSerenaProjectArg(args: string[], root: string): string[] {
  const next = [...args];
  const start = next.lastIndexOf('start-mcp-server');
  if (start < 0) throw new Error('Configured Serena template does not launch start-mcp-server.');
  for (let index = start + 1; index < next.length; index++) {
    if (next[index] === '--project' && typeof next[index + 1] === 'string') {
      next[index + 1] = root;
      return next;
    }
    if (typeof next[index] === 'string' && next[index].startsWith('--project=')) {
      next[index] = `--project=${root}`;
      return next;
    }
  }
  next.push('--project', root);
  return next;
}

async function selectSerenaTemplate(
  runtime: Runtime, root: string, requestedTemplate: string | undefined, deadlineAt: number,
): Promise<{ definition: ServerDefinition; exactRoot: boolean }> {
  const candidates = runtime.listServers().filter((name) => name.startsWith('serena-') && !name.startsWith(SERENA_DYNAMIC_PREFIX));
  if (requestedTemplate) {
    if (!candidates.includes(requestedTemplate)) throw new Error(`Unknown configured Serena template '${requestedTemplate}'.`);
    const definition = runtime.getDefinition(requestedTemplate);
    const bound = await resolveExternalMcpWorkspaceDefinition(definition, deadlineAt);
    return { definition, exactRoot: Boolean(bound && comparableRoot(bound) === comparableRoot(root)) };
  }
  for (const name of candidates) {
    const definition = runtime.getDefinition(name);
    const bound = await resolveExternalMcpWorkspaceDefinition(definition, deadlineAt).catch(() => undefined);
    if (bound && comparableRoot(bound) === comparableRoot(root)) return { definition, exactRoot: true };
  }
  const fallback = candidates[0];
  if (!fallback) throw new Error('No configured Serena MCP template is available.');
  return { definition: runtime.getDefinition(fallback), exactRoot: false };
}

function cloneSerenaDefinition(
  template: ServerDefinition, root: string, serverName: string, exactRoot: boolean,
): ServerDefinition {
  if (template.command.kind !== 'stdio') throw new Error('Session-scoped Serena requires a stdio Serena template.');
  const env = { ...(template.env ?? {}) };
  if (!exactRoot) {
    for (const key of SERENA_CPP_ENV_KEYS) delete env[key];
  }
  return {
    ...template,
    name: serverName,
    description: `Session-scoped Serena semantic tools for ${root}`,
    command: { ...template.command, args: replaceSerenaProjectArg(template.command.args, root) },
    env,
    lifecycle: { mode: 'keep-alive', idleTimeoutMs: SERENA_SESSION_IDLE_TIMEOUT_MS },
    source: undefined,
    sources: undefined,
  };
}

async function ensureSerenaDefinition(runtime: Runtime, binding: SerenaSessionBinding, deadlineAt: number): Promise<void> {
  if (runtime.listServers().includes(binding.serverName)) return;
  const selected = await selectSerenaTemplate(runtime, binding.root, binding.templateServer, deadlineAt);
  runtime.registerDefinition(cloneSerenaDefinition(selected.definition, binding.root, binding.serverName, selected.exactRoot));
}

function startSerenaWarmup(binding: SerenaSessionBinding): Promise<void> {
  if (binding.warmup) return binding.warmup;
  const deadlineAt = Date.now() + MCP_CALL_TIMEOUT_MAX_MS;
  let warmup!: Promise<void>;
  warmup = withRuntimeLease(deadlineAt, async (runtime) => {
    await ensureSerenaDefinition(runtime, binding, deadlineAt);
    await listRuntimeTools(runtime, binding.serverName, true, deadlineAt);
    binding.transportReady = true;
    binding.transportReadyAt = Date.now();
    binding.lastError = undefined;
  }).catch((error) => {
    binding.transportReady = false;
    binding.lastError = error instanceof Error ? error.message : String(error);
    if (binding.warmup === warmup) binding.warmup = undefined;
    throw error;
  });
  binding.warmup = warmup;
  void warmup.catch(() => undefined);
  return warmup;
}

async function settledWithin<T>(promise: Promise<T>, waitMs: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => { timer = setTimeout(() => resolve({ done: false }), waitMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function serenaColdStart(binding: SerenaSessionBinding, stage: string) {
  return {
    status: 'cold_start',
    workspaceSession: binding.token,
    root: binding.root,
    stage,
    retryAfterMs: 3000,
    message: 'Serena is still starting for this workspace. Keep this workspaceSession and retry the same call; do not create another Serena process.',
  };
}

async function hibernateSerenaBinding(binding: SerenaSessionBinding, deadlineAt: number): Promise<void> {
  if (serenaSessionBindings.get(binding.token) !== binding) return;
  if (Date.now() - binding.lastUsedAt < SERENA_SESSION_IDLE_TIMEOUT_MS) {
    scheduleSerenaIdleHibernate(binding);
    return;
  }
  if (binding.idleTimer) clearTimeout(binding.idleTimer);
  binding.idleTimer = undefined;
  await withRuntimeLease(deadlineAt, async (runtime) => {
    if (runtime.listServers().includes(binding.serverName)) await runtime.close(binding.serverName);
  }).catch(() => undefined);
  binding.warmup = undefined;
  binding.transportReady = false;
  binding.transportReadyAt = undefined;
  binding.semanticReady = false;
  binding.lastError = undefined;
  binding.pendingReads.clear();
  binding.completedReads.clear();
}

async function closeSerenaBinding(binding: SerenaSessionBinding, deadlineAt: number): Promise<void> {
  if (binding.idleTimer) clearTimeout(binding.idleTimer);
  binding.idleTimer = undefined;
  serenaSessionBindings.delete(binding.token);
  if (binding.implicitIdentityHash && serenaImplicitSessions.get(binding.implicitIdentityHash) === binding.token) {
    serenaImplicitSessions.delete(binding.implicitIdentityHash);
  }
  await withRuntimeLease(deadlineAt, async (runtime) => {
    if (runtime.listServers().includes(binding.serverName)) await runtime.close(binding.serverName);
  }).catch(() => undefined);
}

function newSerenaToken(): string {
  return `ws_${crypto.randomBytes(18).toString('base64url')}`;
}

export async function callSerenaWorkspaceTool(args: Record<string, unknown>, timeoutMs = 30_000) {
  const allowed = new Set(['operation', 'root', 'session', 'templateServer', 'warm']);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`serena_workspace received unsupported argument(s): ${unknown.join(', ')}.`);
  const operation = args.operation;
  if (operation !== 'bind' && operation !== 'status' && operation !== 'release') {
    throw new Error('serena_workspace.operation must be bind, status, or release.');
  }
  const deadlineAt = Date.now() + Math.min(timeoutMs, MCP_CALL_TIMEOUT_MAX_MS);
  if (operation !== 'bind') {
    const binding = serenaBindingForCall(args.session);
    if (operation === 'release') {
      await closeSerenaBinding(binding, deadlineAt);
      return { status: 'released', workspaceSession: binding.token, root: binding.root };
    }
    return {
      status: binding.lastError ? 'failed' : binding.semanticReady ? 'ready' : binding.transportReady ? 'warming' : 'starting',
      workspaceSession: binding.token, root: binding.root, server: binding.serverName,
      transportReady: binding.transportReady, semanticReady: binding.semanticReady,
      ageMs: Date.now() - binding.createdAt, ...(binding.lastError ? { error: binding.lastError } : {}),
    };
  }

  const root = await validateSerenaWorkspaceRoot(args.root, deadlineAt);
  const explicit = serenaExplicitToken(args.session);
  const implicitHash = implicitSerenaIdentityHash();
  const implicitToken = implicitHash ? serenaImplicitSessions.get(implicitHash) : undefined;
  const token = explicit ?? implicitToken ?? newSerenaToken();
  const templateServer = args.templateServer === undefined ? undefined : String(args.templateServer);
  if (templateServer && !MCP_READ_ONLY_POLICY_NAME.test(templateServer)) throw new Error('serena_workspace.templateServer is invalid.');
  const serverName = `${SERENA_DYNAMIC_PREFIX}${serenaIdentityHash(`${token}\0${root}\0${templateServer ?? ''}`).slice(0, 20)}`;
  const previous = serenaSessionBindings.get(token);
  if (previous && previous.serverName !== serverName) await closeSerenaBinding(previous, deadlineAt);
  if (!previous && serenaSessionBindings.size >= SERENA_SESSION_MAX) {
    const oldest = [...serenaSessionBindings.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (oldest) await closeSerenaBinding(oldest, deadlineAt);
  }
  const binding: SerenaSessionBinding = previous?.serverName === serverName ? previous : {
    token, implicitIdentityHash: implicitHash, root, serverName, templateServer,
    createdAt: Date.now(), lastUsedAt: Date.now(), transportReady: false, semanticReady: false,
    pendingReads: new Map(), completedReads: new Map(),
  };
  touchSerenaBinding(binding);
  serenaSessionBindings.set(token, binding);
  if (implicitHash) serenaImplicitSessions.set(implicitHash, token);
  if (args.warm !== false) startSerenaWarmup(binding);
  return {
    status: binding.semanticReady ? 'ready' : binding.transportReady ? 'warming' : 'starting',
    workspaceSession: token, sessionIdentity: implicitHash ? 'transport' : 'explicit-token-required',
    root, server: serverName, coldStartWaitMs: SERENA_COLD_START_WAIT_MS,
  };
}

function discoveredToolReadOnly(tool: DiscoveredTool): boolean {
  const annotations = tool.annotations;
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return false;
  const value = annotations as Record<string, unknown>;
  return value.readOnlyHint === true && value.destructiveHint !== true;
}

function serenaReadCacheKey(tool: string, args: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(tool).update('\0').update(JSON.stringify(args)).digest('hex');
}

async function serenaFileCacheDependency(
  binding: SerenaSessionBinding, tool: string, args: Record<string, unknown>, deadlineAt: number,
): Promise<{ relativePath: string; contentHash: string } | undefined> {
  if (!SERENA_FILE_LOCAL_CACHE_TOOLS.has(tool)) return undefined;
  const requested = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
  if (!requested || path.isAbsolute(requested)) return undefined;
  const lexical = path.resolve(binding.root, requested);
  const [rootReal, fileReal] = await Promise.all([
    waitForPromiseUntil(fs.realpath(binding.root), deadlineAt, 'Resolve Serena cache workspace root'),
    waitForPromiseUntil(fs.realpath(lexical), deadlineAt, 'Resolve Serena cache dependency'),
  ]).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [undefined, undefined] as const;
    throw error;
  });
  if (!rootReal || !fileReal) return undefined;
  const relative = path.relative(rootReal, fileReal);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  const stats = await waitForPromiseUntil(fs.stat(fileReal), deadlineAt, 'Stat Serena cache dependency');
  if (!stats.isFile() || stats.size > SERENA_FILE_CACHE_MAX_BYTES) return undefined;
  const bytes = await runWithAbortableTimeout(
    (signal) => fs.readFile(fileReal, { signal }),
    remainingDeadline(deadlineAt, 'Read Serena cache dependency'),
    'Read Serena cache dependency',
  );
  return {
    relativePath: relative.replace(/\\/g, '/'),
    contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function callSessionSerenaTool(args: Record<string, unknown>, timeoutMs = MCP_CALL_TIMEOUT_DEFAULT_MS) {
  const allowed = new Set(['tool', 'arguments', 'session']);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`serena_call received unsupported argument(s): ${unknown.join(', ')}.`);
  if (typeof args.tool !== 'string' || !MCP_READ_ONLY_POLICY_NAME.test(args.tool)) throw new Error('serena_call.tool is invalid.');
  const tool = args.tool;
  const toolArguments = normalizeMcpArgumentsObject(args.arguments, 'serena_call.arguments');
  const binding = serenaBindingForCall(args.session);
  const warmup = startSerenaWarmup(binding);
  const warm = await settledWithin(warmup, Math.min(SERENA_COLD_START_WAIT_MS, timeoutMs));
  if (!warm.done) return serenaColdStart(binding, 'transport');
  await warmup;

  const discoveryDeadline = Date.now() + Math.min(timeoutMs, MCP_CALL_TIMEOUT_MAX_MS);
  const selected = await withRuntimeLease(discoveryDeadline, async (runtime, state) => {
    await ensureSerenaDefinition(runtime, binding, discoveryDeadline);
    const tools = await listRuntimeTools(runtime, binding.serverName, true, discoveryDeadline);
    const found = tools.find((candidate) => candidate.name === tool);
    if (!found) throw new Error(`Serena tool '${tool}' is not available for this workspace.`);
    return { tool: found, runtimeGeneration: state.generation };
  });

  if (discoveredToolReadOnly(selected.tool)) {
    const cacheKey = serenaReadCacheKey(tool, toolArguments);
    const dependency = await serenaFileCacheDependency(binding, tool, toolArguments, discoveryDeadline);
    const cached = binding.completedReads.get(cacheKey);
    if (cached) {
      if (dependency && cached.runtimeGeneration === selected.runtimeGeneration &&
          cached.relativePath === dependency.relativePath && cached.contentHash === dependency.contentHash) {
        return { status: 'ready', workspaceSession: binding.token, root: binding.root, cached: true, result: cached.result };
      }
      binding.completedReads.delete(cacheKey);
    }
    let pending = binding.pendingReads.get(cacheKey);
    if (!pending) {
      const callDeadline = Date.now() + MCP_CALL_TIMEOUT_MAX_MS;
      pending = withRuntimeLease(callDeadline, async (runtime, state) => {
        await ensureSerenaDefinition(runtime, binding, callDeadline);
        try {
          return { result: await callRuntimeTool(runtime, binding.serverName, tool, toolArguments, callDeadline), runtimeGeneration: state.generation };
        } catch (error) {
          if (!isExternalMcpDisconnectedError(error)) throw error;
          return { result: await callRuntimeTool(runtime, binding.serverName, tool, toolArguments, callDeadline), runtimeGeneration: state.generation };
        }
      }).then(async ({ result, runtimeGeneration }) => {
        binding.semanticReady = true;
        binding.lastError = undefined;
        if (dependency) {
          const dependencyAfter = await serenaFileCacheDependency(
            binding, tool, toolArguments, Date.now() + 5_000,
          ).catch(() => undefined);
          if (dependencyAfter && dependencyAfter.relativePath === dependency.relativePath &&
              dependencyAfter.contentHash === dependency.contentHash) {
            binding.completedReads.set(cacheKey, {
              result, runtimeGeneration, relativePath: dependency.relativePath, contentHash: dependency.contentHash,
            });
            while (binding.completedReads.size > 16) binding.completedReads.delete(binding.completedReads.keys().next().value!);
          }
        }
        return result;
      }).catch((error) => {
        binding.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }).finally(() => binding.pendingReads.delete(cacheKey));
      binding.pendingReads.set(cacheKey, pending);
      void pending.catch(() => undefined);
    }
    const settled = await settledWithin(pending, Math.min(SERENA_COLD_START_WAIT_MS, timeoutMs));
    if (!settled.done) return serenaColdStart(binding, 'semantic');
    return { status: 'ready', workspaceSession: binding.token, root: binding.root, cached: false, result: settled.value };
  }

  // Mutating Serena operations can invalidate any file-local semantic cache.
  // Clear before execution because a failing refactor may still have changed the workspace.
  binding.completedReads.clear();

  if (!binding.semanticReady && binding.transportReadyAt) {
    const remainingWarmWindow = SERENA_COLD_START_WAIT_MS - (Date.now() - binding.transportReadyAt);
    if (remainingWarmWindow > 0) await new Promise((resolve) => setTimeout(resolve, remainingWarmWindow));
  }
  const callDeadline = Date.now() + Math.min(timeoutMs, MCP_CALL_TIMEOUT_MAX_MS);
  const result = await withRuntimeLease(callDeadline, async (runtime) => {
    await ensureSerenaDefinition(runtime, binding, callDeadline);
    return callRuntimeTool(runtime, binding.serverName, tool, toolArguments, callDeadline);
  });
  binding.semanticReady = true;
  return { status: 'ready', workspaceSession: binding.token, root: binding.root, cached: false, result };
}

export function assertBoundedProxyValue(value: unknown, label: string): { bytes: number; nodes: number } {
  type TraversalFrame = { value: unknown; exiting?: boolean };
  const stack: TraversalFrame[] = [{ value }];
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const current = frame.value;
    if (frame.exiting) {
      ancestors.delete(current as object);
      continue;
    }

    nodes += 1;
    if (nodes > MCP_PROXY_RESULT_MAX_NODES) {
      throw resourceLimitError(`${label} structure`, MCP_PROXY_RESULT_MAX_NODES, nodes);
    }
    if (current === null || current === undefined) { bytes += 4; }
    else if (typeof current === 'string') { bytes += Buffer.byteLength(current, 'utf8') + 2; }
    else if (typeof current === 'number') { bytes += 24; }
    else if (typeof current === 'boolean') { bytes += 5; }
    else if (typeof current === 'bigint') { bytes += Buffer.byteLength(current.toString(), 'utf8'); }
    else if (Buffer.isBuffer(current) || current instanceof Uint8Array) { bytes += current.byteLength; }
    else if (typeof current === 'object') {
      if (ancestors.has(current)) throw new Error(`${label} contains a cyclic object.`);
      ancestors.add(current);
      stack.push({ value: current, exiting: true });
      if (Array.isArray(current)) {
        for (const item of current) stack.push({ value: item });
      } else {
        for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
          bytes += Buffer.byteLength(key, 'utf8') + 3;
          stack.push({ value: item });
        }
      }
    }
    if (bytes > MCP_PROXY_RESULT_MAX_BYTES) {
      throw resourceLimitError(label, MCP_PROXY_RESULT_MAX_BYTES, bytes);
    }
  }
  return { bytes, nodes };
}

function textResult(value: unknown): ServerResult {
  assertBoundedProxyValue(value, 'MCP proxy result');
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function sanitizeRuntimeInstructions(instructions: unknown, tools: DiscoveredTool[]): string | undefined {
  if (typeof instructions !== 'string') return undefined;
  const instructionBytes = Buffer.byteLength(instructions, 'utf8');
  if (instructionBytes > MCP_PROXY_RESULT_MAX_BYTES) {
    throw resourceLimitError('MCP server instructions', MCP_PROXY_RESULT_MAX_BYTES, instructionBytes);
  }
  const availableTools = new Set(tools.map((tool) => tool.name));
  if (availableTools.has('initial_instructions') || !instructions.includes('initial_instructions')) {
    return instructions.trim() || undefined;
  }
  const filtered = instructions
    .split(/\r?\n/)
    .filter((line) => !line.includes('initial_instructions'))
    .join('\n')
    .trim();
  return filtered || undefined;
}

export async function listExternalMcpTools(args: {
  server?: string;
  tool?: string;
  timeout_ms?: number;
}) {
  const timeoutMs = boundedTimeout(args.timeout_ms, 10_000, MCP_LIST_TIMEOUT_MAX_MS, 'mcp_list_tools.timeout_ms');
  const deadlineAt = Date.now() + operationTimeout(timeoutMs);
  if (!args.server) {
    let externalServers: string[] = [];
    let externalMcpError: string | undefined;
    try {
      externalServers = await withRuntimeLease(deadlineAt, (runtime) => {
        remainingDeadline(deadlineAt, 'mcp_list_tools');
        return runtime.listServers();
      });
    } catch (error) {
      externalMcpError = error instanceof Error ? error.message : String(error);
    }
    return textResult({
      servers: [...new Set([BUILTIN_SERVER_ID, BUILTIN_CORE_SERVER_ID, BUILTIN_CONTEXT_SERVER_ID, ...externalServers])],
      ...(externalMcpError ? { external_mcp_error: externalMcpError } : {}),
      routing_guidance: EXTERNAL_MCP_ROUTING_GUIDANCE,
    });
  }

  if (args.server === BUILTIN_SERVER_ID) {
    const { listBuiltinAcceleratorTools } = await builtinAccelerators();
    return textResult({
      server: BUILTIN_SERVER_ID,
      ...(args.tool
        ? { tool: listBuiltinAcceleratorTools(args.tool) }
        : { tools: listBuiltinAcceleratorTools() }),
      routing_guidance: EXTERNAL_MCP_ROUTING_GUIDANCE,
    });
  }

  if (args.server === BUILTIN_CORE_SERVER_ID) {
    const { listBuiltinCoreTools } = await builtinCore();
    return textResult({
      server: BUILTIN_CORE_SERVER_ID,
      ...(args.tool
        ? { tool: listBuiltinCoreTools(args.tool) }
        : { tools: listBuiltinCoreTools() }),
      routing_guidance: EXTERNAL_MCP_ROUTING_GUIDANCE,
    });
  }

  if (args.server === BUILTIN_CONTEXT_SERVER_ID) {
    return textResult({
      server: BUILTIN_CONTEXT_SERVER_ID,
      ...(args.tool ? { tool: listBuiltinContextTools(args.tool) } : { tools: listBuiltinContextTools() }),
      routing_guidance: EXTERNAL_MCP_ROUTING_GUIDANCE,
    });
  }

  const discovery = await withRuntimeLease(
    deadlineAt,
    async (runtime) => {
      const tools = await listRuntimeTools(runtime, args.server!, Boolean(args.tool), deadlineAt);
      const instructions = runtime.getInstructions
        ? await waitForPromiseUntil(
            runtime.getInstructions(args.server!),
            deadlineAt,
            `Read MCP server instructions for ${args.server}`,
          )
        : undefined;
      return { tools, instructions };
    },
  );

  const instructions = sanitizeRuntimeInstructions(discovery.instructions, discovery.tools);
  if (!args.tool) {
    return textResult({
      server: args.server,
      tools: discovery.tools.map((tool) => compactTool(tool, args.server)) ,
      ...(instructions ? { instructions } : {}),
      routing_guidance: EXTERNAL_MCP_ROUTING_GUIDANCE,
    });
  }

  const selected = discovery.tools.find((candidate) => candidate.name === args.tool);
  if (!selected) {
    throw new Error(`Tool '${args.tool}' is not available on MCP server '${args.server}'.`);
  }
  return textResult({
    server: args.server,
    tool: {
      ...selected,
      preferredFrozenSurface: isLocallyTrustedReadOnlyExternalTool(args.server, selected.name) ? 'read_file' : 'write_file',
    },
    ...(instructions ? { instructions } : {}),
  });
}

export async function callExternalMcpTool(args: {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
  timeout_ms?: number;
}) {
  const toolArguments = normalizeMcpArgumentsObject(args.arguments);
  const timeoutMs = boundedTimeout(
    args.timeout_ms,
    callTimeoutFallback(args.server, args.tool, toolArguments),
    callTimeoutMaximum(args.server, args.tool),
    'mcp_call_tool.timeout_ms'
  );
  assertProcessTransportBudget(args.server, args.tool, toolArguments, timeoutMs, 'mcp_call_tool.timeout_ms');
  const operationTimeoutMs = operationTimeout(timeoutMs);
  const responseDeadlineAt = Date.now() + timeoutMs;
  const deadlineAt = Date.now() + operationTimeoutMs;

  if (args.server === BUILTIN_SERVER_ID) {
    const operation = (async () => {
      const { callBuiltinAcceleratorTool } = await builtinAccelerators();
      return callBuiltinAcceleratorTool(args.tool, toolArguments, operationTimeoutMs);
    })();
    return textResult(await waitForPromiseUntil(operation, responseDeadlineAt, 'Builtin MCP accelerator call'));
  }

  if (args.server === BUILTIN_CORE_SERVER_ID) {
    const operation = (async () => {
      const { callBuiltinCoreTool } = await builtinCore();
      return callBuiltinCoreTool(args.tool, toolArguments);
    })();
    try {
      return await waitForPromiseUntil(operation, deadlineAt, `Builtin Desktop Commander tool ${args.tool}`);
    } catch (error) {
      // If this compatibility layer itself exhausts the response budget before
      // start_process can publish its PID, the request-owned child must not
      // survive as an identity-less session for the calling chat.
      if (args.tool === 'start_process') {
        cancelToolCallOwnedWork(
          cancellationCauseOf(error) ?? 'client_cancelled',
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }

  if (args.server === BUILTIN_CONTEXT_SERVER_ID) {
    listBuiltinContextTools(args.tool);
    if (args.tool === 'serena_workspace') {
      const operation = callSerenaWorkspaceTool(toolArguments, operationTimeoutMs);
      return textResult(await waitForPromiseUntil(operation, responseDeadlineAt, 'Builtin Serena workspace call'));
    }
    if (args.tool === 'serena_call') {
      const operation = callSessionSerenaTool(toolArguments, operationTimeoutMs);
      return textResult(await waitForPromiseUntil(operation, responseDeadlineAt, 'Builtin session Serena call'));
    }
    const operation = (async () => {
      const { callBuiltinAcceleratorTool } = await builtinAccelerators();
      return callCodeContextOrchestrator(toolArguments, {
        callBuiltin: (tool, toolArgs, callTimeout) => callBuiltinAcceleratorTool(tool, toolArgs, callTimeout),
        callTrustedExternal: callTrustedReadOnlyExternalMcpTool,
        assertWorkspace: assertExternalContextWorkspace,
      }, operationTimeoutMs);
    })();
    return textResult(await waitForPromiseUntil(operation, responseDeadlineAt, 'Builtin code-context orchestration call'));
  }

  const result = await withRuntimeLease(
    deadlineAt,
    async (runtime) => {
      const tools = await listRuntimeTools(runtime, args.server, true, deadlineAt);
      const selectedTool = tools.find((candidate) => candidate.name === args.tool);
      if (!selectedTool) {
        throw new Error(`Tool '${args.tool}' is not available on MCP server '${args.server}'.`);
      }
      const definition = runtime.getDefinition(args.server);
      const boundArguments = await bindExternalMcpWorkspaceDefinition(
        definition,
        toolArguments,
        deadlineAt,
        toolDeclaresInputProperty(selectedTool, 'repo_root'),
      );
      return callRuntimeTool(runtime, args.server, args.tool, boundArguments, deadlineAt);
    },
  );

  assertBoundedProxyValue(result, `External MCP result ${args.server}/${args.tool}`);
  if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) {
    // Preserve the complete extensible CallToolResult. Whitelisting today's
    // known fields would silently drop future MCP/server-specific extensions.
    const downstream = result as Record<string, unknown> & { content: ServerResult['content'] };
    return { ...downstream, content: downstream.content } as ServerResult;
  }
  return textResult(result);
}


export type ExternalMcpCompatTarget = {
  server?: string;
  tool?: string;
  timeout_ms?: number;
  envelope?: 'flat' | 'legacy';
};

export function parseExternalMcpCompatUri(raw: string): ExternalMcpCompatTarget | null {
  if (!isMcpCompatUri(raw)) return null;
  if (raw.length > MCP_COMPAT_URI_MAX_CHARS) throw new Error('MCP compatibility URI is too long.');
  const rest = raw.slice('mcp://'.length);
  if (rest.includes('#')) throw new Error('MCP compatibility URI fragments are not supported.');
  const queryIndex = rest.indexOf('?');
  const pathPart = queryIndex >= 0 ? rest.slice(0, queryIndex) : rest;
  const queryPart = queryIndex >= 0 ? rest.slice(queryIndex + 1) : '';
  const params = new URLSearchParams(queryPart);
  const allowedQueryKeys = new Set(['timeout_ms', 'envelope']);
  const unknownQueryKeys = [...new Set([...params.keys()].filter((key) => !allowedQueryKeys.has(key)))];
  if (unknownQueryKeys.length > 0) {
    throw new Error(`Unsupported MCP compatibility URI query keys: ${unknownQueryKeys.join(', ')}.`);
  }
  const timeoutValues = params.getAll('timeout_ms');
  if (timeoutValues.length > 1) throw new Error('MCP compatibility URI accepts timeout_ms only once.');
  let timeout_ms: number | undefined;
  if (timeoutValues.length === 1) {
    if (!/^\d+$/.test(timeoutValues[0])) throw new Error('MCP compatibility URI timeout_ms must be an integer.');
    timeout_ms = boundedTimeout(Number(timeoutValues[0]), 30_000, PROCESS_TRANSPORT_TIMEOUT_MAX_MS, 'MCP compatibility URI timeout_ms');
  }
  const envelopeValues = params.getAll('envelope');
  if (envelopeValues.length > 1) throw new Error('MCP compatibility URI accepts envelope only once.');
  let envelope: 'flat' | 'legacy' | undefined;
  if (envelopeValues.length === 1) {
    if (envelopeValues[0] !== 'flat' && envelopeValues[0] !== 'legacy') {
      throw new Error('MCP compatibility URI envelope must be flat or legacy.');
    }
    envelope = envelopeValues[0];
  }

  let parts: string[];
  try {
    parts = pathPart.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw new Error('MCP compatibility URI contains invalid percent-encoding.');
  }
  if (parts.some((part) => part.includes('/') || part.includes('\\'))) {
    throw new Error('MCP compatibility URI server/tool names cannot contain path separators.');
  }
  const query = { ...(timeout_ms ? { timeout_ms } : {}), ...(envelope ? { envelope } : {}) };
  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'servers')) return query;
  if (parts.length > 2) throw new Error('MCP compatibility URI must be mcp://<server>[/<tool>].');
  return { server: parts[0], ...(parts[1] ? { tool: parts[1] } : {}), ...query };
}

async function compatToolInputSchema(
  server: string,
  tool: string,
  deadlineAt: number,
): Promise<Record<string, unknown>> {
  if (server === BUILTIN_SERVER_ID) {
    const { listBuiltinAcceleratorTools } = await builtinAccelerators();
    return (listBuiltinAcceleratorTools(tool) as { inputSchema?: Record<string, unknown> }).inputSchema ?? {};
  }
  if (server === BUILTIN_CORE_SERVER_ID) {
    const { listBuiltinCoreTools } = await builtinCore();
    return (listBuiltinCoreTools(tool) as { inputSchema?: Record<string, unknown> }).inputSchema ?? {};
  }
  if (server === BUILTIN_CONTEXT_SERVER_ID) {
    return (listBuiltinContextTools(tool) as { inputSchema?: Record<string, unknown> }).inputSchema ?? {};
  }

  const tools = await withRuntimeLease(
    deadlineAt,
    (runtime) => listRuntimeTools(runtime, server, true, deadlineAt),
  );
  const selected = tools.find((candidate) => candidate.name === tool);
  if (!selected) throw new Error(`Tool '${tool}' is not available on MCP server '${server}'.`);
  return ((selected as unknown as { inputSchema?: Record<string, unknown> }).inputSchema ?? {});
}

function looksLikeLegacyCompatEnvelope(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return Object.prototype.hasOwnProperty.call(value, 'arguments') &&
    keys.every((key) => key === 'arguments' || key === 'timeout_ms');
}

function schemaDeclaresArgumentsField(schema: Record<string, unknown>): boolean | null {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  const fields = properties as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(fields, 'arguments');
}

export async function readExternalMcpCompatUri(raw: string, options?: Record<string, unknown>) {
  const target = parseExternalMcpCompatUri(raw);
  if (!target) throw new Error('Not an MCP compatibility URI.');
  if (target.envelope) throw new Error('MCP compatibility envelope is only valid for write/call URIs.');

  // Omitted options preserve the historical schema/discovery read. Explicit
  // options are an invocation request and are permitted only when read-only
  // classification is authoritative inside this process. MCP annotations from
  // arbitrary downstream servers are hints and are never a security boundary.
  if (options === undefined) {
    return listExternalMcpTools({
      server: target.server,
      tool: target.tool,
      timeout_ms: target.timeout_ms,
    });
  }
  if (!target.server || !target.tool) {
    throw new Error('MCP read-only invocation requires mcp://<server>/<tool>.');
  }
  if (target.server === BUILTIN_CORE_SERVER_ID) {
    const { listBuiltinCoreTools } = await builtinCore();
    const metadata = listBuiltinCoreTools(target.tool) as { readOnly?: boolean; mutating?: boolean };
    if (metadata.readOnly !== true || metadata.mutating !== false) {
      throw new Error(`Tool '${target.server}/${target.tool}' is not a trusted read-only core tool and cannot execute through read_file.`);
    }
  } else if (target.server === BUILTIN_CONTEXT_SERVER_ID) {
    const metadata = listBuiltinContextTools(target.tool) as { readOnly?: boolean; mutating?: boolean };
    if (metadata.readOnly !== true || metadata.mutating !== false) {
      throw new Error(`Tool '${target.server}/${target.tool}' is not a trusted read-only tool and cannot execute through read_file.`);
    }
  } else if (target.server === BUILTIN_SERVER_ID) {
    const { listBuiltinAcceleratorTools } = await builtinAccelerators();
    const metadata = listBuiltinAcceleratorTools(target.tool) as { readOnly?: boolean; mutating?: boolean };
    if (metadata.readOnly !== true || metadata.mutating !== false) {
      throw new Error(`Tool '${target.server}/${target.tool}' is not a trusted read-only tool and cannot execute through read_file.`);
    }
  } else if (!isLocallyTrustedReadOnlyExternalTool(target.server, target.tool)) {
    throw new Error(`MCP read-only invocation is not enabled for '${target.server}/${target.tool}'. The local ${MCP_READ_ONLY_POLICY_ENV} policy must explicitly allow it; downstream annotations are not trusted.`);
  }
  const toolArguments = normalizeMcpArgumentsObject(options, 'MCP compatibility read options');
  return callExternalMcpTool({
    server: target.server,
    tool: target.tool,
    arguments: toolArguments,
    timeout_ms: target.timeout_ms,
  });
}

function serverResultContentBytes(result: ServerResult): number {
  let total = 0;
  for (const item of result.content) {
    const value = item as unknown as Record<string, unknown>;
    if (typeof value.text === 'string') total += Buffer.byteLength(value.text, 'utf8');
    if (typeof value.data === 'string') total += Buffer.byteLength(value.data, 'utf8');
    const resource = value.resource as Record<string, unknown> | undefined;
    if (resource && typeof resource.text === 'string') total += Buffer.byteLength(resource.text, 'utf8');
    if (resource && typeof resource.blob === 'string') total += Buffer.byteLength(resource.blob, 'utf8');
  }
  return total;
}

export async function readMultipleFilesCompatAware(
  paths: string[],
  readLocal: (filePath: string, maxOutputBytes: number) => Promise<ServerResult>,
): Promise<ServerResult> {
  if (paths.length > MCP_COMPAT_MULTI_MAX_FILES) {
    throw new Error(`read_multiple_files accepts at most ${MCP_COMPAT_MULTI_MAX_FILES} paths.`);
  }
  const deadlineAt = Date.now() + MCP_COMPAT_MULTI_TIMEOUT_MS;
  const sections: ServerResult['content'][] = new Array(paths.length);
  const budget = new AggregateByteBudget(READ_MULTIPLE_MAX_OUTPUT_BYTES);
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= paths.length) return;
      const filePath = paths[index];
      let lease: { maxBytes: number; commit(bytes: number): void; release(): void } | undefined;
      try {
        lease = await budget.acquire(READ_MULTIPLE_PER_FILE_OUTPUT_BYTES);
        const remaining = remainingDeadline(deadlineAt, 'read_multiple_files MCP compatibility batch');
        let item: ServerResult;
        if (isMcpCompatUri(filePath)) {
          const target = parseExternalMcpCompatUri(filePath);
          if (!target || target.envelope) throw new Error('MCP compatibility envelope is only valid for write/call URIs.');
          item = await listExternalMcpTools({
            server: target.server,
            tool: target.tool,
            timeout_ms: Math.min(target.timeout_ms ?? 10_000, remaining),
          });
        } else {
          item = await waitForPromiseUntil(
            readLocal(filePath, lease.maxBytes), deadlineAt, `Read local batch file ${filePath}`
          );
        }
        const itemBytes = serverResultContentBytes(item);
        if (itemBytes > lease.maxBytes) {
          throw resourceLimitError('MCP-compatible batch item', lease.maxBytes, itemBytes);
        }
        lease.commit(itemBytes);
        lease = undefined;
        sections[index] = [{ type: 'text', text: `--- ${filePath} ---` }, ...item.content];
      } catch (error) {
        lease?.release();
        const message = error instanceof Error ? error.message : String(error);
        sections[index] = [{ type: 'text', text: `${filePath}: Error - ${message}` }];
      }
    }
  };

  const workers = Math.min(MCP_COMPAT_MULTI_CONCURRENCY, paths.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return { content: sections.flat() };
}

export async function callExternalMcpCompatUri(raw: string, content: string) {
  const target = parseExternalMcpCompatUri(raw);
  if (!target?.server || !target.tool) {
    throw new Error('MCP calls require mcp://<server>/<tool>.');
  }

  if (Buffer.byteLength(content, 'utf8') > MCP_COMPAT_PAYLOAD_MAX_BYTES) {
    throw new Error(`MCP compatibility payload exceeds ${MCP_COMPAT_PAYLOAD_MAX_BYTES} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('MCP write_file compatibility payload must be JSON.');
  }
  const value = normalizeMcpArgumentsObject(parsed, 'MCP compatibility payload');
  const legacyShape = looksLikeLegacyCompatEnvelope(value);
  const processBudgetArgs = isLocalProcessWaitTarget(target.server, target.tool) && legacyShape
    ? normalizeMcpArgumentsObject(value.arguments, 'Legacy MCP compatibility payload.arguments')
    : value;
  let totalTimeout = boundedTimeout(
    target.timeout_ms,
    callTimeoutFallback(target.server, target.tool, processBudgetArgs),
    callTimeoutMaximum(target.server, target.tool),
    'MCP compatibility timeout_ms',
  );
  let deadlineAt = Date.now() + totalTimeout;

  // Canonical frozen-client form is flat JSON matching the downstream inputSchema.
  // The historical {arguments:{...},timeout_ms:N} envelope remains compatible.
  // Auto-detection unwraps only when the downstream schema explicitly excludes an
  // `arguments` field. Open/dynamic schemas stay flat; callers that truly need the
  // old wrapper there can opt in with ?envelope=legacy. No path silently replaces
  // the downstream object with {}.
  let toolArguments = value;
  let legacyTimeout: number | undefined;
  const explicitLegacy = target.envelope === 'legacy';
  if (explicitLegacy && !legacyShape) {
    throw new Error('MCP compatibility ?envelope=legacy requires {arguments:{...}, timeout_ms?:N}.');
  }
  let shouldUnwrapLegacy = explicitLegacy;
  if (!shouldUnwrapLegacy && target.envelope !== 'flat' && legacyShape) {
    const schema = await compatToolInputSchema(target.server, target.tool, deadlineAt);
    shouldUnwrapLegacy = schemaDeclaresArgumentsField(schema) === false;
  }
  if (shouldUnwrapLegacy) {
    toolArguments = normalizeMcpArgumentsObject(
      value.arguments,
      'Legacy MCP compatibility payload.arguments',
    );
    if (value.timeout_ms !== undefined) {
      if (typeof value.timeout_ms !== 'number') {
        throw new Error('Legacy MCP compatibility payload.timeout_ms must be a number.');
      }
      legacyTimeout = boundedTimeout(
        value.timeout_ms,
        callTimeoutFallback(target.server, target.tool, toolArguments),
        callTimeoutMaximum(target.server, target.tool),
        'Legacy MCP compatibility payload.timeout_ms',
      );
    }
  }

  if (target.timeout_ms !== undefined && legacyTimeout !== undefined && target.timeout_ms !== legacyTimeout) {
    throw new Error('MCP compatibility timeout_ms conflicts between URI and legacy payload.');
  }
  totalTimeout = boundedTimeout(
    target.timeout_ms ?? legacyTimeout,
    callTimeoutFallback(target.server, target.tool, toolArguments),
    callTimeoutMaximum(target.server, target.tool),
    'MCP compatibility timeout_ms',
  );
  assertProcessTransportBudget(target.server, target.tool, toolArguments, totalTimeout, 'MCP compatibility timeout_ms');
  deadlineAt = Date.now() + totalTimeout;
  const remaining = remainingDeadline(deadlineAt, 'MCP compatibility call');
  if (remaining < 100) {
    const error = new Error('MCP compatibility call deadline exceeded before dispatch.') as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  // Compatibility routing adds one more response/serialization hop before the
  // remote transport can return. Reserve a layer here in addition to the
  // reserve inside callExternalMcpTool, otherwise a 45s downstream wait can
  // consume almost the entire 45s remote RPC budget.
  const timeout_ms = compatDispatchTimeout(
    target.server, target.tool, toolArguments, totalTimeout, remaining,
  );

  return callExternalMcpTool({
    server: target.server,
    tool: target.tool,
    arguments: toolArguments,
    timeout_ms,
  });
}

export async function closeExternalMcpRuntime(): Promise<void> {
  const current = runtimeState;
  runtimeState = undefined;
  if (!current) return;
  await closeRuntimeStateBounded(current, MCP_RUNTIME_CLOSE_TIMEOUT_MS);
}
