<#
.SYNOPSIS
  Build the own Android app (packages\own-android, 08-app-access.md sec. 4.2): JVM unit tests, then the APK signed
  with this PC's debug key, copied to own\.out\build\<Version>\android\own-opencode-<Version>.apk. Nothing is
  installed.

.DESCRIPTION
  Steps:

    gradle   packages\own-android\gradlew.bat --no-daemon -PownVersion=<Version> testDebugUnitTest assembleDebug
             (Gradle 9.8.0 from the wrapper, AGP 9.4.1). The debug variant is built non-debuggable (build.gradle.kts):
             it is the sideloaded app, so adb run-as must not reach its cookie store (the device token).
    copy     build\outputs\apk\debug\own-android-debug.apk -> <out>\android\own-opencode-<Version>.apk
    checks   aapt2 dump badging: package dev.own.opencode.android, versionName = <Version>, versionCode from <Version>, minSdk 29,
             targetSdk 36, not debuggable; apksigner verify (prints the signer's SHA-256); unit test results
             (build\test-results\testDebugUnitTest, all passed, none skipped).
    report   <out>\android\android-build.json (sizes, hashes, signer, test counts, toolchain).

  Signing: Gradle's debug signing config uses %USERPROFILE%\.android\debug.keystore (created on the first build when
  missing; ANDROID_USER_HOME moves it). Android only installs an update signed with the same key, so build updates on
  the same PC or copy that keystore (08 sec. 4.2).

  Toolchain (no global installs needed): JDK 17+ from JAVA_HOME, else %LOCALAPPDATA%\Programs\jdk-21; the Android SDK
  from ANDROID_HOME, else ANDROID_SDK_ROOT, else %LOCALAPPDATA%\Android\Sdk, with platforms\android-36 and
  build-tools\37.0.0. The wrapper downloads Gradle (sha256-pinned in gradle-wrapper.properties) and Maven
  dependencies into %USERPROFILE%\.gradle on the first run.

  Unlike build-desktop.ps1 (Bun/Vite), Gradle and AGP build fine from a path containing '#' (verified in
  D:\#Projects\...), so the project is built in place.

  Build order: run build-desktop.ps1 first and this script afterwards with the same -Version. The desktop build's CLI
  step (build-own.ps1, upstream build.ts) deletes own\.out\build\<Version> first, so an APK built before it is lost.
  -Version defaults to <root package.json version>-own.0, like build-desktop.ps1.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-android.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\build-android.ps1 -Version 2.0.18-own.5
#>
[CmdletBinding()]
param(
  # Default: <root package.json version>-own.0 (build-desktop.ps1's default).
  [string]$Version,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$started = Get-Date
if (-not $Version) { $Version = "$((Get-Content -Raw -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json).version)-own.0" }
if ($Version -notmatch '^\d+\.\d+\.\d+-own\.\d+$') {
  throw "Version '$Version' must look like <upstream release>-own.<k>, e.g. 2.0.18-own.4 (own/FORK.md sec. 8.1)."
}
$outRoot = Join-Path $repo 'own\.out'
if (-not $OutDir) { $OutDir = Join-Path $outRoot "build\$Version" }
$OutDir = [IO.Path]::GetFullPath($OutDir)
if (-not $OutDir.StartsWith([IO.Path]::GetFullPath($outRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutDir must be inside $outRoot (the own build scripts only write under own\.out)."
}
# The versionCode build.gradle.kts derives from the version (a*10^7 + b*10^5 + c*10^3 + k): it rises with every
# release, so an update installs over the last one and keeps its data (releases up to 2.2.6-own.7 had 1).
$parts = [regex]::Match($Version, '^(\d+)\.(\d+)\.(\d+)-own\.(\d+)$').Groups
$versionCode = [int]$parts[1].Value * 10000000 + [int]$parts[2].Value * 100000 + [int]$parts[3].Value * 1000 + [int]$parts[4].Value
$project = Join-Path $repo 'packages\own-android'
$androidOut = Join-Path $OutDir 'android'
$apkName = "own-opencode-$Version.apk"
$apk = Join-Path $androidOut $apkName
$compileSdk = 'android-36'
$buildTools = '37.0.0'

# ---------------------------------------------------------------- toolchain

function Resolve-JavaHome {
  foreach ($candidate in @($env:JAVA_HOME, (Join-Path $env:LOCALAPPDATA 'Programs\jdk-21'))) {
    if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'bin\java.exe'))) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  throw 'No JDK found: set JAVA_HOME to a JDK 17+ (default %LOCALAPPDATA%\Programs\jdk-21).'
}

function Resolve-AndroidHome {
  foreach ($candidate in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))) {
    if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'platforms'))) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  throw 'No Android SDK found: set ANDROID_HOME (default %LOCALAPPDATA%\Android\Sdk).'
}

