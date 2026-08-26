/**
 * Customer magic-link sign-in — the `auth` provider's local driver
 * (docs/LOCAL-FIRST-BUILD.md §4.1: "Local magic-link: the link lands in the
 * sandbox inbox").
 *
 * This replaces the order-number + email stub the portal shipped with. That stub
 * had two problems worth naming, because they shape everything below:
 *   1. The order number is the customer's *identity*, and it is printed on a
 *      receipt. Anyone holding a receipt could open the booking.
 *   2. It could only ever show ONE booking — the one whose number you typed.
 *
 * Magic link fixes both: possession of the mailbox is the proof, and the session
 * that comes out is scoped to a customer id, so the portal can list everything
 * that customer has ever booked and nothing else.
 *
 * THE SECURITY SHAPE, and why each piece is the way it is:
 *
 *   Split token (`selector.verifier`). The selector is the lookup key and is
 *   stored in the clear; the verifier is the secret and only its SHA-256 lands in
 *   the database. A dumped token table therefore yields nothing usable, and the
 *   lookup is still a single indexed read rather than a scan-and-compare over
 *   every outstanding hash. The verifier is compared with `timingSafeEqual`.
 *
 *   Single use, enforced by the database and not by a read-then-write. Redeem
 *   does `updateMany({ where: { selector, consumed_at: null } })` and trusts the
 *   returned count: two clicks racing (a mail client prefetching while the human
 *   clicks) means exactly one wins. Checking `consumed_at` in JavaScript first
 *   would leave the window open.
 *
 *   Verify before consume. The verifier is checked *before* the row is marked
 *   consumed, so someone who guesses a selector cannot burn a live link they
 *   cannot actually use.
 *
 *   The request endpoint never reveals whether an address exists. That is why
 *   `requestMagicLink` returns the same shape whether or not it found a customer,
 *   and why the route hands back one fixed body. See the note on timing below.
 *
 * THE SESSION is a stateless HMAC-signed value rather than a session table: the
 * portal is read-mostly, the payload is three ids, and a table would need a
 * schema this agent does not own. It carries `operator_id` as well as
 * `customer_id`, so a session minted on one tenant cannot be replayed against
 * another even if the same person books with two operators.
 *
 * TIME comes from `sandboxNow`, the same clock the payment simulator uses, so the
 * Local Console's clock control can jump forward fifteen minutes and prove a link
 * really does expire — without waiting fifteen minutes.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createId } from '@marina/core';
import type { TenantClient } from '@marina/database';
import { type NotificationResult, skipped } from './notification-data.js';
import { captureMessage, sandboxEnabled } from './sandbox.js';
import { sandboxNow } from './payments-sandbox.js';

// ===========================================================================
// Tunables
// ===========================================================================

/** How long a link stays good. Short: the mailbox is the only thing guarding it. */
export const DEFAULT_LINK_TTL_SECONDS = 15 * 60;

/** How long a redeemed session lasts before the customer needs a fresh link. */
export const DEFAULT_SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

/** Per-email budget: 5 links per 15 minutes, so a stranger cannot mailbomb. */
export const EMAIL_RATE_WINDOW_MS = 15 * 60_000;
export const EMAIL_RATE_MAX = 5;

/** Cookie the portal reads the session back from. */
export const CUSTOMER_SESSION_COOKIE = 'marina_customer_session';

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function linkTtlSeconds(): number {
  return positiveIntEnv('CUSTOMER_MAGIC_LINK_TTL_SECONDS', DEFAULT_LINK_TTL_SECONDS);
}

export function sessionTtlSeconds(): number {
  return positiveIntEnv('CUSTOMER_SESSION_TTL_SECONDS', DEFAULT_SESSION_TTL_SECONDS);
}

// ===========================================================================
// Token generation / hashing (pure — unit tested)
// ===========================================================================

/** Bytes of entropy in each half. 128 bits of selector, 256 bits of secret. */
const SELECTOR_BYTES = 16;
const VERIFIER_BYTES = 32;

