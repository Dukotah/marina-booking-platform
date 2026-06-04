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
      <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-500">
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
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
      <p className="mx-auto mt-3 max-w-md text-slate-600">{message}</p>
      {orderNumber && (
        <p className="mt-2 text-sm text-slate-400">
          Order reference:{' '}
          <span className="font-mono font-medium text-slate-600">{orderNumber}</span>
        </p>
      )}
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link
          href="/lookup"
          className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
          style={{ backgroundColor: 'var(--brand-color)' }}
        >
          Look up my booking
        </Link>
        <Link
          href="/"
          className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Back to booking
        </Link>
      </div>
    </div>
  );
}

export default OrderNotFound;
