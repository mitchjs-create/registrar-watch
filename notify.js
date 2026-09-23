'use strict';

/*
 * Sends an alert through whichever channels are configured by environment
 * variables. Anything not configured is skipped silently, so you can start
 * with one channel and add another later without touching this file.
 *
 *   NTFY_TOPIC            e.g. mitch-registrar-a7f3k2   (plus optional NTFY_SERVER)
 *   TELEGRAM_BOT_TOKEN    from @BotFather
 *   TELEGRAM_CHAT_ID      your chat id
 *   WEBHOOK_URL           anything that accepts a JSON POST
 *   RESEND_API_KEY        plus EMAIL_TO and EMAIL_FROM, for email
 */

async function post(url, options, label) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[notify] ${label} failed: ${res.status} ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[notify] ${label} errored: ${err.message}`);
    return false;
  }
}

async function notify({ title, body, url }) {
  const channels = [];

  if (process.env.NTFY_TOPIC) {
    const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
    const headers = {
      Title: title,
      Priority: 'high',
      Tags: 'calendar',
    };
    if (url) headers.Click = url;
    channels.push(
      post(`${server}/${process.env.NTFY_TOPIC}`, { method: 'POST', headers, body }, 'ntfy')
    );
  }

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    channels.push(
      post(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `*${title}*\n\n${body}${url ? `\n\n${url}` : ''}`,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
          }),
        },
        'telegram'
      )
    );
  }

  if (process.env.RESEND_API_KEY && process.env.EMAIL_TO) {
    channels.push(
      post(
        'https://api.resend.com/emails',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
            to: process.env.EMAIL_TO.split(',').map((s) => s.trim()),
            subject: title,
            text: `${body}${url ? `\n\n${url}` : ''}`,
          }),
        },
        'email'
      )
    );
  }

  if (process.env.WEBHOOK_URL) {
    channels.push(
      post(
        process.env.WEBHOOK_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body, url }),
        },
        'webhook'
      )
    );
  }

  if (channels.length === 0) {
    console.log('[notify] No channel configured, printing instead:');
    console.log(`  ${title}\n${body}`);
    return;
  }

  await Promise.all(channels);
}

module.exports = { notify };
