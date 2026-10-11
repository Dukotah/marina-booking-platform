'use server';

import { revalidatePath } from 'next/cache';
import { withTenant, materializeActivitySchedule, type Prisma } from '@marina/database';
import { AuthorizationError } from '@marina/auth';
import { verifyCheckinToken } from '@marina/core/checkin-token';
import { getOperatorContext, getTenantDb, requirePermission } from '../../lib/session';
import { addIsoDays, localDayRangeUtc, todayIsoIn } from '../../components/manifest/tz';
import { readFleetOutages } from './data';

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
 * Check a guest in from a scanned confirmation QR. The QR encodes an HMAC-signed
 * token (@marina/core signCheckinToken) naming the order + item; the staff "Scan"
 * entry point hands the decoded token string here. We verify the signature
 * (rejecting any tampered/forged token), resolve the named item inside this
 * operator's tenant scope, and route to the SAME check-in write the manifest tap
 * uses — so the scan path and the tap path can never diverge.
 */
export async function checkInByScannedToken(token: string): Promise<CheckInResult> {
  if (!token || !token.trim()) return { ok: false, error: 'No check-in code scanned.' };

  const verified = verifyCheckinToken(token.trim());
  if (!verified) return { ok: false, error: 'That is not a valid check-in code.' };
  if (!verified.signatureValid) {
    // Tampered or foreign-key token — refuse before trusting the named item.
    return { ok: false, error: 'This check-in code failed verification.' };
  }

  const { on: orderNumber, iid: orderItemId } = verified.payload;

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to check guests in.' };
  }

  // Confirm the token's item actually belongs to this operator + order number
  // (tenant-scoped read) before routing to the shared check-in write.
  const db = await getTenantDb();
  const match = await db.orderItem.findFirst({
    where: { id: orderItemId, order: { order_number: orderNumber } },
    select: { id: true },
  });
  if (!match) return { ok: false, error: 'Booking not found for this check-in code.' };

  return checkInOrderItem(orderItemId);
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
// Per-slot BULK status ops + broadcast
//
// "Check in everyone on the 9am", "the whole 2pm pontoon no-showed", and "text
// every guest on this departure we're on a weather hold". The two status ops are
// direct tenant-scoped writes (a NARROW updateMany: this timeslot + the one
// status that can transition, so nothing on another slot or already past can be
// swept). The broadcast goes through the API (which owns Resend + Twilio), the
// same split the waitlist notify uses.
// ===========================================================================

export interface BulkStatusResult {
  ok: boolean;
  error?: string;
  /** How many bookings actually transitioned (already-done ones aren't counted twice). */
  updated?: number;
}

/**
 * Check in every UPCOMING booking on a timeslot in one write. Narrow where:
 * (timeslot_id, status=UPCOMING) on the RLS client — only live, not-yet-arrived
 * seats on THIS slot flip, never a cancelled/no-show seat and never another slot.
 * Idempotent: a slot with nobody upcoming updates 0 and still succeeds.
 */
export async function checkInAllOnTimeslot(timeslotId: string): Promise<BulkStatusResult> {
  if (!timeslotId) return { ok: false, error: 'Missing timeslot id' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to check guests in.' };
  }

  const db = await getTenantDb();
  const slot = await db.timeslot.findUnique({ where: { id: timeslotId }, select: { id: true } });
  if (!slot) return { ok: false, error: 'Timeslot not found.' };

  const affected = await db.orderItem.findMany({
    where: { timeslot_id: timeslotId, status: 'UPCOMING' },
    select: { id: true, order_id: true },
  });
  if (affected.length === 0) {
    revalidatePath('/manifest');
    return { ok: true, updated: 0 };
  }

  const res = await db.orderItem.updateMany({
    where: { timeslot_id: timeslotId, status: 'UPCOMING' },
    data: { status: 'CHECKED_IN' },
  });

  // One audit event per affected order so "who checked everyone in" is recoverable,
  // mirroring the single-item path. Best-effort: a failed audit must not undo the
  // status change the staffer already saw land.
  await Promise.all(
    affected.map((item) =>
      db.orderEvent
        .create({
          data: {
            operator_id: auth.operatorId,
            order_id: item.order_id,
            type: 'CHECK_IN',
            description: 'Guest checked in via bulk check-in from the manifest',
            actor: auth.userId,
          },
        })
        .catch((err) => console.error('[manifest] bulk check-in audit failed:', err)),
    ),
  );

  revalidatePath('/manifest');
  revalidatePath('/calendar');
  return { ok: true, updated: res.count };
}

