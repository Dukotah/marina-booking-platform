/**
 * Gift cards API.
 *
 *   GET    /:code            public — check a card's balance/validity
 *   POST   /redeem           public — apply a card to an order (customer checkout / POS)
 *   GET    /                 staff  — list issued cards (operator:manage)
 *   POST   /                 staff  — issue a new card (operator:manage)
 *
 * All data access is tenant-scoped by RLS. Redemption logic (balance math, order
 * settlement) lives in services/gift-cards.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import {
  issueGiftCard,
  checkGiftCard,
  redeemGiftCard,
  giftCardLiabilityCents,
  GiftCardError,
} from '../services/gift-cards.js';

export const giftCards = new Hono<Env>();

// Throttle the public balance-check + redeem endpoints per IP + tenant so codes
// can't be brute-force enumerated.
const publicRateLimit = rateLimit();

/** GET /api/gift-cards/:code — PUBLIC balance/validity check. */
giftCards.get('/:code', publicRateLimit, async (c) => {
  const code = c.req.param('code');
  const result = await checkGiftCard(c.var.operatorId, code);
  return c.json(result);
});

const redeemSchema = z.object({
  code: z.string().trim().min(1, 'A gift card code is required'),
  orderId: z.string().min(1, 'An order id is required'),
  amountCents: z.number().int().positive().optional(),
});

/** POST /api/gift-cards/redeem — PUBLIC (customer checkout / POS). Apply to an order. */
giftCards.post('/redeem', publicRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = redeemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const result = await redeemGiftCard(c.var.operatorId, {
      code: parsed.data.code,
      orderId: parsed.data.orderId,
      amountCents: parsed.data.amountCents,
      actor: 'customer',
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof GiftCardError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

/** GET /api/gift-cards — staff list + outstanding liability. */
giftCards.get('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const [rows, liabilityCents] = await Promise.all([
    c.var.db.giftCard.findMany({ orderBy: { created_at: 'desc' } }),
    giftCardLiabilityCents(c.var.operatorId),
  ]);
  return c.json({ giftCards: rows, liabilityCents });
});

const issueSchema = z.object({
  initialCents: z.number().int().positive('Amount must be a positive number of cents'),
  purchaserEmail: z.string().email().optional(),
  recipientName: z.string().trim().max(160).optional(),
  recipientEmail: z.string().email().optional(),
  message: z.string().trim().max(500).optional(),
  expiresAt: z.string().datetime().optional(),
});

/** POST /api/gift-cards — staff issue a new card. */
giftCards.post('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const body = await c.req.json().catch(() => null);
  const parsed = issueSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  try {
    const card = await issueGiftCard(c.var.operatorId, {
      initialCents: parsed.data.initialCents,
      purchaserEmail: parsed.data.purchaserEmail,
      recipientName: parsed.data.recipientName,
      recipientEmail: parsed.data.recipientEmail,
      message: parsed.data.message,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined,
    });
    return c.json({ giftCard: card }, 201);
  } catch (err) {
    if (err instanceof GiftCardError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});
