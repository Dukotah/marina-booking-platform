'use server';

/**
 * Platform (super-admin) server actions: provision a client, edit a client, and
 * "open" / "exit" a client (the active-operator cookie that drops the platform
 * admin into a tenant's dashboard). All gated by assertPlatformAdmin.
 */

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { adminPrisma, ProvisionError } from '@marina/database';
import { getOperatorContext, type OperatorContext } from '../../lib/session';
import {
  assertPlatformAdmin,
  provisionClient,
  updateOperatorRecord,
  ACTIVE_OPERATOR_COOKIE,
} from '../../lib/platform';
import { ALL_STAGES } from './_components/onboarding-stages';

export interface PlatformResult {
  ok: boolean;
  message?: string;
  errors?: Record<string, string>;
  /** Slug of the created/updated client. */
  slug?: string;
  id?: string;
}

async function requirePlatform(): Promise<OperatorContext> {
  const ctx = await getOperatorContext();
  assertPlatformAdmin(ctx.auth.userId);
  return ctx;
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

// ---------------------------------------------------------------------------
// Onboarding cockpit — stage, contacts, and the notes log
//
// OperatorOnboarding and OperatorNote are PLATFORM data: the agency's private
// record of how a rollout is going. They sit outside tenant RLS on purpose, so
// they are only ever touched here, through adminPrisma, behind requirePlatform().
// Nothing in the tenant app may read or write them.
// ---------------------------------------------------------------------------

/** Who the note is from. In dev this is the shim id; in prod, the Clerk user id. */
function authorFrom(ctx: OperatorContext): string {
  return ctx.auth.userId || 'platform';
}

/**
 * A date input gives "2026-09-14" with no timezone. Storing that at UTC midnight
 * makes it render as the 13th for anyone west of Greenwich — including this
 * marina — so we anchor it at midday UTC, which lands on the same calendar day
 * everywhere the product is used.
 */
function parseDateInput(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

const stageSchema = z.enum(ALL_STAGES);

/**
 * Move a client along the pipeline. One click, no save button — this is the control
 * the owner touches most, and a two-step save is how a stage silently goes stale.
 */
export async function setStageAction(operatorId: string, stage: string): Promise<PlatformResult> {
  await requirePlatform();

  const parsed = stageSchema.safeParse(stage);
  if (!parsed.success) {
    return { ok: false, message: 'That is not a stage we track.' };
  }
  const next = parsed.data;

  const existing = await adminPrisma.operatorOnboarding.findUnique({
    where: { operator_id: operatorId },
    select: { went_live_on: true },
  });

  // Stamp the go-live date the first time they reach LIVE and never overwrite it:
  // it is a historical fact, so bouncing back to TESTING to fix something must not
  // rewrite when this client actually started taking money.
  const wentLiveOn =
    next === 'LIVE' && !existing?.went_live_on ? new Date() : existing?.went_live_on ?? null;

  await adminPrisma.operatorOnboarding.upsert({
    where: { operator_id: operatorId },
    create: { operator_id: operatorId, stage: next, went_live_on: wentLiveOn },
    update: { stage: next, went_live_on: wentLiveOn },
  });

  revalidatePath('/platform');
  revalidatePath(`/platform/${operatorId}`);
  return { ok: true, id: operatorId, message: 'Stage updated.' };
}

const detailsSchema = z.object({
  owner: z.string().trim().max(120),
  contact_name: z.string().trim().max(120),
  contact_email: z
    .union([z.literal(''), z.string().trim().toLowerCase().email('Use a valid email address')])
    .default(''),
  contact_phone: z.string().trim().max(32),
  target_live_on: z
    .union([
      z.literal(''),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-14'),
    ])
    .default(''),
});

/** Save the platform owner, the client-side contact, and the date we are working to. */
export async function saveOnboardingDetailsAction(
  operatorId: string,
  _prev: PlatformResult | null,
  formData: FormData,
): Promise<PlatformResult> {
  await requirePlatform();

  const parsed = detailsSchema.safeParse({
    owner: formData.get('owner') ?? '',
    contact_name: formData.get('contact_name') ?? '',
    contact_email: formData.get('contact_email') ?? '',
    contact_phone: formData.get('contact_phone') ?? '',
    target_live_on: formData.get('target_live_on') ?? '',
  });
  if (!parsed.success) {
    return { ok: false, errors: zodErrors(parsed.error) };
  }
  const d = parsed.data;

  const data = {
    owner: d.owner || null,
    contact_name: d.contact_name || null,
    contact_email: d.contact_email || null,
    contact_phone: d.contact_phone || null,
    target_live_on: d.target_live_on ? parseDateInput(d.target_live_on) : null,
  };

  await adminPrisma.operatorOnboarding.upsert({
    where: { operator_id: operatorId },
    create: { operator_id: operatorId, ...data },
    update: data,
  });

  revalidatePath('/platform');
  revalidatePath(`/platform/${operatorId}`);
  return { ok: true, id: operatorId, message: 'Saved.' };
}

const noteSchema = z.object({
  body: z.string().trim().min(1, 'Write what happened before adding the note').max(2000),
  is_blocker: z.boolean(),
});

/**
 * Add a dated note. Marking it as the blocker clears the previous one in the same
 * transaction: "what is blocking this client" is a single answer, and two of them
 * is the same as none.
 */
export async function addNoteAction(
  operatorId: string,
  _prev: PlatformResult | null,
  formData: FormData,
): Promise<PlatformResult> {
  const ctx = await requirePlatform();

  const parsed = noteSchema.safeParse({
    body: formData.get('body') ?? '',
    is_blocker: formData.get('is_blocker') === 'on' || formData.get('is_blocker') === 'true',
  });
  if (!parsed.success) {
    return { ok: false, errors: zodErrors(parsed.error) };
  }
  const d = parsed.data;

  await adminPrisma.$transaction(async (tx) => {
    if (d.is_blocker) {
      await tx.operatorNote.updateMany({
        where: { operator_id: operatorId, is_blocker: true },
        data: { is_blocker: false },
      });
    }
    await tx.operatorNote.create({
      data: {
        operator_id: operatorId,
        author: authorFrom(ctx),
        body: d.body,
        is_blocker: d.is_blocker,
      },
    });
  });

  revalidatePath('/platform');
  revalidatePath(`/platform/${operatorId}`);
  return { ok: true, id: operatorId, message: 'Note added.' };
}

/** Promote an existing note to the current blocker, or clear the blocker flag. */
export async function setNoteBlockerAction(
  operatorId: string,
  noteId: string,
  isBlocker: boolean,
): Promise<PlatformResult> {
  await requirePlatform();

  // Scoping the update by operator_id as well as id is what stops a note id from
  // one client being flipped while a different client's page is open.
  const updated = await adminPrisma.$transaction(async (tx) => {
    if (isBlocker) {
      await tx.operatorNote.updateMany({
        where: { operator_id: operatorId, is_blocker: true },
        data: { is_blocker: false },
      });
    }
    return tx.operatorNote.updateMany({
      where: { id: noteId, operator_id: operatorId },
      data: { is_blocker: isBlocker },
    });
  });

  if (updated.count === 0) {
    return { ok: false, message: 'That note is no longer here — reload the page.' };
  }

  revalidatePath('/platform');
  revalidatePath(`/platform/${operatorId}`);
  return { ok: true, id: operatorId, message: isBlocker ? 'Marked as the blocker.' : 'Blocker cleared.' };
}
