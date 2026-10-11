/**
 * Waitlist API — mounted under `/api/waitlist` (tenant-scoped).
 *
 *   POST /          public — join the waitlist for a sold-out timeslot
 *   POST /notify    staff (order:write) — email the oldest PENDING entries on a
 *                   slot that now has room ("Notify next" on the admin manifest)
 *
 * Joining is public and automatic notification happens when the booking service
 * releases capacity (services/waitlist.ts). The /notify surface lets a staffer
 * hand-trigger the same sweep from the manifest when they free a seat directly
 * (a dock cancellation). Removing entries stays in the admin's own tenant-scoped
 * server action (direct DB, per D-007); notify lives here because the API owns
 * Resend + the email templates. Public POST / is rate-limited per client IP +
 * tenant exactly like the other public order endpoints.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  joinWaitlist,
  notifyWaitlistForTimeslots,
  WaitlistError,
} from '../services/waitlist.js';

export const waitlist = new Hono<Env>();

const publicRateLimit = rateLimit();

const joinSchema = z
  .object({
    timeslotId: z.string().trim().min(1, 'timeslotId is required').max(64),
    name: z.string().trim().min(1, 'name is required').max(120),
    email: z.string().trim().email('a valid email is required').max(254),
    phone: z.string().trim().max(32).optional().nullable(),
  })
  .strict();

waitlist.post('/', publicRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = joinSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Validation failed',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  try {
    await joinWaitlist(c.var.operatorId, parsed.data);
  } catch (err) {
    if (err instanceof WaitlistError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400 | 404 | 409);
    }
    throw err;
  }

  // 201 whether created or already on the list — either way the guest is queued,
  // and the response leaks nothing about who else is waiting.
  return c.json({ ok: true }, 201);
});

// --- POST /notify : hand-trigger the notify sweep for a slot ----------------

const notifySchema = z
  .object({
    timeslotId: z.string().trim().min(1, 'timeslotId is required').max(64),
  })
  .strict();

waitlist.post('/notify', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const parsed = notifySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: 'Validation failed',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  // Reuse the exact sweep the booking service fires on a capacity release: it
  // only emails up to the seats actually open on the slot and claims each entry
  // before sending, so a hand-trigger can never double-notify. A slot with no
  // room or no PENDING entries is a no-op (notified: 0).
  const result = await notifyWaitlistForTimeslots(c.var.operatorId, [parsed.data.timeslotId]);
  return c.json({ ok: true, notified: result.notified });
});
