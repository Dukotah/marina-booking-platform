'use client';

/**
 * 3-D Secure / SCA challenge dialog.
 *
 * When a card needs the bank's second factor the charge does not fail — the bank
 * asks the cardholder a question. Before this existed the guest hit a dead end
 * ("the card was declined"), which is the Phase-1 blocker docs/LOCAL-FIRST-BUILD.md
 * §5 names and a guaranteed lost booking for any real EU card or high-value trip.
 *
 * Two drivers, one dialog:
 *   - LOCAL SANDBOX: there is no bank, so "Authenticate" simply tells the API to
 *     settle the outstanding intent — which drives the simulator's real
 *     `confirmChallenge` state machine, not a shortcut around it.
 *   - CLOUD (Stripe): the challenge belongs to Stripe.js. We run
 *     `handleNextAction(clientSecret)`, which opens the issuer's own iframe/redirect,
 *     and only once the browser says the intent moved do we ask the API to settle.
 *     The API re-reads the intent from Stripe anyway — the browser's word is never
 *     what confirms a payment.
 *
 * Cancelling is a first-class outcome, not an escape hatch: it tells the API to
 * abandon the intent AND release the order, so a guest who backs out leaves nothing
 * holding seats.
 *
 * Accessibility: a real modal. `role="dialog" aria-modal`, focus moves in on open
 * and returns to wherever it came from on close, Tab is trapped inside, Escape
 * cancels, and every state change (working / failed) is announced through a polite
 * live region. The buttons are `type="button"` because this renders inside the
 * checkout <form> and a submit here would re-run the whole booking.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { formatUSD } from '@marina/core';
import { Button } from '@marina/ui';
import { isApiError, request } from '@/lib/api';

/** The authentication affordance the charge response handed back. */
export interface ChallengeHandoff {
  /** Which driver raised the challenge — decides whether Stripe.js is involved. */
  provider: 'sandbox' | 'stripe';
  /** The PaymentIntent awaiting authentication. */
  intentId: string | null;
  /** Stripe.js needs this; the simulator has no use for it. */
  clientSecret: string | null;
  /** Stripe publishable key, so this dialog can load Stripe.js on its own. */
  publishableKey: string | null;
}

interface ChallengeDialogProps {
  /** The order the challenged payment belongs to. */
  orderId: string;
  /** Amount awaiting authentication, integer cents. */
  amountCents: number;
  handoff: ChallengeHandoff;
  /** The payment settled — the caller redirects to the confirmation page. */
  onAuthenticated: () => void;
  /**
   * The guest backed out and the order was released. The caller returns them to
   * the checkout form with their details intact.
   */
  onCancelled: () => void;
  /** The dialog could not be completed at all; the caller shows the message. */
  onFailed: (message: string) => void;
}

/** Everything inside the dialog a keyboard can land on, in DOM order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/** The API's answer to a confirm call. Only the order figures are read here. */
interface ConfirmResponse {
  order: { id: string; balanceDueCents: number };
}

