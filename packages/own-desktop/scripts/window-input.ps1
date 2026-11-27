<#
  Window state and real keyboard input for one process's main window (automated runs of the packaged shell only,
  gates.ts). It never types into another application: before every key combination the foreground window must belong
  to the process (or its children); otherwise the combination is skipped and reported.

    window-input.ps1 -ProcessId <pid> -Action minimize | restore | focus | state
    window-input.ps1 -ProcessId <pid> -Action keys -Keys "ctrl+w;ctrl+r;ctrl+shift+i"

  Key names: ctrl, shift, alt, a-z, 0-9, f1-f12, plus (=), minus (-), zero-width names "oemplus"/"oemminus",
  enter, esc, backspace, delete, tab, home, end, left, right, up, down. Output: one JSON line.
#>
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][ValidateSet('minimize', 'restore', 'focus', 'state', 'keys')][string]$Action,
  [string]$Keys = '',
  [int]$DelayMs = 400
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OwnInput {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  public static uint Key(ushort vk, bool up) {
    INPUT[] input = new INPUT[1];
    input[0].type = 1;
    input[0].u.ki.wVk = vk;
    input[0].u.ki.dwFlags = up ? 2u : 0u;
    return SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@

$pids = @($ProcessId) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" | ForEach-Object { [int]$_.ProcessId })
$script:found = [IntPtr]::Zero
$script:best = 0
$callback = [OwnInput+EnumProc]{
  param($hwnd, $lParam)
  $owner = [uint32]0
  [void][OwnInput]::GetWindowThreadProcessId($hwnd, [ref]$owner)
  # A window that cannot be activated (WS_EX_NOACTIVATE) or is a tool window is not the main window: the browser
  # pane's capture window (remote-surface.ts) is one, shown off the screen, and as large as the tab it holds; a
  # minimized main window is only 160 x 28.
  $exStyle = [OwnInput]::GetWindowLong($hwnd, -20)
  $mainLike = -not ($exStyle -band 0x08000080)
  if ($pids -contains [int]$owner -and $mainLike -and [OwnInput]::IsWindowVisible($hwnd)) {
    $rect = New-Object OwnInput+RECT
    [void][OwnInput]::GetWindowRect($hwnd, [ref]$rect)
    $area = [Math]::Max(1, ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top))
    if ($area -gt $script:best) { $script:best = $area; $script:found = $hwnd }
  }
  return $true
}
[void][OwnInput]::EnumWindows($callback, [IntPtr]::Zero)
$hwnd = $script:found
if ($hwnd -eq [IntPtr]::Zero) { Write-Output (@{ ok = $false; error = 'no window' } | ConvertTo-Json -Compress); exit 1 }

function Test-Ours {
  $fg = [OwnInput]::GetForegroundWindow()
  $owner = [uint32]0
  [void][OwnInput]::GetWindowThreadProcessId($fg, [ref]$owner)
  return ($pids -contains [int]$owner)
}

function Invoke-Focus {
  if ([OwnInput]::IsIconic($hwnd)) { [void][OwnInput]::ShowWindow($hwnd, 9) }
  if (Test-Ours) { return $true }
  # Attach to the foreground thread so SetForegroundWindow is allowed, without injecting any key.
  $fg = [OwnInput]::GetForegroundWindow()
  $dummy = [uint32]0
  $fgThread = [OwnInput]::GetWindowThreadProcessId($fg, [ref]$dummy)
  $me = [OwnInput]::GetCurrentThreadId()
  [void][OwnInput]::AttachThreadInput($me, $fgThread, $true)
  try {
    [void][OwnInput]::BringWindowToTop($hwnd)
    [void][OwnInput]::SetForegroundWindow($hwnd)
  }
  finally { [void][OwnInput]::AttachThreadInput($me, $fgThread, $false) }
  Start-Sleep -Milliseconds 250
  if (Test-Ours) { return $true }
  # Foreground lock still on: an injected Alt press makes this process the source of the last input, which
  # SetForegroundWindow accepts. The press lands in the current foreground app, the release in ours (a lone Alt-down
  # opens no menu).
  [void][OwnInput]::Key(0x12, $false)
  [void][OwnInput]::SetForegroundWindow($hwnd)
  [void][OwnInput]::Key(0x12, $true)
  Start-Sleep -Milliseconds 250
  return (Test-Ours)
}

$vk = @{
  ctrl = 0x11; shift = 0x10; alt = 0x12; enter = 0x0D; esc = 0x1B; backspace = 0x08; delete = 0x2E; tab = 0x09
  home = 0x24; end = 0x23; left = 0x25; up = 0x26; right = 0x27; down = 0x28
  plus = 0xBB; oemplus = 0xBB; minus = 0xBD; oemminus = 0xBD
}
foreach ($c in [char[]]'abcdefghijklmnopqrstuvwxyz') { $vk["$c"] = [int][char]::ToUpperInvariant($c) }
foreach ($d in 0..9) { $vk["$d"] = 0x30 + $d }
foreach ($f in 1..12) { $vk["f$f"] = 0x6F + $f }

switch ($Action) {
  'minimize' { [void][OwnInput]::ShowWindow($hwnd, 6); Start-Sleep -Milliseconds 300; Write-Output (@{ ok = $true; iconic = [OwnInput]::IsIconic($hwnd) } | ConvertTo-Json -Compress) }
  'restore' { [void][OwnInput]::ShowWindow($hwnd, 9); Start-Sleep -Milliseconds 300; Write-Output (@{ ok = $true; iconic = [OwnInput]::IsIconic($hwnd) } | ConvertTo-Json -Compress) }
  'state' { Write-Output (@{ ok = $true; iconic = [OwnInput]::IsIconic($hwnd); foreground = (Test-Ours) } | ConvertTo-Json -Compress) }
  'focus' { $ok = Invoke-Focus; Write-Output (@{ ok = $ok } | ConvertTo-Json -Compress) }
  'keys' {
    $results = @()
    foreach ($combo in ($Keys -split ';' | Where-Object { $_ })) {
      $names = $combo.ToLowerInvariant() -split '\+'
      $codes = @()
      foreach ($name in $names) {
        if (-not $vk.ContainsKey($name)) { throw "unknown key '$name' in '$combo'" }
        $codes += [uint16]$vk[$name]
      }
      if (-not (Invoke-Focus)) { $results += @{ combo = $combo; sent = $false; reason = 'not foreground' }; continue }
      foreach ($code in $codes) { [void][OwnInput]::Key($code, $false) }
      [array]::Reverse($codes)
      foreach ($code in $codes) { [void][OwnInput]::Key($code, $true) }
      $results += @{ combo = $combo; sent = $true }
      Start-Sleep -Milliseconds $DelayMs
    }
    Write-Output (@{ ok = $true; results = $results } | ConvertTo-Json -Compress -Depth 4)
  }
}
