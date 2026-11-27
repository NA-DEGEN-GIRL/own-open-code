using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

namespace OwnCuHelper
{
    // Top-level windows as the policy sees them (Policy.WindowInfo on the TS side). The helper's own windows (the
    // indicator and the hidden message window) are never reported.
    internal static class TopWindows
    {
        sealed class ProcessFacts
        {
            public string Exe;
            public bool Elevated;
        }

        sealed class Lookup
        {
            public List<Monitor> Monitors;
            public Dictionary<uint, ProcessFacts> Processes;
        }

        static readonly uint Self = (uint)Process.GetCurrentProcess().Id;

        public static Dictionary<string, object> List()
        {
            var lookup = NewLookup();
            var windows = new List<object>();
            // EnumWindows walks the z-order from the top, which is the order the protocol promises.
            Native.EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr data)
            {
                uint pid;
                Native.GetWindowThreadProcessId(hwnd, out pid);
                if (pid != Self && Native.IsWindowVisible(hwnd)) windows.Add(Info(hwnd, lookup));
                return true;
            };
            Native.EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            var result = Program.Ok();
            result["windows"] = windows;
            return result;
        }

        // The top-level window under a physical point. WindowFromPoint skips hidden, disabled and click-through windows,
        // so it is the window a click there reaches.
        public static Dictionary<string, object> At(Args args)
        {
            var point = new Native.POINT { X = args.Int("x", int.MinValue, int.MaxValue), Y = args.Int("y", int.MinValue, int.MaxValue) };
            return Answer(Native.GetAncestor(Native.WindowFromPoint(point), Native.GA_ROOT));
        }

        public static Dictionary<string, object> Foreground()
        {
            return Answer(Native.GetForegroundWindow());
        }

