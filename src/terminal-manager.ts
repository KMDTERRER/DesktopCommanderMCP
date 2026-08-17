import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { TerminalSession, CommandExecutionResult, ActiveSession, TimingInfo, OutputEvent } from './types.js';
import { DEFAULT_COMMAND_TIMEOUT } from './config.js';
import { configManager } from './config-manager.js';
import {capture} from "./utils/capture.js";
import { analyzeProcessState } from './utils/process-detection.js';
import { spawnIsolatedPty, type IsolatedPty } from './utils/isolated-pty.js';
import { createProcessOutputDecoder, mergeOutputDecodingInfo } from './utils/process-output-decoder.js';
import { probeProcessTree, terminateProcessTree } from './utils/process-tree.js';
import { getWindowsJobHelperFailure, spawnWindowsJobOwnedProcess, terminateWindowsJobOwnedProcess } from './utils/windows-job-owner.js';
import { makeCancellationError, type CancellationCause } from './utils/cancellation.js';

/**
 * Standard Windows PATHEXT value, used to repair a corrupted PATHEXT before
 * spawning child shells.
 *
 * On some Windows Claude Desktop / DXT launches the server process inherits a
 * broken PATHEXT (observed as ".CPL" only). Because we build the child env from
 * { ...process.env }, that broken value would propagate into every spawned
 * shell, stripping ".EXE" and breaking resolution of git / node / python / rg /
 * etc. (and even full-path .exe invocations under PowerShell). See issue #481.
 */
const STANDARD_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * Return a healthy PATHEXT for spawned Windows shells.
 * - Unset           -> use the standard list.
 * - Missing ".EXE"  -> corrupted; merge the standard list with whatever was
 *                      present (preserves any extra extensions, order-stable).
 * - Otherwise       -> leave the inherited value untouched.
 */
function getRepairedPathExt(): string {
  const current = process.env.PATHEXT;
  if (!current) return STANDARD_PATHEXT;
  const exts = current.split(';').map(e => e.trim().toUpperCase()).filter(Boolean);
  if (!exts.includes('.EXE')) {
    return [...new Set([...STANDARD_PATHEXT.split(';'), ...exts])].join(';');
  }
  return current;
}

interface ReaderCursor {
  lastReadIndex: number;
  lastReadRevision: number;
  lastReadLineSnapshot?: string;
  lastAccessTime: number;
}

interface CompletedSession {
  pid: number;
  outputLines: string[];       // Line-based buffer (consistent with active sessions)
  lastReadIndex: number;       // Preserve the legacy offset=0 cursor across active -> completed
  outputRevision: number;      // Preserve partial-line activity detection after process completion
  lastReadRevision: number;    // Legacy reader revision paired with lastReadIndex
  lastReadLineSnapshot?: string; // Preserve a consumed partial tail across active -> completed
  exitCode: number | null;
  startTime: Date;
  endTime: Date;
  lastOutputTime: Date;
  backend: 'pipe' | 'pty';
  outputDecoding?: import('./types.js').OutputDecodingInfo;
  evictedLines: number;        // Carried over from the active session (see TerminalSession)
  evictedChars: number;
  bufferedChars: number;       // Retained joined output size for global completed-session budgeting
  cancellationCause?: CancellationCause;
  terminalError?: string;
}

interface PtyFlowControlState {
  process: IsolatedPty;
  producedChars: number;
  acknowledgedChars: number;
  paused: boolean;
}

/**
 * Output buffering caps. Without a cap, a process emitting enough output makes
 * string concatenation throw "RangeError: Invalid string length" at V8's max
 * string size (~536M chars) inside a stdout 'data' handler — an uncaught
 * exception that kills the whole server (index.ts exits on uncaughtException).
 * The cap also bounds the join() cost in snapshot reads and the periodic
 * process-state scan, both of which are O(total output).
 */
export const MAX_BUFFERED_OUTPUT_CHARS = 50 * 1024 * 1024;  // per session; oldest lines evicted first
const MAX_LINE_CHARS = 1024 * 1024;                  // force-split longer lines so eviction can work
const MAX_WAIT_OUTPUT_CHARS = 2 * 1024 * 1024;       // start_process wait buffer (prompt/state detection)
const MAX_COMPLETED_SESSIONS = 100;
const MAX_COMPLETED_OUTPUT_CHARS = 100 * 1024 * 1024; // all completed sessions combined
const MAX_TIMING_OUTPUT_EVENTS = 1000;               // verbose timing diagnostics only
const MAX_TERMINAL_READERS_PER_PID = 64;              // independent offset=0 cursors per process
// Match VS Code's terminal flow-control thresholds for PTY consumer lag.
const PTY_FLOW_HIGH_WATERMARK_CHARS = 100_000;
const PTY_FLOW_LOW_WATERMARK_CHARS = 5_000;
const PTY_DATA_FLUSH_MS = 250;                         // match VS Code/node-pty trailing-data quiet window
const PTY_WINDOWS_LIFECYCLE_INTERVAL_MS = 250;         // avoid rapid ConPTY kill/spawn hangs
const PTY_WINDOWS_LIFECYCLE_QUEUE_TIMEOUT_MS = 10_000; // a wedged PTY owner must not pin later chats forever
const PIPE_EXIT_DRAIN_GRACE_MS = 250;                   // let ordinary stdio close naturally after root exit
const PIPE_EXIT_FORCE_CLOSE_MS = 100;                   // bounded fallback once the execution tree is proven dead
let lastWindowsPtyLifecycleAt = 0;
let windowsPtyLifecycleTail: Promise<void> = Promise.resolve();

