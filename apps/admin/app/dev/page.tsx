import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AdminShell, PageHeader } from '../../components/shell';
import { getTenantDb, getOperatorContext } from '../../lib/session';
import { MessageInbox } from '../../components/dev/MessageInbox';
import { DevTabs, type DevTab } from '../../components/dev/DevTabs';
import {
  PaymentControls,
  type PaymentAttemptView,
  type QueuedOutcomeView,
} from '../../components/dev/PaymentControls';
import { WebhookPanel, type SandboxWebhookView } from '../../components/dev/WebhookPanel';
import { ClockControl, type UpcomingSlotView } from '../../components/dev/ClockControl';
import { ResetPanel } from '../../components/dev/ResetPanel';
import { isSandboxEnabled } from './actions';

export const metadata: Metadata = {
  title: 'Local Console',
};

export const dynamic = 'force-dynamic';

/**
 * The Local Console — the owner's testing surface when the product runs with no
 * external accounts (docs/LOCAL-FIRST-BUILD.md §4.2).
 *
 * Six tabs, one per thing you would otherwise need a terminal, a Stripe dashboard
 * or an overnight wait to do:
 *
 *   Inbox     every email and SMS the system "sent", fully rendered.
 *   Payments  force the next charge to approve / challenge / decline / time out /
 *             dispute, and read the state machine afterwards.
 *   Webhooks  what fired, the exact payload, and a replay button.
 *   Clock     move the sandbox clock so scheduled work comes due now.
 *   Errors    what threw, with the stack and the request context.
 *   Reset     wipe back to a known seed, with the row counts spelled out first.
 *
 * HARD GATE: this route must not exist when the app runs against real providers.
 * The gate lives in ./actions.ts so the page and every mutation share one
 * definition — a server action is its own endpoint and would not be protected by
 * this `notFound()` alone.
 *
 * All reads go through the tenant-scoped client (D-007), so everything on screen
 * is this operator's and nothing else's.
 */
