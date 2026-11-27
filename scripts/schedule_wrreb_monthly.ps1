# schedule_wrreb_monthly.ps1 - register the "housing-economic-wrreb-monthly" Windows scheduled task.
#
# 12th of each month 10:15 (WRREB posts the previous month's release in the first week or so),
# powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\wrreb_monthly.ps1, working
# directory the repo, StartWhenAvailable (a missed run starts at next logon/startup), 1 h limit,
# IgnoreNew, allowed on battery, no wake. Safe to re-run: unregisters and re-registers.
#
# Run it ELEVATED to get LogonType S4U ("run whether user is logged on or not"). An unelevated
# run still registers a working task, but as Interactive (only runs while you are logged on).
# After registering: run _scheduled-tasks\export-all.ps1 to refresh the backup.

$ErrorActionPreference = 'Stop'
$name   = 'housing-economic-wrreb-monthly'
$repo   = Split-Path $PSScriptRoot -Parent
$script = Join-Path $PSScriptRoot 'wrreb_monthly.ps1'

$action   = New-ScheduledTaskAction -Execute 'powershell.exe' `
              -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $repo
$trigger  = New-ScheduledTaskTrigger -Once -At '10:15'   # replaced by the monthly trigger below
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description 'WRREB market-release figures -> AppMarketData-Internal\WRREBMarket (internal only, never published). See housing-economic-data\README.md' | Out-Null

# New-ScheduledTaskTrigger has no monthly option: set a MonthlyTrigger (day 12) through the COM API
$svc = New-Object -ComObject Schedule.Service; $svc.Connect()
$def = $svc.GetFolder('\').GetTask($name).Definition
$def.Triggers.Clear()
$t = $def.Triggers.Create(4)              # TASK_TRIGGER_MONTHLY
$t.DaysOfMonth = 1 -shl 11                 # bit 11 = day 12
$t.MonthsOfYear = 0xFFF                    # every month
$next = Get-Date -Day 12 -Hour 10 -Minute 15 -Second 0
if ($next -le (Get-Date)) { $next = $next.AddMonths(1) }
$t.StartBoundary = $next.ToString('yyyy-MM-ddTHH:mm:ss')
$svc.GetFolder('\').RegisterTaskDefinition($name, $def, 4, $null, $null, 3) | Out-Null   # update, interactive token

$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
              [Security.Principal.WindowsBuiltInRole]::Administrator)
if ($elevated) {
  $p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
  Set-ScheduledTask -TaskName $name -Principal $p | Out-Null
}
$task  = Get-ScheduledTask -TaskName $name
$logon = $task.Principal.LogonType
Write-Host "$name registered: day 12 of each month 10:15, next run $((Get-ScheduledTaskInfo -TaskName $name).NextRunTime), LogonType $logon"
if ($logon -ne 'S4U') {
  Write-Host "  $name is $logon - it only runs while you are logged on (StartWhenAvailable catches a missed day)." -ForegroundColor Yellow
}
