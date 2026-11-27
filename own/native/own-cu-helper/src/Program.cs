using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

namespace OwnCuHelper
{
    // own-cu-helper: the Windows side of own.computer-use. One JSON object per line on stdin, one answer per request on
    // stdout in request order, unsolicited {event} lines for the stop chord and display changes. README.md is the wire
    // contract; packages/own-computer-use/src/driver/windows/protocol.ts is its TS mirror.
    internal static class Program
    {
        public const string Name = "own-cu-helper";
        public const string Version = "0.1.0";
        public const int Protocol = 1;

        // One helper drives the desktop at a time, also across a dev and a prod service of the same user.
        const string MutexName = @"Local\own-open-code-computer-use";
        const int MaxRequestChars = 1 << 20;
        const int FocusTimeoutMs = 3000;

        static readonly object OutputLock = new object();
        static TextWriter output;
        static Mutex mutex;
        static bool owned;

        static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--version")
            {
                Console.Out.WriteLine(Name + " " + Version + " (protocol " + Protocol + ")");
                return 0;
            }
            // The manifest already asks for Per-Monitor-V2; this covers hosts that ignore it. Fails harmlessly when set.
            Native.SetProcessDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            mutex = new Mutex(false, MutexName);
            owned = TryOwn();
            Ui.Start();
            try
            {
                string line;
                while ((line = input.ReadLine()) != null)
                {
                    if (line.Trim().Length == 0) continue;
                    Write(Handle(line));
                }
            }
            catch (IOException)
            {
                // stdout is gone (the server died): fall through and let go of the desktop.
            }
            // stdin EOF: nothing may stay pressed after the helper is gone.
            Input.ReleaseAll();
            Ui.Stop();
            if (owned) mutex.ReleaseMutex();
            return 0;
        }

        public static Dictionary<string, object> Ok()
        {
            var result = new Dictionary<string, object>();
            result["ok"] = true;
            return result;
        }

        public static void Emit(string name)
        {
            var line = new Dictionary<string, object>();
            line["event"] = name;
            try
            {
                Write(line);
            }
            catch (IOException)
            {
            }
        }

        static void Write(Dictionary<string, object> value)
        {
            var text = Json.Write(value);
            lock (OutputLock)
            {
                output.Write(text);
                output.Write('\n');
                output.Flush();
            }
        }

        static Dictionary<string, object> Handle(string line)
        {
            var request = line.Length > MaxRequestChars ? null : Json.Parse(line);
            if (request == null) return Failure("bad_request", "a request is one JSON object per line");
            object rid;
            request.TryGetValue("rid", out rid);
            object op;
            request.TryGetValue("op", out op);
            Dictionary<string, object> result;
            try
            {
                result = Dispatch(op as string, new Args(request));
            }
            catch (RequestException error)
            {
                result = Failure(error.Code, error.Message);
            }
            catch (Exception error)
            {
                result = Failure("failed", error.GetType().Name + ": " + error.Message);
            }
            if (rid != null) result["rid"] = rid;
            return result;
        }

        static Dictionary<string, object> Dispatch(string op, Args args)
        {
            if (op == "hello")
            {
                // The TS gate asks hello before input to see whether the stop chord works: take a free desktop and retry
                // the chord here, so it recovers once another program (or helper) lets go of it.
                if (!owned) owned = TryOwn();
                if (owned) Ui.EnsureHotKey();
                return Hello();
            }
            if (op == null) throw new RequestException("bad_request", "op is missing");
            if (!Known(op)) throw new RequestException("unknown_op", "unknown op " + op);
            if (!owned)
            {
                owned = TryOwn();
                if (!owned) throw new RequestException("busy", "another own-cu-helper is driving this desktop");
                Ui.EnsureHotKey();
            }
            switch (op)
            {
                case "displays":
                    return Screens.Displays();
                case "capture":
                    return Screens.Capture(args);
                case "cursor.get":
                    return Cursor();
                case "mouse.move":
                    Input.Move(args.Int("x", int.MinValue, int.MaxValue), args.Int("y", int.MinValue, int.MaxValue));
                    return Ok();
                case "mouse.button":
                    Input.Button(args.OneOf("button", "left", "right", "middle"), args.OneOf("action", "down", "up"));
                    return Ok();
                case "mouse.wheel":
                    Input.Wheel(args.Int("dx", -100, 100), args.Int("dy", -100, 100));
                    return Ok();
                case "key":
                    Input.Key(args.Int("vk", 1, 254), args.Bool("extended", false), args.OneOf("action", "down", "up"));
                    return Ok();
                case "text":
                    Input.Text(args.String("text"));
                    return Ok();
                case "window.at":
                    return TopWindows.At(args);
                case "window.foreground":
                    return TopWindows.Foreground();
                case "windows.list":
                    return TopWindows.List();
                case "window.focus":
                    var hwnd = TopWindows.Parse(args.String("id"));
                    Screens.RequireInput();
                    Ui.Run(delegate() { TopWindows.Focus(hwnd); });
                    return Ok();
                case "focus.element":
                    return Uia.Focused(FocusTimeoutMs);
                case "release.all":
                    Input.ReleaseAll();
                    return Ok();
                default:
                    Ui.Indicate(args.Bool("on", false), args.Has("text") ? args.String("text") : null);
                    return Ok();
            }
        }

        static bool Known(string op)
        {
            switch (op)
            {
                case "displays":
                case "capture":
                case "cursor.get":
                case "mouse.move":
                case "mouse.button":
                case "mouse.wheel":
                case "key":
                case "text":
                case "window.at":
                case "window.foreground":
                case "windows.list":
                case "window.focus":
                case "focus.element":
                case "release.all":
                case "indicator":
                    return true;
                default:
                    return false;
            }
        }

        static Dictionary<string, object> Hello()
        {
            var result = Ok();
            result["name"] = Name;
            result["version"] = Version;
            result["protocol"] = Protocol;
            result["dpiAwareness"] = Awareness();
            result["interactive"] = Screens.Interactive();
            result["inputDesktop"] = Screens.Usable();
            result["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
            result["killChord"] = Ui.HotKeyRegistered;
            return result;
        }

        static Dictionary<string, object> Cursor()
        {
            Native.POINT point;
            if (!Native.GetCursorPos(out point)) throw new RequestException("desktop_unavailable", Screens.Unavailable);
            var result = Ok();
            result["x"] = point.X;
            result["y"] = point.Y;
            return result;
        }

        static string Awareness()
        {
            var context = Native.GetThreadDpiAwarenessContext();
            if (Native.AreDpiAwarenessContextsEqual(context, Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return "per_monitor_v2";
            if (Native.AreDpiAwarenessContextsEqual(context, Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE)) return "per_monitor";
            if (Native.AreDpiAwarenessContextsEqual(context, Native.DPI_AWARENESS_CONTEXT_SYSTEM_AWARE)) return "system";
            if (Native.AreDpiAwarenessContextsEqual(context, Native.DPI_AWARENESS_CONTEXT_UNAWARE)) return "unaware";
            return "unknown";
        }

        static Dictionary<string, object> Failure(string code, string message)
        {
            var result = new Dictionary<string, object>();
            result["ok"] = false;
            result["error"] = code;
            result["message"] = message;
            return result;
        }

        static bool TryOwn()
        {
            try
            {
                return mutex.WaitOne(0);
            }
            catch (AbandonedMutexException)
            {
                return true;
            }
        }
    }
}