export function ChallengeDialog({
  orderId,
  amountCents,
  handoff,
  onAuthenticated,
  onCancelled,
  onFailed,
}: ChallengeDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  /** Where focus was before the dialog opened, so it can be handed back. */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const [busy, setBusy] = useState<'authenticating' | 'cancelling' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const titleId = useId();
  const descriptionId = useId();

  /** Ask the API to settle or abandon the intent. Throws an ApiError on failure. */
  const confirm = useCallback(
    (action: 'complete' | 'cancel') =>
      request<ConfirmResponse>('/api/payments/confirm', {
        method: 'POST',
        body: { orderId, intentId: handoff.intentId ?? undefined, action },
      }),
    [orderId, handoff.intentId],
  );

  /**
   * Hand off to the issuer. Only cloud mode has anywhere to hand off TO: in a
   * sandbox run the simulator is the bank, and it answers when the API asks it.
   */
  const runIssuerChallenge = useCallback(async (): Promise<string | null> => {
    if (handoff.provider !== 'stripe') return null;
    if (!handoff.clientSecret || !handoff.publishableKey) {
      // The charge came back needing authentication but without the handle
      // Stripe.js needs. Say so plainly rather than pretending to try.
      return 'We could not reach your bank to confirm this payment. Please try a different card.';
    }

    // Imported here, not at module scope: nobody pays to download Stripe.js for a
    // checkout that never gets challenged.
    const { loadStripe } = await import('@stripe/stripe-js');
    const stripe = await loadStripe(handoff.publishableKey);
    if (!stripe) return 'We could not load the secure payment check. Please try again.';

    const { error } = await stripe.handleNextAction({ clientSecret: handoff.clientSecret });
    if (error) {
      return error.message ?? 'Your bank could not confirm this payment. Please try again.';
    }
    return null;
  }, [handoff.provider, handoff.clientSecret, handoff.publishableKey]);

  const authenticate = useCallback(async () => {
    if (busy) return;
    setProblem(null);
    setBusy('authenticating');
    try {
      const issuerProblem = await runIssuerChallenge();
      if (issuerProblem) {
        setProblem(issuerProblem);
        return;
      }
      await confirm('complete');
      onAuthenticated();
    } catch (err) {
      setProblem(
        isApiError(err)
          ? err.message
          : 'We could not confirm this payment with your bank. Please try again.',
      );
    } finally {
      setBusy(null);
    }
  }, [busy, confirm, onAuthenticated, runIssuerChallenge]);

  const cancel = useCallback(async () => {
    if (busy) return;
    setProblem(null);
    setBusy('cancelling');
    try {
      await confirm('cancel');
      onCancelled();
    } catch (err) {
      // The order may now be in an unknown state, so this is not something the
      // guest can just retry past — hand it to the page's own error banner.
      onFailed(
        isApiError(err)
          ? err.message
          : 'We could not cancel this payment. Please contact us before trying again.',
      );
    } finally {
      setBusy(null);
    }
  }, [busy, confirm, onCancelled, onFailed]);

  // Move focus in on mount and return it on unmount. Without the return step a
  // keyboard or screen-reader user is dropped at the top of the document when the
  // dialog closes, with no idea where they are.
  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => returnFocusRef.current?.focus?.();
  }, []);

  // Escape cancels, Tab cycles inside. Bound to the dialog rather than the document
  // so it cannot interfere with anything else on the page.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void cancel();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const status =
    busy === 'authenticating'
      ? 'Confirming this payment with your bank. Please wait.'
      : busy === 'cancelling'
        ? 'Cancelling this payment and releasing your reservation.'
        : problem ?? '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
      >
        <div className="flex items-start gap-3">
          {/* The tenant's own accent, same CSS var the brand button uses. */}
          <ShieldCheck
            className="mt-0.5 h-6 w-6 shrink-0 text-[var(--brand-color,#0f766e)]"
            aria-hidden
          />
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">
              Your bank needs to confirm this payment
            </h2>
            <p id={descriptionId} className="mt-2 text-sm text-slate-600">
              For your security, your bank asks for an extra check on some card
              payments. Confirm {formatUSD(amountCents)} to finish your booking — your
              reservation is held until you do.
            </p>
          </div>
        </div>

        {/*
          Polite, not assertive, and not role="alert": the guest is already looking
          at this dialog, so an interruption adds nothing, and an alert here would
          be indistinguishable from the checkout page's own failure banner.
        */}
        <p role="status" aria-live="polite" className="mt-4 min-h-[1.25rem] text-sm text-slate-700">
          {status}
        </p>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            ref={confirmRef}
            variant="brand"
            size="lg"
            className="w-full sm:flex-1"
            loading={busy === 'authenticating'}
            disabled={busy === 'cancelling'}
            onClick={authenticate}
          >
            Authenticate with your bank
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="w-full sm:flex-1"
            loading={busy === 'cancelling'}
            disabled={busy === 'authenticating'}
            onClick={cancel}
          >
            Cancel payment
          </Button>
        </div>

        <p className="mt-3 text-center text-xs text-slate-500">
          Cancelling releases your reservation and charges you nothing.
        </p>
      </div>
    </div>
  );
}
