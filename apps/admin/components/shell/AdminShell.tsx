import type { ReactNode } from 'react';
import { getOperatorContext, getTenantDb } from '../../lib/session';
import { isPlatformAdmin, getActiveOperatorOverride } from '../../lib/platform';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { ExitImpersonationBanner } from './ExitImpersonationBanner';

/** Title-case a builtin role for display ("OWNER" -> "Owner"). */
function roleLabel(role: string): string {
  return role.charAt(0) + role.slice(1).toLowerCase();
}

/**
 * The admin app frame: a persistent left rail + top bar wrapping page content.
 * It resolves the operator (white-label branding) and the signed-in staff
 * identity server-side, so every page rendered inside it is tenant-correct
 * without each page re-fetching chrome data.
 *
 * Page slices render their content as `children`; they typically wrap it in a
 * <PageHeader/> for the title row.
 */
export async function AdminShell({ children }: { children: ReactNode }) {
  const { operatorId, auth } = await getOperatorContext();

  // Load white-label branding for this operator. Tenant-scoped client → RLS
  // guarantees we can only read this operator's row.
  const db = await getTenantDb();
  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { name_external: true, name_internal: true, logo_light_url: true },
  });

  // Never hardcode platform branding; fall back to a neutral generic label only
  // if the operator record can't be read (e.g. unseeded dev DB).
  const brandName = operator?.name_external || operator?.name_internal || 'Admin';
  const logoUrl = operator?.logo_light_url ?? null;

  const userName = auth.userId === 'dev-owner' ? 'Dev Owner' : auth.userId;

  const platformAdmin = isPlatformAdmin(auth.userId);
  const impersonating = platformAdmin && Boolean(getActiveOperatorOverride());

  return (
    <div className="flex h-screen overflow-hidden bg-slate-100">
      <Sidebar brandName={brandName} logoUrl={logoUrl} showPlatformLink={platformAdmin} />
      <div className="flex min-w-0 flex-1 flex-col">
        {impersonating && <ExitImpersonationBanner clientName={brandName} />}
        <Topbar brandName={brandName} userName={userName} roleLabel={roleLabel(auth.role)} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl p-4 md:p-6 lg:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
