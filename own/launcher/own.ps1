<#
  own - launcher v0 for own-open-code (01 sec. 5). Windows PowerShell 5.1+ and PowerShell 7.

  The launcher is the only thing that starts the own service (01 sec. 5.3). It
    0. writes the env bridge: the same service config to
         %USERPROFILE%\.config\own-open-code\service-own.json   (read by services started through the launcher)
         %USERPROFILE%\.config\opencode\service-own.json        (read by a raw opencode.exe started without env)
    1. cleans the environment: OPENCODE_CONFIG_DIR, OWN_OPEN_CODE=1, OPENCODE_DISABLE_AUTOUPDATE=1,
       OPENCODE_DISABLE_FREE_MODELS=1; removes provider key variables (names are reported, values never printed),
       OpenTelemetry exporter settings (OTEL_*) and variables that would break channel isolation
    2. runs `opencode.exe service start` (own channel build: opencode-own.db, service-own.json, port 28538)
    3. pairs a browser via POST /api/pair and opens http://127.0.0.1:<port>/auth/connect/<code>
    4. when OWN_HOME\gateway.json has the remote access gateway on, wakes it: own.remote gateway.status at the control
       location (05 sec. 13.4), so a phone can connect without the desktop app open. Not for the desktop shell's runs
       (OWN_LAUNCHER_CLIENT=desktop, never passed on to the service): the app's first control RPC starts it

  Commands: open, start, stop, restart, status, url, pair, env, config init|print, tui, run, version, help, and the
  install lifecycle (01 sec. 5.5) the desktop installer runs from its payload and a person can run by hand:
    install|update --from <payload>  copy <payload>\app to OWN_HOME\app\<ver> (or move it: --move), verify it against
                                     its manifest.json, stop the service when it runs another build (asks when sessions
                                     run), back up opencode-own.db(-wal,-shm) to OWN_HOME\backup, write the version
                                     pointer app\current.json for the new version, point the own plugin entries of
                                     opencode.jsonc at its plugins, keep the previous version, copy <payload>\bin to
                                     OWN_HOME\bin, put OWN_HOME\bin on the user PATH, write the own config when it is
                                     missing, and start the service again when it was running (a failed start rolls
                                     everything back).
    rollback [--to <ver>]            point app\current.json (and the plugin entries) back at the previous version.
    uninstall [--remove-data]        remove the app versions, the launcher and the PATH entry; user data (accounts
                                     registry, vault, ledger, config, database) stays unless --remove-data.
  Stub (later phase): logon.

  No junctions (launcher 0.4.0): the installed version is named by the pointer file OWN_HOME\app\current.json, and
  everything (this launcher, the desktop shell, the plugins) resolves OWN_HOME\app\<version> from it. Launcher 0.3.0
  and earlier pointed an app\current junction at it. A junction is a second path to the same files that every reader
  must be able to follow; one made inside a packaged app's virtualized view (below) names a path that exists nowhere,
  and files cannot be opened through it although attribute queries (Test-Path) still succeed. So the junction is only
  ever read as a link (its target, never followed) and install/update/rollback replace it with the pointer.

  Exit codes: 0 ok; 1 failure; 2 not implemented; 3 service not running (status, url, pair); 4 sessions are running
  and --force was not given where asking is impossible (stdin redirected or --no-prompt, e.g. the desktop shell and
  the installer: 05 sec. 5.7); 5 install/update refused because this process's writes to OWN_HOME are redirected
  into a packaged (MSIX) app's private folder (see "Packaged-app virtualization" below); 64 usage.

  Packaged-app virtualization: a process started from inside a packaged desktop app with file system write
  virtualization (e.g. a terminal or an agent of the Claude desktop app, package Claude_pzs8sxrjxfjjc) writes new
  files under %LOCALAPPDATA% into %LOCALAPPDATA%\Packages\<family>\LocalCache\Local\... . Only that app's processes see
  them: an install made there is invisible to Explorer, the Start menu's Own OpenCode and every normal terminal (the
  shell reports own-open-code as not installed), and a junction made there names the real path, which does not exist,
  so nothing can be opened through it (%TEMP% is not virtualized, which is why junctions in temp roots worked). A
  service started there writes accounts, vault and ledger into the private copy as well. So install, update, rollback,
  uninstall (and the installer's preflight) and open, start, restart, tui, run detect this with a probe folder and stop
  with exit 5 before changing anything (open and start only when no healthy service can be reused: reusing one writes
  nothing under OWN_HOME); --allow-virtualized or OWN_ALLOW_VIRTUALIZED=1 overrides it (tests inside such an app).
  status shows it (virtualized, container_copies).

  Claude subscription account source (02 sec. 8.7, 05 sec. 5.7): OWN_HOME\claude-auth.json {configDir, setAt} is written
  by own.accounts (plugin.claudeAuth.changeSource.execute) or by 'own restart --claude-config-dir <dir>' ('default'
  removes it). Every start puts configDir into the service env as CLAUDE_CONFIG_DIR, the one CLAUDE_* variable that
  is not removed (02 sec. 8.3 I8).

  Overrides (tests/dev): OWN_OPENCODE_EXE (binary), OWN_HOME (default %LOCALAPPDATA%\own-open-code),
  OWN_CONFIG_DIR (default %USERPROFILE%\.config\own-open-code); upstream's XDG_CONFIG_HOME / XDG_STATE_HOME /
  XDG_DATA_HOME move the bridge, registration and database roots exactly as they do for opencode.exe;
  OWN_USER_PATH_FILE: a text file that stands in for the user PATH (HKCU\Environment Path), so tests never touch the
  registry.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

# Windows PowerShell 5.1 auto-loads modules from PSModulePath. Started straight from a PowerShell 7 process (the
# installer's powershell.exe run from a pwsh 7 window, node, a test runner) it inherits 7's value, whose own
# Microsoft.PowerShell.Utility and CimCmdlets come first, so Get-FileHash (a 5.1 Utility function) is missing. own.cmd
# clears the variable; this gives every other way in the same value: 5.1's default, as 5.1 builds it when the variable
# is unset (the user value or Documents\WindowsPowerShell\Modules, then the machine value or Program Files' and
# $PSHOME's Modules). The service and its shells inherit it.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
  $userModules = [Environment]::GetEnvironmentVariable('PSModulePath', 'User')
  if (-not $userModules) { $userModules = [IO.Path]::Combine([Environment]::GetFolderPath('MyDocuments'), 'WindowsPowerShell\Modules') }
  $machineModules = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
  if (-not $machineModules) { $machineModules = "$env:ProgramFiles\WindowsPowerShell\Modules;$PSHOME\Modules" }
  $env:PSModulePath = "$userModules;$machineModules"
}

# A program reading our output through pipes (the desktop shell shows the stderr tail, 05 sec. 5.3) decodes UTF-8;
# the console's OEM code page would garble non-ASCII paths (e.g. a Korean user name). Terminals keep their encoding.
if ([Console]::IsErrorRedirected -or [Console]::IsOutputRedirected) {
  try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }
}

$script:LauncherVersion = '0.6.0'
$script:Channel = 'own'
$script:VersionPattern = '^\d+\.\d+\.\d+-own\.\d+$'
# A version folder name a pointer may name (readers accept more than own releases: test layouts use suffixes).
$script:VersionNamePattern = '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$'
# The plugin bundles whose opencode.jsonc entries the launcher owns (01 sec. 4 activation order). own-team is third
# (06 sec. 2.6), the Claude subscription plugin fourth: it ships in app\<ver>\plugins\claude-auth and is always on
# (02 sec. 8.2, launcher 0.6.0; it replaced the in-app install in OWN_HOME\thirdparty\claude-auth, whose config line
# the launcher points at the bundle). own-import follows own-computer-use (09 sec. 5.1) and own-harness is last
# (10 H0): neither has hooks yet, and a config change reloads only the plugins after the first changed entry, so adding
# either reloads no other plugin. own-harness stays last because its later request hooks (10 H1) must transform the
# request after every other own plugin's. Remote (SSH host) installs carry it last too and never claude-auth (10 sec.
# 6.1, 04 sec. 8.11, packages/own-remote bundle.ts REMOTE_PLUGINS). own-omo (oh-my-opencode on OpenCode 2, 15) comes
# after own-harness: its request hooks work on what own-harness built, and only in sessions that run the omo harness.
# Remote installs carry it last too (15 sec. 1, REMOTE_PLUGINS), with its runtime beside it. own-creator (creator mode and
# own's declarative extensions, 17) is last: its hooks add to what own-harness built (the compaction prompt, a retry
# decision), and a change of its entry reloads no other plugin. Remote installs do not carry it yet (17 sec. 10).
# After it, at the very end, own-creator itself may list code plugins the user approved (17 sec. 12.4: entries naming
# OWN_HOME\creator\ext\<id>\v<n>). The launcher never moves or drops them: syncs touch only its own entries, new
# bundles go in before them, and 'config init --force' carries them over to the end of the new list.
$script:ManagedPlugins = @('own-accounts', 'own-remote', 'own-team', 'claude-auth', 'own-telemetry', 'own-computer-use', 'own-import', 'own-harness', 'own-omo', 'own-creator')

# ---------------------------------------------------------------- paths and constants

function Get-OwnPaths {
  $userHome = $env:USERPROFILE
  $xdgConfig = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $userHome '.config' }
  $xdgState = if ($env:XDG_STATE_HOME) { $env:XDG_STATE_HOME } else { Join-Path $userHome '.local\state' }
  $xdgData = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $userHome '.local\share' }
  $ownHome = if ($env:OWN_HOME) { $env:OWN_HOME } else { Join-Path $env:LOCALAPPDATA 'own-open-code' }
  $configDir = if ($env:OWN_CONFIG_DIR) { $env:OWN_CONFIG_DIR } else { Join-Path $userHome '.config\own-open-code' }
  $paths = [pscustomobject]@{
    OwnHome = $ownHome
    ConfigDir = $configDir
    ConfigFile = Join-Path $configDir 'opencode.jsonc'
    ServiceConfig = Join-Path $configDir 'service-own.json'
    Bridge = Join-Path $xdgConfig 'opencode\service-own.json'
    Registration = Join-Path $xdgState 'opencode\service-own.json'
    Database = Join-Path $xdgData 'opencode\opencode-own.db'
    Control = Join-Path $ownHome 'control'
    ClaudeAuth = Join-Path $ownHome 'claude-auth.json'
    App = Join-Path $ownHome 'app'
    # The version pointer {version, path, previous, ...}: the one place that names the installed version.
    Pointer = Join-Path $ownHome 'app\current.json'
    # The junction of launcher 0.3.0 and earlier; only read as a link (never followed) and removed on the next switch.
    Current = Join-Path $ownHome 'app\current'
    Bin = Join-Path $ownHome 'bin'
    Backup = Join-Path $ownHome 'backup'
    InstallState = Join-Path $ownHome 'install.json'
    InstallLog = Join-Path $ownHome 'install.log'
    # Filled by Update-ActivePaths from the pointer (and again after every switch).
    Active = $null
    Exe = $null
    Plugins = $null
  }
  Update-ActivePaths $paths
  return $paths
}

# Active: the installed version folder (Get-ActiveApp); Exe: OWN_OPENCODE_EXE or its opencode.exe; Plugins: its
# plugins folder. Exe and Plugins are $null when nothing is installed.
function Update-ActivePaths($Paths) {
  $active = Get-ActiveApp $Paths
  $Paths.Active = $active
  $Paths.Plugins = if ($null -ne $active) { Join-Path $active.Dir 'plugins' } else { $null }
  $Paths.Exe = if ($env:OWN_OPENCODE_EXE) { $env:OWN_OPENCODE_EXE } elseif ($null -ne $active) { Join-Path $active.Dir 'opencode.exe' } else { $null }
}

function Test-ExePresent($Paths) { return [bool]$Paths.Exe -and (Test-Path -LiteralPath $Paths.Exe -PathType Leaf) }

# An installed bundle's folder (app\<ver>\plugins\<name>), or $null when that version has none.
function Get-PluginDir($Paths, [string]$Name) {
  if (-not $Paths.Plugins) { return $null }
  $dir = Join-Path $Paths.Plugins $Name
  if (Test-Path -LiteralPath $dir -PathType Container) { return $dir }
  return $null
}

# Same rule as packages/cli/src/services/service-config.ts defaultPort(): 10000 + sha1(channel)[0..8] % 50000.
# Upstream moves a Windows port at 0x8000 or above into the 0x7000 block (e441dafb09, v2.1); the own channel's 28538 is below it.
function Get-DefaultPort([string]$Channel) {
  $sha1 = [Security.Cryptography.SHA1]::Create()
  try { $bytes = $sha1.ComputeHash([Text.Encoding]::UTF8.GetBytes($Channel)) } finally { $sha1.Dispose() }
  $prefix = [uint32](([uint32]$bytes[0] -shl 24) -bor ([uint32]$bytes[1] -shl 16) -bor ([uint32]$bytes[2] -shl 8) -bor [uint32]$bytes[3])
  return 10000 + [int]($prefix % 50000)
}

# Provider credentials must not reach the service (the shell tool inherits its env, 01 sec. 13 ("env hygiene")).
$script:ProviderKeyNames = @(
  'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY',
  'CEREBRAS_API_KEY', 'DEEPINFRA_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_API_KEY', 'CODEX_API_KEY'
)
$script:ProviderKeyPrefixes = @('OPENAI_', 'ANTHROPIC_', 'CLAUDE_', 'OPENCODE_CLAUDE_AUTH_')
# OpenTelemetry exporter settings (decisions TLM): with OTEL_EXPORTER_OTLP_ENDPOINT set, the service sends all its logs and
# traces there (upstream packages/util/src/observability.ts), and its MCP and shell children inherit the rest. A value
# meant for another program must not turn that on.
$script:TelemetryPrefixes = @('OTEL_')
# Variables that would point the own service at another database/config or leak a server password.
$script:IsolationBreakers = @(
  'OPENCODE_DB', 'OPENCODE_DISABLE_CHANNEL_DB', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'
)

# Mirrors own/config/opencode.jsonc.example "permissions" (checked by own/scripts/test/launcher.test.mjs).
$script:Permissions = @(
  @('shell', '*', 'ask'),
  @('read', '*/own-open-code/vault/*', 'deny'), @('edit', '*/own-open-code/vault/*', 'deny'),
  @('read', '*/own-open-code-dev/vault/*', 'deny'), @('edit', '*/own-open-code-dev/vault/*', 'deny'),
  @('read', '*/opencode-own.db*', 'deny'), @('edit', '*/opencode-own.db*', 'deny'),
  @('read', '*/opencode/service-own.json', 'deny'), @('edit', '*/opencode/service-own.json', 'deny'),
  @('read', '*/own-open-code/service-own.json', 'deny'), @('edit', '*/own-open-code/service-own.json', 'deny'),
  @('read', '*/.claude/.credentials.json', 'deny'), @('edit', '*/.claude/.credentials.json', 'deny'),
  @('read', '*/.codex/auth.json', 'deny'), @('edit', '*/.codex/auth.json', 'deny'),
  @('read', '*/codex-multi-provider/work/control-center/profiles/*', 'deny'),
  @('edit', '*/codex-multi-provider/work/control-center/profiles/*', 'deny')
)

# ---------------------------------------------------------------- small helpers

# 05 sec. 5.7: "sessions are running and --force was not given", told apart from other failures (the desktop shell
# turns it into refused:"session_running").
$script:ExitSessionRunning = 4
# The install would land in a packaged app's private (virtualized) folder (see the header).
$script:ExitVirtualized = 5
$script:ExitUsage = 64

# Install lifecycle commands also append their messages to OWN_HOME\install.log: the installer runs the launcher
# without a visible console, so the log is where a failure is explained.
$script:LogFile = $null
# Inside Invoke-Trapped, Stop-Own throws instead of exiting so an update can roll back before it exits.
$script:TrapExit = $false
# --no-prompt: never ask (the installer has no console); refuse with exit 4 where a person would be asked.
$script:NoPrompt = $false

function Write-LogLine([string]$Line) {
  if (-not $script:LogFile) { return }
  try {
    # Never recreates a removed OWN_HOME (uninstall --remove-data).
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $script:LogFile))) { return }
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    [IO.File]::AppendAllText($script:LogFile, "$stamp $Line`r`n", (New-Object Text.UTF8Encoding $false))
  }
  catch { }
}

function Write-Info([string]$Message) { [Console]::Error.WriteLine("own: $Message"); Write-LogLine $Message }
function Write-Warn([string]$Message) { [Console]::Error.WriteLine("own: warning: $Message"); Write-LogLine "warning: $Message" }
function Stop-Own([string]$Message, [int]$Code = 1) {
  Write-LogLine "failed (exit $Code): $Message"
  if ($script:TrapExit) {
    $exception = New-Object System.Exception $Message
    $exception.Data['OwnExit'] = $Code
    throw $exception
  }
  [Console]::Error.WriteLine("own: $Message")
  exit $Code
}

