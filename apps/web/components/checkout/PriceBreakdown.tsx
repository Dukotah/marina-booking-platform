'use client';

/**
 * Live price breakdown for checkout.
 *
 * Subtotal, discount, and tip are computed client-side from the selection,
 * applied promo, and chosen tip using @marina/core's `calculatePricing` so the
 * math matches the platform contract exactly (integer cents throughout).
 *
 * Taxes and processing fees are operator-configured and authoritatively applied
 * by the API at booking time. The API now supplies those fee specs to the
 * checkout (via the activity detail), so we feed them into the same
 * `calculatePricing` the booking uses and show the tax + processing lines and a
 * total that matches the confirmation to the cent — the number on the submit
 * button is the number the guest is committing to.
 *
 * If the API did not supply fees (older API), `fees` is empty: the tax/processing
 * lines simply don't render and the total is labelled an estimate, with the
 * "taxes/fees added at payment" note. The confirmation page always shows the
 * final, authoritative totals returned by the API.
 */
import { calculatePricing, formatUSD } from '@marina/core';
import type { ActivityFee } from '@/lib/api';
import type { AppliedPromo } from './types';

interface PriceBreakdownProps {
  unitPriceCents: number;
  quantity: number;
  promo: AppliedPromo | null;
  tipCents: number;
  /**
   * Operator fees (tax + processing + surcharges) the API will apply. When
   * supplied, the breakdown shows the real total; when empty, it falls back to a
   * pre-fee estimate with a disclaimer.
   */
  fees: ActivityFee[];
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
        (emphasis ? 'text-base font-semibold text-ink' : 'text-sm')
      }
    >
      <span className={muted ? 'text-muted' : 'text-ink'}>{label}</span>
      <span className={`tnum ${muted ? 'text-muted' : 'text-ink'}`}>{value}</span>
    </div>
  );
}

export function PriceBreakdown({
  unitPriceCents,
  quantity,
  promo,
  tipCents,
  fees,
}: PriceBreakdownProps) {
  const pricing = calculatePricing({
    items: [{ unitPriceCents, quantity }],
    fees,
    promo: promo
      ? { discountType: promo.discountType, discountValue: promo.discountValue }
      : null,
    tipCents,
  });

  // When the API supplied fees we can show the real total the confirmation will
  // show; only then are the tax/processing lines meaningful. Without them we fall
  // back to the pre-fee "estimated total" and keep the disclaimer.
  const hasFees = fees.length > 0;

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
      {pricing.taxCents > 0 && (
        <Row label="Tax" value={formatUSD(pricing.taxCents)} muted />
      )}
      {pricing.processingFeeCents > 0 && (
        <Row label="Processing fee" value={formatUSD(pricing.processingFeeCents)} muted />
      )}
      {pricing.tipCents > 0 && (
        <Row label="Tip" value={formatUSD(pricing.tipCents)} />
      )}

      <div className="my-2 border-t border-hairline" />

      <Row
        label={hasFees ? 'Total' : 'Estimated total'}
        value={formatUSD(pricing.totalCents)}
        emphasis
      />
      {!hasFees && (
        <p className="pt-1 text-xs text-muted">
          Applicable taxes and processing fees are calculated and added at payment.
        </p>
      )}
    </div>
  );
}
