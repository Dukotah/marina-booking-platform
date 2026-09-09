'use client';

import { useMemo, useState } from 'react';
import { CalendarDays, List, GanttChartSquare } from 'lucide-react';
import { cn } from '../../lib/cn';
import { DaySchedule } from './DaySchedule';
import { GanttManifest } from './GanttManifest';
import { ManifestList, matchesFilter, type ManifestFilter } from './ManifestList';
import type { ManifestListItem, ManifestRow } from './types';

/**
 * The manifest's working surfaces. Default is the receptionist List — one compact
 * row per party, filterable by the summary counts above it. Day (roomy departure
 * cards with capacity + guides) and Timeline (Gantt) remain one tap away. All three
 * read the same rows; switching never refetches.
 */
export function ManifestViews({
  rows,
  timeZone,
  isoDate,
  signLinkBase,
}: {
  rows: ManifestRow[];
  /** Operator IANA timezone. "Overdue" is measured against this clock, not the
   *  browser's — staff travel, and a laptop set to Denver must not mark a Sonoma boat
   *  late by an hour. */
  timeZone: string;
  /** The day on screen, YYYY-MM-DD, so yesterday's manifest is history and not alarm. */
  isoDate: string;
  /** Customer web base URL for waiver sign links (copy/QR on unsigned rows). */
  signLinkBase: string;
}) {
  const [view, setView] = useState<'list' | 'day' | 'timeline'>('list');
  const [filter, setFilter] = useState<ManifestFilter>('all');

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
    // "Owe balance" counts orders, not items — one order with two boats is one
    // balance to collect at the counter.
    const dueOrders = new Set(
      active.filter((it) => matchesFilter(it, 'due')).map((it) => it.orderId),
    );
    return {
      departures: active.length,
      unsigned: active.filter((it) => matchesFilter(it, 'unsigned')).length,
      due: dueOrders.size,
      checkedIn: active.filter((it) => it.status === 'CHECKED_IN').length,
    };
  }, [rows]);

  /** A summary count doubles as a filter: tap to filter the list, tap again to clear. */
  function toggleFilter(next: Exclude<ManifestFilter, 'all'>) {
    setView('list');
    setFilter((prev) => (prev === next ? 'all' : next));
  }

  // Day and Timeline predate the cancelled toggle; they only ever show live bookings.
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
      {/* Summary counts that act as filters — the numbers that matter at open. */}
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Day summary filters">
        <StatButton
          value={counts.departures}
          label={counts.departures === 1 ? 'departure' : 'departures'}
          active={filter === 'all'}
          onClick={() => {
            setView('list');
            setFilter('all');
          }}
        />
        <StatButton
          value={counts.unsigned}
          label={counts.unsigned === 1 ? 'unsigned waiver' : 'unsigned waivers'}
          tone={counts.unsigned > 0 ? 'amber' : undefined}
          active={filter === 'unsigned'}
          onClick={() => toggleFilter('unsigned')}
        />
        <StatButton
          value={counts.due}
          label={counts.due === 1 ? 'owes balance' : 'owe balance'}
          tone={counts.due > 0 ? 'rose' : undefined}
          active={filter === 'due'}
          onClick={() => toggleFilter('due')}
        />
        <StatButton
          value={counts.checkedIn}
          label="checked in"
          tone={counts.checkedIn > 0 ? 'emerald' : undefined}
          active={filter === 'checkedin'}
          onClick={() => toggleFilter('checkedin')}
        />
      </div>

      {/* role="group" + per-button pressed state so a screen reader hears which view
          is showing, not three identical buttons. (1.4.1, 4.1.2) */}
      <div
        role="group"
        aria-label="Manifest view"
        className="mb-4 inline-flex rounded-lg border border-slate-200 bg-white p-0.5"
      >
        <TabButton active={view === 'list'} onClick={() => setView('list')}>
          <List className="h-4 w-4" aria-hidden /> List
        </TabButton>
        <TabButton active={view === 'day'} onClick={() => setView('day')}>
          <CalendarDays className="h-4 w-4" aria-hidden /> Day
        </TabButton>
        <TabButton active={view === 'timeline'} onClick={() => setView('timeline')}>
          <GanttChartSquare className="h-4 w-4" aria-hidden /> Timeline
        </TabButton>
      </div>

      {view === 'list' ? (
        <ManifestList
          rows={rows}
          timeZone={timeZone}
          isoDate={isoDate}
          signLinkBase={signLinkBase}
          filter={filter}
        />
      ) : view === 'day' ? (
        <DaySchedule rows={liveRows} timeZone={timeZone} isoDate={isoDate} />
      ) : (
        <GanttManifest rows={liveRows} />
      )}

      {/* The capacity legend explains the Day cards and Timeline blocks; the list
          spells its statuses out in words, so it stays legend-free. */}
      {view !== 'list' ? <Legend /> : null}
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
 * One glanceable count that is also a filter. Semantic colour marks a non-zero
 * number that needs attention (amber = waivers, rose = money, emerald = in) — a
 * zero renders quiet grey because there is nothing to chase.
 */
function StatButton({
  value,
  label,
  tone,
  active,
  onClick,
}: {
  value: number;
  label: string;
  tone?: 'amber' | 'rose' | 'emerald';
  active: boolean;
  onClick: () => void;
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
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-baseline gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors',
        active
          ? 'border-slate-900 bg-white ring-1 ring-slate-900'
          : 'border-slate-200 bg-white hover:border-slate-300',
      )}
    >
      <span className={cn('text-base font-semibold tabular-nums', numberClass)}>{value}</span>
      <span className="text-xs font-medium text-slate-600">{label}</span>
    </button>
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
