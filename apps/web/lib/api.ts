/**
 * Typed client for the marina API, used by the customer booking portal.
 *
 * The tenant is selected by the operator slug. In production the slug is resolved
 * from the request host (subdomain / custom domain) by the API's tenant
 * middleware; for dev/server-to-server it comes from OPERATOR_SLUG and is sent as
 * the `x-operator-slug` header on every request.
 *
 * Page/route agents should import the functions below rather than calling `fetch`
 * directly, so the endpoint shapes and error handling stay in one place.
 *
 * All money fields are integer cents (see @marina/types money helpers).
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const OPERATOR_SLUG = process.env.OPERATOR_SLUG ?? 'lake-sonoma';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the API responds with a non-2xx status. Carries the HTTP status
 * and (when present) the structured error payload so callers can branch on it
 * (e.g. show a friendly message for 404 vs 409 conflicts).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload?: unknown;

  constructor(message: string, status: number, code?: string, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

/** True for the typed API error, narrowing `unknown` in catch blocks. */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

// ---------------------------------------------------------------------------
// Response types (mirror the API's camelCase JSON contracts)
// ---------------------------------------------------------------------------

export type ActivityCategory =
  | 'BOAT'
  | 'WATERCRAFT'
  | 'PATIO'
  | 'LODGING'
  | 'TOUR'
  | 'CLASS'
  | 'EVENT'
  | 'EQUIPMENT'
  | 'OTHER';

export type SlotStatus = 'AVAILABLE' | 'FILLING_UP' | 'FULL';

export interface CatalogRate {
  id: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
}

export interface CatalogActivity {
  id: string;
  name: string;
  category: ActivityCategory;
  maxParticipants: number;
  color: string;
  photoUrls: string[];
  waiverRequired: boolean;
  /** Lowest bookable price, or null when no rates are configured. */
  fromPriceCents: number | null;
  rates: CatalogRate[];
}

/** Full detail for a single activity's booking page. */
export interface ActivityDetail extends CatalogActivity {
  minParticipants: number;
  descriptionHtml: string | null;
  selfRescheduleHours: number;
}

/** A single bookable time on a given day. */
export interface AvailabilitySlot {
  timeslotId: string;
  /** ISO 8601 datetime (UTC) of the slot start. */
  datetime: string;
  capacityTotal: number;
  capacityBooked: number;
  capacityRemaining: number;
  status: SlotStatus;
}

/** All bookable slots for one activity on one calendar day. */
export interface AvailabilityDay {
  activityId: string;
  /** The requested day as YYYY-MM-DD. */
  date: string;
  slots: AvailabilitySlot[];
}

/** Result of validating a promo code against an activity. */
export interface PromoValidation {
  valid: boolean;
  code: string;
  discountType: 'PERCENT' | 'FLAT';
  /** Percent (e.g. 10 = 10%) or flat cents, per discountType. */
  discountValue: number;
  /** Human-readable reason when valid is false. */
  reason?: string;
}

export interface OrderLineItem {
  id: string;
  activityId: string;
  activityName: string;
  rateName: string;
  /** ISO 8601 datetime (UTC) of the booked slot. */
  datetime: string;
  quantity: number;
  unitPriceCents: number;
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: 'UPCOMING' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  customerName: string;
  customerEmail: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  processingFeeCents: number;
  tipCents: number;
  totalCents: number;
  amountPaidCents: number;
  balanceDueCents: number;
  items: OrderLineItem[];
  createdAt: string;
}

/** Outcome of submitting a payment for an order (maps the API charge response). */
export interface PaymentResult {
  paymentId: string;
  status: 'PAID' | 'PARTIAL_REFUND' | 'REFUNDED' | 'FAILED' | 'PRE_AUTHORIZED';
  amountCents: number;
  /** Order balance remaining after the charge. */
  balanceDueCents: number;
  cardLastFour: string | null;
  cardBrand: string | null;
  receiptUrl: string | null;
}

// ---------------------------------------------------------------------------
// API order shape (server contract) + mapper to the flat OrderSummary above
// ---------------------------------------------------------------------------

/**
 * The order JSON the API actually returns (`serializeOrder`): customer + line
 * items are nested. We map it to the flat `OrderSummary` the pages consume so the
 * contract lives in exactly one place.
 */
interface ApiOrder {
  id: string;
  orderNumber: string;
  status: OrderSummary['status'];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  processingFeeCents: number;
  tipCents: number;
  totalCents: number;
  amountPaidCents: number;
  balanceDueCents: number;
  createdAt: string;
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
  };
  items: Array<{
    id: string;
    quantity: number;
    unitPriceCents: number;
    activity: { id: string; name: string };
    rate: { id: string; name: string; durationMinutes: number };
    timeslot: { id: string; datetime: string };
  }>;
}

