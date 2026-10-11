'use client';

/**
 * Repeating schedule builder — the FareHarbor-style "availabilities" editor,
 * written for the dad test: every rule reads as one plain sentence ("Runs May 1
 * to Sep 30, on Mon–Fri, departing at 8:00 AM, 10:00 AM and 2:00 PM, up to 10
 * guests"), and a live two-week calendar shows exactly what saving will do
 * BEFORE anything is saved: green = will be added, gray = already there,
 * amber = will come off, red = closed day.
 *
 * Power hides behind progressive disclosure: capacity override sits behind
 * "Set a different limit" (the default follows the boat's own capacity), and
 * one-off surgery (a single day's hours, closing a stretch) stays in the
 * day-by-day editor below this panel.
 */
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus, CalendarX2, Copy, Loader2, Pause, Pencil, Play, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Field, Select, TextInput } from './fields';
import {
  addBlackout,
  copyScheduleFrom,
  deleteScheduleRule,
  previewSchedule,
  saveScheduleRule,
  setScheduleRuleActive,
  removeBlackout,
  type PreviewDay,
  type RuleInput,
  type RuleView,
  type SchedulePreview,
} from '../../app/activities/schedule-rules-actions';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Consecutive closed days with one scope + reason, grouped for display. */
export interface BlackoutGroupView {
  ids: string[];
  startDate: string;
  endDate: string;
  reason: string | null;
  scope: 'activity' | 'operator';
}

export interface CopyOption {
  id: string;
  name: string;
  ruleCount: number;
}

export interface RuleSchedulerProps {
  activityId: string;
  /** The boat's own capacity — what a rule follows unless overridden. */
  boatCapacity: number;
  /** Today, YYYY-MM-DD, in the activity's operating timezone. */
  today: string;
  /**
   * Which kind the "Add a schedule" form opens on. Rental marina boats default
   * to 'rental' (an open rental window); tour boats to 'departures'. The operator
   * can flip the per-rule toggle either way regardless of this default.
   */
  defaultKind: 'rental' | 'departures';
  /** The boat's configured rental open edge (minutes since midnight), if any. */
  defaultOpenMinute: number | null;
  /** The boat's configured rental close edge (minutes since midnight), if any. */
  defaultCloseMinute: number | null;
  rules: RuleView[];
  blackouts: BlackoutGroupView[];
  copyOptions: CopyOption[];
}

// ---------------------------------------------------------------------------
// Plain-language labels
// ---------------------------------------------------------------------------

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday-first for humans
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function isoParts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return { y, m, d };
}

