/**
 * Audit log — the compliance record of everything that touched money or personal
 * data (docs/LOCAL-FIRST-BUILD.md §9).
 *
 * Two rules shape this whole module, and they pull against each other:
 *
 *  1. An audit write must NEVER break the thing it is recording. A failed insert
 *     cannot fail a refund. So `recordAudit` swallows every error.
 *  2. An event must never disappear quietly. So a swallowed error re-emits the
 *     entire event to stderr under a fixed, greppable prefix — the row is lost
 *     from the table but not from the record.
 *
 * Those two force a third decision: `recordAudit` uses its OWN tenant connection
 * and is called AFTER the business transaction commits. It deliberately does not
 * accept the caller's `tx`. Inside a Postgres transaction a failed INSERT aborts
 * the whole transaction — catching the error in JavaScript would not save the
 * caller's refund, it would only hide the fact that we killed it. Callers who
 * genuinely need the audit row to commit atomically with the change use
 * `buildAuditData` and write it themselves, accepting that failure aborts.
 *
 * The stored diff is the *changed fields only*, not two full snapshots: it keeps
 * a year of rows readable, and it minimizes how much personal data an audit
 * table (which is never edited and rarely deleted) accumulates. Obvious secrets
 * are redacted on the way in — an audit log is read by more people than the
 * table it describes.
 */

import type { AuthContext } from '@marina/auth';
import { forOperator, type Prisma } from '@marina/database';

// ---------------------------------------------------------------------------
// Action catalog
// ---------------------------------------------------------------------------

/**
 * Every action name the product records. A closed set rather than a free string
 * so a typo cannot silently create a parallel action that no filter ever matches
 * — the audit UI groups by exactly these values.
 */
export const AUDIT_ACTIONS = {
  PAYMENT_CAPTURE: 'payment.capture',
  PAYMENT_REFUND: 'payment.refund',
  PAYMENT_VOID: 'payment.void',
  PAYMENT_CHARGEBACK: 'payment.chargeback',
  ORDER_CREATE: 'order.create',
  ORDER_CANCEL: 'order.cancel',
  ORDER_RESCHEDULE: 'order.reschedule',
  GIFT_CARD_ISSUE: 'gift_card.issue',
  GIFT_CARD_REDEEM: 'gift_card.redeem',
  GIFT_CARD_ADJUST: 'gift_card.adjust',
  CUSTOMER_CREATE: 'customer.create',
  CUSTOMER_UPDATE: 'customer.update',
  CUSTOMER_DELETE: 'customer.delete',
  CUSTOMER_EXPORT: 'customer.export',
  WAIVER_SIGN: 'waiver.sign',
  WAIVER_EDIT: 'waiver.edit',
  STAFF_INVITE: 'staff.invite',
  STAFF_ROLE_CHANGE: 'staff.role_change',
  STAFF_DEACTIVATE: 'staff.deactivate',
  SETTINGS_UPDATE: 'settings.update',
  PAYOUT_SETTINGS_UPDATE: 'settings.payout_update',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Actions that move money. The audit page defaults to this filter. */
export const MONEY_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.PAYMENT_CAPTURE,
  AUDIT_ACTIONS.PAYMENT_REFUND,
  AUDIT_ACTIONS.PAYMENT_VOID,
  AUDIT_ACTIONS.PAYMENT_CHARGEBACK,
  AUDIT_ACTIONS.ORDER_CANCEL,
  AUDIT_ACTIONS.GIFT_CARD_ISSUE,
  AUDIT_ACTIONS.GIFT_CARD_REDEEM,
  AUDIT_ACTIONS.GIFT_CARD_ADJUST,
  AUDIT_ACTIONS.PAYOUT_SETTINGS_UPDATE,
];

/** Actions that touch personal data. */
export const PII_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.CUSTOMER_CREATE,
  AUDIT_ACTIONS.CUSTOMER_UPDATE,
  AUDIT_ACTIONS.CUSTOMER_DELETE,
  AUDIT_ACTIONS.CUSTOMER_EXPORT,
  AUDIT_ACTIONS.WAIVER_SIGN,
];

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

