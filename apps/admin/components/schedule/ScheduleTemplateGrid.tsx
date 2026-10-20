'use client';

/**
 * Schedule Template Designer — the per-activity weekly template grid, a faithful
 * replica of Singenuity's "Schedule Template → Times" screen.
 *
 * Rows are departure TIMES (9:00 AM, 9:30 AM, …), columns are the seven weekdays
 * (SUN..SAT). A cell that is ON shows the activity's price range, a "Max N"
 * capacity line, a star, and a per-cell ⋮ menu; an OFF cell is faint and empty.
 * The whole grid is a projection of the activity's departure ScheduleRules and
 * is reconciled back to them (REPLACE semantics) by saveScheduleTemplate.
 *
 * First pass — correctness over polish, no drag yet. Capacity is edited PER ROW
 * (a whole time); per-cell capacity is noted as a follow-up (see the engineering
 * report): the underlying model is one-rule-per-time, so a per-cell override
 * would have to split that time into its own rule for the differing day.
 */
import { useMemo, useRef, useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Loader2, MoreVertical, Plus, Star } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button, Select } from '../ui';
import {
  saveScheduleTemplate,
  type TemplatePayload,
} from '../../app/schedule/template-actions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One template row the server projected from the rules. */
export interface TemplateRow {
  /** Minutes since local midnight. Unique per row. */
  minute: number;
  /** Weekdays this time is active on (0=Sun..6=Sat). */
  weekdays: number[];
  /** Guests per departure. null = follow the boat's capacity. */
  capacity: number | null;
}

export interface ScheduleTemplateGridProps {
  activityId: string;
  /** Template label — seeded from an existing departure rule's name, else blank. */
  templateName: string;
  /** Activity display name for the subtitle. */
  activityName: string;
  /** Inclusive season bounds (YYYY-MM-DD) carried onto every saved rule. */
  startDate: string;
  endDate: string;
  /** Pre-expanded grid rows (one per distinct departure time). */
  rows: TemplateRow[];
  /** min/max of the activity's active rate prices, in cents. null = no rates. */
  priceRange: { minCents: number; maxCents: number } | null;
  /** The boat's own capacity — the fallback "Max N" when a row has no override. */
  defaultCapacity: number;
  /** Pre-formatted price range string ("$125.00 - $1,000.00"), or null. */
  priceLabel: string | null;
}

// ---------------------------------------------------------------------------
// Labels + time options
// ---------------------------------------------------------------------------

const WEEKDAY_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Selectable departure times: every half hour, 6:00 AM – 9:30 PM. */
const TIME_OPTIONS = Array.from({ length: 32 }, (_, i) => 6 * 60 + i * 30);

/** "9:00 AM" from minutes since midnight. */
function timeLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

// ---------------------------------------------------------------------------
// A tiny accessible dropdown menu (caret / three-dot triggers share it)
// ---------------------------------------------------------------------------

interface MenuItem {
  label: string;
  onSelect: () => void;
  tone?: 'default' | 'danger';
}

