import path from 'path';
import { MAX_WORKSPACE_CURSOR_TRANSPORT_BYTES } from './workspace-accelerators.js';

const MAX_OPERATION_TIMEOUT_MS = 45_000;
const MAX_CHANGED_FILES = 100;
const MAX_SEED_FILES = 100;
const MAX_SYMBOL_QUERIES = 8;
const MAX_SYMBOL_MATCHES = 20;
const MAX_SYMBOL_ANSWER_CHARS = 40_000;
const SEMANTIC_CONCURRENCY = 4;

export const BUILTIN_CONTEXT_SERVER_ID = 'desktop-context';

type JsonRecord = Record<string, unknown>;

type SymbolQuery = {
  name_path_pattern: string;
  relative_path?: string;
  depth: number;
  include_info: boolean;
  substring_matching: boolean;
  max_matches: number;
  max_answer_chars: number;
};

export type ContextWorkspaceBinding = { requestedRoot: string; boundRoot: string };

export type CodeContextDependencies = {
  callBuiltin: (tool: string, args: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  callTrustedExternal: (server: string, tool: string, args: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  assertWorkspace: (
    server: string, root: string, timeoutMs: number, relation: 'exact' | 'ancestor',
  ) => Promise<ContextWorkspaceBinding>;
};
function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function remaining(deadlineAt: number, label: string): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) {
    const error = new Error(`${label} deadline exceeded.`) as NodeJS.ErrnoException;
    error.code = 'ETIMEDOUT';
    throw error;
  }
  return value;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty single-line string up to ${maximum} characters.`);
  }
  return value.trim();
}
function changedFiles(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHANGED_FILES) {
    throw new Error(`code_context.changedFiles must contain 1-${MAX_CHANGED_FILES} paths when provided.`);
  }
  return value.map((item, index) => boundedString(item, `code_context.changedFiles[${index}]`, 4096));
}

type WorkspaceDeltaContract = {
  changedFiles: string[];
  cursor?: string;
  freshInstance: boolean;
  complete: boolean;
};

function workspaceDeltaContract(value: unknown): WorkspaceDeltaContract {
  const result = recordValue(unwrapResult(value));
  if (!result || !Array.isArray(result.changedFiles)) {
    throw new Error('code_context workspace_delta returned an invalid changed-file contract.');
  }
  // workspace_delta owns the internal changed-file cardinality bound. Do not re-apply
  // code_context's smaller explicit-input cap here: that would create a second,
  // incompatible change-tracking contract and fail merely because a workspace is busy.
  const files = result.changedFiles.map((item, index) =>
    boundedString(item, `code_context workspace_delta changedFiles[${index}]`, 4096));
  const cursor = result.cursor === undefined
    ? undefined
    : boundedString(result.cursor, 'code_context workspace_delta cursor', MAX_WORKSPACE_CURSOR_TRANSPORT_BYTES);
  return {
    changedFiles: files,
    ...(cursor ? { cursor } : {}),
    freshInstance: result.freshInstance === true,
    complete: result.complete === true,
  };
}

function symbolQueries(value: unknown): SymbolQuery[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SYMBOL_QUERIES) {
    throw new Error(`code_context.symbolQueries must contain 1-${MAX_SYMBOL_QUERIES} queries when provided.`);
  }
  return value.map((raw, index) => {
    const item = recordValue(raw);
    if (!item) throw new Error(`code_context.symbolQueries[${index}] must be an object.`);
    const allowed = new Set(['name_path_pattern', 'relative_path', 'depth', 'include_info', 'substring_matching', 'max_matches', 'max_answer_chars']);
    const unknown = Object.keys(item).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new Error(`code_context.symbolQueries[${index}] has unsupported fields: ${unknown.join(', ')}.`);
    return {
      name_path_pattern: boundedString(item.name_path_pattern, `code_context.symbolQueries[${index}].name_path_pattern`, 512),
      ...(item.relative_path === undefined ? {} : { relative_path: boundedString(item.relative_path, `code_context.symbolQueries[${index}].relative_path`, 4096) }),
      depth: boundedInteger(item.depth, 0, 0, 2, `code_context.symbolQueries[${index}].depth`),
      include_info: item.include_info === true,
      substring_matching: item.substring_matching === true,
      max_matches: boundedInteger(item.max_matches, 8, 1, MAX_SYMBOL_MATCHES, `code_context.symbolQueries[${index}].max_matches`),
      max_answer_chars: boundedInteger(item.max_answer_chars, 20_000, 1, MAX_SYMBOL_ANSWER_CHARS, `code_context.symbolQueries[${index}].max_answer_chars`),
    };
  });
}
function unwrapResult(value: unknown): unknown {
  const object = recordValue(value);
  if (!object) return value;
  const structured = recordValue(object.structuredContent);
  if (structured) return structured;
  if (!Array.isArray(object.content)) return value;
  const texts = object.content
    .map((item) => recordValue(item))
    .filter((item): item is JsonRecord => item !== undefined && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string);
  if (texts.length === 0) return value;
  const text = texts.join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}

function normalizeSlash(value: string): string { return value.replace(/\\/g, '/'); }

function pathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requestedScopePrefix(binding: ContextWorkspaceBinding): string {
  return normalizeSlash(path.relative(binding.boundRoot, binding.requestedRoot));
}

function graphRelativeChangedFiles(values: string[], binding: ContextWorkspaceBinding): string[] {
  const prefix = requestedScopePrefix(binding);
  const files: string[] = [];
  for (const value of values) {
    const normalized = normalizeSlash(value);
    const absolute = path.isAbsolute(value)
      ? path.resolve(value)
      : prefix && (normalized === prefix || normalized.startsWith(`${prefix}/`))
        ? path.resolve(binding.boundRoot, normalized)
        : path.resolve(binding.requestedRoot, normalized);
    if (!pathWithin(binding.requestedRoot, absolute)) continue;
    const relative = normalizeSlash(path.relative(binding.boundRoot, absolute));
    if (relative && !files.includes(relative)) files.push(relative);
  }
  return files;
}

function impactedFiles(value: unknown, binding: ContextWorkspaceBinding): { graph: string[]; scope: string[] } {
  const result = recordValue(unwrapResult(value));
  const raw = Array.isArray(result?.impacted_files) ? result.impacted_files : [];
  const graph: string[] = [];
  const scope: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const absolute = path.isAbsolute(item) ? path.resolve(item) : path.resolve(binding.boundRoot, item);
    if (!pathWithin(binding.requestedRoot, absolute)) continue;
    const graphRelative = normalizeSlash(path.relative(binding.boundRoot, absolute));
    const scopeRelative = normalizeSlash(path.relative(binding.requestedRoot, absolute));
    if (graphRelative && !graph.includes(graphRelative)) graph.push(graphRelative);
    if (scopeRelative && !scope.includes(scopeRelative)) scope.push(scopeRelative);
    if (graph.length >= MAX_SEED_FILES) break;
  }
  return { graph, scope };
}

function compactContextPack(value: unknown) {
  const result = recordValue(unwrapResult(value));
  if (!result) return value;
  const delta = recordValue(result.workspaceDelta);
  const changed = Array.isArray(delta?.changedFiles) ? delta.changedFiles : [];
  const working = Array.isArray(delta?.workingTreeChangedFiles) ? delta.workingTreeChangedFiles : [];
  return {
    repositoryRoot: result.repositoryRoot ?? null,
    scopeRoot: result.scopeRoot ?? null,
    scopePrefix: result.scopePrefix ?? '',
    queryTerms: result.queryTerms ?? [],
    workspaceCursor: result.workspaceCursor ?? null,
    workspaceDelta: delta ? {
      freshInstance: delta.freshInstance === true,
      complete: delta.complete === true,
      changedFileCount: typeof delta.changedFileCount === 'number' ? delta.changedFileCount : changed.length,
      changedFilesTruncated: delta.changedFilesTruncated === true,
      workingTreeChangedFileCount: typeof delta.workingTreeChangedFileCount === 'number'
        ? delta.workingTreeChangedFileCount : working.length,
      workingTreeChangedFilesTruncated: delta.workingTreeChangedFilesTruncated === true,
    } : null,
    candidateCount: result.candidateCount ?? 0,
    inspectedCandidateCount: result.inspectedCandidateCount ?? 0,
    inspectedBytes: result.inspectedBytes ?? 0,
    inspectionByteLimitReached: result.inspectionByteLimitReached === true,
    seedFilesAccepted: result.seedFilesAccepted ?? [],
    missingSeedFiles: result.missingSeedFiles ?? [],
    files: result.files ?? [],
    returnedChars: result.returnedChars ?? 0,
    responseTruncated: result.responseTruncated === true,
    semanticFollowupTerms: result.semanticFollowupTerms ?? [],
  };
}

function compactGraph(value: unknown, files: string[]) {
  const result = recordValue(unwrapResult(value));
  if (!result) return { impactedFiles: files };
  return {
    status: typeof result.status === 'string' ? result.status : null,
    summary: typeof result.summary === 'string' ? result.summary.slice(0, 4000) : null,
    truncated: result.truncated === true,
    totalImpacted: typeof result.total_impacted === 'number' ? result.total_impacted : files.length,
    impactedFiles: files,
    ...(recordValue(result._sync) ? { sync: result._sync } : {}),
    ...(recordValue(result._graph) ? { graph: result._graph } : {}),
  };
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, fn: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}
export async function callCodeContextOrchestrator(
  args: Record<string, unknown>, deps: CodeContextDependencies, timeoutMs = 30_000,
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`code_context timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  const allowed = new Set([
    'root', 'query', 'workspaceCursor', 'changedFiles', 'graphServer', 'graphDepth',
    'semanticServer', 'symbolQueries', 'maxFiles', 'contextLines', 'maxLinesPerFile', 'maxTotalChars',
  ]);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`code_context received unsupported argument(s): ${unknown.join(', ')}.`);
  const root = boundedString(args.root, 'code_context.root', 4096);
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 4000) {
    throw new Error('code_context.query must be a non-empty string up to 4000 characters.');
  }
  const query = args.query;
  const explicitChanged = changedFiles(args.changedFiles);
  const graphServer = args.graphServer === undefined ? null : boundedString(args.graphServer, 'code_context.graphServer', 128);
  const semanticServer = args.semanticServer === undefined ? null : boundedString(args.semanticServer, 'code_context.semanticServer', 128);
  const symbols = symbolQueries(args.symbolQueries);
  if (semanticServer && symbols.length === 0) throw new Error('code_context.semanticServer requires symbolQueries.');
  if (!semanticServer && symbols.length > 0) throw new Error('code_context.symbolQueries requires semanticServer.');
  const deadlineAt = Date.now() + timeoutMs;
  const graphDepth = boundedInteger(args.graphDepth, 2, 0, 4, 'code_context.graphDepth');
  const maxFiles = boundedInteger(args.maxFiles, 8, 1, 20, 'code_context.maxFiles');
  const contextLines = boundedInteger(args.contextLines, 3, 0, 20, 'code_context.contextLines');
  const maxLinesPerFile = boundedInteger(args.maxLinesPerFile, 120, 1, 500, 'code_context.maxLinesPerFile');
  const maxTotalChars = boundedInteger(args.maxTotalChars, 60_000, 1, 500_000, 'code_context.maxTotalChars');
  const workspaceCursor = args.workspaceCursor === undefined
    ? undefined
    : boundedString(args.workspaceCursor, 'code_context.workspaceCursor', MAX_WORKSPACE_CURSOR_TRANSPORT_BYTES);

  const autoDeltaPromise = graphServer && explicitChanged.length === 0
    ? deps.callBuiltin('workspace_delta', {
        root,
        ...(workspaceCursor ? { cursor: workspaceCursor } : {}),
      }, remaining(deadlineAt, 'code_context workspace delta'))
    : Promise.resolve(null);
  const [graphBinding, semanticBinding, rawAutoDelta] = await Promise.all([
    graphServer
      ? deps.assertWorkspace(graphServer, root, remaining(deadlineAt, 'code_context graph workspace'), 'ancestor')
      : Promise.resolve(null),
    semanticServer
      ? deps.assertWorkspace(semanticServer, root, remaining(deadlineAt, 'code_context semantic workspace'), 'exact')
      : Promise.resolve(null),
    autoDeltaPromise,
  ]);
  const autoDelta = rawAutoDelta === null ? null : workspaceDeltaContract(rawAutoDelta);
  const changed = explicitChanged.length > 0 ? explicitChanged : (autoDelta?.changedFiles ?? []);
  const graphChanged = graphBinding ? graphRelativeChangedFiles(changed, graphBinding) : changed;
  if (graphServer && explicitChanged.length > 0 && graphChanged.length === 0) {
    throw new Error('code_context.graphServer received no changedFiles inside the requested root scope.');
  }
  // context_pack owns transient-path relevance. Reuse the caller's baseline cursor
  // so it observes the same delta itself instead of receiving the already-advanced
  // cursor and requiring raw auto-delta paths to be promoted as explicit seeds.
  const contextWorkspaceCursor = workspaceCursor;

  const semanticPromise = semanticServer
    ? mapConcurrent(symbols, SEMANTIC_CONCURRENCY, async (symbol) => ({
        query: symbol,
        result: unwrapResult(await deps.callTrustedExternal(semanticServer, 'find_symbol', {
          ...symbol,
          include_body: false,
        }, remaining(deadlineAt, 'code_context semantic query'))),
      }))
    : Promise.resolve([]);
  // Attach rejection handling immediately: graph/context retrieval may take longer
  // than a fast semantic policy/runtime failure, and a late await must not create
  // a transient unhandled rejection in the shared Remote process.
  const semanticSettled = semanticPromise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  const graphResult = graphServer
    ? await deps.callTrustedExternal(graphServer, 'get_impact_radius_tool', {
        changed_files: graphChanged,
        max_depth: graphDepth,
        detail_level: 'compact',
      }, remaining(deadlineAt, 'code_context graph impact'))
    : null;
  const graphImpacts = graphResult && graphBinding ? impactedFiles(graphResult, graphBinding) : { graph: [], scope: [] };
  const graphSeeds = graphImpacts.graph;
  const explicitRelevanceSeeds = explicitChanged.length > 0 ? graphChanged : [];
  const seeds = [...new Set([...explicitRelevanceSeeds, ...graphSeeds])].slice(0, MAX_SEED_FILES);

  const contextPackPromise = deps.callBuiltin('context_pack', {
    root,
    query,
    ...(contextWorkspaceCursor ? { workspaceCursor: contextWorkspaceCursor } : {}),
    ...(seeds.length > 0 ? { seedFiles: seeds } : {}),
    maxFiles,
    contextLines,
    maxLinesPerFile,
    maxTotalChars,
  }, remaining(deadlineAt, 'code_context context pack'));

  const [rawContextPack, semanticOutcome] = await Promise.all([contextPackPromise, semanticSettled]);
  const contextPack = compactContextPack(rawContextPack);
  if (!semanticOutcome.ok) throw semanticOutcome.error;
  const semantic = semanticOutcome.value;
  return {
    root,
    query,
    graph: graphResult ? {
      server: graphServer,
      workspaceRoot: graphBinding?.boundRoot ?? null,
      ...compactGraph(graphResult, graphImpacts.scope),
    } : null,
    contextPack,
    semantic: semanticServer ? { server: semanticServer, results: semantic } : null,
    orchestration: {
      graphCalls: graphResult ? 1 : 0,
      contextPackCalls: 1,
      semanticCalls: semantic.length,
      semanticConcurrency: semantic.length > 0 ? Math.min(SEMANTIC_CONCURRENCY, semantic.length) : 0,
      workspaceDeltaCalls: autoDelta ? 1 : 0,
      changedFilesSource: autoDelta ? 'workspace_delta' : (explicitChanged.length > 0 ? 'explicit' : 'none'),
      changedFiles: graphChanged.length,
      seedFiles: seeds.length,
      graphWorkspaceRelation: graphBinding ? (graphBinding.boundRoot === graphBinding.requestedRoot ? 'exact' : 'ancestor') : null,
    },
  };
}

