'use server';

import { revalidatePath } from 'next/cache';
import { AuthorizationError } from '@marina/auth';
import { getOperatorContext, getTenantDb } from '../../lib/session';

/**
 * One-click check-in for a manifest booking block. The whole point of the visual
 * manifest is that staff can run the dock from a single screen — tap a block, the
 * guest is checked in. This server action is the write half of that interaction.
 *
 * Security: every query runs through the tenant-scoped client (RLS-enforced), and
 * we re-derive the operator from the session rather than trusting client input, so
 * one operator can never mutate another's order items. We also require the
 * `order:write` permission.
 */
export interface CheckInResult {
  ok: boolean;
  status?: 'CHECKED_IN' | 'UPCOMING' | 'NO_SHOW';
  error?: string;
}

export async function checkInOrderItem(orderItemId: string): Promise<CheckInResult> {
  if (!orderItemId) return { ok: false, error: 'Missing booking id' };

  const { auth } = await getOperatorContext();
  try {
    // Staff and above may operate the manifest / check guests in.
    if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
      throw new AuthorizationError('order:write');
    }
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: 'You do not have permission to check guests in.' };
    }
    throw err;
  }

  const db = await getTenantDb();

  // Read first so we can produce an idempotent toggle and a precise audit event.
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, status: true, order_id: true },
  });

  if (!item) return { ok: false, error: 'Booking not found' };

  // Idempotent: checking in an already-checked-in item simply re-affirms it and
  // skips the redundant audit event below.
  if (item.status === 'CHECKED_IN') {
    return { ok: true, status: 'CHECKED_IN' };
  }

  await db.orderItem.update({
    where: { id: item.id },
    data: { status: 'CHECKED_IN' },
  });

  // Audit trail on the parent order so the action is reconstructable later.
  await db.orderEvent.create({
    data: {
      operator_id: auth.operatorId,
      order_id: item.order_id,
      type: 'CHECK_IN',
      description: 'Guest checked in from the day manifest',
      actor: auth.userId,
    },
  });

  revalidatePath('/manifest');
  return { ok: true, status: 'CHECKED_IN' };
}

/**
 * Undo a check-in (revert to UPCOMING). Mirrors the check-in path so a mis-tap is
 * recoverable without leaving the manifest.
 */
export async function undoCheckInOrderItem(orderItemId: string): Promise<CheckInResult> {
  if (!orderItemId) return { ok: false, error: 'Missing booking id' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to modify check-ins.' };
  }

  const db = await getTenantDb();
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, status: true, order_id: true },
  });
  if (!item) return { ok: false, error: 'Booking not found' };

  await db.orderItem.update({
    where: { id: item.id },
    data: { status: 'UPCOMING' },
  });

  await db.orderEvent.create({
    data: {
      operator_id: auth.operatorId,
      order_id: item.order_id,
      type: 'CHECK_IN_UNDO',
      description: 'Check-in reverted from the day manifest',
      actor: auth.userId,
    },
  });

  revalidatePath('/manifest');
  return { ok: true, status: 'UPCOMING' };
}

/**
 * Mark a booking as a no-show (guest never arrived). Frees nothing (the slot is
 * past), but records it for reporting and lets staff clear the manifest. Idempotent.
 */
export async function markNoShowOrderItem(orderItemId: string): Promise<CheckInResult> {
  if (!orderItemId) return { ok: false, error: 'Missing booking id' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to modify the manifest.' };
  }

  const db = await getTenantDb();
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, status: true, order_id: true },
  });
  if (!item) return { ok: false, error: 'Booking not found' };
  if (item.status === 'NO_SHOW') return { ok: true, status: 'NO_SHOW' };

  await db.orderItem.update({ where: { id: item.id }, data: { status: 'NO_SHOW' } });
  await db.orderEvent.create({
    data: {
      operator_id: auth.operatorId,
      order_id: item.order_id,
      type: 'NO_SHOW',
      description: 'Marked no-show from the day manifest',
      actor: auth.userId,
    },
  });

  revalidatePath('/manifest');
  return { ok: true, status: 'NO_SHOW' };
}

/** Revert a no-show back to UPCOMING (mis-tap recovery). */
export async function undoNoShowOrderItem(orderItemId: string): Promise<CheckInResult> {
  if (!orderItemId) return { ok: false, error: 'Missing booking id' };

  const { auth } = await getOperatorContext();
  if (!effectiveCanWrite(auth.role, auth.extraPermissions)) {
    return { ok: false, error: 'You do not have permission to modify the manifest.' };
  }

  const db = await getTenantDb();
  const item = await db.orderItem.findUnique({
    where: { id: orderItemId },
    select: { id: true, status: true, order_id: true },
  });
  if (!item) return { ok: false, error: 'Booking not found' };

  await db.orderItem.update({ where: { id: item.id }, data: { status: 'UPCOMING' } });
  await db.orderEvent.create({
    data: {
      operator_id: auth.operatorId,
      order_id: item.order_id,
      type: 'NO_SHOW_UNDO',
      description: 'No-show reverted from the day manifest',
      actor: auth.userId,
    },
  });

  revalidatePath('/manifest');
  return { ok: true, status: 'UPCOMING' };
}

/**
 * Local permission check mirroring @marina/auth.hasPermission but driven directly
 * off the role/extras already on the session context (avoids constructing a full
 * AuthContext for a single check). `order:write` is held by OWNER/ADMIN/MANAGER/STAFF.
 */
function effectiveCanWrite(role: string, extra: string[]): boolean {
  if (extra.includes('order:write')) return true;
  return role === 'OWNER' || role === 'ADMIN' || role === 'MANAGER' || role === 'STAFF';
}
