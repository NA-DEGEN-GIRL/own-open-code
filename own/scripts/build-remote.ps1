<#
.SYNOPSIS
  Build the SSH remote artifacts (04 §5.2, FORK §8.2 steps 1b, 3, 6): own-channel Linux CLIs, the plugin bundles
  with the release build id, the pinned static git-lfs (06 §4.13), and app\<ver>\remote\<target>.tar.gz +
  remote\tools\git-lfs\<ver>\<target>\ + manifest.json.

.DESCRIPTION
  Steps, all under own\.out\build\<version>\ by default (upstream build.ts deletes its --outdir, so each target
  compiles into its own directory below remote-build\):

    1. build id   FORK §8.2 1b: input hash of the version, bun.lock and the own packages (12 hex). -BuildId or
                  $env:OWN_BUILD_ID wins, so a release computes it once for every bundle.
    2. Linux CLI  the unmodified upstream packages/cli/script/build.ts with OPENCODE_CHANNEL=own and
                  OPENCODE_VERSION=<version>, OPENCODE_TARGET=linux-x64-baseline / linux-arm64 (gate RG2,
                  cross-compiled on Windows; since upstream v2.2 build.ts reads the target only from OPENCODE_TARGET and
                  ignores --target=, which would build every target). Two network inputs, both from official sources:
                  - the Linux native optional packages (@opencode/pty-linux-* (@opencode-ai/pty-linux-* until upstream v2.2.5), @parcel/watcher-linux-*,
                    @opentui/core-linux-*, @ff-labs/fff-bin-linux-*): packages/own-remote/script/native.ts downloads
                    them from registry.npmjs.org at the versions bun.lock pins, checks the lockfile's sha512 integrity,
                    unpacks them under -NativeDir and, for the build only, links them where Bun's isolated linker
                    would (junctions in node_modules\.bun\<dependent>\node_modules and the workspaces' node_modules).
                    The junctions are removed afterwards; bun.lock and the installed packages are never changed.
                    -UpstreamInstall instead runs upstream's own `bun install --os=* --cpu=*` (rewrites bun.lock).
                  - Bun's cross-compile runtime, which Bun.build downloads from npm (@oven/bun-linux-*) into its
                    install cache, pinned to -NativeDir\bun-cache for the build (without HOME, as under PowerShell,
                    Bun would fall back to packages\cli\.bun-cache). It is then compared with the npm package and
                    the GitHub release zip (release SHASUMS256.txt); -SkipRuntimeCheck skips that (offline rebuilds).
                  Fallback: a Linux build host building the same commit; pass its binaries with -LinuxBinary and
                  -SkipCompile.
    2b. git-lfs   for every target, git-lfs's own static Linux release archive of the version native.ts GIT_LFS pins
                  (github.com/git-lfs/git-lfs releases), checked against the pinned sha256 before it is written or
                  unpacked; the git-lfs binary (static ELF for the target machine) and its license go to
                  -NativeDir\git-lfs\<ver>\<target>\. Verified archives are reused from -NativeDir\git-lfs\archives;
                  -GitLfsArchive takes local copies instead of downloading (checked the same way). The pin is 3.8.1
                  (2026-10-30, the fix of four CVEs); the user approved its download on 2026-10-31, and the verified
                  archives sit in the release worktree's -NativeDir\git-lfs\archives next to 3.8.0's (MR8-21).
    3. plugins    own-accounts, own-remote, own-team, own-telemetry, own-harness, own-omo, own-creator
                  (bundle.ts REMOTE_PLUGINS; own-telemetry for the Claude slot the PC relays, 04 §8.11.14;
                  own-harness after it, 10 §6.1; own-omo, 15 §1, with omo-runtime.js, its LICENSE.md,
                  THIRD-PARTY-NOTICES.md, MODIFICATIONS.md and skills\ from packages\own-omo\script\bundle.ts;
                  own-creator last, 17 §10, with own's QuickJS engine in quickjs\core and quickjs\variant, one
                  .wasm for x64 and arm64) as single-file ESM with
                  OWN_BUILD_ID,
                  OWN_EXPECTED_APP_VERSION, OWN_PLUGIN_VERSION (packages/own-remote/script/bundle.ts; Bun.build
                  define, never CLI flags: PowerShell 5.1 drops the quotes).
    4. verify     each binary (it cannot run here): ELF64 little-endian for its machine with the glibc interpreter,
                  the version string and the own-channel user agent, every embedded ELF object for the same machine,
                  no embedded Windows PE image, and every native file of its target embedded byte for byte.
    5. package    per target: opencode, plugins/own-accounts, plugins/own-remote, plugins/own-team,
                  plugins/own-telemetry, plugins/own-harness, plugins/own-omo (with its runtime, license, notices and
                  skills), plugins/own-creator (with quickjs\), libexec/start.sh,
                  manifest.json (sha256 of every file) -> remote\<target>.tar.gz; git-lfs and its license as separate
                  files -> remote\tools\git-lfs\<ver>\<target>\ (not in the archive: a host gets it only when a
                  repository needs it); remote\manifest.json (read by own-remote; tools.git-lfs per target) and
                  remote\remote_artifacts.json (the FORK §8.3 release-manifest entry, with the same tools entry).
                  remote-build-info.json records the inputs (native packages with their URLs and hashes, the runtime
                  check, git-lfs) and the binary reports; a -SkipCompile run over the same binaries (sha256) keeps
                  the compile record it found there (compiled targets, embedded web UI, runtime check).

  Nothing is uploaded anywhere and no remote host is contacted.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-remote.ps1 -Version 2.0.18-own.1

.EXAMPLE
  # RG2 fallback: binaries built on a Linux build host from the same commit
  powershell -File own\scripts\build-remote.ps1 -Version 2.0.18-own.1 -SkipCompile `
    -LinuxBinary "linux-x64-baseline=D:\drop\opencode-x64;linux-arm64=D:\drop\opencode-arm64"

.EXAMPLE
  # git-lfs archives downloaded by hand (still checked against the pins)
  powershell -File own\scripts\build-remote.ps1 -Version 2.0.18-own.8 `
    -GitLfsArchive "linux-x64-baseline=D:\drop\git-lfs-linux-amd64-v3.8.1.tar.gz;linux-arm64=D:\drop\git-lfs-linux-arm64-v3.8.1.tar.gz"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$OutDir,
  # Several targets may be joined with "," or ";" (works through `powershell -File` too).
  [string[]]$Targets = @('linux-x64-baseline', 'linux-arm64'),
  # "<target>=<path>" entries; several may be joined with ";" (works through `powershell -File` too).
  [string[]]$LinuxBinary = @(),
  [switch]$SkipCompile,
  [switch]$UpstreamInstall,
  [switch]$SkipWebUi,
  [string]$BuildId,
  # Verified Linux native packages and runtime downloads (reused across versions; always re-verified).
  [string]$NativeDir,
  [switch]$SkipRuntimeCheck,
  # Tests only: package non-ELF stand-ins (the fake-SSH harness launcher).
  [switch]$NoElfCheck,
  # Local copies of the pinned git-lfs release archives instead of the download: "<target>=<path>" entries, several
  # may be joined with ";". Checked against the pinned sha256 like a download.
  [string[]]$GitLfsArchive = @(),
  # Tests only (with -NoElfCheck): a git-lfs pin file {version, targets: {<target>: {asset, sha256}}} in place of
  # native.ts GIT_LFS (same version), for a fake release archive given with -GitLfsArchive
  # (packages/own-remote/script/fixtures/git-lfs-fake.tar.gz).
  [string]$GitLfsPin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($repo.Contains('#')) {
  throw "Repository path '$repo' contains '#', which breaks Bun/Vite path handling. Build from a worktree without '#' (e.g. C:\src\own-open-code)."
}
if ($Version -notmatch '^\d+\.\d+\.\d+-own\.\d+$') {
  throw "Version '$Version' must look like <upstream release>-own.<k>, e.g. 2.0.18-own.1 (own/FORK.md sec. 8.1)."
}
$Targets = @($Targets | ForEach-Object { $_ -split '[,;]' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$known = @('linux-x64-baseline', 'linux-arm64')
foreach ($target in $Targets) {
  if ($known -notcontains $target) { throw "Unsupported target '$target' (R1: $($known -join ', '); musl targets are R3)." }
}
if ($GitLfsPin -and -not $NoElfCheck) { throw '-GitLfsPin is for tests only (with -NoElfCheck); releases use the pins in native.ts GIT_LFS.' }

$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json
$expectedBun = ($rootPackage.packageManager -split '@')[1]
$bunVersion = (& bun --version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'bun is not on PATH' }
if ($bunVersion -ne $expectedBun) {
  throw "bun $bunVersion does not match packageManager bun@$expectedBun (root package.json)."
}

$outRoot = [IO.Path]::GetFullPath((Join-Path $repo 'own\.out'))
if (-not $OutDir) { $OutDir = Join-Path $outRoot "build\$Version" }
$OutDir = [IO.Path]::GetFullPath($OutDir)
if (-not $OutDir.StartsWith($outRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutDir must be inside $outRoot (upstream build.ts removes its output directory recursively)."
}
if (-not $NativeDir) { $NativeDir = Join-Path $outRoot 'remote\native' }
$NativeDir = [IO.Path]::GetFullPath($NativeDir)
if (-not $NativeDir.StartsWith($outRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw "NativeDir must be inside $outRoot."
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$bundler = Join-Path $repo 'packages\own-remote\script\bundle.ts'
$native = Join-Path $repo 'packages\own-remote\script\native.ts'
$bunCache = Join-Path $NativeDir 'bun-cache'
$started = Get-Date

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

# Runs a bun script that prints JSON on stdout (its progress goes to stderr, straight to the console).
function Invoke-BunJson([string]$What, [string[]]$Arguments) {
  $lines = & bun @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
  return (($lines -join "`n") | ConvertFrom-Json)
}

# 1. build id -----------------------------------------------------------------------------------------------------
if (-not $BuildId) { $BuildId = $env:OWN_BUILD_ID }
if (-not $BuildId) {
  $BuildId = (& bun $bundler build-id --version $Version).Trim()
  if ($LASTEXITCODE -ne 0 -or $BuildId -notmatch '^[0-9a-f]{12}$') { throw "build id computation failed: $BuildId" }
}
Write-Host "==> build id $BuildId (version $Version)"

# 2. Linux CLI ----------------------------------------------------------------------------------------------------
$given = @{}
foreach ($entry in ($LinuxBinary | ForEach-Object { $_ -split ';' } | Where-Object { $_ })) {
  $pair = $entry -split '=', 2
  if ($pair.Count -ne 2 -or -not $pair[1]) { throw "-LinuxBinary entry '$entry' is not <target>=<path>" }
  $given[$pair[0].Trim()] = $pair[1].Trim()
}
$binaries = @{}
$compile = @()
foreach ($target in $Targets) {
  if ($given.ContainsKey($target)) {
    $binaries[$target] = [IO.Path]::GetFullPath([string]$given[$target])
    continue
  }
  $built = Join-Path $OutDir "remote-build\$target\cli-$target\bin\opencode"
  if ($SkipCompile) {
    if (-not (Test-Path -LiteralPath $built)) { throw "-SkipCompile: no binary for $target (pass -LinuxBinary '$target=<path>')" }
    $binaries[$target] = $built
    continue
  }
  $compile += $target
}

# The native packages are fetched for every checked target: step 4 requires their files inside each binary.
$nativePackages = @()
if (-not $NoElfCheck) {
  Write-Host "==> Linux native packages (bun.lock pins, npm registry) -> $NativeDir"
  $nativePackages = @(Invoke-BunJson 'native package fetch' @($native, 'fetch', '--dir', $NativeDir, '--targets', ($Targets -join ',')))
  foreach ($item in $nativePackages) { Write-Host ("    {0}@{1}  {2} bytes  sha256 {3}" -f $item.name, $item.version, $item.bytes, $item.sha256) }
}

$runtimeChecks = @()
if ($compile.Count -gt 0) {
  $linked = $false
  try {
    if (-not $UpstreamInstall) {
      $links = @(Invoke-BunJson 'native package link' @($native, 'link', '--dir', $NativeDir, '--targets', ($compile -join ',')))
      $linked = $true
      Write-Host "==> linked $(@($links | Where-Object { $_.state -ne 'present' }).Count) native package junctions for the build"
    }
    foreach ($target in $compile) {
      $targetOut = Join-Path $OutDir "remote-build\$target"
      $buildArgs = @('run', 'script/build.ts', "--outdir=$targetOut")
      if (-not $UpstreamInstall) { $buildArgs += '--skip-install' }
      if ($SkipWebUi) { $buildArgs += '--skip-web-ui' }
      Write-Host "==> building opencode $Version (channel own, $target) -> $targetOut"
      # OWN_BUILD_IROH=0 (core P-050): no Iroh native is staged for Linux; own runs no machine links (upstream v2.4's
      # `machines`, off in own), so the binary embeds none, as upstream's Intel Mac build does.
      Invoke-WithEnv @{ OPENCODE_CHANNEL = 'own'; OPENCODE_VERSION = $Version; OPENCODE_TARGET = $target; OPENCODE_RELEASE = $null; OPENCODE_BUMP = $null; NODE_PATH = $null; BUN_INSTALL_CACHE_DIR = $bunCache; OWN_BUILD_IROH = '0' } {
        Push-Location (Join-Path $repo 'packages\cli')
        try {
          & bun @buildArgs
          if ($LASTEXITCODE -ne 0) { throw "upstream build failed for $target (exit $LASTEXITCODE)" }
        }
        finally { Pop-Location }
      }
      $built = Join-Path $targetOut "cli-$target\bin\opencode"
      if (-not (Test-Path -LiteralPath $built)) { throw "build finished but $built is missing" }
      $binaries[$target] = $built
    }
  }
  finally {
    if ($linked) {
      $removed = @(Invoke-BunJson 'native package unlink' @($native, 'unlink', '--dir', $NativeDir, '--targets', ($compile -join ',')))
      Write-Host "==> removed $($removed.Count) native package junctions"
    }
  }
  if (-not $SkipRuntimeCheck) {
    Write-Host "==> Bun $bunVersion cross-compile runtimes vs npm @oven/* and the GitHub release"
    $runtimeChecks = @(Invoke-BunJson 'runtime check' @($native, 'runtime', '--dir', $NativeDir, '--targets', ($compile -join ','), '--bun', $bunVersion, '--cache-dir', $bunCache))
    foreach ($item in $runtimeChecks) { Write-Host ("    {0}: {1} ({2} bytes) = npm = github" -f $item.target, $item.cache.sha256, $item.cache.bytes) }
  }
}

# 2b. git-lfs -----------------------------------------------------------------------------------------------------
$lfsArgs = @($native, 'lfs', '--dir', $NativeDir, '--targets', ($Targets -join ','))
foreach ($entry in ($GitLfsArchive | ForEach-Object { $_ -split ';' } | Where-Object { $_ })) { $lfsArgs += @('--archive', $entry.Trim()) }
if ($GitLfsPin) { $lfsArgs += @('--pin', [IO.Path]::GetFullPath($GitLfsPin)) }
Write-Host "==> git-lfs (pinned release, sha256) -> $NativeDir\git-lfs"
$gitLfs = @(Invoke-BunJson 'git-lfs fetch' $lfsArgs)
foreach ($item in $gitLfs) { Write-Host ("    {0}: git-lfs {1} from {2} ({3}), binary {4} bytes sha256 {5}" -f $item.target, $item.version, $item.asset, $item.source, $item.bytes, $item.sha256) }

# 3. plugins ------------------------------------------------------------------------------------------------------
# bundle.ts REMOTE_PLUGINS (script/bundle.test.ts keeps this list equal to it).
$pluginDir = Join-Path $OutDir 'plugins'
& bun $bundler plugins --out $pluginDir --version $Version --build-id $BuildId --packages 'own-accounts,own-remote,own-team,own-telemetry,own-harness,own-omo,own-creator' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'plugin bundling failed' }
Write-Host "==> plugins -> $pluginDir"

# 4. verify -------------------------------------------------------------------------------------------------------
$reports = [ordered]@{}
if (-not $NoElfCheck) {
  foreach ($target in ($binaries.Keys | Sort-Object)) {
    $report = Invoke-BunJson "binary check ($target)" @($bundler, 'verify-binary', '--version', $Version, '--target', $target, '--binary', $binaries[$target], '--native-dir', $NativeDir)
    $reports[$target] = $report
    Write-Host ("==> {0}: {1:N1} MiB, sha256 {2}, interpreter {3}, {4} embedded ELF objects" -f $target, ($report.bytes / 1MB), $report.sha256, $report.elf.interpreter, $report.embeddedElf)
  }
}

# 5. package ------------------------------------------------------------------------------------------------------
$packageArgs = @('package', '--out', $OutDir, '--version', $Version, '--build-id', $BuildId, '--plugins', $pluginDir, '--tools', $NativeDir)
foreach ($target in $binaries.Keys) { $packageArgs += @('--binary', "$target=$($binaries[$target])") }
if ($NoElfCheck) { $packageArgs += '--no-elf-check' }
$artifacts = & bun $bundler @packageArgs
if ($LASTEXITCODE -ne 0) { throw 'packaging failed' }

$commit = (& git -C $repo rev-parse HEAD).Trim()
$dirty = [bool](& git -C $repo status --porcelain)
# A -SkipCompile run (build-desktop.ps1 -RemoteSkipCompile) packs binaries an earlier run compiled. When the
# remote-build-info.json it replaces describes the same binaries (sha256 per target), that run's compile record
# (compiled targets, embedded web UI, runtime check) stays, instead of compiled = [] and embedded_web_ui = 'none'.
$infoFile = Join-Path $OutDir 'remote-build-info.json'
$record = [ordered]@{
  compiled = @($compile)
  embedded_web_ui = $(if ($SkipWebUi -or $compile.Count -eq 0) { 'none' } else { 'packages/app (classic; P-001 planned)' })
  runtime = $runtimeChecks
}
if ($compile.Count -eq 0 -and $reports.Count -gt 0 -and (Test-Path -LiteralPath $infoFile)) {
  $previous = Get-Content -Raw -LiteralPath $infoFile | ConvertFrom-Json
  $previousBinaries = $previous.PSObject.Properties['binaries']
  $changed = @($reports.Keys | Where-Object {
      $entry = if ($previousBinaries) { $previousBinaries.Value.PSObject.Properties[$_] }
      -not $entry -or $entry.Value.sha256 -ne $reports[$_].sha256
    })
  if (@($previous.compiled).Count -gt 0 -and $changed.Count -eq 0) {
    $record = [ordered]@{ compiled = @($previous.compiled); embedded_web_ui = $previous.embedded_web_ui; runtime = @($previous.runtime) }
    Write-Host "==> kept the compile record of $($record.compiled -join ', ') (same binaries)"
  }
}
$info = [ordered]@{
  version = $Version
  channel = 'own'
  build_id = $BuildId
  targets = @($binaries.Keys | Sort-Object)
  compiled = $record.compiled
  embedded_web_ui = $record.embedded_web_ui
  fork_commit = $commit
  fork_dirty = $dirty
  bun = $bunVersion
  native_packages = @($nativePackages | ForEach-Object { [ordered]@{ name = $_.name; version = $_.version; url = $_.url; integrity = $_.integrity; sha256 = $_.sha256; bytes = $_.bytes } })
  runtime = $record.runtime
  git_lfs = @($gitLfs | ForEach-Object { [ordered]@{ target = $_.target; version = $_.version; asset = $_.asset; url = $_.url; source = $_.source; archive_sha256 = $_.archive.sha256; archive_bytes = $_.archive.bytes; sha256 = $_.sha256; bytes = $_.bytes } })
  binaries = $reports
  built_at = (Get-Date).ToUniversalTime().ToString('o')
  build_seconds = [int]((Get-Date) - $started).TotalSeconds
  remote_artifacts = ($artifacts -join "`n" | ConvertFrom-Json)
}
[IO.File]::WriteAllText($infoFile, ($info | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
foreach ($target in ($binaries.Keys | Sort-Object)) {
  $archive = Get-Item -LiteralPath (Join-Path $OutDir "remote\$target.tar.gz")
  Write-Host ("==> remote\{0}.tar.gz  {1:N1} MiB" -f $target, ($archive.Length / 1MB))
}
foreach ($item in $gitLfs) {
  $tool = Get-Item -LiteralPath (Join-Path $OutDir "remote\tools\git-lfs\$($item.version)\$($item.target)\git-lfs")
  Write-Host ("==> remote\tools\git-lfs\{0}\{1}\git-lfs  {2:N1} MiB" -f $item.version, $item.target, ($tool.Length / 1MB))
}
Write-Host "==> remote bundles: $(Join-Path $OutDir 'remote')"
