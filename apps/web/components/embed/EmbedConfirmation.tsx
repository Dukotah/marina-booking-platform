'use client';

/**
 * Confirmation step of the embedded widget, and the moment the operator's own
 * analytics has been waiting for: this is where `booking-completed` is posted to
 * the host page.
 *
 * The standalone `/confirmation` route renders the site header and footer, which
 * cannot appear inside somebody else's page, so this step composes the same
 * confirmation pieces (QR placeholder, price breakdown, check-in and cancellation
 * panels) into the embed's frame instead. The order itself is fetched server-side
 * by the route, exactly as the standalone page does.
 */

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import type { OrderSummary } from '@/lib/api';
import { formatLongDate, formatTime } from '@/lib/format';
import { QrPlaceholder } from '@/app/confirmation/components/QrPlaceholder';
import { PriceBreakdown } from '@/app/confirmation/components/PriceBreakdown';
import {
  CheckInInstructions,
  CancellationPolicy,
} from '@/app/confirmation/components/InfoPanels';
import { postToHost, type BookingCompletedPayload } from './protocol';

interface EmbedConfirmationProps {
  order: OrderSummary;
  brandName: string;
  /** Where "book another" goes; null when the widget is pinned to one activity. */
  bookAnotherHref: string | null;
}

function completionPayload(order: OrderSummary): BookingCompletedPayload {
  return {
    orderNumber: order.orderNumber,
    totalCents: order.totalCents,
    currency: 'USD',
    guests: order.items.reduce((sum, item) => sum + item.quantity, 0),
    activityIds: order.items.map((item) => item.activityId),
    activityNames: order.items.map((item) => item.activityName),
  };
}

/**
 * Fire the completion event at most once per order, even if the customer reloads
 * the frame — an operator counting conversions must not be told twice.
 */
function alreadyAnnounced(orderNumber: string): boolean {
  const key = `marina-embed-booked:${orderNumber}`;
  try {
    if (window.sessionStorage.getItem(key)) return true;
    window.sessionStorage.setItem(key, '1');
    return false;
  } catch {
    // Storage is commonly blocked inside a third-party frame; the in-component
    // ref below still covers the normal case.
    return false;
  }
}

export function EmbedConfirmation({
  order,
  brandName,
  bookAnotherHref,
}: EmbedConfirmationProps) {
  const announced = useRef(false);

  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    if (alreadyAnnounced(order.orderNumber)) return;
    postToHost('booking-completed', completionPayload(order));
  }, [order]);

  const guests = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const cancelled = order.status === 'CANCELLED';

  return (
    <div className="px-3 py-5">
      <div className="text-center">
        <div
          className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full text-white shadow-sm"
          style={{ backgroundColor: 'var(--brand-color)' }}
          aria-hidden
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900">
          {cancelled ? 'Booking cancelled' : "You're all set!"}
        </h1>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-slate-600">
          {cancelled
            ? 'This reservation has been cancelled. Below is a record of the booking.'
            : `Your reservation with ${brandName} is confirmed. A copy has been sent to ${order.customerEmail}.`}
        </p>
      </div>

      <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col items-center gap-4 text-center">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Order number
            </p>
            <p className="mt-0.5 font-mono text-xl font-bold tracking-tight text-slate-900">
              {order.orderNumber}
            </p>
          </div>
          <QrPlaceholder value={order.orderNumber} />
          <p className="text-xs text-slate-400">Show this at check-in</p>
        </div>
      </section>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Reservation</h2>
          <span className="text-xs text-slate-500">
            {guests} {guests === 1 ? 'guest' : 'guests'}
          </span>
        </div>
        <ul className="mt-3 divide-y divide-slate-100">
          {order.items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 py-3">
              <div>
                <p className="text-sm font-medium text-slate-900">{item.activityName}</p>
                <p className="mt-0.5 text-xs text-slate-500">{item.rateName}</p>
                <p className="mt-1.5 text-sm text-slate-700">{formatLongDate(item.datetime)}</p>
                <p className="text-sm text-slate-700">{formatTime(item.datetime)}</p>
              </div>
              <span className="shrink-0 text-xs text-slate-500">
                {item.quantity} {item.quantity === 1 ? 'guest' : 'guests'}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-1 border-t border-slate-200 pt-3 text-sm text-slate-600">
          <span className="font-medium text-slate-700">Reserved for </span>
          {order.customerName}
        </div>
      </section>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Payment summary</h2>
        <PriceBreakdown order={order} />
      </section>

      <div className="mt-4 grid gap-4">
        <CheckInInstructions brandName={brandName} />
        <CancellationPolicy brandName={brandName} />
      </div>

      {bookAnotherHref && (
        <Link
          href={bookAnotherHref}
          className="mt-5 flex min-h-[48px] w-full items-center justify-center rounded-xl px-4 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
          style={{ backgroundColor: 'var(--brand-color)' }}
        >
          Book something else
        </Link>
      )}
    </div>
  );
}

export default EmbedConfirmation;
