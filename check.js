#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { notify } = require('./notify');
const { advanceToCalendar, readSlots, parseDay, surveyScreen } = require('./flow');

const ROOT = __dirname;
const STATE_PATH = path.join(ROOT, 'state.json');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const settings = config.settings || {};

const args = process.argv.slice(2);
const siteArg = (args.find((a) => a.startsWith('--site=')) || '').split('=')[1];
const DRY = args.includes('--dry-run');
const TEST_NOTIFY = args.includes('--test-notify');
// Ignore the date window and the day-of-week rules, to answer "what is the
// earliest anywhere right now". Always run this with --dry-run.
const ALL_DATES = args.includes('--all-dates');
// Email the earliest-per-venue rundown, rather than only printing it.
const EMAIL_SUMMARY = args.includes('--email-summary');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { venues: {} };
  }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function inWindow(date) {
  if (date < today()) return false;
  if (settings.windowStart && date < settings.windowStart) return false;
  if (settings.windowEnd && date > settings.windowEnd) return false;
  return true;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Optional per-venue rules, e.g. only care about Wednesdays at one venue.
function passesFilter(site, venue, isoDate) {
  const rule = site.filters && site.filters[venue];
  if (!rule || !rule.weekdays || !rule.weekdays.length) return true;
  const day = WEEKDAYS[new Date(`${isoDate}T12:00:00Z`).getUTCDay()];
  return rule.weekdays.includes(day);
}

function prettyDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// Contact details for the councils that demand them before showing a calendar.
// The email defaults to a plus alias on the Gmail account used for alerts, so
// anything the council sends lands in an inbox you own. The mobile default is
// inside Ofcom's reserved fictional range, which can never be allocated to a
// real person.
function buildDetails() {
  const gmail = process.env.GMAIL_USER || '';
  const derived = gmail.includes('@') ? gmail.replace('@', '+registrar@') : '';
  return {
    firstName: process.env.TH_FIRST_NAME || 'Availability',
    lastName: process.env.TH_LAST_NAME || 'Check',
    email: process.env.TH_EMAIL || derived || '',
    mobile: process.env.TH_MOBILE || '07700900123',
  };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A venue can be restricted to particular days of the week, for cases where the
// other days are not worth hearing about.
function allowedDay(site, venue, isoDate) {
  const rule = (site.venueRules || {})[venue];
  if (!rule || !rule.weekdays || !rule.weekdays.length) return true;
  const name = DAY_NAMES[new Date(`${isoDate}T12:00:00Z`).getUTCDay()];
  return rule.weekdays.some((d) => d.toLowerCase().startsWith(name.slice(0, 3).toLowerCase()));
}

// A dropped connection tells us nothing about availability, so retry before
// treating it as a failure. The councils throttle by IP, so back off between
// attempts rather than hammering.
const TRANSIENT = /ERR_CONNECTION|ERR_NETWORK|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT|net::|Timeout \d+ms exceeded|no way forward from this screen|ran out of screens/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkVenueWithRetry(browser, site, venue, details) {
  const attempts = settings.attemptsPerVenue || 3;
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    last = await checkVenue(browser, site, venue, details);
    if (last.ok) {
      if (i > 1) console.log(`    recovered on attempt ${i}`);
      return last;
    }
    if (!TRANSIENT.test(last.error || '') || i === attempts) return last;
    const backoff = 5000 * i + Math.floor(Math.random() * 4000);
    console.log(`    attempt ${i} failed (${String(last.error).slice(0, 60)}), retrying in ${Math.round(backoff / 1000)}s`);
    await sleep(backoff);
  }
  return last;
}

async function checkVenue(browser, site, venue, details) {
  const context = await browser.newContext({ userAgent: UA, locale: 'en-GB', timezoneId: 'Europe/London' });
  const page = await context.newPage();
  const log = (m) => console.log(`    ${m}`);
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const nav = await advanceToCalendar(page, venue, log, details);
    if (!nav.ok) {
      try {
        fs.mkdirSync(path.join(ROOT, 'debug'), { recursive: true });
        const slug = `${site.key}-stuck`;
        await page.screenshot({ path: path.join(ROOT, 'debug', `${slug}.png`), fullPage: true });
        const s = await page.evaluate(surveyScreen);
        console.log(`    [stuck] headings: ${s.headings.join(' | ')}`);
        console.log(`    [stuck] errors: ${s.errors.join(' | ') || 'none'}`);
        for (const c2 of s.controls) {
          console.log(`    [stuck] ${c2.tag}/${c2.type} value="${String(c2.value).slice(0, 30)}" label="${c2.label}"`);
        }
        const buttons = await page.evaluate(() =>
          [...document.querySelectorAll('button, a.govuk-button, input[type=submit]')]
            .filter((el) => el.offsetParent !== null)
            .map((el) => (el.value || el.textContent || '').trim().slice(0, 30))
        );
        console.log(`    [stuck] buttons: ${buttons.join(' | ')}`);
      } catch {}
      await context.close();
      return { ok: false, error: nav.error };
    }
    await page.waitForTimeout(2000);

    const raw = await page.evaluate(readSlots);
    const found = [];
    for (const s of raw.slots) {
      const date = parseDay(s.day, raw.viewYear);
      if (!date) continue;
      if (!ALL_DATES && !inWindow(date)) continue;
      if (!ALL_DATES && !allowedDay(site, venue, date)) continue;
      if (!passesFilter(site, venue, date)) continue;
      const time = (s.text.match(/\d{1,2}[:.]\d{2}/) || [''])[0];
      found.push(`${date} ${time}`.trim());
    }
    await context.close();
    return { ok: true, slots: [...new Set(found)].sort(), view: raw.viewTitle, rawCount: raw.slots.length };
  } catch (err) {
    await context.close();
    return { ok: false, error: err.message };
  }
}

