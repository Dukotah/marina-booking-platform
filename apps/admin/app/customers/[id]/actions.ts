'use server';

import { revalidatePath } from 'next/cache';
import { getTenantDb, requirePermission } from '../../../lib/session';

/** Result shape returned to client editors so they can show success/error inline. */
export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Max length for a customer's free-text notes (DB column is unbounded; we cap UI input). */
const MAX_NOTES_LENGTH = 5000;
/** Max length for a single tag. */
const MAX_TAG_LENGTH = 40;
/** Max number of tags per customer. */
const MAX_TAGS = 30;

/**
 * Normalize a raw tag list: trim, drop empties, clamp length, de-duplicate
 * case-insensitively (keeping first spelling), and cap total count.
 */
function normalizeTags(input: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input) {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

/** Confirm the customer exists for this tenant (RLS-scoped) before mutating. */
async function assertCustomerExists(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  customerId: string,
): Promise<boolean> {
  const found = await db.customer.findUnique({
    where: { id: customerId },
    select: { id: true },
  });
  return Boolean(found);
}

/**
 * Replace a customer's tags. Tenant-scoped (RLS) and gated on customer:write.
 */
export async function updateCustomerTags(
  customerId: string,
  tags: string[],
): Promise<ActionResult> {
  try {
    await requirePermission('customer:write');
    if (!customerId) return { ok: false, error: 'Missing customer.' };

    const db = await getTenantDb();
    if (!(await assertCustomerExists(db, customerId))) {
      return { ok: false, error: 'Customer not found.' };
    }

    const normalized = normalizeTags(Array.isArray(tags) ? tags : []);
    await db.customer.update({
      where: { id: customerId },
      data: { tags: normalized },
    });

    revalidatePath(`/customers/${customerId}`);
    revalidatePath('/customers');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Update a customer's free-text notes. Tenant-scoped (RLS) and gated on
 * customer:write. Empty/whitespace notes are stored as null.
 */
export async function updateCustomerNotes(
  customerId: string,
  notes: string,
): Promise<ActionResult> {
  try {
    await requirePermission('customer:write');
    if (!customerId) return { ok: false, error: 'Missing customer.' };

    const trimmed = (typeof notes === 'string' ? notes : '').slice(0, MAX_NOTES_LENGTH).trim();

    const db = await getTenantDb();
    if (!(await assertCustomerExists(db, customerId))) {
      return { ok: false, error: 'Customer not found.' };
    }

    await db.customer.update({
      where: { id: customerId },
      data: { notes: trimmed.length ? trimmed : null },
    });

    revalidatePath(`/customers/${customerId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'status' in err && (err as { status: unknown }).status === 403) {
    return 'You do not have permission to edit customers.';
  }
  return 'Something went wrong. Please try again.';
}
