/**
 * Seeded, in-memory demo data for the customer portal (see ./config).
 *
 * Everything here is PURE and side-effect free (no next/headers, no I/O) so it is
 * safe to import from client components — the availability picker and catalog run
 * these directly in the browser when DEMO_MODE is on. All money is integer cents.
 *
 * The tenant is Lake Sonoma Marina. Availability is generated deterministically
 * from (activityId, date, hour) so a given day always shows the same slots, and a
 * timeslot id encodes its datetime so an order can recover the booked time without
 * any availability being persisted.
 */
import { calculatePricing } from '@marina/core';
import type {
  ActivityDetail,
  AvailabilityDay,
  AvailabilitySlot,
  CatalogActivity,
  CatalogRate,
  CreateBookingPayload,
  OrderSummary,
  PromoValidation,
  SlotStatus,
} from '@/lib/api';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const UNSPLASH = (id: string) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=60`;

export const DEMO_ACTIVITIES: ActivityDetail[] = [
  {
    id: 'pontoon-boat',
    name: 'Pontoon Boat Rental',
    category: 'BOAT',
    maxParticipants: 10,
    minParticipants: 1,
    color: '#0369a1',
    photoUrls: [UNSPLASH('photo-1567899378494-47b22a2ae96a')],
    waiverRequired: true,
    descriptionHtml:
      '<p>Cruise Lake Sonoma in a spacious 10-person pontoon — shade top, cooler, and Bluetooth speakers included. Perfect for a family day on the water.</p>',
    selfRescheduleHours: 24,
    fromPriceCents: 18000,
    rates: [
      { id: 'pontoon-half', name: 'Half day (4 hours)', priceCents: 18000, durationMinutes: 240 },
      { id: 'pontoon-full', name: 'Full day (8 hours)', priceCents: 32000, durationMinutes: 480 },
    ],
  },
  {
    id: 'fishing-boat',
    name: 'Fishing Boat Rental',
    category: 'BOAT',
    maxParticipants: 4,
    minParticipants: 1,
    color: '#0f766e',
    photoUrls: [UNSPLASH('photo-1516132006923-6cf348e5dee2')],
    waiverRequired: true,
    descriptionHtml:
      '<p>A rigged aluminum fishing boat with trolling motor and live well. Lake Sonoma is known for its bass and catfish — bring your gear or rent ours.</p>',
    selfRescheduleHours: 24,
    fromPriceCents: 12000,
    rates: [
      { id: 'fishing-half', name: 'Half day (4 hours)', priceCents: 12000, durationMinutes: 240 },
      { id: 'fishing-full', name: 'Full day (8 hours)', priceCents: 20000, durationMinutes: 480 },
    ],
  },
  {
    id: 'double-kayak',
    name: 'Double Kayak',
    category: 'WATERCRAFT',
    maxParticipants: 2,
    minParticipants: 1,
    color: '#ca8a04',
    photoUrls: [UNSPLASH('photo-1545579133-99bb5ab189bd')],
    waiverRequired: false,
    descriptionHtml:
      '<p>A stable tandem sit-on-top kayak with paddles and life vests. Explore the coves and inlets at your own pace.</p>',
    selfRescheduleHours: 12,
    fromPriceCents: 4500,
    rates: [
      { id: 'kayak-2h', name: '2-hour rental', priceCents: 4500, durationMinutes: 120 },
      { id: 'kayak-4h', name: 'Half day (4 hours)', priceCents: 7000, durationMinutes: 240 },
    ],
  },
  {
    id: 'paddleboard',
    name: 'Stand-Up Paddleboard',
    category: 'WATERCRAFT',
    maxParticipants: 1,
    minParticipants: 1,
    color: '#0891b2',
    photoUrls: [UNSPLASH('photo-1526188717906-ab4a2f949f6b')],
    waiverRequired: false,
    descriptionHtml:
      '<p>An inflatable premium SUP with adjustable paddle and leash. Calm morning water is ideal for beginners.</p>',
    selfRescheduleHours: 12,
    fromPriceCents: 4000,
    rates: [
      { id: 'sup-2h', name: '2-hour rental', priceCents: 4000, durationMinutes: 120 },
      { id: 'sup-day', name: 'All day', priceCents: 6500, durationMinutes: 480 },
    ],
  },
  {
    id: 'lakeside-cabana',
    name: 'Lakeside Cabana',
    category: 'PATIO',
    maxParticipants: 8,
    minParticipants: 1,
    color: '#b45309',
    photoUrls: [UNSPLASH('photo-1439066615861-d1af74d74000')],
    waiverRequired: false,
    descriptionHtml:
      '<p>A reserved shaded cabana on the marina deck with lounge seating, a table, and a private grill. Book the spot, bring the crew.</p>',
    selfRescheduleHours: 24,
    fromPriceCents: 9000,
    rates: [
      { id: 'cabana-half', name: 'Half day (4 hours)', priceCents: 9000, durationMinutes: 240 },
      { id: 'cabana-full', name: 'Full day (8 hours)', priceCents: 15000, durationMinutes: 480 },
    ],
  },
  {
    id: 'sunset-lake-tour',
    name: 'Sunset Lake Tour',
    category: 'TOUR',
    maxParticipants: 12,
    minParticipants: 1,
    color: '#9333ea',
    photoUrls: [UNSPLASH('photo-1502209524164-acea936639a2')],
    waiverRequired: false,
    descriptionHtml:
      '<p>A guided 90-minute cruise across Lake Sonoma as the sun goes down, with local history and wildlife spotting. Light refreshments included.</p>',
    selfRescheduleHours: 48,
    fromPriceCents: 5500,
    rates: [
      { id: 'tour-adult', name: 'Adult', priceCents: 5500, durationMinutes: 90 },
      { id: 'tour-child', name: 'Child (under 12)', priceCents: 3000, durationMinutes: 90 },
    ],
  },
];

function toCatalog(a: ActivityDetail): CatalogActivity {
  return {
    id: a.id,
    name: a.name,
    category: a.category,
    maxParticipants: a.maxParticipants,
    color: a.color,
    photoUrls: a.photoUrls,
    waiverRequired: a.waiverRequired,
    fromPriceCents: a.fromPriceCents,
    rates: a.rates,
  };
}

export function getDemoCatalog(): CatalogActivity[] {
  return DEMO_ACTIVITIES.map(toCatalog);
}

export function getDemoActivity(id: string): ActivityDetail | null {
  return DEMO_ACTIVITIES.find((a) => a.id === id) ?? null;
}

function findActivity(id: string): ActivityDetail | null {
  return getDemoActivity(id);
}

export function resolveRate(activityId: string, rateId: string): CatalogRate | null {
  const a = findActivity(activityId);
  return a?.rates.find((r) => r.id === rateId) ?? null;
}

// ---------------------------------------------------------------------------
// Availability (deterministic, generated from activity + date)
// ---------------------------------------------------------------------------

/** Small, stable string hash — deterministic across server and client. */
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const SLOT_HOURS = [9, 10, 11, 12, 13, 14, 15, 16];
const SEP = '__';

/** timeslot id encodes its datetime so an order can recover the booked time. */
function makeTimeslotId(activityId: string, datetime: string): string {
  return `slot${SEP}${activityId}${SEP}${datetime}`;
}

/** Recover { activityId, datetime } from a demo timeslot id. */
export function parseTimeslotId(
  timeslotId: string,
): { activityId: string; datetime: string } | null {
  const parts = timeslotId.split(SEP);
  if (parts.length !== 3 || parts[0] !== 'slot') return null;
  return { activityId: parts[1]!, datetime: parts[2]! };
}

function slotStatus(remaining: number, total: number): SlotStatus {
  if (remaining <= 0) return 'FULL';
  if (remaining <= Math.max(1, Math.floor(total * 0.34))) return 'FILLING_UP';
  return 'AVAILABLE';
}

export function getDemoAvailability(activityId: string, isoDate: string): AvailabilityDay {
  const activity = findActivity(activityId);
  const capacityTotal = activity ? Math.max(2, activity.maxParticipants) : 8;

  const slots: AvailabilitySlot[] = SLOT_HOURS.map((hour) => {
    // Offset-less ISO: parsed as local wall-clock on both server (UTC) and the
    // browser, so the displayed time is the same everywhere and stays sensible.
    const datetime = `${isoDate}T${String(hour).padStart(2, '0')}:00:00`;
    const seed = hash(`${activityId}|${isoDate}|${hour}`);
    // Deterministically book somewhere between 0 and capacityTotal seats.
    const booked = seed % (capacityTotal + 1);
    const remaining = Math.max(0, capacityTotal - booked);
    return {
      timeslotId: makeTimeslotId(activityId, datetime),
      datetime,
      capacityTotal,
      capacityBooked: booked,
      capacityRemaining: remaining,
      status: slotStatus(remaining, capacityTotal),
    };
  });

  return { activityId, date: isoDate, slots };
}

// ---------------------------------------------------------------------------
// Promos
// ---------------------------------------------------------------------------

export function getDemoPromo(code: string, _activityId: string): PromoValidation {
  const normalized = code.trim().toUpperCase();
  if (normalized === 'SONOMA10') {
    return { valid: true, code: normalized, discountType: 'PERCENT', discountValue: 10 };
  }
  if (normalized === 'LAKE20') {
    return { valid: true, code: normalized, discountType: 'FLAT', discountValue: 2000 };
  }
  return {
    valid: false,
    code: normalized,
    discountType: 'PERCENT',
    discountValue: 0,
    reason: 'That promo code is not recognized. Try SONOMA10 for 10% off.',
  };
}

// ---------------------------------------------------------------------------
// Order computation
// ---------------------------------------------------------------------------

function orderNumber(): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LSM-${rand}`;
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Build a full OrderSummary from a booking payload — pure, no persistence. Totals
 * use the same `@marina/core` `calculatePricing` the checkout screen uses (fees
 * shown as an estimate there), so the confirmation total matches what the guest
 * saw. Promo discount is recomputed here, never trusted from the client.
 */
