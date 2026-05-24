#!/usr/bin/env node
// Shutterfly bulk photo/video downloader.
//
// Usage:
//   node downloader.js --count 200 --out ./downloads --rate-ms 5000 [--resume]
//
// Behavior:
//   - Loads cookies from ./auth.json (written by manual_login.js).
//   - Sniffs JWT + X-API-Key from the SPA's outgoing RPC requests at startup.
//   - Walks the library newest-to-oldest via getPaginatedMoments(pageSize=2000).
//   - For each item, fetches the full original via the same mechanism the SPA's
//     download button uses:
//       photos: GET https://uniim1.shutterfly.com/services/download/<enc>?cn=THISLIFE
//               header: Authorization: Bearer <jwt>
//       videos: POST .../photos/json?method=moment.downloadDetails -> presigned S3 URL
//   - Filenames: YYYY-MM-DD_(image|video)_NNNNNN.<ext>
//     date from EXIF DateTimeOriginal (images) falling back to moment_date.
//     videos always use moment_date (medium transcode has no useful EXIF).
//   - Manifest at <out>/manifest.json (resumable).
//   - Errors logged to <out>/errors.log; per-item retried 3x with exp backoff.
//   - Rate-limited by --rate-ms (default 5000ms between items).
//
// SAFETY:
//   - Atomic manifest writes (temp + rename) survive process kill mid-flush.
//   - JWT refreshes automatically on 401 — sessions live as long as cookies do.
//   - Designed to run for multiple days unattended.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ---------- CLI ----------
function parseArgs(argv) {
  const args = { count: 200, out: './downloads', rateMs: 5000, resume: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count') args.count = parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--rate-ms') args.rateMs = parseInt(argv[++i], 10);
    else if (a === '--resume') args.resume = true;
    else if (a === '--help' || a === '-h') { args.help = true; }
    else { console.error('Unknown arg:', a); process.exit(2); }
  }
  return args;
}
const args = parseArgs(process.argv);
if (args.help) {
  console.log('Usage: node downloader.js --count <N> --out <dir> --rate-ms <ms> [--resume]');
  process.exit(0);
}

const ROOT = __dirname;
const AUTH_FILE = path.join(ROOT, 'auth.json');         // written by manual_login.js
const OUT = path.resolve(args.out);
const MANIFEST_PATH = path.join(OUT, 'manifest.json');
const METADATA_PATH = path.join(OUT, 'metadata.json');
const ERRORS_PATH = path.join(OUT, 'errors.log');

const CHROMIUM_ARGS = [
  '--disable-features=PasswordManager',
  '--no-pings',
  '--disable-component-update',
  '--disable-prompt-on-repost',
  '--disable-infobars',
  '--disable-save-password-bubble',
  '--disable-translate',
  '--disable-extensions',
  '--no-first-run',
  '--password-store=basic',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function loadManifest() {
  // Recovery: prefer manifest.json, fall back to manifest.json.tmp if the
  // main file is missing or unparseable (kill mid-write would have left
  // a complete .tmp before the rename happened).
  const candidates = [MANIFEST_PATH, MANIFEST_PATH + '.tmp'];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (m && m.entries && m.order) {
        if (p !== MANIFEST_PATH) console.log('[manifest] recovered from .tmp');
        return m;
      }
    } catch (e) {
      console.log(`[manifest] ${p} unparseable: ${e.message}`);
    }
  }
  return { entries: {}, order: [] };
}

function sleepSync(ms) {
  // Synchronous spin sleep. Used only inside short EPERM retry loops
  // where blocking the event loop briefly is acceptable.
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function renameWithRetry(src, dst) {
  // Windows raises EPERM/EACCES/EBUSY if any other process has an open
  // handle to dst (antivirus, file indexer, status dashboard reading the
  // manifest). Retry with backoff up to ~3 seconds total.
  for (let attempt = 0; attempt < 10; attempt++) {
    try { fs.renameSync(src, dst); return; }
    catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt === 9) throw e;
      sleepSync(30 + attempt * 50);
    }
  }
}

