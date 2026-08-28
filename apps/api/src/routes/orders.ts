/**
 * Orders + booking API.
 *
 *   POST   /                  public — create a booking (server recomputes price)
 *   GET    /                  staff  — list orders with status/date/search filters
 *   GET    /:orderNumber      public-by-order-number OR staff — fetch one order
 *   POST   /:id/cancel        staff  — cancel an order, restoring capacity
 *   POST   /:id/reschedule    staff  — move a booking to another timeslot
 *   POST   /:orderNumber/self-reschedule  public — customer self-service reschedule
 *
 * All data access goes through `c.var.db` (the RLS-scoped tenant client). Prices are
 * NEVER taken from the client — see services/booking.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { assertPermission } from '@marina/auth';
import { bookingInputSchema } from '@marina/core';
import type { Prisma } from '@marina/database';
import type { Env } from '../context.js';
import { requireStaff } from '../middleware/auth.js';
import { getClientIp, rateLimit } from '../middleware/rate-limit.js';
import { AUDIT_ACTIONS, customerActor, recordAudit, staffActor } from '../services/audit.js';
import {
  createBooking,
  createBookingIdempotent,
  normalizeIdempotencyKey,
  cancelBooking,
  rescheduleBooking,
  collectBalance,
  BookingError,
} from '../services/booking.js';
import { sendBookingConfirmation, sendStaffNewBooking } from '../services/notifications.js';
import { sendBookingConfirmationSms } from '../services/sms.js';
import { evaluateApproval, loadApprovalPolicy } from '../services/approvals.js';

export const orders = new Hono<Env>();

/**
 * Fire booking notifications after an order is committed. Fire-and-forget: these
 * never throw and must not delay or block the booking response. Email (Resend) +
 * SMS (Twilio) go to the customer; staff get an email alert. Each channel no-ops
 * cleanly when its provider isn't configured.
 */
function dispatchBookingNotifications(operatorId: string, orderId: string): void {
  // SEQUENTIAL, not concurrent. Each of these opens its own tenant-scoped
  // transaction, which sets `app.current_operator_id` with SET LOCAL on a shared
  // Prisma client; firing them together interleaves those transactions and corrupts
  // the connection's protocol state. The symptom is baffling — Postgres rejecting a
  // perfectly clean payload with `invalid byte sequence for encoding "UTF8": 0x00` —
  // and it silently ate the staff alert on every booking while the customer's own
  // confirmation went out fine. (The same constraint is why the API test suite runs
  // with fileParallelism:false.)
  //
  // Still fire-and-forget as a whole: the chain runs off the response path, and
  // none of these ever throw, so a slow or failing channel cannot delay a booking.
  void (async () => {
    await sendBookingConfirmation({ operatorId, orderId });
    await sendBookingConfirmationSms({ operatorId, orderId });
    await sendStaffNewBooking({ operatorId, orderId });
  })();
}

// Throttle the PUBLIC/unauthenticated order endpoints (create, lookup-by-number,
// self-reschedule) per client IP + tenant to blunt brute-force / enumeration / DoS.
// Staff routes below run behind requireStaff and are intentionally not throttled.
const publicRateLimit = rateLimit();

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

// --- Reschedule auditing ---------------------------------------------------

/** Which timeslot each of an order's items sat on, keyed by item id. */
type SlotSnapshot = Map<string, { timeslotId: string; datetime: Date }>;

async function snapshotItemSlots(
  db: Env['Variables']['db'],
  orderId: string,
): Promise<SlotSnapshot> {
  const items = await db.orderItem.findMany({
    where: { order_id: orderId },
    select: { id: true, timeslot_id: true, timeslot: { select: { datetime: true } } },
  });
  return new Map(
    items.map((i) => [i.id, { timeslotId: i.timeslot_id, datetime: i.timeslot.datetime }]),
  );
}

/**
 * Record a completed reschedule.
 *
 * The moved item is identified by diffing against the pre-move snapshot rather
 * than by re-deriving which item the service picked: that selection rule (named
 * item, else the sole active one) lives in booking.ts, and a second copy here is
 * exactly how an audit row starts describing a different item than the one that
 * actually moved.
 */
