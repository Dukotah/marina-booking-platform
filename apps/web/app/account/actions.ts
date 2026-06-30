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
  rescheduleBooking,
  isApiError,
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

// ---------------------------------------------------------------------------
// Self-service reschedule
// ---------------------------------------------------------------------------

export interface RescheduleSuccess {
  ok: true;
  /** The order after the move, with the item repointed to the new slot. */
  order: OrderSummary;
}

export interface RescheduleFailure {
  ok: false;
  /** Human-readable, customer-safe message. */
  error: string;
}

export type RescheduleResult = RescheduleSuccess | RescheduleFailure;

export interface RescheduleInput {
  orderNumber: string;
  email: string;
  timeslotId: string;
  /** Required when the order has more than one active item. */
  orderItemId?: string;
}

/** Map a server-side BookingError code to a customer-safe message. */
function rescheduleErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'RESCHEDULE_WINDOW_CLOSED':
      return 'It is too close to your reservation to change it online. Please contact us for help.';
    case 'INSUFFICIENT_CAPACITY':
    case 'TIMESLOT_CANCELLED':
    case 'TIMESLOT_NOT_FOUND':
      return 'That time is no longer available. Please choose another.';
    case 'SAME_TIMESLOT':
      return 'That is the same time as your current booking. Pick a different slot.';
    case 'ORDER_CANCELLED':
      return 'This booking has been cancelled and can no longer be changed.';
    default:
      return 'We could not reschedule that booking. Please try again or contact us.';
  }
}

/**
 * Move an upcoming booking item to a new slot. Mirrors the lookup action's shape:
 * returns a result object (never throws) so the dialog can render inline messages.
 * The API re-verifies the email against the order and enforces the activity's
 * self-reschedule window; we translate its error codes to friendly copy.
 */
export async function rescheduleBookingAction(
  input: RescheduleInput,
): Promise<RescheduleResult> {
  const orderNumber = input.orderNumber.trim().toUpperCase();
  const email = normalizeEmail(input.email);
  const timeslotId = input.timeslotId.trim();
  const orderItemId = input.orderItemId?.trim() || undefined;

  if (!orderNumber || !looksLikeEmail(email) || !timeslotId) {
    return {
      ok: false,
      error: 'Missing booking details for the reschedule. Please try again.',
    };
  }

  try {
    const order = await rescheduleBooking(orderNumber, {
      email,
      timeslotId,
      orderItemId,
    });
    return { ok: true, order };
  } catch (err) {
    if (isApiError(err)) {
      if (err.status === 404) {
        return {
          ok: false,
          error: 'We could not find a booking matching those details.',
        };
      }
      if (err.status === 0) {
        return {
          ok: false,
          error:
            'We could not reach the booking system. Please try again in a moment.',
        };
      }
      return { ok: false, error: rescheduleErrorMessage(err.code) };
    }
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