export const CODE_CONTEXT_TOOL = {
  name: 'code_context',
  purpose: 'Compose trusted read-only graph impact, bounded source retrieval, and explicit exact-symbol lookups without owning their indexes.',
  when_to_use: 'When one task needs CRG-seeded source context and optionally a small explicit set of Serena symbol lookups.',
  when_not_to_use: 'For implicit natural-language symbol inference, mutations, graph/index construction, or arbitrary downstream tool execution.',
  readOnly: true,
  mutating: false,
  preferredFrozenSurface: 'read_file',
  inputSchema: {
    type: 'object',
    required: ['root', 'query'],
    additionalProperties: false,
    properties: {
      root: { type: 'string' },
      query: { type: 'string', minLength: 1, maxLength: 4000 },
      workspaceCursor: { type: 'string' },
      changedFiles: {
        type: 'array', minItems: 1, maxItems: MAX_CHANGED_FILES, items: { type: 'string' },
        description: 'Optional explicit changed-file set for graph impact. When omitted with graphServer, code_context derives the bounded set from workspace_delta.',
      },
      graphServer: { type: 'string', description: 'Workspace-bound CRG server. Uses explicit changedFiles when supplied, otherwise the shared workspace_delta contract.' },
      graphDepth: { type: 'integer', minimum: 0, maximum: 4, default: 2 },
      semanticServer: { type: 'string', description: 'Workspace-bound Serena server; requires symbolQueries.' },
      symbolQueries: {
        type: 'array', minItems: 1, maxItems: MAX_SYMBOL_QUERIES,
        items: {
          type: 'object', required: ['name_path_pattern'], additionalProperties: false,
          properties: {
            name_path_pattern: { type: 'string', minLength: 1, maxLength: 512 },
            relative_path: { type: 'string' },
            depth: { type: 'integer', minimum: 0, maximum: 2, default: 0 },
            include_info: {
              type: 'boolean', default: false,
              description: 'Requests language-server hover/type enrichment. Keep false for bulk or multi-symbol context; enable only for a small number of exact symbols when hover text is specifically needed.',
            },
            substring_matching: { type: 'boolean', default: false },
            max_matches: { type: 'integer', minimum: 1, maximum: MAX_SYMBOL_MATCHES, default: 8 },
            max_answer_chars: { type: 'integer', minimum: 1, maximum: MAX_SYMBOL_ANSWER_CHARS, default: 20000 },
          },
        },
      },
      maxFiles: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
      contextLines: { type: 'integer', minimum: 0, maximum: 20, default: 3 },
      maxLinesPerFile: { type: 'integer', minimum: 1, maximum: 500, default: 120 },
      maxTotalChars: { type: 'integer', minimum: 1, maximum: 500000, default: 60000 },
    },
  },
  recommended_workflow: [
    'For graph impact, code_context consumes the shared workspace_delta contract automatically when changedFiles is omitted; pass changedFiles only when the task already has a smaller authoritative set.',
    'Use symbolQueries only for exact symbol names already known from the task/context; this tool does not infer symbol identity from prose.',
    'Keep include_info=false for bulk or multi-symbol lookups; hover/type enrichment is substantially more expensive and should normally be requested only for one or two exact symbols that need it.',
    'Consume contextPack as the bounded source owner and semantic results as exact read-only evidence.',
  ],
  related_capabilities: ['context_pack', 'CRG get_impact_radius_tool', 'Serena find_symbol'],
};

