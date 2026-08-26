/**
 * OTA / affiliate channel distribution.
 *
 * docs/LOCAL-FIRST-BUILD.md §2 names distribution as FareHarbor's real lock-in:
 * an operator stays because their bookings arrive from Viator, GetYourGuide and
 * affiliates. §8 requires that abstraction to ship with a *local mock channel* so
 * the whole loop — inventory push, booking pull, commission tracking — is
 * exercisable with no partner account anywhere.
 *
 * So this module is the same shape as the payments sandbox: a driver interface,
 * a registry, pure money helpers that are unit-tested directly, and orchestration
 * that owns every database write. Drivers never touch Prisma; they speak the
 * partner's protocol and hand back normalized payloads.
 *
 * THREE INVARIANTS THIS FILE EXISTS TO HOLD:
 *
 *  1. A channel booking is a NORMAL Order. It goes through `createBooking`, which
 *     means it re-checks timeslot capacity AND the shared-resource engine. An OTA
 *     sells from a snapshot that is always slightly stale, so an oversell attempt
 *     is not an edge case — it is Tuesday. It must be rejected, not absorbed.
 *  2. Delivery is at-least-once. Partners retry and do not deduplicate, so the
 *     unique index on (operator, channel, external_ref) is the guard and a repeat
 *     import is a no-op rather than a second boat rental.
 *  3. Commission is snapshotted in integer cents at import time. Renegotiating a
 *     rate next season must never rewrite what last season actually cost.
 *
 * Money is integer cents throughout, times are UTC.
 */
import { forOperator, withTenant } from '@marina/database';
import type { Prisma, TenantClient } from '@marina/database';
import { calculatePricing, roundCents, type BookingInput, type PricingFee } from '@marina/core';
import { BookingError, cancelBooking, createBooking } from './booking.js';
import { sandboxNow } from './payments-sandbox.js';
import { createMockChannelDriver } from './channel-mock.js';

// ===========================================================================
// Types (string unions structurally identical to the Prisma enums)
// ===========================================================================

/** Mirrors the Prisma `ChannelKind` enum, in declaration order. */
export const CHANNEL_KINDS = [
  'MOCK',
  'VIATOR',
  'GET_YOUR_GUIDE',
  'EXPEDIA',
  'TRIPADVISOR',
  'AIRBNB_EXPERIENCES',
  'CUSTOM',
] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** A typed, user-facing failure that route handlers map to a clean HTTP status. */
export class ChannelError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    this.status = status;
  }
}

// ===========================================================================
// The driver contract
// ===========================================================================

/**
 * One sellable rate on a pushed listing. The partner echoes `rateId` back.
 *
 * The retail pair is what a partner actually needs: a marketplace advertises the
 * all-in price a guest pays, not our pre-fee base. It is published as
 * "first traveller, then each additional" because that is the only shape that
 * stays exact when the fee list mixes a flat per-booking fee with percentage tax
 * — multiplying one all-in price by the party size would charge the flat fee once
 * per head, and every OTA reconciliation would then disagree with us by that fee.
 */
export interface InventoryRate {
  rateId: string;
  name: string;
  /** The operator's base rate, before fees and tax. */
  priceCents: number;
  /** All-in price of a party of one, integer cents. */
  retailPriceCents: number;
  /** All-in price of each additional traveller, integer cents. */
  retailIncrementCents: number;
  durationMinutes: number;
}

/** One bookable departure. `remaining` is what we are willing to sell right now. */
export interface InventorySlot {
  timeslotId: string;
  startsAtIso: string;
  remaining: number;
}

/** An Activity as published to a partner. */
export interface InventoryListing {
  listingId: string;
  activityId: string;
  /** The partner's own id from a previous push; null on first publish. */
  externalRef: string | null;
  name: string;
  descriptionHtml: string | null;
  minParticipants: number;
  maxParticipants: number;
  rates: InventoryRate[];
  slots: InventorySlot[];
}

export interface PushInventoryResult {
  accepted: Array<{ listingId: string; externalRef: string }>;
  /** Per-listing refusals — a partner rejects one product without failing the run. */
  rejected: Array<{ listingId: string; error: string }>;
}

/**
 * A booking as it arrives from a channel, normalized.
 *
 * `rateId` / `timeslotId` are OUR ids: we published them as the partner's option
 * and availability codes on the push, and every real OTA protocol (Viator's
 * productOptionCode, GetYourGuide's optionId) echoes the supplier's own codes
 * back on the booking. That is what makes the mapping back to a Timeslot exact
 * rather than a fuzzy date match.
 */
export interface ChannelBookingPayload {
  /** The partner's booking reference. Unique per channel; our dedupe key. */
  externalRef: string;
  status: 'CONFIRMED' | 'CANCELLED';
  /** The partner's id for the listing, as returned by pushInventory. */
  listingExternalRef: string;
  rateId: string;
  timeslotId: string;
  quantity: number;
  /** What the guest actually paid the channel, integer cents. */
  grossCents: number;
  /**
   * Commission the partner states it keeps, integer cents. Null when the partner
   * has not stated one, in which case the channel's configured percent applies.
   */
  commissionCents: number | null;
  /**
   * True when the channel collected the money (an OTA). False for a referral
   * affiliate that sends the guest to us to pay — the commission is still owed,
   * but the balance is ours to collect at the dock.
   */
  prepaid: boolean;
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
  };
  /** Who is actually turning up, when the payer and the traveller differ. */
  leadTravellerName: string | null;
  bookedAtIso: string;
  /** The payload exactly as received, kept for reconciliation disputes. */
  raw: Record<string, unknown>;
}

export interface PullBookingsResult {
  bookings: ChannelBookingPayload[];
  /**
   * Opaque partner cursor to hand back on the next pull, or null when the
   * partner has no more to give. Persisted in the driver's own state.
   */
  cursor: string | null;
}

