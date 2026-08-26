/**
 * Wallet-pay engine — the non-React half of express checkout (Apple Pay / Google
 * Pay). Framework-free on purpose so the money math and the browser-API handling
 * can be reasoned about (and unit-tested) without rendering anything.
 *
 * There are three drivers behind one `WalletDriver` interface, picked by
 * `WalletConfig.mode` and by what the browser can actually do:
 *
 *   1. `stripe`   — cloud. Stripe.js owns the Apple Pay merchant session and the
 *                   Google Pay gateway; we get back a PaymentMethod id, which is
 *                   exactly what the card path already sends as `paymentSourceId`.
 *   2. `browser`  — sandbox, Chromium. The REAL PaymentRequest API against Google
 *                   Pay's TEST environment, which needs no Google merchant account
 *                   (docs/LOCAL-FIRST-BUILD.md §0). A real sheet, a real user
 *                   gesture, real abort semantics — no toy.
 *   3. `simulated` — sandbox, everywhere else. Apple Pay cannot be exercised
 *                   without an Apple merchant certificate, and Firefox ships no
 *                   payment handler, so the component draws the sheet itself. It
 *                   still produces the same token shape and the same outcomes
 *                   (authorize / processor decline / user abort).
 *
 * In both sandbox drivers the token is a `sbx_wallet_…` source id settled by the
 * local payment simulator, never by Stripe. The wallet's own tokenization payload
 * is discarded: a Google Pay TEST token cannot settle anywhere, and pretending it
 * could is exactly the "happy-path toy" the contract forbids.
 *
 * Two rules run through the whole file:
 *   - Money is integer cents everywhere, converted to a decimal string only at the
 *     browser boundary (the PaymentRequest API takes strings; Stripe takes cents).
 *   - Nothing here throws. Every browser call is wrapped, because a wallet that
 *     is unavailable, blocked by permissions policy, or dismissed must degrade to
 *     "no express button" and leave the card path untouched.
 */

import {
  loadStripe,
  type Stripe,
  type PaymentRequestPaymentMethodEvent,
} from '@stripe/stripe-js';
import type { PricingResult } from '@marina/core';
import type { WalletConfig } from '@/app/checkout/wallet-config';

// ===========================================================================
// Money -> wallet sheet
// ===========================================================================

/** One line on the wallet sheet. Negative amounts are discounts. */
export interface WalletLine {
  label: string;
  amountCents: number;
}

/**
 * The amount the wallet will authorize, broken into the lines the sheet shows.
 * Built from the SAME `calculatePricing` result the on-page breakdown renders, so
 * express checkout can never quote a different number than the card path.
 */
export interface WalletTotals {
  /** Lowercase ISO-4217. */
  currency: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  processingFeeCents: number;
  tipCents: number;
  totalCents: number;
  /**
   * True when tax / processing are applied authoritatively by the API at booking
   * time and are therefore not yet known here. The sheet marks the total pending
   * so the customer is not shown a precise figure we cannot honour.
   */
  estimated?: boolean;
}

/** Adapt a `calculatePricing` result into the wallet's view of the same money. */
export function walletTotalsFromPricing(
  pricing: PricingResult,
  currency: string,
  options: { estimated?: boolean } = {},
): WalletTotals {
  return {
    currency,
    subtotalCents: pricing.subtotalCents,
    discountCents: pricing.discountCents,
    taxCents: pricing.taxCents,
    processingFeeCents: pricing.processingFeeCents,
    tipCents: pricing.tipCents,
    totalCents: pricing.totalCents,
    estimated: options.estimated,
  };
}

/**
 * Integer cents -> the decimal string the PaymentRequest API requires. Done with
 * integer arithmetic rather than division so no float ever touches money.
 */
