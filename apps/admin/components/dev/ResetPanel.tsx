'use client';

/**
 * Reset (docs/LOCAL-FIRST-BUILD.md §4.2) — wipe back to a known seed.
 *
 * Deliberately hostile to a stray click. Nothing is destroyed until the owner has
 * (1) picked a scope, (2) read the exact live row counts that scope will delete,
 * and (3) typed that scope's confirmation phrase character for character. The
 * server re-checks the phrase, because a confirmation only the browser enforces is
 * not a confirmation at all.
 *
 * Three scopes rather than one button, because "reset" means different things
 * depending on what you are testing, and the widest one is rarely what you want.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { resetSandboxAction, type ActionResult } from '../../app/dev/actions';

export type ResetScope = 'sandbox' | 'bookings' | 'season';

/** Live row counts, so the warning quotes real numbers instead of "some data". */
export interface ResetCounts {
  messages: number;
  attempts: number;
  webhooks: number;
  errors: number;
  orders: number;
  customers: number;
  timeslotsWithBookings: number;
  clockShifted: boolean;
}

export interface ResetPanelProps {
  counts: ResetCounts;
  /**
   * False when the current operator is not the one the season seed knows how to
   * build — the option is withheld rather than seeding the wrong marina.
   */
  canReseed: boolean;
  /** Shown when reseeding is unavailable, so the reason is never a mystery. */
  seedOperatorId: string;
}

interface ScopeSpec {
  key: ResetScope;
  title: string;
  summary: string;
  phrase: string;
  tone: 'slate' | 'amber' | 'red';
  destroys: (c: ResetCounts) => string[];
  survives: string[];
}

const SCOPES: ScopeSpec[] = [
  {
    key: 'sandbox',
    title: 'Clear the console',
    summary: 'Throws away the sandbox’s own record. No guest ever saw any of it.',
    phrase: 'CLEAR SANDBOX',
    tone: 'slate',
    destroys: (c) => [
      `${c.messages} sandbox message${plural(c.messages)} (the inbox)`,
      `${c.attempts} payment attempt${plural(c.attempts)}, queued and consumed`,
      `${c.webhooks} webhook${plural(c.webhooks)} and their replays`,
      `${c.errors} captured error${plural(c.errors)}`,
      c.clockShifted ? 'the clock offset (back to real time)' : 'the clock offset (already zero)',
    ],
    survives: ['Every order, guest and payment', 'The whole catalog and every setting'],
  },
  {
    key: 'bookings',
    title: 'Delete bookings and guests',
    summary:
      'Empties the marina. The catalog survives, so you can immediately book into it again from a clean slate.',
    phrase: 'DELETE BOOKINGS',
    tone: 'amber',
    destroys: (c) => [
      `${c.orders} order${plural(c.orders)} — with their items, payments and timeline events`,
      `${c.customers} guest record${plural(c.customers)} and their history`,
      `booked seats released on ${c.timeslotsWithBookings} timeslot${plural(c.timeslotsWithBookings)}`,
      `${c.messages} message${plural(c.messages)}, ${c.attempts} payment attempt${plural(c.attempts)}, ${c.webhooks} webhook${plural(c.webhooks)}, ${c.errors} error${plural(c.errors)}`,
    ],
    survives: [
      'Activities, rates, timeslots, resources and locations',
      'Staff, roles, branding, fees, waivers and every setting',
    ],
  },
  {
    key: 'season',
    title: 'Reset to the seeded season',
    summary:
      'Everything above, then rebuilds the demo season so the dashboards, reports and manifest have a believable business behind them again.',
    phrase: 'RESET TO SEED',
    tone: 'red',
    destroys: (c) => [
      `${c.orders} order${plural(c.orders)} and ${c.customers} guest record${plural(c.customers)}`,
      'every sandbox message, payment attempt, webhook and error',
      'the seeded SONOMA10 promo code — the reseed recreates it',
      'any booking you just made by hand — the rebuilt season replaces it',
    ],
    survives: [
      'Activities, rates, timeslots, resources and locations',
      'Staff, roles, branding, fees, waivers and every setting',
    ],
  },
];

const TONE_PANEL: Record<ScopeSpec['tone'], string> = {
  slate: 'border-slate-300 bg-slate-50',
  amber: 'border-amber-300 bg-amber-50',
  red: 'border-red-300 bg-red-50',
};

