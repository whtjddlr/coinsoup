param(
  [string]$TaskPrefix = "RGCA-L",
  [int]$Port = 8788
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source

$DashboardScript = Join-Path $PSScriptRoot "start_dashboard.ps1"
$AutomationScript = Join-Path $PSScriptRoot "run_automation_loop.ps1"

$DashboardAction = New-ScheduledTaskAction `
  -Execute $PowerShell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$DashboardScript`" -Port $Port" `
  -WorkingDirectory $Root

$AutomationAction = New-ScheduledTaskAction `
  -Execute $PowerShell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$AutomationScript`" -Tasks due" `
  -WorkingDirectory $Root

$AtLogon = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 7)

Register-ScheduledTask `
  -TaskName "$TaskPrefix Dashboard" `
  -Action $DashboardAction `
  -Trigger $AtLogon `
  -Settings $Settings `
  -Description "Start RGCA-L paper dashboard at logon." `
  -Force | Out-Null

Register-ScheduledTask `
  -TaskName "$TaskPrefix Automation Loop" `
  -Action $AutomationAction `
  -Trigger $AtLogon `
  -Settings $Settings `
  -Description "Refresh RGCA-L paper analysis and support/resistance snapshots." `
  -Force | Out-Null

"Installed scheduled tasks:"
"- $TaskPrefix Dashboard"
"- $TaskPrefix Automation Loop"
"Run now:"
"  Start-ScheduledTask -TaskName '$TaskPrefix Dashboard'"
"  Start-ScheduledTask -TaskName '$TaskPrefix Automation Loop'"
