/**
 * Full money breakdown for a confirmed order.
 *
 * All amounts are integer cents (see @marina/types money helpers) and rendered
 * via formatUSD. Zero-value lines (discount, tax, processing, tip) are hidden so
 * the receipt stays clean, but subtotal and total always show. Paid / balance
 * lines surface payment state for partially-paid or unpaid orders.
 */
import { formatUSD } from '@/lib/format';
import type { OrderSummary } from '@/lib/api';

function Row({
  label,
  cents,
  muted = false,
  negative = false,
}: {
  label: string;
  cents: number;
  muted?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={muted ? 'text-slate-500' : 'text-slate-700'}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-slate-500' : 'text-slate-900'}`}>
        {negative ? `−${formatUSD(cents)}` : formatUSD(cents)}
      </span>
    </div>
  );
}

export function PriceBreakdown({ order }: { order: OrderSummary }) {
  const fullyPaid = order.balanceDueCents <= 0 && order.amountPaidCents > 0;

  return (
    <div className="space-y-3">
      <Row label="Subtotal" cents={order.subtotalCents} muted />
      {order.discountCents > 0 && (
        <Row label="Discount" cents={order.discountCents} muted negative />
      )}
      {order.taxCents > 0 && <Row label="Tax" cents={order.taxCents} muted />}
      {order.processingFeeCents > 0 && (
        <Row label="Processing fee" cents={order.processingFeeCents} muted />
      )}
      {order.tipCents > 0 && <Row label="Tip" cents={order.tipCents} muted />}

      <div className="border-t border-slate-200 pt-3">
        <div className="flex items-center justify-between">
          <span className="text-base font-semibold text-slate-900">Total</span>
          <span className="text-base font-bold tabular-nums text-slate-900">
            {formatUSD(order.totalCents)}
          </span>
        </div>
      </div>

      {(order.amountPaidCents > 0 || order.balanceDueCents > 0) && (
        <div className="space-y-2 border-t border-slate-200 pt-3">
          <Row label="Amount paid" cents={order.amountPaidCents} muted />
          {order.balanceDueCents > 0 ? (
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-amber-700">Balance due</span>
              <span className="font-semibold tabular-nums text-amber-700">
                {formatUSD(order.balanceDueCents)}
              </span>
            </div>
          ) : (
            fullyPaid && (
              <p className="text-sm font-medium text-emerald-600">Paid in full</p>
            )
          )}
        </div>
      )}
    </div>
  );
}

export default PriceBreakdown;
