/**
 * Seed: sync the Lake Sonoma (operator "lsra") catalog to the signed contract at
 * docs/lakesonoma-catalog.json.
 *
 * WHY THIS EXISTS
 * ---------------
 * The base seed (prisma/seed.ts) generates rates from a single "from" price with
 * a formula, which produced wrong prices, phantom tiers (Two Hour, Overnight),
 * hidden hourly rates, a $150 Grand Patio that should be "Inquire", and it omits
 * two boats entirely (Logic Fishing Boat, Quest Fishing Pontoon). It also never
 * wires real photos, add-ons, or descriptions. This script is the source of truth
 * for the lsra catalog: it makes the DB match the contract exactly.
 *
 * IDEMPOTENT + SAFE TO RE-RUN
 * ---------------------------
 *  - Activities are upserted by slug (stored in Activity.config->>'slug').
 *  - Rates are reconciled by (activity, name_internal): updated in place, created
 *    when missing, and pruned when no longer in the contract — but a rate that is
 *    referenced by an existing OrderItem is NEVER deleted (RESTRICT FK), it is
 *    only deactivated, so dogfooded bookings survive a re-run.
 *  - Add-ons (PackageUpsell) are reconciled by name.
 *  - Fees (day-use + passes) are reconciled by name.
 *  - Timeslots: this only ADDS missing future slots so 60+ future days exist for
 *    every activity; it never deletes slots (orders hang off them).
 *  - It NEVER deletes orders, bookings, payments, or the operator.
 *
 * Photos are copied out-of-band into the API's local upload store
 * (.sandbox/uploads/lsra/activity/<md5(slug)>.jpg) by the companion script
 * scripts/copy-lakesonoma-photos.sh; this script wires each activity's
 * photo_urls to the API serve URL that reads those bytes. No singenuity or
 * cloudinary URL is ever written for this tenant.
 *
 * Usage (from repo root, with .env loaded):
 *   bash packages/database/scripts/copy-lakesonoma-photos.sh   # 1. put the bytes on disk
 *   cd packages/database \
 *     && node --experimental-strip-types scripts/seed-lakesonoma-catalog.ts   # 2. sync the DB
 */
import { createHash } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';

// Connect as the DB owner (DATABASE_URL), matching the other maintenance scripts
// (apply-rls, seed). We set app.current_operator_id inside the transaction so the
// writes still exercise / satisfy the RLS tenant scope.
const adminPrisma = new PrismaClient();

const OP_ID = 'lsra';

/**
 * Base URL for uploads. Default is RELATIVE (`/uploads/...`) so the stored URL
 * works from whatever origin the app is reached on (localhost, a WSL IP, the LAN,
 * a real domain) — each app proxies `/uploads/*` to the API the same way it
 * proxies `/api/*`. Set PUBLIC_UPLOAD_BASE_URL only for a real CDN/bucket.
 */
const UPLOAD_BASE = process.env.PUBLIC_UPLOAD_BASE_URL?.trim() || '';

/** Deterministic stored name, matching the copied files: md5(slug) + .jpg. */
function photoUrlFor(slug: string): string {
  const hex = createHash('md5').update(slug).digest('hex'); // 32 hex chars
  return `${UPLOAD_BASE.replace(/\/+$/, '')}/uploads/${OP_ID}/activity/${hex}.jpg`;
}

const dollars = (n: number) => Math.round(n) * 100;

type Cat = 'BOAT' | 'WATERCRAFT' | 'PATIO';

interface Tier {
  name_internal: string;
  name_external: string;
  minutes: number;
  amount: number; // USD whole dollars
  is_from_price?: boolean;
}

interface Product {
  slug: string;
  singenuityId: number;
  name: string;
  category: Cat;
  categoryLabel: string;
  maxCap: number;
  color: string;
  featured: boolean;
  bookByPhone: boolean;
  priceTBD: boolean;
  blurb: string;
  addOns: string[];
  tiers: Tier[];
  /** sort bucket for catalog grouping (see CATEGORY_ORDER). */
  group: string;
  /**
   * name_external values the base seed (prisma/seed.ts) used for this activity,
   * so the FIRST run of this sync ADOPTS the existing row (tagging it with
   * config.slug) instead of creating a duplicate. Later runs match by slug.
   */
  legacyNames?: string[];
}

