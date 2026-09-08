/**
 * Graceful empty / not-found state for the confirmation page.
 *
 * Used when no order number is provided, the order can't be found for the
 * current tenant, or the booking API is unreachable. Keeps the customer on a
 * friendly, branded screen with a clear next step rather than a raw error.
 */
import Link from 'next/link';

export function OrderNotFound({
  title,
  message,
  orderNumber,
}: {
  title: string;
  message: string;
  orderNumber?: string | null;
}) {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full border border-hairline bg-surface text-muted">
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </div>
      <h1 className="font-display text-[28px] leading-[1.2] tracking-[0.02em] text-ink">{title}</h1>
      <p className="mx-auto mt-3 max-w-md leading-[1.55] text-muted">{message}</p>
      {orderNumber && (
        <p className="mt-2 text-sm text-muted">
          Order reference:{' '}
          <span className="tnum font-medium tracking-[0.04em] text-ink">{orderNumber}</span>
        </p>
      )}
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link
          href="/account"
          className="rounded-lg bg-ink px-5 py-2.5 text-sm font-semibold text-bg transition hover:opacity-90"
        >
          Look up my booking
        </Link>
        <Link
          href="/"
          className="rounded-lg border border-hairline px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-surface"
        >
          Back to booking
        </Link>
      </div>
    </div>
  );
}

export default OrderNotFound;
