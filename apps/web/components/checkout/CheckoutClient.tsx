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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FormProvider, useForm, type FieldErrors } from 'react-hook-form';
import { AlertTriangle } from 'lucide-react';
import { calculatePricing, formatUSD } from '@marina/core';
import { Button, Card, CardContent, CardHeader } from '@marina/ui';
import type { StripeConfig } from '@/app/checkout/stripe-config';
import type { PaymentMode } from '@/app/checkout/payment-mode';
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
  /**
   * How this site takes payment: 'card' collects a card online and charges it now;
   * 'reserve' holds the spot with nothing charged online and the full amount left as
   * balance due, paid on arrival at the marina.
   */
  paymentMode: PaymentMode;
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

  add(
    'waiverAccepted',
    'Liability waiver',
    errors.waiverAccepted?.message,
    'waiverAccepted',
  );
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
      {/* Estate surface card: radius 14, hairline + the one soft shadow. */}
      <Card className="rounded-card border-hairline bg-surface shadow-card">
        <CardHeader>
          {/* An <h2>, not the Card's default <h3>: the page heading is the <h1>
              and a skipped level breaks heading navigation (WCAG 1.3.1). */}
          <h2
            id={headingId}
            className="font-display text-[19px] leading-tight tracking-[0.02em] text-ink"
          >
            {title}
          </h2>
          {description && <p className="text-sm text-muted">{description}</p>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  );
}

