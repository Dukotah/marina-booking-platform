import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import { customerInputSchema } from '@marina/core';
import type { Prisma } from '@marina/database';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';

/**
 * Customers CRM API. All endpoints require an authenticated staff member and the
 * relevant `customer:*` permission. Every query runs through the tenant-scoped
 * `c.var.db`, so RLS guarantees an operator can only ever see/touch its own
 * customers; we still write explicit where-clauses for correctness and clarity.
 *
 * Money is integer cents throughout (`lifetime_value_cents`).
 */
export const customers = new Hono<Env>();

// --- helpers --------------------------------------------------------------

/** Parse 1-based page / page-size query params with sane bounds. */
function parsePagination(c: { req: { query(name: string): string | undefined } }): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const rawPage = Number.parseInt(c.req.query('page') ?? '1', 10);
  const rawPageSize = Number.parseInt(c.req.query('pageSize') ?? '25', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize =
    Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(rawPageSize, 100) : 25;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** Shape a Customer row for API responses (camelCase, explicit fields). */
function serializeCustomer(c: {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  tags: string[];
  notes: string | null;
  lifetime_value_cents: number;
  total_bookings: number;
  last_booking_at: Date | null;
  waiver_on_file: boolean;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: c.id,
    firstName: c.first_name,
    lastName: c.last_name,
    email: c.email,
    phone: c.phone,
    address: c.address,
    city: c.city,
    state: c.state,
    zip: c.zip,
    tags: c.tags,
    notes: c.notes,
    lifetimeValueCents: c.lifetime_value_cents,
    totalBookings: c.total_bookings,
    lastBookingAt: c.last_booking_at,
    waiverOnFile: c.waiver_on_file,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

/** Patch payload: editable contact fields plus CRM tags/notes. All optional. */
const customerUpdateSchema = z
  .object({
    first_name: z.string().trim().min(1).max(80).optional(),
    last_name: z.string().trim().min(1).max(80).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    address: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(64).nullable().optional(),
    zip: z.string().trim().max(16).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(48)).max(50).optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

/**
 * Recompute total_bookings / lifetime_value_cents / last_booking_at for a single
 * customer from its non-cancelled orders, and return the fresh aggregate. This
 * keeps the denormalized CRM counters honest after order changes.
 *
 * Lifetime value = sum of paid amounts on orders that weren't cancelled.
 * Total bookings = count of those orders. Both are tenant-scoped via `db`.
 */
async function recomputeCustomerStats(
  db: Env['Variables']['db'],
  customerId: string,
): Promise<{ totalBookings: number; lifetimeValueCents: number; lastBookingAt: Date | null }> {
  const orderWhere: Prisma.OrderWhereInput = {
    customer_id: customerId,
    status: { not: 'CANCELLED' },
  };

  const [agg, latest] = await Promise.all([
    db.order.aggregate({
      where: orderWhere,
      _count: { _all: true },
      _sum: { amount_paid_cents: true },
    }),
    db.order.findFirst({
      where: orderWhere,
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    }),
  ]);

  const totalBookings = agg._count._all;
  const lifetimeValueCents = agg._sum.amount_paid_cents ?? 0;
  const lastBookingAt = latest?.created_at ?? null;

  await db.customer.update({
    where: { id: customerId },
    data: {
      total_bookings: totalBookings,
      lifetime_value_cents: lifetimeValueCents,
      last_booking_at: lastBookingAt,
    },
  });

  return { totalBookings, lifetimeValueCents, lastBookingAt };
}

// --- routes ---------------------------------------------------------------

/**
 * GET / — list/search customers. Free-text `q` matches across first name, last
 * name, email, and phone (case-insensitive). Paginated via `page` / `pageSize`.
 * Optional `tag` filter narrows to customers carrying a given tag.
 */
customers.get('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'customer:read');

  const q = c.req.query('q')?.trim();
  const tag = c.req.query('tag')?.trim();
  const { page, pageSize, skip, take } = parsePagination(c);

  const where: Prisma.CustomerWhereInput = {};
  if (q) {
    where.OR = [
      { first_name: { contains: q, mode: 'insensitive' } },
      { last_name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (tag) {
    where.tags = { has: tag };
  }

  const [total, rows] = await Promise.all([
    c.var.db.customer.count({ where }),
    c.var.db.customer.findMany({
      where,
      orderBy: [{ last_booking_at: { sort: 'desc', nulls: 'last' } }, { created_at: 'desc' }],
      skip,
      take,
    }),
  ]);

  return c.json({
    customers: rows.map(serializeCustomer),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  });
});

/**
 * GET /:id — a single customer with recent order history and lifetime value.
 * Stats are recomputed on read so the returned lifetime value / booking count
 * reflect the current state of the customer's orders.
 */
customers.get('/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'customer:read');
  const id = c.req.param('id');

  const customer = await c.var.db.customer.findFirst({ where: { id } });
  if (!customer) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  const [stats, orders] = await Promise.all([
    recomputeCustomerStats(c.var.db, id),
    c.var.db.order.findMany({
      where: { customer_id: id },
      orderBy: { created_at: 'desc' },
      take: 50,
      include: {
        items: {
          include: {
            activity: { select: { id: true, name_external: true, category: true } },
            timeslot: { select: { id: true, datetime: true } },
          },
        },
      },
    }),
  ]);

  return c.json({
    customer: {
      ...serializeCustomer(customer),
      // Reflect freshly recomputed aggregates over the read-time snapshot.
      totalBookings: stats.totalBookings,
      lifetimeValueCents: stats.lifetimeValueCents,
      lastBookingAt: stats.lastBookingAt,
    },
    orders: orders.map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      status: o.status,
      createdBy: o.created_by,
      subtotalCents: o.subtotal_cents,
      taxCents: o.tax_cents,
      processingFeeCents: o.processing_fee_cents,
      tipCents: o.tip_cents,
      discountCents: o.discount_cents,
      totalCents: o.total_cents,
      amountPaidCents: o.amount_paid_cents,
      balanceDueCents: o.balance_due_cents,
      createdAt: o.created_at,
      items: o.items.map((it) => ({
        id: it.id,
        quantity: it.quantity,
        unitPriceCents: it.unit_price_cents,
        status: it.status,
        activity: it.activity
          ? {
              id: it.activity.id,
              name: it.activity.name_external,
              category: it.activity.category,
            }
          : null,
        timeslot: it.timeslot ? { id: it.timeslot.id, datetime: it.timeslot.datetime } : null,
      })),
    })),
  });
});

/**
 * POST / — create a customer. Validates with the shared `customerInputSchema`.
 * Enforces the per-operator unique email constraint with a friendly 409 instead
 * of a raw DB error.
 */
customers.post('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'customer:write');

  const body = await c.req.json().catch(() => null);
  const parsed = customerInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const existing = await c.var.db.customer.findFirst({
    where: { email: input.email },
    select: { id: true },
  });
  if (existing) {
    return c.json({ error: 'A customer with this email already exists', customerId: existing.id }, 409);
  }

  const created = await c.var.db.customer.create({
    data: {
      operator_id: c.var.operatorId,
      first_name: input.first_name,
      last_name: input.last_name,
      email: input.email,
      phone: input.phone ?? null,
      address: input.address ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      zip: input.zip ?? null,
    },
  });

  return c.json({ customer: serializeCustomer(created) }, 201);
});

/**
 * PATCH /:id — update contact details and/or CRM fields (tags, notes). Only the
 * provided fields are changed. Email changes are checked against the per-operator
 * unique constraint.
 */
customers.patch('/:id', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'customer:write');
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = customerUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const existing = await c.var.db.customer.findFirst({ where: { id }, select: { id: true } });
  if (!existing) {
    return c.json({ error: 'Customer not found' }, 404);
  }

  if (input.email) {
    const emailOwner = await c.var.db.customer.findFirst({
      where: { email: input.email, id: { not: id } },
      select: { id: true },
    });
    if (emailOwner) {
      return c.json({ error: 'A customer with this email already exists', customerId: emailOwner.id }, 409);
    }
  }

  const data: Prisma.CustomerUpdateInput = {};
  if (input.first_name !== undefined) data.first_name = input.first_name;
  if (input.last_name !== undefined) data.last_name = input.last_name;
  if (input.email !== undefined) data.email = input.email;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.address !== undefined) data.address = input.address;
  if (input.city !== undefined) data.city = input.city;
  if (input.state !== undefined) data.state = input.state;
  if (input.zip !== undefined) data.zip = input.zip;
  if (input.tags !== undefined) data.tags = input.tags;
  if (input.notes !== undefined) data.notes = input.notes;

  const updated = await c.var.db.customer.update({ where: { id }, data });

  return c.json({ customer: serializeCustomer(updated) });
});
