'use server';

import { revalidatePath } from 'next/cache';
import { type Prisma } from '@marina/database';
import { AuthorizationError } from '@marina/auth';
import { getOperatorContext, getTenantDb, requirePermission } from '../../lib/session';
import { localDayRangeUtc } from '../../components/manifest/tz';
// The fleet panel writes out_of_service_qty through the settings action rather than
// touching the column itself — see the fleet section at the bottom of this file.
import { updateResource } from '../settings/resources/actions';

/**
 * One-click check-in for a manifest booking block. The whole point of the visual
 * manifest is that staff can run the dock from a single screen — tap a block, the
 * guest is checked in. This server action is the write half of that interaction.
 *
 * Security: every query runs through the tenant-scoped client (RLS-enforced), and
 * we re-derive the operator from the session rather than trusting client input, so
 * one operator can never mutate another's order items. We also require the
 * `order:write` permission.
 */
export interface CheckInResult {
  ok: boolean;
  status?: 'CHECKED_IN' | 'UPCOMING' | 'NO_SHOW';
  error?: string;
}

export async function checkInOrderItem(orderItemId: string): Promise<CheckInResult> {
  if (!orderItemId) return { ok: false, error: 'Missing booking id' };

  const { auth } = await getOperatorContext();
  try {
    // Staff and above may operate the manifest / check guests in.
    if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
      throw new AuthorizationError('order:write');
    }
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to check guests in.' };
    }
    throw err;
  }

  const db = await getTenantDb();

  // Read first so we can produce an idempotent toggle and a precise audit event.
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, status: true, order_id: true },
  });

  if (!item) return { ok: false, error: 'Booking not found' };

  // Idempotent: checking in an already-checked-in item simply re-affirms it and
  // skips the redundant audit event below.
  if (item.status === 'CHECKED_IN') {
    return { ok: true, status: 'CHECKED_IN' };
  }

  await db.orderItem.update({
    where: { id: item.id },
    data: { status: 'CHECKED_IN' },
  });

  // Audit trail on the parent order so the action is reconstructable later.
  await db.orderEvent.create({
    data: {
      operator_id: auth.operatorId,
      order_id: item.order_id,
      type: 'CHECK_IN',
      description: 'Guest checked in from the day manifest',
      actor: auth.userId,
    },
  });

  revalidatePath('/manifest');
  return { ok: true, status: 'CHECKED_IN' };
}

/**
 * Undo a check-in (revert to UPCOMING). Mirrors the check-in path so a mis-tap is
 * recoverable without leaving the manifest.
 */
export async function undoCheckInOrderItem(orderItemId: string): Promise<CheckInResult> {
  if (!orderItemId) return { ok: false, error: 'Missing booking id' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to modify check-ins.' };
  }

  const db = await getTenantDb();
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, status: true, order_id: true },
  });
  if (!item) return { ok: false, error: 'Booking not found' };

  await db.orderItem.update({
    where: { id: item.id },
    data: { status: 'UPCOMING' },
  });

  await db.orderEvent.create({
    data: {
      operator_id: auth.operatorId,
      order_id: item.order_id,
      type: 'CHECK_IN_UNDO',
      description: 'Check-in reverted from the day manifest',
      actor: auth.userId,
    },
  });

  revalidatePath('/manifest');
  return { ok: true, status: 'UPCOMING' };
}

/**
 * Mark a booking as a no-show (guest never arrived). Frees nothing (the slot is
 * past), but records it for reporting and lets staff clear the manifest. Idempotent.
 */
export async function markNoShowOrderItem(orderItemId: string): Promise<CheckInResult> {
  if (!orderItemId) return { ok: false, error: 'Missing booking id' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to modify the manifest.' };
  }

  const db = await getTenantDb();
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, status: true, order_id: true },
  });
  if (!item) return { ok: false, error: 'Booking not found' };
  if (item.status === 'NO_SHOW') return { ok: true, status: 'NO_SHOW' };

  await db.orderItem.update({ where: { id: item.id }, data: { status: 'NO_SHOW' } });
  await db.orderEvent.create({
    data: {
      operator_id: auth.operatorId,
      order_id: item.order_id,
      type: 'NO_SHOW',
      description: 'Marked no-show from the day manifest',
      actor: auth.userId,
    },
  });

  revalidatePath('/manifest');
  return { ok: true, status: 'NO_SHOW' };
}