export const SERENA_WORKSPACE_TOOL = {
  name: 'serena_workspace',
  purpose: 'Bind, inspect, warm, or release a session-scoped Serena workspace without switching another chat process.',
  when_to_use: 'Before Serena work when the chat needs a project root not safely owned by an existing session binding.',
  when_not_to_use: 'For symbol queries themselves; bind first, then use serena_call.',
  readOnly: false,
  mutating: true,
  preferredFrozenSurface: 'write_file',
  inputSchema: {
    type: 'object',
    required: ['operation'],
    additionalProperties: false,
    properties: {
      operation: { type: 'string', enum: ['bind', 'status', 'release'] },
      root: { type: 'string', description: 'Project directory; required for bind.' },
      session: { type: 'string', description: 'Opaque workspace-session token when no transport chat identity is available.' },
      templateServer: { type: 'string', description: 'Optional configured Serena template; exact-root templates are selected automatically.' },
      warm: { type: 'boolean', default: true },
    },
  },
  recommended_workflow: [
    'Bind the project root once per chat/session.',
    'If the result includes workspaceSession, retain it and pass it to later serena_workspace/serena_call calls.',
    'A cold_start status is informational: keep the returned session and retry rather than creating another Serena process.',
  ],
  related_capabilities: ['Serena MCP', 'persistent Serena symbol cache', 'serena_call'],
};

