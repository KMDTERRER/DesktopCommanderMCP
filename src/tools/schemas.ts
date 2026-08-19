import { z } from "zod";
import {
  DEFAULT_SEARCH_CONTEXT_LINES, DEFAULT_SEARCH_MAX_RESULTS,
  MAX_SEARCH_CONTEXT_LINES, MAX_SEARCH_FILE_PATTERN_CHARS, MAX_SEARCH_PAGE_LENGTH,
  MAX_SEARCH_PATTERN_CHARS, MAX_SEARCH_RESULTS, MAX_SEARCH_TIMEOUT_MS,
} from '../utils/search-limits.js';
import {
  PROCESS_INTERACTION_DEFAULT_MS, PROCESS_STALL_DEFAULT_MS, PROCESS_TRANSPORT_TIMEOUT_MAX_MS,
  PROCESS_WAIT_DEFAULT_MS, PROCESS_WAIT_MAX_MS,
} from '../utils/process-wait-contract.js';
import { MANAGED_TRASH_ENTRY_NAME } from '../utils/trash-contract.js';

// Config tools schemas
export const GetConfigArgsSchema = z.object({
  // 'ui' marks calls the config-editor widget fires programmatically; they are
  // excluded from tool-call telemetry (see isUiOriginCall in server.ts).
  origin: z.enum(['ui', 'llm']).optional(),
});

export const SetConfigValueArgsSchema = z.object({
  key: z.string(),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.null(),
  ]),
  // 'ui' marks widget-fired calls; excluded from tool-call telemetry.
  origin: z.enum(['ui', 'llm']).optional(),
});

// Empty schemas
export const ListProcessesArgsSchema = z.object({});

// Terminal tools schemas
export const StartProcessArgsSchema = z.object({
  command: z.string().min(1).optional(),
  executable: z.string().min(1).optional(),
  args: z.array(z.string().max(32768)).max(512).optional().default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string().max(32768)).optional().refine(
    value => value === undefined || Object.keys(value).length <= 128,
    { message: 'start_process.env accepts at most 128 entries' }
  ),
  execution_kind: z.enum(['auto', 'finite', 'interactive', 'service']).optional().default('auto'),
  pty: z.enum(['auto', 'never', 'always']).optional().default('auto'),
  timeout_ms: z.number().int().min(0).max(PROCESS_WAIT_MAX_MS).optional().default(PROCESS_WAIT_DEFAULT_MS),
  shell: z.string().optional(),
  verbose_timing: z.boolean().optional(),
  // 'ui' marks widget-fired calls (e.g. open-in-folder/editor buttons);
  // excluded from tool-call telemetry (see isUiOriginCall in server.ts).
  origin: z.enum(['ui', 'llm']).optional(),
}).refine(
  value => Boolean(value.command) !== Boolean(value.executable),
  { message: 'Provide exactly one of command or executable' }
);

export const ReadProcessOutputArgsSchema = z.object({
  pid: z.number(),
  timeout_ms: z.number().int().min(0).max(PROCESS_WAIT_MAX_MS).optional().default(PROCESS_WAIT_DEFAULT_MS),
  stall_timeout_ms: z.number().int().min(0).max(PROCESS_WAIT_MAX_MS).optional().default(PROCESS_STALL_DEFAULT_MS),
  offset: z.number().optional(),   // Line offset: 0=from last read, positive=absolute, negative=tail
  reader_id: z.string().min(1).max(128).optional(), // Independent offset=0 cursor for concurrent consumers
  length: z.number().optional(),   // Max lines to return (default from config.fileReadLineLimit)
  verbose_timing: z.boolean().optional(),
});

export const ForceTerminateArgsSchema = z.object({
  pid: z.number(),
});

export const ListSessionsArgsSchema = z.object({});

export const KillProcessArgsSchema = z.object({
  pid: z.number(),
});

// Filesystem tools schemas
export const ReadFileArgsSchema = z.object({
  path: z.string(),
  isUrl: z.boolean().optional().default(false),
  offset: z.number().optional().default(0),
  length: z.number().optional().default(1000),
  sheet: z.string().optional(),  // String only for MCP client compatibility (Cursor doesn't support union types in JSON Schema)
  range: z.string().optional(),
  options: z.record(z.any()).optional(),
  // Whether the call came from the file-preview UI (refresh/navigation) or the
  // LLM. 'ui' calls are excluded from tool-call telemetry; see isUiOriginCall
  // in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
});

export const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()).max(100),
});

export const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
  mode: z.enum(['rewrite', 'append']).default('rewrite'),
  // 'ui' when fired by the file-preview UI, else 'llm'. 'ui' calls are
  // excluded from tool-call telemetry; see isUiOriginCall in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
});

