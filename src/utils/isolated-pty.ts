import { fork, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

export interface IsolatedPtyOptions {
  cwd?: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  startupTimeoutMs?: number;
}

export type IsolatedPtyProcessTreeOwner = 'windows_job' | 'pid_tree' | 'posix_group';

export interface IsolatedPtyExitEvent {
  exitCode: number;
  terminalError?: string;
}

export interface IsolatedPty {
  readonly pid: number;
  readonly processTreeOwner: IsolatedPtyProcessTreeOwner;
  write(data: string): void;
  pause(): void;
  resume(): void;
  kill(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: IsolatedPtyExitEvent) => void): { dispose(): void };
}

type HostMessage =
  | { type: 'ready'; pid: number; processTreeOwner?: IsolatedPtyProcessTreeOwner }
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string };

const HOST_SCRIPT = fileURLToPath(new URL('../pty-session-host.js', import.meta.url));
const HOST_HARD_KILL_MS = 2000;
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class IsolatedPtyClient implements IsolatedPty {
  readonly pid: number;
  readonly processTreeOwner: IsolatedPtyProcessTreeOwner;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: IsolatedPtyExitEvent) => void>();
  private readonly pendingData: string[];
  private pendingExit?: IsolatedPtyExitEvent;
  private hostExited = false;
  private flowPaused = false;
  private killTimer?: NodeJS.Timeout;

  constructor(
    pid: number,
    processTreeOwner: IsolatedPtyProcessTreeOwner,
    private readonly host: ChildProcess,
    pendingData: string[],
    pendingExit?: IsolatedPtyExitEvent,
  ) {
    this.pid = pid;
    this.processTreeOwner = processTreeOwner;
    this.pendingData = pendingData;
    this.pendingExit = pendingExit;
  }

  write(data: string): void {
    if (this.hostExited || !this.host.connected) throw new Error('PTY host is not connected.');
    this.host.send?.({ type: 'write', data }, (error) => {
      if (error) this.emitHostFailure(`PTY IPC write failed: ${error.message}`);
    });
  }

  pause(): void { this.setFlowPaused(true); }
  resume(): void { this.setFlowPaused(false); }

  private setFlowPaused(paused: boolean): void {
    if (this.flowPaused === paused || this.hostExited || !this.host.connected) return;
    this.flowPaused = paused;
    this.host.send?.({ type: 'flow', paused }, (error) => {
      if (error) this.emitHostFailure(`PTY flow-control IPC failed: ${error.message}`);
    });
  }

  kill(): void {
    if (this.hostExited) return;
    try {
      this.host.send?.({ type: 'kill' });
    } catch {}
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      if (!this.hostExited) this.host.kill('SIGKILL');
    }, HOST_HARD_KILL_MS);
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    if (this.pendingData.length > 0) {
      const data = this.pendingData.splice(0).join('');
      queueMicrotask(() => {
        if (this.dataListeners.has(listener)) listener(data);
      });
    }
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: IsolatedPtyExitEvent) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    if (this.pendingExit) {
      const event = this.pendingExit;
      queueMicrotask(() => {
        if (this.exitListeners.has(listener)) listener(event);
      });
    }
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  handleMessage(message: HostMessage): void {
    if (message.type === 'data') {
      if (this.dataListeners.size === 0) this.pendingData.push(message.data);
      else for (const listener of this.dataListeners) listener(message.data);
      return;
    }
    if (message.type === 'exit') {
      const event = { exitCode: Number.isInteger(message.exitCode) ? message.exitCode : 1 };
      this.pendingExit = event;
      for (const listener of this.exitListeners) listener(event);
      return;
    }
    if (message.type === 'error') this.emitHostFailure(message.message);
  }

  handleHostExit(code: number | null, signal: NodeJS.Signals | null, stderr: string): void {
    if (this.hostExited) return;
    this.hostExited = true;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = undefined;
    if (this.pendingExit) return;
    const details = stderr.trim() || `exit=${code ?? 'null'} signal=${signal ?? 'null'}`;
    this.emitHostFailure(`PTY host exited unexpectedly: ${details}`);
  }

  private emitHostFailure(message: string): void {
    const line = `\n[PTY_HOST_ERROR: ${message}]\n`;
    if (this.dataListeners.size === 0) this.pendingData.push(line);
    else for (const listener of this.dataListeners) listener(line);
    if (!this.pendingExit) {
      const event: IsolatedPtyExitEvent = { exitCode: 1, terminalError: message };
      this.pendingExit = event;
      for (const listener of this.exitListeners) listener(event);
    }
  }
}
export async function spawnIsolatedPty(
  executable: string,
  args: string[],
  options: IsolatedPtyOptions,
): Promise<IsolatedPty> {
  const host = fork(HOST_SCRIPT, [], {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  host.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-32 * 1024);
  });

  return new Promise<IsolatedPty>((resolve, reject) => {
    const pendingData: string[] = [];
    let pendingExit: IsolatedPtyExitEvent | undefined;
    let client: IsolatedPtyClient | undefined;
    let settled = false;
    const startupTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      host.kill('SIGKILL');
      reject(new Error('PTY host startup timed out.'));
    }, Math.max(250, Math.min(10_000, options.startupTimeoutMs ?? 5000)));
    host.on('message', (raw: unknown) => {
      const message = raw as HostMessage;
      if (message?.type === 'ready' && !settled) {
        settled = true;
        clearTimeout(startupTimer);
        client = new IsolatedPtyClient(
          message.pid,
          message.processTreeOwner ?? (process.platform === 'win32' ? 'pid_tree' : 'posix_group'),
          host, pendingData, pendingExit,
        );
        resolve(client);
        return;
      }
      if (!client) {
        if (message?.type === 'data') pendingData.push(message.data);
        else if (message?.type === 'exit') pendingExit = { exitCode: message.exitCode };
        else if (message?.type === 'error' && !settled) {
          settled = true;
          clearTimeout(startupTimer);
          host.kill('SIGKILL');
          reject(new Error(message.message));
        }
        return;
      }
      client.handleMessage(message);
    });

    host.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(startupTimer);
        reject(new Error(`PTY host exited before ready: ${stderr.trim() || `exit=${code ?? 'null'} signal=${signal ?? 'null'}`}`));
        return;
      }
      client?.handleHostExit(code, signal, stderr);
    });
    host.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      reject(error);
    });

    host.send?.({
      type: 'start',
      executable,
      args,
      cwd: options.cwd,
      env: options.env,
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
    }, (error) => {
      if (!error || settled) return;
      settled = true;
      clearTimeout(startupTimer);
      host.kill('SIGKILL');
      reject(new Error(`PTY host start IPC failed: ${errorText(error)}`));
    });
  });
}
