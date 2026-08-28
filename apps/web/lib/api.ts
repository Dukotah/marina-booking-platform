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

import { DEMO_MODE } from './demo/config';
import {
  getDemoCatalog,
  getDemoActivity,
  getDemoAvailability,
  getDemoPromo,
} from './demo/fixtures';

// Server-side: call the API directly. Browser-side: use this app's own origin
// (empty base → relative `/api/...`) and let the Next rewrite proxy it to the API,
// so client calls don't depend on the API being reachable at localhost from the
// browser (matters on WSL/remote where localhost isn't forwarded).
const API_URL =
  typeof window === 'undefined'
    ? (process.env.API_URL ?? 'http://localhost:3001')
    : '';
// Per-request tenant override: an `operator_slug` cookie (set from `?operator=`)
// lets a single local deployment preview any client; otherwise the env default.
// Read from document.cookie in the browser; on the server, per-tenant preview is
// a follow-up (would thread the slug from a server-only resolver to avoid pulling
// next/headers into this client-imported module). SSR data uses the env default.
const OPERATOR_SLUG = process.env.OPERATOR_SLUG ?? 'lake-sonoma';

function resolveOperatorSlug(): string {
  if (typeof document !== 'undefined') {
    const m = document.cookie.match(/(?:^|;\s*)operator_slug=([^;]+)/);
    if (m) return decodeURIComponent(m[1]!);
  }
  return OPERATOR_SLUG;
}

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
  /** When true, pricing is suppressed on this activity ("call for price"). */
  hidePrice?: boolean;
  /** Lowest bookable price, or null when no rates are configured / price hidden. */
  fromPriceCents: number | null;
  rates: CatalogRate[];
}

/** An optional add-on offered at checkout for an activity (package upsell). */
export interface ActivityUpsell {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
}

/** Full detail for a single activity's booking page. */
export interface ActivityDetail extends CatalogActivity {
  minParticipants: number;
  descriptionHtml: string | null;
  selfRescheduleHours: number;
  /** Optional checkout add-ons; absent on older API responses. */
  upsells?: ActivityUpsell[];
}

/** One line within a Package bundle. */
export interface PackageItem {
  id: string;
  activityId: string;
  activityName: string;
  rateId: string;
  rateName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

/** A sellable activity/rate bundle at a single package price. */
export interface CatalogPackage {
  id: string;
  name: string;
  descriptionHtml: string | null;
  priceCents: number;
  aLaCarteCents: number;
  savingsCents: number;
  items: PackageItem[];
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
  status:
    | 'PAID'
    | 'PARTIAL_REFUND'
    | 'REFUNDED'
    | 'FAILED'
    | 'PRE_AUTHORIZED'
    // 3DS/SCA challenge outstanding — the guest must complete it before capture.
    | 'REQUIRES_ACTION'
    | 'DISPUTED';
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
export interface ApiOrder {
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

export function mapApiOrder(o: ApiOrder): OrderSummary {
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

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, cache = 'no-store', revalidate, signal } = opts;

