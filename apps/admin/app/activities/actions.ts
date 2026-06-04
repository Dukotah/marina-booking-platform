'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { activityInputSchema, rateInputSchema, createId } from '@marina/core';
import { Prisma } from '@marina/database';
import { z } from 'zod';
import { getTenantDb, requirePermission } from '../../lib/session';

/**
 * Server actions for the activities slice. Every mutation:
 *  - requires the `activity:write` permission (throws AuthorizationError otherwise),
 *  - runs through the tenant-scoped client (RLS enforces operator isolation), and
 *  - still writes an explicit `operator_id` where-clause as defense in depth.
 *
 * The wizard persists an Activity plus its child Rates together. Rates are
 * validated with @marina/core's rateInputSchema (minus activity_id, which we own
 * server-side) and reconciled (create / update / delete) against what exists.
 */

/** A rate as submitted by the wizard. `id` present => existing row to update. */
const wizardRateSchema = rateInputSchema
  .omit({ activity_id: true })
  .extend({ id: z.string().min(1).optional() });

/** The full wizard payload: activity fields + its rates. */
const wizardSchema = z.object({
  activity: activityInputSchema,
  rates: z.array(wizardRateSchema).default([]),
});

export type WizardInput = z.infer<typeof wizardSchema>;

export interface ActionResult {
  ok: boolean;
  /** Field-path -> message, suitable for surfacing inline in the form. */
  errors?: Record<string, string>;
  /** General error message when not field-specific. */
  message?: string;
  /** Created/updated activity id (on success). */
  activityId?: string;
}

/**
 * Coerce the validated config object into a Prisma JSON value. `null`/`undefined`
 * map to `Prisma.JsonNull` so an existing config can be cleared on update.
 */
function toJsonConfig(
  config: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (config == null) return Prisma.JsonNull;
  return config as Prisma.InputJsonValue;
}

/** Flatten a ZodError into a `path -> message` map the client can consume. */
function zodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

/**
 * Create a new Activity (+ its Rates) for the current operator.
 * Redirects to the edit page on success.
 */
export async function createActivity(input: WizardInput): Promise<ActionResult> {
  const { operatorId } = await requirePermission('activity:write');

  const parsed = wizardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodErrors(parsed.error) };
  }
  const { activity, rates } = parsed.data;

  const db = await getTenantDb();

  // If a location was supplied, ensure it belongs to this operator (RLS already
  // guarantees this, but we fail loudly rather than persisting a dangling ref).
  if (activity.location_id) {
    const loc = await db.location.findFirst({
      where: { id: activity.location_id, operator_id: operatorId },
      select: { id: true },
    });
    if (!loc) {
      return { ok: false, errors: { 'activity.location_id': 'Unknown location.' } };
    }
  }

  const activityId = createId();

  await db.activity.create({
    data: {
      id: activityId,
      operator_id: operatorId,
      location_id: activity.location_id ?? null,
      name_internal: activity.name_internal,
      name_external: activity.name_external,
      category: activity.category,
      status: activity.status,
      visible_online: activity.visible_online,
      visible_kiosk: activity.visible_kiosk,
      visible_register: activity.visible_register,
      min_participants: activity.min_participants,
      max_participants: activity.max_participants,
      description_html: activity.description_html ?? null,
      photo_urls: activity.photo_urls,
      color: activity.color,
      waiver_required: activity.waiver_required,
      self_reschedule_hours: activity.self_reschedule_hours,
      sort_index: activity.sort_index,
      config: toJsonConfig(activity.config),
      rates: {
        create: rates.map((r, i) => ({
          id: createId(),
          operator_id: operatorId,
          name_internal: r.name_internal,
          name_external: r.name_external,
          price_cents: r.price_cents,
          duration_minutes: r.duration_minutes,
          is_active: r.is_active,
          online_only: r.online_only,
          internal_only: r.internal_only,
          is_from_price: r.is_from_price,
          sort_index: r.sort_index || i,
        })),
      },
    },
  });

  revalidatePath('/activities');
  redirect(`/activities/${activityId}`);
}

/**
 * Update an existing Activity (+ reconcile its Rates) for the current operator.
 */
