/**
 * Check-in scan API.
 *
 *   POST /scan   staff (order:write) — verify a QR check-in token and check the
 *                guest's booked item in.
 *
 * The token is the HMAC-signed value encoded in the booking's confirmation QR
 * (see @marina/core signCheckinToken). A staff device scans the QR, then POSTs
 * the token here. We verify the signature, resolve the named order-item inside
 * this operator's tenant scope (RLS via `c.var.db`), and route to the SAME
 * check-in write the day manifest uses: set the item CHECKED_IN + record a
 * CHECK_IN order event. Idempotent — re-scanning an already-checked-in item
 * re-affirms it without a duplicate audit row.
 *
 * Security:
 *  - requireStaff + order:write — only staff of THIS operator may check guests in.
 *  - The token signature is the gate against a forged/tampered order-item id; a
 *    bad signature is a 400, never a check-in.
 *  - The lookup is tenant-scoped, so a validly-signed token for another
 *    operator's item resolves to nothing here and 404s.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import { verifyCheckinToken } from '@marina/core/checkin-token';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';

export const checkin = new Hono<Env>();

const scanSchema = z.object({
  token: z.string().min(1, 'A check-in token is required.'),
});

checkin.post('/scan', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const raw = await c.req.json().catch(() => null);
  const parsed = scanSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'A check-in token is required.' }, 400);
  }

  const verified = verifyCheckinToken(parsed.data.token);
  if (!verified) {
    return c.json({ ok: false, error: 'This QR code is not a valid check-in code.' }, 400);
  }
  if (!verified.signatureValid) {
    // Tampered or foreign-key token — refuse rather than trust the named item.
    return c.json({ ok: false, error: 'This check-in code failed verification.' }, 400);
  }

  const { on: orderNumber, iid: orderItemId } = verified.payload;

  // Tenant-scoped: an item from another operator simply isn't visible here.
  const item = await c.var.db.orderItem.findFirst({
    where: {
      id: orderItemId,
      order: { order_number: orderNumber },
    },
    select: {
      id: true,
      status: true,
      order_id: true,
      order: { select: { order_number: true } },
      activity: { select: { name_external: true } },
    },
  });

  if (!item) {
    return c.json({ ok: false, error: 'Booking not found for this check-in code.' }, 404);
  }

  const activityName = item.activity?.name_external ?? null;

  // Idempotent: an already-checked-in item re-affirms without a duplicate event.
  if (item.status === 'CHECKED_IN') {
    return c.json({
      ok: true,
      status: 'CHECKED_IN',
      alreadyCheckedIn: true,
      orderNumber: item.order.order_number,
      orderItemId: item.id,
      activityName,
    });
  }

  await c.var.db.orderItem.update({
    where: { id: item.id },
    data: { status: 'CHECKED_IN' },
  });

  await c.var.db.orderEvent.create({
    data: {
      operator_id: c.var.operatorId,
      order_id: item.order_id,
      type: 'CHECK_IN',
      description: 'Guest checked in by QR scan',
      actor: c.var.auth.userId,
    },
  });

  return c.json({
    ok: true,
    status: 'CHECKED_IN',
    alreadyCheckedIn: false,
    orderNumber: item.order.order_number,
    orderItemId: item.id,
    activityName,
  });
});
