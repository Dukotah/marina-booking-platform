'use client';

/**
 * Rental week grid — the "see the pattern filled in, click to tweak" half of the
 * schedule admin page. Rows are hours of the day, columns are the next 7 calendar
 * days in the boat's operating timezone. A cell is teal-tinted when the boat is
 * rentable in that hour (computed from the active rental-window ScheduleRules via
 * @marina/core), plain when closed.
 *
 * It is read-only-by-default: the only edit is closing (or re-opening) a whole
 * day. Click a day's header — or any cell in its column — and that date becomes a
 * whole-day BlackoutDate (maintenance, a holiday, a private charter). Click again
 * to remove the blackout and re-open. Partial-hour exceptions (close just an
 * afternoon) are intentionally out of scope this pass; whole-day is v1.
 *
 * Persistence reuses the exact server actions the RuleScheduler's "Closed dates"
 * panel uses: addBlackout / removeBlackout (activity-scoped, tenant-narrowed,
 * RLS-enforced). No new write path.
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Lock, Unlock } from 'lucide-react';
import { isHourRentable, type RentalWindowRule } from '@marina/core';
import { cn } from '../../lib/cn';
import { addBlackout, removeBlackout, type RuleView } from '../../app/activities/schedule-rules-actions';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** One already-closed calendar day in the window, with the id(s) to re-open it. */
export interface ClosedDateView {
  date: string; // YYYY-MM-DD
  ids: string[];
  reason: string | null;
  /** 'activity' = this boat only, 'operator' = whole marina (can't re-open here). */
  scope: 'activity' | 'operator';
}

export interface RentalWeekGridProps {
  activityId: string;
  /** Today, YYYY-MM-DD, in the activity's operating timezone. */
  today: string;
  /** All of the boat's schedule rules; departure-only rules are ignored here. */
  rules: RuleView[];
  /** Days already closed inside the 7-day window (activity- or operator-scoped). */
  closedDates: ClosedDateView[];
}

// ---------------------------------------------------------------------------
// Grid shape
// ---------------------------------------------------------------------------

/** First and last hour shown (inclusive start, exclusive end): 6 AM … 10 PM. */
const FIRST_HOUR = 6;
const LAST_HOUR = 22;
const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function isoParts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return { y, m, d };
}

