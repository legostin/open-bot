// open-bot tray app for Windows: keeps the hub running in the background with no console window, restarts it after a
// crash and offers Open / Start at login / Show log / Restart / Quit. The hub and everything it starts (plugins, brain
// CLIs) run inside a job object, so they end with the tray even if it is killed.
//   open-bot.exe               start the hub if needed and open the web UI
//   open-bot.exe --background  start the hub, no browser (the Run key at login)
//   open-bot.exe --quit        stop a running instance and wait for it (installer, uninstaller)
// Built with the C# 5 compiler of .NET Framework 4 that ships with Windows: no newer language features.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("open-bot")]
[assembly: System.Reflection.AssemblyProduct("open-bot")]

namespace OpenBot
{
    static class Program
    {
        const string MutexName = "Local\\open-bot-tray";
        const string OpenEventName = "Local\\open-bot-open";
        const string QuitEventName = "Local\\open-bot-quit";

        [STAThread]
        static int Main(string[] args)
        {
            bool quit = Array.IndexOf(args, "--quit") >= 0;
            bool background = Array.IndexOf(args, "--background") >= 0;
            bool created;
            using (var mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    // Another instance runs: ask it to open the UI (or to quit) and leave.
                    Signal(quit ? QuitEventName : OpenEventName);
                    if (quit) WaitForExit(mutex);
                    return 0;
                }
                if (quit) return 0;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                var events = new[] { new EventWaitHandle(false, EventResetMode.AutoReset, OpenEventName), new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName) };
                Application.Run(new TrayContext(!background, events[0], events[1]));
                mutex.ReleaseMutex();
            }
            return 0;
        }

        static void Signal(string name)
        {
            EventWaitHandle ev;
            if (EventWaitHandle.TryOpenExisting(name, out ev)) { ev.Set(); ev.Dispose(); }
        }

        /// <summary>The running instance holds the mutex until it is gone.</summary>
        static void WaitForExit(Mutex mutex)
        {
            try { if (mutex.WaitOne(30000)) mutex.ReleaseMutex(); }
            catch (AbandonedMutexException) { }
        }
    }

    sealed class TrayContext : ApplicationContext
    {
        readonly string appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        readonly string dataDir;
        readonly string logFile;
        readonly NotifyIcon icon;
        readonly ToolStripMenuItem autostartItem;
        readonly SynchronizationContext ui;
        readonly Job job = new Job();
        readonly object gate = new object();
        Process hub;
        StreamWriter log;
        bool quitting;
        bool portBusy;
        string busyPort = "";
        readonly List<DateTime> crashes = new List<DateTime>();
        System.Threading.Timer restartTimer;

        public TrayContext(bool openOnStart, EventWaitHandle openEvent, EventWaitHandle quitEvent)
        {
            ui = new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(ui);
            var env = Environment.GetEnvironmentVariable("OPENBOT_DATA_DIR");
            dataDir = string.IsNullOrEmpty(env) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "open-bot") : env;
            logFile = Path.Combine(dataDir, "logs", "hub.log");

            var menu = new ContextMenuStrip();
            var openItem = new ToolStripMenuItem(L.T("tray.open"), null, delegate { OpenUi(); });
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            autostartItem = new ToolStripMenuItem(L.T("tray.autostart"), null, delegate { ToggleAutostart(); });
            menu.Items.Add(openItem);
            menu.Items.Add(autostartItem);
            menu.Items.Add(new ToolStripMenuItem(L.T("tray.logs"), null, delegate { ShowLog(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem(L.T("tray.restart"), null, delegate { Restart(); }));
            menu.Items.Add(new ToolStripMenuItem(L.T("tray.quit"), null, delegate { Quit(); }));
            menu.Opening += delegate { autostartItem.Checked = Autostart.Enabled; };

            icon = new NotifyIcon();
            icon.Icon = LoadIcon();
            icon.Text = L.T("tray.starting");
            icon.ContextMenuStrip = menu;
            icon.DoubleClick += delegate { OpenUi(); };
            icon.Visible = true;

            ThreadPool.RegisterWaitForSingleObject(openEvent, delegate { ui.Post(delegate { OpenUi(); }, null); }, null, -1, false);
            ThreadPool.RegisterWaitForSingleObject(quitEvent, delegate { ui.Post(delegate { Quit(); }, null); }, null, -1, false);

            StartHub();
            if (openOnStart) OpenUi();
        }

        Icon LoadIcon()
        {
            var file = Path.Combine(appDir, "open-bot.ico");
            try { return new Icon(file, SystemInformation.SmallIconSize); }
            catch { return SystemIcons.Application; }
        }

        string NodeExe { get { return Path.Combine(appDir, "runtime", "node.exe"); } }
        string Launcher { get { return Path.Combine(appDir, "packaging", "desktop", "launch.mjs"); } }

        ProcessStartInfo NodeStart(string args)
        {
            var psi = new ProcessStartInfo(NodeExe, "--disable-warning=ExperimentalWarning \"" + Launcher + "\" " + args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = appDir;
            psi.EnvironmentVariables["OPENBOT_DATA_DIR"] = dataDir;
            return psi;
        }

        void OpenLog()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(logFile));
            try
            {
                var info = new FileInfo(logFile);
                if (info.Exists && info.Length > 5 * 1024 * 1024) File.Copy(logFile, logFile + ".1", true);
                log = new StreamWriter(logFile, !(info.Exists && info.Length > 5 * 1024 * 1024), new UTF8Encoding(false));
                log.AutoFlush = true;
            }
            catch (IOException) { log = null; }
        }

        void Log(string line)
        {
            lock (gate)
            {
                if (log == null) return;
                try { log.WriteLine(line); } catch (IOException) { }
            }
        }

        void StartHub()
        {
            if (!File.Exists(NodeExe) || !File.Exists(Launcher)) { Notify(L.T("tray.noRuntime"), ToolTipIcon.Error); return; }
            lock (gate)
            {
                if (hub != null) return;
                if (log == null) OpenLog();
                portBusy = false;
                var psi = NodeStart("run");
                psi.RedirectStandardInput = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                var p = new Process();
                p.StartInfo = psi;
                p.EnableRaisingEvents = true;
                p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Log(e.Data); };
                p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data == null) return;
                    Log(e.Data);
                    var i = e.Data.IndexOf("EADDRINUSE", StringComparison.Ordinal);
                    if (i >= 0) { portBusy = true; busyPort = PortOf(e.Data.Substring(i)); }
                };
                p.Exited += delegate { ui.Post(delegate { OnExit(p); }, null); };
                Log("[tray] " + DateTime.Now.ToString("s") + " starting the hub");
                p.Start();
                job.Add(p);
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                hub = p;
            }
            icon.Text = L.T("tray.running");
        }

        static string PortOf(string text)
        {
            var m = System.Text.RegularExpressions.Regex.Match(text, ":(\\d{2,5})");
            return m.Success ? m.Groups[1].Value : "";
        }

        void OnExit(Process p)
        {
            lock (gate) { if (hub != p) return; hub = null; }
            Log("[tray] the hub exited with code " + p.ExitCode);
            if (quitting) return;
            if (portBusy)
            {
                icon.Text = L.T("tray.tooltip");
                Notify(L.T("tray.portBusy", "port", busyPort), ToolTipIcon.Error);
                return;
            }
            var now = DateTime.Now;
            crashes.Add(now);
            crashes.RemoveAll(delegate(DateTime t) { return now - t > TimeSpan.FromMinutes(5); });
            if (crashes.Count >= 5)
            {
                icon.Text = L.T("tray.tooltip");
                Notify(L.T("tray.failed"), ToolTipIcon.Error);
                return;
            }
            icon.Text = L.T("tray.starting");
            if (crashes.Count > 1) Notify(L.T("tray.restarting"), ToolTipIcon.Warning);
            restartTimer = new System.Threading.Timer(delegate { ui.Post(delegate { StartHub(); }, null); }, null, 2000 * crashes.Count, Timeout.Infinite);
        }

        /// <summary>Asks the hub to stop (a "stop" line on its stdin), then ends whatever is left in the job.</summary>
        void StopHub()
        {
            Process p;
            lock (gate) { p = hub; hub = null; }
            if (p == null) return;
            try { p.StandardInput.WriteLine("stop"); p.StandardInput.Flush(); } catch (Exception) { }
            if (!p.WaitForExit(15000)) Log("[tray] the hub did not stop in time; ending it");
            job.Terminate();
        }

        void Restart()
        {
            crashes.Clear();
            icon.Text = L.T("tray.starting");
            StopHub();
            StartHub();
        }

        void OpenUi()
        {
            if (hub == null && !portBusy) StartHub();
            var worker = new Thread(delegate()
            {
                string url = null;
                try
                {
                    var psi = NodeStart("url");
                    psi.RedirectStandardOutput = true;
                    using (var p = Process.Start(psi))
                    {
                        url = p.StandardOutput.ReadLine();
                        p.WaitForExit(100000);
                    }
                }
                catch (Exception e) { Log("[tray] could not get the address: " + e.Message); }
                if (string.IsNullOrEmpty(url) || !url.StartsWith("http://localhost:", StringComparison.Ordinal)) url = "http://localhost:8080/";
                try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
                catch (Exception e) { Log("[tray] could not open the browser: " + e.Message); }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        void ToggleAutostart()
        {
            Autostart.Enabled = !Autostart.Enabled;
            autostartItem.Checked = Autostart.Enabled;
        }

        void ShowLog()
        {
            if (File.Exists(logFile)) Process.Start("explorer.exe", "/select,\"" + logFile + "\"");
            else if (Directory.Exists(dataDir)) Process.Start("explorer.exe", "\"" + dataDir + "\"");
        }

        void Notify(string text, ToolTipIcon kind)
        {
            icon.ShowBalloonTip(10000, "open-bot", text, kind);
        }

        void Quit()
        {
            if (quitting) return;
            quitting = true;
            if (restartTimer != null) restartTimer.Dispose();
            icon.Text = L.T("tray.tooltip");
            StopHub();
            icon.Visible = false;
            icon.Dispose();
            lock (gate) { if (log != null) { log.Dispose(); log = null; } }
            ExitThread();
        }
    }

    /// <summary>The HKCU Run value the installer writes ("Start open-bot when I sign in").</summary>
    static class Autostart
    {
        const string Key = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        const string Name = "open-bot";

        public static bool Enabled
        {
            get
            {
                using (var k = Registry.CurrentUser.OpenSubKey(Key)) return k != null && k.GetValue(Name) != null;
            }
            set
            {
                using (var k = Registry.CurrentUser.CreateSubKey(Key))
                {
                    if (value) k.SetValue(Name, "\"" + Application.ExecutablePath + "\" --background");
                    else k.DeleteValue(Name, false);
                }
            }
        }
    }

    /// <summary>A job object that kills every process in it when the last handle closes (the tray exits or dies).</summary>
    sealed class Job
    {
        readonly IntPtr handle;

        public Job()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                if (!SetInformationJobObject(handle, 9, ptr, (uint)size)) throw new Win32Exception(); // JobObjectExtendedLimitInformation
            }
            finally { Marshal.FreeHGlobal(ptr); }
        }

        public void Add(Process p)
        {
            AssignProcessToJobObject(handle, p.Handle);
        }

        public void Terminate()
        {
            TerminateJobObject(handle, 1);
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
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
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    }
}
