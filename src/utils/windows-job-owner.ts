import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PassThrough, type Readable } from 'stream';
import { fileURLToPath } from 'url';

import { runBoundedSubprocess } from './bounded-subprocess.js';

const TARGET_PID_PREFIX = '__DC_JOB_TARGET_PID__=';
const ATTACHED_PREFIX = '__DC_JOB_ATTACHED__=';
const ERROR_PREFIX = '__DC_JOB_ERROR__=';
const CONTROL_MAX_BYTES = 4096;
const COMPILE_TIMEOUT_MS = 15_000;
const HELPER_EXIT_TIMEOUT_MS = 3_000;
const HELPER_CONTROL_TIMEOUT_MS = 5_000;
const HELPER_CACHE_DIR = path.join(os.homedir(), '.desktop-commander', 'native');

let helperPromise: Promise<string | null> | undefined;
let helperFailure: string | undefined;

export interface WindowsJobOwnedProcess {
  process: ChildProcessWithoutNullStreams;
  pid: number;
  stdout: Readable;
  stderr: Readable;
  owner: 'windows_job';
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function existingFile(candidate: string): Promise<string | null> {
  try {
    const stats = await fs.stat(candidate);
    return stats.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

async function resolveHelperSource(): Promise<string> {
  const besideCompiledModule = fileURLToPath(new URL('../native/windows-job-wrapper.cs', import.meta.url));
  const localSourceFallback = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '../../src/native/windows-job-wrapper.cs',
  );
  for (const candidate of [besideCompiledModule, localSourceFallback]) {
    const found = await existingFile(candidate);
    if (found) return found;
  }
  throw new Error('Windows Job helper source is not installed.');
}

function powershellExecutable(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
async function compileHelper(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const sourcePath = await resolveHelperSource();
    const source = await fs.readFile(sourcePath);
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 20);
    const target = path.join(HELPER_CACHE_DIR, `windows-job-wrapper-${hash}.exe`);
    if (await existingFile(target)) return target;

    await fs.mkdir(HELPER_CACHE_DIR, { recursive: true });
    const temporary = path.join(
      HELPER_CACHE_DIR,
      `.windows-job-wrapper-${hash}-${process.pid}-${randomUUID()}.exe`,
    );
    const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const script = [
      "$ErrorActionPreference='Stop'",
      `Add-Type -Path ${psQuote(sourcePath)} -OutputAssembly ${psQuote(temporary)} -OutputType ConsoleApplication`,
    ].join('; ');
    const result = await runBoundedSubprocess(
      powershellExecutable(),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: COMPILE_TIMEOUT_MS, maxOutputBytes: 256 * 1024, label: 'Compile Windows Job helper' },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Windows Job helper compiler exited ${result.exitCode}: ${result.stderr || result.stdout}`);
    }
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      if (await existingFile(target)) await fs.rm(temporary, { force: true });
      else throw error;
    }
    return target;
  } catch (error) {
    helperFailure = errorText(error);
    return null;
  }
}

export function getWindowsJobHelperFailure(): string | undefined {
  return helperFailure;
}

export async function getWindowsJobHelperPath(): Promise<string | null> {
  if (!helperPromise) helperPromise = compileHelper();
  return helperPromise;
}

function targetArguments(executable: string, args: string[], windowsVerbatim: boolean): string[] {
  return ['launch', ...(windowsVerbatim ? ['--verbatim'] : []), executable, ...args];
}
function parsePositivePid(text: string, prefix: string): number | null {
  if (!text.startsWith(prefix)) return null;
  const pid = Number(text.slice(prefix.length).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function waitForTargetPid(
  child: ChildProcessWithoutNullStreams,
  filteredStderr: PassThrough,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let timer: NodeJS.Timeout | undefined;
    const finish = (pid?: number, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(pid!);
    };
    const fail = (error: Error) => finish(undefined, error);
    timer = setTimeout(() => {
      fail(new Error(`Windows Job helper did not publish target PID within ${HELPER_CONTROL_TIMEOUT_MS}ms.`));
    }, HELPER_CONTROL_TIMEOUT_MS);
    timer.unref?.();
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) {
        filteredStderr.write(chunk);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > CONTROL_MAX_BYTES) {
        fail(new Error('Windows Job helper control line exceeded its bound.'));
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      const remainder = buffer.subarray(newline + 1);
      const pid = parsePositivePid(line, TARGET_PID_PREFIX);
      if (pid !== null) {
        if (remainder.length > 0) filteredStderr.write(remainder);
        finish(pid);
        return;
      }
      if (line.startsWith(ERROR_PREFIX)) {
        fail(new Error(line.slice(ERROR_PREFIX.length).trim() || 'Windows Job helper failed.'));
        return;
      }
      fail(new Error(`Unexpected Windows Job helper control line: ${line.slice(0, 256)}`));
    });
    child.stderr.on('end', () => {
      filteredStderr.end();
      if (!settled) fail(new Error('Windows Job helper exited before publishing target PID.'));
    });
    child.on('error', (error) => fail(error));
    child.on('close', (code) => {
      if (!settled) fail(new Error(`Windows Job helper exited ${code ?? 'null'} before target startup.`));
    });
  });
}
export async function spawnWindowsJobOwnedProcess(
  executable: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
  windowsVerbatim = false,
): Promise<WindowsJobOwnedProcess | null> {
  if (process.platform !== 'win32') return null;
  const helper = await getWindowsJobHelperPath();
  if (!helper) return null;
  const child = spawn(helper, targetArguments(executable, args, windowsVerbatim), {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const filteredStderr = new PassThrough();
  try {
    const pid = await waitForTargetPid(child, filteredStderr);
    return { process: child, pid, stdout: child.stdout, stderr: filteredStderr, owner: 'windows_job' };
  } catch (error) {
    helperFailure = errorText(error);
    try { child.kill('SIGKILL'); } catch {}
    return null;
  }
}

export async function terminateWindowsJobOwnedProcess(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = HELPER_EXIT_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`Windows Job helper did not exit within ${timeoutMs}ms.`)),
      Math.max(100, timeoutMs),
    );
    child.once('close', () => finish());
    child.once('error', (error) => finish(error));
    try {
      if (!child.kill('SIGKILL') && child.exitCode === null) {
        finish(new Error('Failed to terminate Windows Job helper.'));
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export interface WindowsJobAttachment {
  helper: ChildProcess;
  pid: number;
}

async function waitForAttachment(child: ChildProcess, expectedPid: number): Promise<void> {
  if (!child.stdout || !child.stderr) throw new Error('Windows Job attach helper did not expose control pipes.');
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const fail = (error: Error) => finish(error);
    timer = setTimeout(() => {
      fail(new Error(`Windows Job attach helper did not acknowledge PID ${expectedPid} within ${HELPER_CONTROL_TIMEOUT_MS}ms.`));
    }, HELPER_CONTROL_TIMEOUT_MS);
    timer.unref?.();
    stderrStream.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-CONTROL_MAX_BYTES);
    });
    stdoutStream.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > CONTROL_MAX_BYTES) {
        fail(new Error('Windows Job attach control line exceeded its bound.'));
        return;
      }
      const newline = stdout.indexOf(10);
      if (newline < 0) return;
      const line = stdout.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      const pid = parsePositivePid(line, ATTACHED_PREFIX);
      if (pid !== expectedPid) {
        fail(new Error(`Unexpected Windows Job attach response: ${line.slice(0, 256)}`));
        return;
      }
      finish();
    });
    child.on('error', (error) => fail(error));
    child.on('close', (code) => {
      if (!settled) {
        fail(new Error(`Windows Job attach helper exited ${code ?? 'null'}: ${stderr.trim()}`));
      }
    });
  });
}

export async function attachProcessToWindowsJob(pid: number): Promise<WindowsJobAttachment | null> {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  const helper = await getWindowsJobHelperPath();
  if (!helper) return null;
  const child = spawn(helper, ['attach', String(pid)], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForAttachment(child, pid);
    return { helper: child, pid };
  } catch (error) {
    helperFailure = errorText(error);
    try { child.kill('SIGKILL'); } catch {}
    return null;
  }
}
