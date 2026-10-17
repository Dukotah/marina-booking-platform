/**
 * Payment provider resolution — which processor takes this operator's money.
 *
 * Mirrors the per-operator resolution pattern of `../sms.ts` (Integration record →
 * env → local fallback), with one deliberate inversion: the LOCAL SANDBOX wins
 * over everything when it is enabled. That preserves the pre-seam behavior of
 * `stripe.ts` (the simulator superseded Stripe in every non-production run) and
 * the local-first contract — `SANDBOX=local` means local, and a sandbox run must
 * never move real money no matter what keys are lying around. Set `SANDBOX=cloud`
 * to exercise real Stripe from a dev machine.
 *
 * Resolution order:
 *   1. sandbox            — when the local simulator is enabled (sandboxEnabled():
 *                           SANDBOX=local, or any non-production run by default)
 *   2. per-operator keys  — enabled `stripe` Integration record with a secret_key
 *                           (the admin Settings → Integrations catalog entry)
 *   3. square (opt-in)    — ONLY when PAYMENT_PROVIDER=square AND SQUARE_ACCESS_TOKEN
 *                           is present. Stripe stays the default; Square is never
 *                           selected implicitly. See square-provider.ts.
 *   4. env keys           — STRIPE_SECRET_KEY (single-tenant/platform deployment)
 *   5. sandbox (crude)    — DEV_FAKE_PAYMENTS=true (non-production, no Stripe key)
 *   6. none               — payments are off; money routes answer 501
 *
 * Webhooks arrive with no tenant context, so `getWebhookProvider()` resolves
 * without an operator (env/sandbox only). Per-operator webhook secrets would need
 * per-operator endpoints — documented as a follow-up in docs/PAYMENTS.md.
 */
import { forOperator } from '@marina/database';
import { captureError } from '../errors.js';
import { arePaymentsEnabled, isFakePaymentsEnabled, isStripeConfigured } from '../stripe.js';
import { sandboxPaymentsEnabled } from '../payments-sandbox.js';
import { createStripeProvider, envStripeConfig } from './stripe-provider.js';
import type { StripeProviderConfig } from './stripe-provider.js';
import { createSquareProvider, envSquareConfig } from './square-provider.js';
import { sandboxProvider } from './sandbox-provider.js';
import { PaymentsNotConfiguredError } from './types.js';
import type { ClientPaymentConfig, ParsedWebhook, PaymentProvider } from './types.js';

// Re-export the seam's public surface so callers import ONE module.
export * from './types.js';
// Keep the long-standing env helpers working for existing callers.
export { arePaymentsEnabled, isFakePaymentsEnabled, isStripeConfigured };

/**
 * The "payments are off" provider. Every money operation refuses with the same
 * clean 501 the routes have always answered when nothing is configured.
 */
const noneProvider: PaymentProvider = {
  providerKey: 'none',
  isConfigured: () => false,
  clientConfig(): ClientPaymentConfig {
    return { kind: 'none' };
  },
  async charge() {
    throw new PaymentsNotConfiguredError();
  },
  async confirmChallenge() {
    throw new PaymentsNotConfiguredError();
  },
  async pendingChallenge() {
    return null;
  },
  async refund() {
    throw new PaymentsNotConfiguredError();
  },
  verifyAndParseWebhook(): ParsedWebhook {
    throw new PaymentsNotConfiguredError();
  },
};

/** Pull a string field out of a stored Integration config JSON blob. */
function configString(config: unknown, key: string): string | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const v = (config as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Per-operator Stripe keys from the enabled `stripe` Integration record (field
 * names match the admin catalog: secret_key / publishable_key / webhook_secret).
 * Null when absent, disabled, or missing a secret key.
 */
async function integrationStripeConfig(operatorId: string): Promise<StripeProviderConfig | null> {
  try {
    const db = forOperator(operatorId);
    const row = await db.integration.findFirst({
      where: { key: 'stripe', enabled: true },
      select: { config: true },
    });
    const secretKey = configString(row?.config, 'secret_key');
    if (!secretKey) return null;
    return {
      secretKey,
      publishableKey: configString(row?.config, 'publishable_key') ?? null,
      webhookSecret: configString(row?.config, 'webhook_secret') ?? null,
    };
  } catch (err) {
    // Falling through to the env keys here means an operator who configured their
    // own Stripe silently charges through the platform account instead. That is a
    // misconfiguration worth seeing, not a log line.
    await captureError(err, {
      operatorId,
      route: 'payments.integrationStripeConfig',
      extra: { integration: 'stripe' },
    });
    return null;
  }
}

/**
 * Resolve the payment provider for an operator (see module doc for the order).
 * Never throws — an unresolvable provider is the `none` provider, and routes turn
 * that into their usual 501.
 */
export async function getPaymentProvider(operatorId?: string): Promise<PaymentProvider> {
  // 1. Local simulator supersedes everything (local-first contract; pre-seam behavior).
  if (sandboxPaymentsEnabled()) return sandboxProvider;

  // 2. Per-operator Integration keys (true multi-tenant — bring your own Stripe).
  if (operatorId) {
    const opConfig = await integrationStripeConfig(operatorId);
    if (opConfig) return createStripeProvider(opConfig);
  }

  // 3. Square — EXPLICIT opt-in only. Selected solely when PAYMENT_PROVIDER=square
  //    and a Square access token is configured. This never fires by default, so the
  //    default payment provider is unchanged (sandbox locally, Stripe in prod).
  if (process.env.PAYMENT_PROVIDER?.trim().toLowerCase() === 'square') {
    const squareEnv = envSquareConfig();
    if (squareEnv) return createSquareProvider(squareEnv);
    // PAYMENT_PROVIDER=square was asked for but no SQUARE_ACCESS_TOKEN is present:
    // fall through rather than silently charging through Stripe. The `none` provider
    // (or env Stripe, if its keys exist) handles it — a misconfiguration worth seeing
    // as a 501, not a surprise Stripe charge.
  }

  // 4. Platform env keys.
  const env = envStripeConfig();
  if (env) return createStripeProvider(env);

  // 5. Crude dev fake (DEV_FAKE_PAYMENTS with the simulator off).
  if (isFakePaymentsEnabled()) return sandboxProvider;

  // 6. Payments are off.
  return noneProvider;
}

/**
 * Provider for an incoming webhook, which carries no tenant context: env/sandbox
 * resolution only. (Payment rows are still tenant-resolved per event by the route.)
 */
export function getWebhookProvider(): Promise<PaymentProvider> {
  return getPaymentProvider(undefined);
}

/**
 * Whether THIS operator can take payments — the async, integration-aware
 * counterpart of the env-only `arePaymentsEnabled()`.
 */
export async function paymentsEnabledFor(operatorId: string): Promise<boolean> {
  return (await getPaymentProvider(operatorId)).providerKey !== 'none';
}
