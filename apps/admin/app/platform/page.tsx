import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  MessageSquareWarning,
  Minus,
  Plus,
  Pencil,
} from 'lucide-react';
import { formatUSD } from '../../lib/format';
import {
  DEFAULT_SORT_DIRECTION,
  listOperators,
  parseSortDirection,
  parseSortKey,
  sortClients,
  type ClientSortKey,
  type OperatorListRow,
  type SortDirection,
} from '../../lib/platform';
import {
  SCHEDULE_WARN_DAYS,
  STAGE_LABEL,
  courtLabel,
  type CheckStatus,
  type ReadinessCheck,
} from '../../lib/readiness';
import { OpenClientButton } from './_components/PlatformActions';
import { openClientAction } from './actions';
import { Badge, buttonClasses } from '../../components/ui';

export const metadata: Metadata = { title: 'Platform · Clients' };
export const dynamic = 'force-dynamic';

/** Every column in the table, so the expanded detail row can span the lot. */
const COLUMN_COUNT = 10;

// ---------------------------------------------------------------------------
// Deep links into a client account
// ---------------------------------------------------------------------------

/**
 * Only ever redirect somewhere inside this app. The path comes back through the
 * form body, so it is untrusted input by definition — a protocol-relative "//evil"
 * is a valid `redirect()` target and would send a platform admin off-site with the
 * impersonation cookie freshly set.
 */
function safeInternalPath(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

/**
 * Open a client and land on the exact screen that fixes a failing check.
 *
 * This is the whole point of the readiness list: the owner should never read
 * "no prices on Sunset Cruise", then go hunting for the client, then hunt for the
 * activity. One button, and he is standing on the rates step. `openClientAction`
 * re-asserts platform admin, so the gate is not weakened by the shortcut.
 */
async function openClientAtAction(formData: FormData): Promise<void> {
  'use server';
  const operatorId = String(formData.get('operatorId') ?? '');
  const path = safeInternalPath(String(formData.get('path') ?? '/'));
  await openClientAction(operatorId);
  redirect(path);
}

// ---------------------------------------------------------------------------
// Readiness presentation
// ---------------------------------------------------------------------------

const STATUS_WORD: Record<CheckStatus, string> = {
  OK: 'Done',
  WARN: 'Watch',
  BLOCKED: 'Blocked',
  NOT_APPLICABLE: 'N/A',
};

/** Map a check status onto a shared Badge tone (meaning, not decoration). */
const STATUS_TONE: Record<CheckStatus, 'success' | 'waiting' | 'owed' | 'cancelled'> = {
  OK: 'success',
  WARN: 'waiting',
  BLOCKED: 'owed',
  NOT_APPLICABLE: 'cancelled',
};

function StatusIcon({ status }: { status: CheckStatus }) {
  const className = 'h-4 w-4 shrink-0';
  if (status === 'OK') return <CheckCircle2 className={`${className} text-emerald-600`} aria-hidden />;
  if (status === 'WARN') return <AlertTriangle className={`${className} text-amber-600`} aria-hidden />;
  if (status === 'BLOCKED') return <CircleDashed className={`${className} text-rose-600`} aria-hidden />;
  return <Minus className={`${className} text-ink-muted`} aria-hidden />;
}

/** Green only when there is genuinely nothing outstanding. */
function readinessTone(row: OperatorListRow): string {
  if (row.readiness.blockedCount > 0) return 'text-rose-700';
  if (row.readiness.warnCount > 0) return 'text-amber-700';
  return 'text-emerald-700';
}

function barTone(row: OperatorListRow): string {
  if (row.readiness.blockedCount > 0) return 'bg-rose-500';
  if (row.readiness.warnCount > 0) return 'bg-amber-500';
  return 'bg-emerald-500';
}

/** The "go fix it" button. A form, because opening a client is a state change. */
function FixButton({
  row,
  check,
  variant,
}: {
  row: OperatorListRow;
  check: ReadinessCheck;
  variant: 'link' | 'button';
}) {
  return (
    <form action={openClientAtAction} className="inline">
      <input type="hidden" name="operatorId" value={row.id} />
      <input type="hidden" name="path" value={check.fixHref} />
      <button
        type="submit"
        // The label spells out which check on which client, so a screen-reader user
        // is not left with twelve identically named buttons. It always OPENS with
        // the visible text — WCAG 2.5.3 means a voice-control user saying what they
        // can see has to match.
        aria-label={
          variant === 'link'
            ? `Fix ${check.label.toLowerCase()} for ${row.name}`
            : `Open ${check.label.toLowerCase()} for ${row.name}`
        }
        className={
          variant === 'link'
            ? 'rounded font-medium text-accent underline underline-offset-2 transition hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus'
            : buttonClasses('secondary', 'sm')
        }
      >
        {variant === 'link' ? 'Fix' : `Open ${check.label.toLowerCase()}`}
      </button>
    </form>
  );
}

/** One line of the expanded checklist. */
function CheckRow({ row, check }: { row: OperatorListRow; check: ReadinessCheck }) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-t border-line py-2.5 first:border-t-0">
      <StatusIcon status={check.status} />
      <span className="w-28 shrink-0 text-sm font-medium text-ink">{check.label}</span>
      <span className="min-w-[16rem] flex-1 text-sm text-ink-body">{check.detail}</span>
      <span className="flex shrink-0 items-center gap-2">
        <Badge tone={STATUS_TONE[check.status]}>{STATUS_WORD[check.status]}</Badge>
        {check.status === 'NOT_APPLICABLE' ? null : (
          <span className="text-xs text-ink-muted">
            Ball with {courtLabel(check.court).toLowerCase()}
          </span>
        )}
        {check.status === 'OK' || check.status === 'NOT_APPLICABLE' ? null : (
          <FixButton row={row} check={check} variant="button" />
        )}
      </span>
    </li>
  );
}

