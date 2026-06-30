export { adminPrisma, forOperator, withTenant } from './client.js';
export type { TenantClient } from './client.js';
export {
  createOperator,
  ProvisionError,
  type NewOperatorInput,
  type NewOperatorResult,
} from './provision.js';
export * from '@prisma/client';