function isoWeekdayLocal(iso: string): number {
  const { y, m, d } = isoParts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addIsoDays(iso: string, days: number): string {
  const { y, m, d } = isoParts(iso);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** "8 AM" / "12 PM" — compact hour label for the row axis. */
function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${suffix}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RentalWeekGrid(props: RentalWeekGridProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyDate, setBusyDate] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  // Only rental-window rules shade the grid. A boat with fixed departures (tour
  // boat) still works — it just shows no rentable hours here, which is correct.
  const rentalRules: RentalWindowRule[] = useMemo(
    () =>
      props.rules
        .filter((r) => r.kind === 'rental')
        .map((r) => ({
          startDate: r.startDate,
          endDate: r.endDate,
          weekdays: r.weekdays,
          openMinute: r.openMinute,
          closeMinute: r.closeMinute,
          isActive: r.isActive,
        })),
    [props.rules],
  );

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addIsoDays(props.today, i)),
    [props.today],
  );

  const closedByDate = useMemo(() => {
    const map = new Map<string, ClosedDateView>();
    for (const c of props.closedDates) map.set(c.date, c);
    return map;
  }, [props.closedDates]);

  const hasAnyRental = rentalRules.length > 0;

  function toggleDay(date: string) {
    const closed = closedByDate.get(date);
    // A marina-wide closure is managed from the Closed dates panel, not per boat.
    if (closed?.scope === 'operator') {
      setOutcome({
        tone: 'bad',
        text: 'That day is closed for the whole marina. Re-open it from Closed dates below.',
      });
      return;
    }
    setOutcome(null);
    setBusyDate(date);
    startTransition(async () => {
      const result = closed
        ? await removeBlackout(props.activityId, closed.ids)
        : await addBlackout(props.activityId, {
            activityId: props.activityId,
            startDate: date,
            endDate: date,
          });
      setBusyDate(null);
      setOutcome({ tone: result.ok ? 'good' : 'bad', text: result.message });
      if (result.ok) router.refresh();
    });
  }

  return (
    <section
      aria-labelledby="rental-week-grid-heading"
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 id="rental-week-grid-heading" className="text-base font-semibold text-slate-900">
          This week at a glance
        </h2>
        <p className="mt-0.5 text-sm text-slate-600">
          The shaded hours are when this boat can be rented, straight from the schedule above.{' '}
          <span className="font-medium text-slate-700">
            Click a day to close it for maintenance or a holiday
          </span>{' '}
          — click again to re-open. (Closing just part of a day is coming later.)
        </p>
      </div>

      <p
        role="status"
        aria-live="polite"
        className={
          outcome
            ? cn(
                'mx-5 mt-4 rounded-lg border px-4 py-3 text-sm font-medium',
                outcome.tone === 'good'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-rose-200 bg-rose-50 text-rose-800',
              )
            : 'sr-only'
        }
      >
        {outcome?.text ?? ''}
      </p>

      <div className="px-5 py-5">
        {!hasAnyRental ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-6 text-center">
            <p className="text-sm font-medium text-slate-700">No rentable hours yet.</p>
            <p className="mt-1 text-sm text-slate-500">
              Add a rental window in the schedule above (for example, open 8 AM to 8 PM on
              weekdays) and it will fill in here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 w-14 bg-white" aria-hidden />
                  {days.map((date) => {
                    const closed = closedByDate.get(date);
                    const isClosed = Boolean(closed);
                    const weekday = isoWeekdayLocal(date);
                    const { m, d } = isoParts(date);
                    const busy = busyDate === date && isPending;
                    const operatorLocked = closed?.scope === 'operator';
                    return (
                      <th key={date} className="p-0.5 align-bottom">
                        <button
                          type="button"
                          onClick={() => toggleDay(date)}
                          disabled={isPending}
                          aria-pressed={isClosed}
                          aria-label={
                            isClosed
                              ? `${WEEKDAY_SHORT[weekday]} ${MONTH_SHORT[m - 1]} ${d} is closed — click to re-open`
                              : `${WEEKDAY_SHORT[weekday]} ${MONTH_SHORT[m - 1]} ${d} is open — click to close for the day`
                          }
                          className={cn(
                            'flex min-h-[44px] w-full min-w-[44px] flex-col items-center justify-center gap-0.5 rounded-lg border px-1 py-1.5 text-center transition-colors disabled:cursor-wait',
                            isClosed
                              ? 'border-slate-300 bg-slate-100 text-slate-500'
                              : 'border-slate-200 bg-white text-slate-700 hover:border-accent hover:bg-accent-tint',
                          )}
                        >
                          <span className="text-[11px] font-semibold uppercase tracking-wide">
                            {WEEKDAY_SHORT[weekday]}
                          </span>
                          <span
                            className={cn(
                              'text-[11px] tabular-nums',
                              isClosed ? 'text-slate-400' : 'text-slate-500',
                            )}
                          >
                            {MONTH_SHORT[m - 1]} {d}
                          </span>
                          {busy ? (
                            <Loader2 className="h-3 w-3 animate-spin text-slate-500" aria-hidden />
                          ) : isClosed ? (
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-200 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                              <Lock className="h-2.5 w-2.5" aria-hidden />
                              {operatorLocked ? 'Marina' : 'Closed'}
                            </span>
                          ) : (
                            <Unlock className="h-2.5 w-2.5 text-slate-300" aria-hidden />
                          )}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {HOURS.map((hour) => (
                  <tr key={hour}>
                    <th
                      scope="row"
                      className="sticky left-0 z-10 h-10 bg-white pr-2 text-right align-middle text-[11px] font-medium tabular-nums text-slate-400"
                    >
                      {hourLabel(hour)}
                    </th>
                    {days.map((date) => {
                      const closed = closedByDate.get(date);
                      const isClosed = Boolean(closed);
                      const rentable =
                        !isClosed && isHourRentable(rentalRules, date, hour * 60);
                      const busy = busyDate === date && isPending;
                      const weekday = isoWeekdayLocal(date);
                      return (
                        <td key={date} className="p-0.5">
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() => toggleDay(date)}
                            disabled={isPending}
                            aria-hidden
                            className={cn(
                              'h-9 w-full min-w-[44px] rounded-md border transition-colors disabled:cursor-wait',
                              isClosed
                                ? 'border-slate-200/70 bg-[repeating-linear-gradient(135deg,theme(colors.slate.100),theme(colors.slate.100)_6px,theme(colors.slate.50)_6px,theme(colors.slate.50)_12px)]'
                                : rentable
                                  ? 'border-accent/30 bg-accent-tint hover:bg-accent/20'
                                  : 'border-slate-100 bg-slate-50/50 hover:bg-slate-100',
                              busy && 'opacity-50',
                            )}
                            title={
                              isClosed
                                ? `Closed ${WEEKDAY_SHORT[weekday]} — click to re-open`
                                : rentable
                                  ? `Rentable at ${hourLabel(hour)}`
                                  : `Closed at ${hourLabel(hour)}`
                            }
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Legend */}
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500">
          <LegendSwatch
            className="border-accent/30 bg-accent-tint"
            label="Rentable"
          />
          <LegendSwatch className="border-slate-100 bg-slate-50" label="Closed hour" />
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-3.5 w-5 rounded border border-slate-200/70 bg-[repeating-linear-gradient(135deg,theme(colors.slate.100),theme(colors.slate.100)_4px,theme(colors.slate.50)_4px,theme(colors.slate.50)_8px)]"
              aria-hidden
            />
            Closed all day
          </span>
        </div>
      </div>
    </section>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-3.5 w-5 rounded border', className)} aria-hidden />
      {label}
    </span>
  );
}
