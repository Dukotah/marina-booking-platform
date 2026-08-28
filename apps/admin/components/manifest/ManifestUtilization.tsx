import { AlertTriangle, UserRound } from 'lucide-react';
import type { ManifestRow } from './types';

/**
 * Per-activity utilization + guide summary (Singenuity §2 day-of-ops polish).
 *
 * For each activity in the day it shows every timeslot's fill as "booked/total"
 * (e.g. "1/3"), the guides scheduled to run it, and a resource-conflict highlight
 * when a slot is over-subscribed (capacity_booked > capacity_total — the shape a
 * double-booked boat/room takes on the manifest). Read-only; the assign action
 * lives on the order/manifest detail, this is the at-a-glance dock view.
 */
function slotTime(startISO: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(startISO));
}

export function ManifestUtilization({ rows }: { rows: ManifestRow[] }) {
  const withSlots = rows.filter((r) => r.slots.length > 0);
  if (withSlots.length === 0) return null;

  return (
    <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Utilization &amp; guides
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {withSlots.map((row) => (
          <div key={row.activityId} className="rounded-lg border border-slate-100 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: row.color }}
                aria-hidden
              />
              <span className="truncate text-sm font-medium text-slate-700">{row.activityName}</span>
              {/* slate-500, not slate-400: slate-400 on white is 2.45:1. The whole
                  admin uses slate-500 as its lightest text on a white card. (1.4.3) */}
              <span className="ml-auto text-xs tabular-nums text-slate-500">
                <span className="sr-only">Booked: </span>
                {row.capacityBooked}/{row.capacityTotal}
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {row.slots.map((slot) => {
                const conflict = slot.capacityBooked > slot.capacityTotal;
                const full = !conflict && slot.capacityBooked >= slot.capacityTotal;
                const cls = conflict
                  ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-300'
                  : full
                    ? 'bg-amber-50 text-amber-700'
                    : 'bg-slate-50 text-slate-600';
                return (
                  <span
                    key={slot.timeslotId}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium tabular-nums ${cls}`}
                    title={
                      conflict
                        ? 'Over capacity — resource conflict'
                        : `${slot.capacityBooked} of ${slot.capacityTotal} booked`
                    }
                  >
                    {/* An over-subscribed slot was rose fill + an aria-hidden icon +
                        a `title`, i.e. colour only for anyone not using a mouse. The
                        conflict is now stated in text the reader reaches. (1.4.1) */}
                    {conflict ? (
                      <>
                        <AlertTriangle className="h-3 w-3" aria-hidden />
                        <span className="sr-only">Over capacity, resource conflict: </span>
                      </>
                    ) : null}
                    {slotTime(slot.startISO)} · {slot.capacityBooked}/{slot.capacityTotal}
                    <span className="sr-only"> booked</span>
                  </span>
                );
              })}
            </div>

            {row.guides.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {row.guides.map((g) => (
                  <span
                    key={g.assignmentId}
                    className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700"
                    title={g.guideEmail}
                  >
                    <UserRound className="h-3 w-3" aria-hidden />
                    {g.guideName || g.guideEmail}
                    {/* Inherits sky-700; sky-400 on sky-50 was 1.98:1. (1.4.3) */}
                    {g.roleLabel ? <span> · {g.roleLabel}</span> : null}
                  </span>
                ))}
              </div>
            ) : (
              <div className="mt-2 text-[11px] text-slate-500">No guide assigned</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
