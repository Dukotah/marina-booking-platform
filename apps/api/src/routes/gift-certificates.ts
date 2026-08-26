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
import { rateLimit } from '../middleware/rate-limit.js';
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
    return c.json({ giftCertificate: cert }, 201);
  } catch (err) {
    if (err instanceof GiftCertificateError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});
