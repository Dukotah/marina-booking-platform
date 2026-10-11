'use client';

/**
 * Self-service manage panel: cancel + reschedule entry points for a booking.
 *
 * Cancel opens an in-page dialog (CancelDialog) that first shows the refund PREVIEW
 * and the policy in plain language, then cancels through the public self-cancel
 * endpoint — which issues the tiered refund and sends the cancellation email. The
 * endpoint is gated by the order's email (the same magic-link stub the reschedule
 * flow uses) and enforces the activity's self-cancel window server-side; when it is
 * too close to the reservation the dialog shows a "please call" state instead.
 *
 * Reschedule opens an in-page dialog (RescheduleDialog) that moves an upcoming
 * booking to another slot of the same activity via the self-reschedule endpoint —
 * no rebooking or re-payment. It is enabled only when there are changeable items;
 * the activity's self-reschedule window is enforced server-side.
 *
 * White-label: all copy uses the tenant's operator name (brand). No platform or
 * marina-specific branding.
 */

import { useState } from 'react';
import { RescheduleDialog, type RescheduleItem } from './RescheduleDialog';
import { CancelDialog } from './CancelDialog';

interface ManagePanelProps {
  orderNumber: string;
  operatorName: string;
  /** Operator contact email for help, if configured. */
  contactEmail: string | null;
  /** Operator public phone for the "too late to cancel" state, if configured. */
  operatorPhone: string | null;
  /** True when the booking is still upcoming and therefore changeable. */
  changeable: boolean;
  /** Verified order email — the identity gate for self-service changes. */
  email: string;
  /** Upcoming, still-changeable items the customer may move. */
  rescheduleItems: RescheduleItem[];
  /** Tenant brand color for dialog accents. */
  accentColor: string;
}

export function ManagePanel({
  orderNumber,
  operatorName,
  contactEmail,
  operatorPhone,
  changeable,
  email,
  rescheduleItems,
  accentColor,
}: ManagePanelProps) {
  const [showCancel, setShowCancel] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const canReschedule = changeable && rescheduleItems.length > 0;

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

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Manage this booking
      </h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setShowReschedule(true)}
          disabled={!canReschedule}
          className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-brand hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-slate-200 disabled:hover:shadow-sm"
        >
          <span className="text-base font-semibold text-slate-900">Reschedule</span>
          <span className="mt-1 text-sm text-slate-600">
            Move this booking to a new date or time.
          </span>
        </button>

        <button
          type="button"
          onClick={() => setShowCancel(true)}
          className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-red-300 hover:shadow-md"
        >
          <span className="text-base font-semibold text-slate-900">Cancel</span>
          <span className="mt-1 text-sm text-slate-600">
            See your refund, then cancel this reservation.
          </span>
        </button>
      </div>

      <CancelDialog
        open={showCancel}
        onClose={() => setShowCancel(false)}
        orderNumber={orderNumber}
        email={email}
        operatorName={operatorName}
        operatorPhone={operatorPhone}
        accentColor={accentColor}
      />

      {canReschedule && (
        <RescheduleDialog
          open={showReschedule}
          onClose={() => setShowReschedule(false)}
          orderNumber={orderNumber}
          email={email}
          items={rescheduleItems}
          operatorName={operatorName}
          accentColor={accentColor}
        />
      )}
    </div>
  );
}
