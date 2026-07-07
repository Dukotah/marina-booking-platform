'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createId } from '@marina/core';
import { AuthorizationError } from '@marina/auth';
import { getTenantDb, requirePermission } from '../../../lib/session';

/**
 * Server actions for shared-resource pools (D-014). A Resource is a fleet of
 * interchangeable units (jet skis, pontoons, guides) that one or more activities
 * draw from; the booking engine enforces its capacity ACROSS those activities.
 * Every mutation requires `operator:manage`, runs through the tenant client (RLS),
 * and writes an explicit operator_id where-clause as defense in depth.
 */

export interface ActionResult {
  ok: boolean;
  errors?: Record<string, string>;
  message?: string;
  id?: string;
}

function zodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

function denied(): ActionResult {
  return { ok: false, message: 'You do not have permission to manage resources.' };
}

const resourceSchema = z
  .object({
    name: z.string().trim().min(1, 'Resource name is required').max(120),
    quantity: z.coerce.number().int('Whole number').min(1, 'At least 1 unit').max(9999),
    seat_capacity: z.coerce.number().int('Whole number').min(1, 'At least 1 seat').max(9999),
    out_of_service_qty: z.coerce.number().int('Whole number').min(0).max(9999).default(0),
    is_active: z.coerce.boolean().default(true),
    /** Activities that draw from this pool. */
    activity_ids: z.array(z.string().trim()).default([]),
  })
  .refine((v) => v.out_of_service_qty <= v.quantity, {
    path: ['out_of_service_qty'],
    message: 'Out-of-service cannot exceed total units',
  });

export type ResourceInput = z.infer<typeof resourceSchema>;

/** Keep only activity ids that actually belong to this operator (RLS + fail-safe). */
async function ownedActivityIds(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  ids: string[],
): Promise<string[]> {
  const clean = [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
  if (clean.length === 0) return [];
  const found = await db.activity.findMany({
    where: { id: { in: clean } },
    select: { id: true },
  });
  return found.map((a) => a.id);
}

export async function createResource(input: ResourceInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = resourceSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    const links = await ownedActivityIds(db, v.activity_ids);

    const id = createId();
    await db.resource.create({
      data: {
        id,
        operator_id: operatorId,
        name: v.name,
        quantity: v.quantity,
        seat_capacity: v.seat_capacity,
        out_of_service_qty: v.out_of_service_qty,
        is_active: v.is_active,
        activities: { connect: links.map((aid) => ({ id: aid })) },
      },
    });

    revalidatePath('/settings/resources');
    revalidatePath('/settings');
    return { ok: true, id };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function updateResource(resourceId: string, input: ResourceInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!resourceId) return { ok: false, message: 'Missing resource.' };
    const parsed = resourceSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    const existing = await db.resource.findFirst({
      where: { id: resourceId, operator_id: operatorId },
      select: { id: true },
    });
    if (!existing) return { ok: false, message: 'Resource not found.' };

    const links = await ownedActivityIds(db, v.activity_ids);
    await db.resource.update({
      where: { id: resourceId },
      data: {
        name: v.name,
        quantity: v.quantity,
        seat_capacity: v.seat_capacity,
        out_of_service_qty: v.out_of_service_qty,
        is_active: v.is_active,
        activities: { set: links.map((aid) => ({ id: aid })) },
      },
    });

    revalidatePath('/settings/resources');
    return { ok: true, id: resourceId };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function deleteResource(resourceId: string): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!resourceId) return { ok: false, message: 'Missing resource.' };

    const db = await getTenantDb();
    const existing = await db.resource.findFirst({
      where: { id: resourceId, operator_id: operatorId },
      select: { id: true },
    });
    if (!existing) return { ok: false, message: 'Resource not found.' };

    // Don't silently free capacity that live bookings still rely on.
    const held = await db.resourceBooking.count({ where: { resource_id: resourceId } });
    if (held > 0) {
      return {
        ok: false,
        message: `This pool has ${held} active reservation(s). Cancel or reschedule them before deleting it.`,
      };
    }

    await db.resource.delete({ where: { id: resourceId } });
    revalidatePath('/settings/resources');
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}
