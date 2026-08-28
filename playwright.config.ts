import { defineConfig, devices } from '@playwright/test';
import { ADMIN_URL, API_URL, TIMEZONE, WEB_URL } from './e2e/config';

/**
 * End-to-end browser tests against the LOCAL stack.
 *
 * The contract's Definition of Done requires a browser test for anything a human
 * touches (docs/LOCAL-FIRST-BUILD.md §3.2), and the whole product must be exercisable
 * on one laptop with no account anywhere (§0). Those two together decide most of what
 * is below: no external test service, no hosted grid, no Stripe test keys — the suite
 * drives the same local drivers the owner uses, including the payment simulator in the
 * Local Console.
 *
 * The servers are NOT started by default. `pnpm dev:local` is a long-running command
 * that also starts WSL Postgres and can reseed; having a test run own that is a good
 * way to have a test run wipe a database someone was looking at. So the default is to
 * attach to a stack that is already up, and `e2e/global-setup.ts` explains precisely
 * what to start if it is not. Set E2E_START_SERVERS=1 to opt into Playwright managing
 * the stack (useful in CI, where nothing else is running).
 */
export default defineConfig({
  testDir: './e2e/specs',
  globalSetup: './e2e/global-setup.ts',
  outputDir: './e2e/.artifacts/results',

  /*
   * Timeouts are generous because `next dev` compiles each route the first time it is
   * requested, and a cold /checkout can take 20s+ on this machine. That cost is paid
   * once per route per server start, not per test — but a suite that assumes a warm
   * server is a suite that fails on the first run of the day.
   */
  timeout: 120_000,
  expect: { timeout: 15_000 },

  /*
   * Files run in parallel, tests within a file run in order. Two reasons not to use
   * fullyParallel: the public API rate-limits booking creation to 30 requests a minute
   * per IP per route (apps/api/src/middleware/rate-limit.ts), and every worker shares
   * one Postgres and one dev server.
   */
  fullyParallel: false,
  /*
   * ONE worker. Not a performance compromise — a correctness requirement. The payment
   * simulator's outcome queue is per-OPERATOR global state (the Local Console queues
   * "the next charge will decline", and whichever charge arrives first consumes it),
   * and every spec books against the same seeded operator. With two workers, a decline
   * queued by payments.spec was consumed by a booking in local-console.spec, which then
   * failed with a 402 it never asked for.
   *
   * Scoping the queue per guest would let this parallelise, but that would be inventing
   * product complexity to serve the test harness; the owner's console is single-operator
   * by design. Override with E2E_WORKERS if you are running a subset that does not touch
   * simulator state.
   */
  workers: Number(process.env.E2E_WORKERS ?? 1),

  /* A retry is for a genuinely flaky environment, never a way to launder a real bug —
     so local runs get none, and any CI retry shows up in the report as a retry. */
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'e2e/.artifacts/report', open: 'never' }], ['github']]
    : [['list'], ['html', { outputFolder: 'e2e/.artifacts/report', open: 'never' }]],

  use: {
    baseURL: WEB_URL,

    /*
     * Pinned, not inherited. The fixtures compute a calendar day in the OPERATOR's
     * timezone and then look for that day's label in the browser; if the two disagree
     * the date selector misses by one day for part of each day. Global setup asserts
     * this matches the operator's configured zone.
     */
    timezoneId: TIMEZONE,
    locale: 'en-US',

    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
      testIgnore: /mobile\..*\.spec\.ts$/,
    },
    {
      /*
       * The throttled mobile run. Chromium specifically: the network shaping goes
       * through the DevTools protocol, which is the only way to get real latency and
       * bandwidth limits rather than a simulated delay in the test process.
       */
      name: 'mobile-throttled',
      use: { ...devices['Pixel 7'] },
      testMatch: /mobile\..*\.spec\.ts$/,
    },
  ],

  /*
   * Opt-in only. One command brings up all three servers, so Playwright waits on the
   * API's health endpoint and global setup waits (with a long deadline) for the two
   * Next apps, which compile more slowly. Note that `pnpm dev:local` needs pnpm on
   * PATH — it is not, on the owner's machine (docs/LOCAL-FIRST-BUILD.md §1) — hence
   * E2E_SERVER_COMMAND for supplying a launcher that sets it up.
   */
  webServer: process.env.E2E_START_SERVERS
    ? {
        command: process.env.E2E_SERVER_COMMAND ?? 'pnpm dev:local',
        url: `${API_URL}/health`,
        reuseExistingServer: true,
        timeout: 300_000,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    : undefined,
});
