import { Hono } from 'hono';
import { z } from 'zod';
import { promoValidateSchema, DISCOUNT_TYPES } from '@marina/core';
import { assertPermission } from '@marina/auth';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';

export const promos = new Hono<Env>();

/** Create/update payload for a promo code. Mirrors the Prisma `PromoCode` model. */
const promoInputSchema = z.object({
  code: z.string().trim().min(1, 'A promo code is required').max(64),
  name: z.string().trim().min(1, 'A name is required').max(160),
  type: z.enum(['ONE_CODE', 'PER_CUSTOMER', 'AUTO']).default('ONE_CODE'),
  discount_type: z.enum(DISCOUNT_TYPES).default('PERCENT'),
  discount_value: z.number().nonnegative('discount_value must be >= 0'),
  is_active: z.boolean().default(true),
  /** ISO datetime strings; null/omitted means unbounded. */
  valid_from: z.string().datetime().nullable().optional(),
  valid_until: z.string().datetime().nullable().optional(),
  max_redemptions: z.number().int().positive().nullable().optional(),
  /** Empty array = applies to all activities. */
  activity_ids: z.array(z.string().min(1)).default([]),
});

/** Patch payload — every field optional, but at least one must be present. */
const promoPatchSchema = promoInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

/**
 * POST /api/promos/validate — PUBLIC.
 * Validate a promo code against an (optional) activity. Returns the discount
 * shape on success, or `{ valid: false, reason }` on failure. Scoped to the
 * resolved tenant by RLS via c.var.db; codes are unique per operator.
 */
promos.post('/validate', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = promoValidateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ valid: false, reason: 'Invalid request' } as const, 400);
  }
  const { code, activityId } = parsed.data;

  const promo = await c.var.db.promoCode.findFirst({
    where: { code: { equals: code, mode: 'insensitive' } },
  });

  if (!promo) {
    return c.json({ valid: false, reason: 'Promo code not found' } as const);
  }
  if (!promo.is_active) {
    return c.json({ valid: false, reason: 'This promo code is no longer active' } as const);
  }

  const now = new Date();
  if (promo.valid_from && now < promo.valid_from) {
    return c.json({ valid: false, reason: 'This promo code is not yet valid' } as const);
  }
  if (promo.valid_until && now > promo.valid_until) {
    return c.json({ valid: false, reason: 'This promo code has expired' } as const);
  }
  if (promo.max_redemptions !== null && promo.times_redeemed >= promo.max_redemptions) {
    return c.json({ valid: false, reason: 'This promo code has reached its redemption limit' } as const);
  }

  // Empty activity_ids = applies to every activity. Otherwise the cart's activity
  // must be in the list. If the caller supplied no activityId for a scoped promo,
  // we cannot confirm applicability, so reject.
  if (promo.activity_ids.length > 0) {
    if (!activityId || !promo.activity_ids.includes(activityId)) {
      return c.json(
        { valid: false, reason: 'This promo code does not apply to the selected activity' } as const,
      );
    }
  }

  return c.json({
    valid: true as const,
    name: promo.name,
    discountType: promo.discount_type,
    discountValue: promo.discount_value,
  });
});

/**
 * GET /api/promos — staff list of all promo codes for the tenant.
 */
promos.get('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const rows = await c.var.db.promoCode.findMany({
    orderBy: { code: 'asc' },
  });
  return c.json({ promos: rows });
});

/**
 * POST /api/promos — staff create a promo code.
 */
promos.post('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');

  const body = await c.req.json().catch(() => null);
  const parsed = promoInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const data = parsed.data;

  const created = await c.var.db.promoCode.create({
    data: {
      operator_id: c.var.operatorId,
      code: data.code,
      name: data.name,
      type: data.type,
      discount_type: data.discount_type,
      discount_value: data.discount_value,
      is_active: data.is_active,
      valid_from: data.valid_from ? new Date(data.valid_from) : null,
      valid_until: data.valid_until ? new Date(data.valid_until) : null,
      max_redemptions: data.max_redemptions ?? null,
      activity_ids: data.activity_ids,
    },
  });

  return c.json({ promo: created }, 201);
});

/**
 * PATCH /api/promos/:id — staff update a promo code.
 */
promos.patch('/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'operator:manage');
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = promoPatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }
  const data = parsed.data;

  // Ensure the promo exists within this tenant before updating (RLS-scoped).
  const existing = await c.var.db.promoCode.findFirst({ where: { id } });
  if (!existing) {
    return c.json({ error: 'Promo code not found' }, 404);
  }

  const updated = await c.var.db.promoCode.update({
    where: { id },
    data: {
      ...(data.code !== undefined ? { code: data.code } : {}),
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.type !== undefined ? { type: data.type } : {}),
      ...(data.discount_type !== undefined ? { discount_type: data.discount_type } : {}),
      ...(data.discount_value !== undefined ? { discount_value: data.discount_value } : {}),
      ...(data.is_active !== undefined ? { is_active: data.is_active } : {}),
      ...(data.valid_from !== undefined
        ? { valid_from: data.valid_from ? new Date(data.valid_from) : null }
        : {}),
      ...(data.valid_until !== undefined
        ? { valid_until: data.valid_until ? new Date(data.valid_until) : null }
        : {}),
      ...(data.max_redemptions !== undefined ? { max_redemptions: data.max_redemptions } : {}),
      ...(data.activity_ids !== undefined ? { activity_ids: data.activity_ids } : {}),
    },
  });

  return c.json({ promo: updated });
});
