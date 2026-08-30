/**
 * Dynamic pricing rules — the data path.
 *
 * The maths lives in `@marina/core` (`pricing-rules.ts`); this file is everything
 * that touches the database, the clock, or a signing key:
 *
 *   - loading the rules that could apply to a rate, tenant-scoped by RLS,
 *   - turning `PricingRule` rows into the engine's `DynamicPricingRule` shape,
 *   - CRUD + reorder + enable/disable for the admin,
 *   - pricing one slot (used identically by the admin preview, the quote endpoint
 *     and the booking path — so the preview is not an approximation, it is the
 *     same call),
 *   - and issuing / verifying the signed price quote that makes "the price we
 *     showed is the price we charge" enforceable rather than aspirational.
 *
 * TIME AND THE SANDBOX. Lead-time rules need "now". It comes from `sandboxNow`,
 * the same injectable clock the payment simulator uses, so the Local Console can
 * jump the clock forward and watch a last-minute discount switch on — without
 * waiting for the day to pass (docs/LOCAL-FIRST-BUILD.md §4.1, `clock` provider).
 *
 * SCHEMA CAPABILITY GATE. `PricingRuleKind` in the current schema has four values
 * (SEASONAL, WEEKEND, DEMAND, GUIDE_MARKUP). The engine also implements
 * TIME_OF_DAY and LEAD_TIME, which a marina genuinely needs — a sunset premium
 * and a last-minute fill discount are two of the highest-yield rules there are.
 * Those two persist once the enum values and their four window columns exist;
 * until then `assertKindPersistable` refuses to write one with a precise,
 * actionable message instead of letting Prisma throw an opaque error. Nothing
 * else has to change when the migration lands: the reader already understands the
 * columns and the engine already prices them, which is also why the admin preview
 * can demonstrate both kinds today against unsaved drafts.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  PricingRuleKind as PrismaPricingRuleKind,
  type Prisma,
  type PricingRule,
  type TenantClient,
} from '@marina/database';
import {
  DEFAULT_PRICE_GUARDRAILS,
  PRICE_QUOTE_TTL_SECONDS,
  PRICING_RULE_KINDS,
  quoteFingerprint,
  reconcileQuote,
  resolveDynamicPrice,
  type DynamicPriceResult,
  type DynamicPricingRule,
  type PriceGuardrails,
  type PricingAdjustmentType,
  type PricingContext,
  type PricingRuleKind,
  type QuoteReconciliation,
} from '@marina/core';
import { sandboxNow } from './payments-sandbox.js';

// ===========================================================================
// Errors
// ===========================================================================

/** A typed, user-facing failure route handlers map to a clean HTTP status. */
export class PricingRuleError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'PricingRuleError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Either the request-scoped tenant client or a `withTenant` transaction client.
 * Booking prices inside its own transaction, so every entry point here has to
 * accept both; both carry the model delegates this file uses, and RLS is already
 * applied either way.
 */
export type PricingDb = TenantClient | Prisma.TransactionClient;

// ===========================================================================
// Schema capability
// ===========================================================================

/**
 * Extra columns the two window-based kinds need. Declared as `Partial` on the row
 * type so this file compiles against the schema both before and after the
 * migration that adds them — see the header note.
 */
interface ExtendedRuleColumns {
  start_minute: number | null;
  end_minute: number | null;
  min_lead_minutes: number | null;
  max_lead_minutes: number | null;
}

type PricingRuleRow = PricingRule & Partial<ExtendedRuleColumns>;

/**
 * The kinds this deployment's schema can actually store, read from the generated
 * Prisma enum rather than hardcoded — so the set widens by itself the moment the
 * enum does, with no code change and no chance of the two drifting apart.
 */
export const PERSISTABLE_RULE_KINDS: ReadonlySet<PricingRuleKind> = new Set(
  PRICING_RULE_KINDS.filter((k) => k in PrismaPricingRuleKind),
);

/** True when this deployment can store TIME_OF_DAY / LEAD_TIME rules. */
export const supportsKind = (kind: PricingRuleKind): boolean => PERSISTABLE_RULE_KINDS.has(kind);