async function main() {
  if (TEST_NOTIFY) {
    const details = buildDetails();
    console.log(`channels: gmail=${!!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)} resend=${!!process.env.RESEND_API_KEY} ntfy=${!!process.env.NTFY_TOPIC} telegram=${!!process.env.TELEGRAM_BOT_TOKEN}`);
    const rcpts = (process.env.EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
    console.log(
      `recipients: ${rcpts.length} -> ${rcpts
        .map((r) => `${r.slice(0, 2)}***@${r.split('@')[1] || '?'}`)
        .join(', ')}`
    );
    console.log(`tower hamlets contact email resolves: ${details.email ? 'yes' : 'no'}`);
    await notify({
      title: 'registrar-watch test alert',
      body: 'If you are reading this, alerts are working. Real ones will name the venue, date and time.',
      url: 'https://github.com/mitchjs-create/registrar-watch',
    });
    return;
  }

  const state = loadState();
  state.venues = state.venues || {};

  const details = buildDetails();
  const sites = config.sites.filter((s) => {
    if (s.enabled === false) return false;
    if (siteArg && s.key !== siteArg) return false;
    if (s.requiresDetails && !details.email) {
      console.log(`[skip] ${s.name} needs contact details and no email is configured`);
      return false;
    }
    return true;
  });
  const browser = await chromium.launch({ headless: true });
  const summary = [];
  const alerts = [];
  const broken = [];

  // Southwark, Islington, Lincolnshire and Camden all run on sishost.co.uk, so
  // back-to-back checks of those four hit one server four times over. Wait
  // longer before returning to a host we have just used.
  const lastHit = {};
  const hostOf = (u) => {
    try {
      return new URL(u).hostname.split('.').slice(-3).join('.');
    } catch {
      return u;
    }
  };

  for (const site of sites) {
    for (const venue of site.venues || []) {
      const host = hostOf(site.url);
      const base = settings.gapBetweenVenuesMs || 8000;
      const perHost = settings.gapPerHostMs || 25000;
      const since = lastHit[host] ? Date.now() - lastHit[host] : Infinity;
      const wait = Math.max(base, since < perHost ? perHost - since : 0) + Math.floor(Math.random() * 4000);
      if (Number.isFinite(since) || Object.keys(lastHit).length) {
        console.log(`    (waiting ${Math.round(wait / 1000)}s before ${host})`);
        await sleep(wait);
      }
      lastHit[host] = Date.now();

      const id = `${site.key}::${venue}`;
      console.log(`[check] ${site.name} / ${venue}`);
      const prev = state.venues[id] || { slots: [], failures: 0 };
      const result = await checkVenueWithRetry(browser, site, venue, details);

      if (!result.ok) {
        const failures = (prev.failures || 0) + 1;
        const now = Date.now();
        const cooldownMs = (settings.alertCooldownHours || 12) * 3600000;
        const quietSince = prev.lastAlert ? now - Date.parse(prev.lastAlert) : Infinity;
        const threshold = settings.failuresBeforeAlert || 20;
        const worthTelling = failures >= threshold && quietSince > cooldownMs;

        state.venues[id] = {
          ...prev,
          failures,
          lastError: result.error,
          lastRun: new Date().toISOString(),
          lastAlert: worthTelling ? new Date().toISOString() : prev.lastAlert || null,
        };
        console.error(`    failed: ${result.error} (${failures} in a row)`);
        if (worthTelling) broken.push({ site, venue, failures });
        if (ALL_DATES) summary.push({ site, venue, slots: [], unreachable: result.error });
        continue;
      }

      const previous = new Set(prev.slots || []);
      const added = result.slots.filter((s) => !previous.has(s));
      const firstRun = !prev.lastRun;
      console.log(`    ${result.slots.length} in-window slot(s), ${added.length} new, ${result.rawCount} slot(s) on the page in total`);
      if (ALL_DATES) console.log(`    EARLIEST: ${result.slots[0] || 'none visible'}   all: ${result.slots.join(', ')}`);

      state.venues[id] = {
        slots: result.slots,
        failures: 0,
        lastRun: new Date().toISOString(),
        lastChange: added.length ? new Date().toISOString() : prev.lastChange || null,
        lastAlert: prev.lastAlert || null,
      };

      if (ALL_DATES) summary.push({ site, venue, slots: result.slots });

      if (added.length && (!firstRun || settings.notifyOnFirstRun)) {
        alerts.push({ site, venue, added, firstRun });
      }
    }
  }

  await browser.close();
  if (!DRY) fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

  if (ALL_DATES && EMAIL_SUMMARY) {
    const cutoff = settings.windowEnd;
    const ranked = summary
      .filter((s) => s.slots.length)
      .sort((a, b) => a.slots[0].localeCompare(b.slots[0]));
    const empty = summary.filter((s) => !s.slots.length && !s.unreachable);
    const down = summary.filter((s) => s.unreachable);

    const lines = ranked.map((s, i) => {
      const [d, t] = s.slots[0].split(' ');
      const sameDay = s.slots.filter((x) => x.startsWith(d)).length;
      const mark = cutoff && d <= cutoff ? '  ** inside your window **' : '';
      return `${i + 1}. ${s.venue}\n   ${prettyDate(d)} at ${t}${
        sameDay > 1 ? ` (and ${sameDay - 1} more slot(s) that day)` : ''
      }${mark}`;
    });
    for (const s of empty) lines.push(`-. ${s.venue}\n   Nothing available at all`);
    for (const s of down) lines.push(`-. ${s.venue}\n   Could not be reached this time`);

    const inWindowCount = ranked.filter((s) => cutoff && s.slots[0].split(' ')[0] <= cutoff).length;
    await notify({
      title: `Earliest appointment at every venue (${new Date().toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
      })})`,
      body:
        `Every venue being watched, soonest first.\n\n${lines.join('\n\n')}\n\n` +
        `${inWindowCount} of ${summary.length} fall on or before ${cutoff || 'your cutoff'}.\n` +
        `This rundown ignores the cutoff so you can see the whole picture. Automatic alerts still only cover dates before it.`,
      url: 'https://github.com/mitchjs-create/registrar-watch',
    });
  }

  for (const a of alerts) {
    const lines = a.added
      .map((s) => {
        const [d, t] = s.split(' ');
        return `• ${prettyDate(d)}${t ? ` at ${t}` : ''}`;
      })
      .join('\n');
    await notify({
      title: a.firstRun ? `Now watching ${a.venue}` : `New slot at ${a.venue}`,
      body: `${a.site.name}\n${lines}\n\nBook: ${a.site.url}`,
      url: a.site.url,
    });
  }

  for (const b of broken) {
    const hours = Math.round((b.failures * (settings.sweepMinutes || 8)) / 60);
    await notify({
      title: `Cannot reach ${b.venue}`,
      body: `${b.site.name}\n\n${b.failures} failed checks in a row, roughly ${hours} hour(s). Their site may be down or blocking us, or the booking flow may have changed.\n\nYou will not get another message about this venue for at least ${settings.alertCooldownHours || 12} hours.`,
      url: b.site.url,
    });
  }

  console.log('[check] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
