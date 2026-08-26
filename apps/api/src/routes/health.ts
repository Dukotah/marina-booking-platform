/**
 * Health and readiness — GET /health, /health/live, /health/ready, /health/info
 *
 * The distinction these endpoints exist to make is the one that decides whether
 * a restart helps:
 *
 *   liveness  — is this process alive and able to answer? Touches NOTHING
 *               external. A failing liveness check means "kill me and start a
 *               new one". It must therefore never fail because the database is
 *               down, since restarting the API does not fix Postgres; it just
 *               turns a recoverable outage into a crash loop.
 *   readiness — can this process actually serve a request end to end? It does a
 *               real database round-trip. A failing readiness check means "stop
 *               sending me traffic", not "restart me".
 *
 * Readiness proves three separate things, because in this product they fail
 * separately and the fix differs each time:
 *   1. the connection works              -> the cluster is up and reachable
 *   2. the schema is there               -> migrations were applied
 *   3. the sandbox flag matches the env  -> a production deploy that is still
 *      on the simulated payment/email drivers would take real bookings with
 *      fake money. That is reported as `degraded`, loudly, rather than as an
 *      outage, since refusing traffic would not fix it either.
 *
 * These endpoints are UNAUTHENTICATED and take no tenant. `/health/ready`
 * reports migration names and a scrubbed error string, so it belongs on an
 * internal address or behind the load balancer, not on the public internet.
 * See docs/OPERATIONS.md.
 */
import { Hono } from 'hono';
import { adminPrisma } from '@marina/database';
import type { Env } from '../context.js';
import { scrubText } from '../services/errors.js';
import { sandboxEnabled } from '../services/sandbox.js';

export const health = new Hono<Env>();

/** When this process started. Uptime is measured from here, not from boot. */
const STARTED_AT = new Date();

const SERVICE = 'marina-api';

/** A dependency check that hangs is a failed check; do not wait out a TCP timeout. */
const DEFAULT_TIMEOUT_MS = 2_000;

function timeoutMs(): number {
  const raw = Number.parseInt(process.env.HEALTH_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface CheckResult {
  status: CheckStatus;
  latencyMs?: number;
  detail?: string;
  [key: string]: unknown;
}

export interface BuildInfo {
  service: string;
  version: string;
  /** Short commit SHA when the deploy provided one. */
  commit: string | null;
  node: string;
  env: string;
  /** Which provider drivers are live: `local` = simulators, `cloud` = real. */
  sandbox: 'local' | 'cloud';
  startedAt: string;
  uptimeSeconds: number;
  pid: number;
}

/**
 * Build identity. Every field comes from the environment rather than from
 * reading package.json at runtime: the built artifact in `dist/` sits at a
 * different depth than the source, and a health endpoint that throws on a path
 * lookup is worse than one that reports "0.0.0".
 */
export function buildInfo(): BuildInfo {
  const commit =
    process.env.GIT_COMMIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    null;

  return {
    service: SERVICE,
    version: process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.0.0',
    commit: commit ? commit.slice(0, 12) : null,
    node: process.version,
    env: process.env.NODE_ENV ?? 'development',
    sandbox: sandboxEnabled() ? 'local' : 'cloud',
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
  };
}

/** Reject rather than hang. The loser of the race is abandoned, not cancelled. */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Never let a raw driver error reach an unauthenticated response — a Prisma
 * connection failure quotes the connection string, password included.
 */
function safeDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return scrubText(message.split('\n')[0] ?? 'unknown error', 240);
}

/**
 * Round-trip the database and prove the schema is present in one query.
 *
 * `operator.count()` rather than `SELECT 1` on purpose: a cluster that is up but
 * holding an empty or half-migrated database answers `SELECT 1` perfectly well
 * and then fails every real request. Counting a tenant-root table exercises the
 * connection, the schema, and the Prisma client together.
 *
 * This is one of the few legitimate uses of `adminPrisma` (see
 * packages/database/src/client.ts): the check is platform-level and has no
 * tenant, and it reads no tenant rows.
 */
export async function checkDatabase(): Promise<CheckResult> {
  const started = Date.now();
  try {
    const operators = await withTimeout(adminPrisma.operator.count(), timeoutMs(), 'database');
    return { status: 'ok', latencyMs: Date.now() - started, operators };
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - started, detail: safeDetail(err) };
  }
}

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