function assertKindPersistable(kind: PricingRuleKind): void {
  if (supportsKind(kind)) return;
  throw new PricingRuleError(
    'KIND_NOT_MIGRATED',
    `Pricing rule kind "${kind}" needs the pricing-rule window migration ` +
      `(PricingRuleKind.${kind} plus the start_minute/end_minute/min_lead_minutes/` +
      `max_lead_minutes columns). It can be previewed but not saved yet.`,
    409,
  );
}

// ===========================================================================
// Guardrails
// ===========================================================================

/** Read a positive float env override, falling back to the platform default. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * The floor/ceiling a composed price is clamped into for this operator.
 *
 * Deliberately not a per-operator column yet: these are a safety net against a
 * mis-typed rule, not a pricing lever, and a knob an operator can widen is a
 * safety net an operator can remove. Env overrides exist so a deployment can
 * tighten them; the signature already takes the operator so a future
 * per-operator column is a one-line change here and nowhere else.
 */
export function guardrailsForOperator(_operatorId: string): PriceGuardrails {
  return {
    minMultiplier: envNumber('PRICING_MIN_MULTIPLIER', DEFAULT_PRICE_GUARDRAILS.minMultiplier),
    maxMultiplier: envNumber('PRICING_MAX_MULTIPLIER', DEFAULT_PRICE_GUARDRAILS.maxMultiplier),
    absoluteFloorCents: Math.trunc(
      envNumber('PRICING_ABSOLUTE_FLOOR_CENTS', DEFAULT_PRICE_GUARDRAILS.absoluteFloorCents),
    ),
  };
}

// ===========================================================================
// Row <-> engine mapping
// ===========================================================================

/**
 * Map a database row onto the engine's rule shape. The engine only reads the
 * fields its `kind` cares about, so the unused columns cost nothing.
 */
export function toDynamicRule(row: PricingRuleRow): DynamicPricingRule {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as PricingRuleKind,
    adjustmentType: row.adjustment_type as PricingAdjustmentType,
    adjustmentValue: row.adjustment_value,
    priority: row.priority,
    isActive: row.is_active,
    activityId: row.activity_id,
    rateId: row.rate_id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    weekdays: row.weekdays,
    demandThreshold: row.demand_threshold,
    startMinute: row.start_minute ?? null,
    endMinute: row.end_minute ?? null,
    minLeadMinutes: row.min_lead_minutes ?? null,
    maxLeadMinutes: row.max_lead_minutes ?? null,
  };
}

/**
 * Load every rule that could apply to one activity/rate: bound to this rate,
 * bound to this activity, or operator-wide. RLS scopes the query to the tenant;
 * the engine still re-checks scope, because a rule that leaked into the result
 * set must not be able to leak into a price.
 *
 * Ordered by (priority, id) purely so logs and debugging read sensibly — the
 * engine's outcome is independent of it by design.
 */
export async function loadRulesForRate(
  db: PricingDb,
  input: { activityId: string; rateId: string; includeInactive?: boolean },
): Promise<DynamicPricingRule[]> {
  const rows = (await db.pricingRule.findMany({
    where: {
      ...(input.includeInactive ? {} : { is_active: true }),
      OR: [
        { rate_id: input.rateId },
        { rate_id: null, activity_id: input.activityId },
        { rate_id: null, activity_id: null },
      ],
    },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  })) as PricingRuleRow[];
  return rows.map(toDynamicRule);
}

// ===========================================================================
// Pricing one slot
// ===========================================================================

export interface SlotPricingInput {
  activityId: string;
  rateId: string;
  /** The rate's list price in integer cents. */
  basePriceCents: number;
  /** Start of the slot being priced. */
  slotStart: Date;
  /** Seats sold / seats offered. Omitted => DEMAND rules do not fire. */
  capacityTotal?: number | null;
  capacityBooked?: number | null;
  /** Override the clock (tests, backfills). Defaults to the sandbox clock. */
  now?: Date;
  /** Pre-loaded rules — pass these to price several slots without re-querying. */
  rules?: readonly DynamicPricingRule[];
}

/**
 * Resolve the effective per-unit price for one slot. THE single entry point:
 * booking, the quote endpoint and the admin preview all land here, which is what
 * makes "what the preview showed" and "what the guest is charged" the same
 * computation rather than two implementations that agree until they don't.
 */
