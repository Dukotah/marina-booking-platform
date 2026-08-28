/**
 * The accessibility audit: WCAG 2.1 AA, automated, against the running stack.
 *
 * docs/ACCESSIBILITY.md described an accessibility pass. Nothing verified it — every
 * ratio in it was computed by hand and no browser was ever opened. That is a claim,
 * not a fact, and this flow takes a **legal signature** from people standing on a dock
 * holding a phone. This spec is what turns the claim into a fact, or shows where it is
 * not one.
 *
 * The bar, and why it is set here:
 *
 *   - axe-core runs with the WCAG 2.1 A/AA rule set on every surface a customer or a
 *     staff member actually touches, in the state they touch it in — a loaded date
 *     strip, a checkout that has just failed validation, a waiver with the guardian
 *     block open. A scan of a skeleton is a clean report about nothing.
 *   - `serious` and `critical` fail. `moderate` and `minor` are printed and attached.
 *     Both halves matter: the top band is the line that must not move, and the bottom
 *     band is the honest remainder, visible in the run output instead of quietly
 *     dropped so the suite can be green.
 *   - Everything axe cannot see gets an explicit assertion: focus order through the
 *     booking steps, the embed overlay's trap and focus return, visible focus
 *     indicators, errors bound to their inputs and announced, and the date strip's
 *     loading state not being a row of unnamed dead buttons.
 *
 * Findings belong to the product, not to this file. Nothing here may be relaxed to
 * make a run green; a failure names a file and a fix in docs/ACCESSIBILITY.md §3.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test as base } from '../fixtures/test';
import { WEB_URL } from '../config';
import type { BookingSelection } from '../fixtures/booking-data';
import { rx, type ActivityPage } from '../helpers/customer';
import {
  auditA11y,
  danglingDescribedBy,
  describedByText,
  focusIndicator,
  focusedDescriptor,
  settledFocus,
  tabTour,
} from '../helpers/a11y';

// ---------------------------------------------------------------------------
// A host site, for the embed overlay's focus contract
// ---------------------------------------------------------------------------

interface HostSite {
  url(params?: Record<string, string>): string;
}

const HOST_FIXTURE = path.join(__dirname, '..', 'fixtures', 'host-page.html');

type NoTestFixtures = Record<never, never>;

/**
 * The same deliberately hostile host page `embed.spec.ts` uses, served from a real
 * second origin. Focus containment is an origin-shaped problem — the widget lives in a
 * shadow root on the host and its content lives in a cross-origin iframe — so a trap
 * test that ran against a same-document mock would prove nothing about the real thing.
 */
