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
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-1 h-10 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: selection.color }}
        />
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-slate-900">
            {selection.activityName}
          </h3>
          <p className="text-sm text-slate-500">{selection.rate.name}</p>
        </div>
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">Date</dt>
          <dd className="text-right font-medium text-slate-900">
            {formatLongDate(selection.datetime)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">Time</dt>
          <dd className="text-right font-medium text-slate-900">
            {formatTime(selection.datetime)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">Duration</dt>
          <dd className="text-right font-medium text-slate-900">
            {formatDuration(selection.rate.durationMinutes) || '—'}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">Price</dt>
          <dd className="text-right font-medium text-slate-900">
            {formatUSD(selection.rate.priceCents)} each
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700">Guests</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={dec}
            disabled={quantity <= min}
            aria-label="Decrease quantity"
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 text-slate-700 transition-colors',
              'hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <Minus className="h-4 w-4" aria-hidden />
          </button>
          <span
            className="w-6 text-center text-base font-semibold tabular-nums text-slate-900"
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
              'flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 text-slate-700 transition-colors',
              'hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      {quantity >= max && (
        <p className="mt-1 text-right text-xs text-slate-400">
          Maximum available for this time.
        </p>
      )}
    </div>
  );
}
