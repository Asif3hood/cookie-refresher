#!/usr/bin/env node
/**
 * cookie-refresher.js (v23)
 *
 *   Flow:
 *     1. GET /ref=ap_frn_logo/?_encoding=UTF8&ref_=navm_hdr_signin       (signed-in landing)
 *     2. GET /amazonpay/home?ref_=navm_em_navm_pay_btn_0_1_1_14
 *     3. GET /apay/landing/{cat}?ref_=apay_mobhome_V2_{Cat}
 *     4. GET /apay/interstitial/{cat}/{billerId}?ref_=...
 *     5. GET /apay/detail/{cat}?ref_=apay_interstitial_detail_fetch_{cat}
 *     6. Extract  <meta content="XXX" name="csrf-token"/>
 *     7. Harvest cookies from HTTP store + document.cookie + localStorage + sessionStorage
 *
 *   v23 changes:
 *     • EPHEMERAL detection now accepts any truthy value (1, true, yes)
 *     • Clean stale SingletonLock before launching a persistent profile
 *     • Defaults tightened: NAV_TIMEOUT_MS=15000, CMC_WAIT_MS=6000, DWELL_MS=500
 *     • Cookie wait exits early on csrf + any 2 of 3 WAF cookies
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const PORT           = parseInt(process.env.PORT || '3333', 10);
const HOST           = process.env.HOST || '0.0.0.0';
const CONCURRENCY    = parseInt(process.env.CONCURRENCY || '1', 10);
const DEFAULT_PROXY  = process.env.PROXY || null;
const HEADFUL        = process.env.HEADFUL === '1';
const VERBOSE        = process.env.VERBOSE !== '0';

/* ★ v23: accept any truthy value, not just '1' */
const EPHEMERAL      = ['1','true','yes','on'].includes(
    String(process.env.EPHEMERAL_PROFILE || '').toLowerCase()
);

const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '15000', 10);   /* was 25000 */
const CMC_WAIT_MS    = parseInt(process.env.CMC_WAIT_MS    || '6000',  10);   /* was 30000 */
const DWELL_MS       = parseInt(process.env.DWELL_MS       || '500',   10);   /* was 1500  */
const MIN_CMC_LEN    = parseInt(process.env.MIN_CMC_LEN    || '100',   10);
const MAX_BODY       = process.env.MAX_BODY || '512kb';

const HEADLESS_MODE  = process.env.HEADLESS || (HEADFUL ? false : 'new');
const DEFAULT_UA     = 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';

/* ─── Resource blocker ─── */
const BLOCK_TYPES = new Set(['image','media','font','manifest','prefetch']);
const BLOCK_DOMAINS = ['doubleclick.net','googlesyndication.com','google-analytics.com',
  'amazon-adsystem.com','adsystem.com','criteo.com','criteo.net','taboola.com','outbrain.com',
  'rubiconproject.com','pubmatic.com','adnxs.com','demdex.net','facebook.net','fbcdn.net'];
function shouldBlock(url, type) {
  if (BLOCK_TYPES.has(type)) return true;
  const u = url.toLowerCase();
  for (const d of BLOCK_DOMAINS) if (u.includes(d)) return true;
  return false;
}

/* ─── Browser pool ─── */
const SLOTS = Array.from({ length: CONCURRENCY }, (_, i) => ({ idx: i, browser: null, promise: null, dir: null }));