const test = base.extend<NoTestFixtures, { hostSite: HostSite }>({
  hostSite: [
    async ({}, use) => {
      const html = (await readFile(HOST_FIXTURE, 'utf8')).replace(/__EMBED_BASE__/g, WEB_URL);
      const server: Server = createServer((req, res) => {
        if ((req.url ?? '/').startsWith('/favicon')) {
          res.writeHead(204).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      await use({
        url: (params = {}) => {
          const qs = new URLSearchParams(params).toString();
          return qs ? `${origin}/?${qs}` : `${origin}/`;
        },
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    { scope: 'worker' },
  ],
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Every control that is currently marked invalid, with the text a screen reader would
 * read as its description.
 *
 * This is the "tab back to the field and ask why" case. `aria-invalid` alone announces
 * *that* something is wrong; only a resolved `aria-describedby` announces *what*.
 */
async function invalidFieldReport(
  page: Page,
): Promise<Array<{ id: string; label: string; describedBy: string; description: string }>> {
  return page.evaluate(() => {
    const text = (node: Element | null): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('[aria-invalid="true"]')).map((el) => {
      const id = el.id || '';
      const label =
        el.getAttribute('aria-label') ??
        (id ? text(document.querySelector(`label[for="${CSS.escape(id)}"]`)) : '') ??
        '';
      const describedBy = el.getAttribute('aria-describedby') ?? '';
      const description = describedBy
        .split(/\s+/)
        .filter(Boolean)
        .map((ref) => text(document.getElementById(ref)))
        .filter(Boolean)
        .join(' ');
      return { id, label, describedBy, description };
    });
  });
}

/**
 * Drive the booking widget to a complete, fully loaded selection.
 *
 * Every choice is made, not just the ones a given assertion reads. The CTA is
 * `disabled` until rate, date and time are all set, and a disabled button is not in the
 * tab order and cannot take focus — so a widget left half-filled would silently exclude
 * the single most important control on the page from both the audit and the keyboard
 * walk. Waiting on `aria-busy` matters for the same reason: a scan of the skeleton is a
 * clean report about nothing.
 */
async function loadedBookingWidget(
  activityPage: ActivityPage,
  selection: BookingSelection,
): Promise<void> {
  await activityPage.open(selection.activity.id);
  await activityPage.chooseRate(selection.rate.name);
  await expect(activityPage.dateStrip()).toHaveAttribute('aria-busy', 'false');
  await activityPage.chooseDate(selection.slot.datetime);
  await activityPage.chooseTime(selection.slot.datetime);
  await expect(activityPage.continueButton()).toBeEnabled();
}

/** The embed URL for one activity — the document `public/embed.js` frames. */
function embedUrl(activityId: string): string {
  const url = new URL(`${WEB_URL}/embed`);
  url.searchParams.set('eid', 'a11y-audit');
  url.searchParams.set('mode', 'modal');
  url.searchParams.set('v', '1');
  url.searchParams.set('activity', activityId);
  return url.href;
}

// ---------------------------------------------------------------------------
// The customer journey
// ---------------------------------------------------------------------------

test.describe('WCAG 2.1 AA — the customer journey', () => {
  test('the catalog home page has no serious or critical violations', async ({
    page,
    catalogPage,
  }, testInfo) => {
    await catalogPage.open();
    await expect(page.getByRole('link').filter({ has: page.getByRole('heading') }).first()).toBeVisible();

    await auditA11y(page, testInfo, 'catalog home');
  });

  test('an activity page, with the date strip and time picker loaded, is clean', async ({
    page,
    seed,
    activityPage,
  }, testInfo) => {
    const selection = await seed.selection();
    await loadedBookingWidget(activityPage, selection);

    await auditA11y(page, testInfo, 'activity detail (date + time loaded)');
  });

  test('checkout is clean before submission', async ({ page, seed, checkoutPage }, testInfo) => {
    const selection = await seed.selection({ quantity: 2 });
    await checkoutPage.openDirect(selection);

    await auditA11y(page, testInfo, 'checkout (initial)');
  });

  test('checkout after an invalid submit is clean, and the failure is announced', async ({
    page,
    seed,
    checkoutPage,
  }, testInfo) => {
    const selection = await seed.selection({ quantity: 1 });
    await checkoutPage.openDirect(selection);

    // Submit an empty form. This is the state a real guest reaches constantly — a
    // mistyped email, a skipped driver name — and before this pass it was completely
    // silent to a screen reader.
    await checkoutPage.submit();

    const summary = page.getByRole('heading', { name: /problems? with your booking details/ });
    await expect(summary, 'an invalid submit must produce an error summary').toBeVisible();

    /*
     * Four independent things have to be true here, and they are asserted SOFTLY so one
     * run reports all four. A hard assertion on the first would hide the other three
     * for as long as it took anyone to fix it — an audit that reveals its findings one
     * per fix is barely an audit.
     */

    // 1. Focus moved to the summary, so the whole list is read once. Given time to
    //    land: the move happens in an effect after the summary's own commit.
    expect
      .soft(
        await settledFocus(page, /problems? with your booking details/),
        'after a failed submit focus never reached the error summary — the guest is told ' +
          'nothing about why the button did not work',
      )
      .toMatch(/problems? with your booking details/);

    // 2. Every entry in the summary points at a control that exists. An entry that
    //    renders as plain text is a problem the guest is told about and cannot reach.
    const entries = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('h2')).find((h) =>
        /problems? with your booking details/.test(h.textContent ?? ''),
      );
      const list = heading?.parentElement?.querySelector('ul');
      return Array.from(list?.querySelectorAll('li') ?? []).map((li) => {
        const anchor = li.querySelector('a');
        const href = anchor?.getAttribute('href') ?? '';
        return {
          text: (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
          href,
          resolves: href.startsWith('#') ? Boolean(document.getElementById(href.slice(1))) : false,
        };
      });
    });
    expect.soft(entries.length, 'the summary should list every problem').toBeGreaterThan(0);
    const unreachable = entries.filter((e) => !e.resolves);
    expect.soft(
      unreachable,
      `the error summary lists ${unreachable.length} problem(s) with no link to the control: ` +
        unreachable.map((e) => `"${e.text}"`).join(', '),
    ).toEqual([]);

    // 3. Each invalid control carries the reason, not just the fact. This is 3.3.1
    //    for the guest who tabs back into the form instead of using the summary.
    const invalid = await invalidFieldReport(page);
    expect
      .soft(invalid.length, 'an empty required form should mark its fields invalid')
      .toBeGreaterThan(0);
    const unexplained = invalid.filter((f) => f.description.length === 0);
    expect.soft(
      unexplained,
      `${unexplained.length} invalid checkout field(s) announce "invalid" with no reason — ` +
        'they need aria-describedby pointing at their error text: ' +
        unexplained.map((f) => `#${f.id || '(no id)'}`).join(', '),
    ).toEqual([]);

    // 4. Nothing points at an id that does not exist — a dangling describedby is read
    //    as nothing at all, which is indistinguishable from having none.
    expect
      .soft(await danglingDescribedBy(page), 'aria-describedby references a missing element')
      .toEqual([]);

    await auditA11y(page, testInfo, 'checkout (validation errors)');
  });

  test('the confirmation page is clean', async ({ page, seed }, testInfo) => {
    const booking = await seed.booking();
    const url = `/confirmation?order=${encodeURIComponent(booking.orderNumber)}`;

    /*
     * The confirmation page fetches the order server-side, and the API rate-limits per
     * IP on purpose (30/min). A suite running flat out against a production build can
     * trip that, and the page then correctly degrades to "Booking temporarily
     * unavailable" — a real screen, but not the one this test is about. So the load is
     * retried the same way `fixtures/api.ts` retries a 429: behave like a well-mannered
     * client rather than asking for the protection to be relaxed. A page that is
     * genuinely broken still fails, with the heading it actually rendered.
     */
    await expect(async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(/You're all set!/, {
        timeout: 5_000,
      });
    }).toPass({ timeout: 60_000, intervals: [2_000, 4_000, 8_000] });

    await auditA11y(page, testInfo, 'confirmation');
  });
});

// ---------------------------------------------------------------------------
// The waiver — the legal one
// ---------------------------------------------------------------------------

test.describe('WCAG 2.1 AA — the waiver signer', () => {
  test('every state of the waiver is clean and comprehensible without sight', async ({
    page,
    seed,
  }, testInfo) => {
    const booking = await seed.booking({ requireWaiver: true });
    const orderItemId = booking.order.items[0]?.id;
    expect(orderItemId, 'the seeded booking should have a line item to sign against').toBeTruthy();

    await page.goto(`/waiver/${encodeURIComponent(orderItemId as string)}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByRole('button', { name: 'Sign waiver' })).toBeVisible();

    // --- The loaded form -----------------------------------------------------
    await auditA11y(page, testInfo, 'waiver (loaded)');

    // Per-clause initials. A dozen boxes all called "Initials" is the specific
    // liability problem this screen has: a signer cannot tell which legal clause they
    // are acknowledging. Each name must carry its clause.
    const initials = page.locator('input[id^="initials-"]');
    const boxCount = await initials.count();
    expect(boxCount, 'a clause-level waiver should render initials boxes').toBeGreaterThan(1);

    const named = await page.evaluate(() => {
      const text = (node: Element | null): string =>
        (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll<HTMLInputElement>('input[id^="initials-"]')).map(
        (el) => {
          const clauseId = el.id.replace(/^initials-/, '');
          const heading = document.getElementById(`clause-title-${clauseId}`);
          const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
          const accessibleName =
            ids.length > 0
              ? ids.map((id) => text(document.getElementById(id))).filter(Boolean).join(' ')
              : (el.getAttribute('aria-label') ?? '');
          return {
            id: el.id,
            clause: text(heading),
            accessibleName,
            required: el.getAttribute('aria-required') === 'true',
          };
        },
      );
    });

    // "Initials" twelve times over is indistinguishable out of context, and each of
    // these is a separate legal acknowledgment. The name has to carry its clause.
    const contextless = named.filter(
      (box) => !box.clause || !box.accessibleName.includes(box.clause),
    );
    expect(
      contextless,
      `${contextless.length} initials box(es) are not named with the clause they acknowledge — a ` +
        'signer using a screen reader cannot tell which acknowledgment they are giving: ' +
        JSON.stringify(contextless),
    ).toEqual([]);
    expect(
      new Set(named.map((b) => b.accessibleName)).size,
      'two initials boxes share one accessible name',
    ).toBe(named.length);

    // --- The blocked submit --------------------------------------------------
    await page.getByRole('button', { name: 'Sign waiver' }).click();
    const summary = page.getByRole('heading', {
      name: /(One thing is|things are) still needed before you can sign/,
    });
    await expect(summary, 'a blocked signature must say what is missing').toBeVisible();

    await expect
      .poll(
        async () => {
          const at = await focusedDescriptor(page);
          return `<${at.tag}> ${at.name}`;
        },
        {
          message:
            'a blocked signature never moved focus to the summary; the signer is given no reason ' +
            'the button did nothing',
        },
      )
      .toMatch(/still needed before you can sign/);

    const unmet = await invalidFieldReport(page);
    const silent = unmet.filter((f) => f.description.length === 0);
    expect(
      silent,
      `${silent.length} unmet waiver field(s) announce "invalid" with no reason: ` +
        silent.map((f) => `#${f.id || '(no id)'}`).join(', '),
    ).toEqual([]);

    await auditA11y(page, testInfo, 'waiver (unmet requirements)');

    // --- The minor / guardian path -------------------------------------------
    // A date of birth under 18 makes a brand new field required. It appears inside a
    // live region that was present from first render, which is the only way an
    // insertion gets announced.
    const dobIso = new Date(Date.now() - 15 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await page.getByLabel('Date of birth').fill(dobIso);

    const guardian = page.locator('#guardianName');
    await expect(guardian, 'a DOB under 18 must reveal the guardian field').toBeVisible();

    const liveRegion = await guardian.evaluate((el) => {
      const region = el.closest('[aria-live]');
      return { live: region?.getAttribute('aria-live') ?? '', hadRegion: Boolean(region) };
    });
    expect(
      liveRegion.hadRegion && liveRegion.live === 'polite',
      'the guardian field appeared outside a polite live region, so it is added silently',
    ).toBe(true);

    expect(await guardian.getAttribute('aria-required')).toBe('true');
    expect(
      await describedByText(guardian),
      'the guardian field must explain what signing as a guardian means',
    ).toMatch(/parent or legal guardian/i);

    await auditA11y(page, testInfo, 'waiver (minor / guardian)');

    // --- Signing it ----------------------------------------------------------
    for (let i = 0; i < boxCount; i++) await initials.nth(i).fill('AB');
    await page.getByLabel(/Signature/).fill(booking.guest.fullName);
    await page.locator('#guardianName').fill(`Guardian ${booking.guest.lastName}`);
    await page.getByRole('button', { name: 'Sign waiver' }).click();

    const done = page.getByText(/your waiver has been signed and recorded/);
    await expect(done, 'the signature should have been recorded').toBeVisible({ timeout: 30_000 });

    // The form is replaced wholesale. Without a focus move the signer is silently
    // dropped to <body> with no confirmation that a legal document was executed.
    await expect
      .poll(
        async () => {
          const at = await focusedDescriptor(page);
          return `<${at.tag}> ${at.name}`;
        },
        { message: 'after signing, focus never moved — the signer is not told the waiver was recorded' },
      )
      .toMatch(/signed and recorded/);

    await auditA11y(page, testInfo, 'waiver (signed confirmation)');
  });
});

// ---------------------------------------------------------------------------
// The embed, at phone size
// ---------------------------------------------------------------------------

test.describe('WCAG 2.1 AA — the booking widget in the embed at 360px', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('the framed booking flow is clean at 360px', async ({
    page,
    seed,
    activityPage,
  }, testInfo) => {
    const selection = await seed.selection();

    // The framed document itself, not the host page around it. Auditing through the
    // host would mix `fixtures/host-page.html`'s deliberately awful markup into the
    // result — that fixture exists to be hostile, and its violations are not ours.
    // This is byte-for-byte the document `public/embed.js` puts in the iframe.
    await page.goto(embedUrl(selection.activity.id), { waitUntil: 'domcontentloaded' });

    await expect(activityPage.rateGroup()).toBeVisible();
    await activityPage.chooseRate(selection.rate.name);
    await expect(activityPage.dateStrip()).toHaveAttribute('aria-busy', 'false');
    await activityPage.chooseDate(selection.slot.datetime);
    await activityPage.chooseTime(selection.slot.datetime);
    await expect(activityPage.continueButton()).toBeEnabled();

    await auditA11y(page, testInfo, 'embed booking widget @360px');
  });

  test('the date strip is never an unlabelled dead control while it is loading', async ({
    page,
    seed,
    activityPage,
  }) => {
    const selection = await seed.selection();

    /*
     * The embed, not /activities/[id], and that is not a shortcut.
     *
     * The portal page seeds the strip from the server (`loadStripRange` → the
     * calendar's `initialRange`), so its days are already answered on first paint and
     * there is no client-side loading state left to test. The embedded widget renders
     * the very same `BookingWidget` with no seed, so its strip genuinely starts empty
     * and fills in over the network — which is also the slower, worse-connected case
     * this product is built for. Holding the range request open makes that state
     * something a test can stand in rather than a frame that flickers past.
     */
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/availability/range*', async (route) => {
      await held;
      await route.continue();
    });

    await page.goto(embedUrl(selection.activity.id), { waitUntil: 'domcontentloaded' });

    const strip = activityPage.dateStrip();
    await expect(strip).toBeVisible();
    await expect(strip, 'the strip must say it is busy while the range request is open').toHaveAttribute(
      'aria-busy',
      'true',
    );

    // Every placeholder day still has to answer "what are you?". A pulsing box with no
    // name is a control a screen-reader user is told nothing about — and the strip is
    // the first thing in the booking.
    const loadingDays = await strip.getByRole('radio').evaluateAll((els) =>
      els.map((el) => ({
        name: (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim(),
        disabled: (el as HTMLButtonElement).disabled,
      })),
    );
    expect(loadingDays.length, 'the strip should render its placeholder days').toBeGreaterThan(0);
    const nameless = loadingDays.filter((d) => !/checking availability/i.test(d.name));
    expect(
      nameless,
      `${nameless.length} day button(s) in the loading strip do not announce that availability is ` +
        `still being checked: ${JSON.stringify(nameless.slice(0, 5))}`,
    ).toEqual([]);

    release();
    await expect(strip).toHaveAttribute('aria-busy', 'false');
    await page.unroute('**/api/availability/range*');

    // The same question for the time picker, which swaps in six aria-hidden boxes while
    // it loads. Everything visible there is hidden from assistive tech on purpose, so
    // the visually-hidden line is the only thing left to announce; without it the
    // section goes completely silent at the moment the guest is waiting on it.
    await page.route('**/api/activities/*/availability*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue();
    });
    await activityPage.chooseRate(selection.rate.name);
    await activityPage.chooseDate(selection.slot.datetime);
    await expect(page.getByText('Loading available times…')).toBeAttached();
    await page.unroute('**/api/activities/*/availability*');
    await expect(activityPage.timeGroup().getByRole('radio').first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// The operator console
// ---------------------------------------------------------------------------

test.describe('WCAG 2.1 AA — the operator console', () => {
  test('the day manifest is clean', async ({ page, seed, admin }, testInfo) => {
    const booking = await seed.booking();
    await admin.openManifest(booking.selection.slot.datetime);
    await expect(page.getByRole('heading', { level: 1, name: 'Manifest' })).toBeVisible();

    await auditA11y(page, testInfo, 'admin manifest');
  });

  test('an order detail page is clean', async ({ page, seed, admin }, testInfo) => {
    const booking = await seed.booking();
    await admin.openOrder(booking.orderNumber);

    await auditA11y(page, testInfo, 'admin order detail');
  });
});

// ---------------------------------------------------------------------------
// What axe cannot see
// ---------------------------------------------------------------------------

test.describe('beyond axe — keyboard, focus and announcements', () => {
  test('tabbing through the booking widget follows the order on screen', async ({
    page,
    seed,
    activityPage,
  }) => {
    const selection = await seed.selection();
    await loadedBookingWidget(activityPage, selection);

    // Start on the first rate, then walk forward. The requirement is not "every control
    // is reachable" — it is that the tab order matches the visual order, so a keyboard
    // user's mental model of the widget survives contact with it. Rate, then date, then
    // time, then party size, then the CTA.
    const zones = ['Choose a rate', 'Choose a date', 'Choose a time'];
    await activityPage.rateGroup().getByRole('radio').first().focus();

    const stops = await tabTour(page, 120);
    const seen: string[] = [];
    let reachedCta = false;
    for (const stop of stops) {
      if (/Continue to checkout/.test(stop.name)) {
        reachedCta = true;
        break;
      }
      const zone = zones.find((z) => stop.group === z);
      if (zone && seen[seen.length - 1] !== zone) seen.push(zone);
    }

    /** The walk itself, so a failure says where Tab actually went. */
    const trail = stops
      .slice(0, 40)
      .map((s, i) => `${i + 1}. [${s.group || '—'}] <${s.tag}> ${s.name.slice(0, 40)}`)
      .join('\n      ');

    expect(
      reachedCta,
      'Tab never reached "Continue to checkout" within 120 stops — the CTA is unreachable by ' +
        'keyboard, or the widget has more tab stops than a keyboard user could plausibly walk.\n' +
        `      ${trail}`,
    ).toBe(true);

    // Each group must be entered once, in screen order — re-entering a group means the
    // DOM order and the visual order disagree.
    expect(
      seen,
      `the tab order through the booking widget was ${JSON.stringify(seen)}; it should walk the ` +
        'rate, date and time groups once each, in that order',
    ).toEqual(zones);
  });


  test('the embed overlay traps focus and gives it back on close', async ({ page, hostSite }) => {
    await page.goto(hostSite.url({ mode: 'button' }), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() =>
      Boolean((window as unknown as { MarinaBooking?: { version?: string } }).MarinaBooking?.version),
    );

    const launcher = page.getByRole('button', { name: 'Book now' });
    await launcher.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForFunction(() =>
      (window as unknown as { __marinaEvents: Array<{ type: string }> }).__marinaEvents.some(
        (e) => e.type === 'ready',
      ),
    );

    /** Is the current activeElement inside the widget's shadow host? */
    const inWidget = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return Boolean(el?.hasAttribute?.('data-marina-embed'));
      });

    await expect.poll(inWidget, { message: 'the overlay never took focus' }).toBe(true);

    // Backwards off the first stop is the hole a naive trap leaves: Shift+Tab from the
    // close button walks onto the host page behind the modal, where nothing is visible
    // and nothing can be dismissed.
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('Shift+Tab');
      const where = await focusedDescriptor(page);
      expect(
        await inWidget(),
        `Shift+Tab #${i + 1} escaped the overlay onto the host page (<${where.tag}> "${where.name}")`,
      ).toBe(true);
    }

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const where = await focusedDescriptor(page);
      expect(
        await inWidget(),
        `Tab #${i + 1} escaped the overlay onto the host page (<${where.tag}> "${where.name}")`,
      ).toBe(true);
    }

    // Closing must hand focus back to what opened it, or a keyboard user restarts from
    // the top of the operator's website.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      launcher,
      'closing the overlay did not return focus to the launcher that opened it',
    ).toBeFocused();
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  });

  test('the controls in the funnel have a focus indicator you can see', async ({
    page,
    seed,
    checkoutPage,
    activityPage,
  }) => {
    const selection = await seed.selection();

    // The brand colour is operator-supplied, and the global :focus-visible outline is
    // that same colour — so a brand-filled control can ring in a colour indistinguishable
    // from its own background. These are the controls where losing the ring loses the
    // booking.
    await loadedBookingWidget(activityPage, selection);

    const widgetControls: Array<[string, Locator]> = [
      ['a rate option', activityPage.rateGroup().getByRole('radio').first()],
      ['a day in the date strip', activityPage.dateStrip().getByRole('radio', { name: /spots? left/ }).first()],
      // `:not([disabled])` because a sold-out chip is deliberately unfocusable; the
      // question here is whether a chip a guest CAN pick shows a ring.
      ['a time chip', activityPage.timeGroup().locator('button:not([disabled])').first()],
      ['Continue to checkout', activityPage.continueButton()],
    ];

    const invisible: string[] = [];
    for (const [label, locator] of widgetControls) {
      const indicator = await focusIndicator(page, locator);
      if (!indicator.visible) {
        invisible.push(
          `${label} (:focus-visible ${indicator.focusVisible}, outline ${indicator.outlineWidthPx}px ` +
            `${indicator.outlineStyle} ${indicator.outlineColor}, box-shadow ${indicator.boxShadow})`,
        );
      }
    }

    await checkoutPage.openDirect(selection);
    const checkoutControls: Array<[string, Locator]> = [
      ['the first name field', page.locator('#firstName')],
      ['Complete booking', checkoutPage.submitButton()],
    ];
    for (const [label, locator] of checkoutControls) {
      const indicator = await focusIndicator(page, locator);
      if (!indicator.visible) {
        invisible.push(
          `${label} (:focus-visible ${indicator.focusVisible}, outline ${indicator.outlineWidthPx}px ` +
            `${indicator.outlineStyle} ${indicator.outlineColor}, box-shadow ${indicator.boxShadow})`,
        );
      }
    }

    expect(
      invisible,
      `${invisible.length} control(s) show no focus indicator at all when focused by keyboard: ` +
        invisible.join('; '),
    ).toEqual([]);
  });

  test('the skip link points at something', async ({ page, catalogPage }) => {
    // 2.4.1. Every customer page renders `<a href="#main-content">` as its first
    // focusable element. A skip link whose target does not exist is worse than none:
    // it consumes the first tab stop of every page and then does nothing.
    await catalogPage.open();

    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip, 'every customer page should render a skip link').toBeAttached();

    const target = await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll('a')).find(
        (a) => (a.textContent ?? '').trim() === 'Skip to main content',
      );
      const href = link?.getAttribute('href') ?? '';
      const id = href.startsWith('#') ? href.slice(1) : '';
      const el = id ? document.getElementById(id) : null;
      return {
        href,
        exists: Boolean(el),
        tag: el?.tagName ?? '',
        focusable: el?.hasAttribute('tabindex') ?? false,
      };
    });

    // Soft, so one run reports all three facts about the same link instead of stopping
    // at the first. Every one of them is still a failure.
    expect.soft(target.href, 'the skip link should target an in-page anchor').toBe('#main-content');
    expect.soft(
      target.exists,
      'the skip link targets #main-content but no element on the page has that id — every ' +
        'customer page needs id="main-content" (and tabIndex={-1}) on its <main>. ' +
        'See docs/ACCESSIBILITY.md §3.3, finding I',
    ).toBe(true);
    expect.soft(
      target.focusable,
      `#main-content is a <${target.tag || 'missing element'}> with no tabindex, so activating the ` +
        'skip link scrolls but does not move focus — the next Tab returns to the nav the link ' +
        'was meant to bypass',
    ).toBe(true);

    // And whether it actually works: the first Tab must reach it, and Enter must land
    // focus on the main content.
    await page.keyboard.press('Tab');
    await expect
      .soft(skip, 'the skip link must be the first stop in the tab order to be any use')
      .toBeFocused();
    await page.keyboard.press('Enter');
    const landed = await focusedDescriptor(page);
    expect.soft(
      landed.tag,
      `activating the skip link left focus on <${landed.tag}>, not on the page's <main> — the ` +
        'bypass is inert',
    ).toBe('MAIN');
  });

  test('a guest can complete checkout with the keyboard alone', async ({
    page,
    seed,
    checkoutPage,
  }) => {
    const selection = await seed.selection({ quantity: 1 });
    const guest = seed.guest('a11y-kbd');
    await checkoutPage.openDirect(selection);

    // No clicks. Tab to each field and type — the failure this catches is a control
    // that only responds to a pointer, which no amount of ARIA makes operable.
    await page.locator('#firstName').focus();
    await page.keyboard.type(guest.firstName);
    await page.keyboard.press('Tab');
    await page.keyboard.type(guest.lastName);
    await page.keyboard.press('Tab');
    await page.keyboard.type(guest.email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(guest.phone);

    expect(
      {
        firstName: await page.locator('#firstName').inputValue(),
        lastName: await page.locator('#lastName').inputValue(),
        email: await page.locator('#email').inputValue(),
        phone: await page.locator('#phone').inputValue(),
      },
      'tabbing between the guest fields did not land in the order they are read in',
    ).toEqual({
      firstName: guest.firstName,
      lastName: guest.lastName,
      email: guest.email,
      phone: guest.phone,
    });

    await checkoutPage.fillDrivers(guest, selection.quantity);
    await checkoutPage.signWaiver(guest);

    // The submit button has to be operable from the keyboard, and its busy state has to
    // be announced rather than just spinning.
    await checkoutPage.submitButton().focus();
    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('status').filter({ hasText: /Processing your booking/ }),
      'submitting must announce that something is happening — the wait is several seconds on ' +
        'rural cell service and a silent button reads as broken',
    ).toBeAttached({ timeout: 15_000 });

    await page.waitForURL(/\/confirmation\?/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      new RegExp(rx("You're all set!")),
    );
  });
});