function saveManifest(m) {
  const tmp = MANIFEST_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameWithRetry(tmp, MANIFEST_PATH);
}
function appendError(line) { fs.appendFileSync(ERRORS_PATH, `[${new Date().toISOString()}] ${line}\n`); }

function exiftoolDate(filePath) {
  try {
    const out = execFileSync('exiftool', ['-j', '-DateTimeOriginal', '-CreateDate', '-MIMEType', filePath], { encoding: 'utf8' });
    return JSON.parse(out)[0] || {};
  } catch (e) { return {}; }
}

function parseExifDate(s) {
  // exiftool format: "YYYY:MM:DD HH:MM:SS" (with possible timezone offset)
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})/);
  if (!m) return null;
  if (m[1] === '0000') return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function momentDateString(m) {
  if (m.moment_date_timestamp) {
    const d = new Date(parseInt(m.moment_date_timestamp, 10) * 1000);
    return d.toISOString().slice(0, 10);
  }
  if (m.moment_date && m.moment_date.date) return m.moment_date.date.slice(0, 10);
  if (typeof m.moment_date === 'string' && /^\d+$/.test(m.moment_date)) {
    const d = new Date(parseInt(m.moment_date, 10) * 1000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function sanitizeExt(extRaw, fallback) {
  let ext = (extRaw || fallback || 'bin').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!ext) ext = fallback || 'bin';
  return ext;
}

function sha256OfFile(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// ---------- Session / JWT management ----------
async function setupBrowserSession() {
  console.log('[downloader] launching browser');
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error(`auth.json not found at ${AUTH_FILE}. Run \`node manual_login.js\` first to authenticate.`);
  }
  const browser = await chromium.launch({
    headless: true,
    args: CHROMIUM_ARGS,
  });
  const context = await browser.newContext({
    storageState: AUTH_FILE,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const state = { jwt: null, apiKey: null };
  const onReq = req => {
    const u = req.url();
    if (!/photos-api3\.shutterfly\.com\/photos\/json|cmd\.thislife\.com\/json/.test(u)) return;
    try {
      const body = req.postData();
      if (body) {
        const j = JSON.parse(body);
        if (Array.isArray(j.params) && typeof j.params[0] === 'string' && j.params[0].startsWith('eyJ')) {
          state.jwt = j.params[0];
        }
      }
      const h = req.headers();
      if (h['x-api-key']) state.apiKey = h['x-api-key'];
    } catch (e) {}
  };
  context.on('request', onReq);

  const page = await context.newPage();
  await page.goto('https://photos3.shutterfly.com/library', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const start = Date.now();
  while ((!state.jwt || !state.apiKey) && Date.now() - start < 45000) await sleep(500);
  if (!state.jwt || !state.apiKey) {
    await browser.close();
    throw new Error('Failed to sniff JWT / X-API-Key from live traffic. Session may be expired — re-run manual_login.js to refresh.');
  }
  if (!/photos3\.shutterfly\.com\/library/.test(page.url())) {
    await browser.close();
    throw new Error('Browser redirected away from /library (URL=' + page.url() + '). Session likely expired.');
  }

  return { browser, context, page, state };
}

// ---------- API ----------
function makeApi(page, state) {
  const apiCtx = page.request;
  const rpcHeaders = () => ({
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://photos3.shutterfly.com',
    'Referer': 'https://photos3.shutterfly.com/',
    'X-API-Key': state.apiKey,
    'Authorization': `Bearer ${state.jwt}`,
  });

  const callRPC = async (method, params, sub = 'library') => {
    const url = `https://photos-api3.shutterfly.com/photos/json?method=${method}`;
    const body = { method, params, headers: { 'X-SFLY-SubSource': sub }, id: null };
    const r = await apiCtx.post(url, { data: JSON.stringify(body), headers: rpcHeaders() });
    const status = r.status();
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    await r.dispose();
    return { status, text, json };
  };

  return { callRPC, rpcHeaders, apiCtx };
}

// ---------- Enumeration ----------
async function enumerateMoments(api, jwt, targetCount) {
  // Walk newest -> oldest by repeatedly calling getPaginatedMoments with a sliding end-timestamp.
  const out = [];
  let endSec = Math.floor(Date.now() / 1000) + 86400; // future to be safe
  const earliestSec = 0;
  const seenUids = new Set();
  let safetyIter = 0;

  while (out.length < targetCount && safetyIter < 200) {
    safetyIter++;
    const startSec = 0;
    const r = await api.callRPC('getPaginatedMoments',
      [jwt, String(startSec), String(endSec), 2000, false, false, '', true]);
    if (r.status !== 200 || !r.json) {
      throw new Error(`getPaginatedMoments failed: status=${r.status} body=${(r.text||'').slice(0,200)}`);
    }
    const moments = (r.json.result && r.json.result.payload && r.json.result.payload.moments) || [];
    if (moments.length === 0) break;
    moments.sort((a, b) => Number(b.moment_date) - Number(a.moment_date));
    let pushed = 0;
    for (const m of moments) {
      if (seenUids.has(m.uid)) continue;
      seenUids.add(m.uid);
      out.push(m);
      pushed++;
      if (out.length >= targetCount) break;
    }
    console.log(`[enum] page returned ${moments.length}, pushed ${pushed}, total ${out.length}/${targetCount}`);
    if (out.length >= targetCount) break;
    const oldest = moments[moments.length - 1];
    const oldestSec = Number(oldest.moment_date);
    if (!Number.isFinite(oldestSec) || oldestSec <= earliestSec) break;
    endSec = oldestSec - 1;
    await sleep(400);
  }
  return out;
}

function loadMetadataCache() {
  if (!fs.existsSync(METADATA_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8')); }
  catch (e) { console.log('[downloader] metadata.json unreadable, starting fresh'); return {}; }
}

function writeMetadataCache(cache) {
  const tmp = METADATA_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache));
  renameWithRetry(tmp, METADATA_PATH);
}

async function fetchMetadataBatch(api, jwt, uids, cache) {
  // Up to ~50 uids per call seems fine, batch 20 to be safe.
  // cache: existing UID->meta map; UIDs already in cache are skipped.
  // Persists cache to disk every FLUSH_EVERY_BATCHES batches so a kill
  // mid-phase only loses a small window of work.
  const toFetch = uids.filter(uid => !cache[uid]);
  if (toFetch.length === 0) {
    console.log('[meta] all uids already cached');
    return cache;
  }
  const FLUSH_EVERY_BATCHES = 50; // every ~1000 uids
  let batchesSinceFlush = 0;
  let batchNum = 0;
  const totalBatches = Math.ceil(toFetch.length / 20);
  for (let i = 0; i < toFetch.length; i += 20) {
    batchNum++;
    const slice = toFetch.slice(i, i + 20);
    const r = await api.callRPC('getMomentSet', [jwt, slice, null, true, true]);
    if (r.status !== 200 || !r.json) {
      throw new Error(`getMomentSet failed: status=${r.status}`);
    }
    const rows = (r.json.result && r.json.result.payload) || [];
    for (const row of rows) cache[row.uid] = row;
    batchesSinceFlush++;
    if (batchesSinceFlush >= FLUSH_EVERY_BATCHES) {
      writeMetadataCache(cache);
      console.log(`[meta] flushed cache at batch ${batchNum}/${totalBatches} (${Object.keys(cache).length} entries)`);
      batchesSinceFlush = 0;
    }
    await sleep(200);
  }
  writeMetadataCache(cache);
  console.log(`[meta] final flush, ${Object.keys(cache).length} total entries`);
  return cache;
}

// ---------- Per-item download ----------
async function downloadImage(api, state, meta) {
  const url = `https://uniim1.shutterfly.com/services/download/${meta.encrypted_id}?cn=THISLIFE`;
  const headers = {
    'Authorization': `Bearer ${state.jwt}`,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  const r = await api.apiCtx.get(url, { headers, maxRedirects: 5 });
  const result = { status: r.status(), buf: r.ok() ? await r.body() : null, ct: r.headers()['content-type'], cd: r.headers()['content-disposition'], url };
  await r.dispose();
  return result;
}

async function downloadVideo(api, state, meta) {
  const r = await api.callRPC('moment.downloadDetails', [state.jwt, meta.uid]);
  if (r.status !== 200 || !r.json) {
    return { status: r.status, error: 'downloadDetails failed', body: (r.text||'').slice(0, 300) };
  }
  const payload = r.json.result && r.json.result.payload;
  if (!payload || !payload.url) {
    return { status: 500, error: 'no presigned url in downloadDetails', body: JSON.stringify(r.json).slice(0, 300) };
  }
  const ext = sanitizeExt(payload.fileName && payload.fileName.split('.').pop(), meta.orig_file_extension || 'mp4');
  const fetchResp = await api.apiCtx.get(payload.url, { maxRedirects: 5 });
  const result = {
    status: fetchResp.status(),
    buf: fetchResp.ok() ? await fetchResp.body() : null,
    ct: fetchResp.headers()['content-type'],
    cd: fetchResp.headers()['content-disposition'],
    url: payload.url,
    presignedFileName: payload.fileName,
    presignedFileSize: payload.fileSize,
    ext,
  };
  await fetchResp.dispose();
  return result;
}

// ---------- Main ----------
async function main() {
  ensureDir(OUT);
  const manifest = loadManifest();
  if (args.resume) {
    console.log(`[downloader] resume mode: ${manifest.order.length} existing entries`);
  } else if (manifest.order.length > 0) {
    console.log(`[downloader] WARNING: existing manifest with ${manifest.order.length} entries at ${MANIFEST_PATH}. Use --resume to add to it; otherwise delete the dir.`);
    process.exit(3);
  }
  const completedUids = new Set(Object.keys(manifest.entries));

  const { browser, context, page, state } = await setupBrowserSession();
  console.log('[downloader] session ready (jwt len=' + state.jwt.length + ', apiKey len=' + state.apiKey.length + ')');

  let api = makeApi(page, state);

  const refreshSession = async () => {
    console.log('[downloader] refreshing JWT...');
    state.jwt = null;
    await page.goto('https://photos3.shutterfly.com/library?_refresh=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const start = Date.now();
    while (!state.jwt && Date.now() - start < 30000) await sleep(500);
    if (!state.jwt) throw new Error('failed to re-sniff JWT');
    console.log('[downloader] JWT refreshed');
  };

  console.log('[downloader] enumerating moments (target ' + args.count + ')');
  const need = args.count + completedUids.size + 50;
  const allMoments = await enumerateMoments(api, state.jwt, need);
  console.log(`[downloader] got ${allMoments.length} moments total`);

  const toProcess = [];
  for (const m of allMoments) {
    if (completedUids.has(m.uid)) continue;
    toProcess.push(m);
    if (toProcess.length >= args.count) break;
  }
  if (toProcess.length === 0) { console.log('[downloader] nothing to do'); await browser.close(); return; }
  console.log(`[downloader] will download ${toProcess.length} items`);

  console.log('[downloader] fetching metadata...');
  const metaCache = loadMetadataCache();
  const cachedCount = Object.keys(metaCache).length;
  if (cachedCount > 0) console.log(`[downloader] loaded ${cachedCount} cached metadata entries from metadata.json`);
  const metaByUid = await fetchMetadataBatch(api, state.jwt, toProcess.map(m => m.uid), metaCache);

  let seq = manifest.order.length;
  let okCount = 0, errCount = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const m = toProcess[i];
    const meta = metaByUid[m.uid] || {};
    const isVideo = m.moment_type === 'video';

    const fallbackDate = momentDateString({ moment_date_timestamp: m.moment_date, moment_date: meta.moment_date });
    const extGuess = sanitizeExt(meta.orig_file_extension, isVideo ? 'mp4' : 'jpg');
    const kindStr = isVideo ? 'video' : 'image';

    let attempt = 0;
    let success = false;
    let lastErr = null;
    let resp = null;
    while (attempt < 3 && !success) {
      attempt++;
      try {
        resp = isVideo ? await downloadVideo(api, state, { ...meta, uid: m.uid }) : await downloadImage(api, state, { ...meta, encrypted_id: m.encrypted_id });
        if (resp.status === 401) {
          await refreshSession();
          continue;
        }
        if (resp.status < 200 || resp.status >= 300 || !resp.buf || resp.buf.length === 0) {
          lastErr = `status=${resp.status} bytes=${resp.buf ? resp.buf.length : 0}`;
        } else {
          success = true;
        }
      } catch (e) {
        lastErr = String(e.message || e);
      }
      if (!success && attempt < 3) {
        const backoff = Math.pow(4, attempt - 1) * 1000; // 1s, 4s, 16s
        await sleep(backoff);
      }
    }

    if (!success) {
      errCount++;
      const msg = `uid=${m.uid} type=${kindStr} failed after ${attempt} attempts: ${lastErr}`;
      console.error('[ERR] ' + msg);
      appendError(msg);
      await sleep(args.rateMs);
      continue;
    }

    seq = manifest.order.length;
    const tmpExt = isVideo ? (resp.ext || extGuess) : extGuess;
    const tmpPath = path.join(OUT, `.tmp_${m.uid}.${tmpExt}`);
    fs.writeFileSync(tmpPath, resp.buf);

    let dateStr = fallbackDate;
    let mimeType = null;
    if (!isVideo) {
      const ex = exiftoolDate(tmpPath);
      mimeType = ex.MIMEType || null;
      const exifDate = parseExifDate(ex.DateTimeOriginal) || parseExifDate(ex.CreateDate);
      if (exifDate) dateStr = exifDate;
    }
    if (!dateStr) dateStr = '0000-00-00';

    const seqStr = String(seq + 1).padStart(6, '0');
    const finalName = `${dateStr}_${kindStr}_${seqStr}.${tmpExt}`;
    const finalPath = path.join(OUT, finalName);
    fs.renameSync(tmpPath, finalPath);

    const bytes = fs.statSync(finalPath).size;
    const sha = sha256OfFile(finalPath);

    const entry = {
      seq: seq + 1,
      uid: m.uid,
      encrypted_id: m.encrypted_id,
      type: kindStr,
      original_filename: meta.original_filename || null,
      moment_date_iso: fallbackDate,
      exif_date: !isVideo ? dateStr : null,
      mime_type: mimeType,
      url: resp.url,
      saved_path: finalPath,
      saved_name: finalName,
      bytes,
      sha256: sha,
      orig_filesize: meta.orig_filesize || null,
      orig_width: m.orig_width || meta.width || null,
      orig_height: m.orig_height || meta.height || null,
      downloaded_at: new Date().toISOString(),
    };
    manifest.entries[m.uid] = entry;
    manifest.order.push(m.uid);
    saveManifest(manifest);

    okCount++;
    if (((i + 1) % 10) === 0 || (i + 1) === toProcess.length) {
      console.log(`[${String(i + 1).padStart(3)}/${toProcess.length}] seq=${seqStr} uid=${m.uid} bytes=${bytes} type=${kindStr} name=${finalName}`);
    } else {
      console.log(`  [${String(i + 1).padStart(3)}/${toProcess.length}] seq=${seqStr} uid=${m.uid} bytes=${bytes} type=${kindStr}`);
    }

    if (i + 1 < toProcess.length) await sleep(args.rateMs);
  }

  console.log(`\n[downloader] done. ok=${okCount} err=${errCount} totalEntries=${manifest.order.length}`);
  await browser.close();
}

main().catch(e => {
  console.error('[FATAL]', e && (e.stack || e.message || e));
  process.exit(1);
});
