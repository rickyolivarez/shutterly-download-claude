# Shutterfly Bulk Downloader

A pure-API toolkit for archiving your entire Shutterfly photo library to local disk, plus an experimental pipeline that retrieves true original-quality videos from Shutterfly's cold-storage archive.

> **Status:** Functional. Proven on libraries up to 48,000+ items / 127 GB. Use at your own risk — this depends on Shutterfly's internal API which may change without warning.
>
> **Not affiliated with Shutterfly Inc.** This is a personal-archival tool built by reverse-engineering the web app's network traffic.

---

## Why does this exist?

Shutterfly does not offer bulk export. The web UI provides a per-item "Download" button. For a library of 48,000 items that's roughly 133 hours of clicking and waiting. CCPA "right to access" requests technically apply but Shutterfly's response historically excludes original-quality video files.

This project automates what the UI does, one item at a time, but in parallel where possible.

## What does it do?

Two phases, both optional:

1. **Bulk download** (`downloader.js`) — walks your entire library newest-to-oldest, downloads every photo and video at the quality Shutterfly's UI Download button delivers (full-resolution photos, transcoded medium-quality videos). Resumable. Survives crashes, network blips, and multi-day runs.

2. **Video upgrade** (`upgrade.js`) — for each video, triggers a server-side Glacier restore and retrieves the **true original** file (typically 10-150× larger than the medium transcode). Photos cannot be upgraded — Shutterfly does not expose a higher-quality photo path.

## Architecture at a glance

```
┌──────────────────┐        ┌─────────────────────────────────────┐
│  manual_login.js │──────► │  ./auth.json (session cookies)      │
│  (one-time)      │        │  ./.env.local (NEVER commit)        │
└──────────────────┘        └─────────────┬───────────────────────┘
                                          │
                                          ▼
                                ┌──────────────────────┐
                                │  downloader.js       │
                                │  ────────────────    │
                                │  1. Sniff JWT+APIkey │
                                │  2. getPaginatedM... │──────► library catalog
                                │  3. getMomentSet...  │──────► per-item metadata
                                │  4. download each    │──────► ./downloads/<files>
                                │  5. write manifest   │──────► ./downloads/manifest.json
                                └──────────────────────┘
                                          │
                          ┌───────────────┴───────────────┐
                          │   (optional, later)            │
                          ▼                                │
                                ┌──────────────────────┐  │
                                │  upgrade.js          │  │
                                │  ────────────────    │  │
                                │  1. Read manifest    │◄─┘
                                │  2. unfreezeMoments  │──────► AWS Glacier restore (~3h)
                                │  3. Poll until 206   │
                                │  4. downloadDetails  │──────► presigned URL to original
                                │     (8-pos params)   │
                                │  5. Stream+verify    │──────► ./downloads/<file> (swap)
                                │  6. Update manifest  │
                                └──────────────────────┘
```

The two scripts are independent — you can run the downloader without ever using upgrade.js.

## Requirements

