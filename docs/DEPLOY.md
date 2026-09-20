# Deployment Guide — cookie-refresher

Puppeteer + Express sidecar that refreshes Amazon Pay session cookies
(`cmc`, `rxc`, `ak_bmsc`, `bm_sv`, `aws-waf-token`, `csm-hit`) and extracts
the `csrf-token` meta tag.

This guide covers:

1. Local development
2. Local Docker testing (mirrors Render exactly)
3. Deploying to a single Render account
4. Deploying to **multiple Render accounts** (same repo, different accounts)
5. Wiring the PHP client pool
6. Troubleshooting

---

## 1. Repository layout

```
cookie-refresher/
├── Dockerfile              # Debian slim + system Chromium
├── .dockerignore
├── .gitignore
├── package.json            # main = cookie-refresher.js
├── package-lock.json       # ← MUST be committed (npm ci needs it)
├── cookie-refresher.js     # the sidecar server
├── render.yaml             # 3 web services blueprint
└── docs/
    └── DEPLOY.md           # this file
```

---

## 2. Local development (macOS / Linux)

### Install deps

```bash
rm -rf node_modules package-lock.json
npm install
```

This generates `package-lock.json`. **Commit it** — the Docker build uses
`npm ci`, which fails without a lockfile.

### Run

```bash
npm run dev
# → PORT=3333 HOST=127.0.0.1 CONCURRENCY=1 EPHEMERAL_PROFILE=1 VERBOSE=1 node cookie-refresher.js
```

### Verify

```bash
curl http://127.0.0.1:3333/health
# → {"ok":true,"uptime":1.23,"concurrency":1}
```

### Test a real refresh

```bash
curl -X POST http://127.0.0.1:3333/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "cookies": "session-id=YOUR_REAL_SESSION_ID; ubid-acbin=...",
    "category": "ELECTRICITY",
    "billerId": "YOUR_BILLER_ID"
  }' | jq
```

Expected:

```json
{
  "ok": true,
  "jar": "session-id=...; cmc=...; ak_bmsc=...; bm_sv=...; ...",
  "cookies": { "session-id": "...", "cmc": "..." },
  "added": ["cmc", "ak_bmsc", "bm_sv"],
  "changed": ["session-token"],
  "antiCsrfToken": "...",
  "hasAkamai": true,
  "hasCmc": true,
  "duration": 12345
}
```

If `ok:false`, look at `error` in the response and the server console.

---

## 3. Local Docker testing (mirrors Render)

Build and run the exact image Render will use:

```bash
# Build
docker build -t refresher .

# Run (same env shape as Render)
docker run --rm -p 10000:10000 \
  -e PORT=10000 \
  -e HOST=0.0.0.0 \
  -e CONCURRENCY=1 \
  -e HEADLESS=new \
  -e EPHEMERAL_PROFILE=1 \
  -e VERBOSE=1 \
  -e API_KEY=devkey \
  refresher
```

In another terminal:

```bash
curl http://127.0.0.1:10000/health
curl -X POST http://127.0.0.1:10000/refresh \
  -H "Content-Type: application/json" \
  -H "X-API-Key: devkey" \
  -d '{"cookies":"session-id=...","category":"ELECTRICITY"}'
```

**If Docker works, Render will work** — they run the identical image.

### Common Docker failures

| Error | Fix |
|---|---|
| `spawn /usr/bin/chromium ENOENT` | Dockerfile didn't install chromium; check the `apt-get install` block |
| `error while loading shared libraries: libnss3.so` | Missing lib in Dockerfile — add it to the apt list |
| `npm ci` fails | `package-lock.json` missing or out of sync with `package.json` |
| Container exits immediately, logs show JS error | Bug in `cookie-refresher.js`; run `npm run dev` locally to debug |
| `EADDRINUSE` in logs | `PORT` env not honored; verify `HOST=0.0.0.0` is set |

---

## 4. Deploying to a Render account

