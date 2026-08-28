/**
 * A thin, typed client for the local API, used by fixtures to derive and create their
 * own test data.
 *
 * Why the API and not the database: the suite has to run from a checkout with nothing
 * but this repo (docs/LOCAL-FIRST-BUILD.md §0), and reaching into Postgres from the
 * test process would mean a Prisma client, a second connection pool, and a way to lose
 * RLS. Every call here goes through the same tenant-scoped, RLS-enforced surface the
 * product itself uses — which also means a fixture cannot accidentally set up state the
 * product could never produce.
 *
 * Two identities are available: the anonymous customer (default) and the local staff
 * shim (`x-dev-staff-id`), which the API only honours while REQUIRE_CLERK_AUTH is off.
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { API_URL, OPERATOR_SLUG, STAFF_ID } from '../config';

// --- Wire shapes (mirrors of the API's JSON, not imports) --------------------
// Deliberately re-declared rather than imported from @marina/types: an e2e suite that
// shares types with the app under test cannot catch a contract change, it just
// compiles differently.

export interface CatalogRate {
  id: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
}

export interface CatalogActivity {
  id: string;
  name: string;
  category: string;
  maxParticipants: number;
  color: string;
  photoUrls: string[];
  waiverRequired: boolean;
  hidePrice?: boolean;
  fromPriceCents: number | null;
  rates: CatalogRate[];
}

export interface ActivityDetail extends CatalogActivity {
  minParticipants: number;
  descriptionHtml: string | null;
  selfRescheduleHours: number;
}

export interface AvailabilitySlot {
  timeslotId: string;
  /** ISO 8601 UTC instant of the slot start. */
  datetime: string;
  capacityTotal: number;
  capacityBooked: number;
  capacityRemaining: number;
  status: 'AVAILABLE' | 'FILLING_UP' | 'FULL';
}

export interface AvailabilityDay {
  activityId: string;
  date: string;
  slots: AvailabilitySlot[];
}

export interface OrderLineItem {
  id: string;
  activityId: string;
  activityName: string;
  rateName: string;
  datetime: string;
  quantity: number;
  unitPriceCents: number;
  /** Per-item lifecycle — this is what check-in and no-show move. */
  status: 'UPCOMING' | 'CHECKED_IN' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
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

export interface OperatorPublic {
  slug: string;
  name: string;
  brand_color: string;
  timezone: string;
}

export interface BookingRequest {
  activityId: string;
  rateId: string;
  timeslotId: string;
  quantity: number;
  customer: { first_name: string; last_name: string; email: string; phone?: string };
  participants?: Array<{ driver_name: string; license?: string; dob?: string }>;
  promoCode?: string;
  tipCents?: number;
  /**
   * Durable double-submit guard (docs/LOCAL-FIRST-BUILD.md §5). Sent on both the
   * booking and the charge so a replayed submit resolves to the SAME order rather than
   * a second one.
   */
  idempotencyKey?: string;
}

/** An error carrying the status and body, so a failing fixture says what the API said. */
/**
 * Wait out a 429 and try again.
 *
 * The public endpoints are rate-limited per IP (30/min) on purpose — that is a real
 * protection and the suite must not ask for it to be relaxed. Against a production
 * build the suite runs fast enough to trip it, so the harness behaves like a
 * well-mannered client instead: honour the `retryAfterSeconds` the API hands back.
 */
async function withRateLimitRetry<T>(
  attempt: () => Promise<{ status: number; retryAfterSeconds?: number; value?: T }>,
  tries = 4,
): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const res = await attempt();
    if (res.status !== 429) return res.value as T;
    const waitMs = Math.max(1000, (res.retryAfterSeconds ?? 1) * 1000) * (i + 1);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error('Still rate-limited after retries');
}