export async function updateActivity(
  activityId: string,
  input: WizardInput,
): Promise<ActionResult> {
  const { operatorId } = await requirePermission('activity:write');

  const parsed = wizardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodErrors(parsed.error) };
  }
  const { activity, rates } = parsed.data;

  const db = await getTenantDb();

  // Confirm the activity exists and belongs to this operator before mutating.
  const existing = await db.activity.findFirst({
    where: { id: activityId, operator_id: operatorId },
    select: { id: true, rates: { select: { id: true } } },
  });
  if (!existing) {
    return { ok: false, message: 'Activity not found.' };
  }

  if (activity.location_id) {
    const loc = await db.location.findFirst({
      where: { id: activity.location_id, operator_id: operatorId },
      select: { id: true },
    });
    if (!loc) {
      return { ok: false, errors: { 'activity.location_id': 'Unknown location.' } };
    }
  }

  const existingRateIds = new Set(existing.rates.map((r) => r.id));
  const submittedRateIds = new Set(
    rates.map((r) => r.id).filter((id): id is string => Boolean(id)),
  );
  const toDelete = [...existingRateIds].filter((id) => !submittedRateIds.has(id));

  await db.activity.update({
    where: { id: activityId },
    data: {
      location_id: activity.location_id ?? null,
      name_internal: activity.name_internal,
      name_external: activity.name_external,
      category: activity.category,
      status: activity.status,
      visible_online: activity.visible_online,
      visible_kiosk: activity.visible_kiosk,
      visible_register: activity.visible_register,
      min_participants: activity.min_participants,
      max_participants: activity.max_participants,
      description_html: activity.description_html ?? null,
      photo_urls: activity.photo_urls,
      color: activity.color,
      waiver_required: activity.waiver_required,
      self_reschedule_hours: activity.self_reschedule_hours,
      sort_index: activity.sort_index,
      config: toJsonConfig(activity.config),
      rates: {
        // Remove rates the user deleted in the wizard.
        deleteMany: toDelete.length ? { id: { in: toDelete } } : undefined,
        // Update rates that already existed (scoped by id within this activity).
        update: rates
          .filter((r) => r.id && existingRateIds.has(r.id))
          .map((r) => ({
            where: { id: r.id! },
            data: {
              name_internal: r.name_internal,
              name_external: r.name_external,
              price_cents: r.price_cents,
              duration_minutes: r.duration_minutes,
              is_active: r.is_active,
              online_only: r.online_only,
              internal_only: r.internal_only,
              is_from_price: r.is_from_price,
              sort_index: r.sort_index,
            },
          })),
        // Create brand-new rates.
        create: rates
          .filter((r) => !r.id)
          .map((r, i) => ({
            id: createId(),
            operator_id: operatorId,
            name_internal: r.name_internal,
            name_external: r.name_external,
            price_cents: r.price_cents,
            duration_minutes: r.duration_minutes,
            is_active: r.is_active,
            online_only: r.online_only,
            internal_only: r.internal_only,
            is_from_price: r.is_from_price,
            sort_index: r.sort_index || i,
          })),
      },
    },
  });

  revalidatePath('/activities');
  revalidatePath(`/activities/${activityId}`);
  return { ok: true, activityId };
}

/** Toggle an activity between ACTIVE and INACTIVE. */
export async function toggleActivityStatus(activityId: string): Promise<ActionResult> {
  const { operatorId } = await requirePermission('activity:write');
  const db = await getTenantDb();

  const existing = await db.activity.findFirst({
    where: { id: activityId, operator_id: operatorId },
    select: { status: true },
  });
  if (!existing) return { ok: false, message: 'Activity not found.' };

  await db.activity.update({
    where: { id: activityId },
    data: { status: existing.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' },
  });

  revalidatePath('/activities');
  revalidatePath(`/activities/${activityId}`);
  return { ok: true, activityId };
}

/** Toggle a single online/kiosk/register visibility flag. */
export async function toggleActivityVisibility(
  activityId: string,
  channel: 'online' | 'kiosk' | 'register',
): Promise<ActionResult> {
  const { operatorId } = await requirePermission('activity:write');
  const db = await getTenantDb();

  const field =
    channel === 'online'
      ? 'visible_online'
      : channel === 'kiosk'
        ? 'visible_kiosk'
        : 'visible_register';

  const existing = await db.activity.findFirst({
    where: { id: activityId, operator_id: operatorId },
    select: { visible_online: true, visible_kiosk: true, visible_register: true },
  });
  if (!existing) return { ok: false, message: 'Activity not found.' };

  await db.activity.update({
    where: { id: activityId },
    data: { [field]: !existing[field] },
  });

  revalidatePath('/activities');
  revalidatePath(`/activities/${activityId}`);
  return { ok: true, activityId };
}
