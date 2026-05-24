#!/usr/bin/env node
// upgrade.js — pure-API bulk video upgrade pipeline.
//
// MECHANISM (proven via diagnostic series D1-D10):
//   1. POST .../json?method=moment.unfreezeMoments   body params:[jwt, [uid,...]]
//      → triggers AWS Glacier "Standard" restore (~3-5 hr) for cold UIDs
//   2. POST .../json?method=moment.downloadDetails   body params:[jwt, uid, null,null,null,null,null, true]
//      → returns presigned URL pointing at prod-tl-video-source S3 bucket
//   3. Range GET 0-1 on the URL: 206 = ready, 403 = still in Glacier
//   4. Full GET → stream original bytes to disk
//   5. Verify (size ±0.1% of orig_filesize, sha256 differs, fileName matches)
//   6. [--commit only] Swap medium file → .medium.bak; move original; update manifest
//
// THROTTLING & PARALLELISM:
//   --api-rate-ms <ms>           Min interval between Shutterfly API calls (default 4500)
//                                Applies to downloadDetails + unfreezeMoments. NOT to S3.
//   --download-concurrency <N>   Max parallel S3 file downloads (default 5)
//   --unfreeze-batch-size <N>    UIDs per unfreezeMoments call (default 25)
//   --heartbeat-secs <N>         Status line interval, 0=off (default 5)
//   --skip-status-check          Skip Phase 1 (recommended for bulk runs)
//   --max-wait <min>             Minutes to wait for Glacier thaw (default 480 = 8h)
//   --poll-secs <N>              Seconds between thaw poll cycles (default 60)
//
// USAGE:
//   node upgrade.js --uids u1,u2,u3                              # test mode
//   node upgrade.js --uids u1 --commit                           # commit one UID
//   node upgrade.js --limit 4500 --commit --watch --skip-status-check
//                                                                # full bulk run

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

// -------- paths (all relative to script's own directory) --------
const ROOT       = __dirname;
const MANIFEST   = path.join(ROOT, 'downloads', 'manifest.json');
const AUTH_FILE  = path.join(ROOT, 'auth.json');
const USERDATA   = path.join(ROOT, 'userdata');
const TEST_OUT   = path.join(ROOT, 'test', 'upgrade_test');
const LIB_DIR    = path.join(ROOT, 'downloads');

// -------- args --------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else { out[key] = true; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

function usage() {
  console.error('Usage:');
  console.error('  node upgrade.js --uids <comma-separated UIDs> [options]');
  console.error('  node upgrade.js --limit <N> [options]');
  console.error('');
  console.error('  Required (one of):');
  console.error('    --uids <list>                  Comma-separated UID list');
  console.error('    --limit <N>                    Auto-select top N by orig_filesize/bytes ratio');
  console.error('');
  console.error('  Mode:');
  console.error('    --commit                       Modify library + manifest. Default: test mode');
  console.error('    --watch                        Poll until thawed and downloaded. Default: exit after one pass');
  console.error('');
  console.error('  Throttling:');
  console.error('    --api-rate-ms <ms>             Min ms between Shutterfly API calls (default 4500)');
  console.error('    --download-concurrency <N>     Max parallel S3 downloads (default 5)');
  console.error('    --unfreeze-batch-size <N>      UIDs per unfreezeMoments call (default 25)');
  console.error('    --heartbeat-secs <N>           Status line interval, 0=off (default 5)');
  console.error('');
  console.error('  Phase control:');
  console.error('    --skip-status-check            Skip Phase 1, treat all UIDs as frozen (faster for bulk)');
  console.error('    --unfreeze-only                Fire Phase 2 (unfreezeMoments) then exit — for "thaw overnight, download tomorrow" workflow');
  console.error('    --poll-secs <N>                Seconds between poll cycles (default 60)');
  console.error('    --max-wait <min>               Max minutes to wait for Glacier (default 480 = 8h)');
  process.exit(2);
}

if (!args.uids && !args.limit) usage();