export async function priceSlot(
  db: PricingDb,
  operatorId: string,
  input: SlotPricingInput,
): Promise<DynamicPriceResult> {
  const rules =
    input.rules ??
    (await loadRulesForRate(db, { activityId: input.activityId, rateId: input.rateId }));

  const now = input.now ?? (await sandboxNow(db as TenantClient, operatorId));

  const total = input.capacityTotal ?? 0;
  const booked = input.capacityBooked ?? 0;
  const ctx: PricingContext = {
    slotStart: input.slotStart,
    now,
    // A slot with no capacity has no demand signal — 0/0 is not "empty", it is
    // "unknown", and a DEMAND rule must not fire on a guess.
    bookedRatio: total > 0 ? booked / total : null,
    activityId: input.activityId,
    rateId: input.rateId,
  };

  return resolveDynamicPrice(input.basePriceCents, rules, ctx, guardrailsForOperator(operatorId));
}

// ===========================================================================
// Signed price quotes
// ===========================================================================

/** The payload carried inside a quote token. Short keys: it travels in a form field. */
interface QuoteTokenPayload {
  v: 1;
  oid: string;
  aid: string;
  rid: string;
  tid: string;
  qty: number;
  /** Effective unit price the guest was shown, integer cents. */
  unit: number;
  /** Rate list price at quote time, integer cents. */
  base: number;
  /** Ids of the rules that produced the price, sorted. */
  rules: string[];
  /** Epoch milliseconds. */
  iat: number;
  exp: number;
}

export interface IssuedPriceQuote {
  token: string;
  unitPriceCents: number;
  basePriceCents: number;
  expiresAt: Date;
  issuedAt: Date;
  result: DynamicPriceResult;
}

let cachedQuoteSecret: Buffer | null = null;
let warnedEphemeralSecret = false;

/**
 * The quote-signing key. `PRICE_QUOTE_SECRET` in any real deployment; locally a
 * per-process random key, which means restarting the API invalidates outstanding
 * quotes. That is the honest local behaviour (and the same shape customer-auth
 * uses) — the alternative, a hardcoded default, is a key that eventually ships
 * and lets anyone mint their own price.
 */
function quoteSecret(): Buffer {
  if (cachedQuoteSecret) return cachedQuoteSecret;
  const configured = process.env.PRICE_QUOTE_SECRET?.trim() || process.env.CUSTOMER_SESSION_SECRET?.trim();
  if (configured) {
    cachedQuoteSecret = Buffer.from(configured, 'utf8');
    return cachedQuoteSecret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('pricing-rules: PRICE_QUOTE_SECRET is required in production.');
  }
  if (!warnedEphemeralSecret) {
    warnedEphemeralSecret = true;
    console.warn(
      '[pricing-rules] PRICE_QUOTE_SECRET is not set — signing price quotes with a ' +
        'per-process key. Restarting the API invalidates outstanding quotes.',
    );
  }
  cachedQuoteSecret = randomBytes(32);
  return cachedQuoteSecret;
}

/** Test seam: drop the cached key so a test can swap the env var. */
export function resetQuoteSecretCache(): void {
  cachedQuoteSecret = null;
}

/**
 * Sign the CANONICAL fingerprint rather than the encoded payload, so the
 * signature is over the meaning of the quote, not over one particular encoding
 * of it. Two servers that agree on the facts produce the same signature.
 */
function signQuote(payload: QuoteTokenPayload): string {
  const fingerprint = quoteFingerprint({
    operatorId: payload.oid,
    activityId: payload.aid,
    rateId: payload.rid,
    timeslotId: payload.tid,
    quantity: payload.qty,
    unitPriceCents: payload.unit,
    basePriceCents: payload.base,
    ruleIds: payload.rules,
    issuedAtMs: payload.iat,
    expiresAtMs: payload.exp,
  });
  return createHmac('sha256', quoteSecret()).update(fingerprint).digest('base64url');
}

/**
 * Price a slot and hand back a token the checkout can carry. The token is opaque
 * to the guest and unforgeable without the key, so the price on the confirm step
 * is a server fact, not a client-supplied number.
 */