async function runPtyLifecycleOperation<T>(operation: () => T): Promise<T> {
  if (process.platform !== 'win32') return operation();
  const previous = windowsPtyLifecycleTail.catch(() => undefined);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  windowsPtyLifecycleTail = previous.then(() => gate);
  let queueTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<void>((_resolve, reject) => {
        queueTimer = setTimeout(() => {
          reject(makeCancellationError(
            'deadline_exceeded',
            'Timed out waiting for the Windows PTY lifecycle owner.',
            'ETIMEDOUT',
          ));
        }, PTY_WINDOWS_LIFECYCLE_QUEUE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // Pre-release this caller's gate so it cannot extend the queue after the
    // previous owner eventually finishes.
    release();
    throw error;
  } finally {
    if (queueTimer) clearTimeout(queueTimer);
  }
  try {
    const waitMs = Math.max(0, PTY_WINDOWS_LIFECYCLE_INTERVAL_MS - (Date.now() - lastWindowsPtyLifecycleAt));
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    return operation();
  } finally {
    lastWindowsPtyLifecycleAt = Date.now();
    release();
  }
}

function continuedLineDelta(
  lines: string[],
  lastReadIndex: number,
  lastReadLineSnapshot: string | undefined,
  hadNewActivity: boolean,
): string | undefined {
  if (!hadNewActivity || lastReadLineSnapshot === undefined || lastReadIndex <= 0) return undefined;
  const lineIndex = lastReadIndex - 1;
  if (lineIndex >= lines.length) return undefined;
  const current = lines[lineIndex];
  if (current === lastReadLineSnapshot) return undefined;
  // appendToLineBuffer only grows the current tail line. If an unexpected
  // rewrite ever occurs, return the full current line rather than lose output.
  return current.startsWith(lastReadLineSnapshot)
    ? current.slice(lastReadLineSnapshot.length)
    : current;
}

function tailSnapshotAtCursor(lines: string[], cursorIndex: number): string | undefined {
  return cursorIndex > 0 && cursorIndex === lines.length ? lines[cursorIndex - 1] : undefined;
}

// Result type for paginated output reading
export interface PaginatedOutputResult {
  lines: string[];
  totalLines: number;
  readFrom: number;            // Starting line of this read
  readCount: number;           // Number of lines returned
  remaining: number;           // Lines remaining after this read
  isComplete: boolean;         // Whether process has finished
  exitCode?: number | null;    // Exit code if completed
  runtimeMs?: number;          // Runtime in milliseconds (for completed processes)
  evictedLines?: number;       // Lines dropped by the buffer cap; when > 0, line numbers are relative to the retained buffer
  lastOutputTimeMs?: number;   // Last stdout/stderr activity, or process start before first output
  noOutputForMs?: number;      // Current/completion-time silence interval
  outputChangedWithoutNewLine?: boolean; // Activity changed the current partial line without adding a line
  latestPartialLine?: string;  // Latest partial line when the line cursor alone cannot represent new output
  backend?: 'pipe' | 'pty';    // Actual terminal backend for this process
  outputDecoding?: import('./types.js').OutputDecodingInfo;
  continuedLine?: string;      // Newly appended suffix of a previously consumed partial line
  rootExited?: boolean;        // Root PID exited, but descendants/stdout may still be active
  rootExitCode?: number | null;
  treeState?: TerminalSession['treeState'];
  descendantPids?: number[];
  treeProbeWarning?: string;
  terminalError?: string;
  flowControlPaused?: boolean;
  unacknowledgedChars?: number;
}

/**
 * Configuration for spawning a shell with appropriate flags
 */
interface ShellSpawnConfig {
  executable: string;
  args: string[];
  useShellOption: string | boolean;
  // When true, pass args verbatim on Windows (see executeCommand). Only cmd.exe
  // needs this; its quote parsing conflicts with libuv's default \" escaping.
  windowsVerbatim?: boolean;
}

export interface DirectProcessSpec {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ProcessExecutionOptions {
  cwd?: string;
  env?: Record<string, string>;
  detectPrompts?: boolean;
  executionKind?: 'auto' | 'finite' | 'interactive' | 'service';
  onSpawned?: (pid: number) => void;
}

function buildProcessEnv(overlay?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, overlay ?? {});
  env.TERM ??= 'xterm-256color';
  if (process.platform === 'win32') env.PATHEXT = getRepairedPathExt();
  return env;
}

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x07/g, '');
}

/**
 * Get the appropriate spawn configuration for a given shell
 * This handles login shell flags for different shell types
 */
function getShellSpawnArgs(shellPath: string, command: string): ShellSpawnConfig {
  const shellName = path.basename(shellPath).toLowerCase();
  
  // Unix shells with login flag support
  if (shellName.includes('bash') || shellName.includes('zsh')) {
    return { 
      executable: shellPath, 
      args: ['-l', '-c', command],
      useShellOption: false 
    };
  }
  
  // PowerShell Core (cross-platform, supports -Login)
  if (shellName === 'pwsh' || shellName === 'pwsh.exe') {
    return { 
      executable: shellPath, 
      args: ['-Login', '-Command', command],
      useShellOption: false 
    };
  }
  
  // Windows PowerShell 5.1 (no login flag support)
  if (shellName === 'powershell' || shellName === 'powershell.exe') {
    return { 
      executable: shellPath, 
      args: ['-Command', command],
      useShellOption: false 
    };
  }
  
  // CMD
  if (shellName === 'cmd' || shellName === 'cmd.exe') {
    // cmd.exe has special /c quote stripping when the command contains more
    // than one quoted segment (for example a quoted executable plus quoted
    // path arguments). /s deliberately strips exactly the outer wrapper we
    // add here, leaving the user's inner quoting intact. /d prevents AutoRun
    // registry hooks from mutating deterministic tool execution.
    return {
      executable: shellPath,
      args: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatim: true,
      useShellOption: false
    };
  }
  
  // Fish shell (uses -l for login, -c for command)
  if (shellName.includes('fish')) {
    return { 
      executable: shellPath, 
      args: ['-l', '-c', command],
      useShellOption: false 
    };
  }
  
  // Unknown/other shells - use shell option for safety
  // This provides a fallback for shells we don't explicitly handle
  return { 
    executable: command,
    args: [],
    useShellOption: shellPath 
  };
}

export class TerminalManager {
  private sessions: Map<number, TerminalSession> = new Map();
  private completedSessions: Map<number, CompletedSession> = new Map();
  private readerCursors: Map<number, Map<string, ReaderCursor>> = new Map();
  private exitReconcilers: Map<number, () => Promise<void>> = new Map();
  private ptyFlowControls: Map<number, PtyFlowControlState> = new Map();
  private completedOutputChars = 0;

  private recordPtyFlowData(pid: number, charCount: number): void {
    const state = this.ptyFlowControls.get(pid);
    if (!state || charCount <= 0) return;
    state.producedChars += charCount;
    const unacknowledged = Math.max(0, state.producedChars - state.acknowledgedChars);
    if (!state.paused && unacknowledged > PTY_FLOW_HIGH_WATERMARK_CHARS) {
      state.paused = true;
      state.process.pause();
    }
  }

  private acknowledgePtyFlow(pid: number, result: PaginatedOutputResult, continuedLine?: string): void {
    const state = this.ptyFlowControls.get(pid);
    if (!state) return;
    let consumedChars = continuedLine?.length ?? 0;
    if (result.lines.length > 0) {
      consumedChars += result.lines.reduce((sum, line) => sum + line.length, 0);
      consumedChars += Math.max(0, result.lines.length - 1);
      if (result.readFrom + result.readCount < result.totalLines) consumedChars += 1;
    }
    if (consumedChars > 0) {
      state.acknowledgedChars = Math.min(state.producedChars, state.acknowledgedChars + consumedChars);
    }
    const unacknowledged = Math.max(0, state.producedChars - state.acknowledgedChars);
    if (state.paused && unacknowledged < PTY_FLOW_LOW_WATERMARK_CHARS) {
      state.paused = false;
      state.process.resume();
    }
  }

