/**
 * Performance measurement primitives: bytes off the wire, and the two paint metrics
 * that decide whether a page feels broken while it loads.
 *
 * Why this exists rather than Lighthouse. The contract's bar is "Lighthouse mobile
 * performance 95+, accessibility 100" (docs/LOCAL-FIRST-BUILD.md §6), but Lighthouse is
 * not installed and §0 forbids reaching for anything that needs an account or a network
 * install. Everything Lighthouse would tell us about *this* product is already
 * obtainable from the Chrome DevTools Protocol that Playwright is holding open anyway:
 * the transfer size of every response, the largest contentful paint, and the layout
 * shift. What we lose is Lighthouse's opinion score; what we keep is the underlying
 * measurements, which are the things a budget can actually be written against.
 *
 * Two rules run through all of it:
 *
 *   - **Transfer size, never parsed size.** A guest on rural LTE pays for the bytes that
 *     cross the wire, gzipped, headers included. `_next/static/*.js` is roughly a third
 *     of its on-disk size after compression, so budgeting on file size would be
 *     budgeting on a number no guest ever experiences.
 *   - **Cold cache, or it is not a first visit.** The interesting guest is the one who
 *     has never been here. Every measurement disables the HTTP cache for its own page,
 *     so a repeat run measures the same thing as the first one.
 */
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { Page } from '@playwright/test';

/** One kibibyte. Budgets are written in KiB because that is how bundles are discussed. */
export const KB = 1024;

/** The resource classes a budget is written against. */
export type ResourceKind = 'js' | 'css' | 'document' | 'image' | 'font' | 'other';

export interface ResourceEntry {
  url: string;
  kind: ResourceKind;
  /** Bytes actually received on the wire, compressed, headers included. */
  transferBytes: number;
  /** Wall clock at which the request left the browser, for the `load` cutoff. */
  startedAt: number;
  /**
   * True when the response came from an origin other than the site under test.
   *
   * Tracked separately because the two kinds of weight are governed differently. Our
   * own bundle grows a chunk at a time and is fixed by code-splitting; a third-party
   * script arrives all at once, is not minified by us, cannot be split, and — on a
   * product whose first rule is that it runs with no account anywhere — usually should
   * not be on the page at all.
   */
  thirdParty: boolean;
}

/**
 * What one route cost to load.
 *
 * Held as a list of entries rather than a set of totals so a failure can print the
 * three files responsible instead of a number with no address.
 */
export class ResourceTally {
  constructor(readonly entries: ResourceEntry[]) {}

  /** Only what came from the site under test. */
  firstParty(): ResourceTally {
    return new ResourceTally(this.entries.filter((e) => !e.thirdParty));
  }

  /** Only what came from somewhere else. */
  thirdParty(): ResourceTally {
    return new ResourceTally(this.entries.filter((e) => e.thirdParty));
  }

  /** Distinct third-party hosts, for a failure message that names names. */
  thirdPartyOrigins(): string[] {
    return [...new Set(this.thirdParty().entries.map((e) => new URL(e.url).origin))].sort();
  }

  /** Total transfer for one class of resource, in bytes. */
  bytes(kind: ResourceKind): number {
    return this.of(kind).reduce((sum, e) => sum + e.transferBytes, 0);
  }

  /** Total transfer for the whole page, in bytes. */
  totalBytes(): number {
    return this.entries.reduce((sum, e) => sum + e.transferBytes, 0);
  }

  of(kind: ResourceKind): ResourceEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  /**
   * The heaviest responses, largest first — the line a failing budget prints.
   *
   * A budget failure that says only "412 KB > 400 KB" sends the next person to a
   * bundle analyzer; one that names `app/checkout/page-6f2a.js  188 KB` does not.
   */
  heaviest(kind: ResourceKind, count = 5): string {
    return this.of(kind)
      .sort((a, b) => b.transferBytes - a.transferBytes)
      .slice(0, count)
      .map((e) => `      ${kb(e.transferBytes).padStart(8)} KB  ${shorten(e.url)}`)
      .join('\n');
  }

