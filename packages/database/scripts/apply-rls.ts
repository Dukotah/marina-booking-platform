/**
 * Applies prisma/rls.sql to the database. Run after every `prisma migrate` so RLS
 * policies cover any newly created tables. Idempotent.
 *
 * Prisma's $executeRawUnsafe sends each call over the extended protocol (a prepared
 * statement), and Postgres forbids multiple commands in one prepared statement
 * (error 42601). So we split the .sql into individual statements — carefully
 * preserving dollar-quoted bodies ($$ ... $$ / $tag$ ... $tag$) and comments — and
 * run them one at a time. DDL runs on the DIRECT (non-pooled) connection.
 *
 * Usage: pnpm --filter @marina/database rls   (needs DIRECT_URL or DATABASE_URL)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '..', 'prisma', 'rls.sql'), 'utf8');

// DDL belongs on a direct (non-pooled) connection; the PgBouncer pooled endpoint
// is for short application queries, not schema changes.
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url } } });

/**
 * Split a SQL script on top-level semicolons, leaving dollar-quoted blocks and
 * comments intact so a `DO $$ ... $$;` block or a function body with inner
 * semicolons stays a single statement.
 */
function splitStatements(input: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let i = 0;
  let dollarTag: string | null = null;

  while (i < input.length) {
    const ch = input[i]!;

    if (dollarTag) {
      if (input.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        buf += ch;
        i += 1;
      }
      continue;
    }

    const two = input.slice(i, i + 2);
    if (two === '--') {
      const nl = input.indexOf('\n', i);
      const end = nl === -1 ? input.length : nl;
      buf += input.slice(i, end);
      i = end;
      continue;
    }
    if (two === '/*') {
      const close = input.indexOf('*/', i + 2);
      const end = close === -1 ? input.length : close + 2;
      buf += input.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(input.slice(i));
      if (m) {
        dollarTag = m[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (ch === ';') {
      const stmt = buf.trim();
      if (stmt) statements.push(stmt);
      buf = '';
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}

async function main() {
  const statements = splitStatements(sql);
  console.log(`Applying RLS policies from prisma/rls.sql (${statements.length} statements) ...`);
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }
  console.log('✅ RLS policies applied.');
}

main()
  .catch((e) => {
    console.error('❌ Failed to apply RLS:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
