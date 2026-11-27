<#
  Waits for a native dialog (window class #32770, e.g. the folder picker FilesOpenDirectoryPicker opens) of the shell
  process, captures it as PNG and cancels it with WM_CLOSE, so the page's picker resolves as cancelled and nothing is
  chosen. Used by smoke.ts --capabilities. Prints one JSON line.

    powershell -NoProfile -File native-dialog.ps1 -ProcessId <pid> -Out <file.png> [-TimeoutSeconds 10]
#>
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$TimeoutSeconds = 10
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OwnDialog {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[void][OwnDialog]::SetProcessDPIAware()

$pids = @($ProcessId) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" | ForEach-Object { [int]$_.ProcessId })
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$found = [IntPtr]::Zero
while ($found -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
  $callback = [OwnDialog+EnumProc]{
    param($hwnd, $lParam)
    $owner = [uint32]0
    [void][OwnDialog]::GetWindowThreadProcessId($hwnd, [ref]$owner)
    if ($pids -contains [int]$owner -and [OwnDialog]::IsWindowVisible($hwnd)) {
      $name = New-Object System.Text.StringBuilder 64
      [void][OwnDialog]::GetClassName($hwnd, $name, 64)
      if ($name.ToString() -eq '#32770') { $script:found = $hwnd; return $false }
    }
    return $true
  }
  [void][OwnDialog]::EnumWindows($callback, [IntPtr]::Zero)
  if ($found -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 }
}
if ($found -eq [IntPtr]::Zero) {
  Write-Output (@{ found = $false } | ConvertTo-Json -Compress)
  exit 0
}
Start-Sleep -Milliseconds 700
$title = New-Object System.Text.StringBuilder 256
[void][OwnDialog]::GetWindowText($found, $title, 256)
$rect = New-Object OwnDialog+RECT
[void][OwnDialog]::GetWindowRect($found, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
[void][OwnDialog]::PrintWindow($found, $hdc, 2)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
# WM_CLOSE = cancel: the picker resolves with nothing chosen.
[void][OwnDialog]::PostMessage($found, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
$closed = $false
for ($i = 0; $i -lt 20 -and -not $closed; $i++) {
  Start-Sleep -Milliseconds 250
  $closed = -not [OwnDialog]::IsWindow($found)
}
Write-Output (@{ found = $true; title = $title.ToString(); size = "${width}x${height}"; out = $Out; closed = $closed } | ConvertTo-Json -Compress)
