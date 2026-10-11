import { Ban } from 'lucide-react';
import type { ManifestClosure } from './types';

/**
 * A full-day CLOSED / out-of-service overlay for one Gantt row. Marina closures
 * are whole-day (BlackoutDate rows), so this shades the entire time track rather
 * than a span — a slate, subtly striped region with an "Out of service" /
 * "Closed" label and the reason when known. Read-only: it reflects the closure the
 * fleet mechanism already enforces (see FleetStatus / data.ts); it never writes.
 */
export interface ClosedRegionProps {
  closures: ManifestClosure[];
}

export function ClosedRegion({ closures }: ClosedRegionProps) {
  if (closures.length === 0) return null;

  // A boat-specific outage reads "Out of service"; an operator/location-wide
  // blackout reads "Closed" (the whole dock is dark that day).
  const boatScoped = closures.find((c) => !c.wide);
  const label = boatScoped ? 'Out of service' : 'Closed';
  const reason = (boatScoped ?? closures[0]).reason;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden rounded-md border border-slate-300/70"
      // Slate diagonal hatch — unmistakably "not sellable" without a loud color.
      style={{
        backgroundColor: 'rgb(241 245 249 / 0.82)', // slate-100 wash
        backgroundImage:
          'repeating-linear-gradient(135deg, rgb(148 163 184 / 0.28) 0, rgb(148 163 184 / 0.28) 6px, transparent 6px, transparent 12px)',
      }}
      role="img"
      aria-label={reason ? `${label}: ${reason}` : label}
    >
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
        <Ban className="h-3.5 w-3.5" aria-hidden />
        {label}
        {reason ? <span className="font-normal text-slate-500">· {reason}</span> : null}
      </span>
    </div>
  );
}
