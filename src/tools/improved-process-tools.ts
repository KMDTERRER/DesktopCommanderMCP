import { terminalManager, MAX_BUFFERED_OUTPUT_CHARS } from '../terminal-manager.js';
import { commandManager } from '../command-manager.js';
import { StartProcessArgsSchema, ReadProcessOutputArgsSchema, InteractWithProcessArgsSchema, ForceTerminateArgsSchema, ListSessionsArgsSchema } from './schemas.js';
import { capture } from "../utils/capture.js";
import { ServerResult } from '../types.js';
import { analyzeProcessState, cleanProcessOutput, formatProcessStateMessage, ProcessState } from '../utils/process-detection.js';
import * as os from 'os';
import { configManager } from '../config-manager.js';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { terminateProcessTree } from '../utils/process-tree.js';
import { processProblemEvidence } from '../utils/process-problem-matcher.js';
import { runWithAbortableTimeout } from '../utils/withTimeout.js';
import { OperationScope } from '../utils/operation-scope.js';
import { KeyedSerializedOperationOwners } from '../utils/serialized-operation-owner.js';
import { registerToolCallCancellationCleanup } from '../utils/client-context.js';
import {
  PROCESS_INITIAL_OUTPUT_MAX_CHARS, PROCESS_INTERACTION_DEFAULT_MS,
  PROCESS_STALL_DEFAULT_MS, PROCESS_WAIT_DEFAULT_MS,
} from '../utils/process-wait-contract.js';

// Get the directory where the MCP is installed (for ES module imports)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mcpRoot = path.resolve(__dirname, '..', '..');

// Track virtual Node sessions (PIDs that are actually Node fallback sessions)
const virtualNodeSessions = new Map<number, { timeout_ms: number }>();
let virtualPidCounter = -1000; // Use negative PIDs for virtual sessions
const MAX_NODE_LOCAL_OUTPUT_BYTES = 2 * 1024 * 1024;
const PROCESS_LOCAL_IO_TIMEOUT_MS = 5_000;

function processLocalIoTimeout(requestTimeoutMs: number): number {
  return Math.max(100, Math.min(PROCESS_LOCAL_IO_TIMEOUT_MS, requestTimeoutMs > 0 ? requestTimeoutMs : PROCESS_LOCAL_IO_TIMEOUT_MS));
}

const processInteractionOwners = new KeyedSerializedOperationOwners<number>();
const PIPE_PROMPT_SETTLE_MS = 150;

function compactInitialProcessOutput(value: string): { text: string; truncated: boolean; chars: number } {
  const chars = value.length;
  if (chars <= PROCESS_INITIAL_OUTPUT_MAX_CHARS) return { text: value, truncated: false, chars };
  const marker = `[Initial output truncated: ${chars - PROCESS_INITIAL_OUTPUT_MAX_CHARS} earlier characters omitted; use read_process_output for retained output]\n`;
  const tailChars = Math.max(0, PROCESS_INITIAL_OUTPUT_MAX_CHARS - marker.length);
  return { text: `${marker}${value.slice(-tailChars)}`, truncated: true, chars };
}

async function acquireProcessInteractionLease(pid: number, timeoutMs: number): Promise<() => void> {
  const scope = new OperationScope({ label: `Process ${pid} interaction lease`, timeoutMs });
  try {
    const releaseOwner = await processInteractionOwners.acquire(
      pid, scope, `Wait for exclusive interaction with process ${pid}`,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseOwner();
      scope.dispose();
    };
  } catch (error) {
    scope.dispose();
    throw error;
  }
}

/**
 * Execute Node.js code via temp file (fallback when Python unavailable)
 * Creates temp .mjs file in MCP directory for ES module import access
 */
