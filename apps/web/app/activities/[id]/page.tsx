import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getActivity, isApiError, type ActivityDetail } from '@/lib/api';
import { getBrand, brandStyle } from '@/lib/brand';
import { formatUSD } from '@/lib/format';
import { PhotoGallery } from '@/components/activity/PhotoGallery';
import { BookingWidget } from '@/components/activity/BookingWidget';

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
  const brand = await getBrand();
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

  const brand = await getBrand();
  const accent = activity.color;
  const categoryLabel = CATEGORY_LABELS[activity.category];

  return (
    <main style={brandStyle(brand)} className="mx-auto max-w-6xl px-4 py-8">
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

      <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr]">
        {/* Left: media + details */}
        <div className="flex flex-col gap-6">
          <PhotoGallery
            photoUrls={activity.photoUrls}
            name={activity.name}
            accentColor={accent}
          />

          <header>
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

        {/* Right: booking widget (sticky on desktop) */}
        <div className="lg:sticky lg:top-20 lg:self-start">
          <BookingWidget activity={activity} />
        </div>
      </div>
    </main>
  );
}
