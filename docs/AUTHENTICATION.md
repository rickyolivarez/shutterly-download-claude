# Authentication

How the project handles Shutterfly's authentication without re-implementing the login flow.

## Goal

To make API calls to `photos-api3.shutterfly.com/photos/json`, we need two short-lived secrets:

1. **JWT** — a signed token issued by AWS Cognito. Includes user identity, expires every few hours. Goes in `Authorization: Bearer <jwt>` and is also sent as the first positional param of every JSON-RPC body.
2. **X-API-Key** — a separate API gateway key. Goes in the `X-API-Key` header. Less sensitive than the JWT but still required.

These are *not* the same as your email/password. Shutterfly's SPA exchanges your password for them via AWS Cognito on login, then re-uses them for every API call until they expire, at which point it silently refreshes them using cookies that live for weeks.

We don't try to re-implement the Cognito flow. Instead, we let a real browser do the login once, save the resulting cookies, then re-use them.

## The trick: sniffing the JWT from the SPA's own traffic

Every time the SPA at `photos3.shutterfly.com/library` loads, it fires several authenticated API calls (`getStartupInfo`, `searchMoments`, `getLifeFeatureFlows`, etc). Each one sends the JWT both as a header AND as `params[0]` of the JSON-RPC body.

We launch Playwright headless with the saved cookies, navigate to `/library`, and listen on every outgoing request:

```js
const state = { jwt: null, apiKey: null };
context.on('request', req => {
  if (!/photos-api3\.shutterfly\.com\/photos\/json/.test(req.url())) return;

  // JWT is in body.params[0] (always starts with "eyJ" — base64-encoded JWT header)
  const body = req.postData();
  if (body) {
    const j = JSON.parse(body);
    if (Array.isArray(j.params) && typeof j.params[0] === 'string' && j.params[0].startsWith('eyJ')) {
      state.jwt = j.params[0];
    }
  }
  // X-API-Key is in headers
  const h = req.headers();
  if (h['x-api-key']) state.apiKey = h['x-api-key'];
});

// Trigger the SPA to fire its background RPC calls
await page.goto('https://photos3.shutterfly.com/library');

// Wait until both have been observed
const start = Date.now();
while ((!state.jwt || !state.apiKey) && Date.now() - start < 45000) await sleep(500);
```

After this, `state.jwt` and `state.apiKey` are populated with fresh, valid credentials.

## Why `params[0]` of the body, not just the header?

The Shutterfly RPC layer **requires the JWT to appear in BOTH places**. The Authorization header alone returns `401 RaiseFault.MissingToken`. We discovered this the hard way (see `docs/MEDIA_UPGRADE.md` diagnostic D5).

So every RPC call has the JWT included twice:

```http
POST /photos/json?method=moment.downloadDetails HTTP/1.1
Authorization: Bearer eyJ...
X-API-Key: <key>

{
  "method": "moment.downloadDetails",
  "params": ["eyJ...", "<uid>", ...],  ← same JWT here
  ...
}
```

## How the cookies got there

`manual_login.js` is the only script that ever shows a non-headless browser:

```js
const browser = await chromium.launch({ headless: false });  // visible window
const context = await browser.newContext({ /* fresh, no storageState */ });
const page = await context.newPage();
await page.goto('https://photos3.shutterfly.com/library');
// Will redirect to accounts.shutterfly.com login page

// You manually:
// - enter email/password (or use the pre-fill helper)
// - solve hCaptcha if it appears
// - complete 2FA / verification email if needed
// - end up at the /library page

// Script polls page.url() until it sees /library
while (!/photos3\.shutterfly\.com\/library/.test(page.url())) {
  await sleep(2000);
}

// Dump the entire state (cookies + localStorage) to auth.json
await context.storageState({ path: 'auth.json' });
```

The resulting `auth.json` is a Playwright-specific JSON format containing:

