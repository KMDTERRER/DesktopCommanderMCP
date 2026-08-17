import { attachProcessToWindowsJob, type WindowsJobAttachment } from './utils/windows-job-owner.js';

type ProcessTreeOwner = 'windows_job' | 'pid_tree' | 'posix_group';

interface DisposableLike { dispose(): void; }
interface PtyLike {
  readonly pid: number;
  write(data: string | Buffer): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  onData(listener: (data: string) => unknown): DisposableLike;
  onExit(listener: (event: { exitCode: number; signal?: number }) => unknown): DisposableLike;
}

type StartMessage = {
  type: 'start';
  executable: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
};
type ParentMessage =
  | StartMessage
  | { type: 'write'; data: string }
  | { type: 'flow'; paused: boolean }
  | { type: 'kill' };

type HostMessage =
  | { type: 'ready'; pid: number; processTreeOwner: ProcessTreeOwner }
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string };

let terminal: PtyLike | undefined;
let dataDisposable: DisposableLike | undefined;
let exitDisposable: DisposableLike | undefined;
let exitSent = false;
let readySent = false;
let pausedForIpc = false;
let pausedForConsumer = false;
let ptyPaused = false;
let killWatchdog: NodeJS.Timeout | undefined;
let jobAttachment: WindowsJobAttachment | undefined;
let processTreeOwner: ProcessTreeOwner = process.platform === 'win32' ? 'pid_tree' : 'posix_group';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function sendMessage(message: HostMessage, callback?: (error?: Error) => void): boolean {
  if (!process.connected || !process.send) {
    callback?.(new Error('PTY parent IPC is disconnected.'));
    return false;
  }
  try {
    return process.send(message, (error) => callback?.(error ?? undefined));
  } catch (error) {
    callback?.(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

function cleanup(): void {
  dataDisposable?.dispose();
  exitDisposable?.dispose();
  dataDisposable = undefined;
  exitDisposable = undefined;
  if (killWatchdog) clearTimeout(killWatchdog);
  killWatchdog = undefined;
}

function reconcileFlowPause(): void {
  if (!terminal) return;
  const shouldPause = pausedForIpc || pausedForConsumer;
  if (ptyPaused === shouldPause) return;
  ptyPaused = shouldPause;
  try {
    if (shouldPause) terminal.pause();
    else terminal.resume();
  } catch {}
}

function sendReady(forceFallback = false): boolean {
  if (readySent || !terminal) return readySent;
  const realPid = Number(terminal.pid);
  if ((!Number.isInteger(realPid) || realPid <= 0) && !forceFallback) return false;
  readySent = true;
  sendMessage({
    type: 'ready',
    pid: Number.isInteger(realPid) && realPid > 0 ? realPid : process.pid,
    processTreeOwner,
  });
  return true;
}

function forwardData(data: string): void {
  // node-pty >=1.2 beta can report pid=0 until ConPTY connects. VS Code waits
  // for first data before publishing the pid; preserve ready->data IPC order.
  sendReady(true);
  const accepted = sendMessage({ type: 'data', data }, () => {
    if (!pausedForIpc) return;
    pausedForIpc = false;
    reconcileFlowPause();
  });
  if (!accepted && !pausedForIpc) {
    pausedForIpc = true;
    reconcileFlowPause();
  }
}

async function startTerminal(message: StartMessage): Promise<void> {
  if (terminal) throw new Error('PTY session is already started.');
  if (process.platform === 'win32' && !jobAttachment) {
    const attached = await attachProcessToWindowsJob(process.pid);
    if (attached) {
      jobAttachment = attached;
      processTreeOwner = 'windows_job';
    }
  }
  const ptyModuleName = 'node-pty';
  const pty = await import(ptyModuleName) as { spawn: (...args: any[]) => PtyLike };
  terminal = pty.spawn(message.executable, message.args, {
    name: 'xterm-256color',
    cols: message.cols,
    rows: message.rows,
    cwd: message.cwd,
    env: message.env,
  });
  dataDisposable = terminal.onData(forwardData);
  exitDisposable = terminal.onExit(({ exitCode }) => {
    exitSent = true;
    // Silent/very short processes may exit before producing data. In that case
    // publish a stable host pid only as a session identity fallback.
    sendReady(true);
    const normalizedExitCode = Number.isInteger(exitCode) ? exitCode : 1;
    sendMessage({ type: 'exit', exitCode: normalizedExitCode });
  });
  sendReady(false);
}

function terminateTerminal(): void {
  if (!terminal) {
    process.exit(0);
    return;
  }
  // After the parent observed exit and its quiet-data window elapsed, this
  // second kill is intentional: it releases ConPTY/native worker resources.
  if (exitSent) {
    try { terminal.kill(); } catch {}
    cleanup();
    process.exit(0);
    return;
  }

  try {
    terminal.kill();
  } catch (error) {
    sendMessage({ type: 'error', message: `PTY kill failed: ${errorText(error)}` });
  }
  // An upstream native hang/crash is contained in this child. The parent also
  // has its own hard-kill watchdog, but keep a local one for standalone safety.
  killWatchdog = setTimeout(() => process.exit(0), 1500);
}

process.on('message', (raw: unknown) => {
  const message = raw as ParentMessage;
  void (async () => {
    if (message?.type === 'start') {
      await startTerminal(message);
      return;
    }
    if (message?.type === 'write') {
      if (!terminal || exitSent) throw new Error('PTY is not writable.');
      terminal.write(message.data);
      return;
    }
    if (message?.type === 'flow') {
      pausedForConsumer = message.paused;
      reconcileFlowPause();
      return;
    }
    if (message?.type === 'kill') terminateTerminal();
  })().catch((error) => {
    sendMessage({ type: 'error', message: errorText(error) });
    cleanup();
    setImmediate(() => process.exit(1));
  });
});

process.on('disconnect', () => {
  // Do not call into a potentially hung native PTY during parent shutdown.
  cleanup();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  sendMessage({ type: 'error', message: `PTY host uncaught exception: ${errorText(error)}` });
  cleanup();
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  sendMessage({ type: 'error', message: `PTY host unhandled rejection: ${errorText(error)}` });
  cleanup();
  process.exit(1);
});