/**
 * Mark every still-UPCOMING booking on a timeslot a no-show in one write. Same
 * narrow where as the bulk check-in (only UPCOMING seats on this slot), so a
 * guest already checked in is never swept into a no-show. Idempotent.
 */
export async function noShowAllOnTimeslot(timeslotId: string): Promise<BulkStatusResult> {
  if (!timeslotId) return { ok: false, error: 'Missing timeslot id' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to modify the manifest.' };
  }

  const db = await getTenantDb();
  const slot = await db.timeslot.findUnique({ where: { id: timeslotId }, select: { id: true } });
  if (!slot) return { ok: false, error: 'Timeslot not found.' };

  const affected = await db.orderItem.findMany({
    where: { timeslot_id: timeslotId, status: 'UPCOMING' },
    select: { id: true, order_id: true },
  });
  if (affected.length === 0) {
    revalidatePath('/manifest');
    return { ok: true, updated: 0 };
  }

  const res = await db.orderItem.updateMany({
    where: { timeslot_id: timeslotId, status: 'UPCOMING' },
    data: { status: 'NO_SHOW' },
  });

  await Promise.all(
    affected.map((item) =>
      db.orderEvent
        .create({
          data: {
            operator_id: auth.operatorId,
            order_id: item.order_id,
            type: 'NO_SHOW',
            description: 'Marked no-show via bulk no-show from the manifest',
            actor: auth.userId,
          },
        })
        .catch((err) => console.error('[manifest] bulk no-show audit failed:', err)),
    ),
  );

  revalidatePath('/manifest');
  revalidatePath('/calendar');
  return { ok: true, updated: res.count };
}

export interface BroadcastResult {
  ok: boolean;
  error?: string;
  /** Guests the message was addressed to. */
  recipients?: number;
  /** Of those, how many had at least one channel actually dispatch. */
  delivered?: number;
}

/**
 * Broadcast a staff-authored message to every live booking on a timeslot. Calls
 * the API (which owns Resend + Twilio + the message choke points) with the trusted
 * server-to-server x-operator-id header, matching notifyWaitlistAction. Email is
 * the default channel; SMS is opt-in (only reaches guests with a phone on file).
 */
export async function broadcastToTimeslotAction(input: {
  timeslotId: string;
  body: string;
  email?: boolean;
  sms?: boolean;
  subject?: string;
}): Promise<BroadcastResult> {
  if (!input.timeslotId) return { ok: false, error: 'Missing timeslot id' };
  if (!input.body?.trim()) return { ok: false, error: 'Write the message first.' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to message guests.' };
  }

  const base = (process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(
    /\/+$/,
    '',
  );
  if (!base) return { ok: false, error: 'The messaging service is not configured.' };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-operator-id': auth.operatorId,
  };
  if (process.env.REQUIRE_CLERK_AUTH !== 'true') {
    headers['x-dev-staff-id'] = auth.userId;
  }
  if (process.env.INTERNAL_API_TOKEN) {
    headers.authorization = `Bearer ${process.env.INTERNAL_API_TOKEN}`;
  }

  try {
    const res = await fetch(
      `${base}/api/timeslots/${encodeURIComponent(input.timeslotId)}/broadcast`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          body: input.body,
          email: input.email ?? true,
          sms: input.sms ?? false,
          ...(input.subject?.trim() ? { subject: input.subject.trim() } : {}),
        }),
        cache: 'no-store',
      },
    );

    if (res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { recipients?: number; delivered?: number }
        | null;
      return { ok: true, recipients: body?.recipients ?? 0, delivered: body?.delivered ?? 0 };
    }

    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: body?.error ?? `Could not send the message (${res.status}).` };
  } catch (err) {
    console.error('[manifest] broadcastToTimeslotAction failed:', err);
    return { ok: false, error: 'Could not reach the messaging service. Please try again.' };
  }
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
// Waitlist — remove a guest from a sold-out slot's list, and hand-trigger the
// "a spot opened" notify sweep when staff free a seat directly from the dock.
//
// Removal is a direct tenant-scoped DB delete (mirrors unassignGuideAction):
// the narrow `where: { id }` runs through the RLS client, so one operator can
// never delete another's entry, and it is idempotent (missing → ok). Notify
// goes through the API — which owns Resend + the email templates (D-007) —
// reusing the same notifyWaitlistForTimeslots sweep the booking service fires on
// a capacity release.
// ===========================================================================

