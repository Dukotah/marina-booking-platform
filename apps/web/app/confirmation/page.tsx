/**
 * Booking confirmation + lookup result screen.
 *
 * Reached after checkout (the booking flow redirects to
 * `/confirmation?order=<orderNumber>`) and from the "My Booking" lookup. Server
 * component: it fetches the order by its public order number via the typed API
 * client (tenant-scoped on the API side by the resolved operator), then renders
 * a success screen with the order number, each booked activity + date/time, the
 * party size, the full price breakdown, check-in instructions, the cancellation
 * policy, and a QR-style check-in placeholder built from the order number.
 *
 * Everything is white-label: the operator's brand name/color drive the UI; no
 * platform or specific-marina branding is hardcoded. Missing/invalid orders and
 * an unreachable API degrade to a friendly not-found state.
 */
import type { Metadata } from 'next';
import { formatLongDate, formatTime } from '@/lib/format';
import { getOrder, isApiError, type OrderSummary } from '@/lib/api';
import { getBrand, brandStyle } from '@/lib/brand';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';
import { QrPlaceholder } from './components/QrPlaceholder';
import { PriceBreakdown } from './components/PriceBreakdown';
import { CheckInInstructions, CancellationPolicy } from './components/InfoPanels';
import { OrderNotFound } from './components/OrderNotFound';

export const metadata: Metadata = {
  title: 'Booking confirmed',
  robots: { index: false, follow: false },
};

// Orders are never cached — always reflect the latest payment/status.
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

/** Total guests across all line items. */
function partySize(order: OrderSummary): number {
  return order.items.reduce((sum, item) => sum + item.quantity, 0);
}

const STATUS_LABELS: Record<OrderSummary['status'], string> = {
  UPCOMING: 'Upcoming',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No show',
};

const STATUS_STYLES: Record<OrderSummary['status'], string> = {
  UPCOMING: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  COMPLETED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  CANCELLED: 'bg-red-50 text-red-700 ring-red-600/20',
  NO_SHOW: 'bg-amber-50 text-amber-700 ring-amber-600/20',
};

function Shell({ children }: { children: React.ReactNode }) {
  const brand = getBrand();
  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

export default async function ConfirmationPage({
  searchParams,
}: {
  // Next 14 may provide searchParams as a promise; await handles both shapes.
  searchParams: SearchParams | Promise<SearchParams>;
}) {
  const params = await Promise.resolve(searchParams);
  const orderNumber = firstParam(params.order) ?? firstParam(params.orderNumber);
  const brand = getBrand();

  if (!orderNumber) {
    return (
      <Shell>
        <OrderNotFound
          title="No booking selected"
          message="We couldn't find a booking reference in this link. Look up your booking with your order number to see your confirmation."
        />
      </Shell>
    );
  }

  let order: OrderSummary | null = null;
  let notFound = false;
  let serviceError = false;

  try {
    order = await getOrder(orderNumber);
  } catch (err) {
    if (isApiError(err) && err.status === 404) {
      notFound = true;
    } else {
      serviceError = true;
    }
  }

  if (notFound || !order) {
    return (
      <Shell>
        <OrderNotFound
          orderNumber={orderNumber}
          title={serviceError ? 'Booking temporarily unavailable' : 'Booking not found'}
          message={
            serviceError
              ? "We couldn't load this booking right now. Please try again in a moment, or look it up again with your order number."
              : "We couldn't find a booking with that reference. Double-check your order number, or look up your booking to try again."
          }
        />
      </Shell>
    );
  }

  const guests = partySize(order);
  const isCancelled = order.status === 'CANCELLED';

  return (
    <Shell>
      <div className="mx-auto max-w-3xl px-4 py-10">
        {/* Success header */}
        <div className="text-center">
          <div
            className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full text-white shadow-sm"
            style={{ backgroundColor: 'var(--brand-color)' }}
            aria-hidden
          >
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            {isCancelled ? 'Booking cancelled' : "You're all set!"}
          </h1>
          <p className="mt-2 text-slate-600">
            {isCancelled
              ? 'This reservation has been cancelled. Below is a record of the booking.'
              : `Your reservation with ${brand.name} is confirmed. A copy has been sent to ${order.customerEmail}.`}
          </p>
        </div>

        {/* Order number + status + QR */}
        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-center sm:text-left">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Order number
              </p>
              <p className="mt-1 font-mono text-2xl font-bold tracking-tight text-slate-900">
                {order.orderNumber}
              </p>
              <span
                className={`mt-3 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${STATUS_STYLES[order.status]}`}
              >
                {STATUS_LABELS[order.status]}
              </span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <QrPlaceholder value={order.orderNumber} />
              <p className="text-xs text-slate-400">Show this at check-in</p>
            </div>
          </div>
        </section>

        {/* Reservation details */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Reservation</h2>
            <span className="text-sm text-slate-500">
              {guests} {guests === 1 ? 'guest' : 'guests'} in party
            </span>
          </div>

          <ul className="mt-4 divide-y divide-slate-100">
            {order.items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-4 py-4">
                <div>
                  <p className="font-medium text-slate-900">{item.activityName}</p>
                  <p className="mt-0.5 text-sm text-slate-500">{item.rateName}</p>
                  <p className="mt-2 text-sm text-slate-700">
                    {formatLongDate(item.datetime)}
                  </p>
                  <p className="text-sm text-slate-700">{formatTime(item.datetime)}</p>
                </div>
                <div className="shrink-0 text-right text-sm text-slate-500">
                  {item.quantity} {item.quantity === 1 ? 'guest' : 'guests'}
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-2 border-t border-slate-200 pt-4 text-sm text-slate-600">
            <span className="font-medium text-slate-700">Reserved for </span>
            {order.customerName}
          </div>
        </section>

        {/* Price breakdown */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-base font-semibold text-slate-900">
            Payment summary
          </h2>
          <PriceBreakdown order={order} />
        </section>

        {/* Info panels */}
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <CheckInInstructions brandName={brand.name} />
          <CancellationPolicy brandName={brand.name} />
        </div>

        <p className="mt-8 text-center text-sm text-slate-500">
          Need to make a change?{' '}
          <a
            href="/lookup"
            className="font-medium underline-offset-2 hover:underline"
            style={{ color: 'var(--brand-color)' }}
          >
            Look up your booking
          </a>
          .
        </p>
      </div>
    </Shell>
  );
}
