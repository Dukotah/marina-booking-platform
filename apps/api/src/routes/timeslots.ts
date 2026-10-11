/**
 * Timeslots API — mounted under `/api/timeslots` (tenant-scoped).
 *
 *   POST /:id/broadcast   staff (order:write) — message every live booking on a
 *                         timeslot (weather hold, dock moved, running late) by
 *                         email and/or SMS.
 *
 * Broadcast lives here (not in the admin's own tenant-scoped server action) for
 * the same reason the waitlist notify does: the API owns Resend + Twilio + the
 * message choke points. The admin server action calls this with the trusted
 * server-to-server x-operator-id header.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { broadcastToTimeslot, BroadcastError } from '../services/broadcast.js';

export const timeslots = new Hono<Env>();

const broadcastSchema = z
  .object({
    body: z.string().trim().min(1, 'A message is required').max(1000),
    email: z.boolean().optional().default(true),
    sms: z.boolean().optional().default(false),
    subject: z.string().trim().max(200).optional(),
  })
  .strict();

timeslots.post('/:id/broadcast', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const timeslotId = c.req.param('id');
  const parsed = broadcastSchema.safeParse(await c.req.json().catch(() => null));
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
    const result = await broadcastToTimeslot(c.var.operatorId, {
      timeslotId,
      body: parsed.data.body,
      subject: parsed.data.subject,
      channels: { email: parsed.data.email, sms: parsed.data.sms },
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof BroadcastError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400 | 404);
    }
    throw err;
  }
});