async function launch(i) {
  /* ★ v23: use EPHEMERAL folder OR clean a persistent folder */
  let dir;
  if (EPHEMERAL) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amz-chrome-'));
  } else {
    dir = path.join(__dirname, `.chrome-profile-${i}`);
    if (fs.existsSync(dir)) {
      /* ★ Remove stale SingletonLock + friends before Chrome starts */
      for (const f of ['SingletonLock','SingletonCookie','SingletonSocket']) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
      }
    } else {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/chromium');

  const browser = await puppeteer.launch({
    executablePath,
    headless: HEADLESS_MODE,
    userDataDir: dir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1366,900',
      '--lang=en-GB',
      '--disable-crash-reporter',
      '--disable-features=CrashpadHandler',
      '--disable-breakpad',
    ],
    protocolTimeout: 300000,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  SLOTS[i].dir = dir;
  browser.on('disconnected', () => {
    SLOTS[i].browser = null;
    SLOTS[i].promise = null;
    if (EPHEMERAL && SLOTS[i].dir) {
      try { fs.rmSync(SLOTS[i].dir, { recursive: true, force: true }); } catch (_) {}
      SLOTS[i].dir = null;
    }
  });
  return browser;
}
async function getBrowser(i) {
  const s = SLOTS[i];
  if (s.browser) return s.browser;
  if (s.promise)  return s.promise;
  s.promise = launch(i).then(b => { s.browser = b; return b; });
  return s.promise;
}

/* ─── Cookie helpers ─── */
function parseCookieString(str) {
  const out = {};
  for (const p of String(str).split(';')) {
    const t = p.trim(); if (!t) continue;
    const eq = t.indexOf('='); if (eq === -1) continue;
    const n = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (n) out[n] = v;
  }
  return out;
}
const KEEP = new Set(['session-id','session-id-time','ubid-acbin','i18n-prefs','lc-acbin',
  'sso-state-acbin','sid','at-acbin','sess-at-acbin','sst-acbin','session-token','x-acbin',
  'cmc','rxc','csm-hit','ak_bmsc','bm_sv','aws-waf-token','id_pk','id_pkel','sp-cdn','skin',
  'avcid-amz-uid','ap-fid','csm-sid']);
const ORDER = ['session-id','session-id-time','ubid-acbin','i18n-prefs','lc-acbin',
  'sso-state-acbin','sid','at-acbin','sess-at-acbin','sst-acbin','session-token','x-acbin',
  'cmc','rxc','csm-hit','ak_bmsc','bm_sv','aws-waf-token','id_pk','id_pkel','sp-cdn','skin'];
function filterJar(list) {
  const m = {};
  for (const c of list) if (KEEP.has(c.name)) m[c.name] = c.value;
  const seen = new Set(); const ord = [];
  for (const k of ORDER) if (m[k] !== undefined) { ord.push(k); seen.add(k); }
  for (const k of Object.keys(m)) if (!seen.has(k)) ord.push(k);
  return { map: m, jar: ord.map(k => `${k}=${m[k]}`).join('; ') };
}
const line = (m, t) => {
  const L = n => (m[n] || '').length;
  return `[${t}] waf=${L('aws-waf-token')} ak=${L('ak_bmsc')} bm=${L('bm_sv')} cmc=${L('cmc')} rxc=${L('rxc')} hit=${L('csm-hit')}`;
};
function parseCookieStr(str) {
  const out = {};
  for (const p of String(str || '').split(';')) {
    const t = p.trim(); if (!t) continue;
    const eq = t.indexOf('='); if (eq === -1) continue;
    const n = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (n) out[n] = v;
  }
  return out;
}

/* Read cookies from every storage source */
async function readAllCookies(context, page) {
  const merged = {};
  const sources = {};

  try {
    const httpCookies = (typeof context.cookies === 'function')
      ? await context.cookies()
      : await page.cookies();
    const m = {};
    for (const c of httpCookies) m[c.name] = c.value;
    sources.http = m;
    Object.assign(merged, m);
  } catch (e) { sources.http = { error: e.message }; }

  try {
    const dc = await page.evaluate(() => document.cookie);
    const m = parseCookieStr(dc);
    sources.documentCookie = m;
    for (const [k, v] of Object.entries(m)) {
      if (!merged[k] || merged[k] === '') merged[k] = v;
    }
  } catch (e) { sources.documentCookie = { error: e.message }; }

  try {
    const ls = await page.evaluate(() => {
      const out = {};
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); } } catch (_) {}
      return out;
    });
    sources.localStorage = ls;
    for (const [k, v] of Object.entries(ls)) {
      if (typeof v === 'string' && KEEP.has(k) && (!merged[k] || merged[k] === '')) merged[k] = v;
    }
  } catch (e) { sources.localStorage = { error: e.message }; }

  try {
    const ss = await page.evaluate(() => {
      const out = {};
      try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out[k] = sessionStorage.getItem(k); } } catch (_) {}
      return out;
    });
    sources.sessionStorage = ss;
    for (const [k, v] of Object.entries(ss)) {
      if (typeof v === 'string' && KEEP.has(k) && (!merged[k] || merged[k] === '')) merged[k] = v;
    }
  } catch (e) { sources.sessionStorage = { error: e.message }; }

  return { merged, sources };
}

