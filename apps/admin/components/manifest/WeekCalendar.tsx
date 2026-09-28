'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { cn } from '../../lib/cn';
import { formatTime } from '../../lib/format';
import { ReservationCard } from '../calendar/ReservationCard';

/**
 * The week at a glance, the way a phone receptionist reads it: seven day columns of
 * quiet one-line chips in departure order — time + boat, a thin activity-colour tick
 * on the left, and a muted fill only when a booking is NOT simply upcoming. Days
 * with more chips than fit collapse behind "+N more"; cancelled and no-shows hide
 * behind an off-by-default toggle. Clicking a chip opens the reservation card — the
 * edit-everything slide-over — and hovering one reveals the "+ add charge" shortcut
 * straight into the order's charge panel.
 *
 * (This replaces the pixel-positioned lane grid: eight concurrent 8 AM departures
 * used to split a column into unreadable 20px slivers of saturated colour.)
 */
export interface WeekCalendarEvent {
  orderItemId: string;
  orderId: string;
  orderNumber: string;
  /** 0-6 index of the day column (0 = first day of the week). */
  dayIndex: number;
  startMin: number;
  endMin: number;
  startISO: string;
  title: string;
  subtitle: string;
  color: string;
  status: import('@marina/database').OrderItemStatus;
}

export interface WeekCalendarDay {
  /** YYYY-MM-DD for this column. */
  iso: string;
  /** Short weekday label, e.g. "Mon". */
  weekday: string;
  /** Day-of-month number, e.g. "4". */
  dayNum: string;
  isToday: boolean;
}

export interface WeekCalendarProps {
  days: WeekCalendarDay[];
  events: WeekCalendarEvent[];
}

/** Chips shown per day before the column folds behind "+N more". */
const MAX_VISIBLE = 8;

/** "8a" / "8:30a" / "12:15p" — the shortest honest time. */
function compactTime(min: number): string {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h24 >= 12 ? 'p' : 'a';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/** "Quest Fishing Pontoon (3)" → "Quest Fishing Pontoon" — the chip is one line. */
function shortTitle(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*$/, '');
}

