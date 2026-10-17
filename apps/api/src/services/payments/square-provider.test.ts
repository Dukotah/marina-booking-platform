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
import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// Mock ONLY the low-level Square client factory in ../square.ts so the LIVE calls
// (payments.create / refunds.refundPayment) hit an in-memory fake — no network, no
// SDK. The real money/error helpers (toSquareMoney, moneyToCents, toSquareError,
// SquarePaymentError) are preserved via importActual so mapping behavior is genuine.
const squareClientMock = vi.hoisted(() => ({
  paymentsCreate: vi.fn(),
  refundsRefundPayment: vi.fn(),
}));
vi.mock('../square.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../square.js')>();
  return {
    ...actual,
    getSquareClient: () => ({
      payments: { create: squareClientMock.paymentsCreate },
      refunds: { refundPayment: squareClientMock.refundsRefundPayment },
    }),
  };
});
// The mapped-error path uses the SDK's SquareError class; import it lazily for the
// decline-throws test so ../square.ts's toSquareError recognizes it.
import { SquareError } from 'square';

const FULL_CONFIG: SquareProviderConfig = {
  accessToken: 'sq0atp-test-token',
  applicationId: 'sq0idp-test-app',
  locationId: 'LHELLOWORLD',
  webhookSignatureKey: null,
  webhookNotificationUrl: null,
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
  'SQUARE_WEBHOOK_NOTIFICATION_URL',
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

describe('Square provider — not-applicable / fail-closed paths', () => {
  const provider = createSquareProvider(FULL_CONFIG);

  it('confirmChallenge complete throws SquareNotConfiguredError (Square has no server SCA step)', async () => {
    await expect(
      provider.confirmChallenge({ intentId: 'x', action: 'complete', operatorId: 'op' }),
    ).rejects.toBeInstanceOf(SquareNotConfiguredError);
  });

  it('a signed webhook with NO notification url fails closed (never accepts unverified)', () => {
    const signed = createSquareProvider({ ...FULL_CONFIG, webhookSignatureKey: 'wsk_123' });
    expect(() =>
      signed.verifyAndParseWebhook('{}', (name) =>
        name === 'x-square-hmacsha256-signature' ? 'sig' : undefined,
      ),
    ).toThrow(SquareNotConfiguredError);
  });

  it('a signed webhook with a missing signature header is a 401', () => {
    const signed = createSquareProvider({
      ...FULL_CONFIG,
      webhookSignatureKey: 'wsk_123',
      webhookNotificationUrl: 'https://api.example.com/webhooks/stripe',
    });
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

describe('Square provider — LIVE charge (mocked SDK)', () => {
  beforeEach(() => {
    squareClientMock.paymentsCreate.mockReset();
    squareClientMock.refundsRefundPayment.mockReset();
  });

  it('maps a COMPLETED payment to a succeeded ChargeOutcome with the payment id as the ref', async () => {
    squareClientMock.paymentsCreate.mockResolvedValue({
      payment: {
        id: 'sqpay_123',
        status: 'COMPLETED',
        amountMoney: { amount: 2500n, currency: 'USD' },
        receiptUrl: 'https://squareup.com/receipt/abc',
        cardDetails: {
          card: { cardBrand: 'VISA', last4: '1111', cardholderName: 'Ada Lovelace' },
        },
      },
    });

    const provider = createSquareProvider(FULL_CONFIG);
    const outcome = await provider.charge({
      orderId: 'o1',
      tokenizedSource: 'cnon:card-nonce-ok',
      amountCents: 2500,
      idempotencyKey: 'k1',
    });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status === 'succeeded') {
      expect(outcome.paymentRef).toBe('sqpay_123');
      expect(outcome.amountCents).toBe(2500);
      expect(outcome.cardBrand).toBe('VISA');
      expect(outcome.cardLastFour).toBe('1111');
      expect(outcome.cardholderName).toBe('Ada Lovelace');
      expect(outcome.receiptUrl).toBe('https://squareup.com/receipt/abc');
    }

    // The SDK was called with the derived money (bigint), source, idempotency, location.
    const req = squareClientMock.paymentsCreate.mock.calls[0][0];
    expect(req).toMatchObject({
      sourceId: 'cnon:card-nonce-ok',
      idempotencyKey: 'k1',
      locationId: 'LHELLOWORLD',
      referenceId: 'o1',
      amountMoney: { amount: 2500n, currency: 'USD' },
    });
  });

  it('maps an APPROVED payment to succeeded as well', async () => {
    squareClientMock.paymentsCreate.mockResolvedValue({
      payment: { id: 'sqpay_appr', status: 'APPROVED', amountMoney: { amount: 999n, currency: 'USD' } },
    });
    const outcome = await createSquareProvider(FULL_CONFIG).charge({
      orderId: 'o2',
      tokenizedSource: 'cnon:ok',
      amountCents: 999,
      idempotencyKey: 'k2',
    });
    expect(outcome.status).toBe('succeeded');
  });

  it('maps a declined payment (status FAILED) to a 402 failed outcome — NOT a throw', async () => {
    squareClientMock.paymentsCreate.mockResolvedValue({
      payment: { id: 'sqpay_dec', status: 'FAILED', amountMoney: { amount: 2500n, currency: 'USD' } },
    });
    const outcome = await createSquareProvider(FULL_CONFIG).charge({
      orderId: 'o3',
      tokenizedSource: 'cnon:card-nonce-declined',
      amountCents: 2500,
      idempotencyKey: 'k3',
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.failure.httpStatus).toBe(402);
      expect(outcome.failure.code).toBe('FAILED');
    }
  });

  it('maps a thrown SquareError card decline to a 402 failed outcome (not a 5xx throw)', async () => {
    squareClientMock.paymentsCreate.mockRejectedValue(
      new SquareError({
        message: 'Card declined.',
        statusCode: 402,
        body: { errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'CARD_DECLINED', detail: 'Card declined.' }] },
      }),
    );
    const outcome = await createSquareProvider(FULL_CONFIG).charge({
      orderId: 'o4',
      tokenizedSource: 'cnon:card-nonce-declined',
      amountCents: 2500,
      idempotencyKey: 'k4',
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.failure.httpStatus).toBe(402);
    }
  });
});

describe('Square provider — LIVE refund (mocked SDK)', () => {
  beforeEach(() => {
    squareClientMock.refundsRefundPayment.mockReset();
  });

  it('maps a COMPLETED refund to a succeeded RefundOutcome (status lower-cased)', async () => {
    squareClientMock.refundsRefundPayment.mockResolvedValue({
      refund: { id: 'sqref_1', status: 'COMPLETED', amountMoney: { amount: 500n, currency: 'USD' } },
    });
    const outcome = await createSquareProvider(FULL_CONFIG).refund({
      paymentRef: 'sqpay_123',
      amountCents: 500,
      reason: 'customer request',
    });
    expect(outcome).toEqual({ refundRef: 'sqref_1', status: 'succeeded', amountCents: 500 });

    const req = squareClientMock.refundsRefundPayment.mock.calls[0][0];
    expect(req).toMatchObject({
      paymentId: 'sqpay_123',
      idempotencyKey: 'refund-sqpay_123-500',
      amountMoney: { amount: 500n, currency: 'USD' },
      reason: 'customer request',
    });
  });

  it('maps a PENDING refund to a pending RefundOutcome', async () => {
    squareClientMock.refundsRefundPayment.mockResolvedValue({
      refund: { id: 'sqref_2', status: 'PENDING', amountMoney: { amount: 250n, currency: 'USD' } },
    });
    const outcome = await createSquareProvider(FULL_CONFIG).refund({
      paymentRef: 'sqpay_123',
      amountCents: 250,
    });
    expect(outcome.status).toBe('pending');
    expect(outcome.refundRef).toBe('sqref_2');
  });

  it('throws a mapped PaymentProviderError when Square rejects the refund', async () => {
    squareClientMock.refundsRefundPayment.mockRejectedValue(
      new SquareError({ message: 'Already refunded', statusCode: 400 }),
    );
    await expect(
      createSquareProvider(FULL_CONFIG).refund({ paymentRef: 'sqpay_123', amountCents: 500 }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });
});

describe('Square provider — webhook signature verification', () => {
  const SIGNED_CONFIG: SquareProviderConfig = {
    ...FULL_CONFIG,
    webhookSignatureKey: 'wsk_test_key',
    webhookNotificationUrl: 'https://api.example.com/webhooks/stripe',
  };

  // Compute the signature exactly as Square does: base64(HMAC-SHA256(url + body, key)).
  function squareSignature(body: string): string {
    return createHmac('sha256', SIGNED_CONFIG.webhookSignatureKey as string)
      .update((SIGNED_CONFIG.webhookNotificationUrl as string) + body)
      .digest('base64');
  }

  it('ACCEPTS a correctly signed webhook and parses + normalizes it', () => {
    const body = JSON.stringify({
      event_id: 'evt_signed',
      type: 'payment.updated',
      data: { object: { payment: { id: 'pay_signed', status: 'COMPLETED' } } },
    });
    const sig = squareSignature(body);
    const parsed = createSquareProvider(SIGNED_CONFIG).verifyAndParseWebhook(body, (name) =>
      name === 'x-square-hmacsha256-signature' ? sig : undefined,
    );
    expect(parsed).toEqual({
      providerEventId: 'evt_signed',
      providerEventType: 'payment.updated',
      events: [{ type: 'payment_succeeded', paymentRef: 'pay_signed' }],
    });
  });

  it('REJECTS a webhook whose signature does not match (401)', () => {
    const body = JSON.stringify({ event_id: 'evt_bad', type: 'payment.updated' });
    try {
      createSquareProvider(SIGNED_CONFIG).verifyAndParseWebhook(body, (name) =>
        name === 'x-square-hmacsha256-signature' ? 'not-the-real-signature' : undefined,
      );
      expect.unreachable('should have thrown on a bad signature');
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentProviderError);
      expect((err as PaymentProviderError).status).toBe(401);
    }
  });

  it('REJECTS a tampered body under a signature computed for a different body (401)', () => {
    const sig = squareSignature('{"a":1}');
    expect(() =>
      createSquareProvider(SIGNED_CONFIG).verifyAndParseWebhook('{"a":2}', (name) =>
        name === 'x-square-hmacsha256-signature' ? sig : undefined,
      ),
    ).toThrow(PaymentProviderError);
  });

  it('surfaces the CUMULATIVE refunded total from payment.updated refunded_money', () => {
    expect(
      normalizeSquareEvent({
        type: 'payment.updated',
        data: {
          object: {
            payment: { id: 'pay_r', status: 'COMPLETED', refunded_money: { amount: 1500 } },
          },
        },
      }),
    ).toEqual([
      { type: 'payment_succeeded', paymentRef: 'pay_r' },
      { type: 'refund_completed', paymentRef: 'pay_r', refundedTotalCents: 1500 },
    ]);
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
      webhookNotificationUrl: null,
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