const TONE_BUTTON: Record<ScopeSpec['tone'], string> = {
  slate: 'bg-slate-900 hover:bg-slate-800',
  amber: 'bg-amber-600 hover:bg-amber-700',
  red: 'bg-red-600 hover:bg-red-700',
};

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

export function ResetPanel({ counts, canReseed, seedOperatorId }: ResetPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<{ ok: boolean; message: string } | null>(null);
  const [open, setOpen] = useState<ResetScope | null>(null);
  const [typed, setTyped] = useState('');

  function run(action: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await action();
      setBanner({ ok: result.ok, message: result.message });
      if (result.ok) {
        setOpen(null);
        setTyped('');
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
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

      <p className="max-w-3xl text-sm text-slate-500">
        Every reset is scoped to this operator and runs in one transaction — if any part of it
        fails, nothing is deleted. None of it can be undone, and there is no backup on this laptop
        unless you made one.
      </p>

      {SCOPES.map((spec) => {
        const disabled = spec.key === 'season' && !canReseed;
        const isOpen = open === spec.key;
        const confirmed = typed.trim() === spec.phrase;

        return (
          <div
            key={spec.key}
            className={cn(
              'rounded-xl border bg-white',
              isOpen ? TONE_PANEL[spec.tone] : 'border-slate-200',
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-3 p-5">
              <div className="min-w-0 max-w-2xl">
                <p className="text-sm font-semibold text-slate-900">{spec.title}</p>
                <p className="mt-1 text-sm text-slate-600">{spec.summary}</p>
                {disabled ? (
                  <p className="mt-2 text-xs text-slate-500">
                    Unavailable: the season seed only knows how to build{' '}
                    <code className="rounded bg-slate-100 px-1">{seedOperatorId}</code>. Use “Delete
                    bookings and guests” for this operator instead.
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                disabled={disabled || pending}
                onClick={() => {
                  setOpen(isOpen ? null : spec.key);
                  setTyped('');
                }}
                className={cn(
                  'shrink-0 rounded-lg border px-3 py-2 text-sm font-medium shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50',
                  spec.tone === 'red'
                    ? 'border-red-200 text-red-700 hover:bg-red-50'
                    : spec.tone === 'amber'
                      ? 'border-amber-200 text-amber-800 hover:bg-amber-50'
                      : 'border-slate-200 text-slate-700 hover:bg-slate-50',
                )}
              >
                {isOpen ? 'Cancel' : spec.title}
              </button>
            </div>

            {isOpen ? (
              <div className="border-t border-white/60 px-5 pb-5 pt-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <AlertTriangle className="h-4 w-4 text-red-600" aria-hidden />
                  This permanently deletes
                </p>
                <ul className="mt-2 space-y-1 text-sm text-slate-700">
                  {spec.destroys(counts).map((line) => (
                    <li key={line} className="flex gap-2">
                      <span aria-hidden className="text-red-500">
                        &minus;
                      </span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>

                <p className="mt-4 text-sm font-semibold text-slate-900">This is left alone</p>
                <ul className="mt-2 space-y-1 text-sm text-slate-700">
                  {spec.survives.map((line) => (
                    <li key={line} className="flex gap-2">
                      <span aria-hidden className="text-emerald-600">
                        ✓
                      </span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>

                <label
                  htmlFor={`reset-confirm-${spec.key}`}
                  className="mt-5 block text-xs font-medium text-slate-700"
                >
                  Type <span className="font-mono font-semibold">{spec.phrase}</span> to confirm
                </label>
                <input
                  id={`reset-confirm-${spec.key}`}
                  value={typed}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={spec.phrase}
                  className="mt-1 w-64 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-800 placeholder:text-slate-300 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
                />

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!confirmed || pending}
                    onClick={() =>
                      run(() => resetSandboxAction({ scope: spec.key, confirmation: typed.trim() }))
                    }
                    className={cn(
                      'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-50',
                      TONE_BUTTON[spec.tone],
                    )}
                  >
                    {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                    {spec.key === 'season' ? 'Wipe and reseed' : 'Delete permanently'}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setOpen(null);
                      setTyped('');
                    }}
                    className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-white/70"
                  >
                    Keep everything
                  </button>
                </div>

                {spec.key === 'season' ? (
                  <p className="mt-3 text-xs text-slate-600">
                    Reseeding runs the season seed as a background process and can take up to a
                    minute. If it fails, the wipe still happened — the catalog is intact and the
                    marina is simply empty.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
