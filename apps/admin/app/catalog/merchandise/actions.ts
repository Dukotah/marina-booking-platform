'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getTenantDb, requirePermission } from '../../../lib/session';

/**
 * Server actions for the merchandise catalog — the stuff sold at the register
 * that isn't a booking (fuel, tubes, apparel, snacks…). The MerchandiseItem model
 * + CRUD API already existed and the POS already SELLS these; what was missing was
 * any admin surface to ADD/edit them. Gated on operator:manage, tenant-scoped (RLS)
 * via getTenantDb. Prices/costs are integer cents; the forms take dollars.
 */

const ACTION = 'operator:manage' as const;

const itemSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  category: z.string().trim().max(60).optional().or(z.literal('')),
  variant: z.string().trim().max(60).optional().or(z.literal('')),
  priceDollars: z.coerce.number().min(0).optional(),
  costDollars: z.coerce.number().min(0).optional(),
  onHandQty: z.coerce.number().int().min(0).optional(),
  reorderAlertQty: z.coerce.number().int().min(0).optional(),
});

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function toCents(dollars: number | undefined): number | null {
  if (dollars === undefined || Number.isNaN(dollars)) return null;
  return Math.round(dollars * 100);
}

/** Quick-add a merchandise item. Only name is required; everything else is optional. */
export async function createMerchandiseItem(formData: FormData): Promise<ActionResult> {
  const { operatorId } = await requirePermission(ACTION);
  const parsed = itemSchema.safeParse({
    name: formData.get('name'),
    category: formData.get('category') || undefined,
    variant: formData.get('variant') || undefined,
    priceDollars: formData.get('priceDollars') || undefined,
    costDollars: formData.get('costDollars') || undefined,
    onHandQty: formData.get('onHandQty') || undefined,
    reorderAlertQty: formData.get('reorderAlertQty') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the fields.' };
  }
  const d = parsed.data;
  const db = await getTenantDb();
  await db.merchandiseItem.create({
    data: {
      operator_id: operatorId,
      name: d.name,
      category: d.category || 'Other',
      variant: d.variant || null,
      price_cents: toCents(d.priceDollars),
      cost_cents: toCents(d.costDollars) ?? 0,
      on_hand_qty: d.onHandQty ?? null,
      reorder_alert_qty: d.reorderAlertQty ?? null,
      is_active: true,
    },
  });
  revalidatePath('/catalog/merchandise');
  return { ok: true };
}

/** Edit an existing item. Same optional shape; name still required. */
export async function updateMerchandiseItem(id: string, formData: FormData): Promise<ActionResult> {
  await requirePermission(ACTION);
  const parsed = itemSchema.safeParse({
    name: formData.get('name'),
    category: formData.get('category') || undefined,
    variant: formData.get('variant') || undefined,
    priceDollars: formData.get('priceDollars') || undefined,
    costDollars: formData.get('costDollars') || undefined,
    onHandQty: formData.get('onHandQty') || undefined,
    reorderAlertQty: formData.get('reorderAlertQty') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the fields.' };
  }
  const d = parsed.data;
  const db = await getTenantDb();
  await db.merchandiseItem.updateMany({
    where: { id },
    data: {
      name: d.name,
      category: d.category || 'Other',
      variant: d.variant || null,
      price_cents: toCents(d.priceDollars),
      cost_cents: toCents(d.costDollars) ?? 0,
      on_hand_qty: d.onHandQty ?? null,
      reorder_alert_qty: d.reorderAlertQty ?? null,
    },
  });
  revalidatePath('/catalog/merchandise');
  return { ok: true };
}

/** Show/hide an item at the register without deleting its sales history. */
export async function toggleMerchandiseItem(id: string, isActive: boolean): Promise<ActionResult> {
  await requirePermission(ACTION);
  const db = await getTenantDb();
  await db.merchandiseItem.updateMany({ where: { id }, data: { is_active: isActive } });
  revalidatePath('/catalog/merchandise');
  return { ok: true };
}

/** Permanently remove an item (only when it has no sales lines; otherwise deactivate). */
export async function deleteMerchandiseItem(id: string): Promise<ActionResult> {
  await requirePermission(ACTION);
  const db = await getTenantDb();
  const sold = await db.orderMerchandiseLine.count({ where: { merchandise_id: id } });
  if (sold > 0) {
    // It's been sold — keep the row for reporting integrity and just hide it.
    await db.merchandiseItem.updateMany({ where: { id }, data: { is_active: false } });
    revalidatePath('/catalog/merchandise');
    return { ok: true, error: 'Item has sales history — hidden instead of deleted.' };
  }
  await db.merchandiseItem.deleteMany({ where: { id } });
  revalidatePath('/catalog/merchandise');
  return { ok: true };
}