export function WeekCalendar({ days, events }: WeekCalendarProps) {
  // Cancelled/no-show are noise on a planning glance but must stay reachable.
  const [showInactive, setShowInactive] = useState(false);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  // The reservation card open for a clicked chip (null = closed).
  const [openItemId, setOpenItemId] = useState<string | null>(null);

  const inactiveCount = useMemo(
    () => events.filter((e) => e.status === 'CANCELLED' || e.status === 'NO_SHOW').length,
    [events],
  );

  const eventsByDay: WeekCalendarEvent[][] = useMemo(() => {
    const byDay: WeekCalendarEvent[][] = days.map(() => []);
    for (const ev of events) {
      if (!showInactive && (ev.status === 'CANCELLED' || ev.status === 'NO_SHOW')) continue;
      if (ev.dayIndex >= 0 && ev.dayIndex < days.length) byDay[ev.dayIndex].push(ev);
    }
    for (const list of byDay) list.sort((a, b) => a.startMin - b.startMin);
    return byDay;
  }, [days, events, showInactive]);

  function toggleDay(iso: string) {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  }

  return (
    <div>
      {inactiveCount > 0 ? (
        <div className="mb-2 flex justify-end">
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
            />
            Show cancelled & no-shows ({inactiveCount})
          </label>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-slate-200">
          {days.map((d, i) => (
            <div
              key={d.iso}
              className={cn('px-2 py-2 text-center', i > 0 && 'border-l border-slate-100')}
            >
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                {d.weekday}
              </div>
              <div
                className={cn(
                  'mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-sm font-semibold tabular-nums',
                  d.isToday ? 'bg-slate-900 text-white' : 'text-slate-700',
                )}
              >
                {d.dayNum}
              </div>
            </div>
          ))}
        </div>

        {/* Day columns — stacked chips, capped per day. */}
        <div className="grid min-h-[20rem] grid-cols-7">
          {days.map((d, i) => {
            const dayEvents = eventsByDay[i];
            const isExpanded = expandedDays.has(d.iso);
            const visible = isExpanded ? dayEvents : dayEvents.slice(0, MAX_VISIBLE);
            const hiddenCount = dayEvents.length - visible.length;
            return (
              <section
                key={d.iso}
                aria-label={`${d.weekday} ${d.dayNum}: ${dayEvents.length} ${
                  dayEvents.length === 1 ? 'booking' : 'bookings'
                }`}
                className={cn('space-y-1 p-1.5', i > 0 && 'border-l border-slate-100')}
              >
                {visible.map((ev) => (
                  <EventChip
                    key={ev.orderItemId}
                    ev={ev}
                    onOpen={() => setOpenItemId(ev.orderItemId)}
                  />
                ))}
                {hiddenCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => toggleDay(d.iso)}
                    className="block w-full rounded px-1.5 py-1 text-left text-[11px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                  >
                    +{hiddenCount} more
                  </button>
                ) : isExpanded && dayEvents.length > MAX_VISIBLE ? (
                  <button
                    type="button"
                    onClick={() => toggleDay(d.iso)}
                    className="block w-full rounded px-1.5 py-1 text-left text-[11px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                  >
                    Show less
                  </button>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>

      {openItemId ? (
        <ReservationCard orderItemId={openItemId} onClose={() => setOpenItemId(null)} />
      ) : null}
    </div>
  );
}

/**
 * One booking, one quiet line: activity-colour tick + time + boat. Fill only says
 * something when the state is not plain "upcoming". Clicking (or Enter/Space on) a
 * chip opens the reservation card — a button, so it is keyboard-activatable and
 * announces as an action, with a visible hover/focus affordance. Full detail stays
 * on the title tooltip; the order deep link lives inside the card.
 */
function EventChip({ ev, onOpen }: { ev: WeekCalendarEvent; onOpen: () => void }) {
  const inactive = ev.status === 'CANCELLED' || ev.status === 'NO_SHOW';
  const fill =
    ev.status === 'CHECKED_IN'
      ? 'border-emerald-100 bg-emerald-50/70'
      : ev.status === 'COMPLETED'
        ? 'border-slate-200 bg-slate-50'
        : inactive
          ? 'border-slate-200 bg-slate-50'
          : 'border-slate-200 bg-white';

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        data-reservation-trigger={ev.orderItemId}
        title={`${ev.title} · ${formatTime(ev.startISO)} · ${ev.subtitle}${
          ev.status === 'UPCOMING' ? '' : ` · ${statusWord(ev.status)}`
        }`}
        className={cn(
          'relative flex h-7 w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded border pl-2.5 pr-1 text-left text-xs',
          'hover:border-slate-400 hover:bg-slate-50 hover:shadow-sm',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500',
          fill,
          inactive && 'text-slate-500',
        )}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ backgroundColor: ev.color, opacity: inactive ? 0.35 : 1 }}
        />
        <span
          className={cn(
            'shrink-0 font-medium tabular-nums',
            inactive ? 'text-slate-500' : 'text-slate-700',
          )}
        >
          {compactTime(ev.startMin)}
        </span>
        <span
          className={cn(
            'min-w-0 truncate',
            inactive ? 'line-through' : 'text-slate-600',
          )}
        >
          {shortTitle(ev.title)}
        </span>
        <span className="sr-only">
          {ev.subtitle}
          {ev.status === 'UPCOMING' ? '' : ` — ${statusWord(ev.status)}`}
          {' — open reservation'}
        </span>
      </button>
      {!inactive ? (
        // One-tap post-trip charge: deep-links to the order with the charge panel
        // pre-opened (#add-charge). A sibling anchor, not nested in the chip link,
        // revealed on hover/focus so it never competes with the chip's own text.
        <Link
          href={`/orders/${ev.orderId}#add-charge`}
          aria-label={`Add a charge to ${ev.title}, ${formatTime(ev.startISO)}`}
          title="Add fuel / charge"
          className="absolute right-1 top-1/2 z-10 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 opacity-0 shadow-sm transition-opacity hover:bg-slate-50 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-slate-500 group-hover:opacity-100"
        >
          <Plus className="h-3 w-3" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}

function statusWord(status: WeekCalendarEvent['status']): string {
  switch (status) {
    case 'CHECKED_IN':
      return 'Checked in';
    case 'COMPLETED':
      return 'Completed';
    case 'CANCELLED':
      return 'Cancelled';
    case 'NO_SHOW':
      return 'No-show';
    default:
      return 'Upcoming';
  }
}
