/**
 * The performance budget: what the booking funnel is allowed to cost a guest.
 *
 * There was exactly one timed test in this suite (`mobile.funnel.spec.ts`, a 30-second
 * end-to-end clock) and nothing at all watching page weight. A 30-second budget is a
 * smoke alarm, not a thermostat: a feature could ship 200 KB of client JavaScript on the
 * checkout route, take the funnel from 7 seconds to 19, and pass. The guest on rural LTE
 * who gave up is not in the report.
 *
 * The contract's stated bar is "Lighthouse mobile performance 95+, accessibility 100"
 * (docs/LOCAL-FIRST-BUILD.md §6). Lighthouse is not installed and §0 forbids installing
 * it, so this spec asserts the measurements Lighthouse would have scored, taken from the
 * DevTools protocol Playwright already holds open:
 *
 *   - transfer bytes of JS and CSS per route, gzipped, off the wire;
 *   - largest contentful paint and cumulative layout shift, via PerformanceObserver;
 *   - time to the first interaction that actually works, on Slow 4G + 4× CPU;
 *   - the size of the embed loader, which runs on other operators' websites.
 *
 * Accessibility 100 is already enforced, harder than Lighthouse enforces it, by
 * `accessibility.spec.ts` at zero serious/critical violations. This spec does not
 * duplicate it.
 *
 * **Every budget below was measured on this code and then given headroom.** None is an
 * aspiration. A budget nobody can pass gets deleted by the third person who trips it, so
 * the byte numbers are the product as it stands plus roughly 15 %, and the baseline they
 * came from is written down in docs/PERFORMANCE.md §6 so the next person can see what
 * changed and by how much. Each budget carries its measured value in a trailing comment;
 * if you change one, change that comment and the doc in the same edit.
 *
 * **One budget is deliberately red.** The checkout route pulls ~245 KB of Stripe.js from
 * js.stripe.com on a stack that has no Stripe key and never calls it, because
 * `@stripe/stripe-js` injects that script from module scope on import. Its third-party
 * budget is zero and it fails, which is the correct outcome: the fix is two lines in
 * `apps/web/components/checkout/*` (docs/PERFORMANCE.md §7), and raising the budget to
 * accommodate it would delete the only thing that noticed.
 */
import { devices, type Page } from '@playwright/test';
import path from 'node:path';
import { expect, test } from '../fixtures/test';
import { WEB_URL } from '../config';
import { SLOW_4G, throttle, warmRoutes } from '../helpers/network';
import {
  KB,
  fileBytes,
  fetchAsset,
  kb,
  observePaint,
  overBudget,
  readPaint,
  recordResources,
  settle,
  type PaintMetrics,
  type ResourceTally,
} from '../helpers/perf';

/*
 * Measured on a phone, because that is the guest the contract is about. The device
 * descriptor's `defaultBrowserType` is dropped deliberately: Playwright resolves the
 * browser per project, and re-declaring it inside a describe is how a spec ends up
 * silently spawning a second browser.
 */
const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

/** What one route is allowed to cost. Bytes are transfer bytes, gzipped. */
interface RouteBudget {
  name: string;
  /** Our own JavaScript, downloaded before the load event. */
  jsKb: number;
  /** Our own stylesheets, downloaded before the load event. */
  cssKb: number;
  /** Everything we serve: the HTML document, JS, CSS, images, fonts. */
  totalKb: number;
  /**
   * Bytes from anybody else's origin.
   *
   * Budgeted separately, and hard, because a third-party script is a different kind of
   * liability: we cannot split it, cannot minify it, cannot cache it on our own terms,
   * and on a product whose first rule is "exercisable with no account anywhere"
   * (docs/LOCAL-FIRST-BUILD.md §0) an unconditional call out to a vendor's CDN is a
   * correctness problem before it is a performance one.
   */
  thirdPartyKb: number;
  /**
   * Largest contentful paint, unthrottled, on the production build.
   *
   * Given more headroom than the byte budgets on purpose: bytes are deterministic to the
   * byte across runs, but this number is taken on a laptop that is also running the API,
   * Postgres and whatever else is open, and it moves 88–232 ms for reasons that have
   * nothing to do with the product. It is here to catch a route that stops rendering its
   * hero on the server, not to police tens of milliseconds. The measurement with real
   * teeth on a bad connection is the throttled first-interaction budget below.
   */
  lcpMs: number;
  /**
   * Cumulative layout shift, summed strictly (no session windows).
   *
   * Budgeted tight because it is genuinely 0.000 today: the funnel ships no web fonts,
   * no images above the fold, and skeletons whose height matches the real content
   * (docs/PERFORMANCE.md §2.4). Anything that starts moving the page after first paint
   * should have to argue for it.
   */
  cls: number;
}