async function auditReschedule(args: {
  operatorId: string;
  actor: Parameters<typeof recordAudit>[0]['actor'];
  order: OrderWithRelations;
  before: SlotSnapshot;
  requestedTimeslotId: string;
  channel: 'STAFF' | 'CUSTOMER';
}): Promise<void> {
  const { order, before } = args;
  const moved = order.items.find((i) => before.get(i.id)?.timeslotId !== i.timeslot_id);
  const previous = moved ? (before.get(moved.id) ?? null) : null;

  await recordAudit({
    operatorId: args.operatorId,
    actor: args.actor,
    action: AUDIT_ACTIONS.ORDER_RESCHEDULE,
    entityType: 'Order',
    entityId: order.id,
    before: {
      timeslot_id: previous?.timeslotId ?? null,
      timeslot_datetime: previous?.datetime ?? null,
    },
    after: {
      timeslot_id: moved?.timeslot.id ?? args.requestedTimeslotId,
      timeslot_datetime: moved?.timeslot.datetime ?? null,
    },
    context: {
      order_number: order.order_number,
      order_item_id: moved?.id ?? null,
      channel: args.channel,
      activity: moved?.activity.name_external ?? null,
      quantity: moved?.quantity ?? null,
    },
  });
}

// --- POST / : create a booking (public) -----------------------------------

