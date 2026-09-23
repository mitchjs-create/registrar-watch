# registrar-watch

Watches register office appointment booking pages and alerts you when a date
appears that was not there last time.

All five sites run the same Agenda booking software, so there is one checker and
five entries in `config.json`.

## How it works

Each run opens the booking page in a headless Chromium, walks through whatever
clicks and dropdowns lead to the calendar, and records both the calendar markup
and every JSON response the page fetched in the background. Anything date-shaped
is collected, filtered to future dates inside your window, and compared against
`state.json` from the previous run. New dates trigger a notification.

State lives in `state.json` so the comparison survives between runs. On GitHub
Actions the workflow commits it back to the repo, which also gives you a history
of when slots came and went.

## Setup

```bash
npm install
npx playwright install chromium
```

### Step one: discovery

The `steps` array for each site is empty, because I have not seen what the
booking flow asks for. Run this first, ideally with a visible browser so you can
watch it:

```bash
npm run discover:headed -- --site=wandsworth
```

It writes a screenshot, the rendered HTML and every captured request to
`debug/`, and prints a summary. Send me that output, or the screenshots, and I
will fill in the click path for each site: which appointment type to choose,
which venue, and which key in the JSON actually means "bookable".

Until the steps are filled in, the checker only sees whatever is on the first
screen, which for most of these will be nothing useful.

### Step two: configure

In `config.json`:

- `windowStart` / `windowEnd`: only alert on dates in this range, e.g.
  `"2026-06-01"` to `"2026-10-25"`. Leave as `null` for any future date.
- `venueFilter`: for Lincolnshire, the venues you actually care about.
- `keyPaths`: once discovery shows which JSON path holds real availability, put
  a fragment of it here so unrelated dates in the payload are ignored.

### Step three: notifications

Set whichever you want as environment variables locally, or as repository
secrets on GitHub:

| Channel  | Variables                                  |
| -------- | ------------------------------------------ |
| Phone push | `NTFY_TOPIC` (pick an unguessable topic name, install the ntfy app, subscribe to it) |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`   |
| Email    | `RESEND_API_KEY`, `EMAIL_TO`, `EMAIL_FROM` |
| Anything else | `WEBHOOK_URL`                         |

With none set, alerts print to the console, which is fine for testing.

ntfy is the least friction: no account, no API key, and it reaches your phone
in a couple of seconds. The only caveat is that the topic name is the only
secret, so make it random.

### Step four: schedule it

Push to a private GitHub repo and the workflow in `.github/workflows/check.yml`
runs every 15 minutes on free minutes. Add your notification secrets under
Settings, Secrets and variables, Actions.

Scheduled runs on GitHub can be delayed at busy times, and are paused
automatically after 60 days of no commits to the repo, although the state
commits from the workflow itself keep it alive.

## Running once by hand

```bash
node check.js                  # all sites
node check.js --site=southwark # one site
node check.js --headed         # watch it work
```

## Later improvement

Once discovery shows the availability endpoint, most of the browser work can go
away and the checker can call that endpoint directly. That turns a 20 second
browser session per site into a sub-second request, which means it could run
every few minutes rather than every fifteen.

## A note on being a good citizen

One page load per site per run, at fifteen minute intervals, is gentler than a
person refreshing the page while they wait. Worth keeping it at that rather than
tightening the interval, both to stay well inside acceptable use and to avoid
getting the IP range blocked.
