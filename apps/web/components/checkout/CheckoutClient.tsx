'use client';

/**
 * Single-page checkout orchestrator.
 *
 * Owns the whole interactive checkout: the react-hook-form context (customer +
 * per-participant details + waiver), quantity, applied promo, and tip — and the
 * submit pipeline:
 *
 *   1. validate the form (react-hook-form, rules mirror @marina/core schemas)
 *   2. tokenize the card via Stripe Elements (PaymentSection)
 *   3. call the `placeOrder` server action (createBooking → submitPayment)
 *   4. redirect to /confirmation/[orderNumber]
 *
 * Mobile-first: a single stacked column on small screens; on large screens the
 * order summary / price / payment become a sticky right rail. All money is
 * integer cents and the displayed pricing uses @marina/core.
 *
 * Accessibility: each card is a labelled <section> with an <h2> (the page owns
 * the <h1>), a failed submit moves focus to an error summary that links to the
 * offending controls (WCAG 3.3.1/3.3.3), and asynchronous progress and failures
 * are announced through live regions rather than only appearing on screen.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FormProvider, useForm, type FieldErrors } from 'react-hook-form';
import { AlertTriangle } from 'lucide-react';
import { calculatePricing } from '@marina/core';
import { Button, Card, CardContent, CardHeader } from '@marina/ui';
import type { StripeConfig } from '@/app/checkout/stripe-config';
import type { WalletConfig } from '@/app/checkout/wallet-config';
import { placeOrder } from '@/app/checkout/actions';
import {
  clearRememberedGuest,
  loadRememberedGuest,
  saveRememberedGuest,
  type RememberedGuest,
} from '@/lib/guest';
import { OrderSummary } from './OrderSummary';
import { CustomerFields } from './CustomerFields';
import { GuestPrefillBanner } from './GuestPrefillBanner';
import { ParticipantFields } from './ParticipantFields';
import { WaiverSection } from './WaiverSection';
import { PromoField } from './PromoField';
import { TipSelector } from './TipSelector';
import { PriceBreakdown } from './PriceBreakdown';
import { WalletExpress } from './WalletExpress';
import { PaymentSection, type PaymentSectionHandle } from './PaymentSection';
import { ChallengeDialog, type ChallengeHandoff } from './ChallengeDialog';
import type {
  AppliedPromo,
  CheckoutFormValues,
  CheckoutSelection,
  ParticipantFormValue,
} from './types';

interface CheckoutClientProps {
  selection: CheckoutSelection;
  stripe: StripeConfig;
  /** Express-wallet (Apple/Google Pay) seam config — gated behind a flag. */
  wallet: WalletConfig;
  /** Operator (white-label) name for the waiver copy. */
  operatorName: string;
}

/**
 * A booking whose card needs the bank's second factor (3-D Secure / SCA).
 *
 * The order exists and the seats are held, but no money has moved and no Payment
 * row has been written — that happens when the guest answers the challenge. If
 * they back out instead, the dialog releases the order so nothing is left holding
 * capacity (docs/LOCAL-FIRST-BUILD.md §5).
 */
interface PendingChallenge {
  orderId: string;
  orderNumber: string;
  amountCents: number;
  handoff: ChallengeHandoff;
  /**
   * The details this checkout was submitted with, kept so "book again" still
   * remembers the guest once they come back from their bank. Deliberately the
   * shape `saveRememberedGuest` accepts, not a full `RememberedGuest` — the
   * timestamp on that record belongs to the moment the booking succeeds.
   */
  guest: Parameters<typeof saveRememberedGuest>[0];
}

function emptyParticipant(): ParticipantFormValue {
  return { driver_name: '', license: '', dob: '', experience: '' };
}

function makeParticipants(count: number): ParticipantFormValue[] {
  return Array.from({ length: count }, () => emptyParticipant());
}

/** One validation failure, in the order a sighted user meets it on the page. */
interface CheckoutErrorEntry {
  key: string;
  /** Human label for the control, so the summary reads without context. */
  label: string;
  message: string;
  /** DOM id to jump to. Absent when the control has no id to anchor at. */
  fieldId?: string;
}

