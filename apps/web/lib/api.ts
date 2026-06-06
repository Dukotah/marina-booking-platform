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

/** Outcome of submitting a payment for an order (synchronous success path). */
export interface PaymentResult {
  id: string;
  status: string;
  amountCents: number;
  cardBrand: string | null;
  cardLastFour: string | null;
  processorTransactionId: string | null;
  receiptUrl: string | null;
}

/** Returned by POST /payments/charge when the card needs a 3DS challenge. */
export interface PaymentActionRequired {
  requiresAction: true;
  clientSecret: string;
  paymentIntentId: string;
}

/** Settled charge (synchronous success path). */
export interface ChargeSettled {
  payment: PaymentResult;
  order: { id: string; amountPaidCents: number; balanceDueCents: number };
}

/** Combined result of submitPayment: either settled or needs 3DS. */
export type ChargeOutcome = ChargeSettled | PaymentActionRequired;

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export interface BookingParticipant {
  fullName: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
}

export interface BookingLineInput {
  activityId: string;
  rateId: string;
  timeslotId: string;
  quantity: number;
  participants?: BookingParticipant[];
}

export interface CreateBookingPayload {
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
  items: BookingLineInput[];
  promoCode?: string | null;
  tipCents?: number;
  heardAboutUs?: string;
  isReturningGuest?: boolean;
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
  /**
   * Optional customer session bearer token (the email-OTP JWT). When present it's
   * sent as `Authorization: Bearer <token>` so token-gated self-service endpoints
   * (self-reschedule, gift-card tender) authenticate the caller without trusting a
   * client-supplied email. See apps/api customer-auth (D-017).
   */
  token?: string;
  /** Extra request headers merged on top of the standard ones. */
  extraHeaders?: Record<string, string>;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, cache = 'no-store', revalidate, signal, token, extraHeaders } = opts;

  const headers: Record<string, string> = {
    'x-operator-slug': OPERATOR_SLUG,
    accept: 'application/json',
    ...extraHeaders,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = `Bearer ${token}`;

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

/**
 * The public brand/contact shape returned by GET /api/operator/public.
 * Field names match the API's snake_case JSON payload exactly.
 */
export interface OperatorPublic {
  slug: string;
  name: string;
  brand_color: string;
  logo_dark_url: string | null;
  logo_light_url: string | null;
  timezone: string;
  website: string | null;
  phone: string | null;
}

/**
 * Fetch the current tenant's public brand data. Returns `null` instead of
 * throwing so callers can gracefully fall back to env/defaults when the API is
 * unreachable, the operator slug is unresolvable, or the response is malformed.
 * This is intentionally never-throw; the storefront must always render.
 */
export async function getOperatorPublic(): Promise<OperatorPublic | null> {
  try {
    return await request<OperatorPublic>('/api/operator/public', {
      // Brand changes rarely; revalidate once per minute so it is fast but
      // eventually consistent without requiring a full deployment.
      revalidate: 60,
    });
  } catch {
    // Network error, non-2xx, or malformed JSON — degrade silently.
    return null;
  }
}

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
  const data = await request<{ order: OrderSummary }>('/api/bookings', {
    method: 'POST',
    body: payload,
  });
  return data.order;
}

/** Fetch an order by its public order number (used on the confirmation page). */
export async function getOrder(orderNumber: string): Promise<OrderSummary> {
  const data = await request<{ order: OrderSummary }>(
    `/api/orders/${encodeURIComponent(orderNumber)}`,
  );
  return data.order;
}

/**
 * Customer self-service reschedule: move a booking to another timeslot of the same
 * activity. Email-gated server-side (must match the order's customer email) and
 * subject to the activity's self-reschedule window. Returns the updated order.
 */
export async function selfReschedule(
  orderNumber: string,
  email: string,
  timeslotId: string,
  orderItemId?: string,
  token?: string,
): Promise<OrderSummary> {
  const data = await request<{ order: OrderSummary }>(
    `/api/orders/${encodeURIComponent(orderNumber)}/self-reschedule`,
    {
      method: 'POST',
      body: { email, timeslotId, ...(orderItemId ? { orderItemId } : {}) },
      ...(token ? { token } : {}),
    },
  );
  return data.order;
}

// ---------------------------------------------------------------------------
// Customer auth (passwordless email-OTP login — D-017)
// ---------------------------------------------------------------------------

/** Result of requesting a login code. `devCode` is only present in non-prod when email isn't delivered. */
export interface RequestLoginCodeResult {
  sent: boolean;
  expiresAt: string;
  devCode?: string;
}

/** The signed customer session token + the resolved customer (id may be null for a first-time guest). */
export interface VerifyLoginCodeResult {
  token: string;
  expiresInSeconds: number;
  customer: {
    id: string | null;
    email: string;
    first_name?: string;
    last_name?: string;
  };
}

/** Request a 6-digit login code be emailed to the customer (step 1 of login). */
export async function requestCustomerLoginCode(
  email: string,
): Promise<RequestLoginCodeResult> {
  return request<RequestLoginCodeResult>('/api/auth/customer/request', {
    method: 'POST',
    body: { email },
  });
}

/** Exchange an email + code for a session token (step 2 of login). */
export async function verifyCustomerLoginCode(
  email: string,
  code: string,
): Promise<VerifyLoginCodeResult> {
  return request<VerifyLoginCodeResult>('/api/auth/customer/verify', {
    method: 'POST',
    body: { email, code },
  });
}

/**
 * Submit a payment for an order using a tokenized payment source (POST /api/payments/charge).
 *
 * @param sourceId        Stripe PaymentMethod id from Stripe Elements.
 * @param idempotencyKey  Optional client-generated key for double-submit safety. When
 *                        supplied it is sent as the `Idempotency-Key` header so Stripe
 *                        deduplicates any network-level retries against the same charge.
 *
 * Returns either a settled ChargeOutcome (payment + order fields) or a
 * PaymentActionRequired response when the card requires a 3DS challenge.
 */
export async function submitPayment(
  orderId: string,
  sourceId: string,
  idempotencyKey?: string,
): Promise<ChargeOutcome> {
  const extraHeaders: Record<string, string> = {};
  if (idempotencyKey) extraHeaders['Idempotency-Key'] = idempotencyKey;

  return request<ChargeOutcome>('/api/payments/charge', {
    method: 'POST',
    body: { orderId, sourceId },
    extraHeaders,
  });
}

/**
 * Finalize a 3DS-challenged payment after stripe.handleNextAction() resolves.
 * Calls POST /api/payments/confirm; on success returns the same settled
 * ChargeOutcome shape as submitPayment (minus requiresAction).
 */
export async function confirmPayment(
  paymentIntentId: string,
  orderId: string,
): Promise<{ payment: PaymentResult; order: { id: string; amountPaidCents: number; balanceDueCents: number } }> {
  return request('/api/payments/confirm', {
    method: 'POST',
    body: { paymentIntentId, orderId },
  });
}