export interface ChannelCancelResult {
  externalRef: string;
  accepted: boolean;
  /** What the partner says the cancellation costs us, integer cents. */
  penaltyCents: number;
  reason: string | null;
}

/**
 * Private, durable storage for one driver on one channel. A real driver needs
 * this as much as the mock does: OAuth tokens, a delivery cursor, the last
 * catalog hash it pushed. Backed by `Channel.config.driver`.
 */
export interface ChannelStateStore {
  load(): Promise<Record<string, unknown>>;
  save(state: Record<string, unknown>): Promise<void>;
}

/** Everything a driver is allowed to know. Deliberately free of Prisma. */
export interface ChannelDriverContext {
  operatorId: string;
  channelId: string;
  channelName: string;
  kind: ChannelKind;
  /** Credentials and partner settings, verbatim from `Channel.config`. */
  config: Record<string, unknown>;
  /** The channel's configured commission rate, whole percent. */
  commissionPercent: number;
  /** Sandbox-aware clock, so jumping the Local Console clock moves the channel. */
  now: Date;
  state: ChannelStateStore;
}

/**
 * The four verbs every distribution partner supports, under whatever name.
 *
 * WHAT A REAL DRIVER WOULD NEED — not implemented here, and deliberately so:
 * both partners gate API access behind a signed supplier agreement, so neither
 * can be built or tested on this laptop (§0). The interface is shaped to their
 * actual protocols so slotting them in is a new file plus a `registerChannelDriver`
 * call, not a refactor.
 *
 *   VIATOR (Booking Access API, supplier side)
 *     - Credentials: an `exp-api-key` header issued per supplier, plus the
 *       Accept-version header (`application/json;version=2.0`). Store both in
 *       `Channel.config`.
 *     - pushInventory: Viator pulls rather than accepts a push — the supplier
 *       exposes /availability and /products endpoints Viator polls, so this method
 *       would write the catalog to a cache table the public partner API serves
 *       (Phase 4's "customer-facing booking API for partners"). `externalRef`
 *       becomes the Viator productCode; `rateId` maps to productOptionCode and
 *       `timeslotId` to the availability `bookableItem` start time.
 *     - pullBookings: Viator POSTs booking notifications to a supplier webhook;
 *       the driver would read a durable inbox table rather than call out, and the
 *       cursor is the notification id watermark. Viator requires a
 *       hold-then-confirm two-phase flow: /booking/hold reserves for ~30 minutes,
 *       /booking/confirm commits. Our `createBooking` is single-phase, so the hold
 *       would need a HOLD-status Order or a reservation row that expires.
 *     - acknowledge: a 200 on the notification with the supplier reference.
 *     - cancel: POST /booking/cancel with the bookingRef and a reason code from
 *       their fixed enum; the response states the cancellation penalty.
 *
 *   GETYOURGUIDE (Supplier API / OCTO)
 *     - Credentials: OAuth2 client credentials; the token needs caching in the
 *       driver state store with its expiry, refreshed on 401.
 *     - pushInventory: PUT /1/products/{id} then PUT /1/availabilities in bulk —
 *       a genuine push, one call per product plus a batched availability window
 *       (they cap the window at 12 months). Their id is returned and becomes
 *       `externalRef`.
 *     - pullBookings: GET /1/bookings?updatedSince= with a page cursor — maps
 *       exactly onto `PullBookingsResult.cursor`. GetYourGuide also uses
 *       reserve/confirm, and their reservation TTL is configurable per product.
 *     - acknowledge: POST /1/bookings/{id}/acknowledge; unacknowledged bookings
 *       are redelivered, which is exactly the behaviour the mock reproduces.
 *     - cancel: POST /1/bookings/{id}/cancel with a reason; they return the
 *       refund split so `penaltyCents` is real money, not a placeholder.
 *
 * Both partners require idempotent handling of redelivered bookings and both
 * reserve the right to send a cancellation for a booking we never received. The
 * import path handles both cases; see `importChannelBooking`.
 */
export interface ChannelDriver {
  readonly kind: ChannelKind;
  /** Publish (or republish) the operator's catalog and availability. */
  pushInventory(listings: InventoryListing[]): Promise<PushInventoryResult>;
  /** Fetch bookings and cancellations the partner has not seen us acknowledge. */
  pullBookings(opts: { since: Date | null; cursor: string | null; limit: number }): Promise<PullBookingsResult>;
  /** Tell the partner we have durably absorbed these references. */
  acknowledge(externalRefs: string[]): Promise<void>;
  /** Cancel at the partner, operator-initiated (boat broke, weather). */
  cancel(req: { externalRef: string; reason: string }): Promise<ChannelCancelResult>;
}

export type ChannelDriverFactory = (ctx: ChannelDriverContext) => ChannelDriver;

// ===========================================================================
// Driver registry
// ===========================================================================

const DRIVERS = new Map<ChannelKind, ChannelDriverFactory>([['MOCK', createMockChannelDriver]]);

/** Slot a real partner in without touching this file. */
export function registerChannelDriver(kind: ChannelKind, factory: ChannelDriverFactory): void {
  DRIVERS.set(kind, factory);
}

export function hasChannelDriver(kind: ChannelKind): boolean {
  return DRIVERS.has(kind);
}

export function driverFor(kind: ChannelKind, ctx: ChannelDriverContext): ChannelDriver {
  const factory = DRIVERS.get(kind);
  if (!factory) {
    throw new ChannelError(
      'DRIVER_NOT_IMPLEMENTED',
      `No driver for ${kind}. Implement ChannelDriver and call registerChannelDriver('${kind}', ...) — see the ChannelDriver doc comment for what that partner's protocol requires.`,
      501,
    );
  }
  return factory(ctx);
}

// ===========================================================================
// Pure money helpers — no I/O, unit-tested directly
// ===========================================================================

