'use client';

/**
 * Hours and closed dates for an activity that already exists.
 *
 * The blocker this fixes: operating hours were set once, inside the create wizard,
 * and could never be changed again. A marina's year does not work that way — summer
 * hours differ from spring, and a boat goes in for service for three weeks — so this
 * panel edits hours, days of the week and closed dates for a STRETCH OF DATES.
 *
 * It is written for someone who is not going to phone anybody about it:
 *
 *   - Every change is a two-step. Press "Show me what this will do" and the server
 *     works out the answer and hands it back unexecuted: how many days, which days,
 *     what times, what happens to times that already exist. Only then does a second,
 *     separate button actually do it. Touching any field throws the preview away, so
 *     what he confirms is always what he read.
 *   - Days with bookings on them are called out by name, in a box he cannot miss, and
 *     are never changed. When he asked for something that would have hit one, the
 *     confirm button stays off until he ticks the box agreeing to skip those days.
 *     Nobody's Saturday gets deleted by a schedule edit.
 *   - Plain words throughout: "start times", not "timeslots"; "close a date", not
 *     "blackout"; a date range, not a horizon.
 *
 * Accessibility: every control has an explicit id and label, the day-of-the-week and
 * "days that already have times" choices are fieldsets with legends, the preview is a
 * real table with headers, focus moves to the preview when it appears (so it is not a
 * silent change on screen), and outcomes are announced through a live region. No text
 * is white on a brand colour.
 */
import { useEffect, useId, useRef, useState, useTransition, type MutableRefObject } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarX2, Check, Loader2, RotateCcw, X } from 'lucide-react';
import { Field, TextInput } from './fields';
import { cn } from '../../lib/cn';
import {
  applyScheduleChange,
  planScheduleChange,
  type ScheduleDayPlan,
  type ScheduleOperation,
  type SchedulePlan,
} from '../../app/activities/actions';

// ---------------------------------------------------------------------------
// What the page hands in
// ---------------------------------------------------------------------------

/** A day that currently has every one of its start times switched off. */
export interface ClosedDay {
  /** YYYY-MM-DD in the operator timezone. */
  date: string;
  /** How many start times are switched off on it. */
  timeCount: number;
}

/** The truth about what is on the calendar right now — facts, not guesses. */
export interface ScheduleSnapshot {
  /** IANA timezone this activity operates in. */
  timezone: string;
  /** Today in that timezone, YYYY-MM-DD. */
  today: string;
  /** First and last upcoming day carrying bookable times. Null when there are none. */
  firstDate: string | null;
  lastDate: string | null;
  /** Upcoming days with times, and how many times across them. */
  dayCount: number;
  timeCount: number;
  /** How many of those days already have bookings. */
  bookedDayCount: number;
  /** Days of the week currently in use, 0 = Sunday. */
  weekdays: number[];
  /** Distinct minutes-since-midnight of the start times in use, ascending. */
  startMinutes: number[];
  closedDays: ClosedDay[];
}

/** What the hours form opens with — derived from the activity's real slots. */
export interface ScheduleDefaults {
  openHour: number;
  closeHour: number;
  intervalMinutes: number;
  capacityPerSlot: number;
  weekdays: number[];
  startDate: string;
  endDate: string;
}

export interface ScheduleEditorProps {
  activityId: string;
  snapshot: ScheduleSnapshot;
  defaults: ScheduleDefaults;
}

// ---------------------------------------------------------------------------
// Labels
//
// Built from the YYYY-MM-DD parts by hand rather than through a Date: parsing
// '2026-07-04' gives UTC midnight, which renders as July 3rd for anyone west of
// Greenwich. A date the operator typed must never move under him.
// ---------------------------------------------------------------------------

const WEEKDAYS = [
  { value: 0, short: 'Sun', long: 'Sunday' },
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
] as const;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function isoParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return [y, m, d];
}

