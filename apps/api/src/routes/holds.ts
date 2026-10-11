/**
 * Cart-holds API — mounted under `/api/holds` (tenant-scoped).
 *
 *   POST /            public — reserve seats for the operator's hold window when a
 *                     guest starts checkout; returns the hold id + expiry (the
 *                     checkout countdown's deadline). Rate-limited per IP + tenant
 *                     like the other public order endpoints.
 *   DELETE /:holdId   public — release a still-active hold early (guest abandoned
 *                     checkout or changed their seat count), freeing the seats
 *                     immediately rather than waiting for expiry.
 *
 * The hold is race-safe (createHold takes the same timeslot FOR UPDATE lock the
 * booking service uses) and is consumed by the booking that eventually lands. The
 * server is the authority on how many seats are free — it re-reads capacity + live
 * holds under the lock and never trusts the client's view of availability.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../context.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { createHold, releaseHold, HoldError } from '../services/holds.js';

export const holds = new Hono<Env>();

const publicRateLimit = rateLimit();

const createSchema = z
  .object({
    timeslotId: z.string().trim().min(1, 'timeslotId is required').max(64),
    seats: z.number().int().positive('seats must be at least 1').max(1000),
  })
  .strict();

holds.post('/', publicRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
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
    const result = await createHold(c.var.operatorId, parsed.data);
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof HoldError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400 | 403 | 404 | 409);
    }
    throw err;
  }
});

holds.delete('/:holdId', publicRateLimit, async (c) => {
  const holdId = c.req.param('holdId');
  if (!holdId || holdId.trim().length === 0) {
    return c.json({ error: 'holdId is required' }, 400);
  }
  // Idempotent: releasing an unknown/already-gone hold is a success — the seats are
  // free either way, and the client should never see an error for "undo my hold".
  await releaseHold(c.var.operatorId, holdId.trim());
  return c.json({ ok: true });
});
