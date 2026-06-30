'use client';

/**
 * Customer self-service reschedule dialog.
 *
 * Reuses the same date + time pickers as the booking page (AvailabilityCalendar +
 * TimeSlotPicker) so a customer can move an upcoming booking to another slot of the
 * SAME activity. When the order has more than one upcoming item, the customer first
 * picks which one to move. The move goes through the `rescheduleBookingAction`
 * server action, which gates on the order's email and enforces the activity's
 * self-reschedule window; its customer-safe error message is surfaced inline.
 *
 * White-label: copy uses the operator name only; the accent color is the tenant's
 * brand color, passed from the (server) page.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog } from '@marina/ui';
import { formatLongDate, formatTime } from '@/lib/format';
import type { AvailabilitySlot } from '@/lib/api';
import { AvailabilityCalendar } from '@/components/booking/AvailabilityCalendar';
import { TimeSlotPicker } from '@/components/activity/TimeSlotPicker';
import { rescheduleBookingAction } from './actions';

export interface RescheduleItem {
  /** OrderItem id — the booking line being moved. */
  orderItemId: string;
  activityId: string;
  activityName: string;
  /** Current booked slot datetime (ISO 8601 UTC). */
  datetime: string;
}

interface RescheduleDialogProps {
  open: boolean;
  onClose: () => void;
  orderNumber: string;
  /** Verified order email (the identity gate for the move). */
  email: string;
  /** Upcoming, still-changeable items on the order. */
  items: RescheduleItem[];
  operatorName: string;
  accentColor: string;
}

export function RescheduleDialog({
  open,
  onClose,
  orderNumber,
  email,
  items,
  operatorName,
  accentColor,
}: RescheduleDialogProps) {
  const router = useRouter();
  // Single item → preselect it; multiple → make the customer choose first.
  const [selectedItem, setSelectedItem] = useState<RescheduleItem | null>(
    items.length === 1 ? (items[0] ?? null) : null,
  );
  const [date, setDate] = useState<Date | null>(null);
  const [slot, setSlot] = useState<AvailabilitySlot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const resetState = () => {
    setSelectedItem(items.length === 1 ? (items[0] ?? null) : null);
    setDate(null);
    setSlot(null);
    setSubmitting(false);
    setError(null);
    setDone(false);
  };

  const handleClose = () => {
    if (submitting) return;
    resetState();
    onClose();
  };

  const handleSelectDate = (d: Date) => {
    setDate(d);
    setSlot(null);
  };

  const handleConfirm = async () => {
    if (!selectedItem || !slot) return;
    setSubmitting(true);
    setError(null);
    const result = await rescheduleBookingAction({
      orderNumber,
      email,
      timeslotId: slot.timeslotId,
      orderItemId: selectedItem.orderItemId,
    });
    setSubmitting(false);
    if (result.ok) {
      setDone(true);
      // Re-render the (force-dynamic) bookings page so the new time shows.
      router.refresh();
    } else {
      setError(result.error);
    }
  };

  // ---- Success state -------------------------------------------------------
  if (done) {
    return (
      <Dialog
        open={open}
        onClose={handleClose}
        title="Reservation updated"
        footer={
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
            style={{ backgroundColor: accentColor }}
          >
            Done
          </button>
        }
      >
        <p className="text-sm text-slate-600">
          Your booking has been moved
          {slot ? (
            <>
              {' '}
              to{' '}
              <span className="font-semibold text-slate-900">
                {formatLongDate(slot.datetime)} · {formatTime(slot.datetime)}
              </span>
            </>
          ) : null}
          . A confirmation will follow from {operatorName}.
        </p>
      </Dialog>
    );
  }

  // ---- Choose which booking to move (multi-item orders) --------------------
  if (!selectedItem) {
    return (
      <Dialog
        open={open}
        onClose={handleClose}
        title="Which booking would you like to change?"
      >
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.orderItemId}>
              <button
                type="button"
                onClick={() => setSelectedItem(item)}
                className="flex w-full flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-brand hover:shadow-md"
              >
                <span className="font-semibold text-slate-900">
                  {item.activityName}
                </span>
                <span className="mt-0.5 text-sm text-slate-600">
                  {formatLongDate(item.datetime)} · {formatTime(item.datetime)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
    );
  }

  // ---- Pick a new date + time ---------------------------------------------
  const canChooseAnotherItem = items.length > 1;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={`Reschedule ${selectedItem.activityName}`}
      description={
        <>
          Currently {formatLongDate(selectedItem.datetime)} ·{' '}
          {formatTime(selectedItem.datetime)}. Pick a new date and time below.
        </>
      }
      footer={
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Keep current time
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!slot || submitting}
            className="inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ backgroundColor: accentColor }}
          >
            {submitting ? 'Moving…' : 'Confirm new time'}
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        {canChooseAnotherItem && (
          <button
            type="button"
            onClick={() => {
              setSelectedItem(null);
              setDate(null);
              setSlot(null);
            }}
            className="text-sm font-medium text-brand hover:underline"
          >
            ← Change a different booking
          </button>
        )}

        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-700">
            Pick a date
          </h3>
          <AvailabilityCalendar
            activityId={selectedItem.activityId}
            selectedDate={date}
            onSelectDate={handleSelectDate}
          />
        </section>

        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-700">
            Select a time
          </h3>
          {date ? (
            <TimeSlotPicker
              activityId={selectedItem.activityId}
              date={date}
              selectedTimeslotId={slot?.timeslotId ?? null}
              onSelect={setSlot}
              accentColor={accentColor}
            />
          ) : (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
              Pick a date above to see available times.
            </p>
          )}
        </section>

        {slot && (
          <div className="rounded-xl bg-slate-50 p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">New time</span>
              <span className="text-right font-semibold text-slate-900">
                {formatLongDate(slot.datetime)}
                <br />
                <span className="font-medium text-slate-600">
                  {formatTime(slot.datetime)}
                </span>
              </span>
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export default RescheduleDialog;