export interface WaitlistActionResult {
  ok: boolean;
  error?: string;
  /** Entries emailed by a notify sweep (0 when the slot has no room / none waiting). */
  notified?: number;
}

/** Remove one waitlist entry by id. Tenant-scoped, idempotent (missing → ok). */
export async function removeWaitlistEntryAction(entryId: string): Promise<WaitlistActionResult> {
  if (!entryId) return { ok: false, error: 'Missing waitlist entry id' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to manage the waitlist.' };
  }

  const db = await getTenantDb();
  const existing = await db.waitlistEntry.findUnique({
    where: { id: entryId },
    select: { id: true },
  });
  if (existing) await db.waitlistEntry.delete({ where: { id: existing.id } });

  revalidatePath('/manifest');
  return { ok: true };
}

/**
 * Hand-trigger the "a spot opened" sweep for a slot: email the oldest PENDING
 * entries up to the seats now open. Calls the API (which owns Resend + the email
 * templates) with the trusted server-to-server x-operator-id header, matching the
 * existing admin → API actions (see app/orders/actions.ts internalApiHeaders).
 * Never double-notifies — the service claims each entry before sending.
 */
export async function notifyWaitlistAction(timeslotId: string): Promise<WaitlistActionResult> {
  if (!timeslotId) return { ok: false, error: 'Missing timeslot id' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to manage the waitlist.' };
  }

  const base = (process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(
    /\/+$/,
    '',
  );
  if (!base) return { ok: false, error: 'The booking service is not configured.' };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-operator-id': auth.operatorId,
  };
  if (process.env.REQUIRE_CLERK_AUTH !== 'true') {
    headers['x-dev-staff-id'] = auth.userId;
  }
  if (process.env.INTERNAL_API_TOKEN) {
    headers.authorization = `Bearer ${process.env.INTERNAL_API_TOKEN}`;
  }

  try {
    const res = await fetch(`${base}/api/waitlist/notify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ timeslotId }),
      cache: 'no-store',
    });

    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { notified?: number } | null;
      revalidatePath('/manifest');
      return { ok: true, notified: body?.notified ?? 0 };
    }

    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: body?.error ?? `Could not notify the waitlist (${res.status}).` };
  } catch (err) {
    console.error('[manifest] notifyWaitlistAction failed:', err);
    return { ok: false, error: 'Could not reach the booking service. Please try again.' };
  }
}

// ===========================================================================
// Fleet status — take a SPECIFIC boat out of service, and bring it back
//
// Each Activity here IS one physical thing (the "10-Person Pontoon", the
// Canoe, the Bar Patio), so fleet status operates per-activity instead of on
// pooled Resource counts (which named no boat and offered no selection —
// pools stay manageable under Settings → Resources for genuinely shared gear).
//
// MECHANISM (the "out" write, one transaction):
//  1. Activity-scoped BlackoutDate rows for every day in the outage window.
//     The customer availability engine already drops any slot on a blacked-out
//     day, and the schedule materializer never generates into one ("blackout
//     wins" — packages/database/src/schedule.ts), so the window is closed for
//     rule-generated AND seeded slots alike, including slots that do not exist
//     yet when the rolling horizon advances.
//  2. Every future UNBOOKED timeslot in the window (any origin, capacity_booked
//     = 0, not already CANCELLED) is flipped to status CANCELLED — defence in
//     depth for direct-booking paths that check slot status rather than
//     blackouts, and what makes the admin calendar/manifest reflect it. Booked
//     slots are NEVER touched; the impact preview lists those guests instead.
//  3. One AuditLog row (`fleet.out_of_service`, entity Activity) recording the
//     reason/window AND the exact BlackoutDate ids + Timeslot ids written.
//
// RESTORE CONTRACT ("back in service", one transaction):
//  - delete exactly the BlackoutDate ids the outage created (never someone
//    else's closures for the same days);
//  - flip exactly the recorded Timeslot ids back to AVAILABLE, but only where
//    still CANCELLED, still unbooked, and still in the future (the past is
//    never rewritten — a departure that was closed and has sailed stays
//    closed history);
//  - re-materialize the activity's schedule rules (if any) inside the same
//    transaction, so rule-generated slots a nightly sweep DELETED during the
//    outage are recreated;
//  - one `fleet.back_in_service` AuditLog row with what was restored.
//
// The audit row is written INSIDE the transaction, unlike the fire-and-forget
// audit writes elsewhere: it carries the restore payload, so an outage without
// its audit row would be irreversible — better to fail the whole action and
// let the operator tap again.
// ===========================================================================

/** How far ahead an open-ended outage blacks out and is measured. */
const FLEET_HORIZON_DAYS = 90;

/** Hard ceiling on a dated outage window (a longer one is a season, not a repair). */
const MAX_FLEET_WINDOW_DAYS = 180;

/** Display cap on the "call these guests" list; the count is reported in full. */
const GUESTS_SHOWN = 8;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A booked trip on this boat inside the outage window — somebody to ring. */
export interface BoatImpactBooking {
  orderItemId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string | null;
  /** ISO start instant; rendered in the operator's locale by the client. */
  startISO: string;
  seats: number;
}

/** What taking this boat out for the window would do, computed BEFORE any write. */
export interface BoatImpact {
  activityId: string;
  activityName: string;
  /** Effective window as operator-local calendar days (from is clamped to today). */
  fromISO: string;
  untilISO: string | null;
  openEnded: boolean;
  horizonDays: number;
  /** Future unbooked departures that will be withdrawn from sale. */
  slotsToClose: number;
  /** Booked trips inside the window — every one is a guest without a boat. */
  bookedTrips: number;
  guests: BoatImpactBooking[];
  guestsTotal: number;
  /** True when an active repeating schedule also stops generating in the window. */
  hasActiveRule: boolean;
}

export interface BoatImpactResult {
  ok: boolean;
  error?: string;
  impact?: BoatImpact;
}

export interface BoatFleetActionResult {
  ok: boolean;
  error?: string;
  /** Present when the write was refused so the operator can see who is stranded. */
  impact?: BoatImpact;
}

export interface TakeBoatOutInput {
  activityId: string;
  reason: string;
  /** Operator-local YYYY-MM-DD the boat goes out of service. */
  fromISO: string;
  /** Optional operator-local YYYY-MM-DD it is expected back (inclusive). */
  untilISO?: string | null;
  /**
   * Set only when the operator has SEEN the booked trips in the window and
   * chosen to proceed. A dead engine is a fact, so the write is never blocked —
   * but stranding a booked guest has to be a decision somebody made, not a side
   * effect. The server re-computes the impact and refuses without this.
   */
  acknowledgeBookings?: boolean;
}

interface OutageWindow {
  timeZone: string;
  todayISO: string;
  /** Effective first day — the requested from, clamped to today. */
  fromISO: string;
  untilISO: string | null;
  /** Every operator-local day the outage covers (inclusive). */
  days: string[];
  /** UTC instants bounding the window, for slot queries. */
  startUtc: Date;
  endUtc: Date;
}

/** Resolve and validate the outage window. Returns a string error for the form. */
async function resolveOutageWindow(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  operatorId: string,
  fromISO: string,
  untilISO: string | null,
): Promise<OutageWindow | { error: string }> {
  if (!ISO_DATE.test(fromISO)) return { error: 'Pick the date it goes out of service.' };
  if (untilISO && !ISO_DATE.test(untilISO)) return { error: 'That back-by date is not a date.' };
  if (untilISO && untilISO < fromISO) {
    return { error: 'The back-by date is before the day it goes out of service.' };
  }

  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { timezone: true },
  });
  const timeZone = operator?.timezone ?? 'America/Los_Angeles';
  const todayISO = todayIsoIn(timeZone);

  if (untilISO && untilISO < todayISO) {
    return { error: 'That window has already passed — nothing left to close.' };
  }
  // A from-date in the past means "it is already broken": the days that matter
  // start today. YYYY-MM-DD compares lexicographically = chronologically.
  const effectiveFrom = fromISO < todayISO ? todayISO : fromISO;
  const lastDay = untilISO ?? addIsoDays(effectiveFrom, FLEET_HORIZON_DAYS - 1);

  const days: string[] = [];
  for (let iso = effectiveFrom; iso <= lastDay; iso = addIsoDays(iso, 1)) {
    days.push(iso);
    if (days.length > MAX_FLEET_WINDOW_DAYS) {
      return {
        error: `That is more than ${MAX_FLEET_WINDOW_DAYS} days. For a boat that is gone for the season, deactivate the listing instead.`,
      };
    }
  }

  return {
    timeZone,
    todayISO,
    fromISO: effectiveFrom,
    untilISO,
    days,
    startUtc: localDayRangeUtc(effectiveFrom, timeZone).startUtc,
    endUtc: localDayRangeUtc(lastDay, timeZone).endUtc,
  };
}

/**
 * Work out what taking this boat out for the window would cost, before anything
 * is written. Pure read, so the panel can call it as often as the form changes.
 */
async function boatImpact(
  activityId: string,
  fromISO: string,
  untilISO: string | null,
): Promise<BoatImpactResult> {
  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  const activity = await db.activity.findFirst({
    where: { id: activityId, operator_id: operatorId },
    select: {
      id: true,
      name_internal: true,
      name_external: true,
      schedule_rules: { select: { is_active: true } },
    },
  });
  if (!activity) return { ok: false, error: 'That boat no longer exists.' };

  const window = await resolveOutageWindow(db, operatorId, fromISO, untilISO);
  if ('error' in window) return { ok: false, error: window.error };

  // Only the future can be closed or stranded: a window that starts today still
  // begins at "now", not at midnight that already happened.
  const now = new Date();
  const rangeStart = window.startUtc > now ? window.startUtc : now;

  const [slotsToClose, booked] = await Promise.all([
    db.timeslot.count({
      where: {
        activity_id: activity.id,
        datetime: { gte: rangeStart, lt: window.endUtc },
        status: { not: 'CANCELLED' },
        capacity_booked: 0,
      },
    }),
    db.orderItem.findMany({
      where: {
        activity_id: activity.id,
        status: { not: 'CANCELLED' },
        timeslot: { datetime: { gte: rangeStart, lt: window.endUtc } },
      },
      select: {
        id: true,
        quantity: true,
        timeslot: { select: { datetime: true } },
        order: {
          select: {
            order_number: true,
            customer: { select: { first_name: true, last_name: true, phone: true } },
          },
        },
      },
      orderBy: { timeslot: { datetime: 'asc' } },
      // Ceiling so a pathological window cannot pull a whole season into memory.
      take: 500,
    }),
  ]);

  return {
    ok: true,
    impact: {
      activityId: activity.id,
      activityName: activity.name_internal || activity.name_external,
      fromISO: window.fromISO,
      untilISO: window.untilISO,
      openEnded: !window.untilISO,
      horizonDays: FLEET_HORIZON_DAYS,
      slotsToClose,
      bookedTrips: booked.length,
      guestsTotal: booked.length,
      guests: booked.slice(0, GUESTS_SHOWN).map((b) => {
        const cust = b.order.customer;
        return {
          orderItemId: b.id,
          orderNumber: b.order.order_number,
          customerName: `${cust.first_name} ${cust.last_name}`.trim() || 'Guest',
          customerPhone: cust.phone ?? null,
          startISO: b.timeslot.datetime.toISOString(),
          seats: b.quantity,
        };
      }),
      hasActiveRule: activity.schedule_rules.some((r) => r.is_active),
    },
  };
}

/**
 * "What happens if I do this?" — the read the panel runs before it offers a
 * confirm button. Gated on the same permission as the write, so somebody who
 * could never commit the change cannot use the preview to enumerate guests.
 */
export async function previewBoatDowntime(
  activityId: string,
  fromISO: string,
  untilISO?: string | null,
): Promise<BoatImpactResult> {
  try {
    await requirePermission('operator:manage');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to change the fleet.' };
    }
    throw err;
  }
  if (!activityId) return { ok: false, error: 'Missing boat.' };
  return boatImpact(activityId, fromISO, untilISO?.trim() || null);
}

/**
 * Take one specific boat out of service for a window. See the mechanism and
 * restore contract at the top of this section. The availability change lands
 * the moment the transaction commits: those days stop being sellable online.
 */
export async function takeBoatOutOfService(
  input: TakeBoatOutInput,
): Promise<BoatFleetActionResult> {
  let ctx;
  try {
    ctx = await requirePermission('operator:manage');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to change the fleet.' };
    }
    throw err;
  }

  const activityId = input.activityId?.trim();
  if (!activityId) return { ok: false, error: 'Missing boat.' };

  const reason = (input.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'Say what is wrong with it — the crew reads this.' };
  if (reason.length > 200) return { ok: false, error: 'Keep the reason under 200 characters.' };

  const untilISO = input.untilISO?.trim() || null;

  const db = await getTenantDb();
  const window = await resolveOutageWindow(db, ctx.operatorId, input.fromISO, untilISO);
  if ('error' in window) return { ok: false, error: window.error };

  // One outage at a time per boat keeps the restore payload unambiguous: the
  // newest fleet event IS the state. Bring it back before marking it out again.
  const outages = await readFleetOutages(db, window.todayISO);
  if (outages.has(activityId)) {
    return {
      ok: false,
      error: 'That boat is already out of service. Bring it back in first, then mark the new window.',
    };
  }

  // Re-run the impact server-side rather than trusting whatever the form last
  // saw: between previewing and confirming, somebody can have booked a trip.
  const preview = await boatImpact(activityId, input.fromISO, untilISO);
  if (!preview.ok || !preview.impact) return { ok: false, error: preview.error };
  const impact = preview.impact;

  if (impact.bookedTrips > 0 && !input.acknowledgeBookings) {
    return {
      ok: false,
      error: `${impact.bookedTrips} booked ${
        impact.bookedTrips === 1 ? 'trip falls' : 'trips fall'
      } in that window. Check who is affected, then confirm.`,
      impact,
    };
  }

  const now = new Date();
  const rangeStart = window.startUtc > now ? window.startUtc : now;

  await withTenant(ctx.operatorId, async (tx) => {
    // Days already closed for this boat (an operator blackout, say) are left
    // alone — the outage only ever owns rows it created, so restoring it can
    // never quietly re-open somebody else's closure.
    const existing = await tx.blackoutDate.findMany({
      where: {
        activity_id: activityId,
        date: {
          gte: new Date(`${window.days[0]}T00:00:00.000Z`),
          lte: new Date(`${window.days[window.days.length - 1]}T00:00:00.000Z`),
        },
      },
      select: { date: true },
    });
    const have = new Set(existing.map((b) => b.date.toISOString().slice(0, 10)));
    const created = await tx.blackoutDate.createManyAndReturn({
      data: window.days
        .filter((iso) => !have.has(iso))
        .map((iso) => ({
          operator_id: ctx.operatorId,
          activity_id: activityId,
          date: new Date(`${iso}T00:00:00.000Z`),
          // Human-readable on every surface that shows blackouts; the outage
          // itself is tracked by id in the audit row, never by this string.
          reason: `Out of service — ${reason}`,
        })),
      select: { id: true },
    });

    // Close the future, unbooked departures in the window — reversibly (a
    // status flip the restore path can undo), never a delete. Booked slots are
    // untouched: the guests on them are the impact list, not collateral.
    const toClose = await tx.timeslot.findMany({
      where: {
        activity_id: activityId,
        datetime: { gte: rangeStart, lt: window.endUtc },
        status: { not: 'CANCELLED' },
        capacity_booked: 0,
      },
      select: { id: true },
    });
    const closedIds = toClose.map((s) => s.id);
    if (closedIds.length > 0) {
      await tx.timeslot.updateMany({
        where: { id: { in: closedIds } },
        data: { status: 'CANCELLED' },
      });
    }

    // The load-bearing audit row (see section comment): it carries the restore
    // payload, so it commits or the outage does not happen.
    await tx.auditLog.create({
      data: {
        operator_id: ctx.operatorId,
        actor: ctx.auth.userId || 'unknown',
        actor_role: ctx.auth.role || 'unknown',
        action: 'fleet.out_of_service',
        entity_type: 'Activity',
        entity_id: activityId,
        before: { in_service: true } as Prisma.InputJsonValue,
        after: {
          in_service: false,
          reason,
          out_from: window.fromISO,
          expected_back: window.untilISO,
          blackout_ids: created.map((b) => b.id),
          closed_slot_ids: closedIds,
          booked_trips_in_window: impact.bookedTrips,
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  });

  revalidatePath('/manifest');
  revalidatePath('/calendar');
  revalidatePath(`/activities/${activityId}`);
  return { ok: true };
}

/**
 * Put a boat back on the water. Exactly reverses the recorded outage — see the
 * restore contract in the section comment. Idempotent: no active outage means
 * nothing is enforced, so there is nothing to do.
 */
export async function bringBoatBackInService(activityId: string): Promise<BoatFleetActionResult> {
  let ctx;
  try {
    ctx = await requirePermission('operator:manage');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to change the fleet.' };
    }
    throw err;
  }

  if (!activityId) return { ok: false, error: 'Missing boat.' };

  const db = await getTenantDb();
  const activity = await db.activity.findFirst({
    where: { id: activityId, operator_id: ctx.operatorId },
    select: { id: true, schedule_rules: { where: { is_active: true }, select: { id: true } } },
  });
  if (!activity) return { ok: false, error: 'That boat no longer exists.' };

  const operator = await db.operator.findUnique({
    where: { id: ctx.operatorId },
    select: { timezone: true },
  });
  const todayISO = todayIsoIn(operator?.timezone ?? 'America/Los_Angeles');

  const outage = (await readFleetOutages(db, todayISO)).get(activityId);
  // Idempotent: nothing recorded as out (or the window already passed on its
  // own, which un-enforces everything) — nothing to bring back.
  if (!outage) return { ok: true };

  const hasActiveRule = activity.schedule_rules.length > 0;

  await withTenant(ctx.operatorId, async (tx) => {
    // Re-open exactly what the outage closed, where it is still safe: still
    // CANCELLED (the operator may have re-opened one by hand), still unbooked,
    // and still in the future — a closed departure that has sailed is history.
    let reopened = 0;
    if (outage.closedSlotIds.length > 0) {
      const res = await tx.timeslot.updateMany({
        where: {
          id: { in: outage.closedSlotIds },
          activity_id: activityId,
          status: 'CANCELLED',
          capacity_booked: 0,
          datetime: { gte: new Date() },
        },
        data: { status: 'AVAILABLE' },
      });
      reopened = res.count;
    }

    // Delete exactly the blackout rows the outage created (by id — never by
    // date, which could take an unrelated closure with it).
    let blackoutsRemoved = 0;
    if (outage.blackoutIds.length > 0) {
      const res = await tx.blackoutDate.deleteMany({
        where: { id: { in: outage.blackoutIds }, activity_id: activityId },
      });
      blackoutsRemoved = res.count;
    }

    // Rule-backed boats: a nightly materializer sweep may have DELETED (not
    // just closed) rule-generated slots on the blacked-out days. With the
    // blackouts gone, re-materializing recreates them; it is idempotent and a
    // no-op when the sweep never ran. Same transaction = the restore is atomic.
    if (hasActiveRule) {
      await materializeActivitySchedule(tx, { operatorId: ctx.operatorId, activityId });
    }

    // The closing audit row — what flipped back, and that the state is now in.
    await tx.auditLog.create({
      data: {
        operator_id: ctx.operatorId,
        actor: ctx.auth.userId || 'unknown',
        actor_role: ctx.auth.role || 'unknown',
        action: 'fleet.back_in_service',
        entity_type: 'Activity',
        entity_id: activityId,
        before: {
          in_service: false,
          reason: outage.reason,
          out_from: outage.fromISO,
          expected_back: outage.untilISO,
        } as Prisma.InputJsonValue,
        after: {
          in_service: true,
          reopened_slots: reopened,
          blackouts_removed: blackoutsRemoved,
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  });

  revalidatePath('/manifest');
  revalidatePath('/calendar');
  revalidatePath(`/activities/${activityId}`);
  return { ok: true };
}
