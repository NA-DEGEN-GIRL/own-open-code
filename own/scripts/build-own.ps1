<#
.SYNOPSIS
  Build the own-channel opencode CLI (Windows x64) with upstream's packages/cli/script/build.ts.

.DESCRIPTION
  Runs the unmodified upstream build (`bun run script/build.ts --single`) with
  OPENCODE_CHANNEL=own and OPENCODE_VERSION=<upstream>-own.<k> (own/FORK.md sec. 8), writes the
  result under own/.out/build/<version>/ and verifies it in throwaway directories:

    1. `opencode --version` prints the requested version.
    2. `opencode serve` (foreground, random loopback port, test password) answers GET /api/info
       with the same version and creates opencode-own.db inside the temp data root only.

  Nothing under %USERPROFILE%\.config\opencode, ~/.local/share/opencode or the own install
  (%LOCALAPPDATA%\own-open-code) is read or written during verification: XDG_* roots,
  OPENCODE_CONFIG_DIR and OPENCODE_TEST_HOME all point into a temp directory.

  By default the upstream build's cross-platform `bun install --os=* --cpu=*` step is skipped
  (--skip-install) because it rewrites bun.lock; the win32-x64 native packages are already present
  after a normal `bun install`. Pass -UpstreamInstall to run it anyway.

  P-001 (own/ledger/core-patches.yaml, active) selects the embedded web app: the build sets
  OPENCODE_WEB_APP=own-web, so upstream's app-assets.ts builds packages/own-web (VITE_OPENCODE_SERVER_MODE=origin)
  and embeds its dist\ as the web fallback (01 sec. 6.1, `own open --browser`). -ClassicWebUi embeds upstream's
  packages/app instead; -SkipWebUi builds without any embedded UI.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-own.ps1 -Version 2.0.18-own.1
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$OutDir,
  [switch]$SkipWebUi,
  # Embed upstream's packages/app instead of own-web (P-001 off for this build).
  [switch]$ClassicWebUi,
  [switch]$UpstreamInstall,
  [switch]$Baseline,
  [switch]$NoVerify,
  [int]$VerifyTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($repo.Contains('#')) {
  throw "Repository path '$repo' contains '#', which breaks Bun/Vite path handling. Build from a worktree without '#' (e.g. C:\src\own-open-code)."
}
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  throw "build-own.ps1 builds the Windows x64 target only (PROCESSOR_ARCHITECTURE=$env:PROCESSOR_ARCHITECTURE)."
}

$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json
$expectedBun = ($rootPackage.packageManager -split '@')[1]
$bunVersion = (& bun --version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'bun is not on PATH' }
if ($bunVersion -ne $expectedBun) {
  throw "bun $bunVersion does not match packageManager bun@$expectedBun (root package.json). Install that version first (own/FORK.md sec. 3)."
}

if (-not $Version) { $Version = "$($rootPackage.version)-own.0" }
if ($Version -notmatch '^\d+\.\d+\.\d+-own\.\d+$') {
  throw "Version '$Version' must look like <upstream release>-own.<k>, e.g. 2.0.18-own.1 (own/FORK.md sec. 8.1)."
}
if (-not $Version.StartsWith("$($rootPackage.version)-own.")) {
  Write-Warning "Version $Version does not start with the merged upstream release $($rootPackage.version)."
}

$outRoot = Join-Path $repo 'own\.out'
if (-not $OutDir) { $OutDir = Join-Path $outRoot "build\$Version" }
$OutDir = [IO.Path]::GetFullPath($OutDir)
# build.ts deletes --outdir recursively before building; only allow our own output tree.
if (-not $OutDir.StartsWith([IO.Path]::GetFullPath($outRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutDir must be inside $outRoot (upstream build.ts removes it recursively)."
}

$target = if ($Baseline) { 'cli-windows-x64-baseline' } else { 'cli-windows-x64' }
$exe = Join-Path $OutDir "$target\bin\opencode.exe"

$buildArgs = @('run', 'script/build.ts', '--single', "--outdir=$OutDir")
if (-not $UpstreamInstall) { $buildArgs += '--skip-install' }
if ($SkipWebUi) { $buildArgs += '--skip-web-ui' }
if ($Baseline) { $buildArgs += '--baseline' }

$buildEnv = @{
  OPENCODE_CHANNEL = 'own'
  OPENCODE_VERSION = $Version
  OPENCODE_RELEASE = $null
  OPENCODE_BUMP = $null
  # P-001: packages/cli/script/app-assets.ts resolves the embedded web app root from this (default "app").
  OPENCODE_WEB_APP = $(if ($ClassicWebUi) { $null } else { 'own-web' })
}
$embeddedWebUi = if ($SkipWebUi) { 'none' } elseif ($ClassicWebUi) { 'packages/app (classic)' } else { 'packages/own-web (P-001)' }

function Invoke-WithEnv([hashtable]$Vars, [scriptblock]$Body) {
  $saved = @{}
  foreach ($name in $Vars.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $Vars[$name], 'Process')
  }
  try { & $Body }
  finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  }
}

Write-Host "==> building opencode $Version (channel own, $target) -> $OutDir"
$started = Get-Date
Invoke-WithEnv $buildEnv {
  Push-Location (Join-Path $repo 'packages\cli')
  try {
    & bun @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "upstream build failed (exit $LASTEXITCODE)" }
  }
  finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $exe)) { throw "build finished but $exe is missing" }

$item = Get-Item -LiteralPath $exe
$sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$commit = (& git -C $repo rev-parse HEAD).Trim()
$dirty = [bool](& git -C $repo status --porcelain)
$info = [ordered]@{
  version = $Version
  channel = 'own'
  target = $target
  exe = $exe
  size = $item.Length
  sha256 = $sha256
  bun = $bunVersion
  fork_commit = $commit
  fork_dirty = $dirty
  upstream_release = $rootPackage.version
  embedded_web_ui = $embeddedWebUi
  built_at = (Get-Date).ToUniversalTime().ToString('o')
  build_seconds = [int]((Get-Date) - $started).TotalSeconds
}
Write-Host ("==> built {0} ({1:N1} MiB, sha256 {2})" -f $exe, ($item.Length / 1MB), $sha256)

if (-not $NoVerify) {
  $verifyArgs = @{ Exe = $exe; Version = $Version; TimeoutSeconds = $VerifyTimeoutSeconds }
  # own-web's index.html title: the embedded web fallback must be own-web, not the classic app (P-001).
  if (-not $SkipWebUi -and -not $ClassicWebUi) { $verifyArgs.ExpectTitle = 'own-open-code' }
  $info.verify = & (Join-Path $PSScriptRoot 'lib\verify-own-binary.ps1') @verifyArgs
}

[IO.File]::WriteAllText((Join-Path $OutDir 'build-info.json'), ($info | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
Write-Host "==> build-info: $(Join-Path $OutDir 'build-info.json')"
