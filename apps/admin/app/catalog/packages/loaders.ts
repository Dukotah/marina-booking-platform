import { getTenantDb } from '../../../lib/session';
import { fromCents } from '../../../lib/format';
import type { ActivityOption, PackageFormValues } from './types';

/**
 * Load the activities + their active rates offered in the package item picker.
 * Mirrors the POS catalog query; only ACTIVE activities with live rates qualify.
 */
export async function loadActivityOptions(): Promise<ActivityOption[]> {
  const db = await getTenantDb();
  const activities = await db.activity.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { sort_index: 'asc' },
    select: {
      id: true,
      name_external: true,
      name_internal: true,
      rates: {
        where: { is_active: true },
        orderBy: { sort_index: 'asc' },
        select: { id: true, name_external: true, price_cents: true },
      },
    },
  });
  return activities
    .filter((a) => a.rates.length > 0)
    .map((a) => ({
      id: a.id,
      name: a.name_external || a.name_internal,
      rates: a.rates.map((r) => ({
        id: r.id,
        name: r.name_external,
        priceCents: r.price_cents,
      })),
    }));
}

/** Load one package's current values shaped for the editor. Null when missing. */
export async function loadPackageForm(packageId: string): Promise<PackageFormValues | null> {
  const db = await getTenantDb();
  const pkg = await db.package.findUnique({
    where: { id: packageId },
    select: {
      name_internal: true,
      name_external: true,
      description_html: true,
      price_cents: true,
      status: true,
      visible_online: true,
      sort_index: true,
      items: {
        orderBy: { sort_index: 'asc' },
        select: { activity_id: true, rate_id: true, quantity: true },
      },
    },
  });
  if (!pkg) return null;
  return {
    nameInternal: pkg.name_internal,
    nameExternal: pkg.name_external,
    descriptionHtml: pkg.description_html ?? '',
    priceDollars: String(fromCents(pkg.price_cents)),
    status: pkg.status,
    visibleOnline: pkg.visible_online,
    sortIndex: pkg.sort_index,
    items: pkg.items.map((it) => ({
      activityId: it.activity_id,
      rateId: it.rate_id,
      quantity: it.quantity,
    })),
  };
}
