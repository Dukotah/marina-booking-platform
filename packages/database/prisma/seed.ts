/**
 * Seed: Lake Sonoma Marina (LSRA) — the seed client / customer zero.
 *
 * Runs inside a single transaction with the tenant GUC set, so it both seeds the
 * data AND exercises the RLS path (a fixed operator id is used so WITH CHECK passes
 * under FORCE row-level security). Idempotent: wipes and recreates operator "lsra".
 *
 * Usage: pnpm --filter @marina/database seed   (needs DATABASE_URL)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const OP_ID = 'lsra';

/** round to nearest whole dollar, in cents */
const cents = (n: number) => Math.round(n) * 100;

type Cat = 'BOAT' | 'WATERCRAFT' | 'PATIO';
interface Seed {
  name: string;
  category: Cat;
  maxCap: number;
  /** boats: half-day price; watercraft: hourly; patios: day price (USD) */
  from: number;
  color: string;
}

const ACTIVITIES: Seed[] = [
  { name: '5 Person Pontoon Boat Rental', category: 'BOAT', maxCap: 5, from: 350, color: '#0ea5e9' },
  { name: '10 Person Pontoon Rental', category: 'BOAT', maxCap: 10, from: 420, color: '#0ea5e9' },
  { name: '12 Person Pontoon Boat Rental', category: 'BOAT', maxCap: 12, from: 520, color: '#0ea5e9' },
  { name: 'Double Decker Pontoon Rental', category: 'BOAT', maxCap: 12, from: 585, color: '#0284c7' },
  { name: 'Premium 10P Single Story Pontoon', category: 'BOAT', maxCap: 10, from: 600, color: '#0284c7' },
  { name: 'Watersport/Tubing Boat (7P)', category: 'BOAT', maxCap: 7, from: 600, color: '#2563eb' },
  { name: 'Premium Sport Boat (8P)', category: 'BOAT', maxCap: 8, from: 700, color: '#2563eb' },
  { name: 'Jet Ski Rentals (2P)', category: 'WATERCRAFT', maxCap: 2, from: 150, color: '#14b8a6' },
  { name: 'Single Kayak Rental', category: 'WATERCRAFT', maxCap: 1, from: 50, color: '#22c55e' },
  { name: 'Double Kayak Rental', category: 'WATERCRAFT', maxCap: 2, from: 50, color: '#22c55e' },
  { name: 'Paddle Board Rental', category: 'WATERCRAFT', maxCap: 1, from: 50, color: '#22c55e' },
  { name: 'Canoe Rental (2P)', category: 'WATERCRAFT', maxCap: 2, from: 50, color: '#22c55e' },
  { name: 'Grand Patio', category: 'PATIO', maxCap: 100, from: 150, color: '#f59e0b' }, // price TBD — placeholder
  { name: 'Bar Patio', category: 'PATIO', maxCap: 50, from: 100, color: '#f59e0b' },
  { name: 'Scenic Patio', category: 'PATIO', maxCap: 50, from: 100, color: '#f59e0b' },
  { name: 'Bridge Patio', category: 'PATIO', maxCap: 20, from: 100, color: '#f59e0b' },
  { name: 'Lakeside Patio 5', category: 'PATIO', maxCap: 20, from: 100, color: '#f59e0b' },
  { name: 'Lakeside Patio 6', category: 'PATIO', maxCap: 20, from: 100, color: '#f59e0b' },
  { name: 'Upper Lakeside Patio 7', category: 'PATIO', maxCap: 20, from: 100, color: '#f59e0b' },
];

/** Build the rate set for an activity from its "from" price (mirrors LSRA pricing). */
function ratesFor(s: Seed) {
  if (s.category === 'BOAT') {
    const h = s.from; // half day
    return [
      { name_internal: 'One Hour', name_external: 'One Hour', price_cents: cents(h * 0.3571), duration_minutes: 60, internal_only: true, sort_index: 0 },
      { name_internal: 'Two Hour', name_external: 'Two Hour', price_cents: cents(h * 0.7143), duration_minutes: 120, sort_index: 1 },
      { name_internal: 'Half Day', name_external: 'Half Day (4 hr)', price_cents: cents(h), duration_minutes: 240, is_from_price: true, sort_index: 2 },
      { name_internal: 'Full Day', name_external: 'Full Day (8 hr)', price_cents: cents(h * 1.7857), duration_minutes: 480, sort_index: 3 },
      { name_internal: 'Overnight', name_external: 'Overnight', price_cents: cents(h * 2.8571), duration_minutes: 1440, sort_index: 4 },
    ];
  }
  if (s.category === 'WATERCRAFT') {
    const hr = s.from;
    return [
      { name_internal: 'One Hour', name_external: 'One Hour', price_cents: cents(hr), duration_minutes: 60, is_from_price: true, sort_index: 0 },
      { name_internal: 'Half Day', name_external: 'Half Day (4 hr)', price_cents: cents(hr * 3.5), duration_minutes: 240, sort_index: 1 },
    ];
  }
  // PATIO
  return [
    { name_internal: 'Full Day', name_external: 'Full Day', price_cents: cents(s.from), duration_minutes: 480, is_from_price: true, sort_index: 0 },
  ];
}

