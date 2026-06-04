/**
 * Creates the dedicated application database role used for all runtime / tenant
 * queries. THIS IS A SECURITY-CRITICAL ROLE.
 *
 * Neon's default `neondb_owner` role has the BYPASSRLS attribute, so it ignores
 * Row-Level Security entirely — using it for tenant queries would silently defeat
 * cross-tenant isolation (docs/DECISIONS.md D-004). This script provisions a
 * separate `app_user` role that:
 *   - has LOGIN with the password from APP_DB_PASSWORD,
 *   - is NOBYPASSRLS (so RLS policies apply to it), and is NOT a table owner
 *     (so it can never bypass RLS even without FORCE),
 *   - has CRUD on all current + future tables and EXECUTE on the tenant-resolver.
 *
 * Runs as the owner over the DIRECT (non-pooled) connection. Idempotent.
 *
 * Usage: APP_DB_PASSWORD=... pnpm db:approle
 */
import { PrismaClient } from '@prisma/client';

const ROLE = 'app_user';
const password = process.env.APP_DB_PASSWORD;
const ownerUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!password) {
  console.error('❌ APP_DB_PASSWORD is required (the password for the app_user role).');
  process.exit(1);
}
if (!/^[A-Za-z0-9]+$/.test(password)) {
  // We interpolate the password into a CREATE/ALTER ROLE statement (those can't
  // take bind params), so restrict it to alphanumerics to keep that safe.
  console.error('❌ APP_DB_PASSWORD must be alphanumeric (no quotes/specials).');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

const statements = [
  // Create or update the role (single DO block = one command).
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
       CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}' NOBYPASSRLS;
     ELSE
       ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${password}' NOBYPASSRLS;
     END IF;
   END
   $$;`,
  `GRANT USAGE ON SCHEMA public TO ${ROLE}`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`,
  `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ROLE}`,
  // Future objects created by the owner during later migrations.
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE}`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${ROLE}`,
];

async function main() {
  console.log(`Provisioning non-bypass app role "${ROLE}" ...`);
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }
  const [row] = await prisma.$queryRawUnsafe<any[]>(
    `SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = '${ROLE}'`,
  );
  console.log(`✅ ${ROLE} ready (login=${row.rolcanlogin}, bypassrls=${row.rolbypassrls}).`);
  if (row.rolbypassrls) {
    console.error('❌ app_user unexpectedly has BYPASSRLS — isolation would NOT hold.');
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error('❌ Failed to set up app role:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
