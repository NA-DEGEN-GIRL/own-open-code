<#
.SYNOPSIS
  Verify an own-channel opencode.exe in throwaway directories (used by build-own.ps1).

.DESCRIPTION
  - `--version` must print -Version.
  - A foreground `serve` on a random loopback port with a generated test password must answer
    GET /api/info with the same version and create opencode-own.db (channel DB name) in the temp
    data root. The process is stopped afterwards.
  - With -ExpectTitle, GET / must return the embedded web app's index.html with that <title> (P-001: own-web).
  Every root the binary could write to (XDG_*, OPENCODE_CONFIG_DIR, OPENCODE_TEST_HOME) points into
  a fresh temp directory; the real ~/.config/opencode and ~/.local/share/opencode are checked for
  new own-channel files before and after. Returns an ordered summary.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Version,
  [int]$TimeoutSeconds = 90,
  [string]$ExpectTitle
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$root = Join-Path ([IO.Path]::GetTempPath()) ("own-verify-" + [Guid]::NewGuid().ToString('N').Substring(0, 12))
$dirs = [ordered]@{
  XDG_CONFIG_HOME = Join-Path $root 'config'
  XDG_DATA_HOME = Join-Path $root 'data'
  XDG_STATE_HOME = Join-Path $root 'state'
  XDG_CACHE_HOME = Join-Path $root 'cache'
  OPENCODE_CONFIG_DIR = Join-Path $root 'own-config'
  OPENCODE_TEST_HOME = Join-Path $root 'home'
}
foreach ($dir in $dirs.Values) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

# Real user locations this verification must not touch.
$realFiles = @(
  (Join-Path $env:USERPROFILE '.local\share\opencode\opencode-own.db'),
  (Join-Path $env:USERPROFILE '.local\state\opencode\service-own.json'),
  (Join-Path $env:USERPROFILE '.config\opencode\service-own.json'),
  (Join-Path $env:USERPROFILE '.config\own-open-code\opencode.jsonc')
)
$realBefore = @{}
foreach ($file in $realFiles) { $realBefore[$file] = Get-Item -LiteralPath $file -ErrorAction SilentlyContinue | ForEach-Object { $_.LastWriteTimeUtc } }

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = [Convert]::ToBase64String($bytes)

$childEnv = @{
  OPENCODE_DISABLE_AUTOUPDATE = '1'
  OPENCODE_DISABLE_MODELS_FETCH = '1'
  OPENCODE_SERVER_PASSWORD = $password
  OPENCODE_DB = $null
  OPENCODE_DISABLE_CHANNEL_DB = $null
  OPENCODE_CONFIG = $null
  OPENCODE_CONFIG_CONTENT = $null
}
foreach ($name in $dirs.Keys) { $childEnv[$name] = $dirs[$name] }

$saved = @{}
foreach ($name in $childEnv.Keys) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $childEnv[$name], 'Process')
}
$result = [ordered]@{ temp_root = $root; port = $port }
$process = $null
try {
  $reported = (& $Exe --version 2>&1 | Out-String).Trim()
  $result.version_output = $reported
  # Upstream prints "opencode v<version>".
  if ($reported -ne "opencode v$Version" -and $reported -ne $Version) { throw "--version printed '$reported', expected 'opencode v$Version'" }
  Write-Host "    --version: $reported"

  $stdout = Join-Path $root 'serve.out.log'
  $stderr = Join-Path $root 'serve.err.log'
  $process = Start-Process -FilePath $Exe -ArgumentList @('serve', '--hostname', '127.0.0.1', '--port', "$port") `
    -WorkingDirectory $dirs.OPENCODE_TEST_HOME -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
    -WindowStyle Hidden -PassThru
  $headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$password")) }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $info = $null
  while ((Get-Date) -lt $deadline -and $null -eq $info) {
    if ($process.HasExited) { break }
    try { $info = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/info" -Headers $headers -TimeoutSec 5 -UseBasicParsing }
    catch { Start-Sleep -Milliseconds 500 }
  }
  if ($null -eq $info) {
    $tail = (Get-Content -LiteralPath $stderr -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
    throw "serve did not answer /api/info within $TimeoutSeconds s (exited=$($process.HasExited)). stderr tail:`n$tail"
  }
  $result.serve_info_version = $info.version
  $result.serve_urls = @($info.urls)
  if ($info.version -ne $Version) { throw "/api/info version '$($info.version)' != '$Version'" }
  Write-Host "    serve: /api/info version $($info.version) on 127.0.0.1:$port"

  if ($ExpectTitle) {
    $page = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -Headers $headers -TimeoutSec 15 -UseBasicParsing
    $title = if ($page.Content -match '<title>([^<]*)</title>') { $Matches[1] } else { $null }
    $result.web_title = $title
    if ($title -ne $ExpectTitle) { throw "GET / served <title>$title</title>, expected '$ExpectTitle' (embedded web app)" }
    Write-Host "    web: GET / -> <title>$title</title>"
  }

  $db = Join-Path $dirs.XDG_DATA_HOME 'opencode\opencode-own.db'
  $result.channel_db = $db
  $result.channel_db_exists = Test-Path -LiteralPath $db
  if (-not $result.channel_db_exists) { throw "expected channel database $db was not created" }
  Write-Host "    channel db: $db"
}
finally {
  if ($null -ne $process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $process.WaitForExit(10000) | Out-Null
  }
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}

$touched = @($realFiles | Where-Object {
    $after = Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue | ForEach-Object { $_.LastWriteTimeUtc }
    "$after" -ne "$($realBefore[$_])"
  })
$result.real_user_files_touched = $touched
if ($touched.Count -gt 0) { throw "verification touched real user files: $($touched -join ', ')" }
Write-Host "    real ~/.config/opencode, ~/.local/share/opencode and own config untouched"

Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
$result.ok = $true
$result
