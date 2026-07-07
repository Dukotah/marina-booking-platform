'use client';

import { useState } from 'react';
import { List, GanttChartSquare } from 'lucide-react';
import { GanttManifest } from './GanttManifest';
import { ManifestList } from './ManifestList';
import type { ManifestRow } from './types';

/**
 * Toggle between the dense operational List (default — the daily driver) and the
 * visual Timeline (Gantt). Both read the same rows; the toggle is view-only client
 * state so switching never refetches.
 */
export function ManifestViews({ rows }: { rows: ManifestRow[] }) {
  const [view, setView] = useState<'list' | 'timeline'>('list');

  return (
    <div>
      <div className="mb-4 inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
        <TabButton active={view === 'list'} onClick={() => setView('list')}>
          <List className="h-4 w-4" aria-hidden /> List
        </TabButton>
        <TabButton active={view === 'timeline'} onClick={() => setView('timeline')}>
          <GanttChartSquare className="h-4 w-4" aria-hidden /> Timeline
        </TabButton>
      </div>

      {view === 'list' ? <ManifestList rows={rows} /> : <GanttManifest rows={rows} />}
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
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {children}
    </button>
  );
}
