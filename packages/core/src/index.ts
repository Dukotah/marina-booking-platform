// @marina/core — shared domain logic (pricing, availability, validation, ids).
// All exports are named; no default exports.

export { toCents, fromCents, formatUSD, roundCents } from './money.js';

export { createId, generateOrderNumber } from './ids.js';

export {
  calculatePricing,
  type PricingItem,
  type PricingFee,
  type PricingPromo,
  type PricingInput,
  type PricingResult,
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
