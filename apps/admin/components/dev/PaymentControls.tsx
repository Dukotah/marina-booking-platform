'use client';

/**
 * Payment controls for the Local Console (docs/LOCAL-FIRST-BUILD.md §4.2).
 *
 * Two halves. The top half scripts what the NEXT charge does — that ordering is
 * the whole point: you queue "decline" here, then walk the real booking funnel and
 * watch the real decline path run. The bottom half is the history: every attempt,
 * what was asked for versus what actually happened, and the failure code.
 *
 * `outcome` and `status` are shown as separate columns on purpose. They diverge on
 * a 3DS challenge (asked for REQUIRES_ACTION, ends SUCCEEDED or FAILED) and on a
 * dispute (the charge succeeded first, the chargeback landed later) — collapsing
 * them into one "state" would hide exactly the cases worth testing.
 */
import { useId, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import { formatUSD } from '../../lib/format';
import { cn } from '../../lib/cn';
import {
  queuePaymentOutcomeAction,
  cancelQueuedOutcomeAction,
  clearQueuedOutcomesAction,
  type ActionResult,
} from '../../app/dev/actions';

export type SandboxOutcome =
  | 'SUCCEEDED'
  | 'REQUIRES_ACTION'
  | 'DECLINED'
  | 'TIMEOUT'
  | 'DISPUTED';

export type SandboxAttemptStatus =
  | 'QUEUED'
  | 'REQUIRES_ACTION'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DISPUTED'
  | 'CANCELLED';

export interface QueuedOutcomeView {
  id: string;
  outcome: SandboxOutcome;
  failureCode: string | null;
  disputeReason: string | null;
  note: string | null;
  createdAt: string;
}

export interface PaymentAttemptView {
  id: string;
  intentId: string | null;
  amountCents: number | null;
  outcome: SandboxOutcome;
  status: SandboxAttemptStatus;
  failureCode: string | null;
  orderNumber: string | null;
  idempotencyKey: string | null;
  consumedAt: string | null;
  createdAt: string;
}

export interface PaymentControlsProps {
  /** Oldest first — the provider pops the head of this queue. */
  queued: QueuedOutcomeView[];
  /** Consumed/cancelled attempts, newest first. */
  attempts: PaymentAttemptView[];
}

interface OutcomeOption {
  key: SandboxOutcome;
  label: string;
  /** What the processor does. */
  blurb: string;
  /** What the product should do about it — the thing under test. */
  tests: string;
  icon: typeof CheckCircle2;
  tone: string;
}

const OUTCOME_OPTIONS: OutcomeOption[] = [
  {
    key: 'SUCCEEDED',
    label: 'Approve',
    blurb: 'The charge clears on the first try.',
    tests: 'Confirmation email + SMS, capacity held, balance zeroed.',
    icon: CheckCircle2,
    tone: 'emerald',
  },
  {
    key: 'REQUIRES_ACTION',
    label: '3DS challenge',
    blurb: 'The bank demands a second factor before it will authorise.',
    tests: 'The order must sit in REQUIRES_ACTION — not be treated as a decline.',
    icon: ShieldAlert,
    tone: 'indigo',
  },
  {
    key: 'DECLINED',
    label: 'Decline',
    blurb: 'A hard decline with a machine-readable reason.',
    tests: 'A clean retry, and no half-created order left behind.',
    icon: Ban,
    tone: 'red',
  },
  {
    key: 'TIMEOUT',
    label: 'Time out',
    blurb: 'The connection dies before the processor answers.',
    tests: 'The nastiest case: we do not know if the card was charged.',
    icon: Timer,
    tone: 'amber',
  },
  {
    key: 'DISPUTED',
    label: 'Dispute',
    blurb: 'The charge succeeds, then a chargeback lands against it.',
    tests: 'Money comes back out days later; the ledger still has to balance.',
    icon: AlertTriangle,
    tone: 'fuchsia',
  },
];

const DECLINE_CODES = [
  { value: 'card_declined', label: 'card_declined — generic decline' },
  { value: 'insufficient_funds', label: 'insufficient_funds' },
  { value: 'expired_card', label: 'expired_card' },
  { value: 'incorrect_cvc', label: 'incorrect_cvc' },
  { value: 'lost_card', label: 'lost_card' },
  { value: 'stolen_card', label: 'stolen_card' },
  { value: 'processing_error', label: 'processing_error — processor fault' },
];

const DISPUTE_REASONS = [
  { value: 'fraudulent', label: 'fraudulent — cardholder says it was not them' },
  { value: 'product_not_received', label: 'product_not_received' },
  { value: 'duplicate', label: 'duplicate' },
  { value: 'subscription_canceled', label: 'subscription_canceled' },
  { value: 'general', label: 'general' },
];

const TONE_ACTIVE: Record<string, string> = {
  emerald: 'border-emerald-400 bg-emerald-50 ring-1 ring-emerald-200',
  indigo: 'border-accent bg-accent-tint ring-1 ring-accent',
  red: 'border-red-400 bg-red-50 ring-1 ring-red-200',
  amber: 'border-amber-400 bg-amber-50 ring-1 ring-amber-200',
  fuchsia: 'border-fuchsia-400 bg-fuchsia-50 ring-1 ring-fuchsia-200',
};

const TONE_ICON: Record<string, string> = {
  emerald: 'text-emerald-600',
  indigo: 'text-accent',
  red: 'text-red-600',
  amber: 'text-amber-600',
  fuchsia: 'text-fuchsia-600',
};

const STATUS_BADGE: Record<SandboxAttemptStatus, string> = {
  QUEUED: 'bg-slate-100 text-slate-700',
  REQUIRES_ACTION: 'bg-amber-100 text-amber-700',
  SUCCEEDED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
  DISPUTED: 'bg-fuchsia-100 text-fuchsia-700',
  CANCELLED: 'bg-slate-100 text-slate-500',
};

type Banner = { ok: boolean; message: string } | null;

export function PaymentControls({ queued, attempts }: PaymentControlsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<Banner>(null);
  const [selected, setSelected] = useState<SandboxOutcome>('DECLINED');
  const [declineCode, setDeclineCode] = useState(DECLINE_CODES[0]!.value);
  const [disputeReason, setDisputeReason] = useState(DISPUTE_REASONS[0]!.value);
  const [note, setNote] = useState('');

  function run(action: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await action();
      setBanner({ ok: result.ok, message: result.message });
      if (result.ok) {
        setNote('');
        router.refresh();
      }
    });
  }

  const next = queued[0] ?? null;

  return (
    <div className="space-y-5">
      {banner ? <Banner banner={banner} onDismiss={() => setBanner(null)} /> : null}

      {/* What the next charge will do */}
      <div
        className={cn(
          'rounded-xl border p-5',
          next ? 'border-amber-300 bg-amber-50/70' : 'border-slate-200 bg-white',
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Next charge
            </p>
            <p className="mt-1 text-lg font-semibold text-slate-900">
              {next ? describeQueued(next) : 'Approves normally'}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {next
                ? 'The simulator will consume this instruction the next time a card is charged — from the booking funnel, the POS, or a balance collection.'
                : 'Nothing is queued. Pick an outcome below, then go take a booking and watch it happen.'}
            </p>
          </div>
          {queued.length > 0 ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => clearQueuedOutcomesAction())}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden />
              )}
              Clear queue
            </button>
          ) : null}
        </div>

        {queued.length > 1 ? (
          <ol className="mt-4 space-y-1.5 border-t border-amber-200 pt-3">
            {queued.slice(1).map((q, i) => (
              <li key={q.id} className="flex items-center gap-2 text-sm text-slate-700">
                <span className="w-10 shrink-0 text-xs text-slate-500">then {i + 2}</span>
                <span className="truncate">{describeQueued(q)}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => cancelQueuedOutcomeAction({ attemptId: q.id }))}
                  className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      {/* Pick the outcome */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <p className="text-sm font-semibold text-slate-900">Force the next outcome</p>
        <p className="mt-1 text-sm text-slate-500">
          These are the outcomes a real processor produces, not a happy path. Queue one before you
          check out and the production payment code takes that branch for real.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {OUTCOME_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = selected === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                aria-pressed={active}
                onClick={() => setSelected(opt.key)}
                className={cn(
                  'rounded-lg border p-3 text-left transition',
                  active
                    ? TONE_ACTIVE[opt.tone]
                    : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50',
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon className={cn('h-4 w-4', TONE_ICON[opt.tone])} aria-hidden />
                  <span className="text-sm font-semibold text-slate-900">{opt.label}</span>
                </div>
                <p className="mt-1.5 text-xs text-slate-600">{opt.blurb}</p>
                <p className="mt-1 text-xs text-slate-500">{opt.tests}</p>
              </button>
            );
          })}
        </div>

        {selected === 'DECLINED' ? (
          <Field label="Decline code" hint="Stored on the attempt, exactly as Stripe reports it.">
            {(id) => (
              <select
                id={id}
                value={declineCode}
                onChange={(e) => setDeclineCode(e.target.value)}
                className={selectClass}
              >
                {DECLINE_CODES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}

        {selected === 'DISPUTED' ? (
          <Field
            label="Dispute reason"
            hint="The charge still succeeds first — the chargeback arrives after it."
          >
            {(id) => (
              <select
                id={id}
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
                className={selectClass}
              >
                {DISPUTE_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}

        <Field label="Note (optional)" hint="Shows up beside the attempt so you remember why.">
          {(id) => (
            <input
              id={id}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder="e.g. checking the retry banner copy"
              className={cn(selectClass, 'placeholder:text-slate-400')}
            />
          )}
        </Field>

        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(() =>
              queuePaymentOutcomeAction({
                outcome: selected,
                failureCode: selected === 'DECLINED' ? declineCode : undefined,
                disputeReason: selected === 'DISPUTED' ? disputeReason : undefined,
                note,
              }),
            )
          }
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Queue this outcome
        </button>
      </div>

      {/* History */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">Attempts</p>
            <p className="mt-0.5 text-xs text-slate-500">
              What was asked for, and what the state machine actually did with it.
            </p>
          </div>
          <span className="text-xs text-slate-400">{attempts.length} shown</span>
        </div>

        {attempts.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">
            No charges yet. Queue an outcome above, then book something at{' '}
            <a
              href="http://localhost:3000"
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              localhost:3000
            </a>
            .
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Intent</th>
                  <th className="px-3 py-2 font-medium">Order</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Asked for</th>
                  <th className="px-3 py-2 font-medium">Ended as</th>
                  <th className="px-5 py-2 font-medium">Failure code</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {attempts.map((a) => (
                  <tr key={a.id} className="align-top">
                    <td className="whitespace-nowrap px-5 py-3 text-slate-600">
                      {new Date(a.consumedAt ?? a.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-3">
                      <span className="font-mono text-xs text-slate-700">
                        {a.intentId ?? '—'}
                      </span>
                      {a.idempotencyKey ? (
                        <p
                          className="mt-0.5 truncate font-mono text-[11px] text-slate-400"
                          title={`Idempotency key: ${a.idempotencyKey}`}
                        >
                          key {a.idempotencyKey}
                        </p>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-700">
                      {a.orderNumber ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-slate-800">
                      {a.amountCents === null ? '—' : formatUSD(a.amountCents)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-slate-600">
                      {prettyOutcome(a.outcome)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                          STATUS_BADGE[a.status],
                        )}
                      >
                        {a.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-slate-600">
                      {a.failureCode ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const selectClass =
  'mt-1 w-full max-w-lg rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  /** Receives the generated id so the label points at the real control. */
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="mt-4">
      <label htmlFor={id} className="block text-xs font-medium text-slate-600">
        {label}
      </label>
      {children(id)}
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function Banner({ banner, onDismiss }: { banner: { ok: boolean; message: string }; onDismiss: () => void }) {
  return (
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
        onClick={onDismiss}
        className="shrink-0 opacity-60 hover:opacity-100"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

function prettyOutcome(outcome: SandboxOutcome): string {
  return OUTCOME_OPTIONS.find((o) => o.key === outcome)?.label ?? outcome;
}

function describeQueued(q: QueuedOutcomeView): string {
  const base = (() => {
    switch (q.outcome) {
      case 'SUCCEEDED':
        return 'Approve';
      case 'REQUIRES_ACTION':
        return 'Raise a 3DS challenge';
      case 'DECLINED':
        return `Decline (${q.failureCode ?? 'card_declined'})`;
      case 'TIMEOUT':
        return 'Time out — result unknown';
      case 'DISPUTED':
        return `Succeed, then dispute (${q.disputeReason ?? 'fraudulent'})`;
    }
  })();
  return q.note ? `${base} — ${q.note}` : base;
}