export class ApiCallError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body.slice(0, 500)}`);
    this.name = 'ApiCallError';
  }
}

export class MarinaApi {
  constructor(private readonly request: APIRequestContext) {}

  // --- Public surface --------------------------------------------------------

  async operator(): Promise<OperatorPublic> {
    return this.get<OperatorPublic>('/api/operator/public');
  }

  async catalog(): Promise<CatalogActivity[]> {
    const { activities } = await this.get<{ activities: CatalogActivity[] }>('/api/activities');
    return activities;
  }

  async activity(id: string): Promise<ActivityDetail> {
    const { activity } = await this.get<{ activity: ActivityDetail }>(
      `/api/activities/${encodeURIComponent(id)}`,
    );
    return activity;
  }

  async availability(activityId: string, date: string): Promise<AvailabilityDay> {
    return this.get<AvailabilityDay>(
      `/api/activities/${encodeURIComponent(activityId)}/availability?date=${date}`,
    );
  }

  async order(orderNumber: string): Promise<OrderSummary> {
    const { order } = await this.get<{ order: RawOrder }>(
      `/api/orders/${encodeURIComponent(orderNumber)}`,
    );
    return flattenOrder(order);
  }

  /** Null instead of a throw for the 404 case, so a spec can assert absence. */
  async findOrder(orderNumber: string): Promise<OrderSummary | null> {
    const res = await this.request.get(`${API_URL}/api/orders/${encodeURIComponent(orderNumber)}`, {
      headers: this.headers(),
    });
    if (res.status() === 404) return null;
    const { order } = await this.unwrap<{ order: RawOrder }>(res, 'GET', `/api/orders/${orderNumber}`);
    return flattenOrder(order);
  }

  /** Create a booking. Returns the order exactly as the customer flow would have made it. */
  async createBooking(input: BookingRequest): Promise<OrderSummary> {
    const { order } = await this.post<{ order: RawOrder }>('/api/orders', input);
    return flattenOrder(order);
  }

  /** Charge the order's outstanding balance through whichever payment driver is active. */
  async charge(
    orderId: string,
    options: { sourceId?: string; amountCents?: number; idempotencyKey?: string } = {},
  ): Promise<{ payment: { id: string; status: string; amountCents: number }; order: { balanceDueCents: number } }> {
    return this.post('/api/payments/charge', {
      orderId,
      sourceId: options.sourceId ?? 'dev_pm_e2e',
      ...(options.amountCents === undefined ? {} : { amountCents: options.amountCents }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
  }

  /**
   * Raw POST that resolves on ANY status. The double-submit spec needs to inspect two
   * competing responses, one of which is expected to be a rejection.
   */
  async rawPost(path: string, body: unknown, staff = false): Promise<APIResponse> {
    return this.request.post(`${API_URL}${path}`, {
      headers: this.headers(staff),
      data: body as Record<string, unknown>,
      failOnStatusCode: false,
    });
  }

  /** Raw GET that resolves on any status, for assertions about a response itself. */
  async rawGet(path: string, staff = false): Promise<APIResponse> {
    return this.request.get(`${API_URL}${path}`, {
      headers: this.headers(staff),
      failOnStatusCode: false,
    });
  }

  /**
   * Every order belonging to one customer email, through the staff order list.
   *
   * The suite's guest emails are unique per run, which makes this a precise answer to
   * "did the product create anything at all for this person" — the question the decline
   * and double-submit specs have to answer without reaching into Postgres.
   */
  async ordersForEmail(email: string): Promise<OrderSummary[]> {
    const { orders } = await this.get<{ orders: RawOrder[] }>(
      `/api/orders?search=${encodeURIComponent(email)}&limit=50`,
      true,
    );
    return orders.map(flattenOrder);
  }

  // --- Staff surface (local dev shim) ----------------------------------------

  /** Create a promo code owned by this run, so no spec depends on what the seed shipped. */
  async createPromo(input: {
    code: string;
    name: string;
    discount_type: 'PERCENT' | 'FLAT';
    discount_value: number;
    activity_ids?: string[];
  }): Promise<{ id: string; code: string }> {
    const { promo } = await this.post<{ promo: { id: string; code: string } }>(
      '/api/promos',
      { type: 'ONE_CODE', is_active: true, activity_ids: [], ...input },
      true,
    );
    return promo;
  }

  /** Deactivate a promo so repeated runs cannot pile up live codes on the tenant. */
  async deactivatePromo(id: string): Promise<void> {
    const res = await this.request.patch(`${API_URL}/api/promos/${encodeURIComponent(id)}`, {
      headers: this.headers(true),
      data: { is_active: false },
      failOnStatusCode: false,
    });
    // Best effort: a failed cleanup must not fail an otherwise-passing spec, but it
    // should be visible in the run log rather than silent.
    if (!res.ok()) {
      console.warn(`[e2e] could not deactivate promo ${id}: ${res.status()}`);
    }
  }

  // --- Plumbing --------------------------------------------------------------

  private headers(staff = false): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-operator-slug': OPERATOR_SLUG,
      ...(staff ? { 'x-dev-staff-id': STAFF_ID } : {}),
    };
  }

  private async get<T>(path: string, staff = false): Promise<T> {
    return withRateLimitRetry<T>(async () => {
      const res = await this.request.get(`${API_URL}${path}`, {
        headers: this.headers(staff),
        failOnStatusCode: false,
      });
      if (res.status() === 429) {
        const body = (await res.json().catch(() => ({}))) as { retryAfterSeconds?: number };
        return { status: 429, retryAfterSeconds: body.retryAfterSeconds };
      }
      return { status: res.status(), value: await this.unwrap<T>(res, 'GET', path) };
    });
  }

  private async post<T>(path: string, body: unknown, staff = false): Promise<T> {
    const res = await this.request.post(`${API_URL}${path}`, {
      headers: this.headers(staff),
      data: body as Record<string, unknown>,
      failOnStatusCode: false,
    });
    return this.unwrap<T>(res, 'POST', path);
  }

  private async unwrap<T>(res: APIResponse, method: string, path: string): Promise<T> {
    if (!res.ok()) {
      throw new ApiCallError(method, path, res.status(), await res.text());
    }
    return (await res.json()) as T;
  }
}

// --- Order shape ------------------------------------------------------------

/** The nested JSON `serializeOrder` returns; flattened below into `OrderSummary`. */
interface RawOrder {
  id: string;
  orderNumber: string;
  status: OrderSummary['status'];
  customer: { firstName: string; lastName: string; email: string; phone?: string | null };
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  processingFeeCents: number;
  tipCents: number;
  totalCents: number;
  amountPaidCents: number;
  balanceDueCents: number;
  createdAt: string;
  items: Array<{
    id: string;
    quantity: number;
    unitPriceCents: number;
    status: OrderLineItem['status'];
    activity: { id: string; name: string };
    rate: { id: string; name: string };
    timeslot: { id: string; datetime: string };
  }>;
}

function flattenOrder(raw: RawOrder): OrderSummary {
  return {
    id: raw.id,
    orderNumber: raw.orderNumber,
    status: raw.status,
    customerName: [raw.customer.firstName, raw.customer.lastName].filter(Boolean).join(' '),
    customerEmail: raw.customer.email,
    subtotalCents: raw.subtotalCents,
    discountCents: raw.discountCents,
    taxCents: raw.taxCents,
    processingFeeCents: raw.processingFeeCents,
    tipCents: raw.tipCents,
    totalCents: raw.totalCents,
    amountPaidCents: raw.amountPaidCents,
    balanceDueCents: raw.balanceDueCents,
    createdAt: raw.createdAt,
    items: raw.items.map((item) => ({
      id: item.id,
      activityId: item.activity.id,
      activityName: item.activity.name,
      rateName: item.rate.name,
      datetime: item.timeslot.datetime,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      status: item.status,
    })),
  };
}
