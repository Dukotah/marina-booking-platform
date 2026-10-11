import { Package2, ShoppingBag, Tags, TrendingUp } from 'lucide-react';
import type { Delta } from '@marina/core';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@marina/ui';
import { KpiCard } from '../shell';
import { formatNumber, formatUSD } from '../../lib/format';
import type { MerchandiseReport } from './queries';

export interface MerchandiseReportViewProps {
  report: MerchandiseReport;
}

/** A finite ratio for KpiCard, or undefined when the delta base was zero. */
function deltaRatio(delta: Delta | undefined): number | undefined {
  if (!delta || delta.ratio === null || !Number.isFinite(delta.ratio)) return undefined;
  return delta.ratio;
}

const CELL = 'px-3 py-2 tabular-nums text-right';
const CELL_LEFT = 'px-3 py-2 text-left';

/**
 * Merchandise report: every non-seat revenue line — register merchandise and
 * misc/gift lines, checkout add-ons, and post-trip charges — grouped by
 * product category. Parent products roll up their variants (the
 * fuel-by-fractional-gallon pattern): a product-level total row with the
 * variant rows indented beneath it. Per-category subtotals + a grand total.
 * Honors the shared date range, date basis, activity filter, and comparison
 * controls. Discounts are the exact allocated shares of order-level discounts,
 * so this report always reconciles with the Sales summary.
 */
export function MerchandiseReportView({ report }: MerchandiseReportViewProps) {
  const { data, comparison } = report;

  if (data.categories.length === 0) {
    return (
      <EmptyState
        icon={ShoppingBag}
        title="No merchandise sold in this range"
        description="Register merchandise, gift/misc lines, checkout add-ons, and post-trip charges appear here once they're sold."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Merchandise sales"
          value={formatUSD(data.totals.totalCents)}
          icon={TrendingUp}
          deltaRatio={deltaRatio(comparison?.deltas.totalCents)}
          deltaLabel="vs prev period"
        />
        <KpiCard
          label="Units sold"
          value={formatNumber(data.totals.quantity)}
          icon={ShoppingBag}
          deltaRatio={deltaRatio(comparison?.deltas.quantity)}
          deltaLabel="vs prev period"
        />
        <KpiCard label="Categories" value={formatNumber(data.categories.length)} icon={Tags} />
        <KpiCard label="Orders with merchandise" value={formatNumber(data.orders)} icon={Package2} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sales by product</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-medium uppercase tracking-wide text-ink-muted">
                <th className={CELL_LEFT}>Product</th>
                <th className={CELL_LEFT}>Variant</th>
                <th className={CELL}>Cost/Unit</th>
                <th className={CELL}>Qty sold</th>
                <th className={CELL}>Gross</th>
                <th className={CELL}>Discount</th>
                <th className={CELL}>Total sales</th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((cat) => (
                <CategoryRows key={cat.category} category={cat} />
              ))}
              <tr className="border-t-2 border-line font-semibold text-ink">
                <td className={CELL_LEFT} colSpan={3}>
                  Grand total
                </td>
                <td className={CELL}>{formatNumber(data.totals.quantity)}</td>
                <td className={CELL}>{formatUSD(data.totals.grossCents)}</td>
                <td className={CELL}>
                  {data.totals.discountCents ? `−${formatUSD(data.totals.discountCents)}` : '—'}
                </td>
                <td className={CELL}>{formatUSD(data.totals.totalCents)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-muted">
            Total sales are net of allocated order discounts, pre-tax. Includes register
            merchandise, gift/misc lines, checkout add-ons, and post-trip charges.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function CategoryRows({
  category,
}: {
  category: MerchandiseReport['data']['categories'][number];
}) {
  return (
    <>
      <tr>
        <td
          colSpan={7}
          className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          {category.category}
        </td>
      </tr>
      {category.products.map((p) => (
        <ProductRows key={p.name} product={p} />
      ))}
      <tr className="border-t border-line bg-surface-muted font-medium text-ink">
        <td className={CELL_LEFT} colSpan={3}>
          {category.category} subtotal
        </td>
        <td className={CELL}>{formatNumber(category.totals.quantity)}</td>
        <td className={CELL}>{formatUSD(category.totals.grossCents)}</td>
        <td className={CELL}>
          {category.totals.discountCents ? `−${formatUSD(category.totals.discountCents)}` : '—'}
        </td>
        <td className={CELL}>{formatUSD(category.totals.totalCents)}</td>
      </tr>
    </>
  );
}

function ProductRows({
  product,
}: {
  product: MerchandiseReport['data']['categories'][number]['products'][number];
}) {
  // Single-variant (or variant-less) products render as one flat row; products
  // with variants get a parent roll-up row with the variants indented beneath.
  if (!product.hasVariants) {
    const v = product.variants[0];
    return (
      <tr className="border-t border-line">
        <td className={`${CELL_LEFT} font-medium text-ink`}>{product.name}</td>
        <td className={`${CELL_LEFT} text-ink-muted`}>—</td>
        <td className={`${CELL} text-ink-muted`}>
          {v?.unitPriceCents == null ? '—' : formatUSD(v.unitPriceCents)}
        </td>
        <td className={`${CELL} text-ink-body`}>{formatNumber(product.quantity)}</td>
        <td className={`${CELL} text-ink-body`}>{formatUSD(product.grossCents)}</td>
        <td className={`${CELL} text-ink-muted`}>
          {product.discountCents ? `−${formatUSD(product.discountCents)}` : '—'}
        </td>
        <td className={`${CELL} font-medium text-ink`}>{formatUSD(product.totalCents)}</td>
      </tr>
    );
  }

  return (
    <>
      <tr className="border-t border-line">
        <td className={`${CELL_LEFT} font-medium text-ink`}>{product.name}</td>
        <td className={`${CELL_LEFT} text-xs text-ink-muted`}>
          {product.variants.length} variant{product.variants.length === 1 ? '' : 's'}
        </td>
        <td className={`${CELL} text-ink-muted`}>
          {product.unitPriceCents == null ? '—' : formatUSD(product.unitPriceCents)}
        </td>
        <td className={`${CELL} font-medium text-ink`}>{formatNumber(product.quantity)}</td>
        <td className={`${CELL} font-medium text-ink`}>{formatUSD(product.grossCents)}</td>
        <td className={`${CELL} text-ink-muted`}>
          {product.discountCents ? `−${formatUSD(product.discountCents)}` : '—'}
        </td>
        <td className={`${CELL} font-semibold text-ink`}>{formatUSD(product.totalCents)}</td>
      </tr>
      {product.variants.map((v) => (
        <tr key={v.variant ?? '__base__'} className="border-t border-line">
          <td className={`${CELL_LEFT} pl-7 text-ink-muted`}>{product.name}</td>
          <td className={`${CELL_LEFT} text-ink-body`}>{v.variant ?? 'Base'}</td>
          <td className={`${CELL} text-ink-muted`}>
            {v.unitPriceCents == null ? '—' : formatUSD(v.unitPriceCents)}
          </td>
          <td className={`${CELL} text-ink-body`}>{formatNumber(v.quantity)}</td>
          <td className={`${CELL} text-ink-body`}>{formatUSD(v.grossCents)}</td>
          <td className={`${CELL} text-ink-muted`}>
            {v.discountCents ? `−${formatUSD(v.discountCents)}` : '—'}
          </td>
          <td className={`${CELL} text-ink-body`}>{formatUSD(v.totalCents)}</td>
        </tr>
      ))}
    </>
  );
}