/** Commission rates are a whole percent in the schema; keep the math in range. */
export function normalizeCommissionPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.trunc(percent)));
}

/**
 * What the channel keeps on one booking, in integer cents.
 *
 * Half-up via `roundCents`, then clamped to the gross: a 100% channel keeps
 * everything and nothing can ever produce a negative payout to the operator.
 * Rounding happens PER BOOKING because that is where the partner rounds too —
 * which is why the sum of commissions is not the commission of the sum, and why
 * `summarizeChannelBookings` adds up snapshots instead of recomputing.
 */
export function commissionCents(grossCents: number, commissionPercent: number): number {
  if (!Number.isFinite(grossCents) || grossCents <= 0) return 0;
  const gross = Math.trunc(grossCents);
  const pct = normalizeCommissionPercent(commissionPercent);
  if (pct === 0) return 0;
  return Math.min(gross, roundCents((gross * pct) / 100));
}

export interface RetailSchedule {
  /** All-in cost of a party of one. */
  firstCents: number;
  /** All-in cost of each traveller after the first. */
  additionalCents: number;
}

/**
 * The retail price schedule to publish for one rate.
 *
 * Derived from the SAME `calculatePricing` the booking service uses, priced at
 * one and at two travellers: the difference is what each extra head costs once
 * flat per-booking fees have already been paid. Deriving it any other way would
 * let the published price and the charged price drift apart, and the whole point
 * of `ImportResult.discrepancyCents` is that a drift means something is wrong.
 */
export function retailSchedule(baseUnitPriceCents: number, fees: PricingFee[]): RetailSchedule {
  const one = calculatePricing({ items: [{ unitPriceCents: baseUnitPriceCents, quantity: 1 }], fees });
  const two = calculatePricing({ items: [{ unitPriceCents: baseUnitPriceCents, quantity: 2 }], fees });
  return {
    firstCents: one.totalCents,
    additionalCents: Math.max(0, two.totalCents - one.totalCents),
  };
}

export interface ChannelSettlement {
  grossCents: number;
  commissionCents: number;
  netCents: number;
}

/**
 * Split one booking's gross into commission and the operator's net.
 *
 * A partner-stated commission WINS over our configured percent: their remittance
 * statement is the money that actually moves, and a mid-season rate change we
 * have not been told about would otherwise make every future reconciliation
 * disagree by a few cents forever. Our percent is the estimate used only when the
 * partner states nothing.
 */
export function settleChannelAmount(
  grossCents: number,
  commissionPercent: number,
  statedCommissionCents: number | null = null,
): ChannelSettlement {
  const gross = Math.max(0, Math.trunc(Number.isFinite(grossCents) ? grossCents : 0));
  const stated =
    statedCommissionCents !== null &&
    Number.isFinite(statedCommissionCents) &&
    Number.isInteger(statedCommissionCents) &&
    statedCommissionCents >= 0
      ? Math.min(gross, statedCommissionCents)
      : null;
  const commission = stated ?? commissionCents(gross, commissionPercent);
  return { grossCents: gross, commissionCents: commission, netCents: gross - commission };
}

/** One row the commission report can aggregate. */
export interface SummarizableBooking {
  channelId: string;
  channelName: string;
  kind: ChannelKind;
  grossCents: number;
  commissionCents: number;
  /** True when the underlying Order has been cancelled. */
  cancelled: boolean;
}

export interface ChannelSummaryRow {
  channelId: string;
  channelName: string;
  kind: ChannelKind;
  bookings: number;
  cancelled: number;
  grossCents: number;
  commissionCents: number;
  netCents: number;
}

export interface ChannelSummary {
  channels: ChannelSummaryRow[];
  totals: Omit<ChannelSummaryRow, 'channelId' | 'channelName' | 'kind'>;
}

/**
 * Roll bookings up per channel.
 *
 * A cancelled booking is counted but contributes nothing to the money: the guest
 * was refunded and the partner reverses its commission, so leaving its gross in
 * the total would overstate both revenue and what we owe. Keeping the count
 * visible is what makes a channel with a 40% cancellation rate obvious.
 */
export function summarizeChannelBookings(rows: SummarizableBooking[]): ChannelSummary {
  const byChannel = new Map<string, ChannelSummaryRow>();
  for (const row of rows) {
    let entry = byChannel.get(row.channelId);
    if (!entry) {
      entry = {
        channelId: row.channelId,
        channelName: row.channelName,
        kind: row.kind,
        bookings: 0,
        cancelled: 0,
        grossCents: 0,
        commissionCents: 0,
        netCents: 0,
      };
      byChannel.set(row.channelId, entry);
    }
    entry.bookings += 1;
    if (row.cancelled) {
      entry.cancelled += 1;
      continue;
    }
    const gross = Math.max(0, Math.trunc(row.grossCents));
    const commission = Math.min(gross, Math.max(0, Math.trunc(row.commissionCents)));
    entry.grossCents += gross;
    entry.commissionCents += commission;
    entry.netCents += gross - commission;
  }

  const channels = [...byChannel.values()].sort((a, b) => b.grossCents - a.grossCents);
  const totals = channels.reduce(
    (acc, c) => ({
      bookings: acc.bookings + c.bookings,
      cancelled: acc.cancelled + c.cancelled,
      grossCents: acc.grossCents + c.grossCents,
      commissionCents: acc.commissionCents + c.commissionCents,
      netCents: acc.netCents + c.netCents,
    }),
    { bookings: 0, cancelled: 0, grossCents: 0, commissionCents: 0, netCents: 0 },
  );
  return { channels, totals };
}

// ===========================================================================
// Prisma plumbing
// ===========================================================================

/** Prisma's Json input rejects `undefined` members; a round-trip strips them. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/** Postgres unique-violation, surfaced by Prisma as P2002. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Where a driver's private state lives inside `Channel.config`. */
const DRIVER_STATE_KEY = 'driver';

