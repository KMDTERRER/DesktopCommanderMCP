import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';

import { terminateProcessTree } from './process-tree.js';

export interface WindowsFileLocker {
  pid: number;
  appName: string;
  serviceName: string;
  applicationType: string;
  restartable: boolean;
}

const WINDOWS_FILE_LOCK_CONCURRENCY = 4;
const WINDOWS_FILE_LOCK_MAX_WAITERS = 64;
let activeFileLockProbes = 0;
type FileLockProbeWaiter = { resolve: (release: (() => void) | null) => void; timer: NodeJS.Timeout };
const fileLockProbeWaiters: FileLockProbeWaiter[] = [];

function makeFileLockProbeRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeFileLockProbes = Math.max(0, activeFileLockProbes - 1);
    const waiter = fileLockProbeWaiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    activeFileLockProbes += 1;
    waiter.resolve(makeFileLockProbeRelease());
  };
}

function acquireFileLockProbe(deadlineAt: number): Promise<(() => void) | null> {
  if (activeFileLockProbes < WINDOWS_FILE_LOCK_CONCURRENCY) {
    activeFileLockProbes += 1;
    return Promise.resolve(makeFileLockProbeRelease());
  }
  if (fileLockProbeWaiters.length >= WINDOWS_FILE_LOCK_MAX_WAITERS) return Promise.resolve(null);
  const waitMs = deadlineAt - Date.now();
  if (waitMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiter = {} as FileLockProbeWaiter;
    waiter.resolve = resolve;
    waiter.timer = setTimeout(() => {
      const index = fileLockProbeWaiters.indexOf(waiter);
      if (index >= 0) fileLockProbeWaiters.splice(index, 1);
      resolve(null);
    }, waitMs);
    waiter.timer.unref?.();
    fileLockProbeWaiters.push(waiter);
  });
}

const RESTART_MANAGER_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class DesktopCommanderRestartManager {
    const int SessionKeyChars = 32;
    const int MaxAppName = 255;
    const int MaxServiceName = 63;
    const int ErrorMoreData = 234;

    [StructLayout(LayoutKind.Sequential)]
    struct UniqueProcess {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    enum AppType {
        Unknown = 0, MainWindow = 1, OtherWindow = 2,
        Service = 3, Explorer = 4, Console = 5, Critical = 1000
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessInfo {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MaxAppName + 1)]
        public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MaxServiceName + 1)]
        public string ServiceShortName;
        public AppType ApplicationType;
        public uint AppStatus;
        public uint SessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint handle);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint handle, uint fileCount, string[] files,
        uint appCount, IntPtr apps, uint serviceCount, string[] services);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint handle, out uint needed, ref uint count,
        [In, Out] ProcessInfo[] info, ref uint rebootReasons);

    public static string[] GetLockers(string file) {
        uint handle;
        var key = new StringBuilder(SessionKeyChars + 1);
        int rc = RmStartSession(out handle, 0, key);
        if (rc != 0) return Array.Empty<string>();
        try {
            rc = RmRegisterResources(handle, 1, new[] { file }, 0, IntPtr.Zero, 0, null);
            if (rc != 0) return Array.Empty<string>();
            uint needed = 0, count = 0, rebootReasons = 0;
            ProcessInfo[] info = null;
            int retries = 0;
            while (true) {
                count = info == null ? 0u : (uint)info.Length;
                rc = RmGetList(handle, out needed, ref count, info, ref rebootReasons);
                if (rc == 0) break;
                if (rc != ErrorMoreData || needed == 0 || retries++ >= 3) return Array.Empty<string>();
                info = new ProcessInfo[needed];
            }
            if (info == null || count == 0) return Array.Empty<string>();

            var result = new List<string>();
            for (int i = 0; i < count; i++) {
                var app = (info[i].AppName ?? "").Replace("\t", " ");
                var service = (info[i].ServiceShortName ?? "").Replace("\t", " ");
                result.Add(info[i].Process.ProcessId + "\t" + app + "\t" + service + "\t" +
                    info[i].ApplicationType + "\t" + info[i].Restartable);
            }
            return result.ToArray();
        } finally { RmEndSession(handle); }
    }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[DesktopCommanderRestartManager]::GetLockers($env:DC_LOCK_TARGET)
`;

function parseLockers(stdout: string): WindowsFileLocker[] {
  const lockers: WindowsFileLocker[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [pidRaw, appName = '', serviceName = '', applicationType = '', restartableRaw = ''] = line.split('\t');
    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    lockers.push({
      pid,
      appName,
      serviceName,
      applicationType,
      restartable: restartableRaw.trim().toLowerCase() === 'true',
    });
  }
  return lockers;
}

export async function findWindowsFileLockers(
  filePath: string,
  timeoutMs = 1_500,
): Promise<WindowsFileLocker[]> {
  if (process.platform !== 'win32') return [];
  const boundedTimeout = Math.max(100, Math.min(5_000, Math.floor(timeoutMs)));
  const deadlineAt = Date.now() + boundedTimeout;
  const release = await acquireFileLockProbe(deadlineAt);
  if (!release || Date.now() >= deadlineAt) {
    release?.();
    return [];
  }

  return new Promise((resolve) => {
    let callerSettled = false;
    let physicalSettled = false;
    let terminating = false;
    let stdout = '';
    let outputBytes = 0;
    const decoder = new StringDecoder('utf8');
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', RESTART_MANAGER_SCRIPT,
      ], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DC_LOCK_TARGET: filePath },
      });
    } catch {
      release();
      resolve([]);
      return;
    }

    const releasePhysical = () => {
      if (physicalSettled) return;
      physicalSettled = true;
      release();
    };
    const finishCaller = (lockers: WindowsFileLocker[]) => {
      if (callerSettled) return;
      callerSettled = true;
      clearTimeout(timer);
      resolve(lockers);
    };
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      finishCaller([]);
      void terminateProcessTree(child).catch(() => { try { child.kill('SIGKILL'); } catch {} }).finally(releasePhysical);
    };

    const remainingMs = Math.max(1, deadlineAt - Date.now());
    const timer = setTimeout(terminate, remainingMs);
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) { terminate(); return; }
      stdout += decoder.write(chunk);
    });

    child.stderr.resume();
    child.on('error', () => {
      if (!terminating) { finishCaller([]); releasePhysical(); }
    });
    child.on('close', (code) => {
      stdout += decoder.end();
      if (terminating) return;
      finishCaller(code === 0 ? parseLockers(stdout) : []);
      releasePhysical();
    });
  });
}
