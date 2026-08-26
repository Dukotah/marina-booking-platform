/**
 * Packages service — list and price sellable activity/rate bundles.
 *
 * A Package bundles one or more activity+rate lines (PackageItem) at a single
 * authoritative bundle price (`price_cents`). That price need not equal the sum of
 * the individual lines — the discount IS the reason a bundle exists. This service
 * resolves a package's items into a display/pricing shape used by both the customer
 * catalog and the POS register, and computes the implied savings versus buying the
 * lines à la carte.
 *
 * All data access is tenant-scoped by RLS via forOperator(operatorId).
 */

import { forOperator } from '@marina/database';

/** A typed, user-facing failure route handlers map to a clean HTTP status. */
export class PackageError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'PackageError';
    this.code = code;
    this.status = status;
  }
}

export interface PricedPackageItem {
  id: string;
  activityId: string;
  activityName: string;
  rateId: string;
  rateName: string;
  quantity: number;
  /** Unit rate price in cents (à la carte reference). */
  unitPriceCents: number;
  /** unitPriceCents * quantity. */
  lineTotalCents: number;
}

export interface PricedPackage {
  id: string;
  name: string;
  descriptionHtml: string | null;
  /** The authoritative bundle price the customer pays. */
  priceCents: number;
  /** Sum of the à-la-carte line totals (what the items would cost separately). */
  aLaCarteCents: number;
  /** aLaCarteCents - priceCents, floored at 0 (the advertised savings). */
  savingsCents: number;
  items: PricedPackageItem[];
}

/**
 * Compute the à-la-carte total and savings for a set of package items against a
 * bundle price. Pure — unit-testable without a DB.
 */
export function priceItems(
  priceCents: number,
  items: Array<{ unitPriceCents: number; quantity: number }>,
): { aLaCarteCents: number; savingsCents: number } {
  const aLaCarteCents = items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
  const savingsCents = Math.max(0, aLaCarteCents - priceCents);
  return { aLaCarteCents, savingsCents };
}

/**
 * Distribute a bundle price across N line totals proportionally, using the
 * largest-remainder method so the parts sum EXACTLY to priceCents (no rounding
 * drift). Weights are the à-la-carte line totals; when they sum to zero the price
 * is split evenly. Returns one integer-cents amount per input weight.
 */
export function distributePrice(priceCents: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const weightSum = weights.reduce((s, w) => s + w, 0);
  // Even split fallback when weights are all zero.
  const raw = weights.map((w) =>
    weightSum > 0 ? (priceCents * w) / weightSum : priceCents / n,
  );
  const floored = raw.map((r) => Math.floor(r));
  let remainder = priceCents - floored.reduce((s, f) => s + f, 0);
  // Hand out the leftover cents to the lines with the largest fractional parts.
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floored];
  for (let k = 0; k < order.length && remainder > 0; k++) {
    out[order[k].i] += 1;
    remainder -= 1;
  }
  return out;
}

type PackageRow = {
  id: string;
  name_external: string;
  description_html: string | null;
  price_cents: number;
  items: Array<{
    id: string;
    activity_id: string;
    rate_id: string;
    quantity: number;
    activity: { name_external: string };
    rate: { name_external: string; price_cents: number };
  }>;
};

/** Shape a raw package row (with items + activity/rate names) into a PricedPackage. */
export function toPricedPackage(row: PackageRow): PricedPackage {
  const items: PricedPackageItem[] = row.items.map((it) => ({
    id: it.id,
    activityId: it.activity_id,
    activityName: it.activity.name_external,
    rateId: it.rate_id,
    rateName: it.rate.name_external,
    quantity: it.quantity,
    unitPriceCents: it.rate.price_cents,
    lineTotalCents: it.rate.price_cents * it.quantity,
  }));
  const { aLaCarteCents, savingsCents } = priceItems(
    row.price_cents,
    items.map((i) => ({ unitPriceCents: i.unitPriceCents, quantity: i.quantity })),
  );
  return {
    id: row.id,
    name: row.name_external,
    descriptionHtml: row.description_html,
    priceCents: row.price_cents,
    aLaCarteCents,
    savingsCents,
    items,
  };
}

const ITEM_INCLUDE = {
  items: {
    orderBy: { sort_index: 'asc' as const },
    include: {
      activity: { select: { name_external: true } },
      rate: { select: { name_external: true, price_cents: true } },
    },
  },
};

/**
 * List active, online-visible packages for the customer catalog, each priced with
 * its à-la-carte reference and savings.
 */
export async function listPublicPackages(operatorId: string): Promise<PricedPackage[]> {
  const db = forOperator(operatorId);
  const rows = await db.package.findMany({
    where: { status: 'ACTIVE', visible_online: true },
    orderBy: { sort_index: 'asc' },
    include: ITEM_INCLUDE,
  });
  return rows.map((r) => toPricedPackage(r as unknown as PackageRow));
}

/** Price a single package by id (must be ACTIVE). Throws PackageError if missing. */
export async function getPricedPackage(
  operatorId: string,
  packageId: string,
): Promise<PricedPackage> {
  const db = forOperator(operatorId);
  const row = await db.package.findFirst({
    where: { id: packageId, status: 'ACTIVE' },
    include: ITEM_INCLUDE,
  });
  if (!row) throw new PackageError('NOT_FOUND', 'Package not found.', 404);
  return toPricedPackage(row as unknown as PackageRow);
}
