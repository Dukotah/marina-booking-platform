import { AuthorizationError } from '@marina/auth';
import { computeSlotStatus } from '@marina/core';
import { AdminShell } from '../../components/shell';
import { getOperatorContext, getTenantDb, requirePermission } from '../../lib/session';
import { PosTerminal } from '../../components/pos/PosTerminal';
import type {
  PosActivity,
  PosConfig,
  PosFee,
  PosMerchandise,
} from '../../components/pos/types';

export const dynamic = 'force-dynamic';

/**
 * Integrated point-of-sale screen.
 *
 * The anti-Singenuity wedge: the register lives in the same app as the dashboard
 * and manifest, behind the same login — no third app, no third password. Staff with
 * `pos:operate` can sell walk-up bookings, merchandise, and gift/misc items from one
 * cart, take cash or card, and pull up existing orders by code/QR.
 *
 * This server component loads the operator's catalog (active activities + rates +
 * today's open timeslots), merchandise, and fee config through the tenant-scoped
 * client (RLS-isolated), then hands the terminal a serializable snapshot. All money
 * math and persistence happen in server actions (./actions.ts).
 */
export default async function PosPage() {
  // Gate the whole screen on pos:operate; render a denied state instead of crashing.
  try {
    await requirePermission('pos:operate');
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return (
        <AdminShell>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-8 text-center">
            <h1 className="text-lg font-semibold text-amber-900">Register access required</h1>
            <p className="mt-1 text-sm text-amber-800">
              Your role doesn’t include permission to operate the point of sale. Ask an
              administrator for the “Operate POS” permission.
            </p>
          </div>
        </AdminShell>
      );
    }
    throw err;
  }

  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  // Working day window (operator-local server time) for surfacing today's slots.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const [operator, activityRows, merchandiseRows, feeRows, walkupCustomer] = await Promise.all([
    db.operator.findFirst({
      where: { id: operatorId },
      select: { name_external: true, name_internal: true },
    }),
    db.activity.findMany({
      where: {
        operator_id: operatorId,
        status: 'ACTIVE',
        visible_register: true,
      },
      orderBy: { sort_index: 'asc' },
      select: {
        id: true,
        name_external: true,
        category: true,
        color: true,
        max_participants: true,
        rates: {
          where: { is_active: true, online_only: false },
          orderBy: { sort_index: 'asc' },
          select: {
            id: true,
            name_external: true,
            price_cents: true,
            duration_minutes: true,
          },
        },
        timeslots: {
          where: {
            datetime: { gte: dayStart, lt: dayEnd },
            status: { not: 'CANCELLED' },
          },
          orderBy: { datetime: 'asc' },
          select: {
            id: true,
            datetime: true,
            capacity_total: true,
            capacity_booked: true,
          },
        },
      },
    }),
    db.merchandiseItem.findMany({
      where: { operator_id: operatorId, is_active: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        category: true,
        cost_cents: true,
        on_hand_qty: true,
      },
    }),
    db.fee.findMany({
      where: { operator_id: operatorId, enabled: true, activity_id: null },
      select: { name: true, type: true, value: true },
    }),
    db.customer.findFirst({
      where: { operator_id: operatorId, email: 'walk-in@register.local' },
      select: { id: true },
    }),
  ]);

  const activities: PosActivity[] = activityRows
    // Only show activities that can actually be sold (have at least one rate).
    .filter((a) => a.rates.length > 0)
    .map((a) => ({
      id: a.id,
      name: a.name_external,
      category: a.category,
      color: a.color,
      maxParticipants: a.max_participants,
      rates: a.rates.map((r) => ({
        id: r.id,
        name: r.name_external,
        priceCents: r.price_cents,
        durationMinutes: r.duration_minutes,
      })),
      timeslots: a.timeslots.map((t) => ({
        id: t.id,
        datetime: t.datetime.toISOString(),
        capacityTotal: t.capacity_total,
        capacityBooked: t.capacity_booked,
        status: computeSlotStatus(t.capacity_total, t.capacity_booked),
      })),
    }));

  const merchandise: PosMerchandise[] = merchandiseRows.map((m) => ({
    id: m.id,
    name: m.name,
    category: m.category,
    priceCents: m.cost_cents,
    onHandQty: m.on_hand_qty,
  }));

  const fees: PosFee[] = feeRows.map((f) => ({ name: f.name, type: f.type, value: f.value }));

  const config: PosConfig = {
    operatorName: operator?.name_external || operator?.name_internal || 'Register',
    defaultCustomerId: walkupCustomer?.id ?? null,
    fees,
  };

  return (
    <AdminShell>
      <PosTerminal activities={activities} merchandise={merchandise} config={config} />
    </AdminShell>
  );
}
