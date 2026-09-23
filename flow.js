'use strict';

/*
 * Shared navigation. Walks a booking flow from the intro screen to the calendar
 * for a given venue, then reads the visible slots.
 *
 * Element ids are regenerated on every session, so everything here targets
 * labels, roles and the vendor's stable class names instead.
 */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function surveyScreen() {
  const visible = (el) => el.offsetParent !== null;
  return {
    headings: [...document.querySelectorAll('h1, h2, legend')]
      .filter(visible)
      .map((el) => el.textContent.trim().replace(/\s+/g, ' '))
      .slice(0, 8),
    errors: [...document.querySelectorAll('.govuk-error-message, .govuk-error-summary')]
      .filter(visible)
      .map((el) => el.textContent.trim().replace(/\s+/g, ' '))
      .slice(0, 5),
    controls: [...document.querySelectorAll('input, select')]
      .filter((el) => visible(el) && el.type !== 'hidden')
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        id: el.id || '',
        name: el.name || '',
        label: (
          (el.labels && el.labels[0] && el.labels[0].textContent) ||
          el.getAttribute('aria-label') ||
          el.closest('.govuk-form-group')?.querySelector('label, legend')?.textContent ||
          ''
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 120),
        checked: el.checked === true,
        value: el.value || '',
        options:
          el.tagName === 'SELECT'
            ? [...el.options].map((o) => ({ value: o.value, text: o.textContent.trim() }))
            : undefined,
      })),
    hasCalendar: [...document.querySelectorAll('[class*="sis-ct-timeslot"], .ui-datepicker-inline')].some(visible),
  };
}

function readSlots() {
  const visible = (el) => el.offsetParent !== null;
  const title = document.querySelector('.ui-datepicker-title');
  const monthSelect = document.querySelector('.ui-datepicker-month');
  const yearSelect = document.querySelector('.ui-datepicker-year');
  const slots = [];
  for (const el of document.querySelectorAll('[class*="sis-ct-timeslot"]')) {
    if (!visible(el)) continue;
    const text = el.textContent.trim().replace(/\s+/g, ' ');
    if (!/\d{1,2}[:.]\d{2}/.test(text)) continue;
    let node = el;
    let day = null;
    while (node && !day) {
      const header = node.querySelector && node.querySelector('[class*="sis-ct-date-day"]');
      if (header) day = header.textContent.trim().replace(/\s+/g, ' ');
      node = node.parentElement;
    }
    slots.push({ day, text });
  }
  return {
    slots,
    viewTitle: title ? title.textContent.trim().replace(/\s+/g, ' ') : '',
    viewMonth: monthSelect ? monthSelect.value : '',
    viewYear: yearSelect ? yearSelect.value : '',
  };
}

// "Wednesday 13Jan" plus the year the calendar is showing.
function parseDay(dayText, viewYear) {
  if (!dayText) return null;
  const m = dayText.match(/(\d{1,2})\s*([A-Za-z]{3})/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const now = new Date();
  let year = Number(viewYear) || now.getFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  // If the calendar's year would put this in the past, it belongs to the next one.
  if (candidate < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))) {
    year += 1;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function advanceToCalendar(page, venue, log = () => {}, maxScreens = 8) {
  for (let screen = 1; screen <= maxScreens; screen++) {
    const s = await page.evaluate(surveyScreen);
    if (s.errors.length) return { ok: false, error: `blocked: ${s.errors.join(' | ')}` };
    if (s.hasCalendar) return { ok: true };

    let acted = false;

    for (const c of s.controls) {
      if (c.type === 'checkbox' && !c.checked && c.id && /confirm|accept|agree|terms/i.test(c.label)) {
        await page.locator(`[id="${c.id}"]`).first().check({ timeout: 5000 }).catch(() => {});
        log(`ticked "${c.label}"`);
        acted = true;
      }
    }

    const groups = {};
    for (const c of s.controls) {
      if (c.type === 'radio' && c.name) (groups[c.name] = groups[c.name] || []).push(c);
    }
    for (const group of Object.values(groups)) {
      if (group.some((g) => g.checked)) continue;
      const pick = group.find((g) => /^(yes|i give|i confirm|i agree|marriage)/i.test(g.label.trim())) || group[0];
      if (pick && pick.id) {
        await page.locator(`[id="${pick.id}"]`).first().check({ timeout: 5000 }).catch(() => {});
        log(`selected "${pick.label}"`);
        acted = true;
      }
    }

    for (const c of s.controls) {
      if (c.tag !== 'select' || !c.options || c.options.length < 2 || c.value) continue;
      if (/translat|language|search/i.test(c.label + c.id)) continue;
      const isVenue = /ChooseTimeOffice/i.test(c.id) || /venue|taking place/i.test(c.label);
      let choice = c.options[1];
      if (isVenue) {
        const match = c.options.find((o) => o.text === venue);
        if (!match) return { ok: false, error: `venue "${venue}" not offered` };
        choice = match;
      }
      const sel = page.locator(`[id="${c.id}"]`);
      await sel.selectOption(choice.value, { timeout: 5000 }).catch(() => {});
      log(`chose "${choice.text}"`);
      acted = true;
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      if (isVenue) {
        // Some deployments re-render this dropdown and drop the selection, so
        // confirm it stuck and wait for the calendar it should trigger.
        for (let attempt = 1; attempt <= 3; attempt++) {
          const current = await sel.inputValue().catch(() => '');
          if (current !== choice.value) {
            log(`selection did not stick (attempt ${attempt}), retrying by label`);
            await sel.selectOption({ label: choice.text }, { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2000);
          }
          const appeared = await page
            .waitForSelector('[class*="sis-ct-timeslot"], .ui-datepicker-inline', { timeout: 12000, state: 'visible' })
            .then(() => true)
            .catch(() => false);
          if (appeared) {
            log('calendar rendered');
            break;
          }
          if (attempt === 3) log('calendar never rendered for this venue');
        }
      }
    }

    const next = page.getByRole('button', { name: /^(next|continue|start|begin)$/i }).first();
    if (!(await next.count())) {
      if (acted) continue;
      return { ok: false, error: 'no way forward from this screen' };
    }
    await next.click({ timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  return { ok: false, error: 'ran out of screens before reaching a calendar' };
}

module.exports = { advanceToCalendar, readSlots, parseDay, surveyScreen };
