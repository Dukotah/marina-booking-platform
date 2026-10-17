/**
 * Square payment-provider seam — unit tests.
 *
 * Pure unit coverage: NO database, NO network. These tests exercise the Square
 * provider object built by `createSquareProvider`, the env config reader, the money
 * + webhook helpers, and the env-driven selection in `../payments/index.ts`.
 *
 * Mirrors the style of `apps/api/test/payments-provider-resolution.test.ts` (env
 * save/restore in before/afterEach; env-only resolution with no operator so no DB
 * is touched). Every selection test runs with SANDBOX=cloud so the local simulator
 * — which correctly supersedes everything in test env — does not win the resolver.
 *
 * Contract under test:
 *   - the provider conforms to the PaymentProvider interface shape;
 *   - PAYMENT_PROVIDER=square selects Square ONLY when explicitly set + keys present;
 *   - the default selection is unchanged (Square is never implicit);
 *   - unimplemented LIVE methods throw a clear "not configured" error and never a
 *     fake success;
 *   - the pieces that do NOT need the SDK (validation, client config, webhook
 *     parse/normalize, money conversion) are really implemented.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createSquareProvider,
  envSquareConfig,
  normalizeSquareEvent,
  toSquareMoney,
  SquareNotConfiguredError,
  type SquareProviderConfig,
} from './square-provider.js';
import { getPaymentProvider, PaymentProviderError } from './index.js';
import type { PaymentProvider } from './types.js';

const FULL_CONFIG: SquareProviderConfig = {
  accessToken: 'sq0atp-test-token',
  applicationId: 'sq0idp-test-app',
  locationId: 'LHELLOWORLD',
  webhookSignatureKey: null,
  environment: 'sandbox',
};

const ENV_KEYS = [
  'SANDBOX',
  'PAYMENT_PROVIDER',
  'STRIPE_SECRET_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'DEV_FAKE_PAYMENTS',
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_APPLICATION_ID',
  'NEXT_PUBLIC_SQUARE_APPLICATION_ID',
  'SQUARE_LOCATION_ID',
  'NEXT_PUBLIC_SQUARE_LOCATION_ID',
  'SQUARE_WEBHOOK_SIGNATURE_KEY',
  'SQUARE_ENVIRONMENT',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Simulator OFF so the rest of the resolution order is reachable (as the sibling
  // resolution suite does). Nothing here touches the DB — env-only, no operator.
  process.env.SANDBOX = 'cloud';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('Square provider — interface conformance', () => {
  it('implements the full PaymentProvider shape', () => {
    const provider: PaymentProvider = createSquareProvider(FULL_CONFIG);
    expect(provider.providerKey).toBe('square');
    expect(typeof provider.isConfigured).toBe('function');
    expect(typeof provider.clientConfig).toBe('function');
    expect(typeof provider.charge).toBe('function');
    expect(typeof provider.confirmChallenge).toBe('function');
    expect(typeof provider.pendingChallenge).toBe('function');
    expect(typeof provider.refund).toBe('function');
    expect(typeof provider.verifyAndParseWebhook).toBe('function');
  });

  it('isConfigured requires both an access token and a location', () => {
    expect(createSquareProvider(FULL_CONFIG).isConfigured()).toBe(true);
    expect(createSquareProvider({ ...FULL_CONFIG, locationId: null }).isConfigured()).toBe(false);
    expect(createSquareProvider({ ...FULL_CONFIG, accessToken: '' }).isConfigured()).toBe(false);
  });

  it('clientConfig yields square-web-payments with the public ids (never a secret)', () => {
    const cfg = createSquareProvider(FULL_CONFIG).clientConfig();
    expect(cfg).toEqual({
      kind: 'square-web-payments',
      applicationId: 'sq0idp-test-app',
      locationId: 'LHELLOWORLD',
      environment: 'sandbox',
    });
    expect(JSON.stringify(cfg)).not.toContain(FULL_CONFIG.accessToken);
  });

  it('clientConfig is "none" when the browser cannot mount the card form', () => {
    expect(createSquareProvider({ ...FULL_CONFIG, applicationId: null }).clientConfig()).toEqual({
      kind: 'none',
    });
    expect(createSquareProvider({ ...FULL_CONFIG, locationId: null }).clientConfig()).toEqual({
      kind: 'none',
    });
  });
});

describe('Square provider — implemented-without-SDK behavior', () => {
  it('charge returns a 400 FAILED outcome (not a throw) for a bad amount', async () => {
    const provider = createSquareProvider(FULL_CONFIG);
    const outcome = await provider.charge({
      orderId: 'o1',
      tokenizedSource: 'cnon:card-nonce-ok',
      amountCents: 0,
      idempotencyKey: 'k1',
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.failure.httpStatus).toBe(400);
    }
  });

  it('pendingChallenge resolves null (Square holds no recoverable server intent)', async () => {
    await expect(createSquareProvider(FULL_CONFIG).pendingChallenge({
      orderId: 'o1',
      operatorId: 'op',
    })).resolves.toBeNull();
  });

  it('confirmChallenge cancel is a no-op that resolves null', async () => {
    await expect(
      createSquareProvider(FULL_CONFIG).confirmChallenge({
        intentId: 'x',
        action: 'cancel',
        operatorId: 'op',
      }),
    ).resolves.toBeNull();
  });

  it('toSquareMoney passes USD cents through and validates the amount', () => {
    expect(toSquareMoney(1299)).toEqual({ amount: 1299, currency: 'USD' });
    expect(() => toSquareMoney(0)).toThrow(PaymentProviderError);
    expect(() => toSquareMoney(1.5)).toThrow(PaymentProviderError);
  });

  it('normalizeSquareEvent maps payment/refund events and ignores the rest', () => {
    expect(
      normalizeSquareEvent({
        type: 'payment.updated',
        data: { object: { payment: { id: 'pay_1', status: 'COMPLETED' } } },
      }),
    ).toEqual([{ type: 'payment_succeeded', paymentRef: 'pay_1' }]);

    expect(
      normalizeSquareEvent({
        type: 'payment.updated',
        data: { object: { payment: { id: 'pay_2', status: 'FAILED' } } },
      }),
    ).toEqual([{ type: 'payment_failed', paymentRef: 'pay_2' }]);

    expect(
      normalizeSquareEvent({
        type: 'refund.updated',
        data: {
          object: {
            refund: { payment_id: 'pay_3', status: 'COMPLETED', amount_money: { amount: 500 } },
          },
        },
      }),
    ).toEqual([{ type: 'refund_completed', paymentRef: 'pay_3', refundedTotalCents: 500 }]);

    expect(normalizeSquareEvent({ type: 'oauth.authorization.revoked' })).toEqual([]);
    // A pending (not COMPLETED) payment is intentionally ignored.
    expect(
      normalizeSquareEvent({
        type: 'payment.updated',
        data: { object: { payment: { id: 'pay_4', status: 'PENDING' } } },
      }),
    ).toEqual([]);
  });

  it('verifyAndParseWebhook parses + normalizes an unsigned (no-secret) delivery', () => {
    const provider = createSquareProvider(FULL_CONFIG);
    const body = JSON.stringify({
      event_id: 'evt_1',
      type: 'payment.updated',
      data: { object: { payment: { id: 'pay_9', status: 'COMPLETED' } } },
    });
    const parsed = provider.verifyAndParseWebhook(body, () => undefined);
    expect(parsed).toEqual({
      providerEventId: 'evt_1',
      providerEventType: 'payment.updated',
      events: [{ type: 'payment_succeeded', paymentRef: 'pay_9' }],
    });
  });
});

describe('Square provider — unimplemented LIVE calls throw, never fake success', () => {
  const provider = createSquareProvider(FULL_CONFIG);

  it('charge (valid amount) throws SquareNotConfiguredError — no silent success', async () => {
    await expect(
      provider.charge({
        orderId: 'o1',
        tokenizedSource: 'cnon:card-nonce-ok',
        amountCents: 2500,
        idempotencyKey: 'k1',
      }),
    ).rejects.toBeInstanceOf(SquareNotConfiguredError);
  });

  it('refund (valid amount) throws SquareNotConfiguredError', async () => {
    await expect(
      provider.refund({ paymentRef: 'pay_1', amountCents: 500 }),
    ).rejects.toBeInstanceOf(SquareNotConfiguredError);
  });

  it('confirmChallenge complete throws SquareNotConfiguredError', async () => {
    await expect(
      provider.confirmChallenge({ intentId: 'x', action: 'complete', operatorId: 'op' }),
    ).rejects.toBeInstanceOf(SquareNotConfiguredError);
  });

  it('a signed webhook throws until real verification is wired (never accepts unverified)', () => {
    const signed = createSquareProvider({ ...FULL_CONFIG, webhookSignatureKey: 'wsk_123' });
    expect(() =>
      signed.verifyAndParseWebhook('{}', (name) =>
        name === 'x-square-hmacsha256-signature' ? 'sig' : undefined,
      ),
    ).toThrow(SquareNotConfiguredError);
  });

  it('a signed webhook with a missing signature header is a 401', () => {
    const signed = createSquareProvider({ ...FULL_CONFIG, webhookSignatureKey: 'wsk_123' });
    try {
      signed.verifyAndParseWebhook('{}', () => undefined);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentProviderError);
      expect((err as PaymentProviderError).status).toBe(401);
    }
  });

  it('SquareNotConfiguredError is a 501 with a clear, non-decline message', () => {
    const err = new SquareNotConfiguredError('payments.create is not wired');
    expect(err).toBeInstanceOf(PaymentProviderError);
    expect(err.status).toBe(501);
    expect(err.message).toContain('Square live integration not configured');
  });
});

describe('Square env config reader', () => {
  it('returns null when no access token is set', () => {
    expect(envSquareConfig()).toBeNull();
  });

  it('reads token, public ids, signature key, and environment from env', () => {
    process.env.SQUARE_ACCESS_TOKEN = 'sq0atp-x';
    process.env.NEXT_PUBLIC_SQUARE_APPLICATION_ID = 'sq0idp-x';
    process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID = 'LXYZ';
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'wsk';
    process.env.SQUARE_ENVIRONMENT = 'production';
    expect(envSquareConfig()).toEqual({
      accessToken: 'sq0atp-x',
      applicationId: 'sq0idp-x',
      locationId: 'LXYZ',
      webhookSignatureKey: 'wsk',
      environment: 'production',
    });
  });

  it('defaults to the sandbox environment when SQUARE_ENVIRONMENT is unset', () => {
    process.env.SQUARE_ACCESS_TOKEN = 'sq0atp-x';
    expect(envSquareConfig()?.environment).toBe('sandbox');
  });
});

describe('resolver selection (env-only, no DB)', () => {
  it('PAYMENT_PROVIDER=square + SQUARE_ACCESS_TOKEN selects Square', async () => {
    process.env.PAYMENT_PROVIDER = 'square';
    process.env.SQUARE_ACCESS_TOKEN = 'sq0atp-x';
    process.env.NEXT_PUBLIC_SQUARE_APPLICATION_ID = 'sq0idp-x';
    process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID = 'LXYZ';
    const provider = await getPaymentProvider();
    expect(provider.providerKey).toBe('square');
    expect(provider.clientConfig()).toMatchObject({ kind: 'square-web-payments' });
  });

  it('is case-insensitive on the PAYMENT_PROVIDER value', async () => {
    process.env.PAYMENT_PROVIDER = 'Square';
    process.env.SQUARE_ACCESS_TOKEN = 'sq0atp-x';
    const provider = await getPaymentProvider();
    expect(provider.providerKey).toBe('square');
  });

  it('DOES NOT select Square without the explicit flag, even with Square keys present', async () => {
    // Square keys present but PAYMENT_PROVIDER unset -> default (Stripe) stands.
    process.env.SQUARE_ACCESS_TOKEN = 'sq0atp-x';
    process.env.STRIPE_SECRET_KEY = 'sk_test_env';
    const provider = await getPaymentProvider();
    expect(provider.providerKey).toBe('stripe');
  });

  it('default resolution is unchanged — Stripe env keys still win when Square is not requested', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_env';
    const provider = await getPaymentProvider();
    expect(provider.providerKey).toBe('stripe');
  });

  it('PAYMENT_PROVIDER=square with NO Square token does not masquerade — falls through, never Square', async () => {
    process.env.PAYMENT_PROVIDER = 'square';
    process.env.STRIPE_SECRET_KEY = 'sk_test_env';
    const provider = await getPaymentProvider();
    // Falls through to the Stripe env keys rather than returning a broken Square.
    expect(provider.providerKey).toBe('stripe');
  });

  it('PAYMENT_PROVIDER=square with nothing configured resolves "none" (money routes 501)', async () => {
    process.env.PAYMENT_PROVIDER = 'square';
    const provider = await getPaymentProvider();
    expect(provider.providerKey).toBe('none');
  });
});
