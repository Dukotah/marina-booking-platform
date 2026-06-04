import { ACTIVITY_CATEGORIES } from '@marina/core';

/**
 * Client-side form shape for the activity wizard. It mirrors the server
 * `WizardInput` (activity fields + rates) but uses plain form-friendly types
 * (e.g. price entered in dollars, converted to cents on submit).
 */

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export interface RateFormValues {
  /** Present when editing an existing rate; absent for newly added rows. */
  id?: string;
  name_internal: string;
  name_external: string;
  /** Price in DOLLARS in the form; converted to integer cents on submit. */
  price_dollars: number;
  duration_minutes: number;
  is_active: boolean;
  online_only: boolean;
  internal_only: boolean;
  is_from_price: boolean;
}

export interface ActivityFormValues {
  name_internal: string;
  name_external: string;
  category: ActivityCategory;
  status: 'ACTIVE' | 'INACTIVE';
  location_id: string;
  visible_online: boolean;
  visible_kiosk: boolean;
  visible_register: boolean;
  min_participants: number;
  max_participants: number;
  description_html: string;
  color: string;
  waiver_required: boolean;
  self_reschedule_hours: number;
  /** Existing photo URLs, carried through unchanged (photo upload is out of scope). */
  photo_urls: string[];
  /** Scheduling config (persisted in Activity.config.schedule). */
  schedule: ScheduleFormValues;
  rates: RateFormValues[];
}

/**
 * Scheduling settings. These live in Activity.config (JSON) so the core booking
 * engine stays category-agnostic. They drive timeslot generation via
 * @marina/core's generateTimeslots.
 */
export interface ScheduleFormValues {
  open_hour: number;
  close_hour: number;
  interval_minutes: number;
  capacity_total: number;
}

export interface LocationOption {
  id: string;
  name: string;
}

export const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  BOAT: 'Boat',
  WATERCRAFT: 'Watercraft',
  PATIO: 'Patio',
  LODGING: 'Lodging',
  TOUR: 'Tour',
  CLASS: 'Class',
  EVENT: 'Event',
  EQUIPMENT: 'Equipment',
  OTHER: 'Other',
};

/** Sensible defaults for a fresh activity. */
export function emptyActivityForm(): ActivityFormValues {
  return {
    name_internal: '',
    name_external: '',
    category: 'OTHER',
    status: 'ACTIVE',
    location_id: '',
    visible_online: true,
    visible_kiosk: true,
    visible_register: true,
    min_participants: 1,
    max_participants: 10,
    description_html: '',
    color: '#0ea5e9',
    waiver_required: true,
    self_reschedule_hours: 48,
    photo_urls: [],
    schedule: {
      open_hour: 9,
      close_hour: 17,
      interval_minutes: 240,
      capacity_total: 1,
    },
    rates: [],
  };
}

/** A blank rate row, defaulted to a 4-hour active rate. */
export function emptyRate(): RateFormValues {
  return {
    name_internal: '',
    name_external: '',
    price_dollars: 0,
    duration_minutes: 240,
    is_active: true,
    online_only: false,
    internal_only: false,
    is_from_price: false,
  };
}
