# Scheduler

[![Built from a Spekkr spec](https://img.shields.io/badge/built%20from-Spekkr%20spec-f0442b)](https://spekkr.com/dwrtz/scheduling-app/)

Built from the Spekkr spec dwrtz/scheduling-app: https://spekkr.com/dwrtz/scheduling-app/

Build line: `Build the spec at https://spekkr.com/dwrtz/scheduling-app/start.md`

A scheduling app that runs as one Cloudflare Worker (static assets + JSON API) with a D1 database. People book time on your public page; you manage event types, availability and bookings after signing in. You can optionally restrict sign-up and sign-in to a list of emails.

Email, calendar invites and busy-time blocking from a secret iCal address are optional and off until you configure them.

## Run it on your computer

```bash
npm install
npm run dev          # builds, migrates the local D1 database, then wrangler dev
```

Open http://localhost:8787. No Cloudflare account is needed locally.

Demo login (when `seed_demo` is on in `spekkr.inputs.json`): `alex@example.com` / `demo-pass-123`, public page `/alex`. Freeze the clock with `npx wrangler dev --var NOW:2026-11-15T12:00:00.000Z`.

This repo keeps `seed_demo` on so local dev and tests have that demo account. Set it to `false` before a personal production deploy.

## Tests

```bash
npm test                                         # unit tests
npx playwright install chromium && npm run e2e   # end-to-end, against wrangler dev
```

The e2e suite runs two local Workers: one with every integration off (the default), and one with a test email outbox and a test-only encryption key so the integrations specs can run without any real secrets or paid email plan.

## Deploy to Cloudflare

1. Copy [`wrangler.example.jsonc`](./wrangler.example.jsonc) over `wrangler.jsonc` (or edit `wrangler.jsonc` in place) and replace `<YOUR_D1_DATABASE_ID>` with your database id. You can also set `account_id`, a custom domain, and the optional email / iCal vars there.
2. Log in and create the database once:

```bash
npx wrangler login
npx wrangler d1 create calendar
```

Paste the printed D1 id into `wrangler.jsonc`, then apply migrations and deploy:

```bash
npx wrangler d1 migrations apply DB --remote
npm run deploy
```

Keep `NOW` empty and `TEST_CLOCK` `"0"` in production.

### Vars

Set these in `wrangler.jsonc` (or as Worker vars in the dashboard). Secrets are set with `wrangler secret put`, never in the config file.

| Var | Default | Meaning |
|---|---|---|
| `ALLOW_SIGNUP` | `"1"` | `"1"` allows new accounts, `"0"` refuses them. Existing accounts can still sign in. |
| `ALLOWED_EMAILS` | `""` | Comma-separated allowlist for sign-up, sign-in and existing sessions. Empty or unset means no extra restriction. Example: `"you@example.com"`. |
| `EMAIL_PROVIDER` | `""` | `""` (off), `"cloudflare"`, or `"resend"`. |
| `EMAIL_FROM` | `""` | From address on your verified domain, e.g. `"Scheduler <bookings@example.com>"`. It is also the invites' organizer, so it must receive mail through Email Routing (see below). |
| `SITE_URL` | `""` | Public URL of the site, used in email links, e.g. `"https://calendar.example.com"`. |
| `ICAL_POLL_MINUTES` | `"10"` | How often to refresh busy times from a connected iCal feed (5–15). |
| `ENCRYPTION_KEY` | (secret) | Required only if you paste a secret iCal address. 32 bytes, base64. |
| `RESEND_API_KEY` | (secret) | Required only if `EMAIL_PROVIDER` is `"resend"`. |

Public booking pages (`/<username>`, `/<username>/<slug>`, and the guest reschedule/cancel flows) stay open even when sign-up is closed or an email allowlist is set.

### If static asset upload is unavailable

The UI can be bundled into the Worker instead of being uploaded as Workers static assets. Temporarily set `"main": "src/worker/deploy-entry.ts"` in your wrangler config (and drop the `assets` block), then:

```bash
npm run build
node gen-inline-assets.mjs
npx wrangler deploy
```

`src/worker/inline-assets.gen.js` is generated and is not committed.

## Optional integrations

Each one is off until configured; the app works the same without them. Status and the last error are on **Settings > Integrations**.

### Busy times from your calendar (secret iCal address)

1. Create the encryption key once: `openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY`.
2. Sign in, open **Settings > Calendars** and paste your calendar's secret iCal address. In Google Calendar on the web: Settings (gear) > your calendar under "Settings for my calendars" > "Integrate calendar" > "Secret address in iCal format" (ends in `basic.ics`). Outlook and iCloud publish https iCal addresses too. Don't paste that address into chat or into this repo; it belongs only in the app's settings.
3. The address is stored encrypted (AES-GCM) and never shown again. The Cron Trigger polls it every `ICAL_POLL_MINUTES` (5–15, default 10); busy events stop showing as open times.

### Email and calendar invites

Booking, request, accept/decline, move and cancel emails go to the guest (and listed guests) and to you, with an `invite.ics` that shows as confirmed in both calendars. A reschedule updates the existing event instead of adding a second one. Reminders (per event type: 1 week / 1 day / 1 hour / 15 min before, on the event's Limits tab) are sent by the Cron Trigger, each at most once.

- **Cloudflare Email Sending:** needs the Workers Paid plan to send to any address (3,000 emails a month included, then $0.35 per 1,000) and the domain on Cloudflare DNS. Dashboard: Compute > Email Service > Email Sending > Onboard Domain; it adds SPF and DKIM TXT records, DMARC on `_dmarc.<domain>` and `cf-bounce` MX records. When the domain shows as verified, add `"send_email": [{ "name": "EMAIL" }]` to `wrangler.jsonc` (see [`wrangler.example.jsonc`](./wrangler.example.jsonc)), set `EMAIL_PROVIDER=cloudflare`, `EMAIL_FROM="Scheduler" <bookings@your-domain>` and `SITE_URL=https://your-site`, set up receiving (below), and deploy.
- **Resend:** verify the domain in Resend (add the SPF/DKIM records it gives you in Cloudflare DNS), then `npx wrangler secret put RESEND_API_KEY`, set `EMAIL_PROVIDER=resend`, `EMAIL_FROM` and `SITE_URL`, set up receiving (below; the `EMAIL_FROM` domain must be on Cloudflare DNS for Email Routing), and deploy.

#### Receiving calendar replies (required with email)

Every emailed invite names your `EMAIL_FROM` address as the iCalendar `ORGANIZER`, so calendar apps send their replies (accept, maybe, decline, proposed new time) there. That address must receive mail, or Gmail and others retry and then warn the person who replied that delivery failed. **Sending and receiving are configured separately:**

- Email Sending's `cf-bounce` MX records belong to the bounce subdomain (`cf-bounce.<your sending domain>`). They do **not** make your `EMAIL_FROM` address receive mail. Leave them as they are.
- Receiving needs MX records at the organizer address's own domain (the part after `@` in `EMAIL_FROM`, e.g. `calendar.example.com`), which Cloudflare Email Routing adds.

Setup (Cloudflare Email Routing, free, needs the domain on Cloudflare DNS):

1. Dashboard: Compute > Email Service > Email Routing, enable it for the organizer address's domain or subdomain (e.g. `calendar.example.com`). It adds three MX records and an SPF TXT record on that name. If that name already has MX or SPF records from another mail provider, choose a different `EMAIL_FROM` domain instead of replacing them.
2. Add a routing rule: custom address = your `EMAIL_FROM` address (e.g. `bookings@calendar.example.com`), action **Send to a Worker**, Worker = this app.
3. Deploy. Check with `dig MX calendar.example.com`.

The Worker's `email()` handler reads each message's `text/calendar` part (iTIP `METHOD:REPLY` or `COUNTER`), matches its `UID` to a booking, and accepts it only when the replying `ATTENDEE` is on that booking and the SMTP sender is that attendee (or the attendee's calendar service, such as Google Calendar's bounce address, with the attendee in `From`). Anything else is rejected with a permanent SMTP error; nothing is forwarded and nothing is ever sent back to the sender.

Nobody has to sign in to follow or change a meeting: their calendar shows its state, and the app sends every update.

- **Accepted / maybe:** that person's status updates in your bookings list. No email.
- **Declined** by you or by the person who booked: the booking is cancelled, the time is freed, and everyone (the decliner's own copy included) gets the standard calendar cancellation (`METHOD:CANCEL`) with a short note. A decline from an extra guest only updates their status.
- **Proposed new time** (Google Calendar's "Propose a new time", iTIP `COUNTER`) by you or by the person who booked:
  - If the time isn't bookable (outside your hours, taken, a different length, in the past), the proposer gets a `DECLINECOUNTER` with a one-line reason and nothing changes.
  - Otherwise the other party gets an updated invite at the new time that asks them to answer (`PARTSTAT=NEEDS-ACTION;RSVP=TRUE`), with the proposed time and the booking link in the email. Both the original and the proposed time stay held.
  - They accept: the meeting moves, the original time is freed, and everyone gets the final invite. Reminders follow the new time.
  - They decline: the meeting is cancelled for everyone.
  - Nobody answers by the earlier of the two start times: the proposal expires, the original time stands, and everyone gets the invite again at that time.
- Replies older than the current invite (lower `SEQUENCE`, or an earlier `DTSTAMP` than one already recorded) change nothing. Mail from the organizer address itself is refused, and the app never answers a reply with a reply.

`migrations/0002_integrations.sql` adds the tables and columns these need; `migrations/0004_rsvp.sql` adds `booking_rsvps` for calendar replies; `migrations/0005_booking_changes.sql` adds `booking_changes` for proposed new times. They only add; apply them with `npx wrangler d1 migrations apply DB --remote`.

## Settings (`spekkr.inputs.json`)

- **`app_name`:** the product name (default `"Scheduler"`).
- **`brand_color`:** the brand colour, as `#rrggbb`.
- **`seed_demo`:** if `true` (the default in this repo, so local dev and tests have a demo account), seed a demo host on first run. Set this to `false` before a personal production deploy.

## License

MIT. See [LICENSE](./LICENSE).
