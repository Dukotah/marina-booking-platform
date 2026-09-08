// @marina/core — itemized sales + merchandise report math (pure, DB-free).
//
// The Reports overhaul (beat-Singenuity depth) needs line-level views that
// still RECONCILE exactly with the order-level summary numbers. Everything
// here is pure: callers fetch rows (admin data layer or API), these builders
// aggregate them. All money is integer cents.
//
// The core money identity these builders enforce and verify:
//
//   order.total = order.subtotal − discount + tax + processing_fee + tip + Σ charges
//   order.subtotal = Σ activity-line value + Σ merchandise-line value
//
// Order-level money (discount, tax, processing fee) is allocated across the
// order's subtotal lines by value share using a largest-remainder split, so the
// per-line allocations always sum EXACTLY to the order columns — itemized
// totals can never drift from the summary.

// ---------------------------------------------------------------------------
// Input row shapes (minimal projections of the Prisma models)
// ---------------------------------------------------------------------------

/** Order-level money columns (one row per in-scope order). */
export interface ItemizedOrderRow {
  id: string;
  order_number: string;
  /** Attributed local ISO date (already resolved for the active date basis). */
  date: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  processing_fee_cents: number;
  tip_cents: number;
  total_cents: number;
}

/** A booking OrderItem line (seat, add-on, or package-expanded seat). */
export interface ItemizedActivityLineRow {
  order_id: string;
  activity_id: string;
  activity_name: string;
  rate_name: string;
  quantity: number;
  unit_price_cents: number;
  add_on_id: string | null;
  add_on_name: string | null;
  package_id: string | null;
  package_name: string | null;
}

/** A persisted merchandise/misc sale line (OrderMerchandiseLine). */
export interface ItemizedMerchLineRow {
  order_id: string;
  /** MERCHANDISE | MISC */
  kind: string;
  name: string;
  category: string;
  variant: string | null;
  quantity: number;
  unit_price_cents: number;
}

/** A post-booking OrderCharge (fuel used, cleaning, damage, late, other). */
export interface ItemizedChargeRow {
  order_id: string;
  category: string;
  label: string;
  amount_cents: number;
}

export interface ItemizedInput {
  orders: readonly ItemizedOrderRow[];
  activityLines: readonly ItemizedActivityLineRow[];
  merchLines: readonly ItemizedMerchLineRow[];
  charges: readonly ItemizedChargeRow[];
}

// ---------------------------------------------------------------------------
// Largest-remainder allocation
// ---------------------------------------------------------------------------

/**
 * Split `total` across `weights` proportionally in integer cents, guaranteeing
 * the parts sum EXACTLY to `total` (largest-remainder method). A zero/empty
 * weight vector puts everything in the first slot (nothing is ever dropped).
 */
export function allocateProportionally(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (weightSum <= 0 || total === 0) {
    const out = new Array<number>(weights.length).fill(0);
    out[0] = total;
    return out;
  }

  // Work in absolute cents; re-apply the sign at the end so negative totals
  // (refund-style) allocate symmetrically.
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);

  const exact = weights.map((w) => (abs * Math.max(0, w)) / weightSum);
  const floors = exact.map(Math.floor);
  let remainder = abs - floors.reduce((s, f) => s + f, 0);

  // Hand the leftover cents to the largest fractional parts (stable order).
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    floors[order[k]!.i] += 1;
  }

  return floors.map((f) => sign * f);
}

// ---------------------------------------------------------------------------
// Per-line allocation (discount / tax / processing fee)
// ---------------------------------------------------------------------------

/** Which report bucket a line belongs to. */
export type ItemGroupKey = 'activity' | 'packages' | 'merchandise' | 'charges';

export const ITEM_GROUP_LABEL: Record<ItemGroupKey, string> = {
  activity: 'Activities',
  packages: 'Packages',
  merchandise: 'Merchandise',
  charges: 'Charges',
};

