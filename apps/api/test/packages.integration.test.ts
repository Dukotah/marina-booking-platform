/**
 * Packages — live integration test against the seeded LSRA tenant. Proves the
 * service + RLS path: a package built from real seed activity/rate rows is listed
 * in the public catalog and priced with its à-la-carte reference and savings.
 *
 * Skips without DATABASE_URL. Cleans up everything it creates in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import {
  listPublicPackages,
  getPricedPackage,
  PackageError,
} from '../src/services/packages.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';

let activityId = '';
let rateId = '';
let ratePrice = 0;
const createdPackageIds: string[] = [];

describe.skipIf(!HAS_DB)('packages (live, LSRA seed)', () => {
  beforeAll(async () => {
    const rate = await adminPrisma.rate.findFirst({
      where: {
        operator_id: OP,
        is_active: true,
        internal_only: false,
        activity: { status: 'ACTIVE', visible_online: true },
      },
      select: { id: true, activity_id: true, price_cents: true },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No public rate found in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;
    ratePrice = rate.price_cents;
  });

  afterAll(async () => {
    for (const id of createdPackageIds) await adminPrisma.package.deleteMany({ where: { id } });
    await adminPrisma.$disconnect();
  });

  it('lists and prices a package with correct à-la-carte + savings', async () => {
    // Bundle: 2× the rate, priced $10 under à-la-carte.
    const aLaCarte = ratePrice * 2;
    const bundlePrice = aLaCarte - 1000;
    const pkg = await adminPrisma.package.create({
      data: {
        operator_id: OP,
        name_internal: 'itest-pkg',
        name_external: 'Integration Test Bundle',
        price_cents: bundlePrice,
        status: 'ACTIVE',
        visible_online: true,
      },
    });
    createdPackageIds.push(pkg.id);
    await adminPrisma.packageItem.createMany({
      data: [
        { operator_id: OP, package_id: pkg.id, activity_id: activityId, rate_id: rateId, quantity: 2, sort_index: 0 },
      ],
    });

    const priced = await getPricedPackage(OP, pkg.id);
    expect(priced.priceCents).toBe(bundlePrice);
    expect(priced.aLaCarteCents).toBe(aLaCarte);
    expect(priced.savingsCents).toBe(1000);
    expect(priced.items).toHaveLength(1);
    expect(priced.items[0].quantity).toBe(2);

    const catalog = await listPublicPackages(OP);
    expect(catalog.some((p) => p.id === pkg.id)).toBe(true);
  });

  it('hides an inactive package from the public catalog and detail', async () => {
    const pkg = await adminPrisma.package.create({
      data: {
        operator_id: OP,
        name_internal: 'itest-pkg-inactive',
        name_external: 'Hidden Bundle',
        price_cents: 5000,
        status: 'INACTIVE',
        visible_online: true,
      },
    });
    createdPackageIds.push(pkg.id);
    await adminPrisma.packageItem.createMany({
      data: [
        { operator_id: OP, package_id: pkg.id, activity_id: activityId, rate_id: rateId, quantity: 1, sort_index: 0 },
      ],
    });

    const catalog = await listPublicPackages(OP);
    expect(catalog.some((p) => p.id === pkg.id)).toBe(false);
    await expect(getPricedPackage(OP, pkg.id)).rejects.toThrow(PackageError);
  });
});
