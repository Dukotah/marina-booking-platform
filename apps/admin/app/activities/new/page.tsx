import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { AdminShell, PageHeader } from '../../../components/shell';
import { ActivityWizard } from '../../../components/activities/ActivityWizard';
import { emptyActivityForm } from '../../../components/activities/types';
import { loadLocationOptions } from '../loaders';
import { requirePermission } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Create a new activity via the 4-step wizard. Gated by `activity:write` — the
 * permission check throws (handled by the error boundary) for unauthorized staff.
 */
export default async function NewActivityPage() {
  await requirePermission('activity:write');
  const locations = await loadLocationOptions();

  return (
    <AdminShell>
      <PageHeader
        title="New activity"
        description="Set up a bookable offering in four quick steps."
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

      <ActivityWizard mode="create" defaultValues={emptyActivityForm()} locations={locations} />
    </AdminShell>
  );
}
