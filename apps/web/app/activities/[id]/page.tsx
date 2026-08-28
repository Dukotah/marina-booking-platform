import Link from 'next/link';
import dynamic from 'next/dynamic';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getActivity, isApiError, type ActivityDetail } from '@/lib/api';
import { getBrand, brandStyle } from '@/lib/brand';
import { formatUSD } from '@/lib/format';
import { BookingWidget } from '@/components/activity/BookingWidget';

/**
 * The gallery is still server-rendered (so the layout is stable and the placeholder or
 * first photo paints with the document) but its interactivity — thumbnails, arrows,
 * arrow-key navigation — arrives in its own chunk instead of the route's first JS
 * payload. Nothing in it is needed to choose a rate, a date or a time, which is all the
 * throttled funnel budget is spent on.
 */
const PhotoGallery = dynamic(() =>
  import('@/components/activity/PhotoGallery').then((m) => m.PhotoGallery),
);

/**
 * Activity detail + booking page (customer portal).
 *
 * Server component: fetches the activity for the resolved tenant and renders a
 * photo gallery, description, and the interactive booking widget (rate cards +
 * availability calendar + time-slot picker). White-label only — all naming and
 * the accent color come from operator/activity data, never platform branding.
 */

interface PageProps {
  params: { id: string };
}

/** Human label for an activity category (sentence case, no platform terms). */
const CATEGORY_LABELS: Record<ActivityDetail['category'], string> = {
  BOAT: 'Boat rental',
  WATERCRAFT: 'Watercraft',
  PATIO: 'Waterfront venue',
  LODGING: 'Lodging',
  TOUR: 'Guided tour',
  CLASS: 'Class',
  EVENT: 'Event',
  EQUIPMENT: 'Equipment rental',
  OTHER: 'Experience',
};

/**
 * Bridge the gap between "the control is painted" and "React is listening".
 *
 * On a throttled phone the booking widget is on screen and looks live long before its
 * JavaScript has arrived, and a tap in that window is simply thrown away: the browser
 * dispatches it, nothing is subscribed, and the guest is left staring at a rate card
 * that did not select. React 18 replays events that land *during* hydration, but not
 * ones that land before its runtime has executed at all — which on Slow 4G is the
 * entire first several seconds of the page's life.
 *
 * So the document itself remembers the tap and re-applies it once something is
 * listening. Deliberately narrow, because a blind replay of arbitrary clicks would be a
 * menace — a queued "Continue to checkout" firing late is a navigation the guest did not
 * ask for, and a queued "Increase guests" is a wrong party size:
 *
 *   - only `role="radio"` controls, whose activation is idempotent (choosing the same
 *     rate twice is choosing it once) and which carry an unambiguous success signal in
 *     `aria-checked`;
 *   - it stops the instant `aria-checked` flips, so a hydrated app is never clicked twice;
 *   - any later real tap supersedes the queued one, so a guest who changes their mind
 *     while waiting gets what they asked for second, not first;
 *   - it gives up 4s after the document finishes loading (hydration gets a grace period,
 *     because the last byte arriving is not the same as React running), and 15s after the
 *     tap regardless — a selection applied later than that would startle a guest more
 *     than the lost tap did.
 *
 * Inline and parse-blocking on purpose: it is ~20 lines and it has to be listening
 * before the widget's markup is parsed, which is the whole point.
 */
const REPLAY_EARLY_TAPS = `
(function () {
  var CAP_MS = 15000, GRACE_MS = 4000;
  var pending = null, cap = 0, settledAt = 0, timer = 0;
  function stop() { pending = null; settledAt = 0; if (timer) { clearInterval(timer); timer = 0; } }
  function retry() {
    if (!pending || !pending.isConnected || Date.now() > cap) return stop();
    if (pending.getAttribute('aria-checked') === 'true') return stop();
    // Keep going while scripts are still arriving; once the page is fully loaded,
    // give hydration a short grace period and then accept that nothing is coming.
    if (document.readyState === 'complete') {
      if (!settledAt) settledAt = Date.now();
      else if (Date.now() - settledAt > GRACE_MS) return stop();
    } else {
      settledAt = 0;
    }
    pending.click();
  }
  document.addEventListener('pointerdown', function (e) {
    if (!e.isTrusted) return;
    stop();
    var el = e.target && e.target.closest && e.target.closest('[role="radio"]');
    if (!el || el.disabled || el.getAttribute('aria-checked') === 'true') return;
    pending = el;
    cap = Date.now() + CAP_MS;
    timer = setInterval(retry, 150);
  }, true);
})();
`;

