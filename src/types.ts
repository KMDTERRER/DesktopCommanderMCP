import { FilteredStdioServerTransport } from './custom-stdio.js';
import type { PreviewFileType } from './ui/file-preview/shared/preview-file-types.js';
import type { CancellationCause } from './utils/cancellation.js';

declare global {
  var mcpTransport: FilteredStdioServerTransport | undefined;
  var disableOnboarding: boolean | undefined;
}

export interface ProcessInfo {
  pid: number;
  command: string;
  cpu: string;
  memory: string;
}

export interface TerminalProcessHandle {
  stdin: { destroyed?: boolean; write(data: string): unknown } | null;
  kill(signal?: NodeJS.Signals | number): unknown;
}

export interface OutputDecodingInfo {
  mode: 'utf8' | 'windows-adaptive';
  usedEncodings: string[];
  oemCodePage?: number;
  ansiCodePage?: number;
  probeWarning?: string;
}

export interface TerminalSession {
  pid: number;
  /** Opaque capability for process-scoped follow-up calls. */
  terminalSessionId: string;
  /** Remote conversation/thread identity that created this session, when supplied. */
  ownerSessionIdentity?: string;
  process: TerminalProcessHandle;
  backend: 'pipe' | 'pty';
  processTreeOwner?: 'windows_job' | 'posix_group' | 'pid_tree';
  executionKind: 'auto' | 'finite' | 'interactive' | 'service';
  outputDecoding?: OutputDecodingInfo;
  outputLines: string[];      // Line-based buffer (persistent, capped — oldest lines evicted)
  lastReadIndex: number;      // Track where "new" output starts for default reads
  outputRevision: number;     // Increments on every stdout/stderr chunk, including same-line progress
  lastReadRevision: number;   // Revision observed by the last default output read
  lastReadLineSnapshot?: string; // Last consumed tail line; detects later appends to an already-read partial line
  isBlocked: boolean;
  startTime: Date;
  lastOutputTime: Date;       // Updated on every stdout/stderr chunk; startTime until first output
  bufferedChars: number;      // Joined length of outputLines (content + separators)
  evictedLines: number;       // Lines dropped from the front to enforce the buffer cap
  evictedChars: number;       // Joined length of evicted lines (keeps snapshot offsets absolute)
  // Pipe processes may outlive their root PID through descendants that inherited
  // stdio. Keep root-exit and tree state separate from terminal completion.
  rootExitedAt?: Date;
  rootExitCode?: number | null;
  treeState?: 'root_running' | 'root_exited_draining' | 'descendants_running' | 'probe_uncertain';
  descendantPids?: number[];
  treeProbeWarning?: string;
  cancellationCause?: CancellationCause;
  cancellationDetail?: string;
  /** Backend/host failure distinct from the child program's stderr/exit code. */
  terminalError?: string;
}


export interface CommandExecutionResult {
  pid: number;
  output: string;
  isBlocked: boolean;
  backend?: 'pipe' | 'pty';
  terminalError?: string;
  timingInfo?: TimingInfo;
}

export interface TimingInfo {
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  exitReason: 'early_exit_quick_pattern' | 'early_exit_periodic_check' | 'process_exit' | 'root_exit_tree_running' | 'root_exit_probe_uncertain' | 'process_error' | 'timeout';
  firstOutputTime?: number;
  lastOutputTime?: number;
  timeToFirstOutputMs?: number;
  outputEvents?: OutputEvent[];
}

export interface OutputEvent {
  timestamp: number;
  deltaMs: number;
  source: 'stdout' | 'stderr' | 'pty';
  length: number;
  snippet: string;
  matchedPattern?: string;
}

export interface ActiveSession {
  pid: number;
  terminalSessionId: string;
  backend: 'pipe' | 'pty';
  processTreeOwner?: TerminalSession['processTreeOwner'];
  executionKind: 'auto' | 'finite' | 'interactive' | 'service';
  isBlocked: boolean;
  runtime: number;
  treeState?: TerminalSession['treeState'];
  rootExitCode?: number | null;
  descendantPids?: number[];
  cancellationCause?: CancellationCause;
  terminalError?: string;
  flowControlPaused?: boolean;
  unacknowledgedChars?: number;
}

export interface CompletedSession {
  pid: number;
  output: string;
  exitCode: number | null;
  startTime: Date;
  endTime: Date;
  cancellationCause?: CancellationCause;
}


// Define the server response types
export interface ServerResponseContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface FilePreviewStructuredContent {
  fileName: string;
  filePath: string;
  fileType: PreviewFileType;
  sourceTool?: 'read_file' | 'write_file' | 'edit_block';
  defaultEditorName?: string;
  defaultEditorPath?: string;
  // For text/markdown this is the file text; for images it is the base64 image
  // payload (single source — the preview UI renders the <img> from this).
  content?: string;
  mimeType?: string;
}

export interface ServerResult {
  content: ServerResponseContent[];
  structuredContent?: FilePreviewStructuredContent | Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  // MCP CallToolResult is extensible. Passthrough bridges must preserve
  // extension fields instead of silently whitelisting only today's keys.
  [key: string]: unknown;
}

// Define a helper type for tool handler functions
export type ToolHandler<T = unknown> = (args: T) => Promise<ServerResult>;
