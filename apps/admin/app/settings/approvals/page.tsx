import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import { ApprovalForm, type ApprovalFormValues } from '../../../components/settings/ApprovalForm';

export const dynamic = 'force-dynamic';

/**
 * Manager-approval thresholds. Tenant-scoped via getTenantDb (RLS), gated on
 * operator:manage. Reads the two approval fields off the Operator row:
 *  - `approval_threshold_cents` — a payment/refund at or above this needs a
 *    manager sign-off (null/0 = no amount gate). Shown to staff in dollars.
 *  - `refund_requires_approval` — when on, every refund needs a manager.
 *
 * The gate itself is enforced server-side in the payment/refund paths
 * (apps/api services/approvals.ts `evaluateApproval`); this page only edits the
 * policy values.
 */
export default async function ApprovalsPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const operator = await db.operator.findFirst({
    select: {
      approval_threshold_cents: true,
      refund_requires_approval: true,
    },
  });

  const initial: ApprovalFormValues = {
    approval_threshold_dollars: operator?.approval_threshold_cents
      ? operator.approval_threshold_cents / 100
      : null,
    refund_requires_approval: operator?.refund_requires_approval ?? false,
  };

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Require a manager to sign off on larger payments and on refunds."
      />
      <p className="mb-6 max-w-2xl text-sm text-ink-body">
        Set a dollar threshold and any payment or refund at or above that amount
        will need a manager to approve it before it goes through. Leave the
        threshold blank (or zero) to allow any amount without sign-off. Turn on
        &ldquo;require approval for all refunds&rdquo; to route every refund past a
        manager, no matter how small.
      </p>
      <ApprovalForm initial={initial} />
    </>
  );
}
