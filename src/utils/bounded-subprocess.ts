import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';

import { terminateProcessTree } from './process-tree.js';
import { makeCancellationError } from './cancellation.js';

export interface BoundedSubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BoundedSubprocessOptions {
  cwd?: string;
  input?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  label?: string;
}

export async function runBoundedSubprocess(
  executable: string,
  args: string[],
  options: BoundedSubprocessOptions,
): Promise<BoundedSubprocessResult> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error('Bounded subprocess timeoutMs must be a positive integer.');
  }
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
    throw new Error('Bounded subprocess maxOutputBytes must be a positive integer.');
  }
  const label = options.label ?? executable;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let forcedError: Error | undefined;

    const finish = (result?: BoundedSubprocessResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };

    const forceTerminate = (error: Error) => {
      if (forcedError) return;
      forcedError = error;
      void terminateProcessTree(child, undefined, true).catch(() => child.kill('SIGKILL'));
    };
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        const error = new Error(`${label} output exceeded ${options.maxOutputBytes} bytes.`);
        (error as NodeJS.ErrnoException).code = 'EOUTPUTLIMIT';
        forceTerminate(error);
        return;
      }
      if (target === 'stdout') stdout += stdoutDecoder.write(chunk);
      else stderr += stderrDecoder.write(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') finish(undefined, error);
    });
    child.on('error', (error) => finish(undefined, error));
    child.on('close', (code) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (forcedError) finish(undefined, forcedError);
      else finish({ stdout, stderr, exitCode: code ?? 1 });
    });

    const timer = setTimeout(() => {
      forceTerminate(makeCancellationError(
        'deadline_exceeded',
        `${label} timed out after ${options.timeoutMs}ms.`,
        'ETIMEDOUT',
      ));
    }, options.timeoutMs);

    if (options.input !== undefined) child.stdin.end(options.input, 'utf8');
    else child.stdin.end();
  });
}
