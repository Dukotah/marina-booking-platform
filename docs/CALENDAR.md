# Calendar integration (ICS)

How bookings reach the operator's and the customer's calendars. No Google
account, OAuth, or Google Cloud project is required — everything is standard
iCalendar (RFC 5545) over HTTPS, which Google Calendar, Apple Calendar, and
Outlook all consume natively.

## What exists

### 1. Per-operator subscribe feed (operator side)

`GET /calendar/feed/:token.ics` (also accepted without the `.ics` suffix).

- **Auth:** a secret 48-hex-char token, generated/rotated in the admin app under
  **Settings → Integrations → Calendar feed**. The token is stored on the
  operator's `Integration` row (`key: 'calendar_feed'`, `config: { token }`).
  Rotating overwrites `config.token`, which invalidates every previously shared
  URL on the calendar service's next poll. Unknown/disabled tokens 404; the
  comparison is constant-time and the route is rate-limited per IP.
- **Tenancy:** mounted OUTSIDE the `/api` tenant middleware (like `/webhooks`
  and `/internal`) because Google polls a bare URL with no tenant header. The
  token→operator lookup is the one owner-client (non-RLS) read; all booking data
  is then loaded through the RLS tenant-scoped client.
- **Content:** one `VEVENT` per booked order item (checkout add-on lines and
  cancelled bookings are omitted; `METHOD:PUBLISH`), from ~7 days past onward,
  capped at 1000 events. Summary is
  `{activity} — {n} guests ({order number})`; the description carries customer
  name, phone, party size, waiver status, balance due, and an admin deep link to
  the order (`ADMIN_BASE_URL`, falling back to `admin.{APP_BASE_DOMAIN}` /
  `localhost:3002`). `DTSTART`/`DTEND` are UTC instants (`DTEND` = timeslot start
  + rate `duration_minutes`); UIDs are stable per order item so a reschedule
  UPDATES the calendar event instead of duplicating it.
- **Subscribe:** Google Calendar → *Other calendars → + → From URL* → paste the
  feed URL. Apple Calendar: *File → New Calendar Subscription*. Outlook: *Add
  calendar → Subscribe from web*. Google refreshes subscribed feeds on its own
  cadence (typically every few hours); the endpoint answers with
  `Cache-Control: private, max-age=300`.

### 2. Per-booking add-to-calendar (customer side)

On the booking confirmation page (`apps/web/app/confirmation`), below the
reservation details:

- **Add to Google Calendar** — a `calendar.google.com/calendar/render?action=TEMPLATE`
  link prefilled with the activity, start/end (from the rate duration), order
  number, and party size.
- **Download .ics** — `GET /calendar/booking/:orderItemId.ics` on the API
  (public; the order-item cuid is the capability; rate-limited). The web app
  proxies it same-origin at `/calendar/booking/:itemId.ics` so the download works
  wherever the site is reached (WSL/LAN/dev). The file deliberately contains no
  admin link, phone number, or balance — nothing beyond what the confirmation
  page already shows.

Both surfaces share one pure ICS builder,
`apps/api/src/services/calendar-feed.ts` (escaping, 75-octet line folding, UTC
formatting, stable UIDs, duration math — unit-tested in
`apps/api/test/calendar-feed.test.ts`; route wiring is covered by
`apps/api/test/calendar.integration.test.ts`).

## Deliberately deferred

- **Google OAuth two-way push sync** (events created/updated in the operator's
  Google Calendar via the Calendar API, with instant push instead of polling).
  This requires an owner-created Google Cloud project + OAuth consent screen and
  per-operator token storage. The `Integration`-table pattern used by
  `calendar_feed` (and `twilio`) is ready to hold those credentials
  (`key: 'google_calendar'`, `config: { refresh_token, calendar_id, ... }`) when
  that lands — no schema change needed.
- Per-staff/per-location filtered feeds and a customer "subscribe to all my
  bookings" feed — easy extensions of the same token pattern if asked for.