/**
 * Who did it. `id` is a StaffMember.auth_user_id, a Customer id, or the literal
 * "system"; `role` is the StaffRole, "customer", or "system". Both are required
 * — an unattributed audit row is not evidence.
 */
export interface AuditActor {
  id: string;
  role: string;
  /** Client IP, when the call came in over HTTP. */
  ip?: string | null;
}

/** The actor for a scheduled sweep, a webhook, or any unattended job. */
export const SYSTEM_ACTOR: AuditActor = { id: 'system', role: 'system' };

/** Derive the actor from a staff request context. */
export function staffActor(auth: AuthContext, ip?: string | null): AuditActor {
  return { id: auth.userId, role: auth.role, ip: ip ?? null };
}

/** Derive the actor from a customer (magic-link) session. */
export function customerActor(customerId: string, ip?: string | null): AuditActor {
  return { id: customerId, role: 'customer', ip: ip ?? null };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export const REDACTED = '[redacted]';

/**
 * Key fragments that make a field a secret wherever they appear. Matched against
 * the key with separators stripped, so `api_key`, `apiKey`, and `API-KEY` all
 * hit `apikey`. Deliberately narrow: `authorization` is here but not `auth`,
 * because `auth_user_id` is the actor and must stay readable.
 */
const SECRET_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'privatekey',
  'accesskey',
  'credential',
  'authorization',
  'sessionid',
  'cookie',
  'signature',
  'cvv',
  'cvc',
  'securitycode',
  'ssn',
  'socialsecurity',
  'bearer',
  'webhooksecret',
];

/**
 * Key names that are secrets only as the WHOLE name. `pin` cannot be a fragment
 * — `shipping_address` contains it.
 */
const SECRET_KEY_EXACT = new Set(['pin', 'otp', 'key', 'hash', 'salt', 'iv', 'nonce', 'cardnumber', 'pan']);

/** Strip separators and case so key matching is spelling-agnostic. */
function normalizeKey(key: string): string {
  return key.replace(/[\s_\-.]/g, '').toLowerCase();
}

export function isSecretKey(key: string): boolean {
  const k = normalizeKey(key);
  if (SECRET_KEY_EXACT.has(k)) return true;
  return SECRET_KEY_FRAGMENTS.some((fragment) => k.includes(fragment));
}

/** Processor secrets and bearer material carry their own recognizable shapes. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^(sk|rk|whsec)_[A-Za-z0-9]/, // Stripe secret / restricted / webhook-signing keys
  /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
  /^Bearer\s+\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * True when a string looks like a payment card number: 13–19 digits (spaces and
 * dashes allowed) that passes Luhn. The Luhn check is what keeps a phone number,
 * an order number, or a timestamp from being mistaken for a PAN.
 */
export function looksLikeCardNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  return luhnValid(digits);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** `4242424242424242` -> `••••4242`. Last four is the part an investigator needs. */
function maskCard(value: string): string {
  const digits = value.replace(/[\s-]/g, '');
  return `••••${digits.slice(-4)}`;
}

