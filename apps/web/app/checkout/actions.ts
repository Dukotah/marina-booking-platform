'use server';

/**
 * Server actions for the checkout flow.
 *
 * The typed API client in `@/lib/api` is server-only: it reads `API_URL` and
 * `OPERATOR_SLUG` from the environment and sends the tenant slug on every
 * request. We therefore run the money-touching calls (create booking, take
 * payment) here on the server rather than from the browser, so the API origin
 * and tenant resolution stay server-side and the client never talks to the API
 * directly.
 *
 * The client component calls these actions with already-validated input
 * (validated again here with the shared zod schema, since actions are a trust
 * boundary). All money is integer cents.
 */

import { bookingInputSchema, promoValidateSchema } from '@marina/core';
import {
  createBooking,
  submitPayment,
  confirmPayment,
  validatePromo,
  isApiError,
  type CreateBookingPayload,
  type OrderSummary,
  type PaymentResult,
  type PromoValidation,
} from '@/lib/api';

/**
 * Validate a promo code against the activity. Runs server-side (the API client
 * is server-only). Returns the API's `PromoValidation` or a friendly error.
 */
export async function checkPromo(
  code: string,
  activityId: string,
): Promise<
  | { ok: true; promo: PromoValidation }
  | { ok: false; error: string }
> {
  const parsed = promoValidateSchema.safeParse({ code, activityId });
  if (!parsed.success) {
    return { ok: false, error: 'Enter a valid promo code.' };
  }

  try {
    const promo = await validatePromo(parsed.data.code, activityId);
    return { ok: true, promo };
  } catch (err) {
    return {
      ok: false,
      error: isApiError(err)
        ? err.message
        : 'We could not check that promo code right now.',
    };
  }
}

/**
 * Discriminated result so the client can branch on success, a 3DS challenge, or a
 * friendly error.
 *
 * 3-D Secure / SCA control flow (why this is split across server + client):
 *   1. `placeOrder` (server action) creates the order and calls the charge API.
 *   2. If the bank requires a challenge the charge API returns REQUIRES_ACTION;
 *      `placeOrder` cannot run the 3DS modal (server actions have no browser), so
 *      it returns `{ ok: true, requiresAction: true, clientSecret, ... }` to the
 *      CheckoutClient (a client component).
 *   3. CheckoutClient runs `stripe.handleNextAction({ clientSecret })` in the
 *      browser to show the modal. On success it calls `finalizePayment` (server
 *      action) which retrieves the now-succeeded PaymentIntent and records the
 *      Payment row idempotently, returning the normal success result.
 *   4. On challenge cancel/failure the client shows the existing decline UX.
 */
export type CheckoutActionResult =
  | { ok: true; requiresAction?: false; order: OrderSummary; payment: PaymentResult }
  | {
      ok: true;
      requiresAction: true;
      order: OrderSummary;
      clientSecret: string;
      paymentIntentId: string;
    }
  | { ok: false; error: string; code?: string };

/** Shape the client sends to the action (mirrors the shared booking schema). */
export interface PlaceOrderInput {
  activityId: string;
  rateId: string;
  timeslotId: string;
  quantity: number;
  customer: {
    first_name: string;
    last_name: string;
    email: string;
    phone?: string;
  };
  participants: Array<{
    driver_name: string;
    license?: string;
    dob?: string;
    experience?: 'NONE' | 'BEGINNER' | 'INTERMEDIATE' | 'EXPERIENCED';
  }>;
  promoCode?: string;
  tipCents?: number;
  /** Tokenized payment source — a Stripe PaymentMethod id from Stripe Elements. */
  paymentSourceId: string;
  heardAboutUs?: string;
  isReturningGuest?: boolean;
}

/**
 * Create the order then take payment, returning a single result. On any failure
 * the client stays on the checkout page and shows the message; on success it
 * redirects to the confirmation page using the returned order number.
 */