/** Standard boat tier durations. */
const T = {
  // NOTE: name_external is the customer-facing label. It must match the marketing
  // site (data/marina.ts in the LakeSonoma repo) exactly, since customers read the
  // site first: "1 hour" / "4 hours" / "8 hours" / "24 hours" / "Per day". The
  // name_internal keys are the staff-facing labels and the idempotent reconcile key
  // for this script, so they stay stable regardless of the public relabel.
  hour: (amount: number, from = false): Tier => ({
    name_internal: 'One Hour',
    name_external: '1 hour',
    minutes: 60,
    amount,
    is_from_price: from,
  }),
  half: (amount: number, from = false): Tier => ({
    name_internal: 'Half Day',
    name_external: '4 hours',
    minutes: 240,
    amount,
    is_from_price: from,
  }),
  full: (amount: number): Tier => ({
    name_internal: 'Full Day',
    name_external: '8 hours',
    minutes: 480,
    amount,
  }),
  overnight: (amount: number): Tier => ({
    name_internal: 'Overnight',
    name_external: '24 hours',
    minutes: 1440,
    amount,
  }),
  perDay: (amount: number, from = true): Tier => ({
    name_internal: 'Full Day',
    name_external: 'Per day',
    minutes: 480,
    amount,
    is_from_price: from,
  }),
};

/**
 * Category grouping for catalog sort_index, in the contract's intended order:
 * pontoons, then watersport, then sport, then fishing, then jetski, then paddle,
 * then patios.
 */
const CATEGORY_ORDER = ['pontoon', 'watersport', 'sport', 'fishing', 'jetski', 'paddle', 'patio'];

