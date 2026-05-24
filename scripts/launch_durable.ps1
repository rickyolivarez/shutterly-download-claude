# launch_durable.ps1 - launch upgrade.js or downloader.js so it survives session events
#
# Why this exists: on Windows, processes launched from an interactive shell or
# RDP/DCV session can be killed when the session ends (logout, disconnect,
# Windows Update auto-restart, etc.). This launcher registers the script as a
# Task Scheduler task running under the SYSTEM-equivalent context, so the
# upgrade survives those events.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launch_durable.ps1 -Script upgrade.js -ScriptArgs "--limit 5000 --commit --watch --skip-status-check"
#
# To stop:
#   schtasks /Delete /TN "ShutterflyUpgrade" /F
#
# To check status:
#   schtasks /Query /TN "ShutterflyUpgrade" /V /FO LIST
#
# Prerequisites:
#   - You must have Administrator rights to register a scheduled task
#   - Run this script from an elevated PowerShell prompt

param(
  [Parameter(Mandatory=$true)]
  [string]$Script,          # e.g. 'upgrade.js' or 'downloader.js'

  [string]$ScriptArgs = '',        # CLI args to pass through

  [string]$TaskName = 'ShutterflyUpgrade'
)

# Resolve paths
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$scriptPath = Join-Path $repoRoot $Script
if (-not (Test-Path $scriptPath)) {
  Write-Error "Script not found: $scriptPath"
  exit 1
}

# Find node.exe
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodeExe = $nodeCmd.Source
} else {
  $candidates = @(
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )
  $nodeExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $nodeExe) {
    Write-Error "node.exe not found in PATH or common locations. Install Node 18+ and retry."
    exit 1
  }
}

Write-Host "Repo root:  $repoRoot"
Write-Host "Script:     $scriptPath"
Write-Host "Node:       $nodeExe"
Write-Host "Args:       $ScriptArgs"
Write-Host "Task name:  $TaskName"
Write-Host ""

# Build the full command line that the task will execute.
# Note: we redirect output to the downloads/ folder so the existing dashboard works.
$logFile = Join-Path $repoRoot 'downloads\upgrade.log'
$errFile = Join-Path $repoRoot 'downloads\upgrade.err'
$argList = "$Script $ScriptArgs"

# Use cmd.exe as the action so we can do output redirection
$cmdAction = "cmd.exe"
$cmdArgs = "/c `"`"$nodeExe`" $argList > `"$logFile`" 2> `"$errFile`"`""

# Register the task: run immediately, then auto-delete after completion
Write-Host "Registering scheduled task..."
$action = New-ScheduledTaskAction -Execute $cmdAction -Argument $cmdArgs -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -At (Get-Date).AddSeconds(5) -Once
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 24)

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Shutterfly bulk upgrade - launched by launch_durable.ps1" `
    -Force | Out-Null
  Write-Host "Task registered. It will start in 5 seconds." -ForegroundColor Green
  Write-Host ""
  Write-Host "Monitor with:"
  Write-Host "  scripts\upgrade_status.cmd"
  Write-Host ""
  Write-Host "Stop with:"
  Write-Host "  schtasks /End /TN $TaskName"
  Write-Host "  schtasks /Delete /TN $TaskName /F"
} catch {
  Write-Error "Failed to register task: $_"
  Write-Host ""
  Write-Host "Are you running as Administrator? Right-click PowerShell -> Run as Administrator." -ForegroundColor Yellow
  exit 1
}
