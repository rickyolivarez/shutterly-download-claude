# status.ps1 — live PowerShell dashboard for downloader.js.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/status.ps1
#
# Or wrap in scripts/status.cmd:
#   @powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0status.ps1"
#
# Reads the downloader's manifest.json, PID file, and log files to produce
# a refreshing terminal dashboard showing: process state, RAM, file count,
# total bytes, rolling rate, ETA, and recent errors.
#
# Set BASE below to your repo root before first use.

$BASE = (Get-Item $PSScriptRoot).Parent.FullName    # repo root (one level up from scripts/)
$LOG  = "$BASE\downloader.log"
$ERR  = "$BASE\downloader.err"
$PIDF = "$BASE\downloader.pid"
$OUT  = "$BASE\downloads"
$MANI = "$OUT\manifest.json"
$TOTAL = 50000   # estimated library size; updates ETA — adjust to your case

function Format-TimeSpan([TimeSpan]$ts) {
  if ($ts.TotalDays -ge 1) { '{0}d {1:D2}h {2:D2}m' -f [int]$ts.TotalDays, $ts.Hours, $ts.Minutes }
  else { '{0:D2}h {1:D2}m {2:D2}s' -f $ts.Hours, $ts.Minutes, $ts.Seconds }
}

while ($true) {
  Clear-Host
  Write-Host "=== Shutterfly Downloader Status ===" -ForegroundColor Cyan
  Write-Host ("Updated: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  Write-Host ""

  # Process
  $pidNum = $null
  if (Test-Path $PIDF) { $pidNum = (Get-Content $PIDF).Trim() }
  $proc = $null
  if ($pidNum) { $proc = Get-Process -Id $pidNum -ErrorAction SilentlyContinue }
  if ($proc) {
    $elapsed = (Get-Date) - $proc.StartTime
    Write-Host ("PID {0,-6} alive | elapsed {1} | RAM {2:N1} MB | CPU {3:N1}s" -f $pidNum, (Format-TimeSpan $elapsed), ($proc.WorkingSet64/1MB), $proc.CPU) -ForegroundColor Green
  } else {
    Write-Host ("PID {0} NOT RUNNING" -f $pidNum) -ForegroundColor Red
  }

  # File count
  $files = @(Get-ChildItem $OUT -File -ErrorAction SilentlyContinue)
  $count = ($files | Where-Object { $_.Name -ne 'manifest.json' -and $_.Name -ne 'errors.log' -and $_.Name -ne 'metadata.json' }).Count
  $bytes = ($files | Where-Object { $_.Name -ne 'manifest.json' -and $_.Name -ne 'errors.log' -and $_.Name -ne 'metadata.json' } | Measure-Object Length -Sum).Sum
  if (-not $bytes) { $bytes = 0 }
  $pct = if ($TOTAL) { [math]::Round(($count / $TOTAL) * 100, 2) } else { 0 }
  Write-Host ""
  Write-Host ("Files:    {0:N0} / {1:N0} ({2}%)" -f $count, $TOTAL, $pct) -ForegroundColor Yellow
  Write-Host ("Size:     {0:N2} GB" -f ($bytes/1GB))

  # Rate + ETA from manifest
  if (Test-Path $MANI) {
    try {
      $m = Get-Content $MANI -Raw | ConvertFrom-Json
      $entries = @($m.entries.PSObject.Properties.Value)
      if ($entries.Count -ge 2) {
        $sorted = $entries | Sort-Object { [datetime]$_.downloaded_at }
        $first  = $sorted | Select-Object -First 1
        $last   = $sorted | Select-Object -Last 1
        $span   = ([datetime]$last.downloaded_at - [datetime]$first.downloaded_at).TotalSeconds
        $rate   = $span / ($entries.Count - 1)
        $remaining = $TOTAL - $entries.Count
        $etaSec = $remaining * $rate
        $etaTs  = [TimeSpan]::FromSeconds($etaSec)
        $eta    = (Get-Date).AddSeconds($etaSec)
        Write-Host ("Rate:     {0:N2} s/item (lifetime avg)" -f $rate)
        Write-Host ("ETA:      {0} remaining ({1})" -f (Format-TimeSpan $etaTs), $eta.ToString('yyyy-MM-dd HH:mm'))

        $recent = $sorted | Select-Object -Last 50
        if ($recent.Count -ge 2) {
          $rSpan = ([datetime]$recent[-1].downloaded_at - [datetime]$recent[0].downloaded_at).TotalSeconds
          $rRate = $rSpan / ($recent.Count - 1)
          Write-Host ("Recent:   {0:N2} s/item (last {1})" -f $rRate, $recent.Count) -ForegroundColor DarkYellow
        }
      }
    } catch {
      Write-Host "Rate:     (manifest parse pending)" -ForegroundColor DarkGray
    }
  } else {
    Write-Host "Rate:     (no manifest yet)" -ForegroundColor DarkGray
  }

  # Errors
  $errLog = "$OUT\errors.log"
  if (Test-Path $errLog) {
    $errLines = @(Get-Content $errLog)
    Write-Host ""
    Write-Host ("ERRORS:   {0} entries in errors.log" -f $errLines.Count) -ForegroundColor Red
    $errLines | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  } else {
    Write-Host "Errors:   none" -ForegroundColor Green
  }

  # stderr size
  if (Test-Path $ERR) {
    $errSz = (Get-Item $ERR).Length
    if ($errSz -gt 0) {
      Write-Host ("stderr:   {0} bytes (process-level errors below)" -f $errSz) -ForegroundColor Magenta
      Get-Content $ERR -Tail 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Magenta }
    }
  }

  # Tail log
  Write-Host ""
  Write-Host "--- last 15 log lines ---" -ForegroundColor DarkCyan
  if (Test-Path $LOG) {
    Get-Content $LOG -Tail 15 | ForEach-Object { Write-Host $_ }
  }

  Write-Host ""
  Write-Host "(Ctrl-C to quit. Refreshing every 5s...)" -ForegroundColor DarkGray
  Start-Sleep -Seconds 5
}
