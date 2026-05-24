# Media Upgrade — Videos and Photos

This doc covers what `upgrade.js` does for videos (the working Glacier bypass) **and** what we learned about photos (a different story — they have a similar archive tier, but no programmatic retrieval path exists).

If you only want the headline: **videos can be fully upgraded in ~5-7 hours via the bypass; photo originals are gated behind a multi-day email flow we cannot automate.** See the [Photos section](#photos-the-unbypassable-story) below for full details on the photo case.

This document is part technical reference, part research diary — the path to the discovery is instructive.

## The problem we set out to solve

Bulk download via `downloader.js` retrieves what Shutterfly's web "Download" button delivers — which is **NOT the original** in most cases:

- **For videos**: a heavily compressed transcoded version — typically **5-150× smaller** than the original.
- **For most JPEG photos**: a compressed display tier — typically **5-20× smaller** than the original.
- **For HEIC photos**: a full-resolution JPEG transcode — effectively the original at higher byte size (since JPEG is less efficient than HEIC).

This doc covers the video bypass that recovers originals in the first case, and what we discovered about the photo case.

Empirically, on a 4,438-video library:
- Average compression: ~5×
- Extreme cases: 159× (a 488 KB delivered file whose original is 74 MB)
- Total "missing" original data: ~400 GB out of ~510 GB

Shutterfly's web UI has a "Request original" button that emails you a download link 3-5 hours later. Doing this manually for 4,400 videos = 4,400 clicks + 4,400 emails to check + 4,400 manual downloads. Not realistic.

## The Glacier hypothesis (and its confirmation)

After observing the ~3 hour delay between requesting and emails arriving, we hypothesized:

> Original video files live in AWS Glacier cold storage. The "Request original" button triggers a Glacier restore operation. The email is a notification when restore completes.

This explains:
- The RPC name `moment.unfreezeMoments` (literally "thaw the originals")
- The 3-5 hour delay (matches AWS Glacier "Standard" retrieval tier SLA)
- Why originals aren't always available — Shutterfly pays per-GB-month for Glacier
- Why the URL the email points to is in a *different* S3 bucket (`prod-tl-video-source` vs the medium bucket `prod-tl-m-17`)

We confirmed this with experiment D10 (see below): files we'd already thawed return 206 Partial Content from a Range GET; files we've never touched return 403 Forbidden — the classic AWS S3 response when the underlying object is in Glacier without an active restore.

## The discovery sequence

Ten diagnostic experiments led to the working bypass. Summarized:

| ID | Question | Result |
|---|---|---|
| D2 | Does `moment.downloadDetails` return original after `unfreezeMoments`? | No, always medium tier |
| D5 | Is there a magic param/method/header we haven't tried? (40 variations) | All return medium |
| D1 | What does the working UI flow actually call? | HAR capture of clicking the email's Download button → modal → "Download" button |
| D6 | Is it the Content-Type? Accept header? Referer? | None of them — all return medium |
| D7 | Does visiting `/video_download/<uid>` change session state? | Cookies update but direct API calls still return medium |
| **D8** | **What if the params array has 8 positions instead of 3?** | **🎯 BREAKTHROUGH — 8th position `true` = original** |
| D9 | Does this work for any UID, or only thawed ones? | Works for any UID — but the returned URL only delivers bytes if the UID is thawed |
| D10 | Range-fetch the URLs: do they actually serve bytes? | 206 for thawed UIDs, 403 for cold ones — confirming Glacier hypothesis |

## The discovery: 8-position params

The Shutterfly SPA's button click for "Download original" fires `moment.downloadDetails` with a params array of **8 positions**. Earlier reverse-engineering efforts (and our own initial scripts) used 2 positions:

```js
// Returns MEDIUM tier:
params: [jwt, uid]

// Returns ORIGINAL tier:
params: [jwt, uid, null, null, null, null, null, true]
//                                                ^^^^
//                                          THE FLAG
```

Putting `true` at index 2 doesn't work — Shutterfly's server only honors the boolean at position 7. We don't know what positions 2-6 are for. They're probably reserved for features that have been removed or were never shipped. The server treats them as ignored when null.

This single discovery collapses the entire upgrade pipeline from "Playwright + Gmail OAuth + UI automation + 14-21 days of work" to "two API calls per UID."

## Throttling and parallelism (production defaults)

The bulk pipeline applies these constraints, all configurable via CLI flags:

| Concern | Default | Flag |
|---|---|---|
| Min interval between Shutterfly API calls | 4,500 ms | `--api-rate-ms` |
| Max parallel S3 file downloads | 5 | `--download-concurrency` |
| UIDs per `unfreezeMoments` batched call | 25 | `--unfreeze-batch-size` |
| Status heartbeat line interval | 5 s | `--heartbeat-secs` |
| Skip the per-UID Phase 1 status check | off | `--skip-status-check` |
| Max wall-clock wait for Glacier | 480 min (8 h) | `--max-wait` |

The rate limit applies ONLY to the `photos-api3.shutterfly.com` endpoints (`downloadDetails` and `unfreezeMoments`). S3 calls (Range checks, file downloads) are deliberately NOT throttled — they go to AWS, not Shutterfly's API gateway, and benefit from parallelism.

The 4.5s default is empirically safe — it matches the original mass-download pace which ran 52 hours without a single rate-limit incident.

## The complete recipe

### Step 1: Trigger Glacier restore

```http
POST https://photos-api3.shutterfly.com/photos/json?method=moment.unfreezeMoments HTTP/1.1
Authorization: Bearer <JWT>
X-API-Key: <api-key>
Content-Type: application/json

{
  "method": "moment.unfreezeMoments",
  "params": ["<JWT>", ["uid1", "uid2", "uid3", ...]],
  "headers": { "X-SFLY-SubSource": "library" },
  "id": null
}
```

Response:

```json
{
  "result": {
    "_explicitType": "ResponseWrapper",
    "success": true,
    "errors": null,
    "message": "Success.",
    "payload": null
  },
  "id": "",
  "error": null
}
```

The `payload: null` means Shutterfly doesn't return a tracking ID. The UIDs themselves are the only join key. (This is why we don't need Gmail OAuth — we know which UIDs we asked for.)

