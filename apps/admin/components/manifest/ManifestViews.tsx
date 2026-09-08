'use client';

import { useState } from 'react';
import { CalendarDays, List, GanttChartSquare } from 'lucide-react';
import { DaySchedule } from './DaySchedule';
import { GanttManifest } from './GanttManifest';
import { ManifestList } from './ManifestList';
import type { ManifestRow } from './types';

/**
 * Toggle between the roomy Day schedule (default — every timeslot as a time-ordered
 * card the operator reads at a glance), the dense operational List, and the visual
 * Timeline (Gantt). All read the same rows; the toggle is view-only client state so
 * switching never refetches.
 */
export function ManifestViews({
  rows,
  timeZone,
  isoDate,
  signLinkBase,
}: {
  rows: ManifestRow[];
  /** Operator IANA timezone. The list measures "overdue" against this clock, not the
   *  browser's — staff travel, and a laptop set to Denver must not mark a Sonoma boat
   *  late by an hour. */
  timeZone: string;
  /** The day on screen, YYYY-MM-DD, so yesterday's manifest is history and not alarm. */
  isoDate: string;
  /** Customer web base URL for waiver sign links (copy/QR on unsigned rows). */
  signLinkBase: string;
}) {
  const [view, setView] = useState<'day' | 'list' | 'timeline'>('day');

  return (
    <div>
      {/* role="group" + the per-button pressed state: which view is showing was
          conveyed only by the dark fill, so a screen-reader user heard identical
          unrelated buttons and no current state. (1.4.1, 4.1.2) */}
      <div
        role="group"
        aria-label="Manifest view"
        className="mb-4 inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm"
      >
        <TabButton active={view === 'day'} onClick={() => setView('day')}>
          <CalendarDays className="h-4 w-4" aria-hidden /> Day
        </TabButton>
        <TabButton active={view === 'list'} onClick={() => setView('list')}>
          <List className="h-4 w-4" aria-hidden /> List
        </TabButton>
        <TabButton active={view === 'timeline'} onClick={() => setView('timeline')}>
          <GanttChartSquare className="h-4 w-4" aria-hidden /> Timeline
        </TabButton>
      </div>

      {view === 'day' ? (
        <DaySchedule rows={rows} timeZone={timeZone} isoDate={isoDate} />
      ) : view === 'list' ? (
        <ManifestList rows={rows} timeZone={timeZone} isoDate={isoDate} signLinkBase={signLinkBase} />
      ) : (
        <GanttManifest rows={rows} />
      )}
    </div>
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
