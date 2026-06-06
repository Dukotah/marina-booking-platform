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
  type PaymentActionRequired,
  type ChargeSettled,
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

/** Discriminated result so the client can branch on success vs. a friendly error. */
export type CheckoutActionResult =
  | { ok: true; order: OrderSummary; payment: PaymentResult }
  /**
   * 3-D Secure / SCA challenge needed. The client must call
   * stripe.handleNextAction({ clientSecret }) then finalize via confirmOrder().
   */
  | { ok: 'requires_action'; order: OrderSummary; clientSecret: string; paymentIntentId: string }
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
  /**
   * Optional idempotency key for the charge. When supplied it is forwarded as the
   * `Idempotency-Key` header so Stripe deduplicates double-submits. The client
   * should generate one UUID per checkout session and reuse it on retries.
   */
  idempotencyKey?: string;
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

  let chargeOutcome;
  try {
    chargeOutcome = await submitPayment(order.id, input.paymentSourceId, input.idempotencyKey);
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

  // 3DS / SCA: the charge is pending browser authentication. Return the secrets so
  // CheckoutClient can call stripe.handleNextAction() then confirmOrder().
  if ('requiresAction' in chargeOutcome) {
    // Narrowed: chargeOutcome is PaymentActionRequired.
    const actionRequired = chargeOutcome as PaymentActionRequired;
    return {
      ok: 'requires_action',
      order,
      clientSecret: actionRequired.clientSecret,
      paymentIntentId: actionRequired.paymentIntentId,
    };
  }

  // Narrowed: chargeOutcome is ChargeSettled.
  const settled = chargeOutcome as ChargeSettled;
  return { ok: true, order, payment: settled.payment };
}

/**
 * Finalize a 3DS-challenged charge after the browser has completed the
 * stripe.handleNextAction() flow. Called by CheckoutClient when placeOrder()
 * returns `ok: 'requires_action'` and the browser-side challenge succeeds.
 *
 * On success returns the same `{ ok: true, order, payment }` shape as placeOrder,
 * so the caller can redirect to /confirmation the same way.
 */
export async function confirmOrder(
  paymentIntentId: string,
  orderId: string,
  order: OrderSummary,
): Promise<CheckoutActionResult> {
  try {
    const result = await confirmPayment(paymentIntentId, orderId);
    return { ok: true, order, payment: result.payment };
  } catch (err) {
    return {
      ok: false,
      error: isApiError(err)
        ? err.message
        : 'The payment could not be finalized. Please try again.',
      code: isApiError(err) ? err.code : 'CONFIRM_FAILED',
    };
  }
}
