import Link from 'next/link';
import dynamic from 'next/dynamic';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import {
  getActivity,
  getAvailabilityRange,
  isApiError,
  type ActivityDetail,
  type AvailabilityRangeDay,
} from '@/lib/api';
import { getBrandAsync, brandStyle, onBrandForeground } from '@/lib/brand';
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
 * What "selected" looks like before React can say so.
 *
 * `!important` is load-bearing rather than lazy: the rate cards paint their selected
 * border with an inline `style` driven by React state, and an inline style outranks a
 * stylesheet. Scoped to `data-hydrated="false"` so it applies only while nothing else
 * is painting the group — the moment React takes over, this rule stops matching and
 * the component's own styling is unopposed.
 */
const PRE_HYDRATION_STYLES = `
[data-prehydration-radiogroup][data-hydrated='false'] [role='radio'][aria-checked='true'] {
  border-color: var(--prehydration-accent, #0f172a) !important;
  box-shadow: 0 0 0 1px var(--prehydration-accent, #0f172a) !important;
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
 */
async function loadStripRange(activityId: string): Promise<AvailabilityRangeDay[] | undefined> {
  const today = new Date();
  const end = new Date(today);
  end.setDate(today.getDate() + STRIP_DAYS - 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  try {
    return await getAvailabilityRange(activityId, iso(today), iso(end));
  } catch {
    return undefined;
  }
}

export default async function ActivityDetailPage({ params }: PageProps) {
  const activity = await loadActivity(params.id);
  if (!activity) notFound();

  const initialRange = await loadStripRange(activity.id);

  const brand = await getBrandAsync();
  const accent = activity.color;
  const categoryLabel = CATEGORY_LABELS[activity.category];

  return (
    <main id="main-content" tabIndex={-1} style={brandStyle(brand)} className="mx-auto w-full max-w-6xl px-4 py-8">
      <style dangerouslySetInnerHTML={{ __html: PRE_HYDRATION_STYLES }} />
      <script dangerouslySetInnerHTML={{ __html: PRE_HYDRATION_RADIOS }} />

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
            className="inline-block rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide"
            // The activity's own colour, not the tenant brand, so derive a legible
            // foreground for it rather than assuming white (2.77:1 on the seed blue).
            style={{ backgroundColor: accent, color: onBrandForeground(accent) }}
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
          <BookingWidget activity={activity} initialRange={initialRange} />
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
