/**
 * Memberships route — pure unit tests. No DB, no network.
 *
 * These pin the three things about selling a season pass that are easy to get
 * subtly wrong and expensive to get wrong:
 *
 *   1. The derived ids. Everything that makes a membership purchase exactly-once
 *      rests on the order id, the holding id and the processor key being a
 *      FUNCTION of (operator, client key) rather than freshly generated. If any of
 *      them drifts between the first submit and the retry, the unique index stops
 *      being a guard and the payment simulator rejects the replay as "same key,
 *      different parameters" — which is a double charge waiting to happen.
 *   2. What a member actually saves, delegated to @marina/core rather than
 *      re-derived (integer cents, one rounding implementation).
 *   3. What a holding's state really is. A row can sit at ACTIVE and be unusable —
 *      window passed, last punch spent — because nothing sweeps it until the next
 *      booking touches it. Telling a customer their expired pass is "Active" is the
 *      bug this locks down, and it has to agree with `isHoldingUsable` in
 *      services/memberships.ts, which is the authority at booking time.
 */
import { describe, it, expect } from 'vitest';
import {
  derivedId,
  purchaseIds,
  memberSavingsCents,
  describeBenefit,
  viewHolding,
  validateMembershipShape,
} from '../src/routes/memberships.js';

const NOW = new Date('2026-07-01T12:00:00Z');
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

describe('derivedId', () => {
  it('is stable for the same tenant + key', () => {
    expect(derivedId('mbo_', 'lsra', 'attempt-1')).toBe(derivedId('mbo_', 'lsra', 'attempt-1'));
  });

  it('separates tenants — the same client key must not address another operator\'s row', () => {
    expect(derivedId('mbo_', 'lsra', 'attempt-1')).not.toBe(derivedId('mbo_', 'other', 'attempt-1'));
  });

  it('separates attempts', () => {
    expect(derivedId('mbo_', 'lsra', 'attempt-1')).not.toBe(derivedId('mbo_', 'lsra', 'attempt-2'));
  });

  it('separates prefixes, so an order id can never collide with a holding id', () => {
    expect(derivedId('mbo_', 'lsra', 'k')).not.toBe(derivedId('mbh_', 'lsra', 'k'));
  });

  it('carries the prefix and stays short enough to read in a log', () => {
    const id = derivedId('mbo_', 'lsra', 'attempt-1');
    expect(id.startsWith('mbo_')).toBe(true);
    expect(id).toHaveLength(28);
  });

  it('does not let a key boundary be forged by shifting the separator', () => {
    // "a" + "b c" and "a b" + "c" must not hash to the same id.
    expect(derivedId('mbo_', 'a', 'b c')).not.toBe(derivedId('mbo_', 'a b', 'c'));
  });
});

describe('purchaseIds', () => {
  it('returns the same three ids for a retry of the same attempt', () => {
    const first = purchaseIds('lsra', 'attempt-1');
    const retry = purchaseIds('lsra', 'attempt-1');
    expect(retry).toEqual(first);
  });

  it('keeps the order id and the holding id distinct', () => {
    const ids = purchaseIds('lsra', 'attempt-1');
    expect(ids.orderId).not.toBe(ids.holdingId);
  });

  it('derives the processor key from the order id, so the simulator sees one order', () => {
    const ids = purchaseIds('lsra', 'attempt-1');
    expect(ids.chargeKey).toBe(`membership-${ids.orderId}`);
  });

  it('gives a different attempt a different processor key (a genuine retry re-charges)', () => {
    expect(purchaseIds('lsra', 'a').chargeKey).not.toBe(purchaseIds('lsra', 'b').chargeKey);
  });
});

describe('memberSavingsCents', () => {
  it('takes a percentage off, rounded to whole cents', () => {
    // 15% of $85.00 = $12.75 exactly.
    expect(memberSavingsCents(8500, { discountType: 'PERCENT', discountValue: 15 })).toBe(1275);
  });

  it('rounds a fractional percentage half-up rather than truncating a penny away', () => {
    // 10% of $12.35 = 123.5c -> 124c.
    expect(memberSavingsCents(1235, { discountType: 'PERCENT', discountValue: 10 })).toBe(124);
  });

  it('takes a flat amount off', () => {
    expect(memberSavingsCents(8500, { discountType: 'FLAT', discountValue: 1000 })).toBe(1000);
  });

  it('never saves more than the price — a $50-off card on a $20 rental is $20, not -$30', () => {
    expect(memberSavingsCents(2000, { discountType: 'FLAT', discountValue: 5000 })).toBe(2000);
  });

  it('saves nothing on a zero discount', () => {
    expect(memberSavingsCents(8500, { discountType: 'PERCENT', discountValue: 0 })).toBe(0);
  });

  it('is zero on a free base price', () => {
    expect(memberSavingsCents(0, { discountType: 'PERCENT', discountValue: 25 })).toBe(0);
  });
});