export default async function DevConsolePage() {
  if (!(await isSandboxEnabled())) notFound();

  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  // The clock offset gates one of the queries below, so it is read first.
  const clock = await db.sandboxClock.findFirst({
    where: { operator_id: operatorId },
    select: { offset_seconds: true },
  });
  const offsetSeconds = clock?.offset_seconds ?? 0;
  const effectiveNow = new Date(Date.now() + offsetSeconds * 1000);

  const [
    messages,
    queuedAttempts,
    pastAttempts,
    webhookRows,
    replayGroups,
    errors,
    upcomingSlots,
    counts,
  ] = await Promise.all([
    db.sandboxMessage.findMany({ orderBy: { created_at: 'desc' }, take: 100 }),
    // Oldest first: the provider pops the head of the queue, so this order is the
    // order the outcomes will actually be applied in.
    db.sandboxPaymentAttempt.findMany({
      where: { status: 'QUEUED' },
      orderBy: { created_at: 'asc' },
    }),
    db.sandboxPaymentAttempt.findMany({
      where: { status: { not: 'QUEUED' } },
      orderBy: { created_at: 'desc' },
      take: 50,
    }),
    db.sandboxWebhook.findMany({ orderBy: { created_at: 'desc' }, take: 100 }),
    db.sandboxWebhook.groupBy({
      by: ['replay_of_id'],
      where: { replay_of_id: { not: null } },
      _count: { _all: true },
    }),
    db.sandboxError.findMany({ orderBy: { created_at: 'desc' }, take: 50 }),
    db.timeslot.findMany({
      where: {
        datetime: { gte: effectiveNow },
        capacity_booked: { gt: 0 },
        status: { not: 'CANCELLED' },
      },
      orderBy: { datetime: 'asc' },
      take: 8,
      include: { activity: { select: { name_internal: true, name_external: true } } },
    }),
    loadResetCounts(db),
  ]);

  const replaysByOriginal = new Map<string, number>();
  for (const group of replayGroups) {
    if (group.replay_of_id) replaysByOriginal.set(group.replay_of_id, group._count._all);
  }

  // SandboxPaymentAttempt.order_id is a soft link with no foreign key (a deposit is
  // charged inside the transaction that creates its order, so the FK could not hold),
  // which means no Prisma `include` — resolve the order numbers in one extra query.
  const attemptOrderIds = [
    ...new Set(pastAttempts.map((a) => a.order_id).filter((id): id is string => Boolean(id))),
  ];
  const orderNumberById = new Map<string, string>(
    attemptOrderIds.length === 0
      ? []
      : (
          await db.order.findMany({
            where: { id: { in: attemptOrderIds } },
            select: { id: true, order_number: true },
          })
        ).map((o) => [o.id, o.order_number]),
  );

  const emails = messages.filter((m) => m.channel === 'EMAIL').length;
  const texts = messages.filter((m) => m.channel === 'SMS').length;

  const queued: QueuedOutcomeView[] = queuedAttempts.map((a) => {
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    return {
      id: a.id,
      outcome: a.outcome,
      failureCode: a.failure_code,
      disputeReason: typeof meta.disputeReason === 'string' ? meta.disputeReason : null,
      note: typeof meta.note === 'string' ? meta.note : null,
      createdAt: a.created_at.toISOString(),
    };
  });

  const attempts: PaymentAttemptView[] = pastAttempts.map((a) => ({
    id: a.id,
    intentId: a.intent_id,
    amountCents: a.amount_cents,
    outcome: a.outcome,
    status: a.status,
    failureCode: a.failure_code,
    orderNumber: a.order_id ? (orderNumberById.get(a.order_id) ?? null) : null,
    idempotencyKey: a.idempotency_key,
    consumedAt: a.consumed_at?.toISOString() ?? null,
    createdAt: a.created_at.toISOString(),
  }));

  const webhooks: SandboxWebhookView[] = webhookRows.map((w) => ({
    id: w.id,
    eventType: w.event_type,
    status: w.status,
    // Serialised here rather than in the client so the browser never re-parses a
    // payload, and so a huge event is bounded before it crosses the wire.
    payloadJson: prettyJson(w.payload),
    deliveredAt: w.delivered_at?.toISOString() ?? null,
    error: w.error,
    replayOfId: w.replay_of_id,
    replayCount: replaysByOriginal.get(w.id) ?? 0,
    createdAt: w.created_at.toISOString(),
  }));

  const upcoming: UpcomingSlotView[] = upcomingSlots.map((s) => ({
    id: s.id,
    activityName: s.activity.name_internal || s.activity.name_external,
    startsAt: s.datetime.toISOString(),
    booked: s.capacity_booked,
    capacity: s.capacity_total,
  }));

  const tabs: DevTab[] = [
    {
      key: 'inbox',
      label: 'Inbox',
      count: messages.length,
      content: (
        <MessageInbox
          messages={messages.map((m) => ({
            id: m.id,
            channel: m.channel,
            kind: m.kind,
            to: m.to_address,
            from: m.from_address,
            subject: m.subject,
            html: m.body_html,
            text: m.body_text,
            orderNumber: m.order_number,
            createdAt: m.created_at.toISOString(),
          }))}
          emailCount={emails}
          smsCount={texts}
        />
      ),
    },
    {
      key: 'payments',
      label: 'Payments',
      count: queued.length,
      highlight: queued.length > 0,
      content: <PaymentControls queued={queued} attempts={attempts} />,
    },
    {
      key: 'webhooks',
      label: 'Webhooks',
      count: webhooks.length,
      content: <WebhookPanel webhooks={webhooks} canDeliver={apiReachableFromEnv()} />,
    },
    {
      key: 'clock',
      label: 'Clock',
      highlight: offsetSeconds !== 0,
      content: <ClockControl offsetSeconds={offsetSeconds} upcoming={upcoming} />,
    },
    {
      key: 'errors',
      label: 'Errors',
      count: errors.length,
      highlight: errors.length > 0,
      content: <ErrorList errors={errors} />,
    },
    {
      key: 'reset',
      label: 'Reset',
      content: (
        <ResetPanel
          counts={{ ...counts, clockShifted: offsetSeconds !== 0 }}
          canReseed={operatorId === SEASON_SEED_OPERATOR}
          seedOperatorId={SEASON_SEED_OPERATOR}
        />
      ),
    },
  ];

  return (
    <AdminShell>
      <PageHeader
        title="Local Console"
        description="Everything the product does with an outside account, done here instead. Read what was sent, force a card to decline, replay a webhook, move the clock so tomorrow's reminders fire now, and wipe back to a known seed."
      />
      <DevTabs tabs={tabs} />
    </AdminShell>
  );
}

