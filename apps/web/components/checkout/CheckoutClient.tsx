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
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FormProvider, useForm } from 'react-hook-form';
import { AlertTriangle } from 'lucide-react';
import { calculatePricing } from '@marina/core';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@marina/ui';
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

function emptyParticipant(): ParticipantFormValue {
  return { driver_name: '', license: '', dob: '', experience: '' };
}

function makeParticipants(count: number): ParticipantFormValue[] {
  return Array.from({ length: count }, () => emptyParticipant());
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <p className="text-sm text-slate-500">{description}</p>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
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
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Returning-guest ("book again") prefill, read from this device only.
  const [rememberedGuest, setRememberedGuest] = useState<RememberedGuest | null>(null);

  const paymentRef = useRef<PaymentSectionHandle>(null);

  const methods = useForm<CheckoutFormValues>({
    mode: 'onTouched',
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

  const onSubmit = async (values: CheckoutFormValues) => {
    setSubmitError(null);

    if (!stripe.configured && !stripe.fakeMode) {
      setSubmitError(
        'Online payments are not configured for this site yet, so this booking cannot be completed online. Please contact us to finish your reservation.',
      );
      return;
    }

    setSubmitting(true);
    try {
      // Tokenize the card first — no order is created if the card is invalid.
      const tokenResult = await paymentRef.current?.tokenize();
      if (!tokenResult || !tokenResult.ok) {
        setSubmitError(tokenResult?.error ?? 'Please enter your card details.');
        return;
      }

      const result = await placeOrder({
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
        setSubmitError(result.error);
        return;
      }

      // Remember this guest (this device only) so their next booking is one-tap.
      saveRememberedGuest({
        firstName: values.firstName,
        lastName: values.lastName,
        email: values.email,
        phone: values.phone,
      });

      router.push(`/confirmation?order=${encodeURIComponent(result.order.orderNumber)}`);
    } catch {
      setSubmitError('Something went wrong completing your booking. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSubmit)} noValidate>
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
              title={quantity > 1 ? 'Driver information' : 'Driver information'}
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
              <Card>
                <CardHeader>
                  <CardTitle>Your reservation</CardTitle>
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

                  <div className="border-t border-slate-200 pt-4">
                    <p className="mb-3 text-sm font-medium text-slate-700">
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

              {submitError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{submitError}</span>
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

              <p className="text-center text-xs text-slate-400">
                By completing this booking you agree to the terms and any
                applicable cancellation policy.
              </p>
            </div>
          </div>
        </div>
      </form>
    </FormProvider>
  );
}
