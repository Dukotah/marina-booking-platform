'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createId } from '@marina/core';
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
    await tx.operator.update({
      where: { id: operatorId },
      data: {
        name_external: brand.name_external,
        name_internal: emptyToNull(brand.name_internal) ?? brand.name_external,
        brand_color: brand.brand_color,
        website: emptyToNull(brand.website),
        phone: emptyToNull(brand.phone),
      },
    });

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

    // 3) Activities — create the starter set, attached to the new location.
    await tx.activity.createMany({
      data: activities.map((a, i) => ({
        id: createId(),
        operator_id: operatorId,
        location_id: locationId,
        name_internal: a.name_external,
        name_external: a.name_external,
        category: a.category,
        color: brand.brand_color,
        sort_index: i,
      })),
    });
  });

  revalidatePath('/settings');
  revalidatePath('/activities');
  revalidatePath('/');
  return { ok: true };
}