/**
 * Flatten react-hook-form's nested error object into a linkable list.
 *
 * The ids here are the ones CustomerFields / ParticipantFields / WaiverSection
 * put on their inputs; a mismatch shows up as a summary entry that renders as
 * plain text instead of a link, which is why the id is optional rather than
 * assumed.
 */
function collectFieldErrors(errors: FieldErrors<CheckoutFormValues>): CheckoutErrorEntry[] {
  const out: CheckoutErrorEntry[] = [];
  const add = (key: string, label: string, message: unknown, fieldId?: string) => {
    if (typeof message === 'string' && message.length > 0) {
      out.push({ key, label, message, fieldId });
    }
  };

  add('firstName', 'First name', errors.firstName?.message, 'firstName');
  add('lastName', 'Last name', errors.lastName?.message, 'lastName');
  add('email', 'Email', errors.email?.message, 'email');
  add('phone', 'Phone', errors.phone?.message, 'phone');

  const participants = errors.participants;
  if (Array.isArray(participants)) {
    participants.forEach((participant, i) => {
      if (!participant) return;
      const who = `Driver ${i + 1}`;
      add(
        `participant-${i}-name`,
        `${who} — full name`,
        participant.driver_name?.message,
        `participant-${i}-name`,
      );
      add(
        `participant-${i}-license`,
        `${who} — driver license #`,
        participant.license?.message,
        `participant-${i}-license`,
      );
      add(
        `participant-${i}-dob`,
        `${who} — date of birth`,
        participant.dob?.message,
        `participant-${i}-dob`,
      );
    });
  }

  // The waiver acceptance checkbox has no id of its own, so this entry cannot
  // link anywhere yet — see docs/ACCESSIBILITY.md.
  add('waiverAccepted', 'Liability waiver', errors.waiverAccepted?.message);
  add('signatureName', 'Signature', errors.signatureName?.message, 'signatureName');

  return out;
}

/** A titled section card used down the main column. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader>
          {/* An <h2>, not the Card's default <h3>: the page heading is the <h1>
              and a skipped level breaks heading navigation (WCAG 1.3.1). */}
          <h2
            id={headingId}
            className="text-lg font-semibold leading-none tracking-tight"
          >
            {title}
          </h2>
          {description && <p className="text-sm text-slate-500">{description}</p>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  );
}

