<#
  Asks a process's main window to close the way the title bar's X (WCO) and Alt+F4 do: WM_CLOSE to its largest
  visible top-level window. For automated runs of the packaged shell only (browser-agent.ts, 05 §7.2 close
  confirmation); it touches no window of any other process. Returns at once (PostMessage).

    powershell -NoProfile -File window-close.ps1 -ProcessId <pid>
#>
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  # WM_SYSCOMMAND SC_CLOSE, what the caption's X and Alt+F4 send before Windows turns it into WM_CLOSE.
  [switch]$SysCommand
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OwnClose {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$pids = @($ProcessId) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" | ForEach-Object { [int]$_.ProcessId })
$found = [IntPtr]::Zero
$best = 0
$callback = [OwnClose+EnumProc]{
  param($hwnd, $lParam)
  $owner = [uint32]0
  [void][OwnClose]::GetWindowThreadProcessId($hwnd, [ref]$owner)
  if ($pids -contains [int]$owner -and [OwnClose]::IsWindowVisible($hwnd)) {
    $rect = New-Object OwnClose+RECT
    [void][OwnClose]::GetWindowRect($hwnd, [ref]$rect)
    $area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)
    if ($area -gt $script:best) { $script:best = $area; $script:found = $hwnd }
  }
  return $true
}
[void][OwnClose]::EnumWindows($callback, [IntPtr]::Zero)
if ($found -eq [IntPtr]::Zero) { Write-Output 'no window'; exit 1 }
if ($SysCommand) {
  [void][OwnClose]::PostMessage($found, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero)
  Write-Output 'WM_SYSCOMMAND SC_CLOSE posted'
} else {
  [void][OwnClose]::PostMessage($found, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  Write-Output 'WM_CLOSE posted'
}
