'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Mail, Undo2, Loader2, X } from 'lucide-react';
import { formatUSD } from '../../lib/format';
import { cn } from '../../lib/cn';
import {
  cancelOrderAction,
  resendConfirmationAction,
  refundPaymentAction,
  type ActionResult,
} from '../../app/orders/actions';

export interface RefundablePayment {
  id: string;
  /** Original charge amount, integer cents. */
  amountCents: number;
  /** Already-refunded amount, integer cents. */
  refundedCents: number;
  label: string;
}

export interface OrderActionsProps {
  orderId: string;
  /** True when the order is already cancelled (cancel button disabled). */
  isCancelled: boolean;
  /** True when the customer has an email (resend enabled). */
  hasEmail: boolean;
  /** Whether the signed-in staff may refund (order:refund). */
  canRefund: boolean;
  /** Whether the signed-in staff may write orders (cancel / resend). */
  canWrite: boolean;
  /** Payments that still have a refundable balance. */
  refundablePayments: RefundablePayment[];
}

type Banner = { ok: boolean; message: string } | null;

/**
 * One-click order actions: cancel, resend confirmation email, and an inline
 * full/partial refund with a reason. Each calls a tenant-scoped server action and
 * surfaces the result inline. Buttons are gated by the caller's permissions so a
 * staff member without `order:refund` never sees a refund control.
 */
export function OrderActions({
  orderId,
  isCancelled,
  hasEmail,
  canRefund,
  canWrite,
  refundablePayments,
}: OrderActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<Banner>(null);
  const [showCancel, setShowCancel] = useState(false);
  const [showRefund, setShowRefund] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  function run(action: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await action();
      setBanner({ ok: result.ok, message: result.message });
      if (result.ok) {
        setShowCancel(false);
        setShowRefund(false);
        setCancelReason('');
        router.refresh();
      }
    });
  }

  const hasRefundable = refundablePayments.length > 0;

  return (
    <div className="space-y-3">
      {banner ? (
        <div
          role="status"
          className={cn(
            'flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-sm',
            banner.ok
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-red-50 text-red-800',
          )}
        >
          <span>{banner.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setBanner(null)}
            className="shrink-0 opacity-60 hover:opacity-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canWrite ? (
          <button
            type="button"
            disabled={pending || !hasEmail}
            onClick={() => run(() => resendConfirmationAction({ orderId }))}
            title={hasEmail ? undefined : 'Customer has no email on file'}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm',
              'hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Mail className="h-4 w-4" aria-hidden />}
            Resend confirmation
          </button>
        ) : null}

        {canRefund && hasRefundable ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setShowRefund((v) => !v);
              setShowCancel(false);
            }}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 shadow-sm',
              'hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <Undo2 className="h-4 w-4" aria-hidden />
            Refund
          </button>
        ) : null}

        {canWrite ? (
          <button
            type="button"
            disabled={pending || isCancelled}
            onClick={() => {
              setShowCancel((v) => !v);
              setShowRefund(false);
            }}
            title={isCancelled ? 'Order is already cancelled' : undefined}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 shadow-sm',
              'hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <Ban className="h-4 w-4" aria-hidden />
            {isCancelled ? 'Cancelled' : 'Cancel order'}
          </button>
        ) : null}
      </div>

      {showCancel ? (
        <CancelPanel
          reason={cancelReason}
          pending={pending}
          onReasonChange={setCancelReason}
          onConfirm={() => run(() => cancelOrderAction({ orderId, reason: cancelReason }))}
          onClose={() => setShowCancel(false)}
        />
      ) : null}

      {showRefund && canRefund ? (
        <RefundPanel
          payments={refundablePayments}
          pending={pending}
          onSubmit={(paymentId, amountCents, reason) =>
            run(() => refundPaymentAction({ paymentId, amountCents, reason }))
          }
          onClose={() => setShowRefund(false)}
        />
      ) : null}
    </div>
  );
}

