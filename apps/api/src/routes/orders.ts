/**
 * Orders + booking API.
 *
 *   POST   /                  public — create a booking (server recomputes price)
 *   GET    /                  staff  — list orders with status/date/search filters
 *   GET    /:orderNumber      public-by-order-number OR staff — fetch one order
 *   POST   /:id/cancel        staff  — cancel an order, restoring capacity
 *   POST   /:id/reschedule    staff  — move a booking to another timeslot
 *   POST   /:orderNumber/self-reschedule  public — customer self-service reschedule
 *   GET    /:orderNumber/self-cancel      public — refund preview for self-cancel
 *   POST   /:orderNumber/self-cancel      public — customer self-service cancel
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
import { requireStaff, resolveStaffMember } from '../middleware/auth.js';
import { getClientIp, rateLimit } from '../middleware/rate-limit.js';
import { AUDIT_ACTIONS, customerActor, recordAudit, staffActor } from '../services/audit.js';
import {
  createBooking,
  createBookingIdempotent,
  normalizeIdempotencyKey,
  cancelBooking,
  previewCancellationRefund,
  rescheduleBooking,
  collectBalance,
  BookingError,
} from '../services/booking.js';
import { sendBookingConfirmation, sendStaffNewBooking } from '../services/notifications.js';
import { sendBookingConfirmationSms } from '../services/sms.js';
import { messageOrderGuest, BroadcastError } from '../services/broadcast.js';
import { evaluateApproval, loadApprovalPolicy } from '../services/approvals.js';
import { createRentalBooking, RentalError } from '../services/rental.js';

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
      // Per-head rate class this seat line was sold under (null for a plain
      // single-quantity booking). Label is the snapshot taken at booking time.
      rateClassLabel: item.rate_class_label,
      status: item.status,
      driverName: item.driver_name,
      // Waiver state per item, so the confirmation page can show a "sign your
      // waiver" call-to-action linking the standalone signer for unsigned items.
      waiverRequired: item.activity.waiver_required,
      waiverSigned: item.waiver_signed,
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
    // The cart hold this checkout reserved under (if any). Read off the raw body for
    // the same reason the idempotency key is: zod strips unknown keys from parsed.data.
    const rawHoldId = (body as { holdId?: unknown } | null)?.holdId;
    const holdId = typeof rawHoldId === 'string' && rawHoldId.trim().length > 0 ? rawHoldId.trim() : null;
    const { order, replayed } = await createBookingIdempotent(c.var.operatorId, parsed.data, {
      channel: 'CUSTOMER',
      idempotencyKey,
      holdId,
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

// --- POST /rental : create an open-duration RENTAL booking (staff) ----------
//
// Staff/POS consumer for the open-duration rental engine: book a boat at a chosen
// start + duration (the rate's duration_minutes). The customer-facing web rental
// picker is intentionally OUT OF SCOPE this build — this staff action is the only
// consumer. createRentalBooking validates the start fits a free gap (inside an open
// window, not blacked out, not already taken), materializes the timeslot, and hands
// off to the ordinary booking engine, so FOR UPDATE + ResourceBooking overlap +
// pricing + idempotency are all inherited. Registered before `/:orderNumber` so
// Hono doesn't read "rental" as an order number.

const rentalCustomerSchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required').max(80),
  last_name: z.string().trim().min(1, 'Last name is required').max(80),
  email: z.string().trim().toLowerCase().email('A valid email is required').max(254),
  phone: z.string().trim().max(32).optional(),
  address: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(64).optional(),
  zip: z.string().trim().max(16).optional(),
});

const rentalBookingSchema = z.object({
  activityId: z.string().min(1, 'activityId is required'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  startMinute: z.number().int().min(0).max(24 * 60 - 1),
  rateId: z.string().min(1, 'rateId is required'),
  quantity: z.number().int().positive('quantity must be at least 1'),
  customer: rentalCustomerSchema,
  promoCode: z.string().trim().min(1).max(64).optional(),
  tipCents: z.number().int().nonnegative().optional(),
});

orders.post('/rental', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');
  const body = await c.req.json().catch(() => null);
  const parsed = rentalBookingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid rental input', issues: parsed.error.issues }, 422);
  }

  try {
    const idempotencyKey = normalizeIdempotencyKey(
      (body as { idempotencyKey?: unknown } | null)?.idempotencyKey,
    );
    const order = await createRentalBooking(c.var.operatorId, parsed.data, {
      channel: 'STAFF',
      actor: c.var.auth.userId,
      idempotencyKey,
    });
    // Same notification contract as the public create path (fire-and-forget).
    dispatchBookingNotifications(c.var.operatorId, order.id);
    return c.json({ order: serializeOrder(order) }, 201);
  } catch (err) {
    if (err instanceof RentalError || err instanceof BookingError) {
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

// --- GET /:orderNumber : fetch one (public-by-number+email OR staff) -------

orders.get('/:orderNumber', publicRateLimit, async (c) => {
  const orderNumber = c.req.param('orderNumber');

  const order = await c.var.db.order.findFirst({
    where: { order_number: orderNumber },
    include: {
      items: { include: { activity: true, rate: true, timeslot: true } },
      customer: true,
    },
  });

  // Identity gate. Order numbers are human-facing and enumerable
  // (<PUBLIC_CODE><YYMMDD><SEQ3> starting at 001), so the bare order number is NOT
  // a secret: without a second factor an attacker walks the keyspace per day and
  // harvests every guest's name + email + phone. serializeOrder returns full PII,
  // so the caller must prove they own the booking — the same lightweight email
  // match the self-reschedule path uses — OR be authenticated staff.
  //
  // A staff member (dev shim `x-dev-staff-id`, or a verified Clerk token when
  // enforcement is on) resolves to an active StaffMember for this tenant and
  // bypasses the email check — the staff admin fetches orders this way.
  const staff = await resolveStaffMember(c);
  if (!staff) {
    const email = c.req.query('email')?.trim().toLowerCase();
    // Same 404 whether the order is missing OR the email is missing/wrong, so the
    // endpoint can't be used to probe which order numbers exist (mirrors
    // self-reschedule's missing-vs-wrong handling exactly).
    if (!order || !email || order.customer.email.toLowerCase() !== email) {
      return c.json({ error: 'Order not found' }, 404);
    }
  } else if (!order) {
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

// --- POST /:id/message : message one order's guest (staff) ------------------

const messageSchema = z
  .object({
    body: z.string().trim().min(1, 'A message is required').max(1000),
    email: z.boolean().optional().default(true),
    sms: z.boolean().optional().default(false),
    subject: z.string().trim().max(200).optional(),
  })
  .strict();

orders.post('/:id/message', requireStaff, async (c) => {
  assertPermission(c.var.auth, 'order:write');

  const id = c.req.param('id');
  const parsed = messageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: 'Validation failed',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  try {
    const result = await messageOrderGuest(c.var.operatorId, {
      orderId: id,
      body: parsed.data.body,
      subject: parsed.data.subject,
      channels: { email: parsed.data.email, sms: parsed.data.sms },
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof BroadcastError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400 | 404);
    }
    throw err;
  }
});

// --- Self-service identity gate (shared) -----------------------------------

/** An order resolved by its public number once the email on it has matched. */
type GatedOrder = { id: string; customer: { id: string; email: string } };

