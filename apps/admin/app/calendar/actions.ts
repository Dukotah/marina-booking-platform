'use server';

/**
 * Server actions behind the calendar's reservation card — the "click a booking on
 * the calendar, run the whole reservation from a card" flow.
 *
 * Everything here REUSES the platform's existing write paths:
 *   - status ops (check-in / no-show / undo) live in app/manifest/actions.ts;
 *   - money ops (collect balance, add charge, cancel, refund) live in
 *     app/orders/actions.ts;
 *   - reschedule goes through the API's staff reschedule route, which wraps the
 *     one rescheduleBooking service (capacity checks + shared-resource windows +
 *     audit) — channel STAFF, so the customer self-service window does not apply.
 *
 * This file only adds the reads the card needs (one reservation, the reschedulable
 * slots) plus the two small writes that had no admin-side action yet: guest
 * contact details and order notes. All reads/writes are tenant-scoped (RLS) and
 * permission-gated, mirroring the conventions in the sibling action files.
 */

import { revalidatePath } from 'next/cache';
import type { OrderItemStatus } from '@marina/database';
import { AuthorizationError } from '@marina/auth';
import {
  getOperatorContext,
  getTenantDb,
  requirePermission,
  currentPermissions,
  type OperatorContext,
} from '../../lib/session';
import { waiverSignLink } from '../../lib/customer-web';

/** Uniform result for the card's mutations. */
export interface CardActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

/** Everything the reservation card renders, plain + serializable. */
export interface ReservationCardData {
  orderItemId: string;
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  itemStatus: OrderItemStatus;
  activityName: string;
  activityColor: string;
  rateName: string;
  quantity: number;
  unitPriceCents: number;
  timeslotId: string;
  startISO: string;
  /** "Thu, Sep 28" + "9:00 AM", pre-rendered in the OPERATOR's timezone. */
  dayLabel: string;
  timeLabel: string;
  durationMinutes: number;
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
  };
  totalCents: number;
  amountPaidCents: number;
  balanceDueCents: number;
  waiverSigned: boolean;
  waiverSignUrl: string;
  notes: { id: string; content: string; createdAtISO: string }[];
  /** Permission flags so the card never renders a control the caller can't use. */
  canWrite: boolean;
  canEditCustomer: boolean;
}

export interface LoadCardResult {
  ok: boolean;
  error?: string;
  card?: ReservationCardData;
}

/** Operator-local "Thu, Sep 28" / "9:00 AM" labels for a UTC instant. */
function tzLabels(instant: Date, timeZone: string): { day: string; time: string } {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(instant);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
  return { day, time };
}

/**
 * Load one reservation for the card. Tenant-scoped read; the permission flags ride
 * along so the client renders exactly the controls this staffer may use.
 */
export async function loadReservationCard(orderItemId: string): Promise<LoadCardResult> {
  if (!orderItemId) return { ok: false, error: 'Missing booking id.' };

  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';

  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: {
      id: true,
      quantity: true,
      unit_price_cents: true,
      status: true,
      waiver_signed: true,
      timeslot: { select: { id: true, datetime: true } },
      rate: { select: { name_external: true, name_internal: true, duration_minutes: true } },
      activity: { select: { name_internal: true, name_external: true, color: true } },
      order: {
        select: {
          id: true,
          order_number: true,
          status: true,
          total_cents: true,
          amount_paid_cents: true,
          balance_due_cents: true,
          customer: {
            select: { id: true, first_name: true, last_name: true, email: true, phone: true },
          },
          notes: {
            select: { id: true, content: true, created_at: true },
            orderBy: { created_at: 'desc' },
            take: 8,
          },
        },
      },
    },
  });
  if (!item) return { ok: false, error: 'Reservation not found.' };

  const perms = await currentPermissions();
  const labels = tzLabels(item.timeslot.datetime, timeZone);

  return {
    ok: true,
    card: {
      orderItemId: item.id,
      orderId: item.order.id,
      orderNumber: item.order.order_number,
      orderStatus: item.order.status,
      itemStatus: item.status,
      activityName: item.activity.name_internal || item.activity.name_external,
      activityColor: item.activity.color,
      rateName: item.rate?.name_external || item.rate?.name_internal || 'Rate',
      quantity: item.quantity,
      unitPriceCents: item.unit_price_cents,
      timeslotId: item.timeslot.id,
      startISO: item.timeslot.datetime.toISOString(),
      dayLabel: labels.day,
      timeLabel: labels.time,
      durationMinutes: item.rate?.duration_minutes ?? 240,
      customer: {
        id: item.order.customer.id,
        firstName: item.order.customer.first_name,
        lastName: item.order.customer.last_name,
        email: item.order.customer.email,
        phone: item.order.customer.phone ?? null,
      },
      totalCents: item.order.total_cents,
      amountPaidCents: item.order.amount_paid_cents,
      balanceDueCents: item.order.balance_due_cents,
      waiverSigned: item.waiver_signed,
      waiverSignUrl: waiverSignLink(item.id),
      notes: item.order.notes.map((n) => ({
        id: n.id,
        content: n.content,
        createdAtISO: n.created_at.toISOString(),
      })),
      canWrite: perms.has('order:write'),
      canEditCustomer: perms.has('customer:write'),
    },
  };
}