/** One fully-allocated sale line (the atom both views aggregate from). */
export interface AllocatedLine {
  orderId: string;
  orderNumber: string;
  date: string;
  group: ItemGroupKey;
  /** Stable aggregation key within the group (activity id, product|variant, …). */
  itemKey: string;
  label: string;
  /** Secondary label: rate name, variant, category, charge category. */
  sublabel: string | null;
  category: string;
  variant: string | null;
  quantity: number;
  /** Per-unit price; null for charges (no unit concept). */
  unitPriceCents: number | null;
  /** Line value before discounts (qty × unit, or the charge amount). */
  grossCents: number;
  /** This line's allocated share of the order discount. */
  discountCents: number;
  /** gross − discount. */
  netCents: number;
  /** Allocated share of order tax + processing fee. */
  taxCents: number;
  /** net + tax. */
  totalCents: number;
}

/**
 * Explode orders into fully-allocated lines. Order-level discount, tax, and
 * processing fee are spread across the order's SUBTOTAL lines (activity +
 * package + merchandise) by value share; charges were added after pricing so
 * they carry their raw amount and never absorb discount/tax. Lines belonging
 * to orders not present in `orders` are ignored (defensive).
 */
export function allocateLines(input: ItemizedInput): AllocatedLine[] {
  const orderById = new Map(input.orders.map((o) => [o.id, o]));

  const activityByOrder = groupBy(input.activityLines, (l) => l.order_id);
  const merchByOrder = groupBy(input.merchLines, (l) => l.order_id);
  const chargesByOrder = groupBy(input.charges, (l) => l.order_id);

  const out: AllocatedLine[] = [];

  for (const order of input.orders) {
    const aLines = activityByOrder.get(order.id) ?? [];
    const mLines = merchByOrder.get(order.id) ?? [];
    const cLines = chargesByOrder.get(order.id) ?? [];

    const values = [
      ...aLines.map((l) => l.unit_price_cents * l.quantity),
      ...mLines.map((l) => l.unit_price_cents * l.quantity),
    ];
    const discounts = allocateProportionally(order.discount_cents, values);
    // Tax + fee are levied on the discounted base, so allocate by net value.
    const netValues = values.map((v, i) => v - (discounts[i] ?? 0));
    const taxes = allocateProportionally(order.tax_cents + order.processing_fee_cents, netValues);

    let idx = 0;
    for (const l of aLines) {
      const gross = l.unit_price_cents * l.quantity;
      const discount = discounts[idx] ?? 0;
      const tax = taxes[idx] ?? 0;
      idx += 1;

      const isAddOn = l.add_on_id !== null;
      const isPackage = !isAddOn && l.package_id !== null;
      const group: ItemGroupKey = isAddOn ? 'merchandise' : isPackage ? 'packages' : 'activity';
      const label = isAddOn ? (l.add_on_name ?? 'Add-on') : isPackage ? (l.package_name ?? 'Package') : l.activity_name;

      out.push({
        orderId: order.id,
        orderNumber: order.order_number,
        date: order.date,
        group,
        itemKey: isAddOn
          ? `addon:${l.add_on_id}`
          : isPackage
            ? `package:${l.package_id}`
            : `activity:${l.activity_id}`,
        label,
        sublabel: isAddOn ? 'Add-on' : isPackage ? l.activity_name : l.rate_name,
        category: isAddOn ? 'Add-Ons' : isPackage ? 'Packages' : 'Activities',
        variant: null,
        quantity: l.quantity,
        unitPriceCents: l.unit_price_cents,
        grossCents: gross,
        discountCents: discount,
        netCents: gross - discount,
        taxCents: tax,
        totalCents: gross - discount + tax,
      });
    }

    for (const l of mLines) {
      const gross = l.unit_price_cents * l.quantity;
      const discount = discounts[idx] ?? 0;
      const tax = taxes[idx] ?? 0;
      idx += 1;

      out.push({
        orderId: order.id,
        orderNumber: order.order_number,
        date: order.date,
        group: 'merchandise',
        itemKey: `merch:${l.name}|${l.variant ?? ''}`,
        label: l.name,
        sublabel: l.variant ?? l.category,
        category: l.kind === 'MISC' ? 'Uncategorized' : l.category,
        variant: l.variant,
        quantity: l.quantity,
        unitPriceCents: l.unit_price_cents,
        grossCents: gross,
        discountCents: discount,
        netCents: gross - discount,
        taxCents: tax,
        totalCents: gross - discount + tax,
      });
    }

    for (const l of cLines) {
      out.push({
        orderId: order.id,
        orderNumber: order.order_number,
        date: order.date,
        group: 'charges',
        itemKey: `charge:${l.category}`,
        label: chargeCategoryLabel(l.category),
        sublabel: l.label,
        category: chargeCategoryLabel(l.category),
        variant: null,
        quantity: 1,
        unitPriceCents: null,
        grossCents: l.amount_cents,
        discountCents: 0,
        netCents: l.amount_cents,
        taxCents: 0,
        totalCents: l.amount_cents,
      });
    }
  }

  return out.filter((l) => orderById.has(l.orderId));
}

