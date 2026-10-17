/**
 * Order-mutating API operations for the customer portal — create a booking, take
 * payment, fetch an order, and self-reschedule.
 *
 * SERVER-ONLY. These are called exclusively from server actions (checkout,
 * account) and server components (confirmation, account bookings). They are split
 * out of `./api` because in DEMO_MODE they reach a cookie-backed store that imports
 * `next/headers`; keeping them here ensures that dependency never enters the
 * client bundle (`./api` is imported by client components for catalog/availability).
 *
 * All money is integer cents.
 */
import { DEMO_MODE } from './demo/config';
import {
  ApiError,
  mapApiOrder,
  request,
  type ApiOrder,
  type CreateBookingPayload,
  type OrderSummary,
  type PaymentResult,
} from './api';

/** Create a booking (order). Returns the order summary with computed totals. */
export async function createBooking(
  payload: CreateBookingPayload,
): Promise<OrderSummary> {
  if (DEMO_MODE) {
    const store = await import('./demo/store');
    return store.createDemoOrder(payload);
  }
  const data = await request<{ order: ApiOrder }>('/api/bookings', {
    method: 'POST',
    body: payload,
  });
  return mapApiOrder(data.order);
}

/** The shape returned by POST /api/public/gift-cards/purchase. */
export interface GiftCardPurchaseResult {
  giftCard: {
    id: string;
    code: string;
    balanceCents: number;
    status: string;
    recipientEmail: string | null;
  };
  amountChargedCents: number;
  emailSent: boolean;
}

/**
 * Buy a gift card online. The server is the price authority: it re-derives the
 * amount from its allowed denomination set, charges the card through the payment
 * provider, issues the card for exactly the charged amount, and emails the code to
 * the recipient. Always hits the real API (no demo fixture — gift cards are live
 * stored value even in the showcase deployment). All money is integer cents.
 */
export async function purchaseGiftCard(payload: {
  amountCents: number;
  sourceId: string;
  recipientEmail: string;
  recipientName?: string;
  purchaserEmail?: string;
  purchaserName?: string;
  message?: string;
  idempotencyKey?: string;
}): Promise<GiftCardPurchaseResult> {
  return request<GiftCardPurchaseResult>('/api/public/gift-cards/purchase', {
    method: 'POST',
    body: payload,
  });
}

/**
 * Fetch an order by its public order number.
 *
 * The public API gates this on an identity proof: order numbers are enumerable, so
 * the server only returns a guest's PII when the caller proves ownership with the
 * email on the booking (the magic-link stub). Every customer-portal caller already
 * has that email — the confirmation redirect carries it, and the account/lookup
 * flows collect it — so pass it through. A missing/wrong email 404s identically to
 * a missing order, so this never reveals which order numbers exist.
 */
export async function getOrder(orderNumber: string, email: string): Promise<OrderSummary> {
  if (DEMO_MODE) {
    const store = await import('./demo/store');
    const order = store.readDemoOrder(orderNumber);
    // Mirror the live API's identity gate in demo mode: same 404 for a missing
    // order or a non-matching email, so behaviour (and the probing defence) match.
    if (!order || order.customerEmail.trim().toLowerCase() !== email.trim().toLowerCase()) {
      throw new ApiError('Order not found', 404, 'NOT_FOUND');
    }
    return order;
  }
  const data = await request<{ order: ApiOrder }>(
    `/api/orders/${encodeURIComponent(orderNumber)}?email=${encodeURIComponent(email)}`,
  );
  return mapApiOrder(data.order);
}

/**
 * Customer self-service reschedule: move a booking item to a different time slot
 * of the same activity. Identity is gated server-side by the email on the order
 * (the magic-link stub), and the move must fall inside the activity's
 * self-reschedule window. `orderItemId` is required when the order has more than
 * one active item. Returns the updated order summary.
 */
export async function rescheduleBooking(
  orderNumber: string,
  payload: { email: string; timeslotId: string; orderItemId?: string },
): Promise<OrderSummary> {
  if (DEMO_MODE) {
    const store = await import('./demo/store');
    return store.rescheduleDemoOrder(orderNumber, payload);
  }
  const data = await request<{ order: ApiOrder | null }>(
    `/api/orders/${encodeURIComponent(orderNumber)}/self-reschedule`,
    { method: 'POST', body: payload },
  );
  if (!data.order) {
    throw new ApiError(
      'The reschedule did not return an updated order.',
      502,
      'NO_ORDER',
    );
  }
  return mapApiOrder(data.order);
}

/** Refund preview for the self-service cancel dialog (mirrors the API contract). */
export interface CancellationPreview {
  /** Tier percent (0-100) applied at "now". */
  tierPercent: number;
  /** Cents that would be refunded if the guest cancels now. */
  refundCents: number;
  /** Cancellation fee withheld (cents). */
  feeCents: number;
  /** Cents the guest has paid — the refund ceiling. */
  amountPaidCents: number;
  /** True while the guest may still self-cancel online; false => must call. */
  withinSelfCancelWindow: boolean;
  /** Self-cancel cutoff (hours before start) for the policy copy. */
  selfCancelHours: number;
}