  /** A one-line summary suitable for a test annotation. */
  summary(): string {
    const own = this.firstParty();
    const other = this.thirdParty();
    return (
      `JS ${kb(own.bytes('js'))} KB, CSS ${kb(own.bytes('css'))} KB, ` +
      `HTML ${kb(own.bytes('document'))} KB, images ${kb(own.bytes('image'))} KB, ` +
      `first-party total ${kb(own.totalBytes())} KB over ${own.entries.length} requests` +
      (other.entries.length > 0
        ? `; third-party ${kb(other.totalBytes())} KB from ${this.thirdPartyOrigins().join(', ')}`
        : '; no third-party requests')
    );
  }
}

/**
 * Records the transfer size of every response a page receives.
 *
 * Playwright's own `request.sizes()` would nearly do this, but it resolves per request
 * and needs the response body to have been consumed; CDP hands over `encodedDataLength`
 * on `Network.loadingFinished`, which is the browser's own count of bytes off the
 * socket. That is the number DevTools' "Transferred" column shows, and it is the one a
 * guest pays for.
 *
 * The recorder must be started BEFORE the navigation it is measuring — CDP delivers no
 * backlog, so a recorder attached after `goto` sees an empty page load.
 */
export interface ResourceRecorder {
  /** Note the current instant under a name, for use as a cutoff later. */
  mark(name: string): void;
  /** Everything the page loaded, whenever it started. */
  all(): ResourceTally;
  /**
   * Only the requests that had already been issued at `mark`.
   *
   * The cutoff that matters is `load`: Next's router prefetches other routes once it is
   * idle, and those bytes are real but they are not what the guest waited for. Budgeting
   * on them would make adding a link to the catalog fail the checkout budget.
   */
  until(mark: string): ResourceTally;
}

export async function recordResources(
  page: Page,
  options: { firstPartyOrigin: string },
): Promise<ResourceRecorder> {
  const firstPartyOrigin = new URL(options.firstPartyOrigin).origin;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  // A first visit is the whole point of the measurement. Without this, the second run of
  // the day reads a fraction of the first and the budget silently stops meaning anything.
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const pending = new Map<string, Omit<ResourceEntry, 'transferBytes'>>();
  const entries: ResourceEntry[] = [];
  const marks = new Map<string, number>();

  cdp.on('Network.requestWillBeSent', (event) => {
    // Redirects reuse the requestId; keep the original start time, take the latest URL.
    const existing = pending.get(event.requestId);
    pending.set(event.requestId, {
      url: event.request.url,
      kind: classify(event.type, event.request.url),
      startedAt: existing?.startedAt ?? Date.now(),
      thirdParty: isThirdParty(event.request.url, firstPartyOrigin),
    });
  });

  cdp.on('Network.responseReceived', (event) => {
    const started = pending.get(event.requestId);
    if (!started) return;
    // `type` is authoritative here in a way it is not on requestWillBeSent, where it is
    // the browser's guess before any headers have come back.
    pending.set(event.requestId, {
      ...started,
      url: event.response.url,
      kind: classify(event.type, event.response.url, event.response.mimeType),
      thirdParty: isThirdParty(event.response.url, firstPartyOrigin),
    });
  });

  cdp.on('Network.loadingFinished', (event) => {
    const started = pending.get(event.requestId);
    if (!started) return;
    pending.delete(event.requestId);
    // data: and blob: URLs never crossed a wire; counting their zero bytes as requests
    // only inflates the request count in the summary.
    if (started.url.startsWith('data:') || started.url.startsWith('blob:')) return;
    entries.push({ ...started, transferBytes: event.encodedDataLength });
  });

  cdp.on('Network.loadingFailed', (event) => {
    pending.delete(event.requestId);
  });

  return {
    mark(name) {
      marks.set(name, Date.now());
    },
    all() {
      return new ResourceTally([...entries]);
    },
    until(mark) {
      const cutoff = marks.get(mark);
      if (cutoff === undefined) {
        throw new Error(`No performance mark named "${mark}" was recorded.`);
      }
      return new ResourceTally(entries.filter((e) => e.startedAt <= cutoff));
    },
  };
}