/** Revert a no-show back to UPCOMING (mis-tap recovery). */
export async function undoNoShowOrderItem(orderItemId: string): Promise<CheckInResult> {
  if (!orderItemId) return { ok: false, error: 'Missing booking id' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to modify the manifest.' };
  }

  const db = await getTenantDb();
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, status: true, order_id: true },
  });
  if (!item) return { ok: false, error: 'Booking not found' };

  await db.orderItem.update({ where: { id: item.id }, data: { status: 'UPCOMING' } });
  await db.orderEvent.create({
    data: {
      operator_id: auth.operatorId,
      order_id: item.order_id,
      type: 'NO_SHOW_UNDO',
      description: 'No-show reverted from the day manifest',
      actor: auth.userId,
    },
  });

  revalidatePath('/manifest');
  return { ok: true, status: 'UPCOMING' };
}

/**
 * Local permission check mirroring @marina/auth.hasPermission but driven directly
 * off the role/extras already on the session context (avoids constructing a full
 * AuthContext for a single check). `order:write` is held by OWNER/ADMIN/MANAGER/STAFF.
 */
function effectiveCanWrite(role: string, extra: string[]): boolean {
  if (extra.includes('order:write')) return true;
  return role === 'OWNER' || role === 'ADMIN' || role === 'MANAGER' || role === 'STAFF';
}

// ===========================================================================
// Guide scheduling (Singenuity §2)
// ===========================================================================

export interface GuideActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Assign a guide (staff member) to a timeslot from the manifest. Mirrors the API's
 * guide service: validates the guide is an active staffer + the slot exists, is
 * idempotent on (slot, guide), and records the assigning actor. Notifications fire
 * from the API path; the admin action is the direct-DB write for the dock UI.
 * Requires `order:write` (same bar as running the manifest).
 */
export async function assignGuideAction(
  timeslotId: string,
  guideId: string,
  roleLabel?: string,
): Promise<GuideActionResult> {
  if (!timeslotId || !guideId) return { ok: false, error: 'Missing guide or timeslot' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to schedule guides.' };
  }

  const db = await getTenantDb();

  const guide = await db.staffMember.findFirst({
    where: { id: guideId, is_active: true },
    select: { id: true },
  });
  if (!guide) return { ok: false, error: 'Guide is not an active staff member.' };

  const slot = await db.timeslot.findUnique({ where: { id: timeslotId }, select: { id: true } });
  if (!slot) return { ok: false, error: 'Timeslot not found.' };

  const existing = await db.guideAssignment.findFirst({
    where: { timeslot_id: timeslotId, guide_id: guideId },
    select: { id: true },
  });
  if (existing) {
    // Idempotent: update the role label if it changed, otherwise no-op.
    await db.guideAssignment.update({
      where: { id: existing.id },
      data: { role_label: roleLabel?.trim() || null },
    });
  } else {
    await db.guideAssignment.create({
      data: {
        operator_id: auth.operatorId,
        timeslot_id: timeslotId,
        guide_id: guideId,
        role_label: roleLabel?.trim() || null,
        assigned_by: auth.userId,
      },
    });
  }

  revalidatePath('/manifest');
  return { ok: true };
}

/** Remove a guide assignment by id. Idempotent (missing → ok). */
export async function unassignGuideAction(assignmentId: string): Promise<GuideActionResult> {
  if (!assignmentId) return { ok: false, error: 'Missing assignment id' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to schedule guides.' };
  }

  const db = await getTenantDb();
  const existing = await db.guideAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true },
  });
  if (existing) await db.guideAssignment.delete({ where: { id: existing.id } });

  revalidatePath('/manifest');
  return { ok: true };
}

// ===========================================================================
// Fleet status — take a boat out of service without leaving the dock
// ===========================================================================

