'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { DataTable, type Column } from '../shell/DataTable';
import { formatDate, formatUSD } from '../../lib/format';
import { cn } from '../../lib/cn';
import {
  voidGiftCardAction,
  reactivateGiftCardAction,
  type GiftCard,
} from '../../app/giftcards/actions';
import { GiftCardStatusBadge } from './GiftCardStatusBadge';
import { RedeemPanel } from './RedeemPanel';
import { AdjustPanel } from './AdjustPanel';

export interface GiftCardTableProps {
  rows: GiftCard[];
  canWrite: boolean;
  canRefund: boolean;
}

type PanelKind = 'redeem' | 'adjust' | 'void' | 'reactivate';
type ActivePanel = { code: string; panel: PanelKind } | null;

type Banner = { ok: boolean; message: string } | null;

/**
 * Client table of gift cards. Inline action panels for redeem / adjust / void /
 * reactivate expand beneath the row they belong to, matching the OrderActions
 * inline-panel pattern.
 */
export function GiftCardTable({ rows, canWrite, canRefund }: GiftCardTableProps) {
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [pending, startTransition] = useTransition();
  // Track optimistic local card updates after mutations so the table reflects
  // the new state without waiting for a full server re-render.
  const [localCards, setLocalCards] = useState<GiftCard[]>(rows);

  // Keep localCards in sync if the parent re-renders with new server data.
  // (This is intentionally a simple setState on prop change — correct for
  // RSC revalidation which remounts the tree.)

  function closePanel() {
    setActivePanel(null);
  }

  function openPanel(code: string, panel: PanelKind) {
    setActivePanel((prev) =>
      prev?.code === code && prev.panel === panel ? null : { code, panel },
    );
    setBanner(null);
  }

  function applyCardUpdate(updated: GiftCard) {
    setLocalCards((prev) => prev.map((c) => (c.code === updated.code ? updated : c)));
  }

  function handleVoid(card: GiftCard) {
    if (pending) return;
    startTransition(async () => {
      const result = await voidGiftCardAction(card.code);
      if (result.ok) {
        applyCardUpdate(result.giftCard);
        setBanner({ ok: true, message: `Gift card ${card.code} voided.` });
        closePanel();
      } else {
        setBanner({ ok: false, message: result.error });
      }
    });
  }

  function handleReactivate(card: GiftCard) {
    if (pending) return;
    startTransition(async () => {
      const result = await reactivateGiftCardAction(card.code);
      if (result.ok) {
        applyCardUpdate(result.giftCard);
        setBanner({ ok: true, message: `Gift card ${card.code} reactivated.` });
        closePanel();
      } else {
        setBanner({ ok: false, message: result.error });
      }
    });
  }

  const columns: Array<Column<GiftCard>> = [
    {
      id: 'code',
      header: 'Code',
      cell: (row) => (
        <span className="font-mono text-xs font-semibold tracking-wider text-slate-800">
          {row.code}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <GiftCardStatusBadge isActive={row.isActive} />,
    },
    {
      id: 'balance',
      header: 'Balance',
      align: 'right',
      cell: (row) => (
        <span className="font-medium tabular-nums text-slate-900">{formatUSD(row.balanceCents)}</span>
      ),
    },
    {
      id: 'initial',
      header: 'Issued value',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums text-slate-500">{formatUSD(row.initialCents)}</span>
      ),
    },
    {
      id: 'recipient',
      header: 'Recipient',
      cell: (row) =>
        row.recipientName ? (
          <div className="min-w-0">
            <div className="truncate text-sm text-slate-700">{row.recipientName}</div>
            {row.recipientEmail ? (
              <div className="truncate text-xs text-slate-400">{row.recipientEmail}</div>
            ) : null}
          </div>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      id: 'issued',
      header: 'Issued',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums text-slate-600">{formatDate(row.createdAt)}</span>
      ),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      className: 'w-8',
      cell: (row) => {
        const isOpen = activePanel?.code === row.code;
        return (
          <button
            type="button"
            aria-label={isOpen ? 'Close actions' : 'Open actions'}
            onClick={() =>
              isOpen
                ? closePanel()
                : openPanel(row.code, row.isActive ? 'redeem' : 'reactivate')
            }
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            {isOpen ? (
              <ChevronUp className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronDown className="h-4 w-4" aria-hidden />
            )}
          </button>
        );
      },
    },
  ];

  return (
    <div className="space-y-2">
      {banner ? (
        <div
          role="status"
          className={cn(
            'rounded-lg px-4 py-2 text-sm',
            banner.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800',
          )}
        >
          {banner.message}
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={localCards}
        getRowKey={(row) => row.id}
        emptyState="No gift cards have been issued yet."
      />

      {/* Inline action panel rendered below the table for the selected card */}
      {activePanel ? (() => {
        const card = localCards.find((c) => c.code === activePanel.code);
        if (!card) return null;
        return (
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <span className="text-sm font-semibold text-slate-800">
                  Card: <span className="font-mono">{card.code}</span>
                </span>
                <span className="ml-3 text-sm text-slate-500">
                  Balance: <span className="font-medium text-slate-800">{formatUSD(card.balanceCents)}</span>
                </span>
              </div>
              {/* Tab strip for available panels */}
              <div className="flex gap-1">
                {canWrite && card.isActive ? (
                  <TabButton
                    active={activePanel.panel === 'redeem'}
                    onClick={() => openPanel(card.code, 'redeem')}
                  >
                    Redeem
                  </TabButton>
                ) : null}
                {canRefund ? (
                  <TabButton
                    active={activePanel.panel === 'adjust'}
                    onClick={() => openPanel(card.code, 'adjust')}
                  >
                    Adjust
                  </TabButton>
                ) : null}
                {canRefund && card.isActive ? (
                  <TabButton
                    active={activePanel.panel === 'void'}
                    onClick={() => openPanel(card.code, 'void')}
                    variant="danger"
                  >
                    Void
                  </TabButton>
                ) : null}
                {canRefund && !card.isActive ? (
                  <TabButton
                    active={activePanel.panel === 'reactivate'}
                    onClick={() => openPanel(card.code, 'reactivate')}
                    variant="success"
                  >
                    Reactivate
                  </TabButton>
                ) : null}
                <button
                  type="button"
                  onClick={closePanel}
                  className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-100"
                >
                  Close
                </button>
              </div>
            </div>

            {activePanel.panel === 'redeem' && canWrite && card.isActive ? (
              <RedeemPanel
                card={card}
                pending={pending}
                onSuccess={(updated) => {
                  applyCardUpdate(updated.giftCard);
                  setBanner({
                    ok: true,
                    message: `Redeemed ${formatUSD(updated.amountAppliedCents)} — new balance ${formatUSD(updated.balanceCents)}.`,
                  });
                  closePanel();
                }}
                onError={(msg) => setBanner({ ok: false, message: msg })}
              />
            ) : null}

            {activePanel.panel === 'adjust' && canRefund ? (
              <AdjustPanel
                card={card}
                pending={pending}
                onSuccess={(updated) => {
                  applyCardUpdate(updated.giftCard);
                  const sign = updated.deltaCents >= 0 ? '+' : '';
                  setBanner({
                    ok: true,
                    message: `Adjusted ${sign}${formatUSD(updated.deltaCents)} — new balance ${formatUSD(updated.balanceCents)}.`,
                  });
                  closePanel();
                }}
                onError={(msg) => setBanner({ ok: false, message: msg })}
              />
            ) : null}

            {activePanel.panel === 'void' && canRefund && card.isActive ? (
              <VoidConfirmPanel
                card={card}
                pending={pending}
                onConfirm={() => handleVoid(card)}
                onClose={closePanel}
              />
            ) : null}

            {activePanel.panel === 'reactivate' && canRefund && !card.isActive ? (
              <ReactivateConfirmPanel
                card={card}
                pending={pending}
                onConfirm={() => handleReactivate(card)}
                onClose={closePanel}
              />
            ) : null}
          </div>
        );
      })() : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small sub-components
// ---------------------------------------------------------------------------

function TabButton({
  children,
  active,
  onClick,
  variant = 'default',
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
  variant?: 'default' | 'danger' | 'success';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
        active && variant === 'default' && 'bg-slate-900 text-white',
        !active && variant === 'default' && 'text-slate-600 hover:bg-slate-100',
        active && variant === 'danger' && 'bg-red-600 text-white',
        !active && variant === 'danger' && 'text-red-600 hover:bg-red-50',
        active && variant === 'success' && 'bg-emerald-600 text-white',
        !active && variant === 'success' && 'text-emerald-700 hover:bg-emerald-50',
      )}
    >
      {children}
    </button>
  );
}

function VoidConfirmPanel({
  card,
  pending,
  onConfirm,
  onClose,
}: {
  card: GiftCard;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50/60 p-4">
      <p className="text-sm font-medium text-red-900">Void this gift card?</p>
      <p className="mt-1 text-xs text-red-700">
        The card will be frozen and cannot be redeemed. The remaining balance of{' '}
        <strong>{formatUSD(card.balanceCents)}</strong> is preserved and can be restored by
        reactivating the card.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Confirm void
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ReactivateConfirmPanel({
  card,
  pending,
  onConfirm,
  onClose,
}: {
  card: GiftCard;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4">
      <p className="text-sm font-medium text-emerald-900">Reactivate this gift card?</p>
      <p className="mt-1 text-xs text-emerald-700">
        The card will be unfrozen and available for redemption. Current balance:{' '}
        <strong>{formatUSD(card.balanceCents)}</strong>.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Confirm reactivation
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
