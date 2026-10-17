'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { withTenant } from '@marina/database';
import { getTenantDb, requirePermission } from '../../../lib/session';
import { toCents } from '../../../lib/format';
import type { PackageActionResult } from './types';

const itemSchema = z.object({
  activityId: z.string().min(1, 'Pick an activity'),
  rateId: z.string().min(1, 'Pick a rate'),
  quantity: z.coerce.number().int().positive('Quantity must be at least 1'),
});

const formSchema = z.object({
  nameInternal: z.string().trim().min(1, 'Internal name is required').max(160),
  nameExternal: z.string().trim().min(1, 'Customer-facing name is required').max(160),
  descriptionHtml: z.string().trim().max(10_000).optional().default(''),
  priceDollars: z.coerce.number().positive('Package price must be greater than zero'),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  visibleOnline: z.boolean().default(true),
  sortIndex: z.coerce.number().int().nonnegative().default(0),
  items: z.array(itemSchema).min(1, 'A package needs at least one item'),
});

/**
 * Raw form payload the client builder sends. Numeric fields arrive as the strings
 * the inputs hold; the schema's `z.coerce` converts them. Declared explicitly so
 * the client's string-typed state is assignable.
 */
export interface PackageInput {
  nameInternal: string;
  nameExternal: string;
  descriptionHtml?: string;
  priceDollars: string | number;
  status?: 'ACTIVE' | 'INACTIVE';
  visibleOnline?: boolean;
  sortIndex?: string | number;
  items: Array<{ activityId: string; rateId: string; quantity: string | number }>;
}

/** Confirm each item's rate truly belongs to its activity (defense in depth vs RLS). */
async function validateItems(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  items: Array<{ activityId: string; rateId: string }>,
): Promise<string | null> {
  for (const item of items) {
    const rate = await db.rate.findUnique({ where: { id: item.rateId } });
    if (!rate || rate.activity_id !== item.activityId) {
      return `A selected rate does not belong to its activity.`;
    }
  }
  return null;
}

export async function createPackage(input: PackageInput): Promise<PackageActionResult> {
  const { operatorId } = await requirePermission('activity:write');
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const data = parsed.data;
  const db = await getTenantDb();

  const itemError = await validateItems(db, data.items);
  if (itemError) return { ok: false, error: itemError };

  // Parent + items share operator_id across composite FKs, so create the parent
  // then the lines flatly inside one tenant transaction (same as the API route).
  const pkg = await withTenant(operatorId, async (tx) => {
    const created = await tx.package.create({
      data: {
        operator_id: operatorId,
        name_internal: data.nameInternal,
        name_external: data.nameExternal,
        description_html: data.descriptionHtml ? data.descriptionHtml : null,
        price_cents: toCents(data.priceDollars),
        status: data.status,
        visible_online: data.visibleOnline,
        sort_index: data.sortIndex,
      },
    });
    await tx.packageItem.createMany({
      data: data.items.map((it, i) => ({
        operator_id: operatorId,
        package_id: created.id,
        activity_id: it.activityId,
        rate_id: it.rateId,
        quantity: it.quantity,
        sort_index: i,
      })),
    });
    return created;
  });

  revalidatePath('/catalog/packages');
  return { ok: true, packageId: pkg.id };
}

export async function updatePackage(
  packageId: string,
  input: PackageInput,
): Promise<PackageActionResult> {
  const { operatorId } = await requirePermission('activity:write');
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const data = parsed.data;
  const db = await getTenantDb();

  const existing = await db.package.findUnique({ where: { id: packageId } });
  if (!existing) return { ok: false, error: 'Package not found.' };

  const itemError = await validateItems(db, data.items);
  if (itemError) return { ok: false, error: itemError };

  // Replace the item set wholesale (delete-then-recreate) — the editor always
  // submits the full line-up, so a full swap is simpler than a diff.
  await withTenant(operatorId, async (tx) => {
    await tx.package.update({
      where: { id: packageId },
      data: {
        name_internal: data.nameInternal,
        name_external: data.nameExternal,
        description_html: data.descriptionHtml ? data.descriptionHtml : null,
        price_cents: toCents(data.priceDollars),
        status: data.status,
        visible_online: data.visibleOnline,
        sort_index: data.sortIndex,
      },
    });
    await tx.packageItem.deleteMany({ where: { package_id: packageId } });
    await tx.packageItem.createMany({
      data: data.items.map((it, i) => ({
        operator_id: operatorId,
        package_id: packageId,
        activity_id: it.activityId,
        rate_id: it.rateId,
        quantity: it.quantity,
        sort_index: i,
      })),
    });
  });

  revalidatePath('/catalog/packages');
  revalidatePath(`/catalog/packages/${packageId}`);
  return { ok: true, packageId };
}

export async function deletePackage(packageId: string): Promise<void> {
  await requirePermission('activity:write');
  const db = await getTenantDb();
  // PackageItem cascades on the package relation.
  await db.package.deleteMany({ where: { id: packageId } });
  revalidatePath('/catalog/packages');
}
