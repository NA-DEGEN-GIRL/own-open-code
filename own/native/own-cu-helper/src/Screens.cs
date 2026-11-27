using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace OwnCuHelper
{
    internal sealed class Monitor
    {
        public IntPtr Handle;
        public int Id;
        public bool Primary;
        public Rectangle Bounds;
        public double Scale;
        public string Name;
    }

    // Monitors, captures and the input-desktop check.
    internal static class Screens
    {
        // Ids are 0..n-1 with the primary first, then left to right and top to bottom, so they stay put while the
        // layout does (the TS side treats frames of another layout as stale anyway).
        public static List<Monitor> List()
        {
            var found = new List<Monitor>();
            Native.MonitorEnumProc callback = delegate(IntPtr handle, IntPtr hdc, ref Native.RECT rect, IntPtr data)
            {
                var info = new Native.MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX));
                if (!Native.GetMonitorInfo(handle, ref info)) return true;
                uint dpiX;
                uint dpiY;
                var scale = Native.GetDpiForMonitor(handle, Native.MDT_EFFECTIVE_DPI, out dpiX, out dpiY) == 0 ? dpiX / 96.0 : 1.0;
                found.Add(new Monitor
                {
                    Handle = handle,
                    Primary = (info.dwFlags & Native.MONITORINFOF_PRIMARY) != 0,
                    Bounds = Rectangle.FromLTRB(info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right, info.rcMonitor.Bottom),
                    Scale = scale,
                    Name = info.szDevice,
                });
                return true;
            };
            Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            found.Sort(delegate(Monitor a, Monitor b)
            {
                if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
                if (a.Bounds.X != b.Bounds.X) return a.Bounds.X.CompareTo(b.Bounds.X);
                return a.Bounds.Y.CompareTo(b.Bounds.Y);
            });
            for (var index = 0; index < found.Count; index++) found[index].Id = index;
            return found;
        }

        public static Dictionary<string, object> Displays()
        {
            var displays = new List<object>();
            foreach (var monitor in List())
            {
                var display = new Dictionary<string, object>();
                display["id"] = monitor.Id;
                display["primary"] = monitor.Primary;
                display["bounds"] = Rect(monitor.Bounds);
                display["scale"] = monitor.Scale;
                display["name"] = monitor.Name;
                displays.Add(display);
            }
            var result = Program.Ok();
            result["displays"] = displays;
            return result;
        }

        // A display (or a physical region of it, in virtual-desktop coordinates) at width x height, PNG or JPEG.
        public static Dictionary<string, object> Capture(Args args)
        {
            var id = args.Int("display", 0, 255);
            var monitor = List().Find(delegate(Monitor item) { return item.Id == id; });
            if (monitor == null) throw new RequestException("failed", "display " + id + " does not exist");
            var region = monitor.Bounds;
            if (args.Has("region"))
            {
                var value = args.Object("region");
                region = new Rectangle(
                    value.Int("x", int.MinValue, int.MaxValue),
                    value.Int("y", int.MinValue, int.MaxValue),
                    value.Int("width", 1, 65535),
                    value.Int("height", 1, 65535));
                if (!monitor.Bounds.Contains(region)) throw new RequestException("failed", "capture region leaves the display");
            }
            var width = args.Int("width", 1, 16384);
            var height = args.Int("height", 1, 16384);
            var format = args.OneOf("format", "png", "jpeg");
            var quality = args.Has("quality") ? args.Int("quality", 1, 100) : 85;
            RequireInput();
            byte[] data;
            using (var shot = new Bitmap(region.Width, region.Height, PixelFormat.Format24bppRgb))
            {
                Grab(shot, region);
                data = width == region.Width && height == region.Height ? Encode(shot, format, quality) : EncodeResized(shot, width, height, format, quality);
            }
            var result = Program.Ok();
            result["mime"] = format == "png" ? "image/png" : "image/jpeg";
            result["data"] = Convert.ToBase64String(data);
            result["width"] = width;
            result["height"] = height;
            Native.POINT cursor;
            if (Native.GetCursorPos(out cursor) && monitor.Bounds.Contains(cursor.X, cursor.Y)) result["cursor"] = Point(cursor.X, cursor.Y);
            return result;
        }

        public static void RequireInput()
        {
            if (!Usable()) throw new RequestException("desktop_unavailable", Unavailable);
        }

        public const string Unavailable = "the desktop is not taking input: the lock screen, UAC or Ctrl+Alt+Del is up, or the remote-desktop window showing it is minimized";

        // The desktop takes input and can be captured. The lock screen, UAC and Ctrl+Alt+Del move the input to Winlogon or
        // a secure desktop that a normal process cannot open. A remote-desktop session whose client window is minimized
        // keeps the Default desktop but stops rendering: GetCursorPos and screen reads fail with access denied there.
        public static bool Usable()
        {
            var desktop = Native.OpenInputDesktop(0, false, Native.DESKTOP_READOBJECTS);
            if (desktop == IntPtr.Zero) return false;
            try
            {
                Native.POINT cursor;
                return ObjectName(desktop) == "Default" && Native.GetCursorPos(out cursor);
            }
            finally
            {
                Native.CloseDesktop(desktop);
            }
        }

        // The helper runs on the interactive window station, so its input and captures reach the user's desktop.
        public static bool Interactive()
        {
            return ObjectName(Native.GetProcessWindowStation()) == "WinSta0";
        }

        public static Dictionary<string, object> Rect(Rectangle rect)
        {
            var value = new Dictionary<string, object>();
            value["x"] = rect.X;
            value["y"] = rect.Y;
            value["width"] = rect.Width;
            value["height"] = rect.Height;
            return value;
        }

        public static Dictionary<string, object> Point(int x, int y)
        {
            var value = new Dictionary<string, object>();
            value["x"] = x;
            value["y"] = y;
            return value;
        }

        static string ObjectName(IntPtr handle)
        {
            var name = new StringBuilder(256);
            int needed;
            return handle != IntPtr.Zero && Native.GetUserObjectInformation(handle, Native.UOI_NAME, name, name.Capacity * 2, out needed) ? name.ToString() : "";
        }

        // BitBlt from the screen DC with CAPTUREBLT, which includes layered windows (Graphics.CopyFromScreen rejects that
        // flag combination as an undefined enum value). Reading the screen fails while a secure desktop has the input.
        static void Grab(Bitmap target, Rectangle region)
        {
            var screen = Native.GetDC(IntPtr.Zero);
            if (screen == IntPtr.Zero) throw Unreadable(0);
            try
            {
                using (var graphics = Graphics.FromImage(target))
                {
                    var hdc = graphics.GetHdc();
                    try
                    {
                        if (!Native.BitBlt(hdc, 0, 0, region.Width, region.Height, screen, region.X, region.Y, Native.SRCCOPY | Native.CAPTUREBLT))
                            throw Unreadable(Marshal.GetLastWin32Error());
                    }
                    finally
                    {
                        graphics.ReleaseHdc(hdc);
                    }
                }
            }
            finally
            {
                Native.ReleaseDC(IntPtr.Zero, screen);
            }
        }

        static RequestException Unreadable(int code)
        {
            if (!Usable()) return new RequestException("desktop_unavailable", Unavailable);
            return new RequestException("failed", "screen capture failed: " + new Win32Exception(code).Message);
        }

        static byte[] EncodeResized(Bitmap source, int width, int height, string format, int quality)
        {
            using (var target = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                using (var graphics = Graphics.FromImage(target))
                using (var attributes = new ImageAttributes())
                {
                    graphics.CompositingMode = CompositingMode.SourceCopy;
                    graphics.CompositingQuality = CompositingQuality.HighQuality;
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    graphics.SmoothingMode = SmoothingMode.None;
                    // Without it the bicubic filter blends a dark halo into the image edges.
                    attributes.SetWrapMode(WrapMode.TileFlipXY);
                    graphics.DrawImage(source, new Rectangle(0, 0, width, height), 0, 0, source.Width, source.Height, GraphicsUnit.Pixel, attributes);
                }
                return Encode(target, format, quality);
            }
        }

        static byte[] Encode(Bitmap image, string format, int quality)
        {
            using (var stream = new MemoryStream())
            {
                if (format == "png") image.Save(stream, ImageFormat.Png);
                if (format == "jpeg")
                {
                    using (var parameters = new EncoderParameters(1))
                    {
                        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                        image.Save(stream, JpegCodec(), parameters);
                    }
                }
                return stream.ToArray();
            }
        }

        static ImageCodecInfo JpegCodec()
        {
            foreach (var codec in ImageCodecInfo.GetImageEncoders())
                if (codec.FormatID == ImageFormat.Jpeg.Guid) return codec;
            throw new RequestException("failed", "no JPEG encoder");
        }
    }
}
