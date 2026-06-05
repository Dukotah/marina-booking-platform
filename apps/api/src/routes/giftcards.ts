/**
 * Gift cards API.
 *
 *   POST   /                    staff (order:write)  — issue (sell) a gift card
 *   GET    /                    staff (order:read)   — list the tenant's gift cards
 *   GET    /:code/balance       public — check a card's balance by its full code
 *   POST   /:code/redeem        staff (order:write)  — redeem an amount from a card
 *   POST   /:code/adjust        staff (order:refund) — manual signed balance correction
 *   POST   /:code/void          staff (order:refund) — freeze a card (balance kept)
 *   POST   /:code/reactivate    staff (order:refund) — un-freeze a voided card
 *
 * Manual balance management (adjust/void/reactivate) is gated at the higher
 * `order:refund` tier, not `order:write`: rewriting stored value is a
 * money-correction action on par with issuing a refund, so plain order staff
 * cannot do it. Each appends a signed `ADJUST` ledger row (void/reactivate write a
 * zero-amount marker), preserving the ledger-sums-to-balance invariant.
 *
 * The card `code` is the bearer secret: a public balance check by full code is fine
 * (you must already hold the code), but issuing and redeeming are staff actions.
 * Redeeming against a *customer* checkout ties into the payment flow and is a
 * follow-up (see docs/ROADMAP.md). All data access goes through the RLS-scoped
 * tenant client; amounts are NEVER trusted as already-validated — see
 * services/giftcards.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import type { Prisma } from '@marina/database';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import {
  issueGiftCard,
  redeemGiftCard,
  getGiftCardByCode,
  adjustGiftCardBalance,
  voidGiftCard,
  reactivateGiftCard,
  GiftCardError,
} from '../services/giftcards.js';

export const giftcards = new Hono<Env>();

// --- Serialization --------------------------------------------------------

type GiftCardRow = Prisma.GiftCardGetPayload<Record<string, never>>;

/** Shape a gift card into a stable, client-facing JSON payload. */
function serializeGiftCard(card: GiftCardRow) {
  return {
    id: card.id,
    code: card.code,
    initialCents: card.initial_cents,
    balanceCents: card.balance_cents,
    isActive: card.is_active,
    purchaserName: card.purchaser_name,
    purchaserEmail: card.purchaser_email,
    recipientName: card.recipient_name,
    recipientEmail: card.recipient_email,
    message: card.message,
    issuedBy: card.issued_by,
    expiresAt: card.expires_at,
    createdAt: card.created_at,
  };
}

// --- POST / : issue a gift card (staff, order:write) ----------------------

const issueSchema = z.object({
  amountCents: z.number().int().positive('amountCents must be a positive integer'),
  purchaserName: z.string().trim().max(160).nullable().optional(),
  purchaserEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  recipientName: z.string().trim().max(160).nullable().optional(),
  recipientEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  message: z.string().trim().max(1000).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

giftcards.post('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const parsed = issueSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  try {
    const card = await issueGiftCard(c.var.operatorId, parsed.data, {
      actor: c.var.auth.userId,
    });
    return c.json({ giftCard: serializeGiftCard(card) }, 201);
  } catch (err) {
    if (err instanceof GiftCardError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

// --- GET / : list gift cards (staff, order:read) --------------------------

giftcards.get('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:read');

  const take = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const skip = Math.max(Number(c.req.query('offset')) || 0, 0);

  const [rows, total] = await Promise.all([
    c.var.db.giftCard.findMany({ orderBy: { created_at: 'desc' }, take, skip }),
    c.var.db.giftCard.count(),
  ]);

  return c.json({
    giftCards: rows.map(serializeGiftCard),
    pagination: { total, limit: take, offset: skip },
  });
});

// --- GET /:code/balance : public balance check ----------------------------

giftcards.get('/:code/balance', async (c) => {
  const code = c.req.param('code');
  const card = await getGiftCardByCode(c.var.operatorId, code);
  if (!card) {
    return c.json({ error: 'No gift card matches that code' }, 404);
  }
  const expired = card.expires_at != null && card.expires_at.getTime() <= Date.now();
  return c.json({
    code: card.code,
    balanceCents: card.balance_cents,
    isActive: card.is_active,
    expired,
    expiresAt: card.expires_at,
  });
});

// --- POST /:code/redeem : redeem an amount (staff, order:write) ------------

const redeemSchema = z.object({
  amountCents: z.number().int().positive('amountCents must be a positive integer'),
  /** Optional order this redemption is applied to (recorded on the ledger). */
  orderId: z.string().min(1).optional(),
  note: z.string().trim().max(500).optional(),
});

giftcards.post('/:code/redeem', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const code = c.req.param('code');
  const parsed = redeemSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  try {
    const result = await redeemGiftCard(c.var.operatorId, code, parsed.data.amountCents, {
      orderId: parsed.data.orderId,
      actor: c.var.auth.userId,
      note: parsed.data.note,
    });
    return c.json({
      giftCard: serializeGiftCard(result.card),
      amountAppliedCents: result.amountAppliedCents,
      balanceCents: result.balanceCents,
    });
  } catch (err) {
    if (err instanceof GiftCardError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

// --- POST /:code/adjust : manual balance correction (staff, order:refund) --

const adjustSchema = z.object({
  /** Signed delta in cents: positive credits the card up, negative corrects it down. */
  deltaCents: z.number().int().refine((n) => n !== 0, 'deltaCents must be a non-zero integer'),
  reason: z.string().trim().min(1, 'reason is required').max(500),
});

giftcards.post('/:code/adjust', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:refund');

  const code = c.req.param('code');
  const parsed = adjustSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  try {
    const result = await adjustGiftCardBalance(
      c.var.operatorId,
      code,
      parsed.data.deltaCents,
      parsed.data.reason,
      { actor: c.var.auth.userId },
    );
    return c.json({
      giftCard: serializeGiftCard(result.card),
      deltaCents: result.deltaCents,
      balanceCents: result.balanceCents,
    });
  } catch (err) {
    if (err instanceof GiftCardError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

// --- POST /:code/void : freeze a card (staff, order:refund) ----------------

const voidSchema = z.object({ reason: z.string().trim().max(500).optional() });

giftcards.post('/:code/void', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:refund');

  const code = c.req.param('code');
  const parsed = voidSchema.safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  try {
    const card = await voidGiftCard(c.var.operatorId, code, {
      reason: parsed.data.reason,
      actor: c.var.auth.userId,
    });
    return c.json({ giftCard: serializeGiftCard(card) });
  } catch (err) {
    if (err instanceof GiftCardError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

// --- POST /:code/reactivate : un-freeze a voided card (staff, order:refund) -

giftcards.post('/:code/reactivate', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:refund');

  const code = c.req.param('code');
  const parsed = voidSchema.safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  try {
    const card = await reactivateGiftCard(c.var.operatorId, code, {
      reason: parsed.data.reason,
      actor: c.var.auth.userId,
    });
    return c.json({ giftCard: serializeGiftCard(card) });
  } catch (err) {
    if (err instanceof GiftCardError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});