/**
 * Budgets for the three routes a guest passes through to book.
 *
 * Each is set from the measured baseline in docs/PERFORMANCE.md §6 with headroom for a
 * normal feature: a route can grow by a chunk or two before it trips. What it cannot do
 * is grow by a library.
 */
const BUDGETS: Record<'catalog' | 'activity' | 'checkout', RouteBudget> = {
  catalog: {
    name: 'catalog (/)',
    jsKb: 145, // measured 126.8
    cssKb: 12, // measured 7.8
    totalKb: 165, // measured 143.9
    thirdPartyKb: 0, // measured 0
    lcpMs: 1_000, // measured 108–224
    cls: 0.02, // measured 0.000
  },
  activity: {
    name: 'activity (/activities/[id])',
    jsKb: 150, // measured 130.2
    cssKb: 12, // measured 7.8
    totalKb: 168, // measured 146.6
    thirdPartyKb: 0, // measured 0
    lcpMs: 1_000, // measured 144–200
    cls: 0.02, // measured 0.000
  },
  checkout: {
    name: 'checkout (/checkout)',
    jsKb: 195, // measured 168.2
    cssKb: 12, // measured 7.8
    totalKb: 210, // measured 183.8
    /*
     * Zero, and it currently FAILS at ~245 KB. That is the finding, not the budget's
     * fault: `@stripe/stripe-js` injects js.stripe.com/v3 from module scope on import,
     * so checkout downloads a quarter of a megabyte of Stripe.js on a stack that has no
     * Stripe key and never calls it. See docs/PERFORMANCE.md §7 for the two-line fix.
     * The number stays at zero after that fix, because this suite only ever runs against
     * SANDBOX=local — where, by §0, nothing on the booking path may reach a vendor at all.
     */
    thirdPartyKb: 0,
    lcpMs: 1_000, // measured 88–232
    cls: 0.02, // measured 0.000
  },
};

/**
 * The embed loader's budget, in raw source bytes and in gzipped wire bytes.
 *
 * Two numbers because they answer two different questions on somebody else's website:
 * the wire size is what their visitor waits for, and the source size is what their
 * browser parses on the main thread before their own page can finish. This is the one
 * asset whose size is a reputational matter rather than an internal one — an operator
 * evaluating us against FareHarbor will drop this script on their homepage and watch
 * what happens to their own numbers.
 */
const EMBED_BUDGET = { sourceKb: 50, wireKb: 15 }; // measured 45.6 / 13.6

/**
 * Budget for the first interaction on a throttled phone, in ms.
 *
 * Not "time to interactive" in Lighthouse's sense (which waits for the main thread to be
 * quiet for five seconds); this is the thing the guest experiences — from landing on the
 * activity page to a tap on the first control having visibly taken effect. The product
 * deliberately makes that possible before hydration (docs/PERFORMANCE.md §2.3), so it is
 * a budget with a real mechanism behind it, not a hope about bundle size.
 */
const FIRST_INTERACTION_BUDGET_MS = Number(process.env.E2E_TTI_BUDGET_MS ?? 3_000); // measured 0.8–1.1s

