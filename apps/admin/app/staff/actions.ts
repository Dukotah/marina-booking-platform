'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createId } from '@marina/core';
import {
  BUILTIN_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type BuiltinRole,
  type Permission,
} from '@marina/auth';
import { getTenantDb, requirePermission } from '../../lib/session';

/**
 * Server actions for the staff & roles slice. Every mutation:
 *  - requires the `staff:manage` permission (throws AuthorizationError otherwise),
 *  - runs through the tenant-scoped client (RLS enforces operator isolation), and
 *  - still writes an explicit `operator_id` where-clause as defense in depth.
 *
 * Authentication identities come from Clerk (auth_user_id). Until a member signs
 * in through Clerk we don't have their real Clerk id, so an invited member gets a
 * deterministic placeholder id ("invite:<email>") that is later reconciled to the
 * real Clerk user id on first sign-in. The unique [operator_id, auth_user_id]
 * constraint keeps that placeholder unique per operator.
 */

const roleEnum = z.enum(BUILTIN_ROLES as unknown as [BuiltinRole, ...BuiltinRole[]]);
const permissionEnum = z.enum(PERMISSIONS as unknown as [Permission, ...Permission[]]);

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  name: z.string().trim().max(120).optional(),
  role: roleEnum,
  locationIds: z.array(z.string().min(1)).default([]),
  extraPermissions: z.array(permissionEnum).default([]),
});

const updateSchema = z.object({
  staffId: z.string().min(1),
  role: roleEnum,
  locationIds: z.array(z.string().min(1)).default([]),
  extraPermissions: z.array(permissionEnum).default([]),
});

export type InviteStaffInput = z.infer<typeof inviteSchema>;
export type UpdateStaffInput = z.infer<typeof updateSchema>;

export interface ActionResult {
  ok: boolean;
  /** Field-path -> message, suitable for surfacing inline in the form. */
  errors?: Record<string, string>;
  /** General error message when not field-specific. */
  message?: string;
  /** Created/updated staff id (on success). */
  staffId?: string;
}

/** Flatten a ZodError into a `path -> message` map the client can consume. */
function zodErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'form';
    if (!(path in out)) out[path] = issue.message;
  }
  return out;
}

/** Friendly message for a thrown error (notably AuthorizationError -> 403). */
function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err && typeof err === 'object' && 'status' in err && (err as { status: unknown }).status === 403) {
    return 'You do not have permission to manage staff.';
  }
  return fallback;
}

/**
 * Drop any "extra" permissions a role already grants by default — extras only
 * make sense as additions on top of the role baseline. Also de-duplicates.
 */
