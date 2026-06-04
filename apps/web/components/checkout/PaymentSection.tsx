'use client';

/**
 * Square Web Payments card entry.
 *
 * Loads Square's browser SDK (sandbox or production per server-resolved config),
 * mounts a hosted, PCI-safe card field, and exposes a `tokenize()` method via an
 * imperative ref so the parent can obtain a single-use payment token (nonce) at
 * submit time and pass it to the booking action.
 *
 * When Square is not configured (no application/location id — the common early
 * dev state), it renders a clear "sandbox not configured" notice instead of a
 * card field, and `tokenize()` returns a sentinel so the parent can decide how to
 * proceed (e.g. block submit and explain). No secrets touch the browser: only
 * the public application/location ids are used here.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { AlertTriangle, CreditCard, Lock } from 'lucide-react';
import type { SquareConfig } from '@/app/checkout/square-config';

/** What the parent can ask of this section. */
export interface PaymentSectionHandle {
  /**
   * Tokenize the entered card. Returns the source id (nonce) on success, or an
   * object describing why it could not (so the parent shows a message).
   */
  tokenize: () => Promise<
    { ok: true; sourceId: string } | { ok: false; error: string }
  >;
  /** True when a live, ready-to-tokenize card field is mounted. */
  isReady: () => boolean;
}

interface PaymentSectionProps {
  square: SquareConfig;
}

const SDK_URLS: Record<SquareConfig['environment'], string> = {
  sandbox: 'https://sandbox.web.squarecdn.com/v1/square.js',
  production: 'https://web.squarecdn.com/v1/square.js',
};

// Minimal structural types for the parts of the Square SDK we use. The SDK has
// no first-party types bundled here, so we type just our surface to avoid `any`.
interface SquareTokenResult {
  status: string;
  token?: string;
  errors?: Array<{ message?: string }>;
}
interface SquareCard {
  attach: (selector: string | HTMLElement) => Promise<void>;
  tokenize: () => Promise<SquareTokenResult>;
  destroy?: () => Promise<void> | void;
}
interface SquarePayments {
  card: () => Promise<SquareCard>;
}
interface SquareSdk {
  payments: (applicationId: string, locationId: string) => SquarePayments;
}

declare global {
  interface Window {
    Square?: SquareSdk;
  }
}

/** Load the Square SDK script once; resolve when window.Square is available. */
function loadSquareSdk(url: string): Promise<SquareSdk> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Square SDK can only load in the browser.'));
      return;
    }
    if (window.Square) {
      resolve(window.Square);
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${url}"]`,
    );
    const onLoad = () => {
      if (window.Square) resolve(window.Square);
      else reject(new Error('Square SDK loaded but is unavailable.'));
    };
    if (existing) {
      existing.addEventListener('load', onLoad, { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('Failed to load the payment SDK.')),
        { once: true },
      );
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('Failed to load the payment SDK.')),
      { once: true },
    );
    document.head.appendChild(script);
  });
}

export const PaymentSection = forwardRef<PaymentSectionHandle, PaymentSectionProps>(
  function PaymentSection({ square }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cardRef = useRef<SquareCard | null>(null);
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
      square.configured ? 'loading' : 'idle',
    );
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
      if (!square.configured || !square.applicationId || !square.locationId) {
        return;
      }
      let cancelled = false;
      let card: SquareCard | null = null;

      (async () => {
        try {
          const sdk = await loadSquareSdk(SDK_URLS[square.environment]);
          if (cancelled) return;
          const payments = sdk.payments(square.applicationId!, square.locationId!);
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
          setStatus('ready');
        } catch (err) {
          if (cancelled) return;
          setLoadError(
            err instanceof Error
              ? err.message
              : 'The payment form could not be loaded.',
          );
          setStatus('error');
        }
      })();

      return () => {
        cancelled = true;
        const c = cardRef.current ?? card;
        cardRef.current = null;
        void c?.destroy?.();
      };
    }, [square]);

    useImperativeHandle(
      ref,
      () => ({
        isReady: () => status === 'ready' && cardRef.current !== null,
        tokenize: async () => {
          if (!square.configured) {
            return {
              ok: false,
              error:
                'Online payments are not configured for this site yet. Please contact us to complete your booking.',
            };
          }
          const card = cardRef.current;
          if (!card) {
            return {
              ok: false,
              error: 'The payment form is not ready yet. Please wait a moment.',
            };
          }
          try {
            const result = await card.tokenize();
            if (result.status === 'OK' && result.token) {
              return { ok: true, sourceId: result.token };
            }
            const msg =
              result.errors?.map((e) => e.message).filter(Boolean).join(' ') ||
              'Please check your card details and try again.';
            return { ok: false, error: msg };
          } catch {
            return {
              ok: false,
              error: 'We could not process your card. Please try again.',
            };
          }
        },
      }),
      [square, status],
    );

    // --- Not configured: clear sandbox notice (no card field). ----------------
    if (!square.configured) {
      return (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
              aria-hidden
            />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-amber-900">
                Payments sandbox not configured
              </p>
              <p className="text-amber-800">
                Card payments are not set up for this site yet. Add a Square
                application id and location id to enable secure checkout. Until
                then, bookings cannot be paid online here.
              </p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <CreditCard className="h-4 w-4" aria-hidden />
          Card details
          {square.environment === 'sandbox' && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500">
              Sandbox
            </span>
          )}
        </div>

        {/* Square mounts its hosted, PCI-safe card iframe inside this element. */}
        <div
          ref={containerRef}
          className="min-h-[56px] rounded-md border border-slate-300 bg-white p-1"
        />

        {status === 'loading' && (
          <p className="text-sm text-slate-500">Loading secure card field…</p>
        )}
        {status === 'error' && (
          <p role="alert" className="text-sm text-red-600">
            {loadError ?? 'The payment form could not be loaded. Please refresh.'}
          </p>
        )}

        <p className="flex items-center gap-1.5 text-xs text-slate-400">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Your card is encrypted and processed securely. We never see your card
          number.
        </p>
      </div>
    );
  },
);
