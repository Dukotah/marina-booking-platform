'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createId } from '@marina/core';
import { getTenantDb, requirePermission } from '../../lib/session';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const createSchema = z.object({
  code: z.string().trim().min(1, 'Code is required').max(64),
  name: z.string().trim().min(1, 'Name is required').max(160),
  discount_type: z.enum(['PERCENT', 'FLAT']).default('PERCENT'),
  discount_value: z.number().nonnegative('Must be ≥ 0'),
  valid_from: z.string().datetime().nullable().optional(),
  valid_until: z.string().datetime().nullable().optional(),
  max_redemptions: z.number().int().positive().nullable().optional(),
});

export type CreatePromoInput = z.infer<typeof createSchema>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error.';
}

export async function createPromo(input: CreatePromoInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return { ok: false, error: first?.message ?? 'Invalid input.' };
    }
    const data = parsed.data;
    const db = await getTenantDb();

    const existing = await db.promoCode.findFirst({
      where: { code: { equals: data.code, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      return { ok: false, error: `Code "${data.code}" already exists.` };
    }

    await db.promoCode.create({
      data: {
        id: createId(),
        operator_id: operatorId,
        code: data.code.toUpperCase().trim(),
        name: data.name,
        type: 'ONE_CODE',
        discount_type: data.discount_type,
        discount_value: data.discount_value,
        is_active: true,
        valid_from: data.valid_from ? new Date(data.valid_from) : null,
        valid_until: data.valid_until ? new Date(data.valid_until) : null,
        max_redemptions: data.max_redemptions ?? null,
        activity_ids: [],
      },
    });

    revalidatePath('/promos');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function togglePromo(id: string, is_active: boolean): Promise<ActionResult> {
  try {
    await requirePermission('operator:manage');
    if (!id) return { ok: false, error: 'Missing promo id.' };
    const db = await getTenantDb();
    const found = await db.promoCode.findFirst({ where: { id }, select: { id: true } });
    if (!found) return { ok: false, error: 'Promo code not found.' };
    await db.promoCode.update({ where: { id }, data: { is_active } });
    revalidatePath('/promos');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deletePromo(id: string): Promise<ActionResult> {
  try {
    await requirePermission('operator:manage');
    if (!id) return { ok: false, error: 'Missing promo id.' };
    const db = await getTenantDb();
    const found = await db.promoCode.findFirst({ where: { id }, select: { id: true } });
    if (!found) return { ok: false, error: 'Promo code not found.' };
    await db.promoCode.delete({ where: { id } });
    revalidatePath('/promos');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