async function executeNodeCode(code: string, timeout_ms: number = 30000): Promise<ServerResult> {
  const tempFile = path.join(mcpRoot, `.mcp-exec-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  const ioTimeoutMs = processLocalIoTimeout(timeout_ms);
  const cleanupTempFile = () => runWithAbortableTimeout(
    (_signal) => fs.unlink(tempFile), ioTimeoutMs, `Clean Node fallback temp file ${tempFile}`,
  ).catch(() => {});

  try {
    await runWithAbortableTimeout(
      (signal) => fs.writeFile(tempFile, code, { encoding: 'utf8', signal }),
      ioTimeoutMs,
      `Write Node fallback temp file ${tempFile}`,
    );

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number; outputLimitExceeded: boolean; timedOut: boolean }>((resolve) => {
      const proc = spawn(process.execPath, [tempFile], {
        cwd: mcpRoot,
        windowsHide: true, // Prevent visible console windows on Windows
        detached: process.platform !== 'win32',
      });

      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let outputLimitExceeded = false;
      let timedOut = false;
      let settled = false;

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode, outputLimitExceeded, timedOut });
      };
      const append = (target: 'stdout' | 'stderr', data: Buffer) => {
        if (outputLimitExceeded) return;
        if (outputBytes + data.length > MAX_NODE_LOCAL_OUTPUT_BYTES) {
          outputLimitExceeded = true;
          void terminateProcessTree(proc, undefined, true).catch(() => proc.kill('SIGKILL'));
          return;
        }
        outputBytes += data.length;
        if (target === 'stdout') stdout += data.toString();
        else stderr += data.toString();
      };

      proc.stdout.on('data', (data: Buffer) => append('stdout', data));
      proc.stderr.on('data', (data: Buffer) => append('stderr', data));
      proc.on('close', (exitCode) => finish(exitCode ?? 1));
      proc.on('error', (err) => {
        if (!outputLimitExceeded) stderr += `${stderr ? '\n' : ''}${err.message}`;
        finish(1);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(proc, undefined, true).catch(() => proc.kill('SIGKILL'));
      }, timeout_ms);
    });

    // Clean up temp file without letting a stalled filesystem hold the tool response.
    await cleanupTempFile();

    if (result.timedOut) {
      return {
        content: [{ type: "text", text: `Node fallback timed out after ${timeout_ms}ms; process tree terminated.` }],
        isError: true
      };
    }

    if (result.outputLimitExceeded) {
      return {
        content: [{
          type: "text",
          text: `Node fallback output exceeded ${MAX_NODE_LOCAL_OUTPUT_BYTES} bytes; process terminated.`
        }],
        isError: true
      };
    }

    if (result.exitCode !== 0) {
      return {
        content: [{
          type: "text",
          text: `Execution failed (exit code ${result.exitCode}):\n${result.stderr}\n${result.stdout}`
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: result.stdout || '(no output)'
      }]
    };

  } catch (error) {
    // Clean up temp file on error, bounded independently of the failure path.
    await cleanupTempFile();

    return {
      content: [{
        type: "text",
        text: `Failed to execute Node.js code: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Start a new process (renamed from execute_command)
 * Includes early detection of process waiting for input
 */
export async function startProcess(args: unknown): Promise<ServerResult> {
  const parsed = StartProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_start_process_failed');
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for start_process: ${parsed.error}` }],
      isError: true,
    };
  }

  const commandToRun = parsed.data.command;
  const executable = parsed.data.executable;
  const directArgs = parsed.data.args ?? [];
  const executionKind = parsed.data.execution_kind;
  let resolvedCwd: string | undefined;
  if (parsed.data.cwd) {
    if (!path.isAbsolute(parsed.data.cwd)) {
      return { content: [{ type: "text", text: 'Error: start_process.cwd must be an absolute path.' }], isError: true };
    }
    resolvedCwd = path.resolve(parsed.data.cwd);
    let cwdStats;
    try {
      cwdStats = await runWithAbortableTimeout(
        (_signal) => fs.stat(resolvedCwd!),
        processLocalIoTimeout(parsed.data.timeout_ms),
        `Inspect start_process.cwd ${resolvedCwd}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: Unable to inspect start_process.cwd ${resolvedCwd}: ${message}` }], isError: true };
    }
    if (!cwdStats.isDirectory()) {
      return { content: [{ type: "text", text: `Error: start_process.cwd is not a directory: ${resolvedCwd}` }], isError: true };
    }
  }

  if (commandToRun === 'node:local') {
    const virtualPid = virtualPidCounter--;
    virtualNodeSessions.set(virtualPid, { timeout_ms: parsed.data.timeout_ms || PROCESS_WAIT_DEFAULT_MS });
    registerToolCallCancellationCleanup(() => { virtualNodeSessions.delete(virtualPid); });
    return {
      content: [{ type: "text", text: `Node.js session started with PID ${virtualPid} (MCP server execution)\n\n🔄 Ready for self-contained code via interact_with_process.` }],
      structuredContent: { pid: virtualPid, backend: 'node-local', executionKind: 'interactive', state: 'waiting_for_input' },
    };
  }

  let isAllowed = false;
  if (commandToRun) {
    try {
      const commands = commandManager.extractCommands(commandToRun).join(', ');
      capture('server_start_process', { command: commandManager.getBaseCommand(commandToRun), commands });
    } catch {
      capture('server_start_process', { command: commandManager.getBaseCommand(commandToRun) });
    }
    isAllowed = await commandManager.validateCommand(commandToRun);
  } else {
    capture('server_start_process', { command: path.basename(executable!) });
    isAllowed = await commandManager.validateExecutable(executable!, directArgs);
  }
  if (!isAllowed) {
    return {
      content: [{ type: "text", text: `Error: Command not allowed: ${commandToRun ?? executable}` }],
      isError: true,
    };
  }

  let shellUsed: string | undefined = parsed.data.shell;
  if (commandToRun && !shellUsed) {
    const config = await configManager.getConfig();
    if (config.defaultShell) shellUsed = config.defaultShell;
    else if (os.platform() === 'win32' && process.env.COMSPEC) shellUsed = process.env.COMSPEC;
    else if (os.platform() !== 'win32' && process.env.SHELL) shellUsed = process.env.SHELL;
    else shellUsed = os.platform() === 'win32' ? 'cmd.exe' : '/bin/sh';
  }

  const launchSpec = executable
    ? { executable, args: directArgs, cwd: resolvedCwd, env: parsed.data.env }
    : commandToRun!;
  const executionOptions = {
    cwd: resolvedCwd,
    env: parsed.data.env,
    detectPrompts: executionKind === 'auto' || executionKind === 'interactive',
    executionKind,
    onSpawned: (pid: number) => {
      registerToolCallCancellationCleanup(async (cause) => {
        void await terminalManager.forceTerminate(
          pid, cause ?? 'client_cancelled', 'request-owned process cleanup',
        );
      });
    },
  };
  const wantsPty = parsed.data.pty === 'always' || (parsed.data.pty === 'auto' && executionKind === 'interactive');
  let ptyFallbackReason: string | undefined;
  let result;
  if (wantsPty) {
    try {
      result = await terminalManager.executePty(
        launchSpec, parsed.data.timeout_ms, shellUsed, parsed.data.verbose_timing || false, executionOptions,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (parsed.data.pty === 'always') {
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
      ptyFallbackReason = message;
      result = await terminalManager.executeCommand(
        launchSpec, parsed.data.timeout_ms, shellUsed, parsed.data.verbose_timing || false, executionOptions,
      );
    }
  } else {
    result = await terminalManager.executeCommand(
      launchSpec, parsed.data.timeout_ms, shellUsed, parsed.data.verbose_timing || false, executionOptions,
    );
  }

  if (result.pid === -1) {
    return { content: [{ type: "text", text: result.output }], isError: true };
  }

  const snapshot = terminalManager.readOutputPaginated(result.pid, -1, 1);
  const backend = result.backend ?? snapshot?.backend ?? 'pipe';
  const shouldInterpretPrompt = executionKind === 'auto' || executionKind === 'interactive';
  const processState = shouldInterpretPrompt
    ? analyzeProcessState(result.output, result.pid)
    : { isWaitingForInput: false, isFinished: false, isRunning: !snapshot?.isComplete, lastOutput: result.output };
  const terminalError = result.terminalError ?? snapshot?.terminalError;
  const state = terminalError
    ? 'terminal_error'
    : snapshot?.isComplete ? 'completed'
    : snapshot?.treeState === 'descendants_running' ? 'root_exited_tree_running'
    : snapshot?.treeState === 'probe_uncertain' ? 'root_exit_probe_uncertain'
    : snapshot?.treeState === 'root_exited_draining' ? 'root_exited_draining'
    : processState.isWaitingForInput ? 'waiting_for_input' : 'running';

  let statusMessage = '';
  if (snapshot?.isComplete) statusMessage = `\n✅ Process ${result.pid} completed with exit code ${snapshot.exitCode}`;
  else if (snapshot?.treeState === 'descendants_running') {
    statusMessage = `\n⏳ Root process exited with code ${snapshot.rootExitCode ?? 'unknown'}, but descendant processes are still running: ${(snapshot.descendantPids ?? []).join(', ') || 'detected tree activity'}.`;
  } else if (snapshot?.treeState === 'probe_uncertain') {
    statusMessage = `\n⚠️ Root process exited with code ${snapshot.rootExitCode ?? 'unknown'}, but process-tree completion could not be proven${snapshot.treeProbeWarning ? `: ${snapshot.treeProbeWarning}` : '.'}`;
  } else if (snapshot?.treeState === 'root_exited_draining') {
    statusMessage = `\n⏳ Root process exited with code ${snapshot.rootExitCode ?? 'unknown'}; draining stdio and checking descendants.`;
  } else if (processState.isWaitingForInput) statusMessage = `\n🔄 ${formatProcessStateMessage(processState, result.pid)}`;
  else if (result.isBlocked) statusMessage = '\n⏳ Process is running. Use read_process_output to get more output.';

  const timingMessage = result.timingInfo ? formatTimingInfo(result.timingInfo) : '';
  const initialOutput = compactInitialProcessOutput(result.output);
  const modeDescription = executable ? `direct: ${path.basename(executable)}` : `shell: ${shellUsed}`;
  const fallbackMessage = ptyFallbackReason ? `\n[PTY unavailable; used pipe fallback: ${ptyFallbackReason}]` : '';
  const terminalErrorMessage = terminalError ? `\n[TERMINAL ERROR: ${terminalError}]` : '';
  return {
    content: [{
      type: "text",
      text: `Process started with PID ${result.pid} (backend: ${backend}, ${modeDescription})\nInitial output:\n${initialOutput.text}${statusMessage}${fallbackMessage}${terminalErrorMessage}${timingMessage}`
    }],
    structuredContent: {
      pid: result.pid,
      backend,
      executionKind,
      launchMode: executable ? 'direct' : 'shell',
      cwd: resolvedCwd ?? null,
      executable: executable ?? null,
      state,
      exitCode: snapshot?.isComplete ? snapshot.exitCode ?? null : null,
      processSucceeded: snapshot?.isComplete ? snapshot.exitCode === 0 && !terminalError : null,
      ptyRequested: wantsPty,
      ptyFallback: Boolean(ptyFallbackReason),
      outputDecoding: snapshot?.outputDecoding ?? null,
      rootExited: snapshot?.rootExited ?? false,
      rootExitCode: snapshot?.rootExited ? snapshot.rootExitCode ?? null : null,
      treeState: snapshot?.treeState ?? null,
      descendantPids: snapshot?.descendantPids ?? [],
      treeProbeWarning: snapshot?.treeProbeWarning ?? null,
      terminalError: terminalError ?? null,
      initialOutputChars: initialOutput.chars,
      initialOutputTruncated: initialOutput.truncated,
      ...processProblemEvidence(result.output),
    },
  };
}

function formatTimingInfo(timing: any): string {
  let msg = '\n\n📊 Timing Information:\n';
  msg += `  Exit Reason: ${timing.exitReason}\n`;
  msg += `  Total Duration: ${timing.totalDurationMs}ms\n`;

  if (timing.timeToFirstOutputMs !== undefined) {
    msg += `  Time to First Output: ${timing.timeToFirstOutputMs}ms\n`;
  }

  if (timing.firstOutputTime && timing.lastOutputTime) {
    msg += `  Output Window: ${timing.lastOutputTime - timing.firstOutputTime}ms\n`;
  }

  if (timing.outputEvents && timing.outputEvents.length > 0) {
    msg += `\n  Output Events (${timing.outputEvents.length} total):\n`;
    timing.outputEvents.forEach((event: any, idx: number) => {
      msg += `    [${idx + 1}] +${event.deltaMs}ms | ${event.source} | ${event.length}b`;
      if (event.matchedPattern) {
        msg += ` | 🎯 ${event.matchedPattern}`;
      }
      msg += `\n       "${event.snippet}"\n`;
    });
  }

  return msg;
}

/**
 * Read output from a running process with file-like pagination
 * Supports offset/length parameters for controlled reading
 */
export async function readProcessOutput(args: unknown): Promise<ServerResult> {
  const parsed = ReadProcessOutputArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for read_process_output: ${parsed.error}` }],
      isError: true,
    };
  }

  // Get default line limit from config
  const config = await configManager.getConfig();
  const defaultLength = config.fileReadLineLimit ?? 1000;

  const { 
    pid, 
    timeout_ms = PROCESS_WAIT_DEFAULT_MS,
    stall_timeout_ms = PROCESS_STALL_DEFAULT_MS,
    offset = 0,                    // 0 = from last read, positive = absolute, negative = tail
    reader_id,                     // optional independent cursor for concurrent offset=0 readers
    length = defaultLength,        // Default from config, same as file reading
    verbose_timing = false 
  } = parsed.data;

  // Timing telemetry
  const startTime = Date.now();

  // For active sessions with no new output yet, optionally wait for output
  const session = terminalManager.getSession(pid);
  if (session && offset === 0) {
    // Wait for new output to arrive (only for "new output" reads, not absolute/tail)
    const waitForOutput = (): Promise<void> => {
      return new Promise((resolve) => {
        // Check if there's already new output
        if (session.outputRevision > terminalManager.getLastReadRevision(pid, reader_id)) {
          resolve();
          return;
        }
        const initialIdleMs = Math.max(0, Date.now() - session.lastOutputTime.getTime());
        if (stall_timeout_ms > 0 && initialIdleMs >= stall_timeout_ms) {
          resolve();
          return;
        }

        let resolved = false;
        let interval: NodeJS.Timeout | null = null;
        let timeout: NodeJS.Timeout | null = null;

        const cleanup = () => {
          if (interval) clearInterval(interval);
          if (timeout) clearTimeout(timeout);
        };

        const resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve();
        };

        // Poll for new output
        interval = setInterval(() => {
          // Completion may arrive through normal close or through the bounded
          // root-exit/tree reconciler when close is delayed/missing.
          const activeSession = terminalManager.getSession(pid);
          if (!activeSession) {
            resolveOnce();
            return;
          }
          if (activeSession.rootExitedAt) {
            void terminalManager.reconcileExitedSession(pid).catch(() => undefined);
          }
          if (session.outputRevision > terminalManager.getLastReadRevision(pid, reader_id)) {
            resolveOnce();
            return;
          }
          if (stall_timeout_ms > 0 && Date.now() - session.lastOutputTime.getTime() >= stall_timeout_ms) {
            resolveOnce();
          }
        }, 50);

        // Timeout
        timeout = setTimeout(() => {
          resolveOnce();
        }, timeout_ms);
      });
    };

    await waitForOutput();
  }

  // Read output with pagination
  const result = terminalManager.readOutputPaginated(pid, offset, length, reader_id);
  
  if (!result) {
    return {
      content: [{ type: "text", text: `No session found for PID ${pid}` }],
      isError: true,
    };
  }

  // Join lines back into string. A terminal chunk can append to a partial line
  // that a cursor already consumed and add new lines in the same chunk; preserve
  // that newly appended suffix before the newly indexed lines.
  const outputParts = result.continuedLine !== undefined
    ? [result.continuedLine, ...result.lines]
    : result.lines;
  let output = outputParts.join('\n');
  if (!output && result.outputChangedWithoutNewLine && result.latestPartialLine !== undefined) {
    output = result.latestPartialLine;
  }

  // Generate status message similar to file reading
  let statusMessage = '';
  if (offset < 0) {
    // Tail read - match file reading format for consistency
    statusMessage = `[Reading last ${result.readCount} lines (total: ${result.totalLines} lines)]`;
  } else if (offset === 0) {
    // "New output" read
    if (result.remaining > 0) {
      statusMessage = `[Reading ${result.readCount} new lines from line ${result.readFrom} (total: ${result.totalLines} lines, ${result.remaining} remaining)]`;
    } else {
      statusMessage = `[Reading ${result.readCount} new lines (total: ${result.totalLines} lines)]`;
    }
  } else {
    // Absolute position read
    statusMessage = `[Reading ${result.readCount} lines from line ${result.readFrom} (total: ${result.totalLines} lines, ${result.remaining} remaining)]`;
  }

  // Surface buffer-cap eviction so the model knows the retained output is not
  // the full output and that line numbers shifted (matches the truncation
  // markers used by other tools).
  if (result.outputChangedWithoutNewLine) {
    statusMessage += `\n[OUTPUT ACTIVITY: stdout/stderr changed without adding a newline; showing the latest partial line.]`;
  }

  if (result.evictedLines && result.evictedLines > 0) {
    const capMB = Math.round(MAX_BUFFERED_OUTPUT_CHARS / 1024 / 1024);
    statusMessage += `\n[WARNING: output exceeded the ${capMB}MB buffer cap; the ${result.evictedLines} earliest lines were evicted and cannot be read. Line numbers and totals refer to the retained buffer only]`;
  }

  if (!result.isComplete && result.treeState === 'descendants_running') {
    statusMessage += `\n[ROOT EXITED: root exit code ${result.rootExitCode ?? 'unknown'}; descendants still running: ${(result.descendantPids ?? []).join(', ') || 'detected tree activity'}]`;
  } else if (!result.isComplete && result.treeState === 'probe_uncertain') {
    statusMessage += `\n[ROOT EXITED: completion not proven${result.treeProbeWarning ? `; ${result.treeProbeWarning}` : ''}]`;
  }

  if (!result.isComplete && stall_timeout_ms > 0 && (result.noOutputForMs ?? 0) >= stall_timeout_ms) {
    statusMessage += `\n[STALL WARNING: process is still running but produced no stdout/stderr for ${result.noOutputForMs}ms (threshold ${stall_timeout_ms}ms). Output silence alone is not treated as process failure or termination.]`;
  }
  if (result.terminalError) {
    statusMessage += `\n[TERMINAL ERROR: ${result.terminalError}]`;
  }

  // Add process state info
  let processStateMessage = '';
  if (result.isComplete) {
    const runtimeStr = result.runtimeMs !== undefined 
      ? ` (runtime: ${(result.runtimeMs / 1000).toFixed(2)}s)` 
      : '';
    processStateMessage = `\n✅ Process completed with exit code ${result.exitCode}${runtimeStr}`;
  } else if (session && (session.executionKind === 'auto' || session.executionKind === 'interactive')) {
    // Prompt interpretation is only valid for auto/interactive processes.
    const fullOutput = session.outputLines.join('\n');
    const processState = analyzeProcessState(fullOutput, pid);
    if (processState.isWaitingForInput) {
      processStateMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
    }
  }

  // Add timing information if requested
  let timingMessage = '';
  if (verbose_timing) {
    const endTime = Date.now();
    timingMessage = `\n\n📊 Timing: ${endTime - startTime}ms`;
  }

  const responseText = output || '(No output in requested range)';

  return {
    content: [{
      type: "text",
      text: `${statusMessage}\n\n${responseText}${processStateMessage}${timingMessage}`
    }],
    structuredContent: {
      pid,
      backend: result.backend ?? 'pipe',
      state: result.isComplete ? 'completed'
        : result.treeState === 'descendants_running' ? 'root_exited_tree_running'
        : result.treeState === 'probe_uncertain' ? 'root_exit_probe_uncertain'
        : result.treeState === 'root_exited_draining' ? 'root_exited_draining'
        : (processStateMessage ? 'waiting_for_input' : 'running'),
      isComplete: result.isComplete,
      exitCode: result.isComplete ? result.exitCode ?? null : null,
      processSucceeded: result.isComplete ? result.exitCode === 0 && !result.terminalError : null,
      runtimeMs: result.runtimeMs ?? null,
      noOutputForMs: result.noOutputForMs ?? null,
      evictedLines: result.evictedLines ?? 0,
      remainingLines: result.remaining,
      outputDecoding: result.outputDecoding ?? null,
      rootExited: result.rootExited ?? false,
      rootExitCode: result.rootExited ? result.rootExitCode ?? null : null,
      treeState: result.treeState ?? null,
      descendantPids: result.descendantPids ?? [],
      treeProbeWarning: result.treeProbeWarning ?? null,
      terminalError: result.terminalError ?? null,
      ...processProblemEvidence(output),
    },
  };
}