export function CheckoutClient({
  selection,
  stripe,
  wallet,
  operatorName,
}: CheckoutClientProps) {
  const router = useRouter();

  const [quantity, setQuantity] = useState(selection.quantity);
  const [promo, setPromo] = useState<AppliedPromo | null>(null);
  const [tipCents, setTipCents] = useState(0);
  // Nonce-carrying so a repeated identical failure still re-announces.
  const [submitError, setSubmitError] = useState<{ message: string; nonce: number } | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  // Bumped on every failed validation pass so focus returns to the summary even
  // when the same fields fail twice in a row.
  const [invalidCount, setInvalidCount] = useState(0);
  // Returning-guest ("book again") prefill, read from this device only.
  const [rememberedGuest, setRememberedGuest] = useState<RememberedGuest | null>(null);
  // Set when the bank asks for a second factor; drives the modal below.
  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);

  const paymentRef = useRef<PaymentSectionHandle>(null);
  // See the submit handler: the de-duplication key for this checkout attempt.
  const attemptKey = useRef<string | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  const summaryHeadingId = useId();
  const reservationHeadingId = useId();
  const tipHeadingId = useId();

  const methods = useForm<CheckoutFormValues>({
    mode: 'onTouched',
    // We move focus to the error summary instead of the first bad field, so the
    // guest hears everything that failed rather than only the first thing.
    shouldFocusError: false,
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      participants: makeParticipants(selection.quantity),
      promoCode: '',
      waiverAccepted: false,
      signatureName: '',
    },
  });

  const fieldErrors = collectFieldErrors(methods.formState.errors);
  const showErrorSummary = invalidCount > 0 && fieldErrors.length > 0;

  const fail = (message: string) =>
    setSubmitError((prev) => ({ message, nonce: (prev?.nonce ?? 0) + 1 }));

  // --- 3-D Secure outcomes -------------------------------------------------
  // The dialog owns the round trip to the API; these three handlers are what the
  // page does with each of its three possible endings.

  /**
   * Authenticated. The API settled the intent, wrote the Payment row and zeroed
   * the balance, so from here this is the ordinary success path — a challenged
   * booking must be indistinguishable from an unchallenged one.
   */
  const onChallengeAuthenticated = () => {
    if (!challenge) return;
    saveRememberedGuest(challenge.guest);
    setChallenge(null);
    router.push(`/confirmation?order=${encodeURIComponent(challenge.orderNumber)}`);
  };

  /** Backed out. The API released the order, so the guest can retry cleanly. */
  const onChallengeCancelled = () => {
    setChallenge(null);
    fail(
      'Your bank did not confirm the payment, so nothing was charged and your reservation was released. You can try again, or use another card.',
    );
  };

  /** The dialog could not complete at all — surface its own message verbatim. */
  const onChallengeFailed = (message: string) => {
    setChallenge(null);
    fail(message);
  };

  // Keep the participant field array sized to the chosen quantity, preserving any
  // already-entered values.
  const setQty = (next: number) => {
    setQuantity(next);
    const current = methods.getValues('participants') ?? [];
    if (next > current.length) {
      methods.setValue('participants', [
        ...current,
        ...makeParticipants(next - current.length),
      ]);
    } else if (next < current.length) {
      methods.setValue('participants', current.slice(0, next));
    }
  };

  // On mount, surface a remembered guest (if any) so a returning visitor can
  // one-tap prefill. Read after hydration to keep SSR/CSR markup identical.
  useEffect(() => {
    setRememberedGuest(loadRememberedGuest());
  }, []);

  // A failed validation pass is silent to a screen reader unless focus moves —
  // the guest would otherwise press "Complete booking" and hear nothing.
  useEffect(() => {
    if (invalidCount > 0) errorSummaryRef.current?.focus();
  }, [invalidCount]);

  // One-tap "book again": fill the lead-guest fields from the remembered guest.
  const applyRememberedGuest = () => {
    if (!rememberedGuest) return;
    methods.setValue('firstName', rememberedGuest.firstName, { shouldDirty: true });
    methods.setValue('lastName', rememberedGuest.lastName, { shouldDirty: true });
    methods.setValue('email', rememberedGuest.email, { shouldDirty: true });
    methods.setValue('phone', rememberedGuest.phone, { shouldDirty: true });
    setRememberedGuest(null); // banner dismisses once applied
  };

  // "Not you?" — forget the saved guest on this device.
  const forgetRememberedGuest = () => {
    clearRememberedGuest();
    setRememberedGuest(null);
  };

  // Base the tip presets on the post-discount subtotal (integer cents).
  const tipBaseCents = useMemo(() => {
    const { subtotalCents, discountCents } = calculatePricing({
      items: [{ unitPriceCents: selection.rate.priceCents, quantity }],
      fees: [],
      promo: promo
        ? { discountType: promo.discountType, discountValue: promo.discountValue }
        : null,
    });
    return subtotalCents - discountCents;
  }, [selection.rate.priceCents, quantity, promo]);

  const onInvalid = () => {
    setSubmitError(null);
    setInvalidCount((n) => n + 1);
  };

  const onSubmit = async (values: CheckoutFormValues) => {
    setSubmitError(null);
    setInvalidCount(0);

    if (!stripe.configured && !stripe.fakeMode) {
      fail(
        'Online payments are not configured for this site yet, so this booking cannot be completed online. Please contact us to finish your reservation.',
      );
      return;
    }

    setSubmitting(true);
    try {
      // Tokenize the card first — no order is created if the card is invalid.
      const tokenResult = await paymentRef.current?.tokenize();
      if (!tokenResult || !tokenResult.ok) {
        fail(tokenResult?.error ?? 'Please enter your card details.');
        return;
      }

      // One key per checkout attempt, created lazily and held for the life of this
      // component. A retry of the SAME attempt (the guest pressing again after a
      // timeout, or a transport-level retry) reuses it and resolves to the order
      // already created; a genuinely new attempt gets a new key.
      attemptKey.current ??=
        globalThis.crypto?.randomUUID?.() ?? `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const result = await placeOrder({
        idempotencyKey: attemptKey.current,
        activityId: selection.activityId,
        rateId: selection.rate.id,
        timeslotId: selection.timeslotId,
        quantity,
        customer: {
          first_name: values.firstName.trim(),
          last_name: values.lastName.trim(),
          email: values.email.trim(),
          phone: values.phone.trim() || undefined,
        },
        participants: values.participants.map((p) => ({
          driver_name: p.driver_name.trim(),
          license: p.license.trim() || undefined,
          dob: p.dob || undefined,
          experience: p.experience || undefined,
        })),
        promoCode: promo?.code,
        tipCents: tipCents > 0 ? tipCents : undefined,
        paymentSourceId: tokenResult.sourceId,
        isReturningGuest: false,
      });

      if (!result.ok) {
        // Retire the key. The idempotency key de-duplicates ONE attempt (a
        // double-click, a transport retry); a guest who reads "your card was
        // declined" and tries again is making a NEW attempt. The API releases the
        // declined order and its seat, so reusing the key here would replay straight
        // back into that cancelled booking instead of creating a live one.
        attemptKey.current = null;
        fail(result.error);
        return;
      }

      const guest: PendingChallenge['guest'] = {
        firstName: values.firstName,
        lastName: values.lastName,
        email: values.email,
        phone: values.phone,
      };

      // The bank wants a second factor. This is NOT a decline: the order is real,
      // the seats are held, and the guest is one confirmation away from booked.
      // Show the challenge instead of the confirmation page and let the dialog
      // finish (or release) the payment.
      if (result.payment.status === 'REQUIRES_ACTION') {
        setChallenge({
          orderId: result.order.id,
          orderNumber: result.order.orderNumber,
          amountCents: result.payment.amountCents,
          handoff: {
            // The charge response names its own driver, but the checkout action
            // narrows that response to `PaymentResult` before we see it, so the
            // provider is inferred from whether a real Stripe key is configured.
            // Widening `submitPayment` in lib/orders.ts to pass `authentication`
            // through would make this exact — and would also supply the client
            // secret Stripe.js needs in cloud mode.
            provider: stripe.configured ? 'stripe' : 'sandbox',
            intentId: result.payment.paymentId || null,
            clientSecret: null,
            publishableKey: stripe.publishableKey,
          },
          guest,
        });
        return;
      }

      // Remember this guest (this device only) so their next booking is one-tap.
      saveRememberedGuest(guest);

      router.push(`/confirmation?order=${encodeURIComponent(result.order.orderNumber)}`);
    } catch {
      fail('Something went wrong completing your booking. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSubmit, onInvalid)} noValidate>
        {/*
          Error summary. Focused (not role="alert") after a failed submit: moving
          focus here reads the whole list once, and every entry is a link to the
          control that needs fixing — one thumb-tap away on a phone.
        */}
        {showErrorSummary && (
          <div
            ref={errorSummaryRef}
            tabIndex={-1}
            aria-labelledby={summaryHeadingId}
            className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
          >
            <h2
              id={summaryHeadingId}
              className="flex items-center gap-2 text-sm font-semibold text-red-800"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {fieldErrors.length === 1
                ? 'There is 1 problem with your booking details'
                : `There are ${fieldErrors.length} problems with your booking details`}
            </h2>
            <ul className="mt-2 space-y-1 text-sm text-red-800">
              {fieldErrors.map((entry) => (
                <li key={entry.key}>
                  {entry.fieldId ? (
                    <a href={`#${entry.fieldId}`} className="rounded underline">
                      {entry.label}: {entry.message}
                    </a>
                  ) : (
                    <span>
                      {entry.label}: {entry.message}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_22rem]">
          {/* Main column ----------------------------------------------------- */}
          <div className="order-2 space-y-6 lg:order-1">
            <Section
              title="Guest details"
              description="No account needed — book as a guest. We'll send your confirmation and receipt to this email."
            >
              {rememberedGuest && (
                <div className="mb-4">
                  <GuestPrefillBanner
                    guest={rememberedGuest}
                    onUse={applyRememberedGuest}
                    onDismiss={forgetRememberedGuest}
                  />
                </div>
              )}
              <CustomerFields />
            </Section>

            <Section
              title="Driver information"
              description="Each driver must provide their details."
            >
              <ParticipantFields count={quantity} />
            </Section>

            {selection.waiverRequired && (
              <Section title="Liability waiver">
                <WaiverSection
                  operatorName={operatorName}
                  activityName={selection.activityName}
                />
              </Section>
            )}

            <Section title="Payment" description="Secure card payment.">
              {/* Express-wallet seam (Apple/Google Pay). Renders nothing unless
                  NEXT_PUBLIC_ENABLE_WALLET_PAY is on; onExpressPay left unwired
                  until a real PaymentRequest integration is added. */}
              {wallet.enabled && (
                <div className="mb-4">
                  <WalletExpress enabled={wallet.enabled} />
                </div>
              )}
              <PaymentSection ref={paymentRef} stripe={stripe} />
            </Section>
          </div>

          {/* Sticky summary rail -------------------------------------------- */}
          <div className="order-1 lg:order-2">
            <div className="space-y-4 lg:sticky lg:top-20">
              <section aria-labelledby={reservationHeadingId}>
                <Card>
                  <CardHeader>
                    <h2
                      id={reservationHeadingId}
                      className="text-lg font-semibold leading-none tracking-tight"
                    >
                      Your reservation
                    </h2>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <OrderSummary
                      selection={selection}
                      quantity={quantity}
                      onQuantityChange={setQty}
                    />

                    <div className="border-t border-slate-200 pt-4">
                      <PromoField
                        activityId={selection.activityId}
                        applied={promo}
                        onApply={setPromo}
                        onClear={() => setPromo(null)}
                      />
                    </div>

                    {/* The tip presets are a set of related toggles; grouping
                        them under the visible label gives each button context
                        when a screen reader reaches it out of order. */}
                    <div
                      role="group"
                      aria-labelledby={tipHeadingId}
                      className="border-t border-slate-200 pt-4"
                    >
                      <p
                        id={tipHeadingId}
                        className="mb-3 text-sm font-medium text-slate-700"
                      >
                        Add a tip
                      </p>
                      <TipSelector
                        baseCents={tipBaseCents}
                        tipCents={tipCents}
                        onChange={setTipCents}
                      />
                    </div>

                    <div className="border-t border-slate-200 pt-4">
                      <PriceBreakdown
                        unitPriceCents={selection.rate.priceCents}
                        quantity={quantity}
                        promo={promo}
                        tipCents={tipCents}
                      />
                    </div>
                  </CardContent>
                </Card>
              </section>

              {submitError && (
                <div
                  role="alert"
                  // Named so it is addressable on its own. Without a name this is
                  // just one of several alerts on the page (every invalid field
                  // renders one), and "the payment failed" becomes indistinguishable
                  // from "the form is incomplete" to a screen reader and to a test.
                  aria-label="Payment problem"
                  className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{submitError.message}</span>
                </div>
              )}

              <Button
                type="submit"
                variant="brand"
                size="lg"
                className="w-full"
                loading={submitting}
                disabled={!stripe.configured && !stripe.fakeMode}
              >
                {submitting ? 'Processing…' : 'Complete booking'}
              </Button>

              {/*
                Payment can take several seconds on rural cell service. A polite
                live region turns that dead time into something audible instead
                of a button that silently stops responding.
              */}
              <p role="status" className="sr-only">
                {submitting ? 'Processing your booking. Please wait.' : ''}
              </p>

              <p className="text-center text-xs text-slate-500">
                By completing this booking you agree to the terms and any
                applicable cancellation policy.
              </p>
            </div>
          </div>
        </div>

        {/*
          Rendered inside the form (its controls are `type="button"`, so nothing
          here can submit it) and mounted only while a challenge is outstanding —
          keying off `challenge` means every open starts with fresh state and the
          focus-restore effect runs at the right moments.
        */}
        {challenge && (
          <ChallengeDialog
            orderId={challenge.orderId}
            amountCents={challenge.amountCents}
            handoff={challenge.handoff}
            onAuthenticated={onChallengeAuthenticated}
            onCancelled={onChallengeCancelled}
            onFailed={onChallengeFailed}
          />
        )}
      </form>
    </FormProvider>
  );
}
