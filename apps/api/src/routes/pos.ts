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
import { isEmailConfigured, sendBookingConfirmation } from '../services/notifications.js';
import { getResourceConstraint } from '../services/resource-availability.js';

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

const saleLineSchema = z.discriminatedUnion('kind', [bookingLineSchema, merchandiseLineSchema]);

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

  // Resolve operator config for order numbering, fees, and tax-exempt handling.
  const operator = await c.var.db.operator.findUnique({
    where: { id: operatorId },
    select: { location_code: true, timezone: true },
  });
  if (!operator) return c.json({ error: 'Operator not found' }, 404);

  // --- Validate booking lines ---------------------------------------------
  type ResolvedBooking = {
    line: z.infer<typeof bookingLineSchema>;
    activityName: string;
    locationId: string | null;
    unitPriceCents: number;
    /** Asset-occupancy window for shared-resource contention (D-024). */
    slotDatetime: Date;
    durationMinutes: number;
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
      line,
      activityName: rate.activity.name_internal,
      locationId,
      unitPriceCents: line.unitPriceCentsOverride ?? rate.price_cents,
      slotDatetime: timeslot.datetime,
      durationMinutes: rate.duration_minutes,
    });
  }

  // --- Validate merchandise lines -----------------------------------------
  type ResolvedMerch = {
    line: z.infer<typeof merchandiseLineSchema>;
    name: string;
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
    resolvedMerch.push({ line, name: item.name, onHandQty: item.on_hand_qty });
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
    ...resolvedBookings.map((b) => ({ unitPriceCents: b.unitPriceCents, quantity: b.line.quantity })),
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

      // Per-operator, per-day sequence for the human-facing order number.
      const now = new Date();
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
      const todayCount = await tx.order.count({
        where: { created_at: { gte: dayStart, lt: dayEnd } },
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

      // Booking items + capacity. The shared-resource check runs in-transaction so
      // multiple lines in ONE sale that draw on the same asset accumulate correctly
      // (each line sees the items the prior lines just created). D-024.
      for (const b of resolvedBookings) {
        const resource = await getResourceConstraint(tx, {
          activityId: b.line.activityId,
          slotStart: b.slotDatetime,
          durationMs: b.durationMinutes * 60_000,
        });
        if (resource.remaining !== null && b.line.quantity > resource.remaining) {
          const what = resource.bindingResourceName ?? 'the required resource';
          throw new SaleError(
            409,
            resource.remaining <= 0
              ? `${what} is fully committed at this time`
              : `Only ${resource.remaining} ${what} spot(s) remain at this time`,
          );
        }
        await tx.orderItem.create({
          data: {
            operator_id: operatorId,
            order_id: order.id,
            activity_id: b.line.activityId,
            rate_id: b.line.rateId,
            timeslot_id: b.line.timeslotId,
            quantity: b.line.quantity,
            unit_price_cents: b.unitPriceCents,
            status: 'UPCOMING',
          },
        });
        await tx.timeslot.update({
          where: { id: b.line.timeslotId },
          data: { capacity_booked: { increment: b.line.quantity } },
        });
      }

      // Merchandise inventory decrements (only when stock is tracked).
      for (const m of resolvedMerch) {
        if (m.onHandQty !== null) {
          await tx.merchandiseItem.update({
            where: { id: m.line.merchandiseId },
            data: { on_hand_qty: { decrement: m.line.quantity } },
          });
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

    // Email the customer their booking confirmation — fire-and-forget, never blocks
    // or fails the sale. Only for a real customer email (anonymous/synthetic walk-in
    // guests have no deliverable address) that actually booked something (a
    // merchandise-only sale isn't a booking). No-op without a Resend key. We don't
    // send the staff-new-booking alert here: a POS sale is made BY staff at the
    // counter, so alerting them about their own sale would be noise.
    if (isEmailConfigured() && input.customer?.email && resolvedBookings.length > 0) {
      void sendBookingConfirmation({ operatorId, orderId: result.order.id });
    }

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
