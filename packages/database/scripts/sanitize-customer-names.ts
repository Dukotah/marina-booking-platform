/**
 * Neutralize QA-scaffolding customer names so they can never surface on the
 * customer-facing confirmation page (`/confirmation?order=<number>` renders
 * "Reserved for <name>"). Order numbers are sequential and predictable, so any
 * row named "Reserve Demo", "NoWaiver Test", "Playwright …", "QA Test", etc. is
 * practically discoverable and reads as broken/unfinished to a guest.
 *
 * These names are NOT produced by the catalog or season seeds (those draw from
 * curated realistic name lists) — they are residue from manual browser QA and
 * Playwright runs against the shared dev database. This script is the hygiene
 * pass that removes them: it is idempotent and safe to run any time (e.g. after
 * a QA session, or as part of `db:reset`).
 *
 * Matching is deliberately conservative — only names containing an unambiguous
 * scaffolding token are touched, so real generated guests ("Sofia Ellis") are
 * left alone. Rewritten rows become "Marina Guest".
 *
 * Needs DATABASE_URL. Prints how many rows it changed.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: [] });

// Case-insensitive tokens that only appear in test scaffolding, never in a real
// guest's name. Word-ish boundaries via the regexes below keep false positives
// out (e.g. "Reserve" as a token, but not a surname that merely contains it).
const SCAFFOLD_TOKENS = [
  'demo',
  'test',
  'sandbox',
  'playwright',
  'fake',
  'nowaiver',
  'reserve',
  'dummy',
  'e2e',
];

// A name field is scaffolding if it equals or starts with a token, or is one of
// the known Playwright/QA generated shapes (e.g. "QA2", "OpsSDHO").
const tokenRe = new RegExp(`\\b(${SCAFFOLD_TOKENS.join('|')})\\b`, 'i');
const qaShapeRe = /^(qa\d*|opssdho|double|priceCheck|testuser)$/i;

function isScaffolding(first: string, last: string): boolean {
  const f = first?.trim() ?? '';
  const l = last?.trim() ?? '';
  return (
    tokenRe.test(f) ||
    tokenRe.test(l) ||
    qaShapeRe.test(f) ||
    qaShapeRe.test(l)
  );
}

const NEUTRAL_FIRST = 'Marina';
const NEUTRAL_LAST = 'Guest';

async function main() {
  const customers = await prisma.customer.findMany({
    select: { id: true, first_name: true, last_name: true },
  });

  const toFix = customers.filter((c) => isScaffolding(c.first_name, c.last_name));

  if (toFix.length === 0) {
    console.log('[sanitize-customer-names] no scaffolding names found — nothing to do.');
    return;
  }

  await prisma.$transaction(
    toFix.map((c) =>
      prisma.customer.update({
        where: { id: c.id },
        data: { first_name: NEUTRAL_FIRST, last_name: NEUTRAL_LAST },
      }),
    ),
  );

  console.log(
    `[sanitize-customer-names] neutralized ${toFix.length} scaffolding customer name(s) to "${NEUTRAL_FIRST} ${NEUTRAL_LAST}".`,
  );
}

main()
  .catch((err) => {
    console.error(`[sanitize-customer-names] ${err?.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
