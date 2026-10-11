/**
 * Waitlist service — "Sold out? We'll email you if a spot opens."
 *
 * A guest joins the waitlist for a genuinely full timeslot (public, rate-limited
 * route). When capacity frees on that slot — a cancellation or a reschedule-away —
 * the booking service fires {@link queueWaitlistNotifications}, which emails the
 * oldest PENDING entries a deep link to that activity/date/slot and flips them to
 * NOTIFIED. Deliberately simple (FareHarbor-parity without the overbuild):
 *
 *   - NO reservation hold and NO expiry timers — the email says plainly that the
 *     first to book wins;
 *   - notify once per entry: the status flip from PENDING is the claim, done with
 *     a guarded updateMany so two overlapping releases can't double-email;
 *   - the notify path is fire-and-forget off the money path — it can never block
 *     or fail a cancel/reschedule (same contract as dispatchBookingNotifications).
 */
import { forOperator } from '@marina/database';
import { sendWaitlistSpotOpen } from './notifications.js';
import { customerPortalBaseUrl } from './notification-data.js';
import { dayInTimezone } from './departures.js';
import { captureError } from './errors.js';

/** A typed, user-facing failure the route maps to a clean HTTP status. */
export class WaitlistError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'WaitlistError';
    this.code = code;
    this.status = status;
  }
}

export interface JoinWaitlistInput {
  timeslotId: string;
  name: string;
  email: string;
  phone?: string | null;
}

/**
 * Join the waitlist for a sold-out timeslot. Validates that the slot exists, is
 * still upcoming, and is actually full (a slot with room should be booked, not
 * waited on). Upserts on (operator, timeslot, email) so a double-tap or a repeat
 * visit never queues the same guest twice — the original place in line is kept.
 */
export async function joinWaitlist(operatorId: string, input: JoinWaitlistInput) {
  const db = forOperator(operatorId);
  const email = input.email.trim().toLowerCase();

  const slot = await db.timeslot.findUnique({
    where: { id: input.timeslotId },
    select: { id: true, datetime: true, status: true, capacity_total: true, capacity_booked: true },
  });
  if (!slot) {
    throw new WaitlistError('TIMESLOT_NOT_FOUND', 'That time could not be found', 404);
  }
  if (slot.status === 'CANCELLED') {
    throw new WaitlistError('TIMESLOT_CANCELLED', 'That time has been cancelled', 409);
  }
  if (slot.datetime.getTime() <= Date.now()) {
    throw new WaitlistError('TIMESLOT_PAST', 'That time has already started', 409);
  }
  if (slot.capacity_total - slot.capacity_booked > 0) {
    throw new WaitlistError(
      'SLOT_HAS_ROOM',
      'Good news — this time still has open spots. You can book it right now.',
      409,
    );
  }

  return db.waitlistEntry.upsert({
    where: {
      operator_id_timeslot_id_email: {
        operator_id: operatorId,
        timeslot_id: slot.id,
        email,
      },
    },
    // Already on the list: keep their place (created_at) and status; just
    // refresh the contact details they typed.
    update: { name: input.name.trim(), phone: input.phone?.trim() || null },
    create: {
      operator_id: operatorId,
      timeslot_id: slot.id,
      name: input.name.trim(),
      email,
      phone: input.phone?.trim() || null,
      status: 'PENDING',
    },
  });
}

export interface WaitlistNotifyResult {
  operatorId: string;
  /** Entries flipped PENDING → NOTIFIED across all the given slots. */
  notified: number;
}

/**
 * Email the oldest PENDING waitlist entries on each of the given timeslots, up to
 * the number of seats now open on that slot. Marks each entry NOTIFIED first (a
 * guarded status flip — the claim), then sends; a failed/unconfigured email never
 * un-claims, so an entry is emailed at most once. Safe to call with slots that
 * have no waitlist or no room — those are no-ops.
 */
export async function notifyWaitlistForTimeslots(
  operatorId: string,
  timeslotIds: string[],
): Promise<WaitlistNotifyResult> {
  const db = forOperator(operatorId);
  let notified = 0;

  for (const timeslotId of [...new Set(timeslotIds)]) {
    const slot = await db.timeslot.findUnique({
      where: { id: timeslotId },
      select: {
        id: true,
        datetime: true,
        status: true,
        capacity_total: true,
        capacity_booked: true,
        activity: {
          select: {
            id: true,
            name_external: true,
            operator: {
              select: {
                name_external: true,
                brand_color: true,
                logo_light_url: true,
                logo_dark_url: true,
                timezone: true,
              },
            },
            location: { select: { timezone: true } },
          },
        },
      },
    });
    if (!slot || slot.status === 'CANCELLED') continue;
    if (slot.datetime.getTime() <= Date.now()) continue;

    const openSeats = slot.capacity_total - slot.capacity_booked;
    if (openSeats <= 0) continue;

    const pending = await db.waitlistEntry.findMany({
      where: { timeslot_id: slot.id, status: 'PENDING' },
      orderBy: { created_at: 'asc' },
      take: openSeats,
      select: { id: true, name: true, email: true },
    });
    if (pending.length === 0) continue;

    const operator = slot.activity.operator;
    const timezone = slot.activity.location?.timezone ?? operator.timezone ?? 'America/Los_Angeles';
    const dateISO = dayInTimezone(slot.datetime, timezone);
    // The activity-page deep link the departures board already uses:
    // ?date=&slot= preselects the day and time, so the guest is two taps from
    // checkout (BookingWidget adopts the params and validates live capacity).
    const bookingUrl =
      `${customerPortalBaseUrl()}/activities/${encodeURIComponent(slot.activity.id)}` +
      `?date=${encodeURIComponent(dateISO)}&slot=${encodeURIComponent(slot.id)}`;

    for (const entry of pending) {
      // CLAIM before sending: only the sweep that flips PENDING → NOTIFIED gets
      // to email this entry, so overlapping releases can't double-notify.
      const claimed = await db.waitlistEntry.updateMany({
        where: { id: entry.id, status: 'PENDING' },
        data: { status: 'NOTIFIED', notified_at: new Date() },
      });
      if (claimed.count === 0) continue;
      notified += 1;

      // sendWaitlistSpotOpen never throws and no-ops without an email provider —
      // the NOTIFIED flip above is still the system of record either way.
      await sendWaitlistSpotOpen({
        operatorId,
        brand: {
          name_external: operator.name_external,
          brand_color: operator.brand_color,
          logo_light_url: operator.logo_light_url,
          logo_dark_url: operator.logo_dark_url,
        },
        guestName: entry.name,
        guestEmail: entry.email,
        activityName: slot.activity.name_external,
        slotDatetime: slot.datetime,
        timezone,
        bookingUrl,
      });
    }
  }

  return { operatorId, notified };
}

/**
 * Fire-and-forget wrapper the booking service calls after a cancel/reschedule
 * COMMITS. Never blocks or throws into the money path: failures go to the error
 * sink (nobody awaits this, so a silent failure would otherwise be invisible).
 */
export function queueWaitlistNotifications(operatorId: string, timeslotIds: string[]): void {
  if (timeslotIds.length === 0) return;
  void notifyWaitlistForTimeslots(operatorId, timeslotIds).catch(async (err) => {
    await captureError(err, {
      operatorId,
      route: 'waitlist.queueWaitlistNotifications',
      extra: { timeslot_ids: timeslotIds },
    });
  });
}
