import type { Metadata } from 'next';
import { AdminShell, PageHeader, DataTable, type Column } from '../../../components/shell';
import { StatCard, Badge } from '../../../components/ui';
import { CatalogTabs } from '../../../components/catalog/CatalogTabs';
import { getTenantDb, requirePermission } from '../../../lib/session';
import { formatUSD, formatDate } from '../../../lib/format';
import { IssueGiftCardForm } from '../../../components/gift-cards/IssueGiftCardForm';

export const metadata: Metadata = {
  title: 'Gift Cards',
};

export const dynamic = 'force-dynamic';

interface CardRow {
  id: string;
  code: string;
  initialCents: number;
  balanceCents: number;
  status: string;
  recipientEmail: string | null;
  createdAt: Date;
}

const STATUS_TONE: Record<string, 'success' | 'cancelled' | 'neutral'> = {
  ACTIVE: 'success',
  REDEEMED: 'neutral',
  VOID: 'cancelled',
  EXPIRED: 'cancelled',
};

/**
 * Catalog — Gift cards tab. Stored-value gift cards (a balance in cents drawn
 * down over multiple redemptions) DISTINCT from single-use gift certificates.
 * Gated on operator:manage. Lists issued cards + outstanding liability (sum of
 * remaining balance on ACTIVE cards) and lets staff issue a new one. Redemption
 * happens at checkout/POS via the API; this surface issues + reports.
 */
export default async function GiftCardsPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const [cards, liability] = await Promise.all([
    db.giftCard.findMany({ orderBy: { created_at: 'desc' } }),
    db.giftCard.aggregate({ where: { status: 'ACTIVE' }, _sum: { balance_cents: true } }),
  ]);

  const rows: CardRow[] = cards.map((c) => ({
    id: c.id,
    code: c.code,
    initialCents: c.initial_cents,
    balanceCents: c.balance_cents,
    status: c.status,
    recipientEmail: c.recipient_email,
    createdAt: c.created_at,
  }));

  const liabilityCents = liability._sum.balance_cents ?? 0;
  const activeCount = rows.filter((r) => r.status === 'ACTIVE').length;

  const columns: Array<Column<CardRow>> = [
    {
      id: 'code',
      header: 'Code',
      cell: (r) => <span className="font-mono text-ink">{r.code}</span>,
    },
    {
      id: 'balance',
      header: 'Balance',
      align: 'right',
      cell: (r) => <span className="tabular-nums">{formatUSD(r.balanceCents)}</span>,
    },
    {
      id: 'initial',
      header: 'Loaded',
      align: 'right',
      cell: (r) => <span className="tabular-nums text-ink-muted">{formatUSD(r.initialCents)}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (
        <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>
          {r.status.charAt(0) + r.status.slice(1).toLowerCase()}
        </Badge>
      ),
    },
    {
      id: 'recipient',
      header: 'Recipient',
      cell: (r) => r.recipientEmail ?? <span className="text-ink-muted">—</span>,
    },
    { id: 'issued', header: 'Issued', cell: (r) => formatDate(r.createdAt) },
  ];

  return (
    <AdminShell>
      <PageHeader title="Gift Cards" description={`${activeCount} active · stored value`} />

      <CatalogTabs />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Outstanding liability" value={formatUSD(liabilityCents)} tone="owed" />
        <StatCard label="Active cards" value={String(activeCount)} />
        <StatCard label="Total issued" value={String(rows.length)} />
      </div>

      <div className="mb-6">
        <IssueGiftCardForm />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        emptyState="No gift cards issued yet."
      />
    </AdminShell>
  );
}
