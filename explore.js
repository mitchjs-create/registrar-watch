#!/usr/bin/env node
'use strict';

/*
 * Walks each booking flow forwards one screen at a time and reports what is on
 * each screen: the question text, the controls, the options in each dropdown,
 * and any validation errors it hits. It ticks confirmation boxes and picks the
 * first real option in a dropdown, but it never types into a free text field,
 * so it cannot submit personal details. It stops as soon as a calendar or time
 * picker appears, which is the screen we actually care about.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const siteArg = (args.find((a) => a.startsWith('--site=')) || '').split('=')[1];
const MAX_STEPS = Number((args.find((a) => a.startsWith('--steps=')) || '').split('=')[1]) || 8;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function survey() {
  return {
    headings: [...document.querySelectorAll('h1, h2, legend')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => el.textContent.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .slice(0, 12),
    errors: [...document.querySelectorAll('.govuk-error-message, .govuk-error-summary, .error, [class*="error" i]')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => el.textContent.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .slice(0, 10),
    controls: [...document.querySelectorAll('input, select, textarea')]
      .filter((el) => el.offsetParent !== null && el.type !== 'hidden')
      .map((el) => {
        const label =
          (el.labels && el.labels[0] && el.labels[0].textContent.trim()) ||
          el.getAttribute('aria-label') ||
          el.closest('.govuk-form-group')?.querySelector('label, legend')?.textContent.trim() ||
          '';
        return {
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          id: el.id || '',
          name: el.name || '',
          label: label.replace(/\s+/g, ' ').slice(0, 120),
          checked: el.checked === true,
          value: (el.value || '').slice(0, 40),
          className: (el.className || '').slice(0, 80),
          options:
            el.tagName === 'SELECT'
              ? [...el.options].map((o) => `${o.value}|${o.textContent.trim()}`.slice(0, 80)).slice(0, 400)
              : undefined,
        };
      }),
    buttons: [...document.querySelectorAll('button, input[type=submit], a.govuk-button')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => (el.value || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40))
      .filter(Boolean),
    calendarMatches: [
      ...document.querySelectorAll(
        '.sis-datepicker-control, [class*="datepicker" i], [class*="calendar" i], .ui-datepicker, [id*="ChooseTime" i]'
      ),
    ]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return `${el.tagName.toLowerCase()}#${el.id || '-'}.${(el.className || '').toString().slice(0, 40)} visible=${el.offsetParent !== null && r.width > 0 && r.height > 0}`;
      })
      .slice(0, 8),
    dayCells: [...document.querySelectorAll('td, [class*="slot" i], [class*="timeslot" i], [class*="day" i]')]
      .filter((el) => el.offsetParent !== null && el.textContent.trim().length < 30)
      .map((el) => {
        const a = el.querySelector('a, button');
        return `"${el.textContent.trim().slice(0, 24)}" cls=[${(el.className || '').toString().slice(0, 50)}] clickable=${!!a} ${a ? 'href=' + (a.getAttribute('href') || '').slice(0, 30) : ''}`;
      })
      .slice(0, 60),
    monthHeaders: [...document.querySelectorAll('[class*="month" i], [class*="title" i], caption, h3')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => el.textContent.trim().replace(/\s+/g, ' ').slice(0, 60))
      .slice(0, 8),
  };
}

async function explore(browser, site, venue) {
  const context = await browser.newContext({ userAgent: UA, locale: 'en-GB', timezoneId: 'Europe/London' });
  const page = await context.newPage();
  const requests = [];

  page.on('response', async (res) => {
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return;
    try {
      const text = await res.text();
      requests.push({ url: res.url(), method: res.request().method(), size: text.length, sample: text.slice(0, 1500) });
    } catch {}
  });

  console.log(`\n${'='.repeat(70)}\n${site.name}${venue ? ' :: ' + venue : ''}\n${'='.repeat(70)}`);

  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);

    for (let step = 1; step <= MAX_STEPS; step++) {
      const s = await page.evaluate(survey);
      console.log(`\n--- screen ${step} ---`);
      console.log(`headings: ${s.headings.join(' | ') || '(none)'}`);
      if (s.errors.length) console.log(`ERRORS: ${s.errors.join(' | ')}`);
      for (const c of s.controls) {
        const opts = c.options ? `\n      options: ${c.options.join(' ; ')}` : '';
        console.log(
          `  ${c.tag}/${c.type} id=${c.id || '-'} checked=${c.checked} label="${c.label}"${opts}`
        );
      }
      console.log(`buttons: ${s.buttons.join(' | ')}`);
      console.log(`calendar matches: ${s.calendarMatches.join(' ; ') || '(none)'}`);
      if (s.dayCells.length) console.log(`  day/slot cells: ${s.dayCells.join(' ; ')}`);

      if (s.dayCells.length) {
        console.log('>>> reached a date or time screen, stopping here');
        break;
      }
      if (s.errors.length) {
        console.log('>>> validation blocked us, stopping here');
        break;
      }

      // Tick unticked checkboxes (these are the confirm and accept gates).
      for (const c of s.controls) {
        if (c.type === 'checkbox' && !c.checked && c.id) {
          await page
            .locator(`[id="${c.id}"]`)
            .first()
            .check({ timeout: 5000 })
            .catch(() => {});
          console.log(`  [action] ticked "${c.label || c.id}"`);
        }
      }
      // Dropdowns. The venue dropdown gets the configured venue; anything else
      // gets its first real option so we can keep moving.
      for (const c of s.controls) {
        if (c.tag !== 'select' || !c.options || c.options.length < 2 || c.value) continue;
        const isVenue = /ChooseTimeOffice/i.test(c.id) || /venue/i.test(c.label);
        let choice = c.options[1];
        if (isVenue && venue) {
          const match = c.options.find((o) => o.split('|').slice(1).join('|').trim() === venue);
          if (!match) {
            console.log(`  [warn] venue "${venue}" not in dropdown, stopping`);
            return;
          }
          choice = match;
        }
        await page
          .locator(`[id="${c.id}"]`)
          .selectOption(choice.split('|')[0], { timeout: 5000 })
          .catch(() => {});
        console.log(`  [action] chose "${choice}" in ${c.id}`);
        await page.waitForTimeout(3000);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      }
      // Radio gates: prefer the affirmative option, since these are consent or
      // eligibility questions that must be answered to proceed.
      const radioGroups = {};
      for (const c of s.controls) {
        if (c.type === 'radio' && c.name) (radioGroups[c.name] = radioGroups[c.name] || []).push(c);
      }
      for (const [, group] of Object.entries(radioGroups)) {
        if (group.some((g) => g.checked)) continue;
        const pick =
          group.find((g) => /^(yes|i give|i confirm|i agree|i accept)/i.test(g.label.trim())) || group[0];
        if (pick && pick.id) {
          await page.locator(`[id="${pick.id}"]`).first().check({ timeout: 5000 }).catch(() => {});
          console.log(`  [action] selected radio "${pick.label || pick.id}"`);
        }
      }

      // Free text fields are left alone deliberately.
      const textFields = s.controls.filter((c) => ['text', 'email', 'tel', 'password'].includes(c.type));
      if (textFields.length) {
        console.log(`  [note] ${textFields.length} free text field(s) not filled: ${textFields.map((t) => t.label || t.id).join(' ; ')}`);
      }

      const next = page.getByRole('button', { name: /next|continue|start|begin/i }).first();
      if (!(await next.count())) {
        console.log('>>> no Next button found, stopping here');
        break;
      }
      await next.click({ timeout: 10000 }).catch((e) => console.log(`  [warn] next click failed: ${e.message}`));
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }

    console.log(`\nJSON requests seen (${requests.length}):`);
    for (const r of requests) {
      console.log(`  ${r.method} ${r.url} [${r.size} bytes]`);
      console.log(`    ${r.sample.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }

  fs.mkdirSync(path.join(ROOT, 'debug'), { recursive: true });
  await page
    .screenshot({ path: path.join(ROOT, 'debug', `${site.key}-${(venue || 'default').replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`), fullPage: true })
    .catch(() => {});
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const site of config.sites.filter((s) => (!siteArg || s.key === siteArg) && s.enabled !== false)) {
    const venues = site.venues && site.venues.length ? site.venues : [null];
    for (const venue of venues) {
      await explore(browser, site, venue);
    }
  }
  await browser.close();
})();
