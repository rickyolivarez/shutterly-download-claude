# UID Discovery

How the downloader enumerates your entire Shutterfly library and learns enough metadata to download each item.

## Concept: the UID

Every photo and video in Shutterfly's system has a stable internal identifier called the **UID** (sometimes called `moment_id` in older APIs). UIDs:

- Are 14-16 digit numeric strings, e.g. `1773638306792092` or `20440813225`
- Persist across renames, edits, album moves, and re-uploads
- Are the join key for everything — manifest entries, upgrade requests, error logs
- Are NEVER displayed in the web UI but are sent in every API call

If your library has 48,000 items, you have 48,000 UIDs to discover and process.

## The walk algorithm: newest-to-oldest sliding window

Shutterfly's catalog enumeration endpoint is `getPaginatedMoments`. It supports a `[startTimestamp, endTimestamp, pageSize, ...]` filter that returns moments where `startTimestamp <= moment_date <= endTimestamp`.

The page size cap is 2000. To walk the whole library we slide `endTimestamp` backwards in time:

```js
async function enumerateMoments(api, jwt, targetCount) {
  const out = [];
  let endSec = Math.floor(Date.now() / 1000) + 86400; // future to be safe
  const seenUids = new Set();

  while (out.length < targetCount) {
    const r = await api.callRPC('getPaginatedMoments',
      [jwt, "0", String(endSec), 2000, false, false, '', true]);
    const moments = r.json.result.payload.moments || [];
    if (moments.length === 0) break;

    moments.sort((a, b) => Number(b.moment_date) - Number(a.moment_date));
    for (const m of moments) {
      if (seenUids.has(m.uid)) continue;
      seenUids.add(m.uid);
      out.push(m);
      if (out.length >= targetCount) break;
    }

    // Slide endSec backwards to (oldest in page) - 1
    const oldest = moments[moments.length - 1];
    endSec = Number(oldest.moment_date) - 1;
    await sleep(400);  // be polite
  }
  return out;
}
```

### Why newest-to-oldest?

Two reasons:

1. **Resumability** — when you re-run the downloader with `--resume`, it processes from newest down and stops as soon as it hits already-completed UIDs. New items added since the last run get picked up automatically.
2. **Pagination stability** — adding new items shifts the OLDER tail by adding to the head. Walking head-to-tail is stable as long as no items are deleted during the walk.

### What gets returned

Each item in `moments[]` from `getPaginatedMoments` is a lean object:

```json
{
  "uid": "1773638306792092",
  "encrypted_id": "00-Tq_NoCSF...",
  "moment_type": "video",
  "moment_date": "1689824820",      // epoch seconds
  "orig_width": 1920,
  "orig_height": 1080
  // ...
}
```

`encrypted_id` is the only field needed for downloading photos. For videos, only the UID is needed (the subsequent `moment.downloadDetails` call uses it to look up the rest).

## Metadata enrichment: `getMomentSet`

The lean moment object is missing several fields the downloader needs:

- `original_filename` (e.g. `IMG_4801.jpg`)
- `orig_filesize` (used by upgrade.js to detect upgrade candidates)
- `orig_file_extension`
- Full date metadata
- MIME type

To get them, the downloader batches UIDs into `getMomentSet` calls (batch size 20):

```js
async function fetchMetadataBatch(api, jwt, uids, cache) {
  const toFetch = uids.filter(uid => !cache[uid]);
  for (let i = 0; i < toFetch.length; i += 20) {
    const slice = toFetch.slice(i, i + 20);
    const r = await api.callRPC('getMomentSet', [jwt, slice, null, true, true]);
    const rows = r.json.result.payload || [];
    for (const row of rows) cache[row.uid] = row;

    // Flush to disk every 50 batches so a crash doesn't lose much work
    if (++batchesSinceFlush >= 50) {
      writeMetadataCache(cache);
      batchesSinceFlush = 0;
    }
    await sleep(200);
  }
}
```

Each row returned includes the rich metadata. The cache is persisted to `metadata.json` so re-runs with `--resume` skip already-fetched UIDs.

## Memory footprint

For libraries with tens of thousands of UIDs, the in-memory metadata cache can grow into the hundreds of megabytes. The bulk download phase keeps everything in a single `metaByUid` map. This is a known concern — see the patch history in this repo for the original RAM-leak fix (Playwright `APIResponse.dispose()` adoption).

For libraries above ~500,000 items, you'd want to refactor to a streaming approach. For libraries under ~100,000 items (the vast majority of personal accounts), the current in-memory approach is fine.

## Field reference (post-enrichment manifest entry)

```json
{
  "seq": 1234,                                  // 1-indexed sequence
  "uid": "1773638306792092",                    // Shutterfly internal ID
  "encrypted_id": "00-Tq_NoCSF...",             // for the photo download URL
  "type": "video",                              // "image" or "video"
  "original_filename": "FullSizeRender.mov",    // the user-uploaded filename
  "moment_date_iso": "2023-07-20",              // YYYY-MM-DD from moment_date
  "exif_date": null,                            // YYYY-MM-DD from EXIF (images only)
  "mime_type": "video/quicktime",
  "url": "https://...",                          // the URL actually fetched
  "saved_path": "./downloads/2023-07-20_video_000078.mov",
  "saved_name": "2023-07-20_video_000078.mov",
  "bytes": 516759,                              // local file size
  "sha256": "eed931400d3952ed95fb521c...",      // local file hash
  "orig_filesize": 5235232,                     // Shutterfly's claim of original size — CRITICAL for upgrade.js
  "orig_width": 1920,
  "orig_height": 1080,
  "downloaded_at": "2026-05-22T14:42:12.422Z"
}
```

## Prior art

Two community projects do partial versions of this:

- [Redth's 2015 C# gist](https://gist.github.com/Redth/2c8f20293a7152a22afb) — documents `album.getAlbums`, `loginWithCredentials`, `getLifeInfo`, `getStartUpItems`, `getMomentSet`, `getStories`, `getStory`. No mention of `getPaginatedMoments` or `unfreezeMoments`. Useful historical context for what the API has looked like since the ThisLife era.
- [JoshBurke/Shutterfly-Album-Downloader](https://github.com/JoshBurke/Shutterfly-Album-Downloader) — uses `cmd.thislife.com/json` for album-by-album photo download. Doesn't support videos or `getPaginatedMoments`. The closest active project to this one.
- [purarue/selenium-shutterfly-scraper](https://github.com/purarue/selenium-shutterfly-scraper) — UI-driven scraping via Selenium + PyAutoGUI. Useful as a fallback design pattern but much more fragile.

None of these handle `getPaginatedMoments` for whole-library enumeration or the video-upgrade flow. This project is the first published end-to-end implementation as of 2026-05.

## See also

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how this fits into the larger data flow
- [`AUTHENTICATION.md`](AUTHENTICATION.md) — how we get the JWT this code uses
- [`MEDIA_UPGRADE.md`](MEDIA_UPGRADE.md) — what to do with the `orig_filesize` numbers
