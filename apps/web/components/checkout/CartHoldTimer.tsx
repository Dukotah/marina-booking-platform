'use client';

/**
 * Cart-hold countdown — the customer-facing half of the cart-hold timer.
 *
 * On mount it asks the API to reserve the selected seats (POST /api/holds) for the
 * operator's hold window, then ticks a live countdown down to the hold's expiry.
 * While the hold is live those seats are subtracted from availability, so a second
 * guest can't reach "pay" for the same last seat. The hold id is reported up via
 * `onHold` so the booking submit can send it back (the API consumes it on booking).
 *
 * Fails SOFT: if the hold can't be placed (slot already taken, API hiccup) the
 * banner shows a gentle note and booking still proceeds — the server's own capacity
 * check is the authority, the hold is only an early-warning convenience. When the
 * countdown reaches zero the banner flips to "time's up" and asks the guest to
 * refresh; the booking would otherwise fail its capacity check anyway.
 *
 * Estate (warm) tokens only — no blue/indigo/sky. 44px is not needed (no tap
 * target); the refresh link meets the text-link affordance.
 */
import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { createCartHold, releaseCartHold, isApiError } from '@/lib/api';

interface CartHoldTimerProps {
  timeslotId: string;
  seats: number;
  /** Reports the live hold id (or null once it lapses / fails) to the parent. */
  onHold: (holdId: string | null) => void;
}

type Phase =
  | { kind: 'placing' }
  | { kind: 'held'; expiresAt: number }
  | { kind: 'expired' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error' };

/** mm:ss for a non-negative millisecond remainder. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function CartHoldTimer({ timeslotId, seats, onHold }: CartHoldTimerProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'placing' });
  const [remaining, setRemaining] = useState<number>(0);
  const heldIdRef = useRef<string | null>(null);

  // Place the hold once per (timeslot, seats). Re-run if the guest changes party
  // size — the old hold is released and a right-sized one is taken.
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'placing' });

    (async () => {
      try {
        const hold = await createCartHold({ timeslotId, seats });
        if (cancelled) {
          // The effect was superseded before the hold landed — free it immediately.
          void releaseCartHold(hold.holdId);
          return;
        }
        heldIdRef.current = hold.holdId;
        onHold(hold.holdId);
        setPhase({ kind: 'held', expiresAt: new Date(hold.expiresAt).getTime() });
      } catch (err) {
        if (cancelled) return;
        heldIdRef.current = null;
        onHold(null);
        if (isApiError(err) && err.status === 409) {
          setPhase({
            kind: 'unavailable',
            message: err.message || 'Those seats were just taken. Please pick another time.',
          });
        } else {
          // Soft failure: let the guest continue; the server will enforce capacity.
          setPhase({ kind: 'error' });
        }
      }
    })();

    return () => {
      cancelled = true;
      // Release the hold when the guest leaves checkout or changes seats, so the
      // seats free immediately rather than waiting out the full window.
      const id = heldIdRef.current;
      heldIdRef.current = null;
      if (id) {
        onHold(null);
        void releaseCartHold(id);
      }
    };
    // onHold is a stable setter from the parent; intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeslotId, seats]);

  // Tick the countdown while a hold is live.
  useEffect(() => {
    if (phase.kind !== 'held') return;
    const tick = () => {
      const ms = phase.expiresAt - Date.now();
      if (ms <= 0) {
        setRemaining(0);
        setPhase({ kind: 'expired' });
        heldIdRef.current = null;
        onHold(null);
        return;
      }
      setRemaining(ms);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, phase.kind === 'held' ? phase.expiresAt : 0]);

  // Nothing to show while a soft error means "just proceed".
  if (phase.kind === 'error') return null;

  if (phase.kind === 'placing') {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-hairline bg-surface px-4 py-3 text-sm text-muted"
        aria-live="polite"
      >
        <Clock className="h-4 w-4 shrink-0" aria-hidden />
        <span>Reserving your spot&hellip;</span>
      </div>
    );
  }

  if (phase.kind === 'unavailable') {
    return (
      <div
        className="flex items-start gap-2 rounded-lg border border-hairline bg-surface px-4 py-3 text-sm text-ink"
        role="alert"
      >
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span>{phase.message}</span>
      </div>
    );
  }

  if (phase.kind === 'expired') {
    return (
      <div
        className="flex items-start gap-2 rounded-lg border border-hairline bg-surface px-4 py-3 text-sm text-ink"
        role="alert"
      >
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span>
          Your held spot timed out.{' '}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="font-semibold underline underline-offset-2 hover:opacity-80"
          >
            Refresh to check availability
          </button>
          .
        </span>
      </div>
    );
  }

  // Live hold — the countdown.
  const low = remaining <= 60_000;
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-hairline bg-surface px-4 py-3 text-sm text-ink"
      aria-live="off"
    >
      <Clock className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      <span>
        We&rsquo;re holding your spot for{' '}
        <strong
          className={low ? 'tabular-nums text-danger' : 'tabular-nums text-ink'}
          aria-label={`${formatRemaining(remaining)} remaining`}
        >
          {formatRemaining(remaining)}
        </strong>
        .
      </span>
    </div>
  );
}
