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
import { runAllDueReminders } from '../services/notifications.js';

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