// PDF modification schemas - exported for reuse
export const PdfInsertOperationSchema = z.object({
  type: z.literal('insert'),
  pageIndex: z.number(),
  markdown: z.string().optional(),
  sourcePdfPath: z.string().optional(),
  pdfOptions: z.object({}).passthrough().optional(),
});

export const PdfDeleteOperationSchema = z.object({
  type: z.literal('delete'),
  pageIndexes: z.array(z.number()),
});

export const PdfOperationSchema = z.union([PdfInsertOperationSchema, PdfDeleteOperationSchema]);

export const WritePdfArgsSchema = z.object({
  path: z.string(),
  // Preprocess content to handle JSON strings that should be parsed as arrays
  content: z.preprocess(
    (val) => {
      // If it's a string that looks like JSON array, parse it
      if (typeof val === 'string' && val.trim().startsWith('[')) {
        try {
          return JSON.parse(val);
        } catch {
          // If parsing fails, return as-is (might be markdown content)
          return val;
        }
      }
      // Otherwise return as-is
      return val;
    },
    z.union([z.string(), z.array(PdfOperationSchema)])
  ),
  outputPath: z.string().optional(),
  options: z.object({}).passthrough().optional(), // Allow passing options to md-to-pdf
});

export const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

export const ListDirectoryArgsSchema = z.object({
  path: z.string(),
  depth: z.number().int().min(1).max(10).optional().default(2),
  // 'ui' when fired by the file-preview UI, else 'llm'. 'ui' calls are
  // excluded from tool-call telemetry; see isUiOriginCall in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
});

export const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

export const TrashActionArgsSchema = z.object({
  action: z.enum(['put', 'list', 'read', 'restore']),
  path: z.string().min(1).max(4096).optional(),
  name: z.string().regex(MANAGED_TRASH_ENTRY_NAME).optional(),
  workspace: z.string().min(1).max(4096).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'put') {
    if (!value.path) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'trash_action put requires path.' });
    if (value.name) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'trash_action put does not accept name.' });
    return;
  }
  if (value.path) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `trash_action ${value.action} does not accept path.` });
  if ((value.action === 'read' || value.action === 'restore') && !value.name) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `trash_action ${value.action} requires name.` });
  }
});

export const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

// Edit tools schema - SIMPLIFIED from three modes to two
// Previously supported: text replacement, location-based edits (edits array), and range rewrites
// Now supports only: text replacement and range rewrites
// Removed 'edits' array parameter - location-based surgical edits were complex and unnecessary
// Range rewrites are more powerful and cover all structured file editing needs
export const EditBlockArgsSchema = z.object({
  file_path: z.string(),
  // Text file string replacement
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  expected_replacements: z.number().int().min(1).max(10000).optional().default(1),
  // Structured file range rewrite (Excel, etc.)
  range: z.string().optional(),
  content: z.any().optional(),
  options: z.record(z.any()).optional(),
  // 'ui' when fired by the file-preview UI, else 'llm'. 'ui' calls are
  // excluded from tool-call telemetry; see isUiOriginCall in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
}).refine(
  data => {
    // Helper to check if value is actually provided (not undefined, not empty string)
    const hasValue = (v: unknown) => v !== undefined && v !== '';
    return (hasValue(data.old_string) && data.new_string !== undefined) ||
           (hasValue(data.range) && hasValue(data.content));
  },
  { message: "Must provide either (old_string + new_string) or (range + content)" }
);

// Send input to process schema
export const InteractWithProcessArgsSchema = z.object({
  pid: z.number(),
  input: z.string(),
  timeout_ms: z.number().int().min(0).max(PROCESS_WAIT_MAX_MS).optional().default(PROCESS_INTERACTION_DEFAULT_MS),
  wait_for_prompt: z.boolean().optional(),
  verbose_timing: z.boolean().optional(),
});

// Usage stats schema
export const GetUsageStatsArgsSchema = z.object({});

// Feedback tool schema - no pre-filled parameters, all user input
export const GiveFeedbackArgsSchema = z.object({
  // No parameters needed - form will be filled manually by user
  // Only auto-filled hidden fields remain:
  // - tool_call_count (auto)
  // - days_using (auto) 
  // - platform (auto)
  // - client_id (auto)
});

