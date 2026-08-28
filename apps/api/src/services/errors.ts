/**
 * Error sink — the `errors` provider from docs/LOCAL-FIRST-BUILD.md §4.1.
 *
 * Two drivers behind one function, selected by the same `sandboxEnabled()` rule
 * every other provider uses:
 *
 *   local  -> a SandboxError row plus a console line. The Local Console (§4.2
 *             "Errors — what threw, with the stack") reads the table back.
 *   cloud  -> a Sentry event, posted as a Sentry envelope over plain `fetch`.
 *             No SDK, no new dependency, no account required to compile it.
 *
 * The failure policy is the audit log's, for the same reason: an error sink that
 * throws turns one bug into two, and the second one is in the handler that was
 * supposed to explain the first. `captureError` NEVER throws and never rejects.
 * When it cannot store an event it re-emits the whole thing to stderr under a
 * fixed `[errors] LOST EVENT` prefix, so the record survives even when the row
 * does not.
 *
 * WHAT WE REFUSE TO CAPTURE. An error message is free text written by whoever
 * threw it, so it is the most likely place for a secret to leak: a Prisma
 * connection error quotes the connection string (password and all), a fetch
 * failure quotes the Authorization header, a validation error quotes the input
 * it rejected — which at checkout can be a card number. Every string that
 * reaches storage goes through `scrubText` first, and structured context goes
 * through the audit log's own `sanitize` so the two agree on what a secret is.
 * We never accept a card object at all; a PAN that slips into a message comes
 * out as `****4242`.
 *
 * Times are UTC. Money never appears here.
 */
import { createHash } from 'node:crypto';
import type { Prisma } from '@marina/database';
import { forOperator } from '@marina/database';
import { looksLikeCardNumber, sanitize, toPlain } from './audit.js';
import { sandboxEnabled } from './sandbox.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** JSON-safe value. Declared locally so exported signatures stay portable. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Sentry's levels, which are also the only three we ever need. */
export type ErrorLevel = 'warning' | 'error' | 'fatal';

/**
 * Everything we know about the request that was in flight when it threw.
 *
 * `operatorId` is what decides whether the local driver can persist at all —
 * SandboxError is a tenant table under RLS, so an error with no tenant (a
 * startup failure, a cross-tenant sweep) can only reach the console. That is a
 * deliberate limit, not an oversight: writing tenant-less rows would mean an
 * unscoped client, and no error is worth a hole in the isolation model.
 */
export interface ErrorContext {
  operatorId?: string | null;
  /** Which process threw: "api", "web", "admin", or a job name. */
  source?: string;
  /** Route pattern, e.g. `/api/orders/:id`. Prefer the pattern over the URL. */
  route?: string | null;
  method?: string | null;
  /** StaffMember.auth_user_id, a Customer id, or "system". */
  actor?: string | null;
  actorRole?: string | null;
  /** Correlates this event with the request log line. */
  requestId?: string | null;
  ip?: string | null;
  level?: ErrorLevel;
  /** Anything else worth seeing beside the stack. Sanitized before storage. */
  extra?: Record<string, unknown>;
}

/** What happened to one capture. Returned so callers can log or assert on it. */
export interface CapturedError {
  /** SandboxError.id locally, the Sentry event id in cloud mode, null if neither stored it. */
  id: string | null;
  fingerprint: string;
  /** `console` means it was logged but not stored; `suppressed` means burst-limited. */
  driver: 'local' | 'cloud' | 'console' | 'suppressed';
}

/** The provider interface. Both drivers implement exactly this. */
export interface ErrorSink {
  readonly name: 'local' | 'cloud';
  capture(err: unknown, context?: ErrorContext): Promise<CapturedError>;
}

