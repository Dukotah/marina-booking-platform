'use client';

import { useMemo } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { generateTimeslots, computeSlotStatus } from '@marina/core';
import { Field, TextInput } from './fields';
import { formatTime } from '../../lib/format';
import { cn } from '../../lib/cn';
import type { ActivityFormValues } from './types';

/**
 * Step 3 — Schedule. Operators set an operating window (open/close hour),
 * slot interval, and per-slot capacity. We preview the generated slots live using
 * @marina/core's generateTimeslots so what they configure is exactly what guests
 * will see — no separate hidden timeslot editor (the contrast to Singenuity).
 */
const HOUR_OPTIONS = Array.from({ length: 25 }, (_, h) => h);

function hourLabel(h: number): string {
  if (h === 24) return 'Midnight';
  const d = new Date(2026, 0, 1, h, 0, 0, 0);
  return formatTime(d);
}

export function StepSchedule({ form }: { form: UseFormReturn<ActivityFormValues> }) {
  const {
    register,
    watch,
    formState: { errors },
  } = form;

  const openHour = watch('schedule.open_hour');
  const closeHour = watch('schedule.close_hour');
  const intervalMinutes = watch('schedule.interval_minutes');
  const capacityTotal = watch('schedule.capacity_total');

  const preview = useMemo(() => {
    return generateTimeslots({
      openHour: Number(openHour) || 0,
      closeHour: Number(closeHour) || 0,
      intervalMinutes: Number(intervalMinutes) || 0,
      capacityTotal: Number(capacityTotal) || 0,
      date: new Date(),
    });
  }, [openHour, closeHour, intervalMinutes, capacityTotal]);

  const scheduleErrors = errors.schedule;

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">
        Define the daily operating window. The platform generates evenly-spaced
        bookable slots from this — guests see live availability per slot.
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Opens at" error={scheduleErrors?.open_hour?.message}>
          <select
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
            {...register('schedule.open_hour', { valueAsNumber: true })}
          >
            {HOUR_OPTIONS.slice(0, 24).map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Closes at" error={scheduleErrors?.close_hour?.message}>
          <select
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
            {...register('schedule.close_hour', {
              valueAsNumber: true,
              validate: (v) =>
                Number(v) > Number(form.getValues('schedule.open_hour')) ||
                'Close must be after open',
            })}
          >
            {HOUR_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Slot interval (min)" error={scheduleErrors?.interval_minutes?.message}>
          <TextInput
            type="number"
            min={1}
            invalid={Boolean(scheduleErrors?.interval_minutes)}
            {...register('schedule.interval_minutes', {
              valueAsNumber: true,
              min: { value: 1, message: 'Must be at least 1' },
            })}
          />
        </Field>

        <Field
          label="Capacity per slot"
          hint="How many can book each slot."
          error={scheduleErrors?.capacity_total?.message}
        >
          <TextInput
            type="number"
            min={1}
            invalid={Boolean(scheduleErrors?.capacity_total)}
            {...register('schedule.capacity_total', {
              valueAsNumber: true,
              min: { value: 1, message: 'Must be at least 1' },
            })}
          />
        </Field>
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-slate-700">Daily slot preview</h3>
          <span className="text-xs text-slate-400">{preview.length} slots/day</span>
        </div>
        {preview.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            No slots — check that close time is after open time and the interval is valid.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {preview.map((slot) => {
              const status = computeSlotStatus(slot.capacityTotal, 0);
              return (
                <span
                  key={slot.datetime.toISOString()}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium',
                    status === 'FULL'
                      ? 'border-rose-200 bg-rose-50 text-rose-700'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700',
                  )}
                >
                  {formatTime(slot.datetime)}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
