/**
 * Shared types for the resources UI slice. The serialised shape mirrors the
 * API's `serialize()` output (camelCase, with the derived `availableQty` and
 * optional `activities` / `activityCount` fields).
 */

export type AllocationMode = 'SHARED_SEATS' | 'WHOLE_UNIT';

/** A resource as returned by GET /api/resources (list). */
export interface ResourceListItem {
  id: string;
  name: string;
  seatCapacity: number;
  quantity: number;
  outOfServiceQty: number;
  /** Derived: quantity - outOfServiceQty (never < 0). */
  availableQty: number;
  allocationMode: AllocationMode;
  enableTimer: boolean;
  isActive: boolean;
  locationId: string | null;
  /** Returned by the list endpoint via _count. */
  activityCount: number;
}

/** A resource as returned by GET /api/resources/:id (detail, includes activities). */
export interface ResourceDetail extends Omit<ResourceListItem, 'activityCount'> {
  activities: Array<{ id: string; name: string }>;
}

/** Form values used by ResourceForm (both create and edit). */
export interface ResourceFormValues {
  name: string;
  seatCapacity: number;
  quantity: number;
  outOfServiceQty: number;
  allocationMode: AllocationMode;
  enableTimer: boolean;
  locationId: string;
  activityIds: string[];
}

/** Minimal option shape for selects. */
export interface SelectOption {
  id: string;
  name: string;
}

export function emptyResourceForm(): ResourceFormValues {
  return {
    name: '',
    seatCapacity: 1,
    quantity: 1,
    outOfServiceQty: 0,
    allocationMode: 'SHARED_SEATS',
    enableTimer: false,
    locationId: '',
    activityIds: [],
  };
}

export const ALLOCATION_MODE_LABELS: Record<AllocationMode, string> = {
  SHARED_SEATS: 'Shared seats',
  WHOLE_UNIT: 'Whole unit',
};

export const ALLOCATION_MODE_DESCRIPTIONS: Record<AllocationMode, string> = {
  SHARED_SEATS:
    'Seats are shared across bookings — multiple guests can fill one unit simultaneously (e.g. a 10-seat pontoon with individual tickets).',
  WHOLE_UNIT:
    'One booking claims the entire unit — nobody else can use it at the same time (e.g. a private charter or single kayak).',
};
