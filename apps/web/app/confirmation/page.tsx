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
import { formatLongDate, formatTime, formatUSD } from '@/lib/format';
import { getOrder } from '@/lib/orders';
import { isApiError, type OrderSummary } from '@/lib/api';
import { getBrandAsync, brandStyle } from '@/lib/brand';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';
import { QrPlaceholder } from './components/QrPlaceholder';
import { CheckinQr } from './components/CheckinQr';
import { PriceBreakdown } from './components/PriceBreakdown';
import { CheckInInstructions, CancellationPolicy } from './components/InfoPanels';
import { OrderNotFound } from './components/OrderNotFound';
import { AddToCalendar } from './components/AddToCalendar';

// Title carries the operator brand (e.g. "Booking confirmed · Lake Sonoma
// Marina") so the tab reads as the operator on the confirmation screen too,
// resolved from the operator record with env/base fallback.
export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrandAsync();
  return {
    // Already fully branded — opt out of the root title.template so the operator
    // name is not appended twice.
    title: { absolute: `Booking confirmed · ${brand.name}` },
    robots: { index: false, follow: false },
  };
}

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

// Estate: status colors appear only on status — text tokens over the quiet
// surface, framed by the one hairline. No tinted pill backgrounds.
const STATUS_STYLES: Record<OrderSummary['status'], string> = {
  UPCOMING: 'text-success ring-hairline',
  COMPLETED: 'text-muted ring-hairline',
  CANCELLED: 'text-danger ring-hairline',
  NO_SHOW: 'text-warn ring-hairline',
};

