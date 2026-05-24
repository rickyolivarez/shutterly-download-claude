# Setup — dependencies, assumptions, and known issues

Read this BEFORE you start. It covers what you need installed, what assumptions the project makes about your environment, and the known issues you may encounter. The README's quick-start section is the abbreviated version; this doc is the full picture.

## Dependency requirements

### Required

| Dependency | Minimum version | Why |
|---|---|---|
| **Node.js** | **18.0+** | Uses native `fetch`, top-level `await`, ES2022 features. Tested on 18 and 20. |
| **npm** | bundled with Node | Installs Playwright + dependencies |
| **Playwright Chromium** | latest | Sniffs JWT + X-API-Key from the live Shutterfly SPA. Auto-installed via `npx playwright install chromium` |
| **ExifTool** | 12+ | Photo `DateTimeOriginal` extraction (used to name files like `2023-07-20_image_001234.jpg`). Get from [exiftool.org](https://exiftool.org/). Must be in PATH. |
| **Shutterfly account** | any | With at least 1 photo or video. The tool downloads YOUR library only. |

### Required for monitoring/dashboards (Windows only)

| Dependency | Minimum version | Why |
|---|---|---|
| **PowerShell** | **5.1+** | Runs `scripts/status.ps1` and `scripts/upgrade_status.ps1` |

(Bash equivalents are not provided; if you're on macOS or Linux, you can monitor by tailing `downloader.log` / `upgrade.log` directly.)

### Optional

| Dependency | Why |
|---|---|
| **`nssm`** ([nssm.cc](https://nssm.cc/)) | Install upgrade.js as a Windows service for fully session-independent operation. Required only if you've seen Windows Update kill the process mid-run. |
| **Google One subscription** | If you plan to push the result to Google Drive. Budget ~1.3 TB for a 4,000-video / 44,000-photo library at full quality. The 2 TB plan covers most personal libraries. |
| **Cloud storage with versioning** | Dropbox, OneDrive, iCloud Drive — same principle as Google Drive, NOT Google Photos. See [`CLOUD_SYNC.md`](CLOUD_SYNC.md). |
| **ImageMagick 7+** ([imagemagick.org](https://imagemagick.org/) or `winget install ImageMagick.ImageMagick`) | Only needed if you'll run `scripts/upscale_too_small.ps1` to fix Google Photos "files too small" rejections on Shutterfly's compressed-display JPGs. |

### Network requirements

- Stable internet connection (cellular tethering NOT recommended — the bulk downloader runs for 1-3 days continuously)
- Outbound HTTPS to `*.shutterfly.com`, `*.thislife.com`, `*.amazonaws.com`
- No corporate VPN that intercepts/rewrites TLS (Playwright's headless Chromium will fail TLS verification)

### Disk space estimates

| Library size | Bulk download (medium tier) | After video upgrade |
|---|---|---|
| 5,000 items | ~15 GB | ~80 GB |
| 25,000 items | ~75 GB | ~400 GB |
| 50,000 items | ~150 GB | ~800 GB |

Plus ~20% headroom for temp files during atomic swaps + the `.medium.bak` files held briefly during the upgrade phase.

## Assumptions this project makes

If any of these are wrong for your situation, expect things to break.

### About you

1. **You have a Shutterfly account with content in it.** The tool downloads only YOUR library; it can't access other accounts.
2. **You can complete an interactive login** (including 2FA challenges) in a Playwright-opened Chromium window. This is a one-time step. If you can't see/interact with the desktop, this tool isn't for you.
3. **You have admin or write rights** to the output directory (`./downloads/` by default).
4. **You will read the documentation** before running anything in `--commit` mode. The `--commit` flag modifies your local library files (atomic swap). It does NOT touch your Shutterfly cloud account.
5. **You won't run two instances simultaneously** writing to the same `manifest.json`. The script uses atomic writes but two writers will conflict.

### About Shutterfly

1. **Shutterfly's web app API is unchanged** from when this code was written. The API is not public; if Shutterfly renames methods or changes auth, you'll need to re-do the network-traffic recon (see `docs/UID_DISCOVERY.md` and `docs/MEDIA_UPGRADE.md`).
2. **Your Shutterfly cookies remain valid for ~weeks** after one login. If you've been inactive for 60+ days, `manual_login.js` will need to re-run.
3. **Shutterfly doesn't ban your IP** for the default rate (5s/item for downloads, 4.5s/API call for upgrades). We've run for 52 hours straight without incidents. Aggressive rates may trigger rate limiting.

### About AWS (Shutterfly's storage backend)

1. **Glacier "Standard" tier SLA holds** at 3-5h for video originals. A small tail (~3%) may take 6-12 hours.
2. **Glacier retention is 24h** after restore completion. If you restart the upgrade more than 24h after the initial unfreeze, you'll need to re-thaw.
3. **Photo originals are likely in Glacier Deep Archive** (multi-day retrieval) — NOT publicly accessible via the API. See [`MEDIA_UPGRADE.md`](MEDIA_UPGRADE.md).

### About your environment

1. **The machine stays awake for days.** Configure power settings to never sleep, and on Windows configure Active Hours to disable auto-restart during your bulk run. Otherwise see "Process killed mid-run" in [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
2. **Your disk has the headroom estimated above** before you start. Running out of space mid-download leaves you with a partial manifest you'll need to either resume from or delete entirely.
3. **No antivirus actively scans the output folder.** Real-time scanning can hold file handles long enough to cause `EPERM` errors during atomic renames. Add the folder to your AV exclusion list.

## Issues noted (known limitations and gotchas)

These are real things that have happened in production runs. Most are documented in `TROUBLESHOOTING.md` with recovery procedures; this section is the quick scan.

### Bulk download (`downloader.js`)

| Issue | Frequency | Mitigation |
|---|---|---|
| JWT expires mid-run | Routine (every few hours) | Auto-refreshed on 401 — no action needed |
| Shutterfly returns 500/502/503 transient | Rare | 3× retry with backoff; failed items go to `errors.log` for `--resume` |
| HEIC files come back as JPG | By design | Shutterfly transcodes HEIC → JPEG server-side. JPG is full-resolution. See [`MEDIA_UPGRADE.md`](MEDIA_UPGRADE.md). |
| Some JPGs come back heavily compressed (5-150× smaller than `orig_filesize`) | Common (~70% of JPGs in a typical library) | No mitigation possible programmatically — see [`MEDIA_UPGRADE.md`](MEDIA_UPGRADE.md). Use Shutterfly's "Prepare Originals" UI for specific photos that matter. |
| Memory leak in Playwright if you forget `APIResponse.dispose()` | Code-level, fixed | Already handled in `downloader.js` |

### Video upgrade (`upgrade.js`)

| Issue | Frequency | Mitigation |
|---|---|---|
| ~0.01-0.1% of UIDs fail verification on every run | Persistent for that UID | The manifest's `orig_filesize` for that UID is wrong. Accept it as a permanent skip OR manually edit manifest to match delivered size. See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md). |
| ~3% of UIDs take 6-12 hours to thaw (extreme Glacier tail) | Per run | Normal Glacier variance. The `--max-wait 480` (8h) ceiling auto-exits. Resume with Run 2 — 24h retention helps. |
| Windows Update auto-restart kills the process | Per OS update cycle | Use `scripts/launch_durable.ps1` for session-independent runs, or disable Windows Update during Active Hours |
| `unfreezeMoments` batch size limit unknown | Unverified | Default 25/batch is empirically safe; haven't probed the ceiling |
| Filenames stored as UUIDs without extension in manifest | Common (~9% of videos) | Auto-handled — `verifyUpgrade()` strips extension before comparing |

### Photos in general

| Issue | Status |
|---|---|
| Cannot programmatically upgrade JPEG photo originals | **Confirmed unfixable** — Shutterfly stores originals in Glacier Deep Archive accessible only via the "Prepare Originals" email flow (multi-day async). See [`MEDIA_UPGRADE.md`](MEDIA_UPGRADE.md). |
| HEIC photos work fine | ✓ Already at full resolution after bulk download |
| CCPA "right to access" requests | Historically do NOT include original photo files |

### Cloud sync

| Issue | Mitigation |
|---|---|
| Google Photos backup creates duplicates when files are replaced | DON'T sync to Google Photos directly — use Google Drive instead. See [`CLOUD_SYNC.md`](CLOUD_SYNC.md). |
| Google Drive 30-day version retention purges old (medium) copies | Expected behavior; mark important files "Keep forever" if you want them retained |
| HEIC files transcoded to JPG by Google Photos on upload | If you upload via Drive-as-Photos sync, the JPG transcode is what gets stored. To keep original HEIC, upload via the Photos web UI's "Original quality" setting. |
| Google Photos rejects small JPGs with "PHOTOS_FILE_TOO_SMALL" | Affects Shutterfly's 150-300 px compressed-display tier. Run `scripts\upscale_too_small.ps1` to upscale past Google's 256 px floor. See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#google-drive--google-photos-sync-errors). |
| In-flight `_TEMP` video files appear in Google Photos | Old `upgrade.js` bug — fixed by writing to `.partial` extension first. If hit by stragglers from a pre-fix run, search Photos for `_TEMP` and delete. |

## Where to go next

After reading this:

1. **First-time setup**: see [`CLAUDE.md`](../CLAUDE.md) for the step-by-step walkthrough (10 steps, ~30 min hands-on).
2. **Troubleshooting**: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
3. **Architecture / how it works**: [`ARCHITECTURE.md`](ARCHITECTURE.md), [`AUTHENTICATION.md`](AUTHENTICATION.md), [`UID_DISCOVERY.md`](UID_DISCOVERY.md), [`MEDIA_UPGRADE.md`](MEDIA_UPGRADE.md).
4. **Pushing to cloud**: [`CLOUD_SYNC.md`](CLOUD_SYNC.md).
