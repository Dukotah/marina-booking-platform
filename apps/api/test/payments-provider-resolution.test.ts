/**
 * PaymentProvider resolution order (services/payments/index.ts) + the seam's
 * outcome-narrowing helper.
 *
 * The documented order:
 *   1. local sandbox        — whenever the simulator is enabled (any non-production
 *                             run by default; SANDBOX=local forces it, =cloud disables)
 *   2. per-operator keys    — enabled `stripe` Integration record with a secret_key
 *   3. env keys             — STRIPE_SECRET_KEY
 *   4. sandbox (crude fake) — DEV_FAKE_PAYMENTS=true with no Stripe key
 *   5. none                 — payments off, money routes 501
 *
 * Env-only cases run with no operator (no DB needed); the Integration-record cases
 * write a real row for the seeded LSRA tenant and are DB-gated. Every test runs
 * with SANDBOX=cloud except the one proving the sandbox override — in test env the
 * simulator would otherwise (correctly) win everything.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { adminPrisma } from '@marina/database';
import {
  getPaymentProvider,
  paymentsEnabledFor,
  settledOrThrow,
  PaymentChallengeRequiredError,
  PaymentProviderError,
  PaymentsNotConfiguredError,
} from '../src/services/payments/index.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const OP = 'lsra';

const ENV_KEYS = [
  'SANDBOX',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'DEV_FAKE_PAYMENTS',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Default for these tests: simulator OFF so the rest of the order is reachable.
  process.env.SANDBOX = 'cloud';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('payment provider resolution (env-only)', () => {
  it('the local sandbox supersedes everything when enabled', async () => {
    process.env.SANDBOX = 'local';
    process.env.STRIPE_SECRET_KEY = 'sk_test_env';
    const provider = await getPaymentProvider();
    expect(provider.providerKey).toBe('sandbox');
    expect(provider.clientConfig()).toEqual({ kind: 'sandbox' });
  });

  it('env STRIPE_SECRET_KEY resolves the stripe provider (simulator off)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_env';
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_env';
    const provider = await getPaymentProvider();
    expect(provider.providerKey).toBe('stripe');
    expect(provider.clientConfig()).toEqual({
      kind: 'stripe-elements',
      publishableKey: 'pk_test_env',
      testMode: true,
    });
  });

  it('a stripe secret key with no publishable key yields a "none" client config', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_env';
    const provider = await getPaymentProvider();
    expect(provider.providerKey).toBe('stripe');
    expect(provider.clientConfig()).toEqual({ kind: 'none' });
  });

  it('DEV_FAKE_PAYMENTS falls back to the sandbox provider when no key is present', async () => {
    process.env.DEV_FAKE_PAYMENTS = 'true';
    const provider = await getPaymentProvider();
    expect(provider.providerKey).toBe('sandbox');
  });

  it('env keys beat DEV_FAKE_PAYMENTS (fake mode requires no key configured)', async () => {
    process.env.DEV_FAKE_PAYMENTS = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test_env';
    const provider = await getPaymentProvider();
    expect(provider.providerKey).toBe('stripe');
  });

  it('nothing configured resolves "none", whose money calls throw the 501 error', async () => {
    const provider = await getPaymentProvider();
    expect(provider.providerKey).toBe('none');
    expect(provider.isConfigured()).toBe(false);
    expect(provider.clientConfig()).toEqual({ kind: 'none' });
    await expect(
      provider.charge({
        orderId: 'o1',
        tokenizedSource: 'tok',
        amountCents: 100,
        idempotencyKey: 'k1',
      }),
    ).rejects.toBeInstanceOf(PaymentsNotConfiguredError);
    await expect(
      provider.refund({ paymentRef: 'pi_x', amountCents: 100 }),
    ).rejects.toBeInstanceOf(PaymentsNotConfiguredError);
  });
});

describe.skipIf(!HAS_DB)('payment provider resolution (per-operator Integration record)', () => {
  afterEach(async () => {
    await adminPrisma.integration.deleteMany({ where: { operator_id: OP, key: 'stripe' } });
  });

  afterAll(async () => {
    await adminPrisma.$disconnect();
  });

  async function writeIntegration(enabled: boolean, config: Record<string, string>) {
    await adminPrisma.integration.upsert({
      where: { operator_id_key: { operator_id: OP, key: 'stripe' } },
      create: { operator_id: OP, key: 'stripe', enabled, config },
      update: { enabled, config },
    });
  }

  it('an enabled stripe Integration record beats the env keys', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_env';
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_env';
    await writeIntegration(true, {
      secret_key: 'sk_test_operator',
      publishable_key: 'pk_test_operator',
    });

    const provider = await getPaymentProvider(OP);
    expect(provider.providerKey).toBe('stripe');
    // The operator's OWN publishable key proves the Integration record won.
    expect(provider.clientConfig()).toEqual({
      kind: 'stripe-elements',
      publishableKey: 'pk_test_operator',
      testMode: true,
    });
    expect(await paymentsEnabledFor(OP)).toBe(true);
  });

  it('a disabled Integration record is ignored — env keys win', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_env';
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_env';
    await writeIntegration(false, { secret_key: 'sk_test_operator' });

    const provider = await getPaymentProvider(OP);
    expect(provider.providerKey).toBe('stripe');
    expect(provider.clientConfig()).toMatchObject({ publishableKey: 'pk_test_env' });
  });

  it('an Integration record without a secret_key is ignored', async () => {
    await writeIntegration(true, { publishable_key: 'pk_test_operator' });
    const provider = await getPaymentProvider(OP);
    expect(provider.providerKey).toBe('none');
    expect(await paymentsEnabledFor(OP)).toBe(false);
  });

  it('an enabled Integration record alone enables payments (no env at all)', async () => {
    await writeIntegration(true, { secret_key: 'sk_test_operator' });
    const provider = await getPaymentProvider(OP);
    expect(provider.providerKey).toBe('stripe');
    expect(await paymentsEnabledFor(OP)).toBe(true);
  });
});

describe('settledOrThrow (service-layer outcome narrowing)', () => {
  it('passes a succeeded outcome through untouched', () => {
    const outcome = {
      status: 'succeeded' as const,
      paymentRef: 'pi_x',
      amountCents: 1234,
      cardBrand: 'visa',
      cardLastFour: '4242',
      cardholderName: 'T',
      receiptUrl: null,
    };
    expect(settledOrThrow(outcome)).toEqual(outcome);
  });

  it('throws the failure with its message, status and code preserved', () => {
    try {
      settledOrThrow({
        status: 'failed',
        failure: { message: 'Your card was declined.', code: 'card_declined', httpStatus: 402 },
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentProviderError);
      const e = err as PaymentProviderError;
      expect(e.message).toBe('Your card was declined.');
      expect(e.status).toBe(402);
      expect(e.code).toBe('card_declined');
    }
  });

  it('throws a challenge error carrying the full 3DS affordance', () => {
    try {
      settledOrThrow({
        status: 'requires_action',
        amountCents: 500,
        challenge: { intentId: 'pi_1', clientSecret: 'pi_1_secret_a', returnUrl: '/dev/x' },
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentChallengeRequiredError);
      const e = err as PaymentChallengeRequiredError;
      expect(e.intentId).toBe('pi_1');
      expect(e.clientSecret).toBe('pi_1_secret_a');
      expect(e.challengeUrl).toBe('/dev/x');
      expect(e.status).toBe(402);
      expect(e.code).toBe('requires_action');
    }
  });
});
