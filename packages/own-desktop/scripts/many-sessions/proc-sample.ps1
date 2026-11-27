# Memory and CPU time of process trees, for perf-many-sessions.ts. For each request it prints one JSON line: every
# process under the given root pids (the roots included) with its parent, image name, Chromium/Electron process type
# (from the command line), working set, private working set (Task Manager's "메모리"), private bytes (commit, what
# Chromium calls the private memory footprint on Windows) and CPU time. Read-only: it only queries WMI.
#
#   -Roots 1,2,3     one sample, then exit
#   -Serve           read root lists (comma-separated, one per line) from stdin until EOF; one JSON line each, so the
#                    bench pays PowerShell's start-up once instead of every few seconds
param([string]$Roots = '', [switch]$Serve)

function Sample([string]$list) {
  $rootIds = @($list -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ })
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize, PrivatePageCount, KernelModeTime, UserModeTime)
  $children = @{}
  $byId = @{}
  foreach ($p in $all) {
    $key = [int]$p.ParentProcessId
    if (-not $children.ContainsKey($key)) { $children[$key] = New-Object System.Collections.ArrayList }
    [void]$children[$key].Add($p)
    $byId[[int]$p.ProcessId] = $p
  }
  $picked = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  foreach ($id in $rootIds) { if ($byId.ContainsKey($id)) { $queue.Enqueue($byId[$id]) } }
  $seen = @{}
  while ($queue.Count -gt 0) {
    $p = $queue.Dequeue()
    $id = [int]$p.ProcessId
    if ($seen.ContainsKey($id)) { continue }
    $seen[$id] = $true
    [void]$picked.Add($p)
    if ($children.ContainsKey($id)) { foreach ($c in $children[$id]) { $queue.Enqueue($c) } }
  }
  $private = @{}
  if ($picked.Count -gt 0) {
    $filter = (@($picked | ForEach-Object { "IDProcess=$([int]$_.ProcessId)" })) -join ' OR '
    foreach ($row in @(Get-CimInstance Win32_PerfRawData_PerfProc_Process -Filter $filter -Property IDProcess, WorkingSetPrivate)) {
      $private[[int]$row.IDProcess] = [int64]$row.WorkingSetPrivate
    }
  }
  $rows = foreach ($p in $picked) {
    $cmd = [string]$p.CommandLine
    $type = if ($cmd -match '--type=([a-z-]+)') { $Matches[1] } else { 'main' }
    if ($cmd -match '--utility-sub-type=([A-Za-z0-9_.]+)') { $type = "${type}:$($Matches[1])" }
    [pscustomobject]@{
      pid          = [int]$p.ProcessId
      ppid         = [int]$p.ParentProcessId
      name         = [string]$p.Name
      type         = $type
      ws           = [int64]$p.WorkingSetSize
      privateWs    = if ($private.ContainsKey([int]$p.ProcessId)) { $private[[int]$p.ProcessId] } else { $null }
      privateBytes = [int64]$p.PrivatePageCount
      cpu100ns     = [int64]$p.KernelModeTime + [int64]$p.UserModeTime
    }
  }
  ConvertTo-Json -Compress -Depth 3 @($rows)
}

if (-not $Serve) { Sample $Roots; exit 0 }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Trim() -eq '') { continue }
  [Console]::Out.WriteLine((Sample $line.Trim()))
  [Console]::Out.Flush()
}