/**
 * Interact with a running process (renamed from send_input)
 * Automatically detects when process is ready and returns output
 */
export async function interactWithProcess(args: unknown): Promise<ServerResult> {
  const parsed = InteractWithProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_interact_with_process_failed', {
      error: 'Invalid arguments'
    });
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for interact_with_process: ${parsed.error}` }],
      isError: true,
    };
  }

  const {
    pid,
    input,
    timeout_ms = PROCESS_INTERACTION_DEFAULT_MS,
    wait_for_prompt = true,
    verbose_timing = false
  } = parsed.data;

  // Get config for output line limit
  const config = await configManager.getConfig();
  const maxOutputLines = config.fileReadLineLimit ?? 1000;

  // Check if this is a virtual Node session (node:local)
  if (virtualNodeSessions.has(pid)) {
    const session = virtualNodeSessions.get(pid)!;
    capture('server_interact_with_process_node_fallback', {
      pid: pid,
      inputLength: input.length
    });

    // Execute code via temp file approach
    // Respect per-call timeout if provided, otherwise use session default
    const effectiveTimeout = timeout_ms ?? session.timeout_ms;
    return executeNodeCode(input, effectiveTimeout);
  }

  // Serialize the whole snapshot -> stdin -> response transaction for this PID.
  // Raw stdin writes are ordered, but without this lease concurrent callers share
  // the same response window and can consume each other's logical output.
  const startTime = Date.now();
  const interactionDeadline = startTime + timeout_ms;
  let releaseInteraction: (() => void) | undefined;
  try {
    releaseInteraction = await acquireProcessInteractionLease(pid, timeout_ms);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error interacting with process: ${errorMessage}` }], isError: true };
  }
  const responseTimeoutMs = Math.max(1, interactionDeadline - Date.now());

  // Timing telemetry
  let firstOutputTime: number | undefined;
  let lastOutputTime: number | undefined;
  const outputEvents: any[] = [];
  let exitReason: 'early_exit_quick_pattern' | 'early_exit_periodic_check' | 'process_finished' | 'timeout' | 'no_wait' = 'timeout';

  try {
    capture('server_interact_with_process', {
      pid: pid,
      inputLength: input.length
    });

    // Capture output snapshot BEFORE sending input
    // This handles REPLs where output is appended to the prompt line
    const outputSnapshot = terminalManager.captureOutputSnapshot(pid);
    const interactionBackend = terminalManager.getSession(pid)?.backend;

    const success = terminalManager.sendInputToProcess(pid, input);

    if (!success) {
      const terminalState = terminalManager.readOutputPaginated(pid, -1, 1);
      const terminalDetail = terminalState?.terminalError
        ? ` Terminal backend reported: ${terminalState.terminalError}` : '';
      return {
        content: [{ type: "text", text: `Error: Failed to send input to process ${pid}. The process may have exited or doesn't accept input.${terminalDetail}` }],
        structuredContent: {
          pid,
          state: terminalState?.isComplete ? 'completed' : 'unavailable_for_input',
          exitCode: terminalState?.isComplete ? terminalState.exitCode ?? null : null,
          terminalError: terminalState?.terminalError ?? null,
        },
        isError: true,
      };
    }

    // If not waiting for response, return immediately
    if (!wait_for_prompt) {
      exitReason = 'no_wait';
      let timingMessage = '';
      if (verbose_timing) {
        const endTime = Date.now();
        const timingInfo = {
          startTime,
          endTime,
          totalDurationMs: endTime - startTime,
          exitReason,
          firstOutputTime,
          lastOutputTime,
          timeToFirstOutputMs: undefined,
          outputEvents: undefined
        };
        timingMessage = formatTimingInfo(timingInfo);
      }
      return {
        content: [{
          type: "text",
          text: `✅ Input sent to process ${pid}. Use read_process_output to get the response.${timingMessage}`
        }],
      };
    }

    // Smart waiting with immediate and periodic detection
    let output = "";
    let processState: ProcessState | undefined;
    let earlyExit = false;
    let processFinished = false;
    let terminalError: string | undefined;
    let completedExitCode: number | null | undefined;

    // Quick prompt patterns for immediate detection
    const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;
    
    const waitForResponse = (): Promise<void> => {
      return new Promise((resolve) => {
        let resolved = false;
        let attempts = 0;
        const pollIntervalMs = 50; // Poll every 50ms for faster response
        const maxAttempts = Math.ceil(responseTimeoutMs / pollIntervalMs);
        let interval: NodeJS.Timeout | null = null;
        let lastOutputLength = 0; // Track output length to detect new output
        let pipePromptCandidateAt: number | undefined;
        let pipePromptCandidateLength = 0;

        let resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          if (interval) clearInterval(interval);
          resolve();
        };

        // Fast-polling check - check every 50ms for quick responses
        interval = setInterval(() => {
          if (resolved) return;
          if (!terminalManager.getSession(pid)) {
            // The active session may have moved to completed after writing its
            // final stderr/terminal-host bytes. Read that completed buffer before
            // resolving so process exit cannot erase the response tail.
            const finalOutput = outputSnapshot
              ? terminalManager.getOutputSinceSnapshot(pid, outputSnapshot)
              : terminalManager.getNewOutput(pid);
            if (finalOutput) {
              output = finalOutput;
              lastOutputLength = finalOutput.length;
              const now = Date.now();
              if (!firstOutputTime) firstOutputTime = now;
              lastOutputTime = now;
            }
            const completed = terminalManager.readOutputPaginated(pid, -1, 1);
            terminalError = completed?.terminalError;
            completedExitCode = completed?.isComplete ? completed.exitCode ?? null : undefined;
            processFinished = completed?.isComplete ?? true;
            exitReason = 'process_finished';
            resolveOnce();
            return;
          }

          // Use snapshot-based reading to handle REPL prompt line appending
          const newOutput = outputSnapshot 
            ? terminalManager.getOutputSinceSnapshot(pid, outputSnapshot)
            : terminalManager.getNewOutput(pid);
            
          if (newOutput && newOutput.length > lastOutputLength) {
            const now = Date.now();
            if (!firstOutputTime) firstOutputTime = now;
            lastOutputTime = now;

            if (verbose_timing) {
              outputEvents.push({
                timestamp: now,
                deltaMs: now - startTime,
                source: 'periodic_poll',
                length: newOutput.length - lastOutputLength,
                snippet: newOutput.slice(lastOutputLength, lastOutputLength + 50).replace(/\n/g, '\\n')
              });
            }

            output = newOutput; // Replace with full output since snapshot
            lastOutputLength = newOutput.length;

            // Analyze current state
            processState = analyzeProcessState(output, pid);

            // A PTY is already one terminal stream, so a prompt is a stable response
            // boundary. Pipe-backed processes have independent stdout/stderr pipes:
            // one stream can publish the prompt before the other stream's payload is
            // delivered to Node. Treat a pipe prompt as a candidate until output has
            // stayed quiet for a short bounded settle window. Any later output resets
            // the candidate because lastOutputLength changes on this poll.
            if (processState.isWaitingForInput) {
              if (interactionBackend === 'pty') {
                earlyExit = true;
                exitReason = 'early_exit_periodic_check';
                if (verbose_timing && outputEvents.length > 0) {
                  outputEvents[outputEvents.length - 1].matchedPattern = 'periodic_check';
                }
                resolveOnce();
                return;
              }
              pipePromptCandidateAt = now;
              pipePromptCandidateLength = newOutput.length;
            } else {
              pipePromptCandidateAt = undefined;
            }

            // Also exit if process finished
            if (processState.isFinished) {
              exitReason = 'process_finished';
              resolveOnce();
              return;
            }
          } else if (
            pipePromptCandidateAt !== undefined
            && Date.now() - pipePromptCandidateAt >= PIPE_PROMPT_SETTLE_MS
          ) {
            const settledOutput = outputSnapshot
              ? terminalManager.getOutputSinceSnapshot(pid, outputSnapshot)
              : terminalManager.getNewOutput(pid);
            if (settledOutput && settledOutput.length === pipePromptCandidateLength) {
              const settledState = analyzeProcessState(settledOutput, pid);
              if (settledState.isWaitingForInput) {
                output = settledOutput;
                processState = settledState;
                earlyExit = true;
                exitReason = 'early_exit_periodic_check';
                if (verbose_timing && outputEvents.length > 0) {
                  outputEvents[outputEvents.length - 1].matchedPattern = 'pipe_prompt_settled';
                }
                resolveOnce();
                return;
              }
            }
          }

          attempts++;
          if (attempts >= maxAttempts) {
            exitReason = 'timeout';
            resolveOnce();
          }
        }, pollIntervalMs);
      });
    };
    
    await waitForResponse();

    // Clean and format output
    let cleanOutput = cleanProcessOutput(output, input);
    const timeoutReached = !earlyExit && !processFinished && !processState?.isFinished && !processState?.isWaitingForInput;
    
    // Apply output line limit to prevent context overflow
    let truncationMessage = '';
    const outputLines = cleanOutput.split('\n');
    if (outputLines.length > maxOutputLines) {
      const truncatedLines = outputLines.slice(0, maxOutputLines);
      cleanOutput = truncatedLines.join('\n');
      const remainingLines = outputLines.length - maxOutputLines;
      truncationMessage = `\n\n⚠️ Output truncated: showing ${maxOutputLines} of ${outputLines.length} lines (${remainingLines} hidden). Use read_process_output with offset/length for full output.`;
    }
    
    // Determine final state
    if (!processState) {
      processState = analyzeProcessState(output, pid);
    }
    
    let statusMessage = '';
    const completedState = (processFinished || processState.isFinished)
      ? terminalManager.readOutputPaginated(pid, -1, 1) : null;
    if (completedState?.terminalError) terminalError = completedState.terminalError;
    if (completedState?.isComplete) completedExitCode = completedState.exitCode ?? null;
    if (processState.isWaitingForInput) {
      statusMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
    } else if (processFinished || processState.isFinished) {
      statusMessage = completedState?.isComplete
        ? `\n✅ Process ${pid} completed with exit code ${completedState.exitCode}`
        : `\n✅ ${formatProcessStateMessage(processState, pid)}`;
    } else if (timeoutReached) {
      statusMessage = '\n⏱️ Response may be incomplete (timeout reached)';
    }
    if (terminalError) statusMessage += `\n[TERMINAL ERROR: ${terminalError}]`;

    // Add timing information if requested
    let timingMessage = '';
    if (verbose_timing) {
      const endTime = Date.now();
      const timingInfo = {
        startTime,
        endTime,
        totalDurationMs: endTime - startTime,
        exitReason,
        firstOutputTime,
        lastOutputTime,
        timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
        outputEvents: outputEvents.length > 0 ? outputEvents : undefined
      };
      timingMessage = formatTimingInfo(timingInfo);
    }

    if (cleanOutput.trim().length === 0 && !timeoutReached) {
      return {
        content: [{
          type: "text",
          text: `✅ Input executed in process ${pid}.\n📭 (No output produced)${statusMessage}${timingMessage}`
        }],
        structuredContent: {
          pid,
          state: processFinished ? 'completed' : processState.isWaitingForInput ? 'waiting_for_input' : 'running',
          exitCode: completedExitCode ?? null,
          processSucceeded: processFinished && completedExitCode !== undefined
            ? completedExitCode === 0 && !terminalError : null,
          terminalError: terminalError ?? null,
          timedOut: timeoutReached,
        },
      };
    }

    // Format response with better structure and consistent emojis
    let responseText = `✅ Input executed in process ${pid}`;

    if (cleanOutput && cleanOutput.trim().length > 0) {
      responseText += `:\n\n📤 Output:\n${cleanOutput}`;
    } else {
      responseText += `.\n📭 (No output produced)`;
    }

    if (statusMessage) {
      responseText += `\n\n${statusMessage}`;
    }

    if (truncationMessage) {
      responseText += truncationMessage;
    }

    if (timingMessage) {
      responseText += timingMessage;
    }

    return {
      content: [{
        type: "text",
        text: responseText
      }],
      structuredContent: {
        pid,
        state: processFinished ? 'completed' : processState.isWaitingForInput ? 'waiting_for_input' : 'running',
        exitCode: completedExitCode ?? null,
        processSucceeded: processFinished && completedExitCode !== undefined
          ? completedExitCode === 0 && !terminalError : null,
        terminalError: terminalError ?? null,
        timedOut: timeoutReached,
        ...processProblemEvidence(cleanOutput),
      },
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    capture('server_interact_with_process_error', {
      error: errorMessage
    });
    return {
      content: [{ type: "text", text: `Error interacting with process: ${errorMessage}` }],
      isError: true,
    };
  } finally {
    releaseInteraction?.();
  }
}