/**
 * Is this response from someone else's server?
 *
 * A URL the browser reports without an origin (data:, blob:) is ours by construction —
 * it was produced by our own page — and never reaches this function with a host anyway.
 */
function isThirdParty(url: string, firstPartyOrigin: string): boolean {
  try {
    return new URL(url).origin !== firstPartyOrigin;
  } catch {
    return false;
  }
}

/** Map a CDP ResourceType (plus a mime-type fallback) onto a budget class. */
function classify(type: string | undefined, url: string, mimeType?: string): ResourceKind {
  switch (type) {
    case 'Script':
      return 'js';
    case 'Stylesheet':
      return 'css';
    case 'Document':
      return 'document';
    case 'Image':
      return 'image';
    case 'Font':
      return 'font';
    default:
      break;
  }
  // XHR/Fetch carry a route's data, not its code — except that Next serves route
  // JavaScript over plain fetch when the router prefetches, and a chunk is a chunk
  // whichever API pulled it.
  if (mimeType?.includes('javascript') || /\.m?js(\?|$)/.test(url)) return 'js';
  if (mimeType === 'text/css' || /\.css(\?|$)/.test(url)) return 'css';
  return 'other';
}

// ---------------------------------------------------------------------------
// Paint metrics
// ---------------------------------------------------------------------------

export interface PaintMetrics {
  /**
   * Largest contentful paint, in ms from navigation start. The moment the page looks
   * like the page rather than like a skeleton.
   */
  lcpMs: number;
  /** What the LCP element was, so a regression names the image or heading that grew. */
  lcpElement: string;
  /**
   * Cumulative layout shift: the sum of every unexpected shift, unweighted by session
   * window. Deliberately the strict reading — the web-vitals session-window rule can
   * only ever report a smaller number than this one, so a page that passes here passes
   * anywhere.
   */
  cls: number;
  /** First contentful paint, in ms. */
  fcpMs: number;
}

/**
 * Arm the observers. Must be called before the navigation being measured, because
 * `PerformanceObserver` with `buffered: true` only replays entries from the current
 * document — and an observer registered after hydration has already missed the paints.
 */
