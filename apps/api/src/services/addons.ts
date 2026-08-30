/**
 * Add-ons / upsells — the operator's high-margin extras (life jackets, coolers,
 * tubes, photo packages, fuel) offered to a guest who is already at checkout.
 *
 * The single most important thing about this module is what it does NOT do: it
 * does not have a pricing path. An add-on becomes an extra `PricingItem` fed
 * into the same `calculatePricing` call the seats go through, and an extra
 * `OrderItem` row on the same order. There is one subtotal, one tax
 * calculation, one processing fee, one total, and one refundable amount —
 * add-ons ride them, they do not get their own.
 *
 * TAX AND FEES — what the existing fee logic actually does with an add-on
 * ----------------------------------------------------------------------
 * `@marina/core/pricing.ts` has exactly one taxable base:
 *
 *     taxable = subtotal - discount + FLAT fees + PERCENT surcharges
 *     tax     = taxable * taxPct          (0 when the order is tax-exempt)
 *     proc    = (taxable + tax) * procPct
 *
 * There is no per-line tax flag anywhere in the engine — the only exemption knob
 * is the order-level `taxExempt`. So the moment an add-on is a `PricingItem`:
 *
 *   - it IS taxed, at the operator's single configured "Tax" percent fee;
 *   - it DOES enlarge the processing-fee base;
 *   - it IS reduced by a PERCENT promo (the discount applies to the whole
 *     subtotal, not to the seat lines only);
 *   - it DOES enlarge a deposit, since the deposit is a percent of the total.
 *
 * That is the correct answer for the products actually in scope here. A rented
 * cooler, a life-jacket rental, a photo package and fuel are all taxable in
 * California, and taxing them at the same rate as the trip is what an operator's
 * remittance report needs to balance. Making an individual add-on tax-free would
 * require a `tax_exempt` column here AND a per-item tax flag in
 * `calculatePricing`; that is deliberately out of scope and noted in the report.
 *
 * STOCK — why the check survives two guests buying the last one at once
 * ---------------------------------------------------------------------
 * `reserveAddOnStock` never reads a count and then writes it. It issues a single
 * conditional UPDATE whose WHERE clause carries the invariant, and treats
 * "0 rows affected" as sold out. See the comment on that function for why
 * READ COMMITTED makes that airtight where a check-then-write is not.
 *
 * SCHEMA — this module needs columns the checked-in Prisma client predates
 * -----------------------------------------------------------------------
 * The migration is listed in the hand-off report (nullable `activity_id`,
 * `per_guest`, `max_per_booking`, `stock_total`, `stock_sold` on `PackageUpsell`;
 * `add_on_id` + `add_on_name` on `OrderItem`). Until the orchestrator applies it
 * and regenerates the client, those columns do not exist on the generated
 * delegates — so every read/write of the add-on catalog here goes through
 * parameterized SQL rather than a cast that would lie to the type system. The
 * SQL runs on the tenant transaction client, as `app_user`, with
 * `app.current_operator_id` already set, so RLS scopes it exactly as a Prisma
 * call would; `operator_id` is also asserted in every WHERE as defence in depth.
 */
import type { Prisma } from '@marina/database';
import { withTenant } from '@marina/database';
import { allocate, assertCents, createId, sumCents, type PricingItem } from '@marina/core';

/** A typed, user-facing failure route handlers map to a clean HTTP status. */
export class AddOnError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'AddOnError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Domain shapes
// ---------------------------------------------------------------------------

/**
 * How an add-on's quantity is decided.
 *
 *   - `PER_GUEST`   — one per person on the booking. The guest opts in or out;
 *                     the quantity is the party size and is not theirs to set.
 *                     "Life jacket, $12 per guest."
 *   - `PER_BOOKING` — a countable thing the guest picks a number of, capped by
 *                     `maxPerBooking` when set. "Cooler, $25 each."
 */
export type AddOnBasis = 'PER_GUEST' | 'PER_BOOKING';