/** The catalog contract, transcribed from docs/lakesonoma-catalog.json. */
const PRODUCTS: Product[] = [
  {
    slug: 'pontoon-5-person', singenuityId: 3624, name: '5-Person Pontoon',
    category: 'BOAT', categoryLabel: 'Pontoon Boats', maxCap: 5, color: '#0ea5e9',
    featured: true, bookByPhone: false, priceTBD: false, group: 'pontoon',
    blurb: 'Enjoy a leisurely float on Lake Sonoma with a fun pontoon boat rental — our most popular small-group boat, easy to drive and perfect for a relaxed cruise.',
    addOns: ['Performance Water Ski', 'Knee Board', 'Wake Board', 'Tube'],
    tiers: [T.hour(125, true), T.half(350), T.full(625), T.overnight(1000)],
    legacyNames: ['5 Person Pontoon Boat Rental'],
  },
  {
    slug: 'pontoon-10-person', singenuityId: 3633, name: '10-Person Pontoon',
    category: 'BOAT', categoryLabel: 'Pontoon Boats', maxCap: 10, color: '#0ea5e9',
    featured: true, bookByPhone: false, priceTBD: false, group: 'pontoon',
    blurb: 'A roomy pontoon with space for the whole crew to spread out and enjoy a day on the water.',
    addOns: ['Performance Water Ski', 'Knee Board', 'Wake Board', 'Tube'],
    tiers: [T.hour(135, true), T.half(420), T.full(750), T.overnight(1000)],
    legacyNames: ['10 Person Pontoon Rental'],
  },
  {
    slug: 'pontoon-12-person', singenuityId: 3634, name: '12-Person Pontoon',
    category: 'BOAT', categoryLabel: 'Pontoon Boats', maxCap: 12, color: '#0ea5e9',
    featured: false, bookByPhone: false, priceTBD: false, group: 'pontoon',
    blurb: 'Our big-group pontoon for a fun time on Lake Sonoma with the whole family.',
    addOns: ['Performance Water Ski', 'Knee Board', 'Wake Board', 'Tube'],
    tiers: [T.hour(160, true), T.half(520), T.full(900), T.overnight(1300)],
    legacyNames: ['12 Person Pontoon Boat Rental'],
  },
  {
    slug: 'pontoon-double-decker', singenuityId: 3635, name: 'Double Decker Pontoon (12)',
    category: 'BOAT', categoryLabel: 'Pontoon Boats', maxCap: 12, color: '#0284c7',
    featured: true, bookByPhone: false, priceTBD: false, group: 'pontoon',
    blurb: 'Two levels of fun — our double-decker pontoon is a Lake Sonoma favorite for groups up to 12, complete with a slide-friendly upper deck view.',
    addOns: ['Performance Water Ski', 'Knee Board', 'Wake Board', 'Tube'],
    tiers: [T.hour(185, true), T.half(585), T.full(995), T.overnight(1300)],
    legacyNames: ['Double Decker Pontoon Rental'],
  },
  {
    slug: 'pontoon-premium-10', singenuityId: 3636, name: 'Premium 10-Passenger Pontoon',
    category: 'BOAT', categoryLabel: 'Pontoon Boats', maxCap: 10, color: '#0284c7',
    featured: false, bookByPhone: false, priceTBD: false, group: 'pontoon',
    blurb: 'A premium single-story pontoon with upgraded comfort for up to 10 guests.',
    addOns: ['Performance Water Ski', 'Knee Board', 'Wake Board', 'Tube'],
    tiers: [T.hour(200, true), T.half(600), T.full(1100)],
    legacyNames: ['Premium 10P Single Story Pontoon'],
  },
  {
    slug: 'quest-fishing-pontoon', singenuityId: 0, name: 'Quest Fishing Pontoon (3)',
    category: 'BOAT', categoryLabel: 'Pontoon Boats', maxCap: 3, color: '#0284c7',
    featured: false, bookByPhone: true, priceTBD: false, group: 'pontoon',
    blurb: 'A nimble fishing pontoon built for casting a line on Lake Sonoma — stable, easy to drive, and ideal for a small fishing party. Call the marina to reserve.',
    addOns: ['Performance Water Ski', 'Knee Board', 'Wake Board', 'Tube'],
    tiers: [T.hour(100, true), T.half(375), T.full(600)],
  },
  {
    slug: 'watersport-tubing', singenuityId: 3637, name: 'Watersport / Tubing Boat (7)',
    category: 'BOAT', categoryLabel: 'Watersport / Tubing', maxCap: 7, color: '#2563eb',
    featured: true, bookByPhone: false, priceTBD: false, group: 'watersport',
    blurb: "For some great tubing and watersports on Lake Sonoma, don't miss this boat that lets you enjoy the water for a half or a full day.",
    addOns: ['Performance Water Ski', 'Knee Board', 'Wake Board', 'Tube'],
    tiers: [T.hour(175, true), T.half(600), T.full(1000)],
    legacyNames: ['Watersport/Tubing Boat (7P)'],
  },
  {
    slug: 'premium-sport-boat', singenuityId: 3627, name: 'Premium Sport Ski Boat (8)',
    category: 'BOAT', categoryLabel: 'Sport Boats', maxCap: 8, color: '#2563eb',
    featured: false, bookByPhone: false, priceTBD: false, group: 'sport',
    blurb: 'Enjoy a high-octane adventure over the waters of Lake Sonoma with our premium sport ski boat rental.',
    addOns: ['Performance Water Ski', 'Knee Board', 'Wake Board', 'Tube'],
    tiers: [T.hour(225, true), T.half(700), T.full(1300)],
    legacyNames: ['Premium Sport Boat (8P)'],
  },
  {
    slug: 'logic-fishing-boat', singenuityId: 3641, name: 'Logic Fishing Boat (3)',
    category: 'BOAT', categoryLabel: 'Fishing Boats', maxCap: 3, color: '#0369a1',
    featured: true, bookByPhone: false, priceTBD: false, group: 'fishing',
    blurb: 'Experience the best fishing on Lake Sonoma with hourly, half-day, full-day, or overnight rentals.',
    addOns: [],
    tiers: [T.hour(100, true), T.half(340), T.full(680), T.overnight(750)],
  },
  {
    slug: 'jet-ski', singenuityId: 3643, name: 'Wave Runner (Jet Ski)',
    category: 'WATERCRAFT', categoryLabel: 'Wave Runners', maxCap: 2, color: '#14b8a6',
    featured: true, bookByPhone: false, priceTBD: false, group: 'jetski',
    blurb: 'Have fun speeding over the waters of Lake Sonoma with an exciting Wave Runner (jet ski) rental, available by the hour.',
    addOns: [],
    tiers: [T.hour(150, true)],
    legacyNames: ['Jet Ski Rentals (2P)'],
  },
  {
    slug: 'single-kayak', singenuityId: 3644, name: 'Single Kayak',
    category: 'WATERCRAFT', categoryLabel: 'Kayaks & Paddle Craft', maxCap: 1, color: '#22c55e',
    featured: false, bookByPhone: false, priceTBD: false, group: 'paddle',
    blurb: 'Enjoy paddling on Lake Sonoma with a single kayak, available by the hour or for a half or full day.',
    addOns: [],
    tiers: [T.hour(50, true), T.half(150), T.full(300), T.overnight(300)],
    legacyNames: ['Single Kayak Rental'],
  },
  {
    slug: 'double-kayak', singenuityId: 3645, name: 'Double Kayak',
    category: 'WATERCRAFT', categoryLabel: 'Kayaks & Paddle Craft', maxCap: 2, color: '#22c55e',
    featured: false, bookByPhone: false, priceTBD: false, group: 'paddle',
    blurb: 'Paddle together on Lake Sonoma in a roomy double kayak — by the hour or for a half or full day.',
    addOns: [],
    tiers: [T.hour(50, true), T.half(175), T.full(325), T.overnight(325)],
    legacyNames: ['Double Kayak Rental'],
  },
  {
    slug: 'paddle-board', singenuityId: 3648, name: 'Paddle Board',
    category: 'WATERCRAFT', categoryLabel: 'Kayaks & Paddle Craft', maxCap: 1, color: '#22c55e',
    featured: false, bookByPhone: false, priceTBD: false, group: 'paddle',
    blurb: 'Experience the stunning scenery along the shore of Lake Sonoma with a stand-up paddle board rental.',
    addOns: [],
    tiers: [T.hour(50, true), T.half(150), T.full(300), T.overnight(300)],
    legacyNames: ['Paddle Board Rental'],
  },
  {
    slug: 'canoe', singenuityId: 3650, name: 'Canoe',
    category: 'WATERCRAFT', categoryLabel: 'Kayaks & Paddle Craft', maxCap: 3, color: '#22c55e',
    featured: false, bookByPhone: false, priceTBD: false, group: 'paddle',
    blurb: 'Paddle along the shores of Lake Sonoma with a relaxing canoe rental.',
    addOns: [],
    tiers: [T.hour(50, true), T.half(150), T.full(300), T.overnight(300)],
    legacyNames: ['Canoe Rental (2P)'],
  },
  {
    slug: 'patio-grand', singenuityId: 3651, name: 'Grand Patio',
    category: 'PATIO', categoryLabel: 'Patios & Day-Use', maxCap: 100, color: '#f59e0b',
    featured: false, bookByPhone: false, priceTBD: true, group: 'patio',
    blurb: 'Our largest reservable patio for groups and gatherings on the water.',
    addOns: [],
    tiers: [], // priceTBD: no rate; hide_price -> "Inquire"
    legacyNames: ['Grand Patio'],
  },
  {
    slug: 'patio-bar', singenuityId: 3652, name: 'Bar Patio',
    category: 'PATIO', categoryLabel: 'Patios & Day-Use', maxCap: 50, color: '#f59e0b',
    featured: false, bookByPhone: false, priceTBD: false, group: 'patio',
    blurb: 'Reserve a patio by the bar for an easy lakeside day-use spot.',
    addOns: [],
    tiers: [T.perDay(100)],
    legacyNames: ['Bar Patio'],
  },
  {
    slug: 'patio-scenic', singenuityId: 3653, name: 'Scenic Patio',
    category: 'PATIO', categoryLabel: 'Patios & Day-Use', maxCap: 50, color: '#f59e0b',
    featured: false, bookByPhone: false, priceTBD: false, group: 'patio',
    blurb: 'A scenic reserved patio with lake views.',
    addOns: [],
    tiers: [T.perDay(100)],
    legacyNames: ['Scenic Patio'],
  },
  {
    slug: 'patio-bridge', singenuityId: 3654, name: 'Bridge Patio',
    category: 'PATIO', categoryLabel: 'Patios & Day-Use', maxCap: 20, color: '#f59e0b',
    featured: false, bookByPhone: false, priceTBD: false, group: 'patio',
    blurb: 'Reserved patio near the bridge — a shaded place to gather.',
    addOns: [],
    tiers: [T.perDay(100)],
    legacyNames: ['Bridge Patio'],
  },
  {
    slug: 'patio-lakeside-5', singenuityId: 3655, name: 'Lakeside Patio 5',
    category: 'PATIO', categoryLabel: 'Patios & Day-Use', maxCap: 20, color: '#f59e0b',
    featured: false, bookByPhone: false, priceTBD: false, group: 'patio',
    blurb: 'Lakeside reserved patio for your day on the water.',
    addOns: [],
    tiers: [T.perDay(100)],
    legacyNames: ['Lakeside Patio 5'],
  },
  {
    slug: 'patio-lakeside-6', singenuityId: 3656, name: 'Lakeside Patio 6',
    category: 'PATIO', categoryLabel: 'Patios & Day-Use', maxCap: 20, color: '#f59e0b',
    featured: false, bookByPhone: false, priceTBD: false, group: 'patio',
    blurb: 'Lakeside reserved patio for your day on the water.',
    addOns: [],
    tiers: [T.perDay(100)],
    legacyNames: ['Lakeside Patio 6'],
  },
  {
    slug: 'patio-upper-lakeside-7', singenuityId: 3657, name: 'Upper Lakeside Patio 7',
    category: 'PATIO', categoryLabel: 'Patios & Day-Use', maxCap: 20, color: '#f59e0b',
    featured: false, bookByPhone: false, priceTBD: false, group: 'patio',
    blurb: 'Upper lakeside reserved patio with elevated views.',
    addOns: [],
    tiers: [T.perDay(100)],
    legacyNames: ['Upper Lakeside Patio 7'],
  },
];

