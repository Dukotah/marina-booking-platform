'use client';

/**
 * "Book again as …" banner for returning guests.
 *
 * Guest checkout means no account — but we still make the *second* booking fast.
 * If a remembered guest is found in local storage (from a prior successful
 * booking on this device), this offers a one-tap prefill of the lead-guest
 * fields, plus a "Not you?" escape hatch that forgets the saved details.
 *
 * It renders nothing when there is no remembered guest, and after the guest
 * either applies or dismisses it, so it never gets in the way of a first-time
 * booking.
 */

import { UserCheck, X } from 'lucide-react';
import type { RememberedGuest } from '@/lib/guest';

interface GuestPrefillBannerProps {
  guest: RememberedGuest;
  onUse: () => void;
  onDismiss: () => void;
}

export function GuestPrefillBanner({ guest, onUse, onDismiss }: GuestPrefillBannerProps) {
  return (
    <div className="flex items-start gap-3 rounded-card border border-hairline bg-bg p-3.5">
      <UserCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">
          Welcome back, {guest.firstName}
        </p>
        <p className="truncate text-xs text-muted">{guest.email}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onUse}
            className="min-h-[40px] rounded-lg bg-ink px-4 text-sm font-semibold text-bg transition hover:opacity-90"
          >
            Book again as {guest.firstName}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex min-h-[40px] items-center gap-1 rounded-lg px-2 text-sm font-medium text-muted transition hover:text-ink"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            Not you?
          </button>
        </div>
      </div>
    </div>
  );
}

export default GuestPrefillBanner;
