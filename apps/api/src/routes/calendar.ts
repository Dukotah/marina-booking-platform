/**
 * Calendar endpoints — the iCalendar surface of the platform.
 *
 *   GET /calendar/feed/:token(.ics)        per-operator subscribe feed (secret token)
 *   GET /calendar/booking/:orderItemId(.ics)  one booking as a downloadable .ics
 *
 * TENANCY: both routes are mounted OUTSIDE the /api tenant middleware (like
 * /webhooks and /internal) because neither request carries an x-operator-slug —
 * Google Calendar polls a bare URL. The operator is resolved FROM the request:
 *  - the feed token is matched against `calendar_feed` Integration rows via the
 *    owner (non-RLS) client — the one intentionally cross-tenant lookup, exactly
 *    the webhook pattern — and
 *  - the booking download resolves operator_id from the order item id (a cuid,
 *    unguessable).
 * All actual DATA reads then go through the tenant-scoped client (RLS).
 *
 * SECURITY: the feed is authenticated by a 32+ char secret token stored in the
 * operator's `calendar_feed` Integration config (generated/rotated in admin
 * Settings → Integrations). Unknown/disabled tokens 404 without detail. Both
 * routes are rate-limited per client IP; token comparison is constant-time.
 * The per-booking download contains no admin link, no customer phone and no
 * balance — nothing beyond what the confirmation page already shows.
 */
import { Hono, type Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { adminPrisma, forOperator } from '@marina/database';
import type { Env } from '../context.js';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  buildIcsCalendar,
  bookingToEvent,
  type BookingEventSource,
} from '../services/calendar-feed.js';

export const calendar = new Hono<Env>();

// Feeds are polled by calendar services (Google refreshes every few hours) and
// occasionally by an operator's browser; 60/min per IP is generous for both while
// still blunting token brute-force. The booking download shares the posture.
calendar.use('*', rateLimit({ max: 60 }));

/** How far back the feed reaches: recently past bookings stay visible ~7 days. */
const PAST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on feed size — Google truncates giant feeds anyway. */
const MAX_FEED_EVENTS = 1000;

/** Accept `:param` with or without a trailing `.ics`. */
function stripIcsSuffix(raw: string): string {
  return raw.toLowerCase().endsWith('.ics') ? raw.slice(0, -4) : raw;
}

/** Constant-time string comparison (both sides attacker-observable timing). */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the token string out of a `calendar_feed` Integration config blob. */
function configToken(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const token = (config as Record<string, unknown>).token;
  return typeof token === 'string' && token.length >= 16 ? token : null;
}

/**
 * Base URL of the operator (admin) app for order deep links. `ADMIN_BASE_URL`
 * wins; otherwise derived from APP_BASE_DOMAIN the same way the CORS fallback
 * does (dev → localhost:3002, deployed → admin.<base>).
 */
function adminBaseUrl(): string {
  const explicit = (process.env.ADMIN_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const base = (process.env.APP_BASE_DOMAIN ?? 'localhost:3000').trim();
  if (base.startsWith('localhost') || base.startsWith('127.0.0.1')) {
    return 'http://localhost:3002';
  }
  return `https://admin.${base}`;
}

/** Relations every calendar event needs (matches BookingEventSource). */
const EVENT_INCLUDE = {
  activity: {
    select: {
      name_external: true,
      location: { select: { name: true, address: true, city: true, state: true } },
    },
  },
  rate: { select: { duration_minutes: true } },
  timeslot: { select: { datetime: true } },
  order: {
    select: {
      id: true,
      order_number: true,
      status: true,
      balance_due_cents: true,
      customer: { select: { first_name: true, last_name: true, phone: true } },
    },
  },
} as const;

function icsResponse(c: Context<Env>, body: string, extraHeaders?: Record<string, string>) {
  return c.body(body, 200, {
    'content-type': 'text/calendar; charset=utf-8',
    'cache-control': 'private, max-age=300',
    ...extraHeaders,
  });
}

// ---------------------------------------------------------------------------
// GET /calendar/feed/:token(.ics) — the operator subscribe feed
// ---------------------------------------------------------------------------

calendar.get('/feed/:token', async (c) => {
  const token = stripIcsSuffix(c.req.param('token') ?? '').trim();
  if (token.length < 16) return c.json({ error: 'Not found' }, 404);

  // Owner-client lookup: there is no tenant context until the token names one.
  // calendar_feed rows are one per operator, so this scan is tiny.
  const rows = await adminPrisma.integration.findMany({
    where: { key: 'calendar_feed', enabled: true },
    select: { operator_id: true, config: true },
  });
  const match = rows.find((row) => {
    const stored = configToken(row.config);
    return stored !== null && tokenMatches(stored, token);
  });
  if (!match) return c.json({ error: 'Not found' }, 404);

  // From here on: tenant-scoped reads only (RLS).
  const db = forOperator(match.operator_id);
  const operator = await db.operator.findUnique({
    where: { id: match.operator_id },
    select: { name_external: true },
  });
  if (!operator) return c.json({ error: 'Not found' }, 404);

  const since = new Date(Date.now() - PAST_WINDOW_MS);
  const items = await db.orderItem.findMany({
    where: {
      // Booked seats only — checkout add-on lines ride on the same timeslot and
      // would duplicate the event.
      add_on_id: null,
      status: { not: 'CANCELLED' },
      order: { status: { not: 'CANCELLED' } },
      timeslot: { datetime: { gte: since } },
    },
    include: EVENT_INCLUDE,
    orderBy: { timeslot: { datetime: 'asc' } },
    take: MAX_FEED_EVENTS,
  });

  const base = adminBaseUrl();
  const ics = buildIcsCalendar({
    calendarName: `${operator.name_external} — Bookings`,
    events: items.map((item) =>
      bookingToEvent(item as BookingEventSource, `${base}/orders/${item.order.id}`),
    ),
  });
  return icsResponse(c, ics);
});

// ---------------------------------------------------------------------------
// GET /calendar/booking/:orderItemId(.ics) — one booking for the customer
// ---------------------------------------------------------------------------

calendar.get('/booking/:orderItemId', async (c) => {
  const orderItemId = stripIcsSuffix(c.req.param('orderItemId') ?? '').trim();
  if (!orderItemId) return c.json({ error: 'Not found' }, 404);

  // Owner-client lookup ONLY to discover the tenant (webhook pattern); the data
  // read below goes through the RLS client.
  const ref = await adminPrisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: { operator_id: true },
  });
  if (!ref) return c.json({ error: 'Not found' }, 404);

  const db = forOperator(ref.operator_id);
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    include: EVENT_INCLUDE,
  });
  if (!item || item.add_on_id !== null) return c.json({ error: 'Not found' }, 404);

  // Customer-facing: no admin deep link, and the description is trimmed to what
  // the confirmation page already shows (no phone, no balance).
  const event = bookingToEvent(item as BookingEventSource);
  event.description = [
    `Order ${item.order.order_number}`,
    `Party size: ${item.quantity}`,
  ].join('\n');
  event.url = undefined;

  const operator = await db.operator.findUnique({
    where: { id: ref.operator_id },
    select: { name_external: true },
  });

  const ics = buildIcsCalendar({
    calendarName: operator?.name_external ?? 'Booking',
    events: [event],
  });
  return icsResponse(c, ics, {
    'content-disposition': `attachment; filename="booking-${item.order.order_number}.ics"`,
  });
});