export interface GeneratedToken {
  /** What goes in the URL: `selector.verifier`. Never stored. */
  token: string;
  /** Lookup key. Stored in the clear. */
  selector: string;
  /** SHA-256 of the verifier, hex. The only half that is stored. */
  verifierHash: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Mint a fresh magic-link token. */
export function generateMagicLinkToken(): GeneratedToken {
  const selector = b64url(randomBytes(SELECTOR_BYTES));
  const verifier = b64url(randomBytes(VERIFIER_BYTES));
  return {
    token: `${selector}.${verifier}`,
    selector,
    verifierHash: hashVerifier(verifier),
  };
}

/** SHA-256 of a verifier, hex. Deterministic and unsalted on purpose: the input
 *  is already 256 bits of uniform randomness, so a salt or a KDF would buy
 *  nothing against a table dump and would cost a lookup per redeem. */
export function hashVerifier(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('hex');
}

/** Split a presented token. Returns null for anything malformed — a token with
 *  no separator, extra separators, or an empty half is never a near-miss worth
 *  a database round trip. */
export function splitToken(token: string): { selector: string; verifier: string } | null {
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 2) return null;
  const [selector, verifier] = parts as [string, string];
  if (!selector || !verifier) return null;
  // Both halves are base64url; reject anything else before it reaches the DB.
  if (!/^[A-Za-z0-9_-]+$/.test(selector) || !/^[A-Za-z0-9_-]+$/.test(verifier)) return null;
  return { selector, verifier };
}