/**
 * Driver state backed by `Channel.config.driver`.
 *
 * Read-modify-write, so two concurrent syncs of the SAME channel would let one
 * overwrite the other's cursor. Sync is a per-channel operation an operator or a
 * cron triggers, never a request-path fan-out, so serializing on the channel is
 * the caller's job rather than a lock here.
 */
export function prismaStateStore(db: TenantClient, channelId: string): ChannelStateStore {
  return {
    async load() {
      const row = await db.channel.findFirst({
        where: { id: channelId },
        select: { config: true },
      });
      return asRecord(asRecord(row?.config)[DRIVER_STATE_KEY]);
    },
    async save(state) {
      const row = await db.channel.findFirst({
        where: { id: channelId },
        select: { config: true },
      });
      const config = asRecord(row?.config);
      await db.channel.update({
        where: { id: channelId },
        data: { config: toJson({ ...config, [DRIVER_STATE_KEY]: state }) },
      });
    },
  };
}

/** The channel fields the orchestration actually needs. */
export interface ChannelRow {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  commission_percent: number;
  config: unknown;
}

async function loadChannel(db: TenantClient, channelId: string): Promise<ChannelRow> {
  const row = await db.channel.findFirst({
    where: { id: channelId },
    select: { id: true, name: true, kind: true, enabled: true, commission_percent: true, config: true },
  });
  if (!row) throw new ChannelError('CHANNEL_NOT_FOUND', 'Channel not found', 404);
  return row as ChannelRow;
}

/**
 * Build the driver context for a channel. The clock is the SANDBOX clock, so
 * jumping the Local Console forward six hours produces six hours of channel
 * bookings on the next pull — the same trick that makes reminders testable.
 */
async function contextFor(
  db: TenantClient,
  operatorId: string,
  channel: ChannelRow,
): Promise<ChannelDriverContext> {
  const config = asRecord(channel.config);
  // The driver's own state is namespaced; partner credentials are the rest.
  const { [DRIVER_STATE_KEY]: _driverState, ...partnerConfig } = config;
  return {
    operatorId,
    channelId: channel.id,
    channelName: channel.name,
    kind: channel.kind as ChannelKind,
    config: partnerConfig,
    commissionPercent: channel.commission_percent,
    now: await sandboxNow(db, operatorId),
    state: prismaStateStore(db, channel.id),
  };
}

/**
 * Build a driver context for a channel. Exported for the MOCK console controls,
 * which drive the marketplace directly rather than through the four verbs.
 */
export async function channelContext(
  operatorId: string,
  channelId: string,
): Promise<ChannelDriverContext> {
  const db = forOperator(operatorId);
  return contextFor(db, operatorId, await loadChannel(db, channelId));
}

/**
 * Anything a driver throws that is not already a typed ChannelError is the
 * partner failing, not us — a 502, with the partner's own words preserved.
 */
async function callPartner<T>(channelName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ChannelError) throw err;
    throw new ChannelError(
      'PARTNER_ERROR',
      `${channelName}: ${err instanceof Error ? err.message : 'partner request failed'}`,
      502,
    );
  }
}

// ===========================================================================
// Channel + listing management
// ===========================================================================

export interface CreateChannelInput {
  name: string;
  kind: ChannelKind;
  commissionPercent?: number;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export async function createChannel(operatorId: string, input: CreateChannelInput) {
  const db = forOperator(operatorId);
  if (!hasChannelDriver(input.kind)) {
    throw new ChannelError(
      'DRIVER_NOT_IMPLEMENTED',
      `${input.kind} has no driver yet; only ${[...DRIVERS.keys()].join(', ')} can be created.`,
      501,
    );
  }
  try {
    // Top-level create: operator_id is explicit (D-011).
    return await db.channel.create({
      data: {
        operator_id: operatorId,
        name: input.name.trim(),
        kind: input.kind,
        enabled: input.enabled ?? false,
        commission_percent: normalizeCommissionPercent(input.commissionPercent ?? 0),
        config: toJson(input.config ?? {}),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ChannelError('CHANNEL_EXISTS', `A channel named "${input.name}" already exists`, 409);
    }
    throw err;
  }
}

export interface UpdateChannelInput {
  name?: string;
  enabled?: boolean;
  commissionPercent?: number;
  /** Merged over the existing partner config; the driver namespace is preserved. */
  config?: Record<string, unknown>;
}

export async function updateChannel(operatorId: string, channelId: string, patch: UpdateChannelInput) {
  const db = forOperator(operatorId);
  const channel = await loadChannel(db, channelId);
  const existing = asRecord(channel.config);
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (patch.commissionPercent !== undefined) {
    data.commission_percent = normalizeCommissionPercent(patch.commissionPercent);
  }
  if (patch.config !== undefined) {
    // Merge, never replace: blowing away `config.driver` would reset the mock
    // marketplace (or a real partner's OAuth token) on an unrelated rename.
    data.config = toJson({ ...existing, ...patch.config });
  }
  try {
    return await db.channel.update({ where: { id: channelId }, data });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ChannelError('CHANNEL_EXISTS', 'A channel with that name already exists', 409);
    }
    throw err;
  }
}

export async function listChannels(operatorId: string) {
  const db = forOperator(operatorId);
  const rows = await db.channel.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { listings: true, bookings: true } } },
  });
  return rows.map((row) => ({
    ...row,
    // Never hand partner credentials back out of the API; the shape is enough.
    config: Object.keys(asRecord(row.config)).filter((k) => k !== DRIVER_STATE_KEY),
    driverImplemented: hasChannelDriver(row.kind as ChannelKind),
  }));
}

export async function listListings(operatorId: string, channelId: string) {
  const db = forOperator(operatorId);
  await loadChannel(db, channelId);
  return db.channelListing.findMany({
    where: { channel_id: channelId },
    orderBy: { created_at: 'asc' },
    include: { activity: { select: { name_external: true, status: true } } },
  });
}

