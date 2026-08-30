import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createId, assertCents } from '@marina/core';
import { AuthorizationError } from '@marina/auth';
import { withTenant } from '@marina/database';
import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import {
  AddOnEditor,
  type ActivityOption,
  type AddOnActionResult,
  type AddOnFormInput,
  type AddOnRow,
} from '../../../components/settings/AddOnEditor';

export const dynamic = 'force-dynamic';

/**
 * Settings → Add-ons. The operator defines the extras a guest can add at
 * checkout (life jackets, coolers, tubes, photo packages, fuel), per activity or
 * globally, priced per guest or per booking, with an optional hard stock limit.
 *
 * Per D-007 the admin app talks to the database directly through the
 * tenant-scoped path rather than via the API. The add-on catalog lives in
 * `PackageUpsell`, which carries columns the checked-in Prisma client predates
 * (see the migration in the hand-off notes), so the reads and writes below use
 * parameterized SQL on a `withTenant` transaction — as `app_user`, with
 * `app.current_operator_id` set, so RLS scopes them exactly as a Prisma call
 * would. `operator_id` is asserted in every WHERE as defence in depth.
 *
 * `forOperator()` is deliberately NOT used for the raw statements: its extension
 * wraps model operations only, so a raw query through it would run without the
 * GUC set.
 */

/** The raw row shape the SELECT below returns. */
interface UpsellRow {
  id: string;
  activity_id: string | null;
  name: string;
  description: string | null;
  price_cents: number;
  per_guest: boolean;
  max_per_booking: number | null;
  stock_total: number | null;
  stock_sold: number;
  is_active: boolean;
  sort_index: number;
}

/** Fixed literal — no request value ever reaches a query string. */
const COLUMNS =
  'id, activity_id, name, description, price_cents, per_guest, max_per_booking, stock_total, stock_sold, is_active, sort_index';

function toRow(row: UpsellRow): AddOnRow {
  return {
    id: row.id,
    activityId: row.activity_id,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    basis: row.per_guest ? 'PER_GUEST' : 'PER_BOOKING',
    maxPerBooking: row.max_per_booking,
    stockTotal: row.stock_total,
    stockSold: Number(row.stock_sold),
    isActive: row.is_active,
    sortIndex: row.sort_index,
  };
}

/**
 * Server-side validation. The client form already checks these, but a server
 * action is its own HTTP endpoint — the form is a convenience, not the gate.
 */
const addOnSchema = z.object({
  activityId: z.string().min(1).nullable(),
  name: z.string().trim().min(1, 'Give the add-on a name.').max(120),
  description: z.string().trim().max(500).nullable(),
  priceCents: z.number().int().nonnegative('The price cannot be negative.'),
  basis: z.enum(['PER_GUEST', 'PER_BOOKING']),
  maxPerBooking: z.number().int().positive().nullable(),
  stockTotal: z.number().int().nonnegative().nullable(),
  isActive: z.boolean(),
  sortIndex: z.number().int().nonnegative(),
});

/**
 * Create or update an add-on.
 *
 * `stock_sold` is never written here: it is a ledger of what is on real orders
 * and only the booking and cancellation paths may move it. Lowering the stock
 * limit below what is already sold is refused by the UPDATE's own WHERE clause
 * rather than clamped, because an operator who types 2 when 5 are sold needs to
 * be told, not to have three guests' coolers quietly vanish.
 */
