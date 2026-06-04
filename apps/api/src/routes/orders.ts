/**
 * Orders + booking API.
 *
 *   POST   /                  public — create a booking (server recomputes price)
 *   GET    /                  staff  — list orders with status/date/search filters
 *   GET    /:orderNumber      public-by-order-number OR staff — fetch one order
 *   POST   /:id/cancel        staff  — cancel an order, restoring capacity
 *
 * All data access goes through `c.var.db` (the RLS-scoped tenant client). Prices are
 * NEVER taken from the client — see services/booking.ts.
 */
import { Hono } from 'hono';
import { assertPermission } from '@marina/auth';
import { bookingInputSchema } from '@marina/core';
import type { Prisma } from '@marina/database';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { createBooking, cancelBooking, BookingError } from '../services/booking.js';

export const orders = new Hono<Env>();

// --- Serialization --------------------------------------------------------

// The minimal relation set serializeOrder needs. Richer query results (e.g. the
// booking result, which also includes payments/history) remain assignable to this
// narrower payload, so one serializer covers create, list, and detail.
type OrderWithRelations = Prisma.OrderGetPayload<{
  include: {
    customer: true;
    items: { include: { activity: true; rate: true; timeslot: true } };
  };
}>;

/** Shape an order (with relations) into a stable, client-facing JSON payload. */
function serializeOrder(order: OrderWithRelations) {
  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    createdBy: order.created_by,
    subtotalCents: order.subtotal_cents,
    discountCents: order.discount_cents,
    taxCents: order.tax_cents,
    processingFeeCents: order.processing_fee_cents,
    tipCents: order.tip_cents,
    totalCents: order.total_cents,
    amountPaidCents: order.amount_paid_cents,
    balanceDueCents: order.balance_due_cents,
    isReturningGuest: order.is_returning_guest,
    createdAt: order.created_at,
    customer: {
      id: order.customer.id,
      firstName: order.customer.first_name,
      lastName: order.customer.last_name,
      email: order.customer.email,
      phone: order.customer.phone,
    },
    items: order.items.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      unitPriceCents: item.unit_price_cents,
      status: item.status,
      driverName: item.driver_name,
      activity: { id: item.activity.id, name: item.activity.name_external },
      rate: {
        id: item.rate.id,
        name: item.rate.name_external,
        durationMinutes: item.rate.duration_minutes,
      },
      timeslot: { id: item.timeslot.id, datetime: item.timeslot.datetime },
    })),
  };
}

// --- POST / : create a booking (public) -----------------------------------

orders.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = bookingInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid booking input', issues: parsed.error.issues }, 422);
  }

  try {
    const order = await createBooking(c.var.operatorId, parsed.data, {
      channel: 'CUSTOMER',
    });
    return c.json({ order: serializeOrder(order) }, 201);
  } catch (err) {
    if (err instanceof BookingError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

// --- GET / : list orders (staff, order:read) ------------------------------

const ORDER_STATUSES = ['UPCOMING', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const;
type OrderStatusFilter = (typeof ORDER_STATUSES)[number];

orders.get('/', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:read');

  const statusParam = c.req.query('status');
  const status = ORDER_STATUSES.includes(statusParam as OrderStatusFilter)
    ? (statusParam as OrderStatusFilter)
    : undefined;

  // `date` filters by the calendar day a booked timeslot falls on (YYYY-MM-DD).
  const dateParam = c.req.query('date');
  let timeslotDateFilter: { gte: Date; lt: Date } | undefined;
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const [y, m, d] = dateParam.split('-').map(Number) as [number, number, number];
    const start = new Date(y, m - 1, d, 0, 0, 0, 0);
    const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
    timeslotDateFilter = { gte: start, lt: end };
  }

  // `search` matches order number, customer name, or email.
  const search = c.req.query('search')?.trim();

  const take = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const skip = Math.max(Number(c.req.query('offset')) || 0, 0);

  const where: NonNullable<Parameters<typeof c.var.db.order.findMany>[0]>['where'] = {
    ...(status ? { status } : {}),
    ...(timeslotDateFilter
      ? { items: { some: { timeslot: { datetime: timeslotDateFilter } } } }
      : {}),
    ...(search
      ? {
          OR: [
            { order_number: { contains: search, mode: 'insensitive' } },
            { customer: { first_name: { contains: search, mode: 'insensitive' } } },
            { customer: { last_name: { contains: search, mode: 'insensitive' } } },
            { customer: { email: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    c.var.db.order.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take,
      skip,
      include: {
        items: { include: { activity: true, rate: true, timeslot: true } },
        customer: true,
      },
    }),
    c.var.db.order.count({ where }),
  ]);

  // The include above guarantees the relations at runtime; Promise.all loses the
  // payload inference under the extended client, so narrow back to the known shape.
  return c.json({
    orders: (rows as OrderWithRelations[]).map(serializeOrder),
    pagination: { total, limit: take, offset: skip },
  });
});

// --- GET /:orderNumber : fetch one (public-by-number OR staff) -------------

orders.get('/:orderNumber', async (c) => {
  const orderNumber = c.req.param('orderNumber');

  const order = await c.var.db.order.findFirst({
    where: { order_number: orderNumber },
    include: {
      items: { include: { activity: true, rate: true, timeslot: true } },
      customer: true,
    },
  });
  if (!order) {
    return c.json({ error: 'Order not found' }, 404);
  }

  return c.json({ order: serializeOrder(order) });
});

// --- POST /:id/cancel : cancel an order (staff, order:write) ---------------

orders.post('/:id/cancel', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const reason =
    body && typeof body === 'object' && typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 500)
      : undefined;

  try {
    const order = await cancelBooking(c.var.operatorId, id, {
      actor: c.var.auth.userId,
      reason: reason || undefined,
    });
    return c.json({ order: serializeOrder(order) });
  } catch (err) {
    if (err instanceof BookingError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});