/**
 * Marking a unit down is a capacity write, so it goes through the SAME path the
 * settings screen uses: `updateResource` -> `Resource.out_of_service_qty`. There is
 * deliberately no second writer. The booking engine sizes a pool as
 * (quantity - out_of_service_qty) * seat_capacity (apps/api/src/services/resources.ts),
 * so one field with one writer is what makes "those seats stopped selling the moment
 * he tapped it" true rather than hopeful.
 *
 * The reason and the date range have no column of their own on Resource, and this
 * slice may not touch the schema, so they are recorded as an AuditLog row
 * (`resource.out_of_service`) and read back to caption the panel. That is a real
 * record — append-only, attributed, already surfaced by /audit and filed by prefix by
 * components/audit/taxonomy.ts — but it is a record, not a schedule: nothing sweeps a
 * unit back into service when its date passes. So the panel nags on the date instead
 * of pretending, the copy never promises an automatic return, and the slice report
 * asks for the schema field that would let it actually schedule one.
 */

/** A booked trip that overlaps a moment when the shrunken fleet is short. */
export interface FleetImpactBooking {
  orderItemId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string | null;
  activityName: string;
  /** ISO start instant; rendered in the operator's locale by the client. */
  startISO: string;
  seats: number;
}

/** What taking `units` out of a pool would do to bookings already on the books. */
export interface FleetImpact {
  resourceId: string;
  resourceName: string;
  /** Units down before this change, and after it. */
  unitsDownBefore: number;
  unitsDownAfter: number;
  /** Bookable seats before this change, and after it. */
  seatsBefore: number;
  seatsAfter: number;
  /** The window examined, as operator-local calendar dates. */
  fromISO: string;
  untilISO: string | null;
  /** True when no end date was given and the rolling horizon below was used. */
  openEnded: boolean;
  horizonDays: number;
  /** Trips already booked against this pool inside the window. */
  bookedTrips: number;
  /** Peak seats concurrently reserved inside the window. */
  peakSeats: number;
  /** Seats short at that peak. 0 = the remaining fleet still covers everything. */
  shortfallSeats: number;
  /** Trips overlapping a moment when the fleet is short (capped for display). */
  atRisk: FleetImpactBooking[];
  /** How many trips are at risk in total, before the display cap. */
  atRiskTotal: number;
  /** True when the pool is inactive, so its capacity is not enforced at all. */
  poolInactive: boolean;
}

export interface FleetActionResult {
  ok: boolean;
  error?: string;
  /** Present when the write was refused because it would strand booked guests. */
  impact?: FleetImpact;
}

export interface FleetImpactResult {
  ok: boolean;
  error?: string;
  impact?: FleetImpact;
}

export interface MarkResourceDownInput {
  resourceId: string;
  units: number;
  reason: string;
  /** Operator-local YYYY-MM-DD the unit goes out of service. */
  fromISO: string;
  /** Optional operator-local YYYY-MM-DD it is expected back. */
  untilISO?: string | null;
  /**
   * Set only when the operator has SEEN the shortfall and chosen to proceed. A
   * dead engine is a fact, so we never block the write — but overselling a guest
   * off a boat has to be a decision somebody made, not a side effect. The server
   * re-computes the impact and refuses without this, which also closes the gap
   * between previewing and confirming.
   */
  acknowledgeOversell?: boolean;
}

/** How far ahead an open-ended outage is measured. */
const FLEET_HORIZON_DAYS = 90;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Seats a pool provides at a given out-of-service count (mirrors the API poolSeats). */
function seatsAt(quantity: number, seatCapacity: number, outOfService: number): number {
  return Math.max(0, quantity - outOfService) * seatCapacity;
}

/**
 * Peak concurrent seats across a set of half-open [start, end) reservations, plus the
 * moments where that peak exceeds `capacity`.
 *
 * Sorting releases before acquisitions at an identical instant is the whole point: a
 * 10:00–14:00 trip and a 14:00–18:00 trip on the same boat are back-to-back, not a
 * double-booking, and a naive sweep would report the fleet as one short and scare the
 * operator off a repair he needs to make.
 */
