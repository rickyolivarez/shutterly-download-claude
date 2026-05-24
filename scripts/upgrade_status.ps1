# upgrade_status.ps1 - live PowerShell dashboard for upgrade.js
# Reads JSONL audit log + log files to produce a refreshing terminal dashboard.
# Refreshes every 10 seconds. Ctrl-C to exit.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/upgrade_status.ps1
#
# Or via the bundled launcher (Windows):
#   scripts\upgrade_status.cmd

# BASE = repo root (one level up from scripts/). Adjust if your downloads/ lives elsewhere.
$BASE        = (Get-Item $PSScriptRoot).Parent.FullName
$JSONL       = "$BASE\downloads\video_upgrades.jsonl"
$LOG         = "$BASE\downloads\upgrade.log"
$ERR         = "$BASE\downloads\upgrade.err"
$REFRESH_SEC = 10

function Format-Bytes {
  param([double]$n)
  if ($n -ge 1GB) { return ('{0:N2} GB' -f ($n / 1GB)) }
  if ($n -ge 1MB) { return ('{0:N1} MB' -f ($n / 1MB)) }
  if ($n -ge 1KB) { return ('{0:N0} KB' -f ($n / 1KB)) }
  return ('{0:N0} B' -f $n)
}

function Format-TimeSpan2 {
  param([TimeSpan]$ts)
  if ($ts.TotalDays -ge 1) { return ('{0}d {1:D2}h {2:D2}m' -f [int]$ts.TotalDays, $ts.Hours, $ts.Minutes) }
  if ($ts.TotalHours -ge 1) { return ('{0}h {1:D2}m {2:D2}s' -f [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds) }
  return ('{0:D2}m {1:D2}s' -f $ts.Minutes, $ts.Seconds)
}

function Get-UpgradeProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'upgrade\.js' } |
    Select-Object -First 1
}

