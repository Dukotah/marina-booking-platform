'use client';

/**
 * Public gift-card purchase form (Estate warm theme).
 *
 * Pick a denomination, name the recipient, add an optional message, and buy. The
 * amount shown is the amount charged and the amount loaded — the server re-derives
 * it from its allowed set, so what the buyer sees is what settles. On success we
 * show the issued code and confirm the email went to the recipient.
 *
 * All money is integer cents. The denomination list here MUST match the API's
 * GIFT_CARD_DENOMINATIONS_CENTS; a value not in the server set is rejected.
 */

import * as React from 'react';
import { formatUSD } from '@/lib/format';
import { buyGiftCard, type GiftActionResult } from '@/app/gift/actions';

/** Allowed denominations, integer cents — mirrors the API price authority. */
const DENOMINATIONS_CENTS = [2_500, 5_000, 10_000, 15_000, 20_000, 25_000, 50_000];

const fieldLabel = 'block text-sm font-medium text-[var(--ink)] mb-1.5';
const fieldBase =
  'w-full min-h-[44px] rounded-lg border border-[var(--hairline)] bg-[var(--surface)] ' +
  'px-3 py-2 text-[var(--ink)] placeholder:text-[var(--muted)] ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--accent-ink)]';

export default function GiftCardForm() {
  const [amountCents, setAmountCents] = React.useState<number>(DENOMINATIONS_CENTS[1]!);
  const [recipientEmail, setRecipientEmail] = React.useState('');
  const [recipientName, setRecipientName] = React.useState('');
  const [purchaserName, setPurchaserName] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<GiftActionResult | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setResult(null);
    const res = await buyGiftCard({
      amountCents,
      recipientEmail,
      recipientName: recipientName.trim() || undefined,
      purchaserName: purchaserName.trim() || undefined,
      message: message.trim() || undefined,
    });
    setResult(res);
    setPending(false);
  }

  if (result?.ok) {
    return (
      <div
        className="rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] p-6 sm:p-8"
        role="status"
      >
        <h2 className="text-xl font-semibold text-[var(--ink)]">Your gift card is on its way</h2>
        <p className="mt-2 text-[var(--muted)]">
          We charged {formatUSD(result.amountChargedCents)} and loaded the same amount onto a new
          gift card.
          {result.emailSent
            ? ` We emailed the code to ${result.recipientEmail}.`
            : ' Share the code below with your recipient.'}
        </p>
        <div className="mt-5 rounded-xl bg-[var(--ink)] px-4 py-5 text-center">
          <p className="font-mono text-2xl font-bold tracking-[0.2em] text-[var(--bg)]">
            {result.code}
          </p>
        </div>
        <p className="mt-4 text-sm text-[var(--muted)]">
          Keep this code safe &mdash; anyone who has it can spend the balance. Enter it at checkout
          to apply it toward a reservation.
        </p>
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setRecipientEmail('');
            setRecipientName('');
            setMessage('');
          }}
          className="mt-6 inline-flex min-h-[44px] items-center rounded-lg border border-[var(--hairline)] px-4 text-[var(--ink)] hover:bg-[var(--bg)]"
        >
          Buy another gift card
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-2xl border border-[var(--hairline)] bg-[var(--surface)] p-6 sm:p-8"
    >
      <fieldset className="mb-6">
        <legend className={fieldLabel}>Amount</legend>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {DENOMINATIONS_CENTS.map((cents) => {
            const selected = cents === amountCents;
            return (
              <button
                key={cents}
                type="button"
                aria-pressed={selected}
                onClick={() => setAmountCents(cents)}
                className={
                  'min-h-[44px] rounded-lg border px-2 text-sm font-semibold transition ' +
                  (selected
                    ? 'border-[var(--accent-ink)] bg-[var(--accent)] text-[var(--bg)]'
                    : 'border-[var(--hairline)] bg-[var(--surface)] text-[var(--ink)] hover:border-[var(--accent-ink)]')
                }
              >
                {formatUSD(cents)}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mb-4">
        <label htmlFor="recipientEmail" className={fieldLabel}>
          Recipient email
        </label>
        <input
          id="recipientEmail"
          type="email"
          required
          autoComplete="email"
          value={recipientEmail}
          onChange={(e) => setRecipientEmail(e.target.value)}
          placeholder="them@example.com"
          className={fieldBase}
        />
      </div>

      <div className="mb-4">
        <label htmlFor="recipientName" className={fieldLabel}>
          Recipient name <span className="text-[var(--muted)]">(optional)</span>
        </label>
        <input
          id="recipientName"
          type="text"
          maxLength={160}
          value={recipientName}
          onChange={(e) => setRecipientName(e.target.value)}
          placeholder="Alex"
          className={fieldBase}
        />
      </div>

      <div className="mb-4">
        <label htmlFor="purchaserName" className={fieldLabel}>
          Your name <span className="text-[var(--muted)]">(optional)</span>
        </label>
        <input
          id="purchaserName"
          type="text"
          maxLength={160}
          value={purchaserName}
          onChange={(e) => setPurchaserName(e.target.value)}
          placeholder="Jordan"
          className={fieldBase}
        />
      </div>

      <div className="mb-6">
        <label htmlFor="message" className={fieldLabel}>
          Gift message <span className="text-[var(--muted)]">(optional)</span>
        </label>
        <textarea
          id="message"
          rows={3}
          maxLength={500}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Enjoy a day on the water!"
          className={fieldBase}
        />
      </div>

      {result && !result.ok ? (
        <p className="mb-4 rounded-lg border border-[var(--danger)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--danger)]" role="alert">
          {result.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-[var(--ink)] px-4 text-base font-semibold text-[var(--bg)] disabled:opacity-60"
      >
        {pending ? 'Processing…' : `Buy a ${formatUSD(amountCents)} gift card`}
      </button>
      <p className="mt-3 text-center text-xs text-[var(--muted)]">
        The amount shown is what you pay and what loads onto the card.
      </p>
    </form>
  );
}
