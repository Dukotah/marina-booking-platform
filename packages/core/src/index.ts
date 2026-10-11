// @marina/core — shared domain logic (pricing, availability, validation, ids).
// All exports are named; no default exports.

// Money primitives. Re-exported wholesale: every helper here is the shared,
// tested way to touch cents, and callers reaching past the barrel into
// './money.js' is how divergent rounding crept in before.
export * from './money.js';

// Accounting / GL mapping and the QuickBooks + Xero export builders.
export * from './accounting.js';

export { createId, generateOrderNumber } from './ids.js';

export {
  calculatePricing,
  resolveDepositPercent,
  computeDepositCents,
  applyMemberPrice,
  priceRateClasses,
  type RateClassSpec,
  type ParticipantCount,
  type RateClassLine,
  type RateClassPricing,
  resolveEffectivePrice,
  isRuleActive,
  type PricingItem,
  type PricingFee,
  type PricingPromo,
  type PricingInput,
  type PricingResult,
  type MemberDiscount,
  type PricingRuleSpec,
  type PricingRuleContext,
  type EffectivePriceResult,
} from './pricing.js';

// Dynamic pricing: seasonal / weekend / time-of-day / lead-time / demand rules, and
// the signed price quote that guarantees the number a guest is shown is the number
// they are charged.
export {
  PRICING_RULE_KINDS,
  PRICING_RULE_KIND_LABEL,
  DEFAULT_WEEKEND_DAYS,
  DEFAULT_PRICE_GUARDRAILS,
  PRICE_QUOTE_TTL_SECONDS,
  ruleInScope,
  ruleScopeTier,
  ruleMatches,
  isRuleCandidate,
  selectRules,
  guardrailBounds,
  resolveDynamicPrice,
  describeAdjustment,
  quoteFingerprint,
  reconcileQuote,
  type PricingRuleKind,
  type PricingAdjustmentType,
  type DynamicPricingRule,
  type PricingContext,
  type PriceGuardrails,
  type SuppressionReason,
  type SuppressedRule,
  type RuleSelection,
  type AppliedRule,
  type ClampReason,
  type DynamicPriceResult,
  type QuoteFingerprintInput,
  type QuoteStatus,
  type QuoteReconciliation,
} from './pricing-rules.js';


export {
  computeSlotStatus,
  generateTimeslots,
  type SlotStatus,
  type GenerateTimeslotsInput,
  type GeneratedTimeslot,
} from './availability.js';

// Rental-window math: "is this boat rentable at minute M on local day D?" — the
// one tested place the admin week grid derives shaded cells from rental rules.
export {
  isoWeekday,
  mergeRanges,
  rentableRangesForDay,
  isRentableAt,
  isHourRentable,
  // Booking-engine consumers: free gaps + bookable start times for a rental.
  freeRangesForDay,
  bookableStartMinutes,
  fitsInFreeRange,
  type RentalWindowRule,
  type MinuteRange,
} from './rental-window.js';

// Allowlist HTML sanitizer for operator-authored rich text (activity/package
// descriptions) that is rendered unsanitized to public/embedded surfaces.
export { sanitizeHtml, sanitizeDescriptionHtml } from './html-sanitize.js';

export {
  ACTIVITY_CATEGORIES,
  DISCOUNT_TYPES,
  participantInfoSchema,
  bookingInputSchema,
  customerInputSchema,
  activityInputSchema,
  rateInputSchema,
  promoValidateSchema,
  type ParticipantInfo,
  type BookingInput,
  type CustomerInput,
  type ActivityInput,
  type RateInput,
  type PromoValidateInput,
} from './schemas.js';

export {
  DATE_BASES,
  DATE_BASIS_LABEL,
  resolveDateBasis,
  computeDelta,
  previousPeriod,
  summarizePayments,
  PAYMENT_METHOD_KEYS,
  PAYMENT_METHOD_LABEL,
  rollUpByLocation,
  aggregateRefunds,
  REFUND_REASON_NONE,
  type DateBasis,
  type Delta,
  type PaymentMethodKey,
  type PaymentMethodTotal,
  type PaymentRow,
  type PaymentsSummary,
  type LocationMetricRow,
  type LocationRollUpRow,
  type LocationRollUp,
  type RefundRow,
  type RefundReasonTotal,
  type RefundActivityTotal,
  type RefundsReport,
} from './reports.js';

// Itemized sales + merchandise report math (line-level views that reconcile
// exactly with the order-level summaries).
export {
  allocateProportionally,
  allocateLines,
  buildItemizedSales,
  buildItemizedDetails,
  buildMerchandiseReport,
  reconcileItemized,
  chargeCategoryLabel,
  ITEM_GROUP_LABEL,
  type ItemizedInput,
  type ItemizedOrderRow,
  type ItemizedActivityLineRow,
  type ItemizedMerchLineRow,
  type ItemizedChargeRow,
  type ItemGroupKey,
  type AllocatedLine,
  type ItemRow,
  type ItemGroup,
  type ItemTotals,
  type ItemizedSales,
  type Reconciliation,
  type ReconciliationCheck,
  type MerchandiseReportData,
  type MerchandiseCategoryGroup,
  type MerchandiseProductRow,
  type MerchandiseVariantRow,
} from './itemized.js';

// Tiered cancellation policy model + pure refund calculator (tier-by-hours-until-start,
// flat fee per order/guest, clamp to amount paid).
export {
  computeCancellationRefund,
  type CancellationTier,
  type CancellationPolicy,
  type FeeScope,
  type RefundMethod,
  type ComputeCancellationRefundInput,
  type CancellationRefundResult,
} from './cancellation.js';

// Dependency-free QR encoder (byte mode, EC level M) + SVG renderer, used for
// the admin waiver sign-link QR the dock crew shows to guests.
export {
  encodeQr,
  qrToSvg,
  qrSvg,
  formatInfoBits,
  EC_BLOCKS_M,
  type QrMatrix,
  type QrSvgOptions,
} from './qr.js';

// NOTE: the HMAC-signed check-in token module (checkin-token.ts) is deliberately
// NOT re-exported here. It imports Node's `crypto`, and @marina/core is webpack-
// transpiled (not external) in the Next apps — pulling it into this barrel would
// drag `crypto` into every client bundle that imports any core symbol and 500 the
// apps. Node-only call sites import it from the dedicated subpath instead:
//   import { signCheckinToken } from '@marina/core/checkin-token';
