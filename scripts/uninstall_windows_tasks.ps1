param(
  [string]$TaskPrefix = "RGCA-L"
)

$ErrorActionPreference = "Stop"

foreach ($Name in @("$TaskPrefix Dashboard", "$TaskPrefix Automation Loop")) {
  $Task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($Task) {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    "Removed $Name"
  } else {
    "Not found $Name"
  }
}
