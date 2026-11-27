<#
  Windows toast checks for G-D4 (05 sec. 7.4, sec. 14.1): automated runs of the packaged shell only (gates.ts).

    toast.ps1 -Action history -Aumid dev.own.opencode.desktop            toasts of that AUMID in the Action Center
    toast.ps1 -Action clear   -Aumid dev.own.opencode.desktop            removes them again (the run leaves none)
    toast.ps1 -Action find    [-Match <text>] [-Shot <png>]              toast popups on screen (UI Automation)
    toast.ps1 -Action invoke  -Match <text>                              activates the toast whose text has <text>

  `find` looks only at ShellExperienceHost's notification windows and captures only that rectangle. `invoke` uses the
  toast's UI Automation Invoke pattern; it never moves the mouse. Output: one JSON line.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('history', 'clear', 'find', 'invoke')][string]$Action,
  [string]$Aumid = 'dev.own.opencode.desktop',
  [string]$Match = '',
  [string]$Shot = '',
  [int]$TimeoutSeconds = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Out-Json($Value) { Write-Output ($Value | ConvertTo-Json -Compress -Depth 6) }

if ($Action -in @('history', 'clear')) {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $history = [Windows.UI.Notifications.ToastNotificationManager]::History
  if ($Action -eq 'clear') {
    try { $history.Clear($Aumid); Out-Json @{ ok = $true } } catch { Out-Json @{ ok = $false; error = $_.Exception.Message } }
    return
  }
  try {
    $items = @($history.GetHistory($Aumid))
    $list = foreach ($item in $items) {
      $texts = @($item.Content.GetElementsByTagName('text') | ForEach-Object { $_.InnerText })
      $actions = @($item.Content.GetElementsByTagName('action')).Count
      @{ tag = $item.Tag; group = $item.Group; texts = $texts; actions = $actions }
    }
    Out-Json @{ ok = $true; count = $items.Count; toasts = @($list) }
  }
  catch { Out-Json @{ ok = $false; error = $_.Exception.Message } }
  return
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System.Runtime.InteropServices;
public static class OwnToastDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
[void][OwnToastDpi]::SetProcessDPIAware()

function Find-Toasts {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $shell = @(Get-Process -Name ShellExperienceHost -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $found = @()
  $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($window in $children) {
    try {
      $info = $window.Current
      if ($shell -notcontains $info.ProcessId) { continue }
      if ($info.ClassName -ne 'Windows.UI.Core.CoreWindow') { continue }
      $texts = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
        ForEach-Object { $_.Current.Name } | Where-Object { $_ })
      $rect = $info.BoundingRectangle
      $found += [pscustomobject]@{ Element = $window; Name = $info.Name; Texts = $texts; Rect = $rect }
    }
    catch {}
  }
  return $found
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  $toasts = @(Find-Toasts | Where-Object { -not $Match -or (($_.Texts -join "`n") + "`n" + $_.Name).Contains($Match) })
  if ($toasts.Count -gt 0 -or (Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 250
} while ($true)

if ($Action -eq 'find') {
  $shotOut = $null
  if ($Shot -and $toasts.Count -gt 0) {
    $r = $toasts[0].Rect
    if ($r.Width -gt 0 -and $r.Height -gt 0) {
      $bitmap = New-Object System.Drawing.Bitmap ([int]$r.Width), ([int]$r.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bitmap.Size)
      $graphics.Dispose()
      $bitmap.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
      $bitmap.Dispose()
      $shotOut = $Shot
    }
  }
  Out-Json @{
    ok = $true
    count = $toasts.Count
    toasts = @($toasts | ForEach-Object { @{ name = $_.Name; texts = $_.Texts; rect = "$($_.Rect)" } })
    shot = $shotOut
  }
  return
}

# invoke
if ($toasts.Count -eq 0) { Out-Json @{ ok = $false; error = 'no toast' }; return }
$toast = $toasts[0].Element
$candidates = @($toast) + @($toast.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
foreach ($element in $candidates) {
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $name = $element.Current.Name
    # The toast body, not its close or settings buttons.
    if ($Match -and -not $name.Contains($Match) -and $element -ne $toast) { continue }
    $pattern.Invoke()
    Out-Json @{ ok = $true; invoked = $name; controlType = $element.Current.ControlType.ProgrammaticName }
    return
  }
}
Out-Json @{ ok = $false; error = 'toast has no invokable body'; texts = $toasts[0].Texts }