export async function issuePriceQuote(
  db: PricingDb,
  operatorId: string,
  input: SlotPricingInput & { timeslotId: string; quantity: number; ttlSeconds?: number },
): Promise<IssuedPriceQuote> {
  const result = await priceSlot(db, operatorId, input);
  const now = input.now ?? (await sandboxNow(db as TenantClient, operatorId));
  const issuedAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const ttl = Math.max(1, Math.trunc(input.ttlSeconds ?? PRICE_QUOTE_TTL_SECONDS));
  const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);

  const payload: QuoteTokenPayload = {
    v: 1,
    oid: operatorId,
    aid: input.activityId,
    rid: input.rateId,
    tid: input.timeslotId,
    qty: Math.max(1, Math.trunc(input.quantity)),
    unit: result.priceCents,
    base: result.basePriceCents,
    rules: result.applied.map((a) => a.ruleId).sort(),
    iat: issuedAt.getTime(),
    exp: expiresAt.getTime(),
  };

  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return {
    token: `${body}.${signQuote(payload)}`,
    unitPriceCents: result.priceCents,
    basePriceCents: result.basePriceCents,
    expiresAt,
    issuedAt,
    result,
  };
}

export interface VerifiedQuote {
  payload: QuoteTokenPayload;
  signatureValid: boolean;
  expired: boolean;
}

/**
 * Decode and check a quote token. Returns null only when the token is not even
 * shaped like one; a token that parses but fails its signature comes back with
 * `signatureValid: false` so the caller can re-price rather than 500.
 */
export function verifyPriceQuote(token: string | null | undefined, now: Date): VerifiedQuote | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  let payload: QuoteTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as QuoteTokenPayload;
  } catch {
    return null;
  }
  if (payload?.v !== 1 || typeof payload.unit !== 'number' || !Array.isArray(payload.rules)) {
    return null;
  }

  const expectedSig = signQuote(payload);
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  // Length-check first: timingSafeEqual throws on a length mismatch.
  const signatureValid =
    provided.length === expected.length && timingSafeEqual(provided, expected);

  return { payload, signatureValid, expired: now.getTime() > payload.exp };
}

export interface PriceReconciliation extends QuoteReconciliation {
  /** The freshly resolved price, for logging what the rules say right now. */
  current: DynamicPriceResult;
  /** True when the presented quote was for a different slot/rate/quantity. */
  mismatchedSubject: boolean;
}

/**
 * The checkout-time decision: re-resolve from live rules, compare against the
 * quote the guest is holding, and return the price to charge.
 *
 * A quote for a DIFFERENT subject (another slot, rate or quantity) is treated as
 * no quote at all — otherwise a guest could carry a cheap kayak quote into a
 * pontoon booking. `mismatchedSubject` is surfaced so the caller can log it,
 * because it should never happen in the normal flow.
 */
export async function reconcileSlotPrice(
  db: PricingDb,
  operatorId: string,
  input: SlotPricingInput & { timeslotId: string; quantity: number; quoteToken?: string | null },
): Promise<PriceReconciliation> {
  const now = input.now ?? (await sandboxNow(db as TenantClient, operatorId));
  const current = await priceSlot(db, operatorId, { ...input, now });
  const verified = verifyPriceQuote(input.quoteToken, now);

  const mismatchedSubject =
    verified != null &&
    (verified.payload.oid !== operatorId ||
      verified.payload.aid !== input.activityId ||
      verified.payload.rid !== input.rateId ||
      verified.payload.tid !== input.timeslotId ||
      verified.payload.qty !== Math.max(1, Math.trunc(input.quantity)));

  const usable = verified != null && !mismatchedSubject;
  const reconciliation = reconcileQuote({
    quotedUnitPriceCents: usable ? verified!.payload.unit : current.priceCents,
    currentUnitPriceCents: current.priceCents,
    signatureValid: usable ? verified!.signatureValid : false,
    expired: usable ? verified!.expired : true,
  });

  return { ...reconciliation, current, mismatchedSubject };
}

// ===========================================================================
// CRUD
// ===========================================================================

