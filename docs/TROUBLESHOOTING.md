# Troubleshooting

Common errors and how to recover.

## Authentication failures

### `Failed to sniff JWT / X-API-Key from live traffic`

Your Shutterfly session has expired. Cookies live ~30 days; if you've been away, they're gone.

**Fix:** Re-run the one-time login.

```bash
node manual_login.js
```

If the login window opens but immediately closes, your `auth.json` may be corrupt. Delete it and re-run:

```bash
rm -f auth.json
node manual_login.js
```

### `Browser redirected away from /library (URL=https://accounts.shutterfly.com/...)`

The login process started but didn't complete. Possible reasons:

- 2FA challenge wasn't completed within 15 minutes
- Shutterfly flagged your account for "suspicious activity" — log in via the web UI, complete any verification prompts, then re-run `manual_login.js`
- Wrong email/password in `.env.local`

### `401 RaiseFault.MissingToken`

You're calling a Shutterfly RPC without sending the JWT in `params[0]` of the body. Authorization header alone is not enough. Check that the body shape matches:

```json
{ "params": ["<JWT>", ...], ... }
```

### `401 RaiseFault.InvalidToken` mid-run

JWT expired during a long-running download. The downloader handles this automatically via `refreshSession()` (re-navigates the browser to trigger a fresh JWT). If you see this in the upgrade script, the auth.json may be stale — re-run manual_login.js.

## Download issues

### `downloadDetails failed: status=...`

Most common causes:

- **Rate limit (HTTP 429)**: pause for 30 minutes, then resume with `--resume`. Increase `--rate-ms` to a more generous value (e.g. 10000).
- **Shutterfly returned 500/502/503**: transient backend error. The script auto-retries 3× with exponential backoff. If it gives up, the failed UIDs are in `errors.log` and retried on `--resume`.

### Photo `0 bytes` returned

Occasionally Shutterfly's CDN returns 200 OK with an empty body. The downloader treats this as a failure (per the `bytes === 0` check) and retries. If it persists for the same UID, that file may be corrupted server-side — log to `errors.log` and skip.

### `EPERM: operation not permitted, rename` on Windows

Another process (Windows Defender, file indexer, the status dashboard) has a handle open on the destination file. `renameWithRetry()` handles this with backoff; if you see EPERM after 10 retries, close the dashboard and any antivirus scans, then `--resume`.

### `ENOSPC: no space left on device`

Free up disk space. Then `--resume` — the manifest tracks what's already done.

## Upgrade issues

### All UIDs show `frozen` and never thaw

Glacier Standard tier is 3-5 hours. Some files take longer (12+ hours in pathological cases). Check:

1. Was `unfreezeMoments` actually called? The script should print `unfreezeMoments status=200 success=true` once per batch.
2. Run with `--watch` to poll automatically, OR re-run periodically (every hour) — re-issuing `unfreezeMoments` on an already-thawing UID is idempotent.
3. If the script reports `unfreezeMoments status=200 success=false`, examine `result.errors` in the JSONL log. You may have hit a per-account daily quota.

### Range GET returns 200 OK with HTML instead of file bytes

The presigned URL has expired (S3 presigned URLs default to 30 min TTL). The script always re-fetches the URL right before downloading; if you see this, it's a bug — file an issue with the JSONL log.

### Verification fails: `size_within_0.1pct_of_orig_filesize`

The downloaded file's size doesn't match what Shutterfly's manifest claims. Two scenarios:

- **`downloaded_bytes` is much smaller than `orig_filesize`**: you got the medium tier somehow. Check that `upgrade.js` is sending the 8-position params with `true` at index 7.
- **`downloaded_bytes` is close to but not exactly `orig_filesize`**: the file might still be in restoration. Re-run and re-download.

### Verification fails: `sha256_differs_from_medium`

Means the new download has the SAME hash as the medium version. Shutterfly served you the medium instead of the original. Same fix as above — check the params shape.

### Verification fails: `filename_matches_original_filename`

