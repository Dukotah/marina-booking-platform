/**
 * Zod validation schemas + inferred types for the booking domain. These are the
 * authoritative input shapes shared by the API and the web/admin apps. Keep them in
 * sync with the Prisma schema where they mirror DB rows.
 */
import { z } from 'zod';

/** Activity categories — mirrors the Prisma `ActivityCategory` enum. */
export const ACTIVITY_CATEGORIES = [
  'BOAT',
  'WATERCRAFT',
  'PATIO',
  'LODGING',
  'TOUR',
  'CLASS',
  'EVENT',
  'EQUIPMENT',
  'OTHER',
] as const;

/** Discount types — mirrors the Prisma `DiscountType` enum. */
export const DISCOUNT_TYPES = ['PERCENT', 'FLAT'] as const;

// --- Participant ----------------------------------------------------------

/**
 * Per-participant info captured at booking time (e.g. each driver on a boat
 * rental). Driver name is required; the rest are optional but validated when
 * present.
 */
export const participantInfoSchema = z.object({
  driver_name: z.string().trim().min(1, 'Driver name is required').max(120),
  license: z.string().trim().max(64).optional(),
  /** ISO date string (YYYY-MM-DD) for date of birth. */
  dob: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD')
    .optional(),
  experience: z.enum(['NONE', 'BEGINNER', 'INTERMEDIATE', 'EXPERIENCED']).optional(),
});
export type ParticipantInfo = z.infer<typeof participantInfoSchema>;

// --- Customer -------------------------------------------------------------

/** Customer details supplied during checkout. */
export const customerInputSchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required').max(80),
  last_name: z.string().trim().min(1, 'Last name is required').max(80),
  email: z.string().trim().toLowerCase().email('A valid email is required').max(254),
  phone: z.string().trim().max(32).optional(),
  address: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(64).optional(),
  zip: z.string().trim().max(16).optional(),
});
export type CustomerInput = z.infer<typeof customerInputSchema>;

// --- Booking --------------------------------------------------------------

/** A single booking request from a customer or staff member. */
export const bookingInputSchema = z.object({
  activityId: z.string().min(1, 'activityId is required'),
  rateId: z.string().min(1, 'rateId is required'),
  timeslotId: z.string().min(1, 'timeslotId is required'),
  quantity: z.number().int().positive('quantity must be at least 1'),
  customer: customerInputSchema,
  participants: z.array(participantInfoSchema).default([]),
  promoCode: z.string().trim().min(1).max(64).optional(),
  /** Optional gratuity in integer cents. */
  tipCents: z.number().int().nonnegative().optional(),
});
export type BookingInput = z.infer<typeof bookingInputSchema>;

// --- Activity -------------------------------------------------------------

/** Create/update payload for an Activity. */
export const activityInputSchema = z.object({
  name_internal: z.string().trim().min(1, 'Internal name is required').max(160),
  name_external: z.string().trim().min(1, 'External name is required').max(160),
  category: z.enum(ACTIVITY_CATEGORIES).default('OTHER'),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  location_id: z.string().min(1).optional(),
  visible_online: z.boolean().default(true),
  visible_kiosk: z.boolean().default(true),
  visible_register: z.boolean().default(true),
  min_participants: z.number().int().positive().default(1),
  max_participants: z.number().int().positive().default(10),
  description_html: z.string().max(20000).optional(),
  photo_urls: z.array(z.string().url()).default([]),
  color: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'color must be a hex value')
    .default('#0ea5e9'),
  waiver_required: z.boolean().default(true),
  self_reschedule_hours: z.number().int().nonnegative().default(48),
  sort_index: z.number().int().nonnegative().default(0),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type ActivityInput = z.infer<typeof activityInputSchema>;

// --- Rate -----------------------------------------------------------------

/** Create/update payload for a Rate. Prices are integer cents. */
export const rateInputSchema = z.object({
  activity_id: z.string().min(1, 'activity_id is required'),
  name_internal: z.string().trim().min(1, 'Internal name is required').max(160),
  name_external: z.string().trim().min(1, 'External name is required').max(160),
  price_cents: z.number().int().nonnegative('price_cents must be >= 0'),
  duration_minutes: z.number().int().positive().default(240),
  is_active: z.boolean().default(true),
  online_only: z.boolean().default(false),
  internal_only: z.boolean().default(false),
  is_from_price: z.boolean().default(false),
  sort_index: z.number().int().nonnegative().default(0),
});
export type RateInput = z.infer<typeof rateInputSchema>;

// --- Promo validation -----------------------------------------------------

/** Request to validate/apply a promo code against a cart. */
export const promoValidateSchema = z.object({
  code: z.string().trim().min(1, 'A promo code is required').max(64),
  /** Activity the cart is for, so activity-scoped promos can be checked. */
  activityId: z.string().min(1).optional(),
  /** Cart subtotal in integer cents, used for minimum-spend / preview math. */
  subtotalCents: z.number().int().nonnegative().optional(),
});
export type PromoValidateInput = z.infer<typeof promoValidateSchema>;
