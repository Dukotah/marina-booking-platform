import type { Metadata } from 'next';
import { AdminShell, PageHeader } from '../../../../components/shell';
import { CatalogTabs } from '../../../../components/catalog/CatalogTabs';
import { PackageForm } from '../../../../components/packages/PackageForm';
import { requirePermission } from '../../../../lib/session';
import { loadActivityOptions } from '../loaders';

export const metadata: Metadata = {
  title: 'New package',
};

export const dynamic = 'force-dynamic';

export default async function NewPackagePage() {
  await requirePermission('activity:write');
  const activities = await loadActivityOptions();

  return (
    <AdminShell>
      <PageHeader title="New package" description="Bundle activities at a single price." />
      <CatalogTabs />
      <PackageForm mode="create" activities={activities} />
    </AdminShell>
  );
}
