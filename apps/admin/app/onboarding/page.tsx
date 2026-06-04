import type { Metadata } from 'next';
import { AdminShell, PageHeader } from '../../components/shell';
import { getTenantDb, requirePermission } from '../../lib/session';
import {
  OnboardingWizard,
  type OnboardingDefaults,
} from '../../components/settings/OnboardingWizard';

export const metadata: Metadata = {
  title: 'Get started',
};

export const dynamic = 'force-dynamic';

/**
 * Guided onboarding for a new operator. Tenant-scoped via getTenantDb (RLS), gated
 * on operator:manage. Prefills the brand step from whatever the operator record
 * already holds so re-running the wizard is non-destructive to existing branding.
 */
export default async function OnboardingPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const operator = await db.operator.findFirst({
    select: {
      name_external: true,
      name_internal: true,
      brand_color: true,
      website: true,
      phone: true,
    },
  });

  const defaults: OnboardingDefaults = {
    name_external: operator?.name_external ?? '',
    name_internal: operator?.name_internal ?? '',
    brand_color: operator?.brand_color ?? '#0ea5e9',
    website: operator?.website ?? '',
    phone: operator?.phone ?? '',
  };

  return (
    <AdminShell>
      <PageHeader
        title="Get started"
        description="A few quick steps to set up your brand, first location, and activities."
      />
      <OnboardingWizard defaults={defaults} />
    </AdminShell>
  );
}