/** What the admin/API may set on a rule. Ids and timestamps are the server's. */
export interface PricingRuleInput {
  name: string;
  kind: PricingRuleKind;
  adjustmentType: PricingAdjustmentType;
  adjustmentValue: number;
  priority?: number;
  isActive?: boolean;
  activityId?: string | null;
  rateId?: string | null;
  startsOn?: Date | null;
  endsOn?: Date | null;
  weekdays?: number[] | null;
  startMinute?: number | null;
  endMinute?: number | null;
  minLeadMinutes?: number | null;
  maxLeadMinutes?: number | null;
  demandThreshold?: number | null;
}

/** Widest sane percentage. Past this it is a typo, not a price. */
const MAX_PERCENT = 1_000;
/** Widest sane flat adjustment: ±$10,000. */
const MAX_FLAT_CENTS = 1_000_000;

/**
 * Cross-field validation the shape check cannot express: a rule whose condition
 * can never be evaluated is worse than no rule, because the operator believes it
 * is working. Every message names the field an operator can go fix.
 */
export function validatePricingRuleInput(input: PricingRuleInput): void {
  if (!PRICING_RULE_KINDS.includes(input.kind)) {
    throw new PricingRuleError('INVALID_KIND', `Unknown pricing rule kind "${input.kind}".`);
  }

  if (input.adjustmentType === 'PERCENT') {
    if (!Number.isFinite(input.adjustmentValue) || Math.abs(input.adjustmentValue) > MAX_PERCENT) {
      throw new PricingRuleError(
        'INVALID_ADJUSTMENT',
        `A percentage adjustment must be between -${MAX_PERCENT}% and ${MAX_PERCENT}%.`,
      );
    }
  } else if (
    !Number.isInteger(input.adjustmentValue) ||
    Math.abs(input.adjustmentValue) > MAX_FLAT_CENTS
  ) {
    throw new PricingRuleError(
      'INVALID_ADJUSTMENT',
      'A flat adjustment must be a whole number of cents within ±$10,000.',
    );
  }

  if (input.adjustmentValue === 0) {
    throw new PricingRuleError('INVALID_ADJUSTMENT', 'A rule that adjusts by zero does nothing.');
  }

  switch (input.kind) {
    case 'SEASONAL':
      if (input.startsOn && input.endsOn && input.startsOn > input.endsOn) {
        throw new PricingRuleError('INVALID_WINDOW', 'The season ends before it starts.');
      }
      break;

    case 'WEEKEND':
      if (input.weekdays && input.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
        throw new PricingRuleError('INVALID_WEEKDAYS', 'Weekdays must be 1 (Mon) through 7 (Sun).');
      }
      break;

    case 'TIME_OF_DAY': {
      const { startMinute, endMinute } = input;
      if (startMinute == null || endMinute == null) {
        throw new PricingRuleError(
          'INVALID_WINDOW',
          'A time-of-day rule needs both a start and an end time.',
        );
      }
      if (
        !Number.isInteger(startMinute) ||
        !Number.isInteger(endMinute) ||
        startMinute < 0 ||
        startMinute > 1439 ||
        endMinute < 0 ||
        endMinute > 1439
      ) {
        throw new PricingRuleError('INVALID_WINDOW', 'Times must fall within a single day.');
      }
      break;
    }

    case 'LEAD_TIME': {
      const { minLeadMinutes, maxLeadMinutes } = input;
      if (minLeadMinutes == null && maxLeadMinutes == null) {
        throw new PricingRuleError(
          'INVALID_WINDOW',
          'A lead-time rule needs a minimum, a maximum, or both.',
        );
      }
      for (const v of [minLeadMinutes, maxLeadMinutes]) {
        if (v != null && (!Number.isInteger(v) || v < 0)) {
          throw new PricingRuleError('INVALID_WINDOW', 'Lead time must be a whole number of minutes.');
        }
      }
      if (minLeadMinutes != null && maxLeadMinutes != null && minLeadMinutes > maxLeadMinutes) {
        throw new PricingRuleError(
          'INVALID_WINDOW',
          'The minimum lead time is longer than the maximum, so nothing can match.',
        );
      }
      break;
    }

    case 'DEMAND':
      if (
        input.demandThreshold == null ||
        !Number.isFinite(input.demandThreshold) ||
        input.demandThreshold < 0 ||
        input.demandThreshold > 1
      ) {
        throw new PricingRuleError(
          'INVALID_THRESHOLD',
          'A demand rule needs a booked-ratio threshold between 0 and 1.',
        );
      }
      break;

    case 'GUIDE_MARKUP':
      break;
  }
}

