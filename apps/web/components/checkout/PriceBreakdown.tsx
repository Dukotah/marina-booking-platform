'use client';

/**
 * Live price breakdown for checkout.
 *
 * Subtotal, discount, and tip are computed client-side from the selection,
 * applied promo, and chosen tip using @marina/core's `calculatePricing` so the
 * math matches the platform contract exactly (integer cents throughout).
 *
 * Taxes and processing fees are operator-configured and authoritatively applied
 * by the API at booking time; they are not exposed to the customer catalog, so
 * we label the customer-visible figure as an estimate and note that taxes/fees
 * are added at payment. The confirmation page shows the final, authoritative
 * totals returned by the API.
 */
import { calculatePricing, formatUSD } from '@marina/core';
import type { AppliedPromo } from './types';

interface PriceBreakdownProps {
  unitPriceCents: number;
  quantity: number;
  promo: AppliedPromo | null;
  tipCents: number;
}

function Row({
  label,
  value,
  emphasis,
  muted,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={
        'flex items-baseline justify-between ' +
        (emphasis ? 'text-base font-semibold text-slate-900' : 'text-sm')
      }
    >
      <span className={muted ? 'text-slate-500' : 'text-slate-600'}>{label}</span>
      <span className={muted ? 'text-slate-500' : 'text-slate-900'}>{value}</span>
    </div>
  );
}

export function PriceBreakdown({
  unitPriceCents,
  quantity,
  promo,
  tipCents,
}: PriceBreakdownProps) {
  const pricing = calculatePricing({
    items: [{ unitPriceCents, quantity }],
    fees: [],
    promo: promo
      ? { discountType: promo.discountType, discountValue: promo.discountValue }
      : null,
    tipCents,
  });

  return (
    <div className="space-y-2">
      <Row
        label={`${formatUSD(unitPriceCents)} × ${quantity}`}
        value={formatUSD(pricing.subtotalCents)}
      />
      {pricing.discountCents > 0 && (
        <Row
          label={promo ? `Promo (${promo.code})` : 'Discount'}
          value={`−${formatUSD(pricing.discountCents)}`}
        />
      )}
      {pricing.tipCents > 0 && (
        <Row label="Tip" value={formatUSD(pricing.tipCents)} />
      )}

      <div className="my-2 border-t border-slate-200" />

      <Row label="Estimated total" value={formatUSD(pricing.totalCents)} emphasis />
      <p className="pt-1 text-xs text-slate-400">
        Applicable taxes and processing fees are calculated and added at payment.
      </p>
    </div>
  );
}
