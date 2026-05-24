#!/usr/bin/env node
// manual_login.js — one-time interactive login for Shutterfly.
//
// Opens a real (non-headless) Chromium window. You log in by hand, completing
// any 2FA / CAPTCHA challenge. Once the page reaches /library, the script
// saves Playwright's storageState (cookies + localStorage) to ./auth.json.
//
// You only run this once per account, or whenever your session cookies expire
// (typically several weeks). All subsequent scripts read auth.json to inherit
// the authenticated session.
//
// Optionally pre-fills your email/password if SHUTTERFLY_EMAIL / SHUTTERFLY_PASSWORD
// are set in .env.local (or your shell environment). The script does NOT submit
// the form automatically — that's still up to you, so you can handle whatever
// challenge Shutterfly throws at you.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const AUTH_PATH = path.join(ROOT, 'auth.json');
const ENV_PATH = path.join(ROOT, '.env.local');

// ---------- Load .env.local (tiny inline parser, supports CRLF) ----------
function loadEnvLocal() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let val = m[2];
    // Strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

const env = { ...loadEnvLocal(), ...process.env };
const EMAIL = env.SHUTTERFLY_EMAIL || '';
const PASSWORD = env.SHUTTERFLY_PASSWORD || '';

console.log('[manual_login] launching browser');
console.log(`[manual_login] credentials available: email=${!!EMAIL} password=${!!PASSWORD}`);
console.log('[manual_login] you have up to 15 minutes to complete login + any 2FA');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--no-first-run'] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  console.log('[manual_login] navigating to /library (will redirect to login)');
  await page.goto('https://photos3.shutterfly.com/library', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // If we're already logged in, the page will stay at /library
  if (/\/library/.test(page.url())) {
    console.log('[manual_login] already at /library — session may still be valid');
  } else {
    console.log('[manual_login] login page reached');
    if (EMAIL && PASSWORD) {
      // Pre-fill but don't submit — Shutterfly's CAPTCHA / hCaptcha may need your touch
      try {
        await page.fill('input[type="email"], input[name="email"]', EMAIL).catch(()=>{});
        await page.fill('input[type="password"], input[name="password"]', PASSWORD).catch(()=>{});
        console.log('[manual_login] pre-filled email + password. Click Sign In manually.');
      } catch (e) {
        console.log('[manual_login] could not pre-fill — proceed by hand');
      }
    }
  }

  // Wait up to 15 minutes for the URL to become /library (final logged-in state)
  console.log('[manual_login] waiting up to 15 minutes for URL to become /library ...');
  const startWait = Date.now();
  while (!/photos3\.shutterfly\.com\/library/.test(page.url()) && Date.now() - startWait < 15 * 60 * 1000) {
    await sleep(2000);
  }

  if (!/photos3\.shutterfly\.com\/library/.test(page.url())) {
    console.error('[manual_login] TIMEOUT — login did not complete. URL is still:', page.url());
    await browser.close();
    process.exit(2);
  }

  // Reached /library — save session state
  console.log('[manual_login] reached /library. URL:', page.url());
  console.log('[manual_login] saving auth.json');
  const stateStart = Date.now();
  await context.storageState({ path: AUTH_PATH });
  const stateMs = Date.now() - stateStart;
  const stat = fs.statSync(AUTH_PATH);
  console.log(`[manual_login] auth.json written (${stat.size} bytes). Took ${stateMs}ms.`);
  console.log('[manual_login] done. You can now run downloader.js or upgrade.js.');

  await browser.close();
})().catch(err => { console.error('[manual_login] FATAL', err.stack || err); process.exit(1); });
