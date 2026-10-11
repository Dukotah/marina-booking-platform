'use client';

/**
 * Customer self-service cancel dialog.
 *
 * Flow:
 *   1. On open, fetch the refund PREVIEW (getCancelPreviewAction) and show the guest
 *      exactly what they'd get back plus the policy in plain language.
 *   2. If the self-cancel window has already closed, show a clean "too late to
 *      cancel online — please call" state instead of a confirm button.
 *   3. On confirm, call cancelBookingAction. The API issues the tiered refund and
 *      sends the cancellation email; we refresh the page so the CANCELLED status
 *      shows.
 *
 * Both the preview and the cancel are gated server-side by the order's email (the
 * magic-link stub) — the same identity gate the self-reschedule flow uses.
 *
 * White-label: copy uses the operator name only; the accent color is the tenant's
 * brand color. The "please call" state uses the operator's public phone when set.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog } from '@marina/ui';
import { formatUSD } from '@/lib/format';
import type { CancellationPreview } from '@/lib/orders';
import {
  cancelBookingAction,
  getCancelPreviewAction,
} from './actions';

interface CancelDialogProps {
  open: boolean;
  onClose: () => void;
  orderNumber: string;
  /** Verified order email (the identity gate for the cancel). */
  email: string;
  operatorName: string;
  /** Operator public phone for the "too late — please call" state, if configured. */
  operatorPhone: string | null;
  accentColor: string;
}

export function CancelDialog({
  open,
  onClose,
  orderNumber,
  email,
  operatorName,
  operatorPhone,
  accentColor,
}: CancelDialogProps) {
  const router = useRouter();
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [preview, setPreview] = useState<CancellationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [windowClosed, setWindowClosed] = useState(false);
  const [done, setDone] = useState(false);
  const [refundedCents, setRefundedCents] = useState(0);

  const loadPreview = useCallback(async () => {
    setLoadingPreview(true);
    setPreviewError(null);
    const result = await getCancelPreviewAction({ orderNumber, email });
    setLoadingPreview(false);
    if (result.ok) {
      setPreview(result.preview);
      setWindowClosed(!result.preview.withinSelfCancelWindow);
    } else {
      setPreviewError(result.error);
    }
  }, [orderNumber, email]);

  // Fetch the preview each time the dialog opens; reset on close.
  useEffect(() => {
    if (open) {
      setDone(false);
      setCancelError(null);
      void loadPreview();
    } else {
      setPreview(null);
      setPreviewError(null);
      setWindowClosed(false);
      setSubmitting(false);
    }
  }, [open, loadPreview]);

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    setCancelError(null);
    const result = await cancelBookingAction({ orderNumber, email });
    setSubmitting(false);
    if (result.ok) {
      setRefundedCents(preview?.refundCents ?? 0);
      setDone(true);
      router.refresh();
    } else if (result.windowClosed) {
      // The window closed between preview and confirm — flip to the "call us" state.
      setWindowClosed(true);
      setCancelError(null);
    } else {
      setCancelError(result.error);
    }
  };

  // ---- Success state -------------------------------------------------------
  if (done) {
    return (
      <Dialog
        open={open}
        onClose={handleClose}
        title="Booking cancelled"
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
          Your booking has been cancelled.
          {refundedCents > 0 ? (
            <>
              {' '}
              A refund of{' '}
              <span className="font-semibold text-slate-900">
                {formatUSD(refundedCents)}
              </span>{' '}
              is on its way. A confirmation will follow from {operatorName}.
            </>
          ) : (
            <> A confirmation will follow from {operatorName}.</>
          )}
        </p>
      </Dialog>
    );
  }

  // ---- "Too late to cancel online" state -----------------------------------
  if (windowClosed) {
    return (
      <Dialog
        open={open}
        onClose={handleClose}
        title="Please call to cancel"
        footer={
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Keep my booking
          </button>
        }
      >
        <p className="text-sm text-slate-600">
          It is too close to your reservation to cancel online.
          {operatorPhone ? (
            <>
              {' '}
              Please call {operatorName} at{' '}
              <a
                href={`tel:${operatorPhone.replace(/[^0-9+]/g, '')}`}
                className="font-semibold text-brand hover:underline"
              >
                {operatorPhone}
              </a>{' '}
              and we will help.
            </>
          ) : (
            <> Please contact {operatorName} directly and we will help.</>
          )}
        </p>
      </Dialog>
    );
  }

  // ---- Confirm state (with refund preview) ---------------------------------
  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Cancel this booking?"
      description="Review your refund below before confirming. This cannot be undone."
      footer={
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Keep my booking
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || loadingPreview || !!previewError}
            className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Cancelling…' : 'Cancel booking'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {loadingPreview && (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
            Calculating your refund…
          </p>
        )}

        {previewError && (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {previewError}
          </p>
        )}

        {preview && !loadingPreview && !previewError && (
          <>
            <div className="rounded-xl bg-slate-50 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">You paid</span>
                <span className="font-medium text-slate-900">
                  {formatUSD(preview.amountPaidCents)}
                </span>
              </div>
              {preview.feeCents > 0 && (
                <div className="mt-1.5 flex justify-between">
                  <span className="text-slate-500">Cancellation fee</span>
                  <span className="font-medium text-slate-900">
                    −{formatUSD(preview.feeCents)}
                  </span>
                </div>
              )}
              <div className="mt-2 flex justify-between border-t border-slate-200 pt-2">
                <span className="font-semibold text-slate-700">Refund to you</span>
                <span className="text-base font-bold text-slate-900">
                  {formatUSD(preview.refundCents)}
                </span>
              </div>
            </div>

            <p className="text-sm text-slate-600">
              {policyCopy(preview)}
            </p>
          </>
        )}

        {cancelError && (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {cancelError}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Plain-language explanation of the refund the guest is about to receive. */
function policyCopy(preview: CancellationPreview): string {
  if (preview.refundCents >= preview.amountPaidCents && preview.amountPaidCents > 0) {
    return 'You are within the full-refund window, so you will be refunded in full.';
  }
  if (preview.refundCents === 0) {
    return 'Based on how close it is to your reservation, this cancellation is not refundable.';
  }
  return `Based on how close it is to your reservation, ${preview.tierPercent}% of what you paid is refundable.`;
}

export default CancelDialog;