const OPTS = {
  uids:                args.uids ? String(args.uids).split(',').map(s => s.trim()).filter(Boolean) : null,
  limit:               args.limit ? Number(args.limit) : null,
  commit:              !!args.commit,
  watch:               !!args.watch,
  apiRateMs:           Number(args['api-rate-ms'] !== undefined ? args['api-rate-ms'] : 4500),
  downloadConcurrency: Number(args['download-concurrency'] !== undefined ? args['download-concurrency'] : 5),
  unfreezeBatchSize:   Number(args['unfreeze-batch-size'] !== undefined ? args['unfreeze-batch-size'] : 25),
  heartbeatSecs:       Number(args['heartbeat-secs'] !== undefined ? args['heartbeat-secs'] : 5),
  skipStatusCheck:     !!args['skip-status-check'],
  unfreezeOnly:        !!args['unfreeze-only'],
  pollSecs:            Number(args['poll-secs'] !== undefined ? args['poll-secs'] : 60),
  maxWaitMin:          Number(args['max-wait'] !== undefined ? args['max-wait'] : 480),
};
const OUT_DIR = OPTS.commit ? LIB_DIR : TEST_OUT;
const JSONL   = path.join(OUT_DIR, 'video_upgrades.jsonl');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// -------- helpers --------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function nowIso() { return new Date().toISOString(); }
function jsonlAppend(rec) { fs.appendFileSync(JSONL, JSON.stringify({ ts: nowIso(), ...rec }) + '\n'); }
function loadManifest() { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }

// -------- stats + heartbeat --------
const stats = {
  phase: 'init',
  total: 0,
  thawing: 0,
  ready_for_download: 0,
  downloading: 0,
  verified: 0,
  committed: 0,
  failed: 0,
  apiCalls: 0,
  startedAt: Date.now(),
};

function statsLine() {
  const elapsed = (Date.now() - stats.startedAt) / 1000;
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = Math.floor(elapsed % 60);
  const ts = new Date().toISOString().slice(11, 19);
  return `[hb ${ts}] phase=${stats.phase} | total=${stats.total} | thawing=${stats.thawing} | ready=${stats.ready_for_download} | downloading=${stats.downloading} | committed=${stats.committed} | verified=${stats.verified} | failed=${stats.failed} | api=${stats.apiCalls} | elapsed=${h}h${String(m).padStart(2,'0')}m${String(s).padStart(2,'0')}s`;
}

let heartbeatHandle = null;
function startHeartbeat() {
  if (OPTS.heartbeatSecs <= 0) return;
  heartbeatHandle = setInterval(() => console.log(statsLine()), OPTS.heartbeatSecs * 1000);
}
function stopHeartbeat() {
  if (heartbeatHandle) clearInterval(heartbeatHandle);
  heartbeatHandle = null;
}

// -------- API rate limiter (serializes all Shutterfly API calls) --------
// Workers can call this concurrently; the chain naturally serializes them.
let apiChain = Promise.resolve();
let lastApiCall = 0;
function rateLimitApi() {
  const next = apiChain.then(async () => {
    const elapsed = Date.now() - lastApiCall;
    if (elapsed < OPTS.apiRateMs) await sleep(OPTS.apiRateMs - elapsed);
    lastApiCall = Date.now();
    stats.apiCalls++;
  });
  apiChain = next.catch(() => {});
  return next;
}

// -------- pickUIDs --------
function pickUIDs(manifest) {
  if (OPTS.uids) return OPTS.uids;
  const videoExts = new Set(['.mov', '.mp4', '.avi', '.m4v', '.3gp']);
  const candidates = [];
  for (const [uid, e] of Object.entries(manifest.entries || {})) {
    const ext = path.extname(e.saved_path || '').toLowerCase();
    if (!videoExts.has(ext)) continue;
    if (!e.bytes || !e.orig_filesize) continue;
    if (e.quality === 'original') continue;
    const ratio = e.orig_filesize / e.bytes;
    if (ratio < 1.10) continue;
    candidates.push({ uid, ratio, entry: e });
  }
  candidates.sort((a, b) => b.ratio - a.ratio);
  return candidates.slice(0, OPTS.limit).map(c => c.uid);
}

// -------- credential sniffing --------
async function sniffCreds() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const state = { jwt: null, apiKey: null };
  context.on('request', req => {
    if (/photos-api3\.shutterfly\.com\/photos\/json/.test(req.url())) {
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
    }
  });
  const page = await context.newPage();
  await page.goto('https://photos3.shutterfly.com/library', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
  const t0 = Date.now();
  while ((!state.jwt || !state.apiKey) && Date.now() - t0 < 60000) await sleep(500);
  if (!state.jwt || !state.apiKey) {
    await browser.close();
    throw new Error('Could not sniff JWT + X-API-Key. auth.json may have expired.');
  }
  return { browser, context, state };
}

// -------- RPC helpers (rate-limited) --------
function rpcHeaders(state) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Origin': 'https://photos3.shutterfly.com',
    'Referer': 'https://photos3.shutterfly.com/',
    'X-API-Key': state.apiKey,
    'Authorization': `Bearer ${state.jwt}`,
  };
}

