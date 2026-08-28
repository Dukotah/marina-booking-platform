/**
 * Sandbox control API — the HTTP surface of the local payment simulator, the
 * webhook log and the injectable clock (docs/LOCAL-FIRST-BUILD.md §4.2).
 *
 *   GET    /api/sandbox/payments/queue        what the next charge will do
 *   POST   /api/sandbox/payments/queue        script the next outcome
 *   DELETE /api/sandbox/payments/queue        stand down — approve normally again
 *   GET    /api/sandbox/payments/attempts     attempt history, newest first
 *   GET    /api/sandbox/webhooks              what fired
 *   POST   /api/sandbox/webhooks/:id/replay   redeliver one event
 *   GET    /api/sandbox/clock                 the operator's clock offset
 *   PUT    /api/sandbox/clock                 set/advance it
 *
 * The Local Console in `apps/admin` drives the same operations through server
 * actions because it renders on the server. This router exists for everything that
 * ISN'T the console: an E2E spec arming an outcome without a browser, the owner
 * poking the simulator with curl, and (later) a scripted demo. Both surfaces call
 * the same functions in `services/payments-sandbox.ts`, so there is one state
 * machine and no second implementation to drift.
 *
 * GATING: the whole router 404s unless `sandboxEnabled()`. Not 403 — a control
 * plane for a simulator must not even admit to existing when the real Stripe
 * driver is answering, so probing it in cloud mode looks exactly like probing a
 * route that was never mounted.
 *
 * TENANCY: mounted under `/api`, so `tenantMiddleware` has already run and every
 * read/write goes through `c.var.db` (RLS). One operator can neither see nor pop
 * another's queued outcome.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../context.js';
import { sandboxEnabled } from '../services/sandbox.js';
import {
  DECLINE_CODES,
  SANDBOX_OUTCOMES,
  clearQueue,
  getClockOffset,
  listAttempts,
  listQueued,
  listWebhooks,
  queueOutcome,
  replayWebhook,
  sandboxNow,
  setClockOffset,
  type AttemptStatus,
  type SandboxAttempt,
  type SandboxOutcome,
  type SandboxWebhookRow,
} from '../services/payments-sandbox.js';

export const sandbox = new Hono<Env>();

/**
 * The gate. Applied as middleware rather than repeated per handler so a route
 * added later cannot forget it and leak the simulator into a cloud deployment.
 */
sandbox.use('*', async (c, next) => {
  if (!sandboxEnabled()) return c.json({ error: 'Not found' }, 404);
  await next();
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * The outcome names, validated against the simulator's own list rather than a
 * second copy of it — adding an outcome to the state machine must not require
 * remembering to widen a schema over here.
 */
const outcomeSchema = z.custom<SandboxOutcome>(
  (value) => typeof value === 'string' && (SANDBOX_OUTCOMES as readonly string[]).includes(value),
  { message: `outcome must be one of: ${SANDBOX_OUTCOMES.join(', ')}` },
);

/** Same trick for the terminal states the attempts list can filter on. */
const ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'QUEUED',
  'REQUIRES_ACTION',
  'SUCCEEDED',
  'FAILED',
  'DISPUTED',
  'CANCELLED',
];

const queueSchema = z.object({
  outcome: outcomeSchema,
  /** Only meaningful for DECLINED; ignored otherwise (the simulator picks one). */
  failureCode: z.enum(DECLINE_CODES).optional(),
  /** Capture less than the authorization — integer cents, as everywhere else. */
  captureAmountCents: z.number().int().positive().optional(),
  note: z.string().max(200).optional(),
});

/**
 * Either set the offset outright or nudge it. `advanceSeconds` is what the
 * console's "jump forward 24h" button means, and expressing it as a delta rather
 * than a computed absolute keeps two concurrent jumps from clobbering each other.
 */
const clockSchema = z
  .object({
    offsetSeconds: z.number().int().optional(),
    advanceSeconds: z.number().int().optional(),
  })
  .refine((v) => v.offsetSeconds !== undefined || v.advanceSeconds !== undefined, {
    message: 'Provide offsetSeconds or advanceSeconds',
  });

/** Query parsing for the two list endpoints — bounded, with a sane default. */
function limitFrom(raw: string | undefined, fallback = 50): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : fallback;
}

// ---------------------------------------------------------------------------
// Serializers — camelCase JSON, matching the rest of the API's contracts
// ---------------------------------------------------------------------------

