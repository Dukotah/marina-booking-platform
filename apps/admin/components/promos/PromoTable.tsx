'use client';

import { DataTable, type Column } from '../shell/DataTable';
import { formatDate, formatNumber } from '../../lib/format';
import { PromoRowActions } from './PromoRowActions';

export interface PromoRow {
  id: string;
  code: string;
  name: string;
  discountType: string;
  discountValue: number;
  isActive: boolean;
  timesRedeemed: number;
  maxRedemptions: number | null;
  validFrom: string | null;
  validUntil: string | null;
}

function formatDiscount(type: string, value: number): string {
  if (type === 'PERCENT') return `${value}% off`;
  return `$${value.toFixed(2)} off`; // FLAT
}

function formatDateRange(from: string | null, until: string | null): string {
  if (!from && !until) return '—';
  if (from && until) return `${formatDate(from)} – ${formatDate(until)}`;
  if (from) return `From ${formatDate(from)}`;
  return `Until ${formatDate(until!)}`;
}

/**
 * Promo code list table. Renders all promo codes with their discount, redemption
 * count, date range, and status, plus inline pause/resume and delete actions.
 */
export function PromoTable({ rows }: { rows: PromoRow[] }) {
  const columns: Array<Column<PromoRow>> = [
    {
      id: 'code',
      header: 'Code',
      cell: (row) => (
        <span className="font-mono font-semibold tracking-wide text-slate-900">{row.code}</span>
      ),
    },
    {
      id: 'name',
      header: 'Name',
      cell: (row) => <span className="text-slate-700">{row.name}</span>,
    },
    {
      id: 'discount',
      header: 'Discount',
      cell: (row) => (
        <span className="font-medium text-slate-900">
          {formatDiscount(row.discountType, row.discountValue)}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) =>
        row.isActive ? (
          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
            Active
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
            Paused
          </span>
        ),
    },
    {
      id: 'redeemed',
      header: 'Redeemed',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums text-slate-700">
          {formatNumber(row.timesRedeemed)}
          {row.maxRedemptions !== null ? ` / ${formatNumber(row.maxRedemptions)}` : ''}
        </span>
      ),
    },
    {
      id: 'validity',
      header: 'Validity',
      cell: (row) => (
        <span className="text-xs text-slate-500">
          {formatDateRange(row.validFrom, row.validUntil)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      className: 'w-24',
      cell: (row) => (
        <PromoRowActions id={row.id} isActive={row.isActive} code={row.code} />
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      emptyState={
        <div className="py-12 text-center text-sm text-slate-400">
          No promo codes yet. Create one to get started.
        </div>
      }
    />
  );
}