/**
 * Read-only preview of what cancelling an order now would refund, and whether the
 * guest is still inside the self-cancel window. Email-gated server-side (same gate
 * as the cancel itself); a missing/wrong email 404s identically to a missing order.
 */
export async function getCancellationPreview(
  orderNumber: string,
  email: string,
): Promise<CancellationPreview> {
  if (DEMO_MODE) {
    const store = await import('./demo/store');
    return store.previewDemoCancellation(orderNumber, email);
  }
  const data = await request<{ preview: CancellationPreview }>(
    `/api/orders/${encodeURIComponent(orderNumber)}/self-cancel?email=${encodeURIComponent(email)}`,
  );
  return data.preview;
}

/**
 * Customer self-service cancel: cancel an upcoming booking. Identity is gated
 * server-side by the email on the order (the magic-link stub), and the cancel must
 * fall inside the activity's self-cancel window (too close to start -> the API 409s
 * with SELF_CANCEL_WINDOW_CLOSED). On success the API issues the tiered refund and
 * sends the cancellation email. Returns the updated order summary.
 */
export async function cancelBooking(
  orderNumber: string,
  payload: { email: string; reason?: string },
): Promise<OrderSummary> {
  if (DEMO_MODE) {
    const store = await import('./demo/store');
    return store.cancelDemoOrder(orderNumber, payload.email);
  }
  const data = await request<{ order: ApiOrder | null }>(
    `/api/orders/${encodeURIComponent(orderNumber)}/self-cancel`,
    { method: 'POST', body: payload },
  );
  if (!data.order) {
    throw new ApiError('The cancel did not return an updated order.', 502, 'NO_ORDER');
  }
  return mapApiOrder(data.order);
}

/** The result of applying a gift card to an order (mirrors the API's `RedeemGiftCardResult`). */
export interface GiftCardRedemption {
  giftCardId: string;
  code: string;
  /** Cents actually applied to the order by this redemption. */
  appliedCents: number;
  /** Remaining balance on the card after this redemption. */
  cardBalanceCents: number;
  cardStatus: 'ACTIVE' | 'REDEEMED' | 'EXPIRED' | 'VOID';
  /** Order totals AFTER the gift card was applied — the authority on what's left to pay. */
  orderAmountPaidCents: number;
  orderBalanceDueCents: number;
}

/**
 * Apply a gift card to an existing order (PUBLIC `POST /api/gift-cards/redeem`).
 *
 * The server is the authority on the math: it applies min(card balance, requested
 * amount, order balance due) inside a tenant-scoped transaction, writes a
 * GIFT_CARD Payment, and returns the order's new balance_due. Omit `amountCents`
 * to draw down the full outstanding balance (the normal checkout case). Throws
 * ApiError (with the service's GiftCardError `code`, e.g. NOT_FOUND / EXPIRED /
 * INSUFFICIENT_BALANCE / ORDER_CANCELLED) on any failure, so the order can never
 * look paid when the redemption did not land. Always hits the real API — gift
 * cards are live stored value even in the showcase deployment.
 */
export async function redeemGiftCard(
  orderId: string,
  code: string,
  amountCents?: number,
): Promise<GiftCardRedemption> {
  return request<GiftCardRedemption>('/api/gift-cards/redeem', {
    method: 'POST',
    body: { code, orderId, amountCents },
  });
}

/**
 * Submit a payment for an order using a tokenized payment source.
 * @param sourceId Stripe PaymentMethod id from Stripe Elements (sent as `sourceId`).
 *                 In dev-fake-payments / demo mode a placeholder id is accepted.
 */
export async function submitPayment(
  orderId: string,
  sourceId: string,
): Promise<PaymentResult> {
  if (DEMO_MODE) {
    const store = await import('./demo/store');
    return store.payDemoOrder(orderId);
  }
  const data = await request<{
    payment: {
      id: string;
      status: PaymentResult['status'];
      amountCents: number;
      cardBrand: string | null;
      cardLastFour: string | null;
      processorTransactionId: string | null;
      receiptUrl: string | null;
    };
    order: { id: string; amountPaidCents: number; balanceDueCents: number };
    /** Present only on a REQUIRES_ACTION (3DS challenge) response. */
    authentication?: PaymentResult['authentication'];
  }>('/api/payments/charge', {
    method: 'POST',
    body: { orderId, sourceId },
  });
  return {
    paymentId: data.payment.id,
    status: data.payment.status,
    amountCents: data.payment.amountCents,
    balanceDueCents: data.order.balanceDueCents,
    cardLastFour: data.payment.cardLastFour,
    cardBrand: data.payment.cardBrand,
    receiptUrl: data.payment.receiptUrl,
    // Carry the challenge affordance through so the ChallengeDialog gets the
    // client secret Stripe.js needs in cloud mode (previously dropped here).
    authentication: data.authentication ?? null,
  };
}