test.describe('performance budgets', () => {
  test.use(PIXEL_7);

  // ---------------------------------------------------------------------------
  // Page weight
  // ---------------------------------------------------------------------------

  test('the catalog route stays inside its byte budget', async ({ page }) => {
    assertRoute(await measureRoute(page, '/'), BUDGETS.catalog);
  });

  test('the activity route stays inside its byte budget', async ({ page, seed }) => {
    const selection = await seed.selection();
    const activityPath = `/activities/${encodeURIComponent(selection.activity.id)}`;
    assertRoute(await measureRoute(page, activityPath), BUDGETS.activity);
  });

  test('the checkout route stays inside its byte budget', async ({ page, seed }) => {
    const selection = await seed.selection();
    const params = new URLSearchParams({
      activityId: selection.activity.id,
      rateId: selection.rate.id,
      timeslotId: selection.slot.timeslotId,
      date: selection.date,
      quantity: String(selection.quantity),
    });
    assertRoute(await measureRoute(page, `/checkout?${params.toString()}`), BUDGETS.checkout);
  });

  // ---------------------------------------------------------------------------
  // First interaction, throttled
  // ---------------------------------------------------------------------------

  test('the first booking control responds quickly on Slow 4G', async ({
    page,
    seed,
    activityPage,
  }) => {
    const selection = await seed.selection();
    const activityPath = `/activities/${encodeURIComponent(selection.activity.id)}`;

    // Warm unthrottled first, exactly as the funnel spec does, so the number describes
    // the product rather than a server compiling or a connection pool waking up.
    await warmRoutes(page, [activityPath]);
    await throttle(page, SLOW_4G, { cpuSlowdown: 4 });

    const started = Date.now();
    await page.goto(activityPath, { waitUntil: 'commit' });

    const option = activityPage
      .rateGroup()
      .getByRole('radio', { name: new RegExp(escapeRx(selection.rate.name)) });

    await expect(option, 'the rate picker never painted').toBeVisible({ timeout: 60_000 });
    const paintedMs = Date.now() - started;

    // The measurement that matters: not "is it on screen" but "does it answer". A
    // painted-but-inert control is the failure mode this whole route was rebuilt around.
    await option.click();
    await expect(
      option,
      'the rate card was tapped and did not select — the control is painted but inert',
    ).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });
    const interactiveMs = Date.now() - started;

    record(
      `${SLOW_4G.name} + 4x CPU: rate picker painted at ${(paintedMs / 1000).toFixed(1)}s, ` +
        `first tap took effect at ${(interactiveMs / 1000).toFixed(1)}s ` +
        `(budget ${FIRST_INTERACTION_BUDGET_MS / 1000}s)`,
    );

    expect(
      interactiveMs,
      `the guest's first tap took ${(interactiveMs / 1000).toFixed(1)}s to have any effect on ` +
        `${SLOW_4G.name}; the budget is ${FIRST_INTERACTION_BUDGET_MS / 1000}s. The rate picker ` +
        'works before hydration by design (docs/PERFORMANCE.md §2.3) — if this regressed, check ' +
        'that PRE_HYDRATION_RADIOS still ships and that the group still opts in.',
    ).toBeLessThan(FIRST_INTERACTION_BUDGET_MS);
  });

  // ---------------------------------------------------------------------------
  // The embed loader
  // ---------------------------------------------------------------------------

  test('the embed loader stays small on somebody else\'s site', async () => {
    const served = await fetchAsset(`${WEB_URL}/embed.js`, 'gzip');
    expect(served.status, 'the embed loader must be served from the customer site').toBe(200);

    // On-disk size is asserted too, because the served size can only be measured while a
    // server is up, and the thing being defended is what the repository ships.
    const onDisk = await fileBytes(
      path.join(__dirname, '..', '..', 'apps', 'web', 'public', 'embed.js'),
    );

    record(
      `embed.js: ${kb(onDisk)} KB on disk, ${kb(served.transferBytes)} KB on the wire ` +
        `(${served.encoding}), budgets ${EMBED_BUDGET.sourceKb} / ${EMBED_BUDGET.wireKb} KB`,
    );

    // A loader an operator's server refuses to compress is a loader that costs them four
    // times what we think it does. Assert the negotiation, not just the bytes.
    expect(
      served.encoding,
      'the embed loader was served uncompressed; a third-party script on an operator homepage must not be',
    ).toBe('gzip');

    expect(
      onDisk,
      overBudget('embed.js source', onDisk, EMBED_BUDGET.sourceKb * KB),
    ).toBeLessThanOrEqual(EMBED_BUDGET.sourceKb * KB);

    expect(
      served.transferBytes,
      overBudget('embed.js on the wire', served.transferBytes, EMBED_BUDGET.wireKb * KB),
    ).toBeLessThanOrEqual(EMBED_BUDGET.wireKb * KB);

    // The loader is a single file by design: an operator pastes one script tag, and a
    // second request would be a second thing that can fail on their site.
    expect(
      served.sourceBytes,
      'the served loader should decompress to the file on disk',
    ).toBe(onDisk);
  });
});

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Load a route cold and hand back what it cost.
 *
 * The cache is disabled by the recorder, so this is always a first visit. Only requests
 * issued before the `load` event count: Next's router prefetches sibling routes once it
 * is idle, and billing those to this route would mean adding a link to the catalog could
 * fail the checkout budget.
 */