async function loadActivity(id: string): Promise<ActivityDetail | null> {
  try {
    return await getActivity(id);
  } catch (err) {
    if (isApiError(err) && err.status === 404) return null;
    // Re-throw other errors so the route-level error boundary handles them.
    throw err;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const brand = getBrand();
  try {
    const activity = await getActivity(params.id);
    return {
      title: `${activity.name} · ${brand.name}`,
      description:
        activity.descriptionHtml?.replace(/<[^>]+>/g, '').slice(0, 160) ??
        `Book ${activity.name} with ${brand.name}.`,
    };
  } catch {
    return { title: brand.name };
  }
}

export default async function ActivityDetailPage({ params }: PageProps) {
  const activity = await loadActivity(params.id);
  if (!activity) notFound();

  const brand = getBrand();
  const accent = activity.color;
  const categoryLabel = CATEGORY_LABELS[activity.category];

  return (
    <main style={brandStyle(brand)} className="mx-auto w-full max-w-6xl px-4 py-8">
      <script dangerouslySetInnerHTML={{ __html: REPLAY_EARLY_TAPS }} />

      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-5 text-sm text-slate-500">
        <Link href="/" className="transition-colors hover:text-slate-900">
          Book
        </Link>
        <span className="mx-2" aria-hidden>
          /
        </span>
        <span className="text-slate-700">{activity.name}</span>
      </nav>

      {/*
       * Tracks are `minmax(0, …)`, never a bare `fr`, and every child carries `min-w-0`.
       *
       * A bare `1fr` track is `minmax(auto, 1fr)`, so its floor is the *min-content* width
       * of whatever it holds. The booking widget contains a 14-day horizontal strip whose
       * content is ~1050px wide by design, and that floor propagated all the way up: the
       * whole booking route laid out 1140px wide inside a 412px phone. Capping the track
       * floor at 0 is what lets the scroller scroll instead of pushing the page sideways.
       *
       * Source order is the MOBILE order — what is booked, then the thing that books it,
       * then the supporting material — so a phone's reading and tab order match what is on
       * screen with no `order` juggling. The desktop arrangement (media above the title in
       * the left column, widget alongside) is restored by explicit line placement at `lg`,
       * which leaves the two-column layout exactly as it was.
       */}
      {/* `lg:grid-rows-[auto_auto_1fr]`: the widget spans all three rows and is normally
          the tallest thing on the page, so without this the leftover height is shared
          out between the rows and the media, title and description drift apart. Pinning
          the first two rows to their content and letting the last one absorb the slack
          keeps the left column reading exactly as it did before. */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:grid-rows-[auto_auto_1fr]">
        <header className="min-w-0 lg:col-start-1 lg:row-start-2">
          <span
            className="inline-block rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-white"
            style={{ backgroundColor: accent }}
          >
            {categoryLabel}
          </span>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
            {activity.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
            <span>
              {activity.minParticipants === activity.maxParticipants
                ? `${activity.maxParticipants} guests`
                : `${activity.minParticipants}–${activity.maxParticipants} guests`}
            </span>
            {activity.fromPriceCents != null && (
              <span className="font-medium text-slate-900">
                from {formatUSD(activity.fromPriceCents)}
              </span>
            )}
            {activity.waiverRequired && (
              <span className="flex items-center gap-1 text-slate-500">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                Waiver required
              </span>
            )}
          </div>
        </header>

        {/* The booking widget: second on a phone, so the first control is reachable
            without scrolling past a full-bleed hero. Sticky alongside on desktop. */}
        <div className="min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-3 lg:sticky lg:top-20 lg:self-start">
          <BookingWidget activity={activity} />
        </div>

        {/* Media. Below the fold on a phone, and its client chunk is loaded lazily for
            the same reason: nothing here is needed to make the first booking choice. */}
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <PhotoGallery
            photoUrls={activity.photoUrls}
            name={activity.name}
            accentColor={accent}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-3">
          {/* Description */}
          {activity.descriptionHtml ? (
            <div className="max-w-none text-slate-700">
              <h2 className="mb-2 text-lg font-semibold text-slate-900">About this experience</h2>
              <div
                className="space-y-3 leading-relaxed [&_a]:text-[color:var(--brand-color)] [&_a]:underline [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1"
                // Description is operator-authored rich text stored as sanitized HTML.
                dangerouslySetInnerHTML={{ __html: activity.descriptionHtml }}
              />
            </div>
          ) : (
            <div>
              <h2 className="mb-2 text-lg font-semibold text-slate-900">About this experience</h2>
              <p className="text-slate-600">
                Reserve {activity.name} for up to {activity.maxParticipants} guests. Choose a
                rate, date, and time to book.
              </p>
            </div>
          )}

          {/* Policy note (white-label, pulled from activity config) */}
          <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Free self-reschedule up to {activity.selfRescheduleHours} hours before your
            start time.
          </p>
        </div>
      </div>
    </main>
  );
}
