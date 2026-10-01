/**
 * Unit tests for the manager-approval gate (Singenuity §2). Pure decision logic —
 * no DB, no provider — so these run anywhere alongside the other unit suites.
 *
 * Covers: no policy = never required; the amount threshold on both payments and
 * refunds; the refund-always-requires-approval flag; and the self-approval carve-
 * out for a caller holding `order:approve` (required stays true for the audit, but
 * they are not blocked).
 */
import { describe, it, expect } from 'vitest';
import type { AuthContext } from '@marina/auth';
import { evaluateApproval } from '../src/services/approvals.js';

/** Build an AuthContext for a role with no per-member extras. */
function ctx(role: AuthContext['role']): AuthContext {
  return {
    operatorId: 'op1',
    userId: `user-${role}`,
    role,
    extraPermissions: [],
    locationIds: [],
  };
}

const NO_POLICY = { approvalThresholdCents: null, refundRequiresApproval: false };

describe('evaluateApproval — no policy configured', () => {
  it('never requires approval when threshold is null and refund flag is off', () => {
    const d = evaluateApproval({
      action: 'payment',
      amountCents: 1_000_000,
      policy: NO_POLICY,
      auth: ctx('STAFF'),
    });
    expect(d.required).toBe(false);
    expect(d.blocked).toBe(false);
  });

  it('treats a zero threshold as "no amount gate"', () => {
    const d = evaluateApproval({
      action: 'refund',
      amountCents: 999_999,
      policy: { approvalThresholdCents: 0, refundRequiresApproval: false },
      auth: ctx('STAFF'),
    });
    expect(d.required).toBe(false);
  });
});

describe('evaluateApproval — amount threshold', () => {
  const policy = { approvalThresholdCents: 20_000, refundRequiresApproval: false };

  it('does not require approval below the threshold', () => {
    const d = evaluateApproval({ action: 'payment', amountCents: 19_999, policy, auth: ctx('STAFF') });
    expect(d.required).toBe(false);
    expect(d.blocked).toBe(false);
  });

  it('requires approval AT the threshold (inclusive) and blocks a line staffer', () => {
    const d = evaluateApproval({ action: 'payment', amountCents: 20_000, policy, auth: ctx('STAFF') });
    expect(d.required).toBe(true);
    expect(d.blocked).toBe(true);
    expect(d.reason).toBeTruthy();
  });

  it('requires approval above the threshold for refunds too', () => {
    const d = evaluateApproval({ action: 'refund', amountCents: 50_000, policy, auth: ctx('STAFF') });
    expect(d.required).toBe(true);
    expect(d.blocked).toBe(true);
  });

  it('a manager (order:approve) self-approves — required but not blocked', () => {
    const d = evaluateApproval({ action: 'payment', amountCents: 500_000, policy, auth: ctx('MANAGER') });
    expect(d.required).toBe(true);
    expect(d.blocked).toBe(false);
  });
});

describe('evaluateApproval — refund_requires_approval flag', () => {
  const policy = { approvalThresholdCents: null, refundRequiresApproval: true };

  it('requires approval for ANY refund regardless of amount', () => {
    const d = evaluateApproval({ action: 'refund', amountCents: 1, policy, auth: ctx('STAFF') });
    expect(d.required).toBe(true);
    expect(d.blocked).toBe(true);
  });

  it('does NOT gate payments when only the refund flag is set', () => {
    const d = evaluateApproval({ action: 'payment', amountCents: 999_999, policy, auth: ctx('STAFF') });
    expect(d.required).toBe(false);
    expect(d.blocked).toBe(false);
  });

  it('a manager clears the always-on refund gate', () => {
    const d = evaluateApproval({ action: 'refund', amountCents: 1, policy, auth: ctx('OWNER') });
    expect(d.required).toBe(true);
    expect(d.blocked).toBe(false);
  });

  it('an admin (inherits order:approve) clears the gate', () => {
    const d = evaluateApproval({ action: 'refund', amountCents: 1, policy, auth: ctx('ADMIN') });
    expect(d.blocked).toBe(false);
  });

  it('a GUIDE (no approve permission) is blocked', () => {
    const d = evaluateApproval({ action: 'refund', amountCents: 1, policy, auth: ctx('GUIDE') });
    expect(d.blocked).toBe(true);
  });
});

describe('evaluateApproval — per-member extra permission', () => {
  it('a STAFF member granted order:approve as an extra self-approves', () => {
    const auth: AuthContext = { ...ctx('STAFF'), extraPermissions: ['order:approve'] };
    const d = evaluateApproval({
      action: 'refund',
      amountCents: 1,
      policy: { approvalThresholdCents: null, refundRequiresApproval: true },
      auth,
    });
    expect(d.required).toBe(true);
    expect(d.blocked).toBe(false);
  });
});

describe('evaluateApproval — register discounts and comps (red-team P2)', () => {
  const policy = { approvalThresholdCents: 5000, refundRequiresApproval: false };

  it('a STAFF discount at/over the threshold is blocked', () => {
    const d = evaluateApproval({ action: 'discount', amountCents: 5000, policy, auth: ctx('STAFF') });
    expect(d.required).toBe(true);
    expect(d.blocked).toBe(true);
    expect(d.reason).toMatch(/discount\/comp/i);
  });

  it('a STAFF discount under the threshold passes without approval', () => {
    const d = evaluateApproval({ action: 'discount', amountCents: 4999, policy, auth: ctx('STAFF') });
    expect(d.required).toBe(false);
    expect(d.blocked).toBe(false);
  });

  it('a manager self-approves a large comp (required stays true for the audit)', () => {
    const d = evaluateApproval({ action: 'discount', amountCents: 25000, policy, auth: ctx('OWNER') });
    expect(d.required).toBe(true);
    expect(d.blocked).toBe(false);
  });

  it('no threshold configured = discounts never gated (matches payments today)', () => {
    const d = evaluateApproval({ action: 'discount', amountCents: 99999, policy: NO_POLICY, auth: ctx('STAFF') });
    expect(d.required).toBe(false);
  });
});
