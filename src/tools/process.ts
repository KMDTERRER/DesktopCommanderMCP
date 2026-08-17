import os from 'os';
import path from 'path';
import { ProcessInfo, ServerResult } from '../types.js';
import { KillProcessArgsSchema } from './schemas.js';
import { runBoundedSubprocess } from '../utils/bounded-subprocess.js';

const PROCESS_LIST_TIMEOUT_MS = 5_000;
const PROCESS_LIST_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function parseWindowsProcesses(stdout: string): ProcessInfo[] {
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes: ProcessInfo[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const pid = Number(row.Id);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const cpuSeconds = typeof row.CPU === 'number' && Number.isFinite(row.CPU) ? row.CPU : null;
    const workingSetBytes = typeof row.WorkingSet64 === 'number' && Number.isFinite(row.WorkingSet64)
      ? row.WorkingSet64 : null;
    processes.push({
      pid,
      command: typeof row.ProcessName === 'string' && row.ProcessName ? row.ProcessName : '-',
      cpu: cpuSeconds === null ? '-' : `${cpuSeconds.toFixed(2)}s`,
      memory: workingSetBytes === null ? '-' : `${Math.round(workingSetBytes / 1024)} KiB`,
    });
  }
  return processes;
}

function parsePosixProcesses(stdout: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    processes.push({ pid: Number(match[1]), cpu: match[2], memory: match[3], command: match[4] });
  }
  return processes;
}

export async function listProcesses(): Promise<ServerResult> {
  try {
    const windows = os.platform() === 'win32';
    const windowsPowerShell = path.join(
      process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    const windowsScript = [
      '$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);',
      'Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Compress',
    ].join(' ');
    const result = await runBoundedSubprocess(
      windows ? windowsPowerShell : 'ps',
      windows ? ['-NoProfile', '-NonInteractive', '-Command', windowsScript] : ['-eo', 'pid=,pcpu=,rss=,comm='],
      { timeoutMs: PROCESS_LIST_TIMEOUT_MS, maxOutputBytes: PROCESS_LIST_MAX_OUTPUT_BYTES, label: 'process listing' },
    );
    if (result.exitCode !== 0) {
      throw new Error(`process listing exited with code ${result.exitCode}: ${result.stderr.trim()}`);
    }
    const processes = windows ? parseWindowsProcesses(result.stdout) : parsePosixProcesses(result.stdout);
    return {
      content: [{
        type: "text",
        text: processes.length > 0
          ? processes.map(p => `PID: ${p.pid}, Command: ${p.command}, CPU: ${p.cpu}, Memory: ${p.memory}`).join('\n')
          : 'No processes found',
      }],
      structuredContent: { processes },
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: Failed to list processes: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function killProcess(args: unknown): Promise<ServerResult> {
  const parsed = KillProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for kill_process: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    if (os.platform() === 'win32') {
      const result = await runBoundedSubprocess(
        'taskkill.exe', ['/PID', String(parsed.data.pid), '/T', '/F'],
        { timeoutMs: 5_000, maxOutputBytes: 256 * 1024, label: `terminate process tree ${parsed.data.pid}` },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `taskkill exited ${result.exitCode}`);
    } else {
      process.kill(parsed.data.pid);
    }
    return {
      content: [{ type: "text", text: `Successfully terminated process ${parsed.data.pid}` }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: Failed to kill process: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}