/** Constant-time comparison of a presented verifier against a stored hash. */
export function verifierMatches(verifier: string, storedHash: string): boolean {
  const presented = Buffer.from(hashVerifier(verifier), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which would itself be a timing
  // signal; a corrupt stored hash is simply "no match".
  if (stored.length !== presented.length) return false;
  return timingSafeEqual(presented, stored);
}

// ===========================================================================
// Token records + store
// ===========================================================================

export interface MagicLinkRecord {
  id: string;
  operator_id: string;
  customer_id: string;
  /** The address the link was mailed to, normalized. Bound into the record so a
   *  later change of the customer's email invalidates links already in flight. */
  email: string;
  selector: string;
  verifier_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  requested_ip: string | null;
  created_at: Date;
}

export interface MagicLinkStore {
  save(record: MagicLinkRecord): Promise<void>;
  find(selector: string): Promise<MagicLinkRecord | null>;
  /**
   * Atomically mark consumed. Returns true ONLY for the caller that flipped it
   * from unconsumed — this is the single-use guarantee, and it must not be
   * re-implemented as a read followed by a write.
   */
  consume(selector: string, at: Date): Promise<boolean>;
  /** Housekeeping. Drops rows that can no longer be redeemed. */
  purge(before: Date): Promise<number>;
}

export function isExpired(record: Pick<MagicLinkRecord, 'expires_at'>, now: Date): boolean {
  return record.expires_at.getTime() <= now.getTime();
}

// --- In-memory store -------------------------------------------------------

/**
 * Process-local store. This is what the local-first run uses today (see
 * `createMagicLinkStore`), and it is what the unit tests drive.
 *
 * Its limits are real and worth stating: tokens do not survive a restart, and
 * two API instances would not share them. For a laptop running one API process
 * that is correct behaviour, not a compromise — a restart invalidating
 * outstanding links is if anything the safer failure. It is refused outright in
 * production below.
 */
export function createMemoryMagicLinkStore(): MagicLinkStore & { size(): number } {
  const rows = new Map<string, MagicLinkRecord>();
  return {
    async save(record) {
      rows.set(record.selector, { ...record });
    },
    async find(selector) {
      const row = rows.get(selector);
      return row ? { ...row } : null;
    },
    async consume(selector, at) {
      const row = rows.get(selector);
      if (!row || row.consumed_at !== null) return false;
      row.consumed_at = at;
      return true;
    },
    async purge(before) {
      let removed = 0;
      for (const [key, row] of rows) {
        if (row.expires_at.getTime() <= before.getTime() || row.consumed_at !== null) {
          rows.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    size() {
      return rows.size;
    },
  };
}

// --- Prisma store ----------------------------------------------------------

/**
 * The durable store, written against a `CustomerAuthToken` tenant table.
 *
 * That model is NOT in schema.prisma yet — this agent does not own that file, so
 * the exact shape it needs is in the handoff report. The delegate is therefore
 * reached structurally and checked at runtime: the moment the model lands and the
 * client is regenerated, `createMagicLinkStore` picks it up with no code change.
 */
interface AuthTokenRow {
  id: string;
  operator_id: string;
  customer_id: string;
  email: string;
  selector: string;
  verifier_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  requested_ip: string | null;
  created_at: Date;
}

interface AuthTokenDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findFirst(args: { where: { selector: string } }): Promise<AuthTokenRow | null>;
  updateMany(args: {
    where: { selector: string; consumed_at: null };
    data: { consumed_at: Date };
  }): Promise<{ count: number }>;
  deleteMany(args: { where: unknown }): Promise<{ count: number }>;
}

/** The delegate if the model exists on this client, otherwise null. */
export function authTokenDelegate(db: TenantClient): AuthTokenDelegate | null {
  const candidate = (db as unknown as Record<string, unknown>).customerAuthToken;
  if (!candidate || typeof candidate !== 'object') return null;
  const delegate = candidate as Partial<AuthTokenDelegate>;
  return typeof delegate.create === 'function' && typeof delegate.updateMany === 'function'
    ? (candidate as AuthTokenDelegate)
    : null;
}

export function createPrismaMagicLinkStore(
  delegate: AuthTokenDelegate,
  operatorId: string,
): MagicLinkStore {
  return {
    async save(record) {
      // Top-level create on a tenant table: operator_id is explicit (D-011).
      await delegate.create({
        data: {
          id: record.id,
          operator_id: record.operator_id,
          customer_id: record.customer_id,
          email: record.email,
          selector: record.selector,
          verifier_hash: record.verifier_hash,
          expires_at: record.expires_at,
          consumed_at: record.consumed_at,
          requested_ip: record.requested_ip,
        },
      });
    },
    async find(selector) {
      // RLS already scopes this to the tenant; the selector is 128 random bits so
      // findFirst is a unique read in practice without depending on the compound
      // index's generated name.
      const row = await delegate.findFirst({ where: { selector } });
      return row && row.operator_id === operatorId ? row : null;
    },
    async consume(selector, at) {
      const { count } = await delegate.updateMany({
        where: { selector, consumed_at: null },
        data: { consumed_at: at },
      });
      return count === 1;
    },
    async purge(before) {
      const { count } = await delegate.deleteMany({
        where: { OR: [{ expires_at: { lt: before } }, { consumed_at: { not: null } }] },
      });
      return count;
    },
  };
}

// --- Store selection -------------------------------------------------------

const memoryStores = new Map<string, MagicLinkStore>();
let warnedMemoryStore = false;

/**
 * Pick the store for this tenant: the durable table when the client has it,
 * otherwise a per-operator in-memory store.
 *
 * The fallback is loud and is refused in production. A magic-link store that
 * silently forgot every token across a deploy would look like "the link is
 * broken" to real customers, and that is exactly the kind of quiet degradation
 * this codebase's notification/audit modules go out of their way to avoid.
 */
export function createMagicLinkStore(db: TenantClient, operatorId: string): MagicLinkStore {
  const delegate = authTokenDelegate(db);
  if (delegate) return createPrismaMagicLinkStore(delegate, operatorId);

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'customer-auth: the CustomerAuthToken model is missing from the Prisma client. ' +
        'Magic-link sign-in refuses the in-memory fallback in production.',
    );
  }
  if (!warnedMemoryStore) {
    warnedMemoryStore = true;
    console.warn(
      '[customer-auth] CustomerAuthToken is not in the Prisma client — using the ' +
        'in-process token store. Links will not survive an API restart.',
    );
  }

  let store = memoryStores.get(operatorId);
  if (!store) {
    store = createMemoryMagicLinkStore();
    memoryStores.set(operatorId, store);
  }
  return store;
}

// ===========================================================================
// Fixed-window limiter (the per-email budget)
// ===========================================================================

/**
 * Same fixed-window shape as `middleware/rate-limit.ts`, keyed by something that
 * is not the IP. The middleware limiter guards the endpoint per client; this one
 * guards a *mailbox*, which is the thing that actually gets abused: a botnet with
 * a thousand addresses passes an IP limit and still buries one customer in mail.
 */
export interface LimiterDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface FixedWindowLimiter {
  take(key: string, now?: number): LimiterDecision;
  reset(): void;
}

export function createFixedWindowLimiter(options: {
  windowMs: number;
  max: number;
}): FixedWindowLimiter {
  const store = new Map<string, { count: number; resetAt: number }>();
  let opsSinceSweep = 0;
  const SWEEP_EVERY = 1_000;

  return {
    take(key, now = Date.now()) {
      if (++opsSinceSweep >= SWEEP_EVERY) {
        opsSinceSweep = 0;
        for (const [k, state] of store) if (state.resetAt <= now) store.delete(k);
      }

      const existing = store.get(key);
      if (!existing || existing.resetAt <= now) {
        store.set(key, { count: 1, resetAt: now + options.windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (existing.count >= options.max) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
        };
      }
      existing.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
    reset() {
      store.clear();
    },
  };
}

/** The per-mailbox budget, shared across every route in this process. */
export const emailRequestLimiter = createFixedWindowLimiter({
  windowMs: EMAIL_RATE_WINDOW_MS,
  max: EMAIL_RATE_MAX,
});

// ===========================================================================
// Sessions (stateless, HMAC-signed)
// ===========================================================================

export interface CustomerSession {
  operatorId: string;
  customerId: string;
  email: string;
  issuedAt: Date;
  expiresAt: Date;
}

interface SessionPayload {
  v: 1;
  oid: string;
  cid: string;
  eml: string;
  iat: number;
  exp: number;
}

let cachedSecret: Buffer | null = null;
let warnedEphemeralSecret = false;

/**
 * The signing key. `CUSTOMER_SESSION_SECRET` in any real deployment; in local
 * dev a per-process random key, which means restarting the API signs everyone
 * out. That is the honest local behaviour — the alternative, a hardcoded
 * default, is a key that would eventually ship.
 */
function sessionSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const configured = process.env.CUSTOMER_SESSION_SECRET?.trim();
  if (configured) {
    cachedSecret = Buffer.from(configured, 'utf8');
    return cachedSecret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('customer-auth: CUSTOMER_SESSION_SECRET is required in production.');
  }
  if (!warnedEphemeralSecret) {
    warnedEphemeralSecret = true;
    console.warn(
      '[customer-auth] CUSTOMER_SESSION_SECRET is not set — signing customer ' +
        'sessions with a per-process key. Restarting the API signs customers out.',
    );
  }
  cachedSecret = randomBytes(32);
  return cachedSecret;
}

/** Test seam: drop the cached key so a test can swap the env var. */
export function resetSessionSecretCache(): void {
  cachedSecret = null;
}

function sign(payloadB64: string): string {
  return createHmac('sha256', sessionSecret()).update(payloadB64).digest('base64url');
}

export function issueCustomerSession(input: {
  operatorId: string;
  customerId: string;
  email: string;
  now?: Date;
  ttlSeconds?: number;
}): { token: string; expiresAt: Date; issuedAt: Date } {
  const now = input.now ?? new Date();
  const ttl = input.ttlSeconds ?? sessionTtlSeconds();
  const issuedAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);

  const payload: SessionPayload = {
    v: 1,
    oid: input.operatorId,
    cid: input.customerId,
    eml: input.email,
    iat: Math.floor(issuedAt.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { token: `c1.${encoded}.${sign(encoded)}`, expiresAt, issuedAt };
}

/**
 * Verify and decode a session. Returns null for anything that is not a valid,
 * unexpired signature — callers get one bit, never a reason, because the reason
 * is only ever useful to whoever is forging it.
 */
export function verifyCustomerSession(
  token: string | undefined | null,
  now: Date = new Date(),
): CustomerSession | null {
  if (!token) return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;
  const [version, encoded, signature] = parts as [string, string, string];
  if (version !== 'c1' || !encoded || !signature) return null;

  const expected = Buffer.from(sign(encoded), 'utf8');
  const presented = Buffer.from(signature, 'utf8');
  if (expected.length !== presented.length) return null;
  if (!timingSafeEqual(expected, presented)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (payload?.v !== 1 || !payload.oid || !payload.cid || !payload.exp) return null;
  if (payload.exp * 1000 <= now.getTime()) return null;

  return {
    operatorId: payload.oid,
    customerId: payload.cid,
    email: payload.eml,
    issuedAt: new Date(payload.iat * 1000),
    expiresAt: new Date(payload.exp * 1000),
  };
}

// ===========================================================================
// The email
// ===========================================================================

export interface MagicLinkBrand {
  name: string;
  color: string;
  logoUrl?: string | null;
  phone?: string | null;
  website?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Absolute base URL of the customer portal. Derived from what local dev already
 *  sets (`APP_BASE_DOMAIN=localhost:3000`) so the sandbox link works with no new
 *  env var; `CUSTOMER_PORTAL_URL` overrides it for a real deployment. */
export function customerPortalBaseUrl(): string {
  const explicit = (process.env.CUSTOMER_PORTAL_URL ?? process.env.APP_BASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (explicit) return explicit;
  const domain = (process.env.APP_BASE_DOMAIN ?? 'localhost:3000').trim().replace(/\/+$/, '');
  const scheme = /^(localhost|127\.0\.0\.1)/.test(domain) ? 'http' : 'https';
  return `${scheme}://${domain}`;
}

export function buildMagicLinkUrl(token: string, baseUrl = customerPortalBaseUrl()): string {
  return `${baseUrl.replace(/\/+$/, '')}/account/magic?token=${encodeURIComponent(token)}`;
}

/**
 * Render the sign-in email.
 *
 * The link is deliberately present three ways: as a full-width button, as the
 * raw URL in copyable text, and again in the plain-text part. In the Local
 * Console that is the whole feature — the owner opens the inbox and clicks
 * straight through with no Resend account — and in a real inbox it is what
 * rescues the customer whose mail client strips buttons.
 */
export function renderMagicLinkEmail(input: {
  brand: MagicLinkBrand;
  link: string;
  customerName?: string | null;
  expiresInMinutes: number;
}): RenderedEmail {
  const brandName = input.brand.name;
  const safeBrand = escapeHtml(brandName);
  const safeLink = escapeHtml(input.link);
  const color = /^#[0-9a-fA-F]{3,8}$/.test(input.brand.color) ? input.brand.color : '#0ea5e9';
  const name = input.customerName?.trim();
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const minutes = input.expiresInMinutes;
  const contact = [input.brand.phone, input.brand.website].filter(Boolean).map(String);

  const logo = input.brand.logoUrl
    ? `<img src="${escapeHtml(input.brand.logoUrl)}" alt="${safeBrand}" height="40" style="display:block;margin:0 auto 20px;max-height:40px" />`
    : `<div style="text-align:center;font-size:18px;font-weight:700;color:${color};margin-bottom:20px">${safeBrand}</div>`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
    <tr><td>
      ${logo}
      <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3">Sign in to your bookings</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#334155">${escapeHtml(greeting)} tap the button below to see and manage your reservations with ${safeBrand}. No password needed.</p>
      <p style="margin:0 0 20px;text-align:center">
        <a href="${safeLink}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 28px;border-radius:10px">View my bookings</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#64748b">Or paste this link into your browser:</p>
      <p style="margin:0 0 20px;font-size:13px;word-break:break-all"><a href="${safeLink}" style="color:${color}">${safeLink}</a></p>
      <p style="margin:0 0 4px;font-size:13px;color:#64748b">This link expires in ${minutes} minutes and can only be used once.</p>
      <p style="margin:0;font-size:13px;color:#64748b">If you did not ask to sign in, you can ignore this email — nothing has changed.</p>
      ${contact.length ? `<p style="margin:24px 0 0;font-size:12px;color:#94a3b8">${escapeHtml([brandName, ...contact].join(' · '))}</p>` : ''}
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `Sign in to your bookings with ${brandName}`,
    '',
    `${greeting} open this link to see and manage your reservations:`,
    '',
    input.link,
    '',
    `This link expires in ${minutes} minutes and can only be used once.`,
    'If you did not ask to sign in, you can ignore this email.',
    ...(contact.length ? ['', [brandName, ...contact].join(' · ')] : []),
  ].join('\n');

  return { subject: `Your sign-in link for ${brandName}`, html, text };
}

// ===========================================================================
// Delivery
// ===========================================================================

/**
 * Cloud-mode sender. The Resend client is owned by `services/notifications.ts`
 * and nothing else may import Resend (LOCAL-FIRST-BUILD §4.1), so the cloud path
 * is an injected seam rather than a second Resend client here. See the handoff
 * report: notifications.ts needs one exported sender, wired in at startup.
 */
export type MagicLinkEmailSender = (message: {
  operatorId: string;
  to: string;
  brandName: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<NotificationResult>;

let cloudSender: MagicLinkEmailSender | null = null;

export function setMagicLinkEmailSender(sender: MagicLinkEmailSender | null): void {
  cloudSender = sender;
}

/** Deliver a rendered sign-in email. Never throws — the caller's response is the
 *  same either way, so a delivery failure must not turn into a 500 that tells an
 *  attacker the address was real. */
export async function deliverMagicLinkEmail(message: {
  operatorId: string;
  to: string;
  brandName: string;
  subject: string;
  html: string;
  text: string;
}): Promise<NotificationResult> {
  if (sandboxEnabled()) {
    // Exactly the local branch of the notifications dispatcher: the message is
    // rendered as it would be sent and stored for the Local Console inbox.
    return captureMessage({
      operatorId: message.operatorId,
      channel: 'EMAIL',
      kind: 'customer_magic_link',
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
  if (cloudSender) {
    try {
      return await cloudSender(message);
    } catch (err) {
      console.error('[customer-auth] cloud sender failed:', err);
      return skipped('cloud sender failed');
    }
  }
  console.error(
    '[customer-auth] SANDBOX=cloud but no email sender is registered — the sign-in ' +
      'link was NOT delivered. Call setMagicLinkEmailSender() at startup.',
  );
  return skipped('no cloud email sender registered');
}

// ===========================================================================
// Flows
// ===========================================================================

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export interface RequestMagicLinkInput {
  db: TenantClient;
  operatorId: string;
  email: string;
  ip?: string | null;
  /** Override for tests / a tenant-specific portal domain. */
  baseUrl?: string;
}

export interface RequestMagicLinkResult {
  /** Whether an email actually went out. NEVER surfaced to the requester. */
  delivered: boolean;
  /** Diagnostic only — for logs and tests, not for the HTTP body. */
  reason?: string;
  /** Present only in tests / sandbox helpers; the route does not return it. */
  token?: string;
}

/**
 * Issue a link for an address, if that address belongs to a customer of this
 * tenant.
 *
 * The caller must respond identically in every branch. That is why this returns
 * a diagnostic object rather than throwing: "unknown address" and "email sent"
 * have to be indistinguishable from outside, and an exception path is the
 * easiest way to accidentally make them distinguishable.
 *
 * One thing we do NOT do: pad the response to a fixed duration. A real send is
 * measurably slower than a miss, so the honest defence is that the endpoint is
 * rate-limited per address and per IP, which caps how much timing signal anyone
 * can accumulate. Padding here would be theatre, since the sandbox capture and a
 * live Resend call differ by an order of magnitude anyway.
 */
export async function requestMagicLink(
  input: RequestMagicLinkInput,
): Promise<RequestMagicLinkResult> {
  const email = normalizeEmail(input.email);
  const now = await sandboxNow(input.db, input.operatorId);

  const customer = await input.db.customer.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, first_name: true },
  });
  if (!customer) return { delivered: false, reason: 'no customer for address' };

  const operator = await input.db.operator.findUnique({
    where: { id: input.operatorId },
    select: {
      name_external: true,
      brand_color: true,
      logo_light_url: true,
      logo_dark_url: true,
      phone: true,
      website: true,
    },
  });
  if (!operator) return { delivered: false, reason: 'operator not found' };

  const ttl = linkTtlSeconds();
  const generated = generateMagicLinkToken();
  const store = createMagicLinkStore(input.db, input.operatorId);

  // Best effort: keep the table from accumulating dead rows. A purge failure is
  // not a reason to refuse someone a sign-in link.
  void store.purge(now).catch(() => undefined);

  await store.save({
    id: createId(),
    operator_id: input.operatorId,
    customer_id: customer.id,
    email,
    selector: generated.selector,
    verifier_hash: generated.verifierHash,
    expires_at: new Date(now.getTime() + ttl * 1000),
    consumed_at: null,
    requested_ip: input.ip ?? null,
    created_at: now,
  });

  const link = buildMagicLinkUrl(generated.token, input.baseUrl);
  const rendered = renderMagicLinkEmail({
    brand: {
      name: operator.name_external,
      color: operator.brand_color,
      logoUrl: operator.logo_light_url ?? operator.logo_dark_url,
      phone: operator.phone,
      website: operator.website,
    },
    link,
    customerName: customer.first_name,
    expiresInMinutes: Math.max(1, Math.round(ttl / 60)),
  });

  const result = await deliverMagicLinkEmail({
    operatorId: input.operatorId,
    to: customer.email,
    brandName: operator.name_external,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  return {
    delivered: result.sent,
    reason: result.skippedReason,
    // Returned so an integration test can follow the link without scraping the
    // inbox. The route never puts this in a response body.
    token: generated.token,
  };
}

export type RedeemFailureReason =
  | 'malformed'
  | 'not_found'
  | 'expired'
  | 'already_used'
  | 'customer_missing';

export type RedeemResult =
  | {
      ok: true;
      session: { token: string; expiresAt: Date };
      customer: { id: string; email: string; firstName: string; lastName: string };
    }
  | { ok: false; reason: RedeemFailureReason };

/**
 * Redeem a token for a session.
 *
 * Order matters: shape, lookup, expiry, THEN constant-time verifier check, THEN
 * the atomic consume. Consuming before verifying would let a selector guess burn
 * a live link; consuming after issuing the session would leave a window where a
 * replay wins.
 */
export async function redeemMagicLink(input: {
  db: TenantClient;
  operatorId: string;
  token: string;
  now?: Date;
}): Promise<RedeemResult> {
  const parts = splitToken(input.token ?? '');
  if (!parts) return { ok: false, reason: 'malformed' };

  const now = input.now ?? (await sandboxNow(input.db, input.operatorId));
  const store = createMagicLinkStore(input.db, input.operatorId);

  const record = await store.find(parts.selector);
  if (!record) return { ok: false, reason: 'not_found' };
  if (record.operator_id !== input.operatorId) return { ok: false, reason: 'not_found' };
  if (record.consumed_at !== null) return { ok: false, reason: 'already_used' };
  if (isExpired(record, now)) return { ok: false, reason: 'expired' };
  if (!verifierMatches(parts.verifier, record.verifier_hash)) {
    return { ok: false, reason: 'not_found' };
  }

  if (!(await store.consume(parts.selector, now))) {
    // Someone (or something — a link scanner) got here first.
    return { ok: false, reason: 'already_used' };
  }

  const customer = await input.db.customer.findUnique({
    where: { id: record.customer_id },
    select: { id: true, email: true, first_name: true, last_name: true },
  });
  if (!customer) return { ok: false, reason: 'customer_missing' };

  // The address is re-checked against the one the link was mailed to: if the
  // customer's email changed after the link went out, the old mailbox must not
  // still be able to sign in.
  if (normalizeEmail(customer.email) !== record.email) {
    return { ok: false, reason: 'not_found' };
  }

  const session = issueCustomerSession({
    operatorId: input.operatorId,
    customerId: customer.id,
    email: normalizeEmail(customer.email),
    now,
  });

  return {
    ok: true,
    session: { token: session.token, expiresAt: session.expiresAt },
    customer: {
      id: customer.id,
      email: customer.email,
      firstName: customer.first_name,
      lastName: customer.last_name,
    },
  };
}