$javaHome = Resolve-JavaHome
$androidHome = Resolve-AndroidHome
# `java -version` writes to stderr; read the release file instead.
$javaRelease = Get-Content -LiteralPath (Join-Path $javaHome 'release') -ErrorAction SilentlyContinue |
  Where-Object { $_ -like 'JAVA_VERSION=*' } | Select-Object -First 1
$javaVersion = if ($javaRelease) { $javaRelease.Split('=')[1].Trim('"') } else { 'unknown' }
if ($javaVersion -match '^(\d+)' -and [int]$Matches[1] -lt 17) { throw "JDK $javaVersion at $javaHome is too old: AGP 9.4 needs JDK 17+." }
foreach ($required in @("platforms\$compileSdk", "build-tools\$buildTools")) {
  if (-not (Test-Path -LiteralPath (Join-Path $androidHome $required))) {
    throw "Android SDK at $androidHome lacks $required (android --sdk=$androidHome sdk install `"$($required.Replace('\', ';'))`")."
  }
}
$aapt2 = Join-Path $androidHome "build-tools\$buildTools\aapt2.exe"
$apksigner = Join-Path $androidHome "build-tools\$buildTools\apksigner.bat"
Write-Host "==> JDK $javaVersion ($javaHome)"
Write-Host "==> SDK $androidHome"

# Native tools write progress to stderr; Windows PowerShell 5.1 turns redirected stderr into terminating errors
# under ErrorActionPreference=Stop. Exit codes decide success instead.
function Invoke-Native([string]$Label, [string]$WorkingDirectory, [hashtable]$Environment, [scriptblock]$Body) {
  $saved = @{}
  foreach ($name in $Environment.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $Environment[$name], 'Process')
  }
  $previous = $ErrorActionPreference
  Push-Location -LiteralPath $WorkingDirectory
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

# Like Invoke-Native, but returns the combined output and exit code instead of throwing.
function Invoke-Capture([hashtable]$Environment, [scriptblock]$Body) {
  $saved = @{}
  foreach ($name in $Environment.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $Environment[$name], 'Process')
  }
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    $output = (& $Body 2>&1 | ForEach-Object { "$_" }) -join "`n"
    return [pscustomobject]@{ Output = $output; Code = $LASTEXITCODE }
  }
  finally {
    $ErrorActionPreference = $previous
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  }
}

# ANDROID_SDK_ROOT is cleared: AGP refuses to build when it disagrees with ANDROID_HOME.
$toolEnv = @{
  JAVA_HOME = $javaHome
  ANDROID_HOME = $androidHome
  ANDROID_SDK_ROOT = $null
  PATH = "$javaHome\bin;$env:PATH"
}

# ---------------------------------------------------------------- gradle: tests + APK

Write-Host '==> gradle testDebugUnitTest assembleDebug'
$gradleAt = Get-Date
$testResults = Join-Path $project 'build\test-results\testDebugUnitTest'
# Stale results from an earlier run must not count as this run's.
if (Test-Path -LiteralPath $testResults) { Remove-Item -LiteralPath $testResults -Recurse -Force }
Invoke-Native 'gradle (testDebugUnitTest assembleDebug)' $project $toolEnv {
  # -PownTestInstall=0 on the command line wins over a gradle.properties in the user's Gradle home and over
  # ORG_GRADLE_PROJECT_ownTestInstall: a release APK is never the debuggable side-by-side test install.
  & (Join-Path $project 'gradlew.bat') --no-daemon --console=plain "-PownVersion=$Version" "-PownTestInstall=0" testDebugUnitTest assembleDebug
}
$gradleSeconds = [int]((Get-Date) - $gradleAt).TotalSeconds

$built = Join-Path $project 'build\outputs\apk\debug\own-android-debug.apk'
if (-not (Test-Path -LiteralPath $built)) { throw "Gradle produced no $built" }
New-Item -ItemType Directory -Force -Path $androidOut | Out-Null
Copy-Item -LiteralPath $built -Destination $apk -Force

# ---------------------------------------------------------------- checks

$checks = [ordered]@{}

