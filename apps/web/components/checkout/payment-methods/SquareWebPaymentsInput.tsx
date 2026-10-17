'use client';

/**
 * Square Web Payments implementation of the PaymentMethodInput contract.
 *
 * Loads the Square Web Payments SDK (the sandbox or production script, chosen by the
 * API-reported environment), mounts Square's hosted, PCI-safe Card form, and exposes
 * `tokenize()` via the imperative handle so the checkout can obtain a single-use
 * card nonce (`sourceId`) at submit time and pass it to the booking action (which
 * charges it server-side via Square's Payments API).
 *
 * SCA / 3-D Secure: Square runs Strong Customer Authentication IN THE BROWSER via
 * `payments.verifyBuyer(...)` BEFORE the nonce is submitted — so there is no
 * server-side `requires_action` step (unlike Stripe). `tokenize()` here does both:
 * card.tokenize() → nonce, then verifyBuyer() → a verification token folded into the
 * same single `sourceId` the server charges. No secret ever touches the browser:
 * only the public application id + location id.
 *
 * The SDK is loaded from Square's CDN (no `@square/web-sdk` npm dependency) the same
 * way StripeElementsInput lazy-loads Stripe.js — the script is only fetched when a
 * Square-configured checkout actually mounts this component.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { CreditCard, Lock } from 'lucide-react';
import type { PaymentMethodInputHandle } from './types';

const SDK_URLS = {
  sandbox: 'https://sandbox.web.squarecdn.com/v1/square.js',
  production: 'https://web.squarecdn.com/v1/square.js',
} as const;

/**
 * The narrow slice of the Square Web Payments SDK surface we use. The SDK attaches
 * `window.Square` once its script loads. Typed locally so no `@square/web-sdk`
 * dependency is required (the containment mirrors keeping Square server types inside
 * the API provider).
 */
interface SquareCard {
  attach: (selector: string | HTMLElement) => Promise<void>;
  tokenize: () => Promise<{
    status: string;
    token?: string;
    errors?: { message?: string }[];
  }>;
  destroy?: () => Promise<void>;
}
interface SquarePayments {
  card: () => Promise<SquareCard>;
  verifyBuyer: (
    token: string,
    details: Record<string, unknown>,
  ) => Promise<{ token: string } | undefined>;
}
interface SquareSdk {
  payments: (applicationId: string, locationId: string) => SquarePayments;
}
declare global {
  interface Window {
    Square?: SquareSdk;
  }
}

/** Load the Square Web Payments SDK script once, resolving to window.Square. */
function loadSquareSdk(environment: 'sandbox' | 'production'): Promise<SquareSdk> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Square Web Payments SDK can only load in the browser'));
  }
  if (window.Square) return Promise.resolve(window.Square);

  const url = SDK_URLS[environment];
  return new Promise<SquareSdk>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${url}"]`);
    const onLoaded = () => {
      if (window.Square) resolve(window.Square);
      else reject(new Error('Square Web Payments SDK loaded but did not initialize'));
    };
    if (existing) {
      if (window.Square) resolve(window.Square);
      else {
        existing.addEventListener('load', onLoaded, { once: true });
        existing.addEventListener('error', () => reject(new Error('Failed to load the Square SDK')), {
          once: true,
        });
      }
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.addEventListener('load', onLoaded, { once: true });
    script.addEventListener('error', () => reject(new Error('Failed to load the Square SDK')), {
      once: true,
    });
    document.head.appendChild(script);
  });
}

interface SquareWebPaymentsInputProps {
  applicationId: string;
  locationId: string;
  environment: 'sandbox' | 'production';
  /** Amount about to be charged (integer cents), passed to verifyBuyer for SCA. */
  amountCents?: number;
}

/** Square Web Payments card entry, self-contained behind the PaymentMethodInput handle. */
export const SquareWebPaymentsInput = forwardRef<
  PaymentMethodInputHandle,
  SquareWebPaymentsInputProps
>(function SquareWebPaymentsInput({ applicationId, locationId, environment, amountCents }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paymentsRef = useRef<SquarePayments | null>(null);
  const cardRef = useRef<SquareCard | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const testMode = environment === 'sandbox';

  useEffect(() => {
    let cancelled = false;
    let card: SquareCard | null = null;

    (async () => {
      try {
        const sdk = await loadSquareSdk(environment);
        if (cancelled) return;
        const payments = sdk.payments(applicationId, locationId);
        paymentsRef.current = payments;
        card = await payments.card();
        if (cancelled) {
          await card.destroy?.();
          return;
        }
        if (containerRef.current) {
          await card.attach(containerRef.current);
        }
        if (cancelled) {
          await card.destroy?.();
          return;
        }
        cardRef.current = card;
        setReady(true);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error
              ? err.message
              : 'The payment form could not be loaded. Please refresh and try again.',
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      // Best-effort teardown so a remount (e.g. route change) doesn't double-attach.
      void cardRef.current?.destroy?.();
      void card?.destroy?.();
      cardRef.current = null;
      paymentsRef.current = null;
    };
  }, [applicationId, locationId, environment]);

  useImperativeHandle(
    ref,
    () => ({
      isReady: () => Boolean(ready && cardRef.current),
      tokenize: async () => {
        const card = cardRef.current;
        const payments = paymentsRef.current;
        if (!card || !payments) {
          return { ok: false, error: 'The payment form is not ready yet. Please wait a moment.' };
        }
        try {
          // 1) Tokenize the card into a single-use nonce.
          const result = await card.tokenize();
          if (result.status !== 'OK' || !result.token) {
            const message = result.errors?.[0]?.message;
            setFieldError(message ?? null);
            return {
              ok: false,
              error: message ?? 'Please check your card details and try again.',
            };
          }
          const nonce = result.token;

          // 2) Run Strong Customer Authentication in the browser. Square folds the
          //    verification into the nonce's downstream charge; a verification token
          //    is returned when the issuer required a challenge, undefined when not.
          //    A failed/declined challenge throws — treated as a decline here.
          try {
            await payments.verifyBuyer(nonce, {
              amount: amountCents != null ? (amountCents / 100).toFixed(2) : undefined,
              currencyCode: 'USD',
              intent: 'CHARGE',
            });
          } catch {
            return {
              ok: false,
              error: 'We could not verify this card with your bank. Please try a different card.',
            };
          }

          // 3) Submit the card nonce as the sourceId the server charges.
          setFieldError(null);
          return { ok: true, sourceId: nonce };
        } catch {
          return {
            ok: false,
            error: 'Something went wrong reading your card. Please try again.',
          };
        }
      },
    }),
    [ready, amountCents],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-ink">
        <CreditCard className="h-4 w-4" aria-hidden />
        Card details
        {testMode && (
          <span className="rounded bg-bg px-1.5 py-0.5 text-xs font-medium text-muted">Test</span>
        )}
      </div>

      {/* Square mounts its hosted, PCI-safe card iframe inside this element. */}
      <div
        ref={containerRef}
        className="min-h-[44px] rounded-lg border border-hairline bg-surface p-3"
      />

      {!ready && !loadError && <p className="text-sm text-muted">Loading secure card field…</p>}
      {loadError && (
        <p role="alert" className="text-sm text-danger">
          {loadError}
        </p>
      )}
      {fieldError && (
        <p role="alert" className="text-sm text-danger">
          {fieldError}
        </p>
      )}

      <p className="flex items-center gap-1.5 text-xs text-muted">
        <Lock className="h-3.5 w-3.5" aria-hidden />
        Your card is encrypted and processed securely. We never see your card number.
      </p>
    </div>
  );
});