describe('describeBenefit', () => {
  it('describes a percentage', () => {
    expect(describeBenefit({ discountType: 'PERCENT', discountValue: 15 })).toBe(
      '15% off every booking',
    );
  });

  it('describes a flat amount in dollars, from integer cents', () => {
    expect(describeBenefit({ discountType: 'FLAT', discountValue: 1250 })).toBe(
      '$12.50 off every booking',
    );
  });

  it('does not claim a discount when there is none', () => {
    expect(describeBenefit({ discountType: 'PERCENT', discountValue: 0 })).toBe('Member access');
  });
});

describe('viewHolding', () => {
  const usable = {
    status: 'ACTIVE',
    starts_at: hoursFromNow(-24),
    expires_at: hoursFromNow(24),
    remaining_uses: null as number | null,
  };

  it('is Active for a live, in-window, unlimited pass', () => {
    expect(viewHolding(usable, NOW)).toEqual({ usable: true, label: 'Active' });
  });

  it('is Expired once the window has closed, even while the row still says ACTIVE', () => {
    expect(viewHolding({ ...usable, expires_at: hoursFromNow(-1) }, NOW)).toEqual({
      usable: false,
      label: 'Expired',
    });
  });

  it('is Scheduled before the window opens', () => {
    expect(viewHolding({ ...usable, starts_at: hoursFromNow(48) }, NOW)).toEqual({
      usable: false,
      label: 'Scheduled',
    });
  });

  it('is Used up when a punch card has no punches left, even at status ACTIVE', () => {
    expect(viewHolding({ ...usable, remaining_uses: 0 }, NOW)).toEqual({
      usable: false,
      label: 'Used up',
    });
  });

  it('is usable with punches remaining', () => {
    expect(viewHolding({ ...usable, remaining_uses: 3 }, NOW)).toEqual({
      usable: true,
      label: 'Active',
    });
  });

  it('honours a stored DEPLETED status', () => {
    expect(viewHolding({ ...usable, status: 'DEPLETED', remaining_uses: 0 }, NOW).label).toBe(
      'Used up',
    );
  });

  it('honours a stored CANCELLED status even when the window is still open', () => {
    expect(viewHolding({ ...usable, status: 'CANCELLED' }, NOW)).toEqual({
      usable: false,
      label: 'Cancelled',
    });
  });

  it('treats a null expiry as no expiry (an open-ended season pass)', () => {
    expect(viewHolding({ ...usable, expires_at: null }, NOW).usable).toBe(true);
  });
});

describe('validateMembershipShape', () => {
  it('rejects a punch card with no punches — it would be sold and never usable', () => {
    expect(
      validateMembershipShape({
        kind: 'PUNCH_CARD',
        discountType: 'PERCENT',
        discountValue: 100,
        totalUses: null,
      }),
    ).toBe('A punch card needs a positive number of uses.');
  });

  it('rejects a punch card with zero punches', () => {
    expect(
      validateMembershipShape({
        kind: 'PUNCH_CARD',
        discountType: 'PERCENT',
        discountValue: 100,
        totalUses: 0,
      }),
    ).not.toBeNull();
  });

  it('accepts a punch card with punches', () => {
    expect(
      validateMembershipShape({
        kind: 'PUNCH_CARD',
        discountType: 'PERCENT',
        discountValue: 100,
        totalUses: 10,
      }),
    ).toBeNull();
  });

  it('rejects a percentage above 100', () => {
    expect(
      validateMembershipShape({ kind: 'MEMBER_RATE', discountType: 'PERCENT', discountValue: 120 }),
    ).toBe('A percent discount cannot exceed 100.');
  });

  it('allows a flat discount larger than any one rental — applyMemberPrice clamps it', () => {
    expect(
      validateMembershipShape({ kind: 'MEMBER_RATE', discountType: 'FLAT', discountValue: 50_000 }),
    ).toBeNull();
  });

  it('does not demand uses on a season pass', () => {
    expect(
      validateMembershipShape({
        kind: 'SEASON_PASS',
        discountType: 'PERCENT',
        discountValue: 20,
        totalUses: null,
      }),
    ).toBeNull();
  });
});