/**
 * The columns only the extended kinds use. Empty for every kind the current
 * schema supports, so the write never mentions a column that is not there.
 */
function extendedColumns(input: PricingRuleInput): Partial<ExtendedRuleColumns> {
  if (input.kind === 'TIME_OF_DAY') {
    return { start_minute: input.startMinute ?? null, end_minute: input.endMinute ?? null };
  }
  if (input.kind === 'LEAD_TIME') {
    return {
      min_lead_minutes: input.minLeadMinutes ?? null,
      max_lead_minutes: input.maxLeadMinutes ?? null,
    };
  }
  return {};
}

/**
 * Scalars shared by create and update. Fields belonging to other kinds are
 * explicitly nulled rather than left alone: changing a rule from SEASONAL to
 * DEMAND must not leave a stale date window behind that a future schema change
 * could start honouring again.
 */
function ruleScalars(input: PricingRuleInput) {
  return {
    name: input.name.trim(),
    adjustment_type: input.adjustmentType,
    adjustment_value: Math.trunc(input.adjustmentValue),
    priority: Math.trunc(input.priority ?? 0),
    is_active: input.isActive ?? true,
    activity_id: input.activityId ?? null,
    rate_id: input.rateId ?? null,
    starts_on: input.kind === 'SEASONAL' ? input.startsOn ?? null : null,
    ends_on: input.kind === 'SEASONAL' ? input.endsOn ?? null : null,
    weekdays: input.kind === 'WEEKEND' ? input.weekdays ?? [] : [],
    demand_threshold: input.kind === 'DEMAND' ? input.demandThreshold ?? null : null,
    ...extendedColumns(input),
  };
}

/**
 * A rate-scoped rule must belong to the activity it also names, or the scope is
 * self-contradictory and would silently never fire.
 */
async function assertScopeCoherent(db: PricingDb, input: PricingRuleInput): Promise<void> {
  if (input.rateId) {
    const rate = await db.rate.findUnique({
      where: { id: input.rateId },
      select: { activity_id: true },
    });
    if (!rate) throw new PricingRuleError('RATE_NOT_FOUND', 'That rate no longer exists.', 404);
    if (input.activityId && rate.activity_id !== input.activityId) {
      throw new PricingRuleError(
        'SCOPE_MISMATCH',
        'That rate belongs to a different activity than the one selected.',
      );
    }
    return;
  }
  if (input.activityId) {
    const activity = await db.activity.findUnique({
      where: { id: input.activityId },
      select: { id: true },
    });
    if (!activity) {
      throw new PricingRuleError('ACTIVITY_NOT_FOUND', 'That activity no longer exists.', 404);
    }
  }
}

/** Every rule for this tenant, newest precedence first. */
export async function listPricingRules(db: PricingDb): Promise<PricingRuleRow[]> {
  return (await db.pricingRule.findMany({
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  })) as PricingRuleRow[];
}

export async function createPricingRule(
  db: PricingDb,
  operatorId: string,
  input: PricingRuleInput,
): Promise<PricingRuleRow> {
  validatePricingRuleInput(input);
  assertKindPersistable(input.kind);
  await assertScopeCoherent(db, input);

  // Top-level create: `operator_id` is explicit (D-011 — only nested creates under
  // a tenant-composite parent omit it).
  const data = {
    operator_id: operatorId,
    kind: input.kind,
    ...ruleScalars(input),
  } as Prisma.PricingRuleUncheckedCreateInput;

  return (await db.pricingRule.create({ data })) as PricingRuleRow;
}

export async function updatePricingRule(
  db: PricingDb,
  id: string,
  input: PricingRuleInput,
): Promise<PricingRuleRow> {
  validatePricingRuleInput(input);
  assertKindPersistable(input.kind);
  await assertScopeCoherent(db, input);

  const data = { kind: input.kind, ...ruleScalars(input) } as Prisma.PricingRuleUncheckedUpdateInput;

  // updateMany, not update: RLS already scopes the row, and a count of 0 is a
  // clean 404 instead of a thrown P2025 that has to be caught and translated.
  const { count } = await db.pricingRule.updateMany({ where: { id }, data });
  if (count === 0) throw new PricingRuleError('NOT_FOUND', 'Pricing rule not found.', 404);

  const row = await db.pricingRule.findUnique({ where: { id } });
  if (!row) throw new PricingRuleError('NOT_FOUND', 'Pricing rule not found.', 404);
  return row as PricingRuleRow;
}

