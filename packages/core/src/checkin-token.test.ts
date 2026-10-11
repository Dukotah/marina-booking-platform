import { describe, expect, it } from 'vitest';
import {
  signCheckinToken,
  verifyCheckinToken,
  checkinScanUrl,
} from './checkin-token.js';

describe('checkin-token', () => {
  const input = { orderNumber: 'LSRA260604001', orderItemId: 'oi_abc123' };

  it('round-trips a signed token and recovers the payload', () => {
    const token = signCheckinToken(input);
    const verified = verifyCheckinToken(token);
    expect(verified).not.toBeNull();
    expect(verified!.signatureValid).toBe(true);
    expect(verified!.payload).toEqual({ v: 1, on: input.orderNumber, iid: input.orderItemId });
  });

  it('rejects a token with a tampered payload (signature no longer matches)', () => {
    const token = signCheckinToken(input);
    const [body, sig] = token.split('.');
    // Forge a different order-item id but keep the original signature.
    const forgedPayload = { v: 1, on: input.orderNumber, iid: 'oi_victim' };
    const forgedBody = Buffer.from(JSON.stringify(forgedPayload), 'utf8').toString('base64url');
    expect(forgedBody).not.toEqual(body);
    const forged = `${forgedBody}.${sig}`;

    const verified = verifyCheckinToken(forged);
    expect(verified).not.toBeNull();
    expect(verified!.payload.iid).toBe('oi_victim');
    expect(verified!.signatureValid).toBe(false);
  });

  it('rejects a token with a tampered signature', () => {
    const token = signCheckinToken(input);
    const [body] = token.split('.');
    const verified = verifyCheckinToken(`${body}.deadbeef`);
    expect(verified).not.toBeNull();
    expect(verified!.signatureValid).toBe(false);
  });

  it('returns null for malformed / empty tokens', () => {
    expect(verifyCheckinToken(null)).toBeNull();
    expect(verifyCheckinToken(undefined)).toBeNull();
    expect(verifyCheckinToken('')).toBeNull();
    expect(verifyCheckinToken('nodot')).toBeNull();
    expect(verifyCheckinToken('!!!notbase64!!!.sig')).toBeNull();
  });

  it('builds a scan URL that carries the token', () => {
    const token = signCheckinToken(input);
    const url = checkinScanUrl('https://book.example.com/', token);
    expect(url).toBe(`https://book.example.com/api/checkin/scan?t=${encodeURIComponent(token)}`);
  });
});