export async function observePaint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { lcpMs: 0, lcpElement: '', cls: 0, fcpMs: 0 };
    (window as unknown as { __marinaPerf: typeof state }).__marinaPerf = state;

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const lcp = entry as PerformanceEntry & { element?: Element; size?: number };
          state.lcpMs = lcp.startTime;
          const el = lcp.element;
          state.lcpElement = el
            ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` +
              ` "${(el.textContent ?? '').trim().slice(0, 40)}"`
            : 'unknown';
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
          // A shift within 500ms of a real interaction is the guest's own doing (opening
          // the month grid, say) and is excluded from CLS by definition.
          if (!shift.hadRecentInput) state.cls += shift.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') state.fcpMs = entry.startTime;
        }
      }).observe({ type: 'paint', buffered: true });
    } catch {
      // An engine without one of these entry types leaves the metric at 0; the spec
      // asserts the numbers it got rather than failing on a missing observer.
    }
  });
}

/** Read what the observers have seen so far. */
export async function readPaint(page: Page): Promise<PaintMetrics> {
  return page.evaluate(() => {
    const empty = { lcpMs: 0, lcpElement: 'none', cls: 0, fcpMs: 0 };
    return (window as unknown as { __marinaPerf?: typeof empty }).__marinaPerf ?? empty;
  });
}

/**
 * Let the page finish moving before reading CLS.
 *
 * Layout shift is cumulative over a document's life, so "the CLS" is only meaningful
 * relative to a stated window. Ours is: everything up to a quiet network plus a short
 * settle for late fonts and images. Stated here rather than assumed, because a CLS
 * figure without a window is not comparable to anything.
 */
export async function settle(page: Page, quietMs = 1_000): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {
    // networkidle can never arrive on a page holding a long-poll open; the settle below
    // still gives late paints their chance, and the measurement is honest either way.
  });
  await page.waitForTimeout(quietMs);
}

// ---------------------------------------------------------------------------
// The embed loader
// ---------------------------------------------------------------------------

export interface AssetTransfer {
  /** Bytes on the wire, as the server sent them. */
  transferBytes: number;
  /** Bytes the browser parses, after decompression. */
  sourceBytes: number;
  /** `gzip`, `br`, or `identity` when the server did not compress. */
  encoding: string;
  status: number;
}

/**
 * Fetch a URL over real HTTP and count the bytes on the wire.
 *
 * Playwright's `APIRequestContext` transparently decompresses, which would report the
 * uncompressed size and quietly hide whether the server compresses at all — and whether
 * the loader is compressed is half of what its cost on somebody else's site depends on.
 * `node:http` with an explicit `accept-encoding` gives both numbers and proves the
 * header is really being sent.
 */
export function fetchAsset(url: string, encoding = 'gzip'): Promise<AssetTransfer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { 'accept-encoding': encoding } }, (res) => {
      let transferBytes = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        transferBytes += chunk.length;
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const contentEncoding = String(res.headers['content-encoding'] ?? 'identity');
        resolve({
          transferBytes,
          sourceBytes: decodedLength(body, contentEncoding),
          encoding: contentEncoding,
          status: res.statusCode ?? 0,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Uncompressed length of a body that may have arrived compressed.
 *
 * Only gzip is decoded, because that is what the Next server negotiates for a `public/`
 * asset. Anything else falls back to the on-the-wire length, and the caller can see
 * which happened from the `encoding` field rather than being handed a number whose
 * meaning silently changed.
 */
function decodedLength(body: Buffer, encoding: string): number {
  if (encoding === 'identity') return body.length;
  if (encoding !== 'gzip') return body.length;
  return gunzipSync(body).length;
}

/** Bytes of a file on disk — what the repository is committing to ship. */
export async function fileBytes(path: string): Promise<number> {
  return (await readFile(path)).length;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Bytes as a KiB string with one decimal, so a 200-byte regression is still visible. */
export function kb(bytes: number): string {
  return (bytes / KB).toFixed(1);
}

/**
 * Trim a URL to the part a human reads.
 *
 * The host is kept for anything not on localhost, because "240 KB /v3" and "240 KB
 * js.stripe.com/v3" send the reader to completely different places.
 */
export function shorten(url: string): string {
  try {
    const parsed = new URL(url);
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    return `${local ? '' : parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * The sentence a failing budget prints.
 *
 * Always the same shape — measured, budget, overage, then the offenders — because the
 * first question after "the JS budget failed" is always "by how much, and because of
 * what", and a report that answers it inline saves a bundle-analyzer round trip.
 */
export function overBudget(
  label: string,
  measuredBytes: number,
  budgetBytes: number,
  detail = '',
): string {
  const over = measuredBytes - budgetBytes;
  return (
    `${label}: ${kb(measuredBytes)} KB against a ${kb(budgetBytes)} KB budget ` +
    `(${over >= 0 ? '+' : ''}${kb(over)} KB).\n` +
    (detail ? `${detail}\n` : '') +
    '    Budgets live in e2e/specs/performance.spec.ts and the measured baseline is in\n' +
    '    docs/PERFORMANCE.md. Raising one is a decision to record there, not a fix.'
  );
}
