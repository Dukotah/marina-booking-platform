'use client';

import { useId, useState, useTransition } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { formatUSD } from '../../lib/format';
import { issueGiftCardAction, type IssueInput } from '../../app/giftcards/actions';

type FormErrors = Partial<Record<keyof IssueInput | '_form', string>>;

const EMPTY: IssueInput = {
  amountCents: 0,
  purchaserName: null,
  purchaserEmail: null,
  recipientName: null,
  recipientEmail: null,
  message: null,
  expiresAt: null,
};

/**
 * "Issue gift card" modal dialog. Opens from the PageHeader actions slot (visible
 * only to staff with order:write). Collects the amount (in dollars → integer cents)
 * plus optional purchaser/recipient fields and an expiry date. On success it closes
 * and Next.js revalidates the list server-side.
 */
export function IssueGiftCardDialog() {
  const [open, setOpen] = useState(false);
  const [amountInput, setAmountInput] = useState('');
  const [purchaserName, setPurchaserName] = useState('');
  const [purchaserEmail, setPurchaserEmail] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [message, setMessage] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [successCode, setSuccessCode] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const amountId = useId();
  const purchaserNameId = useId();
  const purchaserEmailId = useId();
  const recipientNameId = useId();
  const recipientEmailId = useId();
  const messageId = useId();
  const expiresAtId = useId();

  // Parse dollar input → integer cents.
  const parsedCents = Math.round(
    parseFloat(amountInput.replace(/[^0-9.]/g, '') || '0') * 100,
  );

  function reset() {
    setAmountInput('');
    setPurchaserName('');
    setPurchaserEmail('');
    setRecipientName('');
    setRecipientEmail('');
    setMessage('');
    setExpiresAt('');
    setErrors({});
    setSuccessCode(null);
  }

  function close() {
    if (pending) return;
    setOpen(false);
    reset();
  }

  function validate(): FormErrors {
    const errs: FormErrors = {};
    if (!parsedCents || parsedCents <= 0) {
      errs.amountCents = 'Enter a positive amount (e.g. 25.00).';
    }
    if (purchaserEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(purchaserEmail)) {
      errs.purchaserEmail = 'Enter a valid email address.';
    }
    if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      errs.recipientEmail = 'Enter a valid email address.';
    }
    return errs;
  }

  function submit() {
    if (pending) return;
    const errs = validate();
    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }
    setErrors({});

    const input: IssueInput = {
      amountCents: parsedCents,
      purchaserName: purchaserName.trim() || null,
      purchaserEmail: purchaserEmail.trim() || null,
      recipientName: recipientName.trim() || null,
      recipientEmail: recipientEmail.trim() || null,
      message: message.trim() || null,
      // Convert date-input value (YYYY-MM-DD) to ISO-8601 datetime for the API.
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };

    startTransition(async () => {
      const result = await issueGiftCardAction(input);
      if (result.ok) {
        setSuccessCode(result.giftCard.code);
      } else {
        setErrors({ _form: result.error });
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800"
      >
        <Plus className="h-4 w-4" aria-hidden />
        Issue gift card
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Issue gift card"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="my-8 w-full max-w-lg rounded-xl bg-white shadow-xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="text-lg font-semibold text-slate-900">Issue gift card</h2>
              <button
                type="button"
                onClick={close}
                disabled={pending}
                aria-label="Close"
                className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>

            {/* Success state */}
            {successCode ? (
              <div className="px-5 py-6 text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
                  <svg
                    className="h-6 w-6 text-emerald-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-slate-900">Gift card issued</p>
                <p className="mt-1 text-xs text-slate-500">
                  Card code — share this with the recipient:
                </p>
                <p className="mt-2 rounded-lg bg-slate-100 px-4 py-2 font-mono text-lg font-bold tracking-widest text-slate-900">
                  {successCode}
                </p>
                <p className="mt-2 text-xs text-slate-400">
                  Value: {formatUSD(parsedCents)}
                </p>
                <div className="mt-5 flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      reset();
                      setOpen(true);
                    }}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Issue another
                  </button>
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Form body */}
                <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-5">
                  {/* Amount */}
                  <div>
                    <label htmlFor={amountId} className="text-sm font-semibold text-slate-800">
                      Amount (USD) <span className="text-red-500">*</span>
                    </label>
                    <input
                      id={amountId}
                      inputMode="decimal"
                      value={amountInput}
                      onChange={(e) => setAmountInput(e.target.value)}
                      disabled={pending}
                      placeholder="25.00"
                      className={cn(
                        'mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200',
                        errors.amountCents
                          ? 'border-red-300 focus:border-red-300'
                          : 'border-slate-200 focus:border-slate-300',
                      )}
                    />
                    {errors.amountCents ? (
                      <p className="mt-1 text-xs text-red-600">{errors.amountCents}</p>
                    ) : null}
                  </div>

                  {/* Purchaser */}
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-semibold text-slate-800">
                      Purchaser{' '}
                      <span className="font-normal text-slate-400">(optional)</span>
                    </legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label
                          htmlFor={purchaserNameId}
                          className="block text-xs font-medium text-slate-600"
                        >
                          Name
                        </label>
                        <input
                          id={purchaserNameId}
                          type="text"
                          value={purchaserName}
                          onChange={(e) => setPurchaserName(e.target.value)}
                          disabled={pending}
                          maxLength={160}
                          placeholder="Alex Johnson"
                          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={purchaserEmailId}
                          className="block text-xs font-medium text-slate-600"
                        >
                          Email
                        </label>
                        <input
                          id={purchaserEmailId}
                          type="email"
                          value={purchaserEmail}
                          onChange={(e) => setPurchaserEmail(e.target.value)}
                          disabled={pending}
                          maxLength={320}
                          placeholder="alex@example.com"
                          className={cn(
                            'mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200',
                            errors.purchaserEmail
                              ? 'border-red-300'
                              : 'border-slate-200 focus:border-slate-300',
                          )}
                        />
                        {errors.purchaserEmail ? (
                          <p className="mt-1 text-xs text-red-600">{errors.purchaserEmail}</p>
                        ) : null}
                      </div>
                    </div>
                  </fieldset>

                  {/* Recipient */}
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-semibold text-slate-800">
                      Recipient{' '}
                      <span className="font-normal text-slate-400">(optional)</span>
                    </legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label
                          htmlFor={recipientNameId}
                          className="block text-xs font-medium text-slate-600"
                        >
                          Name
                        </label>
                        <input
                          id={recipientNameId}
                          type="text"
                          value={recipientName}
                          onChange={(e) => setRecipientName(e.target.value)}
                          disabled={pending}
                          maxLength={160}
                          placeholder="Sam Rivera"
                          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={recipientEmailId}
                          className="block text-xs font-medium text-slate-600"
                        >
                          Email
                        </label>
                        <input
                          id={recipientEmailId}
                          type="email"
                          value={recipientEmail}
                          onChange={(e) => setRecipientEmail(e.target.value)}
                          disabled={pending}
                          maxLength={320}
                          placeholder="sam@example.com"
                          className={cn(
                            'mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200',
                            errors.recipientEmail
                              ? 'border-red-300'
                              : 'border-slate-200 focus:border-slate-300',
                          )}
                        />
                        {errors.recipientEmail ? (
                          <p className="mt-1 text-xs text-red-600">{errors.recipientEmail}</p>
                        ) : null}
                      </div>
                    </div>
                  </fieldset>

                  {/* Message + expiry */}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor={messageId}
                        className="block text-sm font-semibold text-slate-800"
                      >
                        Message{' '}
                        <span className="font-normal text-slate-400">(optional)</span>
                      </label>
                      <textarea
                        id={messageId}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        disabled={pending}
                        rows={3}
                        maxLength={1000}
                        placeholder="Happy birthday! Enjoy your next adventure."
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={expiresAtId}
                        className="block text-sm font-semibold text-slate-800"
                      >
                        Expiry date{' '}
                        <span className="font-normal text-slate-400">(optional)</span>
                      </label>
                      <input
                        id={expiresAtId}
                        type="date"
                        value={expiresAt}
                        onChange={(e) => setExpiresAt(e.target.value)}
                        disabled={pending}
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200"
                      />
                    </div>
                  </div>

                  {errors._form ? (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                      {errors._form}
                    </p>
                  ) : null}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
                  <button
                    type="button"
                    onClick={close}
                    disabled={pending}
                    className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={pending}
                    className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {pending ? 'Issuing…' : 'Issue gift card'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
