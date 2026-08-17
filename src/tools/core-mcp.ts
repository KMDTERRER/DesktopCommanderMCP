import { zodToJsonSchema } from 'zod-to-json-schema';
import * as handlers from '../handlers/index.js';
import type { ServerResult } from '../types.js';
import { assertMcpCompatWriteFileOptions, isMcpCompatUri, unsupportedMcpReadFileOptions } from '../utils/mcp-uri.js';
import { getConfig, setConfigValue } from './config.js';
import { getUsageStats } from './usage.js';
import { giveFeedbackToDesktopCommander } from './feedback.js';
import { getPrompts } from './prompts.js';
import { toolArgSchemas } from './schemas.js';

export const BUILTIN_CORE_SERVER_ID = 'desktop-core';

// These are the compatibility gateway itself (or UI-internal), so mirroring
// them through desktop-core would either recurse or expose a host-only detail.
export const CORE_MCP_EXCLUDED_TOOLS = new Set([
  'mcp_list_tools',
  'mcp_call_tool',
  'track_ui_event',
]);

// Security classification for the frozen read_file compatibility surface.
// These tools may update diagnostic/read cursors in memory, but they do not
// mutate user files, process lifetime, stdin, configuration, or external state.
// Keep this intentionally narrower than all conceptually "read-like" tools.
export const CORE_MCP_READ_ONLY_TOOLS = new Set([
  'get_config',
  'get_usage_stats',
  'get_recent_tool_calls',
  'read_process_output',
  'list_sessions',
  'list_processes',
  'read_file',
  'read_multiple_files',
  'list_directory',
  'get_more_search_results',
  'list_searches',
  'get_file_info',
]);

export function isBuiltinCoreToolReadOnly(name: string): boolean {
  return CORE_MCP_READ_ONLY_TOOLS.has(name);
}

type CoreInvoker = (args: unknown) => Promise<ServerResult>;

async function compatAwareReadFile(args: unknown): Promise<ServerResult> {
  const filePath = (args as { path?: unknown } | null)?.path;
  if (!isMcpCompatUri(filePath)) {
    return handlers.handleReadFile(args);
  }
  const unsupportedOptions = unsupportedMcpReadFileOptions((args ?? {}) as Record<string, unknown>);
  if (unsupportedOptions.length > 0) {
    throw new Error(`mcp:// read_file does not support filesystem read options: ${unsupportedOptions.join(', ')}.`);
  }
  const { readExternalMcpCompatUri } = await import('./external-mcp.js');
  return readExternalMcpCompatUri(
    filePath,
    (args as { options?: Record<string, unknown> }).options,
  );
}

async function compatAwareWriteFile(args: unknown): Promise<ServerResult> {
  const value = args as { path?: unknown; content?: unknown } | null;
  const filePath = value?.path;
  if (!isMcpCompatUri(filePath)) {
    return handlers.handleWriteFile(args);
  }
  assertMcpCompatWriteFileOptions((args ?? {}) as Record<string, unknown>);
  const { callExternalMcpCompatUri, parseExternalMcpCompatUri } = await import('./external-mcp.js');
  const target = parseExternalMcpCompatUri(filePath);
  if (target?.server === BUILTIN_CORE_SERVER_ID && target.tool === 'write_file') {
    throw new Error('Recursive desktop-core/write_file routing is not allowed.');
  }
  return callExternalMcpCompatUri(filePath, String(value?.content ?? ''));
}

async function compatAwareReadMultipleFiles(args: unknown): Promise<ServerResult> {
  const paths = (args as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths) || !paths.some((value) => isMcpCompatUri(value))) {
    return handlers.handleReadMultipleFiles(args);
  }
  const { readMultipleFilesCompatAware } = await import('./external-mcp.js');
  return readMultipleFilesCompatAware(
    paths as string[],
    (filePath, maxOutputBytes) => handlers.handleReadFile({ path: filePath }, { maxOutputBytes }),
  );
}

