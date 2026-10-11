import { AlertTriangle, CheckCircle2, MinusCircle, XCircle, type LucideIcon } from 'lucide-react';
import { ClientDeepLink } from './ClientDeepLink';
import {
  STATUS_META,
  byStatusSeverity,
  isOpen,
  type ReadinessCheckView,
  type ReadinessStatus,
} from './readiness-contract';

const ICON: Record<ReadinessStatus, LucideIcon> = {
  OK: CheckCircle2,
  WARN: AlertTriangle,
  BLOCKED: XCircle,
  NOT_APPLICABLE: MinusCircle,
};

/**
 * What is left before this client can go live, split by whose move it is.
 *
 * The split is the whole point. "Waiting on us" is a to-do list; "waiting on the
 * client" is a phone call. One merged list hides the difference, and a client stalls
 * for three weeks because everyone assumed the other side had it.
 *
 * Cleared and not-needed checks are folded into a <details> at the bottom — still
 * there when the owner wants to prove something is done, out of the way when he is
 * working the list. <details> is keyboard operable natively; no JS involved.
 */
export function ReadinessBoard({
  operatorId,
  clientName,
  checks,
  engineAvailable = true,
}: {
  operatorId: string;
  clientName: string;
  checks: ReadinessCheckView[];
  /** False when the check engine could not be read — say so, never render a fake all-clear. */
  engineAvailable?: boolean;
}) {
  const open = checks.filter((c) => isOpen(c.status));
  const ours = open.filter((c) => c.court === 'US').sort(byStatusSeverity);
  const theirs = open.filter((c) => c.court === 'THE_CLIENT').sort(byStatusSeverity);
  const done = checks.filter((c) => c.status === 'OK').sort(byStatusSeverity);
  const na = checks.filter((c) => c.status === 'NOT_APPLICABLE').sort(byStatusSeverity);

  if (!engineAvailable) {
    return (
      <p
        role="alert"
        className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700"
      >
        The readiness checks could not be run just now, so this list is not a statement
        that anything is finished. Everything else on this page is live.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-body">
        {open.length === 0 ? (
          <>Nothing outstanding. Every check has cleared.</>
        ) : (
          <>
            <strong className="font-semibold text-ink">{ours.length}</strong> waiting on us ·{' '}
            <strong className="font-semibold text-ink">{theirs.length}</strong> waiting on
            them · {done.length} done
          </>
        )}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Pile
          title="Waiting on us"
          hint="Ours to finish before we can hand it over."
          emptyText="Nothing on our plate."
          checks={ours}
          operatorId={operatorId}
          clientName={clientName}
        />
        <Pile
          title="Waiting on the client"
          hint="Chase these on the next call."
          emptyText="We are not waiting on them for anything."
          checks={theirs}
          operatorId={operatorId}
          clientName={clientName}
        />
      </div>

      {(done.length > 0 || na.length > 0) && (
        <details className="rounded-lg border border-line bg-surface shadow-sm">
          <summary className="min-h-11 cursor-pointer rounded-lg px-4 py-3 text-sm font-medium text-ink-body focus:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            Cleared and not needed ({done.length + na.length})
          </summary>
          <ul className="space-y-2 border-t border-line p-4">
            {[...done, ...na].map((check) => (
              <CheckRow
                key={check.id}
                check={check}
                operatorId={operatorId}
                clientName={clientName}
              />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Pile({
  title,
  hint,
  emptyText,
  checks,
  operatorId,
  clientName,
}: {
  title: string;
  hint: string;
  emptyText: string;
  checks: ReadinessCheckView[];
  operatorId: string;
  clientName: string;
}) {
  const headingId = `pile-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-line bg-surface p-4 shadow-sm">
      <h3 id={headingId} className="text-sm font-semibold text-ink">
        {title}{' '}
        <span className="ml-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink-body">
          {checks.length}
        </span>
      </h3>
      <p className="mt-1 text-xs text-ink-muted">{hint}</p>
      {checks.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-sm text-ink-muted">
          {emptyText}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {checks.map((check) => (
            <CheckRow
              key={check.id}
              check={check}
              operatorId={operatorId}
              clientName={clientName}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CheckRow({
  check,
  operatorId,
  clientName,
}: {
  check: ReadinessCheckView;
  operatorId: string;
  clientName: string;
}) {
  const meta = STATUS_META[check.status];
  const Icon = ICON[check.status];

  return (
    <li className="rounded-lg border border-line bg-surface-muted p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-ink">{check.label}</p>
            {/* Icon + word together: the status never depends on colour alone. */}
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.pill}`}
            >
              <Icon className={`h-3.5 w-3.5 ${meta.icon}`} aria-hidden />
              {meta.word}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-body">{check.detail}</p>
        </div>
        {check.href && (
          <ClientDeepLink
            operatorId={operatorId}
            href={check.href}
            label={`${check.label} in ${clientName}'s account`}
          >
            Open
          </ClientDeepLink>
        )}
      </div>
    </li>
  );
}
