/**
 * Demo seed for the shared-resource capacity engine (D-014).
 *
 * Idempotent: creates/updates a single "Pontoon Fleet" resource that ALL of the
 * seed operator's pontoon activities draw from, modelling a marina whose pontoon
 * dock can host only so many guests at once. Because the pool is shared, booking a
 * 10-person pontoon leaves too little for an overlapping 5-person pontoon on a
 * DIFFERENT activity — the cross-activity blocking that beats Singenuity/FareHarbor,
 * visible live in the local app.
 *
 * Run: `node --experimental-strip-types scripts/demo-resource.ts` (needs DATABASE_URL).
 * Safe to re-run; does not touch the destructive full seed.
 */
import { PrismaClient } from '@prisma/client';

const adminPrisma = new PrismaClient();
const OPERATOR_ID = 'lsra';
const RESOURCE_NAME = 'Pontoon Fleet';
// One shared pool of 12 guest-seats across every pontoon activity. Small enough that
// two overlapping pontoon bookings collide, so the blocking is easy to see.
const SEAT_CAPACITY = 12;
const QUANTITY = 1;

async function main() {
  const pontoons = await adminPrisma.activity.findMany({
    where: { operator_id: OPERATOR_ID, name_external: { contains: 'Pontoon' } },
    select: { id: true, name_external: true },
  });
  if (pontoons.length === 0) {
    throw new Error('No pontoon activities found — run the main seed first.');
  }

  const existing = await adminPrisma.resource.findFirst({
    where: { operator_id: OPERATOR_ID, name: RESOURCE_NAME },
    select: { id: true },
  });

  const base = {
    seat_capacity: SEAT_CAPACITY,
    quantity: QUANTITY,
    out_of_service_qty: 0,
    is_active: true,
  };
  const links = pontoons.map((p) => ({ id: p.id }));

  if (existing) {
    await adminPrisma.resource.update({
      where: { id: existing.id },
      data: { ...base, activities: { set: links } },
    });
    console.log(`Updated "${RESOURCE_NAME}" → ${pontoons.length} pontoon activities.`);
  } else {
    await adminPrisma.resource.create({
      data: { operator_id: OPERATOR_ID, name: RESOURCE_NAME, ...base, activities: { connect: links } },
    });
    console.log(`Created "${RESOURCE_NAME}" → ${pontoons.length} pontoon activities.`);
  }
  console.log(
    `Pool: ${QUANTITY} × ${SEAT_CAPACITY} = ${QUANTITY * SEAT_CAPACITY} shared guest-seats. ` +
      `Linked: ${pontoons.map((p) => p.name_external).join(', ')}.`,
  );
}

main()
  .then(() => adminPrisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await adminPrisma.$disconnect();
    process.exit(1);
  });
