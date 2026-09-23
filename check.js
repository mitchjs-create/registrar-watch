#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { notify } = require('./notify');

const ROOT = __dirname;
const STATE_PATH = path.join(ROOT, 'state.json');
const DEBUG_DIR = path.join(ROOT, 'debug');

const args = process.argv.slice(2);
const DISCOVER = args.includes('--discover');
const HEADED = args.includes('--headed');
const siteArg = (args.find((a) => a.startsWith('--site=')) || '').split('=')[1];

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const settings = config.settings || {};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/* ---------------------------------------------------------------- state -- */

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { sites: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

/* ------------------------------------------------------------ date utils -- */

const RE_ISO = /(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/;
const RE_UK = /\b([0-3]?\d)\/([01]?\d)\/(20\d{2})\b/;
const RE_MS = /\/Date\((\d{10,13})/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function normaliseDate(value) {
  if (value == null) return null;
  if (typeof value === 'number' && value > 1e12) {
    const d = new Date(value);
    if (!isNaN(d)) return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(value);
  let m = s.match(RE_MS);
  if (m) {
    const d = new Date(Number(m[1].length === 10 ? m[1] * 1000 : m[1]));
    if (!isNaN(d)) return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  m = s.match(RE_ISO);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(RE_UK);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function inWindow(date) {
  if (date < today()) return false;
  if (settings.windowStart && date < settings.windowStart) return false;
  if (settings.windowEnd && date > settings.windowEnd) return false;
  return true;
}

function prettyDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/* --------------------------------------------------- JSON payload walking -- */

// Availability payloads vary between deployments, so rather than guessing a
// schema we walk the whole object and keep anything date-shaped, recording the
// key path it came from. Discover mode prints those paths so the extraction can
// be tightened to the one or two that actually mean "bookable".

function walkForDates(node, keyPath, found, depth) {
  if (depth > 12 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForDates(item, `${keyPath}[]`, found, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    const looksUnavailable =
      node.available === false ||
      node.isAvailable === false ||
      node.IsAvailable === false ||
      node.bookable === false;
    if (looksUnavailable) return;
    for (const [k, v] of Object.entries(node)) {
      walkForDates(v, keyPath ? `${keyPath}.${k}` : k, found, depth + 1);
    }
    return;
  }
  const iso = normaliseDate(node);
  if (iso) found.push({ date: iso, keyPath, raw: String(node).slice(0, 60) });
}

function extractFromPayload(payload) {
  const found = [];
  walkForDates(payload, '', found, 0);
  return found;
}

/* -------------------------------------------------------- DOM extraction -- */

// Fallback for when availability is rendered straight into the calendar markup
// rather than fetched as JSON.
async function extractFromDom(page) {
  return page.evaluate(() => {
    const results = [];
    const candidates = document.querySelectorAll(
      '[data-date], [data-day], td[class*="avail" i], button[class*="avail" i], a[class*="avail" i], .fc-day, [role="gridcell"]'
    );
    for (const el of candidates) {
      const cls = (el.className || '').toString().toLowerCase();
      const disabled =
        el.hasAttribute('disabled') ||
        el.getAttribute('aria-disabled') === 'true' ||
        /disabled|unavail|notavail|no-avail|past|blocked|full/.test(cls);
      if (disabled) continue;
      const hint =
        el.getAttribute('data-date') ||
        el.getAttribute('data-day') ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.textContent.trim();
      if (hint) results.push({ hint: hint.slice(0, 80), cls: cls.slice(0, 80) });
    }
    return results;
  });
}

/* ------------------------------------------------------------ step runner -- */

async function runStep(page, step) {
  const timeout = step.timeout || 20000;
  switch (step.action) {
    case 'click':
      if (step.selector) await page.locator(step.selector).first().click({ timeout });
      else await page.getByText(step.text, { exact: !!step.exact }).first().click({ timeout });
      break;
    case 'select':
      await page.locator(step.selector).selectOption(
        step.value !== undefined ? { value: step.value } : { label: step.label },
        { timeout }
      );
      break;
    case 'fill':
      await page.locator(step.selector).fill(step.value, { timeout });
      break;
    case 'check':
      await page.locator(step.selector).first().check({ timeout });
      break;
    case 'wait':
      await page.waitForTimeout(step.ms || 2000);
      break;
    case 'waitFor':
      await page.locator(step.selector).first().waitFor({ timeout });
      break;
    default:
      throw new Error(`Unknown step action: ${step.action}`);
  }
  await page.waitForTimeout(step.settle || 1500);
}

/* -------------------------------------------------------------- one site -- */

async function checkSite(browser, site) {
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1280, height: 1600 },
  });
  const page = await context.newPage();
  const captured = [];

  page.on('response', async (res) => {
    const url = res.url();
    if (/\.(png|jpe?g|gif|svg|woff2?|ttf|css|ico)(\?|$)/i.test(url)) return;
    const type = (res.headers()['content-type'] || '').toLowerCase();
    if (!type.includes('json') && !type.includes('javascript') && !type.includes('text/plain')) return;
    try {
      const text = await res.text();
      if (!text || text.length > 800000) return;
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        return; // not JSON, ignore
      }
      captured.push({ url, method: res.request().method(), payload, raw: text });
    } catch {
      /* body already consumed or request aborted */
    }
  });

  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);

    for (const step of site.steps || []) {
      await runStep(page, step);
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const jsonHits = [];
    for (const c of captured) {
      for (const hit of extractFromPayload(c.payload)) {
        jsonHits.push({ ...hit, url: c.url });
      }
    }
    const domHits = await extractFromDom(page);

    if (DISCOVER) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(DEBUG_DIR, `${site.key}.png`),
        fullPage: true,
      });
      fs.writeFileSync(
        path.join(DEBUG_DIR, `${site.key}.html`),
        await page.content()
      );
      fs.writeFileSync(
        path.join(DEBUG_DIR, `${site.key}.network.json`),
        JSON.stringify(
          captured.map((c) => ({
            url: c.url,
            method: c.method,
            sample: c.raw.slice(0, 4000),
          })),
          null,
          2
        )
      );
      const paths = {};
      for (const h of jsonHits) {
        paths[h.keyPath] = paths[h.keyPath] || new Set();
        paths[h.keyPath].add(h.date);
      }
      console.log(`\n=== ${site.name} ===`);
      console.log(`Requests captured: ${captured.length}`);
      for (const c of captured) console.log(`  ${c.method} ${c.url}`);
      console.log('Date-shaped values by key path:');
      for (const [p, dates] of Object.entries(paths)) {
        const list = [...dates].sort();
        console.log(`  ${p || '(root)'} -> ${list.length} value(s): ${list.slice(0, 8).join(', ')}`);
      }
      console.log(`DOM candidates: ${domHits.length}`);
      for (const h of domHits.slice(0, 40)) console.log(`  "${h.hint}"  [${h.cls}]`);
    }

    const dates = new Set();
    for (const h of jsonHits) {
      if (site.keyPaths && site.keyPaths.length && !site.keyPaths.some((p) => h.keyPath.includes(p))) continue;
      if (inWindow(h.date)) dates.add(h.date);
    }
    for (const h of domHits) {
      const iso = normaliseDate(h.hint);
      if (iso && inWindow(iso)) dates.add(iso);
    }

    await context.close();
    return { ok: true, dates: [...dates].sort(), requests: captured.length };
  } catch (err) {
    if (DISCOVER) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      await page
        .screenshot({ path: path.join(DEBUG_DIR, `${site.key}-error.png`), fullPage: true })
        .catch(() => {});
    }
    await context.close();
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const state = loadState();
  state.sites = state.sites || {};

  const sites = config.sites.filter(
    (s) => s.enabled !== false && (!siteArg || s.key === siteArg)
  );

  const browser = await chromium.launch({ headless: !HEADED });
  const newFinds = [];
  const brokenSites = [];

  for (const site of sites) {
    console.log(`[check] ${site.name}`);
    const prev = state.sites[site.key] || { dates: [], failures: 0 };
    const result = await Promise.race([
      checkSite(browser, site),
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ ok: false, error: 'timed out' }),
          settings.perSiteTimeoutMs || 120000
        )
      ),
    ]);

    // A page that loaded but fetched nothing is almost certainly broken rather
    // than genuinely empty. Silently reporting zero dates forever is the worst
    // failure mode this tool has, so treat it as an error.
    if (result.ok && result.requests === 0 && result.dates.length === 0) {
      result.ok = false;
      result.error = 'page loaded but made no data requests';
    }

    if (!result.ok) {
      const failures = (prev.failures || 0) + 1;
      state.sites[site.key] = { ...prev, failures, lastError: result.error, lastRun: new Date().toISOString() };
      console.error(`  failed: ${result.error} (${failures} in a row)`);
      if (failures === (settings.failuresBeforeAlert || 3)) brokenSites.push(site);
      continue;
    }

    const previous = new Set(prev.dates || []);
    const added = result.dates.filter((d) => !previous.has(d));
    const removed = (prev.dates || []).filter((d) => !result.dates.includes(d));
    const firstRun = !prev.lastRun;

    console.log(
      `  ${result.dates.length} date(s) visible, ${added.length} new, ${removed.length} gone`
    );

    state.sites[site.key] = {
      dates: result.dates,
      failures: 0,
      lastRun: new Date().toISOString(),
      lastChange: added.length || removed.length ? new Date().toISOString() : prev.lastChange || null,
    };

    if (added.length && (!firstRun || settings.notifyOnFirstRun)) {
      newFinds.push({ site, added, firstRun, total: result.dates.length });
    }
  }

  await browser.close();
  saveState(state);

  for (const find of newFinds) {
    const heading = find.firstRun
      ? `Now watching ${find.site.name}`
      : `New dates at ${find.site.name}`;
    const lines = find.added.map((d) => `• ${prettyDate(d)}`).join('\n');
    await notify({
      title: heading,
      body: `${find.added.length} date(s):\n${lines}\n\nBook: ${find.site.url}`,
      url: find.site.url,
    });
  }

  for (const site of brokenSites) {
    await notify({
      title: `Checker is stuck on ${site.name}`,
      body: 'Three failed runs in a row. The booking flow has probably changed and the steps need updating.',
      url: site.url,
    });
  }

  console.log('[check] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
