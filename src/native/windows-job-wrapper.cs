using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WindowsJobWrapper
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const short SW_HIDE = 0;
    private const uint INFINITE = 0xffffffff;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_SET_QUOTA = 0x0100;
    private const uint SYNCHRONIZE = 0x00100000;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int JobObjectBasicAccountingInformation = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength, IntPtr lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(
        IntPtr hSourceProcessHandle,
        IntPtr hSourceHandle,
        IntPtr hTargetProcessHandle,
        out IntPtr lpTargetHandle,
        uint dwDesiredAccess,
        bool bInheritHandle,
        uint dwOptions);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    private static Exception Win32Failure(string action)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), action);
    }

    private static IntPtr DuplicateStandardHandle(int id)
    {
        IntPtr source = GetStdHandle(id);
        if (source == IntPtr.Zero || source == new IntPtr(-1)) return IntPtr.Zero;
        IntPtr current = GetCurrentProcess();
        IntPtr duplicate;
        if (!DuplicateHandle(current, source, current, out duplicate, 0, true, DUPLICATE_SAME_ACCESS))
            throw Win32Failure("DuplicateHandle");
        return duplicate;
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw Win32Failure("CreateJobObject");
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)size))
                throw Win32Failure("SetInformationJobObject");
            return job;
        }
        catch { CloseHandle(job); throw; }
        finally { Marshal.FreeHGlobal(ptr); }
    }

    private static string QuoteWindowsArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return value;
        var result = new StringBuilder();
        result.Append('"');
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            if (slashes > 0) result.Append('\\', slashes);
            slashes = 0;
            result.Append(ch);
        }
        if (slashes > 0) result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static string BuildCommandLine(string executable, IList<string> args, bool verbatim)
    {
        var result = new StringBuilder(QuoteWindowsArgument(executable));
        foreach (string arg in args) {
            result.Append(' ');
            result.Append(verbatim ? arg : QuoteWindowsArgument(arg));
        }
        return result.ToString();
    }

    private static uint ActiveProcessCount(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(size);
        try {
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, ptr, (uint)size, IntPtr.Zero))
                throw Win32Failure("QueryInformationJobObject");
            var info = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
                ptr, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return info.ActiveProcesses;
        } finally { Marshal.FreeHGlobal(ptr); }
    }

    private static void WaitUntilJobEmpty(IntPtr job)
    {
        while (ActiveProcessCount(job) != 0) Thread.Sleep(25);
    }

    private static int RunLaunch(string[] args)
    {
        if (args.Length < 1) throw new ArgumentException("launch requires executable");
        bool verbatim = args[0] == "--verbatim";
        int executableIndex = verbatim ? 1 : 0;
        if (executableIndex >= args.Length) throw new ArgumentException("launch requires executable");
        string executable = args[executableIndex];
        var targetArgs = new List<string>();
        for (int i = executableIndex + 1; i < args.Length; i++) targetArgs.Add(args[i]);

        IntPtr job = IntPtr.Zero;
        IntPtr stdin = IntPtr.Zero;
        IntPtr stdout = IntPtr.Zero;
        IntPtr stderr = IntPtr.Zero;
        PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();
        try {
            job = CreateKillOnCloseJob();
            stdin = DuplicateStandardHandle(STD_INPUT_HANDLE);
            stdout = DuplicateStandardHandle(STD_OUTPUT_HANDLE);
            stderr = DuplicateStandardHandle(STD_ERROR_HANDLE);
            var startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
            startup.wShowWindow = SW_HIDE;
            startup.hStdInput = stdin;
            startup.hStdOutput = stdout;
            startup.hStdError = stderr;
            var commandLine = new StringBuilder(BuildCommandLine(executable, targetArgs, verbatim));
            if (!CreateProcess(
                executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED, IntPtr.Zero, null, ref startup, out processInfo))
                throw Win32Failure("CreateProcess");
            if (!AssignProcessToJobObject(job, processInfo.hProcess))
                throw Win32Failure("AssignProcessToJobObject");

            Console.Error.WriteLine("__DC_JOB_TARGET_PID__=" + processInfo.dwProcessId);
            Console.Error.Flush();
            if (ResumeThread(processInfo.hThread) == 0xffffffff)
                throw Win32Failure("ResumeThread");

            if (WaitForSingleObject(processInfo.hProcess, INFINITE) == 0xffffffff)
                throw Win32Failure("WaitForSingleObject(target)");
            uint exitCode;
            if (!GetExitCodeProcess(processInfo.hProcess, out exitCode))
                throw Win32Failure("GetExitCodeProcess");
            CloseHandle(processInfo.hThread); processInfo.hThread = IntPtr.Zero;
            CloseHandle(processInfo.hProcess); processInfo.hProcess = IntPtr.Zero;
            WaitUntilJobEmpty(job);
            return unchecked((int)exitCode);
        }
        catch {
            if (processInfo.hProcess != IntPtr.Zero) TerminateProcess(processInfo.hProcess, 125);
            throw;
        }
        finally {
            if (processInfo.hThread != IntPtr.Zero) CloseHandle(processInfo.hThread);
            if (processInfo.hProcess != IntPtr.Zero) CloseHandle(processInfo.hProcess);
            if (stdin != IntPtr.Zero) CloseHandle(stdin);
            if (stdout != IntPtr.Zero) CloseHandle(stdout);
            if (stderr != IntPtr.Zero) CloseHandle(stderr);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    private static int RunAttach(string[] args)
    {
        if (args.Length != 1) throw new ArgumentException("attach requires pid");
        uint pid;
        if (!UInt32.TryParse(args[0], out pid) || pid == 0)
            throw new ArgumentException("attach pid is invalid");
        IntPtr job = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        try {
            job = CreateKillOnCloseJob();
            process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE, false, pid);
            if (process == IntPtr.Zero) throw Win32Failure("OpenProcess");
            if (!AssignProcessToJobObject(job, process)) throw Win32Failure("AssignProcessToJobObject");
            Console.Out.WriteLine("__DC_JOB_ATTACHED__=" + pid);
            Console.Out.Flush();
            if (WaitForSingleObject(process, INFINITE) == 0xffffffff)
                throw Win32Failure("WaitForSingleObject(attached)");
            return 0;
        }
        finally {
            if (process != IntPtr.Zero) CloseHandle(process);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    public static int Main(string[] args)
    {
        try {
            if (args.Length < 1) throw new ArgumentException("mode is required");
            string mode = args[0];
            var rest = new string[args.Length - 1];
            Array.Copy(args, 1, rest, 0, rest.Length);
            if (mode == "launch") return RunLaunch(rest);
            if (mode == "attach") return RunAttach(rest);
            throw new ArgumentException("unknown mode: " + mode);
        }
        catch (Exception error) {
            Console.Error.WriteLine("__DC_JOB_ERROR__=" + error.Message);
            Console.Error.Flush();
            return 125;
        }
    }
}
