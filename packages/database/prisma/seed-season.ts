/**
 * Seed: a believable operating season for Lake Sonoma Marina.
 *
 * The base seed (`seed.ts`) creates the catalog — activities, rates, timeslots.
 * That is enough to take a booking but it leaves every dashboard, report and
 * manifest at zero, which is useless for evaluating the product. This script
 * hangs a real business off that catalog: customers who come back, orders across
 * past and future dates, refunds, no-shows, walk-ups, comps, tips and promo
 * redemptions.
 *
 * Deterministic: a fixed-seed PRNG, so the same data comes out every run and a
 * bug is reproducible. Re-runnable: clears its own orders first.
 *
 * Runs inside one transaction with the tenant GUC set, so it exercises the RLS
 * write path exactly like the base seed does.
 *
 * Usage: pnpm db:seed:season   (needs DATABASE_URL; run after `pnpm db:seed`)
 */
import { PrismaClient, type OrderStatus, type OrderItemStatus } from '@prisma/client';

const prisma = new PrismaClient();
const OP_ID = 'lsra';

const HISTORY_DAYS = 60; // must be <= seed.ts SEASON_HISTORY_DAYS
const FUTURE_DAYS = 25; // must be <= the 30 days seed.ts creates forward

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same season every run.
// ---------------------------------------------------------------------------
function makeRng(seed: number) {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(20260826);

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const chance = (p: number) => rng() < p;

// ---------------------------------------------------------------------------
// Guest names — plausible, generic, not real people.
// ---------------------------------------------------------------------------
const FIRST = [
  'Ava', 'Liam', 'Maya', 'Noah', 'Elena', 'Marcus', 'Priya', 'Diego', 'Chloe', 'Owen',
  'Sofia', 'Jonah', 'Nina', 'Caleb', 'Ruby', 'Theo', 'Iris', 'Sam', 'Leah', 'Wyatt',
  'Grace', 'Miles', 'Hana', 'Felix', 'June', 'Ezra', 'Talia', 'Rowan', 'Cora', 'Silas',
];
const LAST = [
  'Alvarez', 'Brennan', 'Castellano', 'Dunn', 'Ellis', 'Fontaine', 'Garrett', 'Hollis',
  'Ives', 'Jarrett', 'Keller', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Pham',
  'Quinn', 'Rivas', 'Sandoval', 'Thorne', 'Underwood', 'Vega', 'Whitaker', 'Yates',
];
const HEARD = [
  'Google search', 'Friend or family', 'Instagram', 'Drove past the marina',
  'Yelp', 'Returning guest', 'TripAdvisor', null, null,
];
const CARD_BRANDS = ['Visa', 'Mastercard', 'Amex', 'Discover'] as const;

/** Business is seasonal and weekend-heavy — this shapes the whole dataset. */
function bookingsForDay(date: Date): number {
  const dow = date.getUTCDay();
  const weekend = dow === 0 || dow === 6;
  const friday = dow === 5;
  const base = weekend ? int(6, 11) : friday ? int(4, 7) : int(1, 4);
  return chance(0.06) ? 0 : base; // the odd dead day (weather)
}

async function main() {
  console.log('Seeding a season of business for Lake Sonoma Marina ...');

  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_operator_id = '${OP_ID}'`);

      const operator = await tx.operator.findUnique({ where: { id: OP_ID } });
      if (!operator) throw new Error('Operator "lsra" not found — run `pnpm db:seed` first.');

      // Re-runnable: clear prior orders and the customers/timeslot counters they moved.
      await tx.order.deleteMany({ where: { operator_id: OP_ID } });
      await tx.customer.deleteMany({ where: { operator_id: OP_ID } });
      await tx.timeslot.updateMany({ where: { operator_id: OP_ID }, data: { capacity_booked: 0 } });

      const fees = await tx.fee.findMany({ where: { operator_id: OP_ID } });
      const taxPct = fees.find((f) => f.name === 'Sales Tax')?.value ?? 0;
      const procPct = fees.find((f) => f.name === 'Processing Fee')?.value ?? 0;

      // A promo guests actually redeem, so reports have something to show.
      const promo = await tx.promoCode.create({
        data: {
          operator_id: OP_ID,
          code: 'SONOMA10',
          name: 'Summer 10% off',
          type: 'ONE_CODE',
          discount_type: 'PERCENT',
          discount_value: 10,
          is_active: true,
        },
      });

      const activities = await tx.activity.findMany({
        where: { operator_id: OP_ID },
        include: { rates: true },
      });
      if (activities.length === 0) throw new Error('No activities — run `pnpm db:seed` first.');

      // --- Customers. A core of regulars plus one-timers, so the CRM and the
      // "returning guest" flag mean something.
      const REGULARS = 18;
      const ONE_TIMERS = 90;
      const customers: { id: string; email: string; returning: boolean }[] = [];
      const usedEmails = new Set<string>();

      for (let i = 0; i < REGULARS + ONE_TIMERS; i++) {
        const first = pick(FIRST);
        const last = pick(LAST);
        let email = `${first}.${last}${i}@example.com`.toLowerCase();
        while (usedEmails.has(email)) email = `${first}.${last}${i}x@example.com`.toLowerCase();
        usedEmails.add(email);

        const c = await tx.customer.create({
          data: {
            operator_id: OP_ID,
            first_name: first,
            last_name: last,
            email,
            phone: `707${int(2000000, 9999999)}`,
            city: pick(['Healdsburg', 'Geyserville', 'Cloverdale', 'Santa Rosa', 'Windsor', 'Petaluma']),
            state: 'CA',
            tags: i < REGULARS ? ['regular'] : [],
          },
        });
        customers.push({ id: c.id, email, returning: i < REGULARS });
      }

      // --- Orders across the season.
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      let orderSeq = 1000;
      let created = 0;
      const stats = { completed: 0, upcoming: 0, cancelled: 0, noShow: 0, refunded: 0, walkUp: 0 };
      const customerTotals = new Map<string, { cents: number; count: number; last: Date }>();

      for (let d = -HISTORY_DAYS; d <= FUTURE_DAYS; d++) {
        const day = new Date(today);
        day.setUTCDate(today.getUTCDate() + d);
        const isPast = d < 0;

        for (let n = 0; n < bookingsForDay(day); n++) {
          const activity = pick(activities);
          const sellable = activity.rates.filter((r) => !r.internal_only);
          if (sellable.length === 0) continue;
          const rate = pick(sellable);

          // Find a slot on this day with room left.
          const dayStart = new Date(day);
          const dayEnd = new Date(day);
          dayEnd.setUTCDate(day.getUTCDate() + 1);
          const slots = await tx.timeslot.findMany({
            where: {
              operator_id: OP_ID,
              activity_id: activity.id,
              datetime: { gte: dayStart, lt: dayEnd },
            },
          });
          const open = slots.filter((s) => s.capacity_booked < s.capacity_total);
          if (open.length === 0) continue;
          const slot = pick(open);

          const quantity = Math.min(
            int(1, Math.max(1, Math.min(4, activity.max_participants))),
            slot.capacity_total - slot.capacity_booked,
          );
          if (quantity < 1) continue;

          // Regulars book more often than one-timers.
          const customer = chance(0.45)
            ? pick(customers.filter((c) => c.returning))
            : pick(customers);

          // --- Money. Integer cents throughout (never floats).
          const subtotal = rate.price_cents * quantity;
          const usedPromo = chance(0.12);
          const discount = usedPromo ? Math.round(subtotal * 0.1) : 0;
          const taxable = subtotal - discount;
          const tax = Math.round((taxable * taxPct) / 100);
          const processing = Math.round((taxable * procPct) / 100);
          const tip = isPast && chance(0.55) ? Math.round(taxable * pick([0.15, 0.2, 0.25])) : 0;
          const total = taxable + tax + processing + tip;

          // --- Outcome. Past days resolve; future days stay upcoming.
          let status: OrderStatus = 'UPCOMING';
          let itemStatus: OrderItemStatus = 'UPCOMING';
          if (isPast) {
            const roll = rng();
            if (roll < 0.86) { status = 'COMPLETED'; itemStatus = 'COMPLETED'; stats.completed++; }
            else if (roll < 0.93) { status = 'CANCELLED'; itemStatus = 'CANCELLED'; stats.cancelled++; }
            else { status = 'NO_SHOW'; itemStatus = 'NO_SHOW'; stats.noShow++; }
          } else {
            stats.upcoming++;
          }

          const cancelled = status === 'CANCELLED';
          const refundedFully = cancelled && chance(0.8);
          const partialRefund = status === 'COMPLETED' && chance(0.04);
          const refundCents = refundedFully ? total : partialRefund ? Math.round(total * 0.25) : 0;
          if (refundCents > 0) stats.refunded++;

          const amountPaid = cancelled && refundedFully ? 0 : total - (partialRefund ? refundCents : 0);
          const walkUp = chance(0.14);
          if (walkUp) stats.walkUp++;

          const bookedAt = new Date(slot.datetime);
          bookedAt.setUTCDate(bookedAt.getUTCDate() - (walkUp ? 0 : int(1, 21)));

          const order = await tx.order.create({
            data: {
              operator_id: OP_ID,
              order_number: `LSM-${orderSeq++}`,
              customer_id: customer.id,
              status,
              created_by: walkUp ? 'STAFF' : 'CUSTOMER',
              subtotal_cents: subtotal,
              tax_cents: tax,
              processing_fee_cents: processing,
              tip_cents: tip,
              discount_cents: discount,
              total_cents: total,
              amount_paid_cents: amountPaid,
              balance_due_cents: Math.max(0, total - amountPaid - refundCents),
              promo_code_id: usedPromo ? promo.id : null,
              heard_about_us: pick(HEARD),
              is_returning_guest: customer.returning,
              created_at: bookedAt,
              // Nested create under a tenant-composite parent must NOT pass
              // operator_id — Prisma derives it from the parent (D-011).
              items: {
                create: [
                  {
                    activity_id: activity.id,
                    rate_id: rate.id,
                    timeslot_id: slot.id,
                    quantity,
                    unit_price_cents: rate.price_cents,
                    status: itemStatus,
                    waiver_signed: activity.waiver_required && status !== 'CANCELLED',
                    waiver_signed_at:
                      activity.waiver_required && status !== 'CANCELLED' ? bookedAt : null,
                  },
                ],
              },
            },
          });

          if (!cancelled || !refundedFully) {
            await tx.payment.create({
              data: {
                operator_id: OP_ID,
                order_id: order.id,
                method: walkUp && chance(0.4) ? 'CASH' : 'CARD',
                status: refundCents > 0 ? (refundedFully ? 'REFUNDED' : 'PARTIAL_REFUND') : 'PAID',
                amount_cents: total,
                refunded_cents: refundCents,
                card_last_four: String(int(1000, 9999)),
                card_brand: pick(CARD_BRANDS),
                processed_at: bookedAt,
              },
            });
          }

          await tx.orderEvent.create({
            data: {
              operator_id: OP_ID,
              order_id: order.id,
              type: 'CREATED',
              description: walkUp ? 'Walk-up booking taken at the dock' : 'Booked online',
              actor: walkUp ? 'Dukotah Hutcheon' : 'Customer',
              created_at: bookedAt,
            },
          });

          if (!cancelled) {
            await tx.timeslot.update({
              where: { id: slot.id },
              data: { capacity_booked: { increment: quantity } },
            });
          }

          if (status === 'COMPLETED') {
            const t = customerTotals.get(customer.id) ?? { cents: 0, count: 0, last: bookedAt };
            t.cents += amountPaid;
            t.count += 1;
            if (slot.datetime > t.last) t.last = slot.datetime;
            customerTotals.set(customer.id, t);
          }
          created++;
        }
      }

      // Roll up CRM stats so the customer list is not all zeroes.
      for (const [id, t] of customerTotals) {
        await tx.customer.update({
          where: { id },
          data: {
            lifetime_value_cents: t.cents,
            total_bookings: t.count,
            last_booking_at: t.last,
            waiver_on_file: true,
          },
        });
      }

      console.log(`  ${customers.length} customers (${REGULARS} regulars)`);
      console.log(`  ${created} orders across ${HISTORY_DAYS} days back + ${FUTURE_DAYS} forward`);
      console.log(
        `    completed ${stats.completed} · upcoming ${stats.upcoming} · cancelled ${stats.cancelled} · no-show ${stats.noShow}`,
      );
      console.log(`    ${stats.refunded} refunded · ${stats.walkUp} walk-ups · promo SONOMA10 live`);
    },
    { maxWait: 15000, timeout: 300000 },
  );

  console.log('✅ Season seed complete.');
}

main()
  .catch((e) => {
    console.error('❌ Season seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
