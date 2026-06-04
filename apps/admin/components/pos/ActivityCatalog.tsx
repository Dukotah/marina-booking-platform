'use client';

import { useState } from 'react';
import { Clock, Users, Plus, Minus } from 'lucide-react';
import { formatUSD } from '@marina/core';
import { cn } from '../../lib/cn';
import { formatTime } from '../../lib/format';
import type { CartLine, PosActivity, PosRate, PosTimeslot } from './types';

/**
 * Walk-up booking tab. Staff pick an activity, a rate, a timeslot, and a quantity,
 * then add the booking to the cart. Slot availability is color-coded (the
 * anti-Singenuity "no availability signal" fix) and FULL slots can't be selected.
 */
export interface ActivityCatalogProps {
  activities: PosActivity[];
  onAdd: (line: Omit<CartLine, 'key'>) => void;
}

const STATUS_STYLES: Record<PosTimeslot['status'], string> = {
  AVAILABLE: 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:border-emerald-400',
  FILLING_UP: 'border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-400',
  FULL: 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed',
};

export function ActivityCatalog({ activities, onAdd }: ActivityCatalogProps) {
  const [activityId, setActivityId] = useState<string | null>(activities[0]?.id ?? null);
  const activity = activities.find((a) => a.id === activityId) ?? null;

  const [rateId, setRateId] = useState<string | null>(activity?.rates[0]?.id ?? null);
  const [timeslotId, setTimeslotId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);

  function selectActivity(a: PosActivity) {
    setActivityId(a.id);
    setRateId(a.rates[0]?.id ?? null);
    setTimeslotId(null);
    setQuantity(1);
  }

  const rate: PosRate | null = activity?.rates.find((r) => r.id === rateId) ?? null;
  const slot: PosTimeslot | null = activity?.timeslots.find((t) => t.id === timeslotId) ?? null;

  const canAdd = Boolean(activity && rate && slot && slot.status !== 'FULL' && quantity > 0);

  function add() {
    if (!activity || !rate || !slot) return;
    onAdd({
      kind: 'BOOKING',
      label: `${activity.name} — ${rate.name}`,
      sublabel: formatTime(slot.datetime),
      unitPriceCents: rate.priceCents,
      quantity,
      activityId: activity.id,
      rateId: rate.id,
      timeslotId: slot.id,
    });
    // Reset slot/qty for the next walk-up, keep the activity selected.
    setTimeslotId(null);
    setQuantity(1);
  }

  if (activities.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
        No register-visible activities with active rates. Add one under Activities to sell
        walk-ups here.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Activity picker */}
      <div className="flex flex-wrap gap-2">
        {activities.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => selectActivity(a)}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
              a.id === activityId
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300',
            )}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: a.color }}
              aria-hidden
            />
            {a.name}
          </button>
        ))}
      </div>

      {activity ? (
        <>
          {/* Rate picker */}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Rate
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {activity.rates.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRateId(r.id)}
                  className={cn(
                    'flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                    r.id === rateId
                      ? 'border-slate-900 ring-1 ring-slate-900'
                      : 'border-slate-200 hover:border-slate-300',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-800">{r.name}</span>
                    <span className="flex items-center gap-1 text-xs text-slate-500">
                      <Clock className="h-3 w-3" aria-hidden />
                      {r.durationMinutes} min
                    </span>
                  </span>
                  <span className="ml-2 shrink-0 font-semibold text-slate-900">
                    {formatUSD(r.priceCents)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Timeslot picker */}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Today’s timeslots
            </div>
            {activity.timeslots.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
                No timeslots scheduled today for this activity.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {activity.timeslots.map((t) => {
                  const remaining = Math.max(0, t.capacityTotal - t.capacityBooked);
                  const disabled = t.status === 'FULL';
                  return (
                    <button
                      key={t.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => setTimeslotId(t.id)}
                      className={cn(
                        'flex flex-col items-start rounded-lg border px-3 py-2 text-sm transition-colors',
                        STATUS_STYLES[t.status],
                        t.id === timeslotId && !disabled && 'ring-2 ring-offset-1 ring-slate-900',
                      )}
                    >
                      <span className="font-semibold">{formatTime(t.datetime)}</span>
                      <span className="flex items-center gap-1 text-xs">
                        <Users className="h-3 w-3" aria-hidden />
                        {disabled ? 'Full' : `${remaining} left`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quantity + add */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-slate-600">Quantity</span>
              <div className="flex items-center rounded-lg border border-slate-200">
                <button
                  type="button"
                  aria-label="Decrease quantity"
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  className="flex h-9 w-9 items-center justify-center text-slate-600 hover:bg-slate-100"
                >
                  <Minus className="h-4 w-4" aria-hidden />
                </button>
                <span className="w-10 text-center text-sm font-semibold text-slate-900">
                  {quantity}
                </span>
                <button
                  type="button"
                  aria-label="Increase quantity"
                  onClick={() => setQuantity((q) => Math.min(activity.maxParticipants, q + 1))}
                  className="flex h-9 w-9 items-center justify-center text-slate-600 hover:bg-slate-100"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>

            <button
              type="button"
              disabled={!canAdd}
              onClick={add}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add to cart
              {rate ? <span className="opacity-80">· {formatUSD(rate.priceCents * quantity)}</span> : null}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
