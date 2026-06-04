'use client';

import { Trash2, Plus, Minus, ShoppingCart } from 'lucide-react';
import { formatUSD, type PricingResult } from '@marina/core';
import { cn } from '../../lib/cn';
import type { CartLine } from './types';

/**
 * The register cart. Lists the working sale's lines with per-line quantity controls
 * and removal, then renders the authoritative-shape pricing breakdown (subtotal, tax,
 * processing, tip, total) computed by the parent via @marina/core. Booking lines show
 * their timeslot; merchandise/misc lines show their category.
 */
export interface CartProps {
  lines: CartLine[];
  pricing: PricingResult;
  onChangeQuantity: (key: string, quantity: number) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
}

const KIND_LABEL: Record<CartLine['kind'], string> = {
  BOOKING: 'Booking',
  MERCHANDISE: 'Merch',
  MISC: 'Misc',
};

export function Cart({ lines, pricing, onChangeQuantity, onRemove, onClear }: CartProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2 font-semibold text-slate-900">
          <ShoppingCart className="h-4 w-4 text-slate-500" aria-hidden />
          Cart
          {lines.length > 0 ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
              {lines.reduce((n, l) => n + l.quantity, 0)}
            </span>
          ) : null}
        </div>
        {lines.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="text-xs font-medium text-slate-400 hover:text-red-600"
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-400">
            <ShoppingCart className="h-8 w-8 text-slate-300" aria-hidden />
            Cart is empty. Add a booking, merchandise, or a misc charge.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {lines.map((line) => (
              <li key={line.key} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                          line.kind === 'BOOKING'
                            ? 'bg-sky-100 text-sky-700'
                            : line.kind === 'MERCHANDISE'
                              ? 'bg-violet-100 text-violet-700'
                              : 'bg-amber-100 text-amber-700',
                        )}
                      >
                        {KIND_LABEL[line.kind]}
                      </span>
                      <span className="truncate text-sm font-medium text-slate-800">
                        {line.label}
                      </span>
                    </div>
                    {line.sublabel ? (
                      <div className="mt-0.5 truncate text-xs text-slate-500">{line.sublabel}</div>
                    ) : null}
                    <div className="mt-0.5 text-xs text-slate-400">
                      {formatUSD(line.unitPriceCents)} each
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${line.label}`}
                    onClick={() => onRemove(line.key)}
                    className="shrink-0 text-slate-300 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>

                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center rounded-lg border border-slate-200">
                    <button
                      type="button"
                      aria-label="Decrease quantity"
                      onClick={() => onChangeQuantity(line.key, line.quantity - 1)}
                      className="flex h-7 w-7 items-center justify-center text-slate-600 hover:bg-slate-100"
                    >
                      <Minus className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <span className="w-8 text-center text-sm font-semibold text-slate-900">
                      {line.quantity}
                    </span>
                    <button
                      type="button"
                      aria-label="Increase quantity"
                      onClick={() => onChangeQuantity(line.key, line.quantity + 1)}
                      className="flex h-7 w-7 items-center justify-center text-slate-600 hover:bg-slate-100"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                  <span className="text-sm font-semibold text-slate-900">
                    {formatUSD(line.unitPriceCents * line.quantity)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pricing breakdown */}
      <div className="border-t border-slate-100 px-4 py-3 text-sm">
        <Row label="Subtotal" value={pricing.subtotalCents} />
        {pricing.discountCents > 0 ? (
          <Row label="Discount" value={-pricing.discountCents} muted />
        ) : null}
        {pricing.taxCents > 0 ? <Row label="Tax" value={pricing.taxCents} muted /> : null}
        {pricing.processingFeeCents > 0 ? (
          <Row label="Processing" value={pricing.processingFeeCents} muted />
        ) : null}
        {pricing.tipCents > 0 ? <Row label="Tip" value={pricing.tipCents} muted /> : null}
        <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
          <span>Total</span>
          <span>{formatUSD(pricing.totalCents)}</span>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between py-0.5', muted && 'text-slate-500')}>
      <span>{label}</span>
      <span>{formatUSD(value)}</span>
    </div>
  );
}
