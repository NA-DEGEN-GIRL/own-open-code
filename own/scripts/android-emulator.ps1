<#
.SYNOPSIS
  Optional helper for trying the own Android app in the Android Emulator (08-app-access.md sec. 4.3, limits). It
  changes nothing on this PC: it prints what is missing for you to install, and only when an emulator is already
  running does it install the built APK there and open a pairing link in the app.

.DESCRIPTION
  The desktop app's mobile preview (Settings > Devices > Mobile preview) needs none of this. Use the emulator only to
  see what the preview cannot show: the app's own Java screens, the Android WebView engine and Android fonts.

  Modes:

    (default)   Check. Reports the JDK, the Android SDK, platform-tools (adb), the emulator package, system images,
                AVDs and the newest built APK, and prints the commands you run yourself for anything missing
                (sdkmanager packages and their license, the AVD, Windows Hypervisor Platform). Runs no SDK tool and
                does not start adb.
    -Install    Needs a running emulator: an adb serial emulator-NNNN whose ro.kernel.qemu is 1 (a phone is
                refused). adb install -r <APK>, the newest own\.out\build\*\android\own-opencode-*.apk unless -Apk.
    -PairLink   Needs a running emulator. Lets the emulator reach this PC's app listener on loopback
                (adb reverse tcp:<AppPort> tcp:<AppPort>; ends with the adb server or the emulator), adds the route
                127.0.0.1:<AppPort> to the link when it lacks one, and opens it in the app:
                adb shell am start -a android.intent.action.VIEW -d '<link>' dev.own.opencode.android
                The link is the Android one from Settings > Devices > Connect a new device (Android app): copy it
                under the QR. The app then shows the confirmation number; press Allow on this PC as for a phone.

  Limits: the app replaces its stored routes with the ones the PC offers (GET /own/routes) when that list is not
  empty. With a Tailscale or DDNS route configured, the emulator keeps the loopback route only until that refresh.
  The script never adds firewall rules. If Windows asks about qemu-system-x86_64 or netsimd on the emulator's first
  start, deny it: adb and the app listener stay on loopback.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\android-emulator.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\android-emulator.ps1 -Install -PairLink 'ownpc://pair?v=1&...'
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [string]$PairLink,
  [string]$Apk,
  # The app listener's port (Settings > Devices > App connections).
  [ValidateRange(1, 65535)]
  [int]$AppPort = 28540,
  # Which emulator, when more than one runs (adb devices).
  [string]$Serial
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$package = 'dev.own.opencode.android'
$image = 'system-images;android-36;google_apis_playstore;x86_64'
$avdName = 'own-phone'

function First-Existing([string[]]$Candidates, [string]$Probe) {
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate $Probe))) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

function Newest-Apk {
  $root = Join-Path $repo 'own\.out\build'
  if (-not (Test-Path -LiteralPath $root)) { return $null }
  $found = Get-ChildItem -LiteralPath $root -Directory | ForEach-Object {
    $dir = Join-Path $_.FullName 'android'
    if (Test-Path -LiteralPath $dir) { Get-ChildItem -LiteralPath $dir -Filter 'own-opencode-*.apk' -File }
  } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}

function Show([string]$Label, $Value, [string]$Missing) {
  if ($Value) { Write-Host ("  ok       {0,-16} {1}" -f $Label, $Value) }
  else { Write-Host ("  missing  {0,-16} {1}" -f $Label, $Missing) }
}

# Runs adb with stderr folded in; Windows PowerShell 5.1 would turn its stderr into errors under Stop.
function Adb([string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    $output = (& $script:adb @Arguments 2>&1 | ForEach-Object { "$_" }) -join "`n"
    return [pscustomobject]@{ Output = $output.Trim(); Code = $LASTEXITCODE }
  }
  finally { $ErrorActionPreference = $previous }
}

# ---------------------------------------------------------------- check (read-only)