async function saveAddOn(id: string | null, input: AddOnFormInput): Promise<AddOnActionResult> {
  'use server';
  try {
    const ctx = await requirePermission('operator:manage');
    const parsed = addOnSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? 'That add-on is not valid.' };
    }
    const v = parsed.data;
    assertCents(v.priceCents, 'price');
    // A per-guest add-on's quantity IS the party size, so a per-booking cap is
    // meaningless on it; store null rather than a value nothing reads.
    const maxPerBooking = v.basis === 'PER_GUEST' ? null : v.maxPerBooking;

    // An activity-scoped add-on must name an activity that belongs to this
    // tenant. RLS already guarantees it, but the friendly failure beats an FK error.
    if (v.activityId) {
      const db = await getTenantDb();
      const activity = await db.activity.findUnique({ where: { id: v.activityId }, select: { id: true } });
      if (!activity) return { ok: false, message: 'That activity no longer exists.' };
    }

    const outcome = await withTenant(ctx.operatorId, async (tx) => {
      if (id === null) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "PackageUpsell"
             (id, operator_id, activity_id, name, description, price_cents,
              per_guest, max_per_booking, stock_total, stock_sold, is_active, sort_index, created_at)
           VALUES ($11, $1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, now())`,
          ctx.operatorId,
          v.activityId,
          v.name,
          v.description,
          v.priceCents,
          v.basis === 'PER_GUEST',
          maxPerBooking,
          v.stockTotal,
          v.isActive,
          v.sortIndex,
          // Prisma's `@default(cuid())` is applied by the client, not by
          // Postgres, so a raw INSERT supplies its own id.
          createId(),
        );
        return 'created' as const;
      }

      const affected = await tx.$executeRawUnsafe(
        `UPDATE "PackageUpsell"
            SET activity_id = $3, name = $4, description = $5, price_cents = $6,
                per_guest = $7, max_per_booking = $8, stock_total = $9,
                is_active = $10, sort_index = $11
          WHERE id = $2 AND operator_id = $1
            AND ($9 IS NULL OR stock_sold <= $9)`,
        ctx.operatorId,
        id,
        v.activityId,
        v.name,
        v.description,
        v.priceCents,
        v.basis === 'PER_GUEST',
        maxPerBooking,
        v.stockTotal,
        v.isActive,
        v.sortIndex,
      );
      if (affected > 0) return 'updated' as const;

      // Nothing matched: either the add-on is gone, or the new stock limit sits
      // below what is already on orders. Say which.
      const current = await tx.$queryRawUnsafe<Array<{ stock_sold: number }>>(
        `SELECT stock_sold FROM "PackageUpsell" WHERE id = $2 AND operator_id = $1`,
        ctx.operatorId,
        id,
      );
      const sold = current[0]?.stock_sold;
      if (sold === undefined) return 'missing' as const;
      return { conflict: Number(sold) } as const;
    });

    if (outcome === 'missing') return { ok: false, message: 'That add-on no longer exists.' };
    if (typeof outcome === 'object') {
      return {
        ok: false,
        message: `${outcome.conflict} of these are already on orders, so the stock limit cannot go below ${outcome.conflict}.`,
      };
    }

    revalidatePath('/settings/addons');
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, message: 'You do not have permission to manage settings.' };
    }
    throw err;
  }
}

/**
 * Delete an add-on that has never sold; retire one that has.
 *
 * A sold add-on is referenced by `OrderItem.add_on_id`, and deleting it would
 * either break that reference or orphan the history a receipt, a refund and a
 * tax report are read from. The message tells the operator which happened.
 */
async function removeAddOn(id: string): Promise<AddOnActionResult> {
  'use server';
  try {
    const ctx = await requirePermission('operator:manage');
    const outcome = await withTenant(ctx.operatorId, async (tx) => {
      const used = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM "OrderItem" WHERE operator_id = $1 AND add_on_id = $2`,
        ctx.operatorId,
        id,
      );
      if (Number(used[0]?.count ?? 0) > 0) {
        const affected = await tx.$executeRawUnsafe(
          `UPDATE "PackageUpsell" SET is_active = false WHERE id = $2 AND operator_id = $1`,
          ctx.operatorId,
          id,
        );
        return affected > 0 ? ('retired' as const) : ('missing' as const);
      }
      const affected = await tx.$executeRawUnsafe(
        `DELETE FROM "PackageUpsell" WHERE id = $2 AND operator_id = $1`,
        ctx.operatorId,
        id,
      );
      return affected > 0 ? ('deleted' as const) : ('missing' as const);
    });

    if (outcome === 'missing') return { ok: false, message: 'That add-on no longer exists.' };
    revalidatePath('/settings/addons');
    return {
      ok: true,
      message:
        outcome === 'retired'
          ? 'Retired — it stays on the orders that already have it, and is no longer offered.'
          : 'Deleted.',
    };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, message: 'You do not have permission to manage settings.' };
    }
    throw err;
  }
}

export default async function AddOnsSettingsPage() {
  const ctx = await requirePermission('operator:manage');
  const db = await getTenantDb();

  const [rows, activities] = await Promise.all([
    withTenant(ctx.operatorId, (tx) =>
      tx.$queryRawUnsafe<UpsellRow[]>(
        `SELECT ${COLUMNS} FROM "PackageUpsell"
          WHERE operator_id = $1
          ORDER BY sort_index ASC, name ASC`,
        ctx.operatorId,
      ),
    ),
    db.activity.findMany({
      orderBy: { name_internal: 'asc' },
      select: { id: true, name_internal: true },
    }),
  ]);

  const addOns: AddOnRow[] = rows.map(toRow);
  const activityOptions: ActivityOption[] = activities.map((a) => ({
    id: a.id,
    name: a.name_internal,
  }));

  return (
    <>
      <PageHeader
        title="Add-ons"
        description="Extras a guest can add at checkout. High margin, and the guest is already committed."
      />
      <AddOnEditor
        addOns={addOns}
        activities={activityOptions}
        onSave={saveAddOn}
        onDelete={removeAddOn}
      />
    </>
  );
}