# Runs $Body with Stop-Own (and any other error) turned into a result: $null when it went through, else
# {Code, Message}. The caller undoes what it changed and then exits with that code.
# The block runs in a child of this function's scope and reads the caller's variables through it (dynamic scoping),
# so the locals here carry a trap prefix that no caller uses. Results travel in objects the caller passed in.
function Invoke-Trapped([scriptblock]$TrapBody) {
  $trapPrevious = $script:TrapExit
  $script:TrapExit = $true
  try {
    [void](& $TrapBody)
    return $null
  }
  catch {
    $trapCode = $_.Exception.Data['OwnExit']
    if ($null -eq $trapCode) { $trapCode = 1 }
    return [pscustomobject]@{ Code = [int]$trapCode; Message = $_.Exception.Message }
  }
  finally { $script:TrapExit = $trapPrevious }
}

function Get-Prop($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8) | ConvertFrom-Json }
  catch { Write-Warn "ignoring unreadable JSON file $Path"; return $null }
}

# Atomic write: a temp file in the same directory, flushed to disk (fsync), then renamed over the target
# (ReplaceFile when it exists, so readers see the old or the new content, never a partial one). UTF-8, no BOM unless
# asked. Antivirus scanners briefly hold fresh files, so the rename is retried for a few seconds.
function Write-TextFile([string]$Path, [string]$Text, [bool]$Bom = $false) {
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
  $temp = "$Path.tmp-$PID"
  $encoding = New-Object Text.UTF8Encoding $Bom
  [byte[]]$bytes = @($encoding.GetPreamble()) + @($encoding.GetBytes($Text))
  $stream = New-Object IO.FileStream($temp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  }
  finally { $stream.Dispose() }
  for ($attempt = 1; ; $attempt++) {
    try {
      if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temp, $Path, [NullString]::Value) }
      else { [IO.File]::Move($temp, $Path) }
      return
    }
    catch {
      if ($attempt -ge 10) {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        throw "could not write $Path ($($_.Exception.Message))"
      }
      Start-Sleep -Milliseconds 300
    }
  }
}

function New-Password {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Test-Flag([string[]]$Arguments, [string]$Name) { return @($Arguments | Where-Object { $_ -eq $Name }).Count -gt 0 }

# Value of `--name <value>`; $null when the option is absent. A missing value is a usage error.
function Get-OptionValue([string[]]$Arguments, [string]$Name) {
  for ($i = 0; $i -lt $Arguments.Count; $i++) {
    if ($Arguments[$i] -ne $Name) { continue }
    if ($i + 1 -ge $Arguments.Count -or $Arguments[$i + 1].StartsWith('--')) { Stop-Own "$Name needs a value" $script:ExitUsage }
    return $Arguments[$i + 1]
  }
  return $null
}

# ---------------------------------------------------------------- Claude account source (02 sec. 8.7)

# Same checks as the desktop shell (05 sec. 5.6): absolute, no control characters, at most 1,024 characters, an
# existing directory. With $Paths (own restart --claude-config-dir) also not one of own's login folders, refused like
# the service's changeSource does (02 sec. 8.7 CS): exported as CLAUDE_CONFIG_DIR it would turn read only and stop at
# its next token expiry. Returns why the path is not usable, or $null.
function Test-ClaudeConfigDir([string]$Dir, $Paths = $null) {
  if (-not $Dir -or $Dir.Length -gt 1024 -or $Dir -match '[\x00-\x1f\x7f]') { return 'not a valid path' }
  if (-not [IO.Path]::IsPathRooted($Dir) -or $Dir -match '^[\\/](?![\\/])') { return 'not an absolute path' }
  if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return 'not an existing directory' }
  if ($null -ne $Paths -and (Test-OwnLoginFolder $Paths $Dir)) {
    return "one of own's login folders ($(Join-Path $Paths.OwnHome 'claude-accounts')), not a Claude Code folder"
  }
  return $null
}