export function centsToAmountString(cents: number): string {
  const whole = Math.trunc(cents);
  const sign = whole < 0 ? '-' : '';
  const abs = Math.abs(whole);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * The sheet's line items.
 *
 * Google Pay rejects a request whose display items do not sum to the total, and
 * Apple Pay shows the discrepancy to the customer, so the last line reconciles any
 * remainder instead of letting the sheet lie or fail. That remainder is exactly
 * the operator-configured tax + processing fee when the client could not know them
 * yet, which is why it is labelled honestly rather than hidden.
 */
export function buildWalletLines(totals: WalletTotals): WalletLine[] {
  const lines: WalletLine[] = [{ label: 'Subtotal', amountCents: totals.subtotalCents }];

  if (totals.discountCents > 0) {
    lines.push({ label: 'Discount', amountCents: -totals.discountCents });
  }
  if (totals.taxCents > 0) {
    lines.push({ label: 'Tax', amountCents: totals.taxCents });
  }
  if (totals.processingFeeCents > 0) {
    lines.push({ label: 'Processing fee', amountCents: totals.processingFeeCents });
  }
  if (totals.tipCents > 0) {
    lines.push({ label: 'Tip', amountCents: totals.tipCents });
  }

  const sum = lines.reduce((acc, line) => acc + line.amountCents, 0);
  const remainder = totals.totalCents - sum;
  if (remainder !== 0) {
    lines.push({
      label: remainder > 0 ? 'Taxes & fees' : 'Adjustment',
      amountCents: remainder,
    });
  }

  return lines;
}

/** The DOM PaymentRequest payload (string amounts, uppercase currency). */
export function buildPaymentDetails(
  totals: WalletTotals,
  itemLabel: string,
): PaymentDetailsInit {
  const currency = totals.currency.toUpperCase();
  const amount = (cents: number) => ({ currency, value: centsToAmountString(cents) });

  return {
    total: {
      label: itemLabel,
      amount: amount(totals.totalCents),
      pending: totals.estimated === true,
    },
    displayItems: buildWalletLines(totals).map((line) => ({
      label: line.label,
      amount: amount(line.amountCents),
    })),
  };
}

/** Stripe's equivalent payload — same lines, but amounts stay integer cents. */
export function buildStripeRequestItems(totals: WalletTotals, itemLabel: string) {
  return {
    total: {
      label: itemLabel,
      amount: totals.totalCents,
      pending: totals.estimated === true,
    },
    displayItems: buildWalletLines(totals).map((line) => ({
      label: line.label,
      amount: line.amountCents,
    })),
  };
}

// ===========================================================================
// Sandbox source ids
// ===========================================================================

/**
 * What the sandbox wallet asks the payment simulator to do with this token.
 *
 *   `default` — no directive: the simulator applies whatever the Local Console
 *               queued (or its own default), so the console stays authoritative.
 *   `decline` — force a processor decline, so the express path's failure branch is
 *               exercisable straight from the wallet sheet.
 */
export type SandboxWalletOutcome = 'default' | 'decline';

const SANDBOX_SOURCE_PREFIX = 'sbx_wallet';

/** Underscore-free so the source id stays split-parseable. */
function nonce(): string {
  const bytes = new Uint8Array(8);
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Non-secure contexts have no WebCrypto; uniqueness (not unguessability) is all
  // a sandbox token needs, and it never authorizes real money.
  return Math.random().toString(36).slice(2).padEnd(12, '0').replace(/_/g, '0');
}

/**
 * Mint the token the sandbox settle step consumes. Grammar, fixed at five
 * underscore-separated parts so it parses with a plain `split`:
 *
 *   sbx_wallet_<brand>_<outcome>_<nonce>
 *     brand   = apple | google | card
 *     outcome = default | decline
 */
export function makeSandboxSourceId(
  brand: WalletBrand,
  outcome: SandboxWalletOutcome,
): string {
  return `${SANDBOX_SOURCE_PREFIX}_${brand}_${outcome}_${nonce()}`;
}

/** Inverse of `makeSandboxSourceId`; null when the id is not a sandbox token. */
export function parseSandboxSourceId(
  sourceId: string,
): { brand: WalletBrand; outcome: SandboxWalletOutcome } | null {
  const parts = sourceId.split('_');
  if (parts.length !== 5) return null;
  if (`${parts[0]}_${parts[1]}` !== SANDBOX_SOURCE_PREFIX) return null;

  const brand = parts[2];
  const outcome = parts[3];
  if (brand !== 'apple' && brand !== 'google' && brand !== 'card') return null;
  if (outcome !== 'default' && outcome !== 'decline') return null;

  return { brand, outcome };
}

// ===========================================================================
// Drivers
// ===========================================================================

export type WalletBrand = 'apple' | 'google' | 'card';

export const WALLET_BRAND_LABEL: Record<WalletBrand, string> = {
  apple: 'Apple Pay',
  google: 'Google Pay',
  card: 'Express checkout',
};

/** Contact details the wallet returned; used to prefill, never to bypass, the form. */
export interface WalletPayer {
  name?: string;
  email?: string;
  phone?: string;
}

/** What the sheet produced, handed to the parent's normal order pipeline. */
export interface WalletPayment {
  /** Goes through as `paymentSourceId` — the same field the card path fills. */
  sourceId: string;
  brand: WalletBrand;
  payer: WalletPayer;
}

/** The parent's answer: did the order actually get created and paid? */
export type WalletSettleResult = { ok: true } | { ok: false; error: string };

export type WalletPayOutcome =
  | { status: 'paid' }
  | { status: 'aborted' }
  | { status: 'failed'; error: string };

export type WalletSettle = (payment: WalletPayment) => Promise<WalletSettleResult>;

export interface WalletDriver {
  readonly brand: WalletBrand;
  readonly label: string;
  /** True when the sheet is ours, not the platform's — the button says so. */
  readonly simulated: boolean;
  /**
   * Open the sheet and settle. MUST be called synchronously from a click handler:
   * every platform requires `show()` inside the user gesture, so implementations
   * read the current totals through the injected getter rather than awaiting.
   */
  pay(settle: WalletSettle): Promise<WalletPayOutcome>;
}

/** Shown when we cannot say more without leaking processor internals. */
const GENERIC_FAILURE = 'The wallet payment could not be completed. Please try a card.';

export interface SandboxSheetRequest {
  brand: WalletBrand;
  label: string;
  lines: WalletLine[];
  totals: WalletTotals;
}

export type SandboxSheetChoice = { action: 'pay' | 'decline' | 'cancel' };

export interface CreateWalletDriverOptions {
  config: WalletConfig;
  /** Read at click time, so a quantity or tip change is always reflected. */
  getTotals: () => WalletTotals;
  /** Read at click time. The single line naming what is being bought. */
  getItemLabel: () => string;
  /**
   * Renders the simulated sandbox sheet. Without it, sandbox mode is limited to
   * browsers that can run the real PaymentRequest API.
   */
  sandboxSheet?: (request: SandboxSheetRequest) => Promise<SandboxSheetChoice>;
}

/**
 * Probe the environment and return a usable driver, or `null` when no wallet can
 * be offered — in which case the caller renders nothing at all. Never throws.
 */
export async function createWalletDriver(
  options: CreateWalletDriverOptions,
): Promise<WalletDriver | null> {
  const { config } = options;

  if (!config.enabled) return null;
  if (typeof window === 'undefined') return null;
  // A zero total has nothing to authorize; every platform rejects it outright.
  if (options.getTotals().totalCents <= 0) return null;

  if (config.mode === 'stripe') {
    return createStripeDriver(options);
  }

  return (await createBrowserSandboxDriver(options)) ?? createSimulatedDriver(options);
}

// --- cloud: Stripe.js -------------------------------------------------------

async function createStripeDriver(
  options: CreateWalletDriverOptions,
): Promise<WalletDriver | null> {
  const key = options.config.publishableKey;
  if (!key) return null;

  let stripe: Stripe | null = null;
  try {
    stripe = await loadStripe(key);
  } catch {
    return null; // blocked script, offline, bad key — no wallet, no error
  }
  if (!stripe) return null;

  const items = buildStripeRequestItems(options.getTotals(), options.getItemLabel());

  let request;
  try {
    request = stripe.paymentRequest({
      country: options.config.country,
      currency: options.config.currency,
      total: items.total,
      displayItems: items.displayItems,
      // Collecting at least one of these is what makes Apple Pay hand back a
      // billing address, which the processor needs for AVS.
      requestPayerName: true,
      requestPayerEmail: true,
      requestPayerPhone: true,
    });
  } catch {
    return null;
  }

  // The whole point of canMakePayment: if no wallet is enrolled on this device,
  // we must not render a button that can only disappoint.
  let available;
  try {
    available = await request.canMakePayment();
  } catch {
    return null;
  }
  if (!available) return null;

  const brand: WalletBrand = available.applePay
    ? 'apple'
    : available.googlePay
      ? 'google'
      : 'card';

  return {
    brand,
    label: WALLET_BRAND_LABEL[brand],
    simulated: false,
    pay: (settle) =>
      new Promise<WalletPayOutcome>((resolve) => {
        let settled = false;
        const finish = (outcome: WalletPayOutcome) => {
          if (settled) return;
          settled = true;
          request.off('paymentmethod', onPaymentMethod);
          request.off('cancel', onCancel);
          resolve(outcome);
        };

        const onPaymentMethod = async (event: PaymentRequestPaymentMethodEvent) => {
          let result: WalletSettleResult;
          try {
            result = await settle({
              sourceId: event.paymentMethod.id,
              brand,
              payer: {
                name: event.payerName,
                email: event.payerEmail,
                phone: event.payerPhone,
              },
            });
          } catch {
            result = { ok: false, error: GENERIC_FAILURE };
          }
          // The sheet stays open until this call, so the customer sees the
          // authorization succeed or fail inside the wallet, not after it.
          event.complete(result.ok ? 'success' : 'fail');
          finish(result.ok ? { status: 'paid' } : { status: 'failed', error: result.error });
        };

        // Stripe documents that `cancel` can arrive AFTER `paymentmethod` on some
        // platforms; the `settled` guard is what keeps that from reporting a
        // completed payment as an abort.
        const onCancel = () => finish({ status: 'aborted' });

        request.on('paymentmethod', onPaymentMethod);
        request.on('cancel', onCancel);

        try {
          // Totals can have changed since the probe (quantity, tip, promo), and
          // update() must run before show() — both inside this gesture.
          const current = buildStripeRequestItems(
            options.getTotals(),
            options.getItemLabel(),
          );
          request.update({
            currency: options.config.currency,
            total: current.total,
            displayItems: current.displayItems,
          });
          request.show();
        } catch {
          finish({ status: 'failed', error: GENERIC_FAILURE });
        }
      }),
  };
}

// --- sandbox: the real PaymentRequest API, Google Pay TEST ------------------

/**
 * Google Pay's TEST environment issues tokens to anyone — no merchant id, no
 * gateway account — which is what lets the express path run end to end on a
 * laptop with zero signups. The `example` gateway is Google's own documented
 * stand-in, and TEST tokens are inert by construction.
 */
function sandboxMethodData(merchantName: string): PaymentMethodData[] {
  return [
    {
      supportedMethods: 'https://google.com/pay',
      data: {
        environment: 'TEST',
        apiVersion: 2,
        apiVersionMinor: 0,
        merchantInfo: { merchantName },
        allowedPaymentMethods: [
          {
            type: 'CARD',
            parameters: {
              allowedAuthMethods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
              allowedCardNetworks: ['AMEX', 'DISCOVER', 'MASTERCARD', 'VISA'],
            },
            tokenizationSpecification: {
              type: 'PAYMENT_GATEWAY',
              parameters: {
                gateway: 'example',
                gatewayMerchantId: 'exampleGatewayMerchantId',
              },
            },
          },
        ],
      },
    },
  ];
}

const PAYER_OPTIONS: PaymentOptions = {
  requestPayerName: true,
  requestPayerEmail: true,
  requestPayerPhone: true,
};

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

async function createBrowserSandboxDriver(
  options: CreateWalletDriverOptions,
): Promise<WalletDriver | null> {
  if (typeof window.PaymentRequest !== 'function') return null;

  const methods = sandboxMethodData(options.config.merchantName);

  // Constructing here does double duty: it probes support AND validates our
  // display items against the browser's own money parsing, so a malformed total
  // fails now rather than under the customer's thumb.
  let probe: PaymentRequest;
  try {
    probe = new PaymentRequest(
      methods,
      buildPaymentDetails(options.getTotals(), options.getItemLabel()),
      PAYER_OPTIONS,
    );
  } catch {
    return null;
  }

  let available = false;
  try {
    available = await probe.canMakePayment();
  } catch {
    // Chromium throws NotAllowedError when canMakePayment is called too often,
    // and SecurityError outside a secure context. Both mean "not this browser".
    return null;
  }
  if (!available) return null;

  return {
    brand: 'google',
    label: WALLET_BRAND_LABEL.google,
    simulated: false,
    pay: async (settle) => {
      // A PaymentRequest may only be shown once, so each attempt gets a fresh one
      // built from the totals as they are right now.
      let request: PaymentRequest;
      try {
        request = new PaymentRequest(
          methods,
          buildPaymentDetails(options.getTotals(), options.getItemLabel()),
          PAYER_OPTIONS,
        );
      } catch {
        return { status: 'failed', error: GENERIC_FAILURE };
      }

      let response: PaymentResponse;
      try {
        response = await request.show();
      } catch (err) {
        return isAbortError(err)
          ? { status: 'aborted' }
          : { status: 'failed', error: GENERIC_FAILURE };
      }

      let result: WalletSettleResult;
      try {
        result = await settle({
          // The TEST tokenization payload in `response.details` cannot settle
          // anywhere, so it is deliberately dropped: the simulator is the
          // processor here, and it takes a sandbox source id.
          sourceId: makeSandboxSourceId('google', 'default'),
          brand: 'google',
          payer: {
            name: response.payerName ?? undefined,
            email: response.payerEmail ?? undefined,
            phone: response.payerPhone ?? undefined,
          },
        });
      } catch {
        result = { ok: false, error: GENERIC_FAILURE };
      }

      try {
        await response.complete(result.ok ? 'success' : 'fail');
      } catch {
        // The sheet can already be gone; the order state is what matters.
      }

      return result.ok
        ? { status: 'paid' }
        : { status: 'failed', error: result.error };
    },
  };
}

// --- sandbox: our own sheet -------------------------------------------------

/**
 * Which wallet a device would *actually* offer, so the simulated sheet is
 * labelled the way the customer's real one would be. UA sniffing is the only
 * signal available here, and it only picks a label.
 */
function guessPlatformBrand(): WalletBrand {
  if (typeof navigator === 'undefined') return 'card';
  const ua = navigator.userAgent;
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
  return isApple ? 'apple' : 'google';
}

function createSimulatedDriver(
  options: CreateWalletDriverOptions,
): WalletDriver | null {
  const sheet = options.sandboxSheet;
  if (!sheet) return null;

  const brand = guessPlatformBrand();

  return {
    brand,
    label: WALLET_BRAND_LABEL[brand],
    simulated: true,
    pay: async (settle) => {
      const totals = options.getTotals();
      const choice = await sheet({
        brand,
        label: WALLET_BRAND_LABEL[brand],
        lines: buildWalletLines(totals),
        totals,
      });

      if (choice.action === 'cancel') return { status: 'aborted' };

      // A "declined" wallet still hands over a token — the decline happens at the
      // processor. Settling it is what exercises the server's decline branch
      // rather than a client-side shortcut around it.
      let result: WalletSettleResult;
      try {
        result = await settle({
          sourceId: makeSandboxSourceId(
            brand,
            choice.action === 'decline' ? 'decline' : 'default',
          ),
          brand,
          payer: {},
        });
      } catch {
        result = { ok: false, error: GENERIC_FAILURE };
      }

      return result.ok
        ? { status: 'paid' }
        : { status: 'failed', error: result.error };
    },
  };
}