### 4.1 Push to GitHub

```bash
git init
git branch -M main
git add .
git commit -m "Initial cookie-refresher sidecar"
git remote add origin git@github.com:YOUR_USER/cookie-refresher.git
git push -u origin main
```

### 4.2 Create the Blueprint

1. Log in to the Render account.
2. **New + → Blueprint**.
3. Connect GitHub → select the `cookie-refresher` repo.
4. Render reads `render.yaml` and shows **3 services**: `refresher-1`, `refresher-2`, `refresher-3`.
5. Click **Apply**.

### 4.3 Set the API key

`render.yaml` sets `API_KEY` with `sync: false`, which means Render creates the
env var placeholder but does **not** read its value from git. You must enter it
manually per service.

1. Open `refresher-1` → **Environment**.
2. Add:
   ```
   API_KEY = some_long_random_string_for_this_account
   ```
3. Repeat for `refresher-2` and `refresher-3`. Use the **same** API key for
   all three services within one account.
4. Save → Render auto-redeploys.

Generate a strong key:

```bash
openssl rand -hex 32
```

### 4.4 Wait for the first build

First build: 4–6 minutes (installing Chromium + libs). Subsequent builds
are much faster thanks to Docker layer caching.

Watch progress under **Logs → Build**.

### 4.5 Verify deployment

Once status is **Live**:

```bash
# health check
curl https://refresher-1.onrender.com/health
# → {"ok":true,"uptime":N,"concurrency":1}

# auth check (should return 401)
curl https://refresher-1.onrender.com/refresh \
  -H "Content-Type: application/json" \
  -d '{}'
# → {"ok":false,"error":"unauthorized"}

# real check
curl -X POST https://refresher-1.onrender.com/refresh \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY_A" \
  -d '{"cookies":"session-id=...","category":"ELECTRICITY"}'
```

### 4.6 Copy the URLs

Dashboard → each service → **Settings → URL**. You'll get:

```
https://refresher-1.onrender.com
https://refresher-2.onrender.com
https://refresher-3.onrender.com
```

---

## 5. Deploying to multiple Render accounts

**Goal:** Same repo, multiple Render accounts, each account contributes
3 sidecars to a single PHP round-robin pool.

### 5.1 Why this works

- Render lets any account deploy from any GitHub repo it has access to.
- Service names are globally unique on Render, so when Account B deploys
  `refresher-1`, Render assigns `refresher-1-<random-suffix>` automatically.
- `autoDeploy: true` in `render.yaml` means every `git push` triggers a
  redeploy on **every** account that has the Blueprint. No per-account git work.

### 5.2 Repeat for each additional account

For **Account B**:

1. Log in to Account B.
2. **New + → Blueprint** → connect the **same GitHub repo**.
   - If the repo is private, install the Render GitHub App for Account B's
     GitHub user with access to that repo.
3. Apply → Render creates `refresher-1-xxxx`, `refresher-2-yyyy`, `refresher-3-zzzz`.
4. Set a **different** API key on all three services:
   ```
   API_KEY = account_b_random_string
   ```
