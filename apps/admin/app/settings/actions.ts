'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createId } from '@marina/core';
import { AuthorizationError } from '@marina/auth';
import { getTenantDb, requirePermission } from '../../lib/session';

/**
 * Server actions for the settings slice. Every mutation:
 *  - requires the `operator:manage` permission (branding, policies, fees,
 *    locations, integrations are all operator-level configuration),
 *  - runs through the tenant-scoped client (RLS enforces operator isolation), and
 *  - still writes an explicit `operator_id` where-clause as defense in depth.
 *
 * White-label is enforced here: branding values are operator-authored and never
 * defaulted to any platform name.
 */

export interface ActionResult {
  ok: boolean;
  /** Field-path -> message, suitable for surfacing inline in the form. */
  errors?: Record<string, string>;
  /** General error message when not field-specific. */
  message?: string;
  /** Optional id of the created/updated record. */
  id?: string;
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

/** Translate a thrown AuthorizationError into a friendly result. */
function denied(): ActionResult {
  return { ok: false, message: 'You do not have permission to manage settings.' };
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// ===========================================================================
// Branding (white-label)
// ===========================================================================

const brandingSchema = z.object({
  name_internal: z.string().trim().min(1, 'Internal name is required').max(160),
  name_external: z.string().trim().min(1, 'Public name is required').max(160),
  website: z
    .string()
    .trim()
    .url('Enter a valid URL (https://…)')
    .max(2048)
    .optional()
    .or(z.literal('')),
  phone: z.string().trim().max(32).optional().or(z.literal('')),
  brand_color: z.string().regex(HEX_COLOR, 'Brand color must be a hex value (e.g. #0ea5e9)'),
  logo_dark_url: z.string().trim().url('Enter a valid image URL').max(2048).optional().or(z.literal('')),
  logo_light_url: z.string().trim().url('Enter a valid image URL').max(2048).optional().or(z.literal('')),
});

export type BrandingInput = z.infer<typeof brandingSchema>;

export async function updateBranding(input: BrandingInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = brandingSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    await db.operator.update({
      where: { id: operatorId },
      data: {
        name_internal: v.name_internal,
        name_external: v.name_external,
        website: emptyToNull(v.website),
        phone: emptyToNull(v.phone),
        brand_color: v.brand_color,
        logo_dark_url: emptyToNull(v.logo_dark_url),
        logo_light_url: emptyToNull(v.logo_light_url),
      },
    });

    revalidatePath('/settings/branding');
    revalidatePath('/settings');
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

// ===========================================================================
// Policies
// ===========================================================================

const policiesSchema = z.object({
  legal_adult_age: z.coerce
    .number()
    .int('Must be a whole number')
    .min(13, 'Adult age seems too low')
    .max(25, 'Adult age seems too high'),
  timezone: z.string().trim().min(1, 'Timezone is required').max(64),
  /** Free-form policy text stored in operator config-like fields below. */
  cancellation_policy: z.string().trim().max(5000).optional().or(z.literal('')),
  checkin_instructions: z.string().trim().max(5000).optional().or(z.literal('')),
});

export type PoliciesInput = z.infer<typeof policiesSchema>;

/**
 * Update operator policies. `legal_adult_age` and `timezone` are first-class
 * Operator columns. Cancellation policy + check-in instructions are free-form text
 * stored via an Integration config record keyed "policies", so we extend through
 * config rather than adding columns (per docs/ARCHITECTURE.md §3) and avoid a
 * migration.
 */
export async function updatePolicies(input: PoliciesInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = policiesSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    await db.operator.update({
      where: { id: operatorId },
      data: {
        legal_adult_age: v.legal_adult_age,
        timezone: v.timezone,
      },
    });

    // Free-form policy text lives in an Integration config record (key="policies")
    // so the operator can edit cancellation / check-in copy without a migration.
    await db.integration.upsert({
      where: { operator_id_key: { operator_id: operatorId, key: 'policies' } },
      create: {
        id: createId(),
        operator_id: operatorId,
        key: 'policies',
        enabled: true,
        config: {
          cancellation_policy: emptyToNull(v.cancellation_policy) ?? '',
          checkin_instructions: emptyToNull(v.checkin_instructions) ?? '',
        },
      },
      update: {
        config: {
          cancellation_policy: emptyToNull(v.cancellation_policy) ?? '',
          checkin_instructions: emptyToNull(v.checkin_instructions) ?? '',
        },
      },
    });

    revalidatePath('/settings/policies');
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

// ===========================================================================
// Fees & Taxes (Fee CRUD)
// ===========================================================================

const feeSchema = z.object({
  name: z.string().trim().min(1, 'Fee name is required').max(120),
  type: z.enum(['PERCENT', 'FLAT']),
  /** For PERCENT: a percentage (e.g. 8.5). For FLAT: dollars (converted to cents). */
  value: z.coerce.number().min(0, 'Value cannot be negative'),
  enabled: z.coerce.boolean().default(true),
  ignore_tax_exempt: z.coerce.boolean().default(false),
  /** Empty string => global fee (applies to all activities). */
  activity_id: z.string().trim().optional().or(z.literal('')),
});

export type FeeInput = z.infer<typeof feeSchema>;

/**
 * The Fee model stores `value` as a Float. By @marina/core's pricing contract a
 * PERCENT fee's value is a percentage; a FLAT fee's value is added to the taxable
 * total in the same unit as the line items (integer cents). So we persist FLAT
 * values as integer cents and PERCENT values as the raw percentage.
 */
function normalizeFeeValue(type: 'PERCENT' | 'FLAT', value: number): number {
  if (type === 'FLAT') return Math.round(value * 100); // dollars -> cents
  return value; // percentage as entered
}

export async function createFee(input: FeeInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = feeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    const activityId = await resolveActivityId(db, operatorId, v.activity_id);
    if (activityId === INVALID) {
      return { ok: false, errors: { activity_id: 'Unknown activity.' } };
    }

    const id = createId();
    await db.fee.create({
      data: {
        id,
        operator_id: operatorId,
        activity_id: activityId,
        name: v.name,
        type: v.type,
        value: normalizeFeeValue(v.type, v.value),
        enabled: v.enabled,
        ignore_tax_exempt: v.ignore_tax_exempt,
      },
    });

    revalidatePath('/settings/fees');
    return { ok: true, id };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function updateFee(feeId: string, input: FeeInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!feeId) return { ok: false, message: 'Missing fee.' };
    const parsed = feeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    const existing = await db.fee.findFirst({
      where: { id: feeId, operator_id: operatorId },
      select: { id: true },
    });
    if (!existing) return { ok: false, message: 'Fee not found.' };

    const activityId = await resolveActivityId(db, operatorId, v.activity_id);
    if (activityId === INVALID) {
      return { ok: false, errors: { activity_id: 'Unknown activity.' } };
    }

    await db.fee.update({
      where: { id: feeId },
      data: {
        activity_id: activityId,
        name: v.name,
        type: v.type,
        value: normalizeFeeValue(v.type, v.value),
        enabled: v.enabled,
        ignore_tax_exempt: v.ignore_tax_exempt,
      },
    });

    revalidatePath('/settings/fees');
    return { ok: true, id: feeId };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function deleteFee(feeId: string): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!feeId) return { ok: false, message: 'Missing fee.' };

    const db = await getTenantDb();
    const existing = await db.fee.findFirst({
      where: { id: feeId, operator_id: operatorId },
      select: { id: true },
    });
    if (!existing) return { ok: false, message: 'Fee not found.' };

    await db.fee.delete({ where: { id: feeId } });
    revalidatePath('/settings/fees');
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function toggleFee(feeId: string): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!feeId) return { ok: false, message: 'Missing fee.' };

    const db = await getTenantDb();
    const existing = await db.fee.findFirst({
      where: { id: feeId, operator_id: operatorId },
      select: { enabled: true },
    });
    if (!existing) return { ok: false, message: 'Fee not found.' };

    await db.fee.update({ where: { id: feeId }, data: { enabled: !existing.enabled } });
    revalidatePath('/settings/fees');
    return { ok: true, id: feeId };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

// ===========================================================================
// Locations (CRUD)
// ===========================================================================

const locationSchema = z.object({
  name: z.string().trim().min(1, 'Location name is required').max(160),
  address: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().max(120).optional().or(z.literal('')),
  state: z.string().trim().max(64).optional().or(z.literal('')),
  zip: z.string().trim().max(16).optional().or(z.literal('')),
  timezone: z.string().trim().max(64).optional().or(z.literal('')),
  is_default: z.coerce.boolean().default(false),
  is_active: z.coerce.boolean().default(true),
});

export type LocationInput = z.infer<typeof locationSchema>;

export async function createLocation(input: LocationInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = locationSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();

    // If this is the operator's first location, make it default regardless of input.
    const count = await db.location.count();
    const makeDefault = v.is_default || count === 0;

    const id = createId();
    await db.location.create({
      data: {
        id,
        operator_id: operatorId,
        name: v.name,
        address: emptyToNull(v.address),
        city: emptyToNull(v.city),
        state: emptyToNull(v.state),
        zip: emptyToNull(v.zip),
        timezone: emptyToNull(v.timezone),
        is_default: makeDefault,
        is_active: v.is_active,
      },
    });

    // Exactly one default per operator.
    if (makeDefault) {
      await db.location.updateMany({
        where: { operator_id: operatorId, id: { not: id } },
        data: { is_default: false },
      });
    }

    revalidatePath('/settings/locations');
    return { ok: true, id };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function updateLocation(
  locationId: string,
  input: LocationInput,
): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!locationId) return { ok: false, message: 'Missing location.' };
    const parsed = locationSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    const existing = await db.location.findFirst({
      where: { id: locationId, operator_id: operatorId },
      select: { id: true, is_default: true },
    });
    if (!existing) return { ok: false, message: 'Location not found.' };

    await db.location.update({
      where: { id: locationId },
      data: {
        name: v.name,
        address: emptyToNull(v.address),
        city: emptyToNull(v.city),
        state: emptyToNull(v.state),
        zip: emptyToNull(v.zip),
        timezone: emptyToNull(v.timezone),
        is_default: v.is_default,
        is_active: v.is_active,
      },
    });

    if (v.is_default) {
      await db.location.updateMany({
        where: { operator_id: operatorId, id: { not: locationId } },
        data: { is_default: false },
      });
    }

    revalidatePath('/settings/locations');
    return { ok: true, id: locationId };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function deleteLocation(locationId: string): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!locationId) return { ok: false, message: 'Missing location.' };

    const db = await getTenantDb();
    const existing = await db.location.findFirst({
      where: { id: locationId, operator_id: operatorId },
      select: { id: true, is_default: true },
    });
    if (!existing) return { ok: false, message: 'Location not found.' };

    // Guard: don't orphan activities/resources tied to this location.
    const [activityCount, resourceCount, total] = await Promise.all([
      db.activity.count({ where: { location_id: locationId } }),
      db.resource.count({ where: { location_id: locationId } }),
      db.location.count(),
    ]);
    if (activityCount > 0 || resourceCount > 0) {
      return {
        ok: false,
        message: 'Reassign this location’s activities and resources before deleting it.',
      };
    }
    if (total <= 1) {
      return { ok: false, message: 'You must keep at least one location.' };
    }

    await db.location.delete({ where: { id: locationId } });

    // If we removed the default, promote another active location to default.
    if (existing.is_default) {
      const next = await db.location.findFirst({
        where: { operator_id: operatorId, is_active: true },
        orderBy: { created_at: 'asc' },
        select: { id: true },
      });
      if (next) {
        await db.location.update({ where: { id: next.id }, data: { is_default: true } });
      }
    }

    revalidatePath('/settings/locations');
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

// ===========================================================================
// Integrations (upsert by key)
// ===========================================================================

/** Known integration keys are validated; config is a free-form record. */
const integrationSchema = z.object({
  key: z.string().trim().min(1, 'Integration key is required').max(64),
  enabled: z.coerce.boolean().default(false),
  /** Arbitrary key/value config (API keys, account ids, pixel ids, etc.). */
  config: z.record(z.string(), z.string()).default({}),
});

export type IntegrationInput = z.infer<typeof integrationSchema>;

export async function upsertIntegration(input: IntegrationInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = integrationSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    await db.integration.upsert({
      where: { operator_id_key: { operator_id: operatorId, key: v.key } },
      create: {
        id: createId(),
        operator_id: operatorId,
        key: v.key,
        enabled: v.enabled,
        config: v.config,
      },
      update: {
        enabled: v.enabled,
        config: v.config,
      },
    });

    revalidatePath('/settings/integrations');
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function emptyToNull(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length ? trimmed : null;
}

const INVALID = Symbol('invalid-activity');

/**
 * Resolve a fee/scope activity id: empty => null (global fee). Otherwise confirm
 * the activity belongs to this operator (RLS already guarantees this, but we fail
 * loudly rather than persisting a dangling reference).
 */
async function resolveActivityId(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  operatorId: string,
  activityId: string | undefined,
): Promise<string | null | typeof INVALID> {
  const trimmed = (activityId ?? '').trim();
  if (!trimmed) return null;
  const found = await db.activity.findFirst({
    where: { id: trimmed, operator_id: operatorId },
    select: { id: true },
  });
  return found ? found.id : INVALID;
}