  const headers: Record<string, string> = {
    'x-operator-slug': resolveOperatorSlug(),
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
  if (DEMO_MODE) return getDemoCatalog();
  const data = await request<{ activities: CatalogActivity[] }>('/api/activities');
  return data.activities;
}

/** The active, online-visible package bundles for the tenant (empty in demo mode). */
export async function getPackages(): Promise<CatalogPackage[]> {
  if (DEMO_MODE) return [];
  const data = await request<{ packages: CatalogPackage[] }>('/api/packages');
  return data.packages;
}

/** Priced detail for a single package bundle. */
export async function getPackage(id: string): Promise<CatalogPackage> {
  const data = await request<{ package: CatalogPackage }>(
    `/api/packages/${encodeURIComponent(id)}`,
  );
  return data.package;
}

/** Detail for a single activity's booking page. */
export async function getActivity(id: string): Promise<ActivityDetail> {
  if (DEMO_MODE) {
    const activity = getDemoActivity(id);
    if (!activity) throw new ApiError('Activity not found', 404, 'NOT_FOUND');
    return activity;
  }
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
  if (DEMO_MODE) return getDemoAvailability(activityId, isoDate);
  const qs = new URLSearchParams({ date: isoDate });
  return request<AvailabilityDay>(
    `/api/activities/${encodeURIComponent(activityId)}/availability?${qs.toString()}`,
  );
}

/** One day's rolled-up availability, as the range endpoint returns it. */
export interface AvailabilityRangeDay {
  date: string;
  slotCount: number;
  capacityTotal: number;
  capacityBooked: number;
  capacityRemaining: number;
  signal: 'green' | 'yellow' | 'red';
  resourceLimited?: boolean;
}

/**
 * Availability for a span of days in ONE request.
 *
 * Called from the server so the activity page can ship the date strip already
 * populated; the calendar falls back to fetching client-side for anything outside
 * the seeded window.
 */
export async function getAvailabilityRange(
  activityId: string,
  fromIso: string,
  toIso: string,
): Promise<AvailabilityRangeDay[]> {
  const qs = new URLSearchParams({ activityId, from: fromIso, to: toIso });
  const data = await request<{ days: AvailabilityRangeDay[] }>(
    `/api/availability/range?${qs.toString()}`,
  );
  return data.days;
}

/** Validate a promo code for a given activity before applying it at checkout. */
export async function validatePromo(
  code: string,
  activityId: string,
): Promise<PromoValidation> {
  if (DEMO_MODE) return getDemoPromo(code, activityId);
  return request<PromoValidation>('/api/promos/validate', {
    method: 'POST',
    body: { code, activityId },
  });
}

// ---------------------------------------------------------------------------
// Waivers (public: active clauses + clause-level signing)
// ---------------------------------------------------------------------------

/** A single clause of the active waiver, in display order. */
export interface WaiverClause {
  id: string;
  sortOrder: number;
  title: string;
  bodyHtml: string;
  requiresInitials: boolean;
  isRequired: boolean;
}

/** The active waiver plus its ordered clauses, for the clause-level signing UI. */
export interface ActiveWaiver {
  id: string;
  name: string;
  version: number;
  introHtml: string | null;
  templateHtml: string;
  requiresMinorSignature: boolean;
  clauses: WaiverClause[];
}

/** Fetch the tenant's active waiver + clauses (optionally scoped to an activity). */
export async function getActiveWaiver(activityId?: string): Promise<ActiveWaiver> {
  const qs = activityId ? `?activityId=${encodeURIComponent(activityId)}` : '';
  const body = await request<{ waiver: ActiveWaiver }>(`/api/waivers/active${qs}`);
  return body.waiver;
}

/** One per-clause acknowledgment submitted with a signature. */
export interface WaiverAcknowledgment {
  clauseId: string;
  initials?: string;
}

export interface SignWaiverPayload {
  orderItemId: string;
  signerName: string;
  signerDob?: string;
  signatureData: string;
  isMinor: boolean;
  guardianName?: string;
  acknowledgments: WaiverAcknowledgment[];
}

export interface SignWaiverResponse {
  signature: {
    id: string;
    orderItemId: string | null;
    signerName: string;
    signedAt: string;
    acknowledgments: Array<{ clauseId: string; title: string; initials: string | null }>;
  };
}

/** Submit a clause-level waiver signature for an order item. */
export async function signWaiver(payload: SignWaiverPayload): Promise<SignWaiverResponse> {
  return request<SignWaiverResponse>('/api/waivers/sign', {
    method: 'POST',
    body: payload,
  });
}

// Order-mutating operations (create/pay/get/reschedule) live in `./orders` — a
// server-only module — because in DEMO_MODE they reach a cookie-backed store that
// imports `next/headers`, which must never be pulled into the client bundle. This
// module (client-reachable via the availability/catalog components) stays free of
// that dependency. See ./orders.