async function unfreezeMoments(context, state, uids) {
  await rateLimitApi();
  const url = 'https://photos-api3.shutterfly.com/photos/json?method=moment.unfreezeMoments';
  const body = { method: 'moment.unfreezeMoments', params: [state.jwt, uids], headers: { 'X-SFLY-SubSource': 'library' }, id: null };
  const r = await context.request.post(url, { data: JSON.stringify(body), headers: rpcHeaders(state), timeout: 30000 });
  const status = r.status();
  const json = await r.json().catch(() => null);
  await r.dispose();
  return { status, success: json && json.result && json.result.success, body: json };
}

async function downloadDetailsOriginal(context, state, uid) {
  await rateLimitApi();
  const url = 'https://photos-api3.shutterfly.com/photos/json?method=moment.downloadDetails';
  const body = {
    method: 'moment.downloadDetails',
    params: [state.jwt, uid, null, null, null, null, null, true],
    headers: { 'X-SFLY-SubSource': 'library' },
    id: null,
  };
  const r = await context.request.post(url, { data: JSON.stringify(body), headers: rpcHeaders(state), timeout: 30000 });
  const status = r.status();
  const json = await r.json().catch(() => null);
  await r.dispose();
  return { status, payload: json && json.result && json.result.payload, body: json };
}

// -------- S3 helpers (NOT rate-limited) --------
function s3RangeCheck(url) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'Range': 'bytes=0-1' }, timeout: 30000 };
      const req = https.request(opts, (res) => {
        const totalMatch = (res.headers['content-range'] || '').match(/\/(\d+)$/);
        resolve({ status: res.statusCode, totalBytes: totalMatch ? parseInt(totalMatch[1], 10) : null });
        res.resume();
      });
      req.on('error', e => resolve({ status: 0, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      req.end();
    } catch (e) { resolve({ status: 0, error: e.message }); }
  });
}

function s3DownloadStream(url, destPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 600000 };
    const file = fs.createWriteStream(destPath);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const req = https.request(opts, (res) => {
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve({ bytes, sha256: hash.digest('hex') })));
    });
    req.on('error', e => { file.close(); fs.unlink(destPath, () => {}); reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
    req.end();
  });
}

// -------- atomic rename with retry --------
function renameWithRetry(src, dst, attempts = 10) {
  let delay = 100;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(src, dst); return; }
    catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || i === attempts - 1) throw e;
      const start = Date.now();
      while (Date.now() - start < delay) {}
      delay *= 2;
    }
  }
}

// -------- verification --------
function stripExt(s) { return s ? String(s).replace(/\.[^.\\/]+$/, '') : ''; }
function verifyUpgrade(task) {
  const checks = [];
  const sizeRatio = task.downloaded_bytes / task.entry.orig_filesize;
  checks.push({ name: 'size_within_0.1pct_of_orig_filesize', passed: Math.abs(sizeRatio - 1.0) < 0.001, detail: `${task.downloaded_bytes} / ${task.entry.orig_filesize} = ${sizeRatio.toFixed(6)}` });
  checks.push({ name: 'sha256_differs_from_medium', passed: task.downloaded_sha256 !== task.entry.sha256, detail: `delivered: ${task.downloaded_sha256.slice(0,16)} | medium: ${task.entry.sha256.slice(0,16)}` });
  const payloadBase = stripExt(task.payload_filename);
  const manifestBase = stripExt(task.entry.original_filename);
  checks.push({ name: 'filename_matches_original_filename', passed: payloadBase === manifestBase, detail: `payload: ${task.payload_filename} | manifest: ${task.entry.original_filename}` });
  return { passed: checks.every(c => c.passed), checks };
}