The current `upgrade.js` strips extensions before comparing filenames, so the common "manifest has UUID without `.mp4`, payload has UUID with `.mp4`" mismatch is **handled automatically**. If you still see this check fail:

1. Look at the full `payload` and `manifest` values in the JSONL `verification_failed` event
2. If the BASENAMES differ (different identifiers, not just extensions), it's a real asset mismatch — likely a Shutterfly UID reassignment. Don't auto-swap; manually inspect both files (`./downloads/<existing>` and `./test/upgrade_test/<uid>_original.<ext>`) and decide.

### A specific UID fails verification on every run (permanent skip)

After your first full upgrade run, you may find ~0.01-0.1% of UIDs that always fail the size check across multiple retries:

```
size_within_0.1pct_of_orig_filesize: FAILED — 3935278050 / 2331301547 = 1.688
sha256_differs_from_medium: PASSED
filename_matches_original_filename: PASSED
```

This means: hash and filename confirm it's the right asset, but the delivered file is significantly larger (or smaller) than what the manifest claims `orig_filesize` should be. Likely causes:

- The manifest's `orig_filesize` was wrong at bulk-download time (Shutterfly served us a stale value)
- The user uploaded a higher-quality version of the same item after the original bulk download

Either way, the script will keep re-selecting this UID every run and the verification gate will keep refusing to overwrite the existing file. **This is the safe behavior.** Options:

1. **Accept it.** The medium copy stays in place. The audit log records the attempt every run.
2. **Fix the manifest** by editing `orig_filesize` to match the delivered size for that specific UID, then re-run.
3. **Skip it explicitly** via `--uids` listing the UIDs you DO want to attempt.

## Process killed mid-run (Windows Update, RDP disconnect, etc.)

On Windows servers and workstations, the upgrade.js process can be killed externally by:

- **Windows Update** auto-restart for security patches
- **RDP / DCV session disconnect** if the process was launched from that session
- **OS-initiated shutdowns** (power-saver wake/sleep, scheduled tasks)

Signs of this: process exits cleanly, no stderr output, no crash event in the JSONL log, log file's last line is a normal heartbeat or commit.

### Recovery procedure

The manifest is checkpointed every 25 commits via atomic `manifest.json.tmp` + rename. To resume:

1. **Rotate the dead-run's logs** so the new run starts fresh:
   ```powershell
   Move-Item .\downloads\upgrade.log .\downloads\upgrade.log.run1.bak
   Move-Item .\downloads\upgrade.err .\downloads\upgrade.err.run1.bak  # if it exists
   ```
   (Subsequent restarts → `.run2.bak`, `.run3.bak`, etc.)

2. **Re-launch with the same flags**. Phase 1 of `upgrade.js` reads the manifest and automatically excludes UIDs already marked `quality: 'original'`, so completed work is preserved. The script will select only the remaining UIDs.

3. **Glacier retention helps you here.** AWS keeps restored objects warm for 24 hours after thaw completion. If you restart within that window, most UIDs you previously thawed are still ready — Phase 2's re-unfreeze is idempotent (Glacier silently ignores requests for already-restored objects). Some bandwidth/time is wasted on the re-unfreeze API calls (~13 min for 4,300 UIDs), but no Glacier cost is re-incurred.

4. **Manifest is durable.** Even a hard kill (Task Manager → End Task) loses at most the in-flight 25 commits since the last checkpoint — those will be redone. Files that committed before the last checkpoint stay committed.

### Upgrade run stuck on the Glacier slow tail

The most common late-run state: producer is making API calls at full throttle, but every poll returns 403 (still cold). Run shows `committed` stuck at the same number for hours while `thawing` doesn't decrease.

This is not a bug — AWS Glacier "Standard" tier promises 3-5h **median** retrieval, but the slowest few percent of objects can take 6-12+ hours. If you have ~100 UIDs in this state, they may finish on their own before max-wait, or they may not.

**Three options for recovery:**

