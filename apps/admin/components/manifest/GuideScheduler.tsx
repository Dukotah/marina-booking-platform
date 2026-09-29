'use client';

import { useMemo, useState, useTransition } from 'react';
import { UserPlus, X } from 'lucide-react';
import type { ManifestRow } from './types';
import type { GuideRosterEntry } from '../../app/manifest/data';
import { assignGuideAction, unassignGuideAction } from '../../app/manifest/actions';

/** "8:00 AM" from an ISO start (rendered in the browser's locale). */
function slotTime(startISO: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(
    new Date(startISO),
  );
}

/**
 * Assign guides to the day's timeslots (Singenuity §2 day-of ops). A compact
 * scheduler under the manifest: pick a slot, pick a guide, assign. Existing
 * assignments show as removable chips. Writes go through server actions
 * (tenant-scoped, order:write gated); the list re-renders on revalidate.
 */
export function GuideScheduler({
  rows,
  roster,
}: {
  rows: ManifestRow[];
  roster: GuideRosterEntry[];
}) {
  const slots = useMemo(
    () =>
      rows.flatMap((row) =>
        row.slots.map((s) => ({
          timeslotId: s.timeslotId,
          activityName: row.activityName,
          color: row.color,
          startISO: s.startISO,
          startMin: s.startMin,
          guides: s.guides,
        })),
      ).sort((a, b) => a.startMin - b.startMin || a.activityName.localeCompare(b.activityName)),
    [rows],
  );

  const [error, setError] = useState<string | null>(null);
  const [selectedGuide, setSelectedGuide] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error ?? 'Could not update the guide assignment.');
    });
  }

  if (slots.length === 0) {
    return <p className="text-sm text-slate-600">No departures today, so nothing to staff.</p>;
  }

  // No card chrome of its own anymore: this renders inside the manifest's
  // collapsed "Guides" section, which provides the border and the heading.
  return (
    <div>
      {/* role="alert": a failed assignment is an async failure with no focus move, so
          nothing else would tell a screen-reader user the write did not land.
          rose-700, not rose-600: rose-600 on rose-50 is 4.30:1. (4.1.3, 1.4.3) */}
      {error ? (
        <p role="alert" className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
          {error}
        </p>
      ) : null}

      {roster.length === 0 ? (
        <p className="text-sm text-slate-500">
          No staff available to schedule. Add a staff member with the Guide role first.
        </p>
      ) : (
        <div className="space-y-2">
          {slots.map((slot) => {
            // Every control in this row repeats across the whole day, so each one is
            // named with the slot it acts on. "Add guide" thirty times over tells a
            // screen-reader user which control they are on but not which timeslot it
            // books a guide onto. (4.1.2, 2.4.6)
            const slotLabel = `${slot.activityName} at ${slotTime(slot.startISO)}`;
            return (
              <div
                key={slot.timeslotId}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-3 py-2"
              >
                <span className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: slot.color }}
                    aria-hidden
                  />
                  <span className="tabular-nums">{slotTime(slot.startISO)}</span>
                  <span className="truncate">{slot.activityName}</span>
                </span>

                <div className="flex flex-wrap items-center gap-1.5">
                  {slot.guides.map((g) => (
                    <span
                      key={g.assignmentId}
                      className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700"
                    >
                      {g.guideName || g.guideEmail}
                      {/* The role suffix inherits sky-700 from the chip. It used to be
                          sky-400 on sky-50 — 1.98:1. The "·" carries the separation
                          that the lighter colour used to. (1.4.3) */}
                      {g.roleLabel ? <span> · {g.roleLabel}</span> : null}
                      <button
                        type="button"
                        disabled={isPending}
                        aria-label={`Remove ${g.guideName || g.guideEmail} from ${slotLabel}`}
                        onClick={() => run(() => unassignGuideAction(g.assignmentId))}
                        className="ml-0.5 rounded-full p-0.5 hover:bg-sky-100 disabled:opacity-50"
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>

                <div className="ml-auto flex items-center gap-1.5">
                  {/* Was a bare <select> with no label, no aria-label and no title:
                      one per timeslot, so a busy day is ninety-odd controls a screen
                      reader announces only as "combo box". (4.1.2 — axe select-name) */}
                  <select
                    aria-label={`Add a guide to ${slotLabel}`}
                    value={selectedGuide[slot.timeslotId] ?? ''}
                    onChange={(e) =>
                      setSelectedGuide((prev) => ({ ...prev, [slot.timeslotId]: e.target.value }))
                    }
                    className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700"
                  >
                    <option value="">Add guide…</option>
                    {roster.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name || g.email}
                        {g.role === 'GUIDE' ? '' : ` (${g.role.toLowerCase()})`}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={isPending || !selectedGuide[slot.timeslotId]}
                    onClick={() => {
                      const guideId = selectedGuide[slot.timeslotId];
                      if (!guideId) return;
                      run(async () => {
                        const res = await assignGuideAction(slot.timeslotId, guideId);
                        if (res.ok)
                          setSelectedGuide((prev) => ({ ...prev, [slot.timeslotId]: '' }));
                        return res;
                      });
                    }}
                    aria-label={`Assign the selected guide to ${slotLabel}`}
                    className="inline-flex items-center gap-1 rounded-md bg-sky-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-40"
                  >
                    <UserPlus className="h-3.5 w-3.5" aria-hidden /> Assign
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