/**
 * Declare exactly which activities this channel sells. Absent activities are
 * DEACTIVATED rather than deleted, because the listing carries the partner's
 * `external_ref` — dropping the row and re-pushing would orphan the product on
 * their side and duplicate it on the next sync.
 */
export async function setListings(operatorId: string, channelId: string, activityIds: string[]) {
  return withTenant(operatorId, async (tx) => {
    const channel = await tx.channel.findFirst({ where: { id: channelId }, select: { id: true } });
    if (!channel) throw new ChannelError('CHANNEL_NOT_FOUND', 'Channel not found', 404);

    const wanted = [...new Set(activityIds)];
    if (wanted.length > 0) {
      const found = await tx.activity.findMany({
        where: { id: { in: wanted } },
        select: { id: true },
      });
      if (found.length !== wanted.length) {
        throw new ChannelError('ACTIVITY_NOT_FOUND', 'One or more activities do not exist', 404);
      }
    }

    const existing = await tx.channelListing.findMany({
      where: { channel_id: channelId },
      select: { id: true, activity_id: true },
    });
    const existingByActivity = new Map(existing.map((l) => [l.activity_id, l.id]));

    for (const activityId of wanted) {
      const id = existingByActivity.get(activityId);
      if (id) {
        await tx.channelListing.update({ where: { id }, data: { is_active: true } });
      } else {
        await tx.channelListing.create({
          data: { operator_id: operatorId, channel_id: channelId, activity_id: activityId },
        });
      }
    }
    const stale = existing.filter((l) => !wanted.includes(l.activity_id)).map((l) => l.id);
    if (stale.length > 0) {
      await tx.channelListing.updateMany({ where: { id: { in: stale } }, data: { is_active: false } });
    }

    return tx.channelListing.findMany({
      where: { channel_id: channelId },
      orderBy: { created_at: 'asc' },
    });
  });
}

// ===========================================================================
// Inventory push
// ===========================================================================

/** How far ahead we publish availability. Partners cap this; 90 days is polite. */
const PUSH_HORIZON_DAYS = 90;

export interface PushReport {
  channelId: string;
  channelName: string;
  listings: number;
  slots: number;
  accepted: number;
  rejected: Array<{ listingId: string; activityId: string; error: string }>;
}

/**
 * Publish every active listing's catalog + availability to the partner, then
 * record the outcome per listing so a failed product is visible in the console
 * instead of silently missing from the marketplace.
 */
export async function pushInventory(operatorId: string, channelId: string): Promise<PushReport> {
  const db = forOperator(operatorId);
  const channel = await loadChannel(db, channelId);
  const ctx = await contextFor(db, operatorId, channel);
  const driver = driverFor(ctx.kind, ctx);

  const listingRows = await db.channelListing.findMany({
    where: { channel_id: channelId, is_active: true },
    select: { id: true, activity_id: true, external_ref: true },
  });
  if (listingRows.length === 0) {
    return {
      channelId: channel.id,
      channelName: channel.name,
      listings: 0,
      slots: 0,
      accepted: 0,
      rejected: [],
    };
  }

  const activityIds = listingRows.map((l) => l.activity_id);
  const horizon = new Date(ctx.now.getTime() + PUSH_HORIZON_DAYS * 86_400_000);
  const [activities, rates, slots, feeRows] = await Promise.all([
    db.activity.findMany({
      where: { id: { in: activityIds } },
      select: {
        id: true,
        name_external: true,
        description_html: true,
        status: true,
        min_participants: true,
        max_participants: true,
      },
    }),
    db.rate.findMany({
      where: { activity_id: { in: activityIds }, is_active: true, internal_only: false },
      select: { id: true, activity_id: true, name_external: true, price_cents: true, duration_minutes: true },
    }),
    db.timeslot.findMany({
      where: {
        activity_id: { in: activityIds },
        datetime: { gte: ctx.now, lte: horizon },
        status: { not: 'CANCELLED' },
      },
      select: { id: true, activity_id: true, datetime: true, capacity_total: true, capacity_booked: true },
      orderBy: { datetime: 'asc' },
    }),
    // Same fee resolution the booking service uses: activity-scoped fees plus
    // operator-wide ones. Publishing a price that excludes them would guarantee a
    // discrepancy on every single imported booking.
    db.fee.findMany({
      where: { enabled: true, OR: [{ activity_id: { in: activityIds } }, { activity_id: null }] },
      select: { name: true, type: true, value: true, activity_id: true },
    }),
  ]);

  const activityById = new Map(activities.map((a) => [a.id, a]));
  const payload: InventoryListing[] = [];
  const skipped: Array<{ listingId: string; activityId: string; error: string }> = [];

  for (const row of listingRows) {
    const activity = activityById.get(row.activity_id);
    if (!activity || activity.status !== 'ACTIVE') {
      skipped.push({
        listingId: row.id,
        activityId: row.activity_id,
        error: 'Activity is not active — nothing to publish',
      });
      continue;
    }
    const activityRates = rates.filter((r) => r.activity_id === row.activity_id);
    if (activityRates.length === 0) {
      skipped.push({
        listingId: row.id,
        activityId: row.activity_id,
        error: 'No public rate — a partner cannot sell a product with no price',
      });
      continue;
    }
    const fees: PricingFee[] = feeRows
      .filter((f) => f.activity_id === row.activity_id || f.activity_id === null)
      .map((f) => ({ name: f.name, type: f.type, value: f.value }));
    payload.push({
      listingId: row.id,
      activityId: row.activity_id,
      externalRef: row.external_ref,
      name: activity.name_external,
      descriptionHtml: activity.description_html,
      minParticipants: activity.min_participants,
      maxParticipants: activity.max_participants,
      rates: activityRates.map((r) => {
        const retail = retailSchedule(r.price_cents, fees);
        return {
          rateId: r.id,
          name: r.name_external,
          priceCents: r.price_cents,
          retailPriceCents: retail.firstCents,
          retailIncrementCents: retail.additionalCents,
          durationMinutes: r.duration_minutes,
        };
      }),
      slots: slots
        .filter((s) => s.activity_id === row.activity_id)
        .map((s) => ({
          timeslotId: s.id,
          startsAtIso: s.datetime.toISOString(),
          remaining: Math.max(0, s.capacity_total - s.capacity_booked),
        }))
        .filter((s) => s.remaining > 0),
    });
  }

  const result =
    payload.length > 0
      ? await callPartner(channel.name, () => driver.pushInventory(payload))
      : { accepted: [], rejected: [] as PushInventoryResult['rejected'] };

  const acceptedByListing = new Map(result.accepted.map((a) => [a.listingId, a.externalRef]));
  const rejectedByListing = new Map(result.rejected.map((r) => [r.listingId, r.error]));

  for (const row of listingRows) {
    const accepted = acceptedByListing.get(row.id);
    const error = rejectedByListing.get(row.id) ?? skipped.find((s) => s.listingId === row.id)?.error;
    await db.channelListing.update({
      where: { id: row.id },
      data: accepted
        ? { external_ref: accepted, last_synced_at: ctx.now, last_sync_error: null }
        : { last_sync_error: error ?? 'Partner did not acknowledge this listing' },
    });
  }

  const rejected = [
    ...skipped,
    ...result.rejected.map((r) => ({
      listingId: r.listingId,
      activityId: listingRows.find((l) => l.id === r.listingId)?.activity_id ?? '',
      error: r.error,
    })),
  ];

  return {
    channelId: channel.id,
    channelName: channel.name,
    listings: payload.length,
    slots: payload.reduce((n, l) => n + l.slots.length, 0),
    accepted: result.accepted.length,
    rejected,
  };
}

