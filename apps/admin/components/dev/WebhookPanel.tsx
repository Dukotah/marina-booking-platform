'use client';

/**
 * Webhook inspector + replay (docs/LOCAL-FIRST-BUILD.md §4.2).
 *
 * Same two-pane shape as the inbox, because it is the same question: what did the
 * system send, and what exactly was in it. Left is the delivery log; right is the
 * raw payload, in the Stripe event shape the production handler parses.
 *
 * Replay POSTs the stored payload back at the real `/webhooks/stripe` route and
 * records a NEW row linked to the original — so "failed, then the replay worked"
 * stays on the record instead of being overwritten. That is what makes a webhook
 * bug reproducible without asking a processor to re-send anything.
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCw, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { replayWebhookAction, type ActionResult } from '../../app/dev/actions';

export type WebhookStatus = 'PENDING' | 'DELIVERED' | 'FAILED';

export interface SandboxWebhookView {
  id: string;
  eventType: string;
  status: WebhookStatus;
  /** Pretty-printed server-side so the client never parses untrusted JSON. */
  payloadJson: string;
  deliveredAt: string | null;
  error: string | null;
  /** Set when this row is itself a replay of an earlier delivery. */
  replayOfId: string | null;
  /** How many replays exist for this original. */
  replayCount: number;
  createdAt: string;
}

export interface WebhookPanelProps {
  webhooks: SandboxWebhookView[];
  /** False when API_BASE_URL is unset — replay would fail, so say so up front. */
  canDeliver: boolean;
}

type Filter = 'ALL' | 'DELIVERED' | 'FAILED';

const STATUS_BADGE: Record<WebhookStatus, string> = {
  PENDING: 'bg-slate-100 text-slate-600',
  DELIVERED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
};

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function WebhookPanel({ webhooks, canDeliver }: WebhookPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<{ ok: boolean; message: string } | null>(null);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(webhooks[0]?.id ?? null);

  const visible = useMemo(
    () => (filter === 'ALL' ? webhooks : webhooks.filter((w) => w.status === filter)),
    [webhooks, filter],
  );
  const selected = visible.find((w) => w.id === selectedId) ?? visible[0] ?? null;

  function run(action: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await action();
      setBanner({ ok: result.ok, message: result.message });
      router.refresh();
    });
  }

  if (webhooks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
        <p className="text-sm font-medium text-slate-900">No webhooks yet</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
          The payment simulator emits Stripe-shaped events — <code>payment_intent.succeeded</code>,{' '}
          <code>charge.refunded</code>, <code>charge.dispute.created</code> — as charges move. Take
          a booking or issue a refund and they land here, payload and all.
        </p>
      </div>
    );
  }

  const counts = {
    ALL: webhooks.length,
    DELIVERED: webhooks.filter((w) => w.status === 'DELIVERED').length,
    FAILED: webhooks.filter((w) => w.status === 'FAILED').length,
  };

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

      {!canDeliver ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span className="font-medium">API_BASE_URL is not set.</span> Replays will be recorded as
          failed deliveries because there is nowhere to POST them — start the API and set the
          variable to re-deliver for real.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {(['ALL', 'DELIVERED', 'FAILED'] as Filter[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cn(
              'rounded-full px-3 py-1.5 text-sm font-medium transition',
              filter === key
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50',
            )}
          >
            {key === 'ALL' ? 'All' : key === 'DELIVERED' ? 'Delivered' : 'Failed'}
            <span className="ml-1.5 opacity-60">{counts[key]}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <ul className="max-h-[34rem] divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white">
          {visible.map((w) => {
            const active = selected?.id === w.id;
            return (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(w.id)}
                  className={cn(
                    'w-full px-4 py-3 text-left transition',
                    active ? 'bg-accent-tint' : 'hover:bg-slate-50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                        STATUS_BADGE[w.status],
                      )}
                    >
                      {w.status}
                    </span>
                    {w.replayOfId ? (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                        Replay
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-[11px] text-slate-400">
                      {relativeTime(w.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-sm text-slate-900">{w.eventType}</p>
                  {w.error ? (
                    <p className="truncate text-xs text-red-600">{w.error}</p>
                  ) : w.replayCount > 0 ? (
                    <p className="text-xs text-slate-500">
                      replayed {w.replayCount} time{w.replayCount === 1 ? '' : 's'}
                    </p>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="rounded-xl border border-slate-200 bg-white">
          {selected ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
                <div className="min-w-0">
                  <p className="font-mono text-sm font-semibold text-slate-900">
                    {selected.eventType}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Fired {new Date(selected.createdAt).toLocaleString()}
                    {selected.deliveredAt
                      ? ` · delivered ${new Date(selected.deliveredAt).toLocaleTimeString()}`
                      : ''}
                  </p>
                  {selected.error ? (
                    <p className="mt-1 text-xs text-red-600">{selected.error}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => replayWebhookAction({ webhookId: selected.id }))}
                  className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <RotateCw className="h-4 w-4" aria-hidden />
                  )}
                  Replay
                </button>
              </div>
              <pre className="max-h-[26rem] overflow-auto rounded-b-xl bg-slate-950 p-5 font-mono text-xs leading-relaxed text-slate-100">
                {selected.payloadJson}
              </pre>
            </>
          ) : (
            <p className="p-10 text-center text-sm text-slate-500">Select an event.</p>
          )}
        </div>
      </div>
    </div>
  );
}