// ---------------------------------------------------------------------------
// Reschedule — list candidate slots, then move via the API's staff route
// ---------------------------------------------------------------------------

export interface RescheduleSlot {
  timeslotId: string;
  iso: string;
  /** Operator-local labels, e.g. "Thu, Oct 1" / "9:00 AM". */
  dayLabel: string;
  timeLabel: string;
  remaining: number;
  capacityTotal: number;
  isCurrent: boolean;
  /** True when this slot can take the booking's party size. */
  hasRoom: boolean;
}

export interface RescheduleSlotsResult {
  ok: boolean;
  error?: string;
  slots?: RescheduleSlot[];
}

/** How many upcoming slots the picker offers (plenty for a season's weekends). */
const RESCHEDULE_SLOT_LIMIT = 90;

/**
 * Upcoming timeslots for the SAME activity as the booking — the candidates the
 * reschedule panel offers. Pure tenant-scoped read; room is measured against the
 * booking's own party size. The actual move re-validates everything server-side
 * in the booking service, so this list is advisory, never trusted.
 */
export async function listRescheduleSlots(orderItemId: string): Promise<RescheduleSlotsResult> {
  if (!orderItemId) return { ok: false, error: 'Missing booking id.' };

  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';

  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, activity_id: true, timeslot_id: true, quantity: true },
  });
  if (!item) return { ok: false, error: 'Reservation not found.' };

  const slots = await db.timeslot.findMany({
    where: {
      activity_id: item.activity_id,
      status: { not: 'CANCELLED' },
      datetime: { gte: new Date() },
    },
    select: { id: true, datetime: true, capacity_total: true, capacity_booked: true },
    orderBy: { datetime: 'asc' },
    take: RESCHEDULE_SLOT_LIMIT,
  });

  return {
    ok: true,
    slots: slots.map((s) => {
      const labels = tzLabels(s.datetime, timeZone);
      const remaining = Math.max(0, s.capacity_total - s.capacity_booked);
      const isCurrent = s.id === item.timeslot_id;
      return {
        timeslotId: s.id,
        iso: s.datetime.toISOString(),
        dayLabel: labels.day,
        timeLabel: labels.time,
        remaining,
        capacityTotal: s.capacity_total,
        isCurrent,
        hasRoom: remaining >= item.quantity,
      };
    }),
  };
}

/**
 * Move the booking to another timeslot. Calls the API's staff reschedule route
 * (`POST /api/orders/:id/reschedule`), which wraps the one rescheduleBooking
 * service: atomic capacity move, shared-resource re-check, audit trail — and
 * channel STAFF, so the customer 48h/self-service window does NOT apply.
 *
 * Header shape mirrors app/orders/actions.ts `internalApiHeaders` (that helper
 * can't be exported from a 'use server' module): x-operator-id for the API's
 * server-to-server tenant resolution, and the dev staff shim only when Clerk
 * auth is not enforced.
 */
export async function rescheduleReservation(input: {
  orderId: string;
  orderItemId: string;
  timeslotId: string;
}): Promise<CardActionResult> {
  let ctx: OperatorContext;
  try {
    ctx = await requirePermission('order:write');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to reschedule bookings.' };
    }
    throw err;
  }

  if (!input.orderId || !input.orderItemId || !input.timeslotId) {
    return { ok: false, error: 'Missing reservation or timeslot.' };
  }

  const base = (process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(
    /\/+$/,
    '',
  );
  if (!base) return { ok: false, error: 'The booking service is not configured.' };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-operator-id': ctx.operatorId,
  };
  if (process.env.REQUIRE_CLERK_AUTH !== 'true') {
    headers['x-dev-staff-id'] = ctx.auth.userId;
  }
  if (process.env.INTERNAL_API_TOKEN) {
    headers.authorization = `Bearer ${process.env.INTERNAL_API_TOKEN}`;
  }

  try {
    const res = await fetch(`${base}/api/orders/${encodeURIComponent(input.orderId)}/reschedule`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ timeslotId: input.timeslotId, orderItemId: input.orderItemId }),
      cache: 'no-store',
    });

    if (res.ok) {
      revalidateReservation(input.orderId);
      return { ok: true, message: 'Booking moved to the new time.' };
    }

    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: body?.error ?? `Could not reschedule (${res.status}).` };
  } catch (err) {
    console.error('[calendar] rescheduleReservation failed:', err);
    return { ok: false, error: 'Could not reach the booking service. Please try again.' };
  }
}