function mapApiOrder(o: ApiOrder): OrderSummary {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    customerName: `${o.customer.firstName} ${o.customer.lastName}`.trim(),
    customerEmail: o.customer.email,
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    taxCents: o.taxCents,
    processingFeeCents: o.processingFeeCents,
    tipCents: o.tipCents,
    totalCents: o.totalCents,
    amountPaidCents: o.amountPaidCents,
    balanceDueCents: o.balanceDueCents,
    createdAt: o.createdAt,
    items: o.items.map((it) => ({
      id: it.id,
      activityId: it.activity.id,
      activityName: it.activity.name,
      rateName: it.rate.name,
      datetime: it.timeslot.datetime,
      quantity: it.quantity,
      unitPriceCents: it.unitPriceCents,
    })),
  };
}

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export interface BookingParticipant {
  driver_name: string;
  license?: string;
  /** ISO date YYYY-MM-DD. */
  dob?: string;
  experience?: 'NONE' | 'BEGINNER' | 'INTERMEDIATE' | 'EXPERIENCED';
}

/**
 * Create-booking payload — the flat, single-item shape the API validates with
 * `@marina/core` `bookingInputSchema` (snake_case customer + participants). The
 * checkout action validates with that same schema, so it can pass its parsed data
 * straight through.
 */
export interface CreateBookingPayload {
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
  participants?: BookingParticipant[];
  promoCode?: string;
  tipCents?: number;
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Next.js fetch cache strategy. Defaults to 'no-store' (always fresh). */
  cache?: RequestCache;
  /** Optional Next.js revalidation window in seconds. */
  revalidate?: number;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, cache = 'no-store', revalidate, signal } = opts;

  const headers: Record<string, string> = {
    'x-operator-slug': OPERATOR_SLUG,
    accept: 'application/json',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const init: RequestInit & { next?: { revalidate: number } } = {
    method,
    headers,
    cache,
    signal,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (revalidate !== undefined) {
    init.next = { revalidate };
    // `cache` and `next.revalidate` are mutually exclusive in Next's fetch.
    delete (init as { cache?: RequestCache }).cache;
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, init);
  } catch (cause) {
    throw new ApiError(
      `Network error reaching the booking API (${method} ${path}).`,
      0,
      'NETWORK',
      cause,
    );
  }

  if (!res.ok) {
    let code: string | undefined;
    let message = `Request failed (${res.status} ${res.statusText}) for ${method} ${path}.`;
    let payload: unknown;
    try {
      payload = await res.json();
      if (payload && typeof payload === 'object') {
        const p = payload as Record<string, unknown>;
        if (typeof p.error === 'string') message = p.error;
        if (typeof p.code === 'string') code = p.code;
      }
    } catch {
      // Non-JSON error body — keep the default message.
    }
    throw new ApiError(message, res.status, code, payload);
  }

  if (res.status === 204) return undefined as T;

  try {
    return (await res.json()) as T;
  } catch (cause) {
    throw new ApiError(
      `Malformed JSON response for ${method} ${path}.`,
      res.status,
      'BAD_JSON',
      cause,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The full bookable catalog (active, online-visible activities) for the tenant. */
export async function getCatalog(): Promise<CatalogActivity[]> {
  const data = await request<{ activities: CatalogActivity[] }>('/api/activities');
  return data.activities;
}

/** Detail for a single activity's booking page. */
export async function getActivity(id: string): Promise<ActivityDetail> {
  const data = await request<{ activity: ActivityDetail }>(
    `/api/activities/${encodeURIComponent(id)}`,
  );
  return data.activity;
}

/**
 * Availability for one activity on one day.
 * @param isoDate YYYY-MM-DD in the operator's local calendar.
 */
export async function getAvailability(
  activityId: string,
  isoDate: string,
): Promise<AvailabilityDay> {
  const qs = new URLSearchParams({ date: isoDate });
  return request<AvailabilityDay>(
    `/api/activities/${encodeURIComponent(activityId)}/availability?${qs.toString()}`,
  );
}

/** Validate a promo code for a given activity before applying it at checkout. */
export async function validatePromo(
  code: string,
  activityId: string,
): Promise<PromoValidation> {
  return request<PromoValidation>('/api/promos/validate', {
    method: 'POST',
    body: { code, activityId },
  });
}

/** Create a booking (order). Returns the order summary with computed totals. */
export async function createBooking(
  payload: CreateBookingPayload,
): Promise<OrderSummary> {
  const data = await request<{ order: ApiOrder }>('/api/bookings', {
    method: 'POST',
    body: payload,
  });
  return mapApiOrder(data.order);
}

/** Fetch an order by its public order number (used on the confirmation page). */
export async function getOrder(orderNumber: string): Promise<OrderSummary> {
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
 *                 In dev-fake-payments mode a placeholder id is accepted.
 */
export async function submitPayment(
  orderId: string,
  sourceId: string,
): Promise<PaymentResult> {
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
