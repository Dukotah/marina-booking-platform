'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createId, generateTimeslots } from '@marina/core';
import { AuthorizationError } from '@marina/auth';
import { withTenant } from '@marina/database';
import { requirePermission } from '../../lib/session';

/**
 * Onboarding wizard server action. A new operator runs a short guided setup:
 *   1) Brand   — public name + brand color (white-label essentials)
 *   2) Location — their first physical site (made default)
 *   3) Activities — one or more bookable offerings to start with
 *
 * Everything is provisioned in a single tenant-scoped transaction (withTenant) so
 * a partial setup never leaves orphaned records. Gated on operator:manage; RLS
 * scopes every write to the current operator, and we still set operator_id
 * explicitly as defense in depth.
 */

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const ACTIVITY_CATEGORIES = [
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

const onboardingSchema = z.object({
  brand: z.object({
    name_external: z.string().trim().min(1, 'Public name is required').max(160),
    name_internal: z.string().trim().max(160).optional().or(z.literal('')),
    brand_color: z.string().regex(HEX_COLOR, 'Brand color must be a hex value'),
    website: z.string().trim().url('Enter a valid URL').max(2048).optional().or(z.literal('')),
    phone: z.string().trim().max(32).optional().or(z.literal('')),
  }),
  location: z.object({
    name: z.string().trim().min(1, 'Location name is required').max(160),
    address: z.string().trim().max(200).optional().or(z.literal('')),
    city: z.string().trim().max(120).optional().or(z.literal('')),
    state: z.string().trim().max(64).optional().or(z.literal('')),
    zip: z.string().trim().max(16).optional().or(z.literal('')),
  }),
  activities: z
    .array(
      z.object({
        name_external: z.string().trim().min(1, 'Activity name is required').max(160),
        category: z.enum(ACTIVITY_CATEGORIES).default('OTHER'),
        /** Asking price in whole US dollars (wizard collects dollars; stored as cents). */
        price_dollars: z.number().int().min(1, 'Price must be at least $1').max(100_000),
        /** Duration in minutes for the default "Standard" rate. */
        duration_minutes: z.number().int().min(15).max(1440).default(60),
      }),
    )
    .min(1, 'Add at least one activity'),
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;

export interface OnboardingResult {
  ok: boolean;
  errors?: Record<string, string>;
  message?: string;
}

function zodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

function emptyToNull(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Timezone helpers — replicated from apps/api/src/services/availability.ts so
// we can convert local wall-clock → UTC inside a Prisma.TransactionClient
// (withTenant gives TransactionClient, not TenantClient, so the service import
// would be a wrong-package reference and its async queries would be outside our
// transaction scope). No external deps; uses Intl, which is always available.
// ---------------------------------------------------------------------------

function tzOffsetMinutes(timeZone: string, atUtc: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(atUtc);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - atUtc.getTime()) / 60000);
}

function zonedWallTimeToUtc(timeZone: string, local: Date): Date {
  const naiveUtc = Date.UTC(
    local.getFullYear(),
    local.getMonth(),
    local.getDate(),
    local.getHours(),
    local.getMinutes(),
    local.getSeconds(),
    local.getMilliseconds(),
  );
  const firstOffset = tzOffsetMinutes(timeZone, new Date(naiveUtc));
  const firstGuess = naiveUtc - firstOffset * 60000;
  const secondOffset = tzOffsetMinutes(timeZone, new Date(firstGuess));
  return new Date(naiveUtc - secondOffset * 60000);
}

/**
 * Default schedule for a brand-new activity: 9 AM–5 PM, 60-minute intervals,
 * for the next SLOT_DAYS_AHEAD calendar days starting tomorrow (today in UTC).
 * Capacity defaults to the activity's max_participants, or DEFAULT_CAPACITY if
 * that is not available.
 */
const SLOT_DAYS_AHEAD = 21;
const SLOT_OPEN_HOUR = 9;
const SLOT_CLOSE_HOUR = 17;
const SLOT_INTERVAL_MINUTES = 60;
const DEFAULT_CAPACITY = 10;

function buildInitialTimeslots(params: {
  operatorId: string;
  activityId: string;
  capacity: number;
  timezone: string;
}): Array<{
  operator_id: string;
  activity_id: string;
  datetime: Date;
  capacity_total: number;
  is_overnight: boolean;
}> {
  const { operatorId, activityId, capacity, timezone } = params;
  const rows: Array<{
    operator_id: string;
    activity_id: string;
    datetime: Date;
    capacity_total: number;
    is_overnight: boolean;
  }> = [];

  // Start from tomorrow (UTC date + 1 day) to avoid generating slots in the past.
  const today = new Date();
  for (let dayOffset = 1; dayOffset <= SLOT_DAYS_AHEAD; dayOffset++) {
    const localDate = new Date(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() + dayOffset,
      0,
      0,
      0,
      0,
    );
    const generated = generateTimeslots({
      openHour: SLOT_OPEN_HOUR,
      closeHour: SLOT_CLOSE_HOUR,
      intervalMinutes: SLOT_INTERVAL_MINUTES,
      date: localDate,
      capacityTotal: capacity,
    });
    for (const slot of generated) {
      rows.push({
        operator_id: operatorId,
        activity_id: activityId,
        datetime: zonedWallTimeToUtc(timezone, slot.datetime),
        capacity_total: slot.capacityTotal,
        is_overnight: false,
      });
    }
  }
  return rows;
}

/**
 * Provision brand + first location + initial activities for the current operator.
 * Returns a result the wizard surfaces inline; the wizard navigates on success.
 */
export async function completeOnboarding(input: OnboardingInput): Promise<OnboardingResult> {
  let operatorId: string;
  try {
    ({ operatorId } = await requirePermission('operator:manage'));
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, message: 'You do not have permission to set up this account.' };
    }
    throw err;
  }

  const parsed = onboardingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodErrors(parsed.error) };
  }
  const { brand, location, activities } = parsed.data;

  await withTenant(operatorId, async (tx) => {
    // 1) Brand — update the white-label essentials on the operator row.
    //    Also read back the operator timezone so we can anchor timeslot datetimes
    //    correctly without a second round-trip (the update returns the updated row).
    const updatedOperator = await tx.operator.update({
      where: { id: operatorId },
      data: {
        name_external: brand.name_external,
        name_internal: emptyToNull(brand.name_internal) ?? brand.name_external,
        brand_color: brand.brand_color,
        website: emptyToNull(brand.website),
        phone: emptyToNull(brand.phone),
      },
      select: { timezone: true },
    });
    const timezone = updatedOperator.timezone;

    // 2) Location — create the first site as the default. Demote any others so
    // exactly one default exists.
    const locationId = createId();
    await tx.location.create({
      data: {
        id: locationId,
        operator_id: operatorId,
        name: location.name,
        address: emptyToNull(location.address),
        city: emptyToNull(location.city),
        state: emptyToNull(location.state),
        zip: emptyToNull(location.zip),
        is_default: true,
        is_active: true,
      },
    });
    await tx.location.updateMany({
      where: { operator_id: operatorId, id: { not: locationId } },
      data: { is_default: false },
    });

    // 3) Activities — create the starter set with visibility flags set, then for
    //    each activity create a default Rate and an initial timeslot schedule so the
    //    storefront is genuinely bookable as soon as onboarding completes.
    for (let i = 0; i < activities.length; i++) {
      const a = activities[i];
      const activityId = createId();
      const capacity = DEFAULT_CAPACITY;

      // 3a) Activity — visible_online + visible_register so it appears on the storefront.
      await tx.activity.create({
        data: {
          id: activityId,
          operator_id: operatorId,
          location_id: locationId,
          name_internal: a.name_external,
          name_external: a.name_external,
          category: a.category,
          color: brand.brand_color,
          sort_index: i,
          max_participants: capacity,
          visible_online: true,
          visible_register: true,
        },
      });

      // 3b) Default rate — one "Standard" rate using the tenant-composite FK pattern.
      //     operator_id + activity_id are both required; price in integer cents.
      await tx.rate.create({
        data: {
          operator_id: operatorId,
          activity_id: activityId,
          name_internal: 'Standard',
          name_external: 'Standard',
          price_cents: a.price_dollars * 100,
          duration_minutes: a.duration_minutes,
          is_active: true,
          is_from_price: true,
          sort_index: 0,
        },
      });

      // 3c) Initial timeslots — SLOT_DAYS_AHEAD days, SLOT_OPEN_HOUR–SLOT_CLOSE_HOUR
      //     local time, SLOT_INTERVAL_MINUTES apart, capacity = DEFAULT_CAPACITY.
      //     Datetimes are stored as UTC instants; conversion uses the operator timezone.
      const slotRows = buildInitialTimeslots({
        operatorId,
        activityId,
        capacity,
        timezone,
      });
      if (slotRows.length > 0) {
        await tx.timeslot.createMany({ data: slotRows });
      }
    }
  });

  revalidatePath('/settings');
  revalidatePath('/activities');
  revalidatePath('/');
  return { ok: true };
}