function Menu({
  trigger,
  items,
  align = 'left',
  label,
}: {
  trigger: React.ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center rounded text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {trigger}
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            'absolute top-full z-20 mt-1 min-w-[11rem] overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                'block w-full px-3 py-2 text-left text-sm hover:bg-surface-muted',
                item.tone === 'danger' ? 'text-rose-700' : 'text-ink-body',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The designer
// ---------------------------------------------------------------------------

export function ScheduleTemplateGrid(props: ScheduleTemplateGridProps) {
  const router = useRouter();
  const [isSaving, startSaving] = useTransition();
  const [outcome, setOutcome] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const [name, setName] = useState(props.templateName || `${props.activityName} schedule`);
  const [rows, setRows] = useState<TemplateRow[]>(() =>
    [...props.rows].sort((a, b) => a.minute - b.minute),
  );

  // Add-a-time picker state.
  const [adding, setAdding] = useState(false);
  const takenMinutes = useMemo(() => new Set(rows.map((r) => r.minute)), [rows]);
  const firstFree = TIME_OPTIONS.find((m) => !takenMinutes.has(m)) ?? 9 * 60;
  const [newMinute, setNewMinute] = useState(firstFree);

  function cellOn(row: TemplateRow, day: number): boolean {
    return row.weekdays.includes(day);
  }

  function updateRow(minute: number, next: Partial<TemplateRow>) {
    setRows((prev) =>
      prev.map((r) => (r.minute === minute ? { ...r, ...next } : r)),
    );
  }

  function toggleCell(minute: number, day: number) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.minute !== minute) return r;
        const on = r.weekdays.includes(day);
        return {
          ...r,
          weekdays: on
            ? r.weekdays.filter((d) => d !== day)
            : [...r.weekdays, day].sort((a, b) => a - b),
        };
      }),
    );
  }

  function toggleColumn(day: number) {
    // Turn the whole column off if every row has it on; else turn it on everywhere.
    const allOn = rows.length > 0 && rows.every((r) => r.weekdays.includes(day));
    setRows((prev) =>
      prev.map((r) => {
        const on = r.weekdays.includes(day);
        if (allOn && on) return { ...r, weekdays: r.weekdays.filter((d) => d !== day) };
        if (!allOn && !on) return { ...r, weekdays: [...r.weekdays, day].sort((a, b) => a - b) };
        return r;
      }),
    );
  }

  function removeRow(minute: number) {
    setRows((prev) => prev.filter((r) => r.minute !== minute));
  }

  function changeRowTime(minute: number) {
    const raw = window.prompt(
      'New time (24-hour HH:MM, e.g. 14:30):',
      `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
    );
    if (!raw) return;
    const m = parseHHMM(raw);
    if (m === null) {
      setOutcome({ tone: 'bad', text: 'Enter a time as HH:MM, like 14:30.' });
      return;
    }
    if (takenMinutes.has(m) && m !== minute) {
      setOutcome({ tone: 'bad', text: `There's already a ${timeLabel(m)} row.` });
      return;
    }
    updateRow(minute, { minute: m });
    setRows((prev) => [...prev].sort((a, b) => a.minute - b.minute));
  }

  function setRowCapacity(minute: number, current: number | null) {
    const raw = window.prompt(
      'Guests per departure for this time (blank = boat capacity):',
      current === null ? '' : String(current),
    );
    if (raw === null) return;
    const trimmed = raw.trim();
    if (trimmed === '') {
      updateRow(minute, { capacity: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 1 || n > 999) {
      setOutcome({ tone: 'bad', text: 'Capacity has to be a whole number from 1 to 999.' });
      return;
    }
    updateRow(minute, { capacity: n });
  }

  function addTime() {
    if (takenMinutes.has(newMinute)) {
      setOutcome({ tone: 'bad', text: `There's already a ${timeLabel(newMinute)} row.` });
      return;
    }
    // New time defaults ON for all seven days at the boat's capacity.
    setRows((prev) =>
      [...prev, { minute: newMinute, weekdays: [...ALL_DAYS], capacity: null }].sort(
        (a, b) => a.minute - b.minute,
      ),
    );
    setAdding(false);
  }

  function save() {
    const payload: TemplatePayload = {
      name: name.trim() || `${props.activityName} schedule`,
      startDate: props.startDate,
      endDate: props.endDate,
      rows: rows.map((r) => ({ minute: r.minute, weekdays: r.weekdays, capacity: r.capacity })),
    };
    startSaving(async () => {
      const result = await saveScheduleTemplate(props.activityId, payload);
      setOutcome({ tone: result.ok ? 'good' : 'bad', text: result.message });
      if (result.ok) router.refresh();
    });
  }

  const priceLine = props.priceLabel ?? 'No rates yet';

  return (
    <section aria-labelledby="template-heading" className="space-y-5">
      {/* Big template name + subtitle. */}
      <div>
        <input
          aria-label="Template name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full max-w-xl bg-transparent text-2xl font-bold tracking-tight text-ink focus:outline-none focus:ring-2 focus:ring-focus rounded"
        />
        <p className="mt-1 text-sm text-ink-body">
          Template Schedule ({props.activityName})
        </p>
      </div>

      {/* Basic Info | Times tabs. */}
      <TemplateTabs />

      {/* Outcome banner. */}
      <p
        role="status"
        aria-live="polite"
        className={
          outcome
            ? cn(
                'rounded-lg border px-4 py-3 text-sm font-medium',
                outcome.tone === 'good'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-rose-200 bg-rose-50 text-rose-800',
              )
            : 'sr-only'
        }
      >
        {outcome?.text ?? ''}
      </p>

      {/* Times header row. */}
      <div className="flex items-center justify-between">
        <h2 id="template-heading" className="text-base font-semibold text-ink">
          Times
        </h2>
        <div className="flex items-center gap-2">
          {adding ? (
            <div className="flex items-center gap-2">
              <Select
                aria-label="Time to add"
                value={newMinute}
                onChange={(e) => setNewMinute(Number(e.target.value))}
                className="h-9 w-auto"
              >
                {TIME_OPTIONS.map((m) => (
                  <option key={m} value={m} disabled={takenMinutes.has(m)}>
                    {timeLabel(m)}
                  </option>
                ))}
              </Select>
              <Button size="sm" onClick={addTime}>
                Add
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setNewMinute(firstFree);
                setAdding(true);
              }}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add A Time
            </Button>
          )}
        </div>
      </div>

      {/* The grid. */}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-sm">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="w-28 px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Time
              </th>
              {ALL_DAYS.map((day) => (
                <th
                  key={day}
                  scope="col"
                  className="px-2 py-3 text-center text-xs font-semibold uppercase tracking-wide text-ink-muted"
                >
                  <span className="inline-flex items-center gap-1">
                    {WEEKDAY_SHORT[day]}
                    <Menu
                      label={`${WEEKDAY_SHORT[day]} column actions`}
                      align="left"
                      trigger={<ChevronDown className="h-3.5 w-3.5" aria-hidden />}
                      items={[
                        {
                          label:
                            rows.length > 0 && rows.every((r) => r.weekdays.includes(day))
                              ? `Turn ${WEEKDAY_SHORT[day]} off`
                              : `Turn ${WEEKDAY_SHORT[day]} on`,
                          onSelect: () => toggleColumn(day),
                        },
                      ]}
                    />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-sm text-ink-muted">
                  No times yet. Use <span className="font-medium">＋ Add A Time</span> to start the template.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.minute} className="border-b border-line last:border-b-0">
                  {/* Row label: the time + its caret menu. */}
                  <th scope="row" className="px-3 py-4 text-left align-top">
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-ink">
                      {timeLabel(row.minute)}
                      <Menu
                        label={`${timeLabel(row.minute)} row actions`}
                        align="left"
                        trigger={<ChevronDown className="h-3.5 w-3.5" aria-hidden />}
                        items={[
                          { label: 'Edit time', onSelect: () => changeRowTime(row.minute) },
                          {
                            label: 'Set capacity for this time',
                            onSelect: () => setRowCapacity(row.minute, row.capacity),
                          },
                          {
                            label: 'Remove this time',
                            tone: 'danger',
                            onSelect: () => removeRow(row.minute),
                          },
                        ]}
                      />
                    </span>
                  </th>

                  {ALL_DAYS.map((day) => {
                    const on = cellOn(row, day);
                    return (
                      <td
                        key={day}
                        className={cn(
                          'px-2 py-3 text-center align-top',
                          on ? 'bg-surface' : 'bg-surface-muted/40',
                        )}
                      >
                        {on ? (
                          <div className="mx-auto flex max-w-[9rem] flex-col items-center gap-0.5 rounded-lg border border-line/70 bg-surface px-2 py-2">
                            <span className="text-[11px] font-medium tabular-nums text-ink">
                              {priceLine}
                            </span>
                            <span className="text-[11px] text-ink-muted">
                              Max {row.capacity ?? props.defaultCapacity}
                            </span>
                            <div className="mt-0.5 flex items-center gap-2">
                              <Star className="h-3.5 w-3.5 text-amber-400" aria-hidden />
                              <Menu
                                label={`${timeLabel(row.minute)} ${WEEKDAY_SHORT[day]} cell actions`}
                                align="right"
                                trigger={<MoreVertical className="h-3.5 w-3.5" aria-hidden />}
                                items={[
                                  {
                                    label: `Turn ${WEEKDAY_SHORT[day]} off here`,
                                    onSelect: () => toggleCell(row.minute, day),
                                  },
                                  {
                                    label: 'Set capacity (whole time)',
                                    onSelect: () => setRowCapacity(row.minute, row.capacity),
                                  },
                                ]}
                              />
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            aria-label={`Turn on ${timeLabel(row.minute)} on ${WEEKDAY_SHORT[day]}`}
                            onClick={() => toggleCell(row.minute, day)}
                            className="mx-auto flex h-12 w-full max-w-[9rem] items-center justify-center rounded-lg border border-dashed border-line text-ink-muted/50 hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                          >
                            <Plus className="h-4 w-4" aria-hidden />
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={isSaving}>
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Save template
        </Button>
        <p className="text-xs text-ink-muted">
          Saving rebuilds this boat&rsquo;s departures and fills the next 60 days. Rental windows are left alone.
        </p>
      </div>
    </section>
  );
}

/** Basic Info | Times underline tabs. Times is active; Basic Info is a stub. */
function TemplateTabs() {
  const [active, setActive] = useState<'basic' | 'times'>('times');
  return (
    <div className="border-b border-line">
      <nav className="flex gap-6" aria-label="Template sections">
        {(
          [
            { id: 'basic', label: 'Basic Info' },
            { id: 'times', label: 'Times' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-current={active === tab.id ? 'page' : undefined}
            onClick={() => setActive(tab.id)}
            className={cn(
              '-mb-px border-b-2 px-1 py-2.5 text-sm font-medium transition-colors',
              active === tab.id
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-muted hover:text-ink-body',
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

/** Parse "HH:MM" (24-hour) to minutes since midnight, or null if invalid. */
function parseHHMM(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
