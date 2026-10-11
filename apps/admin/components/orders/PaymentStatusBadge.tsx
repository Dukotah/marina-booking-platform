import { Badge, type BadgeTone } from '../ui';

/** Payment status (mirrors Prisma `PaymentStatus`). */
export type PaymentStatusValue =
  | 'PAID'
  | 'REFUNDED'
  | 'PARTIAL_REFUND'
  | 'FAILED'
  | 'PRE_AUTHORIZED'
  | 'REQUIRES_ACTION'
  | 'DISPUTED';

// Semantic tones only — no sky/indigo. success = money captured, owed/rose =
// failure/dispute, waiting/amber = pending or partially returned, cancelled/slate
// = fully refunded or awaiting the guest.
const STYLES: Record<PaymentStatusValue, { label: string; tone: BadgeTone }> = {
  PAID: { label: 'Paid', tone: 'success' },
  REFUNDED: { label: 'Refunded', tone: 'cancelled' },
  PARTIAL_REFUND: { label: 'Partial refund', tone: 'waiting' },
  FAILED: { label: 'Failed', tone: 'owed' },
  PRE_AUTHORIZED: { label: 'Pre-authorized', tone: 'neutral' },
  // The guest has been sent to a 3DS/SCA challenge and has not finished it. Money
  // is not captured yet, so this reads as pending, not as a failure.
  REQUIRES_ACTION: { label: 'Awaiting 3-D Secure', tone: 'waiting' },
  // A chargeback is open against this payment; funds are held pending evidence.
  DISPUTED: { label: 'Disputed', tone: 'owed' },
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
    <Badge tone={style.tone} className={className}>
      {style.label}
    </Badge>
  );
}