// ---------------------------------------------------------------------------
// Guest contact details
// ---------------------------------------------------------------------------

/** Loose email shape check — the DB uniqueness constraint is the real gate. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Update a guest's contact details from the card. Tenant-scoped, gated on
 * customer:write (same bar as the customer notes/tags editors), and it records an
 * OrderEvent on the booking so "who changed the phone number" is reconstructable.
 */
export async function updateGuestContact(input: {
  customerId: string;
  orderId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}): Promise<CardActionResult> {
  let ctx: OperatorContext;
  try {
    ctx = await requirePermission('customer:write');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to edit guests.' };
    }
    throw err;
  }

  const firstName = (input.firstName ?? '').trim().slice(0, 100);
  const lastName = (input.lastName ?? '').trim().slice(0, 100);
  const email = (input.email ?? '').trim().toLowerCase().slice(0, 254);
  const phone = (input.phone ?? '').trim().slice(0, 30);

  if (!input.customerId) return { ok: false, error: 'Missing guest.' };
  if (!firstName || !lastName) return { ok: false, error: 'First and last name are required.' };
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address.' };

  const db = await getTenantDb();
  const existing = await db.customer.findUnique({
    where: { id: input.customerId },
    select: { id: true, first_name: true, last_name: true, email: true, phone: true },
  });
  if (!existing) return { ok: false, error: 'Guest not found.' };

  try {
    await db.customer.update({
      where: { id: existing.id },
      data: {
        first_name: firstName,
        last_name: lastName,
        email,
        phone: phone || null,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return { ok: false, error: 'Another guest already uses that email address.' };
    }
    console.error('[calendar] updateGuestContact failed:', err);
    return { ok: false, error: 'Could not save the guest details. Please try again.' };
  }

  // Audit on the order the edit was made from (best-effort, like fleet events).
  if (input.orderId) {
    try {
      await db.orderEvent.create({
        data: {
          operator_id: ctx.operatorId,
          order_id: input.orderId,
          type: 'CUSTOMER_UPDATED',
          description: `Guest contact details updated from the calendar (${firstName} ${lastName})`,
          actor: ctx.auth.userId,
          metadata: {
            before: {
              first_name: existing.first_name,
              last_name: existing.last_name,
              email: existing.email,
              phone: existing.phone,
            },
            after: { first_name: firstName, last_name: lastName, email, phone: phone || null },
          },
        },
      });
    } catch (err) {
      console.error('[calendar] updateGuestContact audit write failed:', err);
    }
  }

  revalidateReservation(input.orderId);
  revalidatePath(`/customers/${input.customerId}`);
  revalidatePath('/customers');
  return { ok: true, message: 'Guest details saved.' };
}

// ---------------------------------------------------------------------------
// Order notes
// ---------------------------------------------------------------------------

const MAX_NOTE_LENGTH = 2000;

/**
 * Add a staff note to the order (the existing Note model — the POS already writes
 * it; this is the first admin-side writer). Gated on order:write.
 */
export async function addOrderNote(input: {
  orderId: string;
  content: string;
}): Promise<CardActionResult> {
  let ctx: OperatorContext;
  try {
    ctx = await requirePermission('order:write');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to add notes.' };
    }
    throw err;
  }

  const content = (input.content ?? '').trim().slice(0, MAX_NOTE_LENGTH);
  if (!input.orderId) return { ok: false, error: 'Missing order.' };
  if (!content) return { ok: false, error: 'Write the note first.' };

  const db = await getTenantDb();
  const order = await db.order.findUnique({
    where: { id: input.orderId },
    select: { id: true },
  });
  if (!order) return { ok: false, error: 'Order not found.' };

  await db.note.create({
    data: {
      operator_id: ctx.operatorId,
      order_id: order.id,
      content,
      author: ctx.auth.userId,
    },
  });

  revalidateReservation(input.orderId);
  return { ok: true, message: 'Note added.' };
}

/** The pages a reservation change can be visible on. */
function revalidateReservation(orderId: string): void {
  revalidatePath('/calendar');
  revalidatePath('/manifest');
  revalidatePath('/orders');
  if (orderId) revalidatePath(`/orders/${orderId}`);
}
