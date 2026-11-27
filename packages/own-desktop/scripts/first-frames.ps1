<#
  Captures a shell window's first frames as Windows draws them (PrintWindow with PW_RENDERFULLCONTENT: the native
  background before the renderer paints, the page, and the window-controls overlay), to check a start for a light
  flash and for caption buttons that do not contrast with the background. Used by smoke.ts --first-frames.

    powershell -NoProfile -File first-frames.ps1 -Out <dir> [-DurationMs 6000] [-MaxSaved 30]

  Prints "ready" once compiled, then reads the process id from stdin (the caller spawns the shell after "ready", so
  the capture starts within milliseconds of the spawn) and polls that process's largest visible window until
  DurationMs after the id arrived. Every capture is measured; a frame is saved as PNG when it differs from the last
  saved one (plus the last capture), and contact-sheet.png shows the saved frames in order. Measures per capture
  inside the client area (luma 0-255, sRGB weights):
    content       below the caption band: mean luma and the share of light pixels (luma >= 160)
    caption       the right-hand 138 DIP x 44 DIP (the three window-control buttons): background luma (median) and
                  the luma of the pixel that differs most from it (the symbols: white ~255 or black ~0)
    center/corner the colors at the window center and just inside the top-left corner below the band
    dark          DWMWA_USE_IMMERSIVE_DARK_MODE of the window (Electron sets it from nativeTheme): 1, 0, or -1
  The last stdout line is a JSON summary; frames.json holds every capture.
