import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission, canAccessLocation } from '@marina/auth';
import {
  calculatePricing,
  generateOrderNumber,
  type PricingFee,
  type PricingItem,
  type PricingPromo,
} from '@marina/core';
import { withTenant } from '@marina/database';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';

/**
 * Point-of-sale API — the register. Staff record walk-up sales (bookings and/or
 * merchandise) and look up orders, customers, and products at the counter.
 *
 * Every route requires `pos:operate` and is tenant-scoped (RLS). Money is always
 * integer cents. Sales are written atomically inside a single tenant transaction
 * so an Order, its items, inventory decrements, and the Payment never partially
 * commit.
 *
 * Mounted by the orchestrator at /api/pos.
 */
export const pos = new Hono<Env>();

pos.use('*', requireStaff);

// --- /sale ----------------------------------------------------------------

/** A booking line on a walk-up sale (activity + rate + timeslot). */
const bookingLineSchema = z.object({
  kind: z.literal('BOOKING'),
  activityId: z.string().min(1, 'activityId is required'),
  rateId: z.string().min(1, 'rateId is required'),
  timeslotId: z.string().min(1, 'timeslotId is required'),
  quantity: z.number().int().positive().default(1),
  /** Optional override of the rate's price (e.g. a manager discount). */
  unitPriceCentsOverride: z.number().int().nonnegative().optional(),
});

/** A merchandise/retail line on a walk-up sale. */
const merchandiseLineSchema = z.object({
  kind: z.literal('MERCHANDISE'),
  merchandiseId: z.string().min(1, 'merchandiseId is required'),
  quantity: z.number().int().positive().default(1),
  /** Sale price per unit in integer cents — set at the register. */
  unitPriceCents: z.number().int().nonnegative(),
});

/**
 * A package line on a walk-up sale. Sells a Package bundle: each of its items is
 * booked into a caller-supplied timeslot, and the bundle's authoritative
 * price_cents is distributed across the resulting booking lines (largest-remainder)
 * so the order total equals the package price, not the à-la-carte sum.
 */
const packageLineSchema = z.object({
  kind: z.literal('PACKAGE'),
  packageId: z.string().min(1, 'packageId is required'),
  /** One timeslot per package item, in item sort order. */
  timeslotIds: z.array(z.string().min(1)).min(1, 'A timeslot is required for each package item'),
});

const saleLineSchema = z.discriminatedUnion('kind', [
  bookingLineSchema,
  merchandiseLineSchema,
  packageLineSchema,
]);

const saleCustomerSchema = z.object({
  id: z.string().min(1).optional(),
  first_name: z.string().trim().max(80).optional(),
  last_name: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  phone: z.string().trim().max(32).optional(),
});

const saleSchema = z.object({
  customer: saleCustomerSchema.optional(),
  lines: z.array(saleLineSchema).min(1, 'At least one line item is required'),
  payment: z.object({
    method: z.enum(['CARD', 'CASH', 'GIFT_CARD', 'COMP']).default('CASH'),
    /** Amount tendered/charged in integer cents. Defaults to the order total. */
    amountCents: z.number().int().nonnegative().optional(),
    cardLastFour: z.string().trim().regex(/^\d{4}$/, 'cardLastFour must be 4 digits').optional(),
    cardBrand: z.string().trim().max(40).optional(),
    cardholderName: z.string().trim().max(160).optional(),
    isManuallyKeyed: z.boolean().default(false),
  }),
  promoCode: z.string().trim().min(1).max(64).optional(),
  tipCents: z.number().int().nonnegative().default(0),
  taxExempt: z.boolean().default(false),
  heardAboutUs: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
});

/**
 * POST /api/pos/sale — record a walk-up sale.
 *
 * Creates an Order (created_by = STAFF) with its booking OrderItems, decrements
 * merchandise inventory, applies fees/tax/promo via the shared pricing engine,
 * and records the cash/card Payment. Booking timeslot capacity is incremented.
 */