Batch size: a production run batched 25 UIDs/call across 172 calls (4,300 UIDs total) with no failures. The `upgrade.js` default `--unfreeze-batch-size` is 25.

### Step 2: Probe thaw status

```http
POST https://photos-api3.shutterfly.com/photos/json?method=moment.downloadDetails HTTP/1.1
[same auth headers]

{
  "method": "moment.downloadDetails",
  "params": ["<JWT>", "<uid>", null, null, null, null, null, true],
  "headers": { "X-SFLY-SubSource": "library" },
  "id": null
}
```

Response:

```json
{
  "result": {
    "payload": {
      "momentType": "video",
      "contentType": "video/quicktime",
      "fileName": "FullSizeRender.mov",
      "fileSize": 5235232,
      "sha1": "...",
      "momentId": "1773638306792092",
      "url": "https://prod-tl-video-source.s3.amazonaws.com/.../FullSizeRender.mov?X-Amz-Signature=...",
      "s2sEnabled": true
    }
  }
}
```

Note the bucket: `prod-tl-video-source`. That's the originals bucket. If you remove the `true` at position 7, the same call returns a URL pointing at `prod-tl-m-17` (the medium bucket).

### Step 3: Range-check the presigned URL

```http
GET <presigned_url> HTTP/1.1
Range: bytes=0-1
```

Two outcomes:

- **`HTTP 206 Partial Content`** + `Content-Range: bytes 0-1/5235232` → object is restored and downloadable. The total size in the header confirms it matches `orig_filesize`.
- **`HTTP 403 Forbidden`** + XML error body → object is in Glacier. Wait and re-check (~3 hours).

You can use this as the polling mechanism instead of waiting for emails. Polling every 60 seconds with a 1-byte Range GET costs essentially nothing (no body transfer, no Shutterfly RPC).

### Step 4: Stream-download

Just GET the URL with no Range header. Shutterfly presigned URLs allow direct GETs (no auth headers needed since the URL is pre-signed).

```js
https.get(presignedUrl, res => {
  res.pipe(fs.createWriteStream(destPath));
});
```

Observed speeds: 34-94 MB/s. The full bulk run of 4,400 videos (~400 GB) downloads in ~1-2 hours once everything is thawed.

### Step 5: Verify

Three checks before the upgrade is considered valid:

