import Link from 'next/link';
import dynamic from 'next/dynamic';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import {
  getActivity,
  getAvailabilityRange,
  getOperatorPublic,
  isApiError,
  type ActivityDetail,
  type AvailabilityRangeDay,
} from '@/lib/api';
import { getBrandAsync, brandStyle } from '@/lib/brand';
import { formatUSD } from '@/lib/format';
import { operatorDayISO } from '@/lib/operatorDay';
import { BookingWidget } from '@/components/activity/BookingWidget';
import { InquiryPanel } from '@/components/activity/InquiryPanel';

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
  /**
   * Departures-board deep link: `?date=YYYY-MM-DD&slot=<timeslotId>&rate=<rateId>`
   * preselects the booking card so board tap → checkout is two taps. Stale or
   * sold-out params degrade silently inside the widget.
   */
  searchParams: { date?: string; slot?: string; rate?: string };
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
 * Make the first booking control work before React exists.
 *
 * On a throttled phone the booking widget is painted and looks live for many seconds
 * before its JavaScript has arrived — measured at 3.3s to paint against 42.3s to
 * hydrate on Slow 4G (docs/PERFORMANCE.md §3). A tap in that window is dispatched to
 * nothing: React 18 replays events that land *during* hydration, but not ones that land
 * before its runtime has executed at all. The guest taps a rate card, nothing happens,
 * and the funnel is dead on arrival on exactly the connection this product is for.
 *
 * The previous attempt at this queued the tap and re-applied it once something was
 * listening. That is the wrong shape: it still makes the guest wait for hydration, it
 * has to guess how long to keep trying, and its 15s cap expired 24s before React ran.
 * A queue cannot beat a wall that far out.
 *
 * So the group is driven directly instead. This script IS the radiogroup until React
 * takes over: a delegated click sets `aria-checked` on the tapped control, clears its
 * siblings, and leaves the choice on the group for the component to adopt when it
 * mounts. The control responds in the same frame as the tap, on a page with no
 * application JavaScript yet at all.
 *
 * Kept deliberately narrow, because a document-wide click driver is a menace otherwise:
 *
 *   - only inside a group that opted in with `data-prehydration-radiogroup`, and only
 *     `role="radio"` children of it — nothing here can fire a navigation or change a
 *     party size;
 *   - selecting a radio is idempotent and reversible, which is what makes it safe to do
 *     without the application's agreement;
 *   - it goes silent the instant the group reports `data-hydrated="true"`, so React is
 *     the single writer of that attribute for the rest of the page's life;
 *   - it never touches `tabindex` or focus. The controls are real `<button>`s, so Tab
 *     and Enter/Space already work, and roving tabindex that React would not maintain
 *     afterwards would leave the group *less* keyboard-navigable than it is now.
 *
 * The selected *look* comes from the stylesheet below rather than from here, so the
 * script writes semantics only and there is one place that decides what selected means.
 *
 * Inline and parse-blocking on purpose: ~20 lines that must be listening before the
 * widget's markup is parsed, which is the whole point.
 */
const PRE_HYDRATION_RADIOS = `
(function () {
  var GROUP = '[data-prehydration-radiogroup]';
  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;
    var radio = el.closest('[role="radio"]');
    if (!radio || radio.disabled) return;
    var group = radio.closest(GROUP);
    if (!group || group.getAttribute('data-hydrated') === 'true') return;
    var radios = group.querySelectorAll('[role="radio"]');
    var index = -1;
    for (var i = 0; i < radios.length; i++) {
      var on = radios[i] === radio;
      if (on) index = i;
      radios[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
    // Position, not id: the group's markup belongs to the component inside it and
    // carries no identifier. Reading it back by index is what lets the choice the
    // guest already made survive hydration instead of being reset to nothing.
    group.setAttribute('data-preselected', String(index));
  });
})();
`;

/**
 * What "selected" looks like before React can say so: the same sage accent the
 * hydrated RateCards paint, so the tap's feedback never changes color mid-load.
 *
 * `!important` guarantees the win over the Tailwind border utilities on the card
 * regardless of stylesheet order. Scoped to `data-hydrated="false"` so it applies
 * only while nothing else is painting the group — the moment React takes over,
 * this rule stops matching and the component's own styling is unopposed.
 */