#### Option A — Wait it out
Let the run hit its `--max-wait` ceiling. Clean self-exit. Most stragglers should finish within 8h.

#### Option B — Kill the stuck run and start a fresh one (catches "warm pool" leftovers)
If you've had multiple runs already, UIDs that were unfrozen in a *previous* run may still be in Glacier's 24h retention window. Killing the stuck run and starting a fresh one re-selects pending UIDs and starts polling from scratch — catching any that are still warm from earlier unfreezes.

```powershell
# Kill the stuck process
Stop-Process -Id <PID> -Force

# Rotate logs
Move-Item .\downloads\upgrade.log .\downloads\upgrade.log.runN.bak

# Start fresh with a shorter max-wait (warm UIDs only)
node upgrade.js --limit 5000 --commit --watch --skip-status-check --max-wait 240
```

In a real run, this rescued ~37 additional commits in 14 minutes after a previous run had been stuck for 5+ hours.

#### Option C — One-shot "scan and grab" (no waiting, no new unfreeze)
Use `scan_and_grab.js` to do exactly one pass: probe every pending UID, download anything that's already thawed, skip cold ones, exit.

```powershell
node scan_and_grab.js --commit
```

Useful when you want to know "what's available RIGHT NOW" without committing to a multi-hour run. The script does NOT trigger unfreezeMoments — it only retrieves what's already warm. Cold UIDs are simply skipped and need a separate `--unfreeze-only` to start their Glacier restore.

