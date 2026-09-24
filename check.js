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
      if (!date || !inWindow(date)) continue;
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
    console.log(`email_to set: ${!!process.env.EMAIL_TO}`);
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
  const alerts = [];
  const broken = [];

  for (const site of sites) {
    for (const venue of site.venues || []) {
      const id = `${site.key}::${venue}`;
      console.log(`[check] ${site.name} / ${venue}`);
      const prev = state.venues[id] || { slots: [], failures: 0 };
      const result = await checkVenue(browser, site, venue, details);

      if (!result.ok) {
        const failures = (prev.failures || 0) + 1;
        state.venues[id] = { ...prev, failures, lastError: result.error, lastRun: new Date().toISOString() };
        console.error(`    failed: ${result.error} (${failures} in a row)`);
        if (failures === (settings.failuresBeforeAlert || 3)) broken.push({ site, venue });
        continue;
      }

      const previous = new Set(prev.slots || []);
      const added = result.slots.filter((s) => !previous.has(s));
      const firstRun = !prev.lastRun;
      console.log(`    ${result.slots.length} in-window slot(s), ${added.length} new, ${result.rawCount} slot(s) on the page in total`);

      state.venues[id] = {
        slots: result.slots,
        failures: 0,
        lastRun: new Date().toISOString(),
        lastChange: added.length ? new Date().toISOString() : prev.lastChange || null,
      };

      if (added.length && (!firstRun || settings.notifyOnFirstRun)) {
        alerts.push({ site, venue, added, firstRun });
      }
    }
  }

  await browser.close();
  if (!DRY) fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

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
    await notify({
      title: `Checker stuck on ${b.site.name}`,
      body: `Three failed runs for ${b.venue}. The booking flow has probably changed.`,
      url: b.site.url,
    });
  }

  console.log('[check] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