/** An error flattened into the shape both drivers store. */
export interface NormalizedError {
  name: string;
  message: string;
  stack: string | null;
  fingerprint: string;
  level: ErrorLevel;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_MESSAGE = 4_000;
const MAX_STACK = 20_000;
const MAX_CONTEXT_BYTES = 16_384;

/**
 * Same-fingerprint events per minute before we stop writing rows. One row per
 * throw is the schema's design (a test asserting "exactly one error fired" has
 * to keep working), so this ceiling sits far above any test and exists only to
 * stop a retry storm from writing a million rows into the tenant database.
 * `ERROR_BURST_LIMIT=0` disables it.
 */
const DEFAULT_BURST_LIMIT = 100;
const BURST_WINDOW_MS = 60_000;

function burstLimit(): number {
  const raw = Number.parseInt(process.env.ERROR_BURST_LIMIT ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BURST_LIMIT;
}

/**
 * Ceiling on how long one capture may hold its caller.
 *
 * `app.onError` awaits the capture before it answers, so that a reproduction and
 * a look at the Errors tab are the same round trip. That is only safe if the sink
 * cannot wedge: a Postgres that accepts the connection and then never replies
 * would otherwise hold the 500 open for as long as the client waits. On timeout
 * we hand the caller back a console-only result and leave the write running — if
 * it does land a moment later, the row is still there to find.
 *
 * `ERROR_CAPTURE_TIMEOUT_MS=0` waits indefinitely.
 */
const DEFAULT_CAPTURE_TIMEOUT_MS = 5_000;

function captureTimeoutMs(): number {
  const raw = Number.parseInt(process.env.ERROR_CAPTURE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CAPTURE_TIMEOUT_MS;
}

interface BurstEntry {
  windowStart: number;
  count: number;
  suppressed: number;
}

const burstState = new Map<string, BurstEntry>();

/**
 * True when this fingerprint has blown its budget for the current minute. The
 * first suppressed event logs once; the rest are silent until the window rolls,
 * and the roll reports how many were dropped so the gap is never invisible.
 */
function shouldSuppress(fingerprint: string): boolean {
  const limit = burstLimit();
  if (limit === 0) return false;

  const now = Date.now();
  const entry = burstState.get(fingerprint);

  if (!entry || now - entry.windowStart >= BURST_WINDOW_MS) {
    if (entry && entry.suppressed > 0) {
      // eslint-disable-next-line no-console
      console.error(`[errors] suppressed ${entry.suppressed} repeats of ${fingerprint}`);
    }
    burstState.set(fingerprint, { windowStart: now, count: 1, suppressed: 0 });
    pruneBurstState(now);
    return false;
  }

  entry.count++;
  if (entry.count <= limit) return false;

  entry.suppressed++;
  if (entry.suppressed === 1) {
    // eslint-disable-next-line no-console
    console.error(
      `[errors] burst limit hit for ${fingerprint} (${limit}/min) - further repeats this minute are not stored`,
    );
  }
  return true;
}

/** Keep the map from growing unbounded on a process that sees many distinct bugs. */
function pruneBurstState(now: number): void {
  if (burstState.size <= 500) return;
  for (const [key, entry] of burstState) {
    if (now - entry.windowStart >= BURST_WINDOW_MS) burstState.delete(key);
  }
}

/** Forget every burst window. For tests and for the console's Reset button. */
export function resetBurstState(): void {
  burstState.clear();
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

export const REDACTED = '[redacted]';

/**
 * Patterns applied to every string on its way to storage. These match secrets
 * EMBEDDED in prose, which is what separates them from the audit log's
 * whole-value checks — `sanitize` sees `{ apiKey: "sk_live_..." }`, this sees
 * `Error: request failed with Authorization: Bearer eyJ...`.
 */
const TEXT_SCRUBBERS: Array<[RegExp, string]> = [
  // Credentials inside a URL: postgresql://marina:hunter2@host -> ...:[redacted]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${REDACTED}@`],
  // Stripe secret / restricted / webhook-signing keys.
  [/\b(sk|rk|whsec)_[A-Za-z0-9_]{6,}/g, `$1_${REDACTED}`],
  // Bearer tokens and JWTs.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  // Whole PEM blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // `password=...`, `"apiSecret": "..."`, `token: ...` in a serialized payload.
  // Group 2 captures the opening quote so the replacement re-closes it and the
  // scrubbed line is still valid JSON to read.
  [
    /((?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|cvv|cvc)["']?\s*[:=]\s*)(["'])?[^\s"',;)}\]]+\2?/gi,
    `$1$2${REDACTED}$2`,
  ],
];

/** 13-19 digits with optional spaces/dashes — a PAN candidate, Luhn decides. */
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

/**
 * Redact secrets embedded anywhere in a string and clamp its length.
 *
 * Order matters: card masking runs last so a token that happens to be all
 * digits has already been replaced by then.
 */
export function scrubText(input: string, maxLength = MAX_MESSAGE): string {
  let out = input;
  for (const [pattern, replacement] of TEXT_SCRUBBERS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(CARD_CANDIDATE, (match) =>
    looksLikeCardNumber(match) ? `****${match.replace(/[ -]/g, '').slice(-4)}` : match,
  );
  return out.length > maxLength ? `${out.slice(0, maxLength)}...[truncated]` : out;
}

/** Apply `scrubText` to every string leaf of an already-sanitized value. */
function scrubDeep(value: JsonValue): JsonValue {
  if (typeof value === 'string') return scrubText(value, 1_000);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Normalization + fingerprinting
// ---------------------------------------------------------------------------

/** Stack frames from inside node itself or a dependency are never the culprit. */
function isOurFrame(line: string): boolean {
  return !line.includes('node_modules') && !line.includes('node:internal');
}

/**
 * The first frame that belongs to our code, reduced to `file:line`. Absolute
 * paths are stripped so the same bug fingerprints identically on the owner's
 * laptop and on a server.
 */
function topFrame(stack: string | null): string {
  if (!stack) return '';
  const lines = stack.split('\n').slice(1);
  const frame = lines.find(isOurFrame) ?? lines[0] ?? '';
  const match = frame.match(/([^\s()/\\]+\.[cm]?[jt]s):(\d+):\d+/);
  return match ? `${match[1]}:${match[2]}` : frame.trim().slice(0, 120);
}

/**
 * Collapse the parts of a message that vary between occurrences of the SAME
 * bug — ids, numbers, quoted values, timestamps — so "Order abc123 not found"
 * and "Order def456 not found" land on one fingerprint. Without this the
 * console's grouping is useless: every occurrence is its own group.
 */
function messageShape(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[a-z][a-z0-9]{20,31}\b/g, '<id>') // cuid / cuid2
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<time>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/(["'`])(?:[^"'`\\]|\\.)*\1/g, '<str>')
    .trim()
    .slice(0, 300);
}

export function fingerprintOf(name: string, message: string, stack: string | null): string {
  const basis = `${name}|${messageShape(message)}|${topFrame(stack)}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/**
 * Flatten anything that was thrown into the stored shape. Non-Error throws are
 * common in JS (a string, a Prisma result, `undefined` from a rejected promise
 * with no reason) and must not be lost just because they lack a stack.
 */
export function normalizeError(err: unknown, level: ErrorLevel = 'error'): NormalizedError {
  let name = 'Error';
  let message = '';
  let stack: string | null = null;

  if (err instanceof Error) {
    name = err.name || 'Error';
    message = err.message || '';
    stack = typeof err.stack === 'string' ? err.stack : null;
    // Prisma and fetch both hang the useful part off a property, not the message.
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code && !message.includes(code)) {
      message = `${code}: ${message}`;
    }
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && !message.includes(cause.message)) {
      message = `${message} (cause: ${cause.message})`;
    }
  } else if (typeof err === 'string') {
    name = 'ThrownString';
    message = err;
  } else if (err === null || err === undefined) {
    name = 'ThrownEmpty';
    message = String(err);
  } else {
    name = 'ThrownValue';
    try {
      message = JSON.stringify(toPlain(err)) ?? String(err);
    } catch {
      message = String(err);
    }
  }

  const safeMessage = scrubText(message || '(no message)', MAX_MESSAGE);
  const safeStack = stack ? scrubText(stack, MAX_STACK) : null;

  return {
    name: name.slice(0, 120),
    message: safeMessage,
    stack: safeStack,
    // Fingerprint the SCRUBBED text so two events that differ only in a redacted
    // secret still group together.
    fingerprint: fingerprintOf(name, safeMessage, safeStack),
    level,
  };
}

/**
 * Build the stored context blob: the fixed request fields plus sanitized extras,
 * clamped so one runaway payload cannot bloat the table.
 */
export function buildContext(context: ErrorContext): JsonValue | null {
  const base: Record<string, JsonValue> = {};
  if (context.route) base.route = scrubText(context.route, 300);
  if (context.method) base.method = context.method.slice(0, 10);
  if (context.actor) base.actor = context.actor.slice(0, 120);
  if (context.actorRole) base.actor_role = context.actorRole.slice(0, 60);
  if (context.requestId) base.request_id = context.requestId.slice(0, 120);
  if (context.ip) base.ip = context.ip.slice(0, 60);

  if (context.extra && Object.keys(context.extra).length > 0) {
    const cleaned = scrubDeep(sanitize(toPlain(context.extra), '', 1) as unknown as JsonValue);
    base.extra = cleaned;
  }

  if (Object.keys(base).length === 0) return null;

  const bytes = Buffer.byteLength(JSON.stringify(base) ?? '', 'utf8');
  if (bytes > MAX_CONTEXT_BYTES) {
    return { _truncated: true, _bytes: bytes, _keys: Object.keys(base) };
  }
  return base;
}

function resolveSource(context: ErrorContext): string {
  return (context.source ?? process.env.ERROR_SOURCE ?? 'api').slice(0, 60);
}

// ---------------------------------------------------------------------------
// Console — the floor under both drivers
// ---------------------------------------------------------------------------

/**
 * Every captured error hits stderr regardless of driver. The row or the Sentry
 * event is the searchable copy; this is the one that exists even when the
 * database is the thing that broke.
 */
function echoToConsole(source: string, e: NormalizedError, context: ErrorContext): void {
  const where = [context.method, context.route].filter(Boolean).join(' ');
  const who = context.operatorId ? ` operator=${context.operatorId}` : '';
  // eslint-disable-next-line no-console
  console.error(
    `[errors] ${e.level} ${source} ${e.name}: ${e.message}${where ? ` (${where})` : ''}${who} fp=${e.fingerprint}`,
  );
  if (e.stack) {
    // eslint-disable-next-line no-console
    console.error(e.stack);
  }
}

function reportLost(e: NormalizedError, cause: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[errors] LOST EVENT', e.fingerprint, e.name, e.message, cause);
}

// ---------------------------------------------------------------------------
// Local driver
// ---------------------------------------------------------------------------

/**
 * Persist to SandboxError plus console.
 *
 * One row per throw, never a deduped counter — the Local Console groups by
 * `fingerprint` for display, but a test that asserts "exactly one error fired"
 * needs the rows to be countable.
 */
export const localErrorSink: ErrorSink = {
  name: 'local',

  async capture(err: unknown, context: ErrorContext = {}): Promise<CapturedError> {
    const e = normalizeError(err, context.level ?? 'error');
    const source = resolveSource(context);
    echoToConsole(source, e, context);

    if (!context.operatorId) {
      // SandboxError is tenant-scoped under RLS; without a tenant there is no
      // safe client to write it with. Console is the whole record here.
      return { id: null, fingerprint: e.fingerprint, driver: 'console' };
    }

    if (shouldSuppress(e.fingerprint)) {
      return { id: null, fingerprint: e.fingerprint, driver: 'suppressed' };
    }

    try {
      const stored = buildContext(context);
      const row = await forOperator(context.operatorId).sandboxError.create({
        data: {
          operator_id: context.operatorId,
          source,
          name: e.name,
          message: e.message,
          stack: e.stack,
          fingerprint: e.fingerprint,
          context: (stored ?? undefined) as Prisma.InputJsonValue | undefined,
        },
        select: { id: true },
      });
      return { id: row.id, fingerprint: e.fingerprint, driver: 'local' };
    } catch (writeErr) {
      reportLost(e, writeErr);
      return { id: null, fingerprint: e.fingerprint, driver: 'console' };
    }
  },
};

// ---------------------------------------------------------------------------
// Cloud driver — Sentry
// ---------------------------------------------------------------------------

/**
 * The cloud twin posts a Sentry *envelope* with `fetch` instead of pulling in
 * `@sentry/node`. That is a deliberate trade, and the reasons are in order of
 * weight:
 *
 *  1. §0 says the product must compile and run with no Sentry account. An SDK
 *     that reads a DSN at import time and installs global handlers fights that.
 *  2. The envelope endpoint is a stable, documented HTTP contract; the event
 *     body below is the same JSON the SDK would send.
 *  3. Zero new dependencies.
 *
 * What we give up is the SDK's extras: breadcrumbs, automatic instrumentation,
 * release health, source-map resolution (server stacks here are TS run through
 * tsx/tsc, so frames are already readable), and local buffering with retry.
 * If any of those become required, swap this driver's body for the SDK — the
 * `ErrorSink` interface does not change.
 *
 * CUTOVER (§6): set `SANDBOX=cloud` and `SENTRY_DSN`. Optional:
 * `SENTRY_ENVIRONMENT` (defaults to NODE_ENV), `SENTRY_RELEASE` (defaults to
 * APP_VERSION), `SENTRY_TIMEOUT_MS` (defaults to 3000).
 */

interface ParsedDsn {
  publicKey: string;
  envelopeUrl: string;
}

/**
 * DSN shape: `https://<publicKey>@<host>[/<path>]/<projectId>`. The envelope
 * endpoint is `<scheme>://<host>[/<path>]/api/<projectId>/envelope/`.
 */
export function parseSentryDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn.trim());
    const publicKey = url.username;
    const segments = url.pathname.split('/').filter(Boolean);
    const projectId = segments.pop();
    if (!publicKey || !projectId) return null;
    const prefix = segments.length ? `/${segments.join('/')}` : '';
    return {
      publicKey,
      envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    };
  } catch {
    return null;
  }
}

/** V8 stack line -> Sentry frame. Unparseable lines are dropped, not guessed. */
function sentryFrames(stack: string | null): Array<Record<string, JsonValue>> {
  if (!stack) return [];
  const frames: Array<Record<string, JsonValue>> = [];
  for (const line of stack.split('\n').slice(1)) {
    const match = line.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/);
    if (!match) continue;
    frames.push({
      function: match[1] ?? '<anonymous>',
      filename: match[2],
      lineno: Number.parseInt(match[3], 10),
      colno: Number.parseInt(match[4], 10),
      in_app: isOurFrame(line),
    });
  }
  // Sentry renders frames oldest-first; V8 gives newest-first.
  return frames.reverse();
}

function eventId(): string {
  return createHash('sha1')
    .update(`${Date.now()}:${Math.random()}:${process.pid}`)
    .digest('hex')
    .slice(0, 32);
}

let dsnWarned = false;

export const cloudErrorSink: ErrorSink = {
  name: 'cloud',

  async capture(err: unknown, context: ErrorContext = {}): Promise<CapturedError> {
    const e = normalizeError(err, context.level ?? 'error');
    const source = resolveSource(context);
    echoToConsole(source, e, context);

    const dsn = process.env.SENTRY_DSN?.trim();
    const parsed = dsn ? parseSentryDsn(dsn) : null;
    if (!parsed) {
      if (dsn && !dsnWarned) {
        dsnWarned = true;
        // eslint-disable-next-line no-console
        console.error('[errors] SENTRY_DSN is set but not parseable - events are console-only');
      }
      return { id: null, fingerprint: e.fingerprint, driver: 'console' };
    }

    if (shouldSuppress(e.fingerprint)) {
      return { id: null, fingerprint: e.fingerprint, driver: 'suppressed' };
    }

    const id = eventId();
    const stored = buildContext(context);
    const event: Record<string, JsonValue> = {
      event_id: id,
      timestamp: new Date().toISOString(),
      platform: 'node',
      level: e.level,
      logger: source,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
      release: process.env.SENTRY_RELEASE ?? process.env.APP_VERSION ?? null,
      transaction: context.route ?? null,
      // Our own fingerprint, so Sentry's grouping matches the Local Console's.
      fingerprint: [e.fingerprint],
      tags: {
        source,
        operator_id: context.operatorId ?? 'none',
        method: context.method ?? 'none',
        actor_role: context.actorRole ?? 'none',
      },
      // Actor id only. Never an email, name, or phone — those are the customer's,
      // and an error tracker is not a place to accumulate them.
      user: context.actor ? { id: context.actor } : null,
      extra: stored,
      exception: {
        values: [
          {
            type: e.name,
            value: e.message,
            stacktrace: { frames: sentryFrames(e.stack) },
          },
        ],
      },
    };

    const body = [
      JSON.stringify({ event_id: id, sent_at: new Date().toISOString(), dsn }),
      JSON.stringify({ type: 'event', content_type: 'application/json' }),
      JSON.stringify(event),
    ].join('\n');

    const timeoutMs = Number.parseInt(process.env.SENTRY_TIMEOUT_MS ?? '', 10);
    try {
      const res = await fetch(parsed.envelopeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=marina/1.0, sentry_key=${parsed.publicKey}`,
        },
        body,
        signal: AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3_000),
      });
      if (!res.ok) {
        // 429 is Sentry rate-limiting us; anything else is a real delivery fault.
        reportLost(e, `sentry responded ${res.status}`);
        return { id: null, fingerprint: e.fingerprint, driver: 'console' };
      }
      return { id, fingerprint: e.fingerprint, driver: 'cloud' };
    } catch (sendErr) {
      reportLost(e, sendErr);
      return { id: null, fingerprint: e.fingerprint, driver: 'console' };
    }
  },
};

// ---------------------------------------------------------------------------
// Selection + public API
// ---------------------------------------------------------------------------

/** Which driver is live. Same rule as the message sink and payment simulator. */
export function errorSink(): ErrorSink {
  return sandboxEnabled() ? localErrorSink : cloudErrorSink;
}

/** Race marker. A unique symbol so it can never collide with a CapturedError. */
const TIMED_OUT = Symbol('errors.timeout');

/**
 * Await `pending`, but give up after `ms`. The loser of the race keeps running and
 * gets a no-op rejection handler so a late failure cannot surface as an
 * unhandledRejection and take the process down — which would be this module
 * causing exactly the class of outage it exists to explain.
 */
async function within(pending: Promise<CapturedError>, ms: number): Promise<CapturedError | typeof TIMED_OUT> {
  pending.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // Never hold the event loop open for a pending error report.
    timer.unref?.();
  });

  try {
    return await Promise.race([pending, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record one error. Never throws, never rejects, and never blocks longer than
 * `ERROR_CAPTURE_TIMEOUT_MS` — call it without a try/catch, and without awaiting
 * if the caller is on a hot path.
 */
export async function captureError(
  err: unknown,
  context: ErrorContext = {},
): Promise<CapturedError> {
  try {
    const pending = errorSink().capture(err, context);
    const budget = captureTimeoutMs();
    if (budget === 0) return await pending;

    const settled = await within(pending, budget);
    if (settled === TIMED_OUT) {
      reportLost(normalizeError(err, context.level ?? 'error'), `sink did not respond within ${budget}ms`);
      return { id: null, fingerprint: 'unknown', driver: 'console' };
    }
    return settled;
  } catch (sinkErr) {
    // The sink itself failing is the one case its own handler cannot cover.
    // eslint-disable-next-line no-console
    console.error('[errors] sink failure', sinkErr, 'while capturing', err);
    return { id: null, fingerprint: 'unknown', driver: 'console' };
  }
}

/**
 * The minimum a Hono context has to look like for `captureHonoError`. Structural
 * rather than an import of `Context<Env>` so this module stays testable with a
 * plain object and carries no framework coupling.
 */
export interface RequestLike {
  req: {
    method: string;
    path: string;
    routePath?: string;
    header(name: string): string | undefined;
  };
  var: {
    operatorId?: string;
    auth?: { userId?: string; role?: string };
  };
}

/**
 * Capture from inside `app.onError`, pulling operator, route and actor off the
 * request context. See docs/OPERATIONS.md for the wiring.
 */
export async function captureHonoError(
  err: unknown,
  c: RequestLike,
  context: ErrorContext = {},
): Promise<CapturedError> {
  // Reading the request must not be able to throw here: this function is called
  // from the handler of an error that already happened.
  let derived: ErrorContext = {};
  try {
    derived = {
      operatorId: c.var.operatorId ?? null,
      route: c.req.routePath ?? c.req.path,
      method: c.req.method,
      actor: c.var.auth?.userId ?? null,
      actorRole: c.var.auth?.role ?? null,
      requestId: c.req.header('x-request-id') ?? null,
      ip:
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
        c.req.header('x-real-ip') ??
        null,
    };
  } catch {
    // fall through with whatever the caller passed
  }

  return captureError(err, { ...derived, ...context });
}
