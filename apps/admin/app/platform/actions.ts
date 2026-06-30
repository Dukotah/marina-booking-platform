'use server';

/**
 * Platform (super-admin) server actions: provision a client, edit a client, and
 * "open" / "exit" a client (the active-operator cookie that drops the platform
 * admin into a tenant's dashboard). All gated by assertPlatformAdmin.
 */

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { ProvisionError } from '@marina/database';
import { getOperatorContext } from '../../lib/session';
import {
  assertPlatformAdmin,
  provisionClient,
  updateOperatorRecord,
  ACTIVE_OPERATOR_COOKIE,
} from '../../lib/platform';

export interface PlatformResult {
  ok: boolean;
  message?: string;
  errors?: Record<string, string>;
  /** Slug of the created/updated client. */
  slug?: string;
  id?: string;
}

async function requirePlatform() {
  const ctx = await getOperatorContext();
  assertPlatformAdmin(ctx.auth.userId);
}

function zodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const createSchema = z.object({
  name: z.string().trim().min(1, 'Business name is required').max(160),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, numbers, and single hyphens only'),
  brandColor: z.string().trim().regex(HEX, 'Use a hex color like #0e7490').default('#0ea5e9'),
  ownerName: z.string().trim().min(1, 'Owner name is required').max(120),
  ownerEmail: z.string().trim().toLowerCase().email('A valid owner email is required'),
  timezone: z.string().trim().min(1).default('America/Los_Angeles'),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(64).optional(),
  salesTaxPercent: z.coerce.number().min(0).max(50).optional(),
  processingFeePercent: z.coerce.number().min(0).max(50).optional(),
  plan: z.string().trim().default('trial'),
});

export async function createClientAction(
  _prev: PlatformResult | null,
  formData: FormData,
): Promise<PlatformResult> {
  await requirePlatform();

  const parsed = createSchema.safeParse({
    name: formData.get('name'),
    slug: formData.get('slug'),
    brandColor: formData.get('brandColor') || undefined,
    ownerName: formData.get('ownerName'),
    ownerEmail: formData.get('ownerEmail'),
    timezone: formData.get('timezone') || undefined,
    city: formData.get('city') || undefined,
    state: formData.get('state') || undefined,
    salesTaxPercent: formData.get('salesTaxPercent') || undefined,
    processingFeePercent: formData.get('processingFeePercent') || undefined,
    plan: formData.get('plan') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, errors: zodErrors(parsed.error) };
  }
  const d = parsed.data;

  try {
    const result = await provisionClient({
      slug: d.slug,
      nameExternal: d.name,
      brandColor: d.brandColor,
      timezone: d.timezone,
      location: { city: d.city, state: d.state },
      owner: {
        name: d.ownerName,
        email: d.ownerEmail,
        // Dev shim id so the owner can be impersonated/logged in locally; in prod
        // this is replaced by the Clerk id once they sign up.
        authUserId: `dev-${d.slug}`,
      },
      salesTaxPercent: d.salesTaxPercent,
      processingFeePercent: d.processingFeePercent,
      plan: d.plan,
    });
    revalidatePath('/platform');
    return { ok: true, slug: result.slug, id: result.operatorId };
  } catch (err) {
    if (err instanceof ProvisionError) return { ok: false, message: err.message };
    throw err;
  }
}

const updateSchema = z.object({
  name_external: z.string().trim().min(1).max(160),
  name_internal: z.string().trim().max(160).optional(),
  brand_color: z.string().trim().regex(HEX, 'Use a hex color like #0e7490'),
  website: z.string().trim().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(32).optional().or(z.literal('')),
  timezone: z.string().trim().min(1),
  legal_adult_age: z.coerce.number().int().min(0).max(99),
  plan: z.string().trim().min(1),
  is_active: z.coerce.boolean(),
});

export async function updateClientAction(
  id: string,
  _prev: PlatformResult | null,
  formData: FormData,
): Promise<PlatformResult> {
  await requirePlatform();

  const parsed = updateSchema.safeParse({
    name_external: formData.get('name_external'),
    name_internal: formData.get('name_internal') || undefined,
    brand_color: formData.get('brand_color'),
    website: formData.get('website') ?? '',
    phone: formData.get('phone') ?? '',
    timezone: formData.get('timezone'),
    legal_adult_age: formData.get('legal_adult_age'),
    plan: formData.get('plan'),
    is_active: formData.get('is_active') === 'on' || formData.get('is_active') === 'true',
  });
  if (!parsed.success) {
    return { ok: false, errors: zodErrors(parsed.error) };
  }
  const d = parsed.data;

  await updateOperatorRecord(id, {
    name_external: d.name_external,
    name_internal: d.name_internal || d.name_external,
    brand_color: d.brand_color,
    website: d.website ? d.website : null,
    phone: d.phone ? d.phone : null,
    timezone: d.timezone,
    legal_adult_age: d.legal_adult_age,
    plan: d.plan,
    is_active: d.is_active,
  });
  revalidatePath('/platform');
  revalidatePath(`/platform/${id}`);
  return { ok: true, id };
}

/** Drop the platform admin into a client's dashboard (sets the active cookie). */
export async function openClientAction(operatorId: string): Promise<void> {
  await requirePlatform();
  cookies().set(ACTIVE_OPERATOR_COOKIE, operatorId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
}

/** Return to the platform view (clears the active cookie). */
export async function exitClientAction(): Promise<void> {
  cookies().delete(ACTIVE_OPERATOR_COOKIE);
}