// ===========================================================================
// Booking import
// ===========================================================================

export type ImportStatus = 'CREATED' | 'DUPLICATE' | 'CANCELLED' | 'REJECTED';

export interface ImportResult {
  externalRef: string;
  status: ImportStatus;
  orderId: string | null;
  orderNumber: string | null;
  grossCents: number;
  commissionCents: number;
  netCents: number;
  /**
   * Gross the partner reported minus the total our own pricing produced. Non-zero
   * means their catalog is stale or a fee changed — the single most common source
   * of an OTA reconciliation dispute, so it is surfaced rather than swallowed.
   */
  discrepancyCents: number;
  code: string | null;
  message: string | null;
}

/** Actor string on every Order/OrderEvent a channel produces. */
function channelActor(channelName: string): string {
  return `channel:${channelName}`;
}

function rejected(
  externalRef: string,
  code: string,
  message: string,
  settlement?: ChannelSettlement,
): ImportResult {
  return {
    externalRef,
    status: 'REJECTED',
    orderId: null,
    orderNumber: null,
    grossCents: settlement?.grossCents ?? 0,
    commissionCents: settlement?.commissionCents ?? 0,
    netCents: settlement?.netCents ?? 0,
    discrepancyCents: 0,
    code,
    message,
  };
}

/**
 * Turn one partner payload into (or out of) a real Order.
 *
 * The ordering matters: `createBooking` runs its own transaction, so the
 * ChannelBooking row is written in a second one. If a concurrent import wins the
 * unique index in between we have a real Order nobody asked for, and the only
 * honest fix is to cancel it — which releases the capacity and resource holds it
 * took. That compensation is why this is not simply an upsert.
 */
