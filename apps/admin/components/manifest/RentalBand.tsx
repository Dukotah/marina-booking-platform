import type { MinuteRange } from '@marina/core';
import { blockGeometry, type DayWindow } from './time';

/**
 * The OPEN-DURATION RENTAL availability band for one Gantt row: a continuous teal
 * wash across the hours this boat is rentable AND still free, drawn as a full-height
 * region behind the booking / open-slot blocks. This is the rental analog of the
 * fixed-departure "+N open slot" chip — it says "this whole stretch is bookable",
 * which is what an hourly-rental boat actually offers (the guest picks any start).
 *
 * Bands come pre-computed from the boat's rental-window ScheduleRules, with blackout
 * days dropped and existing bookings carved out (see app/manifest/data.ts), so what
 * shades here is exactly what the booking engine would still sell. Read-only and
 * non-interactive: it sits at z-0 under the clickable blocks, a quiet background that
 * never intercepts a tap meant for a booking.
 */
export interface RentalBandProps {
  bands: MinuteRange[];
  window: DayWindow;
}

export function RentalBand({ bands, window: win }: RentalBandProps) {
  if (bands.length === 0) return null;

  return (
    <>
      {bands.map((band) => {
        const geo = blockGeometry(band.open, band.close, win);
        if (!geo) return null;
        return (
          <div
            key={`${band.open}-${band.close}`}
            className="pointer-events-none absolute inset-y-0 z-0 rounded-md border border-dashed border-accent/40 bg-accent-tint"
            style={{ left: `${geo.leftPct}%`, width: `${geo.widthPct}%` }}
            role="img"
            aria-label="Available to rent"
          />
        );
      })}
    </>
  );
}