function peakOccupancy(
  spans: { startMs: number; endMs: number; seats: number }[],
  capacity: number,
): { peak: number; overWindows: { from: number; to: number }[] } {
  const events = spans.flatMap((s) => [
    { t: s.startMs, delta: s.seats },
    { t: s.endMs, delta: -s.seats },
  ]);
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);

  let running = 0;
  let peak = 0;
  const overWindows: { from: number; to: number }[] = [];

  for (let i = 0; i < events.length; i++) {
    running += events[i].delta;
    if (running > peak) peak = running;
    const next = events[i + 1]?.t;
    // Only score the gap once every event at this instant has been applied.
    if (next !== undefined && next > events[i].t && running > capacity) {
      overWindows.push({ from: events[i].t, to: next });
    }
  }

  return { peak, overWindows };
}

/** Display cap on the "call these guests" list; the count is still reported in full. */
const AT_RISK_SHOWN = 8;

/**
 * Work out what taking `units` out of a pool would cost, before anything is written.
 * Pure read, so the panel can call it as often as the form changes.
 */
async function fleetImpact(
  resourceId: string,
  units: number,
  fromISO: string,
  untilISO: string | null,
): Promise<FleetImpactResult> {
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  const resource = await db.resource.findFirst({
    where: { id: resourceId, operator_id: operatorId },
    select: {
      id: true,
      name: true,
      quantity: true,
      seat_capacity: true,
      out_of_service_qty: true,
      is_active: true,
    },
  });
  if (!resource) return { ok: false, error: 'That resource no longer exists.' };

  const inService = Math.max(0, resource.quantity - resource.out_of_service_qty);
  if (!Number.isInteger(units) || units < 1) {
    return { ok: false, error: 'Choose at least one unit to take out of service.' };
  }
  if (units > inService) {
    return {
      ok: false,
      error:
        inService === 0
          ? `Every ${resource.name} unit is already out of service.`
          : `Only ${inService} of ${resource.quantity} ${
              inService === 1 ? 'is' : 'are'
            } in service right now.`,
    };
  }
  if (!ISO_DATE.test(fromISO)) {
    return { ok: false, error: 'Pick the date it goes out of service.' };
  }
  if (untilISO && !ISO_DATE.test(untilISO)) {
    return { ok: false, error: 'That back-by date is not a date.' };
  }
  if (untilISO && untilISO < fromISO) {
    return { ok: false, error: 'The back-by date is before the day it goes out of service.' };
  }

  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';

  const { startUtc } = localDayRangeUtc(fromISO, timeZone);
  const endUtc = untilISO
    ? localDayRangeUtc(untilISO, timeZone).endUtc
    : new Date(startUtc.getTime() + FLEET_HORIZON_DAYS * 24 * 60 * 60 * 1000);

  const held = await db.resourceBooking.findMany({
    where: {
      resource_id: resource.id,
      // Half-open overlap, the same test the availability engine uses.
      starts_at: { lt: endUtc },
      ends_at: { gt: startUtc },
      order_item: { status: { not: 'CANCELLED' } },
    },
    select: {
      seats: true,
      starts_at: true,
      ends_at: true,
      order_item: {
        select: {
          id: true,
          activity: { select: { name_internal: true, name_external: true } },
          order: {
            select: {
              order_number: true,
              customer: { select: { first_name: true, last_name: true, phone: true } },
            },
          },
        },
      },
    },
    orderBy: { starts_at: 'asc' },
    // A ceiling so a pathological range cannot pull a whole season into memory.
    take: 2000,
  });

  const unitsDownAfter = resource.out_of_service_qty + units;
  const seatsBefore = seatsAt(
    resource.quantity,
    resource.seat_capacity,
    resource.out_of_service_qty,
  );
  const seatsAfter = seatsAt(resource.quantity, resource.seat_capacity, unitsDownAfter);

  const spans = held.map((h) => ({
    startMs: h.starts_at.getTime(),
    endMs: h.ends_at.getTime(),
    seats: h.seats,
  }));
  const { peak, overWindows } = peakOccupancy(spans, seatsAfter);

  const atRiskAll =
    overWindows.length === 0
      ? []
      : held.filter((h) =>
          overWindows.some((w) => h.starts_at.getTime() < w.to && h.ends_at.getTime() > w.from),
        );

  return {
    ok: true,
    impact: {
      resourceId: resource.id,
      resourceName: resource.name,
      unitsDownBefore: resource.out_of_service_qty,
      unitsDownAfter,
      seatsBefore,
      seatsAfter,
      fromISO,
      untilISO,
      openEnded: !untilISO,
      horizonDays: FLEET_HORIZON_DAYS,
      bookedTrips: held.length,
      peakSeats: peak,
      shortfallSeats: Math.max(0, peak - seatsAfter),
      atRisk: atRiskAll.slice(0, AT_RISK_SHOWN).map((h) => {
        const cust = h.order_item.order.customer;
        return {
          orderItemId: h.order_item.id,
          orderNumber: h.order_item.order.order_number,
          customerName: `${cust.first_name} ${cust.last_name}`.trim() || 'Guest',
          customerPhone: cust.phone ?? null,
          activityName:
            h.order_item.activity.name_internal || h.order_item.activity.name_external,
          startISO: h.starts_at.toISOString(),
          seats: h.seats,
        };
      }),
      atRiskTotal: atRiskAll.length,
      poolInactive: !resource.is_active,
    },
  };
}

