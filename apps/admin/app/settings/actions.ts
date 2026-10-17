'use server';

import { revalidatePath } from 'next/cache';
import { randomBytes } from 'node:crypto';
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
  review_url: z
    .string()
    .trim()
    .url('Enter a valid URL (https://…)')
    .max(2048)
    .optional()
    .or(z.literal('')),
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
        review_url: emptyToNull(v.review_url),
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
// Cancellation policy (Operator.cancellation_policy — tiered refund model)
// ===========================================================================

/**
 * The tiered cancellation policy stored on `Operator.cancellation_policy` (a Json
 * column — editing it is migration-free). Shape mirrors `CancellationPolicy` in
 * @marina/core, which `computeCancellationRefund` and the API's `cancelBooking`
 * read. We validate here so a malformed policy can never reach the money path.
 *
 * Tiers are `{ hours_before -> refund_percent }` thresholds; the calculator sorts
 * them, so order in the UI is just for the operator's reading.
 */
const cancellationTierSchema = z.object({
  min_hours_before: z.coerce
    .number()
    .int('Use whole hours')
    .min(0, 'Hours cannot be negative')
    .max(8760, 'That is over a year out'),
  refund_percent: z.coerce
    .number()
    .int('Use a whole percent')
    .min(0, 'Percent cannot be negative')
    .max(100, 'Percent cannot exceed 100'),
});

const cancellationPolicySchema = z.object({
  tiers: z
    .array(cancellationTierSchema)
    .min(1, 'Add at least one refund tier')
    .max(8, 'That is a lot of tiers — keep it simple'),
  /** Dollars in the UI; persisted as integer cents. */
  cancellation_fee_dollars: z.coerce
    .number()
    .min(0, 'Fee cannot be negative')
    .max(100000, 'Fee seems too high'),
  fee_scope: z.enum(['order', 'guest']),
  self_cancel_hours: z.coerce
    .number()
    .int('Use whole hours')
    .min(0, 'Hours cannot be negative')
    .max(8760, 'That is over a year out'),
  refund_method: z.enum(['card', 'gift_card', 'card_then_gift']),
});

export type CancellationPolicyInput = z.infer<typeof cancellationPolicySchema>;

/**
 * Persist the operator-default cancellation policy onto `Operator.cancellation_policy`.
 * Tenant-scoped (RLS) + gated on operator:manage, mirroring every settings mutation.
 * Tiers are de-duplicated + sorted most-generous-first so the stored JSON is tidy;
 * the fee is converted dollars -> cents to match the core model.
 */
export async function updateCancellationPolicy(
  input: CancellationPolicyInput,
): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = cancellationPolicySchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    // Collapse duplicate thresholds (last one wins) and sort most-generous first so
    // the stored policy reads top-down the way the preview describes it.
    const byHours = new Map<number, number>();
    for (const t of v.tiers) byHours.set(t.min_hours_before, t.refund_percent);
    const tiers = [...byHours.entries()]
      .map(([min_hours_before, refund_percent]) => ({ min_hours_before, refund_percent }))
      .sort((a, b) => b.min_hours_before - a.min_hours_before);

    const policy = {
      tiers,
      cancellation_fee_cents: Math.round(v.cancellation_fee_dollars * 100),
      fee_scope: v.fee_scope,
      self_cancel_hours: v.self_cancel_hours,
      refund_method: v.refund_method,
    };

    const db = await getTenantDb();
    await db.operator.update({
      where: { id: operatorId },
      data: { cancellation_policy: policy },
    });

    revalidatePath('/settings/policies');
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

// ===========================================================================
// Manager-approval workflow (Singenuity §2)
// ===========================================================================

const approvalSchema = z.object({
  /** Dollar threshold (UI is dollars; stored as cents). Empty/0 = no amount gate. */
  approval_threshold_dollars: z
    .number({ invalid_type_error: 'Enter a dollar amount' })
    .min(0, 'Cannot be negative')
    .max(1_000_000, 'Seems too high')
    .nullable(),
  refund_requires_approval: z.boolean(),
});
export type ApprovalInput = z.infer<typeof approvalSchema>;

/**
 * Save the operator's payment/refund approval policy. Above the threshold (or for
 * every refund when the flag is set) a manager sign-off (`order:approve`) is
 * required in the payment/refund paths. Tenant-scoped, gated on operator:manage.
 */
