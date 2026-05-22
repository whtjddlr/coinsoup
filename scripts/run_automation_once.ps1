param(
  [string]$Tasks = "dashboard,levels,status"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Python = (Get-Command python -ErrorAction Stop).Source

& $Python (Join-Path $Root "automation_runner.py") --tasks $Tasks
