'use client';

import { useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { DaySchedule } from './DaySchedule';
import type { ManifestListItem, ManifestRow, ManifestStatFilter } from './types';

/**
 * The manifest's working surfaces. Day is THE manifest (owner's call: roomy,
 * time-ordered departure cards, each guest one tap from the full reservation
 * card). The spatial boat-by-time board moved to its own top-level Schedule
 * screen (/schedule), so the manifest is purely the day's working list. The old
 * receptionist List view is gone — everything it did per booking (check-in,
 * no-show, charges, waiver links) lives in the reservation card the Day view
 * opens.
 */
export function ManifestViews({
  rows,
  timeZone,
  isoDate,
}: {
  rows: ManifestRow[];
  /** Operator IANA timezone. "Overdue" is measured against this clock, not the
   *  browser's — staff travel, and a laptop set to Denver must not mark a Sonoma boat
   *  late by an hour. */
  timeZone: string;
  /** The day on screen, YYYY-MM-DD, so yesterday's manifest is history and not alarm. */
  isoDate: string;
}) {
  // The active stat filter (null = whole day). Tapping a stat narrows the day list
  // to just those departures; tapping the lit stat again clears it.
  const [filter, setFilter] = useState<ManifestStatFilter | null>(null);
  const dayRef = useRef<HTMLDivElement>(null);

  // Tapping a stat filters the day list to those departures (and scrolls to it, so
  // the narrowed list is in view even on a long day).
  function toggleFilter(next: ManifestStatFilter) {
    setFilter((prev) => (prev === next ? null : next));
    requestAnimationFrame(() => {
      dayRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // The four numbers a front desk needs at open, computed once from the same rows
  // every view renders. Cancelled bookings never count.
  const counts = useMemo(() => {
    const flat: ManifestListItem[] = rows.flatMap((row) =>
      row.bookings.map((b) => ({
        ...b,
        activityId: row.activityId,
        activityName: row.activityName,
        color: row.color,
      })),
    );
    const active = flat.filter((it) => it.status !== 'CANCELLED');
    const unsigned = active.filter(
      (it) => !it.waiverSigned && (it.status === 'UPCOMING' || it.status === 'CHECKED_IN'),
    ).length;
    // "Owe balance" counts orders, not items — one order with two boats is one
    // balance to collect at the counter.
    const dueOrders = new Set(
      active
        .filter((it) => it.balanceDueCents > 0 && it.status !== 'NO_SHOW')
        .map((it) => it.orderId),
    );
    // Guests waiting on sold-out slots. Counted on full slots only — the same
    // condition the departure card shows its "N waiting" chip under, so the
    // glance total and the per-card chips always agree.
    const waiting = rows.reduce(
      (sum, row) =>
        sum +
        row.slots.reduce(
          (s, slot) =>
            s +
            (slot.capacityTotal > 0 && slot.capacityBooked >= slot.capacityTotal
              ? slot.waitlist.length
              : 0),
          0,
        ),
      0,
    );

    return {
      // "Arriving" is who is still to come (UPCOMING), not every booking — a
      // front desk wants the "still outstanding to greet" number, not the day total.
      arriving: active.filter((it) => it.status === 'UPCOMING').length,
      unsigned,
      due: dueOrders.size,
      checkedIn: active.filter((it) => it.status === 'CHECKED_IN').length,
      waiting,
    };
  }, [rows]);

  // The views only ever show live bookings; cancelled ones live on the order pages.
  const liveRows = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        bookings: row.bookings.filter((b) => b.status !== 'CANCELLED'),
      })),
    [rows],
  );

  return (
    <div>
      {/* The five numbers a front desk runs the day on — glanceable, and each a
          one-tap filter on the Day list below. Order mirrors the shift: who's still
          coming, who's in, who owes, who hasn't signed, who's in line. */}
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Day summary and filters">
        <Stat
          value={counts.arriving}
          label="arriving"
          active={filter === 'arriving'}
          onClick={() => toggleFilter('arriving')}
        />
        <Stat
          value={counts.checkedIn}
          label="checked in"
          tone={counts.checkedIn > 0 ? 'emerald' : undefined}
          active={filter === 'checkedIn'}
          onClick={() => toggleFilter('checkedIn')}
        />
        <Stat
          value={counts.due}
          label={counts.due === 1 ? 'owes balance' : 'owe balance'}
          tone={counts.due > 0 ? 'rose' : undefined}
          active={filter === 'due'}
          onClick={() => toggleFilter('due')}
        />
        <Stat
          value={counts.unsigned}
          label={counts.unsigned === 1 ? 'unsigned waiver' : 'unsigned waivers'}
          tone={counts.unsigned > 0 ? 'amber' : undefined}
          active={filter === 'unsigned'}
          onClick={() => toggleFilter('unsigned')}
        />
        <Stat
          value={counts.waiting}
          label="waiting"
          tone={counts.waiting > 0 ? 'amber' : undefined}
          active={filter === 'waiting'}
          onClick={() => toggleFilter('waiting')}
        />
      </div>

      <div ref={dayRef} style={{ scrollMarginTop: '1rem' }}>
        <DaySchedule rows={liveRows} timeZone={timeZone} isoDate={isoDate} filter={filter} />
      </div>

      <Legend />
    </div>
  );
}

function Legend() {
  const items = [
    { label: 'Available', className: 'bg-emerald-500' },
    { label: 'Filling up', className: 'bg-amber-500' },
    { label: 'Full', className: 'bg-rose-500' },
  ];
  return (
    // ink-body on the light cool-gray canvas clears AA. (1.4.3)
    <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-ink-body">
      <span className="font-medium text-ink">Capacity:</span>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-full ${i.className}`} aria-hidden />
          {i.label}
        </span>
      ))}
      <span className="ml-auto inline-flex items-center gap-1.5">
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          ✓
        </span>
        Checked-in booking
      </span>
    </div>
  );
}

/**
 * One glanceable count, and a one-tap filter on the day list. Semantic colour marks
 * a non-zero number that needs attention (amber = waivers / waiting, rose = money,
 * emerald = in) — a zero renders quiet grey because there is nothing to chase. When
 * lit (`active`) the chip reads as the applied filter via a slate ring + pressed
 * state; tapping it again clears the filter.
 */
function Stat({
  value,
  label,
  tone,
  active,
  onClick,
}: {
  value: number;
  label: string;
  tone?: 'amber' | 'rose' | 'emerald';
  /** Whether this stat is the currently applied day filter. */
  active: boolean;
  /** Toggle this stat as the day filter. */
  onClick: () => void;
}) {
  const numberClass =
    tone === 'amber'
      ? 'text-amber-700'
      : tone === 'rose'
        ? 'text-rose-700'
        : tone === 'emerald'
          ? 'text-emerald-700'
          : 'text-ink';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${value} ${label}${active ? ' — filtering the day, tap to clear' : ' — tap to filter the day'}`}
      className={cn(
        // min-h-11 (44px) keeps the filter chips a dad-simple tap target.
        'inline-flex min-h-11 items-baseline gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm shadow-sm transition-colors',
        'hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus',
        // Selected = the one teal accent (law: nav/selected uses teal), not slate.
        active ? 'border-accent ring-1 ring-accent' : 'border-line',
      )}
    >
      <span className={cn('text-base font-semibold tabular-nums', numberClass)}>{value}</span>
      <span className="text-xs font-medium text-ink-body">{label}</span>
    </button>
  );
}

