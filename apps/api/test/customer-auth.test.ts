/**
 * Customer magic-link auth — pure unit tests (no DB, no network).
 *
 * These cover the four properties that decide whether the sign-in flow is safe,
 * because each of them is a place where a plausible-looking implementation is
 * still wrong:
 *
 *   - token generation: enough entropy, and the raw token never recoverable
 *     from what gets stored;
 *   - hashing + comparison: deterministic, constant-time, and immune to a
 *     malformed stored hash;
 *   - expiry: evaluated against an injected clock, exclusive at the boundary;
 *   - single use: the SECOND redeem loses, including when both are in flight.
 *
 * The session signer and the rendered email are here too — a session that
 * survives a tampered payload, or an email whose link is not actually clickable
 * in the Local Console inbox, both make the feature useless in different ways.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildMagicLinkUrl,
  createFixedWindowLimiter,
  createMemoryMagicLinkStore,
  escapeHtml,
  generateMagicLinkToken,
  hashVerifier,
  isExpired,
  issueCustomerSession,
  type MagicLinkRecord,
  renderMagicLinkEmail,
  resetSessionSecretCache,
  splitToken,
  verifierMatches,
  verifyCustomerSession,
} from '../src/services/customer-auth.js';

// A fixed key so signatures are reproducible across cases in this file.
process.env.CUSTOMER_SESSION_SECRET = 'unit-test-signing-key-not-a-real-secret';
resetSessionSecretCache();

const NOW = new Date('2026-08-26T12:00:00.000Z');

function record(overrides: Partial<MagicLinkRecord> = {}): MagicLinkRecord {
  const generated = generateMagicLinkToken();
  return {
    id: 'tok_1',
    operator_id: 'op_1',
    customer_id: 'cus_1',
    email: 'skipper@example.com',
    selector: generated.selector,
    verifier_hash: generated.verifierHash,
    expires_at: new Date(NOW.getTime() + 15 * 60_000),
    consumed_at: null,
    requested_ip: '203.0.113.7',
    created_at: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

describe('generateMagicLinkToken', () => {
  it('produces a selector.verifier pair with real entropy in both halves', () => {
    const { token, selector } = generateMagicLinkToken();
    const parts = splitToken(token);
    expect(parts).not.toBeNull();
    expect(parts!.selector).toBe(selector);
    // base64url of 16 and 32 random bytes.
    expect(parts!.selector).toHaveLength(22);
    expect(parts!.verifier).toHaveLength(43);
  });

  it('never repeats — 500 tokens, 500 distinct selectors and verifiers', () => {
    const selectors = new Set<string>();
    const verifiers = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const { token, selector } = generateMagicLinkToken();
      selectors.add(selector);
      verifiers.add(splitToken(token)!.verifier);
    }
    expect(selectors.size).toBe(500);
    expect(verifiers.size).toBe(500);
  });

  it('stores only a hash — the raw verifier does not appear in what is persisted', () => {
    const { token, selector, verifierHash } = generateMagicLinkToken();
    const verifier = splitToken(token)!.verifier;
    expect(verifierHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifierHash).not.toContain(verifier);
    // The half that IS stored in the clear must not leak the secret half.
    expect(selector).not.toContain(verifier);
    expect(verifier).not.toContain(selector);
  });
});

// ---------------------------------------------------------------------------
// Hashing and comparison
// ---------------------------------------------------------------------------

describe('hashVerifier / verifierMatches', () => {
  it('is deterministic', () => {
    expect(hashVerifier('abc')).toBe(hashVerifier('abc'));
    expect(hashVerifier('abc')).not.toBe(hashVerifier('abd'));
  });

  it('matches the right verifier and rejects a near miss', () => {
    const { token, verifierHash } = generateMagicLinkToken();
    const verifier = splitToken(token)!.verifier;
    expect(verifierMatches(verifier, verifierHash)).toBe(true);

    // Flip one character: still the right length, still base64url, wrong secret.
    const tweaked = (verifier[0] === 'A' ? 'B' : 'A') + verifier.slice(1);
    expect(verifierMatches(tweaked, verifierHash)).toBe(false);
  });

  it('returns false rather than throwing on a malformed stored hash', () => {
    // timingSafeEqual throws on a length mismatch; a corrupt row must read as
    // "no match", not as a 500 that tells the caller the row existed.
    expect(verifierMatches('anything', '')).toBe(false);
    expect(verifierMatches('anything', 'not-hex')).toBe(false);
    expect(verifierMatches('anything', 'ab'.repeat(10))).toBe(false);
  });
});

describe('splitToken', () => {
  it('rejects anything that is not exactly two base64url halves', () => {
    for (const bad of [
      '',
      'nodot',
      'a.b.c',
      '.verifier',
      'selector.',
      'sel ector.verifier',
      'selector.verifier!',
      'sel+ector.verifier',
    ]) {
      expect(splitToken(bad), bad).toBeNull();
    }
  });

  it('tolerates surrounding whitespace from a copy-pasted link', () => {
    const { token } = generateMagicLinkToken();
    expect(splitToken(`  ${token}\n`)).toEqual(splitToken(token));
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

describe('isExpired', () => {
  it('is false before the deadline and true at or after it', () => {
    const expires = new Date(NOW.getTime() + 60_000);
    expect(isExpired({ expires_at: expires }, NOW)).toBe(false);
    expect(isExpired({ expires_at: expires }, new Date(expires.getTime() - 1))).toBe(false);
    // Exclusive at the boundary: a token whose deadline is exactly now is spent.
    expect(isExpired({ expires_at: expires }, expires)).toBe(true);
    expect(isExpired({ expires_at: expires }, new Date(expires.getTime() + 1))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Single-use semantics
// ---------------------------------------------------------------------------

describe('magic-link store: single use', () => {
  it('lets the first consume win and every later one lose', async () => {
    const store = createMemoryMagicLinkStore();
    const row = record();
    await store.save(row);

    expect(await store.consume(row.selector, NOW)).toBe(true);
    expect(await store.consume(row.selector, NOW)).toBe(false);
    expect(await store.consume(row.selector, new Date(NOW.getTime() + 1000))).toBe(false);
  });

  it('marks the row consumed so a later read can see it is spent', async () => {
    const store = createMemoryMagicLinkStore();
    const row = record();
    await store.save(row);
    await store.consume(row.selector, NOW);

    const after = await store.find(row.selector);
    expect(after?.consumed_at).toEqual(NOW);
  });

  it('picks exactly one winner when two redeems race', async () => {
    // A mail client prefetching the link while the human clicks it: both arrive
    // before either has written. Only one may come back true.
    const store = createMemoryMagicLinkStore();
    const row = record();
    await store.save(row);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.consume(row.selector, NOW)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('returns false for a selector that was never issued', async () => {
    const store = createMemoryMagicLinkStore();
    expect(await store.consume('never-issued', NOW)).toBe(false);
    expect(await store.find('never-issued')).toBeNull();
  });

  it('hands back a copy, so a caller cannot mutate the stored row', async () => {
    const store = createMemoryMagicLinkStore();
    const row = record();
    await store.save(row);

    const found = await store.find(row.selector);
    found!.consumed_at = new Date();
    expect((await store.find(row.selector))?.consumed_at).toBeNull();
  });

  it('purges spent and expired rows and keeps live ones', async () => {
    const store = createMemoryMagicLinkStore();
    const live = record({ selector: 'live' });
    const stale = record({ selector: 'stale', expires_at: new Date(NOW.getTime() - 1) });
    const spent = record({ selector: 'spent', consumed_at: NOW });
    await store.save(live);
    await store.save(stale);
    await store.save(spent);

    expect(await store.purge(NOW)).toBe(2);
    expect(store.size()).toBe(1);
    expect(await store.find('live')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe('customer sessions', () => {
  const base = { operatorId: 'op_1', customerId: 'cus_1', email: 'skipper@example.com' };

  it('round-trips the identity it was issued for', () => {
    const { token, expiresAt } = issueCustomerSession({ ...base, now: NOW, ttlSeconds: 3600 });
    const session = verifyCustomerSession(token, NOW);
    expect(session).toMatchObject(base);
    expect(session?.expiresAt).toEqual(expiresAt);
  });

  it('expires exactly at its deadline', () => {
    const { token, expiresAt } = issueCustomerSession({ ...base, now: NOW, ttlSeconds: 60 });
    expect(verifyCustomerSession(token, new Date(expiresAt.getTime() - 1))).not.toBeNull();
    expect(verifyCustomerSession(token, expiresAt)).toBeNull();
  });

  it('rejects a payload edited to point at another customer', () => {
    const { token } = issueCustomerSession({ ...base, now: NOW, ttlSeconds: 3600 });
    const [version, encoded, signature] = token.split('.');
    const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
    payload.cid = 'cus_someone_else';
    const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    // Re-signed by nobody: the original signature no longer covers the payload.
    expect(verifyCustomerSession(`${version}.${forged}.${signature}`, NOW)).toBeNull();
  });

  it('rejects a tampered signature, a wrong version and structural junk', () => {
    const { token } = issueCustomerSession({ ...base, now: NOW, ttlSeconds: 3600 });
    const [, encoded, signature] = token.split('.');
    expect(verifyCustomerSession(`c1.${encoded}.${signature!.slice(0, -1)}x`, NOW)).toBeNull();
    expect(verifyCustomerSession(`c2.${encoded}.${signature}`, NOW)).toBeNull();
    expect(verifyCustomerSession(`${encoded}.${signature}`, NOW)).toBeNull();
    expect(verifyCustomerSession('', NOW)).toBeNull();
    expect(verifyCustomerSession(undefined, NOW)).toBeNull();
  });

  it('carries the operator so a session cannot be reused on another tenant', () => {
    const { token } = issueCustomerSession({
      ...base,
      operatorId: 'op_other',
      now: NOW,
      ttlSeconds: 3600,
    });
    // The route compares this against the resolved tenant and refuses a mismatch.
    expect(verifyCustomerSession(token, NOW)?.operatorId).toBe('op_other');
  });
});

// ---------------------------------------------------------------------------
// Per-mailbox limiter
// ---------------------------------------------------------------------------

describe('createFixedWindowLimiter', () => {
  it('allows up to max in a window, then refuses with a retry hint', () => {
    const limiter = createFixedWindowLimiter({ windowMs: 60_000, max: 3 });
    const t0 = 1_000_000;
    expect(limiter.take('a', t0).allowed).toBe(true);
    expect(limiter.take('a', t0 + 1).allowed).toBe(true);
    expect(limiter.take('a', t0 + 2).allowed).toBe(true);

    const blocked = limiter.take('a', t0 + 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('keeps separate budgets per key and reopens after the window', () => {
    const limiter = createFixedWindowLimiter({ windowMs: 60_000, max: 1 });
    const t0 = 2_000_000;
    expect(limiter.take('one@example.com', t0).allowed).toBe(true);
    expect(limiter.take('one@example.com', t0 + 5).allowed).toBe(false);
    // A different mailbox is untouched by the first one's abuse.
    expect(limiter.take('two@example.com', t0 + 5).allowed).toBe(true);
    // ...and the first is forgiven once the window rolls.
    expect(limiter.take('one@example.com', t0 + 60_001).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------

describe('renderMagicLinkEmail', () => {
  const brand = {
    name: 'Lake Sonoma Marina',
    color: '#0369a1',
    logoUrl: null,
    phone: '707-555-0100',
    website: 'https://example.com',
  };
  const link = buildMagicLinkUrl('sel.ver', 'http://localhost:3000');

  let rendered: ReturnType<typeof renderMagicLinkEmail>;
  beforeEach(() => {
    rendered = renderMagicLinkEmail({
      brand,
      link,
      customerName: 'Dale',
      expiresInMinutes: 15,
    });
  });

  it('makes the link clickable — this is what the Local Console inbox renders', () => {
    // Twice on purpose: the button, and the copyable URL underneath it.
    const needle = `href="${link}"`;
    const hrefs = rendered.html.split(needle).length - 1;
    expect(hrefs).toBe(2);
    expect(rendered.html).toContain('View my bookings');
  });

  it('repeats the link in the plain-text part', () => {
    expect(rendered.text).toContain(link);
  });

  it('states the expiry and the single-use rule in both parts', () => {
    expect(rendered.html).toContain('expires in 15 minutes');
    expect(rendered.html).toContain('only be used once');
    expect(rendered.text).toContain('expires in 15 minutes');
    expect(rendered.text).toContain('only be used once');
  });

  it('is white-label — the operator brands it, nothing else does', () => {
    expect(rendered.subject).toBe('Your sign-in link for Lake Sonoma Marina');
    expect(rendered.html).toContain('Lake Sonoma Marina');
    expect(rendered.html).toContain('#0369a1');
  });

  it('escapes operator and customer values instead of injecting them', () => {
    const hostile = renderMagicLinkEmail({
      brand: { ...brand, name: 'Bob"s <script>alert(1)</script> Marina' },
      link,
      customerName: '<img src=x onerror=alert(1)>',
      expiresInMinutes: 15,
    });
    expect(hostile.html).not.toContain('<script>');
    expect(hostile.html).not.toContain('<img src=x');
    expect(hostile.html).toContain('&lt;script&gt;');
  });

  it('falls back to a safe color when the brand color is malformed', () => {
    const odd = renderMagicLinkEmail({
      brand: { ...brand, color: 'red; background:url(javascript:alert(1))' },
      link,
      customerName: null,
      expiresInMinutes: 15,
    });
    expect(odd.html).not.toContain('javascript:');
    expect(odd.html).toContain('#0ea5e9');
    expect(odd.html).toContain('Hi there,');
  });
});

describe('buildMagicLinkUrl', () => {
  it('lands on the portal page and percent-encodes the token', () => {
    const { token } = generateMagicLinkToken();
    const url = buildMagicLinkUrl(token, 'https://book.example.com/');
    expect(url.startsWith('https://book.example.com/account/magic?token=')).toBe(true);
    // base64url can contain characters that are not URL-safe in a query value.
    expect(new URL(url).searchParams.get('token')).toBe(token);
  });
});

describe('escapeHtml', () => {
  it('neutralizes every character that could break out of an attribute', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});
