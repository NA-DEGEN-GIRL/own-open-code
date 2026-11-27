<#
.SYNOPSIS
  Builds own-cu-helper.exe with the C# compiler that ships with Windows (.NET Framework 4.x csc.exe): no SDK and no
  install. Output: <OutDir>\own-cu-helper.exe (default own\native\own-cu-helper\target, which git ignores).
  Used by own\scripts\build-desktop.ps1 step 3c and by the real-desktop suite (packages/own-computer-use/test/real).
#>
[CmdletBinding()]
param(
  # Default: <script dir>\target. Set in the body: Windows PowerShell 5.1 leaves $PSScriptRoot empty in parameter
  # defaults when the script runs through `powershell.exe -File`.
  [string]$OutDir
)
$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'target' }

$framework = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw "csc.exe not found at $csc (the in-box .NET Framework 4.x is required)" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$out = Join-Path (Resolve-Path -LiteralPath $OutDir) 'own-cu-helper.exe'
$sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.cs' | Sort-Object Name | ForEach-Object { $_.FullName })
$references = @(
  'System.dll',
  'System.Core.dll',
  'System.Drawing.dll',
  'System.Windows.Forms.dll',
  'System.Web.Extensions.dll',
  (Join-Path $framework 'WPF\WindowsBase.dll'),
  (Join-Path $framework 'WPF\UIAutomationTypes.dll'),
  (Join-Path $framework 'WPF\UIAutomationClient.dll')
)

# /codepage:65001: the sources are UTF-8 without BOM (the indicator text is Korean); /noconfig: only these references.
$arguments = @(
  '/nologo', '/noconfig', '/codepage:65001', '/target:winexe', '/platform:x64', '/optimize+', '/warn:4', '/warnaserror+',
  "/win32manifest:$(Join-Path $PSScriptRoot 'app.manifest')",
  "/out:$out"
) + ($references | ForEach-Object { "/reference:$_" }) + $sources

& $csc @arguments
if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE" }
Write-Output $out
