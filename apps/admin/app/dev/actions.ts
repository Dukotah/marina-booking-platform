'use server';

/**
 * Local Console server actions (docs/LOCAL-FIRST-BUILD.md §4.2).
 *
 * These are the controls that make the product testable with no external account:
 * script the next payment outcome, replay a webhook, jump the sandbox clock, and
 * wipe back to a known seed. Per D-007 the admin app talks to the database
 * DIRECTLY through the tenant-scoped client, so each action resolves the operator
 * context and writes through `withTenant` (RLS GUC set) exactly like the rest of
 * the app.
 *
 * TWO GATES, BOTH ENFORCED HERE. A server action is its own HTTP endpoint — the
 * page 404ing in cloud mode does NOT protect these. Every action therefore calls
 * `assertSandbox()` itself, and then requires `operator:manage` (the "danger zone"
 * permission), so a STAFF login cannot wipe the database from a crafted request.
 */

import { revalidatePath } from 'next/cache';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withTenant, type Prisma } from '@marina/database';
import { createId } from '@marina/core';
import { AuthorizationError } from '@marina/auth';
import { requirePermission, type OperatorContext } from '../../lib/session';

/** Uniform result returned to the client panels driving banners + refreshes. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

const ok = (message: string): ActionResult => ({ ok: true, message });
const fail = (message: string): ActionResult => ({ ok: false, message });

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Whether the sandbox surface exists at all. Mirrored from the API service rather
 * than imported because the admin app deliberately has no dependency on the API
 * package (D-007).
 *
 * Exported (and async) so `app/dev/page.tsx` can share this one definition — under
 * `'use server'` every export must be an async function, hence the Promise.
 */
export async function isSandboxEnabled(): Promise<boolean> {
  const flag = process.env.SANDBOX?.trim().toLowerCase();
  if (flag === 'local') return true;
  if (flag === 'cloud') return false;
  return process.env.NODE_ENV !== 'production';
}

/** Thrown by `assertSandbox` — mapped to a plain failure, never leaked as a 500. */
class SandboxDisabledError extends Error {
  constructor() {
    super('The Local Console is not available in this environment.');
    this.name = 'SandboxDisabledError';
  }
}

async function assertSandbox(): Promise<void> {
  if (!(await isSandboxEnabled())) throw new SandboxDisabledError();
}

/**
 * Resolve the operator context behind both gates. Returns the context, or a typed
 * denied result the caller returns as-is — keeps every action's preamble one line.
 */
async function authorize(): Promise<{ ctx: OperatorContext } | { denied: ActionResult }> {
  try {
    await assertSandbox();
    return { ctx: await requirePermission('operator:manage') };
  } catch (err) {
    if (err instanceof SandboxDisabledError) return { denied: fail(err.message) };
    if (err instanceof AuthorizationError) {
      return { denied: fail('Only an owner can use the Local Console controls.') };
    }
    throw err;
  }
}

/** Internal control-flow error mapped to a user-facing message inside actions. */
class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

// ---------------------------------------------------------------------------
// Payments — script the next outcome
// ---------------------------------------------------------------------------

/**
 * The outcomes the simulator can produce, kept as a server-side literal list so a
 * crafted request can't smuggle an unknown enum value into the column. The client
 * has its own copy for labels/ordering; this one is the authority.
 */
const OUTCOMES = ['SUCCEEDED', 'REQUIRES_ACTION', 'DECLINED', 'TIMEOUT', 'DISPUTED'] as const;
type Outcome = (typeof OUTCOMES)[number];

/** Stripe-shaped decline codes. Anything else is rejected rather than stored. */
const DECLINE_CODES = [
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'incorrect_cvc',
  'lost_card',
  'stolen_card',
  'processing_error',
] as const;

/** Stripe's dispute reasons. Recorded in metadata — a dispute is not a decline. */
const DISPUTE_REASONS = [
  'fraudulent',
  'product_not_received',
  'duplicate',
  'subscription_canceled',
  'general',
] as const;

function isOutcome(value: unknown): value is Outcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