async function main() {
  console.log('Seeding Lake Sonoma Marina (operator "lsra") ...');

  await prisma.$transaction(
    async (tx) => {
      // Scope this transaction to the tenant so RLS allows the writes.
      await tx.$executeRawUnsafe(`SET LOCAL app.current_operator_id = '${OP_ID}'`);

      // Idempotent reset. `OrderItem -> Activity/Rate/Timeslot` are RESTRICT FKs
      // (D-011), so deleting the operator can't cascade through activities while
      // orders exist. Clear the order graph first (Order cascades to its items,
      // payments, notes, events); then the operator delete cascades everything
      // else. This keeps the seed re-runnable after dogfooding bookings exist.
      await tx.order.deleteMany({ where: { operator_id: OP_ID } });
      await tx.operator.deleteMany({ where: { id: OP_ID } });

      const operator = await tx.operator.create({
        data: {
          id: OP_ID,
          slug: 'lake-sonoma',
          name_internal: 'Lake Sonoma Recreation Area',
          name_external: 'Lake Sonoma Marina',
          location_code: 'LSRA',
          website: 'https://lakesonoma.com',
          timezone: 'America/Los_Angeles',
          legal_adult_age: 21,
          brand_color: '#0ea5e9',
        },
      });

      const location = await tx.location.create({
        data: {
          operator_id: operator.id,
          name: 'Lake Sonoma Marina',
          city: 'Geyserville',
          state: 'CA',
          is_default: true,
        },
      });

      // Global fees
      await tx.fee.createMany({
        data: [
          { operator_id: operator.id, name: 'Sales Tax', type: 'PERCENT', value: 9.25 },
          { operator_id: operator.id, name: 'Processing Fee', type: 'PERCENT', value: 4.0 },
        ],
      });

      // Default waiver
      await tx.waiver.create({
        data: {
          operator_id: operator.id,
          name: 'Liability Waiver & Boat Operation Agreement',
          requires_minor_signature: true,
          template_html:
            '<h1>Liability Waiver</h1><p>Operator must be 21+. Valid government photo ID required. ' +
            'I acknowledge the risks of watercraft operation and agree to the rental terms, ' +
            'cancellation policy, and fuel/damage responsibilities.</p>',
        },
      });

      // Checkout config (tip presets) stored as an integration record (config pattern)
      await tx.integration.create({
        data: {
          operator_id: operator.id,
          key: 'checkout',
          enabled: true,
          config: { tip_presets: [15, 20, 25], default_tip: 20, checkin_minutes: 30 },
        },
      });

      // Example (expired) promo from the live audit
      await tx.promoCode.create({
        data: {
          operator_id: operator.id,
          code: 'LASTSPLASH',
          name: 'Last Splash (Sept–Oct 2025)',
          type: 'ONE_CODE',
          discount_type: 'PERCENT',
          discount_value: 10,
          is_active: false,
          valid_from: new Date('2025-09-01'),
          valid_until: new Date('2025-10-31'),
        },
      });

      // Default owner staff member (used by the dev-auth shim for testing).
      // Look it up via the `x-dev-staff-id: dev-owner` header (see api auth middleware).
      // Location scoping is via the StaffLocation join, not a scalar field.
      await tx.staffMember.create({
        data: {
          operator_id: operator.id,
          auth_user_id: 'dev-owner',
          name: 'Dukotah Hutcheon',
          email: 'dukotah@gmail.com',
          role: 'OWNER',
          is_active: true,
          locations: { create: { location_id: location.id } },
        },
      });

      // Activities + rates
      let sort = 0;
      const pontoonActivityIds: string[] = [];
      for (const s of ACTIVITIES) {
        const activity = await tx.activity.create({
          data: {
            operator_id: operator.id,
            location_id: location.id,
            name_internal: s.name,
            name_external: s.name,
            category: s.category,
            min_participants: 1,
            max_participants: s.maxCap,
            color: s.color,
            waiver_required: s.category !== 'PATIO',
            sort_index: sort++,
          },
        });
        await tx.rate.createMany({
          data: ratesFor(s).map((r) => ({ ...r, operator_id: operator.id, activity_id: activity.id })),
        });

        // Bookable timeslots for the next 30 days so the booking flow works out of
        // the box (dev/dogfooding). Hours are stored in UTC matching ~8am–4pm PT;
        // not DST-exact (dev data). Capacity = the activity's max party size.
        const SLOT_HOURS = [8, 10, 12, 14, 16];
        const PT_UTC_OFFSET = 7; // PDT; good enough for local dev.
        const day0 = new Date();
        day0.setUTCHours(0, 0, 0, 0);
        const slots: {
          operator_id: string;
          activity_id: string;
          datetime: Date;
          capacity_total: number;
        }[] = [];
        for (let d = 1; d <= 30; d++) {
          for (const h of SLOT_HOURS) {
            const dt = new Date(day0);
            dt.setUTCDate(day0.getUTCDate() + d);
            dt.setUTCHours(h + PT_UTC_OFFSET, 0, 0, 0);
            slots.push({
              operator_id: operator.id,
              activity_id: activity.id,
              datetime: dt,
              capacity_total: s.maxCap,
            });
          }
        }
        await tx.timeslot.createMany({ data: slots });

        if (s.name.includes('Pontoon')) pontoonActivityIds.push(activity.id);
      }

      // Shared-resource demo (D-014): a single "Pontoon Fleet" of 12 guest-seats that
      // every pontoon activity draws from, so booking one pontoon reduces availability
      // for the others — the cross-activity blocking that beats Singenuity/FareHarbor.
      if (pontoonActivityIds.length > 0) {
        await tx.resource.create({
          data: {
            operator_id: operator.id,
            name: 'Pontoon Fleet',
            seat_capacity: 12,
            quantity: 1,
            out_of_service_qty: 0,
            is_active: true,
            activities: { connect: pontoonActivityIds.map((id) => ({ id })) },
          },
        });
      }

      console.log(`  operator ${operator.name_external}`);
      console.log(`  ${ACTIVITIES.length} activities seeded`);
      console.log(`  timeslots seeded (30 days × 5/day per activity)`);
      console.log(`  Pontoon Fleet shared resource → ${pontoonActivityIds.length} activities`);
    },
    { maxWait: 15000, timeout: 120000 },
  );

  console.log('✅ Seed complete.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
