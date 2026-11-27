# Stores an API key for the live harness test (script/live), typed by the user and never shown, logged or passed on a
# command line. The key is sealed with Windows DPAPI for the current Windows user (only this account on this PC can
# open it) in %LOCALAPPDATA%\own-live-test\<provider>.dpapi, and that file is readable by this user only. The live
# forwarder (credentials.ts) opens it in memory per run; the test server never holds it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File set-key.ps1                    # Anthropic key, then a check
#   powershell -NoProfile -ExecutionPolicy Bypass -File set-key.ps1 -Provider openai   # OpenAI API key (live images)
#   powershell -NoProfile -ExecutionPolicy Bypass -File set-key.ps1 -Check             # check the stored key only
#   powershell -NoProfile -ExecutionPolicy Bypass -File set-key.ps1 -Remove            # delete the stored key
# -Check and -Remove take -Provider too.
param(
  [ValidateSet("anthropic", "openai")]
  [string]$Provider = "anthropic",
  [switch]$Check,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$dir = Join-Path $env:LOCALAPPDATA "own-live-test"
$file = Join-Path $dir "$Provider.dpapi"

function Open-Key {
  $sealed = [IO.File]::ReadAllBytes($file)
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, "CurrentUser")
  return [Text.Encoding]::UTF8.GetString($bytes)
}

$name = if ($Provider -eq "openai") { "OpenAI" } else { "Anthropic" }
$prefix = if ($Provider -eq "openai") { "sk-" } else { "sk-ant-" }

function Test-Key([string]$key) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  try {
    if ($Provider -eq "openai") {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "https://api.openai.com/v1/models" -Headers @{
        "Authorization" = "Bearer $key"
      }
    } else {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "https://api.anthropic.com/v1/models?limit=100" -Headers @{
        "x-api-key"         = $key
        "anthropic-version" = "2023-06-01"
      }
    }
    $models = ($response.Content | ConvertFrom-Json).data | ForEach-Object { $_.id }
    $sample = if ($Provider -eq "openai") { $models | Where-Object { $_ -like "gpt-image-*" } | Select-Object -First 3 } else { $models | Select-Object -First 3 }
    Write-Host "확인: 키가 동작해요. 쓸 수 있는 모델 $($models.Count)개 (예: $($sample -join ', '))"
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 401) { Write-Host "확인 실패: 키가 거절됐어요(401). 키를 다시 확인해 주세요." }
    elseif ($status) { Write-Host "확인 실패: $name 서버가 HTTP $status 로 답했어요." }
    else { Write-Host "확인 실패: $name 서버에 연결하지 못했어요. 네트워크를 확인해 주세요." }
  }
}

if ($Remove) {
  if (Test-Path $file) { Remove-Item -LiteralPath $file -Force -Confirm:$false; Write-Host "지웠어요: $file" }
  else { Write-Host "저장된 키가 없어요." }
  return
}

if ($Check) {
  if (-not (Test-Path $file)) { Write-Host "저장된 키가 없어요."; return }
  Test-Key (Open-Key)
  return
}

$secure = Read-Host -AsSecureString "$name API 키를 붙여 넣고 Enter를 누르세요 (화면에는 보이지 않아요)"
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim()
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
if (-not $key.StartsWith($prefix) -or ($Provider -eq "openai" -and $key.StartsWith("sk-ant-"))) {
  Write-Host "저장하지 않았어요: $name API 키는 $prefix 로 시작해요."
  return
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
$sealed = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($key), $null, "CurrentUser")
[IO.File]::WriteAllBytes($file, $sealed)
# Only this Windows user may read or change the file (inherited access removed).
icacls $file /inheritance:r /grant:r "$($env:USERNAME):(R,W,D)" | Out-Null
Write-Host "저장했어요: $file (DPAPI로 암호화, 이 Windows 사용자만 열 수 있어요)"
Test-Key $key
$key = $null