pos.post('/sale', async (c) => {
  assertPermission(c.var.auth, 'pos:operate');

  const body = await c.req.json().catch(() => null);
  const parsed = saleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', issues: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;
  const auth = c.var.auth;
  const operatorId = c.var.operatorId;

  // Pre-validate referenced catalog rows (read through the RLS client) and build
  // the priced cart before opening the write transaction.
  const bookingLines = input.lines.filter((l): l is z.infer<typeof bookingLineSchema> => l.kind === 'BOOKING');
  const merchLines = input.lines.filter((l): l is z.infer<typeof merchandiseLineSchema> => l.kind === 'MERCHANDISE');
  const packageLines = input.lines.filter((l): l is z.infer<typeof packageLineSchema> => l.kind === 'PACKAGE');

  // Resolve operator config for order numbering, fees, and tax-exempt handling.
  const operator = await c.var.db.operator.findUnique({
    where: { id: operatorId },
    select: { location_code: true, timezone: true },
  });
  if (!operator) return c.json({ error: 'Operator not found' }, 404);

  // --- Validate booking lines ---------------------------------------------
  // A resolved booking may originate from a BOOKING line or be synthesized from a
  // PACKAGE line's item, so the line fields are captured explicitly (not tied to
  // the raw bookingLineSchema) to keep the write loop uniform.
  type ResolvedBooking = {
    activityId: string;
    rateId: string;
    timeslotId: string;
    quantity: number;
    activityName: string;
    locationId: string | null;
    unitPriceCents: number;
    /** Set when this booking line came from a PACKAGE bundle (reporting snapshot). */
    packageId?: string;
    packageName?: string;
  };
  const resolvedBookings: ResolvedBooking[] = [];

  for (const line of bookingLines) {
    const rate = await c.var.db.rate.findUnique({
      where: { id: line.rateId },
      include: { activity: { select: { id: true, name_internal: true, location_id: true } } },
    });
    if (!rate || rate.activity_id !== line.activityId) {
      return c.json({ error: `Rate ${line.rateId} not found for activity ${line.activityId}` }, 400);
    }
    if (!rate.is_active) {
      return c.json({ error: `Rate ${line.rateId} is not active` }, 400);
    }
    const timeslot = await c.var.db.timeslot.findUnique({ where: { id: line.timeslotId } });
    if (!timeslot || timeslot.activity_id !== line.activityId) {
      return c.json({ error: `Timeslot ${line.timeslotId} not found for activity ${line.activityId}` }, 400);
    }
    if (timeslot.capacity_booked + line.quantity > timeslot.capacity_total) {
      return c.json(
        { error: `Timeslot ${line.timeslotId} has insufficient capacity` },
        409,
      );
    }
    const locationId = rate.activity.location_id;
    if (locationId && !canAccessLocation(auth, locationId)) {
      return c.json({ error: 'Not permitted to sell at this location' }, 403);
    }
    resolvedBookings.push({
      activityId: line.activityId,
      rateId: line.rateId,
      timeslotId: line.timeslotId,
      quantity: line.quantity,
      activityName: rate.activity.name_internal,
      locationId,
      unitPriceCents: line.unitPriceCentsOverride ?? rate.price_cents,
    });
  }

  // --- Validate package lines ---------------------------------------------
  // Each package expands into one booking per item; the bundle price is spread
  // across those bookings so the order total equals the package price.
  const { distributePrice } = await import('../services/packages.js');
  for (const line of packageLines) {
    const pkg = await c.var.db.package.findFirst({
      where: { id: line.packageId, status: 'ACTIVE' },
      include: {
        items: {
          orderBy: { sort_index: 'asc' },
          include: {
            rate: { select: { id: true, is_active: true, price_cents: true } },
            activity: { select: { id: true, name_internal: true, location_id: true } },
          },
        },
      },
    });
    if (!pkg) return c.json({ error: `Package ${line.packageId} not found` }, 400);
    if (pkg.items.length !== line.timeslotIds.length) {
      return c.json(
        { error: `Package ${line.packageId} has ${pkg.items.length} item(s); provide exactly that many timeslotIds` },
        400,
      );
    }

    // À-la-carte weight per item = rate price * quantity (drives the split).
    const weights = pkg.items.map((it) => it.rate.price_cents * it.quantity);
    const shares = distributePrice(pkg.price_cents, weights);

    for (let idx = 0; idx < pkg.items.length; idx++) {
      const it = pkg.items[idx];
      const timeslotId = line.timeslotIds[idx];
      if (!it.rate.is_active) {
        return c.json({ error: `Package ${line.packageId}: rate ${it.rate_id} is not active` }, 400);
      }
      const timeslot = await c.var.db.timeslot.findUnique({ where: { id: timeslotId } });
      if (!timeslot || timeslot.activity_id !== it.activity_id) {
        return c.json(
          { error: `Timeslot ${timeslotId} not found for package activity ${it.activity_id}` },
          400,
        );
      }
      if (timeslot.capacity_booked + it.quantity > timeslot.capacity_total) {
        return c.json({ error: `Timeslot ${timeslotId} has insufficient capacity` }, 409);
      }
      const locationId = it.activity.location_id;
      if (locationId && !canAccessLocation(auth, locationId)) {
        return c.json({ error: 'Not permitted to sell at this location' }, 403);
      }
      // The distributed share is the LINE total; divide by quantity for unit price
      // (integer — the largest-remainder split already guarantees an exact sum).
      const unit = Math.round(shares[idx] / it.quantity);
      resolvedBookings.push({
        activityId: it.activity_id,
        rateId: it.rate_id,
        timeslotId,
        quantity: it.quantity,
        activityName: it.activity.name_internal,
        locationId,
        unitPriceCents: unit,
        packageId: pkg.id,
        packageName: pkg.name_internal,
      });
    }
  }

  // --- Validate merchandise lines -----------------------------------------
  type ResolvedMerch = {
    line: z.infer<typeof merchandiseLineSchema>;
    name: string;
    category: string;
    variant: string | null;
    onHandQty: number | null;
  };
  const resolvedMerch: ResolvedMerch[] = [];

  for (const line of merchLines) {
    const item = await c.var.db.merchandiseItem.findUnique({ where: { id: line.merchandiseId } });
    if (!item || !item.is_active) {
      return c.json({ error: `Merchandise item ${line.merchandiseId} not found or inactive` }, 400);
    }
    if (item.on_hand_qty !== null && item.on_hand_qty < line.quantity) {
      return c.json({ error: `Insufficient stock for ${item.name}` }, 409);
    }
    resolvedMerch.push({
      line,
      name: item.name,
      category: item.category,
      variant: item.variant,
      onHandQty: item.on_hand_qty,
    });
  }

  // --- Promo ---------------------------------------------------------------
  let pricingPromo: PricingPromo | null = null;
  let promoId: string | null = null;
  if (input.promoCode) {
    const promo = await c.var.db.promoCode.findFirst({
      where: { code: input.promoCode, is_active: true },
    });
    if (!promo) return c.json({ error: 'Invalid or inactive promo code' }, 400);
    const now = new Date();
    if (promo.valid_from && promo.valid_from > now) {
      return c.json({ error: 'Promo code is not yet valid' }, 400);
    }
    if (promo.valid_until && promo.valid_until < now) {
      return c.json({ error: 'Promo code has expired' }, 400);
    }
    if (promo.max_redemptions !== null && promo.times_redeemed >= promo.max_redemptions) {
      return c.json({ error: 'Promo code redemption limit reached' }, 400);
    }
    pricingPromo = { discountType: promo.discount_type, discountValue: promo.discount_value };
    promoId = promo.id;
  }

  // --- Pricing -------------------------------------------------------------
  const items: PricingItem[] = [
    ...resolvedBookings.map((b) => ({ unitPriceCents: b.unitPriceCents, quantity: b.quantity })),
    ...resolvedMerch.map((m) => ({ unitPriceCents: m.line.unitPriceCents, quantity: m.line.quantity })),
  ];

  // Global fees (activity-agnostic) drive tax/processing for the whole sale.
  const feeRows = await c.var.db.fee.findMany({ where: { enabled: true, activity_id: null } });
  const fees: PricingFee[] = feeRows.map((f) => ({ name: f.name, type: f.type, value: f.value }));

  const pricing = calculatePricing({
    items,
    fees,
    promo: pricingPromo,
    tipCents: input.tipCents,
    taxExempt: input.taxExempt,
  });

  // Comps settle the order at $0 tendered; every other method must cover the total.
  if (input.payment.method !== 'COMP') {
    const tendered = input.payment.amountCents ?? pricing.totalCents;
    if (tendered < pricing.totalCents) {
      return c.json(
        { error: 'Payment amount is less than the order total', totalCents: pricing.totalCents },
        400,
      );
    }
  }
  // The order is settled to the full total (comps are recorded as fully paid).
  const amountPaidCents = pricing.totalCents;

  // --- Write atomically ----------------------------------------------------
  try {
    const result = await withTenant(operatorId, async (tx) => {
      // Resolve / create the customer.
      let customerId: string;
      const cust = input.customer;
      if (cust?.id) {
        const found = await tx.customer.findUnique({ where: { id: cust.id } });
        if (!found) throw new SaleError(404, `Customer ${cust.id} not found`);
        customerId = found.id;
      } else if (cust?.email) {
        const existing = await tx.customer.findUnique({
          where: { operator_id_email: { operator_id: operatorId, email: cust.email } },
        });
        if (existing) {
          customerId = existing.id;
        } else {
          const created = await tx.customer.create({
            data: {
              operator_id: operatorId,
              first_name: cust.first_name ?? 'Walk-in',
              last_name: cust.last_name ?? 'Guest',
              email: cust.email,
              phone: cust.phone ?? null,
            },
          });
          customerId = created.id;
        }
      } else {
        // Anonymous walk-up — synthesize a unique guest record for this sale.
        const created = await tx.customer.create({
          data: {
            operator_id: operatorId,
            first_name: cust?.first_name ?? 'Walk-in',
            last_name: cust?.last_name ?? 'Guest',
            email: `walkin+${Date.now()}-${Math.floor(Math.random() * 1e6)}@pos.local`,
            phone: cust?.phone ?? null,
          },
        });
        customerId = created.id;
      }

      // Per-operator, per-day sequence for the human-facing order number. Count
      // orders already numbered for THIS day's prefix rather than orders whose
      // created_at is today: back-dated/seed orders carry a calendar-day order
      // number that differs from their created_at, so counting by created_at drifts
      // out of sync with the encoded date and collides on the order_number unique
      // index. Matches services/booking.ts.
      const now = new Date();
      const numberPrefix = generateOrderNumber(operator.location_code, now, 0).slice(0, -3);
      const todayCount = await tx.order.count({
        where: { order_number: { startsWith: numberPrefix } },
      });
      const orderNumber = generateOrderNumber(operator.location_code, now, todayCount + 1);

      const order = await tx.order.create({
        data: {
          operator_id: operatorId,
          order_number: orderNumber,
          customer_id: customerId,
          status: 'UPCOMING',
          created_by: 'STAFF',
          subtotal_cents: pricing.subtotalCents,
          tax_cents: pricing.taxCents,
          processing_fee_cents: pricing.processingFeeCents,
          tip_cents: pricing.tipCents,
          discount_cents: pricing.discountCents,
          total_cents: pricing.totalCents,
          amount_paid_cents: amountPaidCents,
          balance_due_cents: Math.max(0, pricing.totalCents - amountPaidCents),
          promo_code_id: promoId,
          heard_about_us: input.heardAboutUs ?? null,
        },
      });

      // Booking items + capacity.
      for (const b of resolvedBookings) {
        await tx.orderItem.create({
          data: {
            operator_id: operatorId,
            order_id: order.id,
            activity_id: b.activityId,
            rate_id: b.rateId,
            timeslot_id: b.timeslotId,
            quantity: b.quantity,
            unit_price_cents: b.unitPriceCents,
            status: 'UPCOMING',
            package_id: b.packageId ?? null,
            package_name: b.packageName ?? null,
          },
        });
        // Atomic guarded increment: capacity is re-checked against the CURRENT row
        // inside the transaction, closing the TOCTOU window between the pre-check
        // above and this write. A concurrent sale that filled the slot makes this
        // match 0 rows, rolling the whole sale back instead of overbooking.
        const bumped = await tx.$executeRaw`
          UPDATE "Timeslot"
          SET capacity_booked = capacity_booked + ${b.quantity}
          WHERE id = ${b.timeslotId}
            AND capacity_booked + ${b.quantity} <= capacity_total`;
        if (bumped === 0) {
          throw new SaleError(409, `Timeslot ${b.timeslotId} has insufficient capacity`);
        }
      }

      // Merchandise sale lines (name/category/variant/price snapshots) — what the
      // merchandise + itemized sales reports read — plus inventory decrements
      // (only when stock is tracked). Guarded so concurrent sales can't drive
      // on_hand_qty negative.
      for (const m of resolvedMerch) {
        await tx.orderMerchandiseLine.create({
          data: {
            operator_id: operatorId,
            order_id: order.id,
            merchandise_id: m.line.merchandiseId,
            kind: 'MERCHANDISE',
            name: m.name,
            category: m.category,
            variant: m.variant,
            quantity: m.line.quantity,
            unit_price_cents: m.line.unitPriceCents,
          },
        });
        if (m.onHandQty !== null) {
          const decremented = await tx.$executeRaw`
            UPDATE "MerchandiseItem"
            SET on_hand_qty = on_hand_qty - ${m.line.quantity}
            WHERE id = ${m.line.merchandiseId}
              AND on_hand_qty >= ${m.line.quantity}`;
          if (decremented === 0) {
            throw new SaleError(409, `Insufficient stock for ${m.name}`);
          }
        }
      }

      // Payment.
      const payment = await tx.payment.create({
        data: {
          operator_id: operatorId,
          order_id: order.id,
          method: input.payment.method,
          status: 'PAID',
          amount_cents: amountPaidCents,
          card_last_four: input.payment.cardLastFour ?? null,
          card_brand: input.payment.cardBrand ?? null,
          cardholder_name: input.payment.cardholderName ?? null,
          is_manually_keyed: input.payment.isManuallyKeyed,
        },
      });

      // Promo redemption bookkeeping.
      if (promoId) {
        await tx.promoCode.update({
          where: { id: promoId },
          data: { times_redeemed: { increment: 1 } },
        });
      }

      // Customer rollups.
      await tx.customer.update({
        where: { id: customerId },
        data: {
          lifetime_value_cents: { increment: pricing.totalCents },
          total_bookings: { increment: 1 },
          last_booking_at: now,
        },
      });

      // Audit trail.
      const merchSummary = resolvedMerch.map((m) => `${m.line.quantity}x ${m.name}`).join(', ');
      await tx.orderEvent.create({
        data: {
          operator_id: operatorId,
          order_id: order.id,
          type: 'POS_SALE',
          description: `Walk-up sale recorded at the register${merchSummary ? ` (merchandise: ${merchSummary})` : ''}`,
          actor: auth.userId,
          metadata: {
            method: input.payment.method,
            bookingLines: resolvedBookings.length,
            merchandiseLines: resolvedMerch.length,
            packageLines: packageLines.length,
          },
        },
      });

      if (input.note) {
        await tx.note.create({
          data: {
            operator_id: operatorId,
            order_id: order.id,
            content: input.note,
            author: auth.userId,
          },
        });
      }

      return { order, payment };
    });

    return c.json(
      {
        order: {
          id: result.order.id,
          orderNumber: result.order.order_number,
          status: result.order.status,
          subtotalCents: result.order.subtotal_cents,
          discountCents: result.order.discount_cents,
          taxCents: result.order.tax_cents,
          processingFeeCents: result.order.processing_fee_cents,
          tipCents: result.order.tip_cents,
          totalCents: result.order.total_cents,
          amountPaidCents: result.order.amount_paid_cents,
          balanceDueCents: result.order.balance_due_cents,
        },
        payment: {
          id: result.payment.id,
          method: result.payment.method,
          amountCents: result.payment.amount_cents,
        },
      },
      201,
    );
  } catch (err) {
    if (err instanceof SaleError) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 409);
    }
    throw err;
  }
});