- **Node.js 18 or later** (uses `fetch`, ES2022 features, etc.)
- **ExifTool** ([exiftool.org](https://exiftool.org/)) — needed by the downloader for image date metadata
- **A Shutterfly account** with photos in it
- **Windows, macOS, or Linux** (developed on Windows, scripts use cross-platform path handling)
- Disk space: budget about 3 GB per 1,000 medium-quality items, more for video originals

The project uses Playwright (installed via npm) to sniff authentication tokens from a headless browser. No "scraping" — we observe the same network calls Shutterfly's own SPA makes.

## Getting started

The recommended way to use this project is **with Claude Code as your guide**. The repo ships with a [`CLAUDE.md`](CLAUDE.md) file at the root that walks Claude through your setup step-by-step — checking your environment, installing dependencies, doing the one-time login, kicking off the bulk download, then the video upgrade.

### Three steps

1. **Clone the repo** to a local directory:
   ```bash
   git clone https://github.com/<your-org>/shutterfly-bulk-downloader.git
   cd shutterfly-bulk-downloader
   ```

2. **Launch Claude Code from that directory.** Open your terminal (Windows: PowerShell or Command Prompt; macOS/Linux: any terminal), `cd` into the repo, then run:
   ```bash
   claude --dangerously-skip-permissions
   ```
   The `--dangerously-skip-permissions` flag lets Claude take filesystem/network actions without prompting for each one. **Only use this in a directory you trust** (i.e., the repo you just cloned). Don't run it in `~` or `/`.

   If you don't have Claude Code installed yet, see [claude.com/claude-code](https://www.claude.com/claude-code) for the installer.

3. **Ask Claude to begin:**
   > Read CLAUDE.md and walk me through the setup.

   Claude will read the file, confirm your goal (archive only, archive + cloud, archive at full quality), check your environment against the assumptions in `docs/SETUP.md`, and guide you through the 10-step runbook. Most of the wait time is automatic — Claude tells you when to kick off long-running jobs and when to come back.

### Manual path (if you don't want to use Claude)

If you'd rather follow the instructions yourself, the same step-by-step is in [`CLAUDE.md`](CLAUDE.md) — it's written as a runbook humans can read too. The headings ("Step 0 — Sanity-check the environment", "Step 1 — Install dependencies", etc.) tell you what to do in order. Also read [`docs/SETUP.md`](docs/SETUP.md) for the dependency list and known issues.

## Quick start

> **Before you begin**: read [`docs/SETUP.md`](docs/SETUP.md) for the full dependency list, environment assumptions, and known issues. The steps below are the abbreviated path.

```bash
# 1. Clone and install
git clone https://github.com/<your-org>/shutterfly-bulk-downloader.git
cd shutterfly-bulk-downloader
npm install
npx playwright install chromium

# 2. Configure (no secrets in repo — see .env.example)
cp .env.example .env.local
#   edit .env.local: set SHUTTERFLY_EMAIL and SHUTTERFLY_PASSWORD

# 3. One-time interactive login (opens a real browser window)
node manual_login.js
#   You complete the login + any 2FA challenge by hand.
#   Script saves auth.json with your session cookies.
#   You only do this once; cookies last weeks.

# 4. Bulk download everything (resumable)
node downloader.js --count 48451 --out ./downloads --rate-ms 5000
#   --count is an upper bound; the script downloads exactly that many items
#   from your library (newest to oldest) or fewer if the library is smaller.
#   For very large libraries, expect 1-3 days of wall-clock time.

# 5. (Optional) Upgrade videos to originals
node upgrade.js --limit 10              # TEST: top 10 videos by upgrade ratio, downloads to ./test/
node upgrade.js --limit 10 --commit     # COMMIT: swap files in ./downloads/ and update manifest
node upgrade.js --uids u1,u2,u3 --watch # explicit list, wait for Glacier thaw

# Full library video upgrade (recommended bulk command):
node upgrade.js --limit 5000 --commit --watch --skip-status-check
```

### Bulk run flags reference

The upgrade pipeline is throttled by default to avoid rate-limiting:

| Flag | Default | Purpose |
|---|---|---|
| `--api-rate-ms <ms>` | **4500** | Min ms between Shutterfly API calls (NOT S3) |
| `--download-concurrency <N>` | **5** | Max parallel S3 file downloads |
| `--unfreeze-batch-size <N>` | **25** | UIDs per `unfreezeMoments` call |
| `--heartbeat-secs <N>` | **5** | Status line interval, 0=off |
| `--skip-status-check` | off | Skip Phase 1 enumeration (recommended for bulk) |
| `--poll-secs <N>` | **60** | Seconds between thaw poll cycles |
| `--max-wait <min>` | **480** | Max minutes to wait for Glacier (8h buffer) |

**The 4.5s API rate is empirically safe.** The original bulk downloader ran at this pace for 52 hours against the same endpoints with zero rate-limit incidents.

**Measured wall-clock from a production run of 4,284 video UIDs (May 2026):**

| Phase | Time | Notes |
|---|---|---|
| Phase 2 (unfreeze, 172 calls × 4.5s) | ~13 min | Sequential API throttle |
| Phase 3 (Glacier thaw wait) | ~2-3h before first commits | AWS Glacier "Standard" tier SLA is 3-5h, median ~3h |
| Phase 3+4 (poll + parallel download) | ~3-4h once cascade starts | Saturates at producer ceiling of 13.3 commits/min |
| **Total wall-clock** | **~5-7 hours** | Hands-off; runs unattended |

Once the Glacier cascade kicks in, sustained throughput hits **13.3 commits/min** — exactly the producer's API throttle ceiling, meaning workers never wait on the producer.

For very large libraries (10,000+ videos), the same throughput holds — extrapolate at ~800 commits/hour after the first thaws begin. See [`docs/MEDIA_UPGRADE.md`](docs/MEDIA_UPGRADE.md) for a detailed breakdown.

## How it works — high level

### Authentication

Shutterfly's web app uses a JWT (issued by AWS Cognito) plus an x-api-key header for every API call. Both are short-lived; the SPA refreshes them automatically by re-using long-lived session cookies stored in the browser.

We replicate the same trick:

1. **`manual_login.js`** opens a real Playwright browser, navigates to `https://photos3.shutterfly.com/library` (which redirects you to the Shutterfly login page if not already authenticated), and waits up to 15 minutes for you to complete the login by hand. Once the URL returns to `/library`, the script saves Playwright's `storageState` (cookies + localStorage) to `auth.json`.

2. **All subsequent scripts** launch a headless Playwright context with `storageState: 'auth.json'`. They navigate to `/library` and listen for the SPA's first authenticated RPC call. From that call, they extract the JWT (which appears as `params[0]` of the JSON-RPC body) and the X-API-Key (a request header). With those two values, the script can make API calls itself without needing to drive the browser.

3. **JWT refresh on 401** — long downloads outlast a single JWT lifetime. The downloader catches `401 Unauthorized` responses, re-navigates the browser to `/library`, and re-sniffs the new JWT. This typically extends the session indefinitely as long as the underlying cookies remain valid.

See [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) for the full mechanism, including how cookies are persisted between runs.

### UID discovery

Every photo and video in Shutterfly's system has a **stable internal identifier called `uid`**. UIDs persist across renames, edits, and downloads — they're the join key for everything.

The downloader walks your library via `getPaginatedMoments`:

```
POST https://photos-api3.shutterfly.com/photos/json?method=getPaginatedMoments
{
  "method": "getPaginatedMoments",
  "params": [
    "<JWT>",
    "0",                       // start timestamp (epoch seconds)
    "<latest_timestamp>",      // end timestamp — we slide this to walk backwards
    2000,                      // page size
    false, false, "", true     // misc flags the SPA always sends
  ],
  ...
}
```

Response includes an array of "moment" objects, each with a `uid`, `moment_type` (image/video), `encrypted_id`, and a `moment_date` (epoch seconds). The downloader:

- Calls `getPaginatedMoments` with `endSec = now + 1 day`
- Receives up to 2000 newest items
- Records them, then calls again with `endSec = (oldest_in_page) - 1`
- Repeats until empty or until reaching the requested item count

This newest-to-oldest sliding-window walk is reliable for libraries of any size. We've tested it on 48,451-item libraries with no missed items and no duplicates (UID set dedup is built in).

See [`docs/UID_DISCOVERY.md`](docs/UID_DISCOVERY.md) for the response schema and the metadata enrichment phase.

### Per-item download — photos

Photos use a simple HTTP GET:

```
GET https://uniim1.shutterfly.com/services/download/<encrypted_id>?cn=THISLIFE
Authorization: Bearer <JWT>
```

The `encrypted_id` comes from the moment object returned by `getPaginatedMoments`. The response is the photo bytes. Filename is constructed from EXIF `DateTimeOriginal` (extracted with ExifTool) + a sequence number: `2024-08-15_image_001234.jpg`.

### Per-item download — videos

Videos require an extra RPC hop to fetch a presigned S3 URL:

```
POST https://photos-api3.shutterfly.com/photos/json?method=moment.downloadDetails
{ "params": ["<JWT>", "<uid>"], ... }

→ response: { result.payload.url = "https://prod-tl-m-17.s3.amazonaws.com/.../<uid>_medium.mp4?X-Amz-...." }
```

The presigned URL points at Shutterfly's medium-quality bucket (`prod-tl-m-17`). The script GETs that URL and saves the bytes. Filename pattern: `2023-07-20_video_000078.mov`.

### Manifest — the source of truth

Every successful download appends a single JSON entry to `./downloads/manifest.json`:

```json
{
  "entries": {
    "1773638306792092": {
      "uid": "1773638306792092",
      "type": "video",
      "original_filename": "FullSizeRender.mov",
      "moment_date_iso": "2023-07-20",
      "url": "...",
      "saved_path": "./downloads/2023-07-20_video_000078.mov",
      "bytes": 516759,
      "sha256": "eed931400d3952ed...",
      "orig_filesize": 5235232,
      "orig_width": 1920, "orig_height": 1080,
      "downloaded_at": "2026-05-22T14:42:12.422Z"
    },
    ...
  },
  "order": ["1773638306792092", ...]
}
```

The manifest is written atomically (`temp file + rename`) after every item. On crash or kill, the next run with `--resume` reads the manifest and skips already-downloaded UIDs. We tested this on multi-day runs — kill the process at any point, restart, and it picks up cleanly.

**Critical field**: `orig_filesize`. Shutterfly tells us upfront how big the ORIGINAL file is. The fact that `bytes < orig_filesize` for most videos is what tells us originals exist somewhere and motivated the upgrade pipeline.

### Long-running operation without manual monitoring

The downloader is designed to run for **days** without supervision. Specific design choices:

- **Single auth file** — `./auth.json` (Playwright `storageState`) holds your session cookies. Created once by `manual_login.js` and reused by every other script. Lives weeks before needing refresh.
- **JWT refresh on 401** — sessions live as long as cookies do (weeks).
- **Atomic manifest writes** — `manifest.json.tmp` + rename ensures the manifest is always in a parseable state, even if the OS kills the process mid-flush.
- **Per-item retries** — 3 attempts with 1s/4s/16s exponential backoff per failure.
- **Errors logged, not fatal** — failed items go to `errors.log` and `--resume` will retry them on a subsequent run.
- **Throttled** — `--rate-ms` (default 5000ms) between items to avoid being noticed by Shutterfly's rate limiter.
- **Memory-bounded** — Playwright's `APIResponse.dispose()` is called explicitly after every download to free buffer memory. Without this, the process leaks ~600 MB/hour.

You start it once and walk away. We've successfully run it for 52 hours straight to download 31,374 items.

### The video upgrade — what we discovered

After the bulk download completes, every video in your manifest will have `bytes` (medium tier) and `orig_filesize` (the original). For most videos, `orig_filesize / bytes` is in the range 5-150×. There are 4,400+ videos worth of unrealized storage waiting in Shutterfly's cold archive.

The web UI's "Request original" button:
1. Triggers an AWS Glacier `RestoreObject` for that UID's underlying file
2. Sends an email 3-5 hours later when the restore completes
3. Provides a link that opens an in-app modal with a "Download" button
4. That button calls `moment.downloadDetails` to get a presigned URL to a *different* S3 bucket (`prod-tl-video-source`) where the restored original lives temporarily

Through diagnostic experiments (`research/playwright/d1-d10`), we discovered that the entire UI flow can be replaced with two API calls:

```
1. POST .../json?method=moment.unfreezeMoments
   params: ["<JWT>", ["<uid1>", "<uid2>", ...]]
   → starts Glacier restore (no response payload, just success: true)

2. (after ~3 hours) POST .../json?method=moment.downloadDetails
   params: ["<JWT>", "<uid>", null, null, null, null, null, true]
                                                              ^^^^
                                          THE KEY: 8-position params with `true` at index 7
                                          → returns presigned URL to ORIGINAL bytes
```

The 8th-position boolean was the breakthrough. Without it, `downloadDetails` returns the medium URL. With it, the original. The UI uses an 8-position params array; community reverse-engineering efforts had only documented a 2-position form.

Polling the resulting presigned URL with a 1-byte `Range: bytes=0-1` request tells us thaw status:
- **403 Forbidden** + XML body → still in Glacier
- **206 Partial Content** + `Content-Range: bytes 0-1/<total>` → ready to fetch

The full upgrade pipeline does this in a loop with all eligible video UIDs, batching the unfreeze calls and downloading in parallel as files become available.

See [`docs/MEDIA_UPGRADE.md`](docs/MEDIA_UPGRADE.md) for the full discovery story, the exact request shapes, and the verification gate that ensures we got the actual original (not a re-served medium).

## Verification

Every upgraded file passes three checks before the medium is replaced:

| Check | Test |
|---|---|
| Size | `bytes(downloaded) ≈ manifest.orig_filesize` within ±0.1% |
| Hash | `sha256(downloaded) !== manifest.sha256` (proves it isn't the same file re-served) |
| Filename | `payload.fileName === manifest.original_filename` (proves it's the right asset) |

If all three pass, the medium file is renamed to `.medium.bak`, the new file takes its place, the manifest is updated, and the `.medium.bak` is deleted. If any check fails, the new file is discarded and the medium stays.

## Files

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Entry point for AI assistants (also a step-by-step runbook for humans) |
| `manual_login.js` | One-time interactive login — saves session cookies to `auth.json` |
| `downloader.js` | Bulk download every photo + video at medium-or-better quality |
| `upgrade.js` | Replace medium videos with true originals from Glacier |
| `scan_and_grab.js` | One-shot cleanup: probe pending UIDs, grab anything thawed, exit (no waiting) |
| `scripts/status.ps1` | Live PowerShell dashboard for `downloader.js` (RAM, ETA, error count) |
| `scripts/upgrade_status.ps1` | Live PowerShell dashboard for `upgrade.js` (multi-run aware) |
| `scripts/upgrade_status.cmd` | Double-click launcher for the upgrade dashboard |
| `scripts/launch_durable.ps1` | Windows-only launcher via Task Scheduler — survives RDP/Windows Update |
| `scripts/upscale_too_small.ps1` | Fix Google Photos "PHOTOS_FILE_TOO_SMALL" errors by upscaling tiny JPGs (256 px floor) |
| `package.json` | Just `playwright` as a dependency |
| `.env.example` | Template — copy to `.env.local`, do NOT commit |
| `.gitignore` | Keeps secrets, auth, and downloaded data out of git |
| `docs/SETUP.md` | Read first — dependencies, assumptions, known issues |
| `docs/ARCHITECTURE.md` | Deeper dive on data flow and resilience design |
| `docs/AUTHENTICATION.md` | How the JWT + X-API-Key sniffing works |
| `docs/UID_DISCOVERY.md` | The catalog enumeration and metadata pipeline |
| `docs/MEDIA_UPGRADE.md` | Video Glacier bypass + photo investigation (HEIC vs JPEG quality reality) |
| `docs/CLOUD_SYNC.md` | Replace-in-place compatibility with Google Drive, Photos, etc. |
| `docs/TROUBLESHOOTING.md` | Common errors, crash recovery, persistent failure patterns |

## What's deliberately NOT in this repo

- `auth.json` — your session cookies, treat like a password
- `.env.local` — your email and password
- `downloads/` — your actual photo library, can be hundreds of GB
- Anything else in `.gitignore`

## Limitations and gotchas

- **Photos cannot be upgraded.** Shutterfly does not expose a higher-quality photo path. What `downloader.js` retrieves is the best the public download UI delivers, which is often a JPEG re-encoding at lower quality than the original upload.
- **Shutterfly may change their API at any time.** This project is a snapshot of how it works as of 2026-05. If RPC names, param shapes, or auth flow change, you'll need to re-do the recon (the `research/playwright/` scripts show how).
- **No 2FA automation.** `manual_login.js` waits for you to complete 2FA by hand. Once logged in, sessions persist for weeks.
- **Rate limits unknown at scale.** Shutterfly's exact limits on `getPaginatedMoments`, `unfreezeMoments`, etc. are not publicly documented. The downloader's default 5s between items has worked for us; if you trip a rate limit, adjust `--rate-ms`.
- **`unfreezeMoments` per-batch ceiling unknown.** A production run batched 25 UIDs/call across 172 calls (4,300 UIDs total) with no failures. The default `--unfreeze-batch-size` is 25. Larger batches are likely supported but have not been verified.
- **Glacier restore latency is real.** AWS Glacier "Standard" tier promises 3-5 hours. Some files take longer. The pipeline polls every 60s and times out after 6 hours by default.
- **HEIC files come back as JPG.** Shutterfly server-side-transcodes HEIC uploads to JPG before letting you download. If you specifically need HEIC, file a CCPA request.

## Acknowledgments

This project builds on community reverse-engineering of Shutterfly's APIs going back to the ThisLife era (2013). See [`docs/UID_DISCOVERY.md`](docs/UID_DISCOVERY.md) for the prior art that informed the design.

## License

MIT — see [LICENSE](LICENSE). No warranty. You are responsible for following Shutterfly's terms of service and any applicable laws regarding your use of this software.

## Disclaimer

This is a personal-archival tool. It accesses your own Shutterfly account using your own credentials. It does not bypass any access controls or scrape data you don't already have access to via the official website. It performs the same network calls the official web app makes, just programmatically.

Shutterfly is a registered trademark of Shutterfly Inc. This project is not affiliated with, endorsed by, or supported by Shutterfly.
