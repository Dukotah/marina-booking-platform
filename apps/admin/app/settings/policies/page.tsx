import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import { PoliciesForm, type PoliciesFormValues } from '../../../components/settings/PoliciesForm';

export const dynamic = 'force-dynamic';

/** Shape of the free-form policy config stored under the "policies" integration. */
interface PolicyConfig {
  cancellation_policy?: unknown;
  checkin_instructions?: unknown;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Policy settings. Tenant-scoped via getTenantDb (RLS), gated on operator:manage.
 * Adult age + timezone come from the Operator row; cancellation / check-in copy
 * from the "policies" Integration config record.
 */
export default async function PoliciesPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const [operator, policies] = await Promise.all([
    db.operator.findFirst({ select: { legal_adult_age: true, timezone: true } }),
    db.integration.findFirst({ where: { key: 'policies' }, select: { config: true } }),
  ]);

  const cfg = (policies?.config ?? {}) as PolicyConfig;

  const initial: PoliciesFormValues = {
    legal_adult_age: operator?.legal_adult_age ?? 18,
    timezone: operator?.timezone ?? 'America/Los_Angeles',
    cancellation_policy: readString(cfg.cancellation_policy),
    checkin_instructions: readString(cfg.checkin_instructions),
  };

  return (
    <>
      <PageHeader
        title="Policies"
        description="Adult age, timezone, cancellation, and check-in rules for your bookings."
      />
      <PoliciesForm initial={initial} />
    </>
  );
}
