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
  cancelBooking,
  getCancellationPreview,
  type CancellationPreview,
} from '@/lib/orders';
import { isApiError, type OrderSummary } from '@/lib/api';

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
    // The API now enforces the email match itself (a wrong/missing email 404s
    // identically to a missing order), so this is the real identity gate — not the
    // post-fetch comparison that used to run after the API had already handed back
    // the guest's PII.
    order = await getOrder(orderNumber, email);
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

// ---------------------------------------------------------------------------
// Self-service cancel
// ---------------------------------------------------------------------------

export type CancelPreviewResult =
  | { ok: true; preview: CancellationPreview }
  | { ok: false; error: string };

export type CancelResult =
  | { ok: true; order: OrderSummary }
  | { ok: false; error: string; /** true when the window has closed → show "call us". */ windowClosed?: boolean };

/**
 * Fetch the refund preview for a self-cancel. Returns a result object (never throws)
 * so the dialog can render the number — or a friendly message — inline. The API
 * email-gates this identically to the cancel itself.
 */
export async function getCancelPreviewAction(input: {
  orderNumber: string;
  email: string;
}): Promise<CancelPreviewResult> {
  const orderNumber = input.orderNumber.trim().toUpperCase();
  const email = normalizeEmail(input.email);
  if (!orderNumber || !looksLikeEmail(email)) {
    return { ok: false, error: 'Missing booking details. Please look up your booking again.' };
  }

  try {
    const preview = await getCancellationPreview(orderNumber, email);
    return { ok: true, preview };
  } catch (err) {
    if (isApiError(err)) {
      if (err.status === 404) {
        return { ok: false, error: 'We could not find a booking matching those details.' };
      }
      if (err.status === 0) {
        return {
          ok: false,
          error: 'We could not reach the booking system. Please try again in a moment.',
        };
      }
    }
    return { ok: false, error: 'We could not load your refund details. Please try again.' };
  }
}

/**
 * Cancel an upcoming booking. The API re-verifies the email against the order and
 * enforces the activity's self-cancel window; a cancel too close to start comes back
 * as SELF_CANCEL_WINDOW_CLOSED, which we surface with `windowClosed` so the dialog
 * can route the guest to call. Never throws — returns a result object.
 */
export async function cancelBookingAction(input: {
  orderNumber: string;
  email: string;
  reason?: string;
}): Promise<CancelResult> {
  const orderNumber = input.orderNumber.trim().toUpperCase();
  const email = normalizeEmail(input.email);
  const reason = input.reason?.trim() || undefined;

  if (!orderNumber || !looksLikeEmail(email)) {
    return { ok: false, error: 'Missing booking details for the cancellation. Please try again.' };
  }

  try {
    const order = await cancelBooking(orderNumber, { email, reason });
    return { ok: true, order };
  } catch (err) {
    if (isApiError(err)) {
      if (err.code === 'SELF_CANCEL_WINDOW_CLOSED') {
        return {
          ok: false,
          windowClosed: true,
          error:
            'It is too close to your reservation to cancel online. Please call us and we will help.',
        };
      }
      if (err.status === 404) {
        return { ok: false, error: 'We could not find a booking matching those details.' };
      }
      if (err.code === 'ALREADY_CANCELLED') {
        return { ok: false, error: 'This booking has already been cancelled.' };
      }
      if (err.status === 0) {
        return {
          ok: false,
          error: 'We could not reach the booking system. Please try again in a moment.',
        };
      }
    }
    return { ok: false, error: 'We could not cancel that booking. Please try again or contact us.' };
  }
}
