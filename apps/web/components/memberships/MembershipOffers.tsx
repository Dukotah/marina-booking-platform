'use client';

import { useId, useRef, useState } from 'react';
import { Check, ShieldCheck, Ticket } from 'lucide-react';
import { formatUSD } from '@/lib/format';
import { saveRememberedGuest, loadRememberedGuest } from '@/lib/guest';
import { PaymentSection, type PaymentSectionHandle } from '@/components/checkout/PaymentSection';
import type { StripeConfig } from '@/app/checkout/stripe-config';
import {
  authenticateMembershipPaymentAction,
  purchaseMembershipAction,
} from './actions';
import type { MembershipChallenge, MembershipHolding, MembershipOffer } from './types';

/**
 * The membership storefront: what is on sale, and the flow that buys one.
 *
 * REUSE, NOT A SECOND CHECKOUT. The card field is the checkout's own
 * `PaymentSection` (Stripe Elements, or the dev fake-payments panel when no key is
 * configured), driven through the same imperative `tokenize()` handle, and the
 * per-attempt idempotency key is generated and retired exactly as CheckoutClient
 * does it. The one deliberate difference is that a membership is bought in a single
 * API call rather than create-then-charge: a membership sale has no seats to hold,
 * so charging and issuing belong in one transaction that either happens or does not.
 *
 * Accessibility notes:
 *   - The offers are a real list; each card's Buy button is a disclosure
 *     (`aria-expanded` / `aria-controls`) rather than a modal, so there is no focus
 *     trap to get wrong and Escape has nothing to swallow.
 *   - Opening a form moves focus to its heading; completing a purchase moves focus
 *     to the receipt. A keyboard user is never left where the content used to be.
 *   - Every input has a bound <label>, invalid fields get `aria-invalid` plus an
 *     `aria-describedby` error, and the form-level outcome is a live region.
 *   - The primary button is `bg-brand`, whose foreground is the derived
 *     `--brand-foreground` — never a hardcoded white on an operator-chosen color.
 */
export function MembershipOffers({
  offers,
  stripe,
}: {
  offers: MembershipOffer[];
  stripe: StripeConfig;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {offers.map((offer) => (
        <li key={offer.id} className="flex">
          <OfferCard
            offer={offer}
            stripe={stripe}
            open={openId === offer.id}
            onOpen={() => setOpenId(offer.id)}
            onClose={() => setOpenId((current) => (current === offer.id ? null : current))}
          />
        </li>
      ))}
    </ul>
  );
}

/** "10 launches" / "Unlimited use". */
function usesLine(offer: MembershipOffer): string {
  if (offer.kind === 'PUNCH_CARD') {
    const n = offer.totalUses ?? 0;
    return `${n} ${n === 1 ? 'launch' : 'launches'}`;
  }
  return 'Unlimited use';
}

/** "Good for 90 days" / "Never expires". */
function validityLine(offer: MembershipOffer): string {
  if (offer.durationDays == null) return 'Never expires';
  if (offer.durationDays % 365 === 0) {
    const years = offer.durationDays / 365;
    return years === 1 ? 'Good for 1 year' : `Good for ${years} years`;
  }
  return `Good for ${offer.durationDays} days`;
}

function kindLine(kind: MembershipOffer['kind']): string {
  return kind === 'SEASON_PASS' ? 'Season pass' : kind === 'PUNCH_CARD' ? 'Punch card' : 'Member rate';
}

type Phase = 'form' | 'challenge' | 'done';

interface FieldErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
}

