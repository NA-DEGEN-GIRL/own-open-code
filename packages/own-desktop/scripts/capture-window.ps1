<#
  Captures the top-level window of a process as PNG, including what the renderer screenshot cannot show: the
  Windows window-controls overlay and native views such as the browser pane (PrintWindow with
  PW_RENDERFULLCONTENT, so a covered or background window still renders). Used by smoke.ts --window-shot.

    powershell -NoProfile -File capture-window.ps1 -ProcessId <pid> -Out <file.png>
#>
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OwnCapture {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

# Physical pixels: a DPI-unaware PowerShell would get scaled-down rectangles and crop the capture.
[void][OwnCapture]::SetProcessDPIAware()

# Chromium's window belongs to the browser process; the pid given may be that process or its parent.
$pids = @($ProcessId) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" | ForEach-Object { [int]$_.ProcessId })
$found = [IntPtr]::Zero
$best = 0
$callback = [OwnCapture+EnumProc]{
  param($hwnd, $lParam)
  $owner = [uint32]0
  [void][OwnCapture]::GetWindowThreadProcessId($hwnd, [ref]$owner)
  if ($pids -contains [int]$owner -and [OwnCapture]::IsWindowVisible($hwnd)) {
    $rect = New-Object OwnCapture+RECT
    [void][OwnCapture]::GetWindowRect($hwnd, [ref]$rect)
    $area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)
    if ($area -gt $script:best) { $script:best = $area; $script:found = $hwnd }
  }
  return $true
}
[void][OwnCapture]::EnumWindows($callback, [IntPtr]::Zero)
if ($found -eq [IntPtr]::Zero) { throw "no visible window for process $ProcessId" }
$rect = New-Object OwnCapture+RECT
[void][OwnCapture]::GetWindowRect($found, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
[void][OwnCapture]::PrintWindow($found, $hdc, 2)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output "$Out ${width}x${height}"
