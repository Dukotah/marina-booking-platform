/**
 * Wire shapes for the memberships surface, mirroring the API's camelCase JSON
 * (`serializeMembership` / `serializeHolding` in apps/api/src/routes/memberships.ts).
 *
 * Kept in one file so the server data module, the server action and the client
 * component all agree on the contract. All money is integer cents.
 */

export type MembershipKind = 'SEASON_PASS' | 'PUNCH_CARD' | 'MEMBER_RATE';

/** A membership an operator is currently selling. */
export interface MembershipOffer {
  id: string;
  name: string;
  kind: MembershipKind;
  isActive: boolean;
  /** What it costs to buy, integer cents. */
  priceCents: number;
  discountType: 'PERCENT' | 'FLAT';
  /** PERCENT: whole percent off. FLAT: integer cents off. */
  discountValue: number;
  /** Punch cards only: how many uses a fresh card carries. */
  totalUses: number | null;
  /** Validity in days from purchase; null means it never expires. */
  durationDays: number | null;
  /** Server-rendered summary, e.g. "15% off every booking". */
  benefit: string;
}

/** A membership the signed-in customer already holds. */
export interface MembershipHolding {
  id: string;
  membershipId: string;
  membershipName: string;
  kind: string;
  status: string;
  /** Real state, not the stored enum: Active / Scheduled / Expired / Used up. */
  statusLabel: string;
  /** True when this holding would actually discount a booking made right now. */
  usable: boolean;
  remainingUses: number | null;
  benefit: string;
  startsAt: string;
  expiresAt: string | null;
  purchasedAt: string;
}

/** Everything the browser needs to get the cardholder through a 3DS challenge. */
export interface MembershipChallenge {
  intentId: string | null;
  clientSecret: string | null;
  returnUrl: string | null;
}

/** The outcome of a purchase attempt, as the client branches on it. */
export type PurchaseResult =
  | { ok: true; holding: MembershipHolding; replayed: boolean }
  | {
      ok: false;
      error: string;
      code?: string;
      challenge?: MembershipChallenge;
      /**
       * True when the failure does NOT prove the money stayed put — a dropped
       * connection, a processor timeout, a purchase already in flight. It decides
       * whether the caller keeps its idempotency key: retrying an indeterminate
       * attempt under the SAME key replays whatever really happened, while a fresh
       * key on a charge that actually succeeded is a second charge. A decline is the
       * opposite case and is not indeterminate — it is settled, and the guest trying
       * a different card is a genuinely new attempt.
       */
      indeterminate?: boolean;
    };
