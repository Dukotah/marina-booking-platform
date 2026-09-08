/**
 * API-driven payment configuration for the checkout (server-only).
 *
 * The booking API is the source of truth for how this site takes payment:
 * GET /api/payments/config reports the resolved provider (per-operator Integration
 * keys → env keys → sandbox → none), its browser config (e.g. the Stripe
 * publishable key), and the payment mode. Reading it here — instead of only
 * NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY — means plugging a processor in (env keys on
 * the API, or the admin Settings → Integrations page) needs NO web redeploy.
 *
 * The env-derived config (`getStripeConfig` / `getPaymentMode`) remains as the
 * FALLBACK: in DEMO_MODE (no live API), or when the API is unreachable or predates
 * the config endpoint, checkout behaves exactly as it always has. Nothing breaks
 * when the endpoint is missing; the API merely stops being consulted.
 *
 * The resolved shape stays `StripeConfig` so the client components are untouched —
 * a future non-Stripe provider would extend this mapping alongside its own
 * PaymentMethodInput component (see docs/PAYMENTS.md).
 */
import { request } from '@/lib/api';
import { DEMO_MODE } from '@/lib/demo/config';
import { getStripeConfig, type StripeConfig } from './stripe-config';
import { getPaymentMode, type PaymentMode } from './payment-mode';

/** The API's GET /api/payments/config response. */
interface PaymentsConfigResponse {
  provider: 'stripe' | 'sandbox' | 'none';
  enabled: boolean;
  paymentMode: PaymentMode;
  client:
    | { kind: 'stripe-elements'; publishableKey: string; testMode: boolean }
    | { kind: 'sandbox' }
    | { kind: 'none' };
}

export interface ResolvedPaymentConfig {
  stripe: StripeConfig;
  paymentMode: PaymentMode;
}

/** Map the API's client config onto the StripeConfig the components consume. */
function fromApi(config: PaymentsConfigResponse, envFallback: StripeConfig): StripeConfig {
  switch (config.client.kind) {
    case 'stripe-elements':
      return {
        configured: true,
        publishableKey: config.client.publishableKey,
        testMode: config.client.testMode,
        fakeMode: false,
      };
    case 'sandbox':
      // The API will simulate the charge — same posture as env fake mode. The env
      // publishable key (if any) is irrelevant: sandbox never loads Stripe.js.
      return { configured: false, publishableKey: null, testMode: true, fakeMode: true };
    case 'none':
      // The API takes no payment; keep whatever the env says so a web-only key
      // still renders exactly what it did before this seam existed.
      return envFallback;
  }
}

/**
 * Resolve the payment config: API first, env fallback. Never throws — checkout
 * must render even when the API is down (the submit path surfaces its own errors).
 */
export async function getPaymentConfig(): Promise<ResolvedPaymentConfig> {
  const envConfig = getStripeConfig();
  const envMode = getPaymentMode();

  // DEMO_MODE has no live API: the cookie-backed demo store simulates payment.
  if (DEMO_MODE) {
    return { stripe: envConfig, paymentMode: envMode };
  }

  try {
    const data = await request<PaymentsConfigResponse>('/api/payments/config', {
      // Config changes when the operator wires keys up — cheap call, keep it fresh.
      cache: 'no-store',
    });
    return {
      stripe: fromApi(data, envConfig),
      // The deployment's own PAYMENT_MODE (when set) stays authoritative for the
      // UI it renders; the API's answer covers deployments that only set it there.
      paymentMode: process.env.PAYMENT_MODE || process.env.NEXT_PUBLIC_PAYMENT_MODE
        ? envMode
        : data.paymentMode,
    };
  } catch {
    // API unreachable or endpoint missing — behave exactly as pre-seam checkout.
    return { stripe: envConfig, paymentMode: envMode };
  }
}