/**
 * "What happens if I do this?" — the read the panel runs before it offers a confirm
 * button. Gated on the same permission as the write, so somebody who could never
 * commit the change cannot use the preview to enumerate the season's guests.
 */
export async function previewResourceDowntime(
  resourceId: string,
  units: number,
  fromISO: string,
  untilISO?: string | null,
): Promise<FleetImpactResult> {
  try {
    await requirePermission('operator:manage');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to change the fleet.' };
    }
    throw err;
  }
  if (!resourceId) return { ok: false, error: 'Missing resource.' };
  return fleetImpact(resourceId, units, fromISO, untilISO?.trim() || null);
}

/**
 * Take `units` out of service now, with a reason and an optional expected-back date.
 * The capacity change lands immediately; the reason and dates are recorded for the
 * panel caption and the audit log.
 */
export async function markResourceDown(input: MarkResourceDownInput): Promise<FleetActionResult> {
  let ctx;
  try {
    ctx = await requirePermission('operator:manage');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to change the fleet.' };
    }
    throw err;
  }

  const resourceId = input.resourceId?.trim();
  if (!resourceId) return { ok: false, error: 'Missing resource.' };

  const reason = (input.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'Say what is wrong with it — the crew reads this.' };
  if (reason.length > 200) return { ok: false, error: 'Keep the reason under 200 characters.' };

  const untilISO = input.untilISO?.trim() || null;

  // Re-run the impact server-side rather than trusting whatever the form last saw:
  // between previewing and confirming, somebody can have booked the last seat.
  const preview = await fleetImpact(resourceId, input.units, input.fromISO, untilISO);
  if (!preview.ok || !preview.impact) return { ok: false, error: preview.error };
  const impact = preview.impact;

  if (impact.shortfallSeats > 0 && !input.acknowledgeOversell) {
    return {
      ok: false,
      error: `That would leave ${impact.shortfallSeats} booked ${
        impact.shortfallSeats === 1 ? 'seat' : 'seats'
      } without a boat. Check who is affected, then confirm.`,
      impact,
    };
  }

  const db = await getTenantDb();
  const existing = await db.resource.findFirst({
    where: { id: resourceId, operator_id: ctx.operatorId },
    select: {
      name: true,
      quantity: true,
      seat_capacity: true,
      out_of_service_qty: true,
      is_active: true,
      activities: { select: { id: true } },
    },
  });
  if (!existing) return { ok: false, error: 'That resource no longer exists.' };

  // The one writer: the settings action, unchanged, with a different number in it.
  const saved = await updateResource(resourceId, {
    name: existing.name,
    quantity: existing.quantity,
    seat_capacity: existing.seat_capacity,
    out_of_service_qty: impact.unitsDownAfter,
    is_active: existing.is_active,
    activity_ids: existing.activities.map((a) => a.id),
  });
  if (!saved.ok) {
    const fieldError = saved.errors ? Object.values(saved.errors)[0] : undefined;
    return { ok: false, error: fieldError ?? saved.message ?? 'Could not take it out of service.' };
  }

  await recordFleetEvent({
    operatorId: ctx.operatorId,
    actor: ctx.auth.userId,
    actorRole: ctx.auth.role,
    action: 'resource.out_of_service',
    resourceId,
    before: { out_of_service_qty: impact.unitsDownBefore },
    after: {
      out_of_service_qty: impact.unitsDownAfter,
      units: input.units,
      reason,
      out_from: input.fromISO,
      expected_back: untilISO,
      seats_removed: impact.seatsBefore - impact.seatsAfter,
      bookings_at_risk: impact.atRiskTotal,
    },
  });

  revalidatePath('/manifest');
  return { ok: true };
}

