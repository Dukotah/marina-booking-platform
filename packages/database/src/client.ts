import { PrismaClient, Prisma } from '@prisma/client';
import { TENANT_GUC } from '@marina/types';

/**
 * Tenant-scoped database access.
 *
 * `adminPrisma` bypasses tenant scoping and must ONLY be used for platform-level
 * tasks (migrations, seeding, cross-tenant ops). Application/request code must use
 * `forOperator(operatorId)` so that every query runs inside a transaction with the
 * Postgres GUC `app.current_operator_id` set — which is what the RLS policies in
 * prisma/rls.sql enforce against. This is the app-layer half of D-004's defense in
 * depth; RLS is the DB-layer half.
 */

const globalForPrisma = globalThis as unknown as { adminPrisma?: PrismaClient };

export const adminPrisma: PrismaClient =
  globalForPrisma.adminPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.adminPrisma = adminPrisma;
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

  return adminPrisma.$extends({
    name: 'tenant-rls',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await adminPrisma.$transaction([
            adminPrisma.$executeRaw`SELECT set_config(${TENANT_GUC}, ${operatorId}, true)`,
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
  return adminPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${TENANT_GUC}, ${operatorId}, true)`;
    return fn(tx);
  });
}