function serializeAttempt(attempt: SandboxAttempt) {
  const meta = attempt.metadata ?? {};
  return {
    id: attempt.id,
    intentId: attempt.intent_id,
    amountCents: attempt.amount_cents,
    /** What the console ASKED for. */
    outcome: attempt.outcome,
    /** What it actually ENDED as. The two diverge on a completed 3DS challenge. */
    status: attempt.status,
    orderId: attempt.order_id,
    failureCode: attempt.failure_code,
    idempotencyKey: attempt.idempotency_key,
    capturedCents: meta.capturedCents ?? null,
    refundedCents: meta.refundedCents ?? null,
    cardBrand: meta.cardBrand ?? null,
    cardLastFour: meta.cardLastFour ?? null,
    note: meta.note ?? null,
    /** Present while a 3DS challenge is outstanding or after it resolved. */
    challenge: meta.challenge
      ? {
          returnUrl: meta.challenge.returnUrl,
          resolvedAt: meta.challenge.resolvedAt ?? null,
          succeeded: meta.challenge.succeeded ?? null,
        }
      : null,
    dispute: meta.dispute ?? null,
    consumedAt: attempt.consumed_at?.toISOString() ?? null,
    createdAt: attempt.created_at.toISOString(),
  };
}

function serializeWebhook(row: SandboxWebhookRow) {
  return {
    id: row.id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    error: row.error,
    attemptId: row.attempt_id,
    /** Set on a redelivery; points at the ORIGINAL event, never at another replay. */
    replayOfId: row.replay_of_id,
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Payments — the outcome queue
// ---------------------------------------------------------------------------

/**
 * What the next charge will do. An empty queue is not an error state — it is the
 * normal one, and it means "approve", which is why the response says so explicitly
 * rather than making the caller infer it from an empty array.
 */
sandbox.get('/payments/queue', async (c) => {
  const queued = await listQueued(c.var.db);
  return c.json({
    nextOutcome: queued[0]?.outcome ?? 'SUCCEEDED',
    scripted: queued.length > 0,
    queue: queued.map(serializeAttempt),
  });
});

/**
 * Script the NEXT charge. Several may be stacked — queue DECLINED then SUCCEEDED
 * and the retry scenario is armed in one go — so this appends rather than replaces.
 */
sandbox.post('/payments/queue', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = queueSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  const attempt = await queueOutcome(c.var.db, c.var.operatorId, {
    outcome: parsed.data.outcome,
    failureCode: parsed.data.failureCode,
    captureAmountCents: parsed.data.captureAmountCents,
    note: parsed.data.note,
  });
  return c.json({ queued: serializeAttempt(attempt) }, 201);
});

/**
 * Stand down. Queued instructions are CANCELLED rather than deleted so the console
 * can still show that an outcome was armed and then withdrawn.
 */
sandbox.delete('/payments/queue', async (c) => {
  const cleared = await clearQueue(c.var.db);
  return c.json({ cleared });
});

/** Attempt history — the simulator's stand-in for the Stripe dashboard. */
sandbox.get('/payments/attempts', async (c) => {
  const statusParam = c.req.query('status')?.toUpperCase();
  const status = ATTEMPT_STATUSES.includes(statusParam as AttemptStatus)
    ? (statusParam as AttemptStatus)
    : undefined;

  const attempts = await listAttempts(c.var.db, {
    limit: limitFrom(c.req.query('limit')),
    status,
  });
  return c.json({ attempts: attempts.map(serializeAttempt) });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

sandbox.get('/webhooks', async (c) => {
  const rows = await listWebhooks(c.var.db, {
    limit: limitFrom(c.req.query('limit')),
    eventType: c.req.query('eventType') || undefined,
  });
  return c.json({ webhooks: rows.map(serializeWebhook) });
});

/**
 * Redeliver one event. The replay re-uses the original payload verbatim — same
 * Stripe event id and all — because the thing worth testing is whether our webhook
 * handler stays idempotent under a redelivery, which is what Stripe actually does.
 */
sandbox.post('/webhooks/:id/replay', async (c) => {
  const result = await replayWebhook(c.var.db, c.var.operatorId, c.req.param('id'));
  if (!result) return c.json({ error: 'Webhook not found' }, 404);
  return c.json({ replay: result }, 201);
});

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

sandbox.get('/clock', async (c) => {
  const offsetSeconds = await getClockOffset(c.var.db, c.var.operatorId);
  const now = await sandboxNow(c.var.db, c.var.operatorId);
  return c.json({
    offsetSeconds,
    now: now.toISOString(),
    realNow: new Date().toISOString(),
  });
});

/**
 * Move the sandbox clock. Negative offsets are legal on purpose: "what did the
 * manifest look like yesterday" is as testable as "fire tomorrow's reminders".
 */
sandbox.put('/clock', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = clockSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.flatten() }, 400);
  }

  const current = await getClockOffset(c.var.db, c.var.operatorId);
  const next =
    parsed.data.offsetSeconds !== undefined
      ? parsed.data.offsetSeconds
      : current + (parsed.data.advanceSeconds ?? 0);

  const offsetSeconds = await setClockOffset(c.var.db, c.var.operatorId, next);
  const now = await sandboxNow(c.var.db, c.var.operatorId);
  return c.json({ offsetSeconds, now: now.toISOString(), realNow: new Date().toISOString() });
});