# OWN_HOME\claude-accounts or a folder in it, by path or with junctions and symbolic links followed (the service
# compares realpaths; 8.3 short names are not expanded here).
function Test-OwnLoginFolder($Paths, [string]$Dir) {
  $root = Join-Path $Paths.OwnHome 'claude-accounts'
  $inside = {
    param([string]$Folder, [string]$Base)
    $Folder -ieq $Base -or $Folder.StartsWith("$Base\", [StringComparison]::OrdinalIgnoreCase)
  }
  if (& $inside ([IO.Path]::GetFullPath($Dir).TrimEnd('\')) ([IO.Path]::GetFullPath($root).TrimEnd('\'))) { return $true }
  return [bool](& $inside (Resolve-LinkedPath $Dir) (Resolve-LinkedPath $root))
}

# The full path with every junction or symbolic link along it followed, read from the links (Get-LinkTarget). A part
# whose link cannot be read ends the walk there.
function Resolve-LinkedPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  # A cycle of links ends after 32 hops.
  for ($hop = 0; $hop -lt 32; $hop++) {
    $root = [IO.Path]::GetPathRoot($full)
    $parts = @($full.Substring($root.Length).Split('\') | Where-Object { $_ })
    $at = $root.TrimEnd('\')
    $next = $null
    for ($i = 0; $i -lt $parts.Count -and $null -eq $next; $i++) {
      $at = "$at\$($parts[$i])"
      if (-not (Test-ReparsePoint (Get-LinkAttributes $at))) { continue }
      $target = Get-LinkTarget $at
      if (-not $target) { return $full }
      $next = (@($target) + @($parts | Select-Object -Skip ($i + 1))) -join '\'
      # A link to a drive root: 'C:' alone would be that drive's current folder.
      if ($next -match ':$') { $next += '\' }
    }
    if ($null -eq $next) { return $full }
    $full = [IO.Path]::GetFullPath($next).TrimEnd('\')
  }
  return $full
}

# configDir of OWN_HOME\claude-auth.json when it is usable; otherwise $null (with a warning when the file has one).
function Get-ClaudeConfigDir($Paths, [bool]$Report = $true) {
  $file = Read-JsonFile $Paths.ClaudeAuth
  if ($null -eq $file) { return $null }
  $dir = [string](Get-Prop $file 'configDir')
  if (-not $dir) { return $null }
  $problem = Test-ClaudeConfigDir $dir
  if ($problem) {
    if ($Report) { Write-Warn "ignoring $($Paths.ClaudeAuth): configDir is $problem ($dir); the default Claude account source applies" }
    return $null
  }
  return $dir
}

# 'own restart --claude-config-dir <dir>|default' (05 sec. 5.7): the same file own.accounts writes, so every later
# start (own start, the desktop shell, a restart without the option) keeps the source.
function Set-ClaudeConfigDir($Paths, [string]$Value) {
  if ($Value -eq 'default') {
    if (Test-Path -LiteralPath $Paths.ClaudeAuth) { Remove-Item -LiteralPath $Paths.ClaudeAuth -Force }
    Write-Info 'Claude account source: default (%USERPROFILE%\.claude)'
    return
  }
  $content = [ordered]@{ configDir = $Value; setAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
  Write-TextFile $Paths.ClaudeAuth (($content | ConvertTo-Json) + "`n")
  Write-Info "Claude account source: $Value"
}

# ---------------------------------------------------------------- environment

function Test-RemovedName([string]$Name) {
  if ($script:ProviderKeyNames -contains $Name -or $script:IsolationBreakers -contains $Name) { return $true }
  foreach ($prefix in @($script:ProviderKeyPrefixes + $script:TelemetryPrefixes)) {
    if ($Name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Set-OwnEnvironment($Paths, [bool]$Untrusted, [bool]$Report = $true) {
  $removed = New-Object System.Collections.Generic.List[string]
  foreach ($name in @(Get-ChildItem Env: | ForEach-Object { $_.Name })) {
    if (Test-RemovedName $name) {
      $removed.Add($name)
      Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
  }
  if ($Report -and $removed.Count -gt 0) {
    Write-Warn ("removed from the service environment (values not shown): " + (($removed | Sort-Object) -join ', '))
  }
  $env:OPENCODE_CONFIG_DIR = $Paths.ConfigDir
  $env:OWN_OPEN_CODE = '1'
  $env:OPENCODE_DISABLE_AUTOUPDATE = '1'
  # Upstream's signed-out OpenCode models (opencode.ai's free and contributor models) never stand in for an account the
  # user did not set up: a default pick or a hidden agent could otherwise send prompts there (decisions TLM).
  $env:OPENCODE_DISABLE_FREE_MODELS = '1'
  # Upstream v2.3.1 reads CLAUDE.md beside or instead of AGENTS.md (and ~/.claude/CLAUDE.md); own keeps to AGENTS.md (MR18).
  $env:OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = '1'
  # The one CLAUDE_* exception (02 sec. 8.3 I8): the account source from claude-auth.json, never an inherited value.
  $claude = Get-ClaudeConfigDir $Paths $Report
  if ($claude) { $env:CLAUDE_CONFIG_DIR = $claude }
  if ($Untrusted) { $env:OPENCODE_CONFIG_PROJECT_DISABLE = '1' }
  else {
    Remove-Item Env:OPENCODE_CONFIG_PROJECT_DISABLE -ErrorAction SilentlyContinue
    Remove-Item Env:OPENCODE_DISABLE_PROJECT_CONFIG -ErrorAction SilentlyContinue
  }
}

# The env map the service gets from its config file (also what a raw exe spawn inherits through the bridge).
function Get-BridgeEnv($Paths, [bool]$Untrusted) {
  $bridge = [ordered]@{
    OPENCODE_CONFIG_DIR = $Paths.ConfigDir
    OWN_OPEN_CODE = '1'
    OPENCODE_DISABLE_AUTOUPDATE = '1'
    OPENCODE_DISABLE_FREE_MODELS = '1'
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = '1'
  }
  if ($Untrusted) { $bridge.OPENCODE_CONFIG_PROJECT_DISABLE = '1' }
  $claude = Get-ClaudeConfigDir $Paths $false
  if ($claude) { $bridge.CLAUDE_CONFIG_DIR = $claude }
  return $bridge
}

function Get-ServiceMode($Paths) {
  $config = Read-JsonFile $Paths.ServiceConfig
  $envMap = Get-Prop $config 'env'
  if ((Get-Prop $envMap 'OPENCODE_CONFIG_PROJECT_DISABLE') -eq '1') { return 'untrusted' }
  return 'trusted'
}

# Step 0 (01 sec. 5.2): both service config files get identical content. Unknown keys (cors, ...) are preserved.
function Write-EnvBridge($Paths, [bool]$Untrusted) {
  $existing = Read-JsonFile $Paths.ServiceConfig
  $registration = Read-JsonFile $Paths.Registration
  $password = Get-Prop $existing 'password'
  if (-not $password) { $password = Get-Prop $registration 'password' }
  if (-not $password) { $password = New-Password }
  $port = Get-Prop $existing 'port'
  if (-not $port) { $port = Get-DefaultPort $script:Channel }
  $content = [ordered]@{ hostname = '127.0.0.1'; port = [int]$port; password = $password }
  $cors = Get-Prop $existing 'cors'
  if ($null -ne $cors) { $content.cors = @($cors) }
  $content.env = Get-BridgeEnv $Paths $Untrusted
  $json = ($content | ConvertTo-Json -Depth 5) + "`n"
  Write-TextFile $Paths.ServiceConfig $json
  Write-TextFile $Paths.Bridge $json
  return [int]$port
}

# ---------------------------------------------------------------- opencode.exe

function Assert-Exe($Paths) {
  if (-not $Paths.Exe) {
    $why = if ($script:PointerProblem) { $script:PointerProblem } else { "no version pointer $($Paths.Pointer)" }
    Stop-Own ("own-open-code is not installed ($why): opencode.exe not found.`n" +
      "  Install own-open-code with the desktop installer (own-desktop-<version>-win-x64.exe) or by hand with`n" +
      "  own\.out\build\<version>\bin\own.cmd install (own\scripts\build-desktop.ps1 builds both). For a bare CLI build`n" +
      "  (own\scripts\build-own.ps1) point OWN_OPENCODE_EXE at own\.out\build\<version>\cli-windows-x64\bin\opencode.exe.")
  }
  if (-not (Test-ExePresent $Paths)) {
    Stop-Own ("opencode.exe not found at $($Paths.Exe).`n" +
      "  Install own-open-code with the desktop installer (own-desktop-<version>-win-x64.exe) or by hand with`n" +
      "  own\.out\build\<version>\bin\own.cmd install (own\scripts\build-desktop.ps1 builds both). For a bare CLI build`n" +
      "  (own\scripts\build-own.ps1) point OWN_OPENCODE_EXE at own\.out\build\<version>\cli-windows-x64\bin\opencode.exe.")
  }
}

function Invoke-Exe($Paths, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Paths.Exe @Arguments
    $code = $LASTEXITCODE
  }
  finally { $ErrorActionPreference = $previous }
  return [pscustomobject]@{ Code = $code; Output = @($output) }
}

# `service start` spawns the detached service, and CreateProcess(bInheritHandles=TRUE) lets it inherit every
# inheritable handle of the CLI - and of this PowerShell process, including the caller's stdout/stderr pipes.
# With `own start | ...`, `2>&1` or a CI runner, the caller would then block until the service exits. Starting the
# CLI through ShellExecute (Start-Process without redirection or -NoNewWindow) inherits no handles; the CLI still
# inherits this process's environment. Its own output is not shown; failures point at the opencode log.
function Invoke-ExeDetached($Paths, [string[]]$Arguments) {
  $process = Start-Process -FilePath $Paths.Exe -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  $null = $process.Handle # PS 5.1 only reports ExitCode when the handle was opened before exit
  $process.WaitForExit()
  return [pscustomobject]@{ Code = $process.ExitCode }
}

function Get-ExeVersion($Paths) {
  $result = Invoke-Exe $Paths @('--version')
  $text = ($result.Output -join "`n").Trim()
  if ($result.Code -ne 0) { Stop-Own "$($Paths.Exe) --version failed (exit $($result.Code))" }
  return ($text -replace '^opencode\s+v?', '')
}

# Guard: never run an upstream (non-own) build with the own environment.
# `--version` costs about 150 ms warm and seconds on the first run after an install or a reboot, so the installed exe's
# answer is kept in OWN_HOME\state\exe-version.json under its path, length and last write time: a replaced exe is asked
# again. OWN_OPENCODE_EXE (a dev build that may be rebuilt in place) is always asked.
function Assert-OwnBuild($Paths) {
  $cacheFile = Join-Path $Paths.OwnHome 'state\exe-version.json'
  $exe = Get-Item -LiteralPath $Paths.Exe -Force
  $key = "$($exe.FullName)|$($exe.Length)|$($exe.LastWriteTimeUtc.Ticks)"
  $cached = if ($env:OWN_OPENCODE_EXE) { $null } else { Read-JsonFile $cacheFile }
  # Only an own verdict is kept, so anything else there is a miss rather than a refusal.
  $hit = (Get-Prop $cached 'key') -eq $key -and [string](Get-Prop $cached 'version') -match '-own\.\d+$'
  $version = if ($hit) { [string](Get-Prop $cached 'version') } else { Get-ExeVersion $Paths }
  if ($version -notmatch '-own\.\d+$') {
    Stop-Own "$($Paths.Exe) reports version '$version', which is not an own-channel build (<upstream>-own.<k>). Refusing to start it."
  }
  # Only where this process's writes to OWN_HOME are known to land in the real folder (Assert-NotVirtualized).
  if (-not $hit -and -not $env:OWN_OPENCODE_EXE -and $script:WritesChecked) {
    # Only a cache: a failed write just asks the exe again next time.
    try { Write-TextFile $cacheFile ((([ordered]@{ key = $key; version = $version }) | ConvertTo-Json) + "`n") }
    catch { }
  }
  return $version
}

# ---------------------------------------------------------------- service HTTP

[Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy

function Get-Registration($Paths) {
  $registration = Read-JsonFile $Paths.Registration
  if ($null -eq $registration -or -not (Get-Prop $registration 'url')) { return $null }
  return $registration
}

function Invoke-Service($Registration, [string]$Method, [string]$Path) {
  $pair = "opencode:" + (Get-Prop $Registration 'password')
  $headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair)) }
  $uri = ([string](Get-Prop $Registration 'url')).TrimEnd('/') + $Path
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -TimeoutSec 10 -UseBasicParsing
}

# Registration file plus a live /api/info whose pid matches, like the client's discover().
function Get-RunningService($Paths) {
  $registration = Get-Registration $Paths
  if ($null -eq $registration) { return $null }
  # The registration outlives a reboot, crash or kill (the service removes it only when it shuts down cleanly), and in
  # Windows PowerShell a connect to a closed loopback port takes about 2 s to fail. So nothing is asked when the
  # registered pid is dead; a live pid (possibly reused by another process) still has to answer /api/info with it.
  # GetProcessById opens no handle (an elevated service counts as alive) and costs a fraction of Get-Process.
  $servicePid = (Get-Prop $registration 'pid') -as [int]
  if (-not $servicePid) { return $null }
  try { [void][Diagnostics.Process]::GetProcessById($servicePid) }
  catch { return $null }
  try { $info = Invoke-Service $registration 'GET' '/api/info' }
  catch { return $null }
  if ((Get-Prop $info 'pid') -ne (Get-Prop $registration 'pid')) { return $null }
  return [pscustomobject]@{ Registration = $registration; Info = $info; Url = ([string](Get-Prop $registration 'url')).TrimEnd('/') }
}

function Get-ActiveSessionCount($Service) {
  try {
    $active = Invoke-Service $Service.Registration 'GET' '/api/session/active'
    $data = Get-Prop $active 'data'
    if ($null -eq $data) { return 0 }
    return @($data.PSObject.Properties).Count
  }
  catch {
    Write-Warn "could not list active sessions ($($_.Exception.Message)); assuming none"
    return 0
  }
}

# $true when the stop was agreed to (--force or a yes), $false when no session was running (nothing was asked).
function Confirm-Stop($Service, [string[]]$Arguments, [string]$Action) {
  if (Test-Flag $Arguments '--force') { return $true }
  $count = Get-ActiveSessionCount $Service
  if ($count -eq 0) { return $false }
  $prompt = "$count session(s) are running. $Action stops the service and interrupts them (they resume on the next start, with a cold cache). Continue? [y/N]"
  if ([Console]::IsInputRedirected -or $script:NoPrompt) {
    Stop-Own "$count session(s) are running; re-run with --force to $($Action.ToLowerInvariant()) anyway." $script:ExitSessionRunning
  }
  $answer = Read-Host $prompt
  if ($answer -notmatch '^(y|yes)$') { Stop-Own 'cancelled.' 1 }
  return $true
}

# Remote-access wake-up (05 sec. 13.4 "기동 깨우기"): a fresh service has no Location, so own-remote (and with it the
# gateway listener) would only start when a client first opens one. When OWN_HOME\gateway.json says the gateway is on,
# call own.remote gateway.status once at the control location; own-remote then starts the listener and pins itself.
# The call opens the control Location, so it answers once every plugin there is loaded: 7-11 s on this PC at 90 % CPU,
# longer under more load (RH-50: the 2.0.32-own.9 release smoke's restart outlasted the former 60 s, said the gateway
# would start with the app and found no listener, while own-remote started it by itself once loaded).
$script:GatewayWakeSeconds = 300
function Invoke-GatewayWake($Paths, $Service) {
  $settings = Read-JsonFile (Join-Path $Paths.OwnHome 'gateway.json')
  if ($null -eq $settings -or (Get-Prop $settings 'enabled') -ne $true) { return }
  if (-not (Get-PluginDir $Paths 'own-remote')) {
    Write-Warn "remote access is on in $(Join-Path $Paths.OwnHome 'gateway.json'), but own.remote is not installed under $($Paths.Plugins)"
    return
  }
  $pair = "opencode:" + (Get-Prop $Service.Registration 'password')
  $headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair)) }
  $uri = "$($Service.Url)/api/rpc/own.remote/gateway.status?location%5Bdirectory%5D=$([Uri]::EscapeDataString($Paths.Control))"
  # Since upstream v2.4.0 (#63814) plugins load in the background: the call answers rpc.unavailable (400) until
  # own.remote registered at the control Location, so it is asked again until the same deadline (MR18).
  $deadline = (Get-Date).AddSeconds($script:GatewayWakeSeconds)
  while ($true) {
    try {
      $result = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body '{"input":{}}' -TimeoutSec $script:GatewayWakeSeconds -UseBasicParsing
      $view = Get-Prop $result 'output'
      $state = Get-Prop $view 'state'
      if ($state -eq 'listening') { Write-Info "remote access gateway listening on $(Get-Prop $view 'url')" }
      else { Write-Warn "remote access gateway is $state ($(Get-Prop $view 'problem')); see Settings > Devices" }
      return
    }
    catch {
      if ("$($_.ErrorDetails.Message)" -match 'rpc\.unavailable' -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        continue
      }
      Write-Warn "could not wake the remote access gateway ($($_.Exception.Message)); it starts once the service has loaded its plugins, or when the app first connects"
      return
    }
  }
}

function New-PairingLink($Service) {
  $pairing = Invoke-Service $Service.Registration 'POST' '/api/pair'
  return "$($Service.Url)/auth/connect/$(Get-Prop $pairing 'code')"
}

# ---------------------------------------------------------------- own config (plugins, permissions)

function Get-OwnConfigObject($Paths) {
  $plugins = @()
  # Order = activation order (01 sec. 4, 02 sec. 8.2, 06 sec. 2.6, 09 sec. 5.1, 10 H0): own-accounts, own-remote,
  # own-team, claude-auth (the bundled Claude plugin, always on), own-telemetry, own-computer-use, own-import, own-harness,
  # own-omo, own-creator.
  # The installed version's folders (app\<ver>\plugins\<name>); every switch rewrites them (Sync-ConfigPlugins).
  foreach ($name in $script:ManagedPlugins) {
    $dir = Get-PluginDir $Paths $name
    if ($dir) { $plugins += ($dir -replace '\\', '/') }
  }
  $permissions = @($script:Permissions | ForEach-Object { [ordered]@{ action = $_[0]; resource = $_[1]; effect = $_[2] } })
  return [ordered]@{ update = 'disable'; share = 'disabled'; plugins = $plugins; permissions = $permissions }
}

function Initialize-OwnConfig($Paths, [bool]$Force) {
  if ((Test-Path -LiteralPath $Paths.ConfigFile) -and -not $Force) { return $false }
  if (Test-Path -LiteralPath $Paths.ConfigFile) {
    $backup = "$($Paths.ConfigFile).bak-$(Get-Date -Format yyyyMMddHHmmss)"
    Copy-Item -LiteralPath $Paths.ConfigFile -Destination $backup
    Write-Info "backed up the previous config to $backup"
  }
  $creator = @()
  if (Test-Path -LiteralPath $Paths.ConfigFile) {
    $creator = @(Get-CreatorPluginEntries ([IO.File]::ReadAllText($Paths.ConfigFile)) $Paths)
  }
  $config = Get-OwnConfigObject $Paths
  # Code plugins own-creator listed (17 sec. 12.4) stay, at the end, after the own bundles.
  if ($creator.Count -gt 0) { $config.plugins = @($config.plugins) + $creator }
  Write-TextFile $Paths.ConfigFile ((ConvertTo-Json $config -Depth 6) + "`n")
  if ($creator.Count -gt 0) { Write-Info "kept $($creator.Count) creator plugin entr$(if ($creator.Count -eq 1) { 'y' } else { 'ies' }) at the end of plugins" }
  Write-Info "wrote $($Paths.ConfigFile)"
  if (@($config.plugins).Count -lt 2) {
    Write-Warn "own plugin bundles are not installed under $($Paths.Plugins) yet (Phase 1); the config lists only the ones present. Run 'own config init --force' after installing them."
  }
  return $true
}

function Test-OwnConfig($Paths) {
  if (-not (Test-Path -LiteralPath $Paths.ConfigFile)) { return }
  $text = Get-Content -LiteralPath $Paths.ConfigFile -Raw -Encoding UTF8
  if ($text -notmatch '"update"\s*:\s*"disable"') {
    Write-Warn "$($Paths.ConfigFile) does not contain `"update`": `"disable`" (01 sec. 5.5). OPENCODE_DISABLE_AUTOUPDATE=1 still applies to launcher starts."
  }
}

# ---- the own plugin entries of opencode.jsonc (managed: they always name the installed version's folders)
#
# The service loads its plugins from the paths in opencode.jsonc. Since there is no junction any more, those paths
# name a version folder (app\<ver>\plugins\<name>), and every switch (install, update, rollback, the first start after
# one) points them at the new version. Only string values that are an own bundle folder of this OWN_HOME are touched:
# app\current\plugins\<name> (launcher 0.3.0) or app\<any version>\plugins\<name>, with / or \, optionally as a file:///
# URL or with \index.js; other entries, comments, order and formatting stay byte for byte. Why not a stable path
# instead: OPENCODE_CONFIG_CONTENT (a config the launcher could hand over) is an isolation breaker the launcher removes
# (01 sec. 13), and a stub plugin at a fixed path that re-exports the versioned bundle would make the host list the
# stub instead of the bundle (own.accounts' allowlist and PluginConfig recognise the bundles by their entry files).

# The string literals of a JSONC text outside // and /* */ comments: Start and Length of the quoted token, and Body
# (the raw text between the quotes).
function Get-JsoncStrings([string]$Text) {
  $list = New-Object System.Collections.Generic.List[object]
  $n = $Text.Length
  $i = 0
  while ($i -lt $n) {
    $c = $Text[$i]
    if ($c -eq [char]'"') {
      $start = $i
      $i++
      while ($i -lt $n -and $Text[$i] -ne [char]'"') {
        if ($Text[$i] -eq [char]'\') { $i++ }
        $i++
      }
      if ($i -ge $n) { break }
      $list.Add([pscustomobject]@{ Start = $start; Length = $i - $start + 1; Body = $Text.Substring($start + 1, $i - $start - 1) })
      $i++
      continue
    }
    if ($c -eq [char]'/' -and $i + 1 -lt $n -and $Text[$i + 1] -eq [char]'/') {
      $next = $Text.IndexOf("`n", $i)
      $i = if ($next -lt 0) { $n } else { $next + 1 }
      continue
    }
    if ($c -eq [char]'/' -and $i + 1 -lt $n -and $Text[$i + 1] -eq [char]'*') {
      $next = $Text.IndexOf('*/', $i + 2)
      $i = if ($next -lt 0) { $n } else { $next + 2 }
      continue
    }
    $i++
  }
  return , $list
}

function Get-HomeKey($Paths) { return [IO.Path]::GetFullPath($Paths.OwnHome).Replace('\', '/').TrimEnd('/') }

# The code plugin entries own-creator wrote into a config text (17 sec. 12.4), in order: plugins elements naming a
# version folder under OWN_HOME\creator\ext, as a plain string or as own-creator's {"package": ..., "options": {...}}
# object (flat options, as own-creator writes them). Returns their values (strings, or objects from ConvertFrom-Json).
function Get-CreatorPluginEntries([string]$Text, $Paths) {
  $prefix = (Get-HomeKey $Paths) + '/creator/ext/'
  $isCreator = { param([string]$Value) $Value.Replace('\', '/').StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }
  $found = New-Object System.Collections.Generic.List[object]
  $objects = [regex]::Matches($Text, '\{\s*"package"\s*:\s*"(?<p>(?:[^"\\]|\\.)*)"\s*(?:,\s*"options"\s*:\s*\{[^{}]*\}\s*)?\}')
  $taken = New-Object System.Collections.Generic.List[int]
  foreach ($match in $objects) {
    try { $value = [regex]::Unescape($match.Groups['p'].Value) } catch { continue }
    if (-not (& $isCreator $value)) { continue }
    try { $found.Add([pscustomobject]@{ At = $match.Index; Value = ($match.Value | ConvertFrom-Json) }) } catch { continue }
    $taken.Add($match.Groups['p'].Index - 1)
  }
  foreach ($token in (Get-JsoncStrings $Text)) {
    if ($taken.Contains($token.Start)) { continue }
    try { $value = [regex]::Unescape($token.Body) } catch { continue }
    if (-not (& $isCreator $value)) { continue }
    if ((Get-JsoncPrevious $Text $token.Start) -notin @([char]'[', [char]',')) { continue }
    $found.Add([pscustomobject]@{ At = $token.Start; Value = $value })
  }
  return @($found | Sort-Object At | ForEach-Object { $_.Value })
}

# {Name, Tail, Prefix, Legacy} when $Value is an own bundle folder of this OWN_HOME; else $null. The former in-app
# Claude plugin install, OWN_HOME\thirdparty\claude-auth (launcher 0.5.0 and earlier), counts as the claude-auth
# bundle's entry (Legacy): every sync points it at app\<ver>\plugins\claude-auth in place, keeping its position.
function Get-ManagedPluginEntry([string]$Value, [string]$HomeKey) {
  $value = $Value.Replace('\', '/')
  $prefix = ''
  if ($value -match '^file:///') {
    $prefix = $value.Substring(0, 8)
    $value = $value.Substring(8)
  }
  $legacy = [regex]::Match($value, '^(?<home>.+)/thirdparty/claude-auth(?<tail>/server\.js)?/?$', 'IgnoreCase')
  if ($legacy.Success -and [string]::Equals($legacy.Groups['home'].Value.TrimEnd('/'), $HomeKey, [StringComparison]::OrdinalIgnoreCase)) {
    return [pscustomobject]@{ Name = 'claude-auth'; Tail = $legacy.Groups['tail'].Value; Prefix = $prefix; Legacy = $true }
  }
  $match = [regex]::Match($value, '^(?<home>.+)/app/(?<ver>[^/]+)/plugins/(?<name>own-accounts|own-remote|own-team|claude-auth|own-telemetry|own-computer-use|own-import|own-harness|own-omo|own-creator)(?<tail>/index\.js|/server\.js)?/?$', 'IgnoreCase')
  if (-not $match.Success) { return $null }
  if (-not [string]::Equals($match.Groups['home'].Value.TrimEnd('/'), $HomeKey, [StringComparison]::OrdinalIgnoreCase)) { return $null }
  $version = $match.Groups['ver'].Value
  if ($version -ne 'current' -and $version -notmatch $script:VersionNamePattern) { return $null }
  return [pscustomobject]@{ Name = $match.Groups['name'].Value.ToLowerInvariant(); Tail = $match.Groups['tail'].Value; Prefix = $prefix; Legacy = $false }
}

# $Text with the own bundle entries of this OWN_HOME pointed at app\$Folder\plugins\<name>. Returns {Text, Changed,
# Missing}: Missing names bundles the version does not have (their entries stay as they were).
function Update-ManagedPluginEntries([string]$Text, $Paths, [string]$Folder) {
  $homeKey = Get-HomeKey $Paths
  $builder = New-Object System.Text.StringBuilder
  $last = 0
  $changed = 0
  $missing = New-Object System.Collections.Generic.List[string]
  foreach ($token in (Get-JsoncStrings $Text)) {
    try { $value = [regex]::Unescape($token.Body) } catch { continue }
    $entry = Get-ManagedPluginEntry $value $homeKey
    if ($null -eq $entry) { continue }
    if (-not (Test-Path -LiteralPath (Join-Path $Paths.App "$Folder\plugins\$($entry.Name)") -PathType Container)) {
      # A version from before the bundled Claude plugin loads the former install itself: nothing to report.
      if (-not $entry.Legacy -and -not $missing.Contains($entry.Name)) { $missing.Add($entry.Name) }
      continue
    }
    $wanted = "$($entry.Prefix)$homeKey/app/$Folder/plugins/$($entry.Name)$($entry.Tail)"
    if ([string]::Equals($value.Replace('\', '/'), $wanted, [StringComparison]::OrdinalIgnoreCase)) { continue }
    [void]$builder.Append($Text, $last, $token.Start - $last)
    [void]$builder.Append('"' + $wanted.Replace('\', '\\').Replace('"', '\"') + '"')
    $last = $token.Start + $token.Length
    $changed++
  }
  [void]$builder.Append($Text, $last, $Text.Length - $last)
  return [pscustomobject]@{ Text = $builder.ToString(); Changed = $changed; Missing = @($missing) }
}

# Points the own plugin entries of opencode.jsonc at the installed version (its BOM, if any, is kept). $true when the
# file changed. Callers do this only while no service runs: the service reloads plugins when its config changes.
function Sync-ConfigPlugins($Paths) {
  if ($null -eq $Paths.Active -or -not (Test-Path -LiteralPath $Paths.ConfigFile -PathType Leaf)) { return $false }
  $folder = Split-Path -Leaf $Paths.Active.Dir
  $raw = [IO.File]::ReadAllBytes($Paths.ConfigFile)
  $bom = $raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF
  $skip = if ($bom) { 3 } else { 0 }
  $text = (New-Object Text.UTF8Encoding $false).GetString($raw, $skip, $raw.Length - $skip)
  $result = Update-ManagedPluginEntries $text $Paths $folder
  if ($result.Missing.Count -gt 0) {
    Write-Warn "$($Paths.ConfigFile) loads $($result.Missing -join ', '), which $folder does not have; left as it was"
  }
  if ($result.Changed -eq 0) { return $false }
  Write-TextFile $Paths.ConfigFile $result.Text $bom
  Write-Info "pointed the own plugin entries of $($Paths.ConfigFile) at $folder ($($result.Changed) changed)"
  return $true
}

# $true when opencode.jsonc has an own plugin entry that does not name the installed version.
function Test-ConfigPluginsStale($Paths) {
  if ($null -eq $Paths.Active -or -not (Test-Path -LiteralPath $Paths.ConfigFile -PathType Leaf)) { return $false }
  $text = [IO.File]::ReadAllText($Paths.ConfigFile)
  return (Update-ManagedPluginEntries $text $Paths (Split-Path -Leaf $Paths.Active.Dir)).Changed -gt 0
}

# The last character before $Position outside strings and // or /* */ comments that is not whitespace ([char]0 if none).
function Get-JsoncPrevious([string]$Text, [int]$Position) {
  $last = [char]0
  $i = 0
  while ($i -lt $Position) {
    $c = $Text[$i]
    if ($c -eq [char]'"') {
      $i++
      while ($i -lt $Position -and $Text[$i] -ne [char]'"') {
        if ($Text[$i] -eq [char]'\') { $i++ }
        $i++
      }
      $last = [char]'"'
      $i++
      continue
    }
    if ($c -eq [char]'/' -and $i + 1 -lt $Position -and $Text[$i + 1] -eq [char]'/') {
      $next = $Text.IndexOf("`n", $i)
      $i = if ($next -lt 0) { $Position } else { $next + 1 }
      continue
    }
    if ($c -eq [char]'/' -and $i + 1 -lt $Position -and $Text[$i + 1] -eq [char]'*') {
      $next = $Text.IndexOf('*/', $i + 2)
      $i = if ($next -lt 0) { $Position } else { $next + 2 }
      continue
    }
    if (-not [char]::IsWhiteSpace($c)) { $last = $c }
    $i++
  }
  return $last
}

# A bundle the installed version brings and the version it replaced did not have (e.g. own-computer-use, own-team,
# own-import, own-harness, claude-auth) gets an entry in an existing opencode.jsonc (launcher 0.5.0): right after the
# closest managed entry before it in activation order (own-team after own-remote; claude-auth after own-team, unless
# the config has the former Claude install's line, which the sync before this points at the bundle in place; own-import
# after own-computer-use; own-harness after own-import; own-omo after own-harness; own-creator after own-omo), when that entry is a plain string in the plugins array. Entries of
# bundles the previous version already had are never re-added (the user removed them), and nothing is inserted next to
# an object entry or when no managed entry exists; Test-ConfigPlugins still reports what is missing. $true when the
# file changed.
function Add-NewConfigPlugins($Paths, [string]$OldDir) {
  if ($null -eq $Paths.Active -or -not (Test-Path -LiteralPath $Paths.ConfigFile -PathType Leaf)) { return $false }
  $folder = Split-Path -Leaf $Paths.Active.Dir
  $raw = [IO.File]::ReadAllBytes($Paths.ConfigFile)
  $bom = $raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF
  $skip = if ($bom) { 3 } else { 0 }
  $text = (New-Object Text.UTF8Encoding $false).GetString($raw, $skip, $raw.Length - $skip)
  $homeKey = Get-HomeKey $Paths
  $added = New-Object System.Collections.Generic.List[string]
  foreach ($name in $script:ManagedPlugins) {
    if (-not (Test-Path -LiteralPath (Join-Path $Paths.Active.Dir "plugins\$name") -PathType Container)) { continue }
    if ($OldDir -and (Test-Path -LiteralPath (Join-Path $OldDir "plugins\$name") -PathType Container)) { continue }
    $entries = @(foreach ($token in (Get-JsoncStrings $text)) {
        try { $value = [regex]::Unescape($token.Body) } catch { continue }
        $entry = Get-ManagedPluginEntry $value $homeKey
        if ($null -ne $entry) { [pscustomobject]@{ Name = $entry.Name; Token = $token } }
      })
    if (@($entries | Where-Object { $_.Name -eq $name }).Count -gt 0) { continue }
    $rank = [array]::IndexOf($script:ManagedPlugins, $name)
    $before = @($entries | Where-Object { [array]::IndexOf($script:ManagedPlugins, $_.Name) -lt $rank })
    if ($before.Count -eq 0) { continue }
    $anchor = $before[-1].Token
    if ((Get-JsoncPrevious $text $anchor.Start) -notin @([char]'[', [char]',')) { continue }
    $lineStart = $text.LastIndexOf("`n", [Math]::Max(0, $anchor.Start - 1)) + 1
    $indent = $text.Substring($lineStart, $anchor.Start - $lineStart) -replace '\S', ' '
    $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $quoted = '"' + "$homeKey/app/$folder/plugins/$name".Replace('\', '\\').Replace('"', '\"') + '"'
    $end = $anchor.Start + $anchor.Length
    $text = $text.Substring(0, $end) + ',' + $newline + $indent + $quoted + $text.Substring($end)
    $added.Add($name)
  }
  if ($added.Count -eq 0) { return $false }
  Write-TextFile $Paths.ConfigFile $text $bom
  Write-Info "added $($added -join ', ') to the plugins of $($Paths.ConfigFile) (new in $folder)"
  return $true
}

# The former in-app Claude plugin install (02 sec. 8.2; launcher 0.5.0 and earlier): OWN_HOME\thirdparty\claude-auth
# held the npm install (node_modules, about 130 MB in 18,000 files, its package files and the patch record and
# originals) next to own's account list (claude-accounts.json) and the per-account state and locks
# (claude-auth-state\). Once the installed version ships the bundle and no config line loads the folder any more, the
# install's files go and the list and the state stay, where the bundled plugin keeps reading them: every login is
# kept. Anything else in the folder stays too. Called after a successful install or update (never inside its
# transaction, so a rollback finds the old install intact); a file in use is reported and tried again next time.
function Remove-LegacyClaudeInstall($Paths) {
  $dir = Join-Path $Paths.OwnHome 'thirdparty\claude-auth'
  if ($null -eq (Get-LinkAttributes (Join-Path $dir 'node_modules')) -and $null -eq (Get-LinkAttributes (Join-Path $dir 'package-lock.json'))) { return }
  if (-not (Get-PluginDir $Paths 'claude-auth')) { return }
  if (Test-Path -LiteralPath $Paths.ConfigFile -PathType Leaf) {
    $homeKey = Get-HomeKey $Paths
    $text = [IO.File]::ReadAllText($Paths.ConfigFile)
    foreach ($token in (Get-JsoncStrings $text)) {
      try { $value = [regex]::Unescape($token.Body) } catch { continue }
      $entry = Get-ManagedPluginEntry $value $homeKey
      if ($null -ne $entry -and $entry.Legacy) { return }
    }
  }
  $removed = New-Object System.Collections.Generic.List[string]
  foreach ($name in @('node_modules', 'own-patch-original', 'package.json', 'package-lock.json', 'server.js', 'own-patch.json')) {
    $item = Join-Path $dir $name
    if ($null -eq (Get-LinkAttributes $item)) { continue }
    try { Remove-Folder $item; $removed.Add($name) }
    catch { Write-Warn "could not remove $item of the former Claude plugin install ($($_.Exception.Message)); the next update tries again" }
  }
  if ($removed.Count -gt 0) {
    Write-Info "removed the former Claude plugin install from $dir ($($removed -join ', ')); the Claude account list and login state stay there"
  }
}

# ---------------------------------------------------------------- commands

function Start-OwnService($Paths, [string[]]$Arguments) {
  $untrusted = Test-Flag $Arguments '--untrusted'
  Assert-Exe $Paths
  $running = Get-RunningService $Paths
  # open and start check for a packaged app's write virtualization (about 100 ms) only here, when a service is about to
  # be started or replaced: reusing a healthy one writes nothing under OWN_HOME. The other callers checked in main.
  if ($null -eq $running) { Assert-NotVirtualized $Paths $script:command }
  $version = Assert-OwnBuild $Paths
  New-Item -ItemType Directory -Force -Path $Paths.OwnHome, $Paths.Control, $Paths.ConfigDir | Out-Null
  [void](Initialize-OwnConfig $Paths $false)
  Test-OwnConfig $Paths

  $wanted = if ($untrusted) { 'untrusted' } else { 'trusted' }
  $fresh = $null -eq $running
  if ($null -ne $running -and (Get-ServiceMode $Paths) -ne $wanted) {
    Assert-NotVirtualized $Paths $script:command
    Write-Info "the running service is $(Get-ServiceMode $Paths); restarting it $wanted (01 sec. 5.3: --untrusted is service-wide)"
    [void](Confirm-Stop $running $Arguments 'Restart')
    Set-OwnEnvironment $Paths $untrusted $false
    $stop = Invoke-Exe $Paths @('service', 'stop')
    if ($stop.Code -ne 0) { Stop-Own "opencode service stop failed (exit $($stop.Code))" }
    $fresh = $true
  }
  elseif ($null -ne $running -and (Get-Prop $running.Info 'version') -ne $version) {
    # `service start` replaces a service of another version; ask first like a restart.
    Assert-NotVirtualized $Paths $script:command
    Write-Info "the running service is $(Get-Prop $running.Info 'version'); replacing it with $version"
    [void](Confirm-Stop $running $Arguments 'Restart')
    $fresh = $true
  }
  # A service about to start loads the plugins of the version it runs (a running one is left alone: it would reload
  # its plugins on a config change).
  if ($fresh) {
    try { [void](Sync-ConfigPlugins $Paths) }
    catch { Write-Warn "could not update the plugin entries of $($Paths.ConfigFile) ($($_.Exception.Message))" }
  }
  elseif (Test-ConfigPluginsStale $Paths) {
    Write-Warn "$($Paths.ConfigFile) loads own plugins of another version than $(Split-Path -Leaf $Paths.Active.Dir); 'own restart' points them at it"
  }

  Set-OwnEnvironment $Paths $untrusted
  $port = Write-EnvBridge $Paths $untrusted
  $result = Invoke-ExeDetached $Paths @('service', 'start')
  if ($result.Code -ne 0) {
    Stop-Own ("opencode service start failed (exit $($result.Code)). Details: the opencode log under " +
      "$(Split-Path -Parent $Paths.Database)\log, or run '$($Paths.Exe) service start' with the environment from 'own env'.")
  }
  $service = Get-RunningService $Paths
  if ($null -eq $service) { Stop-Own "service start returned but no healthy own service is registered at $($Paths.Registration)" }
  if (-not ($service.Url -match ":$port$")) { Write-Warn "service listens on $($service.Url), not the configured port $port" }
  if (-not (Get-PluginDir $Paths 'own-accounts')) {
    Write-Warn "own.accounts is not installed$(if ($Paths.Plugins) { " under $($Paths.Plugins)" }): no own accounts/slots."
  }
  # The desktop shell waits for this run to end, and its first control RPC sets up own.remote, which starts the gateway
  # by itself; a CLI start may be the only client for a while (a phone connecting without the app), so it wakes it.
  if (-not $script:DesktopClient) { Invoke-GatewayWake $Paths $service }
  return $service
}

function Invoke-Open($Paths, [string[]]$Arguments) {
  $service = Start-OwnService $Paths $Arguments
  Write-Output "$($service.Url)/"
  $link = New-PairingLink $service
  if (Test-Flag $Arguments '--no-browser') {
    Write-Info "one-time pairing link (expires in 5 minutes): $link"
    return
  }
  $edge = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($edge) { Start-Process -FilePath $edge -ArgumentList "--app=$link" | Out-Null }
  else { Start-Process -FilePath $link | Out-Null }
}

function Invoke-Stop($Paths, [string[]]$Arguments, [string]$Action = 'Stop') {
  Assert-Exe $Paths
  $service = Get-RunningService $Paths
  if ($null -eq $service) {
    Write-Info 'own service is not running'
    return
  }
  [void](Confirm-Stop $service $Arguments $Action)
  Set-OwnEnvironment $Paths ((Get-ServiceMode $Paths) -eq 'untrusted') $false
  $result = Invoke-Exe $Paths @('service', 'stop')
  if ($result.Code -ne 0) { Stop-Own "opencode service stop failed (exit $($result.Code))" }
  Write-Info "stopped $($service.Url) (pid $(Get-Prop $service.Registration 'pid'))"
}

function Invoke-Status($Paths, [string[]]$Arguments) {
  $service = Get-RunningService $Paths
  $registration = Get-Registration $Paths
  $status = [ordered]@{
    channel = $script:Channel
    state = if ($null -ne $service) { 'running' } elseif ($null -ne $registration) { 'stale-registration' } else { 'stopped' }
    url = if ($null -ne $service) { "$($service.Url)/" } else { $null }
    version = if ($null -ne $service) { Get-Prop $service.Info 'version' } else { $null }
    pid = if ($null -ne $service) { Get-Prop $service.Registration 'pid' } else { $null }
    mode = Get-ServiceMode $Paths
    claude_config_dir = Get-ClaudeConfigDir $Paths $false
    exe = $Paths.Exe
    exe_present = Test-ExePresent $Paths
    installed = $(if ($null -ne $Paths.Active) { $Paths.Active.Version } else { $null })
    app = $(if ($null -ne $Paths.Active) { $Paths.Active.Dir } else { $null })
    # pointer: app\current.json; junction/folder: an install of launcher 0.3.0 or earlier, migrated by the next switch.
    app_source = $(if ($null -ne $Paths.Active) { $Paths.Active.Source } else { $null })
    pointer_problem = $script:PointerProblem
    # A packaged app whose private LocalCache holds a copy of OWN_HOME (an install made from inside it), and whether
    # this process's own writes land in one (see the header).
    container_copies = @(Get-ContainerCopies $Paths | ForEach-Object { $_.Path })
    virtualized = $(if ($null -ne ($virtual = Get-WriteVirtualization $Paths.OwnHome)) { $virtual.Family } else { $null })
    rollback_to = Get-Prop (Read-JsonFile $Paths.InstallState) 'previous'
    own_home = $Paths.OwnHome
    config_dir = $Paths.ConfigDir
    registration = $Paths.Registration
    bridge = $Paths.Bridge
    bridge_in_sync = Test-BridgeInSync $Paths
    database = $Paths.Database
    plugins = [ordered]@{
      'own.accounts' = [bool](Get-PluginDir $Paths 'own-accounts')
      'own.remote' = [bool](Get-PluginDir $Paths 'own-remote')
      'own.team' = [bool](Get-PluginDir $Paths 'own-team')
      'claude-auth' = [bool](Get-PluginDir $Paths 'claude-auth')
      'own.telemetry' = [bool](Get-PluginDir $Paths 'own-telemetry')
      'own.computer-use' = [bool](Get-PluginDir $Paths 'own-computer-use')
      'own.import' = [bool](Get-PluginDir $Paths 'own-import')
      'own.harness' = [bool](Get-PluginDir $Paths 'own-harness')
      'own.omo' = [bool](Get-PluginDir $Paths 'own-omo')
      'own.creator' = [bool](Get-PluginDir $Paths 'own-creator')
    }
    launcher = $script:LauncherVersion
  }
  if (Test-Flag $Arguments '--json') {
    Write-Output ($status | ConvertTo-Json -Depth 4)
  }
  else {
    foreach ($key in $status.Keys) {
      $value = $status[$key]
      if ($value -is [System.Collections.IDictionary]) { $value = ($value.Keys | ForEach-Object { "$_=$($value[$_])" }) -join ' ' }
      Write-Output ("{0,-15} {1}" -f $key, $value)
    }
  }
  if ($status.state -ne 'running') { exit 3 }
}

function Test-BridgeInSync($Paths) {
  if (-not (Test-Path -LiteralPath $Paths.Bridge) -or -not (Test-Path -LiteralPath $Paths.ServiceConfig)) { return $false }
  return (Get-Content -LiteralPath $Paths.Bridge -Raw) -eq (Get-Content -LiteralPath $Paths.ServiceConfig -Raw)
}

# tui/run talk to the service; start it here first (keeping the current trust mode) so the CLI reuses it instead
# of spawning one that would inherit this terminal's handles.
function Invoke-Passthrough($Paths, [string[]]$Arguments) {
  $mode = @(if ((Get-ServiceMode $Paths) -eq 'untrusted') { '--untrusted' })
  [void](Start-OwnService $Paths $mode)
  & $Paths.Exe @Arguments
  exit $LASTEXITCODE
}

function Show-Env($Paths) {
  $rows = [ordered]@{
    OPENCODE_CONFIG_DIR = $Paths.ConfigDir
    OWN_OPEN_CODE = '1'
    OPENCODE_DISABLE_AUTOUPDATE = '1'
    OPENCODE_DISABLE_FREE_MODELS = '1'
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = '1'
    OPENCODE_CONFIG_PROJECT_DISABLE = if ((Get-ServiceMode $Paths) -eq 'untrusted') { '1' } else { '(unset: trusted mode)' }
    CLAUDE_CONFIG_DIR = if ($claude = Get-ClaudeConfigDir $Paths) { "$claude (from $($Paths.ClaudeAuth))" } else { '(unset: default Claude account source)' }
    OWN_HOME = $Paths.OwnHome
    exe = $(if ($Paths.Exe) { $Paths.Exe } else { "(not installed: no $($Paths.Pointer))" })
    default_port = Get-DefaultPort $script:Channel
  }
  foreach ($key in $rows.Keys) { Write-Output ("{0,-32} {1}" -f $key, $rows[$key]) }
  $names = @(Get-ChildItem Env: | ForEach-Object { $_.Name } | Where-Object { Test-RemovedName $_ })
  if ($names.Count -gt 0) { Write-Output ("would be removed (values not shown): " + (($names | Sort-Object) -join ', ')) }
}

# ---------------------------------------------------------------- install lifecycle (01 sec. 5.1, 5.5; 05 sec. 10.4)
#
# A payload is the build output of own\scripts\build-desktop.ps1: <root>\app (the app\<ver> layout with its
# manifest.json) and <root>\bin (own.cmd, own.ps1). The desktop installer carries one in
# resources\own-payload and runs 'install --from <it> --move --no-prompt' (packages\own-desktop\build\installer.nsh).
#
# OWN_HOME after an install:
#   app\<ver>\          one folder per installed version; the current one and the previous one are kept
#   app\current.json    the version pointer {schema, version, path, previous, updatedAt, launcher}, written atomically
#                       (temp, flush, rename) on every switch. The launcher, the desktop shell and the plugins
#                       resolve app\<version> from it (next to the file; `path` is informational). No junction:
#                       launcher 0.3.0's app\current junction is read as a link only and removed on the next switch
#   bin\own.cmd, own.ps1
#   install.json        {current, previous, history[]}: what 'own rollback' switches back to
#   install.log         what install/update/rollback/uninstall did (the installer shows no console)
#   backup\opencode-own.<ver>.<stamp>.db[-wal|-shm]   the session database before each version switch (newest 5)

# ---- packaged-app (MSIX) file system write virtualization (see the header)

# The known folder a path lies under ('Local' = %LOCALAPPDATA%, 'Roaming' = %APPDATA%) and the path relative to it;
# $null outside both or under %TEMP% (never virtualized).
function Get-AppDataPlace([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if (($full + '\').StartsWith($temp + '\', [StringComparison]::OrdinalIgnoreCase)) { return $null }
  foreach ($place in @(@('Local', $env:LOCALAPPDATA), @('Roaming', $env:APPDATA))) {
    if (-not $place[1]) { continue }
    $base = [IO.Path]::GetFullPath($place[1]).TrimEnd('\')
    if ($full -eq $base -or ($full + '\').StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
      return [pscustomobject]@{ Kind = $place[0]; Base = $base; Rel = $full.Substring($base.Length).TrimStart('\') }
    }
  }
  return $null
}

# Packages whose private LocalCache holds the given relative path ('<kind>\<rel>').
function Find-PackageCopies([string]$Kind, [string]$Rel) {
  $packages = Join-Path $env:LOCALAPPDATA 'Packages'
  if (-not $env:LOCALAPPDATA -or -not (Test-Path -LiteralPath $packages -PathType Container)) { return @() }
  $found = New-Object System.Collections.Generic.List[object]
  foreach ($package in [IO.Directory]::GetDirectories($packages)) {
    $copy = Join-Path $package "LocalCache\$Kind\$Rel"
    if (Test-Path -LiteralPath $copy) { $found.Add([pscustomobject]@{ Family = Split-Path -Leaf $package; Path = $copy }) }
  }
  return $found.ToArray()
}

# Whether this process's new files at $Dir would land in a packaged app's LocalCache: a probe folder is made next to
# where $Dir goes (its nearest existing ancestor) and looked for under %LOCALAPPDATA%\Packages\*\LocalCache, then
# removed. Returns {Family, Root} or $null. OWN_TEST_VIRTUALIZED_FAMILY (tests) reports that family without probing.
function Get-WriteVirtualization([string]$Dir) {
  if ($env:OWN_TEST_VIRTUALIZED_FAMILY) {
    return [pscustomobject]@{ Family = $env:OWN_TEST_VIRTUALIZED_FAMILY; Root = Join-Path $env:LOCALAPPDATA "Packages\$($env:OWN_TEST_VIRTUALIZED_FAMILY)\LocalCache\Local" }
  }
  $place = Get-AppDataPlace $Dir
  if ($null -eq $place) { return $null }
  $parent = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
  while ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) { $parent = Split-Path -Parent $parent }
  if (-not $parent) { return $null }
  $inside = Get-AppDataPlace $parent
  if ($null -eq $inside) { $inside = [pscustomobject]@{ Kind = $place.Kind; Base = $place.Base; Rel = '' } }
  $name = ".own-write-probe-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
  $probe = Join-Path $parent $name
  try { [void][IO.Directory]::CreateDirectory($probe) } catch { return $null }
  try {
    $rel = if ($inside.Rel) { "$($inside.Rel)\$name" } else { $name }
    $copies = @(Find-PackageCopies $inside.Kind $rel)
    if ($copies.Count -eq 0) { return $null }
    return [pscustomobject]@{ Family = $copies[0].Family; Root = Join-Path $env:LOCALAPPDATA "Packages\$($copies[0].Family)\LocalCache\$($inside.Kind)" }
  }
  finally { try { [IO.Directory]::Delete($probe) } catch { } }
}

# Copies of OWN_HOME in packaged apps' LocalCache (installs made from inside such an app).
function Get-ContainerCopies($Paths) {
  $place = Get-AppDataPlace $Paths.OwnHome
  if ($null -eq $place -or -not $place.Rel) { return @() }
  return @(Find-PackageCopies $place.Kind $place.Rel)
}

# Stops install/update (exit 5) when OWN_HOME would only exist inside a packaged app's virtualized view.
# --allow-virtualized or OWN_ALLOW_VIRTUALIZED=1 (tests run inside such an app; the desktop shell's launcher runs get
# the environment, not the flag). Set once in main.
$script:AllowVirtualized = $false
# $true once Assert-NotVirtualized let this process go on: its writes to OWN_HOME land in the real folder (or
# --allow-virtualized). Later checks are skipped, and only then is the exe version cache written (Assert-OwnBuild).
$script:WritesChecked = $false

# Commands that write OWN_HOME or start a service (which then writes accounts, vault and ledger there) stop with exit 5
# when this process's writes would land in a packaged app's private copy: the rest of the system would not see them.
function Assert-NotVirtualized($Paths, [string]$Command) {
  if ($script:WritesChecked) { return }
  $virtual = if ($script:AllowVirtualized) { $null } else { Get-WriteVirtualization $Paths.OwnHome }
  if ($null -eq $virtual) {
    $script:WritesChecked = $true
    return
  }
  $what = if ($Command -in @('install', 'update', 'rollback', 'uninstall')) { "would change only that private copy of $($Paths.OwnHome)" }
  else { "would start a service whose accounts, vault and ledger writes go only to that private copy" }
  Stop-Own ("this process runs inside the packaged app $($virtual.Family), which redirects new files under " +
    "$(Split-Path -Parent $Paths.OwnHome) into $($virtual.Root). 'own $Command' $what; Explorer, the Own OpenCode app " +
    "from the Start menu and normal terminals would not see it (the app reports own-open-code as not installed). Run " +
    "the installer from Explorer (double-click) or run own from a normal PowerShell window that was not started from " +
    "that app. Nothing was changed.") $script:ExitVirtualized
}

# ---- user PATH (HKCU\Environment Path, read unexpanded and written back with its kind) or OWN_USER_PATH_FILE

function Get-UserPath {
  if ($env:OWN_USER_PATH_FILE) {
    if (-not (Test-Path -LiteralPath $env:OWN_USER_PATH_FILE)) { return '' }
    return ([IO.File]::ReadAllText($env:OWN_USER_PATH_FILE)).TrimEnd("`r", "`n")
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
  if ($null -eq $key) { return '' }
  try { return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $key.Close() }
}

function Set-UserPath([string]$Value) {
  if ($env:OWN_USER_PATH_FILE) {
    Write-TextFile $env:OWN_USER_PATH_FILE $Value
    return
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    # REG_EXPAND_SZ keeps entries like %USERPROFILE%\... working; an existing REG_SZ value stays REG_SZ.
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if (@($key.GetValueNames()) -contains 'Path' -and $key.GetValueKind('Path') -eq [Microsoft.Win32.RegistryValueKind]::String) {
      $kind = [Microsoft.Win32.RegistryValueKind]::String
    }
    $key.SetValue('Path', $Value, $kind)
  }
  finally { $key.Close() }
  Send-EnvironmentChange
}

# WM_SETTINGCHANGE "Environment": Explorer (and the terminals it starts from now on) reads the new PATH.
function Send-EnvironmentChange {
  try {
    if (-not ('OwnNative.EnvironmentBroadcast' -as [type])) {
      Add-Type -Namespace OwnNative -Name EnvironmentBroadcast -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
'@
    }
    $result = [UIntPtr]::Zero
    [void][OwnNative.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  }
  catch { Write-Warn "the user PATH changed, but running programs were not told ($($_.Exception.Message)); sign out and in if a new terminal does not find 'own'" }
}

function Get-PathKey([string]$Entry) {
  return ([Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"'))).TrimEnd('\').ToLowerInvariant()
}

# $true when the entry was added.
function Add-UserPathEntry([string]$Dir) {
  $current = Get-UserPath
  $wanted = Get-PathKey $Dir
  foreach ($entry in ($current -split ';')) { if ($entry.Trim() -and (Get-PathKey $entry) -eq $wanted) { return $false } }
  $value = if ($current.Trim() -eq '') { $Dir } elseif ($current.EndsWith(';')) { "$current$Dir" } else { "$current;$Dir" }
  Set-UserPath $value
  return $true
}

# $true when an entry was removed. The other entries stay exactly as they were.
function Remove-UserPathEntry([string]$Dir) {
  $current = Get-UserPath
  $wanted = Get-PathKey $Dir
  $parts = @($current -split ';')
  $kept = @($parts | Where-Object { -not ($_.Trim() -and (Get-PathKey $_) -eq $wanted) })
  if ($kept.Count -eq $parts.Count) { return $false }
  Set-UserPath ($kept -join ';')
  return $true
}

# ---- folders and junctions (never follows a junction when deleting)

# Attributes of the path itself (a junction is not followed); $null when nothing is there, even a broken link.
function Get-LinkAttributes([string]$Path) {
  try { return [IO.File]::GetAttributes($Path) } catch { return $null }
}

function Test-ReparsePoint($Attributes) { return $null -ne $Attributes -and [bool]($Attributes -band [IO.FileAttributes]::ReparsePoint) }

function Remove-Tree([string]$Path) {
  $attributes = Get-LinkAttributes $Path
  if ($null -eq $attributes) { return }
  if (Test-ReparsePoint $attributes) {
    # The link only; the folder it points at stays.
    if ($attributes -band [IO.FileAttributes]::Directory) { [IO.Directory]::Delete($Path) } else { [IO.File]::Delete($Path) }
    return
  }
  if (-not ($attributes -band [IO.FileAttributes]::Directory)) {
    if ($attributes -band [IO.FileAttributes]::ReadOnly) {
      [IO.File]::SetAttributes($Path, [IO.FileAttributes]([int]$attributes -band (-bnot [int][IO.FileAttributes]::ReadOnly)))
    }
    [IO.File]::Delete($Path)
    return
  }
  foreach ($child in [IO.Directory]::GetFileSystemEntries($Path)) { Remove-Tree $child }
  [IO.Directory]::Delete($Path)
}

function Remove-Folder([string]$Path) {
  try { Remove-Tree $Path }
  catch {
    # e.g. paths beyond MAX_PATH under thirdparty\claude-auth\node_modules; rmdir /s never follows junctions either.
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & cmd.exe /d /c rmdir /s /q $Path 2>&1 | Out-Null } finally { $ErrorActionPreference = $saved }
  }
  if ($null -ne (Get-LinkAttributes $Path)) { throw "could not remove $Path (a file in it is in use?)" }
}

# A rename; antivirus scanners briefly hold freshly written files, so it is retried for a few seconds.
function Move-Folder([string]$From, [string]$To) {
  for ($attempt = 1; ; $attempt++) {
    try {
      [IO.Directory]::Move($From, $To)
      return
    }
    catch {
      if ($attempt -ge 10) { throw "could not move $From to $To ($($_.Exception.Message))" }
      Start-Sleep -Milliseconds 500
    }
  }
}

# The payload's app folder into $To: a rename when asked to move and on the same volume, else a copy (the source is
# then removed when asked to move). Returns 'moved' or 'copied'.
function Copy-PayloadTree([string]$From, [string]$To, [bool]$Move) {
  if ($Move -and [IO.Path]::GetPathRoot($From) -eq [IO.Path]::GetPathRoot($To)) {
    try {
      Move-Folder $From $To
      return 'moved'
    }
    catch { Write-Warn "$($_.Exception.Message); copying instead" }
  }
  Copy-Item -LiteralPath $From -Destination $To -Recurse -Force
  if ($Move) {
    try { Remove-Folder $From } catch { Write-Warn "the payload was copied, but $From could not be removed ($($_.Exception.Message))" }
  }
  return 'copied'
}

# ---- the version pointer app\current.json (and the app\current junction of launcher 0.3.0, read as a link only)

# Why the last pointer read found nothing usable (status and the not-installed message show it).
$script:PointerProblem = $null

function Test-VersionName([string]$Name) {
  return $Name -and $Name -match $script:VersionNamePattern -and $Name -ne 'current' -and -not $Name.EndsWith('.json')
}

# {Version, Dir, Source='pointer', Previous} from app\current.json, or $null (missing, unreadable, or naming a folder
# without manifest.json). Dir is app\<version> next to the pointer file, so a moved OWN_HOME keeps working.
function Read-VersionPointer($Paths) {
  if (-not (Test-Path -LiteralPath $Paths.Pointer -PathType Leaf)) { return $null }
  try { $data = [IO.File]::ReadAllText($Paths.Pointer) | ConvertFrom-Json }
  catch { $script:PointerProblem = "$($Paths.Pointer) is not readable JSON"; return $null }
  $version = [string](Get-Prop $data 'version')
  if (-not (Test-VersionName $version)) { $script:PointerProblem = "$($Paths.Pointer) names no valid version ('$version')"; return $null }
  $dir = Join-Path $Paths.App $version
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'manifest.json') -PathType Leaf)) {
    $script:PointerProblem = "$($Paths.Pointer) names $version, but $dir has no manifest.json"
    return $null
  }
  $previous = [string](Get-Prop $data 'previous')
  return [pscustomobject]@{ Version = $version; Dir = $dir; Source = 'pointer'; Previous = $(if ($previous) { $previous } else { $null }) }
}

# Where a junction or symbolic link points, read from the link itself (never followed); $null when unreadable.
function Get-LinkTarget([string]$Path) {
  try { $target = @((Get-Item -LiteralPath $Path -Force -ErrorAction Stop).Target) | Select-Object -First 1 } catch { return $null }
  if (-not $target) { return $null }
  $target = ([string]$target) -replace '^(\\\\\?\\|\\\?\?\\)', ''
  if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $Path) $target }
  try { return [IO.Path]::GetFullPath($target).TrimEnd('\') } catch { return $null }
}

# An install of launcher 0.3.0 or earlier: the folder the app\current junction names (used directly, the junction is
# not traversed: under %LOCALAPPDATA% opening files through it can fail while attribute queries succeed), or a plain
# app\current folder. $null when there is none or it names no folder with manifest.json.
function Get-LegacyApp($Paths) {
  $attributes = Get-LinkAttributes $Paths.Current
  if ($null -eq $attributes) { return $null }
  if (Test-ReparsePoint $attributes) {
    $target = Get-LinkTarget $Paths.Current
    if (-not $target -or -not (Test-Path -LiteralPath (Join-Path $target 'manifest.json') -PathType Leaf)) { return $null }
    return [pscustomobject]@{ Version = Get-TargetVersion $target; Dir = $target; Source = 'junction'; Previous = $null }
  }
  if (-not ($attributes -band [IO.FileAttributes]::Directory)) { return $null }
  if (-not (Test-Path -LiteralPath (Join-Path $Paths.Current 'manifest.json') -PathType Leaf)) { return $null }
  return [pscustomobject]@{ Version = Get-TargetVersion $Paths.Current; Dir = $Paths.Current; Source = 'folder'; Previous = $null }
}

# The installed version: the pointer, else a legacy app\current; $null when nothing is installed.
function Get-ActiveApp($Paths) {
  $script:PointerProblem = $null
  $pointer = Read-VersionPointer $Paths
  if ($null -ne $pointer) { return $pointer }
  return Get-LegacyApp $Paths
}

# A version folder whose plugins read the pointer (built from 2.0.18-own.3 on): manifest.json install_layout "pointer",
# or, for manifests without it, an own-accounts bundle that knows app\current.json. Versions before it look up
# app\current\{own-vault.exe, templates, plugins, remote, web} from their plugins.
function Test-PointerAware([string]$Dir) {
  if ((Get-Prop (Read-JsonFile (Join-Path $Dir 'manifest.json')) 'install_layout') -eq 'pointer') { return $true }
  $bundle = Join-Path $Dir 'plugins\own-accounts\index.js'
  if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) { return $true }
  try { return ([IO.File]::ReadAllText($bundle)).IndexOf('current.json', [StringComparison]::Ordinal) -ge 0 }
  catch { return $true }
}

# Whether a switch has something to migrate: no valid pointer, or an app\current link that the installed version does
# not need (a version before the pointer gets one on purpose, Sync-CompatJunction).
function Test-LegacyLayout($Paths) {
  $pointer = Read-VersionPointer $Paths
  if ($null -eq $pointer) { return $true }
  if (-not (Test-ReparsePoint (Get-LinkAttributes $Paths.Current))) { return $false }
  return Test-PointerAware $pointer.Dir
}

# app\current as the installed version needs it: none for a version that reads the pointer (a leftover link is
# removed, never followed); for a version before the pointer (own rollback to 2.0.18-own.2), a junction to it, since
# its plugins find their own files only through app\current. A plain folder there stays.
function Sync-CompatJunction($Paths) {
  $active = $Paths.Active
  $needs = $null -ne $active -and $active.Source -eq 'pointer' -and -not (Test-PointerAware $active.Dir)
  if (-not $needs) {
    $problem = Remove-LegacyCurrent $Paths
    if ($problem) { Write-Warn $problem }
    return
  }
  $attributes = Get-LinkAttributes $Paths.Current
  if (Test-ReparsePoint $attributes) {
    if ([string]::Equals((Get-LinkTarget $Paths.Current), $active.Dir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { return }
    [IO.Directory]::Delete($Paths.Current)
  }
  elseif ($null -ne $attributes) {
    Write-Warn "$($Paths.Current) is a folder; $($active.Version) predates the version pointer and needs app\current as a junction to it"
    return
  }
  New-Item -ItemType Junction -Path $Paths.Current -Target $active.Dir | Out-Null
  Write-Warn "$($active.Version) predates the version pointer (its plugins read app\current): app\current is a junction to it again until the next switch to a newer version"
}

# The pointer file for app\$Version (atomic: temp, flush, rename). $Previous is what 'own rollback' returns to.
function Write-VersionPointer($Paths, [string]$Version, [string]$Previous) {
  $content = [ordered]@{
    schema = 1
    version = $Version
    path = Join-Path $Paths.App $Version
    previous = $(if ($Previous) { $Previous } else { $null })
    updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    launcher = $script:LauncherVersion
  }
  Write-TextFile $Paths.Pointer ((ConvertTo-Json $content) + "`n")
}

# Removes launcher 0.3.0's app\current junction without following it (a broken or untraversable one included); a plain
# folder there is not ours and stays. Returns the problem, or $null.
function Remove-LegacyCurrent($Paths) {
  $attributes = Get-LinkAttributes $Paths.Current
  if ($null -eq $attributes) { return $null }
  if (-not (Test-ReparsePoint $attributes)) { return "$($Paths.Current) is a folder, not the junction of an older launcher; it is left alone" }
  # RemoveDirectory on the link removes the link only (the version folder it names stays).
  [IO.Directory]::Delete($Paths.Current)
  Write-Info "removed the app\current junction of the older launcher (replaced by $($Paths.Pointer))"
  return $null
}

# The switch: the pointer names app\$Version, the paths follow, and an older launcher's junction goes (or, for a
# version before the pointer, points at it: Sync-CompatJunction). The pointer is written first, so a reader always
# finds the version.
function Set-ActiveVersion($Paths, [string]$Version, [string]$Previous) {
  Write-VersionPointer $Paths $Version $Previous
  Update-ActivePaths $Paths
  Sync-CompatJunction $Paths
}

# The version of an installed app folder (its manifest.json; the folder name when that is unreadable).
function Get-TargetVersion([string]$Target) {
  if (-not $Target) { return $null }
  $version = [string](Get-Prop (Read-JsonFile (Join-Path $Target 'manifest.json')) 'version')
  if ($version) { return $version }
  return Split-Path -Leaf $Target
}

# ---- payload

# A file's SHA-256 as lowercase hex, with .NET: Get-FileHash exists only while 5.1's own Utility module can be
# auto-loaded (PSModulePath, top of this file). The path resolves the way Get-FileHash -LiteralPath resolves it.
function Get-FileHex([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path))
  try { $digest = $sha.ComputeHash($stream) } finally { $stream.Dispose(); $sha.Dispose() }
  return [BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
}

function Get-FileSha256([string]$Path) { return 'sha256:' + (Get-FileHex $Path) }

# Same rule as own\scripts\build-desktop.ps1 Get-TreeHash: sha256 over "<relative path>`n<file sha256>`n" in ordinal
# path order (forward slashes).
function Get-TreeHash([string]$Path) {
  $root = (Resolve-Path -LiteralPath $Path).ProviderPath.TrimEnd('\') + '\'
  $files = New-Object System.Collections.Generic.List[object]
  foreach ($file in Get-ChildItem -LiteralPath $Path -Recurse -File -Force) {
    $files.Add([pscustomobject]@{ Rel = $file.FullName.Substring($root.Length).Replace('\', '/'); Full = $file.FullName })
  }
  $files.Sort([Comparison[object]] { param($a, $b) [string]::CompareOrdinal($a.Rel, $b.Rel) })
  $lines = New-Object System.Text.StringBuilder
  foreach ($file in $files) {
    [void]$lines.Append("$($file.Rel)`n$(Get-FileHex $file.Full)`n")
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($lines.ToString())) } finally { $sha.Dispose() }
  return 'sha256-tree:' + (($digest | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Read-PayloadManifest([string]$AppDir) {
  $file = Join-Path $AppDir 'manifest.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Stop-Own "no manifest.json in $AppDir" }
  try { $manifest = (Get-Content -LiteralPath $file -Raw -Encoding UTF8) | ConvertFrom-Json }
  catch { Stop-Own "$file is not readable JSON" }
  $version = [string](Get-Prop $manifest 'version')
  if ($version -notmatch $script:VersionPattern) { Stop-Own "$file names version '$version', not an own release (<upstream>-own.<k>)" }
  if ((Get-Prop $manifest 'channel') -ne $script:Channel) { Stop-Own "$file is not an own-channel build (channel '$(Get-Prop $manifest 'channel')')" }
  return $manifest
}

# The files manifest.json lists, present and with the listed hashes; opencode.exe must be there. Returns problems.
function Test-PayloadFiles([string]$AppDir, $Manifest) {
  $problems = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'opencode.exe') -PathType Leaf)) { $problems.Add('opencode.exe is missing') }
  $artifacts = Get-Prop $Manifest 'artifacts'
  if ($null -eq $artifacts) { $problems.Add('manifest.json lists no artifacts') }
  else {
    foreach ($artifact in $artifacts.PSObject.Properties) {
      $rel = $artifact.Name
      $expected = [string]$artifact.Value
      $full = Join-Path $AppDir ($rel.TrimEnd('/') -replace '/', '\')
      if ($rel.EndsWith('/')) {
        if (-not (Test-Path -LiteralPath $full -PathType Container)) { $problems.Add("$rel is missing"); continue }
        if ($expected -and (Get-TreeHash $full) -ne $expected) { $problems.Add("$rel does not match manifest.json") }
        continue
      }
      if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { $problems.Add("$rel is missing"); continue }
      if ($expected -and (Get-FileSha256 $full) -ne $expected) { $problems.Add("$rel does not match manifest.json") }
    }
  }
  return @($problems)
}

# app\<ver> already holds exactly this build (same build id and artifact list, files intact).
function Test-InstalledPayload([string]$Target, $Manifest) {
  if (-not (Test-Path -LiteralPath (Join-Path $Target 'manifest.json'))) { return $false }
  $installed = Read-JsonFile (Join-Path $Target 'manifest.json')
  if ($null -eq $installed) { return $false }
  if ((Get-Prop $installed 'build_id') -ne (Get-Prop $Manifest 'build_id')) { return $false }
  $mine = (Get-Prop $installed 'artifacts') | ConvertTo-Json -Compress -Depth 3
  $theirs = (Get-Prop $Manifest 'artifacts') | ConvertTo-Json -Compress -Depth 3
  if ($mine -ne $theirs) { return $false }
  return @(Test-PayloadFiles $Target $Manifest).Count -eq 0
}

# --from, or the folder above this script when it is a payload's bin\ (own\.out\build\<ver>\bin\own.cmd install).
function Resolve-PayloadRoot($Paths, [string]$From, [string]$Command) {
  if (-not $From) {
    $candidate = Split-Path -Parent $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $candidate 'app\manifest.json')) { $From = $candidate }
    else {
      Stop-Own ("own $Command needs --from <folder with app\ and bin\>: the build output own\.out\build\<version>. " +
        "The desktop installer (own-desktop-<version>-win-x64.exe) carries it and does this in one step.") $script:ExitUsage
    }
  }
  try { $root = (Resolve-Path -LiteralPath $From -ErrorAction Stop).ProviderPath.TrimEnd('\') }
  catch { Stop-Own "--from: $From does not exist" $script:ExitUsage }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'app\manifest.json'))) {
    Stop-Own "--from: $root has no app\manifest.json (expected the build output own\.out\build\<version>)" $script:ExitUsage
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'bin\own.ps1'))) { Stop-Own "--from: $root has no bin\own.ps1" $script:ExitUsage }
  $appRoot = [IO.Path]::GetFullPath($Paths.App).TrimEnd('\') + '\'
  if (($root + '\').StartsWith($appRoot, [StringComparison]::OrdinalIgnoreCase)) { Stop-Own "--from must not be inside $($Paths.App)" $script:ExitUsage }
  return $root
}

# The payload's launcher knows its payload: when it differs from this script, it does the work (and this exits).
function Invoke-PayloadLauncher([string]$Root, [string]$Command, [string[]]$Arguments) {
  $launcher = Join-Path $Root 'bin\own.ps1'
  if ($env:OWN_LAUNCHER_HANDOVER -eq '1' -or -not $PSCommandPath) { return }
  if ((Get-FileHex $launcher) -eq (Get-FileHex $PSCommandPath)) { return }
  Write-Info "handing over to the payload's launcher $launcher"
  $forward = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $Arguments.Count; $i++) {
    if ($Arguments[$i] -eq '--from') { $i++; continue }
    $forward.Add($Arguments[$i])
  }
  $forward.Add('--from')
  $forward.Add($Root)
  $env:OWN_LAUNCHER_HANDOVER = '1'
  $powershell = (Get-Process -Id $PID).Path
  & $powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $launcher $Command @forward
  exit $LASTEXITCODE
}

# Only files that differ are rewritten. own.cmd should stay byte-identical across releases: cmd.exe reads a running
# batch file by offset, and 'own update' run through bin\own.cmd replaces bin\ while that file runs.
function Install-LauncherFiles([string]$FromBin, [string]$ToBin) {
  New-Item -ItemType Directory -Force -Path $ToBin | Out-Null
  $changed = $false
  foreach ($name in @('own.ps1', 'own.cmd')) {
    $source = Join-Path $FromBin $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { Stop-Own "the payload has no bin\$name" }
    $destination = Join-Path $ToBin $name
    if ((Test-Path -LiteralPath $destination) -and
      (Get-FileHex $destination) -eq (Get-FileHex $source)) { continue }
    $temp = "$destination.tmp-$PID"
    Copy-Item -LiteralPath $source -Destination $temp -Force
    Move-Item -LiteralPath $temp -Destination $destination -Force
    $changed = $true
  }
  return $changed
}

# An existing config that does not load an installed bundle (e.g. own-remote after launcher 0.1.0) is only reported:
# the file is the user's, 'own config init --force' rewrites it with a backup. (Entries it has are kept pointed at the
# installed version by Sync-ConfigPlugins.)
function Test-ConfigPlugins($Paths) {
  if (-not (Test-Path -LiteralPath $Paths.ConfigFile)) { return }
  $text = (Get-Content -LiteralPath $Paths.ConfigFile -Raw -Encoding UTF8).Replace('\\', '/').Replace('\', '/')
  $missing = @(foreach ($name in $script:ManagedPlugins) {
      $dir = Get-PluginDir $Paths $name
      if ($dir -and $text.IndexOf(($dir -replace '\\', '/'), [StringComparison]::OrdinalIgnoreCase) -lt 0) { $name }
    })
  if ($missing.Count -gt 0) {
    Write-Warn "$($Paths.ConfigFile) does not load $($missing -join ', '); run 'own config init --force' to regenerate it (the old file is kept as a backup)"
  }
}

# ---- session database backups

function Backup-Database($Paths, [string]$Version, [string]$Stamp) {
  if (-not (Test-Path -LiteralPath $Paths.Database -PathType Leaf)) { return $null }
  New-Item -ItemType Directory -Force -Path $Paths.Backup | Out-Null
  $label = if ($Version) { $Version } else { 'unknown' }
  $base = Join-Path $Paths.Backup "opencode-own.$label.$Stamp.db"
  foreach ($suffix in @('', '-wal', '-shm')) {
    $file = "$($Paths.Database)$suffix"
    if (Test-Path -LiteralPath $file -PathType Leaf) { Copy-Item -LiteralPath $file -Destination "$base$suffix" -Force }
  }
  Write-Info "backed up the session database to $base"
  return $base
}

function Restore-Database($Paths, [string]$Base) {
  foreach ($suffix in @('', '-wal', '-shm')) {
    $live = "$($Paths.Database)$suffix"
    if (Test-Path -LiteralPath "$Base$suffix" -PathType Leaf) { Copy-Item -LiteralPath "$Base$suffix" -Destination $live -Force }
    elseif (Test-Path -LiteralPath $live -PathType Leaf) { Remove-Item -LiteralPath $live -Force }
  }
  Write-Info "restored the session database from $Base"
}

# The newest $Keep sets (<name>.db with its -wal/-shm) stay; the stamp in the name orders them.
function Limit-Backups($Paths, [int]$Keep = 5) {
  if (-not (Test-Path -LiteralPath $Paths.Backup)) { return }
  $pattern = '^opencode-own\..+\.(\d{8}-\d{6}-\d{3})\.db$'
  $sets = @(Get-ChildItem -LiteralPath $Paths.Backup -File -Force | Where-Object { $_.Name -match $pattern } |
      Sort-Object -Property @{ Expression = { [regex]::Match($_.Name, $pattern).Groups[1].Value } } -Descending)
  foreach ($set in @($sets | Select-Object -Skip $Keep)) {
    foreach ($suffix in @('', '-wal', '-shm')) {
      $file = "$($set.FullName)$suffix"
      if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    }
    Write-Info "removed the old database backup $($set.Name)"
  }
}

# ---- install.json

function Write-InstallState($Paths, [string]$Current, [string]$Previous, $Entry) {
  $history = @(Get-Prop (Read-JsonFile $Paths.InstallState) 'history' | Where-Object { $null -ne $_ })
  if ($null -ne $Entry) { $history += [pscustomobject]$Entry }
  if ($history.Count -gt 20) { $history = @($history | Select-Object -Last 20) }
  $content = [ordered]@{
    version = 1
    current = $Current
    previous = $(if ($Previous) { $Previous } else { $null })
    launcher = $script:LauncherVersion
    updated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    history = $history
  }
  Write-TextFile $Paths.InstallState ((ConvertTo-Json $content -Depth 5) + "`n")
}

function Restore-InstallState($Paths, $Text) {
  if ($null -ne $Text) { Write-TextFile $Paths.InstallState $Text }
  elseif (Test-Path -LiteralPath $Paths.InstallState) { Remove-Item -LiteralPath $Paths.InstallState -Force }
}

# Version folders other than the current and the previous one, and leftovers of interrupted runs. Folders that do
# not look like ours stay.
function Remove-OldVersions($Paths, [string[]]$Keep) {
  if (-not (Test-Path -LiteralPath $Paths.App)) { return }
  $current = if ($null -ne $Paths.Active) { $Paths.Active.Dir } else { $null }
  # Temp files of pointer writes an interrupted run left behind.
  foreach ($file in @(Get-ChildItem -LiteralPath $Paths.App -File -Force | Where-Object { $_.Name -match '^current\.json\.tmp-\d+$' })) {
    Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
  }
  foreach ($dir in @(Get-ChildItem -LiteralPath $Paths.App -Directory -Force)) {
    $name = $dir.Name
    $isVersion = $name -match $script:VersionPattern
    if ($name -eq 'current' -or -not ($isVersion -or $name -match '^(\.staging-|\.replaced-|current\.new-)')) { continue }
    if ($isVersion -and $Keep -contains $name) { continue }
    if ($current -and $dir.FullName -eq $current) { continue }
    try {
      Remove-Folder $dir.FullName
      Write-Info "removed $($dir.FullName)"
    }
    catch { Write-Warn "could not remove $($dir.FullName) ($($_.Exception.Message)); delete it by hand" }
  }
}

# ---- service around a switch

# Stops the running service for a version switch; returns its trust mode so the same mode starts again. Asks (or
# refuses with exit 4) unless the caller already had the stop agreed to.
function Stop-ServiceForSwitch($Paths, $Service, [string[]]$Arguments, [string]$Action, [bool]$Agreed) {
  if (-not $Agreed) { [void](Confirm-Stop $Service $Arguments $Action) }
  $mode = Get-ServiceMode $Paths
  $servicePid = Get-Prop $Service.Registration 'pid'
  Set-OwnEnvironment $Paths ($mode -eq 'untrusted') $false
  if (Test-ExePresent $Paths) {
    $result = Invoke-Exe $Paths @('service', 'stop')
    if ($result.Code -ne 0) { Stop-Own "opencode service stop failed (exit $($result.Code))" }
  }
  else {
    # The installed opencode.exe is gone: stop the registered process when it is one of ours.
    $process = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
    $appRoot = [IO.Path]::GetFullPath($Paths.App).TrimEnd('\') + '\'
    if ($null -ne $process -and $process.Path -and $process.Path.StartsWith($appRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Process -Id $servicePid -Force
    }
    else { Stop-Own "cannot stop the service (pid $servicePid): the installed opencode.exe is missing" }
  }
  for ($i = 0; $i -lt 40 -and $null -ne (Get-RunningService $Paths); $i++) { Start-Sleep -Milliseconds 250 }
  if ($null -ne (Get-RunningService $Paths)) { Stop-Own "the service ($($Service.Url)) is still running after service stop" }
  Write-Info "stopped the service ($($Service.Url), pid $servicePid)"
  return $mode
}

function Get-StartArguments([string]$Mode) { return @(if ($Mode -eq 'untrusted') { '--untrusted' }) }

# Puts back what a failed switch changed, in reverse order; each step on its own so one failure does not skip the rest.
function Undo-Switch($Paths, $Tx, [string]$SourceApp) {
  $steps = New-Object System.Collections.Generic.List[object]
  if ($Tx.StartTried) {
    $steps.Add(@('stop the new build', { if ($null -ne (Get-RunningService $Paths)) { [void](Invoke-Exe $Paths @('service', 'stop')) } }))
  }
  if ($Tx.Pointer) {
    # The previous pointer as it was; an install of an older launcher (junction) gets a pointer for its version (and,
    # being a version before the pointer, its app\current junction again: Sync-CompatJunction).
    $steps.Add(@('point app\current.json back', {
          if ($null -ne $Tx.PointerText) { Write-TextFile $Paths.Pointer $Tx.PointerText }
          elseif ($Tx.OldTarget -and (Test-VersionName (Split-Path -Leaf $Tx.OldTarget)) -and
            [string]::Equals((Split-Path -Parent $Tx.OldTarget).TrimEnd('\'), [IO.Path]::GetFullPath($Paths.App).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
            Write-VersionPointer $Paths (Split-Path -Leaf $Tx.OldTarget) $Tx.OldPrevious
          }
          elseif (Test-Path -LiteralPath $Paths.Pointer) { Remove-Item -LiteralPath $Paths.Pointer -Force }
          Update-ActivePaths $Paths
          Sync-CompatJunction $Paths
        }))
  }
  if ($Tx.ConfigChanged) {
    # The file as it was, with its own plugin entries on the version that is active again.
    $steps.Add(@('restore the plugin entries of opencode.jsonc', {
          if ($null -ne $Tx.ConfigBytes) { [IO.File]::WriteAllBytes($Paths.ConfigFile, $Tx.ConfigBytes) }
          [void](Sync-ConfigPlugins $Paths)
        }))
  }
  if ($Tx.DbTouched -and $Tx.Backup) { $steps.Add(@('restore the session database', { Restore-Database $Paths $Tx.Backup })) }
  if ($Tx.Placed) { $steps.Add(@('take the new version folder back', { Move-Folder $Tx.Target $Tx.Staging })) }
  if ($Tx.Replaced) { $steps.Add(@('put the replaced folder back', { Move-Folder $Tx.Replaced $Tx.Target })) }
  if ($Tx.Staging) {
    $steps.Add(@('return the payload', {
          if (Test-Path -LiteralPath $Tx.Staging) {
            if ($Tx.Moved) { Move-Folder $Tx.Staging $SourceApp } else { Remove-Folder $Tx.Staging }
          }
        }))
  }
  if ($Tx.State) { $steps.Add(@('restore install.json', { Restore-InstallState $Paths $Tx.StateText })) }
  if ($Tx.Stopped) {
    $steps.Add(@('start the previous version again', {
          if ($null -eq (Get-RunningService $Paths)) { [void](Start-OwnService $Paths (Get-StartArguments $Tx.Mode)) }
        }))
  }
  foreach ($step in $steps) {
    $undoFailure = Invoke-Trapped $step[1]
    if ($null -ne $undoFailure) { Write-Warn "undo: could not $($step[0]) ($($undoFailure.Message))" }
  }
}

function New-SwitchState($Paths, [string]$Target, $OldActive, $StateText) {
  return [pscustomobject]@{
    Target = $Target; StateText = $StateText
    OldTarget = $(if ($null -ne $OldActive) { $OldActive.Dir } else { $null })
    OldPrevious = $(if ($null -ne $OldActive) { $OldActive.Previous } else { $null })
    PointerText = $(if (Test-Path -LiteralPath $Paths.Pointer -PathType Leaf) { [IO.File]::ReadAllText($Paths.Pointer) } else { $null })
    ConfigBytes = $(if (Test-Path -LiteralPath $Paths.ConfigFile -PathType Leaf) { [IO.File]::ReadAllBytes($Paths.ConfigFile) } else { $null })
    Staging = $null; Moved = $false; Replaced = $null; Placed = $false; Pointer = $false; ConfigChanged = $false; Backup = $null
    DbTouched = $false; Stopped = $false; Mode = 'trusted'; StartTried = $false; Service = $null; State = $false
    PathAdded = $false; LauncherChanged = $false
  }
}

# After the pointer switch: the own plugin entries of an existing config follow it, and bundles new in this version
# are added (both recorded for the undo).
function Update-SwitchConfig($Paths, $Tx) {
  if ($null -eq $Tx.ConfigBytes) { return }
  if (Sync-ConfigPlugins $Paths) { $Tx.ConfigChanged = $true }
  if (Add-NewConfigPlugins $Paths $Tx.OldTarget) { $Tx.ConfigChanged = $true }
}

function Get-ServiceSummary($Paths, $Tx) {
  if ($null -ne $Tx.Service) { return "service running at $($Tx.Service.Url)/" }
  if ($Tx.Stopped) { return "service stopped (--no-start); 'own start' or the desktop app starts it" }
  $running = Get-RunningService $Paths
  if ($null -ne $running) { return "service running at $($running.Url)/ (left as it was: its build did not change)" }
  return "service not running; 'own start' or the desktop app starts it"
}

# ---- commands

# NSIS customInit (before anything is extracted): would installing <v> stop a service that runs sessions?
# Exit 4 (and the count on stdout) when it would; else 0.
function Invoke-InstallPreflight($Paths, [string[]]$Arguments) {
  $version = Get-OptionValue $Arguments '--version'
  if (-not $version) { Stop-Own '--preflight needs --version <version>' $script:ExitUsage }
  # Same version and nothing to migrate: the install will not stop the service.
  if ($null -ne $Paths.Active -and $Paths.Active.Version -eq $version -and -not (Test-LegacyLayout $Paths)) { return }
  $service = Get-RunningService $Paths
  if ($null -eq $service -or (Test-Flag $Arguments '--force')) { return }
  $count = Get-ActiveSessionCount $service
  if ($count -gt 0) {
    [Console]::Out.Write("$count")
    Stop-Own "$count session(s) are running; installing $version stops the service" $script:ExitSessionRunning
  }
}

function Invoke-Install($Paths, [string]$Command, [string[]]$Arguments) {
  $script:NoPrompt = Test-Flag $Arguments '--no-prompt'
  if (Test-Flag $Arguments '--preflight') { Invoke-InstallPreflight $Paths $Arguments; return }
  # Logged from the first step on: the installer shows no console, so even a refused --from must leave a line.
  New-Item -ItemType Directory -Force -Path $Paths.OwnHome | Out-Null
  $script:LogFile = $Paths.InstallLog
  Write-LogLine "==== own $Command $($Arguments -join ' ') (launcher $script:LauncherVersion, $PSCommandPath, pid $PID)"
  $root = Resolve-PayloadRoot $Paths (Get-OptionValue $Arguments '--from') $Command
  Invoke-PayloadLauncher $root $Command $Arguments
  $move = Test-Flag $Arguments '--move'
  $sourceApp = Join-Path $root 'app'
  $manifest = Read-PayloadManifest $sourceApp
  $version = [string]$manifest.version
  New-Item -ItemType Directory -Force -Path $Paths.App | Out-Null
  Write-LogLine "---- own $Command $version from $root (launcher $script:LauncherVersion)"
  $problems = @(Test-PayloadFiles $sourceApp $manifest)
  if ($problems.Count -gt 0) { Stop-Own ("the payload $sourceApp is incomplete or damaged: " + ($problems -join '; ')) }

  $stateText = if (Test-Path -LiteralPath $Paths.InstallState) { [IO.File]::ReadAllText($Paths.InstallState) } else { $null }
  $state = Read-JsonFile $Paths.InstallState
  $oldActive = $Paths.Active
  $oldTarget = if ($null -ne $oldActive) { $oldActive.Dir } else { $null }
  $oldVersion = if ($null -ne $oldActive) { $oldActive.Version } else { $null }
  if ($null -ne $oldActive -and $oldActive.Source -ne 'pointer') { Write-Info "found $oldVersion of an older launcher ($($oldActive.Source) $($Paths.Current)); it gets the version pointer" }
  $target = Join-Path $Paths.App $version
  $reuse = Test-InstalledPayload $target $manifest
  # A layout of launcher 0.3.0 (app\current junction, no pointer) is migrated like a switch, also to the same version.
  $migrate = [bool]$oldVersion -and (Test-LegacyLayout $Paths)
  $switching = ($oldVersion -ne $version) -or -not $reuse -or $migrate
  $action = if (-not $oldVersion) { 'install' } elseif (-not $switching) { 'unchanged' } elseif ($oldVersion -ne $version) { 'update' } elseif ($reuse) { 'migrate' } else { 'reinstall' }
  $previous = [string](Get-Prop $state 'previous')
  if ($switching -and $oldVersion -and $oldVersion -ne $version) { $previous = $oldVersion }
  if ($previous -eq $version) { $previous = '' }

  # Asked (or refused with exit 4) before anything is copied: a refused update changes nothing.
  $agreed = $false
  $running = $null
  if ($switching) {
    $running = Get-RunningService $Paths
    if ($null -ne $running) { $agreed = Confirm-Stop $running $Arguments 'Update' }
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $tx = New-SwitchState $Paths $target $oldActive $stateText
  if (-not $reuse) {
    $tx.Staging = Join-Path $Paths.App ".staging-$version-$stamp"
    Write-Info "$(if ($move) { 'moving' } else { 'copying' }) $version into $($Paths.App)"
    $tx.Moved = (Copy-PayloadTree $sourceApp $tx.Staging $move) -eq 'moved'
    if (-not $tx.Moved) {
      $problems = @(Test-PayloadFiles $tx.Staging $manifest)
      if ($problems.Count -gt 0) {
        Undo-Switch $Paths $tx $sourceApp
        Stop-Own ("the copy in $($tx.Staging) is damaged: " + ($problems -join '; '))
      }
    }
  }

  $failure = Invoke-Trapped {
    if ($switching) {
      # Sessions may have started while the payload was copied: asked again unless the stop was already agreed to.
      $runningNow = Get-RunningService $Paths
      if ($null -ne $runningNow) {
        $tx.Mode = Stop-ServiceForSwitch $Paths $runningNow $Arguments 'Update' $agreed
        $tx.Stopped = $true
      }
      $tx.Backup = Backup-Database $Paths $oldVersion $stamp
      if (-not $reuse) {
        if ($null -ne (Get-LinkAttributes $target)) {
          $tx.Replaced = Join-Path $Paths.App ".replaced-$version-$stamp"
          Move-Folder $target $tx.Replaced
        }
        Move-Folder $tx.Staging $target
        $tx.Placed = $true
      }
      $tx.Pointer = $true
      Set-ActiveVersion $Paths $version $previous
      Write-Info "app\current.json -> $version ($target)"
      Update-SwitchConfig $Paths $tx
    }
    elseif ($null -eq (Get-RunningService $Paths)) {
      # Nothing switches; an entry an older run left on another version is put right while no service would reload.
      Update-SwitchConfig $Paths $tx
    }
    $tx.LauncherChanged = Install-LauncherFiles (Join-Path $root 'bin') $Paths.Bin
    if (-not (Test-Flag $Arguments '--no-path')) {
      try { $tx.PathAdded = Add-UserPathEntry $Paths.Bin }
      catch { Write-Warn "could not add $($Paths.Bin) to the user PATH ($($_.Exception.Message)); add it by hand" }
    }
    [void](Initialize-OwnConfig $Paths $false)
    Test-OwnConfig $Paths
    Test-ConfigPlugins $Paths
    $entry = $null
    if ($action -ne 'unchanged') {
      $entry = [ordered]@{
        at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); action = $action; from = $oldVersion; to = $version
        build_id = Get-Prop $manifest 'build_id'; backup = $tx.Backup; launcher = $script:LauncherVersion
      }
    }
    Write-InstallState $Paths $version $previous $entry
    $tx.State = $true
    if ($tx.Stopped -and -not (Test-Flag $Arguments '--no-start')) {
      $tx.StartTried = $true
      $tx.DbTouched = $true
      $tx.Service = Start-OwnService $Paths (Get-StartArguments $tx.Mode)
    }
  }
  if ($null -ne $failure) {
    Write-Warn "$Command $version failed: $($failure.Message)"
    if ($tx.Pointer -or $tx.Placed -or $tx.Staging -or $tx.Stopped) { Write-Info 'undoing the changes' }
    Undo-Switch $Paths $tx $sourceApp
    $suffix = if ($tx.Pointer) { " (rolled back to $(if ($oldVersion) { $oldVersion } else { 'nothing installed' }))" } else { '' }
    Stop-Own "$Command $version failed: $($failure.Message)$suffix" $failure.Code
  }

  if ($tx.Replaced) {
    try { Remove-Folder $tx.Replaced } catch { Write-Warn "could not remove $($tx.Replaced) ($($_.Exception.Message))" }
  }
  if ($move -and (Test-Path -LiteralPath $sourceApp)) {
    # Already installed: the carried copy is not needed.
    try { Remove-Folder $sourceApp } catch { Write-Warn "could not remove $sourceApp ($($_.Exception.Message))" }
  }
  Remove-OldVersions $Paths @($version, $previous)
  Limit-Backups $Paths
  Remove-LegacyClaudeInstall $Paths

  $summary = [ordered]@{
    action = $action
    version = $version
    previous = $(if ($previous) { $previous } else { $null })
    app = $target
    backup = $tx.Backup
    launcher = $Paths.Bin
    launcher_updated = $tx.LauncherChanged
    path_added = $tx.PathAdded
    service = $(if ($null -ne $tx.Service) { 'restarted' } elseif ($tx.Stopped) { 'stopped' } else { 'untouched' })
    url = $(if ($null -ne $tx.Service) { "$($tx.Service.Url)/" } else { $null })
  }
  Write-LogLine "done: $action $version"
  if (Test-Flag $Arguments '--json') { Write-Output (ConvertTo-Json $summary); return }
  $verb = @{ install = 'installed'; update = 'updated to'; reinstall = 'reinstalled'; migrate = 'moved to the version pointer:'; unchanged = 'already installed:' }[$action]
  Write-Output "$verb $version ($target)"
  if ($previous) { Write-Output "previous version $previous kept for 'own rollback'" }
  if ($tx.Backup) { Write-Output "session database backup: $($tx.Backup)" }
  if ($tx.PathAdded) { Write-Output "$($Paths.Bin) added to the user PATH: 'own' works in new terminals" }
  Write-Output (Get-ServiceSummary $Paths $tx)
}

function Invoke-Rollback($Paths, [string[]]$Arguments) {
  $script:NoPrompt = Test-Flag $Arguments '--no-prompt'
  $oldActive = $Paths.Active
  if ($null -eq $oldActive) { Stop-Own "nothing is installed (no version pointer $($Paths.Pointer))" }
  $current = $oldActive.Version
  $stateText = if (Test-Path -LiteralPath $Paths.InstallState) { [IO.File]::ReadAllText($Paths.InstallState) } else { $null }
  $state = Read-JsonFile $Paths.InstallState
  $to = Get-OptionValue $Arguments '--to'
  if (-not $to) { $to = [string](Get-Prop $state 'previous') }
  if (-not $to) { $to = [string]$oldActive.Previous }
  if (-not $to) { Stop-Own "no previous version is recorded in $($Paths.InstallState); name one with --to <version> (a folder in $($Paths.App))" }
  if ($to -eq $current) { Stop-Own "$to is already the current version" }
  $target = Join-Path $Paths.App $to
  if (-not (Test-Path -LiteralPath $target -PathType Container)) { Stop-Own "$target does not exist (it was removed or never installed)" }
  $manifest = Read-PayloadManifest $target
  if ([string]$manifest.version -ne $to) { Stop-Own "$target\manifest.json is version $($manifest.version), not $to" }
  $problems = @(Test-PayloadFiles $target $manifest)
  if ($problems.Count -gt 0) { Stop-Own ("$target is incomplete or damaged: " + ($problems -join '; ')) }
  $script:LogFile = $Paths.InstallLog
  Write-LogLine "---- own rollback $current -> $to (launcher $script:LauncherVersion)"

  # --restore-db: the backup taken when $to was replaced by $current (sessions since then are lost).
  $restoreFrom = $null
  if (Test-Flag $Arguments '--restore-db') {
    $entries = @(@(Get-Prop $state 'history') | Where-Object {
        $null -ne $_ -and (Get-Prop $_ 'from') -eq $to -and (Get-Prop $_ 'to') -eq $current -and (Get-Prop $_ 'backup')
      })
    if ($entries.Count -eq 0) { Stop-Own "install.json has no database backup from the switch $to -> $current" }
    $restoreFrom = [string](Get-Prop $entries[-1] 'backup')
    if (-not (Test-Path -LiteralPath $restoreFrom)) { Stop-Own "the database backup $restoreFrom is gone" }
  }

  $agreed = $false
  $running = Get-RunningService $Paths
  if ($null -ne $running) { $agreed = Confirm-Stop $running $Arguments 'Rollback' }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $tx = New-SwitchState $Paths $target $oldActive $stateText
  $failure = Invoke-Trapped {
    $runningNow = Get-RunningService $Paths
    if ($null -ne $runningNow) {
      $tx.Mode = Stop-ServiceForSwitch $Paths $runningNow $Arguments 'Rollback' $agreed
      $tx.Stopped = $true
    }
    $tx.Backup = Backup-Database $Paths $current $stamp
    if ($restoreFrom) {
      $tx.DbTouched = $true
      Restore-Database $Paths $restoreFrom
    }
    $tx.Pointer = $true
    Set-ActiveVersion $Paths $to $current
    Write-Info "app\current.json -> $to ($target)"
    Update-SwitchConfig $Paths $tx
    $entry = [ordered]@{
      at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); action = 'rollback'; from = $current; to = $to
      build_id = Get-Prop $manifest 'build_id'; backup = $tx.Backup; restored_db = $restoreFrom; launcher = $script:LauncherVersion
    }
    Write-InstallState $Paths $to $current $entry
    $tx.State = $true
    if ($tx.Stopped -and -not (Test-Flag $Arguments '--no-start')) {
      $tx.StartTried = $true
      $tx.DbTouched = $true
      $tx.Service = Start-OwnService $Paths (Get-StartArguments $tx.Mode)
    }
  }
  if ($null -ne $failure) {
    Write-Warn "rollback to $to failed: $($failure.Message)"
    Undo-Switch $Paths $tx ''
    Stop-Own "rollback to $to failed: $($failure.Message)$(if ($tx.Pointer) { " (back on $current)" })" $failure.Code
  }
  Write-LogLine "done: rollback $current -> $to"
  Write-Output "rolled back to $to ($target); 'own rollback' returns to $current"
  if ($tx.Backup) { Write-Output "session database backup: $($tx.Backup)" }
  if ($restoreFrom) { Write-Output "session database restored from $restoreFrom" }
  elseif ($tx.Backup) {
    Write-Output "the session database was kept; if $to cannot open it: 'own rollback' (back to $current), then 'own rollback --restore-db'"
  }
  Write-Output (Get-ServiceSummary $Paths $tx)
}

function Test-ParentIsCmd {
  try {
    $self = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
    $parent = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($self.ParentProcessId)" -ErrorAction Stop
    return $null -ne $parent -and $parent.Name -eq 'cmd.exe'
  }
  catch { return $false }
}

# A hidden cmd.exe that waits two seconds (the calling batch file has exited by then), deletes $File and removes the
# folders when they are empty.
function Remove-Later([string]$File, [string[]]$Folders) {
  $command = "/d /c ping -n 3 127.0.0.1 >nul & del /f /q `"$File`""
  foreach ($folder in $Folders) { $command += " & rmdir `"$folder`"" }
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList "$command 2>nul" -WindowStyle Hidden
}

# Refuses folders whose removal would take more than own-open-code's own files (a root, the profile, ...).
function Test-RemovableRoot([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full.Length -le 3 -or $full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { return 'it is a drive root' }
  $protected = @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP, $env:SystemRoot, $env:ProgramFiles,
    ${env:ProgramFiles(x86)}, $env:ProgramData, $env:XDG_CONFIG_HOME, $env:XDG_STATE_HOME, $env:XDG_DATA_HOME)
  if ($env:USERPROFILE) { $protected += @((Join-Path $env:USERPROFILE '.config'), (Join-Path $env:USERPROFILE '.local')) }
  foreach ($item in @($protected | Where-Object { $_ })) {
    $other = [IO.Path]::GetFullPath($item).TrimEnd('\')
    if ($full -eq $other -or ($other + '\').StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)) { return "it is or contains $item" }
  }
  return $null
}

function Invoke-Uninstall($Paths, [string[]]$Arguments) {
  $script:NoPrompt = Test-Flag $Arguments '--no-prompt'
  $removeData = Test-Flag $Arguments '--remove-data'
  $service = Get-RunningService $Paths
  if (Test-Flag $Arguments '--check') {
    # NSIS customUnInit: exit 4 (count on stdout) when removing the service would interrupt sessions.
    if ($null -ne $service -and -not (Test-Flag $Arguments '--force')) {
      $count = Get-ActiveSessionCount $service
      if ($count -gt 0) {
        [Console]::Out.Write("$count")
        Stop-Own "$count session(s) are running; uninstalling stops the service" $script:ExitSessionRunning
      }
    }
    return
  }
  if (Test-Path -LiteralPath $Paths.OwnHome) {
    $script:LogFile = $Paths.InstallLog
    Write-LogLine "---- own uninstall$(if ($removeData) { ' --remove-data' }) (launcher $script:LauncherVersion)"
  }
  if ($null -ne $service) { [void](Stop-ServiceForSwitch $Paths $service $Arguments 'Uninstall' $false) }

  $problems = New-Object System.Collections.Generic.List[string]
  try { if (Remove-UserPathEntry $Paths.Bin) { Write-Info "removed $($Paths.Bin) from the user PATH" } }
  catch { $problems.Add("user PATH: $($_.Exception.Message)") }
  # The pointer first (nothing names a version any more), then an older launcher's junction (never followed).
  try { if (Test-Path -LiteralPath $Paths.Pointer) { Remove-Item -LiteralPath $Paths.Pointer -Force } }
  catch { $problems.Add("$($Paths.Pointer): $($_.Exception.Message)") }
  try {
    $legacy = Remove-LegacyCurrent $Paths
    if ($legacy) { $problems.Add($legacy) }
  }
  catch { $problems.Add("$($Paths.Current): $($_.Exception.Message)") }
  if (Test-Path -LiteralPath $Paths.App) {
    foreach ($file in @(Get-ChildItem -LiteralPath $Paths.App -File -Force | Where-Object { $_.Name -match '^current\.json\.tmp-\d+$' })) {
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    }
    foreach ($dir in @(Get-ChildItem -LiteralPath $Paths.App -Directory -Force)) {
      if (-not ($dir.Name -match $script:VersionPattern -or $dir.Name -match '^(\.staging-|\.replaced-|current\.new-)')) { continue }
      try {
        Remove-Folder $dir.FullName
        Write-Info "removed $($dir.FullName)"
      }
      catch { $problems.Add("$($dir.FullName): $($_.Exception.Message)") }
    }
    if (@(Get-ChildItem -LiteralPath $Paths.App -Force).Count -eq 0) { [IO.Directory]::Delete($Paths.App) }
  }
  # Removing the running own.ps1 is fine (PowerShell has read it). own.cmd is different: cmd.exe reads the batch file
  # again after the launcher returns, so when a cmd.exe started this uninstall, a detached cmd.exe removes it a moment
  # later (else: "The batch file cannot be found").
  $cmdFile = Join-Path $Paths.Bin 'own.cmd'
  $deferCmd = (Test-Path -LiteralPath $cmdFile) -and (Test-ParentIsCmd)
  foreach ($file in @((Join-Path $Paths.Bin 'own.ps1'), $cmdFile)) {
    if (-not (Test-Path -LiteralPath $file) -or ($deferCmd -and $file -eq $cmdFile)) { continue }
    try { Remove-Item -LiteralPath $file -Force } catch { $problems.Add("${file}: $($_.Exception.Message)") }
  }
  if ((Test-Path -LiteralPath $Paths.Bin) -and @(Get-ChildItem -LiteralPath $Paths.Bin -Force).Count -eq 0) { [IO.Directory]::Delete($Paths.Bin) }
  $deferredFolders = @($Paths.Bin)
  if (Test-Path -LiteralPath $Paths.InstallState) { Remove-Item -LiteralPath $Paths.InstallState -Force }
  Write-Info 'removed the app versions and the launcher'

  if ($removeData) {
    $script:LogFile = $null
    foreach ($folder in @($Paths.OwnHome, $Paths.ConfigDir)) {
      if (-not (Test-Path -LiteralPath $folder)) { continue }
      $refusal = Test-RemovableRoot $folder
      if ($refusal) { $problems.Add("$folder was not removed: $refusal"); continue }
      try {
        if ($deferCmd -and $folder -eq $Paths.OwnHome) {
          # Everything but bin\own.cmd now; the detached cmd.exe removes the rest.
          foreach ($child in @(Get-ChildItem -LiteralPath $folder -Force)) { if ($child.FullName -ne $Paths.Bin) { Remove-Folder $child.FullName } }
          $deferredFolders += $folder
        }
        else { Remove-Folder $folder }
        Write-Info "removed $folder"
      }
      catch { $problems.Add("${folder}: $($_.Exception.Message)") }
    }
    # Only own's files: the opencode folders around them belong to upstream installs as well.
    foreach ($file in @($Paths.Bridge, $Paths.Registration, $Paths.Database, "$($Paths.Database)-wal", "$($Paths.Database)-shm")) {
      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
      try {
        Remove-Item -LiteralPath $file -Force
        Write-Info "removed $file"
      }
      catch { $problems.Add("${file}: $($_.Exception.Message)") }
    }
  }
  else {
    Write-Info "kept the user data: $($Paths.OwnHome) (accounts, vault, ledger, backups), $($Paths.ConfigDir), $($Paths.Database)"
  }
  if ($deferCmd) { Remove-Later $cmdFile $deferredFolders }
  if ($problems.Count -gt 0) { Stop-Own ("uninstall left something behind: " + ($problems -join '; ')) }
  Write-LogLine 'done: uninstall'
  Write-Output "uninstalled own-open-code$(if ($removeData) { ' and removed its data' } else { ' (user data kept)' })"
}

function Show-Help {
  Write-Output @"
own $script:LauncherVersion - own-open-code launcher (channel own)

  own open [--browser] [--untrusted] [--no-browser] [--force]
                                                    start the service, pair a browser, open the app window
                                                    (--browser: in the browser, which 'open' always does for now)
  own start [--untrusted] [--force]                 start (or reuse) the service; prints the web URL
  own stop [--force]                                stop the service (asks when sessions are running)
  own restart [--untrusted] [--force] [--claude-config-dir <dir>|default]
                                                    stop + start; --claude-config-dir sets the Claude account
                                                    source (OWN_HOME\claude-auth.json) before the start
  own status [--json]                               service state, URL, version, paths (exit 3 when not running)
  own url                                           print the web URL of the running service
  own pair                                          print a one-time pairing link (5 minutes)
  own env                                           show the environment the launcher applies
  own config init [--force] | own config print      write / print the generated own global config
  own tui [args] | own run [args]                   run opencode.exe with the own environment
  own version                                       launcher and binary versions

  own install|update [--from <payload>] [--move] [--force] [--no-start] [--no-path] [--no-prompt] [--json]
                                                    install or update from a payload (<payload>\app, <payload>\bin;
                                                    default: the folder above this script). Stops the service when
                                                    it runs another build (asks when sessions run), backs up the
                                                    session database, points app\current.json and the own plugin
                                                    entries of opencode.jsonc at the new version (an older
                                                    launcher's app\current junction is replaced), keeps the previous
                                                    version, puts OWN_HOME\bin on the user PATH, restarts the
                                                    service when it was running. The desktop installer runs this.
                                                    Refused (exit 5) from inside a packaged app whose writes to
                                                    %LOCALAPPDATA% are virtualized (e.g. the Claude desktop app);
                                                    --allow-virtualized overrides
  own rollback [--to <version>] [--restore-db] [--force] [--no-start]
                                                    point app\current.json back at the previous version
                                                    (install.json); --restore-db also restores the database backup
                                                    of that switch
  own uninstall [--remove-data] [--force]           remove the app versions, the launcher and the PATH entry; user
                                                    data (accounts, vault, ledger, config, sessions) stays unless
                                                    --remove-data

  Not yet available: own logon (Task Scheduler start).
  --untrusted starts the whole service with OPENCODE_CONFIG_PROJECT_DISABLE=1 (no project config/plugins, 01 sec. 13.2).
  Exit codes: 1 failure, 2 not implemented, 3 not running, 4 sessions running without --force (no console),
  5 install refused inside a virtualizing packaged app, 64 usage.
"@
}

# ---------------------------------------------------------------- main

$paths = Get-OwnPaths
$command = if ($args.Count -gt 0) { [string]$args[0] } else { 'open' }
$rest = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] | ForEach-Object { [string]$_ } })
$script:AllowVirtualized = (Test-Flag $rest '--allow-virtualized') -or $env:OWN_ALLOW_VIRTUALIZED -eq '1'
# A run of the desktop shell (packages/own-desktop launcher.ts sets it). Not handed on to the service: its shell tool
# would pass it to an `own start` typed there.
$script:DesktopClient = $env:OWN_LAUNCHER_CLIENT -eq 'desktop'
Remove-Item Env:OWN_LAUNCHER_CLIENT -ErrorAction SilentlyContinue
# Before anything is touched (for install: before extraction in the installer's preflight, and before install.log,
# which would land in the packaged app's copy too). open and start check in Start-OwnService, once they know whether
# a healthy service can be reused.
if ($command -in @('install', 'update', 'rollback', 'uninstall', 'restart', 'tui', 'run')) {
  Assert-NotVirtualized $paths $command
}

switch ($command) {
  'open' { Invoke-Open $paths $rest }
  'start' { $service = Start-OwnService $paths $rest; Write-Output "$($service.Url)/" }
  'stop' { Invoke-Stop $paths $rest }
  'restart' {
    # Checked before anything stops; written only once the stop went through (a refused restart changes nothing).
    $claudeDir = Get-OptionValue $rest '--claude-config-dir'
    if ($null -ne $claudeDir -and $claudeDir -ne 'default') {
      $problem = Test-ClaudeConfigDir $claudeDir $paths
      if ($problem) { Stop-Own "--claude-config-dir: $problem ($claudeDir)" $script:ExitUsage }
    }
    Invoke-Stop $paths $rest 'Restart'
    if ($null -ne $claudeDir) { Set-ClaudeConfigDir $paths $claudeDir }
    $service = Start-OwnService $paths $rest
    Write-Output "$($service.Url)/"
  }
  'status' { Invoke-Status $paths $rest }
  'url' {
    $service = Get-RunningService $paths
    if ($null -eq $service) { Stop-Own 'own service is not running (own start)' 3 }
    Write-Output "$($service.Url)/"
  }
  'pair' {
    $service = Get-RunningService $paths
    if ($null -eq $service) { Stop-Own 'own service is not running (own start)' 3 }
    Write-Output (New-PairingLink $service)
  }
  'env' { Show-Env $paths }
  'config' {
    $sub = if ($rest.Count -gt 0) { $rest[0] } else { 'print' }
    if ($sub -eq 'init') {
      if (-not (Initialize-OwnConfig $paths (Test-Flag $rest '--force'))) { Write-Info "$($paths.ConfigFile) exists; use --force to regenerate (a backup is kept)" }
    }
    elseif ($sub -eq 'print') { Write-Output ((ConvertTo-Json (Get-OwnConfigObject $paths) -Depth 5)) }
    else { Stop-Own "unknown config command '$sub' (init | print)" 64 }
  }
  'tui' { Invoke-Passthrough $paths (@('tui') + $rest) }
  'run' { Invoke-Passthrough $paths (@('run') + $rest) }
  'version' {
    Write-Output "own launcher $script:LauncherVersion"
    if (Test-ExePresent $paths) { Write-Output "opencode $(Get-ExeVersion $paths) ($($paths.Exe))" }
    elseif ($paths.Exe) { Write-Output "opencode (not installed: $($paths.Exe))" }
    else { Write-Output "opencode (not installed: no $($paths.Pointer))" }
  }
  { $_ -in @('install', 'update') } { Invoke-Install $paths $command $rest }
  'rollback' { Invoke-Rollback $paths $rest }
  'uninstall' { Invoke-Uninstall $paths $rest }
  'logon' { Stop-Own "'own logon' (Task Scheduler start at logon, optional per 01 sec. 5.3) is not implemented yet." 2 }
  { $_ -in @('help', '-h', '--help', '/?') } { Show-Help }
  default { Show-Help; Stop-Own "unknown command '$command'" 64 }
}