/**
 * Force terminate a process
 */
export async function forceTerminate(args: unknown): Promise<ServerResult> {
  const parsed = ForceTerminateArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for force_terminate: ${parsed.error}` }],
      isError: true,
    };
  }

  const pid = parsed.data.pid;

  // Handle virtual Node.js sessions (node:local)
  if (virtualNodeSessions.has(pid)) {
    virtualNodeSessions.delete(pid);
    return {
      content: [{
        type: "text",
        text: `Cleared virtual Node.js session ${pid}`
      }],
    };
  }

  const success = await terminalManager.forceTerminate(pid);
  return {
    content: [{
      type: "text",
      text: success
        ? `Successfully initiated termination of session ${pid}`
        : `No active session found for PID ${pid}`
    }],
  };
}

/**
 * List active sessions
 */
export async function listSessions(): Promise<ServerResult> {
  const sessions = terminalManager.listActiveSessions();

  // Include virtual Node.js sessions
  const virtualSessions = Array.from(virtualNodeSessions.entries()).map(([pid, session]) => ({
    pid,
    type: 'node:local',
    timeout_ms: session.timeout_ms
  }));

  const realSessionsText = sessions.map(s =>
    `PID: ${s.pid}, Backend: ${s.backend}, Kind: ${s.executionKind}, Blocked: ${s.isBlocked}, Runtime: ${Math.round(s.runtime / 1000)}s`
  );

  const virtualSessionsText = virtualSessions.map(s =>
    `PID: ${s.pid} (node:local), Timeout: ${s.timeout_ms}ms`
  );

  const allSessions = [...realSessionsText, ...virtualSessionsText];

  return {
    content: [{
      type: "text",
      text: allSessions.length === 0
        ? 'No active sessions'
        : allSessions.join('\n')
    }],
    structuredContent: { sessions, virtualSessions },
  };
}