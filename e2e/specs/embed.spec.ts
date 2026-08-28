/**
 * The embeddable booking widget, on somebody else's website.
 *
 * This is the only spec that loads `public/embed.js` the way an operator does: a
 * cross-origin `<script>` tag on a page we do not control, with its own reset, its
 * own tag selectors, its own fixed furniture at int32-max z-index, its own globals
 * and its own broken third-party listener. `e2e/fixtures/host-page.html` is that
 * page, and every rule in it is something a real marina site actually does.
 *
 * Why a real HTTP server and not `page.route()` or a file:// URL.
 *   The widget's two hardest problems are both origin-shaped: postMessage has to
 *   cross from `http://127.0.0.1:<port>` into `http://localhost:3000` and back, and
 *   the loader has to pin `event.origin` on the way in. A `file://` host has the
 *   opaque "null" origin, which makes those checks pass or fail for the wrong
 *   reason. `page.route()` would work, but it fulfils requests inside the browser
 *   and leaves the host with no server of its own — no real port, and a fulfilled
 *   navigation is easy to get subtly wrong (content type, caching, sub-resources).
 *   A ten-line `node:http` server on an ephemeral port is less machinery and is
 *   exactly what the operator has: a different host, a different port, a genuine
 *   third-party context. `127.0.0.1` and `localhost` are distinct origins to the
 *   browser even though they are the same machine, which is the property we need.
 *
 * What this spec does NOT do: walk checkout. `booking-funnel.spec.ts` owns that
 * journey. Here the completed booking is created through the API and the frame is
 * pointed at the confirmation step, so a regression in the calendar cannot fail the
 * `booking-completed` contract — the contract is what this spec is about.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { expect, test as base } from '../fixtures/test';
import { WEB_URL } from '../config';

// ---------------------------------------------------------------------------
// The host site
// ---------------------------------------------------------------------------

interface HostSite {
  origin: string;
  /** URL of the fixture with widget attributes supplied as query params. */
  url(params?: Record<string, string>): string;
}

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'host-page.html');

/** This spec adds no test-scoped fixtures, only the worker-scoped host site. */
type NoTestFixtures = Record<never, never>;

