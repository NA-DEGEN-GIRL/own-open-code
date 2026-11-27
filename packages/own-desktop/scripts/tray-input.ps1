<#
  The tray and the windows of one shell process, for scripts/tray-quit.ts (05 §7.3). It touches no
  window of any other process and never automates the taskbar: the tray icon is clicked through the shell's own
  notify-icon host window with the message Windows would send it (Electron's kNotifyIconMessage, WM_APP + 1, wParam =
  icon id, lParam = the mouse message). No right-click: the menu would open at the mouse, on the user's screen.
  Output: one JSON line.

    tray-input.ps1 -ProcessId <pid> -Action windows                         top-level windows (class, title, shown, place,
                                                                            noActivate: one that cannot be activated)
    tray-input.ps1 -ProcessId <pid> -Action tray -Mouse click | dblclick
    tray-input.ps1 -ProcessId <pid> -Action session -Message query | end    WM_QUERYENDSESSION / WM_ENDSESSION (log-off)
    tray-input.ps1 -ProcessId <pid> -Action close -Title <title>            WM_SYSCOMMAND SC_CLOSE (the caption's X)
#>
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][ValidateSet('windows', 'tray', 'session', 'close')][string]$Action,
  [ValidateSet('click', 'dblclick')][string]$Mouse = 'click',
  [string]$Title = '',
  [ValidateSet('query', 'end')][string]$Message = 'query'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OwnTray {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$pids = @($ProcessId) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" | ForEach-Object { [int]$_.ProcessId })

function Get-ShellWindows {
  $script:rows = New-Object System.Collections.ArrayList
  $callback = [OwnTray+EnumProc]{
    param($hwnd, $lParam)
    $owner = [uint32]0
    [void][OwnTray]::GetWindowThreadProcessId($hwnd, [ref]$owner)
    if ($pids -contains [int]$owner) {
      $name = New-Object System.Text.StringBuilder 128
      [void][OwnTray]::GetClassName($hwnd, $name, 128)
      $text = New-Object System.Text.StringBuilder 256
      [void][OwnTray]::GetWindowText($hwnd, $text, 256)
      $rect = New-Object OwnTray+RECT
      [void][OwnTray]::GetWindowRect($hwnd, [ref]$rect)
      [void]$script:rows.Add([pscustomobject]@{ hwnd = $hwnd; class = $name.ToString(); title = $text.ToString(); visible = [OwnTray]::IsWindowVisible($hwnd); noActivate = [bool]([OwnTray]::GetWindowLong($hwnd, -20) -band 0x08000000); left = $rect.Left; top = $rect.Top })
    }
    return $true
  }
  [void][OwnTray]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:rows
}

function Out-Json($Value) { Write-Output ($Value | ConvertTo-Json -Compress -Depth 4) }

switch ($Action) {
  'windows' {
    Out-Json @{ windows = @(Get-ShellWindows | Where-Object { $_.title } | ForEach-Object { @{ class = $_.class; title = $_.title; visible = $_.visible; noActivate = $_.noActivate; left = $_.left; top = $_.top } }) }
  }
  'tray' {
    $hosts = @(Get-ShellWindows | Where-Object { $_.class -eq 'Electron_NotifyIconHostWindow' })
    if (-not $hosts.Count) { Out-Json @{ ok = $false; reason = 'no notify icon host' }; exit 1 }
    $lParam = if ($Mouse -eq 'dblclick') { 0x0203 } else { 0x0201 }
    # Icon ids start at 1 or 2 (NotifyIconHost); a message for an id that is not registered is ignored.
    foreach ($id in 1..4) { [void][OwnTray]::PostMessage($hosts[0].hwnd, 0x8001, [IntPtr]$id, [IntPtr]$lParam) }
    Out-Json @{ ok = $true; mouse = $Mouse }
  }
  'session' {
    # ENDSESSION_LOGOFF in lParam; WM_ENDSESSION's wParam TRUE says the session really ends.
    $answers = @(foreach ($window in @(Get-ShellWindows)) {
      $out = [IntPtr]::Zero
      if ($Message -eq 'query') {
        $sent = [OwnTray]::SendMessageTimeout($window.hwnd, 0x0011, [IntPtr]::Zero, [IntPtr]0x80000000L, 0x0002, 5000, [ref]$out)
        @{ class = $window.class; answered = ($sent -ne [IntPtr]::Zero); allows = ($out -ne [IntPtr]::Zero) }
      }
      elseif ($window.class -like 'Chrome_WidgetWin_*' -and $window.title) {
        $sent = [OwnTray]::SendMessageTimeout($window.hwnd, 0x0016, [IntPtr]1, [IntPtr]0x80000000L, 0x0002, 5000, [ref]$out)
        @{ class = $window.class; answered = ($sent -ne [IntPtr]::Zero) }
      }
    })
    Out-Json @{ ok = $true; message = $Message; answers = $answers }
  }
  'close' {
    $window = @(Get-ShellWindows | Where-Object { $_.title -eq $Title -and $_.visible })[0]
    if ($null -eq $window) { Out-Json @{ ok = $false; reason = "no shown window '$Title'" }; exit 1 }
    [void][OwnTray]::PostMessage($window.hwnd, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero)
    Out-Json @{ ok = $true }
  }
}