function OfferCard({
  offer,
  stripe,
  open,
  onOpen,
  onClose,
}: {
  offer: MembershipOffer;
  stripe: StripeConfig;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const uid = useId();
  const panelId = `${uid}-panel`;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const receiptRef = useRef<HTMLDivElement>(null);
  const paymentRef = useRef<PaymentSectionHandle>(null);
  /** One key per attempt, retired on a real failure — see CheckoutClient. */
  const attemptKey = useRef<string | null>(null);
  /** The tokenized card from THIS attempt, reused when finishing a 3DS challenge. */
  const sourceId = useRef<string | null>(null);

  /*
   * Prefill from the guest-checkout "remember me" cache, so a returning customer
   * is not retyping what they typed when they booked. Lazy initialisers, so the
   * read happens once on mount rather than on every render, and SSR-safe because
   * loadRememberedGuest guards on `window` and returns null on the server. The
   * purchase panel is closed on the server render, so the inputs do not exist in
   * the SSR HTML and there is nothing for hydration to disagree about.
   */
  const [firstName, setFirstName] = useState(() => loadRememberedGuest()?.firstName ?? '');
  const [lastName, setLastName] = useState(() => loadRememberedGuest()?.lastName ?? '');
  const [email, setEmail] = useState(() => loadRememberedGuest()?.email ?? '');
  const [phone, setPhone] = useState(() => loadRememberedGuest()?.phone ?? '');

  const [phase, setPhase] = useState<Phase>('form');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [challenge, setChallenge] = useState<MembershipChallenge | null>(null);
  const [holding, setHolding] = useState<MembershipHolding | null>(null);

  const paymentUsable = stripe.configured || stripe.fakeMode;

  const openPanel = () => {
    onOpen();
    // The heading is focusable-by-script only (tabIndex -1), so focus lands on the
    // new content without adding a stop to the tab order.
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!firstName.trim()) errors.firstName = 'Enter your first name.';
    if (!lastName.trim()) errors.lastName = 'Enter your last name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Enter a valid email address.';
    return errors;
  };

  /** Send the purchase with the current attempt key + tokenized card. */
  const submitPurchase = async (source: string) => {
    attemptKey.current ??=
      globalThis.crypto?.randomUUID?.() ?? `mbr-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const result = await purchaseMembershipAction({
      membershipId: offer.id,
      idempotencyKey: attemptKey.current,
      paymentSourceId: source,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      phone: phone.trim() || undefined,
    });

    if (result.ok) {
      saveRememberedGuest({ firstName, lastName, email, phone });
      setHolding(result.holding);
      setChallenge(null);
      setPhase('done');
      requestAnimationFrame(() => receiptRef.current?.focus());
      return;
    }

    if (result.code === 'REQUIRES_ACTION' && result.challenge) {
      // Nothing was sold and nothing was charged: the transaction rolled back the
      // moment the bank asked its question. Keep the key — finishing the challenge
      // and re-submitting with it is what completes this same attempt.
      setChallenge(result.challenge);
      setPhase('challenge');
      setProblem(null);
      return;
    }

    /*
     * A failure. Whether the key survives is the whole question.
     *
     * A settled failure (a decline, a validation error) retires it: the guest who
     * reads "declined" and reaches for another card is making a NEW attempt, and
     * reusing the key would only replay the decline.
     *
     * An INDETERMINATE failure — the request never came back, or the processor
     * timed out having possibly taken the money — keeps it. Retrying under the same
     * key replays whatever actually happened: the succeeded charge completes the
     * purchase, and a charge that never landed is simply made now. Retiring the key
     * here is the one move that can charge a guest twice, which is precisely the
     * case docs/LOCAL-FIRST-BUILD.md §5 exists for.
     */
    if (!result.indeterminate) {
      attemptKey.current = null;
      sourceId.current = null;
    }
    setProblem(
      result.indeterminate
        ? `${result.error} If you were charged, trying again will not charge you twice.`
        : result.error,
    );
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setProblem(null);

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    if (!paymentUsable) {
      setProblem(
        'Online payments are not set up for this site yet, so this membership cannot be bought online. Please contact us.',
      );
      return;
    }

    setBusy(true);
    try {
      /*
       * Re-use the card token when this is a retry of the SAME attempt (the key
       * survived an indeterminate failure). Tokenizing again would hand the
       * processor a different payment method under an idempotency key it has
       * already seen, which Stripe rejects outright as "same key, different
       * parameters" — turning a safe retry into a dead end.
       */
      let source = sourceId.current;
      if (!source) {
        const token = await paymentRef.current?.tokenize();
        if (!token || !token.ok) {
          setProblem(token?.error ?? 'Please enter your card details.');
          return;
        }
        source = token.sourceId;
        sourceId.current = source;
      }
      await submitPurchase(source);
    } finally {
      setBusy(false);
    }
  };

  /** Finish the bank's check, then complete the same attempt. */
  const onAuthenticate = async () => {
    if (busy || !challenge) return;
    setBusy(true);
    setProblem(null);
    try {
      // Cloud mode runs the issuer's own challenge in the browser first. In a local
      // sandbox run there is no bank to hand off to — the simulator answers when the
      // API asks it — so this is skipped entirely.
      if (stripe.configured && challenge.clientSecret && stripe.publishableKey) {
        const { loadStripe } = await import('@stripe/stripe-js');
        const js = await loadStripe(stripe.publishableKey);
        if (!js) {
          setProblem('We could not load the secure payment check. Please try again.');
          return;
        }
        const { error } = await js.handleNextAction({ clientSecret: challenge.clientSecret });
        if (error) {
          setProblem(error.message ?? 'Your bank could not confirm this payment.');
          return;
        }
      }

      const settled = await authenticateMembershipPaymentAction(
        offer.id,
        challenge.intentId ?? '',
      );
      if (!settled.ok) {
        setProblem(settled.error ?? 'Your bank could not confirm this payment.');
        return;
      }
      if (!sourceId.current) {
        setProblem('We lost track of your card details. Please start again.');
        return;
      }
      await submitPurchase(sourceId.current);
    } finally {
      setBusy(false);
    }
  };

  const abandonChallenge = () => {
    // Nothing to release — no order, no seats, no charge. Retire the key so the next
    // try is a clean attempt.
    attemptKey.current = null;
    sourceId.current = null;
    setChallenge(null);
    setPhase('form');
    setProblem('That payment was not completed. You have not been charged.');
  };

  return (
    <div className="flex w-full flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {kindLine(offer.kind)}
          </p>
          <h3 className="mt-1 text-lg font-bold text-slate-900">{offer.name}</h3>
        </div>
        <Ticket className="h-6 w-6 shrink-0 text-brand" aria-hidden />
      </div>

      <p className="mt-3 text-2xl font-bold text-slate-900">
        {offer.priceCents === 0 ? 'Free' : formatUSD(offer.priceCents)}
      </p>

      <ul className="mt-3 space-y-1.5 text-sm text-slate-700">
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
          {offer.benefit}
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
          {usesLine(offer)}
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
          {validityLine(offer)}
        </li>
      </ul>

      <div className="mt-5">
        {open ? (
          <button
            type="button"
            onClick={onClose}
            aria-expanded
            aria-controls={panelId}
            className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-700 focus:ring-offset-2"
          >
            Close
          </button>
        ) : (
          <button
            type="button"
            onClick={openPanel}
            aria-expanded={false}
            aria-controls={panelId}
            className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
          >
            Buy {offer.name}
          </button>
        )}
      </div>

      {/*
        The panel element always exists, even while collapsed, so the Buy button's
        aria-controls always resolves to something real — an aria-controls pointing
        at an absent id is exactly the kind of thing an automated audit flags.
      */}
      <div id={panelId} className={open ? 'mt-5 border-t border-slate-200 pt-5' : undefined}>
        {open ? (
          phase === 'done' && holding ? (
            <div
              ref={receiptRef}
              tabIndex={-1}
              role="status"
              className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 focus:outline-none focus:ring-2 focus:ring-emerald-700"
            >
              <h4 className="text-sm font-semibold text-emerald-900">
                {holding.membershipName} is yours
              </h4>
              <p className="mt-1 text-sm text-emerald-900">
                {holding.remainingUses != null
                  ? `${holding.remainingUses} ${holding.remainingUses === 1 ? 'launch' : 'launches'} ready to use. `
                  : ''}
                {holding.expiresAt
                  ? `Valid until ${new Date(holding.expiresAt).toLocaleDateString()}. `
                  : 'It never expires. '}
                Your member price is applied automatically when you book with{' '}
                <span className="font-medium">{email.trim()}</span>.
              </p>
            </div>
          ) : phase === 'challenge' ? (
            <div className="rounded-lg border border-slate-300 bg-slate-50 p-4">
              <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <ShieldCheck className="h-4 w-4" aria-hidden />
                Your bank needs to confirm this
              </h4>
              <p className="mt-1 text-sm text-slate-700">
                You have not been charged yet. Confirm with your bank to finish buying{' '}
                {offer.name}.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onAuthenticate}
                  disabled={busy}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2 disabled:opacity-70"
                >
                  {busy ? 'Confirming…' : 'Confirm with my bank'}
                </button>
                <button
                  type="button"
                  onClick={abandonChallenge}
                  disabled={busy}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white focus:outline-none focus:ring-2 focus:ring-slate-700 focus:ring-offset-2 disabled:opacity-70"
                >
                  Cancel
                </button>
              </div>
              <div aria-live="polite" className="mt-2 min-h-[1.25rem]">
                {problem ? (
                  <p role="alert" className="text-sm text-red-700">
                    {problem}
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <form onSubmit={onSubmit} noValidate>
              <h4
                ref={headingRef}
                tabIndex={-1}
                className="text-sm font-semibold text-slate-900 focus:outline-none"
              >
                Buy {offer.name}
              </h4>

              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field
                  id={`${uid}-first`}
                  label="First name"
                  value={firstName}
                  onChange={setFirstName}
                  autoComplete="given-name"
                  error={fieldErrors.firstName}
                />
                <Field
                  id={`${uid}-last`}
                  label="Last name"
                  value={lastName}
                  onChange={setLastName}
                  autoComplete="family-name"
                  error={fieldErrors.lastName}
                />
                <div className="sm:col-span-2">
                  <Field
                    id={`${uid}-email`}
                    label="Email"
                    type="email"
                    value={email}
                    onChange={setEmail}
                    autoComplete="email"
                    error={fieldErrors.email}
                    hint="Your member price is applied to bookings made with this address."
                  />
                </div>
                <div className="sm:col-span-2">
                  <Field
                    id={`${uid}-phone`}
                    label="Phone (optional)"
                    type="tel"
                    value={phone}
                    onChange={setPhone}
                    autoComplete="tel"
                    required={false}
                  />
                </div>
              </div>

              <div className="mt-4">
                <PaymentSection ref={paymentRef} stripe={stripe} />
              </div>

              <div className="mt-4 flex items-baseline justify-between text-sm">
                <span className="text-slate-700">Total today</span>
                <span className="text-base font-bold text-slate-900">
                  {offer.priceCents === 0 ? 'Free' : formatUSD(offer.priceCents)}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-600">
                Tax and fees, if your operator charges them, are added at checkout.
              </p>

              <button
                type="submit"
                disabled={busy}
                className="mt-4 w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2 disabled:opacity-70"
              >
                {busy ? 'Working…' : `Buy for ${offer.priceCents === 0 ? 'free' : formatUSD(offer.priceCents)}`}
              </button>

              <div aria-live="polite" className="mt-3 min-h-[1.25rem]">
                {problem ? (
                  <p role="alert" className="text-sm text-red-700">
                    {problem}
                  </p>
                ) : null}
              </div>
            </form>
          )
        ) : null}
      </div>
    </div>
  );
}

/**
 * A labelled text input with an announced error.
 *
 * `aria-invalid` plus `aria-describedby` pointing at the message is what makes a
 * screen reader read the problem when focus lands on the field — a red border
 * alone tells a sighted mouse user and nobody else.
 */
function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  error,
  hint,
  required = true,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  error?: string;
  hint?: string;
  required?: boolean;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 w-full rounded-md border px-3 py-2 text-sm text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900 ${
          error ? 'border-red-600' : 'border-slate-300'
        }`}
      />
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-slate-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
