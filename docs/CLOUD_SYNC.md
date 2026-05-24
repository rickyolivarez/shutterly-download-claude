# Cloud sync after upgrading

Cloud sync is **entirely optional**. The tool works perfectly standalone — your library lives on local disk and you can leave it there. This doc only matters if you want a cloud backup of the result.

## TL;DR — point Google Drive at the folder, NOT Google Photos

If you want a cloud backup, the **strongly recommended workflow** is:

1. Install **Drive for Desktop** ([drive.google.com/drive/download](https://www.google.com/drive/download/))
2. Configure it to **mirror** (NOT stream) your `./downloads/` folder
3. Let it sync

That's it. Drive for Desktop handles file replacements correctly — when `upgrade.js` swaps a medium video for an original, Drive pushes the new bytes as a new revision of the same file. The shareable link doesn't change.

**Do NOT** point Google Photos backup at the same folder. Google Photos is append-only — every replaced file becomes a duplicate library item, and you'll end up with thousands of duplicates after the upgrade. There is no "update photo" API in Google Photos. Use Drive, not Photos, even if Photos is what you eventually want to view in.

## If you actually want photos in Google Photos

There is no clean way. You have two options, both involving cleanup:

- **Option A (recommended)**: Sync to Drive only (per above). View / share / organize from Drive. Skip Google Photos entirely.
- **Option B (if you must use Photos)**: First delete the existing Google Photos library entries for the files you're replacing (via [photos.google.com](https://photos.google.com)), THEN upload the upgraded files fresh. Bulk-delete is slow and painful for >500 items. Trash auto-empties in 60 days, so the deletion IS reversible briefly.

---

If your goal is to get your **upgraded** original-quality videos into a cloud backup (Google Drive, Google Photos, iCloud, Dropbox, OneDrive, etc.), the answer is not the same for every service. Some handle "replace in place" cleanly; others treat the replacement as a new file and you end up with duplicates.

This document covers what we've verified.

## Google Drive (Drive for Desktop, "mirror" mode) ✅ Works

When `upgrade.js` overwrites a medium-quality file in your `./downloads/` folder with the original-quality version (same filename, same path, different content/size/hash), Google Drive handles it correctly.

| Question | Answer |
|---|---|
| Detects the local file changed? | **Yes** — Drive for Desktop watches mtime/size/checksum |
| Replaces the cloud file? | **Yes** — pushes a new revision of the same Drive item |
| File ID stays the same? | **Yes** — shareable links and folder structure preserved |
| Old version kept anywhere? | Yes, briefly — Drive keeps non-Google file revisions for **30 days OR until 100 newer revisions**, then auto-purges |
| Quota impact | Only the **current** revision counts. Auto-purgeable older revisions are FREE (don't count toward quota). Revisions marked "Keep forever" DO count. |
| What if the new file is 10× bigger? | Drive uses ~10× more quota. Budget accordingly. |

### Workflow

1. Run `upgrade.js --commit` until done. Files in `./downloads/` are now originals.
2. Drive for Desktop's next sync (within ~minutes if running) pushes the new bytes as a revision.
3. Verify in [drive.google.com](https://drive.google.com) — file size in the UI updates to the new (larger) value.
4. The previous medium-tier revision is retrievable via "Manage versions" for 30 days; after that it's gone.

### Budget check before starting

Total upgraded size is roughly **10× the medium-tier size** on average, but ratios vary widely. From our production run:
- Medium tier: ~40 GB (4,284 videos)
- Originals: ~400 GB
- 5-150× per file, occasionally 1000×

For a typical Shutterfly library with 4,000-5,000 videos, expect **~400 GB to 1.3 TB** of additional Drive storage needed. Google One 200 GB plan: insufficient. **2 TB plan: sufficient** for most personal libraries. Check your current Drive usage at [one.google.com](https://one.google.com) before kicking off the upgrade.

### Source documentation

- [Check activity & file versions](https://support.google.com/drive/answer/2409045) — Google Drive Help
- [Manage file revisions](https://developers.google.com/workspace/drive/api/guides/manage-revisions) — Google Drive API
- [Stream & mirror files with Drive for desktop](https://support.google.com/drive/answer/13401938)

## Google Photos ❌ Does NOT support replace-in-place

Google Photos is **append-only by design**. There is no concept of "updating" an existing library item with new content. If you sync a folder configured as a Photos backup folder AND the files in it change, Photos uploads them as **new separate items** alongside the existing ones.

| Question | Answer |
|---|---|
| Detects "new version" of an already-uploaded video? | **No** — Photos has no update-in-place API |
| Skips as a duplicate? | Usually **no** for videos — the recompressed/transcoded file has a different content hash than the original it dedupes against |
| Uploads as a 2nd item? | **Yes** — both the old (medium) and new (original) end up in your library |
| Old item auto-deleted? | **No** — you must manually delete it |
| API or desktop sync to "replace"? | **None exists** |

### Workflow (the only one that works)

If you want your Google Photos library to actually hold the originals:

1. **Switch backup quality to "Original quality"** at [photos.google.com](https://photos.google.com) settings — otherwise the upload is re-compressed on ingest, wasting bandwidth and not actually improving cloud quality.
2. **Download a Google Takeout archive** of your current Photos library (optional safety net — Trash only retains 60 days).
3. **Bulk-delete the existing video items** from your library (web UI: filter by `type:video`, then select-all-delete; trash auto-empties in 60 days).
4. **Upload the upgraded originals fresh** via drag-and-drop at [photos.google.com](https://photos.google.com), or by configuring Drive for Desktop's "Google Photos folder" mode pointing at `./downloads/`.
5. **EXIF dates carry over** — uploaded items will sort to their true capture date in the timeline, NOT as "uploaded today."

### Gotchas

- **Storage Saver setting**: even if you upload originals, Photos re-compresses them on ingest under this setting (videos > 1080p downscaled, bitrate reduced). The cloud copy will NOT be your local original. Must be set to "Original quality" before uploading.
- **Don't double-configure**: a single folder set as BOTH a Drive sync folder AND a Photos backup folder doubles your quota usage and creates two upload paths fighting each other. Pick one.
- **Photos web UI is slow at bulk deletes** above ~500 items. Use the keyboard `Shift+Click` range select and process in batches. Or use the third-party `googlephotos-bulk-delete` browser extensions at your own risk.

### Source documentation

- [Choose backup quality](https://support.google.com/photos/answer/6220791) — Google Photos Help
- [Google Photos duplicating during upload (community)](https://support.google.com/photos/thread/128684839)
- [Replace High Quality with Original Quality (community)](https://support.google.com/photos/thread/922080)

## Other services (not verified)

| Service | Expected behavior | Verified? |
|---|---|---|
| **Dropbox** | Replace-in-place works; old versions kept 30 days (free) / 180 days (Plus) | Not tested with this tool |
| **OneDrive** | Replace-in-place works; version history kept 30 days | Not tested |
| **iCloud Drive** | Replace-in-place works; version history kept ~30 days | Not tested |
| **iCloud Photos** | No replace-in-place (similar to Google Photos) | Not tested |
| **Backblaze B2 + Restic/rclone** | Replace-in-place works; configurable retention | Not tested but expected to work |

If you use a service not on this list and verify the behavior, a PR to update this doc is welcome.

## Recommendations

- **If your only target is Google Drive**: run `upgrade.js --commit` and let Drive for Desktop sync. Zero additional work. Verify Google One quota first.
- **If your target is Google Photos**: do the delete-then-upload workflow described above. Don't rely on sync to "update" existing items — it won't, and you'll waste storage on duplicates.
- **If your target is both**: keep them in separate folders. One is your Drive sync source, one is your Photos upload source. Otherwise you'll fight quota wars and duplicate items.
- **If you're worried about losing the medium copies**: the upgrade script keeps a `.medium.bak` only momentarily during the swap, then deletes it. If you want a long-term archive of the mediums, copy `./downloads/` to a backup location BEFORE running `upgrade.js --commit`.

## Drive sync errors you may see

If you sync `downloads/` to Drive (mirror mode), Drive's slurp will surface a couple of error categories in its activity panel:

- **"Some files are too small"** — Google Photos rejects images shorter than 256 px on either axis. Affects ~30-100 of the Shutterfly compressed-display JPGs we couldn't upgrade past the medium tier. Fix: `scripts\upscale_too_small.ps1`. See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md#google-drive--google-photos-sync-errors) for the full workflow.
- **"Some files exceed the daily upload limit for Google Photos"** — Photos' daily upload quota (~75 GB). Drive auto-retries next day; cosmetic only.
- **In-flight `_TEMP` videos in Photos** — bug in `upgrade.js` versions before the `.partial`-suffix fix. Current code prevents it; see TROUBLESHOOTING for cleanup if you're hit by stragglers.

## See also

- [`MEDIA_UPGRADE.md`](MEDIA_UPGRADE.md) — what `upgrade.js` actually does on disk, and the photo-quality reality (HEIC is full quality, JPG is compressed)
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — recovering from a partial run