while ($true) {
  Clear-Host
  $now = Get-Date

  Write-Host "============================================================" -ForegroundColor Cyan
  Write-Host "   Shutterfly Video Upgrade - Live Status" -ForegroundColor Cyan
  Write-Host "============================================================" -ForegroundColor Cyan
  Write-Host ("   Updated: {0}   Refresh: {1}s   Ctrl-C to quit" -f $now.ToString('yyyy-MM-dd HH:mm:ss'), $REFRESH_SEC) -ForegroundColor DarkGray
  Write-Host ""

  # ---- Process status ----
  Write-Host "   Process" -ForegroundColor Yellow
  Write-Host "   ----------------------------------------------------------" -ForegroundColor DarkGray
  $proc = Get-UpgradeProcess
  if ($proc) {
    $procObj = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
    if ($procObj) {
      $elapsed = $now - $procObj.StartTime
      $elapsedStr = Format-TimeSpan2 $elapsed
      $ramMB = [math]::Round($procObj.WorkingSet64 / 1MB)
      $cpuS = [math]::Round($procObj.CPU)
      Write-Host ("   PID {0,-6} ALIVE  -  elapsed {1}  -  RAM {2} MB  -  CPU {3}s" -f $proc.ProcessId, $elapsedStr, $ramMB, $cpuS) -ForegroundColor Green
    }
  } else {
    Write-Host "   No upgrade.js process found." -ForegroundColor Red
    Write-Host "   (Run completed, was killed, or has not started yet)" -ForegroundColor DarkGray
  }
  Write-Host ""

  # ---- Read JSONL and count events ----
  $committedEvents = @()
  $counts = @{}
  if (Test-Path $JSONL) {
    foreach ($line in Get-Content $JSONL) {
      if ($line -match '"event":"([^"]+)"') {
        $ev = $matches[1]
        if (-not $counts.ContainsKey($ev)) { $counts[$ev] = 0 }
        $counts[$ev]++
      }
      if ($line -like '*"event":"committed"*') {
        try { $committedEvents += ($line | ConvertFrom-Json) } catch { }
      }
    }
  }

  $committed = 0
  if ($counts.ContainsKey('committed')) { $committed = $counts['committed'] }
  $thawed = 0
  if ($counts.ContainsKey('thawed')) { $thawed = $counts['thawed'] }
  $unfreezeBatches = 0
  if ($counts.ContainsKey('unfreezeMoments_batch')) { $unfreezeBatches = $counts['unfreezeMoments_batch'] }
  $verifFailed = 0
  if ($counts.ContainsKey('verification_failed')) { $verifFailed = $counts['verification_failed'] }
  $errDl = 0
  if ($counts.ContainsKey('error_download')) { $errDl = $counts['error_download'] }
  $errCommit = 0
  if ($counts.ContainsKey('error_commit')) { $errCommit = $counts['error_commit'] }
  $errOther = 0
  if ($counts.ContainsKey('error_get_url')) { $errOther += $counts['error_get_url'] }
  if ($counts.ContainsKey('error_refresh_url')) { $errOther += $counts['error_refresh_url'] }
  $errTotal = $verifFailed + $errDl + $errCommit + $errOther

  # Overall total: prefer the ORIGINAL run's selection (first rotated log .run1.bak)
  # so the progress bar reflects the full scope across all runs, not just the current one.
  $overallTotal = 0
  $logsToScan = @()
  $run1Bak = $LOG + '.run1.bak'
  if (Test-Path $run1Bak) { $logsToScan += $run1Bak }
  if (Test-Path $LOG) { $logsToScan += $LOG }
  foreach ($lf in $logsToScan) {
    $sel = Get-Content $lf | Select-String 'selected (\d+) UID' | Select-Object -First 1
    if ($sel) { $overallTotal = [int]$sel.Matches[0].Groups[1].Value; break }
  }

  # Current run's slice
  $thisRunTotal = 0
  if (Test-Path $LOG) {
    $sel = Get-Content $LOG | Select-String 'selected (\d+) UID' | Select-Object -First 1
    if ($sel) { $thisRunTotal = [int]$sel.Matches[0].Groups[1].Value }
  }

  $pctDone = 0
  if ($overallTotal -gt 0) { $pctDone = [math]::Round(($committed / $overallTotal) * 100, 1) }

  # Count rotated bak files to show run number
  $bakFiles = Get-ChildItem -Path (Split-Path $LOG) -Filter 'upgrade.log.run*.bak' -ErrorAction SilentlyContinue
  $bakCount = 0
  if ($bakFiles) { $bakCount = $bakFiles.Count }
  $runNumber = $bakCount + 1

  Write-Host "   Pipeline" -ForegroundColor Yellow
  Write-Host "   ----------------------------------------------------------" -ForegroundColor DarkGray
  $barWidth = 50
  $filled = 0
  if ($overallTotal -gt 0) { $filled = [int]([math]::Floor($barWidth * $committed / $overallTotal)) }
  if ($filled -lt 0) { $filled = 0 }
  if ($filled -gt $barWidth) { $filled = $barWidth }
  $empty = $barWidth - $filled
  $bar = ('#' * $filled) + ('.' * $empty)
  Write-Host ("   [{0}]  {1}/{2}  ({3}%)" -f $bar, $committed, $overallTotal, $pctDone) -ForegroundColor Cyan
  Write-Host ""
  Write-Host ("   Run number          {0,6}  (rotated bak files: {1})" -f $runNumber, $bakCount) -ForegroundColor DarkGray
  Write-Host ("   Overall total       {0,6}  (full scope across all runs)" -f $overallTotal) -ForegroundColor DarkGray
  Write-Host ("   This run's slice    {0,6}  (UIDs THIS process is upgrading)" -f $thisRunTotal) -ForegroundColor DarkGray
  Write-Host ("   Unfreeze batches    {0,6}  (this run only)" -f $unfreezeBatches) -ForegroundColor DarkGray
  Write-Host ("   Thawed events       {0,6}  (cumulative across runs)" -f $thawed) -ForegroundColor DarkGray
  Write-Host ("   Committed (total)   {0,6}  <- upgrades fully applied (all runs)" -f $committed) -ForegroundColor Green
  if ($errTotal -gt 0) {
    Write-Host ("   Failed              {0,6}  (verif: {1}, dl: {2}, commit: {3}, other: {4})" -f $errTotal, $verifFailed, $errDl, $errCommit, $errOther) -ForegroundColor Red
  } else {
    Write-Host ("   Failed              {0,6}" -f 0) -ForegroundColor DarkGray
  }
  Write-Host ""

  # ---- Data ----
  Write-Host "   Data" -ForegroundColor Yellow
  Write-Host "   ----------------------------------------------------------" -ForegroundColor DarkGray
  if ($committedEvents.Count -gt 0) {
    $bytesNew = ($committedEvents | Measure-Object bytes -Sum).Sum
    Write-Host ("   New bytes downloaded: {0}" -f (Format-Bytes $bytesNew))

    $cutoff = $now.AddMinutes(-10).ToUniversalTime()
    $recent = @()
    foreach ($e in $committedEvents) {
      try {
        $ts = [datetime]::Parse($e.ts).ToUniversalTime()
        if ($ts -gt $cutoff) { $recent += $e }
      } catch { }
    }
    if ($recent.Count -ge 2) {
      $rate = $recent.Count / 10.0
      Write-Host ("   Recent rate:          {0:N1} files/min  (over last 10 min)" -f $rate)
      $remaining = $overallTotal - $committed
      if ($rate -gt 0 -and $remaining -gt 0) {
        $etaMin = $remaining / $rate
        $etaTs = [TimeSpan]::FromMinutes($etaMin)
        $etaStr = Format-TimeSpan2 $etaTs
        $etaDate = $now.AddMinutes($etaMin)
        Write-Host ("   ETA:                  {0}  ({1})" -f $etaStr, $etaDate.ToString('yyyy-MM-dd HH:mm'))
      }
    }
  } else {
    Write-Host "   (no commits yet)" -ForegroundColor DarkGray
  }
  Write-Host ""

  # ---- Recent activity ----
  Write-Host "   Recent activity (last 5 commits)" -ForegroundColor Yellow
  Write-Host "   ----------------------------------------------------------" -ForegroundColor DarkGray
  if ($committedEvents.Count -gt 0) {
    $last5 = $committedEvents | Select-Object -Last 5
    foreach ($e in $last5) {
      try { $ts = [datetime]::Parse($e.ts).ToString('HH:mm:ss') } catch { $ts = '???' }
      $size = Format-Bytes ([double]$e.bytes)
      $mbpsStr = ''
      if ($e.mbps) { $mbpsStr = ' @ ' + $e.mbps + ' MB/s' }
      Write-Host ("   {0}  uid {1,-20}  {2,10}{3}" -f $ts, $e.uid, $size, $mbpsStr)
    }
  } else {
    Write-Host "   (none yet)" -ForegroundColor DarkGray
  }
  Write-Host ""

  # ---- Last 6 log lines ----
  Write-Host "   Last 6 log lines" -ForegroundColor Yellow
  Write-Host "   ----------------------------------------------------------" -ForegroundColor DarkGray
  if (Test-Path $LOG) {
    Get-Content $LOG -Tail 6 | ForEach-Object {
      $ll = $_
      if ($ll.Length -gt 110) { $ll = $ll.Substring(0, 107) + [string][char]0x2026 }
      Write-Host ("   {0}" -f $ll) -ForegroundColor DarkGray
    }
  } else {
    Write-Host ("   (no log file at {0})" -f $LOG) -ForegroundColor DarkGray
  }
  Write-Host ""

  # ---- stderr ----
  if (Test-Path $ERR) {
    $errSz = (Get-Item $ERR).Length
    if ($errSz -gt 0) {
      Write-Host "   *** STDERR ***" -ForegroundColor Red
      Get-Content $ERR -Tail 3 | ForEach-Object { Write-Host ("   {0}" -f $_) -ForegroundColor Red }
      Write-Host ""
    }
  }

  Write-Host "============================================================" -ForegroundColor Cyan
  Start-Sleep -Seconds $REFRESH_SEC
}