export function CheckoutClient({
  selection,
  stripe,
  paymentMode,
  wallet,
  operatorName,
}: CheckoutClientProps) {
  const router = useRouter();
  // Reserve mode: hold the spot online, collect the balance at the marina — no
  // card is taken here and submitPayment is never called.
  const reserveMode = paymentMode === 'reserve';

  const [quantity, setQuantity] = useState(selection.quantity);
  const [promo, setPromo] = useState<AppliedPromo | null>(null);
  const [tipCents, setTipCents] = useState(0);
  // Nonce-carrying so a repeated identical failure still re-announces.
  const [submitError, setSubmitError] = useState<{ message: string; nonce: number } | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  /*
   * What the last failed submit found — a snapshot, taken in `onInvalid` from the
   * errors react-hook-form hands us, not derived from `formState` on every render.
   *
   * Two reasons. It is committed in the same render as the failure, so the summary
   * is in the DOM the moment there is something to focus (deriving it from
   * `formState` meant the panel appeared a render later than the state that was
   * supposed to trigger the focus move — the bug in docs/ACCESSIBILITY.md finding
   * F). And because the summary is a live region (below), a derived list would
   * re-announce "there are 4 problems… 3 problems…" on every keystroke that
   * changed a field's validity. A summary is a report on a submission, so it
   * changes when a submission does. `attempt` distinguishes two failures with
   * identical contents.
   */
  const [errorSummary, setErrorSummary] = useState<{
    entries: CheckoutErrorEntry[];
    attempt: number;
  } | null>(null);
  // Returning-guest ("book again") prefill, read from this device only.
  const [rememberedGuest, setRememberedGuest] = useState<RememberedGuest | null>(null);
  // Set when the bank asks for a second factor; drives the modal below.
  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);

  const paymentRef = useRef<PaymentSectionHandle>(null);
  // See the submit handler: the de-duplication key for this checkout attempt.
  const attemptKey = useRef<string | null>(null);

  /*
   * Move focus to the error summary the instant it exists.
   *
   * A callback ref, not an effect: an effect keyed on a failure counter runs on
   * the render where the counter changed, which is not necessarily the render
   * where the summary mounted — that is exactly how the previous version focused
   * `null` and left the guest on "Complete booking" with no idea the submit had
   * been rejected. A ref callback cannot fire early, because it is handed the
   * node. `useCallback` with no dependencies keeps its identity stable so React
   * only calls it on mount/unmount; the panel is keyed on the attempt number, so
   * a second failed submit remounts it and re-runs this.
   */
  const focusErrorSummary = useCallback((node: HTMLDivElement | null) => {
    node?.focus();
  }, []);

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

  const summaryEntries = errorSummary?.entries ?? [];
  const showErrorSummary = summaryEntries.length > 0;

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

  // The amount the guest will owe at the marina in reserve mode. The API supplies
  // the operator's fees (tax + processing + surcharges) with the selection, so this
  // runs the SAME `calculatePricing` the booking runs and matches the confirmation
  // total to the cent — this figure is what the submit button commits the guest to.
  const reserveDueCents = useMemo(() => {
    const { totalCents } = calculatePricing({
      items: [{ unitPriceCents: selection.rate.priceCents, quantity }],
      fees: selection.fees,
      promo: promo
        ? { discountType: promo.discountType, discountValue: promo.discountValue }
        : null,
      tipCents,
    });
    return totalCents;
  }, [selection.rate.priceCents, selection.fees, quantity, promo, tipCents]);

  // A failed validation pass is silent to a screen reader unless something moves
  // focus — the guest would otherwise press "Complete booking" and hear nothing.
  // The errors are taken from the argument rather than read back off `formState`
  // so the summary and the focus move land in the same commit.
  const onInvalid = (errors: FieldErrors<CheckoutFormValues>) => {
    setSubmitError(null);
    setErrorSummary((prev) => ({
      entries: collectFieldErrors(errors),
      attempt: (prev?.attempt ?? 0) + 1,
    }));
  };

  const onSubmit = async (values: CheckoutFormValues) => {
    setSubmitError(null);
    setErrorSummary(null);

    // Reserve mode takes no card online — the balance is collected at the marina —
    // so the "payments not configured" guard only applies to the card path.
    if (!reserveMode && !stripe.configured && !stripe.fakeMode) {
      fail(
        'Online payments are not configured for this site yet, so this booking cannot be completed online. Please contact us to finish your reservation.',
      );
      return;
    }

    setSubmitting(true);
    try {
      // Card path: tokenize first — no order is created if the card is invalid.
      // Reserve path: no card is entered, so there is nothing to tokenize.
      let paymentSourceId: string | undefined;
      if (!reserveMode) {
        const tokenResult = await paymentRef.current?.tokenize();
        if (!tokenResult || !tokenResult.ok) {
          fail(tokenResult?.error ?? 'Please enter your card details.');
          return;
        }
        paymentSourceId = tokenResult.sourceId;
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
        // Forward the inline waiver signature so the API records it (and doesn't
        // store waiverSignedAt: null on a booking the guest actually signed). Only
        // sent when this activity required a waiver and the guest accepted + signed.
        waiverAcceptance:
          selection.waiverRequired && values.waiverAccepted && values.signatureName.trim()
            ? {
                accepted: values.waiverAccepted,
                signatureName: values.signatureName.trim(),
              }
            : undefined,
        promoCode: promo?.code,
        tipCents: tipCents > 0 ? tipCents : undefined,
        // Reserve mode leaves paymentSourceId undefined; the action then skips the
        // charge and the order keeps its full balance due for on-arrival payment.
        paymentSourceId,
        reserve: reserveMode,
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
            // The charge response names its own driver and carries the challenge
            // affordance (`authentication`, passed through by lib/orders.ts) —
            // including the client secret Stripe.js needs in cloud mode. The
            // pre-seam inference from the configured key remains as a fallback.
            provider:
              result.payment.authentication?.provider ??
              (stripe.configured ? 'stripe' : 'sandbox'),
            intentId:
              result.payment.authentication?.intentId ?? (result.payment.paymentId || null),
            clientSecret: result.payment.authentication?.clientSecret ?? null,
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

  const submitLabel = submitting
    ? reserveMode
      ? 'Reserving…'
      : 'Processing…'
    : reserveMode
      ? 'Reserve my spot'
      : 'Complete booking';
  const submitDisabled = !reserveMode && !stripe.configured && !stripe.fakeMode;

  return (
    <FormProvider {...methods}>
      {/*
        The primary submit lives in the summary rail, which on a phone sits BELOW
        the four sections of fields a guest has to fill (the rail is `order-2` so the
        guest-details form leads). Either way the submit is a long scroll from
        wherever the guest is finishing a field, so this mobile-only bar keeps the
        action pinned to the bottom of the screen the whole way down — one-handed, no
        scroll-hunting. Hidden from `lg` up, where the rail is already sticky and
        beside the form. The `pb` on the form clears the bar so it never covers the
        last field.
      */}
      <form
        onSubmit={methods.handleSubmit(onSubmit, onInvalid)}
        noValidate
        className="pb-24 lg:pb-0"
      >
        {/*
          Error summary — the only thing that tells a non-sighted guest the submit
          was rejected at all. Two mechanisms, deliberately, because neither
          covers the whole case on its own:

          1. Focus moves to the panel, which reads the heading and the whole list
             once and puts the guest one Tab from the first offending control.
          2. The wrapper is a polite live region that is present from FIRST
             render. A live region created in the same mutation as its content is
             routinely not announced, and the panel is not a `role="alert"`
             because an alert that is also focused gets read twice. Keying the
             panel on the attempt number makes a second failed submit a real DOM
             change inside a region that already existed, so an identical repeat
             failure still speaks instead of appearing to do nothing.

          Every entry is a link to the control that needs fixing — one thumb-tap
          away on a phone, including the waiver checkbox.
        */}
        <div aria-live="polite">
          {showErrorSummary && (
            <div
              key={errorSummary?.attempt}
              ref={focusErrorSummary}
              tabIndex={-1}
              aria-labelledby={summaryHeadingId}
              className="mb-6 rounded-lg border border-danger bg-surface p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2"
            >
              <h2
                id={summaryHeadingId}
                className="flex items-center gap-2 text-sm font-semibold text-danger"
              >
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                {summaryEntries.length === 1
                  ? 'There is 1 problem with your booking details'
                  : `There are ${summaryEntries.length} problems with your booking details`}
              </h2>
              <ul className="mt-2 space-y-1 text-sm text-danger">
                {summaryEntries.map((entry) => (
                  <li key={entry.key}>
                    {entry.fieldId ? (
                      /*
                        A plain in-page link, so the guest lands ON the control
                        rather than merely scrolled near it: every id linked here
                        belongs to a focusable input, and following a fragment to
                        a focusable element gives it focus.
                      */
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
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_22rem]">
          {/* Main column ----------------------------------------------------- */}
          {/*
            On a phone the guest just tapped "Continue to checkout" having already
            chosen the boat, date, time, and party size — so the reservation
            summary is a recap, not the next action. Put the guest-details fields
            FIRST (order-1) so name/email are in view immediately instead of ~1400px
            below the summary rail; the recap follows (order-2). On lg+ the two-column
            layout is unchanged (form left, sticky rail right).
          */}
          <div className="order-1 space-y-6 lg:order-1">
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

            <Section
              title={reserveMode ? 'Reservation' : 'Payment'}
              description={
                reserveMode ? 'Pay when you arrive at the marina.' : 'Secure card payment.'
              }
            >
              {/* Express-wallet seam (Apple/Google Pay). Renders nothing unless
                  NEXT_PUBLIC_ENABLE_WALLET_PAY is on; onExpressPay left unwired
                  until a real PaymentRequest integration is added. Card path only. */}
              {!reserveMode && wallet.enabled && (
                <div className="mb-4">
                  <WalletExpress enabled={wallet.enabled} />
                </div>
              )}
              <PaymentSection
                ref={paymentRef}
                stripe={stripe}
                reserveMode={reserveMode}
                dueAtMarinaCents={reserveDueCents}
              />
            </Section>
          </div>

          {/* Sticky summary rail -------------------------------------------- */}
          <div className="order-2 lg:order-2">
            <div className="space-y-4 lg:sticky lg:top-20">
              <section aria-labelledby={reservationHeadingId}>
                {/* The reservation card — the Estate signature surface on this
                    screen: it fills in as the guest types and flips into the
                    confirmation. */}
                <Card className="rounded-card border-hairline bg-surface shadow-card">
                  <CardHeader>
                    <h2
                      id={reservationHeadingId}
                      className="font-display text-[19px] leading-tight tracking-[0.02em] text-ink"
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

                    <div className="border-t border-hairline pt-4">
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
                      className="border-t border-hairline pt-4"
                    >
                      <p
                        id={tipHeadingId}
                        className="mb-3 text-sm font-medium text-ink"
                      >
                        Add a tip
                      </p>
                      <TipSelector
                        baseCents={tipBaseCents}
                        tipCents={tipCents}
                        onChange={setTipCents}
                      />
                    </div>

                    <div className="border-t border-hairline pt-4">
                      <PriceBreakdown
                        unitPriceCents={selection.rate.priceCents}
                        quantity={quantity}
                        promo={promo}
                        tipCents={tipCents}
                        fees={selection.fees}
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
                  className="flex items-start gap-2 rounded-lg border border-danger bg-surface p-3 text-sm text-danger"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{submitError.message}</span>
                </div>
              )}

              <Button
                type="submit"
                variant="brand"
                size="lg"
                className="w-full rounded-lg font-semibold"
                loading={submitting}
                // Reserve mode never needs online payment configured — it takes no
                // card here — so the config guard only gates the card path. The
                // `submitting` disable is the in-flight double-submit guard: a
                // second click (double-tap, slow connection) must not re-enter the
                // handler while the first request is still in the air. The API's
                // idempotency key already collapses a replay to one order, but the
                // button never even letting a second submit fire is the first line
                // of defence and gives the guest immediate feedback.
                disabled={submitDisabled || submitting}
              >
                {submitLabel}
              </Button>

              {/*
                Payment can take several seconds on rural cell service. A polite
                live region turns that dead time into something audible instead
                of a button that silently stops responding.
              */}
              <p role="status" className="sr-only">
                {submitting
                  ? reserveMode
                    ? 'Reserving your spot. Please wait.'
                    : 'Processing your booking. Please wait.'
                  : ''}
              </p>

              <p className="text-center text-xs text-muted">
                {reserveMode
                  ? 'By reserving you agree to the terms and any applicable cancellation policy.'
                  : 'By completing this booking you agree to the terms and any applicable cancellation policy.'}
              </p>
            </div>
          </div>
        </div>

        {/*
          Mobile-only sticky action bar. A second submit button in the same form is
          valid and fires the same handler; it is `aria-hidden` and out of the tab
          order because the in-flow button above already gives assistive tech and
          keyboard users the submit — this bar is purely a reach aid for a thumb on a
          phone, so duplicating it into the accessibility tree would just announce the
          same control twice. It carries the running total for at-a-glance context.
        */}
        <div
          aria-hidden
          className="fixed inset-x-0 bottom-0 z-30 border-t border-hairline bg-surface px-4 py-3 shadow-[0_-2px_14px_rgba(43,36,28,0.06)] lg:hidden"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <Button
            type="submit"
            variant="brand"
            size="lg"
            className="w-full rounded-lg font-semibold"
            loading={submitting}
            // Same in-flight double-submit guard as the in-flow button above:
            // this mobile bar submits the same form, so it must lock the moment a
            // submit is in the air too.
            disabled={submitDisabled || submitting}
            tabIndex={-1}
          >
            <span className="flex w-full items-center justify-between gap-3">
              <span>{submitLabel}</span>
              {!submitting && (
                <span className="tnum font-semibold">
                  {formatUSD(reserveDueCents)}
                </span>
              )}
            </span>
          </Button>
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
