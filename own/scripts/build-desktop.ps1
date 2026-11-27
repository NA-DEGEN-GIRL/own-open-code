<#
.SYNOPSIS
  Build the own desktop release: own-channel CLI (build-own.ps1), own-web (the desktop renderer, app\<ver>\web), the
  own-desktop shell (win-unpacked) and one NSIS installer that carries the service payload (app\<ver> + launcher) and
  installs, updates and removes both (USER-GUIDE sec. 2). Nothing is installed or started.

.DESCRIPTION
  Order (own/FORK.md sec. 8.2 steps 1, 1b, 2, 5; 05 sec. 10.1):

    1. CLI       own\scripts\build-own.ps1 -Version <v>  (upstream build.ts, own channel, own-web embedded as the web
                 fallback (P-001), verified in temp dirs). It removes its output directory first, so every later step
                 writes after it.
    1a. id       the release build id (FORK sec. 8.2 1b, packages\own-remote\script\bundle.ts build-id), computed once.
    3. plugins   own-accounts, own-remote, own-team, own-telemetry, own-computer-use, own-import, own-harness, own-omo,
                 own-creator: nine single-file bundles (activation order, 06 sec. 2.6, 09 sec. 5.1, 10 H0) with the three release defines
                 and their define/quote check (bundle.ts plugins) -> <out>\plugins\<name>\index.js. own-import's scan
                 Worker is bundled first and embedded in its index.js as the define OWN_IMPORT_WORKER_SOURCE (run from a
                 Blob URL), so every bundle stays one file. The SSH remote bundles never carry own-import (PC-only);
                 they carry own-harness, as here (10 sec. 6.1), and own-omo last (15 sec. 1). own-omo's folder also
                 gets the patched oh-my-opencode runtime omo-runtime.js with its LICENSE.md, THIRD-PARTY-NOTICES.md,
                 MODIFICATIONS.md and skills\ (packages\own-omo\script\bundle.ts, 15 sec. 2).
    3a. claude   own\scripts\claude-auth-bundle.ts: the third-party Claude subscription plugin that ships inside the app
                 and is always on (02 sec. 8.2, user decision 2026-10-18): opencode-claude-auth-v2 installed from
                 own\vendor\claude-auth\package-lock.json (npm ci, from the npm cache when it holds it), its version
                 and integrity verified, own\vendor\claude-auth\patches\<pinned version>.json applied with its pre- and
                 post-hashes, bundled into one file -> <out>\plugins\claude-auth (server.js, package.json,
                 own-bundle.json with the build id and every file's sha256, node_modules\opencode-claude-auth-v2\
                 {package.json, index.js, LICENSE, dist\index.js}; about 90 KB). Any hash that differs fails the build.
                 The SSH remote bundles never carry it (04 sec. 8.11: this PC relays).
    6. remote    (-Remote) own\scripts\build-remote.ps1 with the same version, output directory and build id: the
                 own-channel Linux CLIs and remote\<target>.tar.gz + remote\manifest.json (04 sec. 5.2), with the
                 pinned static git-lfs beside the archives in remote\tools\git-lfs\<ver>\<target>\ (06 sec. 4.13).
    3b. vault    cargo build --release --locked of own\native\own-vault (-SkipVault: reuse the built exe).
    3c. cu-helper own\native\own-cu-helper\build.ps1 (the computer-use helper, C# built by the in-box .NET Framework
                 csc.exe) -> own-cu-helper.exe. While that folder has no build.ps1 the step is skipped with a warning
                 and the payload ships without the helper (only `driver: "helper"` needs it; the default in-process
                 driver does not).
    4. templates own\config\ratecards.default.json.
    1b. rpcHash  packages\own-desktop\scripts\rpc-hash.mjs: the shell <-> renderer IPC contract hash (05 sec. 5.5).
                 It must equal the committed packages\own-desktop\src\shared\rpc-hash.ts, which own-web's desktop
                 host imports; the value goes to the shell build (OWN_RPC_HASH) and to manifest.json.
    2. own-web   vite production build straight into <out>\web (not packages\own-web\dist, which other tools use),
                 source maps removed (SC2: no renderer source maps). The desktop chunk must carry the rpcHash.
    5a. shell    electron-vite build (main/preload stamped with OWN_RPC_HASH and OWN_VERSION, substitutions checked).
    manifest     app\<ver>\manifest.json the shell reads (version, build_id, desktop.rpc_hash / desktop.rpcHash,
                 installer name, artifact hashes of the CLI, web, plugins, vault and templates, remote_artifacts from
                 remote\remote_artifacts.json, active core patches). The installer carries this copy, so its
                 desktop.installer_sha256 is null; <out>\manifest.json gets the hash once the installer exists.
    stage        <out>\app\: the exact app\<ver>\ install layout (01 sec. 5.1; own.ps1 install names it in app\current.json,
                 no junction): opencode.exe, web\, plugins\,
                 remote\ (when built), own-vault.exe, own-cu-helper.exe (when built), templates\, manifest.json;
                 <out>\bin\: own.cmd, own.ps1.
                 Together they are the payload: '<out>\bin\own.cmd install' installs it by hand (USER-GUIDE sec. 2.6).
    5b. package  electron-builder --win into <out>\desktop: win-unpacked\ and the NSIS installer
                 own-desktop-<v>-win-x64.exe (oneClick per-user, no opencode:// protocol, no publish/app-update.yml, no
                 bundled CLI, solid LZMA2). With OWN_DESKTOP_PAYLOAD=<out> the payload goes into resources\own-payload
                 and build\installer.nsh runs 'own.ps1 install --from <it> --move' after the shell (not with
                 -NoInstaller; the run and its exit code are logged to %TEMP%\own-installer.log and OWN_HOME\install.log,
                 and /S ends with the launcher's exit code when the service part fails). The installer is only built and
                 inspected, never run.
    report       <out>\manifest.json (with the installer's sha256) and <out>\desktop-build.json with sizes and the
                 static checks below.

  Static checks (the build fails when one fails, after writing desktop-build.json):
    - G-D2: the main/preload bundle contains no setAsDefaultProtocolClient call and no ai.opencode.desktop app id;
      win-unpacked has no resources\app-update.yml.
    - G-D6: the shell bundle and the own-web desktop chunk carry the same rpcHash as manifest.json.
    - SC2 (05 sec. 9.1): the shell in win-unpacked (without resources\own-payload) <= 460 MB, no source maps in the
      shell renderer or web\; the installer with the payload <= 470 MB (with the SSH remote bundles, which are gzip
      already; 400 MB before Bun 1.4.4, MR8-27) or <= 260 MB (without).
    - installer contents (when 7-Zip's 7z.exe is on PATH or in Program Files; else recorded as skipped): the embedded
      preflight launcher equals bin\own.ps1, app-64.7z holds resources\own-payload with every file of app\ and bin\
      (the .tar.gz bundles sit next to it as NSIS files).

  Output layout (own\.out\build\<version>\, the same root build-own.ps1 uses):
    cli-windows-x64\bin\opencode.exe, build-info.json      step 1
    plugins\<name>\index.js                                step 3
    plugins\claude-auth\                                   step 3a
    remote\<target>.tar.gz, remote\manifest.json,          step 6 (-Remote; remote-build\, remote-stage\ and
      remote-build-info.json                                 remote-build-info.json are build-remote.ps1's)
    own-vault.exe, own-cu-helper.exe, templates\           steps 3b, 3c, 4
    web\                                                   step 2 (the renderer, app\<ver>\web)
    desktop\win-unpacked\own-desktop.exe                   step 5b, for tests (never installed by this script)
    desktop\own-desktop-<version>-win-x64.exe              step 5b, the one-step NSIS installer (shell + payload)
    manifest.json, desktop-build.json
    desktop-client-arm64\                                  (-Client) build-desktop-client.ps1: the Windows ARM64
                                                           client-only installer own-desktop-client-<v>-win-arm64.exe
    app\                                                   the app\<ver>\ layout to install (the payload's app\)
    bin\own.cmd, bin\own.ps1                               the launcher (OWN_HOME\bin, the payload's bin\)

  Electron: the shell packages the Electron in packages\own-desktop\node_modules\electron\dist. When it is missing,
  it is installed from -ElectronCache (a folder holding electron-v<ver>-win32-x64.zip) or downloaded (~151 MB).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop.ps1 -Version 2.0.18-own.1 -Remote
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-desktop.ps1 -Version 2.0.18-own.1 -SkipService
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$OutDir,
  # Reuse the CLI already in <out>\cli-windows-x64 instead of running build-own.ps1.
  [switch]$SkipService,
  # Passed to build-own.ps1.
  [switch]$NoVerify,
  [switch]$SkipWebUi,
  # win-unpacked only (electron-builder --dir), no NSIS installer.
  [switch]$NoInstaller,
  [string]$ElectronCache,
  # Also build the SSH remote bundles (build-remote.ps1) into the same output directory.
  [switch]$Remote,
  # Passed to build-remote.ps1 as -SkipCompile (reuse <out>\remote-build\<target>\...; needs -SkipService).
  [switch]$RemoteSkipCompile,
  # Release build id (12 hex); default $env:OWN_BUILD_ID, else computed from the inputs (FORK sec. 8.2 1b).
  [string]$BuildId,
  # Reuse own\native\own-vault\target\release\own-vault.exe instead of running cargo.
  [switch]$SkipVault,
  # After the x64 build and its checks: also the Windows ARM64 remote-PC client-only installer (build-desktop-client.ps1) into
  # <out>\desktop-client-arm64. Its Electron and node-pty come from own\.out\cache\client-arm64 (downloaded and
  # verified there when missing: warm it with `bun own/scripts/client-natives.ts --arch arm64 --fetch` before an
  # offline build). The x64 outputs are not touched.
  [switch]$Client
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
if ($bunVersion -ne $expectedBun) {
  throw "bun $bunVersion does not match packageManager bun@$expectedBun (root package.json, own/FORK.md sec. 3)."
}
if (-not $Version) { $Version = "$($rootPackage.version)-own.0" }
if ($Version -notmatch '^\d+\.\d+\.\d+-own\.\d+$') {
  throw "Version '$Version' must look like <upstream release>-own.<k>, e.g. 2.0.18-own.1 (own/FORK.md sec. 8.1)."
}

$outRoot = Join-Path $repo 'own\.out'
if (-not $OutDir) { $OutDir = Join-Path $outRoot "build\$Version" }
$OutDir = [IO.Path]::GetFullPath($OutDir)
if (-not $OutDir.StartsWith([IO.Path]::GetFullPath($outRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutDir must be inside $outRoot (build-own.ps1 and this script only write under own\.out)."
}
$desktopPackage = Join-Path $repo 'packages\own-desktop'
$webPackage = Join-Path $repo 'packages\own-web'
$webOut = Join-Path $OutDir 'web'
$desktopOut = Join-Path $OutDir 'desktop'
$cliTarget = 'cli-windows-x64'
$cliExe = Join-Path $OutDir "$cliTarget\bin\opencode.exe"

# Native tools write progress to stderr; Windows PowerShell 5.1 turns redirected stderr into terminating errors
# under ErrorActionPreference=Stop. Exit codes decide success instead.
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

function Get-TreeSize([string]$Path) {
  $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return [int64]0 }
  return [int64]$sum
}

# sha256 over "<relative path>`n<file sha256>`n" in ordinal path order (forward slashes).
function Get-TreeHash([string]$Path) {
  $root = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\') + '\'
  $lines = New-Object System.Text.StringBuilder
  $files = Get-ChildItem -LiteralPath $Path -Recurse -File -Force |
    ForEach-Object { [pscustomobject]@{ Rel = $_.FullName.Substring($root.Length).Replace('\', '/'); Full = $_.FullName } }
  $sorted = [System.Collections.Generic.List[object]]::new()
  foreach ($file in $files) { $sorted.Add($file) }
  $sorted.Sort([Comparison[object]] { param($a, $b) [string]::CompareOrdinal($a.Rel, $b.Rel) })
  foreach ($file in $sorted) {
    $hash = (Get-FileHash -LiteralPath $file.Full -Algorithm SHA256).Hash.ToLowerInvariant()
    [void]$lines.Append("$($file.Rel)`n$hash`n")
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($lines.ToString())) } finally { $sha.Dispose() }
  return 'sha256-tree:' + (($digest | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Test-FilesContain([string]$Path, [string]$Filter, [string]$Needle) {
  foreach ($file in Get-ChildItem -LiteralPath $Path -Recurse -File -Filter $Filter -Force) {
    if ([IO.File]::ReadAllText($file.FullName).Contains($Needle)) { return $file.FullName }
  }
  return $null
}

# The file list of an app.asar: its header is a JSON string after 16 bytes (pickle sizes; the string's length at 12).
function Get-AsarHeader([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $head = New-Object byte[] 16
    if ($stream.Read($head, 0, 16) -ne 16) { throw "$Path is not an asar archive" }
    $length = [BitConverter]::ToInt32($head, 12)
    $json = New-Object byte[] $length
    $read = 0
    while ($read -lt $length) {
      $count = $stream.Read($json, $read, $length - $read)
      if ($count -le 0) { throw "$Path ends inside its header" }
      $read += $count
    }
    return [Text.Encoding]::UTF8.GetString($json)
  }
  finally { $stream.Dispose() }
}

$steps = [ordered]@{}
function Step([string]$Name, [scriptblock]$Body) {
  Write-Host "==> $Name"
  $at = Get-Date
  & $Body
  $steps[$Name] = [int]((Get-Date) - $at).TotalSeconds
  # In the log too (desktop-build.json's steps_seconds has them), so a slow release step shows where it went.
  Write-Host ("    {0}: {1} s (build {2} s)" -f $Name, $steps[$Name], [int]((Get-Date) - $started).TotalSeconds)
}

# ---------------------------------------------------------------- 1. CLI

if ($SkipService) {
  if (-not (Test-Path -LiteralPath $cliExe)) { throw "-SkipService: $cliExe is missing (run without -SkipService once)." }
  Write-Host "==> CLI: reusing $cliExe"
}
else {
  Step 'cli' {
    $buildOwn = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build-own.ps1'), '-Version', $Version, '-OutDir', $OutDir)
    if ($NoVerify) { $buildOwn += '-NoVerify' }
    if ($SkipWebUi) { $buildOwn += '-SkipWebUi' }
    Invoke-Native 'build-own.ps1' $repo @{} { & powershell.exe @buildOwn }
  }
}

# ---------------------------------------------------------------- 1a. build id, 3. plugins, 6. remote, 3b. vault, 3c. cu-helper, 4. templates

$bundler = Join-Path $repo 'packages\own-remote\script\bundle.ts'
$pluginDir = Join-Path $OutDir 'plugins'
# Activation order (06 sec. 2.6, 09 sec. 5.1, bundle.ts DESKTOP_PLUGINS): own-team third, so the claude-auth slot after
# it never reloads it; own-computer-use after own-telemetry; own-import after it (no hooks, so adding it reloads no
# other plugin); own-harness after it (10 H0: no hooks yet, so adding it reloads no other plugin; its later request hooks
# must transform the request after every other own plugin's); own-omo last (15: its request hooks run after
# own-harness's, in omo sessions only; its folder also gets omo-runtime.js and omo's license, notices and
# MODIFICATIONS.md); own-creator after it (17: creator mode and own's extensions, PC-only). bundle.ts fails when a bundle lacks one of the release defines (own-import: also its Worker's
# source) as a string literal.
$pluginNames = @('own-accounts', 'own-remote', 'own-team', 'own-telemetry', 'own-computer-use', 'own-import', 'own-harness', 'own-omo', 'own-creator')
if ($RemoteSkipCompile -and -not $SkipService) { throw '-RemoteSkipCompile needs -SkipService (build-own.ps1 removes the output directory, including remote-build\).' }
if (-not $BuildId) { $BuildId = $env:OWN_BUILD_ID }
if (-not $BuildId) {
  $BuildId = (& bun $bundler build-id --version $Version | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0 -or $BuildId -notmatch '^[0-9a-f]{12}$') { throw "build id computation failed: $BuildId" }
  $BuildId = $BuildId.Trim()
}
Write-Host "    build id $BuildId"

Step 'plugins' {
  Invoke-Native 'plugin bundles' $repo @{} {
    & bun $bundler plugins --out $pluginDir --version $Version --build-id $BuildId --packages ($pluginNames -join ',') | Out-Null
  }
  foreach ($name in $pluginNames) {
    if (-not (Test-Path -LiteralPath (Join-Path $pluginDir "$name\index.js"))) { throw "plugin bundle $name is missing" }
  }
  # own-omo's second file: the patched oh-my-opencode runtime with omo's license, notices and MODIFICATIONS.md (15).
  foreach ($file in @('omo-runtime.js', 'LICENSE.md', 'THIRD-PARTY-NOTICES.md', 'MODIFICATIONS.md')) {
    if (-not (Test-Path -LiteralPath (Join-Path $pluginDir "own-omo\$file"))) { throw "own-omo is missing $file" }
  }
  # own-accounts' imagegen skill is adapted from OpenAI Codex's (Apache-2.0, 02 sec. 9.6): its license and changes go with it.
  foreach ($file in @('imagegen-LICENSE.txt', 'imagegen-MODIFICATIONS.md')) {
    if (-not (Test-Path -LiteralPath (Join-Path $pluginDir "own-accounts\$file"))) { throw "own-accounts is missing $file" }
  }
}

# 02 sec. 8.2: the Claude subscription plugin, between own-team and own-telemetry in the config (the launcher's managed
# entry). The script fails on any lock, integrity or patch hash that differs and writes nothing then.
$claudeBundle = Join-Path $pluginDir 'claude-auth'
Step 'claude-auth' {
  Invoke-Native 'claude-auth bundle' $repo @{} {
    & bun (Join-Path $repo 'own\scripts\claude-auth-bundle.ts') --out $claudeBundle --build-id $BuildId | Out-Null
  }
  if (-not (Test-Path -LiteralPath (Join-Path $claudeBundle 'own-bundle.json'))) { throw "the claude-auth bundle wrote no $claudeBundle\own-bundle.json" }
}

if ($Remote) {
  Step 'remote' {
    $buildRemote = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build-remote.ps1'), '-Version', $Version, '-OutDir', $OutDir, '-BuildId', $BuildId)
    if ($RemoteSkipCompile) { $buildRemote += '-SkipCompile' }
    Invoke-Native 'build-remote.ps1' $repo @{} { & powershell.exe @buildRemote }
  }
}

$vaultSource = Join-Path $repo 'own\native\own-vault\target\release\own-vault.exe'
Step 'vault' {
  if (-not $SkipVault) {
    Invoke-Native 'cargo build own-vault' $repo @{} {
      & cargo build --release --locked --quiet --manifest-path (Join-Path $repo 'own\native\own-vault\Cargo.toml')
    }
  }
  if (-not (Test-Path -LiteralPath $vaultSource)) { throw "$vaultSource is missing (cargo build --release --locked --manifest-path own/native/own-vault/Cargo.toml)" }
  Copy-Item -LiteralPath $vaultSource -Destination (Join-Path $OutDir 'own-vault.exe') -Force
}

# The computer-use helper (own.computer-use's Windows driver), built by its own script with the in-box csc.exe. A
# checkout without that script builds a payload without the helper instead of failing the release.
$cuHelperBuild = Join-Path $repo 'own\native\own-cu-helper\build.ps1'
$cuHelperSource = Join-Path $repo 'own\native\own-cu-helper\target\own-cu-helper.exe'
$cuHelperOut = Join-Path $OutDir 'own-cu-helper.exe'
Step 'cu-helper' {
  if (Test-Path -LiteralPath $cuHelperOut) { Remove-Item -LiteralPath $cuHelperOut -Force }
  if (-not (Test-Path -LiteralPath $cuHelperBuild)) {
    Write-Warning "$cuHelperBuild is missing: the payload has no own-cu-helper.exe, so computer use with driver: helper reports driver_unavailable (the default in-process driver does not need it)"
    return
  }
  # -OutDir explicitly: Windows PowerShell 5.1 can leave $PSScriptRoot empty in the script's parameter defaults.
  $cuHelperArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $cuHelperBuild, '-OutDir', (Split-Path -Parent $cuHelperSource))
  Invoke-Native 'own-cu-helper build' $repo @{} { & powershell.exe @cuHelperArgs }
  if (-not (Test-Path -LiteralPath $cuHelperSource)) { throw "$cuHelperSource is missing after $cuHelperBuild" }
  Copy-Item -LiteralPath $cuHelperSource -Destination $cuHelperOut -Force
}

$templatesOut = Join-Path $OutDir 'templates'
Step 'templates' {
  if (Test-Path -LiteralPath $templatesOut) { Remove-Item -LiteralPath $templatesOut -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $templatesOut | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo 'own\config\ratecards.default.json') -Destination (Join-Path $templatesOut 'ratecards.default.json')
}

# ---------------------------------------------------------------- 1b. rpcHash

$rpcHash = $null
Step 'rpc-hash' {
  $script:rpcHash = (& bun (Join-Path $desktopPackage 'scripts\rpc-hash.mjs') --check | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0 -or $script:rpcHash -notmatch '^[0-9a-f]{16}$') {
    throw "rpcHash check failed: packages\own-desktop\src\shared\rpc-hash.ts is stale (bun run --cwd packages/own-desktop rpc-hash --write, then rebuild)."
  }
}
$rpcHash = $script:rpcHash
Write-Host "    rpcHash $rpcHash"

# ---------------------------------------------------------------- 2. own-web

Step 'web' {
  if (Test-Path -LiteralPath $webOut) { Remove-Item -LiteralPath $webOut -Recurse -Force }
  Invoke-Native 'own-web vite build' $webPackage @{} { & bun run build --outDir $webOut --emptyOutDir --logLevel warn }
  if (-not (Test-Path -LiteralPath (Join-Path $webOut 'index.html'))) { throw "own-web build wrote no index.html to $webOut" }
  # 03 sec. 4.3.1: the user manual ships inside the web build (own-web src/manual/vite.ts), offline for the desktop
  # renderer, the gateway and the web fallback.
  if (-not (Get-ChildItem -LiteralPath (Join-Path $webOut '_assets') -File -Filter 'manual-*.html')) { throw "own-web build has no user manual (_assets\manual-*.html) in $webOut" }
  Get-ChildItem -LiteralPath $webOut -Recurse -File -Filter '*.map' | Remove-Item -Force
}

# ---------------------------------------------------------------- 5a. shell build

Step 'electron' {
  $electronExe = Join-Path $desktopPackage 'node_modules\electron\dist\electron.exe'
  if ($env:OWN_ELECTRON_DIST) { Write-Host "    OWN_ELECTRON_DIST=$env:OWN_ELECTRON_DIST" }
  elseif (-not (Test-Path -LiteralPath $electronExe)) {
    $cacheEnv = @{}
    if ($ElectronCache) { $cacheEnv = @{ electron_config_cache = $ElectronCache; ELECTRON_CACHE = $ElectronCache } }
    Invoke-Native 'electron install' $desktopPackage $cacheEnv { & bun run electron:install }
  }
  else { Write-Host "    $electronExe" }
}

$shellEnv = @{ OWN_RPC_HASH = $rpcHash; OWN_VERSION = $Version; OWN_DESKTOP_OUT = $desktopOut }
Step 'shell-build' {
  Invoke-Native 'electron-vite build' $desktopPackage $shellEnv { & bun run build }
}

# ---------------------------------------------------------------- manifest (the app\<ver>\ copy)

$installerName = "own-desktop-$Version-win-x64.exe"
$installer = Join-Path $desktopOut $installerName
$checks = [ordered]@{}

$desktopPackageJson = Get-Content -Raw -LiteralPath (Join-Path $desktopPackage 'package.json') | ConvertFrom-Json
$commit = (& git -C $repo rev-parse HEAD).Trim()
$dirty = [bool](& git -C $repo status --porcelain)
function Get-FileSha([string]$Path) { return 'sha256:' + (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$cliSha = if (Test-Path -LiteralPath $cliExe) { Get-FileSha $cliExe } else { $null }

$artifacts = [ordered]@{ 'opencode.exe' = $cliSha; 'web/' = (Get-TreeHash $webOut) }
foreach ($name in $pluginNames) { $artifacts["plugins/$name/index.js"] = Get-FileSha (Join-Path $pluginDir "$name\index.js") }
$artifacts['plugins/own-omo/omo-runtime.js'] = Get-FileSha (Join-Path $pluginDir 'own-omo\omo-runtime.js')
$artifacts['plugins/claude-auth/'] = Get-TreeHash $claudeBundle
$artifacts['own-vault.exe'] = Get-FileSha (Join-Path $OutDir 'own-vault.exe')
if (Test-Path -LiteralPath $cuHelperOut) { $artifacts['own-cu-helper.exe'] = Get-FileSha $cuHelperOut }
$artifacts['templates/ratecards.default.json'] = Get-FileSha (Join-Path $templatesOut 'ratecards.default.json')

# Remote bundles: only the ones built with this build id (a -SkipService rebuild may find an older remote\).
$remoteDir = Join-Path $OutDir 'remote'
$remoteArtifacts = $null
if (Test-Path -LiteralPath (Join-Path $remoteDir 'remote_artifacts.json')) {
  $remoteManifest = Get-Content -Raw -LiteralPath (Join-Path $remoteDir 'manifest.json') | ConvertFrom-Json
  $checks['remote.build-id'] = $remoteManifest.build_id -eq $BuildId
  if ($checks['remote.build-id']) { $remoteArtifacts = Get-Content -Raw -LiteralPath (Join-Path $remoteDir 'remote_artifacts.json') | ConvertFrom-Json }
}
elseif ($Remote) { throw "build-remote.ps1 wrote no $remoteDir\remote_artifacts.json" }

# Active core patches (own/ledger/core-patches.yaml): P-001/P-002 are in the source this build compiled.
$ledgerText = Get-Content -Raw -LiteralPath (Join-Path $repo 'own\ledger\core-patches.yaml')
$patchesActive = @(($ledgerText -split '(?m)^- id: ') | Select-Object -Skip 1 |
    Where-Object { $_ -match '(?m)^  status: active\s*$' } | ForEach-Object { ($_ -split '\s')[0] })
$buildInfoFile = Join-Path $OutDir 'build-info.json'
$embeddedWebUi = if (Test-Path -LiteralPath $buildInfoFile) { (Get-Content -Raw -LiteralPath $buildInfoFile | ConvertFrom-Json).embedded_web_ui } else { $null }
# Windows PowerShell 5.1's ConvertFrom-Json rejects the lockfile's empty "" package key: read the one entry by pattern.
$claudeLockText = Get-Content -Raw -LiteralPath (Join-Path $repo 'own\vendor\claude-auth\package-lock.json')
$claudeEntry = [regex]::Match($claudeLockText, '"node_modules/opencode-claude-auth-v2"\s*:\s*\{[^}]*\}').Value
$claudePackage = [pscustomobject]@{
  version = [regex]::Match($claudeEntry, '"version"\s*:\s*"([^"]+)"').Groups[1].Value
  integrity = [regex]::Match($claudeEntry, '"integrity"\s*:\s*"([^"]+)"').Groups[1].Value
}
$claudeShim = Get-Content -Raw -LiteralPath (Join-Path $repo 'own\vendor\claude-auth\package.json') | ConvertFrom-Json

# app\<ver>\manifest.json shape (FORK sec. 8.3). The shell reads version and desktop.rpc_hash (05 sec. 5.5; the
# camelCase key of FORK sec. 8.3 is written too, the shell accepts both). own.ps1 install verifies the payload
# against artifacts. The installer carries this copy, so it cannot hold the installer's own hash (null here; the
# report copy <out>\manifest.json has it).
$manifest = [ordered]@{
  version = $Version
  channel = 'own'
  build_id = $BuildId
  fork_commit = $commit
  fork_dirty = $dirty
  upstream = [ordered]@{ release = $rootPackage.version }
  toolchain = [ordered]@{
    bun = $bunVersion
    rust = $(if (Get-Command rustc -ErrorAction SilentlyContinue) { (& rustc -V).Trim() } else { $null })
    electron = $desktopPackageJson.devDependencies.electron
    electron_vite = $desktopPackageJson.devDependencies.'electron-vite'
    electron_builder = $desktopPackageJson.devDependencies.'electron-builder'
  }
  embedded_web_ui = $embeddedWebUi
  # The plugins read OWN_HOME\app\current.json (01 sec. 5.1); own.ps1 gives versions without this an app\current junction.
  install_layout = 'pointer'
  artifacts = $artifacts
  desktop = [ordered]@{
    version = $Version
    app_id = 'dev.own.opencode.desktop'
    installer = $(if (-not $NoInstaller) { $installerName } else { $null })
    installer_sha256 = $null
    rpc_hash = $rpcHash
    rpcHash = $rpcHash
  }
  remote_artifacts = $remoteArtifacts
  patches_active = $patchesActive
  thirdparty_slots = [ordered]@{
    # 02 sec. 8.2: bundled into plugins\claude-auth and always on; the lock pins it, the patch manifest's hash is the
    # bundle record's patchSha256.
    'claude-auth' = [ordered]@{
      package = 'opencode-claude-auth-v2'
      version = $claudePackage.version
      integrity = $claudePackage.integrity
      overrides = $claudeShim.overrides
      patch = Get-FileSha (Join-Path $repo "own\vendor\claude-auth\patches\$($claudePackage.version).json")
      bundled = 'plugins/claude-auth'
    }
  }
}
$utf8 = New-Object Text.UTF8Encoding $false
function Write-Manifest([string]$Path) { [IO.File]::WriteAllText($Path, ($manifest | ConvertTo-Json -Depth 8), $utf8) }

# ---------------------------------------------------------------- stage: the payload (app\<ver>\ layout + launcher)

$appOut = Join-Path $OutDir 'app'
$binOut = Join-Path $OutDir 'bin'
Step 'stage' {
  if (Test-Path -LiteralPath $appOut) { Remove-Item -LiteralPath $appOut -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $appOut | Out-Null
  Copy-Item -LiteralPath $cliExe -Destination (Join-Path $appOut 'opencode.exe')
  Copy-Item -LiteralPath $webOut -Destination (Join-Path $appOut 'web') -Recurse
  Copy-Item -LiteralPath $pluginDir -Destination (Join-Path $appOut 'plugins') -Recurse
  Copy-Item -LiteralPath (Join-Path $OutDir 'own-vault.exe') -Destination (Join-Path $appOut 'own-vault.exe')
  if (Test-Path -LiteralPath $cuHelperOut) { Copy-Item -LiteralPath $cuHelperOut -Destination (Join-Path $appOut 'own-cu-helper.exe') }
  Copy-Item -LiteralPath $templatesOut -Destination (Join-Path $appOut 'templates') -Recurse
  if ($null -ne $remoteArtifacts) {
    New-Item -ItemType Directory -Force -Path (Join-Path $appOut 'remote') | Out-Null
    # remote_artifacts.json also has a top-level 'tools' key (the pinned git-lfs), so the targets come from the manifest.
    foreach ($target in $remoteManifest.targets.PSObject.Properties.Name) {
      Copy-Item -LiteralPath (Join-Path $remoteDir "$target.tar.gz") -Destination (Join-Path $appOut "remote\$target.tar.gz")
    }
    if (Test-Path -LiteralPath (Join-Path $remoteDir 'tools')) { Copy-Item -LiteralPath (Join-Path $remoteDir 'tools') -Destination (Join-Path $appOut 'remote\tools') -Recurse }
    Copy-Item -LiteralPath (Join-Path $remoteDir 'manifest.json') -Destination (Join-Path $appOut 'remote\manifest.json')
  }
  Write-Manifest (Join-Path $appOut 'manifest.json')
  # OWN_HOME\bin (01 sec. 5.1): the launcher, outside app\<ver>.
  if (Test-Path -LiteralPath $binOut) { Remove-Item -LiteralPath $binOut -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $binOut | Out-Null
  foreach ($name in @('own.cmd', 'own.ps1')) { Copy-Item -LiteralPath (Join-Path $repo "own\launcher\$name") -Destination (Join-Path $binOut $name) }
}
# The staged copy must hash like the manifest says (own.ps1 install checks the same).
$checks['stage.opencode.exe'] = (Get-FileSha (Join-Path $appOut 'opencode.exe')) -eq $cliSha
$checks['stage.web'] = (Get-TreeHash (Join-Path $appOut 'web')) -eq $artifacts['web/']
$checks['stage.plugins'] = @($pluginNames | Where-Object { (Get-FileSha (Join-Path $appOut "plugins\$_\index.js")) -ne $artifacts["plugins/$_/index.js"] }).Count -eq 0 -and
  (Get-TreeHash (Join-Path $appOut 'plugins\claude-auth')) -eq $artifacts['plugins/claude-auth/']

# ---------------------------------------------------------------- 5b. package: win-unpacked + the one-step installer

$packageEnv = $shellEnv.Clone()
if (-not $NoInstaller) { $packageEnv['OWN_DESKTOP_PAYLOAD'] = $OutDir }
Step 'shell-package' {
  if (Test-Path -LiteralPath $desktopOut) { Remove-Item -LiteralPath $desktopOut -Recurse -Force }
  $builderScript = if ($NoInstaller) { 'package' } else { 'package:win' }
  Invoke-Native 'electron-builder' $desktopPackage $packageEnv { & bun run $builderScript }
}

# ---------------------------------------------------------------- checks

$unpacked = Join-Path $desktopOut 'win-unpacked'
$shellExe = Join-Path $unpacked 'own-desktop.exe'
$payloadInPackage = Join-Path $unpacked 'resources\own-payload'
if (-not (Test-Path -LiteralPath $shellExe)) { throw "electron-builder produced no $shellExe" }
if (-not $NoInstaller -and -not (Test-Path -LiteralPath $installer)) { throw "electron-builder produced no $installer" }

$bundle = Join-Path $desktopPackage 'out'
$checks['G-D2.no-setAsDefaultProtocolClient'] = $null -eq (Test-FilesContain (Join-Path $bundle 'main') '*.js' 'setAsDefaultProtocolClient')
$checks['G-D2.no-upstream-app-id'] = ($null -eq (Test-FilesContain (Join-Path $bundle 'main') '*.js' 'ai.opencode.desktop')) -and
  ($null -eq (Test-FilesContain (Join-Path $bundle 'preload') '*.*js' 'ai.opencode.desktop'))
$checks['G-D2.no-app-update-yml'] = -not (Test-Path -LiteralPath (Join-Path $unpacked 'resources\app-update.yml'))
# The shell never updates itself (05 8.1): no updater module ships in the app, packed or unpacked.
$checks['G-D2.no-electron-updater'] = -not (Get-AsarHeader (Join-Path $unpacked 'resources\app.asar')).Contains('"electron-updater"') -and
  -not (Test-Path -LiteralPath (Join-Path $unpacked 'resources\app.asar.unpacked\node_modules\electron-updater'))
# The constants are inlined as string or template literals; the 16 hex chars alone are specific enough.
$checks['G-D6.shell-rpcHash'] = $null -ne (Test-FilesContain (Join-Path $bundle 'main') '*.js' $rpcHash)
$checks['G-D6.preload-rpcHash'] = $null -ne (Test-FilesContain (Join-Path $bundle 'preload') '*.*js' $rpcHash)
$checks['G-D6.web-rpcHash'] = $null -ne (Test-FilesContain $webOut '*.js' $rpcHash)
$checks['SC2.no-renderer-sourcemaps'] = (@(Get-ChildItem -LiteralPath (Join-Path $bundle 'renderer') -Recurse -File -Filter '*.map').Count -eq 0) -and
  (@(Get-ChildItem -LiteralPath $webOut -Recurse -File -Filter '*.map').Count -eq 0)
$unpackedBytes = Get-TreeSize $unpacked
$payloadPackagedBytes = if (Test-Path -LiteralPath $payloadInPackage) { Get-TreeSize $payloadInPackage } else { [int64]0 }
$shellUnpackedBytes = $unpackedBytes - $payloadPackagedBytes
$payloadBytes = (Get-TreeSize $appOut) + (Get-TreeSize $binOut)
$checks['SC2.shell-unpacked-le-460MB'] = $shellUnpackedBytes -le 460MB
$installerBytes = if (-not $NoInstaller -and (Test-Path -LiteralPath $installer)) { (Get-Item -LiteralPath $installer).Length } else { $null }
if ($null -ne $installerBytes) {
  # The remote bundles are gzip already and do not shrink; the rest of the payload compresses to ~60-70 MB. Bun 1.4.4
  # (packageManager since upstream v2.2) carries a runtime 29 MB larger than 1.4.2's in every compiled CLI, the Windows
  # one and both Linux targets: the remote bundles went from ~200 to ~225 MB and the installer from 394 to 438 MiB
  # (merge round 8, decisions MR8-27), so the budget with them went from 400 to 470 MB.
  $installerBudget = if ($null -ne $remoteArtifacts) { 470MB } else { 260MB }
  $checks["SC2.installer-le-$([int]($installerBudget / 1MB))MB"] = $installerBytes -le $installerBudget
  # Byte for byte what was staged (and hashed into app\manifest.json): nothing in packaging (e.g. signing) touched it.
  $checks['installer.payload-packaged'] = (Test-Path -LiteralPath $payloadInPackage) -and
    (Get-TreeHash (Join-Path $payloadInPackage 'app')) -eq (Get-TreeHash $appOut) -and
    (Get-TreeHash (Join-Path $payloadInPackage 'bin')) -eq (Get-TreeHash $binOut)
}
$installerSha = if ($null -ne $installerBytes) { (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }

# The compiled installer, read with 7-Zip (its NSIS reader lists the embedded files; nothing is executed): the
# preflight launcher of customInit, and every payload file in app-64.7z or as an NSIS file (the pre-compressed .gz).
function Find-SevenZip {
  $candidates = New-Object System.Collections.Generic.List[string]
  $command = Get-Command 7z.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates.Add($command.Source) }
  foreach ($root in @($env:ProgramFiles, $env:ProgramW6432, ${env:ProgramFiles(x86)})) { if ($root) { $candidates.Add((Join-Path $root '7-Zip\7z.exe')) } }
  return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Get-ArchivePaths([string]$SevenZip, [string]$Archive) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $lines = @(& $SevenZip l -ba -slt $Archive 2>$null) } finally { $ErrorActionPreference = $previous }
  return @($lines | Where-Object { $_ -like 'Path = *' } | ForEach-Object { $_.Substring(7) } | Where-Object { $_ -ne $Archive })
}

function Test-InstallerContents([string]$SevenZip) {
  $work = Join-Path $OutDir 'installer-check'
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  try {
    $nsisPaths = Get-ArchivePaths $SevenZip $installer
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $SevenZip e -y "-o$work" $installer '$PLUGINSDIR\app-64.7z' '$PLUGINSDIR\own-preflight.ps1' 2>$null | Out-Null }
    finally { $ErrorActionPreference = $previous }
    $appArchive = Join-Path $work 'app-64.7z'
    $archivePaths = if (Test-Path -LiteralPath $appArchive) { Get-ArchivePaths $SevenZip $appArchive } else { @() }
    $present = @{}
    foreach ($entry in $archivePaths) { $present[$entry] = $true }
    # NSIS files written to $INSTDIR (the pre-compressed .gz) are listed relative to it.
    foreach ($entry in $nsisPaths) { $present[$(if ($entry.StartsWith('$INSTDIR\')) { $entry.Substring(9) } else { $entry })] = $true }
    $expected = New-Object System.Collections.Generic.List[string]
    foreach ($part in @(@{ Dir = $appOut; Prefix = 'resources\own-payload\app\' }, @{ Dir = $binOut; Prefix = 'resources\own-payload\bin\' })) {
      $root = (Resolve-Path -LiteralPath $part.Dir).Path.TrimEnd('\') + '\'
      foreach ($file in Get-ChildItem -LiteralPath $part.Dir -Recurse -File -Force) { $expected.Add($part.Prefix + $file.FullName.Substring($root.Length)) }
    }
    $missing = @($expected | Where-Object { -not $present.ContainsKey($_) })
    $preflight = Join-Path $work 'own-preflight.ps1'
    return [ordered]@{
      tool = $SevenZip
      nsis_entries = $nsisPaths.Count
      nsis_payload_files = @($nsisPaths | Where-Object { $_ -like '*resources\own-payload\*' })
      app_archive_entries = $archivePaths.Count
      payload_files_expected = $expected.Count
      payload_files_found = $expected.Count - $missing.Count
      missing = @($missing | Select-Object -First 20)
      preflight_launcher = (Test-Path -LiteralPath $preflight) -and
        (Get-FileHash -LiteralPath $preflight).Hash -eq (Get-FileHash -LiteralPath (Join-Path $binOut 'own.ps1')).Hash
    }
  }
  finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

$inspection = $null
if ($null -ne $installerBytes) {
  $sevenZip = Find-SevenZip
  if ($sevenZip) {
    Step 'inspect' { $script:inspection = Test-InstallerContents $sevenZip }
    $checks['installer.payload-complete'] = $inspection.payload_files_expected -gt 0 -and $inspection.payload_files_found -eq $inspection.payload_files_expected
    $checks['installer.preflight-launcher'] = [bool]$inspection.preflight_launcher
  }
  else { $inspection = 'skipped: 7-Zip (7z.exe) not found on PATH or in Program Files' }
}

# The report copy of the manifest: the same as app\manifest.json plus the installer's hash.
$manifest.desktop.installer_sha256 = $installerSha
Write-Manifest (Join-Path $OutDir 'manifest.json')

$info = [ordered]@{
  version = $Version
  rpc_hash = $rpcHash
  build_id = $BuildId
  out = $OutDir
  app = $appOut
  app_bytes = Get-TreeSize $appOut
  payload_bytes = $payloadBytes
  plugins = $pluginDir
  remote = $(if ($null -ne $remoteArtifacts) { $remoteDir } else { $null })
  remote_rebuilt = [bool]$Remote
  launcher = $binOut
  launcher_version = [regex]::Match((Get-Content -Raw -LiteralPath (Join-Path $repo 'own\launcher\own.ps1')), "LauncherVersion = '([^']+)'").Groups[1].Value
  cli = $(if (Test-Path -LiteralPath $cliExe) { $cliExe } else { $null })
  cli_rebuilt = -not $SkipService
  web = $webOut
  web_bytes = Get-TreeSize $webOut
  shell_exe = $shellExe
  shell_exe_bytes = (Get-Item -LiteralPath $shellExe).Length
  asar_bytes = (Get-Item -LiteralPath (Join-Path $unpacked 'resources\app.asar')).Length
  unpacked_bytes = $unpackedBytes
  shell_unpacked_bytes = $shellUnpackedBytes
  installer = $(if ($null -ne $installerBytes) { $installer } else { $null })
  installer_bytes = $installerBytes
  installer_sha256 = $installerSha
  installer_payload = $(if ($null -ne $installerBytes) { 'resources\own-payload (app\, bin\); installer.nsh runs own.ps1 install --from it' } else { $null })
  installer_inspection = $inspection
  installed = $false
  checks = $checks
  steps_seconds = $steps
  build_seconds = [int]((Get-Date) - $started).TotalSeconds
  built_at = (Get-Date).ToUniversalTime().ToString('o')
  fork_commit = $commit
  fork_dirty = $dirty
}
[IO.File]::WriteAllText((Join-Path $OutDir 'desktop-build.json'), ($info | ConvertTo-Json -Depth 5), $utf8)

Write-Host ("==> shell   {0} ({1:N1} MB unpacked, without the payload)" -f $shellExe, ($shellUnpackedBytes / 1MB))
if ($null -ne $installerBytes) {
  Write-Host ("==> installer {0} ({1:N1} MB with the service payload, not installed)" -f $installer, ($installerBytes / 1MB))
}
Write-Host "==> web     $webOut"
Write-Host ("==> payload {0} + {1} ({2:N1} MB; by hand: {1}\own.cmd install)" -f $appOut, $binOut, ($payloadBytes / 1MB))
if ($null -eq $remoteArtifacts) { Write-Host '    (no remote bundles: run with -Remote for the SSH host tarballs)' }
if ($inspection -is [string]) { Write-Host "    installer contents: $inspection" }
Write-Host "==> manifest $(Join-Path $OutDir 'manifest.json') (rpc_hash $rpcHash, build_id $BuildId)"
$failed = @($checks.Keys | Where-Object { -not $checks[$_] })
foreach ($name in $checks.Keys) { Write-Host ("    {0,-36} {1}" -f $name, $(if ($checks[$name]) { 'ok' } else { 'FAIL' })) }
if ($failed.Count -gt 0) { throw "desktop build checks failed: $($failed -join ', ') (see desktop-build.json)" }
Write-Host ("==> done in {0} s" -f $info.build_seconds)

if ($Client) {
  $clientArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build-desktop-client.ps1'), '-Version', $Version, '-OutDir', $OutDir, '-Arch', 'arm64')
  Invoke-Native 'build-desktop-client.ps1' $repo @{} { & powershell.exe @clientArgs }
}