  private storeCompletedSession(completed: CompletedSession): void {
    this.ptyFlowControls.delete(completed.pid);
    const existing = this.completedSessions.get(completed.pid);
    if (existing) {
      this.completedOutputChars = Math.max(0, this.completedOutputChars - existing.bufferedChars);
      this.completedSessions.delete(completed.pid);
    }

    this.completedSessions.set(completed.pid, completed);
    this.completedOutputChars += completed.bufferedChars;

    while (
      this.completedSessions.size > MAX_COMPLETED_SESSIONS ||
      this.completedOutputChars > MAX_COMPLETED_OUTPUT_CHARS
    ) {
      const oldestKey = this.completedSessions.keys().next().value as number | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.completedSessions.get(oldestKey);
      this.completedSessions.delete(oldestKey);
      this.readerCursors.delete(oldestKey);
      if (oldest) {
        this.completedOutputChars = Math.max(0, this.completedOutputChars - oldest.bufferedChars);
      }
    }
  }

  private getReaderCursor(pid: number, readerId: string): ReaderCursor {
    let cursors = this.readerCursors.get(pid);
    if (!cursors) {
      cursors = new Map();
      this.readerCursors.set(pid, cursors);
    }
    let cursor = cursors.get(readerId);
    if (!cursor) {
      if (cursors.size >= MAX_TERMINAL_READERS_PER_PID) {
        let oldestId: string | undefined;
        let oldestAccess = Number.POSITIVE_INFINITY;
        for (const [id, candidate] of cursors) {
          if (candidate.lastAccessTime < oldestAccess) { oldestAccess = candidate.lastAccessTime; oldestId = id; }
        }
        if (oldestId !== undefined) cursors.delete(oldestId);
      }
      cursor = { lastReadIndex: 0, lastReadRevision: 0, lastReadLineSnapshot: undefined, lastAccessTime: Date.now() };
      cursors.set(readerId, cursor);
    }
    cursor.lastAccessTime = Date.now();
    return cursor;
  }

  getLastReadRevision(pid: number, readerId?: string): number {
    const session = this.sessions.get(pid);
    if (!session) return 0;
    return readerId ? this.getReaderCursor(pid, readerId).lastReadRevision : session.lastReadRevision;
  }

