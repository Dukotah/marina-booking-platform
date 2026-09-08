'use client';

/**
 * Reservation summary card: the selected activity, rate, date/time, duration,
 * and a quantity stepper (clamped to what's bookable). The quantity is owned by
 * the parent so it can keep the participant field array and pricing in sync.
 * White-label: the activity accent color comes from operator data.
 */
import { Minus, Plus } from 'lucide-react';
import { formatUSD } from '@marina/core';
import { cn } from '@marina/ui';
import { formatLongDate, formatTime, formatDuration } from '@/lib/format';
import type { CheckoutSelection } from './types';

interface OrderSummaryProps {
  selection: CheckoutSelection;
  quantity: number;
  onQuantityChange: (quantity: number) => void;
}

export function OrderSummary({
  selection,
  quantity,
  onQuantityChange,
}: OrderSummaryProps) {
  const min = Math.max(1, selection.minParticipants || 1);
  const max = selection.maxQuantity;

  const dec = () => onQuantityChange(Math.max(min, quantity - 1));
  const inc = () => onQuantityChange(Math.min(max, quantity + 1));

  return (
    <div>
      {/* Estate: no colored left bar (hard ban) — the name carries the card. */}
      <div className="min-w-0">
        <h3 className="truncate text-base font-medium text-ink">
          {selection.activityName}
        </h3>
        <p className="text-sm text-muted">{selection.rate.name}</p>
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Date</dt>
          <dd className="tnum text-right font-medium text-ink">
            {formatLongDate(selection.datetime)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Time</dt>
          <dd className="tnum text-right font-medium text-ink">
            {formatTime(selection.datetime)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Duration</dt>
          <dd className="tnum text-right font-medium text-ink">
            {formatDuration(selection.rate.durationMinutes) || '—'}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Price</dt>
          <dd className="tnum text-right font-medium text-ink">
            {formatUSD(selection.rate.priceCents)} each
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-sm font-medium text-ink">Guests</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={dec}
            disabled={quantity <= min}
            aria-label="Decrease quantity"
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg border border-hairline text-ink transition-colors',
              'hover:bg-bg disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <Minus className="h-4 w-4" aria-hidden />
          </button>
          <span
            className="tnum w-6 text-center text-base font-semibold text-ink"
            aria-live="polite"
          >
            {quantity}
          </span>
          <button
            type="button"
            onClick={inc}
            disabled={quantity >= max}
            aria-label="Increase quantity"
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg border border-hairline text-ink transition-colors',
              'hover:bg-bg disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      {quantity >= max && (
        <p className="mt-1 text-right text-xs text-muted">
          Maximum available for this time.
        </p>
      )}
    </div>
  );
}
