/**
 * Is the local database usable yet?
 *
 * Prints one word so a shell can branch on it without parsing SQL through three
 * layers of quoting (PowerShell -> WSL -> bash -> psql, which is a quoting trap):
 *
 *   NO_SCHEMA  - tables are missing; run migrate + rls + approle + seed
 *   NO_SEED    - schema is there but the seed operator is not; run the seeds
 *   READY      - good to go
 *
 * Exits 0 in every case; the caller reads stdout. Needs DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: [] });

try {
  const operators = await prisma.operator.count();
  console.log(operators > 0 ? 'READY' : 'NO_SEED');
} catch (err) {
  // P2021 = table does not exist; anything else that fails this early means the
  // schema is not usable either, so treat it the same and let migrate sort it out.
  const code = err?.code ?? '';
  if (code === 'P2021' || /does not exist|relation .* does not exist/i.test(String(err?.message))) {
    console.log('NO_SCHEMA');
  } else {
    console.log('NO_SCHEMA');
    console.error(`[ensure-seeded] ${err?.message ?? err}`);
  }
} finally {
  await prisma.$disconnect();
}
