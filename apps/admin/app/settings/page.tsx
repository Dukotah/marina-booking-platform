import Link from 'next/link';
import { ChevronRight, Sparkles } from 'lucide-react';
import { PageHeader } from '../../components/shell';
import { getTenantDb, requirePermission } from '../../lib/session';
import { SETTINGS_TABS } from '../../components/settings/SettingsNav';

export const dynamic = 'force-dynamic';

/**
 * Settings hub. Tenant-scoped via getTenantDb (RLS), gated on operator:manage.
 * Surfaces each settings group as a card with a live count where meaningful, plus
 * a prompt to (re)run the guided onboarding wizard. The page never hardcodes a
 * platform brand name — it reads the operator's own external name.
 */
export default async function SettingsHubPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const [operator, locationCount, feeCount, integrationCount, staffCount] = await Promise.all([
    db.operator.findFirst({ select: { name_external: true, name_internal: true } }),
    db.location.count(),
    db.fee.count(),
    db.integration.count({ where: { enabled: true } }),
    db.staffMember.count({ where: { is_active: true } }),
  ]);

  const brandName = operator?.name_external || operator?.name_internal || 'your business';

  const counts: Record<string, string | undefined> = {
    '/settings/locations': `${locationCount} ${locationCount === 1 ? 'location' : 'locations'}`,
    '/settings/fees': `${feeCount} ${feeCount === 1 ? 'fee' : 'fees'}`,
    '/settings/integrations': `${integrationCount} active`,
    '/staff': `${staffCount} ${staffCount === 1 ? 'member' : 'members'}`,
  };

  return (
    <>
      <PageHeader
        title="Settings"
        description={`Configure ${brandName}. Grouped so you can find things fast.`}
      />

      <Link
        href="/onboarding"
        className="mb-6 flex items-center justify-between gap-4 rounded-xl border border-slate-900 bg-slate-900 px-5 py-4 text-white transition-colors hover:bg-slate-800"
      >
        <span className="flex items-center gap-3">
          <Sparkles className="h-5 w-5 shrink-0" aria-hidden />
          <span>
            <span className="block text-sm font-semibold">Guided setup</span>
            <span className="block text-xs text-slate-300">
              Walk through branding, your first location, and activities in a few minutes.
            </span>
          </span>
        </span>
        <ChevronRight className="h-5 w-5 shrink-0" aria-hidden />
      </Link>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SETTINGS_TABS.map((tab) => {
          const Icon = tab.icon;
          const count = counts[tab.href];
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="group flex items-start gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700 group-hover:bg-slate-200">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{tab.label}</span>
                  {count ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                      {count}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">{tab.description}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