export function computeDemoOrder(payload: CreateBookingPayload): OrderSummary {
  const activity = findActivity(payload.activityId);
  const rate = resolveRate(payload.activityId, payload.rateId);
  const parsed = parseTimeslotId(payload.timeslotId);

  const unitPriceCents = rate?.priceCents ?? 0;
  const quantity = Math.max(1, payload.quantity);

  const promo = payload.promoCode
    ? getDemoPromo(payload.promoCode, payload.activityId)
    : null;

  const pricing = calculatePricing({
    items: [{ unitPriceCents, quantity }],
    fees: [],
    promo:
      promo && promo.valid
        ? { discountType: promo.discountType, discountValue: promo.discountValue }
        : null,
    tipCents: payload.tipCents ?? 0,
  });

  const now = new Date().toISOString();
  const datetime = parsed?.datetime ?? now;

  return {
    id: id('order'),
    orderNumber: orderNumber(),
    status: 'UPCOMING',
    customerName: `${payload.customer.first_name} ${payload.customer.last_name}`.trim(),
    customerEmail: payload.customer.email,
    subtotalCents: pricing.subtotalCents,
    discountCents: pricing.discountCents,
    taxCents: pricing.taxCents,
    processingFeeCents: pricing.processingFeeCents,
    tipCents: pricing.tipCents,
    totalCents: pricing.totalCents,
    amountPaidCents: 0,
    balanceDueCents: pricing.totalCents,
    items: [
      {
        id: id('item'),
        activityId: payload.activityId,
        activityName: activity?.name ?? 'Reservation',
        rateName: rate?.name ?? 'Standard',
        datetime,
        durationMinutes: rate?.durationMinutes ?? 60,
        quantity,
        unitPriceCents,
      },
    ],
    createdAt: now,
  };
}
