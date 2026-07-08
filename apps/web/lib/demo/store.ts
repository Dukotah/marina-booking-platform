/**
 * Cookie-backed order store for DEMO_MODE (see ./config).
 *
 * SERVER-ONLY — imports next/headers, so it is reached exclusively via a dynamic
 * `import('./store')` from the order-mutating functions in `@/lib/api`, which run
 * only in server actions (create/pay/reschedule) and server components (read).
 * That keeps next/headers out of the client bundle.
 *
 * Orders live in a single `demo_orders` cookie (a small ring buffer) so a booking
 * created in one request is visible on the confirmation page and the "My Booking"
 * lookup within the same browser session — no database required. All money is
 * integer cents.
 */
import { cookies } from 'next/headers';
import { computeDemoOrder, parseTimeslotId } from './fixtures';
import type { CreateBookingPayload, OrderSummary, PaymentResult } from '@/lib/api';

const COOKIE = 'demo_orders';
const MAX_ORDERS = 10;
const MAX_AGE_SECONDS = 60 * 60 * 24; // 24h

function readAll(): OrderSummary[] {
  try {
    const raw = cookies().get(COOKIE)?.value;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OrderSummary[]) : [];
  } catch {
    return [];
  }
}

/**
 * Persist the order ring buffer. Only valid from a Server Action / Route Handler
 * (Next forbids cookie writes from server components); all writers here are called
 * from server actions, so this is safe.
 */
function writeAll(orders: OrderSummary[]): void {
  const trimmed = orders.slice(-MAX_ORDERS);
  cookies().set(COOKIE, JSON.stringify(trimmed), {
    path: '/',
    maxAge: MAX_AGE_SECONDS,
    sameSite: 'lax',
  });
}

export function createDemoOrder(payload: CreateBookingPayload): OrderSummary {
  const order = computeDemoOrder(payload);
  writeAll([...readAll(), order]);
  return order;
}

export function readDemoOrder(orderNumber: string): OrderSummary | null {
  const target = orderNumber.trim().toUpperCase();
  return readAll().find((o) => o.orderNumber.toUpperCase() === target) ?? null;
}

export function payDemoOrder(orderId: string): PaymentResult {
  const orders = readAll();
  const order = orders.find((o) => o.id === orderId) ?? orders[orders.length - 1];
  const amount = order?.totalCents ?? 0;

  if (order) {
    order.amountPaidCents = order.totalCents;
    order.balanceDueCents = 0;
    writeAll(orders);
  }

  return {
    paymentId: `demo_pay_${Math.random().toString(36).slice(2, 10)}`,
    status: 'PAID',
    amountCents: amount,
    balanceDueCents: 0,
    cardLastFour: '4242',
    cardBrand: 'Visa',
    receiptUrl: null,
  };
}

export function rescheduleDemoOrder(
  orderNumber: string,
  payload: { email: string; timeslotId: string; orderItemId?: string },
): OrderSummary {
  const orders = readAll();
  const order = orders.find(
    (o) => o.orderNumber.toUpperCase() === orderNumber.trim().toUpperCase(),
  );
  if (!order) {
    throw new Error('Order not found');
  }

  const parsed = parseTimeslotId(payload.timeslotId);
  const target =
    (payload.orderItemId && order.items.find((it) => it.id === payload.orderItemId)) ||
    order.items[0];
  if (parsed && target) {
    target.datetime = parsed.datetime;
  }

  writeAll(orders);
  return order;
}
