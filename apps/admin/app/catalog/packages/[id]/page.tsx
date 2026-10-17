import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AdminShell, PageHeader } from '../../../../components/shell';
import { CatalogTabs } from '../../../../components/catalog/CatalogTabs';
import { PackageForm } from '../../../../components/packages/PackageForm';
import { requirePermission } from '../../../../lib/session';
import { loadActivityOptions, loadPackageForm } from '../loaders';

export const metadata: Metadata = {
  title: 'Edit package',
};

export const dynamic = 'force-dynamic';

export default async function EditPackagePage({ params }: { params: { id: string } }) {
  await requirePermission('activity:write');

  const [defaultValues, activities] = await Promise.all([
    loadPackageForm(params.id),
    loadActivityOptions(),
  ]);

  if (!defaultValues) {
    notFound();
  }

  return (
    <AdminShell>
      <PageHeader title={defaultValues.nameExternal || 'Edit package'} description="Update the bundle and its items." />
      <CatalogTabs />
      <PackageForm
        mode="edit"
        packageId={params.id}
        activities={activities}
        defaultValues={defaultValues}
      />
    </AdminShell>
  );
}