export async function setPricingRuleActive(
  db: PricingDb,
  id: string,
  isActive: boolean,
): Promise<PricingRuleRow> {
  const { count } = await db.pricingRule.updateMany({ where: { id }, data: { is_active: isActive } });
  if (count === 0) throw new PricingRuleError('NOT_FOUND', 'Pricing rule not found.', 404);
  const row = await db.pricingRule.findUnique({ where: { id } });
  if (!row) throw new PricingRuleError('NOT_FOUND', 'Pricing rule not found.', 404);
  return row as PricingRuleRow;
}

export async function deletePricingRule(db: PricingDb, id: string): Promise<void> {
  const { count } = await db.pricingRule.deleteMany({ where: { id } });
  if (count === 0) throw new PricingRuleError('NOT_FOUND', 'Pricing rule not found.', 404);
}

/**
 * Renumber priorities from an explicit ordering — the "move up / move down"
 * gesture in the admin.
 *
 * Priorities are rewritten as a dense 0..n-1 sequence rather than nudged, so
 * repeated reordering cannot drift into duplicate or sparse values that make the
 * id tiebreaker (rather than the operator's intent) decide the outcome. Ids not
 * belonging to this tenant simply update nothing, courtesy of RLS.
 */
export async function reorderPricingRules(db: PricingDb, orderedIds: string[]): Promise<number> {
  const seen = new Set<string>();
  let updated = 0;
  for (const id of orderedIds) {
    if (seen.has(id)) {
      throw new PricingRuleError('DUPLICATE_ID', 'The same rule appears twice in the ordering.');
    }
    seen.add(id);
  }
  for (let i = 0; i < orderedIds.length; i++) {
    const { count } = await db.pricingRule.updateMany({
      where: { id: orderedIds[i]! },
      data: { priority: i },
    });
    updated += count;
  }
  return updated;
}

// ===========================================================================
// Preview
// ===========================================================================

export interface PreviewInput {
  activityId: string;
  rateId: string;
  /** The moment being priced. */
  slotStart: Date;
  /** When the hypothetical booking is made, for lead-time rules. */
  now?: Date;
  capacityTotal?: number | null;
  capacityBooked?: number | null;
  /**
   * Unsaved rules to price INSTEAD of the stored ones. This is what lets an
   * operator see the effect of a rule before committing to it — the reason the
   * preview earns trust.
   */
  draftRules?: readonly DynamicPricingRule[];
}

export interface PreviewResult extends DynamicPriceResult {
  rateName: string;
  activityName: string;
  slotStart: Date;
}

/**
 * Price a hypothetical slot for the admin. Resolves the rate's real list price so
 * the number on screen is the number a guest would see, then runs the identical
 * engine call the booking path runs.
 */
export async function previewPrice(
  db: PricingDb,
  operatorId: string,
  input: PreviewInput,
): Promise<PreviewResult> {
  const rate = await db.rate.findUnique({
    where: { id: input.rateId },
    select: {
      price_cents: true,
      name_external: true,
      activity_id: true,
      activity: { select: { name_external: true } },
    },
  });
  if (!rate) throw new PricingRuleError('RATE_NOT_FOUND', 'That rate no longer exists.', 404);
  if (rate.activity_id !== input.activityId) {
    throw new PricingRuleError('SCOPE_MISMATCH', 'That rate belongs to a different activity.');
  }

  const result = await priceSlot(db, operatorId, {
    activityId: input.activityId,
    rateId: input.rateId,
    basePriceCents: rate.price_cents,
    slotStart: input.slotStart,
    capacityTotal: input.capacityTotal,
    capacityBooked: input.capacityBooked,
    now: input.now,
    rules: input.draftRules,
  });

  return {
    ...result,
    rateName: rate.name_external,
    activityName: rate.activity.name_external,
    slotStart: input.slotStart,
  };
}
