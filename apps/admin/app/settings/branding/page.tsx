import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import { BrandingForm, type BrandingFormValues } from '../../../components/settings/BrandingForm';

export const dynamic = 'force-dynamic';

/**
 * Branding settings (white-label). Tenant-scoped via getTenantDb (RLS), gated on
 * operator:manage. Loads the operator's own brand fields — never a platform brand.
 */
export default async function BrandingPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const operator = await db.operator.findFirst({
    select: {
      name_internal: true,
      name_external: true,
      website: true,
      phone: true,
      brand_color: true,
      logo_dark_url: true,
      logo_light_url: true,
    },
  });

  const initial: BrandingFormValues = {
    name_internal: operator?.name_internal ?? '',
    name_external: operator?.name_external ?? '',
    website: operator?.website ?? '',
    phone: operator?.phone ?? '',
    brand_color: operator?.brand_color ?? '#0ea5e9',
    logo_dark_url: operator?.logo_dark_url ?? '',
    logo_light_url: operator?.logo_light_url ?? '',
  };

  return (
    <>
      <PageHeader
        title="Branding"
        description="Your name, logos, and brand color. This is what customers see — fully white-label."
      />
      <BrandingForm initial={initial} />
    </>
  );
}
