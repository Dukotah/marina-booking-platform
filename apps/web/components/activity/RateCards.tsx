'use client';

/**
 * Rate comparison cards for an activity — duration vs. price.
 *
 * Renders each bookable rate as a selectable card showing its name, duration,
 * and price (plus a derived per-hour value so customers can compare options).
 * The cheapest rate is flagged "Best value" and the longest-duration rate is
 * flagged "Most time" to aid the comparison. Selection is controlled by the
 * parent (the booking widget) so date/time selection stays in sync.
 */

import { formatUSD, formatDuration } from '@/lib/format';
import type { CatalogRate } from '@/lib/api';

interface RateCardsProps {
  rates: CatalogRate[];
  selectedRateId: string | null;
  onSelect: (rate: CatalogRate) => void;
  accentColor: string;
}

/** Per-hour price in cents, or null if duration is non-positive. */
function perHourCents(rate: CatalogRate): number | null {
  if (rate.durationMinutes <= 0) return null;
  return Math.round((rate.priceCents / rate.durationMinutes) * 60);
}

export function RateCards({ rates, selectedRateId, onSelect, accentColor }: RateCardsProps) {
  if (rates.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        No rates are available for this activity yet. Please check back soon or
        contact us to book.
      </div>
    );
  }

  // Derive comparison badges. Lowest price = best value; longest = most time.
  const cheapestId = rates.reduce((min, r) =>
    r.priceCents < min.priceCents ? r : min,
  ).id;
  const longestId = rates.reduce((max, r) =>
    r.durationMinutes > max.durationMinutes ? r : max,
  ).id;
  const showBadges = rates.length > 1 && cheapestId !== longestId;

  return (
    <div
      className="grid gap-3 sm:grid-cols-2"
      role="radiogroup"
      aria-label="Choose a rate"
    >
      {rates.map((rate) => {
        const selected = rate.id === selectedRateId;
        const hourly = perHourCents(rate);
        const isCheapest = showBadges && rate.id === cheapestId;
        const isLongest = showBadges && rate.id === longestId;

        return (
          <button
            key={rate.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(rate)}
            className="relative flex flex-col rounded-xl border-2 bg-white p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
            style={{
              borderColor: selected ? accentColor : '#e2e8f0',
              boxShadow: selected ? `0 0 0 1px ${accentColor}` : undefined,
            }}
          >
            {(isCheapest || isLongest) && (
              <span
                className="absolute -top-2 right-3 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                style={{ backgroundColor: accentColor }}
              >
                {isCheapest ? 'Best value' : 'Most time'}
              </span>
            )}

            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-slate-900">{rate.name}</p>
                <p className="mt-0.5 text-sm text-slate-500">
                  {formatDuration(rate.durationMinutes) || 'Flexible duration'}
                </p>
              </div>
              <span
                aria-hidden
                className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition"
                style={{
                  borderColor: selected ? accentColor : '#cbd5e1',
                  backgroundColor: selected ? accentColor : 'transparent',
                }}
              >
                {selected && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </span>
            </div>

            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-900">
                {formatUSD(rate.priceCents)}
              </span>
              {hourly != null && rate.durationMinutes !== 60 && (
                <span className="text-xs text-slate-400">
                  {formatUSD(hourly)}/hr
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export default RateCards;
