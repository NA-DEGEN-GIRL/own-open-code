<#
  Answers a dialog a process shows (#32770 windows: the common "Save As" dialog, message boxes). For automated runs of
  the packaged shell only (browser-agent.ts: 05 §8.4 `PC에 저장`, §7.2 close confirmation); it touches no window of
  any other process.

    powershell -NoProfile -File file-dialog.ps1 -ProcessId <pid> -Path <full path>   # type the name, press Save
    powershell -NoProfile -File file-dialog.ps1 -ProcessId <pid> -Dismiss [-Shot <png>]
    powershell -NoProfile -File file-dialog.ps1 -ProcessId <pid> -ButtonId <id> [-Shot <png>]
  -Dismiss answers the dialog the way Esc or its close button does (IDCANCEL; a message box with a cancel button
  returns that button), trying TDM_CLICK_BUTTON(IDCANCEL), WM_COMMAND(IDCANCEL) and WM_CLOSE until it is gone, and
  reports which one closed it. -ButtonId presses a message box button (TDM_CLICK_BUTTON; Electron numbers custom
  buttons 100, 101, … in order). -Shot saves the dialog as PNG first (PrintWindow).
  Prints the dialog title; exits 1 when no dialog appears within -TimeoutSeconds (default 15) or it stays open.
#>
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [string]$Path,
  [switch]$Dismiss,
  [int]$ButtonId = -1,
  [string]$Shot,
  [int]$TimeoutSeconds = 15
)
$ErrorActionPreference = 'Stop'
# Titles are Korean: print UTF-8 so the caller reads them.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnDialog {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static string Class(IntPtr hwnd) { var b = new StringBuilder(256); GetClassName(hwnd, b, 256); return b.ToString(); }
  public static string Text(IntPtr hwnd) { var b = new StringBuilder(512); GetWindowText(hwnd, b, 512); return b.ToString(); }
  public static List<IntPtr> Dialogs(HashSet<uint> pids) {
    var found = new List<IntPtr>();
    EnumWindows((hwnd, l) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pids.Contains(pid) && IsWindowVisible(hwnd) && Class(hwnd) == "#32770") found.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FileNameBox(IntPtr dialog) {
    IntPtr result = IntPtr.Zero;
    EnumChildWindows(dialog, (hwnd, l) => {
      if (Class(hwnd) == "Edit" && Class(GetParent(hwnd)) == "ComboBox") { result = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
[void][OwnDialog]::SetProcessDPIAware()

$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
[void]$pids.Add([uint32]$ProcessId)
Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" | ForEach-Object { [void]$pids.Add([uint32]$_.ProcessId) }

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$dialog = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $list = [OwnDialog]::Dialogs($pids)
  if ($list.Count -gt 0) { $dialog = $list[0]; break }
  Start-Sleep -Milliseconds 200
}
if ($dialog -eq [IntPtr]::Zero) { Write-Output 'no dialog'; exit 1 }
$title = [OwnDialog]::Text($dialog)
Start-Sleep -Milliseconds 500
$WM_SETTEXT = 0x000C; $WM_COMMAND = 0x0111; $WM_CLOSE = 0x0010; $IDOK = 1; $IDCANCEL = 2; $TDM_CLICK_BUTTON = 0x0466

if ($Shot) {
  $rect = New-Object OwnDialog+RECT
  [void][OwnDialog]::GetWindowRect($dialog, [ref]$rect)
  $bitmap = New-Object System.Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [void][OwnDialog]::PrintWindow($dialog, $hdc, 2)
  $graphics.ReleaseHdc($hdc)
  $graphics.Dispose()
  $bitmap.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

if ($ButtonId -ge 0) {
  [void][OwnDialog]::PostMessage($dialog, [uint32]$TDM_CLICK_BUTTON, [IntPtr]$ButtonId, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 800
  $gone = -not [OwnDialog]::IsWindow($dialog) -or -not [OwnDialog]::IsWindowVisible($dialog)
  Write-Output ("button ${ButtonId}: $title; " + $(if ($gone) { 'closed' } else { 'still open' }))
  exit $(if ($gone) { 0 } else { 1 })
}

if ($Dismiss) {
  $attempts = @(
    @{ name = 'TDM_CLICK_BUTTON(IDCANCEL)'; msg = $TDM_CLICK_BUTTON; w = $IDCANCEL },
    @{ name = 'WM_COMMAND(IDCANCEL)'; msg = $WM_COMMAND; w = $IDCANCEL },
    @{ name = 'WM_CLOSE'; msg = $WM_CLOSE; w = 0 }
  )
  foreach ($attempt in $attempts) {
    [void][OwnDialog]::PostMessage($dialog, [uint32]$attempt.msg, [IntPtr]$attempt.w, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 800
    if (-not [OwnDialog]::IsWindow($dialog) -or -not [OwnDialog]::IsWindowVisible($dialog)) {
      Write-Output "dismissed by $($attempt.name): $title"
      exit 0
    }
  }
  Write-Output "still open: $title"
  exit 1
}

$box = [OwnDialog]::FileNameBox($dialog)
if ($box -eq [IntPtr]::Zero) { Write-Output "no file name box: $title"; exit 1 }
[void][OwnDialog]::SendMessage($box, $WM_SETTEXT, [IntPtr]::Zero, $Path)
Start-Sleep -Milliseconds 200
[void][OwnDialog]::PostMessage($dialog, $WM_COMMAND, [IntPtr]$IDOK, [IntPtr]::Zero)
Write-Output "saved: $title"
