'use client';

import { useEffect, useId, useRef, useState, useTransition, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Mail, Undo2, Loader2, X, Wallet, Plus } from 'lucide-react';
import { formatUSD } from '../../lib/format';
import { cn } from '../../lib/cn';
import { Button, Card, FieldLabel, Input, Select } from '../ui';
import {
  cancelOrderAction,
  resendConfirmationAction,
  refundPaymentAction,
  collectBalanceAction,
  addOrderChargeAction,
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
  /** Outstanding balance in integer cents (drives the "Collect balance" action). */
  balanceDueCents: number;
}

type Banner = { ok: boolean; message: string } | null;

/**
 * One-click order actions: cancel, resend confirmation email, and an inline
 * full/partial refund with a reason. Each calls a tenant-scoped server action and
 * surfaces the result inline. Buttons are gated by the caller's permissions so a
 * staff member without `order:refund` never sees a refund control.
 *
 * The two confirm steps are disclosure panels, not modal dialogs: they render
 * immediately after their trigger, so Tab reaches them in the order they appear.
 * What they owe, and now honour, is the rest of the disclosure contract — the
 * trigger reports its expanded state, opening moves focus into the panel so the
 * confirm step is announced rather than silently appearing below the fold, Escape
 * closes, and closing puts focus back on the control that opened it. (4.1.2, 2.4.3)
 */
