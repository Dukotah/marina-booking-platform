import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import {
  QuestionsManager,
  type QuestionRow,
  type QuestionOption,
} from '../../../components/settings/QuestionsManager';

export const dynamic = 'force-dynamic';

/**
 * Customer questions. Tenant-scoped via getTenantDb (RLS), gated on operator:manage.
 * Operator-defined checkout fields captured on the order; optionally scoped to an
 * activity and/or a single rate, with per-question control over whether the answer
 * appears in the confirmation email.
 */
export default async function QuestionsPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const [questions, activities, rates] = await Promise.all([
    db.customerQuestion.findMany({
      orderBy: [{ sort_index: 'asc' }, { created_at: 'asc' }],
      select: {
        id: true,
        label: true,
        type: true,
        required: true,
        options: true,
        applies_to: true,
        applies_to_rate: true,
        show_in_confirmation: true,
        is_active: true,
        sort_index: true,
      },
    }),
    db.activity.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name_external: 'asc' },
      select: { id: true, name_external: true },
    }),
    db.rate.findMany({
      where: { is_active: true },
      orderBy: { name_external: 'asc' },
      select: { id: true, name_external: true },
    }),
  ]);

  const rows: QuestionRow[] = questions.map((q) => ({
    id: q.id,
    label: q.label,
    type: q.type,
    required: q.required,
    options: q.options,
    appliesTo: q.applies_to,
    appliesToRate: q.applies_to_rate,
    showInConfirmation: q.show_in_confirmation,
    isActive: q.is_active,
    sortIndex: q.sort_index,
  }));

  const activityOptions: QuestionOption[] = activities.map((a) => ({
    id: a.id,
    label: a.name_external,
  }));
  const rateOptions: QuestionOption[] = rates.map((r) => ({
    id: r.id,
    label: r.name_external,
  }));

  return (
    <>
      <PageHeader
        title="Customer Questions"
        description="Collect the extra details you need from guests at checkout."
      />
      <QuestionsManager questions={rows} activities={activityOptions} rates={rateOptions} />
    </>
  );
}