/** Equipment add-ons, offered on every boat that lists them. */
interface AddOn {
  name: string;
  tiers: { label: string; amount: number }[];
}
const ADDONS: AddOn[] = [
  { name: 'Performance Water Ski', tiers: [{ label: '1 hr', amount: 30 }, { label: '4 hr', amount: 50 }, { label: '8 hr', amount: 70 }, { label: '24 hr', amount: 100 }] },
  { name: 'Knee Board', tiers: [{ label: '1 hr', amount: 30 }, { label: '4 hr', amount: 50 }, { label: '8 hr', amount: 70 }, { label: '24 hr', amount: 100 }] },
  { name: 'Wake Board', tiers: [{ label: '1 hr', amount: 35 }, { label: '4 hr', amount: 60 }, { label: '8 hr', amount: 100 }, { label: '24 hr', amount: 135 }] },
  { name: 'Tube', tiers: [{ label: '1 hr', amount: 35 }, { label: '4 hr', amount: 60 }, { label: '8 hr', amount: 100 }, { label: '24 hr', amount: 135 }] },
];

/** Day-use fees + passes/storage, seeded as flat Fees (offered at checkout / on the pricing page). */
const DAY_USE_FEES: { name: string; value: number }[] = [
  { name: 'Launch Ramp', value: 25 },
  { name: 'Hand Launch', value: 20 },
  { name: 'Daily Parking', value: 20 },
  { name: 'Annual Ramp Pass', value: 450 },
  { name: 'Annual Day-Use Pass', value: 250 },
  { name: 'Trailer Storage', value: 85 },
];