function normalizeExtras(role: BuiltinRole, extras: Permission[]): Permission[] {
  const base = new Set<Permission>(ROLE_PERMISSIONS[role]);
  const seen = new Set<Permission>();
  const out: Permission[] = [];
  for (const p of extras) {
    if (base.has(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Validate that every supplied location id belongs to this operator. Returns the
 * valid subset; an explicit operator_id where-clause backs up RLS. An empty
 * scope (no locations) means "all locations" and is always allowed.
 */
async function validateLocationIds(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  operatorId: string,
  locationIds: string[],
): Promise<{ ok: boolean; valid: string[] }> {
  const unique = [...new Set(locationIds)];
  if (unique.length === 0) return { ok: true, valid: [] };
  const found = await db.location.findMany({
    where: { id: { in: unique }, operator_id: operatorId },
    select: { id: true },
  });
  return { ok: found.length === unique.length, valid: found.map((l) => l.id) };
}

/**
 * Invite/add a staff member for the current operator. Until Clerk sign-in, the
 * auth_user_id is a deterministic placeholder derived from the email.
 */
export async function inviteStaff(input: InviteStaffInput): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('staff:manage');

    const parsed = inviteSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, errors: zodErrors(parsed.error) };
    }
    const { email, name, role, locationIds, extraPermissions } = parsed.data;

    const db = await getTenantDb();

    // No two staff records may share an email within one operator.
    const dupe = await db.staffMember.findFirst({
      where: { operator_id: operatorId, email },
      select: { id: true },
    });
    if (dupe) {
      return { ok: false, errors: { email: 'A staff member with this email already exists.' } };
    }

    const locCheck = await validateLocationIds(db, operatorId, locationIds);
    if (!locCheck.ok) {
      return { ok: false, errors: { locationIds: 'One or more locations are invalid.' } };
    }

    const extras = normalizeExtras(role, extraPermissions);
    const staffId = createId();
    // Placeholder Clerk id until the member signs in and we reconcile it.
    const authUserId = `invite:${email}`;

    await db.staffMember.create({
      data: {
        id: staffId,
        operator_id: operatorId,
        auth_user_id: authUserId,
        email,
        name: name && name.length ? name : null,
        role,
        extra_permissions: extras,
        is_active: true,
        locations: locCheck.valid.length
          ? { create: locCheck.valid.map((location_id) => ({ location_id })) }
          : undefined,
      },
    });

    revalidatePath('/staff');
    return { ok: true, staffId };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * Update a staff member's role, per-location scoping, and extra permissions.
 * Replaces the full StaffLocation set to match the submitted location scope.
 */
export async function updateStaff(input: UpdateStaffInput): Promise<ActionResult> {
  try {
    const { operatorId, auth } = await requirePermission('staff:manage');

    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, errors: zodErrors(parsed.error) };
    }
    const { staffId, role, locationIds, extraPermissions } = parsed.data;

    const db = await getTenantDb();

    const existing = await db.staffMember.findFirst({
      where: { id: staffId, operator_id: operatorId },
      select: { id: true, role: true, auth_user_id: true },
    });
    if (!existing) {
      return { ok: false, message: 'Staff member not found.' };
    }

    // Guardrail: never let an operator strip the last OWNER of the owner role,
    // which would lock everyone out of operator-level settings.
    if (existing.role === 'OWNER' && role !== 'OWNER') {
      const ownerCount = await db.staffMember.count({
        where: { operator_id: operatorId, role: 'OWNER', is_active: true },
      });
      if (ownerCount <= 1) {
        return { ok: false, message: 'There must be at least one active owner.' };
      }
    }

    const locCheck = await validateLocationIds(db, operatorId, locationIds);
    if (!locCheck.ok) {
      return { ok: false, errors: { locationIds: 'One or more locations are invalid.' } };
    }

    const extras = normalizeExtras(role, extraPermissions);

    await db.staffMember.update({
      where: { id: staffId },
      data: {
        role,
        extra_permissions: extras,
        // Replace the full location scope: drop existing, recreate the submitted set.
        locations: {
          deleteMany: {},
          create: locCheck.valid.map((location_id) => ({ location_id })),
        },
      },
    });

    revalidatePath('/staff');
    return { ok: true, staffId };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * Activate/deactivate a staff member. Deactivating an owner is blocked if they
 * are the last active owner so the operator can never be locked out.
 */
export async function toggleStaffActive(staffId: string): Promise<ActionResult> {
  try {
    const { operatorId } = await requirePermission('staff:manage');
    if (!staffId) return { ok: false, message: 'Missing staff member.' };

    const db = await getTenantDb();
    const existing = await db.staffMember.findFirst({
      where: { id: staffId, operator_id: operatorId },
      select: { id: true, is_active: true, role: true },
    });
    if (!existing) return { ok: false, message: 'Staff member not found.' };

    if (existing.is_active && existing.role === 'OWNER') {
      const ownerCount = await db.staffMember.count({
        where: { operator_id: operatorId, role: 'OWNER', is_active: true },
      });
      if (ownerCount <= 1) {
        return { ok: false, message: 'There must be at least one active owner.' };
      }
    }

    await db.staffMember.update({
      where: { id: staffId },
      data: { is_active: !existing.is_active },
    });

    revalidatePath('/staff');
    return { ok: true, staffId };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}