/** Human label for an OrderCharge category (free string, defensive default). */
export function chargeCategoryLabel(category: string): string {
  switch (category.toUpperCase()) {
    case 'FUEL':
      return 'Fuel';
    case 'CLEANING':
      return 'Cleaning';
    case 'DAMAGE':
      return 'Damages & Safety Equipment';
    case 'LATE':
      return 'Late fees';
    default:
      return 'Other charges';
  }
}

// ---------------------------------------------------------------------------
// Items view (aggregated) + group totals
// ---------------------------------------------------------------------------

export interface ItemTotals {
  quantity: number;
  grossCents: number;
  discountCents: number;
  netCents: number;
  taxCents: number;
  totalCents: number;
}

export interface ItemRow extends ItemTotals {
  itemKey: string;
  label: string;
  sublabel: string | null;
}

export interface ItemGroup {
  key: ItemGroupKey;
  label: string;
  rows: ItemRow[];
  totals: ItemTotals;
}

export interface ItemizedSales {
  groups: ItemGroup[];
  /** Order-level money that has no line: tips (shown as a footer row). */
  tipCents: number;
  /** Σ group totals + tips — must equal Σ order.total_cents. */
  grandTotalCents: number;
  totals: ItemTotals;
  reconciliation: Reconciliation;
}

const GROUP_ORDER: ItemGroupKey[] = ['activity', 'packages', 'merchandise', 'charges'];

function emptyTotals(): ItemTotals {
  return { quantity: 0, grossCents: 0, discountCents: 0, netCents: 0, taxCents: 0, totalCents: 0 };
}

function addTotals(acc: ItemTotals, l: ItemTotals): void {
  acc.quantity += l.quantity;
  acc.grossCents += l.grossCents;
  acc.discountCents += l.discountCents;
  acc.netCents += l.netCents;
  acc.taxCents += l.taxCents;
  acc.totalCents += l.totalCents;
}

/**
 * Aggregate allocated lines into the Items view: one row per distinct item,
 * grouped into Activities / Packages / Merchandise / Charges with per-group
 * subtotals, plus tips and the combined grand total. Empty groups are omitted.
 */
export function buildItemizedSales(input: ItemizedInput): ItemizedSales {
  const lines = allocateLines(input);

  const groups = new Map<ItemGroupKey, Map<string, ItemRow>>();
  for (const l of lines) {
    let g = groups.get(l.group);
    if (!g) {
      g = new Map();
      groups.set(l.group, g);
    }
    let row = g.get(l.itemKey);
    if (!row) {
      row = { itemKey: l.itemKey, label: l.label, sublabel: l.sublabel, ...emptyTotals() };
      g.set(l.itemKey, row);
    }
    addTotals(row, l);
  }

  const tipCents = input.orders.reduce((s, o) => s + o.tip_cents, 0);

  const outGroups: ItemGroup[] = [];
  const totals = emptyTotals();
  for (const key of GROUP_ORDER) {
    const g = groups.get(key);
    if (!g || g.size === 0) continue;
    const rows = Array.from(g.values()).sort((a, b) => b.grossCents - a.grossCents);
    const groupTotals = emptyTotals();
    for (const r of rows) addTotals(groupTotals, r);
    addTotals(totals, groupTotals);
    outGroups.push({ key, label: ITEM_GROUP_LABEL[key], rows, totals: groupTotals });
  }

  return {
    groups: outGroups,
    tipCents,
    grandTotalCents: totals.totalCents + tipCents,
    totals,
    reconciliation: reconcileItemized(input, lines, totals, tipCents),
  };
}

