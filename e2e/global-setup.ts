/**
 * Preflight.
 *
 * An e2e suite that fails obscurely because a server is down or the database is empty
 * costs more than it saves. This runs once before anything else and turns each of those
 * into one sentence saying exactly what to do — the difference between "Timeout 30000ms
 * exceeded" twenty times and "the admin app is not running; start it with pnpm dev:local".
 *
 * It only reads. It never seeds, resets or writes anything, because it runs against the
 * owner's live local database.
 */
import { request } from '@playwright/test';
import { ADMIN_URL, API_URL, OPERATOR_SLUG, TIMEZONE, WEB_URL } from './config';

class PreflightError extends Error {
  constructor(message: string) {
    super(`\n\n  E2E preflight failed\n  ────────────────────\n  ${message}\n`);
    this.name = 'PreflightError';
  }
}

const START_HINT =
  'Start the whole stack with `pnpm dev:local` (see docs/TESTING.md), then re-run.';

/**
 * How long to keep trying a port. Short when the stack is expected to be up already
 * (a wrong port should say so immediately, not after five minutes); long when
 * Playwright was asked to start the servers, because `next dev` on a cold .next
 * directory legitimately takes minutes to answer.
 */
const REACH_DEADLINE_MS = process.env.E2E_START_SERVERS ? 300_000 : 20_000;

type Http = Awaited<ReturnType<typeof request.newContext>>;

export default async function globalSetup(): Promise<void> {
  const http = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    await checkReachable(http, `${API_URL}/health`, 'API', API_URL);
    await checkReachable(http, WEB_URL, 'customer site', WEB_URL);
    await checkReachable(http, ADMIN_URL, 'admin app', ADMIN_URL);
    await checkTenant(http);
    await checkCatalog(http);
    await checkLocalConsole(http);
  } finally {
    await http.dispose();
  }
}

async function checkReachable(http: Http, url: string, label: string, base: string): Promise<void> {
  const deadline = Date.now() + REACH_DEADLINE_MS;
  let lastError = 'connection refused';

  while (Date.now() < deadline) {
    try {
      const res = await http.get(url, { timeout: 15_000, failOnStatusCode: false });
      // 404 is fine for a bare root with no index route; a 5xx is a server that came up
      // and is broken, which is worth failing on immediately rather than retrying.
      if (res.status() >= 500) {
        throw new PreflightError(
          `The ${label} at ${base} answered ${res.status()}. It is running but erroring — check its terminal output.`,
        );
      }
      return;
    } catch (err) {
      if (err instanceof PreflightError) throw err;
      lastError = (err as Error).message;
      await sleep(1_000);
    }
  }

  throw new PreflightError(
    `The ${label} is not answering at ${base}.\n  ${START_HINT}\n  (last error: ${lastError})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkTenant(http: Http): Promise<void> {
  const res = await http.get(`${API_URL}/api/operator/public`, {
    headers: { 'x-operator-slug': OPERATOR_SLUG },
    failOnStatusCode: false,
  });
  if (res.status() === 404) {
    throw new PreflightError(
      `The API does not know the operator "${OPERATOR_SLUG}".\n` +
        '  Either the database is not seeded (`pnpm db:reset`) or E2E_OPERATOR_SLUG points at the wrong tenant.',
    );
  }
  if (!res.ok()) {
    throw new PreflightError(
      `Resolving the tenant "${OPERATOR_SLUG}" failed with ${res.status()}: ${(await res.text()).slice(0, 300)}`,
    );
  }

  const operator = (await res.json()) as { timezone: string; name: string };
  if (operator.timezone && operator.timezone !== TIMEZONE) {
    // Not cosmetic: the fixtures compute a calendar day in the operator's zone and then
    // look for that day's label in a browser pinned to TIMEZONE. Disagreeing zones make
    // the date-strip selector miss by a day, roughly at dinner time, on some days only.
    throw new PreflightError(
      `Operator "${operator.name}" runs in ${operator.timezone} but the browser is pinned to ${TIMEZONE}.\n` +
        `  Set E2E_TIMEZONE=${operator.timezone} (or change the operator's timezone in Settings).`,
    );
  }
}

async function checkCatalog(http: Http): Promise<void> {
  const res = await http.get(`${API_URL}/api/activities`, {
    headers: { 'x-operator-slug': OPERATOR_SLUG },
    failOnStatusCode: false,
  });
  if (!res.ok()) {
    throw new PreflightError(`Loading the catalog failed with ${res.status()}.`);
  }
  const { activities } = (await res.json()) as { activities: Array<{ rates: unknown[] }> };
  const bookable = activities.filter((a) => a.rates.length > 0);
  if (bookable.length === 0) {
    throw new PreflightError(
      `Operator "${OPERATOR_SLUG}" has no bookable activities, so nothing in this suite can run.\n` +
        '  Seed a believable season with `pnpm db:reset`.',
    );
  }
}

async function checkLocalConsole(http: Http): Promise<void> {
  const res = await http.get(`${ADMIN_URL}/dev`, { failOnStatusCode: false, timeout: 90_000 });
  if (res.status() === 404) {
    throw new PreflightError(
      'The Local Console at /dev returned 404, so the payment simulator and the sandbox inbox\n' +
        '  cannot be driven. That gate is SANDBOX: it is open when SANDBOX=local, and closed when\n' +
        '  SANDBOX=cloud or NODE_ENV=production. Unset SANDBOX (or set it to local) and restart the admin app.',
    );
  }
  if (!res.ok()) {
    throw new PreflightError(`The Local Console at ${ADMIN_URL}/dev answered ${res.status()}.`);
  }
}