/* ─── Fingerprint ─── */
async function applyFingerprint(page, ua, headers) {
  const fp = {
    ua,
    acceptLang: 'en-GB,en;q=0.9',
    deviceMemory: '8', dpr: '2', viewport: '991',
    downlink: '10', ect: '4g', rtt: '100',
    secChUa: '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
    secChUaFull: '"Chromium";v="128.0.6613.138", "Not;A=Brand";v="24.0.0.0", "Google Chrome";v="128.0.6613.138"',
    secChUaMobile: '?1',
    secChUaPlatform: '"Android"',
    secChUaPlatformV: '"6.0"',
  };
  if (Array.isArray(headers)) {
    for (const l of headers) {
      if (typeof l !== 'string' || !l.includes(':')) continue;
      const i = l.indexOf(':');
      const k = l.slice(0, i).trim().toLowerCase();
      const v = l.slice(i + 1).trim();
      if (k === 'user-agent')                     fp.ua = v;
      else if (k === 'accept-language')           fp.acceptLang = v;
      else if (k === 'device-memory' || k === 'sec-ch-device-memory') fp.deviceMemory = v.replace(/"/g, '');
      else if (k === 'dpr' || k === 'sec-ch-dpr') fp.dpr = v.replace(/"/g, '');
      else if (k === 'viewport-width' || k === 'sec-ch-viewport-width') fp.viewport = v.replace(/"/g, '');
      else if (k === 'downlink')                  fp.downlink = v.replace(/"/g, '');
      else if (k === 'ect')                       fp.ect = v.replace(/"/g, '');
      else if (k === 'rtt')                       fp.rtt = v.replace(/"/g, '');
      else if (k === 'sec-ch-ua')                 fp.secChUa = v;
      else if (k === 'sec-ch-ua-full-version-list') fp.secChUaFull = v;
      else if (k === 'sec-ch-ua-mobile')          fp.secChUaMobile = v.replace(/"/g, '');
      else if (k === 'sec-ch-ua-platform')        fp.secChUaPlatform = v;
      else if (k === 'sec-ch-ua-platform-version') fp.secChUaPlatformV = v;
    }
  }
  const w = parseInt(fp.viewport, 10) || 991;
  await page.setViewport({ width: w, height: Math.round(w * 0.7), deviceScaleFactor: parseFloat(fp.dpr) || 2 });
  await page.setUserAgent(fp.ua);
  await page.setExtraHTTPHeaders({
    'accept-language': fp.acceptLang,
    'device-memory': fp.deviceMemory, 'dpr': fp.dpr,
    'downlink': fp.downlink, 'ect': fp.ect, 'rtt': fp.rtt,
    'viewport-width': fp.viewport,
    'sec-ch-device-memory': fp.deviceMemory, 'sec-ch-dpr': fp.dpr,
    'sec-ch-ua': fp.secChUa, 'sec-ch-ua-full-version-list': fp.secChUaFull,
    'sec-ch-ua-mobile': fp.secChUaMobile,
    'sec-ch-ua-platform': fp.secChUaPlatform,
    'sec-ch-ua-platform-version': fp.secChUaPlatformV,
    'sec-ch-viewport-width': fp.viewport,
  });
  return fp;
}

/* ─── URL builder — matches your observed browser flow ─── */
function buildUrls(category, billerId) {
  const cat = String(category || 'ELECTRICITY').toUpperCase();
  const catLower = cat.toLowerCase();
  const catTitle = catLower.charAt(0).toUpperCase() + catLower.slice(1);
  const bid = String(billerId || '').trim();

  if (cat === 'PREPAID_RECHARGE' || cat === 'MOBILE_PREPAID' || cat === 'RECHARGE') {
    return {
      signedInLanding: 'https://www.amazon.in/ref=ap_frn_logo/?_encoding=UTF8&ref_=navm_hdr_signin',
      payHome:         'https://www.amazon.in/amazonpay/home?ref_=navm_em_navm_pay_btn_0_1_1_14',
      landing:         'https://www.amazon.in/apay/landing/mobile-prepaid?ref_=apay_mobhome_icon_rechargebills_mobileprepaid',
      interstitial:    null,
      detail:          'https://www.amazon.in/apay/detail/mobile-prepaid?ref_=apay_landing_mobile-prepaid_contact-picker',
      label:           'mobile-prepaid',
    };
  }
  if (cat === 'LPG') {
    return {
      signedInLanding: 'https://www.amazon.in/ref=ap_frn_logo/?_encoding=UTF8&ref_=navm_hdr_signin',
      payHome:         'https://www.amazon.in/amazonpay/home?ref_=navm_em_navm_pay_btn_0_1_1_14',
      landing:         `https://www.amazon.in/apay/landing/lpg?ref_=apay_mobhome_V2_Lpg&ref_=apay_mobhome_icon_rechargebills_lpg`,
      interstitial:    bid ? `https://www.amazon.in/apay/interstitial/lpg/${encodeURIComponent(bid)}?ref_=apay_interstitial_biller_search_to_form_field_lpg` : null,
      detail:          'https://www.amazon.in/apay/detail/lpg?ref_=apay_interstitial_detail_fetch_lpg',
      label:           'lpg',
    };
  }
  /* ELECTRICITY default */
  return {
    signedInLanding: 'https://www.amazon.in/ref=ap_frn_logo/?_encoding=UTF8&ref_=navm_hdr_signin',
    payHome:         'https://www.amazon.in/amazonpay/home?ref_=navm_em_navm_pay_btn_0_1_1_14',
    landing:         `https://www.amazon.in/apay/landing/electricity?ref_=apay_mobhome_V2_Electricity&ref_=apay_mobhome_icon_rechargebills_electricity`,
    interstitial:    bid ? `https://www.amazon.in/apay/interstitial/electricity/${encodeURIComponent(bid)}?ref_=apay_interstitial_biller_search_to_form_field_electricity` : null,
    detail:          'https://www.amazon.in/apay/detail/electricity?ref_=apay_interstitial_detail_fetch_electricity',
    label:           'electricity',
  };
}

/* ─── CSRF extraction from <meta content="..." name="csrf-token"/> ─── */
function extractCsrfMeta(html) {
  if (!html || typeof html !== 'string') return null;

  /* Primary: <meta content="XXX" name="csrf-token"/>  and  <meta name="csrf-token" content="XXX"/> */
  let m = html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)
       || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i);
  if (m && m[1]) {
    const t = m[1].trim();
    if (t.length >= 20) return t;
  }

  /* Fallbacks */
  const fallbacks = [
    /<meta[^>]*name=["']anti-csrftoken-a2z["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']anti-csrftoken-a2z["']/i,
    /<input[^>]*name=["']anti-csrftoken-a2z["'][^>]*value=["']([^"']+)["']/i,
    /"anti-csrftoken-a2z"\s*:\s*"([^"]{20,})"/i,
    /"csrfToken"\s*:\s*"([^"]{20,})"/i,
    /data-a-state=['"]([^'"]+)['"]/i,
  ];
  for (const p of fallbacks) {
    const mm = html.match(p);
    if (!mm) continue;
    let raw = mm[1];
    if (raw[0] === '{' || raw.includes('&quot;') || raw[0] === '%') {
      const dec = raw[0] === '%' ? decodeURIComponent(raw) : raw.replace(/&quot;/g, '"');
      const inner = dec.match(/anti-?csrftoken-?a2z["']?\s*:\s*["']([^"']{20,})["']/i)
                 || dec.match(/csrfToken["']?\s*:\s*["']([^"']{20,})["']/i);
      if (inner) return inner[1].trim();
    }
    let t = raw.trim();
    if (t.includes('?')) t = t.split('?')[0];
    if (t.length >= 20) return t;
  }
  return null;
}

/* ─── Core refresh ─── */
async function refresh({ cookies, proxy, userAgent, headers, category = 'ELECTRICITY', billerId = '', idx = 0 }) {
  const jarIn = parseCookieString(cookies);
  if (!jarIn['session-id']) return { ok: false, error: 'session-id missing' };

  const urls = buildUrls(category, billerId);
  const t0 = Date.now();
  const browser = await getBrowser(idx);
  const useProxy = proxy || DEFAULT_PROXY;
  const ua = userAgent || DEFAULT_UA;

  const context = typeof browser.createBrowserContext === 'function'
    ? await browser.createBrowserContext()
    : await browser.createIncognitoBrowserContext();

  let page;
  let csrfToken = null;

  try {
    page = await context.newPage();
    await applyFingerprint(page, ua, headers);

    await page.setRequestInterception(true);
    page.on('request', req => {
      try { return shouldBlock(req.url(), req.resourceType()) ? req.abort() : req.continue(); }
      catch (_) {}
    });

    if (VERBOSE) {
      page.on('response', async resp => {
        const u = resp.url();
        if (u.includes('com.amazon.csm.csa.prod') || u.includes('/1/events/com.amazon.csm')) {
          try {
            const body = await resp.text().catch(() => '');
            const snippet = body.slice(0, 100).replace(/\s+/g, ' ');
            console.log(`[b${idx}] [csm] ${resp.status()} ${u.slice(0, 55)}  body: ${snippet}`);
          } catch (_) {}
        }
      });
    }

    if (useProxy) {
      try {
        const u = new URL(useProxy);
        if (u.username) await page.authenticate({
          username: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password),
        });
      } catch (_) {}
    }

    /* Inject account cookies FIRST (before any nav) */
    const seed = [];
    for (const [n, v] of Object.entries(jarIn)) {
      if (n === 'cmc') continue;
      seed.push({ name: n, value: v, domain: '.amazon.in', path: '/', secure: true });
    }

    try { await page.goto('https://www.amazon.in/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); } catch (_) {}
    if (typeof context.setCookie === 'function')   await context.setCookie(...seed);
    else if (typeof page.setCookie === 'function') await page.setCookie(...seed);
    console.log(`[b${idx}] seeded ${seed.length} cookies`);

    /* P1 — signed-in landing */
    console.log(`[b${idx}] === P1 signed-in landing ===`);
    try { await page.goto(urls.signedInLanding, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); } catch (_) {}
    await new Promise(r => setTimeout(r, DWELL_MS));
    let r = await readAllCookies(context, page);
    console.log(`[b${idx}] ${line(r.merged, 'after-P1')}`);

    /* P2 — amazonpay/home */
    console.log(`[b${idx}] === P2 amazonpay/home ===`);
    try { await page.goto(urls.payHome, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); } catch (_) {}
    await new Promise(r => setTimeout(r, DWELL_MS));
    r = await readAllCookies(context, page);
    console.log(`[b${idx}] ${line(r.merged, 'after-P2')}`);

    /* P3 — category landing */
    console.log(`[b${idx}] === P3 landing/${urls.label} ===`);
    try { await page.goto(urls.landing, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); } catch (_) {}
    await new Promise(r => setTimeout(r, DWELL_MS));
    r = await readAllCookies(context, page);
    console.log(`[b${idx}] ${line(r.merged, 'after-P3')}`);

    /* P4 — interstitial (biller specific) */
    if (urls.interstitial) {
      console.log(`[b${idx}] === P4 interstitial/${urls.label}/${billerId} ===`);
      try { await page.goto(urls.interstitial, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); } catch (_) {}
      await new Promise(r => setTimeout(r, DWELL_MS));
    }

    /* P5 — detail page */
    console.log(`[b${idx}] === P5 detail/${urls.label} ===`);
    try { await page.goto(urls.detail, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); } catch (_) {}
    await new Promise(r => setTimeout(r, DWELL_MS));

    /* Extract csrf-token from the rendered HTML */
    try {
      const html = await page.content();
      csrfToken = extractCsrfMeta(html);
      if (VERBOSE) {
        console.log(`[b${idx}] csrf-token: ${csrfToken ? csrfToken.slice(0, 50) + '…' : '(NOT FOUND)'}`);
      }
    } catch (_) {}

    /* ═══════════════════════════════════════════════
     * Wait for cookies to settle
     *   • Break immediately on CMC
     *   • Break when csrf + at least 2 of 3 WAF cookies are present
     *   • Fallback: bm_sv + csrf alone is sufficient
     * ═══════════════════════════════════════════════ */
    const deadline = Date.now() + CMC_WAIT_MS;
    let iter = 0;
    while (Date.now() < deadline) {
      iter++;
      r = await readAllCookies(context, page);

      const hasCmc = r.merged.cmc && r.merged.cmc.length >= MIN_CMC_LEN;
      const hasAk  = !!r.merged.ak_bmsc;
      const hasBm  = !!r.merged.bm_sv;
      const hasWaf = !!r.merged['aws-waf-token'];

      if (hasCmc) {
        if (VERBOSE) console.log(`[b${idx}] cookie-wait done at iter ${iter}: cmc present`);
        break;
      }

      const wafCount = [hasAk, hasBm, hasWaf].filter(Boolean).length;
      if (csrfToken && wafCount >= 2) {
        if (VERBOSE) console.log(`[b${idx}] cookie-wait done at iter ${iter}: csrf=yes ak=${hasAk} bm=${hasBm} waf=${hasWaf}`);
        break;
      }

      if (hasBm && csrfToken) {
        if (VERBOSE) console.log(`[b${idx}] cookie-wait done at iter ${iter}: bm_sv + csrf, proceeding`);
        break;
      }

      await new Promise(res => setTimeout(res, 300));
    }

    if (VERBOSE && iter > 1) {
      r = await readAllCookies(context, page);
      console.log(`[b${idx}] cookie-wait finished after ${iter} iter(s)  ${line(r.merged, 'settled')}`);
    }

    r = await readAllCookies(context, page);
    console.log(`[b${idx}] ${line(r.merged, 'done')}  ${Date.now() - t0}ms`);

    if (VERBOSE) {
      const s = r.sources;
      console.log(`[b${idx}] storage: http=${Object.keys(s.http||{}).length} dc=${Object.keys(s.documentCookie||{}).length} ls=${Object.keys(s.localStorage||{}).length} ss=${Object.keys(s.sessionStorage||{}).length}`);
    }

    const outMap = r.merged;
    const filtered = filterJar(Object.entries(outMap).map(([name, value]) => ({ name, value })));

    const added   = Object.keys(outMap).filter(k => jarIn[k] === undefined || jarIn[k] === '');
    const changed = Object.keys(outMap).filter(k => jarIn[k] !== undefined && jarIn[k] !== outMap[k]);

    return {
      ok: true,
      jar: filtered.jar,
      cookies: filtered.map,
      added, changed,
      cmc:     outMap.cmc     || '',
      rxc:     outMap.rxc     || '',
      ak_bmsc: outMap.ak_bmsc || '',
      bm_sv:   outMap.bm_sv   || '',
      csmHit:  outMap['csm-hit'] || '',
      wafToken: outMap['aws-waf-token'] || '',
      antiCsrfToken: csrfToken || '',
      hasAkamai: !!(outMap.ak_bmsc && outMap.bm_sv),
      hasCmc:    !!(outMap.cmc && outMap.cmc.length >= MIN_CMC_LEN),
      category: category,
      billerId: billerId,
      duration: Date.now() - t0,
    };
  } finally {
    try { if (page) await page.close(); } catch (_) {}
    try { await context.close(); } catch (_) {}
  }
}

/* ─── HTTP server ─── */
const app = express();
app.use(express.json({ limit: MAX_BODY }));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), concurrency: CONCURRENCY }));

const queues = Array.from({ length: CONCURRENCY }, () => Promise.resolve());
let rr = 0;

app.post('/refresh', (req, res) => {
  const { cookies, proxy, userAgent, headers, category, billerId } = req.body || {};
  if (!cookies || typeof cookies !== 'string')
    return res.status(400).json({ ok: false, error: 'cookies field required' });
  const idx = rr++ % CONCURRENCY;
  const task = () => refresh({ cookies, proxy, userAgent, headers, category, billerId, idx });
  const p = queues[idx].then(task, task);
  queues[idx] = p.then(() => {}, () => {});
  p.then(r => res.json(r))
   .catch(err => res.status(500).json({ ok: false, error: err?.message || String(err) }));
});

const server = app.listen(PORT, HOST, async () => {
  console.log(`[cookie-refresher] listening on http://${HOST}:${PORT}  concurrency=${CONCURRENCY}  ephemeral=${EPHEMERAL}`);
  for (let i = 0; i < CONCURRENCY; i++) await getBrowser(i);
  console.log('[cookie-refresher] pool ready');
});

async function shutdown() {
  try { server.close(); } catch (_) {}
  for (const s of SLOTS) try { if (s.browser) await s.browser.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', e => console.error('[uncaught]', e));
process.on('unhandledRejection', e => console.error('[unhandled]', e));