// -------- per-UID download + verify (used by worker pool) --------
async function downloadAndVerify(t, context, state, manifest) {
  // Refresh URL if it's > 25 min old (S3 presigned URLs expire at 30 min)
  const urlAge = Date.now() - (t.url_obtained_at || 0);
  if (urlAge > 25 * 60 * 1000) {
    const dd = await downloadDetailsOriginal(context, state, t.uid);
    if (!dd.payload || !dd.payload.url) {
      t.status = 'error_refresh_url';
      stats.failed++;
      jsonlAppend({ event: 'error_refresh_url', uid: t.uid });
      return;
    }
    t.presigned_url = dd.payload.url;
    t.payload_filename = dd.payload.fileName;
    t.url_obtained_at = Date.now();
  }

  const ext = path.extname(t.entry.saved_path).toLowerCase();
  // .partial suffix keeps the in-flight file out of Google Drive's media-slurp recognizer.
  // Drive only auto-uploads recognized media extensions to Photos (.jpg/.mov/.mp4/.heic/etc.);
  // .partial is treated as a generic file, so it never enters the Photos slurp queue with a
  // garbage filename. Final rename below restores the proper extension atomically.
  const tempPath = path.join(OUT_DIR, `${t.uid}_original_TEMP${ext}.partial`);
  const finalPath = path.join(OUT_DIR, OPTS.commit ? path.basename(t.entry.saved_path) : `${t.uid}_original${ext}`);

  try {
    const start = Date.now();
    const { bytes, sha256 } = await s3DownloadStream(t.presigned_url, tempPath);
    const sec = (Date.now() - start) / 1000;
    const mbps = (bytes / 1024 / 1024) / sec;
    t.downloaded_bytes = bytes;
    t.downloaded_sha256 = sha256;
    t.temp_path = tempPath;
    t.download_seconds = sec;

    const v = verifyUpgrade(t);
    if (!v.passed) {
      t.status = 'verification_failed';
      try { fs.unlinkSync(tempPath); } catch (e) {}
      jsonlAppend({ event: 'verification_failed', uid: t.uid, checks: v.checks });
      stats.failed++;
      console.log(`  ${t.uid.padEnd(20)} ✗ verification failed`);
      return;
    }

    if (OPTS.commit) {
      const libPath = t.entry.saved_path;
      const bakPath = libPath + '.medium.bak';
      try {
        if (fs.existsSync(libPath)) renameWithRetry(libPath, bakPath);
        renameWithRetry(tempPath, libPath);
        const entry = t.entry;
        entry.quality = 'original';
        entry.medium_bytes = entry.bytes;
        entry.medium_sha256 = entry.sha256;
        entry.bytes = bytes;
        entry.sha256 = sha256;
        entry.upgrade = { requested_at: t.thaw_started_at || null, completed_at: nowIso() };
        if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
        t.status = 'committed';
        stats.committed++;
        jsonlAppend({ event: 'committed', uid: t.uid, lib_path: libPath, bytes, sha256, mbps: mbps.toFixed(1) });
        console.log(`  ${t.uid.padEnd(20)} ✓ ${bytes.toLocaleString()}B (${mbps.toFixed(1)} MB/s) → committed`);

        // Periodic manifest checkpoint every N commits so a crash mid-bulk doesn't lose state
        if (stats.committed % 25 === 0) {
          try {
            const tmp = MANIFEST + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
            renameWithRetry(tmp, MANIFEST);
            console.log(`[upgrade] manifest checkpoint @ ${stats.committed} commits`);
          } catch (e) {
            console.log(`[upgrade] manifest checkpoint failed: ${e.message}`);
          }
        }
      } catch (e) {
        t.status = 'error_commit';
        t.error = e.message;
        stats.failed++;
        jsonlAppend({ event: 'error_commit', uid: t.uid, reason: e.message });
        console.log(`  ${t.uid.padEnd(20)} ✗ commit failed: ${e.message}`);
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (er) {}
      }
    } else {
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      renameWithRetry(tempPath, finalPath);
      t.test_path = finalPath;
      t.status = 'verified_test_only';
      stats.verified++;
      jsonlAppend({ event: 'downloaded', uid: t.uid, bytes, sha256, verified: true });
      console.log(`  ${t.uid.padEnd(20)} ✓ ${bytes.toLocaleString()}B (${mbps.toFixed(1)} MB/s) → ${path.basename(finalPath)}`);
    }
  } catch (e) {
    t.status = 'error_download';
    t.error = e.message;
    stats.failed++;
    try { fs.unlinkSync(tempPath); } catch (er) {}
    jsonlAppend({ event: 'error_download', uid: t.uid, reason: e.message });
    console.log(`  ${t.uid.padEnd(20)} ✗ download failed: ${e.message}`);
  }
}

