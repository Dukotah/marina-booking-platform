'use client';

import type { UseFormReturn } from 'react-hook-form';
import { generateTimeslots } from '@marina/core';
import { formatUSD, toCents } from '../../lib/format';
import { CATEGORY_LABELS, type ActivityFormValues } from './types';

/**
 * Step 4 — Preview. A read-only summary mirroring what guests will see, so the
 * operator can confirm before saving. Prices render via the shared cents-based
 * formatter (dollars in the form -> cents -> formatted USD).
 */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-right text-sm font-medium text-slate-800">{value}</dd>
    </div>
  );
}

export function StepPreview({ form }: { form: UseFormReturn<ActivityFormValues> }) {
  const v = form.getValues();

  const slotsPerDay = generateTimeslots({
    openHour: Number(v.schedule.open_hour) || 0,
    closeHour: Number(v.schedule.close_hour) || 0,
    intervalMinutes: Number(v.schedule.interval_minutes) || 0,
    capacityTotal: Number(v.schedule.capacity_total) || 0,
    date: new Date(),
  }).length;

  const activeRates = v.rates.filter((r) => r.is_active);
  const visibility = [
    v.visible_online && 'Online',
    v.visible_kiosk && 'Kiosk',
    v.visible_register && 'Register',
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">
        Review everything below, then save. You can edit any step before saving.
      </p>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-3 border-b border-slate-100 p-4">
          <span
            className="inline-block h-8 w-8 shrink-0 rounded-lg"
            style={{ backgroundColor: v.color }}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-slate-900">
              {v.name_external || 'Untitled activity'}
            </div>
            <div className="truncate text-xs text-slate-500">
              {CATEGORY_LABELS[v.category]} ·{' '}
              <span className={v.status === 'ACTIVE' ? 'text-emerald-600' : 'text-slate-400'}>
                {v.status === 'ACTIVE' ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>
        </div>

        <dl className="divide-y divide-slate-100 px-4">
          <Row label="Internal name" value={v.name_internal || '—'} />
          <Row label="Participants" value={`${v.min_participants}–${v.max_participants}`} />
          <Row label="Visible on" value={visibility.length ? visibility.join(', ') : 'Hidden'} />
          <Row label="Waiver required" value={v.waiver_required ? 'Yes' : 'No'} />
          <Row label="Self-reschedule window" value={`${v.self_reschedule_hours} hours`} />
          <Row
            label="Schedule"
            value={`${slotsPerDay} slots/day · ${v.schedule.capacity_total} per slot`}
          />
        </dl>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">
          Rates ({activeRates.length} active of {v.rates.length})
        </h3>
        {v.rates.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            No rates added. Guests will not be able to book until at least one active rate exists.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {v.rates.map((r, i) => (
              <li key={r.id ?? `new-${i}`} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-800">
                    {r.name_external || r.name_internal || `Rate ${i + 1}`}
                    {!r.is_active ? (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                        Inactive
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-slate-500">{r.duration_minutes} min</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-slate-900">
                    {r.is_from_price ? 'from ' : ''}
                    {formatUSD(toCents(Number(r.price_dollars) || 0))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
