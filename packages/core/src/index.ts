// @marina/core — shared domain logic (pricing, availability, validation, ids).
// All exports are named; no default exports.

export { toCents, fromCents, formatUSD, roundCents } from './money.js';

export { createId, generateOrderNumber } from './ids.js';

export {
  calculatePricing,
  resolveDepositPercent,
  computeDepositCents,
  applyMemberPrice,
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

export {
  computeSlotStatus,
  generateTimeslots,
  type SlotStatus,
  type GenerateTimeslotsInput,
  type GeneratedTimeslot,
} from './availability.js';

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
  type DateBasis,
  type Delta,
  type PaymentMethodKey,
  type PaymentMethodTotal,
  type PaymentRow,
  type PaymentsSummary,
  type LocationMetricRow,
  type LocationRollUpRow,
  type LocationRollUp,
} from './reports.js';