/** Mirrors the constant in ./actions.ts — the operator the season seed builds. */
const SEASON_SEED_OPERATOR = 'lsra';

/** True when there is an API to POST a webhook replay at. */
function apiReachableFromEnv(): boolean {
  return Boolean(process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL);
}

/** Indented JSON, bounded so one enormous event cannot bloat the page payload. */
function prettyJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2) ?? 'null';
    return text.length > 40_000 ? `${text.slice(0, 40_000)}\n… truncated` : text;
  } catch {
    return '(payload could not be rendered)';
  }
}

/**
 * Live row counts for the reset warnings. Counting is cheap next to being vague
 * about what a destructive button is about to delete.
 */
async function loadResetCounts(db: Awaited<ReturnType<typeof getTenantDb>>) {
  const [messages, attempts, webhooks, errors, orders, customers, timeslotsWithBookings] =
    await Promise.all([
      db.sandboxMessage.count(),
      db.sandboxPaymentAttempt.count(),
      db.sandboxWebhook.count(),
      db.sandboxError.count(),
      db.order.count(),
      db.customer.count(),
      db.timeslot.count({ where: { capacity_booked: { gt: 0 } } }),
    ]);
  return { messages, attempts, webhooks, errors, orders, customers, timeslotsWithBookings };
}

interface SandboxErrorRow {
  id: string;
  source: string;
  name: string;
  message: string;
  stack: string | null;
  fingerprint: string;
  context: unknown;
  created_at: Date;
}

/**
 * The local twin of a Sentry issue list. Rendered on the server with native
 * `<details>` elements rather than a client component: a stack trace only needs to
 * expand, and that is one tag rather than a hydration boundary.
 *
 * Occurrences of the same bug are grouped on `fingerprint` — the newest one is the
 * headline and the rest collapse into the count, which is what makes "this fires
 * on every checkout" visible at a glance.
 */
function ErrorList({ errors }: { errors: SandboxErrorRow[] }) {
  if (errors.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
        <p className="text-sm font-medium text-slate-900">Nothing has thrown</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
          Anything that throws in the API, the customer site or this admin app lands here with its
          stack and the request that caused it — no Sentry account involved.
        </p>
      </div>
    );
  }

  const groups = new Map<string, { latest: SandboxErrorRow; count: number }>();
  for (const err of errors) {
    const existing = groups.get(err.fingerprint);
    if (existing) existing.count += 1;
    else groups.set(err.fingerprint, { latest: err, count: 1 });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        {errors.length} occurrence{errors.length === 1 ? '' : 's'} across {groups.size} distinct
        error{groups.size === 1 ? '' : 's'}, newest first.
      </p>
      {Array.from(groups.values()).map(({ latest, count }) => (
        <details
          key={latest.fingerprint}
          className="group rounded-xl border border-slate-200 bg-white open:border-slate-300"
        >
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-5 py-4">
            <span className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-red-700">
              {latest.name}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-600">
              {latest.source}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-slate-900">{latest.message}</span>
            {count > 1 ? (
              <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                ×{count}
              </span>
            ) : null}
            <span className="shrink-0 text-[11px] text-slate-400">
              {latest.created_at.toLocaleString()}
            </span>
          </summary>
          <div className="space-y-3 border-t border-slate-100 px-5 py-4">
            {latest.context ? (
              <div>
                <p className="text-xs font-medium text-slate-600">Context</p>
                <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700">
                  {prettyJson(latest.context)}
                </pre>
              </div>
            ) : null}
            <div>
              <p className="text-xs font-medium text-slate-600">Stack</p>
              <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-100">
                {latest.stack ?? '(no stack captured)'}
              </pre>
            </div>
            <p className="font-mono text-[11px] text-slate-400">
              fingerprint {latest.fingerprint}
            </p>
          </div>
        </details>
      ))}
    </div>
  );
}
