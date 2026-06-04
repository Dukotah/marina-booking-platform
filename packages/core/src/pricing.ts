/**
 * Pricing engine — this governs real money, so it is intentionally explicit and
 * deterministic. Everything is computed in INTEGER CENTS.
 *
 * Order of operations (must match the platform-wide contract):
 *   1. subtotal      = sum(unitPriceCents * quantity)
 *   2. discount      = applied to the subtotal (PERCENT or FLAT), never below 0
 *   3. FLAT fees     = added to the taxable base
 *   4. taxable       = subtotal - discount + sum(FLAT fees)
 *   5. tax           = round(taxable * taxPct)   (0 when taxExempt)
 *   6. processingFee = round((taxable + tax) * procPct)
 *   7. total         = taxable + tax + processingFee + tip
 *
 * Fee classification:
 *   - The PERCENT fee whose name includes "Tax" (case-insensitive) is the tax rate.
 *   - The PERCENT fee whose name includes "Processing" is the processing rate.
 *   - Any other PERCENT fee is treated as a surcharge on the taxable base
 *     (percentage of subtotal-after-discount), added to the taxable base.
 *   - FLAT fees are added directly to the taxable base.
 */
import { roundCents } from './money.js';

export interface PricingItem {
  /** Price per single unit, in integer cents. */
  unitPriceCents: number;
  /** How many units. */
  quantity: number;
}

export interface PricingFee {
  /** Display name. "Tax"/"Processing" substrings drive special handling. */
  name: string;
  /** PERCENT fees use `value` as a percentage (e.g. 8.5 => 8.5%). FLAT fees use `value` as integer cents. */
  type: 'PERCENT' | 'FLAT';
  /** For PERCENT: a percentage (8.5 = 8.5%). For FLAT: integer cents. */
  value: number;
}

export interface PricingPromo {
  discountType: 'PERCENT' | 'FLAT';
  /** For PERCENT: a percentage (10 = 10%). For FLAT: integer cents off. */
  discountValue: number;
}

export interface PricingInput {
  items: PricingItem[];
  fees: PricingFee[];
  promo?: PricingPromo | null;
  /** Tip in integer cents. Not discounted, not taxed, not subject to processing fees. */
  tipCents?: number;
  /** When true, no tax is applied regardless of a configured Tax fee. */
  taxExempt?: boolean;
}

export interface PricingResult {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  processingFeeCents: number;
  tipCents: number;
  totalCents: number;
}

const isTaxFee = (f: PricingFee): boolean =>
  f.type === 'PERCENT' && /tax/i.test(f.name);

const isProcessingFee = (f: PricingFee): boolean =>
  f.type === 'PERCENT' && /processing/i.test(f.name);

/**
 * Compute a complete, rounded price breakdown for a cart. Pure and deterministic.
 */
export const calculatePricing = (input: PricingInput): PricingResult => {
  const { items, fees, promo, taxExempt = false } = input;
  const tipCents = Math.max(0, roundCents(input.tipCents ?? 0));

  // 1. Subtotal — sum of line items (integer cents in, integer cents out).
  const subtotalCents = items.reduce(
    (sum, item) =>
      sum + roundCents(item.unitPriceCents) * Math.max(0, Math.trunc(item.quantity)),
    0,
  );

  // 2. Discount on subtotal, clamped to [0, subtotal].
  let discountCents = 0;
  if (promo) {
    if (promo.discountType === 'PERCENT') {
      discountCents = roundCents((subtotalCents * promo.discountValue) / 100);
    } else {
      discountCents = roundCents(promo.discountValue);
    }
  }
  discountCents = Math.min(Math.max(0, discountCents), subtotalCents);

  // Base that discounts, FLAT fees, and percentage surcharges apply to.
  const discountedBase = subtotalCents - discountCents;

  // 3 + 4. FLAT fees and non-tax/non-processing PERCENT surcharges feed the taxable base.
  let extraTaxableCents = 0;
  let taxPct = 0;
  let procPct = 0;

  for (const fee of fees) {
    if (isTaxFee(fee)) {
      // Last Tax fee wins if multiple are (mis)configured; first found is fine too.
      taxPct = fee.value;
      continue;
    }
    if (isProcessingFee(fee)) {
      procPct = fee.value;
      continue;
    }
    if (fee.type === 'FLAT') {
      extraTaxableCents += roundCents(fee.value);
    } else {
      // Generic percentage surcharge on the discounted base.
      extraTaxableCents += roundCents((discountedBase * fee.value) / 100);
    }
  }

  const taxableCents = discountedBase + extraTaxableCents;

  // 5. Tax.
  const taxCents = taxExempt ? 0 : roundCents((taxableCents * taxPct) / 100);

  // 6. Processing fee on (taxable + tax).
  const processingFeeCents = roundCents(((taxableCents + taxCents) * procPct) / 100);

  // 7. Total.
  const totalCents = taxableCents + taxCents + processingFeeCents + tipCents;

  return {
    subtotalCents,
    discountCents,
    taxCents,
    processingFeeCents,
    tipCents,
    totalCents,
  };
};
