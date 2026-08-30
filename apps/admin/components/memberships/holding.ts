/**
 * Presentation rules for a membership holding. Pure — no React, no Prisma — so the
 * list page, the detail page and any future report all describe a holding the same
 * way.
 *
 * The rule worth stating: a row's stored `status` is NOT its real state. Nothing
 * sweeps holdings on a schedule; an expired season pass and a spent punch card both
 * sit at ACTIVE until the next booking touches them. `isHoldingUsable` in
 * `apps/api/src/services/memberships.ts` is the authority at booking time and
 * already applies the window and the uses-left test — this mirrors it so the
 * operator is never told a pass is Active that the booking path will ignore.
 */

export type HoldingStatusLabel = 'Active' | 'Scheduled' | 'Expired' | 'Used up' | 'Cancelled';

export interface HoldingState {
  /** True when this holding would actually price a booking right now. */
  usable: boolean;
  label: HoldingStatusLabel;
  /** Tailwind classes for the badge; all pairs clear 4.5:1 on the white row. */
  badgeClass: string;
}

const BADGE: Record<HoldingStatusLabel, string> = {
  // 700-weight text on a 100-weight tint: every pair here measures above 4.5:1,
  // which the 600 variants on the same tints do not reliably do.
  Active: 'bg-emerald-100 text-emerald-800',
  Scheduled: 'bg-sky-100 text-sky-800',
  Expired: 'bg-slate-200 text-slate-700',
  'Used up': 'bg-amber-100 text-amber-900',
  Cancelled: 'bg-red-100 text-red-800',
};

export function holdingState(
  row: {
    status: string;
    starts_at: Date;
    expires_at: Date | null;
    remaining_uses: number | null;
  },
  now: Date = new Date(),
): HoldingState {
  const label = resolveLabel(row, now);
  return { usable: label === 'Active', label, badgeClass: BADGE[label] };
}

function resolveLabel(
  row: {
    status: string;
    starts_at: Date;
    expires_at: Date | null;
    remaining_uses: number | null;
  },
  now: Date,
): HoldingStatusLabel {
  if (row.status === 'CANCELLED') return 'Cancelled';
  if (row.status === 'DEPLETED') return 'Used up';
  if (row.status === 'EXPIRED') return 'Expired';
  if (row.starts_at.getTime() > now.getTime()) return 'Scheduled';
  if (row.expires_at && row.expires_at.getTime() < now.getTime()) return 'Expired';
  if (row.remaining_uses != null && row.remaining_uses <= 0) return 'Used up';
  return 'Active';
}

/** "Season pass" / "Punch card" / "Member rate" — never the raw enum. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'SEASON_PASS':
      return 'Season pass';
    case 'PUNCH_CARD':
      return 'Punch card';
    case 'MEMBER_RATE':
      return 'Member rate';
    default:
      return kind;
  }
}

/** "15% off every booking" / "$12.50 off every booking". Cents in, dollars out. */
export function benefitLabel(discountType: string, discountValue: number): string {
  if (!discountValue || discountValue <= 0) return 'Member access only';
  return discountType === 'PERCENT'
    ? `${discountValue}% off every booking`
    : `$${(discountValue / 100).toFixed(2)} off every booking`;
}

/** "10 launches" / "Unlimited" — what the holder still has. */
export function usesLabel(remainingUses: number | null): string {
  if (remainingUses == null) return 'Unlimited';
  return `${remainingUses} left`;
}

/** "90 days from purchase" / "No expiry". */
export function durationLabel(durationDays: number | null): string {
  if (durationDays == null) return 'No expiry';
  if (durationDays % 365 === 0) {
    const years = durationDays / 365;
    return years === 1 ? '1 year' : `${years} years`;
  }
  return `${durationDays} days`;
}