        // Brings a window to the foreground. Windows refuses SetForegroundWindow to a background process unless it
        // shares the foreground thread's input state, so the second attempt attaches to that thread first. Runs on the UI
        // thread, which has a message queue (AttachThreadInput needs one).
        public static void Focus(IntPtr hwnd)
        {
            if (!Native.IsWindow(hwnd)) throw new RequestException("unknown_window", "window " + Id(hwnd) + " does not exist");
            if (Native.IsIconic(hwnd)) Native.ShowWindow(hwnd, Native.SW_RESTORE);
            Native.SetForegroundWindow(hwnd);
            if (Settled(hwnd)) return;
            uint pid;
            var thread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid);
            var self = Native.GetCurrentThreadId();
            var attached = thread != 0 && thread != self && Native.AttachThreadInput(self, thread, true);
            try
            {
                Native.BringWindowToTop(hwnd);
                Native.SetForegroundWindow(hwnd);
            }
            finally
            {
                if (attached) Native.AttachThreadInput(self, thread, false);
            }
            if (!Settled(hwnd)) throw new RequestException("failed", "Windows kept another window in the foreground");
        }

        public static IntPtr Parse(string id)
        {
            long value;
            if (!id.StartsWith("0x", StringComparison.OrdinalIgnoreCase) || !long.TryParse(id.Substring(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out value))
                throw new RequestException("bad_request", "id must be a window id such as 0x1a2b");
            return new IntPtr(value);
        }

        static bool Settled(IntPtr hwnd)
        {
            for (var attempt = 0; attempt < 10; attempt++)
            {
                if (Native.GetForegroundWindow() == hwnd) return true;
                Thread.Sleep(20);
            }
            return false;
        }

        static Dictionary<string, object> Answer(IntPtr hwnd)
        {
            var result = Program.Ok();
            uint pid = 0;
            if (hwnd != IntPtr.Zero) Native.GetWindowThreadProcessId(hwnd, out pid);
            result["window"] = hwnd == IntPtr.Zero || pid == Self ? null : Info(hwnd, NewLookup());
            return result;
        }

        static Lookup NewLookup()
        {
            return new Lookup { Monitors = Screens.List(), Processes = new Dictionary<uint, ProcessFacts>() };
        }

        static Dictionary<string, object> Info(IntPtr hwnd, Lookup lookup)
        {
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            var facts = FactsOf(pid, lookup);
            // A UWP app's top-level window is a frame owned by ApplicationFrameHost.exe; the app itself runs in the process
            // of the frame's CoreWindow child, and that is the app the policy must judge. A frame without such a child (a
            // suspended or minimized app, whose CoreWindow Windows detaches) cannot be attributed: no exe, always denied.
            if (string.Equals(facts.Exe, "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase))
            {
                var app = HostedProcess(hwnd, pid);
                facts = app == 0 ? new ProcessFacts { Exe = "", Elevated = true } : FactsOf(app, lookup);
                if (app != 0) pid = app;
            }
            var title = new StringBuilder(512);
            Native.GetWindowText(hwnd, title, title.Capacity);
            var className = new StringBuilder(256);
            Native.GetClassName(hwnd, className, className.Capacity);
            var minimized = Native.IsIconic(hwnd);
            int cloaked;
            var info = new Dictionary<string, object>();
            info["id"] = Id(hwnd);
            info["pid"] = pid;
            info["exe"] = facts.Exe;
            info["title"] = title.ToString();
            info["className"] = className.ToString();
            info["bounds"] = Screens.Rect(Bounds(hwnd));
            var handle = minimized ? IntPtr.Zero : Native.MonitorFromWindow(hwnd, Native.MONITOR_DEFAULTTONULL);
            var monitor = handle == IntPtr.Zero ? null : lookup.Monitors.Find(delegate(Monitor item) { return item.Handle == handle; });
            if (monitor != null) info["displayId"] = monitor.Id;
            info["elevated"] = facts.Elevated;
            info["minimized"] = minimized;
            info["cloaked"] = Native.DwmGetWindowAttributeInt(hwnd, Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
            return info;
        }

        static ProcessFacts FactsOf(uint pid, Lookup lookup)
        {
            ProcessFacts facts;
            if (lookup.Processes.TryGetValue(pid, out facts)) return facts;
            facts = Facts(pid);
            lookup.Processes[pid] = facts;
            return facts;
        }

        // The process of the first descendant window of a UWP frame that another process owns (its CoreWindow), or 0.
        static uint HostedProcess(IntPtr frame, uint host)
        {
            uint found = 0;
            Native.EnumWindowsProc callback = delegate(IntPtr child, IntPtr data)
            {
                uint pid;
                Native.GetWindowThreadProcessId(child, out pid);
                if (pid == host || pid == 0) return true;
                found = pid;
                return false;
            };
            Native.EnumChildWindows(frame, callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return found;
        }

        // The visible frame (DWM extended frame bounds exclude the invisible resize borders), else the window rect.
        static Rectangle Bounds(IntPtr hwnd)
        {
            Native.RECT rect;
            if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out rect, 16) != 0) Native.GetWindowRect(hwnd, out rect);
            return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
        }

        // Fails closed: a process that cannot be queried has no exe (always denied) and one whose token cannot be read
        // counts as elevated.
        static ProcessFacts Facts(uint pid)
        {
            var facts = new ProcessFacts { Exe = "", Elevated = true };
            var process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return facts;
            try
            {
                var name = new StringBuilder(1024);
                var size = (uint)name.Capacity;
                if (Native.QueryFullProcessImageName(process, 0, name, ref size)) facts.Exe = Path.GetFileName(name.ToString(0, (int)size));
                IntPtr token;
                if (!Native.OpenProcessToken(process, Native.TOKEN_QUERY, out token)) return facts;
                try
                {
                    int elevation;
                    int needed;
                    if (Native.GetTokenInformation(token, Native.TokenElevation, out elevation, 4, out needed)) facts.Elevated = elevation != 0;
                }
                finally
                {
                    Native.CloseHandle(token);
                }
                return facts;
            }
            finally
            {
                Native.CloseHandle(process);
            }
        }

        static string Id(IntPtr hwnd)
        {
            return "0x" + hwnd.ToInt64().ToString("x", CultureInfo.InvariantCulture);
        }
    }
}
