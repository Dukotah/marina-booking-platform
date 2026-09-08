import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import { WaiverEditor, type WaiverData } from '../../../components/settings/WaiverEditor';

export const dynamic = 'force-dynamic';

/**
 * Waiver editor — the operator's own liability waiver, editable without a
 * developer. Tenant-scoped via getTenantDb (RLS), gated on operator:manage.
 *
 * Loads the ACTIVE waiver (most recently created wins, matching the API's
 * GET /api/waivers/active) with its ordered clauses, plus the signature count so
 * the UI can say why past signatures are untouchable. All mutations run through
 * the server actions in ./actions.ts, which enforce the version-bump invariant.
 */
export default async function WaiversSettingsPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const waiver = await db.waiver.findFirst({
    where: { is_active: true },
    orderBy: { created_at: 'desc' },
    include: {
      clauses: { orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }] },
      _count: { select: { signatures: true } },
    },
  });

  const data: WaiverData | null = waiver
    ? {
        id: waiver.id,
        name: waiver.name,
        version: waiver.version,
        introHtml: waiver.intro_html ?? '',
        requiresMinorSignature: waiver.requires_minor_signature,
        signatureCount: waiver._count.signatures,
        clauses: waiver.clauses.map((c) => ({
          id: c.id,
          title: c.title,
          bodyHtml: c.body_html,
          requiresInitials: c.requires_initials,
          isRequired: c.is_required,
        })),
      }
    : null;

  return (
    <>
      <PageHeader
        title="Waivers"
        description="The liability waiver guests sign before getting on the water — edit the intro and each clause, reorder them, and preview exactly what the signer sees."
      />
      <WaiverEditor waiver={data} />
    </>
  );
}