Typical flow:
1. Bulk run stalls in the slow tail
2. `node scan_and_grab.js --commit` — grabs any warm leftovers in ~5-15 min (much faster than upgrade.js's full polling cycle)
3. If many UIDs remain cold: `node upgrade.js --commit --unfreeze-only --skip-status-check` before bed
4. Next morning: `node upgrade.js --commit --watch --skip-status-check --max-wait 240` to download the fresh thaws

### Preventing future Windows kills

For long unattended runs on Windows, consider:

- **Disable automatic restart for updates** in your active hours (Settings → Windows Update → Active hours)
- **Launch via Task Scheduler** with "Run whether user is logged on or not" — survives RDP disconnect
- **Use `nssm`** ([nssm.cc](https://nssm.cc/)) to install upgrade.js as a Windows service for true session-independence
- **Run on a Linux box if available** — no Windows Update surprises

## Resume behavior

### `downloader.js` won't resume cleanly

```
[downloader] WARNING: existing manifest with N entries at ... . Use --resume to add to it; otherwise delete the dir.
```

The downloader refuses to overwrite an existing manifest without explicit consent. Either pass `--resume` (to append) or delete `./downloads/manifest.json` (to start over).

### `upgrade.js` already-downloaded files

`upgrade.js` doesn't have a built-in skip for already-downloaded files in test mode. If you re-run with the same UIDs, it re-downloads. This is fine in `--commit` mode (idempotent, file gets swapped each time) but wastes bandwidth in test mode. Either:

- Edit your `--uids` list to remove already-completed UIDs
- Add resume logic (PR welcome)

## Diagnostics

### `node downloader.js --help` shows nothing

The downloader exits silently if invoked with no args because it has sensible defaults. Add `--help`:

```bash
node downloader.js --help
```

If you still see nothing, you're not running Node 18+. Check `node --version`.

### The status dashboard is empty

`scripts/status.ps1` reads from `./downloads/manifest.json`, `./downloader.pid`, and `./downloader.log`. If any are missing:

- `manifest.json` — downloader hasn't completed its first download yet, or `--out` points somewhere else
- `downloader.pid` — you didn't write the PID at startup. Add `(echo $$ > downloader.pid)` to your launch script.
- `downloader.log` — you redirected output elsewhere. Adjust BASE in status.ps1 to match.

### Where do I see the upgrade audit trail?

Per-event log: `./downloads/video_upgrades.jsonl` (commit mode) or `./test/upgrade_test/video_upgrades.jsonl` (test mode).

```bash
# Last 20 events
tail -20 ./downloads/video_upgrades.jsonl

# Count events by type
jq -r '.event' ./downloads/video_upgrades.jsonl | sort | uniq -c
```

## Google Drive / Google Photos sync errors

If you're syncing `downloads/` via Google Drive for Desktop (so the library auto-mirrors into Google Photos), you may see two error categories in the Drive tray icon's "Activity" panel.

### `PHOTOS_FILE_TOO_SMALL` / "Some files are too small"

Google Photos rejects any image whose **shorter dimension is under 256 pixels**. The check is purely numeric — Google parses the JPEG SOF marker before doing anything else, so byte-padding (huge EXIF blocks, appended zeros) does not bypass it. Source: [Google Drive Help: Fix problems in Drive for desktop](https://support.google.com/drive/answer/2565956).

Shutterfly's compressed display tier is 150-300 px on the long edge, so any photo we couldn't upgrade past the medium tier will trigger this. The fix is to upscale past 256 px on both axes; bicubic/Lanczos is sufficient (the check is dimensional, not perceptual). EXIF must be carried over or Google Photos will bucket the upload under today's date.

`scripts/upscale_too_small.ps1` automates the whole flow:

```powershell
# Discover rejected files by parsing Drive's local logs
.\scripts\upscale_too_small.ps1 -Mode discover

# Dry run -- writes upscaled copies to downloads\.upscale_staging\
.\scripts\upscale_too_small.ps1 -Mode fix

# Commit -- backs originals up to downloads\.upscale_backups\ and replaces in place
.\scripts\upscale_too_small.ps1 -Mode fix -Commit
```

The script defaults to width=1000 (aspect preserved), Lanczos resampling, JPEG quality 90, and falls back to filename-derived `DateTimeOriginal` when the file's EXIF is empty (most Shutterfly compressed JPGs have no date tag).

After the script runs, Drive auto-retries on its next scan cycle — no UI action needed. Verify with `exiftool -ImageWidth -ImageHeight -DateTimeOriginal <file.jpg>` on a sample.

### `EXCEEDS_CLOUD_UPLOAD_QUOTA` / "Some files exceed the daily upload limit for Google Photos"

Different error, separate cause: Google Photos enforces a per-account **daily upload quota** (currently ~75 GB). A large bulk-upgrade run will exceed it. Drive **auto-retries the next day** — no action needed. Visible in the error list but cosmetic; the queue drains itself over multiple days.

### In-flight `_original_TEMP*` files appearing in Photos with garbage names

If you ran `upgrade.js` from a version *before* the `.partial` suffix fix, Google Drive's media slurper may have caught some videos mid-rename and uploaded them to Photos under their internal Shutterfly UIDs (no date prefix). Symptoms:

- Photos library contains items like `20003729960_original_TEMP.mov`
- They're dated "today" instead of their actual capture date
- Drive's error list shows zero-byte `_TEMP.mov` files that "are too small"

The current `upgrade.js` writes in-flight downloads with a `.partial` extension so Drive's media recognizer ignores them until the atomic rename swaps in the final filename. If you have stragglers from an older run, find them in Google Photos by searching for `_TEMP` and either delete (re-upload will happen with the proper filename on next sync) or rename in-place via the Photos UI. The zero-byte error list entries in Drive's tray clear automatically once the files no longer exist on disk.

## When you've truly broken something

Nuclear options, in increasing severity:

1. **Lost session, can't sniff JWT**: `rm auth.json; node manual_login.js`
2. **Manifest corrupted (parseable but wrong data)**: restore from `manifest.json.tmp` if it exists; otherwise the manifest is the source of truth and you may need to re-download anything missing.
3. **Persistent userdata corrupt**: `rm -rf userdata; node manual_login.js`
4. **Want to start completely over**: `rm -rf downloads userdata auth.json node_modules; npm install; node manual_login.js; node downloader.js`

Files in your filesystem (the downloaded photos themselves) are NOT touched by any of this — only the metadata/auth state files. Your library is safe.
