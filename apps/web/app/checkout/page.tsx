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
import type { Metadata } from 'next';
import Link from 'next/link';
import { getActivity, getAvailability, isApiError } from '@/lib/api';
import { getBrandAsync } from '@/lib/brand';
import { getPaymentConfig } from './payment-config';
import { getWalletConfig } from './wallet-config';
import { CheckoutClient } from '@/components/checkout/CheckoutClient';
import type { CheckoutSelection } from '@/components/checkout/types';

export const dynamic = 'force-dynamic';

// The tab must read "Checkout · <operator>", like every other titled page. Without a
// title here Next falls back to the root layout's default (the bare operator name), so
// the checkout tab was indistinguishable from the home tab. A plain string title flows
// through the root `title.template` (`%s · <operator>`), which appends the brand — so
// this is only the leaf word, not the whole phrase. `noindex` because a checkout URL
// carries a specific booking selection and is not a page to index.
export function generateMetadata(): Metadata {
  return {
    title: 'Checkout',
    robots: { index: false, follow: false },
  };
}

interface CheckoutPageProps {
  searchParams: {
    activityId?: string;
    rateId?: string;
    timeslotId?: string;
    date?: string;
    quantity?: string;
  };
}

/**
 * Estate override for the checkout surface: the operator brand color paints no
 * chrome (2026-09-07 decision), so everything var-driven inside checkout — the
 * submit button, tip chips, focus rings — resolves to the sage accent instead.
 * White label text on sage is permitted at >=15px/600, which the submit meets.
 */
const ESTATE_VARS = {
  ['--brand-color' as string]: 'var(--accent)',
  ['--brand-foreground' as string]: '#ffffff',
  ['--brand-text' as string]: 'var(--accent-ink)',
} as React.CSSProperties;

/** A friendly, branded error frame for unrecoverable checkout entry states. */
function CheckoutProblem({ title, body }: { title: string; body: string }) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={ESTATE_VARS}
      className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-6 py-16"
    >
      <h1 className="font-display text-[28px] leading-[1.2] tracking-[0.02em] text-ink">{title}</h1>
      <p className="leading-[1.55] text-muted">{body}</p>
      <Link
        href="/"
        className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-bg transition hover:opacity-90"
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
    // The tax + processing + surcharge fees the API will apply, so the checkout
    // total the guest commits to equals the confirmation total. Absent on older
    // API responses => no fees passed => breakdown labels the figure an estimate.
    fees: activity.fees ?? [],
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

  // Provider config resolved from the API (env fallback) — see payment-config.ts.
  const { stripe, paymentMode } = await getPaymentConfig();
  const brand = await getBrandAsync();
  // Wallet-pay sheet shows the operator as the merchant, not the env-default brand.
  const wallet = getWalletConfig(brand.name);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={ESTATE_VARS}
      className="mx-auto w-full max-w-5xl px-6 py-6 sm:py-10"
    >
      <header className="mb-8">
        <Link
          href="/"
          className="text-sm font-medium text-muted transition-colors hover:text-ink"
        >
          &larr; Continue browsing
        </Link>
        <h1 className="mt-3 font-display text-[28px] leading-[1.2] tracking-[0.02em] text-ink">
          Checkout
        </h1>
        <p className="mt-1 text-sm text-muted">
          {paymentMode === 'reserve'
            ? 'Review your reservation, add guest details, and reserve your spot. Pay when you arrive at the marina.'
            : 'Review your reservation, add guest details, and pay securely.'}
        </p>
      </header>

      <CheckoutClient
        selection={selection}
        stripe={stripe}
        paymentMode={paymentMode}
        wallet={wallet}
        operatorName={brand.name}
      />
    </main>
  );
}
