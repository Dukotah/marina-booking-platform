'use client';

/**
 * Guest-checkout "remember me" store.
 *
 * Sub-30-second re-bookings: after a guest completes checkout (no account
 * required), we stash their contact details in localStorage so the next visit
 * can one-tap prefill the guest form ("Book again as …"). This is a pure
 * convenience cache on the customer's own device — it holds only what the guest
 * already typed, never anything server-authoritative, and can be cleared by the
 * guest at any time.
 *
 * Design notes:
 *   - Namespaced + versioned key so a shape change can't crash old clients.
 *   - Every read is defensively parsed and validated; any corruption yields null
 *     (never throws) so a bad cache can never break the checkout page.
 *   - SSR-safe: all access is guarded on `typeof window` so importing this in a
 *     server-rendered client component is harmless until it actually runs.
 *   - Card/payment data is NEVER stored here — only name/email/phone.
 */

const STORAGE_KEY = 'marina.guest.v1';

/** The remembered guest identity — exactly the checkout lead-guest fields. */
export interface RememberedGuest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** Epoch ms of the last successful booking, for freshness / display. */
  savedAt: number;
}

function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    // Some privacy modes throw on property access.
    return false;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Read the remembered guest, or null if none / unreadable / invalid. Requires at
 * least a name + email to be considered usable for prefill.
 */
export function loadRememberedGuest(): RememberedGuest | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const g = parsed as Record<string, unknown>;
    if (!isNonEmptyString(g.firstName) || !isNonEmptyString(g.lastName)) return null;
    if (!isNonEmptyString(g.email)) return null;
    return {
      firstName: g.firstName,
      lastName: g.lastName,
      email: g.email,
      phone: isNonEmptyString(g.phone) ? g.phone : '',
      savedAt: typeof g.savedAt === 'number' ? g.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Persist the guest's contact details for a future "book again". Silently no-ops
 * if storage is unavailable or the details are incomplete (name+email required).
 * Trims values; never stores payment data.
 */
export function saveRememberedGuest(guest: {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
}): void {
  if (!hasStorage()) return;
  const firstName = guest.firstName.trim();
  const lastName = guest.lastName.trim();
  const email = guest.email.trim();
  if (!firstName || !lastName || !email) return;
  const record: RememberedGuest = {
    firstName,
    lastName,
    email,
    phone: (guest.phone ?? '').trim(),
    savedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Quota / privacy mode — remembering is best-effort, so ignore.
  }
}

/** Forget the remembered guest ("not you?" / privacy). Never throws. */
export function clearRememberedGuest(): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
