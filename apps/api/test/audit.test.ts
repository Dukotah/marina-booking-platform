/**
 * Audit log — pure unit tests (no DB, no network). Covers the two pieces that
 * decide whether the compliance record is trustworthy:
 *   - diffRecords: only real changes survive, added/removed fields are visible,
 *     and money/date values are not mangled on the way in;
 *   - sanitize / isSecretKey: secrets are redacted by key name AND by value
 *     shape, without eating the fields an investigator actually needs.
 */
import { describe, it, expect } from 'vitest';
import {
  AUDIT_ACTIONS,
  MONEY_ACTIONS,
  REDACTED,
  buildAuditData,
  clampPayload,
  diffRecords,
  isSecretKey,
  looksLikeCardNumber,
  sanitize,
  staffActor,
  toPlain,
} from '../src/services/audit.js';

describe('diffRecords', () => {
  it('keeps only the fields that actually changed', () => {
    const d = diffRecords(
      { email: 'a@example.com', phone: '707-555-0100', first_name: 'Dale' },
      { email: 'b@example.com', phone: '707-555-0100', first_name: 'Dale' },
    );
    expect(d.changedKeys).toEqual(['email']);
    expect(d.before).toEqual({ email: 'a@example.com' });
    expect(d.after).toEqual({ email: 'b@example.com' });
  });

  it('records an empty diff — not a fake change — when nothing moved', () => {
    const row = { status: 'PAID', amount_cents: 12000 };
    const d = diffRecords(row, { ...row });
    expect(d.changedKeys).toEqual([]);
    expect(d.before).toEqual({});
    expect(d.after).toEqual({});
  });

  it('treats a missing before as a creation', () => {
    const d = diffRecords(undefined, { id: 'ord_1', total_cents: 9900 });
    expect(d.before).toBeNull();
    expect(d.after).toEqual({ id: 'ord_1', total_cents: 9900 });
    expect(d.changedKeys).toEqual(['id', 'total_cents']);
  });

  it('treats a missing after as a deletion', () => {
    const d = diffRecords({ id: 'cus_1', email: 'gone@example.com' }, undefined);
    expect(d.after).toBeNull();
    expect(d.before).toEqual({ id: 'cus_1', email: 'gone@example.com' });
  });

  it('shows a field that was added and a field that was removed', () => {
    const d = diffRecords({ notes: 'dock B' }, { tags: ['vip'] });
    expect(d.changedKeys).toEqual(['notes', 'tags']);
    expect(d.before).toEqual({ notes: 'dock B', tags: null });
    expect(d.after).toEqual({ notes: null, tags: ['vip'] });
  });

  it('compares nested objects structurally, not by reference', () => {
    const unchanged = diffRecords(
      { config: { reminder_hours: 24, from: 'dock@marina.test' } },
      { config: { from: 'dock@marina.test', reminder_hours: 24 } },
    );
    expect(unchanged.changedKeys).toEqual([]);

    const changed = diffRecords(
      { config: { reminder_hours: 24 } },
      { config: { reminder_hours: 2 } },
    );
    expect(changed.changedKeys).toEqual(['config']);
    expect(changed.after).toEqual({ config: { reminder_hours: 2 } });
  });

  it('compares arrays by order and length', () => {
    expect(diffRecords({ tags: ['a', 'b'] }, { tags: ['a', 'b'] }).changedKeys).toEqual([]);
    expect(diffRecords({ tags: ['a', 'b'] }, { tags: ['b', 'a'] }).changedKeys).toEqual(['tags']);
    expect(diffRecords({ tags: ['a'] }, { tags: ['a', 'b'] }).changedKeys).toEqual(['tags']);
  });

  it('does not confuse an integer-cents amount with its string form', () => {
    const d = diffRecords({ amount_cents: 12000 }, { amount_cents: '12000' });
    expect(d.changedKeys).toEqual(['amount_cents']);
  });

  it('sees a same-instant Date and ISO string as equal', () => {
    const iso = '2026-08-26T17:30:00.000Z';
    expect(diffRecords({ starts_at: new Date(iso) }, { starts_at: iso }).changedKeys).toEqual([]);
  });

  it('wraps a non-object subject so the diff shape stays uniform', () => {
    const d = diffRecords('OPEN', 'CANCELLED');
    expect(d.before).toEqual({ value: 'OPEN' });
    expect(d.after).toEqual({ value: 'CANCELLED' });
  });

  it('detects a changed secret without revealing either value', () => {
    const d = diffRecords({ api_key: 'old-key-aaa' }, { api_key: 'new-key-bbb' });
    expect(d.changedKeys).toEqual(['api_key']);
    expect(d.before).toEqual({ api_key: REDACTED });
    expect(d.after).toEqual({ api_key: REDACTED });
  });

  it('ignores undefined properties rather than logging them as nulls', () => {
    const d = diffRecords({ note: 'x' }, { note: 'x', middle_name: undefined });
    expect(d.changedKeys).toEqual([]);
  });
});

