/**
 * The embedded booking experience — the whole funnel, in one route.
 *
 * `public/embed.js` points an iframe here from the operator's own website. Every
 * step (catalog → activity → checkout → confirmation) is this same route with a
 * different query string, which is what lets the embed layout — and the host
 * bridge inside it — stay mounted for the entire booking. See
 * `components/embed/params.ts` for the URL contract and `EmbedRouterProvider` for
 * how the reused portal components are kept inside the frame.
 *
 * Nothing about the booking logic is forked here. The activity step renders the
 * portal's real `BookingWidget`; the checkout step renders the portal's real
 * checkout page component, validation and all; the confirmation step composes the
 * real confirmation pieces (the confirmation *route* is the one thing that cannot
 * be reused whole, because it hardcodes the site header and footer).
 */

import { getActivity, getCatalog, isApiError, type CatalogActivity } from '@/lib/api';
import { getOrder } from '@/lib/orders';
import { getBrand, brandStyle } from '@/lib/brand';
import CheckoutPage from '@/app/checkout/page';
import { EmbedRouterProvider } from '@/components/embed/EmbedRouterProvider';
import { EmbedSession } from '@/components/embed/EmbedSession';
import { EmbedShell } from '@/components/embed/EmbedShell';
import { EmbedCatalog } from '@/components/embed/EmbedCatalog';
import { EmbedActivity } from '@/components/embed/EmbedActivity';
import { EmbedConfirmation } from '@/components/embed/EmbedConfirmation';
import { EmbedNotice } from '@/components/embed/EmbedNotice';
import {
  backTarget,
  buildEmbedHref,
  parseEmbedParams,
  type EmbedParams,
  type EmbedSessionParams,
  type RawParams,
} from '@/components/embed/params';

// Availability and order state must never be served stale to a live widget.
export const dynamic = 'force-dynamic';

interface EmbedPageProps {
  // Next 14 may hand searchParams over as a promise; awaiting covers both shapes.
  searchParams: RawParams | Promise<RawParams>;
}

/** Catalog step: the operator's bookable experiences. */
async function CatalogStep({ brandName, session }: { brandName: string; session: EmbedSessionParams }) {
  let activities: CatalogActivity[] = [];
  try {
    activities = await getCatalog();
  } catch {
    return (
      <EmbedNotice
        title="Booking is temporarily unavailable"
        body="We could not load availability just now. Please try again in a moment."
        actionHref={buildEmbedHref(session, 'catalog')}
      />
    );
  }

  if (activities.length === 0) {
    return (
      <EmbedNotice
        title="Nothing is bookable online yet"
        body={`${brandName} has not published any online experiences. Please get in touch to reserve.`}
      />
    );
  }

  return <EmbedCatalog activities={activities} brandName={brandName} />;
}

/** Activity step: rate, date, time, party size — the portal's own booking widget. */
async function ActivityStep({ params, session }: { params: EmbedParams; session: EmbedSessionParams }) {
  if (!params.activityId) {
    return (
      <EmbedNotice
        title="No experience selected"
        body="Choose what you would like to book to see live availability."
        actionHref={session.locked ? null : buildEmbedHref(session, 'catalog')}
        actionLabel="See what's available"
      />
    );
  }

  try {
    const activity = await getActivity(params.activityId);
    return <EmbedActivity activity={activity} />;
  } catch (err) {
    const missing = isApiError(err) && err.status === 404;
    return (
      <EmbedNotice
        title={missing ? 'This experience is no longer offered' : 'Availability is unavailable'}
        body={
          missing
            ? 'It may have been removed or fully booked for the season.'
            : 'We could not load this experience right now. Please try again in a moment.'
        }
        actionHref={session.locked ? null : buildEmbedHref(session, 'catalog')}
        actionLabel={missing ? 'See what else is available' : 'Try again'}
      />
    );
  }
}

/** Confirmation step: the completed booking, plus the host's `booking-completed` event. */
async function ConfirmationStep({
  params,
  session,
  brandName,
}: {
  params: EmbedParams;
  session: EmbedSessionParams;
  brandName: string;
}) {
  const bookAnotherHref = session.locked
    ? buildEmbedHref(session, 'activity', { activityId: session.activity })
    : buildEmbedHref(session, 'catalog');

  if (!params.order) {
    return (
      <EmbedNotice
        title="No booking to show"
        body="This link is missing a booking reference."
        actionHref={bookAnotherHref}
        actionLabel="Start a booking"
      />
    );
  }

  try {
    const order = await getOrder(params.order);
    return (
      <EmbedConfirmation
        order={order}
        brandName={brandName}
        bookAnotherHref={bookAnotherHref}
      />
    );
  } catch (err) {
    const missing = isApiError(err) && err.status === 404;
    return (
      <EmbedNotice
        title={missing ? 'Booking not found' : 'Booking temporarily unavailable'}
        body={
          missing
            ? `We could not find a booking with the reference ${params.order}.`
            : 'Your booking exists — we just could not load it this second. Check your email for the confirmation.'
        }
        actionHref={bookAnotherHref}
        actionLabel="Start a booking"
      />
    );
  }
}

export default async function EmbedPage({ searchParams }: EmbedPageProps) {
  const raw = await Promise.resolve(searchParams);
  const params = parseEmbedParams(raw);

  const session: EmbedSessionParams = {
    eid: params.eid,
    operator: params.operator,
    activity: params.activity,
    locked: params.locked,
    mode: params.mode,
    accent: params.accent,
  };

  const brand = getBrand();
  // `data-color` on the script tag lets an operator match the widget to their own
  // site without touching their tenant branding.
  const accent = params.accent || brand.color;

  const back = backTarget(session, params.step, params.activityId);

  let content: React.ReactNode;
  switch (params.step) {
    case 'activity':
      content = <ActivityStep params={params} session={session} />;
      break;
    case 'checkout':
      // The real checkout route component: it resolves and re-validates the
      // selection against live availability, then renders the real CheckoutClient
      // with the same Stripe/wallet config the standalone page uses.
      content = (
        <CheckoutPage
          searchParams={{
            activityId: params.activityId,
            rateId: params.rateId,
            timeslotId: params.timeslotId,
            date: params.date,
            quantity: params.quantity,
          }}
        />
      );
      break;
    case 'confirmation':
      content = (
        <ConfirmationStep params={params} session={session} brandName={brand.name} />
      );
      break;
    default:
      content = <CatalogStep brandName={brand.name} session={session} />;
  }

  return (
    <div style={brandStyle({ ...brand, color: accent })} className="w-full bg-white">
      <EmbedSession
        operator={params.operator}
        step={params.step}
        activityId={params.activityId}
      />
      <EmbedRouterProvider session={session}>
        <EmbedShell
          session={session}
          step={params.step}
          brandName={brand.name}
          backHref={back?.href ?? null}
          backLabel={back?.label ?? ''}
        >
          {content}
        </EmbedShell>
      </EmbedRouterProvider>
    </div>
  );
}