/** Days of future timeslots we guarantee for every activity. */
const FUTURE_DAYS = 75; // > the 60-day requirement
const SLOT_HOURS = [8, 10, 12, 14, 16];
const PT_UTC_OFFSET = 7;

function descriptionHtml(p: Product): string {
  const parts = [`<p>${p.blurb}</p>`];
  if (p.bookByPhone) {
    parts.push('<p><strong>Call to reserve.</strong> Reserve now, pay at the marina.</p>');
  }
  if (p.priceTBD) {
    parts.push('<p>Contact the marina for custom and group pricing.</p>');
  }
  return parts.join('');
}

async function main() {
  console.log('Syncing Lake Sonoma catalog to contract ...');

  await adminPrisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_operator_id = '${OP_ID}'`);

      const operator = await tx.operator.findUnique({ where: { id: OP_ID } });
      if (!operator) {
        throw new Error(
          `Operator "${OP_ID}" not found. Run the base seed (pnpm --filter @marina/database seed) first.`,
        );
      }
      const location = await tx.location.findFirst({
        where: { operator_id: OP_ID, is_default: true },
      });

      // ---- Activities + rates -------------------------------------------
      const pontoonActivityIds: string[] = [];
      const activityBySlug = new Map<string, string>();

      for (const p of PRODUCTS) {
        const sort = CATEGORY_ORDER.indexOf(p.group) * 100 + p.singenuityId; // stable, grouped

        // Match an existing row by its slug tag (later runs); on the first run the
        // base-seed rows have no config.slug, so fall back to adopting the legacy
        // name_external the base seed used — this prevents duplicate activities.
        let existing = await tx.activity.findFirst({
          where: { operator_id: OP_ID, config: { path: ['slug'], equals: p.slug } },
        });
        if (!existing && p.legacyNames && p.legacyNames.length > 0) {
          existing = await tx.activity.findFirst({
            where: {
              operator_id: OP_ID,
              name_external: { in: p.legacyNames },
              config: { equals: Prisma.DbNull },
            },
          });
        }

        const data = {
          operator_id: OP_ID,
          location_id: location?.id ?? null,
          name_internal: p.name,
          name_external: p.name,
          category: p.category,
          min_participants: 1,
          max_participants: p.maxCap,
          color: p.color,
          waiver_required: p.category !== 'PATIO',
          description_html: descriptionHtml(p),
          photo_urls: [photoUrlFor(p.slug)],
          // priceTBD -> list the activity but suppress pricing ("Inquire").
          hide_price: p.priceTBD,
          sort_index: sort,
          config: {
            slug: p.slug,
            singenuityId: p.singenuityId,
            categoryLabel: p.categoryLabel,
            bookByPhone: p.bookByPhone,
            priceTBD: p.priceTBD,
            featured: p.featured,
          },
        };

        let activityId: string;
        if (existing) {
          await tx.activity.update({ where: { id: existing.id }, data });
          activityId = existing.id;
        } else {
          const created = await tx.activity.create({ data: { ...data, status: 'ACTIVE' } });
          activityId = created.id;
        }
        activityBySlug.set(p.slug, activityId);
        if (p.category === 'BOAT' && p.categoryLabel.includes('Pontoon')) {
          pontoonActivityIds.push(activityId);
        }

        // ---- Reconcile rates ----
        const desired = p.tiers.map((t, i) => ({
          name_internal: t.name_internal,
          name_external: t.name_external,
          price_cents: dollars(t.amount),
          duration_minutes: t.minutes,
          is_from_price: !!t.is_from_price,
          internal_only: false, // every contract tier is publicly bookable
          is_active: true,
          sort_index: i,
        }));
        const desiredKeys = new Set(desired.map((d) => d.name_internal));

        const currentRates = await tx.rate.findMany({ where: { operator_id: OP_ID, activity_id: activityId } });
        const currentByName = new Map(currentRates.map((r) => [r.name_internal, r]));

        // Upsert desired tiers.
        for (const d of desired) {
          const cur = currentByName.get(d.name_internal);
          if (cur) {
            await tx.rate.update({ where: { id: cur.id }, data: d });
          } else {
            await tx.rate.create({ data: { ...d, operator_id: OP_ID, activity_id: activityId } });
          }
        }

        // Prune tiers not in the contract (Two Hour, phantom Overnight, spurious
        // Half Day on Jet Ski, etc.). Deactivate if referenced by an order; else delete.
        for (const cur of currentRates) {
          if (desiredKeys.has(cur.name_internal)) continue;
          const refCount = await tx.orderItem.count({ where: { operator_id: OP_ID, rate_id: cur.id } });
          if (refCount > 0) {
            await tx.rate.update({ where: { id: cur.id }, data: { is_active: false, internal_only: true } });
          } else {
            await tx.rate.delete({ where: { id: cur.id } });
          }
        }
      }

      // ---- Add-ons (PackageUpsell) --------------------------------------
      // Offered on every boat whose contract lists add-ons. Reconcile by
      // (activity, name); each add-on carries its 4-tier price in the description.
      const addOnByName = new Map(ADDONS.map((a) => [a.name, a]));
      for (const p of PRODUCTS) {
        const activityId = activityBySlug.get(p.slug)!;
        const desiredNames = new Set(p.addOns);
        const currentUpsells = await tx.packageUpsell.findMany({
          where: { operator_id: OP_ID, activity_id: activityId },
        });
        const currentByName = new Map(currentUpsells.map((u) => [u.name, u]));

        let sort = 0;
        for (const name of p.addOns) {
          const a = addOnByName.get(name);
          if (!a) continue;
          const desc = a.tiers.map((t) => `${t.label} $${t.amount}`).join(' · ');
          // The base (1 hr) price is the sticker; full tier table lives in description.
          const base = dollars(a.tiers[0]!.amount);
          const cur = currentByName.get(name);
          const payload = {
            name,
            description: desc,
            price_cents: base,
            is_active: true,
            sort_index: sort++,
          };
          if (cur) {
            await tx.packageUpsell.update({ where: { id: cur.id }, data: payload });
          } else {
            await tx.packageUpsell.create({
              data: { ...payload, operator_id: OP_ID, activity_id: activityId },
            });
          }
        }
        // Remove add-ons no longer offered on this activity (unless order-referenced).
        for (const cur of currentUpsells) {
          if (desiredNames.has(cur.name)) continue;
          const refCount = await tx.orderItem.count({ where: { operator_id: OP_ID, add_on_id: cur.id } });
          if (refCount > 0) {
            await tx.packageUpsell.update({ where: { id: cur.id }, data: { is_active: false } });
          } else {
            await tx.packageUpsell.delete({ where: { id: cur.id } });
          }
        }
      }

      // ---- Day-use fees + passes (flat Fees) ----------------------------
      const currentFees = await tx.fee.findMany({ where: { operator_id: OP_ID, type: 'FLAT' } });
      const currentFeeByName = new Map(currentFees.map((f) => [f.name, f]));
      for (const f of DAY_USE_FEES) {
        const cur = currentFeeByName.get(f.name);
        const payload = {
          name: f.name,
          type: 'FLAT' as const,
          // Optional line items, not auto-applied to every order; enabled=false so
          // they surface as offerable extras without silently taxing every booking.
          value: f.value,
          enabled: false,
          activity_id: null,
        };
        if (cur) {
          await tx.fee.update({ where: { id: cur.id }, data: payload });
        } else {
          await tx.fee.create({ data: { ...payload, operator_id: OP_ID } });
        }
      }

      // ---- Timeslots: ensure 60+ future days for every activity ----------
      const day0 = new Date();
      day0.setUTCHours(0, 0, 0, 0);

      let slotsAdded = 0;
      for (const p of PRODUCTS) {
        const activityId = activityBySlug.get(p.slug)!;
        // Existing future slot datetimes (as epoch ms) so we never duplicate.
        const existingFuture = await tx.timeslot.findMany({
          where: { operator_id: OP_ID, activity_id: activityId, datetime: { gte: day0 } },
          select: { datetime: true },
        });
        const have = new Set(existingFuture.map((s) => s.datetime.getTime()));

        const toCreate: { operator_id: string; activity_id: string; datetime: Date; capacity_total: number }[] = [];
        for (let d = 0; d <= FUTURE_DAYS; d++) {
          for (const h of SLOT_HOURS) {
            const dt = new Date(day0);
            dt.setUTCDate(day0.getUTCDate() + d);
            dt.setUTCHours(h + PT_UTC_OFFSET, 0, 0, 0);
            if (have.has(dt.getTime())) continue;
            toCreate.push({ operator_id: OP_ID, activity_id: activityId, datetime: dt, capacity_total: p.maxCap });
          }
        }
        if (toCreate.length > 0) {
          await tx.timeslot.createMany({ data: toCreate });
          slotsAdded += toCreate.length;
        }
      }

      // ---- Prune out-of-hours phantom slots -------------------------------
      // Older base-seed runs left AVAILABLE slots at 06:00 UTC (11pm PT) — an
      // 11:00 PM boat-rental time nobody offers. The generator above only ever
      // creates the sane operating hours (SLOT_HOURS PT -> ALLOWED_UTC_HOURS),
      // so any AVAILABLE slot at a different hour is a leftover. Delete those,
      // but NEVER one a customer has actually booked into: an order item pins a
      // slot as historical fact, so we skip any slot with order items regardless
      // of the hour. Idempotent — a clean database matches nothing.
      const ALLOWED_UTC_HOURS = SLOT_HOURS.map((h) => (h + PT_UTC_OFFSET) % 24);
      const prunedResult = await tx.$executeRaw`
        DELETE FROM "Timeslot" t
        WHERE t.operator_id = ${OP_ID}
          AND t.status = 'AVAILABLE'
          AND EXTRACT(HOUR FROM t.datetime)::int NOT IN (${Prisma.join(ALLOWED_UTC_HOURS)})
          AND NOT EXISTS (
            SELECT 1 FROM "OrderItem" oi WHERE oi.timeslot_id = t.id
          )
      `;
      const slotsPruned = Number(prunedResult) || 0;

      // ---- Pontoon Fleet shared resource (keep membership current) -------
      if (pontoonActivityIds.length > 0) {
        const fleet = await tx.resource.findFirst({ where: { operator_id: OP_ID, name: 'Pontoon Fleet' } });
        if (fleet) {
          await tx.resource.update({
            where: { id: fleet.id },
            data: { activities: { set: pontoonActivityIds.map((id) => ({ id })) } },
          });
        } else {
          await tx.resource.create({
            data: {
              operator_id: OP_ID,
              name: 'Pontoon Fleet',
              seat_capacity: 12,
              quantity: 1,
              is_active: true,
              activities: { connect: pontoonActivityIds.map((id) => ({ id })) },
            },
          });
        }
      }

      console.log(`  ${PRODUCTS.length} activities synced (${pontoonActivityIds.length} pontoons)`);
      console.log(`  add-ons + day-use fees reconciled`);
      console.log(`  ${slotsAdded} future timeslots added (target ${FUTURE_DAYS} days)`);
      console.log(`  ${slotsPruned} out-of-hours phantom timeslots pruned (bookings kept)`);
    },
    { maxWait: 20000, timeout: 180000 },
  );

  console.log('✅ Catalog sync complete.');
}

main()
  .catch((e) => {
    console.error('❌ Catalog sync failed:', e);
    process.exit(1);
  })
  .finally(() => adminPrisma.$disconnect());
