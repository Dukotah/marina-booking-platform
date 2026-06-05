'use client';

/**
 * Self-service reschedule picker (customer account area).
 *
 * Lets a guest move an upcoming booking to a different day/time of the SAME
 * activity: pick a date, see the open slots for that day, choose one, confirm.
 * It calls the email-gated `rescheduleBookingAction` server action (which hits the
 * API's /self-reschedule endpoint); identity + the activity's reschedule window are
 * enforced server-side. On success it refreshes the page so the new time shows.
 *
 * White-label: no platform branding; copy is neutral / operator-driven.
 */
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Calendar, Check } from 'lucide-react';
import type { AvailabilitySlot } from '@/lib/api';
import { fetchRescheduleSlots, rescheduleBookingAction } from '@/app/account/actions';
import { formatTime } from '@/lib/format';

interface RescheduleFlowProps {
  orderNumber: string;
  email: string;
  activityId: string;
  activityName: string;
  /** The specific item to move (the order's upcoming line). */
  orderItemId: string;
  onCancel: () => void;
}

/** Local YYYY-MM-DD `n` days from today (computed client-side to avoid SSR drift). */
function isoDatePlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function RescheduleFlow({
  orderNumber,
  email,
  activityId,
  activityName,
  orderItemId,
  onCancel,
}: RescheduleFlowProps) {
  const router = useRouter();
  const [date, setDate] = useState('');
  const minDate = isoDatePlus(0);

  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [loadingSlots, startLoadSlots] = useTransition();

  const [selected, setSelected] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  const [done, setDone] = useState(false);

  // Default to tomorrow once mounted (client-only, so no hydration mismatch).
  useEffect(() => {
    setDate(isoDatePlus(1));
  }, []);

  // Load slots whenever the chosen date changes.
  useEffect(() => {
    if (!date) return;
    setSelected(null);
    setSlotsError(null);
    startLoadSlots(async () => {
      const res = await fetchRescheduleSlots(activityId, date);
      if (res.ok) {
        setSlots(res.slots);
      } else {
        setSlots([]);
        setSlotsError(res.error);
      }
    });
  }, [date, activityId]);

  const onConfirm = () => {
    if (!selected) return;
    setSubmitError(null);
    startSubmit(async () => {
      const res = await rescheduleBookingAction(orderNumber, email, selected, orderItemId);
      if (res.ok) {
        setDone(true);
        router.refresh();
      } else {
        setSubmitError(res.error);
      }
    });
  };

  if (done) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex items-start gap-3">
          <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
          <div className="text-sm">
            <p className="font-semibold text-emerald-900">Your booking was rescheduled</p>
            <p className="text-emerald-800">
              Your reservation has been moved. The updated time is shown above.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Calendar className="h-4 w-4 text-brand" aria-hidden />
        Reschedule {activityName}
      </div>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Pick a new date</span>
        <input
          type="date"
          value={date}
          min={minDate}
          onChange={(e) => setDate(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </label>

      <div>
        <span className="mb-2 block text-sm font-medium text-slate-700">Available times</span>
        {loadingSlots ? (
          <p className="text-sm text-slate-500">Loading times…</p>
        ) : slotsError ? (
          <p className="text-sm text-red-600">{slotsError}</p>
        ) : slots.length === 0 ? (
          <p className="text-sm text-slate-500">
            No open times on that day. Try another date.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {slots.map((slot) => {
              const isSel = selected === slot.timeslotId;
              return (
                <button
                  key={slot.timeslotId}
                  type="button"
                  onClick={() => setSelected(slot.timeslotId)}
                  className={`rounded-lg border px-2 py-2 text-sm font-medium transition ${
                    isSel
                      ? 'border-brand bg-brand text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:border-brand'
                  }`}
                  aria-pressed={isSel}
                >
                  {formatTime(slot.datetime)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {submitError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{submitError}</span>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          disabled={!selected || submitting}
          onClick={onConfirm}
          className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Rescheduling…' : 'Confirm new time'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Keep current time
        </button>
      </div>
    </div>
  );
}
