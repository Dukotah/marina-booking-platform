/**
 * Seed: an open-duration RENTAL WINDOW ScheduleRule for every rentable Lake
 * Sonoma boat/watercraft/patio.
 *
 * Open-duration rentals (a boat rentable across a window of hours, e.g.
 * 8:00 AM - 8:00 PM) are modeled as a ScheduleRule with open_minute/close_minute
 * set and start_minutes empty. See the ScheduleRule doc comment in schema.prisma.
 *
 * This gives the back-office schedule builder a baseline to render in the week
 * grid / rule builder: every rentable activity is open every day 8am-8pm across a
 * wide current season.
 *
 * Scoped to operator_id = 'lsra'. Idempotent: skips any activity that already
 * has an open-duration rental-window rule, so re-runs are safe. Runs inside one
 * transaction with the tenant GUC set, exercising the RLS write path.
 *
 * Usage: DATABASE_URL=... pnpm --filter @marina/database exec tsx scripts/seed-rental-windows.ts
 */
import { PrismaClient, ActivityCategory } from '@prisma/client';

const prisma = new PrismaClient();
const OP_ID = 'lsra';

// The rentable categories (boats, watercraft, patios) — open-duration rentals.
const RENTAL_CATEGORIES: ActivityCategory[] = [
  ActivityCategory.BOAT,
  ActivityCategory.WATERCRAFT,
  ActivityCategory.PATIO,
];

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // every day, Sun..Sat
const OPEN_MINUTE = 480; // 8:00 AM
const CLOSE_MINUTE = 1200; // 8:00 PM
// A wide current season so the window is live today and well into the future.
const SEASON_START = '2026-01-01';
const SEASON_END = '2026-12-31';

async function main() {
  console.log('Seeding open-duration rental windows for Lake Sonoma ...');

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_operator_id = '${OP_ID}'`);

    const operator = await tx.operator.findUnique({ where: { id: OP_ID } });
    if (!operator) throw new Error('Operator "lsra" not found — run `pnpm db:seed` first.');

    const activities = await tx.activity.findMany({
      where: { operator_id: OP_ID, category: { in: RENTAL_CATEGORIES } },
      select: { id: true, name_external: true, category: true },
      orderBy: [{ category: 'asc' }, { name_external: 'asc' }],
    });

    let created = 0;
    let skipped = 0;

    for (const a of activities) {
      // Idempotent: a rental-window rule is one with both edges set.
      const existing = await tx.scheduleRule.findFirst({
        where: {
          operator_id: OP_ID,
          activity_id: a.id,
          open_minute: { not: null },
          close_minute: { not: null },
        },
        select: { id: true },
      });

      if (existing) {
        skipped += 1;
        continue;
      }

      await tx.scheduleRule.create({
        data: {
          operator_id: OP_ID,
          activity_id: a.id,
          name: 'Open daily 8am-8pm',
          start_date: SEASON_START,
          end_date: SEASON_END,
          weekdays: WEEKDAYS,
          start_minutes: [], // empty => open-duration rental window, not fixed departures
          open_minute: OPEN_MINUTE,
          close_minute: CLOSE_MINUTE,
          capacity: null,
          is_active: true,
        },
      });
      created += 1;
      console.log(`  + ${a.category.padEnd(10)} ${a.name_external}`);
    }

    return { total: activities.length, created, skipped };
  });

  console.log(
    `Done. ${result.total} rentable activities: ${result.created} rules created, ${result.skipped} already had one.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