/**
 * The lightweight identity gate every public self-service mutation shares: resolve
 * the order by its (enumerable) number on the RLS-scoped tenant client and require
 * the supplied email to match the order's customer email. Order numbers are NOT a
 * secret, so this email match is the real ownership proof.
 *
 * Returns the order on a match, or null on EITHER a missing order OR a wrong email —
 * the caller must 404 identically for both so the endpoint can't be used to probe
 * which order numbers exist. Self-reschedule and self-cancel call this verbatim so
 * they never drift apart and never widen the known IDOR surface.
 */
async function gateSelfServiceOrder(
  db: Env['Variables']['db'],
  orderNumber: string,
  email: string,
): Promise<GatedOrder | null> {
  const found = await db.order.findFirst({
    where: { order_number: orderNumber },
    select: { id: true, customer: { select: { id: true, email: true } } },
  });
  if (!found || found.customer.email.toLowerCase() !== email) return null;
  return found;
}

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
  const found = await gateSelfServiceOrder(c.var.db, orderNumber, parsed.data.email);
  if (!found) {
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

// --- GET /:orderNumber/self-cancel : refund preview (public) ----------------
//
// Read-only. The self-service cancel dialog GETs this first to show the guest what
// their refund would be and whether they are still inside the self-cancel window,
// BEFORE they confirm. Gated by the SAME email identity check the cancel POST uses
// (and the same 404-on-miss behaviour), so the preview can't be used to probe which
// order numbers exist or to read a stranger's refund posture.

orders.get('/:orderNumber/self-cancel', publicRateLimit, async (c) => {
  const orderNumber = c.req.param('orderNumber');
  const email = c.req.query('email')?.trim().toLowerCase();
  if (!email) {
    return c.json({ error: 'We could not find a booking matching those details' }, 404);
  }

  const found = await gateSelfServiceOrder(c.var.db, orderNumber, email);
  if (!found) {
    return c.json({ error: 'We could not find a booking matching those details' }, 404);
  }

  try {
    const preview = await previewCancellationRefund(c.var.operatorId, found.id);
    return c.json({ preview });
  } catch (err) {
    if (err instanceof BookingError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});

// --- POST /:orderNumber/self-cancel : customer self-service cancel -----------
//
// Mirrors the self-reschedule endpoint's identity gate (email + order number, reused
// verbatim via gateSelfServiceOrder) so this adds no new IDOR surface. Enforces the
// policy's self_cancel_hours cutoff: a cancel too close to start is refused with 409
// SELF_CANCEL_WINDOW_CLOSED and the guest is told to call. On success it delegates to
// cancelBooking with channel CUSTOMER + enforceSelfCancelWindow so the tiered refund
// and the cancellation email/SMS fire exactly as the staff cancel's do.

const selfCancelSchema = z.object({
  /** Identity check (magic-link stub): must match the order's customer email. */
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  /** Optional free-text reason, recorded on the cancel event. */
  reason: z.string().max(500).optional(),
});

orders.post('/:orderNumber/self-cancel', publicRateLimit, async (c) => {
  const orderNumber = c.req.param('orderNumber');
  const parsed = selfCancelSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
  }

  const found = await gateSelfServiceOrder(c.var.db, orderNumber, parsed.data.email);
  if (!found) {
    // Same response whether the order is missing or the email is wrong — don't leak
    // which order numbers exist.
    return c.json({ error: 'We could not find a booking matching those details' }, 404);
  }

  // Pre-cancel money state for the audit row (the staff cancel captures the same).
  const before = await c.var.db.order.findUnique({
    where: { id: found.id },
    select: { status: true, amount_paid_cents: true, balance_due_cents: true },
  });

  try {
    const order = await cancelBooking(c.var.operatorId, found.id, {
      actor: 'customer',
      reason: parsed.data.reason?.trim() || undefined,
      channel: 'CUSTOMER', // subject to the self-cancel window ...
      enforceSelfCancelWindow: true, // ... and we ask it to be enforced.
    });

    await recordAudit({
      operatorId: c.var.operatorId,
      // Self-service is unauthenticated; the email match above is the identity check,
      // so the order's customer is the honest attribution and the IP corroborates it.
      actor: customerActor(found.customer.id, getClientIp((h) => c.req.header(h))),
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
        channel: 'CUSTOMER',
        reason: parsed.data.reason ?? null,
        total_cents: order.total_cents,
        refund_cents: order.refundSummary?.refundCents ?? 0,
        retained_cents: order.amount_paid_cents,
        items_cancelled: order.items.length,
      },
    });

    return c.json({ order: serializeOrder(order), refund: order.refundSummary ?? null });
  } catch (err) {
    if (err instanceof BookingError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
});