export async function importChannelBooking(
  operatorId: string,
  channel: ChannelRow,
  payload: ChannelBookingPayload,
): Promise<ImportResult> {
  const db = forOperator(operatorId);
  const actor = channelActor(channel.name);

  const existing = await db.channelBooking.findFirst({
    where: { channel_id: channel.id, external_ref: payload.externalRef },
    select: { id: true, order_id: true, commission_cents: true },
  });

  // --- Cancellations. A partner may cancel a booking we never received (their
  //     confirm call to us timed out); acknowledging that is correct, not an error. ---
  if (payload.status === 'CANCELLED') {
    if (!existing) {
      return rejected(
        payload.externalRef,
        'UNKNOWN_BOOKING',
        'Cancellation for a booking we never imported — acknowledged, nothing to do',
      );
    }
    const order = await db.order.findFirst({
      where: { id: existing.order_id },
      select: { id: true, order_number: true, status: true, total_cents: true },
    });
    if (!order) {
      return rejected(payload.externalRef, 'ORDER_MISSING', 'The order for this booking no longer exists');
    }
    if (order.status !== 'CANCELLED') {
      await cancelBooking(operatorId, order.id, {
        actor,
        reason: `Cancelled by ${channel.name} (ref ${payload.externalRef})`,
      });
    }
    return {
      externalRef: payload.externalRef,
      status: 'CANCELLED',
      orderId: order.id,
      orderNumber: order.order_number,
      grossCents: 0,
      commissionCents: 0,
      netCents: 0,
      discrepancyCents: 0,
      code: null,
      message: null,
    };
  }

  // --- At-least-once delivery: a redelivered booking is a no-op, not a second boat. ---
  if (existing) {
    const order = await db.order.findFirst({
      where: { id: existing.order_id },
      select: { order_number: true },
    });
    return {
      externalRef: payload.externalRef,
      status: 'DUPLICATE',
      orderId: existing.order_id,
      orderNumber: order?.order_number ?? null,
      grossCents: payload.grossCents,
      commissionCents: existing.commission_cents,
      netCents: payload.grossCents - existing.commission_cents,
      discrepancyCents: 0,
      code: null,
      message: null,
    };
  }

  // --- Map the partner's listing back to one of ours. ---
  const listing = await db.channelListing.findFirst({
    where: { channel_id: channel.id, external_ref: payload.listingExternalRef },
    select: { activity_id: true, is_active: true },
  });
  if (!listing) {
    return rejected(
      payload.externalRef,
      'LISTING_NOT_FOUND',
      `No listing on ${channel.name} with reference ${payload.listingExternalRef}`,
    );
  }
  if (!listing.is_active) {
    return rejected(
      payload.externalRef,
      'LISTING_INACTIVE',
      'That product was withdrawn from this channel',
    );
  }

  const settlement = settleChannelAmount(
    payload.grossCents,
    channel.commission_percent,
    payload.commissionCents,
  );

  const input: BookingInput = {
    activityId: listing.activity_id,
    rateId: payload.rateId,
    timeslotId: payload.timeslotId,
    quantity: payload.quantity,
    customer: {
      first_name: payload.customer.firstName.trim(),
      last_name: payload.customer.lastName.trim(),
      email: payload.customer.email.trim().toLowerCase(),
      phone: payload.customer.phone ?? undefined,
    },
    participants: [
      { driver_name: (payload.leadTravellerName ?? `${payload.customer.firstName} ${payload.customer.lastName}`).trim() },
    ],
    heardAboutUs: channel.name,
  };

  let order: { id: string; order_number: string; total_cents: number; amount_paid_cents: number };
  try {
    // The real capacity gate. An OTA sells from a snapshot, so INSUFFICIENT_CAPACITY
    // and INSUFFICIENT_RESOURCE here are the expected oversell rejection, not a bug.
    const created = await createBooking(operatorId, input, { channel: 'CUSTOMER', actor });
    order = {
      id: created.id,
      order_number: created.order_number,
      total_cents: created.total_cents,
      amount_paid_cents: created.amount_paid_cents,
    };
  } catch (err) {
    if (err instanceof BookingError) {
      return rejected(payload.externalRef, err.code, err.message, settlement);
    }
    throw err;
  }

  const discrepancyCents = settlement.grossCents - order.total_cents;

  try {
    await withTenant(operatorId, async (tx) => {
      // Top-level create: operator_id is explicit (D-011).
      await tx.channelBooking.create({
        data: {
          operator_id: operatorId,
          channel_id: channel.id,
          order_id: order.id,
          external_ref: payload.externalRef,
          commission_cents: settlement.commissionCents,
          raw: toJson(payload.raw),
        },
      });

      // Prepaid = the channel already took the guest's money. Leaving a balance on
      // the order would send dock staff to collect from a guest who has paid.
      if (payload.prepaid && order.amount_paid_cents < order.total_cents) {
        await tx.order.update({
          where: { id: order.id },
          data: { amount_paid_cents: order.total_cents, balance_due_cents: 0 },
        });
      }

      await tx.orderEvent.create({
        data: {
          operator_id: operatorId,
          order_id: order.id,
          type: 'CHANNEL_BOOKING_IMPORTED',
          description:
            `Imported from ${channel.name} (ref ${payload.externalRef}); ` +
            `${(settlement.grossCents / 100).toFixed(2)} USD gross, ` +
            `${(settlement.commissionCents / 100).toFixed(2)} USD commission, ` +
            `${(settlement.netCents / 100).toFixed(2)} USD net`,
          actor,
          metadata: toJson({
            channelId: channel.id,
            channelName: channel.name,
            kind: channel.kind,
            externalRef: payload.externalRef,
            grossCents: settlement.grossCents,
            commissionCents: settlement.commissionCents,
            netCents: settlement.netCents,
            orderTotalCents: order.total_cents,
            discrepancyCents,
            prepaid: payload.prepaid,
            // What the channel settled beyond anything already collected on our
            // side (a deposit, say). Keeps the order ledger explainable.
            channelSettledCents: payload.prepaid
              ? Math.max(0, order.total_cents - order.amount_paid_cents)
              : 0,
          }),
        },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost the race to a concurrent import of the same reference. Undo the order
      // we just created so its capacity and resource holds go back.
      await cancelBooking(operatorId, order.id, {
        actor,
        reason: `Duplicate import of ${channel.name} booking ${payload.externalRef}`,
      });
      const winner = await db.channelBooking.findFirst({
        where: { channel_id: channel.id, external_ref: payload.externalRef },
        select: { order_id: true, commission_cents: true },
      });
      return {
        externalRef: payload.externalRef,
        status: 'DUPLICATE',
        orderId: winner?.order_id ?? null,
        orderNumber: null,
        grossCents: settlement.grossCents,
        commissionCents: winner?.commission_cents ?? settlement.commissionCents,
        netCents: settlement.grossCents - (winner?.commission_cents ?? settlement.commissionCents),
        discrepancyCents: 0,
        code: null,
        message: null,
      };
    }
    throw err;
  }

  return {
    externalRef: payload.externalRef,
    status: 'CREATED',
    orderId: order.id,
    orderNumber: order.order_number,
    grossCents: settlement.grossCents,
    commissionCents: settlement.commissionCents,
    netCents: settlement.netCents,
    discrepancyCents,
    code: null,
    message: null,
  };
}

// ===========================================================================
// Pull + sync
// ===========================================================================

/** Bounded so one pull cannot run for minutes against a backlogged partner. */
const DEFAULT_PULL_LIMIT = 50;

export interface PullReport {
  channelId: string;
  channelName: string;
  pulled: number;
  created: number;
  duplicates: number;
  cancelled: number;
  rejected: number;
  results: ImportResult[];
}

/**
 * Pull the partner's outstanding bookings and absorb them.
 *
 * Every reference we reached a DECISION about is acknowledged, including
 * rejections: an oversold slot will not free itself, so leaving it unacknowledged
 * would make the partner redeliver it forever. A crash mid-loop throws before the
 * acknowledge, and the partner redelivers — which is exactly why the import is
 * idempotent.
 */
export async function pullAndImport(
  operatorId: string,
  channelId: string,
  opts: { limit?: number; since?: Date | null } = {},
): Promise<PullReport> {
  const db = forOperator(operatorId);
  const channel = await loadChannel(db, channelId);
  if (!channel.enabled) {
    throw new ChannelError('CHANNEL_DISABLED', `${channel.name} is disabled`, 409);
  }
  const ctx = await contextFor(db, operatorId, channel);
  const driver = driverFor(ctx.kind, ctx);

  const state = await ctx.state.load();
  const cursor = typeof state.cursor === 'string' ? state.cursor : null;
  const pull = await callPartner(channel.name, () =>
    driver.pullBookings({
      since: opts.since ?? null,
      cursor,
      limit: Math.min(200, Math.max(1, opts.limit ?? DEFAULT_PULL_LIMIT)),
    }),
  );

  const results: ImportResult[] = [];
  for (const payload of pull.bookings) {
    results.push(await importChannelBooking(operatorId, channel, payload));
  }

  if (results.length > 0) {
    await callPartner(channel.name, () => driver.acknowledge(results.map((r) => r.externalRef)));
  }
  if (pull.cursor !== cursor) {
    const latest = await ctx.state.load();
    await ctx.state.save({ ...latest, cursor: pull.cursor });
  }

  return {
    channelId: channel.id,
    channelName: channel.name,
    pulled: pull.bookings.length,
    created: results.filter((r) => r.status === 'CREATED').length,
    duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
    cancelled: results.filter((r) => r.status === 'CANCELLED').length,
    rejected: results.filter((r) => r.status === 'REJECTED').length,
    results,
  };
}

/** Push then pull — the operation a cron (or the Local Console button) runs. */
export async function syncChannel(operatorId: string, channelId: string) {
  const push = await pushInventory(operatorId, channelId);
  const pull = await pullAndImport(operatorId, channelId);
  return { push, pull };
}

/**
 * Operator-initiated cancellation: cancel OUR order and tell the partner.
 *
 * Our order is cancelled first. If the partner call then fails the guest is at
 * least not double-sold a boat we cannot supply, and the retry is safe because
 * `cancelBooking` refuses to run twice.
 */
export async function cancelAtChannel(
  operatorId: string,
  channelId: string,
  externalRef: string,
  reason: string,
) {
  const db = forOperator(operatorId);
  const channel = await loadChannel(db, channelId);
  const booking = await db.channelBooking.findFirst({
    where: { channel_id: channelId, external_ref: externalRef },
    select: { id: true, order_id: true },
  });
  if (!booking) {
    throw new ChannelError('BOOKING_NOT_FOUND', 'No channel booking with that reference', 404);
  }
  const order = await db.order.findFirst({
    where: { id: booking.order_id },
    select: { id: true, order_number: true, status: true },
  });
  if (order && order.status !== 'CANCELLED') {
    await cancelBooking(operatorId, order.id, {
      actor: channelActor(channel.name),
      reason,
    });
  }

  const ctx = await contextFor(db, operatorId, channel);
  const driver = driverFor(ctx.kind, ctx);
  const result = await callPartner(channel.name, () => driver.cancel({ externalRef, reason }));

  if (order) {
    await db.orderEvent.create({
      data: {
        operator_id: operatorId,
        order_id: order.id,
        type: 'CHANNEL_CANCELLED',
        description: result.accepted
          ? `Cancelled at ${channel.name} (ref ${externalRef})${result.penaltyCents > 0 ? `; ${(result.penaltyCents / 100).toFixed(2)} USD penalty` : ''}`
          : `${channel.name} refused the cancellation of ${externalRef}: ${result.reason ?? 'no reason given'}`,
        actor: channelActor(channel.name),
        metadata: toJson({ ...result, reason }),
      },
    });
  }

  return { order, cancellation: result };
}

// ===========================================================================
// Reporting
// ===========================================================================

export interface CommissionReportRange {
  from?: Date | null;
  to?: Date | null;
}

/**
 * What each channel sold and what it cost, over a window.
 *
 * Reads the SNAPSHOTTED `commission_cents` rather than recomputing from the
 * channel's current percent — that snapshot is the whole reason the column
 * exists, and recomputing would quietly restate history after a renegotiation.
 */
export async function channelCommissionReport(
  operatorId: string,
  range: CommissionReportRange = {},
) {
  const db = forOperator(operatorId);
  const rows = await db.channelBooking.findMany({
    where: {
      created_at: {
        ...(range.from ? { gte: range.from } : {}),
        ...(range.to ? { lte: range.to } : {}),
      },
    },
    select: {
      commission_cents: true,
      external_ref: true,
      created_at: true,
      channel: { select: { id: true, name: true, kind: true } },
      order: { select: { id: true, order_number: true, status: true, total_cents: true } },
    },
    orderBy: { created_at: 'desc' },
  });

  const summary = summarizeChannelBookings(
    rows.map((r) => ({
      channelId: r.channel.id,
      channelName: r.channel.name,
      kind: r.channel.kind as ChannelKind,
      // Gross is the order total: it is the figure both sides can see, and the
      // partner's stated commission was already reconciled against it at import.
      grossCents: r.order.total_cents,
      commissionCents: r.commission_cents,
      cancelled: r.order.status === 'CANCELLED',
    })),
  );

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    ...summary,
    bookings: rows.map((r) => ({
      externalRef: r.external_ref,
      createdAt: r.created_at,
      channelId: r.channel.id,
      channelName: r.channel.name,
      orderId: r.order.id,
      orderNumber: r.order.order_number,
      status: r.order.status,
      grossCents: r.order.total_cents,
      commissionCents: r.commission_cents,
      netCents: r.order.total_cents - r.commission_cents,
    })),
  };
}
