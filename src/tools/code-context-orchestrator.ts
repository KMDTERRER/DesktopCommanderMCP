import path from 'path';
import { remainingOperationMs } from '../utils/operation-scope.js';
import { MAX_WORKSPACE_CURSOR_TRANSPORT_BYTES } from './workspace-accelerators.js';

const MAX_OPERATION_TIMEOUT_MS = 45_000;
const MAX_CHANGED_FILES = 100;
const MAX_SEED_FILES = 100;
const MAX_SYMBOL_QUERIES = 8;
const MAX_SYMBOL_MATCHES = 20;
const MAX_SYMBOL_ANSWER_CHARS = 40_000;
const MAX_SEMANTIC_EXPANSION_SEEDS = 8;
const MAX_SEMANTIC_FILES = 40;
const MAX_SEMANTIC_RELATIONS = 100;
const MAX_SEMANTIC_EXPANSION_ANSWER_CHARS = 12_000;
const MAX_SEMANTIC_SNIPPET_CHARS = 1200;
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

type SemanticExpandMode = 'none' | 'references' | 'all';
type SemanticBodyLocation = { start_line: number; end_line: number };
type SemanticSeed = {
  queryIndex: number;
  namePath: string;
  relativePath: string;
  bodyLocation?: SemanticBodyLocation;
  answerChars: number;
  ordinal: number;
};
type SemanticTruncatedQuery = { queryIndex: number; maxMatches: number; reportedMatches?: number };
type SemanticTruncatedExpansionCall = {
  kind: 'reference' | 'implementation';
  seedNamePath: string;
  seedRelativePath: string;
};
type ParsedSemanticRelations = { relations: SemanticRelation[]; files: string[]; truncated: boolean };
type SemanticRelation = {
  kind: 'reference' | 'implementation';
  seedNamePath: string;
  seedRelativePath: string;
  relativePath: string;
  namePath?: string;
  symbolKind?: string;
  bodyLocation?: SemanticBodyLocation;
  snippet?: string;
};

export type ContextWorkspaceBinding = { requestedRoot: string; boundRoot: string };

export type CodeContextDependencies = {
  callBuiltin: (tool: string, args: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  callTrustedExternal: (server: string, tool: string, args: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  assertWorkspace: (
    server: string, root: string, timeoutMs: number, relation: 'exact' | 'ancestor',
  ) => Promise<ContextWorkspaceBinding>;
  callSessionSemantic?: (
    session: string, tool: string, args: Record<string, unknown>, timeoutMs: number,
  ) => Promise<unknown>;
  assertSessionWorkspace?: (session: string, root: string, timeoutMs: number) => Promise<ContextWorkspaceBinding>;
};
function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
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

function semanticExpandMode(value: unknown): SemanticExpandMode {
  if (value === undefined) return 'references';
  if (value === 'none' || value === 'references' || value === 'all') return value;
  throw new Error("code_context.semanticExpand must be one of: none, references, all.");
}

function semanticBodyLocation(value: unknown): SemanticBodyLocation | undefined {
  const object = recordValue(value);
  const start = object?.start_line;
  const end = object?.end_line;
  if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) < (start as number)) {
    return undefined;
  }
  return { start_line: start as number, end_line: end as number };
}

function serenaPayload(value: unknown): unknown {
  const unwrapped = unwrapResult(value);
  const object = recordValue(unwrapped);
  const encoded = object && typeof object.result === 'string'
    ? object.result
    : typeof unwrapped === 'string' ? unwrapped : undefined;
  if (encoded === undefined) return unwrapped;
  try { return JSON.parse(encoded); } catch { return encoded; }
}

