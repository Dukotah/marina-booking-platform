/**
 * Checkout page (server component).
 *
 * The booking selection arrives as query params from the activity page:
 *   /checkout?activityId=…&rateId=…&timeslotId=…&date=YYYY-MM-DD&quantity=2
 *
 * This component resolves and validates that selection against the live catalog
 * and availability (so a stale/tampered link fails gracefully), then hands a
 * fully-resolved, typed `CheckoutSelection` to the interactive client form. All
 * money is integer cents; nothing here hardcodes operator/platform branding.
 */
import Link from 'next/link';
import { getActivity, getAvailability, isApiError } from '@/lib/api';
import { getBrand } from '@/lib/brand';
import { getStripeConfig } from './stripe-config';
import { CheckoutClient } from '@/components/checkout/CheckoutClient';
import type { CheckoutSelection } from '@/components/checkout/types';

export const dynamic = 'force-dynamic';

interface CheckoutPageProps {
  searchParams: {
    activityId?: string;
    rateId?: string;
    timeslotId?: string;
    date?: string;
    quantity?: string;
  };
}

/** A friendly, branded error frame for unrecoverable checkout entry states. */
function CheckoutProblem({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-4 py-16">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
      <p className="text-slate-600">{body}</p>
      <Link
        href="/"
        className="rounded-md px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
        style={{ backgroundColor: 'var(--brand-color)' }}
      >
        Back to booking
      </Link>
    </main>
  );
}

export default async function CheckoutPage({ searchParams }: CheckoutPageProps) {
  const { activityId, rateId, timeslotId, date } = searchParams;

  if (!activityId || !rateId || !timeslotId || !date) {
    return (
      <CheckoutProblem
        title="Your booking details are incomplete"
        body="Start from an activity and pick a date and time, then continue to checkout."
      />
    );
  }

  // Resolve activity + availability concurrently. Either failing means the link
  // is stale or the API is unavailable; both should fail to a friendly screen.
  let activity;
  let availability;
  try {
    [activity, availability] = await Promise.all([
      getActivity(activityId),
      getAvailability(activityId, date),
    ]);
  } catch (err) {
    if (isApiError(err) && err.status === 404) {
      return (
        <CheckoutProblem
          title="This activity is no longer available"
          body="It may have been removed or is fully booked. Please choose another option."
        />
      );
    }
    return (
      <CheckoutProblem
        title="Checkout is temporarily unavailable"
        body="We could not load your booking details right now. Please go back and try again in a moment."
      />
    );
  }

  const rate = activity.rates.find((r) => r.id === rateId);
  if (!rate) {
    return (
      <CheckoutProblem
        title="That rate is no longer offered"
        body="Please return to the activity and choose an available rate."
      />
    );
  }

  const slot = availability.slots.find((s) => s.timeslotId === timeslotId);
  if (!slot) {
    return (
      <CheckoutProblem
        title="That time is no longer available"
        body="The slot you selected may have just sold out. Please pick another time."
      />
    );
  }
  if (slot.status === 'FULL' || slot.capacityRemaining <= 0) {
    return (
      <CheckoutProblem
        title="That time just sold out"
        body="Please go back and choose another available time."
      />
    );
  }

  // Clamp the requested quantity to what's actually bookable for this slot and
  // within the activity's participant bounds.
  const requestedQty = Number.parseInt(searchParams.quantity ?? '1', 10);
  const safeRequested =
    Number.isFinite(requestedQty) && requestedQty > 0 ? requestedQty : 1;
  const maxQuantity = Math.max(
    1,
    Math.min(slot.capacityRemaining, activity.maxParticipants || slot.capacityRemaining),
  );
  const quantity = Math.min(Math.max(safeRequested, 1), maxQuantity);

  const selection: CheckoutSelection = {
    activityId: activity.id,
    activityName: activity.name,
    category: activity.category,
    color: activity.color,
    waiverRequired: activity.waiverRequired,
    minParticipants: activity.minParticipants,
    maxParticipants: activity.maxParticipants,
    rate: {
      id: rate.id,
      name: rate.name,
      priceCents: rate.priceCents,
      durationMinutes: rate.durationMinutes,
    },
    timeslotId: slot.timeslotId,
    datetime: slot.datetime,
    date,
    quantity,
    maxQuantity,
  };

  const stripe = getStripeConfig();
  const brand = getBrand();

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:py-10">
      <header className="mb-6">
        <Link
          href="/"
          className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
        >
          &larr; Continue browsing
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          Checkout
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Review your reservation, add guest details, and pay securely.
        </p>
      </header>

      <CheckoutClient
        selection={selection}
        stripe={stripe}
        operatorName={brand.name}
      />
    </main>
  );
}
