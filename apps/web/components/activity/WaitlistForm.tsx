'use client';

/**
 * Inline waitlist signup for one sold-out timeslot.
 *
 * Rendered by TimeSlotPicker when the guest taps a "Sold out · Join waitlist"
 * chip. Tiny on purpose: name + email (+ optional phone) → one POST → a plain
 * confirmation. No hold is placed and no timer runs — if a spot opens, the
 * marina emails a booking link and the first guest to book gets it, which is
 * exactly what the confirmation copy says.
 */
import { useState } from 'react';
import { joinWaitlist, isApiError } from '@/lib/api';
import { formatTime } from '@/lib/format';

interface WaitlistFormProps {
  timeslotId: string;
  /** ISO datetime of the sold-out slot, for the heading ("10:00 AM"). */
  datetime: string;
  /** Collapse the form (the little "Cancel" affordance). */
  onDismiss: () => void;
}

const inputClasses =
  'w-full rounded-lg border border-hairline bg-surface px-3 py-2.5 text-sm text-ink ' +
  'placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-accent-ink focus-visible:ring-offset-1';

export function WaitlistForm({ timeslotId, datetime, onDismiss }: WaitlistFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !/.+@.+\..+/.test(trimmedEmail)) {
      setError('Please add your name and a valid email so we can reach you.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await joinWaitlist({
        timeslotId,
        name: trimmedName,
        email: trimmedEmail,
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      });
      setDone(true);
    } catch (err) {
      setError(
        isApiError(err) && err.message
          ? err.message
          : 'Something went wrong joining the waitlist. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div
        role="status"
        className="mt-3 rounded-lg border border-hairline bg-surface px-4 py-3 text-sm"
      >
        <p className="font-semibold text-ink">You&rsquo;re on the waitlist.</p>
        <p className="mt-0.5 text-muted">
          We&rsquo;ll email you if a spot opens up for {formatTime(datetime)}. Spots go to
          whoever books first, so keep an eye on your inbox.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 rounded-lg border border-hairline bg-surface p-4"
      aria-label={`Join the waitlist for ${formatTime(datetime)}`}
    >
      <p className="text-sm font-semibold text-ink">
        Join the waitlist for {formatTime(datetime)}
      </p>
      <p className="mt-0.5 text-xs text-muted">
        If a spot opens up, we&rsquo;ll email you a booking link. First come, first served.
      </p>

      {error && (
        <p role="alert" className="mt-2 rounded-lg border border-danger px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        <label className="block text-xs font-medium text-muted">
          Your name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
            className={`mt-1 ${inputClasses}`}
          />
        </label>
        <label className="block text-xs font-medium text-muted">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            inputMode="email"
            required
            className={`mt-1 ${inputClasses}`}
          />
        </label>
        <label className="block text-xs font-medium text-muted sm:col-span-2">
          Phone <span className="font-normal">(optional)</span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
            inputMode="tel"
            className={`mt-1 ${inputClasses}`}
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Joining…' : 'Join waitlist'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-sm font-medium text-muted transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export default WaitlistForm;
