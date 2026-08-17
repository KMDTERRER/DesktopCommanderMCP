import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const WINDOWS_TREE_KILL_TIMEOUT_MS = 3_000;
const WINDOWS_TREE_PROBE_TIMEOUT_MS = 2_500;
const WINDOWS_TREE_PROBE_MAX_BYTES = 2 * 1024 * 1024;
const ROOT_CREATION_SKEW_MS = 2_000;
const ROOT_EXIT_CHILD_CREATION_GRACE_MS = 1_000;

export type ProcessTreeProbe = {
  certain: boolean;
  rootAlive: boolean;
  treeAlive: boolean;
  directDescendantPids: number[];
  descendantPids: number[];
  warning?: string;
};

type WindowsProcessRow = { pid: number; ppid: number; createdAtMs: number | null };

function processHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (processHasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once('close', finish);
  });
}

function parseWindowsCreationDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const dotNet = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(value);
  if (dotNet) return Number(dotNet[1]);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function windowsProcessRows(timeoutMs = WINDOWS_TREE_PROBE_TIMEOUT_MS): Promise<WindowsProcessRow[]> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        try {
          const parsed = stdout.trim() ? JSON.parse(stdout) : [];
          const values = Array.isArray(parsed) ? parsed : [parsed];
          resolve(values.map((item: any) => ({
            pid: Number(item?.ProcessId),
            ppid: Number(item?.ParentProcessId),
            createdAtMs: parseWindowsCreationDate(item?.CreationDate),
          })).filter((item) => Number.isInteger(item.pid) && item.pid > 0 && Number.isInteger(item.ppid)));
        } catch (parseError) {
          reject(new Error(`Unable to parse Windows process-tree snapshot: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
        }
      }
    };
    const append = (chunk: Buffer, target: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > WINDOWS_TREE_PROBE_MAX_BYTES) {
        try { child.kill('SIGKILL'); } catch {}
        finish(new Error('Windows process-tree snapshot exceeded its output limit.'));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code !== 0) finish(new Error(`Windows process-tree snapshot failed with exit code ${code}: ${stderr.trim()}`));
      else finish();
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(new Error(`Windows process-tree snapshot timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function probeProcessTree(
  rootPid: number,
  rootStartedAtMs: number,
  rootExitedAtMs?: number,
  ownsProcessGroup = false,
): Promise<ProcessTreeProbe> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { certain: false, rootAlive: false, treeAlive: false, directDescendantPids: [], descendantPids: [], warning: 'Invalid root PID.' };
  }
  if (process.platform !== 'win32') {
    const rootAlive = rootExitedAtMs === undefined && processExists(rootPid);
    if (ownsProcessGroup) {
      try {
        process.kill(-rootPid, 0);
        return { certain: true, rootAlive, treeAlive: true, directDescendantPids: [], descendantPids: [] };
      } catch {
        return { certain: true, rootAlive, treeAlive: rootAlive, directDescendantPids: [], descendantPids: [] };
      }
    }
    return { certain: true, rootAlive, treeAlive: rootAlive, directDescendantPids: [], descendantPids: [] };
  }

  try {
    const rows = await windowsProcessRows();
    const rootRow = rows.find((row) => row.pid === rootPid);
    const currentRootMatches = rootRow?.createdAtMs === null || rootRow?.createdAtMs === undefined
      ? false
      : Math.abs(rootRow.createdAtMs - rootStartedAtMs) <= ROOT_CREATION_SKEW_MS;
    const rootAlive = rootExitedAtMs === undefined && Boolean(rootRow && currentRootMatches);
    const byParent = new Map<number, WindowsProcessRow[]>();
    for (const row of rows) {
      const list = byParent.get(row.ppid) ?? [];
      list.push(row);
      byParent.set(row.ppid, list);
    }
    const direct = (byParent.get(rootPid) ?? []).filter((row) => {
      if (row.createdAtMs === null) return false;
      if (row.createdAtMs < rootStartedAtMs - ROOT_CREATION_SKEW_MS) return false;
      return rootExitedAtMs === undefined || row.createdAtMs <= rootExitedAtMs + ROOT_EXIT_CHILD_CREATION_GRACE_MS;
    });
    const descendants: WindowsProcessRow[] = [];
    const queue = [...direct];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current.pid)) continue;
      seen.add(current.pid);
      descendants.push(current);
      for (const child of byParent.get(current.pid) ?? []) {
        if (child.createdAtMs !== null && current.createdAtMs !== null && child.createdAtMs + ROOT_CREATION_SKEW_MS < current.createdAtMs) continue;
        queue.push(child);
      }
    }
    const descendantPids = descendants.map((row) => row.pid);
    return {
      certain: true,
      rootAlive,
      treeAlive: rootAlive || descendantPids.length > 0,
      directDescendantPids: direct.map((row) => row.pid),
      descendantPids,
    };
  } catch (error) {
    return {
      certain: false, rootAlive: rootExitedAtMs === undefined && processExists(rootPid), treeAlive: true,
      directDescendantPids: [], descendantPids: [],
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

async function terminateWindowsTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      killer.kill('SIGKILL');
      finish();
    }, WINDOWS_TREE_KILL_TIMEOUT_MS);
    timer.unref?.();
    killer.once('error', finish);
    killer.once('close', finish);
  });
}

export async function terminateProcessTree(
  child: ChildProcess,
  timeoutMs = WINDOWS_TREE_KILL_TIMEOUT_MS,
  ownsProcessGroup = false,
  rootStartedAtMs?: number,
  rootExitedAtMs?: number,
): Promise<void> {
  if (!child.pid) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    // taskkill /T is the cheap path while the root still exists. If it already
    // exited, probe the retained ParentProcessId tree and terminate its direct
    // surviving children instead of silently returning and orphaning them.
    await terminateWindowsTree(pid);
    if (rootStartedAtMs !== undefined) {
      const probe = await probeProcessTree(pid, rootStartedAtMs, rootExitedAtMs ?? (processHasExited(child) ? Date.now() : undefined));
      if (!probe.certain) throw new Error(`Unable to prove process-tree termination for PID ${pid}: ${probe.warning ?? 'unknown probe failure'}`);
      for (const childPid of probe.directDescendantPids) await terminateWindowsTree(childPid);
      const after = await probeProcessTree(pid, rootStartedAtMs, rootExitedAtMs ?? (processHasExited(child) ? Date.now() : undefined));
      if (after.certain && after.treeAlive) {
        throw new Error(`Process tree ${pid} still has living descendants: ${after.descendantPids.join(', ')}`);
      }
    }
  } else if (ownsProcessGroup) {
    try { process.kill(-pid, 'SIGKILL'); } catch { if (!processHasExited(child)) child.kill('SIGKILL'); }
  } else if (!processHasExited(child)) {
    child.kill('SIGKILL');
  }
  if (!processHasExited(child)) child.kill('SIGKILL');
  await waitForChildClose(child, timeoutMs);
}
