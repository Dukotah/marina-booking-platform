'use client';

import { useMemo, useState } from 'react';
import { CalendarDays, GanttChartSquare } from 'lucide-react';
import { cn } from '../../lib/cn';
import { DaySchedule } from './DaySchedule';
import { GanttManifest } from './GanttManifest';
import type { ManifestListItem, ManifestRow } from './types';

/**
 * The manifest's working surfaces. Day is THE manifest (owner's call: roomy,
 * time-ordered departure cards, each guest one tap from the full reservation
 * card); Timeline (Gantt) stays one tap away for the spatial view. The old
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
  const [view, setView] = useState<'day' | 'timeline'>('day');

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
    return {
      departures: active.length,
      unsigned,
      due: dueOrders.size,
      checkedIn: active.filter((it) => it.status === 'CHECKED_IN').length,
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
      {/* The numbers that matter at open — glanceable, not another control row. */}
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Day summary">
        <Stat value={counts.departures} label={counts.departures === 1 ? 'departure' : 'departures'} />
        <Stat
          value={counts.unsigned}
          label={counts.unsigned === 1 ? 'unsigned waiver' : 'unsigned waivers'}
          tone={counts.unsigned > 0 ? 'amber' : undefined}
        />
        <Stat
          value={counts.due}
          label={counts.due === 1 ? 'owes balance' : 'owe balance'}
          tone={counts.due > 0 ? 'rose' : undefined}
        />
        <Stat value={counts.checkedIn} label="checked in" tone={counts.checkedIn > 0 ? 'emerald' : undefined} />
      </div>

      {/* role="group" + per-button pressed state so a screen reader hears which view
          is showing, not two identical buttons. (1.4.1, 4.1.2) */}
      <div
        role="group"
        aria-label="Manifest view"
        className="mb-4 inline-flex rounded-lg border border-slate-200 bg-white p-0.5"
      >
        <TabButton active={view === 'day'} onClick={() => setView('day')}>
          <CalendarDays className="h-4 w-4" aria-hidden /> Day
        </TabButton>
        <TabButton active={view === 'timeline'} onClick={() => setView('timeline')}>
          <GanttChartSquare className="h-4 w-4" aria-hidden /> Timeline
        </TabButton>
      </div>

      {view === 'day' ? (
        <DaySchedule rows={liveRows} timeZone={timeZone} isoDate={isoDate} />
      ) : (
        <GanttManifest rows={liveRows} />
      )}

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
    // slate-600/700, not slate-500/600: the legend sits on the page background
    // (bg-slate-100), where slate-500 is only 4.34:1. (1.4.3)
    <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-600">
      <span className="font-medium text-slate-700">Capacity:</span>
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
 * One glanceable count. Semantic colour marks a non-zero number that needs
 * attention (amber = waivers, rose = money, emerald = in) — a zero renders quiet
 * grey because there is nothing to chase.
 */
function Stat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: 'amber' | 'rose' | 'emerald';
}) {
  const numberClass =
    tone === 'amber'
      ? 'text-amber-800'
      : tone === 'rose'
        ? 'text-rose-700'
        : tone === 'emerald'
          ? 'text-emerald-700'
          : 'text-slate-900';
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
      <span className={cn('text-base font-semibold tabular-nums', numberClass)}>{value}</span>
      <span className="text-xs font-medium text-slate-600">{label}</span>
    </span>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {children}
    </button>
  );
}
