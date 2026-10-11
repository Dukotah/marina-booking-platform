'use client';

import { useState } from 'react';
import { Clock, Users, Plus, Minus } from 'lucide-react';
import { formatUSD } from '@marina/core';
import { cn } from '../../lib/cn';
import { Button } from '../ui';
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
  FULL: 'border-line bg-surface-muted text-ink-muted cursor-not-allowed',
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
      <div className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-ink-body">
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
              'inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors',
              a.id === activityId
                ? 'border-accent bg-accent-tint text-accent-ink'
                : 'border-line bg-surface text-ink-body hover:border-line-strong',
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
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Rate
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {activity.rates.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRateId(r.id)}
                  className={cn(
                    'flex min-h-11 items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                    r.id === rateId
                      ? 'border-accent bg-accent-tint ring-1 ring-accent'
                      : 'border-line hover:border-line-strong',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">{r.name}</span>
                    <span className="flex items-center gap-1 text-xs text-ink-body">
                      <Clock className="h-3 w-3" aria-hidden />
                      {r.durationMinutes} min
                    </span>
                  </span>
                  <span className="ml-2 shrink-0 font-semibold text-ink tabular-nums">
                    {formatUSD(r.priceCents)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Timeslot picker */}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Today’s timeslots
            </div>
            {activity.timeslots.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-ink-body">
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
                        'flex min-h-11 flex-col items-start rounded-lg border px-3 py-2 text-sm transition-colors',
                        STATUS_STYLES[t.status],
                        t.id === timeslotId && !disabled && 'ring-2 ring-offset-1 ring-accent',
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-ink-body">Quantity</span>
              <div className="flex items-center rounded-lg border border-line">
                <button
                  type="button"
                  aria-label="Decrease quantity"
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  className="flex h-11 w-11 items-center justify-center text-ink-body hover:bg-surface-muted"
                >
                  <Minus className="h-4 w-4" aria-hidden />
                </button>
                <span className="w-10 text-center text-sm font-semibold text-ink tabular-nums">
                  {quantity}
                </span>
                <button
                  type="button"
                  aria-label="Increase quantity"
                  onClick={() => setQuantity((q) => Math.min(activity.maxParticipants, q + 1))}
                  className="flex h-11 w-11 items-center justify-center text-ink-body hover:bg-surface-muted"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>

            <Button type="button" disabled={!canAdd} onClick={add}>
              <Plus className="h-4 w-4" aria-hidden />
              Add to cart
              {rate ? <span className="opacity-80 tabular-nums">· {formatUSD(rate.priceCents * quantity)}</span> : null}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
