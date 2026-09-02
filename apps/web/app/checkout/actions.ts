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
import { createBooking, submitPayment } from '@/lib/orders';
import {
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

/** Discriminated result so the client can branch on success vs. a friendly error. */
export type CheckoutActionResult =
  | { ok: true; order: OrderSummary; payment: PaymentResult }
  | { ok: false; error: string; code?: string };

/** Shape the client sends to the action (mirrors the shared booking schema). */
export interface PlaceOrderInput {
  /**
   * Stable per-attempt de-duplication key. The API resolves a replayed submit to the
   * order the first attempt created instead of booking twice — which matters most on
   * exactly the weak rural connection this product is built for, where a request can
   * succeed on the server and still time out on the phone.
   */
  idempotencyKey?: string;
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
  /**
   * Inline liability-waiver acceptance from checkout (WaiverSection): the required
   * acceptance flag and the typed full legal name. Forwarded so the API records the
   * signature instead of storing waiverSignedAt: null on a booking the guest signed.
   */
  waiverAcceptance?: {
    accepted: boolean;
    signatureName: string;
  };
  /**
   * Tokenized payment source — a Stripe PaymentMethod id from Stripe Elements.
   * Omitted in reserve mode, where no card is taken online.
   */
  paymentSourceId?: string;
  /**
   * Reserve now, pay at the marina. When true, the order is created and left with
   * its full balance due — no online charge is taken — so staff collect it on
   * arrival via the existing check-in / collect-balance flow.
   */
  reserve?: boolean;
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
    waiverAcceptance: input.waiverAcceptance,
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? 'Please check your booking details and try again.',
      code: 'VALIDATION',
    };
  }

  // Card mode requires a tokenized source before we create anything. Reserve mode
  // takes no card online, so this guard does not apply there.
  if (!input.reserve && !input.paymentSourceId) {
    return {
      ok: false,
      error: 'A payment method is required to complete your booking.',
      code: 'NO_PAYMENT_SOURCE',
    };
  }

  const data = parsed.data;

  // `parsed.data` already matches the API's flat bookingInputSchema contract
  // (snake_case customer + participants), so it passes straight through.
  const payload: CreateBookingPayload = {
    activityId: data.activityId,
    rateId: data.rateId,
    timeslotId: data.timeslotId,
    quantity: data.quantity,
    customer: data.customer,
    participants: data.participants,
    promoCode: data.promoCode,
    tipCents: data.tipCents,
    waiverAcceptance: data.waiverAcceptance,
    idempotencyKey: input.idempotencyKey,
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

  // Reserve mode: the booking is complete the moment the order exists. No card is
  // charged online — the order keeps its full balance due for on-arrival payment —
  // so we skip submitPayment entirely and report the balance the guest will owe.
  if (input.reserve) {
    const payment: PaymentResult = {
      paymentId: '',
      // Not paid, not failed, no bank challenge — a reservation awaiting payment.
      status: 'PRE_AUTHORIZED',
      amountCents: 0,
      balanceDueCents: order.balanceDueCents,
      cardLastFour: null,
      cardBrand: null,
      receiptUrl: null,
    };
    return { ok: true, order, payment };
  }

  let payment: PaymentResult;
  try {
    payment = await submitPayment(order.id, input.paymentSourceId!);
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

  return { ok: true, order, payment };
}
