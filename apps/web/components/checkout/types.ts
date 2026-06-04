/**
 * Shared types for the checkout client components. Kept separate so the server
 * page and the client form/components agree on the resolved selection shape
 * without importing the (server-only) API client into client bundles.
 *
 * All money is integer cents.
 */
import type { ActivityCategory } from '@/lib/api';

/** The fully-resolved, validated booking selection passed to the client form. */
export interface CheckoutSelection {
  activityId: string;
  activityName: string;
  category: ActivityCategory;
  /** Activity accent color (white-label, from operator data). */
  color: string;
  /** Whether a waiver must be signed before this activity can be booked. */
  waiverRequired: boolean;
  minParticipants: number;
  maxParticipants: number;
  rate: {
    id: string;
    name: string;
    priceCents: number;
    durationMinutes: number;
  };
  timeslotId: string;
  /** ISO 8601 datetime (UTC) of the booked slot start. */
  datetime: string;
  /** The selected calendar day (YYYY-MM-DD). */
  date: string;
  /** Requested number of units, clamped to what's bookable. */
  quantity: number;
  /** Maximum bookable quantity for this slot (capacity + activity bounds). */
  maxQuantity: number;
}

/** Per-participant form values (mirrors @marina/core participantInfoSchema). */
export interface ParticipantFormValue {
  driver_name: string;
  license: string;
  dob: string;
  experience: '' | 'NONE' | 'BEGINNER' | 'INTERMEDIATE' | 'EXPERIENCED';
}

/** The full checkout form shape used by react-hook-form. */
export interface CheckoutFormValues {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  participants: ParticipantFormValue[];
  promoCode: string;
  waiverAccepted: boolean;
  /** Typed signature (full legal name) used as the waiver signature. */
  signatureName: string;
}

/** An applied, server-validated promo code. */
export interface AppliedPromo {
  code: string;
  discountType: 'PERCENT' | 'FLAT';
  /** Percent (10 = 10%) or flat cents, per discountType. */
  discountValue: number;
}