/**
 * Put units back on the water. Returns them all by default — after a repair the
 * operator wants one tap, not arithmetic.
 */
export async function returnResourceToService(
  resourceId: string,
  units?: number,
): Promise<FleetActionResult> {
  let ctx;
  try {
    ctx = await requirePermission('operator:manage');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to change the fleet.' };
    }
    throw err;
  }

  if (!resourceId) return { ok: false, error: 'Missing resource.' };

  const db = await getTenantDb();
  const existing = await db.resource.findFirst({
    where: { id: resourceId, operator_id: ctx.operatorId },
    select: {
      name: true,
      quantity: true,
      seat_capacity: true,
      out_of_service_qty: true,
      is_active: true,
      activities: { select: { id: true } },
    },
  });
  if (!existing) return { ok: false, error: 'That resource no longer exists.' };
  // Idempotent: nothing is down, so there is nothing to bring back.
  if (existing.out_of_service_qty === 0) return { ok: true };

  const back =
    units === undefined
      ? existing.out_of_service_qty
      : Math.min(Math.max(Math.trunc(units), 1), existing.out_of_service_qty);
  const after = existing.out_of_service_qty - back;

  const saved = await updateResource(resourceId, {
    name: existing.name,
    quantity: existing.quantity,
    seat_capacity: existing.seat_capacity,
    out_of_service_qty: after,
    is_active: existing.is_active,
    activity_ids: existing.activities.map((a) => a.id),
  });
  if (!saved.ok) {
    const fieldError = saved.errors ? Object.values(saved.errors)[0] : undefined;
    return { ok: false, error: fieldError ?? saved.message ?? 'Could not put it back in service.' };
  }

  await recordFleetEvent({
    operatorId: ctx.operatorId,
    actor: ctx.auth.userId,
    actorRole: ctx.auth.role,
    action: 'resource.in_service',
    resourceId,
    before: { out_of_service_qty: existing.out_of_service_qty },
    after: { out_of_service_qty: after, units: back },
  });

  revalidatePath('/manifest');
  return { ok: true };
}

/**
 * Append one fleet event to the audit log.
 *
 * Never throws, for the reason apps/api/src/services/audit.ts never throws: a failed
 * audit insert must not undo a repair that already happened on the water. A lost row
 * is re-emitted to stderr under the same greppable prefix so it survives outside the
 * table.
 */
async function recordFleetEvent(event: {
  operatorId: string;
  actor: string;
  actorRole: string;
  action: 'resource.out_of_service' | 'resource.in_service';
  resourceId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}): Promise<void> {
  try {
    const db = await getTenantDb();
    await db.auditLog.create({
      data: {
        operator_id: event.operatorId,
        actor: event.actor || 'unknown',
        actor_role: event.actorRole || 'unknown',
        action: event.action,
        entity_type: 'Resource',
        entity_id: event.resourceId,
        before: event.before as Prisma.InputJsonValue,
        after: event.after as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] LOST EVENT', JSON.stringify(event), err);
  }
}
