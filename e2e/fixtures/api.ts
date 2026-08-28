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

/**
 * A distinct client address for one test's fixture traffic.
 *
 * The public endpoints are rate-limited per `client IP + tenant + route`
 * (apps/api/src/middleware/rate-limit.ts). Nothing on this machine sets
 * `x-forwarded-for`, so without this every request — the fixtures' AND the two Next
 * servers' server-side calls on behalf of the browser — collapses into one `unknown`
 * bucket with a single 30-per-minute budget. The fixtures then spend the budget the
 * BROWSER needs, and the guest's own page load comes back 429; the account page turns
 * any error into "We could not find a booking matching that link", so the symptom is a
 * reschedule that fails as if the order had vanished.
 *
 * A test harness is not one abusive client, it is many independent guests, so each
 * test's client says who it is. The limiter itself is untouched and still enforced —
 * `withRateLimitRetry` below honours a 429 exactly as before.
 */
export function makeClientIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 254);
  return `10.${octet()}.${octet()}.${octet()}`;
}

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

/**
 * A slot as the CANONICAL availability endpoint reports it.
 *
 * `/api/activities/:id/availability` (the shape the customer portal consumes) drops
 * `limitedBy`, so a spec reading it cannot tell "this slot has four seats left" from
 * "this slot has four seats left because a shared boat is out". `/api/availability`
 * keeps it, and a spec that needs inventory nothing else is contending for has to be
 * able to ask that question — see `docs/TESTING.md`, "What a spec guarantees about its
 * own data".
 */
export interface TimeslotView extends Omit<AvailabilitySlot, 'timeslotId'> {
  id: string;
  isOvernight: boolean;
  available: boolean;
  limitedBy: { kind: 'RESOURCE'; resourceId: string; resourceName: string; reason: string } | null;
  unavailableReason: string | null;
}

/** What a staff timeslot generation actually wrote. */
export interface GeneratedTimeslots {
  activityId: string;
  timezone: string;
  created: number;
  daysGenerated: number;
  daysSkipped: number;
}

/** The payment simulator's scripted-outcome queue for this tenant. */
export interface PaymentQueue {
  /** What the next charge will do — `SUCCEEDED` when nothing is scripted. */
  nextOutcome: string;
  /** True when an instruction is waiting to be popped. */
  scripted: boolean;
  queue: Array<{ id: string; outcome: string; note?: string | null }>;
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
  constructor(
    private readonly request: APIRequestContext,
    /** This client's address, so its traffic has its own rate-limit budget. */
    private readonly clientIp: string = makeClientIp(),
  ) {}

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

  /**
   * One day's slots from the canonical availability endpoint, including why a slot's
   * capacity is what it is (`limitedBy`).
   */
  async timeslots(activityId: string, date: string): Promise<TimeslotView[]> {
    const { timeslots } = await this.get<{ timeslots: TimeslotView[] }>(
      `/api/availability?activityId=${encodeURIComponent(activityId)}&date=${date}`,
    );
    return timeslots;
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

  /**
   * Create timeslots for one activity over a date range, through the same staff
   * endpoint an operator uses to open their season.
   *
   * This is how a spec gets inventory it owns instead of eating the seed's. Keep the
   * window one hour wide (`openHour: h, closeHour: h + 1, intervalMinutes: 60`) and it
   * writes exactly one slot per day. `skipExistingDays` must be false for that: a
   * seeded day already has slots, and the default would skip it and silently give you
   * nothing back.
   */
  async generateTimeslots(input: {
    activityId: string;
    from: string;
    to: string;
    openHour: number;
    closeHour: number;
    intervalMinutes: number;
    capacityTotal: number;
    skipExistingDays?: boolean;
  }): Promise<GeneratedTimeslots> {
    return this.post<GeneratedTimeslots>(
      '/api/availability/generate',
      { skipExistingDays: false, ...input },
      true,
    );
  }

  /**
   * Cancel an order, which restores its timeslots' capacity and releases any shared
   * resource it held. This is how a spec gives back the inventory it took.
   */
  async cancelOrder(orderId: string, reason: string): Promise<void> {
    const res = await this.request.post(
      `${API_URL}/api/orders/${encodeURIComponent(orderId)}/cancel`,
      { headers: this.headers(true), data: { reason }, failOnStatusCode: false },
    );
    // An order a spec already cancelled or refunded comes back 409; that is the state
    // we wanted, not a failure. Anything else is worth seeing in the run log, because
    // it means capacity stayed spent.
    if (!res.ok() && res.status() !== 409) {
      console.warn(`[e2e] could not release order ${orderId}: ${res.status()}`);
    }
  }

  // --- Payment simulator (Local Console's outcome queue) ---------------------

  /** What the simulator will do to the next charge on this tenant. */
  async paymentQueue(): Promise<PaymentQueue> {
    return this.get<PaymentQueue>('/api/sandbox/payments/queue');
  }

  /**
   * Drop every scripted outcome. The queue is per-OPERATOR global state, so an
   * instruction a previous spec queued and never consumed is a live trap for the next
   * booking anyone makes.
   */
  async clearPaymentQueue(): Promise<number> {
    const { cleared } = await this.delete<{ cleared: number }>('/api/sandbox/payments/queue');
    return cleared;
  }

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
      'x-forwarded-for': this.clientIp,
      ...(staff ? { 'x-dev-staff-id': STAFF_ID } : {}),
    };
  }

  private async get<T>(path: string, staff = false): Promise<T> {
    return this.send<T>('GET', path, () =>
      this.request.get(`${API_URL}${path}`, {
        headers: this.headers(staff),
        failOnStatusCode: false,
      }),
    );
  }

  /**
   * A write that honours the rate limiter, like the reads do.
   *
   * `POST /api/orders` sits behind the same 30-per-minute budget as the lookups, and a
   * 429 there used to surface as a fixture throwing mid-arrangement — a spec reported
   * as broken because the harness was impatient. Retrying a REJECTED request creates
   * nothing twice: the limiter answers before the handler runs.
   */
  private async post<T>(path: string, body: unknown, staff = false): Promise<T> {
    return this.send<T>('POST', path, () =>
      this.request.post(`${API_URL}${path}`, {
        headers: this.headers(staff),
        data: body as Record<string, unknown>,
        failOnStatusCode: false,
      }),
    );
  }

  private async delete<T>(path: string, staff = false): Promise<T> {
    return this.send<T>('DELETE', path, () =>
      this.request.delete(`${API_URL}${path}`, {
        headers: this.headers(staff),
        failOnStatusCode: false,
      }),
    );
  }

  private async send<T>(
    method: string,
    path: string,
    call: () => Promise<APIResponse>,
  ): Promise<T> {
    return withRateLimitRetry<T>(async () => {
      const res = await call();
      if (res.status() === 429) {
        const body = (await res.json().catch(() => ({}))) as { retryAfterSeconds?: number };
        return { status: 429, retryAfterSeconds: body.retryAfterSeconds };
      }
      return { status: res.status(), value: await this.unwrap<T>(res, method, path) };
    });
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
