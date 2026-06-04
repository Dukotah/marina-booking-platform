/**
 * A single activity card on the customer catalog.
 *
 * Mobile-first and responsive: a photo header (falling back to the activity's
 * configured color with a category glyph), the name, a capacity line, an
 * availability hint, and a "from $X" price. The whole card links to the
 * activity's booking page. Money is always integer cents formatted via the
 * shared helper. No platform or hardcoded operator branding.
 */
import Link from 'next/link';
import { formatUSD } from '@/lib/format';
import type { CatalogActivity } from '@/lib/api';
import { categoryGlyph, categoryLabel } from './category';
import { readableTextOn } from './color';

interface ActivityCardProps {
  activity: CatalogActivity;
}

/** Shortest configured duration label, e.g. "from 2h", when rates exist. */
function lowestRate(activity: CatalogActivity) {
  if (activity.rates.length === 0) return null;
  return activity.rates.reduce((min, r) => (r.priceCents < min.priceCents ? r : min));
}

export function ActivityCard({ activity }: ActivityCardProps) {
  const photo = activity.photoUrls[0] ?? null;
  const headerText = readableTextOn(activity.color);
  const cheapest = lowestRate(activity);
  const bookable = activity.fromPriceCents != null && activity.rates.length > 0;

  return (
    <Link
      href={`/activities/${encodeURIComponent(activity.id)}`}
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm outline-none transition hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-[var(--brand-color)] focus-visible:ring-offset-2"
    >
      {/* Header: photo when available, otherwise the activity color + glyph. */}
      <div className="relative aspect-[16/10] w-full overflow-hidden" style={{ backgroundColor: activity.color }}>
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- tenant photos from arbitrary origins
          <img
            src={photo}
            alt={activity.name}
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center" style={{ color: headerText }}>
            <span aria-hidden className="text-5xl opacity-90">
              {categoryGlyph(activity.category)}
            </span>
          </div>
        )}

        {/* Category chip */}
        <span
          className="absolute left-3 top-3 rounded-full bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm backdrop-blur"
        >
          {categoryLabel(activity.category)}
        </span>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-4">
        <h3 className="text-base font-semibold leading-snug text-slate-900">{activity.name}</h3>

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
          <span className="inline-flex items-center gap-1">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Up to {activity.maxParticipants}
          </span>
          {activity.waiverRequired && (
            <span className="inline-flex items-center gap-1 text-slate-400">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              Waiver
            </span>
          )}
        </div>

        {/* Availability hint */}
        <p className="mt-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {bookable ? 'Check live availability' : 'Coming soon'}
        </p>

        {/* Price + CTA */}
        <div className="mt-4 flex items-end justify-between border-t border-slate-100 pt-3">
          <div>
            {bookable ? (
              <>
                <span className="block text-xs font-medium uppercase tracking-wide text-slate-400">From</span>
                <span className="text-lg font-bold text-slate-900">
                  {formatUSD(activity.fromPriceCents as number)}
                </span>
                {cheapest && (
                  <span className="ml-1 text-xs text-slate-400">/ {cheapest.name}</span>
                )}
              </>
            ) : (
              <span className="text-sm font-medium text-slate-500">Pricing soon</span>
            )}
          </div>
          <span
            className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white transition group-hover:opacity-90"
            style={{ backgroundColor: 'var(--brand-color)' }}
          >
            Book
          </span>
        </div>
      </div>
    </Link>
  );
}

export default ActivityCard;
