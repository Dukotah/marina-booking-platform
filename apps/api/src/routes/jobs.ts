/**
 * Scheduled-job triggers — endpoints an external scheduler pings on a cadence.
 *
 *   POST /jobs/reminders   send all due pre-arrival reminder emails
 *
 * These are platform-level (not tenant-scoped): they iterate operators internally,
 * so they are mounted OUTSIDE the tenant middleware (no x-operator-slug header) —
 * the same posture as /webhooks. Authentication is a shared secret, not a staff
 * session: set `JOBS_SECRET` and have the scheduler send it as
 * `Authorization: Bearer <secret>` (Vercel Cron's convention) or `x-jobs-secret`.
 *
 * Fail-closed in production: with no `JOBS_SECRET` set, the endpoint is open only in
 * non-production (local/dev/test convenience) and refuses in production — mirroring
 * the customer-auth secret posture (D-017).
 *
 * Example cron (hourly): a Vercel `vercel.json` cron or any scheduler doing
 *   curl -X POST https://api.example.com/jobs/reminders -H "Authorization: Bearer $JOBS_SECRET"
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../context.js';
import { sendDueReminders } from '../services/reminders.js';

export const jobs = new Hono<Env>();

/**
 * True if the caller presented the shared job secret (or we're in an open dev env).
 * Env is read per request (not cached at import) so deployment config changes — and
 * tests — take effect without a restart.
 */
function isAuthorized(authHeader: string | undefined, secretHeader: string | undefined): boolean {
  const secret = process.env.JOBS_SECRET;
  if (secret) {
    const bearer =
      authHeader && authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : undefined;
    const provided = bearer ?? secretHeader;
    return provided === secret;
  }
  // No secret configured → open in non-prod only (fail closed in production).
  return process.env.NODE_ENV !== 'production';
}

const reminderParamsSchema = z.object({
  leadHours: z.number().positive().max(24 * 14).optional(),
  operatorId: z.string().min(1).optional(),
  maxPerOperator: z.number().int().positive().max(10_000).optional(),
  checkInLeadMinutes: z.number().int().nonnegative().max(24 * 60).optional(),
});

jobs.post('/reminders', async (c) => {
  if (!isAuthorized(c.req.header('authorization'), c.req.header('x-jobs-secret'))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Params are optional; accept them from the JSON body (a cron may send none).
  const parsed = reminderParamsSchema.safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  const summary = await sendDueReminders(parsed.data);
  return c.json({ ok: true, summary });
});
