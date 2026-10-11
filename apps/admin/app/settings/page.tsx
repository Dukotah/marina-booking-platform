import Link from 'next/link';
import { ChevronRight, Sparkles } from 'lucide-react';
import { PageHeader } from '../../components/shell';
import { getTenantDb, requirePermission } from '../../lib/session';
import { SETTINGS_TABS } from '../../components/settings/tabs';

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
    '/settings/staff': `${staffCount} ${staffCount === 1 ? 'member' : 'members'}`,
  };

  return (
    <>
      <PageHeader
        title="Settings"
        description={`Configure ${brandName}. Grouped so you can find things fast.`}
      />

      <Link
        href="/onboarding"
        className="mb-6 flex min-h-11 items-center justify-between gap-4 rounded-lg border border-line bg-surface px-5 py-4 shadow-sm transition-colors hover:border-accent hover:bg-accent-tint"
      >
        <span className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-tint text-accent-ink">
            <Sparkles className="h-5 w-5 shrink-0" aria-hidden />
          </span>
          <span>
            <span className="block text-sm font-semibold text-ink">Guided setup</span>
            <span className="block text-xs text-ink-body">
              Walk through branding, your first location, and activities in a few minutes.
            </span>
          </span>
        </span>
        <ChevronRight className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden />
      </Link>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SETTINGS_TABS.map((tab) => {
          const Icon = tab.icon;
          const count = counts[tab.href];
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="group flex items-start gap-4 rounded-lg border border-line bg-surface p-5 shadow-sm transition-colors hover:border-accent hover:bg-accent-tint"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-ink-body group-hover:bg-surface group-hover:text-accent-ink">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{tab.label}</span>
                  {count ? (
                    <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-body">
                      {count}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-ink-body">{tab.description}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