$javaHome = First-Existing @($env:JAVA_HOME, (Join-Path $env:LOCALAPPDATA 'Programs\jdk-21')) 'bin\java.exe'
$sdk = First-Existing @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk')) 'platforms'
$script:adb = if ($sdk -and (Test-Path -LiteralPath (Join-Path $sdk 'platform-tools\adb.exe'))) { Join-Path $sdk 'platform-tools\adb.exe' } else { $null }
$emulator = if ($sdk -and (Test-Path -LiteralPath (Join-Path $sdk 'emulator\emulator.exe'))) { Join-Path $sdk 'emulator\emulator.exe' } else { $null }
$sdkmanager = if ($sdk) { Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat' } else { $null }
$avdmanager = if ($sdk) { Join-Path $sdk 'cmdline-tools\latest\bin\avdmanager.bat' } else { $null }
# @(...) around the if: PowerShell unrolls an empty or one-item array returned from it.
$images = @(if ($sdk -and (Test-Path -LiteralPath (Join-Path $sdk 'system-images'))) {
  Get-ChildItem -LiteralPath (Join-Path $sdk 'system-images') -Recurse -Filter 'system.img' -File -ErrorAction SilentlyContinue |
    ForEach-Object { $_.Directory.FullName.Substring($sdk.Length + 1) }
})
$avdHome = if ($env:ANDROID_AVD_HOME) { $env:ANDROID_AVD_HOME }
  elseif ($env:ANDROID_USER_HOME) { Join-Path $env:ANDROID_USER_HOME 'avd' }
  else { Join-Path $env:USERPROFILE '.android\avd' }
$avds = @(if (Test-Path -LiteralPath $avdHome) { Get-ChildItem -LiteralPath $avdHome -Filter '*.ini' -File | ForEach-Object { $_.BaseName } })
if (-not $Apk) { $Apk = Newest-Apk }

Write-Host '==> Android Emulator check (nothing is installed or changed)'
Show 'JDK' $javaHome 'only to build the APK: own\scripts\build-android.ps1 looks in JAVA_HOME and %LOCALAPPDATA%\Programs\jdk-21'
Show 'Android SDK' $sdk 'install Android Studio or the command-line tools into %LOCALAPPDATA%\Android\Sdk'
Show 'adb' $script:adb 'the SDK package platform-tools'
Show 'emulator' $emulator 'the SDK package emulator'
Show 'system image' ($images -join ', ') $image
Show 'AVD' ($avds -join ', ') "an AVD ($avdHome)"
Show 'APK' $Apk 'run own\scripts\build-desktop.ps1, then own\scripts\build-android.ps1 with the same -Version'

$steps = @()
if ($sdk -and (-not $emulator -or $images.Count -eq 0)) {
  $steps += "& '$sdkmanager' `"emulator`" `"$image`"      # several GB; shows a license to accept"
}
if ($sdk -and $avds.Count -eq 0) {
  $steps += "& '$avdmanager' create avd -n $avdName -k `"$image`" -d pixel_8"
}
if ($sdk) {
  $emulatorPath = Join-Path $sdk 'emulator\emulator.exe'
  $steps += "& '$emulatorPath' -accel-check      # WHPX should be usable"
  $steps += "# Only if it is not, in an administrator PowerShell, then restart Windows:"
  $steps += "#   Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform"
  $steps += "& '$emulatorPath' -avd $(if ($avds.Count -gt 0) { $avds[0] } else { $avdName }) -no-boot-anim -netfast      # start it; leave it running"
}
Write-Host ''
Write-Host '==> Steps you run yourself (this script never runs them)'
$steps | ForEach-Object { Write-Host "  $_" }
Write-Host ''
Write-Host '==> Then, with the emulator running:'
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File own\scripts\android-emulator.ps1 -Install -PairLink '<Android link from Settings > Devices>'"

if (-not $Install -and -not $PairLink) { exit 0 }

# ---------------------------------------------------------------- the running emulator

if (-not $script:adb) { throw 'adb is missing (the SDK package platform-tools).' }
$listed = Adb @('devices')
if ($listed.Code -ne 0) { throw "adb devices failed: $($listed.Output)" }
$running = @($listed.Output -split "`n" | Where-Object { $_ -match '^(emulator-\d+)\s+device$' } | ForEach-Object { $Matches[1] })
if ($Serial) { $running = @($running | Where-Object { $_ -eq $Serial }) }
if ($running.Count -eq 0) { throw 'No running emulator (adb devices lists no emulator-NNNN device). Start one first; phones are not used here.' }
if ($running.Count -gt 1) { throw "Several emulators run ($($running -join ', ')): pick one with -Serial." }
$target = $running[0]
$qemu = Adb @('-s', $target, 'shell', 'getprop', 'ro.kernel.qemu')
if ($qemu.Output -ne '1') { throw "$target does not report ro.kernel.qemu=1; refusing (this helper is for the emulator only)." }
Write-Host ''
Write-Host "==> Emulator $target"

if ($Install) {
  if (-not $Apk -or -not (Test-Path -LiteralPath $Apk)) { throw 'No APK: build it first (own\scripts\build-android.ps1) or pass -Apk.' }
  Write-Host "  installing $Apk"
  $installed = Adb @('-s', $target, 'install', '-r', $Apk)
  if ($installed.Code -ne 0 -or $installed.Output -notmatch 'Success') { throw "adb install failed: $($installed.Output)" }
  Write-Host '  installed'
}

if ($PairLink) {
  $link = $PairLink.Trim()
  if ($link -notmatch '^ownpc://pair\?' -or $link -match "['`"\s]") { throw 'Not an ownpc://pair link (copy the whole Android link from Settings > Devices).' }
  $route = "r=127.0.0.1%3A$AppPort"
  if ($link -notmatch [regex]::Escape($route)) { $link = "$link&$route" }
  $reversed = Adb @('-s', $target, 'reverse', "tcp:$AppPort", "tcp:$AppPort")
  if ($reversed.Code -ne 0) { throw "adb reverse failed: $($reversed.Output)" }
  Write-Host "  the emulator's 127.0.0.1:$AppPort reaches this PC's 127.0.0.1:$AppPort (adb reverse)"
  $opened = Adb @('-s', $target, 'shell', "am start -a android.intent.action.VIEW -d '$link' $package")
  if ($opened.Code -ne 0 -or $opened.Output -match 'Error') { throw "opening the link failed: $($opened.Output -replace 'c=[A-Za-z0-9_-]+', 'c=<code>')" }
  Write-Host '  the link is open in the app: compare the confirmation number and press Allow on this PC'
}