export function OrderActions({
  orderId,
  isCancelled,
  hasEmail,
  canRefund,
  canWrite,
  refundablePayments,
  balanceDueCents,
}: OrderActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [banner, setBanner] = useState<Banner>(null);
  const [showCancel, setShowCancel] = useState(false);
  const [showRefund, setShowRefund] = useState(false);
  const [showCharge, setShowCharge] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [returnFocusTo, setReturnFocusTo] = useState<'cancel' | 'refund' | 'charge' | null>(null);

  // Track the balance locally so a charge added here raises the "Collect balance"
  // figure immediately — before the server revalidation round-trips back. Re-seeded
  // whenever the server prop changes (after router.refresh() commits the new total).
  const [balanceCents, setBalanceCents] = useState(balanceDueCents);
  useEffect(() => {
    setBalanceCents(balanceDueCents);
  }, [balanceDueCents]);

  const cancelPanelId = useId();
  const refundPanelId = useId();
  const chargePanelId = useId();
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const refundTriggerRef = useRef<HTMLButtonElement>(null);
  const chargeTriggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  function run(action: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await action();
      setBanner({ ok: result.ok, message: result.message });
      if (result.ok) {
        // A panel that submitted successfully is about to unmount with focus
        // inside it; hand the keyboard back before that happens.
        if (showCancel) setReturnFocusTo('cancel');
        else if (showRefund) setReturnFocusTo('refund');
        else if (showCharge) setReturnFocusTo('charge');
        setShowCancel(false);
        setShowRefund(false);
        setShowCharge(false);
        setCancelReason('');
        router.refresh();
      }
    });
  }

  useEffect(() => {
    // Deferred to an effect, and held until the transition commits, because the
    // trigger can legitimately disappear — a full refund leaves nothing refundable,
    // so the "Refund" button unmounts with the panel. The root then takes focus, and
    // it sits immediately before the result banner the reader needs to hear.
    if (!returnFocusTo || pending) return;
    const trigger =
      returnFocusTo === 'cancel'
        ? cancelTriggerRef.current
        : returnFocusTo === 'refund'
          ? refundTriggerRef.current
          : chargeTriggerRef.current;
    const target = trigger && !trigger.disabled ? trigger : rootRef.current;
    target?.focus();
    setReturnFocusTo(null);
  }, [returnFocusTo, pending]);

  // Calendar deep-link: a block clicked in the week grid links here with #add-charge,
  // so staff land with the charge panel already open and scrolled into view — the
  // one-tap "add a charge from the calendar" path.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash !== '#add-charge') return;
    if (!canWrite || isCancelled) return;
    setShowCharge(true);
    setShowCancel(false);
    setShowRefund(false);
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Clear the hash so a later manual refresh doesn't re-pop the panel.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [canWrite, isCancelled]);

  const hasRefundable = refundablePayments.length > 0;
  const hasBalanceDue = balanceCents > 0 && !isCancelled;

  return (
    <div className="space-y-3" ref={rootRef} tabIndex={-1}>
      {banner ? (
        <div
          // A failure needs to interrupt; a confirmation does not. Both appear
          // without a focus move, so both need a live region — assertive for the
          // one that means the money did not move. (4.1.3)
          role={banner.ok ? 'status' : 'alert'}
          className={cn(
            'flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-sm',
            banner.ok
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-rose-50 text-rose-800',
          )}
        >
          <span>{banner.message}</span>
          <button
            type="button"
            aria-label="Dismiss this message"
            onClick={() => setBanner(null)}
            className="shrink-0 text-current opacity-70 hover:opacity-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}

      {/* Collect balance is the one obvious primary action when money is owed. */}
      {canWrite && hasBalanceDue ? (
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => run(() => collectBalanceAction({ orderId, method: 'CARD' }))}
          title={`Charge the remaining ${formatUSD(balanceCents)} balance`}
          className="w-full"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Wallet className="h-4 w-4" aria-hidden />
          )}
          Collect balance ({formatUSD(balanceCents)})
        </Button>
      ) : null}

      {/* Everyday secondary actions. */}
      <div className="flex flex-wrap gap-2">
        {canWrite ? (
          <Button
            variant="secondary"
            disabled={pending || !hasEmail}
            onClick={() => run(() => resendConfirmationAction({ orderId }))}
            title={hasEmail ? undefined : 'Customer has no email on file'}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Mail className="h-4 w-4" aria-hidden />}
            Resend confirmation
          </Button>
        ) : null}

        {canWrite ? (
          <Button
            variant="secondary"
            ref={chargeTriggerRef}
            disabled={pending || isCancelled}
            aria-expanded={isCancelled ? undefined : showCharge}
            aria-controls={showCharge ? chargePanelId : undefined}
            onClick={() => {
              setShowCharge((v) => !v);
              setShowCancel(false);
              setShowRefund(false);
            }}
            title={isCancelled ? 'Order is cancelled' : 'Add a fuel, cleaning, damage or late charge'}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add fuel / charge
          </Button>
        ) : null}
      </div>

      {/* Rare, money-reversing actions, demoted below the everyday set. */}
      {canWrite || (canRefund && hasRefundable) ? (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {canRefund && hasRefundable ? (
            <Button
              variant="secondary"
              ref={refundTriggerRef}
              disabled={pending}
              aria-expanded={showRefund}
              // Only referenced while the panel exists: aria-controls pointing at a
              // missing id is an invalid attribute value.
              aria-controls={showRefund ? refundPanelId : undefined}
              onClick={() => {
                setShowRefund((v) => !v);
                setShowCancel(false);
              }}
            >
              <Undo2 className="h-4 w-4" aria-hidden />
              Refund
            </Button>
          ) : null}

          {canWrite ? (
            <Button
              variant="danger"
              ref={cancelTriggerRef}
              disabled={pending || isCancelled}
              aria-expanded={isCancelled ? undefined : showCancel}
              aria-controls={showCancel ? cancelPanelId : undefined}
              onClick={() => {
                setShowCancel((v) => !v);
                setShowRefund(false);
              }}
              title={isCancelled ? 'Order is already cancelled' : undefined}
            >
              <Ban className="h-4 w-4" aria-hidden />
              {isCancelled ? 'Cancelled' : 'Cancel order'}
            </Button>
          ) : null}
        </div>
      ) : null}

      {showCancel ? (
        <CancelPanel
          id={cancelPanelId}
          reason={cancelReason}
          pending={pending}
          onReasonChange={setCancelReason}
          onConfirm={() => run(() => cancelOrderAction({ orderId, reason: cancelReason }))}
          onClose={() => {
            setShowCancel(false);
            setReturnFocusTo('cancel');
          }}
        />
      ) : null}

      {showRefund && canRefund ? (
        <RefundPanel
          id={refundPanelId}
          payments={refundablePayments}
          pending={pending}
          onSubmit={(paymentId, amountCents, reason) =>
            run(() => refundPaymentAction({ paymentId, amountCents, reason }))
          }
          onClose={() => {
            setShowRefund(false);
            setReturnFocusTo('refund');
          }}
        />
      ) : null}

      {showCharge && canWrite ? (
        <ChargePanel
          id={chargePanelId}
          pending={pending}
          onSubmit={(category, amountCents, label) => {
            // Optimistically raise the balance so "Collect balance" reflects the new
            // charge the instant it lands, before the revalidation returns.
            setBalanceCents((c) => c + amountCents);
            run(() => addOrderChargeAction({ orderId, category, amountCents, label }));
          }}
          onClose={() => {
            setShowCharge(false);
            setReturnFocusTo('charge');
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Focus the panel on mount and close it on Escape.
 *
 * Shared by both confirm steps. Focusing the panel itself — rather than its first
 * field — announces the panel's own name ("Cancel this order?") before anything
 * inside it, which is the whole point of a confirm step. (2.4.3, 4.1.3)
 */
function useConfirmPanel(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }
  return { ref, onKeyDown };
}

function CancelPanel({
  id,
  reason,
  pending,
  onReasonChange,
  onConfirm,
  onClose,
}: {
  id: string;
  reason: string;
  pending: boolean;
  onReasonChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const fieldId = useId();
  const titleId = useId();
  const { ref, onKeyDown } = useConfirmPanel(onClose);
  return (
    <div
      id={id}
      ref={ref}
      role="group"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="rounded-lg border border-rose-200 bg-rose-50/60 p-4"
    >
      <p id={titleId} className="text-sm font-semibold text-rose-900">
        Cancel this order?
      </p>
      <p className="mt-1 text-xs text-rose-700">
        This cancels all booked items and restores their timeslot capacity. This cannot be undone.
      </p>
      <FieldLabel htmlFor={fieldId} className="mt-3 text-ink-body">
        Reason (optional)
      </FieldLabel>
      <textarea
        id={fieldId}
        value={reason}
        onChange={(e) => onReasonChange(e.target.value)}
        rows={2}
        maxLength={500}
        placeholder="e.g. Customer requested cancellation"
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted shadow-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus"
      />
      <div className="mt-3 flex gap-2">
        <Button variant="danger" disabled={pending} onClick={onConfirm}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Confirm cancellation
        </Button>
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          Keep order
        </Button>
      </div>
    </div>
  );
}

function RefundPanel({
  id,
  payments,
  pending,
  onSubmit,
  onClose,
}: {
  id: string;
  payments: RefundablePayment[];
  pending: boolean;
  onSubmit: (paymentId: string, amountCents: number | undefined, reason: string) => void;
  onClose: () => void;
}) {
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? '');
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [amountInput, setAmountInput] = useState('');
  const [reason, setReason] = useState('');
  const paymentFieldId = useId();
  const amountFieldId = useId();
  const amountErrorId = useId();
  const reasonFieldId = useId();
  const titleId = useId();
  const { ref, onKeyDown } = useConfirmPanel(onClose);

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

  const showAmountError = mode === 'partial' && Boolean(amountInput) && !amountValid;

  return (
    <div
      id={id}
      ref={ref}
      role="group"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="rounded-lg border border-amber-200 bg-amber-50/60 p-4"
    >
      <p id={titleId} className="text-sm font-semibold text-amber-900">
        Issue a refund
      </p>

      {payments.length > 1 ? (
        <div className="mt-3">
          {/* The label was decorative markup: no htmlFor, and the select had no id,
              so the control that picks which card gets refunded announced as a bare
              "combo box". (4.1.2 — axe select-name) */}
          <FieldLabel htmlFor={paymentFieldId} className="text-ink-body">
            Payment
          </FieldLabel>
          <Select
            id={paymentFieldId}
            value={paymentId}
            onChange={(e) => {
              setPaymentId(e.target.value);
              setMode('full');
              setAmountInput('');
            }}
          >
            {payments.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {formatUSD(p.amountCents - p.refundedCents)} refundable
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <p className="mt-3 text-xs text-ink-body">
        Refundable on this payment:{' '}
        <span className="font-medium text-ink tabular-nums">{formatUSD(refundableCents)}</span>
      </p>

      {/* Two radios with no grouping announce as "Full, radio 1 of 2" with nothing
          saying what is being chosen. Tailwind's preflight zeroes the fieldset's
          native border and padding, so this is markup-only. (1.3.1) */}
      <fieldset className="mt-3">
        <legend className="sr-only">Refund amount</legend>
        <div className="flex gap-4 text-sm text-ink-body">
          <label className="inline-flex min-h-11 items-center gap-1.5">
            <input
              type="radio"
              name="refund-mode"
              className="accent-accent"
              checked={mode === 'full'}
              onChange={() => setMode('full')}
            />
            Full
          </label>
          <label className="inline-flex min-h-11 items-center gap-1.5">
            <input
              type="radio"
              name="refund-mode"
              className="accent-accent"
              checked={mode === 'partial'}
              onChange={() => setMode('partial')}
            />
            Partial
          </label>
        </div>
      </fieldset>

      {mode === 'partial' ? (
        <div className="mt-3">
          <FieldLabel htmlFor={amountFieldId} className="text-ink-body">
            Amount (USD)
          </FieldLabel>
          <Input
            id={amountFieldId}
            inputMode="decimal"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="0.00"
            // aria-invalid alone announces *that* something is wrong; only a bound
            // description announces what, when the reader tabs back to ask. (3.3.1)
            aria-invalid={showAmountError || undefined}
            aria-describedby={showAmountError ? amountErrorId : undefined}
            className="w-40 tabular-nums"
          />
          {showAmountError ? (
            <p id={amountErrorId} className="mt-1 text-xs text-rose-700">
              Enter an amount between $0.01 and {formatUSD(refundableCents)}.
            </p>
          ) : null}
        </div>
      ) : null}

      <FieldLabel htmlFor={reasonFieldId} className="mt-3 text-ink-body">
        Reason (optional)
      </FieldLabel>
      <textarea
        id={reasonFieldId}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={500}
        placeholder="e.g. Weather cancellation"
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted shadow-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus"
      />

      <div className="mt-3 flex gap-2">
        {/* Money-moving confirm keeps its amber semantic tone (waiting/refund) with
            amber-700 for white-text contrast; not a standard Button variant. */}
        <button
          type="button"
          disabled={pending || !amountValid || !selected}
          onClick={() =>
            selected &&
            onSubmit(selected.id, mode === 'full' ? undefined : parsedAmountCents, reason)
          }
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-amber-700 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Refund {amountValid ? formatUSD(parsedAmountCents) : ''}
        </button>
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The post-trip charge kinds — same set the manifest offers, so a fuel charge added
 *  from the order page and one added from the dock land identically. */
const CHARGE_CATEGORIES: { value: string; label: string }[] = [
  { value: 'FUEL', label: 'Fuel' },
  { value: 'CLEANING', label: 'Cleaning' },
  { value: 'DAMAGE', label: 'Damage' },
  { value: 'LATE', label: 'Late return' },
  { value: 'OTHER', label: 'Other' },
];

/**
 * Add an ad-hoc charge (fuel, cleaning, damage, late) to this order — the same
 * post-trip flow the manifest runs when a boat returns, reachable here on the order's
 * own page. It lands on the balance via addOrderChargeAction; the staff then settle it
 * with "Collect balance" above, whose figure updates the instant the charge posts.
 *
 * Same disclosure contract as the cancel/refund panels: focused on open so its name is
 * announced, Escape closes, focus returns to the trigger on close. (2.4.3, 4.1.3)
 */
function ChargePanel({
  id,
  pending,
  onSubmit,
  onClose,
}: {
  id: string;
  pending: boolean;
  onSubmit: (category: string, amountCents: number, label?: string) => void;
  onClose: () => void;
}) {
  const [category, setCategory] = useState('FUEL');
  const [amountInput, setAmountInput] = useState('');
  const [note, setNote] = useState('');
  const categoryFieldId = useId();
  const amountFieldId = useId();
  const noteFieldId = useId();
  const titleId = useId();
  const { ref, onKeyDown } = useConfirmPanel(onClose);

  const parsedAmountCents = Math.round(
    parseFloat(amountInput.replace(/[^0-9.]/g, '') || '0') * 100,
  );
  const amountValid = parsedAmountCents > 0;

  return (
    <div
      id={id}
      ref={ref}
      role="group"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="rounded-lg border border-line bg-surface-muted p-4"
    >
      <p id={titleId} className="text-sm font-semibold text-ink">
        Add a charge
      </p>
      <p className="mt-1 text-xs text-ink-body">
        Adds to this order&rsquo;s balance. Settle it with &ldquo;Collect balance&rdquo; above.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <FieldLabel htmlFor={amountFieldId} className="text-ink-body">
            Amount (USD)
          </FieldLabel>
          <div className="flex w-32 items-center rounded-lg border border-line bg-surface px-3 shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-focus">
            <span className="text-ink-muted">$</span>
            <input
              id={amountFieldId}
              inputMode="decimal"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              placeholder="0.00"
              className="h-11 w-full border-0 bg-transparent pl-1 text-sm text-ink tabular-nums placeholder:text-ink-muted focus:outline-none focus:ring-0"
            />
          </div>
        </div>

        <div>
          <FieldLabel htmlFor={categoryFieldId} className="text-ink-body">
            For
          </FieldLabel>
          <Select
            id={categoryFieldId}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-auto"
          >
            {CHARGE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <FieldLabel htmlFor={noteFieldId} className="mt-3 text-ink-body">
        Note (optional)
      </FieldLabel>
      <Input
        id={noteFieldId}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={200}
        placeholder="e.g. half tank"
      />

      <div className="mt-3 flex gap-2">
        {/* Money-adding confirm keeps its emerald semantic tone (success); emerald-700
            for white-text contrast. Not a standard Button variant. */}
        <button
          type="button"
          disabled={pending || !amountValid}
          onClick={() => onSubmit(category, parsedAmountCents, note.trim() || undefined)}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Add charge {amountValid ? formatUSD(parsedAmountCents) : ''}
        </button>
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