orders.post('/', publicRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = bookingInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid booking input', issues: parsed.error.issues }, 422);
  }

  try {
    // Read the key straight off the RAW body: bookingInputSchema is a plain z.object
    // and zod strips unknown keys, so it never survives into parsed.data. A replayed
    // submit — a double-click, or a transport-level retry on flaky rural service —
    // must resolve to the order the first attempt created, not a second booking.
    const idempotencyKey = normalizeIdempotencyKey(
      (body as { idempotencyKey?: unknown } | null)?.idempotencyKey,
    );
    const { order, replayed } = await createBookingIdempotent(c.var.operatorId, parsed.data, {
      channel: 'CUSTOMER',
      idempotencyKey,
    });
    // Only the attempt that actually created the order sends mail. A replay must not
    // text the guest a second confirmation for one booking.
    if (!replayed) dispatchBookingNotifications(c.var.operatorId, order.id);
    return c.json({ order: serializeOrder(order) }, replayed ? 200 : 201);
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

orders.get('/:orderNumber', publicRateLimit, async (c) => {
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

  // Read the pre-cancel money state before the service moves it. cancelBooking
  // returns only the post-state, and "cancelled an order that had $340 collected
  // against it" is the fact an investigator needs.
  const before = await c.var.db.order.findUnique({
    where: { id },
    select: {
      status: true,
      total_cents: true,
      amount_paid_cents: true,
      balance_due_cents: true,
    },
  });

  try {
    const order = await cancelBooking(c.var.operatorId, id, {
      actor: c.var.auth.userId,
      reason: reason || undefined,
    });

    await recordAudit({
      operatorId: c.var.operatorId,
      actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
      action: AUDIT_ACTIONS.ORDER_CANCEL,
      entityType: 'Order',
      entityId: order.id,
      before: {
        status: before?.status ?? null,
        amount_paid_cents: before?.amount_paid_cents ?? null,
        balance_due_cents: before?.balance_due_cents ?? null,
      },
      after: {
        status: order.status,
        amount_paid_cents: order.amount_paid_cents,
        balance_due_cents: order.balance_due_cents,
      },
      context: {
        order_number: order.order_number,
        reason: reason ?? null,
        total_cents: order.total_cents,
        // Cancelling does not refund; money still held against a cancelled order
        // is an open liability and the row should say so.
        retained_cents: order.amount_paid_cents,
        items_cancelled: order.items.length,
      },
    });

    return c.json({ order: serializeOrder(order) });
  } catch (err) {
    if (err instanceof BookingError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

// --- POST /:id/collect-balance : charge the remaining balance (staff) --------

const collectBalanceSchema = z.object({
  /** How to settle the remainder. Defaults to a (simulated) card charge. */
  method: z.enum(['CARD', 'CASH']).default('CARD'),
});

orders.post('/:id/collect-balance', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const id = c.req.param('id');
  const parsed = collectBalanceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  // Manager-approval gate for staff-initiated charges above the operator threshold
  // (Singenuity §2). Evaluate against the order's outstanding balance (what will be
  // charged) before touching the processor. Self-approved by managers (order:approve).
  const orderForApproval = await c.var.db.order.findUnique({
    where: { id },
    select: { balance_due_cents: true },
  });
  if (orderForApproval && orderForApproval.balance_due_cents > 0) {
    const policy = await loadApprovalPolicy(c.var.db, c.var.operatorId);
    const approval = evaluateApproval({
      action: 'payment',
      amountCents: orderForApproval.balance_due_cents,
      policy,
      auth: c.var.auth,
    });
    if (approval.blocked) {
      return c.json(
        {
          error: approval.reason ?? 'This charge requires manager approval',
          code: 'APPROVAL_REQUIRED',
          requiresPermission: 'order:approve',
        },
        403,
      );
    }
  }

  try {
    const result = await collectBalance(c.var.operatorId, id, {
      actor: c.var.auth.userId,
      method: parsed.data.method,
    });

    // collectBalance charges exactly the outstanding balance in one transaction,
    // so the pre-charge state is the post-state minus what it charged — exact
    // arithmetic, and cheaper than a second read of a row we already moved.
    await recordAudit({
      operatorId: c.var.operatorId,
      actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
      action: AUDIT_ACTIONS.PAYMENT_CAPTURE,
      entityType: 'Payment',
      entityId: result.paymentId,
      before: {
        amount_paid_cents: result.amountPaidCents - result.chargedCents,
        balance_due_cents: result.balanceDueCents + result.chargedCents,
      },
      after: {
        amount_paid_cents: result.amountPaidCents,
        balance_due_cents: result.balanceDueCents,
      },
      context: {
        order_id: result.orderId,
        order_number: result.orderNumber,
        captured_cents: result.chargedCents,
        method: parsed.data.method,
        source: 'staff_balance_collection',
      },
    });

    return c.json({ result });
  } catch (err) {
    if (err instanceof BookingError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

// --- POST /:id/reschedule : move a booking to another slot (staff) ----------

const staffRescheduleSchema = z.object({
  timeslotId: z.string().min(1, 'timeslotId is required'),
  /** Disambiguate which item to move on a multi-item order. */
  orderItemId: z.string().min(1).optional(),
});

orders.post('/:id/reschedule', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const id = c.req.param('id');
  const parsed = staffRescheduleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const before = await snapshotItemSlots(c.var.db, id);

  try {
    const order = await rescheduleBooking(c.var.operatorId, id, parsed.data.timeslotId, {
      actor: c.var.auth.userId,
      channel: 'STAFF', // staff bypass the self-service window
      orderItemId: parsed.data.orderItemId,
    });

    if (order) {
      await auditReschedule({
        operatorId: c.var.operatorId,
        actor: staffActor(c.var.auth, getClientIp((h) => c.req.header(h))),
        order,
        before,
        requestedTimeslotId: parsed.data.timeslotId,
        channel: 'STAFF',
      });
    }

    return c.json({ order: order ? serializeOrder(order) : null });
  } catch (err) {
    if (err instanceof BookingError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

// --- POST /:orderNumber/self-reschedule : customer self-service -------------

const selfRescheduleSchema = z.object({
  /** Identity check (magic-link stub): must match the order's customer email. */
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  timeslotId: z.string().min(1, 'timeslotId is required'),
  orderItemId: z.string().min(1).optional(),
});

orders.post('/:orderNumber/self-reschedule', publicRateLimit, async (c) => {
  const orderNumber = c.req.param('orderNumber');
  const parsed = selfRescheduleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  // Resolve the order by number (RLS-scoped) and verify the email matches before
  // touching anything — the lightweight identity gate for the self-service flow.
  const found = await c.var.db.order.findFirst({
    where: { order_number: orderNumber },
    select: { id: true, customer: { select: { id: true, email: true } } },
  });
  if (!found || found.customer.email.toLowerCase() !== parsed.data.email) {
    // Same response whether the order is missing or the email is wrong — don't leak
    // which order numbers exist.
    return c.json({ error: 'We could not find a booking matching those details' }, 404);
  }

  const before = await snapshotItemSlots(c.var.db, found.id);

  try {
    const order = await rescheduleBooking(c.var.operatorId, found.id, parsed.data.timeslotId, {
      actor: 'customer',
      channel: 'CUSTOMER', // enforces the activity's self-reschedule window
      orderItemId: parsed.data.orderItemId,
    });

    if (order) {
      await auditReschedule({
        operatorId: c.var.operatorId,
        // Self-service is unauthenticated; the email match above is the identity
        // check, so the order's customer is the honest attribution and the IP is
        // what corroborates it.
        actor: customerActor(found.customer.id, getClientIp((h) => c.req.header(h))),
        order,
        before,
        requestedTimeslotId: parsed.data.timeslotId,
        channel: 'CUSTOMER',
      });
    }

    return c.json({ order: order ? serializeOrder(order) : null });
  } catch (err) {
    if (err instanceof BookingError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});