function findSymbolCandidates(value: unknown): { candidates: unknown[]; truncated: boolean; reportedMatches?: number } {
  const unwrapped = unwrapResult(value);
  const object = recordValue(unwrapped);
  const encoded = object && typeof object.result === 'string'
    ? object.result
    : typeof unwrapped === 'string' ? unwrapped : undefined;
  if (encoded === undefined) {
    if (Array.isArray(unwrapped)) return { candidates: unwrapped, truncated: false };
    const direct = recordValue(unwrapped);
    if (direct && typeof direct.name_path === 'string' && typeof direct.relative_path === 'string') {
      return { candidates: [direct], truncated: false };
    }
    throw new Error('code_context Serena find_symbol returned an invalid symbol contract.');
  }
  try {
    const parsed = JSON.parse(encoded);
    if (typeof parsed !== 'string') {
      if (Array.isArray(parsed)) return { candidates: parsed, truncated: false };
      const direct = recordValue(parsed);
      if (direct && typeof direct.name_path === 'string' && typeof direct.relative_path === 'string') {
        return { candidates: [direct], truncated: false };
      }
      throw new Error('code_context Serena find_symbol returned an invalid symbol contract.');
    }
  } catch { /* Serena shortened output is a text prefix followed by JSON. */ }
  const marker = 'Shortened result:';
  const markerIndex = encoded.indexOf(marker);
  if (markerIndex < 0) {
    if (encoded.includes('The answer is too long')) return { candidates: [], truncated: true };
    throw new Error('code_context Serena find_symbol returned an invalid symbol contract.');
  }
  const prefix = encoded.slice(0, markerIndex);
  const reportedMatch = /Matched\s+(\d+)>/.exec(prefix);
  let shortened: unknown;
  try {
    shortened = JSON.parse(encoded.slice(markerIndex + marker.length).trim());
  } catch {
    return { candidates: [], truncated: true, ...(reportedMatch ? { reportedMatches: Number(reportedMatch[1]) } : {}) };
  }
  const candidates: unknown[] = [];
  const byPath = recordValue(shortened);
  if (byPath) {
    for (const [relativePath, rawNames] of Object.entries(byPath)) {
      if (!Array.isArray(rawNames)) continue;
      for (const rawName of rawNames) {
        if (typeof rawName === 'string' && rawName.trim()) {
          candidates.push({ name_path: rawName.trim(), relative_path: relativePath });
        } else {
          const item = recordValue(rawName);
          if (item && typeof item.name_path === 'string') candidates.push({ ...item, relative_path: relativePath });
        }
      }
    }
  }
  return {
    candidates, truncated: true,
    ...(reportedMatch ? { reportedMatches: Number(reportedMatch[1]) } : {}),
  };
}

function semanticTerms(value: string): string[] {
  return [...new Set(value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 3))];
}

function semanticSeedScore(seed: SemanticSeed, symbol: SymbolQuery, taskQuery: string): number {
  const name = seed.namePath.toLowerCase();
  const candidate = `${seed.namePath} ${seed.relativePath}`.toLowerCase();
  const pattern = symbol.name_path_pattern.trim().toLowerCase();
  let score = 0;
  if (name === pattern) score += 240;
  else if (name.endsWith(`/${pattern}`)) score += 180;
  else if (name.includes(pattern)) score += 100;
  if (symbol.relative_path && normalizeSlash(symbol.relative_path).toLowerCase() === seed.relativePath.toLowerCase()) score += 240;
  const candidateTerms = new Set(semanticTerms(candidate));
  for (const term of semanticTerms(taskQuery)) {
    if (candidateTerms.has(term)) score += 24;
    else if (candidate.includes(term)) score += 6;
  }
  for (const term of semanticTerms(symbol.name_path_pattern)) {
    if (candidateTerms.has(term)) score += 12;
  }
  return score;
}