# Unit tests: every suite's counts from the JUnit XML reports.
$tests = 0; $failures = 0; $skipped = 0
foreach ($file in @(Get-ChildItem -LiteralPath $testResults -Filter 'TEST-*.xml' -ErrorAction SilentlyContinue)) {
  $suite = ([xml](Get-Content -Raw -LiteralPath $file.FullName)).testsuite
  $tests += [int]$suite.tests; $failures += [int]$suite.failures + [int]$suite.errors; $skipped += [int]$suite.skipped
}
$checks['tests.ran'] = $tests -gt 0
$checks['tests.passed'] = $failures -eq 0 -and $skipped -eq 0

# Manifest values as packaged.
$badging = (Invoke-Capture @{} { & $aapt2 dump badging $apk }).Output
$package = [regex]::Match($badging, "package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'")
$checks['apk.package'] = $package.Success -and $package.Groups[1].Value -eq 'dev.own.opencode.android'
$checks['apk.versionName'] = $package.Success -and $package.Groups[3].Value -eq $Version
$checks['apk.versionCode'] = $package.Success -and $package.Groups[2].Value -eq "$versionCode"
$checks['apk.minSdk-29'] = $badging -match "(?m)^(min)?[sS]dkVersion:'29'"
$checks['apk.targetSdk-36'] = $badging -match "(?m)^targetSdkVersion:'36'"
$checks['apk.not-debuggable'] = -not ($badging -match '(?m)^application-debuggable')

# Signature (apksigner prints the signer's certificate digests).
$verified = Invoke-Capture $toolEnv { & $apksigner verify --print-certs $apk }
$checks['apk.signature'] = $verified.Code -eq 0
$digest = [regex]::Match($verified.Output, 'certificate SHA-256 digest: ([0-9a-f]+)')
$signer = if ($digest.Success) { $digest.Groups[1].Value } else { $null }
$signerDn = [regex]::Match($verified.Output, 'certificate DN: ([^\r\n]+)').Groups[1].Value.Trim()

$apkBytes = (Get-Item -LiteralPath $apk).Length
$apkSha = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
$wrapper = Get-Content -Raw -LiteralPath (Join-Path $project 'gradle\wrapper\gradle-wrapper.properties')
$buildScript = Get-Content -Raw -LiteralPath (Join-Path $project 'build.gradle.kts')
$commit = (& git -C $repo rev-parse HEAD).Trim()
$dirty = [bool](& git -C $repo status --porcelain -- packages/own-android)

$info = [ordered]@{
  version = $Version
  version_code = $versionCode
  application_id = 'dev.own.opencode.android'
  apk = $apk
  apk_bytes = $apkBytes
  apk_sha256 = $apkSha
  signer_sha256 = $signer
  signer_dn = $signerDn
  debug_keystore = $(if ($env:ANDROID_USER_HOME) { Join-Path $env:ANDROID_USER_HOME 'debug.keystore' } else { Join-Path $env:USERPROFILE '.android\debug.keystore' })
  tests = [ordered]@{ total = $tests; failed = $failures; skipped = $skipped }
  toolchain = [ordered]@{
    gradle = [regex]::Match($wrapper, 'gradle-([0-9.]+)-bin\.zip').Groups[1].Value
    agp = [regex]::Match($buildScript, 'id\("com\.android\.application"\) version "([^"]+)"').Groups[1].Value
    jdk = $javaVersion
    build_tools = $buildTools
    compile_sdk = $compileSdk
  }
  checks = $checks
  gradle_seconds = $gradleSeconds
  build_seconds = [int]((Get-Date) - $started).TotalSeconds
  built_at = (Get-Date).ToUniversalTime().ToString('o')
  fork_commit = $commit
  android_dirty = $dirty
}
$utf8 = New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllText((Join-Path $androidOut 'android-build.json'), ($info | ConvertTo-Json -Depth 5), $utf8)

Write-Host ("==> apk     {0} ({1:N2} MB)" -f $apk, ($apkBytes / 1MB))
Write-Host "    sha256  $apkSha"
Write-Host "    signer  $signerDn (SHA-256 $signer)"
Write-Host "==> tests   $tests passed"
$failed = @($checks.Keys | Where-Object { -not $checks[$_] })
foreach ($name in $checks.Keys) { Write-Host ("    {0,-24} {1}" -f $name, $(if ($checks[$name]) { 'ok' } else { 'FAIL' })) }
if ($failed.Count -gt 0) { throw "android build checks failed: $($failed -join ', ') (see android-build.json)" }
Write-Host ("==> done in {0} s" -f $info.build_seconds)