/**
 * What Prisma's own migration table says. Reported, never fatal: a deploy that
 * cannot read `_prisma_migrations` (a restricted role, a database provisioned
 * by hand) is not necessarily unhealthy, and `checkDatabase` already covers the
 * case that matters.
 */
export async function checkMigrations(): Promise<CheckResult> {
  const started = Date.now();
  try {
    const rows = await withTimeout(
      adminPrisma.$queryRaw<MigrationRow[]>`
        SELECT migration_name, finished_at, rolled_back_at
        FROM _prisma_migrations
        ORDER BY started_at DESC
      `,
      timeoutMs(),
      'migrations',
    );

    const applied = rows.filter((r) => r.finished_at !== null && r.rolled_back_at === null);
    const unfinished = rows.filter((r) => r.finished_at === null && r.rolled_back_at === null);
    const rolledBack = rows.filter((r) => r.rolled_back_at !== null);

    return {
      // An unfinished or rolled-back migration means the schema is in a state
      // nobody designed. Worth a warning on every page load until it is fixed.
      status: unfinished.length > 0 || rolledBack.length > 0 ? 'warn' : 'ok',
      latencyMs: Date.now() - started,
      applied: applied.length,
      latest: applied[0]?.migration_name ?? null,
      unfinished: unfinished.map((r) => r.migration_name),
      rolledBack: rolledBack.map((r) => r.migration_name),
    };
  } catch (err) {
    return { status: 'warn', latencyMs: Date.now() - started, detail: safeDetail(err) };
  }
}

/**
 * Is the process running the simulated providers in a place that takes real
 * money? `warn`, not `error`: taking the node out of rotation does not fix a
 * misconfiguration, but this has to be impossible to miss on a status page.
 */
export function checkSandbox(): CheckResult {
  const local = sandboxEnabled();
  const prod = process.env.NODE_ENV === 'production';
  if (local && prod) {
    return {
      status: 'warn',
      mode: 'local',
      detail:
        'SANDBOX is local in a production build - payments, email and SMS are SIMULATED. Set SANDBOX=cloud.',
    };
  }
  return { status: 'ok', mode: local ? 'local' : 'cloud' };
}

/** The worst status present decides the overall one. */
function rollUp(checks: Record<string, CheckResult>): 'ok' | 'degraded' | 'error' {
  const statuses = Object.values(checks).map((c) => c.status);
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warn')) return 'degraded';
  return 'ok';
}

/** Health answers must never be cached by a proxy, a browser, or a CDN. */
health.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store, max-age=0');
});

/**
 * Liveness. Answers as long as the event loop is turning. Deliberately touches
 * no dependency — see the module header for why.
 */
function livenessBody() {
  return { status: 'ok', service: SERVICE, uptimeSeconds: Math.round(process.uptime()) };
}

health.get('/', (c) => c.json(livenessBody()));
health.get('/live', (c) => c.json(livenessBody()));

/** Build and runtime identity, with no dependency checks. */
health.get('/info', (c) => c.json(buildInfo()));

/**
 * Readiness. 200 for `ok` and `degraded`, 503 for `error` — a degraded process
 * still serves correct responses, so pulling it from rotation would trade a
 * warning for an outage.
 */
health.get('/ready', async (c) => {
  const started = Date.now();
  const [database, migrations] = await Promise.all([checkDatabase(), checkMigrations()]);
  const checks: Record<string, CheckResult> = {
    database,
    migrations,
    sandbox: checkSandbox(),
  };

  const status = rollUp(checks);
  return c.json(
    {
      status,
      service: SERVICE,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      checks,
      build: buildInfo(),
    },
    status === 'error' ? 503 : 200,
  );
});
