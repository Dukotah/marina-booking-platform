import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import { PoliciesForm, type PoliciesFormValues } from '../../../components/settings/PoliciesForm';
import {
  CancellationPolicyForm,
  type CancellationPolicyFormValues,
} from '../../../components/settings/CancellationPolicyForm';

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
 * Coerce the stored `Operator.cancellation_policy` JSON into the editor's form
 * values. A missing/garbage policy falls back to the same sensible default the
 * seed writes (168h→100%, 24h→50%, 0h→0%), so the editor always opens on a usable
 * starting point rather than an empty form.
 */
function readCancellationPolicy(raw: unknown): CancellationPolicyFormValues {
  const fallback: CancellationPolicyFormValues = {
    tiers: [
      { min_hours_before: 168, refund_percent: 100 },
      { min_hours_before: 24, refund_percent: 50 },
      { min_hours_before: 0, refund_percent: 0 },
    ],
    cancellation_fee_dollars: 0,
    fee_scope: 'order',
    self_cancel_hours: 24,
    refund_method: 'card_then_gift',
  };
  if (!raw || typeof raw !== 'object') return fallback;
  const p = raw as Record<string, unknown>;
  if (!Array.isArray(p.tiers)) return fallback;

  const tiers = p.tiers
    .map((t) => {
      const row = (t ?? {}) as Record<string, unknown>;
      return {
        min_hours_before: Math.max(0, Number(row.min_hours_before) || 0),
        refund_percent: Math.min(100, Math.max(0, Number(row.refund_percent) || 0)),
      };
    })
    .sort((a, b) => b.min_hours_before - a.min_hours_before);

  return {
    tiers: tiers.length > 0 ? tiers : fallback.tiers,
    cancellation_fee_dollars: Math.max(0, Number(p.cancellation_fee_cents) || 0) / 100,
    fee_scope: p.fee_scope === 'guest' ? 'guest' : 'order',
    self_cancel_hours: Math.max(0, Number(p.self_cancel_hours) || 0),
    refund_method:
      p.refund_method === 'gift_card' || p.refund_method === 'card_then_gift'
        ? p.refund_method
        : 'card',
  };
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
    db.operator.findFirst({
      select: {
        legal_adult_age: true,
        timezone: true,
        cancellation_policy: true,
      },
    }),
    db.integration.findFirst({ where: { key: 'policies' }, select: { config: true } }),
  ]);

  const cfg = (policies?.config ?? {}) as PolicyConfig;

  const initial: PoliciesFormValues = {
    legal_adult_age: operator?.legal_adult_age ?? 18,
    timezone: operator?.timezone ?? 'America/Los_Angeles',
    cancellation_policy: readString(cfg.cancellation_policy),
    checkin_instructions: readString(cfg.checkin_instructions),
  };

  const cancellationInitial = readCancellationPolicy(operator?.cancellation_policy ?? null);

  return (
    <>
      <PageHeader
        title="Policies"
        description="Adult age, timezone, cancellation, and check-in rules for your bookings."
      />
      <PoliciesForm initial={initial} />

      <div className="mt-8">
        <CancellationPolicyForm initial={cancellationInitial} />
      </div>
    </>
  );
}
