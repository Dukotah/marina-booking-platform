/**
 * Reports overhaul — live integration tests against the seeded LSRA tenant.
 *
 * Proves the reporting trust chain end to end, against a real database and the
 * real POS route:
 *   1. POST /api/pos/sale persists merchandise/misc lines as first-class
 *      OrderMerchandiseLine rows (name/category/variant/price snapshots), and
 *      package lines stamp package_id/package_name on their booking items with
 *      the bundle price distributed exactly.
 *   2. RECONCILIATION: feeding the persisted rows through the same pure
 *      builders the admin Reports page uses (@marina/core buildItemizedSales /
 *      buildMerchandiseReport) reconciles to the cent — activities + packages
 *      + merchandise + charges + tax + fees + tips = gross. No trust, proof.
 *
 * SKIPS when DATABASE_URL is unset. Creates its own disposable merchandise,
 * package, timeslots, and orders, and deletes everything in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import {
  buildItemizedSales,
  buildMerchandiseReport,
  type ItemizedInput,
} from '@marina/core';
import { app } from '../src/app.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';
const SLUG = 'lake-sonoma';

const staffJsonHeaders = {
  'x-operator-slug': SLUG,
  'x-dev-staff-id': 'dev-owner',
  'content-type': 'application/json',
};

let activityId = '';
let rateId = '';
let ratePriceCents = 0;

let fuelFullId = '';
let fuelQuarterId = '';
let stickerId = '';
let packageId = '';
let createdStaff = false;

const createdOrderIds: string[] = [];
const createdTimeslotIds: string[] = [];

async function makeSlot(): Promise<string> {
  const slot = await adminPrisma.timeslot.create({
    data: {
      operator_id: OP,
      activity_id: activityId,
      datetime: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
      capacity_total: 40,
      capacity_booked: 0,
      status: 'AVAILABLE',
    },
    select: { id: true },
  });
  createdTimeslotIds.push(slot.id);
  return slot.id;
}

/**
 * Load the persisted rows for a set of orders in the exact projection the
 * admin data layer feeds the pure builders (order-date basis).
 */
async function loadItemizedInput(orderIds: string[]): Promise<ItemizedInput> {
  const [orders, items, merchLines, charges] = await Promise.all([
    adminPrisma.order.findMany({
      where: { operator_id: OP, id: { in: orderIds } },
      select: {
        id: true,
        order_number: true,
        created_at: true,
        subtotal_cents: true,
        discount_cents: true,
        tax_cents: true,
        processing_fee_cents: true,
        tip_cents: true,
        total_cents: true,
      },
    }),
    adminPrisma.orderItem.findMany({
      where: { operator_id: OP, order_id: { in: orderIds } },
      select: {
        order_id: true,
        quantity: true,
        unit_price_cents: true,
        add_on_id: true,
        add_on_name: true,
        package_id: true,
        package_name: true,
        activity: { select: { id: true, name_external: true } },
        rate: { select: { name_external: true } },
      },
    }),
    adminPrisma.orderMerchandiseLine.findMany({
      where: { operator_id: OP, order_id: { in: orderIds } },
      select: {
        order_id: true,
        kind: true,
        name: true,
        category: true,
        variant: true,
        quantity: true,
        unit_price_cents: true,
      },
    }),
    adminPrisma.orderCharge.findMany({
      where: { operator_id: OP, order_id: { in: orderIds } },
      select: { order_id: true, category: true, label: true, amount_cents: true },
    }),
  ]);

  return {
    orders: orders.map((o) => ({
      id: o.id,
      order_number: o.order_number,
      date: o.created_at.toISOString().slice(0, 10),
      subtotal_cents: o.subtotal_cents,
      discount_cents: o.discount_cents,
      tax_cents: o.tax_cents,
      processing_fee_cents: o.processing_fee_cents,
      tip_cents: o.tip_cents,
      total_cents: o.total_cents,
    })),
    activityLines: items.map((it) => ({
      order_id: it.order_id,
      activity_id: it.activity.id,
      activity_name: it.activity.name_external,
      rate_name: it.rate.name_external,
      quantity: it.quantity,
      unit_price_cents: it.unit_price_cents,
      add_on_id: it.add_on_id,
      add_on_name: it.add_on_name,
      package_id: it.package_id,
      package_name: it.package_name,
    })),
    merchLines,
    charges,
  };
}