const coreInvokers: Record<string, CoreInvoker> = {
  get_config: async () => getConfig(),
  set_config_value: (args) => setConfigValue(args),
  get_usage_stats: async () => getUsageStats(),
  get_prompts: (args) => getPrompts((args ?? {}) as Record<string, unknown>),
  give_feedback_to_desktop_commander: async () => giveFeedbackToDesktopCommander(),
  get_recent_tool_calls: (args) => handlers.handleGetRecentToolCalls(args),
  start_process: (args) => handlers.handleStartProcess(args),
  read_process_output: (args) => handlers.handleReadProcessOutput(args),
  interact_with_process: (args) => handlers.handleInteractWithProcess(args),
  force_terminate: (args) => handlers.handleForceTerminate(args),
  list_sessions: async () => handlers.handleListSessions(),
  list_processes: async () => handlers.handleListProcesses(),
  kill_process: (args) => handlers.handleKillProcess(args),
  read_file: (args) => compatAwareReadFile(args),
  read_multiple_files: (args) => compatAwareReadMultipleFiles(args),
  write_file: (args) => compatAwareWriteFile(args),
  write_pdf: (args) => handlers.handleWritePdf(args),
  create_directory: (args) => handlers.handleCreateDirectory(args),
  list_directory: (args) => handlers.handleListDirectory(args),
  move_file: (args) => handlers.handleMoveFile(args),
  start_search: (args) => handlers.handleStartSearch(args),
  get_more_search_results: (args) => handlers.handleGetMoreSearchResults(args),
  stop_search: (args) => handlers.handleStopSearch(args),
  list_searches: async () => handlers.handleListSearches(),
  get_file_info: (args) => handlers.handleGetFileInfo(args),
  edit_block: (args) => handlers.handleEditBlock(args),
};

function mirroredToolNames(): string[] {
  return Object.keys(toolArgSchemas)
    .filter((name) => !CORE_MCP_EXCLUDED_TOOLS.has(name))
    .sort();
}
export function assertCoreMcpCoverage(): void {
  const expected = mirroredToolNames();
  const actual = Object.keys(coreInvokers).sort();
  const missing = expected.filter((name) => !coreInvokers[name]);
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length || extra.length) {
    throw new Error(
      `desktop-core compatibility coverage mismatch. Missing: [${missing.join(', ')}]; extra: [${extra.join(', ')}].`,
    );
  }
}

function coreToolMetadata(name: string) {
  const schema = toolArgSchemas[name];
  if (!schema || CORE_MCP_EXCLUDED_TOOLS.has(name) || !coreInvokers[name]) {
    throw new Error(`Unknown ${BUILTIN_CORE_SERVER_ID} tool '${name}'.`);
  }
  const readOnly = isBuiltinCoreToolReadOnly(name);
  return {
    name,
    description: `Current Desktop Commander core tool schema mirror for frozen-client compatibility: ${name}.`,
    inputSchema: zodToJsonSchema(schema),
    readOnly,
    mutating: !readOnly,
    preferredFrozenSurface: readOnly ? 'read_file' as const : 'write_file' as const,
    compatibility: readOnly
      ? 'Use read_file(mcp://desktop-core/<tool>, options=<arguments>) for trusted read-only execution.'
      : 'Use write_file(mcp://desktop-core/<tool>, content=<arguments JSON>) for execution.',
  };
}

export function listBuiltinCoreTools(tool?: string) {
  assertCoreMcpCoverage();
  if (tool) return coreToolMetadata(tool);
  return mirroredToolNames().map((name) => ({
    name,
    description: `Current core schema mirror: ${name}.`,
    readOnly: isBuiltinCoreToolReadOnly(name),
    mutating: !isBuiltinCoreToolReadOnly(name),
    preferredFrozenSurface: isBuiltinCoreToolReadOnly(name) ? 'read_file' as const : 'write_file' as const,
  }));
}
export async function callBuiltinCoreTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<ServerResult> {
  assertCoreMcpCoverage();
  const schema = toolArgSchemas[tool];
  const invoke = coreInvokers[tool];
  if (!schema || !invoke || CORE_MCP_EXCLUDED_TOOLS.has(tool)) {
    throw new Error(`Unknown ${BUILTIN_CORE_SERVER_ID} tool '${tool}'.`);
  }

  // Validate against the canonical top-level schema, but pass the original
  // object to the handler. Some handlers intentionally distinguish omitted
  // optional fields from schema defaults (for example write_file.mode).
  schema.parse(args);
  return invoke(args);
}

// Fail at module load in development/production if a new core tool is added
// without a compatibility invoker. Schema-only changes are mirrored
// automatically because discovery reads directly from toolArgSchemas.
assertCoreMcpCoverage();
