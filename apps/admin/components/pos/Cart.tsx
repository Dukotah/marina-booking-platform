'use client';

import { Trash2, Plus, Minus, ShoppingCart } from 'lucide-react';
import { formatUSD, type PricingResult } from '@marina/core';
import { cn } from '../../lib/cn';
import { Badge, type BadgeTone } from '../ui';
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

// Keep cart line tags quiet and meaningful: bookings use the teal accent (the
// primary thing sold here), everything else stays neutral.
const KIND_TONE: Record<CartLine['kind'], BadgeTone> = {
  BOOKING: 'accent',
  MERCHANDISE: 'neutral',
  MISC: 'neutral',
};

export function Cart({ lines, pricing, onChangeQuantity, onRemove, onClear }: CartProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2 font-semibold text-ink">
          <ShoppingCart className="h-4 w-4 text-ink-muted" aria-hidden />
          Cart
          {lines.length > 0 ? (
            <Badge tone="neutral">{lines.reduce((n, l) => n + l.quantity, 0)}</Badge>
          ) : null}
        </div>
        {lines.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="min-h-11 text-sm font-medium text-ink-muted hover:text-rose-600"
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-2 p-6 text-center text-sm text-ink-muted">
            <ShoppingCart className="h-8 w-8 text-ink-muted/60" aria-hidden />
            Cart is empty. Add a booking, merchandise, or a misc charge.
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {lines.map((line) => (
              <li key={line.key} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone={KIND_TONE[line.kind]}>{KIND_LABEL[line.kind]}</Badge>
                      <span className="truncate text-sm font-medium text-ink">
                        {line.label}
                      </span>
                    </div>
                    {line.sublabel ? (
                      <div className="mt-0.5 truncate text-xs text-ink-body">{line.sublabel}</div>
                    ) : null}
                    <div className="mt-0.5 text-xs text-ink-muted tabular-nums">
                      {formatUSD(line.unitPriceCents)} each
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${line.label}`}
                    onClick={() => onRemove(line.key)}
                    className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-muted hover:text-rose-600"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>

                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center rounded-lg border border-line">
                    <button
                      type="button"
                      aria-label="Decrease quantity"
                      onClick={() => onChangeQuantity(line.key, line.quantity - 1)}
                      className="flex h-9 w-9 items-center justify-center text-ink-body hover:bg-surface-muted"
                    >
                      <Minus className="h-4 w-4" aria-hidden />
                    </button>
                    <span className="w-9 text-center text-sm font-semibold text-ink tabular-nums">
                      {line.quantity}
                    </span>
                    <button
                      type="button"
                      aria-label="Increase quantity"
                      onClick={() => onChangeQuantity(line.key, line.quantity + 1)}
                      className="flex h-9 w-9 items-center justify-center text-ink-body hover:bg-surface-muted"
                    >
                      <Plus className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                  <span className="text-sm font-semibold text-ink tabular-nums">
                    {formatUSD(line.unitPriceCents * line.quantity)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pricing breakdown */}
      <div className="border-t border-line px-4 py-3 text-sm">
        <Row label="Subtotal" value={pricing.subtotalCents} />
        {pricing.discountCents > 0 ? (
          <Row label="Discount" value={-pricing.discountCents} muted />
        ) : null}
        {pricing.taxCents > 0 ? <Row label="Tax" value={pricing.taxCents} muted /> : null}
        {pricing.processingFeeCents > 0 ? (
          <Row label="Processing" value={pricing.processingFeeCents} muted />
        ) : null}
        {pricing.tipCents > 0 ? <Row label="Tip" value={pricing.tipCents} muted /> : null}
        <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-base font-bold text-ink">
          <span>Total</span>
          <span className="tabular-nums">{formatUSD(pricing.totalCents)}</span>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between py-0.5', muted ? 'text-ink-body' : 'text-ink')}>
      <span>{label}</span>
      <span className="tabular-nums">{formatUSD(value)}</span>
    </div>
  );
}
