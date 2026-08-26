import { formatUSD } from '../../lib/format';
import { fieldLabel, isMoneyField } from './taxonomy';

export interface AuditDiffProps {
  /** Prior values of the changed fields; null when the entity was created. */
  before: Record<string, unknown> | null;
  /** New values of the changed fields; null when the entity was deleted. */
  after: Record<string, unknown> | null;
}

/**
 * Field-by-field before/after view of one audit entry.
 *
 * The API stores only the fields that changed, so this renders everything it is
 * given — there is no "unchanged" noise to filter. `_context` is lifted out and
 * shown separately because it explains the change rather than being part of it.
 *
 * Render-only, so it works inside the server page and inside the client
 * timeline without a 'use client' boundary of its own.
 */
export function AuditDiff({ before, after }: AuditDiffProps) {
  const context = extractContext(after);
  const afterFields = omitContext(after);

  const fields = [
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(afterFields ?? {})]),
  ].sort();

  const truncated = Boolean(
    (before as { _truncated?: boolean } | null)?._truncated ??
      (afterFields as { _truncated?: boolean } | null)?._truncated,
  );

  if (fields.length === 0 && !context) {
    return (
      <p className="text-sm text-slate-500">
        No field changes were recorded for this event.
      </p>
    );
  }

  if (truncated) {
    const changed = (
      ((before ?? afterFields) as { _changed?: string[] } | null)?._changed ?? []
    ).map(fieldLabel);
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-medium">The change was too large to store in full.</p>
        <p className="mt-1">
          Fields changed: {changed.length > 0 ? changed.join(', ') : 'unknown'}.
        </p>
      </div>
    );
  }

  const mode: 'created' | 'deleted' | 'updated' =
    before === null ? 'created' : afterFields === null ? 'deleted' : 'updated';

  return (
    <div className="space-y-3">
      {fields.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left">
                <th
                  scope="col"
                  className="w-1/4 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  Field
                </th>
                {mode !== 'created' ? (
                  <th
                    scope="col"
                    className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500"
                  >
                    Before
                  </th>
                ) : null}
                {mode !== 'deleted' ? (
                  <th
                    scope="col"
                    className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500"
                  >
                    {mode === 'created' ? 'Value' : 'After'}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {fields.map((field) => (
                <tr key={field} className="align-top">
                  <th
                    scope="row"
                    className="px-3 py-2 text-left font-medium text-slate-600"
                  >
                    {fieldLabel(field)}
                  </th>
                  {mode !== 'created' ? (
                    <td className="px-3 py-2 text-slate-500">
                      <Value field={field} value={before?.[field]} muted />
                    </td>
                  ) : null}
                  {mode !== 'deleted' ? (
                    <td className="px-3 py-2 text-slate-900">
                      <Value field={field} value={afterFields?.[field]} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {context ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Context
          </p>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
            {Object.entries(context).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="font-medium text-slate-600">{fieldLabel(key)}</dt>
                <dd className="min-w-0 text-slate-800">
                  <Value field={key} value={value} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

/** Render one JSON leaf, formatting integer-cents fields as currency. */
function Value({
  field,
  value,
  muted = false,
}: {
  field: string;
  value: unknown;
  muted?: boolean;
}) {
  if (value === undefined || value === null) {
    return <span className="italic text-slate-400">empty</span>;
  }

  if (typeof value === 'boolean') {
    return <span className="font-mono text-xs">{value ? 'true' : 'false'}</span>;
  }

  if (typeof value === 'number' && isMoneyField(field)) {
    return <span className="tabular-nums">{formatUSD(value)}</span>;
  }

  if (typeof value === 'number') {
    return <span className="tabular-nums">{value.toLocaleString('en-US')}</span>;
  }

  if (typeof value === 'string') {
    if (value === '[redacted]') {
      return (
        <span className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-xs text-slate-600">
          redacted
        </span>
      );
    }
    return <span className="break-words">{value}</span>;
  }

  // Objects and arrays: the raw JSON is the honest representation. Kept
  // scrollable so a nested config never blows out the row width.
  return (
    <pre
      className={`max-h-48 overflow-auto rounded bg-slate-900/95 p-2 font-mono text-xs leading-relaxed ${
        muted ? 'text-slate-400' : 'text-slate-100'
      }`}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function extractContext(after: Record<string, unknown> | null): Record<string, unknown> | null {
  const ctx = after?._context;
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return null;
  const entries = Object.entries(ctx as Record<string, unknown>);
  return entries.length > 0 ? (ctx as Record<string, unknown>) : null;
}

function omitContext(after: Record<string, unknown> | null): Record<string, unknown> | null {
  if (after === null) return null;
  if (!('_context' in after)) return after;
  return Object.fromEntries(Object.entries(after).filter(([key]) => key !== '_context'));
}