export async function updateApprovalSettings(input: ApprovalInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = approvalSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const cents =
      v.approval_threshold_dollars && v.approval_threshold_dollars > 0
        ? Math.round(v.approval_threshold_dollars * 100)
        : null;

    const db = await getTenantDb();
    await db.operator.update({
      where: { id: operatorId },
      data: {
        approval_threshold_cents: cents,
        refund_requires_approval: v.refund_requires_approval,
      },
    });

    revalidatePath('/settings/approvals');
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
  /** First-class tax flag: identifies this fee as tax (skipped for tax-exempt customers). */
  is_tax: z.coerce.boolean().default(false),
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
        is_tax: v.is_tax,
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
        is_tax: v.is_tax,
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
// Charge presets (reusable one-click post-trip charges)
// ===========================================================================

/** Same free-string set as OrderCharge.category / addOrderChargeAction. */
const CHARGE_PRESET_CATEGORIES = ['FUEL', 'CLEANING', 'DAMAGE', 'LATE', 'OTHER'] as const;

const chargePresetSchema = z.object({
  label: z.string().trim().min(1, 'Label is required').max(120),
  category: z.enum(CHARGE_PRESET_CATEGORIES),
  /** Dollars in the UI; persisted as integer cents. */
  amount_dollars: z.coerce
    .number()
    .positive('Amount must be greater than zero')
    .max(10000, 'That amount looks too high'),
  active: z.coerce.boolean().default(true),
});

export type ChargePresetInput = z.infer<typeof chargePresetSchema>;

export async function createChargePreset(input: ChargePresetInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = chargePresetSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    const id = createId();
    await db.chargePreset.create({
      data: {
        id,
        operator_id: operatorId,
        category: v.category,
        label: v.label,
        amount_cents: Math.round(v.amount_dollars * 100),
        active: v.active,
      },
    });

    revalidatePath('/settings/charges');
    return { ok: true, id };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function updateChargePreset(
  presetId: string,
  input: ChargePresetInput,
): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!presetId) return { ok: false, message: 'Missing preset.' };
    const parsed = chargePresetSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    const existing = await db.chargePreset.findFirst({
      where: { id: presetId, operator_id: operatorId },
      select: { id: true },
    });
    if (!existing) return { ok: false, message: 'Preset not found.' };

    await db.chargePreset.update({
      where: { id: presetId },
      data: {
        category: v.category,
        label: v.label,
        amount_cents: Math.round(v.amount_dollars * 100),
        active: v.active,
      },
    });

    revalidatePath('/settings/charges');
    return { ok: true, id: presetId };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function deleteChargePreset(presetId: string): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!presetId) return { ok: false, message: 'Missing preset.' };

    const db = await getTenantDb();
    const existing = await db.chargePreset.findFirst({
      where: { id: presetId, operator_id: operatorId },
      select: { id: true },
    });
    if (!existing) return { ok: false, message: 'Preset not found.' };

    await db.chargePreset.delete({ where: { id: presetId } });
    revalidatePath('/settings/charges');
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function toggleChargePreset(presetId: string): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!presetId) return { ok: false, message: 'Missing preset.' };

    const db = await getTenantDb();
    const existing = await db.chargePreset.findFirst({
      where: { id: presetId, operator_id: operatorId },
      select: { active: true },
    });
    if (!existing) return { ok: false, message: 'Preset not found.' };

    await db.chargePreset.update({
      where: { id: presetId },
      data: { active: !existing.active },
    });
    revalidatePath('/settings/charges');
    return { ok: true, id: presetId };
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
// Calendar feed (secret-token ICS subscribe URL)
// ===========================================================================

/**
 * Generate (or rotate) the operator's calendar-feed token. The token is the
 * WHOLE credential — whoever holds the URL can read the booking schedule — so
 * rotation simply overwrites `config.token`, which invalidates every previously
 * shared URL on the next calendar poll. 48 hex chars (192 bits) of entropy.
 */
export async function rotateCalendarFeedToken(): Promise<ActionResult & { token?: string }> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const token = randomBytes(24).toString('hex');

    const db = await getTenantDb();
    await db.integration.upsert({
      where: { operator_id_key: { operator_id: operatorId, key: 'calendar_feed' } },
      create: {
        id: createId(),
        operator_id: operatorId,
        key: 'calendar_feed',
        enabled: true,
        config: { token },
      },
      update: { enabled: true, config: { token } },
    });

    revalidatePath('/settings/integrations');
    return { ok: true, token };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

