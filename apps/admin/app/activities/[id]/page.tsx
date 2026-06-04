import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { AdminShell, PageHeader } from '../../../components/shell';
import { ActivityWizard } from '../../../components/activities/ActivityWizard';
import { loadActivityForm, loadLocationOptions } from '../loaders';
import { requirePermission } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Edit an existing activity via the same 4-step wizard. Loads the activity
 * (tenant-scoped) and its rates into the form. 404s when the id doesn't resolve
 * for the current operator. Gated by `activity:write`.
 */
export default async function EditActivityPage({ params }: { params: { id: string } }) {
  await requirePermission('activity:write');

  const [defaultValues, locations] = await Promise.all([
    loadActivityForm(params.id),
    loadLocationOptions(),
  ]);

  if (!defaultValues) {
    notFound();
  }

  return (
    <AdminShell>
      <PageHeader
        title={defaultValues.name_external || 'Edit activity'}
        description="Update details, rates, and scheduling."
        actions={
          <Link
            href="/activities"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Back to activities
          </Link>
        }
      />

      <ActivityWizard
        mode="edit"
        activityId={params.id}
        defaultValues={defaultValues}
        locations={locations}
      />
    </AdminShell>
  );
}