function isoWeekday(iso: string): number {
  const { y, m, d } = isoParts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addIsoDays(iso: string, days: number): string {
  const { y, m, d } = isoParts(iso);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** "Jul 4" — compact, no year (the builder lives in the near term). */
function shortDate(iso: string): string {
  const { m, d } = isoParts(iso);
  return `${MONTH_SHORT[m - 1]} ${d}`;
}

/** "Jul 4, 2027" when the year differs from this one. */
function seasonDate(iso: string, todayIso: string): string {
  const { y, m, d } = isoParts(iso);
  return y === isoParts(todayIso).y ? `${MONTH_SHORT[m - 1]} ${d}` : `${MONTH_SHORT[m - 1]} ${d}, ${y}`;
}

/** "8:00 AM" from minutes since midnight. */
function timeLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

/** "Mon–Fri", "Sat & Sun", "every day", "Mon, Wed & Fri". */
function weekdayPhrase(days: number[]): string {
  const set = new Set(days);
  if (set.size === 7) return 'every day';
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return 'Mon–Fri';
  if (set.size === 2 && set.has(0) && set.has(6)) return 'Sat & Sun';
  const names = WEEKDAY_ORDER.filter((d) => set.has(d)).map((d) => WEEKDAY_SHORT[d]);
  if (names.length === 1) return `${names[0]} only`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

type FormMode = { kind: 'closed' } | { kind: 'create' } | { kind: 'edit'; rule: RuleView };

export function RuleScheduler(props: RuleSchedulerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [mode, setMode] = useState<FormMode>({ kind: 'closed' });
  const [outcome, setOutcome] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function finish(result: { ok: boolean; message: string }) {
    setOutcome({ tone: result.ok ? 'good' : 'bad', text: result.message });
    if (result.ok) {
      setMode({ kind: 'closed' });
      setConfirmDeleteId(null);
      router.refresh();
    }
  }

  const act = (fn: () => Promise<{ ok: boolean; message: string }>) => {
    startTransition(async () => finish(await fn()));
  };

  return (
    <section
      aria-labelledby="rule-scheduler-heading"
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 id="rule-scheduler-heading" className="text-base font-semibold text-slate-900">
          Repeating schedule
        </h2>
        <p className="mt-0.5 text-sm text-slate-600">
          Tell it the pattern once — &ldquo;weekdays at 8, 10 and 2&rdquo; — and the calendar fills
          itself in and stays topped up, 60 days ahead. Booked departures are never touched.
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

      <div className="space-y-6 px-5 py-5">
        {/* ---- Saved rules ---- */}
        {props.rules.length === 0 && mode.kind === 'closed' ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-6 text-center">
            <p className="text-sm font-medium text-slate-700">No repeating schedule yet.</p>
            <p className="mt-1 text-sm text-slate-500">
              Add one and this boat&rsquo;s departures appear on the calendar automatically —
              or copy the schedule from a boat that already has one.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {props.rules.map((rule) => (
              <li
                key={rule.id}
                className={cn(
                  'rounded-lg border px-4 py-3',
                  rule.isActive ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50',
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <span className="truncate">{rule.name}</span>
                      {!rule.isActive ? (
                        <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                          Paused
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-sm text-slate-600">
                      {rule.kind === 'rental' &&
                      rule.openMinute !== null &&
                      rule.closeMinute !== null ? (
                        <>
                          Rentable {weekdayPhrase(rule.weekdays)} {timeLabel(rule.openMinute)}–
                          {timeLabel(rule.closeMinute)}, {seasonDate(rule.startDate, props.today)} to{' '}
                          {seasonDate(rule.endDate, props.today)} — up to{' '}
                          {rule.capacity ?? props.boatCapacity} guests
                          {rule.capacity === null ? ' (the boat’s capacity)' : ''}.
                        </>
                      ) : (
                        <>
                          Runs {seasonDate(rule.startDate, props.today)} to{' '}
                          {seasonDate(rule.endDate, props.today)}, {weekdayPhrase(rule.weekdays)},
                          departing at {listPhrase(rule.startMinutes.map(timeLabel))} — up to{' '}
                          {rule.capacity ?? props.boatCapacity} guests
                          {rule.capacity === null ? ' (the boat’s capacity)' : ''}.
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton
                      label={`Edit ${rule.name}`}
                      onClick={() => {
                        setOutcome(null);
                        setConfirmDeleteId(null);
                        setMode({ kind: 'edit', rule });
                      }}
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </IconButton>
                    <IconButton
                      label={rule.isActive ? `Pause ${rule.name}` : `Resume ${rule.name}`}
                      disabled={isPending}
                      onClick={() =>
                        act(() => setScheduleRuleActive(props.activityId, rule.id, !rule.isActive))
                      }
                    >
                      {rule.isActive ? (
                        <Pause className="h-4 w-4" aria-hidden />
                      ) : (
                        <Play className="h-4 w-4" aria-hidden />
                      )}
                    </IconButton>
                    <IconButton
                      label={`Remove ${rule.name}`}
                      disabled={isPending}
                      onClick={() => setConfirmDeleteId(rule.id)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </IconButton>
                  </div>
                </div>
                {confirmDeleteId === rule.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <p className="text-sm text-amber-900">
                      Remove this schedule? Its empty future departures come off the calendar.
                      Anything booked stays put.
                    </p>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => act(() => deleteScheduleRule(props.activityId, rule.id))}
                      className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-sm font-medium text-amber-900 hover:bg-amber-100"
                    >
                      Yes, remove it
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded-lg px-2.5 py-1 text-sm font-medium text-slate-600 hover:bg-white"
                    >
                      Keep it
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {/* ---- Add / edit form ---- */}
        {mode.kind === 'closed' ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setOutcome(null);
                setMode({ kind: 'create' });
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              <CalendarPlus className="h-4 w-4" aria-hidden />
              Add a schedule
            </button>
            <CopyControl {...props} disabled={isPending} onDone={finish} act={act} />
          </div>
        ) : (
          <RuleForm
            key={mode.kind === 'edit' ? mode.rule.id : 'new'}
            activityId={props.activityId}
            boatCapacity={props.boatCapacity}
            today={props.today}
            defaultKind={props.defaultKind}
            defaultOpenMinute={props.defaultOpenMinute}
            defaultCloseMinute={props.defaultCloseMinute}
            initial={mode.kind === 'edit' ? mode.rule : null}
            ruleCount={props.rules.length}
            onCancel={() => setMode({ kind: 'closed' })}
            onSaved={finish}
          />
        )}

        {/* ---- Closed dates ---- */}
        <BlackoutPanel {...props} disabled={isPending} act={act} />
      </div>
    </section>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg border border-transparent p-2 text-slate-500 hover:border-slate-200 hover:bg-slate-50 hover:text-slate-800 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The rule form + live preview
// ---------------------------------------------------------------------------

/** Selectable departure times: every half hour, 5:00 AM – 9:30 PM. */
const TIME_OPTIONS = Array.from({ length: 34 }, (_, i) => 5 * 60 + i * 30);

/** Selectable OPEN edges for a rental window: every half hour, 5:00 AM – 9:30 PM. */
const OPEN_OPTIONS = TIME_OPTIONS;
/** Selectable CLOSE edges: every half hour, 5:30 AM – 12:00 AM (midnight = 1440). */
const CLOSE_OPTIONS = Array.from({ length: 38 }, (_, i) => 5 * 60 + 30 + i * 30);

type RuleKind = 'rental' | 'departures';

interface RuleFormProps {
  activityId: string;
  boatCapacity: number;
  today: string;
  defaultKind: RuleKind;
  defaultOpenMinute: number | null;
  defaultCloseMinute: number | null;
  initial: RuleView | null;
  ruleCount: number;
  onCancel: () => void;
  onSaved: (result: { ok: boolean; message: string }) => void;
}

function RuleForm(props: RuleFormProps) {
  // An edited rule keeps its own kind; a brand-new one opens on the boat's default.
  const [kind, setKind] = useState<RuleKind>(props.initial?.kind ?? props.defaultKind);
  const [name, setName] = useState(props.initial?.name ?? '');
  const [startDate, setStartDate] = useState(props.initial?.startDate ?? props.today);
  const [endDate, setEndDate] = useState(
    props.initial?.endDate ?? addIsoDays(props.today, 120),
  );
  const [weekdays, setWeekdays] = useState<number[]>(props.initial?.weekdays ?? [1, 2, 3, 4, 5]);
  const [times, setTimes] = useState<number[]>(props.initial?.startMinutes ?? []);
  const [timeToAdd, setTimeToAdd] = useState(9 * 60);
  // Rental window edges. Seed from the edited rule, else the boat's configured
  // window, else a friendly 8 AM – 8 PM.
  const [openMinute, setOpenMinute] = useState<number>(
    props.initial?.openMinute ?? props.defaultOpenMinute ?? 8 * 60,
  );
  const [closeMinute, setCloseMinute] = useState<number>(
    props.initial?.closeMinute ?? props.defaultCloseMinute ?? 20 * 60,
  );
  const [capacity, setCapacity] = useState<number | null>(props.initial?.capacity ?? null);
  const [showCapacity, setShowCapacity] = useState(props.initial?.capacity != null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSaving, startSaving] = useTransition();

  const isRental = kind === 'rental';

  const draft: RuleInput = useMemo(
    () => ({
      id: props.initial?.id,
      kind,
      name: name.trim() || 'Schedule',
      startDate,
      endDate,
      weekdays,
      // Only the active shape carries values; the server normalizes the rest to
      // null/[] so a saved row is never half rental, half departures.
      startMinutes: isRental ? [] : times,
      openMinute: isRental ? openMinute : null,
      closeMinute: isRental ? closeMinute : null,
      capacity,
      isActive: props.initial?.isActive ?? true,
    }),
    [props.initial, kind, isRental, name, startDate, endDate, weekdays, times, openMinute, closeMinute, capacity],
  );

  const windowOk = !isRental || closeMinute > openMinute;
  const complete =
    weekdays.length > 0 &&
    endDate >= startDate &&
    windowOk &&
    (isRental ? true : times.length > 0);

  function toggleWeekday(day: number) {
    setWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b),
    );
  }

  function addTime() {
    setTimes((prev) =>
      prev.includes(timeToAdd) ? prev : [...prev, timeToAdd].sort((a, b) => a - b),
    );
  }

  function save() {
    setErrors({});
    startSaving(async () => {
      const result = await saveScheduleRule(props.activityId, {
        ...draft,
        name: name.trim() || suggestedName(),
      });
      if (!result.ok && result.errors) setErrors(result.errors);
      props.onSaved(result);
    });
  }

  function suggestedName(): string {
    if (isRental) {
      return `Rentable ${weekdayPhrase(weekdays)} ${timeLabel(openMinute)}–${timeLabel(closeMinute)}`.slice(
        0,
        80,
      );
    }
    return `${weekdayPhrase(weekdays)} at ${listPhrase(times.map(timeLabel))}`.slice(0, 80);
  }

  return (
    <div className="rounded-xl border border-slate-300 bg-slate-50/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            {props.initial ? `Edit “${props.initial.name}”` : 'New repeating schedule'}
          </h3>
          <p className="mt-0.5 text-sm text-slate-600">
            {isRental
              ? 'Set the days and the hours this boat is rentable. Nothing changes until you press save.'
              : 'Fill in the pattern and watch the two-week preview below — nothing changes until you press save.'}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close without saving"
          onClick={props.onCancel}
          className="rounded-lg p-2 text-slate-500 hover:bg-white hover:text-slate-800"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="mt-4 space-y-4">
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">What kind of schedule</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <KindCard
              selected={isRental}
              onClick={() => setKind('rental')}
              title="Open rental window"
              body="The boat is rentable for any stretch between an open and a close time — pick from, say, 8 AM to 8 PM."
            />
            <KindCard
              selected={!isRental}
              onClick={() => setKind('departures')}
              title="Scheduled departures"
              body="The boat leaves at set times — a tour at 9 AM, 12 PM and 3 PM. Guests book a departure."
            />
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Name"
            hint="Just for you — guests never see it."
            error={errors.name}
          >
            <TextInput
              value={name}
              placeholder={times.length > 0 ? suggestedName() : 'Summer weekdays'}
              invalid={Boolean(errors.name)}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Runs from" hint="The first day this pattern applies.">
            <TextInput type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field
            label="Until"
            hint="Add another schedule for a different season."
            error={endDate < startDate ? 'Has to be on or after the first date.' : errors.endDate}
          >
            <TextInput
              type="date"
              value={endDate}
              invalid={endDate < startDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-slate-700">On these days</legend>
          <p className="mt-0.5 text-xs text-slate-500">
            {isRental
              ? 'Which days of the week this boat can be rented.'
              : 'Which days of the week get these departures.'}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {WEEKDAY_ORDER.map((day) => {
              const on = weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleWeekday(day)}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-sm font-medium',
                    on
                      ? 'border-slate-400 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                  )}
                >
                  {WEEKDAY_SHORT[day]}
                </button>
              );
            })}
            <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />
            <QuickPick label="Every day" onClick={() => setWeekdays([0, 1, 2, 3, 4, 5, 6])} />
            <QuickPick label="Weekdays" onClick={() => setWeekdays([1, 2, 3, 4, 5])} />
            <QuickPick label="Weekends" onClick={() => setWeekdays([0, 6])} />
          </div>
          {weekdays.length === 0 ? (
            <p className="mt-1.5 text-sm text-rose-700">Pick at least one day.</p>
          ) : null}
        </fieldset>

        {isRental ? (
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">Rentable hours</legend>
            <p className="mt-0.5 text-xs text-slate-500">
              The boat is open for rental any time between these two — guests pick how long.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <Field label="Open time">
                <Select
                  aria-label="Open time"
                  value={openMinute}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setOpenMinute(next);
                    if (closeMinute <= next) {
                      const bumped = CLOSE_OPTIONS.find((m) => m > next);
                      if (bumped) setCloseMinute(bumped);
                    }
                  }}
                  className="w-auto"
                >
                  {OPEN_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {timeLabel(m)}
                    </option>
                  ))}
                </Select>
              </Field>
              <span className="mb-2 text-sm text-slate-500">to</span>
              <Field label="Close time" error={closeMinute <= openMinute ? 'After the open time.' : errors.closeMinute}>
                <Select
                  aria-label="Close time"
                  value={closeMinute}
                  invalid={closeMinute <= openMinute}
                  onChange={(e) => setCloseMinute(Number(e.target.value))}
                  className="w-auto"
                >
                  {CLOSE_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m === 24 * 60 ? '12:00 AM (midnight)' : timeLabel(m)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </fieldset>
        ) : (
          <fieldset>
          <legend className="text-sm font-medium text-slate-700">Departing at</legend>
          <p className="mt-0.5 text-xs text-slate-500">
            Each time becomes a bookable departure on every day picked above.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {times.map((minutes) => (
              <span
                key={minutes}
                className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white py-1 pl-3 pr-1 text-sm font-medium text-slate-800"
              >
                {timeLabel(minutes)}
                <button
                  type="button"
                  aria-label={`Remove ${timeLabel(minutes)}`}
                  onClick={() => setTimes((prev) => prev.filter((t) => t !== minutes))}
                  className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </span>
            ))}
            <Select
              aria-label="Time to add"
              value={timeToAdd}
              onChange={(e) => setTimeToAdd(Number(e.target.value))}
              className="w-auto"
            >
              {TIME_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {timeLabel(m)}
                </option>
              ))}
            </Select>
            <button
              type="button"
              onClick={addTime}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Add time
            </button>
          </div>
          {times.length === 0 ? (
            <p className="mt-1.5 text-sm text-rose-700">Add at least one departure time.</p>
          ) : null}
          </fieldset>
        )}

        <div>
          {!showCapacity ? (
            <p className="text-sm text-slate-600">
              {isRental ? 'This boat holds up to ' : 'Each departure holds up to '}
              <span className="font-semibold text-slate-900">{props.boatCapacity} guests</span> —
              the boat&rsquo;s capacity.{' '}
              <button
                type="button"
                onClick={() => {
                  setShowCapacity(true);
                  setCapacity(props.boatCapacity);
                }}
                className="font-medium text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500"
              >
                Set a different limit
              </button>
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <Field
                label={isRental ? 'Guests on board' : 'Guests per departure'}
                hint="Only for this schedule — the boat itself is unchanged."
              >
                <TextInput
                  type="number"
                  min={1}
                  max={999}
                  value={capacity ?? props.boatCapacity}
                  onChange={(e) => setCapacity(Math.max(1, Number(e.target.value) || 1))}
                  className="w-28"
                />
              </Field>
              <button
                type="button"
                onClick={() => {
                  setShowCapacity(false);
                  setCapacity(null);
                }}
                className="mb-1 text-sm font-medium text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
              >
                Back to boat capacity ({props.boatCapacity})
              </button>
            </div>
          )}
        </div>

        {isRental ? (
          <RentalSummary
            weekdays={weekdays}
            openMinute={openMinute}
            closeMinute={closeMinute}
            startDate={startDate}
            endDate={endDate}
            today={props.today}
            enabled={complete}
          />
        ) : (
          <LivePreview activityId={props.activityId} draft={draft} enabled={complete} />
        )}

        <div className="flex items-center gap-2 border-t border-slate-200 pt-4">
          <button
            type="button"
            disabled={!complete || isSaving}
            onClick={save}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {props.initial ? 'Save changes' : 'Save schedule'}
          </button>
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <p className="ml-auto hidden text-xs text-slate-500 sm:block">
            {isRental
              ? 'Saving opens these rentable hours on the week view below.'
              : 'Saving fills the next 60 days and keeps them topped up.'}
          </p>
        </div>
      </div>
    </div>
  );
}

function QuickPick({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
    >
      {label}
    </button>
  );
}

/** The two-up "which kind of schedule" selector card. Teal accent when chosen. */
function KindCard({
  selected,
  onClick,
  title,
  body,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex min-h-[44px] flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
        selected
          ? 'border-accent bg-accent-tint ring-2 ring-accent/30'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50',
      )}
    >
      <span className={cn('text-sm font-semibold', selected ? 'text-accent-ink' : 'text-slate-800')}>
        {title}
      </span>
      <span className="text-xs text-slate-500">{body}</span>
    </button>
  );
}

/**
 * Plain-language confirmation for a rental window, standing in for the departure
 * preview grid (a rental rule generates no fixed departures to draw). Reads like
 * "Rentable every day 8:00 AM–8:00 PM, Jun 1–Sep 30."
 */
function RentalSummary({
  weekdays,
  openMinute,
  closeMinute,
  startDate,
  endDate,
  today,
  enabled,
}: {
  weekdays: number[];
  openMinute: number;
  closeMinute: number;
  startDate: string;
  endDate: string;
  today: string;
  enabled: boolean;
}) {
  if (!enabled) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
        Pick the days and the open/close hours — the rentable-window summary appears here.
      </div>
    );
  }
  const closeLabel = closeMinute === 24 * 60 ? '12:00 AM' : timeLabel(closeMinute);
  return (
    <div className="rounded-lg border border-accent/30 bg-accent-tint p-4" aria-live="polite">
      <p className="text-sm font-medium text-accent-ink">
        Rentable {weekdayPhrase(weekdays)} {timeLabel(openMinute)}–{closeLabel},{' '}
        {seasonDate(startDate, today)}–{seasonDate(endDate, today)}.
      </p>
      <p className="mt-1 text-xs text-slate-600">
        Guests can book any stretch inside these hours. The week view below shades every
        rentable hour as soon as you save.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live two-week preview
// ---------------------------------------------------------------------------

function LivePreview({
  activityId,
  draft,
  enabled,
}: {
  activityId: string;
  draft: RuleInput;
  enabled: boolean;
}) {
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setPreview(null);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await previewSchedule(activityId, draft);
        if (seq.current === mine) setPreview(result);
      } finally {
        if (seq.current === mine) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [activityId, draft, enabled]);

  if (!enabled) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
        Pick days and departure times and the two-week preview appears here.
      </div>
    );
  }

  return (
    <div aria-live="polite">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-800">
          The next two weeks{loading ? '…' : ''}
        </h4>
        {preview?.ok ? <p className="text-xs text-slate-500">{preview.headline}</p> : null}
      </div>

      {preview && !preview.ok ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {preview.message}
        </p>
      ) : (
        <PreviewGrid days={preview?.days ?? []} dimmed={loading || !preview} />
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <LegendDot className="bg-emerald-500" label="will be added" />
        <LegendDot className="bg-slate-300" label="already there" />
        <LegendDot className="bg-amber-400" label="will come off" />
        <LegendDot className="bg-rose-400" label="closed day" />
        {preview?.protectedCount ? (
          <span className="text-accent">
            {preview.protectedCount} booked departure{preview.protectedCount === 1 ? '' : 's'} will
            be left exactly as {preview.protectedCount === 1 ? 'it is' : 'they are'}.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-2 w-2 rounded-full', className)} aria-hidden />
      {label}
    </span>
  );
}

function PreviewGrid({ days, dimmed }: { days: PreviewDay[]; dimmed: boolean }) {
  if (days.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-400">
        Working it out…
      </div>
    );
  }
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 lg:grid-cols-7',
        dimmed && 'opacity-60',
      )}
    >
      {days.map((day) => {
        const closed = day.blackoutReason !== null;
        return (
          <div
            key={day.date}
            className={cn('min-h-[76px] p-2', closed ? 'bg-rose-50' : 'bg-white')}
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              {WEEKDAY_SHORT[isoWeekday(day.date)]}{' '}
              <span className="text-slate-400">{shortDate(day.date)}</span>
            </p>
            {closed ? (
              <p className="mt-1 text-xs font-medium text-rose-700">
                {day.blackoutReason}
                {day.blackoutScope === 'operator' ? ' (whole marina)' : ''}
              </p>
            ) : day.times.length === 0 ? (
              <p className="mt-1 text-xs text-slate-300">—</p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1">
                {day.times.map((t) => (
                  <span
                    key={`${t.minutes}-${t.kind}`}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
                      t.kind === 'create' && 'bg-emerald-100 text-emerald-800',
                      t.kind === 'exists' && 'bg-slate-100 text-slate-600',
                      t.kind === 'removed' && 'bg-amber-100 text-amber-800 line-through',
                      t.kind === 'booked' && 'bg-accent-tint text-accent-ink',
                      t.kind === 'closed' && 'bg-slate-100 text-slate-400 line-through',
                    )}
                    title={
                      t.kind === 'create'
                        ? 'Will be added'
                        : t.kind === 'exists'
                          ? 'Already on the calendar'
                          : t.kind === 'removed'
                            ? 'Will come off (nothing booked)'
                            : t.kind === 'booked'
                              ? 'Has bookings — left alone'
                              : 'Closed by hand — stays closed'
                    }
                  >
                    {timeLabel(t.minutes)}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy from another boat
// ---------------------------------------------------------------------------

function CopyControl({
  activityId,
  copyOptions,
  disabled,
  act,
}: RuleSchedulerProps & {
  disabled: boolean;
  onDone: (r: { ok: boolean; message: string }) => void;
  act: (fn: () => Promise<{ ok: boolean; message: string }>) => void;
}) {
  const [sourceId, setSourceId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const options = copyOptions.filter((o) => o.ruleCount > 0);
  if (options.length === 0) return null;

  const source = options.find((o) => o.id === sourceId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-slate-500">or</span>
      <Select
        aria-label="Boat to copy the schedule from"
        value={sourceId}
        onChange={(e) => {
          setSourceId(e.target.value);
          setConfirming(false);
        }}
        className="w-auto"
      >
        <option value="">Copy schedule from…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
      {source && !confirming ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setConfirming(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <Copy className="h-4 w-4" aria-hidden />
          Copy
        </button>
      ) : null}
      {source && confirming ? (
        <span className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-900">
          Replaces this boat&rsquo;s schedule with {source.name}&rsquo;s. Bookings stay.
          <button
            type="button"
            disabled={disabled}
            onClick={() => act(() => copyScheduleFrom(activityId, source.id))}
            className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 font-medium hover:bg-amber-100"
          >
            Copy it
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-lg px-2 py-1 font-medium text-slate-600 hover:bg-white"
          >
            Never mind
          </button>
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Closed dates (blackouts)
// ---------------------------------------------------------------------------

function BlackoutPanel({
  activityId,
  today,
  blackouts,
  disabled,
  act,
}: RuleSchedulerProps & {
  disabled: boolean;
  act: (fn: () => Promise<{ ok: boolean; message: string }>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<'activity' | 'operator'>('activity');

  return (
    <div className="border-t border-slate-100 pt-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Closed dates</h3>
          <p className="mt-0.5 text-sm text-slate-600">
            Holidays, repairs, private events — closed days beat every schedule. Booked
            departures on a closed day are kept and called out, never deleted.
          </p>
        </div>
        {!open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <CalendarX2 className="h-4 w-4" aria-hidden />
            Close some dates
          </button>
        ) : null}
      </div>

      {blackouts.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {blackouts.map((group) => (
            <li
              key={group.ids[0]}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
            >
              <p className="text-sm text-slate-800">
                <span className="font-medium">
                  {group.startDate === group.endDate
                    ? seasonDate(group.startDate, today)
                    : `${seasonDate(group.startDate, today)} – ${seasonDate(group.endDate, today)}`}
                </span>
                {group.reason ? <span className="text-slate-600"> · {group.reason}</span> : null}
                <span
                  className={cn(
                    'ml-2 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                    group.scope === 'operator'
                      ? 'border-slate-300 bg-slate-100 text-slate-600'
                      : 'border-accent bg-accent-tint text-accent-ink',
                  )}
                >
                  {group.scope === 'operator' ? 'Whole marina' : 'This boat'}
                </span>
              </p>
              <button
                type="button"
                disabled={disabled}
                onClick={() => act(() => removeBlackout(activityId, group.ids))}
                className="text-sm font-medium text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
              >
                Re-open
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-slate-400">Nothing is closed.</p>
      )}

      {open ? (
        <div className="mt-3 rounded-lg border border-slate-300 bg-slate-50/60 p-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="First closed day">
              <TextInput
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (endDate < e.target.value) setEndDate(e.target.value);
                }}
              />
            </Field>
            <Field label="Last closed day" hint="Same day = closed for just that day.">
              <TextInput
                type="date"
                value={endDate}
                invalid={endDate < startDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </Field>
            <Field label="Why (optional)" hint="Shows on the preview so future-you remembers.">
              <TextInput
                value={reason}
                placeholder="Thanksgiving week"
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <Field label="Applies to" hint="The whole marina closes every boat those days.">
              <Select value={scope} onChange={(e) => setScope(e.target.value as 'activity' | 'operator')}>
                <option value="activity">Just this boat</option>
                <option value="operator">The whole marina</option>
              </Select>
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={disabled || endDate < startDate}
              onClick={() =>
                act(async () => {
                  const result = await addBlackout(activityId, {
                    activityId: scope === 'activity' ? activityId : null,
                    startDate,
                    endDate,
                    reason: reason.trim() || undefined,
                  });
                  if (result.ok) {
                    setOpen(false);
                    setReason('');
                  }
                  return result;
                })
              }
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Close these dates
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
