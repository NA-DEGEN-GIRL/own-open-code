<#
.SYNOPSIS
  Build the remote-PC client-only desktop app for another Windows architecture, cross-built on this x64 PC: the
  own-desktop shell with no service payload, whose window is the remote-client page (pair with another PC, open its
  own-web in a pinned window). Default: Windows ARM64. Nothing is installed or started.

.DESCRIPTION
  own/reports/win-arm64-2026-11-06.md. Order:

    1. natives   own\scripts\client-natives.ts --arch <arch>: Electron's win32-<arch> zip (sha256 = the installed electron
                 package's checksums.json) unpacked into own\.out\cache\client-<arch>, and @lydell/node-pty-win32-<arch>
                 (sha512 = bun.lock) unpacked into packages\own-desktop\node_modules\@lydell for packaging. Downloaded
                 only when the cache lacks a verified copy; -Offline refuses to download. Also the ffi-rs binding
                 @yuuang/ffi-rs-win32-<arch>-msvc (sha512 = bun.lock and a vetted one, decisions AF-1) unpacked beside
                 the ffi-rs wrapper in bun's store, where the main bundle takes it into out\main\chunks.
    2. shell     electron-vite build with OWN_DESKTOP_CLIENT_ONLY=1 (main's client switch, src\client as the renderer),
                 OPENCODE_TARGET=windows-<arch> (upstream's node-pty choice) and OWN_VERSION.
    3. package   electron-builder --win --<arch> with OWN_ELECTRON_DIST = that Electron, into
                 <out>\desktop-client-<arch>: win-<arch>-unpacked\ and own-desktop-client-<version>-win-<arch>.exe
                 (oneClick per-user NSIS, shell only: installer.nsh compiles none of the service macros without a
                 payload). The node-pty and ffi-rs folders of step 1 are removed again whatever happens.
    4. checks    own\scripts\client-check.ts: layout, PE machine of every image (elevate.exe x86 allowed), app.asar
                 (client page, client switch, the <arch> node-pty only, no updater, no payload), the installer's
                 archive (7-Zip), and the signature inventory (pe-inventory.json). A failed check fails the build.
    report       <out>\desktop-client-<arch>\desktop-client-build.json: sizes, hashes, inputs, checks.

  The shell's build folder packages\own-desktop\out is left holding the client bundle; every full build
  (build-desktop.ps1) rebuilds it first. Run this after build-desktop.ps1, or through its -Client switch.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop-client.ps1 -Version 2.2.5-own.3
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop-client.ps1 -Version 2.2.5-own.3 -Offline
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$OutDir,
  [ValidateSet('arm64')]
  [string]$Arch = 'arm64',
  # win-<arch>-unpacked only (electron-builder --dir), no NSIS installer.
  [switch]$NoInstaller,
  # Use only the verified cache in own\.out\cache\client-<arch>; never download.
  [switch]$Offline
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($repo.Contains('#')) {
  throw "Repository path '$repo' contains '#', which breaks Bun/Vite path handling. Build from a worktree without '#' (e.g. C:\src\own-open-code)."
}
$started = Get-Date
$rootPackage = Get-Content -Raw -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json
$expectedBun = ($rootPackage.packageManager -split '@')[1]
$bunVersion = (& bun --version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'bun is not on PATH' }
if ($bunVersion -ne $expectedBun) { throw "bun $bunVersion does not match packageManager bun@$expectedBun (root package.json)." }
if (-not $Version) { $Version = "$($rootPackage.version)-own.0" }
if ($Version -notmatch '^\d+\.\d+\.\d+-own\.\d+$') { throw "Version '$Version' must look like <upstream release>-own.<k>, e.g. 2.2.5-own.3." }

$outRoot = Join-Path $repo 'own\.out'
if (-not $OutDir) { $OutDir = Join-Path $outRoot "build\$Version" }
$OutDir = [IO.Path]::GetFullPath($OutDir)
if (-not $OutDir.StartsWith([IO.Path]::GetFullPath($outRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutDir must be inside $outRoot."
}
$desktopPackage = Join-Path $repo 'packages\own-desktop'
$clientOut = Join-Path $OutDir "desktop-client-$Arch"
$installerName = "own-desktop-client-$Version-win-$Arch.exe"

# Same contract as build-desktop.ps1: native tools write progress to stderr, exit codes decide.
function Invoke-Native([string]$Label, [string]$WorkingDirectory, [hashtable]$Environment, [scriptblock]$Body) {
  $saved = @{}
  foreach ($name in $Environment.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $Environment[$name], 'Process')
  }
  $previous = $ErrorActionPreference
  Push-Location $WorkingDirectory
  try {
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    & $Body
    $code = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previous
    Pop-Location
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  }
  if ($code -ne 0) { throw "$Label failed (exit $code)" }
}

$steps = [ordered]@{}
function Step([string]$Name, [scriptblock]$Body) {
  Write-Host "==> $Name"
  $at = Get-Date
  & $Body
  $steps[$Name] = [int]((Get-Date) - $at).TotalSeconds
  Write-Host ("    {0}: {1} s" -f $Name, $steps[$Name])
}

$natives = $null
$nativesScript = Join-Path $repo 'own\scripts\client-natives.ts'
Step 'natives' {
  $nativeArgs = @($nativesScript, '--arch', $Arch)
  if ($Offline) { $nativeArgs += '--offline' }
  Invoke-Native 'client-natives' $repo @{} { $script:nativeLines = @(& bun @nativeArgs) }
  $script:natives = ($script:nativeLines | Select-Object -Last 1) | ConvertFrom-Json
  Write-Host "    electron $($natives.electron.version) $Arch (sha256 $($natives.electron.sha256))"
  Write-Host "    $($natives.pty.name)@$($natives.pty.version)"
  Write-Host "    $($natives.ffi.name)@$($natives.ffi.version) ($($natives.ffi.integrity))"
}

# OWN_DESKTOP_PAYLOAD stays unset (electron-builder.config.ts refuses it with the client switch).
$clientEnv = @{
  OWN_DESKTOP_CLIENT_ONLY = '1'
  OPENCODE_TARGET = "windows-$Arch"
  OWN_VERSION = $Version
  OWN_DESKTOP_OUT = $clientOut
  OWN_ELECTRON_DIST = $natives.electron.dist
  OWN_DESKTOP_PAYLOAD = $null
  ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
}
try {
  Step 'shell-build' { Invoke-Native 'electron-vite build (client)' $desktopPackage $clientEnv { & bun run build } }
  Step 'shell-package' {
    if (Test-Path -LiteralPath $clientOut) { Remove-Item -LiteralPath $clientOut -Recurse -Force }
    $builderScript = if ($NoInstaller) { 'package' } else { 'package:win' }
    Invoke-Native 'electron-builder (client)' $desktopPackage $clientEnv { & bun run $builderScript "--$Arch" }
  }
}
finally {
  & bun $nativesScript --arch $Arch --remove | Out-Null
}

$checkReport = Join-Path $clientOut 'client-check.json'
$checksPassed = $true
Step 'checks' {
  $checkArgs = @((Join-Path $repo 'own\scripts\client-check.ts'), '--dir', $clientOut, '--version', $Version, '--arch', $Arch)
  if ($NoInstaller) { $checkArgs += '--no-installer' }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & bun @checkArgs | Write-Host; $script:checksPassed = $LASTEXITCODE -eq 0 } finally { $ErrorActionPreference = $previous }
}

$installer = Join-Path $clientOut $installerName
$installerBytes = if (Test-Path -LiteralPath $installer) { (Get-Item -LiteralPath $installer).Length } else { $null }
$unpacked = Join-Path $clientOut "win-$Arch-unpacked"
$info = [ordered]@{
  version = $Version
  arch = $Arch
  kind = 'client-only'
  out = $clientOut
  installer = $(if ($null -ne $installerBytes) { $installer } else { $null })
  installer_bytes = $installerBytes
  installer_sha256 = $(if ($null -ne $installerBytes) { (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null })
  shell_exe = Join-Path $unpacked 'own-desktop.exe'
  shell_exe_sha256 = (Get-FileHash -LiteralPath (Join-Path $unpacked 'own-desktop.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  unpacked_bytes = (Get-ChildItem -LiteralPath $unpacked -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
  electron = [ordered]@{ version = $natives.electron.version; zip_sha256 = $natives.electron.sha256 }
  node_pty = [ordered]@{ name = $natives.pty.name; version = $natives.pty.version; integrity = $natives.pty.integrity }
  ffi_rs = [ordered]@{ name = $natives.ffi.name; version = $natives.ffi.version; integrity = $natives.ffi.integrity }
  checks = $(if (Test-Path -LiteralPath $checkReport) { (Get-Content -Raw -LiteralPath $checkReport | ConvertFrom-Json).checks } else { $null })
  checks_passed = $checksPassed
  installed = $false
  steps_seconds = $steps
  build_seconds = [int]((Get-Date) - $started).TotalSeconds
  built_at = (Get-Date).ToUniversalTime().ToString('o')
  fork_commit = (& git -C $repo rev-parse HEAD).Trim()
  fork_dirty = [bool](& git -C $repo status --porcelain)
}
$utf8 = New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllText((Join-Path $clientOut 'desktop-client-build.json'), ($info | ConvertTo-Json -Depth 5), $utf8)
if ($null -ne $installerBytes) { Write-Host ("==> installer {0} ({1:N1} MB, client only, not installed)" -f $installer, ($installerBytes / 1MB)) }
Write-Host "==> unpacked  $unpacked"
if (-not $checksPassed) { throw "client build checks failed (see $checkReport)" }
Write-Host ("==> done in {0} s" -f $info.build_seconds)