/** Turn the feed off (keeps the token so re-enabling restores the same URL). */
export async function setCalendarFeedEnabled(enabled: boolean): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const db = await getTenantDb();
    await db.integration.updateMany({
      where: { operator_id: operatorId, key: 'calendar_feed' },
      data: { enabled },
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

// ===========================================================================
// Customer Questions
// ===========================================================================

const QUESTION_TYPES = [
  'TEXT',
  'TEXTAREA',
  'SELECT',
  'CHECKBOX',
  'NUMBER',
  'DATE',
  'PHONE',
] as const;

const questionSchema = z.object({
  label: z.string().trim().min(1, 'Label is required').max(200),
  type: z.enum(QUESTION_TYPES).default('TEXT'),
  required: z.coerce.boolean().default(false),
  /** SELECT choices; ignored for other types but always persisted as an array. */
  options: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  /** Empty => applies to every activity. */
  applies_to: z.string().trim().optional().or(z.literal('')),
  /** Empty => not narrowed to a single rate. */
  applies_to_rate: z.string().trim().optional().or(z.literal('')),
  show_in_confirmation: z.coerce.boolean().default(false),
  is_active: z.coerce.boolean().default(true),
  sort_index: z.coerce.number().int().min(0).max(9999).default(0),
});

export type QuestionInput = z.infer<typeof questionSchema>;

/**
 * Resolve the optional per-rate scope: empty => null; otherwise confirm the rate
 * belongs to this operator (RLS guarantees it, but we fail loudly rather than
 * persist a dangling reference). Returns the INVALID symbol when not found.
 */
async function resolveRateId(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  operatorId: string,
  rateId: string | undefined,
): Promise<string | null | typeof INVALID> {
  const trimmed = (rateId ?? '').trim();
  if (!trimmed) return null;
  const found = await db.rate.findFirst({
    where: { id: trimmed, operator_id: operatorId },
    select: { id: true },
  });
  return found ? found.id : INVALID;
}

export async function createQuestion(input: QuestionInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = questionSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    const activityId = await resolveActivityId(db, operatorId, v.applies_to);
    if (activityId === INVALID) return { ok: false, errors: { applies_to: 'Unknown activity.' } };
    const rateId = await resolveRateId(db, operatorId, v.applies_to_rate);
    if (rateId === INVALID) return { ok: false, errors: { applies_to_rate: 'Unknown rate.' } };

    const id = createId();
    await db.customerQuestion.create({
      data: {
        id,
        operator_id: operatorId,
        label: v.label,
        type: v.type,
        required: v.required,
        options: v.type === 'SELECT' ? v.options : [],
        applies_to: activityId,
        applies_to_rate: rateId,
        show_in_confirmation: v.show_in_confirmation,
        is_active: v.is_active,
        sort_index: v.sort_index,
      },
    });

    revalidatePath('/settings/questions');
    return { ok: true, id };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function updateQuestion(
  questionId: string,
  input: QuestionInput,
): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!questionId) return { ok: false, message: 'Missing question.' };
    const parsed = questionSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    const existing = await db.customerQuestion.findFirst({
      where: { id: questionId, operator_id: operatorId },
      select: { id: true },
    });
    if (!existing) return { ok: false, message: 'Question not found.' };

    const activityId = await resolveActivityId(db, operatorId, v.applies_to);
    if (activityId === INVALID) return { ok: false, errors: { applies_to: 'Unknown activity.' } };
    const rateId = await resolveRateId(db, operatorId, v.applies_to_rate);
    if (rateId === INVALID) return { ok: false, errors: { applies_to_rate: 'Unknown rate.' } };

    await db.customerQuestion.update({
      where: { id: questionId },
      data: {
        label: v.label,
        type: v.type,
        required: v.required,
        options: v.type === 'SELECT' ? v.options : [],
        applies_to: activityId,
        applies_to_rate: rateId,
        show_in_confirmation: v.show_in_confirmation,
        is_active: v.is_active,
        sort_index: v.sort_index,
      },
    });

    revalidatePath('/settings/questions');
    return { ok: true, id: questionId };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function deleteQuestion(questionId: string): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!questionId) return { ok: false, message: 'Missing question.' };

    const db = await getTenantDb();
    const existing = await db.customerQuestion.findFirst({
      where: { id: questionId, operator_id: operatorId },
      select: { id: true },
    });
    if (!existing) return { ok: false, message: 'Question not found.' };

    await db.customerQuestion.delete({ where: { id: questionId } });
    revalidatePath('/settings/questions');
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function toggleQuestion(questionId: string): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!questionId) return { ok: false, message: 'Missing question.' };

    const db = await getTenantDb();
    const existing = await db.customerQuestion.findFirst({
      where: { id: questionId, operator_id: operatorId },
      select: { is_active: true },
    });
    if (!existing) return { ok: false, message: 'Question not found.' };

    await db.customerQuestion.update({
      where: { id: questionId },
      data: { is_active: !existing.is_active },
    });
    revalidatePath('/settings/questions');
    return { ok: true, id: questionId };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

