/**
 * Idempotent seed for the California boat-rental waiver clauses.
 *
 * Attaches the canonical clause set (packages/database/prisma/waiver-clauses.ts)
 * to the seed operator's ACTIVE waiver without running the destructive full seed.
 * Safe to re-run: it matches existing clauses by title and updates them in place,
 * inserting any that are missing, so it converges the DB to the canonical text.
 * Also backfills the waiver intro if empty.
 *
 * Run: `node --experimental-strip-types scripts/seed-waiver-clauses.ts` (needs DATABASE_URL).
 */
import { PrismaClient } from '@prisma/client';
import { CA_BOAT_WAIVER_CLAUSES } from '../prisma/waiver-clauses.ts';

const adminPrisma = new PrismaClient();
const OPERATOR_ID = 'lsra';

const DEFAULT_INTRO_HTML =
  '<p>This Liability Waiver, Release, and Rental Agreement (the "Agreement") ' +
  'is made between you (the "Renter") and the boat livery operator (the ' +
  '"Operator"). Please read every section carefully and initial each one. ' +
  'The Operator must be 21 or older and present a valid government-issued ' +
  'photo ID. This packet supplements — and does not replace — the ' +
  'California Boater Card and applicable California and U.S. Coast Guard ' +
  'boating laws.</p>';

async function main() {
  const waiver = await adminPrisma.waiver.findFirst({
    where: { operator_id: OPERATOR_ID, is_active: true },
    orderBy: { created_at: 'desc' },
    include: { clauses: true },
  });
  if (!waiver) {
    throw new Error(`No active waiver for operator "${OPERATOR_ID}" — run the main seed first.`);
  }

  if (!waiver.intro_html) {
    await adminPrisma.waiver.update({
      where: { id: waiver.id },
      data: { intro_html: DEFAULT_INTRO_HTML },
    });
    console.log('Backfilled waiver intro_html.');
  }

  const byTitle = new Map(waiver.clauses.map((c) => [c.title, c]));
  let inserted = 0;
  let updated = 0;

  for (const cl of CA_BOAT_WAIVER_CLAUSES) {
    const existing = byTitle.get(cl.title);
    if (existing) {
      await adminPrisma.waiverClause.update({
        where: { id: existing.id },
        data: {
          sort_order: cl.sort_order,
          body_html: cl.body_html,
          requires_initials: cl.requires_initials,
          is_required: cl.is_required,
        },
      });
      updated++;
    } else {
      await adminPrisma.waiverClause.create({
        data: {
          operator_id: OPERATOR_ID,
          waiver_id: waiver.id,
          sort_order: cl.sort_order,
          title: cl.title,
          body_html: cl.body_html,
          requires_initials: cl.requires_initials,
          is_required: cl.is_required,
        },
      });
      inserted++;
    }
  }

  console.log(
    `Waiver clauses synced for "${OPERATOR_ID}": ${inserted} inserted, ${updated} updated (waiver ${waiver.id}).`,
  );
}

main()
  .then(() => adminPrisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await adminPrisma.$disconnect();
    process.exit(1);
  });