- All cookies set during the browser session, including `_thislife_session`, `session`, AWS Cognito refresh tokens, etc.
- localStorage entries for `photos3.shutterfly.com` and `accounts.shutterfly.com`

This file is your password-equivalent. **Treat it like a credit card number** — keep it gitignored, don't share it, regenerate by re-running `manual_login.js` if you suspect compromise.

## Cookie lifetime

Empirically, we've observed cookies remaining valid for **several weeks** of inactivity. Concrete data points:

- `auth.json` created on day 0, used for daily downloads through day 7+ without re-login
- Specific cookie expirations in `auth.json`:
  - `_thislife_session`: 1 year
  - `session`: 30 days (rolling)
  - AWS Cognito refresh tokens: 30 days
  - Various tracking/analytics cookies: 1-2 years

The 30-day rolling session cookie is the binding constraint. If you go 30+ days without using the project, you'll need to re-run `manual_login.js`.

## How the downloader extends sessions across long runs

All scripts (`downloader.js`, `upgrade.js`, `scan_and_grab.js`) load cookies the same way: `chromium.launch()` + `newContext({ storageState: AUTH_FILE })`, where `AUTH_FILE` is `./auth.json`. `manual_login.js` is the single source of truth for that file — it runs an interactive Chromium window once, lets you sign in by hand, and saves the resulting `storageState` to disk.

For multi-day runs, the headless context shares Cognito token refresh with the live SPA: every `page.goto('.../library')` triggers the same JWT renewal code path the web app uses. The downloader caches the freshest JWT it sees from network traffic and monitors for 401 responses. When one is detected, `refreshSession()`:

```js
const refreshSession = async () => {
  state.jwt = null;
  // Adding a query string forces Playwright to actually navigate (not cache)
  await page.goto('https://photos3.shutterfly.com/library?_refresh=' + Date.now());
  const start = Date.now();
  while (!state.jwt && Date.now() - start < 30000) await sleep(500);
  if (!state.jwt) throw new Error('failed to re-sniff JWT');
};
```

In practice, 401s during a long run are rare — the SPA refreshes the JWT proactively as it ages. Most multi-day runs never trigger `refreshSession` at all.

## Why this is safe (from a security standpoint)

This project:

1. **Does not bypass any access controls.** It's running with your own credentials, accessing your own account.
2. **Does not transmit credentials anywhere unexpected.** Your email/password go to `accounts.shutterfly.com` in the visible browser during the one-time login. The JWT is sniffed locally from your machine's outgoing network traffic.
3. **Does not log into your account from anywhere else.** No remote server is involved. All scripts run on your machine.
4. **Does not bundle credentials in committed files.** `.env.local` and `auth.json` are gitignored. If you accidentally commit them, immediately revoke the session by logging out of Shutterfly on the web.

## Failure modes and recovery

| Symptom | Likely cause | Fix |
|---|---|---|
| `Failed to sniff JWT / X-API-Key` | Session expired (30+ days idle) | Re-run `manual_login.js` |
| `Browser redirected away from /library` | Login flow demanded fresh 2FA | Re-run `manual_login.js`, complete 2FA, save new auth.json |
| `401 RaiseFault.MissingToken` on every call | JWT not in params[0] of body | Check that your call uses `[jwt, ...other-args]` as params, not just headers |
| `401 RaiseFault.InvalidToken` | JWT has expired mid-run | Should auto-recover via `refreshSession`; if it keeps failing, your `auth.json` is stale — re-run `manual_login.js` |
| Cookies rejected entirely | Account locked out from too many login attempts | Log in via Shutterfly web UI manually, complete any "verify suspicious activity" prompt, then re-run manual_login.js |

## See also

- [`UID_DISCOVERY.md`](UID_DISCOVERY.md) — what we do once we have the JWT
- [`MEDIA_UPGRADE.md`](MEDIA_UPGRADE.md) — using the same auth for the upgrade pipeline
