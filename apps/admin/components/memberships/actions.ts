'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { toCents } from '@marina/core';
import { getTenantDb, requirePermission } from '../../lib/session';

/**
 * Server actions for the memberships slice.
 *
 * Per D-007 the admin app talks to the database DIRECTLY through the tenant-scoped
 * client (RLS), not via the API — the same way the gift-certificate actions do. The
 * issue rules below (uses seeded from `total_uses`, expiry from `duration_days`)
 * deliberately mirror `issueCustomerMembership` in
 * `apps/api/src/services/memberships.ts`, which is the authority for the customer-
 * facing path. They are two copies of one rule; see the handoff note about lifting
 * that service into a shared package so there is only one.
 *
 * Permissions:
 *   - catalog create/edit  -> activity:write (a membership is a sellable product,
 *                             gated exactly like packages)
 *   - grant / revoke       -> customer:write (it changes what one customer holds
 *                             and what they will be charged, so a line STAFF member
 *                             with activity:read cannot hand out season passes)
 *
 * All money is integer cents.
 */

/** Result shape the client forms render inline. */
export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Set on a successful grant so the form can confirm who received what. */
  message?: string;
}

const KINDS = ['SEASON_PASS', 'PUNCH_CARD', 'MEMBER_RATE'] as const;

const productSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the membership a name.').max(160),
    kind: z.enum(KINDS),
    priceDollars: z.coerce
      .number({ invalid_type_error: 'Enter a price.' })
      .min(0, 'Price cannot be negative.')
      .max(100_000, 'That price looks like a typo.'),
    discountType: z.enum(['PERCENT', 'FLAT']),
    discountValue: z.coerce
      .number({ invalid_type_error: 'Enter a discount.' })
      .min(0, 'Discount cannot be negative.'),
    totalUses: z
      .union([z.coerce.number().int().positive(), z.literal('')])
      .optional()
      .transform((v) => (v === '' || v === undefined ? null : (v as number))),
    durationDays: z
      .union([z.coerce.number().int().positive(), z.literal('')])
      .optional()
      .transform((v) => (v === '' || v === undefined ? null : (v as number))),
    isActive: z.boolean(),
  })
  .superRefine((val, ctx) => {
    // A punch card with no punches would sell and never work; a >100% discount
    // would price every booking at zero. Both are caught before anything is stored.
    if (val.kind === 'PUNCH_CARD' && (val.totalUses == null || val.totalUses <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A punch card needs a number of uses.',
        path: ['totalUses'],
      });
    }
    if (val.discountType === 'PERCENT' && val.discountValue > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A percent discount cannot exceed 100.',
        path: ['discountValue'],
      });
    }
  });

/** Read the shared product fields out of a FormData payload. */
function readProductForm(formData: FormData) {
  return productSchema.safeParse({
    name: formData.get('name'),
    kind: formData.get('kind'),
    priceDollars: formData.get('priceDollars'),
    discountType: formData.get('discountType'),
    discountValue: formData.get('discountValue'),
    totalUses: formData.get('totalUses') ?? '',
    durationDays: formData.get('durationDays') ?? '',
    isActive: formData.get('isActive') === 'on',
  });
}

/** Create a membership product. */
export async function createMembershipAction(formData: FormData): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('activity:write');
    const parsed = readProductForm(formData);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
    }
    const input = parsed.data;
    const db = await getTenantDb();

    await db.membership.create({
      data: {
        // Top-level create: operator_id is explicit (D-011).
        operator_id: operatorId,
        name: input.name,
        kind: input.kind,
        // toCents, not `* 100` — one rounding implementation for the whole platform.
        price_cents: toCents(input.priceDollars),
        discount_type: input.discountType,
        // PERCENT stores a whole percent; FLAT stores integer CENTS, so the dollar
        // figure typed into the form is converted here and nowhere else.
        discount_value:
          input.discountType === 'PERCENT'
            ? Math.round(input.discountValue)
            : toCents(input.discountValue),
        // Uses only mean something on a punch card. Storing one on a season pass
        // would make every issue seed a limit nobody intended.
        total_uses: input.kind === 'PUNCH_CARD' ? input.totalUses : null,
        duration_days: input.durationDays,
        is_active: input.isActive,
      },
    });

    revalidatePath('/memberships');
    return { ok: true, message: `${input.name} is ready to sell.` };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Update an existing membership product. */
