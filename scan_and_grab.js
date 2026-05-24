// scan_and_grab.js — one-shot cleanup probe for pending video UIDs.
//
// What it does:
//   1. Loads the manifest, finds video entries where quality != 'original'
//   2. Probes each one via moment.downloadDetails + Range GET
//   3. For UIDs returning 206 (thawed): downloads, verifies, commits
//   4. For UIDs returning 403 (cold): logs and skips
//   5. Exits when done — NO waiting loop
//
// When to use:
//   - After a bulk upgrade.js run has stalled on Glacier's slow tail
//   - To capture UIDs that previous runs thawed but didn't commit (within Glacier's 24h
//     warm window)
//   - As a quick "what's available right now" check without committing to a multi-hour run
//
// What it does NOT do:
//   - Trigger unfreezeMoments. Run upgrade.js --unfreeze-only first if your UIDs are cold.
//   - Wait for thaws. Cold UIDs are simply skipped this pass — re-run later.
//
// Usage:
//   node scan_and_grab.js [--commit] [--api-rate-ms <ms>] [--concurrency <N>]
//   node scan_and_grab.js                    # dry-run, won't modify library
//   node scan_and_grab.js --commit           # swap files in ./downloads/ + update manifest
//   node scan_and_grab.js --commit --api-rate-ms 1500
//
// Flags:
//   --commit              Modify library + manifest. Default: dry-run (downloads to temp only).
//   --api-rate-ms <ms>    Min interval between Shutterfly API calls (default 2000 = 2s, 30/min).
//                         The bulk upgrade.js uses 4500. Faster is fine for short scans.
//   --concurrency <N>     Max parallel S3 downloads (default 5).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// -------- paths (all relative to script's own directory) --------
const ROOT      = __dirname;
const MANIFEST  = path.join(ROOT, 'downloads', 'manifest.json');
const JSONL     = path.join(ROOT, 'downloads', 'video_upgrades.jsonl');
const AUTH_FILE = path.join(ROOT, 'auth.json');
const LIB_DIR   = path.join(ROOT, 'downloads');
const TEMP_DIR  = path.join(ROOT, 'downloads', '.scan_tmp');

// -------- args --------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i+1];
      if (!next || next.startsWith('--')) { o[k] = true; }
      else { o[k] = next; i++; }
    }
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const OPTS = {
  commit:      !!args.commit,
  apiRateMs:   Number(args['api-rate-ms'] !== undefined ? args['api-rate-ms'] : 2000),
  concurrency: Number(args.concurrency !== undefined ? args.concurrency : 5),
};

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// -------- helpers --------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowIso() { return new Date().toISOString(); }
function jsonlAppend(rec) { fs.appendFileSync(JSONL, JSON.stringify({ ts: nowIso(), ...rec }) + '\n'); }
function fmtBytes(n) {
  if (n >= 1024**3) return (n/1024**3).toFixed(2)+' GB';
  if (n >= 1024**2) return (n/1024**2).toFixed(1)+' MB';
  if (n >= 1024)    return (n/1024).toFixed(1)+' KB';
  return n+' B';
}
const stripExt = s => s ? String(s).replace(/\.[^.\\/]+$/, '') : '';

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
  if (!state.jwt || !state.apiKey) { await browser.close(); throw new Error('Could not sniff creds. auth.json may have expired.'); }
  return { browser, context, state };
}