5. Copy the URLs (they'll have the random suffixes).

Repeat for **Account C** with `account_c_random_string`.

### 5.3 Verify all accounts respond

```bash
for u in \
  https://refresher-1.onrender.com \
  https://refresher-2.onrender.com \
  https://refresher-3.onrender.com \
  https://refresher-1-xxxx.onrender.com \
  https://refresher-2-yyyy.onrender.com \
  https://refresher-3-zzzz.onrender.com \
  https://refresher-1-aaaa.onrender.com \
  https://refresher-2-bbbb.onrender.com \
  https://refresher-3-cccc.onrender.com ; do
  echo -n "$u → "
  curl -s -o /dev/null -w "%{http_code}\n" "$u/health"
done
```

All should print `200`.

### 5.4 Predictable URLs (optional)

Random suffixes are ugly. Two options:

**Option A — Custom domain per account**
Render Starter+ supports custom domains. Buy a cheap domain
(`refresher.example.com`) and assign:

```
a1.refresher.example.com → refresher-1 (Account A)
a2.refresher.example.com → refresher-2 (Account A)
a3.refresher.example.com → refresher-3 (Account A)
b1.refresher.example.com → refresher-1-xxxx (Account B)
...
```

**Option B — Accept the suffixes**
Just paste them into your PHP pool JSON once. They never change for the
lifetime of the service.

---

## 6. PHP client pool configuration

Your PHP app talks to the sidecars via a pool file, typically:

```
refresher_pool.json
```

Example with all 9 sidecars (3 accounts × 3 services):

```json
{
    "instances": [
        { "url": "https://refresher-1.onrender.com",      "key": "KEY_A" },
        { "url": "https://refresher-2.onrender.com",      "key": "KEY_A" },
        { "url": "https://refresher-3.onrender.com",      "key": "KEY_A" },
        { "url": "https://refresher-1-xxxx.onrender.com", "key": "KEY_B" },
        { "url": "https://refresher-2-yyyy.onrender.com", "key": "KEY_B" },
        { "url": "https://refresher-3-zzzz.onrender.com", "key": "KEY_B" },
        { "url": "https://refresher-1-aaaa.onrender.com", "key": "KEY_C" },
        { "url": "https://refresher-2-bbbb.onrender.com", "key": "KEY_C" },
        { "url": "https://refresher-3-cccc.onrender.com", "key": "KEY_C" }
    ],
    "health_ttl": 90,
    "request_timeout": 180,
    "connect_timeout": 10,
    "debug": false,
    "state_file": "/tmp/refresher_pool_state.json"
}
```

Your existing `refresherPool->refresh($body)` will round-robin across all
9 URLs, skipping unhealthy ones based on `/health` probes cached for
`health_ttl` seconds.

### Notes

- `key` is sent as the `X-API-Key` header (see `callSingleRefresher()`).
- `request_timeout: 180` matches the sidecar's `NAV_TIMEOUT_MS + CMC_WAIT_MS`
  budget. Don't lower it below 120.
- `health_ttl: 90` — probe every 90 s per instance. With 9 instances,
  that's 6 probes/minute. Trivial load.

### Test the pool from PHP

```php
$body = [
    'cookies'   => $this->getCookieString(),
    'category'  => 'ELECTRICITY',
    'billerId'  => $this->billerId,
    'userAgent' => $this->userAgent,
    'headers'   => $this->mobileHeaders,
];
$ok = $this->refreshCookiesViaSidecar();
var_dump($ok, $this->sidecarErr);
```

If all sidecars are down, `$this->sidecarErr` will show
`"bad response: ..."` or `"transport: ..."` — check the sidecars are Live
in the Render dashboard and the API keys match.

---

## 7. Operations

### 7.1 Keeping services warm (free plan only)

Render free web services spin down after 15 min idle. First request after
spin-down takes ~30 s. To prevent cold starts, add a cron on any always-on
host (your PHP box, a VPS, a GitHub Action):

```bash
# crontab -e
*/10 * * * * curl -s -o /dev/null https://refresher-1.onrender.com/health
*/10 * * * * curl -s -o /dev/null https://refresher-2.onrender.com/health
*/10 * * * * curl -s -o /dev/null https://refresher-3.onrender.com/health
# ... repeat for each URL from every account
```

`starter` plan and above do **not** spin down.

### 7.2 Rotating the API key

1. Render dashboard → service → Environment → change `API_KEY`.
2. Save → auto-redeploys (~1 min).
3. Update the corresponding `key` in `refresher_pool.json`.
4. Deploy PHP.

Zero downtime if you do the PHP side right after Render finishes the
redeploy.

### 7.3 Updating code

```bash
git add .
git commit -m "tweak timeout"
git push
```

Every account redeploys in parallel (`autoDeploy: true`). Watch each
account's **Events** tab.

If an account doesn't redeploy automatically (misconfigured GitHub App),
click **Manual Deploy → Deploy latest commit** in that account.

### 7.4 Monitoring

- **Logs**: Dashboard → service → **Logs**. Filter by `[b0]` / `[b1]` to
  separate browser slots.
- **Health**: `/health` returns `{ok, uptime, concurrency}`.
- **Metrics**: Dashboard → **Metrics** tab shows CPU, memory, requests.
  If memory peaks above ~80%, either lower `CONCURRENCY` or upgrade plan.

### 7.5 Scaling

| Symptom | Fix |
|---|---|
| OOM kills (container restarts) | Lower `CONCURRENCY` to 1, or upgrade plan |
| High latency, queue backs up | Add more instances (more accounts, or scale a service) |
| Chrome crashes mid-job | Check `--disable-dev-shm-usage` is in launch args |
| 401 on `/refresh` | API key mismatch between Render env and PHP pool |

---

## 8. Troubleshooting

### Chrome won't launch

```
Error: Failed to launch the browser process!
/usr/bin/chromium: error while loading shared libraries: libXXX.so
```

Add the missing lib to the Dockerfile's `apt-get install` block. Rebuild.

### `npm ci` fails during build

```
npm error The `npm ci` command can only install with an existing package-lock.json
```

`package-lock.json` isn't committed. Run locally:

```bash
rm -rf node_modules package-lock.json
npm install
git add package-lock.json
git commit -m "Add lockfile"
git push
```

### `Target closed` / `Protocol error` on launch

Usually `puppeteer@24` + `puppeteer-extra@3.3.6` incompatibility. Fix:
downgrade puppeteer in `package.json` to `^23.11.1`, regenerate lockfile,
push.

### Response has `ok:false, error:"session-id missing"`

The `cookies` field in the POST body doesn't contain `session-id`. Check
your PHP `getCookieString()` output.

### `csrf-token: (NOT FOUND)`

The detail page HTML didn't contain the meta tag. Causes:
- Session wasn't actually signed in (bad cookies).
- Amazon changed the page layout (update `extractCsrfMeta()` regexes).
- Page didn't finish rendering (`DWELL_MS` too low — bump to 5000).

### `cmc` never appears

`MIN_CMC_LEN=100` is the threshold. If Amazon changed the cookie name or
shortened it, lower the threshold or add the new name to `KEEP` in
`cookie-refresher.js`.

### Health check failing on Render

Render marks a service unhealthy if `/health` fails 3×. Causes:
- Server bound to `127.0.0.1` instead of `0.0.0.0` (check `HOST` env).
- Express crashed on startup — check build logs.
- First build still in progress.

### All 9 sidecars return 401

API key mismatch. Recheck each Render service's `API_KEY` env matches the
`key` in `refresher_pool.json`. Keys are account-specific — don't reuse.

---

## 9. What NOT to do

- ❌ Don't commit `.env` files.
- ❌ Don't commit `package-lock.json` deletions.
- ❌ Don't reuse the same `API_KEY` across Render accounts.
- ❌ Don't use the `free` plan for production (spins down, OOMs easily).
- ❌ Don't set `CONCURRENCY` > 2 on `starter` (memory).
- ❌ Don't edit `render.yaml` service names after first deploy — Render
  treats renamed services as new ones and orphans the old ones.

---

## 10. Quick reference

```bash
# Local dev
npm install
npm run dev

# Local docker
docker build -t refresher .
docker run --rm -p 10000:10000 -e API_KEY=devkey refresher

# Health
curl http://127.0.0.1:10000/health

# Refresh
curl -X POST http://127.0.0.1:10000/refresh \
  -H "Content-Type: application/json" \
  -H "X-API-Key: devkey" \
  -d '{"cookies":"session-id=...","category":"ELECTRICITY"}'

# Deploy
git push   # → auto-redeploys every Render account with this Blueprint
```