export async function placeOrder(
  input: PlaceOrderInput,
): Promise<CheckoutActionResult> {
  // Re-validate the booking core (actions are a public trust boundary).
  const parsed = bookingInputSchema.safeParse({
    activityId: input.activityId,
    rateId: input.rateId,
    timeslotId: input.timeslotId,
    quantity: input.quantity,
    customer: input.customer,
    participants: input.participants,
    promoCode: input.promoCode,
    tipCents: input.tipCents,
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? 'Please check your booking details and try again.',
      code: 'VALIDATION',
    };
  }

  if (!input.paymentSourceId) {
    return {
      ok: false,
      error: 'A payment method is required to complete your booking.',
      code: 'NO_PAYMENT_SOURCE',
    };
  }

  const data = parsed.data;

  const payload: CreateBookingPayload = {
    customer: {
      firstName: data.customer.first_name,
      lastName: data.customer.last_name,
      email: data.customer.email,
      phone: data.customer.phone,
    },
    items: [
      {
        activityId: data.activityId,
        rateId: data.rateId,
        timeslotId: data.timeslotId,
        quantity: data.quantity,
        participants: data.participants.map((p) => ({
          fullName: p.driver_name,
          dateOfBirth: p.dob,
        })),
      },
    ],
    promoCode: data.promoCode ?? null,
    tipCents: data.tipCents,
    heardAboutUs: input.heardAboutUs,
    isReturningGuest: input.isReturningGuest,
  };

  let order: OrderSummary;
  try {
    order = await createBooking(payload);
  } catch (err) {
    return {
      ok: false,
      error: isApiError(err)
        ? err.message
        : 'We could not create your booking. Please try again.',
      code: isApiError(err) ? err.code : undefined,
    };
  }

  let payment: PaymentResult;
  try {
    payment = await submitPayment(order.id, input.paymentSourceId);
  } catch (err) {
    // The order exists but payment failed — surface a clear, recoverable message.
    return {
      ok: false,
      error: isApiError(err)
        ? err.message
        : 'Your booking was created but the payment could not be processed. Please try a different card.',
      code: isApiError(err) ? err.code : 'PAYMENT_FAILED',
    };
  }

  if (payment.status === 'FAILED') {
    return {
      ok: false,
      error: 'The payment was declined. Please try a different card.',
      code: 'PAYMENT_DECLINED',
    };
  }

  // 3-D Secure / SCA: the charge isn't settled — hand the client secret back to the
  // browser, which runs the challenge and then calls `finalizePayment`. See the
  // CheckoutActionResult doc comment for the full sequence.
  if (payment.status === 'REQUIRES_ACTION') {
    if (!payment.clientSecret || !payment.paymentIntentId) {
      return {
        ok: false,
        error: 'The payment could not be completed. Please try a different card.',
        code: 'PAYMENT_FAILED',
      };
    }
    return {
      ok: true,
      requiresAction: true,
      order,
      clientSecret: payment.clientSecret,
      paymentIntentId: payment.paymentIntentId,
    };
  }

  return { ok: true, order, payment };
}

/**
 * Finalize a payment after the browser completed the 3-D Secure / SCA challenge.
 * Called by CheckoutClient once `stripe.handleNextAction` resolves successfully.
 * Retrieves the PaymentIntent server-side and records the Payment row idempotently
 * (the API guards against double-insert). Returns the same discriminated result so
 * the client can proceed to the confirmation page exactly like the happy path.
 */
export async function finalizePayment(
  order: OrderSummary,
  paymentIntentId: string,
): Promise<CheckoutActionResult> {
  let payment: PaymentResult;
  try {
    payment = await confirmPayment(order.id, paymentIntentId);
  } catch (err) {
    return {
      ok: false,
      error: isApiError(err)
        ? err.message
        : 'We could not confirm your payment. Please try again.',
      code: isApiError(err) ? err.code : 'PAYMENT_FAILED',
    };
  }

  if (payment.status === 'FAILED') {
    return {
      ok: false,
      error: 'The payment was declined. Please try a different card.',
      code: 'PAYMENT_DECLINED',
    };
  }

  // Still pending after the challenge — surface a recoverable error rather than
  // looping the modal indefinitely.
  if (payment.status === 'REQUIRES_ACTION') {
    return {
      ok: false,
      error: 'Payment authentication was not completed. Please try again.',
      code: 'PAYMENT_REQUIRES_ACTION',
    };
  }

  return { ok: true, order, payment };
}