export const SERENA_CALL_TOOL = {
  name: 'serena_call',
  purpose: 'Call a tool on the Serena process bound to this chat/session, with explicit cold-start reporting.',
  when_to_use: 'For session-scoped Serena semantic reads/edits after serena_workspace bind.',
  when_not_to_use: 'Before a workspace is bound, or when a fixed configured Serena server already intentionally owns the call.',
  readOnly: false,
  mutating: true,
  preferredFrozenSurface: 'write_file',
  inputSchema: {
    type: 'object',
    required: ['tool'],
    additionalProperties: false,
    properties: {
      tool: { type: 'string', minLength: 1, maxLength: 128 },
      arguments: { type: 'object', additionalProperties: true, default: {} },
      session: { type: 'string', description: 'Opaque workspace-session token when required by serena_workspace.' },
    },
  },
  recommended_workflow: [
    'Reuse the same workspace session across calls.',
    'If status=cold_start is returned, wait/retry; the existing startup continues in the background.',
    'Do not retry mutation tools after an ambiguous downstream execution error.',
  ],
  related_capabilities: ['serena_workspace', 'find_symbol', 'find_referencing_symbols', 'Serena symbol edits'],
};

export function listBuiltinContextTools(tool?: string) {
  const tools = [CODE_CONTEXT_TOOL, SERENA_WORKSPACE_TOOL, SERENA_CALL_TOOL];
  if (tool === undefined) return tools.map((item) => ({ name: item.name, purpose: item.purpose, readOnly: item.readOnly, mutating: item.mutating }));
  const selected = tools.find((item) => item.name === tool);
  if (!selected) throw new Error(`Unknown ${BUILTIN_CONTEXT_SERVER_ID} tool: ${tool}`);
  return selected;
}
