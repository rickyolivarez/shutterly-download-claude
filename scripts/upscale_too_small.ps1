# upscale_too_small.ps1 -- fix Google Photos "PHOTOS_FILE_TOO_SMALL" rejections
#
# Why this exists: Google Photos rejects any image whose shortest edge is less
# than 256 pixels. Shutterfly's "compressed display" tier is typically
# 150-300 px on the long edge, so most thumbnails fail Photos slurp with the
# error "Some files are too small" / PHOTOS_FILE_TOO_SMALL. The fix is to
# upscale past the 256 px floor; the dimension check is purely numeric, so
# bicubic/Lanczos resampling clears it. EXIF (especially DateTimeOriginal)
# must be preserved or Google Photos will bucket the upload under today's
# date and you will not be able to fix it in bulk afterward.
#
# Two modes:
#   -Mode discover : parse Google Drive logs, write a TSV of rejected files
#   -Mode fix      : read the TSV, upscale, replace in-place (with backups)
#
# Examples (run from anywhere; paths resolve relative to the script):
#   .\upscale_too_small.ps1 -Mode discover
#   .\upscale_too_small.ps1 -Mode fix                          # dry run
#   .\upscale_too_small.ps1 -Mode fix -Commit                  # replace in place
#
# Prerequisites: ImageMagick 7+ on PATH (winget install ImageMagick.ImageMagick),
# ExifTool on PATH (winget install -e --id OliverBetz.ExifTool), Google Drive
# for Desktop installed (only needed for -Mode discover).

param(
  [ValidateSet('discover', 'fix')]
  [string]$Mode = 'discover',

  [string]$TsvPath,
  [string]$Downloads,
  [string]$DriveLogs,

  [int]$Width   = 1000,
  [int]$Quality = 90,
  [switch]$Commit
)

$ErrorActionPreference = "Stop"

# ---------- resolve paths ----------
$repoRoot   = (Get-Item $PSScriptRoot).Parent.FullName
if (-not $TsvPath)   { $TsvPath   = Join-Path $repoRoot 'downloads\too_small.tsv' }
if (-not $Downloads) { $Downloads = Join-Path $repoRoot 'downloads' }
if (-not $DriveLogs) {
  $DriveLogs = Join-Path $env:LOCALAPPDATA 'Google\DriveFS\Logs'
}

# ---------- tool discovery ----------
function Resolve-Magick {
  $g = Get-Command magick -ErrorAction SilentlyContinue
  if ($g) { return $g.Source }
  $glob = Get-ChildItem -Path "C:\Program Files\ImageMagick*","C:\Program Files (x86)\ImageMagick*" -Filter "magick.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($glob) { return $glob.FullName }
  throw "ImageMagick not found. Install with: winget install ImageMagick.ImageMagick"
}
function Resolve-Exiftool {
  $g = Get-Command exiftool -ErrorAction SilentlyContinue
  if ($g) { return $g.Source }
  throw "exiftool not found on PATH. Install ExifTool, or add its install folder to PATH."
}

# ============================================================
# MODE: discover -- scan Drive logs, write TSV of rejected files
# ============================================================
if ($Mode -eq 'discover') {
  if (-not (Test-Path $DriveLogs)) {
    throw "Drive log folder not found: $DriveLogs (is Google Drive for Desktop installed?)"
  }
  $logFiles = Get-ChildItem -Path $DriveLogs -Filter "drive_fs*.txt" -ErrorAction SilentlyContinue
  if (-not $logFiles) { throw "No Drive log files found in $DriveLogs" }

  $tooSmall = @{}
  foreach ($f in $logFiles) {
    $lines = Get-Content $f.FullName
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match "FILE_TOO_SMALL") {
        for ($j = $i; $j -gt [Math]::Max(0, $i - 10); $j--) {
          if ($lines[$j] -match 'photos_slurp_transporter.*MaybeUploadMediaFileInternalFromOpenFile.*file_path="([^"]+)".*size=(\d+)') {
            $fname = $matches[1]; $size = [int64]$matches[2]
            if ($size -gt 0 -and $fname -notmatch "_TEMP" -and -not $tooSmall.ContainsKey($fname)) {
              $tooSmall[$fname] = $size
            }
            break
          }
        }
      }
    }
  }

  $tooSmall.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Value)`t$($_.Key)" } |
    Out-File -FilePath $TsvPath -Encoding utf8

  Write-Host ""
  Write-Host "Rejected files found:  $($tooSmall.Count)"
  Write-Host "TSV written:           $TsvPath"
  Write-Host ""
  Write-Host "Next: .\upscale_too_small.ps1 -Mode fix          # dry run"
  Write-Host "Then: .\upscale_too_small.ps1 -Mode fix -Commit  # in-place replace"
  return
}

# ============================================================
# MODE: fix -- read TSV, upscale, replace originals
# ============================================================
$Magick   = Resolve-Magick
$ExifTool = Resolve-Exiftool

$staging  = Join-Path $repoRoot 'downloads\.upscale_staging'
$backups  = Join-Path $repoRoot 'downloads\.upscale_backups'
if (-not (Test-Path $TsvPath))   { throw "TSV not found: $TsvPath -- run with -Mode discover first." }
if (-not (Test-Path $staging))   { New-Item -ItemType Directory -Path $staging | Out-Null }
if ($Commit -and -not (Test-Path $backups)) { New-Item -ItemType Directory -Path $backups | Out-Null }

$entries = Get-Content $TsvPath | ForEach-Object {
  $parts = $_ -split "`t"
  if ($parts.Count -eq 2) {
    [PSCustomObject]@{ Size = [int64]$parts[0]; Name = $parts[1] }
  }
} | Where-Object { $_ }

