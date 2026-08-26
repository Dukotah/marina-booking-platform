/**
 * Network and CPU throttling, for the one differentiator that is measured rather than
 * claimed: booking has to take seconds on bad rural cell service
 * (docs/LOCAL-FIRST-BUILD.md §2, §6).
 *
 * Playwright has no built-in throttling, so this drives Chrome DevTools Protocol
 * directly — the same mechanism the DevTools "Slow 4G" preset uses, with the same
 * numbers. Chromium only; the mobile project pins that.
 */
import type { Page } from '@playwright/test';

export interface NetworkProfile {
  name: string;
  /** Round-trip time in ms, applied to every request. */
  latencyMs: number;
  /** Bytes per second. */
  downloadBps: number;
  uploadBps: number;
}

/**
 * DevTools' "Slow 4G" preset, to the number — the honest floor for a usable rural LTE
 * signal, and the profile the funnel budget is set against. A harsher profile is a
 * one-line addition here (Fast 3G is 562.5ms / 1.6Mbps down / 750Kbps up).
 */
export const SLOW_4G: NetworkProfile = {
  name: 'Slow 4G',
  latencyMs: 400,
  downloadBps: (400 * 1024) / 8,
  uploadBps: (400 * 1024) / 8,
};

/**
 * Throttle a page's network (and optionally its CPU) for the rest of its life.
 *
 * The CDP session is intentionally not detached: it must stay attached for the
 * emulation to hold, and Playwright tears it down with the page.
 */
export async function throttle(
  page: Page,
  profile: NetworkProfile,
  options: { cpuSlowdown?: number } = {},
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: profile.latencyMs,
    downloadThroughput: profile.downloadBps,
    uploadThroughput: profile.uploadBps,
  });
  if (options.cpuSlowdown && options.cpuSlowdown > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpuSlowdown });
  }
}

/**
 * Warm a route so a measurement is of the product, not of the dev server.
 *
 * `next dev` compiles a route the first time it is requested, which can take tens of
 * seconds and has nothing to do with how fast the page is for a guest. Every timed spec
 * warms its routes UNTHROTTLED first, then measures. This is stated plainly rather than
 * hidden, because a performance number whose method is unclear is worth nothing.
 */
export async function warmRoutes(page: Page, paths: string[]): Promise<void> {
  for (const path of paths) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  }
}