// -------- main pipeline --------
async function main() {
  startHeartbeat();
  console.log('[upgrade] mode:', OPTS.commit ? 'COMMIT (will modify library)' : 'TEST (no library changes)');
  console.log('[upgrade] options:', JSON.stringify({
    api_rate_ms: OPTS.apiRateMs, download_concurrency: OPTS.downloadConcurrency,
    unfreeze_batch_size: OPTS.unfreezeBatchSize, heartbeat_secs: OPTS.heartbeatSecs,
    skip_status_check: OPTS.skipStatusCheck, watch: OPTS.watch,
    poll_secs: OPTS.pollSecs, max_wait_min: OPTS.maxWaitMin,
  }));
  console.log('[upgrade] output dir:', OUT_DIR);
  console.log('[upgrade] JSONL log:', JSONL);

  const manifest = loadManifest();
  const uids = pickUIDs(manifest);
  console.log(`[upgrade] selected ${uids.length} UID(s) for upgrade`);
  if (uids.length === 0) { stopHeartbeat(); console.error('No UIDs selected.'); process.exit(1); }

  const tasks = uids.map(uid => {
    const entry = manifest.entries[uid];
    if (!entry) return null;
    return { uid, entry, status: 'pending' };
  }).filter(Boolean);

  stats.total = tasks.length;
  stats.phase = 'sniff_creds';
  console.log('[upgrade] sniffing creds...');
  const { browser, context, state } = await sniffCreds();
  console.log('[upgrade] creds ok\n');

  try {
    // ---- Phase 1: status check (skippable) ----
    if (!OPTS.skipStatusCheck) {
      stats.phase = 'status_check';
      console.log('[upgrade] === Phase 1: checking thaw status ===');
      for (const t of tasks) {
        const dd = await downloadDetailsOriginal(context, state, t.uid);
        if (dd.status !== 200 || !dd.payload || !dd.payload.url) {
          t.status = 'error_get_url';
          stats.failed++;
          jsonlAppend({ event: 'error_get_url', uid: t.uid });
          console.log(`  ${t.uid.padEnd(20)} ERROR getting URL`);
          continue;
        }
        t.presigned_url = dd.payload.url;
        t.payload_filename = dd.payload.fileName;
        t.payload_filesize = dd.payload.fileSize;
        t.url_obtained_at = Date.now();
        const rc = await s3RangeCheck(dd.payload.url);
        if (rc.status === 206) {
          t.status = 'ready_for_download';
          stats.ready_for_download++;
          console.log(`  ${t.uid.padEnd(20)} thawed (${dd.payload.fileSize.toLocaleString()} B)`);
        } else if (rc.status === 403) {
          t.status = 'frozen';
          stats.thawing++;
          console.log(`  ${t.uid.padEnd(20)} frozen (${dd.payload.fileSize.toLocaleString()} B)`);
        } else {
          t.status = 'error_range_check';
          stats.failed++;
        }
        jsonlAppend({ event: 'status_check', uid: t.uid, state: t.status, size: dd.payload.fileSize });
      }
    } else {
      console.log('[upgrade] Phase 1 skipped (--skip-status-check). All UIDs treated as frozen.');
      for (const t of tasks) { t.status = 'frozen'; }
      stats.thawing = tasks.length;
    }

    // ---- Phase 2: batched unfreeze ----
    const toUnfreeze = tasks.filter(t => t.status === 'frozen');
    if (toUnfreeze.length > 0) {
      stats.phase = 'unfreeze';
      const batches = [];
      for (let i = 0; i < toUnfreeze.length; i += OPTS.unfreezeBatchSize) {
        batches.push(toUnfreeze.slice(i, i + OPTS.unfreezeBatchSize));
      }
      console.log(`\n[upgrade] === Phase 2: unfreezing ${toUnfreeze.length} UIDs in ${batches.length} batch(es) of up to ${OPTS.unfreezeBatchSize} ===`);
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const r = await unfreezeMoments(context, state, batch.map(t => t.uid));
        const success = r.success;
        console.log(`  batch ${b + 1}/${batches.length} (${batch.length} UIDs) status=${r.status} success=${success}`);
        jsonlAppend({ event: 'unfreezeMoments_batch', batch_index: b, uids: batch.map(t => t.uid), result: r.body && r.body.result });
        if (success) {
          for (const t of batch) {
            t.status = 'thawing';
            t.thaw_started_at = nowIso();
          }
        }
      }
    }

    // ---- Early exit for --unfreeze-only ----
    if (OPTS.unfreezeOnly) {
      const thawingCount = tasks.filter(t => t.status === 'thawing').length;
      console.log(`\n[upgrade] --unfreeze-only: ${thawingCount} UID(s) queued for Glacier restore. Exiting.`);
      console.log(`[upgrade] Re-run without --unfreeze-only in ~3-5 hours to download. Glacier retention is 24h after thaw.`);
      jsonlAppend({ event: 'unfreeze_only_complete', queued: thawingCount });
      await browser.close();
      return;
    }

    // ---- Phase 3+4: producer (poll) + consumer (download) ----
    const downloadQueue = [];
    let producerDone = false;

    // Seed queue with any already-ready tasks
    for (const t of tasks) {
      if (t.status === 'ready_for_download') downloadQueue.push(t);
    }

    // Worker pool — always spawned, even with no thawing tasks (drains initial queue)
    const workers = [];
    for (let i = 0; i < OPTS.downloadConcurrency; i++) {
      workers.push((async () => {
        while (true) {
          if (downloadQueue.length === 0) {
            if (producerDone) break;
            await sleep(2000);
            continue;
          }
          const t = downloadQueue.shift();
          stats.ready_for_download = downloadQueue.length;
          stats.downloading++;
          try { await downloadAndVerify(t, context, state, manifest); }
          finally { stats.downloading--; }
        }
      })());
    }

    // Producer: only runs if --watch and there are thawing tasks
    if (OPTS.watch && tasks.some(t => t.status === 'thawing')) {
      stats.phase = 'poll_and_download';
      console.log(`\n[upgrade] === Phase 3+4: polling + downloading (max wait ${OPTS.maxWaitMin}min, concurrency ${OPTS.downloadConcurrency}) ===`);
      const waitStart = Date.now();
      let cycleCount = 0;

      while (true) {
        cycleCount++;
        const thawingTasks = tasks.filter(t => t.status === 'thawing');
        if (thawingTasks.length === 0) break;
        if ((Date.now() - waitStart) > OPTS.maxWaitMin * 60 * 1000) {
          console.log('[upgrade] max wait reached');
          break;
        }
        console.log(`[upgrade] poll cycle ${cycleCount}: checking ${thawingTasks.length} thawing UIDs`);
        for (const t of thawingTasks) {
          if ((Date.now() - waitStart) > OPTS.maxWaitMin * 60 * 1000) break;
          if (t.status !== 'thawing') continue;
          const dd = await downloadDetailsOriginal(context, state, t.uid);
          if (!dd.payload || !dd.payload.url) continue;
          t.presigned_url = dd.payload.url;
          t.payload_filename = dd.payload.fileName;
          t.payload_filesize = dd.payload.fileSize;
          t.url_obtained_at = Date.now();
          const rc = await s3RangeCheck(dd.payload.url);
          if (rc.status === 206) {
            t.status = 'ready_for_download';
            stats.thawing = Math.max(0, stats.thawing - 1);
            downloadQueue.push(t);
            stats.ready_for_download = downloadQueue.length;
            const waitMin = Math.round((Date.now() - Date.parse(t.thaw_started_at || nowIso())) / 60000);
            console.log(`  ${t.uid.padEnd(20)} THAWED (after ${waitMin} min) → queued`);
            jsonlAppend({ event: 'thawed', uid: t.uid, wait_min: waitMin });
          }
        }
        const stillThawing = tasks.filter(t => t.status === 'thawing').length;
        if (stillThawing === 0) break;
        console.log(`[upgrade] cycle ${cycleCount} done: ${stillThawing} still thawing, queue=${downloadQueue.length}, sleeping ${OPTS.pollSecs}s`);
        await sleep(OPTS.pollSecs * 1000);
      }
    }

    producerDone = true;
    if (workers.length > 0) {
      console.log('[upgrade] producer done, draining workers...');
      await Promise.all(workers);
    }

    // ---- Phase 5: persist manifest (commit mode only) ----
    if (OPTS.commit) {
      stats.phase = 'persist_manifest';
      const committedCount = tasks.filter(t => t.status === 'committed').length;
      if (committedCount > 0) {
        const tmp = MANIFEST + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
        renameWithRetry(tmp, MANIFEST);
        console.log(`[upgrade] manifest updated (${committedCount} entries changed)`);
      }
    }

    stats.phase = 'done';
    console.log('\n[upgrade] === SUMMARY ===');
    const summary = {};
    for (const t of tasks) summary[t.status] = (summary[t.status] || 0) + 1;
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(28)} ${v}`);
    console.log(`  total api calls            ${stats.apiCalls}`);
    console.log(`\n[upgrade] JSONL log: ${JSONL}`);
    console.log(`[upgrade] Files in: ${OUT_DIR}`);
  } finally {
    stopHeartbeat();
    await context.close();
    await browser.close();
  }
}

main().catch(err => { stopHeartbeat(); console.error('FATAL', err.stack || err); process.exit(1); });