export async function updateMembershipAction(
  membershipId: string,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('activity:write');
    if (!membershipId) return { ok: false, error: 'Missing membership.' };
    const parsed = readProductForm(formData);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
    }
    const input = parsed.data;
    const db = await getTenantDb();

    // updateMany, not update: RLS already fences the tenant, and a `where` that
    // matches nothing is a clean "not found" instead of a thrown P2025.
    const result = await db.membership.updateMany({
      where: { id: membershipId },
      data: {
        name: input.name,
        kind: input.kind,
        price_cents: toCents(input.priceDollars),
        discount_type: input.discountType,
        discount_value:
          input.discountType === 'PERCENT'
            ? Math.round(input.discountValue)
            : toCents(input.discountValue),
        total_uses: input.kind === 'PUNCH_CARD' ? input.totalUses : null,
        duration_days: input.durationDays,
        is_active: input.isActive,
      },
    });
    if (result.count === 0) return { ok: false, error: 'Membership not found.' };

    revalidatePath('/memberships');
    revalidatePath(`/memberships/${membershipId}`);
    return { ok: true, message: 'Saved.' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

const grantSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter the customer’s email address.'),
});

/**
 * Grant a membership to a customer by email — the comp / "they paid me at the
 * dock" path. No money moves here; a paid purchase goes through the customer
 * portal, which charges and issues in one transaction.
 *
 * Looks the customer up rather than offering a picker: an operator with thousands
 * of customers cannot use a <select>, and the email is what they have in front of
 * them. RLS scopes the lookup, so this can only ever find their own customers.
 */
export async function grantMembershipAction(
  membershipId: string,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('customer:write');
    if (!membershipId) return { ok: false, error: 'Missing membership.' };

    const parsed = grantSchema.safeParse({ email: formData.get('email') });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Enter a valid email.' };
    }
    const db = await getTenantDb();

    const membership = await db.membership.findUnique({
      where: { id: membershipId },
      select: { id: true, name: true, kind: true, total_uses: true, duration_days: true, is_active: true },
    });
    if (!membership) return { ok: false, error: 'Membership not found.' };
    if (!membership.is_active) {
      return { ok: false, error: 'This membership is inactive. Reactivate it before granting one.' };
    }

    const customer = await db.customer.findUnique({
      where: { operator_id_email: { operator_id: operatorId, email: parsed.data.email } },
      select: { id: true, first_name: true, last_name: true },
    });
    if (!customer) {
      return {
        ok: false,
        error: `No customer with the email ${parsed.data.email}. They need a customer record first.`,
      };
    }

    // Mirrors issueCustomerMembership: uses only for punch cards, expiry only when
    // the product carries a duration.
    await db.customerMembership.create({
      data: {
        operator_id: operatorId,
        membership_id: membership.id,
        customer_id: customer.id,
        status: 'ACTIVE',
        remaining_uses: membership.kind === 'PUNCH_CARD' ? membership.total_uses ?? null : null,
        expires_at:
          membership.duration_days != null
            ? new Date(Date.now() + membership.duration_days * 86_400_000)
            : null,
      },
    });

    revalidatePath(`/memberships/${membershipId}`);
    revalidatePath('/memberships');
    const who = `${customer.first_name} ${customer.last_name}`.trim() || parsed.data.email;
    return { ok: true, message: `${membership.name} granted to ${who}.` };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Revoke a holding.
 *
 * `updateMany` with a status guard rather than `update`: revoking twice is a no-op
 * instead of an error, and a DEPLETED card cannot be flipped back through
 * CANCELLED into looking spendable.
 */
export async function revokeHoldingAction(
  membershipId: string,
  holdingId: string,
): Promise<ActionResult> {
  try {
    await requirePermission('customer:write');
    if (!holdingId) return { ok: false, error: 'Missing membership holder.' };
    const db = await getTenantDb();

    const result = await db.customerMembership.updateMany({
      where: { id: holdingId, status: 'ACTIVE' },
      data: { status: 'CANCELLED' },
    });

    revalidatePath(`/memberships/${membershipId}`);
    revalidatePath('/memberships');
    return result.count > 0
      ? { ok: true, message: 'Membership revoked.' }
      : { ok: false, error: 'That membership was already inactive.' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Please try again.';
}