function semanticSeedsFromResults(
  results: Array<{ query: SymbolQuery; result: unknown }>, taskQuery: string,
): { seeds: SemanticSeed[]; total: number; sourceTruncated: boolean; truncatedQueries: SemanticTruncatedQuery[] } {
  const all: SemanticSeed[] = [];
  const seen = new Set<string>();
  const truncatedQueries: SemanticTruncatedQuery[] = [];
  let ordinal = 0;
  results.forEach((entry, queryIndex) => {
    const parsed = findSymbolCandidates(entry.result);
    if (parsed.truncated) {
      truncatedQueries.push({
        queryIndex, maxMatches: entry.query.max_matches,
        ...(parsed.reportedMatches !== undefined ? { reportedMatches: parsed.reportedMatches } : {}),
      });
    }
    for (const candidate of parsed.candidates) {
      const item = recordValue(candidate);
      if (!item || typeof item.name_path !== 'string' || typeof item.relative_path !== 'string') continue;
      const namePath = item.name_path.trim();
      const relativePath = normalizeSlash(item.relative_path.trim());
      if (!namePath || !relativePath) continue;
      const key = `${relativePath}\u0000${namePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        queryIndex, namePath, relativePath, answerChars: entry.query.max_answer_chars, ordinal: ordinal++,
        ...(semanticBodyLocation(item.body_location) ? { bodyLocation: semanticBodyLocation(item.body_location) } : {}),
      });
    }
  });
  const ranked = [...all].sort((left, right) =>
    semanticSeedScore(right, results[right.queryIndex].query, taskQuery)
      - semanticSeedScore(left, results[left.queryIndex].query, taskQuery)
    || left.ordinal - right.ordinal);
  const selected: SemanticSeed[] = [];
  const selectedKeys = new Set<string>();
  for (let queryIndex = 0; queryIndex < results.length && selected.length < MAX_SEMANTIC_EXPANSION_SEEDS; queryIndex++) {
    const best = ranked.find((seed) => seed.queryIndex === queryIndex);
    if (!best) continue;
    const key = `${best.relativePath}\u0000${best.namePath}`;
    selected.push(best);
    selectedKeys.add(key);
  }
  for (const seed of ranked) {
    if (selected.length >= MAX_SEMANTIC_EXPANSION_SEEDS) break;
    const key = `${seed.relativePath}\u0000${seed.namePath}`;
    if (selectedKeys.has(key)) continue;
    selected.push(seed);
    selectedKeys.add(key);
  }
  return {
    seeds: selected, total: all.length, sourceTruncated: truncatedQueries.length > 0, truncatedQueries,
  };
}

function semanticScopePath(value: string, binding: ContextWorkspaceBinding): string | null {
  const normalized = normalizeSlash(value.trim());
  if (!normalized) return null;
  const fsPath = normalized.split('/').join(path.sep);
  const absolute = path.isAbsolute(fsPath) ? path.resolve(fsPath) : path.resolve(binding.boundRoot, fsPath);
  if (!pathWithin(binding.requestedRoot, absolute)) return null;
  const relative = normalizeSlash(path.relative(binding.requestedRoot, absolute));
  return relative && relative !== '..' ? relative : null;
}

function compactSnippet(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().slice(0, MAX_SEMANTIC_SNIPPET_CHARS);
}

function serenaResultText(value: unknown): string | undefined {
  const unwrapped = unwrapResult(value);
  const object = recordValue(unwrapped);
  if (object && typeof object.result === 'string') return object.result;
  return typeof unwrapped === 'string' ? unwrapped : undefined;
}

function jsonAfterMarker(encoded: string, marker: string): unknown | undefined {
  const markerIndex = encoded.indexOf(marker);
  if (markerIndex < 0) return undefined;
  try { return JSON.parse(encoded.slice(markerIndex + marker.length).trim()); } catch { return undefined; }
}

function referenceRelations(value: unknown, seed: SemanticSeed, binding: ContextWorkspaceBinding): ParsedSemanticRelations {
  const encoded = serenaResultText(value);
  const tooLong = typeof encoded === 'string' && encoded.includes('The answer is too long');
  const withoutContext = typeof encoded === 'string'
    ? jsonAfterMarker(encoded, 'References without surrounding lines:')
    : undefined;
  const countOnly = withoutContext === undefined && typeof encoded === 'string'
    ? jsonAfterMarker(encoded, 'Reference counts per file:')
    : undefined;
  if (countOnly !== undefined) {
    const counts = recordValue(countOnly);
    const files = counts
      ? Object.keys(counts).map((rawFile) => semanticScopePath(rawFile, binding)).filter((item): item is string => item !== null)
      : [];
    return { relations: [], files: [...new Set(files)], truncated: true };
  }
  const payload = recordValue(withoutContext ?? serenaPayload(value));
  if (!payload) return { relations: [], files: [], truncated: tooLong || withoutContext !== undefined };
  const relations: SemanticRelation[] = [];
  for (const [rawFile, rawKinds] of Object.entries(payload)) {
    const relativePath = semanticScopePath(rawFile, binding);
    const kinds = recordValue(rawKinds);
    if (!relativePath || !kinds) continue;
    for (const [symbolKind, rawItems] of Object.entries(kinds)) {
      if (!Array.isArray(rawItems)) continue;
      for (const rawItem of rawItems) {
        const item = recordValue(rawItem);
        if (!item) continue;
        relations.push({
          kind: 'reference',
          seedNamePath: seed.namePath,
          seedRelativePath: seed.relativePath,
          relativePath,
          ...(typeof item.name_path === 'string' && item.name_path.trim() ? { namePath: item.name_path.trim() } : {}),
          ...(symbolKind ? { symbolKind } : {}),
          ...(semanticBodyLocation(item.body_location) ? { bodyLocation: semanticBodyLocation(item.body_location) } : {}),
          ...(compactSnippet(item.content_around_reference) ? { snippet: compactSnippet(item.content_around_reference) } : {}),
        });
      }
    }
  }
  return { relations, files: [], truncated: tooLong || withoutContext !== undefined };
}

function implementationRelations(value: unknown, seed: SemanticSeed, binding: ContextWorkspaceBinding): ParsedSemanticRelations {
  const payload = serenaPayload(value);
  if (!Array.isArray(payload)) {
    const encoded = serenaResultText(value);
    return { relations: [], files: [], truncated: typeof encoded === 'string' && encoded.includes('The answer is too long') };
  }
  const relations: SemanticRelation[] = [];
  for (const rawItem of payload) {
    const item = recordValue(rawItem);
    if (!item || typeof item.relative_path !== 'string') continue;
    const relativePath = semanticScopePath(item.relative_path, binding);
    if (!relativePath) continue;
    relations.push({
      kind: 'implementation',
      seedNamePath: seed.namePath,
      seedRelativePath: seed.relativePath,
      relativePath,
      ...(typeof item.name_path === 'string' && item.name_path.trim() ? { namePath: item.name_path.trim() } : {}),
      ...(typeof item.kind === 'string' && item.kind.trim() ? { symbolKind: item.kind.trim() } : {}),
      ...(semanticBodyLocation(item.body_location) ? { bodyLocation: semanticBodyLocation(item.body_location) } : {}),
    });
  }
  return { relations, files: [], truncated: false };
}

function requestedScopePrefix(binding: ContextWorkspaceBinding): string {
  return normalizeSlash(path.relative(binding.boundRoot, binding.requestedRoot));
}

function translatedChangedFiles(
  values: string[], binding: ContextWorkspaceBinding,
): { graph: string[]; scope: string[] } {
  const prefix = requestedScopePrefix(binding);
  const scope: string[] = [];
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
    const scopeRelative = normalizeSlash(path.relative(binding.requestedRoot, absolute));
    if (relative && !files.includes(relative)) files.push(relative);
    if (scopeRelative && !scope.includes(scopeRelative)) scope.push(scopeRelative);
  }
  return { graph: files, scope };
}

function impactedFiles(
  value: unknown, binding: ContextWorkspaceBinding,
): { graph: string[]; scope: string[]; truncated: boolean } {
  const result = recordValue(unwrapResult(value));
  if (!result || !Array.isArray(result.impacted_files)
      || result.impacted_files.some((item) => typeof item !== 'string')) {
    throw new Error('code_context graph impact returned an invalid graph contract.');
  }
  const raw = result.impacted_files;
  let truncated = false;
  const graph: string[] = [];
  const scope: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const absolute = path.isAbsolute(item) ? path.resolve(item) : path.resolve(binding.boundRoot, item);
    if (!pathWithin(binding.requestedRoot, absolute)) continue;
    const graphRelative = normalizeSlash(path.relative(binding.boundRoot, absolute));
    const scopeRelative = normalizeSlash(path.relative(binding.requestedRoot, absolute));
    if (graphRelative && !graph.includes(graphRelative)) {
      if (graph.length >= MAX_SEED_FILES) { truncated = true; continue; }
      graph.push(graphRelative);
    }
    if (scopeRelative && !scope.includes(scopeRelative)) scope.push(scopeRelative);

  }
  return { graph, scope, truncated };
}

function compactContextPack(value: unknown) {
  const result = recordValue(unwrapResult(value));
  if (!result
      || typeof result.repositoryRoot !== 'string'
      || typeof result.scopeRoot !== 'string'
      || !Array.isArray(result.seedFilesAccepted)
      || !Array.isArray(result.missingSeedFiles)
      || !Array.isArray(result.files)) {
    throw new Error('code_context context_pack returned an invalid context contract.');
  }
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

function compactGraph(value: unknown, files: string[], locallyTruncated = false) {
  const result = recordValue(unwrapResult(value));
  if (!result) return { impactedFiles: files };
  return {
    status: typeof result.status === 'string' ? result.status : null,
    summary: typeof result.summary === 'string' ? result.summary.slice(0, 4000) : null,
    truncated: result.truncated === true || locallyTruncated,
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

async function expandSemanticResults(
  results: Array<{ query: SymbolQuery; result: unknown }>,
  taskQuery: string,
  mode: SemanticExpandMode,
  maxFiles: number,
  maxRelations: number,
  binding: ContextWorkspaceBinding,
  callSemantic: (tool: string, args: Record<string, unknown>, timeoutMs: number) => Promise<unknown>,
  deadlineAt: number,
) {
  const seedState = semanticSeedsFromResults(results, taskQuery);
  const files: string[] = [];
  const fileSet = new Set<string>();
  const scopedSeeds: SemanticSeed[] = [];
  let truncated = seedState.sourceTruncated || seedState.total > seedState.seeds.length;

  const acceptFile = (candidate: string): boolean => {
    if (fileSet.has(candidate)) return true;
    if (files.length >= maxFiles) {
      truncated = true;
      return false;
    }
    fileSet.add(candidate);
    files.push(candidate);
    return true;
  };

  for (const seed of seedState.seeds) {
    const relativePath = semanticScopePath(seed.relativePath, binding);
    if (!relativePath) {
      truncated = true;
      continue;
    }
    if (!acceptFile(relativePath)) continue;
    scopedSeeds.push({ ...seed, relativePath });
  }

  const tasks: Array<{ kind: 'reference' | 'implementation'; seed: SemanticSeed }> = [];
  if (mode !== 'none') {
    for (const seed of scopedSeeds) {
      tasks.push({ kind: 'reference', seed });
      if (mode === 'all') tasks.push({ kind: 'implementation', seed });
    }
  }

  const expanded = await mapConcurrent(tasks, SEMANTIC_CONCURRENCY, async (task) => {
    const tool = task.kind === 'reference' ? 'find_referencing_symbols' : 'find_implementations';
    const args = task.kind === 'reference'
      ? {
          name_path: task.seed.namePath,
          relative_path: task.seed.relativePath,
          max_answer_chars: Math.min(task.seed.answerChars, MAX_SEMANTIC_EXPANSION_ANSWER_CHARS),
        }
      : {
          name_path: task.seed.namePath,
          relative_path: task.seed.relativePath,
          include_info: false,
          max_answer_chars: Math.min(task.seed.answerChars, MAX_SEMANTIC_EXPANSION_ANSWER_CHARS),
        };
    return {
      task,
      result: await callSemantic(
        tool, args, remainingOperationMs(deadlineAt, `code_context semantic ${task.kind} expansion`),
      ),
    };
  });

  const relations: SemanticRelation[] = [];
  const relationSet = new Set<string>();
  let downstreamTruncated = false;
  const truncatedExpansionCalls: SemanticTruncatedExpansionCall[] = [];
  for (const item of expanded) {
    const parsed = item.task.kind === 'reference'
      ? referenceRelations(item.result, item.task.seed, binding)
      : implementationRelations(item.result, item.task.seed, binding);
    if (parsed.truncated) {
      truncated = true;
      downstreamTruncated = true;
      truncatedExpansionCalls.push({
        kind: item.task.kind,
        seedNamePath: item.task.seed.namePath,
        seedRelativePath: item.task.seed.relativePath,
      });
    }
    for (const file of parsed.files) acceptFile(file);
    for (const relation of parsed.relations) {
      if (!acceptFile(relation.relativePath)) continue;
      const key = [
        relation.kind, relation.seedRelativePath, relation.seedNamePath, relation.relativePath,
        relation.namePath ?? '', relation.bodyLocation?.start_line ?? '',
      ].join('\u0000');
      if (relationSet.has(key)) continue;
      relationSet.add(key);
      if (relations.length >= maxRelations) {
        truncated = true;
        continue;
      }
      relations.push(relation);
    }
  }

  return {
    mode,
    seedCount: seedState.total,
    expandedSeedCount: scopedSeeds.length,
    sourceTruncated: seedState.sourceTruncated,
    truncatedQueries: seedState.truncatedQueries,
    selectedSeeds: scopedSeeds.map(({ queryIndex, namePath, relativePath }) => ({ queryIndex, namePath, relativePath })),
    downstreamTruncated,
    truncatedExpansionCalls,
    calls: tasks.length,
    files,
    relations,
    truncated,
  };
}
export async function callCodeContextOrchestrator(
  args: Record<string, unknown>, deps: CodeContextDependencies, timeoutMs = 30_000,
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`code_context timeout must be an integer from 100 to ${MAX_OPERATION_TIMEOUT_MS}ms.`);
  }
  const allowed = new Set([
    'root', 'query', 'workspaceCursor', 'changedFiles', 'graphServer', 'graphDepth',
    'semanticServer', 'semanticSession', 'symbolQueries', 'semanticExpand', 'semanticMaxFiles', 'semanticMaxRelations',
    'maxFiles', 'contextLines', 'maxLinesPerFile', 'maxTotalChars',
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
  const semanticSession = args.semanticSession === undefined ? null : boundedString(args.semanticSession, 'code_context.semanticSession', 128);
  const symbols = symbolQueries(args.symbolQueries);
  const semanticExpand = semanticExpandMode(args.semanticExpand);
  const semanticMaxFiles = boundedInteger(args.semanticMaxFiles, 12, 1, MAX_SEMANTIC_FILES, 'code_context.semanticMaxFiles');
  const semanticMaxRelations = boundedInteger(
    args.semanticMaxRelations, 32, 1, MAX_SEMANTIC_RELATIONS, 'code_context.semanticMaxRelations',
  );
  if (semanticServer && semanticSession) {
    throw new Error('code_context.semanticServer and semanticSession are mutually exclusive.');
  }
  const hasSemanticProvider = Boolean(semanticServer || semanticSession);
  if (hasSemanticProvider && symbols.length === 0) {
    throw new Error('code_context semantic provider requires symbolQueries.');
  }
  if (!hasSemanticProvider && symbols.length > 0) {
    throw new Error('code_context.symbolQueries requires semanticServer or semanticSession.');
  }
  if (!hasSemanticProvider && (args.semanticExpand !== undefined || args.semanticMaxFiles !== undefined || args.semanticMaxRelations !== undefined)) {
    throw new Error('code_context semantic expansion options require semanticServer or semanticSession.');
  }
  if (semanticSession && (!deps.callSessionSemantic || !deps.assertSessionWorkspace)) {
    throw new Error('code_context session-scoped semantic provider is not configured.');
  }
  const callSemantic = semanticServer
    ? (tool: string, toolArgs: Record<string, unknown>, callTimeout: number) =>
        deps.callTrustedExternal(semanticServer, tool, toolArgs, callTimeout)
    : semanticSession
      ? (tool: string, toolArgs: Record<string, unknown>, callTimeout: number) =>
          deps.callSessionSemantic!(semanticSession, tool, toolArgs, callTimeout)
      : null;
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
      }, remainingOperationMs(deadlineAt, 'code_context workspace delta'))
    : Promise.resolve(null);
  const [graphBinding, semanticBinding, rawAutoDelta] = await Promise.all([
    graphServer
      ? deps.assertWorkspace(graphServer, root, remainingOperationMs(deadlineAt, 'code_context graph workspace'), 'ancestor')
      : Promise.resolve(null),
    semanticServer
      ? deps.assertWorkspace(semanticServer, root, remainingOperationMs(deadlineAt, 'code_context semantic workspace'), 'exact')
      : semanticSession
        ? deps.assertSessionWorkspace!(semanticSession, root, remainingOperationMs(deadlineAt, 'code_context semantic session workspace'))
        : Promise.resolve(null),
    autoDeltaPromise,
  ]);
  const autoDelta = rawAutoDelta === null ? null : workspaceDeltaContract(rawAutoDelta);
  const changed = explicitChanged.length > 0 ? explicitChanged : (autoDelta?.changedFiles ?? []);
  const translatedChanged = graphBinding
    ? translatedChangedFiles(changed, graphBinding)
    : { graph: changed, scope: changed };
  const graphChanged = translatedChanged.graph;
  if (graphServer && explicitChanged.length > 0 && graphChanged.length === 0) {
    throw new Error('code_context.graphServer received no changedFiles inside the requested root scope.');
  }
  // context_pack owns transient-path relevance. Reuse the caller's baseline cursor
  // so it observes the same delta itself instead of receiving the already-advanced
  // cursor and requiring raw auto-delta paths to be promoted as explicit seeds.
  const contextWorkspaceCursor = workspaceCursor;

  const semanticPromise = callSemantic
    ? mapConcurrent(symbols, SEMANTIC_CONCURRENCY, async (symbol) => ({
        query: symbol,
        result: unwrapResult(await callSemantic('find_symbol', {
          ...symbol,
          include_body: false,
        }, remainingOperationMs(deadlineAt, 'code_context semantic query'))),
      }))
    : Promise.resolve([]);
  // Observe semantic rejection immediately while graph work is in progress.
  const semanticSettled = semanticPromise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  const graphResult = graphServer
    ? await deps.callTrustedExternal(graphServer, 'get_impact_radius_tool', {
        changed_files: graphChanged,
        max_depth: graphDepth,
        detail_level: 'compact',
      }, remainingOperationMs(deadlineAt, 'code_context graph impact'))
    : null;
  const graphImpacts = graphResult && graphBinding
    ? impactedFiles(graphResult, graphBinding)
    : { graph: [], scope: [], truncated: false };
  const graphSeeds = graphImpacts.scope;
  const explicitRelevanceSeeds = explicitChanged.length > 0 ? translatedChanged.scope : [];
  const semanticOutcome = await semanticSettled;
  if (!semanticOutcome.ok) throw semanticOutcome.error;
  const semantic = semanticOutcome.value;
  const semanticExpansion = callSemantic && semanticBinding
    ? await expandSemanticResults(
        semantic, query, semanticExpand, semanticMaxFiles, semanticMaxRelations,
        semanticBinding, callSemantic, deadlineAt,
      )
    : {
        mode: 'none' as SemanticExpandMode, seedCount: 0, expandedSeedCount: 0, sourceTruncated: false,
        truncatedQueries: [] as SemanticTruncatedQuery[], selectedSeeds: [] as Array<{ queryIndex: number; namePath: string; relativePath: string }>,
        downstreamTruncated: false, truncatedExpansionCalls: [] as SemanticTruncatedExpansionCall[], calls: 0,
        files: [] as string[], relations: [] as SemanticRelation[], truncated: false,
      };
  const seedCandidates = [...new Set([
    ...explicitRelevanceSeeds, ...graphSeeds, ...semanticExpansion.files,
  ])];
  const seedFilesTruncated = seedCandidates.length > MAX_SEED_FILES;
  const seeds = seedCandidates.slice(0, MAX_SEED_FILES);

  const rawContextPack = await deps.callBuiltin('context_pack', {
    root,
    query,
    ...(contextWorkspaceCursor ? { workspaceCursor: contextWorkspaceCursor } : {}),
    ...(seeds.length > 0 ? { seedFiles: seeds } : {}),
    maxFiles,
    contextLines,
    maxLinesPerFile,
    maxTotalChars,
  }, remainingOperationMs(deadlineAt, 'code_context context pack'));
  const contextPack = compactContextPack(rawContextPack);
  return {
    root,
    query,
    graph: graphResult ? {
      server: graphServer,
      workspaceRoot: graphBinding?.boundRoot ?? null,
      ...compactGraph(graphResult, graphImpacts.scope, graphImpacts.truncated),
    } : null,
    contextPack,
    semantic: hasSemanticProvider ? {
      provider: semanticServer ? 'server' : 'session',
      ...(semanticServer ? { server: semanticServer } : { workspaceSession: semanticSession }),
      workspaceRoot: semanticBinding?.boundRoot ?? null,
      results: semantic, expansion: semanticExpansion,
    } : null,
    orchestration: {
      graphCalls: graphResult ? 1 : 0,
      contextPackCalls: 1,
      semanticCalls: semantic.length,
      semanticConcurrency: semantic.length > 0 ? Math.min(SEMANTIC_CONCURRENCY, semantic.length) : 0,
      semanticExpansionMode: semanticExpansion.mode,
      semanticExpansionCalls: semanticExpansion.calls,
      semanticSeedSymbols: semanticExpansion.seedCount,
      semanticFiles: semanticExpansion.files.length,
      semanticRelations: semanticExpansion.relations.length,
      workspaceDeltaCalls: autoDelta ? 1 : 0,
      changedFilesSource: autoDelta ? 'workspace_delta' : (explicitChanged.length > 0 ? 'explicit' : 'none'),
      changedFiles: graphChanged.length,
      seedCandidates: seedCandidates.length,
      seedFiles: seeds.length,
      seedFilesTruncated,
      graphWorkspaceRelation: graphBinding ? (graphBinding.boundRoot === graphBinding.requestedRoot ? 'exact' : 'ancestor') : null,
    },
  };
}

export const CODE_CONTEXT_TOOL = {
  name: 'code_context',
  purpose: 'Compose trusted graph impact, multi-file semantic fan-out, and bounded source retrieval without owning the underlying indexes.',
  when_to_use: 'When one task needs CRG/source context plus exact Serena symbols expanded into related files in one model round.',
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
      semanticServer: { type: 'string', description: 'Fixed workspace-bound Serena server; requires symbolQueries and is mutually exclusive with semanticSession.' },
      semanticSession: { type: 'string', description: 'Opaque workspaceSession returned by serena_workspace. Preferred for task/session-scoped Serena semantics; requires symbolQueries and is mutually exclusive with semanticServer.' },
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
      semanticExpand: {
        type: 'string', enum: ['none', 'references', 'all'], default: 'references',
        description: 'Expand exact Serena hits into related files. references follows callers/usages; all also includes implementations.',
      },
      semanticMaxFiles: {
        type: 'integer', minimum: 1, maximum: MAX_SEMANTIC_FILES, default: 12,
        description: 'Maximum unique semantic seed/reference/implementation files returned and promoted into context_pack.',
      },
      semanticMaxRelations: {
        type: 'integer', minimum: 1, maximum: MAX_SEMANTIC_RELATIONS, default: 32,
        description: 'Maximum compact reference/implementation relations returned across all semantic seeds.',
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
    'When serena_workspace already bound this task to a project, pass its workspaceSession as semanticSession so code_context can perform exact symbol fan-out without rebinding a global Serena server or requiring separate serena_call rounds.',
    'By default semanticExpand=references fans each exact hit into bounded cross-file usages and promotes those files into context_pack; use all only when implementations are materially relevant.',
    'Keep include_info=false for bulk or multi-symbol lookups; hover/type enrichment is substantially more expensive and should normally be requested only for one or two exact symbols that need it.',
    'Consume contextPack as the bounded source owner and semantic.expansion as compact exact relationship evidence.',
  ],
  related_capabilities: ['context_pack', 'CRG get_impact_radius_tool', 'Serena find_symbol/find_referencing_symbols/find_implementations'],
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
    'If the result includes workspaceSession, retain it and pass it to later serena_workspace/serena_read_batch/serena_call calls.',
    'A cold_start status is informational: keep the returned session and retry rather than creating another Serena process.',
  ],
  related_capabilities: ['Serena MCP', 'persistent Serena symbol cache', 'serena_read_batch', 'serena_call'],
};

export const SERENA_READ_BATCH_TOOL = {
  name: 'serena_read_batch',
  purpose: 'Execute several session-scoped Serena read-only semantic calls in one bounded model round.',
  when_to_use: 'After serena_workspace bind when several independent symbol/reference/diagnostic reads are already known.',
  when_not_to_use: 'For mutation/refactoring tools; those stay on single-call serena_call and are rejected from this batch.',
  readOnly: true,
  mutating: false,
  preferredFrozenSurface: 'read_file',
  inputSchema: {
    type: 'object',
    required: ['calls'],
    additionalProperties: false,
    properties: {
      calls: {
        type: 'array', minItems: 1, maxItems: 16,
        items: {
          type: 'object', required: ['tool'], additionalProperties: false,
          properties: {
            tool: { type: 'string', minLength: 1, maxLength: 128 },
            arguments: { type: 'object', additionalProperties: true, default: {} },
          },
        },
      },
      session: { type: 'string', description: 'Opaque workspace-session token when required by serena_workspace.' },
      concurrency: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
    },
  },
  recommended_workflow: [
    'Bind once with serena_workspace.',
    'Batch only already-known independent read queries; result order matches input order.',
    'Every downstream tool is re-checked against its live readOnlyHint before execution.',
    'Use code_context instead when one seed symbol should automatically fan out into related files.',
  ],
  related_capabilities: ['serena_workspace', 'serena_call', 'code_context', 'Serena read-only tools'],
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
  const tools = [CODE_CONTEXT_TOOL, SERENA_WORKSPACE_TOOL, SERENA_READ_BATCH_TOOL, SERENA_CALL_TOOL];
  if (tool === undefined) return tools.map((item) => ({ name: item.name, purpose: item.purpose, readOnly: item.readOnly, mutating: item.mutating }));
  const selected = tools.find((item) => item.name === tool);
  if (!selected) throw new Error(`Unknown ${BUILTIN_CONTEXT_SERVER_ID} tool: ${tool}`);
  return selected;
}
