param(
  [int]$Port = 8788
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root "data"
$PidPath = Join-Path $DataDir "paper_app.pid"
$OutLog = Join-Path $DataDir "paper_app.out.log"
$ErrLog = Join-Path $DataDir "paper_app.err.log"

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

if (Test-Path $PidPath) {
  $ExistingPid = Get-Content $PidPath -ErrorAction SilentlyContinue
  if ($ExistingPid) {
    $ExistingProcess = Get-Process -Id ([int]$ExistingPid) -ErrorAction SilentlyContinue
    if ($ExistingProcess) {
      Stop-Process -Id ([int]$ExistingPid) -Force
      Start-Sleep -Milliseconds 500
    }
  }
}

$Python = (Get-Command python -ErrorAction Stop).Source
$Process = Start-Process `
  -FilePath $Python `
  -ArgumentList @("paper_app.py", "--port", "$Port") `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -PassThru

$Process.Id | Set-Content -Path $PidPath
"Dashboard started: http://127.0.0.1:$Port (PID $($Process.Id))"