| Check | Test |
|---|---|
| Size | `downloaded_bytes` ≈ `manifest.orig_filesize` ±0.1% |
| Hash | `sha256(downloaded) !== manifest.sha256` (proves it isn't the same medium re-served) |
| Filename | basename(`payload.fileName`) === basename(`manifest.original_filename`) (extensions ignored — see below) |

### Filename verification: extension mismatch (lesson learned)

In our production run, ~9% of UIDs failed the filename check with an exact string compare. Looking at the events:

```
payload:  7938e072-ec67-48f8-afa8-4d16aa7b0a99.mp4
manifest: 7938e072-ec67-48f8-afa8-4d16aa7b0a99
                                              ^^^^
                                       Extension differs
```

The manifest stored some UUID-format `original_filename` values without an extension (a quirk of how Shutterfly populated the field at upload time), while `moment.downloadDetails` always returns names with the `.mp4`/`.mov`/etc. suffix. Size and hash checks BOTH passed — these were real originals, but the strict `===` filename comparison rejected them.

The current `verifyUpgrade()` in `upgrade.js` strips the extension before comparing, which fixes this case while still rejecting genuine asset mismatches (different basenames remain different after stripping):

```js
function stripExt(s) { return s ? String(s).replace(/\.[^.\\/]+$/, '') : ''; }
const payloadBase = stripExt(task.payload_filename);
const manifestBase = stripExt(task.entry.original_filename);
// passes when basenames match regardless of extension
```

### Persistent verification failures (~0.1% of UIDs)

In a 4,284-UID run we saw **one** UID that fails verification every time: the size check legitimately fails (delivered file is 1.69× the manifest's `orig_filesize`). This is most likely a stale manifest entry — the value Shutterfly told us at bulk-download time was wrong for that specific file (or the underlying original was replaced by the user after the original upload).

These are **permanent skips**. The script will re-attempt them on every run and keep failing. Either accept them (the medium copy stays in place) or manually correct the manifest's `orig_filesize` for that UID. They do not indicate a code bug.

### EXIF / capture-date preservation

The commit step does a binary file swap: medium → `.medium.bak`, original → library path, `.medium.bak` deleted. Filesystem mtime takes the original-file's mtime at write time, but **EXIF metadata inside the file is whatever Shutterfly stored at upload time** — capture date, GPS, camera model, etc. all come from the original file's container. For Google Photos / Apple Photos timeline sorting, this means upgraded files sort to their TRUE capture date, not to today.

## Production run characteristics (4,384 UIDs, May 2026)

Real numbers from a production campaign, useful for calibrating expectations:

| Metric | Value |
|---|---|
| Total candidates | 4,384 videos |
| Total delivered bytes | **~407 GB** (medium tier was 106 GB) |
| Average upgrade ratio | **4.91×** |
| Sustained commit rate (steady state) | **13.3 commits/min** (matches 4.5s API throttle exactly) |
| Persistent verification skips | 18 of 4,384 (~0.4%) — mostly stale `orig_filesize` values |
| Memory ceiling | <400 MB throughout |
| CPU utilization | ~25-45% (SHA256 + I/O) |

**Number of runs required: 4** (plus a final `scan_and_grab` cleanup). Reality of the campaign:

| Run | Wall-clock | Outcome | Lessons learned |
|---|---|---|---|
| Run 1 | 3.5 hours | 154 commits, then killed | First-time filename verification bug (handled now via `stripExt()`) |
| Run 2 | 3.5 hours | 2,546 commits, then killed by Windows Update reboot | Use `scripts/launch_durable.ps1` to survive sessions |
| Run 3 | 6 hours + 8h max-wait | 1,474 commits, then stalled on slow Glacier tail | Glacier ~5% of UIDs take 6-12+ hours, not 3-5 |
| Run 4 | ~30 min before scan replaced it | 37 commits from previous warm pool | Killing a stalled run + restarting catches Run-N-2 leftovers (24h retention) |
| `scan_and_grab` | 12 min | 2 commits | One-shot cleanup pass for the warm pool |

**Total upgrades committed**: 4,153 / 4,384 = **94.7%**. The remaining 5.3% is:
- 18 verification-failed permanent skips (~0.4%)
- ~213 still-cold UIDs that would need another `--unfreeze-only` + wait cycle to capture

**Plan to budget**: For a similar-size library, **plan on at least 1 full day** (sometimes 2-3) of intermittent attention. The script itself is unattended, but:
- Windows Updates kill runs (use the durable launcher)
- Glacier's slow tail (~5% of UIDs) won't finish in the default 8h max-wait
- Glacier's 24h retention window between thaw completion and re-freeze means stragglers from one day's run are recoverable the next day if you act fast

**The `scan_and_grab` workflow** is the key insight: after a stalled run, immediately doing a one-shot scan-and-grab catches every UID currently warm in Glacier without waiting for more polling cycles or starting fresh unfreezes. See `docs/TROUBLESHOOTING.md` § "Upgrade run stuck on the Glacier slow tail" for the full pattern.

The system runs **at the producer's API throttle ceiling** for the duration of the download phase — workers never wait on the producer once the cascade starts. If you set `--api-rate-ms` lower (say 3000ms), throughput will scale linearly until you hit Shutterfly's actual rate limits (we have not probed those).

## Things we tried that didn't work

If you're attempting your own reverse-engineering or extending this, these are dead ends:

1. **Sibling method names** — `moment.downloadOriginal`, `moment.getOriginalDownloadDetails`, etc. all return `success: null` with empty bodies (methods don't exist).
2. **Param variations at position 2** — `[jwt, uid, 'original']`, `[jwt, uid, true]`, `[jwt, uid, {tier: 'original'}]`. All return medium.
3. **Different X-SFLY-SubSource values** — `download_modal`, `request_original`, `unfreeze`, `original`, etc. All return medium.
4. **Content-Type: application/x-www-form-urlencoded** — what the SPA actually sends. Replicating this doesn't change behavior on its own.
5. **Different Referer headers** — `https://photos3.shutterfly.com/video_download/<uid>`. Doesn't matter.
6. **Cookie tricks** — visiting `/video_download/<uid>` before calling the API. Cookies change but the direct API call still returns medium without the 8-position trick.
7. **`cmd.thislife.com/json` endpoint** — accepts `moment.downloadDetails` but the same 8-position trick is required and the response is identical.
8. **`moment.thawMoments`, `moment.getUnfrozenUrl`** — these methods don't exist.

What DOES work is the single combination at the top of this doc. We don't know what positions 2-6 of the params array are for, and we couldn't find any documentation or community reference to them. As far as we can tell, this project is the first to document the 8-position form.

## Verification: was the upgrade real?

For the test files we downloaded:

| UID | Medium (bytes) | Delivered original (bytes) | Ratio | First 4 bytes hex |
|---|---|---|---|---|
| `1773638306792092` | 516,759 | 5,235,232 | 10.13× | `00000014` (QuickTime ftyp atom) |
| `20013439938` | 488,172 | 77,675,958 | 159.1× | `00000020` (MP4 ftyp atom) |

Both downloaded files start with valid container-format headers. SHA256 hashes differ from the manifest's recorded medium hash. Sizes match `orig_filesize` to the byte.

## Photos: the unbypassable story

We thoroughly tested whether photos have a video-equivalent upgrade path. They don't — but the situation is more nuanced than a flat "no." The short version: **HEIC photos already come back at full quality via the bulk downloader; JPEG photos do not, and there's no programmatic way to upgrade them.**

### What we learned by probing the photo download flow

Investigations (10+ diagnostic experiments across 2 HAR captures, 2 web research agents, and ~40 API permutations):

1. **`moment.unfreezeMoments` is NOT a no-op on photo UIDs.** It validates (garbage UIDs return `success: false, "Moment not found"`). It accepts real photo UIDs and returns `success: true`. Something happens server-side — we just can't observe the result via any public endpoint.

2. **The 8-position `downloadDetails` trick has zero effect on photos.** All position-7 boolean variations return the same response. The trick is video-specific.

3. **`moment.downloadDetails` returns an INTERNAL hostname for photos.** Specifically `https://unifetchcloud.internal.shutterfly.com/image/raw/<locationSpec>?redirect=false`. This URL is not resolvable from outside Shutterfly's VPC (`getaddrinfo ENOTFOUND`). The internal hostname is real — Shutterfly's backend does serve photo originals from it — but only to clients inside their network.

4. **All public photo paths cap out at the display tier.** Tested:
   - `/render/<eid>?cn=THISLIFE&res=small|medium|large` → 20 KB / 76 KB / 296 KB
   - `/render/<eid>?cn=THISLIFE&res=xlarge|original|full|max|4k` → HTTP 400 (invalid)
   - `/services/download/<eid>?cn=THISLIFE` → ~400 KB (what the bulk downloader uses)
   - `/full/`, `/raw/`, `/image/`, `/original/` on `uniim1.shutterfly.com` → HTTP 401 (paths exist but no auth path)
   - `cmd.thislife.com/json?method=moment.getOriginalUrl|getPrintUrl|requestOriginals|prepareOriginals` → all `Method not found`
   - `io.thislife.com/download?source=original|raw|fullsize|print|hires|editor|originals` → all return the SAME 416 KB compressed JPEG

5. **The web UI's "Download" button on a photo hits the SAME endpoint and returns the SAME 416 KB file.** Confirmed by capturing the network traffic when a user clicked Download on `recreation2.jpg` (UID `1834690495283767`, "Original Filesize" shown as 29 MB in the UI). The encrypted_id in the UI's request matched our manifest's encrypted_id byte-for-byte. There is no UI-only path that escapes this tier.

### The HEIC exception — and why

For HEIC photos, the bulk downloader DOES get full-resolution images, transcoded to JPEG:

| Sample file | Source HEIC | Bulk-downloaded JPEG | Dimensions | Quality |
|---|---|---|---|---|
| `IMG_1629.HEIC` | 2.34 MB | **7.72 MB** (3.3× larger) | 4032×3024 | ✓ Full original resolution |
| `IMG_1787.HEIC` | 2.68 MB | **8.37 MB** (3.1× larger) | 4032×3024 | ✓ Full original resolution |

The transcoded JPEG is LARGER than the source HEIC because HEIC uses HEVC/H.265 compression (very efficient) while JPEG uses much less efficient DCT compression. At the same visual quality, JPEG needs ~3-5× more bytes than HEIC.

**Why HEIC works**: phone HEIC photos are typically 2-4 MB and ~12 MP. Small enough that Shutterfly keeps them in hot CDN tiers and serves the full transcoded JPEG via the public download path. No thaw needed.

**Why JPEG doesn't**: large JPEG originals (multi-MB at high megapixels) appear to be moved to Glacier Deep Archive, leaving only the compressed display tier in hot storage. Recovering them requires the slow "Prepare Originals" email flow (multi-day async job that Shutterfly explicitly describes as "this can take multiple days" in their support docs).

### Empirical breakdown — a typical Shutterfly library

From a real 44,067-photo library:

| Type | Count | % | Quality after bulk download |
|---|---|---|---|
| **HEIC** | 1,595 | 3.6% | ✓ Full original resolution (transcoded JPEG, no thaw needed) |
| **JPG/JPEG (small originals)** | ~13,000 | 30% | ✓ Approximately full quality |
| **JPG/JPEG (compressed)** | 29,005 | 66% | ✗ Display tier only — ~10× smaller than `orig_filesize` |
| **PNG / other** | 165 | 0.4% | varies |

For the compressed-JPEG subset:
- Total downloaded: ~10 GB
- Total claimed `orig_filesize`: ~95 GB
- **Storage gap: ~85 GB at 9.3× average ratio**

That 85 GB is real photo data that exists in Shutterfly's storage but is not publicly retrievable. The only avenue is the "Prepare Originals" email flow, which is:
- Manual UI clicks per album
- Capped at ~500 photos per request
- Multi-day async per batch
- For 29,005 photos: ~58 batches × multi-day each = months of waiting

### Recommended approach for photos

1. **Accept the bulk download for the 96% you have.** HEIC files are already at full quality. Most JPEGs are at display tier — acceptable for viewing and social sharing.

2. **Cherry-pick the photos that matter for "Prepare Originals."** Identify the 50-200 photos you care about most (family events, important portraits, large panoramas where compression hurts most). Trigger the UI flow manually for just those.

3. **Don't expect a programmatic photo upgrade**. We've definitively ruled out every public API path. The "Prepare Originals" trigger endpoint isn't documented anywhere in community reverse-engineering work, and the UI doesn't fire it via standard XHR (it's likely a one-off URL inside the email that Shutterfly sends after a regular Download click).

4. **CCPA "right to access" is not a workaround.** Historical reports (2023-2024) indicate Shutterfly's CCPA response includes account data, not original photo files.

### What would change this

If someone manually triggers "Prepare Originals" in the UI and captures the network traffic when they click that button, the trigger endpoint will be revealed. Then it could be automated. We didn't do this capture (it requires the user to be willing to wait through the multi-day flow), but it's the obvious next research step for anyone determined to make photo upgrade work.

## See also

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how upgrade.js fits into the full pipeline
- [`AUTHENTICATION.md`](AUTHENTICATION.md) — getting the JWT this code uses
- [`CLOUD_SYNC.md`](CLOUD_SYNC.md) — pushing the result to Google Drive / Google Photos
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — what to do when thaw fails or downloads stall