Write-Host ""
Write-Host "Mode:     $(if ($Commit) { 'COMMIT (in-place replace)' } else { 'DRY-RUN (staging only)' })"
Write-Host "Entries:  $($entries.Count)"
Write-Host "Width:    ${Width}px (aspect preserved)"
Write-Host "Quality:  $Quality"
Write-Host ""

$ok = 0; $skipped = 0; $failed = 0
foreach ($e in $entries) {
  $src = Join-Path $Downloads $e.Name
  $out = Join-Path $staging  $e.Name
  if (-not (Test-Path $src)) {
    Write-Host "[SKIP] $($e.Name) not in $Downloads"
    $skipped++; continue
  }
  try {
    & $Magick $src -filter Lanczos -resize "${Width}x" -quality $Quality $out
    if ($LASTEXITCODE -ne 0) { throw "magick failed (exit $LASTEXITCODE)" }
    & $ExifTool -TagsFromFile $src -all:all -overwrite_original $out 2>&1 | Out-Null

    # If DateTimeOriginal missing after EXIF copy, derive from filename (YYYY-MM-DD prefix)
    $newDate = (& $ExifTool -s -s -s -DateTimeOriginal $out 2>$null)
    if (-not $newDate) {
      if ($e.Name -match '^(\d{4})-(\d{2})-(\d{2})') {
        $stamp = "$($matches[1]):$($matches[2]):$($matches[3]) 12:00:00"
        & $ExifTool "-DateTimeOriginal=$stamp" "-CreateDate=$stamp" -overwrite_original $out 2>&1 | Out-Null
        $newDate = "$stamp  (from filename)"
      } else {
        $newDate = "(none -- no EXIF, filename did not parse)"
      }
    }

    $dims = & $ExifTool -s -s -s -ImageWidth -ImageHeight $out 2>$null
    $w = [int]$dims[0]; $h = [int]$dims[1]
    $passes = [Math]::Min($w, $h) -ge 256
    $newSize = (Get-Item $out).Length

    $status = if ($passes) { "OK " } else { "WARN" }
    Write-Host ("[$status] {0,-38} {1,5}->{2,5}KB  {3}x{4}  date={5}" -f `
      $e.Name, ([int]($e.Size/1KB)), ([int]($newSize/1KB)), $w, $h, $newDate)

    if ($Commit -and $passes) {
      Copy-Item -Path $src -Destination (Join-Path $backups $e.Name) -Force
      Copy-Item -Path $out -Destination $src -Force
    }
    $ok++
  } catch {
    Write-Host "[FAIL] $($e.Name): $($_.Exception.Message)"
    $failed++
  }
}

Write-Host ""
Write-Host "===================================================="
Write-Host "OK:      $ok"
Write-Host "Skipped: $skipped"
Write-Host "Failed:  $failed"
Write-Host "===================================================="
if (-not $Commit) {
  Write-Host ""
  Write-Host "Dry-run outputs in: $staging"
  Write-Host "Re-run with -Commit to back up originals (in .upscale_backups\) and replace in-place."
}