// ---------------------------------------------------------------------------
// Details view (line level)
// ---------------------------------------------------------------------------

/**
 * The Details view is the raw allocated lines, newest date first then by order
 * number, so every cent in the Items view can be traced to a specific order.
 */
export function buildItemizedDetails(input: ItemizedInput): AllocatedLine[] {
  return allocateLines(input).sort(
    (a, b) => b.date.localeCompare(a.date) || a.orderNumber.localeCompare(b.orderNumber),
  );
}

// ---------------------------------------------------------------------------
// Reconciliation — the trust feature
// ---------------------------------------------------------------------------

export interface ReconciliationCheck {
  name: string;
  expectedCents: number;
  actualCents: number;
  diffCents: number;
  ok: boolean;
}

export interface Reconciliation {
  ok: boolean;
  checks: ReconciliationCheck[];
}

function check(name: string, expectedCents: number, actualCents: number): ReconciliationCheck {
  const diffCents = actualCents - expectedCents;
  return { name, expectedCents, actualCents, diffCents, ok: diffCents === 0 };
}

/**
 * Verify that the itemization covers every cent of the summary:
 *  1. line coverage: Σ line gross (activity+package+merch) = Σ order.subtotal —
 *     catches orders whose lines were never persisted (pre-migration history);
 *  2. discount allocation: Σ line discounts = Σ order.discount;
 *  3. tax/fee allocation: Σ line tax = Σ order.(tax + processing_fee);
 *  4. the order identity itself: Σ order.total = Σ (subtotal − discount + tax
 *     + fee + tip) + Σ charges;
 *  5. grand total: itemized total + tips = Σ order.total.
 */