describe.skipIf(!HAS_DB)('reports reconciliation (live POS sales vs LSRA seed)', () => {
  beforeAll(async () => {
    // Dev-staff shim row (same convention as the gift-card route tests).
    const existingStaff = await adminPrisma.staffMember.findFirst({
      where: { operator_id: OP, auth_user_id: 'dev-owner' },
      select: { id: true },
    });
    if (!existingStaff) {
      await adminPrisma.staffMember.create({
        data: {
          operator_id: OP,
          auth_user_id: 'dev-owner',
          name: 'Dev Owner',
          email: 'dev-owner@example.com',
          role: 'OWNER',
          is_active: true,
        },
      });
      createdStaff = true;
    }

    const rate = await adminPrisma.rate.findFirst({
      where: { operator_id: OP, is_active: true, activity: { status: 'ACTIVE' } },
      select: { id: true, price_cents: true, activity_id: true },
      orderBy: { price_cents: 'asc' },
    });
    if (!rate) throw new Error('No active rate in the LSRA seed — run `pnpm db:seed`.');
    activityId = rate.activity_id;
    rateId = rate.id;
    ratePriceCents = rate.price_cents;

    // Disposable merch catalog: a variant pair (fuel) + a flat item.
    const [fuelFull, fuelQuarter, sticker] = await Promise.all([
      adminPrisma.merchandiseItem.create({
        data: {
          operator_id: OP,
          name: 'ITest Fuel',
          category: 'Fuel',
          variant: 'Full gallon',
          cost_cents: 2400,
          on_hand_qty: 500,
        },
        select: { id: true },
      }),
      adminPrisma.merchandiseItem.create({
        data: {
          operator_id: OP,
          name: 'ITest Fuel',
          category: 'Fuel',
          variant: '1/4 gallon',
          cost_cents: 600,
          on_hand_qty: 500,
        },
        select: { id: true },
      }),
      adminPrisma.merchandiseItem.create({
        data: {
          operator_id: OP,
          name: 'ITest Sticker',
          category: 'Apparel',
          cost_cents: 500,
          on_hand_qty: 100,
        },
        select: { id: true },
      }),
    ]);
    fuelFullId = fuelFull.id;
    fuelQuarterId = fuelQuarter.id;
    stickerId = sticker.id;

    // A two-line package on the fixture activity (bundle price ≠ à la carte).
    // Created in two steps (unchecked scalar FKs) — the tenant-composite FKs
    // make Prisma reject nested creates that also set operator_id.
    const pkg = await adminPrisma.package.create({
      data: {
        operator_id: OP,
        name_internal: 'ITest Bundle',
        name_external: 'ITest Bundle',
        price_cents: Math.max(1000, ratePriceCents * 2 - 500),
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    packageId = pkg.id;
    await adminPrisma.packageItem.createMany({
      data: [
        { operator_id: OP, package_id: packageId, activity_id: activityId, rate_id: rateId, quantity: 1, sort_index: 0 },
        { operator_id: OP, package_id: packageId, activity_id: activityId, rate_id: rateId, quantity: 1, sort_index: 1 },
      ],
    });
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await adminPrisma.order.deleteMany({ where: { id } });
    for (const id of createdTimeslotIds) await adminPrisma.timeslot.deleteMany({ where: { id } });
    await adminPrisma.package.deleteMany({ where: { operator_id: OP, id: packageId } });
    await adminPrisma.merchandiseItem.deleteMany({
      where: { operator_id: OP, id: { in: [fuelFullId, fuelQuarterId, stickerId] } },
    });
    if (createdStaff) {
      await adminPrisma.staffMember.deleteMany({
        where: { operator_id: OP, auth_user_id: 'dev-owner' },
      });
    }
    await adminPrisma.$disconnect();
  });

  it('persists merchandise sale lines with snapshots via POST /api/pos/sale', async () => {
    const timeslotId = await makeSlot();
    const res = await app.request('/api/pos/sale', {
      method: 'POST',
      headers: staffJsonHeaders,
      body: JSON.stringify({
        lines: [
          { kind: 'BOOKING', activityId, rateId, timeslotId, quantity: 2 },
          { kind: 'MERCHANDISE', merchandiseId: fuelFullId, quantity: 3, unitPriceCents: 2400 },
          { kind: 'MERCHANDISE', merchandiseId: fuelQuarterId, quantity: 2, unitPriceCents: 600 },
          { kind: 'MERCHANDISE', merchandiseId: stickerId, quantity: 1, unitPriceCents: 500 },
        ],
        payment: { method: 'CASH' },
        tipCents: 700,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { order: { id: string; subtotalCents: number } };
    createdOrderIds.push(body.order.id);

    // Subtotal covers booking + merch lines.
    expect(body.order.subtotalCents).toBe(2 * ratePriceCents + 3 * 2400 + 2 * 600 + 500);

    const lines = await adminPrisma.orderMerchandiseLine.findMany({
      where: { operator_id: OP, order_id: body.order.id },
      orderBy: { unit_price_cents: 'desc' },
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      kind: 'MERCHANDISE',
      name: 'ITest Fuel',
      category: 'Fuel',
      variant: 'Full gallon',
      quantity: 3,
      unit_price_cents: 2400,
      merchandise_id: fuelFullId,
    });
    expect(lines.map((l) => l.variant).sort()).toEqual(['1/4 gallon', 'Full gallon', null].sort());
  });

  it('stamps package attribution and distributes the bundle price exactly', async () => {
    const [slotA, slotB] = [await makeSlot(), await makeSlot()];
    const res = await app.request('/api/pos/sale', {
      method: 'POST',
      headers: staffJsonHeaders,
      body: JSON.stringify({
        lines: [{ kind: 'PACKAGE', packageId, timeslotIds: [slotA, slotB] }],
        payment: { method: 'CARD', cardLastFour: '4242' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { order: { id: string } };
    createdOrderIds.push(body.order.id);

    const items = await adminPrisma.orderItem.findMany({
      where: { operator_id: OP, order_id: body.order.id },
      select: { package_id: true, package_name: true, unit_price_cents: true, quantity: true },
    });
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.package_id).toBe(packageId);
      expect(it.package_name).toBe('ITest Bundle');
    }
    // The distributed line values sum EXACTLY to the bundle price.
    const pkg = await adminPrisma.package.findUniqueOrThrow({
      where: { id: packageId },
      select: { price_cents: true },
    });
    const lineSum = items.reduce((s, it) => s + it.unit_price_cents * it.quantity, 0);
    expect(lineSum).toBe(pkg.price_cents);
  });

  it('RECONCILES: itemized builders cover every cent of the live orders (incl. charges)', async () => {
    // Add a post-trip fuel charge to the first order, exactly like the admin
    // "add charge" action does (charge row + total/balance bump).
    const orderId = createdOrderIds[0]!;
    const order = await adminPrisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { total_cents: true, balance_due_cents: true },
    });
    await adminPrisma.orderCharge.create({
      data: {
        operator_id: OP,
        order_id: orderId,
        category: 'FUEL',
        label: 'Fuel — half tank',
        amount_cents: 3150,
      },
    });
    await adminPrisma.order.update({
      where: { id: orderId },
      data: {
        total_cents: order.total_cents + 3150,
        balance_due_cents: order.balance_due_cents + 3150,
      },
    });

    const input = await loadItemizedInput(createdOrderIds);
    const itemized = buildItemizedSales(input);

    // The trust feature: every check passes against REAL persisted data.
    expect(itemized.reconciliation.checks.map((c) => `${c.name}: ${c.ok}`)).toEqual(
      itemized.reconciliation.checks.map((c) => `${c.name}: true`),
    );
    expect(itemized.reconciliation.ok).toBe(true);

    // Grand total equals stored gross to the cent.
    const gross = input.orders.reduce((s, o) => s + o.total_cents, 0);
    expect(itemized.grandTotalCents).toBe(gross);

    // Groups: activities (seat line), packages (bundle lines), merchandise
    // (fuel + sticker), charges (the fuel top-up).
    const keys = itemized.groups.map((g) => g.key);
    expect(keys).toContain('activity');
    expect(keys).toContain('packages');
    expect(keys).toContain('merchandise');
    expect(keys).toContain('charges');

    // Merchandise report: fuel variants roll up under one parent product.
    const merch = buildMerchandiseReport(input);
    const fuelCat = merch.categories.find((c) => c.category === 'Fuel');
    const fuelProduct = fuelCat?.products.find((p) => p.name === 'ITest Fuel');
    expect(fuelProduct?.hasVariants).toBe(true);
    expect(fuelProduct?.variants.map((v) => v.variant).sort()).toEqual([
      '1/4 gallon',
      'Full gallon',
    ]);
    expect(fuelProduct?.quantity).toBe(5);
    expect(fuelProduct?.grossCents).toBe(3 * 2400 + 2 * 600);
  });
});