/** The collapsed one-liner that describes what is inside the checklist. */
function readinessSummaryText(row: OperatorListRow): string {
  const { blockedCount, warnCount, okCount, applicableCount } = row.readiness;
  if (blockedCount > 0 && warnCount > 0) {
    return `${blockedCount} blocking, ${warnCount} to watch`;
  }
  if (blockedCount > 0) return `${blockedCount} blocking`;
  if (warnCount > 0) return `${warnCount} to watch`;
  return `All clear — ${okCount} of ${applicableCount} checks pass`;
}

/**
 * The schedule callout's opening sentence. "Out of times" and "nearly out of
 * times" are two different phone calls, so the banner never blurs them into one.
 */
function scheduleLede(trouble: OperatorListRow[], dark: OperatorListRow[]): string {
  const soon = trouble.filter((c) => !dark.includes(c));
  const parts: string[] = [];
  if (dark.length === 1) {
    parts.push(`${dark[0].name} has activities with no bookable times left at all.`);
  } else if (dark.length > 1) {
    parts.push(`${dark.length} clients have activities with no bookable times left at all.`);
  }
  if (soon.length === 1) {
    const days = soon[0].readiness.scheduleHorizonDays;
    parts.push(`${soon[0].name} runs out in ${days} ${days === 1 ? 'day' : 'days'}.`);
  } else if (soon.length > 1) {
    parts.push(`${soon.length} more run out within two weeks.`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Sortable headers
// ---------------------------------------------------------------------------

function sortHref(key: ClientSortKey, current: ClientSortKey, direction: SortDirection): string {
  const next: SortDirection =
    current === key ? (direction === 'asc' ? 'desc' : 'asc') : DEFAULT_SORT_DIRECTION[key];
  return `/platform?sort=${key}&dir=${next}`;
}

function SortHeader({
  label,
  sortKey,
  current,
  direction,
  align = 'left',
  hint,
}: {
  label: string;
  sortKey: ClientSortKey;
  current: ClientSortKey;
  direction: SortDirection;
  align?: 'left' | 'right';
  hint?: string;
}) {
  const active = current === sortKey;
  return (
    <th
      scope="col"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`px-4 py-3 font-medium ${align === 'right' ? 'text-right' : ''}`}
    >
      <Link
        href={sortHref(sortKey, current, direction)}
        title={hint}
        className={`inline-flex items-center gap-1 rounded transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
          active ? 'text-ink' : ''
        }`}
      >
        {label}
        {active ? (
          direction === 'asc' ? (
            <ArrowUp className="h-3 w-3" aria-hidden />
          ) : (
            <ArrowDown className="h-3 w-3" aria-hidden />
          )
        ) : null}
      </Link>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function PlatformHome({
  searchParams,
}: {
  searchParams?: { sort?: string; dir?: string };
}) {
  const unsorted = await listOperators();
  const sortKey = parseSortKey(searchParams?.sort);
  const sortDir = parseSortDirection(searchParams?.dir, sortKey);
  const clients = sortClients(unsorted, sortKey, sortDir);

  const totalRevenue = clients.reduce((s, c) => s + c.revenueCents, 0);
  const blockedClients = clients.filter((c) => c.readiness.blockedCount > 0);
  const watchClients = clients.filter(
    (c) => c.readiness.blockedCount === 0 && c.readiness.warnCount > 0,
  );
  // The quiet failure worth its own callout: nothing errors when a schedule runs
  // out, the activity simply stops being bookable. Split "already dark" from
  // "about to go dark" — they are different phone calls.
  const scheduleTrouble = clients.filter(
    (c) => c.readiness.scheduleHorizonDays !== null && c.readiness.scheduleHorizonDays <= SCHEDULE_WARN_DAYS,
  );
  const alreadyDark = scheduleTrouble.filter((c) => c.readiness.scheduleHorizonDays === 0);
  const webBase = process.env.NEXT_PUBLIC_WEB_BASE_URL ?? 'http://localhost:3000';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Clients</h1>
          <p className="mt-1 text-sm text-ink-body">
            {clients.length} {clients.length === 1 ? 'client' : 'clients'} · {formatUSD(totalRevenue)} booked
            across the platform
            {blockedClients.length > 0 || watchClients.length > 0 ? (
              <>
                {' · '}
                <span className={blockedClients.length > 0 ? 'text-rose-700' : 'text-amber-700'}>
                  {blockedClients.length > 0
                    ? `${blockedClients.length} blocked`
                    : `${watchClients.length} to watch`}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <Link href="/platform/new" className={buttonClasses('primary', 'md')}>
          <Plus className="h-4 w-4" aria-hidden /> New client
        </Link>
      </div>

      {scheduleTrouble.length > 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <span>
            {scheduleLede(scheduleTrouble, alreadyDark)} A schedule that ends takes the activity off sale
            without any error — nobody finds out until the phone stops ringing.
          </span>
        </p>
      ) : null}

      {clients.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong bg-surface p-12 text-center text-ink-muted">
          No clients yet. Create your first one to get started.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface shadow-sm">
          <table className="w-full min-w-[64rem] text-sm">
            <caption className="sr-only">
              Clients, most in need of attention first. Column headings sort the list.
            </caption>
            <thead className="bg-surface-muted text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <SortHeader label="Client" sortKey="name" current={sortKey} direction={sortDir} />
                <SortHeader
                  label="Stage"
                  sortKey="stage"
                  current={sortKey}
                  direction={sortDir}
                  hint="Onboarding stage"
                />
                <SortHeader
                  label="Ready"
                  sortKey="ready"
                  current={sortKey}
                  direction={sortDir}
                  hint="Share of applicable setup checks passing"
                />
                <SortHeader
                  label="Blocked on"
                  sortKey="attention"
                  current={sortKey}
                  direction={sortDir}
                  hint="Sort the most stuck clients to the top"
                />
                <th scope="col" className="px-4 py-3 font-medium">
                  Plan
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
                </th>
                <SortHeader
                  label="Activities"
                  sortKey="activities"
                  current={sortKey}
                  direction={sortDir}
                  align="right"
                />
                <SortHeader
                  label="Orders"
                  sortKey="orders"
                  current={sortKey}
                  direction={sortDir}
                  align="right"
                />
                <SortHeader
                  label="Revenue"
                  sortKey="revenue"
                  current={sortKey}
                  direction={sortDir}
                  align="right"
                />
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            {clients.map((c) => {
              const top = c.readiness.topBlocker;
              return (
                <tbody key={c.id} className="border-t border-line">
                  <tr className="hover:bg-surface-muted">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span
                          className="inline-block h-3 w-3 shrink-0 rounded-full"
                          style={{ backgroundColor: c.brandColor }}
                          aria-hidden
                        />
                        <div>
                          <div className="font-medium text-ink">{c.name}</div>
                          <div className="text-xs text-ink-muted">{c.slug}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-ink-body">{STAGE_LABEL[c.stage]}</span>
                      {c.stageIsDerived ? (
                        // Say so rather than pretend: nobody has filed this client's
                        // onboarding record, so the stage is read off their data.
                        <span
                          className="block text-xs text-ink-muted"
                          title="No onboarding record yet — read from the client's own data"
                        >
                          assumed
                        </span>
                      ) : c.onboardingOwner ? (
                        <span className="block text-xs text-ink-muted">{c.onboardingOwner}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className={`font-semibold tabular-nums ${readinessTone(c)}`}>
                        {c.readiness.percent}%
                      </div>
                      <span className="mt-1 block h-1 w-16 overflow-hidden rounded-full bg-surface-muted" aria-hidden>
                        <span
                          className={`block h-full rounded-full ${barTone(c)}`}
                          style={{ width: `${c.readiness.percent}%` }}
                        />
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {top ? (
                        <div className="flex items-start gap-2">
                          <StatusIcon status={top.status} />
                          <div className="min-w-0">
                            <div className="font-medium text-ink">{top.label}</div>
                            <div className="text-xs text-ink-muted">
                              {courtLabel(top.court)} · <FixButton row={c} check={top} variant="link" />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <span className="text-ink-muted">Nothing — ready to sell</span>
                      )}
                      {c.blockerNote ? (
                        <div className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700">
                          <MessageSquareWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span className="line-clamp-2">{c.blockerNote.body}</span>
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 capitalize text-ink-body">{c.plan}</td>
                    <td className="px-4 py-3">
                      <Badge tone={c.isActive ? 'success' : 'owed'}>
                        {c.isActive ? 'Active' : 'Suspended'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink-body">{c.activities}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink-body">{c.orders}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink">
                      {formatUSD(c.revenueCents)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <a
                          href={`${webBase}/?operator=${encodeURIComponent(c.slug)}`}
                          target="_blank"
                          rel="noreferrer"
                          title="View customer site"
                          aria-label={`View ${c.name} customer site`}
                          className={buttonClasses('secondary', 'sm', 'px-2.5')}
                        >
                          <ExternalLink className="h-4 w-4" aria-hidden />
                        </a>
                        <Link
                          href={`/platform/${c.id}`}
                          title="Edit client"
                          aria-label={`Edit ${c.name}`}
                          className={buttonClasses('secondary', 'sm', 'px-2.5')}
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </Link>
                        <OpenClientButton operatorId={c.id} />
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={COLUMN_COUNT} className="px-4 pb-3">
                      {/* Native <details>: keyboard operable and announced without a
                          line of client JavaScript, which keeps this page a pure
                          server render. */}
                      <details className="group">
                        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded text-xs [&::-webkit-details-marker]:hidden text-ink-muted transition hover:text-ink-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                          <span aria-hidden className="transition group-open:rotate-90">
                            ▸
                          </span>
                          {readinessSummaryText(c)} · setup detail for {c.name}
                        </summary>
                        <div className="mt-2 rounded-lg border border-line bg-surface-muted px-4 py-1">
                          {c.blockerNote ? (
                            <p className="border-b border-line py-2.5 text-sm text-amber-700">
                              <span className="font-medium">Blocker noted by {c.blockerNote.author}:</span>{' '}
                              {c.blockerNote.body}
                            </p>
                          ) : null}
                          <ul>
                            {c.readiness.checks.map((check) => (
                              <CheckRow key={check.id} row={c} check={check} />
                            ))}
                          </ul>
                        </div>
                      </details>
                    </td>
                  </tr>
                </tbody>
              );
            })}
          </table>
        </div>
      )}
    </div>
  );
}