#>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$DurationMs = 6000,
  [int]$MaxSaved = 30
)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OwnFrames {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  public class Stats {
    public long T; public int Width; public int Height; public double Scale; public int Dark;
    public double ContentLuma; public double ContentLight; public double MeanLuma;
    public int CaptionBg; public int CaptionSymbol; public string Center; public string Corner;
    public string Saved;
  }

  public static void DpiAware() {
    // Physical pixels (per-monitor v2), else system-aware like capture-window.ps1.
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
    SetProcessDPIAware();
  }

  /** JIT everything the loop runs, so the first capture is not late. */
  public static void WarmUp() {
    using (var bmp = new Bitmap(64, 64, PixelFormat.Format32bppArgb)) {
      var s = Analyze(bmp, new Rectangle(0, 0, 64, 64), 1.0);
      Key(s);
      Json(s);
      using (var copy = (Bitmap)bmp.Clone()) { }
    }
    Find(0);
  }

  static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    long best = 0;
    EnumWindows(delegate (IntPtr hwnd, IntPtr lParam) {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner != pid || !IsWindowVisible(hwnd)) return true;
      RECT rect;
      GetWindowRect(hwnd, out rect);
      long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
      if (area > best) { best = area; found = hwnd; }
      return true;
    }, IntPtr.Zero);
    return best > 100 * 100 ? found : IntPtr.Zero;
  }

  static Rectangle ClientRect(IntPtr hwnd, RECT window) {
    RECT client;
    POINT origin = new POINT();
    if (!GetClientRect(hwnd, out client) || !ClientToScreen(hwnd, ref origin))
      return new Rectangle(0, 0, window.Right - window.Left, window.Bottom - window.Top);
    return new Rectangle(origin.X - window.Left, origin.Y - window.Top, client.Right, client.Bottom);
  }

  static int Luma(byte r, byte g, byte b) { return (int)Math.Round(0.2126 * r + 0.7152 * g + 0.0722 * b); }

  /** Measures inside `client` (the client area in window coordinates: the window rect adds DWM's border strip). */
  static Stats Analyze(Bitmap bmp, Rectangle client, double scale) {
    var s = new Stats { Width = bmp.Width, Height = bmp.Height, Scale = scale, Dark = -1 };
    client.Intersect(new Rectangle(0, 0, bmp.Width, bmp.Height));
    if (client.Width <= 0 || client.Height <= 0) client = new Rectangle(0, 0, bmp.Width, bmp.Height);
    int w = client.Width, h = client.Height, ox = client.X, oy = client.Y;
    var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      int stride = data.Stride;
      var bytes = new byte[stride * bmp.Height];
      Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
      Func<int, int, int> at = (x, y) => (oy + y) * stride + (ox + x) * 4;
      int band = Math.Min(h, (int)Math.Round(44 * scale));
      long sum = 0, all = 0, n = 0, na = 0, light = 0;
      for (int y = 0; y < h; y += 4) for (int x = 0; x < w; x += 4) {
        int i = at(x, y);
        int l = Luma(bytes[i + 2], bytes[i + 1], bytes[i]);
        all += l; na++;
        if (y < band) continue;
        sum += l; n++;
        if (l >= 160) light++;
      }
      s.MeanLuma = na > 0 ? (double)all / na : 0;
      s.ContentLuma = n > 0 ? (double)sum / n : 0;
      s.ContentLight = n > 0 ? (double)light / n : 0;
      int left = Math.Max(0, w - (int)Math.Round(138 * scale));
      var lumas = new List<int>();
      for (int y = 0; y < band; y++) for (int x = left; x < w; x++) {
        int i = at(x, y);
        lumas.Add(Luma(bytes[i + 2], bytes[i + 1], bytes[i]));
      }
      if (lumas.Count > 0) {
        var sorted = new List<int>(lumas);
        sorted.Sort();
        s.CaptionBg = sorted[sorted.Count / 2];
        int far = s.CaptionBg;
        foreach (int l in lumas) if (Math.Abs(l - s.CaptionBg) > Math.Abs(far - s.CaptionBg)) far = l;
        s.CaptionSymbol = far;
      }
      Func<int, int, string> hex = (x, y) => {
        int i = at(Math.Min(w - 1, Math.Max(0, x)), Math.Min(h - 1, Math.Max(0, y)));
        return string.Format("#{0:x2}{1:x2}{2:x2}", bytes[i + 2], bytes[i + 1], bytes[i]);
      };
      s.Center = hex(w / 2, h / 2);
      s.Corner = hex((int)Math.Round(8 * scale), band + (int)Math.Round(8 * scale));
    } finally {
      bmp.UnlockBits(data);
    }
    return s;
  }

  static string Key(Stats s) {
    return string.Format(CultureInfo.InvariantCulture, "{0:F0}|{1:F2}|{2}|{3}|{4}|{5}|{6}x{7}|{8}",
      s.ContentLuma, s.ContentLight, s.CaptionBg / 8, s.CaptionSymbol / 32, s.Center, s.Corner, s.Width, s.Height,
      s.Dark);
  }

  static string Json(Stats s) {
    return string.Format(CultureInfo.InvariantCulture,
      "{{\"t\":{0},\"w\":{1},\"h\":{2},\"dark\":{3},\"contentLuma\":{4:F1},\"contentLight\":{5:F3}," +
      "\"meanLuma\":{6:F1},\"captionBg\":{7},\"captionSymbol\":{8},\"center\":\"{9}\",\"corner\":\"{10}\"," +
      "\"saved\":{11}}}",
      s.T, s.Width, s.Height, s.Dark, s.ContentLuma, s.ContentLight, s.MeanLuma, s.CaptionBg, s.CaptionSymbol,
      s.Center, s.Corner, s.Saved == null ? "null" : "\"" + s.Saved + "\"");
  }

  public static string Run(uint pid, int durationMs, int maxSaved, string outDir) {
    Directory.CreateDirectory(outDir);
    var clock = Stopwatch.StartNew();
    var all = new List<Stats>();
    var kept = new List<KeyValuePair<Stats, Bitmap>>();
    string lastKey = null;
    long found = -1;
    Bitmap buffer = null;
    while (clock.ElapsedMilliseconds < durationMs) {
      IntPtr hwnd = Find(pid);
      if (hwnd == IntPtr.Zero) { Thread.Sleep(1); continue; }
      if (found < 0) found = clock.ElapsedMilliseconds;
      RECT rect;
      if (!GetWindowRect(hwnd, out rect)) continue;
      int w = rect.Right - rect.Left, h = rect.Bottom - rect.Top;
      if (w <= 0 || h <= 0) continue;
      if (buffer == null || buffer.Width != w || buffer.Height != h) {
        if (buffer != null) buffer.Dispose();
        buffer = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      }
      using (var g = Graphics.FromImage(buffer)) {
        IntPtr hdc = g.GetHdc();
        PrintWindow(hwnd, hdc, 2);
        g.ReleaseHdc(hdc);
      }
      long t = clock.ElapsedMilliseconds;
      uint dpi = 96;
      try { dpi = GetDpiForWindow(hwnd); } catch (Exception) { }
      var s = Analyze(buffer, ClientRect(hwnd, rect), (dpi == 0 ? 96 : dpi) / 96.0);
      int dark;
      if (DwmGetWindowAttribute(hwnd, 20, out dark, 4) == 0) s.Dark = dark != 0 ? 1 : 0;
      s.T = t;
      all.Add(s);
      string key = Key(s);
      if (key != lastKey && kept.Count < maxSaved - 1) {
        lastKey = key;
        kept.Add(new KeyValuePair<Stats, Bitmap>(s, (Bitmap)buffer.Clone()));
      }
    }
    Stats last = all.Count > 0 ? all[all.Count - 1] : null;
    if (last != null && buffer != null && (kept.Count == 0 || !object.ReferenceEquals(kept[kept.Count - 1].Key, last)))
      kept.Add(new KeyValuePair<Stats, Bitmap>(last, (Bitmap)buffer.Clone()));
    if (buffer != null) buffer.Dispose();
    for (int k = 0; k < kept.Count; k++) {
      var name = string.Format("frame-{0:D3}-{1:D5}ms.png", k, kept[k].Key.T);
      kept[k].Value.Save(Path.Combine(outDir, name), ImageFormat.Png);
      kept[k].Key.Saved = name;
    }
    string sheet = kept.Count > 0 ? ContactSheet(kept, Path.Combine(outDir, "contact-sheet.png")) : null;
    foreach (var pair in kept) pair.Value.Dispose();

    var frames = new StringBuilder("[\n");
    for (int k = 0; k < all.Count; k++) frames.Append(Json(all[k])).Append(k + 1 < all.Count ? ",\n" : "\n");
    frames.Append("]\n");
    File.WriteAllText(Path.Combine(outDir, "frames.json"), frames.ToString());

    double maxLight = 0, maxLuma = 0, minSymbolContrast = 255;
    int darkFrames = 0, lightFrames = 0;
    foreach (var s in all) {
      maxLight = Math.Max(maxLight, s.ContentLight);
      maxLuma = Math.Max(maxLuma, s.ContentLuma);
      minSymbolContrast = Math.Min(minSymbolContrast, Math.Abs(s.CaptionSymbol - s.CaptionBg));
      if (s.Dark == 1) darkFrames++;
      if (s.Dark == 0) lightFrames++;
    }
    Stats first = all.Count > 0 ? all[0] : null;
    return string.Format(CultureInfo.InvariantCulture,
      "{{\"pid\":{0},\"windowFoundMs\":{1},\"captures\":{2},\"lastT\":{3},\"saved\":{4},\"maxContentLuma\":{5:F1}," +
      "\"maxContentLight\":{6:F3},\"minCaptionContrast\":{7},\"immersiveDark\":{{\"dark\":{8},\"light\":{9}}}," +
      "\"first\":{10},\"last\":{11},\"contactSheet\":{12},\"framesJson\":\"{13}\"}}",
      pid, found, all.Count, last == null ? -1 : last.T, kept.Count, maxLuma, maxLight, (int)minSymbolContrast,
      darkFrames, lightFrames, first == null ? "null" : Json(first), last == null ? "null" : Json(last),
      sheet == null ? "null" : "\"" + sheet.Replace("\\", "\\\\") + "\"",
      Path.Combine(outDir, "frames.json").Replace("\\", "\\\\"));
  }

  static string ContactSheet(List<KeyValuePair<Stats, Bitmap>> kept, string file) {
    const int cols = 4, thumb = 400, label = 22, pad = 8;
    var first = kept[0].Value;
    int th = (int)Math.Round(thumb * (double)first.Height / first.Width);
    int rows = (kept.Count + cols - 1) / cols;
    using (var sheet = new Bitmap(cols * (thumb + pad) + pad, rows * (th + label + pad) + pad))
    using (var g = Graphics.FromImage(sheet))
    using (var font = new Font("Segoe UI", 9f))
    using (var ink = new SolidBrush(Color.Black))
    using (var frame = new Pen(Color.FromArgb(255, 255, 0, 255))) {
      g.Clear(Color.FromArgb(255, 128, 128, 128));
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
      for (int k = 0; k < kept.Count; k++) {
        int x = pad + (k % cols) * (thumb + pad), y = pad + (k / cols) * (th + label + pad);
        var s = kept[k].Key;
        g.DrawString(string.Format(CultureInfo.InvariantCulture,
          "{0} ms  luma {1:F0}  light {2:P0}  btn {3}/{4}  dark {5}",
          s.T, s.ContentLuma, s.ContentLight, s.CaptionSymbol, s.CaptionBg, s.Dark), font, ink, x, y + 2);
        g.DrawImage(kept[k].Value, new Rectangle(x, y + label, thumb, th));
        g.DrawRectangle(frame, x - 1, y + label - 1, thumb + 1, th + 1);
      }
      sheet.Save(file, ImageFormat.Png);
    }
    return file;
  }
}
'@

[OwnFrames]::DpiAware()
[OwnFrames]::WarmUp()
New-Item -ItemType Directory -Force -Path $Out | Out-Null
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
$line = [Console]::In.ReadLine()
$processId = 0
if (-not [uint32]::TryParse(($line + '').Trim(), [ref]$processId)) { throw "expected a process id on stdin, got '$line'" }
[Console]::Out.WriteLine([OwnFrames]::Run([uint32]$processId, $DurationMs, $MaxSaved, $Out))
