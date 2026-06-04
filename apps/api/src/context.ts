import type { TenantClient } from '@marina/database';
import type { AuthContext } from '@marina/auth';

/** Variables attached to the Hono context by middleware. */
export type Env = {
  Variables: {
    /** Resolved tenant for this request. */
    operatorId: string;
    /** RLS-scoped Prisma client for this tenant. Use this for ALL data access. */
    db: TenantClient;
    /** Present only after requireStaff middleware runs. */
    auth: AuthContext;
  };
};