/** One add-on as the operator defined it. All money is integer cents. */
export interface AddOnDefinition {
  id: string;
  /** Null = offered on every activity (a global add-on, e.g. fuel). */
  activityId: string | null;
  name: string;
  description: string | null;
  priceCents: number;
  basis: AddOnBasis;
  /** Per-booking cap on quantity. Null = no cap beyond stock. */
  maxPerBooking: number | null;
  /** Total units sellable for the whole season. Null = unlimited. */
  stockTotal: number | null;
  /** Units already committed to orders. Never exceeds `stockTotal`. */
  stockSold: number;
  isActive: boolean;
  sortIndex: number;
}

/** An add-on offered to a guest, with the stock arithmetic already done. */
export interface OfferedAddOn extends AddOnDefinition {
  /** `stockTotal - stockSold`, or null when stock is not tracked. */
  remainingStock: number | null;
  /** The largest quantity this guest may take right now (0 = sold out). */
  maxSelectable: number;
}

/** What the guest chose: an add-on id and how many (per-guest sends 1 or 0). */
export interface AddOnSelection {
  addOnId: string;
  quantity: number;
}

/** A priced add-on line, ready to become both a PricingItem and an OrderItem. */
export interface PricedAddOnLine {
  addOnId: string;
  /** Name snapshotted onto the order so a later rename cannot rewrite history. */
  name: string;
  basis: AddOnBasis;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

// ---------------------------------------------------------------------------
// Pure logic — no DB, no clock. Everything below this line is unit-tested.
// ---------------------------------------------------------------------------

/** Units still sellable, or null when the operator did not cap stock. */
export function remainingStock(def: AddOnDefinition): number | null {
  if (def.stockTotal === null) return null;
  return Math.max(0, def.stockTotal - def.stockSold);
}

/**
 * The largest quantity a guest may select of this add-on right now.
 *
 * A PER_GUEST add-on is a yes/no for the whole party, so its ceiling is the
 * party size — but it still consumes one unit of stock per guest, which is why
 * a party of six cannot take a per-guest add-on with four left. Selling four of
 * six would put staff on the dock one short at the counter, which is worse than
 * not offering it.
 */
export function maxSelectableQuantity(def: AddOnDefinition, guestCount: number): number {
  const guests = Math.max(0, Math.trunc(guestCount));
  if (!def.isActive) return 0;
  const stock = remainingStock(def);

  if (def.basis === 'PER_GUEST') {
    if (guests === 0) return 0;
    if (stock !== null && stock < guests) return 0;
    return guests;
  }

  let cap = def.maxPerBooking !== null ? Math.max(0, def.maxPerBooking) : Number.MAX_SAFE_INTEGER;
  if (stock !== null) cap = Math.min(cap, stock);
  return Math.max(0, cap);
}

/** Decorate a definition with the stock arithmetic the UI needs. */
export function toOfferedAddOn(def: AddOnDefinition, guestCount: number): OfferedAddOn {
  return {
    ...def,
    remainingStock: remainingStock(def),
    maxSelectable: maxSelectableQuantity(def, guestCount),
  };
}

/**
 * The quantity a selection actually resolves to.
 *
 * PER_GUEST collapses any positive request to the whole party — the guest
 * toggled it on, and "on" means one each. PER_BOOKING is clamped into
 * `[0, maxSelectable]`. Never trusted from the client: the server re-runs this
 * against the definitions it just read from the database.
 */
export function resolveQuantity(
  def: AddOnDefinition,
  requestedQuantity: number,
  guestCount: number,
): number {
  const requested = Number.isFinite(requestedQuantity) ? Math.trunc(requestedQuantity) : 0;
  if (requested <= 0) return 0;
  const ceiling = maxSelectableQuantity(def, guestCount);
  if (ceiling === 0) return 0;
  return def.basis === 'PER_GUEST' ? ceiling : Math.min(requested, ceiling);
}

/**
 * Price a set of guest selections against the operator's definitions.
 *
 * Selections naming an unknown, inactive or sold-out add-on resolve to a
 * quantity of 0 and are dropped rather than failing the checkout — the guest's
 * seats are the thing that matters, and an add-on that went out of stock while
 * they filled in the waiver should not lose them the booking. `strict` flips
 * that for the callers that need a hard answer (the admin re-pricing an order).
 *
 * Output order follows the definitions' `sortIndex`, so the line items on the
 * order read in the same order the guest saw them at checkout.
 */
export function priceAddOnSelections(
  definitions: readonly AddOnDefinition[],
  selections: readonly AddOnSelection[],
  guestCount: number,
  options: { strict?: boolean } = {},
): PricedAddOnLine[] {
  const byId = new Map(definitions.map((d) => [d.id, d]));
  // Collapse duplicate ids: a client that sends the same add-on twice means one
  // selection of the summed quantity, not two lines that each pass the cap.
  const merged = new Map<string, number>();
  for (const sel of selections) {
    const def = byId.get(sel.addOnId);
    if (!def) {
      if (options.strict) {
        throw new AddOnError('ADD_ON_NOT_FOUND', `Add-on ${sel.addOnId} is not available.`, 404);
      }
      continue;
    }
    merged.set(sel.addOnId, (merged.get(sel.addOnId) ?? 0) + Math.max(0, Math.trunc(sel.quantity)));
  }

  const lines: PricedAddOnLine[] = [];
  for (const def of definitions) {
    const requested = merged.get(def.id);
    if (requested === undefined) continue;
    const quantity = resolveQuantity(def, requested, guestCount);
    if (quantity === 0) {
      if (options.strict) {
        throw new AddOnError(
          'ADD_ON_UNAVAILABLE',
          `${def.name} is no longer available in that quantity.`,
          409,
        );
      }
      continue;
    }
    const unitPriceCents = assertCents(def.priceCents, `${def.name} price`);
    lines.push({
      addOnId: def.id,
      name: def.name,
      basis: def.basis,
      unitPriceCents,
      quantity,
      lineTotalCents: unitPriceCents * quantity,
    });
  }
  return lines;
}

/**
 * The add-on lines as `PricingItem`s, to be appended to the seat line before
 * `calculatePricing` runs. This is the whole integration: there is no second
 * pricing call and no add-on-specific tax maths.
 */
export function addOnPricingItems(lines: readonly PricedAddOnLine[]): PricingItem[] {
  return lines.map((l) => ({ unitPriceCents: l.unitPriceCents, quantity: l.quantity }));
}

/** Sum of the add-on lines, in integer cents. Validates every term. */
export function addOnSubtotalCents(lines: readonly PricedAddOnLine[]): number {
  return sumCents(
    lines.map((l) => l.lineTotalCents),
    'addOnLineTotal',
  );
}

/**
 * The fields an add-on's `OrderItem` row carries.
 *
 * An add-on line reuses the booking's activity / rate / timeslot because those
 * columns are NOT NULL and because it is genuinely true: the cooler belongs to
 * that trip on that boat at that time, which is exactly what the manifest needs
 * in order to tell the dock a cooler is owed. `add_on_id` is what separates it
 * from a seat line — see `isAddOnItem` and the hand-off report for the guards
 * every guest-count and capacity reader needs.
 */
export interface AddOnOrderItemData {
  activity_id: string;
  rate_id: string;
  timeslot_id: string;
  quantity: number;
  unit_price_cents: number;
  status: 'UPCOMING';
  add_on_id: string;
  add_on_name: string;
}

/**
 * Build the nested-create payloads for an order's add-on lines.
 *
 * Deliberately returns plain data rather than writing anything: these rows are
 * created by `booking.ts` inside the SAME `items: { create: [...] }` as the seat
 * line, so the whole order is one insert and a rolled-back booking leaves no
 * orphan add-on. `operator_id` is absent on purpose — the item inherits it from
 * the order through the tenant-composite relation (D-011).
 */
export function buildAddOnOrderItems(
  lines: readonly PricedAddOnLine[],
  context: { activityId: string; rateId: string; timeslotId: string },
): AddOnOrderItemData[] {
  return lines.map((l) => ({
    activity_id: context.activityId,
    rate_id: context.rateId,
    timeslot_id: context.timeslotId,
    quantity: l.quantity,
    unit_price_cents: l.unitPriceCents,
    status: 'UPCOMING' as const,
    add_on_id: l.addOnId,
    // Snapshot: renaming "Cooler" to "Cooler (large)" next season must not
    // rewrite what a guest bought last August, on their receipt or on a report.
    add_on_name: l.name,
  }));
}

/** The shape every OrderItem reader needs to tell a seat line from an add-on. */
export interface AddOnDiscriminated {
  add_on_id?: string | null;
}

/**
 * True when an order item is an add-on rather than a booked seat.
 *
 * Every reader that sums `quantity` as a guest count, or that moves timeslot
 * capacity, must exclude these — a cooler is not a person and does not occupy a
 * seat. The hand-off report lists each call site.
 */
export function isAddOnItem(item: AddOnDiscriminated): boolean {
  return item.add_on_id != null;
}

/** True for a booked seat (the complement of {@link isAddOnItem}). */
export function isSeatItem(item: AddOnDiscriminated): boolean {
  return !isAddOnItem(item);
}

/** Guests on an order: seat lines only, add-ons excluded. */
export function seatCount(items: readonly (AddOnDiscriminated & { quantity: number })[]): number {
  return items.reduce((sum, item) => (isSeatItem(item) ? sum + item.quantity : sum), 0);
}

/**
 * What refunding ONE line of an order is worth, tax and fees included.
 *
 * A line's subtotal is not what the guest paid for it: the order carries tax, a
 * processing fee and possibly a discount on top, and a $25 cooler on a taxed
 * order cost more than $25. Refunding the bare subtotal quietly keeps the tax
 * the operator never owed.
 *
 * So the refundable amount is the line's share of the order TOTAL, allocated by
 * line subtotal with `allocate` — largest remainder, so the shares of every line
 * sum to exactly the order total and refunding every line in turn returns
 * exactly what was charged, never a penny more or less. The tip is excluded
 * because it belongs to the crew and is not attributable to a cooler.
 *
 * @param lineSubtotals every line's `unit_price_cents * quantity`, in order.
 * @param index which line is being refunded.
 * @param orderTotalCents the order's `total_cents`.
 * @param orderTipCents the order's `tip_cents`, held back from the split.
 */
export function lineRefundCents(
  lineSubtotals: readonly number[],
  index: number,
  orderTotalCents: number,
  orderTipCents = 0,
): number {
  assertCents(orderTotalCents, 'orderTotalCents');
  assertCents(orderTipCents, 'orderTipCents');
  if (index < 0 || index >= lineSubtotals.length) {
    throw new AddOnError('LINE_OUT_OF_RANGE', `No line at index ${index}.`);
  }
  const refundable = Math.max(0, orderTotalCents - orderTipCents);
  const shares = allocate(refundable, lineSubtotals.map((c) => assertCents(c, 'lineSubtotal')));
  return shares[index]!;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** The raw row shape the catalog SELECTs below return. */
interface AddOnRow {
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

/** Map a raw catalog row onto the domain shape. */
function toDefinition(row: AddOnRow): AddOnDefinition {
  return {
    id: row.id,
    activityId: row.activity_id,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    basis: row.per_guest ? 'PER_GUEST' : 'PER_BOOKING',
    maxPerBooking: row.max_per_booking,
    stockTotal: row.stock_total,
    // Postgres returns integers as numbers here; guard anyway so a driver change
    // cannot turn a stock count into a string that compares wrong.
    stockSold: Number(row.stock_sold),
    isActive: row.is_active,
    sortIndex: row.sort_index,
  };
}

/**
 * The SELECT list every catalog read shares, as a constant. Factored out so the
 * column set cannot drift between reads. It is a fixed literal — no value from a
 * request ever reaches a query string; every one of those is a bound parameter.
 */
const ADD_ON_COLUMNS = [
  'id',
  'activity_id',
  'name',
  'description',
  'price_cents',
  'per_guest',
  'max_per_booking',
  'stock_total',
  'stock_sold',
  'is_active',
  'sort_index',
].join(', ');

/**
 * Any client that can run raw SQL. Always a client inside `withTenant` — the
 * `forOperator` extension only wraps MODEL operations, so a raw query issued
 * through it would run without `app.current_operator_id` set and RLS would (
 * correctly) return nothing. Every caller here therefore opens a transaction.
 */
type RawClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

/**
 * Load the add-ons offered for an activity: the ones scoped to it plus the
 * operator's global ones. Active only — the customer catalog never sees a
 * retired add-on.
 */
export async function listAddOnsForActivity(
  db: RawClient,
  operatorId: string,
  activityId: string,
): Promise<AddOnDefinition[]> {
  const rows = await db.$queryRawUnsafe<AddOnRow[]>(
    `SELECT ${ADD_ON_COLUMNS} FROM "PackageUpsell"
      WHERE operator_id = $1
        AND is_active = true
        AND (activity_id = $2 OR activity_id IS NULL)
      ORDER BY sort_index ASC, name ASC`,
    operatorId,
    activityId,
  );
  return rows.map(toDefinition);
}

/** Load specific add-ons by id, for validating a submitted selection. */
export async function loadAddOnsByIds(
  db: RawClient,
  operatorId: string,
  ids: readonly string[],
): Promise<AddOnDefinition[]> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRawUnsafe<AddOnRow[]>(
    `SELECT ${ADD_ON_COLUMNS} FROM "PackageUpsell"
      WHERE operator_id = $1 AND id = ANY($2::text[])
      ORDER BY sort_index ASC, name ASC`,
    operatorId,
    [...ids],
  );
  return rows.map(toDefinition);
}

/** The whole catalog, active and retired, for the operator's settings screen. */
export async function listAllAddOns(operatorId: string): Promise<AddOnDefinition[]> {
  return withTenant(operatorId, async (tx) => {
    const rows = await tx.$queryRawUnsafe<AddOnRow[]>(
      `SELECT ${ADD_ON_COLUMNS} FROM "PackageUpsell"
        WHERE operator_id = $1
        ORDER BY sort_index ASC, name ASC`,
      operatorId,
    );
    return rows.map(toDefinition);
  });
}

/**
 * The add-ons a guest may pick from for one activity and party size, priced and
 * with the stock arithmetic resolved. This is what the checkout page renders.
 */
export async function offerAddOns(
  operatorId: string,
  activityId: string,
  guestCount: number,
): Promise<OfferedAddOn[]> {
  const defs = await withTenant(operatorId, (tx) =>
    listAddOnsForActivity(tx, operatorId, activityId),
  );
  return defs.map((d) => toOfferedAddOn(d, guestCount));
}

// --- Writes ----------------------------------------------------------------

/** Operator-supplied add-on definition (already validated by the route/action). */
export interface AddOnInput {
  activityId: string | null;
  name: string;
  description: string | null;
  priceCents: number;
  basis: AddOnBasis;
  maxPerBooking: number | null;
  stockTotal: number | null;
  isActive: boolean;
  sortIndex: number;
}

/**
 * Create an add-on. `stock_sold` starts at 0 and is only ever moved by
 * {@link reserveAddOnStock} / {@link releaseAddOnStock}, never by an edit.
 */
export async function createAddOn(
  operatorId: string,
  input: AddOnInput,
): Promise<AddOnDefinition> {
  assertCents(input.priceCents, 'priceCents');
  return withTenant(operatorId, async (tx) => {
    const rows = await tx.$queryRawUnsafe<AddOnRow[]>(
      `INSERT INTO "PackageUpsell"
         (id, operator_id, activity_id, name, description, price_cents,
          per_guest, max_per_booking, stock_total, stock_sold, is_active, sort_index, created_at)
       VALUES ($11, $1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, now())
       RETURNING ${ADD_ON_COLUMNS}`,
      operatorId,
      input.activityId,
      input.name,
      input.description,
      input.priceCents,
      input.basis === 'PER_GUEST',
      input.maxPerBooking,
      input.stockTotal,
      input.isActive,
      input.sortIndex,
      // Application-generated id: Prisma's `@default(cuid())` is applied by the
      // client, not by Postgres, so a raw INSERT has to supply one. `createId`
      // is the platform's single id generator (@marina/core/ids).
      createId(),
    );
    const row = rows[0];
    if (!row) throw new AddOnError('CREATE_FAILED', 'Could not create the add-on.', 500);
    return toDefinition(row);
  });
}

/**
 * Update an add-on's definition.
 *
 * Lowering `stock_total` below what is already sold is refused rather than
 * silently clamped: those units are on real orders, and an operator who types 2
 * when 5 are sold needs to be told, not to have three guests' coolers vanish.
 */
export async function updateAddOn(
  operatorId: string,
  addOnId: string,
  input: AddOnInput,
): Promise<AddOnDefinition> {
  assertCents(input.priceCents, 'priceCents');
  return withTenant(operatorId, async (tx) => {
    const rows = await tx.$queryRawUnsafe<AddOnRow[]>(
      `UPDATE "PackageUpsell"
          SET activity_id = $3, name = $4, description = $5, price_cents = $6,
              per_guest = $7, max_per_booking = $8, stock_total = $9,
              is_active = $10, sort_index = $11
        WHERE id = $2 AND operator_id = $1
          AND ($9 IS NULL OR stock_sold <= $9)
        RETURNING ${ADD_ON_COLUMNS}`,
      operatorId,
      addOnId,
      input.activityId,
      input.name,
      input.description,
      input.priceCents,
      input.basis === 'PER_GUEST',
      input.maxPerBooking,
      input.stockTotal,
      input.isActive,
      input.sortIndex,
    );
    const row = rows[0];
    if (row) return toDefinition(row);

    // Distinguish "no such add-on" from "the new stock limit is below what is
    // already sold" — the operator needs different words for each.
    const existing = await loadAddOnsByIds(tx, operatorId, [addOnId]);
    const current = existing[0];
    if (!current) throw new AddOnError('NOT_FOUND', 'Add-on not found.', 404);
    throw new AddOnError(
      'STOCK_BELOW_SOLD',
      `${current.stockSold} of these are already on orders, so the stock limit cannot be set below ${current.stockSold}.`,
      409,
    );
  });
}

/**
 * Delete an add-on that has never sold; retire (deactivate) one that has.
 *
 * A sold add-on is referenced by `OrderItem.add_on_id`, and deleting it would
 * either break the FK or orphan the history a refund and a tax report depend
 * on. Returns which of the two happened so the UI can say so.
 */
export async function deleteAddOn(
  operatorId: string,
  addOnId: string,
): Promise<{ deleted: boolean }> {
  return withTenant(operatorId, async (tx) => {
    const inUse = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "OrderItem"
        WHERE operator_id = $1 AND add_on_id = $2`,
      operatorId,
      addOnId,
    );
    const used = Number(inUse[0]?.count ?? 0) > 0;
    if (used) {
      const affected = await tx.$executeRawUnsafe(
        `UPDATE "PackageUpsell" SET is_active = false WHERE id = $2 AND operator_id = $1`,
        operatorId,
        addOnId,
      );
      if (affected === 0) throw new AddOnError('NOT_FOUND', 'Add-on not found.', 404);
      return { deleted: false };
    }
    const affected = await tx.$executeRawUnsafe(
      `DELETE FROM "PackageUpsell" WHERE id = $2 AND operator_id = $1`,
      operatorId,
      addOnId,
    );
    if (affected === 0) throw new AddOnError('NOT_FOUND', 'Add-on not found.', 404);
    return { deleted: true };
  });
}

// --- Stock ------------------------------------------------------------------

/**
 * Commit stock for the add-ons on one booking. Call INSIDE the booking's
 * transaction, before the order is created.
 *
 * Why two guests cannot both buy the last cooler
 * ----------------------------------------------
 * The check and the write are ONE statement, and the invariant lives in the
 * WHERE clause:
 *
 *     UPDATE ... SET stock_sold = stock_sold + q
 *      WHERE ... AND (stock_total IS NULL OR stock_sold + q <= stock_total)
 *
 * Guest A and guest B submit at the same instant. Both statements target the
 * same row; Postgres grants A the row lock and B blocks. When A's transaction
 * commits, B does not proceed on the snapshot it started with — under READ
 * COMMITTED an UPDATE that unblocks re-reads the newly committed row version and
 * **re-evaluates its WHERE clause against it**. B therefore sees
 * `stock_sold = 1` (A's), its predicate `1 + 1 <= 1` fails, it matches zero
 * rows, and this function raises ADD_ON_SOLD_OUT. If A rolls back instead, B's
 * re-evaluation sees the original row and succeeds. Either way exactly one of
 * them gets the cooler.
 *
 * That is precisely what a `SELECT remaining` followed by an `UPDATE` cannot
 * promise: both readers see 1 remaining in their own snapshots and both write.
 * It is also why this is not `{ increment: q }` — an unconditional increment has
 * no invariant at all and simply oversells.
 *
 * Two further guards:
 *   - the migration adds `CHECK (stock_sold >= 0 AND (stock_total IS NULL OR
 *     stock_sold <= stock_total))`, so even a future code path that forgets this
 *     function fails loudly instead of overselling;
 *   - reservations are applied in a deterministic order (by add-on id), so two
 *     orders taking the same two add-ons acquire the row locks in the same
 *     sequence and cannot deadlock against each other.
 */
export async function reserveAddOnStock(
  tx: RawClient,
  operatorId: string,
  lines: readonly PricedAddOnLine[],
): Promise<void> {
  const ordered = [...lines].sort((a, b) => (a.addOnId < b.addOnId ? -1 : a.addOnId > b.addOnId ? 1 : 0));
  for (const line of ordered) {
    if (line.quantity <= 0) continue;
    const affected = await tx.$executeRawUnsafe(
      `UPDATE "PackageUpsell"
          SET stock_sold = stock_sold + $3
        WHERE id = $2
          AND operator_id = $1
          AND is_active = true
          AND (stock_total IS NULL OR stock_sold + $3 <= stock_total)`,
      operatorId,
      line.addOnId,
      line.quantity,
    );
    if (affected === 0) {
      throw new AddOnError(
        'ADD_ON_SOLD_OUT',
        `${line.name} just sold out. Remove it to finish your booking.`,
        409,
      );
    }
  }
}

/**
 * Give stock back when an order (or one add-on line) is cancelled or refunded.
 *
 * Floored at zero with GREATEST rather than trusting the arithmetic: a
 * double-cancel must not drive the counter negative and hand out free stock. As
 * with the reservation this is one statement, so a concurrent booking either
 * sees the released unit or does not — never a torn count.
 */
export async function releaseAddOnStock(
  tx: RawClient,
  operatorId: string,
  lines: readonly { addOnId: string; quantity: number }[],
): Promise<void> {
  const ordered = [...lines].sort((a, b) => (a.addOnId < b.addOnId ? -1 : a.addOnId > b.addOnId ? 1 : 0));
  for (const line of ordered) {
    if (line.quantity <= 0) continue;
    await tx.$executeRawUnsafe(
      `UPDATE "PackageUpsell"
          SET stock_sold = GREATEST(0, stock_sold - $3)
        WHERE id = $2 AND operator_id = $1`,
      operatorId,
      line.addOnId,
      line.quantity,
    );
  }
}

/**
 * Validate a guest's submitted selections against the database and price them.
 *
 * The one entry point `booking.ts` needs: it re-reads the definitions (never
 * trusting a client-sent price), resolves quantities, and returns the priced
 * lines. It does NOT reserve stock — that happens later in the same transaction,
 * once the seats are known to be available, so a booking that fails on capacity
 * does not first consume a cooler.
 */
export async function resolveAddOnLines(
  tx: RawClient,
  operatorId: string,
  input: {
    activityId: string;
    guestCount: number;
    selections: readonly AddOnSelection[];
  },
): Promise<PricedAddOnLine[]> {
  const wanted = input.selections.filter((s) => s.quantity > 0);
  if (wanted.length === 0) return [];

  const offered = await listAddOnsForActivity(tx, operatorId, input.activityId);
  const offeredIds = new Set(offered.map((d) => d.id));
  for (const sel of wanted) {
    if (!offeredIds.has(sel.addOnId)) {
      // A selection for another activity's add-on is a client bug or a probe,
      // not a race — fail it loudly rather than silently dropping it.
      throw new AddOnError(
        'ADD_ON_NOT_OFFERED',
        'One of the selected add-ons is not available for this activity.',
        400,
      );
    }
  }
  return priceAddOnSelections(offered, wanted, input.guestCount);
}
