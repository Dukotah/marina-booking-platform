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
  // A deposit order paid a portion now and owes the rest at check-in.
  const isDeposit = order.amountPaidCents > 0 && order.balanceDueCents > 0;
  // A reserve-now booking: nothing was charged online, the full amount is owed on
  // arrival ("pay at the marina"). Shown as its own clean callout, not as a
  // "$0.00 paid" line.
  const isReserveOnly = order.amountPaidCents === 0 && order.balanceDueCents > 0;

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

      {isDeposit && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
          Deposit taken. Pay {formatUSD(order.amountPaidCents)} now,{' '}
          {formatUSD(order.balanceDueCents)} due at check-in.
        </p>
      )}

      {isReserveOnly ? (
        <div className="space-y-2 border-t border-slate-200 pt-3">
          <div className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2">
            <span className="text-sm font-medium text-amber-800">
              Due at the marina
            </span>
            <span className="text-sm font-semibold tabular-nums text-amber-800">
              {formatUSD(order.balanceDueCents)}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Your spot is reserved — nothing was charged today. Pay when you arrive.
            Cash and card are accepted at check-in.
          </p>
        </div>
      ) : (
        (order.amountPaidCents > 0 || order.balanceDueCents > 0) && (
          <div className="space-y-2 border-t border-slate-200 pt-3">
            <Row label={isDeposit ? 'Deposit paid' : 'Amount paid'} cents={order.amountPaidCents} muted />
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
        )
      )}
    </div>
  );
}

export default PriceBreakdown;
