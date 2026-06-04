'use client';

/**
 * Self-service manage panel: cancel + reschedule entry points for a booking.
 *
 * IMPORTANT: there is no public customer-facing cancel endpoint yet — the API's
 * cancel route is staff-only (requires staff auth). So self-service cancel here
 * is a guided "request cancellation" entry point that opens a prefilled email to
 * the operator, rather than mutating the order directly. When a public
 * customer-cancel endpoint (gated by the magic-link session) lands, swap the
 * mailto for a server action calling it. See slice followups.
 *
 * Reschedule links the customer to the activity's booking page (rebook a new
 * slot), since drag-to-reschedule is an operator/manifest capability.
 *
 * White-label: all copy uses the tenant's operator name (brand). No platform or
 * marina-specific branding.
 */

import { useState } from 'react';
import Link from 'next/link';

interface ManagePanelProps {
  orderNumber: string;
  operatorName: string;
  /** Operator contact email for cancellation requests, if configured. */
  contactEmail: string | null;
  /** True when the booking is still upcoming and therefore changeable. */
  changeable: boolean;
  /** First activity id, used as a convenient "rebook" target when present. */
  rebookActivityId: string | null;
}

export function ManagePanel({
  orderNumber,
  operatorName,
  contactEmail,
  changeable,
  rebookActivityId,
}: ManagePanelProps) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);

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
        <Link
          href={
            rebookActivityId
              ? `/activities/${encodeURIComponent(rebookActivityId)}`
              : '/'
          }
          className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-brand hover:shadow-md"
        >
          <span className="text-base font-semibold text-slate-900">Reschedule</span>
          <span className="mt-1 text-sm text-slate-600">
            Pick a new date or time by booking a different slot.
          </span>
        </Link>

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
    </div>
  );
}
