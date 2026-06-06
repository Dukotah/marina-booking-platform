'use client';

/**
 * Self-service manage panel: reschedule + cancel entry points for a booking.
 *
 * RESCHEDULE is now a real in-account flow (roadmap 2.1): it opens a modal slot
 * picker (RescheduleSlotPicker) that calls the API self-reschedule endpoint via a
 * server action. Identity is the httpOnly session cookie (forwarded as a Bearer
 * token by lib/api.ts) — never an order#/email in the URL. For multi-item orders
 * the customer first chooses which reservation to move (orderItemId). The older
 * "rebook by booking a new slot" link is gone (it created a brand-new order).
 *
 * CANCEL: there is still no public customer-facing cancel endpoint (the API's
 * cancel route is staff-only), so cancel remains a guided "request cancellation"
 * mailto to the operator. When a session-gated customer-cancel endpoint lands,
 * swap the mailto for a server action.
 *
 * White-label: all copy uses the tenant's operator name (brand). No platform or
 * marina-specific branding.
 */

import { useState } from 'react';
import { Dialog } from '@marina/ui';
import { formatLongDate, formatTime } from '@/lib/format';
import { RescheduleSlotPicker } from '@/components/reschedule/RescheduleSlotPicker';

/** A reschedulable line item, threaded from the bookings page. */
export interface ManageableItem {
  id: string;
  activityId: string;
  activityName: string;
  rateName: string;
  /** ISO datetime the item is currently booked for. */
  datetime: string;
}

interface ManagePanelProps {
  orderNumber: string;
  operatorName: string;
  /** Operator contact email for cancellation requests, if configured. */
  contactEmail: string | null;
  /** True when the booking is still upcoming and therefore changeable. */
  changeable: boolean;
  /** Brand accent color (hex) for selected affordances in the picker. */
  accentColor: string;
  /** Upcoming, still-movable items. Empty when there's nothing to reschedule. */
  items: ManageableItem[];
}

export function ManagePanel({
  orderNumber,
  operatorName,
  contactEmail,
  changeable,
  accentColor,
  items,
}: ManagePanelProps) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  // Which item is being moved. For single-item orders this is auto-selected.
  const [activeItemId, setActiveItemId] = useState<string | null>(null);

  if (!changeable) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        This reservation can no longer be changed online. For help, contact{' '}
        {operatorName}
        {contactEmail ? (
          <>
            {' '}
            at{' '}
            <a className="font-medium text-brand hover:underline" href={`mailto:${contactEmail}`}>
              {contactEmail}
            </a>
          </>
        ) : null}
        .
      </div>
    );
  }

  const canReschedule = items.length > 0;
  const activeItem = items.find((i) => i.id === activeItemId) ?? null;

  const openReschedule = () => {
    // Auto-pick when there's only one movable item; otherwise prompt to choose.
    setActiveItemId(items.length === 1 ? (items[0]?.id ?? null) : null);
    setRescheduleOpen(true);
  };
  const closeReschedule = () => {
    setRescheduleOpen(false);
    setActiveItemId(null);
  };

  const cancelSubject = `Cancellation request — order ${orderNumber}`;
  const cancelBody =
    `Hello ${operatorName},\n\n` +
    `I would like to request a cancellation for my booking ${orderNumber}.\n\n` +
    `Thank you.`;
  const cancelMailto = contactEmail
    ? `mailto:${contactEmail}?subject=${encodeURIComponent(cancelSubject)}&body=${encodeURIComponent(
        cancelBody,
      )}`
    : null;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Manage this booking
      </h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={openReschedule}
          disabled={!canReschedule}
          className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-brand hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-slate-200 disabled:hover:shadow-sm"
        >
          <span className="text-base font-semibold text-slate-900">Reschedule</span>
          <span className="mt-1 text-sm text-slate-600">
            Move your reservation to another date or time.
          </span>
        </button>

        <button
          type="button"
          onClick={() => setConfirmingCancel((v) => !v)}
          className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-red-300 hover:shadow-md"
        >
          <span className="text-base font-semibold text-slate-900">Cancel</span>
          <span className="mt-1 text-sm text-slate-600">
            Request to cancel this reservation.
          </span>
        </button>
      </div>

      {confirmingCancel && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-900">
            Cancellations are handled by {operatorName}. Refund eligibility depends on
            their policy and how close it is to your reservation time.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            {cancelMailto ? (
              <a
                href={cancelMailto}
                className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-700"
              >
                Email cancellation request
              </a>
            ) : (
              <span className="text-sm text-red-900">
                Please contact {operatorName} directly to cancel.
              </span>
            )}
            <button
              type="button"
              onClick={() => setConfirmingCancel(false)}
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Keep my booking
            </button>
          </div>
        </div>
      )}

      <Dialog
        open={rescheduleOpen}
        onClose={closeReschedule}
        title="Reschedule your booking"
        description={
          activeItem
            ? undefined
            : 'Which reservation would you like to move?'
        }
      >
        {activeItem ? (
          <RescheduleSlotPicker
            orderItemId={activeItem.id}
            activityId={activeItem.activityId}
            activityName={activeItem.activityName}
            rateName={activeItem.rateName}
            currentDatetime={activeItem.datetime}
            accentColor={accentColor}
            onDone={closeReschedule}
          />
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setActiveItemId(item.id)}
                  className="flex w-full flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-brand hover:shadow-md"
                >
                  <span className="font-semibold text-slate-900">{item.activityName}</span>
                  <span className="text-sm text-slate-600">{item.rateName}</span>
                  <span className="mt-1 text-sm font-medium text-slate-900">
                    {formatLongDate(item.datetime)} · {formatTime(item.datetime)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </div>
  );
}
