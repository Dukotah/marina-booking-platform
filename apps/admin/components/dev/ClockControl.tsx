'use client';

/**
 * Sandbox clock (docs/LOCAL-FIRST-BUILD.md §4.2).
 *
 * The product never asks the operating system what time it is — it asks the clock
 * provider, which adds this operator's stored offset. So moving the offset forward
 * moves the whole product forward: a reminder scheduled for 24 hours before
 * departure becomes due the moment you jump past it, and a no-show sweep can be
 * exercised without leaving a laptop running overnight.
 *
 * The offset is cumulative and per-operator. Real time keeps running underneath,
 * which is why the effective clock is rendered live rather than as a snapshot.
 */
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Clock, FastForward, Loader2, RotateCcw, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { advanceClockAction, resetClockAction, type ActionResult } from '../../app/dev/actions';

export interface UpcomingSlotView {
  id: string;
  activityName: string;
  /** Slot start, ISO UTC. Rendered against the EFFECTIVE clock, not the real one. */
  startsAt: string;
  booked: number;
  capacity: number;
}

export interface ClockControlProps {
  /** Seconds ahead of real time. Negative means the sandbox is in the past. */
  offsetSeconds: number;
  /** The next few departures, so the offset means something concrete on screen. */
  upcoming: UpcomingSlotView[];
}

const JUMPS: Array<{ label: string; seconds: number; hint: string }> = [
  { label: '+1 hour', seconds: 3600, hint: 'past the 1-hour "leaving soon" nudge' },
  { label: '+6 hours', seconds: 6 * 3600, hint: 'into the same day’s later departures' },
  { label: '+24 hours', seconds: 24 * 3600, hint: 'fires tomorrow’s pre-arrival reminders' },
  { label: '+3 days', seconds: 3 * 24 * 3600, hint: 'past the cancellation window' },
  { label: '+7 days', seconds: 7 * 24 * 3600, hint: 'a full week of sweeps at once' },
];

export function ClockControl({ offsetSeconds, upcoming }: ClockControlProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<{ ok: boolean; message: string } | null>(null);
  const [customHours, setCustomHours] = useState('');
  const [now, setNow] = useState<Date | null>(null);

  // Rendered client-side only: the server's "now" is stale by the time it paints,
  // and rendering it during hydration would mismatch. null on the first frame.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  function run(action: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await action();
      setBanner({ ok: result.ok, message: result.message });
      if (result.ok) {
        setCustomHours('');
        router.refresh();
      }
    });
  }

  const effective = now ? new Date(now.getTime() + offsetSeconds * 1000) : null;
  const shifted = offsetSeconds !== 0;
  const customSeconds = Math.round(parseFloat(customHours.replace(/[^0-9.-]/g, '') || '0') * 3600);
  const customValid = Number.isFinite(customSeconds) && customSeconds !== 0;

  return (
    <div className="space-y-5">
      {banner ? (
        <div
          role="status"
          className={cn(
            'flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-sm',
            banner.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800',
          )}
        >
          <span>{banner.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setBanner(null)}
            className="shrink-0 opacity-60 hover:opacity-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}

      <div
        className={cn(
          'rounded-xl border p-5',
          shifted ? 'border-sky-300 bg-sky-50/70' : 'border-slate-200 bg-white',
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <Clock className="h-3.5 w-3.5" aria-hidden />
              Effective time
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900">
              {effective ? effective.toLocaleString() : '—'}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {shifted ? (
                <>
                  <span className="font-medium">{formatOffset(offsetSeconds)}</span> — real time is{' '}
                  {now ? now.toLocaleString() : '—'}
                </>
              ) : (
                'Running on real time.'
              )}
            </p>
          </div>
          {shifted ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => resetClockAction())}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="h-4 w-4" aria-hidden />
              )}
              Back to real time
            </button>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <p className="text-sm font-semibold text-slate-900">Jump forward</p>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          This is how you make a pre-arrival reminder fire without waiting for the day to arrive.
          Everything time-dependent — reminders, no-show sweeps, cancellation windows, membership
          expiry — reads the clock through this offset, so jumping past a scheduled moment makes it
          due immediately. Jumps stack: three taps of +24 hours is three days.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {JUMPS.map((j) => (
            <button
              key={j.seconds}
              type="button"
              disabled={pending}
              title={j.hint}
              onClick={() => run(() => advanceClockAction({ seconds: j.seconds }))}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FastForward className="h-4 w-4 text-sky-600" aria-hidden />
              {j.label}
            </button>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
          <div>
            <label htmlFor="dev-clock-hours" className="block text-xs font-medium text-slate-600">
              Or move by hours (negative goes back)
            </label>
            <input
              id="dev-clock-hours"
              inputMode="decimal"
              value={customHours}
              onChange={(e) => setCustomHours(e.target.value)}
              placeholder="e.g. 36 or -12"
              className="mt-1 w-44 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
          </div>
          <button
            type="button"
            disabled={pending || !customValid}
            onClick={() => run(() => advanceClockAction({ seconds: customSeconds }))}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Move the clock
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold text-slate-900">What is coming up</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Departures with seats sold, measured against the effective clock — jump past one and its
            reminders come due.
          </p>
        </div>
        {upcoming.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">
            No booked departures ahead of the effective clock. Take a booking, or move the clock
            back.
          </p>
        ) : (
          <ul className="divide-y divide-slate-50">
            {upcoming.map((slot) => (
              <li key={slot.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
                  {slot.activityName}
                </span>
                <span className="whitespace-nowrap text-slate-600">
                  {new Date(slot.startsAt).toLocaleString()}
                </span>
                <span className="whitespace-nowrap text-xs text-slate-500">
                  {slot.booked}/{slot.capacity} booked
                </span>
                <span className="w-28 whitespace-nowrap text-right text-xs font-medium text-sky-700">
                  {effective ? countdown(slot.startsAt, effective) : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatOffset(seconds: number): string {
  const abs = Math.abs(seconds);
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const parts = [days ? `${days}d` : '', hours ? `${hours}h` : '', minutes ? `${minutes}m` : ''];
  const magnitude = parts.filter(Boolean).join(' ') || `${abs}s`;
  return `${magnitude} ${seconds > 0 ? 'ahead of' : 'behind'} real time`;
}

/** "in 4h 20m" / "20m ago", measured from the effective clock. */
function countdown(iso: string, from: Date): string {
  const deltaMs = new Date(iso).getTime() - from.getTime();
  const abs = Math.abs(deltaMs);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const magnitude =
    days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return deltaMs >= 0 ? `in ${magnitude}` : `${magnitude} ago`;
}