/** Redact a leaf string on its own shape, independent of the key it sat under. */
function redactStringValue(value: string): string {
  if (looksLikeCardNumber(value)) return maskCard(value);
  if (SECRET_VALUE_PATTERNS.some((re) => re.test(value))) return REDACTED;
  return value;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Depth beyond which nested structures are collapsed rather than walked. */
const MAX_DEPTH = 6;
/** Longest array we keep element-by-element. */
const MAX_ARRAY = 50;
/** Longest string we keep whole. */
const MAX_STRING = 2000;
/** Byte ceiling for one row's before+after payload. */
const MAX_PAYLOAD_BYTES = 32_768;

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

/**
 * Convert an arbitrary value into JSON-safe data WITHOUT redacting or
 * truncating. Diffing happens on this form so that two different secrets are
 * still seen as a change (redaction would make both `[redacted]` and therefore
 * equal), and so that a truncation boundary cannot swallow a real difference.
 *
 * Dates become ISO strings, Decimal/BigInt become strings (never floats — money
 * is integer cents and a Decimal that round-trips through `number` is a bug
 * waiting to happen), and cycles become a marker instead of throwing.
 */
export function toPlain(value: unknown, seen: WeakSet<object> = new WeakSet()): Plain {
  if (value === null || value === undefined) return null;

  const t = typeof value;
  if (t === 'string') return value as string;
  if (t === 'boolean') return value as boolean;
  if (t === 'number') return Number.isFinite(value as number) ? (value as number) : String(value);
  if (t === 'bigint') return (value as bigint).toString();
  if (t === 'function' || t === 'symbol') return `[${t}]`;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[invalid date]' : value.toISOString();
  }

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);

  try {
    if (Array.isArray(value)) return value.map((v) => toPlain(v, seen));
    if (value instanceof Map) {
      return Object.fromEntries([...value].map(([k, v]) => [String(k), toPlain(v, seen)]));
    }
    if (value instanceof Set) return [...value].map((v) => toPlain(v, seen));
    if (Buffer.isBuffer(value)) return `[binary ${value.byteLength}b]`;

    // Prisma Decimal and anything else with a meaningful toString but no own
    // enumerable data (an empty {} in the log helps nobody).
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && typeof (value as { toString?: unknown }).toString === 'function') {
      const s = String(value);
      if (s !== '[object Object]') return s;
    }

    const out: Record<string, Plain> = {};
    for (const [k, v] of entries) {
      if (v === undefined) continue; // an absent key is not the same as a null one
      out[k] = toPlain(v, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Redact secrets and clamp size. Runs AFTER diffing, on the values that survived.
 * `key` is the field name the value sat under, so key-based redaction applies to
 * whole subtrees (a `config.stripe_secret` object is dropped entirely).
 */
export function sanitize(value: Plain, key = '', depth = 0): Plain {
  if (key && isSecretKey(key)) return REDACTED;

  if (typeof value === 'string') {
    const redacted = redactStringValue(value);
    return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…[truncated]` : redacted;
  }

  if (value === null || typeof value !== 'object') return value;

  if (depth >= MAX_DEPTH) return '[nested]';

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, '', depth + 1));
    if (value.length > MAX_ARRAY) kept.push(`…${value.length - MAX_ARRAY} more`);
    return kept;
  }

  const out: Record<string, Plain> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = sanitize(v, k, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface AuditDiff {
  /** Prior values of the fields that changed; null for a creation. */
  before: Record<string, Plain> | null;
  /** New values of the fields that changed; null for a deletion. */
  after: Record<string, Plain> | null;
  /** The field names that changed, in stable order. */
  changedKeys: string[];
}

function deepEqual(a: Plain, b: Plain): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const ao = a as Record<string, Plain>;
  const bo = b as Record<string, Plain>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

function asRecord(value: unknown): Record<string, Plain> | null {
  if (value === null || value === undefined) return null;
  const plain = toPlain(value);
  if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) {
    // A non-object subject (a bare id, an amount) still deserves a record; wrap
    // it so the diff shape stays uniform.
    return { value: plain };
  }
  return plain as Record<string, Plain>;
}

/**
 * Reduce a before/after pair to only the fields that actually changed, redacted.
 *
 *  - creation (no before)  -> before null, after = the whole new record
 *  - deletion (no after)   -> before = the whole old record, after null
 *  - update                -> both sides trimmed to the changed keys
 *  - update that changed nothing -> empty objects, `changedKeys` empty
 *
 * A key missing on one side is a change to/from `null`, so an added or removed
 * field shows up rather than vanishing.
 */
export function diffRecords(before: unknown, after: unknown): AuditDiff {
  const b = asRecord(before);
  const a = asRecord(after);

  if (b === null && a === null) return { before: null, after: null, changedKeys: [] };

  if (b === null) {
    return {
      before: null,
      after: sanitize(a as Plain) as Record<string, Plain>,
      changedKeys: Object.keys(a as Record<string, Plain>).sort(),
    };
  }

  if (a === null) {
    return {
      before: sanitize(b as Plain) as Record<string, Plain>,
      after: null,
      changedKeys: Object.keys(b).sort(),
    };
  }

  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  const beforeOut: Record<string, Plain> = {};
  const afterOut: Record<string, Plain> = {};
  const changedKeys: string[] = [];

  for (const key of keys) {
    const bv = key in b ? b[key] : null;
    const av = key in a ? a[key] : null;
    if (deepEqual(bv, av)) continue;
    changedKeys.push(key);
    beforeOut[key] = sanitize(bv, key, 1);
    afterOut[key] = sanitize(av, key, 1);
  }

  return { before: beforeOut, after: afterOut, changedKeys };
}

/**
 * Keep one row's payload under the byte ceiling. A runaway blob (a base64 image
 * pasted into a note, a 5k-line settings object) would otherwise bloat the table
 * and make the timeline unusable. We degrade to the field NAMES that changed,
 * which is the fact the audit log exists to preserve.
 */
export function clampPayload(diff: AuditDiff): AuditDiff {
  const bytes = Buffer.byteLength(
    JSON.stringify({ before: diff.before, after: diff.after }) ?? '',
    'utf8',
  );
  if (bytes <= MAX_PAYLOAD_BYTES) return diff;

  const summary = {
    _truncated: true,
    _bytes: bytes,
    _changed: diff.changedKeys,
  } as unknown as Record<string, Plain>;

  return {
    before: diff.before === null ? null : summary,
    after: diff.after === null ? null : summary,
    changedKeys: diff.changedKeys,
  };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface RecordAuditInput {
  operatorId: string;
  actor: AuditActor;
  action: AuditAction;
  /** The model that changed, e.g. "Payment", "Customer", "StaffMember". */
  entityType: string;
  entityId: string;
  /** State before the change. Omit for a creation. */
  before?: unknown;
  /** State after the change. Omit for a deletion. */
  after?: unknown;
  /**
   * Extra context that is not a field on the entity — the reason for a refund,
   * the approval id, the request route. Merged into `after` under `_context` so
   * it travels with the change it explains.
   */
  context?: Record<string, unknown>;
}

/** The exact row shape written to AuditLog. Pure — safe to unit test. */
export function buildAuditData(input: RecordAuditInput): Prisma.AuditLogUncheckedCreateInput {
  const diff = clampPayload(diffRecords(input.before, input.after));

  let after = diff.after;
  if (input.context && Object.keys(input.context).length > 0) {
    const ctx = sanitize(toPlain(input.context), '', 1);
    after = { ...(after ?? {}), _context: ctx };
  }

  return {
    operator_id: input.operatorId,
    actor: input.actor.id || 'unknown',
    actor_role: input.actor.role || 'unknown',
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    before: (diff.before ?? undefined) as Prisma.InputJsonValue | undefined,
    after: (after ?? undefined) as Prisma.InputJsonValue | undefined,
    ip: input.actor.ip ?? null,
  };
}

/**
 * Record one audit event. Never throws — a failure is logged loudly under
 * `[audit] LOST EVENT` and the caller continues.
 *
 * Call this AFTER the business transaction commits. It opens its own tenant
 * connection precisely so it cannot poison the caller's transaction.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  let data: Prisma.AuditLogUncheckedCreateInput;
  try {
    data = buildAuditData(input);
  } catch (err) {
    // A diff that cannot even be built is still an event that happened.
    reportLost(input, err);
    return;
  }

  // One immediate retry: the common failure here is a transient connection
  // blip, and an audit row is worth a second attempt before it is lost.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await forOperator(input.operatorId).auditLog.create({ data, select: { id: true } });
      return;
    } catch (err) {
      if (attempt === 1) reportLost(input, err, data);
    }
  }
}

/**
 * Fixed, greppable stderr record of an event that never reached the table. The
 * full payload goes out so the row can be reconstructed from logs.
 */
function reportLost(
  input: RecordAuditInput,
  err: unknown,
  data?: Prisma.AuditLogUncheckedCreateInput,
): void {
  const payload = data ?? {
    operator_id: input.operatorId,
    actor: input.actor.id,
    actor_role: input.actor.role,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = `${input.action} ${input.entityType}:${input.entityId}`;
  }
  // eslint-disable-next-line no-console
  console.error('[audit] LOST EVENT', serialized, err);
}