function CancelPanel({
  reason,
  pending,
  onReasonChange,
  onConfirm,
  onClose,
}: {
  reason: string;
  pending: boolean;
  onReasonChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const fieldId = useId();
  return (
    <div className="rounded-lg border border-red-200 bg-red-50/60 p-4">
      <p className="text-sm font-medium text-red-900">Cancel this order?</p>
      <p className="mt-1 text-xs text-red-700">
        This cancels all booked items and restores their timeslot capacity. This cannot be undone.
      </p>
      <label htmlFor={fieldId} className="mt-3 block text-xs font-medium text-slate-600">
        Reason (optional)
      </label>
      <textarea
        id={fieldId}
        value={reason}
        onChange={(e) => onReasonChange(e.target.value)}
        rows={2}
        maxLength={500}
        placeholder="e.g. Customer requested cancellation"
        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
      />
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Confirm cancellation
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          Keep order
        </button>
      </div>
    </div>
  );
}

function RefundPanel({
  payments,
  pending,
  onSubmit,
  onClose,
}: {
  payments: RefundablePayment[];
  pending: boolean;
  onSubmit: (paymentId: string, amountCents: number | undefined, reason: string) => void;
  onClose: () => void;
}) {
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? '');
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [amountInput, setAmountInput] = useState('');
  const [reason, setReason] = useState('');
  const amountFieldId = useId();
  const reasonFieldId = useId();

  const selected = payments.find((p) => p.id === paymentId) ?? payments[0];
  const refundableCents = selected ? selected.amountCents - selected.refundedCents : 0;

  const parsedAmountCents =
    mode === 'full'
      ? refundableCents
      : Math.round(parseFloat(amountInput.replace(/[^0-9.]/g, '') || '0') * 100);

  const amountValid =
    mode === 'full'
      ? refundableCents > 0
      : parsedAmountCents > 0 && parsedAmountCents <= refundableCents;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
      <p className="text-sm font-medium text-amber-900">Issue a refund</p>

      {payments.length > 1 ? (
        <div className="mt-3">
          <label className="block text-xs font-medium text-slate-600">Payment</label>
          <select
            value={paymentId}
            onChange={(e) => {
              setPaymentId(e.target.value);
              setMode('full');
              setAmountInput('');
            }}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
          >
            {payments.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {formatUSD(p.amountCents - p.refundedCents)} refundable
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <p className="mt-3 text-xs text-slate-600">
        Refundable on this payment:{' '}
        <span className="font-medium text-slate-800">{formatUSD(refundableCents)}</span>
      </p>

      <div className="mt-3 flex gap-4 text-sm">
        <label className="inline-flex items-center gap-1.5">
          <input
            type="radio"
            name="refund-mode"
            checked={mode === 'full'}
            onChange={() => setMode('full')}
          />
          Full
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="radio"
            name="refund-mode"
            checked={mode === 'partial'}
            onChange={() => setMode('partial')}
          />
          Partial
        </label>
      </div>

      {mode === 'partial' ? (
        <div className="mt-3">
          <label htmlFor={amountFieldId} className="block text-xs font-medium text-slate-600">
            Amount (USD)
          </label>
          <input
            id={amountFieldId}
            inputMode="decimal"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="0.00"
            className="mt-1 w-40 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />
          {amountInput && !amountValid ? (
            <p className="mt-1 text-xs text-red-600">
              Enter an amount between $0.01 and {formatUSD(refundableCents)}.
            </p>
          ) : null}
        </div>
      ) : null}

      <label htmlFor={reasonFieldId} className="mt-3 block text-xs font-medium text-slate-600">
        Reason (optional)
      </label>
      <textarea
        id={reasonFieldId}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={500}
        placeholder="e.g. Weather cancellation"
        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
      />

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={pending || !amountValid || !selected}
          onClick={() =>
            selected &&
            onSubmit(selected.id, mode === 'full' ? undefined : parsedAmountCents, reason)
          }
          className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Refund {amountValid ? formatUSD(parsedAmountCents) : ''}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
