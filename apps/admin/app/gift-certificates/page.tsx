import type { Metadata } from 'next';
import { AdminShell, PageHeader, DataTable, KpiCard, type Column } from '../../components/shell';
import { getTenantDb, requirePermission } from '../../lib/session';
import { formatUSD, formatDate } from '../../lib/format';
import { IssueCertificateForm, type ActivityOption } from '../../components/gift-certificates/IssueCertificateForm';

export const metadata: Metadata = {
  title: 'Gift Certificates',
};

export const dynamic = 'force-dynamic';

interface CertRow {
  id: string;
  code: string;
  valueCents: number;
  status: string;
  activityName: string | null;
  recipientEmail: string | null;
  createdAt: Date;
}

/**
 * Gift certificates — single-use certificates DISTINCT from stored-value gift
 * cards. Gated on operator:manage. Lists issued certificates + outstanding
 * liability (sum of ACTIVE values) and lets staff issue a new one. Redemption
 * happens at checkout/POS via the API; this surface issues and reports.
 */
export default async function GiftCertificatesPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const [certs, activities, liability] = await Promise.all([
    db.giftCertificate.findMany({
      orderBy: { created_at: 'desc' },
      include: { activity: { select: { name_external: true } } },
    }),
    db.activity.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { sort_index: 'asc' },
      select: { id: true, name_external: true },
    }),
    db.giftCertificate.aggregate({ where: { status: 'ACTIVE' }, _sum: { value_cents: true } }),
  ]);

  const rows: CertRow[] = certs.map((c) => ({
    id: c.id,
    code: c.code,
    valueCents: c.value_cents,
    status: c.status,
    activityName: c.activity?.name_external ?? null,
    recipientEmail: c.recipient_email,
    createdAt: c.created_at,
  }));

  const activityOptions: ActivityOption[] = activities.map((a) => ({ id: a.id, name: a.name_external }));
  const liabilityCents = liability._sum.value_cents ?? 0;
  const activeCount = rows.filter((r) => r.status === 'ACTIVE').length;

  const columns: Array<Column<CertRow>> = [
    { id: 'code', header: 'Code', cell: (r) => <span className="font-mono">{r.code}</span> },
    { id: 'value', header: 'Value', align: 'right', cell: (r) => formatUSD(r.valueCents) },
    { id: 'scope', header: 'Scope', cell: (r) => r.activityName ?? 'Any (dollar value)' },
    { id: 'status', header: 'Status', cell: (r) => r.status },
    { id: 'recipient', header: 'Recipient', cell: (r) => r.recipientEmail ?? '—' },
    { id: 'issued', header: 'Issued', cell: (r) => formatDate(r.createdAt) },
  ];

  return (
    <AdminShell>
      <PageHeader
        title="Gift Certificates"
        description={`${activeCount} active · redeemable once`}
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Outstanding liability" value={formatUSD(liabilityCents)} />
        <KpiCard label="Active certificates" value={String(activeCount)} />
        <KpiCard label="Total issued" value={String(rows.length)} />
      </div>

      <div className="mb-6">
        <IssueCertificateForm activities={activityOptions} />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        emptyState="No gift certificates issued yet."
      />
    </AdminShell>
  );
}