  /**
   * Send input to a running process
   * @param pid Process ID
   * @param input Text to send to the process
   * @returns Whether input was successfully sent
   */
  sendInputToProcess(pid: number, input: string): boolean {
    const session = this.sessions.get(pid);
    if (!session) {
      return false;
    }
    
    try {
      if (session.process.stdin && !session.process.stdin.destroyed) {
        // Ensure input ends with a newline for most REPLs
        const inputWithNewline = input.endsWith('\n') ? input : input + '\n';
        session.process.stdin.write(inputWithNewline);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error sending input to process ${pid}:`, error);
      return false;
    }
  }
  
  async executeCommand(
    command: string | DirectProcessSpec,
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT,
    shell?: string,
    collectTiming: boolean = false,
    executionOptions: ProcessExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    let shellToUse: string | boolean | undefined = shell;
    let spawnConfig: ShellSpawnConfig;
    let spawnOptions: any;

    if (typeof command !== 'string') {
      spawnConfig = { executable: command.executable, args: command.args ?? [], useShellOption: false };
      spawnOptions = {
        cwd: command.cwd,
        env: buildProcessEnv(command.env),
        shell: false,
        windowsHide: true,
      };
    } else {
      if (!shellToUse) {
        try {
          const config = await configManager.getConfig();
          shellToUse = config.defaultShell || true;
        } catch {
          shellToUse = true;
        }
      }

      let enhancedCommand = command;
      if (command.trim().startsWith('ssh ') && !command.includes(' -t')) {
        enhancedCommand = command.replace(/^ssh /, 'ssh -t ');
      }

      if (typeof shellToUse === 'string') {
        spawnConfig = getShellSpawnArgs(shellToUse, enhancedCommand);
        spawnOptions = {
          cwd: executionOptions.cwd,
          env: buildProcessEnv(executionOptions.env),
          windowsHide: true,
        };
        if (spawnConfig.useShellOption) spawnOptions.shell = spawnConfig.useShellOption;
      } else {
        spawnConfig = { executable: enhancedCommand, args: [], useShellOption: shellToUse };
        spawnOptions = {
          cwd: executionOptions.cwd,
          shell: shellToUse,
          env: buildProcessEnv(executionOptions.env),
          windowsHide: true,
        };
      }
    }

    // On Windows, when we invoke cmd.exe directly and pass the user's command as a
    // single argument, Node/libuv applies MSVCRT-style quoting that escapes embedded
    // double quotes as \" . cmd.exe does not understand that escaping, so any command
    // containing quotes (e.g. a quoted path with spaces like "C:\Program Files\app.exe")
    // is corrupted before the shell ever parses it. Passing arguments verbatim lets
    // cmd handle its own quoting. Scoped to shells that set windowsVerbatim (cmd only)
    // because PowerShell/pwsh have different quote rules and must NOT use verbatim.
    if (process.platform === 'win32' && spawnConfig.windowsVerbatim) {
      spawnOptions.windowsVerbatimArguments = true;
    }
    // Own a process group on POSIX so cancellation/force termination can kill
    // descendants without relying on shell cooperation. stdio remains piped.
    if (process.platform !== 'win32') spawnOptions.detached = true;

    // Decode pipe output without assuming UTF-8 for legacy Windows console/native producers.
    // The profile probe is process-cached, so only the first Windows pipe process pays for it.
    const [stdoutDecoder, stderrDecoder] = await Promise.all([
      createProcessOutputDecoder(), createProcessOutputDecoder(),
    ]);
    const currentOutputDecoding = () => mergeOutputDecodingInfo(
      stdoutDecoder.diagnostics(), stderrDecoder.diagnostics(),
    );

    // On Windows prefer an operation-scoped Job Object. The helper creates the
    // target suspended, assigns it before resume, and stays alive until the Job
    // is empty. This removes the post-spawn descendant escape race and makes the
    // helper's close event authoritative for tree completion.
    const jobOwned = process.platform === 'win32' && !spawnOptions.shell
      ? await spawnWindowsJobOwnedProcess(
          spawnConfig.executable, spawnConfig.args, spawnOptions, spawnConfig.windowsVerbatim, timeoutMs,
        )
      : null;
    const childProcess = jobOwned?.process ?? spawn(spawnConfig.executable, spawnConfig.args, spawnOptions);
    const processStdout = jobOwned?.stdout ?? childProcess.stdout;
    const processStderr = jobOwned?.stderr ?? childProcess.stderr;
    const sessionPid = jobOwned?.pid ?? childProcess.pid;
    const processTreeOwner: TerminalSession['processTreeOwner'] = jobOwned
      ? 'windows_job'
      : process.platform === 'win32' ? 'pid_tree' : 'posix_group';
    let output = '';
    const spawnFailure: { message?: string } = {};
    const earlyErrorHandler = (error: Error) => { spawnFailure.message = error.message; };
    childProcess.on('error', earlyErrorHandler);

    if (!sessionPid || !processStdout || !processStderr) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        pid: -1,
        output: `Error: Failed to start process${spawnFailure.message ? `: ${spawnFailure.message}` : '. The command could not be executed.'}`,
        isBlocked: false
      };
    }

    const session: TerminalSession = {
      pid: sessionPid,
      process: childProcess,
      backend: 'pipe',
      processTreeOwner,
      executionKind: executionOptions.executionKind ?? 'auto',
      outputDecoding: currentOutputDecoding(),
      outputLines: [],           // Line-based buffer
      lastReadIndex: 0,          // Track where "new" output starts
      outputRevision: 0,         // Incremented for every stdout/stderr chunk
      lastReadRevision: 0,       // Last revision observed by an offset=0 read
      isBlocked: false,
      startTime: new Date(),
      lastOutputTime: new Date(),
      bufferedChars: 0,
      evictedLines: 0,
      evictedChars: 0,
      treeState: 'root_running',
      descendantPids: [],
      treeProbeWarning: processTreeOwner === 'pid_tree' ? getWindowsJobHelperFailure() : undefined,
    };

    this.sessions.set(session.pid, session);
    executionOptions.onSpawned?.(session.pid);

    // Timing telemetry
    const startTime = Date.now();
    let firstOutputTime: number | undefined;
    let lastOutputTime: number | undefined;
    const outputEvents: OutputEvent[] = [];
    let exitReason: TimingInfo['exitReason'] = 'timeout';
    const executionKind = executionOptions.executionKind ?? 'auto';
    const detectPrompts = executionOptions.detectPrompts ?? (executionKind === 'auto' || executionKind === 'interactive');

    return new Promise((resolve) => {
      let resolved = false;
      let periodicCheck: NodeJS.Timeout | null = null;
      let timeoutHandle: NodeJS.Timeout | null = null;
      let exitDrainHandle: NodeJS.Timeout | null = null;
      let forceFinalizeHandle: NodeJS.Timeout | null = null;
      let finalizedSession = false;
      let treeProbeInFlight = false;
      let lastTreeProbeAt = 0;

      // Quick prompt patterns for immediate detection
      const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;

      const resolveOnce = (result: CommandExecutionResult) => {
        if (resolved) return;
        resolved = true;
        if (periodicCheck) clearInterval(periodicCheck);
        if (timeoutHandle) clearTimeout(timeoutHandle);

        // Add timing info if requested
        if (collectTiming) {
          const endTime = Date.now();
          result.timingInfo = {
            startTime,
            endTime,
            totalDurationMs: endTime - startTime,
            exitReason,
            firstOutputTime,
            lastOutputTime,
            timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
            outputEvents: outputEvents.length > 0 ? outputEvents : undefined
          };
        }

        resolve(result);
      };

      processStdout.on('data', (data: Buffer) => {
        const text = stdoutDecoder.write(data);
        session.outputDecoding = currentOutputDecoding();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;
        session.lastOutputTime = new Date(now);
        if (text.length > 0) session.outputRevision += 1;

        // `output` only feeds the wait-phase result and prompt/state detection,
        // so stop growing it once resolved and keep only a bounded tail.
        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        // Append to line-based buffer
        this.appendToLineBuffer(session, text);

        // Timing telemetry is diagnostic only; cap event cardinality so a
        // chatty process cannot grow an unbounded side buffer.
        const timingEventRecorded = collectTiming && outputEvents.length < MAX_TIMING_OUTPUT_EVENTS;
        if (timingEventRecorded) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stdout',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }

        // Immediate check for obvious prompts
        if (detectPrompts && quickPromptPatterns.test(text)) {
          session.isBlocked = true;
          exitReason = 'early_exit_quick_pattern';

          if (timingEventRecorded && outputEvents.length > 0) {
            outputEvents[outputEvents.length - 1].matchedPattern = 'quick_pattern';
          }

          resolveOnce({
            pid: session.pid,
            output,
            isBlocked: true
          });
        }
      });

      processStderr.on('data', (data: Buffer) => {
        const text = stderrDecoder.write(data);
        session.outputDecoding = currentOutputDecoding();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;
        session.lastOutputTime = new Date(now);
        if (text.length > 0) session.outputRevision += 1;

        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        // Append to line-based buffer
        this.appendToLineBuffer(session, text);

        // Same bounded timing budget for stderr chunks.
        if (collectTiming && outputEvents.length < MAX_TIMING_OUTPUT_EVENTS) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stderr',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }
      });

      // Periodic prompt detection is only useful for auto/interactive work.
      if (detectPrompts) {
        periodicCheck = setInterval(() => {
          if (output.trim()) {
            const processState = analyzeProcessState(output, session.pid);
            if (processState.isWaitingForInput) {
              session.isBlocked = true;
              exitReason = 'early_exit_periodic_check';
              resolveOnce({
                pid: session.pid,
                output,
                isBlocked: true
              });
            }
          }
        }, 100);
      }

      // Timeout fallback. Keep the handle so early completion/prompt detection
      // does not leave thousands of dormant timers alive until their deadline.
      timeoutHandle = setTimeout(() => {
        session.isBlocked = true;
        exitReason = 'timeout';
        resolveOnce({
          pid: session.pid,
          output,
          isBlocked: true
        });
      }, timeoutMs);

      const flushDecoderTail = (text: string, source: 'stdout' | 'stderr') => {
        if (!text) return;
        const now = Date.now();
        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;
        session.lastOutputTime = new Date(now);
        session.outputRevision += 1;
        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        this.appendToLineBuffer(session, text);
        if (collectTiming && outputEvents.length < MAX_TIMING_OUTPUT_EVENTS) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source,
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n'),
          });
        }
      };

      const processErrorHandler = (error: Error) => {
        const terminalError = `Process backend error: ${error.message}`;
        session.terminalError = terminalError;
        session.lastOutputTime = new Date();
        session.outputRevision += 1;
        this.appendToLineBuffer(session, `\n[TERMINAL_ERROR: ${terminalError}]\n`);
        exitReason = 'process_error';
        resolveOnce({
          pid: session.pid,
          output: `${output}${output ? '\n' : ''}Error: ${terminalError}`,
          isBlocked: true,
          terminalError,
        });
      };
      childProcess.on('error', processErrorHandler);
      childProcess.off('error', earlyErrorHandler);

      const finalizeCompletedSession = (code: number | null) => {
        if (finalizedSession) return;
        finalizedSession = true;
        if (exitDrainHandle) clearTimeout(exitDrainHandle);
        if (forceFinalizeHandle) clearTimeout(forceFinalizeHandle);
        flushDecoderTail(stdoutDecoder.end(), 'stdout');
        flushDecoderTail(stderrDecoder.end(), 'stderr');
        session.outputDecoding = currentOutputDecoding();
        {
          this.storeCompletedSession({
            pid: session.pid,
            outputLines: [...session.outputLines],
            lastReadIndex: session.lastReadIndex,
            outputRevision: session.outputRevision,
            lastReadRevision: session.lastReadRevision,
            lastReadLineSnapshot: session.lastReadLineSnapshot,
            exitCode: code,
            startTime: session.startTime,
            endTime: new Date(),
            lastOutputTime: session.lastOutputTime,
            backend: session.backend,
            outputDecoding: session.outputDecoding,
            evictedLines: session.evictedLines,
            evictedChars: session.evictedChars,
            bufferedChars: session.bufferedChars,
            cancellationCause: session.cancellationCause,
            terminalError: session.terminalError,
          });
          this.sessions.delete(session.pid);
          this.exitReconcilers.delete(session.pid);
        }
        exitReason = 'process_exit';
        resolveOnce({ pid: session.pid, output, isBlocked: false });
      };

      const reconcileRootExit = async () => {
        if (session.processTreeOwner === 'windows_job') return;
        if (finalizedSession || treeProbeInFlight || !session.rootExitedAt) return;
        const now = Date.now();
        if (now - lastTreeProbeAt < 1_000) return;
        lastTreeProbeAt = now;
        treeProbeInFlight = true;
        try {
          const probe = await probeProcessTree(
            session.pid, session.startTime.getTime(), session.rootExitedAt.getTime(), process.platform !== 'win32',
          );
          if (finalizedSession) return;
          session.descendantPids = probe.descendantPids;
          session.treeProbeWarning = probe.warning;
          if (!probe.certain) {
            session.treeState = 'probe_uncertain';
            session.isBlocked = true;
            exitReason = 'root_exit_probe_uncertain';
            resolveOnce({ pid: session.pid, output, isBlocked: true });
            return;
          }
          if (probe.treeAlive) {
            session.treeState = 'descendants_running';
            session.isBlocked = true;
            exitReason = 'root_exit_tree_running';
            resolveOnce({ pid: session.pid, output, isBlocked: true });
            return;
          }

          // Root exit is final only after the OS proves that no descendants
          // remain. Give stdio one natural drain window, then close our read
          // endpoints and finish even if Node never emits close.
          session.treeState = 'root_exited_draining';
          processStdout.destroy();
          processStderr.destroy();
          forceFinalizeHandle = setTimeout(
            () => finalizeCompletedSession(session.rootExitCode ?? childProcess.exitCode ?? null),
            PIPE_EXIT_FORCE_CLOSE_MS,
          );
          forceFinalizeHandle.unref?.();
        } finally {
          treeProbeInFlight = false;
        }
      };

      this.exitReconcilers.set(session.pid, reconcileRootExit);

      const onRootExit = (code: number | null) => {
        if (session.rootExitedAt) return;
        session.rootExitedAt = new Date();
        session.rootExitCode = code;
        session.treeState = 'root_exited_draining';
        if (session.processTreeOwner === 'windows_job') return;
        exitDrainHandle = setTimeout(() => { void reconcileRootExit(); }, PIPE_EXIT_DRAIN_GRACE_MS);
        exitDrainHandle.unref?.();
      };
      childProcess.on('exit', onRootExit);
      if (childProcess.exitCode !== null || childProcess.signalCode !== null) onRootExit(childProcess.exitCode);

      childProcess.on('close', (code: number | null) => {
        finalizeCompletedSession(code ?? session.rootExitCode ?? null);
      });
    });
  }

  async executePty(
    command: string | DirectProcessSpec,
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT,
    shell?: string,
    collectTiming: boolean = false,
    executionOptions: ProcessExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    let executable: string;
    let args: string[];
    let cwd: string | undefined;
    let env: Record<string, string>;
    if (typeof command === 'string') {
      let shellToUse = shell;
      if (!shellToUse) {
        const config = await configManager.getConfig();
        shellToUse = config.defaultShell || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
      }
      const prepared = getShellSpawnArgs(shellToUse, command);
      if (prepared.useShellOption) {
        throw new Error(`PTY_UNSUPPORTED_SHELL: ${shellToUse}`);
      }
      executable = prepared.executable;
      args = prepared.args;
      cwd = executionOptions.cwd;
      env = buildProcessEnv(executionOptions.env);
    } else {
      executable = command.executable;
      args = command.args ?? [];
      cwd = command.cwd;
      env = buildProcessEnv(command.env);
    }

    let ptyProcess;
    try {
      ptyProcess = await runPtyLifecycleOperation(() => spawnIsolatedPty(executable, args, {
        cwd,
        env,
        cols: 120,
        rows: 30,
        startupTimeoutMs: Math.min(timeoutMs, 5000),
      }));
    } catch (error) {
      throw new Error(`PTY_START_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }

    let output = '';
    const stdinAdapter = {
      destroyed: false,
      write: (data: string) => ptyProcess.write(data.replace(/\r?\n/g, '\r')),
    };
    const session: TerminalSession = {
      pid: ptyProcess.pid,
      process: {
        stdin: stdinAdapter,
        kill: () => {
          stdinAdapter.destroyed = true;
          void runPtyLifecycleOperation(() => ptyProcess.kill()).catch((error) => {
            capture('server_request_error', {
              error: error instanceof Error ? error.message : String(error),
              message: 'Failed to terminate PTY process',
            });
          });
          return true;
        },
      },
      backend: 'pty',
      processTreeOwner: ptyProcess.processTreeOwner,
      executionKind: executionOptions.executionKind ?? 'auto',
      outputDecoding: { mode: 'utf8', usedEncodings: ['utf8'] },
      outputLines: [],
      lastReadIndex: 0,
      outputRevision: 0,
      lastReadRevision: 0,
      isBlocked: false,
      startTime: new Date(),
      lastOutputTime: new Date(),
      bufferedChars: 0,
      evictedLines: 0,
      evictedChars: 0,
    };
    this.sessions.set(session.pid, session);
    if (session.executionKind !== 'finite') {
      this.ptyFlowControls.set(session.pid, {
        process: ptyProcess, producedChars: 0, acknowledgedChars: 0, paused: false,
      });
    }
    executionOptions.onSpawned?.(session.pid);

    const startTime = Date.now();
    let firstOutputTime: number | undefined;
    let lastOutputTime: number | undefined;
    const outputEvents: OutputEvent[] = [];
    let exitReason: TimingInfo['exitReason'] = 'timeout';
    const executionKind = executionOptions.executionKind ?? 'auto';
    const detectPrompts = executionOptions.detectPrompts ?? (executionKind === 'auto' || executionKind === 'interactive');

    return new Promise((resolve) => {
      let resolved = false;
      let periodicCheck: NodeJS.Timeout | null = null;
      let timeoutHandle: NodeJS.Timeout | null = null;
      let exitFlushHandle: NodeJS.Timeout | null = null;
      let pendingExitCode: number | null = null;
      let pendingTerminalError: string | undefined;
      const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;

      const resolveOnce = (result: CommandExecutionResult) => {
        if (resolved) return;
        resolved = true;
        if (periodicCheck) clearInterval(periodicCheck);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (collectTiming) {
          const endTime = Date.now();
          result.timingInfo = {
            startTime,
            endTime,
            totalDurationMs: endTime - startTime,
            exitReason,
            firstOutputTime,
            lastOutputTime,
            timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
            outputEvents: outputEvents.length > 0 ? outputEvents : undefined,
          };
        }
        result.pid = ptyProcess.pid;
        result.backend = 'pty';
        resolve(result);
      };

      const finalizePtyExit = () => {
        if (pendingExitCode === null) return;
        const exitCode = pendingExitCode;
        pendingExitCode = null;
        exitFlushHandle = null;
        const finalPid = ptyProcess.pid;
        // Tell the isolated host to release native ConPTY resources only after
        // the trailing-data quiet window has elapsed. Any native hang/crash is
        // contained in that helper process, not the main MCP server.
        session.process.kill();
        this.storeCompletedSession({
          pid: finalPid,
          outputLines: [...session.outputLines],
          lastReadIndex: session.lastReadIndex,
          outputRevision: session.outputRevision,
          lastReadRevision: session.lastReadRevision,
          lastReadLineSnapshot: session.lastReadLineSnapshot,
          exitCode,
          startTime: session.startTime,
          endTime: new Date(),
          lastOutputTime: session.lastOutputTime,
          backend: 'pty',
          outputDecoding: session.outputDecoding,
          evictedLines: session.evictedLines,
          evictedChars: session.evictedChars,
          bufferedChars: session.bufferedChars,
          cancellationCause: session.cancellationCause,
          terminalError: session.terminalError,
        });
        if (this.sessions.get(finalPid) === session) this.sessions.delete(finalPid);
        exitReason = 'process_exit';
        resolveOnce({
          pid: finalPid, output, isBlocked: false, backend: 'pty',
          terminalError: session.terminalError,
        });
      };

      const queuePtyExit = (exitCode: number, terminalError?: string) => {
        pendingExitCode = exitCode;
        if (terminalError) {
          pendingTerminalError = terminalError;
          session.terminalError = terminalError;
        }
        if (exitFlushHandle) clearTimeout(exitFlushHandle);
        exitFlushHandle = setTimeout(finalizePtyExit, PTY_DATA_FLUSH_MS);
      };

      ptyProcess.onData((raw: string) => {
        const text = stripTerminalControlSequences(raw).replace(/\r\n/g, '\n').replace(/\r/g, '');
        if (!text) return;
        const now = Date.now();
        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;
        session.lastOutputTime = new Date(now);
        session.outputRevision += 1;
        this.recordPtyFlowData(session.pid, text.length);
        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        this.appendToLineBuffer(session, text);
        if (collectTiming && outputEvents.length < MAX_TIMING_OUTPUT_EVENTS) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'pty',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n'),
          });
        }
        if (pendingExitCode !== null) queuePtyExit(pendingExitCode, pendingTerminalError);
        if (pendingExitCode === null && detectPrompts && quickPromptPatterns.test(text)) {
          session.isBlocked = true;
          exitReason = 'early_exit_quick_pattern';
          resolveOnce({ pid: ptyProcess.pid, output, isBlocked: true, backend: 'pty' });
        }
      });

      if (detectPrompts) {
        periodicCheck = setInterval(() => {
          if (!output.trim()) return;
          const state = analyzeProcessState(output, ptyProcess.pid);
          if (state.isWaitingForInput) {
            session.isBlocked = true;
            exitReason = 'early_exit_periodic_check';
            resolveOnce({ pid: ptyProcess.pid, output, isBlocked: true, backend: 'pty' });
          }
        }, 100);
      }

      timeoutHandle = setTimeout(() => {
        session.isBlocked = true;
        exitReason = 'timeout';
        resolveOnce({ pid: ptyProcess.pid, output, isBlocked: true, backend: 'pty' });
      }, timeoutMs);

      ptyProcess.onExit(({ exitCode, terminalError }) => {
        stdinAdapter.destroyed = true;
        queuePtyExit(exitCode, terminalError);
      });
    });
  }

  /**
   * Append text to a session's line buffer
   * Handles partial lines and newline splitting
   */
  private appendToLineBuffer(session: TerminalSession, text: string): void {
    if (!text) return;

    // Split text into lines, keeping track of whether text ends with newline
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastFragment = i === lines.length - 1;
      const endsWithNewline = text.endsWith('\n');

      if (session.outputLines.length === 0) {
        // First line ever
        session.outputLines.push(line);
      } else if (i === 0) {
        // First fragment - append to last line (might be partial)
        session.outputLines[session.outputLines.length - 1] += line;
      } else {
        // Subsequent lines - add as new lines
        session.outputLines.push(line);
      }
    }
    // Appended text contributes exactly its length to the joined buffer
    // (its newlines become the join separators).
    session.bufferedChars += text.length;

    // A process printing without newlines grows a single line forever, which
    // eviction can't bound — force-split so no line exceeds MAX_LINE_CHARS.
    // Each inserted break adds one separator to the joined length.
    let lastIndex = session.outputLines.length - 1;
    while (session.outputLines[lastIndex].length > MAX_LINE_CHARS) {
      const overlong = session.outputLines[lastIndex];
      session.outputLines[lastIndex] = overlong.slice(0, MAX_LINE_CHARS);
      session.outputLines.push(overlong.slice(MAX_LINE_CHARS));
      session.bufferedChars += 1;
      lastIndex++;
    }

    // Enforce the per-session cap by evicting the oldest lines. Keeps the
    // buffer far below V8's max string length so concatenation and join()
    // can never throw "Invalid string length" and kill the server.
    while (session.bufferedChars > MAX_BUFFERED_OUTPUT_CHARS && session.outputLines.length > 1) {
      const dropped = session.outputLines.shift()!;
      const droppedJoinedChars = dropped.length + 1; // +1 for its join separator
      session.bufferedChars -= droppedJoinedChars;
      session.evictedChars += droppedJoinedChars;
      session.evictedLines++;
      if (session.lastReadIndex > 0) session.lastReadIndex--;
      const cursors = this.readerCursors.get(session.pid);
      if (cursors) {
        for (const cursor of cursors.values()) {
          if (cursor.lastReadIndex > 0) cursor.lastReadIndex--;
        }
      }
    }
  }

  /**
   * Read process output with pagination (like file reading)
   * @param pid Process ID
   * @param offset Line offset: 0=from lastReadIndex, positive=absolute, negative=tail
   * @param length Max lines to return
   * @param updateReadIndex Whether to update lastReadIndex (default: true for offset=0)
   */
  readOutputPaginated(pid: number, offset: number = 0, length: number = 1000, readerId?: string): PaginatedOutputResult | null {
    // First check active sessions
    const session = this.sessions.get(pid);
    if (session) {
      const readerCursor = offset === 0 && readerId ? this.getReaderCursor(pid, readerId) : undefined;
      const lastReadRevision = readerCursor?.lastReadRevision ?? session.lastReadRevision;
      const lastReadIndex = readerCursor?.lastReadIndex ?? session.lastReadIndex;
      const lastReadLineSnapshot = readerCursor?.lastReadLineSnapshot ?? session.lastReadLineSnapshot;
      const hadNewActivity = offset === 0 && session.outputRevision > lastReadRevision;
      const continuedLine = offset === 0
        ? continuedLineDelta(session.outputLines, lastReadIndex, lastReadLineSnapshot, hadNewActivity)
        : undefined;
      let updatedIndex = lastReadIndex;
      const result = this.readFromLineBuffer(
        session.outputLines,
        offset,
        length,
        lastReadIndex,
        (newIndex) => {
          updatedIndex = newIndex;
          if (readerCursor) readerCursor.lastReadIndex = newIndex;
          else session.lastReadIndex = newIndex;
        },
        false,
        undefined
      );
      if (offset === 0) {
        if (continuedLine !== undefined && continuedLine.length > 0) result.continuedLine = continuedLine;
        result.outputChangedWithoutNewLine = hadNewActivity && result.readCount === 0 && result.continuedLine === undefined && session.outputLines.length > 0;
        if (result.outputChangedWithoutNewLine) {
          result.latestPartialLine = session.outputLines[session.outputLines.length - 1];
        }
        const lineSnapshot = tailSnapshotAtCursor(session.outputLines, updatedIndex);
        if (readerCursor) {
          readerCursor.lastReadRevision = session.outputRevision;
          readerCursor.lastReadLineSnapshot = lineSnapshot;
          readerCursor.lastAccessTime = Date.now();
        } else {
          session.lastReadRevision = session.outputRevision;
          session.lastReadLineSnapshot = lineSnapshot;
          this.acknowledgePtyFlow(pid, result, result.continuedLine);
        }
      }
      const flowState = this.ptyFlowControls.get(pid);
      if (flowState) {
        result.flowControlPaused = flowState.paused;
        result.unacknowledgedChars = Math.max(0, flowState.producedChars - flowState.acknowledgedChars);
      }
      result.evictedLines = session.evictedLines;
      result.backend = session.backend;
      result.outputDecoding = session.outputDecoding;
      result.lastOutputTimeMs = session.lastOutputTime.getTime();
      result.noOutputForMs = Math.max(0, Date.now() - result.lastOutputTimeMs);
      result.rootExited = Boolean(session.rootExitedAt);
      result.rootExitCode = session.rootExitedAt ? session.rootExitCode ?? null : undefined;
      result.treeState = session.treeState ?? 'root_running';
      result.descendantPids = session.descendantPids ? [...session.descendantPids] : [];
      result.treeProbeWarning = session.treeProbeWarning;
      result.terminalError = session.terminalError;
      return result;
    }

    // Then check completed sessions
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      const runtimeMs = completedSession.endTime.getTime() - completedSession.startTime.getTime();
      const readerCursor = offset === 0 && readerId ? this.getReaderCursor(pid, readerId) : undefined;
      const lastReadRevision = readerCursor?.lastReadRevision ?? completedSession.lastReadRevision;
      const lastReadIndex = readerCursor?.lastReadIndex ?? completedSession.lastReadIndex;
      const lastReadLineSnapshot = readerCursor?.lastReadLineSnapshot ?? completedSession.lastReadLineSnapshot;
      const hadNewActivity = offset === 0 && completedSession.outputRevision > lastReadRevision;
      const continuedLine = offset === 0
        ? continuedLineDelta(completedSession.outputLines, lastReadIndex, lastReadLineSnapshot, hadNewActivity)
        : undefined;
      let updatedIndex = lastReadIndex;
      const result = this.readFromLineBuffer(
        completedSession.outputLines,
        offset,
        length,
        lastReadIndex,
        (newIndex) => {
          updatedIndex = newIndex;
          if (readerCursor) {
            readerCursor.lastReadIndex = newIndex;
            readerCursor.lastAccessTime = Date.now();
          } else {
            completedSession.lastReadIndex = newIndex;
          }
        },
        true,
        completedSession.exitCode,
        runtimeMs
      );
      if (offset === 0) {
        if (continuedLine !== undefined && continuedLine.length > 0) result.continuedLine = continuedLine;
        result.outputChangedWithoutNewLine = hadNewActivity && result.readCount === 0 && result.continuedLine === undefined && completedSession.outputLines.length > 0;
        if (result.outputChangedWithoutNewLine) {
          result.latestPartialLine = completedSession.outputLines[completedSession.outputLines.length - 1];
        }
        const lineSnapshot = tailSnapshotAtCursor(completedSession.outputLines, updatedIndex);
        if (readerCursor) {
          readerCursor.lastReadRevision = completedSession.outputRevision;
          readerCursor.lastReadLineSnapshot = lineSnapshot;
          readerCursor.lastAccessTime = Date.now();
        } else {
          completedSession.lastReadRevision = completedSession.outputRevision;
          completedSession.lastReadLineSnapshot = lineSnapshot;
        }
      }
      result.evictedLines = completedSession.evictedLines;
      result.backend = completedSession.backend;
      result.outputDecoding = completedSession.outputDecoding;
      result.lastOutputTimeMs = completedSession.lastOutputTime.getTime();
      result.noOutputForMs = Math.max(0, completedSession.endTime.getTime() - result.lastOutputTimeMs);
      result.terminalError = completedSession.terminalError;
      return result;
    }

    return null;
  }

  /**
   * Internal helper to read from a line buffer with offset/length
   */
  private readFromLineBuffer(
    lines: string[],
    offset: number,
    length: number,
    lastReadIndex: number,
    updateLastRead: (index: number) => void,
    isComplete: boolean,
    exitCode?: number | null,
    runtimeMs?: number
  ): PaginatedOutputResult {
    const totalLines = lines.length;
    let startIndex: number;
    let linesToRead: string[];

    if (offset < 0) {
      // Negative offset = start position from end, then read 'length' lines forward
      // e.g., offset=-50, length=10 means: start 50 lines from end, read 10 lines
      const fromEnd = Math.abs(offset);
      startIndex = Math.max(0, totalLines - fromEnd);
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for tail reads
    } else if (offset === 0) {
      // offset=0 means "from where I last read" (like getNewOutput)
      startIndex = lastReadIndex;
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Update lastReadIndex for "new output" behavior
      updateLastRead(Math.min(startIndex + linesToRead.length, totalLines));
    } else {
      // Positive offset = absolute position
      startIndex = offset;
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for absolute position reads
    }

    const readCount = linesToRead.length;
    const endIndex = startIndex + readCount;
    const remaining = Math.max(0, totalLines - endIndex);

    return {
      lines: linesToRead,
      totalLines,
      readFrom: startIndex,
      readCount,
      remaining,
      isComplete,
      exitCode,
      runtimeMs
    };
  }

  /**
   * Get total line count for a process
   */
  getOutputLineCount(pid: number): number | null {
    const session = this.sessions.get(pid);
    if (session) {
      return session.outputLines.length;
    }

    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return completedSession.outputLines.length;
    }

    return null;
  }

  /**
   * Legacy method for backward compatibility
   * Returns all new output since last read
   * @param maxLines Maximum lines to return (default: 1000 for context protection)
   * @deprecated Use readOutputPaginated instead
   */
  getNewOutput(pid: number, maxLines: number = 1000): string | null {
    const result = this.readOutputPaginated(pid, 0, maxLines);
    if (!result) return null;

    const outputParts = result.continuedLine !== undefined
      ? [result.continuedLine, ...result.lines]
      : result.lines;
    const output = outputParts.join('\n').trim();

    // For completed sessions, append completion info with runtime
    if (result.isComplete) {
      const runtimeStr = result.runtimeMs !== undefined 
        ? `\nRuntime: ${(result.runtimeMs / 1000).toFixed(2)}s` 
        : '';
      if (output) {
        return `${output}\n\nProcess completed with exit code ${result.exitCode}${runtimeStr}`;
      } else {
        return `Process completed with exit code ${result.exitCode}${runtimeStr}\n(No output produced)`;
      }
    }

    // Add truncation warning if there's more output
    if (result.remaining > 0) {
      return `${output}\n\n[Output truncated: ${result.remaining} more lines available. Use read_process_output with offset/length for full output.]`;
    }

    return output || null;
  }

  /**
   * Capture a snapshot of current output state for interaction tracking.
   * Used by interactWithProcess to know what output existed before sending input.
   */
  captureOutputSnapshot(pid: number): { totalChars: number; lineCount: number } | null {
    const session = this.sessions.get(pid);
    if (session) {
      const fullOutput = session.outputLines.join('\n');
      return {
        // Absolute since process start (includes evicted output), so the
        // offset stays valid even if the cap evicts lines between
        // snapshot and read.
        totalChars: session.evictedChars + fullOutput.length,
        lineCount: session.evictedLines + session.outputLines.length
      };
    }
    return null;
  }

  /**
   * Get output that appeared since a snapshot was taken.
   * This handles the case where output is appended to the last line (REPL prompts).
   * Also checks completed sessions in case process finished between snapshot and poll.
   */
  getOutputSinceSnapshot(pid: number, snapshot: { totalChars: number; lineCount: number }): string | null {
    // Check active session first
    const session = this.sessions.get(pid);
    if (session) {
      return TerminalManager.outputSinceSnapshot(session.outputLines, session.evictedChars, snapshot.totalChars);
    }

    // Fallback to completed sessions - process may have finished between snapshot and poll
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return TerminalManager.outputSinceSnapshot(completedSession.outputLines, completedSession.evictedChars, snapshot.totalChars);
    }

    return null;
  }

  /**
   * New output since a snapshot, in absolute (since process start) offsets.
   * If eviction dropped part of the unseen output, returns what the buffer
   * still holds — the oldest unseen chars are lost to the cap.
   */
  private static outputSinceSnapshot(outputLines: string[], evictedChars: number, snapshotTotalChars: number): string {
    const fullOutput = outputLines.join('\n');
    const newChars = evictedChars + fullOutput.length - snapshotTotalChars;
    if (newChars <= 0) {
      return ''; // No new output
    }
    return fullOutput.substring(Math.max(0, fullOutput.length - newChars));
  }

    /**
   * Get a session by PID
   * @param pid Process ID
   * @returns The session or undefined if not found
   */
  getSession(pid: number): TerminalSession | undefined {
    return this.sessions.get(pid);
  }

  async reconcileExitedSession(pid: number): Promise<void> {
    const reconcile = this.exitReconcilers.get(pid);
    if (reconcile) await reconcile();
  }

  async forceTerminate(
    pid: number,
    cause: CancellationCause = 'client_cancelled',
    detail?: string,
  ): Promise<boolean> {
    const session = this.sessions.get(pid);
    if (!session) return false;
    session.cancellationCause ??= cause;
    session.cancellationDetail ??= detail;

    try {
      if (session.backend === 'pty') {
        session.process.kill();
        return true;
      }
      if (session.processTreeOwner === 'windows_job') {
        await terminateWindowsJobOwnedProcess(session.process as import('child_process').ChildProcessWithoutNullStreams);
        return true;
      }
      await terminateProcessTree(
        session.process as ChildProcess,
        3_000,
        process.platform !== 'win32',
        session.startTime.getTime(),
        session.rootExitedAt?.getTime(),
      );
      return true;
    } catch (error) {
      try { session.process.kill('SIGKILL'); } catch {}
      const errorMessage = error instanceof Error ? error.message : String(error);
      capture('server_request_error', {error: errorMessage, message: `Failed to terminate process tree ${pid}:`});
      return false;
    }
  }

  listActiveSessions(): ActiveSession[] {
    const now = new Date();
    return Array.from(this.sessions.values()).map(session => ({
      pid: session.pid,
      backend: session.backend,
      processTreeOwner: session.processTreeOwner,
      executionKind: session.executionKind,
      isBlocked: session.isBlocked,
      runtime: now.getTime() - session.startTime.getTime(),
      treeState: session.treeState,
      rootExitCode: session.rootExitedAt ? session.rootExitCode ?? null : undefined,
      descendantPids: session.descendantPids ? [...session.descendantPids] : [],
      cancellationCause: session.cancellationCause,
      terminalError: session.terminalError,
    }));
  }

  listCompletedSessions(): CompletedSession[] {
    return Array.from(this.completedSessions.values());
  }
}

export const terminalManager = new TerminalManager();