async function measureRoute(page: Page, url: string): Promise<RouteMeasurement> {
  await observePaint(page);
  const recorder = await recordResources(page, { firstPartyOrigin: WEB_URL });

  await page.goto(url, { waitUntil: 'load' });
  recorder.mark('load');
  // Read the paints only after the page has stopped moving, so CLS covers a stated
  // window rather than whatever happened to have settled when the assertion ran.
  await settle(page);

  return { tally: recorder.until('load'), paint: await readPaint(page) };
}

interface RouteMeasurement {
  tally: ResourceTally;
  paint: PaintMetrics;
}

/** Assert one route against its budget, and record the measurement either way. */
function assertRoute({ tally, paint }: RouteMeasurement, budget: RouteBudget): void {
  const own = tally.firstParty();
  const js = own.bytes('js');
  const css = own.bytes('css');
  const total = own.totalBytes();
  const thirdParty = tally.thirdParty();

  record(
    `${budget.name}: ${tally.summary()} | FCP ${Math.round(paint.fcpMs)}ms, ` +
      `LCP ${Math.round(paint.lcpMs)}ms (${paint.lcpElement}), CLS ${paint.cls.toFixed(3)}`,
  );

  expect(
    js,
    overBudget(`${budget.name} first-party JavaScript`, js, budget.jsKb * KB, own.heaviest('js')),
  ).toBeLessThanOrEqual(budget.jsKb * KB);
  expect(
    css,
    overBudget(`${budget.name} CSS`, css, budget.cssKb * KB, own.heaviest('css')),
  ).toBeLessThanOrEqual(budget.cssKb * KB);
  expect(
    total,
    overBudget(`${budget.name} first-party transfer`, total, budget.totalKb * KB, own.heaviest('image')),
  ).toBeLessThanOrEqual(budget.totalKb * KB);

  expect(
    thirdParty.totalBytes(),
    overBudget(
      `${budget.name} third-party transfer`,
      thirdParty.totalBytes(),
      budget.thirdPartyKb * KB,
      (thirdParty.entries.length > 0
        ? `    Loaded from ${thirdParty.thirdPartyOrigins().join(', ')}:\n${thirdParty.heaviest('js')}\n`
        : '') +
        '    The booking funnel must work on one laptop with no account anywhere\n' +
        '    (docs/LOCAL-FIRST-BUILD.md §0), so a vendor CDN fetch on this route is a\n' +
        '    defect before it is a byte count.',
    ),
  ).toBeLessThanOrEqual(budget.thirdPartyKb * KB);

  // LCP of 0 means the observer saw nothing, which is a broken measurement rather than a
  // fast page — fail on it rather than passing a budget with no evidence behind it.
  expect(paint.lcpMs, 'no largest-contentful-paint was observed; the measurement is not valid').toBeGreaterThan(0);
  expect(
    paint.lcpMs,
    `${budget.name} largest contentful paint was ${Math.round(paint.lcpMs)}ms against a ` +
      `${budget.lcpMs}ms budget. The element was ${paint.lcpElement}.`,
  ).toBeLessThanOrEqual(budget.lcpMs);

  expect(
    paint.cls,
    `${budget.name} shifted ${paint.cls.toFixed(3)} against a ${budget.cls} budget. ` +
      'Something is being inserted or resized after first paint — usually a skeleton whose ' +
      'height does not match the real content (docs/PERFORMANCE.md §2.4).',
  ).toBeLessThanOrEqual(budget.cls);
}

/**
 * Publish a measurement.
 *
 * Both channels on purpose. The annotation is what the HTML report and the trace viewer
 * show; the stdout line is what the person running `--reporter=line` sees, and a
 * performance spec whose numbers are invisible to the person who ran it has failed at
 * its actual job — a green tick tells you nothing moved, not what the number is.
 */
function record(description: string): void {
  test.info().annotations.push({ type: 'measurement', description });
  process.stdout.write(`  perf  ${description}\n`);
}

/** Escape a rate name for use inside a RegExp. */
function escapeRx(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
