'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import { cn } from '../../lib/cn';
import { formatDateTime, formatRelative } from '../../lib/format';
import { AuditDiff } from './AuditDiff';
import { CATEGORY_META, actionLabel, categoryOf, fieldLabel } from './taxonomy';

export interface AuditEntryView {
  id: string;
  action: string;
  actor: string;
  actorRole: string;
  actorName: string | null;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface AuditTimelineProps {
  entries: AuditEntryView[];
  /** True when a filter is active — changes the empty-state wording. */
  isFiltered: boolean;
}

/**
 * The audit timeline: one row per recorded event, newest first, with the stored
 * before/after diff expandable in place.
 *
 * Client-side only for the expand/collapse — filtering and paging are done by
 * the server page through the URL, so the rows here are always exactly the rows
 * the tenant-scoped query returned. Nothing is fetched from the browser.
 */
export function AuditTimeline({ entries, isFiltered }: AuditTimelineProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
        <ShieldCheck className="mx-auto h-8 w-8 text-slate-300" aria-hidden />
        <p className="mt-3 text-sm font-medium text-slate-900">
          {isFiltered ? 'No events match these filters' : 'No audit events yet'}
        </p>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          {isFiltered
            ? 'Widen the date range or clear the filters to see more of the record.'
            : 'Refunds, payments, cancellations, waiver signatures, customer edits, and staff role changes are recorded here as they happen.'}
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {entries.map((entry) => {
        const open = openId === entry.id;
        const category = categoryOf(entry.action);
        const meta = CATEGORY_META[category];
        const changed = changedFields(entry);

        return (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => setOpenId(open ? null : entry.id)}
              aria-expanded={open}
              className={cn(
                'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                open ? 'bg-slate-50' : 'hover:bg-slate-50',
              )}
            >
              <span className="mt-0.5 shrink-0 text-slate-400" aria-hidden>
                {open ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-slate-900">
                    {actionLabel(entry.action)}
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
                      meta.badgeClass,
                    )}
                  >
                    {meta.label}
                  </span>
                  <span className="font-mono text-xs text-slate-400">
                    {entry.entityType} · {shortId(entry.entityId)}
                  </span>
                </span>

                <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-slate-500">
                  <span className="font-medium text-slate-700">
                    {entry.actorName ?? actorFallback(entry.actor)}
                  </span>
                  <span className="text-slate-400">({entry.actorRole.toLowerCase()})</span>
                  {changed.length > 0 ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="min-w-0 truncate">
                        changed {changed.slice(0, 4).map(fieldLabel).join(', ').toLowerCase()}
                        {changed.length > 4 ? ` +${changed.length - 4} more` : ''}
                      </span>
                    </>
                  ) : null}
                </span>
              </span>

              <span
                className="shrink-0 whitespace-nowrap text-xs text-slate-400"
                title={formatDateTime(entry.createdAt)}
              >
                {formatRelative(entry.createdAt)}
              </span>
            </button>

            {open ? (
              <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-4 sm:pl-11">
                <dl className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
                  <div className="flex gap-1.5">
                    <dt className="font-medium text-slate-600">When</dt>
                    <dd>{formatDateTime(entry.createdAt)}</dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt className="font-medium text-slate-600">Actor</dt>
                    <dd className="font-mono">{entry.actor}</dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt className="font-medium text-slate-600">Entity</dt>
                    <dd className="font-mono">
                      {entry.entityType}:{entry.entityId}
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt className="font-medium text-slate-600">IP</dt>
                    <dd className="font-mono">{entry.ip ?? '—'}</dd>
                  </div>
                </dl>
                <AuditDiff before={entry.before} after={entry.after} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The fields this event touched, ignoring the context bag. */
function changedFields(entry: AuditEntryView): string[] {
  const keys = new Set<string>();
  for (const key of Object.keys(entry.before ?? {})) keys.add(key);
  for (const key of Object.keys(entry.after ?? {})) {
    if (key !== '_context') keys.add(key);
  }
  keys.delete('_truncated');
  keys.delete('_bytes');
  keys.delete('_changed');
  return [...keys].sort();
}

/** cuids are long and uniform; the tail is the part a human can match on. */
function shortId(id: string): string {
  return id.length > 12 ? `…${id.slice(-8)}` : id;
}

function actorFallback(actor: string): string {
  return actor === 'system' ? 'System' : actor;
}