const test = base.extend<NoTestFixtures, { hostSite: HostSite }>({
  hostSite: [
    async ({}, use) => {
      const html = (await readFile(FIXTURE, 'utf8')).replace(/__EMBED_BASE__/g, WEB_URL);

      const server: Server = createServer((req, res) => {
        // The fixture is the whole site; a favicon request must not 500 the page.
        if ((req.url ?? '/').startsWith('/favicon')) {
          res.writeHead(204).end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(html);
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;

      await use({
        origin,
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
// Helpers
// ---------------------------------------------------------------------------

/** Load the host page and wait until the loader has published its global. */
async function openHost(
  page: Page,
  site: HostSite,
  params: Record<string, string> = {},
): Promise<void> {
  await page.goto(site.url(params), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as never as HostWindow).MarinaBooking?.version));
}

interface HostWindow {
  MarinaBooking?: {
    version?: string;
    widgets: Array<{ id: string }>;
    open: (options?: Record<string, unknown>) => unknown;
  };
  __marinaEvents: Array<{ type: string; detail: Record<string, unknown> }>;
  __marinaApiEvents?: Array<Record<string, unknown>>;
  __hostLegacyOpenCalled?: boolean;
  dataLayer: Array<Record<string, unknown>>;
}

/** Every `marina:*` event the host page has seen so far, in order. */
function hostEvents(page: Page) {
  return page.evaluate(() => (window as never as HostWindow).__marinaEvents.slice());
}

/** The booking flow's frame. Fails loudly rather than returning undefined. */
function embedFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().includes('/embed'));
  expect(frame, 'the widget should have framed the /embed route').toBeTruthy();
  return frame as Frame;
}

/** Wait for the frame to exist and to have told the host it is ready. */
async function waitForReady(page: Page): Promise<Frame> {
  await page.waitForFunction(() =>
    (window as never as HostWindow).__marinaEvents.some((e) => e.type === 'ready'),
  );
  return embedFrame(page);
}

/**
 * Read something out of the widget's shadow DOM.
 *
 * There is more than one shadow host on the page: the launcher gets one, and the
 * modal gets its OWN attached to <body> (so a host ancestor with a transform cannot
 * become the containing block for the fixed overlay). So this searches every host,
 * not `querySelector('[data-marina-embed]')` — which finds the launcher's and then
 * reports the dialog as missing.
 */
function shadowBox(page: Page, selector: string) {
  return page.evaluate((sel) => {
    for (const host of Array.from(document.querySelectorAll('[data-marina-embed]'))) {
      const el = (host as HTMLElement).shadowRoot?.querySelector(sel) as HTMLElement | null;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        radius: cs.borderTopLeftRadius,
        border: cs.borderTopWidth,
        scrolling: el.getAttribute('scrolling'),
      };
    }
    return null;
  }, selector);
}

/** `document.activeElement` at the top level; inside a shadow root this is the host. */
function activeElementSummary(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName ?? 'NONE',
      id: el?.id ?? '',
      inWidget: Boolean(el?.hasAttribute('data-marina-embed')),
    };
  });
}

/**
 * Computed styles of the host page's own furniture — the diff that proves the
 * widget did not bleed onto its host.
 */
function hostStyleSnapshot(page: Page) {
  return page.evaluate(() => {
    const read = (selector: string, props: string[]) => {
      const el = document.querySelector(selector);
      if (!el) return { missing: selector };
      const cs = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const prop of props) out[prop] = cs.getPropertyValue(prop);
      return out;
    };
    return {
      body: read('body', ['font-family', 'letter-spacing', 'overflow', 'background-color', 'margin-top']),
      html: read('html', ['overflow', 'overflow-x']),
      header: read('#site-header', ['position', 'z-index', 'background-color', 'top']),
      decoy: read('#marina-embed', ['border-top-width', 'border-top-style', 'display', 'padding-top']),
      hours: read('#booking', ['border-left-width', 'background-color']),
      cookie: read('#site-cookie', ['position', 'z-index']),
      // A shadow-root widget must never add a stylesheet to the host's <head>.
      headStyles: document.head.querySelectorAll('style, link[rel="stylesheet"]').length,
      scrollY: Math.round(window.scrollY),
    };
  });
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

test.describe('embeddable widget on a hostile host page', () => {
  test('the launcher renders and the host page cannot restyle it', async ({ page, hostSite }) => {
    await openHost(page, hostSite, { mode: 'button', label: 'Reserve a boat', color: '#0369a1' });

    const launcher = page.getByRole('button', { name: 'Reserve a boat' });
    await expect(launcher).toBeVisible();

    // The one global we add is ours, not the stale plugin object the page left in
    // its place — and taking the name over must not have called the old one.
    expect(await page.evaluate(() => (window as never as HostWindow).MarinaBooking?.version)).toBe(
      '1.1.0',
    );
    expect(
      await page.evaluate(() => (window as never as HostWindow).__hostLegacyOpenCalled ?? false),
      'taking over the MarinaBooking global must not invoke whatever was there before',
    ).toBe(false);

    // The host's `button { … !important }` rule is the single most common way an
    // embedded launcher ends up looking like a ransom note. It must not reach in.
    const styles = await launcher.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        background: cs.backgroundColor,
        color: cs.color,
        textTransform: cs.textTransform,
        letterSpacing: cs.letterSpacing,
        borderRadius: cs.borderTopLeftRadius,
        borderWidth: cs.borderTopWidth,
        cursor: cs.cursor,
        fontFamily: cs.fontFamily,
        fontStyle: cs.fontStyle,
        paddingLeft: cs.paddingLeft,
      };
    });

    expect(styles.background, 'data-color should paint the launcher').toBe('rgb(3, 105, 161)');
    expect(styles.color).toBe('rgb(255, 255, 255)');
    expect(styles.textTransform, "the host's uppercase rule leaked in").toBe('none');
    expect(styles.letterSpacing).not.toBe('normal');
    expect(parseFloat(styles.letterSpacing)).toBeLessThan(2);
    expect(styles.borderRadius).toBe('10px');
    expect(styles.borderWidth).toBe('0px');
    expect(styles.cursor).toBe('pointer');
    expect(styles.fontStyle, "the host's italic div rule leaked in").toBe('normal');
    expect(styles.fontFamily.toLowerCase()).not.toContain('comic');
    expect(styles.paddingLeft).toBe('22px');
  });

  test('the overlay opens above the host page and frames the booking flow', async ({
    page,
    hostSite,
  }) => {
    await openHost(page, hostSite, { mode: 'button' });
    await page.getByRole('button', { name: 'Book now' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const frame = await waitForReady(page);
    expect(new URL(frame.url()).pathname).toBe('/embed');

    // The real flow, not a shell: the catalog step with live availability.
    await expect(frame.getByRole('heading', { level: 1 })).toContainText(/Book with/);

    // Exactly one way to close. The loader paints its own close button over the top
    // of the frame, so a second one inside the frame is two controls with the same
    // accessible name in the same 40px square — invisible on screen, duplicated for
    // anyone using a keyboard or a screen reader.
    await expect(
      frame.getByRole('button', { name: 'Close booking' }),
      'the frame must not draw its own close button under the loader\'s',
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Close booking' })).toHaveCount(1);

    // The host's `iframe { … !important }` rule sits outside the shadow root and
    // must not have resized or bordered our frame.
    const frameBox = await shadowBox(page, '.mbw-dialog iframe');
    expect(frameBox, 'the dialog should contain the booking frame').toBeTruthy();
    expect(frameBox?.border, "the host's iframe border leaked in").toBe('0px');
    expect(frameBox?.width, "the host's 220px iframe width leaked in").toBeGreaterThan(400);
    expect(frameBox?.height, "the host's 90px iframe height leaked in").toBeGreaterThan(300);

    // The chat bubble is at int32-max z-index and was injected AFTER we mounted.
    // A point inside it must still hit the widget while the overlay is open.
    const covered = await page.evaluate(() => {
      const chat = document.getElementById('site-chat');
      if (!chat) return { found: false, hit: '' };
      const r = chat.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        found: true,
        hit: el ? `${el.tagName}#${el.id}` : 'none',
        isWidget: Boolean(el && (el as HTMLElement).hasAttribute('data-marina-embed')),
      };
    });
    expect(covered.found, 'the fixture should have injected the chat bubble').toBe(true);
    expect(
      covered.isWidget,
      `the host's z-index 2147483647 chat bubble is painting over the booking dialog (hit ${covered.hit})`,
    ).toBe(true);
  });

  test('the resize message sizes the dialog, and nothing is clipped or unreachable', async ({
    page,
    hostSite,
  }) => {
    await openHost(page, hostSite, { mode: 'button' });
    await page.getByRole('button', { name: 'Book now' }).click();
    const frame = await waitForReady(page);
    await expect(frame.getByRole('heading', { level: 1 })).toBeVisible();

    // The host page has to have been told a height; that message is the only way
    // a cross-origin parent can know how tall we are.
    await page.waitForFunction(() =>
      (window as never as HostWindow).__marinaEvents.some(
        (e) => e.type === 'resize' && Number(e.detail.height) > 100,
      ),
    );

    const reported = (await hostEvents(page))
      .filter((e) => e.type === 'resize')
      .map((e) => Number(e.detail.height))
      .pop() as number;

    // The dialog is capped at 92vh; below that cap it should be exactly as tall as
    // the content it was told about.
    const dialogBox = await shadowBox(page, '.mbw-dialog');
    const iframeBox = await shadowBox(page, '.mbw-dialog iframe');
    const cap = await page.evaluate(() => Math.round(window.innerHeight * 0.92));
    expect(dialogBox, 'the dialog should be on screen').toBeTruthy();

    const expected = Math.min(reported, cap);
    expect(
      Math.abs((dialogBox?.height ?? -1) - expected),
      `the dialog is ${dialogBox?.height}px but the frame reported ${reported}px (cap ${cap}px)`,
    ).toBeLessThanOrEqual(2);

    // Now the part that actually matters to a customer: can they reach the bottom
    // of the flow? Either the content fits the frame, or the frame scrolls. A
    // `scrolling="no"` iframe with content taller than its box is a dead end.
    const inner = await frame.evaluate(() => {
      const doc = document.documentElement;
      const before = doc.scrollTop;
      doc.scrollTop = doc.scrollHeight;
      const after = doc.scrollTop;
      doc.scrollTop = before;
      return {
        scrollHeight: doc.scrollHeight,
        clientHeight: doc.clientHeight,
        scrolled: after > before,
        overflowY: getComputedStyle(doc).overflowY,
      };
    });

    if (inner.scrollHeight > inner.clientHeight + 2) {
      expect(
        inner.scrolled,
        `the flow is ${inner.scrollHeight}px inside a ${inner.clientHeight}px frame and cannot be ` +
          `scrolled (scrolling="${iframeBox?.scrolling}", overflow-y ${inner.overflowY}) — the ` +
          'bottom of the booking is unreachable',
      ).toBe(true);
    } else {
      // It fits, so it must not have its own scrollbar either.
      expect(inner.scrollHeight).toBeLessThanOrEqual(inner.clientHeight + 2);
    }
  });

  test('focus is trapped in the dialog while it is open', async ({ page, hostSite }) => {
    await openHost(page, hostSite, { mode: 'button' });
    await page.getByRole('button', { name: 'Book now' }).click();
    await waitForReady(page);

    // Focus starts on the close button, which retargets to the shadow host.
    await expect
      .poll(async () => (await activeElementSummary(page)).inWidget)
      .toBe(true);

    // Backwards off the first stop is the escape route a naive trap leaves open.
    await page.keyboard.press('Shift+Tab');
    let where = await activeElementSummary(page);
    expect(
      where.inWidget,
      `Shift+Tab from the close button escaped the dialog onto the host page (${where.tag}#${where.id})`,
    ).toBe(true);

    await page.keyboard.press('Shift+Tab');
    where = await activeElementSummary(page);
    expect(where.inWidget, 'a second Shift+Tab escaped the dialog').toBe(true);

    // And forwards, all the way round the cycle.
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press('Tab');
      where = await activeElementSummary(page);
      expect(
        where.inWidget,
        `Tab #${i + 1} escaped the dialog onto the host page (${where.tag}#${where.id})`,
      ).toBe(true);
    }
  });

  test('Escape closes the widget and returns focus to the launcher', async ({ page, hostSite }) => {
    await openHost(page, hostSite, { mode: 'button' });
    const launcher = page.getByRole('button', { name: 'Book now' });
    await launcher.click();
    await waitForReady(page);
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
    await expect(launcher).toBeFocused();

    const events = await hostEvents(page);
    const close = events.filter((e) => e.type === 'close').pop();
    expect(close, 'a close event should have been published').toBeTruthy();
    expect(close?.detail.reason).toBe('escape');
  });

  test('the host page keeps its own styles, its scroll position and its scrolling', async ({
    page,
    hostSite,
  }) => {
    // Baseline: the same page with no widget on it at all.
    await page.goto(hostSite.url({ widget: 'off' }), { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => window.scrollTo(0, 0));
    const baseline = await hostStyleSnapshot(page);

    await openHost(page, hostSite, { mode: 'button' });
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(300);
    const scrollBefore = await page.evaluate(() => Math.round(window.scrollY));

    await page.getByRole('button', { name: 'Book now' }).click();
    await waitForReady(page);

    // The background must not scroll behind the modal. `html { overflow-x: hidden }`
    // on the host stops body-overflow propagating to the viewport, so locking the
    // body alone is not a lock at all.
    await page.mouse.move(200, 300);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(() => Math.round(window.scrollY)),
      'the host page scrolled behind the open modal',
    ).toBe(scrollBefore);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Everything we touched must be handed back exactly as we found it.
    const after = await hostStyleSnapshot(page);
    expect(after.body).toEqual(baseline.body);
    expect(after.html).toEqual(baseline.html);
    expect(after.header).toEqual(baseline.header);
    expect(after.decoy, 'the host element that already used id #marina-embed changed').toEqual(
      baseline.decoy,
    );
    expect(after.hours).toEqual(baseline.hours);
    expect(after.cookie).toEqual(baseline.cookie);
    expect(after.headStyles, 'the widget injected a stylesheet into the host page').toBe(
      baseline.headStyles,
    );
    expect(after.scrollY, 'the scroll position was not restored after closing').toBe(scrollBefore);

    const inlineStyles = await page.evaluate(() => ({
      body: document.body.getAttribute('style') ?? '',
      html: document.documentElement.getAttribute('style') ?? '',
    }));
    expect(inlineStyles.body.replace(/\s/g, ''), 'a scroll lock was left on <body>').toBe('');
    expect(inlineStyles.html.replace(/\s/g, ''), 'a scroll lock was left on <html>').toBe('');

    // And the page scrolls again.
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() => page.evaluate(() => Math.round(window.scrollY)))
      .toBeGreaterThan(scrollBefore);
  });

  test('a data-activity deep link opens straight on that activity', async ({
    page,
    hostSite,
    seed,
  }) => {
    const selection = await seed.selection();

    await openHost(page, hostSite, { mode: 'button', activity: selection.activity.id });
    await page.getByRole('button', { name: 'Book now' }).click();
    const frame = await waitForReady(page);

    const url = new URL(frame.url());
    expect(url.searchParams.get('activity')).toBe(selection.activity.id);
    expect(url.searchParams.get('locked'), 'a pinned widget must lock its navigation').toBe('1');

    await expect(frame.getByRole('heading', { level: 1 })).toHaveText(selection.activity.name);
    await expect(frame.getByRole('radiogroup', { name: 'Choose a rate' })).toBeVisible();

    // Pinned means pinned: no route back to a catalog the operator did not embed.
    await expect(frame.getByRole('link', { name: 'All activities' })).toHaveCount(0);

    const step = (await hostEvents(page)).filter((e) => e.type === 'step').pop();
    expect(step?.detail.step).toBe('activity');
    expect(step?.detail.activityId).toBe(selection.activity.id);
  });

  test('a completed booking emits the event an operator can listen for', async ({
    page,
    hostSite,
    seed,
  }) => {
    const booking = await seed.booking({ quantity: 2 });

    await openHost(page, hostSite, { mode: 'button' });
    await page.getByRole('button', { name: 'Book now' }).click();
    const frame = await waitForReady(page);

    // Drive the frame to the confirmation step of the SAME widget instance — the
    // booking itself was made through the API above, because the checkout journey
    // belongs to booking-funnel.spec.ts. Everything the operator depends on still
    // runs for real: the handshake, the origin pinning, and the one-shot guard.
    const widgetId = await page.evaluate(
      () => (window as never as HostWindow).MarinaBooking?.widgets[0]?.id ?? '',
    );
    expect(widgetId).toBeTruthy();

    const confirmation = new URL(`${WEB_URL}/embed`);
    confirmation.searchParams.set('eid', widgetId);
    confirmation.searchParams.set('mode', 'modal');
    confirmation.searchParams.set('v', '1');
    confirmation.searchParams.set('step', 'confirmation');
    confirmation.searchParams.set('order', booking.orderNumber);
    await frame.goto(confirmation.href, { waitUntil: 'domcontentloaded' });

    await expect(frame.getByText(booking.orderNumber).first()).toBeVisible();

    await page.waitForFunction(() =>
      (window as never as HostWindow).__marinaEvents.some((e) => e.type === 'booking'),
    );

    const booked = (await hostEvents(page)).filter((e) => e.type === 'booking');
    expect(booked, 'booking-completed must fire exactly once per order').toHaveLength(1);

    const detail = booked[0]?.detail as Record<string, unknown>;
    expect(detail.orderNumber).toBe(booking.orderNumber);
    expect(detail.currency).toBe('USD');
    // Integer cents, and the same number the server holds.
    expect(detail.totalCents).toBe(booking.order.totalCents);
    expect(Number.isInteger(detail.totalCents)).toBe(true);
    expect(detail.guests).toBe(booking.selection.quantity);
    expect(detail.activityIds).toEqual([booking.selection.activity.id]);

    // The same payload has to reach the other two documented routes.
    const api = await page.evaluate(
      () => (window as never as HostWindow).__marinaApiEvents ?? [],
    );
    expect(api, 'MarinaBooking.on("booking") should have fired').toHaveLength(1);
    expect(api[0]?.orderNumber).toBe(booking.orderNumber);

    const pushed = await page.evaluate(() =>
      (window as never as HostWindow).dataLayer.filter(
        (row) => row && row.event === 'marina_booking_completed',
      ),
    );
    expect(pushed, 'the GTM dataLayer push documented in docs/EMBED.md is missing').toHaveLength(1);
    expect(pushed[0]?.orderNumber).toBe(booking.orderNumber);
    expect(pushed[0]?.totalCents).toBe(booking.order.totalCents);
  });

  test('inline mode grows to fit its content instead of scrolling inside a box', async ({
    page,
    hostSite,
  }) => {
    await openHost(page, hostSite, { mode: 'inline', height: '400' });
    const frame = await waitForReady(page);
    await expect(frame.getByRole('heading', { level: 1 })).toBeVisible();

    await page.waitForFunction(() =>
      (window as never as HostWindow).__marinaEvents.some(
        (e) => e.type === 'resize' && Number(e.detail.height) > 100,
      ),
    );

    const reported = (await hostEvents(page))
      .filter((e) => e.type === 'resize')
      .map((e) => Number(e.detail.height))
      .pop() as number;

    await expect
      .poll(async () => (await shadowBox(page, '.mbw-inline iframe'))?.height ?? -1)
      .toBeGreaterThan(reported - 3);

    // Inline is the mode where an inner scrollbar is unambiguously a bug: the host
    // page is supposed to do the scrolling.
    const inner = await frame.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      inner.scrollHeight,
      'the inline widget has its own vertical scrollbar; it should have grown instead',
    ).toBeLessThanOrEqual(inner.clientHeight + 2);
    expect(inner.scrollWidth, 'the inline widget overflows sideways').toBeLessThanOrEqual(
      inner.clientWidth + 2,
    );

    // It sits inside the operator's own section, and did not break out of it.
    const placed = await page.evaluate(() => {
      const host = document.querySelector('[data-marina-embed]');
      const slot = document.getElementById('widget-slot');
      return Boolean(host && slot && slot.contains(host));
    });
    expect(placed, 'the inline widget did not mount where the script tag sits').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

test.describe('embeddable widget on a 360px phone', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('the launcher and the full-screen modal both work at 360px', async ({ page, hostSite }) => {
    await openHost(page, hostSite, { mode: 'button' });

    const launcher = page.getByRole('button', { name: 'Book now' });
    await expect(launcher).toBeVisible();

    // Full width at phone size, and inside the viewport rather than over its edge.
    const button = await launcher.boundingBox();
    expect(button, 'the launcher should have a box').toBeTruthy();
    expect(Math.round(button?.width ?? 0)).toBeGreaterThan(300);
    expect((button?.x ?? -1) >= 0).toBe(true);
    expect(Math.round((button?.x ?? 0) + (button?.width ?? 0))).toBeLessThanOrEqual(360);

    await launcher.click();
    const frame = await waitForReady(page);
    await expect(frame.getByRole('heading', { level: 1 })).toBeVisible();

    // The modal takes the whole screen on a phone — no 24px gutter, no rounding.
    const dialog = await shadowBox(page, '.mbw-dialog');
    expect(dialog, 'the dialog should be on screen').toBeTruthy();
    expect(dialog?.width).toBe(360);
    expect(dialog?.height).toBe(740);
    expect(dialog?.top).toBe(0);
    expect(dialog?.left).toBe(0);
    expect(dialog?.radius).toBe('0px');

    // Nothing inside the flow may overflow sideways at 360px — a horizontal
    // scrollbar in a phone booking box loses the booking.
    const inner = await frame.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));
    expect(
      inner.scrollWidth,
      `the flow is ${inner.scrollWidth}px wide inside a ${inner.clientWidth}px phone frame`,
    ).toBeLessThanOrEqual(inner.clientWidth + 1);

    // Tall content on a short screen has to be scrollable, or the customer can
    // never reach the "continue" button.
    if (inner.scrollHeight > inner.clientHeight + 2) {
      const scrolled = await frame.evaluate(() => {
        const doc = document.documentElement;
        doc.scrollTop = doc.scrollHeight;
        return doc.scrollTop > 0;
      });
      expect(scrolled, 'the phone modal clips the flow and cannot be scrolled').toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(launcher).toBeFocused();
  });
});