function rpcHeaders(state) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${state.jwt}`,
    'X-API-Key': state.apiKey,
    'Origin': 'https://photos3.shutterfly.com',
    'Referer': 'https://photos3.shutterfly.com/',
  };
}

let lastApi = 0;
async function downloadDetailsOriginal(context, state, uid) {
  const wait = Math.max(0, OPTS.apiRateMs - (Date.now() - lastApi));
  if (wait > 0) await sleep(wait);
  lastApi = Date.now();
  const url = 'https://photos-api3.shutterfly.com/photos/json?method=moment.downloadDetails';
  const body = {
    method: 'moment.downloadDetails',
    params: [state.jwt, uid, null, null, null, null, null, true],
    headers: { 'X-SFLY-SubSource': 'library' },
    id: null,
  };
  const r = await context.request.post(url, { data: JSON.stringify(body), headers: rpcHeaders(state), timeout: 30000 });
  const json = await r.json().catch(() => null);
  await r.dispose();
  return json && json.result && json.result.payload;
}

function rangeCheck(url) {
  return new Promise(resolve => {
    try {
      const req = https.request(url, { method: 'GET', headers: { Range: 'bytes=0-1' }, timeout: 10000 }, res => {
        resolve({ status: res.statusCode, contentRange: res.headers['content-range'] || '' });
        res.destroy();
      });
      req.on('error', e => resolve({ status: 0, error: e.code || e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      req.end();
    } catch (e) { resolve({ status: 0, error: e.message }); }
  });
}

async function downloadToTemp(url, destPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const file = fs.createWriteStream(destPath);
    let bytes = 0;
    const t0 = Date.now();
    const req = https.get(url, { timeout: 600000 }, res => {
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.destroy(); file.destroy();
        try { fs.unlinkSync(destPath); } catch (e) {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
      res.pipe(file);
      file.on('finish', () => {
        const sec = Math.max((Date.now() - t0) / 1000, 0.001);
        resolve({ bytes, sha256: hash.digest('hex'), mbps: (bytes/1024/1024/sec).toFixed(1) });
      });
      file.on('error', e => reject(e));
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
  });
}

function renameWithRetry(src, dst, attempts = 5) {
  let delay = 50;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(src, dst); return; }
    catch (e) {
      if (i === attempts - 1) throw e;
      const start = Date.now();
      while (Date.now() - start < delay) {}
      delay *= 2;
    }
  }
}

function verifyUpgrade(downloadedBytes, downloadedSha, payloadFilename, entry) {
  const sizeRatio = downloadedBytes / entry.orig_filesize;
  const sizeOK     = Math.abs(sizeRatio - 1.0) < 0.001;
  const hashOK     = downloadedSha !== entry.sha256;
  const filenameOK = stripExt(payloadFilename) === stripExt(entry.original_filename);
  return { sizeOK, hashOK, filenameOK, sizeRatio };
}

(async () => {
  console.log('Loading manifest + JSONL...');
  const mani = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const committedUids = new Set();
  if (fs.existsSync(JSONL)) {
    for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.event === 'committed' && !e.is_photo_test) committedUids.add(e.uid);
      } catch (err) {}
    }
  }

  const videos = Object.values(mani.entries).filter(e => e.type === 'video');
  const pending = videos.filter(v => v.quality !== 'original' && !committedUids.has(v.uid));
  pending.sort((a, b) => (b.orig_filesize || 0) - (a.orig_filesize || 0));

  console.log(`\nPending video UIDs: ${pending.length}`);
  console.log(`API throttle: ${OPTS.apiRateMs}ms (~${(60000/OPTS.apiRateMs).toFixed(0)}/min)`);
  console.log(`Download concurrency: ${OPTS.concurrency}`);
  console.log(`Mode: ${OPTS.commit ? 'COMMIT (will modify library)' : 'DRY-RUN (no library changes)'}\n`);

  if (pending.length === 0) {
    console.log('Nothing pending. Exiting.');
    return;
  }

  console.log('Sniffing creds...');
  const { browser, context, state } = await sniffCreds();
  console.log('Creds OK\n');

  jsonlAppend({ event: 'scan_started', pending_count: pending.length, api_rate_ms: OPTS.apiRateMs, commit: OPTS.commit });

  const downloadQueue = [];
  const stats = { thawed: 0, cold: 0, errors: 0, downloaded: 0, committed: 0, verif_failed: 0, bytes: 0 };

  // PRODUCER: probe each pending UID once
  console.log('=== Probing pending UIDs ===');
  console.log('(legend: ! = thawed, . = cold, X = error)\n');
  for (let i = 0; i < pending.length; i++) {
    const v = pending[i];
    try {
      const p = await downloadDetailsOriginal(context, state, v.uid);
      if (!p || !p.url) { stats.errors++; process.stdout.write('X'); continue; }
      const rc = await rangeCheck(p.url);
      if (rc.status === 206) {
        stats.thawed++;
        downloadQueue.push({ entry: v, payload: p });
        process.stdout.write('!');
      } else if (rc.status === 403) {
        stats.cold++;
        process.stdout.write('.');
      } else {
        stats.errors++;
        process.stdout.write('?');
      }
    } catch (e) {
      stats.errors++;
      process.stdout.write('X');
    }
    if ((i + 1) % 50 === 0) process.stdout.write(` [${i+1}/${pending.length}]\n`);
  }
  console.log(`\n\nProbe complete:`);
  console.log(`  Thawed (ready): ${stats.thawed}`);
  console.log(`  Cold (Glacier): ${stats.cold}`);
  console.log(`  Errors:         ${stats.errors}`);

  if (downloadQueue.length === 0) {
    console.log('\nNothing thawed. To thaw the cold UIDs, run:');
    console.log('  node upgrade.js --limit 5000 --commit --unfreeze-only --skip-status-check');
    console.log('Then wait 3-5 hours and re-run this script (or upgrade.js --watch).');
    await browser.close();
    jsonlAppend({ event: 'scan_complete', stats });
    return;
  }

  // CONSUMER: parallel downloads
  console.log(`\n=== Downloading ${downloadQueue.length} thawed UIDs (concurrency ${OPTS.concurrency}) ===`);
  const workers = [];
  let qIdx = 0;
  for (let w = 0; w < OPTS.concurrency; w++) {
    workers.push((async () => {
      while (true) {
        const idx = qIdx++;
        if (idx >= downloadQueue.length) break;
        const { entry: v, payload: p } = downloadQueue[idx];
        const tempPath = path.join(TEMP_DIR, v.uid + '.tmp');
        try {
          const dl = await downloadToTemp(p.url, tempPath);
          stats.downloaded++;
          stats.bytes += dl.bytes;
          const vr = verifyUpgrade(dl.bytes, dl.sha256, p.fileName, v);
          if (!vr.sizeOK || !vr.hashOK || !vr.filenameOK) {
            try { fs.unlinkSync(tempPath); } catch (e) {}
            stats.verif_failed++;
            jsonlAppend({ event: 'verification_failed', uid: v.uid, checks: [
              { name: 'size_within_0.1pct_of_orig_filesize', passed: vr.sizeOK, detail: `${dl.bytes} / ${v.orig_filesize} = ${vr.sizeRatio.toFixed(6)}` },
              { name: 'sha256_differs_from_medium', passed: vr.hashOK, detail: `delivered: ${dl.sha256.slice(0,16)} | medium: ${v.sha256.slice(0,16)}` },
              { name: 'filename_matches_original_filename', passed: vr.filenameOK, detail: `payload: ${p.fileName} | manifest: ${v.original_filename}` },
            ]});
            console.log(`  ${v.uid.padEnd(20)} ✗ verification failed`);
            continue;
          }
          if (OPTS.commit) {
            const libPath = v.saved_path;
            const bakPath = libPath + '.medium.bak';
            if (fs.existsSync(libPath)) renameWithRetry(libPath, bakPath);
            renameWithRetry(tempPath, libPath);
            try { fs.unlinkSync(bakPath); } catch (e) {}
            mani.entries[v.uid].bytes = dl.bytes;
            mani.entries[v.uid].sha256 = dl.sha256;
            mani.entries[v.uid].medium_bytes = v.bytes;
            mani.entries[v.uid].medium_sha256 = v.sha256;
            mani.entries[v.uid].quality = 'original';
            mani.entries[v.uid].upgrade = mani.entries[v.uid].upgrade || {};
            mani.entries[v.uid].upgrade.completed_at = nowIso();
            stats.committed++;
            jsonlAppend({ event: 'committed', uid: v.uid, lib_path: libPath, bytes: dl.bytes, sha256: dl.sha256, mbps: dl.mbps });
            console.log(`  ${v.uid.padEnd(20)} ✓ ${fmtBytes(dl.bytes)} (${dl.mbps} MB/s) → committed`);
          } else {
            console.log(`  ${v.uid.padEnd(20)} ✓ ${fmtBytes(dl.bytes)} (dry-run, file kept in .scan_tmp/)`);
          }
        } catch (e) {
          stats.errors++;
          try { fs.unlinkSync(tempPath); } catch (e2) {}
          jsonlAppend({ event: 'error_download', uid: v.uid, error: e.message });
          console.log(`  ${v.uid.padEnd(20)} ERROR: ${e.message}`);
        }
      }
    })());
  }
  await Promise.all(workers);

  // Save manifest
  if (OPTS.commit && stats.committed > 0) {
    console.log('\nSaving manifest...');
    const tmp = MANIFEST + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mani, null, 2));
    renameWithRetry(tmp, MANIFEST);
  }

  await browser.close();

  console.log('\n' + '='.repeat(60));
  console.log('SCAN & GRAB SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Probed:       ${pending.length}`);
  console.log(`  Thawed:       ${stats.thawed}`);
  console.log(`  Cold:         ${stats.cold}  (need fresh unfreeze)`);
  console.log(`  Downloaded:   ${stats.downloaded}`);
  console.log(`  Committed:    ${stats.committed}`);
  console.log(`  Verif failed: ${stats.verif_failed}`);
  console.log(`  Errors:       ${stats.errors}`);
  console.log(`  Bytes added:  ${fmtBytes(stats.bytes)}`);
  jsonlAppend({ event: 'scan_complete', stats });
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
