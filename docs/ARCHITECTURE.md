# Architecture

A detailed look at how the system is structured, how data flows, and the design decisions that let it run unattended for multiple days.

## Components

```
manual_login.js     →  one-shot, interactive       →  produces auth.json
downloader.js       →  long-running, headless      →  produces ./downloads/* + manifest.json
upgrade.js          →  resumable, pure-API         →  rewrites ./downloads/*.mov + updates manifest
scripts/status.ps1  →  optional, read-only dash    →  monitors downloader.js progress
```

All scripts share a single piece of persistent auth state:

- **`auth.json`** — Playwright `storageState` dump (session cookies + localStorage). Written once by `manual_login.js`. Loaded by `downloader.js`, `upgrade.js`, and `scan_and_grab.js` via `newContext({ storageState })`. Treated as a password-equivalent.

## Data flow — bulk download phase

```
                        ┌──────────────────────────┐
                        │   auth.json (cookies)    │
                        └──────────┬───────────────┘
                                   │
                                   ▼
              ┌─────────────────────────────────────────┐
              │  downloader.js launches headless Chromium│
              │  with storageState: auth.json            │
              │  navigates to photos3.shutterfly.com    │
              │  /library                                │
              └─────────────┬───────────────────────────┘
                            │
                            │ listens to network traffic
                            ▼
              ┌─────────────────────────────────────────┐
              │  state.jwt       = params[0] from RPC    │
              │  state.apiKey    = X-API-Key from header │
              └─────────────┬───────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────────────────┐
              │  enumerateMoments(api, jwt, targetCount) │
              │  ── getPaginatedMoments × N pages       │
              │  ── slide endSec backwards in time      │
              │  ── dedup by uid                        │
              └─────────────┬───────────────────────────┘
                            │
                            │ list of moments
                            ▼
              ┌─────────────────────────────────────────┐
              │  fetchMetadataBatch (UIDs → full meta)   │
              │  ── getMomentSet, batches of 20         │
              │  ── persists to metadata.json after    │
              │     every 50 batches (resume-friendly)  │
              └─────────────┬───────────────────────────┘
                            │
                            │ for each moment...
                            ▼
              ┌─────────────────────────────────────────┐
              │  isVideo ? downloadVideo : downloadImage │
              │  ── 3 attempts, exp backoff 1s/4s/16s   │
              │  ── on 401: refreshSession (re-sniff)   │
              │  ── on success: write temp file        │
              └─────────────┬───────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────────────────┐
              │  EXIF date extraction (images only)      │
              │  ── exiftool -DateTimeOriginal           │
              │  ── falls back to moment_date           │
              └─────────────┬───────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────────────────┐
              │  Final filename + atomic move           │
              │  ── YYYY-MM-DD_(image|video)_NNNNNN.ext │
              │  ── compute sha256                      │
              │  ── append entry to manifest            │
              │  ── saveManifest (atomic temp+rename)   │
              └─────────────┬───────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────────────────┐
              │  sleep(rateMs)  // default 5000ms       │
              └──────────────────────────────────────────┘
```

## Data flow — video upgrade phase

```
                            ┌────────────────────────────────────────┐
                            │  Read manifest.json                    │
                            │  ── filter videos with orig_filesize > │
                            │     bytes (skip already-original ones) │
                            └─────────────┬──────────────────────────┘
                                          │
                                          ▼
                            ┌────────────────────────────────────────┐
                            │  Phase 1: For each UID                 │
                            │    downloadDetails(uid, 8-pos true)    │
                            │    Range GET 0-1 on presigned URL      │
                            │      → 206: thawed, ready to download  │
                            │      → 403: frozen, needs unfreeze     │
                            └─────────────┬──────────────────────────┘
                                          │
                                          ▼
                            ┌────────────────────────────────────────┐
                            │  Phase 2: Batched unfreezeMoments      │
                            │    one POST with all frozen UIDs in    │
                            │    a single params[1] array            │
                            └─────────────┬──────────────────────────┘
                                          │
                                          ▼
                            ┌────────────────────────────────────────┐
                            │  Phase 3: Poll until thawed (--watch)  │
                            │    every 60s, re-call downloadDetails  │
                            │    re-Range-check                       │
                            │    (presigned URLs expire in 30 min!)  │
                            └─────────────┬──────────────────────────┘
                                          │
                                          ▼
                            ┌────────────────────────────────────────┐
                            │  Phase 4: Download                     │
                            │    re-fetch fresh URL just before GET  │
                            │    stream to <uid>_original_TEMP.<ext> │
                            │    compute sha256 in same pass         │
                            └─────────────┬──────────────────────────┘
                                          │
                                          ▼
                            ┌────────────────────────────────────────┐
                            │  Verify 3 checks:                      │
                            │    size ≈ orig_filesize ±0.1%          │
                            │    sha256 != manifest.sha256            │
                            │    fileName == manifest.orig_filename  │
                            └─────────────┬──────────────────────────┘
                                          │
                                          ▼
                            ┌────────────────────────────────────────┐
                            │  --commit mode only:                   │
                            │    rename medium → .medium.bak         │
                            │    rename temp → library path          │
                            │    update manifest (quality=original)  │
                            │    delete .medium.bak                  │
                            │    atomic manifest save                │
                            └────────────────────────────────────────┘
```

