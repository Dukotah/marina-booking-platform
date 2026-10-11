/**
 * Internal / scheduled-job endpoints — POST /internal/reminders/run
 *
 * These run on a schedule (cron, Vercel Cron, GitHub Action, etc.), not per-user.
 * They arrive with NO tenant context and sweep across ALL operators, so they are
 * mounted OUTSIDE the /api tenant middleware — the reminder engine itself scopes
 * each operator's writes through its RLS tenant client.
 *
 * SECURITY: gated by a shared secret. Set `CRON_SECRET` and send it as
 * `Authorization: Bearer <secret>` (or `x-cron-secret`). If `CRON_SECRET` is unset
 * (local/dev) the endpoint is open so the sweep can be exercised without config —
 * the same graceful-degradation posture as the Stripe webhook.
 */
import { Hono } from 'hono';
import type { Env } from '../context.js';
import { runAllDueReminders, runAllDuePostTripReviews } from '../services/notifications.js';
import { runScheduleSweep } from '../services/schedules.js';
import { runHoldsSweep } from '../services/holds.js';

export const internal = new Hono<Env>();

/** Default look-ahead window: remind guests whose trip starts within 24 hours. */
const DEFAULT_WITHIN_HOURS = 24;

function authorized(header: (name: string) => string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev / unconfigured — open, matches webhook posture
  const bearer = header('authorization')?.replace(/^Bearer\s+/i, '').trim();
  const custom = header('x-cron-secret')?.trim();
  return bearer === secret || custom === secret;
}

/**
 * Run the pre-arrival reminder sweep across every active operator. Optional
 * `?withinHours=` overrides the look-ahead window (1–168h). Idempotent: an order is
 * reminded at most once (tracked via a REMINDER_SENT order event).
 */
internal.post('/reminders/run', async (c) => {
  if (!authorized((name) => c.req.header(name))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const raw = Number.parseInt(c.req.query('withinHours') ?? '', 10);
  const withinHours = Number.isFinite(raw) ? Math.min(168, Math.max(1, raw)) : DEFAULT_WITHIN_HOURS;

  const result = await runAllDueReminders({ withinHours });
  return c.json({ ok: true, withinHours, ...result });
});

/** Default look-back window: ask for a review once the trip ended 3+ hours ago. */
const DEFAULT_AFTER_HOURS = 3;

/**
 * Run the post-trip review-request sweep across every active operator. Optional
 * `?afterHours=` overrides how long after a trip ends to ask (1–168h). Idempotent:
 * an order is asked at most once (tracked via a REVIEW_SENT order event). No-ops for
 * operators without a review_url configured.
 */
internal.post('/reviews/run', async (c) => {
  if (!authorized((name) => c.req.header(name))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const raw = Number.parseInt(c.req.query('afterHours') ?? '', 10);
  const afterHours = Number.isFinite(raw) ? Math.min(168, Math.max(1, raw)) : DEFAULT_AFTER_HOURS;

  const result = await runAllDuePostTripReviews({ afterHours });
  return c.json({ ok: true, afterHours, ...result });
});

/**
 * Top up the rolling schedule horizon: re-materialize every activity that has an
 * active ScheduleRule, for every active operator. Idempotent — a day with its
 * slots already in place is left untouched, so running this hourly or daily is
 * equally safe. Optional `?horizonDays=` overrides the look-ahead (1–366 days).
 */
internal.post('/schedules/run', async (c) => {
  if (!authorized((name) => c.req.header(name))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const raw = Number.parseInt(c.req.query('horizonDays') ?? '', 10);
  const horizonDays = Number.isFinite(raw) ? Math.min(366, Math.max(1, raw)) : undefined;

  const result = await runScheduleSweep({ horizonDays });
  return c.json({ ok: true, ...result });
});

/**
 * Free expired (and spent) cart holds across every active operator. Lazy on-read
 * expiry already stops a lapsed hold from reducing availability the instant it
 * lapses — this sweep is housekeeping so the CartHold table doesn't grow without
 * bound. Idempotent and safe to run as often as a cron fires.
 */
internal.post('/holds/sweep', async (c) => {
  if (!authorized((name) => c.req.header(name))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const result = await runHoldsSweep();
  return c.json({ ok: true, ...result });
});
