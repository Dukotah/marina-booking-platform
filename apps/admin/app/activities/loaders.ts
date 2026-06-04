import { fromCents } from '@marina/core';
import { getTenantDb } from '../../lib/session';
import {
  emptyActivityForm,
  type ActivityCategory,
  type ActivityFormValues,
  type LocationOption,
  type ScheduleFormValues,
} from '../../components/activities/types';

/**
 * Server-only loaders for the activity wizard pages. They run through the
 * tenant-scoped client so they only ever see the current operator's data.
 */

/** Active locations for this operator, for the wizard's location selector. */
export async function loadLocationOptions(): Promise<LocationOption[]> {
  const db = await getTenantDb();
  const locations = await db.location.findMany({
    where: { is_active: true },
    orderBy: [{ is_default: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true },
  });
  return locations;
}

/** Parse the schedule block out of an activity's config JSON, with safe defaults. */
function parseSchedule(config: unknown): ScheduleFormValues {
  const defaults = emptyActivityForm().schedule;
  if (config && typeof config === 'object' && 'schedule' in config) {
    const s = (config as { schedule?: Partial<ScheduleFormValues> }).schedule ?? {};
    return {
      open_hour: typeof s.open_hour === 'number' ? s.open_hour : defaults.open_hour,
      close_hour: typeof s.close_hour === 'number' ? s.close_hour : defaults.close_hour,
      interval_minutes:
        typeof s.interval_minutes === 'number' ? s.interval_minutes : defaults.interval_minutes,
      capacity_total:
        typeof s.capacity_total === 'number' ? s.capacity_total : defaults.capacity_total,
    };
  }
  return defaults;
}

/**
 * Load an existing activity (+ its rates) and shape it into the wizard's form
 * values. Returns null when the activity doesn't exist for this operator.
 */
export async function loadActivityForm(
  activityId: string,
): Promise<ActivityFormValues | null> {
  const db = await getTenantDb();
  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: {
      name_internal: true,
      name_external: true,
      category: true,
      status: true,
      location_id: true,
      visible_online: true,
      visible_kiosk: true,
      visible_register: true,
      min_participants: true,
      max_participants: true,
      description_html: true,
      color: true,
      waiver_required: true,
      self_reschedule_hours: true,
      photo_urls: true,
      config: true,
      rates: {
        orderBy: [{ sort_index: 'asc' }],
        select: {
          id: true,
          name_internal: true,
          name_external: true,
          price_cents: true,
          duration_minutes: true,
          is_active: true,
          online_only: true,
          internal_only: true,
          is_from_price: true,
        },
      },
    },
  });

  if (!activity) return null;

  return {
    name_internal: activity.name_internal,
    name_external: activity.name_external,
    category: activity.category as ActivityCategory,
    status: activity.status,
    location_id: activity.location_id ?? '',
    visible_online: activity.visible_online,
    visible_kiosk: activity.visible_kiosk,
    visible_register: activity.visible_register,
    min_participants: activity.min_participants,
    max_participants: activity.max_participants,
    description_html: activity.description_html ?? '',
    color: activity.color,
    waiver_required: activity.waiver_required,
    self_reschedule_hours: activity.self_reschedule_hours,
    photo_urls: activity.photo_urls,
    schedule: parseSchedule(activity.config),
    rates: activity.rates.map((r) => ({
      id: r.id,
      name_internal: r.name_internal,
      name_external: r.name_external,
      price_dollars: fromCents(r.price_cents),
      duration_minutes: r.duration_minutes,
      is_active: r.is_active,
      online_only: r.online_only,
      internal_only: r.internal_only,
      is_from_price: r.is_from_price,
    })),
  };
}