## Resilience design

### Atomic manifest writes

```js
fs.writeFileSync(MANIFEST_PATH + '.tmp', JSON.stringify(manifest));
fs.renameSync(MANIFEST_PATH + '.tmp', MANIFEST_PATH);
```

On Windows the rename is *not* atomic in the POSIX sense, but it's close enough — if the process is killed between `writeFileSync` and `renameSync`, the next run finds `.tmp` and recovers from it (see `loadManifest()`).

### `renameWithRetry` for EPERM

Windows raises `EPERM`/`EACCES`/`EBUSY` if another process has any handle open on the destination file. The dashboard reading `manifest.json` every 5s can trigger this. We retry 10 times with exponential backoff (30, 80, 130, ... ms — up to ~3s total). In practice, the dashboard releases its handle within 100-200ms so most retries succeed on the second attempt.

### `APIResponse.dispose()`

Playwright's HTTP client retains the response body buffer until `dispose()` is explicitly called, even after `body()`/`text()` consumes it. Without dispose, the downloader leaks ~600 MB/hour. Every API call site in this repo calls `await r.dispose()` immediately after consuming the body.

### JWT refresh on 401

The JWT lives ~4 hours. Long downloads need refresh:

```js
const refreshSession = async () => {
  state.jwt = null;
  await page.goto('https://photos3.shutterfly.com/library?_refresh=' + Date.now());
  // request listener auto-updates state.jwt when the SPA fires its next RPC
  const start = Date.now();
  while (!state.jwt && Date.now() - start < 30000) await sleep(500);
};
```

On `401 Unauthorized`, retry the same item without incrementing the attempt counter.

### Per-item retries

Three attempts with exponential backoff: 1s, 4s, 16s. After the third failure, log to `errors.log` and continue. `--resume` retries them on the next invocation.

### Throttling

`--rate-ms` (default 5000) between items. This is the single most effective lever against rate-limiting. We've successfully sustained this rate for 50+ hours straight.

## Why Playwright?

Three alternatives we considered:

| Option | Verdict |
|---|---|
| Pure `fetch` with hard-coded JWT | JWT expires every 4 hours. Re-doing manual login that often is unbearable for multi-day runs. |
| Selenium / Puppeteer | Playwright has the cleanest `context.request` API for hybrid browser-context-aware-HTTP calls; persistent contexts are first-class; storageState dump-and-restore is built in. |
| Reverse-engineer the Cognito login flow | Would require maintaining a working token-refresh implementation including handling 2FA challenges that change without notice. Not worth it. |

Playwright's value is *credential management*, not browser automation. The actual data fetches go through Playwright's HTTP client (which inherits the cookies), not the browser. So we get long-lived sessions with minimal browser overhead.

## File layout in a working repo

```
.
├── auth.json                ← gitignored, written by manual_login.js (sole auth source)
├── .env.local               ← gitignored, your credentials
├── downloads/
│   ├── manifest.json        ← source of truth for what's been downloaded
│   ├── metadata.json        ← persistent cache of getMomentSet results
│   ├── errors.log           ← failed items, retryable with --resume
│   ├── video_upgrades.jsonl ← upgrade audit log (created by upgrade.js)
│   ├── 2024-08-15_image_001234.jpg
│   ├── 2024-08-15_image_001234.jpg.medium.bak  ← transient during commit
│   ├── 2023-07-20_video_000078.mov
│   └── ...
├── test/upgrade_test/       ← test-mode upgrade downloads, never touched in commit mode
├── downloader.js
├── upgrade.js
├── manual_login.js
└── scripts/
    └── status.ps1
```

## See also

- [`AUTHENTICATION.md`](AUTHENTICATION.md) — JWT sniffing and session refresh deep dive
- [`UID_DISCOVERY.md`](UID_DISCOVERY.md) — `getPaginatedMoments` walk + `getMomentSet` enrichment
- [`MEDIA_UPGRADE.md`](MEDIA_UPGRADE.md) — the 8-position params discovery story
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — common errors and recovery