const PRE_HYDRATION_STYLES = `
[data-prehydration-radiogroup][data-hydrated='false'] [role='radio'][aria-checked='true'] {
  border-color: var(--accent, #5f7a5a) !important;
}
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
  const brand = await getBrandAsync();
  try {
    const activity = await getActivity(params.id);
    return {
      // Already fully branded — opt out of the root title.template so the operator
      // name is not appended twice.
      title: { absolute: `${activity.name} · ${brand.name}` },
      description:
        activity.descriptionHtml?.replace(/<[^>]+>/g, '').slice(0, 160) ??
        `Book ${activity.name} with ${brand.name}.`,
    };
  } catch {
    return { title: { absolute: brand.name } };
  }
}

/** Days the date strip shows first; mirrors STRIP_DAYS in AvailabilityCalendar. */
const STRIP_DAYS = 14;

/**
 * Availability for the strip window, fetched here so the page ships with its dates
 * already selectable. Never fatal: if it fails the calendar just loads them itself,
 * exactly as it did before.
 *
 * `timeZone` is the operator's, so the seeded window starts on the same local day
 * the client strip does rather than on the UTC day the server happens to be in
 * (`operatorDayISO`, shared with the client widgets — see lib/operatorDay).
 */
async function loadStripRange(
  activityId: string,
  timeZone: string,
): Promise<AvailabilityRangeDay[] | undefined> {
  try {
    return await getAvailabilityRange(
      activityId,
      operatorDayISO(timeZone, 0),
      operatorDayISO(timeZone, STRIP_DAYS - 1),
    );
  } catch {
    return undefined;
  }
}

/**
 * Estate override for this surface (same pattern as checkout): the operator
 * brand color paints no chrome, so anything var-driven — focus rings, the
 * pre-hydration selected border — resolves to the sage accent instead.
 */
const ESTATE_VARS = {
  ['--brand-color' as string]: 'var(--accent)',
  ['--brand-foreground' as string]: '#ffffff',
  ['--brand-text' as string]: 'var(--accent-ink)',
} as React.CSSProperties;

export default async function ActivityDetailPage({ params, searchParams }: PageProps) {
  const activity = await loadActivity(params.id);
  if (!activity) notFound();

  // The operator's timezone decides which calendar day the strip starts on, so seed the
  // availability window in that zone rather than the server's UTC day. Never fatal: on a
  // failed lookup the strip falls back to a client fetch exactly as before.
  const operatorTimeZone = await getOperatorPublic()
    .then((op) => op.timezone)
    .catch(() => 'America/Los_Angeles');
  const initialRange = await loadStripRange(activity.id, operatorTimeZone);

  const brand = await getBrandAsync();
  const categoryLabel = CATEGORY_LABELS[activity.category];
  // Bookable online only when there is a real rate to charge. Otherwise the page
  // offers an inquiry path (call the marina) rather than a dead booking widget.
  const bookable = activity.fromPriceCents != null && activity.rates.length > 0;

  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{ ...brandStyle(brand), ...ESTATE_VARS }}
      // The generous bottom padding below lg clears the widget's fixed mobile
      // price+CTA bar; DESIGN.md max content width is 1120px with 24px gutters.
      className="mx-auto w-full max-w-[1120px] px-6 py-8 pb-28 lg:pb-12"
    >
      <style dangerouslySetInnerHTML={{ __html: PRE_HYDRATION_STYLES }} />
      <script dangerouslySetInnerHTML={{ __html: PRE_HYDRATION_RADIOS }} />

      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-5 text-sm text-muted">
        <Link href="/" className="transition-colors hover:text-ink">
          Book
        </Link>
        <span className="mx-2" aria-hidden>
          /
        </span>
        <span className="text-ink">{activity.name}</span>
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
      {/* Airbnb anatomy (DESIGN.md speed mechanics #2): photos + specs left at
          ~64%, the sticky booking card right at ~32%. */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[auto_auto_1fr]">
        <header className="min-w-0 lg:col-start-1 lg:row-start-2">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-muted">
            {categoryLabel}
          </p>
          <h1 className="mt-2 font-display text-[28px] leading-[1.2] tracking-[0.02em] text-ink">
            {activity.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span className="tnum">
              {activity.minParticipants === activity.maxParticipants
                ? `${activity.maxParticipants} guests`
                : `${activity.minParticipants}–${activity.maxParticipants} guests`}
            </span>
            {activity.fromPriceCents != null && (
              <span className="tnum font-medium text-ink">
                from {formatUSD(activity.fromPriceCents)}
              </span>
            )}
            {activity.waiverRequired && (
              <span className="flex items-center gap-1">
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
            without scrolling past a full-bleed hero. Sticky alongside on desktop.
            Activities with no online rate (e.g. the Grand Patio, "Pricing soon")
            have no bookable funnel, so they show an inquiry panel with the marina's
            phone instead of a booking widget that leads nowhere. */}
        <div className="min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-3 lg:sticky lg:top-8 lg:self-start">
          {bookable ? (
            <BookingWidget
              activity={activity}
              initialRange={initialRange}
              timeZone={operatorTimeZone}
              preselect={searchParams}
              stickyMobileCta
            />
          ) : (
            <InquiryPanel activityName={activity.name} phone={brand.phone} />
          )}
        </div>

        {/* Media. Below the fold on a phone, and its client chunk is loaded lazily for
            the same reason: nothing here is needed to make the first booking choice. */}
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <PhotoGallery photoUrls={activity.photoUrls} name={activity.name} />
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-3">
          {/* Description */}
          {activity.descriptionHtml ? (
            <div className="max-w-none text-ink">
              <h2 className="mb-2 font-display text-[22px] tracking-[0.02em] text-ink">
                About this experience
              </h2>
              <div
                className="space-y-3 leading-[1.55] [&_a]:text-accent-ink [&_a]:underline [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1"
                // Description is operator-authored rich text stored as sanitized HTML.
                dangerouslySetInnerHTML={{ __html: activity.descriptionHtml }}
              />
            </div>
          ) : (
            <div>
              <h2 className="mb-2 font-display text-[22px] tracking-[0.02em] text-ink">
                About this experience
              </h2>
              <p className="leading-[1.55] text-muted">
                Reserve {activity.name} for up to {activity.maxParticipants} guests. Choose a
                rate, date, and time to book.
              </p>
            </div>
          )}

          {/* Policy note (white-label, pulled from activity config) */}
          <p className="border-t border-hairline pt-4 text-sm text-muted">
            Free self-reschedule up to{' '}
            <span className="tnum">{activity.selfRescheduleHours}</span> hours before your
            start time.
          </p>
        </div>
      </div>
    </main>
  );
}