/** "Sat Jul 4, 2026" — no comma after the weekday, so these read cleanly in a list. */
function longLabel(iso: string): string {
  const [y, m, d] = isoParts(iso);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[dow].short} ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "9:00 AM" from minutes since midnight. */
function timeLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

/** "9:00 AM" for a whole hour on the clock; 24 is midnight at the end of the day. */
function hourLabel(hour: number): string {
  if (hour === 24) return 'Midnight';
  return timeLabel(hour * 60);
}

/** "Fridays, Saturdays and Sundays" */
function weekdayPhrase(days: number[]): string {
  const names = [...new Set(days)].sort((a, b) => a - b).map((d) => `${WEEKDAYS[d].long}s`);
  if (names.length === 0) return 'no days';
  if (names.length === 7) return 'every day';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`;
}

/** Verb agreement for a counted subject, so "4 days already has" never ships. */
function hasHave(count: number): string {
  return count === 1 ? 'has' : 'have';
}

// ---------------------------------------------------------------------------
// Hint and error text, tied to the control it belongs to
//
// `Field`'s own hint/error slots render loose text at `text-slate-400`, which is
// 2.6:1 on white and is announced to nobody because nothing points at it. These two
// helpers render the same thing at a readable contrast and wire it to the input with
// aria-describedby, so the reason a field is refused reaches a screen reader as well
// as an eye. (The shared `Field` is not ours to change — see the report.)
// ---------------------------------------------------------------------------

/** The id a control should point aria-describedby at: the error if any, else the hint. */
function describedBy(id: string, hint?: string, error?: string): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

function HelpText({ id, hint, error }: { id: string; hint?: string; error?: string }) {
  if (error) {
    // role="alert" so a message that appears while the operator is mid-form is spoken,
    // not just drawn under a field he may already have moved past.
    return (
      <p id={`${id}-error`} role="alert" className="text-xs font-medium text-rose-700">
        {error}
      </p>
    );
  }
  if (hint) {
    return (
      <p id={`${id}-hint`} className="text-xs text-slate-600">
        {hint}
      </p>
    );
  }
  return null;
}

/** How each planned day is described in the preview table. */
const DAY_ACTION_LABEL: Record<ScheduleDayPlan['action'], string> = {
  CREATE: 'Gets the new times',
  REPLACE: 'Times replaced',
  KEEP: 'Left as it is',
  BLOCKED: 'Has bookings — not touched',
  LEFT_CLOSED: 'Closed — stays closed',
  CLOSE: 'Closed',
  REOPEN: 'Opened back up',
};

// ---------------------------------------------------------------------------
// Local form state
// ---------------------------------------------------------------------------

/** Numbers stay as text so a half-typed value is not coerced to 0 under the cursor. */
interface HoursDraft {
  startDate: string;
  endDate: string;
  weekdays: number[];
  openHour: number;
  closeHour: number;
  intervalMinutes: string;
  capacityPerSlot: string;
  existingDays: 'keep' | 'replace';
}

interface CloseDraft {
  startDate: string;
  endDate: string;
}

/** A preview the operator is looking at, plus what it would take to run it. */
interface Pending {
  operation: ScheduleOperation;
  /** Which panel raised it, so the review renders under the right form. */
  source: 'hours' | 'close' | 'reopen';
  plan: SchedulePlan;
  /** The exact payload the confirm button will send. */
  input: Record<string, unknown>;
}

type Outcome = { tone: 'good' | 'bad'; text: string } | null;

const HOUR_CHOICES = Array.from({ length: 25 }, (_, h) => h);

const CLOSE_HINT = 'The last start time is before this.';
const INTERVAL_HINT = 'In minutes. 240 is every four hours.';
const CAPACITY_HINT = 'How many can book each one.';

// ---------------------------------------------------------------------------

export function ScheduleEditor({ activityId, snapshot, defaults }: ScheduleEditorProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pending, setPending] = useState<Pending | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const [hours, setHours] = useState<HoursDraft>({
    startDate: defaults.startDate,
    endDate: defaults.endDate,
    weekdays: defaults.weekdays,
    openHour: defaults.openHour,
    closeHour: defaults.closeHour,
    intervalMinutes: String(defaults.intervalMinutes),
    capacityPerSlot: String(defaults.capacityPerSlot),
    existingDays: 'keep',
  });
  const [closeRange, setCloseRange] = useState<CloseDraft>({
    startDate: snapshot.today,
    endDate: snapshot.today,
  });

  const reviewRef = useRef<HTMLHeadingElement | null>(null);

  // A preview appearing further down the page is a silent change for anyone not
  // looking at that spot, so send focus to it. It also puts the confirm button one
  // Tab away instead of a dozen.
  useEffect(() => {
    if (pending) reviewRef.current?.focus();
  }, [pending]);

  /** Any edit invalidates the preview: he must never confirm something he didn't read. */
  function editHours(patch: Partial<HoursDraft>) {
    setPending(null);
    setAcknowledged(false);
    setHours((h) => ({ ...h, ...patch }));
  }

  function editCloseRange(patch: Partial<CloseDraft>) {
    setPending(null);
    setAcknowledged(false);
    setCloseRange((c) => ({ ...c, ...patch }));
  }

  function discardPreview() {
    setPending(null);
    setAcknowledged(false);
  }

  function preview(operation: ScheduleOperation, source: Pending['source'], input: Record<string, unknown>) {
    setOutcome(null);
    setAcknowledged(false);
    startTransition(async () => {
      const plan = await planScheduleChange(operation, input);
      if (!plan.ok) {
        setPending(null);
        setOutcome({ tone: 'bad', text: plan.message ?? 'That could not be worked out.' });
        return;
      }
      setPending({ operation, source, plan, input });
    });
  }

  function confirm() {
    if (!pending) return;
    const payload = { ...pending.input, acknowledgeBookedDays: acknowledged };
    startTransition(async () => {
      const result = await applyScheduleChange(pending.operation, payload);
      setOutcome({ tone: result.ok ? 'good' : 'bad', text: result.message });
      if (result.ok) {
        setPending(null);
        setAcknowledged(false);
        router.refresh();
      }
    });
  }

  // --- the hours form's inputs, validated in the browser before the round trip ---

  const interval = Number(hours.intervalMinutes);
  const capacity = Number(hours.capacityPerSlot);
  const intervalError =
    !Number.isInteger(interval) || interval < 5
      ? 'Use a whole number of minutes, 5 or more.'
      : undefined;
  const capacityError =
    !Number.isInteger(capacity) || capacity < 1 ? 'At least 1 person.' : undefined;
  const closeHourError =
    hours.closeHour <= hours.openHour ? 'Closing time has to be after opening time.' : undefined;
  const weekdayError = hours.weekdays.length === 0 ? 'Pick at least one day.' : undefined;
  const rangeError =
    hours.endDate < hours.startDate ? 'The end date has to be on or after the first date.' : undefined;
  const hoursReady =
    !intervalError && !capacityError && !closeHourError && !weekdayError && !rangeError;
  const pastRange = hours.endDate < snapshot.today;

  const closeRangeError =
    closeRange.endDate < closeRange.startDate
      ? 'The end date has to be on or after the first date.'
      : undefined;

  function previewHours() {
    preview('GENERATE', 'hours', {
      activityId,
      startDate: hours.startDate,
      endDate: hours.endDate,
      weekdays: hours.weekdays,
      openHour: hours.openHour,
      closeHour: hours.closeHour,
      intervalMinutes: interval,
      capacityPerSlot: capacity,
      existingDays: hours.existingDays,
      acknowledgeBookedDays: false,
    });
  }

  function previewClose() {
    preview('CLOSE', 'close', {
      activityId,
      startDate: closeRange.startDate,
      endDate: closeRange.endDate,
      acknowledgeBookedDays: false,
    });
  }

  function previewReopen(date: string) {
    preview('REOPEN', 'reopen', {
      activityId,
      startDate: date,
      endDate: date,
      acknowledgeBookedDays: false,
    });
  }

  const ids = {
    hoursStart: useId(),
    hoursEnd: useId(),
    open: useId(),
    close: useId(),
    interval: useId(),
    capacity: useId(),
    existing: useId(),
    closeStart: useId(),
    closeEnd: useId(),
    ack: useId(),
    confirmHelp: useId(),
  };

  const review = pending ? (
    <PlanReview
      pending={pending}
      headingRef={reviewRef}
      acknowledged={acknowledged}
      onAcknowledge={setAcknowledged}
      onConfirm={confirm}
      onCancel={discardPreview}
      isPending={isPending}
      ackId={ids.ack}
      helpId={ids.confirmHelp}
    />
  ) : null;

  return (
    <section
      aria-labelledby="schedule-editor-heading"
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 id="schedule-editor-heading" className="text-base font-semibold text-slate-900">
          Hours and closed dates
        </h2>
        <p className="mt-0.5 text-sm text-slate-600">
          Change what times you run, on which days, between any two dates. Nothing happens
          until you have read what it will do and pressed the second button.
        </p>
      </div>

      {/*
        One live region for the whole panel. A change that succeeds inside a transition
        alters things further up the page, so the outcome has to be announced rather
        than only rendered somewhere he may not be looking.
      */}
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

      <div className="space-y-8 px-5 py-5">
        <CurrentPicture snapshot={snapshot} />

        {/* ---- Hours across a date range ---- */}
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Set the hours for a stretch of dates</h3>
          <p className="mt-0.5 text-sm text-slate-600">
            Summer hours, spring hours, a holiday weekend — pick the dates and the times, and
            these become the start times guests can book.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="First date" htmlFor={ids.hoursStart}>
              <TextInput
                id={ids.hoursStart}
                type="date"
                value={hours.startDate}
                onChange={(e) => editHours({ startDate: e.target.value })}
              />
            </Field>
            <Field label="Last date" htmlFor={ids.hoursEnd}>
              <TextInput
                id={ids.hoursEnd}
                type="date"
                value={hours.endDate}
                invalid={Boolean(rangeError)}
                aria-invalid={rangeError ? true : undefined}
                aria-describedby={describedBy(ids.hoursEnd, undefined, rangeError)}
                onChange={(e) => editHours({ endDate: e.target.value })}
              />
              <HelpText id={ids.hoursEnd} error={rangeError} />
            </Field>
          </div>

          {pastRange ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Those dates have already gone by. Check the year.
            </p>
          ) : null}

          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-slate-700">
              Days you are open
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => {
                const checked = hours.weekdays.includes(day.value);
                return (
                  <label
                    key={day.value}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium',
                      checked
                        ? 'border-slate-400 bg-slate-100 text-slate-900'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
                      checked={checked}
                      onChange={(e) =>
                        editHours({
                          weekdays: e.target.checked
                            ? [...hours.weekdays, day.value].sort((a, b) => a - b)
                            : hours.weekdays.filter((d) => d !== day.value),
                        })
                      }
                    />
                    <span>
                      <span aria-hidden>{day.short}</span>
                      <span className="sr-only">{day.long}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {weekdayError ? (
              <p className="mt-1.5 text-xs font-medium text-rose-700">{weekdayError}</p>
            ) : (
              <p className="mt-1.5 text-xs text-slate-600">
                Days you leave unticked are not touched at all.
              </p>
            )}
          </fieldset>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Opens at" htmlFor={ids.open}>
              <select
                id={ids.open}
                value={hours.openHour}
                onChange={(e) => editHours({ openHour: Number(e.target.value) })}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
              >
                {HOUR_CHOICES.slice(0, 24).map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Closes at" htmlFor={ids.close}>
              <select
                id={ids.close}
                value={hours.closeHour}
                aria-invalid={closeHourError ? true : undefined}
                aria-describedby={describedBy(ids.close, CLOSE_HINT, closeHourError)}
                onChange={(e) => editHours({ closeHour: Number(e.target.value) })}
                className={cn(
                  'w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:ring-2',
                  closeHourError
                    ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-100'
                    : 'border-slate-300 focus:border-slate-500 focus:ring-slate-200',
                )}
              >
                {HOUR_CHOICES.slice(1).map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
              <HelpText id={ids.close} hint={CLOSE_HINT} error={closeHourError} />
            </Field>

            <Field label="A new start time every" htmlFor={ids.interval}>
              <TextInput
                id={ids.interval}
                type="number"
                min={5}
                step={5}
                inputMode="numeric"
                value={hours.intervalMinutes}
                invalid={Boolean(intervalError)}
                aria-invalid={intervalError ? true : undefined}
                aria-describedby={describedBy(ids.interval, INTERVAL_HINT, intervalError)}
                onChange={(e) => editHours({ intervalMinutes: e.target.value })}
              />
              <HelpText id={ids.interval} hint={INTERVAL_HINT} error={intervalError} />
            </Field>

            <Field label="People per start time" htmlFor={ids.capacity}>
              <TextInput
                id={ids.capacity}
                type="number"
                min={1}
                inputMode="numeric"
                value={hours.capacityPerSlot}
                invalid={Boolean(capacityError)}
                aria-invalid={capacityError ? true : undefined}
                aria-describedby={describedBy(ids.capacity, CAPACITY_HINT, capacityError)}
                onChange={(e) => editHours({ capacityPerSlot: e.target.value })}
              />
              <HelpText id={ids.capacity} hint={CAPACITY_HINT} error={capacityError} />
            </Field>
          </div>

          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-slate-700">
              Days in this stretch that already have times
            </legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
                <input
                  type="radio"
                  name={`${ids.existing}-choice`}
                  className="mt-0.5 h-4 w-4 border-slate-300 text-slate-900 focus:ring-slate-400"
                  checked={hours.existingDays === 'keep'}
                  onChange={() => editHours({ existingDays: 'keep' })}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-800">Leave them alone</span>
                  <span className="block text-xs text-slate-600">
                    Only days with no times on them get the new hours. Safest.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
                <input
                  type="radio"
                  name={`${ids.existing}-choice`}
                  className="mt-0.5 h-4 w-4 border-slate-300 text-slate-900 focus:ring-slate-400"
                  checked={hours.existingDays === 'replace'}
                  onChange={() => editHours({ existingDays: 'replace' })}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-800">
                    Change them to the new hours
                  </span>
                  <span className="block text-xs text-slate-600">
                    Old times are taken off and rebuilt. Days with bookings are never
                    touched.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <div className="mt-4">
            <button
              type="button"
              onClick={previewHours}
              disabled={!hoursReady || isPending}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isPending && pending === null ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              Show me what this will do
            </button>
          </div>

          {pending?.source === 'hours' ? review : null}
        </div>

        {/* ---- Closing dates ---- */}
        <div className="border-t border-slate-100 pt-6">
          <h3 className="text-sm font-semibold text-slate-900">Close some dates</h3>
          <p className="mt-0.5 text-sm text-slate-600">
            A storm, a holiday, three weeks in the shop. This takes the times off the
            calendar for these dates only — the rest of the season is untouched, and it
            closes this activity alone, not everything you run.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="First date to close" htmlFor={ids.closeStart}>
              <TextInput
                id={ids.closeStart}
                type="date"
                value={closeRange.startDate}
                onChange={(e) =>
                  editCloseRange({
                    startDate: e.target.value,
                    // Keep the common single-day case one field: dragging the first date
                    // past the last one carries the last one along instead of erroring.
                    endDate:
                      closeRange.endDate < e.target.value ? e.target.value : closeRange.endDate,
                  })
                }
              />
            </Field>
            <Field label="Last date to close" htmlFor={ids.closeEnd}>
              <TextInput
                id={ids.closeEnd}
                type="date"
                value={closeRange.endDate}
                invalid={Boolean(closeRangeError)}
                aria-invalid={closeRangeError ? true : undefined}
                aria-describedby={describedBy(ids.closeEnd, undefined, closeRangeError)}
                onChange={(e) => editCloseRange({ endDate: e.target.value })}
              />
              <HelpText id={ids.closeEnd} error={closeRangeError} />
            </Field>
          </div>

          <div className="mt-4">
            <button
              type="button"
              onClick={previewClose}
              disabled={Boolean(closeRangeError) || isPending}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CalendarX2 className="h-4 w-4" aria-hidden />
              Show me what closing these will do
            </button>
          </div>

          {pending?.source === 'close' ? review : null}

          <ClosedList
            closedDays={snapshot.closedDays}
            onReopen={previewReopen}
            disabled={isPending}
          />
          {pending?.source === 'reopen' ? review : null}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// What is on the calendar right now
// ---------------------------------------------------------------------------

function CurrentPicture({ snapshot }: { snapshot: ScheduleSnapshot }) {
  if (snapshot.dayCount === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-700">
        <p className="font-medium text-slate-900">Nothing is bookable yet.</p>
        <p className="mt-1">
          Set the hours below and pick the dates you want them to run, and guests will be
          able to book.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
      <h3 className="text-sm font-semibold text-slate-900">What is on the calendar now</h3>
      <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-600">
            Bookable dates
          </dt>
          <dd className="mt-0.5 text-sm text-slate-900">
            {snapshot.firstDate && snapshot.lastDate
              ? `${longLabel(snapshot.firstDate)} through ${longLabel(snapshot.lastDate)}`
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-600">
            Days you are open
          </dt>
          <dd className="mt-0.5 text-sm text-slate-900">{weekdayPhrase(snapshot.weekdays)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-600">
            Start times in use
          </dt>
          <dd className="mt-0.5 text-sm text-slate-900">
            {snapshot.startMinutes.length > 0
              ? snapshot.startMinutes.map(timeLabel).join(', ')
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-600">
            Days with bookings
          </dt>
          <dd className="mt-0.5 text-sm text-slate-900">
            {plural(snapshot.bookedDayCount, 'day')} of {plural(snapshot.dayCount, 'day')}
            {snapshot.bookedDayCount > 0 ? ' — those are never changed by an edit here' : ''}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-slate-600">
        {plural(snapshot.timeCount, 'start time')} in total, from today onwards. Times shown in{' '}
        {snapshot.timezone.replace(/_/g, ' ')}.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The days that are currently closed, with a way back
// ---------------------------------------------------------------------------

function ClosedList({
  closedDays,
  onReopen,
  disabled,
}: {
  closedDays: ClosedDay[];
  onReopen: (date: string) => void;
  disabled: boolean;
}) {
  if (closedDays.length === 0) {
    return (
      <p className="mt-5 text-sm text-slate-600">No dates are closed at the moment.</p>
    );
  }
  return (
    <div className="mt-5">
      <h4 className="text-sm font-semibold text-slate-900">Closed at the moment</h4>
      <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
        {closedDays.map((day) => (
          <li key={day.date} className="flex items-center justify-between gap-4 px-3 py-2">
            <span className="text-sm text-slate-800">
              {longLabel(day.date)}
              <span className="ml-2 text-xs text-slate-600">
                {plural(day.timeCount, 'start time')} off
              </span>
            </span>
            <button
              type="button"
              onClick={() => onReopen(day.date)}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Open back up
              <span className="sr-only"> — {longLabel(day.date)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The preview: what this will do, before it does it
// ---------------------------------------------------------------------------

/** Days listed one by one before the list collapses to a count. */
const DAY_LIST_LIMIT = 14;

function PlanReview({
  pending,
  headingRef,
  acknowledged,
  onAcknowledge,
  onConfirm,
  onCancel,
  isPending,
  ackId,
  helpId,
}: {
  pending: Pending;
  headingRef: MutableRefObject<HTMLHeadingElement | null>;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
  ackId: string;
  helpId: string;
}) {
  const { plan } = pending;
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? plan.days : plan.days.slice(0, DAY_LIST_LIMIT);
  const hidden = plan.days.length - shown.length;
  const blocked = plan.needsDecision && !acknowledged;

  return (
    <div className="mt-4 rounded-xl border-2 border-slate-300 bg-white p-4 shadow-sm">
      <h4
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-semibold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      >
        Before it happens: {plan.headline}
      </h4>

      {plan.lines.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          {plan.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {plan.blockedDays.length > 0 ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">
            {plural(plan.blockedDays.length, 'day')} already {hasHave(plan.blockedDays.length)}{' '}
            bookings and will not be changed
          </p>
          <p className="mt-1 text-sm text-amber-900">
            {plan.blockedDays
              .map((d) => `${d.label} (${plural(d.bookings, 'booking')})`)
              .join(', ')}
          </p>
          <p className="mt-1 text-sm text-amber-900">
            Those days stay exactly as they are. To change them, move or refund the
            bookings first.
          </p>
        </div>
      ) : null}

      {plan.days.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[28rem] border-collapse text-left text-sm">
            <caption className="sr-only">
              What happens to each day in the dates you picked
            </caption>
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  Day
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  What happens
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                  Times now
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                  Times after
                </th>
                <th scope="col" className="py-1.5 text-right font-medium">
                  Bookings
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((day) => (
                <tr key={day.date} className="border-b border-slate-100 last:border-0">
                  <th scope="row" className="py-1.5 pr-3 font-medium text-slate-900">
                    {day.label}
                  </th>
                  <td
                    className={cn(
                      'py-1.5 pr-3',
                      day.action === 'BLOCKED' ? 'font-medium text-amber-900' : 'text-slate-700',
                    )}
                  >
                    {DAY_ACTION_LABEL[day.action]}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-700">
                    {day.timesNow}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-700">
                    {day.timesAfter}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-slate-700">{day.bookings}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-2 rounded-lg px-1 text-sm font-medium text-slate-700 underline hover:text-slate-900"
            >
              Show the other {plural(hidden, 'day')}
            </button>
          ) : null}
        </div>
      ) : null}

      {plan.needsDecision ? (
        <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <input
            id={ackId}
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-amber-400 text-slate-900 focus:ring-slate-400"
            checked={acknowledged}
            onChange={(e) => onAcknowledge(e.target.checked)}
          />
          <span className="text-sm font-medium text-amber-900">
            Yes — skip the {plural(plan.blockedDays.length, 'day')} with bookings and change
            the rest.
          </span>
        </label>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={blocked || isPending || plan.noChange}
          aria-describedby={blocked || plan.noChange ? helpId : undefined}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Check className="h-4 w-4" aria-hidden />
          )}
          Yes, make these changes
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <X className="h-4 w-4" aria-hidden />
          Never mind
        </button>
        {blocked || plan.noChange ? (
          <span id={helpId} className="text-sm text-slate-700">
            {/*
              When every day in range is booked, "nothing to change" and "blocked by
              bookings" are both true. The bookings are the reason, so they explain it.
            */}
            {plan.noChange && plan.blockedDays.length > 0
              ? 'Every day here has bookings on it. Move those first, or pick other dates.'
              : plan.noChange
                ? 'There is nothing here to change.'
                : 'Tick the box above first, or change the dates.'}
          </span>
        ) : null}
      </div>
    </div>
  );
}
