/**
 * Applies prisma/rls.sql to the database. Run after every `prisma migrate` so RLS
 * policies cover any newly created tables. Idempotent.
 *
 * Usage: pnpm --filter @marina/database rls
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '..', 'prisma', 'rls.sql'), 'utf8');

const prisma = new PrismaClient();

async function main() {
  console.log('Applying RLS policies from prisma/rls.sql ...');
  await prisma.$executeRawUnsafe(sql);
  console.log('✅ RLS policies applied.');
}

main()
  .catch((e) => {
    console.error('❌ Failed to apply RLS:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