async function Shell({ children }: { children: React.ReactNode }) {
  const brand = await getBrandAsync();
  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="flex-1">{children}</main>
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
  // The order number alone is enumerable, so the API gates the lookup on the email
  // the booking was made under. The checkout redirect carries it (?email=), so the
  // guest lands on their own confirmation; a bare link with no email 404s like any
  // other unproven lookup, which is the point.
  const email = firstParam(params.email);
  const brand = await getBrandAsync();

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

  if (!email) {
    // No identity proof in the link — treat as not-found rather than attempting an
    // ungated fetch (which the API would reject anyway).
    notFound = true;
  } else {
    try {
      order = await getOrder(orderNumber, email);
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        notFound = true;
      } else {
        serviceError = true;
      }
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
  // Items whose activity requires a liability waiver but has no signature on file
  // yet — e.g. reserve-mode or phone bookings that skipped the inline checkout
  // waiver. Each gets a link to the standalone clause-level signer.
  const unsignedWaiverItems = isCancelled
    ? []
    : order.items.filter((item) => item.waiverRequired && !item.waiverSigned);
  // Reserve-now / pay-at-the-marina: nothing charged online, full amount owed on
  // arrival. Drives the "what to bring / due at the marina" messaging below.
  const isReserveOnly =
    !isCancelled && order.amountPaidCents === 0 && order.balanceDueCents > 0;
  const balanceDueLabel = isReserveOnly ? formatUSD(order.balanceDueCents) : undefined;

  return (
    <Shell>
      <div className="mx-auto max-w-3xl px-4 py-10">
        {/* Success header — the tick is drawn in the success token (Estate:
            confirmed state), never the operator brand color (chrome decision). */}
        <div className="text-center">
          <div
            className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-success text-white"
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
          <h1 className="font-display text-[28px] leading-[1.2] tracking-[0.02em] text-ink sm:text-4xl">
            {isCancelled ? 'Booking cancelled' : "You're all set"}
          </h1>
          <p className="mx-auto mt-3 max-w-xl leading-[1.55] text-muted">
            {isCancelled
              ? 'This reservation has been cancelled. Below is a record of the booking.'
              : isReserveOnly
                ? `Your spot with ${brand.name} is reserved. Nothing was charged today — ${balanceDueLabel} is due when you arrive. A copy has been sent to ${order.customerEmail}.`
                : `Your reservation with ${brand.name} is confirmed. A copy has been sent to ${order.customerEmail}.`}
          </p>
        </div>

        {/* Order number + status + QR */}
        <section className="mt-8 rounded-card border border-hairline bg-surface p-6 shadow-card">
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-center sm:text-left">
              <p className="text-[13px] font-medium uppercase tracking-wide text-muted">
                Order number
              </p>
              <p className="tnum mt-1 text-2xl font-semibold tracking-[0.04em] text-ink">
                {order.orderNumber}
              </p>
              <span
                className={`mt-3 inline-flex items-center rounded-lg bg-bg px-2.5 py-1 text-[13px] font-medium ring-1 ring-inset ${STATUS_STYLES[order.status]}`}
              >
                {STATUS_LABELS[order.status]}
              </span>
            </div>
            <div className="flex flex-col items-center gap-2">
              {/* A real, HMAC-signed, scannable check-in QR for the primary booked
                  item. Cancelled orders (or the rare item-less order) fall back to
                  the plain visual placeholder — there's nothing to check in. */}
              {!isCancelled && order.items[0] ? (
                <CheckinQr orderNumber={order.orderNumber} orderItemId={order.items[0].id} />
              ) : (
                <QrPlaceholder value={order.orderNumber} />
              )}
              <p className="text-[13px] text-muted">Show this at check-in</p>
            </div>
          </div>
        </section>

        {/* Waiver call-to-action — only when a signature is still outstanding
            (the inline checkout waiver usually covers this; reserve-mode and
            phone bookings are the ones that land here unsigned). */}
        {unsignedWaiverItems.length > 0 ? (
          <section className="mt-6 rounded-card border border-hairline bg-surface p-6 shadow-card">
            <h2 className="font-display text-[19px] tracking-[0.02em] text-ink">
              One more step: sign your waiver
            </h2>
            <p className="mt-1 text-sm text-muted">
              Every rental needs a signed liability waiver before you get on the
              water. Sign now on your phone and skip the paperwork at check-in.
            </p>
            <ul className="mt-4 space-y-2">
              {unsignedWaiverItems.map((item) => (
                <li key={item.id}>
                  <a
                    href={`/waiver/${item.id}`}
                    className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-[15px] font-semibold text-white transition-opacity hover:opacity-90 sm:w-auto"
                  >
                    Sign waiver
                    {unsignedWaiverItems.length > 1 ? ` — ${item.activityName}` : ' now'}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Reservation details */}
        <section className="mt-6 rounded-card border border-hairline bg-surface p-6 shadow-card">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-[19px] tracking-[0.02em] text-ink">Reservation</h2>
            <span className="text-sm text-muted">
              <span className="tnum">{guests}</span> {guests === 1 ? 'guest' : 'guests'} in party
            </span>
          </div>

          <ul className="mt-4 divide-y divide-hairline">
            {order.items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-4 py-4">
                <div>
                  <p className="font-medium text-ink">{item.activityName}</p>
                  <p className="mt-0.5 text-sm text-muted">{item.rateName}</p>
                  <p className="tnum mt-2 text-sm text-ink">
                    {formatLongDate(item.datetime)}
                  </p>
                  <p className="tnum text-sm text-ink">{formatTime(item.datetime)}</p>
                </div>
                <div className="tnum shrink-0 text-right text-sm text-muted">
                  {item.quantity} {item.quantity === 1 ? 'guest' : 'guests'}
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-2 border-t border-hairline pt-4 text-sm text-muted">
            <span className="font-medium text-ink">Reserved for </span>
            {order.customerName}
          </div>

          {/* Add-to-calendar links for the (primary) booked activity. Hidden on
              cancelled orders — no point putting a dead trip on a calendar. */}
          {!isCancelled && order.items[0] ? (
            <AddToCalendar
              item={order.items[0]}
              orderNumber={order.orderNumber}
              brandName={brand.name}
            />
          ) : null}
        </section>

        {/* Price breakdown */}
        <section className="mt-6 rounded-card border border-hairline bg-surface p-6 shadow-card">
          <h2 className="mb-4 font-display text-[19px] tracking-[0.02em] text-ink">
            Payment summary
          </h2>
          <PriceBreakdown order={order} />
        </section>

        {/* Info panels */}
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <CheckInInstructions brandName={brand.name} balanceDueLabel={balanceDueLabel} />
          <CancellationPolicy brandName={brand.name} />
        </div>

        <p className="mt-8 text-center text-sm text-muted">
          Need to make a change?{' '}
          <a
            href="/account"
            className="font-medium text-accent-ink underline-offset-2 hover:underline"
          >
            Look up your booking
          </a>
          .
        </p>
      </div>
    </Shell>
  );
}
