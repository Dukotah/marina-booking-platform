'use server';

/**
 * Server actions for the lightweight customer account area.
 *
 * There is no heavy customer auth yet. Bookings are looked up by the public
 * order number combined with the email on the order — a magic-link stub. The
 * order endpoint is public-by-number (see apps/api orders route), so we verify
 * the supplied email matches the order's customer email here before exposing any
 * booking details. This is intentionally light; a real magic-link/OTP flow is a
 * followup (see slice notes).
 */

import {
  getOrder,
  getAvailability,
  selfReschedule,
  isApiError,
  type AvailabilitySlot,
  type OrderSummary,
} from '@/lib/api';

/** Normalize an email for comparison (trim + lowercase). */
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Minimal email shape check — the order endpoint is the real gate. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export interface LookupSuccess {
  ok: true;
  /** Order number, echoed for building the bookings link. */
  orderNumber: string;
  /** Normalized email, echoed for building the bookings link. */
  email: string;
}

export interface LookupFailure {
  ok: false;
  /** Human-readable, customer-safe message. */
  error: string;
}

export type LookupResult = LookupSuccess | LookupFailure;

/**
 * Look up a booking by order number + email. Returns a redirect-friendly result
 * rather than throwing, so the form can render a friendly message inline.
 *
 * We deliberately return the SAME message for "no such order" and "email does
 * not match" so the form can't be used to probe which order numbers exist.
 */
export async function lookupBooking(
  _prev: LookupResult | null,
  formData: FormData,
): Promise<LookupResult> {
  const orderNumberRaw = String(formData.get('orderNumber') ?? '');
  const emailRaw = String(formData.get('email') ?? '');

  const orderNumber = orderNumberRaw.trim().toUpperCase();
  const email = normalizeEmail(emailRaw);

  if (!orderNumber) {
    return { ok: false, error: 'Enter your confirmation (order) number.' };
  }
  if (!looksLikeEmail(email)) {
    return { ok: false, error: 'Enter the email address used for the booking.' };
  }

  const notFound: LookupFailure = {
    ok: false,
    error:
      'We could not find a booking matching that order number and email. Double-check both and try again.',
  };

  let order: OrderSummary;
  try {
    order = await getOrder(orderNumber);
  } catch (err) {
    if (isApiError(err) && err.status === 404) return notFound;
    if (isApiError(err) && err.status === 0) {
      return {
        ok: false,
        error: 'We could not reach the booking system. Please try again in a moment.',
      };
    }
    return notFound;
  }

  if (normalizeEmail(order.customerEmail) !== email) {
    return notFound;
  }

  return { ok: true, orderNumber: order.orderNumber, email };
}

/**
 * Bookable slots for an activity on a given day (operator-local YYYY-MM-DD), for the
 * self-service reschedule picker. Drops full slots and anything already past.
 */
export async function fetchRescheduleSlots(
  activityId: string,
  isoDate: string,
): Promise<{ ok: true; slots: AvailabilitySlot[] } | { ok: false; error: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return { ok: false, error: 'Please choose a valid date.' };
  }
  try {
    const day = await getAvailability(activityId, isoDate);
    const now = Date.now();
    const slots = day.slots.filter(
      (s) => s.status !== 'FULL' && s.capacityRemaining > 0 && new Date(s.datetime).getTime() > now,
    );
    return { ok: true, slots };
  } catch (err) {
    return {
      ok: false,
      error: isApiError(err) ? err.message : 'We could not load times for that day.',
    };
  }
}

/**
 * Move the booking to a new timeslot via the email-gated self-service endpoint.
 * Identity (order number + email) is re-checked server-side by the API.
 */
export async function rescheduleBookingAction(
  orderNumber: string,
  email: string,
  timeslotId: string,
  orderItemId?: string,
): Promise<{ ok: true; order: OrderSummary } | { ok: false; error: string }> {
  try {
    const order = await selfReschedule(orderNumber, email, timeslotId, orderItemId);
    return { ok: true, order };
  } catch (err) {
    return {
      ok: false,
      error: isApiError(err)
        ? err.message
        : 'We could not reschedule your booking. Please try again.',
    };
  }
}