// --- /search --------------------------------------------------------------

/**
 * GET /api/pos/search?q=...&type=orders|customers|products|all
 *
 * Register-counter lookup across orders (by number), customers (name/email/phone),
 * and merchandise products (name/category). Defaults to `all`. Tenant-scoped.
 */
pos.get('/search', async (c) => {
  assertPermission(c.var.auth, 'pos:operate');

  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ error: 'A search query (?q=) is required' }, 400);

  const type = (c.req.query('type') ?? 'all').toLowerCase();
  const wantOrders = type === 'all' || type === 'orders';
  const wantCustomers = type === 'all' || type === 'customers';
  const wantProducts = type === 'all' || type === 'products';
  const take = 20;

  const [orders, customers, products] = await Promise.all([
    wantOrders
      ? c.var.db.order.findMany({
          where: {
            OR: [
              { order_number: { contains: q, mode: 'insensitive' } },
              { customer: { email: { contains: q, mode: 'insensitive' } } },
              { customer: { last_name: { contains: q, mode: 'insensitive' } } },
            ],
          },
          orderBy: { created_at: 'desc' },
          take,
          include: { customer: { select: { first_name: true, last_name: true, email: true } } },
        })
      : Promise.resolve([]),
    wantCustomers
      ? c.var.db.customer.findMany({
          where: {
            OR: [
              { first_name: { contains: q, mode: 'insensitive' } },
              { last_name: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q, mode: 'insensitive' } },
            ],
          },
          orderBy: { last_name: 'asc' },
          take,
        })
      : Promise.resolve([]),
    wantProducts
      ? c.var.db.merchandiseItem.findMany({
          where: {
            is_active: true,
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { category: { contains: q, mode: 'insensitive' } },
            ],
          },
          orderBy: { name: 'asc' },
          take,
        })
      : Promise.resolve([]),
  ]);

  return c.json({
    query: q,
    orders: orders.map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      status: o.status,
      totalCents: o.total_cents,
      balanceDueCents: o.balance_due_cents,
      createdAt: o.created_at,
      customer: o.customer
        ? { name: `${o.customer.first_name} ${o.customer.last_name}`.trim(), email: o.customer.email }
        : null,
    })),
    customers: customers.map((cu) => ({
      id: cu.id,
      name: `${cu.first_name} ${cu.last_name}`.trim(),
      email: cu.email,
      phone: cu.phone,
      totalBookings: cu.total_bookings,
      lifetimeValueCents: cu.lifetime_value_cents,
    })),
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      costCents: p.cost_cents,
      onHandQty: p.on_hand_qty,
    })),
  });
});

/** Internal control-flow error so transaction work can return clean HTTP codes. */
class SaleError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SaleError';
    this.status = status;
  }
}
