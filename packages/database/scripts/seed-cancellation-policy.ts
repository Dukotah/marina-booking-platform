/**
 * Seed: a sensible generic DEFAULT tiered cancellation policy on the Lake Sonoma
 * operator ("lsra").
 *
 * Tiers (most-generous first):
 *   168h before start -> 100% refund
 *    24h before start ->  50% refund
 *     0h before start ->   0% refund
 * No cancellation fee; fee charged per order; customers may self-cancel up to 24h
 * before start; refunds go to card first, then gift card for any remainder.
 *
 * Shape matches computeCancellationRefund in @marina/core and the
 * Operator.cancellation_policy doc comment in schema.prisma.
 *
 * Scoped to operator_id = 'lsra' (the operator IS the tenant row keyed by id).
 * Idempotent: a plain targeted update that re-writes the same JSON every run.
 *
 * Usage: DATABASE_URL=... pnpm --filter @marina/database exec tsx scripts/seed-cancellation-policy.ts
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const OP_ID = 'lsra';

const DEFAULT_POLICY: Prisma.InputJsonValue = {
  tiers: [
    { min_hours_before: 168, refund_percent: 100 },
    { min_hours_before: 24, refund_percent: 50 },
    { min_hours_before: 0, refund_percent: 0 },
  ],
  cancellation_fee_cents: 0,
  fee_scope: 'order',
  self_cancel_hours: 24,
  refund_method: 'card_then_gift',
};

async function main() {
  console.log('Seeding default cancellation policy for operator "lsra" ...');
  const res = await prisma.operator.updateMany({
    where: { id: OP_ID },
    data: { cancellation_policy: DEFAULT_POLICY },
  });
  console.log(`Updated ${res.count} operator row(s).`);
  if (res.count === 0) {
    throw new Error(`Operator "${OP_ID}" not found — nothing seeded.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
