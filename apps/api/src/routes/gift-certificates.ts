/**
 * Gift certificates API — SINGLE-USE certificates, distinct from stored-value cards.
 *
 *   GET    /:code            public — check a certificate's validity/value
 *   POST   /redeem           public — redeem against an order (checkout / POS)
 *   GET    /                 staff  — list issued certificates + liability (operator:manage)
 *   POST   /                 staff  — issue a new certificate (operator:manage)
 *
 * All data access is tenant-scoped by RLS. Redemption logic lives in
 * services/gift-certificates.ts. Mounted by the orchestrator at /api/gift-certificates.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { getClientIp, rateLimit } from '../middleware/rate-limit.js';
import {
  AUDIT_ACTIONS,
  SYSTEM_ACTOR,
  customerActor,
  recordAudit,
  staffActor,
} from '../services/audit.js';
import {
  issueGiftCertificate,
  checkGiftCertificate,
  redeemGiftCertificate,
  giftCertificateLiabilityCents,
  GiftCertificateError,
} from '../services/gift-certificates.js';

export const giftCertificates = new Hono<Env>();

// Throttle the public check + redeem endpoints so codes can't be brute-forced.
const publicRateLimit = rateLimit();

/** GET /api/gift-certificates/:code — PUBLIC validity/value check. */
giftCertificates.get('/:code', publicRateLimit, async (c) => {
  const result = await checkGiftCertificate(c.var.operatorId, c.req.param('code'));
  return c.json(result);
});

const redeemSchema = z.object({
  code: z.string().trim().min(1, 'A gift certificate code is required'),
  orderId: z.string().min(1, 'An order id is required'),
});

/** POST /api/gift-certificates/redeem — PUBLIC (checkout / POS). Apply to an order. */
giftCertificates.post('/redeem', publicRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = redeemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const result = await redeemGiftCertificate(c.var.operatorId, {
      code: parsed.data.code,
      orderId: parsed.data.orderId,
      actor: 'customer',
    });

    // Redemption is the moment a certificate stops being a liability and becomes
    // collected revenue, so the row carries the order balance on both sides of it.
    // redeemGiftCertificate applies exactly `appliedCents` inside one transaction,
    // so the pre-state is the post-state minus that — exact, and it spares a read.
    const order = await c.var.db.order.findUnique({
      where: { id: parsed.data.orderId },
      select: { order_number: true, customer_id: true },
    });

    await recordAudit({
      operatorId: c.var.operatorId,
      actor: order
        ? customerActor(order.customer_id, getClientIp((h) => c.req.header(h)))
        : { ...SYSTEM_ACTOR, ip: getClientIp((h) => c.req.header(h)) },
      action: AUDIT_ACTIONS.GIFT_CARD_REDEEM,
      entityType: 'GiftCertificate',
      entityId: result.giftCertificateId,
      before: {
        status: 'ACTIVE',
        order_amount_paid_cents: result.orderAmountPaidCents - result.appliedCents,
        order_balance_due_cents: result.orderBalanceDueCents + result.appliedCents,
      },
      after: {
        status: 'REDEEMED',
        order_amount_paid_cents: result.orderAmountPaidCents,
        order_balance_due_cents: result.orderBalanceDueCents,
      },
      context: {
        code: result.code,
        applied_cents: result.appliedCents,
        order_id: parsed.data.orderId,
        order_number: order?.order_number ?? null,
      },
    });

    return c.json(result);
  } catch (err) {
    if (err instanceof GiftCertificateError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

/** GET /api/gift-certificates — staff list + outstanding liability. */
giftCertificates.get('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const [rows, liabilityCents] = await Promise.all([
    c.var.db.giftCertificate.findMany({ orderBy: { created_at: 'desc' } }),
    giftCertificateLiabilityCents(c.var.operatorId),
  ]);
  return c.json({ giftCertificates: rows, liabilityCents });
});

const issueSchema = z.object({
  valueCents: z.number().int().positive('Value must be a positive number of cents'),
  activityId: z.string().min(1).optional(),
  purchaserEmail: z.string().email().optional(),
  recipientName: z.string().trim().max(160).optional(),
  recipientEmail: z.string().email().optional(),
  message: z.string().trim().max(500).optional(),
  expiresAt: z.string().datetime().optional(),
});

/** POST /api/gift-certificates — staff issue a new certificate. */
giftCertificates.post('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const body = await c.req.json().catch(() => null);
  const parsed = issueSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const cert = await issueGiftCertificate(c.var.operatorId, {
      valueCents: parsed.data.valueCents,
      activityId: parsed.data.activityId,
      purchaserEmail: parsed.data.purchaserEmail,
      recipientName: parsed.data.recipientName,
      recipientEmail: parsed.data.recipientEmail,
      message: parsed.data.message,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
    });

    // Issuing a certificate creates an outstanding liability out of nothing, so
    // who authorized it and for how much is the point of the row. The code is
    // recorded because it is how an operator identifies a certificate, and this
    // page is gated on the same `operator:manage` that already lists every code.
    await recordAudit({
      operatorId: c.var.operatorId,
      actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
      action: AUDIT_ACTIONS.GIFT_CARD_ISSUE,
      entityType: 'GiftCertificate',
      entityId: cert.id,
      after: {
        code: cert.code,
        value_cents: cert.value_cents,
        status: cert.status,
        activity_id: cert.activity_id,
        recipient_name: cert.recipient_name,
        recipient_email: cert.recipient_email,
        purchaser_email: cert.purchaser_email,
        expires_at: cert.expires_at,
      },
      context: { has_gift_message: Boolean(cert.message) },
    });

    return c.json({ giftCertificate: cert }, 201);
  } catch (err) {
    if (err instanceof GiftCertificateError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});