describe('isSecretKey', () => {
  it('matches secret names regardless of separator or case', () => {
    for (const key of ['password', 'API_KEY', 'apiKey', 'client-secret', 'refresh_token', 'CVV']) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it('matches whole-word-only secrets without swallowing lookalikes', () => {
    expect(isSecretKey('pin')).toBe(true);
    expect(isSecretKey('shipping_address')).toBe(false);
    expect(isSecretKey('key')).toBe(true);
    expect(isSecretKey('monkey')).toBe(false);
  });

  it('leaves the fields an investigator needs readable', () => {
    for (const key of ['auth_user_id', 'actor', 'email', 'phone', 'amount_cents', 'order_id']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe('looksLikeCardNumber', () => {
  it('accepts Luhn-valid PANs with or without separators', () => {
    expect(looksLikeCardNumber('4242424242424242')).toBe(true);
    expect(looksLikeCardNumber('4242 4242 4242 4242')).toBe(true);
    expect(looksLikeCardNumber('4242-4242-4242-4242')).toBe(true);
  });

  it('rejects digit strings that are not cards', () => {
    expect(looksLikeCardNumber('4242424242424243')).toBe(false); // fails Luhn
    expect(looksLikeCardNumber('7075550100')).toBe(false); // phone, too short
    expect(looksLikeCardNumber('1756228200000')).toBe(false); // epoch millis
    expect(looksLikeCardNumber('not a number')).toBe(false);
  });
});

describe('sanitize', () => {
  it('redacts a whole subtree when the key is a secret', () => {
    const out = sanitize(toPlain({ stripe_secret: { live: 'x', test: 'y' } }));
    expect(out).toEqual({ stripe_secret: REDACTED });
  });

  it('redacts by value shape even under an innocent key', () => {
    const out = sanitize(
      toPlain({
        note: 'sk_live_51HxxxxxxxxxxxxxxxxABC',
        header: 'Bearer abc.def.ghi',
      }),
    ) as Record<string, unknown>;
    expect(out.note).toBe(REDACTED);
    expect(out.header).toBe(REDACTED);
  });

  it('masks a card number down to the last four', () => {
    const out = sanitize(toPlain({ note: 'charged 4242 4242 4242 4242' , number: '4242424242424242' })) as Record<
      string,
      unknown
    >;
    // Only the bare PAN is masked; prose containing one is not a PAN field.
    expect(out.number).toBe('••••4242');
  });

  it('keeps ordinary personal data intact — that is the point of the record', () => {
    const out = sanitize(toPlain({ email: 'skipper@example.com', phone: '707-555-0100' }));
    expect(out).toEqual({ email: 'skipper@example.com', phone: '707-555-0100' });
  });

  it('collapses structures deeper than the depth limit', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too far' } } } } } } };
    const out = JSON.stringify(sanitize(toPlain(deep)));
    expect(out).toContain('[nested]');
    expect(out).not.toContain('too far');
  });

  it('caps long arrays and reports how many were dropped', () => {
    const arr = Array.from({ length: 60 }, (_, i) => i);
    const out = sanitize(toPlain({ items: arr })) as { items: unknown[] };
    expect(out.items).toHaveLength(51);
    expect(out.items[50]).toBe('…10 more');
  });

  it('truncates a runaway string', () => {
    const out = sanitize(toPlain({ note: 'x'.repeat(5000) })) as { note: string };
    expect(out.note.endsWith('…[truncated]')).toBe(true);
    expect(out.note.length).toBeLessThan(2100);
  });
});

describe('toPlain', () => {
  it('serializes Dates as ISO and BigInt as a string, never a float', () => {
    const out = toPlain({ at: new Date('2026-08-26T00:00:00.000Z'), big: 90071992547409911n }) as Record<
      string,
      unknown
    >;
    expect(out.at).toBe('2026-08-26T00:00:00.000Z');
    expect(out.big).toBe('90071992547409911');
  });

  it('survives a cycle instead of throwing', () => {
    const a: Record<string, unknown> = { name: 'loop' };
    a.self = a;
    expect(toPlain(a)).toEqual({ name: 'loop', self: '[circular]' });
  });

  it('renders a Decimal-like object by its string form, not an empty object', () => {
    class DecimalLike {
      toString() {
        return '129.00';
      }
    }
    expect(toPlain({ rate: new DecimalLike() })).toEqual({ rate: '129.00' });
  });
});

describe('clampPayload', () => {
  it('degrades an oversized diff to the list of changed field names', () => {
    const huge = { blob: 'z'.repeat(100_000) };
    const clamped = clampPayload({
      before: null,
      after: huge,
      changedKeys: ['blob'],
    });
    expect(clamped.after).toEqual({ _truncated: true, _bytes: expect.any(Number), _changed: ['blob'] });
    expect(clamped.before).toBeNull();
  });

  it('leaves a normal diff untouched', () => {
    const diff = diffRecords({ status: 'PAID' }, { status: 'REFUNDED' });
    expect(clampPayload(diff)).toEqual(diff);
  });
});

describe('buildAuditData', () => {
  const actor = staffActor(
    { operatorId: 'lsra', userId: 'staff_1', role: 'MANAGER', extraPermissions: [], locationIds: [] },
    '127.0.0.1',
  );

  it('shapes a refund into a row with the operator, actor, entity and diff', () => {
    const row = buildAuditData({
      operatorId: 'lsra',
      actor,
      action: AUDIT_ACTIONS.PAYMENT_REFUND,
      entityType: 'Payment',
      entityId: 'pay_1',
      before: { status: 'SUCCEEDED', refunded_cents: 0 },
      after: { status: 'REFUNDED', refunded_cents: 12000 },
      context: { reason: 'weather cancellation' },
    });

    expect(row.operator_id).toBe('lsra');
    expect(row.actor).toBe('staff_1');
    expect(row.actor_role).toBe('MANAGER');
    expect(row.action).toBe('payment.refund');
    expect(row.entity_type).toBe('Payment');
    expect(row.entity_id).toBe('pay_1');
    expect(row.ip).toBe('127.0.0.1');
    expect(row.before).toEqual({ status: 'SUCCEEDED', refunded_cents: 0 });
    expect(row.after).toEqual({
      status: 'REFUNDED',
      refunded_cents: 12000,
      _context: { reason: 'weather cancellation' },
    });
  });

  it('omits the diff sides that do not exist so the columns stay NULL', () => {
    const row = buildAuditData({
      operatorId: 'lsra',
      actor,
      action: AUDIT_ACTIONS.GIFT_CARD_ISSUE,
      entityType: 'GiftCard',
      entityId: 'gc_1',
      after: { balance_cents: 5000 },
    });
    expect(row.before).toBeUndefined();
    expect(row.after).toEqual({ balance_cents: 5000 });
  });

  it('never leaves the actor blank — an unattributed row is not evidence', () => {
    const row = buildAuditData({
      operatorId: 'lsra',
      actor: { id: '', role: '' },
      action: AUDIT_ACTIONS.SETTINGS_UPDATE,
      entityType: 'Operator',
      entityId: 'lsra',
      after: { name: 'Lake Sonoma' },
    });
    expect(row.actor).toBe('unknown');
    expect(row.actor_role).toBe('unknown');
  });

  it('redacts a secret carried in the context bag', () => {
    const row = buildAuditData({
      operatorId: 'lsra',
      actor,
      action: AUDIT_ACTIONS.SETTINGS_UPDATE,
      entityType: 'Operator',
      entityId: 'lsra',
      after: { stripe_connected: true },
      context: { webhook_secret: 'whsec_abc123' },
    });
    expect((row.after as Record<string, unknown>)._context).toEqual({ webhook_secret: REDACTED });
  });
});

describe('action catalog', () => {
  it('lists every money action as a real action name', () => {
    const all = new Set(Object.values(AUDIT_ACTIONS));
    for (const action of MONEY_ACTIONS) expect(all.has(action)).toBe(true);
  });

  it('uses dotted verbs so the action index groups cleanly', () => {
    for (const action of Object.values(AUDIT_ACTIONS)) {
      expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});
