import { cn } from '../../lib/cn';

/** Payment status (mirrors Prisma `PaymentStatus`). */
export type PaymentStatusValue =
  | 'PAID'
  | 'REFUNDED'
  | 'PARTIAL_REFUND'
  | 'FAILED'
  | 'PRE_AUTHORIZED';

const STYLES: Record<PaymentStatusValue, { label: string; className: string }> = {
  PAID: { label: 'Paid', className: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  REFUNDED: { label: 'Refunded', className: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
  PARTIAL_REFUND: {
    label: 'Partial refund',
    className: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  },
  FAILED: { label: 'Failed', className: 'bg-red-50 text-red-700 ring-red-600/20' },
  PRE_AUTHORIZED: { label: 'Pre-authorized', className: 'bg-sky-50 text-sky-700 ring-sky-600/20' },
};

/** Color-coded payment status pill used in the order detail payments table. */
export function PaymentStatusBadge({
  status,
  className,
}: {
  status: PaymentStatusValue;
  className?: string;
}) {
  const style = STYLES[status] ?? STYLES.PAID;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        style.className,
        className,
      )}
    >
      {style.label}
    </span>
  );
}