export function reconcileItemized(
  input: ItemizedInput,
  lines: readonly AllocatedLine[],
  totals: ItemTotals,
  tipCents: number,
): Reconciliation {
  let subtotal = 0;
  let discount = 0;
  let taxAndFee = 0;
  let tips = 0;
  let gross = 0;
  for (const o of input.orders) {
    subtotal += o.subtotal_cents;
    discount += o.discount_cents;
    taxAndFee += o.tax_cents + o.processing_fee_cents;
    tips += o.tip_cents;
    gross += o.total_cents;
  }
  const chargesTotal = lines
    .filter((l) => l.group === 'charges')
    .reduce((s, l) => s + l.grossCents, 0);
  const subtotalLines = lines
    .filter((l) => l.group !== 'charges')
    .reduce((s, l) => s + l.grossCents, 0);

  const checks = [
    check('Line coverage (Σ lines = Σ order subtotals)', subtotal, subtotalLines),
    check('Discount allocation', discount, totals.discountCents),
    check('Tax & fee allocation', taxAndFee, totals.taxCents),
    check(
      'Order identity (subtotal − discount + tax + fee + tip + charges = gross)',
      gross,
      subtotal - discount + taxAndFee + tips + chargesTotal,
    ),
    check('Grand total (items + tips = gross sales)', gross, totals.totalCents + tipCents),
  ];

  return { ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// Merchandise report (category → product → variant roll-up)
// ---------------------------------------------------------------------------

export interface MerchandiseVariantRow {
  /** Variant label, or null for the product's base (no-variant) sales. */
  variant: string | null;
  /** Per-unit price; null when lines disagree (price changed mid-range). */
  unitPriceCents: number | null;
  quantity: number;
  grossCents: number;
  discountCents: number;
  totalCents: number;
}

export interface MerchandiseProductRow {
  name: string;
  variants: MerchandiseVariantRow[];
  /** True when the product has >1 variant row (renders a roll-up parent row). */
  hasVariants: boolean;
  unitPriceCents: number | null;
  quantity: number;
  grossCents: number;
  discountCents: number;
  totalCents: number;
}

export interface MerchandiseCategoryGroup {
  category: string;
  products: MerchandiseProductRow[];
  totals: { quantity: number; grossCents: number; discountCents: number; totalCents: number };
}

export interface MerchandiseReportData {
  categories: MerchandiseCategoryGroup[];
  totals: { quantity: number; grossCents: number; discountCents: number; totalCents: number };
  /** Distinct orders that included at least one merch-like line. */
  orders: number;
}

/**
 * The Merchandise report: every non-seat revenue line — persisted merchandise
 * and misc register lines, checkout add-ons, and post-trip charges — grouped
 * by category, with parent products rolling up their variants (the
 * fuel-by-fractional-gallon pattern) and per-category subtotals. Discounts are
 * the allocated shares from `allocateLines`, so this report plus the activity
 * side always reconciles with gross. "Total Sales" per row = net (gross −
 * discount), pre-tax — the merchandising view of the money.
 */
export function buildMerchandiseReport(input: ItemizedInput): MerchandiseReportData {
  const lines = allocateLines(input).filter(
    (l) => l.group === 'merchandise' || l.group === 'charges',
  );

  // category -> product name -> variant -> accumulating row
  const cats = new Map<string, Map<string, Map<string, MerchandiseVariantRow & { prices: Set<number | null> }>>>();
  const orderIds = new Set<string>();

  for (const l of lines) {
    orderIds.add(l.orderId);
    const catKey = l.category;
    let products = cats.get(catKey);
    if (!products) {
      products = new Map();
      cats.set(catKey, products);
    }
    let variants = products.get(l.label);
    if (!variants) {
      variants = new Map();
      products.set(l.label, variants);
    }
    const vKey = l.variant ?? '';
    let row = variants.get(vKey);
    if (!row) {
      row = {
        variant: l.variant,
        unitPriceCents: null,
        quantity: 0,
        grossCents: 0,
        discountCents: 0,
        totalCents: 0,
        prices: new Set(),
      };
      variants.set(vKey, row);
    }
    row.quantity += l.quantity;
    row.grossCents += l.grossCents;
    row.discountCents += l.discountCents;
    row.totalCents += l.netCents;
    row.prices.add(l.unitPriceCents);
  }

  const categories: MerchandiseCategoryGroup[] = [];
  const totals = { quantity: 0, grossCents: 0, discountCents: 0, totalCents: 0 };

  for (const [category, products] of cats) {
    const productRows: MerchandiseProductRow[] = [];
    for (const [name, variants] of products) {
      const variantRows: MerchandiseVariantRow[] = Array.from(variants.values())
        .map(({ prices, ...v }) => ({
          ...v,
          unitPriceCents: prices.size === 1 ? Array.from(prices)[0]! : null,
        }))
        .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''));

      const product: MerchandiseProductRow = {
        name,
        variants: variantRows,
        hasVariants: variantRows.length > 1 || variantRows.some((v) => v.variant !== null),
        unitPriceCents:
          variantRows.length === 1 ? variantRows[0]!.unitPriceCents : null,
        quantity: variantRows.reduce((s, v) => s + v.quantity, 0),
        grossCents: variantRows.reduce((s, v) => s + v.grossCents, 0),
        discountCents: variantRows.reduce((s, v) => s + v.discountCents, 0),
        totalCents: variantRows.reduce((s, v) => s + v.totalCents, 0),
      };
      productRows.push(product);
    }
    productRows.sort((a, b) => b.totalCents - a.totalCents);

    const catTotals = {
      quantity: productRows.reduce((s, p) => s + p.quantity, 0),
      grossCents: productRows.reduce((s, p) => s + p.grossCents, 0),
      discountCents: productRows.reduce((s, p) => s + p.discountCents, 0),
      totalCents: productRows.reduce((s, p) => s + p.totalCents, 0),
    };
    totals.quantity += catTotals.quantity;
    totals.grossCents += catTotals.grossCents;
    totals.discountCents += catTotals.discountCents;
    totals.totalCents += catTotals.totalCents;

    categories.push({ category, products: productRows, totals: catTotals });
  }

  categories.sort((a, b) => b.totals.totalCents - a.totals.totalCents);

  return { categories, totals, orders: orderIds.size };
}

// ---------------------------------------------------------------------------
// Small shared helper
// ---------------------------------------------------------------------------

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}
