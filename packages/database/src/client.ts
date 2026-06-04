import { PrismaClient, Prisma } from '@prisma/client';
import { TENANT_GUC } from '@marina/types';

/**
 * Tenant-scoped database access.
 *
 * Two connections, two roles — this is D-004's defense in depth:
 *  - `adminPrisma` connects as the database OWNER (DATABASE_URL). The owner has
 *    BYPASSRLS on Neon, so this client ignores RLS. Use it ONLY for platform-level
 *    tasks (migrations, seeding, genuine cross-tenant ops).
 *  - `forOperator(operatorId)` / `withTenant(...)` connect as a dedicated NON-bypass
 *    app role (APP_DATABASE_URL → `app_user`, set up by `pnpm db:approle`) and run
 *    every query inside a transaction with the Postgres GUC `app.current_operator_id`
 *    set. The RLS policies in prisma/rls.sql enforce isolation against that GUC, and
 *    because the role cannot bypass RLS, isolation holds even if app code forgets a
 *    WHERE clause. ALL application/request code must use these, never adminPrisma.
 *
 * If APP_DATABASE_URL is unset the tenant client falls back to the owner connection
 * so local dev still runs — but RLS is then NOT enforced, so we warn loudly. In any
 * deployed environment APP_DATABASE_URL must be set.
 */

const globalForPrisma = globalThis as unknown as {
  adminPrisma?: PrismaClient;
  appPrisma?: PrismaClient;
};

const logLevels: ('warn' | 'error')[] =
  process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'];

export const adminPrisma: PrismaClient =
  globalForPrisma.adminPrisma ?? new PrismaClient({ log: logLevels });

/**
 * The connection the tenant-scoped clients are built on. Connects as the non-bypass
 * app role when APP_DATABASE_URL is set; otherwise falls back to the owner with a
 * warning (RLS NOT enforced — dev convenience only).
 */
const appDbUrl = process.env.APP_DATABASE_URL;
if (!appDbUrl) {
  // eslint-disable-next-line no-console
  console.warn(
    '[database] APP_DATABASE_URL not set — tenant queries fall back to the owner ' +
      'connection, which has BYPASSRLS. Cross-tenant isolation is NOT enforced. ' +
      'Run `pnpm db:approle` and set APP_DATABASE_URL before deploying.',
  );
}

const appPrisma: PrismaClient =
  globalForPrisma.appPrisma ??
  (appDbUrl
    ? new PrismaClient({ log: logLevels, datasources: { db: { url: appDbUrl } } })
    : adminPrisma);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.adminPrisma = adminPrisma;
  globalForPrisma.appPrisma = appPrisma;
}

export type TenantClient = ReturnType<typeof forOperator>;

/**
 * Returns a Prisma client whose every operation is wrapped in a transaction that
 * first sets `app.current_operator_id` (transaction-local), so RLS scopes the
 * query to this operator. Safe under connection pooling (the GUC and the query
 * share one connection within the batch transaction).
 */
export function forOperator(operatorId: string) {
  if (!operatorId) throw new Error('forOperator requires a non-empty operatorId');

  return appPrisma.$extends({
    name: 'tenant-rls',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await appPrisma.$transaction([
            appPrisma.$executeRaw`SELECT set_config(${TENANT_GUC}, ${operatorId}, true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

/**
 * Run arbitrary work as a tenant inside a single interactive transaction with the
 * GUC set — use for multi-step operations (e.g. creating an order + items +
 * payment) that must be atomic and tenant-scoped together.
 */
export async function withTenant<T>(
  operatorId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!operatorId) throw new Error('withTenant requires a non-empty operatorId');
  return appPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${TENANT_GUC}, ${operatorId}, true)`;
    return fn(tx);
  });
}