// ===========================================================================
// Message templates (per-kind transactional copy overrides)
// ===========================================================================

/**
 * The transactional messages an operator may override. Mirrors the
 * `MessageTemplateKind` enum in schema.prisma — one row per kind per operator.
 * The notifications service reads subject_override / body_override / sms_body_override
 * and falls back to the built-in default copy for any blank field.
 */
const MESSAGE_TEMPLATE_KINDS = [
  'BOOKING_CONFIRMATION',
  'BOOKING_REMINDER',
  'REFUND_RECEIPT',
  'BOOKING_CANCELLED',
  'REVIEW_REQUEST',
] as const;

const messageTemplateSchema = z.object({
  kind: z.enum(MESSAGE_TEMPLATE_KINDS),
  enabled: z.coerce.boolean().default(true),
  /** Blank => fall back to the built-in default subject. */
  subject_override: z.string().trim().max(200).optional().or(z.literal('')),
  /** Blank => fall back to the built-in default email body. */
  body_override: z.string().trim().max(5000).optional().or(z.literal('')),
  /** Blank => fall back to the built-in compact SMS copy. */
  sms_body_override: z.string().trim().max(1000).optional().or(z.literal('')),
});

export type MessageTemplateInput = z.infer<typeof messageTemplateSchema>;

export async function createMessageTemplate(
  input: MessageTemplateInput,
): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    const parsed = messageTemplateSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    // One row per kind per operator (@@unique([operator_id, kind])).
    const clash = await db.messageTemplate.findFirst({
      where: { operator_id: operatorId, kind: v.kind },
      select: { id: true },
    });
    if (clash) {
      return { ok: false, errors: { kind: 'You already have an override for this message.' } };
    }

    const id = createId();
    await db.messageTemplate.create({
      data: {
        id,
        operator_id: operatorId,
        kind: v.kind,
        enabled: v.enabled,
        subject_override: emptyToNull(v.subject_override),
        body_override: emptyToNull(v.body_override),
        sms_body_override: emptyToNull(v.sms_body_override),
      },
    });

    revalidatePath('/settings/messages');
    return { ok: true, id };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function updateMessageTemplate(
  templateId: string,
  input: MessageTemplateInput,
): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!templateId) return { ok: false, message: 'Missing template.' };
    const parsed = messageTemplateSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
    const v = parsed.data;

    const db = await getTenantDb();
    const existing = await db.messageTemplate.findFirst({
      where: { id: templateId, operator_id: operatorId },
      select: { id: true },
    });
    if (!existing) return { ok: false, message: 'Template not found.' };

    // Guard the per-kind uniqueness when the operator re-points a row's kind.
    const clash = await db.messageTemplate.findFirst({
      where: { operator_id: operatorId, kind: v.kind, id: { not: templateId } },
      select: { id: true },
    });
    if (clash) {
      return { ok: false, errors: { kind: 'You already have an override for this message.' } };
    }

    await db.messageTemplate.update({
      where: { id: templateId },
      data: {
        kind: v.kind,
        enabled: v.enabled,
        subject_override: emptyToNull(v.subject_override),
        body_override: emptyToNull(v.body_override),
        sms_body_override: emptyToNull(v.sms_body_override),
      },
    });

    revalidatePath('/settings/messages');
    return { ok: true, id: templateId };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function deleteMessageTemplate(templateId: string): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!templateId) return { ok: false, message: 'Missing template.' };

    const db = await getTenantDb();
    const existing = await db.messageTemplate.findFirst({
      where: { id: templateId, operator_id: operatorId },
      select: { id: true },
    });
    if (!existing) return { ok: false, message: 'Template not found.' };

    await db.messageTemplate.delete({ where: { id: templateId } });
    revalidatePath('/settings/messages');
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}

export async function toggleMessageTemplate(templateId: string): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('operator:manage');
    if (!templateId) return { ok: false, message: 'Missing template.' };

    const db = await getTenantDb();
    const existing = await db.messageTemplate.findFirst({
      where: { id: templateId, operator_id: operatorId },
      select: { enabled: true },
    });
    if (!existing) return { ok: false, message: 'Template not found.' };

    await db.messageTemplate.update({
      where: { id: templateId },
      data: { enabled: !existing.enabled },
    });
    revalidatePath('/settings/messages');
    return { ok: true, id: templateId };
  } catch (err) {
    if (err instanceof AuthorizationError) return denied();
    throw err;
  }
}
