import type { Metadata } from 'next';
import { AdminShell, PageHeader, KpiCard } from '../../components/shell';
import { requirePermission, currentPermissions } from '../../lib/session';
import { formatUSD, formatNumber } from '../../lib/format';
import { GiftCardTable } from '../../components/giftcards/GiftCardTable';
import { IssueGiftCardDialog } from '../../components/giftcards/IssueGiftCardDialog';
import { apiGet } from '../../lib/apiClient';
import type { GiftCard } from './actions';
import { Gift } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Gift Cards',
};

export const dynamic = 'force-dynamic';

/**
 * Gift card management page.
 *
 * Gated on order:read (same permission the list endpoint requires). Issue,
 * redeem, adjust, void, and reactivate are gated individually in the child
 * components / actions based on order:write or order:refund.
 *
 * Data comes exclusively from the API (which owns the signed ledger) — never
 * from the database directly.
 */
export default async function GiftCardsPage() {
  await requirePermission('order:read');

  // Resolve which tier the current staff holds so child components can show /
  // hide destructive controls without their own server round-trips.
  const permissions = await currentPermissions();
  const canWrite = permissions.has('order:write');
  const canRefund = permissions.has('order:refund');

  let giftCards: GiftCard[] = [];
  let total = 0;
  let fetchError: string | null = null;

  try {
    const data = await apiGet<{
      giftCards: GiftCard[];
      pagination: { total: number; limit: number; offset: number };
    }>('/api/giftcards', { limit: 200, offset: 0 });
    giftCards = data.giftCards;
    total = data.pagination.total;
  } catch (err) {
    console.error('[giftcards page] failed to load gift cards:', err);
    fetchError = 'Could not load gift cards. The API may be unavailable.';
  }

  // Aggregate KPIs from the fetched page (accurate for ≤200 cards; a follow-up
  // can add a dedicated stats endpoint if counts grow large).
  const activeCards = giftCards.filter((c) => c.isActive);
  const totalIssuedCents = giftCards.reduce((sum, c) => sum + c.initialCents, 0);
  const totalBalanceCents = giftCards.reduce((sum, c) => sum + c.balanceCents, 0);

  const description = fetchError
    ? undefined
    : `${formatNumber(total)} ${total === 1 ? 'card' : 'cards'}${
        total > 200 ? ' · showing first 200' : ''
      }`;

  return (
    <AdminShell>
      <PageHeader
        title="Gift Cards"
        description={description}
        actions={canWrite ? <IssueGiftCardDialog /> : undefined}
      />

      {fetchError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {fetchError}
        </div>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <KpiCard
              label="Total issued"
              value={formatNumber(total)}
              icon={Gift}
            />
            <KpiCard
              label="Active cards"
              value={formatNumber(activeCards.length)}
            />
            <KpiCard
              label="Total issued value"
              value={formatUSD(totalIssuedCents)}
            />
            <KpiCard
              label="Outstanding balance"
              value={formatUSD(totalBalanceCents)}
            />
          </div>

          <GiftCardTable
            rows={giftCards}
            canWrite={canWrite}
            canRefund={canRefund}
          />

          {total > 200 ? (
            <p className="mt-3 text-xs text-slate-400">
              Showing the first 200 cards. Use code lookup in the row actions to find a specific card.
            </p>
          ) : null}
        </>
      )}
    </AdminShell>
  );
}