/** Trim + bound a free-text note so a huge value can't bloat the metadata blob. */
function cleanNote(note: unknown): string | undefined {
  if (typeof note !== 'string') return undefined;
  const trimmed = note.trim().slice(0, 300);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Queue the outcome the NEXT charge should produce.
 *
 * This writes a QUEUED SandboxPaymentAttempt with no intent_id and no amount: it
 * is an instruction, not a charge. The payments provider pops the oldest QUEUED
 * row when a charge arrives, fills in the intent/amount/order, and advances
 * `status` from there. That indirection is what lets the owner set up "the next
 * card declines" *before* he walks the booking funnel — which is the only way to
 * test a decline without a real card that declines.
 */
export async function queuePaymentOutcomeAction(input: {
  outcome: string;
  /** Required for DECLINED; ignored otherwise. */
  failureCode?: string;
  /** Required for DISPUTED; ignored otherwise. */
  disputeReason?: string;
  note?: string;
}): Promise<ActionResult> {
  const auth = await authorize();
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  if (!isOutcome(input.outcome)) return fail('Unknown payment outcome.');
  const outcome = input.outcome;

  let failureCode: string | null = null;
  if (outcome === 'DECLINED') {
    const code = input.failureCode ?? 'card_declined';
    if (!(DECLINE_CODES as readonly string[]).includes(code)) {
      return fail('Unknown decline code.');
    }
    failureCode = code;
  }

  let disputeReason: string | null = null;
  if (outcome === 'DISPUTED') {
    const reason = input.disputeReason ?? 'fraudulent';
    if (!(DISPUTE_REASONS as readonly string[]).includes(reason)) {
      return fail('Unknown dispute reason.');
    }
    disputeReason = reason;
  }

  const note = cleanNote(input.note);

  try {
    await withTenant(ctx.operatorId, (tx) =>
      tx.sandboxPaymentAttempt.create({
        data: {
          id: createId(),
          // Top-level create: operator_id is explicit (D-011).
          operator_id: ctx.operatorId,
          outcome,
          status: 'QUEUED',
          failure_code: failureCode,
          metadata: {
            queuedBy: ctx.auth.userId,
            queuedAt: new Date().toISOString(),
            ...(disputeReason ? { disputeReason } : {}),
            ...(note ? { note } : {}),
          } as Prisma.InputJsonValue,
        },
      }),
    );
  } catch (err) {
    console.error('[dev] queuePaymentOutcomeAction failed:', err);
    return fail('Could not queue that outcome. Please try again.');
  }

  revalidatePath('/dev');
  return ok(`Next charge will ${describeOutcome(outcome, failureCode)}.`);
}

function describeOutcome(outcome: Outcome, failureCode: string | null): string {
  switch (outcome) {
    case 'SUCCEEDED':
      return 'be approved';
    case 'REQUIRES_ACTION':
      return 'raise a 3DS challenge';
    case 'DECLINED':
      return `be declined (${failureCode ?? 'card_declined'})`;
    case 'TIMEOUT':
      return 'time out with an indeterminate result';
    case 'DISPUTED':
      return 'succeed, then be disputed';
  }
}

/**
 * Drop one queued instruction. Only a QUEUED row can be cancelled — an attempt a
 * charge already consumed is history, and history is not editable here.
 */
export async function cancelQueuedOutcomeAction(input: {
  attemptId: string;
}): Promise<ActionResult> {
  const auth = await authorize();
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  if (typeof input.attemptId !== 'string' || input.attemptId.length === 0) {
    return fail('Missing attempt id.');
  }

  try {
    const { count } = await withTenant(ctx.operatorId, (tx) =>
      tx.sandboxPaymentAttempt.updateMany({
        where: { id: input.attemptId, status: 'QUEUED' },
        data: { status: 'CANCELLED' },
      }),
    );
    if (count === 0) return fail('That instruction is no longer queued.');
  } catch (err) {
    console.error('[dev] cancelQueuedOutcomeAction failed:', err);
    return fail('Could not cancel that instruction. Please try again.');
  }

  revalidatePath('/dev');
  return ok('Queued outcome cleared.');
}

/** Clear the whole queue — back to "charges behave normally". */
export async function clearQueuedOutcomesAction(): Promise<ActionResult> {
  const auth = await authorize();
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  let count = 0;
  try {
    const result = await withTenant(ctx.operatorId, (tx) =>
      tx.sandboxPaymentAttempt.updateMany({
        where: { status: 'QUEUED' },
        data: { status: 'CANCELLED' },
      }),
    );
    count = result.count;
  } catch (err) {
    console.error('[dev] clearQueuedOutcomesAction failed:', err);
    return fail('Could not clear the queue. Please try again.');
  }

  revalidatePath('/dev');
  return count === 0
    ? ok('Nothing was queued — charges already behave normally.')
    : ok(`Cleared ${count} queued outcome${count === 1 ? '' : 's'}.`);
}

// ---------------------------------------------------------------------------
// Webhooks — replay
// ---------------------------------------------------------------------------

/**
 * Re-deliver a stored webhook to the real handler.
 *
 * A replay is a NEW row pointing at the original through `replay_of_id`; the
 * original is never mutated, so the console keeps the full delivery history and
 * "this one failed, then the replay succeeded" stays visible.
 *
 * Delivery is a genuine HTTP POST to the API's `/webhooks/stripe` route — the same
 * production handler Stripe would hit. Locally STRIPE_WEBHOOK_SECRET is unset, so
 * the handler accepts unsigned events; that is the documented dev posture, not a
 * bypass we invented. If the API is down the replay is recorded FAILED with the
 * reason, because a webhook that cannot be delivered is a real state worth seeing.
 */
export async function replayWebhookAction(input: { webhookId: string }): Promise<ActionResult> {
  const auth = await authorize();
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  if (typeof input.webhookId !== 'string' || input.webhookId.length === 0) {
    return fail('Missing webhook id.');
  }

  let replayId = '';
  let eventType = '';
  let payload: Prisma.InputJsonValue = {};

  try {
    const created = await withTenant(ctx.operatorId, async (tx) => {
      const original = await tx.sandboxWebhook.findFirst({
        where: { id: input.webhookId },
      });
      if (!original) throw new ActionError('Webhook not found.');

      return tx.sandboxWebhook.create({
        data: {
          id: createId(),
          operator_id: ctx.operatorId,
          event_type: original.event_type,
          // `?? {}` because a required Json column can hold a JSON null, which
          // Prisma will not accept back as a plain `null` on write.
          payload: (original.payload ?? {}) as Prisma.InputJsonValue,
          status: 'PENDING',
          attempt_id: original.attempt_id,
          // Point at the ORIGINAL even when replaying a replay, so the console
          // shows one flat delivery history instead of a chain to walk.
          replay_of_id: original.replay_of_id ?? original.id,
        },
      });
    });
    replayId = created.id;
    eventType = created.event_type;
    payload = (created.payload ?? {}) as Prisma.InputJsonValue;
  } catch (err) {
    if (err instanceof ActionError) return fail(err.message);
    console.error('[dev] replayWebhookAction failed to record the replay:', err);
    return fail('Could not record the replay. Please try again.');
  }

  const delivery = await deliverWebhook(eventType, payload);

  try {
    await withTenant(ctx.operatorId, (tx) =>
      tx.sandboxWebhook.update({
        where: { id: replayId },
        data: delivery.delivered
          ? { status: 'DELIVERED', delivered_at: new Date(), error: null }
          : { status: 'FAILED', error: delivery.error ?? 'Delivery failed' },
      }),
    );
  } catch (err) {
    // The replay row exists; only its delivery status failed to persist. Say so
    // rather than claiming a clean replay.
    console.error('[dev] replayWebhookAction failed to record delivery:', err);
    return fail('Replay was sent but its result could not be recorded.');
  }

  revalidatePath('/dev');
  return delivery.delivered
    ? ok(`Replayed ${eventType}.`)
    : fail(`Replay of ${eventType} failed: ${delivery.error ?? 'no response'}.`);
}

interface DeliveryResult {
  delivered: boolean;
  error?: string;
}

/**
 * POST the stored event to the API's Stripe webhook route. Never throws — an
 * unreachable API is a delivery failure, which is exactly what we want to record.
 */
async function deliverWebhook(
  eventType: string,
  payload: Prisma.InputJsonValue,
): Promise<DeliveryResult> {
  const base = (process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(
    /\/+$/,
    '',
  );
  if (!base) return { delivered: false, error: 'API_BASE_URL is not set' };

  // The route is mounted OUTSIDE /api (Stripe carries no tenant context), so this
  // is /webhooks/stripe, not /api/webhooks/stripe.
  const url = `${base}/webhooks/stripe`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (res.ok) return { delivered: true };
    const body = (await res.text().catch(() => '')).slice(0, 300);
    return { delivered: false, error: `${res.status} ${res.statusText}${body ? ` — ${body}` : ''}` };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { delivered: false, error: `timed out after 10s (${eventType})` };
    }
    return {
      delivered: false,
      error: err instanceof Error ? err.message : 'could not reach the API',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** Ten years either way. Past that, date arithmetic stops being a useful test. */
const MAX_OFFSET_SECONDS = 10 * 365 * 24 * 60 * 60;

/**
 * Move the sandbox clock by `seconds` (negative moves it back). The offset is
 * cumulative, so "+24h" three times is +72h — which is how you walk a booking
 * through reminder, arrival and no-show sweep in three clicks.
 */
export async function advanceClockAction(input: { seconds: number }): Promise<ActionResult> {
  const auth = await authorize();
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  const delta = Math.trunc(Number(input.seconds));
  if (!Number.isFinite(delta) || delta === 0) return fail('Enter how far to move the clock.');

  let offset = 0;
  try {
    offset = await withTenant(ctx.operatorId, async (tx) => {
      const existing = await tx.sandboxClock.findFirst({
        where: { operator_id: ctx.operatorId },
        select: { id: true, offset_seconds: true },
      });
      const next = clampOffset((existing?.offset_seconds ?? 0) + delta);

      if (existing) {
        await tx.sandboxClock.update({
          where: { id: existing.id },
          data: { offset_seconds: next },
        });
      } else {
        await tx.sandboxClock.create({
          data: { id: createId(), operator_id: ctx.operatorId, offset_seconds: next },
        });
      }
      return next;
    });
  } catch (err) {
    console.error('[dev] advanceClockAction failed:', err);
    return fail('Could not move the clock. Please try again.');
  }

  revalidatePath('/dev');
  return ok(
    offset === 0
      ? 'Clock is back on real time.'
      : `Clock is now ${describeOffset(offset)} real time.`,
  );
}

/** Put the sandbox clock back on real time. */
export async function resetClockAction(): Promise<ActionResult> {
  const auth = await authorize();
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  try {
    await withTenant(ctx.operatorId, (tx) =>
      tx.sandboxClock.updateMany({
        where: { operator_id: ctx.operatorId },
        data: { offset_seconds: 0 },
      }),
    );
  } catch (err) {
    console.error('[dev] resetClockAction failed:', err);
    return fail('Could not reset the clock. Please try again.');
  }

  revalidatePath('/dev');
  return ok('Clock is back on real time.');
}

function clampOffset(seconds: number): number {
  return Math.max(-MAX_OFFSET_SECONDS, Math.min(MAX_OFFSET_SECONDS, seconds));
}

function describeOffset(seconds: number): string {
  const abs = Math.abs(seconds);
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const parts = [
    days ? `${days}d` : '',
    hours ? `${hours}h` : '',
    !days && minutes ? `${minutes}m` : '',
  ].filter(Boolean);
  const magnitude = parts.length > 0 ? parts.join(' ') : `${abs}s`;
  return `${magnitude} ${seconds > 0 ? 'ahead of' : 'behind'}`;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

/**
 * The season seed hard-codes the Lake Sonoma operator, so "restore the seeded
 * season" is only truthful for that tenant. For any other operator the option is
 * withheld rather than silently seeding the wrong marina.
 */
const SEASON_SEED_OPERATOR = 'lsra';

/**
 * The one promo code `seed-season.ts` creates unconditionally. PromoCode is unique
 * per (operator, code), so a leftover row makes the SECOND reseed die on a
 * constraint violation — which would turn this button into a one-shot. Cleared
 * ahead of the seed by exact code, never by wiping every promo, because the base
 * seed's expired audit promo is not something the season seed puts back.
 */
const SEASON_SEED_PROMO_CODE = 'SONOMA10';

/**
 * Each scope's confirmation phrase. The client shows it; the server re-checks it,
 * because a confirmation only a browser enforces is not a confirmation.
 */
const RESET_PHRASES = {
  sandbox: 'CLEAR SANDBOX',
  bookings: 'DELETE BOOKINGS',
  season: 'RESET TO SEED',
} as const;

type ResetScope = keyof typeof RESET_PHRASES;

function isResetScope(value: unknown): value is ResetScope {
  return typeof value === 'string' && value in RESET_PHRASES;
}

/**
 * Wipe back to a known state. Three widening scopes, because "reset" means very
 * different things depending on what you are testing:
 *
 *   sandbox  — the console's own record: messages, payment attempts, webhooks,
 *              errors, and the clock offset. No customer ever saw any of it.
 *   bookings — the above, plus every order and guest, with timeslot counters
 *              rolled back to zero. The catalog survives, so the marina is empty
 *              but still bookable.
 *   season   — the above, then re-runs the season seed so the dashboards have a
 *              believable business behind them again.
 *
 * Everything except the seed subprocess happens in ONE transaction, so a failure
 * halfway through leaves the database as it was rather than half-wiped.
 */
export async function resetSandboxAction(input: {
  scope: string;
  confirmation: string;
}): Promise<ActionResult> {
  const auth = await authorize();
  if ('denied' in auth) return auth.denied;
  const { ctx } = auth;

  if (!isResetScope(input.scope)) return fail('Unknown reset scope.');
  const scope = input.scope;

  const expected = RESET_PHRASES[scope];
  if (typeof input.confirmation !== 'string' || input.confirmation.trim() !== expected) {
    return fail(`Type ${expected} exactly to confirm.`);
  }

  if (scope === 'season' && ctx.operatorId !== SEASON_SEED_OPERATOR) {
    return fail(
      `The season seed only knows how to build "${SEASON_SEED_OPERATOR}". Use "Delete bookings and guests" for this operator.`,
    );
  }

  let cleared: ClearedCounts;
  try {
    cleared = await withTenant(ctx.operatorId, (tx) => clearTenant(tx, ctx.operatorId, scope));
  } catch (err) {
    console.error('[dev] resetSandboxAction clear failed:', err);
    // The transaction rolled back, so nothing was deleted. Prisma errors carry a
    // multi-line query dump — the first line is the part worth reading on screen,
    // and the full object is already in the server log above.
    const detail =
      err instanceof Error ? err.message.split('\n')[0]?.slice(0, 200) : undefined;
    return fail(
      detail
        ? `Reset failed, nothing was deleted: ${detail}`
        : 'Reset failed. Nothing was deleted.',
    );
  }

  const summary = summarizeCleared(cleared, scope);

  if (scope !== 'season') {
    revalidatePath('/dev');
    return ok(summary);
  }

  const seed = await runSeasonSeed();
  revalidatePath('/dev');
  return seed.ok
    ? ok(`${summary} Seeded season restored.`)
    : fail(
        `${summary} The season seed did not run: ${seed.error}. The catalog is intact — ` +
          'the marina is simply empty until the seed succeeds.',
      );
}

interface ClearedCounts {
  webhooks: number;
  attempts: number;
  errors: number;
  messages: number;
  orders: number;
  customers: number;
  timeslots: number;
}

/**
 * Delete order matters: SandboxWebhook hangs off SandboxPaymentAttempt, and Order
 * holds a required reference to Customer, so guests can only go after their
 * orders. Cascades handle order items, payments and order events.
 */
async function clearTenant(
  tx: Prisma.TransactionClient,
  operatorId: string,
  scope: ResetScope,
): Promise<ClearedCounts> {
  const where = { operator_id: operatorId };

  const webhooks = await tx.sandboxWebhook.deleteMany({ where });
  const attempts = await tx.sandboxPaymentAttempt.deleteMany({ where });
  const errors = await tx.sandboxError.deleteMany({ where });
  const messages = await tx.sandboxMessage.deleteMany({ where });
  await tx.sandboxClock.updateMany({ where, data: { offset_seconds: 0 } });

  const counts: ClearedCounts = {
    webhooks: webhooks.count,
    attempts: attempts.count,
    errors: errors.count,
    messages: messages.count,
    orders: 0,
    customers: 0,
    timeslots: 0,
  };

  // The season seed clears orders and guests itself, but doing it here too keeps
  // the transaction the single source of truth for what was destroyed, and leaves
  // a coherent database even if the seed subprocess never runs.
  if (scope === 'sandbox') return counts;

  const orders = await tx.order.deleteMany({ where });
  const customers = await tx.customer.deleteMany({ where });

  if (scope === 'season') {
    await tx.promoCode.deleteMany({ where: { ...where, code: SEASON_SEED_PROMO_CODE } });
  }

  // Roll capacity back. Two statements because `computeSlotStatus(total, 0)` is
  // AVAILABLE only when the slot has capacity at all — a zero-capacity slot keeps
  // whatever status it had, and a CANCELLED slot is never resurrected.
  const cleared = await tx.timeslot.updateMany({
    where: { ...where, status: { not: 'CANCELLED' } },
    data: { capacity_booked: 0 },
  });
  await tx.timeslot.updateMany({
    where: { ...where, status: { not: 'CANCELLED' }, capacity_total: { gt: 0 } },
    data: { status: 'AVAILABLE' },
  });

  counts.orders = orders.count;
  counts.customers = customers.count;
  counts.timeslots = cleared.count;
  return counts;
}

function summarizeCleared(c: ClearedCounts, scope: ResetScope): string {
  const parts = [
    `${c.messages} message${c.messages === 1 ? '' : 's'}`,
    `${c.attempts} payment attempt${c.attempts === 1 ? '' : 's'}`,
    `${c.webhooks} webhook${c.webhooks === 1 ? '' : 's'}`,
    `${c.errors} error${c.errors === 1 ? '' : 's'}`,
  ];
  if (scope !== 'sandbox') {
    parts.push(`${c.orders} order${c.orders === 1 ? '' : 's'}`);
    parts.push(`${c.customers} guest${c.customers === 1 ? '' : 's'}`);
  }
  return `Deleted ${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Re-running the season seed without a terminal
// ---------------------------------------------------------------------------

interface SeedResult {
  ok: boolean;
  error?: string;
}

/**
 * Run `prisma/seed-season.ts` as a child process.
 *
 * We spawn `process.execPath` (the Node binary already running this app) rather
 * than pnpm: pnpm is not on PATH on the owner's machine, and the seed script is
 * plain TypeScript run through Node's type stripping — the exact command the
 * `db:seed:season` package script uses. Inheriting the environment hands the child
 * DATABASE_URL, which is what it connects with.
 *
 * This is the piece that keeps §4.2's promise: reseeding is a button, not a shell.
 */
async function runSeasonSeed(): Promise<SeedResult> {
  const script = findSeedScript();
  if (!script) {
    return { ok: false, error: 'could not locate packages/database/prisma/seed-season.ts' };
  }
  if (!process.env.DATABASE_URL) {
    return { ok: false, error: 'DATABASE_URL is not set for the admin process' };
  }

  return new Promise<SeedResult>((resolveResult) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', script.path], {
      cwd: script.packageDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let settled = false;
    const finish = (result: SeedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };

    // A seed that hangs (cluster down, lock contention) must not hang the action.
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: 'the seed took longer than 3 minutes and was stopped' });
    }, 180_000);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Drain stdout so a chatty seed cannot fill the pipe buffer and deadlock.
    child.stdout.resume();

    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('close', (code) => {
      if (code === 0) return finish({ ok: true });
      const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      finish({ ok: false, error: detail || `exited with code ${code}` });
    });
  });
}

/**
 * Walk up from the running process's directory to find the database package. The
 * admin app's cwd is `apps/admin` under `next dev` and `next start`; six levels is
 * ample headroom for either, and for a build run from the repo root.
 */
function findSeedScript(): { path: string; packageDir: string } | null {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    const packageDir = join(dir, 'packages', 'database');
    const path = join(packageDir, 'prisma', 'seed-season.ts');
    if (existsSync(path)) return { path, packageDir };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