// Search schemas (renamed for natural language)
export const StartSearchArgsSchema = z.object({
  path: z.string().min(1),
  pattern: z.string().min(1).max(MAX_SEARCH_PATTERN_CHARS),
  searchType: z.enum(['files', 'content']).default('files'),
  filePattern: z.string().max(MAX_SEARCH_FILE_PATTERN_CHARS).optional(),
  ignoreCase: z.boolean().optional().default(true),
  maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional().default(DEFAULT_SEARCH_MAX_RESULTS),
  includeHidden: z.boolean().optional().default(false),
  contextLines: z.number().int().min(0).max(MAX_SEARCH_CONTEXT_LINES).optional().default(DEFAULT_SEARCH_CONTEXT_LINES),
  timeout_ms: z.number().int().min(0).max(MAX_SEARCH_TIMEOUT_MS).optional(), // 0 explicitly disables the process timer; manager supplies the bounded default
  earlyTermination: z.boolean().optional(), // Stop search early when exact filename match is found (default: true for files, false for content)
  literalSearch: z.boolean().optional().default(false), // Force literal string matching (-F flag) instead of regex
  // 'ui' marks widget-fired calls (e.g. markdown link-target search);
  // excluded from tool-call telemetry (see isUiOriginCall in server.ts).
  origin: z.enum(['ui', 'llm']).optional(),
});

export const GetMoreSearchResultsArgsSchema = z.object({
  sessionId: z.string().min(1),
  offset: z.number().int().optional().default(0),    // Negative values retain tail semantics
  length: z.number().int().min(1).max(MAX_SEARCH_PAGE_LENGTH).optional().default(100),
});

export const StopSearchArgsSchema = z.object({
  sessionId: z.string(),
});

export const ListSearchesArgsSchema = z.object({});

// Prompts tool schema - SIMPLIFIED (only get_prompt action)
export const GetPromptsArgsSchema = z.object({
  action: z.enum(['get_prompt']),
  promptId: z.string(),
  // Disabled to check if it makes sense or should be removed or changed
  // anonymous_user_use_case: z.string().optional(),
});

// Tool history schema
export const GetRecentToolCallsArgsSchema = z.object({
  maxResults: z.number().min(1).max(1000).optional().default(50),
  maxOutputChars: z.number().int().min(4096).max(262144).optional().default(32768),
  toolName: z.string().optional(),
  since: z.string().datetime().optional(),
});

export const McpListToolsArgsSchema = z.object({
  server: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(100).max(45000).optional().default(10000),
});

export const McpCallToolArgsSchema = z.object({
  server: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.record(z.unknown()).optional().default({}),
  timeout_ms: z.number().int().min(100).max(PROCESS_TRANSPORT_TIMEOUT_MAX_MS).optional(),
});

export const TrackUiEventArgsSchema = z.object({
  event: z.string().min(1).max(80),
  component: z.string().optional().default('file_preview'),
  params: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().default({}),
});

/**
 * Map of tool name -> argument schema, used by the dispatcher to detect and warn
 * about parameters a caller sent that the tool does not support. Keep in sync
 * with the tool definitions in server.ts.
 */
export const toolArgSchemas: Record<string, z.ZodTypeAny> = {
  get_config: GetConfigArgsSchema,
  set_config_value: SetConfigValueArgsSchema,
  read_file: ReadFileArgsSchema,
  read_multiple_files: ReadMultipleFilesArgsSchema,
  write_file: WriteFileArgsSchema,
  write_pdf: WritePdfArgsSchema,
  create_directory: CreateDirectoryArgsSchema,
  list_directory: ListDirectoryArgsSchema,
  move_file: MoveFileArgsSchema,
  trash_action: TrashActionArgsSchema,
  start_search: StartSearchArgsSchema,
  get_more_search_results: GetMoreSearchResultsArgsSchema,
  stop_search: StopSearchArgsSchema,
  list_searches: ListSearchesArgsSchema,
  get_file_info: GetFileInfoArgsSchema,
  edit_block: EditBlockArgsSchema,
  start_process: StartProcessArgsSchema,
  read_process_output: ReadProcessOutputArgsSchema,
  interact_with_process: InteractWithProcessArgsSchema,
  force_terminate: ForceTerminateArgsSchema,
  list_sessions: ListSessionsArgsSchema,
  list_processes: ListProcessesArgsSchema,
  kill_process: KillProcessArgsSchema,
  get_usage_stats: GetUsageStatsArgsSchema,
  get_recent_tool_calls: GetRecentToolCallsArgsSchema,
  mcp_list_tools: McpListToolsArgsSchema,
  mcp_call_tool: McpCallToolArgsSchema,
  give_feedback_to_desktop_commander: GiveFeedbackArgsSchema,
  get_prompts: GetPromptsArgsSchema,
  track_ui_event: TrackUiEventArgsSchema,
};
