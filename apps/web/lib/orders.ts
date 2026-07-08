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

/** Fetch an order by its public order number (used on the confirmation page). */
export async function getOrder(orderNumber: string): Promise<OrderSummary> {
  if (DEMO_MODE) {
    const store = await import('./demo/store');
    const order = store.readDemoOrder(orderNumber);
    if (!order) throw new ApiError('Order not found', 404, 'NOT_FOUND');
    return order;
  }
  const data = await request<{ order: ApiOrder }>(
    `/api/orders/${encodeURIComponent(orderNumber)}`,
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
  };
}
